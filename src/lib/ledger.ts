import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
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

/**
 * Append-only NDJSON ledger (MASTER-PLAN §9). Records the run's step timeline,
 * keyed by task id, so a run's provenance is inspectable after the fact. Every
 * line is one JSON object; `ts` and `host` are stamped here at write time.
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

// ── W1-T429: task-id-keyed DECISION reads are repo-blind ────────────────────────────────────
//
// The ledger is one file per INSTANCE (`ledgerPathFor` off `config.root`), and only `run.start`
// carries a `repo:` dimension today — every other task-id-keyed decision read (a breaker-gate's
// own escalation dedup, a cap count, a fleet-control marker's filename) keys on the bare task id
// alone. `drainCommand`/`sweepCommand` already accept `--repo`, and the fleet's plans share ONE id
// scheme (this repo's W1-T12 and a project-init'd repo's W1-T12 are the SAME KEY) — so the moment
// a second repo is driven from one instance, a decision read for one repo's task id silently
// counts/gates against the OTHER repo's history of the same id.

/**
 * THE ONE key-renderer every task-id-keyed decision read/write in this codebase goes through —
 * never a per-site `${repo}:${taskId}` string built by hand (design note i, W1-T429): `<repo>:
 * <task_id>` when `repo` is known, or the BARE `task_id` when it is not. The bare form is
 * deliberately not an error case — it is the LEGACY FALLBACK a call site with no repo dimension
 * yet threaded to it (or a line ledgered before this key existed) renders through, so a
 * pre-existing, unscoped ledger line keeps matching once a caller starts scoping its reads.
 */
export function repoScopedTaskKey(repo: string | undefined, taskId: string): string {
  return repo ? `${repo}:${taskId}` : taskId;
}

/**
 * True iff `line` records a decision for the SAME (repo, task_id) pair as `repo`/`taskId` —
 * the read-side half of {@link repoScopedTaskKey}'s adoption. Built on that ONE helper for the
 * isolating comparison (two lines whose OWN `repo` differs render to different keys and never
 * match, however momentary the equal `task_id`), plus the explicit BACKWARD-COMPAT clause design
 * note (iii) requires: a line ledgered before this task existed carries no `repo` field at all,
 * and must still be found by a read that now knows a repo — an upgrade must never orphan a
 * pre-existing dedup marker or silently re-arm an already-fired escalation/cap.
 *
 * FALSIFIER, both directions (test/ledger-repo-scope.test.ts): (1) two synthetic lines for the
 * SAME `task_id`, each carrying a DIFFERENT `repo`, must never both match one repo's query — the
 * cap/gate one repo consumes must leave the other at zero. (2) a synthetic line with NO `repo`
 * field must still match a query that now supplies one — deleting the fallback clause below fails
 * this direction.
 */
