// @ts-nocheck
/* eslint-disable */
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { productionDayIdTz, productionHourIndex, bucketHour, bucketLabel, bucketIsNextDay, nextDateStr, inProductionRange, productionRangeLabel } from "./production-day";

import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from "recharts";
import * as XLSX from "xlsx";
import { computeRecommendation } from "./recommendation";
import { useMlrModel } from "./use-mlr-model";
import { parseTrainingCsv, fitMlr, MLR_FEATURES, TARGET_COATING, mmss as fmtMMSS } from "./mlr";
import { predictCoating as mlrPredictCoating } from "./mlr";
import { fitLgbm, lgbmPredictCoating } from "./lgbm";
import { fitXgb, xgbPredictCoating } from "./xgb";
import { fitCatboost, catboostPredictCoating } from "./catboost";
import { fitZinccore, fineTuneZinccore, zinccorePredictCoating, zinccorePredictTotalTime, zinccoreAttribution } from "./zinccore";
import {
  AI_MODEL_IDS, AI_MODEL_LABEL, AI_MODEL_SHORT, normalizeAiSelection,
  buildPredictionSnapshot, validationRowsForBeam, rollup as aiRollup, bestModel as aiBestModel, signed as aiSigned,
} from "./ai-accuracy";

import { SixSigmaDashboard } from "./SixSigmaDashboard";
import SecurityAdmin from "@/features/security/SecurityAdmin";
import { stageVariance, stageTimeline, timelineSummary, fmtSignedDur } from "./variance";
import { SyncHealthBadge } from "@/components/SyncHealthBadge";
import { DippingSyncBadge } from "./DippingSyncBadge";
import { useServerClock, serverNowISO as srvNowISO } from "@/lib/server-time";
import { clearDraft, saveDraft, useDraft } from "@/lib/use-draft";
import { pendingCountForTable, pendingOpsForTable } from "@/lib/pending-queue";
import { toast } from "sonner";
import { useShow65, setShow65, is65Enabled, filterCoatings, filterBeamsByFlag } from "./feature-flags";
import { MultiSelectFilter } from "@/components/MultiSelectFilter";
import { resolveBackdatedEntry, backdatedCycleSecs, type BackdateInput } from "./backdate";
import { checkThickness, sanitizeThicknessInput, maxThicknessOf, detectMaterialType, materialGradesOf } from "./loading-rules";
import { APP_TZ_LABEL, toTzInputValue, dateKeyTz, fmtDateTz, fmtDateTimeTz, fmtTimeTz, tzFields } from "@/lib/tz";

import {
  isV2 as isV2Coj, emptyV2Strings, stringsToV2, v2ToStrings,
  validateV2Strings, subAverages as v2SubAverages, totalAverage as v2TotalAverage,
  minMax as v2MinMax, flatReadings as v2FlatReadings, overCapPoint as v2OverCap,
  V2_GROUPS, V2_SIDES,
} from "@/lib/coj-readings";


// Live count of pending writes for a given table; updates on sync events.
function usePendingCount(table: string): number {
  const [n, setN] = useState<number>(() => {
    try { return pendingCountForTable(table); } catch { return 0; }
  });
  useEffect(() => {
    const refresh = () => {
      try { setN(pendingCountForTable(table)); } catch {}
    };
    const onStatus = () => refresh();
    window.addEventListener("hdp:sync-status", onStatus as any);
    window.addEventListener("online", refresh);
    const id = window.setInterval(refresh, 2000);
    return () => {
      window.removeEventListener("hdp:sync-status", onStatus as any);
      window.removeEventListener("online", refresh);
      window.clearInterval(id);
    };
  }, [table]);
  return n;
}

// ══════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════
const LOAD_TYPES = [
  "Amc","Cnc","Drilling","Plate","Cleat",
  "Hook","Proto","Double Dipp","Double Batch","Other",
];
const COATINGS_ALL = [65, 87, 130];
const COATINGS = COATINGS_ALL; // legacy alias — use is65Enabled()/filterCoatings at render sites
const STATUS_ORDER = ["LOADED","DIPPING","QC_PENDING","COMPLETED"];

// Load types whose beams have no Length dimension (hidden in UI, saved as null,
// excluded from length-based comparisons and reports).
const LENGTHLESS_TYPES = ["Plate","Cleat"] as const;
export function isLengthless(loadType?: string | null): boolean {
  return !!loadType && (LENGTHLESS_TYPES as readonly string[]).includes(loadType);
}

// Parse thickness in mm from a free-form section string ("6mm", "5 mm", "6.5").
// Returns null when no leading number is found (e.g. "L1", "M3").
export function parseThicknessMm(section?: string | null): number | null {
  if (!section) return null;
  const m = String(section).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

export type MicronRuleLike = {
  prefix: string;
  thickness_min: number;
  thickness_max: number | null;
  coating_required: number;
  local_coating_required?: number | null;
  active: boolean;
};

// Resolve the full active admin rule for a part number. Picks the longest
// matching prefix (case-insensitive) whose thickness range contains the mm.
export function resolveRuleForPart(
  partNo: string,
  thicknessMm: number | null,
  rules: MicronRuleLike[],
): MicronRuleLike | null {
  if (thicknessMm == null || isNaN(thicknessMm)) return null;
  const upper = String(partNo || "").toUpperCase();
  if (!upper) return null;
  const matches = (rules || [])
    .filter(r => r && r.active && upper.startsWith(String(r.prefix).toUpperCase()))
    .filter(r => thicknessMm >= Number(r.thickness_min)
                 && (r.thickness_max == null || thicknessMm <= Number(r.thickness_max)))
    .sort((a,b) => String(b.prefix).length - String(a.prefix).length);
  return matches.length ? matches[0] : null;
}

// Resolve micron from active admin rules.
export function resolveMicronFromRules(
  partNo: string,
  thicknessMm: number | null,
  rules: MicronRuleLike[],
): number | null {
  const r = resolveRuleForPart(partNo, thicknessMm, rules);
  return r ? Number(r.coating_required) : null;
}



// Mutable so Admin can edit coating ranges at runtime (persisted in App state).
let QC_RANGES = {
  65:  { min: 65,  ok_max: 80  },
  87:  { min: 87,  ok_max: 110 },
  130: { min: 130, ok_max: 155 },
};
export function setQcRangesGlobal(next){ QC_RANGES = { ...QC_RANGES, ...next }; }
export function getQcRangesGlobal(){ return QC_RANGES; }

// Friendly label for surface condition (stored as "Normal"/"Rusted"/"HeavyRusted").
export function fmtSurface(s: any): string {
  if (!s) return "—";
  if (s === "HeavyRusted" || s === "Heavy Rusted") return "Heavy Rusted";
  return String(s);
}

// ── Coating on Job — job parameters & zinc-excess maths ─────────────────────
// The coating band (65-75 / 87-95 / 130-140) is an ACCEPTANCE REQUIREMENT, not
// a target. Our aim is the minimum coating that still clears the band floor,
// so every CoJ record reports how much zinc was laid down above that floor.
export const COJ_BANDS: Record<number, { min: number; max: number }> = {
  65:  { min: 65,  max: 75  },
  87:  { min: 87,  max: 95  },
  130: { min: 130, max: 140 },
};

export function cojBand(required: any): { min: number; max: number } | null {
  const n = Number(required);
  if (!Number.isFinite(n) || n <= 0) return null;
  return COJ_BANDS[n] ?? { min: n, max: n + 10 };
}

/** Excess coating (µm) and excess zinc (%) over the requirement floor. */
export function zincExcess(required: any, avg: any): { min: number; excessUm: number; excessPct: number } | null {
  const band = cojBand(required);
  const a = Number(avg);
  if (!band || !Number.isFinite(a) || a <= 0) return null;
  const excessUm = +(a - band.min).toFixed(2);
  return { min: band.min, excessUm, excessPct: +((excessUm / band.min) * 100).toFixed(2) };
}

/** Job parameters shown on every Coating on Job record. */
export function cojJobParams(b: any) {
  const totalSec =
    (Number(b?.immersion_duration) || 0) +
    (Number(b?.reaction_duration) || 0) +
    (Number(b?.withdrawal_duration) || 0);
  const w = parseFloat(String(b?.total_weight));
  const t = parseThicknessMm(b?.section);
  const lRaw = b?.length_mm != null ? parseFloat(String(b.length_mm)) : NaN;
  const temp = b?.bath_temperature != null && b?.bath_temperature !== "" ? Number(b.bath_temperature) : NaN;
  return {
    weightMT: Number.isFinite(w) ? w : null,
    thicknessMm: t,
    lengthMm: Number.isFinite(lRaw) && lRaw > 0 ? lRaw : null,
    loadType: b?.load_type || null,
    surface: b?.surface_condition || null,
    bathTemp: Number.isFinite(temp) ? temp : null,
    totalSec: totalSec > 0 ? totalSec : null,
  };
}



// ── Best Match benchmark helpers (Coating on Job) ─────────────
// Finds the closest historical PASS beam using the same tolerance-based
// criteria as the Dipping AI: mandatory match on coating spec and thickness,
// tolerance windows for weight/length/qty/temperature, optional load type.
// Similarity = average of per-criterion closeness scores × 100.
// Snapshot is persisted on the beam row so historical comparisons remain
// locked to the criteria/tolerances in effect at save time.
function _parseThk(b) {
  const m = String(b?.section || "").match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}
function _parseLen(b) {
  if (b == null) return null;
  if (b.length_mm != null && !isNaN(parseFloat(String(b.length_mm)))) return parseFloat(String(b.length_mm));
  const rows = Array.isArray(b.dbl_parts_detail) ? b.dbl_parts_detail : [];
  const lens = rows.map((r) => parseFloat(String(r?.length_mm))).filter((n) => !isNaN(n) && n > 0);
  if (!lens.length) return null;
  return lens.reduce((s, n) => s + n, 0) / lens.length;
}
function _qty(b) { return (b?.part_nos || "").split(",").filter(Boolean).length || 1; }

// ── CoJ History → Model Prediction ──────────────────────────────────────────
// For a completed beam's ACTUAL total dipping time, ask every enabled+trained
// model what coating it would expect, and compare with the measured CoJ average.
function cojActualSec(b) {
  return cycleSecs(b);
}
function cojActualAverage(b) {
  const direct = b?.avg_reading != null && b.avg_reading !== "" ? Number(b.avg_reading) : NaN;
  if (Number.isFinite(direct) && direct > 0) return direct;
  return isV2Coj(b) ? v2TotalAverage(b.elcometer_v2) : null;
}
function cojModelComparison(b, mlrStore, aiModels) {
  const actualSec = cojActualSec(b);
  const actual = cojActualAverage(b);
  if (!actualSec || !Number.isFinite(actual) || actual <= 0) return [];
  const input = {
    loadType: b.load_type ?? null,
    material: b.material_type ?? null,
    thickness: _parseThk(b) ?? 0,
    spec: Number(b.coating_required) || 0,
    surface: b.surface_condition ?? null,
    bathTemp: Number(b.bath_temperature) || 0,
    weight: parseFloat(b.total_weight) || 0,
    length: _parseLen(b) ?? 0,
  };
  const selected = normalizeAiSelection(aiModels);
  const out = [];
  for (const id of selected) {
    let expected = null;
    try {
      if (id === "mlr" && mlrStore?.stored?.model) expected = mlrPredictCoating(mlrStore.stored.model, input, actualSec);
      else if (id === "lgbm" && mlrStore?.lgbm?.model) expected = lgbmPredictCoating(mlrStore.lgbm.model, input, actualSec);
      else if (id === "xgb" && mlrStore?.xgb?.model) expected = xgbPredictCoating(mlrStore.xgb.model, input, actualSec);
      else if (id === "cat" && mlrStore?.cat?.model) expected = catboostPredictCoating(mlrStore.cat.model, input, actualSec);
      else if (id === "zc" && mlrStore?.zc?.model) expected = zinccorePredictCoating(mlrStore.zc.model, input, actualSec);
    } catch { expected = null; }
    if (expected == null || !Number.isFinite(expected)) continue;
    const diff = +(actual - expected).toFixed(2);
    out.push({
      id,
      label: AI_MODEL_LABEL[id],
      actualSec,
      expected: +Number(expected).toFixed(2),
      actual: +actual.toFixed(2),
      diff,
      accuracy: +Math.max(0, Math.min(100, 100 * (1 - Math.abs(diff) / actual))).toFixed(2),
    });
  }
  return out;
}


// Default CoJ Best Match criteria — used when admin hasn't configured anything.
export const COJ_BM_DEFAULTS = {
  enabled: true,
  criteria: {
    specificMicron:   { enabled: true },                // mandatory exact match (no tol)
    loadType:         { enabled: true },                // exact string equality
    thickness:        { enabled: true,  tol: 0 },       // ± mm (0 = exact)
    weight:           { enabled: true,  tol: 0.1 },     // ± MT
    length:           { enabled: false, tol: 500 },     // ± mm
    temperature:      { enabled: true,  tol: 1 },       // ± °C
    quantity:         { enabled: false, tol: 5 },       // ± pcs
    materialType:     { enabled: true },                // MS / HT mandatory exact match
    surfaceCondition: { enabled: true },                // Normal / Rusted / Heavy Rusted mandatory exact match
  },
};

// Unified renderer for the "Criteria Used" string — shared across CoJ card,
// exports, registers, and variance analysis. Given `c = benchmark.criteria_used`.
export function formatCriteriaUsed(c: any): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.specificMicron) parts.push("Specific μm");
  if (c.loadType) parts.push("Load Type");
  if (c.thickness) parts.push(`Thickness ±${c.thkTol ?? 0}`);
  if (c.weight) parts.push(`Weight ±${c.wtTol ?? 0}`);
  if (c.length) parts.push(`Length ±${c.lenTol ?? 0}`);
  if (c.temperature) parts.push(`Temp ±${c.tmpTol ?? 0}`);
  if (c.quantity) parts.push(`Quantity ±${c.qtyTol ?? 0}`);
  if (c.materialType) parts.push("Material Type (MS/HT)");
  if (c.surfaceCondition) parts.push("Surface Condition (Normal/Rusted/Heavy Rusted)");
  return parts.join(" · ");
}

export function computeBenchmark(current, allBeams, cfg) {
  if (cfg && cfg.enabled === false) return null;

  const curAvg = Number(current?.avg_reading);
  const spec   = Number(current?.coating_required);
  if (!curAvg || isNaN(curAvg) || !spec) return null;
  const curTxn = current.transaction_id || current.beam_no;

  const crit = (cfg && cfg.criteria) || COJ_BM_DEFAULTS.criteria;
  const useSpec = crit.specificMicron?.enabled !== false; // default mandatory
  const useLoad = !!crit.loadType?.enabled;
  const useThk  = !!crit.thickness?.enabled;
  const useWt   = !!crit.weight?.enabled;
  const useLen  = !!crit.length?.enabled;
  const useTmp  = !!crit.temperature?.enabled;
  const useMat  = true; // mandatory exact match
  const useSurf = true; // mandatory exact match
  const useQty  = !!crit.quantity?.enabled;
  const thkTol  = Number(crit.thickness?.tol   ?? 0);
  const wtTol   = Number(crit.weight?.tol      ?? 0.1);
  const lenTol  = Number(crit.length?.tol      ?? 500);
  const tmpTol  = Number(crit.temperature?.tol ?? 1);
  const qtyTol  = Number(crit.quantity?.tol    ?? 5);

  const curThk = _parseThk(current);
  const curLen = _parseLen(current);
  const curWt  = parseFloat(current.total_weight) || 0;
  const curTmp = current.bath_temperature != null && !isNaN(Number(current.bath_temperature))
    ? Number(current.bath_temperature) : null;
  const curQty = _qty(current);

  const eps = 1e-9;
  const within = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol + eps;

  // Base pool: completed PASS beams, exclude self.
  const base = (allBeams || []).filter(b => {
    if ((b.transaction_id || b.beam_no) === curTxn) return false;
    if (b.qc_status !== "PASS") return false;
    const v = Number(b.avg_reading);
    return !isNaN(v) && v > 0;
  });

  // Strict all-pass filtering.
  const survivors = base.filter(b => {
    if (useSpec && Number(b.coating_required) !== spec) return false;
    if (useLoad && b.load_type !== current.load_type) return false;
    if (useMat  && (!current.material_type     || b.material_type     !== current.material_type))     return false;
    if (useSurf && (!current.surface_condition || b.surface_condition !== current.surface_condition)) return false;
    if (useThk) {
      const t = _parseThk(b);
      if (!within(curThk, t, thkTol)) return false;
    }
    if (useWt) {
      const w = parseFloat(b.total_weight) || 0;
      if (!within(curWt, w, wtTol)) return false;
    }
    if (useLen && !isLengthless(current.load_type) && !isLengthless(b.load_type)) {
      // Lengthless beams (Plate/Cleat) have no length — skip the length criterion.
      const l = _parseLen(b);
      if (curLen == null || l == null) return false;
      if (!within(curLen, l, lenTol)) return false;
    }
    if (useTmp) {
      if (curTmp == null || b.bath_temperature == null) return false;
      if (!within(curTmp, Number(b.bath_temperature), tmpTol)) return false;
    }
    if (useQty) {
      if (!within(curQty, _qty(b), qtyTol)) return false;
    }
    return true;
  });

  const criteria_used = {
    specificMicron: useSpec, loadType: useLoad,
    thickness: useThk, weight: useWt, length: useLen, temperature: useTmp,
    quantity: useQty, materialType: useMat, surfaceCondition: useSurf,
    thkTol, wtTol, lenTol, tmpTol, qtyTol,
  };

  if (!survivors.length) {
    return {
      ref_beam_no: null, ref_beam_id: null, ref_avg: null,
      ref_material_type: null, ref_surface_condition: null,
      ref_coating_required: spec, current_avg: curAvg,
      difference: null, status: "Match Not Available",
      criteria_used, compared_at: new Date().toISOString(),
    };
  }

  // Pick closest to its own specific-micron value; tie-break by recency.
  survivors.sort((a, z) => {
    const ad = Math.abs(Number(a.avg_reading) - Number(a.coating_required));
    const zd = Math.abs(Number(z.avg_reading) - Number(z.coating_required));
    if (ad !== zd) return ad - zd;
    return new Date(z.qc_completed_at || 0).getTime() - new Date(a.qc_completed_at || 0).getTime();
  });

  const ref = survivors[0];
  const refAvg = Number(ref.avg_reading);
  const diff = +(curAvg - refAvg).toFixed(2);
  let status;
  if (Math.abs(diff) < 0.5) status = "Equivalent Coating";
  else if (diff > 0)        status = `Higher Coating Achieved (+${diff} μm)`;
  else                      status = `Lower Coating (${diff} μm)`;

  return {
    ref_beam_no: ref.beam_no,
    ref_beam_id: ref.transaction_id || ref.beam_no,
    ref_avg: refAvg,
    ref_material_type: ref.material_type ?? null,
    ref_surface_condition: ref.surface_condition ?? null,
    ref_sub_avgs: isV2Coj(ref) ? v2SubAverages(ref.elcometer_v2) : null,
    ref_coating_required: spec,
    current_avg: curAvg,
    difference: diff,
    status,
    criteria_used,
    compared_at: new Date().toISOString(),
  };
}

// Build a CoJ Best Match cfg from the admin-managed fieldConfig.cojBestMatch.
export function buildBenchmarkCfg(_dippingConfig, fieldConfig) {
  const fc = fieldConfig || {};
  const stored = fc.cojBestMatch;
  if (stored && typeof stored === "object") {
    return {
      enabled: stored.enabled !== false,
      criteria: { ...COJ_BM_DEFAULTS.criteria, ...(stored.criteria || {}) },
    };
  }
  // Back-compat: honor old master toggle if cojBestMatch hasn't been seeded yet.
  return {
    enabled: fc.qcBestMatchEnabled !== false,
    criteria: COJ_BM_DEFAULTS.criteria,
  };
}

export function benchmarkStatusColor(status) {
  if (!status) return "#8DA0AD";
  if (status === "Match Not Available") return "#3D7EA6";
  if (status === "Equivalent Coating" || status === "Excellent") return "#4ADE80";
  if (status.startsWith("Higher Coating")) return "#3D7EA6";
  if (status.startsWith("Lower Coating"))  return "#4ADE80";
  if (status === "Very Close to Best Coating Result") return "#A78BFA";
  if (status === "Close") return "#FBBF24";
  if (status === "Needs Review") return "#F87171";
  return "#8DA0AD";
}



// ── Auto-shift from current time ──────────────────────────────
function autoShift(iso) {
  const h = tzFields(iso || new Date().toISOString()).hour;
  if (h >= 6  && h < 14) return "Day (06:00–14:00)";
  if (h >= 14 && h < 22) return "Afternoon (14:00–22:00)";
  return "Night (22:00–06:00)";
}

// ══════════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════════
const nowISO  = () => new Date().toISOString();
const dateKey = (iso) => dateKeyTz(iso);

// Build a unique Transaction ID for a loading cycle.
// Format: `${BEAM}-${H:MM}/${DD}` — e.g. "05-6:35/30".
// `existing` is the current beams array, used to add a "-2", "-3"… suffix
// on the extremely rare event of two loads landing in the same minute on
// the same beam number.
function makeTxnId(beamNo, iso, existing) {
  const p = tzFields(iso || nowISO());
  const h = p.hour;                 // 0-23 plant time, no leading zero
  const mm = String(p.minute).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  const base = `${beamNo}-${h}:${mm}/${dd}`;
  let id = base, n = 2;
  const used = new Set((existing || []).map((b) => b.transaction_id).filter(Boolean));
  while (used.has(id)) { id = `${base}-${n++}`; }
  return id;
}
// Legacy beams (loaded before the transaction_id rollout) may not have one
// stored yet — fall back to beam_no so existing UI never breaks.
const txn = (b) => (b && (b.transaction_id || b.beam_no)) || "";
// Operational enable/disable state. `is_enabled` is the column; the legacy
// jsonb `disabled` flag is honoured for older records. Disabled beams stay
// fully visible everywhere — they simply cannot advance to the next process.
const beamEnabled = (b: any) => !(b?.is_enabled === false || b?.disabled === true);



function fmt12(iso) { return fmtTimeTz(iso); }
function fmtDate(iso) { return fmtDateTz(iso); }
function fmtDT(iso) { return fmtDateTimeTz(iso); }
function fmtDur(secs) {
  if (secs == null || secs < 0) return "—";
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60), s = secs%60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}
function calcSecs(a,b) {
  if (!a||!b) return null;
  const d = Math.floor((new Date(b)-new Date(a))/1000);
  return d >= 0 ? d : null;
}
// Total cycle time per beam: Immersion Start → Withdrawal End (the full
// process). Falls back to the sum of per-phase durations when withdrawal
// timestamp is missing (legacy / manual records).
function cycleSecs(b) {
  if (!b) return null;
  const c = calcSecs(b.immersion_start, b.withdrawal_end);
  if (c != null) return c;
  const sum = (Number(b.immersion_duration)||0)
            + (Number(b.reaction_duration)||0)
            + (Number(b.withdrawal_duration)||0);
  return sum > 0 ? sum : null;
}
// Shared production-day helpers used by both the Reports and Coating on Job
// views. Keep all date/shift calculations in plant time, including records
// inspected from the QC table.
function drProdDay(b) {
  const ts = b?.immersion_start || b?.dipping_at || b?.dipped_at || b?.loaded_at;
  return ts ? productionDayIdTz(ts) : "";
}
function drShift(b) {
  const ts = b?.immersion_start || b?.dipping_at || b?.dipped_at || b?.loaded_at;
  if (!ts) return "—";
  const h = tzFields(ts).hour;
  if (h >= 6 && h < 14) return "A";
  if (h >= 14 && h < 22) return "B";
  return "C";
}
function avg7(readings) {
  const nums = readings.map(Number).filter(n => !isNaN(n) && n > 0);
  return nums.length === 7 ? (nums.reduce((a,b)=>a+b,0)/7) : null;
}
function getAutoRemark(coating, avgVal) {
  if (!avgVal || !coating) return null;
  const r = QC_RANGES[coating];
  if (!r) return null;
  if (avgVal < r.min)    return { text:"Below Minimum", status:"FAIL", color:"#F87171" };
  if (avgVal <= r.ok_max) return { text:"OK",           status:"PASS", color:"#4ADE80" };
  return                         { text:"High Coating",  status:"PASS", color:"#FBBF24" };
}
function buildAudit(userId,userName,action,module,details) {
  return { id:Date.now()+Math.random(), userId, userName, action, module, details, ts:nowISO() };
}

// ══════════════════════════════════════════════════════════════
// SEED DATA
// ══════════════════════════════════════════════════════════════
// Legacy seed array kept empty — real users are managed via Supabase auth (admin panel).
const INIT_USERS = [];

const INIT_BEAMS = [];
const INIT_AUDIT = [];

// ══════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ══════════════════════════════════════════════════════════════
const THEME_PRESETS = {
  "industrial":  { dark:true,  bg:"#111827", surf:"#1F2937", card:"#1F2937", border:"#374151", text:"#E5E7EB", muted:"#9CA3AF", dim:"#6B7280", amber:"#F97316", amberD:"#C2410C" },
  "dark-gold":   { dark:true,  bg:"#0F1720", surf:"#1E2A36", card:"#24313E", border:"#33434F", text:"#C9D6DF", muted:"#8DA0AD", dim:"#5C7482", amber:"#3D7EA6", amberD:"#2E6285" },
  "light":       { dark:false, bg:"#EFF2F7", surf:"#FFFFFF", card:"#FAFBFC", border:"#D8E2F0", text:"#0F1E38", muted:"#6B7EA8", dim:"#9AAACF", amber:"#3D7EA6", amberD:"#2E6285" },
  "ocean-blue":  { dark:true,  bg:"#061018", surf:"#0B1A2A", card:"#102538", border:"#1B3A56", text:"#DCEBFB", muted:"#6691B5", dim:"#2D4E70", amber:"#22D3EE", amberD:"#0891B2" },
  "slate":       { dark:true,  bg:"#0C0F14", surf:"#161A22", card:"#1C212C", border:"#2A303D", text:"#E2E8F0", muted:"#8B95A8", dim:"#4A5468", amber:"#94A3B8", amberD:"#64748B" },
};
function useTheme(themeId) {
  const p = THEME_PRESETS[themeId] || THEME_PRESETS["dark-gold"];
  return {
    ...p,
    blueT:"#5BA3FF", blue:"#1D6FE8",
    greenT:"#4ADE80", green:"#16A34A",
    redT:"#F87171", red:"#DC2626",
    yellowT:"#FDE047", yellow:"#CA8A04",
    purpleT:"#A78BFA", cyanT:"#22D3EE",
  };
}

const ST = {
  LOADED:    {bg:"#0E1E3A",color:"#5BA3FF",label:"● LOADED"},
  DIPPING:   {bg:"#2A1600",color:"#FB923C",label:"◈ DIPPING"},
  QC_PENDING:{bg:"#2A2600",color:"#FDE047",label:"◉ COATING PENDING"},
  COMPLETED: {bg:"#0A2218",color:"#4ADE80",label:"✔ COMPLETED"},
};

// ══════════════════════════════════════════════════════════════
// PRIMITIVES
// ══════════════════════════════════════════════════════════════
function DInput({style:s={},dark,...p}){
  const [f,sf]=useState(false);
  return <input onFocus={()=>sf(true)} onBlur={()=>sf(false)} style={{
    width:"100%",padding:"8px 11px",borderRadius:6,fontSize:13,fontFamily:"inherit",
    background:dark?"#090F1A":"#F4F7FC",
    border:`1px solid ${f?"#3D7EA6":dark?"#33434F":"#D8E2F0"}`,
    color:dark?"#C9D6DF":"#0F1E38",outline:"none",boxSizing:"border-box",
    transition:"border-color .15s",...s}}  {...p}/>;
}
function DSel({children,style:s={},dark,...p}){
  return <select style={{
    width:"100%",padding:"8px 11px",borderRadius:6,fontSize:13,cursor:"pointer",
    fontFamily:"inherit",background:dark?"#090F1A":"#F4F7FC",
    border:`1px solid ${dark?"#33434F":"#D8E2F0"}`,
    color:dark?"#C9D6DF":"#0F1E38",outline:"none",boxSizing:"border-box",...s}} {...p}>{children}</select>;
}
function DTa({style:s={},dark,...p}){
  return <textarea style={{
    width:"100%",padding:"8px 11px",borderRadius:6,fontSize:13,fontFamily:"inherit",
    background:dark?"#090F1A":"#F4F7FC",
    border:`1px solid ${dark?"#33434F":"#D8E2F0"}`,
    color:dark?"#C9D6DF":"#0F1E38",outline:"none",boxSizing:"border-box",
    resize:"vertical",minHeight:56,...s}} {...p}/>;
}
function Btn({variant="amber",size="md",style:s={},children,...p}){
  const [hov,sh]=useState(false);
  const V={
    amber:{bg:"#3D7EA6",bh:"#2E6285",c:"#000",fw:700},
    blue:{bg:"#1D6FE8",bh:"#155BBC",c:"#fff",fw:600},
    green:{bg:"#16A34A",bh:"#116637",c:"#fff",fw:600},
    red:{bg:"#DC2626",bh:"#AA1D1D",c:"#fff",fw:600},
    ghost:{bg:"transparent",bh:"#33434F",c:"#8DA0AD",fw:500,border:"1px solid #33434F"},
    purple:{bg:"#7C3AED",bh:"#6028C5",c:"#fff",fw:600},
    cyan:{bg:"#0891B2",bh:"#067090",c:"#fff",fw:600},
  };
  const v=V[variant]||V.amber;
  const sz=size==="sm"?{padding:"4px 10px",fontSize:11}:{padding:"8px 16px",fontSize:13};
  return <button onMouseEnter={()=>sh(true)} onMouseLeave={()=>sh(false)}
    style={{background:hov?v.bh:v.bg,color:v.c,border:v.border||"none",borderRadius:6,
    cursor:"pointer",fontWeight:v.fw,fontFamily:"inherit",transition:"background .15s",...sz,...s}} {...p}>{children}</button>;
}
function Field({label,required,children,style:s={},T}){
  return <div style={{display:"flex",flexDirection:"column",...s}}>
    <label style={{fontSize:10,color:T?.muted||"#8DA0AD",fontWeight:700,marginBottom:5,textTransform:"uppercase",letterSpacing:".06em"}}>
      {label}{required&&<span style={{color:"#3D7EA6",marginLeft:3}}>*</span>}
    </label>
    {children}
  </div>;
}
function StatusBadge({status}){
  const s=ST[status]||ST.LOADED;
  return <span style={{display:"inline-block",padding:"3px 9px",borderRadius:4,fontSize:10,fontWeight:700,letterSpacing:".05em",background:s.bg,color:s.color}}>{s.label}</span>;
}
function QCBadge({remark}){
  if(!remark) return <span style={{color:"#5C7482"}}>—</span>;
  const m={"OK":["#0A2218","#4ADE80"],"High Coating":["#2A1E00","#FBBF24"],"Below Minimum":["#2A0A0A","#F87171"]};
  const [bg,color]=m[remark]||["#33434F","#C9D6DF"];
  return <span style={{display:"inline-block",padding:"3px 9px",borderRadius:4,fontSize:10,fontWeight:700,background:bg,color}}>{remark}</span>;
}
function Alert({ok,msg,onClose}){
  if(!msg) return null;
  return <div style={{padding:"10px 14px",borderRadius:6,fontSize:13,display:"flex",alignItems:"center",gap:10,
    background:ok?"#081A10":"#220808",color:ok?"#4ADE80":"#F87171",
    border:`1px solid ${ok?"#143820":"#441010"}`,marginBottom:12}}>
    <span style={{flex:1}}>{msg}</span>
    {onClose&&<span onClick={onClose} style={{cursor:"pointer",opacity:.6}}>✕</span>}
  </div>;
}
function Card({children,style:s={},T}){
  return <div style={{background:T?.card,border:`1px solid ${T?.border}`,borderRadius:10,...s}}>{children}</div>;
}
function SecHead({title,sub,right,T}){
  return <div style={{padding:"13px 18px",borderBottom:`1px solid ${T?.border||"#33434F"}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
    <div>
      <div style={{fontSize:13,fontWeight:700,color:T?.text||"#C9D6DF"}}>{title}</div>
      {sub&&<div style={{fontSize:11,color:T?.muted||"#8DA0AD",marginTop:2}}>{sub}</div>}
    </div>
    {right}
  </div>;
}
function StatCard({label,value,sub,accent="#3D7EA6",T}){
  return <div style={{background:T?.card,border:`1px solid ${T?.border}`,borderLeft:`3px solid ${accent}`,borderRadius:8,padding:"14px 16px"}}>
    <div style={{fontSize:10,color:T?.muted,fontWeight:700,letterSpacing:".08em",textTransform:"uppercase",marginBottom:8}}>{label}</div>
    <div style={{fontSize:24,fontWeight:800,color:T?.text,fontFamily:"monospace",lineHeight:1}}>{value}</div>
    {sub&&<div style={{fontSize:11,color:T?.muted,marginTop:4}}>{sub}</div>}
  </div>;
}
function Table({headers,rows,empty="No records",T}){
  const th={padding:"9px 12px",textAlign:"left",background:T?.surf,color:T?.muted,fontWeight:700,
    letterSpacing:".06em",textTransform:"uppercase",fontSize:10,
    borderBottom:`1px solid ${T?.border}`,whiteSpace:"nowrap"};
  const td={padding:"9px 12px",borderBottom:`1px solid ${T?.border}`,color:T?.text,whiteSpace:"nowrap",fontSize:12};
  return <div style={{overflowX:"auto"}}>
    <table style={{width:"100%",borderCollapse:"collapse"}}>
      <thead><tr>{headers.map((h,i)=><th key={i} style={th}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.length===0
          ?<tr><td colSpan={headers.length} style={{...td,textAlign:"center",padding:28,color:T?.dim}}>{empty}</td></tr>
          :rows.map((row,i)=>(
            <tr key={i} onMouseEnter={e=>e.currentTarget.style.background=T?.surf}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"} style={{transition:"background .1s"}}>
              {row.map((c,j)=><td key={j} style={td}>{c}</td>)}
            </tr>
          ))}
      </tbody>
    </table>
  </div>;
}
const bn=(v)=><strong style={{fontFamily:"monospace",color:"#3D7EA6",letterSpacing:".04em"}}>{v}</strong>;
const mn=(v,c="#C9D6DF")=><span style={{fontFamily:"monospace",color:c}}>{v??'—'}</span>;
const TIP={contentStyle:{background:"#1E2A36",border:"1px solid #33434F",color:"#C9D6DF",fontSize:12,borderRadius:6},labelStyle:{color:"#3D7EA6"}};

// ══════════════════════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════════════════════
function LoginScreen({users,onLogin}){
  const [u,su]=useState(""); const [p,sp]=useState(""); const [err,se]=useState("");
  const [showQL,sQL]=useState(false); const [qlClicks,sqc]=useState(0);

  function go(){
    const f=users.find(x=>x.username===u.trim()&&x.password===p&&x.active);
    if(!f){se("Invalid credentials");return;} onLogin(f);
  }

  // Secret: clicking version text 5 times reveals quick login for admin
  function handleVersionClick(){
    const n=qlClicks+1; sqc(n);
    if(n>=5){sQL(true);sqc(0);}
  }

  const RI={admin:{icon:"⚙",label:"Admin",c:"#3D7EA6"},supervisor:{icon:"👷",label:"Supervisor",c:"#22D3EE"},shift_supervisor:{icon:"🧭",label:"Shift Supv",c:"#34D399"},manager:{icon:"📈",label:"Manager",c:"#F472B6"},loading_supervisor:{icon:"📦",label:"Loading",c:"#5BA3FF"},dipping_supervisor:{icon:"🛢",label:"Dipping",c:"#FB923C"},qc_inspector:{icon:"🔬",label:"Coating on Job",c:"#A78BFA"}};

  return <div style={{minHeight:"100vh",background:"#0F1720",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Figtree,system-ui,sans-serif"}}>
    <div style={{width:420}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <div style={{width:64,height:64,borderRadius:16,background:"linear-gradient(135deg,#3D7EA6,#2E6285)",
          display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px",fontSize:30,
          boxShadow:"0 0 32px rgba(61,126,166,.5)"}}>⚙</div>
        <div style={{fontSize:20,fontWeight:800,color:"#C9D6DF",letterSpacing:".1em"}}>HDP GALVANIZING</div>
        <div onClick={handleVersionClick} style={{fontSize:10,color:"#5C7482",marginTop:4,letterSpacing:".15em",cursor:"default",userSelect:"none"}}>
          PRODUCTION AUTOMATION SYSTEM  v3.0
        </div>
      </div>

      <div style={{background:"#1E2A36",border:"1px solid #33434F",borderRadius:12,padding:"28px 28px 22px"}}>
        <div style={{marginBottom:14}}>
          <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:6}}>USERNAME</label>
          <DInput dark value={u} onChange={e=>{su(e.target.value);se("");}} placeholder="Enter your username" autoComplete="username"/>
        </div>
        <div style={{marginBottom:6}}>
          <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:6}}>PASSWORD</label>
          <DInput dark type="password" value={p} onChange={e=>{sp(e.target.value);se("");}} placeholder="Enter your password"
            autoComplete="current-password" onKeyDown={e=>e.key==="Enter"&&go()}/>
        </div>
        {err&&<div style={{color:"#F87171",fontSize:12,marginBottom:8,padding:"8px 12px",background:"#220808",borderRadius:6}}>⚠ {err}</div>}
        <Btn onClick={go} style={{width:"100%",marginTop:14,padding:"11px 0",fontSize:14,letterSpacing:".04em"}}>SIGN IN →</Btn>
      </div>

      {/* Quick login removed — no client-side credentials in bundle */}
      {showQL&&<div style={{marginTop:14,background:"#1E2A36",border:"1px solid #2A2600",borderRadius:10,padding:16}}>
        <div style={{fontSize:9,color:"#4A4000",fontWeight:700,textTransform:"uppercase",letterSpacing:".1em",marginBottom:10,display:"flex",justifyContent:"space-between"}}>
          <span>⚙ Dev Quick Access</span>
          <span onClick={()=>sQL(false)} style={{cursor:"pointer",color:"#8DA0AD"}}>✕</span>
        </div>
        <div style={{fontSize:11,color:"#8DA0AD"}}>Use the sign-in form above with your assigned credentials.</div>
      </div>}
    </div>
  </div>;
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════
function OperatorSummary({beams,T}){
  const rows = useMemo(()=>{
    const m={};
    beams.forEach(b=>{
      const op=(b.dipping_operator||"").trim();
      if(!op || !b.dipped_at) return;
      if(!m[op]) m[op]={op,dipped:0,mt:0,coatSum:0,coatN:0,pass:0,fail:0};
      m[op].dipped++;
      m[op].mt += parseFloat(b.total_weight)||0;
      if(b.avg_reading){m[op].coatSum+=Number(b.avg_reading);m[op].coatN++;}
      if(b.qc_status==="PASS") m[op].pass++;
      else if(b.qc_status==="FAIL") m[op].fail++;
    });
    return Object.values(m).sort((a:any,b:any)=>b.dipped-a.dipped);
  },[beams]);
  if(!rows.length) return null;
  return <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:18}}>
    <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontSize:14}}>👷</span> Operator-wise Dipping Production & Coating
      <span style={{fontSize:10,color:T.muted,fontWeight:400,marginLeft:4}}>Combined production + average coating per operator</span>
    </div>
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead><tr style={{borderBottom:`1px solid ${T.border}`,color:T.muted,textAlign:"left"}}>
          {["Operator","Beams Dipped","Total MT","Avg Coating (μm)","CoJ Pass","CoJ Fail"].map(h=>(
            <th key={h} style={{padding:"8px 10px",fontWeight:700,fontSize:10,letterSpacing:".05em"}}>{h.toUpperCase()}</th>
          ))}
        </tr></thead>
        <tbody>
          {rows.map((r:any)=>(
            <tr key={r.op} style={{borderBottom:`1px solid ${T.border}`}}>
              <td style={{padding:"8px 10px",color:T.text,fontWeight:700}}>{r.op}</td>
              <td style={{padding:"8px 10px",fontFamily:"monospace",color:T.blueT,fontWeight:700}}>{r.dipped}</td>
              <td style={{padding:"8px 10px",fontFamily:"monospace",color:T.amber,fontWeight:700}}>{r.mt.toFixed(2)} MT</td>
              <td style={{padding:"8px 10px",fontFamily:"monospace",color:T.text,fontWeight:700}}>{r.coatN?(r.coatSum/r.coatN).toFixed(2):"—"}</td>
              <td style={{padding:"8px 10px",color:T.greenT,fontWeight:700}}>{r.pass}</td>
              <td style={{padding:"8px 10px",color:r.fail>0?T.redT:T.dim,fontWeight:700}}>{r.fail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>;
}

// ── Reusable Reference Beam Analysis panel ───────────────────
function BenchmarkPanel({ beam, T, compact = false }) {
  const bm = beam?.benchmark;
  if (!bm) return null;
  const color = benchmarkStatusColor(bm.status);
  const fieldStyle = {
    background: T?.bg || "#16202B",
    border: `1px solid ${T?.border || "#33434F"}`,
    borderRadius: 6,
    padding: "8px 10px",
  };
  const lbl = { fontSize: 9, color: T?.dim || "#3A4F70", fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase" };
  const val = { fontSize: 13, color: T?.text || "#C9D6DF", fontFamily: "monospace", fontWeight: 700, marginTop: 3 };
  return (
    <div style={{
      background: "linear-gradient(135deg,#0A1320,#0E1A2A)",
      border: `1px solid ${color}40`,
      borderRadius: 10,
      padding: compact ? 10 : 14,
      marginTop: 10,
      boxShadow: `0 0 14px ${color}15`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14 }}>🎯</span>
        <strong style={{ fontSize: 11, fontWeight: 800, color, letterSpacing: ".08em", textTransform: "uppercase" }}>
          Best Match Analysis — Closest Historical Beam
        </strong>
        <span style={{
          marginLeft: "auto", padding: "3px 10px", borderRadius: 12,
          background: color + "20", border: `1px solid ${color}60`,
          fontSize: 10, fontWeight: 800, color,
        }}>{bm.status}</span>
      </div>
      {bm.status === "Match Not Available" ? (
        <div style={{ fontSize: 12, color: "#3D7EA6", padding: "10px 12px", background: "#1A1100", border: "1px solid #3D7EA640", borderRadius: 6, fontWeight: 700 }}>
          ⚠ Match Not Available — No historical beam found meeting all enabled matching criteria.
          <div style={{ fontSize: 10, color: T?.dim || "#8DA0AD", fontWeight: 500, marginTop: 4 }}>
            Adjust admin tolerances or wait for more historical PASS beams that satisfy every enabled criterion.
          </div>
        </div>
      ) : bm.ref_beam_no ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          <div style={fieldStyle}><div style={lbl}>Ref Beam No</div><div style={val}>{bm.ref_beam_no}</div></div>
          <div style={fieldStyle}><div style={lbl}>Ref Beam ID</div><div style={{ ...val, fontSize: 10 }}>{bm.ref_beam_id}</div></div>
          <div style={fieldStyle}><div style={lbl}>Ref Avg (μm)</div><div style={val}>{bm.ref_avg}</div></div>
          <div style={fieldStyle}><div style={lbl}>Current Avg (μm)</div><div style={val}>{bm.current_avg}</div></div>
          <div style={fieldStyle}><div style={lbl}>Material Type</div><div style={{ ...val, fontSize: 12 }}>{bm.ref_material_type || "—"}</div></div>
          <div style={fieldStyle}><div style={lbl}>Surface Condition</div><div style={{ ...val, fontSize: 12 }}>{bm.ref_surface_condition || "—"}</div></div>
          <div style={fieldStyle}><div style={lbl}>Coating Δ (μm)</div>{(() => {
            const d = Number(bm.difference ?? 0);
            const isHigher = d > 0.05;
            const isLower = d < -0.05;
            const c = isHigher ? "#3D7EA6" : isLower ? "#4ADE80" : (T?.dim || "#8DA0AD");
            const label = isHigher ? `+${d.toFixed(2)} μm Higher` : isLower ? `${d.toFixed(2)} μm Lower` : "Equivalent";
            return <div style={{ marginTop: 3, display: "inline-block", padding: "3px 8px", borderRadius: 12, background: c + "20", border: `1px solid ${c}60`, color: c, fontSize: 11, fontWeight: 800, fontFamily: "monospace" }}>{label}</div>;
          })()}</div>
          <div style={fieldStyle}><div style={lbl}>Match Status</div><div style={{ ...val, fontSize: 11, color }}>{bm.status}</div></div>
          <div style={{ ...fieldStyle, gridColumn: "span 4" }}><div style={lbl}>Criteria Used</div><div style={{ ...val, fontSize: 10, color: T?.dim || "#8DA0AD", whiteSpace: "normal", lineHeight: 1.5 }}>{formatCriteriaUsed(bm.criteria_used) || "—"}</div></div>
          <div style={{ ...fieldStyle, gridColumn: "span 4" }}>
            <div style={lbl}>Coating on Job — 30-Point Withdrawal Averages (μm)</div>
            {bm.ref_sub_avgs ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, marginTop: 6 }}>
                {[["FW Outside Average", bm.ref_sub_avgs.fwOut], ["FW Inside Average", bm.ref_sub_avgs.fwIn], ["MW Outside Average", bm.ref_sub_avgs.mwOut], ["MW Inside Average", bm.ref_sub_avgs.mwIn], ["LW Outside Average", bm.ref_sub_avgs.lwOut], ["LW Inside Average", bm.ref_sub_avgs.lwIn], ["Total Average (30 ÷ 30)", bm.ref_avg]].map(([l, v]) => (
                  <div key={l} style={{ padding: "4px 6px", background: T?.bg || "#16202B", border: `1px solid ${T?.border || "#33434F"}`, borderRadius: 4, textAlign: "center" }}>
                    <div style={{ fontSize: 8, color: T?.dim || "#4A5A70", fontWeight: 700 }}>{l}</div>
                    <div style={{ fontSize: 11, color: T?.text || "#C9D6DF", fontWeight: 800, fontFamily: "monospace" }}>{v != null ? Number(v).toFixed(2) : "—"}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 10, color: T?.dim || "#8DA0AD", marginTop: 5 }}>Legacy 7-point record — withdrawal-wise (FW/MW/LW · Outside/Inside) averages are not available for this beam.</div>
            )}
          </div>
          <div style={fieldStyle}><div style={lbl}>Compared At</div><div style={{ ...val, fontSize: 10 }}>{fmtDateTimeTz(bm.compared_at)}</div></div>
        </div>

      ) : (
        <div style={{ fontSize: 11, color: T?.muted || "#8DA0AD", padding: "8px 4px" }}>
          ℹ No PASS reference beam exists yet at <strong style={{ color: T?.amber || "#3D7EA6" }}>{bm.ref_coating_required} μm</strong> spec. This beam (Avg <strong>{bm.current_avg} μm</strong>) will set the baseline for future comparisons.
        </div>
      )}
    </div>
  );
}



function DashboardTab({beams: allBeams,users,auditLog,T,user,setBeams,addAudit,fieldConfig,qcRanges,toggleBeamEnabled}:any){
  const isAdmin = user?.role==="admin";
  const disabledBeams = useMemo(()=>allBeams.filter((b:any)=>!beamEnabled(b)),[allBeams]);
  function toggleDisabled(b:any){
    if(toggleBeamEnabled){ toggleBeamEnabled(b); return; }
    if(!setBeams) return;
    const nextEnabled = !beamEnabled(b);
    setBeams((prev:any[])=>prev.map(x=>txn(x)===txn(b)?{...x,is_enabled:nextEnabled,disabled:!nextEnabled}:x));
    addAudit?.(user.id,user.full_name,"EDIT","dashboard",`${nextEnabled?"Enabled":"Disabled"} beam ${b.beam_no}`);
  }
  return <div style={{display:"flex",flexDirection:"column",gap:14}}>
    <SixSigmaDashboard beams={allBeams} users={users} T={T} qcRanges={qcRanges} />
    {isAdmin && <AdminBeamManager allBeams={allBeams} disabledBeams={disabledBeams} toggleDisabled={toggleDisabled} T={T}/>}
  </div>;
}


function AdminBeamManager({allBeams,disabledBeams,toggleDisabled,T}){
  const [q,setQ]=useState("");
  const [showDisabledOnly,setSDO]=useState(false);
  // Admin enable/disable applies ONLY to pending beams (not yet COMPLETED).
  // Newly loaded beams remain enabled by default and flow into Dipping as usual.
  const pendingBeams = useMemo(()=>allBeams.filter(b=>b.status!=="COMPLETED"),[allBeams]);
  const pendingDisabled = useMemo(()=>pendingBeams.filter(b=>!beamEnabled(b)),[pendingBeams]);
  const list = useMemo(()=>{
    const base = showDisabledOnly ? pendingDisabled : pendingBeams;
    const qq = q.trim().toLowerCase();
    return base.filter(b=>!qq || (`${b.beam_no} ${b.part_nos||""} ${b.load_type||""}`).toLowerCase().includes(qq))
      .slice().sort((a,b)=>new Date(b.loaded_at)-new Date(a.loaded_at)).slice(0,50);
  },[pendingBeams,pendingDisabled,q,showDisabledOnly]);
  return <div style={{background:T.card,border:`1px solid ${T.amber}40`,borderRadius:10,overflow:"hidden"}}>
    <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <span style={{fontSize:14}}>⚙</span>
      <div style={{fontSize:12,fontWeight:800,color:T.amber,letterSpacing:".06em"}}>ADMIN — PENDING BEAM CONTROL</div>
      <span style={{fontSize:10,color:T.dim}}>Disable stops a beam from moving to its next process. Status, data, dashboard, reports & tracker are unaffected.</span>
      <div style={{flex:1}}/>
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search beam no…"
        style={{background:T.bg,border:`1px solid ${T.border}`,color:T.text,padding:"5px 10px",borderRadius:6,fontSize:11,minWidth:180}}/>
      <button onClick={()=>setSDO(v=>!v)} style={{
        padding:"5px 12px",fontSize:11,fontWeight:700,borderRadius:6,cursor:"pointer",
        background:showDisabledOnly?"#F87171":T.bg,color:showDisabledOnly?"#000":T.muted,
        border:`1px solid ${showDisabledOnly?"#F87171":T.border}`}}>
        {showDisabledOnly?`Pending disabled only (${pendingDisabled.length})`:`Show pending disabled only (${pendingDisabled.length})`}
      </button>
    </div>
    <div style={{maxHeight:300,overflowY:"auto"}}>
      {list.length===0 && <div style={{padding:24,textAlign:"center",color:T.dim,fontSize:12}}>No beams</div>}
      {list.map(b=>(
        <div key={txn(b)} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 16px",borderBottom:`1px solid ${T.border}`,opacity:beamEnabled(b)?1:0.55}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:"monospace"}}>{b.beam_no} {!beamEnabled(b) && <span style={{fontSize:9,padding:"2px 6px",background:"#2A0808",border:"1px solid #F8717140",color:"#F87171",borderRadius:4,marginLeft:6}}>DISABLED</span>}</div>
            <div style={{fontSize:10,color:T.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.load_type} · {b.total_weight} MT · {b.status} · {fmt12(b.loaded_at)}</div>
          </div>
          <button onClick={()=>toggleDisabled(b)} style={{
            padding:"6px 14px",fontSize:11,fontWeight:700,borderRadius:6,cursor:"pointer",
            background:beamEnabled(b)?"#2A0808":"#0A2218",color:beamEnabled(b)?"#F87171":"#4ADE80",
            border:`1px solid ${beamEnabled(b)?"#F8717140":"#4ADE8040"}`}}>
            {beamEnabled(b)?"⊘ Disable":"✓ Enable"}
          </button>
        </div>
      ))}
    </div>
  </div>;
}


function BeamTrackerTab({beams,T,isAdmin=false,deleteBeams=(_:string[])=>{},toggleBeamEnabled=(_b:any)=>{}}){
  const [sel,setSel]=useState<Record<string,boolean>>({});
  const selectedNos = Object.keys(sel).filter(k=>sel[k]);
  const [search,ss]=useState(""); const [filter,sf]=useState("ALL");
  const filtered=useMemo(()=>beams.filter(b=>{
    const ok=`${b.beam_no} ${b.part_nos} ${b.section} ${b.load_type}`.toLowerCase().includes(search.toLowerCase());
    return ok&&(filter==="ALL"||b.status===filter);
  }).sort((a,b)=>new Date(b.loaded_at)-new Date(a.loaded_at)),[beams,search,filter]);

  function pendDur(b){
    if(b.status==="COMPLETED") return "—";
    const last=b.dipped_at||b.loaded_at;
    return fmtDur(Math.floor((new Date()-new Date(last))/1000));
  }

  return <div>
    <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
      <DInput dark value={search} onChange={e=>ss(e.target.value)} placeholder="🔍  Search beam / route / thickness..." style={{maxWidth:320}}/>
      <div style={{display:"flex",gap:6}}>
        {["ALL",...STATUS_ORDER].map(s=>(
          <button key={s} onClick={()=>sf(s)} style={{
            padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer",
            background:filter===s?T.amber:T.card,color:filter===s?"#000":T.muted,
            border:`1px solid ${filter===s?T.amber:T.border}`}}>{s.replace("_"," ")}</button>
        ))}
      </div>
      <div style={{marginLeft:"auto",fontSize:12,color:T.muted}}>{filtered.length} beams</div>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:14}}>
      {STATUS_ORDER.map(s=>{
        const cnt=beams.filter(b=>b.status===s).length, ss2=ST[s];
        return <div key={s} onClick={()=>sf(filter===s?"ALL":s)}
          style={{background:ss2.bg,border:`1px solid ${ss2.color}40`,borderRadius:8,padding:"10px 14px",cursor:"pointer"}}>
          <div style={{fontSize:9,color:ss2.color,fontWeight:800,letterSpacing:".08em",marginBottom:4}}>{ss2.label}</div>
          <div style={{fontSize:22,fontWeight:800,color:ss2.color,fontFamily:"monospace"}}>{cnt}</div>
        </div>;
      })}
    </div>

    <Card T={T}>
      <SecHead T={T} title="Live Beam Tracker" sub="Real-time status — Loading → Dipping → QC → Completed"
        right={isAdmin && selectedNos.length>0 ? (
          <button onClick={()=>{
            if(confirm(`Permanently delete ${selectedNos.length} selected beam(s)? This cannot be undone.`)){
              deleteBeams(selectedNos); setSel({});
            }
          }} style={{padding:"6px 12px",borderRadius:6,background:"#2A0808",color:"#F87171",border:"1px solid #F8717160",fontSize:11,fontWeight:700,cursor:"pointer"}}>
            🗑 Delete {selectedNos.length} selected
          </button>
        ) : null}/>
      <Table T={T}
        headers={[...(isAdmin?[<input key="hsel" type="checkbox"
          checked={filtered.length>0 && filtered.every(b=>sel[txn(b)])}
          onChange={e=>{ const ck=e.target.checked; const n:any={...sel}; filtered.forEach(b=>{ if(ck) n[txn(b)]=true; else delete n[txn(b)]; }); setSel(n); }}/>]:[]),"Beam No","Part No(s)","Thickness","Load Type","Weight","μm Req","Status","Loaded","Dipped","CoJ Done","Pending",...(isAdmin?["Actions"]:[])]}
        rows={filtered.map(b=>[
          ...(isAdmin?[<input key={txn(b)+"_s"} type="checkbox" checked={!!sel[txn(b)]} onChange={e=>setSel(p=>({...p,[txn(b)]:e.target.checked}))}/>]:[]),
          <span style={{display:"inline-flex",alignItems:"center",gap:6}}>
            {bn(b.beam_no)}
            {!beamEnabled(b) && <span style={{fontSize:9,padding:"1px 6px",background:"#2A0808",border:"1px solid #F8717140",color:"#F87171",borderRadius:4,fontWeight:700}}>Disabled</span>}
          </span>,
          <span style={{fontSize:11,color:T.muted,maxWidth:160,display:"block",overflow:"hidden",textOverflow:"ellipsis"}}>{b.part_nos}</span>,
          <span style={{fontSize:11,color:T.muted}}>{b.section}</span>,
          b.load_type,
          mn(b.total_weight?.toFixed(2)+" MT",T.cyanT),
          b.coating_required+" μm",
          <StatusBadge status={b.status}/>,
          <span style={{fontSize:11}}>{fmt12(b.loaded_at)}</span>,
          <span style={{fontSize:11,color:T.amber}}>{fmt12(b.dipped_at)}</span>,
          <span style={{fontSize:11,color:T.greenT}}>{fmt12(b.qc_completed_at)}</span>,
          <span style={{fontSize:11,color:b.status!=="COMPLETED"?"#FB923C":T.dim}}>{pendDur(b)}</span>,
          ...(isAdmin?[<div key={txn(b)+"_act"} style={{display:"flex",gap:4,alignItems:"center"}}>
            <button onClick={()=>{
              const on=beamEnabled(b);
              if(confirm(on?`Disable beam ${b.beam_no}? It keeps its status and data but cannot move to the next process until enabled.`:`Enable beam ${b.beam_no}? It can continue the normal workflow from ${b.status}.`)) toggleBeamEnabled(b);
            }} title={beamEnabled(b)?"Disable this beam":"Enable this beam"}
              style={{padding:"4px 10px",borderRadius:5,fontSize:10,fontWeight:700,cursor:"pointer",
                background:beamEnabled(b)?"#2A0808":"#0A2218",color:beamEnabled(b)?"#F87171":"#4ADE80",
                border:`1px solid ${beamEnabled(b)?"#F8717160":"#4ADE8060"}`}}>
              {beamEnabled(b)?"🔴 Disable":"🟢 Enable"}
            </button>
            <button onClick={()=>{ if(confirm(`Permanently delete beam ${b.beam_no}?`)) deleteBeams([txn(b)]); }} style={{padding:"4px 10px",borderRadius:5,background:"#2A0808",color:"#F87171",border:"1px solid #F8717160",fontSize:10,fontWeight:700,cursor:"pointer"}}>🗑</button>
          </div>]:[]),

        ])}/>
    </Card>
  </div>;
}

// ══════════════════════════════════════════════════════════════
// LOADING TAB
// ══════════════════════════════════════════════════════════════
function LoadingTab({beams,setBeams,addAudit,user,readOnly=false,T,fieldConfig={},micronRules=[]}:any){
  const dark=true;
  const LOAD_TYPES_GROUPED=[
    {grp:"Tower Members",types:["Amc","Cnc","Drilling","Plate","Cleat","Hook"]},
    {grp:"Special Process",types:["Proto","Double Dipp","Double Batch","Other"]},
  ];
  const show65 = useShow65();
  const COAT_OPTS=filterCoatings([{val:65,label:"65 Micron",sub:"IS 2629 Min"},{val:87,label:"87 Micron",sub:"IS 2629 Std"},{val:130,label:"130 Micron",sub:"Heavy Duty"}]);
  const WORK_CENTRES=["WC-ZINC","WC-FLUX","WC-PICKLE","WC-RINSE","WC-DEGREASE","WC-QC","WC-DISPATCH"];

  // Admin-controlled field config (label & visibility of route_card / qty / thickness-vs-section)
  const fc = fieldConfig || {};
  const THICK_LABEL = fc.thicknessLabel || "Thickness"; // always Thickness
  const RC_ENABLED  = fc.routeCardEnabled !== false;     // default on
  const QTY_ENABLED = fc.qtyEnabled       !== false;     // default on


  // Part rows for double batch: each has { part, qty, length_mm, weight, section, route_card }
  const EMPTY_PART_ROW={part:"",qty:"1",length_mm:"",weight:"",section:"",route_card:""};
  // Standard part rows (part no + qty + per-row route card)
  const EMPTY_STD_ROW={part:"",qty:"1",route_card:""};

  const emptyF={
    date:new Date().toISOString().slice(0,10),
    beam_no:"",
    part_rows:[{...EMPTY_STD_ROW}],
    dbl_part_rows:[{...EMPTY_PART_ROW}],
    section:"", load_type:"",
    total_weight:"", length_mm:"", coating_required:"",
    work_centre:"WC-ZINC",
    material_grade:"",
    material_type:"",
    _coatingTouched:false,
  };
  const [f,sf]=useState(emptyF);

  // Auto-select coating from active admin Micron Rules (prefix + thickness).
  // Respects the _coatingTouched flag so a manual operator pick is never overwritten.
  function maybeAutoMicron(partNoOverride?:string, thicknessOverride?:string){
    sf(prev=>{
      if(prev._coatingTouched) return prev;
      const part = (partNoOverride ?? prev.part_rows?.[0]?.part ?? "").trim();
      if(!part) return prev;
      const thkStr = thicknessOverride ?? prev.section;
      const thkMm = parseThicknessMm(thkStr);
      const ruleMicron = resolveMicronFromRules(part, thkMm, micronRules||[]);
      if(ruleMicron==null) return prev;
      if(parseInt(prev.coating_required as any)===ruleMicron) return prev;
      return {...prev, coating_required:String(ruleMicron)};
    });
  }

  // Re-evaluate when rules data loads/changes or section (thickness) changes.
  useEffect(()=>{ maybeAutoMicron(); /* eslint-disable-line */ },[micronRules,f.section,f.part_rows?.[0]?.part]);



  const [msg,sm]=useState(null);
  const [search,ss]=useState("");
  const [edit,se]=useState(null);
  const [showForm,setShowForm]=useState(true);
  const [qrBeam,setQrBeam]=useState(null);   // beam for QR modal
  const [qrWC,  setQrWC  ]=useState(null);   // work-centre QR modal
  const [showWCQR,setSWCQR]=useState(false);  // work-centre QR panel

  // Persist the in-progress Loading form so a refresh / phone call /
  // browser kill never loses partially-typed entries. Only drafts while
  // creating a NEW beam (not when editing an existing one).
  const beamsPending = usePendingCount("beams");
  useDraft(user?.id, "load:current", f, sf as any, { enabled: !edit });
  const clearLoadDraft = () => { try { clearDraft(user?.id, "load:current"); } catch {} };
  const clearLoadDraftWhenSafe = (transactionId: string, beamNo: string, submittedDraft?: any) => {
    if (typeof window === "undefined") return;
    const startedAt = Date.now();
    let done = false;
    const finish = (clear: boolean, text?: string) => {
      if (done) return;
      done = true;
      window.removeEventListener("hdp:sync-status", onStatus as any);
      window.removeEventListener("hdp:sync-error", onError as any);
      if (clear) clearLoadDraft();
      if (text) sm({ ok: clear, text });
    };
    const matches = (d: any) => d?.table === "beams" && Array.isArray(d.ids) && d.ids.map(String).includes(String(transactionId));
    const onStatus = (ev: any) => {
      const d = ev?.detail || {};
      if (!matches(d)) return;
      if (d.status === "saved") {
        finish(true);
      } else if (d.status === "queued") {
        if (submittedDraft) saveDraft(user?.id, "load:current", submittedDraft);
        sm({ ok: true, text: `✅ Beam ${beamNo} registered — syncing automatically` });
      }
    };
    const onError = (ev: any) => {
      const d = ev?.detail || {};
      if (d.table !== "beams") return;
      if (!d.permanent) return;
      if (Array.isArray(d.ids) && !d.ids.map(String).includes(String(transactionId))) return;
      if (submittedDraft) {
        saveDraft(user?.id, "load:current", submittedDraft);
        sf(submittedDraft);
      }
      finish(false, `⚠ Beam ${beamNo} was not saved: ${d.message || "sync error"}`);
    };
    window.addEventListener("hdp:sync-status", onStatus as any);
    window.addEventListener("hdp:sync-error", onError as any);
    setTimeout(() => {
      if (!done && submittedDraft) saveDraft(user?.id, "load:current", submittedDraft);
    }, 600);
    setTimeout(() => {
      if (Date.now() - startedAt >= 14_000) {
        if (done) return;
        if (submittedDraft) saveDraft(user?.id, "load:current", submittedDraft);
        sm({ ok: false, text: `⚠ Beam ${beamNo} is still syncing — entry draft kept until confirmed` });
      }
    }, 14_000);
    setTimeout(() => {
      if (!done) finish(false);
    }, 120_000);
  };

  const isDoubleBatch=f.load_type==="Double Batch";
  const sorted=beams.slice().sort((a,b)=>new Date(b.loaded_at)-new Date(a.loaded_at));
  const filtered=sorted.filter(b=>`${b.beam_no} ${b.part_nos} ${b.section} ${b.load_type} ${b.work_centre||""} ${b.route_card||""}`.toLowerCase().includes(search.toLowerCase()));

  // ── Part row helpers ─────────────────────────────────────────
  function composeParts(rows){return rows.filter(r=>r.part?.trim()).map(r=>r.part.trim()+(r.qty&&parseInt(r.qty)>1?` ×${r.qty}`:"")).join(", ");}
  function addStdRow(){sf(p=>({...p,part_rows:[...p.part_rows,{...EMPTY_STD_ROW}]}));}
  function removeStdRow(i){sf(p=>({...p,part_rows:p.part_rows.filter((_,j)=>j!==i)}));}
  function updateStdRow(i,key,val){sf(p=>({...p,part_rows:p.part_rows.map((r,j)=>j===i?{...r,[key]:val}:r)}));}

  function addDblRow(){sf(p=>({...p,dbl_part_rows:[...p.dbl_part_rows,{...EMPTY_PART_ROW}]}));}
  function removeDblRow(i){sf(p=>({...p,dbl_part_rows:p.dbl_part_rows.filter((_,j)=>j!==i)}));}
  function updateDblRow(i,key,val){sf(p=>({...p,dbl_part_rows:p.dbl_part_rows.map((r,j)=>j===i?{...r,[key]:val}:r)}));}

  // For double batch: derive totals from part rows
  const dblTotalWeight=isDoubleBatch
    ? f.dbl_part_rows.reduce((s,r)=>s+(parseFloat(r.weight)||0),0).toFixed(2)
    : null;
  const dblAllLengths=isDoubleBatch
    ? f.dbl_part_rows.map(r=>r.length_mm).filter(Boolean).join(", ")
    : null;

  // ── QR code generation (client-side, no external API) ───────
  // Uses the `qrcode` library so beam/work-centre data never leaves the browser.
  async function generateQRDataUrl(text: string, size = 200): Promise<string> {
    const QR = (await import("qrcode")).default;
    return QR.toDataURL(text, {
      width: size,
      margin: 2,
      color: { dark: "#3D7EA6", light: "#1E2A36" },
    });
  }
  function QRImage({ text, size = 200, style, alt }: { text: string; size?: number; style?: any; alt?: string }) {
    const [src, setSrc] = useState<string>("");
    useEffect(() => {
      let cancelled = false;
      generateQRDataUrl(text, size).then(d => { if (!cancelled) setSrc(d); }).catch(() => {});
      return () => { cancelled = true; };
    }, [text, size]);
    if (!src) return <div style={{ ...style, background: "#16202B" }} aria-label={alt} />;
    return <img src={src} alt={alt} style={style} />;
  }

  // ── Validation ───────────────────────────────────────────────
  const MAX_WT = typeof fc.maxBeamWeightMT === "number" ? fc.maxBeamWeightMT : 3.0;
  const DUP_CHECK = fc.restrictDuplicateBeam !== false; // default ON
  function validate(){
    if(!f.beam_no.trim()){sm({ok:false,text:"⚠ Beam Number required"});return false;}
    if(RC_ENABLED && !(f.part_rows.some(r=>r.route_card?.trim()) || f.dbl_part_rows.some(r=>r.route_card?.trim()))){
      sm({ok:false,text:"⚠ Route Card required on at least one part"});return false;
    }
    if(!f.load_type){sm({ok:false,text:"⚠ Select Type of Load"});return false;}
    if(!f.material_type){sm({ok:false,text:"⚠ Select Material Type (MS / HT)"});return false;}
    if(!f.coating_required){sm({ok:false,text:"⚠ Select Coating Requirement"});return false;}

    // Re-entry of the same Beam Number is always allowed — each loading
    // cycle gets its own unique Transaction ID (e.g. "05-6:35/30"), so
    // previous in-process records are never overwritten or blocked.


    if(isDoubleBatch){
      const valid=f.dbl_part_rows.filter(r=>r.part.trim());
      if(!valid.length){sm({ok:false,text:"⚠ Enter at least one Part No for Double Batch"});return false;}
      if(valid.some(r=>!r.length_mm||!r.weight||!r.section)){
        sm({ok:false,text:`⚠ Each part in Double Batch needs Length (mm), Weight and ${THICK_LABEL}`});return false;
      }
      for(let i=0;i<valid.length;i++){
        const terr=checkThickness(valid[i].section,fc);
        if(terr){sm({ok:false,text:`⚠ Row ${i+1}: ${terr}`});return false;}
      }
      const sumWt = valid.reduce((s,r)=>s+(parseFloat(r.weight)||0),0);
      if(sumWt >= MAX_WT){
        sm({ok:false,text:`⚠ Total weight ${sumWt.toFixed(2)} MT exceeds limit. Beam weight must be below ${MAX_WT} MT.`});return false;
      }
    } else {
      if(composeParts(f.part_rows).trim()===""){sm({ok:false,text:"⚠ Enter at least one Part No"});return false;}
      const thickErr=checkThickness(f.section,fc);
      if(thickErr){sm({ok:false,text:`⚠ ${thickErr}`});return false;}
      if(!f.total_weight||isNaN(parseFloat(f.total_weight))){sm({ok:false,text:"⚠ Enter valid Total Weight (MT)"});return false;}
      const wt = parseFloat(f.total_weight);
      if(wt >= MAX_WT){
        sm({ok:false,text:`⚠ Weight ${wt.toFixed(2)} MT exceeds limit. Beam weight must be below ${MAX_WT} MT.`});return false;
      }
      if(!isLengthless(f.load_type) && (!f.length_mm||isNaN(parseFloat(f.length_mm)))){sm({ok:false,text:"⚠ Enter valid Length (mm)"});return false;}
    }
    return true;
  }

  function save(){
    if(!validate()) return;
    const now=nowISO();
    const shift=autoShift(now);
    let part_nos,section,total_weight,length_mm,parts_detail=null;
    let dbl_parts_detail=null;

    if(isDoubleBatch){
      const valid=f.dbl_part_rows.filter(r=>r.part.trim());
      part_nos=valid.map(r=>r.part.trim()+(r.qty&&parseInt(r.qty)>1?` ×${r.qty}`:"")).join(", ");
      section=valid.map(r=>r.section).join(" | ");
      total_weight=valid.reduce((s,r)=>s+(parseFloat(r.weight)||0),0).toFixed(2);
      length_mm=valid.map(r=>r.length_mm+"mm").join(", ");
      dbl_parts_detail=valid.map(r=>({part:r.part.trim(),qty:parseInt(r.qty)||1,length_mm:parseFloat(r.length_mm),weight:parseFloat(r.weight),section:r.section,route_card:(r.route_card||"").trim()}));
    } else {
      const validStd=f.part_rows.filter(r=>r.part?.trim());
      part_nos=composeParts(f.part_rows);
      section=f.section;
      total_weight=parseFloat(f.total_weight).toFixed(2);
      // Plate beams have no Length — saved as null and treated as null everywhere downstream.
      length_mm=isLengthless(f.load_type) ? null : f.length_mm;
      parts_detail=validStd.map(r=>({part:r.part.trim(),qty:parseInt(r.qty)||1,route_card:(r.route_card||"").trim()}));
    }
    const total_qty=isDoubleBatch
      ? (dbl_parts_detail||[]).reduce((s,r)=>s+(r.qty||1),0)
      : (parts_detail||[]).reduce((s,r)=>s+(r.qty||1),0);
    // Aggregate all unique route cards from per-row entries
    const rcSet=new Set<string>();
    (parts_detail||[]).forEach((r:any)=>r.route_card&&rcSet.add(r.route_card));
    (dbl_parts_detail||[]).forEach((r:any)=>r.route_card&&rcSet.add(r.route_card));
    const route_cards=Array.from(rcSet);
    const route_card_combined=route_cards.join(", ");


    if(edit){
      setBeams(prev=>prev.map(b=>txn(b)===txn(edit)?{...b,
        date:f.date, route_card:route_card_combined, route_cards,
        part_nos, section, load_type:f.load_type,
        material_type:f.material_type,
        total_weight:parseFloat(total_weight), length_mm:length_mm==null?null:parseFloat(length_mm),
        coating_required:parseInt(f.coating_required),
        work_centre:f.work_centre,
        parts_detail, dbl_parts_detail, total_qty,
      }:b));
      addAudit(user.id,user.full_name,"EDIT","loading","Edited beam "+f.beam_no);
      sm({ok:true,text:"✅ Beam "+f.beam_no+" updated"});
      se(null);
    } else {
      const bno=f.beam_no.trim().toUpperCase();
      const transaction_id = makeTxnId(bno, now, beams);
      const submittedDraft = { ...f };
      saveDraft(user?.id, "load:current", submittedDraft);
      clearLoadDraftWhenSafe(transaction_id, bno, submittedDraft);
      setBeams(prev=>[{
        id:Date.now(), transaction_id, beam_no:bno, date:f.date, shift,
        route_card:route_card_combined,
        route_cards,
        part_nos, section, load_type:f.load_type,
        material_type:f.material_type,
        total_weight:parseFloat(total_weight),
        length_mm:length_mm==null?null:parseFloat(length_mm),
        coating_required:parseInt(f.coating_required),
        work_centre:f.work_centre,
        parts_detail, dbl_parts_detail, total_qty,
        loaded_by:user.id, loaded_by_name:user.full_name, loaded_at:now,
        immersion_start:null,immersion_end:null,immersion_duration:null,
        reaction_end:null,reaction_duration:null,withdrawal_end:null,withdrawal_duration:null,
        dipped_by:null,dipped_by_name:null,dipped_at:null,dipped_parts:null,
        elcometer:[null,null,null,null,null,null,null],avg_reading:null,
        qc_remark:"",qc_status:null,qc_auto_remark:null,
        qc_completed_by:null,qc_completed_by_name:null,qc_completed_at:null,
        status:"LOADED",
      },...prev]);
      addAudit(user.id,user.full_name,"CREATE","loading",`Loaded ${bno} (Txn ${transaction_id}) | ${f.load_type} | ${part_nos}`);
      sm({ok:true,text:`✅ Beam ${bno} registered — Txn ${transaction_id} | Shift: ${shift} | Work Centre: ${f.work_centre}`});
    }

    // (Legacy per-prefix micron memory removed — Admin Micron Mapping Rules
    // are now the only source for auto-selecting micron values.)


    sf(emptyF);
    if(edit) clearLoadDraft();
    setTimeout(()=>sm(null),7000);
  }

  function startEdit(b){
    const rows=b.parts_detail?.length
      ? b.parts_detail.map(r=>({part:r.part||"",qty:String(r.qty||1),route_card:r.route_card||""}))
      : (b.part_nos?b.part_nos.split(",").map(s=>{const m=s.trim().match(/^(.*?)\s*×\s*(\d+)$/);return m?{part:m[1].trim(),qty:m[2],route_card:""}:{part:s.trim(),qty:"1",route_card:""};}):[{...EMPTY_STD_ROW}]);
    const dblRows=b.dbl_parts_detail?.length
      ? b.dbl_parts_detail.map(r=>({part:r.part||"",qty:String(r.qty||1),length_mm:r.length_mm||"",weight:r.weight||"",section:r.section||"",route_card:r.route_card||""}))
      : [{...EMPTY_PART_ROW}];
    sf({date:b.date, beam_no:b.beam_no, part_rows:rows, dbl_part_rows:dblRows,
      section:b.section, load_type:b.load_type,
      material_type:b.material_type||"",
      total_weight:b.total_weight, length_mm:isLengthless(b.load_type)?"":(b.length_mm||""),
      coating_required:b.coating_required, work_centre:b.work_centre||"WC-ZINC",
      _coatingTouched:true});
    se(b); sm(null); setShowForm(true);
    window.scrollTo({top:0,behavior:"smooth"});
  }

  // Live stats
  const loaded   =filtered.filter(b=>b.status==="LOADED").length;
  const inProg   =filtered.filter(b=>b.status==="DIPPING").length;
  const qcPend   =filtered.filter(b=>b.status==="QC_PENDING").length;
  const done     =filtered.filter(b=>b.status==="COMPLETED").length;
  const totalMT  =filtered.reduce((s,b)=>s+(b.total_weight||0),0).toFixed(2);

  // Work-centre beam counts for QR
  const wcCounts=useMemo(()=>{
    const m={};
    WORK_CENTRES.forEach(wc=>{m[wc]=beams.filter(b=>b.work_centre===wc).length;});
    return m;
  },[beams]);

  return <div style={{fontFamily:"system-ui,-apple-system,sans-serif"}}>
    {readOnly&&<div style={{padding:"10px 16px",background:"#0E1E3A",border:"1px solid #1A3A6E",borderRadius:8,marginBottom:14,display:"flex",alignItems:"center",gap:10,fontSize:12,color:"#5BA3FF"}}><span style={{fontSize:16}}>👁</span><strong>SUPERVISOR VIEW — READ ONLY</strong><span style={{color:"#3A4F70",marginLeft:4}}>Loading data visible. Contact Loading Supervisor to modify records.</span></div>}

    {/* ── HEADER BANNER ────────────────────────────────────────── */}
    <div style={{background:"linear-gradient(135deg,#0E1A2B,#1A2E4A)",border:"1px solid #1E3A60",borderRadius:10,padding:"16px 22px",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
      <div style={{display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:48,height:48,borderRadius:10,background:"linear-gradient(135deg,#3D7EA6,#2E6285)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:"0 0 16px rgba(61,126,166,.4)"}}>📦</div>
        <div>
          <div style={{fontSize:15,fontWeight:800,color:"#C9D6DF",letterSpacing:".06em"}}>LOADING STATION</div>
          <div style={{fontSize:11,color:"#8DA0AD",marginTop:2}}>HDP Galvanizing — Transmission Line Tower Components</div>
        </div>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        {[["LOADED",loaded,"#5BA3FF"],["DIPPING",inProg,"#FB923C"],["COJ PEND",qcPend,"#FDE047"],["DONE",done,"#4ADE80"]].map(([l,v,col])=>(
          <div key={l} style={{background:"rgba(0,0,0,.3)",border:`1px solid ${col}30`,borderRadius:8,padding:"7px 12px",textAlign:"center",minWidth:64}}>
            <div style={{fontSize:18,fontWeight:900,color:col,fontFamily:"monospace",lineHeight:1}}>{v}</div>
            <div style={{fontSize:9,color:"#8DA0AD",marginTop:2,fontWeight:700}}>{l}</div>
          </div>
        ))}
        <div style={{background:"rgba(61,126,166,.1)",border:"1px solid #3D7EA640",borderRadius:8,padding:"7px 14px",textAlign:"center"}}>
          <div style={{fontSize:18,fontWeight:900,color:"#3D7EA6",fontFamily:"monospace",lineHeight:1}}>{totalMT}</div>
          <div style={{fontSize:9,color:"#8DA0AD",marginTop:2,fontWeight:700}}>TOTAL MT</div>
        </div>
        {/* Work Centre QR Button */}
        <button onClick={()=>setSWCQR(p=>!p)} style={{padding:"8px 14px",borderRadius:8,border:"1px solid #3D5A6B",background:showWCQR?"#3D5A6B":"transparent",color:"#5BA3FF",cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit"}}>
          📷 Work Centre QR
        </button>
      </div>
    </div>

    {/* ── WORK CENTRE QR PANEL ─────────────────────────────────── */}
    {showWCQR&&<div style={{background:"#1E2A36",border:"1px solid #3D5A6B",borderRadius:10,padding:18,marginBottom:14}}>
      <div style={{fontSize:13,fontWeight:700,color:"#C9D6DF",marginBottom:4}}>📷 Work Centre QR Codes</div>
      <div style={{fontSize:11,color:"#8DA0AD",marginBottom:14}}>Scan any QR to instantly filter and view all beams for that work centre. Print and post at each station.</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
        {WORK_CENTRES.map(wc=>(
          <div key={wc} style={{background:"#16202B",border:"1px solid #33434F",borderRadius:8,padding:14,textAlign:"center"}}>
            <div style={{fontSize:12,fontWeight:700,color:"#5BA3FF",marginBottom:8}}>{wc}</div>
            <QRImage
              text={`HDP-PLANT:WORKCENTRE:${wc}`}
              size={120}
              alt={`QR for ${wc}`}
              style={{width:100,height:100,borderRadius:6,border:"2px solid #3D5A6B",display:"block",margin:"0 auto 8px"}}/>
            <div style={{fontSize:10,color:"#3A4F70",marginBottom:6}}>{wcCounts[wc]||0} beams</div>
            <button onClick={()=>{ss(wc);setSWCQR(false);}} style={{
              padding:"4px 12px",borderRadius:5,border:"1px solid #3D5A6B",background:"#1E2A36",
              color:"#5BA3FF",cursor:"pointer",fontSize:10,fontFamily:"inherit",fontWeight:600}}>
              Filter Beams →
            </button>
          </div>
        ))}
      </div>
    </div>}

    {/* ── REGISTRATION FORM ────────────────────────────────────── */}
    <div style={{display:readOnly?"none":"block"}}>
    <div style={{background:"#1E2A36",border:`2px solid ${edit?"#3D7EA6":"#33434F"}`,borderRadius:12,marginBottom:14,overflow:"hidden",boxShadow:edit?"0 0 24px rgba(61,126,166,.12)":"none"}}>
      {/* Form header */}
      <div style={{background:edit?"linear-gradient(90deg,#2A1E00,#1A1400)":"linear-gradient(90deg,#0A1A2E,#1E2A36)",borderBottom:"1px solid #33434F",padding:"13px 20px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:edit?"#3D7EA6":"#4ADE80",boxShadow:`0 0 8px ${edit?"#3D7EA6":"#4ADE80"}`}}/>
          <span style={{fontSize:13,fontWeight:700,color:"#C9D6DF"}}>{edit?`EDITING — BEAM ${edit.beam_no}`:"NEW BEAM REGISTRATION"}</span>
          {isDoubleBatch&&<span style={{fontSize:10,color:"#FB923C",background:"#2A1600",padding:"2px 8px",borderRadius:4,fontWeight:700,border:"1px solid #4A2A00"}}>⚡ DOUBLE BATCH MODE</span>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{fontFamily:"monospace",fontSize:11,color:"#FDE047",background:"#2A2600",padding:"3px 10px",borderRadius:5,fontWeight:700}}>{autoShift(nowISO())}</div>
          <button onClick={()=>setShowForm(p=>!p)} style={{background:"transparent",border:"1px solid #33434F",borderRadius:6,padding:"4px 10px",color:"#8DA0AD",cursor:"pointer",fontSize:11}}>{showForm?"▲ Collapse":"▼ Expand"}</button>
        </div>
      </div>

      {showForm&&<div style={{padding:20}}>
        {/* ROW 1 — Beam No + Date + Work Centre */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14,marginBottom:14}}>
          {/* Beam No */}
          <div>
            <label style={{fontSize:10,color:"#3D7EA6",fontWeight:800,letterSpacing:".08em",textTransform:"uppercase",display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
              <span style={{background:"#3D7EA6",color:"#000",borderRadius:3,padding:"1px 6px",fontSize:9,fontWeight:900}}>REQUIRED</span>
              Beam Number
            </label>
            <DInput dark value={f.beam_no}
              onChange={e=>sf(p=>({...p,beam_no:e.target.value.toUpperCase()}))}
              placeholder="B-1025"
              disabled={!!edit}
              style={{fontSize:20,fontWeight:800,fontFamily:"monospace",textAlign:"center",letterSpacing:".08em",padding:"13px 16px",background:edit?"#0F1720":"#16202B",border:`2px solid ${edit?"#2A2600":f.beam_no?"#3D7EA6":"#3D5A6B"}`,color:edit?"#3A4F70":"#3D7EA6",borderRadius:8}}/>
          </div>
          {/* Date */}
          <div>
            <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".07em",textTransform:"uppercase",display:"block",marginBottom:8}}>Date</label>
            <DInput dark type="date" value={f.date} onChange={e=>sf(p=>({...p,date:e.target.value}))} style={{fontSize:14,padding:"13px 14px",fontFamily:"monospace",borderRadius:8}}/>
            <div style={{marginTop:6,padding:"6px 10px",background:"#2A2600",border:"1px solid #4A4000",borderRadius:5,display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:12}}>⏰</span>
              <span style={{fontSize:11,color:"#FDE047",fontWeight:700}}>{autoShift(nowISO())}</span>
            </div>
          </div>
          {/* Work Centre — editable by Admin only */}
          <div>
            <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".07em",textTransform:"uppercase",display:"block",marginBottom:8}}>
              Work Centre {user?.role!=="admin" && <span style={{color:"#3D7EA6",fontWeight:600,letterSpacing:".05em"}}>🔒 Admin only</span>}
            </label>
            <DSel dark value={f.work_centre} disabled={user?.role!=="admin"} onChange={e=>sf(p=>({...p,work_centre:e.target.value}))} style={{opacity:user?.role!=="admin"?0.6:1,cursor:user?.role!=="admin"?"not-allowed":"pointer"}}>
              {WORK_CENTRES.map(wc=><option key={wc} value={wc}>{wc}</option>)}
            </DSel>
            <div style={{marginTop:6,fontSize:10,color:"#3A4F70"}}>{user?.role==="admin"?"QR code generated per work centre for scanning":"Locked — only Admin can change the Work Centre"}</div>
          </div>
        </div>



        {/* TYPE OF LOAD — button grid */}
        <div style={{marginBottom:14}}>
          <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".07em",textTransform:"uppercase",display:"block",marginBottom:8}}>
            Type of Load <span style={{color:"#3D7EA6"}}>*</span>
          </label>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {LOAD_TYPES_GROUPED.map(grp=>(
              <div key={grp.grp}>
                <div style={{fontSize:9,color:"#3A4F70",fontWeight:700,letterSpacing:".07em",textTransform:"uppercase",marginBottom:6}}>{grp.grp}</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {grp.types.map(t=>(
                    <button key={t} onClick={()=>sf(p=>({...p,load_type:t,part_rows:[EMPTY_STD_ROW],dbl_part_rows:[{...EMPTY_PART_ROW}]}))} style={{
                      padding:"7px 14px",borderRadius:7,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",
                      background:f.load_type===t?"#3D7EA6":"#16202B",color:f.load_type===t?"#000":"#6B82A8",
                      border:`1px solid ${f.load_type===t?"#3D7EA6":"#33434F"}`,
                      boxShadow:f.load_type===t?"0 0 10px rgba(61,126,166,.3)":"none",
                      letterSpacing:".02em"}}>
                      {t==="Double Batch"?"⚡ "+t:t==="Double Dipp"?"⚡ "+t:t}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* MATERIAL TYPE — MS / HT */}
        <div style={{marginBottom:14}}>
          <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".07em",textTransform:"uppercase",display:"block",marginBottom:8}}>
            Material Type <span style={{color:"#3D7EA6"}}>*</span>
          </label>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {[{k:"MS",lbl:"MS — Mild Steel"},{k:"HT",lbl:"HT — High Tensile Steel"}].map(mt=>(
              <button key={mt.k} type="button" onClick={()=>sf(p=>({...p,material_type:mt.k}))} style={{
                padding:"9px 18px",borderRadius:7,fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"inherit",
                background:f.material_type===mt.k?"#22D3EE":"#16202B",color:f.material_type===mt.k?"#000":"#6B82A8",
                border:`1px solid ${f.material_type===mt.k?"#22D3EE":"#33434F"}`,
                boxShadow:f.material_type===mt.k?"0 0 10px rgba(34,211,238,.3)":"none",letterSpacing:".03em"}}>
                {mt.lbl}
              </button>
            ))}
          </div>
        </div>


        {/* ── STANDARD PART ENTRY (not double batch) ─────────── */}
        {!isDoubleBatch&&<>
          {/* Part No rows */}
          <div style={{background:"#16202B",border:"2px solid #3D5A6B",borderRadius:10,padding:16,marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
              <span style={{background:"#1A3A6E",borderRadius:5,padding:"3px 10px",fontSize:10,color:"#5BA3FF",fontWeight:700}}>PART NO</span>
              <span style={{fontSize:12,color:"#C9D6DF",fontWeight:600}}>Part Number(s)</span>
              <span style={{fontSize:10,color:"#3A4F70",marginLeft:4}}>Multiple parts allowed — set Qty per part</span>
              <span style={{marginLeft:"auto",fontSize:10,color:"#3D7EA6",fontWeight:700}}>{f.part_rows.filter(r=>r.part?.trim()).length} parts · {f.part_rows.reduce((s,r)=>s+(r.part?.trim()?(parseInt(r.qty)||1):0),0)} qty</span>
            </div>
            <div style={{display:"grid",gap:8}}>
              {f.part_rows.map((row,i)=>(
                <div key={i} style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  <div style={{width:26,height:26,borderRadius:"50%",background:"#33434F",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,color:"#5BA3FF",flexShrink:0}}>{i+1}</div>
                  <DInput dark value={row.part||""}
                    onChange={e=>{const v=e.target.value.toUpperCase(); updateStdRow(i,"part",v); maybeAutoMicron(v);}}
                    placeholder={`Part No #${i+1} — e.g. P-${1001+i}`}
                    style={{flex:"1 1 180px",minWidth:140,fontSize:14,fontWeight:600,fontFamily:"monospace",letterSpacing:".04em",border:`1px solid ${row.part?"#3D7EA6":"#33434F"}`}}/>
                  {QTY_ENABLED && <div style={{position:"relative",flexShrink:0}}>
                    <DInput dark type="number" min="1" step="1" value={row.qty||""}
                      onChange={e=>updateStdRow(i,"qty",e.target.value)}
                      placeholder="Qty"
                      style={{width:90,fontSize:13,fontWeight:700,fontFamily:"monospace",textAlign:"center",paddingRight:30,border:`1px solid ${row.qty&&parseInt(row.qty)>0?"#22D3EE":"#33434F"}`}}/>
                    <span style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#22D3EE",fontWeight:700}}>QTY</span>
                  </div>}
                  {RC_ENABLED && <div style={{position:"relative",flexShrink:0}}>
                    <DInput dark value={row.route_card||""}
                      onChange={e=>updateStdRow(i,"route_card",e.target.value.toUpperCase())}
                      placeholder="RC"
                      style={{width:160,fontSize:12,fontWeight:700,fontFamily:"monospace",paddingRight:32,border:`1px solid ${row.route_card?"#3D7EA6":"#33434F"}`}}/>
                    <span style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#3D7EA6",fontWeight:700}}>RC</span>
                  </div>}
                  {f.part_rows.length>1&&<button onClick={()=>removeStdRow(i)} aria-label={`Remove part row ${i+1}`} title="Remove part row" style={{width:28,height:28,border:"1px solid #441010",borderRadius:6,background:"#220808",color:"#F87171",cursor:"pointer",fontSize:16,flexShrink:0}}><span aria-hidden="true">✕</span></button>}
                </div>
              ))}
            </div>
            <button onClick={addStdRow} style={{marginTop:10,padding:"7px 14px",background:"transparent",border:"1px dashed #3D5A6B",borderRadius:6,color:"#5BA3FF",cursor:"pointer",fontSize:12,width:"100%",fontFamily:"inherit"}}>+ Add Another Part No</button>
            {f.part_rows.some(r=>r.part?.trim())&&(
              <div style={{marginTop:10,padding:"7px 12px",background:"#0A1520",border:"1px solid #3D5A6B",borderRadius:6,fontSize:11,color:"#5BA3FF",fontFamily:"monospace"}}>
                Combined: {composeParts(f.part_rows)}
              </div>
            )}
          </div>

          {/* Thickness + Weight + Length for standard. Length hidden when load type = Plate. */}
          <div style={{display:"grid",gridTemplateColumns:isLengthless(f.load_type)?"1fr 1fr":"1fr 1fr 1fr",gap:14,marginBottom:14}}>
            <div>
              <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".07em",textTransform:"uppercase",display:"block",marginBottom:8}}>{THICK_LABEL} <span style={{color:"#3D7EA6"}}>*</span></label>
              <DInput dark inputMode="decimal" value={f.section} onChange={e=>sf(p=>({...p,section:sanitizeThicknessInput(e.target.value)}))} placeholder={`e.g. 6, 8, 12.5 (max ${maxThicknessOf(fc)} mm)`}/>
              <div style={{fontSize:9,color:"#3A4F70",marginTop:4}}>Numbers only (mm) — maximum {maxThicknessOf(fc)} mm.</div>
            </div>
            <div>
              <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".07em",textTransform:"uppercase",display:"block",marginBottom:8}}>Total Weight (MT) <span style={{color:"#3D7EA6"}}>*</span></label>
              <div style={{position:"relative"}}>
                <DInput dark type="number" step="0.001" min="0" value={f.total_weight} onChange={e=>sf(p=>({...p,total_weight:e.target.value}))} placeholder="0.000" style={{fontFamily:"monospace",fontWeight:700,paddingRight:36}}/>
                <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"#3A4F70",fontWeight:700}}>MT</span>
              </div>
            </div>
            {!isLengthless(f.load_type) && <div>
              <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".07em",textTransform:"uppercase",display:"block",marginBottom:8}}>Length (mm) <span style={{color:"#3D7EA6"}}>*</span></label>
              <div style={{position:"relative"}}>
                <DInput dark type="number" step="1" min="0" value={f.length_mm} onChange={e=>sf(p=>({...p,length_mm:e.target.value}))} placeholder="6000" style={{fontFamily:"monospace",fontWeight:700,paddingRight:38}}/>
                <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"#3A4F70",fontWeight:700}}>mm</span>
              </div>
            </div>}
          </div>
        </>}


        {/* ── DOUBLE BATCH — Part rows with individual length/weight/section ── */}
        {isDoubleBatch&&<div style={{background:"#0A1A08",border:"2px solid #1A3A10",borderRadius:10,padding:18,marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
            <span style={{fontSize:16}}>⚡</span>
            <span style={{fontSize:13,fontWeight:800,color:"#4ADE80"}}>DOUBLE BATCH — Part Details</span>
            <span style={{fontSize:10,color:"#3A4F70",marginLeft:4}}>Enter length (mm), weight & thickness per part number</span>
            <span style={{marginLeft:"auto",fontSize:10,color:"#FDE047",fontWeight:700,background:"#2A2600",padding:"2px 8px",borderRadius:4}}>
              Total: {dblTotalWeight} MT
            </span>
          </div>

          {/* Column headers */}
          <div style={{display:"grid",gridTemplateColumns:"36px 1fr 80px 120px 120px 1fr 28px",gap:8,marginBottom:8}}>
            {["#","Part No *","Qty *","Length (mm) *","Weight (MT) *","Thickness *",""].map((h,i)=>(
              <div key={i} style={{fontSize:9,color:"#3A4F70",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",textAlign:i===0||i===6?"center":"left"}}>{h}</div>
            ))}
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {f.dbl_part_rows.map((row,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"36px 1fr 80px 120px 120px 1fr 28px",gap:8,alignItems:"center",padding:"10px 12px",background:"#060E04",border:"1px solid #1A2A10",borderRadius:8}}>
                {/* Index */}
                <div style={{width:26,height:26,borderRadius:"50%",background:"#1A3A10",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,color:"#4ADE80",margin:"0 auto"}}>
                  {i+1}
                </div>
                {/* Part No */}
                <DInput dark value={row.part||""} onChange={e=>{const v=e.target.value.toUpperCase(); updateDblRow(i,"part",v); maybeAutoMicron(v);}}
                  placeholder={`P-${1001+i}`}
                  style={{fontFamily:"monospace",fontSize:13,fontWeight:700,border:`1px solid ${row.part?"#4ADE80":"#1A3A10"}`}}/>
                {/* Qty */}
                <DInput dark type="number" min="1" step="1" value={row.qty||""} onChange={e=>updateDblRow(i,"qty",e.target.value)}
                  placeholder="1"
                  style={{fontFamily:"monospace",fontSize:13,fontWeight:700,textAlign:"center",border:`1px solid ${row.qty&&parseInt(row.qty)>0?"#22D3EE":"#1A3A10"}`}}/>
                {/* Length mm */}
                <div style={{position:"relative"}}>
                  <DInput dark type="number" step="1" min="0" value={row.length_mm||""} onChange={e=>updateDblRow(i,"length_mm",e.target.value)}
                    placeholder="e.g. 6000"
                    style={{fontFamily:"monospace",fontSize:13,paddingRight:34,border:`1px solid ${row.length_mm?"#22D3EE":"#1A3A10"}`}}/>
                  <span style={{position:"absolute",right:7,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#22D3EE",fontWeight:700}}>mm</span>
                </div>
                {/* Weight */}
                <div style={{position:"relative"}}>
                  <DInput dark type="number" step="0.001" min="0" value={row.weight||""} onChange={e=>updateDblRow(i,"weight",e.target.value)}
                    placeholder="0.000"
                    style={{fontFamily:"monospace",fontSize:13,paddingRight:28,border:`1px solid ${row.weight?"#3D7EA6":"#1A3A10"}`}}/>
                  <span style={{position:"absolute",right:7,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#3D7EA6",fontWeight:700}}>MT</span>
                </div>
                {/* Thickness */}
                <DInput dark inputMode="decimal" value={row.section||""} onChange={e=>updateDblRow(i,"section",sanitizeThicknessInput(e.target.value))}
                  placeholder={`mm (max ${maxThicknessOf(fc)})`}
                  style={{fontSize:13,border:`1px solid ${row.section?"#A78BFA":"#1A3A10"}`}}/>
                {/* Remove */}
                {f.dbl_part_rows.length>1
                  ?<button onClick={()=>removeDblRow(i)} aria-label={`Remove double dip row ${i+1}`} title="Remove row" style={{width:26,height:26,border:"1px solid #441010",borderRadius:5,background:"#220808",color:"#F87171",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}><span aria-hidden="true">✕</span></button>
                  :<div/>}
              </div>
            ))}
          </div>

          <button onClick={addDblRow} style={{marginTop:10,padding:"8px 16px",background:"transparent",border:"1px dashed #1A3A10",borderRadius:6,color:"#4ADE80",cursor:"pointer",fontSize:12,width:"100%",fontFamily:"inherit"}}>
            + Add Part to Double Batch
          </button>

          {/* Auto-computed totals preview */}
          {f.dbl_part_rows.some(r=>r.part?.trim())&&<div style={{marginTop:12,padding:"10px 14px",background:"#070F04",border:"1px solid #1A3A10",borderRadius:7,display:"flex",gap:20,flexWrap:"wrap"}}>
            <div><span style={{fontSize:9,color:"#3A4F70",display:"block",marginBottom:3}}>PARTS</span><span style={{fontFamily:"monospace",fontSize:13,color:"#4ADE80",fontWeight:700}}>{f.dbl_part_rows.filter(r=>r.part?.trim()).map(r=>r.part).join(", ")}</span></div>
            <div><span style={{fontSize:9,color:"#3A4F70",display:"block",marginBottom:3}}>TOTAL WEIGHT</span><span style={{fontFamily:"monospace",fontSize:13,color:"#3D7EA6",fontWeight:700}}>{dblTotalWeight} MT</span></div>
            <div><span style={{fontSize:9,color:"#3A4F70",display:"block",marginBottom:3}}>LENGTHS</span><span style={{fontFamily:"monospace",fontSize:12,color:"#22D3EE",fontWeight:700}}>{f.dbl_part_rows.filter(r=>r.length_mm).map(r=>r.length_mm+"mm").join(", ")||"—"}</span></div>
            <div><span style={{fontSize:9,color:"#3A4F70",display:"block",marginBottom:3}}>THICKNESS</span><span style={{fontFamily:"monospace",fontSize:12,color:"#A78BFA",fontWeight:700}}>{f.dbl_part_rows.filter(r=>r.section).map(r=>r.section).join(" | ")||"—"}</span></div>
          </div>}
        </div>}

        {/* Coating — toggle buttons */}
        <div style={{marginBottom:16}}>
          <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".07em",textTransform:"uppercase",display:"block",marginBottom:8}}>Coating Requirement <span style={{color:"#3D7EA6"}}>*</span></label>
          <div style={{display:"flex",gap:10}}>
            {COAT_OPTS.map(opt=>(
              <button key={opt.val} onClick={()=>sf(p=>({...p,coating_required:opt.val,_coatingTouched:true}))} style={{
                flex:1,padding:"12px 14px",borderRadius:8,cursor:"pointer",fontFamily:"inherit",
                display:"flex",alignItems:"center",justifyContent:"space-between",
                background:parseInt(f.coating_required)===opt.val?"#2A1E00":"#16202B",
                border:`2px solid ${parseInt(f.coating_required)===opt.val?"#3D7EA6":"#33434F"}`,
                boxShadow:parseInt(f.coating_required)===opt.val?"0 0 12px rgba(61,126,166,.25)":"none"}}>
                <span style={{fontSize:14,fontWeight:800,fontFamily:"monospace",color:parseInt(f.coating_required)===opt.val?"#3D7EA6":"#8DA0AD"}}>{opt.label}</span>
                <span style={{fontSize:9,color:parseInt(f.coating_required)===opt.val?"#CA8A04":"#5C7482",fontWeight:700}}>{opt.sub}</span>
              </button>
            ))}
          </div>
        </div>

        {msg&&<Alert ok={msg?.ok} msg={msg?.text} onClose={()=>sm(null)}/>}

        {/* Action buttons */}
        {beamsPending>0 && <div style={{margin:"0 0 10px",padding:"8px 12px",background:"#2A1E00",border:"1px solid #4A4000",borderRadius:6,fontSize:11,color:"#FDE047",fontWeight:700,display:"flex",alignItems:"center",gap:8}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:"#FDE047",boxShadow:"0 0 8px #FDE047",animation:"pulse 1.2s infinite"}}/>
          QUEUED — {beamsPending} pending change{beamsPending===1?"":"s"} will sync when connection is stable
        </div>}
        <div style={{display:"flex",gap:10}}>
          <button onClick={save} style={{flex:1,padding:"14px 0",fontSize:15,fontWeight:800,background:"linear-gradient(135deg,#3D7EA6,#2E6285)",color:"#000",border:"none",borderRadius:8,cursor:"pointer",letterSpacing:".06em",fontFamily:"inherit",boxShadow:"0 4px 16px rgba(61,126,166,.3)"}}>
            {edit?"✓  SAVE CHANGES":"⊕  REGISTER BEAM"}
          </button>
          {edit&&<button onClick={()=>{se(null);sf(emptyF);clearLoadDraft();sm(null);}} style={{padding:"14px 24px",fontSize:14,fontWeight:700,background:"transparent",color:"#8DA0AD",border:"1px solid #33434F",borderRadius:8,cursor:"pointer",fontFamily:"inherit"}}>✕ Cancel</button>}
        </div>
      </div>}
    </div>
    </div>{/* end readOnly wrapper */}

    {/* ── BEAM RECORDS TABLE ─────────────────────────────────── */}
    <div style={{background:"#1E2A36",border:"1px solid #33434F",borderRadius:12,overflow:"hidden"}}>
      <div style={{background:"#0F1720",borderBottom:"1px solid #33434F",padding:"12px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#C9D6DF"}}>Loaded Beams Register</div>
          <div style={{fontSize:10,color:"#3A4F70",marginTop:2}}>Showing latest {Math.min(20,filtered.length)} of {filtered.length} beams — data auto-available in Dipping module</div>
        </div>
        <div style={{position:"relative"}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:12,color:"#3A4F70"}}>🔍</span>
          <DInput dark value={search} onChange={e=>ss(e.target.value)} placeholder="Search beam, part, thickness, type, work centre..." style={{paddingLeft:30,width:300,fontSize:12}}/>
        </div>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead>
            <tr style={{background:"#0F1720"}}>
              {["Beam No","Date","Shift","Work Centre","Route Card","Part No(s)","Qty","Thickness","Type","Weight (MT)","Length (mm)","Coating","Status","By","QR","Action"].map(h=>(
                <th key={h} style={{padding:"9px 11px",textAlign:"left",color:"#3A4F70",fontWeight:700,fontSize:10,letterSpacing:".06em",textTransform:"uppercase",borderBottom:"1px solid #33434F",whiteSpace:"nowrap"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length===0&&<tr><td colSpan={16} style={{padding:36,textAlign:"center",color:"#5C7482",fontSize:12}}>No beams registered yet — use the form above to register the first beam</td></tr>}
            {filtered.slice(0,20).map((b,i)=>{
              const st=ST[b.status]||ST.LOADED;
              return <tr key={txn(b)} style={{borderBottom:"1px solid #1E2A36",transition:"background .1s"}}
                onMouseEnter={e=>e.currentTarget.style.background="#111C2E"}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <td style={{padding:"10px 11px"}}><span style={{fontFamily:"monospace",fontSize:13,fontWeight:800,color:"#3D7EA6",letterSpacing:".05em"}}>{b.beam_no}</span></td>
                <td style={{padding:"10px 11px",fontSize:11,color:"#8DA0AD",whiteSpace:"nowrap"}}>{b.date}</td>
                <td style={{padding:"10px 11px",whiteSpace:"nowrap"}}><span style={{fontSize:10,fontWeight:700,color:"#FDE047",background:"#2A2600",padding:"2px 6px",borderRadius:4}}>{b.shift?.split(" ")[0]}</span></td>
                <td style={{padding:"10px 11px",whiteSpace:"nowrap"}}><span style={{fontSize:10,fontWeight:700,color:"#5BA3FF",background:"#0E1E3A",padding:"2px 7px",borderRadius:4}}>{b.work_centre||"—"}</span></td>
                <td style={{padding:"10px 11px",whiteSpace:"nowrap"}}><span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,color:b.route_card?"#3D7EA6":"#3A4F70"}}>{b.route_card||"—"}</span></td>
                <td style={{padding:"10px 11px",maxWidth:140}}><span style={{fontSize:10,color:"#5BA3FF",fontFamily:"monospace",wordBreak:"break-all"}}>{b.part_nos||"—"}</span></td>
                <td style={{padding:"10px 11px",whiteSpace:"nowrap",textAlign:"center"}}><span style={{fontSize:11,fontFamily:"monospace",fontWeight:700,color:"#22D3EE"}}>{b.total_qty||"—"}</span></td>
                <td style={{padding:"10px 11px"}}><span style={{fontSize:10,color:"#8DA0AD"}}>{b.section||"—"}</span></td>
                <td style={{padding:"10px 11px",whiteSpace:"nowrap"}}>
                  <span style={{fontSize:10,fontWeight:700,color:["Double Batch","Double Dipp"].includes(b.load_type)?"#FB923C":"#C9D6DF",background:"#33434F",padding:"2px 7px",borderRadius:4}}>{b.load_type}</span>
                </td>
                <td style={{padding:"10px 11px",whiteSpace:"nowrap"}}><span style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:"#22D3EE"}}>{b.total_weight?.toFixed(2)}</span></td>
                <td style={{padding:"10px 11px",whiteSpace:"nowrap"}}>
                  <span style={{fontFamily:"monospace",fontSize:12,color:"#C9D6DF"}}>
                    {b.load_type==="Double Batch"&&b.dbl_parts_detail
                      ? b.dbl_parts_detail.map(r=>r.length_mm+"mm").join(", ")
                      : (b.length_mm?b.length_mm+"mm":"—")}
                  </span>
                </td>
                <td style={{padding:"10px 11px",whiteSpace:"nowrap"}}><span style={{fontFamily:"monospace",fontSize:11,fontWeight:700,color:b.coating_required===130?"#A78BFA":b.coating_required===87?"#5BA3FF":"#4ADE80"}}>{b.coating_required}μm</span></td>
                <td style={{padding:"10px 11px",whiteSpace:"nowrap"}}><span style={{display:"inline-block",padding:"3px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:st.bg,color:st.color}}>{st.label}</span></td>
                <td style={{padding:"10px 11px",fontSize:11,color:"#8DA0AD",whiteSpace:"nowrap"}}>{b.loaded_by_name}</td>
                <td style={{padding:"10px 11px"}}>
                  <button onClick={()=>setQrBeam(b)} style={{padding:"4px 8px",borderRadius:5,border:"1px solid #3D5A6B",background:"transparent",color:"#5BA3FF",cursor:"pointer",fontSize:10,fontFamily:"inherit",fontWeight:600}}>📷 QR</button>
                </td>
                <td style={{padding:"10px 11px",whiteSpace:"nowrap"}}>
                  {b.status==="LOADED"&&!readOnly
                    ?<button onClick={()=>startEdit(b)} style={{padding:"5px 11px",borderRadius:5,border:"1px solid #33434F",background:"#24313E",color:"#8DA0AD",cursor:"pointer",fontSize:11,fontFamily:"inherit",fontWeight:600}}>✏ Edit</button>
                    :<span style={{fontSize:10,color:"#5C7482",fontStyle:"italic"}}>{b.status!=="LOADED"?"In Progress":"—"}</span>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>

    {/* ── BEAM QR MODAL ─────────────────────────────────────── */}
    {qrBeam&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}} onClick={()=>setQrBeam(null)}>
      <div style={{background:"#1E2A36",border:"2px solid #3D7EA6",borderRadius:14,padding:28,minWidth:340,textAlign:"center"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:14,fontWeight:800,color:"#3D7EA6",marginBottom:2,fontFamily:"monospace",letterSpacing:".08em"}}>{qrBeam.beam_no}</div>
        <div style={{fontSize:11,color:"#8DA0AD",marginBottom:4}}>{qrBeam.load_type} | {qrBeam.work_centre}</div>
        <div style={{fontSize:10,color:"#3A4F70",marginBottom:16}}>{qrBeam.part_nos} | {qrBeam.coating_required}μm | {qrBeam.total_weight}MT</div>
        <QRImage
          text={`HDP:BEAM:${qrBeam.beam_no}:WC:${qrBeam.work_centre||""}:TYPE:${qrBeam.load_type}:COAT:${qrBeam.coating_required}`}
          size={200}
          alt={`QR ${qrBeam.beam_no}`}
          style={{width:200,height:200,borderRadius:10,border:"2px solid #3D5A6B",margin:"0 auto 16px",display:"block"}}/>
        <div style={{display:"flex",gap:10,justifyContent:"center"}}>
          <button onClick={async()=>{const url=await generateQRDataUrl(`HDP:BEAM:${qrBeam.beam_no}:WC:${qrBeam.work_centre||""}:TYPE:${qrBeam.load_type}:COAT:${qrBeam.coating_required}`,400);const w=window.open();if(w){w.document.write(`<img src="${url}" style="width:100%"/>`);}}} style={{padding:"8px 18px",borderRadius:7,border:"1px solid #3D7EA6",background:"transparent",color:"#3D7EA6",cursor:"pointer",fontSize:12,fontFamily:"inherit",fontWeight:700}}>🖨 Open Full Size</button>
          <button onClick={()=>setQrBeam(null)} style={{padding:"8px 18px",borderRadius:7,border:"1px solid #33434F",background:"transparent",color:"#8DA0AD",cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>Close</button>
        </div>
      </div>
    </div>}
  </div>;
}

function DippingTab({beams,setBeams,addAudit,user,readOnly=false,T,dippingConfig,operators=[],shiftSupervisors=[],micronRules=[],mlrModel=null,mlrTrainedAt=null,lgbmModel=null,lgbmTrainedAt=null,xgbModel=null,xgbTrainedAt=null,catModel=null,catTrainedAt=null,zcModel=null,zcTrainedAt=null,aiModel="mlr"}:any){
  const dc = dippingConfig || {engineEnabled:true,showThickness:true,showWeight:true,showTemperature:true,showQty:true,showLoadType:true,showLength:true,showMaterialType:true,showSurfaceCondition:true,weightTol:0.2,tempTol:2,lengthTol:500,qtyTol:5,topN:3,allowPostEdit:false};
  const [sel,ss]=useState("");
  const [live,sl]=useState(nowISO());
  const [msg,sm]=useState(null);
  const [dbl,setDbl]=useState({selectedParts:[],nextBeamNo:"",nextSelectedParts:[]});
  const activeOperators = (operators||[]).filter((o:any)=>o.active);
  const activeShiftSups = (shiftSupervisors||[]).filter((s:any)=>s.active);
  const [operatorName,setOperatorName]=useState("");
  const [shiftSupName,setShiftSupName]=useState("");
  const [editBeam,setEditBeam]=useState<any>(null);
  const canEditPast = !!dc.allowPostEdit || user?.role === "admin";

  // ── Timestamps — each stored as ISO string ─────────────────
  const [tsImmStart,setIS]=useState(null);
  const [tsImmEnd,  setIE]=useState(null);
  const [tsReactEnd,setRE]=useState(null);
  const [tsWithEnd, setWE]=useState(null);
  const [bathTemp, setBathTemp]=useState("");
  const [surfaceCond, setSurfaceCond] = useState<string>("");
  const [selectedTopIdx, setSelectedTopIdx] = useState<number>(0);
  // NOTE: reset moved below `beam` declaration to avoid TDZ.
  const [showRegister,setShowRegister]=useState(false);
  const savingRef = useRef(false);
  const savedRef  = useRef(false);

  // Live count of beams writes still queued offline — used to show
  // operator a "QUEUED — will sync" pill and to keep the success toast
  // visible until the row is fully synced.
  const beamsPending = usePendingCount("beams");

  // Per-beam drafts: bathTemp, operator, shiftSup, and manual MM:SS values
  // are persisted in localStorage keyed by the currently selected beam so a
  // refresh / phone call / browser kill mid-entry doesn't lose work.
  useDraft(user?.id, sel ? `dip:${sel}:bathTemp` : "dip:none:bathTemp",
    bathTemp, setBathTemp, { enabled: !!sel });
  useDraft(user?.id, sel ? `dip:${sel}:operatorName` : "dip:none:operatorName",
    operatorName, setOperatorName, { enabled: !!sel });
  useDraft(user?.id, sel ? `dip:${sel}:shiftSupName` : "dip:none:shiftSupName",
    shiftSupName, setShiftSupName, { enabled: !!sel });
  useDraft(user?.id, sel ? `dip:${sel}:surfaceCond` : "dip:none:surfaceCond",
    surfaceCond, setSurfaceCond, { enabled: !!sel });
  // manImm/manReact/manWith useDraft calls are placed AFTER their useState
  // declarations below to avoid a temporal-dead-zone ReferenceError.

  // ── Time Entry Mode (admin-controlled: live_only | manual_only | both) ───
  const timeMode: "live_only"|"manual_only"|"both" =
    dc.dippingTimeMode || (dc.manualDurationEntry ? "manual_only" : "live_only");
  // When mode is "both", operator chooses per-entry. Default to Live.
  const [userManualPref, setUserManualPref] = useState(false);
  const manualMode =
    timeMode === "manual_only" ? true :
    timeMode === "live_only"   ? false :
    userManualPref;
  const [manImm, setManImm] = useState("");   // MM:SS
  const [manReact, setManReact] = useState(""); // MM:SS
  const [manWith, setManWith] = useState("");  // MM:SS
  // Per-beam drafts for the manual MM:SS fields. Must be declared AFTER the
  // useState calls above (temporal dead zone).
  useDraft(user?.id, sel ? `dip:${sel}:manImm` : "dip:none:manImm",
    manImm, setManImm, { enabled: !!sel });
  useDraft(user?.id, sel ? `dip:${sel}:manReact` : "dip:none:manReact",
    manReact, setManReact, { enabled: !!sel });
  useDraft(user?.id, sel ? `dip:${sel}:manWith` : "dip:none:manWith",
    manWith, setManWith, { enabled: !!sel });
  // Strict MM:SS validator — returns specific, user-friendly error per field.
  // Rules: Immersion/Withdrawal 00:01–30:00; Reaction 00:00–30:00; Total 00:05–60:00.
  const MAX_FIELD_SEC = 30 * 60;   // 30:00
  const TOTAL_MIN_SEC = 5;         // 00:05
  const TOTAL_MAX_SEC = 60 * 60;   // 60:00
  const fmtMmSs = (sec:number) => `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;
  function validateMmSsField(
    label:string,
    raw:string,
    opts:{min:number; max:number; allowZero:boolean}
  ): { seconds:number|null; error:string|null } {
    const s = (raw||"").trim();
    if(!s) return { seconds:null, error:`${label} is required (MM:SS)` };
    if(!/^\d{1,2}:\d{2}$/.test(s)) return { seconds:null, error:`${label}: use MM:SS format, e.g. 01:23` };
    const [mm, ss] = s.split(":").map(n=>parseInt(n,10));
    if(ss > 59) return { seconds:null, error:`${label}: seconds must be 00–59` };
    const total = mm*60 + ss;
    if(!opts.allowZero && total < opts.min)
      return { seconds:total, error:`${label} must be at least ${fmtMmSs(opts.min)}` };
    if(opts.allowZero && total < 0)
      return { seconds:total, error:`${label} cannot be negative` };
    if(total > opts.max)
      return { seconds:total, error:`${label} cannot exceed ${fmtMmSs(opts.max)} (got ${fmtMmSs(total)})` };
    return { seconds:total, error:null };
  }
  const vImm   = validateMmSsField("Immersion Duration",  manImm,  { min:1, max:MAX_FIELD_SEC, allowZero:false });
  const vReact = validateMmSsField("Reaction Duration",   manReact,{ min:0, max:MAX_FIELD_SEC, allowZero:true  });
  const vWith  = validateMmSsField("Withdrawal Duration", manWith, { min:1, max:MAX_FIELD_SEC, allowZero:false });
  const manImmSec   = vImm.error   ? null : vImm.seconds;
  const manReactSec = vReact.error ? null : vReact.seconds;
  const manWithSec  = vWith.error  ? null : vWith.seconds;
  const manTotalSec = (manImmSec!=null && manReactSec!=null && manWithSec!=null) ? (manImmSec+manReactSec+manWithSec) : null;
  let manTotalError: string|null = null;
  if(manTotalSec!=null){
    if(manTotalSec < TOTAL_MIN_SEC) manTotalError = `Total dipping time ${fmtMmSs(manTotalSec)} is too short — minimum ${fmtMmSs(TOTAL_MIN_SEC)}`;
    else if(manTotalSec > TOTAL_MAX_SEC) manTotalError = `Total dipping time ${fmtMmSs(manTotalSec)} exceeds maximum ${fmtMmSs(TOTAL_MAX_SEC)}`;
  }
  const manualFirstError = vImm.error || vReact.error || vWith.error || manTotalError;
  // Sanitize MM:SS input: digits-only, auto-insert ':' after 2 digits, max length 5.
  function sanitizeMmSs(input:string): string {
    const digits = (input||"").replace(/[^\d:]/g,"").replace(/:/g,"").slice(0,4);
    if(digits.length <= 2) return digits;
    return digits.slice(0, digits.length-2) + ":" + digits.slice(-2);
  }

  // Server-anchored clock: ticks every second while visible, re-syncs on
  // resume / online so a phone call or screen-lock can't drift the timer.
  const { tick: serverTick } = useServerClock(1000);
  useEffect(() => { sl(serverTick); }, [serverTick]);

  // ── Split-batch helpers ────────────────────────────────────
  const isDoubleType=(b)=>!!b&&["Double Batch","Double Dipp"].includes(b.load_type);
  const partList=(b)=>b?.part_nos?b.part_nos.split(",").map(p=>p.trim()).filter(Boolean):[];
  const dippedSet=(b)=>{const s=new Set();(b?.dipping_history||[]).forEach(h=>(h.parts||[]).forEach(p=>s.add(p)));return s;};
  const remainingParts=(b)=>{const all=partList(b),d=dippedSet(b);return all.filter(p=>!d.has(p));};
  const hasRemaining=(b)=>isDoubleType(b)&&partList(b).length>0&&remainingParts(b).length>0;

  // A beam is available for dipping if it's freshly LOADED, OR it's a Double Batch
  // mid-progress (DIPPING) that still has un-dipped parts.
  // Admin can suppress a pending beam via the Dashboard "Enable/Disable" control
  // — disabled beams are skipped here so they never appear in the Dipping selector.
  const available=beams.filter(b=>beamEnabled(b) && (b.status==="LOADED"||(b.status==="DIPPING"&&hasRemaining(b))));
  const beam=beams.find(b=>txn(b)===sel);

  // ── Coating-requirement acknowledgement pop-up ───────────────
  // On beam selection the app resolves the beam's part-number prefix against
  // the LIVE admin micron rules and forces a one-tap acknowledgement.
  const [ackedTxns,setAckedTxns]=useState<Record<string,boolean>>({});
  const coatingReqInfo = useMemo(()=>{
    if(!beam) return null;
    const parts = String(beam.part_nos||"").split(",").map((p:string)=>p.trim()).filter(Boolean);
    const thk = parseThicknessMm(beam.section);
    let matched:any = null, matchedPart = "";
    for(const p of parts){
      const r = resolveRuleForPart(p, thk, micronRules as any);
      if(r){ matched = r; matchedPart = p; break; }
    }
    return {
      parts,
      thicknessMm: thk,
      matchedPart,
      prefix: matched ? String(matched.prefix).toUpperCase() : null,
      required: matched ? Number(matched.coating_required) : (beam.coating_required!=null?Number(beam.coating_required):null),
      local: matched && matched.local_coating_required!=null ? Number(matched.local_coating_required) : null,
      hasRule: !!matched,
    };
  },[beam?.beam_no, beam?.part_nos, beam?.section, beam?.coating_required, micronRules]);
  // Pop-up only fires when THIS beam's part-number prefix resolves to an admin
  // rule that actually has a Local Coating Requirement configured.
  const needsCoatingAck = !!beam && !!coatingReqInfo?.hasRule && coatingReqInfo?.local!=null && !ackedTxns[txn(beam)];


  useEffect(()=>{ setSelectedTopIdx(0); }, [beam?.beam_no, bathTemp, surfaceCond]);
  const isSpecial=beam&&isDoubleType(beam);
  const beamRemaining=beam?remainingParts(beam):[];
  const beamAlreadyDipped=beam?Array.from(dippedSet(beam)):[];

  // ── Server-anchored phase persistence ─────────────────────────
  // Each phase tap is written to the beams row immediately so the timer
  // survives phone calls, screen-lock, refresh, and brief network drops.
  // Status moves LOADED→DIPPING on the first phase; final status change to
  // QC_PENDING still happens via save() (needs bath temp + operator).
  const persistPhase = (field: string, iso: string|null) => {
    if (!beam) return;
    const beamTxn = txn(beam);
    setBeams((prev:any[]) => prev.map((x:any) => {
      if (txn(x) !== beamTxn) return x;
      const patch:any = { [field]: iso };
      if (field === "immersion_start") {
        if (iso) {
          if (x.status === "LOADED") patch.status = "DIPPING";
          patch.dipping_at = iso;
          if (!x.dipped_by) {
            patch.dipped_by = user.id;
            patch.dipped_by_name = user.full_name;
          }
        } else {
          // Operator cleared the start — revert beam back to LOADED so it
          // disappears from in-progress rehydration.
          if (x.status === "DIPPING" && !x.withdrawal_end) {
            patch.status = "LOADED";
            patch.dipping_at = null;
          }
        }
      }
      return { ...x, ...patch };
    }));
  };
  const setIS_p = (v:any) => { setIS(v); persistPhase("immersion_start", v); };
  const setIE_p = (v:any) => { setIE(v); persistPhase("immersion_end",   v); };
  const setRE_p = (v:any) => { setRE(v); persistPhase("reaction_end",    v); };
  const setWE_p = (v:any) => { setWE(v); persistPhase("withdrawal_end",  v); };

  // Track txns reset in the last ~3s so the auto-rehydrate effect skips a
  // beam whose server row hasn't yet round-tripped its cleared timestamps.
  const recentlyReset = useRef<Record<string, number>>({});
  const isRecentlyReset = (t:string) => {
    const ts = recentlyReset.current[t];
    if (!ts) return false;
    const stillQueued = (() => {
      try {
        return pendingOpsForTable("beams").some((op:any) => {
          if (op.kind === "update") return String(op.id) === String(t);
          if (op.kind === "insert") return (op.rows || []).some((r:any) => String(r?.[op.rowIdKey]) === String(t));
          if (op.kind === "upsert") return String(op.row?.[op.rowIdKey]) === String(t);
          if (op.kind === "delete") return (op.ids || []).map(String).includes(String(t));
          return false;
        });
      } catch { return false; }
    })();
    if (stillQueued) return true;
    return (Date.now() - ts) < 15000;
  };

  // Abort an in-progress dipping session on the server: clears all phase
  // timestamps & operator metadata and reverts DIPPING -> LOADED so the row
  // is no longer picked up by auto-rehydrate. Saved beams (QC_PENDING /
  // COMPLETED) are untouched.
  const abortBeamPhases = (beamTxn: string) => {
    if (!beamTxn) return;
    recentlyReset.current[beamTxn] = Date.now();
    setBeams((prev:any[]) => prev.map((x:any) => {
      if (txn(x) !== beamTxn) return x;
      if (x.status === "QC_PENDING" || x.status === "COMPLETED") return x;
      if (!x.immersion_start && !x.immersion_end && !x.reaction_end && !x.withdrawal_end
          && x.status !== "DIPPING") return x;
      return {
        ...x,
        immersion_start: null,
        immersion_end:   null,
        reaction_end:    null,
        withdrawal_end:  null,
        immersion_duration: null,
        reaction_duration: null,
        withdrawal_duration: null,
        dipping_at:      null,
        dipped_by:       null,
        dipped_by_name:  null,
        bath_temperature: null,
        dipping_operator: null,
        shift_supervisor: null,
        surface_condition: null,
        status: (x.status === "DIPPING") ? "LOADED" : x.status,
      };
    }));
  };

  const clearDippingDrafts = (beamTxn?: string) => {
    try {
      const uid = user?.id;
      if (!uid) return;
      const fields = ["bathTemp","operatorName","shiftSupName","manImm","manReact","manWith","surfaceCond"];
      // Legacy global keys
      ["dip:bathTemp","dip:operatorName","dip:shiftSupName","dip:manImm","dip:manReact","dip:manWith","dip:surfaceCond"]
        .forEach(k => clearDraft(uid, k));
      // Per-beam keys for the supplied beam (or current selection)
      const t = beamTxn ?? sel;
      if (t) fields.forEach(f => clearDraft(uid, `dip:${t}:${f}`));
    } catch {}
  };

  // Auto-rehydrate an in-progress dipping session owned by the current user
  // (e.g. after refresh, phone call, or device handoff). Picks the most
  // recently started DIPPING beam that has immersion_start but not yet a
  // completed save (withdrawal_end null OR still in DIPPING status).
  useEffect(() => {
    if (sel || tsImmStart) return;
    const mine = beams
      .filter((b:any) =>
        b.status === "DIPPING"
        && b.immersion_start
        && (!b.withdrawal_end)
        && (!b.dipped_by || b.dipped_by === user.id)
        && !isDoubleType(b) // double-batch in-progress is part-managed; leave manual
        && !isRecentlyReset(txn(b)))
      .sort((a:any,b:any) =>
        new Date(b.immersion_start).getTime() - new Date(a.immersion_start).getTime());
    const active = mine[0];
    if (!active) return;
    ss(txn(active));
    setIS(active.immersion_start || null);
    setIE(active.immersion_end || null);
    setRE(active.reaction_end || null);
    setWE(active.withdrawal_end || null);
    if (active.bath_temperature != null && bathTemp === "") {
      setBathTemp(String(active.bath_temperature));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beams, user?.id]);

  const dippedBeams=beams.filter(b=>["DIPPING","QC_PENDING","COMPLETED"].includes(b.status)).slice().sort((a,b)=>new Date(b.dipped_at||b.loaded_at)-new Date(a.dipped_at||a.loaded_at));

  // ── Smart Coating Recommendation ───────────────────────────
  // Picks the historical PASS beam whose avg coating is closest to required,
  // gated by exact Thickness/Load/Coating + bucketed Weight/Temp/Qty match.
  // Pure logic lives in ./recommendation.ts so it can be unit-tested.
  const recommendation = useMemo(
    () => {
      // Surface Condition is captured live during Dipping (stored on the beam
      // only after Save). Feed the operator's current selection into the
      // engine so history filters against what they've picked right now.
      const eff = beam
        ? { ...beam, surface_condition: beam.surface_condition ?? (surfaceCond || null) }
        : beam;
      return computeRecommendation({ beam: eff, beams, bathTemp, dc, mlrModel, mlrTrainedAt, lgbmModel, lgbmTrainedAt, xgbModel, xgbTrainedAt, catModel, catTrainedAt, zcModel, zcTrainedAt, aiModel, refIndex: selectedTopIdx });
    },
    [beam, beams, bathTemp, dc, surfaceCond, selectedTopIdx, mlrModel, mlrTrainedAt, lgbmModel, lgbmTrainedAt, xgbModel, xgbTrainedAt, catModel, catTrainedAt, zcModel, zcTrainedAt, aiModel],

  );

  function applyRecommendation(ref){
    const r = ref || recommendation?.best;
    if(!r) return;
    const fmtSec=(s)=>{const v=Math.max(0,Number(s)||0);return `${String(Math.floor(v/60)).padStart(2,"0")}:${String(v%60).padStart(2,"0")}`;};
    if(manualMode){
      setManImm(fmtSec(r.immersion_duration));
      setManReact(fmtSec(r.reaction_duration));
      setManWith(fmtSec(r.withdrawal_duration));
    } else {
      if(!tsImmStart) return;
      const start=new Date(tsImmStart).getTime();
      setIE(new Date(start + (r.immersion_duration||0)*1000).toISOString());
      setRE(new Date(start + ((r.immersion_duration||0)+(r.reaction_duration||0))*1000).toISOString());
      setWE(new Date(start + ((r.immersion_duration||0)+(r.reaction_duration||0)+(r.withdrawal_duration||0))*1000).toISOString());
    }
    if(r.bath_temperature!=null && bathTemp==="") setBathTemp(String(r.bath_temperature));
  }




  // ── Live stopwatch (ticks every second via `live` state) ───
  const liveImm    = tsImmStart && !tsImmEnd   ? calcSecs(tsImmStart, live) : null;
  const liveReact  = tsImmEnd   && !tsReactEnd ? calcSecs(tsImmEnd,   live) : null;
  const liveWith   = tsReactEnd && !tsWithEnd  ? calcSecs(tsReactEnd, live) : null;
  const liveTotal  = tsImmStart && !tsWithEnd  ? calcSecs(tsImmStart, live) : null;

  // ── Duration calculations (each phase is independent) ───────
  const immDur    = calcSecs(tsImmStart, tsImmEnd);    // immersion start → immersion end
  const reactDur  = calcSecs(tsImmEnd,   tsReactEnd);  // immersion end   → reaction end
  const withdDur  = calcSecs(tsReactEnd, tsWithEnd);   // reaction end    → withdrawal end
  const totalDur  = calcSecs(tsImmStart, tsWithEnd);   // full process

  // Elapsed from start (for display on each box)
  const elapsedToImmEnd  = calcSecs(tsImmStart, tsImmEnd);
  const elapsedToReact   = calcSecs(tsImmStart, tsReactEnd);
  const elapsedToWithd   = calcSecs(tsImmStart, tsWithEnd);

  function captureNow(setter){
    if(!surfaceCond){
      sm({ok:false,text:"⚠ Select Material Surface Condition first — mandatory before Dipping entry"});
      return;
    }
    if(bathTemp==="" || isNaN(parseFloat(bathTemp))){
      sm({ok:false,text:"⚠ Enter Zinc Bath Temperature first — mandatory before Dipping entry"});
      const el=document.getElementById("bath_temp"); if(el){el.focus();el.scrollIntoView({behavior:"smooth",block:"center"});}
      return;
    }
    setter(nowISO());
  }

  function resetForm(opts?: { abortServer?: boolean }){
    const shouldAbort = opts?.abortServer !== false;
    if (shouldAbort && sel) abortBeamPhases(sel);
    ss(""); setIS(null); setIE(null); setRE(null); setWE(null);
    setDbl({selectedParts:[],nextBeamNo:"",nextSelectedParts:[]});
    setBathTemp("");
    setOperatorName("");
    setShiftSupName("");
    setSurfaceCond("");
    setManImm(""); setManReact(""); setManWith("");
    clearDippingDrafts();
    sm(null);
  }

  // Sequence validation (live-timer mode only)
  const seqErrors=[];
  if(!manualMode){
    if(tsImmStart&&tsImmEnd&&new Date(tsImmEnd)<new Date(tsImmStart))  seqErrors.push("Immersion End must be after Immersion Start");
    if(tsImmEnd  &&tsReactEnd&&new Date(tsReactEnd)<new Date(tsImmEnd))seqErrors.push("Reaction End must be after Immersion End");
    if(tsReactEnd&&tsWithEnd &&new Date(tsWithEnd)<new Date(tsReactEnd))seqErrors.push("Withdrawal End must be after Reaction End");
  }

  function save(){
    if (savingRef.current) return; // guard double-tap
    const fail = (text: string) => { sm({ok:false,text}); toast.error(text.replace(/^⚠\s*/,"")); };
    if(!sel||!beam){fail("⚠ Select a beam first");return;}
    if(bathTemp==="" || isNaN(parseFloat(bathTemp))){fail("⚠ Zinc Bath Temperature is mandatory before saving Dipping record");return;}
    if(activeOperators.length>0 && !operatorName){fail("⚠ Select the Dipping Operator on the floor");return;}
    if(!surfaceCond){fail("⚠ Select Material Surface Condition before saving");return;}

    // Derive timestamps from manual durations (anchor at "now"), or use live-captured timestamps.
    let _immStart=tsImmStart, _immEnd=tsImmEnd, _reactEnd=tsReactEnd, _withEnd=tsWithEnd;
    let _immDur=immDur, _reactDur=reactDur, _withDur=withdDur, _totalDur=totalDur;
    if(manualMode){
      if(vImm.error)  {fail("⚠ "+vImm.error);return;}
      if(vReact.error){fail("⚠ "+vReact.error);return;}
      if(vWith.error) {fail("⚠ "+vWith.error);return;}
      if(manTotalError){fail("⚠ "+manTotalError);return;}
      const anchor = Date.now();
      _immStart = new Date(anchor).toISOString();
      _immEnd   = new Date(anchor + manImmSec!*1000).toISOString();
      _reactEnd = new Date(anchor + (manImmSec!+manReactSec!)*1000).toISOString();
      _withEnd  = new Date(anchor + (manImmSec!+manReactSec!+manWithSec!)*1000).toISOString();
      _immDur=manImmSec!; _reactDur=manReactSec!; _withDur=manWithSec!;
      _totalDur=manImmSec!+manReactSec!+manWithSec!;
    } else {
      if(!tsImmStart||!tsImmEnd||!tsReactEnd||!tsWithEnd){
        const missing=[];
        if(!tsImmStart)missing.push("Immersion Start");
        if(!tsImmEnd)  missing.push("Immersion End");
        if(!tsReactEnd)missing.push("Reaction End");
        if(!tsWithEnd) missing.push("Withdrawal End");
        fail("⚠ Missing: "+missing.join(", "));return;
      }
      if(seqErrors.length>0){fail("⚠ "+seqErrors[0]);return;}
    }
    const nb=dbl.nextBeamNo.trim();
    // Same beam_no may now exist in multiple loading cycles. Pick the latest
    // load that is still available for dipping (LOADED, or DIPPING with parts
    // remaining), and address it via its transaction_id.
    const findLatestAvailable = (bno) => {
      if (!bno) return null;
      return beams
        .filter(x => x.beam_no === bno && (x.status === "LOADED" || (x.status === "DIPPING" && hasRemaining(x))))
        .sort((a,b) => new Date(b.loaded_at||0).getTime() - new Date(a.loaded_at||0).getTime())[0] || null;
    };
    const nbObj = findLatestAvailable(nb);
    if(isSpecial&&nb&&!nbObj){fail(`⚠ Beam "${nb}" has no available loading cycle in the Loading register`);return;}
    const nbTxn = nbObj ? txn(nbObj) : null;

    const tempNum = bathTemp!=="" && !isNaN(parseFloat(bathTemp)) ? parseFloat(bathTemp) : null;
    const baseDip={
      immersion_start:_immStart, immersion_end:_immEnd, immersion_duration:_immDur,
      reaction_end:_reactEnd,    reaction_duration:_reactDur,
      withdrawal_end:_withEnd,   withdrawal_duration:_withDur,
      bath_temperature:tempNum,
      dipped_by:user.id, dipped_by_name:user.full_name, dipped_at:_withEnd,
      dipping_operator: operatorName || null,
      shift_supervisor: shiftSupName || null,
      surface_condition: surfaceCond || null,
      entry_mode: manualMode ? "manual" : "timer",
      // Snapshot the AI prediction so it can be validated against the actual
      // dipping time and the inspected coating later.
      ai_prediction: buildPredictionSnapshot(recommendation, { bathTemp: tempNum, surface: surfaceCond || null }),
    };
    savingRef.current = true; savedRef.current = true;

    // Applies one dipping pass to a beam, with split-batch tracking for Double Batch.
    const applyDipToBeam=(b,selectedParts)=>{
      if(!isDoubleType(b)){
        return {...b,...baseDip,status:"QC_PENDING",dipped_parts:null};
      }
      const all=partList(b);
      const prior=b.dipping_history||[];
      const partsThisRun=selectedParts.length?selectedParts:all; // empty selection = all parts
      const entry={...baseDip,parts:partsThisRun};
      const history=[...prior,entry];
      const dippedAll=new Set();
      history.forEach(h=>(h.parts||[]).forEach(p=>dippedAll.add(p)));
      const fullyDone=all.length===0||all.every(p=>dippedAll.has(p));
      return {
        ...b,
        ...baseDip,                                  // latest pass overwrites top-level
        dipping_history:history,
        dipped_parts:Array.from(dippedAll).join(", ")||null,
        status:fullyDone?"QC_PENDING":"DIPPING",
      };
    };

    setBeams(prev=>{
      let next=[...prev];
      next=next.map(b=>txn(b)===sel?applyDipToBeam(b,dbl.selectedParts):b);
      if(isSpecial&&nbTxn&&next.find(b=>txn(b)===nbTxn)){
        next=next.map(b=>txn(b)===nbTxn?applyDipToBeam(b,dbl.nextSelectedParts):b);
      }
      return next;
    });
    addAudit(user.id,user.full_name,"DIPPING","dipping",`${sel}${isSpecial&&nbTxn?" + "+nbTxn:""} — ${manualMode?"MANUAL ":""}Imm:${fmtDur(_immDur)} React:${fmtDur(_reactDur)} Withd:${fmtDur(_withDur)} Total:${fmtDur(_totalDur)}${tempNum!=null?` @ ${tempNum}°C`:""}`);
    const syncing = pendingCountForTable("beams") > 0;
    const okMsg = `✅ Dipping saved${isSpecial&&nbTxn?" for 2 beams":""}${isSpecial?" — split tracked":" — Coating Pending"}${syncing?" · syncing…":""}`;
    sm({ok:true,text:okMsg});
    toast.success(`Dipping saved — status: Coating Pending${syncing?" (syncing…)":""}`);

    // Post-save: confirm the write actually flushed within 10s; otherwise warn.
    const startedAt = Date.now();
    let syncErrSeen = false;
    const onErr = (ev: any) => {
      if (ev?.detail?.table === "beams") syncErrSeen = true;
    };
    if (typeof window !== "undefined") {
      window.addEventListener("hdp:sync-error", onErr as any);
    }
    const checkSync = () => {
      const pend = (() => { try { return pendingCountForTable("beams"); } catch { return 0; } })();
      if (syncErrSeen || pend > 0) {
        if (Date.now() - startedAt > 10_000) {
          toast.error("Dipping save not yet synced — will retry automatically when online");
          if (typeof window !== "undefined") {
            window.removeEventListener("hdp:sync-error", onErr as any);
          }
          return;
        }
        setTimeout(checkSync, 1_000);
      } else {
        if (typeof window !== "undefined") {
          window.removeEventListener("hdp:sync-error", onErr as any);
        }
      }
    };
    setTimeout(checkSync, 1_500);

    clearDippingDrafts(sel);
    resetForm({ abortServer: false });
    setTimeout(()=>{ savingRef.current = false; savedRef.current = false; sm(null); },6000);
  }

  const beamParts=partList(beam);
  // For display only — pick the latest available loading cycle for the typed beam_no.
  const nextBeamObj=dbl.nextBeamNo
    ? (beams.filter(b=>b.beam_no===dbl.nextBeamNo.trim() && (b.status==="LOADED" || (b.status==="DIPPING" && hasRemaining(b))))
        .sort((a,b)=>new Date(b.loaded_at||0).getTime()-new Date(a.loaded_at||0).getTime())[0] || null)
    : null;
  const nextBeamParts=nextBeamObj?remainingParts(nextBeamObj):[];
  const nextBeamAlreadyDipped=nextBeamObj?Array.from(dippedSet(nextBeamObj)):[];

  // ── Timestamp box component ───────────────────────────────
  function TsBox({label,step,hint,value,setter,dependsOn,elapsedFromStart,phaseDur,phaseLabel,col,liveTicker}){
    const captured=!!value;
    const locked = dependsOn!==undefined && !dependsOn && !captured;
    const ticking=!captured&&!locked&&liveTicker!=null;
    return <div style={{background:captured?"#0A1E0E":(locked?"#0A0F1A":(ticking?"#0C1A22":"#16202B")),
      border:`2px solid ${captured?col:(locked?"#33434F":(ticking?col+"80":"#33434F"))}`,borderRadius:12,
      overflow:"hidden",transition:"all .25s",opacity:locked?0.55:1,
      boxShadow:captured?`0 0 18px ${col}25`:(ticking?`0 0 14px ${col}30`:"none")}}>
      {/* Step header */}
      <div style={{padding:"10px 14px",borderBottom:`1px solid ${captured?col+"40":"#33434F"}`,
        display:"flex",alignItems:"center",gap:8,
        background:captured?"rgba(0,0,0,.2)":"transparent"}}>
        <div style={{width:26,height:26,borderRadius:"50%",flexShrink:0,fontWeight:900,fontSize:12,
          display:"flex",alignItems:"center",justifyContent:"center",
          background:captured?col:(ticking?col+"40":"#33434F"),color:captured?"#000":(ticking?col:"#3A4F70")}}>{locked?"🔒":step}</div>
        <div>
          <div style={{fontSize:11,fontWeight:700,color:captured?col:"#8DA0AD",textTransform:"uppercase",letterSpacing:".05em"}}>{label}</div>
          <div style={{fontSize:9,color:"#5C7482",marginTop:1}}>{hint}</div>
        </div>
      </div>
      {/* Time display */}
      <div style={{padding:"12px 14px"}}>
        <div style={{fontFamily:"monospace",fontSize:captured?17:13,
          color:captured?col:"#3A4F70",fontWeight:captured?800:400,marginBottom:8,lineHeight:1.2}}>
          {captured?fmt12(value):(locked?"🔒 Complete previous step first":"— Waiting for capture —")}
        </div>
        {/* Live stopwatch ticker for the active phase */}
        {ticking&&<div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,
          padding:"7px 10px",background:`${col}15`,border:`1px dashed ${col}60`,borderRadius:6}}>
          <span style={{width:7,height:7,borderRadius:"50%",background:col,boxShadow:`0 0 8px ${col}`,animation:"pulse 1.2s infinite"}}/>
          <span style={{fontSize:9,color:col,fontWeight:700,letterSpacing:".06em"}}>LIVE</span>
          <span style={{fontFamily:"monospace",fontSize:15,color:col,fontWeight:800,marginLeft:"auto"}}>{fmtDur(liveTicker)}</span>
        </div>}
        {/* Phase duration */}
        {phaseDur!=null&&<div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,
          padding:"5px 8px",background:"rgba(0,0,0,.25)",borderRadius:5}}>
          <span style={{fontSize:9,color:"#3A4F70",fontWeight:700}}>{phaseLabel}:</span>
          <span style={{fontFamily:"monospace",fontSize:12,color:"#22D3EE",fontWeight:700}}>{fmtDur(phaseDur)}</span>
        </div>}
        {/* Elapsed from start */}
        {elapsedFromStart!=null&&tsImmStart&&<div style={{fontSize:9,color:"#5C7482",marginBottom:8}}>
          ⏱ {fmtDur(elapsedFromStart)} from immersion start
        </div>}
        {/* Capture button */}
        <div style={{display:"flex",gap:6}}>
          <button disabled={locked}
            onClick={()=>{ if(locked){ sm({ok:false,text:`⚠ Complete previous step before "${label}"`}); return; } captureNow(setter); }}
            title={locked?"Complete previous step first":""}
            style={{
            flex:1,padding:"9px 0",borderRadius:7,border:"none",
            cursor:locked?"not-allowed":"pointer",fontFamily:"inherit",fontSize:12,fontWeight:800,letterSpacing:".04em",
            background:locked?"#33434F":(captured?`${col}20`:`linear-gradient(135deg,${col},${col}AA)`),
            color:locked?"#3A4F70":(captured?col:"#000"),
            boxShadow:captured||locked?"none":`0 3px 10px ${col}40`}}>
            {locked?"🔒 LOCKED":(captured?"⟳  Re-Capture Now":"⏱  CAPTURE NOW")}
          </button>
          {captured && <button onClick={()=>{ if(confirm(`Clear captured time for "${label}"?`)) setter(null); }}
            title="Reset this step (clear accidental capture)"
            style={{width:38,borderRadius:7,border:`1px solid ${T?.border||"#33434F"}`,background:"transparent",color:"#FB7185",cursor:"pointer",fontSize:14,fontWeight:800}}>✕</button>}
        </div>
        {/* Manual time entry */}
        <div style={{marginTop:8,display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:9,color:"#3A4F70",fontWeight:700,letterSpacing:".05em"}}>✎ MANUAL:</span>
          <input
            type="datetime-local"
            step="1"
            disabled={locked}
            value={value? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,19) : ""}
            onChange={e=>{
              if(locked){ sm({ok:false,text:`⚠ Complete previous step before "${label}"`}); return; }
              const v = e.target.value;
              if(!v){ setter(null); return; }
              if(!surfaceCond){
                sm({ok:false,text:"⚠ Select Material Surface Condition first — mandatory before Dipping entry"});
                return;
              }
              if(bathTemp==="" || isNaN(parseFloat(bathTemp))){
                sm({ok:false,text:"⚠ Enter Zinc Bath Temperature first — mandatory before Dipping entry"});
                return;
              }
              setter(new Date(v).toISOString());
            }}
            style={{flex:1,background:"#16202B",border:`1px solid ${locked?"#33434F":col+"40"}`,color:locked?"#3A4F70":col,
              padding:"4px 6px",borderRadius:5,fontSize:10,fontFamily:"monospace",cursor:locked?"not-allowed":"text"}}
          />
        </div>
      </div>
    </div>;
  }

  return <div>
    {beam && needsCoatingAck && coatingReqInfo && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.82)",zIndex:2500,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#0C1420",border:"1px solid #17405C",borderRadius:12,padding:22,width:"min(460px,96vw)",boxShadow:"0 20px 60px rgba(0,0,0,.6)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
          <div style={{width:38,height:38,borderRadius:9,background:"linear-gradient(135deg,#FB923C,#C2410C)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⚠</div>
          <div>
            <div style={{fontSize:14,fontWeight:800,color:"#C9D6DF",letterSpacing:".05em"}}>COATING REQUIREMENT</div>
            <div style={{fontSize:11,color:"#8DA0AD"}}>Beam {beam.beam_no} — auto-detected from admin configuration</div>
          </div>
        </div>
        <div style={{display:"grid",gap:8}}>
          <div style={{background:"#0A101A",border:"1px solid #17293D",borderRadius:8,padding:"10px 12px"}}>
            <div style={{fontSize:10,color:"#8DA0AD",fontWeight:700}}>PART NUMBER{coatingReqInfo.parts.length>1?"S":""} / PREFIX</div>
            <div style={{fontFamily:"monospace",fontSize:13,fontWeight:800,color:"#5BA3FF",marginTop:3}}>
              {coatingReqInfo.parts.length?coatingReqInfo.parts.join(", "):"—"}
              {coatingReqInfo.prefix && <span style={{color:"#FBBF24",marginLeft:8}}>· prefix {coatingReqInfo.prefix}</span>}
            </div>
            <div style={{fontSize:10,color:"#3A4F70",marginTop:3}}>Thickness {coatingReqInfo.thicknessMm!=null?`${coatingReqInfo.thicknessMm} mm`:(beam.section||"—")}</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <div style={{background:"#0A101A",border:"1px solid #17293D",borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontSize:10,color:"#8DA0AD",fontWeight:700}}>REQUIRED AVERAGE COATING</div>
              <div style={{fontSize:20,fontWeight:900,color:"#4ADE80",marginTop:3}}>{coatingReqInfo.required!=null?`${coatingReqInfo.required} μm`:"—"}</div>
            </div>
            <div style={{background:"#0A101A",border:"1px solid #17293D",borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontSize:10,color:"#8DA0AD",fontWeight:700}}>LOCAL COATING REQUIREMENT</div>
              <div style={{fontSize:20,fontWeight:900,color:coatingReqInfo.local!=null?"#FBBF24":"#3A4F70",marginTop:3}}>{coatingReqInfo.local!=null?`${coatingReqInfo.local} μm`:"—"}</div>
            </div>
          </div>
        </div>

        <div style={{marginTop:16,display:"flex",justifyContent:"flex-end"}}>
          <Btn onClick={()=>setAckedTxns(prev=>({...prev,[txn(beam)]:true}))}>Acknowledge &amp; Continue</Btn>
        </div>
      </div>
    </div>}

    {readOnly&&<div style={{padding:"10px 16px",background:"#1A0E00",border:"1px solid #3A2A00",borderRadius:8,marginBottom:14,display:"flex",alignItems:"center",gap:10,fontSize:12,color:"#FB923C"}}><span style={{fontSize:16}}>👁</span><strong>SUPERVISOR VIEW — READ ONLY</strong><span style={{color:"#4A3A00",marginLeft:4}}>You can see all dipping records. Contact Dipping Supervisor to add records.</span></div>}
    {/* Header */}
    <div style={{background:"linear-gradient(135deg,#0A1A1F,#0D2030)",border:"1px solid #0E3A52",
      borderRadius:10,padding:"16px 22px",marginBottom:16,
      display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
      <div style={{display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:48,height:48,borderRadius:10,background:"linear-gradient(135deg,#FB923C,#C2410C)",
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,
          boxShadow:"0 0 20px rgba(251,146,60,.4)"}}>🛢</div>
        <div>
          <div style={{fontSize:15,fontWeight:800,color:"#C9D6DF",letterSpacing:".06em"}}>DIPPING STATION</div>
          <div style={{fontSize:11,color:"#8DA0AD",marginTop:2}}>Zinc Bath — 4-Stage Timestamp Recording</div>
          <div style={{fontSize:10,color:"#3A4F70",marginTop:2}}>
            Immersion Start → Immersion End → Reaction End → Withdrawal End
          </div>
        </div>
      </div>
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
        <div style={{fontFamily:"monospace",fontSize:14,color:"#FB923C",fontWeight:800,
          background:"rgba(251,146,60,.1)",border:"1px solid #FB923C40",borderRadius:8,padding:"8px 16px"}}>
          LIVE: {fmt12(live)}
        </div>
        {[["AWAITING",available.length,"#5BA3FF"],["DIPPED",dippedBeams.length,"#FB923C"],
          ["COATING PENDING",beams.filter(b=>b.status==="QC_PENDING").length,"#FDE047"],
          ["DONE",beams.filter(b=>b.status==="COMPLETED").length,"#4ADE80"]].map(([l,v,col])=>(
          <div key={l} style={{textAlign:"center",background:"rgba(0,0,0,.3)",border:`1px solid ${col}30`,
            borderRadius:8,padding:"8px 12px",minWidth:64}}>
            <div style={{fontSize:18,fontWeight:900,color:col,fontFamily:"monospace",lineHeight:1}}>{v}</div>
            <div style={{fontSize:9,color:"#8DA0AD",marginTop:2,fontWeight:700}}>{l}</div>
          </div>
        ))}
      </div>
    </div>

    {/* Process guide strip */}
    <div style={{background:"#16202B",border:"1px solid #33434F",borderRadius:8,
      padding:"10px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:0,overflowX:"auto"}}>
      {[
        ["1","IMMERSION START","Beam enters zinc bath","#3D7EA6",!!tsImmStart],
        ["2","IMMERSION END","Beam fully submerged","#5BA3FF",!!tsImmEnd],
        ["3","REACTION END","Zinc reaction complete","#22D3EE",!!tsReactEnd],
        ["4","WITHDRAWAL END","Beam lifted out of bath","#4ADE80",!!tsWithEnd],
      ].map(([n,lbl,hint,col,done],i)=>(
        <div key={n} style={{display:"flex",alignItems:"center",gap:0,flex:1,minWidth:120}}>
          <div style={{textAlign:"center",flex:1}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:4}}>
              <div style={{width:22,height:22,borderRadius:"50%",fontWeight:900,fontSize:11,
                display:"flex",alignItems:"center",justifyContent:"center",
                background:done?col:"#33434F",color:done?"#000":"#3A4F70"}}>
                {done?"✓":n}
              </div>
              <span style={{fontSize:10,fontWeight:700,color:done?col:"#3A4F70",letterSpacing:".04em"}}>{lbl}</span>
            </div>
            <div style={{fontSize:9,color:"#5C7482"}}>{hint}</div>
          </div>
          {i<3&&<div style={{width:30,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <span style={{color:done?"#4ADE80":"#33434F",fontSize:20,fontWeight:900}}>›</span>
          </div>}
        </div>
      ))}
    </div>

    {/* Main form card */}
    <div style={{display:readOnly?"none":"block"}}><div style={{background:"#1E2A36",border:`2px solid ${beam?"#FB923C30":"#33434F"}`,
      borderRadius:12,marginBottom:18,overflow:"hidden"}}>
      <div style={{background:"linear-gradient(90deg,#0A1220,#1E2A36)",borderBottom:"1px solid #33434F",
        padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:beam?"#FB923C":"#33434F",
            boxShadow:beam?"0 0 8px #FB923C":"none"}}/>
          <span style={{fontSize:13,fontWeight:700,color:"#C9D6DF"}}>DIPPING PROCESS RECORDER</span>
          {isSpecial&&<span style={{fontSize:10,color:"#FB923C",background:"#2A1600",
            padding:"2px 8px",borderRadius:4,fontWeight:700,border:"1px solid #4A2A00"}}>
            ⚡ {beam.load_type.toUpperCase()} — DUAL ENTRY MODE
          </span>}
        </div>
      </div>

      <div style={{padding:20}}>
        {/* Beam selector */}
        <div style={{marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,gap:8,flexWrap:"wrap"}}>
            <label style={{fontSize:11,color:"#8DA0AD",fontWeight:700,letterSpacing:".08em",textTransform:"uppercase"}}>
              Select Beam for Dipping <span style={{color:"#3D7EA6"}}>*</span>
              <span style={{fontSize:9,fontWeight:400,color:"#3A4F70",marginLeft:8}}>({available.length} awaiting dip)</span>
            </label>
            {!readOnly && <button type="button" onClick={()=>setShowRegister(true)} style={{
              padding:"6px 12px",fontSize:11,fontWeight:700,borderRadius:6,cursor:"pointer",
              background:"linear-gradient(135deg,#5BA3FF,#1D6FE8)",color:"#000",border:"none"}}>
              ＋ REGISTER NEW BEAM
            </button>}
          </div>
          <DSel dark value={sel} onChange={e=>{
            const next = e.target.value;
            const prev = sel;
            if (prev && prev !== next) {
              // Warn before silently discarding captured timestamps so the
              // operator never loses an in-progress dipping session by
              // mistakenly switching beams.
              const hasCaptures = !!(tsImmStart || tsImmEnd || tsReactEnd || tsWithEnd
                || bathTemp || dbl.selectedParts.length);
              if (hasCaptures) {
                const prevBeam = beams.find((b:any)=>txn(b)===prev);
                const label = prevBeam?.beam_no || prev;
                const ok = window.confirm(
                  `Discard captured data for beam ${label} and switch?\n\nUnsaved timestamps, bath temperature, and part selection will be cleared.`
                );
                if (!ok) return;
              }
              abortBeamPhases(prev);
              clearDippingDrafts(prev);
            }
            // Reset local state so stale values from the previous beam don't
            // bleed through during the render that swaps `sel`. The per-beam
            // `useDraft` restore effect fires AFTER this commit and rehydrates
            // any auto-saved entries for the newly selected beam — so we must
            // NOT wipe the next beam's draft here.
            ss(next);
            setIS(null); setIE(null); setRE(null); setWE(null);
            setDbl({selectedParts:[],nextBeamNo:"",nextSelectedParts:[]});
            setBathTemp(""); setOperatorName(""); setShiftSupName(""); setSurfaceCond("");
            setManImm(""); setManReact(""); setManWith("");
          }}>
            <option value="">— Select Beam Awaiting Dipping —</option>
            {available.map(b=><option key={txn(b)} value={txn(b)}>
              {b.beam_no}  |  {b.load_type}  |  {b.part_nos}  |  {b.coating_required}μm  |  {b.total_weight}MT
            </option>)}
          </DSel>
        </div>


        {/* Auto-fetched info */}
        {beam&&<div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,
          padding:14,background:"#060E18",border:"1px solid #0E2A40",borderRadius:10,marginBottom:18}}>
          {[["Beam No",beam.beam_no,"#3D7EA6"],["Load Type",beam.load_type,"#FB923C"],
            ["Part No(s)",beam.part_nos,"#5BA3FF"],["Thickness",beam.section||"—","#8DA0AD"],
            ["Weight",beam.total_weight+" MT","#22D3EE"],["Length",beam.length_mm?beam.length_mm+" mm":"—","#FDE047"],
            ["Coating",beam.coating_required+" μm","#A78BFA"],
            ["Date Loaded",fmtDate(beam.loaded_at),"#8DA0AD"],["Shift",beam.shift?.split(" ")[0]||"—","#FDE047"]
          ].map(([k,v,col])=>(
            <div key={k} style={{padding:"8px 10px",background:"#0A1520",borderRadius:6,border:"1px solid #33434F"}}>
              <div style={{fontSize:9,color:"#5C7482",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4}}>{k}</div>
              <div style={{fontSize:12,color:col,fontWeight:700,fontFamily:"monospace",wordBreak:"break-all"}}>{v||"—"}</div>
            </div>
          ))}
        </div>}

        {/* ── TIME ENTRY MODE SWITCH (when admin allows Both) ─────── */}
        {beam && timeMode === "both" && (
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"#16202B",border:"1px solid #33434F",borderRadius:8,marginBottom:14}}>
            <span style={{fontSize:11,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase"}}>Time Entry:</span>
            {[
              {k:false,lbl:"⏱ Live Timer",col:"#4ADE80"},
              {k:true, lbl:"✍ Manual MM:SS",col:"#FB923C"},
            ].map(opt=>{
              const on = userManualPref === opt.k;
              return <button key={String(opt.k)} type="button" onClick={()=>{
                setUserManualPref(opt.k);
                setIS(null);setIE(null);setRE(null);setWE(null);
                setManImm("");setManReact("");setManWith("");
              }} style={{padding:"6px 14px",borderRadius:6,cursor:"pointer",fontSize:11,fontWeight:800,
                background:on?opt.col:"#0A1520",color:on?"#000":opt.col,border:`1px solid ${opt.col}`,fontFamily:"inherit"}}>{opt.lbl}</button>;
            })}
            <span style={{marginLeft:"auto",fontSize:10,color:"#3A4F70"}}>Admin has enabled both — pick how to record this dip.</span>
          </div>
        )}

        {/* ── SMART COATING RECOMMENDATION (Top-N) ─────────────── */}
        {beam&&recommendation?.disabled&&(
          <div style={{padding:"10px 14px",background:"#1A0A0A",border:"1px dashed #441010",borderRadius:8,marginBottom:16,fontSize:11,color:"#F87171"}}>
            🧠 AI recommendation engine is currently <strong>disabled</strong> by admin.
          </div>
        )}
        {beam&&recommendation?.needTemp&&(
          <div style={{padding:"12px 14px",background:"#1A0E00",border:"1px dashed #FB923C",borderRadius:8,marginBottom:16,fontSize:12,color:"#FB923C",fontWeight:700}}>
            🌡 Enter Zinc Bath Temperature below to fetch exact-match best coating results.
          </div>
        )}
        {beam&&recommendation?.needSurface&&(
          <div style={{padding:"12px 14px",background:"#1A0E00",border:"1px dashed #F0ABFC",borderRadius:8,marginBottom:16,fontSize:12,color:"#F0ABFC",fontWeight:700}}>
            🧱 Select Material Surface Condition (Normal / Rusted / Heavy Rusted) below to fetch exact-match best coating results.
          </div>
        )}
        {/* ── AI INSIGHTS — Total Dipping Time Prediction (Dipping) ───────────────── */}
        {beam && recommendation && (recommendation.mlr || recommendation.exactMatch) && (() => {
          const blocks:any[] = (recommendation.aiBlocks && recommendation.aiBlocks.length)
            ? recommendation.aiBlocks
            : (recommendation.mlr ? [recommendation.mlr] : []);
          if(!blocks.length) return null;
          const primary = blocks[0];
          const isReg = !!recommendation.regression;
          const isClosest = !isReg && recommendation.recommendationType === "closest";
          const label = isReg ? "AI PREDICTION" : isClosest ? "CLOSEST MATCH (2× TOL)" : "EXACT MATCH";
          const badgeBg = isReg ? "#FB923C" : isClosest ? "#FBBF24" : "#4ADE80";
          const anyModel = blocks.some((b:any)=>b?.hasModel);
          const border = anyModel ? badgeBg : "#F87171";
          const refBeam = !isReg ? recommendation.best : null;
          const refSec = refBeam
            ? (Number(refBeam.immersion_duration)||0)+(Number(refBeam.reaction_duration)||0)+(Number(refBeam.withdrawal_duration)||0)
            : null;
          const total = primary.predictedSec;
          const ref = primary?.hasModel ? {
            beam_no: "AI",
            immersion_duration: Math.max(1,Math.round(total*0.72)),
            reaction_duration: Math.max(0,Math.round(total*0.08)),
            withdrawal_duration: Math.max(0,total-Math.max(1,Math.round(total*0.72))-Math.max(0,Math.round(total*0.08))),
            bath_temperature: Number(bathTemp)||null,
          } : null;
          const applyDisabled = !ref || (!manualMode && !tsImmStart);
          return (
            <div style={{padding:"14px 16px",background:"linear-gradient(90deg,#1A0E00,#0A1422)",border:`1px solid ${border}80`,borderRadius:10,marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                <span style={{fontSize:10,fontWeight:900,color:"#C9D6DF",letterSpacing:".1em"}}>🧠 AI INSIGHTS</span>
                <span style={{fontSize:10,fontWeight:900,color:"#000",background:badgeBg,padding:"2px 7px",borderRadius:3,letterSpacing:".06em"}}>{label}</span>
                <span style={{fontSize:10,color:"#8AA3C0",fontFamily:"monospace"}}>Model: {blocks.map((b:any)=>b.modelLabel||"MLR").join(" + ")}</span>
                {ref && (
                  <button type="button" onClick={()=>applyRecommendation(ref)} disabled={applyDisabled}
                    title={applyDisabled?"Capture Immersion Start (or enable manual mode) and train the AI model first":"Apply predicted total dipping time"}
                    style={{marginLeft:"auto",padding:"4px 9px",borderRadius:4,border:`1px solid ${applyDisabled?"#4A3A20":"#FB923C"}`,background:applyDisabled?"#0A1520":"#2A1408",color:applyDisabled?"#4A3A20":"#FB923C",cursor:applyDisabled?"not-allowed":"pointer",fontSize:10,fontWeight:800,fontFamily:"inherit"}}>
                    ⚡ APPLY
                  </button>
                )}
              </div>
              {refBeam && (
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:6,marginBottom:10}}>
                  {[
                    ["Reference Beam",String(refBeam.beam_no??"—"),"#5BA3FF"],
                    ["Historical Total Time",`${fmtMMSS(refSec||0)} (${Math.round(refSec||0)}s)`,"#5BA3FF"],
                    ["Historical Avg Coating",`${Number(refBeam.avg_reading||0).toFixed(2)} µm`,"#A78BFA"],
                  ].map(([k,v,col])=>(
                    <div key={k as string} style={{padding:"5px 7px",background:"#0A1520",borderRadius:4,border:"1px solid #33434F"}}>
                      <div style={{fontSize:8,color:"#8A6A3A",fontWeight:700,textTransform:"uppercase",letterSpacing:".05em",marginBottom:2}}>{k}</div>
                      <div style={{fontSize:11,color:col as string,fontWeight:800,fontFamily:"monospace"}}>{v as any}</div>
                    </div>
                  ))}
                </div>
              )}
              {blocks.map((b:any)=>{
                const conf = b.hasModel ? b.confidencePct : 0;
                const low = !b.hasModel || conf < 45;
                return (
                  <div key={b.modelType||"mlr"} style={{marginBottom:10,padding:"8px 10px",background:"#0A1520",border:`1px solid ${low?"#F8717155":"#33434F"}`,borderRadius:8}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:6}}>
                      <span style={{fontSize:10,fontWeight:900,color:"#FDE68A",letterSpacing:".06em"}}>{b.modelLabel||"MLR"}</span>
                      {b.hasModel && <span style={{fontSize:10,color:"#8AA3C0",fontFamily:"monospace"}}>Confidence {conf}% · R² {Number(b.r2).toFixed(2)} · n={b.n}</span>}
                      {low && <span style={{fontSize:9,fontWeight:900,color:"#000",background:"#F87171",padding:"2px 6px",borderRadius:3}}>LOW CONFIDENCE</span>}
                      {b.hasModel && b.intervalSec && <span style={{fontSize:10,color:"#8AA3C0",fontFamily:"monospace"}}>Range {fmtMMSS(b.intervalSec.low)}–{fmtMMSS(b.intervalSec.high)}</span>}
                    </div>
                    {b.reviewFlag && (
                      <div style={{padding:"5px 8px",marginBottom:6,borderRadius:5,background:"#2A1408",border:"1px solid #FB923C",color:"#FDBA74",fontSize:10,fontWeight:800}}>
                        ⚠ {b.reviewFlag}
                      </div>
                    )}
                    <div style={{fontSize:13,color:low?"#FCA5A5":"#E8F0FA",fontWeight:600,lineHeight:1.4,marginBottom:8}}>{b.sentence}</div>
                    {b.hasModel && b.minZinc && (
                      <div style={{padding:"5px 8px",marginBottom:8,borderRadius:5,background:"#06180F",border:"1px solid #22C55E55",color:"#86EFAC",fontSize:10.5,fontWeight:700,lineHeight:1.45}}>
                        ♻ Minimum-zinc option — {b.minZinc.mmss} ({b.minZinc.sec}s) still lands ≈{b.minZinc.coating} µm, clearing the {recommendation.required} µm requirement floor
                        {b.minZinc.savedUm > 0 ? ` and saving ≈${b.minZinc.savedUm} µm of zinc per beam.` : "."}
                      </div>
                    )}

                    {b.hasModel && (
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:6}}>
                        {[
                          ["Specific Coating",`${recommendation.required} µm`,"#FDE68A"],
                          ["Target Coating",`${b.targetCoating} µm`,"#4ADE80"],
                          ["Predicted Total Time",`${b.predictedSec}s (${b.predictedMMSS})`,"#FB923C"],
                          ["Expected Coating",`${Number(b.expectedCoating).toFixed(2)} µm`,"#A78BFA"],
                          ["Adjustment",`${b.deltaSec>=0?"+":""}${b.deltaSec}s`,b.deltaSec>=0?"#FB923C":"#22D3EE"],
                          ["Confidence",`${conf}%`,low?"#F87171":"#4ADE80"],
                        ].map(([k,v,col])=>(
                          <div key={k as string} style={{padding:"5px 7px",background:"#16202B",borderRadius:4,border:"1px solid #33434F"}}>
                            <div style={{fontSize:8,color:"#8A6A3A",fontWeight:700,textTransform:"uppercase",letterSpacing:".05em",marginBottom:2}}>{k}</div>
                            <div style={{fontSize:11,color:col as string,fontWeight:800,fontFamily:"monospace"}}>{v as any}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {primary?.hasModel && (
                <details style={{fontSize:10,color:"#8A6A3A"}}>
                  <summary style={{cursor:"pointer",fontWeight:700,color:"#FB923C"}}>Model inputs</summary>
                  <div style={{marginTop:6,fontFamily:"monospace",fontSize:9,lineHeight:1.6,color:"#8AA3C0"}}>
                    <div>Inputs — Load Type: {String(primary.inputs.loadType ?? "—")} · Material: {String(primary.inputs.material ?? "—")} · Thickness: {primary.inputs.thickness} mm · Weight: {Number(primary.inputs.weight||0).toFixed(2)} MT · Length: {Math.round(Number(primary.inputs.length||0))} mm · Specific Coating: {primary.inputs.spec} µm · Surface: {String(primary.inputs.surface ?? "—")} · Bath Temp: {primary.inputs.bathTemp}°C</div>
                    {primary.coefficients && <div>β = [{(primary.coefficients||[]).map((c)=>Number(c).toFixed(4)).join(", ")}]</div>}
                    <div>Trained on {primary.n} historical rows{primary.trainedAt?` · ${fmtDateTimeTz(primary.trainedAt)}`:""} · Coating R² {Number(primary.coatingR2).toFixed(2)}</div>
                  </div>
                </details>
              )}
            </div>
          );
        })()}




        {beam&&recommendation&&recommendation.top&&recommendation.top.length>0&&(
          <div style={{padding:"14px 16px",background:"linear-gradient(90deg,#04140A,#0A1422)",border:"1px solid #1A3A20",borderRadius:10,marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
              <span style={{fontSize:11,fontWeight:900,color:"#000",background:recommendation.recommendationType==="closest"?"#FBBF24":"#4ADE80",padding:"3px 8px",borderRadius:4,letterSpacing:".08em"}}>
                {recommendation.recommendationType==="closest"?"CLOSEST HISTORICAL MATCH":"EXACT HISTORICAL MATCH"}
              </span>
              <div style={{flex:1,minWidth:200}}>
                <div style={{fontSize:11,fontWeight:800,color:recommendation.recommendationType==="closest"?"#FBBF24":"#4ADE80",letterSpacing:".05em"}}>Best Coating Result — Required {recommendation.required} μm · Confidence 100%</div>
                <div style={{fontSize:10,color:"#3A6E4A"}}>
                  {recommendation.recommendationType==="closest"
                    ? `No exact match — tolerances widened ${recommendation.relaxFactor}× · scanned ${recommendation.count} PASS beam${recommendation.count>1?"s":""}, picked nearest avg coating`
                    : `Exact match on Thickness, Load Type, Coating spec + range match on Weight / Bath °C / Qty — scanned ${recommendation.count} prior PASS beam${recommendation.count>1?"s":""}, picked nearest avg coating`}
                </div>

                <div style={{fontSize:9,color:"#3A4F70",marginTop:3,fontFamily:"monospace"}}>
                  {recommendation.tolerances?.thk!=null && <span style={{marginRight:10}}>THK = {recommendation.tolerances.thk}mm</span>}
                  {recommendation.tolerances?.wt!=null && <span style={{marginRight:10}}>WT {recommendation.tolerances.wt}±{recommendation.tolerances.weightTol} MT</span>}
                  {recommendation.tolerances?.tempNum!=null && <span style={{marginRight:10}}>°C {recommendation.tolerances.tempNum}±{recommendation.tolerances.tempTol}</span>}
                  {recommendation.tolerances?.qty!=null && <span style={{marginRight:10}}>QTY {recommendation.tolerances.qty}±{recommendation.tolerances.qtyTol}</span>}
                  {recommendation.tolerances?.len!=null && <span style={{marginRight:10}}>LEN {recommendation.tolerances.len}±{recommendation.tolerances.lengthTol}mm</span>}
                  {recommendation.tolerances?.useMat!==false && recommendation.tolerances?.mat && <span style={{marginRight:10}}>MAT = {recommendation.tolerances.mat} (Exact)</span>}
                  {recommendation.tolerances?.useSurf!==false && recommendation.tolerances?.surf && <span style={{marginRight:10}}>SURFACE = {recommendation.tolerances.surf} (Exact)</span>}
                </div>
              </div>
            </div>
            {/* Selected historical match — visually highlighted */}
            <div>
              {(() => {
                const top3Arr = recommendation.top3 || [recommendation.best];
                const idx = Math.min(selectedTopIdx, top3Arr.length - 1);
                const r = top3Arr[idx] || recommendation.best;
                const refDate = r.qc_completed_at ? new Date(r.qc_completed_at) : null;
                const dateLabel = refDate && Number.isFinite(+refDate)
                  ? refDate.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
                  : "—";
                const isV2Ref = isV2Coj(r);
                const readings: (number|null)[] = !isV2Ref && Array.isArray(r.elcometer) && r.elcometer.length
                  ? r.elcometer.slice(0, 7) : [];
                const v2Subs = isV2Ref ? v2SubAverages(r.elcometer_v2) : null;
                const v2Mm = isV2Ref ? v2MinMax(r.elcometer_v2) : null;
                const band: [number, number] = recommendation.required === 65 ? [65, 75]
                  : recommendation.required === 87 ? [87, 105]
                  : recommendation.required === 130 ? [130, 145]
                  : [recommendation.required, recommendation.required + 10];
                return (
                  <div key={r.beam_no+"_"+idx} style={{padding:"12px 14px",background:"#060E18",border:"2px solid #4ADE80",borderRadius:8,position:"relative",boxShadow:"0 0 0 3px rgba(74,222,128,.12)"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,gap:8,flexWrap:"wrap"}}>
                      <span style={{fontSize:11,fontWeight:800,color:"#4ADE80",letterSpacing:".05em"}}>
                        ⭐ {["1ST","2ND","3RD"][idx] || `#${idx+1}`} VIEW · Required {recommendation.required} μm · Matched {r.avg_reading} μm · Δ {r._diff?.toFixed(2)} μm
                      </span>
                      <button type="button" onClick={()=>applyRecommendation(r)} disabled={!manualMode && !tsImmStart}
                        title={(!manualMode && !tsImmStart)?"Capture Immersion Start first":"Apply these timings"}
                        style={{padding:"4px 9px",borderRadius:4,border:`1px solid ${(manualMode||tsImmStart)?"#4ADE80":"#5C7482"}`,background:(manualMode||tsImmStart)?"#0A2A14":"#0A1520",color:(manualMode||tsImmStart)?"#4ADE80":"#5C7482",cursor:(manualMode||tsImmStart)?"pointer":"not-allowed",fontSize:10,fontWeight:800,fontFamily:"inherit"}}>
                        ⚡ APPLY
                      </button>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
                      {[
                        ["Ref Beam",r.beam_no,"#3D7EA6"],
                        ["Ref Date",dateLabel,"#8AA3C0"],
                        ["Avg μm",(r.avg_reading??"—")+"","#A78BFA"],
                        ["Immersion",fmtDur(r.immersion_duration),"#5BA3FF"],
                        ["Reaction",fmtDur(r.reaction_duration),"#22D3EE"],
                        ["Withdrawal",fmtDur(r.withdrawal_duration),"#4ADE80"],
                        ["Bath °C",r.bath_temperature??"—","#FB923C"],
                        ["Material Type",r.material_type??"—","#FDE68A"],
                        ["Surface",r.surface_condition??"—","#F0ABFC"],
                      ].map(([k,v,col])=>(
                        <div key={k as string} style={{padding:"5px 7px",background:"#0A1520",borderRadius:4,border:"1px solid #33434F"}}>
                          <div style={{fontSize:8,color:"#5C7482",fontWeight:700,textTransform:"uppercase",letterSpacing:".05em",marginBottom:2}}>{k}</div>
                          <div style={{fontSize:11,color:col as string,fontWeight:800,fontFamily:"monospace"}}>{v as any}</div>
                        </div>
                      ))}
                    </div>
                    {isV2Ref && v2Subs && (
                      <div style={{marginTop:8,padding:"6px 8px",background:"#0A1520",borderRadius:4,border:"1px solid #33434F"}}>
                        <div style={{fontSize:8,color:"#5C7482",fontWeight:700,textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>Coating on Job — 30-Point Withdrawal Averages (μm)</div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:4}}>
                          {[["FW Outside Average",v2Subs.fwOut],["FW Inside Average",v2Subs.fwIn],["MW Outside Average",v2Subs.mwOut],["MW Inside Average",v2Subs.mwIn],["LW Outside Average",v2Subs.lwOut],["LW Inside Average",v2Subs.lwIn]].map(([lbl,val])=>{
                            const n = val as number|null;
                            const inBand = n!=null && n>=band[0] && n<=band[1];
                            const col = n==null ? "#4A3A20" : inBand ? "#4ADE80" : n < band[0] ? "#F87171" : "#FBBF24";
                            return (
                              <div key={lbl as string} style={{padding:"3px 4px",background:"#060E18",borderRadius:3,border:`1px solid ${col}40`,textAlign:"center"}}>
                                <div style={{fontSize:7,color:"#4A5A70",fontWeight:700}}>{lbl as string}</div>
                                <div style={{fontSize:10,color:col,fontWeight:800,fontFamily:"monospace"}}>{n!=null?n.toFixed(2):"—"}</div>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:4,marginTop:4}}>
                          <div style={{padding:"3px 4px",background:"#0A2014",borderRadius:3,border:"1px solid #4ADE8060",textAlign:"center"}}>
                            <div style={{fontSize:7,color:"#4ADE80",fontWeight:700}}>TOTAL AVG</div>
                            <div style={{fontSize:10,color:"#4ADE80",fontWeight:800,fontFamily:"monospace"}}>{Number(r.avg_reading).toFixed(2)}</div>
                          </div>
                          <div style={{padding:"3px 4px",background:"#060E18",borderRadius:3,border:"1px solid #33434F",textAlign:"center"}}>
                            <div style={{fontSize:7,color:"#8DA0AD",fontWeight:700}}>MIN</div>
                            <div style={{fontSize:10,color:"#8AA3C0",fontWeight:800,fontFamily:"monospace"}}>{v2Mm?.min!=null?v2Mm.min.toFixed(2):"—"}</div>
                          </div>
                          <div style={{padding:"3px 4px",background:"#060E18",borderRadius:3,border:"1px solid #33434F",textAlign:"center"}}>
                            <div style={{fontSize:7,color:"#8DA0AD",fontWeight:700}}>MAX</div>
                            <div style={{fontSize:10,color:"#8AA3C0",fontWeight:800,fontFamily:"monospace"}}>{v2Mm?.max!=null?v2Mm.max.toFixed(2):"—"}</div>
                          </div>
                        </div>
                      </div>
                    )}
                    {!isV2Ref && readings.length > 0 && (
                      <div style={{marginTop:8,padding:"6px 8px",background:"#0A1520",borderRadius:4,border:"1px solid #33434F"}}>
                        <div style={{fontSize:8,color:"#5C7482",fontWeight:700,textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>Seven-Point Elcometer Readings (μm)</div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(8,1fr)",gap:4}}>
                          {readings.map((val,i)=>{
                            const n = Number(val);
                            const inBand = Number.isFinite(n) && n >= band[0] && n <= band[1];
                            const col = !Number.isFinite(n) ? "#4A3A20" : inBand ? "#4ADE80" : n < band[0] ? "#F87171" : "#FBBF24";
                            return (
                              <div key={i} style={{padding:"3px 4px",background:"#060E18",borderRadius:3,border:`1px solid ${col}40`,textAlign:"center"}}>
                                <div style={{fontSize:7,color:"#4A5A70",fontWeight:700}}>R{i+1}</div>
                                <div style={{fontSize:10,color:col,fontWeight:800,fontFamily:"monospace"}}>{Number.isFinite(n)?n.toFixed(2):"—"}</div>
                              </div>
                            );
                          })}
                          <div style={{padding:"3px 4px",background:"#0A2014",borderRadius:3,border:"1px solid #4ADE8060",textAlign:"center"}}>
                            <div style={{fontSize:7,color:"#4ADE80",fontWeight:700}}>AVG</div>
                            <div style={{fontSize:10,color:"#4ADE80",fontWeight:800,fontFamily:"monospace"}}>{Number(r.avg_reading).toFixed(2)}</div>
                          </div>
                        </div>
                        <div style={{marginTop:4,fontSize:8,color:"#4A5A70",fontWeight:600}}>Legacy 7-point record — withdrawal-wise (FW/MW/LW · Outside/Inside) averages are not available for this beam.</div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Top 3 selector — click to view details of each */}
            {recommendation.top3 && recommendation.top3.length > 1 && (
              <div style={{marginTop:10,padding:"8px 10px",background:"#040A14",border:"1px solid #142840",borderRadius:6}}>
                <div style={{fontSize:9,fontWeight:800,color:"#3A6E4A",letterSpacing:".08em",textTransform:"uppercase",marginBottom:6}}>Best Coating Result — select 1st / 2nd / 3rd View (AI Insights &amp; variance follow the selection)</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
                  {recommendation.top3.map((r,idx)=>{
                    const active = idx === selectedTopIdx;
                    const dt = r.qc_completed_at ? new Date(r.qc_completed_at) : null;
                    const dateShort = dt && Number.isFinite(+dt) ? dt.toLocaleDateString("en-IN",{day:"2-digit",month:"short"}) : "—";
                    return (
                      <button type="button" key={"t3_"+txn(r)+"_"+idx} onClick={()=>setSelectedTopIdx(idx)}
                        style={{padding:"8px 10px",background:active?"#0A2014":"#0A1520",borderRadius:4,border:`2px solid ${active?"#4ADE80":"#33434F"}`,fontFamily:"monospace",fontSize:10,textAlign:"left",cursor:"pointer",color:"inherit"}}>
                        <div style={{color:active?"#4ADE80":"#6B7E9E",fontWeight:800,marginBottom:2}}>{["1ST","2ND","3RD"][idx] || `#${idx+1}`} VIEW {active?"★ selected":"· click to view"}</div>
                        <div style={{color:"#3D7EA6",fontWeight:700}}>{r.beam_no}</div>
                        <div style={{color:"#8AA3C0",fontSize:9}}>{dateShort}</div>
                        <div style={{color:"#A78BFA"}}>{r.avg_reading} μm · Δ {r._diff?.toFixed(2)}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}


            {/* ── Stage-by-Stage Variance vs selected Ref Beam (admin-toggle) ── */}
            {dc.varianceAnalysisEnabled !== false && (() => {
              const t3 = recommendation.top3 || [recommendation.best];
              const selIdx = Math.min(selectedTopIdx, t3.length - 1);
              const r = t3[selIdx] || recommendation.best;
              const curImm = manualMode ? manImmSec : immDur;
              const curReact = manualMode ? manReactSec : reactDur;
              const curWith = manualMode ? manWithSec : withdDur;
              if (curImm == null && curReact == null && curWith == null) return null;
              const rows = stageTimeline(
                { immersion: curImm, reaction: curReact, withdrawal: curWith },
                { immersion: r.immersion_duration, reaction: r.reaction_duration, withdrawal: r.withdrawal_duration },
              );
              const colorFor = (s:string) => s==="On Target" ? "#6B7E9E"
                : s.endsWith("Higher") ? (s.startsWith("Significantly") ? "#F87171" : "#FB923C")
                : s.endsWith("Lower")  ? (s.startsWith("Significantly") ? "#5BA3FF" : "#22D3EE")
                : "#3A4F70";
              return (
                <div key={"var_"+r.beam_no+"_"+selIdx} style={{marginTop:10,padding:"10px 12px",background:"#02101A",border:"1px solid #143040",borderRadius:6}}>
                  <div style={{fontSize:10,fontWeight:800,color:"#22D3EE",letterSpacing:".08em",textTransform:"uppercase",marginBottom:8}}>
                    🧭 Stage-by-Stage Variance vs Ref Beam {r.beam_no} · {["1st","2nd","3rd"][selIdx] || `#${selIdx+1}`} View
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1.3fr .8fr .8fr .9fr .9fr .9fr 1.1fr",gap:1,background:"#0A1320",borderRadius:4,overflow:"hidden",fontFamily:"monospace",fontSize:11}}>
                    {["Stage","Stage Time","Ref Stage","Elapsed","Ref Elapsed","Variance","Status"].map(h=>(
                      <div key={h} style={{padding:"5px 8px",background:"#0E1E2E",color:"#6B7E9E",fontWeight:800,fontSize:9,textTransform:"uppercase",letterSpacing:".05em"}}>{h}</div>
                    ))}
                    {rows.map(row=>{
                      const isTotal = row.key==="total";
                      const isStart = row.key==="immersion-start";
                      const bg = isTotal?"#0A1A2A":isStart?"#08161F":"#060E18";
                      const cells = [
                        <span style={{fontWeight:(isTotal||isStart)?800:600,color:isTotal?"#3D7EA6":isStart?"#FDE68A":"#C9D6DF"}}>{row.label}</span>,
                        <span style={{color:"#A78BFA"}}>{row.stageCurrent!=null?fmtDur(row.stageCurrent):"—"}</span>,
                        <span style={{color:"#8DA0AD"}}>{row.stageReference!=null?fmtDur(row.stageReference):"—"}</span>,
                        <span style={{color:"#22D3EE"}}>{row.current!=null?fmtDur(row.current):"—"}</span>,
                        <span style={{color:"#8DA0AD"}}>{row.reference!=null?fmtDur(row.reference):"—"}</span>,
                        <span style={{color:colorFor(row.status),fontWeight:800}}>{isStart?"—":fmtSignedDur(row.variance)}</span>,
                        <span style={{color:colorFor(row.status),fontWeight:isTotal?800:600}}>{isStart?"Baseline":row.status}</span>,
                      ];
                      return cells.map((c,i)=>(
                        <div key={row.key+"_"+i} style={{padding:"5px 8px",background:bg}}>{c}</div>
                      ));
                    })}
                  </div>
                  {(() => {
                    const sl = timelineSummary(rows);
                    return sl ? <div style={{marginTop:6,fontSize:10,color:"#22D3EE",fontStyle:"italic"}}>{sl}</div> : null;
                  })()}
                </div>
              );
            })()}
          </div>
        )}
        {/* Match-not-available block removed — AI always emits a recommendation
            via the unconditional First-Beam regression fallback in
            src/features/hdp/recommendation.ts. */}




        {/* ── 4 TIMESTAMP BOXES (live-timer mode) ─────────────── */}
        {beam&&!manualMode&&<>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:16}}>
            <TsBox label="Immersion Start" step="1" hint="Beam enters zinc bath"
              value={tsImmStart} setter={setIS_p} col="#3D7EA6"
              phaseDur={null} elapsedFromStart={null}
              liveTicker={null}/>

            <TsBox label="Immersion End" step="2" hint="Beam fully submerged"
              value={tsImmEnd} setter={setIE_p} col="#5BA3FF" dependsOn={tsImmStart}
              phaseDur={immDur} phaseLabel="Immersion phase"
              elapsedFromStart={elapsedToImmEnd}
              liveTicker={liveImm}/>

            <TsBox label="Reaction End" step="3" hint="Zinc reaction complete"
              value={tsReactEnd} setter={setRE_p} col="#22D3EE" dependsOn={tsImmEnd}
              phaseDur={reactDur} phaseLabel="Reaction phase"
              elapsedFromStart={elapsedToReact}
              liveTicker={liveReact}/>

            <TsBox label="Withdrawal End" step="4" hint="Beam fully out of bath"
              value={tsWithEnd} setter={setWE_p} col="#4ADE80" dependsOn={tsReactEnd}
              phaseDur={withdDur} phaseLabel="Withdrawal phase"
              elapsedFromStart={elapsedToWithd}
              liveTicker={liveWith}/>
          </div>

          {/* Big live total stopwatch */}
          {liveTotal!=null&&<div style={{display:"flex",alignItems:"center",gap:14,padding:"12px 18px",
            background:"linear-gradient(90deg,#1A0E00,#1E2A36)",border:"1px solid #FB923C50",borderRadius:10,marginBottom:12,flexWrap:"wrap"}}>
            <span style={{width:9,height:9,borderRadius:"50%",background:"#FB923C",boxShadow:"0 0 10px #FB923C",animation:"pulse 1.2s infinite"}}/>
            <span style={{fontSize:11,fontWeight:800,color:"#FB923C",letterSpacing:".08em"}}>LIVE DIP STOPWATCH</span>
            <DippingSyncBadge/>
            <strong style={{marginLeft:"auto",fontFamily:"monospace",fontSize:28,color:"#FB923C",fontWeight:900,letterSpacing:".02em"}}>{fmtDur(liveTotal)}</strong>
          </div>}
        </>}

        {/* ── MANUAL DURATION ENTRY (admin-enabled) ───────────── */}
        {beam&&manualMode&&<div style={{marginBottom:16}}>
          <div style={{padding:"10px 14px",background:"#1A0E00",border:"1px solid #4A2A00",borderRadius:8,marginBottom:12,fontSize:11,color:"#FB923C",display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:14}}>✍</span>
            <strong>MANUAL DURATION ENTRY</strong>
            <span style={{color:"#A85020"}}>Live timer disabled by Admin. Enter durations in MM:SS (e.g. 01:23).</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:12}}>
            {[
              {lbl:"Immersion Duration", val:manImm, set:setManImm, v:vImm,   col:"#3D7EA6", ph:"00:20"},
              {lbl:"Reaction Duration",  val:manReact,set:setManReact,v:vReact, col:"#22D3EE", ph:"01:23"},
              {lbl:"Withdrawal Duration",val:manWith, set:setManWith, v:vWith,  col:"#4ADE80", ph:"02:34"},
            ].map((f,i)=>{
              const touched = f.val!=="";
              const invalid = touched && !!f.v.error;
              const ok      = !f.v.error && f.v.seconds!=null;
              return <div key={f.lbl} style={{background:"#0A1422",border:`1px solid ${invalid?"#7A1B1B":(ok?f.col+"60":"#33434F")}`,borderRadius:10,padding:"12px 14px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:ok?f.col:"#33434F",color:ok?"#000":"#3A4F70",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:11}}>{i+1}</div>
                  <label style={{fontSize:11,fontWeight:700,color:f.col,letterSpacing:".04em"}}>{f.lbl}</label>
                </div>
                <DInput dark value={f.val}
                  onChange={e=>f.set(sanitizeMmSs(e.target.value))}
                  placeholder={f.ph} maxLength={5}
                  inputMode="numeric" pattern="[0-9]{1,2}:[0-5][0-9]"
                  aria-invalid={invalid}
                  style={{width:"100%",textAlign:"center",fontFamily:"monospace",fontSize:22,fontWeight:800,color:invalid?"#F87171":f.col,letterSpacing:".06em"}}/>
                <div style={{fontSize:10,color:invalid?"#F87171":"#3A4F70",marginTop:6,fontFamily:invalid?"inherit":"monospace",textAlign:"center",lineHeight:1.35,minHeight:14}}>
                  {touched
                    ? (invalid ? f.v.error : `= ${f.v.seconds}s ✓`)
                    : "Format MM:SS (00:01–30:00)"}
                </div>
              </div>;
            })}
          </div>
          {manTotalSec!=null&&<div style={{display:"flex",alignItems:"center",gap:14,padding:"12px 18px",
            background:"linear-gradient(90deg,#1A0E00,#1E2A36)",border:`1px solid ${manTotalError?"#7A1B1B":"#FB923C50"}`,borderRadius:10,marginBottom:8}}>
            <span style={{fontSize:16}}>⏱</span>
            <span style={{fontSize:11,fontWeight:800,color:manTotalError?"#F87171":"#FB923C",letterSpacing:".08em"}}>TOTAL DIPPING TIME (auto-calculated)</span>
            <strong style={{marginLeft:"auto",fontFamily:"monospace",fontSize:28,color:manTotalError?"#F87171":"#FB923C",fontWeight:900,letterSpacing:".02em"}}>{fmtDur(manTotalSec)}</strong>
          </div>}
          {manTotalError&&<div style={{fontSize:11,color:"#F87171",marginBottom:12,padding:"6px 12px",background:"#220808",border:"1px solid #441010",borderRadius:6}}>⚠ {manTotalError}</div>}
        </div>}

        
        {beam&&<>


          {/* Material Surface Condition — required before dipping */}
          <div style={{padding:"12px 16px",background:"#0A1422",border:`1px solid ${surfaceCond?"#33434F":"#3A2A00"}`,borderRadius:10,marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <span style={{fontSize:16}}>🧱</span>
              <div style={{flex:1}}>
                <div style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase"}}>Material Surface Condition <span style={{color:"#3D7EA6"}}>*</span></div>
                <div style={{fontSize:9,color:"#3A4F70"}}>Recorded against beam & coating-result history — used by AI recommendation when enabled.</div>
              </div>
              {beam?.material_type && <span style={{fontSize:10,fontWeight:800,color:"#22D3EE",background:"#082430",border:"1px solid #22D3EE60",padding:"2px 8px",borderRadius:4,letterSpacing:".05em"}}>{beam.material_type}</span>}
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {[
                {k:"Normal",lbl:"Normal Surface",col:"#4ADE80"},
                {k:"Rusted",lbl:"Rusted Surface",col:"#3D7EA6"},
                {k:"HeavyRusted",lbl:"Heavy Rusted Surface",col:"#F87171"},
              ].map(o=>{
                const on = surfaceCond===o.k;
                return <button key={o.k} type="button" onClick={()=>setSurfaceCond(o.k)} style={{
                  padding:"8px 16px",borderRadius:7,fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"inherit",
                  background:on?o.col:"#16202B",color:on?"#000":o.col,
                  border:`1px solid ${o.col}`,letterSpacing:".03em"}}>{o.lbl}</button>;
              })}
            </div>
          </div>

          {/* Bath Temperature entry */}
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",background:"#0A1422",border:"1px solid #33434F",borderRadius:10,marginBottom:12}}>
            <span style={{fontSize:18}}>🌡</span>
            <div style={{flex:1}}>
              <label htmlFor="bath_temp" style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:4}}>Zinc Bath Temperature</label>
              <div style={{fontSize:9,color:"#3A4F70"}}>Typical range 440 – 460°C. Used by smart-coating recommendation.</div>
            </div>
            <DInput id="bath_temp" name="bath_temp" type="number" step="0.1" min="0" max="600" dark value={bathTemp} onChange={e=>setBathTemp(e.target.value)} placeholder="°C" style={{width:120,textAlign:"center",fontFamily:"monospace",fontWeight:700}} aria-label="Zinc bath temperature in Celsius"/>
            <span style={{fontFamily:"monospace",fontSize:14,color:"#FB923C",fontWeight:800,minWidth:36}}>°C</span>
          </div>

          {/* Dipping Operator — required when admin has configured operator names */}
          {activeOperators.length>0 && (
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",background:"#0A1422",border:`1px solid ${operatorName?"#33434F":"#3A2A00"}`,borderRadius:10,marginBottom:12}}>
              <span style={{fontSize:18}}>👷</span>
              <div style={{flex:1}}>
                <label htmlFor="dip_operator" style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:4}}>Dipping Operator (on floor)</label>
                <div style={{fontSize:9,color:"#3A4F70"}}>Operator who actually performed the dip — used for operator-wise production reports.</div>
              </div>
              <DSel dark value={operatorName} onChange={e=>setOperatorName(e.target.value)} style={{width:220}}>
                <option value="">— Select Operator —</option>
                {activeOperators.map((o:any)=><option key={o.id} value={o.name}>{o.name}</option>)}
              </DSel>
            </div>
          )}
          {activeShiftSups.length>0 && (
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",background:"#0A1422",border:`1px solid ${shiftSupName?"#33434F":"#3A2A00"}`,borderRadius:10,marginBottom:12}}>
              <span style={{fontSize:18}}>🧑‍🏭</span>
              <div style={{flex:1}}>
                <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:4}}>Shift Supervisor</label>
                <div style={{fontSize:9,color:"#3A4F70"}}>Supervisor on shift — feeds the Shift-Supervisor-wise Dipping &amp; Coating report.</div>
              </div>
              <DSel dark value={shiftSupName} onChange={e=>setShiftSupName(e.target.value)} style={{width:220}}>
                <option value="">— Select Supervisor —</option>
                {activeShiftSups.map((o:any)=><option key={o.id} value={o.name}>{o.name}</option>)}
              </DSel>
            </div>
          )}


          {seqErrors.length>0&&<div style={{marginBottom:12}}>
            {seqErrors.map((e,i)=><div key={i} style={{padding:"8px 12px",background:"#200808",
              border:"1px solid #441010",borderRadius:6,fontSize:12,color:"#F87171",marginBottom:4}}>⚠ {e}</div>)}
          </div>}

          {/* Duration summary bar */}
          {totalDur!=null&&<div style={{display:"flex",flexWrap:"wrap",gap:8,padding:"13px 18px",
            background:"#060C14",border:"1px solid #0E2030",borderRadius:10,marginBottom:16,alignItems:"center"}}>
            <div style={{fontSize:10,color:"#3A4F70",fontWeight:700,marginRight:8}}>PHASE DURATIONS:</div>
            {[[immDur,"Immersion","#3D7EA6"],[reactDur,"Reaction","#22D3EE"],[withdDur,"Withdrawal","#4ADE80"]].map(([d,lbl,col])=>
              d!=null?<div key={lbl} style={{display:"flex",alignItems:"center",gap:6,
                padding:"5px 12px",background:"rgba(0,0,0,.3)",borderRadius:6}}>
                <span style={{fontSize:9,color:"#3A4F70",fontWeight:700}}>{lbl}:</span>
                <strong style={{color:col,fontFamily:"monospace",fontSize:13}}>{fmtDur(d)}</strong>
              </div>:null)}
            <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8,
              padding:"8px 16px",background:"rgba(251,146,60,.1)",border:"1px solid #FB923C40",borderRadius:8}}>
              <span style={{fontSize:10,color:"#FB923C",fontWeight:700}}>TOTAL DIP TIME:</span>
              <strong style={{color:"#FB923C",fontFamily:"monospace",fontSize:20}}>{fmtDur(totalDur)}</strong>
            </div>
          </div>}
        </>}

        {/* ── DUAL BATCH SECTION ─────────────────────────────── */}
        {isSpecial&&beam&&<div style={{background:"#0A1A08",border:"2px solid #1A3A10",
          borderRadius:10,padding:18,marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
            <span style={{fontSize:18}}>⚡</span>
            <span style={{fontSize:13,fontWeight:800,color:"#4ADE80"}}>DUAL BATCH MODE — {beam.load_type.toUpperCase()}</span>
          </div>
          {/* Split-batch progress + history */}
          {(beam.dipping_history||[]).length>0&&<div style={{background:"#060E04",border:"1px dashed #1A3A10",borderRadius:8,padding:12,marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,flexWrap:"wrap"}}>
              <span style={{fontSize:10,fontWeight:800,color:"#FB923C",letterSpacing:".06em",background:"#2A1600",border:"1px solid #4A2A00",padding:"3px 8px",borderRadius:4}}>SPLIT-BATCH IN PROGRESS</span>
              <span style={{fontSize:11,color:"#8DA0AD"}}>Beam: <strong style={{color:"#3D7EA6",fontFamily:"monospace"}}>{beam.beam_no}</strong></span>
              <span style={{fontSize:11,color:"#8DA0AD"}}>Dipped: <strong style={{color:"#4ADE80",fontFamily:"monospace"}}>{beamAlreadyDipped.length}</strong>/{partList(beam).length}</span>
              <span style={{fontSize:11,color:"#8DA0AD"}}>Remaining: <strong style={{color:"#FDE047",fontFamily:"monospace"}}>{beamRemaining.length}</strong></span>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:120,overflowY:"auto"}}>
              {(beam.dipping_history||[]).map((h,i)=>(
                <div key={i} style={{fontSize:10,fontFamily:"monospace",color:"#3A4F70",padding:"3px 6px",background:"#040A02",borderRadius:3,display:"flex",gap:8,flexWrap:"wrap"}}>
                  <span style={{color:"#8DA0AD"}}>#{i+1}</span>
                  <span style={{color:"#4ADE80"}}>{(h.parts||[]).join(", ")||"all"}</span>
                  <span style={{color:"#22D3EE"}}>{fmtDur(calcSecs(h.immersion_start,h.withdrawal_end))}</span>
                  {h.bath_temperature!=null&&<span style={{color:"#FB923C"}}>{h.bath_temperature}°C</span>}
                  <span style={{color:"#8DA0AD",marginLeft:"auto"}}>{fmt12(h.dipped_at)} — {h.dipped_by_name}</span>
                </div>
              ))}
            </div>
          </div>}

          {/* Beam 1 parts — show only remaining un-dipped parts */}
          <div style={{background:"#060E04",border:"1px solid #1A2A10",borderRadius:8,padding:14,marginBottom:12}}>
            <div style={{fontSize:11,color:"#4ADE80",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:10}}>
              ① {beam.beam_no} — Select Parts Dipped in This Batch
              {beamAlreadyDipped.length>0&&<span style={{marginLeft:8,fontSize:10,color:"#8DA0AD",fontWeight:400,textTransform:"none"}}>(already dipped: {beamAlreadyDipped.join(", ")})</span>}
            </div>
            {beamRemaining.length>0
              ?<div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                {beamRemaining.map(pt=>{const s2=dbl.selectedParts.includes(pt);
                  return <button key={pt} onClick={()=>setDbl(p=>({...p,selectedParts:s2?p.selectedParts.filter(x=>x!==pt):[...p.selectedParts,pt]}))} style={{
                    padding:"9px 18px",borderRadius:7,cursor:"pointer",fontFamily:"monospace",fontSize:13,fontWeight:800,
                    background:s2?"#16A34A":"#0A1A06",color:s2?"#fff":"#4ADE80",
                    border:`2px solid ${s2?"#4ADE80":"#1A3A10"}`,boxShadow:s2?"0 0 10px rgba(74,222,128,.3)":"none"}}>{s2?"✓ ":""}{pt}</button>;})}
              </div>
              :partList(beam).length===0
                ?<div style={{fontSize:11,color:"#5C7482",fontStyle:"italic"}}>No individual parts listed — all parts dipped together</div>
                :<div style={{fontSize:11,color:"#4ADE80",fontStyle:"italic"}}>✓ All parts already dipped — saving this entry will move beam to QC.</div>}
            {dbl.selectedParts.length>0&&<div style={{marginTop:8,fontSize:11,color:"#4ADE80",fontFamily:"monospace",padding:"6px 10px",background:"#0D2A10",borderRadius:5}}>This batch: {dbl.selectedParts.join(", ")}</div>}
          </div>
          {/* Next beam */}
          <div style={{background:"#060E18",border:"1px solid #0E2A40",borderRadius:8,padding:14}}>
            <div style={{fontSize:11,color:"#5BA3FF",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:10}}>
              ② Next Beam No. (manual entry — same zinc bath) <span style={{color:"#3A4F70",fontWeight:400}}>optional</span>
            </div>
            <DInput dark value={dbl.nextBeamNo}
              onChange={e=>setDbl(p=>({...p,nextBeamNo:e.target.value.toUpperCase(),nextSelectedParts:[]}))}
              placeholder="Type beam number — e.g. B-1026 (must be registered in Loading)"
              style={{fontSize:14,fontWeight:700,fontFamily:"monospace",marginBottom:8,
                border:`2px solid ${dbl.nextBeamNo?(nextBeamObj?"#5BA3FF":"#F87171"):"#33434F"}`}}/>
            {dbl.nextBeamNo&&!nextBeamObj&&<div style={{fontSize:11,color:"#F87171",marginBottom:8,padding:"6px 10px",background:"#200808",borderRadius:5}}>⚠ Beam not found in Loading register</div>}
            {nextBeamObj&&<>
              <div style={{fontSize:11,color:"#4ADE80",marginBottom:10,padding:"6px 10px",background:"#0A1A06",borderRadius:5,fontFamily:"monospace"}}>
                ✓ {nextBeamObj.beam_no} | {nextBeamObj.load_type} | {nextBeamObj.part_nos} | {nextBeamObj.coating_required}μm
              </div>
              {nextBeamParts.length>0&&<div>
                <div style={{fontSize:10,color:"#5BA3FF",fontWeight:700,textTransform:"uppercase",letterSpacing:".05em",marginBottom:8}}>Select Parts from {nextBeamObj.beam_no}:
                  {nextBeamAlreadyDipped.length>0&&<span style={{marginLeft:8,fontSize:10,color:"#8DA0AD",fontWeight:400,textTransform:"none"}}>(already dipped: {nextBeamAlreadyDipped.join(", ")})</span>}
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                  {nextBeamParts.map(pt=>{const s2=dbl.nextSelectedParts.includes(pt);
                    return <button key={pt} onClick={()=>setDbl(p=>({...p,nextSelectedParts:s2?p.nextSelectedParts.filter(x=>x!==pt):[...p.nextSelectedParts,pt]}))} style={{
                      padding:"9px 18px",borderRadius:7,cursor:"pointer",fontFamily:"monospace",fontSize:13,fontWeight:800,
                      background:s2?"#1D6FE8":"#060E18",color:s2?"#fff":"#5BA3FF",
                      border:`2px solid ${s2?"#5BA3FF":"#33434F"}`}}>{s2?"✓ ":""}{pt}</button>;})}
                </div>
              </div>}
            </>}
          </div>
        </div>}

        {msg&&<Alert ok={msg?.ok} msg={msg?.text} onClose={()=>sm(null)}/>}

        {beamsPending>0 && <div style={{margin:"0 0 10px",padding:"8px 12px",background:"#2A1E00",border:"1px solid #4A4000",borderRadius:6,fontSize:11,color:"#FDE047",fontWeight:700,display:"flex",alignItems:"center",gap:8}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:"#FDE047",boxShadow:"0 0 8px #FDE047",animation:"pulse 1.2s infinite"}}/>
          QUEUED — {beamsPending} pending change{beamsPending===1?"":"s"} will sync when connection is stable
        </div>}

        {beam&&(()=>{
          const blocked = manualMode && !!manualFirstError;
          return <div style={{display:"flex",gap:10}}>
            <button onClick={save} title={blocked?manualFirstError!:""}
              style={{flex:1,padding:"14px 0",fontSize:15,fontWeight:800,
              background: blocked ? "#3A2418" : "linear-gradient(135deg,#FB923C,#C2410C)",
              color: blocked ? "#F87171" : "#fff", border: blocked ? "1px solid #7A2418" : "none",
              borderRadius:8, cursor: "pointer", letterSpacing:".06em", fontFamily:"inherit",
              boxShadow: blocked ? "none" : "0 4px 16px rgba(251,146,60,.3)",
              opacity: blocked ? 0.95 : 1}}>
              {blocked ? "⚠  TAP TO SEE ERRORS" : "💾  SAVE DIPPING RECORD"}
            </button>
            <button onClick={resetForm} style={{padding:"14px 24px",fontSize:13,fontWeight:600,
              background:"transparent",color:"#8DA0AD",border:"1px solid #33434F",
              borderRadius:8,cursor:"pointer",fontFamily:"inherit"}}>✕ Reset</button>
          </div>;
        })()}
      </div>
    </div>

    </div>{/* end dipping readOnly wrapper */}
    {/* Records table */}
    <div style={{background:"#1E2A36",border:"1px solid #33434F",borderRadius:12,overflow:"hidden"}}>
      <div style={{background:"#0F1720",borderBottom:"1px solid #33434F",padding:"12px 18px"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#C9D6DF"}}>Dipping Records</div>
        <div style={{fontSize:10,color:"#3A4F70",marginTop:2}}>Showing latest {Math.min(20,dippedBeams.length)} of {dippedBeams.length} records — auto-transferred to QC module</div>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr style={{background:"#0F1720"}}>
            {["Beam No","Type","Material","Surface","Part No(s)","Dipped Parts","Weight","μm","Imm Start","Imm Duration","React Duration","Withd Duration","Cycle Time","Status","Operator","By",...(canEditPast?["Edit"]:[])].map(h=>(
              <th key={h} style={{padding:"9px 12px",textAlign:"left",color:"#3A4F70",fontWeight:700,
                fontSize:10,letterSpacing:".06em",textTransform:"uppercase",
                borderBottom:"1px solid #33434F",whiteSpace:"nowrap"}}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {dippedBeams.length===0&&<tr><td colSpan={canEditPast?17:16} style={{padding:32,textAlign:"center",color:"#5C7482",fontSize:12}}>No dipping records yet</td></tr>}
            {dippedBeams.slice(0,20).map(b=>{
              const sts=ST[b.status]||ST.DIPPING;
              return <tr key={txn(b)} style={{borderBottom:"1px solid #1E2A36",transition:"background .1s"}}
                onMouseEnter={e=>e.currentTarget.style.background="#111C2E"}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <td style={{padding:"10px 12px"}}><span style={{fontFamily:"monospace",fontSize:13,fontWeight:800,color:"#3D7EA6"}}>{b.beam_no}</span></td>
                <td style={{padding:"10px 12px"}}><span style={{fontSize:10,fontWeight:700,color:["Double Batch","Double Dipp"].includes(b.load_type)?"#FB923C":"#C9D6DF",background:"#33434F",padding:"2px 7px",borderRadius:4}}>{b.load_type}</span></td>
                <td style={{padding:"10px 12px"}}><span style={{fontSize:10,fontWeight:800,color:"#22D3EE",background:"#082430",border:"1px solid #22D3EE60",padding:"2px 7px",borderRadius:4,letterSpacing:".05em"}}>{b.material_type||"—"}</span></td>
                <td style={{padding:"10px 12px"}}><span style={{fontSize:10,fontWeight:700,color:"#F0ABFC"}}>{fmtSurface(b.surface_condition)}</span></td>
                <td style={{padding:"10px 12px",maxWidth:100}}><span style={{fontSize:10,color:"#5BA3FF",fontFamily:"monospace"}}>{b.part_nos||"—"}</span></td>
                <td style={{padding:"10px 12px",maxWidth:90}}><span style={{fontSize:10,color:b.dipped_parts?"#4ADE80":"#5C7482",fontFamily:"monospace"}}>{b.dipped_parts||"All"}</span></td>
                <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}><span style={{fontFamily:"monospace",fontSize:11,color:"#22D3EE"}}>{b.total_weight}MT</span></td>
                <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}><span style={{fontFamily:"monospace",fontSize:11,color:"#A78BFA"}}>{b.coating_required}μm</span></td>
                <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}><span style={{fontFamily:"monospace",fontSize:11,color:"#3D7EA6"}}>{fmt12(b.immersion_start)}</span></td>
                <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}><span style={{fontFamily:"monospace",fontSize:11,color:"#3D7EA6"}}>{fmtDur(b.immersion_duration)}</span></td>
                <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}><span style={{fontFamily:"monospace",fontSize:11,color:"#22D3EE"}}>{fmtDur(b.reaction_duration)}</span></td>
                <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}><span style={{fontFamily:"monospace",fontSize:11,color:"#4ADE80"}}>{fmtDur(b.withdrawal_duration)}</span></td>
                <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}><strong style={{fontFamily:"monospace",fontSize:12,color:"#FB923C"}}>{fmtDur(calcSecs(b.immersion_start,b.withdrawal_end))}</strong></td>
                <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}><span style={{display:"inline-block",padding:"3px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:sts.bg,color:sts.color}}>{sts.label}</span></td>
                <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}><span style={{fontSize:11,color:b.dipping_operator?"#A78BFA":"#3A4F70",fontWeight:b.dipping_operator?700:400}}>{b.dipping_operator||"—"}</span></td>
                <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}><span style={{fontSize:11,color:"#8DA0AD"}}>{b.dipped_by_name||"—"}</span></td>
                {canEditPast && <td style={{padding:"10px 12px",whiteSpace:"nowrap"}}>
                  <button onClick={()=>setEditBeam(b)} title="Edit captured timings"
                    style={{background:"transparent",border:"1px solid #33434F",color:"#5BA3FF",cursor:"pointer",fontSize:10,fontWeight:700,padding:"4px 8px",borderRadius:5}}>✎ Edit</button>
                  {Array.isArray(b.timing_history)&&b.timing_history.length>0 && <button
                    title={`Undo last edit (${b.timing_history.length} snapshot${b.timing_history.length>1?"s":""} saved)`}
                    onClick={()=>{
                      const hist=b.timing_history as any[]; const last=hist[hist.length-1];
                      if(!last||!confirm(`Undo last timing edit for ${b.beam_no}?\nRestore values from ${fmtDateTimeTz(last.edited_at)}.`)) return;
                      setBeams(prev=>prev.map(x=>txn(x)===txn(b)?{...x,...last.snapshot,timing_history:hist.slice(0,-1)}:x));
                      addAudit(user.id,user.full_name,"EDIT_TIMINGS_UNDO","dipping",`Reverted timings on ${b.beam_no} (was edited by ${last.edited_by_name} at ${last.edited_at})`);
                      sm({ok:true,text:`↶ Reverted timings for ${b.beam_no}`}); setTimeout(()=>sm(null),4000);
                    }}
                    style={{marginLeft:6,background:"transparent",border:"1px solid #33434F",color:"#FB923C",cursor:"pointer",fontSize:10,fontWeight:700,padding:"4px 8px",borderRadius:5}}>↶ Undo</button>}
                </td>}
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>

    {/* ── Beam Register modal (quick registration from dipping floor) ── */}
    {showRegister && <BeamRegisterModal
      isAdmin={user?.role==="admin"}
      onClose={()=>setShowRegister(false)}
      onSave={(nb,backdated)=>{
        const loaded_at = backdated?.loaded_at || nowISO();
        const transaction_id = makeTxnId((nb.beam_no||"").trim().toUpperCase(), loaded_at, beams);
        const beam = {
          ...nb,
          transaction_id,
          status: backdated?.status || "LOADED",
          ...(backdated || {}),
          loaded_at,
          loaded_by:user.id, loaded_by_name:user.full_name,
          shift: autoShift(loaded_at),
        };
        setBeams(prev=>[beam, ...prev]);
        addAudit(user.id,user.full_name,"CREATE","dipping",
          backdated
            ? `Backdated beam ${nb.beam_no} (Txn ${transaction_id}) created for ${fmtDateTimeTz(loaded_at)}`
            : `Quick-registered beam ${nb.beam_no} (Txn ${transaction_id}) from Dipping floor`);
        ss(transaction_id);
        setShowRegister(false);
        sm({ok:true,text: backdated
          ? `✅ Backdated beam ${nb.beam_no} saved (Txn ${transaction_id}) — ${fmtDateTz(loaded_at)}`
          : `✅ Beam ${nb.beam_no} registered (Txn ${transaction_id}) & selected`});
        setTimeout(()=>sm(null),5000);
      }}
    />}


    {editBeam && <EditTimingsModal beam={editBeam} onClose={()=>setEditBeam(null)} onSave={(patch,diffSummary)=>{
      const snapshot = {
        immersion_start: editBeam.immersion_start, immersion_end: editBeam.immersion_end,
        reaction_end: editBeam.reaction_end, withdrawal_end: editBeam.withdrawal_end,
        immersion_duration: editBeam.immersion_duration, reaction_duration: editBeam.reaction_duration,
        withdrawal_duration: editBeam.withdrawal_duration, bath_temperature: editBeam.bath_temperature,
        dipped_at: editBeam.dipped_at,
      };
      const entry = {snapshot, edited_at: nowISO(), edited_by: user.id, edited_by_name: user.full_name, diff: diffSummary};
      setBeams(prev=>prev.map(x=>txn(x)===txn(editBeam)?{...x,...patch,timing_history:[...(x.timing_history||[]),entry]}:x));
      addAudit(user.id,user.full_name,"EDIT_TIMINGS","dipping",`Edited timings on ${editBeam.beam_no}: ${diffSummary||"no field changes"}`);
      sm({ok:true,text:`✏ Timings updated for ${editBeam.beam_no} — undo available`});
      setTimeout(()=>sm(null),5000);
      setEditBeam(null);
    }}/>}
  </div>;
}

function EditTimingsModal({beam,onClose,onSave}){
  const toLocal = (iso:any)=> iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset()*60000).toISOString().slice(0,19) : "";
  const [f,setF]=useState({
    immersion_start: toLocal(beam.immersion_start),
    immersion_end:   toLocal(beam.immersion_end),
    reaction_end:    toLocal(beam.reaction_end),
    withdrawal_end:  toLocal(beam.withdrawal_end),
    bath_temperature: beam.bath_temperature ?? "",
  });
  const [err,setErr]=useState("");
  const [stage,setStage]=useState<"edit"|"confirm">("edit");
  function toIso(v:string){ return v ? new Date(v).toISOString() : null; }
  function secs(a:any,b:any){ if(!a||!b) return null; const d=(new Date(b).getTime()-new Date(a).getTime())/1000; return d>=0?Math.round(d):null; }
  const built = (()=>{
    const is=toIso(f.immersion_start), ie=toIso(f.immersion_end), re=toIso(f.reaction_end), we=toIso(f.withdrawal_end);
    const bt = f.bath_temperature===""?beam.bath_temperature:parseFloat(String(f.bath_temperature));
    return {
      patch: {
        immersion_start:is, immersion_end:ie, reaction_end:re, withdrawal_end:we,
        immersion_duration:secs(is,ie), reaction_duration:secs(ie,re), withdrawal_duration:secs(re,we),
        bath_temperature: bt, dipped_at: we || beam.dipped_at,
      },
      iso:{is,ie,re,we},
    };
  })();
  function validateAndConfirm(){
    setErr("");
    const {is,ie,re,we}=built.iso;
    if(!is) return setErr("Immersion Start is required");
    const order=[is,ie,re,we].filter(Boolean) as string[];
    for(let i=1;i<order.length;i++){ if(new Date(order[i]).getTime() < new Date(order[i-1]).getTime()) return setErr("Timestamps must be in chronological order"); }
    setStage("confirm");
  }
  const inp:React.CSSProperties = {width:"100%",background:"#16202B",border:"1px solid #33434F",color:"#C9D6DF",padding:"8px 10px",borderRadius:6,fontSize:12,fontFamily:"monospace"};
  const lbl:React.CSSProperties = {fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:5};
  // build diff rows for confirmation
  const rows: Array<{label:string; before:any; after:any; changed:boolean}> = [
    {label:"Immersion Duration", before:fmtDur(beam.immersion_duration), after:fmtDur(built.patch.immersion_duration), changed:(beam.immersion_duration??null)!==(built.patch.immersion_duration??null)},
    {label:"Reaction Duration",  before:fmtDur(beam.reaction_duration),  after:fmtDur(built.patch.reaction_duration),  changed:(beam.reaction_duration??null)!==(built.patch.reaction_duration??null)},
    {label:"Withdrawal Duration",before:fmtDur(beam.withdrawal_duration),after:fmtDur(built.patch.withdrawal_duration),changed:(beam.withdrawal_duration??null)!==(built.patch.withdrawal_duration??null)},
    {label:"Bath Temperature",   before:`${beam.bath_temperature??"—"}°C`, after:`${built.patch.bath_temperature??"—"}°C`, changed:(Number(beam.bath_temperature)||0)!==(Number(built.patch.bath_temperature)||0)},
  ];
  const changedRows = rows.filter(r=>r.changed);
  const diffSummary = changedRows.map(r=>`${r.label}: ${r.before} → ${r.after}`).join("; ");
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:"#1E2A36",border:"1px solid #33434F",borderRadius:12,padding:24,width:560,maxWidth:"100%",maxHeight:"90vh",overflowY:"auto"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div>
          <div style={{fontSize:14,fontWeight:800,color:"#C9D6DF"}}>{stage==="edit"?"✎ Edit Dipping Timings":"⚠ Confirm Timing Changes"}</div>
          <div style={{fontSize:11,color:"#8DA0AD",marginTop:3}}>Beam <span style={{color:"#3D7EA6",fontFamily:"monospace",fontWeight:700}}>{beam.beam_no}</span> — {stage==="edit"?"durations recalculate automatically":"review recalculated durations before saving"}</div>
        </div>
        <button onClick={onClose} style={{background:"transparent",border:"none",color:"#8DA0AD",cursor:"pointer",fontSize:20}}>✕</button>
      </div>
      {stage==="edit" ? <>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {[
            ["Immersion Start","immersion_start"],
            ["Immersion End","immersion_end"],
            ["Reaction End","reaction_end"],
            ["Withdrawal End","withdrawal_end"],
          ].map(([label,key])=>(
            <div key={key}>
              <label style={lbl}>{label}</label>
              <input type="datetime-local" step="1" value={(f as any)[key]} style={inp}
                onChange={e=>setF(p=>({...p,[key]:e.target.value}))}/>
            </div>
          ))}
          <div>
            <label style={lbl}>Zinc Bath Temperature (°C)</label>
            <input type="number" step="0.1" value={f.bath_temperature} style={inp}
              onChange={e=>setF(p=>({...p,bath_temperature:e.target.value}))}/>
          </div>
        </div>
        {err && <div style={{marginTop:10,padding:"8px 12px",background:"#2A0A0A",border:"1px solid #5C1818",borderRadius:6,fontSize:11,color:"#FB7185"}}>⚠ {err}</div>}
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:18}}>
          <button onClick={onClose} style={{padding:"9px 16px",background:"transparent",color:"#8DA0AD",border:"1px solid #33434F",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>Cancel</button>
          <button onClick={validateAndConfirm} style={{padding:"9px 16px",background:"linear-gradient(135deg,#5BA3FF,#2563EB)",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:800}}>Review Changes →</button>
        </div>
      </> : <>
        <div style={{padding:"10px 12px",background:"#1A1408",border:"1px solid #5C3D18",borderRadius:6,fontSize:11,color:"#FBBF24",marginBottom:12}}>
          ⚠ You are about to overwrite the captured timings. A snapshot will be saved so you can undo this change.
        </div>
        <div style={{border:"1px solid #33434F",borderRadius:8,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr 1fr",gap:0,background:"#0A1320",padding:"8px 12px",fontSize:10,fontWeight:700,color:"#8DA0AD",letterSpacing:".06em",textTransform:"uppercase"}}>
            <div>Field</div><div>Before</div><div>After</div>
          </div>
          {rows.map((r,i)=>(
            <div key={i} style={{display:"grid",gridTemplateColumns:"1.4fr 1fr 1fr",gap:0,padding:"9px 12px",borderTop:"1px solid #1E2A36",background:r.changed?"#1A1A0A":"transparent"}}>
              <div style={{fontSize:11,color:"#C9D6DF",fontWeight:r.changed?700:400}}>{r.changed?"● ":""}{r.label}</div>
              <div style={{fontSize:11,fontFamily:"monospace",color:"#8DA0AD"}}>{r.before}</div>
              <div style={{fontSize:11,fontFamily:"monospace",color:r.changed?"#4ADE80":"#8DA0AD",fontWeight:r.changed?700:400}}>{r.after}</div>
            </div>
          ))}
        </div>
        {changedRows.length===0 && <div style={{marginTop:10,padding:"8px 12px",background:"#0A1320",borderRadius:6,fontSize:11,color:"#8DA0AD"}}>ℹ No values changed — save will still create an audit entry.</div>}
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:18}}>
          <button onClick={()=>setStage("edit")} style={{padding:"9px 16px",background:"transparent",color:"#8DA0AD",border:"1px solid #33434F",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>← Back</button>
          <button onClick={()=>onSave(built.patch,diffSummary)} style={{padding:"9px 16px",background:"linear-gradient(135deg,#16A34A,#15803D)",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:800}}>✓ Confirm & Save</button>
        </div>
      </>}
    </div>
  </div>;
}

function BeamRegisterModal({onClose,onSave,isAdmin=false}:any){
  const [f,setF]=useState({beam_no:"",part_nos:"",load_type:"Amc",section:"",total_weight:"",length_mm:"",coating_required:"87",work_centre:"WC-ZINC"});
  const [backdate,setBackdate]=useState(false);
  const [bd,setBd]=useState<BackdateInput>({loaded_at:"",immersion_start:"",immersion_end:"",reaction_end:"",withdrawal_end:"",bath_temperature:"",dipping_operator:"",shift_supervisor:"",surface_condition:""});
  const [err,setErr]=useState("");
  const TYPES=["Amc","Cnc","Drilling","Plate","Cleat","Hook","Proto","Double Dipp","Double Batch","Other"];
  const COATS=[65,87,130];
  const bdResult = backdate ? resolveBackdatedEntry(bd) : null;
  const bdPreview = bdResult && bdResult.ok ? bdResult.patch : null;
  function submit(){
    if(!f.beam_no.trim()) return setErr("Beam No required");
    if(!f.part_nos.trim()) return setErr("Part No(s) required");
    if(!f.total_weight || isNaN(parseFloat(f.total_weight))) return setErr("Weight required");
    let backdatePayload:any = null;
    if(backdate){
      const r = resolveBackdatedEntry(bd);
      if(!r.ok) return setErr(r.error);
      backdatePayload = { status:r.status, ...r.patch };
    }
    onSave({
      beam_no:f.beam_no.trim(),
      part_nos:f.part_nos.trim(),
      load_type:f.load_type,
      section:f.section.trim(),
      total_weight:parseFloat(f.total_weight),
      // Lengthless beams (Plate/Cleat) have no length — always null.
      length_mm:isLengthless(f.load_type) ? null : (f.length_mm?parseFloat(f.length_mm):null),
      coating_required:parseInt(f.coating_required,10),
      work_centre:f.work_centre,
    }, backdatePayload);
  }

  const inp:React.CSSProperties = {width:"100%",background:"#0B1422",border:"1px solid #33434F",color:"#C9D6DF",padding:"8px 10px",borderRadius:6,fontSize:12,fontFamily:"inherit"};
  const lbl:React.CSSProperties = {fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:5};
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:"#1E2A36",border:"1px solid #33434F",borderRadius:12,padding:24,width:560,maxWidth:"100%",maxHeight:"90vh",overflowY:"auto"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
        <div>
          <div style={{fontSize:15,fontWeight:800,color:"#5BA3FF",letterSpacing:".06em"}}>📦 BEAM REGISTER</div>
          <div style={{fontSize:11,color:"#8DA0AD",marginTop:3}}>Quick register a beam from the dipping floor</div>
        </div>
        <button onClick={onClose} style={{background:"none",border:"none",color:"#8DA0AD",fontSize:22,cursor:"pointer"}}>×</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div><label style={lbl}>Beam No *</label><input style={inp} value={f.beam_no} onChange={e=>{setF({...f,beam_no:e.target.value});setErr("");}}/></div>
        <div><label style={lbl}>Load Type *</label>
          <select style={inp} value={f.load_type} onChange={e=>setF({...f,load_type:e.target.value})}>
            {TYPES.map(t=><option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={{gridColumn:"1 / -1"}}><label style={lbl}>Part No(s) *</label><input style={inp} placeholder="e.g. P-1234, P-5678" value={f.part_nos} onChange={e=>setF({...f,part_nos:e.target.value})}/></div>
        <div><label style={lbl}>Thickness / Section</label><input style={inp} value={f.section} onChange={e=>setF({...f,section:e.target.value})}/></div>
        <div><label style={lbl}>Weight (MT) *</label><input type="number" step="0.001" style={inp} value={f.total_weight} onChange={e=>setF({...f,total_weight:e.target.value})}/></div>
        {!isLengthless(f.load_type) && <div><label style={lbl}>Length (mm)</label><input type="number" style={inp} value={f.length_mm} onChange={e=>setF({...f,length_mm:e.target.value})}/></div>}
        <div><label style={lbl}>Coating Required *</label>
          <select style={inp} value={f.coating_required} onChange={e=>setF({...f,coating_required:e.target.value})}>
            {COATS.map(c=><option key={c} value={c}>{c} μm</option>)}
          </select>
        </div>
      </div>

      {isAdmin && <div style={{marginTop:16,border:"1px solid #33434F",borderRadius:8,padding:14,background:"#0A1220"}}>
        <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
          <input type="checkbox" checked={backdate} onChange={e=>{
            const on=e.target.checked;
            if(on && !bd.immersion_start){
              const now=toTzInputValue(new Date().toISOString());
              setBd(p=>({...p,loaded_at:now,immersion_start:now}));
            }
            setBackdate(on);setErr("");
          }}/>
          <span style={{fontSize:12,fontWeight:800,color:"#3D7EA6",letterSpacing:".04em"}}>BACKDATED ENTRY (ADMIN)</span>
        </label>
        <div style={{fontSize:10,color:"#8DA0AD",marginTop:4}}>Record a beam processed on a past date with its exact dipping timestamps — hh:mm:ss in plant time ({APP_TZ_LABEL}). Current plant time: <b style={{color:"#8FA8C8"}}>{fmtDateTimeTz(new Date().toISOString())}</b></div>
        {backdate && <>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:12}}>
            {[
              ["Loaded Date & Time","loaded_at"],
              ["Immersion Start *","immersion_start"],
              ["Immersion End","immersion_end"],
              ["Reaction End","reaction_end"],
              ["Withdrawal End","withdrawal_end"],
            ].map(([label,key])=>(
              <div key={key as string}>
                <label style={lbl}>{label}</label>
                <input type="datetime-local" step="1" style={{...inp,fontFamily:"monospace"}}
                  value={(bd as any)[key as string]||""}
                  onChange={e=>{setBd(p=>({...p,[key as string]:e.target.value}));setErr("");}}/>
              </div>
            ))}
            <div><label style={lbl}>Zinc Bath Temp (°C)</label>
              <input type="number" step="0.1" style={inp} value={String(bd.bath_temperature??"")}
                onChange={e=>setBd(p=>({...p,bath_temperature:e.target.value}))}/></div>
            <div><label style={lbl}>Dipping Operator</label>
              <input style={inp} value={bd.dipping_operator||""} onChange={e=>setBd(p=>({...p,dipping_operator:e.target.value}))}/></div>
            <div><label style={lbl}>Shift Supervisor</label>
              <input style={inp} value={bd.shift_supervisor||""} onChange={e=>setBd(p=>({...p,shift_supervisor:e.target.value}))}/></div>
            <div><label style={lbl}>Surface Condition</label>
              <select style={inp} value={bd.surface_condition||""} onChange={e=>setBd(p=>({...p,surface_condition:e.target.value}))}>
                <option value="">— select —</option>
                {["Normal","Rusted","Heavy Rusted"].map(s=><option key={s} value={s}>{s}</option>)}
              </select></div>
          </div>
          <div style={{marginTop:12,padding:"9px 12px",borderRadius:6,background:"#16202B",border:"1px solid #33434F",fontSize:11,color:"#8FA8C8",display:"flex",flexWrap:"wrap",gap:14}}>
            {bdPreview ? <>
              <span>Immersion: <b style={{color:"#C9D6DF"}}>{fmtDur(bdPreview.immersion_duration)}</b></span>
              <span>Reaction: <b style={{color:"#C9D6DF"}}>{fmtDur(bdPreview.reaction_duration)}</b></span>
              <span>Withdrawal: <b style={{color:"#C9D6DF"}}>{fmtDur(bdPreview.withdrawal_duration)}</b></span>
              <span>Total Cycle: <b style={{color:"#5BA3FF"}}>{fmtDur(backdatedCycleSecs(bd))}</b></span>
              <span>Status: <b style={{color:"#3D7EA6"}}>{(bdResult as any).status.replace("_"," ")}</b></span>
            </> : <span style={{color:"#FB923C"}}>⚠ {(bdResult as any)?.error||"Enter the dipping timestamps"}</span>}
          </div>
        </>}
      </div>}

      {err && <div style={{color:"#F87171",fontSize:12,marginTop:14,padding:"8px 12px",background:"#220808",borderRadius:6}}>⚠ {err}</div>}

      <div style={{display:"flex",gap:10,marginTop:20,justifyContent:"flex-end"}}>
        <button onClick={onClose} style={{padding:"10px 20px",background:"transparent",border:"1px solid #33434F",color:"#8DA0AD",borderRadius:6,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>CANCEL</button>
        <button onClick={submit} style={{padding:"10px 22px",background:"linear-gradient(135deg,#5BA3FF,#1D6FE8)",border:"none",color:"#000",borderRadius:6,fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"inherit",letterSpacing:".04em"}}>＋ REGISTER BEAM</button>
      </div>
    </div>
  </div>;
}

function QCTab({beams,setBeams,addAudit,user,readOnly=false,T,qcRanges,setQcRanges,dippingConfig,fieldConfig}){
  const benchCfg = buildBenchmarkCfg(dippingConfig, fieldConfig);
  const isAdmin = user?.role==="admin";
  const canEditQC = !!dippingConfig?.allowQCEdit || isAdmin;
  const available=beams.filter(b=>b.status==="QC_PENDING" && beamEnabled(b));
  const [sel,ss]=useState("");
  const [v2Str,setV2Str]=useState<Record<string,string[]>>(()=>emptyV2Strings());
  const [remark,sr]=useState("");
  const [msg,sm]=useState(null);
  const [editQCBeam,setEditQCBeam]=useState<any>(null);

  // Per-beam drafts so the 30 readings + remark survive a refresh / phone
  // call / browser kill mid-inspection. Cleared on successful submit or
  // explicit beam switch.
  const beamsPending = usePendingCount("beams");
  useDraft(user?.id, sel ? `coj:${sel}:v2` : "coj:none:v2",
    v2Str, setV2Str as any, { enabled: !!sel });
  useDraft(user?.id, sel ? `coj:${sel}:remark` : "coj:none:remark",
    remark, sr, { enabled: !!sel });
  const clearCojDrafts = (beamTxn?: string) => {
    try {
      const uid = user?.id; if (!uid) return;
      const t = beamTxn ?? sel; if (!t) return;
      clearDraft(uid, `coj:${t}:v2`);
      clearDraft(uid, `coj:${t}:remark`);
    } catch {}
  };

  const beam=beams.find(b=>txn(b)===sel);
  const v2Valid = validateV2Strings(v2Str);
  const allFilled = v2Valid.ok;
  const v2Obj = useMemo(()=>stringsToV2(v2Str),[v2Str]);
  const v2Subs = useMemo(()=>v2SubAverages(v2Obj),[v2Obj]);
  const avgVal = allFilled ? v2TotalAverage(v2Obj) : null;
  const autoR = beam && avgVal!=null ? getAutoRemark(beam.coating_required, avgVal) : null;
  const v2Mm = useMemo(()=>allFilled?v2MinMax(v2Obj):{min:null,max:null},[v2Obj,allFilled]);
  const minV = v2Mm.min;
  const maxV = v2Mm.max;
  const rangeV = minV!=null && maxV!=null ? (maxV-minV).toFixed(2) : null;

  function updateV2(group:string, idx:number, val:string){
    setV2Str(prev=>{
      const arr = [...(prev[group]||["","","","","",""]).slice(0,5)];
      arr[idx] = val;
      return { ...prev, [group]: arr };
    });
  }

  const capOn = fieldConfig?.cojReadingMaxEnabled !== false;
  const capMax = Number(fieldConfig?.cojReadingMax) || 500;

  function submitQC(){
    if(!sel||!beam){sm({ok:false,text:"⚠ Select a beam"});return;}
    if(!allFilled){sm({ok:false,text:`⚠ ${v2Valid.reason || "Enter all 30 Elcometer readings (must be > 0)"}`});return;}
    if(capOn){
      const over = v2OverCap(v2Str, capMax);
      if(over){sm({ok:false,text:`⚠ Reading exceeds max ${capMax} μm (${over.group.toUpperCase()} R${over.idx+1})`});return;}
    }
    if(!autoR){sm({ok:false,text:"⚠ Cannot determine QC — check coating requirement"});return;}
    const now=nowISO();
    const avgFinal=parseFloat((avgVal as number).toFixed(2));
    const updated={...beam,
      elcometer:null, elcometer_v2:v2Obj, avg_reading:avgFinal,
      qc_remark:remark,qc_status:autoR.status,qc_auto_remark:autoR.text,
      qc_completed_by:user.id,qc_completed_by_name:user.full_name,
      qc_completed_at:now,status:"COMPLETED"};
    const bench=computeBenchmark(updated,beams,benchCfg);
    setBeams(prev=>prev.map(b=>txn(b)===sel?{...updated,benchmark:bench}:b));
    const benchTag = bench?.ref_beam_no ? ` · Δ ${bench.difference>0?"+":""}${bench.difference}μm vs ref ${bench.ref_beam_no}` : (bench?.status==="Match Not Available" ? " · No best match" : "");
    addAudit(user.id,user.full_name,"CoJ","quality",`${sel}: ${autoR.status} — ${autoR.text} — avg ${avgFinal}μm${benchTag}`);
    const syncing = pendingCountForTable("beams") > 0;
    sm({ok:autoR.status==="PASS",text:`${autoR.status==="PASS"?"✅":"❌"} ${sel}: ${autoR.status} — ${autoR.text} | Avg ${avgFinal} μm${benchTag}${syncing?" · syncing…":""}`,benchmark:bench});
    clearCojDrafts(sel);
    ss(""); setV2Str(emptyV2Strings()); sr(""); setTimeout(()=>sm(null),9000);
  }



  const qcDone=beams.filter(b=>b.status==="COMPLETED"&&b.qc_status).sort((a,b)=>new Date(b.qc_completed_at)-new Date(a.qc_completed_at));
  const QCR=Object.fromEntries(Object.entries(qcRanges||{}).map(([k,r]:any)=>[k,`${r.min}–${r.ok_max} μm → OK  |  >${r.ok_max} μm → High Coating  |  <${r.min} μm → FAIL`]));
  const PT_POS=["Top-L","Top-C","Top-R","Mid","Bot-L","Bot-C","Bot-R"];

  return <div>
    {readOnly&&<div style={{padding:"10px 16px",background:"#0A1A10",border:"1px solid #1A3A20",borderRadius:8,marginBottom:14,display:"flex",alignItems:"center",gap:10,fontSize:12,color:"#4ADE80"}}><span style={{fontSize:16}}>👁</span><strong>SUPERVISOR VIEW — READ ONLY</strong><span style={{color:"#5C7482",marginLeft:4}}>You can see all QC records. Contact QC Inspector to add results.</span></div>}
    {isAdmin && setQcRanges && (
      <div style={{padding:"12px 16px",background:"#1A1200",border:"1px solid #3A2800",borderRadius:8,marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <span style={{fontSize:14}}>⚙</span>
          <strong style={{fontSize:12,color:"#3D7EA6",letterSpacing:".06em"}}>ADMIN — COATING RANGE EDITOR</strong>
          <span style={{fontSize:10,color:"#8DA0AD"}}>Changes apply immediately to PASS / HIGH / FAIL logic</span>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          {Object.keys(qcRanges).map((k)=>{
            const r=qcRanges[k];
            return <div key={k} style={{padding:"10px 12px",background:"#0A0F18",border:"1px solid #33434F",borderRadius:6}}>
              <div style={{fontSize:11,fontWeight:800,color:"#3D7EA6",marginBottom:6}}>{k} μm Spec</div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <label style={{fontSize:9,color:"#8DA0AD"}} htmlFor={`min-${k}`}>Min</label>
                <input id={`min-${k}`} type="number" value={r.min} onChange={e=>setQcRanges({...qcRanges,[k]:{...r,min:parseFloat(e.target.value)||0}})} style={{width:64,padding:"4px 6px",background:"#0F1720",border:"1px solid #33434F",color:"#C9D6DF",borderRadius:4,fontFamily:"monospace",fontSize:12}} aria-label={`Minimum acceptable coating for ${k} micron spec`}/>
                <label style={{fontSize:9,color:"#8DA0AD"}} htmlFor={`max-${k}`}>OK Max</label>
                <input id={`max-${k}`} type="number" value={r.ok_max} onChange={e=>setQcRanges({...qcRanges,[k]:{...r,ok_max:parseFloat(e.target.value)||0}})} style={{width:64,padding:"4px 6px",background:"#0F1720",border:"1px solid #33434F",color:"#C9D6DF",borderRadius:4,fontFamily:"monospace",fontSize:12}} aria-label={`Upper OK threshold for ${k} micron spec`}/>
              </div>
              <div style={{fontSize:9,color:"#3A4F70",marginTop:4}}>&lt;{r.min}=FAIL · {r.min}–{r.ok_max}=OK · &gt;{r.ok_max}=HIGH</div>
            </div>;
          })}
        </div>
      </div>
    )}
    {/* Header */}
    <div style={{background:"linear-gradient(135deg,#0A1A10,#0D2818)",border:"1px solid #1A3820",
      borderRadius:10,padding:"16px 22px",marginBottom:16,
      display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
      <div style={{display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:48,height:48,borderRadius:10,background:"linear-gradient(135deg,#22C55E,#15803D)",
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,
          boxShadow:"0 0 20px rgba(34,197,94,.4)"}}>✅</div>
        <div>
          <div style={{fontSize:15,fontWeight:800,color:"#C9D6DF",letterSpacing:".06em"}}>COATING ON JOB</div>
          <div style={{fontSize:11,color:"#8DA0AD",marginTop:2}}>30-Point Elcometer — IS 2629 / ISO 1461 Coating Verification</div>
        </div>
      </div>
      <div style={{display:"flex",gap:8}}>
        {[[qcDone.filter(b=>b.qc_auto_remark==="OK").length,"OK","#0A2218","#4ADE80"],
          [qcDone.filter(b=>b.qc_auto_remark==="High Coating").length,"HIGH","#2A1E00","#FBBF24"],
          [qcDone.filter(b=>b.qc_auto_remark==="Below Minimum").length,"FAIL","#2A0808","#F87171"],
          [available.length,"PENDING","#0E1E3A","#5BA3FF"]].map(([v,l,bg,col])=>(
          <div key={l} style={{textAlign:"center",background:bg,border:`1px solid ${col}30`,borderRadius:8,padding:"8px 14px",minWidth:64}}>
            <div style={{fontSize:20,fontWeight:800,color:col,fontFamily:"monospace",lineHeight:1}}>{v}</div>
            <div style={{fontSize:9,color:"#8DA0AD",marginTop:2,fontWeight:700}}>{l}</div>
          </div>
        ))}
      </div>
    </div>

    {/* Inspection card */}
    <div style={{display:readOnly?"none":"block"}}><div style={{background:"#1E2A36",border:`2px solid ${beam?"#22C55E30":"#33434F"}`,
      borderRadius:12,marginBottom:18,overflow:"hidden"}}>
      <div style={{background:"linear-gradient(90deg,#0A1A0E,#1E2A36)",borderBottom:"1px solid #33434F",
        padding:"14px 20px",display:"flex",alignItems:"center",gap:10}}>
        <div style={{width:8,height:8,borderRadius:"50%",background:beam?"#22C55E":"#33434F",
          boxShadow:beam?"0 0 8px #22C55E":"none"}}/>
        <span style={{fontSize:13,fontWeight:700,color:"#C9D6DF"}}>30-POINT ELCOMETER INSPECTION</span>
      </div>

      <div style={{padding:20}}>
        <div style={{marginBottom:16}}>
          <label style={{fontSize:11,color:"#8DA0AD",fontWeight:700,letterSpacing:".08em",textTransform:"uppercase",display:"block",marginBottom:8}}>
            Select Beam <span style={{color:"#3D7EA6"}}>*</span>
            <span style={{fontSize:9,fontWeight:400,color:"#3A4F70",marginLeft:8}}>({available.length} awaiting QC)</span>
          </label>
          <DSel dark value={sel} onChange={e=>{
            const next = e.target.value; const prev = sel;
            if (prev && prev !== next) {
              const hasData = Object.values(v2Str).some(arr=>arr.some(v=>v!=="")) || !!remark;
              if (hasData) {
                const prevBeam = beams.find((b:any)=>txn(b)===prev);
                const label = prevBeam?.beam_no || prev;
                const ok = window.confirm(`Discard unsaved QC readings for beam ${label} and switch?`);
                if (!ok) return;
              }
              clearCojDrafts(prev);
            }
            ss(next);
            setV2Str(emptyV2Strings());
            sr("");
          }}>
            <option value="">— Select Dipped Beam Awaiting QC —</option>
            {available.map(b=><option key={txn(b)} value={txn(b)}>
              {b.beam_no}  |  {b.load_type}  |  {b.part_nos}  |  Req: {b.coating_required}μm  |  Dipped: {fmt12(b.dipped_at)}
            </option>)}
          </DSel>
        </div>

        {beam&&<>
          {/* Auto-fetched info grid */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,
            padding:14,background:"#060E10",border:"1px solid #0E2A20",borderRadius:10,marginBottom:14}}>
            {[["Beam No",beam.beam_no,"#3D7EA6"],["Load Type",beam.load_type,"#FB923C"],
              ["Part No(s)",beam.part_nos,"#5BA3FF"],["Dipped Parts",beam.dipped_parts||"All","#4ADE80"],
              ["Coating Req.",beam.coating_required+" μm","#A78BFA"],
              ["Thickness",beam.section||"—","#8DA0AD"],["Weight",beam.total_weight+" MT","#22D3EE"],
              ["Length",beam.length_mm?beam.length_mm+" mm":"—","#FDE047"],
              ["Dip Duration",fmtDur(calcSecs(beam.immersion_start,beam.withdrawal_end)),"#FB923C"],
              ["Dipped At",fmt12(beam.dipped_at),"#8DA0AD"],["By",beam.dipped_by_name||"—","#8DA0AD"],
              ["Entry Mode", beam.entry_mode==="manual"?"Manual":"Live", beam.entry_mode==="manual"?"#FB923C":"#4ADE80"]
            ].map(([k,v,col])=>(
              <div key={k} style={{padding:"8px 10px",background:"#0A1520",borderRadius:6,border:"1px solid #33434F"}}>
                <div style={{fontSize:9,color:"#5C7482",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4}}>{k}</div>
                <div style={{fontSize:11,color:col,fontWeight:700,fontFamily:"monospace",wordBreak:"break-all"}}>{v||"—"}</div>
              </div>
            ))}
          </div>

          {/* QC spec */}
          <div style={{padding:"10px 14px",background:"#16202B",border:"1px solid #0E2A40",
            borderRadius:8,marginBottom:16,fontSize:11,color:"#C9D6DF",fontFamily:"monospace"}}>
            <span style={{color:"#3A4F70",marginRight:10}}>SPEC {beam.coating_required}μm:</span>
            {QCR[beam.coating_required]}
          </div>

          {/* 30-point grid — FW / MW / LW × Outside / Inside × 5 readings */}
          <div style={{fontSize:11,color:"#8DA0AD",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:12}}>
            30-Point Elcometer Readings (μm) <span style={{color:"#3D7EA6"}}>*</span>
            <span style={{fontSize:9,fontWeight:400,color:"#3A4F70",marginLeft:8}}>3 withdrawals × Outside & Inside × 5 readings</span>
          </div>
          {V2_GROUPS.map(g=>(
            <div key={g.key} style={{marginBottom:12,padding:"10px 12px",background:"#060E18",border:"1px solid #0E2A20",borderRadius:8}}>
              <div style={{fontSize:11,fontWeight:800,color:"#4ADE80",letterSpacing:".05em",marginBottom:8}}>{g.label}</div>
              {V2_SIDES.map(s=>{
                const gk = `${g.key}_${s.key}`;
                const arr = v2Str[gk] || ["","","","","",""];
                const nums = arr.map(Number).filter(n=>Number.isFinite(n)&&n>0);
                const rowAvg = nums.length===5 ? nums.reduce((a,b)=>a+b,0)/5 : null;
                return (
                  <div key={gk} style={{marginBottom:8}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <span style={{fontSize:10,fontWeight:700,color:"#8AA3C0",textTransform:"uppercase",letterSpacing:".05em",minWidth:60}}>{s.label}</span>
                      {rowAvg!=null && <span style={{fontSize:10,fontFamily:"monospace",color:"#4ADE80",fontWeight:800}}>Avg {rowAvg.toFixed(2)} μm</span>}
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
                      {[0,1,2,3,4].map(i=>{
                        const v=arr[i]||""; const n=Number(v); const filled=v!==""&&!isNaN(n)&&n>0;
                        const overCap = capOn && filled && n>capMax;
                        const ar=filled&&!overCap&&beam?getAutoRemark(beam.coating_required,n):null;
                        const brd = overCap ? "#F87171" : (filled?(ar?.color||"#4ADE80"):"#33434F");
                        const bg  = overCap ? "#200808" : (filled?(ar?.status==="FAIL"?"#200808":ar?.text==="High Coating"?"#1A1400":"#0A2010"):"#16202B");
                        const col = overCap ? "#F87171" : (filled?(ar?.color||"#4ADE80"):"#8DA0AD");
                        return (
                          <div key={i}>
                            <div style={{fontSize:8,color:"#3A4F70",fontWeight:700,textAlign:"center",marginBottom:3}}>R{i+1}</div>
                            <input type="number" step="0.1" min="0" max={capOn?capMax:undefined} value={v}
                              onChange={e=>updateV2(gk,i,e.target.value)} placeholder="0.0"
                              style={{width:"100%",padding:"10px 2px",borderRadius:6,fontSize:14,fontWeight:900,fontFamily:"monospace",textAlign:"center",outline:"none",boxSizing:"border-box",background:bg,border:`2px solid ${brd}`,color:col,boxShadow:filled?`0 0 6px ${brd}30`:"none"}}/>
                            {overCap && <div style={{textAlign:"center",marginTop:2,fontSize:8,color:"#F87171",fontWeight:700}}>Max {capMax}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {/* Six sub-averages tile */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
            {[
              ["FW Outside Average", v2Subs.fwOut],
              ["FW Inside Average", v2Subs.fwIn],
              ["MW Upper Average", v2Subs.mwOut],
              ["MW Inside Average", v2Subs.mwIn],
              ["LW Outside Average", v2Subs.lwOut],
              ["LW Inside Average", v2Subs.lwIn],

            ].map(([lbl,val])=>(
              <div key={lbl as string} style={{padding:"7px 9px",background:"#0A1520",borderRadius:5,border:"1px solid #33434F",textAlign:"center"}}>
                <div style={{fontSize:8,color:"#8DA0AD",fontWeight:700,textTransform:"uppercase",letterSpacing:".05em"}}>{lbl as string}</div>
                <div style={{fontSize:14,fontWeight:900,fontFamily:"monospace",color:val!=null?"#4ADE80":"#3A4F70"}}>{val!=null?(val as number).toFixed(2):"—"}</div>
              </div>
            ))}
          </div>


          {/* Result summary */}
          {avgVal!=null&&<div style={{display:"flex",gap:16,padding:"16px 20px",
            background:autoR?.status==="PASS"?"#071A0A":"#1A0707",
            border:`2px solid ${autoR?.color||"#33434F"}50`,borderRadius:10,marginBottom:16,
            alignItems:"center",flexWrap:"wrap"}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:10,color:T.muted,textTransform:"uppercase",fontWeight:700,marginBottom:4}}>Total Average (30-pt)</div>
              <div style={{fontSize:32,fontWeight:900,fontFamily:"monospace",color:autoR?.color||T.amber,lineHeight:1}}>{avgVal.toFixed(2)}</div>
              <div style={{fontSize:10,color:T.muted}}>μm</div>
            </div>
            {[[minV?.toFixed(2),"Min"],[maxV?.toFixed(2),"Max"],[rangeV,"Range"]].map(([v,l])=>(
              <div key={l} style={{textAlign:"center"}}>
                <div style={{fontSize:10,color:T.muted,textTransform:"uppercase",fontWeight:700,marginBottom:4}}>{l}</div>
                <div style={{fontSize:18,fontWeight:800,fontFamily:"monospace",color:"#C9D6DF"}}>{v}</div>
              </div>
            ))}
            {autoR&&<div style={{marginLeft:"auto",textAlign:"center",padding:"14px 24px",
              background:autoR.status==="PASS"?"#0D2A10":"#2A0D0D",
              border:`2px solid ${autoR.color}`,borderRadius:10,boxShadow:`0 0 20px ${autoR.color}40`}}>
              <div style={{fontSize:28,fontWeight:900,fontFamily:"monospace",color:autoR.color,letterSpacing:".08em"}}>{autoR.status}</div>
              <div style={{fontSize:14,color:autoR.color,fontWeight:700,marginTop:2}}>{autoR.text}</div>
              <div style={{fontSize:9,color:T.muted,marginTop:4}}>AUTO-GENERATED</div>
            </div>}
          </div>}

          <div style={{marginBottom:16}}>
            <label style={{fontSize:11,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:8}}>Inspector Remark</label>
            <DTa dark value={remark} onChange={e=>sr(e.target.value)} placeholder="Surface condition, defects, areas of concern..." style={{minHeight:48}}/>
          </div>
        </>}

        {msg&&<Alert ok={msg?.ok} msg={msg?.text} onClose={()=>sm(null)}/>}
        {msg?.benchmark && <BenchmarkPanel beam={{benchmark: msg.benchmark}} T={T}/>}
        {beamsPending>0 && <div style={{margin:"0 0 10px",padding:"8px 12px",background:"#2A1E00",border:"1px solid #4A4000",borderRadius:6,fontSize:11,color:"#FDE047",fontWeight:700,display:"flex",alignItems:"center",gap:8}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:"#FDE047",boxShadow:"0 0 8px #FDE047",animation:"pulse 1.2s infinite"}}/>
          QUEUED — {beamsPending} pending change{beamsPending===1?"":"s"} will sync when connection is stable
        </div>}
        {beam&&<button onClick={submitQC} style={{width:"100%",padding:"14px 0",fontSize:15,fontWeight:800,
          background:"linear-gradient(135deg,#22C55E,#15803D)",color:"#fff",border:"none",
          borderRadius:8,cursor:"pointer",letterSpacing:".06em",fontFamily:"inherit",
          boxShadow:"0 4px 16px rgba(34,197,94,.3)"}}>✅  SUBMIT QC RESULT</button>}
      </div>
    </div>

    </div>{/* end qc readOnly wrapper */}
    {/* QC Records */}
    <div style={{background:"#1E2A36",border:"1px solid #33434F",borderRadius:12,overflow:"hidden"}}>
      <div style={{background:"#0F1720",borderBottom:"1px solid #33434F",padding:"12px 18px"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#C9D6DF"}}>Coating on Job Records — Elcometer</div>
        <div style={{fontSize:10,color:"#3A4F70",marginTop:2}}>IS 2629 / ISO 1461 — Showing latest {Math.min(20,qcDone.length)} of {qcDone.length} — New records = 30-point (5×6) · Legacy = 7-point</div>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr style={{background:"#0F1720"}}>
            {["Beam No","Type","Material","Surface","Part No(s)","Req μm","Readings (P1–P7 · legacy) / 6 Sub-Averages (v2)","Avg","Min","Max","Cycle Time","Decision","Status","Best Match","AI Prediction vs Actual","By","At",...(canEditQC?["Edit"]:[])].map(h=>(
              <th key={h} style={{padding:"9px 12px",textAlign:"left",color:"#3A4F70",fontWeight:700,fontSize:10,letterSpacing:".06em",textTransform:"uppercase",borderBottom:"1px solid #33434F",whiteSpace:"nowrap"}}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {qcDone.length===0&&<tr><td colSpan={canEditQC?18:17} style={{padding:32,textAlign:"center",color:"#5C7482",fontSize:12}}>No QC records yet</td></tr>}
            {qcDone.slice(0,20).map(b=>{
              const v2 = isV2Coj(b);
              const subs = v2 ? v2SubAverages(b.elcometer_v2) : null;
              const mm = v2 ? v2MinMax(b.elcometer_v2) : null;
              const legacyE = Array.isArray(b.elcometer) ? b.elcometer : [];
              return (
              <tr key={txn(b)} style={{borderBottom:"1px solid #1E2A36",transition:"background .1s"}}
                onMouseEnter={e=>e.currentTarget.style.background="#111C2E"}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <td style={{padding:"9px 12px"}}><span style={{fontFamily:"monospace",fontSize:13,fontWeight:800,color:"#3D7EA6"}}>{b.beam_no}</span></td>
                <td style={{padding:"9px 12px"}}><span style={{fontSize:10,fontWeight:700,color:"#FB923C",background:"#33434F",padding:"2px 6px",borderRadius:3}}>{b.load_type}</span></td>
                <td style={{padding:"9px 12px"}}><span style={{fontSize:10,fontWeight:800,color:"#22D3EE",background:"#082430",border:"1px solid #22D3EE60",padding:"2px 6px",borderRadius:3,letterSpacing:".05em"}}>{b.material_type||"—"}</span></td>
                <td style={{padding:"9px 12px"}}><span style={{fontSize:10,fontWeight:700,color:"#F0ABFC"}}>{fmtSurface(b.surface_condition)}</span></td>
                <td style={{padding:"9px 12px",maxWidth:90}}><span style={{fontSize:10,color:"#5BA3FF",fontFamily:"monospace"}}>{b.part_nos||"—"}</span></td>
                <td style={{padding:"9px 12px"}}><span style={{fontFamily:"monospace",color:"#A78BFA",fontSize:11}}>{b.coating_required}μm</span></td>
                <td style={{padding:"9px 12px"}}>
                  {v2 && subs ? (
                    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                      {[["FW·O",subs.fwOut],["FW·I",subs.fwIn],["MW·O",subs.mwOut],["MW·I",subs.mwIn],["LW·O",subs.lwOut],["LW·I",subs.lwIn]].map(([lbl,v])=>(
                        <span key={lbl as string} style={{padding:"2px 5px",background:"#0A1520",border:"1px solid #33434F",borderRadius:3,fontFamily:"monospace",fontSize:10,color:"#4ADE80"}}>
                          <span style={{color:"#8DA0AD",marginRight:3}}>{lbl as string}</span>{v!=null?(v as number).toFixed(2):"—"}
                        </span>
                      ))}
                      <span style={{padding:"2px 5px",background:"#0A1014",border:"1px solid #33434F",borderRadius:3,fontFamily:"monospace",fontSize:9,color:"#8DA0AD"}}>30-pt</span>
                    </div>
                  ) : (
                    <div style={{display:"flex",gap:4}}>
                      {[0,1,2,3,4,5,6].map(i=><span key={i} style={{fontFamily:"monospace",fontSize:11,color:"#8DA0AD",minWidth:26,textAlign:"center"}}>{legacyE[i]??'—'}</span>)}
                      <span style={{padding:"1px 4px",background:"#0A1014",border:"1px solid #33434F",borderRadius:3,fontFamily:"monospace",fontSize:9,color:"#8DA0AD",marginLeft:4}}>7-pt</span>
                    </div>
                  )}
                </td>
                <td style={{padding:"9px 12px"}}><strong style={{fontFamily:"monospace",fontSize:13,color:b.qc_auto_remark==="Below Minimum"?"#F87171":b.qc_auto_remark==="High Coating"?"#FBBF24":"#4ADE80"}}>{b.avg_reading}</strong></td>
                <td style={{padding:"9px 12px"}}><span style={{fontFamily:"monospace",fontSize:11,color:"#8DA0AD"}}>{v2&&mm?.min!=null?mm.min.toFixed(2):(legacyE.filter(Boolean).length?Math.min(...legacyE.filter(Boolean)).toFixed(2):"—")}</span></td>
                <td style={{padding:"9px 12px"}}><span style={{fontFamily:"monospace",fontSize:11,color:"#8DA0AD"}}>{v2&&mm?.max!=null?mm.max.toFixed(2):(legacyE.filter(Boolean).length?Math.max(...legacyE.filter(Boolean)).toFixed(2):"—")}</span></td>

                <td style={{padding:"9px 12px",whiteSpace:"nowrap"}}><span style={{fontFamily:"monospace",fontSize:11,color:"#FB923C",fontWeight:700}} title="Total cycle time from Dipping (Immersion start → Withdrawal end)">{fmtDur(cycleSecs(b))}</span></td>
                <td style={{padding:"9px 12px",whiteSpace:"nowrap"}}>
                  <span style={{padding:"3px 8px",borderRadius:4,fontSize:10,fontWeight:700,
                    background:b.qc_auto_remark==="OK"?"#0A2218":b.qc_auto_remark==="High Coating"?"#2A1E00":"#2A0808",
                    color:b.qc_auto_remark==="OK"?"#4ADE80":b.qc_auto_remark==="High Coating"?"#FBBF24":"#F87171"}}>{b.qc_auto_remark}</span>
                </td>
                <td style={{padding:"9px 12px"}}><span style={{fontWeight:800,fontSize:12,color:b.qc_status==="PASS"?"#4ADE80":"#F87171"}}>{b.qc_status}</span></td>
                <td style={{padding:"9px 12px",whiteSpace:"nowrap"}} title={(()=>{const bm=b.benchmark||computeBenchmark(b,beams,benchCfg);return bm?.ref_beam_no?`Ref ${bm.ref_beam_no} (${bm.ref_avg}μm) · Δ ${bm.difference}μm · ${bm.status}`:(bm?.status==="Match Not Available"?"No historical beam meets the enabled criteria":"No benchmark");})()}>
                  {(() => {
                    const bm = b.benchmark || computeBenchmark(b, beams, benchCfg);
                    if (!bm) return <span style={{fontSize:10,color:"#3A4F70"}}>—</span>;
                    if (bm.status === "Match Not Available") {
                      return <span style={{padding:"3px 8px",borderRadius:4,fontSize:10,fontWeight:800,fontFamily:"monospace",background:"#3D7EA620",color:"#3D7EA6",border:"1px solid #3D7EA650"}}>No Match</span>;
                    }
                    if (bm.ref_beam_no && bm.difference!=null) {
                      const d = Number(bm.difference);
                      const c = d>0.05?"#3D7EA6":d<-0.05?"#4ADE80":"#8DA0AD";
                      const label = d>0.05?`+${d.toFixed(2)}μm`:d<-0.05?`${d.toFixed(2)}μm`:"≈";
                      return <span style={{padding:"3px 8px",borderRadius:4,fontSize:10,fontWeight:800,fontFamily:"monospace",background:c+"20",color:c,border:`1px solid ${c}50`}}>{label} · {bm.ref_beam_no}</span>;
                    }
                    return <span style={{fontSize:10,color:"#3A4F70"}}>—</span>;
                  })()}
                </td>
                <td style={{padding:"9px 12px",minWidth:220}}>
                  {(() => {
                    const secs = cycleSecs(b);
                    const avg = cojActualAverage(b);
                    const rows = validationRowsForBeam(b, {
                      actualSec: secs != null ? Number(secs) : null,
                      actualCoating: avg != null && Number.isFinite(Number(avg)) ? Number(Number(avg).toFixed(2)) : null,
                      productionDate: drProdDay(b),
                      shift: drShift(b),
                    });
                    if (!rows.length) return <span style={{fontSize:10,color:"#3A4F70",fontStyle:"italic"}}>No AI prediction</span>;
                    const scored = rows.filter((r:any) => r.overallAccuracy != null);
                    const best = scored.length
                      ? scored.slice().sort((x:any,y:any)=>(y.overallAccuracy!-x.overallAccuracy!)||((y.predictedSec??0)-(x.predictedSec??0)))[0].model
                      : null;
                    return (
                      <div style={{display:"flex",flexDirection:"column",gap:5}}>
                        {rows.map((r:any) => {
                          const isBest = best != null && r.model === best;
                          return (
                            <div key={r.model} style={{background:"#0A1520",border:`1px solid ${isBest?"#4ADE8060":"#33434F"}`,borderRadius:5,padding:"5px 8px",fontFamily:"monospace",fontSize:10,lineHeight:1.7}}>
                              <div style={{display:"flex",alignItems:"center",gap:6}}>
                                <span style={{fontWeight:800,color:"#7DD3FC",letterSpacing:".04em"}}>{r.modelLabel}</span>
                                {isBest && <span style={{fontSize:8,fontWeight:800,color:"#4ADE80",background:"#0A2218",border:"1px solid #4ADE8050",borderRadius:3,padding:"1px 5px",letterSpacing:".06em"}}>BEST MODEL</span>}
                              </div>
                              <div style={{color:"#8DA0AD"}}>Actual time <span style={{color:"#FB923C",fontWeight:700}}>{fmtDur(r.actualSec)}</span>{r.predictedSec!=null&&<> · predicted <span style={{color:"#8FA8CF"}}>{fmtDur(r.predictedSec)}</span></>}</div>
                              <div style={{color:"#8DA0AD"}}>Expected <span style={{color:"#A78BFA",fontWeight:700}}>{r.expectedCoating!=null?`${r.expectedCoating}μm`:"—"}</span> · Actual <span style={{color:"#C9D6DF",fontWeight:700}}>{r.actualCoating!=null?`${r.actualCoating}μm`:"—"}</span> · Error <span style={{color:r.coatingVariation!=null&&Math.abs(r.coatingVariation)<=3?"#4ADE80":"#3D7EA6",fontWeight:700}}>{r.coatingVariation!=null?`${r.coatingVariation>0?"+":""}${r.coatingVariation}μm`:"—"}</span></div>
                              <div style={{color:"#8DA0AD"}}>Accuracy <span style={{color:(r.overallAccuracy??0)>=85?"#4ADE80":(r.overallAccuracy??0)>=60?"#FBBF24":"#F87171",fontWeight:800}}>{r.overallAccuracy!=null?`${r.overallAccuracy}%`:"—"}</span>{r.coatingAccuracy!=null&&<span style={{color:"#3A4F70"}}> (coating {r.coatingAccuracy}%)</span>}</div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </td>
                <td style={{padding:"9px 12px",fontSize:11,color:"#8DA0AD",whiteSpace:"nowrap"}}>{b.qc_completed_by_name}</td>
                <td style={{padding:"9px 12px",fontSize:11,color:"#8DA0AD",whiteSpace:"nowrap"}}>{fmt12(b.qc_completed_at)}</td>
                {canEditQC && <td style={{padding:"9px 12px",whiteSpace:"nowrap"}}>
                  <button onClick={()=>setEditQCBeam(b)} title="Edit Coating on Job readings"
                    style={{background:"transparent",border:"1px solid #33434F",color:"#A78BFA",cursor:"pointer",fontSize:10,fontWeight:700,padding:"4px 8px",borderRadius:5}}>✎ Edit</button>
                  {Array.isArray(b.qc_history)&&b.qc_history.length>0 && <button
                    title={`Undo last QC edit (${b.qc_history.length} snapshot${b.qc_history.length>1?"s":""} saved)`}
                    onClick={()=>{
                      const hist=b.qc_history as any[]; const last=hist[hist.length-1];
                      if(!last||!confirm(`Undo last Coating on Job edit for ${b.beam_no}?\nRestore values from ${fmtDateTimeTz(last.edited_at)}.`)) return;
                      setBeams((prev:any)=>prev.map((x:any)=>txn(x)===txn(b)?{...x,...last.snapshot,qc_history:hist.slice(0,-1)}:x));
                      addAudit(user.id,user.full_name,"EDIT_QC_UNDO","quality",`Reverted Coating on Job on ${b.beam_no} (was edited by ${last.edited_by_name} at ${last.edited_at})`);
                      sm({ok:true,text:`↶ Reverted Coating on Job for ${b.beam_no}`}); setTimeout(()=>sm(null),4000);
                    }}
                    style={{marginLeft:6,background:"transparent",border:"1px solid #33434F",color:"#FB923C",cursor:"pointer",fontSize:10,fontWeight:700,padding:"4px 8px",borderRadius:5}}>↶ Undo</button>}
                </td>}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    {editQCBeam && <EditQCModal beam={editQCBeam} qcRanges={qcRanges} fieldConfig={fieldConfig} onClose={()=>setEditQCBeam(null)} onSave={(patch:any,diffSummary:string)=>{
      const snapshot = {
        elcometer: editQCBeam.elcometer, avg_reading: editQCBeam.avg_reading,
        qc_remark: editQCBeam.qc_remark, qc_status: editQCBeam.qc_status,
        qc_auto_remark: editQCBeam.qc_auto_remark,
        benchmark: editQCBeam.benchmark,
        data: editQCBeam.data,
      };
      const entry = {snapshot, edited_at: nowISO(), edited_by: user.id, edited_by_name: user.full_name, diff: diffSummary};
      const merged = {...editQCBeam, ...patch};
      const bench = computeBenchmark(merged, beams, benchCfg);
      setBeams((prev:any)=>prev.map((x:any)=>txn(x)===txn(editQCBeam)?{...x,...patch,benchmark:bench,qc_history:[...(x.qc_history||[]),entry]}:x));
      addAudit(user.id,user.full_name,"EDIT_QC","quality",`Edited Coating on Job for ${editQCBeam.beam_no}: ${diffSummary||"no field changes"}${bench?.ref_beam_no?` · Δ ${bench.difference>0?"+":""}${bench.difference}μm vs ref ${bench.ref_beam_no}`:(bench?.status==="Match Not Available"?" · No best match":"")}`);
      sm({ok:true,text:`✏ Coating on Job updated for ${editQCBeam.beam_no} — undo available`,benchmark:bench});
      setTimeout(()=>sm(null),6000);
      setEditQCBeam(null);
    }}/>}

  </div>;
}


function EditQCModal({beam,qcRanges,fieldConfig,onClose,onSave}:any){
  const capOn = fieldConfig?.cojReadingMaxEnabled !== false;
  const capMax = Number(fieldConfig?.cojReadingMax) || 500;
  const isV2Beam = isV2Coj(beam);

  // Legacy (7-point) state
  const [pts,setPts]=useState<string[]>(()=>(beam.elcometer||["","","","","","",""]).map((v:any)=>v==null?"":String(v)));
  // V2 (30-point) state
  const [v2s,setV2s]=useState<Record<string,string[]>>(()=> isV2Beam ? v2ToStrings(beam?.data?.elcometer_v2) : emptyV2Strings());

  const [remark,setRemark]=useState<string>(beam.qc_remark||"");
  const [err,setErr]=useState("");
  const [stage,setStage]=useState<"edit"|"confirm">("edit");

  // Compute avg
  let avgVal:number|null = null;
  let patch:any = null;
  const r = qcRanges?.[beam.coating_required];
  if (isV2Beam) {
    const val = validateV2Strings(v2s);
    if (val.ok) {
      const v2Obj = stringsToV2(v2s);
      avgVal = v2TotalAverage(v2Obj);
      const autoR=(avgVal!=null&&r)?(avgVal<r.min?{status:"FAIL",text:"Below Minimum",color:"#F87171"}:avgVal>r.ok_max?{status:"PASS",text:"High Coating",color:"#FBBF24"}:{status:"PASS",text:"OK",color:"#4ADE80"}):null;
      if (autoR && avgVal!=null) patch = {
        data: {...(beam.data||{}), elcometer_v2: v2Obj},
        avg_reading: parseFloat(avgVal.toFixed(2)),
        qc_remark: remark,
        qc_status: autoR.status,
        qc_auto_remark: autoR.text,
      };
    }
  } else {
    const allFilled=pts.every(v=>v!==""&&!isNaN(Number(v))&&Number(v)>0);
    avgVal = allFilled ? (pts.map(Number).reduce((a,b)=>a+b,0)/7) : null;
    const autoR=(avgVal!=null&&r)?(avgVal<r.min?{status:"FAIL",text:"Below Minimum",color:"#F87171"}:avgVal>r.ok_max?{status:"PASS",text:"High Coating",color:"#FBBF24"}:{status:"PASS",text:"OK",color:"#4ADE80"}):null;
    if (autoR && avgVal!=null) patch = {
      elcometer: pts.map(Number),
      avg_reading: parseFloat(avgVal.toFixed(2)),
      qc_remark: remark,
      qc_status: autoR.status,
      qc_auto_remark: autoR.text,
    };
  }
  const autoR = patch ? {status:patch.qc_status, text:patch.qc_auto_remark, color: patch.qc_status==="FAIL"?"#F87171":(patch.qc_auto_remark==="High Coating"?"#FBBF24":"#4ADE80")} : null;

  const oldAvg = Number(beam.avg_reading)||0;
  const changes: string[] = [];
  if (patch) {
    if (Math.abs((patch.avg_reading||0)-oldAvg) > 0.001) changes.push(`Avg: ${oldAvg} → ${patch.avg_reading}`);
    if (patch.qc_status !== beam.qc_status) changes.push(`Status: ${beam.qc_status} → ${patch.qc_status}`);
    if (patch.qc_auto_remark !== beam.qc_auto_remark) changes.push(`Decision: ${beam.qc_auto_remark} → ${patch.qc_auto_remark}`);
    if ((patch.qc_remark||"") !== (beam.qc_remark||"")) changes.push(`Remark updated`);
    if (isV2Beam) {
      const oldFlat = v2FlatReadings(beam?.data?.elcometer_v2||{fw:{out:[],in:[]},mw:{out:[],in:[]},lw:{out:[],in:[]}}).join(",");
      const newFlat = v2FlatReadings(patch.data.elcometer_v2).join(",");
      if (oldFlat !== newFlat) changes.push(`30 readings updated`);
    } else {
      const oldE=(beam.elcometer||[]).map((v:any)=>String(v??"")).join(",");
      const newE=(patch.elcometer||[]).join(",");
      if (oldE !== newE) changes.push(`Readings: [${oldE}] → [${newE}]`);
    }
  }
  const diffSummary=changes.join("; ");

  function validateAndConfirm(){
    setErr("");
    if (isV2Beam) {
      const val = validateV2Strings(v2s);
      if (!val.ok) return setErr(val.reason || "Fill all 30 readings (> 0)");
      if (capOn) {
        const hit = v2OverCap(v2s, capMax);
        if (hit) return setErr(`Reading exceeds max ${capMax} μm (${hit.group.toUpperCase()} #${hit.idx+1})`);
      }
    } else {
      const allFilled=pts.every(v=>v!==""&&!isNaN(Number(v))&&Number(v)>0);
      if(!allFilled) return setErr("Enter all 7 Elcometer readings (must be > 0)");
      if(capOn){
        const overIdx = pts.findIndex(v=>Number(v)>capMax);
        if(overIdx>=0) return setErr(`Reading at P${overIdx+1} exceeds max ${capMax} μm`);
      }
    }
    if(!autoR) return setErr("Cannot determine decision — check coating range config");
    setStage("confirm");
  }

  function updV2(gk:string,i:number,val:string){
    setV2s(p=>{const arr=[...(p[gk]||["","","","",""])];arr[i]=val;return {...p,[gk]:arr};});
  }

  const inp:React.CSSProperties = {width:"100%",background:"#16202B",border:"1px solid #33434F",color:"#C9D6DF",padding:"10px 6px",borderRadius:6,fontSize:14,fontFamily:"monospace",fontWeight:800,textAlign:"center"};
  const lbl:React.CSSProperties = {fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:5};

  const v2Subs = isV2Beam ? v2SubAverages(stringsToV2(v2s)) : null;

  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:"#1E2A36",border:"1px solid #33434F",borderRadius:12,padding:24,width:isV2Beam?860:680,maxWidth:"100%",maxHeight:"90vh",overflowY:"auto"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div>
          <div style={{fontSize:14,fontWeight:800,color:"#C9D6DF"}}>{stage==="edit"?`✎ Edit Coating on Job${isV2Beam?" (30-Point)":""}`:"⚠ Confirm Coating Changes"}</div>
          <div style={{fontSize:11,color:"#8DA0AD",marginTop:3}}>Beam <span style={{color:"#3D7EA6",fontFamily:"monospace",fontWeight:700}}>{beam.beam_no}</span> — Req {beam.coating_required}μm — {stage==="edit"?"avg & decision recalculate automatically":"review before saving"}</div>
        </div>
        <button onClick={onClose} style={{background:"transparent",border:"none",color:"#8DA0AD",cursor:"pointer",fontSize:20}}>✕</button>
      </div>
      {stage==="edit" ? <>
        {isV2Beam ? (
          <div style={{marginBottom:14}}>
            {V2_GROUPS.map(g=>(
              <div key={g.key} style={{marginBottom:10,padding:"8px 10px",background:"#16202B",border:"1px solid #33434F",borderRadius:8}}>
                <div style={{fontSize:11,fontWeight:800,color:"#8AA3C0",marginBottom:6,letterSpacing:".05em"}}>{g.label}</div>
                {V2_SIDES.map(s=>{
                  const gk = `${g.key}_${s.key}`;
                  const arr = v2s[gk] || ["","","","",""];
                  return (
                    <div key={s.key} style={{display:"grid",gridTemplateColumns:"90px repeat(5,1fr) 70px",gap:6,alignItems:"center",marginBottom:6}}>
                      <div style={{fontSize:10,color:"#8DA0AD",fontWeight:700,textTransform:"uppercase"}}>{s.key==="out"?(g.key==="lw"?"Upper":"Upper"):(g.key==="lw"?"Lower":"Inside")}</div>
                      {arr.map((v,i)=>{
                        const n=Number(v); const overCap = capOn && v!=="" && !isNaN(n) && n>capMax;
                        return <input key={i} type="number" step="0.1" min="0" max={capOn?capMax:undefined} value={v}
                          style={{...inp,padding:"8px 2px",fontSize:12, border:`1px solid ${overCap?"#F87171":"#33434F"}`, color:overCap?"#F87171":"#C9D6DF"}}
                          onChange={e=>updV2(gk,i,e.target.value)} placeholder="0.0"/>;
                      })}
                      {(() => {
                        const nums = arr.map(Number).filter(n=>Number.isFinite(n)&&n>0);
                        const a = nums.length===5 ? nums.reduce((a,b)=>a+b,0)/5 : null;
                        return <div style={{textAlign:"center",fontSize:11,fontWeight:800,fontFamily:"monospace",color:a!=null?"#4ADE80":"#3A4F70"}}>{a!=null?a.toFixed(2):"—"}</div>;
                      })()}
                    </div>
                  );
                })}
              </div>
            ))}
            {v2Subs && (
              <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:6,marginTop:6}}>
                {[["FW Upper",v2Subs.fwOut],["FW Inside",v2Subs.fwIn],["MW Upper",v2Subs.mwOut],["MW Inside",v2Subs.mwIn],["LW Upper",v2Subs.lwOut],["LW Lower",v2Subs.lwIn]].map(([k,v])=>(
                  <div key={k as string} style={{padding:"5px 6px",background:"#0A1520",borderRadius:4,border:"1px solid #33434F",textAlign:"center"}}>
                    <div style={{fontSize:8,color:"#8DA0AD",fontWeight:700}}>{k as string}</div>
                    <div style={{fontSize:11,color:v!=null?"#4ADE80":"#3A4F70",fontWeight:800,fontFamily:"monospace"}}>{v!=null?(v as number).toFixed(2):"—"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:8,marginBottom:14}}>
            {pts.map((v,i)=>{
              const n=Number(v); const overCap = capOn && v!=="" && !isNaN(n) && n>capMax;
              return <div key={i}>
                <label style={{...lbl,textAlign:"center"}}>P{i+1}</label>
                <input type="number" step="0.1" min="0" max={capOn?capMax:undefined} value={v}
                  style={{...inp, border:`1px solid ${overCap?"#F87171":"#33434F"}`, color:overCap?"#F87171":"#C9D6DF"}}
                  onChange={e=>setPts(p=>{const n=[...p];n[i]=e.target.value;return n;})}/>
                {overCap && <div style={{textAlign:"center",marginTop:3,fontSize:9,color:"#F87171",fontWeight:700}}>Max {capMax}μm</div>}
              </div>;
            })}
          </div>
        )}
        <div style={{marginBottom:14}}>
          <label style={lbl}>Inspector Remark</label>
          <textarea value={remark} onChange={e=>setRemark(e.target.value)}
            style={{width:"100%",background:"#16202B",border:"1px solid #33434F",color:"#C9D6DF",padding:"8px 10px",borderRadius:6,fontSize:12,minHeight:60,fontFamily:"inherit"}}/>
        </div>
        {avgVal!=null && autoR && <div style={{display:"flex",gap:14,padding:"12px 16px",background:autoR.status==="PASS"?"#071A0A":"#1A0707",border:`1px solid ${autoR.color}50`,borderRadius:8,marginBottom:10,alignItems:"center"}}>
          <div><div style={{fontSize:9,color:"#8DA0AD"}}>NEW AVG</div><div style={{fontSize:22,fontWeight:900,fontFamily:"monospace",color:autoR.color}}>{avgVal.toFixed(2)}μm</div></div>
          <div><div style={{fontSize:9,color:"#8DA0AD"}}>NEW STATUS</div><div style={{fontSize:16,fontWeight:800,color:autoR.color}}>{autoR.status} — {autoR.text}</div></div>
          <div style={{marginLeft:"auto",fontSize:10,color:"#8DA0AD"}}>Was: {beam.avg_reading}μm · {beam.qc_status} · {beam.qc_auto_remark}</div>
        </div>}
        {err && <div style={{marginTop:6,padding:"8px 12px",background:"#2A0A0A",border:"1px solid #5C1818",borderRadius:6,fontSize:11,color:"#FB7185"}}>⚠ {err}</div>}
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:14}}>
          <button onClick={onClose} style={{padding:"9px 16px",background:"transparent",color:"#8DA0AD",border:"1px solid #33434F",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>Cancel</button>
          <button onClick={validateAndConfirm} style={{padding:"9px 16px",background:"linear-gradient(135deg,#A78BFA,#7C3AED)",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:800}}>Review Changes →</button>
        </div>
      </> : <>
        <div style={{padding:"10px 12px",background:"#1A1408",border:"1px solid #5C3D18",borderRadius:6,fontSize:11,color:"#FBBF24",marginBottom:12}}>
          ⚠ You are about to overwrite the Coating on Job result. A snapshot will be saved so you can undo this change.
        </div>
        {changes.length===0
          ? <div style={{padding:"10px 12px",background:"#0A1320",borderRadius:6,fontSize:11,color:"#8DA0AD"}}>ℹ No values changed — save will still create an audit entry.</div>
          : <ul style={{margin:0,padding:"10px 16px 10px 28px",background:"#0A1320",borderRadius:6,fontSize:11,color:"#C9D6DF",lineHeight:1.7}}>
              {changes.map((c,i)=><li key={i}>{c}</li>)}
            </ul>}
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:18}}>
          <button onClick={()=>setStage("edit")} style={{padding:"9px 16px",background:"transparent",color:"#8DA0AD",border:"1px solid #33434F",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>← Back</button>
          <button onClick={()=>patch && onSave(patch,diffSummary)} style={{padding:"9px 16px",background:"linear-gradient(135deg,#16A34A,#15803D)",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:800}}>✓ Confirm & Save</button>
        </div>
      </>}
    </div>
  </div>;
}


function ReportsTab({beams:allBeamsRaw,setBeams=(_:any)=>{},aiDashboardEnabled=false,aiModels=[],mlrStore=null as any,aiTrainHistory=[],emailRecs,canExport=true,canEmail=false,operators=[],shiftSupervisors=[],T,isAdmin=false,deleteBeams=(_:string[])=>{},fieldConfig={},dippingConfig={}}:any){
  // Reports always include every beam — admin disable flag only affects the Dipping selector.
  const allBeams = useMemo(()=>allBeamsRaw.slice(),[allBeamsRaw]);
  // Best-Match config + view-time backfill for completed beams that pre-date
  // the benchmark feature (or were saved while the toggle was off).
  const benchCfg = useMemo(()=>buildBenchmarkCfg(dippingConfig, fieldConfig),[dippingConfig, fieldConfig]);
  const effBench = (b:any) => b?.benchmark || (b?.qc_status ? computeBenchmark(b, allBeams, benchCfg) : null);

  const [rpt,sr]=useState("hourly");
  const [date,sd]=useState(new Date().toISOString().slice(0,10));
  const [fromDate,setFromDate]=useState(new Date(Date.now()-13*864e5).toISOString().slice(0,10));
  const [toDate,setToDate]=useState(new Date().toISOString().slice(0,10));
  const [fltShift,setFltShift]=useState<string[]>([]);
  const [fltOperator,setFltOperator]=useState<string[]>([]);
  const [fltSupervisor,setFltSupervisor]=useState<string[]>([]);
  const [fltMicronMin,setFltMicronMin]=useState("");
  const [fltMicronMax,setFltMicronMax]=useState("");
  const [fltBeamNo,setFltBeamNo]=useState("");
  const [fltThickness,setFltThickness]=useState("");
  const [fltTempMin,setFltTempMin]=useState("");
  const [fltTempMax,setFltTempMax]=useState("");
  const [fltStatus,setFltStatus]=useState<string[]>([]);

  const [showFilters,setShowFilters]=useState(false);
  const [emailModal,se]=useState(false);
  const [emailScope,setEmailScope]=useState<string|undefined>(undefined);
  const [sent,ss]=useState(false);
  const [sending,setSending]=useState(false);
  const [sendErr,setSendErr]=useState<string|null>(null);
  const dark=true;

  // Non-date filters — shared by the global set and the Hourly production-day set
  const passesNonDateFilters = useCallback((b:any)=>{
    if(fltShift.length){ const s=(b.shift||"").split(" ")[0]; if(!fltShift.includes(s)) return false; }
    if(fltOperator.length && !fltOperator.includes(b.dipping_operator||"")) return false;
    if(fltSupervisor.length && !fltSupervisor.includes(b.shift_supervisor||"")) return false;
    if(fltStatus.length && !fltStatus.includes(b.status)) return false;

    if(fltBeamNo && !(b.beam_no||"").toLowerCase().includes(fltBeamNo.toLowerCase())) return false;
    if(fltThickness && String(b.section||"").toLowerCase()!==fltThickness.toLowerCase()) return false;
    const mn=parseFloat(fltMicronMin), mx=parseFloat(fltMicronMax);
    if(!isNaN(mn) || !isNaN(mx)){
      const v=Number(b.avg_reading);
      if(!v) return false;
      if(!isNaN(mn) && v<mn) return false;
      if(!isNaN(mx) && v>mx) return false;
    }
    const tmin=parseFloat(fltTempMin), tmax=parseFloat(fltTempMax);
    if(!isNaN(tmin) || !isNaN(tmax)){
      const v=Number(b.bath_temperature);
      if(!v) return false;
      if(!isNaN(tmin) && v<tmin) return false;
      if(!isNaN(tmax) && v>tmax) return false;
    }
    return true;
  },[fltShift,fltOperator,fltSupervisor,fltStatus,fltBeamNo,fltThickness,fltMicronMin,fltMicronMax,fltTempMin,fltTempMax]);

  // Apply all filters globally — Excel & email export inherit the same set
  const beams = useMemo(()=>allBeams.filter((b:any)=>{
    // Production-day range (06:00 → 06:00 plant time) — uses dipped_at if present, else loaded_at
    const ts=b.dipped_at||b.loaded_at||"";
    if(ts && !inProductionRange(ts,fromDate,toDate)) return false;
    return passesNonDateFilters(b);
  }),[allBeams,fromDate,toDate,passesNonDateFilters]);


  const activeFilters = useMemo(()=>{
    const out:[string,string][]=[];
    out.push(["Production Day Range",productionRangeLabel(fromDate,toDate)]);
    if(fltShift.length) out.push(["Shift",fltShift.join(", ")]);
    if(fltOperator.length) out.push(["Operator",fltOperator.join(", ")]);
    if(fltSupervisor.length) out.push(["Supervisor",fltSupervisor.join(", ")]);
    if(fltStatus.length) out.push(["Status",fltStatus.join(", ")]);
    if(fltBeamNo) out.push(["Beam No contains",fltBeamNo]);
    if(fltThickness) out.push(["Thickness",fltThickness]);
    if(fltMicronMin||fltMicronMax) out.push(["Micron Range",`${fltMicronMin||"−∞"} – ${fltMicronMax||"+∞"} μm`]);
    if(fltTempMin||fltTempMax) out.push(["Bath Temp Range",`${fltTempMin||"−∞"} – ${fltTempMax||"+∞"} °C`]);
    return out;
  },[fromDate,toDate,fltShift,fltOperator,fltSupervisor,fltStatus,fltBeamNo,fltThickness,fltMicronMin,fltMicronMax,fltTempMin,fltTempMax]);
  const activeFilterCount = activeFilters.length - 1; // exclude always-on date range
  function clearAllFilters(){
    setFltShift([]); setFltOperator([]); setFltSupervisor([]); setFltStatus([]);
    setFltBeamNo(""); setFltThickness(""); setFltMicronMin(""); setFltMicronMax(""); setFltTempMin(""); setFltTempMax("");
  }


  const recipients = useMemo(()=>{
    const all = new Set<string>();
    Object.values(emailRecs||{}).forEach((arr:any)=> (arr||[]).forEach((e:string)=> all.add(e)));
    return Array.from(all);
  },[emailRecs]);

  const dipped=beams.filter(b=>b.dipped_at);
  const completed=beams.filter(b=>b.status==="COMPLETED"&&b.qc_status);

  // Hourly Report — production day 06:00 → 06:00 (plant time), bucketed by
  // IMMERSION START TIME. e.g. immersion_start 07:59 → 07:00–08:00 bucket.
  const hourly=useMemo(()=>{
    const buckets=Array.from({length:24},(_,i)=>({
      idx:i, key:String(bucketHour(i)).padStart(2,"0")+":00",
      label:bucketLabel(i), nextDay:bucketIsNextDay(i), beams:[] as any[],
    }));
    allBeams
      .filter((b:any)=>b.dipped_at && b.immersion_start && passesNonDateFilters(b))
      .filter((b:any)=>productionDayIdTz(b.immersion_start)===date)
      .sort((a:any,b:any)=>String(a.immersion_start).localeCompare(String(b.immersion_start)))
      .forEach((b:any)=>{
        const i=productionHourIndex(b.immersion_start);
        if(i>=0) buckets[i].beams.push(b);
      });
    let cumCount=0, cumMT=0;
    const cumTypes:Record<string,number>={};
    const rows:any[]=[];
    for(const r of buckets){
      const mt=r.beams.reduce((s:number,b:any)=>s+(Number(b.total_weight)||0),0);
      cumCount+=r.beams.length; cumMT+=mt;
      r.beams.forEach((b:any)=>{ const t=b.load_type||"—"; cumTypes[t]=(cumTypes[t]||0)+1; });
      if(!r.beams.length) continue;
      rows.push({
        ...r, count:r.beams.length,
        totalMT:mt.toFixed(2),
        types:[...new Set(r.beams.map((b:any)=>b.load_type))].join(", "),
        beamNos:r.beams.map((b:any)=>b.beam_no).join(", "),
        cumCount,
        cumMT:cumMT.toFixed(2),
        cumTypes:Object.entries(cumTypes).map(([k,v])=>`${k} ${v}`).join(" · "),
      });
    }
    return rows;
  },[allBeams,passesNonDateFilters,date]);



  const shiftRpt=useMemo(()=>{
    const d2=dipped.filter(b=>productionDayIdTz(b.immersion_start||b.dipped_at)===date);
    const m:any={Day:[],Afternoon:[],Night:[]};
    d2.forEach(b=>{const s=autoShift(b.dipped_at).split(" ")[0];if(m[s])m[s].push(b);});
    return Object.entries(m).map(([shift,bs]:any)=>({
      shift,count:bs.length,
      totalMT:bs.reduce((s:number,b:any)=>s+b.total_weight,0).toFixed(2),
      avgDip:(()=>{const a=bs.map((b:any)=>cycleSecs(b)).filter((v:any)=>v!=null);return a.length?Math.round(a.reduce((s:number,v:number)=>s+v,0)/a.length):0;})(),
      pass:bs.filter((b:any)=>b.qc_status==="PASS").length,
      fail:bs.filter((b:any)=>b.qc_status==="FAIL").length,
    }));
  },[dipped,date]);

  // Coating on Job by Operator — based on per-band micron tolerance rules.
  // Uses admin-editable QC_RANGES (same source as PASS/HIGH/FAIL auto-decision)
  // so aggregate Matching Status mirrors per-beam QC truth.
  const QCR_LIVE = getQcRangesGlobal() as Record<string,{min:number;ok_max:number}>;
  function ruleFor(req:number){ return (QCR_LIVE as any)?.[req] || (QCR_LIVE as any)?.[String(req)] || null; }
  function ruleCriteria(req:number){
    const r=ruleFor(req);
    if(!r) return "No rule defined";
    return `<${r.min}=Below Min · ${r.min}–${r.ok_max}=OK · >${r.ok_max}=High Coating`;
  }
  function matchingStatus(avg:number, req:number){
    if(!req || !avg) return "—";
    const r=ruleFor(req);
    if(!r){
      const tol=req*0.10;
      if(avg<req) return "Below Min";
      if(avg>req+tol) return "High Coating";
      return "OK";
    }
    if(avg<r.min) return "Below Min";
    if(avg>r.ok_max) return "High Coating";
    return "OK";
  }
  const operatorQcRpt=useMemo(()=>{
    const m:any={};
    completed.forEach((b:any)=>{
      const k=(b.dipping_operator||"—").trim()||"—";
      const req=Number(b.coating_required)||0;
      const groupKey=k+"|"+req;
      if(!m[groupKey]) m[groupKey]={operator:k,required:req,beams:0,sum:0,pass:0,fail:0};
      m[groupKey].beams++;
      m[groupKey].sum+=Number(b.avg_reading)||0;
      if(b.qc_status==="PASS") m[groupKey].pass++; else m[groupKey].fail++;
    });
    return Object.values(m).map((r:any)=>{
      const avg=r.beams?r.sum/r.beams:0;
      return {...r, avg:avg?avg.toFixed(2):"—", rule:ruleCriteria(r.required), status:matchingStatus(avg,r.required)};
    }).sort((a:any,b:any)=>b.beams-a.beams);
  },[completed]);

  const supervisorQcRpt=useMemo(()=>{
    const m:any={};
    completed.forEach((b:any)=>{
      const k=(b.shift_supervisor||"—").trim()||"—";
      const req=Number(b.coating_required)||0;
      const groupKey=k+"|"+req;
      if(!m[groupKey]) m[groupKey]={supervisor:k,required:req,beams:0,sum:0,pass:0,fail:0};
      m[groupKey].beams++;
      m[groupKey].sum+=Number(b.avg_reading)||0;
      if(b.qc_status==="PASS") m[groupKey].pass++; else m[groupKey].fail++;
    });
    return Object.values(m).map((r:any)=>{
      const avg=r.beams?r.sum/r.beams:0;
      return {...r, avg:avg?avg.toFixed(2):"—", rule:ruleCriteria(r.required), status:matchingStatus(avg,r.required)};
    }).sort((a:any,b:any)=>b.beams-a.beams);
  },[completed]);

  // ── Dipping Register — every beam with dipping_at, with full cycle + CoJ data.
  // Production Date uses the Production-Day rule (times <06:00 belong to the prior day).
  // Grouping selector lets the user pivot by Date / Shift / Load / Operator / Spec.
  const [drGroupBy,setDrGroupBy]=useState<"none"|"date"|"shift"|"load"|"operator"|"spec">("none");
  const varianceEnabled = dippingConfig?.varianceAnalysisEnabled !== false;
  const dcForVar = dippingConfig || {engineEnabled:true,showThickness:true,showWeight:true,showTemperature:true,showQty:true,showLoadType:true,showLength:true,showMaterialType:true,showSurfaceCondition:true,weightTol:0.2,tempTol:2,lengthTol:500,qtyTol:5,topN:3};
  const drRows=useMemo(()=>dipped.map((b:any)=>{
    let ref:any = null, variance:any = null;
    if(varianceEnabled && b.immersion_duration!=null && b.reaction_duration!=null && b.withdrawal_duration!=null){
      const rec = computeRecommendation({beam:b, beams:allBeams, bathTemp:b.bath_temperature ?? null, dc:dcForVar});
      if(rec && (rec as any).best){
        ref = (rec as any).best;
        variance = stageVariance(
          {immersion:b.immersion_duration, reaction:b.reaction_duration, withdrawal:b.withdrawal_duration},
          {immersion:ref.immersion_duration, reaction:ref.reaction_duration, withdrawal:ref.withdrawal_duration},
        );
      }
    }
    const vTotal = variance ? variance.find((r:any)=>r.key==="total") : null;
    const vImm   = variance ? variance.find((r:any)=>r.key==="immersion") : null;
    const vReact = variance ? variance.find((r:any)=>r.key==="reaction") : null;
    const vWith  = variance ? variance.find((r:any)=>r.key==="withdrawal") : null;
    return {
      productionDate:drProdDay(b),
      shift:drShift(b),
      beamNo:b.beam_no,
      routeCard:b.route_card_no||b.route_card||"",
      partNo:b.part_nos||"",
      loadType:b.load_type||"",
      materialType:b.material_type||"",
      surfaceCondition:fmtSurface(b.surface_condition),
      qty:b.quantity||(Array.isArray(b.part_nos)?b.part_nos.length:""),
      weightMT:b.total_weight??"",
      operator:b.dipping_operator||"",
      entryTime:fmt12(b.immersion_start||b.dipping_at),
      exitTime:fmt12(b.withdrawal_end||b.dipped_at),
      cycleTime:fmtDur(cycleSecs(b)),
      coatingSpec:b.coating_required??"",
      individualReadings: isV2Coj(b) ? v2FlatReadings(b.elcometer_v2).map(v=>v.toFixed(2)).join(" · ") : (b.elcometer||[]).filter((v:any)=>v!=null&&v!=="").join(" · "),
      avgCoating:b.avg_reading??"",
      refBeam: ref?.beam_no || "",
      refImm:  ref ? fmtDur(ref.immersion_duration) : "",
      refReact:ref ? fmtDur(ref.reaction_duration) : "",
      refWith: ref ? fmtDur(ref.withdrawal_duration) : "",
      dImm:    vImm   ? fmtSignedDur(vImm.variance)   : "",
      dReact:  vReact ? fmtSignedDur(vReact.variance) : "",
      dWith:   vWith  ? fmtSignedDur(vWith.variance)  : "",
      dTotal:  vTotal ? fmtSignedDur(vTotal.variance) : "",
      varStatus: vTotal ? vTotal.status : "",
    };
  }).sort((a:any,b:any)=>(a.productionDate<b.productionDate?1:a.productionDate>b.productionDate?-1:0)),[dipped,allBeams,varianceEnabled]);
  const drGroups=useMemo(()=>{
    if(drGroupBy==="none") return null;
    const keyOf:Record<string,(r:any)=>string>={
      date:(r)=>r.productionDate||"—",
      shift:(r)=>`Shift ${r.shift}`,
      load:(r)=>r.loadType||"—",
      operator:(r)=>r.operator||"—",
      spec:(r)=>r.coatingSpec?`${r.coatingSpec} µm`:"—",
    };
    const m=new Map<string,any[]>();
    drRows.forEach((r:any)=>{ const k=keyOf[drGroupBy](r); if(!m.has(k)) m.set(k,[]); m.get(k)!.push(r); });
    return Array.from(m.entries()).sort((a,b)=>a[0]<b[0]?-1:1);
  },[drRows,drGroupBy]);

  // ── Regression Predictive Data — the exact inputs/outputs the regression
  //    model consumes for each processed beam (one row per dipped beam).
  const regRows=useMemo(()=>dipped.map((b:any)=>{
    const secs=cycleSecs(b);
       const avg = cojActualAverage(b);
    return {
      productionDate:drProdDay(b),
      shift:drShift(b),
      beamNo:b.beam_no,
      cycleTime: secs!=null ? fmtDur(secs) : "",
      totalSec: secs!=null ? Number(secs) : null,
      avgCoating: avg!=null && Number.isFinite(Number(avg)) ? Number(Number(avg).toFixed(2)) : null,
      bathTemp: b.bath_temperature!=null && b.bath_temperature!=="" ? Number(b.bath_temperature) : null,
      materialType: b.material_type||"",
      loadType: b.load_type||"",
      surfaceCondition: fmtSurface(b.surface_condition),
      weightMT: b.total_weight!=null && b.total_weight!=="" ? Number(b.total_weight) : null,
      thickness: parseThicknessMm(b.section),
      length: b.length_mm!=null && b.length_mm!=="" ? Number(b.length_mm) : null,
      qty: b.quantity!=null && b.quantity!=="" ? Number(b.quantity) : null,
      coatingSpec: b.coating_required!=null ? Number(b.coating_required) : null,
    };
  }).sort((a:any,b:any)=>(a.productionDate<b.productionDate?1:a.productionDate>b.productionDate?-1:0)),[dipped]);



  // ── AI Prediction Validation — one row per model that predicted each dipped
  //    beam, compared against the actual dipping time and inspected coating.
  const aiRows=useMemo(()=>{
    const out:any[]=[];
    dipped.forEach((b:any)=>{
      const secs=cycleSecs(b);
       const avg = cojActualAverage(b);
      validationRowsForBeam(b,{
        actualSec: secs!=null?Number(secs):null,
        actualCoating: avg!=null&&Number.isFinite(Number(avg))?Number(Number(avg).toFixed(2)):null,
        productionDate: drProdDay(b),
        shift: drShift(b),
      }).forEach(r=>out.push(r));
    });
    return out.sort((a,b)=>(a.productionDate<b.productionDate?1:a.productionDate>b.productionDate?-1:0));
  },[dipped]);
  const aiByModel=useMemo(()=>aiRollup(aiRows,(r:any)=>r.modelLabel),[aiRows]);
  const aiByDate=useMemo(()=>aiRollup(aiRows,(r:any)=>r.productionDate||"—"),[aiRows]);
  const aiByMaterial=useMemo(()=>aiRollup(aiRows,(r:any)=>`${r.materialType||"—"} / ${fmtSurface(r.surfaceCondition)||"—"}`),[aiRows]);
  const aiBest=useMemo(()=>aiBestModel(aiByModel),[aiByModel]);
  const toggleTraining=(beamNo:string,next:boolean)=>{
    setBeams?.((prev:any[])=>prev.map((x:any)=>x.beam_no===beamNo?{...x,ai_train_include:next}:x));
  };

  // ── Per-tab export builders. Each tab id maps to a sheet name + rows.
  //    Shared by "This Tab" exports and the full multi-sheet workbook so
  //    UI / Excel / email stay in lockstep.
  const getTabDataMap = ():Record<string,{sheet:string,label:string,rows:any[]}> => ({
    hourly:{sheet:"Hourly Report",label:"Hourly",rows:hourly.map((r:any)=>({
      "Production Day":`${date} 06:00 → ${nextDateStr(date)} 06:00`,
      "Hour (Immersion Start)":r.label,"Beams Dipped":r.count,"Total MT":r.totalMT,"Types":r.types,

      "Cumulative Beam Count":r.cumCount,"Cumulative Weight (MT)":r.cumMT,"Cumulative Load Type":r.cumTypes,
      "Dipping Start Times":r.beams.map((b:any)=>`${b.beam_no} @ ${fmtTimeTz(b.immersion_start)}`).join(", "),
      "Beam Nos":r.beamNos,
    }))},
    shift:{sheet:"Shift Report",label:"Shift",rows:shiftRpt.map((r:any)=>({
      "Shift":r.shift,"Beams":r.count,"Total MT":r.totalMT,"Avg Cycle Time":fmtDur(r.avgDip),"Pass":r.pass,"Fail":r.fail,
    }))},
    daily:{sheet:"Daily Report",label:"Daily",rows:dailyRpt.map((r:any)=>({
      "Date":r.date,"Loaded":r.loaded,"Dipped":r.dipped,"Completed":r.completed,"Total MT":r.mt,"Pass":r.pass,"Fail":r.fail,
    }))},
    operator:{sheet:"Operator Report",label:"Operator",rows:operatorRpt.map((r:any)=>({
      "Operator":r.operator,"Beams":r.beams,"Total MT":r.mt,"Avg Cycle Time":fmtDur(r.avgDip),"Avg μm":r.avgCoat,
      "Pass":r.pass,"Fail":r.fail,"High":r.high,"Low":r.low,"Pass Rate %":r.passRate,
    }))},
    coating:{sheet:"Coating Report",label:"Coating",rows:coatingRpt.map((r:any)=>({
      "Spec (μm)":r.spec,"Beams":r.total,"Avg μm":r.avg,"Pass":r.pass,"Fail":r.fail,
      "High Coating":r.high,"Below Min":r.low,"Pass Rate %":r.passRate,
    }))},
    beam:{sheet:"Beam Tracking",label:"Beam Tracking",rows:beams.map((b:any)=>{const bm=effBench(b);return{
      "Beam No":b.beam_no,"Part No(s)":b.part_nos,"Load Type":b.load_type,"Material Type":b.material_type||"","Surface Condition":fmtSurface(b.surface_condition),"Weight (MT)":b.total_weight,
      "Length (mm)":b.length_mm||"",
      "Coating (μm)":b.coating_required,"Shift":b.shift,"Supervisor":b.shift_supervisor||"",
      "Loaded At":fmtDT(b.loaded_at),"Dipped At":fmtDT(b.dipped_at),"Imm Duration":fmtDur(b.immersion_duration),"Cycle Time":fmtDur(cycleSecs(b)),
      "Entry Mode": b.entry_mode==="manual"?"Manual":(b.dipped_at?"Live":""),
      "Avg μm":b.avg_reading||"","Auto Remark":b.qc_auto_remark||"","QC Status":b.qc_status||"",
      "Completed At":fmtDT(b.qc_completed_at),
      "Ref Beam No":bm?.ref_beam_no||"","Ref Beam ID":bm?.ref_beam_id||"",
      "Ref Avg μm":bm?.ref_avg??"","Difference μm":bm?.difference??"",
      "Coating Δ μm":(bm?.difference!=null?(bm.difference>0?"+":"")+bm.difference:""),"Match Status":bm?.status||"","Match Criteria":formatCriteriaUsed(bm?.criteria_used),
      "Benchmark At":bm?.compared_at?fmtDT(bm.compared_at):"",
    };})},
    qc:{sheet:"Coating on Job",label:"Coating on Job",rows:completed.map((b:any)=>{
      const bm=effBench(b);
      const v2 = isV2Coj(b);
      const subs = v2 ? v2SubAverages(b.elcometer_v2) : null;
      const mm = v2 ? v2MinMax(b.elcometer_v2) : null;
      const flat = v2 ? v2FlatReadings(b.elcometer_v2) : [];
      const legacy = Array.isArray(b.elcometer) ? b.elcometer : [];
      const jp = cojJobParams(b);
      const zx = zincExcess(b.coating_required, b.avg_reading);
      const band = cojBand(b.coating_required);
      const row:any = {
        "Beam No":b.beam_no,"Part No(s)":b.part_nos,"Material Type":b.material_type||"","Surface Condition":fmtSurface(b.surface_condition),"Required μm":b.coating_required,
        "Requirement Band μm": band ? `${band.min}-${band.max}` : "",
        "Weight (MT)": jp.weightMT ?? "",
        "Thickness (mm)": jp.thicknessMm ?? "",
        "Length (mm)": jp.lengthMm ?? "",
        "Load Type": jp.loadType ?? "",
        "Zinc Bath Temperature (°C)": jp.bathTemp ?? "",
        "Total Dipping Time (sec)": jp.totalSec ?? "",
        "Total Dipping Time (mm:ss)": jp.totalSec != null ? fmtMMSS(jp.totalSec) : "",
        "Format": v2 ? "30-Point (5×6)" : "7-Point (legacy)",
      };

      if (v2 && subs) {
        for (let i=0;i<30;i++) row[`R${i+1}`] = flat[i] ?? "";
        row["FW Outside Average"]  = subs.fwOut ?? "";
        row["FW Inside Average"] = subs.fwIn ?? "";
        row["MW Upper Average"]  = subs.mwOut ?? "";
        row["MW Inside Average"] = subs.mwIn ?? "";
        row["LW Outside Average"]  = subs.lwOut ?? "";
        row["LW Inside Average"]  = subs.lwIn ?? "";

        row["Min μm"] = mm?.min ?? "";
        row["Max μm"] = mm?.max ?? "";
      } else {
        row["P1"]=legacy[0]??""; row["P2"]=legacy[1]??""; row["P3"]=legacy[2]??"";
        row["P4"]=legacy[3]??""; row["P5"]=legacy[4]??""; row["P6"]=legacy[5]??""; row["P7"]=legacy[6]??"";
      }
      row["Total Average μm (30÷30)"]=b.avg_reading;
      row["Requirement Floor μm"]=zx?.min ?? "";
      row["Excess over Floor μm"]=zx?.excessUm ?? "";
      row["Excess Zinc %"]=zx?.excessPct ?? "";
      row["Auto Remark"]=b.qc_auto_remark; row["QC Status"]=b.qc_status;

      row["QC Remark"]=b.qc_remark||""; row["Inspector"]=b.qc_completed_by_name; row["Completed At"]=fmtDT(b.qc_completed_at);
      row["Ref Beam No"]=bm?.ref_beam_no||""; row["Ref Beam ID"]=bm?.ref_beam_id||"";
      row["Ref Avg μm"]=bm?.ref_avg??""; row["Difference μm"]=bm?.difference??"";
      row["Coating Δ μm"]=bm?.difference!=null?(bm.difference>0?"+":"")+bm.difference:""; row["Match Status"]=bm?.status||""; row["Match Criteria"]=formatCriteriaUsed(bm?.criteria_used);
      row["Benchmark At"]=bm?.compared_at?fmtDT(bm.compared_at):"";
      // CoJ History → Model Prediction (one column group per enabled model).
      const cmp = cojModelComparison(b, mlrStore, aiModels);
      if (cmp.length) row["Actual Total Dipping Time (sec)"] = cmp[0].actualSec;
      for (const c of cmp) {
        row[`${AI_MODEL_SHORT[c.id]} Expected Coating μm`] = c.expected;
        row[`${AI_MODEL_SHORT[c.id]} Difference μm`] = (c.diff>0?"+":"")+c.diff;
        row[`${AI_MODEL_SHORT[c.id]} Accuracy %`] = c.accuracy;
      }
      return row;

    })},

    operator_qc:{sheet:"CoJ by Operator",label:"CoJ by Operator",rows:operatorQcRpt.map((r:any)=>({
      "Operator":r.operator,"Required μm":r.required,"Tolerance Rule":r.rule,"Total Beams":r.beams,
      "Avg Coating":r.avg,"Pass":r.pass,"Fail":r.fail,"Matching Status":r.status,
    }))},
    supervisor_qc:{sheet:"CoJ by Supervisor",label:"CoJ by Supervisor",rows:supervisorQcRpt.map((r:any)=>({
      "Shift Supervisor":r.supervisor,"Required μm":r.required,"Tolerance Rule":r.rule,"Total Beams":r.beams,
      "Avg Coating":r.avg,"Pass":r.pass,"Fail":r.fail,"Matching Status":r.status,
    }))},
    dipping_register:{sheet:"Dipping Register",label:"Dipping Register",rows:drRows.map((r:any)=>({
      "Production Date":r.productionDate,"Shift":r.shift,"Beam No":r.beamNo,"Route Card":r.routeCard,
      "Part No":r.partNo,"Load Type":r.loadType,"Material Type":r.materialType,"Surface Condition":r.surfaceCondition,"Qty":r.qty,"Weight (MT)":r.weightMT,"Operator":r.operator,
      "Entry Time":r.entryTime,"Exit Time":r.exitTime,"Cycle Time":r.cycleTime,
      "Coating Spec (µm)":r.coatingSpec,"Individual Readings":r.individualReadings,"Avg Coating":r.avgCoating,
      ...(varianceEnabled?{
        "Ref Beam":r.refBeam,"Ref Imm":r.refImm,"Ref React":r.refReact,"Ref With":r.refWith,
        "ΔImm":r.dImm,"ΔReact":r.dReact,"ΔWith":r.dWith,"ΔTotal":r.dTotal,"Variance Status":r.varStatus,
      }:{}),
    }))},
    loading_register:{sheet:"Loading Register",label:"Loading Register",rows:[
      ...lrByType.map((r:any)=>({
        "Load Type":r.type,"Beams Loaded":r.count,"Total Weight (MT)":r.mt,"Beam Nos":(r.beams||[]).join(", "),
      })),
      { "Load Type":"— Day 07:00–19:00 —","Beams Loaded":lrTotals.dayCount,"Total Weight (MT)":lrTotals.dayMT,"Beam Nos":"" },
      { "Load Type":"— Night 19:00–07:00 —","Beams Loaded":lrTotals.nightCount,"Total Weight (MT)":lrTotals.nightMT,"Beam Nos":"" },
      { "Load Type":"— Cumulative Total —","Beams Loaded":lrTotals.totalCount,"Total Weight (MT)":lrTotals.totalMT,"Beam Nos":"" },
    ]},
    regression:{sheet:"Regression Predictive Data",label:"Regression Predictive Data",rows:regRows.map((r:any)=>({
      "Production Date":r.productionDate,"Shift":r.shift,"Beam No":r.beamNo,
      "Total Cycle Time (MM:SS)":r.cycleTime,"Total Time (Seconds)":r.totalSec??"",
      "Average Coating (µm)":r.avgCoating??"","Zinc Bath Temperature (°C)":r.bathTemp??"",
      "Material Type":r.materialType,"Load Type":r.loadType,"Surface Condition":r.surfaceCondition,
      "Weight (MT)":r.weightMT??"","Job Thickness (mm)":r.thickness??"","Length (mm)":r.length??"","Quantity":r.qty??"",
       "Specific Coating Requirement (µm)":r.coatingSpec??"",
    }))},
    ai_validation:{sheet:"AI Prediction Validation",label:"AI Prediction Validation",rows:aiRows.map((r:any)=>({
      "Production Date":r.productionDate,"Shift":r.shift,"Beam No":r.beamNo,"AI Model":r.modelLabel,"Prediction Source":r.tier,
      "Material Type":r.materialType,"Surface Condition":fmtSurface(r.surfaceCondition),"Load Type":r.loadType,
      "Bath Temp (°C)":r.bathTemp??"","Specific Coating (µm)":r.specificCoating??"","Target Coating (µm)":r.targetCoating??"",
      "Predicted Total Time (Sec)":r.predictedSec??"","Actual Total Time (Sec)":r.actualSec??"","Time Variation (Sec)":r.timeVariation??"",
      "Expected Coating (µm)":r.expectedCoating??"","Actual Coating (µm)":r.actualCoating??"","Coating Variation (µm)":r.coatingVariation??"",
      "Time Accuracy %":r.timeAccuracy??"","Coating Accuracy %":r.coatingAccuracy??"","Overall Accuracy %":r.overallAccuracy??"",
      "Confidence %":r.confidencePct??"","Included in Retraining":r.includedInTraining?"Yes":"No","Recommendation":r.recommendation,
    }))},
  });



  function makeFiltersSheet(scopeLabel:string, scopeRows:number){
    const fRows=[
      ["HDP Production Report"],
      ["Generated At", fmtDateTimeTz(new Date().toISOString())+" "+APP_TZ_LABEL],
      ["Scope", scopeLabel],
      ["Rows in Scope", scopeRows],
      ["Beams Matched (after filters)", beams.length],
      [],
      ["Applied Filters"],
      ...activeFilters.map(([k,v])=>[k,v]),
    ];
    return XLSX.utils.aoa_to_sheet(fRows);
  }
  function fitCols(rows:any[]){
    if(!rows.length) return [];
    const keys=Object.keys(rows[0]);
    return keys.map(k=>({wch:Math.min(40,Math.max(k.length+2,...rows.map(r=>String(r[k]??"").length+2)))}));
  }
  function appendSheet(wb:any, rows:any[], name:string){
    const ws=XLSX.utils.json_to_sheet(rows);
    (ws as any)["!cols"]=fitCols(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  function buildWorkbook(scope?:string){
    const wb=XLSX.utils.book_new();
    const tabDataMap=getTabDataMap();
    if(scope && tabDataMap[scope]){
      const {sheet,label,rows}=tabDataMap[scope];
      XLSX.utils.book_append_sheet(wb, makeFiltersSheet(label, rows.length), "Filters");
      appendSheet(wb, rows, sheet);
      return wb;
    }
    // Full workbook (all tabs)
    XLSX.utils.book_append_sheet(wb, makeFiltersSheet("All Reports", beams.length), "Filters");
    appendSheet(wb, beams.map((b:any)=>({
      "Beam No":b.beam_no,"Date":b.date,"Shift":b.shift,"Supervisor":b.shift_supervisor||"","Part No(s)":b.part_nos,
      "Thickness":b.section,"Load Type":b.load_type,"Weight (MT)":b.total_weight,
      "Length (m)":b.length,"Coating (μm)":b.coating_required,"Status":b.status,
      "Loaded By":b.loaded_by_name,"Loaded At":fmtDT(b.loaded_at),
    })), "Loading");
    appendSheet(wb, dipped.map((b:any)=>{
      const isCompleted = b.status === "COMPLETED" && b.qc_status;
      return {
        "Beam No":b.beam_no, "Part No(s)":b.part_nos, "Load Type":b.load_type,
        "Material Type":b.material_type||"", "Surface Condition":fmtSurface(b.surface_condition),
        "Weight (MT)":b.total_weight, "Coating (μm)":b.coating_required,
        "Bath °C":b.bath_temperature??"",
        "Imm Start":fmt12(b.immersion_start), "Imm End":fmt12(b.immersion_end), "Imm Duration":fmtDur(b.immersion_duration),
        "React End":fmt12(b.reaction_end), "React Duration":fmtDur(b.reaction_duration),
        "Withd End":fmt12(b.withdrawal_end), "Withd Duration":fmtDur(b.withdrawal_duration),
        "Cycle Time":fmtDur(cycleSecs(b)),
        "Entry Mode": b.entry_mode==="manual"?"Manual":"Live",
        "Dipping Operator":b.dipping_operator||"", "Shift Supervisor":b.shift_supervisor||"",
        "Dipped By":b.dipped_by_name, "Dipped At":fmtDT(b.dipped_at),
        "CoJ Format":isCompleted?(isV2Coj(b)?"30-Point":"7-Point"):"",
        "P1":isCompleted&&!isV2Coj(b)?b.elcometer?.[0]:"", "P2":isCompleted&&!isV2Coj(b)?b.elcometer?.[1]:"",
        "P3":isCompleted&&!isV2Coj(b)?b.elcometer?.[2]:"", "P4":isCompleted&&!isV2Coj(b)?b.elcometer?.[3]:"",
        "P5":isCompleted&&!isV2Coj(b)?b.elcometer?.[4]:"", "P6":isCompleted&&!isV2Coj(b)?b.elcometer?.[5]:"",
        "P7":isCompleted&&!isV2Coj(b)?b.elcometer?.[6]:"",
        "FW·O Avg":isCompleted&&isV2Coj(b)?(v2SubAverages(b.elcometer_v2).fwOut??""):"",
        "FW·I Avg":isCompleted&&isV2Coj(b)?(v2SubAverages(b.elcometer_v2).fwIn??""):"",
        "MW·O Avg":isCompleted&&isV2Coj(b)?(v2SubAverages(b.elcometer_v2).mwOut??""):"",
        "MW·I Avg":isCompleted&&isV2Coj(b)?(v2SubAverages(b.elcometer_v2).mwIn??""):"",
        "LW·O Avg":isCompleted&&isV2Coj(b)?(v2SubAverages(b.elcometer_v2).lwOut??""):"",
        "LW·I Avg":isCompleted&&isV2Coj(b)?(v2SubAverages(b.elcometer_v2).lwIn??""):"",
        "Min μm":isCompleted&&isV2Coj(b)?(v2MinMax(b.elcometer_v2).min??""):"",
        "Max μm":isCompleted&&isV2Coj(b)?(v2MinMax(b.elcometer_v2).max??""):"",
        "Avg μm":isCompleted?b.avg_reading:"",
        "Auto Remark":isCompleted?b.qc_auto_remark:"",
        "QC Status":isCompleted?b.qc_status:"",
        "QC Remark":isCompleted?b.qc_remark:"",
        "Inspector":isCompleted?b.qc_completed_by_name:"",
        "CoJ Completed At":isCompleted?fmtDT(b.qc_completed_at):"",
      };
    }), "Dipping & QC");
    for(const id of Object.keys(tabDataMap)){
      const {sheet,rows}=tabDataMap[id];
      appendSheet(wb, rows, sheet);
    }
    return wb;
  }


  function exportExcel(scope?:string){
    const tag=activeFilterCount>0?`_filtered`:"";
    const tabDataMap=getTabDataMap();
    const scopeTag = scope && tabDataMap[scope] ? `_${tabDataMap[scope].sheet.replace(/[^A-Za-z0-9]+/g,"-")}` : "";
    XLSX.writeFile(buildWorkbook(scope),`HDP_Report${scopeTag}_${fromDate}_to_${toDate}${tag}.xlsx`);
  }


  async function sendEmail(scope?:string){
    if(recipients.length===0){ setSendErr("No recipients configured. Add them in Admin → Email Config."); return; }
    setSending(true); setSendErr(null);
    try{
      const tabDataMap=getTabDataMap();
      const wb=buildWorkbook(scope);
      // ── E2E payload check: parse the workbook we're about to send and
      //    verify each sheet's row count matches the filtered UI memos.
      const expected:Record<string,number> = scope && tabDataMap[scope]
        ? { [tabDataMap[scope].sheet]: tabDataMap[scope].rows.length }
        : {
            "Loading":beams.length,
            "Dipping & QC":dipped.length,
            ...Object.fromEntries(Object.values(tabDataMap).map(t=>[t.sheet,t.rows.length])),
          };
      const mismatches:string[]=[];
      for(const [sheet,want] of Object.entries(expected)){
        const ws=wb.Sheets[sheet];
        const got = ws ? Math.max(0, (XLSX.utils.sheet_to_json(ws) as any[]).length) : -1;
        if(got!==want) mismatches.push(`${sheet}: payload=${got} vs UI=${want}`);
      }
      if(mismatches.length){
        throw new Error(`Email payload does not match filtered UI rows — aborted. ${mismatches.join("; ")}`);
      }
      const b64=XLSX.write(wb,{bookType:"xlsx",type:"base64"}) as string;
      const scopeLabel = scope && tabDataMap[scope] ? tabDataMap[scope].label : "All Reports";
      const scopeTag = scope && tabDataMap[scope] ? `_${tabDataMap[scope].sheet.replace(/[^A-Za-z0-9]+/g,"-")}` : "";
      const filename=`HDP_Report${scopeTag}_${fromDate}_to_${toDate}.xlsx`;
      const { escapeHtml: esc } = await import("@/lib/sanitize");
      const filterRows=activeFilters.map(([k,v])=>`<tr><td style="padding:4px 10px;color:#666">${esc(k)}</td><td style="padding:4px 10px;font-weight:600">${esc(v)}</td></tr>`).join("");
      const countRows=Object.entries(expected).map(([k,v])=>`<tr><td style="padding:4px 10px;color:#666">${esc(k)}</td><td style="padding:4px 10px;font-weight:600">${esc(v)}</td></tr>`).join("");
      const sheetList=Object.keys(expected).map(esc).join(", ");
      const bodyHtml=`<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
        <h2 style="margin:0 0 12px">HDP Production Report — ${esc(scopeLabel)} — ${esc(productionRangeLabel(fromDate,toDate))}</h2>
        <p>Scope: <b>${esc(scopeLabel)}</b>. Beams matching filters: <b>${beams.length}</b> of ${allBeams.length} total.</p>
        <h3 style="margin:18px 0 6px;font-size:14px">Applied Filters</h3>
        <table style="border-collapse:collapse;font-size:13px">${filterRows}</table>
        <h3 style="margin:18px 0 6px;font-size:14px">Filtered Row Counts (verified)</h3>
        <table style="border-collapse:collapse;font-size:13px">${countRows}</table>
        <p style="margin-top:14px">Attached: <b>${esc(filename)}</b> — sheets: Filters, ${sheetList}. Only filtered data is included.</p>
        <p style="color:#666;font-size:12px">Auto-generated from the HDP system.</p>
      </div>`;
      await _sendBeamReport({ data:{
        recipients, subject:`HDP Report — ${scopeLabel} — ${productionRangeLabel(fromDate,toDate)}${activeFilterCount>0?` (${activeFilterCount} filters)`:""}`,
        bodyHtml, filename, fileBase64:b64,
        mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }});
      ss(true);
      setTimeout(()=>{ se(false); ss(false); },2500);
    }catch(e:any){
      setSendErr(e?.message||"Failed to send email");
    }finally{ setSending(false); }
  }

  // Send every report tab as its own separate email (one attachment per tab).
  async function sendEmailEach(){
    if(recipients.length===0){ setSendErr("No recipients configured. Add them in Admin → Email Config."); return; }
    const keys=Object.keys(getTabDataMap());
    setSending(true); setSendErr(null);
    try{
      for(const k of keys){
        // sendEmail manages its own setSending; call its inner logic by reusing it
        await sendEmail(k);
      }
      ss(true);
      setTimeout(()=>{ ss(false); },2500);
    }catch(e:any){
      setSendErr(e?.message||"Failed to send one or more emails");
    }finally{ setSending(false); }
  }

  // ── Master Sheet: every dataset flattened into ONE worksheet.
  //    Sections stacked vertically with blank-row separators and bold section headers.
  function buildMasterWorkbook(){
    const wb=XLSX.utils.book_new();
    const rows:any[][]=[];

    // 1) Header block
    rows.push(["HDP Production — Master Report"]);
    rows.push(["Generated At", fmtDateTimeTz(new Date().toISOString())+" "+APP_TZ_LABEL]);
    rows.push(["Production Day Range", productionRangeLabel(fromDate, toDate)]);
    rows.push(["Beams in Scope", beams.length, "Dipped", dipped.length, "Completed", completed.length]);
    if(activeFilters.length){
      rows.push([]);
      rows.push(["Applied Filters"]);
      activeFilters.forEach(([k,v])=>rows.push([k,v]));
    }
    rows.push([]);

    // 2) Six Sigma / Coating summary (per spec)
    rows.push(["SIX SIGMA SUMMARY (per Coating Spec)"]);
    rows.push(["Spec (µm)","Beams","Avg µm","Pass","Fail","High","Below Min","Pass Rate %"]);
    coatingRpt.forEach((r:any)=>rows.push([r.spec,r.total,r.avg,r.pass,r.fail,r.high,r.low,r.passRate]));
    rows.push([]);

    // 3) Load-wise summary derived from drRows
    const lm=new Map<string,{beams:number;mt:number;sumCoat:number;nCoat:number;sumCyc:number;nCyc:number}>();
    drRows.forEach((r:any)=>{
      const k=r.loadType||"—";
      if(!lm.has(k)) lm.set(k,{beams:0,mt:0,sumCoat:0,nCoat:0,sumCyc:0,nCyc:0});
      const o=lm.get(k)!;
      o.beams++;
      o.mt+=Number(r.weightMT)||0;
      const c=Number(r.avgCoating); if(!isNaN(c)&&c>0){o.sumCoat+=c;o.nCoat++;}
      // cycleTime string → seconds via dipped row lookup
      const beam=dipped.find((b:any)=>b.beam_no===r.beamNo);
      const cs=beam?cycleSecs(beam):null;
      if(cs!=null){o.sumCyc+=cs;o.nCyc++;}
    });
    rows.push(["LOAD-WISE SUMMARY"]);
    rows.push(["Load Type","Total Beams","Total MT","Avg Coating (µm)","Avg Cycle Time"]);
    Array.from(lm.entries()).sort((a,b)=>b[1].beams-a[1].beams).forEach(([k,o])=>{
      rows.push([k,o.beams,o.mt.toFixed(2),o.nCoat?(o.sumCoat/o.nCoat).toFixed(2):"—",o.nCyc?fmtDur(Math.round(o.sumCyc/o.nCyc)):"—"]);
    });
    rows.push([]);

    // 4) Spec × Load Matrix (avg coating)
    const specs=Array.from(new Set(drRows.map((r:any)=>String(r.coatingSpec||"")).filter(Boolean))).sort();
    const loads=Array.from(lm.keys()).sort();
    const matrix=new Map<string,{sum:number;n:number}>();
    drRows.forEach((r:any)=>{
      const c=Number(r.avgCoating); if(isNaN(c)||c<=0) return;
      const key=`${r.loadType||"—"}||${r.coatingSpec||""}`;
      if(!matrix.has(key)) matrix.set(key,{sum:0,n:0});
      const o=matrix.get(key)!; o.sum+=c; o.n++;
    });
    rows.push(["SPEC × LOAD MATRIX (Avg Coating µm)"]);
    rows.push(["Load Type", ...specs.map(s=>`${s} µm`)]);
    loads.forEach(lt=>{
      rows.push([lt, ...specs.map(s=>{const o=matrix.get(`${lt}||${s}`); return o?(o.sum/o.n).toFixed(2):"—";})]);
    });
    rows.push([]);

    // 5) Dipping Register — core + variance, deduped by Beam No, hh:mm:ss formatting
    const pad=(n:number)=>String(n).padStart(2,"0");
    const hms=(iso:any)=>{ if(!iso) return ""; if(isNaN(+new Date(iso))) return ""; const p=tzFields(iso); return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`; };
    const durHMS=(secs:any)=>{ if(secs==null||secs<0||isNaN(+secs)) return ""; const s=Math.floor(secs); return `${pad(Math.floor(s/3600))}:${pad(Math.floor((s%3600)/60))}:${pad(s%60)}`; };
    const sgnHMS=(secs:any)=>{ if(secs==null||isNaN(+secs)) return ""; const sign=secs<0?"-":"+"; return sign+durHMS(Math.abs(secs)); };
    rows.push(["DIPPING REGISTER (Core + Variance)"]);
    const drHeaders=["Production Date","Shift","Beam No","Route Card","Part No","Load Type","Material Type","Surface Condition","Qty","Weight (MT)","Operator","Entry (hh:mm:ss)","Exit (hh:mm:ss)","Cycle Time (hh:mm:ss)","Spec (µm)","Avg Coating"];
    if(varianceEnabled) drHeaders.push("Ref Beam","ΔImm (hh:mm:ss)","ΔReact (hh:mm:ss)","ΔWith (hh:mm:ss)","ΔTotal (hh:mm:ss)","Variance Status");
    rows.push(drHeaders);
    const seen=new Set<string>();
    drRows.forEach((r:any)=>{
      const key=String(r.beamNo||"")+"|"+String(r.productionDate||"");
      if(seen.has(key)) return;
      seen.add(key);
      const beam=dipped.find((b:any)=>b.beam_no===r.beamNo);
      const entryISO=beam?(beam.immersion_start||beam.dipping_at):null;
      const exitISO =beam?(beam.withdrawal_end||beam.dipped_at):null;
      const cycSec  =beam?cycleSecs(beam):null;
      const refBeam=r.refBeam?dipped.find((b:any)=>b.beam_no===r.refBeam):null;
      const cur={imm:beam?.immersion_duration,react:beam?.reaction_duration,wit:beam?.withdrawal_duration};
      const ref={imm:refBeam?.immersion_duration,react:refBeam?.reaction_duration,wit:refBeam?.withdrawal_duration};
      const dI = (cur.imm!=null&&ref.imm!=null)?cur.imm-ref.imm:null;
      const dR = (cur.react!=null&&ref.react!=null)?cur.react-ref.react:null;
      const dW = (cur.wit!=null&&ref.wit!=null)?cur.wit-ref.wit:null;
      const dT = (dI!=null&&dR!=null&&dW!=null)?dI+dR+dW:null;
      const row=[r.productionDate,r.shift,r.beamNo,r.routeCard,Array.isArray(r.partNo)?r.partNo.join(", "):r.partNo,r.loadType,r.materialType,r.surfaceCondition,r.qty,r.weightMT,r.operator,hms(entryISO),hms(exitISO),durHMS(cycSec),r.coatingSpec,r.avgCoating];
      if(varianceEnabled) row.push(r.refBeam,sgnHMS(dI),sgnHMS(dR),sgnHMS(dW),sgnHMS(dT),r.varStatus);
      rows.push(row);
    });


    const ws=XLSX.utils.aoa_to_sheet(rows);
    // Column widths
    const maxCols=rows.reduce((m,r)=>Math.max(m,r.length),0);
    (ws as any)["!cols"]=Array.from({length:maxCols},(_,i)=>({wch:Math.min(28,Math.max(10,...rows.map(r=>String(r[i]??"").length+2)))}));
    XLSX.utils.book_append_sheet(wb,ws,"Master");
    return wb;
  }

  function exportMasterSheet(){
    const tag=activeFilterCount>0?`_filtered`:"";
    XLSX.writeFile(buildMasterWorkbook(),`HDP_Master_${fromDate}_to_${toDate}${tag}.xlsx`);
  }

  async function sendMasterEmail(){
    if(recipients.length===0){ setSendErr("No recipients configured. Add them in Admin → Email Config."); return; }
    setSending(true); setSendErr(null);
    try{
      const wb=buildMasterWorkbook();
      const b64=XLSX.write(wb,{bookType:"xlsx",type:"base64"}) as string;
      const filename=`HDP_Master_${fromDate}_to_${toDate}.xlsx`;
      const { escapeHtml: esc } = await import("@/lib/sanitize");
      const filterRows=activeFilters.map(([k,v])=>`<tr><td style="padding:4px 10px;color:#666">${esc(k)}</td><td style="padding:4px 10px;font-weight:600">${esc(v)}</td></tr>`).join("");
      const bodyHtml=`<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
        <h2 style="margin:0 0 12px">HDP Master Report — ${esc(productionRangeLabel(fromDate,toDate))}</h2>
        <p>Single-sheet master report combining Six Sigma summary, Load-wise, Spec × Load matrix and Dipping Register.</p>
        <p>Beams matching filters: <b>${beams.length}</b> of ${allBeams.length} total. Dipped: <b>${dipped.length}</b>. Completed: <b>${completed.length}</b>.</p>
        ${filterRows?`<h3 style="margin:18px 0 6px;font-size:14px">Applied Filters</h3><table style="border-collapse:collapse;font-size:13px">${filterRows}</table>`:""}
        <p style="margin-top:14px">Attached: <b>${esc(filename)}</b> — single worksheet: Master.</p>
        <p style="color:#666;font-size:12px">Auto-generated from the HDP system.</p>
      </div>`;
      await _sendBeamReport({ data:{
        recipients, subject:`HDP Master Report — ${productionRangeLabel(fromDate,toDate)}${activeFilterCount>0?` (${activeFilterCount} filters)`:""}`,
        bodyHtml, filename, fileBase64:b64,
        mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }});
      ss(true);
      setTimeout(()=>{ se(false); ss(false); },2500);
    }catch(e:any){
      setSendErr(e?.message||"Failed to send email");
    }finally{ setSending(false); }
  }



  const RTABS=[["loading_register","📦 Loading Register"],["dipping_register","🛢 Dipping Register"],["hourly","⏰ Hourly"],["shift","🔄 Shift"],["daily","📅 Daily"],["operator","👷 Operator"],["coating","🎨 Coating"],["beam","🔍 Beam Tracking"],["qc","✅ Coating on Job"],["operator_qc","🎯 CoJ by Operator"],["supervisor_qc","🧭 CoJ by Supervisor"],["regression","🧮 Regression Predictive Data"],["ai_validation","🤖 AI Prediction Validation"],...(aiDashboardEnabled?[["ai_dashboard","📈 AI Performance Dashboard"]]:[])];

  // Operator-wise report (uses filtered beams; covers full date range)
  const operatorRpt=useMemo(()=>{
    const m:any={};
    beams.filter((b:any)=>b.dipped_at).forEach((b:any)=>{
      const k=(b.dipping_operator||"—").trim()||"—";
      if(!m[k]) m[k]={operator:k,beams:0,mt:0,avgDipSum:0,avgDipN:0,coatedSum:0,coatedN:0,pass:0,fail:0,high:0,low:0};
      m[k].beams++;
      m[k].mt+=Number(b.total_weight)||0;
      { const c=cycleSecs(b); if(c!=null){ m[k].avgDipSum+=c; m[k].avgDipN++; } }
      if(b.avg_reading){ m[k].coatedSum+=Number(b.avg_reading); m[k].coatedN++; }
      if(b.qc_status==="PASS") m[k].pass++; else if(b.qc_status==="FAIL") m[k].fail++;
      if(b.qc_auto_remark==="High Coating") m[k].high++;
      if(b.qc_auto_remark==="Below Minimum") m[k].low++;
    });
    return Object.values(m).map((r:any)=>({
      ...r, mt:r.mt.toFixed(2),
      avgDip:r.avgDipN?Math.round(r.avgDipSum/r.avgDipN):0,
      avgCoat:r.coatedN?(r.coatedSum/r.coatedN).toFixed(2):"—",
      passRate:r.pass+r.fail?Math.round(r.pass/(r.pass+r.fail)*100):0,
    })).sort((a:any,b:any)=>b.beams-a.beams);
  },[beams]);

  // Daily production (within the filter range, capped at 60 days)
  const dailyRpt=useMemo(()=>{
    // Production days (06:00 → 06:00 plant time) within the selected range.
    const start=new Date(fromDate+"T00:00:00").getTime();
    const end=new Date(toDate+"T00:00:00").getTime();
    const days=Math.min(60, Math.max(1, Math.round((end-start)/864e5)+1));
    const m:any={};
    for(let i=0;i<days;i++){const d=new Date(end-i*864e5);const k=d.toISOString().slice(0,10);m[k]={date:k,loaded:0,dipped:0,completed:0,mt:0,pass:0,fail:0};}
    beams.forEach((b:any)=>{const k=productionDayIdTz(b.loaded_at);if(m[k]){m[k].loaded++;m[k].mt=parseFloat((m[k].mt+(b.total_weight||0)).toFixed(2));}});
    dipped.forEach((b:any)=>{const k=productionDayIdTz(b.immersion_start||b.dipped_at);if(m[k])m[k].dipped++;});
    completed.forEach((b:any)=>{const k=productionDayIdTz(b.qc_completed_at);if(m[k]){m[k].completed++;if(b.qc_status==="PASS")m[k].pass++;else m[k].fail++;}});
    return Object.values(m).sort((a:any,b:any)=>a.date<b.date?1:-1);
  },[beams,dipped,completed,fromDate,toDate]);

  // Coating report: completed beams grouped by required μm spec
  const coatingRpt=useMemo(()=>{
    const m:any={};
    completed.forEach((b:any)=>{
      const k=b.coating_required||"?";
      if(!m[k]) m[k]={spec:k,total:0,pass:0,fail:0,high:0,low:0,sumAvg:0};
      m[k].total++;
      m[k].sumAvg+=Number(b.avg_reading)||0;
      if(b.qc_status==="PASS") m[k].pass++; else m[k].fail++;
      if(b.qc_auto_remark==="High Coating") m[k].high++;
      if(b.qc_auto_remark==="Below Minimum") m[k].low++;
    });
    return Object.values(m).map((r:any)=>({...r,avg:r.total?(r.sumAvg/r.total).toFixed(2):"—",passRate:r.total?Math.round(r.pass/r.total*100):0}));
  },[completed]);

  // ── Loading Register ──────────────────────────────────────
  // Buckets loaded beams by Day-shift (07:00–18:59) vs Night-shift (19:00–06:59),
  // then groups cumulatively by load type with counts and total weight (MT).
  // Honours the same filter set as every other Report tab.
  const [lrShift,setLrShift]=useState<"ALL"|"DAY_7_7"|"NIGHT_7_7">("ALL");
  const inDayWindow = (iso:string)=>{ const h=tzFields(iso).hour; return h>=7 && h<19; };
  const lrBeams = useMemo(()=>beams.filter((b:any)=>{
    if(!b.loaded_at) return false;
    if(lrShift==="DAY_7_7")   return  inDayWindow(b.loaded_at);
    if(lrShift==="NIGHT_7_7") return !inDayWindow(b.loaded_at);
    return true;
  }),[beams,lrShift]);
  const lrByType = useMemo(()=>{
    const m:any={};
    lrBeams.forEach((b:any)=>{
      const k=b.load_type||"—";
      if(!m[k]) m[k]={type:k,count:0,mt:0,beams:[] as string[]};
      m[k].count++;
      m[k].mt = parseFloat((m[k].mt + (Number(b.total_weight)||0)).toFixed(2));
      m[k].beams.push(b.beam_no);
    });
    return Object.values(m).sort((a:any,b:any)=>b.count-a.count);
  },[lrBeams]);
  const lrTotals = useMemo(()=>{
    const day   = beams.filter((b:any)=>b.loaded_at && inDayWindow(b.loaded_at));
    const night = beams.filter((b:any)=>b.loaded_at && !inDayWindow(b.loaded_at));
    const sum=(arr:any[])=>parseFloat(arr.reduce((s:number,b:any)=>s+(Number(b.total_weight)||0),0).toFixed(2));
    return {
      dayCount:day.length, dayMT:sum(day),
      nightCount:night.length, nightMT:sum(night),
      totalCount:day.length+night.length, totalMT:parseFloat((sum(day)+sum(night)).toFixed(2)),
    };
  },[beams]);

  const StatusPill = ({s}:{s:string})=>{
    const c = s==="OK"?T.greenT:s==="High Coating"?T.yellowT:s==="Below Min"?T.redT:T.dim;
    return <span style={{fontWeight:700,color:c}}>{s}</span>;
  };

  return <div>
    <div style={{display:"flex",gap:10,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        {RTABS.map(([id,lbl])=>(
          <button key={id} onClick={()=>sr(id)} style={{padding:"7px 14px",fontSize:12,fontWeight:600,borderRadius:6,cursor:"pointer",
            background:rpt===id?T.amber:T.card,color:rpt===id?"#000":T.muted,border:`1px solid ${rpt===id?T.amber:T.border}`}}>{lbl}</button>
        ))}
      </div>
      <div style={{display:"flex",gap:8,marginLeft:"auto",alignItems:"center",flexWrap:"wrap"}}>
        <button onClick={()=>setShowFilters(v=>!v)} style={{padding:"7px 12px",fontSize:12,fontWeight:700,borderRadius:6,cursor:"pointer",background:T.card,color:T.text,border:`1px solid ${activeFilterCount>0?T.amber:T.border}`}}>
          🔎 Filters {activeFilterCount>0 && <span style={{background:T.amber,color:"#000",borderRadius:10,padding:"1px 7px",marginLeft:6,fontSize:10}}>{activeFilterCount}</span>}
        </button>
        {canExport&&<>
          <Btn variant="green" onClick={()=>exportExcel(rpt)}>📥 Excel: This Tab</Btn>
          <Btn variant="ghost" onClick={()=>exportExcel()}>📦 Excel: All Reports</Btn>
          <Btn variant="amber" onClick={()=>exportMasterSheet()}>📋 Master Sheet</Btn>
        </>}
        {canEmail&&<>
          <Btn variant="purple" onClick={()=>{setEmailScope(rpt);se(true);}}>📧 Email: This Tab</Btn>
          <Btn variant="ghost" onClick={()=>{setEmailScope(undefined);se(true);}}>📧 Email: All</Btn>
          <Btn variant="ghost" onClick={()=>sendEmailEach()} disabled={sending||recipients.length===0}>📧 Email Each Report</Btn>
          <Btn variant="ghost" onClick={()=>sendMasterEmail()} disabled={sending||recipients.length===0}>📧 Email Master</Btn>
        </>}

      </div>

    </div>

    {/* Comprehensive filter panel */}
    {showFilters && <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14,marginBottom:14,display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>FROM PRODUCTION DAY (06:00)</div>
        <DInput dark type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} style={{width:"100%"}}/>
      </div>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>TO PRODUCTION DAY (→ 06:00 next)</div>
        <DInput dark type="date" value={toDate} onChange={e=>setToDate(e.target.value)} style={{width:"100%"}}/>
      </div>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>SHIFT</div>
        <MultiSelectFilter T={T} width="100%" allLabel="All Shifts" value={fltShift} onChange={setFltShift}
          options={[{value:"Day",label:"☀ Day"},{value:"Afternoon",label:"🌤 Afternoon"},{value:"Night",label:"🌙 Night"}]} />
      </div>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>OPERATOR</div>
        <MultiSelectFilter T={T} width="100%" allLabel="All Operators" value={fltOperator} onChange={setFltOperator}
          options={(operators||[]).filter((o:any)=>o.active).map((o:any)=>({value:o.name,label:o.name}))} />
      </div>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>SUPERVISOR</div>
        <MultiSelectFilter T={T} width="100%" allLabel="All Supervisors" value={fltSupervisor} onChange={setFltSupervisor}
          options={(shiftSupervisors||[]).filter((o:any)=>o.active).map((o:any)=>({value:o.name,label:o.name}))} />
      </div>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>STATUS</div>
        <MultiSelectFilter T={T} width="100%" allLabel="All Statuses" value={fltStatus} onChange={setFltStatus}
          options={[{value:"LOADED",label:"Loaded"},{value:"DIPPING",label:"Dipping"},{value:"QC_PENDING",label:"CoJ Pending"},{value:"COMPLETED",label:"Completed"}]} />
      </div>

      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>BEAM NO</div>
        <DInput dark value={fltBeamNo} onChange={e=>setFltBeamNo(e.target.value)} placeholder="contains…" style={{width:"100%"}}/>
      </div>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>THICKNESS</div>
        <DInput dark value={fltThickness} onChange={e=>setFltThickness(e.target.value)} placeholder="e.g. 10" style={{width:"100%"}}/>
      </div>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>MICRON MIN</div>
        <DInput dark type="number" value={fltMicronMin} onChange={e=>setFltMicronMin(e.target.value)} placeholder="μm" style={{width:"100%"}}/>
      </div>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>MICRON MAX</div>
        <DInput dark type="number" value={fltMicronMax} onChange={e=>setFltMicronMax(e.target.value)} placeholder="μm" style={{width:"100%"}}/>
      </div>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>TEMP MIN (°C)</div>
        <DInput dark type="number" value={fltTempMin} onChange={e=>setFltTempMin(e.target.value)} placeholder="°C" style={{width:"100%"}}/>
      </div>
      <div>
        <div style={{fontSize:10,color:T.dim,marginBottom:4}}>TEMP MAX (°C)</div>
        <DInput dark type="number" value={fltTempMax} onChange={e=>setFltTempMax(e.target.value)} placeholder="°C" style={{width:"100%"}}/>
      </div>
      <div style={{gridColumn:"1/-1",display:"flex",gap:8,alignItems:"center",justifyContent:"space-between",flexWrap:"wrap"}}>
        <div style={{fontSize:11,color:T.muted}}>{beams.length} of {allBeams.length} beams match</div>
        {activeFilterCount>0 && <button onClick={clearAllFilters} style={{padding:"6px 12px",fontSize:11,background:T.card,color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,cursor:"pointer"}}>✕ Clear all filters</button>}
      </div>
    </div>}

    {/* Single-day picker — still used by Hourly / Shift views */}
    {(rpt==="hourly"||rpt==="shift")&&<div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10,fontSize:12,color:T.muted}}>
      <span>{rpt==="hourly"?"Production day (06:00 → 06:00):":`Date for ${rpt}:`}</span>
      <DInput dark type="date" value={date} onChange={e=>sd(e.target.value)} style={{width:160}}/>
    </div>}

    {rpt==="loading_register"&&<Card T={T}>
      <SecHead T={T} title="Loading Register" sub="Beams registered in Loading — split by 7 AM–7 PM (Day) vs 7 PM–7 AM (Night), with cumulative load-type totals"/>
      <div style={{padding:"12px 16px",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",borderBottom:`1px solid ${T.border}`}}>
        <span style={{fontSize:11,color:T.muted,fontWeight:700,letterSpacing:".06em",marginRight:4}}>SHIFT FILTER</span>
        {[["ALL","All (24h)"],["DAY_7_7","☀ 7 AM – 7 PM"],["NIGHT_7_7","🌙 7 PM – 7 AM"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setLrShift(id as any)} style={{
            padding:"6px 12px",fontSize:11,fontWeight:700,borderRadius:6,cursor:"pointer",
            background:lrShift===id?T.amber:T.bg,color:lrShift===id?"#000":T.muted,
            border:`1px solid ${lrShift===id?T.amber:T.border}`}}>{lbl}</button>
        ))}
        <div style={{marginLeft:"auto",fontSize:11,color:T.muted}}>
          Showing <strong style={{color:T.text}}>{lrBeams.length}</strong> beams
        </div>
      </div>
      <div style={{padding:16,display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
        <div style={{background:T.bg,border:`1px solid ${T.border}`,borderLeft:`3px solid #FBBF24`,borderRadius:8,padding:"12px 14px"}}>
          <div style={{fontSize:10,color:T.muted,fontWeight:700,letterSpacing:".06em"}}>DAY 07:00–19:00</div>
          <div style={{fontSize:20,fontWeight:800,color:T.text,fontFamily:"monospace",marginTop:4}}>{lrTotals.dayCount}</div>
          <div style={{fontSize:11,color:T.amber,fontFamily:"monospace",fontWeight:700}}>{lrTotals.dayMT} MT</div>
        </div>
        <div style={{background:T.bg,border:`1px solid ${T.border}`,borderLeft:`3px solid #5BA3FF`,borderRadius:8,padding:"12px 14px"}}>
          <div style={{fontSize:10,color:T.muted,fontWeight:700,letterSpacing:".06em"}}>NIGHT 19:00–07:00</div>
          <div style={{fontSize:20,fontWeight:800,color:T.text,fontFamily:"monospace",marginTop:4}}>{lrTotals.nightCount}</div>
          <div style={{fontSize:11,color:T.amber,fontFamily:"monospace",fontWeight:700}}>{lrTotals.nightMT} MT</div>
        </div>
        <div style={{background:T.bg,border:`1px solid ${T.border}`,borderLeft:`3px solid #4ADE80`,borderRadius:8,padding:"12px 14px"}}>
          <div style={{fontSize:10,color:T.muted,fontWeight:700,letterSpacing:".06em"}}>CUMULATIVE (24h)</div>
          <div style={{fontSize:20,fontWeight:800,color:T.text,fontFamily:"monospace",marginTop:4}}>{lrTotals.totalCount}</div>
          <div style={{fontSize:11,color:T.amber,fontFamily:"monospace",fontWeight:700}}>{lrTotals.totalMT} MT</div>
        </div>
      </div>
      {lrByType.length===0
        ? <div style={{padding:32,textAlign:"center",color:T.dim}}>No loaded beams match the current filters</div>
        : <Table T={T}
            headers={["Load Type","Beams Loaded","Total Weight","Beam Nos"]}
            rows={lrByType.map((r:any)=>[
              <strong style={{color:T.amber}}>{r.type}</strong>,
              mn(r.count,T.cyanT),
              mn(r.mt+" MT",T.greenT),
              <span style={{fontSize:11,color:T.muted,whiteSpace:"normal",wordBreak:"break-word"}}>{(r.beams||[]).join(", ")}</span>,
            ])}/>}
    </Card>}

    {rpt==="dipping_register"&&<Card T={T}>
      <SecHead T={T} title="Dipping Register" sub="Every beam dipped — Production-Day shifts (A 06–14 · B 14–22 · C 22–06, C reports under start date)"/>
      <div style={{padding:"12px 16px",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",borderBottom:`1px solid ${T.border}`}}>
        <span style={{fontSize:11,color:T.muted,fontWeight:700,letterSpacing:".06em",marginRight:4}}>VIEW BY</span>
        {[["none","Flat"],["date","Production Date"],["shift","Shift"],["load","Load Type"],["operator","Operator"],["spec","Coating Spec"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setDrGroupBy(id as any)} style={{
            padding:"6px 12px",fontSize:11,fontWeight:700,borderRadius:6,cursor:"pointer",
            background:drGroupBy===id?T.amber:T.bg,color:drGroupBy===id?"#000":T.muted,
            border:`1px solid ${drGroupBy===id?T.amber:T.border}`}}>{lbl}</button>
        ))}
        <div style={{marginLeft:"auto",fontSize:11,color:T.muted}}>
          Showing <strong style={{color:T.text}}>{drRows.length}</strong> dipped beams
        </div>
      </div>
      {drRows.length===0
        ? <div style={{padding:32,textAlign:"center",color:T.dim}}>No dipping records match current filters</div>
        : drGroupBy==="none"
          ? <Table T={T}
              headers={["Prod Date","Shift","Beam No","Route Card","Part No","Load Type","Material","Surface","Qty","Wt (MT)","Operator","Entry","Exit","Cycle","Spec (µm)","Readings","Avg µm",...(varianceEnabled?["Ref Beam","ΔTotal","Status"]:[])]}
              rows={drRows.map((r:any)=>[
                <span style={{fontFamily:"monospace",color:T.amber}}>{r.productionDate}</span>,
                <strong style={{color:T.cyanT}}>{r.shift}</strong>,
                bn(r.beamNo), r.routeCard,
                <span style={{fontSize:11,color:T.muted,maxWidth:140,display:"block",overflow:"hidden",textOverflow:"ellipsis"}}>{r.partNo}</span>,
                r.loadType,
                <strong style={{color:T.cyanT,fontSize:11}}>{r.materialType||"—"}</strong>,
                <span style={{color:"#F0ABFC",fontSize:11,fontWeight:700}}>{r.surfaceCondition}</span>,
                r.qty, mn(r.weightMT+" MT",T.greenT), r.operator,
                <span style={{fontSize:11}}>{r.entryTime}</span>,
                <span style={{fontSize:11}}>{r.exitTime}</span>,
                mn(r.cycleTime),
                <strong style={{fontFamily:"monospace",color:T.amber}}>{r.coatingSpec}</strong>,
                <span style={{fontSize:10,color:T.muted,fontFamily:"monospace"}}>{r.individualReadings||"—"}</span>,
                <strong style={{fontFamily:"monospace",color:T.text}}>{r.avgCoating||"—"}</strong>,
                ...(varianceEnabled?[
                  <span style={{fontFamily:"monospace",fontSize:11,color:T.muted}}>{r.refBeam||"—"}</span>,
                  <span style={{fontFamily:"monospace",fontSize:11,color:r.dTotal?.startsWith("+")?"#FB923C":(r.dTotal?.startsWith("-")?"#22D3EE":T.dim),fontWeight:700}}>{r.dTotal||"—"}</span>,
                  <span style={{fontSize:10,color:T.muted}}>{r.varStatus||"—"}</span>,
                ]:[]),
              ])}/>
          : <div style={{padding:16,display:"flex",flexDirection:"column",gap:14}}>
              {drGroups!.map(([gk,gr])=>(
                <div key={gk} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:12}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                    <div style={{fontSize:13,fontWeight:800,color:T.amber}}>{gk}</div>
                    <div style={{fontSize:11,color:T.muted}}>
                      {gr.length} beams · {gr.reduce((s:number,r:any)=>s+(Number(r.weightMT)||0),0).toFixed(2)} MT
                    </div>
                  </div>
                  <Table T={T}
                    headers={["Prod Date","Shift","Beam No","Route Card","Load Type","Material","Surface","Wt (MT)","Operator","Entry","Exit","Cycle","Spec","Avg µm",...(varianceEnabled?["Ref Beam","ΔTotal","Status"]:[])]}
                    rows={gr.map((r:any)=>[
                      <span style={{fontFamily:"monospace",fontSize:11,color:T.muted}}>{r.productionDate}</span>,
                      r.shift, bn(r.beamNo), r.routeCard, r.loadType,
                      <strong style={{color:T.cyanT,fontSize:11}}>{r.materialType||"—"}</strong>,
                      <span style={{color:"#F0ABFC",fontSize:11,fontWeight:700}}>{r.surfaceCondition}</span>,
                      mn(r.weightMT+" MT",T.greenT), r.operator,
                      <span style={{fontSize:11}}>{r.entryTime}</span>,
                      <span style={{fontSize:11}}>{r.exitTime}</span>,
                      mn(r.cycleTime),
                      <strong style={{fontFamily:"monospace",color:T.amber}}>{r.coatingSpec}</strong>,
                      <strong style={{fontFamily:"monospace",color:T.text}}>{r.avgCoating||"—"}</strong>,
                      ...(varianceEnabled?[
                        <span style={{fontFamily:"monospace",fontSize:11,color:T.muted}}>{r.refBeam||"—"}</span>,
                        <span style={{fontFamily:"monospace",fontSize:11,color:r.dTotal?.startsWith("+")?"#FB923C":(r.dTotal?.startsWith("-")?"#22D3EE":T.dim),fontWeight:700}}>{r.dTotal||"—"}</span>,
                        <span style={{fontSize:10,color:T.muted}}>{r.varStatus||"—"}</span>,
                      ]:[]),
                    ])}/>
                </div>
              ))}
            </div>}
    </Card>}




    {rpt==="hourly"&&<Card T={T}>
      <SecHead T={T} title={`Hourly Dipping Report — Production Day ${fmtDate(date+"T12:00:00")} 06:00 → ${fmtDate(nextDateStr(date)+"T12:00:00")} 06:00`} sub="Production day runs 06:00 → 06:00 (plant time). Bucketed by Immersion Start Time; cumulative totals reset only at 06:00."/>
      {hourly.length===0
        ?<div style={{padding:32,textAlign:"center",color:T.dim}}>No dipping activity matching filters on selected date</div>
        :<div style={{padding:16,display:"flex",flexDirection:"column",gap:10}}>
          {hourly.map((r:any)=>(
            <div key={r.key} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:16}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                <div style={{fontFamily:"monospace",fontSize:14,color:T.amber,fontWeight:700}}>{r.label}{r.nextDay?<span style={{fontSize:11,color:T.dim,marginLeft:6}}>({fmtDate(nextDateStr(date)+"T12:00:00")})</span>:null}</div>
                <div style={{display:"flex",gap:20}}>
                  <span style={{color:T.cyanT,fontSize:13,fontWeight:700}}>{r.count} Beams</span>
                  <span style={{color:T.greenT,fontSize:13,fontWeight:700}}>{r.totalMT} MT</span>
                  <span style={{color:T.muted,fontSize:12}}>{r.types}</span>
                </div>
              </div>
              <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:10,padding:"6px 10px",background:T.surf,borderRadius:5,fontSize:11}}>
                <span style={{color:T.dim}}>Cumulative Beam Count: <strong style={{color:T.cyanT,fontFamily:"monospace"}}>{r.cumCount}</strong></span>
                <span style={{color:T.dim}}>Cumulative Weight: <strong style={{color:T.greenT,fontFamily:"monospace"}}>{r.cumMT} MT</strong></span>
                <span style={{color:T.dim}}>Cumulative Load Type: <strong style={{color:T.amber}}>{r.cumTypes||"—"}</strong></span>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {r.beams.map((b:any)=>(
                  <div key={txn(b)} style={{display:"flex",gap:16,fontSize:11,color:T.muted,padding:"5px 10px",background:T.surf,borderRadius:4,flexWrap:"wrap"}}>
                    <span style={{color:T.amber,fontFamily:"monospace",minWidth:72}}>{b.beam_no}</span>
                    <span>{b.part_nos}</span>
                    <span>{b.load_type}</span>
                    <span>{b.total_weight} MT</span>
                    <span style={{color:T.cyanT}}>Start: {fmtTimeTz(b.immersion_start)}</span>
                    <span>Imm: {fmtDur(b.immersion_duration)}</span>
                    <span>React: {fmtDur(b.reaction_duration)}</span>
                    <span>Withd: {fmtDur(b.withdrawal_duration)}</span>
                    <span style={{color:b.entry_mode==="manual"?"#FB923C":"#4ADE80",fontWeight:700}}>{b.entry_mode==="manual"?"✍ Manual":"⏱ Live"}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>}
    </Card>}

    {rpt==="shift"&&<Card T={T}>
      <SecHead T={T} title={`Shift-wise Report — ${fmtDate(date+"T00:00:00")}`}/>
      <Table T={T} headers={["Shift","Beams Dipped","Total MT","Avg Cycle Time","CoJ Pass","CoJ Fail"]}
        rows={shiftRpt.map((r:any)=>[
          <strong style={{color:T.amber}}>{r.shift}</strong>,
          mn(r.count,T.cyanT), mn(r.totalMT+" MT",T.greenT), mn(fmtDur(r.avgDip)),
          <span style={{color:T.greenT,fontWeight:700}}>{r.pass}</span>,
          <span style={{color:r.fail>0?T.redT:T.dim,fontWeight:700}}>{r.fail}</span>,
        ])}/>
    </Card>}

    {rpt==="daily"&&<Card T={T}>
      <SecHead T={T} title={`Daily Production Report — ${productionRangeLabel(fromDate,toDate)}`} sub="Production day 06:00 → 06:00 · Loaded / Dipped / Completed / MT / QC outcomes"/>
      <Table T={T}
        headers={["Date","Loaded","Dipped","Completed","Total MT","CoJ Pass","CoJ Fail"]}
        rows={dailyRpt.map((r:any)=>[
          <strong style={{color:T.amber,fontFamily:"monospace"}}>{r.date}</strong>,
          mn(r.loaded,T.blueT), mn(r.dipped,"#FB923C"), mn(r.completed,T.cyanT),
          mn(r.mt+" MT",T.amber),
          <span style={{color:T.greenT,fontWeight:700}}>{r.pass}</span>,
          <span style={{color:r.fail>0?T.redT:T.dim,fontWeight:700}}>{r.fail}</span>,
        ])}/>
    </Card>}

    {rpt==="operator"&&<Card T={T}>
      <SecHead T={T} title="Operator-wise Report" sub="Per dipping operator — beams, MT, average coating, pass rate (current filters apply)"/>
      {operatorRpt.length===0
        ? <div style={{padding:32,textAlign:"center",color:T.dim}}>No dipping activity recorded for current filters</div>
        : <Table T={T}
            headers={["Operator","Beams","Total MT","Avg Cycle Time","Avg μm","Pass","Fail","High","Low","Pass Rate"]}
            rows={operatorRpt.map((r:any)=>[
              <strong style={{color:T.text}}>{r.operator}</strong>,
              mn(r.beams,T.cyanT),
              mn(r.mt+" MT",T.amber),
              mn(fmtDur(r.avgDip)),
              <strong style={{fontFamily:"monospace",color:T.text}}>{r.avgCoat}</strong>,
              <span style={{color:T.greenT,fontWeight:700}}>{r.pass}</span>,
              <span style={{color:r.fail>0?T.redT:T.dim,fontWeight:700}}>{r.fail}</span>,
              <span style={{color:r.high>0?T.yellowT:T.dim,fontWeight:700}}>{r.high}</span>,
              <span style={{color:r.low>0?T.redT:T.dim,fontWeight:700}}>{r.low}</span>,
              <span style={{color:r.passRate>=90?T.greenT:r.passRate>=70?T.yellowT:T.redT,fontWeight:700,fontFamily:"monospace"}}>{r.passRate}%</span>,
            ])}/>}
    </Card>}


    {rpt==="coating"&&<Card T={T}>
      <SecHead T={T} title="Coating Report — Grouped by Spec" sub="Avg μm, pass rate, and out-of-range counts per coating requirement"/>
      {coatingRpt.length===0
        ? <div style={{padding:32,textAlign:"center",color:T.dim}}>No completed QC data yet</div>
        : <Table T={T}
            headers={["Spec (μm)","Beams","Avg μm","Pass","Fail","High Coating","Below Min","Pass Rate"]}
            rows={coatingRpt.map((r:any)=>[
              <strong style={{color:T.amber,fontFamily:"monospace"}}>{r.spec} μm</strong>,
              mn(r.total,T.cyanT),
              <strong style={{fontFamily:"monospace",color:T.text}}>{r.avg}</strong>,
              <span style={{color:T.greenT,fontWeight:700}}>{r.pass}</span>,
              <span style={{color:r.fail>0?T.redT:T.dim,fontWeight:700}}>{r.fail}</span>,
              <span style={{color:r.high>0?T.yellowT:T.dim,fontWeight:700}}>{r.high}</span>,
              <span style={{color:r.low>0?T.redT:T.dim,fontWeight:700}}>{r.low}</span>,
              <span style={{color:r.passRate>=90?T.greenT:r.passRate>=70?T.yellowT:T.redT,fontWeight:700,fontFamily:"monospace"}}>{r.passRate}%</span>,
            ])}/>}
    </Card>}



    {rpt==="beam"&&<Card T={T}>
      <SecHead T={T} title="Complete Beam-wise Report" sub="All stages merged per beam"/>
      <Table T={T}
        headers={["Beam No","Part No(s)","Load Type","Weight","μm","Shift","Loaded","Dipped","Cycle Time","Avg μm (7pt)","CoJ Result","Completed At",...(isAdmin?["Admin"]:[])]}
        rows={beams.sort((a:any,b:any)=>new Date(b.loaded_at).getTime()-new Date(a.loaded_at).getTime()).map((b:any)=>[
          bn(b.beam_no),
          <span style={{fontSize:11,color:T.muted,maxWidth:140,display:"block",overflow:"hidden",textOverflow:"ellipsis"}}>{b.part_nos}</span>,
          b.load_type, b.total_weight+"MT", b.coating_required+"μm",
          <span style={{fontSize:10,color:"#FDE047"}}>{b.shift}</span>,
          <span style={{fontSize:11}}>{fmt12(b.loaded_at)}</span>,
          b.dipped_at?<span style={{fontSize:11,color:T.amber}}>{fmt12(b.dipped_at)}</span>:<span style={{color:T.dim}}>—</span>,
          mn(fmtDur(cycleSecs(b))),
          b.avg_reading?<strong style={{fontFamily:"monospace",color:b.qc_auto_remark==="Below Minimum"?T.redT:b.qc_auto_remark==="High Coating"?T.yellowT:T.greenT}}>{b.avg_reading}μm</strong>:<span style={{color:T.dim}}>—</span>,
          b.qc_status?<span style={{fontWeight:700,color:b.qc_status==="PASS"?T.greenT:T.redT}}>{b.qc_status}</span>:<span style={{color:T.dim}}>—</span>,
          <span style={{fontSize:11}}>{fmt12(b.qc_completed_at)}</span>,
          ...(isAdmin?[<button key={txn(b)+"_rd"} onClick={()=>{ if(confirm(`Permanently delete beam ${b.beam_no}? It will be removed from every report.`)) deleteBeams([txn(b)]); }} style={{padding:"4px 10px",borderRadius:5,background:"#2A0808",color:"#F87171",border:"1px solid #F8717160",fontSize:10,fontWeight:700,cursor:"pointer"}}>🗑</button>]:[]),
        ])}/>
    </Card>}

    {rpt==="qc"&&<Card T={T}>
      <SecHead T={T} title="Coating on Job — 30-Point Elcometer" sub="Job parameters, all 30 readings (FW/MW/LW · Outside/Inside), six section averages and Total Average — bands are the acceptance requirement only; excess over the floor is wasted zinc"/>
      {(()=>{ const ex=completed.map((b:any)=>zincExcess(b.coating_required,b.avg_reading)).filter(Boolean) as any[];
        if(!ex.length) return null;
        const avgEx=ex.reduce((s,e)=>s+e.excessUm,0)/ex.length;
        const avgPct=ex.reduce((s,e)=>s+e.excessPct,0)/ex.length;
        return (
          <div style={{margin:"12px 16px 0",display:"flex",gap:14,flexWrap:"wrap",alignItems:"center",background:"#0A1520",border:`1px solid ${T.border}`,borderRadius:8,padding:"8px 12px"}}>
            <span style={{fontSize:10,fontWeight:800,color:T.amber,letterSpacing:".05em"}}>ZINC CONSUMPTION — EXCESS OVER REQUIREMENT FLOOR</span>
            <span style={{fontSize:11,color:T.muted}}>Records <strong style={{color:T.text,fontFamily:"monospace"}}>{ex.length}</strong></span>
            <span style={{fontSize:11,color:T.muted}}>Avg excess <strong style={{color:avgEx>5?T.redT:avgEx>2?T.yellowT:T.greenT,fontFamily:"monospace"}}>{avgEx.toFixed(2)} μm</strong></span>
            <span style={{fontSize:11,color:T.muted}}>Avg excess zinc <strong style={{color:avgPct>6?T.redT:avgPct>3?T.yellowT:T.greenT,fontFamily:"monospace"}}>{avgPct.toFixed(2)}%</strong></span>
          </div>
        ); })()}
      <div style={{padding:16,display:"flex",flexDirection:"column",gap:12}}>
        {completed.length===0 && <div style={{padding:24,textAlign:"center",color:T.dim}}>No completed CoJ records for current filters</div>}

        {completed.sort((a:any,b:any)=>new Date(b.qc_completed_at).getTime()-new Date(a.qc_completed_at).getTime()).map((b:any)=>{
          const v2 = isV2Coj(b);
          const subs = v2 ? v2SubAverages(b.elcometer_v2) : null;
          const flat = v2 ? v2FlatReadings(b.elcometer_v2) : [];
          const legacyE = Array.isArray(b.elcometer) ? b.elcometer : [];
          const totalAvg = v2 && flat.length ? flat.reduce((s:number,n:number)=>s+n,0)/flat.length : Number(b.avg_reading);
          const groups: [string, number[]][] = v2 ? [
            ["FW Outside", flat.slice(0,5)], ["FW Inside", flat.slice(5,10)],
            ["MW Outside", flat.slice(10,15)], ["MW Inside", flat.slice(15,20)],
            ["LW Outside", flat.slice(20,25)], ["LW Inside", flat.slice(25,30)],
          ] : [];
          const subTiles: [string, number|null][] = subs ? [
            ["FW Outside Average", subs.fwOut], ["FW Inside Average", subs.fwIn],
            ["MW Outside Average", subs.mwOut], ["MW Inside Average", subs.mwIn],
            ["LW Outside Average", subs.lwOut], ["LW Inside Average", subs.lwIn],
          ] : [];
          const jp = cojJobParams(b);
          const band = cojBand(b.coating_required);
          const zx = zincExcess(b.coating_required, totalAvg);
          const paramTiles: [string, string][] = [
            ["Weight", jp.weightMT!=null?`${jp.weightMT} MT`:"—"],
            ["Thickness", jp.thicknessMm!=null?`${jp.thicknessMm} mm`:"—"],
            ["Length", jp.lengthMm!=null?`${jp.lengthMm} mm`:"—"],
            ["Load Type", jp.loadType||"—"],
            ["Surface Condition", fmtSurface(jp.surface)],
            ["Zinc Bath Temp", jp.bathTemp!=null?`${jp.bathTemp} °C`:"—"],
            ["Total Dipping Time", jp.totalSec!=null?`${fmtMMSS(jp.totalSec)} (${jp.totalSec}s)`:"—"],
          ];
          return (
            <div key={txn(b)} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:12}}>
              <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:8}}>
                <strong style={{fontFamily:"monospace",color:T.amber,fontSize:14}}>Beam {b.beam_no}</strong>
                <span style={{fontSize:11,color:T.muted}}>{b.part_nos||"—"}</span>
                <span style={{fontSize:11,color:T.cyanT,fontWeight:700}}>{b.material_type||"—"} · {fmtSurface(b.surface_condition)}</span>
                <span style={{fontFamily:"monospace",fontSize:11,color:"#A78BFA"}}>Req {b.coating_required} μm{band?` (requirement ${band.min}-${band.max})`:""}</span>
                <span style={{fontSize:10,color:T.dim,fontFamily:"monospace"}}>{v2?"30-Point (5×6)":"7-Point (legacy)"}</span>
                <span style={{marginLeft:"auto",fontSize:11,color:T.muted}}>{b.qc_completed_by_name} · {fmt12(b.qc_completed_at)}</span>
                <span style={{fontWeight:800,color:b.qc_status==="PASS"?T.greenT:T.redT}}>{b.qc_status}</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:6,marginBottom:8}}>
                {paramTiles.map(([l,v])=>(
                  <div key={l} style={{background:"#0A1520",border:`1px solid ${T.border}`,borderRadius:6,padding:"5px 7px"}}>
                    <div style={{fontSize:9,color:T.dim,fontWeight:700,textTransform:"uppercase",letterSpacing:".04em"}}>{l}</div>
                    <div style={{fontFamily:"monospace",fontSize:11,fontWeight:700,color:T.text}}>{v}</div>
                  </div>
                ))}
                {zx && <div style={{background:"#1A1206",border:"1px solid #FBBF2455",borderRadius:6,padding:"5px 7px"}}>
                  <div style={{fontSize:9,color:T.yellowT,fontWeight:700,textTransform:"uppercase",letterSpacing:".04em"}}>Excess over {zx.min} μm floor</div>
                  <div style={{fontFamily:"monospace",fontSize:11,fontWeight:800,color:zx.excessUm>5?T.redT:zx.excessUm>2?T.yellowT:T.greenT}}>
                    {zx.excessUm>0?"+":""}{zx.excessUm} μm · {zx.excessPct}% zinc
                  </div>
                </div>}
              </div>

              {v2 ? (
                <>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:6}}>
                    {groups.map(([g,vals])=>(
                      <div key={g} style={{background:"#0A1520",border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 8px"}}>
                        <div style={{fontSize:9,color:T.dim,fontWeight:700,textTransform:"uppercase",letterSpacing:".05em",marginBottom:3}}>{g}</div>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                          {vals.map((n,i)=><span key={i} style={{fontFamily:"monospace",fontSize:11,color:T.text}}>{n!=null?Number(n).toFixed(2):"—"}</span>)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:6,marginTop:8}}>
                    {subTiles.map(([l,v])=>(
                      <div key={l} style={{background:"#060E18",border:`1px solid ${T.border}`,borderRadius:6,padding:"5px 7px",textAlign:"center"}}>
                        <div style={{fontSize:9,color:T.dim,fontWeight:700}}>{l}</div>
                        <div style={{fontFamily:"monospace",fontSize:12,fontWeight:800,color:T.text}}>{v!=null?Number(v).toFixed(2):"—"}</div>
                      </div>
                    ))}
                    <div style={{background:"#0A2014",border:"1px solid #4ADE8060",borderRadius:6,padding:"5px 7px",textAlign:"center"}}>
                      <div style={{fontSize:9,color:T.greenT,fontWeight:700}}>Total Average (30 ÷ 30)</div>
                      <div style={{fontFamily:"monospace",fontSize:12,fontWeight:800,color:T.greenT}}>{Number.isFinite(totalAvg)?totalAvg.toFixed(2):"—"}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
                  {[0,1,2,3,4,5,6].map(i=>(
                    <span key={i} style={{fontFamily:"monospace",fontSize:11,color:T.muted}}>P{i+1}: <strong style={{color:T.text}}>{legacyE[i]??"—"}</strong></span>
                  ))}
                  <span style={{fontFamily:"monospace",fontSize:12,fontWeight:800,color:T.greenT}}>Total Average {b.avg_reading} μm</span>
                </div>
              )}
              {(()=>{ const cmp=cojModelComparison(b,mlrStore,aiModels); if(!cmp.length) return null; return (
                <div style={{marginTop:10,background:"#060E18",border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 10px"}}>
                  <div style={{fontSize:10,fontWeight:800,color:"#FB923C",letterSpacing:".05em",marginBottom:6}}>
                    COJ HISTORY → MODEL PREDICTION (at actual dipping time {fmtMMSS(cmp[0].actualSec)})
                  </div>
                  <Table T={T} headers={["Model","Actual Time","Expected Coating","Actual CoJ","Difference","Accuracy"]}
                    rows={cmp.map((r:any)=>[
                      <strong style={{color:T.cyanT}}>{r.label}</strong>,
                      <span style={{fontFamily:"monospace"}}>{r.actualSec} sec</span>,
                      <span style={{fontFamily:"monospace"}}>{r.expected.toFixed(2)} μm</span>,
                      <span style={{fontFamily:"monospace"}}>{r.actual.toFixed(2)} μm</span>,
                      <span style={{fontFamily:"monospace",color:Math.abs(r.diff)<=3?T.greenT:T.yellowT}}>{aiSigned(r.diff," μm")}</span>,
                      <strong style={{fontFamily:"monospace",color:r.accuracy>=95?T.greenT:r.accuracy>=85?T.yellowT:T.redT}}>{r.accuracy}%</strong>,
                    ])}/>
                </div>
              ); })()}
              <div style={{marginTop:8,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                <QCBadge remark={b.qc_auto_remark}/>
                <span style={{fontSize:11,color:T.muted}}>{b.qc_remark||""}</span>
              </div>

            </div>
          );
        })}
      </div>
    </Card>}

    {rpt==="operator_qc"&&<Card T={T}>
      <SecHead T={T} title="Coating on Job — by Operator" sub="Grouped by required micron; Matching Status uses per-band tolerance rules (admin-editable)"/>
      {operatorQcRpt.length===0
        ? <div style={{padding:32,textAlign:"center",color:T.dim}}>No completed CoJ records for current filters</div>
        : <Table T={T}
            headers={["Operator","Required μm","Total Beams","Avg Coating","Pass","Fail","Matching Status"]}
            rows={operatorQcRpt.map((r:any)=>[
              <strong style={{color:T.text}}>{r.operator}</strong>,
              <div>
                <strong style={{fontFamily:"monospace",color:T.amber}}>{r.required} μm</strong>
                <div style={{fontSize:9,color:T.dim,marginTop:2,fontFamily:"monospace"}}>Rule: {r.rule}</div>
              </div>,
              mn(r.beams,T.cyanT),
              <strong style={{fontFamily:"monospace",color:T.text}}>{r.avg}</strong>,
              <span style={{color:T.greenT,fontWeight:700}}>{r.pass}</span>,
              <span style={{color:r.fail>0?T.redT:T.dim,fontWeight:700}}>{r.fail}</span>,
              <StatusPill s={r.status}/>,
            ])}/>}
    </Card>}

    {rpt==="supervisor_qc"&&<Card T={T}>
      <SecHead T={T} title="Coating on Job — by Shift Supervisor" sub="Grouped by required micron; Matching Status uses per-band tolerance rules (admin-editable)"/>
      {supervisorQcRpt.length===0
        ? <div style={{padding:32,textAlign:"center",color:T.dim}}>No completed CoJ records for current filters</div>
        : <Table T={T}
            headers={["Shift Supervisor","Required μm","Total Beams","Avg Coating","Pass","Fail","Matching Status"]}
            rows={supervisorQcRpt.map((r:any)=>[
              <strong style={{color:T.text}}>{r.supervisor}</strong>,
              <div>
                <strong style={{fontFamily:"monospace",color:T.amber}}>{r.required} μm</strong>
                <div style={{fontSize:9,color:T.dim,marginTop:2,fontFamily:"monospace"}}>Rule: {r.rule}</div>
              </div>,
              mn(r.beams,T.cyanT),
              <strong style={{fontFamily:"monospace",color:T.text}}>{r.avg}</strong>,
              <span style={{color:T.greenT,fontWeight:700}}>{r.pass}</span>,
              <span style={{color:r.fail>0?T.redT:T.dim,fontWeight:700}}>{r.fail}</span>,
              <StatusPill s={r.status}/>,
            ])}/>}
    </Card>}

    {rpt==="regression"&&<Card T={T}>
      <SecHead T={T} title="Regression Predictive Data" sub="Actual input & prediction parameters used by the regression model for each processed beam"/>
      {regRows.length===0
        ? <div style={{padding:32,textAlign:"center",color:T.dim}}>No dipped beams for current filters</div>
        : <div style={{overflowX:"auto"}}><Table T={T}
            headers={["Production Date","Shift","Beam No","Total Cycle Time (MM:SS)","Total Time (Sec)","Avg Coating (µm)","Bath Temp (°C)","Material Type","Load Type","Surface Condition","Weight (MT)","Thickness (mm)","Length (mm)","Qty","Specific Coating (µm)"]}
            rows={regRows.map((r:any)=>{
              const dash=(v:any)=> v==null||v===""?<span style={{color:T.dim}}>—</span>:v;
              return [
                <span style={{fontFamily:"monospace",color:T.muted}}>{r.productionDate||"—"}</span>,
                <span style={{color:T.muted}}>{r.shift}</span>,
                <strong style={{color:T.text}}>{r.beamNo}</strong>,
                <span style={{fontFamily:"monospace",color:T.cyanT}}>{r.cycleTime||"—"}</span>,
                <span style={{fontFamily:"monospace",color:T.muted}}>{dash(r.totalSec)}</span>,
                <strong style={{fontFamily:"monospace",color:T.amber}}>{dash(r.avgCoating)}</strong>,
                <span style={{fontFamily:"monospace",color:T.text}}>{dash(r.bathTemp)}</span>,
                <span style={{color:T.text}}>{r.materialType||<span style={{color:T.dim}}>—</span>}</span>,
                <span style={{color:T.muted}}>{r.loadType||"—"}</span>,
                <span style={{color:T.muted}}>{r.surfaceCondition||"—"}</span>,
                <span style={{fontFamily:"monospace",color:T.text}}>{dash(r.weightMT)}</span>,
                <span style={{fontFamily:"monospace",color:T.text}}>{dash(r.thickness)}</span>,
                <span style={{fontFamily:"monospace",color:T.text}}>{dash(r.length)}</span>,
                <span style={{fontFamily:"monospace",color:T.text}}>{dash(r.qty)}</span>,
                <strong style={{fontFamily:"monospace",color:T.greenT}}>{dash(r.coatingSpec)}</strong>,
              ];
            })}/></div>}
    </Card>}

    {rpt==="ai_validation"&&<Card T={T}>
      <SecHead T={T} title="AI Prediction Validation" sub="Predicted vs actual total dipping time and coating, with accuracy per AI model"/>
      {aiRows.length===0
        ? <div style={{padding:32,textAlign:"center",color:T.dim}}>No AI predictions recorded yet — predictions are captured when a beam is dipped.</div>
        : <div style={{overflowX:"auto"}}><Table T={T}
            headers={["Production Date","Shift","Beam No","AI Model","Source","Material / Surface","Predicted Time (Sec)","Actual Time (Sec)","Δ Time (Sec)","Expected µm","Actual µm","Δ µm","Time Acc %","Coating Acc %","Overall Acc %","Confidence %","Use for Retraining"]}
            rows={aiRows.map((r:any)=>{
              const dash=(v:any)=> v==null||v===""?<span style={{color:T.dim}}>—</span>:v;
              const accCol=(v:any)=> v==null?T.dim : v>=90?T.greenT : v>=75?T.amber : T.redT;
              return [
                <span style={{fontFamily:"monospace",color:T.muted}}>{r.productionDate||"—"}</span>,
                <span style={{color:T.muted}}>{r.shift}</span>,
                <strong style={{color:T.text}}>{r.beamNo}</strong>,
                <span style={{color:T.cyanT,fontWeight:700}}>{r.modelLabel}</span>,
                <span style={{color:T.muted}}>{r.tier}</span>,
                <span style={{color:T.muted}}>{(r.materialType||"—")+" / "+(fmtSurface(r.surfaceCondition)||"—")}</span>,
                <span style={{fontFamily:"monospace",color:T.text}}>{dash(r.predictedSec)}</span>,
                <span style={{fontFamily:"monospace",color:T.text}}>{dash(r.actualSec)}</span>,
                <span style={{fontFamily:"monospace",color:accCol(r.timeAccuracy)}}>{aiSigned(r.timeVariation)}</span>,
                <span style={{fontFamily:"monospace",color:T.amber}}>{dash(r.expectedCoating)}</span>,
                <span style={{fontFamily:"monospace",color:T.amber}}>{dash(r.actualCoating)}</span>,
                <span style={{fontFamily:"monospace",color:accCol(r.coatingAccuracy)}}>{aiSigned(r.coatingVariation)}</span>,
                <strong style={{fontFamily:"monospace",color:accCol(r.timeAccuracy)}}>{dash(r.timeAccuracy)}</strong>,
                <strong style={{fontFamily:"monospace",color:accCol(r.coatingAccuracy)}}>{dash(r.coatingAccuracy)}</strong>,
                <strong style={{fontFamily:"monospace",color:accCol(r.overallAccuracy)}}>{dash(r.overallAccuracy)}</strong>,
                <span style={{fontFamily:"monospace",color:T.muted}}>{dash(r.confidencePct)}</span>,
                <label style={{display:"flex",alignItems:"center",gap:5,cursor:isAdmin?"pointer":"not-allowed",color:T.muted,fontSize:11}}>
                  <input type="checkbox" disabled={!isAdmin} checked={!!r.includedInTraining}
                    onChange={e=>toggleTraining(r.beamNo,e.target.checked)}/>
                  {r.includedInTraining?"Included":"Excluded"}
                </label>,
              ];
            })}/></div>}
    </Card>}

    {rpt==="ai_dashboard"&&aiDashboardEnabled&&<Card T={T}>
      <SecHead T={T} title="AI Performance Dashboard" sub="Model comparison, accuracy trend and training status"/>
      {aiRows.length===0
        ? <div style={{padding:32,textAlign:"center",color:T.dim}}>No AI predictions recorded yet.</div>
        : <div style={{display:"grid",gap:14}}>
            <div style={{fontSize:12,color:T.muted}}>
              Active model{normalizeAiSelection(aiModels).length===1?"":"s"}: <b style={{color:T.cyanT}}>{normalizeAiSelection(aiModels).map((m:any)=>AI_MODEL_LABEL[m]).join(", ")}</b>
              {aiBest && <> · Best performing: <b style={{color:T.greenT}}>{aiBest.key}</b> ({aiBest.avgOverallAccuracy}% over {aiBest.count} predictions)</>}
            </div>
            <div><div style={{fontSize:12,fontWeight:800,color:T.text,marginBottom:6}}>Model comparison</div>
              <Table T={T} headers={["Model","Predictions","Avg Δ Time (Sec)","Avg Δ Coating (µm)","Avg Time Acc %","Avg Coating Acc %","Avg Overall Acc %","High Conf","Low Conf"]}
                rows={aiByModel.map((r:any)=>[r.key,r.count,aiSigned(r.avgTimeVariation),aiSigned(r.avgCoatingVariation),r.avgTimeAccuracy??"—",r.avgCoatingAccuracy??"—",<strong style={{color:T.greenT}}>{r.avgOverallAccuracy??"—"}</strong>,r.highConfidence,r.lowConfidence])}/></div>
            <div><div style={{fontSize:12,fontWeight:800,color:T.text,marginBottom:6}}>Accuracy trend by production date</div>
              <Table T={T} headers={["Production Date","Predictions","Avg Time Acc %","Avg Coating Acc %","Avg Overall Acc %"]}
                rows={aiByDate.map((r:any)=>[r.key,r.count,r.avgTimeAccuracy??"—",r.avgCoatingAccuracy??"—",r.avgOverallAccuracy??"—"])}/></div>
            <div><div style={{fontSize:12,fontWeight:800,color:T.text,marginBottom:6}}>Accuracy by material / surface</div>
              <Table T={T} headers={["Material / Surface","Predictions","Avg Δ Time (Sec)","Avg Overall Acc %"]}
                rows={aiByMaterial.map((r:any)=>[r.key,r.count,aiSigned(r.avgTimeVariation),r.avgOverallAccuracy??"—"])}/></div>
            <div><div style={{fontSize:12,fontWeight:800,color:T.text,marginBottom:6}}>Training status</div>
              <Table T={T} headers={["Model","Status","Rows Used","R²","Trained At"]}
                rows={AI_MODEL_IDS.map((id:any)=>{
                  const st = id==="mlr"?mlrStore?.stored : id==="lgbm"?mlrStore?.lgbm : id==="xgb"?mlrStore?.xgb : id==="cat"?mlrStore?.cat : mlrStore?.zc;
                  return [AI_MODEL_LABEL[id], st?"Trained":"Not trained", st?st.model.n:"—", st?Number(st.model.r2).toFixed(3):"—", st?.trainedAt?fmtDateTimeTz(st.trainedAt)+" "+APP_TZ_LABEL:"—"];
                })}/></div>
            {Array.isArray(aiTrainHistory)&&aiTrainHistory.length>0&&
              <div><div style={{fontSize:12,fontWeight:800,color:T.text,marginBottom:6}}>Retraining history</div>
                <Table T={T} headers={["Trained At","Source","CSV Rows","Production Rows","MLR R²","LightGBM R²","XGBoost R²","CatBoost R²","zinccore R²","By"]}
                  rows={aiTrainHistory.map((h:any)=>[fmtDateTimeTz(h.at),h.filename||"csv",h.csvRows??"—",h.productionRows??0,h.mlrR2!=null?Number(h.mlrR2).toFixed(3):"—",h.lgbmR2!=null?Number(h.lgbmR2).toFixed(3):"—",h.xgbR2!=null?Number(h.xgbR2).toFixed(3):"—",h.catR2!=null?Number(h.catR2).toFixed(3):"—",h.zcR2!=null?Number(h.zcR2).toFixed(3):"—",h.by||"—"])}/></div>}

          </div>}
    </Card>}



    {emailModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
      <div style={{background:T.surf,border:`1px solid ${T.border}`,borderRadius:12,padding:28,width:560,maxHeight:"92vh",overflowY:"auto"}}>
        <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:16}}>📧 Send Email Report — {emailScope?(getTabDataMap()[emailScope]?.label||emailScope):"All Reports"}</div>
        {sent
          ?<div style={{textAlign:"center",padding:"28px 0"}}>
            <div style={{fontSize:36,marginBottom:12}}>✅</div>
            <div style={{color:T.greenT,fontWeight:700,fontSize:16}}>Report Sent!</div>
            <div style={{color:T.muted,fontSize:12,marginTop:6}}>Delivered via Gmail to {recipients.length} recipient(s)</div>
          </div>
          :<>
            <div style={{fontSize:11,color:T.muted,fontWeight:700,letterSpacing:".06em",marginBottom:8}}>APPLIED FILTERS (only filtered data is sent)</div>
            <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:14,marginBottom:16,fontSize:12}}>
              <table style={{width:"100%",fontFamily:"monospace",fontSize:11}}>
                <tbody>
                  <tr><td style={{color:T.dim,padding:"3px 0",width:"45%"}}>Scope</td><td style={{color:T.amber,fontWeight:700}}>{emailScope?(getTabDataMap()[emailScope]?.label||emailScope):"All Reports"}</td></tr>
                  {activeFilters.map(([k,v])=>(
                    <tr key={k}><td style={{color:T.dim,padding:"3px 0",width:"45%"}}>{k}</td><td style={{color:T.text,fontWeight:700}}>{v}</td></tr>
                  ))}
                </tbody>
              </table>
              <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
                <div style={{color:T.cyanT,marginBottom:4}}>
                  {emailScope?`Rows in this tab: ${getTabDataMap()[emailScope]?.rows.length??0}`:`Beams in scope: ${beams.length} of ${allBeams.length}`}
                </div>
                <div style={{color:T.muted,wordBreak:"break-all"}}>To: {recipients.length?recipients.join(", "):<span style={{color:T.redT}}>No recipients — configure in Admin → Email Config</span>}</div>
                <div style={{color:T.muted,marginTop:4}}>Attachment: HDP_Report{emailScope?`_${(getTabDataMap()[emailScope]?.sheet||"").replace(/[^A-Za-z0-9]+/g,"-")}`:""}_{fromDate}_to_{toDate}.xlsx</div>
              </div>
            </div>
            <div style={{fontSize:11,color:T.dim,marginBottom:12}}>Tip: adjust filters in the Filters panel before sending. Filter details are included in both the email body and the Excel "Filters" sheet for traceability.</div>
            {sendErr&&<div style={{color:T.redT,fontSize:12,marginBottom:10}}>{sendErr}</div>}
            <div style={{display:"flex",gap:10}}>
              <Btn onClick={()=>sendEmail(emailScope)} disabled={sending||recipients.length===0}>{sending?"Sending…":"Send Filtered Report"}</Btn>
              <Btn variant="ghost" onClick={()=>se(false)} disabled={sending}>Cancel</Btn>
            </div>
          </>}
      </div>
    </div>}
  </div>;
}

// ══════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════

// (Removed PartPrefixMicronAdmin — replaced by MicronRulesAdmin below.)

// Stand-alone audit log viewer — visible to admin + manager.
// Managers get read-only access; admins also see delete/purge controls.
function AuditTab({auditLog,fieldConfig,user:me,T,deleteAuditEntries=(_:string[])=>{},purgeOldAudit=(_silent?:boolean)=>{}}:any){
  const [asearch,sa]=useState("");
  const [auditSel,setAuditSel]=useState<Record<string,boolean>>({});
  const isAdmin = me?.role==="admin";
  const fAudit=(auditLog||[]).filter((a:any)=>`${a.userName} ${a.action} ${a.module} ${a.details}`.toLowerCase().includes(asearch.toLowerCase())).slice(0,150);
  return <Card T={T}>
    <SecHead T={T} title="Audit Log"
      sub={`${(auditLog||[]).length} entries total${isAdmin?` — retention: ${Number(fieldConfig?.auditRetentionDays)>0?Number(fieldConfig?.auditRetentionDays)+" days (auto-purge)":"Never"}`:" — read only"}`}
      right={<div style={{display:"flex",gap:8,alignItems:"center"}}>
        {isAdmin && Number(fieldConfig?.auditRetentionDays)>0 && (
          <button onClick={()=>{
            const days=Number(fieldConfig?.auditRetentionDays);
            if(confirm(`Delete every audit entry older than ${days} day(s)? This cannot be undone.`)) purgeOldAudit(false);
          }} style={{padding:"6px 12px",borderRadius:6,background:"#2A1408",color:"#FB923C",border:"1px solid #FB923C60",fontSize:11,fontWeight:700,cursor:"pointer"}}>
            🧹 Purge &gt;{Number(fieldConfig?.auditRetentionDays)}d
          </button>
        )}
        {isAdmin && Object.values(auditSel).filter(Boolean).length>0 && (
          <button onClick={()=>{
            const ids=Object.keys(auditSel).filter(k=>auditSel[k]);
            if(confirm(`Permanently delete ${ids.length} audit entry(ies)?`)){
              deleteAuditEntries(ids); setAuditSel({});
            }
          }} style={{padding:"6px 12px",borderRadius:6,background:"#2A0808",color:"#F87171",border:"1px solid #F8717160",fontSize:11,fontWeight:700,cursor:"pointer"}}>
            🗑 Delete {Object.values(auditSel).filter(Boolean).length}
          </button>
        )}
        <DInput dark value={asearch} onChange={(e:any)=>sa(e.target.value)} placeholder="Search audit log..." style={{width:240}}/>
      </div>}/>
    <Table T={T} headers={isAdmin
      ? [<input key="hal" type="checkbox" checked={fAudit.length>0 && fAudit.every((a:any)=>auditSel[a.id])}
          onChange={e=>{ const ck=e.target.checked; const n:any={...auditSel}; fAudit.forEach((a:any)=>{ if(ck) n[a.id]=true; else delete n[a.id]; }); setAuditSel(n); }}/>,"#","Timestamp","User","Action","Module","Details","Admin"]
      : ["#","Timestamp","User","Action","Module","Details"]}
      rows={fAudit.map((a:any,i:number)=>{
        const base=[
          mn(fAudit.length-i,T.dim),
          <span style={{fontFamily:"monospace",fontSize:11,color:T.muted}}>{fmtDT(a.ts||a.timestamp)}</span>,
          <strong style={{color:T.text,fontSize:12}}>{a.userName}</strong>,
          <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"#33434F",color:T.amber,letterSpacing:".05em"}}>{a.action}</span>,
          <span style={{color:T.muted,fontSize:11}}>{a.module}</span>,
          <span style={{fontSize:11,color:T.text}}>{a.details}</span>,
        ];
        if(!isAdmin) return base;
        return [
          <input key={a.id+"_as"} type="checkbox" checked={!!auditSel[a.id]} onChange={e=>setAuditSel(p=>({...p,[a.id]:e.target.checked}))}/>,
          ...base,
          <button onClick={()=>{ if(confirm("Delete this audit entry?")) deleteAuditEntries([a.id]); }} style={{padding:"4px 10px",borderRadius:5,background:"#2A0808",color:"#F87171",border:"1px solid #F8717160",fontSize:10,fontWeight:700,cursor:"pointer"}}>🗑</button>,
        ];
      })}/>
  </Card>;
}




/** Approved production beams usable as extra training rows (continuous learning). */
function approvedTrainingRows(beams:any[]):any[]{
  return (beams||[]).filter((b:any)=>{
    if(!b?.ai_train_include) return false;
    const secs=cycleSecs(b);
    const avg = b.avg_reading!=null&&b.avg_reading!==""?Number(b.avg_reading):(isV2Coj(b)?v2TotalAverage(b.elcometer_v2):null);
    return Number(secs)>0 && Number(avg)>0 && b.bath_temperature!=null;
  }).map((b:any)=>({
    loadType:b.load_type||"",
    material:b.material_type||"",
    thickness:parseThicknessMm(b.section)||0,
    spec:Number(b.coating_required)||0,
    surface:b.surface_condition||"",
    bathTemp:Number(b.bath_temperature)||0,
    weight:Number(b.total_weight)||0,
    length:Number(b.length_mm)||0,
    totalTime:Number(cycleSecs(b))||0,
    coating:Number(b.avg_reading!=null&&b.avg_reading!==""?b.avg_reading:v2TotalAverage(b.elcometer_v2))||0,
  }));
}

function MlrTrainingAdmin({store,me,addAudit,aiModel,setAiModel,aiDashboardEnabled,setAiDashboardEnabled,beams=[],trainHistory=[],setTrainHistory=(_:any)=>{}}:any){
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState<any>(null);
  const [useProduction,setUseProduction]=useState(true);
  const stored=store?.stored;
  const storedLgbm=store?.lgbm;
  const storedXgb=store?.xgb;
  const storedCat=store?.cat;
  const storedZc=store?.zc;

  const selected=normalizeAiSelection(aiModel);
  const prodRows=useMemo(()=>approvedTrainingRows(beams),[beams]);

  function toggleModel(id:string){
    const next = selected.includes(id) ? selected.filter((v:string)=>v!==id) : [...selected,id];
    setAiModel?.(next.length?next:[id]);
  }

  async function onFile(e:any){
    const file=e.target.files?.[0]; e.target.value="";
    if(!file) return;
    setBusy(true); setMsg(null);
    try{
      const text=await file.text();
      const parsed=parseTrainingCsv(text);
      if(!parsed.rows.length){ setMsg({ok:false,text:parsed.errors[0]||"No valid rows found.",errors:parsed.errors}); return; }
      const extra = useProduction ? prodRows : [];
      const rows=[...parsed.rows,...extra];
      const meta={filename:file.name,byName:me?.full_name||me?.email||null,byId:me?.id||null};
      const model=fitMlr(rows);
      if(!model){ setMsg({ok:false,text:"Could not fit a model from this data."}); return; }
      await store.save(model,meta);
      const gbm=fitLgbm(rows); if(gbm) await store.saveLgbm(gbm,meta);
      const xg=fitXgb(rows);   if(xg)  await store.saveXgb(xg,meta);
      const cb=fitCatboost(rows); if(cb) await store.saveCat(cb,meta);
      const zc=fitZinccore(rows); if(zc) await store.saveZc(zc,meta);
      const entry={at:new Date().toISOString(),by:meta.byName,filename:file.name,csvRows:parsed.accepted,productionRows:extra.length,
        rejected:parsed.rejected,mlrR2:model.r2,lgbmR2:gbm?.r2??null,xgbR2:xg?.r2??null,catR2:cb?.r2??null,zcR2:zc?.r2??null};
      setTrainHistory?.([entry,...(Array.isArray(trainHistory)?trainHistory:[])].slice(0,20));
      addAudit?.({action:"AI_MODELS_TRAINED",detail:`${rows.length} rows (${parsed.accepted} CSV + ${extra.length} approved production) · MLR R² ${model.r2}${gbm?` · LGBM R² ${gbm.r2}`:""}${xg?` · XGB R² ${xg.r2}`:""}${cb?` · CatBoost R² ${cb.r2}`:""}${zc?` · zinccore R² ${zc.r2}`:""} · ${file.name}`});
      setMsg({ok:true,errors:parsed.errors,
        text:`Trained on ${rows.length} rows (${parsed.accepted} CSV + ${extra.length} approved production, ${parsed.rejected} skipped) — MLR R² ${model.r2.toFixed(3)}${gbm?` · LightGBM R² ${gbm.r2.toFixed(3)}`:""}${xg?` · XGBoost R² ${xg.r2.toFixed(3)}`:""}${cb?` · CatBoost R² ${cb.r2.toFixed(3)}`:""}${zc?` · zinccore R² ${zc.r2.toFixed(3)}`:""}`});

    }catch(err:any){ setMsg({ok:false,text:err?.message||"Training failed."}); }
    finally{ setBusy(false); }
  }

  async function del(type:"mlr"|"lgbm"|"xgb"|"cat"|"zc"|"all"){
    const what=type==="all"?"ALL training models":`the ${AI_MODEL_SHORT[type]||type} model`;
    if(!confirm(`Delete ${what}? The Dipping AI will stop predicting with it.`)) return;
    setBusy(true); setMsg(null);
    try{
      if(type==="all") await store.clearAll(); else await store.remove(type);
      addAudit?.({action:"AI_MODEL_DELETED",detail:what});
      setMsg({ok:true,text:`Deleted ${what}.`});
    }catch(err:any){ setMsg({ok:false,text:err?.message||"Delete failed."}); }
    finally{ setBusy(false); }
  }

  const template="Load Type,Material Type,Thickness,Weight,Length,Specific Coating,Surface Condition,Bath Temperature,Total Dipping Time,Actual Average Coating\nSingle,MS,10,1.2,6000,87,Normal,450,300,96\n";
  const cards:[string,any][]=[["mlr",stored],["lgbm",storedLgbm],["xgb",storedXgb],["cat",storedCat],["zc",storedZc]];
  return (
    <div style={{padding:"14px 16px",background:"#0A1422",border:"1px solid #33434F",borderRadius:10,marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:900,color:"#FB923C",letterSpacing:".06em",marginBottom:8}}>AI MODEL CONFIGURATION & TRAINING — TOTAL DIPPING TIME PREDICTION</div>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:10}}>
        <span style={{fontSize:11,color:"#8AA3C0",fontWeight:700}}>Active prediction model(s):</span>
        {AI_MODEL_IDS.map((v:string)=>{
          const on=selected.includes(v);
          return <button key={v} type="button" onClick={()=>toggleModel(v)}
            style={{padding:"5px 10px",borderRadius:5,fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"inherit",
              border:`1px solid ${on?"#FB923C":"#33434F"}`,background:on?"#2A1408":"#16202B",color:on?"#FB923C":"#8AA3C0"}}>
            {on?"☑":"☐"} {AI_MODEL_LABEL[v]}
          </button>;
        })}
        <label style={{marginLeft:"auto",fontSize:11,color:"#8AA3C0",fontWeight:700,display:"flex",alignItems:"center",gap:6,cursor:"pointer"}}>
          <input type="checkbox" checked={!!aiDashboardEnabled} onChange={e=>setAiDashboardEnabled?.(e.target.checked)}/>
          Show AI Performance Dashboard
        </label>
      </div>
      <div style={{fontSize:11,color:"#8AA3C0",lineHeight:1.6,marginBottom:10}}>
        Upload historical production data (CSV) once — every model is retrained from the same file.
        Required columns: {MLR_FEATURES.join(", ")}, Total Dipping Time (seconds), Actual Average Coating (µm).
        Target coating mapping: {Object.entries(TARGET_COATING).map(([k,v])=>`${k} → ${v} µm`).join(" · ")}.
      </div>
      <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#8AA3C0",fontWeight:700,marginBottom:10,cursor:"pointer"}}>
        <input type="checkbox" checked={useProduction} onChange={e=>setUseProduction(e.target.checked)}/>
        Continuous learning — also train on {prodRows.length} approved production record{prodRows.length===1?"":"s"} (approve them in Reports → AI Prediction Validation)
      </label>
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:10}}>
        <label style={{padding:"6px 12px",borderRadius:5,border:"1px solid #FB923C",background:"#2A1408",color:"#FB923C",fontSize:11,fontWeight:800,cursor:busy?"wait":"pointer"}}>
          {busy?"WORKING…":"⬆ UPLOAD CSV & TRAIN / RETRAIN"}
          <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={busy} style={{display:"none"}}/>
        </label>
        <a href={"data:text/csv;charset=utf-8,"+encodeURIComponent(template)} download="ai_training_template.csv"
          style={{fontSize:11,color:"#5BA3FF",fontWeight:700}}>Download CSV template</a>
        {cards.map(([id,st])=>(
          <button key={id} type="button" disabled={busy||!st} onClick={()=>del(id as any)}
            style={{padding:"5px 10px",borderRadius:5,border:"1px solid #F87171",background:"#2A0A0A",color:"#FCA5A5",fontSize:11,fontWeight:800,cursor:busy||!st?"not-allowed":"pointer",fontFamily:"inherit",opacity:st?1:.5}}>Delete {AI_MODEL_SHORT[id]}</button>
        ))}
        <button type="button" disabled={busy||(!stored&&!storedLgbm&&!storedXgb&&!storedCat&&!storedZc)} onClick={()=>del("all")}
          style={{padding:"5px 10px",borderRadius:5,border:"1px solid #F87171",background:"#3A0A0A",color:"#FCA5A5",fontSize:11,fontWeight:800,cursor:busy?"not-allowed":"pointer",fontFamily:"inherit",opacity:(stored||storedLgbm||storedXgb||storedCat||storedZc)?1:.5}}>Clear all training data</button>

      </div>
      {msg&&(
        <div style={{padding:"8px 10px",borderRadius:6,fontSize:11,fontWeight:700,marginBottom:10,
          background:msg.ok?"#04140A":"#2A0A0A",border:`1px solid ${msg.ok?"#16A34A":"#F87171"}`,color:msg.ok?"#4ADE80":"#FCA5A5"}}>
          <div>{msg.text}</div>
          {Array.isArray(msg.errors)&&msg.errors.length>0&&(
            <details style={{marginTop:6,fontWeight:600}}>
              <summary style={{cursor:"pointer"}}>Rejected-row report ({msg.errors.length})</summary>
              <div style={{fontFamily:"monospace",fontSize:10,lineHeight:1.6,marginTop:4}}>{msg.errors.map((e:string,i:number)=><div key={i}>{e}</div>)}</div>
            </details>
          )}
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:8,marginBottom:10}}>
        {cards.map(([id,s])=>(
          <div key={id} style={{padding:"8px 10px",background:"#16202B",border:`1px solid ${s?"#33434F":"#2A1010"}`,borderRadius:8}}>
            <div style={{fontSize:11,fontWeight:900,color:s?"#FDE68A":"#F87171",marginBottom:4}}>{AI_MODEL_LABEL[id]} — {s?"TRAINED":"NOT TRAINED"}</div>
            {s
              ? <div style={{fontSize:10,color:"#8AA3C0",fontFamily:"monospace",lineHeight:1.7}}>
                  <div>Rows used: {s.model.n} · R² {Number(s.model.r2).toFixed(3)} · Coating R² {Number(s.model.coatingR2).toFixed(3)}</div>
                  <div>Trained: {s.trainedAt?fmtDateTimeTz(s.trainedAt):"—"} {APP_TZ_LABEL}</div>
                  <div>Source: {s.sourceFilename||"csv"}{s.trainedByName?` · by ${s.trainedByName}`:""}</div>
                </div>
              : <div style={{fontSize:10,color:"#8AA3C0"}}>Upload a CSV to train this model.</div>}
          </div>
        ))}
      </div>
      <ZinccoreLearningPanel store={store} me={me} beams={beams} addAudit={addAudit} busy={busy} setBusy={setBusy} setMsg={setMsg}/>
      {Array.isArray(trainHistory)&&trainHistory.length>0&&(
        <details style={{fontSize:11,color:"#8AA3C0"}}>
          <summary style={{cursor:"pointer",fontWeight:800,color:"#FB923C"}}>Training history ({trainHistory.length})</summary>
          <div style={{marginTop:6,fontFamily:"monospace",fontSize:10,lineHeight:1.7}}>
            {trainHistory.map((h:any,i:number)=>(
              <div key={i}>{fmtDateTimeTz(h.at)} · {h.filename||"csv"} · {h.csvRows} CSV + {h.productionRows||0} production rows · MLR R² {Number(h.mlrR2??0).toFixed(3)} · LGBM R² {h.lgbmR2!=null?Number(h.lgbmR2).toFixed(3):"—"} · XGB R² {h.xgbR2!=null?Number(h.xgbR2).toFixed(3):"—"} · CatBoost R² {h.catR2!=null?Number(h.catR2).toFixed(3):"—"} · zinccore R² {h.zcR2!=null?Number(h.zcR2).toFixed(3):"—"}{h.by?` · by ${h.by}`:""}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}


function ZinccoreLearningPanel({store,me,beams=[],addAudit,busy,setBusy,setMsg}:any){
  const model=store?.zc?.model??null;
  const rows=useMemo(()=>approvedTrainingRows(beams),[beams]);

  // Rolling accuracy of zinccore against completed beams (latest 30).
  const perf=useMemo(()=>{
    if(!model) return null;
    const done=(beams||[])
      .filter((b:any)=>b.qc_status==="PASS"&&Number(b.avg_reading)>0&&(Number(b.immersion_duration)||0)+(Number(b.reaction_duration)||0)+(Number(b.withdrawal_duration)||0)>0)
      .sort((a:any,b:any)=>new Date(b.qc_completed_at||b.dipped_at||0).getTime()-new Date(a.qc_completed_at||a.dipped_at||0).getTime())
      .slice(0,30);
    const acc:number[]=[]; const tAcc:number[]=[]; let worst:any=null;
    for(const b of done){
      const input={loadType:b.load_type??null,material:b.material_type??null,thickness:_parseThk(b)??0,
        spec:Number(b.coating_required)||0,surface:b.surface_condition??null,bathTemp:Number(b.bath_temperature)||0,
        weight:parseFloat(b.total_weight)||0,length:_parseLen(b)??0};
      const actualSec=(Number(b.immersion_duration)||0)+(Number(b.reaction_duration)||0)+(Number(b.withdrawal_duration)||0);
      const actualC=Number(b.avg_reading);
      let pc:number,pt:number;
      try{ pc=zinccorePredictCoating(model,input,actualSec); pt=zinccorePredictTotalTime(model,input); }catch{ continue; }
      const ca=Math.max(0,100*(1-Math.abs(actualC-pc)/actualC));
      const ta=actualSec>0?Math.max(0,100*(1-Math.abs(actualSec-pt)/actualSec)):0;
      acc.push(ca); tAcc.push(ta);
      if(!worst||ca<worst.acc) worst={beam:b,input,acc:ca,expected:pc,actual:actualC};
    }
    if(!acc.length) return null;
    const avg=(a:number[])=>+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(2);
    const recent=acc.slice(0,10), older=acc.slice(10);
    const drift=older.length>=5?+(avg(recent)-avg(older)).toFixed(2):null;
    return {n:acc.length,coatingAcc:avg(acc),timeAcc:avg(tAcc),drift,worst};
  },[model,beams]);

  const attribution=useMemo(()=>{
    if(!model||!perf?.worst) return [];
    try{ return zinccoreAttribution(model,perf.worst.input).slice(0,5); }catch{ return []; }
  },[model,perf]);

  async function fineTune(){
    if(!model||!rows.length) return;
    setBusy(true); setMsg(null);
    try{
      const next=fineTuneZinccore(model,rows);
      if(!next) throw new Error("Not enough approved production rows to fine-tune.");
      await store.saveZc(next,{filename:"incremental",byName:me?.full_name||me?.email||null,byId:me?.id||null});
      addAudit?.({action:"ZINCCORE_FINE_TUNED",detail:`${rows.length} approved production rows · R² ${next.r2}`});
      setMsg({ok:true,text:`zinccore fine-tuned on ${rows.length} approved production record(s) — R² ${next.r2.toFixed(3)} · Coating R² ${next.coatingR2.toFixed(3)}`});
    }catch(err:any){ setMsg({ok:false,text:err?.message||"Fine-tune failed."}); }
    finally{ setBusy(false); }
  }

  return (
    <div style={{padding:"10px 12px",background:"#16202B",border:"1px solid #33434F",borderRadius:8,marginBottom:10}}>
      <div style={{fontSize:11,fontWeight:900,color:"#5BA3FF",letterSpacing:".05em",marginBottom:6}}>ZINCCORE LEARNING — DEEP LEARNING FEEDBACK LOOP</div>
      {!model
        ? <div style={{fontSize:11,color:"#8AA3C0"}}>Train zinccore from a CSV above to enable continuous learning.</div>
        : <div style={{display:"grid",gap:8}}>
            <div style={{fontSize:10,color:"#8AA3C0",fontFamily:"monospace",lineHeight:1.7}}>
              <div>Network: {model.features.length} inputs · {model.hidden1}×{model.hidden2} hidden units · {model.epochs} epochs · {model.n} training rows</div>
              <div>Training fit: Time R² {Number(model.r2).toFixed(3)} · Coating R² {Number(model.coatingR2).toFixed(3)}</div>
              {perf
                ? <div>Live accuracy (last {perf.n} completed beams): Coating {perf.coatingAcc}% · Time {perf.timeAcc}%
                    {perf.drift!=null && <> · Drift {perf.drift>0?"+":""}{perf.drift}% vs earlier beams</>}</div>
                : <div>No completed beams yet to measure live accuracy.</div>}
            </div>
            {perf?.drift!=null&&perf.drift<-3&&
              <div style={{padding:"6px 8px",borderRadius:6,background:"#2A1408",border:"1px solid #FB923C",color:"#FDBA74",fontSize:10,fontWeight:700}}>
                Drift detected — recent accuracy dropped {Math.abs(perf.drift)}%. Fine-tune or retrain zinccore.
              </div>}
            {perf?.worst&&
              <div style={{fontSize:10,color:"#8AA3C0",lineHeight:1.7}}>
                <div style={{fontWeight:800,color:"#FDE68A"}}>Largest miss: {perf.worst.beam.beam_no} — expected {perf.worst.expected} µm vs actual {perf.worst.actual} µm ({perf.worst.acc.toFixed(1)}% accurate)</div>
                {attribution.length>0&&<div>Most influential inputs: {attribution.map((a:any)=>`${a.feature} (${a.impactSec>0?"+":""}${a.impactSec}s)`).join(" · ")}</div>}
              </div>}
            <div>
              <button type="button" disabled={busy||!rows.length} onClick={fineTune}
                style={{padding:"5px 10px",borderRadius:5,border:"1px solid #5BA3FF",background:"#08172A",color:"#5BA3FF",fontSize:11,fontWeight:800,fontFamily:"inherit",cursor:busy||!rows.length?"not-allowed":"pointer",opacity:rows.length?1:.5}}>
                ⟳ Fine-tune on {rows.length} approved production record{rows.length===1?"":"s"}
              </button>
            </div>
          </div>}
    </div>
  );
}

function MicronRulesAdmin({micronRules,setMicronRules,addAudit,me,T}:any){
  const MICRONS=filterCoatings([65,87,130] as number[]);
  const [pfx,setPfx]=useState("");
  const [tMin,setTMin]=useState("");
  const [tMax,setTMax]=useState("");
  const [micron,setMicron]=useState<number>(87);
  const [localReq,setLocalReq]=useState("");
  const [editId,setEditId]=useState<string|null>(null);
  const sorted=(micronRules||[]).slice().sort((a:any,b:any)=>{
    const p=String(a.prefix).localeCompare(String(b.prefix));
    return p!==0 ? p : (Number(a.thickness_min)-Number(b.thickness_min));
  });
  function reset(){ setPfx(""); setTMin(""); setTMax(""); setMicron(87); setLocalReq(""); setEditId(null); }

  function save(){
    const P=pfx.trim().toUpperCase();
    if(!P){alert("Prefix is required");return;}
    const mn=parseFloat(tMin);
    if(isNaN(mn)||mn<0){alert("Thickness Min must be a non-negative number");return;}
    const mx=tMax.trim()===""?null:parseFloat(tMax);
    if(mx!=null && (isNaN(mx)||mx<mn)){alert("Thickness Max must be blank or ≥ Min");return;}
    const lr=localReq.trim()===""?null:parseFloat(localReq);
    if(lr!=null && (isNaN(lr)||lr<=0)){alert("Local Coating Requirement must be blank or a positive number");return;}
    const dup=(micronRules||[]).some((r:any)=> r.id!==editId
      && String(r.prefix).toUpperCase()===P
      && Number(r.thickness_min)===mn
      && ((r.thickness_max==null && mx==null) || Number(r.thickness_max)===mx));
    if(dup){alert("A rule for this prefix and thickness range already exists");return;}
    setMicronRules((prev:any[])=>{
      const next=(prev||[]).slice();
      if(editId){
        const i=next.findIndex((x:any)=>x.id===editId);
        if(i>=0) next[i]={...next[i], prefix:P, thickness_min:mn, thickness_max:mx, coating_required:micron, local_coating_required:lr, updated_by_name:me?.full_name||null};
      } else {
        next.push({id:(crypto as any).randomUUID(), prefix:P, thickness_min:mn, thickness_max:mx, coating_required:micron, local_coating_required:lr, active:true, updated_by_name:me?.full_name||null});
      }
      return next;
    });
    addAudit?.(me?.id,me?.full_name, editId?"MICRON_RULE_EDIT":"MICRON_RULE_ADD","admin",`${P} | ${mn}${mx==null?"+":"–"+mx} mm → ${micron}μm${lr!=null?` | local ${lr}μm`:""}`);
    reset();
  }
  function startEdit(r:any){ setEditId(r.id); setPfx(r.prefix); setTMin(String(r.thickness_min)); setTMax(r.thickness_max==null?"":String(r.thickness_max)); setMicron(Number(r.coating_required)); setLocalReq(r.local_coating_required==null?"":String(r.local_coating_required)); }

  function toggleActive(r:any){
    setMicronRules((prev:any[])=>(prev||[]).map((x:any)=>x.id===r.id?{...x,active:!x.active,updated_by_name:me?.full_name||null}:x));
    addAudit?.(me?.id,me?.full_name,"MICRON_RULE_TOGGLE","admin",`${r.prefix} ${r.thickness_min}${r.thickness_max==null?"+":"–"+r.thickness_max}mm → ${!r.active?"Active":"Inactive"}`);
  }
  function removeRow(r:any){
    if(!confirm(`Delete rule ${r.prefix} ${r.thickness_min}${r.thickness_max==null?"+":"–"+r.thickness_max}mm → ${r.coating_required}μm?`)) return;
    setMicronRules((prev:any[])=>(prev||[]).filter((x:any)=>x.id!==r.id));
    addAudit?.(me?.id,me?.full_name,"MICRON_RULE_DELETE","admin",`Removed ${r.prefix} ${r.thickness_min}${r.thickness_max==null?"+":"–"+r.thickness_max}mm`);
  }
  return <Card T={T} style={{padding:18,marginBottom:14}}>
    <SecHead T={T} title="Admin Micron Mapping Rules" sub="Auto-select micron by part-number prefix + thickness range. Longest matching prefix wins. Operators cannot modify."/>
    <div style={{display:"grid",gridTemplateColumns:"1.2fr .8fr .8fr 1fr 1fr auto",gap:8,alignItems:"end",margin:"10px 0 14px"}}>
      <div>
        <label style={{fontSize:10,color:T.muted,fontWeight:700,display:"block",marginBottom:4}}>Part No Prefix</label>
        <DInput dark value={pfx} onChange={(e:any)=>setPfx(e.target.value.toUpperCase())} placeholder="e.g. B2IA" style={{fontFamily:"monospace",fontWeight:700}}/>
      </div>
      <div>
        <label style={{fontSize:10,color:T.muted,fontWeight:700,display:"block",marginBottom:4}}>Thickness Min (mm)</label>
        <DInput dark type="number" step="0.1" min="0" value={tMin} onChange={(e:any)=>setTMin(e.target.value)} placeholder="e.g. 4"/>
      </div>
      <div>
        <label style={{fontSize:10,color:T.muted,fontWeight:700,display:"block",marginBottom:4}}>Thickness Max (mm)</label>
        <DInput dark type="number" step="0.1" min="0" value={tMax} onChange={(e:any)=>setTMax(e.target.value)} placeholder="blank = and above"/>
      </div>
      <div>
        <label style={{fontSize:10,color:T.muted,fontWeight:700,display:"block",marginBottom:4}}>Required Average Coating</label>
        <DSel dark value={String(micron)} onChange={(e:any)=>setMicron(parseInt(e.target.value))}>
          {MICRONS.map(m=><option key={m} value={m}>{m} μm</option>)}
        </DSel>
      </div>
      <div>
        <label style={{fontSize:10,color:T.muted,fontWeight:700,display:"block",marginBottom:4}}>Local Coating Requirement (μm)</label>
        <DInput dark type="number" step="1" min="0" value={localReq} onChange={(e:any)=>setLocalReq(e.target.value)} placeholder="e.g. 70 (optional)"/>
      </div>
      <div style={{display:"flex",gap:6}}>
        <Btn onClick={save}>{editId?"Update Rule":"+ Add Rule"}</Btn>
        {editId && <Btn variant="ghost" onClick={reset}>Cancel</Btn>}
      </div>
    </div>
    <Table T={T} headers={["Prefix","Thickness","Required Avg Coating","Local Requirement","Status","Updated By","Actions"]}
      rows={sorted.map((r:any)=>[
        <strong style={{fontFamily:"monospace",color:T.text,fontSize:13}}>{String(r.prefix).toUpperCase()}</strong>,
        <span style={{fontFamily:"monospace",fontSize:12,color:T.text}}>{Number(r.thickness_min)}{r.thickness_max==null?" mm and above":` – ${Number(r.thickness_max)} mm`}</span>,
        <span style={{fontFamily:"monospace",fontSize:12,fontWeight:800,color:r.coating_required===130?"#A78BFA":r.coating_required===87?"#5BA3FF":"#4ADE80"}}>{r.coating_required} μm</span>,
        <span style={{fontFamily:"monospace",fontSize:12,fontWeight:800,color:r.local_coating_required==null?T.dim:"#FBBF24"}}>{r.local_coating_required==null?"—":`${Number(r.local_coating_required)} μm`}</span>,

        <button onClick={()=>toggleActive(r)} style={{padding:"3px 10px",borderRadius:5,border:`1px solid ${r.active?"#4ADE80":T.border}`,background:"transparent",color:r.active?"#4ADE80":T.muted,fontSize:11,fontWeight:700,cursor:"pointer"}}>{r.active?"● Active":"○ Inactive"}</button>,
        <span style={{fontSize:11,color:T.dim}}>{r.updated_by_name||"—"}</span>,
        <div style={{display:"flex",gap:5}}>
          <Btn size="sm" variant="ghost" onClick={()=>startEdit(r)}>Edit</Btn>
          <Btn size="sm" variant="red" onClick={()=>removeRow(r)}>Delete</Btn>
        </div>,
      ])}
      empty="No micron rules yet. Add a rule above to auto-select micron by part-number prefix and thickness."/>
  </Card>;
}


// Default module access per role. Used when Admin has not explicitly
// configured a user in Module Access — so a newly-created Manager (or any
// other role) immediately gets a sensible set of tabs, and Admin can then
// enable/disable individual modules from Admin → Module Access.
const ROLE_DEFAULT_PERMS: Record<string, { tabs: Record<string, boolean>; readOnly: boolean; exportOnly: boolean; canExport: boolean; canSendReportEmail: boolean }> = {
  manager: { tabs: { dashboard:true, tracker:true, loading:true, dipping:true, qc:true, material_offer:true, reports:true, audit:true }, readOnly:true, exportOnly:false, canExport:true, canSendReportEmail:true },
  supervisor: { tabs: { dashboard:true, tracker:true, loading:true, dipping:true, qc:true, material_offer:true, reports:true }, readOnly:true, exportOnly:false, canExport:true, canSendReportEmail:false },
  shift_supervisor: { tabs: { dashboard:true, tracker:true, loading:true, dipping:true, material_offer:true }, readOnly:false, exportOnly:false, canExport:true, canSendReportEmail:false },
  loading_supervisor: { tabs: { tracker:true, loading:true }, readOnly:false, exportOnly:false, canExport:true, canSendReportEmail:false },
  dipping_supervisor: { tabs: { tracker:true, dipping:true, qc:true, material_offer:true }, readOnly:false, exportOnly:false, canExport:true, canSendReportEmail:false },
  qc_inspector: { tabs: { dashboard:true, qc:true, material_offer:true, reports:true }, readOnly:false, exportOnly:false, canExport:true, canSendReportEmail:false },
};
function roleDefaultPerms(role?: string) {
  const d = role ? ROLE_DEFAULT_PERMS[role] : undefined;
  if (!d) return { tabs: {}, readOnly: false, exportOnly: false, canExport: true, canSendReportEmail: false };
  return { tabs: { ...d.tabs }, readOnly: d.readOnly, exportOnly: d.exportOnly, canExport: d.canExport, canSendReportEmail: d.canSendReportEmail };
}

function AdminTab({users,setUsers,auditLog,addAudit,user:me,beams,setBeams=(_:any)=>{},allTabs,moduleAccess,setModuleAccess,resetBeams,emailRecs,setEmailRecs,fieldConfig,setFieldConfig,dippingConfig,setDippingConfig,operators=[],setOperators=()=>{},shiftSupervisors=[],setShiftSupervisors=(()=>{}) as any,themeId,setThemeId,deleteBeams=(_:string[])=>{},deleteAuditEntries=(_:string[])=>{},purgeOldAudit=(_silent?:boolean)=>{},sendInviteEmail=false,setSendInviteEmail=(_:boolean)=>{},micronRules=[],setMicronRules=(_:any)=>{},mlrStore=null as any,aiModel="mlr",setAiModel=(_:any)=>{},aiDashboardEnabled=false,setAiDashboardEnabled=(_:any)=>{},aiTrainHistory=[],setAiTrainHistory=(_:any)=>{},feature65um={enabled:true},setFeature65um=(_:any)=>{},T}:any){
  const [auditSel,setAuditSel]=useState<Record<string,boolean>>({});
  const [beamSel,setBeamSel]=useState<Record<string,boolean>>({});
  const [panel,sp]=useState("users");
  const [editBeam,setEditBeam]=useState<any>(null);
  const [beamBusy,setBeamBusy]=useState(false);

  const [beamSearch,setBeamSearch]=useState("");
  const [beamSrcFilter,setBeamSrcFilter]=useState<string[]>([]);
  const [beamSpecFilter,setBeamSpecFilter]=useState<string[]>([]);

  const [beamFromDate,setBeamFromDate]=useState<string>("");
  const [beamToDate,setBeamToDate]=useState<string>("");

  function getUserPerms(uid){
    const key=String(uid); const o=moduleAccess[key]||{};
    const u=users.find((x:any)=>String(x.id)===key);
    const def=roleDefaultPerms(u?.role);
    if(o.tabs===undefined && Object.keys(o).length===0){
      // No explicit entry — use role defaults so Admin sees the current
      // effective access and can toggle from there.
      return def;
    }
    if(o.tabs===undefined){
      const legacy={...o}; delete legacy.tabs; delete legacy.readOnly; delete legacy.exportOnly; delete legacy.canExport; delete legacy.canSendReportEmail;
      return { tabs: {...def.tabs, ...legacy}, readOnly:!!o.readOnly||def.readOnly, exportOnly:!!o.exportOnly, canExport:o.canExport!==false, canSendReportEmail:o.canSendReportEmail!==undefined?!!o.canSendReportEmail:def.canSendReportEmail };
    }
    return { tabs:{...def.tabs, ...(o.tabs||{})}, readOnly:o.readOnly!==undefined?!!o.readOnly:def.readOnly, exportOnly:!!o.exportOnly, canExport:o.canExport!==false, canSendReportEmail:o.canSendReportEmail!==undefined?!!o.canSendReportEmail:def.canSendReportEmail };
  }
  function toggleModule(uid,tabId,currentVal){
    const key=String(uid);
    setModuleAccess(prev=>{
      const cur=getUserPerms(uid);
      return {...prev,[key]:{...cur, tabs:{...cur.tabs, [tabId]:!currentVal}}};
    });
    const u=users.find(x=>x.id===uid);
    addAudit(me.id,me.full_name,"MODULE_TOGGLE","admin",`${!currentVal?"Enabled":"Disabled"} tab '${tabId}' for user ${u?.username}`);
  }
  function toggleFlag(uid,flag){
    const key=String(uid);
    setModuleAccess(prev=>{
      const cur=getUserPerms(uid);
      const next={...cur, [flag]:!cur[flag]};
      return {...prev,[key]:next};
    });
    addAudit(me.id,me.full_name,"PERM_FLAG","admin",`Toggled '${flag}' for user ${uid}`);
  }
  function applyPreset(uid,preset){
    const key=String(uid);
    const presets={
      dipping_coating:{ tabs:{dashboard:false,tracker:true,loading:false,dipping:true,qc:true,reports:false}, readOnly:false, exportOnly:false, canExport:false, canSendReportEmail:false },
      dashboard_reports:{ tabs:{dashboard:true,tracker:true,loading:false,dipping:false,qc:false,reports:true}, readOnly:true, exportOnly:true, canExport:true, canSendReportEmail:false },
      clear:{ tabs:{}, readOnly:false, exportOnly:false, canExport:true, canSendReportEmail:false },
    };
    const next=presets[preset]; if(!next) return;
    setModuleAccess(prev=>({...prev,[key]:next}));
    const u=users.find(x=>x.id===uid);
    addAudit(me.id,me.full_name,"PRESET_APPLY","admin",`Applied preset '${preset}' to ${u?.username}`);
  }

  function getAccess(uid,tabId,baseRoles,userRole){
    if(userRole==="admin") return true;
    if(!baseRoles.includes(userRole)) return false;
    const p=getUserPerms(uid);
    if(tabId==="dashboard") return p.tabs.dashboard===true;
    return p.tabs[tabId]!==false;
  }
  const [f,sf]=useState({username:"",password:"",full_name:"",role:"",email:""});
  const [msg,sm]=useState(null);
  const [asearch,sa]=useState("");
  const [newEmail,setNE]=useState({loading:"",dipping:"",qc:"",hourly:"",shiftwise:""});
  const [emailMsg,setEM]=useState({cat:null,text:null});
  const [resetModal,setRM]=useState(false);
  const [resetPwdInput,setRPI]=useState("");
  const [resetMsg,setRMsg]=useState(null);
  const [resetConfirm,setRC]=useState(false);

  const RA={
    admin:"Full access — all modules, dashboard, reports, admin panel",
    supervisor:"👷 Supervisor — Read-only monitor of all production data and dashboards",
    shift_supervisor:"🧭 Shift Supervisor — Dashboard, Loading & Dipping (operate assigned modules)",
    manager:"📈 Manager — Dashboard, Reports, Coating on Job + Ready-status view of Loading/Dipping",
    loading_supervisor:"📦 Loading only — register beams, edit before dipping",
    dipping_supervisor:"🛢 Dipping Supervisor — Dipping + Coating on Job entry & monitoring",
    qc_inspector:"🔬 Coating on Job only — 7-point Elcometer per IS 2629",
  };
  const RC={admin:T.amber,supervisor:"#22D3EE",shift_supervisor:"#34D399",manager:"#F472B6",loading_supervisor:T.blueT,dipping_supervisor:T.greenT,qc_inspector:"#A78BFA"};

  const REPORT_LABELS={
    loading:"Daily Loading Report (14:00 daily)",
    dipping:"Dipping + QC Combined (22:00 daily)",
    qc:"Coating on Job Summary Report",
    hourly:"Hourly Production Summary",
    shiftwise:"Shift-wise Summary (shift end)",
  };

  function addUser(){
    if(!f.username||!f.full_name||!f.role||!f.email){sm({ok:false,text:"Username, Full Name, Role and Email are required"});return;}
    if(!sendInviteEmail && (!f.password || f.password.length<6)){sm({ok:false,text:"Password (min 6 chars) is required when email invite is disabled"});return;}
    if(users.find(u=>u.username===f.username)){sm({ok:false,text:`Username "${f.username}" already taken`});return;}
    setUsers(prev=>[...prev,{id:Date.now(),...f,active:true,created_at:nowISO()}]);
    addAudit(me.id,me.full_name,"CREATE_USER","admin","Created user "+f.username+" ("+f.role+") via "+(sendInviteEmail?"email invite":"direct password"));
    sm({ok:true,text:`✓ User "${f.username}" created`});
    sf({username:"",password:"",full_name:"",role:"",email:""});
    setTimeout(()=>sm(null),5000);
  }
  function toggleUser(uid){
    const t=users.find(u=>u.id===uid);
    setUsers(prev=>prev.map(u=>u.id===uid?{...u,active:!u.active}:u));
    addAudit(me.id,me.full_name,"TOGGLE_USER","admin",(t.active?"Deactivated":"Activated")+" "+t.username);
  }
  function resetUserPwd(uid){
    const t=users.find(u=>u.id===uid);
    const entered=typeof window!=="undefined"?window.prompt("Enter a new temporary password for "+t.username+" (min 8 chars). Leave blank to auto-generate."):"";
    let newPwd=(entered||"").trim();
    if(!newPwd){
      const bytes=new Uint8Array(12); (globalThis.crypto||window.crypto).getRandomValues(bytes);
      newPwd=Array.from(bytes).map(b=>"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"[b%54]).join("");
    }
    if(newPwd.length<8){ alert("Password must be at least 8 characters."); return; }
    setUsers(prev=>prev.map(u=>u.id===uid?{...u,_pendingPwd:newPwd}:u));
    addAudit(me.id,me.full_name,"RESET_PWD","admin","Reset password for "+t.username);
    alert("Temporary password for "+t.username+":\n\n"+newPwd+"\n\nShare it over a secure channel. They should change it after login.");
  }
  function delUser(uid){
    const t=users.find(u=>u.id===uid);
    if(!confirm(`Delete user "${t.username}"?`)) return;
    setUsers(prev=>prev.filter(u=>u.id!==uid));
    addAudit(me.id,me.full_name,"DELETE_USER","admin","Deleted user "+t.username);
  }

  function addEmailRec(cat){
    const e=newEmail[cat].trim().toLowerCase();
    if(!e||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)){setEM({cat,text:"Enter a valid email address"});return;}
    if(emailRecs[cat].includes(e)){setEM({cat,text:"Already in list"});return;}
    setEmailRecs(prev=>({...prev,[cat]:[...prev[cat],e]}));
    setNE(prev=>({...prev,[cat]:""}));
    setEM({cat:null,text:null});
    addAudit(me.id,me.full_name,"EMAIL_ADD","admin","Added "+e+" to "+cat+" recipients");
  }
  function removeEmailRec(cat,email){
    setEmailRecs(prev=>({...prev,[cat]:prev[cat].filter(x=>x!==email)}));
    addAudit(me.id,me.full_name,"EMAIL_REMOVE","admin","Removed "+email+" from "+cat+" recipients");
  }

  async function attemptReset(){
    if(!resetPwdInput){setRMsg("❌ Enter your admin password");return;}
    const email=me?.email;
    if(!email){setRMsg("❌ No email on your account — cannot verify");return;}
    setRMsg("Verifying…");
    try{
      const { error } = await _sb.auth.signInWithPassword({ email, password: resetPwdInput });
      if(error){setRMsg("❌ Invalid admin password");return;}
      resetBeams();
      setRC(true); setRMsg(null);
      setTimeout(()=>{setRM(false);setRPI("");setRC(false);},3000);
    }catch(e){
      setRMsg("❌ Verification failed, try again");
    }
  }


  const fAudit=auditLog.filter(a=>`${a.userName} ${a.action} ${a.module} ${a.details}`.toLowerCase().includes(asearch.toLowerCase())).slice(0,150);

  return <div>
    {/* Panel tabs */}
    <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
      {[["users","👥 Users"],["modules","🔧 Module Access"],["operators","👷 Operators"],["fields","🧩 Field Config"],["ai","🧠 Dipping AI"],["email","📧 Email Config"],["data","🗂 Data Management"],["security","🔐 Security"],["audit","📋 Audit Log"],["appearance","🎨 Appearance"],["reset","🗑 Data Reset"]].map(([id,lbl])=>(
        <button key={id} onClick={()=>sp(id)} style={{
          padding:"7px 14px",fontSize:12,fontWeight:600,borderRadius:6,cursor:"pointer",
          background:panel===id?(id==="reset"?T.red:T.amber):T.card,
          color:panel===id?"#fff":T.muted,
          border:`1px solid ${panel===id?(id==="reset"?T.red:T.amber):T.border}`}}>{lbl}</button>
      ))}
      <div style={{marginLeft:"auto",display:"flex",gap:12,fontSize:11,color:T.muted}}>
        <span>👥 {users.length} Users</span>
        <span>📦 {beams.length} Beams</span>
        <span>📋 {auditLog.length} Audit entries</span>
      </div>
    </div>

    {/* ── USERS ─────────────────────────────────────────────── */}
    {panel==="users"&&<>
      <Card T={T} style={{padding:20,marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:10}}>
          <div style={{fontSize:13,fontWeight:700,color:T.text}}>➕ Create New User</div>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:11,color:T.muted,cursor:"pointer",padding:"6px 12px",background:T.bg,border:`1px solid ${sendInviteEmail?T.amber:T.border}`,borderRadius:6}}>
            <input type="checkbox" checked={sendInviteEmail} onChange={e=>setSendInviteEmail(e.target.checked)} style={{accentColor:T.amber}}/>
            <span><strong style={{color:sendInviteEmail?T.amber:T.text}}>📧 Send email invite link</strong> — {sendInviteEmail?"user receives link to set their own password":"admin sets password below; user logs in directly"}</span>
          </label>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:12}}>
          <Field label="Username" required T={T}><DInput dark value={f.username} onChange={e=>sf(p=>({...p,username:e.target.value}))}/></Field>
          <Field label={sendInviteEmail?"Password (ignored — set via email)":"Password"} required={!sendInviteEmail} T={T}><DInput dark type="password" value={f.password} disabled={sendInviteEmail} onChange={e=>sf(p=>({...p,password:e.target.value}))} placeholder={sendInviteEmail?"User will set via invite link":"min 6 characters"}/></Field>
          <Field label="Full Name" required T={T}><DInput dark value={f.full_name} onChange={e=>sf(p=>({...p,full_name:e.target.value}))}/></Field>
          <Field label="Role & Module Access" required T={T}>
            <DSel dark value={f.role} onChange={e=>sf(p=>({...p,role:e.target.value}))}>
              <option value="">— Select Role —</option>
              <option value="admin">⚙ Admin — Full access, user management, all modules</option>
              <option value="supervisor">👷 Supervisor — Dashboard + all modules read-only monitor</option>
              <option value="shift_supervisor">🧭 Shift Supervisor — Dashboard, Loading & Dipping (operate)</option>
              <option value="manager">📈 Manager — Dashboard, Reports, Coating on Job + Ready-only Loading/Dipping</option>
              <option value="loading_supervisor">📦 Loading Supervisor — Loading module only (register beams)</option>
              <option value="dipping_supervisor">🛢 Dipping Supervisor — Dipping + Coating on Job</option>
              <option value="qc_inspector">🔬 Coating on Job — Coating on Job module only (7-pt elcometer)</option>
            </DSel>
          </Field>
          <Field label="Email" required T={T}><DInput dark type="email" value={f.email} onChange={e=>sf(p=>({...p,email:e.target.value}))} placeholder="user@hdp.com"/></Field>
        </div>
        {f.role&&<div style={{padding:"8px 12px",background:T.bg,borderRadius:6,fontSize:12,color:T.muted,marginBottom:12}}>🔑 {RA[f.role]}</div>}
        <Alert ok={msg?.ok} msg={msg?.text} onClose={()=>sm(null)}/>
        <Btn onClick={addUser}>+ Create User</Btn>
      </Card>
      {/* Chain explanation */}
      <div style={{padding:"12px 16px",background:"#16202B",border:"1px solid #1A3458",borderRadius:8,marginBottom:14}}>
        <div style={{fontSize:11,fontWeight:700,color:T.amber,marginBottom:8}}>⛓ PRODUCTION CHAIN — How Roles Work Together</div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",fontSize:11,color:T.muted}}>
          {[["⚙ Admin","Creates all users, full access","#3D7EA6"],["→",null,T.dim],["👷 Supervisor","Monitors all data read-only","#22D3EE"],["→",null,T.dim],["📦 Loading","Registers beams","#5BA3FF"],["→",null,T.dim],["🛢 Dipping","Records timestamps","#FB923C"],["→",null,T.dim],["🔬 QC Inspector","7-pt inspection","#A78BFA"]].map(([l,s,col],i)=>(
            s?<div key={i} style={{padding:"6px 10px",background:col+"15",border:`1px solid ${col}30`,borderRadius:6}}>
              <div style={{color:col,fontWeight:700}}>{l}</div>
              <div style={{fontSize:9,color:T.dim,marginTop:2}}>{s}</div>
            </div>:<span key={i} style={{color:T.dim,fontSize:16}}>{l}</span>
          ))}
        </div>
      </div>
      <Card T={T}>
        <SecHead T={T} title="System Users" sub="Role-based access — user data is never deleted"/>
        <Table T={T} headers={["Username","Full Name","Role","Access","Email","Status","Created","Actions"]}
          rows={users.map(u=>[
            <strong style={{color:T.text}}>{u.username}</strong>,
            u.full_name,
            <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:(RC[u.role]||T.amber)+"20",color:RC[u.role]||T.amber}}>
              {u.role.replace(/_/g," ").toUpperCase()}
            </span>,
            <span style={{fontSize:10,color:T.muted}}>{RA[u.role]}</span>,
            u.email||"—",
            <span style={{color:u.active?T.greenT:T.redT,fontSize:11,fontWeight:700}}>{u.active?"● Active":"● Inactive"}</span>,
            <span style={{fontSize:11}}>{fmtDate(u.created_at)}</span>,
            <div style={{display:"flex",gap:6}}>
              <Btn variant="ghost" size="sm" onClick={()=>toggleUser(u.id)}>{u.active?"Deactivate":"Activate"}</Btn>
              <Btn variant="cyan" size="sm" onClick={()=>resetUserPwd(u.id)}>Reset Pwd</Btn>
              {u.id!==me.id&&<Btn variant="red" size="sm" onClick={()=>delUser(u.id)}>Delete</Btn>}
            </div>,
          ])}/>
      </Card>
    </>}

    {/* ── MODULE ACCESS ───────────────────────────────────── */}
    {panel==="modules"&&<div>
      <div style={{padding:"12px 16px",background:"#0A1520",border:"1px solid #1A3458",
        borderRadius:8,marginBottom:14,fontSize:12,color:T.muted}}>
        🔧 <strong style={{color:T.text}}>Module Access Control</strong> — Admin can enable or disable individual
        tabs per user. Admin accounts always retain full access regardless of toggles.
        Changes take effect immediately on next login or page refresh.
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {users.filter(u=>u.role!=="admin").map(u=>(
          <Card key={u.id} T={T} style={{padding:18}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
              <div style={{width:36,height:36,borderRadius:"50%",
                background:(RC[u.role]||T.amber)+"20",border:`2px solid ${RC[u.role]||T.amber}`,
                display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:13,fontWeight:800,color:RC[u.role]||T.amber}}>
                {u.full_name.charAt(0)}
              </div>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:T.text}}>{u.full_name}</div>
                <div style={{fontSize:10,color:RC[u.role]||T.amber,fontWeight:700}}>
                  {u.username} — {u.role.replace(/_/g," ").toUpperCase()}
                </div>
              </div>
              <div style={{marginLeft:"auto",fontSize:10,color:T.dim}}>
                {allTabs.filter(t=>getAccess(u.id,t.id,t.baseRoles,u.role)).length} of {allTabs.filter(t=>t.baseRoles.includes(u.role)).length} tabs enabled
              </div>
            </div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10,paddingBottom:10,borderBottom:`1px dashed ${T.border}`}}>
              <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",alignSelf:"center",marginRight:4}}>Quick presets:</div>
              <button onClick={()=>applyPreset(u.id,"dipping_coating")} style={{padding:"6px 10px",fontSize:11,fontWeight:700,borderRadius:6,background:T.greenT+"20",border:`1px solid ${T.greenT}`,color:T.greenT,cursor:"pointer"}}>🛢 Dipping + Coating</button>
              <button onClick={()=>applyPreset(u.id,"dashboard_reports")} style={{padding:"6px 10px",fontSize:11,fontWeight:700,borderRadius:6,background:T.blueT+"20",border:`1px solid ${T.blueT}`,color:T.blueT,cursor:"pointer"}}>📊 Dashboard + Reports</button>
              <button onClick={()=>applyPreset(u.id,"clear")} style={{padding:"6px 10px",fontSize:11,fontWeight:700,borderRadius:6,background:"transparent",border:`1px solid ${T.border}`,color:T.muted,cursor:"pointer"}}>✕ Clear</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>

              {allTabs.filter(t=>t.id!=="admin").map(t=>{
                const baseAllowed=t.baseRoles.includes(u.role);
                const currentOn=getAccess(u.id,t.id,t.baseRoles,u.role);
                return <div key={t.id} style={{
                  display:"flex",alignItems:"center",justifyContent:"space-between",
                  padding:"10px 12px",borderRadius:8,
                  background:currentOn&&baseAllowed?"#0A1A0A":"#0A0A0A",
                  border:`1px solid ${currentOn&&baseAllowed?"#1A3A1A":baseAllowed?"#2A1A1A":"#33434F"}`,
                  opacity:baseAllowed?1:0.35}}>
                  <div>
                    <div style={{fontSize:12,fontWeight:700,color:currentOn&&baseAllowed?"#C9D6DF":"#3A4F70"}}>{t.label}</div>
                    {!baseAllowed&&<div style={{fontSize:9,color:"#5C7482",marginTop:2}}>Not in base role</div>}
                  </div>
                  <button onClick={()=>baseAllowed&&toggleModule(u.id,t.id,currentOn)}
                    disabled={!baseAllowed}
                    style={{
                      width:42,height:24,borderRadius:12,border:"none",cursor:baseAllowed?"pointer":"default",
                      background:currentOn&&baseAllowed?"#16A34A":"#33434F",
                      position:"relative",transition:"background .2s",flexShrink:0}}>
                    <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",
                      position:"absolute",top:3,
                      left:currentOn&&baseAllowed?21:3,transition:"left .2s"}}/>
                  </button>
                </div>;
              })}
            </div>
            {(()=>{ const p=getUserPerms(u.id); const flags=[["readOnly","🔒 Read-only mode","Disable all create / edit / save actions"],["exportOnly","📥 Export-only","Hide write UI but allow Excel export"],["canExport","📊 Allow Excel export","Show download / export buttons in Reports"],["canSendReportEmail","📧 Can send report emails","Show the Email Report button in Reports (admin can revoke any time)"]]; return (
              <div style={{marginTop:12,paddingTop:12,borderTop:`1px dashed ${T.border}`}}>
                <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",marginBottom:8}}>Permission Flags</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
                  {flags.map(([f,lbl,desc])=>{
                    const on=!!p[f];
                    return <label key={f} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:6,background:on?"#0A1A0A":"#0A0A0A",border:`1px solid ${on?"#1A3A1A":T.border}`,cursor:"pointer"}}>
                      <input type="checkbox" checked={on} onChange={()=>toggleFlag(u.id,f)} style={{accentColor:T.amber,width:14,height:14}}/>
                      <div>
                        <div style={{fontSize:11,fontWeight:700,color:on?T.text:T.muted}}>{lbl}</div>
                        <div style={{fontSize:9,color:T.dim,marginTop:2}}>{desc}</div>
                      </div>
                    </label>;
                  })}
                </div>
              </div>
            );})()}
          </Card>
        ))}
      </div>
    </div>}

    {/* ── OPERATORS ────────────────────────────────────────── */}
    {panel==="operators"&&<div>
      <div style={{padding:"12px 16px",background:"#0A1520",border:"1px solid #1A3458",borderRadius:8,marginBottom:14,fontSize:12,color:T.muted}}>
        👷 <strong style={{color:T.text}}>Dipping Operators</strong> — Names listed here appear in the Dipping form's operator picker.
        Operator-wise production & coating data flow into the Dashboard and Reports.
      </div>
      <Card T={T} style={{padding:18,marginBottom:14}}>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <DInput dark id="new_op_name" placeholder="Operator full name" style={{flex:1}}
            onKeyDown={(e:any)=>{ if(e.key==="Enter"){ const v=e.target.value.trim(); if(!v) return; setOperators((p:any)=>[...p,{id:Date.now(),name:v,active:true}]); addAudit(me.id,me.full_name,"OPERATOR_ADD","admin","Added operator "+v); e.target.value=""; }}}/>
          <Btn onClick={()=>{ const el=document.getElementById("new_op_name") as any; const v=(el?.value||"").trim(); if(!v) return; setOperators((p:any)=>[...p,{id:Date.now(),name:v,active:true}]); addAudit(me.id,me.full_name,"OPERATOR_ADD","admin","Added operator "+v); el.value=""; }}>+ Add Operator</Btn>
        </div>
      </Card>
      <Card T={T}>
        <SecHead T={T} title="Active Operators" sub={`${operators.length} configured · ${operators.filter((o:any)=>o.active).length} active`}/>
        <Table T={T} headers={["Name","Status","Actions"]}
          rows={operators.map((o:any)=>[
            <strong style={{color:T.text}}>{o.name}</strong>,
            <span style={{color:o.active?T.greenT:T.redT,fontSize:11,fontWeight:700}}>{o.active?"● Active":"● Inactive"}</span>,
            <div style={{display:"flex",gap:6}}>
              <Btn variant="ghost" size="sm" onClick={()=>setOperators((p:any)=>p.map((x:any)=>x.id===o.id?{...x,active:!x.active}:x))}>{o.active?"Deactivate":"Activate"}</Btn>
              <Btn variant="red" size="sm" onClick={()=>{ if(confirm(`Remove operator ${o.name}?`)){ setOperators((p:any)=>p.filter((x:any)=>x.id!==o.id)); addAudit(me.id,me.full_name,"OPERATOR_REMOVE","admin","Removed operator "+o.name); }}}>Delete</Btn>
            </div>,
          ])}/>
      </Card>

      <div style={{padding:"12px 16px",background:"#0A1520",border:"1px solid #1A3458",borderRadius:8,margin:"18px 0 14px",fontSize:12,color:T.muted}}>
        🧑‍✈ <strong style={{color:T.text}}>Shift Supervisors</strong> — Appear in the Dipping form's Shift Supervisor picker and in Shift-Supervisor-wise reports.
      </div>
      <Card T={T} style={{padding:18,marginBottom:14}}>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <DInput dark id="new_sup_name" placeholder="Shift Supervisor full name" style={{flex:1}}
            onKeyDown={(e:any)=>{ if(e.key==="Enter"){ const v=e.target.value.trim(); if(!v) return; setShiftSupervisors((p:any)=>[...(p||[]),{id:Date.now(),name:v,active:true}]); addAudit(me.id,me.full_name,"SHIFT_SUP_ADD","admin","Added shift supervisor "+v); e.target.value=""; }}}/>
          <Btn onClick={()=>{ const el=document.getElementById("new_sup_name") as any; const v=(el?.value||"").trim(); if(!v) return; setShiftSupervisors((p:any)=>[...(p||[]),{id:Date.now(),name:v,active:true}]); addAudit(me.id,me.full_name,"SHIFT_SUP_ADD","admin","Added shift supervisor "+v); el.value=""; }}>+ Add Supervisor</Btn>
        </div>
      </Card>
      <Card T={T}>
        <SecHead T={T} title="Active Shift Supervisors" sub={`${shiftSupervisors.length} configured · ${shiftSupervisors.filter((o:any)=>o.active).length} active`}/>
        <Table T={T} headers={["Name","Status","Actions"]}
          rows={shiftSupervisors.map((o:any)=>[
            <strong style={{color:T.text}}>{o.name}</strong>,
            <span style={{color:o.active?T.greenT:T.redT,fontSize:11,fontWeight:700}}>{o.active?"● Active":"● Inactive"}</span>,
            <div style={{display:"flex",gap:6}}>
              <Btn variant="ghost" size="sm" onClick={()=>setShiftSupervisors((p:any)=>p.map((x:any)=>x.id===o.id?{...x,active:!x.active}:x))}>{o.active?"Deactivate":"Activate"}</Btn>
              <Btn variant="red" size="sm" onClick={()=>{ if(confirm(`Remove shift supervisor ${o.name}?`)){ setShiftSupervisors((p:any)=>p.filter((x:any)=>x.id!==o.id)); addAudit(me.id,me.full_name,"SHIFT_SUP_REMOVE","admin","Removed shift supervisor "+o.name); }}}>Delete</Btn>
            </div>,
          ])}/>
      </Card>
    </div>}

    {panel==="fields"&&<div>
      <div style={{padding:"12px 16px",background:"#0A1520",border:"1px solid #1A3458",
        borderRadius:8,marginBottom:14,fontSize:12,color:T.muted}}>
        🧩 <strong style={{color:T.text}}>Loading Module — Field Configuration</strong> — Toggle visibility of
        Route Card / Quantity fields. Thickness is the standard measurement field across the entire system.
        Changes apply instantly to all operators on next page refresh.
      </div>

      <Card T={T} style={{padding:16,marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:4}}>🎚 65 µm Coating Visibility</div>
            <div style={{fontSize:11,color:T.muted,maxWidth:640}}>
              When disabled, 65 µm is hidden from Loading spec picker, Dipping/QC lists, Recommendations, Dashboard, and all Reports/Exports. Existing 65 µm records remain in the database and reappear when re-enabled.
            </div>
          </div>
          <button onClick={()=>{
            const next=!(feature65um?.enabled!==false);
            setFeature65um({enabled:next});
            setShow65(next);
            addAudit(me.id,me.full_name,"FEATURE_TOGGLE","admin",`65 µm coating ${next?"ENABLED":"DISABLED"} globally`);
          }} style={{width:52,height:28,borderRadius:14,border:"none",cursor:"pointer",
            background:(feature65um?.enabled!==false)?"#16A34A":"#33434F",position:"relative",flex:"0 0 auto"}}>
            <div style={{width:22,height:22,borderRadius:"50%",background:"#fff",
              position:"absolute",top:3,left:(feature65um?.enabled!==false)?27:3,transition:"left .2s"}}/>
          </button>
        </div>
        <div style={{marginTop:8,fontSize:10,fontWeight:700,color:(feature65um?.enabled!==false)?T.greenT:T.redT}}>
          {(feature65um?.enabled!==false)?"● ENABLED — 65 µm visible everywhere":"● DISABLED — 65 µm hidden across the app"}
        </div>
      </Card>

      <MicronRulesAdmin micronRules={micronRules} setMicronRules={setMicronRules} addAudit={addAudit} me={me} T={T}/>
      <MlrTrainingAdmin store={mlrStore} me={me} addAudit={addAudit} aiModel={aiModel} setAiModel={setAiModel} aiDashboardEnabled={aiDashboardEnabled} setAiDashboardEnabled={setAiDashboardEnabled} beams={beams} trainHistory={aiTrainHistory} setTrainHistory={setAiTrainHistory}/>

      <Card T={T} style={{padding:20,marginBottom:14}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14}}>
          {/* Route Card toggle */}
          <div style={{padding:14,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontSize:12,fontWeight:700,color:T.text}}>Route Card Field</div>
              <button onClick={()=>{setFieldConfig(p=>({...p,routeCardEnabled:!p.routeCardEnabled}));addAudit(me.id,me.full_name,"FIELD_TOGGLE","admin",`Route Card field ${!fieldConfig.routeCardEnabled?"enabled":"disabled"}`);}}
                style={{width:42,height:24,borderRadius:12,border:"none",cursor:"pointer",
                background:fieldConfig.routeCardEnabled?"#16A34A":"#33434F",position:"relative"}}>
                <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",
                  position:"absolute",top:3,left:fieldConfig.routeCardEnabled?21:3,transition:"left .2s"}}/>
              </button>
            </div>
            <div style={{fontSize:10,color:T.dim}}>Per-part Route Card numbers in Loading form & table</div>
            <div style={{marginTop:6,fontSize:10,fontWeight:700,color:fieldConfig.routeCardEnabled?T.greenT:T.redT}}>
              {fieldConfig.routeCardEnabled?"● ENABLED":"● DISABLED"}
            </div>
          </div>

          {/* Quantity toggle */}
          <div style={{padding:14,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontSize:12,fontWeight:700,color:T.text}}>Quantity Field</div>
              <button onClick={()=>{setFieldConfig(p=>({...p,qtyEnabled:!p.qtyEnabled}));addAudit(me.id,me.full_name,"FIELD_TOGGLE","admin",`Quantity field ${!fieldConfig.qtyEnabled?"enabled":"disabled"}`);}}
                style={{width:42,height:24,borderRadius:12,border:"none",cursor:"pointer",
                background:fieldConfig.qtyEnabled?"#16A34A":"#33434F",position:"relative"}}>
                <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",
                  position:"absolute",top:3,left:fieldConfig.qtyEnabled?21:3,transition:"left .2s"}}/>
              </button>
            </div>
            <div style={{fontSize:10,color:T.dim}}>Per-part Quantity counter (×N) in Loading rows</div>
            <div style={{marginTop:6,fontSize:10,fontWeight:700,color:fieldConfig.qtyEnabled?T.greenT:T.redT}}>
              {fieldConfig.qtyEnabled?"● ENABLED":"● DISABLED"}
            </div>
          </div>

          {/* Thickness label (locked) */}
          <div style={{padding:14,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
            <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:10}}>Field Label</div>
            <div style={{padding:"8px 10px",background:T.card,border:`1px solid ${T.amber}`,borderRadius:6,fontSize:12,fontWeight:700,color:T.amber,textAlign:"center"}}>THICKNESS</div>
            <div style={{marginTop:8,fontSize:10,color:T.dim}}>Standardised label across all modules.</div>
          </div>
        </div>
      </Card>

      {/* Loading rules — duplicate beam + max weight */}
      <Card T={T} style={{padding:20,marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:12}}>Loading Module — Production Rules</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:14}}>
          {/* Duplicate beam toggle */}
          <div style={{padding:14,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontSize:12,fontWeight:700,color:T.text}}>Duplicate Beam Check</div>
              <button onClick={()=>{
                const next=!(fieldConfig.restrictDuplicateBeam!==false);
                setFieldConfig(p=>({...p,restrictDuplicateBeam:next}));
                addAudit(me.id,me.full_name,"FIELD_TOGGLE","admin",`Duplicate beam check ${next?"enabled":"disabled"}`);
              }}
                style={{width:42,height:24,borderRadius:12,border:"none",cursor:"pointer",
                background:(fieldConfig.restrictDuplicateBeam!==false)?"#16A34A":"#33434F",position:"relative"}}>
                <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",
                  position:"absolute",top:3,left:(fieldConfig.restrictDuplicateBeam!==false)?21:3,transition:"left .2s"}}/>
              </button>
            </div>
            <div style={{fontSize:10,color:T.dim}}>Block re-entry while a beam is LOADED / DIPPING / QC_PENDING. Re-entry allowed once COMPLETED.</div>
            <div style={{marginTop:6,fontSize:10,fontWeight:700,color:(fieldConfig.restrictDuplicateBeam!==false)?T.greenT:T.redT}}>
              {(fieldConfig.restrictDuplicateBeam!==false)?"● ENABLED":"● DISABLED"}
            </div>
          </div>

          {/* Max beam weight */}
          <div style={{padding:14,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
            <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:8}}>Max Beam Weight (MT)</div>
            <DInput dark type="number" step="0.1" min="0.1"
              value={typeof fieldConfig.maxBeamWeightMT==="number"?fieldConfig.maxBeamWeightMT:3.0}
              onChange={e=>{
                const v=parseFloat(e.target.value)||3.0;
                setFieldConfig(p=>({...p,maxBeamWeightMT:v}));
                addAudit(me.id,me.full_name,"FIELD_UPDATE","admin",`Max beam weight set to ${v} MT`);
              }}
              style={{width:"100%",fontFamily:"monospace",textAlign:"center",fontSize:14}}/>
            <div style={{marginTop:6,fontSize:10,color:T.dim}}>Beam total weight must be strictly below this cap (default 3.0 MT).</div>
          </div>

          {/* Max thickness */}
          <div style={{padding:14,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
            <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:8}}>Maximum Thickness (mm)</div>
            <DInput dark type="number" step="0.5" min="0.5"
              value={typeof fieldConfig.maxThicknessMm==="number"?fieldConfig.maxThicknessMm:40}
              onChange={e=>{
                const v=parseFloat(e.target.value)||40;
                setFieldConfig(p=>({...p,maxThicknessMm:v}));
                addAudit(me.id,me.full_name,"FIELD_UPDATE","admin",`Max thickness set to ${v} mm`);
              }}
              style={{width:"100%",fontFamily:"monospace",textAlign:"center",fontSize:14}}/>
            <div style={{marginTop:6,fontSize:10,color:T.dim}}>Loading rejects any thickness above this value (default 40 mm). Numbers only.</div>
          </div>
        </div>
      </Card>

      {/* Audit retention */}
      <Card T={T} style={{padding:20,marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:12}}>Audit Log — Retention Policy</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,alignItems:"end"}}>
          <div style={{padding:14,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
            <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:8}}>Keep audit entries for</div>
            <select
              value={Number(fieldConfig?.auditRetentionDays)||0}
              onChange={e=>{
                const v=parseInt(e.target.value,10)||0;
                setFieldConfig(p=>({...p,auditRetentionDays:v}));
                addAudit(me.id,me.full_name,"FIELD_UPDATE","admin",`Audit retention set to ${v===0?"Never (no purge)":v+" day(s)"}`);
              }}
              style={{width:"100%",background:"#16202B",border:`1px solid ${T.border}`,color:T.text,padding:"8px 10px",borderRadius:6,fontSize:13,fontFamily:"monospace",fontWeight:700}}>
              {[30,60,90,180,365].map(d=><option key={d} value={d}>{d} days</option>)}
              <option value={0}>Never (do not purge)</option>
            </select>
            <div style={{marginTop:6,fontSize:10,color:T.dim}}>Entries older than this are auto-purged once per day when an admin opens the app. Default: 90 days.</div>
          </div>
          <div style={{padding:14,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
            <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:8}}>Purge now</div>
            <button onClick={()=>{
              const days=Number(fieldConfig?.auditRetentionDays);
              if(!days){ alert("Retention is set to Never. Pick a retention window first."); return; }
              if(confirm(`Delete every audit entry older than ${days} day(s)? This cannot be undone.`)) purgeOldAudit(false);
            }} style={{padding:"10px 14px",borderRadius:6,background:"#2A1408",color:"#FB923C",border:"1px solid #FB923C60",fontSize:12,fontWeight:800,cursor:"pointer",width:"100%"}}>🧹 Purge entries older than {Number(fieldConfig?.auditRetentionDays)||"—"} days</button>
            <div style={{marginTop:6,fontSize:10,color:T.dim}}>Runs the server-side purge immediately. The action itself is recorded in the audit log.</div>
          </div>
        </div>
      </Card>


      <div style={{padding:"10px 14px",background:"#16202B",border:"1px solid #1A3458",borderRadius:8,fontSize:11,color:T.muted}}>
        ℹ All field-config changes are audited and apply globally to every Loading operator.
      </div>
    </div>}

    {/* ── EMAIL CONFIG ──────────────────────────────────────── */}
    {/* ── DIPPING AI CONFIG ────────────────────────────────── */}
    {panel==="ai"&&<div>
      <div style={{padding:"12px 16px",background:"#0A1520",border:"1px solid #1A3458",borderRadius:8,marginBottom:14,fontSize:12,color:T.muted}}>
        🧠 <strong style={{color:T.text}}>Dipping AI — Coating Recommendation Engine</strong> — Configure
        bucket ranges, toggle matching fields, and enable/disable the AI suggestions shown to dipping operators.
      </div>

      {/* Engine on/off + field toggles */}
      <Card T={T} style={{padding:18,marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:12}}>Engine &amp; Matching Fields</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          {[
            ["engineEnabled","AI Recommendation Engine"],
            ["showThickness","Match Thickness"],
            ["showWeight","Match Weight (± tol)"],
            ["showTemperature","Match Temperature (± tol)"],
            ["showQty","Match Quantity (± tol)"],
            ["showLength","Match Length (± tol)"],
            ["showLoadType","Match Load Type"],
            ["showMaterialType","Match Material Type (MS / HT)", true],
            ["showSurfaceCondition","Match Surface Condition", true],
            ["regressionEnabled","Regression Model (last 7 days)"],
          ].map(([k,lbl,mandatory])=>{
            const on=!!dippingConfig[k];
            return <div key={k} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
              <div style={{fontSize:12,fontWeight:700,color:T.text}}>{lbl}{mandatory && <span style={{marginLeft:6,fontSize:9,color:T.amber}}>MANDATORY</span>}</div>
              <button onClick={()=>{if(!mandatory){setDippingConfig(p=>({...p,[k]:!p[k]}));addAudit(me.id,me.full_name,"AI_TOGGLE","admin",`${lbl}: ${!on?"ON":"OFF"}`);}}} disabled={!!mandatory} title={mandatory?"Mandatory exact match — always enabled":(on?"Disable":"Enable")}
                style={{width:42,height:24,borderRadius:12,border:"none",cursor:mandatory?"not-allowed":"pointer",background:(mandatory||on)?"#16A34A":"#33434F",position:"relative",opacity:mandatory?0.85:1}}>
                <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:(mandatory||on)?21:3,transition:"left .2s"}}/>
              </button>
            </div>;
          })}
        </div>
      </Card>

      {/* Tolerance editors (±) — replaces bucket ranges */}
      <Card T={T} style={{padding:18,marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:4}}>Match Tolerances (±)</div>
        <div style={{fontSize:10,color:T.dim,marginBottom:12}}>Each tolerance defines a window around the current beam's value (e.g. Length 6000 ±500 → 5500–6500 mm).</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14}}>
          {[
            {key:"weightTol",label:"Weight",unit:"MT",step:"0.01",dflt:0.2},
            {key:"tempTol",label:"Temperature",unit:"°C",step:"0.5",dflt:2},
            {key:"lengthTol",label:"Length",unit:"mm",step:"50",dflt:500},
            {key:"qtyTol",label:"Quantity",unit:"pcs",step:"1",dflt:5},
          ].map(r=>(
            <div key={r.key} style={{padding:14,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
              <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:8}}>{r.label} <span style={{color:T.dim,fontWeight:400}}>({r.unit})</span></div>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontFamily:"monospace",fontSize:14,color:T.amber,fontWeight:800}}>±</span>
                <DInput dark type="number" step={r.step} value={dippingConfig[r.key]??r.dflt}
                  onChange={e=>setDippingConfig(p=>({...p,[r.key]:parseFloat(e.target.value)||0}))}
                  style={{width:"100%",fontFamily:"monospace",fontSize:13,textAlign:"center"}}/>
              </div>
            </div>
          ))}
        </div>
        <div style={{marginTop:12,padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,display:"flex",alignItems:"center",gap:12}}>
          <div style={{fontSize:12,fontWeight:700,color:T.text}}>Show Top-N Results</div>
          <DInput dark type="number" min="1" max="10" value={dippingConfig.topN} onChange={e=>setDippingConfig(p=>({...p,topN:Math.max(1,Math.min(10,parseInt(e.target.value)||3))}))} style={{width:80,fontFamily:"monospace",textAlign:"center"}}/>
          <div style={{fontSize:10,color:T.dim}}>Number of best historical coatings shown to operators (default 3).</div>
        </div>
        <div style={{marginTop:10,padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:T.text}}>Allow Post-Save Edit of Timings</div>
            <div style={{fontSize:10,color:T.dim,marginTop:2}}>When ON, operators can edit captured Dipping timestamps via ✎ Edit Timings. Admins always have access.</div>
          </div>
          <button onClick={()=>{const on=!!dippingConfig.allowPostEdit; setDippingConfig(p=>({...p,allowPostEdit:!on})); addAudit(me.id,me.full_name,"AI_TOGGLE","admin",`allowPostEdit: ${!on?"ON":"OFF"}`);}}
            style={{width:42,height:24,borderRadius:12,border:"none",cursor:"pointer",background:dippingConfig.allowPostEdit?"#16A34A":"#33434F",position:"relative",flexShrink:0}}>
            <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:dippingConfig.allowPostEdit?21:3,transition:"left .2s"}}/>
          </button>
        </div>
        <div style={{marginTop:10,padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:T.text}}>Allow Post-Save Edit of Coating on Job</div>
            <div style={{fontSize:10,color:T.dim,marginTop:2}}>When ON, QC inspectors can edit saved 7-point Elcometer readings via ✎ Edit. Admins always have access.</div>
          </div>
          <button onClick={()=>{const on=!!dippingConfig.allowQCEdit; setDippingConfig(p=>({...p,allowQCEdit:!on})); addAudit(me.id,me.full_name,"AI_TOGGLE","admin",`allowQCEdit: ${!on?"ON":"OFF"}`);}}
            style={{width:42,height:24,borderRadius:12,border:"none",cursor:"pointer",background:dippingConfig.allowQCEdit?"#16A34A":"#33434F",position:"relative",flexShrink:0}}>
            <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:dippingConfig.allowQCEdit?21:3,transition:"left .2s"}}/>
          </button>
        </div>
        <div style={{marginTop:10,padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:T.text}}>🧭 Stage-by-Stage Variance Analysis</div>
            <div style={{fontSize:10,color:T.dim,marginTop:2}}>When ON, the Dipping screen and Dipping Register report show per-stage time variance (Immersion / Reaction / Withdrawal / Total) vs the Closest Match reference beam.</div>
          </div>
          <button onClick={()=>{const on=dippingConfig.varianceAnalysisEnabled!==false; setDippingConfig(p=>({...p,varianceAnalysisEnabled:!on})); addAudit(me.id,me.full_name,"AI_TOGGLE","admin",`Variance Analysis: ${!on?"ON":"OFF"}`);}}
            style={{width:42,height:24,borderRadius:12,border:"none",cursor:"pointer",background:dippingConfig.varianceAnalysisEnabled!==false?"#16A34A":"#33434F",position:"relative",flexShrink:0}}>
            <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:dippingConfig.varianceAnalysisEnabled!==false?21:3,transition:"left .2s"}}/>
          </button>
        </div>
        {(() => {
          const cbm = fieldConfig.cojBestMatch || COJ_BM_DEFAULTS;
          const crit = { ...COJ_BM_DEFAULTS.criteria, ...(cbm.criteria || {}) };
          const masterOn = cbm.enabled !== false;
          const updateCfg = (next:any, auditMsg:string) => {
            setFieldConfig(p=>({...p, cojBestMatch: next, qcBestMatchEnabled: next.enabled}));
            addAudit(me.id,me.full_name,"FIELD_TOGGLE","admin",auditMsg);
          };
          const toggleMaster = () => updateCfg({...cbm, criteria: crit, enabled: !masterOn}, `CoJ Best Match: ${!masterOn?"ENABLED":"DISABLED"}`);
          const toggleCrit = (key:string) => {
            const cur = !!crit[key]?.enabled;
            const nextCrit = {...crit, [key]: {...crit[key], enabled: !cur}};
            updateCfg({...cbm, enabled: masterOn, criteria: nextCrit}, `CoJ Best Match · ${key}: ${!cur?"ON":"OFF"}`);
          };
          const setTol = (key:string, v:number) => {
            const nextCrit = {...crit, [key]: {...crit[key], tol: v}};
            updateCfg({...cbm, enabled: masterOn, criteria: nextCrit}, `CoJ Best Match · ${key} tol: ±${v}`);
          };
          const rows: {key:string; label:string; unit?:string; step?:string; mandatory?:boolean}[] = [
            {key:"specificMicron",   label:"Specific Micron (exact)", mandatory:true},
            {key:"loadType",         label:"Load Type (exact)"},
            {key:"thickness",        label:"Thickness", unit:"mm", step:"0.1"},
            {key:"weight",           label:"Weight",    unit:"MT", step:"0.01"},
            {key:"length",           label:"Length",    unit:"mm", step:"50"},
            {key:"temperature",      label:"Temperature", unit:"°C", step:"0.5"},
            {key:"materialType",     label:"Material Type (MS / HT, exact)", mandatory:true},
            {key:"surfaceCondition", label:"Surface Condition (Normal / Rusted / Heavy Rusted, exact)", mandatory:true},
          ];
          return <div style={{marginTop:10,padding:"12px 14px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:6}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:T.text}}>Coating on Job — Best Match Criteria</div>
                <div style={{fontSize:10,color:T.dim,marginTop:2}}>A historical PASS beam is selected only when <strong style={{color:T.amber}}>ALL enabled criteria pass</strong>. From survivors, the one closest to its own specific-micron value wins.</div>
              </div>
              <button onClick={toggleMaster}
                style={{width:42,height:24,borderRadius:12,border:"none",cursor:"pointer",background:masterOn?"#16A34A":"#33434F",position:"relative",flexShrink:0}}>
                <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:masterOn?21:3,transition:"left .2s"}}/>
              </button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr",gap:6,opacity:masterOn?1:0.5,pointerEvents:masterOn?"auto":"none"}}>
              {rows.map(r => {
                const on = !!crit[r.key]?.enabled;
                const showOn = !!r.mandatory || on;
                const tol = crit[r.key]?.tol;
                const hasTol = r.unit != null;
                return <div key={r.key} style={{display:"grid",gridTemplateColumns:"24px 1fr 140px",alignItems:"center",gap:10,padding:"6px 8px",background:T.card,border:`1px solid ${T.border}`,borderRadius:6}}>
                  <button onClick={()=>{ if(!r.mandatory) toggleCrit(r.key); }} disabled={r.mandatory}
                    title={r.mandatory?"Mandatory — always enabled":(on?"Disable":"Enable")}
                    style={{width:20,height:20,borderRadius:4,border:`1.5px solid ${showOn?"#4ADE80":T.border}`,background:showOn?"#4ADE8030":"transparent",color:"#4ADE80",cursor:r.mandatory?"not-allowed":"pointer",fontSize:13,fontWeight:900,padding:0}}>
                    {showOn?"✓":""}
                  </button>
                  <div style={{fontSize:12,fontWeight:700,color:T.text}}>
                    {r.label}{r.mandatory && <span style={{marginLeft:6,fontSize:9,color:T.amber,fontWeight:700}}>MANDATORY</span>}
                  </div>
                  {hasTol ? (
                    <div style={{display:"flex",alignItems:"center",gap:6,justifyContent:"flex-end"}}>
                      <span style={{fontFamily:"monospace",fontSize:12,color:on?T.amber:T.dim,fontWeight:800}}>±</span>
                      <DInput dark type="number" step={r.step} value={tol ?? 0}
                        disabled={!on}
                        onChange={e=>setTol(r.key, parseFloat(e.target.value)||0)}
                        style={{width:70,fontFamily:"monospace",fontSize:12,textAlign:"center"}}/>
                      <span style={{fontSize:10,color:T.dim,minWidth:28}}>{r.unit}</span>
                    </div>
                  ) : <div style={{fontSize:10,color:T.dim,textAlign:"right"}}>{r.mandatory?"exact":"exact match"}</div>}
                </div>;
              })}
            </div>
          </div>;
        })()}
        {(() => {
          const on = fieldConfig.sixSigmaEnabled !== false;
          return <div style={{marginTop:10,padding:"12px 14px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:T.text}}>Dashboard — Six Sigma Capability Panel</div>
              <div style={{fontSize:10,color:T.dim,marginTop:2}}>Shows <strong style={{color:T.amber}}>Cp, Cpk, Pp, Ppk</strong> per micron spec using QC Range (min = LSL, ok_max = USL) on completed beams.</div>
            </div>
            <button onClick={()=>{
              setFieldConfig(p=>({...p, sixSigmaEnabled: !on}));
              addAudit(me.id,me.full_name,"FIELD_TOGGLE","admin",`Six Sigma panel: ${!on?"ENABLED":"DISABLED"}`);
            }} style={{width:42,height:24,borderRadius:12,border:"none",cursor:"pointer",background:on?"#16A34A":"#33434F",position:"relative",flexShrink:0}}>
              <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:on?21:3,transition:"left .2s"}}/>
            </button>
          </div>;
        })()}
        {(() => {
          const on = fieldConfig.cojReadingMaxEnabled !== false;
          const cap = Number(fieldConfig.cojReadingMax) || 500;
          return <div style={{marginTop:10,padding:"12px 14px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:T.text}}>Coating on Job — Reading Cap</div>
                <div style={{fontSize:10,color:T.dim,marginTop:2}}>When ON, any of the 7 Elcometer points above this value is <strong style={{color:T.amber}}>rejected at entry</strong>.</div>
              </div>
              <button onClick={()=>{
                setFieldConfig(p=>({...p, cojReadingMaxEnabled: !on}));
                addAudit(me.id,me.full_name,"FIELD_TOGGLE","admin",`CoJ Reading Cap: ${!on?"ENABLED":"DISABLED"}`);
              }} style={{width:42,height:24,borderRadius:12,border:"none",cursor:"pointer",background:on?"#16A34A":"#33434F",position:"relative",flexShrink:0}}>
                <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:on?21:3,transition:"left .2s"}}/>
              </button>
            </div>
            <div style={{marginTop:10,display:"flex",alignItems:"center",gap:10,opacity:on?1:0.5,pointerEvents:on?"auto":"none"}}>
              <span style={{fontSize:11,color:T.muted,fontWeight:700}}>Max reading per point:</span>
              <input type="number" min={1} max={2000} step={1} value={cap}
                onChange={e=>{
                  const raw = parseFloat(e.target.value);
                  const next = !Number.isFinite(raw) ? 500 : Math.min(2000, Math.max(1, Math.round(raw)));
                  setFieldConfig(p=>({...p, cojReadingMax: next}));
                }}
                onBlur={()=>addAudit(me.id,me.full_name,"FIELD_TOGGLE","admin",`CoJ Reading Cap max: ${cap} μm`)}
                style={{width:90,padding:"6px 8px",background:"#0F1720",border:"1px solid #33434F",color:"#C9D6DF",borderRadius:6,fontFamily:"monospace",fontSize:13,fontWeight:800,textAlign:"center"}}/>
              <span style={{fontSize:11,color:T.dim,fontWeight:700}}>μm</span>
            </div>
          </div>;
        })()}
        <div style={{marginTop:10,padding:"12px 14px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
          <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:4}}>Dipping Time Entry Mode</div>
          <div style={{fontSize:10,color:T.dim,marginBottom:10}}>
            Choose how operators record Immersion / Reaction / Withdrawal durations.
            <strong> Live</strong> uses the on-screen stopwatch; <strong>Manual</strong> accepts MM:SS entry;
            <strong> Both</strong> lets the operator pick per dip. All values flow into dashboards, reports, SPC &amp; Six Sigma — Entry Mode is tagged on every record.
          </div>
          {(() => {
            const curMode: "live_only"|"manual_only"|"both" =
              dippingConfig.dippingTimeMode || (dippingConfig.manualDurationEntry ? "manual_only" : "live_only");
            const opts: {k:"live_only"|"manual_only"|"both"; lbl:string; col:string}[] = [
              {k:"live_only",   lbl:"Live Time Only",     col:"#4ADE80"},
              {k:"manual_only", lbl:"Manual Time Only",   col:"#FB923C"},
              {k:"both",        lbl:"Both Live & Manual", col:"#A78BFA"},
            ];
            return <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {opts.map(o=>{
                const on = curMode === o.k;
                return <button key={o.k} type="button" onClick={()=>{
                  setDippingConfig(p=>({...p,dippingTimeMode:o.k,manualDurationEntry:o.k==="manual_only"}));
                  addAudit(me.id,me.full_name,"AI_TOGGLE","admin",`dippingTimeMode: ${o.k}`);
                }} style={{padding:"8px 16px",borderRadius:6,cursor:"pointer",fontSize:11,fontWeight:800,fontFamily:"inherit",
                  background:on?o.col:"transparent",color:on?"#000":o.col,border:`1.5px solid ${o.col}`}}>
                  {on?"● ":""}{o.lbl}
                </button>;
              })}
            </div>;
          })()}
        </div>
      </Card>

      <div style={{padding:"10px 14px",background:"#16202B",border:"1px solid #1A3458",borderRadius:8,fontSize:11,color:T.muted}}>
        ℹ Changes apply instantly. Engine matches past PASS beams using ± tolerance windows on the current beam's Thickness, Weight, Temperature, Length, Qty and Load Type.
      </div>

    </div>}

    {panel==="email"&&<div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
        {Object.entries(REPORT_LABELS).map(([cat,title])=>(
          <Card key={cat} T={T} style={{padding:18}}>
            <div style={{fontSize:12,fontWeight:700,color:T.amber,marginBottom:3}}>{title}</div>
            <div style={{fontSize:10,color:T.dim,marginBottom:12,letterSpacing:".03em"}}>
              {cat==="loading"?"Sent 14:00 daily — PDF + Excel attachment":
               cat==="dipping"?"Sent 22:00 daily — Dipping & QC combined sheet":
               cat==="qc"?"Sent after each Coating on Job batch — inspection summary":
               cat==="hourly"?"Sent every hour — MT and beam count":
               "Sent at shift end — full shift production metrics"}
            </div>

            {/* Recipient list */}
            <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:10}}>
              {emailRecs[cat].length===0&&<div style={{fontSize:11,color:T.dim,fontStyle:"italic",padding:"6px 0"}}>No recipients — add below</div>}
              {emailRecs[cat].map(email=>(
                <div key={email} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                  padding:"6px 10px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:6}}>
                  <span style={{fontSize:12,color:T.text,fontFamily:"monospace"}}>
                    <span style={{color:T.greenT,marginRight:8}}>✉</span>{email}
                  </span>
                  <button onClick={()=>removeEmailRec(cat,email)} aria-label={`Remove recipient ${email}`} title="Remove recipient"
                    style={{background:"transparent",border:"none",color:T.redT,cursor:"pointer",fontSize:15,padding:"0 4px",lineHeight:1}}><span aria-hidden="true">✕</span></button>
                </div>
              ))}
            </div>

            {/* Add new email input */}
            <div style={{display:"flex",gap:8}}>
              <DInput dark value={newEmail[cat]} onChange={e=>setNE(p=>({...p,[cat]:e.target.value}))}
                placeholder="name@company.com"
                onKeyDown={e=>e.key==="Enter"&&addEmailRec(cat)}
                style={{flex:1,fontSize:12}}/>
              <Btn onClick={()=>addEmailRec(cat)} size="sm">+ Add</Btn>
            </div>
            {emailMsg.cat===cat&&emailMsg.text&&
              <div style={{fontSize:11,color:T.redT,marginTop:5}}>{emailMsg.text}</div>}

            <div style={{marginTop:10,display:"flex",gap:8,alignItems:"center"}}>
              <span style={{padding:"2px 8px",background:"#0A2218",color:"#4ADE80",borderRadius:4,fontSize:10,fontWeight:700}}>● ACTIVE</span>
              <span style={{fontSize:10,color:T.dim}}>{emailRecs[cat].length} recipient(s)</span>
            </div>
          </Card>
        ))}
      </div>
      <div style={{padding:"12px 16px",background:"#16202B",borderRadius:8,border:"1px solid #1A3458",fontSize:12,color:T.muted}}>
        ℹ <strong style={{color:T.text}}>Power Automate Integration:</strong> Recipient lists sync automatically to your Power Automate flow.
        Reports are sent as PDF + Excel attachments on the schedule shown.
        Add admin recipients above for each report category.
      </div>
    </div>}

    {/* ── DATA MANAGEMENT (admin selective delete) ─────────── */}
    {panel==="data"&&<Card T={T}>
      <SecHead T={T} title="Master Beam Data — Admin"
        sub="View, edit, correct or delete any beam across Loading, Dipping, Coating on Job and Tracker. Changes propagate to every linked module and are audit-logged."
        right={Object.values(beamSel).filter(Boolean).length>0 ? (
          <button onClick={()=>{
            const nos=Object.keys(beamSel).filter(k=>beamSel[k]);
            if(confirm(`Permanently delete ${nos.length} beam(s)? This cannot be undone.`)){
              deleteBeams(nos); setBeamSel({});
            }
          }} style={{padding:"6px 12px",borderRadius:6,background:"#2A0808",color:"#F87171",border:"1px solid #F8717160",fontSize:11,fontWeight:700,cursor:"pointer"}}>
            🗑 Delete {Object.values(beamSel).filter(Boolean).length} selected
          </button>
        ) : null}/>
      <div style={{display:"flex",gap:8,alignItems:"center",padding:"0 12px 12px",flexWrap:"wrap"}}>
        <input value={beamSearch} onChange={e=>setBeamSearch(e.target.value)}
          placeholder="Search beam no / part / load type / status…"
          style={{flex:1,minWidth:220,background:T.bg,border:`1px solid ${T.border}`,color:T.text,padding:"6px 10px",borderRadius:6,fontSize:12}}/>
        <MultiSelectFilter T={T} width={180} allLabel="All sources" value={beamSrcFilter} onChange={setBeamSrcFilter}
          options={[
            {value:"LOADING",label:"Loading Register"},
            {value:"DIPPING",label:"Dipping Register"},
            {value:"COJ",label:"Coating on Job"},
            {value:"TRACKER",label:"Beam Tracker"},
          ]}/>
        <MultiSelectFilter T={T} width={140} allLabel="All specs" value={beamSpecFilter} onChange={setBeamSpecFilter}
          options={[...(is65Enabled()?[{value:"65",label:"65 µm"}]:[]),{value:"87",label:"87 µm"},{value:"130",label:"130 µm"}]}/>
        <input type="date" value={beamFromDate} onChange={e=>setBeamFromDate(e.target.value)} title="From (loaded date)"
          style={{background:T.bg,border:`1px solid ${T.border}`,color:T.text,padding:"6px 10px",borderRadius:6,fontSize:11}}/>
        <input type="date" value={beamToDate} onChange={e=>setBeamToDate(e.target.value)} title="To (loaded date)"
          style={{background:T.bg,border:`1px solid ${T.border}`,color:T.text,padding:"6px 10px",borderRadius:6,fontSize:11}}/>
        {(beamSpecFilter.length||beamSrcFilter.length||beamFromDate||beamToDate)&&(
          <button onClick={()=>{setBeamSpecFilter([]);setBeamSrcFilter([]);setBeamFromDate("");setBeamToDate("");}}
            style={{background:T.bg,border:`1px solid ${T.border}`,color:T.dim,padding:"6px 10px",borderRadius:6,fontSize:10,cursor:"pointer"}}>✕ Clear</button>
        )}
      </div>
      {(()=>{
        const qq=beamSearch.trim().toLowerCase();
        const inSrc=(b:any)=>{
          if(beamSrcFilter.length===0) return true;
          return beamSrcFilter.some((s)=>{
            if(s==="LOADING"||s==="TRACKER") return true;
            if(s==="DIPPING") return !!b.dipped_at || ["DIPPING","QC_PENDING","COMPLETED"].includes(b.status);
            if(s==="COJ") return !!b.qc_completed_at || b.status==="COMPLETED" || !!b.qc_status;
            return false;
          });
        };
        const inSpec=(b:any)=> beamSpecFilter.length===0 || beamSpecFilter.includes(String(b.coating_required??""));

        const inDate=(b:any)=>{
          const k=(b.loaded_at||"").slice(0,10);
          if(beamFromDate && (!k || k<beamFromDate)) return false;
          if(beamToDate && (!k || k>beamToDate)) return false;
          return true;
        };
        const filtered=beams.filter((b:any)=>inSrc(b) && inSpec(b) && inDate(b) && (!qq || (`${b.beam_no} ${b.part_nos||""} ${b.load_type||""} ${b.status||""}`).toLowerCase().includes(qq)))
          .slice().sort((a:any,b:any)=>new Date(b.loaded_at).getTime()-new Date(a.loaded_at).getTime()).slice(0,300);
        return <>
          <Table T={T}
            headers={[<input key="hba" type="checkbox" checked={filtered.length>0 && filtered.every((b:any)=>beamSel[txn(b)])}
              onChange={e=>{ const ck=e.target.checked; const n:any={...beamSel}; filtered.forEach((b:any)=>{ if(ck) n[txn(b)]=true; else delete n[txn(b)]; }); setBeamSel(n); }}/>,"Beam No","Load Type","Weight","μm","Status","Loaded","Dipped","CoJ","Actions"]}
            rows={filtered.map((b:any)=>[
              <input key={txn(b)+"_ds"} type="checkbox" checked={!!beamSel[txn(b)]} onChange={e=>setBeamSel(p=>({...p,[txn(b)]:e.target.checked}))}/>,
              bn(b.beam_no), b.load_type, (b.total_weight??"")+"MT", (b.coating_required??"")+"μm",
              <StatusBadge status={b.status}/>,
              <span style={{fontSize:11}}>{fmt12(b.loaded_at)}</span>,
              <span style={{fontSize:11,color:T.amber}}>{fmt12(b.dipped_at)}</span>,
              <span style={{fontSize:11,color:T.greenT}}>{fmt12(b.qc_completed_at)}</span>,
              <div key={txn(b)+"_act"} style={{display:"flex",gap:4}}>
                <button onClick={()=>setEditBeam({...b})} style={{padding:"4px 10px",borderRadius:5,background:"#0E1E3A",color:T.blueT,border:`1px solid ${T.blueT}60`,fontSize:10,fontWeight:700,cursor:"pointer"}}>✎ Edit</button>
                <button onClick={()=>{ if(confirm(`Permanently delete beam ${b.beam_no}?`)) deleteBeams([txn(b)]); }} style={{padding:"4px 10px",borderRadius:5,background:"#2A0808",color:"#F87171",border:"1px solid #F8717160",fontSize:10,fontWeight:700,cursor:"pointer"}}>🗑</button>
              </div>,
            ])}/>
          <div style={{padding:"8px 12px",fontSize:10,color:T.dim}}>Showing {filtered.length} of {beams.length} records (latest 300 after filter).</div>
        </>;
      })()}
    </Card>}

    {/* ── MASTER BEAM EDIT MODAL ───────────────────────────── */}
    {editBeam && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.82)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000,padding:20}}>
      <div style={{background:T.surf,border:`2px solid ${T.amber}`,borderRadius:12,padding:24,width:640,maxHeight:"90vh",overflowY:"auto",boxShadow:`0 0 40px ${T.amber}40`}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
          <span style={{fontSize:18}}>✎</span>
          <div style={{fontSize:15,fontWeight:800,color:T.amber}}>Edit Beam — {editBeam.beam_no}</div>
          <div style={{flex:1}}/>
          <span style={{fontSize:10,color:T.dim}}>Txn: <code style={{color:T.muted}}>{txn(editBeam)}</code></span>
        </div>
        <div style={{padding:"10px 12px",background:"#1A0E00",border:"1px solid #3A2A00",borderRadius:8,marginBottom:14,fontSize:11,color:"#FB923C"}}>
          ⚠ Edits here update the master record and are reflected in Loading, Dipping, Coating on Job, Tracker and Reports immediately.
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {[
            ["beam_no","Beam No","text"],
            ["load_type","Load Type","text"],
            ["part_nos","Part No(s)","text"],
            ["section","Thickness (mm)","thickness"],
            ["material_type","Material Type","material"],
            ["surface_condition","Surface Condition","surface"],
            ["length_mm","Length (mm)","number"],
            ["total_qty","Quantity","number"],
            ["total_weight","Weight (MT)","number"],
            ["coating_required","Specific Micron (μm)","micron"],
            ["bath_temperature","Zinc Bath Temperature (°C)","number"],
            ["immersion_duration","Immersion Time (sec)","number"],
            ["reaction_duration","Reaction Time (sec)","number"],
            ["withdrawal_duration","Withdrawal Time (sec)","number"],
            ["status","Status","select"],
            ["shift","Shift","text"],
            ["work_centre","Work Centre","text"],
            ["loadingOperator","Loading Operator","text"],
            ["dipping_operator","Dipping Operator","text"],
            ["shift_supervisor","Shift Supervisor","text"],
            ["loaded_at","Loaded At (ISO)","text"],
            ["dipped_at","Dipped At (ISO)","text"],
            ["qc_completed_at","CoJ Completed At (ISO)","text"],
            ["avg_reading","Avg μm Reading","number"],
          ].map(([k,label,kind])=>{
            const key=k as string;
            const sel=(opts:any[])=>(
              <select value={editBeam[key]??""} onChange={e=>setEditBeam((p:any)=>({...p,[key]:e.target.value===""?null:e.target.value}))}
                style={{width:"100%",background:T.bg,border:`1px solid ${T.border}`,color:T.text,padding:"6px 10px",borderRadius:6,fontSize:12}}>
                <option value="">—</option>
                {opts.map((s:any)=><option key={String(s)} value={String(s)}>{String(s)}</option>)}
              </select>
            );
            return <div key={key}>
              <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:4}}>{label}</label>
              {kind==="select"
                ? <select value={editBeam[key]??""} onChange={e=>setEditBeam((p:any)=>({...p,[key]:e.target.value}))}
                    style={{width:"100%",background:T.bg,border:`1px solid ${T.border}`,color:T.text,padding:"6px 10px",borderRadius:6,fontSize:12}}>
                    {STATUS_ORDER.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                : kind==="material" ? sel(["MS","HT"])
                : kind==="surface" ? sel(["Normal","Rusted","Heavy Rusted"])
                : kind==="micron" ? (
                  <select value={editBeam[key]??""} onChange={e=>setEditBeam((p:any)=>({...p,[key]:e.target.value===""?null:Number(e.target.value)}))}
                    style={{width:"100%",background:T.bg,border:`1px solid ${T.border}`,color:T.text,padding:"6px 10px",borderRadius:6,fontSize:12}}>
                    <option value="">—</option>
                    {filterCoatings([65,87,130]).map((m:any)=><option key={m} value={m}>{m} μm</option>)}
                  </select>
                )
                : kind==="thickness" ? (
                  <input type="text" inputMode="decimal" value={editBeam[key]??""}
                    onChange={e=>setEditBeam((p:any)=>({...p,[key]:sanitizeThicknessInput(e.target.value)}))}
                    placeholder={`max ${maxThicknessOf(fieldConfig)} mm`}
                    style={{width:"100%",background:T.bg,border:`1px solid ${T.border}`,color:T.text,padding:"6px 10px",borderRadius:6,fontSize:12,fontFamily:"monospace"}}/>
                )
                : <input type={kind==="number"?"number":"text"} value={editBeam[key]??""}
                    onChange={e=>setEditBeam((p:any)=>({...p,[key]:kind==="number"?(e.target.value===""?"":Number(e.target.value)):e.target.value}))}
                    style={{width:"100%",background:T.bg,border:`1px solid ${T.border}`,color:T.text,padding:"6px 10px",borderRadius:6,fontSize:12,fontFamily:kind==="number"?"monospace":"inherit"}}/>}
            </div>;
          })}
          <div>
            <label style={{fontSize:10,color:"#8DA0AD",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",display:"block",marginBottom:4}}>Total Cycle Time (derived)</label>
            <input readOnly value={fmtDur(
              (Number(editBeam.immersion_duration)||0)+(Number(editBeam.reaction_duration)||0)+(Number(editBeam.withdrawal_duration)||0)
            )} style={{width:"100%",background:"#0A1526",border:`1px solid ${T.border}`,color:T.muted,padding:"6px 10px",borderRadius:6,fontSize:12,fontFamily:"monospace"}}/>
          </div>
        </div>

        {/* 30-point coating readings */}
        <div style={{marginTop:16,padding:12,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
            <div style={{fontSize:12,fontWeight:800,color:T.cyanT}}>30-Point Coating Readings</div>
            <div style={{flex:1}}/>
            {!editBeam.__v2s && <button onClick={()=>setEditBeam((p:any)=>({...p,__v2s:isV2Coj(p)?v2ToStrings(p.elcometer_v2):emptyV2Strings()}))}
              style={{padding:"4px 10px",borderRadius:5,background:"#0E1E3A",color:T.blueT,border:`1px solid ${T.blueT}60`,fontSize:10,fontWeight:700,cursor:"pointer"}}>
              ✎ Edit readings
            </button>}
          </div>
          {!editBeam.__v2s
            ? <div style={{fontSize:11,color:T.dim}}>{isV2Coj(editBeam)?`Current average: ${Number(v2TotalAverage(editBeam.elcometer_v2)||0).toFixed(2)} μm`:"No 30-point readings on this record."}</div>
            : <>
              {[["fw_out","FW Outside"],["fw_in","FW Inside"],["mw_out","MW Outside"],["mw_in","MW Inside"],["lw_out","LW Outside"],["lw_in","LW Lower"]].map(([g,lbl])=>(
                <div key={g as string} style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                  <div style={{width:96,fontSize:10,color:T.dim,fontWeight:700}}>{lbl}</div>
                  {[0,1,2,3,4].map(i=>(
                    <input key={i} type="number" step="0.1" min="0" value={editBeam.__v2s[g as string]?.[i]??""}
                      onChange={e=>setEditBeam((p:any)=>{ const n={...p.__v2s}; const arr=[...(n[g as string]||["","","","",""])]; arr[i]=e.target.value; n[g as string]=arr; return {...p,__v2s:n}; })}
                      style={{width:64,background:T.surf,border:`1px solid ${T.border}`,color:T.text,padding:"5px 6px",borderRadius:5,fontSize:11,fontFamily:"monospace",textAlign:"center"}}/>
                  ))}
                </div>
              ))}
              <div style={{fontSize:10,color:T.dim,marginTop:4}}>Saving recalculates the six section averages and the Total Average (sum of 30 ÷ 30).</div>
            </>}
        </div>

        <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:18}}>
          <button onClick={()=>setEditBeam(null)} style={{padding:"8px 16px",borderRadius:6,background:T.bg,color:T.muted,border:`1px solid ${T.border}`,fontSize:12,fontWeight:700,cursor:"pointer"}}>Cancel</button>
          <button onClick={()=>{
            const id=txn(editBeam);
            const orig=beams.find((x:any)=>txn(x)===id)||{};
            const patch:any={...editBeam};
            const v2s=patch.__v2s; delete patch.__v2s;

            // ── Validation ─────────────────────────────────────
            if(!String(patch.beam_no||"").trim()){ alert("Beam No is required."); return; }
            // Beam numbers are re-used every production day (1..N per day), so a
            // global uniqueness rule is wrong. Only warn when another record with
            // the same number was loaded on the SAME calendar day.
            const sameDayKey=String(patch.loaded_at||orig.loaded_at||"").slice(0,10);
            const clash=beams.some((x:any)=>txn(x)!==id
              && String(x.beam_no||"").trim().toUpperCase()===String(patch.beam_no).trim().toUpperCase()
              && sameDayKey && String(x.loaded_at||"").slice(0,10)===sameDayKey);
            if(clash && !confirm(`Another beam loaded on ${sameDayKey} already uses Beam No ${patch.beam_no}. Save anyway?`)) return;

            if(patch.section!=null && String(patch.section).trim()!==""){
              const terr=checkThickness(patch.section,fieldConfig);
              if(terr){ alert(terr); return; }
            }
            if(patch.coating_required!=null && String(patch.coating_required)!==""){
              const allowed=filterCoatings([65,87,130]).map(Number);
              if(!allowed.includes(Number(patch.coating_required))){
                alert(`Specific Micron must be one of ${allowed.join(" / ")} μm.`); return;
              }
            }
            for(const [k,lbl] of [["length_mm","Length (mm)"],["total_qty","Quantity"],["total_weight","Weight (MT)"],["bath_temperature","Zinc Bath Temperature"],["immersion_duration","Immersion Time"],["reaction_duration","Reaction Time"],["withdrawal_duration","Withdrawal Time"]] as any){
              const v=patch[k];
              if(v===""||v==null) continue;
              const n=Number(v);
              if(!Number.isFinite(n)||n<0){ alert(`${lbl} must be a valid non-negative number.`); return; }
            }
            if(v2s){
              const chk=validateV2Strings(v2s);
              if(!chk.ok){ alert(`Coating readings — ${chk.reason}`); return; }
              const capMax=fieldConfig?.cojReadingMaxEnabled!==false?Number(fieldConfig?.cojReadingMax)||500:Infinity;
              const over=v2OverCap(v2s,capMax);
              if(over){ alert(`Coating reading exceeds the ${capMax} μm cap (${over.group} #${over.idx+1}).`); return; }
              const v2=stringsToV2(v2s);
              patch.elcometer_v2=v2;
              patch.elcometer=null;
              patch.avg_reading=Number((v2TotalAverage(v2)||0).toFixed(2));
            }
            // Total cycle time always derived from the three phase durations.
            const totalCycle=(Number(patch.immersion_duration)||0)+(Number(patch.reaction_duration)||0)+(Number(patch.withdrawal_duration)||0);
            if(totalCycle>0) patch.total_cycle_secs=totalCycle;

            // Build a short diff summary for the audit log
            const diff=Object.keys(patch).filter(k=>JSON.stringify(orig[k])!==JSON.stringify(patch[k]))
              .map(k=>`${k}:${orig[k]??"∅"}→${typeof patch[k]==="object"?"(updated)":patch[k]??"∅"}`).slice(0,8).join(", ");

            // Surface the real database result instead of failing silently.
            setBeamBusy(true);
            let settled=false;
            const finish=(ok:boolean,msg?:string)=>{
              if(settled) return; settled=true;
              window.removeEventListener("hdp:sync-error",onErr as any);
              window.removeEventListener("hdp:sync-status",onOk as any);
              clearTimeout(timer);
              setBeamBusy(false);
              if(ok){ setEditBeam(null); alert(`✓ Beam ${patch.beam_no} updated successfully.`); }
              else alert(`Update failed — ${msg||"unknown error"}`);
            };
            const onErr=(e:any)=>{ const d=e?.detail||{}; if(d.table&&String(d.table).includes("beam")===false) return; finish(false,d.rawMessage||d.message); };
            const onOk=(e:any)=>{ const d=e?.detail||{}; if(d.op==="update"&&Array.isArray(d.ids)&&d.ids.map(String).includes(String(id))) finish(true); };
            window.addEventListener("hdp:sync-error",onErr as any);
            window.addEventListener("hdp:sync-status",onOk as any);
            const timer=setTimeout(()=>finish(true),8000);

            setBeams((prev:any)=>prev.map((x:any)=>txn(x)===id?{...x,...patch,_admin_corrected_at:nowISO(),_admin_corrected_by:me.full_name}:x));
            addAudit(me.id,me.full_name,"ADMIN_EDIT_BEAM","admin",`Edited beam ${patch.beam_no||orig.beam_no}: ${diff||"no field changes"}`);
          }} disabled={beamBusy} style={{padding:"8px 16px",borderRadius:6,background:beamBusy?T.border:T.amber,color:"#000",border:"none",fontSize:12,fontWeight:800,cursor:beamBusy?"not-allowed":"pointer",opacity:beamBusy?.6:1}}>{beamBusy?"Saving…":"💾 Save Corrections"}</button>
        </div>


      </div>
    </div>}

    {/* ── AUDIT LOG ─────────────────────────────────────────── */}
    {panel==="security"&&<SecurityAdmin T={T}/>}

    {panel==="audit"&&<Card T={T}>
      <SecHead T={T} title="Audit Log"
        sub={`${auditLog.length} entries total — retention: ${Number(fieldConfig?.auditRetentionDays)>0?Number(fieldConfig?.auditRetentionDays)+" days (auto-purge)":"Never"}`}
        right={<div style={{display:"flex",gap:8,alignItems:"center"}}>
          {Number(fieldConfig?.auditRetentionDays)>0 && (
            <button onClick={()=>{
              const days=Number(fieldConfig?.auditRetentionDays);
              if(confirm(`Delete every audit entry older than ${days} day(s)? This cannot be undone.`)) purgeOldAudit(false);
            }} title={`Run retention purge (>${Number(fieldConfig?.auditRetentionDays)} days)`}
              style={{padding:"6px 12px",borderRadius:6,background:"#2A1408",color:"#FB923C",border:"1px solid #FB923C60",fontSize:11,fontWeight:700,cursor:"pointer"}}>
              🧹 Purge &gt;{Number(fieldConfig?.auditRetentionDays)}d
            </button>
          )}
          {Object.values(auditSel).filter(Boolean).length>0 && (
            <button onClick={()=>{
              const ids=Object.keys(auditSel).filter(k=>auditSel[k]);
              if(confirm(`Permanently delete ${ids.length} audit entry(ies)?`)){
                deleteAuditEntries(ids); setAuditSel({});
              }
            }} style={{padding:"6px 12px",borderRadius:6,background:"#2A0808",color:"#F87171",border:"1px solid #F8717160",fontSize:11,fontWeight:700,cursor:"pointer"}}>
              🗑 Delete {Object.values(auditSel).filter(Boolean).length}
            </button>
          )}
          <DInput dark value={asearch} onChange={e=>sa(e.target.value)} placeholder="Search audit log..." style={{width:240}}/>
        </div>}/>
      <Table T={T} headers={[<input key="hal" type="checkbox" checked={fAudit.length>0 && fAudit.every((a:any)=>auditSel[a.id])}
        onChange={e=>{ const ck=e.target.checked; const n:any={...auditSel}; fAudit.forEach((a:any)=>{ if(ck) n[a.id]=true; else delete n[a.id]; }); setAuditSel(n); }}/>,"#","Timestamp","User","Action","Module","Details","Admin"]}
        rows={fAudit.map((a:any,i:number)=>[
          <input key={a.id+"_as"} type="checkbox" checked={!!auditSel[a.id]} onChange={e=>setAuditSel(p=>({...p,[a.id]:e.target.checked}))}/>,
          mn(fAudit.length-i,T.dim),
          <span style={{fontFamily:"monospace",fontSize:11,color:T.muted}}>{fmtDT(a.ts||a.timestamp)}</span>,
          <strong style={{color:T.text,fontSize:12}}>{a.userName}</strong>,
          <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"#33434F",color:T.amber,letterSpacing:".05em"}}>{a.action}</span>,
          <span style={{color:T.muted,fontSize:11}}>{a.module}</span>,
          <span style={{fontSize:11,color:T.text}}>{a.details}</span>,
          <button onClick={()=>{ if(confirm("Delete this audit entry?")) deleteAuditEntries([a.id]); }} style={{padding:"4px 10px",borderRadius:5,background:"#2A0808",color:"#F87171",border:"1px solid #F8717160",fontSize:10,fontWeight:700,cursor:"pointer"}}>🗑</button>,
        ])}/>
    </Card>}

    {/* ── DATA RESET ────────────────────────────────────────── */}
    {panel==="appearance"&&<div>
      <div style={{padding:"12px 16px",background:"#0A1520",border:`1px solid ${T.border}`,borderRadius:8,marginBottom:14,fontSize:12,color:T.muted}}>
        🎨 <strong style={{color:T.text}}>Application Theme</strong> — Global setting. Affects every user immediately. Pick <strong style={{color:T.amber}}>Industrial</strong> for the new professional look, or revert to a previous version below.
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12}}>
        {[
          ["industrial","Industrial (New)","Heavy-industry graphite with hazard-amber accents — current production look","#0B0E12","#F59E0B"],
          ["dark-gold","Classic Dark Gold","Older default — navy with gold accents","#0F1720","#3D7EA6"],
          ["light","Light","Bright daylight scheme","#EFF2F7","#3D7EA6"],
          ["ocean-blue","Ocean Blue","Deep navy with cyan accents","#061018","#22D3EE"],
          ["slate","Slate","Cool neutral slate for long sessions","#0C0F14","#94A3B8"],
        ].map(([id,name,desc,bg,accent])=>{
          const active=themeId===id;
          return <button key={id} onClick={()=>{ setThemeId(id); addAudit(me.id,me.full_name,"THEME_CHANGE","admin","Switched theme to "+name); }} style={{textAlign:"left",cursor:"pointer",padding:14,borderRadius:10,background:bg,border:`2px solid ${active?accent:T.border}`,boxShadow:active?`0 0 0 3px ${accent}30`:"none"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <div style={{width:32,height:32,borderRadius:8,background:accent,boxShadow:`0 0 12px ${accent}80`}}/>
              <div>
                <div style={{fontSize:13,fontWeight:800,color:bg==="#EFF2F7"?"#0F1E38":"#C9D6DF"}}>{name}</div>
                <div style={{fontSize:10,color:bg==="#EFF2F7"?"#6B7EA8":"#8DA0AD"}}>{desc}</div>
              </div>
              {active&&<span style={{marginLeft:"auto",fontSize:10,fontWeight:700,color:accent}}>● ACTIVE</span>}
            </div>
            <div style={{display:"flex",gap:4}}>
              {[bg,accent,"#4ADE80","#F87171","#A78BFA"].map((c,i)=><div key={i} style={{flex:1,height:18,borderRadius:4,background:c,border:`1px solid ${T.border}`}}/>)}
            </div>
          </button>;
        })}
      </div>
    </div>}



    {panel==="reset"&&<div>
      <Card T={T} style={{padding:24,marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:700,color:T.redT,marginBottom:8}}>🗑 Production Data Reset</div>
        <div style={{fontSize:12,color:T.muted,marginBottom:20,lineHeight:1.8}}>
          Permanently deletes <strong style={{color:T.redT}}>ALL production data</strong> — every beam, loading record,
          dipping timestamp and QC inspection. The system will start completely fresh with zero records.<br/>
          <strong style={{color:T.redT}}>⚠ This is irreversible. Pre-seeded demo data is also deleted.</strong><br/>
          User accounts, email config and audit log entry for this reset are always preserved.
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:20}}>
          <div style={{background:"#0E1E3A",border:"1px solid #1A3A6E",borderRadius:8,padding:"12px 16px",textAlign:"center"}}>
            <div style={{fontSize:28,fontWeight:800,color:T.blueT,fontFamily:"monospace"}}>{beams.length}</div>
            <div style={{fontSize:11,color:T.muted,marginTop:4}}>Beam Records</div>
            <div style={{fontSize:10,color:T.redT,marginTop:2}}>Will be reset</div>
          </div>
          <div style={{background:"#2A1600",border:"1px solid #4A3000",borderRadius:8,padding:"12px 16px",textAlign:"center"}}>
            <div style={{fontSize:28,fontWeight:800,color:"#FB923C",fontFamily:"monospace"}}>{beams.filter(b=>b.dipped_at).length}</div>
            <div style={{fontSize:11,color:T.muted,marginTop:4}}>Dipping Records</div>
            <div style={{fontSize:10,color:T.redT,marginTop:2}}>Will be reset</div>
          </div>
          <div style={{background:"#0A2218",border:"1px solid #143820",borderRadius:8,padding:"12px 16px",textAlign:"center"}}>
            <div style={{fontSize:28,fontWeight:800,color:T.greenT,fontFamily:"monospace"}}>{auditLog.length}</div>
            <div style={{fontSize:11,color:T.muted,marginTop:4}}>Audit Entries</div>
            <div style={{fontSize:10,color:T.greenT,marginTop:2}}>Always preserved</div>
          </div>
        </div>
        <Btn variant="red" onClick={()=>{setRM(true);setRPI("");setRMsg(null);setRC(false);}}>
          🗑 Delete ALL Production Data — Admin Password Required
        </Btn>
      </Card>

      <Card T={T} style={{padding:16}}>
        <div style={{fontSize:12,color:T.muted,lineHeight:1.9}}>
          <div style={{marginBottom:6,color:T.text,fontWeight:700}}>Always preserved (never deleted):</div>
          <div>✅ User accounts, roles and passwords</div>
          <div>✅ Email recipient configuration</div>
          <div>✅ One audit entry recording the reset event</div>
          <div style={{marginTop:10,marginBottom:6,color:T.text,fontWeight:700}}>Permanently deleted on reset:</div>
          <div style={{color:T.redT}}>✕ All beam registration records (including seed data)</div>
          <div style={{color:T.redT}}>✕ All dipping timestamp records</div>
          <div style={{color:T.redT}}>✕ All QC inspection records</div>
          <div style={{color:T.redT}}>✕ All previous audit log entries</div>
          <div style={{marginTop:10,padding:"8px 12px",background:"#1A0808",border:"1px solid #441010",borderRadius:6,color:T.redT,fontSize:11}}>
            ⚠ After reset the system starts completely empty. No demo or seed data is restored.
          </div>
        </div>
      </Card>
    </div>}

    {/* ── RESET CONFIRM MODAL ───────────────────────────────── */}
    {resetModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.82)",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}}>
      <div style={{background:T.surf,border:`2px solid ${T.red}`,borderRadius:12,padding:30,width:460,boxShadow:`0 0 40px rgba(220,38,38,.3)`}}>
        {resetConfirm
          ?<div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:40,marginBottom:14}}>✅</div>
            <div style={{color:T.greenT,fontWeight:700,fontSize:17}}>All Production Data Deleted</div>
            <div style={{color:T.muted,fontSize:12,marginTop:8}}>System is now completely empty. Ready for live production data.</div>
          </div>
          :<>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
              <span style={{fontSize:22}}>⚠</span>
              <div style={{fontSize:15,fontWeight:700,color:T.redT}}>Confirm Production Data Reset</div>
            </div>
            <div style={{fontSize:12,color:T.muted,marginBottom:20,lineHeight:1.7,padding:"12px 14px",
              background:"#220808",border:"1px solid #441010",borderRadius:8}}>
              <strong style={{color:T.redT}}>ALL production data will be permanently deleted</strong> — every beam,
              dipping record, QC record and audit history. The system will start completely empty.
              Pre-seeded demo data is also erased. This cannot be undone.
            </div>
            <Field label="Enter Your Admin Password to Confirm" required T={T} style={{marginBottom:14}}>
              <DInput dark type="password" value={resetPwdInput}
                onChange={e=>{setRPI(e.target.value);setRMsg(null);}}
                placeholder="Admin password..."
                onKeyDown={e=>e.key==="Enter"&&attemptReset()}
                style={{border:`1px solid ${resetMsg?T.red:T.border}`,fontSize:14}}/>
            </Field>
            {resetMsg&&<div style={{fontSize:12,color:T.redT,marginBottom:12,
              padding:"8px 12px",background:"#220808",borderRadius:6}}>{resetMsg}</div>}
            <div style={{display:"flex",gap:10}}>
              <Btn variant="red" onClick={attemptReset} style={{flex:1,padding:"10px 0"}}>
                🗑 Confirm Reset
              </Btn>
              <Btn variant="ghost" onClick={()=>{setRM(false);setRPI("");setRMsg(null);}} style={{flex:1,padding:"10px 0"}}>
                Cancel — Keep Data
              </Btn>
            </div>
          </>}
      </div>
    </div>}
  </div>;
}
// ══════════════════════════════════════════════════════════════
// ROOT
// ══════════════════════════════════════════════════════════════
function usePersisted(key, initial){
  const [v, sv] = useState(initial);
  const hydrated = useRef(false);
  useEffect(() => {
    try {
      const r = localStorage.getItem("hdp:" + key);
      if (r != null) sv(JSON.parse(r));
    } catch {}
    hydrated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    try { localStorage.setItem("hdp:" + key, JSON.stringify(v)); } catch {}
  }, [key, v]);
  return [v, sv];
}

import { supabase as _sb } from "@/integrations/supabase/client";
import { useBeams as _useBeams, useAudit as _useAudit, useUsers as _useUsers, useCloudSetting as _useCloudSetting, useMicronRules as _useMicronRules, setCurrentUid as _setCurrentUid } from "@/lib/cloud-sync";
import _AuthGate from "@/components/AuthGate";
import { createUserAccount as _createUser, deleteUserAccount as _deleteUser, resetUserPassword as _resetPwd, setUserActive as _setActive } from "@/lib/admin.functions";
import { sendBeamReport as _sendBeamReport } from "@/lib/email-report.functions";
import { adminDeleteBeams as _adminDeleteBeams, adminDeleteAuditEntries as _adminDeleteAuditEntries, adminResetBeams as _adminResetBeams, adminPurgeOldAudit as _adminPurgeOldAudit } from "@/lib/admin-destructive.functions";
import MaterialOfferTab from "@/features/hdp/MaterialOfferTab";
import { useResumeLifecycle as _useResumeLifecycle } from "@/lib/resume-lifecycle";
import { startQueueDrainer as _startQueueDrainer } from "@/lib/pending-queue";


function AppInner({ sessionId }: { sessionId: string }){
  _setCurrentUid(sessionId);
  useEffect(()=>{ console.info("[boot] HdpApp mounted"); },[]);
  _useResumeLifecycle();
  useEffect(()=>{ const stop = _startQueueDrainer(); return stop; },[]);
  // Surface settings write failures so the user knows a toggle didn't stick.
  useEffect(()=>{
    if (typeof window === "undefined") return;
    const onErr = (ev: any) => {
      const d = ev?.detail || {};
      if (d.permanent) {
        toast.error(`Setting "${d.key}" not saved: ${d.message || "permission denied"}`);
      } else {
        toast.error(`Setting "${d.key}" queued — will retry when connection returns`);
      }
    };
    window.addEventListener("hdp:settings-write-error", onErr as any);
    return () => window.removeEventListener("hdp:settings-write-error", onErr as any);
  },[]);
  const [users,,usersLoaded] = _useUsers(true);
  const [beams,sb,beamsLoaded] = _useBeams(true);
  const [audit,sa] = _useAudit(true);
  
  const [micronRules,setMicronRules] = _useMicronRules(true);
  const mlrStore = useMlrModel();
  const [aiModel,setAiModel]=_useCloudSetting<any>("aiModel","mlr");
  const aiModels = useMemo(()=>normalizeAiSelection(aiModel),[aiModel]);
  const [aiDashboardEnabled,setAiDashboardEnabled]=_useCloudSetting<any>("aiDashboardEnabled",false);
  const [aiTrainHistory,setAiTrainHistory]=_useCloudSetting<any>("aiTrainingHistory",[]);
  const [me,sm]=useState<any>(null);
  const [profileWaitExpired,setProfileWaitExpired]=useState(false);
  const [tab,st]=useState("dashboard");
  const [themeId,setThemeId]=_useCloudSetting<any>("uiTheme", "industrial");
  const dark = (THEME_PRESETS[themeId]||THEME_PRESETS["industrial"]).dark;
  const sd = (_:any)=> setThemeId((cur:any)=> ((THEME_PRESETS[cur]||THEME_PRESETS["industrial"]).dark ? "light" : "industrial"));
  const [clock,sc]=useState(new Date());
  const [notif,sn]=useState<any>(null);
  const [moduleAccess,setMA]=_useCloudSetting<any>("moduleAccess", {});
  const [feature65um,setFeature65um]=_useCloudSetting<any>("feature65um", { enabled: true });
  useEffect(()=>{ setShow65(feature65um?.enabled !== false); },[feature65um?.enabled]);
  const [sendInviteEmail,setSendInviteEmail]=usePersisted("sendInviteEmail", false);
  const [emailRecs,setEmailRecs]=_useCloudSetting<any>("emailRecs", {
    loading:[],
    dipping:[],
    qc:[],
    hourly:[],
    shiftwise:[],
  });

  const [qcRanges,setQcRanges]=_useCloudSetting<any>("qcRanges",{
    65:  { min: 65,  ok_max: 80  },
    87:  { min: 87,  ok_max: 110 },
    130: { min: 130, ok_max: 155 },
  });
  const [fieldConfig,setFieldConfig]=_useCloudSetting<any>("fieldConfig",{
    routeCardEnabled: true,
    qtyEnabled: true,
    thicknessLabel: "Thickness",
    restrictDuplicateBeam: true,
    maxBeamWeightMT: 3.0,
    maxThicknessMm: 40,
    auditRetentionDays: 90, // 0 = never purge
    qcBestMatchEnabled: true, // legacy master toggle (kept in sync with cojBestMatch.enabled)
    cojBestMatch: COJ_BM_DEFAULTS,
    sixSigmaEnabled: true, // Dashboard Six Sigma capability panel
    cojReadingMaxEnabled: true, // CoJ per-reading cap enforced at entry
    cojReadingMax: 500,         // Max μm allowed per Elcometer point
  });
  const [operators,setOperators]=_useCloudSetting<any>("operators",[
    {id:1,name:"Suresh Babu",active:true},
    {id:2,name:"Ravi Kumar",active:true},
  ]);
  const [shiftSupervisors,setShiftSupervisors]=_useCloudSetting<any>("shiftSupervisors",[
    {id:1,name:"Suresh Babu",active:true},
    {id:2,name:"Ravi Kumar",active:true},
  ]);
  const [dippingConfig,setDippingConfig]=_useCloudSetting<any>("dippingConfig",{
    engineEnabled: true,
    showThickness: true,
    showWeight: true,
    showTemperature: true,
    showQty: true,
    showLoadType: true,
    showLength: true,
    showMaterialType: true,
    showSurfaceCondition: true,
    // Tolerance windows (±) — admin-editable
    weightTol: 0.2,   // MT
    tempTol:   2,     // °C
    lengthTol: 500,   // mm
    qtyTol:    5,     // pcs
    // Back-compat (still persisted for migration)
    weightStep: 0.1, weightMin: 0.1, weightMax: 3.0,
    tempStep: 2, tempMin: 440, tempMax: 465,
    qtyStep: 10, qtyMin: 10, qtyMax: 20,
    thicknessTolerance: 0.5,
    topN: 3,
    allowPostEdit: false, // admin-controlled: allow editing dipping timings after save
    allowQCEdit: false,   // admin-controlled: allow editing Coating on Job after save
    manualDurationEntry: false, // admin-controlled: enter MM:SS durations manually instead of live timer
    regressionEnabled: true,    // admin-controlled: use regression model when no exact match (last 10 days)
  });
  useEffect(()=>{ setQcRangesGlobal(qcRanges as any); },[qcRanges]);

  const T=useTheme(themeId);
  useEffect(()=>{const t=setInterval(()=>sc(new Date()),1000);return()=>clearInterval(t);},[]);

  // Resolve me from session + users list
  useEffect(()=>{
    const u=users.find((x:any)=>x.id===sessionId);
    if(u) sm(u);
  },[sessionId,users]);

  useEffect(()=>{
    if(me) return;
    setProfileWaitExpired(false);
    const t=setTimeout(()=>setProfileWaitExpired(true),7000);
    return()=>clearTimeout(t);
  },[sessionId,me]);

  useEffect(()=>{
    if(usersLoaded && users.length>0 && !users.find((x:any)=>x.id===sessionId)) {
      console.warn("[boot] profile not found for active session");
    }
  },[sessionId,users,usersLoaded]);

  // Surface cloud sync failures (e.g. RLS-rejected Dipping/Coating writes) to the operator.
  useEffect(()=>{
    if(typeof window==="undefined") return;
    const onErr=(e:any)=>{
      const d=e?.detail||{};
      const msg=`⚠ Save failed (${d.table||"sync"} ${d.op||""}): ${d.message||"unknown error"}`;
      sn({beam:"SYNC", status:"DIPPING", color:"#F87171", label:msg});
      setTimeout(()=>sn(null),8000);
    };
    window.addEventListener("hdp:sync-error",onErr as any);
    return ()=>window.removeEventListener("hdp:sync-error",onErr as any);
  },[]);


  function addAudit(uid:any,uname:string,action:string,module:string,details:string){
    // Only admin & manager actions are recorded in the audit log.
    const actorRole = (me?.role||"").toLowerCase();
    if (actorRole !== "admin" && actorRole !== "manager") return;
    const item={id:crypto.randomUUID(),userId:uid,userName:uname,action,module,details,timestamp:nowISO()} as any;
    sa((prev:any)=>[item,...prev]);
  }

  function setBeamsNotif(updater:any){
    sb((prev:any)=>{
      const next=typeof updater==="function"?updater(prev):updater;
      const changed=next.find((b:any)=>{const o=prev.find((p:any)=>(p.transaction_id||p.beam_no)===(b.transaction_id||b.beam_no));return o&&o.status!==b.status;});
      if(changed){const ss=ST[changed.status as keyof typeof ST];sn({beam:changed.beam_no,status:changed.status,color:ss.color,label:ss.label});setTimeout(()=>sn(null),5000);}
      return next;
    });
  }

  // Admin-only: individual beam Enable/Disable. Operational control only —
  // the beam keeps its status, data, timestamps and stays visible everywhere.
  function toggleBeamEnabled(b:any){
    if(!b) return;
    if(me?.role!=="admin"){ alert("Admin only"); return; }
    const id=b.transaction_id||b.beam_no;
    const nextEnabled=!beamEnabled(b);
    const nowIso=new Date().toISOString();
    sb((prev:any[])=>prev.map((x:any)=>((x.transaction_id||x.beam_no)===id
      ? {...x,
         is_enabled:nextEnabled,
         disabled:!nextEnabled,
         ...(nextEnabled?{enabled_at:nowIso,enabled_by:me.id}:{disabled_at:nowIso,disabled_by:me.id})}
      : x)));
    addAudit(me.id,me.full_name,nextEnabled?"BEAM_ENABLED":"BEAM_DISABLED","tracker",
      `${nextEnabled?"Enabled":"Disabled"} beam ${b.beam_no} (status ${b.status})`);
  }


  // Admin-only: hard-delete beams + audit entries (with audit trail)
  // Authoritative admin check enforced by server fns; client check is UX only.
  function deleteBeams(txnIds:string[]){
    if(!txnIds||!txnIds.length) return;
    if(me?.role!=="admin"){ alert("Admin only"); return; }
    if((deleteBeams as any)._busy){ return; }        // block duplicate requests
    (deleteBeams as any)._busy=true;
    const set=new Set(txnIds);
    const labels=beams.filter((b:any)=>set.has(b.transaction_id||b.beam_no)).map((b:any)=>b.beam_no);
    _adminDeleteBeams({data:{transaction_ids:txnIds}})
      .then(()=>{
        sb((prev:any)=>prev.filter((b:any)=>!set.has(b.transaction_id||b.beam_no)));
        addAudit(me.id,me.full_name,"DELETE_BEAMS","admin",`Deleted ${txnIds.length} beam(s): ${labels.slice(0,10).join(", ")}${labels.length>10?` …(+${labels.length-10})`:""}`);
        alert(`✓ Deleted ${txnIds.length} beam record(s).`);
      })
      .catch((e:any)=>alert("Delete failed: "+(e?.message||e)))
      .finally(()=>{ (deleteBeams as any)._busy=false; });
  }

  function deleteAuditEntries(ids:string[]){
    if(!ids||!ids.length) return;
    if(me?.role!=="admin"){ alert("Admin only"); return; }
    _adminDeleteAuditEntries({data:{ids}})
      .then(()=>{
        sa((prev:any)=>prev.filter((a:any)=>!ids.includes(a.id)));
        addAudit(me.id,me.full_name,"DELETE_AUDIT","admin",`Deleted ${ids.length} audit entry(ies)`);
      })
      .catch((e:any)=>alert("Delete failed: "+(e?.message||e)));
  }

  // Manual + automatic audit retention (admin only).
  function purgeOldAudit(silent=false){
    const days = Number(fieldConfig?.auditRetentionDays);
    if(!days || days<=0) { if(!silent) alert("Audit retention is disabled (Never). Enable it in Admin → Field Config."); return; }
    if(me?.role!=="admin"){ if(!silent) alert("Admin only"); return; }
    _adminPurgeOldAudit({data:{daysToKeep:days}})
      .then((res:any)=>{
        const n=res?.deleted??0;
        if(n>0){
          sa((prev:any)=>prev.filter((a:any)=>new Date(a.timestamp||a.ts||0).getTime() >= Date.now()-days*86400000));
          addAudit(me.id,me.full_name,"AUDIT_PURGE","admin",`Auto-purged ${n} audit entr${n===1?"y":"ies"} older than ${days} day(s)`);
        }
        if(!silent) alert(`✓ Purged ${n} audit entr${n===1?"y":"ies"} older than ${days} days.`);
      })
      .catch((e:any)=>{ if(!silent) alert("Purge failed: "+(e?.message||e)); else console.warn("[audit-purge]",e); });
  }

  // Auto-run once per 24h when admin loads the app
  useEffect(()=>{
    if(me?.role!=="admin") return;
    const days = Number(fieldConfig?.auditRetentionDays);
    if(!days || days<=0) return;
    try{
      const key="hdp:auditPurgedAt";
      const last=Number(localStorage.getItem(key)||0);
      if(Date.now()-last < 86400000) return;
      localStorage.setItem(key, String(Date.now()));
      purgeOldAudit(true);
    }catch{}
  },[me?.role, fieldConfig?.auditRetentionDays]);



  // Cloud-backed setUsers: intercepts add/toggle/reset/delete and calls server fns
  const setUsersCloud=(updater:any)=>{
    const prev=users; const next=typeof updater==="function"?updater(prev):updater;
    const prevById=new Map(prev.map((u:any)=>[u.id,u]));
    const nextById=new Map(next.map((u:any)=>[u.id,u]));
    // Adds: items in next not in prev (id will be a Date.now() number from AdminTab)
    for(const [k,v] of nextById){
      if(!prevById.has(k) && (v as any).email){
        const redirect = typeof window!=="undefined" ? window.location.origin + "/reset-password" : undefined;
        const payload:any={email:(v as any).email,full_name:(v as any).full_name,username:(v as any).username,role:(v as any).role,send_invite:!!sendInviteEmail};
        if(sendInviteEmail){ payload.redirect_to=redirect; }
        else { payload.password=(v as any).password; }
        _createUser({data:payload})
          .then(()=>alert(sendInviteEmail
            ? "✓ Invite email sent to "+(v as any).email+". They will set their password via the link."
            : "✓ User "+(v as any).username+" created. They can log in immediately with the password you set."))
          .catch((e:any)=>alert("Create user failed: "+e.message));
      }
    }
    // Deletes
    for(const k of prevById.keys()) if(!nextById.has(k) && typeof k==="string") _deleteUser({data:{user_id:k as string}}).catch((e:any)=>alert(e.message));
    // Updates: active toggle / password reset
    for(const [k,v] of nextById){
      const o=prevById.get(k) as any; if(!o||typeof k!=="string") continue;
      if(o.active!==(v as any).active) _setActive({data:{user_id:k as string,active:(v as any).active}}).catch((e:any)=>alert(e.message));
      const pendingPwd=(v as any)._pendingPwd;
      if(pendingPwd && typeof pendingPwd==="string" && o._pendingPwd!==pendingPwd){
        _resetPwd({data:{user_id:k as string,new_password:pendingPwd}})
          .then(()=>alert("✓ Password reset for "+((v as any).username||(v as any).email||"user")))
          .catch((e:any)=>alert("Reset password failed: "+e.message));
      }
    }
  };

  const ALL_TABS=[
    {id:"dashboard", label:"📊 Dashboard",    baseRoles:["admin","supervisor","shift_supervisor","manager","loading_supervisor","dipping_supervisor","qc_inspector"]},
    {id:"tracker",   label:"🔍 Beam Tracker", baseRoles:["admin","supervisor","shift_supervisor","manager","loading_supervisor","dipping_supervisor"]},
    {id:"loading",   label:"📦 Loading",       baseRoles:["admin","supervisor","shift_supervisor","manager","loading_supervisor"]},
    {id:"dipping",   label:"🛢 Dipping",       baseRoles:["admin","supervisor","shift_supervisor","manager","dipping_supervisor"]},
    {id:"qc",        label:"🎯 Coating on Job",  baseRoles:["admin","supervisor","manager","dipping_supervisor","qc_inspector"]},
    {id:"material_offer", label:"🧾 Material Offer to QC", baseRoles:["admin","supervisor","shift_supervisor","manager","dipping_supervisor","qc_inspector"]},
    {id:"reports",   label:"📋 Reports",       baseRoles:["admin","supervisor","manager"]},
    {id:"audit",     label:"📜 Audit Log",     baseRoles:["admin","manager"]},
    {id:"admin",     label:"⚙ Admin",          baseRoles:["admin"]},
  ];

  function permsFor(u:any){
    if(!u||u.role==="admin") return { tabs:{}, readOnly:false, exportOnly:false, canExport:true, canSendReportEmail:true };
    const o=(moduleAccess as any)[String(u.id)]||{};
    const def=roleDefaultPerms(u.role);
    if(o.tabs===undefined && Object.keys(o).length===0){
      return def;
    }
    if(o.tabs===undefined){
      const legacy={...o}; delete legacy.tabs; delete legacy.readOnly; delete legacy.exportOnly; delete legacy.canExport; delete legacy.canSendReportEmail;
      return { tabs:{...def.tabs, ...legacy}, readOnly:!!o.readOnly||def.readOnly, exportOnly:!!o.exportOnly, canExport:o.canExport!==false, canSendReportEmail:o.canSendReportEmail!==undefined?!!o.canSendReportEmail:def.canSendReportEmail };
    }
    return { tabs:{...def.tabs, ...(o.tabs||{})}, readOnly:o.readOnly!==undefined?!!o.readOnly:def.readOnly, exportOnly:!!o.exportOnly, canExport:o.canExport!==false, canSendReportEmail:o.canSendReportEmail!==undefined?!!o.canSendReportEmail:def.canSendReportEmail };
  }
  function tabsForUser(u:any){
    if(!u) return [];
    if(u.role==="admin") return ALL_TABS;
    const p=permsFor(u);
    return ALL_TABS.filter(t=>{
      if(!t.baseRoles.includes(u.role)) return false;
      if(t.id==="dashboard") return p.tabs.dashboard===true;
      return p.tabs[t.id]!==false;
    });
  }

  const TABS=me?tabsForUser(me):[];
  const activeTab = TABS.some((t:any)=>t.id===tab) ? tab : (TABS[0]?.id || "");
  const myPerms = permsFor(me);
  // Admin-configured Module Access (or role defaults for unconfigured users)
  // fully drives read-only state — no additional role-based override.
  const effReadOnly = myPerms.readOnly || myPerms.exportOnly;
  const RD:any={admin:{label:"Admin",c:T.amber},supervisor:{label:"Supervisor",c:"#22D3EE"},
    shift_supervisor:{label:"Shift Supervisor",c:"#34D399"},
    manager:{label:"Manager",c:"#F472B6"},
    loading_supervisor:{label:"Loading Supervisor",c:T.blueT},
    dipping_supervisor:{label:"Dipping Supervisor",c:T.greenT},
    qc_inspector:{label:"Coating on Job",c:"#A78BFA"}};
  const qcPend=beams.filter((b:any)=>b.status==="QC_PENDING").length;

  useEffect(()=>{
    if(activeTab && activeTab!==tab) st(activeTab);
  },[activeTab,tab]);

  if(!me){
    const loadedNoProfile = usersLoaded && users.length>0;
    const noProfileForMe = usersLoaded && !users.find((x:any)=>x.id===sessionId);
    return <div style={{minHeight:"100vh",background:T.bg,color:T.muted,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,fontFamily:"system-ui",padding:24,textAlign:"center"}}>
      {noProfileForMe ? <>
        <div style={{fontSize:15,color:T.text,fontWeight:700}}>Profile not found</div>
        <div style={{fontSize:13,maxWidth:420,lineHeight:1.5}}>Your account exists but no profile is linked to it. Please contact your administrator.</div>
      </> : profileWaitExpired ? <>
        <div style={{fontSize:15,color:T.text,fontWeight:700}}>Still loading your profile</div>
        <div style={{fontSize:13,maxWidth:420,lineHeight:1.5}}>The app started, but profile data is taking longer than expected. You can reload or sign in again.</div>
      </> : <div>Loading profile…</div>}
      <button onClick={async()=>{ try{ await _sb.auth.signOut(); }catch{} try{ localStorage.removeItem("hdp.session_id"); }catch{} location.reload(); }} style={{marginTop:8,padding:"8px 16px",fontSize:12,fontWeight:700,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,cursor:"pointer",fontFamily:"inherit"}}>Sign out</button>
    </div>;
  }
  if(TABS.length===0){
    return <div style={{minHeight:"100vh",background:T.bg,color:T.muted,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,fontFamily:"system-ui",padding:24,textAlign:"center"}}>
      <div style={{fontSize:15,color:T.text,fontWeight:700}}>No modules assigned</div>
      <div style={{fontSize:13,maxWidth:420,lineHeight:1.5}}>Your account ({me.full_name||me.email}) has no module access. Contact your administrator to enable Loading, Dipping, or Coating on Job.</div>
      <button onClick={async()=>{ try{ await _sb.auth.signOut(); }catch{} try{ localStorage.removeItem("hdp.session_id"); }catch{} location.reload(); }} style={{marginTop:8,padding:"8px 16px",fontSize:12,fontWeight:700,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,cursor:"pointer",fontFamily:"inherit"}}>Sign out</button>
    </div>;
  }
  const rd=RD[me.role]||RD.admin;


  return <div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:"system-ui,-apple-system,sans-serif"}}>
    {/* Notification */}
    {notif&&<div style={{position:"fixed",top:16,right:16,zIndex:9999,background:"#1E2A36",
      border:`2px solid ${notif.color}`,borderRadius:10,padding:"12px 18px",minWidth:280,
      boxShadow:`0 0 24px ${notif.color}40`}}>
      <div style={{fontSize:10,color:T.muted,fontWeight:700,textTransform:"uppercase",marginBottom:4}}>Status Updated</div>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontFamily:"monospace",color:T.amber,fontWeight:700}}>{notif.beam}</span>
        <span style={{color:notif.color,fontSize:13,fontWeight:700}}>→ {notif.label}</span>
      </div>
    </div>}

    {/* Header */}
    <div style={{background:T.surf,borderBottom:`1px solid ${T.border}`,height:54,
      padding:"0 20px",display:"flex",alignItems:"center",justifyContent:"space-between",
      position:"sticky",top:0,zIndex:200}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{width:32,height:32,borderRadius:8,
          background:`linear-gradient(135deg,${T.amber},${T.amberD})`,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,color:"#0B0E12",
          boxShadow:`0 0 12px ${T.amber}40`,fontWeight:900}}>HDP</div>
        <div>
          <div style={{fontSize:13,fontWeight:800,color:T.text,letterSpacing:".06em"}}>HDP GALVANIZING</div>
          <div style={{fontSize:9,color:T.dim,letterSpacing:".1em"}}>TRANSMISSION LINE TOWER — PRODUCTION SYSTEM v3.0</div>
        </div>
        <SyncHealthBadge T={T} />
        {qcPend>0&&<div style={{marginLeft:4,background:T.amber+"18",border:`1px solid ${T.amber}40`,
          borderRadius:6,padding:"2px 10px",fontSize:11,color:T.amber,fontWeight:700}}>
          {qcPend} Coating Pending
        </div>}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <div style={{fontFamily:"monospace",fontSize:11,color:T.muted}}>
          {clock.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})}  {clock.toLocaleTimeString("en-IN",{hour12:true})}
        </div>
        <div style={{background:T.amber+"18",border:`1px solid ${T.amber}40`,borderRadius:6,
          padding:"3px 10px",fontSize:10,color:T.amber,fontWeight:700,letterSpacing:".08em"}}>
          {autoShift(clock.toISOString()).split(" ")[0]} SHIFT
        </div>
        <button onClick={()=>sd(d=>!d)} aria-label={dark?"Switch to light theme":"Switch to dark theme"} title="Toggle theme" style={{background:T.card,border:`1px solid ${T.border}`,
          borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:13,color:T.muted}}><span aria-hidden="true">{dark?"☀":"🌙"}</span></button>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:30,height:30,borderRadius:"50%",background:rd.c+"25",
            border:`2px solid ${rd.c}`,display:"flex",alignItems:"center",
            justifyContent:"center",fontSize:12,fontWeight:800,color:rd.c}}>
            {me.full_name.charAt(0)}
          </div>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:T.text,lineHeight:1}}>{me.full_name}</div>
            <div style={{fontSize:9,color:rd.c,fontWeight:700}}>{rd.label.toUpperCase()}</div>
          </div>
        </div>
        <button onClick={()=>{addAudit(me.id,me.full_name,"LOGOUT","auth","Logged out");_sb.auth.signOut();}}
          style={{padding:"5px 14px",fontSize:11,fontWeight:600,borderRadius:6,cursor:"pointer",
          background:"transparent",color:T.muted,border:`1px solid ${T.border}`,fontFamily:"inherit"}}>
          Sign Out
        </button>
      </div>
    </div>

    {/* Nav */}
    <div style={{background:"#16202B",borderBottom:`1px solid ${T.border}`,
      padding:"0 20px",display:"flex",gap:2,overflowX:"auto"}}>
      {TABS.map(t=>(
        <button key={t.id} onClick={()=>st(t.id)} style={{
          padding:"11px 15px",fontSize:12,fontWeight:600,background:"transparent",border:"none",
          cursor:"pointer",whiteSpace:"nowrap",fontFamily:"inherit",
          color:activeTab===t.id?T.amber:T.muted,
          borderBottom:`2px solid ${activeTab===t.id?T.amber:"transparent"}`,transition:"color .15s"}}>
          {t.label}
        </button>
      ))}
      <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5,
        padding:"0 8px",fontSize:10,color:T.dim,whiteSpace:"nowrap"}}>
        {["LOADED","DIPPING","CoJ","COMPLETED"].map((s,i)=>(
          <span key={s} style={{display:"flex",alignItems:"center",gap:4}}>
            <span style={{color:ST[s==="CoJ"?"QC_PENDING":s]?.color||T.amber}}>{s}</span>
            {i<3&&<span style={{color:T.dim}}>→</span>}
          </span>
        ))}
      </div>
    </div>

    {/* Content */}
    <div style={{padding:"18px 20px"}}>
      <div style={{marginBottom:16,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{fontSize:17,fontWeight:800,color:T.text}}>{TABS.find(t=>t.id===activeTab)?.label || "No module access"}</div>
        <div style={{fontSize:11,color:T.dim}}>{clock.toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</div>
        <div style={{padding:"3px 10px",background:rd.c+"20",border:`1px solid ${rd.c}40`,
          borderRadius:6,fontSize:11,color:rd.c}}>🔑 {rd.label}</div>
      </div>

      {!activeTab&&<Card T={T} style={{padding:24}}><div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:6}}>No module access assigned</div><div style={{fontSize:12,color:T.muted}}>Please contact an administrator to enable your module access.</div></Card>}
      {activeTab==="dashboard"&&<DashboardTab beams={filterBeamsByFlag(beams)} users={users} auditLog={audit} T={T} user={me} setBeams={effReadOnly?()=>{}:setBeamsNotif} addAudit={addAudit} fieldConfig={fieldConfig} qcRanges={qcRanges} toggleBeamEnabled={effReadOnly?undefined:toggleBeamEnabled}/>}      
      {activeTab==="tracker"  &&<BeamTrackerTab beams={filterBeamsByFlag(beams)} T={T} isAdmin={me?.role==="admin"} deleteBeams={deleteBeams} toggleBeamEnabled={toggleBeamEnabled}/>}      
      {activeTab==="loading"  &&<LoadingTab beams={filterBeamsByFlag(beams)} setBeams={effReadOnly?()=>{}:setBeamsNotif} addAudit={addAudit} user={me} readOnly={effReadOnly} T={T} fieldConfig={fieldConfig} micronRules={micronRules}/>}      
      {activeTab==="dipping"  &&<DippingTab beams={filterBeamsByFlag(beams)} setBeams={effReadOnly?()=>{}:setBeamsNotif} addAudit={addAudit} user={me} readOnly={effReadOnly} T={T} dippingConfig={dippingConfig} operators={operators} shiftSupervisors={shiftSupervisors} micronRules={micronRules} mlrModel={mlrStore.stored?.model ?? null} mlrTrainedAt={mlrStore.stored?.trainedAt ?? null} lgbmModel={mlrStore.lgbm?.model ?? null} lgbmTrainedAt={mlrStore.lgbm?.trainedAt ?? null} xgbModel={mlrStore.xgb?.model ?? null} xgbTrainedAt={mlrStore.xgb?.trainedAt ?? null} catModel={mlrStore.cat?.model ?? null} catTrainedAt={mlrStore.cat?.trainedAt ?? null} zcModel={mlrStore.zc?.model ?? null} zcTrainedAt={mlrStore.zc?.trainedAt ?? null} aiModel={aiModels}/>}      
      {activeTab==="qc"       &&<QCTab beams={filterBeamsByFlag(beams)} setBeams={effReadOnly?()=>{}:setBeamsNotif} addAudit={addAudit} user={me} readOnly={effReadOnly} T={T} qcRanges={qcRanges} setQcRanges={setQcRanges} dippingConfig={dippingConfig} fieldConfig={fieldConfig}/>}      
      {activeTab==="material_offer"&&<MaterialOfferTab beams={filterBeamsByFlag(beams)} T={T} user={me} readOnly={effReadOnly}/>}
      {activeTab==="reports"  &&<ReportsTab beams={filterBeamsByFlag(beams)} setBeams={effReadOnly?()=>{}:setBeamsNotif} emailRecs={emailRecs} canExport={myPerms.canExport} canEmail={myPerms.canSendReportEmail} operators={operators} shiftSupervisors={shiftSupervisors} T={T} isAdmin={me?.role==="admin"} deleteBeams={deleteBeams} fieldConfig={fieldConfig} dippingConfig={dippingConfig} aiDashboardEnabled={!!aiDashboardEnabled} aiModels={aiModels} mlrStore={mlrStore} aiTrainHistory={Array.isArray(aiTrainHistory)?aiTrainHistory:[]}/>}
      {activeTab==="audit"    &&<AuditTab auditLog={audit} fieldConfig={fieldConfig} user={me} T={T} deleteAuditEntries={deleteAuditEntries} purgeOldAudit={purgeOldAudit}/>}      
      {activeTab==="admin"    &&<AdminTab
        users={users} setUsers={setUsersCloud}
        auditLog={audit} addAudit={addAudit}
        user={me} beams={beams} setBeams={sb}
        allTabs={ALL_TABS}
        moduleAccess={moduleAccess} setModuleAccess={setMA}
        themeId={themeId} setThemeId={setThemeId}
        resetBeams={()=>{
          if(me?.role!=="admin"){ alert("Admin only"); return; }
          _adminResetBeams({data:{confirm:true}})
            .then(()=>{ sb([] as any); addAudit(me.id,me.full_name,"DATA_RESET","admin","ALL production data deleted by "+me.full_name); })
            .catch((e:any)=>alert("Reset failed: "+(e?.message||e)));
        }}
        emailRecs={emailRecs} setEmailRecs={setEmailRecs}
        fieldConfig={fieldConfig} setFieldConfig={setFieldConfig}
        dippingConfig={dippingConfig} setDippingConfig={setDippingConfig}
        operators={operators} setOperators={setOperators}
        shiftSupervisors={shiftSupervisors} setShiftSupervisors={setShiftSupervisors}
        deleteBeams={deleteBeams} deleteAuditEntries={deleteAuditEntries} purgeOldAudit={purgeOldAudit}
        sendInviteEmail={sendInviteEmail} setSendInviteEmail={setSendInviteEmail}
        
        micronRules={micronRules} setMicronRules={setMicronRules} mlrStore={mlrStore} aiModel={aiModels} setAiModel={setAiModel}
        aiDashboardEnabled={!!aiDashboardEnabled} setAiDashboardEnabled={setAiDashboardEnabled}
        aiTrainHistory={Array.isArray(aiTrainHistory)?aiTrainHistory:[]} setAiTrainHistory={setAiTrainHistory}
        feature65um={feature65um} setFeature65um={setFeature65um}
        T={T}/>}
    </div>
    <style>{`*{box-sizing:border-box}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#33434F;border-radius:3px}select option{background:#1E2A36;color:#C9D6DF}`}</style>
  </div>;
}

export default function App(){
  return <_AuthGate>{({sessionId})=> <AppInner sessionId={sessionId}/>}</_AuthGate>;
}
