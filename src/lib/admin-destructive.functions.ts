import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Beams live in the legacy table plus five rotation tables; destructive admin
// actions must cover all six. Kept literal here so this server module never
// imports the browser-side shard helper.
const BEAM_TABLES = [
  "beams",
  "new_beams_1",
  "new_beams_2",
  "new_beams_3",
  "new_beams_4",
  "new_beams_5",
] as const;

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error || !data) throw new Error("Forbidden: admin only");
}

export const adminDeleteBeams = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        transaction_ids: z.array(z.string().min(1).max(120)).min(1).max(1000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    for (const t of BEAM_TABLES) {
      const { error } = await (supabaseAdmin as any)
        .from(t)
        .delete()
        .in("transaction_id", data.transaction_ids);
      if (error) throw new Error(error.message);
    }
    return { ok: true, deleted: data.transaction_ids.length };
  });

export const adminDeleteAuditEntries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("audit_log").delete().in("id", data.ids);
    if (error) throw new Error(error.message);
    return { ok: true, deleted: data.ids.length };
  });

export const adminResetBeams = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ confirm: z.literal(true) }).parse(input))
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    for (const t of BEAM_TABLES) {
      const { error } = await (supabaseAdmin as any)
        .from(t)
        .delete()
        .not("transaction_id", "is", null);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const adminPurgeOldAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ daysToKeep: z.number().int().min(1).max(3650) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const cutoff = new Date(Date.now() - data.daysToKeep * 86400 * 1000).toISOString();
    const { data: rows, error } = await supabaseAdmin
      .from("audit_log")
      .delete()
      .lt("created_at", cutoff)
      .select("id");
    if (error) throw new Error(error.message);
    return { ok: true, deleted: rows?.length ?? 0, cutoff };
  });
