// "zinccore" — deep-learning (neural network) engine for the Dipping module.
//
// A pure-TypeScript multi-layer perceptron with learned embeddings for the
// categorical inputs (Material Type, Load Type, Surface Condition). Native DL
// runtimes cannot run in the app runtime, so the network — and its
// backpropagation / Adam optimiser — are implemented here directly. The model
// is small enough to train on a historical CSV inside the browser in seconds.
//
// Shared trunk, two heads:
//   trunk : [numeric(5) + embeddings(9)] → 32 → 16   (ReLU + dropout)
//   time  : trunk → Total Dipping Time (seconds)
//   coat  : [trunk, normalised time] → Average Coating (µm)
//
// The coating head is conditioned on time, so the engine can answer "what
// coating would we get at time t?" the same way the tree engines do.

import {
  encodeLoad,
  encodeMaterial,
  encodeSurface,
  targetCoatingFor,
  mmss,
  type MlrInput,
  type MlrTrainingRow,
  MLR_FEATURES,
} from "./mlr";

// ── Hyperparameters ─────────────────────────────────────────────────────────
export const ZC_PARAMS = {
  embDim: 3,
  hidden1: 32,
  hidden2: 16,
  dropout: 0.1,
  lr: 0.01,
  epochs: 400,
  batch: 16,
  valSplit: 0.15,
  patience: 40,
  mcPasses: 20,
  seed: 20260809,
};

const LOAD_CARD = 6;   // encodeLoad → 0..5
const MAT_CARD = 3;    // encodeMaterial → 0..2
const SURF_CARD = 4;   // encodeSurface → 0..3
const NUM_DIM = 5;     // thickness, spec, bathTemp, weight, length

export type ZcMatrix = number[][];

export type TrainedZinccore = {
  kind: "zc";
  /** Embedding tables, one row per category level. */
  embLoad: ZcMatrix;
  embMat: ZcMatrix;
  embSurf: ZcMatrix;
  W1: ZcMatrix; b1: number[];
  W2: ZcMatrix; b2: number[];
  Wt: number[]; bt: number;
  Wc: number[]; bc: number;
  /** Standardisation statistics. */
  xMean: number[]; xStd: number[];
  tMean: number; tStd: number;
  cMean: number; cStd: number;
  features: string[];
  dropout: number;
  epochsRun: number;
  r2: number;
  coatingR2: number;
  n: number;
  degenerate?: boolean;
};

// ── Deterministic RNG ───────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(v: number[]): number {
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}
function std(v: number[], m: number): number {
  if (v.length < 2) return 1;
  const s = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length);
  return s > 1e-9 ? s : 1;
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

function zeros(n: number): number[] { return new Array(n).fill(0); }
function zeroMat(r: number, c: number): ZcMatrix {
  return Array.from({ length: r }, () => zeros(c));
}
function randMat(r: number, c: number, rnd: () => number): ZcMatrix {
  // He initialisation for ReLU layers.
  const scale = Math.sqrt(2 / Math.max(1, c));
  return Array.from({ length: r }, () =>
    Array.from({ length: c }, () => (rnd() * 2 - 1) * scale),
  );
}

// ── Adam state ──────────────────────────────────────────────────────────────
type Adam = { m: number[]; v: number[]; t: number };
function adamInit(n: number): Adam { return { m: zeros(n), v: zeros(n), t: 0 }; }
function adamStep(p: number[], g: number[], s: Adam, lr: number) {
  s.t++;
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const c1 = 1 - Math.pow(b1, s.t);
  const c2 = 1 - Math.pow(b2, s.t);
  for (let i = 0; i < p.length; i++) {
    s.m[i] = b1 * s.m[i] + (1 - b1) * g[i];
    s.v[i] = b2 * s.v[i] + (1 - b2) * g[i] * g[i];
    p[i] -= (lr * (s.m[i] / c1)) / (Math.sqrt(s.v[i] / c2) + eps);
  }
}

// ── Feature extraction ──────────────────────────────────────────────────────
export type ZcRawInput = {
  num: number[];
  load: number;
  mat: number;
  surf: number;
};

