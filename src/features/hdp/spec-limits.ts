// Central specification limits used across ALL dashboards, SPC charts,
// Cp/Cpk / Sigma calculations, reports, alerts and AI recommendations.
// Single source of truth — do NOT hardcode LSL/USL anywhere else.

export type SpecLimit = { lsl: number; usl: number };

export const COATING_SPEC: Record<number, SpecLimit> = {
  65:  { lsl: 65,  usl: 75  },
  87:  { lsl: 87,  usl: 105 },
  130: { lsl: 130, usl: 145 },
};

export const TEMP_SPEC: SpecLimit = { lsl: 445, usl: 456 };

// Fallback for a non-standard coating requirement (should rarely trigger).
export const coatingSpec = (micron: number): SpecLimit =>
  COATING_SPEC[micron] ?? { lsl: micron, usl: micron + 10 };
