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
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid #1A2840" }}>
        <span style={{ color: "#5A7599", fontSize: 11, letterSpacing: ".05em", textTransform: "uppercase" }}>{k}</span>
        <span style={{ color: "#DDE8F8", fontSize: 12, fontWeight: 600 }}>{v}</span>
      </div>
    ) : null;

  return (
    <div style={{ minHeight: "100vh", background: "#04080F", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui,sans-serif", padding: 16 }}>
      <div style={{ width: 460, maxWidth: "100%", background: "#0E1623", border: "1px solid #1A2840", borderRadius: 12, padding: 28 }}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <div style={{ fontSize: 40 }}>{icon}</div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#DDE8F8", marginTop: 8 }}>{title}</div>
          <div style={{ fontSize: 13, color: "#8FA6C4", marginTop: 10, lineHeight: 1.6 }}>{info.message}</div>
        </div>

        {info.device && (
          <div style={{ background: "#0B1422", border: "1px solid #1A2840", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
            {row("Device type", info.device.device_type)}
            {row("Operating system", info.device.operating_system)}
            {row("Browser", info.device.browser)}
          </div>
        )}

        {info.status === "NEW_DEVICE" || info.status === "DEVICE_NOT_APPROVED" ? (
          <div style={{ fontSize: 12, color: "#FFD27A", background: "#2A1A08", border: "1px solid #E8A020", borderRadius: 8, padding: "10px 14px", marginBottom: 14, lineHeight: 1.5 }}>
            An approval request has been sent to the administrator. Once approved, sign in again from this device.
          </div>
        ) : null}

        <button
          onClick={onBack}
          style={{ width: "100%", padding: "11px 0", fontSize: 13, fontWeight: 700, borderRadius: 6, cursor: "pointer", background: "linear-gradient(135deg,#E8A020,#B57A0F)", color: "#04080F", border: "none", fontFamily: "inherit" }}
        >
          BACK TO SIGN IN
        </button>
      </div>
    </div>
  );
}