export function zcRaw(i: MlrInput): ZcRawInput {
  return {
    num: [
      Number(i.thickness) || 0,
      Number(i.spec) || 0,
      Number(i.bathTemp) || 0,
      Number(i.weight) || 0,
      Number(i.length) || 0,
    ],
    load: Math.min(LOAD_CARD - 1, Math.max(0, encodeLoad(i.loadType))),
    mat: Math.min(MAT_CARD - 1, Math.max(0, encodeMaterial(i.material))),
    surf: Math.min(SURF_CARD - 1, Math.max(0, encodeSurface(i.surface))),
  };
}

function inputVector(m: TrainedZinccore, r: ZcRawInput): number[] {
  const x: number[] = [];
  for (let k = 0; k < NUM_DIM; k++) x.push((r.num[k] - m.xMean[k]) / m.xStd[k]);
  x.push(...m.embLoad[r.load], ...m.embMat[r.mat], ...m.embSurf[r.surf]);
  return x;
}

// ── Forward pass ────────────────────────────────────────────────────────────
type Forward = {
  x: number[];
  z1: number[]; a1: number[]; d1: number[];
  z2: number[]; a2: number[]; d2: number[];
  tHat: number;
};

function forward(
  m: TrainedZinccore,
  r: ZcRawInput,
  opts: { dropout: boolean; rnd?: () => number },
): Forward {
  const x = inputVector(m, r);
  const h1 = m.W1.length;
  const z1 = zeros(h1); const a1 = zeros(h1); const d1 = zeros(h1);
  for (let j = 0; j < h1; j++) {
    let s = m.b1[j];
    const row = m.W1[j];
    for (let k = 0; k < x.length; k++) s += row[k] * x[k];
    z1[j] = s;
    const act = s > 0 ? s : 0;
    const keep = opts.dropout && opts.rnd ? (opts.rnd() < m.dropout ? 0 : 1 / (1 - m.dropout)) : 1;
    d1[j] = keep;
    a1[j] = act * keep;
  }
  const h2 = m.W2.length;
  const z2 = zeros(h2); const a2 = zeros(h2); const d2 = zeros(h2);
  for (let j = 0; j < h2; j++) {
    let s = m.b2[j];
    const row = m.W2[j];
    for (let k = 0; k < h1; k++) s += row[k] * a1[k];
    z2[j] = s;
    const act = s > 0 ? s : 0;
    const keep = opts.dropout && opts.rnd ? (opts.rnd() < m.dropout ? 0 : 1 / (1 - m.dropout)) : 1;
    d2[j] = keep;
    a2[j] = act * keep;
  }
  let tHat = m.bt;
  for (let j = 0; j < h2; j++) tHat += m.Wt[j] * a2[j];
  return { x, z1, a1, d1, z2, a2, d2, tHat };
}

function coatHead(m: TrainedZinccore, a2: number[], tNorm: number): number {
  let v = m.bc;
  for (let j = 0; j < a2.length; j++) v += m.Wc[j] * a2[j];
  v += m.Wc[a2.length] * tNorm;
  return v;
}

// ── Training ────────────────────────────────────────────────────────────────
function blankModel(rnd: () => number, inDim: number): TrainedZinccore {
  return {
    kind: "zc",
    embLoad: randMat(LOAD_CARD, ZC_PARAMS.embDim, rnd),
    embMat: randMat(MAT_CARD, ZC_PARAMS.embDim, rnd),
    embSurf: randMat(SURF_CARD, ZC_PARAMS.embDim, rnd),
    W1: randMat(ZC_PARAMS.hidden1, inDim, rnd),
    b1: zeros(ZC_PARAMS.hidden1),
    W2: randMat(ZC_PARAMS.hidden2, ZC_PARAMS.hidden1, rnd),
    b2: zeros(ZC_PARAMS.hidden2),
    Wt: randMat(1, ZC_PARAMS.hidden2, rnd)[0],
    bt: 0,
    Wc: randMat(1, ZC_PARAMS.hidden2 + 1, rnd)[0],
    bc: 0,
    xMean: zeros(NUM_DIM),
    xStd: new Array(NUM_DIM).fill(1),
    tMean: 0, tStd: 1,
    cMean: 0, cStd: 1,
    features: [...MLR_FEATURES],
    dropout: ZC_PARAMS.dropout,
    epochsRun: 0,
    r2: 0, coatingR2: 0, n: 0,
  };
}

