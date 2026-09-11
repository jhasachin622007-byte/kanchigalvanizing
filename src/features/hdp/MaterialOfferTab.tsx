import { useEffect, useMemo, useState } from "react";
import { fmtDateTimeTz, fmtDateTz, tzFields } from "@/lib/tz";
import { useBeamMaterials, type BeamMaterialItem } from "@/lib/cloud-sync";
import { pendingOpsForTable } from "@/lib/pending-queue";
import { useDraft, clearDraft } from "@/lib/use-draft";
import {
  Factory, ClipboardList, FileBarChart2, CheckCircle2, XCircle, RotateCcw,
  Download, Filter, Search, Calendar, AlertTriangle,
} from "lucide-react";

const iconBtn = { display: "inline-flex", alignItems: "center", gap: 6 } as const;

type Beam = any;
type T = any;

const DEFECTS = [
  { id: "LUMPS", label: "Lumps" },
  { id: "RUNS", label: "Runs" },
  { id: "STEEL_DEFECT", label: "Steel Defect" },
  { id: "BARE_SPOT", label: "Bare Spot" },
  { id: "ROUGH", label: "Rough Surface" },
  { id: "OTHER", label: "Other" },
];

const STATUS_COLOR: Record<string, string> = {
  OFFERED: "#FDE047",
  ACCEPTED: "#4ADE80",
  REJECTED: "#F87171",
  DISPUTE: "#FB923C",
};
const STATUS_LABEL: Record<string, string> = {
  OFFERED: "Offered to QC",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  DISPUTE: "Dispute / Rework",
};

function autoShift(iso: string) {
  const h = tzFields(iso).hour;
  if (h >= 6 && h < 14) return "A";
  if (h >= 14 && h < 22) return "B";
  return "C";
}

function fmtDT(iso?: string | null) {
  return fmtDateTimeTz(iso);
}
function fmtDate(iso?: string | null) {
  return fmtDateTz(iso);
}

// Derive material list from a completed beam.
function materialsFor(beam: Beam): Array<{ route_card_no: string | null; part_no: string | null; quantity: number | null }> {
  const out: Array<{ route_card_no: string | null; part_no: string | null; quantity: number | null }> = [];
  const dbl = Array.isArray(beam.dbl_parts_detail) ? beam.dbl_parts_detail : [];
  const std = Array.isArray(beam.parts_detail) ? beam.parts_detail : [];
  for (const r of dbl) {
    out.push({
      route_card_no: (r.route_card || "").trim() || null,
      part_no: (r.part || "").trim() || null,
      quantity: Number(r.qty) || null,
    });
  }
  for (const r of std) {
    out.push({
      route_card_no: (r.route_card || "").trim() || null,
      part_no: (r.part || "").trim() || null,
      quantity: Number(r.qty) || null,
    });
  }
  if (out.length === 0) {
    // Legacy beam with no parts_detail — fallback to a single row.
    out.push({
      route_card_no: beam.route_card || null,
      part_no: beam.part_nos || null,
      quantity: null,
    });
  }
  return out;
}

const PRIV_ROLES = new Set(["admin", "supervisor", "shift_supervisor", "manager", "qc_inspector"]);

