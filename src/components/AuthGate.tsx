import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { signInWithIdentifier, sendPasswordResetForIdentifier } from "@/lib/auth-lookup.functions";
import { getDeviceId, setDeviceId } from "@/lib/device-id";
import DeviceGateScreen, { type GateInfo } from "@/features/security/DeviceGateScreens";
import { checkMyDevice } from "@/lib/security-admin.functions";
import {
  claimActiveSession,
  clearLocalSessionId,
  getLocalSessionId,
  verifyActiveSession,
  watchActiveSession,
} from "@/lib/single-session";


export default function AuthGate({ children }: { children: (ctx: { sessionId: string }) => React.ReactNode }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [evictedMsg, setEvictedMsg] = useState<string | null>(null);
  const watcherCleanup = useRef<(() => void) | null>(null);
  const watchingFor = useRef<string | null>(null);
  // Monotonic counter — only the latest auth event is allowed to mutate state.
  const authSeq = useRef(0);

  const stopWatch = () => {
    if (watcherCleanup.current) {
      watcherCleanup.current();
      watcherCleanup.current = null;
    }
    watchingFor.current = null;
  };

  const startWatch = (uid: string) => {
    stopWatch();
    watchingFor.current = uid;
    watcherCleanup.current = watchActiveSession(uid, () => {
      void forceLogout("Your account was logged in from another device.");
    });
  };

  const forceLogout = async (msg: string) => {
    stopWatch();
    clearLocalSessionId();
    setEvictedMsg(msg);
    setSessionId(null);
    try {
      await supabase.auth.signOut();
    } catch {}
  };

  useEffect(() => {
    // A device approved at sign-in can be revoked later by an admin; every
    // restore/refresh re-validates it server-side before granting the app.
    const deviceStillApproved = async () => {
      try {
        const r: any = await checkMyDevice({ data: { deviceId: getDeviceId() } });
        return !!r?.approved;
      } catch {
        return true; // network hiccup must not lock out a valid operator
      }
    };

    const handle = async (uid: string | null, event: string) => {
      const mySeq = ++authSeq.current;

      if (!uid) {
        stopWatch();
        setSessionId(null);
        return;
      }

      // Fresh sign-in: this device takes over unconditionally.
      // Clear any stale eviction banner so the UI reflects the new active state.
      if (event !== "SIGNED_IN" && !(await deviceStillApproved())) {
        await forceLogout("This device's access has been revoked. Contact your administrator.");
        return;
      }

      if (event === "SIGNED_IN") {
        await claimActiveSession(uid);
        if (mySeq !== authSeq.current) return; // superseded
        setEvictedMsg(null);
        setSessionId(uid);
        startWatch(uid);
        return;
      }

      // Page reload / token refresh / initial session restore.
      // If localStorage lost our app-level session id (mobile OS purge,
      // preview reload, browser restore), reclaim this browser instead of
      // forcing a logout. The active_sessions row still enforces one active
      // browser: the latest valid browser claim wins and older watchers exit.
      const localSid = getLocalSessionId();
      if (!localSid) {
        await claimActiveSession(uid);
        if (mySeq !== authSeq.current) return;
        setEvictedMsg(null);
        setSessionId(uid);
        startWatch(uid);
        return;
      }

      const ok = await verifyActiveSession(uid, localSid);
      if (mySeq !== authSeq.current) return;
      if (!ok) {
        await claimActiveSession(uid);
        if (mySeq !== authSeq.current) return;
        setEvictedMsg(null);
        setSessionId(uid);
        startWatch(uid);
        return;
      }

      setSessionId(uid);
      if (watchingFor.current !== uid) startWatch(uid);
    };

    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      const uid = sess?.user?.id ?? null;
      void handle(uid, event);
    });
    // Safety net: never let the "Loading…" splash hang forever if
    // getSession() stalls on a flaky network.
    const failOpen = setTimeout(() => setChecked(true), 4000);
    supabase.auth.getSession()
      .then(({ data }) => {
        const uid = data.session?.user?.id ?? null;
        // Treat the initial probe as a restore, not a fresh sign-in.
        void handle(uid, "INITIAL_SESSION");
      })
      .catch((err) => {
        console.error("[auth] getSession failed", err);
      })
      .finally(() => {
        clearTimeout(failOpen);
        setChecked(true);
      });
    return () => {
      sub.subscription.unsubscribe();
      stopWatch();
    };
  }, []);

  if (!checked) {
    return (
      <div style={{ minHeight: "100vh", background: "#04080F", color: "#5A7599", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui" }}>
        Loading…
      </div>
    );
  }
  if (!sessionId) return <LoginScreen evictedMsg={evictedMsg} clearEvicted={() => setEvictedMsg(null)} />;
  return <>{children({ sessionId })}</>;
}

function LoginScreen({ evictedMsg, clearEvicted }: { evictedMsg: string | null; clearEvicted: () => void }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<GateInfo | null>(null);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setInfo("");
    clearEvicted();
    setBusy(true);
    try {
      const id = identifier.trim();
      if (mode === "login") {
        // Make sure no stale Supabase session lingers — guarantees the next
        // onAuthStateChange fires "SIGNED_IN" (not just TOKEN_REFRESHED).
        try { await supabase.auth.signOut(); } catch {}
        clearEvicted();
        const res: any = await signInWithIdentifier({
          data: { identifier: id, password, deviceId: getDeviceId() },
        });
        // The server always hands back the device handle it used/created so
        // this browser keeps a stable identity across sign-in attempts.
        if (res?.deviceId) setDeviceId(res.deviceId);
        if (!res.ok) {
          if (res.status && res.status !== "INVALID_CREDENTIALS" && res.status !== "RATE_LIMITED") {
            setGate({
              status: res.status,
              message: res.error || "Access blocked.",
              deviceId: res.deviceId ?? null,
              requestId: res.requestId ?? null,
              device: res.device ?? null,
            });
            return;
          }
          throw new Error(res.error || "Invalid credentials");
        }
        const { error } = await supabase.auth.setSession({
          access_token: res.access_token,
          refresh_token: res.refresh_token,
        });
        if (error) throw error;
      } else {
        await sendPasswordResetForIdentifier({
          data: {
            identifier: id,
            redirectTo:
              typeof window !== "undefined" ? window.location.origin + "/reset-password" : undefined,
          },
        });
        setInfo("✓ If an account exists, a password reset link has been sent.");
      }
    } catch (e: any) {
      setErr(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "10px 14px", background: "#0F1720", border: "1px solid rgba(61,126,166,.3)",
    borderRadius: 2, color: "#C9D6DF", fontSize: 13, outline: "none", fontFamily: "inherit",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: "rgba(201,214,223,.7)", fontWeight: 600, letterSpacing: ".08em",
    textTransform: "uppercase", display: "block", marginBottom: 6,
  };

  if (gate) return <DeviceGateScreen info={gate} onBack={() => { setGate(null); setPassword(""); }} />;

  return (
    <div style={{ minHeight: "100vh", background: "#0F1720", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Figtree, system-ui, sans-serif", padding: 24 }}>
      <div style={{ width: 420, maxWidth: "100%", background: "#1E2A36", borderLeft: "4px solid #3D7EA6", boxShadow: "0 25px 50px -12px rgba(0,0,0,.6)", position: "relative", overflow: "hidden" }}>
        <div style={{ padding: 32 }}>
          <header style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ fontSize: 10, letterSpacing: ".18em", color: "#3D7EA6", fontWeight: 700, textTransform: "uppercase" }}>Terminal v3.0</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: "#3D7EA6", animation: "pulse 2s ease-in-out infinite" }} />
                <span style={{ fontSize: 10, color: "rgba(201,214,223,.6)", textTransform: "uppercase", letterSpacing: ".02em" }}>System ready</span>
              </span>
            </div>
            <h1 style={{ fontFamily: "Outfit, system-ui, sans-serif", fontSize: 30, lineHeight: 1.15, fontWeight: 700, color: "#C9D6DF", margin: 0 }}>
              Galvanizing<br />Production Access
            </h1>
          </header>

          {evictedMsg && (
            <div style={{ marginBottom: 16, padding: "12px 14px", background: "#0F1720", borderLeft: "3px solid #3D7EA6", color: "#C9D6DF", fontSize: 12, lineHeight: 1.5 }}>
              ⚠ {evictedMsg}
            </div>
          )}

          <form onSubmit={go} style={{ display: "grid", gap: 20 }}>
            <div>
              <label htmlFor="auth-identifier" style={labelStyle}>Operator ID / Email</label>
              <input id="auth-identifier" name="identifier" type="text" required placeholder="Enter credentials…" value={identifier} onChange={(e) => { setIdentifier(e.target.value); setErr(""); }} style={inputStyle} autoComplete="username" />
            </div>

            {mode !== "forgot" && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label htmlFor="auth-password" style={labelStyle}>Secure Password</label>
                  <button type="button" onClick={() => { setMode("forgot"); setErr(""); setInfo(""); }} style={{ background: "none", border: "none", color: "#3D7EA6", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".02em", cursor: "pointer", fontFamily: "inherit", padding: 0, marginBottom: 6 }}>
                    Forgot access?
                  </button>
                </div>
                <input id="auth-password" name="password" type="password" required minLength={6} placeholder="••••••••" value={password} onChange={(e) => { setPassword(e.target.value); setErr(""); }} style={inputStyle} autoComplete="current-password" />
              </div>
            )}

            {mode === "forgot" && (
              <button type="button" onClick={() => { setMode("login"); setErr(""); setInfo(""); }} style={{ background: "none", border: "none", color: "#3D7EA6", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".02em", cursor: "pointer", fontFamily: "inherit", padding: 0, textAlign: "left" }}>
                ← Back to sign in
              </button>
            )}

            {err && <div style={{ color: "#F87171", fontSize: 12, padding: "8px 12px", background: "#0F1720", borderLeft: "3px solid #F87171" }}>⚠ {err}</div>}
            {info && <div style={{ color: "#7FD1A8", fontSize: 12, padding: "8px 12px", background: "#0F1720", borderLeft: "3px solid #7FD1A8" }}>{info}</div>}

            <button type="submit" disabled={busy} style={{ width: "100%", padding: "13px 0", fontSize: 13, fontWeight: 700, letterSpacing: ".16em", textTransform: "uppercase", background: "#3D7EA6", color: "#0F1720", border: "none", borderRadius: 0, cursor: busy ? "wait" : "pointer", fontFamily: "Outfit, system-ui, sans-serif" }}>
              {busy ? "…" : mode === "login" ? "Authenticate →" : "Send reset link →"}
            </button>
          </form>

          <div style={{ marginTop: 28, paddingTop: 22, borderTop: "1px solid rgba(201,214,223,.1)", display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ background: "rgba(61,126,166,.1)", color: "#3D7EA6", padding: 6, fontSize: 12, lineHeight: 1 }}>🔒</div>
            <p style={{ fontSize: 11, lineHeight: 1.6, color: "rgba(201,214,223,.5)", margin: 0 }}>
              <strong style={{ color: "rgba(201,214,223,.8)", display: "block", marginBottom: 2 }}>Device security protocol:</strong>
              Unrecognised devices need administrator approval before production access is granted.
            </p>
          </div>
        </div>

        <div style={{ height: 4, width: "100%", background: "rgba(61,126,166,.2)" }}>
          <div style={{ height: "100%", width: "33%", background: "#3D7EA6" }} />
        </div>
      </div>
    </div>
  );
}

