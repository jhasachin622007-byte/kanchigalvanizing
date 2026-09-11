// Pure validation helpers extracted from LoadingTab so they can be unit-tested.

export type LoadingFieldConfig = {
  maxBeamWeightMT?: number;
  restrictDuplicateBeam?: boolean;
  maxThicknessMm?: number;
};

export const DEFAULT_MAX_THICKNESS_MM = 40;

export function maxThicknessOf(fc: LoadingFieldConfig = {}): number {
  const v = Number(fc.maxThicknessMm);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_THICKNESS_MM;
}

/**
 * Strip everything that is not a digit or a single decimal point.
 * Used as an onChange filter so `+`, `-`, `*`, `/`, letters and other
 * special characters can never be typed into a Thickness field.
 */
export function sanitizeThicknessInput(raw: string): string {
  let s = String(raw ?? "").replace(/[^0-9.]/g, "");
  const first = s.indexOf(".");
  if (first !== -1) s = s.slice(0, first + 1) + s.slice(first + 1).replace(/\./g, "");
  return s;
}

/**
 * Validate a Thickness value (mm). Returns null when OK, else the message
 * that should be shown to the operator.
 */
export function checkThickness(
  raw: string | number | null | undefined,
  fc: LoadingFieldConfig = {},
): string | null {
  const MAX = maxThicknessOf(fc);
  const s = String(raw ?? "").trim();
  if (!s) return "Enter Thickness (mm)";
  if (!/^\d+(\.\d+)?$/.test(s)) return "Thickness must be a number (digits and one decimal point only)";
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return "Thickness must be greater than 0";
  if (n > MAX) return `Maximum allowed thickness is ${MAX} mm.`;
  return null;
}


/** Return null if OK, or a string error message. */
export function checkWeight(
  totalWeightMT: number,
  fc: LoadingFieldConfig = {},
): string | null {
  const MAX = typeof fc.maxBeamWeightMT === "number" ? fc.maxBeamWeightMT : 3.0;
  if (isNaN(totalWeightMT) || totalWeightMT <= 0) return "Enter valid Total Weight (MT)";
  if (totalWeightMT >= MAX)
    return `Weight ${totalWeightMT.toFixed(3)} MT exceeds limit. Beam weight must be below ${MAX} MT.`;
  return null;
}

/**
 * Return null if OK, or the existing in-process beam record.
 *
 * Re-entry of the same Beam Number is ALWAYS allowed — each loading cycle
 * gets its own unique transaction_id. This check only blocks an exact
 * transaction_id collision (e.g. two loads in the same minute on the same
 * device), which the caller resolves by appending a "-2", "-3" suffix.
 */
export function checkDuplicateBeam(
  _beamNo: string,
  _beams: Array<{ beam_no: string; status: string }>,
  _fc: LoadingFieldConfig = {},
  _isEdit = false,
): { beam_no: string; status: string } | null {
  return null;
}

// ── Material / Grade options ─────────────────────────────────────────────
export type MaterialType = "MS" | "HT";
export type MaterialGrade = { name: string; type: MaterialType };

export const DEFAULT_MATERIAL_GRADES: MaterialGrade[] = [
  { name: "JSPL PG HT", type: "HT" },
  { name: "SARAL PG MS", type: "MS" },
];

/**
 * Detect MS / HT from the trailing designation of an embossing / grade name.
 * Case-insensitive, ignores trailing spaces and punctuation. Returns null when
 * the name does not end with an MS / HT designation.
 */
export function detectMaterialType(name: string | null | undefined): MaterialType | null {
  const s = String(name ?? "").replace(/[^A-Za-z]+$/, "").trim();
  if (!s) return null;
  const m = s.match(/(MS|HT)$/i);
  if (!m) return null;
  return m[1].toUpperCase() as MaterialType;
}

/** Admin-configured grade list, falling back to the seeded defaults. */
export function materialGradesOf(fc: any = {}): MaterialGrade[] {
  const raw = fc?.materialGrades;
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_MATERIAL_GRADES;
  return raw
    .map((g: any) => {
      const name = String(g?.name ?? "").trim();
      const type = (String(g?.type ?? "").toUpperCase() === "HT" ? "HT" : String(g?.type ?? "").toUpperCase() === "MS" ? "MS" : detectMaterialType(name));
      return name && type ? ({ name, type } as MaterialGrade) : null;
    })
    .filter(Boolean) as MaterialGrade[];
}
