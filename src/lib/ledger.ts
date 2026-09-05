import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { defaultIsPidAlive, parseDrainLockInfo, type DrainLockInfo } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock, type FileIdentity } from "./fs-race-safe.js";
import { resolveProducerIdentity, type ProducerIdentity } from "./producer-identity.js";

/** Append-only NDJSON ledger (MASTER-PLAN §9). One JSON object per line, keyed by task id; `ts` and
 *  `host` are stamped at write time. Every worker and brain-plane call spreads the same telemetry
 *  shape onto its line via {@link import("./worker.js").workerLedgerFields} (W1-T6). */
export interface LedgerLine {
  run_id: string;
  task_id: string;
  step: string;
  [k: string]: unknown;
}

/**
 * True for a spawn-INFRASTRUCTURE refusal (worker.ts's `ClaudeToolchainBlockedError`), duck-typed
 * on a string tag rather than `instanceof`, so this module keeps its "fs + JSON only" contract. It
 * fires before the SDK subprocess launches, so no worker ran and nothing was billed, and
 * `runFixRung` gates strike eligibility on it (see {@link isRealStrike}).
 * Why: a spawn-ENOENT crash once debited a strike on a worker that never ran (W1-T127, #212/#213;
 * docs/forensics/ledger.md#isspawninfrablockederror).
 */
export function isSpawnInfraBlockedError(err: unknown): err is { reasonClass: "blocked_toolchain"; message: string } {
  return typeof err === "object" && err !== null && (err as { reasonClass?: unknown }).reasonClass === "blocked_toolchain";
}

// ── W1-T429: task-id-keyed decision reads are repo-blind ────────────────────────────────────
// Only `run.start` carries a `repo:` dimension, and the fleet's plans share one id scheme, so a
// second driven repo makes one repo's read count against the other's history of the same id.

/** The one key-renderer every task-id-keyed decision read and write goes through: `<repo>:<task_id>`
 *  when `repo` is known, else the BARE `task_id` (W1-T429 design note i). The bare form is the
 *  deliberate legacy fallback, so a line ledgered before this key existed keeps matching. */
export function repoScopedTaskKey(repo: string | undefined, taskId: string): string {
  return repo ? `${repo}:${taskId}` : taskId;
}

/** True iff `line` records a decision for the same (repo, task_id) pair — the read side of
 *  {@link repoScopedTaskKey}. Lines whose own `repo` differs never match. A line carrying no `repo`
 *  must still be found by a read that knows one, so an upgrade never orphans a dedup marker (design
 *  note iii). Falsifier, both directions: test/ledger-repo-scope.test.ts. */
export function matchesRepoScopedTask(line: { task_id?: unknown; repo?: unknown }, repo: string | undefined, taskId: string): boolean {
  if (typeof line.task_id !== "string") return false;
  const lineRepo = typeof line.repo === "string" ? line.repo : undefined;
  if (repoScopedTaskKey(lineRepo, line.task_id) === repoScopedTaskKey(repo, taskId)) return true;
  return lineRepo === undefined && line.task_id === taskId;
}

/** Cost-line tag (W1-T127 design note iii). `"task"` is the implicit attribution for real billed
 *  work; `"infra"` marks a $0 line logged for a spawn-infrastructure refusal, so a per-task rollup
 *  can exclude it while a fleet-health rollup still finds it. See {@link isSpawnInfraBlockedError}. */
export const LEDGER_COST_TAG_TASK = "task" as const;
export const LEDGER_COST_TAG_INFRA = "infra" as const;
export type LedgerCostTag = typeof LEDGER_COST_TAG_TASK | typeof LEDGER_COST_TAG_INFRA;

/** THE #212 CONJUNCTION (W1-T127 design note i): a strike is recorded only where a worker RAN and a
 *  judgment was POSTED. Both halves are asserted, never either, so this cannot degrade to one half
 *  of the conjunction it checks. Pure and total; callers supply what they observed. */
export function isRealStrike(evidence: { workerRan: boolean; judgmentPosted: boolean }): boolean {
  return evidence.workerRan && evidence.judgmentPosted;
}

/**
 * Append one line. The record is issued as exactly ONE `writeSync` and the kernel's acceptance is
 * checked, so a writer's record is never split across two syscalls with another appender's line in
 * the gap. `O_APPEND` already makes concurrent appenders safe; this is NOT a lock (W1-T206). A
 * short write is LOUD, never retried. Falsifier: test/ledger-atomic.test.ts.
 * Why: the read-side torn-line contract, and why a lock was rejected (W1-T206;
 * docs/forensics/ledger.md#appendledger).
 *
 * `identity` stamps the writing machine onto every row under the same `host` key this repo's
 * lock-holder records use. Appended LAST so no caller shifts; injectable only so one test can
 * drive two identities in one process (W1-T972, test/ledger-host-identity.test.ts).
 */
export function appendLedger(
  path: string,
  line: LedgerLine,
  opts: { ceilingBytes?: number; identity?: () => string } = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const record = { ts: new Date().toISOString(), host: (opts.identity ?? hostname)(), ...line };
  const buf = Buffer.from(JSON.stringify(record) + "\n", "utf8");
  const fd = openSync(path, "a");
  try {
    const written = writeSync(fd, buf, 0, buf.length);
    if (written !== buf.length) {
      console.error(
        `ledger: short write for ${path} (${written}/${buf.length} bytes written) — ` +
          `the record may be torn; see readLedgerLines' torn-line handling`,
      );
    }
  } finally {
    closeSync(fd);
  }
  // W1-T209: opportunistic, lazy rotation — the only place the ledger grows, so the only place
  // that needs to notice it has grown past the ceiling. One extra statSync on every under-ceiling
  // call; the full read-and-rewrite cost only on the call that crosses it.
  if (ledgerExceedsRotationCeiling(path, opts.ceilingBytes)) {
    rotateLedger(path, { ceilingBytes: opts.ceilingBytes });
  }
}

/**
 * Append a line on behalf of a PSEUDO sender — a producer that is not itself a plan task (the
 * daemon loop, retro, drain, sweep; producer-identity.ts holds the closed registry). An undeclared
 * sender is REFUSED rather than becoming a new ungoverned key. Resolution is a GATE ONLY:
 * `task_id` is written exactly as `senderId` was passed, and no historical row is rewritten by
 * this path (W1-T2495).
 */
export function appendProducerLedger(
  path: string,
  senderId: string,
  line: Omit<LedgerLine, "task_id">,
  opts: { ceilingBytes?: number; identity?: () => string } = {},
): ProducerIdentity {
  const identity = resolveProducerIdentity(senderId);
  appendLedger(path, { ...line, task_id: senderId } as LedgerLine, opts);
  return identity;
}

// ── THE ACCOUNT DIMENSION (W1-T268, MASTER-PLAN §9) ─────────────────────────
// appendLedger only ever appends, so a line written before `account_label` existed can never be
// retrofitted with one. Any accounting built on the label below has a HARD START DATE and must
// REFUSE an older line rather than guess (docs/forensics/ledger.md#account_attribution_epoch).

/** THE ACCOUNT ATTRIBUTION EPOCH — the boot that re-provisioned the worker keychain store after the
 *  operator's manual account switch (W1-T265). Every earlier line belongs to the account active
 *  before that switch and none says so. Named so a reader binds to the value, not a copy. */
export const ACCOUNT_ATTRIBUTION_EPOCH = "2026-07-31T16:39:00.582Z";

/** One account's summed, attributed spend — an entry of {@link AccountSpendSummary.byAccount}. */
export interface AccountSpendGroup {
  accountLabel: string;
  totalCostUsd: number;
  lineCount: number;
}

/**
 * Spend {@link groupSpendByAccount} REFUSED to attribute to any account, split by why —
 * visible and countable, never silently dropped or silently credited to whichever label
 * happens to be current.
 */
