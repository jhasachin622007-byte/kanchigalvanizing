// Server-only device / IP security helpers. Never imported by client code.
import { getRequest } from "@tanstack/react-start/server";

export const ADMIN_APPROVAL_MAILBOX = "jhasachin622007@gmail.com";
const APP_URL = "https://kanchigalvanizing.lovable.app";
const GMAIL_GATEWAY = "https://connector-gateway.lovable.dev/google_mail/gmail/v1";

export type DeviceStatus =
  | "NOT_REGISTERED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "REVOKED"
  | "EXPIRED";

export type LoginResult =
  | "SUCCESS"
  | "INVALID_CREDENTIALS"
  | "NEW_DEVICE"
  | "DEVICE_NOT_APPROVED"
  | "DEVICE_REJECTED"
  | "DEVICE_REVOKED"
  | "IP_BLOCKED"
  | "ACCOUNT_LOCKED"
  | "RATE_LIMITED"
  | "SECURITY_REVIEW";

export async function admin() {
  const mod = await import("@/integrations/supabase/client.server");
  return mod.supabaseAdmin;
}

/* ------------------------------------------------------------------ */
/* Request metadata                                                    */
/* ------------------------------------------------------------------ */

/**
 * Public IP of the caller. Only forwarded headers set by the trusted edge
 * (Cloudflare in front of this deployment) are honoured; a client-supplied
 * value is never used as the source of truth.
 */
export function clientIp(): string {
  try {
    const req = getRequest();
    const h = req?.headers;
    if (!h) return "unknown";
    const cf = h.get("cf-connecting-ip");
    if (cf) return cf.trim();
    const xff = h.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
    const xr = h.get("x-real-ip");
    if (xr) return xr.trim();
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function ipVersion(ip: string): string {
  if (!ip || ip === "unknown") return "unknown";
  return ip.includes(":") ? "IPv6" : "IPv4";
}

export function approxLocation(): string | null {
  try {
    const h = getRequest()?.headers;
    if (!h) return null;
    const country = h.get("cf-ipcountry");
    const city = h.get("cf-ipcity");
    const region = h.get("cf-region");
    const parts = [city, region, country].filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  } catch {
    return null;
  }
}

export function requestUserAgent(): string {
  try {
    return getRequest()?.headers.get("user-agent") ?? "";
  } catch {
    return "";
  }
}

export type ParsedUa = {
  device_type: string;
  operating_system: string;
  browser: string;
  browser_version: string;
};

export function parseUserAgent(ua: string): ParsedUa {
  const s = ua || "";
  const isTablet = /iPad|Tablet/i.test(s);
  const isMobile = !isTablet && /Mobi|Android|iPhone|iPod/i.test(s);
  const device_type = isTablet ? "Tablet" : isMobile ? "Mobile" : "Desktop";

  let operating_system = "Unknown";
  if (/Windows NT 10/i.test(s)) operating_system = "Windows 10/11";
  else if (/Windows/i.test(s)) operating_system = "Windows";
  else if (/Android[ /]?([\d.]+)?/i.test(s))
    operating_system = "Android " + (s.match(/Android[ /]?([\d.]+)/i)?.[1] ?? "").trim();
  else if (/iPhone|iPad|iPod/i.test(s))
    operating_system = "iOS " + (s.match(/OS (\d+[_\d]*)/)?.[1]?.replace(/_/g, ".") ?? "").trim();
  else if (/Mac OS X/i.test(s)) operating_system = "macOS";
  else if (/CrOS/i.test(s)) operating_system = "ChromeOS";
  else if (/Linux/i.test(s)) operating_system = "Linux";

  let browser = "Unknown";
  let browser_version = "";
  const tests: [string, RegExp][] = [
    ["Edge", /Edg\/([\d.]+)/],
    ["Opera", /OPR\/([\d.]+)/],
    ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
    ["Firefox", /Firefox\/([\d.]+)/],
    ["Chrome", /Chrome\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, re] of tests) {
    const m = s.match(re);
    if (m) {
      browser = name;
      browser_version = m[1] ?? "";
      break;
    }
  }
  return { device_type, operating_system: operating_system.trim(), browser, browser_version };
}

export function newDeviceId(): string {
  return "DVC-" + crypto.randomUUID();
}

export function newRequestId(): string {
  return "REQ-" + crypto.randomUUID();
}

export function isValidDeviceId(v: unknown): v is string {
  return typeof v === "string" && /^DVC-[0-9a-f-]{36}$/i.test(v);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export type DeviceSettings = {
  maxDevices: number;
  approvalExpiryMinutes: number;
  bootstrapAdminDevice: boolean;
};
export type IpSettings = { mode: "OFF" | "MONITOR" | "ALLOWLIST" | "STRICT"; allowlist: string[] };

export async function getDeviceSettings(): Promise<DeviceSettings> {
  const sb = await admin();
  const { data } = await sb.from("app_settings").select("value").eq("key", "security.devices").maybeSingle();
  const v = (data?.value ?? {}) as Partial<DeviceSettings>;
  return {
    maxDevices: Number(v.maxDevices ?? 2) || 2,
    approvalExpiryMinutes: Number(v.approvalExpiryMinutes ?? 60) || 60,
    bootstrapAdminDevice: v.bootstrapAdminDevice !== false,
  };
}

export async function getIpSettings(): Promise<IpSettings> {
  const sb = await admin();
  const { data } = await sb.from("app_settings").select("value").eq("key", "security.ip").maybeSingle();
  const v = (data?.value ?? {}) as Partial<IpSettings>;
  const mode = v.mode && ["OFF", "MONITOR", "ALLOWLIST", "STRICT"].includes(v.mode) ? v.mode : "MONITOR";
  return { mode: mode as IpSettings["mode"], allowlist: Array.isArray(v.allowlist) ? v.allowlist : [] };
}

/* ------------------------------------------------------------------ */
/* CIDR                                                                */
/* ------------------------------------------------------------------ */

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const seg of p) {
    const x = Number(seg);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n << 8) | x;
  }
  return n >>> 0;
}

