// Multiple Linear Regression (MLR) engine for the Dipping module.
//
// Predicts TOTAL DIPPING TIME (seconds) from six process inputs and, with a
// companion fit, the expected average coating. Coefficients are trained ONLY
// from the historical CSV uploaded by the Admin and stored in the database.
//
//   Ŷ = β0 + β1·LoadType + β2·MaterialType + β3·Thickness
//          + β4·SpecificCoating + β5·SurfaceCondition + β6·BathTemp

export const MLR_FEATURES = [
  "Load Type",
  "Material Type",
  "Thickness",
  "Specific Coating",
  "Surface Condition",
  "Bath Temperature",
  "Weight",
  "Length",
] as const;


/** Specific coating (µm) → target average coating (µm). */
export const TARGET_COATING: Record<number, number> = { 65: 75, 87: 95, 130: 140 };

export function targetCoatingFor(required: number | string | null | undefined): number {
  const r = Number(required) || 0;
  return TARGET_COATING[r] ?? (r > 0 ? Math.round(r * 1.08) : 0);
}

// ── Encoders ────────────────────────────────────────────────────────────────
const LOAD_TYPES = ["single", "double", "plate", "cleat", "bundle"];

export function encodeLoad(v: any): number {
  const s = String(v ?? "").trim().toLowerCase();
  const i = LOAD_TYPES.indexOf(s);
  return i >= 0 ? i + 1 : 0;
}

export function encodeMaterial(v: any): number {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "MS") return 1;
  if (s === "HT") return 2;
  return 0;
}

export function encodeSurface(v: any): number {
  const s = String(v ?? "").trim().toLowerCase();
  if (s.startsWith("heavy")) return 3;
  if (s.startsWith("rust")) return 2;
  if (s.startsWith("normal")) return 1;
  return 0;
}

export type MlrInput = {
  loadType: any;
  material: any;
  thickness: number;
  spec: number;
  surface: any;
  bathTemp: number;
  /** MT */
  weight?: number;
  /** mm */
  length?: number;
};

export type MlrTrainingRow = MlrInput & {
  totalTime: number;
  coating: number;
};

export function encodeInput(i: MlrInput): number[] {
  return [
    encodeLoad(i.loadType),
    encodeMaterial(i.material),
    Number(i.thickness) || 0,
    Number(i.spec) || 0,
    encodeSurface(i.surface),
    Number(i.bathTemp) || 0,
    Number(i.weight) || 0,
    Number(i.length) || 0,
  ];
}


// ── CSV parsing ─────────────────────────────────────────────────────────────

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";" || c === "\t") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const HEADER_ALIASES: Record<string, string[]> = {
  loadType: ["load type", "loadtype", "load"],
  material: ["material type", "material", "materialtype"],
  thickness: ["thickness", "material thickness", "thickness (mm)", "job thickness", "job thickness (mm)"],
  spec: ["specific coating", "spec coating", "coating spec", "specific coating (µm)", "specific coating (um)", "required coating", "specific coating requirement", "specific coating requirement (µm)", "specific coating requirement (um)"],
  surface: ["surface condition", "surface"],
  bathTemp: ["bath temperature", "bath temp", "zinc bath temperature", "temperature", "bath temperature (°c)", "zinc bath temperature (°c)", "zinc bath temperature (c)"],
  totalTime: ["total dipping time", "total dipping time (seconds)", "total dipping time (sec)", "total time", "dipping time", "total time (seconds)", "total time (sec)"],
  coating: ["actual average coating", "average coating", "actual coating", "avg coating", "actual average coating (µm)", "average coating (µm)", "average coating (um)"],
};

/** Optional columns — accepted when present, defaulted to 0 otherwise. */
const OPTIONAL_ALIASES: Record<string, string[]> = {
  weight: ["weight", "weight (mt)", "total weight", "total weight (mt)", "weight mt"],
  length: ["length", "length (mm)", "job length", "job length (mm)", "beam length"],
};

export type CsvParseResult = {
  rows: MlrTrainingRow[];
  errors: string[];
  accepted: number;
  rejected: number;
  missingColumns: string[];
};

