// Loads / saves the Admin-trained AI models (MLR + LightGBM + XGBoost + CatBoost).
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { TrainedMlr } from "./mlr";
import type { TrainedLgbm } from "./lgbm";
import type { TrainedXgb } from "./xgb";
import type { TrainedCatboost } from "./catboost";
import type { TrainedZinccore } from "./zinccore";

export type AiModelType = "mlr" | "lgbm" | "xgb" | "cat" | "zc";


export type StoredMlr = {
  id?: string;
  model: TrainedMlr;
  trainedAt: string | null;
  trainedByName: string | null;
  sourceFilename: string | null;
};

export type StoredLgbm = {
  id?: string;
  model: TrainedLgbm;
  trainedAt: string | null;
  trainedByName: string | null;
  sourceFilename: string | null;
};

export type StoredXgb = {
  id?: string;
  model: TrainedXgb;
  trainedAt: string | null;
  trainedByName: string | null;
  sourceFilename: string | null;
};

export type StoredCatboost = {
  id?: string;
  model: TrainedCatboost;
  trainedAt: string | null;
  trainedByName: string | null;
  sourceFilename: string | null;
};

export type StoredZinccore = {
  id?: string;
  model: TrainedZinccore;
  trainedAt: string | null;
  trainedByName: string | null;
  sourceFilename: string | null;
};

const MODEL_NAME = "dipping_total_time";

