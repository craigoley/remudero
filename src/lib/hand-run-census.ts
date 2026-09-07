/**
 * lib/hand-run-census.ts — W1-T2697: the ledger's `actor` field (ledger.ts) finally tells an
 * OPERATOR row (a bare `./bin/rmd` invocation) apart from a worker or the daemon's own loop. The
 * inverse of `rmd emissions`'s `attributeVerbs` (what the fleet never does): this asks what the
 * operator keeps doing BY HAND.
 *
 * Invariant: over the ledger union (never the live file alone — W1-T1013), operator rows group
 * into SESSIONS by writing process (`actor_pid`) and a gap under {@link HAND_RUN_SESSION_GAP_MS}
 * (guards OS pid reuse across unrelated invocations days apart), each session reduces to its
 * ordered STEP SEQUENCE, and a sequence recurring on at least
 * {@link HAND_RUN_RECURRENCE_DAY_FLOOR} DISTINCT DAYS (never raw session count) is a RECURRENCE.
 * Trap: a recurrence becomes exactly ONE `plan/feedback/` entry via `captureFeedback`, deduped by
 * signature against the ledger union first (the W1-T470 discipline coverage-improvement.ts's
 * `alreadyFiledForSignature` established) — never a rung, never a behaviour change.
 *
 * Falsifier: test/hand-run-census.test.ts.
 */
import { appendLedger, type LedgerLine } from "./ledger.js";
import { resolveLedgerUnion, type LedgerGrepFsDeps, type LedgerUnionResult } from "./ledger-grep.js";
import { captureFeedback, type CaptureFeedbackOptions, type FeedbackEntry } from "./feedback.js";

// ── Reading operator rows out of the union ──────────────────────────────────────────────────

/** A pre-filter pattern for {@link resolveLedgerUnion}, matching the RAW JSON field (the same
 *  `"<key>":"<literal>"` substring idiom `coverage-improvement.ts`'s own pattern uses) so the
 *  union read never has to parse every non-operator line just to find these. Anchored on the
 *  field itself, never a bare value — a bare `operator` would also match unrelated prose. */
const HAND_RUN_OPERATOR_LEDGER_PATTERN = /"actor":"operator"/;

/** One operator-authored ledger row, narrowed to the three fields session-mining needs. */
export interface HandRunLedgerRow {
  ts: string;
  actorPid: number;
  step: string;
}

/** Parse every operator row out of a set of raw {@link resolveLedgerUnion} match lines. A
 *  malformed line, or one missing `ts`/`actor_pid`/`step`, is skipped rather than guessed at —
 *  the same discipline `coverage-improvement.ts`'s `parseFiledCoverageImprovementLines` applies
 *  to a possibly-torn line. `actor` is re-checked here (not just trusted from the pre-filter
 *  pattern) since a pattern match is a substring hit, not a parse. */
export function parseOperatorLedgerRows(rawLines: readonly string[]): HandRunLedgerRow[] {
  const out: HandRunLedgerRow[] = [];
  for (const raw of rawLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // torn or foreign line — never takes the whole read down, same discipline every other
      // ledger reader in this codebase applies to a possibly-torn line.
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const line = parsed as { actor?: unknown; actor_pid?: unknown; step?: unknown; ts?: unknown };
    if (line.actor !== "operator") continue;
    if (typeof line.actor_pid !== "number" || typeof line.step !== "string" || typeof line.ts !== "string") continue;
    if (!Number.isFinite(Date.parse(line.ts))) continue; // unparseable ts — never guessed into a session
    out.push({ ts: line.ts, actorPid: line.actor_pid, step: line.step });
  }
  return out;
}

// ── Sessions (design note ii) ───────────────────────────────────────────────────────────────

/** A real hand-typed invocation is short-lived; this mostly guards against the OS reusing a pid
 *  number across two genuinely separate invocations days apart, which same-pid grouping alone
 *  would otherwise splice into one false session. */
export const HAND_RUN_SESSION_GAP_MS = 30 * 60 * 1000;

/** One session: a run of operator rows sharing a pid, no two consecutive rows more than
 *  {@link HAND_RUN_SESSION_GAP_MS} apart. */
export interface HandRunSession {
  actorPid: number;
  /** UTC calendar date (`YYYY-MM-DD`) of the session's first row. */
  day: string;
  /** The session's rows' `step` values, IN ORDER, duplicates kept — this IS the verb sequence. */
  sequence: string[];
  rows: HandRunLedgerRow[];
}