export function parseTrainingCsv(text: string): CsvParseResult {
  const errors: string[] = [];
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (!lines.length) {
    return { rows: [], errors: ["File is empty."], accepted: 0, rejected: 0, missingColumns: [] };
  }
  const header = splitCsvLine(lines[0]).map((h) => h.replace(/^\uFEFF/, "").toLowerCase());
  const idx: Record<string, number> = {};
  const missingColumns: string[] = [];
  for (const key of Object.keys(HEADER_ALIASES)) {
    const found = header.findIndex((h) => HEADER_ALIASES[key].includes(h));
    if (found < 0) missingColumns.push(key);
    idx[key] = found;
  }
  for (const key of Object.keys(OPTIONAL_ALIASES)) {
    idx[key] = header.findIndex((h) => OPTIONAL_ALIASES[key].includes(h));
  }
  if (missingColumns.length) {
    return {
      rows: [], errors: [`Missing column(s): ${missingColumns.join(", ")}`],
      accepted: 0, rejected: 0, missingColumns,
    };
  }

  const rows: MlrTrainingRow[] = [];
  let rejected = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const num = (k: string) => parseFloat(String(c[idx[k]] ?? "").replace(/[^\d.\-]/g, ""));
    const optNum = (k: string) => {
      if (idx[k] < 0) return 0;
      const v = num(k);
      return Number.isFinite(v) ? v : 0;
    };
    const thickness = num("thickness");
    const spec = num("spec");
    const bathTemp = num("bathTemp");
    const totalTime = num("totalTime");
    const coating = num("coating");
    const bad =
      !Number.isFinite(thickness) || !Number.isFinite(spec) ||
      !Number.isFinite(bathTemp) || !Number.isFinite(totalTime) ||
      !Number.isFinite(coating) || totalTime <= 0 || coating <= 0;
    if (bad) {
      rejected++;
      if (errors.length < 10) errors.push(`Row ${i + 1}: invalid or missing numeric value — skipped.`);
      continue;
    }
    rows.push({
      loadType: c[idx["loadType"]] ?? "",
      material: c[idx["material"]] ?? "",
      thickness, spec,
      surface: c[idx["surface"]] ?? "",
      bathTemp, totalTime, coating,
      weight: optNum("weight"),
      length: optNum("length"),
    });
  }
  return { rows, errors, accepted: rows.length, rejected, missingColumns: [] };
}


// ── Least squares ───────────────────────────────────────────────────────────

/** Solve (XᵀX + λI)β = Xᵀy via Gaussian elimination. X already has intercept. */
function solve(X: number[][], y: number[], lambda = 1e-6): number[] | null {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (!n || !p) return null;
  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const b: number[] = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 0; j < p; j++) A[j][j] += lambda;
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let k = col; k < p; k++) A[r][k] -= f * A[col][k];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

function r2Of(y: number[], pred: number[]): number {
  const mean = y.reduce((s, v) => s + v, 0) / (y.length || 1);
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < y.length; i++) {
    ssTot += (y[i] - mean) ** 2;
    ssRes += (y[i] - pred[i]) ** 2;
  }
  if (ssTot <= 1e-12) return 0;
  return Math.max(0, Math.min(1, 1 - ssRes / ssTot));
}

export type TrainedMlr = {
  /** [β0..β6] for total dipping time. */
  beta: number[];
  /** [α0..α6, α7·time] for expected average coating. */
  coatingBeta: number[];
  features: string[];
  r2: number;
  coatingR2: number;
  n: number;
  /** true when the dataset was too small/degenerate for a full 6-variable fit. */
  degenerate?: boolean;
};

export function fitMlr(rows: MlrTrainingRow[]): TrainedMlr | null {
  if (!rows.length) return null;
  const P = MLR_FEATURES.length + 1; // intercept + features
  const Xt = rows.map((r) => [1, ...encodeInput(r)]);
  const yTime = rows.map((r) => Number(r.totalTime));
  let beta = rows.length >= P ? solve(Xt, yTime) : null;
  let degenerate = false;
  if (!beta) {
    // Not enough (or collinear) data → intercept-only mean model.
    const mean = yTime.reduce((s, v) => s + v, 0) / yTime.length;
    beta = [mean, ...new Array(P - 1).fill(0)];
    degenerate = true;
  }
  const timePred = Xt.map((x) => x.reduce((s, v, i) => s + v * beta![i], 0));

  const Xc = rows.map((r, i) => [...Xt[i], yTime[i]]);
  const yCoat = rows.map((r) => Number(r.coating));
  let coatingBeta = rows.length >= P + 1 ? solve(Xc, yCoat) : null;
  if (!coatingBeta) {
    const mean = yCoat.reduce((s, v) => s + v, 0) / yCoat.length;
    coatingBeta = [mean, ...new Array(P).fill(0)];
  }
  const coatPred = Xc.map((x) => x.reduce((s, v, i) => s + v * coatingBeta![i], 0));

  return {
    beta,
    coatingBeta,
    features: [...MLR_FEATURES],
    r2: +r2Of(yTime, timePred).toFixed(4),
    coatingR2: +r2Of(yCoat, coatPred).toFixed(4),
    n: rows.length,
    degenerate,
  };
}

