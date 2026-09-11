import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { enqueue as enqueuePending, drainQueue, pendingOpsForTable } from "@/lib/pending-queue";
import {
  BEAM_HOME_KEY,
  BEAM_READ_TABLES,
  LEGACY_BEAM_TABLE,
  nextBeamShardTable,
} from "@/features/hdp/beam-shards";

const WRITE_TIMEOUT_MS = 10_000;
const STALE_CHANNEL_MS = 45_000;
const PERIODIC_RECONCILE_MS = 60_000;

/**
 * Pure merge used by reconcile(): overlay a server snapshot with locally
 * pending writes so an in-flight optimistic change is never clobbered by a
 * stale snapshot. Exported for unit tests.
 */
export type DirtyKind = "insert" | "update" | "delete";
export function mergeWithDirty<T>(opts: {
  server: T[];
  local: T[];
  dirty: Map<unknown, { kind: DirtyKind; at: number; token?: number }>;
  idOf: (row: T) => unknown;
}): T[] {
  const { server, local, dirty, idOf } = opts;
  const localById = new Map(local.map((x) => [idOf(x), x]));
  const serverIds = new Set(server.map((x) => idOf(x)));
  const out: T[] = [];
  for (const row of server) {
    const id = idOf(row);
    const d = dirty.get(id);
    if (d?.kind === "delete") continue;
    if (d?.kind === "update") {
      out.push((localById.get(id) ?? row) as T);
    } else {
      out.push(row);
    }
  }
  for (const [id, d] of dirty) {
    if (d.kind !== "insert") continue;
    if (serverIds.has(id)) continue;
    const local = localById.get(id);
    if (local) out.push(local);
  }
  return out;
}

function pendingIdsForTable(table: string): Set<string> {
  const ids = new Set<string>();
  try {
    for (const op of pendingOpsForTable(table)) {
      if (op.kind === "insert") {
        (op.rows || []).forEach((r: any) => ids.add(String(r?.[op.rowIdKey])));
      } else if (op.kind === "update") {
        ids.add(String(op.id));
      } else if (op.kind === "upsert") {
        ids.add(String(op.row?.[op.rowIdKey]));
      } else if (op.kind === "delete") {
        (op.ids || []).forEach((id: unknown) => ids.add(String(id)));
      }
    }
  } catch {}
  ids.delete("undefined");
  ids.delete("null");
  return ids;
}


function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Cached current user id, refreshed via auth state changes, used for RLS attribution.
let _currentUid: string | null = null;
if (typeof window !== "undefined") {
  supabase.auth.getSession().then(({ data }) => {
    _currentUid = data.session?.user?.id ?? null;
  });
  supabase.auth.onAuthStateChange((_e, session) => {
    _currentUid = session?.user?.id ?? null;
  });
}
export function getCurrentUid() {
  return _currentUid;
}

export function setCurrentUid(uid: string | null) {
  _currentUid = uid;
}

/**
 * Generic table sync hook. Subscribes to realtime postgres_changes on the
 * given table(s) and mirrors local array writes back to Supabase.
 *
 * Items are application-shaped; rows are DB-shaped. The two map fns convert.
 *
 * Multi-table mode: pass `readTables` (physical tables read + subscribed as one
 * logical stream) together with `homeKey` (item field holding the physical
 * table a row came from) and `pickInsertTable` (chooses the destination for a
 * brand-new row). Updates and deletes are routed back to each row's home
 * table, so nothing ever moves between tables.
 */
