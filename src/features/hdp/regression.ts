// Regression model for Dipping coating recommendation.
// Pure functions only — no React, no I/O — so this stays unit-testable.
//
// Learns micron = f(immersion, reaction, withdrawal, bathTemp, thickness,
// weight, length) from PASS beams in the last N days (default 7 per spec),
// predicts expected micron for the current beam, and solves for the
// immersion-time delta needed to hit an optimum target micron.

import { parseLen, parseThk } from "./recommendation";
import { productionDayIdTz } from "./production-day";

// ── Types ──────────────────────────────────────────────────────────
export type TrainingRow = {
  beam: any;
  micron: number;
  immersion: number;
  reaction: number;
  withdrawal: number;
  bathTemp: number;
  thickness: number;
  weight: number;
  length: number;
};

export type Sensitivities = {
  perSecImmersion: number;
  perSecReaction: number;
  perSecWithdrawal: number;
  perDegBathTemp: number;
  perMmThickness: number;
  perMtWeight: number;
  perMmLength: number;
};

export type CoatingModel = {
  // [intercept, b_imm, b_react, b_with, b_temp, b_thk, b_wt, b_len]
  coef: number[];
  r2: number;
  n: number;
  residualStd: number;
  sensitivities: Sensitivities;
  fallback?: "univariate" | "constant";
  lowSample: boolean;
};

export type NonMatchAdjustment = {
  label: string;
  delta: number;
  micronImpact: number;
};

export type HistoricalRow = {
  beam_no: string;
  qc_completed_at: string | null;
  immersion: number;
  reaction: number;
  withdrawal: number;
  bathTemp: number;
  length: number;
  micron: number;
  similarity: number;
};

export type Prediction = {
  immersion: number;
  reaction: number;
  withdrawal: number;
  total: number;
  deltaSec: number;
  expectedMicron: number;
  targetMicron: number;
  targetBand?: [number, number];
  requiredMicron: number;
  confidence: number;
  nonMatchAdjustments: NonMatchAdjustment[];
};


export type MatchedInfo = {
  matching: string[];
  nonMatching: string[];
  details: Array<{ label: string; current: any; anchor: any; ok: boolean }>;
  anchorBeamNo: string | null;
  similarity: number;
};

export type TargetEvidence = {
  target: number;
  reason: "history" | "preferred" | "required";
  bucketRange?: [number, number];
  bucketRows?: number;
};

// Low-sample thresholds (spec §4 confidence gate).
export const LOW_SAMPLE_MIN_ROWS = 10;
export const LOW_SAMPLE_MIN_R2 = 0.3;

// ── Training-set selection ─────────────────────────────────────────
export function selectTrainingSet(
  beams: any[],
  opts: { days?: number; minRows?: number; maxDays?: number; now?: number } = {},
): { rows: TrainingRow[]; days: number } {
  const days = opts.days ?? 10;
  const minRows = opts.minRows ?? 8;
  const maxDays = opts.maxDays ?? 30;
  const nowMs = opts.now ?? Date.now();

  const build = (windowDays: number): TrainingRow[] => {
    const cutoff = nowMs - windowDays * 86400_000;
    const out: TrainingRow[] = [];
    for (const b of beams) {
      if (b?.qc_status !== "PASS") continue;
      const ts = b.qc_completed_at || b.dipped_at || null;
      const t = ts ? new Date(ts).getTime() : NaN;
      if (!isFinite(t) || t < cutoff) continue;
      const micron = Number(b.avg_reading);
      const imm = Number(b.immersion_duration);
      const react = Number(b.reaction_duration);
      const wdr = Number(b.withdrawal_duration);
      const temp = Number(b.bath_temperature);
      const thk = parseThk(b);
      const wt = parseFloat(b.total_weight);
      const len = parseLen(b) ?? 0;
      if (![micron, imm, react, wdr, temp, wt].every((v) => isFinite(v) && v > 0)) continue;
      if (thk == null || !isFinite(thk)) continue;
      // Bath temp guard: regression training only for in-spec zinc bath (440–465 °C).
      if (temp < 440 || temp > 465) continue;
      out.push({
        beam: b,
        micron, immersion: imm, reaction: react, withdrawal: wdr,
        bathTemp: temp, thickness: thk, weight: wt, length: len,
      });
    }
    return out;
  };

  let rows = build(days);
  let used = days;
  if (rows.length < minRows && maxDays > days) {
    const wider = build(maxDays);
    if (wider.length > rows.length) {
      rows = wider;
      used = maxDays;
    }
  }
  return { rows, days: used };
}