export function confidencePct(model: TrainedMlr): number {
  const nScore = Math.min(1, model.n / 40);
  const raw = 0.65 * model.r2 + 0.35 * nScore;
  const pct = Math.round(raw * 100);
  if (model.degenerate) return Math.min(pct, 45);
  return Math.max(10, Math.min(99, pct));
}

/** Encoded row sized to the stored model (older models were trained on fewer features). */
function encodeFor(model: TrainedMlr, input: MlrInput): number[] {
  const enc = encodeInput(input);
  const want = Math.max(0, (model.beta?.length ?? enc.length + 1) - 1);
  return enc.slice(0, want);
}

export function predictTotalTime(model: TrainedMlr, input: MlrInput): number {
  const x = [1, ...encodeFor(model, input)];
  const t = x.reduce((s, v, i) => s + v * (model.beta[i] ?? 0), 0);
  return Math.max(1, Math.round(t));
}

export function predictCoating(model: TrainedMlr, input: MlrInput, totalTimeSec: number): number {
  const k = Math.max(0, (model.coatingBeta?.length ?? 0) - 2);
  const x = [1, ...encodeInput(input).slice(0, k), totalTimeSec];
  const c = x.reduce((s, v, i) => s + v * (model.coatingBeta[i] ?? 0), 0);
  return +c.toFixed(2);
}

/**
 * Invert the coating model in time to find the seconds needed to reach the
 * target average coating. Falls back to the direct time model when the
 * time-sensitivity of coating is not usable.
 */
export function timeForTargetCoating(
  model: TrainedMlr,
  input: MlrInput,
  targetCoating: number,
): number {
  const last = (model.coatingBeta?.length ?? 0) - 1;
  const slope = last >= 0 ? (model.coatingBeta[last] ?? 0) : 0;
  if (Math.abs(slope) > 1e-6) {
    const k = Math.max(0, last - 1);
    const x = [1, ...encodeInput(input).slice(0, k)];
    const base = x.reduce((s, v, i) => s + v * (model.coatingBeta[i] ?? 0), 0);

    const t = (targetCoating - base) / slope;
    if (Number.isFinite(t) && t > 5 && t < 3600) return Math.round(t);
  }
  return predictTotalTime(model, input);
}

export type MlrPrediction = {
  totalSec: number;
  totalMMSS: string;
  expectedCoating: number;
  targetCoating: number;
  confidencePct: number;
  r2: number;
  n: number;
};

export function mmss(sec: number): string {
  const v = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

export function predict(model: TrainedMlr, input: MlrInput): MlrPrediction {
  const target = targetCoatingFor(input.spec);
  const totalSec = timeForTargetCoating(model, input, target);
  const expected = predictCoating(model, input, totalSec);
  return {
    totalSec,
    totalMMSS: mmss(totalSec),
    expectedCoating: Number.isFinite(expected) && expected > 0 ? expected : target,
    targetCoating: target,
    confidencePct: confidencePct(model),
    r2: model.r2,
    n: model.n,
  };
}

/** Recommendation sentence for the AI Insights panel. */
export function recommendationSentence(opts: {
  predictedSec: number;
  targetCoating: number;
  referenceSec?: number | null;
  referenceCoating?: number | null;
}): { sentence: string; deltaSec: number } {
  const { predictedSec, targetCoating, referenceSec } = opts;
  if (referenceSec == null || !Number.isFinite(Number(referenceSec)) || Number(referenceSec) <= 0) {
    return {
      deltaSec: 0,
      sentence: `Use ${predictedSec} seconds (${mmss(predictedSec)}) total dipping time to achieve approximately ${Math.round(targetCoating)} µm average coating.`,
    };
  }
  const delta = Math.round(predictedSec - Number(referenceSec));
  if (Math.abs(delta) < 1) {
    return {
      deltaSec: 0,
      sentence: `Hold dipping time at ${predictedSec} seconds (${mmss(predictedSec)}) to achieve approximately ${Math.round(targetCoating)} µm average coating.`,
    };
  }
  const verb = delta < 0 ? "Reduce" : "Increase";
  return {
    deltaSec: delta,
    sentence: `${verb} immersion time by ${Math.abs(delta)} seconds (to ${predictedSec}s / ${mmss(predictedSec)}) to achieve approximately ${Math.round(targetCoating)} µm average coating.`,
  };
}
