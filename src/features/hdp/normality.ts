// Pure normality-test helpers (Shapiro-Wilk + Anderson-Darling).
// No dependencies — safe to import anywhere.

export type NormalityMethod = "Shapiro-Wilk" | "Anderson-Darling";

export interface NormalityResult {
  n: number;
  mean: number;
  median: number;
  sd: number;
  min: number;
  max: number;
  method: NormalityMethod | null;
  statistic: number | null;
  pValue: number | null;
  normal: boolean | null;
  interpretation: string;
}

const ALPHA = 0.05;

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const sdSample = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
};

// Abramowitz & Stegun 26.2.17 normal CDF.
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// Acklam's inverse normal CDF approximation.
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Shapiro-Wilk W statistic with the Royston (1992) coefficient and p-value
 * approximation. Valid for 3 <= n <= 5000.
 */
export function shapiroWilk(input: number[]): { W: number; p: number } | null {
  const x = [...input].sort((a, b) => a - b);
  const n = x.length;
  if (n < 3) return null;
  const m: number[] = [];
  for (let i = 1; i <= n; i++) m.push(normInv((i - 0.375) / (n + 0.25)));
  const mSq = m.reduce((s, v) => s + v * v, 0);
  const rsn = 1 / Math.sqrt(n);
  const a = new Array<number>(n).fill(0);
  const an = -2.706056 * Math.pow(rsn, 5) + 4.434685 * Math.pow(rsn, 4) - 2.071190 * Math.pow(rsn, 3)
    - 0.147981 * Math.pow(rsn, 2) + 0.221157 * rsn + m[n - 1] / Math.sqrt(mSq);
  a[n - 1] = an;
  a[0] = -an;
  let phi: number;
  if (n > 5) {
    const an1 = -3.582633 * Math.pow(rsn, 5) + 5.682633 * Math.pow(rsn, 4) - 1.752461 * Math.pow(rsn, 3)
      - 0.293762 * Math.pow(rsn, 2) + 0.042981 * rsn + m[n - 2] / Math.sqrt(mSq);
    a[n - 2] = an1;
    a[1] = -an1;
    phi = (mSq - 2 * m[n - 1] * m[n - 1] - 2 * m[n - 2] * m[n - 2]) /
      (1 - 2 * an * an - 2 * an1 * an1);
    for (let i = 2; i < n - 2; i++) a[i] = m[i] / Math.sqrt(phi);
  } else {
    phi = (mSq - 2 * m[n - 1] * m[n - 1]) / (1 - 2 * an * an);
    for (let i = 1; i < n - 1; i++) a[i] = m[i] / Math.sqrt(phi);
  }

  const xbar = mean(x);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += a[i] * x[i];
    den += (x[i] - xbar) * (x[i] - xbar);
  }
  if (den <= 0) return null;
  let W = (num * num) / den;
  if (W > 1) W = 1;

  // Royston p-value
  let p: number;
  if (n === 3) {
    const pi6 = 1.909859;
    const stqr = 1.047198;
    const w = Math.max(Math.min(W, 1), 0.75);
    p = pi6 * (Math.asin(Math.sqrt(w)) - stqr);
    p = Math.max(0, Math.min(1, p));
  } else {
    const ln = Math.log(n);
    let mu: number, sigma: number, z: number;
    if (n <= 11) {
      const gamma = -2.273 + 0.459 * n;
      mu = 0.5440 - 0.39978 * n + 0.025054 * n * n - 0.0006714 * n * n * n;
      sigma = Math.exp(1.3822 - 0.77857 * n + 0.062767 * n * n - 0.0020322 * n * n * n);
      const y = -Math.log(gamma - Math.log(1 - W));
      z = (y - mu) / sigma;
    } else {
      mu = -1.5861 - 0.31082 * ln - 0.083751 * ln * ln + 0.0038915 * ln * ln * ln;
      sigma = Math.exp(-0.4803 - 0.082676 * ln + 0.0030302 * ln * ln);
      z = (Math.log(1 - W) - mu) / sigma;
    }
    p = 1 - normCdf(z);
    p = Math.max(0, Math.min(1, p));
  }
  return { W, p };
}

/**
 * Anderson-Darling test against a normal distribution with estimated
 * mean/sd, with the standard D'Agostino adjustment and p-value formula.
 */
export function andersonDarling(input: number[]): { A2: number; p: number } | null {
  const x = [...input].sort((a, b) => a - b);
  const n = x.length;
  if (n < 8) return null;
  const m = mean(x);
  const s = sdSample(x);
  if (!(s > 0)) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const zi = normCdf((x[i] - m) / s);
    const zn = normCdf((x[n - 1 - i] - m) / s);
    const a = Math.min(Math.max(zi, 1e-12), 1 - 1e-12);
    const b = Math.min(Math.max(zn, 1e-12), 1 - 1e-12);
    sum += (2 * (i + 1) - 1) * (Math.log(a) + Math.log(1 - b));
  }
  const A2 = -n - sum / n;
  const A2star = A2 * (1 + 0.75 / n + 2.25 / (n * n));
  let p: number;
  if (A2star >= 0.6) p = Math.exp(1.2937 - 5.709 * A2star + 0.0186 * A2star * A2star);
  else if (A2star >= 0.34) p = Math.exp(0.9177 - 4.279 * A2star - 1.38 * A2star * A2star);
  else if (A2star >= 0.2) p = 1 - Math.exp(-8.318 + 42.796 * A2star - 59.938 * A2star * A2star);
  else p = 1 - Math.exp(-13.436 + 101.14 * A2star - 223.73 * A2star * A2star);
  p = Math.max(0, Math.min(1, p));
  return { A2, p };
}

/**
 * Full descriptive + normality summary. Shapiro-Wilk for N <= 50,
 * Anderson-Darling for larger samples.
 */
export function normalityReport(values: number[]): NormalityResult {
  const xs = (values || []).map(Number).filter((v) => Number.isFinite(v));
  const n = xs.length;
  const base = {
    n,
    mean: n ? mean(xs) : 0,
    median: n ? median(xs) : 0,
    sd: sdSample(xs),
    min: n ? Math.min(...xs) : 0,
    max: n ? Math.max(...xs) : 0,
  };
  if (n < 3) {
    return { ...base, method: null, statistic: null, pValue: null, normal: null,
      interpretation: "Not enough data — at least 3 readings are needed to run a normality test." };
  }
  const useSW = n <= 50;
  const res = useSW ? shapiroWilk(xs) : (andersonDarling(xs) ?? shapiroWilk(xs));
  if (!res) {
    return { ...base, method: null, statistic: null, pValue: null, normal: null,
      interpretation: "Test could not be computed — all readings are identical (zero variation)." };
  }
  const method: NormalityMethod = useSW || !("A2" in res) ? "Shapiro-Wilk" : "Anderson-Darling";
  const statistic = "W" in res ? res.W : res.A2;
  const p = res.p;
  const normal = p > ALPHA;
  const interpretation = normal
    ? `P-value ${p.toFixed(4)} > 0.05 — the coating readings follow a normal distribution, so Cp/Cpk and the control limits shown here are statistically valid.`
    : `P-value ${p.toFixed(4)} ≤ 0.05 — the coating readings are NOT normally distributed. Capability indices may be misleading; check for mixed batches, outliers or process shifts before acting on Cp/Cpk.`;
  return { ...base, method, statistic, pValue: p, normal, interpretation };
}
