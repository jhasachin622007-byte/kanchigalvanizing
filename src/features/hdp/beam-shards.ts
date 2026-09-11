import { supabase } from "@/integrations/supabase/client";

/**
 * Beam storage is spread across six physical tables:
 *  - `beams`           legacy/historical rows. Still fully readable, editable
 *                      and deletable, but never receives a brand-new beam.
 *  - `new_beams_1..5`  every newly created beam, distributed round-robin.
 *
 * The app treats all six as one logical "beams" stream. Each item carries a
 * hidden `__src` marker naming its home table so edits and deletes route back
 * to the exact table the row lives in.
 */

export const LEGACY_BEAM_TABLE = "beams";
export const SHARD_COUNT = 5;
export const NEW_BEAM_TABLES = Array.from(
  { length: SHARD_COUNT },
  (_, i) => `new_beams_${i + 1}`,
);
/** Read order: legacy first, then the rotation tables. */
export const BEAM_READ_TABLES = [LEGACY_BEAM_TABLE, ...NEW_BEAM_TABLES];
/** Field on a beam item holding its home (physical) table. */
export const BEAM_HOME_KEY = "__src";

export function shardTableForIndex(n: number): string {
  const i = ((Math.trunc(n) - 1) % SHARD_COUNT + SHARD_COUNT) % SHARD_COUNT;
  return NEW_BEAM_TABLES[i];
}

/**
 * Offline / fallback slot: derived deterministically from the transaction id so
 * the same beam always resolves to the same table, even across retries.
 */
export function fallbackShardTableForId(id: string): string {
  const s = String(id ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return NEW_BEAM_TABLES[h % SHARD_COUNT];
}

/**
 * Ask the database for the next rotation slot (shared counter, so two devices
 * never land on the same table). Falls back to the id-derived slot when the
 * call fails (offline, transient error).
 */
export async function nextBeamShardTable(id: string): Promise<string> {
  try {
    const { data, error } = await (supabase as any).rpc("next_beam_shard");
    const n = Number(data);
    if (error || !Number.isFinite(n) || n < 1) return fallbackShardTableForId(id);
    return shardTableForIndex(n);
  } catch {
    return fallbackShardTableForId(id);
  }
}
