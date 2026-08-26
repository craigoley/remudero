/**
 * `rmd replay <since> <until>` — a deterministic, plain-text narration of a LEDGER WINDOW (W1-T2296).
 *
 * WHAT THIS ANSWERS THAT NOTHING ELSE DOES (see the task's rationale). `buildReceipt`
 * (src/lib/receipt.ts) proves ONE run's ledger truth outward — P17's "the ledger proves our runs
 * to US; nothing proves them to anyone ELSE." The console (src/lib/serve.ts) is a live glance with
 * no history surface. `rmd status` projects plan state, not events. `rmd ledger-grep`
 * (ledger-grep.ts) hands back matching ROWS, not an ordered account. None of the four can answer:
 * between two instants, what did the fleet decide, in what order, and for what recorded reasons?
 * `buildReplay` reuses `buildReceipt`'s house discipline over a WINDOW instead of a run.
 *
 * PURE, LIKE buildReceipt. Same window + rows in, byte-identical narration out — no `Date.now()`,
 * no relative-time rendering, no randomness. An operator pasting a replay into an incident note
 * can regenerate it later and diff clean. Ordered primarily by each row's own `ts` (ascending,
 * lexicographic — every writer stamps `ts` via `new Date().toISOString()`, a fixed-width format
 * where lexicographic order IS chronological order); a `run_id`/`task_id` tie-break beneath that
 * keeps the order stable regardless of the input array's own order, which is what "grouped by
 * run/task, ordered by timestamp" (the task's design) means for a single flat account rather than
 * nested groups — every row still carries its own run/task label, just inline, not indented under
 * a heading a reader would have to cross-reference.
 *
 * ABSENT IS SAID, NEVER PAPERED (design (iii)). A row with no `reason` (or no `outcome`) renders
 * that field as `absent (no "<field>" field on this row)` — never invented, never silently
 * dropped from the line. Same discipline as {@link import("./receipt.js").ReceiptField}, applied
 * per-row instead of per fixed-schema leaf, because a replay window spans arbitrary step families
 * whose shapes this module does not (and must not) hardcode.
 *
 * READ-ONLY BY CONSTRUCTION. `buildReplay` takes ledger lines in and returns a string; it makes
 * no GitHub call, no fetch, no write, no state mutation, and fabricates nothing not present in a
 * row. {@link resolveReplayLedgerLines} reads the corpus through `resolveLedgerUnion`
 * (ledger-grep.ts) — the ONE corpus reader — and REFUSES on partial coverage exactly as
 * `resolveReceiptLedgerLines` does; a replay is evidence for a human, never a shorter story.
 */

import { resolveLedgerUnion, type LedgerGrepFsDeps } from "./ledger-grep.js";

/** One ledger line, as {@link buildReplay} reads it — the same loose shape every other ledger
 *  consumer in the tree uses (`Array<Record<string, unknown>>`), never a narrower type this
 *  module would have to keep byte-for-byte in sync with the writer. */
export type ReplayLedgerLine = Record<string, unknown>;

export interface BuildReplayOptions {
  /** Inclusive lower bound, ISO-8601 (e.g. `2026-08-25T10:40:00.000Z`) — compared lexicographically
   *  against each row's own `ts`, never parsed into a `Date` (no clock, no timezone arithmetic). */
  since: string;
  /** Inclusive upper bound, ISO-8601, same comparison discipline as {@link since}. */
  until: string;
  /** Optional narrowing to one task's rows (`row.task_id === taskId`). */
  taskId?: string;
  /** Optional narrowing to one step FAMILY — a literal prefix match against `row.step`
   *  (e.g. `"automerge."` matches `automerge.armed`, `automerge.arm_skipped`, ...). */
  stepPrefix?: string;
}

/** Renders `row[key]` when present as a non-empty string, else the same "absent, named"
 *  phrasing {@link import("./receipt.js").ReceiptField} uses — never a fabricated value,
 *  never a silently blank field. */
function fieldOrAbsent(row: ReplayLedgerLine, key: string): string {
  const v = row[key];
  return typeof v === "string" && v.length > 0 ? v : `absent (no "${key}" field on this row)`;
}

function renderRow(row: ReplayLedgerLine): string {
  const ts = fieldOrAbsent(row, "ts");
  const runId = fieldOrAbsent(row, "run_id");
  const taskId = fieldOrAbsent(row, "task_id");
  const step = fieldOrAbsent(row, "step");
  const outcome = fieldOrAbsent(row, "outcome");
  const reason = fieldOrAbsent(row, "reason");
  return `${ts}  run=${runId}  task=${taskId}  step=${step}  outcome=${outcome}  reason=${reason}`;
}

/**
 * Assemble the deterministic plain-text narration of `ledgerLines` restricted to
 * `[opts.since, opts.until]` (inclusive on both ends), optionally narrowed to one task id and/or
 * one step-name prefix.
 *
 * PURE: reads only `ledgerLines` and `opts`, writes nothing, and returns the identical string
 * (same characters, same order) for the identical input every time.
 *
 * A row whose own `ts` is missing or not a string can never be placed in the window and is
 * EXCLUDED — never guessed into the window, never guessed out of it.
 */