export interface RefusedSpend {
  /** Lines older than {@link ACCOUNT_ATTRIBUTION_EPOCH} (or with no parseable `ts`, which
   *  is treated identically — an unattributable line is never guessed to be recent). */
  preEpochCount: number;
  preEpochCostUsd: number;
  /** Lines AT/AFTER the epoch that still carry no `account_label` — a caller that bypassed
   *  the ledgering helpers ({@link import("./worker.js").workerLedgerFields} and friends). */
  unlabelledCount: number;
  unlabelledCostUsd: number;
}

/** Result of {@link groupSpendByAccount}. */
export interface AccountSpendSummary {
  byAccount: AccountSpendGroup[];
  refused: RefusedSpend;
}

/** Group every spend-carrying line by `account_label`, REFUSING — never guessing — a line older
 *  than {@link ACCOUNT_ATTRIBUTION_EPOCH} or one carrying spend with no label (W1-T268 note 3). A
 *  line with neither `total_cost_usd` nor `cost_usd` is skipped: refusal is for spend this function
 *  chose not to credit. Falsifier: test/ledger-account-dimension.test.ts. */
export function groupSpendByAccount(lines: readonly LedgerLine[]): AccountSpendSummary {
  const epochMs = Date.parse(ACCOUNT_ATTRIBUTION_EPOCH);
  const totals = new Map<string, { totalCostUsd: number; lineCount: number }>();
  const refused: RefusedSpend = { preEpochCount: 0, preEpochCostUsd: 0, unlabelledCount: 0, unlabelledCostUsd: 0 };

  for (const line of lines) {
    const cost =
      typeof line.total_cost_usd === "number"
        ? line.total_cost_usd
        : typeof line.cost_usd === "number"
        ? line.cost_usd
        : undefined;
    if (cost === undefined) continue; // not a spend-carrying line — no claim to refuse or credit

    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const tsMs = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(tsMs) || tsMs < epochMs) {
      refused.preEpochCount++;
      refused.preEpochCostUsd += cost;
      continue;
    }

    const label = typeof line.account_label === "string" && line.account_label.length > 0 ? line.account_label : undefined;
    if (!label) {
      refused.unlabelledCount++;
      refused.unlabelledCostUsd += cost;
      continue;
    }

    const entry = totals.get(label) ?? { totalCostUsd: 0, lineCount: 0 };
    entry.totalCostUsd += cost;
    entry.lineCount++;
    totals.set(label, entry);
  }

  const byAccount = [...totals.entries()].map(([accountLabel, v]) => ({ accountLabel, ...v }));
  return { byAccount, refused };
}

/** SIZE CEILING (W1-T209, recon R-9). Below the size a real never-rotated ledger reaches, so one
 *  actually crosses it, and above any single run's appends, so a rotating ledger never thrashes.
 *  Why: the ledger measured at intake (docs/forensics/ledger.md#ledger_rotation_ceiling_bytes). */
export const LEDGER_ROTATION_CEILING_BYTES = 4 * 1024 * 1024; // 4 MiB

/** W1-T2244: the one row an operator produces when they act on a risk-judge escalation instead of
 *  taking its "merge it by hand" escape hatch in silence. Written by `recordRiskOverride`, read
 *  back head-bound by {@link riskOverrideFromLedger} so a record never outlives the diff it judged
 *  (design viii). RECORDING ONLY: nothing here decides dispatch or merge. */
export const RISK_OVERRIDE_RECORDED_STEP = "panel.risk_override_recorded";

/** W1-T2244 (design vii): the two signals an override can carry, OPPOSITE for a calibrator.
 *  `judge_wrong` says the escalation was a miscalibration; `risk_accepted` says it was correct and
 *  the operator knowingly took the cost. One "overridden" flag would collapse both into judge error.
 *  Free text (`reason`) rides alongside, never replacing it. */
export const RISK_OVERRIDE_REASON_CLASSES = ["judge_wrong", "risk_accepted"] as const;
export type RiskOverrideReasonClass = (typeof RISK_OVERRIDE_REASON_CLASSES)[number];

/** W1-T2244 (design vi): what the operator actually did with the escalated head — a closed set
 *  for the same reason {@link RISK_OVERRIDE_REASON_CLASSES} is closed. */
export const RISK_OVERRIDE_DISPOSITIONS = ["merged_by_hand", "redispatched", "abandoned"] as const;
export type RiskOverrideDisposition = (typeof RISK_OVERRIDE_DISPOSITIONS)[number];

/**
 * The ledger steps a DECIDING reader — never a merely-displaying one — consults to answer "has this
 * already happened" or "how many times". Such a line survives rotation, bounded only by
 * {@link MAX_RETAINED_LINES_PER_STEP}.
 *
 * THE INVARIANT: for these steps THE LINE IS THE BOUND. Archiving one silently resets the breaker,
 * dedup or cap it backs, so the reader re-fires an escalation, re-arms a refused head, or re-files
 * work it already did. Each entry below names its reader and what losing it would do.
 *
 * THIS LIST IS NOT SELF-CERTIFYING, and it has fallen behind its consumers once already.
 * test/ledger-rotation.test.ts re-derives the set from every consumer's own source on every run;
 * treat that test, not this comment, as the source of truth. Telemetry and display-only reads are
 * archived, operator-visible history gets {@link RENDER_RELEVANT_LEDGER_STEPS}, and `daemon.boot`
 * and `deploy.*` are members but health HEARTBEATS, bounded by recency instead.
 *
 * Why: the per-consumer table, the W1-T244 incident and the exclusion arguments —
 * docs/forensics/ledger.md#decision_relevant_ledger_steps.
 */