export default function MaterialOfferTab({
  beams,
  T,
  user,
  readOnly,
}: {
  beams: Beam[];
  T: T;
  user: any;
  readOnly?: boolean;
}) {
  const [materials, setMaterials] = useBeamMaterials(true);
  // Pending list filters (OFFERED only)
  const [filterBeam, setFilterBeam] = useState<string>("");
  const [filterFrom, setFilterFrom] = useState<string>("");
  const [filterTo, setFilterTo] = useState<string>("");
  // Report filters (decided rows)
  const [rptStatus, setRptStatus] = useState<string>("ALL");
  const [rptBeam, setRptBeam] = useState<string>("");
  const [rptDefect, setRptDefect] = useState<string>("ALL");
  const [rptDecidedBy, setRptDecidedBy] = useState<string>("");
  const [rptFrom, setRptFrom] = useState<string>("");
  const [rptTo, setRptTo] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dlg, setDlg] = useState<{ kind: "REJECTED" | "DISPUTE"; ids: string[] } | null>(null);
  const [defectType, setDefectType] = useState("LUMPS");
  const [remark, setRemark] = useState("");

  // Persist in-progress dialog state to localStorage so an incoming call /
  // screen lock can't erase the operator's defect notes mid-entry.
  const draftKey = dlg ? `mo-decision:${dlg.kind}:${dlg.ids.join(",")}` : "mo-decision:idle";
  useDraft(user?.id, `${draftKey}:defect`, defectType, setDefectType, { enabled: !!dlg });
  useDraft(user?.id, `${draftKey}:remark`, remark, setRemark, { enabled: !!dlg });

  const canAct = !readOnly && PRIV_ROLES.has((user?.role || "").toLowerCase());
  const completed = useMemo(
    () => beams.filter((b) => b.status === "COMPLETED"),
    [beams],
  );

  // Signature over the current material set so the effect only re-runs when
  // the actual set of offered rows changes (not on every render or on any
  // status update). Prevents re-queuing identical inserts on flaky links.
  const materialsSig = useMemo(
    () =>
      materials
        .map((m) => `${m.transaction_id}|${m.route_card_no || ""}|${m.part_no || ""}`)
        .sort()
        .join(","),
    [materials],
  );
  const completedSig = useMemo(
    () => completed.map((b) => b.transaction_id || b.beam_no).sort().join(","),
    [completed],
  );

  // Auto-offer: for every completed beam, ensure a beam_materials row exists per material.
  useEffect(() => {
    if (!completed.length) return;
    if (!canAct && (user?.role || "").toLowerCase() !== "dipping_supervisor") return;
    const byTxn = new Map<string, BeamMaterialItem[]>();
    for (const m of materials) {
      const arr = byTxn.get(m.transaction_id) || [];
      arr.push(m);
      byTxn.set(m.transaction_id, arr);
    }
    // Also exclude any rows already queued locally (offline / retrying) so
    // we don't enqueue the same (txn, route_card, part) twice — which used
    // to trip beam_materials_uniq and drop the offer.
    const queuedKeys = new Set<string>();
    for (const op of pendingOpsForTable("beam_materials")) {
      if (op.kind === "insert") {
        for (const row of op.rows || []) {
          queuedKeys.add(
            `${row.transaction_id}|${row.route_card_no || ""}|${row.part_no || ""}`,
          );
        }
      }
    }
    const toInsert: any[] = [];
    for (const b of completed) {
      const existing = byTxn.get(b.transaction_id || b.beam_no) || [];
      const wantList = materialsFor(b);
      for (const w of wantList) {
        const dup = existing.find(
          (e) => (e.route_card_no || "") === (w.route_card_no || "") && (e.part_no || "") === (w.part_no || ""),
        );
        const key = `${b.transaction_id || b.beam_no}|${w.route_card_no || ""}|${w.part_no || ""}`;
        if (!dup && !queuedKeys.has(key)) {
          toInsert.push({
            id: crypto.randomUUID(),
            transaction_id: b.transaction_id || b.beam_no,
            beam_no: b.beam_no,
            route_card_no: w.route_card_no,
            part_no: w.part_no,
            quantity: w.quantity,
            coating_spec: b.coating_required ? String(b.coating_required) : null,
            qc_status: "OFFERED",
            defect_type: null,
            defect_remark: null,
            offered_at: b.qc_completed_at || b.dipped_at || new Date().toISOString(),
            decided_at: null,
            decided_by: null,
            decided_by_name: null,
          });
        }
      }
    }
    if (toInsert.length) {
      setMaterials((prev) => [...toInsert, ...prev]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedSig, materialsSig]);

  function decide(ids: string[], status: "ACCEPTED" | "REJECTED" | "DISPUTE", dtype?: string, dremark?: string) {
    if (!canAct) return;
    const now = new Date().toISOString();
    setMaterials((prev) =>
      prev.map((m) =>
        ids.includes(m.id)
          ? {
              ...m,
              qc_status: status,
              defect_type: status === "ACCEPTED" ? null : dtype || null,
              defect_remark: status === "ACCEPTED" ? null : dremark || null,
              decided_at: now,
              decided_by: user?.id || null,
              decided_by_name: user?.full_name || null,
            }
          : m,
      ),
    );
    setSelected(new Set());
    // Clear any persisted draft for this dialog before we close it.
    if (dlg) {
      const k = `mo-decision:${dlg.kind}:${dlg.ids.join(",")}`;
      clearDraft(user?.id, `${k}:defect`);
      clearDraft(user?.id, `${k}:remark`);
    }
    setDlg(null);
    setRemark("");
  }

  // Pending list: only OFFERED rows
  const pendingFiltered = useMemo(() => {
    return materials.filter((m) => {
      if (m.qc_status !== "OFFERED") return false;
      if (filterBeam && !m.beam_no.toLowerCase().includes(filterBeam.toLowerCase())) return false;
      if (filterFrom && new Date(m.offered_at) < new Date(filterFrom)) return false;
      if (filterTo && new Date(m.offered_at) > new Date(filterTo + "T23:59:59")) return false;
      return true;
    });
  }, [materials, filterBeam, filterFrom, filterTo]);

  // Report: decided rows (ACCEPTED / REJECTED / DISPUTE)
  const reportFiltered = useMemo(() => {
    return materials.filter((m) => {
      if (m.qc_status === "OFFERED") return false;
      if (rptStatus !== "ALL" && m.qc_status !== rptStatus) return false;
      if (rptBeam && !m.beam_no.toLowerCase().includes(rptBeam.toLowerCase())) return false;
      if (rptDefect !== "ALL" && (m.defect_type || "") !== rptDefect) return false;
      if (rptDecidedBy && !(m.decided_by_name || "").toLowerCase().includes(rptDecidedBy.toLowerCase())) return false;
      const ref = m.decided_at || m.offered_at;
      if (rptFrom && new Date(ref) < new Date(rptFrom)) return false;
      if (rptTo && new Date(ref) > new Date(rptTo + "T23:59:59")) return false;
      return true;
    });
  }, [materials, rptStatus, rptBeam, rptDefect, rptDecidedBy, rptFrom, rptTo]);

  // ───── Reports aggregations (report-scoped) ─────
  const reports = useMemo(() => {
    const byDate = new Map<string, { offered: number; accepted: number; rejected: number; dispute: number }>();
    const byShift: any = { A: { offered: 0, accepted: 0, rejected: 0, dispute: 0 }, B: { offered: 0, accepted: 0, rejected: 0, dispute: 0 }, C: { offered: 0, accepted: 0, rejected: 0, dispute: 0 } };
    const byHour = new Array(24).fill(0).map(() => ({ offered: 0, accepted: 0, rejected: 0, dispute: 0 }));
    const byDefect = new Map<string, number>();
    for (const m of reportFiltered) {
      const d = fmtDate(m.offered_at);
      const k = m.qc_status === "ACCEPTED" ? "accepted" : m.qc_status === "REJECTED" ? "rejected" : m.qc_status === "DISPUTE" ? "dispute" : "offered";
      const cur = byDate.get(d) || { offered: 0, accepted: 0, rejected: 0, dispute: 0 };
      cur[k] += 1;
      byDate.set(d, cur);
      const sh = autoShift(m.offered_at);
      byShift[sh][k] += 1;
      const h = tzFields(m.offered_at).hour;
      byHour[h][k] += 1;
      if (m.defect_type && (m.qc_status === "REJECTED" || m.qc_status === "DISPUTE")) {
        byDefect.set(m.defect_type, (byDefect.get(m.defect_type) || 0) + 1);
      }
    }
    return { byDate: Array.from(byDate.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1)), byShift, byHour, byDefect: Array.from(byDefect.entries()).sort((a, b) => b[1] - a[1]) };
  }, [reportFiltered]);

  function downloadCSV(rows: string[][], name: string) {
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  function exportPendingCSV() {
    const rows = [["Beam No", "Route Card", "Part No", "Qty", "Coating Spec", "Offered At", "Shift"]];
    for (const m of pendingFiltered) {
      rows.push([
        m.beam_no, m.route_card_no || "", m.part_no || "", String(m.quantity ?? ""),
        m.coating_spec || "", fmtDT(m.offered_at), autoShift(m.offered_at),
      ]);
    }
    downloadCSV(rows, "material-offer-pending");
  }

  function exportReportCSV() {
    const rows = [["Beam No", "Route Card", "Part No", "Qty", "Coating Spec", "Offered At", "Decided At", "Shift", "Status", "Defect", "Remark", "Decided By"]];
    for (const m of reportFiltered) {
      rows.push([
        m.beam_no, m.route_card_no || "", m.part_no || "", String(m.quantity ?? ""),
        m.coating_spec || "", fmtDT(m.offered_at), fmtDT(m.decided_at), autoShift(m.offered_at),
        STATUS_LABEL[m.qc_status] || m.qc_status,
        m.defect_type || "", (m.defect_remark || "").replace(/[\r\n,]+/g, " "),
        m.decided_by_name || "",
      ]);
    }
    downloadCSV(rows, "material-offer-report");
  }


  const styles = {
    card: { background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14 } as const,
    th: { textAlign: "left" as const, padding: "8px 10px", fontSize: 11, fontWeight: 700, color: T.muted, borderBottom: `1px solid ${T.border}`, background: T.surf },
    td: { padding: "8px 10px", fontSize: 12, color: T.text, borderBottom: `1px solid ${T.border}` },
    btn: (bg: string) => ({ background: bg, color: "#0B0E12", border: "none", borderRadius: 5, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }),
    ghost: { background: "transparent", color: T.muted, border: `1px solid ${T.border}`, borderRadius: 5, padding: "5px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
    input: { padding: "6px 9px", borderRadius: 5, fontSize: 12, fontFamily: "inherit", background: T.surf, border: `1px solid ${T.border}`, color: T.text, outline: "none" },
    pill: (col: string) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700, color: col, background: col + "22", border: `1px solid ${col}55` }),
  };

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const allChecked = pendingFiltered.length > 0 && pendingFiltered.every((m) => selected.has(m.id));

  const counts = {
    offered: materials.filter((m) => m.qc_status === "OFFERED").length,
    accepted: materials.filter((m) => m.qc_status === "ACCEPTED").length,
    rejected: materials.filter((m) => m.qc_status === "REJECTED").length,
    dispute: materials.filter((m) => m.qc_status === "DISPUTE").length,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Section heading */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: T.amber + "20", border: `1px solid ${T.amber}40`, display: "grid", placeItems: "center" }}>
          <Factory size={18} color={T.amber} />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: T.text, letterSpacing: ".06em" }}>MATERIAL OFFER</div>
          <div style={{ fontSize: 10, color: T.dim }}>QC acceptance · rework · rejection workflow</div>
        </div>
      </div>
      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10 }}>
        {[
          ["Pending", counts.offered, STATUS_COLOR.OFFERED],
          ["Accepted", counts.accepted, STATUS_COLOR.ACCEPTED],
          ["Rejected", counts.rejected, STATUS_COLOR.REJECTED],
          ["Dispute / Rework", counts.dispute, STATUS_COLOR.DISPUTE],
        ].map(([l, v, c]: any) => (
          <div key={l} style={{ ...styles.card, padding: 12 }}>
            <div style={{ fontSize: 10, color: T.muted, fontWeight: 700, letterSpacing: 0.5 }}>{l.toUpperCase()}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: c, marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Pending offer filters + actions */}
      <div style={styles.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <ClipboardList size={16} color={T.amber} />
          <div style={{ fontSize: 12, fontWeight: 800, color: T.text, letterSpacing: ".06em" }}>PENDING MATERIAL OFFERS</div>
          <span style={{ ...styles.pill(T.amber), background: T.surf }}>{pendingFiltered.length}</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
            <Search size={12} color={T.muted} style={{ position: "absolute", left: 8, pointerEvents: "none" }} />
            <input placeholder="Beam No" value={filterBeam} onChange={(e) => setFilterBeam(e.target.value)} style={{ ...styles.input, paddingLeft: 26 }} />
          </div>
          <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} style={styles.input} />
          <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} style={styles.input} />
          <button onClick={exportPendingCSV} style={{ ...styles.ghost, ...iconBtn }}>
            <Download size={12} /> Export Pending CSV
          </button>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {canAct && selected.size > 0 && (
              <>
                <button onClick={() => decide(Array.from(selected), "ACCEPTED")} style={{ ...styles.btn(STATUS_COLOR.ACCEPTED), ...iconBtn }}>
                  <CheckCircle2 size={13} /> Accept ({selected.size})
                </button>
                <button onClick={() => { setDefectType("LUMPS"); setRemark(""); setDlg({ kind: "REJECTED", ids: Array.from(selected) }); }} style={{ ...styles.btn(STATUS_COLOR.REJECTED), ...iconBtn }}>
                  <XCircle size={13} /> Reject ({selected.size})
                </button>
                <button onClick={() => { setDefectType("LUMPS"); setRemark(""); setDlg({ kind: "DISPUTE", ids: Array.from(selected) }); }} style={{ ...styles.btn(STATUS_COLOR.DISPUTE), ...iconBtn }}>
                  <RotateCcw size={13} /> Rework ({selected.size})
                </button>
              </>
            )}
          </div>
        </div>
      </div>


      {/* Material table */}
      <div style={{ ...styles.card, padding: 0, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1100 }}>
          <thead>
            <tr>
              {canAct && (
                <th style={{ ...styles.th, width: 30 }}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => setSelected(e.target.checked ? new Set(pendingFiltered.map((m) => m.id)) : new Set())}
                  />
                </th>
              )}
              <th style={styles.th}>Beam No</th>
              <th style={styles.th}>Route Card No</th>
              <th style={styles.th}>Part No</th>
              <th style={styles.th}>Qty</th>
              <th style={styles.th}>Coating Spec</th>
              <th style={styles.th}>Dipping Date &amp; Time</th>
              <th style={styles.th}>Current Status</th>
              <th style={styles.th}>Defect</th>
              <th style={{ ...styles.th, textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pendingFiltered.length === 0 && (
              <tr><td colSpan={canAct ? 10 : 9} style={{ ...styles.td, textAlign: "center", color: T.muted, padding: 28 }}>No materials match the current filter.</td></tr>
            )}
            {pendingFiltered.map((m) => (
              <tr key={m.id}>
                {canAct && (
                  <td style={styles.td}>
                    <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggleSel(m.id)} />
                  </td>
                )}
                <td style={{ ...styles.td, fontWeight: 700 }}>{m.beam_no}</td>
                <td style={styles.td}>{m.route_card_no || "—"}</td>
                <td style={styles.td}>{m.part_no || "—"}</td>
                <td style={styles.td}>{m.quantity ?? "—"}</td>
                <td style={styles.td}>{m.coating_spec ? `${m.coating_spec} μm` : "—"}</td>
                <td style={{ ...styles.td, color: T.muted, fontFamily: "monospace", fontSize: 11 }}>{fmtDT(m.offered_at)}</td>
                <td style={styles.td}><span style={styles.pill(STATUS_COLOR[m.qc_status])}>{STATUS_LABEL[m.qc_status]}</span></td>
                <td style={{ ...styles.td, color: T.muted }}>
                  {m.defect_type ? (
                    <div>
                      <div style={{ fontWeight: 700, color: T.text }}>{DEFECTS.find((d) => d.id === m.defect_type)?.label || m.defect_type}</div>
                      {m.defect_remark && <div style={{ fontSize: 10 }}>{m.defect_remark}</div>}
                    </div>
                  ) : "—"}
                </td>
                <td style={{ ...styles.td, textAlign: "right" }}>
                  {canAct ? (
                    <div style={{ display: "inline-flex", gap: 4 }}>
                      <button title="Accept" onClick={() => decide([m.id], "ACCEPTED")} style={{ ...styles.btn(STATUS_COLOR.ACCEPTED), ...iconBtn }}><CheckCircle2 size={12} /> Accept</button>
                      <button title="Reject" onClick={() => { setDefectType("LUMPS"); setRemark(""); setDlg({ kind: "REJECTED", ids: [m.id] }); }} style={{ ...styles.btn(STATUS_COLOR.REJECTED), ...iconBtn }}><XCircle size={12} /> Reject</button>
                      <button title="Rework" onClick={() => { setDefectType("LUMPS"); setRemark(""); setDlg({ kind: "DISPUTE", ids: [m.id] }); }} style={{ ...styles.btn(STATUS_COLOR.DISPUTE), ...iconBtn }}><RotateCcw size={12} /> Rework</button>
                    </div>
                  ) : <span style={{ fontSize: 10, color: T.dim }}>read-only</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ───── Material Offer Report ───── */}
      <div style={styles.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <FileBarChart2 size={16} color={T.amber} />
          <div style={{ fontSize: 12, fontWeight: 800, color: T.text, letterSpacing: ".06em" }}>MATERIAL OFFER REPORT</div>
          <span style={{ ...styles.pill(T.muted), background: T.surf }}>{reportFiltered.length} records</span>
          <div style={{ marginLeft: "auto" }}>
            <button onClick={exportReportCSV} style={{ ...styles.ghost, ...iconBtn }}>
              <Download size={12} /> Export Report CSV
            </button>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
          <select value={rptStatus} onChange={(e) => setRptStatus(e.target.value)} style={styles.input}>
            <option value="ALL">All decided</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="REJECTED">Rejected</option>
            <option value="DISPUTE">Dispute / Rework</option>
          </select>
          <select value={rptDefect} onChange={(e) => setRptDefect(e.target.value)} style={styles.input}>
            <option value="ALL">All defects</option>
            {DEFECTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <input placeholder="Beam No" value={rptBeam} onChange={(e) => setRptBeam(e.target.value)} style={styles.input} />
          <input placeholder="Decided by" value={rptDecidedBy} onChange={(e) => setRptDecidedBy(e.target.value)} style={styles.input} />
          <input type="date" value={rptFrom} onChange={(e) => setRptFrom(e.target.value)} style={styles.input} />
          <input type="date" value={rptTo} onChange={(e) => setRptTo(e.target.value)} style={styles.input} />
        </div>
        <div style={{ overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1200 }}>
            <thead>
              <tr>
                <th style={styles.th}>Beam No</th>
                <th style={styles.th}>Route Card</th>
                <th style={styles.th}>Part No</th>
                <th style={styles.th}>Qty</th>
                <th style={styles.th}>Coating</th>
                <th style={styles.th}>Offered At</th>
                <th style={styles.th}>Decided At</th>
                <th style={styles.th}>Shift</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Defect / Remark</th>
                <th style={styles.th}>Decided By</th>
              </tr>
            </thead>
            <tbody>
              {reportFiltered.length === 0 && (
                <tr><td colSpan={11} style={{ ...styles.td, textAlign: "center", color: T.muted, padding: 24 }}>No decided materials match the filter.</td></tr>
              )}
              {reportFiltered.map((m) => (
                <tr key={m.id}>
                  <td style={{ ...styles.td, fontWeight: 700 }}>{m.beam_no}</td>
                  <td style={styles.td}>{m.route_card_no || "—"}</td>
                  <td style={styles.td}>{m.part_no || "—"}</td>
                  <td style={styles.td}>{m.quantity ?? "—"}</td>
                  <td style={styles.td}>{m.coating_spec ? `${m.coating_spec} μm` : "—"}</td>
                  <td style={{ ...styles.td, color: T.muted, fontFamily: "monospace", fontSize: 11 }}>{fmtDT(m.offered_at)}</td>
                  <td style={{ ...styles.td, color: T.muted, fontFamily: "monospace", fontSize: 11 }}>{fmtDT(m.decided_at)}</td>
                  <td style={styles.td}>{autoShift(m.offered_at)}</td>
                  <td style={styles.td}><span style={styles.pill(STATUS_COLOR[m.qc_status])}>{STATUS_LABEL[m.qc_status]}</span></td>
                  <td style={{ ...styles.td, color: T.muted }}>
                    {m.defect_type ? (
                      <div>
                        <div style={{ fontWeight: 700, color: T.text }}>{DEFECTS.find((d) => d.id === m.defect_type)?.label || m.defect_type}</div>
                        {m.defect_remark && <div style={{ fontSize: 10 }}>{m.defect_remark}</div>}
                      </div>
                    ) : "—"}
                  </td>
                  <td style={styles.td}>{m.decided_by_name || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>



      {/* Reports */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 10 }}>
        <div style={styles.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 8 }}>By Date</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={styles.th}>Date</th><th style={styles.th}>Offer</th><th style={styles.th}>Acc</th><th style={styles.th}>Rej</th><th style={styles.th}>Disp</th></tr></thead>
            <tbody>
              {reports.byDate.length === 0 && <tr><td colSpan={5} style={{ ...styles.td, color: T.muted, textAlign: "center" }}>No data</td></tr>}
              {reports.byDate.slice(0, 14).map(([d, c]) => (
                <tr key={d}><td style={styles.td}>{d}</td><td style={styles.td}>{c.offered}</td><td style={{ ...styles.td, color: STATUS_COLOR.ACCEPTED }}>{c.accepted}</td><td style={{ ...styles.td, color: STATUS_COLOR.REJECTED }}>{c.rejected}</td><td style={{ ...styles.td, color: STATUS_COLOR.DISPUTE }}>{c.dispute}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={styles.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 8 }}>By Shift</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={styles.th}>Shift</th><th style={styles.th}>Offer</th><th style={styles.th}>Acc</th><th style={styles.th}>Rej</th><th style={styles.th}>Disp</th></tr></thead>
            <tbody>
              {(["A", "B", "C"] as const).map((s) => {
                const c = reports.byShift[s];
                return <tr key={s}><td style={{ ...styles.td, fontWeight: 700 }}>{s}</td><td style={styles.td}>{c.offered}</td><td style={{ ...styles.td, color: STATUS_COLOR.ACCEPTED }}>{c.accepted}</td><td style={{ ...styles.td, color: STATUS_COLOR.REJECTED }}>{c.rejected}</td><td style={{ ...styles.td, color: STATUS_COLOR.DISPUTE }}>{c.dispute}</td></tr>;
              })}
            </tbody>
          </table>
        </div>

        <div style={styles.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 8 }}>By Hour (today's filter)</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(12,1fr)", gap: 3 }}>
            {reports.byHour.map((c, h) => {
              const total = c.offered + c.accepted + c.rejected + c.dispute;
              return (
                <div key={h} title={`${h}:00 — Acc ${c.accepted} / Rej ${c.rejected} / Disp ${c.dispute}`} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 8, color: T.dim }}>{h}</div>
                  <div style={{ height: 28, display: "flex", flexDirection: "column-reverse", borderRadius: 3, overflow: "hidden", background: T.surf }}>
                    {total > 0 && (
                      <>
                        <div style={{ background: STATUS_COLOR.ACCEPTED, height: `${(c.accepted / total) * 100}%` }} />
                        <div style={{ background: STATUS_COLOR.REJECTED, height: `${(c.rejected / total) * 100}%` }} />
                        <div style={{ background: STATUS_COLOR.DISPUTE, height: `${(c.dispute / total) * 100}%` }} />
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 8, color: T.muted }}>{total || ""}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={styles.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 8 }}>By Defect</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={styles.th}>Defect</th><th style={{ ...styles.th, textAlign: "right" }}>Count</th></tr></thead>
            <tbody>
              {reports.byDefect.length === 0 && <tr><td colSpan={2} style={{ ...styles.td, color: T.muted, textAlign: "center" }}>No defects logged</td></tr>}
              {reports.byDefect.map(([d, n]) => (
                <tr key={d}><td style={styles.td}>{DEFECTS.find((x) => x.id === d)?.label || d}</td><td style={{ ...styles.td, textAlign: "right", fontWeight: 700 }}>{n}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Reject/Dispute dialog */}
      {dlg && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setDlg(null)}>
          <div style={{ ...styles.card, width: 420, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 10 }}>
              {dlg.kind === "REJECTED" ? "Reject Material" : "Dispute / Rework"} ({dlg.ids.length})
            </div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Defect type</div>
            <select value={defectType} onChange={(e) => setDefectType(e.target.value)} style={{ ...styles.input, width: "100%", marginBottom: 10 }}>
              {DEFECTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Remarks <span style={{ color: T.redT }}>*</span></div>
            <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={3} placeholder="e.g. heavy lumps near root, requires re-dip"
              style={{ ...styles.input, width: "100%", resize: "vertical" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setDlg(null)} style={styles.ghost}>Cancel</button>
              <button
                disabled={!remark.trim()}
                onClick={() => decide(dlg.ids, dlg.kind, defectType, remark.trim())}
                style={{ ...styles.btn(dlg.kind === "REJECTED" ? STATUS_COLOR.REJECTED : STATUS_COLOR.DISPUTE), opacity: remark.trim() ? 1 : 0.4 }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
