/**
 * THE FLEET CHECKS WHETHER WHAT IT RECORDED AS DONE IS ACTUALLY THERE.
 *
 * THE LOSS THIS REMOVES, MEASURED RATHER THAN IMAGINED. W1-T2924 (`the rmd audit verb`) reads
 * MERGED on `main` today and was never built. The chain: PR 4941 carried the real implementation and
 * was CLOSED UNMERGED; PR 4975 — a console preregistration whose diff was two `scripts/` files and
 * one test, with no `src/lib/audit.ts` in it — carried `Remudero-Task: W1-T2924` and merged as
 * `c8892b5b6`; so the trailer credited the task, `src/lib/audit.ts` and `test/audit-command.test.ts`
 * are ABSENT, and the shard still reads `status: queued`, which doctrine already states is not a
 * completion signal. Credit derives from the trailer, so the task has left the runnable frontier
 * permanently. Nothing in the fleet would ever notice.
 *
 */

/**
 * IT IS A CHANNEL, NOT AN INCIDENT. Over 14 days of merged commits, 105 of 663 commits carrying a
 * `Remudero-Task:` trailer shipped NONE of the declared non-plan files for the task they credited,
 * and 99 of those 105 had a diff consisting entirely of `plan/` records. A second live case (#5107)
 * was caught by hand the same day and would otherwise have been a third.
 *
 * WHY THIS RUNG AND NOT A FASTER GATE. `W1-T3414` refuses the credit at source, which is the better
 * fix for NEW cases and cannot reach the ones already merged. This rung is the reconciler for
 * history: it asks the one question no existing check asks — "does the file I claimed to ship
 * exist?" — against data the repo already keeps. The two are complements, not alternatives.
 *
 * THE MEASURED FLEET CONTEXT THAT RULES OUT THE OBVIOUS ALTERNATIVE. Latency is not the problem and
 * a faster sweep would not help: median time-to-merge is 0.7h, p99 9.5h, and ZERO of 355 merged PRs
 * took over 24h. Escalations are answered in 2.2h median with 17 of 986 issues open. The fleet is
 * fast and responsive; what it lacks is a feedback loop between credit and reality.
 */

/** A task the credit projection reports merged, with the `files:` its own shard declares. */
export interface CreditedTaskDeclaration {
  taskId: string;
  /** The shard's `files:` verbatim. Plan paths are kept — {@link classifyCreditTruth} filters them. */
  files: readonly string[];
  /** Where the credit came from (a sha, a PR ref), carried into the ledger row and the escalation. */
  creditedBy?: string;
  /**
   * Which of this task's DECLARED files the crediting commit actually touched.
   *
   * THIS FIELD IS WHAT MAKES THE RUNG WORK, and leaving it out was a real defect in the first draft:
   * classifying on file existence alone, W1-T2924 — the case this rung was written for — came out
   * `partial` rather than actionable, because its `files:` names `src/run-task.ts`, a shared file that
   * exists no matter what. Almost every shard names one. Existence alone therefore cannot separate
   * "never built" from "built, plus a shared file".
   *
   * The measurement that found the 105-case channel asked a different question — whether the crediting
   * commit shipped ANY of the declared files — and that is the question kept here.
   */
  shippedByCredit?: readonly string[];
}

/**
 * What the declared deliverables say about a credit.
 *
 * `plan-only` and `partial` exist SO THAT `unshipped` CAN MEAN SOMETHING. A rung that escalated every
 * imperfect match would fire on ordinary renames and be switched off inside a week — this repo's
 * recurring defect is a bound that fires on a healthy condition.
 */
