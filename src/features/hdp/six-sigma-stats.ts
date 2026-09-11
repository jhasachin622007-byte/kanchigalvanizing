// Pure statistics helpers for the Six Sigma Dashboard.
// All functions are side-effect free and unit-testable.
import { productionDayIdTz, productionShift } from "./production-day";

export const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const mode = (xs: number[]): number => {
  if (!xs.length) return 0;
  const counts = new Map<number, number>();
  let best = xs[0];
  let bestN = 0;
  for (const x of xs) {
    const r = Math.round(x * 10) / 10;
    const n = (counts.get(r) || 0) + 1;
    counts.set(r, n);
    if (n > bestN) {
      bestN = n;
      best = r;
    }
  }
  return best;
};

export const stdDev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
};

// Process capability indices
export const cp = (sd: number, lsl: number, usl: number): number | null =>
  sd > 0 ? (usl - lsl) / (6 * sd) : null;

export const cpk = (m: number, sd: number, lsl: number, usl: number): number | null =>
  sd > 0 ? Math.min((usl - m) / (3 * sd), (m - lsl) / (3 * sd)) : null;

// Within-subgroup sigma via MR-bar / 1.128 (individuals chart)
export const sigmaWithin = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  let mr = 0;
  for (let i = 1; i < xs.length; i++) mr += Math.abs(xs[i] - xs[i - 1]);
  return mr / (xs.length - 1) / 1.128;
};

// X-bar (individuals) control limits using MR-bar
export type ControlLimits = { cl: number; ucl: number; lcl: number; sd: number };

export const xBarLimits = (xs: number[]): ControlLimits => {
  const m = mean(xs);
  const sd = sigmaWithin(xs) || stdDev(xs);
  return { cl: m, ucl: m + 3 * sd, lcl: m - 3 * sd, sd };
};

// Western Electric rule violations. Returns indices flagged.
export const westernElectric = (xs: number[], cl: number, sd: number): Set<number> => {
  const out = new Set<number>();
  if (!sd || !xs.length) return out;
  const z = xs.map((x) => (x - cl) / sd);
  // Rule 1: 1 point beyond 3σ
  z.forEach((v, i) => {
    if (Math.abs(v) > 3) out.add(i);
  });
  // Rule 2: 2 of 3 consecutive beyond 2σ (same side)
  for (let i = 2; i < z.length; i++) {
    const w = [z[i - 2], z[i - 1], z[i]];
    const pos = w.filter((v) => v > 2).length;
    const neg = w.filter((v) => v < -2).length;
    if (pos >= 2 || neg >= 2) out.add(i);
  }
  // Rule 3: 4 of 5 beyond 1σ (same side)
  for (let i = 4; i < z.length; i++) {
    const w = z.slice(i - 4, i + 1);
    if (w.filter((v) => v > 1).length >= 4) out.add(i);
    if (w.filter((v) => v < -1).length >= 4) out.add(i);
  }
  // Rule 4: 8-in-a-row same side of center
  for (let i = 7; i < z.length; i++) {
    const w = z.slice(i - 7, i + 1);
    if (w.every((v) => v > 0) || w.every((v) => v < 0)) out.add(i);
  }
  return out;
};

export const pearson = (xs: number[], ys: number[]): number => {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const d = Math.sqrt(dx * dy);
  return d > 0 ? num / d : 0;
};

// Simple linear regression y = a + b*x.
export const linreg = (xs: number[], ys: number[]) => {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { a: 0, b: 0 };
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  const b = den ? num / den : 0;
  return { a: my - b * mx, b };
};

export const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return s[base + 1] != null ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
};

export const histogram = (xs: number[], bins = 10) => {
  if (!xs.length) return [] as { bin: number; count: number }[];
  const mn = Math.min(...xs);
  const mx = Math.max(...xs);
  const w = (mx - mn) / bins || 1;
  const out = Array.from({ length: bins }, (_, i) => ({
    bin: +(mn + (i + 0.5) * w).toFixed(1),
    count: 0,
  }));
  for (const x of xs) {
    let idx = Math.floor((x - mn) / w);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    out[idx].count++;
  }
  return out;
};

// Normal density (for overlaying normal curve on histogram)
export const normalPdf = (x: number, mu: number, sd: number): number => {
  if (sd <= 0) return 0;
  const z = (x - mu) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
};

export const cpkRating = (v: number | null) => {
  if (v == null) return { label: "—", color: "#9CA3AF", emoji: "⚪" };
  if (v >= 1.33) return { label: "Capable", color: "#22C55E", emoji: "🟢" };
  if (v >= 1.0) return { label: "Marginal", color: "#FBBF24", emoji: "🟡" };
  return { label: "Not Capable", color: "#EF4444", emoji: "🔴" };
};

// Production-Day + Shift logic (anchored on a timestamp, usually immersion start).
// A = 06:00–13:59, B = 14:00–21:59, C = 22:00–05:59.
// Times before 06:00 belong to the PREVIOUS calendar date (C-shift carry-over).
const toIso = (ts?: string | number | Date | null): string | null => {
  if (!ts) return null;
  const d = new Date(ts as any);
  return isNaN(+d) ? null : d.toISOString();
};

export const productionDayOf = (ts?: string | number | Date | null): string =>
  productionDayIdTz(toIso(ts));

export const shiftOf = (ts?: string | number | Date | null): "A" | "B" | "C" | "" =>
  productionShift(toIso(ts));

// Population standard deviation (divides by N, not N-1). Use for
// long-term/complete-dataset variation (e.g. all qualifying jobs).
export const stdDevPop = (xs: number[]): number => {
  if (xs.length < 1) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length;
  return Math.sqrt(v);
};

// Process performance (long-term, uses overall stdev).
export const pp = (sd: number, lsl: number, usl: number): number | null =>
  sd > 0 ? (usl - lsl) / (6 * sd) : null;

export const ppk = (m: number, sd: number, lsl: number, usl: number): number | null =>
  sd > 0 ? Math.min((usl - m) / (3 * sd), (m - lsl) / (3 * sd)) : null;

