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
    width: "100%", padding: "10px 12px", background: "#0B1422", border: "1px solid #1A2840",
    borderRadius: 6, color: "#DDE8F8", fontSize: 13, outline: "none", fontFamily: "inherit",
  };

  if (gate) return <DeviceGateScreen info={gate} onBack={() => { setGate(null); setPassword(""); }} />;

  return (

    <div style={{ minHeight: "100vh", background: "#04080F", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui,sans-serif", padding: 16 }}>
      <div style={{ width: 420, maxWidth: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: "linear-gradient(135deg,#E8A020,#B57A0F)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px", fontSize: 30, boxShadow: "0 0 32px rgba(232,160,32,.5)" }}>⚙</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#DDE8F8", letterSpacing: ".1em" }}>HDP GALVANIZING</div>
          <div style={{ fontSize: 10, color: "#2E4A6E", marginTop: 4, letterSpacing: ".15em" }}>PRODUCTION AUTOMATION SYSTEM v3.0</div>
        </div>

        {evictedMsg && (
          <div style={{ marginBottom: 14, padding: "12px 14px", background: "#2A1A08", border: "1px solid #E8A020", borderRadius: 8, color: "#FFD27A", fontSize: 13, lineHeight: 1.5 }}>
            ⚠ {evictedMsg}
          </div>
        )}

        <form onSubmit={go} style={{ background: "#0E1623", border: "1px solid #1A2840", borderRadius: 12, padding: "28px 28px 22px" }}>
          <div style={{ display:"flex", gap:6, marginBottom:14 }}>
            {(["login","forgot"] as const).map(m => (
              <button key={m} type="button" onClick={()=>{setMode(m);setErr("");setInfo("");}} style={{ flex:1, padding:"6px 0", fontSize:11, fontWeight:700, borderRadius:6, cursor:"pointer", background: mode===m?"#1A2840":"transparent", color: mode===m?"#E8A020":"#5A7599", border:"1px solid #1A2840", fontFamily:"inherit" }}>
                {m==="login"?"Sign in":"Forgot password"}
              </button>
            ))}
          </div>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="auth-identifier" style={{ fontSize: 10, color: "#5A7599", fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Email or Username</label>
            <input id="auth-identifier" name="identifier" type="text" required value={identifier} onChange={(e) => { setIdentifier(e.target.value); setErr(""); }} style={inputStyle} autoComplete="username" />
          </div>
          {mode!=="forgot" && (
            <div style={{ marginBottom: 6 }}>
              <label htmlFor="auth-password" style={{ fontSize: 10, color: "#5A7599", fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Password</label>
              <input id="auth-password" name="password" type="password" required minLength={6} value={password} onChange={(e) => { setPassword(e.target.value); setErr(""); }} style={inputStyle} autoComplete={mode === "login" ? "current-password" : "new-password"} />
            </div>
          )}
          {err && <div style={{ color: "#F87171", fontSize: 12, marginTop: 10, padding: "8px 12px", background: "#220808", borderRadius: 6 }}>⚠ {err}</div>}
          {info && <div style={{ color: "#4ADE80", fontSize: 12, marginTop: 10, padding: "8px 12px", background: "#0A2218", borderRadius: 6 }}>{info}</div>}
          <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 14, padding: "11px 0", fontSize: 14, letterSpacing: ".04em", background: "linear-gradient(135deg,#E8A020,#B57A0F)", color: "#04080F", border: "none", borderRadius: 6, fontWeight: 700, cursor: busy ? "wait" : "pointer", fontFamily: "inherit" }}>
            {busy ? "…" : mode==="login" ? "SIGN IN →" : "SEND RESET LINK →"}
          </button>
        </form>
      </div>
    </div>
  );
}
