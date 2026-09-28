import { createHash } from "node:crypto";
import { appendLedger, matchesRepoScopedTask } from "./ledger.js";
import type { Task } from "./plan.js";
import { readLedgerLines } from "./status.js";

/**
 * W1-T4678: A CIRCUIT-BROKEN TASK PAGES THE OPERATOR WITH NO DIAGNOSIS.
 *
 * `escalation-catalogue.ts`'s `escalateCircuitBreak` fires the instant `nextRunnable`'s breaker
 * trips, straight to a needs-human issue — W1-T2487 found 26 of 50 blocked tasks name no
 * disposition, and 2026-09-28 W1-T3116's breaker issue #7432 would have been answered "correct
 * the credit" although all 7 of its proofs fail on main. This module is the cheap-lane read
 * BEFORE that page: it looks at the same evidence a human would (breaker counts, refusal
 * reasons, PR state, whether the task's own shard changed since the last read) and decides
 * which of four dispositions applies, so the escalation that DOES fire (when one does) already
 * carries a diagnosis instead of a bare "dispatch halted".
 *
 * WHAT THIS CANNOT DO (design (ii)): decide whether the task dispatches. The breaker's own gate
 * (`nextRunnable`/`isCircuitTripped`) is untouched by this module and stays tripped regardless
 * of the verdict below — `amend`/`retire`/`requeue` change what the NEXT human or rung sees,
 * never whether THIS run's dispatch proceeds. That is also why this module never calls
 * `escalateCircuitBreak` itself: the caller decides, per the verdict, whether the backstop page
 * still fires.
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
  /** `DispatchBreakerDetail.hasNewOwnedPr` — a `pr.opened` line exists for this task. */
  hasNewOwnedPr: boolean;
  /** PR state(s) observed for this task since the breaker tripped, cheapest-projection read —
   *  `"open"`, `"merged"`, `"closed_unmerged"`, or empty when nothing is known. */
  prStates: readonly string[];
  /** A hash of the task's own plan-shard material (acceptance/files/note) — changes the moment an
   *  operator or Architect amends the proof, so an amended task reads as NEW evidence rather than
   *  silently reusing a stale verdict. */
  shardHash: string;
}

/** The four outcomes design (i) names. `escalate` is the only one that still pages a human — the
 *  other three are dispositions the caller can act on (or log) without opening an issue. */
export type StallVerdict =
  | { kind: "amend"; reason: string }
  | { kind: "retire"; reason: string }
  | { kind: "requeue"; note: string }
  | { kind: "escalate"; owner: string; reason: string };

export interface StallVerifierResult {
  fingerprint: string;
  verdict: StallVerdict;
  /** True when THIS fingerprint was already verified (a prior `STALL_VERIFIED_STEP` ledger line
   *  matched) — the verdict is still returned (pure re-derivation of the same evidence), but no
   *  second ledger line was written; design (ii)'s "never verified twice". */
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
  // A PR for this task actually merged (or the breaker's own scan already saw a fresh owned PR)
  // despite the breaker reading tripped: the credit/ownership assert missed it — the W1-T3116
  // shape this task's rationale names, but inverted (there the credit read was RIGHT and the
  // recommendation was wrong; here a wrong credit read is exactly what "amend" is for).
  if (evidence.hasNewOwnedPr || evidence.prStates.includes("merged")) {
    return {
      kind: "amend",
      reason:
        "a PR for this task appears to have merged (or the breaker's own ledger scan already saw " +
        "a fresh owned PR) — amend the credit/ownership read before treating this as a stall",
    };
  }

  const excludedTotal = Object.values(evidence.excludedByReason).reduce((a, b) => a + b, 0);
  const onlyOrphaned =
    excludedTotal > 0 && Object.keys(evidence.excludedByReason).every((reason) => reason === "orphaned_run");
  // Every excluded dispatch was an orphaned run (a worker that died mid-attempt, never a
  // terminal verdict) and nothing genuinely fresh remains: this is infrastructure noise, not a
  // real stall — clear it and let the next pass try again, with a note saying why.
  if (onlyOrphaned && evidence.freshCount <= 0) {
    return {
      kind: "requeue",
      note: `${excludedTotal} excluded dispatch(es) were all orphaned runs (no completed attempt) — requeued for a fresh try, not escalated`,
    };
  }

  // Every attempt opened and closed a PR unmerged, and none is open now, and the breaker's own
  // scan excluded nothing (so no orphaned/indeterminate noise is muddying the read): the work was
  // attempted, judged, and abandoned by every dispatch — nothing left for a human to unblock.
  const prStateSet = new Set(evidence.prStates);
  if (prStateSet.has("closed_unmerged") && !prStateSet.has("open") && excludedTotal === 0 && evidence.freshCount > 0) {
    return {
      kind: "retire",
      reason: "every dispatch opened and closed a PR unmerged with no owned PR since — the task reads abandoned, not blocked",
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

/**
 * The whole verb: fingerprint the evidence, skip a re-verify iff THIS exact fingerprint was
 * already logged for THIS task (repo-scoped, `matchesRepoScopedTask` — the same cross-repo dedup
 * discipline `escalateCircuitBreak` itself uses), otherwise decide and ledger the verdict.
 *
 * NEVER calls `escalateCircuitBreak` or any other escalation — design (ii): this cannot approve
 * or bypass a gate, including the escalation gate. The caller reads `.verdict.kind` and decides
 * whether the backstop page still fires (today: only on `"escalate"`).
 */
export function verifyStalledTask(
  taskId: string,
  evidence: StallEvidence,
  ctx: { repo: string; ledgerPath: string; runId: string },
  deps: {
    readLedgerLines?: (path: string) => ReturnType<typeof readLedgerLines>;
    appendLedger?: typeof appendLedger;
  } = {},
): StallVerifierResult {
  const readLines = deps.readLedgerLines ?? readLedgerLines;
  const append = deps.appendLedger ?? appendLedger;
  const fingerprint = fingerprintStallEvidence(evidence);
  const alreadyVerified = readLines(ctx.ledgerPath).some(
    (l) => l.step === STALL_VERIFIED_STEP && l.fingerprint === fingerprint && matchesRepoScopedTask(l, ctx.repo, taskId),
  );
  const verdict = decideStallVerdict(evidence);
  if (!alreadyVerified) {
    append(ctx.ledgerPath, {
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
  }
  return { fingerprint, verdict, alreadyVerified };
}