export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const entry = cidr.trim();
  if (!entry) return false;
  if (!entry.includes("/")) return entry === ip;
  const [base, bitsRaw] = entry.split("/");
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base ?? "");
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function ipInAllowlist(ip: string, list: string[]): boolean {
  return list.some((c) => ipMatchesCidr(ip, c));
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export async function logLoginAttempt(row: Record<string, unknown>) {
  try {
    const sb = await admin();
    await sb.from("login_attempts").insert(row as never);
  } catch (e) {
    console.error("[security] login_attempts insert failed", e);
  }
}

export async function auditEvent(row: {
  event_type: string;
  user_id?: string | null;
  admin_id?: string | null;
  device_id?: string | null;
  ip_address?: string | null;
  request_id?: string | null;
  result?: string | null;
  description?: string | null;
}) {
  try {
    const sb = await admin();
    await sb.from("security_audit_logs").insert(row as never);
  } catch (e) {
    console.error("[security] audit insert failed", e);
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

const FAIL_RESULTS = [
  "INVALID_CREDENTIALS",
  "DEVICE_NOT_APPROVED",
  "DEVICE_REJECTED",
  "DEVICE_REVOKED",
  "IP_BLOCKED",
  "RATE_LIMITED",
];

/** Returns true when the caller is currently throttled. */
export async function isRateLimited(email: string, ip: string): Promise<boolean> {
  try {
    const sb = await admin();
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const [byIp, byEmail] = await Promise.all([
      ip && ip !== "unknown"
        ? sb
            .from("login_attempts")
            .select("id", { count: "exact", head: true })
            .eq("ip_address", ip)
            .in("authentication_result", FAIL_RESULTS)
            .gte("created_at", since)
        : Promise.resolve({ count: 0 } as { count: number | null }),
      sb
        .from("login_attempts")
        .select("id", { count: "exact", head: true })
        .eq("email", email.toLowerCase())
        .in("authentication_result", FAIL_RESULTS)
        .gte("created_at", since),
    ]);
    return (byIp.count ?? 0) >= 30 || (byEmail.count ?? 0) >= 10;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

function esc(s: unknown): string {
  return String(s ?? "—").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string);
}

export async function sendDeviceApprovalEmail(info: {
  email: string;
  userId: string;
  deviceId: string;
  deviceType: string;
  os: string;
  browser: string;
  browserVersion: string;
  ip: string;
  ipVer: string;
  location: string | null;
  requestId: string;
  requestedAt: string;
}) {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  const GOOGLE_MAIL_API_KEY = process.env.GOOGLE_MAIL_API_KEY;
  if (!LOVABLE_API_KEY || !GOOGLE_MAIL_API_KEY) {
    console.error("[security] approval email skipped — mail connector not configured");
    return;
  }
  const rows: [string, string][] = [
    ["User", info.email],
    ["User ID", info.userId],
    ["Device ID", info.deviceId],
    ["Device Type", info.deviceType],
    ["Operating System", info.os],
    ["Browser", info.browser],
    ["Browser Version", info.browserVersion],
    ["IP Address", info.ip],
    ["IP Version", info.ipVer],
    ["Approximate IP Location", info.location ?? "Unavailable"],
    ["Request Time", info.requestedAt],
    ["Request ID", info.requestId],
    ["Status", "PENDING ADMIN APPROVAL"],
  ];
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#111">
<h2 style="color:#B45309;margin:0 0 6px">SECURITY ALERT</h2>
<p style="margin:0 0 14px">New device access request detected.</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px">
${rows.map(([k, v]) => `<tr><td style="border:1px solid #ddd;background:#fafafa"><b>${esc(k)}</b></td><td style="border:1px solid #ddd">${esc(v)}</td></tr>`).join("")}
</table>
<p style="margin:16px 0 0"><a href="${APP_URL}/?admin=security" style="background:#3D7EA6;color:#0F1720;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:700">Review Device Registration</a></p>
<p style="font-size:12px;color:#666;margin-top:14px">You must sign in as an administrator to approve or reject this device. This email cannot approve access by itself.</p>
</div>`;

  const stripCrlf = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  const raw = Buffer.from(
    [
      `To: ${ADMIN_APPROVAL_MAILBOX}`,
      `Subject: ${stripCrlf("New Device Login Approval Required")}`,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      html,
      "",
    ].join("\r\n"),
    "utf8",
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    const res = await fetch(`${GMAIL_GATEWAY}/users/me/messages/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "X-Connection-Api-Key": GOOGLE_MAIL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) console.error("[security] approval email failed", res.status, (await res.text()).slice(0, 300));
  } catch (e) {
    console.error("[security] approval email error", e);
  }
}

/** Notifies the admin mailbox that a device was auto-approved for the admin account. */
export async function sendDeviceAutoApprovedEmail(info: {
  email: string;
  userId: string;
  deviceId: string;
  deviceType: string;
  os: string;
  browser: string;
  browserVersion: string;
  ip: string;
  ipVer: string;
  location: string | null;
  approvedAt: string;
}) {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  const GOOGLE_MAIL_API_KEY = process.env.GOOGLE_MAIL_API_KEY;
  if (!LOVABLE_API_KEY || !GOOGLE_MAIL_API_KEY) {
    console.error("[security] auto-approval email skipped — mail connector not configured");
    return;
  }
  const rows: [string, string][] = [
    ["Account", info.email],
    ["User ID", info.userId],
    ["Device ID", info.deviceId],
    ["Device Type", info.deviceType],
    ["Operating System", info.os],
    ["Browser", `${info.browser} ${info.browserVersion}`],
    ["IP Address", info.ip],
    ["IP Version", info.ipVer],
    ["Approximate IP Location", info.location ?? "Unavailable"],
    ["Approved At", info.approvedAt],
    ["Status", "AUTO-APPROVED (ADMINISTRATOR ACCOUNT)"],
  ];
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#111">
<h2 style="color:#15803D;margin:0 0 6px">DEVICE AUTO-APPROVED</h2>
<p style="margin:0 0 14px">A device signed in with the administrator account and was approved automatically.</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px">
${rows.map(([k, v]) => `<tr><td style="border:1px solid #ddd;background:#fafafa"><b>${esc(k)}</b></td><td style="border:1px solid #ddd">${esc(v)}</td></tr>`).join("")}
</table>
<p style="margin:16px 0 0"><a href="${APP_URL}/?admin=security" style="background:#3D7EA6;color:#0F1720;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:700">Open Security Console</a></p>
<p style="font-size:12px;color:#666;margin-top:14px">If this was not you, revoke the device immediately from the Security console.</p>
</div>`;

  const raw = Buffer.from(
    [
      `To: ${ADMIN_APPROVAL_MAILBOX}`,
      "Subject: Administrator Device Auto-Approved",
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      html,
      "",
    ].join("\r\n"),
    "utf8",
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    const res = await fetch(`${GMAIL_GATEWAY}/users/me/messages/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "X-Connection-Api-Key": GOOGLE_MAIL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) console.error("[security] auto-approval email failed", res.status, (await res.text()).slice(0, 300));
  } catch (e) {
    console.error("[security] auto-approval email error", e);
  }
}

