// XGBoost-style gradient boosted regression trees for the Dipping module.
//
// The native XGBoost library cannot run in the app runtime, so this is a
// pure-TypeScript implementation of the same algorithm: DEPTH-WISE boosted
// trees grown with the second-order (gradient + hessian) split-gain formula,
// L2 regularisation (lambda), min-child-weight, gamma and shrinkage.
//
// This is deliberately different from ./lgbm.ts (leaf-wise growth, first-order
// SSE splits) so the two engines produce genuinely independent predictions.
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

export type XgbNode =
  | { leaf: number }
  | { f: number; t: number; l: XgbNode; r: XgbNode };

export type XgbEnsemble = {
  base: number;
  lr: number;
  trees: XgbNode[];
};

export type TrainedXgb = {
  kind: "xgb";
  time: XgbEnsemble;
  coating: XgbEnsemble;
  features: string[];
  r2: number;
  coatingR2: number;
  n: number;
  degenerate?: boolean;
};

const PARAMS = {
  trees: 150,
  lr: 0.1,
  maxDepth: 4,
  lambda: 1,
  gamma: 0,
  minChildWeight: 2,
  maxBins: 16,
};

function mean(v: number[]): number {
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}

/** Candidate split thresholds per feature (histogram bin edges). */
function binEdges(values: number[], maxBins = PARAMS.maxBins): number[] {
  const uniq = Array.from(new Set(values)).sort((a, b) => a - b);
  if (uniq.length <= 1) return [];
  if (uniq.length <= maxBins) return uniq.slice(1).map((v, i) => (v + uniq[i]) / 2);
  const out: number[] = [];
  for (let i = 1; i < maxBins; i++) {
    const at = Math.floor((i / maxBins) * uniq.length);
    out.push((uniq[at] + uniq[Math.max(0, at - 1)]) / 2);
  }
  return Array.from(new Set(out));
}

/** Second-order leaf weight: -G / (H + lambda). */
function leafWeight(g: number[], idx: number[]): number {
  const G = idx.reduce((s, i) => s + g[i], 0);
  const H = idx.length; // squared loss → hessian = 1 per sample
  return -G / (H + PARAMS.lambda);
}

/** Structure score for a node: G² / (H + lambda). */
function score(g: number[], idx: number[]): number {
  const G = idx.reduce((s, i) => s + g[i], 0);
  const H = idx.length;
  return (G * G) / (H + PARAMS.lambda);
}

function buildTree(X: number[][], g: number[], idx: number[], depth: number): XgbNode {
  if (depth >= PARAMS.maxDepth || idx.length < PARAMS.minChildWeight * 2) {
    return { leaf: leafWeight(g, idx) };
  }
  const p = X[0]?.length ?? 0;
  const parent = score(g, idx);
  let best: { f: number; t: number; gain: number; l: number[]; r: number[] } | null = null;

  for (let f = 0; f < p; f++) {
    for (const t of binEdges(idx.map((i) => X[i][f]))) {
      const l: number[] = [];
      const r: number[] = [];
      for (const i of idx) (X[i][f] <= t ? l : r).push(i);
      if (l.length < PARAMS.minChildWeight || r.length < PARAMS.minChildWeight) continue;
      const gain = 0.5 * (score(g, l) + score(g, r) - parent) - PARAMS.gamma;
      if (gain > 1e-9 && (!best || gain > best.gain)) best = { f, t, gain, l, r };
    }
  }
  if (!best) return { leaf: leafWeight(g, idx) };
  return {
    f: best.f,
    t: best.t,
    l: buildTree(X, g, best.l, depth + 1),
    r: buildTree(X, g, best.r, depth + 1),
  };
}

function evalTree(node: XgbNode, x: number[]): number {
  let n: XgbNode = node;
  while (!("leaf" in n)) n = x[n.f] <= n.t ? n.l : n.r;
  return n.leaf;
}