export const DECISION_RELEVANT_LEDGER_STEPS: ReadonlySet<string> = new Set([
  "run.start",
  "pr.opened",
  // W1-T2594: provider-diverse reviewer routing resolves this row by exact task + PR + head.
  // Rotating it away would make an unchanged head route differently after maintenance.
  "pr.head_provider",
  // W1-T2425: `seedCountFromCircuitBreak` (status.ts) reads this row's `freshCount` for the
  // baseline a restarted process cannot carry; archived away, a rotation un-trips a tripped breaker.
  "dispatch.circuit_broken",
  "dispatch.circuit_broken.escalated",
  // W1-T316: `escalateLifetimeCapExceeded`'s (run-task.ts) dedup marker, written whether or not
  // delivery succeeds; dropping it re-opens a duplicate lifetime-cap escalation.
  "dispatch.lifetime_capped.escalated",
  // W1-T215: `escalateCrashLoop`'s (run-task.ts) dedup marker, read per boot; dropping it re-opens
  // one duplicate needs-human issue per boot, roughly one a minute while the storm lasts.
  "daemon.crashloop.escalated",
  "daemon.headroom_reserve.escalated",
  // `escalateHeadroomParkCeiling` (run-task.ts) compares this row against the newest
  // `daemon.headroom`; dropping it re-pages once per daemon boot while the probe stays broken.
  "daemon.headroom.park_ceiling.escalated",
  // …and the row that ENDS a blind stretch, which that dedup compares against. Retention costs
  // nothing (`isRenderRelevantStep` keeps it already); this entry records the decision read.
  "daemon.headroom",
  // W1-T372: `escalateQuotaExhaustion`'s (run-task.ts) dedup marker, read per bucket; dropping it
  // re-opens one duplicate quota-exhaustion notice per tick while the bucket stays exhausted.
  "daemon.quota_exhausted.escalated",
  // W1-T1082: `escalateDiskHeadroomBreach`'s (run-task.ts) dedup marker, compared against an
  // episode window; it is what stops a daemon RESTART mid-episode from re-opening the issue.
  "daemon.disk_headroom.escalated",
  "dispatch.starvation.escalated",
  // `escalateStarvationCleared`'s (run-task.ts) referent boundary, read alongside
  // "dispatch.starvation.escalated"; losing it re-closes a stale issue or skips a new episode.
  "dispatch.starvation.cleared",
  "verdict",
  "verdict.merged",
  "correction.provenance",
  "sweep.disposed",
  "escalation.issue_opened",
  // impl-FL: daemon.ts counts these back to decide whether a reset string was already announced,
  // so the line IS the dedup key. Registered by exact name — a dotted child inherits nothing.
  "daemon.usage_reset_unrecognised",
  // impl-EV: ops.ts's `priorReconciledAlertFeedbackIds` counts these to decide whether an
  // alert-feedback entry was already closed; the local entry stays `new`, so the line IS the dedup.
  "ops.feedback_reconciled",
  "ratify.approved",
  "ratify.reframed",
  // W1-T2604: inbox.ts's `declinedReasonInLedger` reads this row — the decline's one receipt.
  // Rotating it away un-declines a proposal and re-offers ratify on something already refused.
  "panel.proposal_declined",
  "fix.dispatch",
  "fix.review",
  // W1-T1110: sweep.ts's `fixRungStalledWithoutNewHead` reads "fix.ci_not_green"/"fix.resolved"
  // beside "fix.review"; losing either re-strands the PR against a head nothing will move again.
  // W1-T1211: `runIsAwaitingExternal` (run-task.ts) reads "run.awaiting_external", written once per
  // wait; losing it reads a WAITING run as WORKING and freezes the fix rung for that run.
  "run.awaiting_external",
  "fix.ci_not_green",
  "fix.resolved",
  // W1-T1095: `fixRebaseAlreadySpent` (run-task.ts) reads this to enforce "at most one rebase per
  // blocked PR"; no timer backs it, so losing it restores an unbounded rebase-and-retry.
  "fix.rebased",
  // W1-T2436: `priorPrerequisitePrFor` (run-task.ts) folds these by `pr_url`; the ledger is that
  // capability's only memory, so archived away the rung opens a SECOND prerequisite PR.
  "fix.prerequisite_opened",
  "dep-review.decided",
  "review.posted",
  "review.post_refused",
  // W1-T913: `lastPendingReviewStatusFromLedger` (review.ts) reads this back for per-head
  // idempotence AND the staleness clock; dropping it makes a review stalled for hours read as fresh.
  "review.pending_posted",
  // W1-T1017: W1-T322's ships-unwired advisory floor line. The deciding reader is not code — it is
  // the operator adjudicating W1-T323's advisory-versus-blocking flip against this exact corpus.
  // Why: rotation was dropping 95%+ of these rows (W1-T1017; docs/forensics/ledger.md).
  "review.unwired_advisory",
  "automerge.capped_override_granted",
  // W1-T2244: the risk-judge escalation's override record, beside its capped-verdict sibling.
  // `panel.escalation_marked_handled` stays out: it carries nothing a calibrator could read back.
  RISK_OVERRIDE_RECORDED_STEP,
  "daemon.boot",
  // impl-DF: the idle rung's reason tally. A HUMAN reads it to tell "starved of work" from
  // "everything filtered"; it is emitted only on change, so rotation would drop a long idle's cause.
  "daemon.idle_reasons",
  "sweep.post_fix_redriven",
  // W1-T970: sweep.ts's `priorActionsFromLedger` builds a sha-keyed `riskRefused` set off this
  // step; losing it re-arms a head a risk judge explicitly refused.
  "risk_judge.escalated",
  // W1-T186: `priorActionsFromLedger` counts these to enforce ABSENT_REPUSH_CAP. The line IS the
  // bound — archived away, every rotation re-earns the PR another empty commit.
  "sweep.absent_repush",
  // `escalatePostReviewStall` (run-task.ts) counts these back for its episode key. `escalate()`
  // skips its dedup when no PR is named, so archiving this marker pages PER SWEEP TICK.
  "sweep.post_review.stalled.escalated",
  // `detectPostReviewStall` (sweep.ts) counts the run of `.failed` lines and RESETS on a `.done`,
  // so both decide. Without them a rotation mid-stall resets the run and the stall goes unnoticed.
  "sweep.post_review.done",
  "sweep.post_review.failed",
  // W1-T393 (MASTER-PLAN §11 D-10): retro.ts's `mutationGateLifetime` folds this into
  // `mutation-ratchet`'s LIFETIME record, so archiving it resets that figure on every rotation.
  "mutation.ratchet_verdict",
  // W1-T435: sweep.ts's `operatorVerdictEvidence` quotes a wrong or needs-follow-up steering note
  // into the next fix-rung dispatch — a DECIDING read (it drives the re-arm), not display-only.
  "operator_feedback",
  // W1-T470: `injectCoverageImprovementTask`'s dedup marker, read back via a ledger UNION rather
  // than the live file alone. Dropping it re-files the same debt profile on every red-band run.
  "coverage.improvement.filed",
  // W1-T2862: the source-size follow-up consumer reads this exact signature from the archive +
  // live ledger union before deciding whether the same maintainability obligation may file again.
  "source_size.followup.filed",
  // W1-T949: the reservation-REFUSAL record for each id-filing lane, carrying `id`/`ref`/`outcome`
  // as structured fields so "why did this filing open no PR" stays queryable a week later. Like
  // "review.unwired_advisory" the deciding reader is a HUMAN, so these never appear in the
  // derived-from-consumers test's scanned corpus — expected, not a gap.
  "triage.id_reservation_failed",
  "plan.id_reservation_failed",
  "approve.id_reservation_failed",
  // W1-T1029: `latestManualCompletion` (status.ts) reads this back for hand-execution credit. The
  // line IS the credit: archiving it re-parks every task depending on the one it credited.
  "manual.completed",
  // W1-T1000002: review.ts's `automergeHoldFromLedger` reads both back, "last one wins", with NO
  // head-sha binding — a hold must outlive a push. Dropping "hold_engaged" lifts a hold the operator
  // believes still stands; dropping "hold_released" re-freezes a PR they already released.
  "automerge.hold_engaged",
  "automerge.hold_released",
  // W1-T1215: `armRunIdFromLedger` (run-task.ts) reads these rows to name WHICH lane armed a PR
  // that merged behind a refused verdict; dropping them turns that attribution into "unattributed".
  "automerge.armed",
  // W1-T1212: run-task.ts derives `updatedForWorkflow` from this row's `stale_workflow` field;
  // dropping it re-selects the same stale-gate PR every pass, spending the head for nothing.
  "sweep.update_branch.updated",
  // W1-T1235: `latestGhRateLimitRefusalsFromLedger` (run-task.ts) reads the newest row per bucket
  // for `rmd status`'s GITHUB BUCKETS section. Kept here, not in the render set, because GitHub's
  // resets outlast RENDER_STEP_RETENTION_WINDOW_MS and an operator needs the LAST refusal however
  // old. Sparse by construction, so permanent retention costs nothing beyond the per-step cap.
  "automerge.rate_limit_refused",
  // W1-T2558: cost-anomaly.ts's idempotence marker — `alreadyLedgeredCostAnomalyRunIds` reads every
  // `cost.anomaly` row back to decide whether a run was already flagged; before this entry the
  // dedup worked only until the next rotation. Why: 471 raw rows collapsing to 45 run ids, one
  // re-flagged 26 times (W1-T2558; docs/forensics/ledger.md).
  "cost.anomaly",
  // KEEP THE W1-T964 TRIO LAST, immediately before the Set's close: test/ledger-rotation.test.ts
  // anchors its mutation check on those three lines followed by `]);` and asserts the needle occurs
  // EXACTLY once. A block appended after them silently breaks that anchor.
  // W1-T964: `mineFollowups` (retro.ts) matches a harvest mark back to its source entry to decide
  // whether to mint a fresh candidate, and a followup must survive PAST either recency window. All
  // three must land TOGETHER: source without marks RE-MINTS an adjudicated entry, marks without
  // source LOSES it. Falsifier: test/followup-rotation-idempotency.test.ts.
  "report.followups",
  "followup.harvested",
  "followup.deduped",
]);

/** W1-T2244: one recorded operator override of a risk-judge escalation. The judged VERDICT and
 *  CONFIDENCE are carried VERBATIM, copied at write time and never re-derived, so the row stays
 *  self-contained once the escalation itself has rotated away. */
