import { describe, it, expect } from "vitest";
import { resolveRuleForPart, resolveMicronFromRules } from "./HdpApp";

const rules = [
  { prefix: "B2", thickness_min: 0, thickness_max: null, coating_required: 65, local_coating_required: 70, active: true },
  { prefix: "B2IA", thickness_min: 5, thickness_max: 8, coating_required: 87, local_coating_required: 96, active: true },
  { prefix: "ZZ", thickness_min: 0, thickness_max: null, coating_required: 130, local_coating_required: null, active: false },
];

describe("resolveRuleForPart", () => {
  it("picks the longest matching prefix inside the thickness range", () => {
    const r = resolveRuleForPart("B2IA-1001", 6, rules);
    expect(r?.prefix).toBe("B2IA");
    expect(r?.coating_required).toBe(87);
    expect(r?.local_coating_required).toBe(96);
  });
  it("falls back to the shorter prefix outside the range", () => {
    expect(resolveRuleForPart("B2IA-1001", 10, rules)?.prefix).toBe("B2");
  });
  it("ignores inactive rules", () => {
    expect(resolveRuleForPart("ZZ-1", 6, rules)).toBeNull();
  });
  it("returns null with no match, unknown thickness or empty part", () => {
    expect(resolveRuleForPart("QQ-1", 6, rules)).toBeNull();
    expect(resolveRuleForPart("B2IA-1", null, rules)).toBeNull();
    expect(resolveRuleForPart("", 6, rules)).toBeNull();
  });
  it("keeps resolveMicronFromRules behaviour", () => {
    expect(resolveMicronFromRules("B2IA-1", 6, rules)).toBe(87);
    expect(resolveMicronFromRules("QQ-1", 6, rules)).toBeNull();
  });
});

describe("local coating pop-up gate", () => {
  const gate = (part: string, thk: number | null) => {
    const r = resolveRuleForPart(part, thk, rules);
    return !!r && r.local_coating_required != null;
  };
  it("fires only when the matched rule has a local coating value", () => {
    expect(gate("B2IA-1001", 6)).toBe(true);
    expect(gate("B2-1", 10)).toBe(true);
  });
  it("does not fire without a matching rule", () => {
    expect(gate("QQ-1", 6)).toBe(false);
    expect(gate("", 6)).toBe(false);
  });
  it("does not fire when local_coating_required is null", () => {
    const noLocal = [{ prefix: "XX", thickness_min: 0, thickness_max: null, coating_required: 87, local_coating_required: null, active: true }];
    const r = resolveRuleForPart("XX-9", 6, noLocal);
    expect(r).not.toBeNull();
    expect(!!r && r.local_coating_required != null).toBe(false);
  });
});
