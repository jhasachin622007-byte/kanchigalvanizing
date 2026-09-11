// AI prediction capture, validation and accuracy maths for the Dipping module.
//
// Predictions are snapshotted onto the beam record when dipping is saved
// (`ai_prediction`), then compared with the ACTUAL total dipping time and the
// actual average coating once the coating inspection is complete.

export type AiModelId = "mlr" | "lgbm" | "xgb" | "cat" | "zc";

export const AI_MODEL_IDS: AiModelId[] = ["mlr", "lgbm", "xgb", "cat", "zc"];

export const AI_MODEL_LABEL: Record<AiModelId, string> = {
  mlr: "Multiple Linear Regression",
  lgbm: "LightGBM",
  xgb: "XGBoost",
  cat: "CatBoost",
  zc: "zinccore (Deep Learning)",
};

export const AI_MODEL_SHORT: Record<AiModelId, string> = {
  mlr: "MLR",
  lgbm: "LightGBM",
  xgb: "XGBoost",
  cat: "CatBoost",
  zc: "zinccore",
};


/**
 * Admin selection is a list of models. Legacy single-value settings
 * ("mlr" | "lgbm" | "both") are migrated on read.
 */
export function normalizeAiSelection(raw: any): AiModelId[] {
  const clean = (arr: any[]): AiModelId[] => {
    const out = arr
      .map((v) => String(v ?? "").trim().toLowerCase())
      .filter((v): v is AiModelId => (AI_MODEL_IDS as string[]).includes(v));
    return Array.from(new Set(out));
  };
  if (Array.isArray(raw)) {
    const list = clean(raw);
    return list.length ? list : ["mlr"];
  }
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "both") return ["mlr", "lgbm"];
  if (s === "all") return [...AI_MODEL_IDS];
  const one = clean([s]);
  return one.length ? one : ["mlr"];
}

// ── Prediction snapshot ─────────────────────────────────────────────────────

export type AiPredictionModelSnapshot = {
  type: AiModelId;
  label: string;
  predictedSec: number;
  expectedCoating: number;
  targetCoating: number;
  confidencePct: number;
  r2: number;
  n: number;
  sentence?: string;
};

export type AiPredictionSnapshot = {
  capturedAt: string;
  /** Which history tier answered: exact / closest / AI-only. */
  tier: "exact" | "closest" | "regression";
  refBeamNo?: string | null;
  refSec?: number | null;
  refCoating?: number | null;
  bathTemp?: number | null;
  surface?: string | null;
  models: AiPredictionModelSnapshot[];
};

/** Build the snapshot stored on the beam from a computeRecommendation() result. */
export function buildPredictionSnapshot(
  rec: any,
  extra: { bathTemp?: number | null; surface?: string | null },
): AiPredictionSnapshot | null {
  if (!rec) return null;
  const blocks: any[] = Array.isArray(rec.aiBlocks) && rec.aiBlocks.length
    ? rec.aiBlocks
    : rec.mlr
      ? [rec.mlr]
      : [];
  const models = blocks
    .filter((b) => b?.hasModel)
    .map((b) => ({
      type: (b.modelType ?? "mlr") as AiModelId,
      label: b.modelLabel ?? AI_MODEL_LABEL[(b.modelType ?? "mlr") as AiModelId],
      predictedSec: Math.round(Number(b.predictedSec) || 0),
      expectedCoating: Number(Number(b.expectedCoating || 0).toFixed(2)),
      targetCoating: Number(b.targetCoating) || 0,
      confidencePct: Number(b.confidencePct) || 0,
      r2: Number(b.r2) || 0,
      n: Number(b.n) || 0,
      sentence: b.sentence ?? "",
    }));
  if (!models.length) return null;
  const ref = rec.best ?? null;
  const refSec = ref
    ? (Number(ref.immersion_duration) || 0) +
      (Number(ref.reaction_duration) || 0) +
      (Number(ref.withdrawal_duration) || 0)
    : null;
  return {
    capturedAt: new Date().toISOString(),
    tier: rec.regression ? "regression" : rec.recommendationType === "closest" ? "closest" : "exact",
    refBeamNo: ref?.beam_no ?? null,
    refSec,
    refCoating: ref?.avg_reading != null ? Number(ref.avg_reading) : null,
    bathTemp: extra.bathTemp ?? null,
    surface: extra.surface ?? null,
    models,
  };
}

// ── Accuracy maths ──────────────────────────────────────────────────────────

/** Accuracy % = 100 · (1 − |actual − predicted| / actual), clamped to 0…100. */
export function accuracyPct(actual: number | null, predicted: number | null): number | null {
  const a = Number(actual);
  const p = Number(predicted);
  if (!Number.isFinite(a) || !Number.isFinite(p) || a <= 0) return null;
  return +Math.max(0, Math.min(100, 100 * (1 - Math.abs(a - p) / a))).toFixed(2);
}

export function variation(actual: number | null, predicted: number | null): number | null {
  const a = Number(actual);
  const p = Number(predicted);
  if (!Number.isFinite(a) || !Number.isFinite(p)) return null;
  return +(a - p).toFixed(2);
}

