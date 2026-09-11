import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Mobile resume lifecycle.
 *
 * When the user comes back to the tab after a phone call, screen lock, or
 * app-switch, do three things in order:
 *   1. Refresh the Supabase access token if it is close to expiry. Long
 *      OS-level suspensions can outlast the 1-hour token TTL; if we let the
 *      first request fly with a stale token it 401s before autoRefreshToken
 *      gets a chance.
 *   2. Dispatch `hdp:resume` so any subscriber (sync layer, pending-write
 *      queue) can reconcile.
 *   3. The single-session AuthGate watcher listens for the same events but
 *      uses its own grace window — see AuthGate.tsx.
 */
export function useResumeLifecycle() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let inFlight = false;

    const refreshIfNeeded = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { data } = await supabase.auth.getSession();
        const sess = data.session;
        if (!sess) return;
        const expiresAt = (sess.expires_at ?? 0) * 1000;
        const msLeft = expiresAt - Date.now();
        // Refresh if expired or within 60 seconds of expiry.
        if (msLeft < 60_000) {
          try {
            await supabase.auth.refreshSession();
          } catch (err) {
            // Network down — leave token; queue will retry on `online`.
            console.warn("[resume] refreshSession failed", err);
          }
        }
      } finally {
        inFlight = false;
      }
    };

    const broadcast = () => {
      try {
        window.dispatchEvent(new CustomEvent("hdp:resume"));
      } catch {}
    };

    const onResume = async () => {
      await refreshIfNeeded();
      broadcast();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void onResume();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      // `persisted` means restored from BFCache (common on iOS after
      // returning from a phone call). Always re-check.
      if (e.persisted) void onResume();
    };
    const onOnline = () => void onResume();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onResume);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onResume);
    };
  }, []);
}
