/**
 * Backdated beam entry (Admin) — Dipping module.
 *
 * Turns manually-typed local date-time strings into the exact set of beam
 * fields the rest of the app already understands, so a beam created for a
 * past date behaves like one processed live on that date.
 */

export type BackdateInput = {
  loaded_at?: string;        // datetime-local string
  immersion_start?: string;
  immersion_end?: string;
  reaction_end?: string;
  withdrawal_end?: string;
  bath_temperature?: string | number | null;
  dipping_operator?: string;
  shift_supervisor?: string;
  surface_condition?: string;
};

export type BackdateResult =
  | { ok: false; error: string }
  | { ok: true; status: "LOADED" | "DIPPING" | "QC_PENDING"; patch: Record<string, any> };

import { parseTzLocal } from "@/lib/tz";

/** Parse a `datetime-local` value as plant-local wall clock → UTC ISO. */
export function toIsoLocal(v?: string | null): string | null {
  return parseTzLocal(v);
}

export function diffSecs(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
  return d >= 0 ? Math.round(d) : null;
}

/**
 * Validates and builds the backdated beam payload.
 * `nowMs` is injectable so tests are deterministic.
 */
export function resolveBackdatedEntry(input: BackdateInput, nowMs: number = Date.now()): BackdateResult {
  const is = toIsoLocal(input.immersion_start);
  const ie = toIsoLocal(input.immersion_end);
  const re = toIsoLocal(input.reaction_end);
  const we = toIsoLocal(input.withdrawal_end);
  const la = toIsoLocal(input.loaded_at) || is;

  if (!is) return { ok: false, error: "Immersion Start is required for a backdated entry" };
  if (!la) return { ok: false, error: "Loaded date & time is invalid" };

  const labelled: Array<[string, string | null]> = [
    ["Loaded date & time", la],
    ["Immersion Start", is],
    ["Immersion End", ie],
    ["Reaction End", re],
    ["Withdrawal End", we],
  ];
  // 5 min grace so a slightly fast wall clock on the floor tablet never blocks
  // an entry the operator is typing "as of now".
  const futureLimit = nowMs + 5 * 60 * 1000;
  for (const [name, s] of labelled) {
    if (s && new Date(s).getTime() > futureLimit) {
      return { ok: false, error: `${name} is in the future — pick a past date & time` };
    }
  }
  const order = labelled.filter(([, v]) => v) as Array<[string, string]>;
  for (let i = 1; i < order.length; i++) {
    if (new Date(order[i][1]).getTime() < new Date(order[i - 1][1]).getTime()) {
      return {
        ok: false,
        error: `${order[i][0]} is earlier than ${order[i - 1][0]} — timestamps must run in order`,
      };
    }
  }

  const complete = Boolean(is && ie && re && we);
  const status: "DIPPING" | "QC_PENDING" = complete ? "QC_PENDING" : "DIPPING";

  const btRaw = input.bath_temperature;
  const bath =
    btRaw === "" || btRaw === null || btRaw === undefined ? null : Number(btRaw);
  if (bath !== null && !Number.isFinite(bath)) return { ok: false, error: "Zinc bath temperature is invalid" };

  return {
    ok: true,
    status,
    patch: {
      loaded_at: la,
      immersion_start: is,
      immersion_end: ie,
      reaction_end: re,
      withdrawal_end: we,
      immersion_duration: diffSecs(is, ie),
      reaction_duration: diffSecs(ie, re),
      withdrawal_duration: diffSecs(re, we),
      dipping_at: is,
      dipped_at: we || null,
      bath_temperature: bath,
      dipping_operator: input.dipping_operator?.trim() || null,
      shift_supervisor: input.shift_supervisor?.trim() || null,
      surface_condition: input.surface_condition || null,
      backdated: true,
    },
  };
}

/** Total cycle time (seconds) implied by the entered timestamps. */
export function backdatedCycleSecs(input: BackdateInput): number | null {
  return diffSecs(toIsoLocal(input.immersion_start), toIsoLocal(input.withdrawal_end));
}
