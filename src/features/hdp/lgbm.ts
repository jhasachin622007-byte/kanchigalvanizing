// LightGBM-style gradient boosted regression trees for the Dipping module.
//
// The native LightGBM library cannot run in the app runtime, so this is a
// pure-TypeScript implementation of the same algorithm family: leaf-wise
// gradient boosting over histogram-binned features with a learning rate and
// shrinkage, trained on the Admin-uploaded CSV.
//
// Predicts TOTAL DIPPING TIME (seconds); a companion ensemble predicts the
// expected average coating for a candidate time.

import {
  encodeInput,
  targetCoatingFor,
  mmss,
  type MlrInput,
  type MlrTrainingRow,
  MLR_FEATURES,
} from "./mlr";

export type LgbmNode =
  | { leaf: number }
  | { f: number; t: number; l: LgbmNode; r: LgbmNode };

export type LgbmEnsemble = {
  base: number;
  lr: number;
  trees: LgbmNode[];
};

export type TrainedLgbm = {
  kind: "lgbm";
  time: LgbmEnsemble;
  coating: LgbmEnsemble;
  features: string[];
  r2: number;
  coatingR2: number;
  n: number;
  degenerate?: boolean;
};

const PARAMS = { trees: 120, lr: 0.1, maxLeaves: 8, minSamples: 3 };

function mean(v: number[]): number {
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}

/** Candidate split thresholds per feature (histogram bin edges). */
function binEdges(values: number[], maxBins = 16): number[] {
  const uniq = Array.from(new Set(values)).sort((a, b) => a - b);
  if (uniq.length <= 1) return [];
  if (uniq.length <= maxBins) {
    return uniq.slice(1).map((v, i) => (v + uniq[i]) / 2);
  }
  const out: number[] = [];
  for (let i = 1; i < maxBins; i++) {
    const q = uniq[Math.floor((i / maxBins) * uniq.length)];
    const p = uniq[Math.max(0, Math.floor((i / maxBins) * uniq.length) - 1)];
    out.push((q + p) / 2);
  }
  return Array.from(new Set(out));
}

function buildTree(X: number[][], g: number[], idx: number[], leavesLeft: number): LgbmNode {
  const target = mean(idx.map((i) => g[i]));
  if (leavesLeft <= 1 || idx.length < PARAMS.minSamples * 2) return { leaf: target };

  const p = X[0]?.length ?? 0;
  let best: { f: number; t: number; gain: number; l: number[]; r: number[] } | null = null;
  const parentSSE = idx.reduce((s, i) => s + (g[i] - target) ** 2, 0);

  for (let f = 0; f < p; f++) {
    const edges = binEdges(idx.map((i) => X[i][f]));
    for (const t of edges) {
      const l: number[] = [];
      const r: number[] = [];
      for (const i of idx) (X[i][f] <= t ? l : r).push(i);
      if (l.length < PARAMS.minSamples || r.length < PARAMS.minSamples) continue;
      const lm = mean(l.map((i) => g[i]));
      const rm = mean(r.map((i) => g[i]));
      const sse =
        l.reduce((s, i) => s + (g[i] - lm) ** 2, 0) + r.reduce((s, i) => s + (g[i] - rm) ** 2, 0);
      const gain = parentSSE - sse;
      if (gain > 1e-9 && (!best || gain > best.gain)) best = { f, t, gain, l, r };
    }
  }
  if (!best) return { leaf: target };

  // Leaf-wise growth: give the larger child the bigger leaf budget.
  const leftBudget = Math.max(1, Math.round(((leavesLeft - 1) * best.l.length) / idx.length));
  const rightBudget = Math.max(1, leavesLeft - leftBudget);
  return {
    f: best.f,
    t: best.t,
    l: buildTree(X, g, best.l, leftBudget),
    r: buildTree(X, g, best.r, rightBudget),
  };
}

function evalTree(node: LgbmNode, x: number[]): number {
  let n: LgbmNode = node;
  while (!("leaf" in n)) n = x[n.f] <= n.t ? n.l : n.r;
  return n.leaf;
}

export function evalEnsemble(e: LgbmEnsemble, x: number[]): number {
  let v = e.base;
  for (const t of e.trees) v += e.lr * evalTree(t, x);
  return v;
}