export interface RiskOverrideRecord {
  taskId: string;
  issueUrl: string;
  headSha: string;
  verdict: "low" | "high";
  confidence: number;
  disposition: RiskOverrideDisposition;
  reasonClass: RiskOverrideReasonClass;
  reason?: string;
}

/**
 * Recover the most recent {@link RISK_OVERRIDE_RECORDED_STEP} line for `taskId`, "last one wins" —
 * the idiom {@link import("./review.js").cappedOverrideFromLedger} uses for its sibling.
 * HEAD-BOUND (design viii): the caller's `headSha` must equal the row's own, or the row is skipped
 * as if absent, because an override that outlived the head it judged is evidence about a diff that
 * no longer exists. A row outside the closed disposition and reason-class sets is skipped too.
 * READ FOR DISPLAY ONLY (design ix/x) — nothing may call this to decide dispatch or merge.
 * Falsifier: test/risk-override-reader-refusals.test.ts.
 */
export function riskOverrideFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  headSha: string,
): RiskOverrideRecord | undefined {
  let found: RiskOverrideRecord | undefined;
  for (const line of lines) {
    if (line.step !== RISK_OVERRIDE_RECORDED_STEP || line.task_id !== taskId) continue;
    if (typeof line.head_sha !== "string" || line.head_sha !== headSha) continue;
    if (line.verdict !== "low" && line.verdict !== "high") continue;
    if (typeof line.confidence !== "number") continue;
    if (typeof line.issue_url !== "string") continue;
    if (typeof line.disposition !== "string" || !(RISK_OVERRIDE_DISPOSITIONS as readonly string[]).includes(line.disposition)) continue;
    if (typeof line.reason_class !== "string" || !(RISK_OVERRIDE_REASON_CLASSES as readonly string[]).includes(line.reason_class)) continue;
    found = {
      taskId,
      issueUrl: line.issue_url,
      headSha: line.head_sha,
      verdict: line.verdict,
      confidence: line.confidence,
      disposition: line.disposition as RiskOverrideDisposition,
      reasonClass: line.reason_class as RiskOverrideReasonClass,
      ...(typeof line.reason === "string" ? { reason: line.reason } : {}),
    };
  }
  return found;
}

/** Steps matched by PREFIX rather than enumerated — currently only `deploy.*` (deployer.ts's
 *  `runDeployCycle`). Prefix matching covers a future `deploy.*` step automatically, the same
 *  "derived, not a stale hardcoded list" doctrine {@link DECISION_RELEVANT_LEDGER_STEPS} states. */
const HEALTH_RELEVANT_LEDGER_STEP_PREFIXES: readonly string[] = ["deploy."];

/** True for `daemon.boot` and any `deploy.*` step — W1-T244's health-window-bounded steps
 *  (see {@link DECISION_RELEVANT_LEDGER_STEPS}'s doc for why these are NOT kept unconditionally
 *  like the rest of the decision-relevant set). */
function isHealthOrDeployStep(step: string): boolean {
  return step === "daemon.boot" || HEALTH_RELEVANT_LEDGER_STEP_PREFIXES.some((prefix) => step.startsWith(prefix));
}

/** How far back a health-window-bounded step survives rotation. Comfortably larger than any real
 *  health window here (deployer.ts's own default is 45s), so `assessBootHealth` never loses a line
 *  still inside its window, while a restart storm's boot count stays bounded rather than kept. */
export const HEALTH_STEP_RETENTION_WINDOW_MS = 15 * 60 * 1000;

/**
 * RENDER-RELEVANT, not decision-relevant: consulted by the console to render OPERATOR-VISIBLE
 * HISTORY, never to make a daemon-side decision. They get a recency-bounded category of their own
 * because a step added to the decision core is retained FOREVER. Each entry names its consumer, and
 * test/ledger-render-retention.test.ts re-derives the set from those consumers' own source. Why:
 * the ACCOUNT strip read "unknown" on a healthy fleet (docs/forensics/ledger.md#render_relevant_ledger_steps).
 */
export const RENDER_RELEVANT_LEDGER_STEPS: ReadonlySet<string> = new Set([
  "daemon.headroom",
  "console.kick_refused",
  "console.kick_dispatched",
  // W1-T282's LANE_START_STEPS (status.ts) let the NOW panel open a run on any lane's start, and
  // none was retained, so a long-running lane vanished from "currently running" at the next
  // rotation. This window equals `deriveRunState`'s 30-minute liveness bound, so a start ages out
  // exactly when NOW stops calling it live. `run.start` and `plan.start` are deliberately absent.
  "daemon.start",
  "drain.start",
  "retro.start",
  "serve.start",
  "triage.start",
  // THE GOVERNOR'S TWO "I CANNOT READ USAGE" SIGNALS, by exact name because `isRenderRelevantStep`
  // is a `Set.has` and a dotted child inherits nothing. A blind governor fails closed and idles the
  // fleet, and these are how it says so. The window suffices because `degraded` re-fires every tick
  // and each row's `consecutive_unreadable` states the duration. Protected for an unmerged
  // consumer, at a known cost.
  "daemon.headroom.degraded",
  "daemon.headroom.unavailable",
  // W1-T329: the two dispatch-deferring governors' heartbeats, written on every tick either defers
  // NEW dispatch, carrying the observed figure against its ceiling. Nothing in the dispatch path
  // re-reads them — sweep.ts's predicates are fresh each tick — so they exist purely so a human can
  // see WHY the fleet looks idle. account-usage.ts reads the newest line of each.
  "daemon.cost_governor",
  "daemon.queue_governor",
  // W1-T333: who, when, from and to for every console write to the daily-cost-ceiling override.
  // The CURRENT value is state read fresh by policy.ts, so this line is HISTORY, not a decision.
  "console.ceiling_override_written",
  // W1-T1237: the sweep's per-pass heartbeat, in NEITHER retention set before that task. BOTH by
  // exact name: doctor.ts's `judgeSweepLiveness` derives two faults from the PAIR.
  "sweep.pass",
  "sweep.summary",
]);

/** True for any step in {@link RENDER_RELEVANT_LEDGER_STEPS}. */
function isRenderRelevantStep(step: string): boolean {
  return RENDER_RELEVANT_LEDGER_STEPS.has(step);
}

/** How far back a render-relevant step survives rotation. SIZED FROM THE CONSUMER: account-usage.ts
 *  declares the ACCOUNT strip's staleness bound as `USAGE_CACHE_MAX_AGE_MS` (30 minutes), so less
 *  here would make the strip read "unknown" straight after a rotation. Restated rather than
 *  imported — account-usage.ts already depends transitively on this module. */
export const RENDER_STEP_RETENTION_WINDOW_MS = 30 * 60 * 1000;

// ── CONSOLE WRITE AUDIT: the daily-cost-ceiling override (W1-T333) ─────────────────────────────
//
// Who, when, from and to for every console write, queryable at runtime rather than only in git.
// `appendLedger` is append-only, so ONE LINE PER WRITE is the full history, never a summary.

/** The step name a console write to the daily-cost-ceiling override is ledgered under — see
 *  {@link RENDER_RELEVANT_LEDGER_STEPS}'s entry for this exact string for why it is render-, not
 *  decision-, relevant, and {@link appendDailyCostCeilingOverrideAudit} for what it carries. */
export const CEILING_OVERRIDE_WRITTEN_STEP = "console.ceiling_override_written";

/** One console write to the daily cost ceiling override, as ledgered — the who/when/from/to the
 *  operator asked for, plus the RESULTING effective value. `when` is deliberately not a field
 *  here: {@link appendLedger} stamps `ts` itself, at write time, so the line's own `ts` IS the
 *  "when" — a caller-supplied one could drift from the actual write instant it is meant to record. */
export interface DailyCostCeilingOverrideAudit {
  runId: string;
  taskId: string;
  /** Who performed the write — an operator identity/session label, never blank. */
  who: string;
  fromUsd: number;
  toUsd: number;
  /** The effective ceiling immediately after the write (per `policy.ts`'s
   *  `resolveDailyCostCeiling`) — ordinarily equal to `toUsd`, but recorded independently so a
   *  write that the store immediately refused to honor is still visible as a mismatch here rather
   *  than silently assumed to have taken effect. */
  effectiveUsd: number;
}

