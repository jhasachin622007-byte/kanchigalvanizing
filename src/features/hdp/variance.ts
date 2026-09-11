// Stage-by-stage variance between current beam and closest-match reference beam.
// Pure utilities, no React/DOM dependencies.

export type StageKey = "immersion" | "reaction" | "withdrawal" | "total";

export type StageStatus =
  | "On Target"
  | "Slightly Higher"
  | "Slightly Lower"
  | "Significantly Higher"
  | "Significantly Lower"
  | "—";

export type StageRow = {
  key: StageKey;
  label: string;
  current: number | null;
  reference: number | null;
  variance: number | null; // current - reference
  status: StageStatus;
};

export type DurationsInput = {
  immersion: number | null | undefined;
  reaction: number | null | undefined;
  withdrawal: number | null | undefined;
};

const num = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function statusFor(variance: number | null): StageStatus {
  if (variance == null) return "—";
  const a = Math.abs(variance);
  if (a <= 5) return "On Target";
  if (variance > 0) return a <= 20 ? "Slightly Higher" : "Significantly Higher";
  return a <= 20 ? "Slightly Lower" : "Significantly Lower";
}

export function stageVariance(
  current: DurationsInput,
  reference: DurationsInput,
): StageRow[] {
  const stages: Array<[StageKey, string, keyof DurationsInput]> = [
    ["immersion", "Immersion", "immersion"],
    ["reaction", "Reaction", "reaction"],
    ["withdrawal", "Withdrawal", "withdrawal"],
  ];
  const rows: StageRow[] = stages.map(([key, label, fk]) => {
    const c = num(current[fk]);
    const r = num(reference[fk]);
    const v = c != null && r != null ? c - r : null;
    return { key, label, current: c, reference: r, variance: v, status: statusFor(v) };
  });
  const cTotal = rows.reduce<number | null>(
    (s, r) => (s == null || r.current == null ? null : s + r.current),
    0,
  );
  const rTotal = rows.reduce<number | null>(
    (s, r) => (s == null || r.reference == null ? null : s + r.reference),
    0,
  );
  const vTotal = cTotal != null && rTotal != null ? cTotal - rTotal : null;
  rows.push({
    key: "total",
    label: "Total Time",
    current: cTotal,
    reference: rTotal,
    variance: vTotal,
    status: statusFor(vTotal),
  });
  return rows;
}

export function fmtSignedDur(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  if (s === 0) return "0s";
  const sign = s > 0 ? "+" : "-";
  const a = Math.abs(s);
  if (a < 60) return `${sign}${a} sec`;
  const m = Math.floor(a / 60);
  const r = a % 60;
  return r ? `${sign}${m}m ${String(r).padStart(2, "0")}s` : `${sign}${m}m`;
}

export function contributionPct(rows: StageRow[]): Array<{ key: StageKey; pct: number }> {
  const total = rows.find((r) => r.key === "total");
  const denom = total?.variance != null ? Math.abs(total.variance) : 0;
  if (!denom) return [];
  return rows
    .filter((r) => r.key !== "total" && r.variance != null)
    .map((r) => ({ key: r.key, pct: Math.round((Math.abs(r.variance!) / denom) * 100) }));
}

export function impactHint(totalVariance: number | null): string {
  if (totalVariance == null) return "";
  const a = Math.abs(totalVariance);
  if (a <= 5) return "Process time matches reference — coating expected to track closely.";
  if (totalVariance > 0)
    return "Longer total process time vs reference — coating likely thicker than reference.";
  return "Shorter total process time vs reference — coating likely thinner than reference.";
}

export function summaryLine(rows: StageRow[]): string {
  const total = rows.find((r) => r.key === "total");
  if (!total || total.variance == null) return "";
  const contrib = contributionPct(rows).sort((a, b) => b.pct - a.pct)[0];
  const stageLabel = contrib
    ? rows.find((r) => r.key === contrib.key)?.label ?? ""
    : "";
  const parts = [`Total Δ ${fmtSignedDur(total.variance)}`];
  if (contrib && stageLabel) parts.push(`${stageLabel} contributed ${contrib.pct}%`);
  const hint = impactHint(total.variance);
  if (hint) parts.push(`Likely impact: ${hint.replace(/\.$/, "")}`);
  return parts.join(" · ");
}

