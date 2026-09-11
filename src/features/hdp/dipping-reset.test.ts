// @ts-nocheck
// Guards the dipping "Reset to Loading" server-write shape. abortBeamPhases
// must produce a diff whose status is LOADED with all phase timestamps
// cleared — otherwise the DB trigger rejects the update.
import { describe, expect, it } from "bun:test";

// Inlined copy of the reducer body used by abortBeamPhases in HdpApp.tsx.
// If the source changes, update here and vice versa.
function abortReducer(x: any, beamTxn: string): any {
  const txn = x.transaction_id || x.beam_no;
  if (txn !== beamTxn) return x;
  if (x.status === "QC_PENDING" || x.status === "COMPLETED") return x;
  if (!x.immersion_start && !x.immersion_end && !x.reaction_end && !x.withdrawal_end
      && x.status !== "DIPPING") return x;
  return {
    ...x,
    immersion_start: null,
    immersion_end:   null,
    reaction_end:    null,
    withdrawal_end:  null,
    immersion_duration: null,
    reaction_duration: null,
    withdrawal_duration: null,
    dipping_at:      null,
    dipped_by:       null,
    dipped_by_name:  null,
    bath_temperature: null,
    dipping_operator: null,
    shift_supervisor: null,
    surface_condition: null,
    status: (x.status === "DIPPING") ? "LOADED" : x.status,
  };
}

describe("dipping reset", () => {
  it("reverts DIPPING beam to LOADED with all phase timestamps cleared", () => {
    const beam = {
      transaction_id: "T-1",
      beam_no: "B-1",
      status: "DIPPING",
      immersion_start: "2026-07-01T10:00:00Z",
      immersion_end: "2026-07-01T10:02:00Z",
      reaction_end: null,
      withdrawal_end: null,
      immersion_duration: 120,
      reaction_duration: 60,
      withdrawal_duration: 90,
      bath_temperature: 455,
      dipping_operator: "Ravi",
      shift_supervisor: "Suresh",
      surface_condition: "Normal",
      route_card: "RC-1",
      part_nos: "P-1",
      total_weight: 1.2,
      coating_required: 87,
      elcometer: [null, null, null, null, null, null, null],
    };
    const next = abortReducer(beam, "T-1");
    expect(next.status).toBe("LOADED");
    expect(next.immersion_start).toBeNull();
    expect(next.immersion_end).toBeNull();
    expect(next.reaction_end).toBeNull();
    expect(next.withdrawal_end).toBeNull();
    expect(next.immersion_duration).toBeNull();
    expect(next.reaction_duration).toBeNull();
    expect(next.withdrawal_duration).toBeNull();
    expect(next.bath_temperature).toBeNull();
    expect(next.dipping_operator).toBeNull();
    expect(next.shift_supervisor).toBeNull();
    expect(next.surface_condition).toBeNull();
    expect(next.route_card).toBe("RC-1");
    expect(next.part_nos).toBe("P-1");
    expect(next.total_weight).toBe(1.2);
    expect(next.coating_required).toBe(87);
    expect(next.elcometer).toBe(beam.elcometer);
  });

  it("leaves QC_PENDING / COMPLETED beams untouched", () => {
    const beam = { transaction_id: "T-1", beam_no: "B-1", status: "QC_PENDING", immersion_start: "x" };
    const next = abortReducer(beam, "T-1");
    expect(next).toBe(beam);
  });

  it("leaves LOADED beams with no captures untouched", () => {
    const beam = { transaction_id: "T-1", beam_no: "B-1", status: "LOADED" };
    const next = abortReducer(beam, "T-1");
    expect(next).toBe(beam);
  });

  it("ignores beams with a different transaction id", () => {
    const beam = { transaction_id: "T-2", beam_no: "B-2", status: "DIPPING", immersion_start: "x" };
    const next = abortReducer(beam, "T-1");
    expect(next).toBe(beam);
  });
});