export function useSyncedTable<Item, Row>(opts: {
  table: string;
  idKey: keyof Item;
  rowIdKey: keyof Row;
  rowToItem: (row: Row) => Item;
  itemToRow: (item: Item) => Row;
  enabled: boolean;
  orderBy?: { column: string; ascending?: boolean };
  initialSort?: (a: Item, b: Item) => number;
  onConflict?: string;
  readTables?: string[];
  homeKey?: string;
  pickInsertTable?: (row: Row) => Promise<string> | string;
}) {
  const { table, idKey, rowIdKey, rowToItem, itemToRow, enabled, orderBy, initialSort, onConflict, homeKey, pickInsertTable } = opts;
  const readTables = opts.readTables && opts.readTables.length ? opts.readTables : [table];
  const readTablesKey = readTables.join(",");
  const tagHome = (item: Item, physical: string): Item =>
    homeKey ? ({ ...(item as any), [homeKey]: physical } as Item) : item;
  const homeOf = (item: Item | undefined): string =>
    (homeKey && item ? ((item as any)[homeKey] as string) : "") || table;
  const [items, setItems] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(false);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  // Dirty-row ledger: rows the user just wrote whose Supabase write hasn't
  // confirmed yet. Reconcile / realtime DELETE handlers respect this so a
  // stale server snapshot can't clobber the optimistic local state.
  const dirtyRef = useRef<Map<unknown, { kind: "insert"|"update"|"delete"; at: number; token?: number }>>(new Map());
  const dirtySeqRef = useRef(0);
  const DIRTY_TTL_MS = 90_000;
  const markDirty = (id: unknown, kind: "insert"|"update"|"delete") => {
    const token = ++dirtySeqRef.current;
    dirtyRef.current.set(id, { kind, at: Date.now(), token });
    return token;
  };
  const clearDirty = (id: unknown) => { dirtyRef.current.delete(id); };
  const clearDirtyIf = (id: unknown, token?: number) => {
    if (token == null) {
      clearDirty(id);
      return;
    }
    if (dirtyRef.current.get(id)?.token === token) clearDirty(id);
  };
  const pruneDirty = (m: Map<unknown, { kind: string; at: number }>) => {
    const now = Date.now();
    const pendingIds = pendingIdsForTable(table);
    for (const [k, v] of m) {
      if (pendingIds.has(String(k))) continue;
      if (now - v.at > DIRTY_TTL_MS) m.delete(k);
    }
  };

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let backoff = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let periodicTimer: ReturnType<typeof setInterval> | null = null;
    let lastActivity = Date.now();

    const applyPendingOpsToLocal = (ops: ReturnType<typeof pendingOpsForTable>) => {
      if (!ops.length) return;
      setItems((prev) => {
        let next = [...prev];
        const upsertLocal = (row: any, physical: string) => {
          if (!row) return;
          const item = tagHome(rowToItem(row as Row), physical);
          const id = item[idKey] as unknown;
          const i = next.findIndex((x) => (x[idKey] as unknown) === id);
          if (i >= 0) next[i] = { ...next[i], ...item };
          else next.unshift(item);
        };
        for (const op of ops) {
          if (op.kind === "insert") {
            (op.rows || []).forEach((r: any) => upsertLocal(r, op.table));
          } else if (op.kind === "update") {
            upsertLocal(op.row, op.table);
          } else if (op.kind === "upsert") {
            upsertLocal(op.row, op.table);
          } else if (op.kind === "delete") {
            const ids = new Set((op.ids || []).map(String));
            next = next.filter((x) => !ids.has(String(x[idKey] as unknown)));
          }
        }
        if (initialSort) next.sort(initialSort);
        return next;
      });
    };

    const markPendingQueueDirty = () => {
      try {
        const ops = pendingOpsForTable(table);
        for (const op of ops) {
          if (op.kind === "insert") {
            (op.rows || []).forEach((r: any) => markDirty(r?.[rowIdKey as string], "insert"));
          } else if (op.kind === "update") {
            markDirty(op.id, "update");
          } else if (op.kind === "upsert") {
            markDirty(op.row?.[op.rowIdKey], "update");
          } else if (op.kind === "delete") {
            (op.ids || []).forEach((id: unknown) => markDirty(id, "delete"));
          }
        }
        applyPendingOpsToLocal(ops);
      } catch {}
    };

    const reconcile = async () => {
      try {
        const results = await Promise.all(
          readTables.map(async (t) => {
            let q = (supabase as any).from(t).select("*");
            if (orderBy) q = q.order(orderBy.column, { ascending: orderBy.ascending ?? true });
            const res = (await withTimeout(q, WRITE_TIMEOUT_MS, `reconcile ${t}`)) as any;
            return { t, data: res?.data, error: res?.error };
          }),
        );
        if (!alive) return;
        const failed = results.filter((r) => r.error);
        if (failed.length === results.length) {
          console.error(`[sync:${table}] reconcile failed`, failed[0]?.error);
          setLoaded(true);
          return;
        }
        for (const f of failed) console.error(`[sync:${table}] reconcile failed on ${f.t}`, f.error);
        lastActivity = Date.now();

        // Merge all physical tables into one logical list, tagging each row
        // with its home table. Duplicate ids (should not happen) resolve to
        // the most recently updated row.
        const byId = new Map<unknown, { item: Item; at: number }>();
        for (const { t, data } of results) {
          for (const r of data ?? []) {
            const item = tagHome(rowToItem(r as Row), t);
            const id = item[idKey] as unknown;
            const at = Date.parse((r as any)?.updated_at ?? "") || 0;
            const prev = byId.get(id);
            if (!prev || at >= prev.at) byId.set(id, { item, at });
          }
        }
        const mapped = Array.from(byId.values()).map((x) => x.item);
        if (initialSort) mapped.sort(initialSort);
        // Dirty-row guard: don't clobber optimistic local writes that haven't
        // confirmed yet. Reset, phase-tap, save, and Loading insert all pass
        // through here; without this, a periodic reconcile snaps the row
        // back to the stale server state.
        pruneDirty(dirtyRef.current);
        const merged = mergeWithDirty<Item>({
          server: mapped as Item[],
          local: itemsRef.current,
          dirty: dirtyRef.current,
          idOf: (x) => x[idKey] as unknown,
        });
        if (initialSort) merged.sort(initialSort);
        setItems(merged);
        setLoaded(true);
      } catch (err) {
        if (!alive) return;
        console.warn(`[sync:${table}] reconcile error`, err);
        setLoaded(true);
      }
    };

    const dispatchStatus = (status: string) => {
      if (typeof window === "undefined") return;
      try {
        window.dispatchEvent(
          new CustomEvent("hdp:sync-status", { detail: { table, status } }),
        );
      } catch {}
    };

    // Tracks channels currently being torn down so the subscribe callback
    // doesn't recurse into teardown when removeChannel fires a synchronous
    // CLOSED event (which was blowing the call stack).
    const tearingDown = new WeakSet<object>();
    const teardownChannel = () => {
      const ch = channel;
      if (!ch) return;
      channel = null;
      tearingDown.add(ch as unknown as object);
      try { supabase.removeChannel(ch); } catch {}
    };

    const connect = () => {
      if (!alive) return;
      teardownChannel();
      // One channel, one binding per physical table. The topic keeps the
      // logical table name so realtime topic authorization stays unchanged.
      const base = supabase.channel(`sync:${table}:${Math.random().toString(36).slice(2, 8)}`);
      const myChannel = readTables.reduce(
        (ch: any, physical: string) =>
          ch.on(
            "postgres_changes",
            { event: "*", schema: "public", table: physical },
            (payload: any) => {
              lastActivity = Date.now();
              pruneDirty(dirtyRef.current);
              setItems((prev) => {
                if (payload.eventType === "DELETE") {
                  const oldId = (payload.old as Row)[rowIdKey];
                  // Ignore a stray DELETE for a row we just re-inserted locally.
                  const d = dirtyRef.current.get(oldId as unknown);
                  if (d && d.kind === "insert") return prev;
                  return prev.filter((x) => (x[idKey] as unknown) !== (oldId as unknown));
                }
                const item = tagHome(rowToItem(payload.new as Row), physical);
                const id = item[idKey] as unknown;
                const d = dirtyRef.current.get(id);
                // Don't overwrite a locally pending update with a stale server row.
                if (d && d.kind === "update") return prev;
                const i = prev.findIndex(
                  (x) => (x[idKey] as unknown) === id,
                );
                if (i >= 0) {
                  const next = prev.slice();
                  next[i] = item;
                  return next;
                }
                return [item, ...prev];
              });
            },
          ),
        base as any,
      )
        .subscribe((status: string) => {
          if (!alive) return;
          // If this callback fires for a channel we're already tearing down
          // (removeChannel triggers a synchronous CLOSED), ignore it —
          // otherwise we recurse into teardownChannel → removeChannel → ...
          if (tearingDown.has(myChannel as unknown as object)) return;
          // A stale channel from a previous connect() cycle should also
          // stop influencing state after we've moved on.
          if (channel !== myChannel) return;
          if (status === "SUBSCRIBED") {
            backoff = 1000;
            lastActivity = Date.now();
            dispatchStatus("connected");
            reconcile();
            // Channel is back — flush anything that queued while offline.
            void drainQueue();
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            dispatchStatus("reconnecting");
            teardownChannel();
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, backoff);
            backoff = Math.min(backoff * 2, 8000);
          }
        });
      channel = myChannel;
    };

    connect();

    // Stale-channel watchdog: half-open sockets (cell handoff, lock-screen,
    // NAT timeout) still report SUBSCRIBED but deliver no events. If no
    // activity in 45s while visible, force-reconnect.
    watchdogTimer = setInterval(() => {
      if (!alive) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (Date.now() - lastActivity < STALE_CHANNEL_MS) return;
      dispatchStatus("reconnecting");
      connect();
    }, 15_000);

    // Periodic safety reconcile so the operator's view stays authoritative
    // even if a realtime event was dropped silently.
    periodicTimer = setInterval(() => {
      if (!alive) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      reconcile();
    }, PERIODIC_RECONCILE_MS);

    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        markPendingQueueDirty();
        reconcile();
      }
    };
    const onOnline = () => { markPendingQueueDirty(); reconcile(); };
    const onResumeEvt = () => { markPendingQueueDirty(); reconcile(); };
    const onSyncStatus = (ev: any) => {
      const d = ev?.detail || {};
      if (d.table !== table) return;
      const ids = Array.isArray(d.ids) ? d.ids : [];
      if (d.status === "saved") {
        if (d.tokens) ids.forEach((id: unknown) => clearDirtyIf(id, d.tokens?.[String(id)]));
        void reconcile();
      } else if (d.status === "failed") {
        // Do NOT clear the dirty ledger on failure — the write did not
        // reach the server, and clearing here lets the next reconcile
        // silently wipe the operator's just-entered row. Leave the entry
        // so mergeWithDirty keeps it visible until the ledger TTL expires
        // or the operator explicitly retries / edits.
        void reconcile();
      } else if (d.status === "queued") {
        const kind = d.op === "insert" ? "insert" : d.op === "delete" ? "delete" : "update";
        ids.forEach((id: unknown) => markDirty(id, kind));
      }
    };
    if (typeof window !== "undefined") {
      markPendingQueueDirty();
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("online", onOnline);
      window.addEventListener("hdp:resume", onResumeEvt);
      window.addEventListener("hdp:sync-status", onSyncStatus as any);
    }

    return () => {
      alive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (periodicTimer) clearInterval(periodicTimer);
      teardownChannel();
      if (typeof window !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("online", onOnline);
        window.removeEventListener("hdp:resume", onResumeEvt);
        window.removeEventListener("hdp:sync-status", onSyncStatus as any);
      }
    };
  }, [enabled, table, readTablesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = useCallback(
    (updater: Item[] | ((prev: Item[]) => Item[])) => {
      const prev = itemsRef.current;
      const next = typeof updater === "function" ? (updater as any)(prev) : updater;
      setItems(next);

      const prevById = new Map(prev.map((x) => [x[idKey] as unknown, x]));
      const nextById = new Map(next.map((x: Item) => [x[idKey] as unknown, x]));
      const inserts: Row[] = [];
      const updates: { id: unknown; row: Row; home: string }[] = [];
      for (const [k, v] of nextById) {
        const old = prevById.get(k);
        if (!old) {
          inserts.push(itemToRow(v as Item));
        } else if (JSON.stringify(old) !== JSON.stringify(v)) {
          const home =
            (homeKey && ((v as any)?.[homeKey] || (old as any)?.[homeKey])) || table;
          updates.push({ id: k, row: itemToRow(v as Item), home });
        }
      }
      const deletes: { id: unknown; home: string }[] = [];
      for (const [k, oldItem] of prevById) if (!nextById.has(k)) deletes.push({ id: k, home: homeOf(oldItem as Item) });

      const sb: any = supabase;
      const reportError = (op: string, error: any) => {
        console.error(`[sync:${table}] ${op}`, error);
        if (typeof window !== "undefined") {
          try {
            const msg = String(error?.message || error || "");
            const status = Number(error?.status || error?.statusCode || 0);
            const code = String(error?.code || "");
            const transient =
              /failed to fetch|timed out|network|load failed|offline/i.test(msg) ||
              status === 0 || status === 408 || status === 429 || status >= 500 ||
              code === "" && !status;
            const friendly = transient
              ? `Saved locally — will sync when connection recovers (${op} ${table})`
              : `Save failed (${table} ${op}): ${msg}`;
            window.dispatchEvent(
              new CustomEvent("hdp:sync-error", {
                detail: { table, op, message: friendly, rawMessage: msg, transient },
              }),
            );
          } catch {}
        }
      };
      const reportSaved = (op: string, ids: unknown[], tokens: Record<string, number> = {}) => {
        if (typeof window === "undefined") return;
        try {
          window.dispatchEvent(
            new CustomEvent("hdp:sync-status", {
              detail: { table, op, status: "saved", ids, tokens },
            }),
          );
        } catch {}
      };
      const kickDrain = () => {
        // Nudge the queue so the retry happens immediately rather than
        // waiting for the OS to fire `online` / `visibilitychange`.
        setTimeout(() => { void drainQueue(); }, 1_000);
      };

      // Always run the write — don't trust navigator.onLine, which lies on
      // mobile (captive portals, weak cell, Wi-Fi associated but no internet).
      // On any failure or timeout, enqueue durably and kick the drainer.
      if (inserts.length) {
        const runInsert = (targetTable: string, rows: Row[]) => {
          const opPayload = {
            kind: "insert" as const,
            table: targetTable,
            logical: table,
            rowIdKey: rowIdKey as string,
            rows,
            ...(onConflict ? { onConflict, ignoreDuplicates: true } : {}),
          };
          const insertedIds = rows.map((r: any) => r[rowIdKey as string]);
          const tokens: Record<string, number> = {};
          insertedIds.forEach((id: unknown) => { tokens[String(id)] = markDirty(id, "insert"); });
          const insertPromise = onConflict
            ? sb.from(targetTable).upsert(rows as any, { onConflict, ignoreDuplicates: true })
            : sb.from(targetTable).insert(rows as any);
          withTimeout(insertPromise, WRITE_TIMEOUT_MS, `insert ${targetTable}`)
            .then(({ error }: any) => {
              if (error) {
                // 23505 with onConflict shouldn't happen, but be defensive.
                if (String(error?.code || "") === "23505") {
                  insertedIds.forEach((id: unknown) => clearDirtyIf(id, tokens[String(id)]));
                  reportSaved("insert", insertedIds, tokens);
                  return;
                }
                reportError("insert", error);
                enqueuePending(opPayload);
                kickDrain();
              } else {
                insertedIds.forEach((id: unknown) => clearDirtyIf(id, tokens[String(id)]));
                reportSaved("insert", insertedIds, tokens);
              }
            })
            .catch((err: any) => {
              reportError("insert", err);
              enqueuePending(opPayload);
              kickDrain();
            });
        };

        if (!pickInsertTable) {
          runInsert(table, inserts);
        } else {
          // Resolve each new row's destination table (round-robin), then group
          // so rows landing in the same table share one request.
          void (async () => {
            const byTable = new Map<string, Row[]>();
            for (const row of inserts) {
              const id = (row as any)[rowIdKey as string];
              const existing = nextById.get(id as unknown) as any;
              let target = (homeKey && existing?.[homeKey]) as string | undefined;
              if (!target) {
                try {
                  target = await pickInsertTable(row);
                } catch {
                  target = undefined;
                }
              }
              const t = target || table;
              // Remember the home table locally so later edits route correctly.
              if (homeKey) {
                setItems((prevItems) =>
                  prevItems.map((x) =>
                    (x[idKey] as unknown) === (id as unknown)
                      ? ({ ...(x as any), [homeKey]: t } as Item)
                      : x,
                  ),
                );
              }
              const arr = byTable.get(t);
              if (arr) arr.push(row); else byTable.set(t, [row]);
            }
            for (const [t, rows] of byTable) runInsert(t, rows);
          })();
        }
      }
      // Per-row update (not upsert) so we never re-INSERT an existing beam
      // and trip the strict INSERT RLS for Dipping/QC roles.
      for (const u of updates) {
        const targetTable = u.home || table;
        const opPayload = { kind: "update" as const, table: targetTable, logical: table, rowIdKey: rowIdKey as string, id: u.id, row: u.row };
        const token = markDirty(u.id, "update");
        withTimeout(
          sb.from(targetTable).update(u.row as any).eq(rowIdKey as string, u.id as any),
          WRITE_TIMEOUT_MS,
          `update ${targetTable}`,
        )
          .then(({ error }: any) => {
            if (error) {
              reportError("update", error);
              enqueuePending(opPayload);
              kickDrain();
            } else {
              clearDirtyIf(u.id, token);
              reportSaved("update", [u.id], { [String(u.id)]: token });
            }
          })
          .catch((err: any) => {
            reportError("update", err);
            enqueuePending(opPayload);
            kickDrain();
          });
      }
      if (deletes.length) {
        // Route each delete back to the table the row actually lives in.
        const byTable = new Map<string, unknown[]>();
        for (const d of deletes) {
          const t = d.home || table;
          const arr = byTable.get(t);
          if (arr) arr.push(d.id); else byTable.set(t, [d.id]);
        }
        for (const [targetTable, ids] of byTable) {
          const opPayload = { kind: "delete" as const, table: targetTable, logical: table, rowIdKey: rowIdKey as string, ids };
          const tokens: Record<string, number> = {};
          ids.forEach((id) => { tokens[String(id)] = markDirty(id, "delete"); });
          withTimeout(
            sb.from(targetTable).delete().in(rowIdKey as string, ids as any),
            WRITE_TIMEOUT_MS,
            `delete ${targetTable}`,
          )
            .then(({ error }: any) => {
              if (error) {
                reportError("delete", error);
                enqueuePending(opPayload);
                kickDrain();
              } else {
                ids.forEach((id) => clearDirtyIf(id, tokens[String(id)]));
                reportSaved("delete", ids, tokens);
              }
            })
            .catch((err: any) => {
              reportError("delete", err);
              enqueuePending(opPayload);
              kickDrain();
            });
        }
      }
    },
    [table], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return [items, set, loaded] as const;
}


// ── Admin micron rules hook (prefix + thickness range → micron) ────────────
export type MicronRuleItem = {
  id: string;
  prefix: string;
  thickness_min: number;
  thickness_max: number | null;
  coating_required: number;
  local_coating_required?: number | null;
  active: boolean;
  updated_by?: string | null;
  updated_by_name?: string | null;
};

export function useMicronRules(enabled: boolean) {
  return useSyncedTable<MicronRuleItem, any>({
    table: "micron_rules",
    idKey: "id",
    rowIdKey: "id",
    enabled,
    rowToItem: (r) => ({
      id: r.id,
      prefix: String(r.prefix || "").toUpperCase(),
      thickness_min: Number(r.thickness_min),
      thickness_max: r.thickness_max == null ? null : Number(r.thickness_max),
      coating_required: Number(r.coating_required),
      local_coating_required:
        r.local_coating_required == null ? null : Number(r.local_coating_required),
      active: !!r.active,
      updated_by: r.updated_by ?? null,
      updated_by_name: r.updated_by_name ?? null,
    }),
    itemToRow: (i) => ({
      id: i.id,
      prefix: String(i.prefix || "").toUpperCase(),
      thickness_min: i.thickness_min,
      thickness_max: i.thickness_max,
      coating_required: i.coating_required,
      local_coating_required: i.local_coating_required ?? null,
      active: !!i.active,
      updated_by: i.updated_by ?? getCurrentUid(),
      updated_by_name: i.updated_by_name ?? null,
    }),
  });
}




// ── App-specific item/row shapes ────────────────────────────────────────────

export type BeamItem = {
  transaction_id: string;
  beam_no: string;
  status: string;
  [k: string]: any;
};
export type BeamRow = {
  transaction_id: string;
  beam_no: string;
  status: string;
  material_type?: string | null;
  surface_condition?: string | null;
  is_enabled?: boolean;
  disabled_at?: string | null;
  disabled_by?: string | null;
  enabled_at?: string | null;
  enabled_by?: string | null;
  data: any;
  updated_at?: string;
  updated_by?: string | null;
};

export function useBeams(enabled: boolean) {
  return useSyncedTable<BeamItem, BeamRow>({
    table: LEGACY_BEAM_TABLE,
    idKey: "transaction_id",
    rowIdKey: "transaction_id",
    enabled,
    // Read/subscribe across the legacy table plus the five rotation tables.
    readTables: BEAM_READ_TABLES,
    homeKey: BEAM_HOME_KEY,
    // New beams never go to `beams` — round-robin across new_beams_1..5.
    pickInsertTable: (row) => nextBeamShardTable(String(row?.transaction_id || row?.beam_no || "")),
    rowToItem: (r) => {
      const data = r.data || {};
      // Operational enable/disable flag. Column wins; legacy `disabled` inside
      // the jsonb payload is honoured so older records keep their state.
      const isEnabled =
        r.is_enabled != null ? !!r.is_enabled : data.disabled === true ? false : true;
      return {
        transaction_id: r.transaction_id || r.beam_no,
        beam_no: r.beam_no,
        status: r.status,
        ...data,
        material_type: r.material_type ?? data.material_type ?? null,
        surface_condition: r.surface_condition ?? data.surface_condition ?? null,
        is_enabled: isEnabled,
        disabled_at: r.disabled_at ?? null,
        disabled_by: r.disabled_by ?? null,
        enabled_at: r.enabled_at ?? null,
        enabled_by: r.enabled_by ?? null,
      };
    },
    itemToRow: (i) => {
      // `__src` is the in-memory home-table marker — never persist it.
      const {
        transaction_id, beam_no, status, material_type, surface_condition,
        is_enabled, disabled_at, disabled_by, enabled_at, enabled_by,
        [BEAM_HOME_KEY]: _home, ...rest
      } = i as any;
      return {
        transaction_id: transaction_id || beam_no,
        beam_no,
        status,
        material_type: material_type ?? null,
        surface_condition: surface_condition ?? null,
        is_enabled: is_enabled === false ? false : true,
        disabled_at: disabled_at ?? null,
        disabled_by: disabled_by ?? null,
        enabled_at: enabled_at ?? null,
        enabled_by: enabled_by ?? null,
        data: rest,
        updated_by: getCurrentUid(),
      };
    },
  });
}



// ── Beam materials hook: one row per material (route card / part) offered to QC ─────
export type BeamMaterialItem = {
  id: string;
  transaction_id: string;
  beam_no: string;
  route_card_no: string | null;
  part_no: string | null;
  quantity: number | null;
  coating_spec: string | null;
  qc_status: "OFFERED" | "ACCEPTED" | "REJECTED" | "DISPUTE";
  defect_type: string | null;
  defect_remark: string | null;
  offered_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
};

export function useBeamMaterials(enabled: boolean) {
  return useSyncedTable<BeamMaterialItem, any>({
    table: "beam_materials",
    idKey: "id",
    rowIdKey: "id",
    enabled,
    onConflict: "transaction_id,route_card_no,part_no",
    orderBy: { column: "offered_at", ascending: false },
    rowToItem: (r) => ({
      id: r.id,
      transaction_id: r.transaction_id,
      beam_no: r.beam_no,
      route_card_no: r.route_card_no,
      part_no: r.part_no,
      quantity: r.quantity,
      coating_spec: r.coating_spec,
      qc_status: r.qc_status,
      defect_type: r.defect_type,
      defect_remark: r.defect_remark,
      offered_at: r.offered_at,
      decided_at: r.decided_at,
      decided_by: r.decided_by,
      decided_by_name: r.decided_by_name,
    }),
    itemToRow: (i) => ({
      id: i.id,
      transaction_id: i.transaction_id,
      beam_no: i.beam_no,
      route_card_no: i.route_card_no,
      part_no: i.part_no,
      quantity: i.quantity,
      coating_spec: i.coating_spec,
      qc_status: i.qc_status,
      defect_type: i.defect_type,
      defect_remark: i.defect_remark,
      offered_at: i.offered_at,
      decided_at: i.decided_at,
      decided_by: i.decided_by,
      decided_by_name: i.decided_by_name,
    }),
  });
}

// (Removed legacy usePartPrefixMicron hook — Admin Micron Mapping Rules
// (`micron_rules`) is now the sole source of auto-selected micron values.)


export type AuditItem = {
  id: string;
  userId?: any;
  userName?: string;
  action?: string;
  module?: string;
  details?: string;
  timestamp?: string;
  [k: string]: any;
};

export function useAudit(enabled: boolean) {
  return useSyncedTable<AuditItem, { id: string; data: any; user_id?: string | null; created_at?: string }>({
    table: "audit_log",
    idKey: "id",
    rowIdKey: "id",
    enabled,
    orderBy: { column: "created_at", ascending: false },
    initialSort: (a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""),
    rowToItem: (r) => ({ id: r.id, ...(r.data || {}) }),
    itemToRow: (i) => {
      const { id, ...rest } = i;
      // Bind audit entry to the actual signed-in user (RLS enforces user_id = auth.uid())
      return { id, data: rest, user_id: getCurrentUid() };
    },
  });
}

// ── Users hook: read-only sync of profiles+roles into app's user shape ─────

export type UserItem = {
  id: string; // uuid
  username: string;
  email: string;
  full_name: string;
  role: string;
  active: boolean;
  created_at: string;
  password?: string; // never read; placeholder for UI
};

export function useUsers(enabled: boolean) {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const [{ data: profiles }, { data: roles }] = await Promise.all([
      supabase.from("profiles").select("*"),
      supabase.from("user_roles").select("*"),
    ]);
    const roleByUser = new Map<string, string>();
    (roles ?? []).forEach((r: any) => roleByUser.set(r.user_id, r.role));
    setUsers(
      (profiles ?? []).map((p: any) => ({
        id: p.id,
        username: p.username || p.email,
        email: p.email,
        full_name: p.full_name || p.email,
        role: roleByUser.get(p.id) || "supervisor",
        active: p.active,
        created_at: p.created_at,
      })),
    );
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const ch = supabase
      .channel("sync:users")
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => refresh())
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "user_roles" },
        () => refresh(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [enabled, refresh]);

  return [users, refresh, loaded] as const;
}

