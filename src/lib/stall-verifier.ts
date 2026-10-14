import { createHash } from "node:crypto";
import type { FixProgressVerdict } from "./fix-progress-judge.js";
import { appendLedger, matchesRepoScopedTask } from "./ledger.js";
import type { Task } from "./plan.js";
import { DISPATCH_BREAKER_JUDGED_STEP, isDispatchStreakReset, readLedgerLines, streakRefusal } from "./status.js";

/**
 * W1-T4678: A CIRCUIT-BROKEN TASK PAGES THE OPERATOR WITH NO DIAGNOSIS.
 *
 * `escalation-catalogue.ts`'s `escalateCircuitBreak` fires the instant `nextRunnable`'s breaker
 * trips, straight to a needs-human issue — W1-T2487 found 26 of 50 blocked tasks name no
 * disposition, and 2026-09-28 W1-T3116's breaker issue #7432 would have been answered "correct
 * the credit" although all 7 of its proofs fail on main. This module is the cheap-lane read
 * BEFORE that page: it looks at the same evidence a human would (breaker counts, refusal
 * reasons, PR state, whether the task's own shard changed since the last read) and decides
 * which provisional disposition fits. It writes that diagnosis to the ledger before the
 * existing backstop page; the issue text itself is unchanged in this offline-first stage.
 *
 * WHAT THIS CANNOT DO (design (ii)): decide whether the task dispatches. The breaker's own gate
 * (`nextRunnable`/`isCircuitTripped`) is untouched by this module and stays tripped regardless
 * of the verdict below — `amend`/`retire`/`requeue` are provisional observations for the
 * offline replay, never changes to whether THIS run's dispatch or backstop page proceeds. This
 * module never calls `escalateCircuitBreak` itself; the caller retains that notification.
 */

/** The dedup ledger step — mirrors `escalateCircuitBreak`'s own `dispatch.circuit_broken.escalated`
 *  (ledger.ts's dedup-by-ledger-line discipline), keyed on this module's OWN fingerprint rather
 *  than merely task+repo, so a genuinely NEW evidence shape re-verifies even while the breaker
 *  stays tripped, and an UNCHANGED shape never re-verifies (design (ii): "once per new evidence
 *  fingerprint"). */
export const STALL_VERIFIED_STEP = "dispatch.circuit_broken.verified" as const;

/** The cheap-lane's whole input: breaker counts, refusal reasons, PR state, shard hash — the
 *  four evidence sources this task's design (i) names. Every field here is already read by an
 *  existing dispatch-path consumer (`breakerGateFor`'s `DispatchBreakerDetail`, the drain's own
 *  GitHub projection) — this module reads no NEW source, it only reads them together. */
export interface StallEvidence {
  /** `DispatchBreakerDetail.freshCount` — dispatches without a new owned PR since, at decision time. */
  freshCount: number;
  /** `DispatchBreakerDetail.excludedByReason` — the refusal/exclusion reasons the breaker's own
   *  ledger scan already classified (includes `orphaned_run` for a stale start with no later row). */
  excludedByReason: Readonly<Record<string, number>>;
  /** `DispatchBreakerDetail.hasNewOwnedPr` — a `pr.opened` line exists for this task, possibly before the current streak. */
  hasNewOwnedPr: boolean;
  /** PR state(s) observed for this task since the breaker tripped, cheapest-projection read —
   *  `"open"`, `"merged"`, `"closed_unmerged"`, or empty when nothing is known. */
  prStates: readonly string[];
  /** A hash of the task's own plan-shard material (acceptance/files/note) — changes the moment an
   *  operator or Architect amends the proof, so an amended task reads as NEW evidence rather than
   *  silently reusing a stale verdict. */
  shardHash: string;
}

/** The four provisional outcomes design (i) names. None changes the dispatch gate or its
 *  existing backstop page in the offline-first stage. */
export type StallVerdict =
  | { kind: "amend"; reason: string }
  | { kind: "retire"; reason: string }
  | { kind: "requeue"; note: string }
  | { kind: "escalate"; owner: string; reason: string };

export interface StallVerifierResult {
  fingerprint: string;
  verdict: StallVerdict;
  /** True when a prior complete `STALL_VERIFIED_STEP` row supplied this fingerprint's verdict.
   *  No second decision or ledger write is made for unchanged evidence. */
  alreadyVerified: boolean;
}

/** Stable-order material so two evidence objects with the same content always fingerprint the
 *  same, regardless of key insertion order (`excludedByReason` in particular is built by walking
 *  a ledger scan, so its key order is not a semantic fact). */
