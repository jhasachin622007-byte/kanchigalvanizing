// One-Way / Two-Way ANOVA + Tukey HSD post-hoc.
// Pure numeric; used by the Six Sigma dashboard to compare Shift / Operator /
// Load-Type / Coating-Spec means for the currently-filtered dataset.

export type OneWayAnova = {
  groups: { label: string; n: number; mean: number; variance: number }[];
  k: number;               // number of groups
  N: number;               // total observations
  grandMean: number;
  ssBetween: number;
  ssWithin: number;
  ssTotal: number;
  dfBetween: number;
  dfWithin: number;
  msBetween: number;
  msWithin: number;
  F: number;
  pValue: number;          // right-tail p under F(dfB, dfW)
  significant: boolean;    // p < 0.05
};

export type TukeyPair = {
  a: string; b: string;
  meanDiff: number;
  se: number;
  q: number;               // studentized range statistic
  qCritical: number;       // critical q at α=0.05
  significant: boolean;    // |q| > qCritical
};

export type TwoWayAnova = {
  factorA: { levels: string[]; SS: number; df: number; MS: number; F: number; p: number };
  factorB: { levels: string[]; SS: number; df: number; MS: number; F: number; p: number };
  interaction: { SS: number; df: number; MS: number; F: number; p: number } | null;
  error: { SS: number; df: number; MS: number };
  total: { SS: number; df: number };
  N: number;
};

// ── Statistical helpers ────────────────────────────────────────────────
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const variance = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
};

// Log-gamma via Lanczos approximation.
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Regularized incomplete beta I_x(a,b) via continued fraction (Numerical Recipes).
function betaCF(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-7;
  const FPMIN = 1e-30;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betaCF(a, b, x)) / a;
  return 1 - (bt * betaCF(b, a, 1 - x)) / b;
}

// Right-tail p-value for F distribution.
export function fPValue(F: number, df1: number, df2: number): number {
  if (!isFinite(F) || F <= 0 || df1 <= 0 || df2 <= 0) return 1;
  const x = df2 / (df2 + df1 * F);
  return betaI(x, df2 / 2, df1 / 2);
}

// Studentized-range critical value at α=0.05.
// Lookup table (rows = df within, cols = k groups 2..8) from standard Q tables.
const Q05_TABLE: Record<number, number[]> = {
  5:   [3.64, 4.60, 5.22, 5.67, 6.03, 6.33, 6.58],
  6:   [3.46, 4.34, 4.90, 5.30, 5.63, 5.90, 6.12],
  7:   [3.34, 4.16, 4.68, 5.06, 5.36, 5.61, 5.82],
  8:   [3.26, 4.04, 4.53, 4.89, 5.17, 5.40, 5.60],
  10:  [3.15, 3.88, 4.33, 4.65, 4.91, 5.12, 5.30],
  12:  [3.08, 3.77, 4.20, 4.51, 4.75, 4.95, 5.12],
  15:  [3.01, 3.67, 4.08, 4.37, 4.60, 4.78, 4.94],
  20:  [2.95, 3.58, 3.96, 4.23, 4.45, 4.62, 4.77],
  24:  [2.92, 3.53, 3.90, 4.17, 4.37, 4.54, 4.68],
  30:  [2.89, 3.49, 3.85, 4.10, 4.30, 4.46, 4.60],
  40:  [2.86, 3.44, 3.79, 4.04, 4.23, 4.39, 4.52],
  60:  [2.83, 3.40, 3.74, 3.98, 4.16, 4.31, 4.44],
  120: [2.80, 3.36, 3.68, 3.92, 4.10, 4.24, 4.36],
  1000:[2.77, 3.31, 3.63, 3.86, 4.03, 4.17, 4.29],
};

export function qCritical(k: number, df: number): number {
  const kIdx = Math.max(0, Math.min(6, k - 2));
  const keys = Object.keys(Q05_TABLE).map(Number).sort((a, b) => a - b);
  if (df <= keys[0]) return Q05_TABLE[keys[0]][kIdx];
  if (df >= keys[keys.length - 1]) return Q05_TABLE[keys[keys.length - 1]][kIdx];
  for (let i = 0; i < keys.length - 1; i++) {
    const lo = keys[i], hi = keys[i + 1];
    if (df >= lo && df <= hi) {
      const t = (df - lo) / (hi - lo);
      return Q05_TABLE[lo][kIdx] * (1 - t) + Q05_TABLE[hi][kIdx] * t;
    }
  }
  return Q05_TABLE[1000][kIdx];
}

