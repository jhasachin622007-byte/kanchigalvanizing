// @ts-nocheck
// Invariants for the Transaction ID rollout. These guard the
// Loading → DIPPING → QC → Beam Tracker flow against regressions
// where the same beam_no is reused across multiple loading cycles.
import { describe, expect, it } from "bun:test";

// Mirror the helpers in HdpApp.tsx. Kept inline to avoid pulling the
// 4500-line component module (and React) into the test runtime.
function makeTxnId(beamNo: string, iso: string, existing: any[]) {
  const d = new Date(iso);
  const h = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const base = `${beamNo}-${h}:${mm}/${dd}`;
  let id = base, n = 2;
  const used = new Set((existing || []).map((b) => b.transaction_id).filter(Boolean));
  while (used.has(id)) { id = `${base}-${n++}`; }
  return id;
}
const txn = (b: any) => (b && (b.transaction_id || b.beam_no)) || "";

function materialOfferRowsFor(beams: any[]) {
  return beams
    .filter((b) => b.status === "COMPLETED")
    .flatMap((b) => {
      const rows = Array.isArray(b.parts_detail) && b.parts_detail.length
        ? b.parts_detail
        : [{ route_card: b.route_card, part: b.part_nos, qty: b.total_qty }];
      return rows.map((r: any) => ({
        transaction_id: b.transaction_id || b.beam_no,
        beam_no: b.beam_no,
        route_card_no: r.route_card || null,
        part_no: r.part || null,
        quantity: Number(r.qty) || null,
        coating_spec: b.coating_required ? String(b.coating_required) : null,
        qc_status: "OFFERED",
      }));
    });
}

describe("makeTxnId", () => {
  const iso = "2026-05-30T06:35:00.000Z";

  it("produces a stable BEAM-H:MM/DD shape", () => {
    const id = makeTxnId("B-05", iso, []);
    expect(id).toMatch(/^B-05-\d{1,2}:\d{2}\/\d{2}$/);
  });

  it("returns a fresh id when the same beam_no is reloaded later", () => {
    const first = makeTxnId("B-05", "2026-05-30T06:35:00Z", []);
    const second = makeTxnId(
      "B-05",
      "2026-05-30T09:10:00Z",
      [{ transaction_id: first, beam_no: "B-05" }],
    );
    expect(second).not.toBe(first);
  });

  it("appends -2/-3 when two loads collide in the same minute", () => {
    const a = makeTxnId("B-05", iso, []);
    const b = makeTxnId("B-05", iso, [{ transaction_id: a }]);
    const c = makeTxnId("B-05", iso, [{ transaction_id: a }, { transaction_id: b }]);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(b.endsWith("-2")).toBe(true);
    expect(c.endsWith("-3")).toBe(true);
  });
});

describe("txn() resolver", () => {
  it("prefers transaction_id, falls back to beam_no for legacy rows", () => {
    expect(txn({ transaction_id: "B-05-6:35/30", beam_no: "B-05" })).toBe("B-05-6:35/30");
    expect(txn({ beam_no: "B-05" })).toBe("B-05");
    expect(txn(null)).toBe("");
  });
});

describe("Edit/Delete target the correct cycle when beam_no is reused", () => {
  const cycles = [
    { transaction_id: "B-05-6:35/30", beam_no: "B-05", status: "COMPLETED", total_weight: 1.2 },
    { transaction_id: "B-05-9:10/30", beam_no: "B-05", status: "DIPPING",   total_weight: 1.4 },
    { transaction_id: "B-05-14:0/30", beam_no: "B-05", status: "LOADED",    total_weight: 1.1 },
  ];

  it("deleting by transaction_id removes only the targeted cycle", () => {
    const target = "B-05-9:10/30";
    const set = new Set([target]);
    const after = cycles.filter((b) => !set.has(b.transaction_id || b.beam_no));
    expect(after).toHaveLength(2);
    expect(after.find((b) => b.transaction_id === target)).toBeUndefined();
    // Other cycles for the same beam_no stay intact.
    expect(after.filter((b) => b.beam_no === "B-05")).toHaveLength(2);
  });

  it("editing by transaction_id updates only the targeted cycle", () => {
    const target = "B-05-14:0/30";
    const after = cycles.map((b) =>
      (b.transaction_id || b.beam_no) === target ? { ...b, total_weight: 2.0 } : b,
    );
    expect(after.find((b) => b.transaction_id === target)?.total_weight).toBe(2.0);
    expect(after.find((b) => b.transaction_id === "B-05-6:35/30")?.total_weight).toBe(1.2);
    expect(after.find((b) => b.transaction_id === "B-05-9:10/30")?.total_weight).toBe(1.4);
  });

  it("Dipping next-batch lookup by beam_no picks the latest available cycle", () => {
    // Reproduces the Dipping floor logic at HdpApp.tsx line 1740:
    // filter by beam_no + available status, then sort by loaded_at DESC.
    const rows = [
      { transaction_id: "B-05-6:35/30", beam_no: "B-05", status: "DIPPING", loaded_at: "2026-05-30T06:35:00Z" },
      { transaction_id: "B-05-14:0/30", beam_no: "B-05", status: "LOADED",  loaded_at: "2026-05-30T14:00:00Z" },
      { transaction_id: "B-05-9:10/30", beam_no: "B-05", status: "COMPLETED", loaded_at: "2026-05-30T09:10:00Z" },
    ];
    const latest = rows
      .filter((b) => b.beam_no === "B-05" && (b.status === "LOADED" || b.status === "DIPPING"))
      .sort((a, b) => new Date(b.loaded_at).getTime() - new Date(a.loaded_at).getTime())[0];
    expect(latest.transaction_id).toBe("B-05-14:0/30");
  });
});

