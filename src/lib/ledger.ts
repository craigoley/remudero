import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Append-only NDJSON ledger (MASTER-PLAN §9). Records the run's step timeline,
 * keyed by task id, so a run's provenance is inspectable after the fact. Every
 * line is one JSON object; `ts` is stamped here at write time.
 *
 * W1-T6: every WORKER call (recon, implement, implement.resumed) and every
 * BRAIN-PLANE call (the advisory reviewer, the retro Architect) logs the same
 * telemetry shape via {@link import("./worker.js").workerLedgerFields} —
 * `{model, effort, tokens, total_cost_usd, billing_mode, verdict}` — spread
 * onto that call's ledger line, so the full metering surface is queryable
 * uniformly regardless of which stage or tier produced the line.
 */
export interface LedgerLine {
  run_id: string;
  task_id: string;
  step: string;
  [k: string]: unknown;
}

/**
 * W1-T206 ATOMICITY, DESIGNED AGAINST THE CORRECTED EVIDENCE (plan/tasks.yaml's design
 * note for this task) — NOT a lock. `openSync(path, "a")` sets `O_APPEND`, which makes
 * the kernel atomically combine "seek to current EOF" with the write itself: concurrent
 * appenders across separate `rmd` processes can never overwrite or splice INTO each
 * other's already-placed bytes, full stop, with or without a lock. The recon that first
 * flagged this task suggested a `PIPE_BUF`-style size ceiling; that does not apply here —
 * `PIPE_BUF` bounds atomic writes to a PIPE, not a regular file — and a lock whose only
 * justification was that race is explicitly rejected by this task's design.
 *
 * The real, narrower exposure `O_APPEND` does NOT cover: if a SINGLE writer's own record
 * were split across more than one `write(2)` syscall, the gap BETWEEN those two syscalls
 * is a window where a different concurrent appender's line could land in the middle. This
 * function closes that window the way the design calls for — "a single write() of a
 * record under the filesystem block size" — by issuing the record as exactly ONE
 * `writeSync` call and checking the kernel accepted it in full, rather than by excluding
 * other writers. On a local disk this always succeeds in one call for any realistic
 * ledger line; on the fs the doc anticipated as the extreme, an incomplete write is LOUD
 * (`console.error`), never silently retried into a second syscall that would reopen the
 * exact interleave window a retry loop invites. The complementary read-side half of this
 * lives in status.ts's `readLedgerLines`/`readLedgerTail`: a torn trailing line — from
 * this or a crash mid-write, which no write-side mechanism can fully rule out — is
 * counted and surfaced, never silently absorbed into a fabricated empty record.
 */
/**
 * Duck-typed classifier for a spawn-INFRASTRUCTURE refusal (worker.ts's
 * `ClaudeToolchainBlockedError`) — the SAME "plain string tag, never `instanceof`"
 * idiom daemon.ts's own `isSpawnInfraBlocked` already uses (see that function's
 * doc), duplicated here rather than imported so this module keeps its "fs + JSON
 * only" contract and never gains a runtime dependency on the spawn layer.
 *
 * W1-T127 (the #212 fixture — PR #212/#213: a spawn-ENOENT/autoupdater-race binary
 * crash debited a fix-rung strike, and nearly escalated, on a worker that never
 * ran; the PR then sat 20h41m blocked on a strike that was pure accounting
 * fiction). A `blocked_toolchain` refusal fires BEFORE the SDK subprocess ever
 * launches (worker.ts's `resolveClaudeExecutable` preflight) — no worker ran,
 * nothing was billed — so `run-task.ts`'s `runFixRung` calls this to gate whether
 * a dispatch round is EVER eligible to become a strike: see `isRealStrike` below
 * for the conjunction it enforces, and {@link LEDGER_COST_TAG_INFRA} for how the
 * $0 line it still leaves behind is tagged.
 */
export function isSpawnInfraBlockedError(err: unknown): err is { reasonClass: "blocked_toolchain"; message: string } {
  return typeof err === "object" && err !== null && (err as { reasonClass?: unknown }).reasonClass === "blocked_toolchain";
}

/**
 * Cost-line tag (W1-T127 design note iii). `"task"` is the ordinary, implicit
 * attribution for real billed work; `"infra"` marks a $0 line logged for a
 * spawn-infrastructure refusal (see {@link isSpawnInfraBlockedError}) — so a
 * per-task cost rollup can exclude it from "this task was expensive" while a
 * fleet-health rollup can still find it under "the host was broken".
 */
export const LEDGER_COST_TAG_TASK = "task" as const;
export const LEDGER_COST_TAG_INFRA = "infra" as const;
export type LedgerCostTag = typeof LEDGER_COST_TAG_TASK | typeof LEDGER_COST_TAG_INFRA;

/**
 * THE #212 CONJUNCTION (W1-T127, design note i): "a strike is recorded only where
 * a worker RAN and a judgment was POSTED. Assert both, never either." A worker
 * having run with no judgment ever posted for it (e.g. the process died between
 * dispatch and any further trace) is not a strike; a judgment with no worker
 * having run for it is not constructible in the real system, but is asserted
 * insufficient here too, so this predicate never silently degrades to just one
 * half of the conjunction it claims to check. Pure and total — never reads a
 * ledger itself; callers (`runFixRung`) supply the two halves from what they
 * directly observed.
 */
