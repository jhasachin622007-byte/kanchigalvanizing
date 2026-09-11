// @ts-nocheck
// Guards the reconcile merge: locally pending writes must survive a stale
// server snapshot so Loading beam disappearance, Dipping "auto-cut", and
// Reset snap-back can never happen.
import { describe, expect, it } from "bun:test";
import { mergeWithDirty } from "./cloud-sync";

const idOf = (r: any) => r.id;

describe("mergeWithDirty", () => {
  it("keeps a locally-inserted row the server hasn't shown yet", () => {
    const local = [{ id: "a", status: "LOADED" }];
    const server: any[] = [];
    const dirty = new Map([["a", { kind: "insert" as const, at: Date.now() }]]);
    const out = mergeWithDirty({ server, local, dirty, idOf });
    expect(out).toEqual([{ id: "a", status: "LOADED" }]);
  });

  it("prefers the local updated row over a stale server row", () => {
    const local = [{ id: "a", status: "LOADED", immersion_start: null }];
    const server = [{ id: "a", status: "DIPPING", immersion_start: "2026-07-01" }];
    const dirty = new Map([["a", { kind: "update" as const, at: Date.now() }]]);
    const out = mergeWithDirty({ server, local, dirty, idOf });
    expect(out[0].status).toBe("LOADED");
    expect(out[0].immersion_start).toBeNull();
  });

  it("keeps a freshly-loaded beam visible while insert is pending", () => {
    const local = [{ id: "TX-LOAD-1", beam_no: "B-10", status: "LOADED" }];
    const server = [{ id: "old", beam_no: "B-OLD", status: "LOADED" }];
    const dirty = new Map([["TX-LOAD-1", { kind: "insert" as const, at: Date.now() }]]);
    const out = mergeWithDirty({ server, local, dirty, idOf });
    expect(out.map((x) => x.id)).toContain("TX-LOAD-1");
  });

  it("keeps Dipping save at QC_PENDING over stale DIPPING server state", () => {
    const local = [{ id: "a", status: "QC_PENDING", withdrawal_end: "done" }];
    const server = [{ id: "a", status: "DIPPING", withdrawal_end: null }];
    const dirty = new Map([["a", { kind: "update" as const, at: Date.now() }]]);
    const out = mergeWithDirty({ server, local, dirty, idOf });
    expect(out[0].status).toBe("QC_PENDING");
    expect(out[0].withdrawal_end).toBe("done");
  });

  it("keeps CoJ completion over stale QC_PENDING server state", () => {
    const local = [{ id: "a", status: "COMPLETED", avg_reading: 88.5 }];
    const server = [{ id: "a", status: "QC_PENDING", avg_reading: null }];
    const dirty = new Map([["a", { kind: "update" as const, at: Date.now() }]]);
    const out = mergeWithDirty({ server, local, dirty, idOf });
    expect(out[0].status).toBe("COMPLETED");
    expect(out[0].avg_reading).toBe(88.5);
  });

  it("keeps Reset back to LOADED over stale DIPPING server state", () => {
    const local = [{ id: "a", status: "LOADED", immersion_start: null, immersion_duration: null }];
    const server = [{ id: "a", status: "DIPPING", immersion_start: "2026-07-01", immersion_duration: 120 }];
    const dirty = new Map([["a", { kind: "update" as const, at: Date.now() }]]);
    const out = mergeWithDirty({ server, local, dirty, idOf });
    expect(out[0].status).toBe("LOADED");
    expect(out[0].immersion_start).toBeNull();
    expect(out[0].immersion_duration).toBeNull();
  });

  it("does not re-add a locally-deleted row", () => {
    const local: any[] = [];
    const server = [{ id: "a", status: "LOADED" }];
    const dirty = new Map([["a", { kind: "delete" as const, at: Date.now() }]]);
    const out = mergeWithDirty({ server, local, dirty, idOf });
    expect(out).toEqual([]);
  });

  it("takes the server row when no dirty entry exists", () => {
    const local = [{ id: "a", status: "LOADED" }];
    const server = [{ id: "a", status: "QC_PENDING" }];
    const out = mergeWithDirty({ server, local, dirty: new Map(), idOf });
    expect(out[0].status).toBe("QC_PENDING");
  });

  it("takes the server row for an updated id when local copy is missing", () => {
    const server = [{ id: "a", status: "QC_PENDING" }];
    const dirty = new Map([["a", { kind: "update" as const, at: Date.now() }]]);
    const out = mergeWithDirty({ server, local: [], dirty, idOf });
    expect(out).toEqual([{ id: "a", status: "QC_PENDING" }]);
  });
});