/** Ledger one console write to the daily cost ceiling override. The caller — the console WRITE
 *  control, which W1-T333 explicitly did not build — must invoke this alongside policy.ts's
 *  `writeDailyCostCeilingOverride`, so a write auditable but never applied cannot happen. */
export function appendDailyCostCeilingOverrideAudit(ledgerPath: string, audit: DailyCostCeilingOverrideAudit): void {
  appendLedger(ledgerPath, {
    run_id: audit.runId,
    task_id: audit.taskId,
    step: CEILING_OVERRIDE_WRITTEN_STEP,
    who: audit.who,
    from_usd: audit.fromUsd,
    to_usd: audit.toUsd,
    effective_usd: audit.effectiveUsd,
  });
}

/** Hard cap on how many lines of any single decision-relevant `step` {@link rotateLedger} retains,
 *  EXCLUDING `sweep.disposed` and the health-window steps, which carry their own bound. The core is
 *  otherwise UNBOUNDED, so over enough runs it alone exceeds the ceiling and every append re-rotates
 *  forever. Newest-N survive, because a consumer reads RECENT history only. Why: 80+ archives,
 *  bursts of 12 rotations a second, observed live (docs/forensics/ledger.md#max_retained_lines_per_step). */
export const MAX_RETAINED_LINES_PER_STEP = 200;

/** Minimal fs surface {@link ledgerExceedsRotationCeiling} and {@link rotateLedger} need,
 *  injectable so a test proves the ceiling check without ever touching a real file. */
export interface LedgerRotationFsDeps {
  existsSync: (path: string) => boolean;
  statSize: (path: string) => number;
}

const realRotationFs: LedgerRotationFsDeps = {
  existsSync: (path) => existsSync(path),
  statSize: (path) => statSync(path).size,
};

/** True iff `path` exists and is larger than `ceilingBytes` (default {@link
 *  LEDGER_ROTATION_CEILING_BYTES}) — an absent ledger never "exceeds" anything (nothing to
 *  rotate, same absence-is-not-proof-of-anything doctrine status.ts's readers already use). */
export function ledgerExceedsRotationCeiling(
  path: string,
  ceilingBytes: number = LEDGER_ROTATION_CEILING_BYTES,
  fsDeps: LedgerRotationFsDeps = realRotationFs,
): boolean {
  if (!fsDeps.existsSync(path)) return false;
  return fsDeps.statSize(path) > ceilingBytes;
}

/** One snapshot line, parsed ONCE and carried by reference through `rotateLedger`'s whole
 *  retention pipeline (classify → health-window → sweep dedup → per-step cap → convergence
 *  shed) so every pass can regroup/reorder freely and the final step still recovers original
 *  file order by identity, without re-parsing or fuzzy-matching raw text back to a line. */
interface ParsedLedgerLine {
  raw: string;
  json?: Record<string, unknown>;
  step?: string;
  /** `Date.parse(json.ts)` when `ts` is a valid ISO string; `undefined` otherwise — a line
   *  with no parseable timestamp is never guessed at (see the health-window/shed passes). */
  tsMs?: number;
}

function parseLedgerLine(raw: string): ParsedLedgerLine {
  try {
    const json = JSON.parse(raw.trim()) as Record<string, unknown>;
    const step = typeof json.step === "string" ? json.step : undefined;
    const tsMs = typeof json.ts === "string" ? Date.parse(json.ts) : NaN;
    return { raw, json, step, tsMs: Number.isFinite(tsMs) ? tsMs : undefined };
  } catch {
    return { raw };
  }
}

function readSyncRange(path: string, start: number, end: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(end - start);
    readSync(fd, buf, 0, end - start, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Writes `content` as ONE atomic unit: staged into a same-directory temp file with a single
 *  writeSync, then swapped in with a single renameSync, so a concurrent reader sees the whole old
 *  file or the whole new one. `content` accepts a `Buffer` (gzip's output, W1-T2482).
 *  `beforeRename` (R-1) runs with the stage fully written, immediately before the rename; returning
 *  `false` withdraws the swap and leaves the path as it was — how {@link rotateLedger} refuses to
 *  rename over a live file that is no longer the inode it snapshotted. */
function writeFileAtomic(path: string, content: string | Buffer, beforeRename?: () => boolean): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.rotate-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const fd = openSync(tmpPath, "w");
  try {
    const written = writeSync(fd, buf, 0, buf.length);
    if (written !== buf.length) {
      console.error(`ledger: short write staging ${tmpPath} for rotation of ${path} (${written}/${buf.length} bytes)`);
    }
  } finally {
    closeSync(fd);
  }
  if (beforeRename && !beforeRename()) {
    rmSync(tmpPath, { force: true }); // withdraw the stage; leave nothing behind
    return false;
  }
  renameSync(tmpPath, path);
  return true;
}

/** The whole live file read through ONE descriptor, with that descriptor's `fstat` identity, so
 *  `size`, `content` and `{dev, ino}` describe the same open file rather than three separate path
 *  re-resolutions. {@link rotateLedger} compares `identity` against a by-name `stat` right before
 *  its final rename: a mismatch means the path no longer holds the snapshotted file. */
function readSnapshotWithIdentity(path: string): { size: number; content: string; identity: FileIdentity } {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return { size: st.size, content: buf.toString("utf8"), identity: { dev: st.dev, ino: st.ino } };
  } finally {
    closeSync(fd);
  }
}

/** Sibling of the live ledger that serialises {@link rotateLedger} across processes,
 *  `<ledgerPath>.rotate.lock`. It ends in neither `.ndjson` nor `.ndjson.gz`, so ledger-grep.ts's
 *  `ledgerRotationEntries` never mistakes it for an archive — the same reason
 *  `writeFileAtomic`'s `.rotate-tmp-*` staging names are invisible to that reader. */
export function ledgerRotationLockPath(ledgerPath: string): string {
  return `${ledgerPath}.rotate.lock`;
}

/** What the rotation lock records about its holder — the SAME `{pid, host, startedAt}` shape
 *  (and the same parser) `acquireDrainLock` already uses, so {@link isHolderStale}'s three
 *  rungs (host, pid liveness, process start time) judge it exactly as they judge every other
 *  lock in this repo, with no rotation-specific holder shape or liveness logic to drift. */
type LedgerRotationLockInfo = DrainLockInfo;

/**
 * Try to take the rotation lock. Returns a release function, or `null` when a LIVE holder owns it —
 * the caller then SKIPS this rotation rather than waiting. APPEND IS THE PRIORITY: the append that
 * triggered it has already landed, and the holder's own catch-up read folds it in. Same acquire
 * shape as `acquireDrainLock`: an `O_EXCL` create is the atomic win, and a holder
 * {@link isHolderStale} judges dead is cleared through {@link reclaimStaleLock}, whose delete is
 * conditioned on the lock's on-disk identity so two reclaimers cannot both hold it. Falsifier:
 * test/ledger-rotation-is-locked.test.ts. Why: two rotators dropped every row appended between
 * their renames (R-1; docs/forensics/ledger.md#tryacquirerotationlock).
 */
function tryAcquireRotationLock(lockPath: string): (() => void) | null {
  const info: LedgerRotationLockInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const result = reclaimStaleLock(lockPath, {
        parseHolder: parseDrainLockInfo,
        isStale: (held) => isHolderStale(held, { isPidAlive: defaultIsPidAlive }),
      });
      if (result.outcome === "live") return null;
      // "missing" | "reclaimed" | "lost" → retry the atomic create from the top.
    }
  }
  // `force`: a lock some other actor already cleared (a reclaimer that mis-judged this holder
  // stale) must not turn release into a throw — the rotation's own outcome was decided by the
  // identity guard, not by whether the lock file survived.
  return () => rmSync(lockPath, { force: true });
}

function datedArchivePath(path: string, now: Date): string {
  const base = basename(path).replace(/\.ndjson$/, "");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dirname(path), `${base}.${stamp}.ndjson`);
}