/**
 * The verdicts, as a runtime tuple so the set is enumerable and the type derives from ONE source.
 *
 * - `shipped` — every declared non-plan file exists; the credit is consistent with the tree.
 * - `credit-elsewhere` — files are missing, but the crediting commit DID ship some declared file. A
 *   rename, a restructure, or genuinely partial work all look like this, so it is REPORTED, never
 *   escalated.
 * - `unshipped` — the crediting commit shipped NONE of the declared files AND at least one is absent.
 *   Both halves are required: the first says the credit is not evidence of work, the second says the
 *   work is really missing. The only verdict that escalates.
 * - `plan-only` — the shard declares only `plan/` paths, so a plan-only diff genuinely builds it.
 * - `undeterminable` — the check could not answer. NEVER treated as missing.
 *
 * A TUPLE RATHER THAN A BARE UNION, for a measured reason: `diff-coverage`'s type-only exemption
 * (`computeTypeOnlyRanges`) carves out `interface` and object-`type` members BY BRACE CONTEXT, and a
 * string union has no braces — so each `| "member"` line took a `DA:<line>,0` the gate would not
 * exempt and the PR blocked on six lines that erase to nothing. Deriving the type from real runtime
 * code fixes that and is better anyway: the set can now be iterated instead of hand-copied.
 */
export const CREDIT_TRUTH_VERDICTS = [
  "shipped",
  "credit-elsewhere",
  "unshipped",
  "plan-only",
  "undeterminable",
] as const;

export type CreditTruthVerdict = (typeof CREDIT_TRUTH_VERDICTS)[number];

export interface CreditTruthFinding {
  taskId: string;
  verdict: CreditTruthVerdict;
  /** The non-plan subset actually examined. */
  declared: readonly string[];
  missing: readonly string[];
  creditedBy?: string;
}

/** A path inside the plan's own scope, which a plan-only PR legitimately ships. */
function isPlanPath(path: string): boolean {
  return path.startsWith("plan/") || path === "MASTER-PLAN.md" || path.startsWith("plan/tasks.d/");
}

/**
 * Pure. Classify ONE credited task against the tree.
 *
 * `exists` MAY THROW, and a throw is `undeterminable`, never `missing`. An unreadable filesystem
 * must not manufacture a finding: the cost of missing one real loss for one tick is a later tick,
 * and the cost of escalating on an I/O blip is an operator learning to ignore this rung.
 */
export function classifyCreditTruth(
  task: CreditedTaskDeclaration,
  exists: (path: string) => boolean,
): CreditTruthFinding {
  const declared = task.files.filter((f) => !isPlanPath(f));
  if (declared.length === 0) {
    return { taskId: task.taskId, verdict: "plan-only", declared, missing: [], creditedBy: task.creditedBy };
  }

  const missing: string[] = [];
  for (const path of declared) {
    let there: boolean;
    try {
      there = exists(path);
    } catch {
      return { taskId: task.taskId, verdict: "undeterminable", declared, missing: [], creditedBy: task.creditedBy };
    }
    if (!there) missing.push(path);
  }

  if (missing.length === 0) {
    return { taskId: task.taskId, verdict: "shipped", declared, missing, creditedBy: task.creditedBy };
  }

  // `undefined` means the caller could not determine what the credit shipped — NOT that it shipped
  // nothing. Absent evidence must not escalate, for the same reason a throwing `exists` does not.
  if (task.shippedByCredit === undefined) {
    return { taskId: task.taskId, verdict: "undeterminable", declared, missing, creditedBy: task.creditedBy };
  }

  const creditShippedSomething = task.shippedByCredit.some((f) => declared.includes(f));
  return {
    taskId: task.taskId,
    verdict: creditShippedSomething ? "credit-elsewhere" : "unshipped",
    declared,
    missing,
    creditedBy: task.creditedBy,
  };
}

export interface CreditTruthAudit {
  /** Every task examined, in input order — the full record, not just the findings. */
  findings: readonly CreditTruthFinding[];
  /** The actionable set: credits with NO evidence the work landed. */
  unshipped: readonly CreditTruthFinding[];
  /** Reported for a human to read, never escalated. */
  creditElsewhere: readonly CreditTruthFinding[];
  counts: Readonly<Record<CreditTruthVerdict, number>> & { checked: number };
}

