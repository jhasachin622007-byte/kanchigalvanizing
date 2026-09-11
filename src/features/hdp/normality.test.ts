// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { normalityReport, shapiroWilk, andersonDarling, normCdf, normInv } from "./normality";

// Deterministic pseudo-normal sample (Box-Muller on a seeded LCG).
function normalSample(n: number, mu = 100, sd = 5): number[] {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(rnd(), 1e-9);
    const u2 = rnd();
    out.push(mu + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
    out.push(mu + sd * Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2));
  }
  return out.slice(0, n);
}

describe("normal helpers", () => {
  it("normCdf is calibrated", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 5);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
  });
  it("normInv inverts normCdf", () => {
    expect(normInv(0.975)).toBeCloseTo(1.96, 2);
    expect(normInv(0.5)).toBeCloseTo(0, 6);
  });
});

describe("shapiroWilk", () => {
  it("returns null below n = 3", () => {
    expect(shapiroWilk([1, 2])).toBeNull();
  });
  it("accepts a normal sample", () => {
    const r = shapiroWilk(normalSample(30))!;
    expect(r.W).toBeGreaterThan(0.9);
    expect(r.p).toBeGreaterThan(0.05);
  });
  it("rejects a strongly skewed sample", () => {
    const skew = Array.from({ length: 30 }, (_, i) => Math.exp(i / 3));
    const r = shapiroWilk(skew)!;
    expect(r.p).toBeLessThan(0.05);
  });
});

describe("andersonDarling", () => {
  it("returns null below n = 8", () => {
    expect(andersonDarling([1, 2, 3])).toBeNull();
  });
  it("accepts a normal sample", () => {
    const r = andersonDarling(normalSample(80))!;
    expect(r.p).toBeGreaterThan(0.05);
  });
  it("rejects a skewed sample", () => {
    const skew = Array.from({ length: 80 }, (_, i) => Math.exp(i / 8));
    const r = andersonDarling(skew)!;
    expect(r.p).toBeLessThan(0.05);
  });
});

describe("normalityReport", () => {
  it("reports insufficient data", () => {
    const r = normalityReport([1, 2]);
    expect(r.method).toBeNull();
    expect(r.normal).toBeNull();
    expect(r.interpretation).toMatch(/at least 3/);
  });
  it("uses Shapiro-Wilk at N <= 50", () => {
    const r = normalityReport(normalSample(40));
    expect(r.method).toBe("Shapiro-Wilk");
    expect(r.normal).toBe(true);
    expect(r.n).toBe(40);
  });
  it("uses Anderson-Darling above N = 50", () => {
    const r = normalityReport(normalSample(120));
    expect(r.method).toBe("Anderson-Darling");
  });
  it("computes descriptive statistics", () => {
    const r = normalityReport([90, 95, 100, 105, 110]);
    expect(r.mean).toBeCloseTo(100, 6);
    expect(r.median).toBe(100);
    expect(r.min).toBe(90);
    expect(r.max).toBe(110);
    expect(r.sd).toBeCloseTo(7.9057, 3);
  });
  it("handles zero-variance data", () => {
    const r = normalityReport([5, 5, 5, 5, 5]);
    expect(r.normal).toBeNull();
    expect(r.interpretation).toMatch(/identical/);
  });
});