function cloneModel(m: TrainedZinccore): TrainedZinccore {
  return JSON.parse(JSON.stringify(m)) as TrainedZinccore;
}

type FitOpts = { epochs?: number; lr?: number; init?: TrainedZinccore | null; seed?: number };

export function fitZinccore(rows: MlrTrainingRow[], opts: FitOpts = {}): TrainedZinccore | null {
  const clean = rows.filter(
    (r) => Number.isFinite(Number(r.totalTime)) && Number(r.totalTime) > 0 && Number.isFinite(Number(r.coating)),
  );
  if (!clean.length) return null;

  const rnd = mulberry32(opts.seed ?? ZC_PARAMS.seed);
  const raws = clean.map((r) => zcRaw(r));
  const inDim = NUM_DIM + 3 * ZC_PARAMS.embDim;
  const m = opts.init ? cloneModel(opts.init) : blankModel(rnd, inDim);

  // Standardisation (recomputed on a full fit, preserved when fine-tuning).
  if (!opts.init) {
    for (let k = 0; k < NUM_DIM; k++) {
      const col = raws.map((r) => r.num[k]);
      m.xMean[k] = mean(col);
      m.xStd[k] = std(col, m.xMean[k]);
    }
    const ts = clean.map((r) => Number(r.totalTime));
    const cs = clean.map((r) => Number(r.coating));
    m.tMean = mean(ts); m.tStd = std(ts, m.tMean);
    m.cMean = mean(cs); m.cStd = std(cs, m.cMean);
  }

  const yT = clean.map((r) => (Number(r.totalTime) - m.tMean) / m.tStd);
  const yC = clean.map((r) => (Number(r.coating) - m.cMean) / m.cStd);

  // Train / validation split.
  const order = raws.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const nVal = clean.length >= 12 ? Math.max(1, Math.round(clean.length * ZC_PARAMS.valSplit)) : 0;
  const valIdx = order.slice(0, nVal);
  const trIdx = nVal ? order.slice(nVal) : order;

  // Adam states — flat views over each parameter tensor.
  const flat = (mat: ZcMatrix) => mat.length * (mat[0]?.length ?? 0);
  const st = {
    W1: adamInit(flat(m.W1)), b1: adamInit(m.b1.length),
    W2: adamInit(flat(m.W2)), b2: adamInit(m.b2.length),
    Wt: adamInit(m.Wt.length), bt: adamInit(1),
    Wc: adamInit(m.Wc.length), bc: adamInit(1),
    eL: adamInit(flat(m.embLoad)), eM: adamInit(flat(m.embMat)), eS: adamInit(flat(m.embSurf)),
  };

  const lr = opts.lr ?? ZC_PARAMS.lr;
  const epochs = opts.epochs ?? ZC_PARAMS.epochs;
  const h1 = ZC_PARAMS.hidden1;
  const h2 = ZC_PARAMS.hidden2;

  const valLoss = (): number => {
    if (!valIdx.length) return 0;
    let s = 0;
    for (const i of valIdx) {
      const f = forward(m, raws[i], { dropout: false });
      const c = coatHead(m, f.a2, yT[i]);
      s += (f.tHat - yT[i]) ** 2 + (c - yC[i]) ** 2;
    }
    return s / valIdx.length;
  };

  let best = cloneModel(m);
  let bestLoss = Infinity;
  let stale = 0;
  let epochsRun = 0;

  for (let ep = 0; ep < epochs; ep++) {
    // Shuffle training order each epoch.
    for (let i = trIdx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [trIdx[i], trIdx[j]] = [trIdx[j], trIdx[i]];
    }
    for (let bStart = 0; bStart < trIdx.length; bStart += ZC_PARAMS.batch) {
      const batch = trIdx.slice(bStart, bStart + ZC_PARAMS.batch);
      const gW1 = zeroMat(h1, m.W1[0].length); const gb1 = zeros(h1);
      const gW2 = zeroMat(h2, h1); const gb2 = zeros(h2);
      const gWt = zeros(h2); let gbt = 0;
      const gWc = zeros(h2 + 1); let gbc = 0;
      const gEL = zeroMat(LOAD_CARD, ZC_PARAMS.embDim);
      const gEM = zeroMat(MAT_CARD, ZC_PARAMS.embDim);
      const gES = zeroMat(SURF_CARD, ZC_PARAMS.embDim);

      for (const i of batch) {
        const r = raws[i];
        const f = forward(m, r, { dropout: true, rnd });
        const cHat = coatHead(m, f.a2, yT[i]);
        const dT = (2 * (f.tHat - yT[i])) / batch.length;
        const dC = (2 * (cHat - yC[i])) / batch.length;

        // Heads.
        gbt += dT; gbc += dC;
        const dA2 = zeros(h2);
        for (let j = 0; j < h2; j++) {
          gWt[j] += dT * f.a2[j];
          gWc[j] += dC * f.a2[j];
          dA2[j] += dT * m.Wt[j] + dC * m.Wc[j];
        }
        gWc[h2] += dC * yT[i];

        // Layer 2.
        const dZ2 = zeros(h2);
        for (let j = 0; j < h2; j++) dZ2[j] = dA2[j] * f.d2[j] * (f.z2[j] > 0 ? 1 : 0);
        const dA1 = zeros(h1);
        for (let j = 0; j < h2; j++) {
          gb2[j] += dZ2[j];
          for (let k = 0; k < h1; k++) {
            gW2[j][k] += dZ2[j] * f.a1[k];
            dA1[k] += dZ2[j] * m.W2[j][k];
          }
        }

        // Layer 1.
        const dZ1 = zeros(h1);
        for (let j = 0; j < h1; j++) dZ1[j] = dA1[j] * f.d1[j] * (f.z1[j] > 0 ? 1 : 0);
        const dX = zeros(f.x.length);
        for (let j = 0; j < h1; j++) {
          gb1[j] += dZ1[j];
          for (let k = 0; k < f.x.length; k++) {
            gW1[j][k] += dZ1[j] * f.x[k];
            dX[k] += dZ1[j] * m.W1[j][k];
          }
        }

        // Embeddings (input slots NUM_DIM..).
        const E = ZC_PARAMS.embDim;
        for (let d = 0; d < E; d++) {
          gEL[r.load][d] += dX[NUM_DIM + d];
          gEM[r.mat][d] += dX[NUM_DIM + E + d];
          gES[r.surf][d] += dX[NUM_DIM + 2 * E + d];
        }
      }

      const applyMat = (p: ZcMatrix, g: ZcMatrix, s: Adam) => {
        const pf = p.flat(); const gf = g.flat();
        adamStep(pf, gf, s, lr);
        const c = p[0].length;
        for (let i = 0; i < p.length; i++) for (let j = 0; j < c; j++) p[i][j] = pf[i * c + j];
      };
      applyMat(m.W1, gW1, st.W1);
      adamStep(m.b1, gb1, st.b1, lr);
      applyMat(m.W2, gW2, st.W2);
      adamStep(m.b2, gb2, st.b2, lr);
      adamStep(m.Wt, gWt, st.Wt, lr);
      const btArr = [m.bt]; adamStep(btArr, [gbt], st.bt, lr); m.bt = btArr[0];
      adamStep(m.Wc, gWc, st.Wc, lr);
      const bcArr = [m.bc]; adamStep(bcArr, [gbc], st.bc, lr); m.bc = bcArr[0];
      applyMat(m.embLoad, gEL, st.eL);
      applyMat(m.embMat, gEM, st.eM);
      applyMat(m.embSurf, gES, st.eS);
    }

    epochsRun = ep + 1;
    if (valIdx.length && ep % 5 === 4) {
      const l = valLoss();
      if (l < bestLoss - 1e-6) { bestLoss = l; best = cloneModel(m); stale = 0; }
      else { stale += 5; if (stale >= ZC_PARAMS.patience) break; }
    }
  }

  const final = valIdx.length && bestLoss < Infinity ? best : m;
  final.epochsRun = epochsRun;
  final.n = clean.length;
  final.degenerate = clean.length < 12;

  const predT: number[] = [];
  const predC: number[] = [];
  for (let i = 0; i < raws.length; i++) {
    const f = forward(final, raws[i], { dropout: false });
    predT.push(f.tHat * final.tStd + final.tMean);
    predC.push(coatHead(final, f.a2, yT[i]) * final.cStd + final.cMean);
  }
  final.r2 = +r2Of(clean.map((r) => Number(r.totalTime)), predT).toFixed(4);
  final.coatingR2 = +r2Of(clean.map((r) => Number(r.coating)), predC).toFixed(4);
  return final;
}