/** Group `rows` into sessions: same `actorPid`, sorted by `ts`, split wherever a gap exceeds
 *  {@link HAND_RUN_SESSION_GAP_MS}. Pure — no I/O, no clock read (splits are relative to the
 *  rows' own `ts`, never `Date.now()`). */
export function buildHandRunSessions(rows: readonly HandRunLedgerRow[]): HandRunSession[] {
  const byPid = new Map<number, HandRunLedgerRow[]>();
  for (const row of rows) {
    const list = byPid.get(row.actorPid) ?? [];
    list.push(row);
    byPid.set(row.actorPid, list);
  }

  const sessions: HandRunSession[] = [];
  for (const [actorPid, group] of byPid) {
    const sorted = [...group].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let current: HandRunLedgerRow[] = [];
    let lastMs: number | undefined;
    const flush = () => {
      if (current.length === 0) return;
      sessions.push({
        actorPid,
        day: current[0].ts.slice(0, 10),
        sequence: current.map((r) => r.step),
        rows: current,
      });
      current = [];
    };
    for (const row of sorted) {
      const ms = Date.parse(row.ts);
      if (lastMs !== undefined && ms - lastMs > HAND_RUN_SESSION_GAP_MS) flush();
      current.push(row);
      lastMs = ms;
    }
    flush();
  }
  return sessions;
}

// ── Recurrences: a sequence seen on at least the policy floor of distinct days ──────────────

/** THE POLICY FLOOR OF DISTINCT DAYS (design note ii). One recurring day is a coincidence; a
 *  SECOND distinct day is the operator doing it again — the same "one occurrence is not a
 *  pattern, a second is" threshold `plan/policy.yaml`'s `repairFilingThreshold` (min: 2) already
 *  states for a structurally identical judgment ("one occurrence is a repair, a recurrence is a
 *  defect"). Not sourced from `plan/policy.yaml` itself (no such row exists there yet for this
 *  module — recon found none): a local, documented constant rather than a guessed policy path. */
export const HAND_RUN_RECURRENCE_DAY_FLOOR = 2;

/** The primary key for a verb sequence: the ordered steps, joined — never a hash, the same plain
 *  `join` `coverage-improvement.ts`'s `coverageDebtSignature` uses for the identical reason (a
 *  short, stable key needs no digest). Step names are dot-separated identifiers, so `|` cannot
 *  collide with one. */
export function handRunSequenceSignature(sequence: readonly string[]): string {
  return sequence.join("|");
}

/** One recurring hand-run sequence, with its evidence. */
export interface HandRunRecurrence {
  sequence: string[];
  signature: string;
  /** Sorted, ascending. */
  distinctDays: string[];
  sessionCount: number;
  evidenceRows: HandRunLedgerRow[];
}

/** Group sessions of length >= 2 by their exact verb sequence, and keep only the ones recurring
 *  on at least `opts.dayFloor` (default {@link HAND_RUN_RECURRENCE_DAY_FLOOR}) DISTINCT calendar
 *  days — a busy single night is one day, never a recurrence on its own. Ordered by distinct-day
 *  count descending, then signature, for a deterministic report. */
export function mineHandRunRecurrences(
  rows: readonly HandRunLedgerRow[],
  opts: { dayFloor?: number } = {},
): HandRunRecurrence[] {
  const dayFloor = opts.dayFloor ?? HAND_RUN_RECURRENCE_DAY_FLOOR;
  const sessions = buildHandRunSessions(rows).filter((s) => s.sequence.length >= 2);

  const bySignature = new Map<string, { sequence: string[]; sessions: HandRunSession[] }>();
  for (const session of sessions) {
    const signature = handRunSequenceSignature(session.sequence);
    const entry = bySignature.get(signature) ?? { sequence: session.sequence, sessions: [] };
    entry.sessions.push(session);
    bySignature.set(signature, entry);
  }

  const recurrences: HandRunRecurrence[] = [];
  for (const [signature, { sequence, sessions: group }] of bySignature) {
    const distinctDays = [...new Set(group.map((s) => s.day))].sort();
    if (distinctDays.length < dayFloor) continue;
    recurrences.push({
      sequence,
      signature,
      distinctDays,
      sessionCount: group.length,
      evidenceRows: group.flatMap((s) => s.rows),
    });
  }
  recurrences.sort((a, b) => b.distinctDays.length - a.distinctDays.length || (a.signature < b.signature ? -1 : 1));
  return recurrences;
}