function sortedEntries(rec: Readonly<Record<string, number>>): Array<[string, number]> {
  return Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** design (ii): "once per new evidence fingerprint" — this IS the fingerprint. Pure function of
 *  {@link StallEvidence}, so calling it twice on unchanged evidence always yields the same digest
 *  and `verifyStalledTask`'s dedup read below can trust that identity. */
export function fingerprintStallEvidence(evidence: StallEvidence): string {
  const material = JSON.stringify({
    freshCount: evidence.freshCount,
    excludedByReason: sortedEntries(evidence.excludedByReason),
    hasNewOwnedPr: evidence.hasNewOwnedPr,
    prStates: [...evidence.prStates].sort(),
    shardHash: evidence.shardHash,
  });
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** A stable hash of the parts of a task's own shard that a `retire`/`amend` disposition would be
 *  answering ABOUT — its acceptance proofs, declared files and operator note — never `status`/
 *  `attempts`, which move on every dispatch and would otherwise make the fingerprint churn once
 *  per attempt instead of once per actual plan edit (defeating the dedup above). */
export function stallShardFingerprint(task: Pick<Task, "acceptance" | "files" | "note" | "rationale">): string {
  const material = JSON.stringify({
    acceptance: task.acceptance ?? null,
    files: task.files ?? null,
    note: task.note ?? null,
    rationale: task.rationale ?? null,
  });
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * design (i): reads the evidence and decides. A cheap, ORDERED set of rules — never a model call,
 * never a network read of its own (every input is handed in) — so it is safe to run on every
 * circuit-break, not merely the ones that already justify a human's attention.
 */
export function decideStallVerdict(evidence: StallEvidence): StallVerdict {
  // A merged PR in the projection may mean the credit read missed progress. `hasNewOwnedPr`
  // merely means SOME pr.opened row exists, possibly before the current failed streak; it
  // cannot substantiate this diagnosis on its own.
  if (evidence.prStates.includes("merged")) {
    return {
      kind: "amend",
      reason: "a PR for this task appears merged in the projection — inspect its credit before treating this as a stall",
    };
  }

  const excludedTotal = Object.values(evidence.excludedByReason).reduce((a, b) => a + b, 0);
  const onlyOrphaned =
    excludedTotal > 0 && Object.keys(evidence.excludedByReason).every((reason) => reason === "orphaned_run");
  // Every excluded dispatch was an orphaned run (a worker that died mid-attempt, never a
  // terminal verdict) and nothing genuinely fresh remains: this is infrastructure noise, not a
  // real stall. This is a recommendation for review; the breaker remains tripped.
  if (onlyOrphaned && evidence.freshCount <= 0) {
    return {
      kind: "requeue",
      note: `${excludedTotal} excluded dispatch(es) were all orphaned runs (no completed attempt) — inspect for a fresh try`,
    };
  }

  // A closed unmerged PR is observed, none is open now, and the breaker's own scan excluded
  // nothing. This projection does not prove EVERY attempt was abandoned; retire is a candidate
  // for the offline replay to inspect.
  const prStateSet = new Set(evidence.prStates);
  if (prStateSet.has("closed_unmerged") && !prStateSet.has("open") && excludedTotal === 0 && evidence.freshCount > 0) {
    return {
      kind: "retire",
      reason: "a PR is observed closed unmerged and none open — inspect all attempts before retiring the task",
    };
  }

  return {
    kind: "escalate",
    owner: "operator",
    reason:
      `${evidence.freshCount} dispatch(es) with no new owned PR since ` +
      `(excluded: ${JSON.stringify(evidence.excludedByReason)}, pr states: ${JSON.stringify([...prStateSet])}) — ` +
      "no cheap disposition applies",
  };
}

/** Read a prior verdict only when the row has every field needed for its kind. An incomplete
 *  marker is not proof that verification finished, so the caller recomputes and records it. */
function storedStallVerdict(row: Record<string, unknown>): StallVerdict | undefined {
  switch (row.disposition) {
    case "amend":
    case "retire":
      return typeof row.reason === "string" ? { kind: row.disposition, reason: row.reason } : undefined;
    case "requeue":
      return typeof row.note === "string" ? { kind: "requeue", note: row.note } : undefined;
    case "escalate":
      return typeof row.owner === "string" && typeof row.reason === "string"
        ? { kind: "escalate", owner: row.owner, reason: row.reason }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The whole verb: fingerprint the evidence, skip a re-verify iff THIS exact fingerprint was
 * already logged for THIS task (repo-scoped, `matchesRepoScopedTask` — the same cross-repo dedup
 * discipline `escalateCircuitBreak` itself uses), otherwise decide and ledger the verdict.
 *
 * NEVER calls `escalateCircuitBreak` or any other escalation — design (ii): this cannot approve
 * or bypass a gate. The caller keeps the existing backstop page for every verdict during the
 * offline-first stage; the ledger row supports later comparison with operator resolutions.
 */
export function verifyStalledTask(
  taskId: string,
  evidence: StallEvidence,
  ctx: { repo: string; ledgerPath: string; runId: string },
): StallVerifierResult {
  const fingerprint = fingerprintStallEvidence(evidence);
  const rows = readLedgerLines(ctx.ledgerPath);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.step !== STALL_VERIFIED_STEP || row.fingerprint !== fingerprint || !matchesRepoScopedTask(row, ctx.repo, taskId)) continue;
    const priorVerdict = storedStallVerdict(row);
    if (priorVerdict) return { fingerprint, verdict: priorVerdict, alreadyVerified: true };
  }
  const verdict = decideStallVerdict(evidence);
  appendLedger(ctx.ledgerPath, {
    run_id: ctx.runId,
    task_id: taskId,
    repo: ctx.repo,
    step: STALL_VERIFIED_STEP,
    fingerprint,
    disposition: verdict.kind,
    ...(verdict.kind === "amend" || verdict.kind === "retire" ? { reason: verdict.reason } : {}),
    ...(verdict.kind === "requeue" ? { note: verdict.note } : {}),
    ...(verdict.kind === "escalate" ? { owner: verdict.owner, reason: verdict.reason } : {}),
  });
  return { fingerprint, verdict, alreadyVerified: false };
}

/** One attributable attempt the dispatch-break judge reads: a run's terminal verdict that no exclusion names. */
export interface DispatchBreakAttempt { runId: string; verdict: string; reason?: string; costUsd?: number }

/** The dispatch-break judge's whole input — the attempts since the streak last reset, and its own earlier rulings. */
export interface DispatchBreakInput {
  taskId: string;
  title?: string;
  freshCount: number;
  excludedByReason: Readonly<Record<string, number>>;
  attempts: DispatchBreakAttempt[];
  priorRulings: Array<{ decision: string; reason: string }>;
  stall: StallVerdict;
}
export type DispatchBreakJudge = (input: DispatchBreakInput) => Promise<FixProgressVerdict | undefined>;

/** The attributable terminal verdicts since `taskId`'s streak last reset — what the breaker counted. */
export function dispatchBreakAttempts(rows: ReadonlyArray<Record<string, unknown>>, taskId: string): DispatchBreakAttempt[] {
  let attempts: DispatchBreakAttempt[] = [];
  for (const row of rows) {
    if (row.task_id !== taskId) continue;
    if (isDispatchStreakReset(row)) {
      attempts = [];
      continue;
    }
    if (row.step !== "verdict" || typeof row.run_id !== "string" || streakRefusal(row) !== undefined) continue;
    attempts.push({ runId: row.run_id, verdict: String(row.verdict),
      ...(typeof row.reason === "string" ? { reason: row.reason.slice(0, 300) } : {}),
      ...(typeof row.cost_usd === "number" ? { costUsd: row.cost_usd } : {}) });
  }
  return attempts;
}

/**
 * W1-T7742 — THE BREAKER'S BOUND ASKS A JUDGE; IT IS NOT A WALL. When the streak breaker trips, the
 * fix lane's progress-judge pattern decides whether the attempts so far justify more: `continue` (or
 * `change-approach`) writes a {@link DISPATCH_BREAKER_JUDGED_STEP} row that resets the streak like an
 * `rmd release`, so the task dispatches next tick; `escalate` keeps the trip and its page. An absent,
 * throwing or unparseable judge escalates — the backstop is never weaker than before — and is not
 * cached, so the next process asks again; a ruling is asked once per observed state.
 */
export async function judgeDispatchBreak(
  task: Pick<Task, "id" | "title">,
  evidence: Pick<StallEvidence, "freshCount" | "excludedByReason">,
  stall: StallVerdict,
  ctx: { repo: string; ledgerPath: string; runId: string; judge?: DispatchBreakJudge },
): Promise<"continue" | "escalate"> {
  const rows = readLedgerLines(ctx.ledgerPath);
  const attempts = dispatchBreakAttempts(rows, task.id);
  const observed = `${task.id}:fresh=${evidence.freshCount}:last=${attempts.at(-1)?.runId ?? "none"}`;
  const own = rows.filter((row) => row.step === DISPATCH_BREAKER_JUDGED_STEP && matchesRepoScopedTask(row, ctx.repo, task.id));
  const settled = own.findLast((row) => row.observed_state === observed && (row.decision === "continue" || row.decision === "escalate"));
  if (settled) return settled.decision as "continue" | "escalate";
  let verdict: FixProgressVerdict | undefined;
  let failure = "dispatch-break judge is not wired";
  try {
    verdict = await ctx.judge?.({ taskId: task.id, title: task.title, freshCount: evidence.freshCount,
      excludedByReason: evidence.excludedByReason, attempts, stall,
      priorRulings: own.map((row) => ({ decision: String(row.decision), reason: String(row.reason ?? "") })) });
    if (ctx.judge && !verdict) failure = "absent or unparseable dispatch-break verdict";
  } catch (error) {
    failure = `dispatch-break judgment failed: ${String((error as Error)?.message ?? error)}`;
  }
  const decision = verdict === undefined ? "unavailable" : verdict.verdict === "escalate" ? "escalate" : "continue";
  appendLedger(ctx.ledgerPath, { run_id: ctx.runId, task_id: task.id, repo: ctx.repo, step: DISPATCH_BREAKER_JUDGED_STEP,
    observed_state: observed, decision, fresh_count: evidence.freshCount, reason: verdict?.reason ?? failure,
    ...(verdict?.verdict === "change-approach" ? { approach: verdict.approach } : {}) });
  return decision === "continue" ? "continue" : "escalate";
}
