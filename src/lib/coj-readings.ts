// Coating-on-Job reading helpers.
//
// New records use a 30-point layout — First / Middle / Last Withdrawal ×
// (Outside, Inside) × 5 readings — stored on the beam as `elcometer_v2`.
// Legacy records keep the 7-point `elcometer` array. All UI branches on
// `isV2(beam)`; nothing is migrated in place.

export type FiveReadings = [number, number, number, number, number] | number[];

export interface ElcometerV2 {
  fw: { out: number[]; in: number[] };
  mw: { out: number[]; in: number[] };
  lw: { out: number[]; in: number[] };
}

export const V2_GROUPS = [
  { key: "fw", label: "First Withdrawal (FW)" },
  { key: "mw", label: "Middle Withdrawal (MW)" },
  { key: "lw", label: "Last Withdrawal (LW)" },
] as const;

export const V2_SIDES = [
  { key: "out", label: "Outside" },
  { key: "in", label: "Inside" },
] as const;

export const V2_SUB_KEYS = [
  { g: "fw", s: "out", label: "FW Upper Average" },
  { g: "fw", s: "in", label: "FW Inside Average" },
  { g: "mw", s: "out", label: "MW Upper Average" },
  { g: "mw", s: "in", label: "MW Inside Average" },
  { g: "lw", s: "out", label: "LW Upper Average" },
  { g: "lw", s: "in", label: "LW Lower Average" },
] as const;


export function emptyV2(): ElcometerV2 {
  return {
    fw: { out: [], in: [] },
    mw: { out: [], in: [] },
    lw: { out: [], in: [] },
  };
}

export function emptyV2Strings(): Record<string, string[]> {
  return {
    fw_out: ["", "", "", "", ""],
    fw_in: ["", "", "", "", ""],
    mw_out: ["", "", "", "", ""],
    mw_in: ["", "", "", "", ""],
    lw_out: ["", "", "", "", ""],
    lw_in: ["", "", "", "", ""],
  };
}

export function isV2(beam: any): boolean {
  const v = beam?.elcometer_v2;
  if (!v || typeof v !== "object") return false;
  return ["fw", "mw", "lw"].every(
    (g) => v[g] && Array.isArray(v[g].out) && Array.isArray(v[g].in),
  );
}

function safeArr(a: any): number[] {
  return Array.isArray(a) ? a.map((n: any) => Number(n)).filter((n) => Number.isFinite(n)) : [];
}

function avg(nums: number[]): number | null {
  const arr = nums.filter((n) => Number.isFinite(n));
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function subAverages(v2: ElcometerV2): {
  fwOut: number | null; fwIn: number | null;
  mwOut: number | null; mwIn: number | null;
  lwOut: number | null; lwIn: number | null;
} {
  return {
    fwOut: avg(safeArr(v2?.fw?.out)),
    fwIn: avg(safeArr(v2?.fw?.in)),
    mwOut: avg(safeArr(v2?.mw?.out)),
    mwIn: avg(safeArr(v2?.mw?.in)),
    lwOut: avg(safeArr(v2?.lw?.out)),
    lwIn: avg(safeArr(v2?.lw?.in)),
  };
}

export function totalAverage(v2: ElcometerV2): number | null {
  // Official coating average: sum of all 30 individual readings / 30.
  // Never average the six sub-averages — see spec.
  const all = flatReadings(v2);
  if (all.length === 0) return null;
  return all.reduce((a, b) => a + b, 0) / all.length;
}


export function flatReadings(v2: ElcometerV2): number[] {
  return [
    ...safeArr(v2?.fw?.out), ...safeArr(v2?.fw?.in),
    ...safeArr(v2?.mw?.out), ...safeArr(v2?.mw?.in),
    ...safeArr(v2?.lw?.out), ...safeArr(v2?.lw?.in),
  ];
}

export function minMax(v2: ElcometerV2): { min: number | null; max: number | null } {
  const all = flatReadings(v2);
  if (all.length === 0) return { min: null, max: null };
  return { min: Math.min(...all), max: Math.max(...all) };
}

export function validateV2Strings(s: Record<string, string[]>): { ok: boolean; reason?: string } {
  const groups = ["fw_out", "fw_in", "mw_out", "mw_in", "lw_out", "lw_in"] as const;
  const labels: Record<string, string> = {
    fw_out: "FW Outside", fw_in: "FW Inside",
    mw_out: "MW Outside", mw_in: "MW Inside",
    lw_out: "LW Outside", lw_in: "LW Inside",
  };
  for (const g of groups) {
    const arr = s[g] || [];
    if (arr.length !== 5) return { ok: false, reason: `${labels[g]}: need 5 readings` };
    for (let i = 0; i < 5; i++) {
      const v = arr[i];
      if (v === "" || v == null) return { ok: false, reason: `${labels[g]} reading ${i + 1} missing` };
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: `${labels[g]} reading ${i + 1} must be > 0` };
    }
  }
  return { ok: true };
}

export function stringsToV2(s: Record<string, string[]>): ElcometerV2 {
  const toNums = (arr: string[]) => arr.map((v) => Number(v));
  return {
    fw: { out: toNums(s.fw_out || []), in: toNums(s.fw_in || []) },
    mw: { out: toNums(s.mw_out || []), in: toNums(s.mw_in || []) },
    lw: { out: toNums(s.lw_out || []), in: toNums(s.lw_in || []) },
  };
}

export function v2ToStrings(v2: ElcometerV2): Record<string, string[]> {
  const pad = (arr: any[]) => {
    const a = (arr || []).map((n) => (n == null ? "" : String(n)));
    while (a.length < 5) a.push("");
    return a.slice(0, 5);
  };
  return {
    fw_out: pad(v2?.fw?.out || []),
    fw_in: pad(v2?.fw?.in || []),
    mw_out: pad(v2?.mw?.out || []),
    mw_in: pad(v2?.mw?.in || []),
    lw_out: pad(v2?.lw?.out || []),
    lw_in: pad(v2?.lw?.in || []),
  };
}

export function overCapPoint(
  s: Record<string, string[]>,
  capMax: number,
): { group: string; idx: number } | null {
  const groups = ["fw_out", "fw_in", "mw_out", "mw_in", "lw_out", "lw_in"] as const;
  for (const g of groups) {
    const arr = s[g] || [];
    for (let i = 0; i < arr.length; i++) {
      const n = Number(arr[i]);
      if (Number.isFinite(n) && n > capMax) return { group: g, idx: i };
    }
  }
  return null;
}
