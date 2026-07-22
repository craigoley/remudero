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
 *
 * Deliberately EXCLUDES pure telemetry/polling noise (`ci.polling`, `pr.polling`,
 * `ops.alerts_polled`, `issues.polled`, `inbox.polled`, ...) — exactly the high-frequency,
 * no-decision-consequence lines that drove the measured growth and are safe to archive.
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
]);

/** True iff `raw` parses as JSON with a `step` in {@link DECISION_RELEVANT_LEDGER_STEPS}. A
 *  torn (unparseable) line is never decision-relevant — same doctrine as readLedgerLines'
 *  own torn-line handling — but is never fabricated into a false positive either. */
function isDecisionRelevantRawLine(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(trimmed) as { step?: unknown };
    return typeof parsed.step === "string" && DECISION_RELEVANT_LEDGER_STEPS.has(parsed.step);
  } catch {
    return false;
  }
}

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

  const keptLines: string[] = [];
  let archivedLineCount = 0;
  for (const raw of snapshot.split("\n")) {
    if (!raw.trim()) continue;
    if (isDecisionRelevantRawLine(raw)) {
      keptLines.push(raw);
    } else {
      archivedLineCount++;
    }
  }

  // Catch-up: fold in anything appended to the live path since the snapshot above, so a
  // concurrent appendLedger call landing in that window is never silently dropped.
  const sizeNow = statSync(path).size;
  const tail = sizeNow > size0 ? readSyncRange(path, size0, sizeNow) : "";

  const newLiveContent = (keptLines.length > 0 ? keptLines.join("\n") + "\n" : "") + tail;
  writeFileAtomic(path, newLiveContent);

  return {
    rotated: true,
    archivePath,
    archivedLineCount,
    retainedLineCount: keptLines.length,
  };
}
