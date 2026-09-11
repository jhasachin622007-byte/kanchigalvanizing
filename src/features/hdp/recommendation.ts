// Pure recommendation logic for the Dipping module.
// Tolerance-based matching: each numeric field has a ± window around the
// current beam's value (instead of fixed bucket edges).

import {
  predict as mlrPredict,
  recommendationSentence,
  targetCoatingFor,
  mmss as mlrMMSS,
  type TrainedMlr,
  type MlrInput,
} from "./mlr";
import { lgbmPredict, type TrainedLgbm } from "./lgbm";
import { xgbPredict, type TrainedXgb } from "./xgb";
import { catboostPredict, type TrainedCatboost } from "./catboost";
import { zinccorePredict, type TrainedZinccore } from "./zinccore";
import { AI_MODEL_LABEL, normalizeAiSelection, type AiModelId } from "./ai-accuracy";



/** Closest-match tier widens numeric tolerances 2× — never 3×. */
export const CLOSEST_RELAX = 2;

export type Bucket = { lo: number; hi: number; label: string };

// Back-compat helper (still used by tests / debug UI).
export function bucket(val: number | null | undefined, min: number, step: number): Bucket | null {
  if (val == null || isNaN(val as number)) return null;
  const idx = Math.floor(((val as number) - min) / step);
  const lo = +(min + idx * step).toFixed(2);
  const hi = +(lo + step).toFixed(2);
  return { lo, hi, label: `${lo}–${hi}` };
}

