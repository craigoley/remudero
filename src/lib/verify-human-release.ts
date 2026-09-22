/**
 * lib/verify-human-release.ts — the verify-human judge's CONTINUE arm (operator ruling 2026-09-22).
 *
 * An `automate` verdict used to end as an inbox proposal waiting for the operator to ratify it.
 * This turns it into a release: a filing-time risk judge reads the RECORD, and on PROCEED the task
 * is released through W1-T3206's existing `ratify.approved` ledger row — the same row `rmd approve`
 * writes — so the plan record stays byte-identical and the dispatcher's own eligibility check is
 * what admits it. On ESCALATE it goes to the operator with the risk judge's reason.
 *
 * WHY THE RISK JUDGE SITS IN FRONT. The operator's direction was that rules should "only fire if an
 * LLM judge determines the changes are bad or risky". The verify-human judge answers "does this
 * need the operator"; it does not answer "is releasing it risky". That is what
 * `buildFilingRiskJudgeInput` (W1-T3143) was built to ask of a record — and until now nothing
 * called it.
 *
 * POLARITY, INHERITED FROM THAT PRODUCER: a judge that errors, returns no verdict, or returns
 * `availability: "unavailable"` releases NOTHING. An outage produces more operator review, never
 * an unjudged dispatch.
 *
 * Imported only by run-task.ts, never by a routing loop, so the risk-judge dependency cannot close
 * a cycle through measurement-cadence.ts.
 */
import { buildFilingRiskJudgeInput, planRiskJudgeAction, type RiskJudgeInput, type RiskJudgeVerdict } from "./risk-judge.js";
import type { Task } from "./plan.js";
import type { ShardUnderJudgement, VerifyHumanReleaseOutcome, VerifyHumanVerdict } from "./verify-human-judge.js";

/**
 * Carried on the machine-written `ratify.approved` row. LAW 5: a record launders authority unless
 * its author class rides it. `ratify.approved` was until now written only by an operator spending
 * his bit, so a row a machine writes must say so on its face — an audit that counts operator
 * approvals reads `author_class` and is never fooled.
 */
export interface MachineReleaseProvenance {
  released_by: "verify-human-judge";
  author_class: "machine";
  judge_reason: string;
  risk_verdict: string;
  risk_confidence: number;
  risk_reasons: string[];
}

export interface VerifyHumanReleaseDeps {
  /** The record as the plan holds it; undefined when the id resolves to nothing. */
  task: (id: string) => Task | undefined;
  riskJudge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>;
  /** Writes the release row. `approveParkedTask`'s own guards apply; a non-zero code means no row. */
  writeRelease: (taskId: string, provenance: MachineReleaseProvenance) => { code: number; message: string };
}

const unavailable = (reason: string): VerifyHumanReleaseOutcome => ({ kind: "unavailable", reason });

export async function releaseAutomatedShard(
  shard: ShardUnderJudgement,
  verdict: VerifyHumanVerdict,
  deps: VerifyHumanReleaseDeps,
): Promise<VerifyHumanReleaseOutcome> {
  const task = deps.task(shard.id);
  if (!task) return unavailable(`${shard.id} does not resolve to a plan record`);
  // Checked here as well as in approveParkedTask so the reason names the real cause rather than a
  // write refusal, and so no risk-judge spend is made on a record that cannot be released anyway.
  if (task.verify !== "human") return unavailable(`${shard.id} is verify: ${task.verify}, not parked`);
  if (task.status !== "queued") return unavailable(`${shard.id} is status: ${task.status}, not queued`);

  let risk: RiskJudgeVerdict;
  try {
    risk = await deps.riskJudge(buildFilingRiskJudgeInput(task));
  } catch (e) {
    return unavailable(`the risk judge threw: ${String((e as Error)?.message ?? e)}`);
  }
  // `"available"` is also a legal value, so presence alone is not the signal — only the explicit
  // "unavailable" marker means no LLM decision was reached.
  if (risk.availability === "unavailable") return unavailable("the risk judge reached no decision");

  const action = planRiskJudgeAction(risk);
  if (action.kind === "escalate") return { kind: "escalated", reason: action.reason };

  const written = deps.writeRelease(task.id, {
    released_by: "verify-human-judge",
    author_class: "machine",
    judge_reason: verdict.reason,
    risk_verdict: risk.verdict,
    risk_confidence: risk.confidence,
    risk_reasons: [...risk.reasons],
  });
  if (written.code !== 0) return unavailable(written.message);
  return { kind: "released", reason: action.reason };
}
