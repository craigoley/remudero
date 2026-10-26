/**
 * lib/procedures-command.ts — `rmd procedures [--days <n>] [--json]`: the procedure census (procedure-census.ts) over
 * the last N days of merged runs. READ-ONLY: one step-filtered read of the ledger union, then a report on stdout. It
 * writes no ledger row and no state file; the one `cli.invoked` row run-task.ts's dispatcher ledgers for every verb
 * (`logCliInvocation`) is the only row an invocation adds.
 *
 * Every side effect is a field of {@link ProceduresCommandInput}; run-task.ts wires the real ones through
 * {@link proceduresProductionInput}.
 *
 * Exit codes: 0 the census was printed; 2 a usage error, or a ledger union with an unread source. An unread
 * rotation can hold a run's fix rounds, and a census without them would count a repaired run as clean.
 */
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { loadConfig, type Config } from "./config.js";
import { ledgerPathFor } from "./ledger-path.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { buildProcedureCensus, renderProcedureCensus } from "./procedure-census.js";
import { GATHER_RUNS_LEDGER_STEPS, gatherRuns, type LedgerRecord } from "./retro.js";

export const PROCEDURES_USAGE = "usage: rmd procedures [--days <n>] [--json]  (n: an integer from 1 to 60, default 14)";
export const PROCEDURES_DEFAULT_DAYS = 14;
/** PRIMARY CONTROL: the widest window `--days` accepts, which is what bounds the one union read this verb makes. */
export const PROCEDURES_MAX_DAYS = 60;

/** The steps the census reads: what `gatherRuns` needs, the tool-call rows, and the fix rounds that split clean
 *  runs from repaired ones. */
export const PROCEDURES_LEDGER_STEPS: readonly string[] = [...GATHER_RUNS_LEDGER_STEPS, "worker.activity", "fix.dispatch"];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every side effect of {@link proceduresCommand}. */
export interface ProceduresCommandInput {
  /** The state dir whose ledger union is read. Called only after the arguments parse. */
  stateDir: () => string;
  readLedger: typeof readLedgerUnionRecordsSync;
  clock: Clock;
  print: (text: string) => void;
  printError: (text: string) => void;
}

/** `--days`: absent is the default; anything but an integer from 1 to {@link PROCEDURES_MAX_DAYS} is undefined. */
function parseDays(raw: string | undefined): number | undefined {
  if (raw === undefined) return PROCEDURES_DEFAULT_DAYS;
  if (!/^\d+$/.test(raw)) return undefined;
  const days = Number(raw);
  return days >= 1 && days <= PROCEDURES_MAX_DAYS ? days : undefined;
}

/** `rmd procedures [--days <n>] [--json]`. The window ends at the clock's now; a run counts when it started inside it. */
export function proceduresCommand(argv: readonly string[], input: ProceduresCommandInput): number {
  let values: { days?: string; json?: boolean };
  try {
    values = parseArgs({ args: [...argv], strict: true, allowPositionals: false,
      options: { days: { type: "string" }, json: { type: "boolean" } } }).values;
  } catch (error) {
    // A malformed argv is a usage error: named with the usage line and exit 2, never a census over a guessed window.
    const reason = (error as Error).message;
    input.printError(`rmd procedures: ${reason}\n${PROCEDURES_USAGE}`);
    return 2;
  }
  const days = parseDays(values.days);
  if (days === undefined) {
    input.printError(`rmd procedures: --days must be an integer from 1 to ${PROCEDURES_MAX_DAYS}, got ${JSON.stringify(values.days)}\n${PROCEDURES_USAGE}`);
    return 2;
  }
  const untilMs = input.clock.now();
  const sinceMs = untilMs - days * DAY_MS;
  const window = { sinceTs: fixedClock(sinceMs).iso(), untilTs: fixedClock(untilMs).iso() };
  const stateDir = input.stateDir();
  const read = input.readLedger(stateDir, { sinceTs: window.sinceTs, step: PROCEDURES_LEDGER_STEPS, refuseIncomplete: true });
  if (!read.ok) {
    input.printError([
      `rmd procedures: the ledger union at ${stateDir} is incomplete; refusing to count a partial corpus, since an unread ` +
        "rotation can hide a run's fix rounds. Unread:",
      ...read.unread.map((path) => `  ${path}`),
    ].join("\n"));
    return 2;
  }
  const runs = gatherRuns(read.rows as LedgerRecord[]).filter((run) => {
    const startMs = Date.parse(run.startTs);
    return startMs >= sinceMs && startMs <= untilMs;
  });
  const census = buildProcedureCensus(runs, read.rows);
  input.print(values.json ? JSON.stringify(census, null, 2) : renderProcedureCensus(census, window));
  return 0;
}

/** The production wiring: the configured root's state dir (config loads only once the arguments parse), the real
 *  union reader, the wall clock, and the console. */
export function proceduresProductionInput(options: { loadConfig?: () => Config } = {}): ProceduresCommandInput {
  return {
    stateDir: () => dirname(ledgerPathFor((options.loadConfig ?? loadConfig)())),
    readLedger: readLedgerUnionRecordsSync,
    clock: systemClock,
    print: (text) => console.log(text),
    printError: (text) => console.error(text),
  };
}
