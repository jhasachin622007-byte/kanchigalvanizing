import { describe, it, expect } from "bun:test";
import {
  stageVariance,
  stageTimeline,
  timelineSummary,
  statusFor,
  fmtSignedDur,
  contributionPct,
  impactHint,
  summaryLine,
} from "./variance";

describe("statusFor", () => {
  it("returns On Target within ±5s", () => {
    expect(statusFor(0)).toBe("On Target");
    expect(statusFor(5)).toBe("On Target");
    expect(statusFor(-5)).toBe("On Target");
  });
  it("returns Slightly bands within ±20s", () => {
    expect(statusFor(15)).toBe("Slightly Higher");
    expect(statusFor(-15)).toBe("Slightly Lower");
  });
  it("returns Significantly bands beyond ±20s", () => {
    expect(statusFor(80)).toBe("Significantly Higher");
    expect(statusFor(-80)).toBe("Significantly Lower");
  });
  it("returns — when variance is null", () => {
    expect(statusFor(null)).toBe("—");
  });
});

describe("stageVariance", () => {
  it("computes per-stage variance + total", () => {
    const rows = stageVariance(
      { immersion: 22, reaction: 257, withdrawal: 125 },
      { immersion: 18, reaction: 174, withdrawal: 112 },
    );
    expect(rows.map((r) => r.variance)).toEqual([4, 83, 13, 100]);
    expect(rows[3].label).toBe("Total Time");
    expect(rows[1].status).toBe("Significantly Higher");
  });
  it("returns null variance when any current is missing", () => {
    const rows = stageVariance(
      { immersion: null, reaction: 10, withdrawal: 10 },
      { immersion: 10, reaction: 10, withdrawal: 10 },
    );
    expect(rows[0].variance).toBeNull();
    expect(rows[3].variance).toBeNull(); // total contaminated
  });
});

describe("fmtSignedDur", () => {
  it("formats seconds and minutes with sign", () => {
    expect(fmtSignedDur(0)).toBe("0s");
    expect(fmtSignedDur(4)).toBe("+4 sec");
    expect(fmtSignedDur(-12)).toBe("-12 sec");
    expect(fmtSignedDur(83)).toBe("+1m 23s");
    expect(fmtSignedDur(-100)).toBe("-1m 40s");
    expect(fmtSignedDur(120)).toBe("+2m");
  });
  it("returns — for null/NaN", () => {
    expect(fmtSignedDur(null)).toBe("—");
    expect(fmtSignedDur(undefined)).toBe("—");
    expect(fmtSignedDur(NaN)).toBe("—");
  });
});

describe("contributionPct + summaryLine", () => {
  it("computes contribution shares", () => {
    const rows = stageVariance(
      { immersion: 22, reaction: 257, withdrawal: 125 },
      { immersion: 18, reaction: 174, withdrawal: 112 },
    );
    const c = contributionPct(rows);
    const react = c.find((x) => x.key === "reaction")!;
    expect(react.pct).toBe(83);
  });
  it("summary mentions total + top contributor", () => {
    const rows = stageVariance(
      { immersion: 22, reaction: 257, withdrawal: 125 },
      { immersion: 18, reaction: 174, withdrawal: 112 },
    );
    const line = summaryLine(rows);
    expect(line).toContain("Total Δ +1m 40s");
    expect(line).toContain("Reaction contributed");
  });
});

describe("impactHint", () => {
  it("flags thicker / thinner / on-target", () => {
    expect(impactHint(60)).toMatch(/thicker/);
    expect(impactHint(-60)).toMatch(/thinner/);
    expect(impactHint(3)).toMatch(/track closely/);
    expect(impactHint(null)).toBe("");
  });
});

describe("stageTimeline (cumulative from immersion start)", () => {
  const rows = stageTimeline(
    { immersion: 100, reaction: 20, withdrawal: 40 },
    { immersion: 90, reaction: 20, withdrawal: 30 },
  );
  const get = (k: string) => rows.find((r) => r.key === k)!;

  it("starts at zero baseline", () => {
    expect(get("immersion-start").current).toBe(0);
    expect(get("immersion-start").variance).toBe(0);
  });

  it("accumulates elapsed time through the stages", () => {
    expect(get("immersion-end").current).toBe(100);
    expect(get("reaction-end").current).toBe(120);
    expect(get("withdrawal-end").current).toBe(160);
    expect(get("withdrawal-end").reference).toBe(140);
  });

  it("reports cumulative variance and total", () => {
    expect(get("immersion-end").variance).toBe(10);
    expect(get("reaction-end").variance).toBe(10);
    expect(get("total").variance).toBe(20);
    expect(get("total").stageCurrent).toBe(160);
  });

  it("summarises the timeline", () => {
    expect(timelineSummary(rows)).toContain("Total Δ");
  });
});