// ── Similarity ─────────────────────────────────────────────────────
export function similarityScore(
  current: any,
  hist: any,
  opts: { weightTol?: number; tempTol?: number; lengthTol?: number; qtyTol?: number; thkTol?: number } = {},
): number {
  const weightTol = opts.weightTol ?? 0.2;
  const tempTol = opts.tempTol ?? 2;
  const lengthTol = opts.lengthTol ?? 500;
  const qtyTol = opts.qtyTol ?? 5;
  const thkTol = opts.thkTol ?? 2;

  const cWt = parseFloat(current.total_weight) || 0;
  const hWt = parseFloat(hist.total_weight) || 0;
  const cLen = parseLen(current) ?? 0;
  const hLen = parseLen(hist) ?? 0;
  const cQty = (current.part_nos || "").split(",").filter(Boolean).length || 1;
  const hQty = (hist.part_nos || "").split(",").filter(Boolean).length || 1;
  const cTemp = Number(current.bath_temperature) || 0;
  const hTemp = Number(hist.bath_temperature) || 0;
  const cThk = parseThk(current) ?? 0;
  const hThk = parseThk(hist) ?? 0;
  const cShift = current.shift ?? null;
  const hShift = hist.shift ?? null;

  const norm = (a: number, b: number, tol: number) => {
    if (tol <= 0) return a === b ? 1 : 0;
    return Math.max(0, 1 - Math.abs(a - b) / (4 * tol));
  };
  const eq = (a: any, b: any) => (a == null && b == null ? 1 : a != null && b != null && a === b ? 1 : a == null || b == null ? 0.5 : 0);

  const parts: Array<[number, number]> = [
    [norm(cThk, hThk, thkTol), 0.25],
    [norm(cWt, hWt, weightTol), 0.20],
    [norm(cTemp, hTemp, tempTol), 0.20],
    [norm(cLen, hLen, lengthTol), 0.15],
    [eq(cShift, hShift), 0.10],
    [norm(cQty, hQty, qtyTol), 0.10],
  ];
  const total = parts.reduce((s, [_, w]) => s + w, 0);
  const score = parts.reduce((s, [v, w]) => s + v * w, 0) / total;
  return Math.max(0, Math.min(1, score));
}

// ── Matrix helpers (Gauss–Jordan) ──────────────────────────────────
function invert(M: number[][]): number[][] | null {
  const n = M.length;
  const A: number[][] = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(A[r][i]) > Math.abs(A[pivot][i])) pivot = r;
    }
    if (Math.abs(A[pivot][i]) < 1e-12) return null;
    if (pivot !== i) [A[i], A[pivot]] = [A[pivot], A[i]];
    const div = A[i][i];
    for (let j = 0; j < 2 * n; j++) A[i][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[i][j];
    }
  }
  return A.map((row) => row.slice(n));
}

function matVec(M: number[][], v: number[]): number[] {
  return M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}

// ── Model fit ──────────────────────────────────────────────────────
const zeroSens = (coef: number[]): Sensitivities => ({
  perSecImmersion: +(coef[1] || 0),
  perSecReaction: +(coef[2] || 0),
  perSecWithdrawal: +(coef[3] || 0),
  perDegBathTemp: +(coef[4] || 0),
  perMmThickness: +(coef[5] || 0),
  perMtWeight: +(coef[6] || 0),
  perMmLength: +(coef[7] || 0),
});

const padCoef = (c: number[]): number[] => {
  const out = c.slice(0, 8);
  while (out.length < 8) out.push(0);
  return out;
};

const isLowSample = (n: number, r2: number, fallback?: "univariate" | "constant") =>
  fallback != null || n < LOW_SAMPLE_MIN_ROWS || r2 < LOW_SAMPLE_MIN_R2;

export function fitCoatingModel(rows: TrainingRow[]): CoatingModel {
  const n = rows.length;
  if (n === 0) {
    const coef = padCoef([0]);
    return {
      coef, r2: 0, n: 0, residualStd: 0,
      sensitivities: zeroSens(coef), fallback: "constant", lowSample: true,
    };
  }
  const X = rows.map((r) => [1, r.immersion, r.reaction, r.withdrawal, r.bathTemp, r.thickness, r.weight, r.length]);
  const y = rows.map((r) => r.micron);
  const k = 8;

  if (n < k + 1) return fitUnivariate(rows);

  const XtX: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const Xty: number[] = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const inv = invert(XtX);
  if (!inv) return fitUnivariate(rows);
  const coef = matVec(inv, Xty);

  const yMean = y.reduce((s, v) => s + v, 0) / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = X[i].reduce((s, v, j) => s + v * coef[j], 0);
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const residualStd = Math.sqrt(ssRes / Math.max(1, n - k));
  return {
    coef, r2, n, residualStd,
    sensitivities: zeroSens(coef),
    lowSample: isLowSample(n, r2),
  };
}

