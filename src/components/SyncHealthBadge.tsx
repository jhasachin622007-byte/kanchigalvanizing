import { useEffect, useState } from "react";
import { Wifi, WifiOff, Loader2 } from "lucide-react";
import { pendingCount } from "@/lib/pending-queue";

type Status = "connected" | "reconnecting" | "pending" | "error";

const RECENT_ERROR_MS = 15_000;

export function SyncHealthBadge({ T }: { T: any }) {
  const [status, setStatus] = useState<Status>("connected");
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    let lastErrorAt = 0;

    const recompute = () => {
      const queued = pendingCount();
      if (queued > 0) {
        setStatus("pending");
        return;
      }
      if (Date.now() - lastErrorAt < RECENT_ERROR_MS) {
        setStatus("reconnecting");
        return;
      }
      setStatus("connected");
    };

    const onStatus = (e: any) => {
      const d = e?.detail || {};
      if (d.status === "drained" || d.status === "ok" || d.status === "connected") {
        lastErrorAt = 0;
        setLastError(null);
        setLastUpdate(new Date());
      } else if (d.status === "reconnecting") {
        // soft signal — let recompute decide
      }
      recompute();
    };
    const onError = (e: any) => {
      lastErrorAt = Date.now();
      setLastError(e?.detail?.message || "Sync error");
      recompute();
    };

    window.addEventListener("hdp:sync-status", onStatus as any);
    window.addEventListener("hdp:sync-error", onError as any);
    const poll = setInterval(recompute, 5_000);
    recompute();
    return () => {
      window.removeEventListener("hdp:sync-status", onStatus as any);
      window.removeEventListener("hdp:sync-error", onError as any);
      clearInterval(poll);
    };
  }, []);

  const cfg = {
    connected:    { color: "#10B981", bg: "#10B98118", border: "#10B98140", label: "LIVE",         Icon: Wifi },
    reconnecting: { color: "#F59E0B", bg: "#F59E0B18", border: "#F59E0B40", label: "RECONNECTING", Icon: Loader2 },
    pending:      { color: "#F59E0B", bg: "#F59E0B18", border: "#F59E0B40", label: "SYNCING",      Icon: Loader2 },
    error:        { color: "#EF4444", bg: "#EF444418", border: "#EF444440", label: "OFFLINE",      Icon: WifiOff },
  }[status];

  const title = status === "connected"
    ? `Live sync · last update ${lastUpdate.toLocaleTimeString("en-IN", { hour12: false })}`
    : lastError || "Reconnecting to the live data channel…";

  const Icon = cfg.Icon;
  return (
    <div title={title} style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 10px", borderRadius: 6,
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      color: cfg.color, fontSize: 10, fontWeight: 800, letterSpacing: ".08em",
      fontFamily: "inherit",
    }}>
      <Icon size={12} style={status === "reconnecting" ? { animation: "spin 1s linear infinite" } : undefined} />
      <span>{cfg.label}</span>
      <style>{`@keyframes spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }`}</style>
    </div>
  );
}
