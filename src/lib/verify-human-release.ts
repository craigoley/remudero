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
import {
  buildFilingRiskJudgeInput,
  DEFAULT_RISK_POLICY,
  planRiskJudgeAction,
  type RiskJudgeInput,
  type RiskJudgeVerdict,
  type RiskPolicy,
} from "./risk-judge.js";
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

export interface VerifyHumanReleasePorts {
  /** The record as the plan holds it; undefined when the id resolves to nothing. */
  task: (id: string) => Task | undefined;
  riskJudge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>;
  riskPolicy?: RiskPolicy;
  /** Writes the release row. `approveParkedTask`'s own guards apply; a non-zero code means no row. */
  writeRelease: (
    taskId: string,
    provenance: MachineReleaseProvenance,
    riskPolicy: RiskPolicy,
  ) => { code: number; message: string; released?: boolean };
}

const unavailable = (reason: string): VerifyHumanReleaseOutcome => ({ kind: "unavailable", reason });

export async function releaseAutomatedShard(
  shard: ShardUnderJudgement,
  verdict: VerifyHumanVerdict,
  ports: VerifyHumanReleasePorts,
): Promise<VerifyHumanReleaseOutcome> {
  const task = ports.task(shard.id);
  if (!task) return unavailable(`${shard.id} does not resolve to a plan record`);
  // Checked here as well as in approveParkedTask so the reason names the real cause rather than a
  // write refusal, and so no risk-judge spend is made on a record that cannot be released anyway.
  if (task.verify !== "human") return unavailable(`${shard.id} is verify: ${task.verify}, not parked`);
  if (task.status !== "queued") return unavailable(`${shard.id} is status: ${task.status}, not queued`);

  let risk: RiskJudgeVerdict;
  try {
    risk = await ports.riskJudge(buildFilingRiskJudgeInput(task));
  } catch (e) {
    return { kind: "unavailable", reason: `the risk judge threw: ${String((e as Error)?.message ?? e)}` };
  }
  // `"available"` is also a legal value, so presence alone is not the signal — only the explicit
  // "unavailable" marker means no LLM decision was reached.
  if (risk.availability === "unavailable") return unavailable("the risk judge reached no decision");

  const riskPolicy = ports.riskPolicy ?? DEFAULT_RISK_POLICY;
  const action = planRiskJudgeAction(risk, { confidenceThreshold: riskPolicy.confidenceThreshold });
  if (action.kind === "escalate") return { kind: "escalated", reason: action.reason };

  const written = ports.writeRelease(
    task.id,
    {
      released_by: "verify-human-judge",
      author_class: "machine",
      judge_reason: verdict.reason,
      risk_verdict: risk.verdict,
      risk_confidence: risk.confidence,
      risk_reasons: [...risk.reasons],
    },
    riskPolicy,
  );
  if (written.code !== 0) return unavailable(written.message);
  if (written.released === false) return { kind: "escalated", reason: written.message };
  return { kind: "released", reason: action.reason };
}

// ── W1-T4083: the release judge is measured (38 of 38 released, none escalated, 2026-09-22) ──────

export const VERIFY_HUMAN_RELEASE_AUDIT_STEP = "verify_human.release_audit";
export const RELEASE_AUDIT_MIN_RELEASES = 50;
export const RELEASE_AUDIT_MIN_DECIDED = 10;

const MERGED_VERDICTS = new Set(["merged", "already_satisfied"]);
/** Task-attributable failures only; infrastructure blocks never count against the judge. */
const FAILED_VERDICTS = new Set(["blocked_ci", "blocked_review", "no_pr", "blocked_budget", "error_max_budget_usd", "blocked_illformed"]);

export interface ReleaseAuditAlert {
  kind: "never-escalates" | "failing-above-base";
  detail: string;
}

export interface ReleaseAudit {
  releases: number;
  escalations: number;
  merged: number;
  failed: number;
  pending: number;
  failureRate: number | null;
  baseFailureRate: number | null;
  alerts: ReleaseAuditAlert[];
}

function verdictClass(verdict: unknown): "merged" | "failed" | undefined {
  if (typeof verdict !== "string") return undefined;
  if (MERGED_VERDICTS.has(verdict)) return "merged";
  return FAILED_VERDICTS.has(verdict) ? "failed" : undefined;
}

/** Remembered between runs: the fleet ledger keeps about a day of rotations. */
export interface ReleaseAuditState {
  released: Record<string, string>;
  escalationKeys: string[];
  outcomes: Record<string, { ts: string; cls: "merged" | "failed" }>;
}

export const EMPTY_RELEASE_AUDIT_STATE: ReleaseAuditState = { released: {}, escalationKeys: [], outcomes: {} };

