// @ts-nocheck
// Tests for tolerance-based Dipping coating recommendation.
// Run with: bun test src/features/hdp/recommendation.test.ts
import { describe, expect, it } from "bun:test";
import { computeRecommendation, bucket, parseThk, parseLen } from "./recommendation";

const dc = {
  engineEnabled: true,
  weightTol: 0.1,
  tempTol: 1,
  lengthTol: 500,
  qtyTol: 5,
  showLength: false,
};

function mk(overrides: any) {
  return {
    beam_no: "B?",
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
    avg_reading: 90,
    material_type: "MS",
    surface_condition: "Normal",
    qc_completed_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const baseBeam = mk({ beam_no: "CURR", qc_status: "LOADED" });

describe("tolerance-based recommendation", () => {
  it("requires bath temperature to be entered first", () => {
    expect(computeRecommendation({ beam: baseBeam, beams: [], bathTemp: "", dc }))
      .toEqual({ needTemp: true });
  });

  it("returns disabled when the engine is off", () => {
    expect(computeRecommendation({ beam: baseBeam, beams: [], bathTemp: "450", dc: { ...dc, engineEnabled: false } }))
      .toEqual({ disabled: true });
  });

  it("temperature: includes ±1°C neighbours", () => {
    const beams = [
      mk({ beam_no: "T449", bath_temperature: 449, avg_reading: 90 }),
      mk({ beam_no: "T451", bath_temperature: 451, avg_reading: 92 }),
      mk({ beam_no: "T453", bath_temperature: 453, avg_reading: 88 }), // out of ±1
    ];
    const res: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc });
    expect(res.count).toBe(2);
    expect(res.top3.map((r: any) => r.beam_no).sort()).toEqual(["T449", "T451"]);
  });

  it("weight: includes ±0.1 MT neighbours", () => {
    const beams = [
      mk({ beam_no: "W09",  total_weight: "0.9",  avg_reading: 90 }),
      mk({ beam_no: "W11",  total_weight: "1.1",  avg_reading: 92 }),
      mk({ beam_no: "W12",  total_weight: "1.2",  avg_reading: 88 }), // out
    ];
    const res: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc });
    expect(res.count).toBe(2);
  });

  it("length: ±500 mm when showLength is on", () => {
    const dcLen = { ...dc, showLength: true };
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", length_mm: 6000 });
    const beams = [
      mk({ beam_no: "L5500", length_mm: 5500, avg_reading: 90 }),
      mk({ beam_no: "L6500", length_mm: 6500, avg_reading: 92 }),
      mk({ beam_no: "L7000", length_mm: 7000, avg_reading: 88 }), // out
    ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc: dcLen });
    expect(res.count).toBe(2);
  });

  it("picks the beam closest to required coating (87)", () => {
    const candidates = [96, 93, 90, 100, 102].map((avg, i) =>
      mk({ beam_no: `B0${i + 1}`, avg_reading: avg }),
    );
    const res: any = computeRecommendation({
      beam: { ...baseBeam, coating_required: 87 },
      beams: candidates, bathTemp: "450", dc,
    });
    expect(res.best.avg_reading).toBe(90);
    expect(res.top3.map((r: any) => r.avg_reading)).toEqual([90, 93, 96]);
  });

  it("excludes beams with mismatched thickness when showThickness is on", () => {
    const beams = [
      mk({ beam_no: "WRONG", section: "12", avg_reading: 87 }),
      mk({ beam_no: "RIGHT", section: "10", avg_reading: 95 }),
    ];
    const res: any = computeRecommendation({
      beam: { ...baseBeam, coating_required: 87 },
      beams, bathTemp: "450", dc,
    });
    expect(res.best.beam_no).toBe("RIGHT");
  });

  it("falls back to regression (never 'none') when nothing is in tolerance", () => {
    const beams = [mk({ beam_no: "FAR", bath_temperature: 460, total_weight: "2.5" })];
    const res: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc });
    expect(res.regression).toBe(true);
    expect(res.firstBeam || res.recommendationStatus === "regression-only").toBeTruthy();
    expect(res.none).toBeUndefined();
  });
});

describe("helpers", () => {
  it("buckets values by step (back-compat)", () => {
    expect(bucket(0.25, 0.1, 0.1)?.label).toBe("0.2–0.3");
  });
  it("parses thickness", () => {
    expect(parseThk({ section: "10" })).toBe(10);
    expect(parseThk({ section: "12.5mm" })).toBe(12.5);
  });
  it("parses length (single + double batch)", () => {
    expect(parseLen({ length_mm: 6000 })).toBe(6000);
    expect(parseLen({ dbl_parts_detail: [{ length_mm: 5000 }, { length_mm: 7000 }] })).toBe(6000);
    expect(parseLen({})).toBe(null);
  });
});

