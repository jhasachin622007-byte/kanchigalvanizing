import { useEffect, useState } from "react";
import {
  securityOverview,
  decideDeviceRequest,
  revokeDevice,
  updateSecuritySettings,
  reapproveDevice,
} from "@/lib/security-admin.functions";

type T = any;

type Overview = Awaited<ReturnType<typeof securityOverview>>;

export default function SecurityAdmin({ T }: { T: T }) {
  const [tab, setTab] = useState<"pending" | "devices" | "attempts" | "audit" | "settings">("pending");
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setErr(null);
    try {
      const res = await securityOverview({ data: undefined as never });
      setData(res);
    } catch (e: any) {
      setErr(e?.message || "Failed to load security data");
    }
  };
  useEffect(() => { void load(); }, []);

  const act = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await fn();
      if (r && r.ok === false) setErr(r.error || "Action failed");
      else setMsg(ok);
      await load();
    } catch (e: any) {
      setErr(e?.message || "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const box: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16, marginBottom: 14 };
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 10, color: T.muted, textTransform: "uppercase", letterSpacing: ".05em", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 12, color: T.text, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" };
  const btn = (bg: string): React.CSSProperties => ({ padding: "5px 10px", fontSize: 11, fontWeight: 700, borderRadius: 5, border: "none", cursor: busy ? "wait" : "pointer", background: bg, color: "#fff" });

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {([["pending", "🕒 Pending approvals"], ["devices", "🖥 Registered devices"], ["attempts", "🔑 Login attempts"], ["audit", "📜 Audit log"], ["settings", "⚙ Settings"]] as const).map(([id, lbl]) => (
          <button key={id} onClick={() => setTab(id as any)} style={{ padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer", background: tab === id ? T.amber : T.card, color: tab === id ? "#000" : T.muted, border: `1px solid ${tab === id ? T.amber : T.border}` }}>{lbl}</button>
        ))}
        <button onClick={() => void load()} style={{ marginLeft: "auto", padding: "6px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: T.card, color: T.muted, border: `1px solid ${T.border}` }}>↻ Refresh</button>
      </div>

      {msg && <div style={{ ...box, borderColor: "#16A34A", color: "#4ADE80", fontSize: 12 }}>{msg}</div>}
      {err && <div style={{ ...box, borderColor: "#DC2626", color: "#F87171", fontSize: 12 }}>⚠ {err}</div>}
      {!data && !err && <div style={{ color: T.muted, fontSize: 12 }}>Loading…</div>}

      {data && tab === "pending" && (
        <div style={box}>
          {data.pending.length === 0 ? <div style={{ color: T.muted, fontSize: 12 }}>No pending device approval requests.</div> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>{["User", "Device ID", "Type", "OS", "Browser", "IP", "Requested", "Expires", ""].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {data.pending.map((r: any) => (
                    <tr key={r.request_id}>
                      <td style={td}>{r.email}</td>
                      <td style={{ ...td, fontFamily: "monospace", fontSize: 10 }}>{r.device_id}</td>
                      <td style={td}>{r.device_type}</td>
                      <td style={td}>{r.operating_system}</td>
                      <td style={td}>{r.browser} {r.browser_version}</td>
                      <td style={td}>{r.ip_address}</td>
                      <td style={td}>{new Date(r.created_at).toLocaleString()}</td>
                      <td style={td}>{new Date(r.expires_at).toLocaleString()}</td>
                      <td style={{ ...td, display: "flex", gap: 6 }}>
                        <button disabled={busy} style={btn("#16A34A")} onClick={() => act(() => decideDeviceRequest({ data: { requestId: r.request_id, action: "APPROVE" } }), "Device approved.")}>Approve</button>
                        <button disabled={busy} style={btn("#DC2626")} onClick={() => {
                          const reason = window.prompt("Reason for rejection (optional)") || "";
                          void act(() => decideDeviceRequest({ data: { requestId: r.request_id, action: "REJECT", reason } }), "Device rejected.");
                        }}>Reject</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {data && tab === "devices" && (
        <div style={box}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Device", "Type", "OS", "Browser", "Status", "Last IP", "Last seen", ""].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {data.devices.map((d: any) => (
                  <tr key={d.id}>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 10 }}>{d.device_id}</td>
                    <td style={td}>{d.device_type}</td>
                    <td style={td}>{d.operating_system}</td>
                    <td style={td}>{d.browser}</td>
                    <td style={{ ...td, color: d.status === "APPROVED" ? "#4ADE80" : d.status === "PENDING" ? "#FFD27A" : "#F87171", fontWeight: 700 }}>{d.status}</td>
                    <td style={td}>{d.last_ip}</td>
                    <td style={td}>{new Date(d.last_seen_at).toLocaleString()}</td>
                    <td style={{ ...td, display: "flex", gap: 6 }}>
                      {d.status !== "REVOKED" && d.status !== "REJECTED" && (
                        <button disabled={busy} style={btn("#DC2626")} onClick={() => {
                          if (!window.confirm("Revoke this device? The user will be blocked until a new approval.")) return;
                          void act(() => revokeDevice({ data: { userId: d.user_id, deviceId: d.device_id } }), "Device revoked.");
                        }}>Revoke</button>
                      )}
                      {(d.status === "REVOKED" || d.status === "REJECTED") && (
                        <button disabled={busy} style={btn("#16A34A")} onClick={() => {
                          if (!window.confirm("Re-approve this device? The user will be able to sign in from it again.")) return;
                          void act(() => reapproveDevice({ data: { userId: d.user_id, deviceId: d.device_id } }), "Device re-approved.");
                        }}>Re-approve</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && tab === "attempts" && (
        <div style={box}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Time", "Email", "Result", "Device status", "IP", "Device", "Browser"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {data.attempts.map((a: any) => (
                  <tr key={a.id}>
                    <td style={td}>{new Date(a.created_at).toLocaleString()}</td>
                    <td style={td}>{a.email}</td>
                    <td style={{ ...td, color: a.authentication_result === "SUCCESS" ? "#4ADE80" : "#F87171", fontWeight: 700 }}>{a.authentication_result}</td>
                    <td style={td}>{a.device_status}</td>
                    <td style={td}>{a.ip_address}</td>
                    <td style={td}>{a.device_type} / {a.operating_system}</td>
                    <td style={td}>{a.browser}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && tab === "audit" && (
        <div style={box}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Time", "Event", "Result", "IP", "Device", "Description"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {data.audit.map((a: any) => (
                  <tr key={a.id}>
                    <td style={td}>{new Date(a.created_at).toLocaleString()}</td>
                    <td style={td}>{a.event_type}</td>
                    <td style={td}>{a.result}</td>
                    <td style={td}>{a.ip_address}</td>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 10 }}>{a.device_id}</td>
                    <td style={{ ...td, whiteSpace: "normal" }}>{a.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && tab === "settings" && <SettingsForm T={T} data={data} busy={busy} act={act} />}
    </div>
  );
}

function SettingsForm({ T, data, busy, act }: { T: T; data: Overview; busy: boolean; act: (fn: () => Promise<any>, ok: string) => Promise<void> }) {
  const [maxDevices, setMaxDevices] = useState(String(data.deviceSettings.maxDevices));
  const [expiry, setExpiry] = useState(String(data.deviceSettings.approvalExpiryMinutes));
  const [ipMode, setIpMode] = useState(data.ipSettings.mode);
  const [allowlist, setAllowlist] = useState(data.ipSettings.allowlist.join("\n"));

  const input: React.CSSProperties = { width: "100%", padding: "8px 10px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: "inherit" };
  const lbl: React.CSSProperties = { fontSize: 10, color: T.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", display: "block", marginBottom: 6 };

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16, display: "grid", gap: 14, maxWidth: 520 }}>
      <div><label style={lbl}>Max approved devices per user</label><input style={input} value={maxDevices} onChange={e => setMaxDevices(e.target.value)} /></div>
      <div><label style={lbl}>Approval request expiry (minutes)</label><input style={input} value={expiry} onChange={e => setExpiry(e.target.value)} /></div>
      <div>
        <label style={lbl}>IP policy</label>
        <select style={input} value={ipMode} onChange={e => setIpMode(e.target.value as any)}>
          <option value="OFF">Off</option>
          <option value="MONITOR">Monitor only</option>
          <option value="ALLOWLIST">Allowlist enforced</option>
          <option value="STRICT">Strict (review unknown networks)</option>
        </select>
      </div>
      <div><label style={lbl}>CIDR allowlist (one per line)</label><textarea style={{ ...input, minHeight: 90 }} value={allowlist} onChange={e => setAllowlist(e.target.value)} /></div>
      <button
        disabled={busy}
        style={{ padding: "10px 0", fontSize: 13, fontWeight: 700, borderRadius: 6, border: "none", background: T.amber, color: "#000", cursor: busy ? "wait" : "pointer" }}
        onClick={() => void act(() => updateSecuritySettings({
          data: {
            maxDevices: Number(maxDevices),
            approvalExpiryMinutes: Number(expiry),
            ipMode,
            allowlist: allowlist.split("\n").map(s => s.trim()).filter(Boolean),
          },
        }), "Security settings saved.")}
      >SAVE SETTINGS</button>
    </div>
  );
}