/** Incremental learning: continue training the existing weights on new rows. */
export function fineTuneZinccore(
  model: TrainedZinccore,
  rows: MlrTrainingRow[],
  epochs = 60,
): TrainedZinccore | null {
  return fitZinccore(rows, { init: model, epochs, lr: ZC_PARAMS.lr / 3 });
}

// ── Inference ───────────────────────────────────────────────────────────────

export function zinccorePredictTotalTime(model: TrainedZinccore, input: MlrInput): number {
  const f = forward(model, zcRaw(input), { dropout: false });
  return Math.max(1, Math.round(f.tHat * model.tStd + model.tMean));
}

export function zinccorePredictCoating(
  model: TrainedZinccore,
  input: MlrInput,
  totalTimeSec: number,
): number {
  const f = forward(model, zcRaw(input), { dropout: false });
  const tNorm = (Number(totalTimeSec) - model.tMean) / model.tStd;
  const v = coatHead(model, f.a2, tNorm) * model.cStd + model.cMean;
  return +v.toFixed(2);
}

/** Search the time axis for the time that lands on the target coating. */
export function zinccoreTimeForTargetCoating(
  model: TrainedZinccore,
  input: MlrInput,
  targetCoating: number,
): number {
  const seed = zinccorePredictTotalTime(model, input);
  let bestT = seed;
  let bestErr = Math.abs(zinccorePredictCoating(model, input, seed) - targetCoating);
  const lo = Math.max(10, Math.round(seed * 0.4));
  const hi = Math.min(3600, Math.max(lo + 10, Math.round(seed * 2)));
  const step = Math.max(1, Math.round((hi - lo) / 120));
  for (let t = lo; t <= hi; t += step) {
    const err = Math.abs(zinccorePredictCoating(model, input, t) - targetCoating);
    if (err < bestErr) { bestErr = err; bestT = t; }
  }
  return bestT;
}

