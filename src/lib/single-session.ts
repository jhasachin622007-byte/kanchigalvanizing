import { supabase } from "@/integrations/supabase/client";

const LS_KEY = "hdp.session_id";

function makeSessionId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

function deviceInfo() {
  if (typeof navigator === "undefined") return "unknown";
  return (navigator.userAgent || "unknown").slice(0, 200);
}

export function getLocalSessionId(): string | null {
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

export function setLocalSessionId(sid: string) {
  try {
    localStorage.setItem(LS_KEY, sid);
  } catch {}
}

export function clearLocalSessionId() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {}
}

/**
 * Claim this device as the single active session for the user.
 * Latest claim always wins — previous devices will detect the change
 * via realtime / focus-poll and sign themselves out.
 */
export async function claimActiveSession(userId: string): Promise<string> {
  const sid = makeSessionId();
  // Write local FIRST so any concurrent watcher check sees the new id.
  setLocalSessionId(sid);

  // The row is protected by `auth.uid() = user_id`. Right after sign-in the
  // client may not have propagated the new access token yet, which makes the
  // write fail with an RLS violation. Wait for the session to be confirmed and
  // always claim for the JWT subject, not the id the caller guessed.
  const confirmUid = async (): Promise<string | null> => {
    try {
      const { data } = await supabase.auth.getSession();
      return data.session?.user?.id ?? null;
    } catch {
      return null;
    }
  };

  let uid = await confirmUid();
  for (let i = 0; !uid && i < 3; i++) {
    await new Promise((r) => setTimeout(r, 300));
    uid = await confirmUid();
  }
  if (!uid) {
    console.warn("[single-session] no confirmed session; skipping claim");
    return sid;
  }
  if (uid !== userId) {
    console.warn("[single-session] claiming for confirmed session user instead of caller id");
  }

  const row = {
    user_id: uid,
    session_id: sid,
    device_info: deviceInfo(),
    updated_at: new Date().toISOString(),
  };

  const attempt = async () => {
    const { error } = await supabase
      .from("active_sessions")
      .upsert(row, { onConflict: "user_id" });
    if (!error) return null;
    // Some older installs may not have a unique constraint on user_id, which
    // makes upsert fail. Fall back to update-then-insert.
    const { user_id: _uid, ...nextRow } = row;
    const { data: updated, error: updateError } = await supabase
      .from("active_sessions")
      .update(nextRow)
      .eq("user_id", uid!)
      .select("user_id")
      .limit(1);
    if (!updateError && updated?.length) return null;
    const { error: insertError } = await supabase.from("active_sessions").insert(row);
    return insertError ?? error;
  };

  let err = await attempt();
  if (err) {
    // One retry after a short delay: covers the token still settling.
    await new Promise((r) => setTimeout(r, 600));
    err = await attempt();
  }
  if (err) console.error("[single-session] claim failed", err);
  return sid;
}


/**
 * Verify our local session id is still the active one in the DB.
 * Returns true if we are active, false if evicted (or no row exists).
 */
export async function verifyActiveSession(
  userId: string,
  localSid: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("active_sessions")
    .select("session_id, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // On transient error, don't evict — fail open.
    return true;
  }
  // Missing rows are not proof of a second device; avoid false logouts.
  if (!data) return true;
  return data.session_id === localSid;
}

/**
 * Subscribe to changes on the user's active_sessions row. If another device
 * takes over (session_id differs from our LOCAL stored id), invoke onEvicted().
 * Always re-reads localStorage so a fresh claim from this same device is
 * respected even if this watcher was started before the claim completed.
 */
export function watchActiveSession(
  userId: string,
  onEvicted: () => void,
): () => void {
  let evicted = false;
  let stopped = false;

  const isStillActive = (incomingSid: string | undefined | null) => {
    const current = getLocalSessionId();
    if (!current) return false; // we have no claim → not active
    if (!incomingSid) return false;
    return incomingSid === current;
  };

  const trigger = () => {
    if (evicted || stopped) return;
    evicted = true;
    onEvicted();
  };

  const channel = supabase
    .channel(`active_sessions:${userId}:${Date.now()}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "active_sessions",
        filter: `user_id=eq.${userId}`,
      },
      (payload: any) => {
        if (stopped || evicted) return;
        if (payload.eventType === "DELETE") {
          // Row gone — re-check via DB to avoid false positives.
          void (async () => {
            const ok = await verifyActiveSession(userId, getLocalSessionId() || "");
            if (!ok) trigger();
          })();
          return;
        }
        const next = payload.new && (payload.new.session_id as string | undefined);
        if (!next) return;
        if (!isStillActive(next)) {
          void (async () => {
            const ok = await verifyActiveSession(userId, getLocalSessionId() || "");
            if (!ok) trigger();
          })();
        }
      },
    )
    .subscribe();

  // Focus / visibility poll as a fallback in case realtime missed an event.
  // After a long mobile suspend (phone call, screen lock), the access token
  // may be stale. Give autoRefreshToken + resume-lifecycle ~1.5s to refresh
  // before we ask Supabase about session ownership — otherwise verifyActiveSession
  // can race a 401 and we'd evict a perfectly valid logged-in user.
  const checkNow = async () => {
    if (stopped || evicted) return;
    const localSid = getLocalSessionId();
    if (!localSid) return; // nothing to verify
    const ok = await verifyActiveSession(userId, localSid);
    if (!ok) trigger();
  };
  const checkAfterResume = () => {
    if (stopped || evicted) return;
    setTimeout(() => { void checkNow(); }, 1500);
  };
  const onVis = () => {
    if (document.visibilityState === "visible") checkAfterResume();
  };
  window.addEventListener("visibilitychange", onVis);
  window.addEventListener("focus", checkAfterResume);

  return () => {
    stopped = true;
    supabase.removeChannel(channel);
    window.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("focus", checkAfterResume);
  };
}
