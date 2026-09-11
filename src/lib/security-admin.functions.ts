import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Reports whether the caller's current device is still approved. */
export const checkMyDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { deviceId?: string | null }) => ({
    deviceId: typeof data?.deviceId === "string" ? data.deviceId : null,
  }))
  .handler(async ({ data, context }) => {
    const sec = await import("@/lib/device-security.server");
    if (!sec.isValidDeviceId(data.deviceId)) return { approved: false, status: "NOT_REGISTERED" };
    const sb = await sec.admin();
    const { data: dev } = await sb
      .from("user_devices")
      .select("status")
      .eq("user_id", context.userId)
      .eq("device_id", data.deviceId)
      .maybeSingle();
    return { approved: dev?.status === "APPROVED", status: dev?.status ?? "NOT_REGISTERED" };
  });

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error || !data) throw new Error("Forbidden: administrator role required");
}

export const securityOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as never);
    const sec = await import("@/lib/device-security.server");
    const sb = await sec.admin();
    const nowIso = new Date().toISOString();
    const [pending, devices, attempts, audit, devCfg, ipCfg] = await Promise.all([
      sb.from("device_approval_requests").select("*").eq("status", "PENDING").gt("expires_at", nowIso).order("created_at", { ascending: false }).limit(200),
      sb.from("user_devices").select("*").order("last_seen_at", { ascending: false }).limit(500),
      sb.from("login_attempts").select("*").order("created_at", { ascending: false }).limit(300),
      sb.from("security_audit_logs").select("*").order("created_at", { ascending: false }).limit(300),
      sec.getDeviceSettings(),
      sec.getIpSettings(),
    ]);
    return {
      pending: pending.data ?? [],
      devices: devices.data ?? [],
      attempts: attempts.data ?? [],
      audit: audit.data ?? [],
      deviceSettings: devCfg,
      ipSettings: ipCfg,
    };
  });

export const decideDeviceRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { requestId: string; action: "APPROVE" | "REJECT"; reason?: string }) => {
    const requestId = String(data?.requestId || "").trim();
    const action = data?.action === "APPROVE" ? "APPROVE" : "REJECT";
    if (!requestId) throw new Error("Invalid request");
    return { requestId, action: action as "APPROVE" | "REJECT", reason: String(data?.reason || "").slice(0, 300) };
  })
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    const sec = await import("@/lib/device-security.server");
    const sb = await sec.admin();
    const nowIso = new Date().toISOString();

    const { data: req } = await sb
      .from("device_approval_requests")
      .select("*")
      .eq("request_id", data.requestId)
      .maybeSingle();
    if (!req) return { ok: false, error: "Request not found" };
    if (req.status !== "PENDING") return { ok: false, error: `Request already ${String(req.status).toLowerCase()}` };
    if (new Date(req.expires_at as string).getTime() < Date.now()) {
      await sb.from("device_approval_requests").update({ status: "EXPIRED" } as never).eq("request_id", data.requestId);
      return { ok: false, error: "Request expired" };
    }

    if (data.action === "APPROVE") {
      const settings = await sec.getDeviceSettings();
      const { count } = await sb
        .from("user_devices")
        .select("id", { count: "exact", head: true })
        .eq("user_id", req.user_id as string)
        .eq("status", "APPROVED");
      if ((count ?? 0) >= settings.maxDevices) {
        return { ok: false, error: `User already has the maximum of ${settings.maxDevices} approved devices. Revoke one first.` };
      }
      await sb
        .from("user_devices")
        .update({ status: "APPROVED", approved_by: context.userId, approved_at: nowIso, rejected_at: null, revoked_at: null } as never)
        .eq("user_id", req.user_id as string)
        .eq("device_id", req.device_id as string);
    } else {
      await sb
        .from("user_devices")
        .update({ status: "REJECTED", rejected_at: nowIso } as never)
        .eq("user_id", req.user_id as string)
        .eq("device_id", req.device_id as string);
    }

    await sb
      .from("device_approval_requests")
      .update({
        status: data.action === "APPROVE" ? "APPROVED" : "REJECTED",
        decided_by: context.userId,
        decided_at: nowIso,
        reason: data.reason || null,
      } as never)
      .eq("request_id", data.requestId);

    await sec.auditEvent({
      event_type: data.action === "APPROVE" ? "DEVICE_APPROVED" : "DEVICE_REJECTED",
      user_id: req.user_id as string,
      admin_id: context.userId,
      device_id: req.device_id as string,
      request_id: data.requestId,
      result: data.action === "APPROVE" ? "APPROVED" : "REJECTED",
      description: data.reason || null,
    });
    return { ok: true };
  });