function fitEnsemble(X: number[][], y: number[]): LgbmEnsemble {
  const base = mean(y);
  const pred = y.map(() => base);
  const trees: LgbmNode[] = [];
  const idxAll = X.map((_, i) => i);
  for (let k = 0; k < PARAMS.trees; k++) {
    const resid = y.map((v, i) => v - pred[i]);
    const tree = buildTree(X, resid, idxAll, PARAMS.maxLeaves);
    trees.push(tree);
    for (let i = 0; i < X.length; i++) pred[i] += PARAMS.lr * evalTree(tree, X[i]);
  }
  return { base, lr: PARAMS.lr, trees };
}

function r2Of(y: number[], pred: number[]): number {
  const m = mean(y);
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < y.length; i++) {
    ssTot += (y[i] - m) ** 2;
    ssRes += (y[i] - pred[i]) ** 2;
  }
  if (ssTot <= 1e-12) return 0;
  return Math.max(0, Math.min(1, 1 - ssRes / ssTot));
}

export function fitLgbm(rows: MlrTrainingRow[]): TrainedLgbm | null {
  if (!rows.length) return null;
  const X = rows.map((r) => encodeInput(r));
  const yTime = rows.map((r) => Number(r.totalTime));
  const yCoat = rows.map((r) => Number(r.coating));
  const degenerate = rows.length < 8;

  const time = fitEnsemble(X, yTime);
  const Xc = X.map((x, i) => [...x, yTime[i]]);
  const coating = fitEnsemble(Xc, yCoat);

  return {
    kind: "lgbm",
    time,
    coating,
    features: [...MLR_FEATURES],
    r2: +r2Of(yTime, X.map((x) => evalEnsemble(time, x))).toFixed(4),
    coatingR2: +r2Of(yCoat, Xc.map((x) => evalEnsemble(coating, x))).toFixed(4),
    n: rows.length,
    degenerate,
  };
}

export function lgbmConfidencePct(model: TrainedLgbm): number {
  const nScore = Math.min(1, model.n / 40);
  const pct = Math.round((0.65 * model.r2 + 0.35 * nScore) * 100);
  if (model.degenerate) return Math.min(pct, 45);
  return Math.max(10, Math.min(99, pct));
}

function encFor(model: TrainedLgbm, input: MlrInput): number[] {
  return encodeInput(input);
}

export function lgbmPredictTotalTime(model: TrainedLgbm, input: MlrInput): number {
  return Math.max(1, Math.round(evalEnsemble(model.time, encFor(model, input))));
}

export function lgbmPredictCoating(model: TrainedLgbm, input: MlrInput, totalTimeSec: number): number {
  const v = evalEnsemble(model.coating, [...encFor(model, input), totalTimeSec]);
  return +v.toFixed(2);
}

/**
 * Search the time axis for the dipping time whose predicted coating is
 * closest to the target. Tree ensembles cannot be inverted analytically.
 */
export function lgbmTimeForTargetCoating(
  model: TrainedLgbm,
  input: MlrInput,
  targetCoating: number,
): number {
  const seed = lgbmPredictTotalTime(model, input);
  let bestT = seed;
  let bestErr = Math.abs(lgbmPredictCoating(model, input, seed) - targetCoating);
  const lo = Math.max(10, Math.round(seed * 0.4));
  const hi = Math.min(3600, Math.max(lo + 10, Math.round(seed * 2)));
  const step = Math.max(1, Math.round((hi - lo) / 120));
  for (let t = lo; t <= hi; t += step) {
    const err = Math.abs(lgbmPredictCoating(model, input, t) - targetCoating);
    if (err < bestErr) {
      bestErr = err;
      bestT = t;
    }
  }
  return bestT;
}

export type LgbmPrediction = {
  totalSec: number;
  totalMMSS: string;
  expectedCoating: number;
  targetCoating: number;
  confidencePct: number;
  r2: number;
  n: number;
};

export function lgbmPredict(model: TrainedLgbm, input: MlrInput): LgbmPrediction {
  const target = targetCoatingFor(input.spec);
  const totalSec = lgbmTimeForTargetCoating(model, input, target);
  const expected = lgbmPredictCoating(model, input, totalSec);
  return {
    totalSec,
    totalMMSS: mmss(totalSec),
    expectedCoating: Number.isFinite(expected) && expected > 0 ? expected : target,
    targetCoating: target,
    confidencePct: lgbmConfidencePct(model),
    r2: model.r2,
    n: model.n,
  };
}
