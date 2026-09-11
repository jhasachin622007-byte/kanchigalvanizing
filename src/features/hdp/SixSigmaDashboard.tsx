// @ts-nocheck
/* eslint-disable */
import { useMemo, useState } from "react";
import { fmtDateTimeTz, tzFields } from "@/lib/tz";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ScatterChart, Scatter, ZAxis, Legend, Cell,
} from "recharts";
import { useServerFn } from "@tanstack/react-start";
import {
  mean, median, mode, stdDev, stdDevPop, cp as cpFn, cpk as cpkFn,
  xBarLimits, westernElectric, pearson, linreg, quantile, histogram,
  normalPdf, cpkRating, productionDayOf, shiftOf as prodShiftOf,
  pp as ppFn, ppk as ppkFn,
} from "./six-sigma-stats";
import { COATING_SPEC, TEMP_SPEC, coatingSpec } from "./spec-limits";
import { productionDayIdTz, productionRange, productionRangeLabel } from "./production-day";
import { normalityReport } from "./normality";
import {
  iMR, xBarR, subgroupBySize, detectViolations,
  RULE_LABEL, RULE_ACTION, type Violation,
} from "./spc";
import { oneWayAnova, tukeyHSD, twoWayAnova } from "./anova";
import { getSixSigmaInsights } from "@/lib/six-sigma-insights.functions";
import { useShow65 } from "./feature-flags";
import { MultiSelectFilter, inSel } from "@/components/MultiSelectFilter";


const COATINGS_ALL = [65, 87, 130] as const;
const TIP = {
  contentStyle: { background: "#1E2A36", border: "1px solid #33434F", color: "#C9D6DF", fontSize: 12, borderRadius: 6 },
  labelStyle: { color: "#3D7EA6" },
};

// ── Helpers ───────────────────────────────────────────────────────────────
const dipSecs = (b: any): number | null => {
  if (b?.immersion_start_at && b?.withdrawal_end_at) {
    return Math.max(0, Math.round((+new Date(b.withdrawal_end_at) - +new Date(b.immersion_start_at)) / 1000));
  }
  if (b?.dipped_at && b?.dipping_at) {
    return Math.max(0, Math.round((+new Date(b.dipped_at) - +new Date(b.dipping_at)) / 1000));
  }
  return null;
};
const fmtSec = (s: number | null) => {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};
const num = (x: any, d = 2) => (x == null || Number.isNaN(x) ? "—" : Number(x).toFixed(d));
const fmtAxis = (v: any) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};
const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const fmt = (x: any) => (x == null || Number.isNaN(x) ? "—" : Number(x).toFixed(2));
  return (
    <div style={{ background: "#1E2A36", border: "1px solid #33434F", borderRadius: 6, padding: 8, color: "#C9D6DF", fontSize: 12 }}>
      {label != null && <div style={{ color: "#3D7EA6", fontWeight: 700, marginBottom: 2 }}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ marginTop: 2 }}>{p.name || p.dataKey}: <b>{fmt(p.value)}</b></div>
      ))}
    </div>
  );
};

// Production-Day shift: A/B/C derived from immersion-start timestamp.
const shiftOf = (b: any): "A" | "B" | "C" | "" => prodShiftOf(b?.dipping_at || b?.immersion_start_at || b?.dipped_at || b?.loaded_at);
const prodDayOf = (b: any) => productionDayOf(b?.dipping_at || b?.immersion_start_at || b?.dipped_at || b?.loaded_at);
// Production-day key (06:00 → 06:00 plant time) — shared with Reports/Hourly.
const dayKey = (iso?: string) => productionDayIdTz(iso);
const SHIFT_LABELS: Record<string, string> = { A: "A (06–14)", B: "B (14–22)", C: "C (22–06)" };

// ── Reusable atoms ────────────────────────────────────────────────────────
const Section = ({ id, title, sub, right, children, T }: any) => {
  const [open, setOpen] = useState(true);
  return (
    <div id={id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ padding: "12px 16px", borderBottom: open ? `1px solid ${T.border}` : "none",
          display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}
      >
        <span style={{ fontSize: 14 }}>{open ? "▾" : "▸"}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: T.text, letterSpacing: ".03em" }}>{title}</div>
          {sub && <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>{sub}</div>}
        </div>
        {right}
      </div>
      {open && <div style={{ padding: 14 }}>{children}</div>}
    </div>
  );
};

const KCard = ({ label, value, sub, color = "#3D7EA6", T }: any) => (
  <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 14px", minWidth: 140 }}>
    <div style={{ fontSize: 10, color: T.muted, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase" }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 900, color, fontFamily: "monospace", marginTop: 4, lineHeight: 1 }}>{value}</div>
    {sub && <div style={{ fontSize: 10, color: T.dim, marginTop: 4 }}>{sub}</div>}
  </div>
);

const Light = ({ cpkVal }: { cpkVal: number | null }) => {
  const r = cpkRating(cpkVal);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px",
      background: r.color + "20", border: `1px solid ${r.color}55`, borderRadius: 999,
      fontSize: 11, fontWeight: 800, color: r.color }}>
      <span>{r.emoji}</span> {r.label} {cpkVal != null && `· Cpk ${cpkVal.toFixed(2)}`}
    </span>
  );
};