describe("tolerance edge cases", () => {
  it("temperature: boundary value exactly at ±tol is INCLUDED", () => {
    const beams = [
      mk({ beam_no: "T449_BOUND", bath_temperature: 449, avg_reading: 90 }), // exactly -1
      mk({ beam_no: "T451_BOUND", bath_temperature: 451, avg_reading: 91 }), // exactly +1
    ];
    const res: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc });
    expect(res.count).toBe(2);
  });

  it("admin-updated tolerances widen/narrow the window", () => {
    const beams = [
      mk({ beam_no: "T448", bath_temperature: 448, avg_reading: 90 }),
      mk({ beam_no: "T452", bath_temperature: 452, avg_reading: 91 }),
    ];
    // Default ±1°C → no exact match; Tier 2 widens 3× → both qualify as CLOSEST.
    const t1: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc: { ...dc, regressionEnabled: false } });
    expect(t1.recommendationType).toBe("closest");
    expect(t1.count).toBe(2);
    // Admin widens to ±2°C → both qualify as EXACT.
    const wide: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc: { ...dc, tempTol: 2, regressionEnabled: false } });
    expect(wide.recommendationType).toBe("exact");
    expect(wide.count).toBe(2);
    // Admin narrows to ±0 → history returns nothing; engine falls back to regression (never none).
    const tight: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc: { ...dc, tempTol: 0, regressionEnabled: false } });
    expect(tight.none).toBeUndefined();
  });


  it("weight: floating-point boundary at ±0.1 MT is included", () => {
    const beams = [
      mk({ beam_no: "W_LO", total_weight: "0.9", avg_reading: 88 }),
      mk({ beam_no: "W_HI", total_weight: "1.1", avg_reading: 92 }),
    ];
    const res: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc });
    expect(res.count).toBe(2);
  });

  it("weight: admin tightens tolerance to ±0.05 MT", () => {
    const beams = [
      mk({ beam_no: "W_OUT", total_weight: "1.08", avg_reading: 90 }),
      mk({ beam_no: "W_IN",  total_weight: "1.04", avg_reading: 91 }),
    ];
    const res: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc: { ...dc, weightTol: 0.05 } });
    expect(res.count).toBe(1);
    expect(res.best.beam_no).toBe("W_IN");
  });

  it("length: boundary at ±500 mm exactly is included", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", length_mm: 7500 });
    const beams = [
      mk({ beam_no: "L7000", length_mm: 7000, avg_reading: 90 }),
      mk({ beam_no: "L8000", length_mm: 8000, avg_reading: 91 }),
    ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc: { ...dc, showLength: true } });
    expect(res.count).toBe(2);
  });

  it("length: beams missing length_mm are excluded when showLength is on", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", length_mm: 6000 });
    const beams = [
      mk({ beam_no: "NO_LEN", length_mm: null, avg_reading: 87 }),
      mk({ beam_no: "OK",     length_mm: 6000, avg_reading: 90 }),
    ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc: { ...dc, showLength: true } });
    expect(res.count).toBe(1);
    expect(res.best.beam_no).toBe("OK");
  });

  it("length: double-batch averaging matches against single-beam target", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", length_mm: 6000 });
    const beams = [
      // average 6000 → IN
      { ...mk({ beam_no: "DBL_IN", length_mm: null, avg_reading: 90 }),
        dbl_parts_detail: [{ length_mm: 5500 }, { length_mm: 6500 }] },
      // average 7000 → OUT (diff 1000 > 500)
      { ...mk({ beam_no: "DBL_OUT", length_mm: null, avg_reading: 89 }),
        dbl_parts_detail: [{ length_mm: 6500 }, { length_mm: 7500 }] },
    ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc: { ...dc, showLength: true } });
    expect(res.count).toBe(1);
    expect(res.best.beam_no).toBe("DBL_IN");
  });

  it("turning a field toggle OFF skips its window even when values would mismatch", () => {
    const beams = [
      mk({ beam_no: "WRONG_WT", total_weight: "5.0", avg_reading: 87 }),
    ];
    // With weight on → filtered out; engine falls back to regression, no history match.
    const on: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc });
    expect(on.regression || on.none).toBeTruthy();
    expect(on.count).toBeUndefined();
    // With weight OFF → passes through
    const off: any = computeRecommendation({ beam: baseBeam, beams, bathTemp: "450", dc: { ...dc, showWeight: false } });
    expect(off.count).toBe(1);
  });

  it("qty: ±5 default includes boundary, default-tol respected when admin omits it", () => {
    const parts = (n: number) => Array.from({ length: n }, (_, i) => `P${i}`).join(",");
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", part_nos: parts(12) });
    const beams = [
      mk({ beam_no: "Q7",  part_nos: parts(7),  avg_reading: 90 }), // diff 5 → in
      mk({ beam_no: "Q18", part_nos: parts(18), avg_reading: 91 }), // diff 6 → out
    ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc: { ...dc, qtyTol: undefined as any } });
    expect(res.count).toBe(1);
    expect(res.best.beam_no).toBe("Q7");
  });
});

