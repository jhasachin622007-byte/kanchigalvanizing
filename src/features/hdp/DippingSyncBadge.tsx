import { useEffect, useState } from "react";
import { pendingCountForTable } from "@/lib/pending-queue";

/**
 * Compact pill that tells the operator whether the active dipping session is
 * being mirrored to the server in real time.
 *
 * States:
 *  - LIVE SYNCED   — beams writes succeeding, no queued items
 *  - BACKGROUND    — tab hidden / inactive but server is anchoring the timer
 *  - RECONNECTING  — a recent beams write failed (transient)
 *  - OFFLINE       — QUEUED beams writes waiting to drain
 *
 * Note: we deliberately do NOT key off `navigator.onLine`. On mobile that flag
 * lies (captive portal, weak cell, Wi-Fi up but no internet). Real sync events
 * tell the truth.
 */
type Status = "live" | "background" | "reconnecting" | "offline";

const RECENT_ERROR_MS = 15_000;

export function DippingSyncBadge() {
  const [status, setStatus] = useState<Status>("live");
  const [hidden, setHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    let lastBeamsError = 0;

    const recompute = () => {
      const queued = pendingCountForTable("beams");
      if (queued > 0) return setStatus("offline");
      if (Date.now() - lastBeamsError < RECENT_ERROR_MS) return setStatus("reconnecting");
      setStatus(document.visibilityState === "hidden" ? "background" : "live");
    };

    const onStatus = (e: any) => {
      const d = e?.detail || {};
      const table = String(d.table || "");
      if (table === "pending-queue") {
        if (d.status === "drained") lastBeamsError = 0;
        recompute();
        return;
      }
      if (table !== "beams") return;
      if (d.status === "ok" || d.status === "drained") {
        lastBeamsError = 0;
      }
      recompute();
    };
    const onError = (e: any) => {
      const d = e?.detail || {};
      if (String(d.table || "") !== "beams") return;
      lastBeamsError = Date.now();
      recompute();
    };
    const onVis = () => {
      setHidden(document.visibilityState === "hidden");
      recompute();
    };

    window.addEventListener("hdp:sync-status", onStatus);
    window.addEventListener("hdp:sync-error", onError);
    document.addEventListener("visibilitychange", onVis);
    const poll = setInterval(recompute, 5_000);
    recompute();
    return () => {
      window.removeEventListener("hdp:sync-status", onStatus);
      window.removeEventListener("hdp:sync-error", onError);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(poll);
    };
  }, []);

  const eff: Status = status === "live" && hidden ? "background" : status;

  const palette: Record<Status, { bg: string; bd: string; fg: string; label: string; dot: string }> = {
    live:         { bg: "#072014", bd: "#16A34A", fg: "#4ADE80", label: "LIVE SYNCED",       dot: "#4ADE80" },
    background:   { bg: "#0F1A2A", bd: "#3B82F6", fg: "#60A5FA", label: "RUNNING IN BACKGROUND", dot: "#60A5FA" },
    reconnecting: { bg: "#1A1300", bd: "#D97706", fg: "#FBBF24", label: "RECONNECTING",      dot: "#FBBF24" },
    offline:      { bg: "#1A0808", bd: "#B91C1C", fg: "#F87171", label: "OFFLINE — QUEUED",  dot: "#F87171" },
  };
  const p = palette[eff];

  return (
    <span
      title="Dipping timer is anchored to server time and survives calls, lock-screen, and refresh."
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "4px 9px", borderRadius: 999,
        background: p.bg, border: `1px solid ${p.bd}80`,
        fontSize: 10, fontWeight: 800, color: p.fg, letterSpacing: ".06em",
        fontFamily: "inherit",
      }}
    >
      <span
        style={{
          width: 7, height: 7, borderRadius: "50%", background: p.dot,
          boxShadow: `0 0 8px ${p.dot}`,
          animation: eff === "live" || eff === "background" ? "pulse 1.4s infinite" : undefined,
        }}
      />
      {p.label}
    </span>
  );
}