export function isRealStrike(evidence: { workerRan: boolean; judgmentPosted: boolean }): boolean {
  return evidence.workerRan && evidence.judgmentPosted;
}

export function appendLedger(path: string, line: LedgerLine, opts: { ceilingBytes?: number } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const record = { ts: new Date().toISOString(), ...line };
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
  // W1-T209: opportunistic, lazy rotation — the only place the ledger ever grows, so the
  // only place that needs to notice it has grown past the ceiling. Cheap on every call that
  // stays under the ceiling (one extra statSync); only pays the full read+rewrite cost on
  // the rare call that crosses it. See rotateLedger's doc for what "rotation" means here.
  if (ledgerExceedsRotationCeiling(path, opts.ceilingBytes)) {
    rotateLedger(path, { ceilingBytes: opts.ceilingBytes });
  }
}

// ── THE ACCOUNT DIMENSION (W1-T268, MASTER-PLAN §9) ─────────────────────────
//
// No line in this ledger's unioned history (662 files, 4,160,926 lines at the time this
// task was filed) carries any `account`-prefixed key — the entire billing vocabulary was
// cost_usd/total_cost_usd, tokens, the two cache-token columns, and `billing_mode` (a
// funding-source flag, not an identity). Because appendLedger only ever appends, a line
// written before an `account_label` field existed can NEVER be retrofitted with one — so
// any accounting built on top of the label below has a HARD START DATE and must REFUSE a
// line older than it rather than guess which of possibly several accounts it belongs to.

/**
 * THE ACCOUNT ATTRIBUTION EPOCH. The sole `daemon.worker_keychain` line in the entire
 * unioned ledger history reading `provisioned:true` — the boot that re-provisioned the
 * worker keychain store after the operator's manual account switch (W1-T265). Every line
 * before this instant belongs to whichever account was active before that switch, by
 * construction, but NO such line SAYS so. Exported as a NAMED constant (never a bare
 * comment) so a downstream reader binds to the value itself, never a copy of it — see
 * {@link groupSpendByAccount}, the one query helper in this codebase that groups spend by
 * account, for how it is enforced.
 */
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

/**
 * Group every spend-carrying ledger line by its `account_label`, REFUSING — never
 * guessing — any line older than {@link ACCOUNT_ATTRIBUTION_EPOCH} or one that carries a
 * spend figure with no label at all (this task's design note 3, plan/tasks.d/W1-T268: "any
 * query helper that groups spend by account REFUSES lines older than the epoch instead of
 * attributing them to whichever label happens to be current").
 *
 * A "spend-carrying" line is one with a numeric `total_cost_usd` (worker/brain-plane
 * calls — {@link import("./worker.js").workerLedgerFields}) or `cost_usd` (run-task.ts's
 * own verdict lines) — the two conventions this ledger actually uses. Neither present ⇒
 * the line is skipped entirely: it never carried a spend figure, so it is not a candidate
 * for attribution OR refusal (refusal is reserved for spend this function chose not to
 * credit, never for a line with nothing to credit).
 */
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

/**
 * SIZE CEILING (W1-T209, RECON R-9): `state/ledger.ndjson` was measured at intake at
 * 9,455,694 bytes / ~27.6k lines and growing, with NO rotation mechanism anywhere in src,
 * scripts, or bin. Comfortably below that measured size, so a real, never-rotated ledger
 * actually crosses this rather than the ceiling being theoretical; comfortably above any
 * single run's worth of appends, so a healthy, actively-rotating ledger never thrashes.
 */