export function matchesRepoScopedTask(line: { task_id?: unknown; repo?: unknown }, repo: string | undefined, taskId: string): boolean {
  if (typeof line.task_id !== "string") return false;
  const lineRepo = typeof line.repo === "string" ? line.repo : undefined;
  if (repoScopedTaskKey(lineRepo, line.task_id) === repoScopedTaskKey(repo, taskId)) return true;
  return lineRepo === undefined && line.task_id === taskId;
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

/**
 * W1-T972: every ledger row is written by SOME process on SOME machine, and until this task
 * nothing on the row said which — the SAME "no writer identity" gap this repo's lock-holder
 * records (drain-lock.ts, inflight-lock.ts, review.ts, all keyed `host: ... ?? hostname()`)
 * already close for a different surface. `identity` is that same primitive, reused rather than
 * reinvented, so a row stamped here JOINS to those holder records on the identical key. It is an
 * OPTIONAL param appended LAST on `appendLedger`'s existing `opts` bag (never a new positional
 * param, so no caller shifts) and defaults to the real `hostname()` — injectable ONLY so a test
 * can drive two DISTINCT identities through two ledger roots in one process, which `os.hostname()`
 * itself (constant per-process) cannot produce; every real caller gets the true machine name.
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
 *   - "dispatch.starvation.cleared"         → run-task.ts's escalateStarvationCleared referent —
 *                                              read alongside the row above to find the CURRENT
 *                                              episode's open issue; losing it can re-close an
 *                                              already-closed issue or skip a genuinely open one
 *                                              (this task).
 *   - "verdict" / "verdict.merged"          → sweep.ts's hasMergeCredit — the credit-backfill
 *                                              rung's idempotence (P29(i)/W1-T149/W1-T150) — AND
 *                                              status.ts's dispatchesWithoutNewOwnedPr, which
 *                                              RESETS on the same fact (both via the one shared
 *                                              `isMergeCreditLine`). Rotating either spelling away
 *                                              would re-strand a back-credited task as
 *                                              circuit-broken, the W1-T377/W1-T378 shape.
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
 *   - "fix.ci_not_green" / "fix.resolved"   → sweep.ts's fixRungStalledWithoutNewHead (W1-T1110)
 *                                              — read alongside a non-"success" "fix.review" to
 *                                              decide whether a dispatch that set the
 *                                              `blocked-fixable`/`conflicted` dedup key already
 *                                              ENDED without landing a new head, and so must not
 *                                              keep deduping this PR against a head nothing will
 *                                              ever move again. "fix.resolved" was display-only
 *                                              (see the exclusion note below) until this task gave
 *                                              it a SECOND, real reader here — losing either line
 *                                              across a rotation re-strands (or wrongly re-arms) a
 *                                              stuck fix dispatch exactly like losing "sweep.disposed"
 *                                              itself would.
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
 *   - "risk_judge.escalated"                → sweep.ts's priorActionsFromLedger builds a
 *                                              sha-keyed `riskRefused` set off this exact step
 *                                              (W1-T970), consulted where `alreadyDone` is
 *                                              computed for `disposition: "mergeable"`. Losing
 *                                              this line across a rotation is the SAME defect
 *                                              this task closes under a new name: the sweep
 *                                              reads the refusal as gone and re-arms a head a
 *                                              risk judge explicitly refused — "the line IS the
 *                                              bound; it must survive rotation" applies verbatim.
 *   - "manual.completed"                    → status.ts's latestManualCompletion — the
 *                                              hand-execution credit rung (W1-T1029), widened to
 *                                              a completion PR in ANOTHER repository and to a
 *                                              completion with no PR at all. Losing this line
 *                                              re-parks every task transitively depending on the
 *                                              one it credited, permanently — a credit-based
 *                                              `depends_on` a hand-completed task can otherwise
 *                                              never satisfy.
 *   - "automerge.hold_engaged" /             → review.ts's automergeHoldFromLedger — an
 *     "automerge.hold_released"                operator's merge hold, consulted by sweep.ts's
 *                                              `alreadyDone` for `disposition: "mergeable"`
 *                                              (W1-T1000002) exactly where "automerge.
 *                                              capped_override_granted" and "risk_judge.escalated"
 *                                              are consulted immediately above. UNLIKE those two,
 *                                              this pair is deliberately NEVER sha-keyed — a hold
 *                                              must survive a push, so losing either line across a
 *                                              rotation either lifts a hold the operator believes
 *                                              still stands (dropping "hold_engaged") or re-freezes
 *                                              a PR the operator already released (dropping
 *                                              "hold_released", the "last one wins" read finding
 *                                              only the stale engage). Both directions are exactly
 *                                              the "the line IS the bound" failure this Set exists
 *                                              to prevent, applied to a hold instead of a cap/risk
 *                                              refusal.
 *
 * Deliberately EXCLUDES pure telemetry/polling noise (`ci.polling`, `pr.polling`,
 * `ops.alerts_polled`, `issues.polled`, `inbox.polled`, ...) — exactly the high-frequency,
 * no-decision-consequence lines that drove the measured growth and are safe to archive — AND
 * excludes the handful of steps ("recon.done", "implement.resumed", "implement.done" as a
 * phase transition) that status.ts's `deriveRunState` reads ONLY to label a cosmetic
 * `phase`/`elapsedMs` for the board/status display: `daemon.ts`'s `reconstructOrphan` proves
 * those never gate a real decision — its `&& projection.prUrl` guard is a no-op for every case a
 * `run.start`/`pr.opened` line (both already covered above) didn't already set. `"fix.resolved"`
 * used to sit in this same display-only group (status.ts's read of it is still cosmetic on its
 * own) — W1-T1110 gave it a SECOND, genuinely deciding reader (sweep.ts's
 * `fixRungStalledWithoutNewHead`, listed above), so it now belongs in the retained set instead;
 * a step is excluded here only while EVERY one of its readers is display-only.
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
/**
 * W1-T2244: the ONE row an operator produces when they act on a risk-judge escalation instead
 * of exercising its "merge it by hand" escape hatch in silence — the CAPPED verdict's sibling
 * escalation class had `automerge.capped_override_granted`
 * (`--override-capped-by`/`--override-capped-reason`) as its attributable, calibratable record;
 * the risk judge had nothing an operator could produce under its own name. Written by
 * {@link import("./panel-actions.js").recordRiskOverride}, read back head-bound by
 * {@link riskOverrideFromLedger} — the SAME "refuse a line whose head_sha does not match the
 * CURRENT head" discipline `cappedOverrideFromLedger` (review.ts) already enforces, so a record
 * never outlives the diff it was judged on (design viii). RECORDING ONLY: nothing in this
 * codebase reads this row to decide whether to dispatch or merge — see that function's own doc
 * for the boundary this task must not cross.
 */
export const RISK_OVERRIDE_RECORDED_STEP = "panel.risk_override_recorded";

/**
 * W1-T2244 (design vii): the two signals an override can carry, and they are OPPOSITE for a
 * calibrator — "judge_wrong" means the escalation itself was a miscalibration (it should not
 * have fired), "risk_accepted" means the escalation was correct and the operator knowingly took
 * the cost anyway. A closed set the writer validates against, never free text alone: a single
 * "overridden" flag would collapse both into "judge error" and drive calibration the wrong way,
 * which the design explicitly calls worse than the silence there is today. Free text (`reason`)
 * rides ALONGSIDE this class, never replacing it — the same shape `--override-capped-reason`
 * already pairs with `--override-capped-by`.
 */
export const RISK_OVERRIDE_REASON_CLASSES = ["judge_wrong", "risk_accepted"] as const;
export type RiskOverrideReasonClass = (typeof RISK_OVERRIDE_REASON_CLASSES)[number];

/** W1-T2244 (design vi): what the operator actually did with the escalated head — a closed set
 *  for the same reason {@link RISK_OVERRIDE_REASON_CLASSES} is closed. */
export const RISK_OVERRIDE_DISPOSITIONS = ["merged_by_hand", "redispatched", "abandoned"] as const;
export type RiskOverrideDisposition = (typeof RISK_OVERRIDE_DISPOSITIONS)[number];

export const DECISION_RELEVANT_LEDGER_STEPS: ReadonlySet<string> = new Set([
  "run.start",
  "pr.opened",
  // W1-T2425: the breaker's own REFUSAL row, joining the ESCALATION row immediately below it.
  // Same prefix, same writer, and until now opposite retention: `.escalated` was decision-relevant
  // and survived (measured 2 live / 2 union on the fleet) while this one belonged to none of the
  // three retention sets and was archived entire by PASS 1 (0 live / 78 union). The row carries
  // `freshCount` — the count the breaker actually decided on, present on 78 of 78 rows — and
  // `seedCountFromCircuitBreak` (status.ts) reads it to give a RESTARTED process the baseline its
  // in-memory `cache.lastCounts` cannot carry across a boot. Archived away, that baseline reads
  // absent, `evaluateDispatchBreakerDetailed`'s regression arm is unreachable, and a rotation that
  // shortens the live file un-trips a tripped breaker silently — which is exactly the class this
  // Set exists to prevent, and exactly what happened to W1-T1279 for 84 hours on 2026-08-27.
  // Bounded by PASS 4's per-step cap like every other member; no cap moves for it.
  "dispatch.circuit_broken",
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
  // This change: `escalateHeadroomParkCeiling` (run-task.ts) READS this row to decide whether it
  // has already paged for the CURRENT blind stretch — it compares this row's timestamp against
  // the newest `daemon.headroom` (immediately relevant below, and already retained). A rotation
  // dropping this one re-opens one duplicate page per daemon boot for as long as the probe stays
  // broken, which on a restart-looping host is exactly the pager this dedup exists to prevent.
  "daemon.headroom.park_ceiling.escalated",
  // …and the row that ENDS a blind stretch, which the same dedup compares against: a readable
  // probe writes `daemon.headroom`, and an escalation newer than the newest of those means we
  // have already paged for the CURRENT blindness. RETENTION COST IS ZERO — `isRenderRelevantStep`
  // already keeps it for the console's account strip, and `rotateLedger` retains a line matching
  // ANY of the three sets — so this entry only records that a DECISION now reads it too, which is
  // what the derived-from-consumers test enforces.
  "daemon.headroom",
  // W1-T372: escalateQuotaExhaustion's (run-task.ts) own dedup marker, read per bucket
  // (`l.bucket === info.bucket && l.resets_at === info.resetsAt`) — the SAME "written whether
  // or not delivery succeeds" discipline as `daemon.headroom_reserve.escalated` immediately
  // above. A rotation dropping it re-opens one duplicate quota-exhaustion notice per tick for
  // as long as the bucket stays exhausted.
  "daemon.quota_exhausted.escalated",
  // W1-T1082: `escalateDiskHeadroomBreach`'s (run-task.ts) own dedup marker — the SAME
  // "compare THIS marker's own `ts` against an episode window" shape `escalatePostReviewStall`
  // applies just below for a condition with no natural reset boundary (unlike
  // `daemon.headroom_reserve.escalated`'s `resets_at`). The in-process latch in `runDaemon`
  // (`daemon.ts`) already bounds one escalation per CONTINUOUS breach within a single process —
  // this marker is what stops a daemon RESTART mid-episode (disk pressure can itself crash-loop
  // the daemon) from re-opening a duplicate issue on the very next tick. A rotation dropping it
  // re-opens one duplicate needs-human issue on every tick this condition persists, once the
  // marker falls out of the retained view — the #977 class again, on the one alarm this task
  // exists to make reachable before the disk that would otherwise swallow it fills up.
  "daemon.disk_headroom.escalated",
  "dispatch.starvation.escalated",
  // This task: escalateStarvationCleared's (run-task.ts) own referent boundary — read alongside
  // "dispatch.starvation.escalated" above to find the CURRENT episode's open issue (the most
  // recent "escalated" row not yet followed by a "cleared" one). Losing it to rotation would let
  // a stale, already-closed issue URL be re-derived from an older "escalated" row and re-closed
  // (or worse, silently skipped as "already closed" while a genuinely NEW episode's issue stays
  // open) — the exact referent confusion this row exists to prevent.
  "dispatch.starvation.cleared",
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
  // W1-T1110: sweep.ts's `fixRungStalledWithoutNewHead` reads these two (alongside "fix.review"
  // above) to decide whether a `blocked-fixable`/`conflicted` dedup's dispatch already CONCLUDED
  // without landing a new head — see that function's own doc. Losing either across a rotation
  // reads a stalled dispatch as still in flight and re-strands the PR against a head nothing will
  // ever move again, the exact deadlock this task fixes.
  // W1-T1211: run-task.ts's `runIsAwaitingExternal` reads this row to decide whether the light pass
  // may let the fix rung act beside an in-flight run — a run that has written it has finished its
  // worker turn and is waiting on GitHub. Written ONCE per wait, never per poll, which is why it
  // belongs here and `ci.polling`/`pr.polling` (named as telemetry noise above) do not: losing this
  // row across a rotation reads a WAITING run as WORKING and silently re-freezes the fix rung for
  // that run's whole duration, which is the twenty-one-hour stall the task measured.
  "run.awaiting_external",
  "fix.ci_not_green",
  "fix.resolved",
  // W1-T1095 (capability 3): run-task.ts's `fixRebaseAlreadySpent` reads this row to enforce the
  // shard's "AT MOST ONE rebase-and-retry per blocked PR" bound (design iii). It is the ONLY
  // record of that bound — there is no timer and no state file — so losing it across a rotation
  // would silently restore an unbounded rebase-and-retry, which is the retry loop this capability
  // exists to avoid becoming. Its siblings `fix.rebase_refused`/`fix.rebase_failed` are
  // deliberately NOT here: nothing decides on them, and a step belongs in this set only while a
  // real deciding reader consults it.
  "fix.rebased",
  // W1-T2436 (capability 2): run-task.ts's `priorPrerequisitePrFor` folds these rows, keyed by
  // `pr_url`, to answer "has a prerequisite PR already been opened for this entangled PR?" — the
  // SAME ledger-as-memory idiom as `fix.rebased` directly above, and for the same reason: there is
  // no state file and no timer, so this row is the ONLY record that the split was already
  // produced. Its own doc says the ledger "not the review, is this capability's own memory",
  // precisely because `detectInstrumentEntanglement` is diff-derived and reports an unchanged
  // entangled diff as entangled forever. Archived away by a rotation, the fold reads `undefined`
  // and the rung dispatches a SECOND worker to open a SECOND prerequisite PR for a split it has
  // already produced — an unbounded re-dispatch, the same class the `fix.rebased` note above
  // guards against. Bounded by PASS 4's per-step cap like every other member; no cap moves for it.
  "fix.prerequisite_opened",
  "dep-review.decided",
  "review.posted",
  "review.post_refused",
  // W1-T913: `postReviewPending` (review.ts) writes this the moment a review is DETECTED, before
  // any judging happens, and `lastPendingReviewStatusFromLedger` READS IT BACK to decide two
  // things: whether a pending status was already posted for THIS head (idempotence per head), and
  // how long the review has been pending — the `ts` on this very line is the staleness clock
  // `OpenPrView.reviewPendingSince` carries. A rotation dropping it therefore does not merely lose
  // a record: it re-posts a duplicate pending status on the next pass and resets the clock, so a
  // review stalled for hours reads as freshly detected and never surfaces as stalled. Same
  // "the line IS the bound" discipline as its two siblings immediately above.
  "review.pending_posted",
  // W1-T1017: W1-T322's SHIPS-UNWIRED advisory floor line — measured live 4 / rotations 83
  // against a `review.posted` control of live 219 / rotations 390, i.e. rotation was dropping
  // 95%+ of these rows. UNLIKE every other entry in this Set, the deciding reader is not code:
  // it is the operator adjudicating W1-T323's advisory-versus-blocking flip against this exact
  // corpus, which is why `run-task.ts`'s own emitter comment (the "NOT added ... deliberately"
  // note beside `log("review.unwired_advisory", ...)`) is now stale and due a follow-up edit,
  // not why the row itself should keep expiring. W1-T323 clause (iii) already named this
  // registration but sequenced it INSIDE the flip change, downstream of the adjudication it
  // exists to protect; this entry registers it now instead, ahead of that change, so it is a
  // no-op (not a conflict) if W1-T323 lands first and registers the step itself. Preserves rows
  // from the next rotation onward only — it does not and cannot restore the 2026-08-04 through
  // 08-10 rows already archived out of this host. Bounded the same as every other entry here by
  // `MAX_RETAINED_LINES_PER_STEP` (200 newest per step, PASS 4 below), comfortably above the 87
  // rows measured live at filing time.
  "review.unwired_advisory",
  "automerge.capped_override_granted",
  // W1-T2244: the risk-judge escalation's own override record — see this Set's own doc, just
  // above, for why it must sit beside its capped-verdict sibling rather than expire like
  // `panel.escalation_marked_handled` (deliberately NOT registered here: it carries no verdict,
  // confidence, disposition or reason a calibrator could read back, so it stays outside the
  // never-rotated core exactly as it does today).
  RISK_OVERRIDE_RECORDED_STEP,
  "daemon.boot",
  // W1-…/impl-DF: the idle rung's reason tally. A HUMAN reads this to tell "starved of work"
  // from "everything filtered", and it is emitted only on change -- so it is sparse by design and
  // rotation would otherwise drop exactly the lines that explain a long idle.
  "daemon.idle_reasons",
  "sweep.post_fix_redriven",
  // W1-T970: `priorActionsFromLedger`'s `riskRefused` set (sweep.ts) reads these back,
  // sha-keyed, to withhold auto-merge arming from a head the risk judge already refused —
  // see the doc block above for the rotation-survival reasoning.
  "risk_judge.escalated",
  // W1-T186's ABSENT remedy: `priorActionsFromLedger` counts these lines to enforce
  // ABSENT_REPUSH_CAP. Archived away, the count reads zero and every rotation re-earns the
  // PR another empty commit — an unbounded re-push loop, which is precisely the failure the
  // cap exists to prevent. The line IS the bound; it must survive rotation.
  "sweep.absent_repush",
  // `escalatePostReviewStall` (run-task.ts) COUNTS these back to decide whether the CURRENT
  // post-review stall has already been escalated — the episode key, exactly the shape
  // `daemon.crashloop.escalated` above uses. The line IS the dedup: `escalate()` skips its whole
  // dedup block when the escalation names no PR (`if (prRef && deps.issues.listOpen)`), and a
  // post-review stall is a fleet-wide condition with no single PR to name, so a rotation archiving
  // this marker would re-open one needs-human issue PER SWEEP TICK — the same unbounded shape that
  // produced eight identical "dispatch queue starved" issues.
  "sweep.post_review.stalled.escalated",
  // `detectPostReviewStall` (lib/sweep.ts) COUNTS the current consecutive run of `.failed` lines and
  // RESETS that count on a `.done` — so both are deciding reads, and both must survive rotation.
  // Without them the stall detector would inherit the very defect it exists to fix: a rotation
  // mid-stall would archive the failures, reset the run to zero, and the stall would go unnoticed
  // again — the #977 (`sweep.absent_repush`) class, applied to this feature. Bounded like every
  // other member by MAX_RETAINED_LINES_PER_STEP (200 newest per step), which is far above the
  // detector's threshold of 8, so this costs a fixed and small amount of retained history.
  "sweep.post_review.done",
  "sweep.post_review.failed",
  // W1-T393 (MASTER-PLAN §11 D-10): `mutationGateLifetime` (src/lib/retro.ts) folds this step
  // into `mutation-ratchet`'s LIFETIME kill/survive/escape record — the exact "sweep.
  // absent_repush" shape clause (iv) of that task's design names: a rotation archiving this line
  // away would silently reset a LIFETIME figure back to zero every time the ledger rotates,
  // reproducing the very defect ("no gather ever carried that column, because nothing recorded
  // it durably") this task exists to close. Registered here in the SAME change that adds the
  // step (retro.ts's `MUTATION_GATE_VERDICT_STEP`), before anything writes it in production —
  // see that constant's doc for why the write call site itself is a follow-up, not this change.
  "mutation.ratchet_verdict",
  // W1-T435: lib/sweep.ts's `operatorVerdictEvidence` (run-task.ts's `buildOpenPrViews` calls it
  // per open PR) reads `operator_feedback` lines to quote a wrong/needs-follow-up verdict's
  // steering note into the next fix-rung dispatch — a DECIDING read (it drives the
  // `blocked-fixable` re-arm), not display-only, so rotation must retain it the moment that
  // consumer exists (the #977/W1-T240 class this task's own rationale names).
  "operator_feedback",
  // W1-T470: `injectCoverageImprovementTask`'s (src/lib/coverage-improvement.ts) own dedup
  // marker — read back via a ledger UNION (never the live file alone; the escalation precedent
  // this shape is modeled on used a rotation-capped one-file read that eventually forgot its own
  // marker and refiled identical content forever) to decide whether a run's exact debt-file
  // signature was already filed as a plan/feedback/ entry. A rotation dropping this line would
  // reproduce that exact bug one module later: the next red-band CI run reads "not yet filed"
  // and re-files the same debt profile, the unbounded-refile loop this dedupe exists to prevent.
  "coverage.improvement.filed",
  // W1-T949: the reservation-REFUSAL record for each id-filing lane (triage/plan/approve).
  // Before this, `reserveTaskIdRemote`'s `TaskIdReservationError` landed only as a stringified
  // message inside the lane's generic `*.error` line — no id, no ref, no outcome discriminator,
  // and nothing separating "could not reach origin" from any other lane failure (rationale (6)).
  // These three carry `id`/`ref`/`outcome` (task-id-reservation.ts's `TaskIdReservationError`
  // fields) as their OWN structured fields, so an operator auditing "why did this filing open no
  // PR" a week later can query them directly instead of grepping a rotated-away free-text field.
  // UNLIKE most of this Set, the deciding reader is a HUMAN (the same "review.unwired_advisory"
  // shape above), not code — so these will never appear in the derived-from-consumers test's
  // scanned `.step === "..."` corpus below, and that is expected, not a gap: see that test's own
  // doc for why a step no automated consumer reads still needs a human-adjudicated registration.
  "triage.id_reservation_failed",
  "plan.id_reservation_failed",
  "approve.id_reservation_failed",
  // W1-T1029: `latestManualCompletion` (status.ts) reads this back to widen rung (b)'s
  // hand-execution credit to the two shapes a tasks.yaml `pr:` field cannot express — a
  // completion PR in another repository, and a completion with no PR at all. The line IS the
  // credit: a rotation archiving it away re-parks W12-T1/W1-T12e (and every task transitively
  // depending on them) behind a `depends_on` that can never again be satisfied, the exact
  // "sweep.absent_repush" shape this Set exists to prevent, applied to a dependency edge
  // instead of a re-push cap.
  "manual.completed",
  // W1-T1000002: review.ts's automergeHoldFromLedger reads both back, "last one wins" over the
  // whole ledger with NO head-sha binding (see this Set's own doc comment above for why a hold
  // must outlive a push) — sweep.ts's `alreadyDone` for `disposition: "mergeable"` and the arm
  // completion in run-task.ts (`attemptArm`) both consult it before ever registering an arm.
  "automerge.hold_engaged",
  "automerge.hold_released",
  // W1-T1215: `armRunIdFromLedger` (run-task.ts) reads these rows to name WHICH lane armed a PR
  // that merged behind a refused verdict. A rotation that dropped them would silently turn every
  // such HARD_STOP's attribution into "unattributed" — the same quiet-reset failure this Set
  // exists to prevent, so the read makes the step decision-relevant rather than cosmetic.
  "automerge.armed",
  // W1-T1212: `redPrWithStaleGate`'s caller (run-task.ts) derives `updatedForWorkflow` from a
  // ledger scan over this row's own `stale_workflow` field to decide whether a given
  // `${prNumber}:${workflowName}` pair has already been spent — see `SweepDeps.updatedForWorkflow`
  // and `redPrWithStaleGate`'s own "ALREADY UPDATED FOR THIS WORKFLOW" design note (sweep.ts). A
  // rotation dropping this row would forget the pair was already fired, re-selecting the same
  // stale-gate PR for the same workflow on every subsequent pass — the update-branch head is
  // spent for nothing, forever, the same unbounded-re-fire shape `sweep.absent_repush` exists to
  // prevent, applied to this lane's own dedup instead.
  "sweep.update_branch.updated",
  // W1-T1235: run-task.ts's `latestGhRateLimitRefusalsFromLedger` reads the NEWEST
  // `automerge.rate_limit_refused` line per bucket for `rmd status`'s GITHUB BUCKETS section
  // (`line.step !== "automerge.rate_limit_refused"` guard) — a rate-limited auto-merge arm's
  // own naming of the exhausted bucket (see `logArmAttribution`'s own doc). Placed here rather
  // than the recency-bounded RENDER_RELEVANT_LEDGER_STEPS category deliberately: GitHub's own
  // bucket resets are commonly an hour or more out, longer than RENDER_STEP_RETENTION_WINDOW_MS
  // (30 minutes) would keep this line visible for, and an operator diagnosing a stuck merge
  // needs to see the LAST refusal regardless of how long ago it fired — the same "GitHub quota
  // event, worth permanent operator-visible history" reasoning `daemon.quota_exhausted.escalated`
  // above already carries for its own sibling event. Sparse by construction (fires only on an
  // actual rate-limit-shaped arm refusal, never on ordinary traffic — acceptance 6 of this
  // task), so permanent retention costs nothing beyond the fixed MAX_RETAINED_LINES_PER_STEP
  // ceiling every other member of this Set already accepts. Its siblings
  // `automerge.arm_failed`/`automerge.arm_skipped` are deliberately NOT registered anywhere
  // (matching their pre-existing, unprotected status quo) — only this ONE step, the one
  // `rmd status` actually reads, needs the guard.
  "automerge.rate_limit_refused",
  // KEEP THE W1-T964 TRIO LAST, immediately before the Set's close: the mutation check in
  // test/ledger-rotation.test.ts anchors on those three lines followed by `]);` and asserts the
  // needle occurs EXACTLY once. A block appended after them silently breaks that anchor — this
  // merge did exactly that once, and the sanity assertion is what caught it.
  // W1-T964: `report.followups` (run-task.ts's `harvestFollowupsFromReport`, one line per
  // dispatched task's `## Follow-ups` section) and its two harvest marks, `followup.harvested`/
  // `followup.deduped` (retro.ts's `recordFollowupHarvest`, one line per entry within such a
  // section) — mined together by `mineFollowups` (retro.ts:2139), which matches a mark back to
  // its source entry by `entryId` (`${runId}:${ts}:${index}`, W1-T2252) to decide whether to mint a fresh
  // candidate for the Architect or skip an already-adjudicated one. DECISION-RELEVANT, NOT
  // RENDER OR HEALTH: `mineFollowups`'s own doc (retro.ts:2131-2134) states a followup "must
  // survive PAST the marker window (a discovery from three retros ago is still worth
  // surfacing)" — ruling out both RENDER_RELEVANT_LEDGER_STEPS's 30-minute window
  // (RENDER_STEP_RETENTION_WINDOW_MS) and isHealthOrDeployStep's 15-minute one
  // (HEALTH_STEP_RETENTION_WINDOW_MS), neither of which could hold a discovery from three
  // retro cycles ago; RENDER_RELEVANT_LEDGER_STEPS is for OPERATOR-VISIBLE HISTORY the console
  // renders, not a decision this codebase makes, so it is the wrong category on its own terms
  // too (the W1-T275 precedent immediately above: widening the wrong set "would silently trade
  // one failure for another"). All three MUST land here TOGETHER — a rotation that keeps
  // `report.followups` live while `followup.harvested`/`followup.deduped` are not RE-MINTS the
  // entry as a fresh candidate on the next mine (the Architect is shown work it already
  // adjudicated); the reverse (marks retained, source dropped) LOSES the entry silently, mark
  // left behind as an orphan. Before this line, all three read ZERO membership in every
  // retention category and were archived unconditionally on the very next rotation regardless
  // of volume — see test/followup-rotation-idempotency.test.ts.
  "report.followups",
  "followup.harvested",
  "followup.deduped",
]);

/**
 * W1-T2244: one recorded operator override of a risk-judge escalation, as recovered off the
 * ledger. The judged VERDICT and CONFIDENCE are carried here VERBATIM (copied off the
 * `risk_judge.decision`/`risk_judge.escalated` line at write time, never re-derived), so the row
 * stays self-contained once the escalation itself has rotated away.
 */
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
 * Recover the most recent {@link RISK_OVERRIDE_RECORDED_STEP} line for `taskId`, "last one wins"
 * — the SAME scanning idiom {@link import("./review.js").cappedOverrideFromLedger} uses for its
 * capped-verdict sibling.
 *
 * HEAD-BOUND, deliberately mirroring `cappedOverrideFromLedger`'s W1-T219 binding (design viii):
 * `headSha` — the CURRENT head being judged, supplied by the caller — must match the recorded
 * line's own `head_sha` exactly, or the line is skipped as if it were never there. An override
 * that outlived the head it judged would be evidence about a diff that no longer exists. A line
 * whose `disposition`/`reason_class` does not fall inside the closed sets above is likewise
 * skipped, never coerced — the ledger is append-only and unauthenticated, so a malformed or
 * hand-edited row is treated as absent rather than trusted.
 *
 * READ FOR DISPLAY ONLY. Nothing in this codebase may call this to decide whether to dispatch or
 * merge — the escalation still blocks and auto-merge still refuses regardless of what this
 * returns (design ix/x). It exists so a reader can say an override WAS recorded and under which
 * class, never to grant one.
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
  // W1-T333 (THE OPERATOR'S AUDIT REQUIREMENT): who/when/from/to for every console write to the
  // daily-cost-ceiling override (policy.ts's `state/DAILY_COST_CEILING_OVERRIDE`, W1-T332).
  // RENDER, NOT DECISION -- THE ARGUMENT, CONFIRMED AGAINST SOURCE RATHER THAN INHERITED (this
  // task's own design note demands exactly that): the CURRENT override value is STATE and lives
  // in `state/DAILY_COST_CEILING_OVERRIDE`, read fresh by `policy.ts`'s `resolveDailyCostCeiling`
  // on every call -- no decision in this codebase re-reads THIS ledger line to learn the ceiling,
  // it reads the store. This line is HISTORY: it is how "was this ever overridden, by whom, when,
  // from what, to what" survives the store's own documented DISAPPEARANCE CASE (policy.ts's
  // header) -- `state/` is deliberately outside git, so a wiped state root reverts silently to the
  // committed default with NO error, and `resolveDailyCostCeiling` ALONE cannot then tell "never
  // overridden" apart from "a real override just vanished" (both read `provenance: "default"`
  // with no `fallback`). A decision therefore never depends on this line surviving, so it belongs
  // in the recency-bounded render set, not the never-rotated decision core -- putting it there
  // would retain a frequently-tuned knob's full write history forever for a value that is, itself,
  // already retained in `state/`.
  //
  // src/lib/account-usage.ts's `deriveCeilingOverrideAudit` reads the NEWEST
  // `console.ceiling_override_written` line for the ACCOUNT strip's ceiling-audit slot
  // (`line.step !== "console.ceiling_override_written"` guard, the same shape every other
  // render-relevant reader above already uses).
  "console.ceiling_override_written",
  // W1-T1237 (THE SWEEP HEARTBEAT WOULD NOT SURVIVE BEING READ): `sweep.pass` and `sweep.summary`
  // (src/lib/sweep.ts, "PER-PASS HEARTBEAT, WRITTEN BEFORE THE LOOP") were in NEITHER retention
  // set before this task, so rotation archived them like any other diagnostic row — the same
  // exposure this whole category exists to close (W1-T275's `daemon.headroom` precedent,
  // verbatim). RENDER, NOT DECISION, on this category's own terms: nothing in this codebase's
  // dispatch path re-reads either line to decide anything (sweep.ts's own predicates are
  // re-evaluated fresh every tick), so widening the never-rotated `DECISION_RELEVANT_LEDGER_STEPS`
  // core for a report-only read would trade a bounded-retention bug for unbounded growth, the same
  // ruling this file already applies to every other entry here.
  //
  // BOTH steps, by exact name, because `isRenderRelevantStep` is a `Set.has`, never a prefix
  // match. src/lib/doctor.ts's `judgeSweepLiveness` (W1-T1236) makes TWO faults out of these rows
  // and needs both: (a) the newest `sweep.pass` older than a bound derived from this host's own
  // observed cadence, and (b) the newest `sweep.pass` with no `sweep.summary` AT OR AFTER its own
  // timestamp — the paired derivation is worthless if only one half of the pair survives rotation.
  //
  // src/lib/doctor.ts's `readSweepPassSummaryTimestamps` reads both steps through doctor.ts's own
  // exported `SWEEP_LIVENESS_STEPS` boundary marker (`.has(step)`) — the single source
  // `test/ledger-render-retention.test.ts`'s derived-from-consumers lock also scans, so this
  // registration cannot silently rot the way an untested hardcoded pair could.
  "sweep.pass",
  "sweep.summary",
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

// ── CONSOLE WRITE AUDIT: the daily-cost-ceiling override (W1-T333) ─────────────────────────────
//
// THE OPERATOR'S AUDIT REQUIREMENT, verbatim in substance: who/when/from/to for every console
// write, and better than git because it is queryable at runtime. `appendLedger` is append-only, so
// ONE LINE PER WRITE is the full history, never a summary that could itself go stale.

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

/**
 * Ledger one console write to the daily cost ceiling override — see this section's header and
 * {@link DailyCostCeilingOverrideAudit}'s doc for what "who/when/from/to" maps to here. The
 * caller (the console WRITE control itself — NOT built by this task; see W1-T333's own "NOT IN
 * SCOPE" note) is responsible for invoking this immediately alongside `policy.ts`'s
 * `writeDailyCostCeilingOverride`, so a write that is auditable but never actually took effect
 * (or vice versa) can never happen.
 */
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
 *  only ever sees the whole old file or the whole new one, never a partial rewrite. `content`
 *  accepts a `Buffer` (gzip's own output, W1-T2482) as well as a `string`, so the same atomic
 *  staging idiom covers a compressed archive without a UTF-8 round trip corrupting its bytes. */
function writeFileAtomic(path: string, content: string | Buffer): void {
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
  renameSync(tmpPath, path);
}

function datedArchivePath(path: string, now: Date): string {
  const base = basename(path).replace(/\.ndjson$/, "");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dirname(path), `${base}.${stamp}.ndjson`);
}

/** Minimal fs surface {@link writeArchive} needs for compression, injectable (same reason
 *  {@link LedgerRotationFsDeps} is) so a test can force the compression step itself to fail —
 *  proving the plain-archive fallback below — without monkey-patching `node:zlib` globally. */
export interface LedgerArchiveFsDeps {
  gzipSync: (buf: Buffer) => Buffer;
}

const realArchiveFs: LedgerArchiveFsDeps = {
  gzipSync: (buf) => gzipSync(buf),
};

/**
 * W1-T2482 — COMPRESS AT ROTATION, THE HALF THE READER ALREADY EXPECTED. `ledger-grep.ts`'s
 * `ledgerRotationEntries` has classified `<base>.<stamp>.ndjson.gz` as gzip-form since W1-T444;
 * this writer never produced one, so every rotation on a long-lived host accumulated plain and
 * every union read (11 modules) paid to scan all of them. Measured on the incident host: 47
 * plain archives, 199M -> 29M after gzip, 87.6-93.7% per-file reduction.
 *
 * `plainArchivePath` is the name `datedArchivePath` chose (still `.ndjson`, no `.gz`) — the
 * SAME dated name a caller reading `result.archivePath` back from before this task would have
 * seen, just with a suffix appended once compression is known to have succeeded, so the
 * pointer/log line always names the file that actually exists on disk.
 *
 * FALLBACK, NOT LOSS: if `gzipSync` itself throws (OOM, a future zlib regression, an injected
 * test double), the archive lands PLAIN at `plainArchivePath` — the pre-W1-T2482 shape the
 * union reader has always classified — rather than the rotation losing the snapshot outright.
 * A rotation's whole job is "the audit trail is relocated, never deleted" (see `rotateLedger`'s
 * own doc); compression is an optimization layered on top of that guarantee, never a
 * precondition for it.
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
 * COMPRESSION (W1-T2482): the dated archive is gzipped via {@link writeArchive} before it is
 * written — the live path rewritten below is NEVER compressed, only the just-rotated snapshot,
 * so an append-in-progress on the live ledger is untouched by this. `ledger-grep.ts`'s union
 * reader has classified both `.ndjson.gz` and plain `.ndjson` rotations since W1-T444, so this
 * needs no reader-side change; it only stops the writer from producing the form the reader was
 * built to read but never received.
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

  const size0 = statSync(path).size;
  const snapshot = readSyncRange(path, 0, size0);

  const plainArchivePath = datedArchivePath(path, opts.now?.() ?? new Date());
  const archivePath = writeArchive(plainArchivePath, snapshot, archiveFsDeps);

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

// ── W1-T234: STATE BACKUP/RESTORE ORGAN (MASTER-PLAN §10 WS-7) ──────────────────────────────
//
// state/ holds the ledger above, the run locks (drain.lock, inflight/), the worker-keychain
// service tokens, and the proposals register (inbox-proposals.json, gained P37-P45 on one
// disk this session) — and until this task, none of it was backed up. Lives here rather than
// a new module because it reuses this file's own atomic-write/dated-archive idiom
// (`writeFileAtomic`/`datedArchivePath`, W1-T209 above) for the SAME reason that idiom exists:
// a backup that is half-written when the process dies must never be mistaken for a whole one.
//
// SCOPE (design note i): back up what is IRREPLACEABLE, not everything in the directory.
// `STATE_BACKUP_EXCLUDED_RELPATHS` is the one file this task's own rationale explicitly proves
// rederivable (`status.json`) — every other entry under `state/`, including the ledger's own
// W1-T209 rotation archives (`ledger.<stamp>.ndjson`, picked up here for free by walking the
// directory rather than hardcoding one filename — the coordination design note iii calls for),
// is treated as authoritative until this comment names an equally explicit rederivability
// proof for it, per the same design note's instruction not to guess.
//
// VERIFY, DON'T TRUST (design note ii): `snapshotState` re-lists the STAGED copy from disk
// after copying and refuses to publish (rename into place) a snapshot that is empty or that
// dropped the ledger/proposals register the source actually had — see its own doc.
//
// FAILURE ESCALATES LOUDLY (design note iv): every failure path here is a THROWN
// {@link StateBackupError}, never a caught-and-logged no-op — a caller (a launchd-scheduled
// `rmd state-backup` run, per the W1-T152/W1-T169 launchd lineage design note iii names as the
// obvious scheduler) that lets it propagate exits non-zero, which launchd's own
// `StandardErrorPath` and exit-status observability surface loudly. Wiring that CLI
// entrypoint/plist is left to a follow-up (see this task's PR) — the functions below are the
// tested, load-bearing primitives that entrypoint would call.

/** Loud, typed failure for every state-backup/restore operation — always THROWN, never
 *  swallowed (design note iv, above). `cause` carries the underlying fs error when there is
 *  one, so a caller/log line keeps the original stack without this class re-deriving it. */
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

/**
 * Relative paths under `state/` excluded from every snapshot because they are cheaply
 * rederivable, not because they merely look unimportant. `status.json` is the only entry —
 * this task's own rationale states outright "status.json is rederivable and does not
 * matter". See this section's header comment for why nothing else is excluded by default.
 */
export const STATE_BACKUP_EXCLUDED_RELPATHS: ReadonlySet<string> = new Set(["status.json"]);

/** One completed snapshot. */
export interface StateBackupSnapshot {
  /** Absolute path to the finished, verified snapshot directory. */
  archiveDir: string;
  /** Relative paths of every file the snapshot copied, sorted, relative to `state/`. */
  entries: string[];
}

/** Recursively lists every FILE (never a directory itself) under `root`, as paths relative
 *  to `root`, sorted, skipping any relative path in `excluded`. Shared by both the staging
 *  and the post-copy verification read in {@link snapshotState}, and by {@link restoreState} —
 *  ONE walk, so a future exclusion/traversal fix applies to snapshot, verify, and restore
 *  alike rather than drifting across three hand-written copies. */
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

/** Copies `relPaths` from `srcRoot` to `dstRoot`, creating destination directories as
 *  needed and preserving each source file's permission bits (chmod, best-effort) — the
 *  service-token files under `state/` are 0600 by design (worker-home.ts's
 *  `workerKeychainPaths`) and a backup that silently widened them on restore would be a
 *  regression this task exists to prevent, not one it introduces. */
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
 * Snapshots `stateDir` into a freshly-created, dated directory under `backupsRoot`.
 * ATOMIC PUBLISH: stages every copy into a temp dir under `backupsRoot` first, verifies the
 * staged copy from disk (never trusts the in-memory copy list), and only then `renameSync`s
 * it into its final dated name — mirroring `writeFileAtomic`/`rotateLedger` above, so a
 * process death mid-copy leaves at most an orphaned temp dir, never a partial archive at a
 * name a restore would trust. `backupsRoot` is deliberately never inside `stateDir` itself
 * (it would otherwise recurse into its own prior backups on the very next run).
 *
 * VERIFICATION (design note ii — "a snapshot that is not verified is not a backup"): refuses
 * to publish, throwing {@link StateBackupError}, when the staged copy is empty, or when the
 * source contained {@link STATE_BACKUP_LEDGER_RELPATH} or
 * {@link STATE_BACKUP_PROPOSALS_REGISTER_RELPATH} and the staged copy does not — the two
 * files this task's own acceptance names by name. A verification failure is cleaned up (the
 * temp dir is removed) rather than left behind as an empty or partial archive.
 *
 * `opts.copy` overrides the staging step and exists for ONE reason: to make that verification
 * falsifiable. `copyStateFiles` copies every entry it is given or throws, so against the real
 * implementation the "the staged copy lost a file" arm is unreachable — and an unreachable
 * check is indistinguishable from an absent one, which is the shape this task exists to
 * refuse. Only that one test supplies it; every other caller, and every other test here, runs
 * the default.
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

