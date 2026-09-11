// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { narrate } from "./narrate";

describe("narrate — spec §7 templates", () => {
  it("exact match with predicted above band → 'Reduce total dipping time by …'", () => {
    const out = narrate({
      source: "exact",
      predicted_um: 95, target_lo: 90, target_hi: 92,
      delta_s: 10, confidence_pct: 88,
    });
    expect(out.source_label).toBe("Exact Match");
    expect(out.low_confidence).toBe(false);
    expect(out.sentence).toContain("Reduce total dipping time by 10s");
    expect(out.sentence).toContain("95µm");
    expect(out.sentence).toContain("90–92µm");
    expect(out.sentence.split(/\s+/).length).toBeLessThanOrEqual(30);
  });

  it("exact match with predicted below band → 'Increase total dipping time …'", () => {
    const out = narrate({
      source: "exact",
      predicted_um: 80, target_lo: 90, target_hi: 92,
      delta_s: -8, confidence_pct: 90,
    });
    expect(out.sentence).toContain("Increase total dipping time by 8s");
  });

  it("exact match already in band → 'Hold current timing'", () => {
    const out = narrate({
      source: "exact",
      predicted_um: 91, target_lo: 90, target_hi: 92,
      delta_s: 0, confidence_pct: 95,
    });
    expect(out.sentence).toContain("Hold current timing");
  });

  it("closest match names the differing covariate(s)", () => {
    const out = narrate({
      source: "closest",
      non_compatible: ["Weight"],
      total_s: 89, confidence_pct: 78,
    });
    expect(out.source_label).toBe("Closest Compatible Match");
    expect(out.sentence).toContain("Weight differs");
    expect(out.sentence).toContain("89s");
  });

  it("closest match with multiple non-compatible fields joins them naturally", () => {
    const out = narrate({
      source: "closest",
      non_compatible: ["Weight", "Length", "Bath Temp"],
      total_s: 100,
    });
    expect(out.sentence).toContain("Weight, Length and Bath Temp differ");
  });

  it("regression fallback describes MLR-driven time adjustment vs target", () => {
    const out = narrate({
      source: "regression",
      immersion_s: 62, reaction_s: 18, withdrawal_s: 9, total_s: 89, delta_s: -5,
      predicted_um: 98, target_lo: 95, target_hi: 105, confidence_pct: 72,
    });
    expect(out.source_label).toBe("Regression Prediction");
    expect(out.sentence).toContain("98 µm");
    expect(out.sentence).toContain("95 µm");
    expect(out.sentence).toContain("5s");
  });

  it("prepends 'Low confidence' when confidence < 60", () => {
    const out = narrate({
      source: "regression",
      immersion_s: 60, reaction_s: 20, withdrawal_s: 10,
      predicted_um: 90, confidence_pct: 45,
    });
    expect(out.low_confidence).toBe(true);
    expect(out.sentence).toMatch(/^Low confidence/);
  });

  it("prepends 'Low confidence' when low_sample flag is set (even with high pct)", () => {
    const out = narrate({
      source: "regression",
      immersion_s: 60, reaction_s: 20, withdrawal_s: 10,
      predicted_um: 90, confidence_pct: 82, low_sample: true,
    });
    expect(out.low_confidence).toBe(true);
    expect(out.sentence).toMatch(/^Low confidence/);
  });
});