export function signed(n: number | null | undefined, unit = ""): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return `${v > 0 ? "+" : ""}${v}${unit}`;
}

export type ValidationRow = {
  beamNo: string;
  dippedAt: string | null;
  productionDate: string;
  shift: string;
  operator: string;
  supervisor: string;
  model: AiModelId;
  modelLabel: string;
  tier: string;
  materialType: string;
  loadType: string;
  surfaceCondition: string;
  bathTemp: number | null;
  specificCoating: number | null;
  targetCoating: number | null;
  predictedSec: number | null;
  actualSec: number | null;
  timeVariation: number | null;
  expectedCoating: number | null;
  actualCoating: number | null;
  coatingVariation: number | null;
  confidencePct: number | null;
  timeAccuracy: number | null;
  coatingAccuracy: number | null;
  overallAccuracy: number | null;
  recommendation: string;
  includedInTraining: boolean;
};

/** Expand one beam into one validation row per model that predicted it. */
export function validationRowsForBeam(
  beam: any,
  ctx: {
    actualSec: number | null;
    actualCoating: number | null;
    productionDate: string;
    shift: string;
  },
): ValidationRow[] {
  const snap: AiPredictionSnapshot | null = beam?.ai_prediction ?? null;
  if (!snap || !Array.isArray(snap.models) || !snap.models.length) return [];
  return snap.models.map((m) => {
    const timeAcc = accuracyPct(ctx.actualSec, m.predictedSec);
    const coatAcc = accuracyPct(ctx.actualCoating, m.expectedCoating);
    const parts = [timeAcc, coatAcc].filter((v): v is number => v != null);
    return {
      beamNo: beam.beam_no,
      dippedAt: beam.dipped_at ?? null,
      productionDate: ctx.productionDate,
      shift: ctx.shift,
      operator: beam.dipping_operator || "—",
      supervisor: beam.shift_supervisor || "—",
      model: m.type,
      modelLabel: m.label || AI_MODEL_LABEL[m.type],
      tier: snap.tier,
      materialType: beam.material_type || "",
      loadType: beam.load_type || "",
      surfaceCondition: beam.surface_condition || "",
      bathTemp: beam.bath_temperature != null && beam.bath_temperature !== "" ? Number(beam.bath_temperature) : null,
      specificCoating: beam.coating_required != null ? Number(beam.coating_required) : null,
      targetCoating: m.targetCoating ?? null,
      predictedSec: m.predictedSec ?? null,
      actualSec: ctx.actualSec,
      timeVariation: variation(ctx.actualSec, m.predictedSec),
      expectedCoating: m.expectedCoating ?? null,
      actualCoating: ctx.actualCoating,
      coatingVariation: variation(ctx.actualCoating, m.expectedCoating),
      confidencePct: m.confidencePct ?? null,
      timeAccuracy: timeAcc,
      coatingAccuracy: coatAcc,
      overallAccuracy: parts.length ? +(parts.reduce((s, v) => s + v, 0) / parts.length).toFixed(2) : null,
      recommendation: m.sentence || "",
      includedInTraining: !!beam.ai_train_include,
    };
  });
}

export type AccuracyStat = {
  key: string;
  count: number;
  avgTimeVariation: number | null;
  avgCoatingVariation: number | null;
  avgTimeAccuracy: number | null;
  avgCoatingAccuracy: number | null;
  avgOverallAccuracy: number | null;
  highConfidence: number;
  lowConfidence: number;
};

const avg = (v: (number | null)[]): number | null => {
  const nums = v.filter((x): x is number => x != null && Number.isFinite(x));
  if (!nums.length) return null;
  return +(nums.reduce((s, x) => s + x, 0) / nums.length).toFixed(2);
};

/** Group validation rows by any key and roll up the accuracy statistics. */
export function rollup(rows: ValidationRow[], keyOf: (r: ValidationRow) => string): AccuracyStat[] {
  const map = new Map<string, ValidationRow[]>();
  for (const r of rows) {
    const k = keyOf(r) || "—";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return Array.from(map.entries())
    .map(([key, list]) => ({
      key,
      count: list.length,
      avgTimeVariation: avg(list.map((r) => r.timeVariation)),
      avgCoatingVariation: avg(list.map((r) => r.coatingVariation)),
      avgTimeAccuracy: avg(list.map((r) => r.timeAccuracy)),
      avgCoatingAccuracy: avg(list.map((r) => r.coatingAccuracy)),
      avgOverallAccuracy: avg(list.map((r) => r.overallAccuracy)),
      highConfidence: list.filter((r) => (r.confidencePct ?? 0) >= 45).length,
      lowConfidence: list.filter((r) => (r.confidencePct ?? 0) < 45).length,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Model with the highest average overall accuracy (ties broken by sample count). */
export function bestModel(stats: AccuracyStat[]): AccuracyStat | null {
  const scored = stats.filter((s) => s.avgOverallAccuracy != null);
  if (!scored.length) return null;
  return scored.slice().sort(
    (a, b) => (b.avgOverallAccuracy! - a.avgOverallAccuracy!) || (b.count - a.count),
  )[0];
}