/**
 * Restores every file under a snapshot directory (as produced by {@link snapshotState}) into
 * `targetStateDir`, byte-for-byte (permission bits preserved best-effort, same as the
 * snapshot side — see {@link copyStateFiles}). THE RESTORE IS A VERB, NOT A RUNBOOK
 * PARAGRAPH (design note iii): this is the one command an operator mid-incident runs, not a
 * paragraph describing what they should do. Refuses (throws {@link StateBackupError}) an
 * absent or empty archive rather than silently no-op'ing over an existing state dir.
 */
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
 * W1-T2383 rank 3 — IS THIS `run.start` A QUEUE DISPATCH, OR A LANE RUN?
 *
 * Until this task every `run.start` row carried `type: "implement"` (measured: 547 of 547), so
 * "a run.start" and "a task dispatched off the queue" were the same fact and three readers were
 * written on that identity. Adding a row for the triage and retro lanes separates them, and this
 * predicate is where the separation is stated ONCE rather than re-derived at each reader.
 *
 * TRUE for an implement dispatch, and for a row that declares no `type` at all — the 67
 * pre-schema rows in the retained corpus predate the field and were all implement dispatches, so
 * treating an absent `type` as one keeps every historical reading byte-identical. FALSE only for
 * a row that positively declares some other lane.
 *
 * THE THREE READERS THAT NEED IT, AND WHY (each has a test pinning it):
 *   - `distinctDispatchedTaskIds` (status-board.ts) feeds `deriveCircuitBrokenBlockers`, which
 *     does NOT filter to plan tasks. Measured against the real lane history: two feedback ids
 *     would have reached the cap of five runs with no `pr.opened` and rendered a phantom
 *     `circuit_broken` blocker for an id no dispatch will ever take.
 *   - `dispatchRunStarts` (status-board.ts) feeds `deriveDispatchCadence`, whose bound is
 *     "3x the longest observed gap between DISPATCHES on this host". A lane run is not a queue
 *     dispatch, so counting it would silently tighten a queue-head staleness bound.
 *   - `taskDurations` (analytics-route.ts) pairs a start with a verdict and counts the unpaired
 *     as `noTerminalCount`. The lanes emit no verdict by design (this task deliberately does not
 *     add one), so every lane run would land there and inflate that metric.
 *
 * EVERY OTHER `run.start` READER IS KEYED ON `task_id` and needs nothing: `RETRO` and
 * `TRIAGE-fb-*` are not plan task ids, so a fold asked about a plan task never sees these rows.
 */
export function isQueueDispatchRunStart(line: Record<string, unknown>): boolean {
  if (line.step !== "run.start") return false;
  const type = line.type;
  return type === undefined || type === "implement";
}