/**
 * Monte-Carlo dropout: run several stochastic forward passes and read the
 * spread of the predictions as an uncertainty estimate.
 */
export function zinccoreUncertainty(
  model: TrainedZinccore,
  input: MlrInput,
  passes = ZC_PARAMS.mcPasses,
): { meanSec: number; sdSec: number; lowSec: number; highSec: number } {
  const rnd = mulberry32(ZC_PARAMS.seed + 7);
  const r = zcRaw(input);
  const out: number[] = [];
  for (let i = 0; i < passes; i++) {
    const f = forward(model, r, { dropout: true, rnd });
    out.push(f.tHat * model.tStd + model.tMean);
  }
  const m = mean(out);
  const sd = out.length > 1 ? Math.sqrt(out.reduce((s, x) => s + (x - m) ** 2, 0) / out.length) : 0;
  return {
    meanSec: Math.round(m),
    sdSec: Math.round(sd),
    lowSec: Math.max(1, Math.round(m - 1.64 * sd)),
    highSec: Math.round(m + 1.64 * sd),
  };
}

export function zinccoreConfidencePct(model: TrainedZinccore, input?: MlrInput): number {
  const nScore = Math.min(1, model.n / 40);
  let base = 0.6 * model.r2 + 0.4 * nScore;
  if (input) {
    const u = zinccoreUncertainty(model, input);
    const rel = u.meanSec > 0 ? u.sdSec / u.meanSec : 1;
    // Tight MC spread lifts confidence, wide spread pulls it down.
    base *= Math.max(0.4, 1 - Math.min(1, rel * 3));
  }
  const pct = Math.round(base * 100);
  if (model.degenerate) return Math.min(pct, 45);
  return Math.max(10, Math.min(99, pct));
}

/**
 * Input attribution: perturb each input and read how much the predicted time
 * moves. Used by the Learning panel to explain misses.
 */
