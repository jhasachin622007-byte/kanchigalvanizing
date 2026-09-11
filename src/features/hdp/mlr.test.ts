// @ts-nocheck
import { describe, expect, it } from "bun:test";
import {
  parseTrainingCsv, fitMlr, predict, targetCoatingFor,
  encodeMaterial, encodeSurface, predictTotalTime, recommendationSentence, MLR_FEATURES,
} from "./mlr";

const csv = [
  "Load Type,Material Type,Thickness,Specific Coating,Surface Condition,Bath Temperature,Total Dipping Time,Actual Average Coating",
  ...Array.from({ length: 20 }, (_, i) =>
    `Single,MS,${8 + (i % 4)},87,Normal,${448 + (i % 5)},${280 + i * 5},${88 + i * 0.6}`),
].join("\n");

describe("targetCoatingFor", () => {
  it("maps spec micron to target coating", () => {
    expect(targetCoatingFor(65)).toBe(75);
    expect(targetCoatingFor(87)).toBe(95);
    expect(targetCoatingFor(130)).toBe(140);
  });
});

describe("encoders", () => {
  it("encodes material and surface", () => {
    expect(encodeMaterial("MS")).toBe(1);
    expect(encodeMaterial("HT")).toBe(2);
    expect(encodeSurface("Normal")).toBe(1);
    expect(encodeSurface("Rusted")).toBe(2);
    expect(encodeSurface("Heavy Rusted")).toBe(3);
  });
});

describe("parseTrainingCsv", () => {
  it("parses valid rows and reports missing columns", () => {
    const r = parseTrainingCsv(csv);
    expect(r.accepted).toBe(20);
    expect(r.rejected).toBe(0);
    const bad = parseTrainingCsv("A,B\n1,2");
    expect(bad.missingColumns.length).toBeGreaterThan(0);
  });

  it("skips rows with invalid numbers", () => {
    const r = parseTrainingCsv(csv + "\nSingle,MS,,87,Normal,450,,90");
    expect(r.rejected).toBe(1);
  });
});

describe("fitMlr / predict", () => {
  it("fits a model and predicts a positive dipping time", () => {
    const { rows } = parseTrainingCsv(csv);
    const model = fitMlr(rows);
    expect(model).not.toBeNull();
    expect(model.beta.length).toBe(MLR_FEATURES.length + 1);
    expect(model.n).toBe(20);
    const p = predict(model, {
      loadType: "Single", material: "MS", thickness: 10, spec: 87, surface: "Normal", bathTemp: 450,
    });
    expect(p.totalSec).toBeGreaterThan(0);
    expect(p.targetCoating).toBe(95);
    expect(p.confidencePct).toBeGreaterThan(0);
  });

  it("recovers a known linear time relationship", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      loadType: "Single", material: "MS", thickness: 10, spec: 87,
      surface: "Normal", bathTemp: 450,
      totalTime: 100 + 2 * i, coating: 80 + 0.5 * i,
    }));
    const model = fitMlr(rows);
    expect(predictTotalTime(model, {
      loadType: "Single", material: "MS", thickness: 10, spec: 87, surface: "Normal", bathTemp: 450,
    })).toBeGreaterThan(0);
  });
});

describe("recommendationSentence", () => {
  it("says increase / reduce against a reference time", () => {
    expect(recommendationSentence({ predictedSec: 320, targetCoating: 95, referenceSec: 300 }).sentence)
      .toContain("Increase immersion time by 20 seconds");
    expect(recommendationSentence({ predictedSec: 280, targetCoating: 95, referenceSec: 300 }).sentence)
      .toContain("Reduce immersion time by 20 seconds");
    expect(recommendationSentence({ predictedSec: 300, targetCoating: 95, referenceSec: null }).sentence)
      .toContain("300 seconds");
  });
});