/** Minimal fs surface {@link writeArchive} needs for compression, injectable so a test can force
 *  compression to fail — proving the fallback below — without monkey-patching `node:zlib`. */
export interface LedgerArchiveFsDeps {
  gzipSync: (buf: Buffer) => Buffer;
}

const realArchiveFs: LedgerArchiveFsDeps = {
  gzipSync: (buf) => gzipSync(buf),
};

/**
 * W1-T2482 — COMPRESS AT ROTATION, the half the reader already expected: ledger-grep.ts has
 * classified `.ndjson.gz` as gzip-form since W1-T444, but this writer never produced one. The `.gz`
 * suffix is appended only once compression has succeeded, so the returned path names a real file.
 * FALLBACK, NOT LOSS: if `gzipSync` throws, the archive lands PLAIN — the shape the union reader
 * has always classified — rather than the rotation losing the snapshot; compression is layered on
 * "relocated, never deleted". Falsifier: test/rotation-compresses-what-the-reader-already-decompresses.test.ts.
 */
function writeArchive(plainArchivePath: string, snapshot: string, fsDeps: LedgerArchiveFsDeps): string {
  try {
    const compressed = fsDeps.gzipSync(Buffer.from(snapshot, "utf8"));
    const gzipPath = `${plainArchivePath}.gz`;
    writeFileAtomic(gzipPath, compressed);
    return gzipPath;
  } catch (err) {
    console.error(
      `ledger: rotation compression failed for ${plainArchivePath}, archiving plain (${(err as Error)?.message ?? String(err)})`,
    );
    writeFileAtomic(plainArchivePath, snapshot);
    return plainArchivePath;
  }
}

/** What one {@link rotateLedger} call did. */
export interface LedgerRotationResult {
  /** False when the ledger was absent or already at/under the ceiling — nothing to do. */
  rotated: boolean;
  /** Absolute path to the dated archive holding every pre-rotation line verbatim — set only
   *  when `rotated`. Ends in `.ndjson.gz` (the form {@link writeArchive}/ledger-grep.ts's
   *  `ledgerRotationEntries` both already call "gzip") unless compression itself failed, in
   *  which case it ends in plain `.ndjson` — see {@link writeArchive}'s own doc. */
  archivePath?: string;
  /** Lines relocated to the archive because they were neither decision-relevant nor parseable. */
  archivedLineCount?: number;
  /** Lines retained live — the ones matching {@link DECISION_RELEVANT_LEDGER_STEPS}, plus any
   *  health/render-relevant line still inside its own retention window (see
   *  {@link HEALTH_STEP_RETENTION_WINDOW_MS}/{@link RENDER_STEP_RETENTION_WINDOW_MS}), plus
   *  anything appended after the snapshot (see doc below). */
  retainedLineCount?: number;
}

/**
 * ROLL, BUT KEEP A DECISION TAIL (W1-T209). Moves the ledger's content byte-for-byte into a dated
 * archive beside it — relocated, never deleted — then rewrites the live path to hold only the
 * decision-relevant lines, so status.ts's readers keep seeing what the breaker, sweep dedup, credit
 * backfill and escalation dedup consult. THE ACCEPTANCE TEST IS THE BREAKER, NOT THE FILE SIZE. A
 * no-op (`{ rotated: false }`) when the ledger is absent or under `ceilingBytes`. Only the snapshot
 * is gzipped (W1-T2482), so an append in progress on the live path is untouched.
 *
 * CONCURRENCY — TWO ROTATORS (R-1, 2026-09-05). Four invariants, each with its own falsifier in
 * test/ledger-rotation-is-locked.test.ts:
 *   1. Rotation is serialised across processes by {@link tryAcquireRotationLock}, taken AFTER the
 *      cheap ceiling check and BEFORE the snapshot.
 *   2. A second rotator finding a live holder returns `{ rotated: false }` at once — append is the
 *      priority, and the holder's catch-up read folds that append in.
 *   3. Once held, the ceiling is RE-CHECKED, or a rotator queued behind a completed rotation
 *      re-archives the freshly shrunk file.
 *   4. Immediately before the rename the live path is `stat`ed by name and compared on `dev`+`ino`
 *      against the snapshot's own `fstat`; a mismatch WITHDRAWS the rename rather than clobbering
 *      whatever replaced the file, and the archive already written stays on disk.
 *
 * CONCURRENCY — ONE APPENDER: appendLedger holds no long-lived descriptor, so the only exposure is
 * the window between the snapshot and the rename. One statSync plus a delta read immediately before
 * the rename folds any line appended in that window into the live file unfiltered. A line landing
 * between that check and the rename syscall is the one residual hazard — the same one `logrotate`
 * has against a writer it cannot signal to reopen its handle.
 * Why: without the lock the second rotator's catch-up saw the first's smaller live file, took an
 * empty tail and renamed over it (R-1; docs/forensics/ledger.md#rotateledger).
 */
export function rotateLedger(
  path: string,
  opts: {
    ceilingBytes?: number;
    fsDeps?: LedgerRotationFsDeps;
    now?: () => Date;
    archiveFsDeps?: LedgerArchiveFsDeps;
  } = {},
): LedgerRotationResult {
  const ceilingBytes = opts.ceilingBytes ?? LEDGER_ROTATION_CEILING_BYTES;
  const fsDeps = opts.fsDeps ?? realRotationFs;
  const archiveFsDeps = opts.archiveFsDeps ?? realArchiveFs;
  if (!ledgerExceedsRotationCeiling(path, ceilingBytes, fsDeps)) return { rotated: false };

  const release = tryAcquireRotationLock(ledgerRotationLockPath(path));
  if (release === null) return { rotated: false }; // a live rotator holds it — its catch-up covers us
  try {
    // Re-check under the lock: if the holder we queued behind just rotated, the file is
    // already small and there is nothing left to do (see the doc above).
    if (!ledgerExceedsRotationCeiling(path, ceilingBytes, fsDeps)) return { rotated: false };
    return rotateLedgerLocked(path, ceilingBytes, archiveFsDeps, opts.now);
  } finally {
    release();
  }
}

