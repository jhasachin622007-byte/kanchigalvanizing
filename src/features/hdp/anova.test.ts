// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { oneWayAnova, tukeyHSD, twoWayAnova, fPValue, qCritical } from "./anova";

describe("fPValue", () => {
  it("large F gives tiny p", () => {
    expect(fPValue(50, 2, 20)).toBeLessThan(0.001);
  });
  it("F≈1 gives p near 0.5", () => {
    const p = fPValue(1, 5, 20);
    expect(p).toBeGreaterThan(0.3);
    expect(p).toBeLessThan(0.6);
  });
});

describe("oneWayAnova", () => {
  it("returns null when fewer than two valid groups", () => {
    expect(oneWayAnova({ A: [1, 2] })).toBeNull();
  });

  it("detects a significant mean difference", () => {
    const a = oneWayAnova({
      Shift_A: [88, 90, 91, 89, 92],
      Shift_B: [95, 97, 96, 94, 98],
      Shift_C: [100, 102, 101, 99, 103],
    });
    expect(a).not.toBeNull();
    expect(a!.k).toBe(3);
    expect(a!.N).toBe(15);
    expect(a!.F).toBeGreaterThan(10);
    expect(a!.pValue).toBeLessThan(0.05);
    expect(a!.significant).toBe(true);
  });

  it("non-significant when groups overlap heavily", () => {
    const a = oneWayAnova({
      X: [90, 91, 92, 89, 90],
      Y: [90, 92, 91, 90, 91],
      Z: [91, 90, 92, 90, 91],
    });
    expect(a!.significant).toBe(false);
    expect(a!.pValue).toBeGreaterThan(0.05);
  });
});

describe("tukeyHSD", () => {
  it("flags pairs whose means diverge beyond qCritical", () => {
    const a = oneWayAnova({
      A: [88, 90, 91, 89, 92],
      B: [95, 97, 96, 94, 98],
      C: [100, 102, 101, 99, 103],
    })!;
    const pairs = tukeyHSD(a);
    expect(pairs.length).toBe(3);
    expect(pairs.every((p) => p.significant)).toBe(true);
    const ac = pairs.find((p) => p.a === "A" && p.b === "C")!;
    expect(Math.abs(ac.meanDiff)).toBeGreaterThan(9);
  });

  it("does not flag near-identical groups", () => {
    const a = oneWayAnova({
      A: [90, 91, 92, 89, 90],
      B: [90, 92, 91, 90, 91],
    })!;
    const pairs = tukeyHSD(a);
    expect(pairs[0].significant).toBe(false);
  });
});

describe("qCritical", () => {
  it("matches published values (k=3, df=20)", () => {
    expect(Math.abs(qCritical(3, 20) - 3.58)).toBeLessThan(0.01);
  });
  it("interpolates between df rows", () => {
    const q = qCritical(3, 25);
    expect(q).toBeGreaterThan(qCritical(3, 30));
    expect(q).toBeLessThan(qCritical(3, 20));
  });
});

describe("twoWayAnova", () => {
  it("detects strong factor-A effect", () => {
    const rows = [
      { a: "MS", b: "Normal", value: 88 }, { a: "MS", b: "Normal", value: 90 },
      { a: "MS", b: "Rusted", value: 89 }, { a: "MS", b: "Rusted", value: 91 },
      { a: "HT", b: "Normal", value: 110 }, { a: "HT", b: "Normal", value: 112 },
      { a: "HT", b: "Rusted", value: 111 }, { a: "HT", b: "Rusted", value: 113 },
    ];
    const r = twoWayAnova(rows)!;
    expect(r.factorA.levels).toEqual(["HT", "MS"]);
    expect(r.factorA.p).toBeLessThan(0.001);
    expect(r.factorB.p).toBeGreaterThan(0.05);
  });

  it("returns null on insufficient data", () => {
    expect(twoWayAnova([{ a: "A", b: "B", value: 1 }])).toBeNull();
  });
});
