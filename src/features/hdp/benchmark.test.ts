// @ts-nocheck
// Tests for Coating on Job Best Match — material_type + surface_condition filters.
import { describe, expect, it } from "bun:test";
import { computeBenchmark, COJ_BM_DEFAULTS, formatCriteriaUsed } from "./HdpApp";

function mk(overrides: any) {
  return {
    beam_no: "B?",
    transaction_id: undefined,
    qc_status: "PASS",
    coating_required: 87,
    load_type: "Single",
    section: "10",
    total_weight: "1.0",
    length_mm: 6000,
    bath_temperature: 460,
    avg_reading: 90,
    material_type: "MS",
    surface_condition: "Normal",
    qc_completed_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const current = mk({
  beam_no: "CURR",
  qc_status: "LOADED",
  material_type: "HT",
  surface_condition: "Rusted",
  avg_reading: 88,
});

describe("CoJ Best Match — material & surface filters", () => {
  it("excludes candidates with different material_type", () => {
    const beams = [
      mk({ beam_no: "MS_WRONG", material_type: "MS", surface_condition: "Rusted", avg_reading: 90 }),
      mk({ beam_no: "HT_OK",   material_type: "HT", surface_condition: "Rusted", avg_reading: 91 }),
    ];
    const b: any = computeBenchmark(current, beams, COJ_BM_DEFAULTS);
    expect(b.ref_beam_no).toBe("HT_OK");
  });

  it("excludes candidates with different surface_condition", () => {
    const beams = [
      mk({ beam_no: "NORMAL",   material_type: "HT", surface_condition: "Normal",       avg_reading: 90 }),
      mk({ beam_no: "RUSTED_OK",material_type: "HT", surface_condition: "Rusted",       avg_reading: 91 }),
      mk({ beam_no: "HEAVY",    material_type: "HT", surface_condition: "Heavy Rusted", avg_reading: 87 }),
    ];
    const b: any = computeBenchmark(current, beams, COJ_BM_DEFAULTS);
    expect(b.ref_beam_no).toBe("RUSTED_OK");
  });

  it("materialType remains mandatory even if legacy config disables it", () => {
    const beams = [ mk({ beam_no: "MS_BLOCKED", material_type: "MS", surface_condition: "Rusted", avg_reading: 90 }) ];
    const cfg = { ...COJ_BM_DEFAULTS, criteria: { ...COJ_BM_DEFAULTS.criteria, materialType: { enabled: false } } };
    const b: any = computeBenchmark(current, beams, cfg);
    expect(b.status).toBe("Match Not Available");
    expect(b.ref_beam_no).toBe(null);
    expect(b.criteria_used.materialType).toBe(true);
  });

  it("surfaceCondition remains mandatory even if legacy config disables it", () => {
    const beams = [ mk({ beam_no: "NORMAL_BLOCKED", material_type: "HT", surface_condition: "Normal", avg_reading: 90 }) ];
    const cfg = { ...COJ_BM_DEFAULTS, criteria: { ...COJ_BM_DEFAULTS.criteria, surfaceCondition: { enabled: false } } };
    const b: any = computeBenchmark(current, beams, cfg);
    expect(b.status).toBe("Match Not Available");
    expect(b.ref_beam_no).toBe(null);
    expect(b.criteria_used.surfaceCondition).toBe(true);
  });

  it("returns 'Match Not Available' when nothing survives", () => {
    const beams = [ mk({ beam_no: "MS_NORMAL", material_type: "MS", surface_condition: "Normal", avg_reading: 90 }) ];
    const b: any = computeBenchmark(current, beams, COJ_BM_DEFAULTS);
    expect(b.status).toBe("Match Not Available");
  });

  it("finds the 87μm example — 6mm/1MT/460°C/6000mm HT/Rusted PASS beam", () => {
    const req = mk({
      beam_no: "NEW",
      qc_status: "LOADED",
      section: "6", total_weight: "1.0", length_mm: 6000, bath_temperature: 460,
      material_type: "HT", surface_condition: "Rusted", coating_required: 87,
      avg_reading: 86,
    });
    const beams = [
      mk({
        beam_no: "HIST_PASS",
        section: "6", total_weight: "1.0", length_mm: 6000, bath_temperature: 460,
        material_type: "HT", surface_condition: "Rusted", coating_required: 87,
        avg_reading: 88,
      }),
    ];
    const b: any = computeBenchmark(req, beams, COJ_BM_DEFAULTS);
    expect(b.ref_beam_no).toBe("HIST_PASS");
  });

  it("criteria_used surfaces Material Type & Surface Condition + ref fields", () => {
    const beams = [ mk({ beam_no: "HT_OK", material_type: "HT", surface_condition: "Rusted", avg_reading: 91 }) ];
    const b: any = computeBenchmark(current, beams, COJ_BM_DEFAULTS);
    expect(b.criteria_used.materialType).toBe(true);
    expect(b.criteria_used.surfaceCondition).toBe(true);
    expect(b.ref_material_type).toBe("HT");
    expect(b.ref_surface_condition).toBe("Rusted");
    const s = formatCriteriaUsed(b.criteria_used);
    expect(s).toContain("Material Type (MS/HT)");
    expect(s).toContain("Surface Condition");
  });
});
