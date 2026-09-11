import { supabase } from "@/integrations/supabase/client";

/**
 * Durable queue of failed Supabase mutations.
 *
 * `useSyncedTable.set` calls into here when an insert/update/delete fails
 * or times out (offline, captive portal, dead Wi-Fi, weak cellular). The op
 * is persisted to localStorage and replayed automatically on a background
 * backoff schedule, on `hdp:resume`, and on `online`.
 *
 * Why localStorage: the queue must outlive a tab freeze + reload from the
 * OS. Why not server-side: the user may be offline entirely.
 */

const KEY = "hdp:pending-writes";
const OP_TIMEOUT_MS = 10_000;
const MAX_TRIES_BEFORE_WARN = 25;

/**
 * `table` is the physical Postgres table the op is replayed against.
 * `logical` (optional) is the app-level stream the op belongs to — beams are
 * physically spread across `beams` + `new_beams_1..5` but are one logical
 * "beams" stream for badges, dirty ledgers and sync-status events.
 */
export type PendingOp =
  | { kind: "insert"; table: string; logical?: string; rowIdKey: string; rows: any[]; onConflict?: string; ignoreDuplicates?: boolean }
  | { kind: "update"; table: string; logical?: string; rowIdKey: string; id: any; row: any }
  | { kind: "upsert"; table: string; logical?: string; rowIdKey: string; row: any; onConflict?: string }
  | { kind: "delete"; table: string; logical?: string; rowIdKey: string; ids: any[] };


type Entry = { id: string; op: PendingOp; tries: number; lastError?: string };

function read(): Entry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(entries: Entry[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {}
}

function dispatchStatus(status: "pending" | "draining" | "drained" | "failed", count: number) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("hdp:sync-status", {
        detail: { table: "pending-queue", status, count },
      }),
    );
  } catch {}
}

function opIds(op: PendingOp): any[] {
  if (op.kind === "insert") return (op.rows || []).map((r) => r?.[op.rowIdKey]);
  if (op.kind === "update") return [op.id];
  if (op.kind === "upsert") return [op.row?.[op.rowIdKey]];
  return op.ids || [];
}

function dispatchOpStatus(
  op: PendingOp,
  status: "queued" | "saved" | "failed",
  message?: string,
) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("hdp:sync-status", {
        detail: { table: op.logical || op.table, physicalTable: op.table, status, op: op.kind, ids: opIds(op), message },
      }),
    );
  } catch {}
}

function dispatchWarn(entry: Entry) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("hdp:sync-error", {
        detail: {
          table: entry.op.logical || entry.op.table,
          op: entry.op.kind,
          message: `Still retrying after ${entry.tries} attempts: ${entry.lastError || "transient error"}`,
          stuck: true,
        },
      }),
    );
  } catch {}
}

/**
 * Add an op to the queue. Updates to the same row are coalesced: a newer
 * update replaces the older queued update so we don't replay an entire
 * dipping phase-tap stream after a long offline window.
 */
export function enqueue(opIn: PendingOp) {
  let op: PendingOp = opIn;
  const entries = read();
  if (op.kind === "update") {
    const upOp = op;
    const idx = entries.findIndex(
      (e) =>
        e.op.kind === "update" &&
        (e.op.logical || e.op.table) === (upOp.logical || upOp.table) &&
        e.op.rowIdKey === upOp.rowIdKey &&
        String((e.op as any).id) === String(upOp.id),
    );
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], op };
      write(entries);
      dispatchStatus("pending", entries.length);
      dispatchOpStatus(op, "queued");
      scheduleRetry(2_000);
      return;
    }
  } else if (op.kind === "upsert") {
    const usOp = op;
    const rid = usOp.row?.[usOp.rowIdKey];
    const idx = entries.findIndex(
      (e) =>
        e.op.kind === "upsert" &&
        (e.op.logical || e.op.table) === (usOp.logical || usOp.table) &&
        e.op.rowIdKey === usOp.rowIdKey &&
        String((e.op as any).row?.[(e.op as any).rowIdKey]) === String(rid),
    );
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], op };
      write(entries);
      dispatchStatus("pending", entries.length);
      dispatchOpStatus(op, "queued");
      scheduleRetry(2_000);
      return;
    }
  } else if (op.kind === "insert") {
    // Coalesce inserts by rowId so a re-tap or auto-offer re-run doesn't
    // enqueue a duplicate row that will later trip a unique constraint.
    const insOp = op;
    const filteredRows = (insOp.rows || []).filter((r) => {
      const rid = String(r?.[insOp.rowIdKey]);
      const dup = entries.some(
        (e) =>
          e.op.kind === "insert" &&
          (e.op.logical || e.op.table) === (insOp.logical || insOp.table) &&
          e.op.rowIdKey === insOp.rowIdKey &&
          ((e.op as any).rows || []).some(
            (existing: any) => String(existing?.[insOp.rowIdKey]) === rid,
          ),
      );
      return !dup;
    });
    if (filteredRows.length === 0) {
      dispatchStatus("pending", entries.length);
      dispatchOpStatus(op, "queued");
      return;
    }
    op = { ...insOp, rows: filteredRows };
  }
  entries.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    op,
    tries: 0,
  });
  write(entries);
  dispatchStatus("pending", entries.length);
  dispatchOpStatus(op, "queued");
  scheduleRetry(2_000);
}