function fitUnivariate(rows: TrainingRow[]): CoatingModel {
  const n = rows.length;
  if (n < 2) {
    const mean = n ? rows[0].micron : 0;
    const coef = padCoef([mean]);
    return {
      coef, r2: 0, n, residualStd: 0,
      sensitivities: zeroSens(coef), fallback: "constant", lowSample: true,
    };
  }
  const xs = rows.map((r) => r.immersion);
  const ys = rows.map((r) => r.micron);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const b = den > 0 ? num / den : 0;
  const a = my - b * mx;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - my) ** 2;
    ssRes += (ys[i] - (a + b * xs[i])) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const coef = padCoef([a, b]);
  return {
    coef, r2, n,
    residualStd: Math.sqrt(ssRes / Math.max(1, n - 2)),
    sensitivities: zeroSens(coef),
    fallback: "univariate",
    lowSample: true,
  };
}

export function predictMicron(
  model: CoatingModel,
  x: { immersion: number; reaction: number; withdrawal: number; bathTemp: number; thickness: number; weight: number; length?: number },
): number {
  const v = [1, x.immersion, x.reaction, x.withdrawal, x.bathTemp, x.thickness, x.weight, x.length ?? 0];
  return model.coef.reduce((s, c, j) => s + c * v[j], 0);
}

// ── Target-micron optimization ─────────────────────────────────────
// Production regression targets (per spec):
//   65 µm → optimize for 75 µm
//   87 µm → optimize for 95 µm
//   130 µm → optimize for 140 µm
const PREFERRED: Record<number, number> = { 65: 75, 87: 95, 130: 140 };
export const TARGET_MICRON_PER_SPEC: Record<number, number> = { 65: 75, 87: 95, 130: 140 };


export function optimalTargetMicron(
  rows: TrainingRow[],
  required: number,
): TargetEvidence {
  const preferred = PREFERRED[required] ?? required + 8;
  const candidates = rows.filter((r) => r.micron >= required && r.micron < preferred);
  if (candidates.length >= 5) {
    const buckets = new Map<number, number>();
    for (const r of candidates) {
      const b = Math.floor(r.micron / 2) * 2;
      buckets.set(b, (buckets.get(b) || 0) + 1);
    }
    const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    for (const [b, count] of sorted) {
      if (count >= 5) {
        return { target: b + 1, reason: "history", bucketRange: [b, b + 2], bucketRows: count };
      }
    }
  }
  if (PREFERRED[required] != null) return { target: preferred, reason: "preferred" };
  return { target: required, reason: "required" };
}

// ── Confidence ─────────────────────────────────────────────────────
export function confidenceFrom(r2: number, n: number, similarity: number, lowSample = false): number {
  const nScore = Math.min(1, n / 20);
  const raw = 0.5 * Math.max(0, Math.min(1, r2)) + 0.3 * nScore + 0.2 * Math.max(0, Math.min(1, similarity));
  const pct = Math.round(100 * Math.max(0, Math.min(1, raw)));
  return lowSample ? Math.min(pct, 55) : pct;
}

// ── Prediction ─────────────────────────────────────────────────────
export function predictTimings(
  model: CoatingModel,
  current: { bathTemp: number; thickness: number; weight: number; length?: number },
  ctx: { requiredMicron: number; targetMicron: number; anchor: TrainingRow; similarity: number; trainingRows?: TrainingRow[] },
): Prediction {
  const bImm = model.coef[1] || 0;
  // Median helper — used as a safety net when the anchor row has a missing
  // or zero reaction / withdrawal duration (a common data-entry artefact
  // when the floor operator taps Reaction End and Withdrawal End back-to-back).
  const median = (xs: number[]): number => {
    const v = xs.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!v.length) return 0;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const tr = ctx.trainingRows ?? [];
  const baseImm = ctx.anchor.immersion > 0 ? ctx.anchor.immersion : median(tr.map((r) => r.immersion));
  const baseReact = ctx.anchor.reaction > 0 ? ctx.anchor.reaction : median(tr.map((r) => r.reaction));
  const baseWith = ctx.anchor.withdrawal > 0 ? ctx.anchor.withdrawal : median(tr.map((r) => r.withdrawal));
  const curLen = current.length ?? ctx.anchor.length ?? 0;

  const predAtAnchor = predictMicron(model, {
    immersion: baseImm,
    reaction: baseReact,
    withdrawal: baseWith,
    bathTemp: current.bathTemp,
    thickness: current.thickness,
    weight: current.weight,
    length: curLen,
  });

  let deltaSec = 0;
  if (Math.abs(bImm) > 1e-6) {
    deltaSec = (ctx.targetMicron - predAtAnchor) / bImm;
    const cap = Math.max(30, baseImm * 0.5);
    deltaSec = Math.max(-cap, Math.min(cap, deltaSec));
  }
  const immersion = Math.max(1, Math.round(baseImm + deltaSec));
  const reaction = Math.max(1, Math.round(baseReact));
  const withdrawal = Math.max(1, Math.round(baseWith));
  const expectedMicron = predictMicron(model, {
    immersion, reaction, withdrawal,
    bathTemp: current.bathTemp,
    thickness: current.thickness,
    weight: current.weight,
    length: curLen,
  });

  const s = model.sensitivities;
  const adj: NonMatchAdjustment[] = [];
  const push = (label: string, delta: number, coef: number) => {
    if (Math.abs(delta) < 1e-6 || Math.abs(coef) < 1e-6) return;
    adj.push({ label, delta: +delta.toFixed(2), micronImpact: +(delta * coef).toFixed(2) });
  };
  push("Bath Temp", current.bathTemp - ctx.anchor.bathTemp, s.perDegBathTemp);
  push("Thickness", current.thickness - ctx.anchor.thickness, s.perMmThickness);
  push("Weight", current.weight - ctx.anchor.weight, s.perMtWeight);
  push("Length", curLen - (ctx.anchor.length ?? 0), s.perMmLength);

  return {
    immersion,
    reaction,
    withdrawal,
    total: immersion + reaction + withdrawal,
    deltaSec: Math.round(deltaSec),
    expectedMicron: +expectedMicron.toFixed(2),
    targetMicron: ctx.targetMicron,
    requiredMicron: ctx.requiredMicron,
    confidence: confidenceFrom(model.r2, model.n, ctx.similarity, model.lowSample),
    nonMatchAdjustments: adj,
  };
}