export function buildReplay(ledgerLines: readonly ReplayLedgerLine[], opts: BuildReplayOptions): string {
  const { since, until, taskId, stepPrefix } = opts;

  const inWindow = (row: ReplayLedgerLine): boolean => {
    const ts = row.ts;
    return typeof ts === "string" && ts >= since && ts <= until;
  };
  const matches = ledgerLines
    .filter(inWindow)
    .filter((row) => taskId === undefined || row.task_id === taskId)
    .filter((row) => stepPrefix === undefined || (typeof row.step === "string" && row.step.startsWith(stepPrefix)));

  // Ordered by ts first (ascending, lexicographic — see this module's header note on why that IS
  // chronological order here), then run_id/task_id as a deterministic tie-break, then the row's
  // own position in `matches` as the final, always-decisive fallback — so the SAME rows in the
  // SAME order always narrate to the SAME bytes, regardless of how many rows share one instant.
  const ordered = matches
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const tsA = typeof a.row.ts === "string" ? a.row.ts : "";
      const tsB = typeof b.row.ts === "string" ? b.row.ts : "";
      if (tsA !== tsB) return tsA < tsB ? -1 : 1;
      const runA = typeof a.row.run_id === "string" ? a.row.run_id : "";
      const runB = typeof b.row.run_id === "string" ? b.row.run_id : "";
      if (runA !== runB) return runA < runB ? -1 : 1;
      const taskA = typeof a.row.task_id === "string" ? a.row.task_id : "";
      const taskB = typeof b.row.task_id === "string" ? b.row.task_id : "";
      if (taskA !== taskB) return taskA < taskB ? -1 : 1;
      return a.index - b.index;
    })
    .map((x) => x.row);

  const scope =
    (taskId ? ` for task ${taskId}` : "") + (stepPrefix ? ` matching step prefix "${stepPrefix}"` : "");

  if (ordered.length === 0) {
    return `rmd replay ${since}..${until}: 0 ledger row(s)${scope}`;
  }

  const header = `rmd replay ${since}..${until}: ${ordered.length} ledger row(s)${scope}, ordered by timestamp`;
  return [header, ...ordered.map(renderRow)].join("\n");
}

/** Everything {@link resolveReplayLedgerLines} could resolve, or why it refused to. Mirrors
 *  {@link import("./receipt.js").ReceiptLedgerRead} one layer up: `lines` is only ever populated
 *  on `ok: true` — a refusal never degrades to an empty (and therefore indistinguishable from
 *  "nothing happened in this window") line list. */
export type ReplayLedgerRead = { ok: true; lines: ReplayLedgerLine[] } | { ok: false; reason: string };

/** Every real ledger line carries a `step` key (`LedgerLine`, ledger.ts) — `buildReplay` spans
 *  arbitrary step families rather than a fixed nine like `buildReceipt`, so the corpus read below
 *  cannot scope by step name the way {@link import("./receipt.js").RECEIPT_LEDGER_STEP_REGEXP}
 *  does; this pattern instead matches every genuine ledger row (and only rows shaped like one) by
 *  the one JSON key every writer stamps. Compiled once, not operator input, so — same reasoning as
 *  the receipt module's compiled pattern — passing this `RegExp` instance bypasses
 *  `resolveLedgerUnion`'s string-input `sanitizeRegExp` cap, which exists for the OPERATOR-supplied
 *  `rmd ledger-grep <pattern>` argument, not a fixed literal this module owns. */
const REPLAY_LEDGER_LINE_PATTERN = /"step":"/;

/**
 * Resolve the ledger lines {@link buildReplay} narrates from the archive∪live UNION
 * (`resolveLedgerUnion`, `./ledger-grep.js`) — never the live `ledger.ndjson` alone, which
 * rotation empties (see `receipt.ts`'s own header note for the defect this discipline replaces).
 *
 * REFUSES, NEVER DOWNGRADES. When `resolveLedgerUnion` reports `ok: false` (zero archives matched
 * under `stateDir`, or a matched rotation could not be read), this returns `{ ok: false, reason }`
 * — the caller must surface that refusal, never fall back to treating it as "zero rows found",
 * which would narrate a PARTIAL history as though it were the WHOLE one.
 *
 * PARSING NEVER FABRICATES. A matched line that fails to parse as a JSON object is corpus noise
 * (a torn write, a decoy), not a value this generator may guess at — it is dropped, never turned
 * into a row.
 */
export function resolveReplayLedgerLines(stateDir: string, fsDeps?: LedgerGrepFsDeps): ReplayLedgerRead {
  const result = resolveLedgerUnion(stateDir, REPLAY_LEDGER_LINE_PATTERN, fsDeps);
  if (!result.ok) {
    const reason =
      result.archiveCount === 0
        ? `zero ledger archive files matched under ${stateDir} — refusing to narrate a window from the ` +
          "live ledger file alone, which is exactly the rotation-emptied slice this refusal exists to avoid"
        : `${result.unread.length} matched ledger rotation(s) under ${stateDir} could not be read: ` +
          result.unread.join(", ");
    return { ok: false, reason };
  }
  const lines: ReplayLedgerLine[] = [];
  for (const raw of result.matches) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // Not valid JSON — never guessed into a row, just dropped.
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      lines.push(parsed as ReplayLedgerLine);
    }
  }
  return { ok: true, lines };
}
