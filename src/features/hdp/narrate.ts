// Deterministic recommendation-narration layer (spec §7, template-only).
// Turns already-computed numbers into the single plant-floor sentence shown
// in the AI Insights panel. No LLM, no calculation — templates only.

export type NarrationSource = "exact" | "closest" | "regression";

export type NarrationInput = {
  source: NarrationSource;
  predicted_um?: number | null;
  target_lo?: number | null;
  target_hi?: number | null;
  required_um?: number | null;
  immersion_s?: number | null;
  reaction_s?: number | null;
  withdrawal_s?: number | null;
  total_s?: number | null;
  delta_s?: number | null;                 // + = reduce time, − = increase
  non_compatible?: string[];
  confidence_pct?: number | null;
  low_sample?: boolean;
};

export type NarrationOutput = {
  sentence: string;
  source_label: "Exact Match" | "Closest Compatible Match" | "Regression Prediction";
  low_confidence: boolean;
};

const LABELS: Record<NarrationSource, NarrationOutput["source_label"]> = {
  exact: "Exact Match",
  closest: "Closest Compatible Match",
  regression: "Regression Prediction",
};

function round(n: number | null | undefined): number {
  return Math.round(Number(n) || 0);
}

export function narrate(input: NarrationInput): NarrationOutput {
  const conf = Number(input.confidence_pct ?? 100);
  const lowConfidence = !!input.low_sample || conf < 60;
  let body = "";

  if (input.source === "exact") {
    const pred = round(input.predicted_um);
    const lo = round(input.target_lo);
    const hi = round(input.target_hi);
    const d = round(input.delta_s);
    if (d > 0 && pred > hi) {
      body = `Reduce total dipping time by ${d}s to bring ${pred}µm down to the ${lo}–${hi}µm target.`;
    } else if (d < 0 && pred < lo) {
      body = `Increase total dipping time by ${Math.abs(d)}s to lift ${pred}µm up to the ${lo}–${hi}µm target.`;
    } else {
      body = `Hold current timing — predicted ${pred}µm sits inside the ${lo}–${hi}µm target band.`;
    }
  } else if (input.source === "closest") {
    const total = round(input.total_s);
    const fields = (input.non_compatible ?? []).filter(Boolean);
    const fieldList =
      fields.length === 0
        ? "Covariates"
        : fields.length === 1
          ? fields[0]
          : fields.length === 2
            ? `${fields[0]} and ${fields[1]}`
            : `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;
    const verb = fields.length <= 1 ? "differs" : "differ";
    body = `${fieldList} ${verb} from closest matching record — timing adjusted automatically to ${total}s total.`;
  } else {
    const pred = round(input.predicted_um);
    const target = round(input.target_lo);
    const total = round(input.total_s);
    const delta = round(input.delta_s);
    const absD = Math.abs(delta);
    if (delta === 0 || absD < 1) {
      body = `Current predicted coating is ${pred} µm vs regression target ${target} µm. Hold total dipping time at ${total}s — trained MLR expects ~${target} µm.`;
    } else if (delta < 0) {
      body = `Current predicted coating is ${pred} µm vs regression target ${target} µm. Based on the trained MLR, reduce total dipping time by ${absD}s (to ${total}s) to reach ~${target} µm while keeping process stability.`;
    } else {
      body = `Current predicted coating is ${pred} µm vs regression target ${target} µm. Based on the trained MLR, increase total dipping time by ${absD}s (to ${total}s) to reach ~${target} µm while keeping process stability.`;
    }
  }

  const sentence = lowConfidence ? `Low confidence — supervisor review. ${body}` : body;
  return { sentence, source_label: LABELS[input.source], low_confidence: lowConfidence };
}