export function parseThk(b: any): number | null {
  const s = b?.section || "";
  const m = String(s).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

// Extract beam length in mm (single beam: length_mm; double batch: average of
// dbl_parts_detail lengths).
export function parseLen(b: any): number | null {
  if (b == null) return null;
  if (b.length_mm != null && !isNaN(parseFloat(String(b.length_mm)))) {
    return parseFloat(String(b.length_mm));
  }
  const rows = Array.isArray(b.dbl_parts_detail) ? b.dbl_parts_detail : [];
  const lens = rows
    .map((r: any) => parseFloat(String(r?.length_mm)))
    .filter((n: number) => !isNaN(n) && n > 0);
  if (!lens.length) return null;
  return lens.reduce((s: number, n: number) => s + n, 0) / lens.length;
}

export type DC = {
  engineEnabled: boolean;
  // Tolerance windows
  weightTol?: number;   // MT, default 0.1
  tempTol?: number;     // °C, default 1
  lengthTol?: number;   // mm, default 500
  qtyTol?: number;      // pcs, default 5
  // Field toggles
  showThickness?: boolean;
  showWeight?: boolean;
  showTemperature?: boolean;
  showQty?: boolean;
  showLoadType?: boolean;
  showLength?: boolean;
  showMaterialType?: boolean;      // MS / HT — mandatory exact match (legacy config ignored)
  showSurfaceCondition?: boolean;  // Normal / Rusted / Heavy Rusted — mandatory exact match (legacy config ignored)
  // Back-compat (ignored by new logic; kept so admin form can read/write):
  weightMin?: number; weightStep?: number; weightMax?: number;
  tempMin?: number;   tempStep?: number;   tempMax?: number;
  qtyMin?: number;    qtyStep?: number;    qtyMax?: number;
  thicknessTolerance?: number;
  topN?: number;
  allowPostEdit?: boolean;
  // Regression fallback (per spec: last 10 days)
  regressionEnabled?: boolean;
  regressionDays?: number;
};

/** Legacy alias — a selection is now a list of model ids. */
export type AiSelection = AiModelId | "both";

export type MlrBlock = {
  hasModel: boolean;
  /** "mlr" | "lgbm" | "xgb" — which engine produced this block. */
  modelType?: AiModelId;
  /** Human label shown in AI Insights. */
  modelLabel?: string;
  predictedSec: number;
  predictedMMSS: string;
  expectedCoating: number;
  targetCoating: number;
  confidencePct: number;
  r2: number;
  coatingR2: number;
  n: number;
  trainedAt?: string | null;
  deltaSec: number;
  sentence: string;
  inputs: {
    loadType: any; material: any; thickness: number; spec: number; surface: any;
    bathTemp: number; weight?: number; length?: number;
  };
  coefficients?: number[];
  features?: string[];
  /** zinccore only — MC-dropout prediction interval (seconds). */
  intervalSec?: { low: number; high: number };
  /** zinccore only — leanest time that still clears the specification floor. */
  minZinc?: { sec: number; mmss: string; coating: number; savedUm: number };

  /** zinccore only — set when the output failed a plausibility check. */
  implausible?: string;
  /** zinccore only — amber cross-check flag with its reason. */
  reviewFlag?: string;
};


export type RecResult =
  | { disabled: true }
  | { needTemp: true }
  | { needSurface: true }
  | { none: true; tolerances: any }
  | {
      regression: true;
      recommendationType: "regression";
      mlr: MlrBlock;
      aiBlocks: MlrBlock[];
      aiSelection: AiModelId[];
      prediction: {
        immersion: number; reaction: number; withdrawal: number; total: number;
        expectedMicron: number; targetMicron: number; confidence: number; deltaSec: number;
      };
      required: number;
      target: number;
      tolerances: any;
      compatibilityPct: number;
      lowSample: boolean;
      firstBeam?: boolean;
    }

  | {
      best: any;
      top: any[];
      top3: any[];
      count: number;
      tolerances: any;
      exactMatch: true;
      recommendationType: "exact" | "closest";
      closestMatch?: boolean;
      relaxFactor?: number;
      required: number;
      compatibilityPct: number;
      mlr?: MlrBlock;
      aiBlocks?: MlrBlock[];
      aiSelection?: AiModelId[];
      /** Index within top3 used as the active reference (0–2). */
      refIndex?: number;
    };



function within(val: number | null, target: number | null, tol: number): boolean {
  if (val == null || target == null) return false;
  // 1e-9 epsilon avoids float-precision drift (e.g. |1.1 - 1.0| = 0.10000000000000009).
  return Math.abs(val - target) <= tol + 1e-9;
}

export function computeRecommendation(opts: {
  beam: any;
  beams: any[];
  bathTemp: string | number | null;
  dc: DC;
  /** MLR model trained from the Admin-uploaded historical CSV. */
  mlrModel?: TrainedMlr | null;
  mlrTrainedAt?: string | null;
  /** LightGBM model trained from the same CSV. */
  lgbmModel?: TrainedLgbm | null;
  lgbmTrainedAt?: string | null;
  /** XGBoost model trained from the same CSV. */
  xgbModel?: TrainedXgb | null;
  xgbTrainedAt?: string | null;
  /** CatBoost model trained from the same CSV. */
  catModel?: TrainedCatboost | null;
  catTrainedAt?: string | null;
  /** zinccore deep-learning model trained from the same CSV. */
  zcModel?: TrainedZinccore | null;
  zcTrainedAt?: string | null;
  /** Minimum confidence before zinccore raises a review flag (default 60). */
  zcMinConfidence?: number;
  /** Max % deviation from the other models before a review flag (default 20). */
  zcMaxDeviationPct?: number;
  /** Admin-selected active AI model(s) — id, legacy string, or list. */
  aiModel?: AiModelId | AiModelId[] | string | string[];
  /** Which of the top-3 historical matches is the active reference (0–2). */
  refIndex?: number;
}): RecResult | null {
  const {
    beam, beams, bathTemp, dc,
    mlrModel, mlrTrainedAt,
    lgbmModel, lgbmTrainedAt,
    xgbModel, xgbTrainedAt,
    catModel, catTrainedAt,
    zcModel, zcTrainedAt,
  } = opts;
  const aiSelection: AiModelId[] = normalizeAiSelection(opts.aiModel);


  if (!beam) return null;
  if (!dc.engineEnabled) return { disabled: true };
  const tempNum =
    bathTemp !== "" && bathTemp != null && !isNaN(parseFloat(String(bathTemp)))
      ? parseFloat(String(bathTemp))
      : null;
  if (tempNum == null) return { needTemp: true };

  // Resolve tolerances with safe defaults.
  const weightTol = Number(dc.weightTol ?? 0.1);
  const tempTol   = Number(dc.tempTol   ?? 1);
  const lengthTol = Number(dc.lengthTol ?? 500);
  const qtyTol    = Number(dc.qtyTol    ?? 5);

  // Field toggles (default ON for back-compat)
  const useWeight = dc.showWeight      !== false;
  const useTemp   = dc.showTemperature !== false;
  const useQty    = dc.showQty         !== false;
  const useLoad   = dc.showLoadType    !== false;
  const useThk    = dc.showThickness   !== false;
  const useLen    = dc.showLength      === true; // opt-in
  const useMat    = true; // mandatory exact match
  const useSurf   = true; // mandatory exact match

  // Surface Condition is captured at Dipping time — before it is set we can't
  // meaningfully filter history. Prompt the operator for it instead of hiding
  // every candidate behind a "No Matching Data" wall.
  if (useSurf && !beam.surface_condition) return { needSurface: true };

  const qty = (beam.part_nos || "").split(",").filter(Boolean).length || 1;
  const wt  = parseFloat(beam.total_weight) || 0;
  const thk = parseThk(beam);
  const len = parseLen(beam);

  const currentSurface = beam.surface_condition ?? null;

  const runFilter = (relax: number) => beams.filter((b) => {
    if (b.beam_no === beam.beam_no) return false;
    if (b.qc_status !== "PASS") return false;
    if (!b.immersion_duration || !b.reaction_duration || !b.withdrawal_duration) return false;
    if (b.bath_temperature == null) return false;
    if (useLoad && b.load_type !== beam.load_type) return false;
    if (b.coating_required !== beam.coating_required) return false;
    if (useMat && (!beam.material_type || b.material_type !== beam.material_type)) return false;
    if (useSurf) {
      const cSurf = b.surface_condition ?? (currentSurface === "Normal" ? "Normal" : null);
      if (cSurf !== currentSurface) return false;
    }
    if (useThk) {
      const cThk = parseThk(b);
      if (thk == null || cThk == null || cThk !== thk) return false;
    }
    if (useWeight) {
      const cWt = parseFloat(b.total_weight) || 0;
      if (!within(cWt, wt, weightTol * relax)) return false;
    }
    if (useTemp) {
      if (!within(Number(b.bath_temperature), tempNum, tempTol * relax)) return false;
    }
    if (useQty) {
      const cQty = (b.part_nos || "").split(",").filter(Boolean).length || 1;
      if (!within(cQty, qty, qtyTol * relax)) return false;
    }
    if (useLen && !["Plate","Cleat"].includes(beam.load_type) && !["Plate","Cleat"].includes(b.load_type)) {
      const cLen = parseLen(b);
      if (!within(cLen, len, lengthTol * relax)) return false;
    }
    return true;
  });

  const matches = runFilter(1);

  const tolerances = {
    thk, len, wt, tempNum, qty,
    weightTol, tempTol, lengthTol, qtyTol,
    mat: beam.material_type ?? null,
    surf: beam.surface_condition ?? null,
    useMat, useSurf,
  };

  const required = parseFloat(beam.coating_required) || 0;

  // ── AI blocks (shared by every tier) ──────────────────────────────────────
  const mlrInputs: MlrInput = {
    loadType: beam.load_type ?? null,
    material: beam.material_type ?? null,
    thickness: thk ?? 0,
    spec: required,
    surface: beam.surface_condition ?? null,
    bathTemp: tempNum,
    weight: wt,
    length: len ?? 0,
  };

  const emptyBlock = (
    type: AiModelId,
    label: string,
    refSec: number | null,
    refCoating: number | null,
  ): MlrBlock => ({
    hasModel: false,
    modelType: type,
    modelLabel: label,
    predictedSec: Math.max(0, Math.round(Number(refSec) || 0)),
    predictedMMSS: mlrMMSS(Number(refSec) || 0),
    expectedCoating: Number(refCoating) || 0,
    targetCoating: targetCoatingFor(required),
    confidencePct: 0,
    r2: 0, coatingR2: 0, n: 0,
    trainedAt: null,
    deltaSec: 0,
    sentence: `No trained ${label} model yet — upload historical data in Admin → AI Training to enable time predictions.`,
    inputs: mlrInputs,
  });

  const buildMlrBlock = (refSec: number | null, refCoating: number | null): MlrBlock => {
    if (!mlrModel) return emptyBlock("mlr", AI_MODEL_LABEL.mlr, refSec, refCoating);
    const p = mlrPredict(mlrModel, mlrInputs);
    const { sentence, deltaSec } = recommendationSentence({
      predictedSec: p.totalSec,
      targetCoating: p.targetCoating,
      referenceSec: refSec,
      referenceCoating: refCoating,
    });
    return {
      hasModel: true,
      modelType: "mlr",
      modelLabel: AI_MODEL_LABEL.mlr,
      predictedSec: p.totalSec,
      predictedMMSS: p.totalMMSS,
      expectedCoating: p.expectedCoating,
      targetCoating: p.targetCoating,
      confidencePct: p.confidencePct,
      r2: mlrModel.r2,
      coatingR2: mlrModel.coatingR2,
      n: mlrModel.n,
      trainedAt: mlrTrainedAt ?? null,
      deltaSec,
      sentence,
      inputs: mlrInputs,
      coefficients: mlrModel.beta,
      features: mlrModel.features,
    };
  };

  const buildLgbmBlock = (refSec: number | null, refCoating: number | null): MlrBlock => {
    if (!lgbmModel) return emptyBlock("lgbm", AI_MODEL_LABEL.lgbm, refSec, refCoating);
    const p = lgbmPredict(lgbmModel, mlrInputs);
    const { sentence, deltaSec } = recommendationSentence({
      predictedSec: p.totalSec,
      targetCoating: p.targetCoating,
      referenceSec: refSec,
      referenceCoating: refCoating,
    });
    return {
      hasModel: true,
      modelType: "lgbm",
      modelLabel: AI_MODEL_LABEL.lgbm,
      predictedSec: p.totalSec,
      predictedMMSS: p.totalMMSS,
      expectedCoating: p.expectedCoating,
      targetCoating: p.targetCoating,
      confidencePct: p.confidencePct,
      r2: lgbmModel.r2,
      coatingR2: lgbmModel.coatingR2,
      n: lgbmModel.n,
      trainedAt: lgbmTrainedAt ?? null,
      deltaSec,
      sentence,
      inputs: mlrInputs,
      features: lgbmModel.features,
    };
  };

  const buildXgbBlock = (refSec: number | null, refCoating: number | null): MlrBlock => {
    if (!xgbModel) return emptyBlock("xgb", AI_MODEL_LABEL.xgb, refSec, refCoating);
    const p = xgbPredict(xgbModel, mlrInputs);
    const { sentence, deltaSec } = recommendationSentence({
      predictedSec: p.totalSec,
      targetCoating: p.targetCoating,
      referenceSec: refSec,
      referenceCoating: refCoating,
    });
    return {
      hasModel: true,
      modelType: "xgb",
      modelLabel: AI_MODEL_LABEL.xgb,
      predictedSec: p.totalSec,
      predictedMMSS: p.totalMMSS,
      expectedCoating: p.expectedCoating,
      targetCoating: p.targetCoating,
      confidencePct: p.confidencePct,
      r2: xgbModel.r2,
      coatingR2: xgbModel.coatingR2,
      n: xgbModel.n,
      trainedAt: xgbTrainedAt ?? null,
      deltaSec,
      sentence,
      inputs: mlrInputs,
      features: xgbModel.features,
    };
  };

  const buildCatBlock = (refSec: number | null, refCoating: number | null): MlrBlock => {
    if (!catModel) return emptyBlock("cat", AI_MODEL_LABEL.cat, refSec, refCoating);
    const p = catboostPredict(catModel, mlrInputs);
    const { sentence, deltaSec } = recommendationSentence({
      predictedSec: p.totalSec,
      targetCoating: p.targetCoating,
      referenceSec: refSec,
      referenceCoating: refCoating,
    });
    return {
      hasModel: true,
      modelType: "cat",
      modelLabel: AI_MODEL_LABEL.cat,
      predictedSec: p.totalSec,
      predictedMMSS: p.totalMMSS,
      expectedCoating: p.expectedCoating,
      targetCoating: p.targetCoating,
      confidencePct: p.confidencePct,
      r2: catModel.r2,
      coatingR2: catModel.coatingR2,
      n: catModel.n,
      trainedAt: catTrainedAt ?? null,
      deltaSec,
      sentence,
      inputs: mlrInputs,
      features: catModel.features,
    };
  };

  const buildZcBlock = (refSec: number | null, refCoating: number | null): MlrBlock => {
    if (!zcModel) return emptyBlock("zc", AI_MODEL_LABEL.zc, refSec, refCoating);
    const p = zinccorePredict(zcModel, mlrInputs);
    const { sentence, deltaSec } = recommendationSentence({
      predictedSec: p.totalSec,
      targetCoating: p.targetCoating,
      referenceSec: refSec,
      referenceCoating: refCoating,
    });
    return {
      hasModel: true,
      modelType: "zc",
      modelLabel: AI_MODEL_LABEL.zc,
      predictedSec: p.totalSec,
      predictedMMSS: p.totalMMSS,
      expectedCoating: p.expectedCoating,
      targetCoating: p.targetCoating,
      confidencePct: p.confidencePct,
      r2: zcModel.r2,
      coatingR2: zcModel.coatingR2,
      n: zcModel.n,
      trainedAt: zcTrainedAt ?? null,
      deltaSec,
      sentence,
      inputs: mlrInputs,
      features: zcModel.features,
      intervalSec: { low: p.lowSec, high: p.highSec },
      minZinc: {
        sec: p.minZincSec,
        mmss: p.minZincMMSS,
        coating: p.minZincCoating,
        savedUm: p.zincSavedUm,
      },
      implausible: p.implausible,

    };
  };

  /** One block per Admin-selected engine; first entry is the primary. */
  const buildAiBlocks = (refSec: number | null, refCoating: number | null): MlrBlock[] => {
    const blocks = aiSelection.map((id) =>
      id === "lgbm" ? buildLgbmBlock(refSec, refCoating)
      : id === "xgb" ? buildXgbBlock(refSec, refCoating)
      : id === "cat" ? buildCatBlock(refSec, refCoating)
      : id === "zc" ? buildZcBlock(refSec, refCoating)
      : buildMlrBlock(refSec, refCoating),
    );

    // zinccore cross-check: low confidence, or a large gap against the median
    // of the other enabled engines, raises an amber review flag.
    const minConf = Number(opts.zcMinConfidence ?? 60);
    const maxDev = Number(opts.zcMaxDeviationPct ?? 20);
    const zc = blocks.find((b) => b.modelType === "zc");
    if (zc?.hasModel) {
      const others = blocks.filter((b) => b.modelType !== "zc" && b.hasModel).map((b) => b.predictedSec);
      const reasons: string[] = [];
      if (zc.confidencePct < minConf) reasons.push(`confidence ${zc.confidencePct}% is below the ${minConf}% threshold`);
      if (others.length) {
        const sorted = [...others].sort((a, b) => a - b);
        const mid = sorted.length % 2
          ? sorted[(sorted.length - 1) / 2]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        const devPct = mid > 0 ? Math.round((Math.abs(zc.predictedSec - mid) / mid) * 100) : 0;
        if (devPct > maxDev) reasons.push(`prediction differs ${devPct}% from the other models`);
      }
      if (zc.implausible) reasons.unshift(zc.implausible);
      if (reasons.length) zc.reviewFlag = `Review recommended — ${reasons.join("; ")}.`;
    }
    return blocks;
  };



  const buildMlrResult = (): RecResult => {
    const blocks = buildAiBlocks(null, null);
    const block = blocks[0];

    const total = block.predictedSec;
    // Split the predicted total into phases using the plant's standard cycle
    // proportions (immersion 72%, reaction 8%, withdrawal 20%).
    const immersion = Math.max(1, Math.round(total * 0.72));
    const reaction = Math.max(0, Math.round(total * 0.08));
    const withdrawal = Math.max(0, total - immersion - reaction);
    return {
      regression: true,
      recommendationType: "regression",
      mlr: block,
      aiBlocks: blocks,
      aiSelection,
      prediction: {

        immersion, reaction, withdrawal, total,
        expectedMicron: block.expectedCoating,
        targetMicron: block.targetCoating,
        confidence: block.confidencePct,
        deltaSec: 0,
      },
      required,
      target: block.targetCoating,
      tolerances,
      compatibilityPct: 0,
      lowSample: !block.hasModel || block.n < 12,
      firstBeam: true,
    } as RecResult;
  };

  const buildExactResult = (
    rows: any[],
    kind: "exact" | "closest",
    relaxFactor?: number,
  ): RecResult => {
    const scored = rows
      .map((m) => ({ m, diff: Math.abs((Number(m.avg_reading) || 0) - required) }))
      .sort(
        (a, b) =>
          a.diff - b.diff ||
          new Date(b.m.qc_completed_at || b.m.dipped_at || 0).getTime() -
            new Date(a.m.qc_completed_at || a.m.dipped_at || 0).getTime(),
      );
    // Which of the top-3 the operator has selected (1st / 2nd / 3rd View).
    const refIdx = Math.min(
      Math.max(0, Math.floor(Number(opts.refIndex) || 0)),
      Math.max(0, Math.min(2, scored.length - 1)),
    );
    // Compatibility % (spec §6.2): weighted similarity of the anchor to the
    // current beam. Exact tier is always ≥ threshold; closest tier may be lower.
    let compatibilityPct = kind === "exact" ? 100 : 80;
    try {
      const reg = require("./regression") as typeof import("./regression");
      if (scored[refIdx]) {
        const currentForSim = { ...beam, bath_temperature: tempNum };
        const sim = reg.similarityScore(currentForSim, scored[refIdx].m, {
          weightTol, tempTol, lengthTol, qtyTol,
        });
        compatibilityPct = Math.round(sim * 100);
      }
    } catch { /* fall through */ }
    const mkCard = (entry: { m: any; diff: number }, isBest: boolean) => ({
      beam_no: entry.m.beam_no,
      immersion_duration: Number(entry.m.immersion_duration) || 0,
      reaction_duration: Number(entry.m.reaction_duration) || 0,
      withdrawal_duration: Number(entry.m.withdrawal_duration) || 0,
      bath_temperature: Number(entry.m.bath_temperature) || 0,
      avg_reading: Number(entry.m.avg_reading) || 0,
      material_type: entry.m.material_type ?? null,
      surface_condition: entry.m.surface_condition ?? null,
      qc_completed_at: entry.m.qc_completed_at ?? entry.m.dipped_at ?? null,
      elcometer: Array.isArray(entry.m.elcometer) ? entry.m.elcometer : null,
      elcometer_v2: entry.m.elcometer_v2 ?? null,
      total_weight: entry.m.total_weight ?? null,
      section: entry.m.section ?? null,
      load_type: entry.m.load_type ?? null,
      _required: required,
      _diff: entry.diff,
      _isClosest: isBest,
    });
    const top3 = scored.slice(0, 3).map((s, i) => mkCard(s, i === refIdx));

    // The selected view becomes the active reference for AI blocks, variance
    // and the saved prediction snapshot.
    const best = top3[refIdx] || top3[0];
    const aiBlocksForRef = buildAiBlocks(
      best
        ? (best.immersion_duration || 0) + (best.reaction_duration || 0) + (best.withdrawal_duration || 0)
        : null,
      best ? best.avg_reading ?? null : null,
    );
    return {

      best,
      refIndex: refIdx,
      top: [best],
      top3,
      count: rows.length,
      tolerances,
      exactMatch: true,
      recommendationType: kind,
      closestMatch: kind === "closest" || undefined,
      relaxFactor,
      required,
      compatibilityPct,
      mlr: aiBlocksForRef[0],
      aiBlocks: aiBlocksForRef,
      aiSelection,
    } as RecResult;
  };



  if (matches.length) {
    return buildExactResult(matches, "exact");
  }

  // ── Tier 2: CLOSEST HISTORICAL MATCH — widen numeric tolerances 2× (never 3×).
  const relaxed = runFilter(CLOSEST_RELAX);
  if (relaxed.length) {
    return buildExactResult(relaxed, "closest", CLOSEST_RELAX);
  }

  // ── Tier 3: MULTIPLE LINEAR REGRESSION PREDICTION ──────────────────
  // Trained only from the Admin-uploaded historical CSV. Always returns a
  // recommendation — never "No Matching Data Available".
  return buildMlrResult();
}