// ── The read-only census (`rmd hand-runs`) ───────────────────────────────────────────────────

export type HandRunCensusResult =
  | { status: "refused"; refusedReason: string }
  | { status: "measured"; recurrences: HandRunRecurrence[]; operatorRowCount: number };

/** Read the ledger union for operator rows and mine recurrences — READ-ONLY, no write of any
 *  kind. `status: "refused"` when the union cannot be trusted (zero archives / a partial read —
 *  W1-T1013's own coverage-not-readability rule) OR when it carries no actor-stamped operator row
 *  yet (a pre-stamp corpus, or an operator-free window), never a false-healthy empty report. */
export function censusHandRuns(
  stateDir: string,
  ledgerUnion: (stateDir: string, pattern: RegExp, fsDeps?: LedgerGrepFsDeps) => LedgerUnionResult = resolveLedgerUnion,
  opts: { dayFloor?: number; fsDeps?: LedgerGrepFsDeps } = {},
): HandRunCensusResult {
  const union = ledgerUnion(stateDir, HAND_RUN_OPERATOR_LEDGER_PATTERN, opts.fsDeps);
  if (!union.ok) {
    return {
      status: "refused",
      refusedReason: `ledger corpus incomplete under ${union.stateDir} (${union.archiveCount} archive(s), ${union.unread.length} unread)`,
    };
  }
  const rows = parseOperatorLedgerRows(union.matches);
  if (rows.length === 0) {
    return { status: "refused", refusedReason: "no actor-stamped operator row found in the ledger union yet" };
  }
  return { status: "measured", recurrences: mineHandRunRecurrences(rows, { dayFloor: opts.dayFloor }), operatorRowCount: rows.length };
}

// ── Ledger dedupe for the proposal (design note iii, the W1-T470 discipline) ───────────────

/** Registered in `DECISION_RELEVANT_LEDGER_STEPS` (`src/lib/ledger.ts`) — see that Set's own
 *  W1-T2697 entry. Duplicated as a literal there rather than imported, the same
 *  `coverage.improvement.filed`/`source_size.followup.filed` precedent, so `ledger.ts` never
 *  imports from a `lib/` module that itself imports `ledger.ts`. */
export const HAND_RUN_CENSUS_PROPOSED_STEP = "hand_run.census_proposed";

const HAND_RUN_CENSUS_PROPOSED_LEDGER_PATTERN = /"step":"hand_run\.census_proposed"/;

/** One PRIOR proposal this module's own dedupe marker recorded. */
export interface FiledHandRunProposalRecord {
  signature: string;
  ts?: string;
}

/** Parse every {@link HAND_RUN_CENSUS_PROPOSED_STEP} line out of a set of raw ledger match
 *  strings — a malformed line is skipped, never thrown on, mirroring
 *  `coverage-improvement.ts`'s `parseFiledCoverageImprovementLines`. */
export function parseFiledHandRunProposalLines(rawLines: readonly string[]): FiledHandRunProposalRecord[] {
  const out: FiledHandRunProposalRecord[] = [];
  for (const raw of rawLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // torn or foreign line — never thrown on, mirroring coverage-improvement.ts's own reader.
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const line = parsed as { step?: unknown; signature?: unknown; ts?: unknown };
    if (line.step === HAND_RUN_CENSUS_PROPOSED_STEP && typeof line.signature === "string") {
      out.push({ signature: line.signature, ts: typeof line.ts === "string" ? line.ts : undefined });
    }
  }
  return out;
}

/** True iff `rawLines` (a {@link resolveLedgerUnion} match set) already recorded a proposal for
 *  the EXACT same sequence `signature`. */
export function alreadyProposedForSignature(rawLines: readonly string[], signature: string): boolean {
  return parseFiledHandRunProposalLines(rawLines).some((r) => r.signature === signature);
}

/** The raw `plan/feedback/` text for one recurrence — names the sequence, the days it recurred,
 *  and the rung shape it suggests (design note iii). Proposal only: this text never schedules
 *  anything itself (rationale (3), Rule 15). */