/* ------------------------------------------------------------------ */
/* Core gate                                                           */
/* ------------------------------------------------------------------ */

export type GateOutcome = {
  allowed: boolean;
  result: LoginResult;
  deviceStatus: DeviceStatus;
  deviceId: string;
  requestId?: string;
  message: string;
  device?: { device_type: string; operating_system: string; browser: string };
};

async function isAdminUser(userId: string): Promise<boolean> {
  const sb = await admin();
  const { data } = await sb.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  return !!data;
}

/**
 * Evaluate device registration + approval + IP policy for a user whose
 * credentials have ALREADY been verified server-side.
 */
export async function evaluateDeviceGate(opts: {
  userId: string;
  email: string;
  deviceIdIn: string | null;
}): Promise<GateOutcome> {
  const sb = await admin();
  const ip = clientIp();
  const ipVer = ipVersion(ip);
  const ua = requestUserAgent();
  const parsed = parseUserAgent(ua);
  const settings = await getDeviceSettings();
  const ipCfg = await getIpSettings();

  const deviceId = isValidDeviceId(opts.deviceIdIn) ? opts.deviceIdIn : newDeviceId();
  const nowIso = new Date().toISOString();

  const base = {
    user_id: opts.userId,
    email: opts.email.toLowerCase(),
    device_id: deviceId,
    ip_address: ip,
    ip_version: ipVer,
    user_agent: ua.slice(0, 500),
    device_type: parsed.device_type,
    operating_system: parsed.operating_system,
    browser: parsed.browser,
    browser_version: parsed.browser_version,
  };
  const devInfo = {
    device_type: parsed.device_type,
    operating_system: parsed.operating_system,
    browser: parsed.browser,
  };

  const finish = async (
    result: LoginResult,
    deviceStatus: DeviceStatus,
    message: string,
    requestId?: string,
  ): Promise<GateOutcome> => {
    await logLoginAttempt({
      ...base,
      authentication_result: result,
      device_status: deviceStatus,
      ip_status: ipCfg.mode,
      approval_request_id: requestId ?? null,
      request_id: requestId ?? null,
    });
    return {
      allowed: result === "SUCCESS",
      result,
      deviceStatus,
      deviceId,
      requestId,
      message,
      device: devInfo,
    };
  };

  // ---- IP allowlist enforcement (before anything else) ----
  if (ipCfg.mode === "ALLOWLIST" && ipCfg.allowlist.length > 0 && !ipInAllowlist(ip, ipCfg.allowlist)) {
    await auditEvent({
      event_type: "IP_BLOCKED",
      user_id: opts.userId,
      device_id: deviceId,
      ip_address: ip,
      result: "BLOCKED",
      description: "IP outside allowlist",
    });
    return finish("IP_BLOCKED", "NOT_REGISTERED", "Access from this network is not permitted. Contact the administrator.");
  }

  // ---- existing device row ----
  const { data: dev } = await sb
    .from("user_devices")
    .select("*")
    .eq("user_id", opts.userId)
    .eq("device_id", deviceId)
    .maybeSingle();

  // ---- Owner admin mailbox: devices are auto-approved, never held for review ----
  if (opts.email.trim().toLowerCase() === ADMIN_APPROVAL_MAILBOX) {
    const row = {
      user_id: opts.userId,
      device_id: deviceId,
      device_name: `${parsed.browser} on ${parsed.operating_system}`,
      device_type: parsed.device_type,
      operating_system: parsed.operating_system,
      browser: parsed.browser,
      browser_version: parsed.browser_version,
      last_ip: ip,
      last_seen_at: nowIso,
      status: "APPROVED",
      approved_by: opts.userId,
      approved_at: nowIso,
      rejected_at: null,
      revoked_at: null,
    };
    if (dev) {
      await sb.from("user_devices").update(row as never).eq("user_id", opts.userId).eq("device_id", deviceId);
    } else {
      await sb.from("user_devices").insert(row as never);
    }
    await sb
      .from("device_approval_requests")
      .update({ status: "APPROVED", decided_by: opts.userId, decided_at: nowIso, reason: "Auto-approved (administrator account)" } as never)
      .eq("user_id", opts.userId)
      .eq("device_id", deviceId)
      .eq("status", "PENDING");
    await auditEvent({
      event_type: "DEVICE_APPROVED",
      user_id: opts.userId,
      admin_id: opts.userId,
      device_id: deviceId,
      ip_address: ip,
      result: "APPROVED",
      description: "Auto-approved: administrator account",
    });
    await auditEvent({
      event_type: "LOGIN_SUCCESS",
      user_id: opts.userId,
      device_id: deviceId,
      ip_address: ip,
      result: "SUCCESS",
    });
    if (!dev || dev.status !== "APPROVED") {
      await sendDeviceAutoApprovedEmail({
        email: opts.email,
        userId: opts.userId,
        deviceId,
        deviceType: parsed.device_type,
        os: parsed.operating_system,
        browser: parsed.browser,
        browserVersion: parsed.browser_version,
        ip,
        ipVer,
        location: approxLocation(),
        approvedAt: nowIso,
      });
    }
    return finish("SUCCESS", "APPROVED", "Device automatically approved for the administrator account.");
  }


  const raiseRequest = async (): Promise<GateOutcome> => {
    // Reuse a live pending request when one exists.
    const { data: existing } = await sb
      .from("device_approval_requests")
      .select("request_id, expires_at, status")
      .eq("user_id", opts.userId)
      .eq("device_id", deviceId)
      .eq("status", "PENDING")
      .gt("expires_at", nowIso)
      .maybeSingle();
    if (existing?.request_id) {
      return finish(
        "DEVICE_NOT_APPROVED",
        "PENDING",
        "Your device registration is waiting for administrator approval.",
        existing.request_id,
      );
    }
    const requestId = newRequestId();
    const expires = new Date(Date.now() + settings.approvalExpiryMinutes * 60_000).toISOString();
    await sb.from("device_approval_requests").insert({
      request_id: requestId,
      user_id: opts.userId,
      device_id: deviceId,
      email: opts.email,
      ip_address: ip,
      ip_version: ipVer,
      device_type: parsed.device_type,
      operating_system: parsed.operating_system,
      browser: parsed.browser,
      browser_version: parsed.browser_version,
      location: approxLocation(),
      status: "PENDING",
      expires_at: expires,
    } as never);
    await auditEvent({
      event_type: "DEVICE_REGISTRATION_REQUESTED",
      user_id: opts.userId,
      device_id: deviceId,
      ip_address: ip,
      request_id: requestId,
      result: "PENDING",
      description: `${parsed.device_type} / ${parsed.operating_system} / ${parsed.browser}`,
    });
    await sendDeviceApprovalEmail({
      email: opts.email,
      userId: opts.userId,
      deviceId,
      deviceType: parsed.device_type,
      os: parsed.operating_system,
      browser: parsed.browser,
      browserVersion: parsed.browser_version,
      ip,
      ipVer,
      location: approxLocation(),
      requestId,
      requestedAt: nowIso,
    });
    return finish(
      "NEW_DEVICE",
      "PENDING",
      "This device is not registered. Your registration request has been sent to the administrator.",
      requestId,
    );
  };

  if (!dev) {
    // Bootstrap: the very first admin device is trusted so approvals are possible.
    if (settings.bootstrapAdminDevice && (await isAdminUser(opts.userId))) {
      await sb.from("user_devices").insert({
        user_id: opts.userId,
        device_id: deviceId,
        device_name: `${parsed.browser} on ${parsed.operating_system}`,
        device_type: parsed.device_type,
        operating_system: parsed.operating_system,
        browser: parsed.browser,
        browser_version: parsed.browser_version,
        last_ip: ip,
        status: "APPROVED",
        approved_by: opts.userId,
        approved_at: nowIso,
      } as never);
      await sb
        .from("app_settings")
        .update({ value: { ...settings, bootstrapAdminDevice: false } as never })
        .eq("key", "security.devices");
      await auditEvent({
        event_type: "DEVICE_APPROVED",
        user_id: opts.userId,
        admin_id: opts.userId,
        device_id: deviceId,
        ip_address: ip,
        result: "APPROVED",
        description: "Bootstrap: first administrator device auto-approved",
      });
      await auditEvent({
        event_type: "LOGIN_SUCCESS",
        user_id: opts.userId,
        device_id: deviceId,
        ip_address: ip,
        result: "SUCCESS",
      });
      return finish("SUCCESS", "APPROVED", "Device approved.");
    }
    await sb.from("user_devices").insert({
      user_id: opts.userId,
      device_id: deviceId,
      device_name: `${parsed.browser} on ${parsed.operating_system}`,
      device_type: parsed.device_type,
      operating_system: parsed.operating_system,
      browser: parsed.browser,
      browser_version: parsed.browser_version,
      last_ip: ip,
      status: "PENDING",
    } as never);
    await auditEvent({
      event_type: "NEW_DEVICE_DETECTED",
      user_id: opts.userId,
      device_id: deviceId,
      ip_address: ip,
      result: "BLOCKED",
    });
    return raiseRequest();
  }

  await sb
    .from("user_devices")
    .update({ last_seen_at: nowIso, last_ip: ip } as never)
    .eq("user_id", opts.userId)
    .eq("device_id", deviceId);

  if (dev.status === "REJECTED")
    return finish("DEVICE_REJECTED", "REJECTED", "This device has not been approved. Please contact the administrator.");
  if (dev.status === "REVOKED")
    return finish("DEVICE_REVOKED", "REVOKED", "This device is no longer authorized. A new registration and approval is required.");
  if (dev.status === "PENDING") {
    // Expire stale requests, then re-raise.
    await sb
      .from("device_approval_requests")
      .update({ status: "EXPIRED" } as never)
      .eq("user_id", opts.userId)
      .eq("device_id", deviceId)
      .eq("status", "PENDING")
      .lt("expires_at", nowIso);
    return raiseRequest();
  }
  if (dev.status !== "APPROVED")
    return finish("DEVICE_NOT_APPROVED", dev.status as DeviceStatus, "Device registration is not approved.");

  // ---- STRICT IP policy: unseen IP for an approved device needs review ----
  if (ipCfg.mode === "STRICT" && ip !== "unknown") {
    const { count } = await sb
      .from("login_attempts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", opts.userId)
      .eq("ip_address", ip)
      .eq("authentication_result", "SUCCESS");
    if ((count ?? 0) === 0) {
      await auditEvent({
        event_type: "IP_BLOCKED",
        user_id: opts.userId,
        device_id: deviceId,
        ip_address: ip,
        result: "SECURITY_REVIEW",
        description: "Strict IP policy: unrecognised address",
      });
      return finish(
        "SECURITY_REVIEW",
        "APPROVED",
        "Sign-in from an unrecognised network requires administrator review.",
      );
    }
  }

  await auditEvent({
    event_type: "LOGIN_SUCCESS",
    user_id: opts.userId,
    device_id: deviceId,
    ip_address: ip,
    result: "SUCCESS",
  });
  return finish("SUCCESS", "APPROVED", "Device approved.");
}