// ── Matching-parameter classification (for UI chips) ───────────────
export function classifyMatch(
  current: any,
  anchor: any,
  opts: { weightTol?: number; tempTol?: number; lengthTol?: number; qtyTol?: number } = {},
): MatchedInfo {
  const weightTol = opts.weightTol ?? 0.2;
  const tempTol = opts.tempTol ?? 2;
  const lengthTol = opts.lengthTol ?? 500;
  const qtyTol = opts.qtyTol ?? 5;
  const matching: string[] = [];
  const nonMatching: string[] = [];
  const details: MatchedInfo["details"] = [];
  const push = (label: string, cur: any, anc: any, ok: boolean) => {
    (ok ? matching : nonMatching).push(label);
    details.push({ label, current: cur, anchor: anc, ok });
  };

  push("Material Type", current.material_type ?? null, anchor.material_type ?? null,
    (current.material_type || null) === (anchor.material_type || null));
  push("Surface Condition", current.surface_condition ?? null, anchor.surface_condition ?? null,
    (current.surface_condition || null) === (anchor.surface_condition || null));
  push("Load Type", current.load_type, anchor.load_type, current.load_type === anchor.load_type);
  push("Required Coating", current.coating_required, anchor.coating_required,
    Number(current.coating_required) === Number(anchor.coating_required));
  const cThk = parseThk(current), aThk = parseThk(anchor);
  push("Thickness", cThk, aThk, cThk === aThk);
  const cWt = parseFloat(current.total_weight) || 0;
  const hWt = parseFloat(anchor.total_weight) || 0;
  push("Weight", cWt, hWt, Math.abs(cWt - hWt) <= weightTol + 1e-9);
  const cTemp = Number(current.bath_temperature) || 0;
  const aTemp = Number(anchor.bath_temperature) || 0;
  push("Bath Temp", cTemp, aTemp, Math.abs(cTemp - aTemp) <= tempTol + 1e-9);
  const cLen = parseLen(current), hLen = parseLen(anchor);
  if (cLen != null && hLen != null) {
    push("Length", cLen, hLen, Math.abs(cLen - hLen) <= lengthTol + 1e-9);
  }
  const cQty = (current.part_nos || "").split(",").filter(Boolean).length || 1;
  const hQty = (anchor.part_nos || "").split(",").filter(Boolean).length || 1;
  push("Quantity", cQty, hQty, Math.abs(cQty - hQty) <= qtyTol + 1e-9);

  return { matching, nonMatching, details, anchorBeamNo: anchor?.beam_no ?? null, similarity: 0 };
}

// ── Historical-record ranking ──────────────────────────────────────
// topN defaults to Infinity so callers get every training row sorted by
// similarity descending. Pass an explicit cap to limit.
export function rankHistorical(
  current: any,
  rows: TrainingRow[],
  opts: { weightTol?: number; tempTol?: number; lengthTol?: number; qtyTol?: number } = {},
  topN: number = Infinity,
): HistoricalRow[] {
  return rows
    .map((r) => ({
      row: r,
      sim: similarityScore(current, r.beam, opts),
    }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topN)
    .map(({ row, sim }) => ({
      beam_no: row.beam?.beam_no ?? "—",
      qc_completed_at: row.beam?.qc_completed_at ?? row.beam?.dipped_at ?? null,
      immersion: row.immersion,
      reaction: row.reaction,
      withdrawal: row.withdrawal,
      bathTemp: row.bathTemp,
      length: row.length,
      micron: row.micron,
      similarity: +sim.toFixed(2),
    }));
}

// ═════════════════════════════════════════════════════════════════════
// TIME-SERIES ANALYSIS LAYER (spec: AI Time-Series Recommendation Engine)
// Operates on the already-selected TrainingRow[] set. Pure helpers.
// ═════════════════════════════════════════════════════════════════════

const PREFERRED_BAND: Record<number, [number, number]> = {
  65: [70, 75],
  87: [90, 97],
  130: [130, 140],
};

export function targetBandFor(required: number): [number, number] {
  return PREFERRED_BAND[required] ?? [required, required + 8];
}

const _ts = (r: TrainingRow): number => {
  const s = r.beam?.qc_completed_at || r.beam?.dipped_at;
  const t = s ? new Date(s).getTime() : NaN;
  return isFinite(t) ? t : 0;
};

export function sortChronological(rows: TrainingRow[]): TrainingRow[] {
  return [...rows].sort((a, b) => _ts(a) - _ts(b));
}

const _stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
};