export const LEDGER_ROTATION_CEILING_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * The ledger `step` names a DECIDING reader — never a merely-displaying one — actually
 * consults to answer "has this already happened / how many times has this happened". VERIFIED
 * by grepping every `.step === "..."` read site in src/ at the time this task was implemented
 * (W1-T209's own design note warns against copying a stale list from the recon that first
 * flagged this, since a step THAT forgets is a breaker/dedup that silently resets):
 *
 *   - "run.start" / "pr.opened"             → status.ts's dispatchesWithoutNewOwnedPr /
 *                                              lastPrOpened — THE DISPATCH CIRCUIT BREAKER
 *                                              itself (MASTER-PLAN P29(ii)).
 *   - "dispatch.circuit_broken.escalated"   → run-task.ts's escalateCircuitBreak dedup —
 *                                              never re-escalates the same tripped breaker.
 *   - "dispatch.starvation.escalated"       → run-task.ts's escalateStarvation dedup — reads
 *                                              this line back against "run.start" (above) to
 *                                              tell whether anything has dispatched since the
 *                                              last starvation notice; losing it re-pages the
 *                                              operator on every idle poll for as long as the
 *                                              queue stays starved (oper#queue-starvation-2026-08-03).
 *   - "verdict" / "verdict.merged"          → sweep.ts's hasMergeCredit — the credit-backfill
 *                                              rung's idempotence (P29(i)/W1-T149/W1-T150).
 *   - "correction.provenance"               → status.ts's debunkedTrailerUrls / the
 *                                              corrections-win-supreme override (P9-iv).
 *   - "sweep.disposed"                      → sweep.ts's priorActionsFromLedger — the
 *                                              arm/fix/close/escalate/dep-review dedup for
 *                                              every open-PR disposition.
 *   - "escalation.issue_opened"             → ops.ts's priorEscalatedAlertIds and
 *                                              drain.ts's buildRundown — the SAME
 *                                              already-escalated dedup shape as the
 *                                              breaker's own escalation, for alerts instead.
 *   - "ratify.approved" / "ratify.reframed" → inbox.ts's isRatifiedInLedger and its
 *                                              reframe-once bookkeeping.
 *   - "fix.dispatch" / "fix.review"         → run-task.ts's deriveStrikeHistory and the
 *                                              fix rung's own strike cap.
 *   - "dep-review.decided"                  → sweep.ts's depReview readback — the terminal
 *                                              arm/escalate/refuse decision for a Dependabot PR.
 *   - "review.posted"                       → run-task.ts's currentStrikeRegimeFor (the
 *                                              keyword-vs-executed fix-strike amnesty regime)
 *                                              AND review.ts's priorReviewVerdictFromLedger /
 *                                              lastPostedReviewStatusFromLedger — the W1-T178
 *                                              verdict-stability anti-flap rule and the review
 *                                              evidence-strength precedence, both "last one
 *                                              wins" scans over this exact step.
 *   - "review.post_refused"                 → sweep.ts's priorActionsFromLedger (W1-T254) — the
 *                                              OUTCOME-keyed post-review dedup: an explicit
 *                                              refusal for a head must dedup exactly like a
 *                                              posted verdict does, or a rotation that drops it
 *                                              re-opens the SAME head to a repeat post-review
 *                                              attempt forever (the #707 fix's latent sibling).
 *   - "automerge.capped_override_granted"   → review.ts's cappedOverrideFromLedger — the
 *                                              operator-granted, head-pinned override that lets
 *                                              auto-merge arm despite a CAPPED verdict; losing
 *                                              this line silently revokes a human's decision.
 *   - "sweep.post_fix_redriven"             → sweep.ts's per-pr-headSha-class dedup for the
 *                                              W1-T124 post-fix re-verification reconciler —
 *                                              losing this line re-earns and re-fires the same
 *                                              redrive (and its strike-credit) on every rotation.
 *
 * Deliberately EXCLUDES pure telemetry/polling noise (`ci.polling`, `pr.polling`,
 * `ops.alerts_polled`, `issues.polled`, `inbox.polled`, ...) — exactly the high-frequency,
 * no-decision-consequence lines that drove the measured growth and are safe to archive — AND
 * excludes the handful of steps ("recon.done", "implement.resumed", "implement.done" as a
 * phase transition, "fix.resolved") that status.ts's `deriveRunState` reads ONLY to label a
 * cosmetic `phase`/`elapsedMs` for the board/status display: `daemon.ts`'s `reconstructOrphan`
 * proves those never gate a real decision — its `&& projection.prUrl` guard is a no-op for
 * every case a `run.start`/`pr.opened` line (both already covered above) didn't already set.
 *
 * ALSO deliberately EXCLUDES `daemon.headroom` and `console.kick_refused`/
 * `console.kick_dispatched` (W1-T275) even though real consumers read them
 * (account-usage.ts's governor posture, board.ts's RECENT operator-action feed) — those reads
 * render OPERATOR-VISIBLE HISTORY, not a decision this codebase makes, so widening THIS set
 * (the never-rotated core) to cover them would trade a bounded-retention bug for unbounded
 * growth. See {@link RENDER_RELEVANT_LEDGER_STEPS} below for the separate, recency-bounded
 * category that covers them instead.
 *
 * THIS LIST IS NOT SELF-CERTIFYING. It failed once already — "review.posted" and
 * "automerge.capped_override_granted" were both real deciding reads this list omitted until
 * the review round that caught it — which is exactly the "hardcoded to a stale list" failure
 * mode this task exists to close. `test/ledger-rotation.test.ts`'s "derived from consumers,
 * not hardcoded" test re-derives the expected step set from the actual source of every
 * consumer file named above on every run and fails if this Set falls behind it again; treat
 * that test, not this comment, as the source of truth for completeness.
 *
 * W1-T244 (feedback fb-1784769525147-13afc6, OBSERVED LIVE 2026-07-23) ADDED "daemon.boot":
 * `deployer.ts`'s `assessBootHealth` reads `daemon.boot` heartbeats straight off the ledger
 * to decide whether a just-kickstarted deploy came up healthy — a boot line archived away
 * mid-health-window reads as "never booted" and rolls back a perfectly healthy deploy (this
 * happened for real: a healthy 7abe870 deploy was rolled back at 00:19Z on exactly this false
 * negative). UNLIKE every other step above, `daemon.boot` (and every `deploy.*` step — see
 * {@link isHealthOrDeployStep}, matched by prefix rather than enumerated here so a future
 * `deploy.*` step is covered without another stale-list edit) is a HEALTH HEARTBEAT, not a
 * one-shot decision: keeping every one forever is exactly the unbounded-retained-core growth
 * this same task fixes (a restart-storm logs roughly one `daemon.boot` per minute — see
 * escalate.ts's own observed 460-line/10-window incident). Both are therefore bounded by
 * {@link HEALTH_STEP_RETENTION_WINDOW_MS} rather than kept unconditionally like the rest of
 * this Set — see `rotateLedger`'s retention pipeline.
 */
export const DECISION_RELEVANT_LEDGER_STEPS: ReadonlySet<string> = new Set([
  "run.start",
  "pr.opened",
  "dispatch.circuit_broken.escalated",
  // W1-T316: escalateLifetimeCapExceeded's (run-task.ts) own dedup marker — the SAME
  // "written whether or not delivery succeeds" discipline as `dispatch.circuit_broken.escalated`
  // immediately above; a rotation dropping it re-opens a duplicate lifetime-cap escalation.
  "dispatch.lifetime_capped.escalated",
  // W1-T215 wiring: escalateCrashLoop's (run-task.ts) own dedup marker. It is READ per boot to
  // decide whether the current storm already escalated (episode key: `window_newest` within one
  // window of the new verdict's newest boot) — a rotation dropping it re-opens one duplicate
  // needs-human issue per boot, roughly one a MINUTE for as long as the storm lasts.
  "daemon.crashloop.escalated",
  "daemon.headroom_reserve.escalated",
  "dispatch.starvation.escalated",
  "verdict",
  "verdict.merged",
  "correction.provenance",
  "sweep.disposed",
  "escalation.issue_opened",
  // impl-FL: daemon.ts's once-per-distinct-string bound COUNTS these lines back (seeded via
  // DaemonDeps.priorUnrecognisedResets) to decide whether a reset string has already been
  // announced. The line IS the dedup key, so rotating it away would make every restart
  // re-announce strings already reported — the same reason `ops.feedback_reconciled` is here.
  // Registered by EXACT name deliberately: `isRenderRelevantStep` is a `Set.has`, and
  // `daemon.headroom.degraded` was emitted 52 times and rotated away entirely because a dotted
  // child does not inherit its parent's membership.
  "daemon.usage_reset_unrecognised",
  // impl-EV: ops.ts's `priorReconciledAlertFeedbackIds` COUNTS these to decide whether an
  // alert-feedback entry was already closed. The status flip goes through the landing bridge,
  // which never touches this checkout, so the local entry still reads `status: new` until the
  // landing PR merges — the ledger line IS the dedup. Rotating it away would make every poll
  // re-reconcile the same entries and force-push a landing branch each tick, the same shape
  // `sweep.absent_repush` is retained to prevent.
  "ops.feedback_reconciled",
  "ratify.approved",
  "ratify.reframed",
  "fix.dispatch",
  "fix.review",
  "dep-review.decided",
  "review.posted",
  "review.post_refused",
  "automerge.capped_override_granted",
  "daemon.boot",
  // W1-…/impl-DF: the idle rung's reason tally. A HUMAN reads this to tell "starved of work"
  // from "everything filtered", and it is emitted only on change -- so it is sparse by design and
  // rotation would otherwise drop exactly the lines that explain a long idle.
  "daemon.idle_reasons",
  "sweep.post_fix_redriven",
  // W1-T186's ABSENT remedy: `priorActionsFromLedger` counts these lines to enforce
  // ABSENT_REPUSH_CAP. Archived away, the count reads zero and every rotation re-earns the
  // PR another empty commit — an unbounded re-push loop, which is precisely the failure the
  // cap exists to prevent. The line IS the bound; it must survive rotation.
  "sweep.absent_repush",
]);

/** Steps matched by PREFIX rather than enumerated — currently only `deploy.*` (`deploy.skip`,
 *  `deploy.pulled`, `deploy.kickstart`, `deploy.ok`, `deploy.unhealthy_rollback`, ... — see
 *  deployer.ts's `runDeployCycle`). Prefix matching means a future `deploy.*` step is covered
 *  automatically, the same "derived, not a stale hardcoded list" doctrine
 *  {@link DECISION_RELEVANT_LEDGER_STEPS}'s own doc already applies to its enumerated steps. */
const HEALTH_RELEVANT_LEDGER_STEP_PREFIXES: readonly string[] = ["deploy."];

/** True for `daemon.boot` and any `deploy.*` step — W1-T244's health-window-bounded steps
 *  (see {@link DECISION_RELEVANT_LEDGER_STEPS}'s doc for why these are NOT kept unconditionally
 *  like the rest of the decision-relevant set). */
function isHealthOrDeployStep(step: string): boolean {
  return step === "daemon.boot" || HEALTH_RELEVANT_LEDGER_STEP_PREFIXES.some((prefix) => step.startsWith(prefix));
}

/** How far back (from `rotateLedger`'s own `now`) a health-window-bounded step survives.
 *  Comfortably larger than any real health window in this codebase (deployer.ts's own default
 *  `healthWindowMs` is 45s) so `assessBootHealth`/the W1-T215 boot-rate detector never lose a
 *  line still inside their window, while still bounding a restart-storm's boot count (roughly
 *  1/minute) to a small, ceiling-safe number instead of retaining it forever. */
export const HEALTH_STEP_RETENTION_WINDOW_MS = 15 * 60 * 1000;

/**
 * RENDER-RELEVANT, not decision-relevant: consulted by the console to render OPERATOR-VISIBLE
 * HISTORY (the ACCOUNT strip's governor posture, the RECENT feed's operator-action row) rather
 * than to make a daemon-side decision. W1-T275 (OBSERVED LIVE 2026-07-31): the ACCOUNT strip
 * read "unknown" on a healthy fleet because `daemon.headroom` was absent from
 * {@link DECISION_RELEVANT_LEDGER_STEPS} and rotation archived every line of it. Widening that
 * set to cover these would silently trade one failure for another — it is the never-rotated
 * core, so a render-only step added there is retained FOREVER, not for as long as the console
 * actually needs it. These instead get their OWN recency-bounded category, the same treatment
 * `daemon.boot`/`deploy.*` already get via {@link isHealthOrDeployStep}/
 * {@link HEALTH_STEP_RETENTION_WINDOW_MS} above, so a rotation still bounds retained growth
 * while the console keeps rendering.
 *
 * Consumers, and why each step is here:
 *   src/lib/account-usage.ts `deriveGovernorPosture` reads the NEWEST `daemon.headroom` line
 *     for the ACCOUNT strip's governor posture (`line.step !== "daemon.headroom"` guard).
 *   src/lib/account-usage.ts `deriveCostGovernorDeferral`/`deriveQueueGovernorDeferral` (W1-T329)
 *     read the NEWEST `daemon.cost_governor`/`daemon.queue_governor` line for the ACCOUNT strip's
 *     dispatch-deferral slots (`line.step !== "daemon.cost_governor"` /
 *     `line.step !== "daemon.queue_governor"` guards).
 *   src/lib/board.ts's `OPERATOR_ACTION_STEPS` / `classifyLine` read `console.kick_refused` and
 *     `console.kick_dispatched` for the RECENT feed's operator-action row (`case "console.kick_refused":` /
 *     `case "console.kick_dispatched":`).
 *   src/lib/account-usage.ts `deriveCostCeilingAudit` (W1-T333) reads the NEWEST
 *     `panel.cost_ceiling_override_set`/`panel.cost_ceiling_override_cleared` line for the
 *     ACCOUNT strip's cost-ceiling provenance (`line.step === "panel.cost_ceiling_override_set"` /
 *     `line.step === "panel.cost_ceiling_override_cleared"` guards) — the WHO/WHEN/FROM/TO/
 *     resulting-effective-value audit trail of every console write to the daily cost ceiling
 *     override (src/lib/policy.ts's W1-T332 `state/`-resident store). `panel.*` matches
 *     panel-actions.ts's own naming convention for every other console write
 *     (`panel.pause_requested`, `panel.quiet_hours_toggled`, ...); THE WRITE ROUTE THAT WOULD
 *     ACTUALLY EMIT THESE TWO LINES IS OUT OF SCOPE for the task that added this entry (W1-T333
 *     — "the console WRITE control itself" is its own, deliberately unfiled follow-up), so
 *     nothing in this checkout emits them yet. This membership and account-usage.ts's read
 *     exist so that follow-up route is a drop-in emitter into an already-render/already-
 *     retained shape, never a retention or render redesign, when it lands — the same
 *     "protect the shape before the emitter exists" precedent `daemon.headroom.degraded`/
 *     `.unavailable` above already set, except here the CONSUMER (not just the membership) is
 *     real and already exercised by test/ledger-render-retention.test.ts's derivation lock.
 *     RENDER, NOT DECISION, for the identical reason the two lines above are — and for a
 *     second, W1-T333-specific reason too: `state/DAILY_COST_CEILING_OVERRIDE` (policy.ts) IS
 *     the current override and is what a live decision reads; this ledger line is HISTORY —
 *     "was this ever overridden" surviving a `state/` wipe, which policy.ts's own resolver
 *     documents it cannot answer alone (see `EffectiveDailyCostCeiling`'s doc: a wipe and a
 *     "never touched" value both read back `provenance: "default"` with no `fallback`).
 *
 * `test/ledger-render-retention.test.ts` re-derives this set from account-usage.ts's and
 * board.ts's own source on every run — the same "derived from consumers, not hardcoded"
 * doctrine `test/ledger-rotation.test.ts` already applies to `DECISION_RELEVANT_LEDGER_STEPS`
 * above — and fails if this Set falls behind it.
 */
export const RENDER_RELEVANT_LEDGER_STEPS: ReadonlySet<string> = new Set([
  "daemon.headroom",
  "console.kick_refused",
  "console.kick_dispatched",
  // W1-T282's LANE_START_STEPS (status.ts) taught the NOW panel to open a run on any lane's start,
  // not just `run.start` — and then none of the six new ones was retained, so a long-running lane
  // could VANISH from "currently running" the moment a rotation happened. Measured on this host:
  // `drain.start`, `retro.start` and `triage.start` all read ZERO in the live ledger against 25/14/34
  // in the unioned corpus, i.e. every one of them had ALREADY been rotated away.
  //
  // RENDER, NOT DECISION, and the window is why. `deriveRunState`'s own consumer bound is
  // DEFAULT_LIVENESS_BOUND_MS = 30 minutes (status.ts:471) — a run whose last activity is older than
  // that is ALREADY not shown as live — and RENDER_STEP_RETENTION_WINDOW_MS is 30 minutes too. So
  // this window is sized exactly to the consumer, retaining a start for precisely as long as NOW
  // could still act on it and not one tick longer. Putting them in DECISION_RELEVANT would retain
  // every lane start FOREVER for a display-only read; status.ts's own note says these reads are
  // "display-only ... never decision-relevant, so they must not be mistakenly harvested into that
  // enforcement list either way".
  //
  // IT ALSO CANNOT STRAND A PERPETUAL IN-FLIGHT ROW. A successful retro or triage logs no terminal
  // step at all (status.ts's LANE_TERMINAL_STEPS doc: `retro.error`/`triage.error` are each lane's
  // ONLY terminal), so those lanes close purely on the liveness bound. Because this retention window
  // EQUALS that bound, the start line ages out at the same moment NOW stops calling it live.
  //
  // `run.start` is deliberately absent: it is already in DECISION_RELEVANT_LEDGER_STEPS, where it
  // belongs for reasons beyond this panel. `plan.start` is deliberately absent too — it has a real
  // emitter (run-task.ts:10832) but ZERO emissions in 19 days of unioned ledger, so protecting it
  // would be the `sweep.absent_repush` defect in the other direction: membership for a step nothing
  // writes. Add it when `rmd plan` actually runs.
  "daemon.start",
  "drain.start",
  "retro.start",
  "serve.start",
  "triage.start",
  // THE GOVERNOR'S TWO "I CANNOT READ USAGE" SIGNALS. `isRenderRelevantStep` is an exact
  // `Set.has`, so a dotted CHILD does not inherit its parent's protection: `daemon.headroom` was
  // retained while `daemon.headroom.degraded`/`.unavailable` were not. Measured on this host —
  // 52 and 215 lines in the unioned corpus, ZERO in the live ledger against a `run.start` control
  // of 200. Rotation had already stripped every one from the surface the console reads.
  //
  // WHY IT MATTERS MORE THAN THE COUNT SUGGESTS. A governor that cannot read usage fails closed
  // and idles the whole fleet — measured once at three hours, during which the operator could not
  // distinguish "blind" from "comfortably under ceiling" and four wrong theories were built before
  // the cause was found. `daemon.headroom.degraded` is HOW A BLIND GOVERNOR ANNOUNCES ITSELF, and
  // it was evaporating within the hour.
  //
  // THE 30-MINUTE RENDER WINDOW IS SUFFICIENT, and the measurement is why rather than the hope.
  // While blind, `degraded` re-fires every tick: 49 of 51 consecutive gaps are under ten minutes,
  // median 2.32. So a blind episode ALWAYS has a line inside the window. And duration does not
  // depend on retention at all — each line carries `consecutive_unreadable` (observed 4..42) plus
  // `poll_interval_ms` (60000), so ONE line states how long the blindness has lasted. A reader
  // concludes "blind for N minutes" from the counter, never from how much history survived.
  //
  // PROTECTED FOR A CONSUMER THAT DOES NOT EXIST YET, deliberately and on the record: the panel
  // that will render these (governor visibility, blind-vs-reading) is not merged. If it never
  // lands, the cost is 13.9 lines/day held for 30 minutes — under 0.3 lines resident — which is a
  // KNOWN cost, not an accident. Nothing else in the tree reads these two steps today.
  "daemon.headroom.degraded",
  "daemon.headroom.unavailable",
  // W1-T329 (OPERATOR COMPLAINT, 2026-08-04): THE TWO DISPATCH-DEFERRING GOVERNORS' OWN
  // HEARTBEATS. `daemon.cost_governor` (daemon.ts) and `daemon.queue_governor` (daemon.ts) are
  // written on EVERY tick either governor defers NEW dispatch, carrying the observed figure
  // against its ceiling (`observed_day_cost_usd`/`daily_cost_ceiling_usd` for cost,
  // `observed_open_count`/`wip_limit` for queue) — but neither was in either retention set, so a
  // fleet that deferred every dispatch for ~40 minutes at $152.28 against a $150 ceiling had
  // ZERO surviving lines the moment a rotation happened, and the ACCOUNT strip (below) had
  // nothing to read even after this task wired it up. RENDER, NOT DECISION: nothing in this
  // codebase's own dispatch path re-reads these two ledger lines to decide anything (the
  // predicates in sweep.ts are re-evaluated fresh every tick against the ledger's cost/PR
  // totals, never against their own prior emission) — they exist purely so a human can see WHY
  // the fleet looks idle, the same operator-visible-history role `daemon.headroom` already
  // holds for the governor's own posture.
  //
  // src/lib/account-usage.ts's `deriveCostGovernorDeferral`/`deriveQueueGovernorDeferral` read
  // the NEWEST line of each for the ACCOUNT strip's new cost-governor/queue-governor slots
  // (`line.step !== "daemon.cost_governor"` / `line.step !== "daemon.queue_governor"` guards,
  // the same shape `deriveGovernorPosture`'s own guard above uses).
  "daemon.cost_governor",
  "daemon.queue_governor",
  // W1-T333: the daily-cost-ceiling override's own console-write audit trail — see this Set's
  // doc block above for the full account-usage.ts/panel-actions.ts cross-reference and why the
  // emitter is a deliberate follow-up rather than part of this entry.
  "panel.cost_ceiling_override_set",
  "panel.cost_ceiling_override_cleared",
]);

/** True for any step in {@link RENDER_RELEVANT_LEDGER_STEPS}. */
function isRenderRelevantStep(step: string): boolean {
  return RENDER_RELEVANT_LEDGER_STEPS.has(step);
}

/**
 * How far back a render-relevant step survives rotation. SIZED FROM THE CONSUMER, not for
 * convenience (this task's own design note): account-usage.ts's `deriveAccountUsage` already
 * declares the ACCOUNT strip's own staleness bound as `USAGE_CACHE_MAX_AGE_MS` (30 minutes) —
 * the newest `daemon.headroom` line older than that already reads as stale to the strip, so
 * retaining anything LESS than that window here would guarantee the strip reads "unknown"
 * immediately after a rotation, before its own staleness check would ever have kicked in. The
 * value is restated rather than imported: account-usage.ts -> status.ts -> escalate.ts ->
 * ledger.ts (appendLedger) already forms a chain back to this module, so importing from
 * account-usage.ts here would be circular.
 */
export const RENDER_STEP_RETENTION_WINDOW_MS = 30 * 60 * 1000;

/** Hard cap on how many lines of any single decision-relevant `step` `rotateLedger` retains,
 *  EXCLUDING `sweep.disposed` (its own per-`pr@head` dedup below supersedes a flat count cap)
 *  and the health-window-bounded steps above (already bounded by recency, not count). W1-T244:
 *  the retained core is otherwise UNBOUNDED — every run appends more `run.start`/`pr.opened`/
 *  etc., so over enough runs the core alone eventually exceeds the ceiling and every append
 *  re-rotates forever (feedback fb-1784769525147-13afc6: 80+ archives, bursts of 12
 *  rotations/second, observed live). Newest-N survive; older ones archive — a consumer here
 *  (the dispatch breaker, sweep dedup, ...) only ever reads a task's RECENT history, never the
 *  dawn of the ledger, so this is set generously above any realistic per-task line count
 *  (default breaker thresholds are single digits) and only bites the pathological case. */
export const MAX_RETAINED_LINES_PER_STEP = 200;

/** Minimal fs surface {@link ledgerExceedsRotationCeiling}/{@link rotateLedger} need,
 *  injectable for the same reason {@link status.ts}'s `LedgerFsDeps` is: a test proves the
 *  ceiling check and the rotation itself without ever touching a real file. */
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

/** Writes `content` as ONE atomic unit: staged into a same-directory temp file with a
 *  single writeSync call (same "one syscall, no interleave window" discipline appendLedger
 *  itself uses), then swapped into place with a single renameSync — the swap itself is
 *  atomic on any POSIX filesystem, so a concurrent reader (readLedgerLines/readLedgerTail)
 *  only ever sees the whole old file or the whole new one, never a partial rewrite. */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.rotate-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const buf = Buffer.from(content, "utf8");
  const fd = openSync(tmpPath, "w");
  try {
    const written = writeSync(fd, buf, 0, buf.length);
    if (written !== buf.length) {
      console.error(`ledger: short write staging ${tmpPath} for rotation of ${path} (${written}/${buf.length} bytes)`);
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

function datedArchivePath(path: string, now: Date): string {
  const base = basename(path).replace(/\.ndjson$/, "");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dirname(path), `${base}.${stamp}.ndjson`);
}

/** What one {@link rotateLedger} call did. */
export interface LedgerRotationResult {
  /** False when the ledger was absent or already at/under the ceiling — nothing to do. */
  rotated: boolean;
  /** Absolute path to the dated archive holding every pre-rotation line verbatim — set only when `rotated`. */
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
 * ROLL, BUT KEEP A DECISION TAIL (W1-T209's own design note, plan/tasks.yaml). Moves the
 * ledger's current full content, byte-for-byte, into a dated archive file next to it — the
 * audit trail is relocated, never deleted — then rewrites the live path to hold ONLY the
 * lines whose `step` is decision-relevant (see {@link DECISION_RELEVANT_LEDGER_STEPS}), so
 * readLedgerLines/readLedgerTail keep seeing exactly what the dispatch breaker, sweep dedup,
 * credit-backfill and escalation dedup consult — THE ACCEPTANCE TEST IS THE BREAKER, NOT THE
 * FILE SIZE (this task's own design note): a rotation that shrinks the file but drops one of
 * those lines is worthless, because the reader it backs would silently reset.
 *
 * A no-op (`{ rotated: false }`) when the ledger is absent or not yet over `ceilingBytes`.
 *
 * CONCURRENCY: appendLedger never holds a long-lived file descriptor — open, one writeSync,
 * close, every single call (see its own doc) — so the only exposure here is the window
 * between this function's initial snapshot read and its final atomic rename. That window is
 * narrowed to one extra statSync + delta read taken immediately before the rename (mirrors
 * status.ts's readLedgerTail's own incremental-catch-up shape): any line appended by another
 * process between the snapshot and that final check is still folded into the live file
 * unfiltered (never dropped, never mis-classified as noise on a partial read) rather than
 * risking loss. A line landing in the sliver AFTER that final check and BEFORE the rename
 * syscall itself is the one residual hazard — the same one ordinary `logrotate` has against a
 * writer it cannot signal to reopen its handle; this codebase's append path never holding a
 * long-lived fd is what keeps that sliver this narrow rather than open-ended.
 */
export function rotateLedger(
  path: string,
  opts: { ceilingBytes?: number; fsDeps?: LedgerRotationFsDeps; now?: () => Date } = {},
): LedgerRotationResult {
  const ceilingBytes = opts.ceilingBytes ?? LEDGER_ROTATION_CEILING_BYTES;
  const fsDeps = opts.fsDeps ?? realRotationFs;
  if (!ledgerExceedsRotationCeiling(path, ceilingBytes, fsDeps)) return { rotated: false };

  const size0 = statSync(path).size;
  const snapshot = readSyncRange(path, 0, size0);

  const archivePath = datedArchivePath(path, opts.now?.() ?? new Date());
  writeFileAtomic(archivePath, snapshot);

  // ONE clock read for the whole rotation — the health-window filter, the shed pointer's size
  // estimate, and the shed pointer's actual `ts` all agree on the same instant.
  const nowDate = opts.now?.() ?? new Date();
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();
  let archivedLineCount = 0;

  // Parsed exactly once, in file order — every retention pass below tracks lines by object
  // identity (never re-parses/re-matches raw text) so original order is always recoverable.
  const originalOrder: ParsedLedgerLine[] = snapshot
    .split("\n")
    .filter((raw) => raw.trim() !== "")
    .map(parseLedgerLine);

  // ── PASS 1: classify — decision/health/render-relevant candidates vs pure noise (unchanged
  // from W1-T209 for decision/health; W1-T275 adds render-relevant so daemon.headroom/
  // console.kick_refused/console.kick_dispatched survive into PASS 2's window bound below
  // instead of being archived here as if they were noise). ────────────────────────────────
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

  // ── PASS 2: recency-window bound — daemon.boot/deploy.* (health) and daemon.headroom/
  // console.kick_refused/console.kick_dispatched (render, W1-T275) are heartbeats/history, not
  // one-shot decisions; only the recent ones (their own window — HEALTH_STEP_RETENTION_WINDOW_MS or
  // RENDER_STEP_RETENTION_WINDOW_MS) are retained, so neither a restart-storm's boot spam
  // (W1-T244) nor an unbounded run of headroom heartbeats can itself bloat the retained core.
  // A line with no parseable `ts` is kept rather than guessed away — absence is never proof of
  // staleness. ──────────────────────────────────────────────────────────────────────────────
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

  // ── PASS 3: sweep.disposed dedup — keep the single ACTED:TRUE line per `pr@head` (the one
  // line sweep's own idempotence dedup, priorActionsFromLedger, actually consults) if one
  // exists, else the single most recent line for that key. Every other duplicate for the same
  // key is a same-outcome re-poll with no decision consequence (W1-T244: this is the loudest
  // real-world source of retained-core bloat — a still-open PR re-logs the same disposition on
  // every sweep pass forever). ──────────────────────────────────────────────────────────────
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

  // ── PASS 4: per-step count cap — bounds every OTHER decision-relevant step (run.start,
  // pr.opened, ...) to the newest MAX_RETAINED_LINES_PER_STEP lines. W1-T244's root cause: this
  // set is otherwise unbounded — every run appends more, so over enough runs the retained core
  // alone eventually exceeds the ceiling and every append re-rotates forever. sweep.disposed
  // (deduped above) and health/deploy/render steps (window-bounded above; W1-T275 adds render)
  // already have their own bound and are excluded here. ────────────────────────────────────
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

  // ── THE CONVERGENCE INVARIANT (W1-T244, feedback fb-1784769525147-13afc6 — OBSERVED LIVE
  // 2026-07-23: the retained core alone exceeded the ceiling, so EVERY append re-rotated —
  // 80+ archive files, bursts of 12 rotations/second, a truncated live ledger). Even after
  // every bound above, the retained core CAN still exceed the ceiling (many concurrently
  // in-flight tasks each within their own cap). Post-rotation, the live ledger MUST be
  // strictly below the ceiling, or rotation cannot terminate — a rotation that cannot make
  // live < ceiling is a bug, never a steady state. Shed the OLDEST retained lines (by `ts`;
  // a consumer here only ever reads a task's RECENT history, never the dawn of the ledger) —
  // never the newest — until the live file converges, and leave a single small pointer line
  // behind naming the archive, rather than silently retaining an over-ceiling core in a loop. ─
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
    // Shed down to a TARGET below the ceiling (not to the ceiling's edge) so the freshly
    // converged live ledger has real headroom — otherwise the very next append could put it
    // straight back over, forcing another rotation almost immediately. Still strictly enforces
    // the invariant either way; this just makes "converged" mean something durable rather than
    // a hair's-width pass.
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
  writeFileAtomic(path, newLiveContent);

  return {
    rotated: true,
    archivePath,
    archivedLineCount,
    retainedLineCount: keptLines.length,
  };
}