export function useMlrModel() {
  const [stored, setStored] = useState<StoredMlr | null>(null);
  const [lgbm, setLgbm] = useState<StoredLgbm | null>(null);
  const [xgb, setXgb] = useState<StoredXgb | null>(null);
  const [cat, setCat] = useState<StoredCatboost | null>(null);
  const [zc, setZc] = useState<StoredZinccore | null>(null);
  const [loading, setLoading] = useState(true);


  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await (supabase.from("mlr_models") as any)
        .select("*")
        .eq("name", MODEL_NAME)
        .order("updated_at", { ascending: false });
      const rows: any[] = Array.isArray(data) ? data : [];
      const mlrRow = rows.find((r) => (r.model_type ?? "mlr") === "mlr");
      const lgbmRow = rows.find((r) => r.model_type === "lgbm");
      const xgbRow = rows.find((r) => r.model_type === "xgb");
      const catRow = rows.find((r) => r.model_type === "cat");
      const zcRow = rows.find((r) => r.model_type === "zc");


      if (mlrRow?.coefficients) {
        const c: any = mlrRow.coefficients;
        setStored({
          id: mlrRow.id,
          model: {
            beta: c.beta ?? [],
            coatingBeta: c.coatingBeta ?? [],
            features: (mlrRow.features as any) ?? [],
            r2: Number(mlrRow.r2 ?? 0),
            coatingR2: Number(mlrRow.coating_r2 ?? 0),
            n: Number(mlrRow.sample_rows ?? 0),
            degenerate: !!c.degenerate,
          },
          trainedAt: mlrRow.updated_at ?? mlrRow.created_at ?? null,
          trainedByName: mlrRow.trained_by_name ?? null,
          sourceFilename: mlrRow.source_filename ?? null,
        });
      } else setStored(null);

      if (lgbmRow?.coefficients?.time) {
        const c: any = lgbmRow.coefficients;
        setLgbm({
          id: lgbmRow.id,
          model: {
            kind: "lgbm",
            time: c.time,
            coating: c.coating,
            features: (lgbmRow.features as any) ?? [],
            r2: Number(lgbmRow.r2 ?? 0),
            coatingR2: Number(lgbmRow.coating_r2 ?? 0),
            n: Number(lgbmRow.sample_rows ?? 0),
            degenerate: !!c.degenerate,
          },
          trainedAt: lgbmRow.updated_at ?? lgbmRow.created_at ?? null,
          trainedByName: lgbmRow.trained_by_name ?? null,
          sourceFilename: lgbmRow.source_filename ?? null,
        });
      } else setLgbm(null);

      if (xgbRow?.coefficients?.time) {
        const c: any = xgbRow.coefficients;
        setXgb({
          id: xgbRow.id,
          model: {
            kind: "xgb",
            time: c.time,
            coating: c.coating,
            features: (xgbRow.features as any) ?? [],
            r2: Number(xgbRow.r2 ?? 0),
            coatingR2: Number(xgbRow.coating_r2 ?? 0),
            n: Number(xgbRow.sample_rows ?? 0),
            degenerate: !!c.degenerate,
          },
          trainedAt: xgbRow.updated_at ?? xgbRow.created_at ?? null,
          trainedByName: xgbRow.trained_by_name ?? null,
          sourceFilename: xgbRow.source_filename ?? null,
        });
      } else setXgb(null);

      if (catRow?.coefficients?.time) {
        const c: any = catRow.coefficients;
        setCat({
          id: catRow.id,
          model: {
            kind: "cat",
            time: c.time,
            coating: c.coating,
            statsTime: c.statsTime,
            statsCoating: c.statsCoating,
            features: (catRow.features as any) ?? [],
            r2: Number(catRow.r2 ?? 0),
            coatingR2: Number(catRow.coating_r2 ?? 0),
            n: Number(catRow.sample_rows ?? 0),
            degenerate: !!c.degenerate,
          },
          trainedAt: catRow.updated_at ?? catRow.created_at ?? null,
          trainedByName: catRow.trained_by_name ?? null,
          sourceFilename: catRow.source_filename ?? null,
        });
      } else setCat(null);

      if (zcRow?.coefficients?.net) {
        const c: any = zcRow.coefficients;
        setZc({
          id: zcRow.id,
          model: {
            ...(c.net as TrainedZinccore),
            kind: "zc",
            features: (zcRow.features as any) ?? [],
            r2: Number(zcRow.r2 ?? 0),
            coatingR2: Number(zcRow.coating_r2 ?? 0),
            n: Number(zcRow.sample_rows ?? 0),
          },
          trainedAt: zcRow.updated_at ?? zcRow.created_at ?? null,
          trainedByName: zcRow.trained_by_name ?? null,
          sourceFilename: zcRow.source_filename ?? null,
        });
      } else setZc(null);
    } catch {
      setStored(null);
      setLgbm(null);
      setXgb(null);
      setCat(null);
      setZc(null);
    } finally {

      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const upsert = useCallback(
    async (type: AiModelType, payload: Record<string, any>) => {
      const { data: existing } = await (supabase.from("mlr_models") as any)
        .select("id")
        .eq("name", MODEL_NAME)
        .eq("model_type", type)
        .limit(1)
        .maybeSingle();
      const res = existing?.id
        ? await (supabase.from("mlr_models") as any).update(payload).eq("id", existing.id)
        : await (supabase.from("mlr_models") as any).insert(payload);
      if (res.error) throw res.error;
      await load();
    },
    [load],
  );

  const save = useCallback(
    async (model: TrainedMlr, meta: { filename?: string | null; byName?: string | null; byId?: string | null }) =>
      upsert("mlr", {
        name: MODEL_NAME,
        model_type: "mlr",
        coefficients: { beta: model.beta, coatingBeta: model.coatingBeta, degenerate: !!model.degenerate },
        features: model.features as any,
        r2: model.r2,
        coating_r2: model.coatingR2,
        sample_rows: model.n,
        source_filename: meta.filename ?? null,
        trained_by: meta.byId ?? null,
        trained_by_name: meta.byName ?? null,
        updated_at: new Date().toISOString(),
      }),
    [upsert],
  );

  const saveLgbm = useCallback(
    async (model: TrainedLgbm, meta: { filename?: string | null; byName?: string | null; byId?: string | null }) =>
      upsert("lgbm", {
        name: MODEL_NAME,
        model_type: "lgbm",
        coefficients: { time: model.time, coating: model.coating, degenerate: !!model.degenerate },
        features: model.features as any,
        r2: model.r2,
        coating_r2: model.coatingR2,
        sample_rows: model.n,
        source_filename: meta.filename ?? null,
        trained_by: meta.byId ?? null,
        trained_by_name: meta.byName ?? null,
        updated_at: new Date().toISOString(),
      }),
    [upsert],
  );

  const saveXgb = useCallback(
    async (model: TrainedXgb, meta: { filename?: string | null; byName?: string | null; byId?: string | null }) =>
      upsert("xgb", {
        name: MODEL_NAME,
        model_type: "xgb",
        coefficients: { time: model.time, coating: model.coating, degenerate: !!model.degenerate },
        features: model.features as any,
        r2: model.r2,
        coating_r2: model.coatingR2,
        sample_rows: model.n,
        source_filename: meta.filename ?? null,
        trained_by: meta.byId ?? null,
        trained_by_name: meta.byName ?? null,
        updated_at: new Date().toISOString(),
      }),
    [upsert],
  );

  const saveCat = useCallback(
    async (model: TrainedCatboost, meta: { filename?: string | null; byName?: string | null; byId?: string | null }) =>
      upsert("cat", {
        name: MODEL_NAME,
        model_type: "cat",
        coefficients: {
          time: model.time,
          coating: model.coating,
          statsTime: model.statsTime,
          statsCoating: model.statsCoating,
          degenerate: !!model.degenerate,
        },
        features: model.features as any,
        r2: model.r2,
        coating_r2: model.coatingR2,
        sample_rows: model.n,
        source_filename: meta.filename ?? null,
        trained_by: meta.byId ?? null,
        trained_by_name: meta.byName ?? null,
        updated_at: new Date().toISOString(),
      }),
    [upsert],
  );


  const saveZc = useCallback(
    async (model: TrainedZinccore, meta: { filename?: string | null; byName?: string | null; byId?: string | null }) =>
      upsert("zc", {
        name: MODEL_NAME,
        model_type: "zc",
        coefficients: { net: model, degenerate: !!model.degenerate },
        features: model.features as any,
        r2: model.r2,
        coating_r2: model.coatingR2,
        sample_rows: model.n,
        source_filename: meta.filename ?? null,
        trained_by: meta.byId ?? null,
        trained_by_name: meta.byName ?? null,
        updated_at: new Date().toISOString(),
      }),
    [upsert],
  );

  const remove = useCallback(
    async (type: AiModelType) => {
      const res = await (supabase.from("mlr_models") as any)
        .delete()
        .eq("name", MODEL_NAME)
        .eq("model_type", type);
      if (res.error) throw res.error;
      await load();
    },
    [load],
  );

  const clearAll = useCallback(async () => {
    const res = await (supabase.from("mlr_models") as any).delete().eq("name", MODEL_NAME);
    if (res.error) throw res.error;
    await load();
  }, [load]);

  return { stored, lgbm, xgb, cat, zc, loading, reload: load, save, saveLgbm, saveXgb, saveCat, saveZc, remove, clearAll };
}