/** The rotation proper — runs ONLY with the rotation lock held (see {@link rotateLedger}). */
function rotateLedgerLocked(
  path: string,
  ceilingBytes: number,
  archiveFsDeps: LedgerArchiveFsDeps,
  now: (() => Date) | undefined,
): LedgerRotationResult {
  const { size: size0, content: snapshot, identity: snapshotIdentity } = readSnapshotWithIdentity(path);

  const plainArchivePath = datedArchivePath(path, now?.() ?? new Date());
  const archivePath = writeArchive(plainArchivePath, snapshot, archiveFsDeps);

  // ONE clock read for the whole rotation — the health-window filter, the shed pointer's size
  // estimate, and the shed pointer's actual `ts` all agree on the same instant.
  const nowDate = now?.() ?? new Date();
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();
  let archivedLineCount = 0;

  // Parsed exactly once, in file order — every retention pass below tracks lines by object
  // identity (never re-parses/re-matches raw text) so original order is always recoverable.
  const originalOrder: ParsedLedgerLine[] = snapshot
    .split("\n")
    .filter((raw) => raw.trim() !== "")
    .map(parseLedgerLine);

  // ── PASS 1: classify — decision, health and render-relevant candidates against pure noise.
  // Render membership (W1-T275) keeps daemon.headroom and the kick rows out of the archive here,
  // so PASS 2's window can bound them instead. ─────────────────────────────────────────────────
  let candidates: ParsedLedgerLine[] = [];
  for (const parsed of originalOrder) {
    if (
      parsed.step &&
      (DECISION_RELEVANT_LEDGER_STEPS.has(parsed.step) ||
        isHealthOrDeployStep(parsed.step) ||
        isRenderRelevantStep(parsed.step))
    ) {
      candidates.push(parsed);
    } else {
      archivedLineCount++;
    }
  }

  // ── PASS 2: recency-window bound — health and render steps are heartbeats, not one-shot
  // decisions, so only lines inside their own window are retained; that stops a restart storm's
  // boot spam bloating the core. A line with no parseable `ts` is kept, never guessed away. ────
  candidates = candidates.filter((p) => {
    if (!p.step) return true;
    const isHealth = isHealthOrDeployStep(p.step);
    const isRender = isRenderRelevantStep(p.step);
    if (!isHealth && !isRender) return true;
    if (p.tsMs === undefined) return true;
    const windowMs = isHealth ? HEALTH_STEP_RETENTION_WINDOW_MS : RENDER_STEP_RETENTION_WINDOW_MS;
    const withinWindow = nowMs - p.tsMs <= windowMs;
    if (!withinWindow) archivedLineCount++;
    return withinWindow;
  });

  // ── PASS 3: sweep.disposed dedup — keep the single acted:true line per `pr@head` if one exists,
  // else the most recent for that key. Every other duplicate is a same-outcome re-poll, and a
  // still-open PR re-logging its disposition every pass is the loudest source of bloat (W1-T244). ─
  const sweepGroups = new Map<string, ParsedLedgerLine[]>();
  const nonSweepCandidates: ParsedLedgerLine[] = [];
  for (const p of candidates) {
    if (p.step === "sweep.disposed" && p.json) {
      const prNumber = typeof p.json.pr_number === "number" ? p.json.pr_number : "?";
      const headSha = typeof p.json.head_sha === "string" ? p.json.head_sha : "";
      const key = `${prNumber}@${headSha}`;
      const group = sweepGroups.get(key) ?? [];
      group.push(p);
      sweepGroups.set(key, group);
    } else {
      nonSweepCandidates.push(p);
    }
  }
  const dedupedSweep: ParsedLedgerLine[] = [];
  for (const group of sweepGroups.values()) {
    const actedTrue = group.filter((p) => p.json?.acted === true);
    // group is in file order (push preserves it); the LAST entry of whichever pool applies
    // is the most recent — the acted:true evidence line if one exists, else the latest poll.
    dedupedSweep.push(actedTrue.length > 0 ? actedTrue[actedTrue.length - 1] : group[group.length - 1]);
    archivedLineCount += group.length - 1;
  }
  candidates = [...nonSweepCandidates, ...dedupedSweep];

  // ── PASS 4: per-step count cap — bounds every OTHER decision-relevant step to the newest
  // MAX_RETAINED_LINES_PER_STEP lines, because the set is otherwise unbounded. sweep.disposed and
  // the health, deploy and render steps carry their own bound and are excluded here. ───────────
  const byStep = new Map<string, ParsedLedgerLine[]>();
  for (const p of candidates) {
    const key = p.step ?? "";
    const group = byStep.get(key) ?? [];
    group.push(p);
    byStep.set(key, group);
  }
  const capped: ParsedLedgerLine[] = [];
  for (const [step, group] of byStep.entries()) {
    if (
      step === "sweep.disposed" ||
      isHealthOrDeployStep(step) ||
      isRenderRelevantStep(step) ||
      group.length <= MAX_RETAINED_LINES_PER_STEP
    ) {
      capped.push(...group);
      continue;
    }
    // group is in file order (chronological); drop the oldest excess, keep the newest cap.
    const excess = group.length - MAX_RETAINED_LINES_PER_STEP;
    archivedLineCount += excess;
    capped.push(...group.slice(excess));
  }

  // Restore original file order — every pass above regrouped by key/step, losing it. Filtering
  // `originalOrder` (parsed once, never cloned) by identity recovers it directly.
  const survivors = new Set(capped);
  let keptCandidates = originalOrder.filter((p) => survivors.has(p));

  // Catch-up: fold in anything appended to the live path since the snapshot above, so a
  // concurrent appendLedger call landing in that window is never silently dropped.
  const sizeNow = statSync(path).size;
  const tail = sizeNow > size0 ? readSyncRange(path, size0, sizeNow) : "";
  const tailBytes = Buffer.byteLength(tail, "utf8");

  let keptLines = keptCandidates.map((p) => p.raw);
  let keptBytes = keptLines.length > 0 ? Buffer.byteLength(keptLines.join("\n") + "\n", "utf8") : 0;

  // ── THE CONVERGENCE INVARIANT (W1-T244). Even after every bound above the retained core can
  // still exceed the ceiling. Post-rotation the live ledger MUST be strictly below it, or rotation
  // cannot terminate. Shed the OLDEST retained lines by `ts`, never the newest, and leave one
  // pointer line naming the archive. Falsifier: test/ledger-rotation-convergence.test.ts. Why: the
  // core once exceeded the ceiling live (docs/forensics/ledger.md#rotateledger). ───────────────
  let shedCount = 0;
  if (keptBytes + tailBytes >= ceilingBytes) {
    // Reserve room for the pointer line itself — sized against a worst-case shed_count
    // (6 digits) so the one estimate covers any real run without re-measuring per victim.
    const pointerBytes = Buffer.byteLength(
      JSON.stringify({
        ts: nowIso,
        run_id: "ledger-rotation",
        task_id: "_ledger",
        step: "ledger.rotation_shed",
        shed_count: 999999,
        archive_path: archivePath,
      }) + "\n",
      "utf8",
    );
    // Shed to a TARGET below the ceiling rather than to its edge, so the converged ledger has real
    // headroom — otherwise the very next append could put it straight back over. The invariant is
    // strictly enforced either way; this makes "converged" durable rather than a hair's-width pass.
    const targetBytes = Math.floor(ceilingBytes * 0.9);
    const byAge = [...keptCandidates].sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
    const stillKept = new Set(byAge);
    for (const victim of byAge) {
      if (keptBytes + tailBytes + pointerBytes < targetBytes) break;
      stillKept.delete(victim);
      keptBytes -= Buffer.byteLength(victim.raw + "\n", "utf8");
      shedCount++;
    }
    keptCandidates = keptCandidates.filter((p) => stillKept.has(p));
    keptLines = keptCandidates.map((p) => p.raw);
  }

  if (shedCount > 0) {
    archivedLineCount += shedCount;
    keptLines.push(
      JSON.stringify({
        ts: nowIso,
        run_id: "ledger-rotation",
        task_id: "_ledger",
        step: "ledger.rotation_shed",
        shed_count: shedCount,
        archive_path: archivePath,
      }),
    );
  }

  const newLiveContent = (keptLines.length > 0 ? keptLines.join("\n") + "\n" : "") + tail;
  const swapped = writeFileAtomic(path, newLiveContent, () => {
    // Immediately before the rename: is the live path STILL the inode this rotation snapshotted?
    // If not, something replaced it and renaming would clobber it. (A ledger REMOVED mid-rotation
    // already throws out of the catch-up stat above; this guard decides only same file or other.)
    const st = statSync(path);
    return st.dev === snapshotIdentity.dev && st.ino === snapshotIdentity.ino;
  });
  if (!swapped) {
    console.error(
      `ledger: rotation of ${path} withdrawn — the live file changed identity since the snapshot ` +
        `(another rotator replaced it); its lines are untouched and the snapshot archive ${archivePath} is kept`,
    );
    return { rotated: false };
  }

  return {
    rotated: true,
    archivePath,
    archivedLineCount,
    retainedLineCount: keptLines.length,
  };
}

// ── W1-T234: STATE BACKUP/RESTORE ORGAN (MASTER-PLAN §10 WS-7) ──────────────────────────────
// state/ holds the ledger, the run locks, the worker-keychain tokens and the proposals register,
// and none of it was backed up. It lives here because it reuses this file's atomic-write and
// dated-archive idiom: a half-written backup must never be mistaken for a whole one. SCOPE (i):
// back up what is IRREPLACEABLE — only `status.json` is excluded, proven rederivable. VERIFY,
// DON'T TRUST (ii): `snapshotState` re-lists the STAGED copy from disk before publishing. FAILURE
// ESCALATES LOUDLY (iv): every failure path throws {@link StateBackupError}, never a logged no-op.

