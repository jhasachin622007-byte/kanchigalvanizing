import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateText } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

const num = z.number().finite();
const nNum = z.number().finite().nullable();

const CapabilitySchema = z.object({
  micron: num,
  n: z.number().int().min(0).max(1_000_000),
  mean: nNum,
  sd: nNum,
  cp: nNum,
  cpk: nNum,
});
const BestParamsSchema = z.object({
  micron: num,
  bestTemp: nNum,
  bestDipSec: nNum,
  expected: nNum,
  successRate: num,
  sample: z.number().int().min(0).max(1_000_000),
});
const ShiftSchema = z.object({
  shift: z.string().max(50),
  beams: z.number().int().min(0).max(1_000_000),
  avgCoat: num,
  avgDip: num,
  sigma: nNum,
});
const OperatorSchema = z.object({
  operator: z.string().max(100),
  beams: z.number().int().min(0).max(1_000_000),
  avgCoat: num,
  avgDip: num,
  sigma: nNum,
});
const LoadTypeSchema = z.object({
  type: z.string().max(100),
  qty: z.number().int().min(0).max(1_000_000),
  avgCoat: num,
  avgDip: num,
  yield: num,
});

const InputSchema = z.object({
  rangeLabel: z.string().max(100),
  capability: z.array(CapabilitySchema).max(50),
  bestParams: z.array(BestParamsSchema).max(50),
  shift: z.array(ShiftSchema).max(20),
  operator: z.array(OperatorSchema).max(50),
  loadType: z.array(LoadTypeSchema).max(50),
  outOfControl: z.number().int().min(0).max(1_000_000),
});

type SummaryInput = z.infer<typeof InputSchema>;

export const getSixSigmaInsights = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: SummaryInput) => InputSchema.parse(data))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) {
      return { ok: false as const, error: "AI is not configured (missing LOVABLE_API_KEY)." };
    }
    const gateway = createLovableAiGatewayProvider(key);
    const prompt = `You are a Six Sigma process engineer for a hot-dip galvanizing plant. Analyse the following aggregated production data and produce a concise (max ~280 words) report.

Period: ${data.rangeLabel}

Process Capability (Cp/Cpk by coating micron):
${JSON.stringify(data.capability, null, 2)}

Best historical process parameters (per target coating):
${JSON.stringify(data.bestParams, null, 2)}

Shift performance:
${JSON.stringify(data.shift, null, 2)}

Top operators:
${JSON.stringify(data.operator.slice(0, 8), null, 2)}

Load-type performance:
${JSON.stringify(data.loadType.slice(0, 8), null, 2)}

Out-of-control SPC events: ${data.outOfControl}

Structure your reply with these short markdown sections:
**Process Health** — assess Cp/Cpk per micron, call out world-class / marginal / not-capable lines.
**Best Operating Window** — temperature + dipping time recommendations per coating spec, with the historical success rate.
**Shift / Operator / Load-Type Observations** — best performers, biggest variation, anomalies.
**Top 3 Improvement Opportunities** — numbered, each one sentence and actionable.

Use °C, sec, µm units. Keep it data-driven; never invent numbers that are not in the input.`;

    try {
      const { text } = await generateText({
        model: gateway("google/gemini-3-flash-preview"),
        prompt,
      });
      return { ok: true as const, text };
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes("429")) {
        return { ok: false as const, error: "AI rate limit reached. Please retry in a moment." };
      }
      if (msg.includes("402")) {
        return {
          ok: false as const,
          error: "Lovable AI credits exhausted. Add credits in Settings → Workspace → Usage.",
        };
      }
      return { ok: false as const, error: msg };
    }
  });
