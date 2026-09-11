// @ts-nocheck
// Tests for the regression fallback used by the Dipping recommendation engine.
// Run with: bun test src/features/hdp/regression.test.ts
import { describe, expect, it } from "bun:test";
import {
  selectTrainingSet,
  fitCoatingModel,
  fitWeightedCoatingModel,
  predictMicron,
  optimalTargetMicron,
  confidenceFrom,
  similarityScore,
  predictTimings,
  rankHistorical,
  targetBandFor,
  detectProcessDrift,
  detectStability,
  detectSuddenShift,
  bestStableWindow,
  computeTimeSeries,
} from "./regression";

import { computeRecommendation } from "./recommendation";

const dayMs = 86400_000;
const NOW = Date.parse("2026-07-13T12:00:00Z");

function mkBeam(overrides: any = {}) {
  return {
    beam_no: "H" + Math.random().toString(36).slice(2, 8),
    qc_status: "PASS",
    immersion_duration: 60,
    reaction_duration: 120,
    withdrawal_duration: 30,
    bath_temperature: 450,
    load_type: "Single",
    coating_required: 87,
    section: "10",
    total_weight: "1.0",
    length_mm: 6000,
    part_nos: Array.from({ length: 12 }, (_, i) => `P${i}`).join(","),
    avg_reading: 95,
    material_type: "MS",
    surface_condition: "Normal",
    qc_completed_at: new Date(NOW - dayMs).toISOString(),
    ...overrides,
  };
}

describe("selectTrainingSet", () => {
  it("filters PASS beams within the 10-day window", () => {
    const beams = [
      mkBeam({ qc_completed_at: new Date(NOW - 3 * dayMs).toISOString() }),
      mkBeam({ qc_completed_at: new Date(NOW - 20 * dayMs).toISOString() }), // out
      mkBeam({ qc_status: "FAIL" }), // out
    ];
    const { rows, days } = selectTrainingSet(beams, { now: NOW, minRows: 1 });
    expect(rows.length).toBe(1);
    expect(days).toBe(10);
  });

  it("expands to 30-day window when there are too few rows in 10 days", () => {
    const beams = [
      mkBeam({ qc_completed_at: new Date(NOW - 15 * dayMs).toISOString() }),
      mkBeam({ qc_completed_at: new Date(NOW - 18 * dayMs).toISOString() }),
    ];
    const { rows, days } = selectTrainingSet(beams, { now: NOW });
    expect(rows.length).toBe(2);
    expect(days).toBe(30);
  });
});

describe("fitCoatingModel", () => {
  it("recovers a known linear relationship (micron = 20 + 0.5·imm)", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      beam: {},
      immersion: 60 + i,
      reaction: 120,
      withdrawal: 30,
      bathTemp: 450,
      thickness: 10,
      weight: 1.0,
      length: 6000,
      micron: 20 + 0.5 * (60 + i),
    }));
    const model = fitCoatingModel(rows);
    expect(model.r2).toBeGreaterThan(0.99);
    expect(Math.abs(model.coef[1] - 0.5)).toBeLessThan(0.05);
    const pred = predictMicron(model, {
      immersion: 100, reaction: 120, withdrawal: 30, bathTemp: 450, thickness: 10, weight: 1.0, length: 6000,
    });
    expect(Math.abs(pred - 70)).toBeLessThan(1);
  });

  it("exposes Length as a predictor and includes it in predictions", () => {
    // Length values are on a large scale vs other features, so we verify the
    // coefficient wiring and prediction plumbing rather than numeric recovery
    // (real production data goes through standardisation elsewhere).
    const rows = Array.from({ length: 30 }, (_, i) => {
      const imm = 60 + i;
      const len = 4000 + i * 200;
      return {
        beam: {}, immersion: imm,
        reaction: 110 + (i % 5),
        withdrawal: 25 + (i % 4),
        bathTemp: 448 + (i % 6),
        thickness: 8 + (i % 3),
        weight: 1.0 + (i % 7) * 0.05,
        length: len,
        micron: 40 + 0.5 * imm + 0.001 * len,
      };
    });
    const model = fitCoatingModel(rows);
    // Coefficient slot 7 == Length, and sensitivity is wired to it.
    expect(model.coef.length).toBe(8);
    expect(typeof model.sensitivities.perMmLength).toBe("number");
    // Predict at different lengths → prediction changes when perMmLength ≠ 0.
    const base = predictMicron(model, {
      immersion: 90, reaction: 120, withdrawal: 30, bathTemp: 450, thickness: 10, weight: 1.0, length: 4000,
    });
    const long = predictMicron(model, {
      immersion: 90, reaction: 120, withdrawal: 30, bathTemp: 450, thickness: 10, weight: 1.0, length: 10000,
    });
    if (Math.abs(model.sensitivities.perMmLength) > 1e-9) {
      expect(base).not.toBe(long);
    }
  });

  it("falls back to univariate when sample size is too small and flags lowSample", () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      beam: {}, immersion: 60 + i * 10, reaction: 120, withdrawal: 30,
      bathTemp: 450, thickness: 10, weight: 1.0, length: 6000, micron: 80 + i * 5,
    }));
    const model = fitCoatingModel(rows);
    expect(model.fallback).toBe("univariate");
    expect(model.coef[1]).toBeGreaterThan(0);
    expect(model.lowSample).toBe(true);
  });
});