/**
 * Cloud-synced single setting backed by public.app_settings (key -> jsonb value).
 * - Loads the initial value from cloud (falls back to `initial` if no row exists).
 * - Subscribes to realtime updates so changes by admin on one device propagate to all others.
 * - When the caller updates the value, writes back to cloud (RLS allows only admins).
 *
 * The setter has the same signature as React.useState's setter (value or updater fn).
 */
export function useCloudSetting<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const valueRef = useRef<T>(initial);
  valueRef.current = value;
  const hydrated = useRef(false);
  // Timestamp of our most recent write — used to ignore realtime echoes for
  // a short window so a slow server round-trip doesn't snap the toggle back.
  const writingUntil = useRef<number>(0);

  // Initial load + realtime subscription
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await (supabase as any)
        .from("app_settings")
        .select("value")
        .eq("key", key)
        .maybeSingle();
      if (!alive) return;
      if (!error && data && data.value !== undefined && data.value !== null) {
        const cloudVal = data.value as any;
        const isPlainObj = (x: any) =>
          x !== null && typeof x === "object" && !Array.isArray(x);
        if (isPlainObj(initial) && isPlainObj(cloudVal)) {
          setValue({ ...(initial as any), ...cloudVal } as T);
        } else {
          setValue(cloudVal as T);
        }
      }
      hydrated.current = true;
      setLoaded(true);
    })();

    const ch = supabase
      .channel(`settings:${key}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "app_settings", filter: `key=eq.${key}` },
        (payload: any) => {
          // Ignore echoes of our own write for up to 3s.
          if (Date.now() < writingUntil.current) return;
          if (payload.eventType === "DELETE") return;
          const next = payload.new?.value;
          if (next !== undefined) setValue(next as T);
        },
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(ch);
    };
  }, [key]);

  const set = useCallback(
    (updater: T | ((prev: T) => T)) => {
      const prev = valueRef.current;
      const next =
        typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
      setValue(next);

      const row = {
        key,
        value: next as any,
        updated_by: _currentUid,
        updated_at: new Date().toISOString(),
      };

      const doWrite = () => {
        writingUntil.current = Date.now() + 3_000;
        withTimeout(
          (supabase as any)
            .from("app_settings")
            .upsert(row, { onConflict: "key" }),
          WRITE_TIMEOUT_MS,
          `settings ${key}`,
        )
          .then(({ error }: any) => {
            if (error) {
              console.error(`[settings:${key}] write failed`, error.message);
              // Permanent RLS denials are worth surfacing to the user
              // immediately; transient failures go to the durable queue
              // and retry automatically on reconnect.
              const code = String(error?.code || "");
              const status = Number(error?.status || 0);
              const permanent =
                code === "42501" ||
                (status >= 400 && status < 500 && status !== 408 && status !== 429);
              if (permanent) {
                if (typeof window !== "undefined") {
                  try {
                    window.dispatchEvent(
                      new CustomEvent("hdp:settings-write-error", {
                        detail: { key, message: error.message, permanent: true },
                      }),
                    );
                  } catch {}
                }
              } else {
                enqueuePending({
                  kind: "upsert",
                  table: "app_settings",
                  rowIdKey: "key",
                  row,
                });
                setTimeout(() => { void drainQueue(); }, 1_000);
              }
            }
          })
          .catch((err: any) => {
            console.warn(`[settings:${key}] write timed out`, err?.message);
            enqueuePending({
              kind: "upsert",
              table: "app_settings",
              rowIdKey: "key",
              row,
            });
            setTimeout(() => { void drainQueue(); }, 1_000);
          });
      };
      if (hydrated.current) doWrite();
      else setTimeout(doWrite, 50);
    },
    [key],
  );

  return [value, set, loaded] as const;
}

