import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Reset Password — HDP Galvanizing" },
      { name: "description", content: "Set a new password for your HDP Galvanizing production system account." },
      { property: "og:title", content: "Reset Password — HDP Galvanizing" },
      { property: "og:description", content: "Set a new password for your HDP Galvanizing production system account." },
      { property: "og:url", content: "https://kanchigalvanizing.lovable.app/reset-password" },
      { name: "robots", content: "noindex,nofollow" },
    ],
    links: [
      { rel: "canonical", href: "https://kanchigalvanizing.lovable.app/reset-password" },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  useEffect(() => {
    let cancelled = false;
    // 1) Surface explicit errors from the email link (e.g. expired)
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const search = typeof window !== "undefined" ? window.location.search : "";
    const hp = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const sp = new URLSearchParams(search);
    const errDesc = hp.get("error_description") || sp.get("error_description");
    if (errDesc) {
      setErr(decodeURIComponent(errDesc.replace(/\+/g, " ")));
      return;
    }

    // 2) PKCE flow: `?code=...` must be exchanged for a session
    const code = sp.get("code");
    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (cancelled) return;
        if (error) setErr(error.message);
        else {
          setReady(true);
          window.history.replaceState({}, "", window.location.pathname);
        }
      });
    }

    // 3) Implicit / recovery flow: token lives in hash, auth client parses it
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled && data.session) setReady(true);
    });
    const sub = supabase.auth.onAuthStateChange((event, sess) => {
      if (cancelled) return;
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && sess)) {
        setReady(true);
      }
    });

    // 4) Timeout fallback if nothing resolved
    const t = setTimeout(() => {
      if (!cancelled) setReady((r) => r || (setErr("Reset link is invalid or expired. Request a new one."), false));
    }, 6000);

    return () => {
      cancelled = true;
      sub.data.subscription.unsubscribe();
      clearTimeout(t);
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setInfo("");
    if (password.length < 6) return setErr("Password must be at least 6 characters");
    if (password !== confirm) return setErr("Passwords do not match");
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setInfo("✓ Password updated. Redirecting…");
      setTimeout(() => navigate({ to: "/" }), 1200);
    } catch (e: any) {
      setErr(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "10px 12px", background: "#0B1422", border: "1px solid #33434F",
    borderRadius: 6, color: "#C9D6DF", fontSize: 13, outline: "none", fontFamily: "inherit",
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0F1720", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Figtree,system-ui,sans-serif", padding: 16 }}>
      <div style={{ width: 420, maxWidth: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: "linear-gradient(135deg,#3D7EA6,#2E6285)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px", fontSize: 30, boxShadow: "0 0 32px rgba(61,126,166,.5)" }}>⚙</div>
          <h1 style={{ fontSize: 18, fontWeight: 800, color: "#C9D6DF", letterSpacing: ".1em", margin: 0 }}>RESET PASSWORD</h1>
        </div>
        <form onSubmit={submit} style={{ background: "#1E2A36", border: "1px solid #33434F", borderRadius: 12, padding: "28px" }}>
          {!ready ? (
            <div style={{ color: "#8DA0AD", fontSize: 13, textAlign: "center" }}>Validating reset link…</div>
          ) : (
            <>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 10, color: "#8DA0AD", fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>New password</label>
                <input type="password" required minLength={6} value={password} onChange={(e)=>setPassword(e.target.value)} style={inputStyle} autoComplete="new-password" />
              </div>
              <div style={{ marginBottom: 6 }}>
                <label style={{ fontSize: 10, color: "#8DA0AD", fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", display: "block", marginBottom: 6 }}>Confirm password</label>
                <input type="password" required minLength={6} value={confirm} onChange={(e)=>setConfirm(e.target.value)} style={inputStyle} autoComplete="new-password" />
              </div>
              {err && <div style={{ color: "#F87171", fontSize: 12, marginTop: 10, padding: "8px 12px", background: "#220808", borderRadius: 6 }}>⚠ {err}</div>}
              {info && <div style={{ color: "#4ADE80", fontSize: 12, marginTop: 10, padding: "8px 12px", background: "#0A2218", borderRadius: 6 }}>{info}</div>}
              <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 14, padding: "11px 0", fontSize: 14, letterSpacing: ".04em", background: "linear-gradient(135deg,#3D7EA6,#2E6285)", color: "#0F1720", border: "none", borderRadius: 6, fontWeight: 700, cursor: busy ? "wait" : "pointer", fontFamily: "inherit" }}>
                {busy ? "…" : "UPDATE PASSWORD →"}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
