// CatBoost-style gradient boosted regression for the Dipping module.
//
// The native CatBoost library cannot run in the app runtime, so this is a
// pure-TypeScript implementation of the same algorithm:
//   • NATIVE CATEGORICAL HANDLING — Material Type, Load Type and Surface
//     Condition are encoded with ORDERED TARGET STATISTICS (running mean of
//     the target over a random permutation, smoothed with a prior), instead of
//     one-hot expansion.
//   • SYMMETRIC (OBLIVIOUS) TREES — every level of a tree uses one shared
//     split for all nodes, which is the CatBoost default.
//
// This is deliberately different from ./xgb.ts (depth-wise, per-node splits)
// and ./lgbm.ts (leaf-wise growth), so all engines stay independent.
//
// Predicts TOTAL DIPPING TIME (seconds); a companion ensemble predicts the
// expected average coating for a candidate time.

import {
  targetCoatingFor,
  mmss,
  type MlrInput,
  type MlrTrainingRow,
} from "./mlr";

/** Raw categorical columns handled natively (never one-hot encoded). */
export const CAT_CATEGORICAL = ["loadType", "material", "surface"] as const;
/** Numeric columns used as-is. */
export const CAT_NUMERIC = ["thickness", "spec", "bathTemp", "weight", "length"] as const;

export const CAT_FEATURES: string[] = [...CAT_CATEGORICAL, ...CAT_NUMERIC];

export type CatTargetStats = {
  /** category key → smoothed target statistic, per categorical column. */
  maps: Record<string, Record<string, number>>;
  prior: number;
};

/** Oblivious tree: one (feature, threshold) pair per depth level. */
export type CatObliviousTree = {
  splits: { f: number; t: number }[];
  /** 2^depth leaf values indexed by the split bit pattern. */
  leaves: number[];
};

export type CatEnsemble = {
  base: number;
  lr: number;
  trees: CatObliviousTree[];
};

export type TrainedCatboost = {
  kind: "cat";
  time: CatEnsemble;
  coating: CatEnsemble;
  /** Ordered target statistics learned for the time target. */
  statsTime: CatTargetStats;
  /** Ordered target statistics learned for the coating target. */
  statsCoating: CatTargetStats;
  features: string[];
  r2: number;
  coatingR2: number;
  n: number;
  degenerate?: boolean;
};

const PARAMS = {
  trees: 200,
  lr: 0.08,
  depth: 4,
  lambda: 3, // l2_leaf_reg
  maxBins: 16,
  smoothing: 10, // prior weight for target statistics
};

function mean(v: number[]): number {
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}

function catKey(v: any): string {
  return String(v ?? "").trim().toLowerCase() || "—";
}