export function zinccoreAttribution(
  model: TrainedZinccore,
  input: MlrInput,
): { feature: string; impactSec: number }[] {
  const basis = zinccorePredictTotalTime(model, input);
  const probes: { feature: string; alt: MlrInput }[] = [
    { feature: "Thickness", alt: { ...input, thickness: Number(input.thickness) * 1.1 } },
    { feature: "Specific Coating", alt: { ...input, spec: Number(input.spec) * 1.1 } },
    { feature: "Bath Temperature", alt: { ...input, bathTemp: Number(input.bathTemp) + 2 } },
    { feature: "Weight", alt: { ...input, weight: (Number(input.weight) || 0) * 1.1 } },
    { feature: "Length", alt: { ...input, length: (Number(input.length) || 0) * 1.1 } },
    { feature: "Material Type", alt: { ...input, material: input.material === "HT" ? "MS" : "HT" } },
    { feature: "Surface Condition", alt: { ...input, surface: input.surface === "Normal" ? "Rusted" : "Normal" } },
  ];
  return probes
    .map((p) => ({ feature: p.feature, impactSec: Math.round(zinccorePredictTotalTime(model, p.alt) - basis) }))
    .sort((a, b) => Math.abs(b.impactSec) - Math.abs(a.impactSec));
}

/**
 * Minimum-zinc time: the SHORTEST dipping time whose predicted coating still
 * clears the specification floor plus a safety margin. The 65-75 / 87-95 /
 * 130-140 bands are an acceptance requirement, not a target — every micron
 * above the floor is zinc we paid for and did not have to.
 */
export function zinccoreMinZincTime(
  model: TrainedZinccore,
  input: MlrInput,
  marginUm = 2,
): { sec: number; coating: number } {
  const floor = Number(input.spec) || 0;
  const need = floor + Math.max(0, marginUm);
  const seed = zinccorePredictTotalTime(model, input);
  const lo = Math.max(10, Math.round(seed * 0.3));
  const hi = Math.min(3600, Math.max(lo + 10, Math.round(seed * 2.2)));
  const step = Math.max(1, Math.round((hi - lo) / 160));
  let bestSec = seed;
  let bestCoat = zinccorePredictCoating(model, input, seed);
  let found = false;
  for (let t = lo; t <= hi; t += step) {
    const c = zinccorePredictCoating(model, input, t);
    if (c >= need) { bestSec = t; bestCoat = c; found = true; break; }
  }
  if (!found) { bestSec = hi; bestCoat = zinccorePredictCoating(model, input, hi); }
  return { sec: bestSec, coating: +bestCoat.toFixed(2) };
}

export type ZinccorePrediction = {
  totalSec: number;
  totalMMSS: string;
  expectedCoating: number;
  targetCoating: number;
  confidencePct: number;
  r2: number;
  n: number;
  lowSec: number;
  highSec: number;
  /** Leanest time that still clears the specification floor. */
  minZincSec: number;
  minZincMMSS: string;
  minZincCoating: number;
  /** Coating (µm) saved by dipping to the lean time instead of the target. */
  zincSavedUm: number;
  /** Set when the output fails an internal plausibility check. */
  implausible?: string;
};

export function zinccorePredict(model: TrainedZinccore, input: MlrInput): ZinccorePrediction {
  const target = targetCoatingFor(input.spec);
  const totalSec = zinccoreTimeForTargetCoating(model, input, target);
  const expectedRaw = zinccorePredictCoating(model, input, totalSec);
  const u = zinccoreUncertainty(model, input);
  const expected = Number.isFinite(expectedRaw) && expectedRaw > 0 ? expectedRaw : target;
  const lean = zinccoreMinZincTime(model, input);

  let implausible: string | undefined;
  if (!Number.isFinite(totalSec) || totalSec <= 0) implausible = "Predicted time is not a usable value.";
  else if (totalSec > 3000) implausible = "Predicted time is far outside the normal dipping range.";
  else if (expected < 20 || expected > 400) implausible = "Expected coating is outside the plausible range.";

  return {
    totalSec,
    totalMMSS: mmss(totalSec),
    expectedCoating: expected,
    targetCoating: target,
    confidencePct: zinccoreConfidencePct(model, input),
    r2: model.r2,
    n: model.n,
    lowSec: u.lowSec,
    highSec: u.highSec,
    minZincSec: lean.sec,
    minZincMMSS: mmss(lean.sec),
    minZincCoating: lean.coating,
    zincSavedUm: +Math.max(0, expected - lean.coating).toFixed(2),
    implausible,
  };
}

