// Statistical Process Control (SPC) — pure math for X-bar/R and I-MR charts
// plus the 4-rule violation engine specified for the Six Sigma dashboard.
// No React, no side effects — fully unit-testable.

export type Limits = { cl: number; ucl: number; lcl: number };
export type IMR = { i: Limits; mr: Limits; mrBar: number; sigma: number };
export type XbarR = { xbar: Limits; r: Limits; rBar: number; subgroupSize: number };

// ── Control-chart constants ───────────────────────────────────────────────
// Source: standard SPC tables (Montgomery, "Statistical Quality Control").
// n = subgroup size.
const A2: Record<number, number> = { 2: 1.880, 3: 1.023, 4: 0.729, 5: 0.577, 6: 0.483, 7: 0.419, 8: 0.373, 9: 0.337, 10: 0.308 };
const D3: Record<number, number> = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0.076, 8: 0.136, 9: 0.184, 10: 0.223 };
const D4: Record<number, number> = { 2: 3.267, 3: 2.574, 4: 2.282, 5: 2.114, 6: 2.004, 7: 1.924, 8: 1.864, 9: 1.816, 10: 1.777 };
const d2: Record<number, number> = { 2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534, 7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078 };

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

// ── I-MR (Individuals & Moving Range) ────────────────────────────────────
// For continuous streams where subgrouping is not natural (bath temp,
// dipping time per beam).
export const iMR = (xs: number[]): IMR | null => {
  if (xs.length < 2) return null;
  const mrs: number[] = [];
  for (let i = 1; i < xs.length; i++) mrs.push(Math.abs(xs[i] - xs[i - 1]));
  const xBar = avg(xs);
  const mrBar = avg(mrs);
  const sigma = mrBar / d2[2]; // 1.128
  return {
    i: { cl: xBar, ucl: xBar + 2.66 * mrBar, lcl: xBar - 2.66 * mrBar },
    mr: { cl: mrBar, ucl: D4[2] * mrBar, lcl: D3[2] * mrBar },
    mrBar,
    sigma,
  };
};

// ── X-bar / R (subgrouped) ───────────────────────────────────────────────
// `groups` is an array of subgroups (each an array of readings). All
// subgroups must be the same size (2..10).
export const xBarR = (groups: number[][]): XbarR | null => {
  const clean = groups.filter((g) => g.length >= 2);
  if (clean.length < 2) return null;
  const n = clean[0].length;
  if (!A2[n]) return null;
  if (clean.some((g) => g.length !== n)) return null;
  const means = clean.map(avg);
  const ranges = clean.map((g) => Math.max(...g) - Math.min(...g));
  const xDbar = avg(means);
  const rBar = avg(ranges);
  return {
    xbar: { cl: xDbar, ucl: xDbar + A2[n] * rBar, lcl: xDbar - A2[n] * rBar },
    r: { cl: rBar, ucl: D4[n] * rBar, lcl: D3[n] * rBar },
    rBar,
    subgroupSize: n,
  };
};

// Group readings into fixed-size chronological subgroups. Trailing partial
// group is dropped (X-bar/R requires equal subgroup size).
export const subgroupBySize = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i + size <= items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// ── Rule engine (the 4 rules from the spec) ──────────────────────────────
export type Rule = 1 | 2 | 3 | 4;
export type Violation = { index: number; rule: Rule; description: string };

export const RULE_LABEL: Record<Rule, string> = {
  1: "Beyond control limit",
  2: "7 consecutive on one side of CL",
  3: "7 consecutive trend",
  4: "Cyclic / alternating pattern",
};

// Suggested corrective action per rule (surface as a hint in the UI).
export const RULE_ACTION: Record<Rule, string> = {
  1: "Investigate special cause immediately — check operator, material batch, and equipment.",
  2: "Process has shifted — recalibrate setpoint and re-verify inputs.",
  3: "Sustained drift — check for tool wear, temperature bath ageing, or reagent depletion.",
  4: "Recurring pattern — investigate shift changeovers, cyclical maintenance, or automated controllers.",
};

export const detectViolations = (xs: number[], limits: Limits): Violation[] => {
  const out: Violation[] = [];
  const { cl, ucl, lcl } = limits;

  // Rule 1 — beyond UCL/LCL
  xs.forEach((v, i) => {
    if (v > ucl || v < lcl) out.push({ index: i, rule: 1, description: RULE_LABEL[1] });
  });

  // Rule 2 — 7 consecutive on same side of CL
  for (let i = 6; i < xs.length; i++) {
    const w = xs.slice(i - 6, i + 1);
    if (w.every((v) => v > cl) || w.every((v) => v < cl)) {
      out.push({ index: i, rule: 2, description: RULE_LABEL[2] });
    }
  }

  // Rule 3 — 7 consecutive strictly increasing or decreasing
  for (let i = 6; i < xs.length; i++) {
    const w = xs.slice(i - 6, i + 1);
    let inc = true, dec = true;
    for (let k = 1; k < w.length; k++) {
      if (w[k] <= w[k - 1]) inc = false;
      if (w[k] >= w[k - 1]) dec = false;
    }
    if (inc || dec) out.push({ index: i, rule: 3, description: RULE_LABEL[3] });
  }

  // Rule 4 — 14 consecutive alternating up/down (cyclic / sawtooth).
  for (let i = 13; i < xs.length; i++) {
    const w = xs.slice(i - 13, i + 1);
    let alt = true;
    for (let k = 2; k < w.length; k++) {
      const a = w[k] - w[k - 1];
      const b = w[k - 1] - w[k - 2];
      if (a === 0 || b === 0 || Math.sign(a) === Math.sign(b)) { alt = false; break; }
    }
    if (alt) out.push({ index: i, rule: 4, description: RULE_LABEL[4] });
  }

  return out;
};

// Aggregate distinct violated indices (dedupes across rules) for a quick
// "stable / unstable" verdict.
export const violatedIndices = (v: Violation[]): Set<number> => {
  const s = new Set<number>();
  v.forEach((x) => s.add(x.index));
  return s;
};