describe("surface condition gating", () => {
  it("returns needSurface when current beam has no surface_condition selected", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", surface_condition: null });
    const beams = [ mk({ beam_no: "OK", avg_reading: 90 }) ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc });
    expect(res.needSurface).toBe(true);
  });

  it("legacy PASS beams with null surface_condition match when current is Normal", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", surface_condition: "Normal" });
    const beams = [
      mk({ beam_no: "LEGACY", surface_condition: null, avg_reading: 90 }),
      mk({ beam_no: "NORMAL_OK", surface_condition: "Normal", avg_reading: 91 }),
    ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc });
    expect(res.count).toBe(2);
  });

  it("legacy PASS beams with null surface_condition are excluded when current is Rusted", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", surface_condition: "Rusted" });
    const beams = [
      mk({ beam_no: "LEGACY", surface_condition: null, avg_reading: 90 }),
      mk({ beam_no: "RUSTED_OK", surface_condition: "Rusted", avg_reading: 91 }),
    ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc });
    expect(res.count).toBe(1);
    expect(res.best.beam_no).toBe("RUSTED_OK");
  });
});


describe("material type & surface condition matching", () => {
  it("excludes candidates with a different material_type (MS vs HT)", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", material_type: "HT" });
    const beams = [
      mk({ beam_no: "MS_MATCH_TIMING", material_type: "MS", avg_reading: 87 }),
      mk({ beam_no: "HT_OK",           material_type: "HT", avg_reading: 91 }),
    ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc });
    expect(res.count).toBe(1);
    expect(res.best.beam_no).toBe("HT_OK");
  });

  it("excludes candidates missing material_type when current beam has one", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", material_type: "HT" });
    const beams = [
      mk({ beam_no: "NO_MAT", material_type: null, avg_reading: 87 }),
      mk({ beam_no: "HT_OK", material_type: "HT", avg_reading: 92 }),
    ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc });
    expect(res.count).toBe(1);
    expect(res.best.beam_no).toBe("HT_OK");
  });

  it("excludes candidates with a different surface_condition by default", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", surface_condition: "Rusted" });
    const beams = [
      mk({ beam_no: "NORMAL", surface_condition: "Normal",       avg_reading: 87 }),
      mk({ beam_no: "HEAVY",  surface_condition: "Heavy Rusted", avg_reading: 88 }),
      mk({ beam_no: "RUSTED_OK", surface_condition: "Rusted",    avg_reading: 91 }),
    ];
    const res: any = computeRecommendation({ beam, beams, bathTemp: "450", dc });
    expect(res.count).toBe(1);
    expect(res.best.beam_no).toBe("RUSTED_OK");
  });

  it("material match remains mandatory even if legacy admin config disables it", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", material_type: "HT" });
    const beams = [ mk({ beam_no: "MS_ALLOWED", material_type: "MS", avg_reading: 87 }) ];
    const res: any = computeRecommendation({
      beam, beams, bathTemp: "450",
      dc: { ...dc, showMaterialType: false },
    });
    expect(res.regression || res.none).toBeTruthy();
    expect(res.count).toBeUndefined();
  });

  it("surface condition remains mandatory even if legacy admin config disables it", () => {
    const beam = mk({ beam_no: "CURR", qc_status: "LOADED", surface_condition: "Heavy Rusted" });
    const beams = [ mk({ beam_no: "RUSTED_WRONG", surface_condition: "Rusted", avg_reading: 87 }) ];
    const res: any = computeRecommendation({
      beam, beams, bathTemp: "450",
      dc: { ...dc, showSurfaceCondition: false },
    });
    expect(res.regression || res.none).toBeTruthy();
    expect(res.count).toBeUndefined();
  });
});

describe("refIndex — selectable best coating result", () => {
  const mk = (no: string, avg: number, imm: number) => ({
    beam_no: no, qc_status: "PASS", load_type: "Beam", material_type: "MS",
    surface_condition: "Normal", coating_required: 87, section: "10 mm",
    total_weight: "1.0", part_nos: "a", bath_temperature: 450,
    immersion_duration: imm, reaction_duration: 20, withdrawal_duration: 30,
    avg_reading: avg, qc_completed_at: "2026-01-01T00:00:00Z",
  });
  const current = { ...mk("CUR", 0, 0), immersion_duration: null, avg_reading: null };
  const hist = [mk("H1", 88, 100), mk("H2", 90, 200), mk("H3", 95, 300)];
  const dc: any = { engineEnabled: true };

  it("anchors on top3[0] by default", () => {
    const r: any = computeRecommendation({ beam: current, beams: hist, bathTemp: 450, dc });
    expect(r.best.beam_no).toBe("H1");
    expect(r.refIndex).toBe(0);
  });

  it("anchors on the selected view", () => {
    const r: any = computeRecommendation({ beam: current, beams: hist, bathTemp: 450, dc, refIndex: 2 });
    expect(r.top3.map((t: any) => t.beam_no)).toEqual(["H1", "H2", "H3"]);
    expect(r.best.beam_no).toBe("H3");
    expect(r.refIndex).toBe(2);
    expect(r.top3[2]._isClosest).toBe(true);
  });

  it("clamps an out-of-range index", () => {
    const r: any = computeRecommendation({ beam: current, beams: hist, bathTemp: 450, dc, refIndex: 9 });
    expect(r.best.beam_no).toBe("H3");
  });
});