export type ProcessDrift = { slopePerDay: number; direction: "up" | "down" | "flat"; n: number };
export function detectProcessDrift(rows: TrainingRow[]): ProcessDrift {
  const sorted = sortChronological(rows);
  const n = sorted.length;
  if (n < 3) return { slopePerDay: 0, direction: "flat", n };
  const t0 = _ts(sorted[0]);
  const xs = sorted.map((r) => (_ts(r) - t0) / 86400_000);
  const ys = sorted.map((r) => r.micron);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den > 0 ? num / den : 0;
  const dir: ProcessDrift["direction"] = Math.abs(slope) < 0.2 ? "flat" : slope > 0 ? "up" : "down";
  return { slopePerDay: +slope.toFixed(2), direction: dir, n };
}

export type TempDrift = { tempDelta: number; micronDelta: number; n: number };
export function detectTemperatureDrift(rows: TrainingRow[]): TempDrift {
  const sorted = sortChronological(rows);
  const n = sorted.length;
  if (n < 4) return { tempDelta: 0, micronDelta: 0, n };
  const half = Math.floor(n / 2);
  const first = sorted.slice(0, half);
  const second = sorted.slice(n - half);
  const avg = (arr: TrainingRow[], k: "bathTemp" | "micron") =>
    arr.reduce((s, r) => s + r[k], 0) / arr.length;
  return {
    tempDelta: +(avg(second, "bathTemp") - avg(first, "bathTemp")).toFixed(2),
    micronDelta: +(avg(second, "micron") - avg(first, "micron")).toFixed(2),
    n,
  };
}

export type Stability = { status: "Stable" | "Slightly Variable" | "Unstable"; sigma: number; n: number };
export function detectStability(rows: TrainingRow[]): Stability {
  const n = rows.length;
  const sigma = _stdev(rows.map((r) => r.micron));
  const status: Stability["status"] =
    n < 3 ? "Slightly Variable" : sigma <= 3 ? "Stable" : sigma <= 6 ? "Slightly Variable" : "Unstable";
  return { status, sigma: +sigma.toFixed(2), n };
}

export type SuddenShift = { shifted: boolean; from: number; to: number; dayISO: string | null };
export function detectSuddenShift(rows: TrainingRow[]): SuddenShift {
  const sorted = sortChronological(rows);
  const byDay = new Map<string, number[]>();
  for (const r of sorted) {
    // Group by production day (06:00 → 06:00 plant time), same as reports.
    const key = productionDayIdTz(new Date(_ts(r)).toISOString());
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(r.micron);
  }
  const days = [...byDay.entries()].map(([k, ms]) => [k, ms.reduce((s, v) => s + v, 0) / ms.length] as const);
  days.sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 1; i < days.length; i++) {
    if (Math.abs(days[i][1] - days[i - 1][1]) >= 5) {
      return { shifted: true, from: +days[i - 1][1].toFixed(2), to: +days[i][1].toFixed(2), dayISO: days[i][0] };
    }
  }
  return { shifted: false, from: 0, to: 0, dayISO: null };
}

export type ShiftPatternRow = { shift: string; avgMicron: number; n: number };
export function shiftPattern(rows: TrainingRow[]): ShiftPatternRow[] {
  const g = new Map<string, number[]>();
  for (const r of rows) {
    const s = String(r.beam?.shift ?? "").trim() || "—";
    if (!g.has(s)) g.set(s, []);
    g.get(s)!.push(r.micron);
  }
  return [...g.entries()]
    .map(([shift, ms]) => ({ shift, avgMicron: +(ms.reduce((s, v) => s + v, 0) / ms.length).toFixed(2), n: ms.length }))
    .sort((a, b) => a.shift.localeCompare(b.shift));
}

