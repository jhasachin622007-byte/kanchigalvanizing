import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Server-time offset.
 *
 * Dipping timers must keep ticking against the real wall-clock even if the
 * device is asleep, in a phone call, or has a wrong system clock. We compute
 * `offsetMs = serverNow - Date.now()` and use `Date.now() + offsetMs` for
 * every elapsed-time calculation. Re-syncs on resume / network online.
 *
 * The "server now" is read from the Supabase REST `Date` response header —
 * it requires no RPC/function and is accurate to ~1s, which is plenty for
 * a process measured in minutes.
 */

let cachedOffset = 0;
let lastSyncAt = 0;
let inFlight: Promise<void> | null = null;

const SUPABASE_URL =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_SUPABASE_URL) ||
  "";

async function fetchServerOffset(): Promise<void> {
  if (!SUPABASE_URL) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const t0 = Date.now();
      const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        method: "HEAD",
        cache: "no-store",
      });
      const t1 = Date.now();
      const dateHeader = res.headers.get("date");
      if (!dateHeader) return;
      const serverMs = new Date(dateHeader).getTime();
      if (!Number.isFinite(serverMs)) return;
      // Compensate for one-way latency (~rtt/2).
      const rttHalf = Math.round((t1 - t0) / 2);
      cachedOffset = serverMs + rttHalf - t1;
      lastSyncAt = t1;
    } catch {
      // Network down — keep last known offset; we'll retry on `online`.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Real server-time ISO, regardless of device clock. */
export function serverNowISO(): string {
  return new Date(Date.now() + cachedOffset).toISOString();
}

export function serverNowMs(): number {
  return Date.now() + cachedOffset;
}

export function getServerOffsetMs(): number {
  return cachedOffset;
}

/**
 * Hook: resynchronizes server-time offset on mount, on resume/visibility,
 * and on `online`. Returns a `tick` value that changes every second while
 * the tab is visible so components re-render their live timers.
 */
export function useServerClock(intervalMs = 1000) {
  const [tick, setTick] = useState(() => serverNowISO());
  const mounted = useRef(true);

  const resync = useCallback(async () => {
    await fetchServerOffset();
    if (mounted.current) setTick(serverNowISO());
  }, []);

  useEffect(() => {
    mounted.current = true;
    void resync();
    const id = window.setInterval(() => {
      // Skip ticking when the tab is hidden — the next visibilitychange
      // event will repaint with the correct elapsed time.
      if (document.visibilityState === "hidden") return;
      setTick(serverNowISO());
    }, intervalMs);

    const onResume = () => void resync();
    const onVisible = () => {
      if (document.visibilityState === "visible") void resync();
    };

    window.addEventListener("hdp:resume", onResume);
    window.addEventListener("online", onResume);
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onVisible);

    // Re-sync the offset every 5 minutes to combat slow clock drift.
    const refreshOffset = window.setInterval(() => {
      if (Date.now() - lastSyncAt > 5 * 60_000) void fetchServerOffset();
    }, 60_000);

    return () => {
      mounted.current = false;
      window.clearInterval(id);
      window.clearInterval(refreshOffset);
      window.removeEventListener("hdp:resume", onResume);
      window.removeEventListener("online", onResume);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, resync]);

  return { tick, resync, serverNowISO, serverNowMs };
}