export function pendingCount(): number {
  return read().length;
}

export function pendingCountForTable(table: string): number {
  return read().filter((e) => (e.op.logical || e.op.table) === table).length;
}

export function pendingOpsForTable(table: string): PendingOp[] {
  return read().filter((e) => (e.op.logical || e.op.table) === table).map((e) => e.op);
}

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Request timed out")), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function runRaw(op: PendingOp): Promise<{ error: any } | { error: null }> {
  const sb: any = supabase;
  if (op.kind === "insert") {
    if (op.onConflict) {
      return await withTimeout(
        sb.from(op.table).upsert(op.rows, {
          onConflict: op.onConflict,
          ignoreDuplicates: op.ignoreDuplicates ?? true,
        }),
        OP_TIMEOUT_MS,
      );
    }
    return await withTimeout(sb.from(op.table).insert(op.rows), OP_TIMEOUT_MS);
  } else if (op.kind === "update") {
    return await withTimeout(
      sb.from(op.table).update(op.row).eq(op.rowIdKey, op.id),
      OP_TIMEOUT_MS,
    );
  } else if (op.kind === "upsert") {
    return await withTimeout(
      sb.from(op.table).upsert(op.row, { onConflict: op.onConflict || op.rowIdKey }),
      OP_TIMEOUT_MS,
    );
  } else {
    return await withTimeout(
      sb.from(op.table).delete().in(op.rowIdKey, op.ids),
      OP_TIMEOUT_MS,
    );
  }
}

async function runOp(op: PendingOp): Promise<{ ok: true } | { ok: false; permanent: boolean; message: string }> {
  try {
    const { error } = await runRaw(op);
    if (!error) return { ok: true };

    // Duplicate-key on insert means the row is already there — treat as success.
    if (String((error as any)?.code || "") === "23505") return { ok: true };

    // Auth-expiry recovery: refresh once, then retry the same op.
    if (isAuthExpired(error)) {
      try {
        await supabase.auth.refreshSession();
        const { error: retryErr } = await runRaw(op);
        if (!retryErr) return { ok: true };
        if (String((retryErr as any)?.code || "") === "23505") return { ok: true };
        return classify(retryErr);
      } catch (e: any) {
        return { ok: false, permanent: false, message: e?.message || "auth refresh failed" };
      }
    }
    return classify(error);
  } catch (err: any) {
    // Timeouts / network errors are always transient.
    return { ok: false, permanent: false, message: err?.message || String(err) };
  }
}

function isAuthExpired(error: any): boolean {
  const status = Number(error?.status || error?.statusCode || 0);
  const msg = String(error?.message || "").toLowerCase();
  return (
    status === 401 ||
    msg.includes("jwt expired") ||
    msg.includes("invalid jwt") ||
    msg.includes("token is expired")
  );
}

