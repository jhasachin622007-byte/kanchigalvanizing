// @ts-nocheck
// Guards the cloud-sync change that splits a beam diff into
// inserts / updates / deletes. Existing rows must NEVER be reclassified
// as inserts, because the Dipping/QC roles cannot INSERT beams and an
// upsert path would silently drop their saves.
import { describe, expect, it } from "bun:test";

function classify(prev: any[], next: any[], idKey = "transaction_id") {
  const prevById = new Map(prev.map((x) => [x[idKey], x]));
  const nextById = new Map(next.map((x) => [x[idKey], x]));
  const inserts: any[] = [];
  const updates: any[] = [];
  for (const [k, v] of nextById) {
    const old = prevById.get(k);
    if (!old) inserts.push(v);
    else if (JSON.stringify(old) !== JSON.stringify(v)) updates.push({ id: k, row: v });
  }
  const deletes: any[] = [];
  for (const k of prevById.keys()) if (!nextById.has(k)) deletes.push(k);
  return { inserts, updates, deletes };
}

const loaded = { transaction_id: "B-05-6:35/30", beam_no: "B-05", status: "LOADED" };

describe("cloud-sync classify", () => {
  it("classifies a new beam as INSERT", () => {
    const out = classify([], [loaded]);
    expect(out.inserts).toHaveLength(1);
    expect(out.updates).toHaveLength(0);
  });

  it("classifies a Dipping save as UPDATE, never as insert", () => {
    const next = [{ ...loaded, status: "QC_PENDING", dipped_at: "x" }];
    const out = classify([loaded], next);
    expect(out.inserts).toHaveLength(0);
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0].id).toBe(loaded.transaction_id);
  });

  it("classifies a Coating save as UPDATE on the same transaction_id", () => {
    const dipped = { ...loaded, status: "QC_PENDING" };
    const completed = { ...dipped, status: "COMPLETED", avg_reading: 92 };
    const out = classify([dipped], [completed]);
    expect(out.inserts).toHaveLength(0);
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0].id).toBe(dipped.transaction_id);
  });

  it("classifies reusing the same beam_no in a new cycle as INSERT of the new transaction only", () => {
    const cycle1 = { transaction_id: "B-05-6:35/30", beam_no: "B-05", status: "COMPLETED" };
    const cycle2 = { transaction_id: "B-05-9:10/30", beam_no: "B-05", status: "LOADED" };
    const out = classify([cycle1], [cycle1, cycle2]);
    expect(out.inserts).toHaveLength(1);
    expect(out.inserts[0].transaction_id).toBe(cycle2.transaction_id);
    expect(out.updates).toHaveLength(0);
    expect(out.deletes).toHaveLength(0);
  });

  it("classifies a removed cycle as DELETE by transaction_id", () => {
    const out = classify([loaded], []);
    expect(out.deletes).toEqual([loaded.transaction_id]);
  });
});
