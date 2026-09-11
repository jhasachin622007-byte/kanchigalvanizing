import { describe, expect, it } from "bun:test";
import {
  emptyV2, isV2, subAverages, totalAverage, flatReadings, minMax,
  validateV2Strings, stringsToV2, v2ToStrings, overCapPoint,
} from "./coj-readings";

const sample = {
  fw: { out: [70, 72, 74, 76, 78], in: [80, 82, 84, 86, 88] },
  mw: { out: [90, 92, 94, 96, 98], in: [100, 102, 104, 106, 108] },
  lw: { out: [60, 62, 64, 66, 68], in: [50, 52, 54, 56, 58] },
};

describe("coj-readings v2", () => {
  it("isV2 rejects legacy 7-point beam", () => {
    expect(isV2({ elcometer: [1, 2, 3, 4, 5, 6, 7] })).toBe(false);
    expect(isV2({})).toBe(false);
    expect(isV2(null)).toBe(false);
  });

  it("isV2 accepts well-formed v2 beam", () => {
    expect(isV2({ elcometer_v2: sample })).toBe(true);
    expect(isV2({ elcometer_v2: emptyV2() })).toBe(true);
  });

  it("subAverages returns six sub-averages", () => {
    const s = subAverages(sample);
    expect(s.fwOut).toBe(74);
    expect(s.fwIn).toBe(84);
    expect(s.mwOut).toBe(94);
    expect(s.mwIn).toBe(104);
    expect(s.lwOut).toBe(64);
    expect(s.lwIn).toBe(54);
  });

  it("totalAverage averages the six sub-averages", () => {
    // (74+84+94+104+64+54)/6 = 79
    expect(totalAverage(sample)).toBe(79);
  });

  it("flatReadings returns all 30 numbers", () => {
    expect(flatReadings(sample).length).toBe(30);
  });

  it("minMax across 30 readings", () => {
    const mm = minMax(sample);
    expect(mm.min).toBe(50);
    expect(mm.max).toBe(108);
  });

  it("validateV2Strings flags missing / zero readings", () => {
    const s = v2ToStrings(sample);
    expect(validateV2Strings(s).ok).toBe(true);
    s.fw_out[2] = "";
    expect(validateV2Strings(s).ok).toBe(false);
    s.fw_out[2] = "0";
    expect(validateV2Strings(s).ok).toBe(false);
  });

  it("stringsToV2 round-trips", () => {
    const back = stringsToV2(v2ToStrings(sample));
    expect(back.fw.out).toEqual(sample.fw.out);
    expect(back.lw.in).toEqual(sample.lw.in);
  });

  it("overCapPoint detects a value above cap", () => {
    const s = v2ToStrings(sample);
    expect(overCapPoint(s, 500)).toBeNull();
    s.mw_in[3] = "600";
    const hit = overCapPoint(s, 500);
    expect(hit?.group).toBe("mw_in");
    expect(hit?.idx).toBe(3);
  });
});