const Tbl = ({ headers, rows, T }: any) => (
  <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: 8 }}>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ background: T.bg }}>
          {headers.map((h: string) => (
            <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: T.muted, fontWeight: 700,
              fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", borderBottom: `1px solid ${T.border}` }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={headers.length} style={{ padding: 16, textAlign: "center", color: T.dim }}>No data</td></tr>}
        {rows.map((row: any[], i: number) => (
          <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
            {row.map((c, j) => <td key={j} style={{ padding: "8px 10px", color: T.text }}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const pFmt = (p: number) => (p < 0.001 ? "< 0.001" : p.toFixed(2));
const AnovaBlock = ({ title, a, tukey, T }: any) => {
  if (!a) return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>{title}</div>
      <div style={{ color: T.dim, fontSize: 12, padding: 10, border: `1px dashed ${T.border}`, borderRadius: 6 }}>Insufficient data (need ≥ 2 groups with ≥ 2 samples each).</div>
    </div>
  );
  const sig = a.significant;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
        <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>{title}</div>
        <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800, background: sig ? "#4ADE8022" : "#71809622", color: sig ? "#4ADE80" : T.muted, border: `1px solid ${sig ? "#4ADE80" : T.border}` }}>
          {sig ? "SIGNIFICANT (p < 0.05)" : "NOT SIGNIFICANT"}
        </span>
      </div>
      <Tbl T={T}
        headers={["Source", "SS", "df", "MS", "F", "p-value"]}
        rows={[
          ["Between Groups", a.ssBetween.toFixed(2), a.dfBetween, a.msBetween.toFixed(2), a.F.toFixed(2), pFmt(a.pValue)],
          ["Within Groups",  a.ssWithin.toFixed(2),  a.dfWithin,  a.msWithin.toFixed(2),  "—", "—"],
          ["Total",          a.ssTotal.toFixed(2),   a.dfBetween + a.dfWithin, "—", "—", "—"],
        ]} />
      <div style={{ marginTop: 6 }}>
        <Tbl T={T}
          headers={["Group", "n", "Mean", "Variance"]}
          rows={a.groups.map((g: any) => [g.label, g.n, g.mean.toFixed(2), g.variance.toFixed(2)])} />
      </div>
      {tukey && tukey.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: T.dim, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Tukey HSD post-hoc (α = 0.05)</div>
          <Tbl T={T}
            headers={["Pair", "Mean Diff", "SE", "q", "q crit", "Sig?"]}
            rows={tukey.map((p: any) => [
              `${p.a} vs ${p.b}`,
              p.meanDiff.toFixed(2),
              p.se.toFixed(2),
              p.q.toFixed(2),
              p.qCritical.toFixed(2),
              <span key="s" style={{ color: p.significant ? "#4ADE80" : T.dim, fontWeight: 700 }}>{p.significant ? "YES" : "no"}</span>,
            ])} />
        </div>
      )}
    </div>
  );
};

const TwoWayAnovaBlock = ({ title, a, T }: any) => {
  if (!a) return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>{title}</div>
      <div style={{ color: T.dim, fontSize: 12, padding: 10, border: `1px dashed ${T.border}`, borderRadius: 6 }}>Insufficient data (need ≥ 2 levels of both factors with observations).</div>
    </div>
  );
  const rows: any[] = [
    [`Factor A (${a.factorA.levels.join("/")})`, a.factorA.SS.toFixed(2), a.factorA.df, a.factorA.MS.toFixed(2), a.factorA.F.toFixed(2), pFmt(a.factorA.p), a.factorA.p < 0.05 ? "★" : ""],
    [`Factor B (${a.factorB.levels.join("/")})`, a.factorB.SS.toFixed(2), a.factorB.df, a.factorB.MS.toFixed(2), a.factorB.F.toFixed(2), pFmt(a.factorB.p), a.factorB.p < 0.05 ? "★" : ""],
  ];
  if (a.interaction) {
    rows.push(["A × B Interaction", a.interaction.SS.toFixed(2), a.interaction.df, a.interaction.MS.toFixed(2), a.interaction.F.toFixed(2), pFmt(a.interaction.p), a.interaction.p < 0.05 ? "★" : ""]);
  }
  rows.push(["Error", a.error.SS.toFixed(2), a.error.df, a.error.MS.toFixed(2), "—", "—", ""]);
  rows.push(["Total", a.total.SS.toFixed(2), a.total.df, "—", "—", "—", ""]);
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>{title}</div>
      <Tbl T={T} headers={["Source", "SS", "df", "MS", "F", "p-value", "Sig"]} rows={rows} />
      <div style={{ fontSize: 11, color: T.dim, marginTop: 4 }}>N = {a.N}. ★ = significant at α = 0.05.</div>
    </div>
  );
};


// ──────────────────────────────────────────────────────────────────────────
export function SixSigmaDashboard({ beams: allBeams, users = [], T, qcRanges }: any) {
  // Specification limits are the single source of truth for LSL/USL used in
  // SPC, Cp/Cpk, Sigma, alerts, reports and AI recommendations.
  // The QCR shape (min / ok_max) is kept for backward compatibility with
  // downstream code, but always mirrors COATING_SPEC.
  const QCR: Record<number, { min: number; ok_max: number }> = {
    65:  { min: COATING_SPEC[65].lsl,  ok_max: COATING_SPEC[65].usl  },
    87:  { min: COATING_SPEC[87].lsl,  ok_max: COATING_SPEC[87].usl  },
    130: { min: COATING_SPEC[130].lsl, ok_max: COATING_SPEC[130].usl },
  };
  void qcRanges; // dashboard ignores per-project overrides — spec limits are global

  // ── Global filters ───────────────────────────────────────────────────
  const today = new Date();
  const ago30 = new Date(today); ago30.setDate(ago30.getDate() - 29);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const [fromDate, setFromDate] = useState(iso(ago30));
  const [toDate, setToDate] = useState(iso(today));
  const [fShift, setFShift] = useState<string[]>([]);
  const [fOperator, setFOperator] = useState<string[]>([]);
  const [fLoadType, setFLoadType] = useState<string[]>([]);
  const [fCoating, setFCoating] = useState<string[]>([]);
  // Some downstream charts (KPIs, distribution, Cpk light, load-wise view)
  // need a single-spec context. `null` = "combined / all specs".
  const fCoatingSingle = useMemo(() => (fCoating.length === 1 ? Number(fCoating[0]) : null), [fCoating]);

  const show65 = useShow65();
  const COATINGS = useMemo(() => (show65 ? COATINGS_ALL : COATINGS_ALL.filter((c) => c !== 65)) as readonly number[], [show65]);
  const [fMaterial, setFMaterial] = useState<string[]>([]);
  const [fSurface, setFSurface] = useState<string[]>([]);
  const [fBeam, setFBeam] = useState("");
  const [predictorKey, setPredictorKey] = useState<"dip" | "temp" | "thk" | "wt" | "immwdr_avg">("dip");

  const loadTypes = useMemo(() => {
    const s = new Set<string>();
    allBeams.forEach((b: any) => { if (b?.load_type) s.add(String(b.load_type)); });
    return Array.from(s).sort();
  }, [allBeams]);
  const operators = useMemo(() => {
    const s = new Set<string>();
    allBeams.forEach((b: any) => { if (b?.dipping_operator) s.add(String(b.dipping_operator)); });
    return Array.from(s).sort();
  }, [allBeams]);

  // Production-day window: fromDate 06:00 → (toDate + 1) 06:00, plant time.
  const tFrom = useMemo(() => +new Date(productionRange(fromDate, toDate).start), [fromDate, toDate]);
  const tTo = useMemo(() => +new Date(productionRange(fromDate, toDate).end) - 1, [fromDate, toDate]);

  const beams = useMemo(() => allBeams.filter((b: any) => {
    const ts = +new Date(b.loaded_at || b.dipped_at || 0);
    if (!ts || ts < tFrom || ts > tTo) return false;
    if (!inSel(fShift, shiftOf(b))) return false;
    if (!inSel(fOperator, b.dipping_operator || "")) return false;
    if (!inSel(fLoadType, b.load_type || "")) return false;
    if (!inSel(fCoating, String(Number(b.coating_required)))) return false;
    if (!inSel(fMaterial, String(b.material_type || "").toUpperCase())) return false;
    if (!inSel(fSurface, String(b.surface_condition || "").toLowerCase())) return false;
    if (fBeam.trim() && !String(b.beam_no || "").toLowerCase().includes(fBeam.trim().toLowerCase())) return false;
    return true;
  }), [allBeams, tFrom, tTo, fShift, fOperator, fLoadType, fCoating, fMaterial, fSurface, fBeam]);


  const completed = useMemo(() => beams.filter((b: any) => b.status === "COMPLETED" && b.avg_reading != null), [beams]);

  // ── 1. Production Overview ──────────────────────────────────────────
  const todayKey = productionDayIdTz(new Date().toISOString());
  const todayBeams = allBeams.filter((b: any) => dayKey(b.immersion_start || b.dipped_at) === todayKey);
  const todayMT = +todayBeams.reduce((s: number, b: any) => s + (Number(b.total_weight) || 0), 0).toFixed(2);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const monthMT = +allBeams
    .filter((b: any) => +new Date(b.dipped_at || 0) >= monthStart)
    .reduce((s: number, b: any) => s + (Number(b.total_weight) || 0), 0).toFixed(2);

  const shiftToday: Record<string, number> = { A: 0, B: 0, C: 0 };
  todayBeams.forEach((b: any) => { const s = shiftOf(b); if (s in shiftToday) shiftToday[s] += Number(b.total_weight) || 0; });
  const pending = allBeams.filter((b: any) => b.status === "LOADED").length;
  const running = allBeams.filter((b: any) => b.status === "DIPPING" || b.status === "QC_PENDING").length;
  const done = allBeams.filter((b: any) => b.status === "COMPLETED").length;
  const avgDipAll = (() => {
    const xs = beams.map(dipSecs).filter((v) => v != null) as number[];
    return xs.length ? Math.round(mean(xs)) : null;
  })();
  const latestTemp = (() => {
    const sorted = [...beams].filter((b: any) => b.bath_temperature)
      .sort((a: any, b: any) => +new Date(b.dipped_at || 0) - +new Date(a.dipped_at || 0));
    return sorted[0]?.bath_temperature ?? null;
  })();
  const capacityPct = Math.min(100, Math.round((done / Math.max(1, beams.length)) * 100));

  const daily30 = useMemo(() => {
    const m: Record<string, { date: string; mt: number; avg: number; n: number; sum: number }> = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = iso(d);
      m[k] = { date: k.slice(5), mt: 0, avg: 0, n: 0, sum: 0 };
    }
    beams.forEach((b: any) => {
      const k = dayKey(b.dipped_at || b.loaded_at);
      if (m[k]) {
        m[k].mt = +(m[k].mt + (Number(b.total_weight) || 0)).toFixed(2);
        if (b.avg_reading != null) { m[k].sum += Number(b.avg_reading); m[k].n++; }
      }
    });
    return Object.values(m).map((r) => ({ ...r, avg: r.n ? +(r.sum / r.n).toFixed(2) : null }));
  }, [beams]);

  const hourly = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hr: `${h}:00`, mt: 0, n: 0 }));
    todayBeams.forEach((b: any) => {
      const t = b.dipped_at ? new Date(b.dipped_at) : null;
      if (!t) return;
      const h = tzFields(t.toISOString()).hour;
      buckets[h].mt = +(buckets[h].mt + (Number(b.total_weight) || 0)).toFixed(2);
      buckets[h].n++;
    });
    return buckets;
  }, [todayBeams]);

  const shiftCompare = useMemo(() => (["A", "B", "C"] as const).map((s) => {
    const sb = beams.filter((b: any) => shiftOf(b) === s);
    const dips = sb.map(dipSecs).filter((v) => v != null) as number[];
    return {
      shift: SHIFT_LABELS[s],
      mt: +sb.reduce((x: number, b: any) => x + (Number(b.total_weight) || 0), 0).toFixed(2),
      beams: sb.length,
      avgDip: dips.length ? Math.round(mean(dips)) : 0,
    };
  }), [beams]);

  // ── 2. Coating Thickness Analytics per micron ──────────────────────
  const coatStats = useMemo(() => COATINGS.map((m) => {
    const xs = completed.filter((b: any) => Number(b.coating_required) === m)
      .map((b: any) => Number(b.avg_reading)).filter((v: number) => Number.isFinite(v));
    const r = QCR[m] || { min: m, ok_max: m * 1.3 };
    const mu = mean(xs);
    const sd = stdDev(xs);
    const sdP = stdDevPop(xs);
    const c = cpFn(sd, r.min, r.ok_max);
    const ck = cpkFn(mu, sd, r.min, r.ok_max);
    const ppV = ppFn(sdP, r.min, r.ok_max);
    const ppkV = ppkFn(mu, sdP, r.min, r.ok_max);
    const sigma = ck != null ? +(ck * 3 + 1.5).toFixed(2) : null;
    const mn = xs.length ? Math.min(...xs) : 0;
    const mx = xs.length ? Math.max(...xs) : 0;
    return {
      micron: m, n: xs.length, xs, lsl: r.min, usl: r.ok_max,
      mean: mu, median: median(xs), mode: mode(xs),
      sd, sdPop: sdP, min: mn, max: mx, range: mx - mn,
      cp: c, cpk: ck, pp: ppV, ppk: ppkV, sigma,
      normality: normalityReport(xs),
    };
  }), [completed, QCR]);

  // ── 3. SPC Control charts ───────────────────────────────────────────
  // Individuals chart limits from I-MR (uses moving-range sigma), with the
  // 4-rule engine from spc.ts: beyond limits, 7 same-side, 7 monotonic,
  // 14 alternating (cyclic).
  const spcBuild = (samples: { label: string; v: number; b?: any }[]) => {
    const xs = samples.map((s) => s.v);
    if (xs.length < 2) return null;
    const mr = iMR(xs)!;
    const { cl, ucl, lcl } = mr.i;
    const vList: Violation[] = detectViolations(xs, mr.i);
    const flagged = new Map<number, Violation[]>();
    vList.forEach((v) => {
      if (!flagged.has(v.index)) flagged.set(v.index, []);
      flagged.get(v.index)!.push(v);
    });
    const data = samples.map((s, i) => ({ ...s, oc: flagged.has(i) }));
    // Detailed rows for the violations table.
    const details = vList.map((v) => ({
      index: v.index,
      rule: v.rule,
      ruleLabel: RULE_LABEL[v.rule],
      action: RULE_ACTION[v.rule],
      sample: samples[v.index],
    }));
    // X-bar / R side stats (subgroup size 5, chronological).
    const groups = subgroupBySize(xs, 5);
    const xr = xBarR(groups);
    return {
      data, cl, ucl, lcl, sd: mr.sigma,
      stable: flagged.size === 0,
      violations: flagged.size,
      details,
      xr,
    };
  };
  // Per-spec SPC for Coating Thickness — independent X-Bar / WE-rules / Cp / Cpk / Pp / Ppk / Sigma per micron.
  const spcCoatingBySpec = useMemo(() => {
    const specs = (fCoatingSingle == null ? COATINGS : [fCoatingSingle]) as readonly number[];
    return specs.map((m) => {
      const r = QCR[m] || { min: m, ok_max: m * 1.3 };
      const pool = completed
        .filter((b: any) => Number(b.coating_required) === m)
        .sort((a: any, b: any) => +new Date(a.qc_completed_at || 0) - +new Date(b.qc_completed_at || 0));
      const samples = pool.slice(-40).map((b: any) => ({ label: b.beam_no, v: Number(b.avg_reading), b }));
      const spc = spcBuild(samples);
      const xs = pool.map((b: any) => Number(b.avg_reading)).filter((v: number) => Number.isFinite(v));
      const mu = mean(xs);
      const sd = stdDev(xs);
      const cpV = cpFn(sd, r.min, r.ok_max);
      const cpkV = cpkFn(mu, sd, r.min, r.ok_max);
      const ppV = ppFn(sd, r.min, r.ok_max);
      const ppkV = ppkFn(mu, sd, r.min, r.ok_max);
      const sigma = cpkV != null ? +(cpkV * 3 + 1.5).toFixed(2) : null;
      return { micron: m, lsl: r.min, usl: r.ok_max, n: xs.length, spc, cp: cpV, cpk: cpkV, pp: ppV, ppk: ppkV, sigma };
    });
  }, [completed, fCoating, QCR]);
  // Kept for the Management Summary card (uses 87 µm as default reference).
  const spcCoating = spcCoatingBySpec[0]?.spc || null;
  const spcDip = useMemo(() => {
    const src = beams
      .map((b: any) => ({ b, v: dipSecs(b) }))
      .filter((x) => x.v != null)
      .sort((a: any, b: any) => +new Date(a.b.dipped_at || 0) - +new Date(b.b.dipped_at || 0))
      .slice(-40)
      .map((x: any) => ({ label: x.b.beam_no, v: Math.round(x.v / 60 * 10) / 10, b: x.b }));
    return spcBuild(src);
  }, [beams]);
  const spcTemp = useMemo(() => {
    const src = beams
      .filter((b: any) => b.bath_temperature != null)
      .sort((a: any, b: any) => +new Date(a.dipped_at || 0) - +new Date(b.dipped_at || 0))
      .slice(-40)
      .map((b: any) => ({ label: b.beam_no, v: Number(b.bath_temperature), b }));
    return spcBuild(src);
  }, [beams]);

  // Consolidated SPC violations table (Rule, Beam, Date/Time, Shift, Operator,
  // Parameter, Suggested Action). Users can jump straight to the offending beam.
  const spcViolationRows = useMemo(() => {
    const rows: any[] = [];
    const push = (parameter: string, spc: any) => {
      if (!spc) return;
      spc.details.forEach((d: any) => {
        const b = d.sample.b || {};
        const ts = b.qc_completed_at || b.dipped_at || b.immersion_start_at || b.loaded_at;
        rows.push({
          parameter,
          beam_no: b.beam_no || d.sample.label,
          when: ts ? fmtDateTimeTz(ts) : "—",
          shift: shiftOf(b),
          operator: b.dipping_operator || b.qc_operator || b.loaded_operator || "—",
          material: b.material_type || "—",
          load_type: b.load_type || "—",
          weight: (() => {
            const w = b.beam_weight ?? b.total_weight ?? b.weight_mt ?? b.weight;
            return w != null && Number.isFinite(Number(w)) ? Number(w).toFixed(2) : "—";
          })(),
          dip_op: b.dipping_operator || "—",
          value: d.sample.v,
          rule: d.rule,
          ruleLabel: d.ruleLabel,
          action: d.action,
        });
      });

    };
    spcCoatingBySpec.forEach((g: any) => push(`Coating ${g.micron}µm`, g.spc));
    push("Dipping Time (min)", spcDip);
    push("Zinc Bath Temp (°C)", spcTemp);
    return rows;
  }, [spcCoatingBySpec, spcDip, spcTemp]);

  // Production MT by Coating Specification (filtered range).
  const coatingSpecMT = useMemo(() => {
    const m: Record<number, number> = { 65: 0, 87: 0, 130: 0 };
    beams.forEach((b: any) => {
      const k = Number(b.coating_required);
      if (k in m) m[k] += Number(b.total_weight) || 0;
    });
    const total = m[65] + m[87] + m[130];
    return { 65: +m[65].toFixed(2), 87: +m[87].toFixed(2), 130: +m[130].toFixed(2), total: +total.toFixed(2) };
  }, [beams]);

  // Load-wise Coating Dashboard — Total Beams · Total MT · Avg Coating · Avg Cycle Time per Load Type.
  // When a Coating Spec is selected, metrics reflect that spec; ALL → expands into per-spec sub-columns.
  const loadWise = useMemo(() => {
    const groups = new Map<string, any[]>();
    beams.forEach((b: any) => {
      const k = (b.load_type || "—").trim() || "—";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(b);
    });
    return Array.from(groups.entries()).map(([type, bs]) => {
      const cdone = bs.filter((b: any) => b.status === "COMPLETED" && b.avg_reading != null);
      const mt = +bs.reduce((s: number, b: any) => s + (Number(b.total_weight) || 0), 0).toFixed(2);
      const bySpec = (m: number) => {
        const s = cdone.filter((b: any) => Number(b.coating_required) === m);
        const xs = s.map((b: any) => Number(b.avg_reading));
        const dips = s.map(dipSecs).filter((v) => v != null) as number[];
        return {
          n: s.length,
          avgCoat: xs.length ? +mean(xs).toFixed(2) : null,
          avgCycle: dips.length ? Math.round(mean(dips)) : null,
        };
      };
      const all = (() => {
        const pool = fCoatingSingle == null ? cdone : cdone.filter((b: any) => Number(b.coating_required) === fCoatingSingle);
        const xs = pool.map((b: any) => Number(b.avg_reading));
        const dips = pool.map(dipSecs).filter((v) => v != null) as number[];
        return {
          avgCoat: xs.length ? +mean(xs).toFixed(2) : null,
          avgCycle: dips.length ? Math.round(mean(dips)) : null,
        };
      })();
      return { type, beams: bs.length, mt, avgCoat: all.avgCoat, avgCycle: all.avgCycle, perSpec: { 65: bySpec(65), 87: bySpec(87), 130: bySpec(130) } };
    }).sort((a, b) => b.beams - a.beams);
  }, [beams, fCoating]);

  // Cycle Time breakdown — by Spec / Load Type / Operator.
  const cycleBy = useMemo(() => {
    const avg = (arr: any[]) => {
      const dips = arr.map(dipSecs).filter((v) => v != null) as number[];
      return dips.length ? Math.round(mean(dips)) : null;
    };
    const bySpec = COATINGS.map((m) => ({ key: `${m} µm`, n: completed.filter((b: any) => Number(b.coating_required) === m).length, avgCycle: avg(completed.filter((b: any) => Number(b.coating_required) === m)) }));
    const lt = new Map<string, any[]>();
    completed.forEach((b: any) => { const k = (b.load_type || "—").trim() || "—"; if (!lt.has(k)) lt.set(k, []); lt.get(k)!.push(b); });
    const byLoad = Array.from(lt.entries()).map(([k, bs]) => ({ key: k, n: bs.length, avgCycle: avg(bs) })).sort((a, b) => (b.n - a.n));
    const op = new Map<string, any[]>();
    completed.forEach((b: any) => { const k = (b.dipping_operator || "—").trim() || "—"; if (!op.has(k)) op.set(k, []); op.get(k)!.push(b); });
    const byOp = Array.from(op.entries()).map(([k, bs]) => ({ key: k, n: bs.length, avgCycle: avg(bs) })).sort((a, b) => (b.n - a.n));
    return { bySpec, byLoad, byOp };
  }, [completed]);

  // ── 4. Dipping Time Intelligence ────────────────────────────────────
  const corr = useMemo(() => {
    const pts = completed.map((b: any) => {
      const t = dipSecs(b);
      return t != null ? {
        x: +(t / 60).toFixed(2), y: Number(b.avg_reading),
        z: Number(b.total_weight) || 1, t: Number(b.bath_temperature) || 0, label: b.beam_no,
      } : null;
    }).filter(Boolean) as any[];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const r = pts.length > 1 ? pearson(xs, ys) : 0;
    const { a, b } = pts.length > 1 ? linreg(xs, ys) : { a: 0, b: 0 };
    // Optimal dipping bucket: bucket times by 0.5 min, pick the one with highest pass rate
    const buckets: Record<string, { ok: number; n: number; sumT: number }> = {};
    pts.forEach((p) => {
      const k = (Math.floor(p.x * 2) / 2).toFixed(2);
      buckets[k] = buckets[k] || { ok: 0, n: 0, sumT: 0 };
      const sp = QCR[(fCoatingSingle ?? 87)] || { min: 87, ok_max: 110 };
      if (p.y >= sp.min && p.y <= sp.ok_max) buckets[k].ok++;
      buckets[k].n++;
      buckets[k].sumT += p.t;
    });
    let best: any = null;
    Object.entries(buckets).forEach(([k, v]) => {
      if (v.n < 3) return;
      const rate = v.ok / v.n;
      if (!best || rate > best.rate) best = { range: k, rate, n: v.n, avgT: v.sumT / v.n };
    });
    return { pts, r, a, b, best };
  }, [completed, fCoating, QCR]);

  // Full regression matrix — the 7 predictor pairs from the spec.
  // Each entry produces equation y = a + b·x, r, r², slope, intercept and
  // the predicted µm at the mean of x (a quick sanity check).
  const regressions = useMemo(() => {
    const pool = (fCoatingSingle == null ? completed : completed.filter((b: any) => Number(b.coating_required) === fCoatingSingle));
    const specs = ((fCoatingSingle ?? 87));
    const targetSpec = QCR[specs] || { min: specs, ok_max: specs * 1.3 };
    type Pair = { key: string; title: string; xLabel: string; yLabel: string; getX: (b: any) => number | null; getY: (b: any) => number | null };
    const parseThk = (b: any): number | null => {
      const direct = Number(b?.material_thickness);
      if (Number.isFinite(direct) && direct > 0) return direct;
      const m = String(b?.section || "").match(/[\d.]+/);
      const v = m ? Number(m[0]) : NaN;
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const pairs: Pair[] = [
      { key: "dip",         title: "Dipping Time vs Coating",                    xLabel: "Dip (min)",           yLabel: "Coating (Micron µm)", getX: (b) => { const t = dipSecs(b); return t != null ? t / 60 : null; }, getY: (b) => Number(b.avg_reading) || null },
      { key: "temp",        title: "Bath Temperature vs Coating",                xLabel: "Temp (°C)",           yLabel: "Coating (Micron µm)", getX: (b) => Number(b.bath_temperature) || null, getY: (b) => Number(b.avg_reading) || null },
      { key: "wt",          title: "Weight vs Coating",                          xLabel: "Weight (MT)",         yLabel: "Coating (Micron µm)", getX: (b) => Number(b.total_weight) || null, getY: (b) => Number(b.avg_reading) || null },
      { key: "thk",         title: "Thickness vs Coating",                       xLabel: "Thickness (mm)",      yLabel: "Coating (Micron µm)", getX: parseThk, getY: (b) => Number(b.avg_reading) || null },
      { key: "immwdr_avg",  title: "Immersion / Withdraw Time vs Avg Coating",   xLabel: "Immersion ÷ Withdraw (ratio)", yLabel: "Coating (Micron µm)",
        getX: (b) => { const i = Number(b.immersion_duration); const w = Number(b.withdrawal_duration); return Number.isFinite(i) && Number.isFinite(w) && w > 0 ? i / w : null; },
        getY: (b) => Number(b.avg_reading) || null },
    ];
    return pairs.map((p) => {
      const pts = pool.map((b: any) => {
        const x = p.getX(b); const y = p.getY(b);
        return x != null && y != null && Number.isFinite(x) && Number.isFinite(y) ? { x, y, label: b.beam_no } : null;
      }).filter(Boolean) as any[];
      const xs = pts.map((q) => q.x);
      const ys = pts.map((q) => q.y);
      const r = pts.length > 1 ? pearson(xs, ys) : 0;
      const { a, b } = pts.length > 1 ? linreg(xs, ys) : { a: 0, b: 0 };
      const xMean = xs.length ? mean(xs) : 0;
      const predicted = a + b * xMean;
      // Solve for x that hits centre of spec (targetSpec midpoint): x* = (target - a) / b
      const target = (targetSpec.min + targetSpec.ok_max) / 2;
      const xTarget = b !== 0 ? (target - a) / b : null;
      return { ...p, pts, r, r2: r * r, a, b, xMean, predicted, target, xTarget };
    });
  }, [completed, fCoating, QCR]);

  // ── 5. Shift performance ────────────────────────────────────────────
  const capFor = (xs: number[], m: number) => {
    if (xs.length < 2) return { cp: null as number | null, cpk: null as number | null, sigma: null as number | null };
    const sp = QCR[m]; if (!sp) return { cp: null, cpk: null, sigma: null };
    const mu = mean(xs); const sd = stdDev(xs);
    const cpV = cpFn(sd, sp.min, sp.ok_max);
    const ck = cpkFn(mu, sd, sp.min, sp.ok_max);
    const sig = ck != null ? +(ck * 3 + 1.5).toFixed(2) : null;
    return { cp: cpV != null ? +cpV.toFixed(2) : null, cpk: ck != null ? +ck.toFixed(2) : null, sigma: sig };
  };
  const yieldOf = (bs: any[]) => {
    const done = bs.filter((b) => b.status === "COMPLETED" && b.avg_reading != null);
    if (!done.length) return 0;
    const pass = done.filter((b) => b.qc_status === "PASS").length;
    return Math.round((pass / done.length) * 100);
  };
  const shiftPerf = useMemo(() => (["A", "B", "C"] as const).map((s) => {
    const sb = completed.filter((b: any) => shiftOf(b) === s);
    const xs = sb.map((b: any) => Number(b.avg_reading));
    const dips = sb.map(dipSecs).filter((v) => v != null) as number[];
    const m = (fCoatingSingle ?? 87);
    const c = capFor(xs, m);
    return {
      shift: SHIFT_LABELS[s],
      beams: sb.length,
      mt: +sb.reduce((x: number, b: any) => x + (Number(b.total_weight) || 0), 0).toFixed(2),
      avgCoat: xs.length ? +mean(xs).toFixed(2) : 0,
      avgDip: dips.length ? Math.round(mean(dips) / 60 * 10) / 10 : 0,
      yieldPct: yieldOf(sb),
      cp: c.cp,
      cpk: c.cpk,
      sigma: c.sigma,
    };
  }), [completed, fCoating]);

  // ── 6. Operator performance ─────────────────────────────────────────
  const operatorPerf = useMemo(() => {
    const groups = new Map<string, any[]>();
    completed.forEach((b: any) => {
      const k = (b.dipping_operator || "—").trim() || "—";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(b);
    });
    const m = (fCoatingSingle ?? 87);
    return Array.from(groups.entries()).map(([operator, bs]) => {
      const xs = bs.map((b: any) => Number(b.avg_reading));
      const dips = bs.map(dipSecs).filter((v) => v != null) as number[];
      const c = capFor(xs, m);
      return {
        operator,
        beams: bs.length,
        avgCoat: xs.length ? +mean(xs).toFixed(2) : 0,
        avgDip: dips.length ? +(mean(dips) / 60).toFixed(2) : 0,
        std: xs.length ? +stdDev(xs).toFixed(2) : 0,
        yieldPct: yieldOf(bs),
        cp: c.cp,
        cpk: c.cpk,
        sigma: c.sigma,
      };
    }).sort((a, b) => b.beams - a.beams);
  }, [completed, fCoating]);

  // ── 7. Load type intelligence ───────────────────────────────────────
  const loadTypePerf = useMemo(() => {
    const groups = new Map<string, any[]>();
    beams.forEach((b: any) => {
      const k = (b.load_type || "Other").trim() || "Other";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(b);
    });
    const m = (fCoatingSingle ?? 87);
    return Array.from(groups.entries()).map(([type, bs]) => {
      const done = bs.filter((b: any) => b.status === "COMPLETED" && b.avg_reading != null);
      const xs = done.map((b: any) => Number(b.avg_reading));
      const dips = done.map(dipSecs).filter((v) => v != null) as number[];
      const c = capFor(xs, m);
      return {
        type, qty: bs.length,
        avgCoat: xs.length ? +mean(xs).toFixed(2) : 0,
        avgDip: dips.length ? +(mean(dips) / 60).toFixed(2) : 0,
        yield: yieldOf(bs),
        sigma: c.sigma,
      };
    }).sort((a, b) => b.qty - a.qty);
  }, [beams, fCoating]);

  // Correlation: Load qty ↔ average coating across load types.
  const loadCoatingCorr = useMemo(() => {
    const pts = loadTypePerf.filter((r) => r.qty >= 2 && r.avgCoat > 0);
    if (pts.length < 3) return null;
    return +pearson(pts.map((p) => p.qty), pts.map((p) => p.avgCoat)).toFixed(2);
  }, [loadTypePerf]);

  // ── 8. Best Process Parameters (statistical + reference beam) ───────
  const bestParams = useMemo(() => COATINGS.map((m) => {
    const sp = QCR[m]; if (!sp) return null;
    const pool = completed.filter((b: any) => Number(b.coating_required) === m && b.bath_temperature);
    // bucket: temperature ±2 °C × dip time ±30 sec
    const buckets = new Map<string, { ok: number; n: number; sumThk: number; sumT: number; sumD: number; beams: any[] }>();
    pool.forEach((b: any) => {
      const t = Number(b.bath_temperature);
      const d = dipSecs(b);
      if (d == null || !Number.isFinite(t)) return;
      const tk = Math.round(t / 2) * 2;
      const dk = Math.round(d / 30) * 30;
      const k = `${tk}|${dk}`;
      const e = buckets.get(k) || { ok: 0, n: 0, sumThk: 0, sumT: 0, sumD: 0, beams: [] as any[] };
      const v = Number(b.avg_reading);
      e.n++; e.sumT += t; e.sumD += d; e.sumThk += v; e.beams.push(b);
      if (v >= sp.min && v <= sp.ok_max) e.ok++;
      buckets.set(k, e);
    });
    let best: any = null;
    buckets.forEach((e) => {
      if (e.n < 3) return;
      const rate = e.ok / e.n;
      if (!best || rate > best.rate || (rate === best.rate && e.n > best.n)) {
        best = { rate, n: e.n, t: e.sumT / e.n, d: e.sumD / e.n, thk: e.sumThk / e.n, beams: e.beams };
      }
    });
    // Reference beam: within best bucket, PASS, avg_reading closest to spec midpoint
    let refBeam: any = null;
    if (best) {
      const mid = (sp.min + sp.ok_max) / 2;
      const passing = best.beams.filter((b: any) => {
        const v = Number(b.avg_reading);
        return v >= sp.min && v <= sp.ok_max;
      });
      passing.sort((a: any, b: any) =>
        Math.abs(Number(a.avg_reading) - mid) - Math.abs(Number(b.avg_reading) - mid));
      refBeam = passing[0] || null;
    }
    return {
      micron: m,
      bestTemp: best ? +best.t.toFixed(2) : null,
      bestDipSec: best ? Math.round(best.d) : null,
      expected: best ? +best.thk.toFixed(2) : null,
      successRate: best ? Math.round(best.rate * 100) : 0,
      sample: best ? best.n : 0,
      refBeamNo: refBeam?.beam_no ?? refBeam?.beam_id ?? null,
      refCoating: refBeam ? +Number(refBeam.avg_reading).toFixed(2) : null,
      refDate: refBeam?.dipping_end_time || refBeam?.qc_end_time || refBeam?.updated_at || null,
    };
  }).filter(Boolean) as any[], [completed, QCR]);


  // ── ANOVA (One-Way / Two-Way + Tukey HSD) ───────────────────────────
  const anovaShift = useMemo(() => {
    const g: Record<string, number[]> = { A: [], B: [], C: [] };
    completed.forEach((b: any) => {
      const s = shiftOf(b);
      const v = Number(b.avg_reading);
      if (s && Number.isFinite(v)) g[s].push(v);
    });
    const named = Object.fromEntries(Object.entries(g).map(([k, v]) => [SHIFT_LABELS[k] ?? k, v]));
    return oneWayAnova(named);
  }, [completed]);
  const tukeyShift = useMemo(() => (anovaShift ? tukeyHSD(anovaShift) : []), [anovaShift]);


  const anovaOperator = useMemo(() => {
    const g: Record<string, number[]> = {};
    completed.forEach((b: any) => {
      const op = (b.dipping_operator || "").trim();
      const v = Number(b.avg_reading);
      if (op && Number.isFinite(v)) (g[op] ??= []).push(v);
    });
    return oneWayAnova(g);
  }, [completed]);

  const anovaLoad = useMemo(() => {
    const g: Record<string, number[]> = {};
    completed.forEach((b: any) => {
      const lt = (b.load_type || "").trim();
      const v = Number(b.avg_reading);
      if (lt && Number.isFinite(v)) (g[lt] ??= []).push(v);
    });
    return oneWayAnova(g);
  }, [completed]);
  const tukeyOperator = useMemo(() => (anovaOperator ? tukeyHSD(anovaOperator) : []), [anovaOperator]);
  const tukeyLoad = useMemo(() => (anovaLoad ? tukeyHSD(anovaLoad) : []), [anovaLoad]);

  // Shift Supervisor Performance — grouped by shift_supervisor field.
  // Reactive to global filters.
  const anovaSupervisor = useMemo(() => {
    const g: Record<string, number[]> = {};
    completed.forEach((b: any) => {
      const s = (b.shift_supervisor || "").trim();
      const v = Number(b.avg_reading);
      if (s && Number.isFinite(v)) (g[s] ??= []).push(v);
    });
    return oneWayAnova(g);
  }, [completed]);
  const tukeySupervisor = useMemo(() => (anovaSupervisor ? tukeyHSD(anovaSupervisor) : []), [anovaSupervisor]);
  const supervisorKPI = useMemo(() => {
    const vals: number[] = [];
    let mt = 0;
    completed.forEach((b: any) => {
      if (!(b.shift_supervisor || "").trim()) return;
      const v = Number(b.avg_reading);
      if (Number.isFinite(v)) vals.push(v);
      mt += Number(b.total_weight) || 0;
    });
    const n = vals.length;
    const m = n ? vals.reduce((s, x) => s + x, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(vals.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : 0;
    const spec = COATING_SPEC[(fCoatingSingle ?? 87) as 65 | 87 | 130] || COATING_SPEC[87];
    const cp = sd > 0 ? (spec.usl - spec.lsl) / (6 * sd) : null;
    const cpk = sd > 0 ? Math.min((spec.usl - m) / (3 * sd), (m - spec.lsl) / (3 * sd)) : null;
    const sigma = cpk != null ? cpk * 3 : null;
    return { beams: n, mt, avg: m, sd, cp, cpk, sigma };
  }, [completed, fCoatingSingle]);
  const supervisorBar = useMemo(
    () => (anovaSupervisor?.groups || [])
      .map((g: any) => ({ supervisor: g.label, avg: +g.mean.toFixed(2), n: g.n, variance: +g.variance.toFixed(2) }))
      .sort((a: any, b: any) => b.avg - a.avg),
    [anovaSupervisor],
  );




  const anovaMatSurf = useMemo(() => {
    const rows: { a: string; b: string; value: number }[] = [];
    completed.forEach((b: any) => {
      const v = Number(b.avg_reading);
      if (b.material_type && b.surface_condition && Number.isFinite(v)) {
        rows.push({ a: b.material_type, b: b.surface_condition, value: v });
      }
    });
    return twoWayAnova(rows);
  }, [completed]);

  // ── 10. Pareto Analysis of Defects ──────────────────────────────────
  const pareto = useMemo(() => {
    const fails = completed.filter((b: any) => b.qc_status === "FAIL");
    const cats: Record<string, { count: number; beams: string[] }> = {};
    const bump = (k: string, beam: string) => {
      if (!cats[k]) cats[k] = { count: 0, beams: [] };
      cats[k].count++;
      if (cats[k].beams.length < 8) cats[k].beams.push(beam);
    };
    fails.forEach((b: any) => {
      const m = Number(b.coating_required);
      const sp = QCR[m];
      const v = Number(b.avg_reading);
      const t = Number(b.bath_temperature);
      const d = dipSecs(b);
      const bn = b.beam_no ?? b.beam_id ?? "—";
      let flagged = false;
      if (sp && Number.isFinite(v)) {
        if (v < sp.min) { bump(`Coating below LSL (${m} µm)`, bn); flagged = true; }
        else if (v > sp.ok_max) { bump(`Coating above USL (${m} µm)`, bn); flagged = true; }
      }
      if (Number.isFinite(t)) {
        if (t < TEMP_SPEC.lsl) { bump("Bath temp below 445 °C", bn); flagged = true; }
        else if (t > TEMP_SPEC.usl) { bump("Bath temp above 456 °C", bn); flagged = true; }
      }
      if (d != null) {
        if (d < 90) { bump("Dip time < 90 s", bn); flagged = true; }
        else if (d > 400) { bump("Dip time > 400 s", bn); flagged = true; }
      }
      const rem = String(b.qc_auto_remark || b.qc_remark || "").trim();
      if (!flagged) bump(rem ? `Other — ${rem.slice(0, 40)}` : "Other / unspecified", bn);
    });
    const rows = Object.entries(cats)
      .map(([reason, v]) => ({ reason, count: v.count, beams: v.beams }))
      .sort((a, b) => b.count - a.count);
    const total = rows.reduce((s, r) => s + r.count, 0) || 1;
    let cum = 0;
    const withCum = rows.map((r) => {
      cum += r.count;
      return { ...r, pct: +(r.count / total * 100).toFixed(2), cumPct: +(cum / total * 100).toFixed(2) };
    });
    const vital = withCum.filter((r) => r.cumPct <= 80.001);
    const trivial = withCum.filter((r) => r.cumPct > 80.001);
    return { rows: withCum, total, failCount: fails.length, doneCount: completed.length, vital, trivial };
  }, [completed, QCR]);

  // ── 9. Management summary ───────────────────────────────────────────
  const bestShift = [...shiftPerf].sort((a, b) => (b.sigma || 0) - (a.sigma || 0))[0];
  const bestOperator = [...operatorPerf].sort((a, b) => (b.sigma || 0) - (a.sigma || 0))[0];
  const bestLoad = [...loadTypePerf].sort((a, b) => b.yield - a.yield)[0];
  const outOfControlCount =
    (spcCoating?.violations || 0) + (spcDip?.violations || 0) + (spcTemp?.violations || 0);
  const overallCpk = coatStats.find((s) => s.micron === ((fCoatingSingle ?? 87)))?.cpk ?? null;

  // ── AI Insights ──────────────────────────────────────────────────────
  const askAi = useServerFn(getSixSigmaInsights);
  const [aiText, setAiText] = useState<string>("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  async function runAi() {
    setAiBusy(true); setAiErr(null);
    try {
      const res: any = await askAi({
        data: {
          rangeLabel: `Production day ${productionRangeLabel(fromDate, toDate)} (IST)`,
          capability: coatStats.map((s) => ({
            micron: s.micron, n: s.n,
            mean: s.n ? +s.mean.toFixed(2) : null,
            sd: s.n ? +s.sd.toFixed(2) : null,
            cp: s.cp != null ? +s.cp.toFixed(2) : null,
            cpk: s.cpk != null ? +s.cpk.toFixed(2) : null,
          })),
          bestParams,
          shift: shiftPerf,
          operator: operatorPerf,
          loadType: loadTypePerf,
          outOfControl: outOfControlCount,
        },
      });
      if (res?.ok) setAiText(res.text);
      else setAiErr(res?.error || "AI unavailable");
    } catch (e: any) {
      setAiErr(String(e?.message || e));
    } finally {
      setAiBusy(false);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Header */}
      <div style={{ background: "linear-gradient(135deg,#0A1628,#0D1E38)", border: "1px solid #33434F",
        borderRadius: 12, padding: "16px 20px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg,#3D7EA6,#2E6285)",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24,
          boxShadow: "0 0 18px rgba(61,126,166,.5)" }}>📈</div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: "#C9D6DF", letterSpacing: ".06em" }}>SIX SIGMA GALVANIZING DASHBOARD</div>
          <div style={{ fontSize: 11, color: "#8DA0AD", marginTop: 2 }}>SPC · Cpk · Process Intelligence · AI Recommendations</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <KCard label="Today MT" value={todayMT} color="#3D7EA6" T={T} />
          <KCard label="Pending / Running / Done" value={`${pending} / ${running} / ${done}`} color="#5BA3FF" T={T} />
          <KCard label="Out-of-control" value={outOfControlCount} color={outOfControlCount ? "#F87171" : "#4ADE80"} T={T} />
        </div>
      </div>

      {/* Global filters */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: T.card, border: `1px solid ${T.border}`,
        borderRadius: 10, padding: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ fontSize: 11, color: T.muted, fontWeight: 700, letterSpacing: ".06em" }}>FILTERS</div>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
          style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 8px", fontSize: 12 }} />
        <span style={{ color: T.dim, fontSize: 11 }}>to</span>
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
          style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 8px", fontSize: 12 }} />
        <span style={{ color: T.dim, fontSize: 10 }}>Production day {productionRangeLabel(fromDate, toDate)} (IST)</span>
        <MultiSelectFilter T={T} width={150} allLabel="All shifts" value={fShift} onChange={setFShift}
          options={[{ value: "A", label: "Shift A (06–14)" }, { value: "B", label: "Shift B (14–22)" }, { value: "C", label: "Shift C (22–06)" }]} />
        <MultiSelectFilter T={T} width={170} allLabel="All operators" value={fOperator} onChange={setFOperator}
          options={operators} />
        <MultiSelectFilter T={T} width={150} allLabel="All load types" value={fLoadType} onChange={setFLoadType}
          options={loadTypes} />
        <MultiSelectFilter T={T} width={140} allLabel="All coatings" value={fCoating} onChange={setFCoating}
          options={COATINGS.map((c) => ({ value: String(c), label: `${c} micron` }))} />
        <MultiSelectFilter T={T} width={130} allLabel="All materials" value={fMaterial} onChange={setFMaterial}
          options={[{ value: "MS", label: "MS" }, { value: "HT", label: "HT" }]} />
        <MultiSelectFilter T={T} width={140} allLabel="All surfaces" value={fSurface} onChange={setFSurface}
          options={[{ value: "normal", label: "Normal" }, { value: "rusted", label: "Rusted" }, { value: "heavy_rusted", label: "Heavy Rusted" }]} />

        <input value={fBeam} onChange={(e) => setFBeam(e.target.value)} placeholder="Beam no…"
          style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 8px", fontSize: 12, width: 120 }} />
        <span style={{ marginLeft: "auto", fontSize: 11, color: T.dim }}>
          {beams.length} beams · {completed.length} with QC reading
        </span>
      </div>


      {/* 1. Production Overview */}
      <Section id="s1" title="1. Production Overview" sub="Live production KPIs and trends" T={T}>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10, marginBottom: 14 }}>
          <KCard label="Today (MT)" value={todayMT} color="#3D7EA6" T={T} />
          <KCard label="Shift A (06–14)" value={shiftToday.A.toFixed(2)} color="#5BA3FF" T={T} />
          <KCard label="Shift B (14–22)" value={shiftToday.B.toFixed(2)} color="#A78BFA" T={T} />
          <KCard label="Shift C (22–06)" value={shiftToday.C.toFixed(2)} color="#22D3EE" T={T} />

          <KCard label="Month (MT)" value={monthMT} color="#4ADE80" T={T} />
          <KCard label="Capacity Util." value={`${capacityPct}%`} color="#FB923C" T={T} />
          <KCard label="Pending" value={pending} color="#FBBF24" T={T} />
          <KCard label="Running" value={running} color="#22D3EE" T={T} />
          <KCard label="Completed" value={done} color="#4ADE80" T={T} />
          <KCard label="Avg Dip Time" value={fmtSec(avgDipAll)} color="#FB923C" T={T} />
          <KCard label="Zinc Bath °C" value={latestTemp ?? "—"} color="#F87171" T={T} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(130px,1fr))", gap: 10, marginBottom: 14 }}>
          {show65 && <KCard label="65 µm Production" value={`${coatingSpecMT[65].toFixed(2)} MT`} color="#5BA3FF" T={T} />}
          <KCard label="87 µm Production" value={`${coatingSpecMT[87].toFixed(2)} MT`} color="#A78BFA" T={T} />
          <KCard label="130 µm Production" value={`${coatingSpecMT[130].toFixed(2)} MT`} color="#22D3EE" T={T} />
          <KCard label="Total (filtered)" value={`${coatingSpecMT.total.toFixed(2)} MT`} color="#3D7EA6" T={T} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 12 }}>
          <div style={{ height: 220 }}>
            <div style={{ fontSize: 11, color: T.muted, fontWeight: 700, marginBottom: 6 }}>DAILY PRODUCTION (30 DAYS)</div>
            <ResponsiveContainer><LineChart data={daily30}>
              <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} />
              <YAxis tick={{ fontSize: 10, fill: T.muted }}  tickFormatter={fmtAxis} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="mt" stroke="#3D7EA6" strokeWidth={2} dot={false} name="MT" />
              <Line type="monotone" dataKey="avg" stroke="#5BA3FF" strokeWidth={2} dot={false} name="Avg µm" />
            </LineChart></ResponsiveContainer>
          </div>
          <div style={{ height: 220 }}>
            <div style={{ fontSize: 11, color: T.muted, fontWeight: 700, marginBottom: 6 }}>HOURLY (TODAY)</div>
            <ResponsiveContainer><BarChart data={hourly}>
              <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
              <XAxis dataKey="hr" tick={{ fontSize: 9, fill: T.muted }} />
              <YAxis tick={{ fontSize: 10, fill: T.muted }}  tickFormatter={fmtAxis} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="mt" fill="#5BA3FF" />
            </BarChart></ResponsiveContainer>
          </div>
          <div style={{ height: 220 }}>
            <div style={{ fontSize: 11, color: T.muted, fontWeight: 700, marginBottom: 6 }}>SHIFT COMPARISON</div>
            <ResponsiveContainer><BarChart data={shiftCompare}>
              <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
              <XAxis dataKey="shift" tick={{ fontSize: 10, fill: T.muted }} />
              <YAxis tick={{ fontSize: 10, fill: T.muted }}  tickFormatter={fmtAxis} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="mt" fill="#3D7EA6" name="MT" />
              <Bar dataKey="beams" fill="#5BA3FF" name="Beams" />
            </BarChart></ResponsiveContainer>
          </div>
        </div>
      </Section>

      {/* 2. Coating Thickness Analytics */}
      <Section id="s2" title="2. Coating Thickness Analytics" sub="Per coating spec — 65 / 87 / 130 µm" T={T}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 14 }}>
          {coatStats.map((s) => {
            const hist = histogram(s.xs, 12);
            const curve = hist.length ? hist.map((h) => ({ bin: h.bin, count: h.count,
              norm: normalPdf(h.bin, s.mean, s.sd || 0.001) * s.xs.length * ((hist[hist.length - 1].bin - hist[0].bin) / Math.max(1, hist.length - 1)) })) : [];
            const trend = completed
              .filter((b: any) => Number(b.coating_required) === s.micron)
              .sort((a: any, b: any) => +new Date(a.qc_completed_at || 0) - +new Date(b.qc_completed_at || 0))
              .slice(-30)
              .map((b: any, i: number) => ({ i: i + 1, v: Number(b.avg_reading), beam: b.beam_no }));
            return (
              <div key={s.micron} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 900, color: "#3D7EA6" }}>{s.micron} µm spec</div>
                  <Light cpkVal={s.cpk} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 10 }}>
                  {[
                    ["n", s.n], ["Mean", num(s.mean, 1)], ["Median", num(s.median, 1)], ["Mode", num(s.mode, 1)],
                    ["SD (s)", num(s.sd, 1)], ["SD (σ)", num(s.sdPop, 1)], ["Min", num(s.min, 1)], ["Max", num(s.max, 1)],
                    ["Range", num(s.range, 1)], ["Cp", s.cp != null ? num(s.cp, 1) : "—"], ["Cpk", s.cpk != null ? num(s.cpk, 1) : "—"], ["Sigma", s.sigma != null ? num(s.sigma, 1) : "—"],
                    ["Pp", s.pp != null ? num(s.pp, 1) : "—"], ["Ppk", s.ppk != null ? num(s.ppk, 1) : "—"], ["LSL", s.lsl], ["USL", s.usl],
                  ].map(([l, v]) => (
                    <div key={l as string} style={{ background: T.card, borderRadius: 6, padding: "4px 6px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: T.muted, letterSpacing: ".06em" }}>{l}</div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: T.text, fontFamily: "monospace" }}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ height: 130 }}>
                  <ResponsiveContainer><BarChart data={curve}>
                    <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
                    <XAxis dataKey="bin" tick={{ fontSize: 9, fill: T.muted }}  tickFormatter={fmtAxis} />
                    <YAxis tick={{ fontSize: 9, fill: T.muted }}  tickFormatter={fmtAxis} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="count" fill="#5BA3FF" />
                    <Line type="monotone" dataKey="norm" stroke="#3D7EA6" strokeWidth={2} dot={false} />
                    <ReferenceLine x={s.lsl} stroke="#F87171" strokeDasharray="3 3" />
                    <ReferenceLine x={s.usl} stroke="#F87171" strokeDasharray="3 3" />
                  </BarChart></ResponsiveContainer>
                </div>
                {/* Normality Test */}
                <div style={{ marginTop: 10, background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "#5BA3FF" }}>Normality Test</div>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4,
                      background: s.normality.normal == null ? "#1A2436" : s.normality.normal ? "#07240F" : "#2A0808",
                      color: s.normality.normal == null ? T.muted : s.normality.normal ? "#4ADE80" : "#F87171" }}>
                      {s.normality.normal == null ? "NOT AVAILABLE" : s.normality.normal ? "NORMAL" : "NOT NORMAL"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6 }}>
                    {[
                      ["Sample Size", s.normality.n],
                      ["Mean", num(s.normality.mean, 1)],
                      ["Median", num(s.normality.median, 1)],
                      ["Std Dev", num(s.normality.sd, 1)],
                      ["Minimum", num(s.normality.min, 1)],
                      ["Maximum", num(s.normality.max, 1)],
                      ["LSL", s.lsl],
                      ["USL", s.usl],
                      ["Method", s.normality.method ?? "—"],
                      ["Statistic", s.normality.statistic != null ? s.normality.statistic.toFixed(4) : "—"],
                      ["P-value", s.normality.pValue != null ? s.normality.pValue.toFixed(4) : "—"],
                      ["α", "0.05"],
                    ].map(([l, v]) => (
                      <div key={l as string} style={{ background: T.bg, borderRadius: 6, padding: "4px 6px", textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: T.muted, letterSpacing: ".06em" }}>{l}</div>
                        <div style={{ fontSize: 12, fontWeight: 800, color: T.text, fontFamily: "monospace" }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 10, color: T.muted, lineHeight: 1.5 }}>{s.normality.interpretation}</div>
                </div>
                <div style={{ height: 110, marginTop: 6 }}>
                  <ResponsiveContainer><LineChart data={trend}>
                    <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
                    <XAxis dataKey="i" tick={{ fontSize: 9, fill: T.muted }}  tickFormatter={fmtAxis} />
                    <YAxis tick={{ fontSize: 9, fill: T.muted }} domain={["auto", "auto"]}  tickFormatter={fmtAxis} />
                    <Tooltip content={<ChartTooltip />} />
                    <ReferenceLine y={s.lsl} stroke="#F87171" strokeDasharray="3 3" />
                    <ReferenceLine y={s.usl} stroke="#F87171" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="v" stroke="#4ADE80" strokeWidth={2} dot={false} />
                  </LineChart></ResponsiveContainer>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* 3. SPC Control Center — per coating spec + global Dip Time / Bath Temp */}
      <Section id="s3" title="3. Six Sigma SPC Control Center" sub="Coating X̄-R (n=5) · Dipping Time / Bath Temp I-MR · 4-rule engine: beyond limits · 7 same-side · 7 trend · cyclic" T={T}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
          {spcCoatingBySpec.map((g) => (
            <div key={g.micron} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 900, color: "#3D7EA6" }}>{g.micron} µm spec · n={g.n}</div>
                {g.spc ? (
                  <span style={{ fontSize: 11, fontWeight: 700, color: g.spc.stable ? "#4ADE80" : "#F87171" }}>
                    {g.spc.stable ? "🟢 STABLE" : `🔴 UNSTABLE — ${g.spc.violations} WE-rule violations`}
                  </span>
                ) : <span style={{ fontSize: 11, color: T.dim }}>Insufficient data</span>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 6, marginBottom: 10 }}>
                {[
                  ["Cp", g.cp != null ? g.cp.toFixed(2) : "—"],
                  ["Cpk", g.cpk != null ? g.cpk.toFixed(2) : "—"],
                  ["Pp", g.pp != null ? g.pp.toFixed(2) : "—"],
                  ["Ppk", g.ppk != null ? g.ppk.toFixed(2) : "—"],
                  ["Sigma", g.sigma != null ? g.sigma.toFixed(2) : "—"],
                ].map(([l, v]) => (
                  <div key={l as string} style={{ background: T.card, borderRadius: 6, padding: "5px 8px", textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: T.muted, letterSpacing: ".06em" }}>{l}</div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: T.text, fontFamily: "monospace" }}>{v}</div>
                  </div>
                ))}
              </div>
              {g.spc && (() => {
                const yLo = Math.min(g.spc.lcl, g.lsl, ...g.spc.data.map((d: any) => d.v)) - 1;
                const yHi = Math.max(g.spc.ucl, g.usl, ...g.spc.data.map((d: any) => d.v)) + 1;
                const plot = g.spc.data.map((d: any, i: number) => ({ ...d, i: i + 1 }));
                return (
                  <>
                    <div style={{ fontSize: 10, color: T.muted, marginBottom: 4 }}>
                      LSL {g.lsl} · UCL {g.spc.ucl.toFixed(2)} · CL {g.spc.cl.toFixed(2)} · LCL {g.spc.lcl.toFixed(2)} · USL {g.usl}
                    </div>
                    <div style={{ height: 220 }}>
                      <ResponsiveContainer><LineChart data={plot} margin={{ top: 6, right: 8, bottom: 18, left: 0 }}>
                        <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
                        <XAxis dataKey="i" type="number" domain={[1, plot.length]} tick={{ fontSize: 9, fill: T.muted }} label={{ value: "Beam # (chronological)", fill: T.muted, fontSize: 10, dy: 12 }}  tickFormatter={fmtAxis} />
                        <YAxis tick={{ fontSize: 10, fill: T.muted }} domain={[yLo, yHi]}  tickFormatter={fmtAxis} />
                        <Tooltip {...TIP} content={({ active, payload }: any) => {
                          if (!active || !payload?.[0]) return null;
                          const p = payload[0].payload;
                          const ts = p.b?.qc_completed_at || p.b?.dipped_at;
                          return (
                            <div style={{ background: T.card, border: `1px solid ${T.border}`, padding: 6, fontSize: 11, color: T.text }}>
                              <div style={{ fontWeight: 700 }}>Beam {p.label}</div>
                              <div style={{ color: T.muted, fontSize: 10 }}>{ts ? fmtDateTimeTz(ts) : "—"}</div>
                              <div>Coating: <b>{Number(p.v).toFixed(2)} µm</b></div>
                              {p.oc && <div style={{ color: "#F87171" }}>⚠ SPC rule violation</div>}
                            </div>
                          );
                        }} />
                        <ReferenceLine y={g.spc.cl} stroke="#5BA3FF" strokeDasharray="4 4" />
                        <ReferenceLine y={g.spc.ucl} stroke="#F87171" />
                        <ReferenceLine y={g.spc.lcl} stroke="#F87171" />
                        <ReferenceLine y={g.lsl} stroke="#FBBF24" strokeDasharray="2 4" />
                        <ReferenceLine y={g.usl} stroke="#FBBF24" strokeDasharray="2 4" />
                        <Line type="monotone" dataKey="v" stroke="#3D7EA6" strokeWidth={2}
                          dot={(props: any) => {
                            const { cx, cy, payload } = props;
                            return <circle cx={cx} cy={cy} r={payload.oc ? 5 : 2.5} fill={payload.oc ? "#F87171" : "#3D7EA6"} stroke={payload.oc ? "#fff" : "none"} strokeWidth={payload.oc ? 1 : 0} />;
                          }} />
                      </LineChart></ResponsiveContainer>
                    </div>
                  </>
                );
              })()}
            </div>
          ))}
          {[
            { title: "Dipping Time (min)", data: spcDip, spec: null as null | { lsl: number; usl: number } },
            { title: "Zinc Bath Temperature (°C)", data: spcTemp, spec: TEMP_SPEC },
          ].map(({ title, data, spec }) => (
            <div key={title} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: T.text }}>{title}</div>
                {data ? (
                  <span style={{ fontSize: 11, fontWeight: 700, color: data.stable ? "#4ADE80" : "#F87171" }}>
                    {data.stable ? "🟢 STABLE" : `🔴 UNSTABLE — ${data.violations} violations`}
                  </span>
                ) : <span style={{ fontSize: 11, color: T.dim }}>Insufficient data</span>}
              </div>
              {data && (() => {
                const yLo = Math.min(data.lcl, spec ? spec.lsl : data.lcl, ...data.data.map((d: any) => d.v)) - 1;
                const yHi = Math.max(data.ucl, spec ? spec.usl : data.ucl, ...data.data.map((d: any) => d.v)) + 1;
                const plot = data.data.map((d: any, i: number) => ({ ...d, i: i + 1 }));
                return (
                  <>
                    <div style={{ fontSize: 10, color: T.muted, marginBottom: 4 }}>
                      UCL {data.ucl.toFixed(2)} · CL {data.cl.toFixed(2)} · LCL {data.lcl.toFixed(2)}
                      {spec && ` · LSL ${spec.lsl} · USL ${spec.usl}`}
                    </div>
                    <div style={{ height: 220 }}>
                      <ResponsiveContainer><LineChart data={plot} margin={{ top: 6, right: 8, bottom: 18, left: 0 }}>
                        <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
                        <XAxis dataKey="i" type="number" domain={[1, plot.length]} tick={{ fontSize: 9, fill: T.muted }} label={{ value: "Beam # (chronological)", fill: T.muted, fontSize: 10, dy: 12 }}  tickFormatter={fmtAxis} />
                        <YAxis tick={{ fontSize: 10, fill: T.muted }} domain={[yLo, yHi]}  tickFormatter={fmtAxis} />
                        <Tooltip {...TIP} content={({ active, payload }: any) => {
                          if (!active || !payload?.[0]) return null;
                          const p = payload[0].payload;
                          const ts = p.b?.qc_completed_at || p.b?.dipped_at;
                          return (
                            <div style={{ background: T.card, border: `1px solid ${T.border}`, padding: 6, fontSize: 11, color: T.text }}>
                              <div style={{ fontWeight: 700 }}>Beam {p.label}</div>
                              <div style={{ color: T.muted, fontSize: 10 }}>{ts ? fmtDateTimeTz(ts) : "—"}</div>
                              <div>Value: <b>{Number(p.v).toFixed(2)}</b></div>
                              {p.oc && <div style={{ color: "#F87171" }}>⚠ SPC rule violation</div>}
                            </div>
                          );
                        }} />
                        <ReferenceLine y={data.cl} stroke="#5BA3FF" strokeDasharray="4 4" />
                        <ReferenceLine y={data.ucl} stroke="#F87171" />
                        <ReferenceLine y={data.lcl} stroke="#F87171" />
                        {spec && <ReferenceLine y={spec.lsl} stroke="#FBBF24" strokeDasharray="2 4" />}
                        {spec && <ReferenceLine y={spec.usl} stroke="#FBBF24" strokeDasharray="2 4" />}
                        <Line type="monotone" dataKey="v" stroke="#3D7EA6" strokeWidth={2}
                          dot={(props: any) => {
                            const { cx, cy, payload } = props;
                            return <circle cx={cx} cy={cy} r={payload.oc ? 5 : 2.5} fill={payload.oc ? "#F87171" : "#3D7EA6"} stroke={payload.oc ? "#fff" : "none"} strokeWidth={payload.oc ? 1 : 0} />;
                          }} />
                      </LineChart></ResponsiveContainer>
                    </div>
                  </>
                );
              })()}
            </div>
          ))}
        </div>

        {/* Pareto — SPC Deviations block removed; consolidated into Section 10 below. */}

      </Section>


      {/* Pareto Deviation Analysis — SPC Deviations (moved above Section 4). */}
      <Section id="s10" title="Pareto Deviation Analysis — SPC Deviations"
        sub="80/20 split of statistical process-control rule violations across monitored parameters" T={T}>
        {(() => {
          // Group SPC violation events by (Parameter · Rule).
          const bucket: Record<string, { reason: string; count: number; beams: string[] }> = {};
          for (const r of spcViolationRows) {
            const key = `${r.parameter} · R${r.rule}`;
            const b = (bucket[key] ??= { reason: key, count: 0, beams: [] });
            b.count += 1;
            if (r.beam_no && b.beams.length < 6 && !b.beams.includes(r.beam_no)) b.beams.push(r.beam_no);
          }
          const sorted = Object.values(bucket).sort((a, b) => b.count - a.count);
          const total = sorted.reduce((s, r) => s + r.count, 0);
          let cum = 0;
          const rows = sorted.map((r) => {
            cum += r.count;
            const pct = total ? +(100 * r.count / total).toFixed(2) : 0;
            const cumPct = total ? +(100 * cum / total).toFixed(2) : 0;
            return { ...r, pct, cumPct };
          });
          const vital = rows.filter((r) => r.cumPct <= 80.001);
          const trivial = rows.filter((r) => r.cumPct > 80.001);
          if (rows.length === 0) {
            return (
              <div style={{ padding: 20, textAlign: "center", color: T.dim, fontSize: 12 }}>
                No SPC deviations in the current filter window — all monitored parameters are in statistical control. ✅
              </div>
            );
          }
          return (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10, marginBottom: 12 }}>
                <KCard label="Total Deviations" value={total} color="#F87171" T={T} />
                <KCard label="Distinct Categories" value={rows.length} color="#5BA3FF" T={T} />
                <KCard label="Vital Few (≤80%)" value={vital.length} color="#3D7EA6" T={T} />
                <KCard label="Trivial Many" value={trivial.length} color="#A78BFA" T={T} />
              </div>
              <div style={{ height: 280, marginBottom: 12 }}>
                <ResponsiveContainer>
                  <BarChart data={rows} margin={{ top: 10, right: 40, left: 0, bottom: 60 }}>
                    <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
                    <XAxis dataKey="reason" tick={{ fontSize: 9, fill: T.muted }} angle={-25} textAnchor="end" interval={0} height={70} />
                    <YAxis yAxisId="l" tick={{ fontSize: 10, fill: T.muted }} label={{ value: "Count", angle: -90, position: "insideLeft", fill: T.muted, fontSize: 10 }}  tickFormatter={fmtAxis} />
                    <YAxis yAxisId="r" orientation="right" domain={[0, 100]} tick={{ fontSize: 10, fill: T.muted }}
                      label={{ value: "Cumulative %", angle: 90, position: "insideRight", fill: T.muted, fontSize: 10 }}  tickFormatter={fmtAxis} />
                    <Tooltip content={<ChartTooltip />} />
                    <ReferenceLine yAxisId="r" y={80} stroke="#3D7EA6" strokeDasharray="4 4" label={{ value: "80%", fill: "#3D7EA6", fontSize: 10, position: "right" }} />
                    <Bar yAxisId="l" dataKey="count" name="Deviations">
                      {rows.map((r, i) => (
                        <Cell key={i} fill={r.cumPct <= 80.001 ? "#F87171" : "#8DA0AD"} />
                      ))}
                    </Bar>
                    <Line yAxisId="r" type="monotone" dataKey="cumPct" name="Cumulative %" stroke="#3D7EA6" strokeWidth={2} dot={{ r: 3, fill: "#3D7EA6" }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{ overflow: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: T.card, color: T.muted }}>
                      <th style={{ padding: 6, textAlign: "left" }}>#</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Parameter · Rule</th>
                      <th style={{ padding: 6, textAlign: "right" }}>Count</th>
                      <th style={{ padding: 6, textAlign: "right" }}>%</th>
                      <th style={{ padding: 6, textAlign: "right" }}>Cum %</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Zone</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Sample Beams</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const v = r.cumPct <= 80.001;
                      return (
                        <tr key={r.reason} style={{ borderTop: `1px solid ${T.border}` }}>
                          <td style={{ padding: 6, color: T.dim }}>{i + 1}</td>
                          <td style={{ padding: 6, color: T.text, fontWeight: 600 }}>{r.reason}</td>
                          <td style={{ padding: 6, textAlign: "right", fontFamily: "monospace", color: T.text }}>{r.count}</td>
                          <td style={{ padding: 6, textAlign: "right", fontFamily: "monospace", color: T.text }}>{r.pct}%</td>
                          <td style={{ padding: 6, textAlign: "right", fontFamily: "monospace", color: T.text }}>{r.cumPct}%</td>
                          <td style={{ padding: 6 }}>
                            <span style={{ fontSize: 10, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                              background: v ? "#F8717122" : "#8DA0AD22", color: v ? "#F87171" : "#8AA3C0" }}>
                              {v ? "VITAL FEW" : "TRIVIAL MANY"}
                            </span>
                          </td>
                          <td style={{ padding: 6, color: T.dim, fontFamily: "monospace", fontSize: 10 }}>
                            {r.beams.join(", ") || "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 16, overflow: "auto" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: T.text, marginBottom: 6, letterSpacing: ".03em" }}>
                  Deviation Events · Beam-Level Detail
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: T.card, color: T.muted }}>
                      <th style={{ padding: 6, textAlign: "left" }}>Beam #</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Date &amp; Time</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Parameter</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Rule</th>
                      <th style={{ padding: 6, textAlign: "right" }}>Value</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Material</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Load Type</th>
                      <th style={{ padding: 6, textAlign: "right" }}>Weight (MT)</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Dipping Operator</th>
                      
                    </tr>
                  </thead>
                  <tbody>
                    {spcViolationRows.map((r: any, i: number) => (
                      <tr key={i} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: 6, color: "#3D7EA6", fontFamily: "monospace", fontWeight: 700 }}>{r.beam_no}</td>
                        <td style={{ padding: 6, color: T.dim, fontSize: 10 }}>{r.when}</td>
                        <td style={{ padding: 6, color: T.text }}>{r.parameter}</td>
                        <td style={{ padding: 6, color: "#F87171", fontWeight: 700 }}>R{r.rule} · {r.ruleLabel}</td>
                        <td style={{ padding: 6, textAlign: "right", fontFamily: "monospace", color: T.text }}>
                          {typeof r.value === "number" ? r.value.toFixed(2) : r.value}
                        </td>
                        <td style={{ padding: 6, color: T.text }}>{r.material}</td>
                        <td style={{ padding: 6, color: T.text }}>{r.load_type}</td>
                        <td style={{ padding: 6, textAlign: "right", fontFamily: "monospace", color: T.text }}>{r.weight}</td>
                        <td style={{ padding: 6, color: T.text }}>{r.dip_op}</td>
                        
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 10, fontSize: 11, color: T.dim, lineHeight: 1.6 }}>
                <strong style={{ color: "#3D7EA6" }}>Interpretation:</strong> ~80% of SPC deviations typically stem from
                ~20% of parameter/rule combinations. Prioritise corrective action on the
                <span style={{ color: "#F87171", fontWeight: 700 }}> VITAL FEW </span> categories above.
              </div>
            </>
          );
        })()}
      </Section>


      {/* 4. Dipping Time Intelligence */}
      <Section id="s4" title="4. Dipping Time Intelligence" sub="Select an analysis metric to update chart and statistics" T={T}>
        {(() => {
          const sel = regressions.find((r) => r.key === predictorKey) || regressions[0];
          const xs = sel.pts.map((p: any) => p.x).filter((n: number) => Number.isFinite(n));
          const ys = sel.pts.map((p: any) => p.y).filter((n: number) => Number.isFinite(n));
          const xMin = xs.length ? Math.min(...xs) : 0;
          const xMax = xs.length ? Math.max(...xs) : 1;
          const yMin = ys.length ? Math.min(...ys) : 0;
          const yMax = ys.length ? Math.max(...ys) : 1;
          // Pad Y domain by 10% but keep it locked so an ill-conditioned
          // regression intercept can't blow the axis up to timestamp-scale numbers.
          const yPad = Math.max(1, (yMax - yMin) * 0.1);
          const yLo = Math.max(0, yMin - yPad);
          const yHi = yMax + yPad;
          // Clamp fit-line endpoints into the Y domain so Recharts never
          // auto-scales past real data values.
          const clampY = (v: number) => Math.max(yLo, Math.min(yHi, Number.isFinite(v) ? v : yLo));
          const fit = [
            { x: xMin, y: clampY(sel.a + sel.b * xMin) },
            { x: xMax, y: clampY(sel.a + sel.b * xMax) },
          ];
          const rColor = Math.abs(sel.r) >= 0.7 ? "#4ADE80" : Math.abs(sel.r) >= 0.4 ? "#FBBF24" : "#F87171";
          const eq = `y = ${sel.a.toFixed(2)} ${sel.b >= 0 ? "+" : "−"} ${Math.abs(sel.b).toFixed(2)}·x`;
          const OPTIONS: { key: typeof predictorKey; label: string }[] = [
            { key: "dip",         label: "Dipping Time vs Coating (Micron)" },
            { key: "temp",        label: "Bath Temperature vs Coating (Micron)" },
            { key: "thk",         label: "Thickness vs Coating (Micron)" },
            { key: "wt",          label: "Weight vs Coating (Micron)" },
            { key: "immwdr_avg",  label: "Immersion / Withdraw Time vs Avg Coating (Micron)" },
          ];
          return (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12, padding: 10, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: T.muted, letterSpacing: ".05em", textTransform: "uppercase" }}>Analysis:</span>
                <select value={predictorKey} onChange={(e) => setPredictorKey(e.target.value as any)}
                  style={{ padding: "8px 12px", background: T.card, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 12, fontWeight: 600, minWidth: 280 }}>
                  {OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
                <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, color: rColor, padding: "4px 10px", background: rColor + "20", border: `1px solid ${rColor}55`, borderRadius: 999 }}>
                  r = {sel.r.toFixed(2)} · R² = {sel.r2.toFixed(2)} · n = {sel.pts.length}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
                <div style={{ height: 340, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: 8 }}>
                  <div style={{ fontSize: 11, color: T.muted, fontFamily: "monospace", padding: "2px 6px" }}>{eq}</div>
                  <ResponsiveContainer><ScatterChart margin={{ top: 6, right: 12, bottom: 24, left: 0 }}>
                    <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
                    <XAxis type="number" dataKey="x" domain={["dataMin", "dataMax"]} tick={{ fontSize: 10, fill: T.muted }} label={{ value: sel.xLabel, fill: T.muted, fontSize: 11, dy: 14 }}  tickFormatter={fmtAxis} />
                    <YAxis type="number" dataKey="y" domain={[yLo, yHi]} allowDataOverflow tick={{ fontSize: 10, fill: T.muted }} label={{ value: sel.yLabel, angle: -90, fill: T.muted, fontSize: 11, dx: -4 }}  tickFormatter={fmtAxis} />
                    <Tooltip content={<ChartTooltip />} cursor={{ strokeDasharray: "3 3" }} />
                    <Scatter data={sel.pts} fill="#5BA3FF" />
                    <Scatter data={fit} line={{ stroke: "#3D7EA6", strokeWidth: 2 }} lineType="fitting" shape={() => null as any} />
                  </ScatterChart></ResponsiveContainer>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <KCard label="Correlation r" value={sel.r.toFixed(2)} color={rColor} T={T} />
                  <KCard label="R² (fit quality)" value={sel.r2.toFixed(2)} color="#A78BFA" T={T} />
                  <KCard label="Slope" value={sel.b.toFixed(2)} sub={`per unit ${sel.xLabel}`} color="#5BA3FF" T={T} />
                  <KCard label="Intercept (a)" value={sel.a.toFixed(2)} color="#22D3EE" T={T} />
                  <KCard label={`Predicted ŷ at x̄=${sel.xMean.toFixed(2)}`} value={`${sel.predicted.toFixed(2)} µm`} color="#4ADE80" T={T} />
                  <KCard label={`x* for target ${sel.target.toFixed(0)} µm`} value={sel.xTarget != null && Number.isFinite(sel.xTarget) ? sel.xTarget.toFixed(2) : "—"} color="#3D7EA6" T={T} />
                  {predictorKey === "dip" && corr.best && (
                    <div style={{ fontSize: 10, color: T.dim, marginTop: 4, padding: 8, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6 }}>
                      Optimal dip window: <b style={{ color: "#4ADE80" }}>{corr.best.range} min</b> · {Math.round(corr.best.rate * 100)}% pass · n={corr.best.n} · avg temp {corr.best.avgT.toFixed(2)}°C
                    </div>
                  )}
                </div>
              </div>
            </>
          );
        })()}
        {/* Cycle Time breakdown — By Spec / Load Type / Operator */}
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12 }}>
          {[
            { title: "Avg Cycle Time — By Coating Spec", rows: cycleBy.bySpec },
            { title: "Avg Cycle Time — By Load Type", rows: cycleBy.byLoad },
            { title: "Avg Cycle Time — By Operator", rows: cycleBy.byOp },
          ].map(({ title, rows }) => (
            <div key={title}>
              <div style={{ fontSize: 11, color: T.muted, fontWeight: 700, marginBottom: 6 }}>{title.toUpperCase()}</div>
              <Tbl T={T}
                headers={["Group", "Beams", "Avg Cycle Time"]}
                rows={rows.map((r: any) => [r.key, r.n, fmtSec(r.avgCycle)])} />
            </div>
          ))}
        </div>
      </Section>



      {/* 5. Shift Performance */}
      <Section id="s5" title="5. Shift Performance" T={T}>
        <Tbl T={T}
          headers={["Shift", "Beams", "MT", "Avg Coating (µm)", "Avg Dip (min)", "Cp", "Cpk", "Sigma", "Yield (%)"]}
          rows={shiftPerf.map((r) => [r.shift, r.beams, r.mt, r.avgCoat, r.avgDip, r.cp ?? "—", r.cpk ?? "—", r.sigma ?? "—", `${r.yieldPct}%`])} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 10, marginTop: 12 }}>
          <div style={{ height: 200 }}>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>MT vs Avg Coating</div>
            <ResponsiveContainer><BarChart data={shiftPerf}>
              <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
              <XAxis dataKey="shift" tick={{ fontSize: 10, fill: T.muted }} />
              <YAxis tick={{ fontSize: 10, fill: T.muted }}  tickFormatter={fmtAxis} />
              <Tooltip content={<ChartTooltip />} /><Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="mt" fill="#3D7EA6" name="MT" />
              <Bar dataKey="avgCoat" fill="#5BA3FF" name="Avg µm" />
            </BarChart></ResponsiveContainer>
          </div>
          <div style={{ height: 200 }}>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Cp / Cpk / Sigma</div>
            <ResponsiveContainer><BarChart data={shiftPerf}>
              <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
              <XAxis dataKey="shift" tick={{ fontSize: 10, fill: T.muted }} />
              <YAxis tick={{ fontSize: 10, fill: T.muted }}  tickFormatter={fmtAxis} />
              <Tooltip content={<ChartTooltip />} /><Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="cp" fill="#A78BFA" name="Cp" />
              <Bar dataKey="cpk" fill="#4ADE80" name="Cpk" />
              <Bar dataKey="sigma" fill="#22D3EE" name="Sigma" />
            </BarChart></ResponsiveContainer>
          </div>
          <div style={{ height: 200 }}>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Yield %</div>
            <ResponsiveContainer><BarChart data={shiftPerf}>
              <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
              <XAxis dataKey="shift" tick={{ fontSize: 10, fill: T.muted }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: T.muted }}  tickFormatter={fmtAxis} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="yieldPct" fill="#4ADE80" name="Yield %" />
            </BarChart></ResponsiveContainer>
          </div>
        </div>
      </Section>

      {/* Shift Supervisor Performance — reactive ANOVA + Tukey HSD */}
      <Section id="s-supervisor" title="Shift Supervisor Performance — ANOVA & Tukey HSD (α = 0.05)"
        sub="Grouped by Shift Supervisor. Recomputes automatically as filters change." T={T}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: 10, marginBottom: 12 }}>
          <KCard label="Total Beams" value={supervisorKPI.beams} color="#3D7EA6" T={T} />
          <KCard label="Total MT" value={supervisorKPI.mt.toFixed(2)} color="#5BA3FF" T={T} />
          <KCard label="Avg Coating (µm)" value={num(supervisorKPI.avg)} color="#4ADE80" T={T} />
          <KCard label="Std Dev" value={num(supervisorKPI.sd)} color="#A78BFA" T={T} />
          <KCard label="Cp" value={num(supervisorKPI.cp)} color="#22D3EE" T={T} />
          <KCard label="Cpk" value={num(supervisorKPI.cpk)} color="#22D3EE" T={T} />
          <KCard label="Sigma Level" value={num(supervisorKPI.sigma)} color="#FB923C" T={T} />
          <KCard label="Supervisors (k)" value={anovaSupervisor?.k ?? 0} color="#3D7EA6" T={T} />
          <KCard label="F Statistic" value={anovaSupervisor ? num(anovaSupervisor.F) : "—"} color="#FBBF24" T={T} />
          <KCard label="p-value" value={anovaSupervisor ? pFmt(anovaSupervisor.pValue) : "—"}
            color={anovaSupervisor?.significant ? "#4ADE80" : "#71809C"} T={T} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <span style={{ padding: "4px 10px", borderRadius: 999, fontSize: 11, fontWeight: 800,
            background: anovaSupervisor?.significant ? "#4ADE8022" : "#71809622",
            color: anovaSupervisor?.significant ? "#4ADE80" : T.muted,
            border: `1px solid ${anovaSupervisor?.significant ? "#4ADE80" : T.border}` }}>
            {anovaSupervisor?.significant ? "🟢 Significant (p < 0.05)" : "⚪ Not Significant (p ≥ 0.05)"}
          </span>
          {fCoatingSingle == null && (
            <span style={{ marginLeft: 10, fontSize: 11, color: T.dim }}>
              Cp/Cpk/Sigma computed against 87 µm spec — select a single coating filter to lock a spec.
            </span>
          )}
        </div>
        {!anovaSupervisor ? (
          <div style={{ padding: 14, fontSize: 12, color: T.dim, border: `1px dashed ${T.border}`, borderRadius: 6 }}>
            Need ≥ 2 shift supervisors with ≥ 2 beams each in the current filter to run ANOVA.
          </div>
        ) : (
          <>
            <div style={{ height: 260, marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: T.muted, fontWeight: 700, marginBottom: 6 }}>AVG COATING BY SHIFT SUPERVISOR</div>
              <ResponsiveContainer><BarChart data={supervisorBar}>
                <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
                <XAxis dataKey="supervisor" tick={{ fontSize: 10, fill: T.muted }} interval={0} angle={-15} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 10, fill: T.muted }} tickFormatter={fmtAxis} />
                <Tooltip content={<ChartTooltip />} />
                <ReferenceLine y={+supervisorKPI.avg.toFixed(2)} stroke="#3D7EA6" strokeDasharray="4 4" label={{ value: "Grand mean", fill: "#3D7EA6", fontSize: 10 }} />
                <Bar dataKey="avg" fill="#5BA3FF" name="Avg µm" />
                <Bar dataKey="n" fill="#4ADE80" name="N" />
              </BarChart></ResponsiveContainer>
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>ANOVA Summary — Group Statistics</div>
              <Tbl T={T}
                headers={["Shift Supervisor", "N", "Group Mean", "Group Variance"]}
                rows={anovaSupervisor.groups.map((g: any) => [g.label, g.n, g.mean.toFixed(2), g.variance.toFixed(2)])} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>ANOVA Table</div>
              <Tbl T={T}
                headers={["Source", "SS", "df", "MS", "F", "p-value"]}
                rows={[
                  ["Between Groups", anovaSupervisor.ssBetween.toFixed(2), anovaSupervisor.dfBetween, anovaSupervisor.msBetween.toFixed(2), anovaSupervisor.F.toFixed(2), pFmt(anovaSupervisor.pValue)],
                  ["Within Groups", anovaSupervisor.ssWithin.toFixed(2), anovaSupervisor.dfWithin, anovaSupervisor.msWithin.toFixed(2), "—", "—"],
                  ["Total", anovaSupervisor.ssTotal.toFixed(2), anovaSupervisor.dfBetween + anovaSupervisor.dfWithin, "—", "—", "—"],
                ]} />
            </div>
            <div>
              <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Tukey HSD Post-hoc (α = 0.05)</div>
              {!anovaSupervisor.significant ? (
                <div style={{ padding: 10, fontSize: 12, color: T.dim, border: `1px dashed ${T.border}`, borderRadius: 6 }}>
                  Post-hoc comparison skipped — ANOVA not significant.
                </div>
              ) : (
                <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: 8 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: T.bg }}>
                        {["Supervisor A", "Supervisor B", "Mean Diff", "Std Error", "Q Statistic", "Critical Q", "Significant"].map((h) => (
                          <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: T.muted, fontWeight: 700, fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tukeySupervisor.map((p: any, i: number) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${T.border}`, background: p.significant ? "#4ADE8018" : "transparent" }}>
                          <td style={{ padding: "8px 10px", color: T.text }}>{p.a}</td>
                          <td style={{ padding: "8px 10px", color: T.text }}>{p.b}</td>
                          <td style={{ padding: "8px 10px", color: T.text, fontFamily: "monospace" }}>{p.meanDiff.toFixed(2)}</td>
                          <td style={{ padding: "8px 10px", color: T.text, fontFamily: "monospace" }}>{p.se.toFixed(2)}</td>
                          <td style={{ padding: "8px 10px", color: T.text, fontFamily: "monospace" }}>{p.q.toFixed(2)}</td>
                          <td style={{ padding: "8px 10px", color: T.text, fontFamily: "monospace" }}>{p.qCritical.toFixed(2)}</td>
                          <td style={{ padding: "8px 10px", color: p.significant ? "#4ADE80" : T.dim, fontWeight: 800 }}>{p.significant ? "YES" : "no"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </Section>

      {/* 6. Operator Performance */}

      <Section id="s6" title="6. Operator Performance" sub="From the Dipping operator selector" T={T}>
        <Tbl T={T}
          headers={["Operator", "Beams", "Avg Coating (µm)", "Std Dev", "Avg Dip (min)", "Cp", "Cpk", "Sigma", "Yield (%)"]}
          rows={operatorPerf.map((r) => [r.operator, r.beams, r.avgCoat, r.std, r.avgDip, r.cp ?? "—", r.cpk ?? "—", r.sigma ?? "—", `${r.yieldPct}%`])} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8, marginTop: 12 }}>
          <KCard label="Best by Sigma" value={[...operatorPerf].sort((a, b) => (b.sigma || 0) - (a.sigma || 0))[0]?.operator || "—"} color="#4ADE80" T={T} />
          <KCard label="Best by Production" value={[...operatorPerf].sort((a, b) => b.beams - a.beams)[0]?.operator || "—"} color="#3D7EA6" T={T} />
          <KCard label="Lowest Variation" value={[...operatorPerf].filter((r) => r.beams >= 3).sort((a, b) => a.std - b.std)[0]?.operator || "—"} color="#5BA3FF" T={T} />
          <KCard label="Highest Yield" value={[...operatorPerf].filter((r) => r.beams >= 3).sort((a, b) => b.yieldPct - a.yieldPct)[0]?.operator || "—"} color="#A78BFA" T={T} />
        </div>
      </Section>

      {/* 7. Load Type Intelligence */}
      <Section id="s7" title="7. Load Type Intelligence" sub="Derived from existing beam load types" T={T}>
        <Tbl T={T}
          headers={["Load Type", "Qty", "Avg Coating (µm)", "Avg Dip (min)", "Sigma", "Yield (%)"]}
          rows={loadTypePerf.map((r) => [r.type, r.qty, r.avgCoat, r.avgDip, r.sigma ?? "—", `${r.yield}%`])} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8, marginTop: 12 }}>
          <KCard label="Best Performing" value={[...loadTypePerf].sort((a, b) => b.yield - a.yield)[0]?.type || "—"} color="#4ADE80" T={T} />
          <KCard label="Highest Yield" value={`${[...loadTypePerf].sort((a, b) => b.yield - a.yield)[0]?.yield || 0}%`} color="#5BA3FF" T={T} />
          <KCard label="Lowest Dip Time" value={[...loadTypePerf].filter((r) => r.qty >= 2).sort((a, b) => a.avgDip - b.avgDip)[0]?.type || "—"} color="#3D7EA6" T={T} />
          <KCard label="Highest Sigma" value={[...loadTypePerf].filter((r) => r.sigma != null).sort((a, b) => (b.sigma || 0) - (a.sigma || 0))[0]?.type || "—"} color="#A78BFA" T={T} />
          {/* Load ↔ Coating r removed per spec. */}
        </div>
      </Section>

      {/* 7b. Load-wise Coating Dashboard */}
      <Section id="s7b" title="7b. Load-wise Coating Dashboard" sub={fCoatingSingle == null
        ? "All specs — per-load breakdown with avg coating / cycle time per spec"
        : `Filtered to ${fCoatingSingle} µm spec`} T={T}>
        {fCoatingSingle == null ? (
          <Tbl T={T}
            headers={[
              "Load Type", "Total Beams", "Total MT",
              "65 µm Avg", "65 µm Cycle", "87 µm Avg", "87 µm Cycle", "130 µm Avg", "130 µm Cycle",
            ]}
            rows={loadWise.map((r: any) => [
              r.type, r.beams, `${r.mt} MT`,
              r.perSpec[65].avgCoat != null ? `${r.perSpec[65].avgCoat} µm (n=${r.perSpec[65].n})` : "—",
              fmtSec(r.perSpec[65].avgCycle),
              r.perSpec[87].avgCoat != null ? `${r.perSpec[87].avgCoat} µm (n=${r.perSpec[87].n})` : "—",
              fmtSec(r.perSpec[87].avgCycle),
              r.perSpec[130].avgCoat != null ? `${r.perSpec[130].avgCoat} µm (n=${r.perSpec[130].n})` : "—",
              fmtSec(r.perSpec[130].avgCycle),
            ])} />
        ) : (
          <Tbl T={T}
            headers={["Load Type", "Total Beams", "Total MT", `Avg Coating @ ${fCoatingSingle} µm`, "Avg Cycle Time"]}
            rows={loadWise.map((r: any) => [
              r.type, r.beams, `${r.mt} MT`,
              r.avgCoat != null ? `${r.avgCoat} µm` : "—",
              fmtSec(r.avgCycle),
            ])} />
        )}
      </Section>






      {/* 7c. ANOVA & Tukey HSD */}
      <Section id="s7c" title="7c. ANOVA — Statistical Comparison" sub="One-Way & Two-Way ANOVA with Tukey HSD post-hoc (α = 0.05)" T={T}>
        <AnovaBlock T={T} title="One-Way ANOVA: Coating vs Shift" a={anovaShift} tukey={tukeyShift} />
        <AnovaBlock T={T} title="One-Way ANOVA: Coating vs Operator" a={anovaOperator} tukey={tukeyOperator} />
        <AnovaBlock T={T} title="One-Way ANOVA: Coating vs Load Type" a={anovaLoad} tukey={tukeyLoad} />

        <TwoWayAnovaBlock T={T} title="Two-Way ANOVA: Material Type × Surface Condition" a={anovaMatSurf} />
      </Section>

      {/* 8. Best Process Parameters */}
      <Section id="s8" title="8. Best Process Parameters" sub="Hybrid: historical statistical optimum + on-demand AI insights" T={T}
        right={<button onClick={runAi} disabled={aiBusy}
          style={{ padding: "6px 14px", background: aiBusy ? T.bg : "#3D7EA6", color: aiBusy ? T.muted : "#0A1422",
            border: `1px solid #3D7EA6`, borderRadius: 6, fontWeight: 800, fontSize: 11, cursor: aiBusy ? "wait" : "pointer" }}>
          {aiBusy ? "Thinking…" : "🤖 Ask AI for Insights"}
        </button>}>
        <Tbl T={T}
          headers={["Target Coating", "Best Temperature", "Best Dipping Time", "Expected Thickness", "Success Rate", "Sample", "Reference Beam", "Ref Coating"]}
          rows={bestParams.map((r: any) => [
            `${r.micron} µm`,
            r.bestTemp != null ? `${r.bestTemp} °C` : "—",
            r.bestDipSec != null ? fmtSec(r.bestDipSec) : "—",
            r.expected != null ? `${r.expected} µm` : "—",
            `${r.successRate}%`,
            r.sample,
            r.refBeamNo ?? "—",
            r.refCoating != null ? `${r.refCoating} µm` : "—",
          ])} />

        {(aiText || aiErr) && (
          <div style={{ marginTop: 12, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }}>
            {aiErr ? (
              <div style={{ color: "#F87171", fontSize: 12 }}>⚠ {aiErr}</div>
            ) : (
              <div style={{ whiteSpace: "pre-wrap", fontSize: 12, color: T.text, lineHeight: 1.6 }}>{aiText}</div>
            )}
          </div>
        )}
      </Section>

      {/* 9. Management Summary */}
      <Section id="s9" title="9. Management Summary" sub="Daily snapshot" T={T}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10 }}>
          <KCard label="Production Achievement" value={`${capacityPct}%`} color="#3D7EA6" T={T} />
          <KCard label="Avg Coating" value={`${num(mean(completed.map((b: any) => Number(b.avg_reading))), 1)} µm`} color="#5BA3FF" T={T} />
          <KCard label="Avg Dip Time" value={fmtSec(avgDipAll)} color="#FB923C" T={T} />
          <KCard label="Sigma Level (Cpk·3+1.5)" value={overallCpk != null ? (overallCpk * 3 + 1.5).toFixed(2) : "—"} color="#4ADE80" T={T} />
          <KCard label="Best Shift" value={bestShift?.shift || "—"} color="#5BA3FF" T={T} />
          <KCard label="Best Operator" value={bestOperator?.operator || "—"} color="#A78BFA" T={T} />
          <KCard label="Best Load Type" value={bestLoad?.type || "—"} color="#22D3EE" T={T} />
          <KCard label="Cp / Cpk (87 µm)" value={`${num(coatStats[1]?.cp, 1)} / ${num(coatStats[1]?.cpk, 1)}`} color="#4ADE80" T={T} />
          <KCard label="Out-of-Control Events" value={outOfControlCount} color={outOfControlCount ? "#F87171" : "#4ADE80"} T={T} />
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: T.dim }}>
          Tip: click <strong style={{ color: "#3D7EA6" }}>Ask AI for Insights</strong> above to get an AI-written narrative
          summary and top improvement opportunities based on the current filtered data.
        </div>
      </Section>




    </div>
  );
}