function classify(error: any): { ok: false; permanent: boolean; message: string } {
  const code = String(error?.code || "");
  const status = Number(error?.status || error?.statusCode || 0);
  // RLS / not-null / FK / check-constraint won't fix themselves on retry.
  // 401 is handled separately above (refresh + retry).
  const permanent =
    code === "42501" || // permission denied
    code === "23502" || // not-null violation
    code === "23503" || // FK violation
    code === "23514" || // check constraint
    // Other 4xx (except 401/408/429) are not retryable.
    (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429);
  return { ok: false, permanent, message: error?.message || "Unknown error" };
}

let draining = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 2_000;

function scheduleRetry(delayMs: number) {
  if (typeof window === "undefined") return;
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drainQueue();
  }, delayMs);
}

export async function drainQueue(): Promise<void> {
  if (draining) return;
  const entries0 = read();
  if (entries0.length === 0) return;

  draining = true;
  dispatchStatus("draining", entries0.length);

  try {
    // Refresh from storage each iteration so newly enqueued ops join the run.
    let entries = entries0;
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      const result = await runOp(entry.op);
      // Re-read in case the user enqueued more rows while we were awaiting.
      entries = read();
      const idx = entries.findIndex((e) => e.id === entry.id);

      if (result.ok) {
        if (idx >= 0) entries.splice(idx, 1);
        write(entries);
        dispatchOpStatus(entry.op, "saved");
        backoffMs = 2_000;
        continue;
      }
      if (result.permanent) {
        console.error("[pending-queue] dropping permanent failure", entry.op, result.message);
        if (idx >= 0) entries.splice(idx, 1);
        write(entries);
        dispatchOpStatus(entry.op, "failed", result.message);
        try {
          window.dispatchEvent(
            new CustomEvent("hdp:sync-error", {
              detail: {
                table: entry.op.logical || entry.op.table,
                op: entry.op.kind,
                ids: opIds(entry.op),
                message: result.message,
                permanent: true,
              },
            }),
          );
        } catch {}
        continue;
      }
      // Transient: bump tries, persist, stop this pass and back off.
      const bumped: Entry = { ...entry, tries: entry.tries + 1, lastError: result.message };
      if (idx >= 0) entries[idx] = bumped; else entries.push(bumped);
      write(entries);
      if (bumped.tries === MAX_TRIES_BEFORE_WARN) dispatchWarn(bumped);
      break;
    }

    const remaining = read();
    if (remaining.length === 0) {
      dispatchStatus("drained", 0);
      backoffMs = 2_000;
    } else {
      dispatchStatus("failed", remaining.length);
      // Schedule next attempt with exponential backoff capped at 30s.
      const next = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 30_000);
      scheduleRetry(next);
    }
  } finally {
    draining = false;
  }
}

/**
 * Repair queue entries persisted before we added `onConflict` for
 * `beam_materials`. Without this the drainer keeps replaying poisoned
 * inserts that unconditionally trip beam_materials_uniq (23505) and
 * spam "Save failed" toasts. Also drop entries whose lastError is a
 * duplicate-key — the row is already server-side.
 */
function repairPoisonedEntries() {
  const entries = read();
  if (entries.length === 0) return;
  let changed = false;
  const kept: Entry[] = [];
  for (const e of entries) {
    const lastErr = String((e as any).lastError || "");
    if (lastErr.includes("beam_materials_uniq") || lastErr.includes("duplicate key")) {
      changed = true;
      continue;
    }
    if (
      e.op.kind === "insert" &&
      e.op.table === "beam_materials" &&
      !e.op.onConflict
    ) {
      e.op = {
        ...e.op,
        onConflict: "transaction_id,route_card_no,part_no",
        ignoreDuplicates: true,
      };
      changed = true;
    }
    kept.push(e);
  }
  if (changed) write(kept);
}

/**
 * Wire the queue to resume/online events plus a background retry loop.
 * Call once at app startup.
 */
export function startQueueDrainer() {
  if (typeof window === "undefined") return () => {};
  repairPoisonedEntries();
  const onResume = () => {
    backoffMs = 2_000;
    void drainQueue();
  };
  window.addEventListener("hdp:resume", onResume);
  window.addEventListener("online", onResume);
  // Initial drain on boot (covers reload-after-freeze).
  void drainQueue();
  return () => {
    window.removeEventListener("hdp:resume", onResume);
    window.removeEventListener("online", onResume);
  };
}
