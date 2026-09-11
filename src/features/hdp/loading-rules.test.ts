// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { checkWeight, checkDuplicateBeam, checkThickness, sanitizeThicknessInput, detectMaterialType, materialGradesOf } from "./loading-rules";

describe("checkWeight", () => {
  it("rejects weights at or above 3.0 MT (default)", () => {
    expect(checkWeight(3.0)).toMatch(/exceeds/);
    expect(checkWeight(3.5)).toMatch(/exceeds/);
  });
  it("accepts weights below 3.0 MT", () => {
    expect(checkWeight(2.999)).toBeNull();
    expect(checkWeight(1.2)).toBeNull();
  });
  it("rejects invalid or zero weight", () => {
    expect(checkWeight(0)).toMatch(/valid/);
    expect(checkWeight(NaN)).toMatch(/valid/);
  });
  it("honours a custom maxBeamWeightMT cap", () => {
    expect(checkWeight(2.5, { maxBeamWeightMT: 2.5 })).toMatch(/exceeds/);
    expect(checkWeight(2.49, { maxBeamWeightMT: 2.5 })).toBeNull();
  });
});

describe("checkDuplicateBeam", () => {
  const beams = [
    { beam_no: "B-100", status: "LOADED" },
    { beam_no: "B-200", status: "DIPPING" },
    { beam_no: "B-300", status: "COMPLETED" },
  ];

  it("always allows re-entry of the same beam number (new transaction id per load)", () => {
    expect(checkDuplicateBeam("B-100", beams)).toBeNull();
    expect(checkDuplicateBeam("B-200", beams)).toBeNull();
    expect(checkDuplicateBeam("B-300", beams)).toBeNull();
    expect(checkDuplicateBeam("B-999", beams)).toBeNull();
    expect(checkDuplicateBeam("B-100", beams, { restrictDuplicateBeam: true })).toBeNull();
  });
});

describe("sanitizeThicknessInput", () => {
  it("strips letters and special characters", () => {
    expect(sanitizeThicknessInput("6mm")).toBe("6");
    expect(sanitizeThicknessInput("1+2")).toBe("12");
    expect(sanitizeThicknessInput("A6*")).toBe("6");
    expect(sanitizeThicknessInput("-8")).toBe("8");
  });
  it("keeps only one decimal point", () => {
    expect(sanitizeThicknessInput("12.5")).toBe("12.5");
    expect(sanitizeThicknessInput("1.2.3")).toBe("1.23");
  });
});

describe("checkThickness", () => {
  it("requires a value", () => {
    expect(checkThickness("")).toMatch(/Enter Thickness/);
  });
  it("rejects non-numeric text", () => {
    expect(checkThickness("6mm")).toMatch(/must be a number/);
  });
  it("rejects zero", () => {
    expect(checkThickness("0")).toMatch(/greater than 0/);
  });
  it("enforces the default 40 mm limit", () => {
    expect(checkThickness("40")).toBeNull();
    expect(checkThickness("40.5")).toBe("Maximum allowed thickness is 40 mm.");
  });
  it("honours a custom limit", () => {
    expect(checkThickness("25", { maxThicknessMm: 20 })).toBe("Maximum allowed thickness is 20 mm.");
    expect(checkThickness("18.5", { maxThicknessMm: 20 })).toBeNull();
  });
});

describe("detectMaterialType", () => {
  it("detects trailing HT / MS case-insensitively", () => {
    expect(detectMaterialType("JSPL PG HT")).toBe("HT");
    expect(detectMaterialType("saral pg ms")).toBe("MS");
    expect(detectMaterialType("JSPL PG HT  ")).toBe("HT");
    expect(detectMaterialType("JSPL PG HT.")).toBe("HT");
  });
  it("returns null when there is no designation", () => {
    expect(detectMaterialType("JSPL PG")).toBeNull();
    expect(detectMaterialType("")).toBeNull();
    expect(detectMaterialType(null)).toBeNull();
  });
});

describe("materialGradesOf", () => {
  it("falls back to seeded defaults", () => {
    expect(materialGradesOf({}).map(g => g.name)).toEqual(["JSPL PG HT", "SARAL PG MS"]);
  });
  it("keeps admin options and infers missing types", () => {
    const out = materialGradesOf({ materialGrades: [{ name: "TATA X HT" }, { name: "Custom", type: "MS" }, { name: "Bad" }] });
    expect(out).toEqual([{ name: "TATA X HT", type: "HT" }, { name: "Custom", type: "MS" }]);
  });
});
