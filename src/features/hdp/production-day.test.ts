import { describe, it, expect } from "vitest";
import {
  productionDayIdTz,
  productionHourIndex,
  productionWindow,
  bucketLabel,
  bucketIsNextDay,
  nextDateStr,
  productionRange,
  inProductionRange,
  productionShift,
  productionRangeLabel,
} from "./production-day";
import { parseTzLocal } from "@/lib/tz";

const ist = (s: string) => parseTzLocal(s)!;

describe("production day boundaries (IST 06:00 → 06:00)", () => {
  it("05:59 on 08/08 belongs to the previous production day", () => {
    expect(productionDayIdTz(ist("2026-08-08T05:59:00"))).toBe("2026-08-07");
  });
  it("06:00 on 08/08 belongs to 08/08", () => {
    expect(productionDayIdTz(ist("2026-08-08T06:00:00"))).toBe("2026-08-08");
  });
  it("05:59 on 09/08 still belongs to 08/08", () => {
    expect(productionDayIdTz(ist("2026-08-09T05:59:59"))).toBe("2026-08-08");
  });
  it("06:00 on 09/08 starts the 09/08 production day", () => {
    expect(productionDayIdTz(ist("2026-08-09T06:00:00"))).toBe("2026-08-09");
  });
  it("handles empty/invalid input", () => {
    expect(productionDayIdTz(null)).toBe("");
    expect(productionDayIdTz("nonsense")).toBe("");
  });
});

describe("bucket mapping", () => {
  it("maps hours to 06-anchored indices", () => {
    expect(productionHourIndex(ist("2026-08-08T06:00:00"))).toBe(0);
    expect(productionHourIndex(ist("2026-08-08T07:59:00"))).toBe(1);
    expect(productionHourIndex(ist("2026-08-09T00:30:00"))).toBe(18);
    expect(productionHourIndex(ist("2026-08-09T05:59:00"))).toBe(23);
  });
  it("labels buckets", () => {
    expect(bucketLabel(0)).toBe("06:00 – 07:00");
    expect(bucketLabel(17)).toBe("23:00 – 00:00");
    expect(bucketLabel(23)).toBe("05:00 – 06:00");
  });
  it("flags post-midnight buckets", () => {
    expect(bucketIsNextDay(17)).toBe(false);
    expect(bucketIsNextDay(18)).toBe(true);
    expect(bucketIsNextDay(23)).toBe(true);
  });
});

describe("window", () => {
  it("spans 06:00 to next 06:00", () => {
    const w = productionWindow("2026-08-08");
    expect(w.start).toBe(ist("2026-08-08T06:00:00"));
    expect(w.end).toBe(ist("2026-08-09T06:00:00"));
    expect(nextDateStr("2026-08-31")).toBe("2026-09-01");
  });
});

describe("cumulative sequence", () => {
  it("accumulates within a production day and resets at the next 06:00", () => {
    const stamps = [
      ...Array(10).fill("2026-08-08T06:10:00"),
      ...Array(8).fill("2026-08-08T07:10:00"),
      ...Array(12).fill("2026-08-08T08:10:00"),
      ...Array(6).fill("2026-08-08T09:10:00"),
      "2026-08-09T06:05:00",
    ].map(ist);

    const day = "2026-08-08";
    const buckets = Array.from({ length: 24 }, () => 0);
    let dropped = 0;
    for (const s of stamps) {
      if (productionDayIdTz(s) !== day) { dropped++; continue; }
      buckets[productionHourIndex(s)]++;
    }
    expect(dropped).toBe(1);
    let cum = 0;
    const cums = buckets.map((n) => (cum += n));
    expect(cums[0]).toBe(10);
    expect(cums[1]).toBe(18);
    expect(cums[2]).toBe(30);
    expect(cums[3]).toBe(36);
    expect(cums[23]).toBe(36);
  });
});

describe("production range + shift", () => {
  it("spans from 06:00 of the first day to 06:00 after the last day", () => {
    const r = productionRange("2026-08-08", "2026-08-10");
    expect(r.start).toBe(ist("2026-08-08T06:00:00"));
    expect(r.end).toBe(ist("2026-08-11T06:00:00"));
  });
  it("includes the post-midnight tail of the last day", () => {
    expect(inProductionRange(ist("2026-08-11T05:59:00"), "2026-08-08", "2026-08-10")).toBe(true);
    expect(inProductionRange(ist("2026-08-11T06:00:00"), "2026-08-08", "2026-08-10")).toBe(false);
    expect(inProductionRange(ist("2026-08-08T05:59:00"), "2026-08-08", "2026-08-10")).toBe(false);
    expect(inProductionRange(ist("2026-08-08T06:00:00"), "2026-08-08", "2026-08-10")).toBe(true);
  });
  it("derives shifts from plant time", () => {
    expect(productionShift(ist("2026-08-08T06:00:00"))).toBe("A");
    expect(productionShift(ist("2026-08-08T13:59:00"))).toBe("A");
    expect(productionShift(ist("2026-08-08T14:00:00"))).toBe("B");
    expect(productionShift(ist("2026-08-08T22:00:00"))).toBe("C");
    expect(productionShift(ist("2026-08-09T05:59:00"))).toBe("C");
    expect(productionShift(null)).toBe("");
  });
  it("labels a production range", () => {
    expect(productionRangeLabel("2026-08-08", "2026-08-10")).toContain("06:00");
  });
});