export function buildHandRunFeedback(r: HandRunRecurrence): string {
  return (
    `The operator hand-ran this exact verb sequence on ${r.distinctDays.length} distinct days ` +
    `(${r.sessionCount} session(s) total): ${r.sequence.join(" → ")}.\n\n` +
    `Days: ${r.distinctDays.join(", ")}.\n\n` +
    `Evidence: ${r.evidenceRows.length} ledger row(s) across those sessions (rmd hand-runs for the full detail).\n\n` +
    `Consider a routine: a rung that fires this same step sequence on the cadence the operator ` +
    `already keeps by hand, so the next recurrence needs no typing.`
  );
}

// ── The cadence entry point (`runMeasurementCadenceReport`'s hand-run member) ───────────────

export interface HandRunCensusCadenceOpts {
  /** Repo checkout root — where `plan/feedback/` lives (passed straight to `captureFeedback`). */
  root: string;
  /** State dir `resolveLedgerUnion` globs for `ledger.*.ndjson[.gz]` rotations + the live file. */
  stateDir: string;
  /** Ledger path this run's own `hand_run.census_proposed` marker is appended to. */
  ledgerPath: string;
  runId: string;
  dayFloor?: number;
  /** Test seams — real callers never set these, matching `coverage-improvement.ts`'s
   *  `InjectCoverageImprovementDeps`. */
  capture?: (root: string, opts: CaptureFeedbackOptions) => FeedbackEntry;
  ledgerUnion?: (stateDir: string, pattern: RegExp, fsDeps?: LedgerGrepFsDeps) => LedgerUnionResult;
  writeLedgerLine?: (path: string, line: LedgerLine) => void;
  land?: CaptureFeedbackOptions["land"];
}

export type HandRunCensusCadenceResult =
  | { status: "refused"; refusedReason: string }
  | {
      status: "measured";
      operatorRowCount: number;
      recurrenceCount: number;
      /** Signatures actually captured to `plan/feedback/` this run. */
      proposedSignatures: string[];
      /** Recurrences already proposed by a prior run — never re-captured. */
      skippedDuplicateSignatures: string[];
    };

/**
 * `runMeasurementCadenceReport`'s hand-run member (design note iii): census, then propose. Reads
 * the ledger union for operator rows and mines recurrences ({@link censusHandRuns}); for each
 * recurrence NOT already proposed — deduped by sequence signature against the union, the
 * W1-T470 discipline — captures ONE `plan/feedback/` entry via `captureFeedback` and records a
 * `hand_run.census_proposed` marker so a later run with the same signature does not refile it.
 * `status: "refused"` propagates straight from {@link censusHandRuns} — the union unreadable, or
 * carrying no actor-stamped row yet.
 */
export function handRunCensus(deps: HandRunCensusCadenceOpts): HandRunCensusCadenceResult {
  const ledgerUnion = deps.ledgerUnion ?? resolveLedgerUnion;
  const census = censusHandRuns(deps.stateDir, ledgerUnion, { dayFloor: deps.dayFloor });
  if (census.status === "refused") return census;

  const filedUnion = ledgerUnion(deps.stateDir, HAND_RUN_CENSUS_PROPOSED_LEDGER_PATTERN);
  const capture = deps.capture ?? captureFeedback;
  const writeLine = deps.writeLedgerLine ?? appendLedger;

  const proposedSignatures: string[] = [];
  const skippedDuplicateSignatures: string[] = [];
  for (const r of census.recurrences) {
    // `filedUnion.ok === false` cannot CONFIRM a prior proposal — never that one is CONFIRMED
    // absent. Proposing anyway is the deliberate fail-open `injectCoverageImprovementTask` takes
    // for the identical reason: an occasional duplicate feedback entry is bounded and
    // recoverable (the operator ratifies or reframes it — rationale (3)), while silently never
    // proposing because a fresh instance has not rotated a ledger yet would be the opposite,
    // unbounded failure.
    if (filedUnion.ok && alreadyProposedForSignature(filedUnion.matches, r.signature)) {
      skippedDuplicateSignatures.push(r.signature);
      continue;
    }
    const entry = capture(deps.root, { raw: buildHandRunFeedback(r), origin: "cli", land: deps.land });
    writeLine(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: "hand-run-census",
      step: HAND_RUN_CENSUS_PROPOSED_STEP,
      signature: r.signature,
      feedback_id: entry.id,
      distinct_days: r.distinctDays,
      sequence: r.sequence,
    });
    proposedSignatures.push(r.signature);
  }

  return {
    status: "measured",
    operatorRowCount: census.operatorRowCount,
    recurrenceCount: census.recurrences.length,
    proposedSignatures,
    skippedDuplicateSignatures,
  };
}