export type OperatorPatternRow = {
  operator: string; n: number; avgMicron: number; sigma: number;
  avgImm: number; avgReact: number; avgWith: number; mostConsistent?: boolean;
};
export function operatorPattern(rows: TrainingRow[]): OperatorPatternRow[] {
  const g = new Map<string, TrainingRow[]>();
  for (const r of rows) {
    const op = String(r.beam?.dipped_by ?? r.beam?.operator_id ?? r.beam?.dipping_supervisor ?? "").trim() || "—";
    if (!g.has(op)) g.set(op, []);
    g.get(op)!.push(r);
  }
  const out: OperatorPatternRow[] = [...g.entries()].map(([op, rs]) => {
    const ms = rs.map((r) => r.micron);
    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    return {
      operator: op,
      n: rs.length,
      avgMicron: +avg(ms).toFixed(2),
      sigma: +_stdev(ms).toFixed(2),
      avgImm: Math.round(avg(rs.map((r) => r.immersion))),
      avgReact: Math.round(avg(rs.map((r) => r.reaction))),
      avgWith: Math.round(avg(rs.map((r) => r.withdrawal))),
    };
  }).sort((a, b) => b.n - a.n);
  // Mark most-consistent (lowest sigma with n>=3)
  const eligible = out.filter((r) => r.n >= 3);
  if (eligible.length) {
    const best = eligible.reduce((a, b) => (a.sigma <= b.sigma ? a : b));
    best.mostConsistent = true;
  }
  return out;
}

export type StableWindow = {
  days: number;
  rows: TrainingRow[];
  sigma: number;
  slopePerDay: number;
  status: Stability["status"];
};
export function bestStableWindow(rows: TrainingRow[], nowMs: number = Date.now()): StableWindow {
  const sorted = sortChronological(rows);
  const candidates = [2, 3, 5, 7];
  let best: StableWindow | null = null;
  for (const d of candidates) {
    const cutoff = nowMs - d * 86400_000;
    const inWin = sorted.filter((r) => _ts(r) >= cutoff);
    if (inWin.length < 4) continue;
    const sigma = _stdev(inWin.map((r) => r.micron));
    const drift = detectProcessDrift(inWin);
    const stab = detectStability(inWin);
    const score = -sigma - Math.abs(drift.slopePerDay);
    const cur: StableWindow = { days: d, rows: inWin, sigma: +sigma.toFixed(2), slopePerDay: drift.slopePerDay, status: stab.status };
    if (!best || score > (-best.sigma - Math.abs(best.slopePerDay))) best = cur;
  }
  if (best) return best;
  // Fallback: full set
  const sigma = _stdev(sorted.map((r) => r.micron));
  const drift = detectProcessDrift(sorted);
  const stab = detectStability(sorted);
  return { days: 7, rows: sorted, sigma: +sigma.toFixed(2), slopePerDay: drift.slopePerDay, status: stab.status };
}

export type TimeSeriesInsights = {
  totalRows: number;
  drift: ProcessDrift;
  tempDrift: TempDrift;
  stability: Stability;
  suddenShift: SuddenShift;
  shifts: ShiftPatternRow[];
  operators: OperatorPatternRow[];
  bestWindow: StableWindow;
};

export function computeTimeSeries(rows: TrainingRow[], nowMs: number = Date.now()): TimeSeriesInsights {
  return {
    totalRows: rows.length,
    drift: detectProcessDrift(rows),
    tempDrift: detectTemperatureDrift(rows),
    stability: detectStability(rows),
    suddenShift: detectSuddenShift(rows),
    shifts: shiftPattern(rows),
    operators: operatorPattern(rows).slice(0, 5),
    bestWindow: bestStableWindow(rows, nowMs),
  };
}

