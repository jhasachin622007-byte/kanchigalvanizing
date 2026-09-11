export type GateInfo = {
  status: string;
  message: string;
  deviceId?: string | null;
  requestId?: string | null;
  device?: { device_type: string; operating_system: string; browser: string } | null;
};

const TITLES: Record<string, string> = {
  NEW_DEVICE: "Device Registration Required",
  DEVICE_NOT_APPROVED: "Waiting for Administrator Approval",
  DEVICE_REJECTED: "Device Not Approved",
  DEVICE_REVOKED: "Device Access Revoked",
  EXPIRED: "Approval Request Expired",
  IP_BLOCKED: "Network Not Permitted",
  SECURITY_REVIEW: "Security Review Required",
  RATE_LIMITED: "Too Many Attempts",
};

const ICONS: Record<string, string> = {
  NEW_DEVICE: "🖥",
  DEVICE_NOT_APPROVED: "⏳",
  DEVICE_REJECTED: "⛔",
  DEVICE_REVOKED: "🚫",
  EXPIRED: "⌛",
  IP_BLOCKED: "🌐",
  SECURITY_REVIEW: "🔍",
  RATE_LIMITED: "🐢",
};

export default function DeviceGateScreen({ info, onBack }: { info: GateInfo; onBack: () => void }) {
  const title = TITLES[info.status] || "Access Blocked";
  const icon = ICONS[info.status] || "🔒";
  const row = (k: string, v?: string | null) =>
    v ? (
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid #33434F" }}>
        <span style={{ color: "#8DA0AD", fontSize: 11, letterSpacing: ".05em", textTransform: "uppercase" }}>{k}</span>
        <span style={{ color: "#C9D6DF", fontSize: 12, fontWeight: 600 }}>{v}</span>
      </div>
    ) : null;

  return (
    <div style={{ minHeight: "100vh", background: "#0F1720", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Figtree,system-ui,sans-serif", padding: 16 }}>
      <div style={{ width: 460, maxWidth: "100%", background: "#1E2A36", border: "1px solid #33434F", borderRadius: 12, padding: 28 }}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <div style={{ fontSize: 40 }}>{icon}</div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#C9D6DF", marginTop: 8 }}>{title}</div>
          <div style={{ fontSize: 13, color: "#8FA6C4", marginTop: 10, lineHeight: 1.6 }}>{info.message}</div>
        </div>

        {info.device && (
          <div style={{ background: "#0B1422", border: "1px solid #33434F", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
            {row("Device type", info.device.device_type)}
            {row("Operating system", info.device.operating_system)}
            {row("Browser", info.device.browser)}
          </div>
        )}

        {info.status === "NEW_DEVICE" || info.status === "DEVICE_NOT_APPROVED" ? (
          <div style={{ fontSize: 12, color: "#FFD27A", background: "#2A1A08", border: "1px solid #3D7EA6", borderRadius: 8, padding: "10px 14px", marginBottom: 14, lineHeight: 1.5 }}>
            An approval request has been sent to the administrator. Once approved, sign in again from this device.
          </div>
        ) : null}

        <button
          onClick={onBack}
          style={{ width: "100%", padding: "11px 0", fontSize: 13, fontWeight: 700, borderRadius: 6, cursor: "pointer", background: "linear-gradient(135deg,#3D7EA6,#2E6285)", color: "#0F1720", border: "none", fontFamily: "inherit" }}
        >
          BACK TO SIGN IN
        </button>
      </div>
    </div>
  );
}