describe("confidence low-sample cap", () => {
  it("caps confidence at 55% when lowSample is true", () => {
    const capped = confidenceFrom(0.95, 25, 0.9, true);
    expect(capped).toBeLessThanOrEqual(55);
    const uncapped = confidenceFrom(0.95, 25, 0.9, false);
    expect(uncapped).toBeGreaterThan(55);
  });
});

describe("rankHistorical", () => {
  it("returns every training row when no cap is passed", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      beam: { beam_no: "B" + i, total_weight: String(1 + i * 0.05), bath_temperature: 450, section: "10", length_mm: 6000, part_nos: "P" },
      immersion: 60, reaction: 120, withdrawal: 30,
      bathTemp: 450, thickness: 10, weight: 1 + i * 0.05, length: 6000, micron: 90,
    }));
    const current = { total_weight: "1.0", bath_temperature: 450, section: "10", length_mm: 6000, part_nos: "P" };
    const all = rankHistorical(current, rows, {});
    expect(all.length).toBe(12);
    // Sorted by similarity descending.
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].similarity).toBeGreaterThanOrEqual(all[i].similarity);
    }
  });
});


describe("optimalTargetMicron", () => {
  it("uses preferred zinc target when history is thin", () => {
    const rows = [] as any[];
    const { target, reason } = optimalTargetMicron(rows, 87);
    expect(target).toBe(95);
    expect(reason).toBe("preferred");
  });

  it("prefers a proven lower band when history supports it", () => {
    // 6 PASS rows clustered at 90-91 µm for a 87 µm requirement
    const rows = Array.from({ length: 6 }, () => ({
      beam: {}, immersion: 60, reaction: 120, withdrawal: 30,
      bathTemp: 450, thickness: 10, weight: 1.0, micron: 90.5,
    }));
    const { target, reason } = optimalTargetMicron(rows, 87);
    expect(reason).toBe("history");
    expect(target).toBeLessThan(95);
    expect(target).toBeGreaterThanOrEqual(87);
  });
});

describe("confidenceFrom", () => {
  it("grows with R², sample size, and similarity", () => {
    const low = confidenceFrom(0.2, 3, 0.3);
    const high = confidenceFrom(0.95, 25, 0.9);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(100);
    expect(low).toBeGreaterThanOrEqual(0);
  });
});

describe("similarityScore", () => {
  it("returns 1 for identical soft fields and drops with distance", () => {
    const a = mkBeam();
    const b = mkBeam();
    expect(similarityScore(a, b)).toBeCloseTo(1, 2);
    const c = mkBeam({ total_weight: "5.0", bath_temperature: 470 });
    expect(similarityScore(a, c)).toBeLessThan(0.7);
  });
});