/** Deterministic pseudo-random permutation (CatBoost's ordering trick). */
function permutation(n: number, seed = 12345): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = seed;
  for (let i = n - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

/**
 * Ordered target statistics: for each row, the category encoding uses only the
 * target values of rows appearing EARLIER in a random permutation, which is
 * what prevents CatBoost's target leakage. The final per-category map (full
 * data) is stored for inference.
 */
export function fitTargetStats(
  rows: { cats: string[]; y: number }[],
  colCount: number,
): { stats: CatTargetStats; encoded: number[][] } {
  const prior = mean(rows.map((r) => r.y));
  const order = permutation(rows.length);
  const encoded: number[][] = rows.map(() => new Array(colCount).fill(prior));

  for (let c = 0; c < colCount; c++) {
    const sum = new Map<string, number>();
    const cnt = new Map<string, number>();
    for (const i of order) {
      const k = rows[i].cats[c];
      const s = sum.get(k) ?? 0;
      const n = cnt.get(k) ?? 0;
      encoded[i][c] = (s + PARAMS.smoothing * prior) / (n + PARAMS.smoothing);
      sum.set(k, s + rows[i].y);
      cnt.set(k, n + 1);
    }
  }

  // Final maps over the full dataset, used for prediction.
  const maps: Record<string, Record<string, number>> = {};
  for (let c = 0; c < colCount; c++) {
    const sum = new Map<string, number>();
    const cnt = new Map<string, number>();
    for (const r of rows) {
      const k = r.cats[c];
      sum.set(k, (sum.get(k) ?? 0) + r.y);
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
    const m: Record<string, number> = {};
    for (const k of sum.keys()) {
      m[k] = (sum.get(k)! + PARAMS.smoothing * prior) / (cnt.get(k)! + PARAMS.smoothing);
    }
    maps[CAT_CATEGORICAL[c] ?? `cat${c}`] = m;
  }
  return { stats: { maps, prior }, encoded };
}

function catsOf(i: MlrInput): string[] {
  return [catKey(i.loadType), catKey(i.material), catKey(i.surface)];
}

function numsOf(i: MlrInput): number[] {
  return [
    Number(i.thickness) || 0,
    Number(i.spec) || 0,
    Number(i.bathTemp) || 0,
    Number(i.weight) || 0,
    Number(i.length) || 0,
  ];
}

/** Encode one input for inference using the trained target statistics. */
export function encodeCat(stats: CatTargetStats, input: MlrInput): number[] {
  const cats = catsOf(input);
  const enc = cats.map((k, c) => {
    const col = CAT_CATEGORICAL[c];
    const m = stats.maps[col] ?? {};
    // Unseen category falls back to the prior — supports new combinations.
    return m[k] ?? stats.prior;
  });
  return [...enc, ...numsOf(input)];
}

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

function leafValue(g: number[], idx: number[]): number {
  if (!idx.length) return 0;
  const G = idx.reduce((s, i) => s + g[i], 0);
  return -G / (idx.length + PARAMS.lambda);
}

function sse(g: number[], idx: number[]): number {
  if (!idx.length) return 0;
  const G = idx.reduce((s, i) => s + g[i], 0);
  return (G * G) / (idx.length + PARAMS.lambda);
}

/** Grow one oblivious tree: pick a single best split per level, shared by all nodes. */
function buildObliviousTree(X: number[][], g: number[]): CatObliviousTree {
  const p = X[0]?.length ?? 0;
  const splits: { f: number; t: number }[] = [];
  // groups[k] = row indices in leaf k at the current depth
  let groups: number[][] = [X.map((_, i) => i)];

  for (let d = 0; d < PARAMS.depth; d++) {
    let best: { f: number; t: number; score: number } | null = null;
    for (let f = 0; f < p; f++) {
      const edges = binEdges(X.map((x) => x[f]));
      for (const t of edges) {
        let s = 0;
        for (const grp of groups) {
          const l: number[] = [];
          const r: number[] = [];
          for (const i of grp) (X[i][f] <= t ? l : r).push(i);
          s += sse(g, l) + sse(g, r);
        }
        if (!best || s > best.score) best = { f, t, score: s };
      }
    }
    if (!best) break;
    splits.push({ f: best.f, t: best.t });
    const next: number[][] = [];
    for (const grp of groups) {
      const l: number[] = [];
      const r: number[] = [];
      for (const i of grp) (X[i][best.f] <= best.t ? l : r).push(i);
      next.push(l, r);
    }
    groups = next;
  }

  return { splits, leaves: groups.map((grp) => leafValue(g, grp)) };
}

function leafIndex(tree: CatObliviousTree, x: number[]): number {
  let idx = 0;
  for (const s of tree.splits) idx = idx * 2 + (x[s.f] <= s.t ? 0 : 1);
  return idx;
}

export function evalCatEnsemble(e: CatEnsemble, x: number[]): number {
  let v = e.base;
  for (const t of e.trees) v += e.lr * (t.leaves[leafIndex(t, x)] ?? 0);
  return v;
}

function fitEnsemble(X: number[][], y: number[]): CatEnsemble {
  const base = mean(y);
  const pred = y.map(() => base);
  const trees: CatObliviousTree[] = [];
  for (let k = 0; k < PARAMS.trees; k++) {
    const grad = y.map((v, i) => pred[i] - v);
    const tree = buildObliviousTree(X, grad);
    trees.push(tree);
    for (let i = 0; i < X.length; i++) pred[i] += PARAMS.lr * (tree.leaves[leafIndex(tree, X[i])] ?? 0);
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

export function fitCatboost(rows: MlrTrainingRow[]): TrainedCatboost | null {
  if (!rows.length) return null;
  const yTime = rows.map((r) => Number(r.totalTime));
  const yCoat = rows.map((r) => Number(r.coating));
  const cats = rows.map((r) => catsOf(r));
  const nums = rows.map((r) => numsOf(r));
  const degenerate = rows.length < 8;

  const nCat = CAT_CATEGORICAL.length;
  const t = fitTargetStats(cats.map((c, i) => ({ cats: c, y: yTime[i] })), nCat);
  const c = fitTargetStats(cats.map((cc, i) => ({ cats: cc, y: yCoat[i] })), nCat);

  const Xt = t.encoded.map((e, i) => [...e, ...nums[i]]);
  const time = fitEnsemble(Xt, yTime);

  // Coating model additionally sees the total time.
  const Xc = c.encoded.map((e, i) => [...e, ...nums[i], yTime[i]]);
  const coating = fitEnsemble(Xc, yCoat);

  // Inference-time encoding (full-data maps) is what R² should reflect.
  const XtEval = rows.map((r) => encodeCat(t.stats, r));
  const XcEval = rows.map((r, i) => [...encodeCat(c.stats, r), yTime[i]]);

  return {
    kind: "cat",
    time,
    coating,
    statsTime: t.stats,
    statsCoating: c.stats,
    features: [...CAT_FEATURES],
    r2: +r2Of(yTime, XtEval.map((x) => evalCatEnsemble(time, x))).toFixed(4),
    coatingR2: +r2Of(yCoat, XcEval.map((x) => evalCatEnsemble(coating, x))).toFixed(4),
    n: rows.length,
    degenerate,
  };
}

export function catboostConfidencePct(model: TrainedCatboost): number {
  const nScore = Math.min(1, model.n / 40);
  const pct = Math.round((0.65 * model.r2 + 0.35 * nScore) * 100);
  if (model.degenerate) return Math.min(pct, 45);
  return Math.max(10, Math.min(99, pct));
}

export function catboostPredictTotalTime(model: TrainedCatboost, input: MlrInput): number {
  return Math.max(1, Math.round(evalCatEnsemble(model.time, encodeCat(model.statsTime, input))));
}

export function catboostPredictCoating(
  model: TrainedCatboost,
  input: MlrInput,
  totalTimeSec: number,
): number {
  const v = evalCatEnsemble(model.coating, [...encodeCat(model.statsCoating, input), totalTimeSec]);
  return +v.toFixed(2);
}

/** Tree ensembles cannot be inverted analytically — search the time axis. */
export function catboostTimeForTargetCoating(
  model: TrainedCatboost,
  input: MlrInput,
  targetCoating: number,
): number {
  const seed = catboostPredictTotalTime(model, input);
  let bestT = seed;
  let bestErr = Math.abs(catboostPredictCoating(model, input, seed) - targetCoating);
  const lo = Math.max(10, Math.round(seed * 0.4));
  const hi = Math.min(3600, Math.max(lo + 10, Math.round(seed * 2)));
  const step = Math.max(1, Math.round((hi - lo) / 120));
  for (let t = lo; t <= hi; t += step) {
    const err = Math.abs(catboostPredictCoating(model, input, t) - targetCoating);
    if (err < bestErr) {
      bestErr = err;
      bestT = t;
    }
  }
  return bestT;
}

export type CatboostPrediction = {
  totalSec: number;
  totalMMSS: string;
  expectedCoating: number;
  targetCoating: number;
  confidencePct: number;
  r2: number;
  n: number;
};

export function catboostPredict(model: TrainedCatboost, input: MlrInput): CatboostPrediction {
  const target = targetCoatingFor(input.spec);
  const totalSec = catboostTimeForTargetCoating(model, input, target);
  const expected = catboostPredictCoating(model, input, totalSec);
  return {
    totalSec,
    totalMMSS: mmss(totalSec),
    expectedCoating: Number.isFinite(expected) && expected > 0 ? expected : target,
    targetCoating: target,
    confidencePct: catboostConfidencePct(model),
    r2: model.r2,
    n: model.n,
  };
}