describe("Cloud sync round-trip preserves cycle identity", () => {
  // Mirrors useBeams' itemToRow / rowToItem in src/lib/cloud-sync.ts —
  // guarantees a refresh re-hydrates each cycle as its own row.
  function itemToRow(i: any) {
    const { transaction_id, beam_no, status, material_type, surface_condition, ...rest } = i;
    return {
      transaction_id: transaction_id || beam_no,
      beam_no,
      status,
      material_type: material_type ?? null,
      surface_condition: surface_condition ?? null,
      data: rest,
    };
  }
  function rowToItem(r: any) {
    const data = r.data || {};
    return {
      transaction_id: r.transaction_id || r.beam_no,
      beam_no: r.beam_no,
      status: r.status,
      ...data,
      material_type: r.material_type ?? data.material_type ?? null,
      surface_condition: r.surface_condition ?? data.surface_condition ?? null,
    };
  }

  it("survives a serialize / reload cycle without merging same-beam_no rows", () => {
    const items = [
      { transaction_id: "B-05-6:35/30", beam_no: "B-05", status: "COMPLETED", total_weight: 1.2 },
      { transaction_id: "B-05-9:10/30", beam_no: "B-05", status: "DIPPING",   total_weight: 1.4 },
    ];
    const rows = items.map(itemToRow);
    expect(rows.map((r) => r.transaction_id).sort()).toEqual(
      ["B-05-6:35/30", "B-05-9:10/30"].sort(),
    );
    const reloaded = rows.map(rowToItem);
    expect(reloaded).toHaveLength(2);
    expect(reloaded[0].total_weight).toBe(1.2);
    expect(reloaded[1].total_weight).toBe(1.4);
  });

  it("persists material type and surface condition as first-class beam fields", () => {
    const loaded = {
      transaction_id: "B-09-8:15/05",
      beam_no: "B-09",
      status: "LOADED",
      material_type: "HT",
      total_weight: 1.25,
    };
    const dipping = {
      ...loaded,
      status: "QC_PENDING",
      surface_condition: "Rusted",
      immersion_start: "2026-07-05T08:15:00.000Z",
      withdrawal_end: "2026-07-05T08:20:00.000Z",
    };
    const completed = {
      ...dipping,
      status: "COMPLETED",
      avg_reading: 92.4,
      qc_status: "PASS",
    };

    const reloaded = rowToItem(itemToRow(completed));
    expect(reloaded.transaction_id).toBe("B-09-8:15/05");
    expect(reloaded.status).toBe("COMPLETED");
    expect(reloaded.material_type).toBe("HT");
    expect(reloaded.surface_condition).toBe("Rusted");
    expect(reloaded.avg_reading).toBe(92.4);
  });

  it("runs a pre-seeded Loading → Dipping → Coating → Material Offer flow", () => {
    const transaction_id = makeTxnId("B-77", "2026-07-05T08:15:00.000Z", []);
    const loaded = {
      transaction_id,
      beam_no: "B-77",
      status: "LOADED",
      material_type: "MS",
      loaded_at: "2026-07-05T08:15:00.000Z",
      route_card: "RC-77",
      parts_detail: [{ part: "P-77", qty: 2, route_card: "RC-77" }],
      coating_required: 87,
      total_weight: 1.45,
    };

    const dipping = {
      ...loaded,
      status: "DIPPING",
      immersion_start: "2026-07-05T08:20:00.000Z",
      dipped_by: "operator-1",
      dipped_by_name: "Operator One",
    };
    const qcPending = {
      ...dipping,
      status: "QC_PENDING",
      immersion_end: "2026-07-05T08:21:00.000Z",
      reaction_end: "2026-07-05T08:22:00.000Z",
      withdrawal_end: "2026-07-05T08:23:00.000Z",
      dipped_at: "2026-07-05T08:23:00.000Z",
      surface_condition: "Normal",
      bath_temperature: 452,
    };
    const completed = {
      ...qcPending,
      status: "COMPLETED",
      elcometer: [90, 91, 92, 93, 94, 92, 91],
      avg_reading: 91.86,
      qc_status: "PASS",
      qc_completed_at: "2026-07-05T08:30:00.000Z",
    };

    const persistedRows = [loaded, dipping, qcPending, completed].map(itemToRow);
    const reloaded = persistedRows.map(rowToItem);

    expect(reloaded.map((b) => b.status)).toEqual(["LOADED", "DIPPING", "QC_PENDING", "COMPLETED"]);
    expect(reloaded.every((b) => b.transaction_id === transaction_id)).toBe(true);
    expect(reloaded.at(-1)?.material_type).toBe("MS");
    expect(reloaded.at(-1)?.surface_condition).toBe("Normal");

    const offers = materialOfferRowsFor([reloaded.at(-1)]);
    expect(offers).toEqual([
      {
        transaction_id,
        beam_no: "B-77",
        route_card_no: "RC-77",
        part_no: "P-77",
        quantity: 2,
        coating_spec: "87",
        qc_status: "OFFERED",
      },
    ]);
  });
});
