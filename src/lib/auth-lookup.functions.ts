import { createServerFn } from "@tanstack/react-start";

/**
 * Sign in with username OR email + password. Resolution happens entirely
 * server-side; the raw email is never returned to the client, which prevents
 * unauthenticated username -> email enumeration / PII harvesting.
 *
 * Returns the Supabase session tokens on success so the browser can call
 * `supabase.auth.setSession(...)` to hydrate the client session.
 */
export const signInWithIdentifier = createServerFn({ method: "POST" })
  .inputValidator((data: { identifier: string; password: string; deviceId?: string | null }) => ({
    identifier: String(data?.identifier || "").trim(),
    password: String(data?.password || ""),
    deviceId: typeof data?.deviceId === "string" ? data.deviceId : null,
  }))
  .handler(async ({ data }) => {
    const sec = await import("@/lib/device-security.server");
    const ip = sec.clientIp();
    const fail = async (email?: string) => {
      await sec.logLoginAttempt({
        email: (email || data.identifier).toLowerCase().slice(0, 254),
        ip_address: ip,
        ip_version: sec.ipVersion(ip),
        user_agent: sec.requestUserAgent().slice(0, 500),
        authentication_result: "INVALID_CREDENTIALS",
        device_status: "NOT_REGISTERED",
      });
      return { ok: false as const, status: "INVALID_CREDENTIALS" as const, error: "Invalid credentials" };
    };
    if (!data.identifier || data.identifier.length > 254) return fail();
    if (!data.password || data.password.length > 200) return fail();

    const { createClient } = await import("@supabase/supabase-js");
    let email = data.identifier;

    if (!email.includes("@")) {
      // Resolve username -> email using service role, but never return the email.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: row, error } = await supabaseAdmin
        .from("profiles")
        .select("email, active")
        .ilike("username", email)
        .maybeSingle();
      // Generic error — do not differentiate "no such username" from "wrong password".
      if (error || !row || row.active === false || !row.email) return fail();
      email = row.email as string;
    }

    if (await sec.isRateLimited(email, ip)) {
      await sec.logLoginAttempt({
        email: email.toLowerCase(),
        ip_address: ip,
        ip_version: sec.ipVersion(ip),
        user_agent: sec.requestUserAgent().slice(0, 500),
        authentication_result: "RATE_LIMITED",
        device_status: "NOT_REGISTERED",
      });
      return {
        ok: false as const,
        status: "RATE_LIMITED" as const,
        error: "Too many attempts. Please wait a few minutes and try again.",
      };
    }

    const supa = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false, storage: undefined } },
    );
    const { data: signIn, error: signErr } = await supa.auth.signInWithPassword({
      email,
      password: data.password,
    });
    if (signErr || !signIn.session) return fail(email);

    // Credentials are valid — now the device / IP gate decides.
    const gate = await sec.evaluateDeviceGate({
      userId: signIn.session.user.id,
      email,
      deviceIdIn: data.deviceId,
    });

    if (!gate.allowed) {
      // Never hand out tokens for an unapproved device.
      try { await supa.auth.signOut(); } catch {}
      return {
        ok: false as const,
        status: gate.result,
        deviceStatus: gate.deviceStatus,
        deviceId: gate.deviceId,
        requestId: gate.requestId ?? null,
        device: gate.device ?? null,
        error: gate.message,
      };
    }

    return {
      ok: true as const,
      status: "SUCCESS" as const,
      deviceId: gate.deviceId,
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
    };
  });



/**
 * Send a password reset email for the given username or email. Always returns
 * `{ ok: true }` regardless of whether the account exists, so the endpoint
 * cannot be used to enumerate usernames or emails.
 */
export const sendPasswordResetForIdentifier = createServerFn({ method: "POST" })
  .inputValidator((data: { identifier: string; redirectTo?: string }) => {
    const id = String(data?.identifier || "").trim();
    if (!id || id.length > 254) throw new Error("Invalid request");
    const redirectTo =
      typeof data?.redirectTo === "string" && /^https?:\/\//i.test(data.redirectTo)
        ? data.redirectTo
        : undefined;
    return { identifier: id, redirectTo };
  })
  .handler(async ({ data }) => {
    try {
      let email = data.identifier;
      if (!email.includes("@")) {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: row } = await supabaseAdmin
          .from("profiles")
          .select("email, active")
          .ilike("username", email)
          .maybeSingle();
        if (!row || row.active === false || !row.email) return { ok: true };
        email = row.email as string;
      }
      const { createClient } = await import("@supabase/supabase-js");
      const supa = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_PUBLISHABLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false, storage: undefined } },
      );
      await supa.auth.resetPasswordForEmail(email, { redirectTo: data.redirectTo });
    } catch {
      // Swallow — uniform response prevents enumeration.
    }
    return { ok: true };
  });
