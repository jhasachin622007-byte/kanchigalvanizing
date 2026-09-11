import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// supabaseAdmin is imported dynamically inside helpers so the service-role
// client never enters the client module graph via a top-level static import.
async function getAdmin() {
  const mod = await import("@/integrations/supabase/client.server");
  return mod.supabaseAdmin;
}

const GMAIL_GATEWAY = "https://connector-gateway.lovable.dev/google_mail/gmail/v1";

async function assertReportSender(userId: string) {
  const supabaseAdmin = await getAdmin();
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "supervisor"]);
  if (error) throw new Error("Authorization check failed");
  if (!data || data.length === 0) throw new Error("Forbidden: admin or supervisor only");
  const roles = new Set(data.map((r: any) => r.role));
  // Admins always retain email-sending permission. Non-admins must have
  // canSendReportEmail explicitly granted by an admin in Module Access.
  if (roles.has("admin")) return;
  const { data: maRow, error: maErr } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "moduleAccess")
    .maybeSingle();
  if (maErr) throw new Error("Permission lookup failed");
  const ma = (maRow?.value ?? {}) as Record<string, any>;
  const perms = ma[String(userId)] ?? {};
  if (!perms || perms.canSendReportEmail !== true) {
    throw new Error("Forbidden: email-sending permission has been revoked by an admin");
  }
}

async function getAllowedRecipients(): Promise<Set<string>> {
  const supabaseAdmin = await getAdmin();
  const { data, error } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "emailRecs")
    .maybeSingle();
  if (error) throw new Error("Recipient allow-list lookup failed");
  const allowed = new Set<string>();
  const val = (data?.value ?? {}) as Record<string, unknown>;
  for (const arr of Object.values(val)) {
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (typeof e === "string") allowed.add(e.trim().toLowerCase());
      }
    }
  }
  return allowed;
}

// Server-side HTML sanitizer for the report body. Reports are data tables, so
// we drop any script/iframe/object/embed/link/meta/style elements, every "on*"
// event handler attribute, and any href/src that uses a javascript:/data:/vbscript:
// scheme. This blocks XSS/phishing payloads even if the caller bypasses the UI.
function sanitizeReportHtml(html: string): string {
  let out = html;
  // Strip dangerous tags including their content
  out = out.replace(
    /<(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|svg)\b[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  // Strip self-closing / orphan dangerous tags
  out = out.replace(
    /<(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|svg)\b[^>]*\/?>/gi,
    "",
  );
  // Strip on* event handler attributes
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Neutralize dangerous URL schemes in href/src
  out = out.replace(
    /\s(href|src|xlink:href|formaction|action)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi,
    ' $1=$2#$2',
  );
  return out;
}


const Schema = z.object({
  recipients: z.array(z.string().email()).min(1).max(50),
  subject: z.string().min(1).max(200),
  bodyHtml: z.string().min(1).max(200_000),
  filename: z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/),
  fileBase64: z.string().min(1).max(20_000_000), // base64-encoded xlsx, ~15 MB binary cap
  mimeType: z.string().min(1).max(100).default(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ),
});

function buildRawEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  filename: string;
  fileBase64: string;
  mimeType: string;
}) {
  const boundary = "----hdp_boundary_" + Math.random().toString(36).slice(2);
  // Wrap base64 to 76-char lines per RFC 2045
  const wrapped = opts.fileBase64.replace(/.{76}/g, "$&\r\n");
  // Strip CR/LF from any value placed into a MIME header to prevent
  // header injection (attacker-supplied "Subject" or filename smuggling
  // Bcc:/Cc:/extra MIME parts via embedded \r\n).
  const stripCrlf = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  const safeSubject = stripCrlf(opts.subject);
  const safeMime = stripCrlf(opts.mimeType);
  const safeFilename = stripCrlf(opts.filename).replace(/"/g, "");
  const safeTo = opts.to
    .map(stripCrlf)
    .filter((a) => /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/.test(a));
  if (safeTo.length === 0) throw new Error("No valid recipients after sanitization");
  const lines = [
    `To: ${safeTo.join(", ")}`,
    `Subject: ${safeSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    opts.html,
    "",
    `--${boundary}`,
    `Content-Type: ${safeMime}; name="${safeFilename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${safeFilename}"`,
    "",
    wrapped,
    "",
    `--${boundary}--`,
    "",
  ];
  const raw = lines.join("\r\n");
  // base64url encode
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const sendBeamReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => Schema.parse(input))
  .handler(async ({ data, context }) => {
    await assertReportSender(context.userId);

    // Enforce admin-configured recipient allow-list (defense in depth — a
    // compromised supervisor account cannot phish arbitrary addresses).
    const allowed = await getAllowedRecipients();
    if (allowed.size === 0) {
      throw new Error("No recipient allow-list configured. Add recipients in Admin → Email settings.");
    }
    const filteredRecipients = data.recipients.filter((r) =>
      allowed.has(r.trim().toLowerCase()),
    );
    if (filteredRecipients.length === 0) {
      throw new Error("None of the requested recipients are in the configured allow-list.");
    }

    // Strip scripts / event handlers / dangerous URL schemes from the report HTML.
    const safeHtml = sanitizeReportHtml(data.bodyHtml);

    const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
    const GOOGLE_MAIL_API_KEY = process.env.GOOGLE_MAIL_API_KEY;
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    if (!GOOGLE_MAIL_API_KEY) throw new Error("Gmail connector not configured");

    const raw = buildRawEmail({
      to: filteredRecipients,
      subject: data.subject,
      html: safeHtml,
      filename: data.filename,
      fileBase64: data.fileBase64,
      mimeType: data.mimeType,
    });


    const res = await fetch(`${GMAIL_GATEWAY}/users/me/messages/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "X-Connection-Api-Key": GOOGLE_MAIL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });

    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Gmail send failed [${res.status}]: ${body.slice(0, 500)}`);
    }
    let parsed: any = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // ignore
    }
    return { ok: true, id: parsed.id ?? null, recipients: filteredRecipients };
  });