// Recency-weighted refit (half-life in days). Falls back to fitCoatingModel
// when fewer than 4 rows.
export function fitWeightedCoatingModel(
  rows: TrainingRow[],
  opts: { halfLifeDays?: number; now?: number } = {},
): CoatingModel {
  const n = rows.length;
  if (n < 4) return fitCoatingModel(rows);
  const halfLife = opts.halfLifeDays ?? 2;
  const nowMs = opts.now ?? Date.now();
  const w = rows.map((r) => {
    const ageDays = Math.max(0, (nowMs - _ts(r)) / 86400_000);
    return Math.exp(-Math.LN2 * ageDays / halfLife);
  });
  const k = 8;
  if (n < k + 1) {
    // weighted univariate on immersion
    const xs = rows.map((r) => r.immersion);
    const ys = rows.map((r) => r.micron);
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (let i = 0; i < n; i++) {
      sw += w[i]; swx += w[i] * xs[i]; swy += w[i] * ys[i];
      swxx += w[i] * xs[i] * xs[i]; swxy += w[i] * xs[i] * ys[i];
    }
    const den = sw * swxx - swx * swx;
    const b = den !== 0 ? (sw * swxy - swx * swy) / den : 0;
    const a = sw !== 0 ? (swy - b * swx) / sw : 0;
    const my = swy / sw;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
      ssTot += w[i] * (ys[i] - my) ** 2;
      ssRes += w[i] * (ys[i] - (a + b * xs[i])) ** 2;
    }
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
    const coef = padCoef([a, b]);
    return { coef, r2, n, residualStd: Math.sqrt(ssRes / Math.max(1, n - 2)), sensitivities: zeroSens(coef), fallback: "univariate", lowSample: true };
  }
  const X = rows.map((r) => [1, r.immersion, r.reaction, r.withdrawal, r.bathTemp, r.thickness, r.weight, r.length]);
  const y = rows.map((r) => r.micron);
  const XtX: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const Xty: number[] = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    for (let a = 0; a < k; a++) {
      Xty[a] += wi * X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += wi * X[i][a] * X[i][b];
    }
  }
  const inv = invert(XtX);
  if (!inv) return fitCoatingModel(rows);
  const coef = matVec(inv, Xty);
  const sw = w.reduce((s, v) => s + v, 0);
  const yMean = w.reduce((s, v, i) => s + v * y[i], 0) / sw;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = X[i].reduce((s, v, j) => s + v * coef[j], 0);
    ssRes += w[i] * (y[i] - pred) ** 2;
    ssTot += w[i] * (y[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const residualStd = Math.sqrt(ssRes / Math.max(1, n - k));
  return { coef, r2, n, residualStd, sensitivities: zeroSens(coef), lowSample: isLowSample(n, r2) };
}


// ═════════════════════════════════════════════════════════════════════
// AI INSIGHT TIME — regression on TOTAL cycle time (seconds) as a
// function of (bathTemp, weight, length, thickness) from the filtered
// last-7-days PASS set. Independent from the micron model above.
// ═════════════════════════════════════════════════════════════════════

export type CycleTimeModel = {
  // [intercept, b_temp, b_wt, b_len, b_thk]
  coef: number[];
  r2: number;
  n: number;
  residualStd: number;
  fallback?: "mean";
};

export function fitCycleTimeModel(rows: TrainingRow[]): CycleTimeModel {
  const n = rows.length;
  if (n === 0) return { coef: [0, 0, 0, 0, 0], r2: 0, n: 0, residualStd: 0, fallback: "mean" };
  const totals = rows.map((r) => r.immersion + r.reaction + r.withdrawal);
  if (n < 6) {
    const mean = totals.reduce((s, v) => s + v, 0) / n;
    return { coef: [mean, 0, 0, 0, 0], r2: 0, n, residualStd: 0, fallback: "mean" };
  }
  const k = 5;
  const X = rows.map((r) => [1, r.bathTemp, r.weight, r.length, r.thickness]);
  const y = totals;
  const XtX: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const Xty: number[] = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const inv = invert(XtX);
  if (!inv) {
    const mean = y.reduce((s, v) => s + v, 0) / n;
    return { coef: [mean, 0, 0, 0, 0], r2: 0, n, residualStd: 0, fallback: "mean" };
  }
  const coef = matVec(inv, Xty);
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = X[i].reduce((s, v, j) => s + v * coef[j], 0);
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { coef, r2, n, residualStd: Math.sqrt(ssRes / Math.max(1, n - k)) };
}

export function predictCycleTime(
  model: CycleTimeModel,
  x: { bathTemp: number; weight: number; length: number; thickness: number },
): number {
  const v = [1, x.bathTemp, x.weight, x.length, x.thickness];
  const t = model.coef.reduce((s, c, j) => s + c * v[j], 0);
  return Math.max(1, Math.round(t));
}

// ═════════════════════════════════════════════════════════════════════
// TOTAL-TIME MLR MODEL — per required coating spec (65/87/130 µm)
// Predicts the recommended TOTAL DIPPING TIME (seconds) from encoded
// production predictors. Independent of the coating-micron model above.
// Enables "First Beam" recommendations when history has no exact match.
//   Y = b0 + b1·LoadType + b2·Weight + b3·Thickness + b4·BathTemp
//       + b5·MaterialCode + b6·SurfaceCode
// ═════════════════════════════════════════════════════════════════════

const LOAD_TYPE_CODES: Record<string, number> = {
  "Single": 0, "Double": 1, "Batch": 2, "Plate": 3, "Cleat": 4,
};
export function encodeLoadType(v: any): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (s in LOAD_TYPE_CODES) return LOAD_TYPE_CODES[s];
  // Stable hash → deterministic ordinal for unseen labels.
  let h = 5; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 100 / 10; // 0..10 spread
}
export function encodeMaterial(v: any): number {
  const s = String(v || "").toUpperCase().trim();
  return s === "HT" ? 1 : 0; // MS = 0 (default)
}
export function encodeSurface(v: any): number {
  const s = String(v || "").toLowerCase().trim();
  if (s.startsWith("heavy")) return 2;
  if (s.startsWith("rust")) return 1;
  return 0; // Normal / unknown
}

export type TotalTimeModel = {
  spec: number;
  coef: number[];              // [b0, load, wt, thk, temp, mat, surf, len]
  r2: number;
  n: number;
  residualStd: number;
  fallback?: "mean" | "insufficient";
  driverImportance: Array<{ name: string; weight: number }>;
  meanTotal: number;
};

