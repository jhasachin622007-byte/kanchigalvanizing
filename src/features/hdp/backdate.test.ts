import { describe, it, expect } from "vitest";
import { resolveBackdatedEntry, backdatedCycleSecs, diffSecs, toIsoLocal } from "./backdate";
import { parseTzLocal } from "@/lib/tz";

const NOW = new Date("2026-08-06T10:00:00Z").getTime();

describe("resolveBackdatedEntry", () => {
  it("requires immersion start", () => {
    const r = resolveBackdatedEntry({}, NOW);
    expect(r.ok).toBe(false);
  });

  it("builds a complete QC_PENDING record with durations", () => {
    const r = resolveBackdatedEntry({
      loaded_at: "2026-08-01T08:00:00",
      immersion_start: "2026-08-01T09:00:00",
      immersion_end: "2026-08-01T09:02:00",
      reaction_end: "2026-08-01T09:05:00",
      withdrawal_end: "2026-08-01T09:06:30",
      bath_temperature: "450.5",
      surface_condition: "Normal",
    }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("QC_PENDING");
    expect(r.patch.immersion_duration).toBe(120);
    expect(r.patch.reaction_duration).toBe(180);
    expect(r.patch.withdrawal_duration).toBe(90);
    expect(r.patch.bath_temperature).toBe(450.5);
    expect(r.patch.dipped_at).toBe(parseTzLocal("2026-08-01T09:06:30"));
    expect(r.patch.backdated).toBe(true);
  });

  it("stays in DIPPING when phases are partial", () => {
    const r = resolveBackdatedEntry({ immersion_start: "2026-08-01T09:00:00" }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("DIPPING");
    expect(r.patch.loaded_at).toBe(r.patch.immersion_start);
  });

  it("rejects future timestamps", () => {
    const r = resolveBackdatedEntry({ immersion_start: "2027-01-01T09:00:00" }, NOW);
    expect(r.ok).toBe(false);
  });

  it("rejects out-of-order timestamps", () => {
    const r = resolveBackdatedEntry({
      immersion_start: "2026-08-01T09:00:00",
      immersion_end: "2026-08-01T08:00:00",
    }, NOW);
    expect(r.ok).toBe(false);
  });

  it("computes total cycle seconds", () => {
    expect(backdatedCycleSecs({
      immersion_start: "2026-08-01T09:00:00",
      withdrawal_end: "2026-08-01T09:06:30",
    })).toBe(390);
    expect(diffSecs(null, null)).toBeNull();
    expect(toIsoLocal("")).toBeNull();
  });
});