// ── Cumulative dipping timeline (Immersion Start → Withdrawal End) ──────────
// Stage-by-stage variance shown as a timeline that starts at Immersion Start
// (00:00 baseline) and walks through every dipping stage, carrying both the
// stage duration and the elapsed time since Immersion Start.

export type TimelineKey =
  | "immersion-start"
  | "immersion-end"
  | "reaction-end"
  | "withdrawal-end"
  | "total";

export type TimelineRow = {
  key: TimelineKey;
  label: string;
  /** Duration of the stage that ends at this milestone (null for the start). */
  stageCurrent: number | null;
  stageReference: number | null;
  /** Elapsed time from Immersion Start to this milestone. */
  current: number | null;
  reference: number | null;
  /** current - reference on the cumulative elapsed time. */
  variance: number | null;
  status: StageStatus;
};

export function stageTimeline(
  current: DurationsInput,
  reference: DurationsInput,
): TimelineRow[] {
  const add = (a: number | null, b: number | null) =>
    a == null || b == null ? null : a + b;

  const c = {
    immersion: num(current.immersion),
    reaction: num(current.reaction),
    withdrawal: num(current.withdrawal),
  };
  const r = {
    immersion: num(reference.immersion),
    reaction: num(reference.reaction),
    withdrawal: num(reference.withdrawal),
  };

  const mk = (
    key: TimelineKey,
    label: string,
    stageCurrent: number | null,
    stageReference: number | null,
    curCum: number | null,
    refCum: number | null,
  ): TimelineRow => {
    const variance = curCum != null && refCum != null ? curCum - refCum : null;
    return {
      key,
      label,
      stageCurrent,
      stageReference,
      current: curCum,
      reference: refCum,
      variance,
      status: key === "immersion-start" ? "On Target" : statusFor(variance),
    };
  };

  const cImm = c.immersion;
  const rImm = r.immersion;
  const cReact = add(cImm, c.reaction);
  const rReact = add(rImm, r.reaction);
  const cWith = add(cReact, c.withdrawal);
  const rWith = add(rReact, r.withdrawal);

  return [
    mk("immersion-start", "Immersion Start", null, null, 0, 0),
    mk("immersion-end", "Immersion End", c.immersion, r.immersion, cImm, rImm),
    mk("reaction-end", "Reaction End", c.reaction, r.reaction, cReact, rReact),
    mk("withdrawal-end", "Withdrawal End", c.withdrawal, r.withdrawal, cWith, rWith),
    mk("total", "Total Time", cWith, rWith, cWith, rWith),
  ];
}

/** Summary sentence for the timeline (largest contributing stage + impact). */
export function timelineSummary(rows: TimelineRow[]): string {
  const total = rows.find((x) => x.key === "total");
  if (!total || total.variance == null) return "";
  const stages = rows.filter(
    (x) => x.key !== "total" && x.key !== "immersion-start" && x.stageCurrent != null && x.stageReference != null,
  );
  const denom = Math.abs(total.variance) || 0;
  let best: { label: string; pct: number } | null = null;
  for (const s of stages) {
    const d = Math.abs((s.stageCurrent as number) - (s.stageReference as number));
    const pct = denom ? Math.round((d / denom) * 100) : 0;
    if (!best || pct > best.pct) best = { label: s.label, pct };
  }
  const parts = [`Total Δ ${fmtSignedDur(total.variance)}`];
  if (best && best.pct > 0) parts.push(`${best.label} contributed ${best.pct}%`);
  const hint = impactHint(total.variance);
  if (hint) parts.push(`Likely impact: ${hint.replace(/\.$/, "")}`);
  return parts.join(" · ");
}