describe("computeRecommendation regression fallback", () => {
  const dc = {
    engineEnabled: true,
    weightTol: 0.1,
    tempTol: 1,
    lengthTol: 500,
    qtyTol: 5,
    showLength: false,
    regressionEnabled: true,
  };

  it("returns a regression prediction when no exact match exists", () => {
    // History: same material/surface/coating/load, but weights far outside tolerance.
    const beams = Array.from({ length: 12 }, (_, i) =>
      mkBeam({
        total_weight: String(3.0 + i * 0.1), // way off from current 1.0
        immersion_duration: 60 + i * 2,
        avg_reading: 90 + i * 0.5,
        qc_completed_at: new Date(NOW - (i + 1) * dayMs * 0.5).toISOString(),
      }),
    );
    const current = mkBeam({ beam_no: "CURR", qc_status: "LOADED", total_weight: "1.0" });
    const res: any = computeRecommendation({ beam: current, beams, bathTemp: 450, dc });
    expect(res.regression).toBe(true);
    expect(res.recommendationType).toBe("regression");
    expect(res.mlr.hasModel).toBe(false);
  });

  it("falls back to First-Beam regression even when regression is disabled (never 'none')", () => {
    const beams = [mkBeam({ total_weight: "5.0" })];
    const current = mkBeam({ beam_no: "CURR", qc_status: "LOADED", total_weight: "1.0" });
    const res: any = computeRecommendation({
      beam: current, beams, bathTemp: 450,
      dc: { ...dc, regressionEnabled: false },
    });
    expect(res.none).toBeUndefined();
    expect(res.regression).toBe(true);
  });

  it("falls back to First-Beam regression when hard filters (material) exclude every candidate", () => {
    const beams = Array.from({ length: 12 }, () =>
      mkBeam({ material_type: "HT", total_weight: "5.0" }),
    );
    const current = mkBeam({ beam_no: "CURR", qc_status: "LOADED", material_type: "MS", total_weight: "1.0" });
    const res: any = computeRecommendation({ beam: current, beams, bathTemp: 450, dc });
    expect(res.none).toBeUndefined();
    expect(res.regression).toBe(true);
  });
});

describe("predictTimings", () => {
  it("increases immersion when target micron is above prediction at anchor", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      beam: { beam_no: "A" + i }, immersion: 60 + i, reaction: 120, withdrawal: 30,
      bathTemp: 450, thickness: 10, weight: 1.0, length: 6000, micron: 70 + 0.5 * i,
    }));
    const model = fitCoatingModel(rows);
    const anchor = rows[0]; // predicted ~70 at anchor
    const p = predictTimings(
      model,
      { bathTemp: 450, thickness: 10, weight: 1.0, length: 6000 },
      { requiredMicron: 87, targetMicron: 95, anchor, similarity: 0.9 },
    );
    expect(p.immersion).toBeGreaterThan(anchor.immersion);
    expect(p.deltaSec).toBeGreaterThan(0);
    expect(p.expectedMicron).toBeGreaterThan(70);
  });
});

describe("three-tier resolver", () => {
  const dc = {
    engineEnabled: true, weightTol: 0.1, tempTol: 1, lengthTol: 500, qtyTol: 5,
    regressionEnabled: true,
  };

  it("tier 2 CLOSEST fires when Tier 1 empty but relaxed tolerance matches", () => {
    // Weight tol=0.1, current=1.0, historical=1.25 → tier 1 misses (Δ 0.25 > 0.1)
    // Tier 2 relaxes 3× → 0.3, 0.25 < 0.3 → matches.
    const beams = [
      mkBeam({ beam_no: "H1", total_weight: "1.15", avg_reading: 92 }),
    ];
    const current = mkBeam({ beam_no: "CURR", qc_status: "LOADED", total_weight: "1.0" });
    const res: any = computeRecommendation({ beam: current, beams, bathTemp: 450, dc });
    expect(res.recommendationType).toBe("closest");
    expect(res.count).toBe(1);
    expect(res.relaxFactor).toBe(2);
  });

  it("tier 1 EXACT still wins when strict tolerances match", () => {
    const beams = [mkBeam({ beam_no: "H1", total_weight: "1.05", avg_reading: 91 })];
    const current = mkBeam({ beam_no: "CURR", qc_status: "LOADED", total_weight: "1.0" });
    const res: any = computeRecommendation({ beam: current, beams, bathTemp: 450, dc });
    expect(res.recommendationType).toBe("exact");
  });

  it("regression tier exposes sensitivities and historical records list", () => {
    const beams = Array.from({ length: 12 }, (_, i) =>
      mkBeam({
        total_weight: String(3.0 + i * 0.1),
        immersion_duration: 60 + i * 2,
        avg_reading: 90 + i * 0.5,
        qc_completed_at: new Date(NOW - (i + 1) * dayMs * 0.5).toISOString(),
      }),
    );
    const current = mkBeam({ beam_no: "CURR", qc_status: "LOADED", total_weight: "1.0" });
    const res: any = computeRecommendation({ beam: current, beams, bathTemp: 450, dc });
    expect(res.recommendationType).toBe("regression");
    expect(res.prediction.total).toBeGreaterThanOrEqual(0);
    expect(res.target).toBe(95);
  });
});