export const revokeDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { userId: string; deviceId: string; reason?: string }) => {
    const userId = String(data?.userId || "").trim();
    const deviceId = String(data?.deviceId || "").trim();
    if (!userId || !deviceId) throw new Error("Invalid request");
    return { userId, deviceId, reason: String(data?.reason || "").slice(0, 300) };
  })
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    const sec = await import("@/lib/device-security.server");
    const sb = await sec.admin();
    await sb
      .from("user_devices")
      .update({ status: "REVOKED", revoked_at: new Date().toISOString() } as never)
      .eq("user_id", data.userId)
      .eq("device_id", data.deviceId);
    await sec.auditEvent({
      event_type: "DEVICE_REVOKED",
      user_id: data.userId,
      admin_id: context.userId,
      device_id: data.deviceId,
      result: "REVOKED",
      description: data.reason || null,
    });
    return { ok: true };
  });

export const reapproveDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { userId: string; deviceId: string }) => {
    const userId = String(data?.userId || "").trim();
    const deviceId = String(data?.deviceId || "").trim();
    if (!userId || !deviceId) throw new Error("Invalid request");
    return { userId, deviceId };
  })
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    const sec = await import("@/lib/device-security.server");
    const sb = await sec.admin();
    const settings = await sec.getDeviceSettings();
    const { count } = await sb
      .from("user_devices")
      .select("id", { count: "exact", head: true })
      .eq("user_id", data.userId)
      .eq("status", "APPROVED");
    if ((count ?? 0) >= settings.maxDevices) {
      return { ok: false, error: `User already has the maximum of ${settings.maxDevices} approved devices. Revoke one first.` };
    }
    const nowIso = new Date().toISOString();
    const { error } = await sb
      .from("user_devices")
      .update({ status: "APPROVED", approved_by: context.userId, approved_at: nowIso, revoked_at: null, rejected_at: null } as never)
      .eq("user_id", data.userId)
      .eq("device_id", data.deviceId);
    if (error) return { ok: false, error: error.message };
    await sec.auditEvent({
      event_type: "DEVICE_REAPPROVED",
      user_id: data.userId,
      admin_id: context.userId,
      device_id: data.deviceId,
      result: "APPROVED",
      description: "Device re-approved by administrator",
    });
    return { ok: true };
  });


export const updateSecuritySettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: {
    maxDevices: number;
    approvalExpiryMinutes: number;
    ipMode: "OFF" | "MONITOR" | "ALLOWLIST" | "STRICT";
    allowlist: string[];
  }) => ({
    maxDevices: Math.max(1, Math.min(20, Number(data?.maxDevices) || 2)),
    approvalExpiryMinutes: Math.max(5, Math.min(10080, Number(data?.approvalExpiryMinutes) || 60)),
    ipMode: (["OFF", "MONITOR", "ALLOWLIST", "STRICT"].includes(data?.ipMode) ? data.ipMode : "MONITOR") as
      "OFF" | "MONITOR" | "ALLOWLIST" | "STRICT",
    allowlist: Array.isArray(data?.allowlist) ? data.allowlist.map((x) => String(x).trim()).filter(Boolean).slice(0, 100) : [],
  }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    const sec = await import("@/lib/device-security.server");
    const sb = await sec.admin();
    const current = await sec.getDeviceSettings();
    await sb.from("app_settings").upsert(
      {
        key: "security.devices",
        value: {
          maxDevices: data.maxDevices,
          approvalExpiryMinutes: data.approvalExpiryMinutes,
          bootstrapAdminDevice: current.bootstrapAdminDevice,
        },
      } as never,
      { onConflict: "key" } as never,
    );
    await sb.from("app_settings").upsert(
      { key: "security.ip", value: { mode: data.ipMode, allowlist: data.allowlist } } as never,
      { onConflict: "key" } as never,
    );
    await sec.auditEvent({
      event_type: "SECURITY_SETTINGS_UPDATED",
      admin_id: context.userId,
      result: "OK",
      description: `maxDevices=${data.maxDevices}, expiry=${data.approvalExpiryMinutes}m, ip=${data.ipMode}`,
    });
    return { ok: true };
  });