/** Loud, typed failure for every state-backup or restore operation — always THROWN, never
 *  swallowed (design note iv). `cause` carries the underlying fs error, so a log keeps its stack. */
export class StateBackupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StateBackupError";
  }
}

/** Relative path (from `state/`) of the ledger this module treats as authoritative-by-name
 *  when verifying a snapshot — mirrors `ledgerPathFor`'s own basename (run-task.ts:
 *  `join(config.root, "state", "ledger.ndjson")`), duplicated as a bare string here rather
 *  than imported so this file never takes a dependency on run-task.ts (a CLI entrypoint) for
 *  one constant. */
export const STATE_BACKUP_LEDGER_RELPATH = "ledger.ndjson";

/** Relative path (from `state/`) of the proposals register this module treats as
 *  authoritative-by-name — mirrors the inbox registry's own basename (run-task.ts:
 *  `join(config.root, "state", "inbox-proposals.json")`), the file this task's rationale
 *  names as having gained nine entries (P37-P45) that exist on exactly one disk. */
export const STATE_BACKUP_PROPOSALS_REGISTER_RELPATH = "inbox-proposals.json";

/** Relative paths under `state/` excluded from every snapshot because they are cheaply rederivable,
 *  not because they merely look unimportant. `status.json` is the only entry: W1-T234's rationale
 *  states outright that it is rederivable and does not matter. */
export const STATE_BACKUP_EXCLUDED_RELPATHS: ReadonlySet<string> = new Set(["status.json"]);

/** One completed snapshot. */
export interface StateBackupSnapshot {
  /** Absolute path to the finished, verified snapshot directory. */
  archiveDir: string;
  /** Relative paths of every file the snapshot copied, sorted, relative to `state/`. */
  entries: string[];
}

/** Recursively lists every FILE (never a directory) under `root`, as sorted paths relative to
 *  `root`, skipping any relative path in `excluded`. ONE walk shared by staging, the post-copy
 *  verification and {@link restoreState}, so a traversal fix applies to all three. */
function listStateFiles(root: string, excluded: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const walk = (relDir: string): void => {
    const absDir = relDir ? join(root, relDir) : root;
    for (const name of readdirSync(absDir).sort()) {
      const rel = relDir ? join(relDir, name) : name;
      if (excluded.has(rel)) continue;
      const abs = join(absDir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(rel);
      else if (st.isFile()) out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

/** Copies `relPaths` from `srcRoot` to `dstRoot`, creating destination directories as needed and
 *  preserving each file's permission bits, best-effort. The service-token files under `state/` are
 *  0600 by design, and a backup that widened them on restore would be a regression. */
function copyStateFiles(srcRoot: string, dstRoot: string, relPaths: readonly string[]): void {
  for (const rel of relPaths) {
    const src = join(srcRoot, rel);
    const dst = join(dstRoot, rel);
    mkdirSync(dirname(dst), { recursive: true });
    const srcStat = statSync(src);
    cpSync(src, dst, { force: true });
    try {
      chmodSync(dst, srcStat.mode);
    } catch {
      // best-effort — an fs that refuses chmod (e.g. some network mounts) still has the
      // bytes copied correctly; permission preservation is a hardening, not the contract.
    }
  }
}

function datedStateBackupDir(backupsRoot: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(backupsRoot, `state-backup.${stamp}`);
}

/**
 * Snapshots `stateDir` into a freshly-created, dated directory under `backupsRoot`. ATOMIC PUBLISH:
 * every copy is staged into a temp dir, verified from disk rather than from the in-memory list, and
 * only then renamed into its final dated name, so a process death mid-copy leaves at most an
 * orphaned temp dir. `backupsRoot` is never inside `stateDir`, which would recurse into its own
 * prior backups. VERIFICATION (design note ii — "a snapshot that is not verified is not a backup"):
 * throws {@link StateBackupError} when the staged copy is empty, or when the source held the ledger
 * or the proposals register and the staged copy does not. `opts.copy` overrides staging for ONE
 * reason, to make that verification falsifiable: `copyStateFiles` copies every entry or throws, so
 * the "staged copy lost a file" arm is otherwise unreachable, and an unreachable check is
 * indistinguishable from an absent one. Only test/state-backup.test.ts supplies it.
 */
export function snapshotState(stateDir: string, backupsRoot: string, opts: { now?: () => Date; copy?: (srcRoot: string, dstRoot: string, relPaths: readonly string[]) => void } = {}): StateBackupSnapshot {
  const now = opts.now ?? (() => new Date());
  const copy = opts.copy ?? copyStateFiles;
  let tmpDir: string | undefined;
  try {
    if (!existsSync(stateDir)) {
      throw new StateBackupError(`state backup: source state dir does not exist: ${stateDir}`);
    }
    mkdirSync(backupsRoot, { recursive: true });
    tmpDir = mkdtempSync(join(backupsRoot, ".state-backup-tmp-"));
    const sourceEntries = listStateFiles(stateDir, STATE_BACKUP_EXCLUDED_RELPATHS);
    copy(stateDir, tmpDir, sourceEntries);

    const staged = listStateFiles(tmpDir);
    if (staged.length === 0) {
      throw new StateBackupError(`state backup: snapshot of ${stateDir} would be an empty archive — refusing to publish it`);
    }
    const missing = [STATE_BACKUP_LEDGER_RELPATH, STATE_BACKUP_PROPOSALS_REGISTER_RELPATH].filter(
      (rel) => sourceEntries.includes(rel) && !staged.includes(rel),
    );
    if (missing.length > 0) {
      throw new StateBackupError(
        `state backup: snapshot of ${stateDir} is missing ${missing.join(", ")}, present in the source — refusing to publish it`,
      );
    }

    const archiveDir = datedStateBackupDir(backupsRoot, now());
    renameSync(tmpDir, archiveDir);
    tmpDir = undefined;
    return { archiveDir, entries: staged };
  } catch (err) {
    if (err instanceof StateBackupError) throw err;
    throw new StateBackupError(`state backup: snapshot of ${stateDir} failed: ${(err as Error).message}`, { cause: err });
  } finally {
    if (tmpDir !== undefined && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/** Restores every file under a snapshot directory into `targetStateDir` byte-for-byte, permission
 *  bits preserved best-effort. THE RESTORE IS A VERB, NOT A RUNBOOK PARAGRAPH (design note iii):
 *  this is the one command an operator runs mid-incident. Refuses — throwing
 *  {@link StateBackupError} — an absent or empty archive rather than no-op'ing over a live dir. */
export function restoreState(archiveDir: string, targetStateDir: string): void {
  try {
    if (!existsSync(archiveDir)) {
      throw new StateBackupError(`state backup: restore source does not exist: ${archiveDir}`);
    }
    const entries = listStateFiles(archiveDir);
    if (entries.length === 0) {
      throw new StateBackupError(`state backup: refusing to restore from an empty archive: ${archiveDir}`);
    }
    mkdirSync(targetStateDir, { recursive: true });
    copyStateFiles(archiveDir, targetStateDir, entries);
  } catch (err) {
    if (err instanceof StateBackupError) throw err;
    throw new StateBackupError(
      `state backup: restore into ${targetStateDir} from ${archiveDir} failed: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * W1-T2383 — IS THIS `run.start` A QUEUE DISPATCH, OR A LANE RUN? Until this task every `run.start`
 * row was an implement dispatch, so the two were the same fact and three readers were written on
 * that identity. Adding rows for the triage and retro lanes separates them, and this states the
 * separation ONCE rather than re-deriving it at each reader. TRUE for an implement dispatch, and
 * for a row declaring no `type` at all, because the pre-schema rows were all implement dispatches;
 * FALSE only for a row that positively declares another lane. Why: the three readers that need it,
 * and what each would get wrong (W1-T2383; docs/forensics/ledger.md#isqueuedispatchrunstart).
 */
export function isQueueDispatchRunStart(line: Record<string, unknown>): boolean {
  if (line.step !== "run.start") return false;
  const type = line.type;
  return type === undefined || type === "implement";
}
