import { createHash } from "node:crypto";
import type { Mount } from "./mounts.js";

export type ShadowJudgeSurface = "review" | "risk" | "verify-human";

/** A stable 5% sample keyed to the decision, so retries do not change assignment. */
export function shadowJudgeSampled(key: string): boolean {
  const bucket = createHash("sha256").update(key).digest().readUInt32BE(0) % 20;
  return bucket === 0;
}

/** Use an already configured model. Never silently compare a model with itself. */
export function shadowJudgeMount(mounts: readonly Mount[], primaryModel: string): Mount | undefined {
  return mounts.find((mount) => mount.model !== primaryModel);
}

export const SHADOW_JUDGE_MAX_BUDGET_USD = 0.10;

export interface ShadowJudgeRequest<T> {
  surface: ShadowJudgeSurface;
  key: string;
  primaryMount: Mount;
  primaryServedModel?: string | null;
  primaryDecision: T;
  mounts: readonly Mount[] | (() => readonly Mount[]);
  judge: (mount: Mount) => Promise<{ decision: T; servedModel?: string | null }>;
  log: (step: string, fields: Record<string, unknown>) => void;
}

/** Advisory only: no result is returned to the caller, even on disagreement or failure. */
export async function runShadowJudge<T>(request: ShadowJudgeRequest<T>): Promise<void> {
  if (!shadowJudgeSampled(`${request.surface}:${request.key}`)) return;
  const record = (step: string, fields: Record<string, unknown>): void => {
    try {
      request.log(step, fields);
    } catch (error) {
      // A failed observation must never affect the decision being shadowed.
      process.stderr.write(`shadow judge ledger unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  const common = {
    surface: request.surface,
    decision_key: request.key,
    primary_model: request.primaryMount.model,
    primary_served_model: request.primaryServedModel ?? null,
    primary_effort: request.primaryMount.effort,
    primary_provider: request.primaryMount.provider ?? null,
    primary_decision: request.primaryDecision,
    sample_denominator: 20,
    shadow_budget_usd: SHADOW_JUDGE_MAX_BUDGET_USD,
  };
  let mounts: readonly Mount[];
  try {
    mounts = typeof request.mounts === "function" ? request.mounts() : request.mounts;
  } catch (error) {
    record("shadow_judge.unavailable", {
      ...common, reason: `mount-resolution-failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  const mount = shadowJudgeMount(mounts, request.primaryMount.model);
  if (!mount) {
    record("shadow_judge.unavailable", { ...common, reason: "no-different-configured-model" });
    return;
  }
  try {
    const shadow = await request.judge(mount);
    if (request.primaryServedModel && shadow.servedModel && request.primaryServedModel === shadow.servedModel) {
      record("shadow_judge.unavailable", {
        ...common, shadow_model: mount.model, shadow_served_model: shadow.servedModel,
        reason: "same-served-model",
      });
      return;
    }
    record("shadow_judge.paired", {
      ...common,
      shadow_model: mount.model,
      shadow_effort: mount.effort,
      shadow_provider: mount.provider ?? null,
      shadow_served_model: shadow.servedModel ?? null,
      model_comparison: request.primaryServedModel && shadow.servedModel
        ? "served-different" : "requested-different-served-unavailable",
      shadow_decision: shadow.decision,
      agreement: JSON.stringify(request.primaryDecision) === JSON.stringify(shadow.decision),
    });
  } catch (error) {
    record("shadow_judge.unavailable", {
      ...common,
      shadow_model: mount.model,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Aggregate paired observations; unavailable samples stay visible in the denominator. */
export function measureShadowJudgeAgreement(
  rows: ReadonlyArray<Record<string, unknown>>,
  surface: ShadowJudgeSurface,
): { sampled: number; paired: number; agreed: number; agreementRate: number | null; unavailable: number } {
  const observed = rows.filter((row) => row.surface === surface &&
    (row.step === "shadow_judge.paired" || row.step === "shadow_judge.unavailable"));
  const paired = observed.filter((row) => row.step === "shadow_judge.paired");
  const agreed = paired.filter((row) => row.agreement === true).length;
  return {
    sampled: observed.length,
    paired: paired.length,
    agreed,
    agreementRate: paired.length === 0 ? null : agreed / paired.length,
    unavailable: observed.length - paired.length,
  };
}