const TOTAL_TIME_PREDICTORS = [
  "Load Type", "Weight (MT)", "Thickness (Micron µm)", "Bath Temp (°C)",
  "Material Type", "Surface Condition", "Length (mm)",
] as const;

function totalTimeFeatureVec(b: any, bathTemp: number): number[] {
  return [
    1,
    encodeLoadType(b.load_type),
    parseFloat(b.total_weight) || 0,
    parseThk(b) ?? 0,
    bathTemp,
    encodeMaterial(b.material_type),
    encodeSurface(b.surface_condition),
    parseLen(b) ?? 0,
  ];
}

export function fitTotalTimeModel(rows: TrainingRow[], spec: number): TotalTimeModel {
  const n = rows.length;
  const totals = rows.map((r) => r.immersion + r.reaction + r.withdrawal);
  const meanTotal = n ? totals.reduce((s, v) => s + v, 0) / n : 0;
  const emptyDrivers = TOTAL_TIME_PREDICTORS.map((name) => ({ name, weight: 0 }));
  const zeroCoef = [meanTotal, 0, 0, 0, 0, 0, 0, 0];
  if (n < 2) {
    return { spec, coef: zeroCoef, r2: 0, n, residualStd: 0, fallback: "insufficient", driverImportance: emptyDrivers, meanTotal };
  }
  const k = 8;
  const X = rows.map((r) => totalTimeFeatureVec(r.beam, r.bathTemp));
  const y = totals;
  if (n < k + 1) {
    // Mean-fallback for very small samples.
    return { spec, coef: zeroCoef, r2: 0, n, residualStd: 0, fallback: "mean", driverImportance: emptyDrivers, meanTotal };
  }
  const XtX: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const Xty: number[] = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const inv = invert(XtX);
  if (!inv) {
    return { spec, coef: zeroCoef, r2: 0, n, residualStd: 0, fallback: "mean", driverImportance: emptyDrivers, meanTotal };
  }
  const coef = matVec(inv, Xty);
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = X[i].reduce((s, v, j) => s + v * coef[j], 0);
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const residualStd = Math.sqrt(ssRes / Math.max(1, n - k));
  // Driver importance: |b_i| * stdev(X_i)
  const drivers = TOTAL_TIME_PREDICTORS.map((name, idx) => {
    const col = X.map((row) => row[idx + 1]);
    const m = col.reduce((s, v) => s + v, 0) / col.length;
    const sd = Math.sqrt(col.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, col.length - 1));
    return { name, weight: Math.abs(coef[idx + 1]) * sd };
  });
  const sumW = drivers.reduce((s, d) => s + d.weight, 0) || 1;
  const driverImportance = drivers
    .map((d) => ({ name: d.name, weight: +(d.weight / sumW).toFixed(2) }))
    .sort((a, b) => b.weight - a.weight);
  return { spec, coef, r2, n, residualStd, driverImportance, meanTotal };
}

export function predictTotalTime(
  model: TotalTimeModel,
  x: { loadType: any; weight: number; thickness: number; bathTemp: number; material: any; surface: any; length?: number },
): { totalSec: number; confidencePct: number; outOfTempRange: boolean } {
  const v = [
    1,
    encodeLoadType(x.loadType),
    x.weight,
    x.thickness,
    x.bathTemp,
    encodeMaterial(x.material),
    encodeSurface(x.surface),
    x.length ?? 0,
  ];
  const t = model.coef.reduce((s, c, j) => s + c * v[j], 0);
  const totalSec = Math.max(30, Math.round(t));
  // Confidence: blend R² and sample-size score, cap for fallbacks.
  const nScore = Math.min(1, model.n / 20);
  const raw = 0.6 * Math.max(0, Math.min(1, model.r2)) + 0.4 * nScore;
  let pct = Math.round(100 * raw);
  if (model.fallback === "mean") pct = Math.min(pct, 45);
  if (model.fallback === "insufficient") pct = 25;
  const outOfTempRange = !(Number.isFinite(x.bathTemp) && x.bathTemp >= 440 && x.bathTemp <= 465);
  if (outOfTempRange) pct = Math.max(15, pct - 20);
  return { totalSec, confidencePct: pct, outOfTempRange };
}


// Build training rows filtered by required coating spec — used for the
// three per-spec Total-Time models (65 → 72 µm, 87 → 96 µm, 130 → 140 µm).
export function selectTrainingSetForSpec(
  beams: any[],
  spec: number,
  opts: { days?: number; now?: number } = {},
): { rows: TrainingRow[]; days: number } {
  const filteredBeams = beams.filter((b: any) => Number(b?.coating_required) === spec);
  const { rows, days } = selectTrainingSet(filteredBeams, { days: opts.days ?? 7, now: opts.now, minRows: 0, maxDays: opts.days ?? 7 });
  return { rows, days };
}