export function evalXgbEnsemble(e: XgbEnsemble, x: number[]): number {
  let v = e.base;
  for (const t of e.trees) v += e.lr * evalTree(t, x);
  return v;
}

function fitEnsemble(X: number[][], y: number[]): XgbEnsemble {
  const base = mean(y);
  const pred = y.map(() => base);
  const trees: XgbNode[] = [];
  const idxAll = X.map((_, i) => i);
  for (let k = 0; k < PARAMS.trees; k++) {
    // Squared loss → gradient = pred - y, hessian = 1.
    const grad = y.map((v, i) => pred[i] - v);
    const tree = buildTree(X, grad, idxAll, 0);
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

export function fitXgb(rows: MlrTrainingRow[]): TrainedXgb | null {
  if (!rows.length) return null;
  const X = rows.map((r) => encodeInput(r));
  const yTime = rows.map((r) => Number(r.totalTime));
  const yCoat = rows.map((r) => Number(r.coating));
  const degenerate = rows.length < 8;

  const time = fitEnsemble(X, yTime);
  const Xc = X.map((x, i) => [...x, yTime[i]]);
  const coating = fitEnsemble(Xc, yCoat);

  return {
    kind: "xgb",
    time,
    coating,
    features: [...MLR_FEATURES],
    r2: +r2Of(yTime, X.map((x) => evalXgbEnsemble(time, x))).toFixed(4),
    coatingR2: +r2Of(yCoat, Xc.map((x) => evalXgbEnsemble(coating, x))).toFixed(4),
    n: rows.length,
    degenerate,
  };
}

export function xgbConfidencePct(model: TrainedXgb): number {
  const nScore = Math.min(1, model.n / 40);
  const pct = Math.round((0.65 * model.r2 + 0.35 * nScore) * 100);
  if (model.degenerate) return Math.min(pct, 45);
  return Math.max(10, Math.min(99, pct));
}

export function xgbPredictTotalTime(model: TrainedXgb, input: MlrInput): number {
  return Math.max(1, Math.round(evalXgbEnsemble(model.time, encodeInput(input))));
}

export function xgbPredictCoating(model: TrainedXgb, input: MlrInput, totalTimeSec: number): number {
  const v = evalXgbEnsemble(model.coating, [...encodeInput(input), totalTimeSec]);
  return +v.toFixed(2);
}

/** Tree ensembles cannot be inverted analytically — search the time axis. */
export function xgbTimeForTargetCoating(
  model: TrainedXgb,
  input: MlrInput,
  targetCoating: number,
): number {
  const seed = xgbPredictTotalTime(model, input);
  let bestT = seed;
  let bestErr = Math.abs(xgbPredictCoating(model, input, seed) - targetCoating);
  const lo = Math.max(10, Math.round(seed * 0.4));
  const hi = Math.min(3600, Math.max(lo + 10, Math.round(seed * 2)));
  const step = Math.max(1, Math.round((hi - lo) / 120));
  for (let t = lo; t <= hi; t += step) {
    const err = Math.abs(xgbPredictCoating(model, input, t) - targetCoating);
    if (err < bestErr) {
      bestErr = err;
      bestT = t;
    }
  }
  return bestT;
}

export type XgbPrediction = {
  totalSec: number;
  totalMMSS: string;
  expectedCoating: number;
  targetCoating: number;
  confidencePct: number;
  r2: number;
  n: number;
};

export function xgbPredict(model: TrainedXgb, input: MlrInput): XgbPrediction {
  const target = targetCoatingFor(input.spec);
  const totalSec = xgbTimeForTargetCoating(model, input, target);
  const expected = xgbPredictCoating(model, input, totalSec);
  return {
    totalSec,
    totalMMSS: mmss(totalSec),
    expectedCoating: Number.isFinite(expected) && expected > 0 ? expected : target,
    targetCoating: target,
    confidencePct: xgbConfidencePct(model),
    r2: model.r2,
    n: model.n,
  };
}
