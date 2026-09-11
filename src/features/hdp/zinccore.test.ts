import { describe, it, expect } from "bun:test";
import {
  fitZinccore,
  fineTuneZinccore,
  zinccorePredict,
  zinccorePredictTotalTime,
  zinccorePredictCoating,
  zinccoreAttribution,
} from "./zinccore";

// Synthetic dataset with a clear signal: time grows with thickness/spec,
// coating grows with time. zinccore should recover the trend.
function dataset(n = 160) {
  const loads = ["Single", "Double", "Plate"];
  const mats = ["MS", "HT"];
  const surfs = ["Normal", "Rusted", "Heavy Rusted"];
  const rows: any[] = [];
  for (let i = 0; i < n; i++) {
    const thickness = 6 + (i % 5) * 3;
    const spec = [65, 87, 130][i % 3];
    const bathTemp = 448 + (i % 7);
    const weight = 0.6 + (i % 9) * 0.2;
    const length = 3000 + (i % 6) * 1000;
    const loadType = loads[i % 3];
    const material = mats[i % 2];
    const surface = surfs[i % 3];
    const surfBump = surface === "Normal" ? 0 : surface === "Rusted" ? 25 : 50;
    const totalTime = 120 + thickness * 8 + spec * 1.4 + weight * 20 + surfBump + (material === "HT" ? 15 : 0);
    const coating = 20 + totalTime * 0.16 + (material === "HT" ? 3 : 0);
    rows.push({ loadType, material, thickness, spec, surface, bathTemp, weight, length, totalTime, coating });
  }
  return rows;
}

describe("zinccore", () => {
  const rows = dataset();
  const model = fitZinccore(rows);

  it("trains and recovers the signal", () => {
    expect(model).not.toBeNull();
    expect(model!.n).toBe(rows.length);
    expect(model!.r2).toBeGreaterThan(0.7);
    expect(model!.coatingR2).toBeGreaterThan(0.7);
  });

  it("predicts a plausible total time and coating", () => {
    const input = {
      loadType: "Single", material: "MS", thickness: 10, spec: 87,
      surface: "Normal", bathTemp: 450, weight: 1.2, length: 6000,
    };
    const p = zinccorePredict(model!, input as any);
    expect(p.totalSec).toBeGreaterThan(0);
    expect(p.totalMMSS).toMatch(/^\d+:\d{2}$/);
    expect(p.targetCoating).toBe(95);
    expect(p.confidencePct).toBeGreaterThanOrEqual(0);
    expect(p.confidencePct).toBeLessThanOrEqual(100);
    expect(p.highSec).toBeGreaterThanOrEqual(p.lowSec);
    expect(p.expectedCoating).toBeGreaterThan(0);
  });

  it("thicker sections take longer", () => {
    const base = { loadType: "Single", material: "MS", spec: 87, surface: "Normal", bathTemp: 450, weight: 1.2, length: 6000 };
    const thin = zinccorePredictTotalTime(model!, { ...base, thickness: 6 } as any);
    const thick = zinccorePredictTotalTime(model!, { ...base, thickness: 18 } as any);
    expect(thick).toBeGreaterThan(thin);
  });

  it("coating increases with dipping time", () => {
    const input = { loadType: "Single", material: "MS", thickness: 10, spec: 87, surface: "Normal", bathTemp: 450, weight: 1.2, length: 6000 };
    const short = zinccorePredictCoating(model!, input as any, 250);
    const long = zinccorePredictCoating(model!, input as any, 500);
    expect(long).toBeGreaterThan(short);
  });

  it("attribution ranks inputs by impact", () => {
    const input = { loadType: "Single", material: "MS", thickness: 10, spec: 87, surface: "Normal", bathTemp: 450, weight: 1.2, length: 6000 };
    const attr = zinccoreAttribution(model!, input as any);
    expect(attr.length).toBeGreaterThan(3);
    expect(Math.abs(attr[0].impactSec)).toBeGreaterThanOrEqual(Math.abs(attr[attr.length - 1].impactSec));
  });

  it("fine-tuning keeps a usable model", () => {
    const tuned = fineTuneZinccore(model!, dataset(60), 20);
    expect(tuned).not.toBeNull();
    expect(tuned!.r2).toBeGreaterThan(0.5);
  });

  it("returns null on insufficient data", () => {
    expect(fitZinccore([])).toBeNull();
  });
});
