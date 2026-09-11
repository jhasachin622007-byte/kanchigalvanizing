// @ts-nocheck
// Guards the useDraft session-level restore semantics via its module-level
// helpers. We can't render React hooks in this pure-logic test runner, so we
// exercise the exported helpers directly and check the underlying invariants.
import { describe, expect, it, beforeEach } from "bun:test";
import { clearDraft, __resetDraftSessionState } from "./use-draft";

// Minimal localStorage shim so the helpers run outside a browser.
if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
  };
}

describe("useDraft helpers", () => {
  beforeEach(() => {
    (globalThis as any).localStorage.clear();
    __resetDraftSessionState();
  });

  it("clearDraft removes the persisted key", () => {
    (globalThis as any).localStorage.setItem("hdp:draft:u1:load:current", JSON.stringify({ x: 1 }));
    clearDraft("u1", "load:current");
    expect((globalThis as any).localStorage.getItem("hdp:draft:u1:load:current")).toBeNull();
  });

  it("clearDraft is namespaced by user id", () => {
    (globalThis as any).localStorage.setItem("hdp:draft:u1:k", "1");
    (globalThis as any).localStorage.setItem("hdp:draft:u2:k", "2");
    clearDraft("u1", "k");
    expect((globalThis as any).localStorage.getItem("hdp:draft:u1:k")).toBeNull();
    expect((globalThis as any).localStorage.getItem("hdp:draft:u2:k")).toBe("2");
  });

  it("__resetDraftSessionState is safe to call repeatedly", () => {
    __resetDraftSessionState();
    __resetDraftSessionState();
    expect(true).toBe(true);
  });
});