// ── One-Way ANOVA ──────────────────────────────────────────────────────
export function oneWayAnova(named: Record<string, number[]>): OneWayAnova | null {
  const entries = Object.entries(named)
    .map(([label, xs]) => ({ label, xs: xs.filter((v) => Number.isFinite(v)) }))
    .filter((g) => g.xs.length >= 2);
  if (entries.length < 2) return null;
  const groups = entries.map((g) => ({
    label: g.label, n: g.xs.length, mean: mean(g.xs), variance: variance(g.xs),
  }));
  const N = groups.reduce((s, g) => s + g.n, 0);
  const grandMean = groups.reduce((s, g) => s + g.mean * g.n, 0) / N;
  const ssBetween = groups.reduce((s, g) => s + g.n * (g.mean - grandMean) ** 2, 0);
  const ssWithin  = groups.reduce((s, g) => s + (g.n - 1) * g.variance, 0);
  const ssTotal   = ssBetween + ssWithin;
  const dfBetween = groups.length - 1;
  const dfWithin  = N - groups.length;
  const msBetween = ssBetween / dfBetween;
  const msWithin  = ssWithin / (dfWithin || 1);
  const F = msWithin > 0 ? msBetween / msWithin : 0;
  const pValue = fPValue(F, dfBetween, dfWithin);
  return {
    groups, k: groups.length, N, grandMean,
    ssBetween, ssWithin, ssTotal,
    dfBetween, dfWithin, msBetween, msWithin,
    F, pValue, significant: pValue < 0.05,
  };
}

// ── Tukey HSD ──────────────────────────────────────────────────────────
export function tukeyHSD(a: OneWayAnova): TukeyPair[] {
  const pairs: TukeyPair[] = [];
  const qc = qCritical(a.k, Math.max(1, a.dfWithin));
  for (let i = 0; i < a.groups.length; i++) {
    for (let j = i + 1; j < a.groups.length; j++) {
      const gi = a.groups[i], gj = a.groups[j];
      const nH = 2 / (1 / gi.n + 1 / gj.n); // harmonic mean of pair sizes
      const se = Math.sqrt(a.msWithin / nH);
      const diff = gi.mean - gj.mean;
      const q = se > 0 ? Math.abs(diff) / se : 0;
      pairs.push({
        a: gi.label, b: gj.label,
        meanDiff: diff, se, q, qCritical: qc,
        significant: q > qc,
      });
    }
  }
  return pairs;
}

// ── Two-Way ANOVA (balanced or unbalanced, with replication) ───────────
export function twoWayAnova(
  rows: { a: string; b: string; value: number }[],
): TwoWayAnova | null {
  const clean = rows.filter((r) => Number.isFinite(r.value) && r.a && r.b);
  if (clean.length < 4) return null;
  const A = Array.from(new Set(clean.map((r) => r.a))).sort();
  const B = Array.from(new Set(clean.map((r) => r.b))).sort();
  if (A.length < 2 || B.length < 2) return null;
  const cells: Record<string, number[]> = {};
  const perA: Record<string, number[]> = {}, perB: Record<string, number[]> = {};
  clean.forEach((r) => {
    (cells[`${r.a}||${r.b}`] ??= []).push(r.value);
    (perA[r.a] ??= []).push(r.value);
    (perB[r.b] ??= []).push(r.value);
  });
  const N = clean.length;
  const grand = mean(clean.map((r) => r.value));
  const ssA = A.reduce((s, a) => s + perA[a].length * (mean(perA[a]) - grand) ** 2, 0);
  const ssB = B.reduce((s, b) => s + perB[b].length * (mean(perB[b]) - grand) ** 2, 0);
  let ssCells = 0, ssWithin = 0;
  let hasReplication = false;
  for (const a of A) for (const b of B) {
    const cell = cells[`${a}||${b}`] || [];
    if (cell.length === 0) continue;
    if (cell.length > 1) hasReplication = true;
    const cm = mean(cell);
    ssCells += cell.length * (cm - grand) ** 2;
    cell.forEach((v) => { ssWithin += (v - cm) ** 2; });
  }
  const ssInter = ssCells - ssA - ssB;
  const dfA = A.length - 1;
  const dfB = B.length - 1;
  const dfInter = dfA * dfB;
  const dfError = hasReplication ? N - A.length * B.length : dfA * dfB;
  const errSS = hasReplication ? ssWithin : Math.max(0, ssInter);
  const msError = errSS / Math.max(1, dfError);
  const msA = ssA / Math.max(1, dfA);
  const msB = ssB / Math.max(1, dfB);
  const fA = msError > 0 ? msA / msError : 0;
  const fB = msError > 0 ? msB / msError : 0;
  const interaction = hasReplication ? (() => {
    const msI = ssInter / Math.max(1, dfInter);
    const fI = msError > 0 ? msI / msError : 0;
    return { SS: ssInter, df: dfInter, MS: msI, F: fI, p: fPValue(fI, dfInter, dfError) };
  })() : null;
  return {
    factorA: { levels: A, SS: ssA, df: dfA, MS: msA, F: fA, p: fPValue(fA, dfA, dfError) },
    factorB: { levels: B, SS: ssB, df: dfB, MS: msB, F: fB, p: fPValue(fB, dfB, dfError) },
    interaction,
    error: { SS: errSS, df: dfError, MS: msError },
    total: { SS: ssA + ssB + ssInter + (hasReplication ? ssWithin : 0), df: N - 1 },
    N,
  };
}