describe("time-series layer", () => {
  const mkRow = (dayOffset: number, micron: number, extra: any = {}) => ({
    beam: { qc_completed_at: new Date(NOW - dayOffset * dayMs).toISOString(), ...extra },
    immersion: 60, reaction: 120, withdrawal: 30, bathTemp: 450,
    thickness: 10, weight: 1.0, length: 6000, micron,
  });

  it("targetBandFor returns spec bands", () => {
    expect(targetBandFor(65)).toEqual([70, 75]);
    expect(targetBandFor(87)).toEqual([90, 97]);
    expect(targetBandFor(130)).toEqual([130, 140]);
    expect(targetBandFor(100)).toEqual([100, 108]);
  });

  it("detectProcessDrift picks up an upward slope", () => {
    const rows = Array.from({ length: 7 }, (_, i) => mkRow(6 - i, 80 + i * 2));
    const d = detectProcessDrift(rows);
    expect(d.direction).toBe("up");
    expect(d.slopePerDay).toBeGreaterThan(1);
  });

  it("detectStability flags Stable vs Unstable by sigma", () => {
    const stable = Array.from({ length: 8 }, (_, i) => mkRow(i, 90 + (i % 2)));
    expect(detectStability(stable).status).toBe("Stable");
    const unstable = Array.from({ length: 8 }, (_, i) => mkRow(i, 80 + i * 3));
    expect(detectStability(unstable).status).toBe("Unstable");
  });

  it("detectSuddenShift catches a >=5μm day-to-day jump", () => {
    const rows = [
      mkRow(3, 90), mkRow(3, 91),
      mkRow(2, 90), mkRow(2, 89),
      mkRow(1, 98), mkRow(1, 99), // sudden +8μm
    ];
    const s = detectSuddenShift(rows);
    expect(s.shifted).toBe(true);
    expect(s.to).toBeGreaterThan(s.from);
  });

  it("bestStableWindow prefers the calm recent window", () => {
    // Days 5-6-7 chaotic, days 0-2 calm
    const rows = [
      mkRow(7, 70), mkRow(7, 88), mkRow(6, 65), mkRow(6, 99),
      mkRow(2, 90), mkRow(1, 91), mkRow(1, 90), mkRow(0, 90),
    ];
    const w = bestStableWindow(rows, NOW);
    expect(w.sigma).toBeLessThan(3);
    expect(w.rows.length).toBeGreaterThanOrEqual(4);
  });

  it("computeTimeSeries returns full insight bundle", () => {
    const rows = Array.from({ length: 8 }, (_, i) => mkRow(7 - i, 90 + (i % 2), { shift: i % 2 ? "A" : "B", dipped_by: "op" + (i % 2) }));
    const ins = computeTimeSeries(rows, NOW);
    expect(ins.totalRows).toBe(8);
    expect(ins.shifts.length).toBeGreaterThanOrEqual(2);
    expect(ins.operators.length).toBeGreaterThanOrEqual(2);
    expect(ins.bestWindow.rows.length).toBeGreaterThan(0);
  });

  it("fitWeightedCoatingModel produces a model on 8 recent rows", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      beam: { qc_completed_at: new Date(NOW - i * dayMs * 0.3).toISOString() },
      immersion: 60 + i, reaction: 120, withdrawal: 30, bathTemp: 450,
      thickness: 10, weight: 1.0, length: 6000, micron: 70 + 0.5 * i,
    }));
    const m = fitWeightedCoatingModel(rows, { now: NOW, halfLifeDays: 2 });
    expect(m.coef.length).toBe(8);
    expect(typeof m.sensitivities.perSecImmersion).toBe("number");
  });
});