/** Join each machine release to its latest decisive verdict, against other tasks' failure rate. */
export function auditMachineReleases(
  rows: readonly Record<string, unknown>[],
  prior: ReleaseAuditState = EMPTY_RELEASE_AUDIT_STATE,
): { audit: ReleaseAudit; state: ReleaseAuditState } {
  const released = new Map(Object.entries(prior.released));
  const escalationKeys = new Set(prior.escalationKeys);
  for (const row of rows) {
    const ts = String(row.ts ?? "");
    if (row.step === "verify_human.release_escalated") escalationKeys.add(`${String(row.task_id)}@${ts}`);
    if (row.step === "ratify.approved" && row.author_class === "machine" && typeof row.task_id === "string") {
      const seen = released.get(row.task_id);
      if (seen === undefined || ts > seen) released.set(row.task_id, ts);
    }
  }
  const outcomes = new Map(Object.entries(prior.outcomes));
  let baseMerged = 0;
  let baseFailed = 0;
  for (const row of rows) {
    if (row.step !== "verdict" || typeof row.task_id !== "string") continue;
    const cls = verdictClass(row.verdict);
    if (!cls) continue;
    const ts = String(row.ts ?? "");
    const releasedTs = released.get(row.task_id);
    if (releasedTs === undefined) {
      if (cls === "merged") baseMerged += 1;
      else baseFailed += 1;
      continue;
    }
    if (ts <= releasedTs) continue;
    const seen = outcomes.get(row.task_id);
    if (!seen || ts > seen.ts) outcomes.set(row.task_id, { ts, cls });
  }
  let merged = 0;
  let failed = 0;
  for (const [taskId, o] of outcomes) {
    if (!released.has(taskId)) continue;
    if (o.cls === "merged") merged += 1;
    else failed += 1;
  }
  const decided = merged + failed;
  const failureRate = decided > 0 ? failed / decided : null;
  const baseDecided = baseMerged + baseFailed;
  const baseFailureRate = baseDecided > 0 ? baseFailed / baseDecided : null;
  const escalations = escalationKeys.size;
  const alerts: ReleaseAuditAlert[] = [];
  if (released.size >= RELEASE_AUDIT_MIN_RELEASES && escalations === 0) {
    alerts.push({
      kind: "never-escalates",
      detail:
        `The verify-human release judge has released ${released.size} tasks and escalated none. A gate ` +
        `that never says no is not discriminating: sample a few released tasks and review the risk ` +
        `threshold in plan/policy.yaml.`,
    });
  }
  if (
    failureRate !== null && baseFailureRate !== null && decided >= RELEASE_AUDIT_MIN_DECIDED &&
    baseDecided >= RELEASE_AUDIT_MIN_DECIDED && failureRate > 2 * baseFailureRate
  ) {
    alerts.push({
      kind: "failing-above-base",
      detail:
        `Tasks released by the verify-human judge fail ${(failureRate * 100).toFixed(0)}% of the time ` +
        `(${failed} of ${decided}) against ${(baseFailureRate * 100).toFixed(0)}% for other tasks. The ` +
        `release threshold is letting through work the fleet cannot finish.`,
    });
  }
  return {
    audit: { releases: released.size, escalations, merged, failed, pending: released.size - decided, failureRate, baseFailureRate, alerts },
    state: { released: Object.fromEntries(released), escalationKeys: [...escalationKeys].sort(), outcomes: Object.fromEntries(outcomes) },
  };
}

/** Stable proposal ids, so a once-only stager raises each condition exactly once. */
export function runReleaseAudit(
  rows: readonly Record<string, unknown>[],
  hooks: {
    appendRow: (row: Record<string, unknown>) => void;
    stageProposal: (proposal: { id: string; summary: string; evidenceAnchors: never[] }) => void;
    runId: string;
    readState: () => ReleaseAuditState;
    writeState: (state: ReleaseAuditState) => void;
  },
): ReleaseAudit {
  const { audit, state } = auditMachineReleases(rows, hooks.readState());
  hooks.writeState(state);
  hooks.appendRow({
    run_id: hooks.runId,
    task_id: "DAEMON",
    step: VERIFY_HUMAN_RELEASE_AUDIT_STEP,
    releases: audit.releases,
    escalations: audit.escalations,
    merged: audit.merged,
    failed: audit.failed,
    pending: audit.pending,
    failure_rate: audit.failureRate,
    base_failure_rate: audit.baseFailureRate,
    alerts: audit.alerts.map((a) => a.kind),
  });
  for (const alert of audit.alerts) {
    hooks.stageProposal({ id: `verify-human-release-audit-${alert.kind}`, summary: alert.detail, evidenceAnchors: [] });
  }
  return audit;
}
