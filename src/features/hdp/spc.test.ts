import { describe, it, expect } from "vitest";
import {
  iMR, xBarR, subgroupBySize, detectViolations, violatedIndices, RULE_LABEL,
} from "./spc";

describe("iMR", () => {
  it("returns null for <2 points", () => {
    expect(iMR([])).toBeNull();
    expect(iMR([5])).toBeNull();
  });
  it("computes I and MR limits", () => {
    const r = iMR([10, 12, 11, 13, 12])!;
    expect(r.i.cl).toBeCloseTo(11.6, 2);
    expect(r.mrBar).toBeCloseTo(1.5, 2);
    // UCL_I = xBar + 2.66*mrBar
    expect(r.i.ucl).toBeCloseTo(11.6 + 2.66 * 1.5, 2);
    // UCL_MR = 3.267 * mrBar
    expect(r.mr.ucl).toBeCloseTo(3.267 * 1.5, 2);
    expect(r.mr.lcl).toBe(0);
  });
});

describe("xBarR", () => {
  it("returns null when too few subgroups", () => {
    expect(xBarR([[1, 2, 3, 4, 5]])).toBeNull();
  });
  it("computes X-bar and R limits for n=5", () => {
    const g = [
      [10, 11, 12, 10, 11],
      [11, 12, 13, 11, 12],
      [10, 10, 11, 12, 12],
    ];
    const r = xBarR(g)!;
    expect(r.subgroupSize).toBe(5);
    expect(r.xbar.cl).toBeCloseTo(11.2, 1);
    // A2(5) = 0.577; UCL = xDbar + 0.577*rBar
    expect(r.xbar.ucl - r.xbar.cl).toBeCloseTo(0.577 * r.rBar, 3);
    // D4(5) = 2.114
    expect(r.r.ucl).toBeCloseTo(2.114 * r.rBar, 3);
  });
  it("rejects mismatched subgroup sizes", () => {
    expect(xBarR([[1, 2, 3], [1, 2, 3, 4]])).toBeNull();
  });
});

describe("subgroupBySize", () => {
  it("drops trailing partial", () => {
    expect(subgroupBySize([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
  });
});

describe("detectViolations", () => {
  const limits = { cl: 10, ucl: 13, lcl: 7 };

  it("Rule 1 — beyond UCL/LCL", () => {
    const v = detectViolations([10, 10, 15, 10, 5], limits);
    expect(v.filter((x) => x.rule === 1).map((x) => x.index)).toEqual([2, 4]);
  });

  it("Rule 2 — 7 consecutive on one side of CL", () => {
    const v = detectViolations([11, 11, 11, 11, 11, 11, 11, 10], limits);
    expect(v.some((x) => x.rule === 2 && x.index === 6)).toBe(true);
  });

  it("Rule 3 — 7 consecutive monotonic", () => {
    const inc = [8, 8.5, 9, 9.5, 10, 10.5, 11];
    const v = detectViolations(inc, limits);
    expect(v.some((x) => x.rule === 3 && x.index === 6)).toBe(true);
  });

  it("Rule 4 — 14 alternating (cyclic)", () => {
    const xs = Array.from({ length: 14 }, (_, i) => 10 + (i % 2 === 0 ? -0.5 : 0.5));
    const v = detectViolations(xs, limits);
    expect(v.some((x) => x.rule === 4 && x.index === 13)).toBe(true);
  });

  it("clean series has no violations", () => {
    const xs = [10, 11, 9, 10, 11, 9, 10, 11, 9, 10];
    expect(detectViolations(xs, limits)).toEqual([]);
  });

  it("violatedIndices dedupes across rules", () => {
    const v = [{ index: 3, rule: 1 as const, description: "" }, { index: 3, rule: 2 as const, description: "" }];
    expect([...violatedIndices(v)]).toEqual([3]);
  });

  it("labels are defined for every rule", () => {
    ([1, 2, 3, 4] as const).forEach((r) => expect(RULE_LABEL[r]).toBeTruthy());
  });
});
