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
  "verdict",
  "verdict.merged",
  "correction.provenance",
  "sweep.disposed",
  "escalation.issue_opened",
  "ratify.approved",
  "ratify.reframed",
  "fix.dispatch",
  "fix.review",
  "dep-review.decided",
  "review.posted",
  "review.post_refused",
  "automerge.capped_override_granted",
  "daemon.boot",
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
  /** Lines retained live — exactly the ones matching {@link DECISION_RELEVANT_LEDGER_STEPS}, plus anything appended after the snapshot (see doc below). */
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

  // ── PASS 1: classify — decision/health-relevant candidates vs pure noise (unchanged from
  // W1-T209: a torn or non-decision-relevant line is archivable). ─────────────────────────
  let candidates: ParsedLedgerLine[] = [];
  for (const parsed of originalOrder) {
    if (parsed.step && (DECISION_RELEVANT_LEDGER_STEPS.has(parsed.step) || isHealthOrDeployStep(parsed.step))) {
      candidates.push(parsed);
    } else {
      archivedLineCount++;
    }
  }

  // ── PASS 2: health-window bound — daemon.boot/deploy.* are heartbeats, not one-shot
  // decisions; only the recent ones (see HEALTH_STEP_RETENTION_WINDOW_MS) are retained, so a
  // restart-storm's boot spam cannot itself bloat the retained core (W1-T244). A line with no
  // parseable `ts` is kept rather than guessed away — absence is never proof of staleness. ──
  candidates = candidates.filter((p) => {
    if (!p.step || !isHealthOrDeployStep(p.step)) return true;
    if (p.tsMs === undefined) return true;
    const withinWindow = nowMs - p.tsMs <= HEALTH_STEP_RETENTION_WINDOW_MS;
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
  // (deduped above) and health/deploy steps (window-bounded above) already have their own
  // bound and are excluded here. ────────────────────────────────────────────────────────────
  const byStep = new Map<string, ParsedLedgerLine[]>();
  for (const p of candidates) {
    const key = p.step ?? "";
    const group = byStep.get(key) ?? [];
    group.push(p);
    byStep.set(key, group);
  }
  const capped: ParsedLedgerLine[] = [];
  for (const [step, group] of byStep.entries()) {
    if (step === "sweep.disposed" || isHealthOrDeployStep(step) || group.length <= MAX_RETAINED_LINES_PER_STEP) {
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