/** Pure. Classify a whole credited population. */
export function auditCreditTruth(
  tasks: readonly CreditedTaskDeclaration[],
  exists: (path: string) => boolean,
): CreditTruthAudit {
  const findings = tasks.map((t) => classifyCreditTruth(t, exists));
  // Built FROM the tuple, so a new verdict cannot be added without its counter appearing too.
  const counts = { ...Object.fromEntries(CREDIT_TRUTH_VERDICTS.map((v) => [v, 0])), checked: findings.length } as Record<
    CreditTruthVerdict,
    number
  > & { checked: number };
  for (const f of findings) counts[f.verdict] += 1;
  return {
    findings,
    unshipped: findings.filter((f) => f.verdict === "unshipped"),
    creditElsewhere: findings.filter((f) => f.verdict === "credit-elsewhere"),
    counts,
  };
}

export interface CreditTruthTrigger {
  /** Minimum gap between audits, so a tick loop cannot spend the cycle auditing. */
  minIntervalMs: number;
  /**
   * The most tasks one fire may escalate.
   *
   * SIZED FOR THE BACKLOG, WHICH IS THE WHOLE REASON IT EXISTS. The first run faces a measured 105
   * historical false credits; opening 105 issues at once would bury the 17-issue steady state and
   * guarantee the rung is muted. A small bound drains the backlog across ticks and keeps each fire
   * readable.
   */
  maxEscalationsPerFire: number;
}

export const DEFAULT_CREDIT_TRUTH_TRIGGER: CreditTruthTrigger = {
  minIntervalMs: 6 * 60 * 60_000,
  maxEscalationsPerFire: 3,
};

export interface CreditTruthDecision {
  fire: boolean;
  /** Always populated — a decision with no reason is a self-contradictory ledger row. */
  reason: string;
}

/**
 * Pure. Whether to audit on this tick.
 *
 * A marker stamped in the FUTURE is a clock problem, not licence to audit every tick: it is treated
 * as "just fired", the conservative direction, matching `decideLedgerCompaction`'s own handling.
 */
export function decideCreditTruthAudit(
  lastFiredAtMs: number | undefined,
  nowMs: number,
  trigger: CreditTruthTrigger = DEFAULT_CREDIT_TRUTH_TRIGGER,
): CreditTruthDecision {
  if (lastFiredAtMs === undefined) return { fire: true, reason: "no prior credit-truth audit recorded" };
  const sinceMs = nowMs - lastFiredAtMs;
  if (sinceMs < trigger.minIntervalMs) {
    return {
      fire: false,
      reason:
        `throttled — last credit-truth audit ${Math.max(0, Math.floor(sinceMs / 1000))}s ago, ` +
        `interval ${Math.floor(trigger.minIntervalMs / 1000)}s`,
    };
  }
  return { fire: true, reason: `due — last credit-truth audit ${Math.floor(sinceMs / 1000)}s ago` };
}

/** The escalation-worthy slice of one audit, already bounded. */
export function creditTruthEscalations(
  audit: CreditTruthAudit,
  trigger: CreditTruthTrigger = DEFAULT_CREDIT_TRUTH_TRIGGER,
): readonly CreditTruthFinding[] {
  return audit.unshipped.slice(0, Math.max(0, trigger.maxEscalationsPerFire));
}

/** One line an operator can act on without opening the repo. */
export function formatCreditTruthFinding(f: CreditTruthFinding): string {
  const by = f.creditedBy ? ` credited by ${f.creditedBy}` : "";
  return (
    `${f.taskId}${by}: reads MERGED, the crediting commit shipped NONE of its ${f.declared.length} ` +
    `declared non-plan file(s), and ${f.missing.length} of them are absent — missing ${f.missing.join(", ")}. ` +
    `The credit is not evidence the work landed; requeue the task rather than trusting it.`
  );
}
