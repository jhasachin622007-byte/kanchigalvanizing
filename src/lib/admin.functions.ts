import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
// NOTE: supabaseAdmin is imported dynamically inside each handler to keep
// the service-role client out of the client module graph. Route/function
// files are part of the client bundle (only handler bodies are stripped),
// so a top-level static import risks leaking the admin client.
type SupabaseAdmin = typeof import("@/integrations/supabase/client.server")["supabaseAdmin"];
async function getAdmin(): Promise<SupabaseAdmin> {
  const mod = await import("@/integrations/supabase/client.server");
  return mod.supabaseAdmin;
}

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error || !data) throw new Error("Forbidden: admin only");
}

const RoleEnum = z.enum([
  "admin",
  "supervisor",
  "shift_supervisor",
  "manager",
  "loading_supervisor",
  "dipping_supervisor",
  "qc_inspector",
]);

export const createUserAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        email: z.string().email(),
        full_name: z.string().min(1).max(120),
        username: z.string().min(1).max(60).optional(),
        role: RoleEnum,
        redirect_to: z.string().url().optional(),
        password: z.string().min(6).max(128).optional(),
        send_invite: z.boolean().optional(),
        module_access: z.record(z.string(), z.any()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const supabaseAdmin = await getAdmin();
    const username = data.username ?? data.email.split("@")[0];
    const meta = { full_name: data.full_name, username, role: data.role };

    let newUserId: string;
    let invited = false;

    if (data.send_invite) {
      const { data: inv, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email, {
        redirectTo: data.redirect_to,
        data: meta,
      });
      if (error || !inv.user) throw new Error(error?.message || "Invite failed");
      newUserId = inv.user.id;
      invited = true;
    } else {
      if (!data.password) throw new Error("Password is required when invite email is disabled");
      const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
        email: data.email,
        password: data.password,
        email_confirm: true,
        user_metadata: meta,
      });
      if (error || !created.user) throw new Error(error?.message || "Create user failed");
      newUserId = created.user.id;
    }

    // From here on, any failure MUST roll back the auth user so we never leave
    // an orphan account that logs in with "Profile not found".
    const rollback = async (reason: string): Promise<never> => {
      try { await supabaseAdmin.auth.admin.deleteUser(newUserId); } catch { /* ignore */ }
      throw new Error(reason);
    };

    // 1) Ensure profile exists — do NOT rely on the handle_new_user trigger alone.
    const { error: profErr } = await supabaseAdmin
      .from("profiles")
      .upsert(
        {
          id: newUserId,
          email: data.email,
          full_name: data.full_name,
          username,
          active: true,
          created_by: context.userId,
        } as any,
        { onConflict: "id" },
      );
    if (profErr) await rollback("Profile creation failed: " + profErr.message);

    // 2) Reset roles then assign selected role.
    const { error: delErr } = await supabaseAdmin.from("user_roles").delete().eq("user_id", newUserId);
    if (delErr) await rollback("Role reset failed: " + delErr.message);
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: newUserId, role: data.role });
    if (roleErr) await rollback("Role assignment failed: " + roleErr.message);

    // 3) Optional per-user module access → app_settings.moduleAccess[user_id]
    if (data.module_access && Object.keys(data.module_access).length > 0) {
      const { data: existing } = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", "moduleAccess")
        .maybeSingle();
      const cur = (existing?.value as Record<string, any>) || {};
      const next = { ...cur, [newUserId]: data.module_access };
      const { error: maErr } = await supabaseAdmin
        .from("app_settings")
        .upsert({ key: "moduleAccess", value: next }, { onConflict: "key" });
      if (maErr) await rollback("Module access assignment failed: " + maErr.message);
    }

    // 4) Verify — profile + role must actually exist.
    const [{ data: profCheck }, { data: roleCheck }] = await Promise.all([
      supabaseAdmin.from("profiles").select("id").eq("id", newUserId).maybeSingle(),
      supabaseAdmin.from("user_roles").select("role").eq("user_id", newUserId).eq("role", data.role).maybeSingle(),
    ]);
    if (!profCheck) await rollback("Verification failed: profile row missing after insert");
    if (!roleCheck) await rollback("Verification failed: role not assigned after insert");

    return { id: newUserId, invited, role: data.role };
  });

export const deleteUserAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ user_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const supabaseAdmin = await getAdmin();
    if (data.user_id === context.userId) throw new Error("Cannot delete yourself");

    // Delete the auth account FIRST so a failure leaves the user fully intact
    // (no half-deleted state where role/profile are gone but the login remains).
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (error) throw new Error(error.message);

    // Cleanup app rows (auth cascade also covers these) — beam data is kept.
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);
    await supabaseAdmin.from("profiles").delete().eq("id", data.user_id);

    // Drop the module-access entry for this user.
    const { data: maRow } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "moduleAccess")
      .maybeSingle();
    const ma = (maRow?.value ?? null) as Record<string, any> | null;
    if (ma && Object.prototype.hasOwnProperty.call(ma, data.user_id)) {
      const next = { ...ma };
      delete next[data.user_id];
      await supabaseAdmin
        .from("app_settings")
        .upsert({ key: "moduleAccess", value: next as any }, { onConflict: "key" });
    }
    return { ok: true };
  });


export const resetUserPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ user_id: z.string().uuid(), new_password: z.string().min(6).max(128) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const supabaseAdmin = await getAdmin();
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      password: data.new_password,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setUserActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ user_id: z.string().uuid(), active: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const supabaseAdmin = await getAdmin();
    // Ban via auth (block sign-in) and mirror to profile flag.
    const { error: a } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      ban_duration: data.active ? "none" : "876000h",
    });
    if (a) throw new Error(a.message);
    await supabaseAdmin.from("profiles").update({ active: data.active }).eq("id", data.user_id);
    return { ok: true };
  });
