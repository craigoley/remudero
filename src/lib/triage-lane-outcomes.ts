import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { ledgerPathFor } from "./ledger-path.js";
import { readLedgerUnionRawLinesSync } from "./ledger-union.js";
import { unknownArgError } from "./cli-args.js";

/**
 * W1-T3547 — THE TRIAGE LANE, COUNTED PER PROVIDER. MEASURE ONLY: this folds rows the lane already
 * writes and routes nothing, mounts nothing and changes no spawn.
 *
 * Triage's deterministic gates refuse a malformed output, never a wrong `no_task`, so the only
 * evidence that a weaker provider is safe here is a count of terminal outcomes beside the Claude
 * baseline over the SAME rows. A run is the rows sharing one `run_id`; it is a triage run once it
 * carries `triage.start` or `triage.synthesized`. Its terminal is the FIRST terminal row in ledger
 * order (`triage.relint_refused`, `triage.error`, `triage.grill_opened`, or a `pr.opened` naming
 * its action). A run with none is CENSORED: still running, or killed, and scored as neither.
 *
 * THE CONFOUND, NAMED: observational, not randomized. A squeeze divert lands on whatever feedback
 * arrives while both subscriptions are blocked, so provider and feedback mix travel together.
 */
export const TRIAGE_LANE_MIN_TERMINAL_RUNS = 20;

export const TRIAGE_LANE_CONFOUND =
  "observational, not randomized: a squeeze divert runs whatever feedback arrives while both subscriptions are blocked, so provider and feedback mix are confounded";

export const TRIAGE_TERMINALS = ["propose", "no_task", "grill", "error", "relint_refused"] as const;
export type TriageTerminal = (typeof TRIAGE_TERMINALS)[number];

type Row = Record<string, unknown>;

export interface TriageLaneGroup {
  provider: string;
  model: string;
  runs: number;
  censored: number;
  terminalRuns: number;
  outcomes: Record<TriageTerminal, number>;
  sample: "insufficient" | "sufficient";
  rates: Record<TriageTerminal, number> | null;
  attempts: number;
  attemptsPerRun: number;
  relints: number;
  cost: { apiUsd: number | null; subscriptionNotionalUsd: number | null; unknownCostRuns: number };
}

export interface TriageLaneReport {
  runs: number;
  censoredRuns: number;
  minTerminalRuns: number;
  verdict: "none";
  confound: string;
  groups: TriageLaneGroup[];
}

interface RunAcc {
  triage: boolean;
  terminal?: TriageTerminal;
  attempts: Map<string, Row>;
  relints: number;
}

const TERMINAL_OF_STEP: Record<string, TriageTerminal> = {
  "triage.relint_refused": "relint_refused",
  "triage.error": "error",
  "triage.grill_opened": "grill",
};

function terminalOf(row: Row): TriageTerminal | undefined {
  if (row.step === "pr.opened") return (TRIAGE_TERMINALS as readonly unknown[]).includes(row.action) ? (row.action as TriageTerminal) : undefined;
  return TERMINAL_OF_STEP[String(row.step)];
}

function label(value: unknown, absent: string): string {
  return typeof value === "string" && value.length > 0 ? value : absent;
}

function emptyOutcomes(): Record<TriageTerminal, number> {
  return { propose: 0, no_task: 0, grill: 0, error: 0, relint_refused: 0 };
}

function attemptCost(row: Row): { usd: number; mode: "api" | "subscription" } | undefined {
  const usd = typeof row.total_cost_usd === "number" ? row.total_cost_usd : row.cost_usd;
  const mode = row.billing_mode;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return undefined;
  return mode === "api" || mode === "subscription" ? { usd, mode } : undefined;
}

/** Fold the triage lane's ledger rows into per-provider, per-model outcome counts. Pure. */
export function foldTriageLaneOutcomes(rows: Iterable<Row>): TriageLaneReport {
  const runs = new Map<string, RunAcc>();
  let unkeyed = 0;
  for (const row of rows) {
    const step = String(row.step);
    if (typeof row.run_id !== "string") continue;
    const acc: RunAcc = runs.get(row.run_id) ?? { triage: false, attempts: new Map(), relints: 0 };
    runs.set(row.run_id, acc);
    if (step === "triage.start" || step === "triage.synthesized") acc.triage = true;
    if (step === "triage.synthesized") acc.attempts.set(typeof row.attempt === "number" ? `a${row.attempt}` : `u${unkeyed++}`, row);
    if (step === "triage.relint") acc.relints += 1;
    acc.terminal ??= terminalOf(row);
  }

  const groups = new Map<string, TriageLaneGroup & { api: number; apiN: number; sub: number; subN: number }>();
  for (const acc of runs.values()) {
    if (!acc.triage) continue;
    const attempts = [...acc.attempts.values()];
    const last = attempts.at(-1);
    const provider = attempts.length === 0 ? "no-worker" : label(last?.provider, "unknown");
    const model = attempts.length === 0 ? "none" : label(last?.model, "unknown");
    const key = `${provider}\u0000${model}`;
    const group = groups.get(key) ?? {
      provider, model, runs: 0, censored: 0, terminalRuns: 0, outcomes: emptyOutcomes(), sample: "insufficient" as const, rates: null,
      attempts: 0, attemptsPerRun: 0, relints: 0, cost: { apiUsd: null, subscriptionNotionalUsd: null, unknownCostRuns: 0 },
      api: 0, apiN: 0, sub: 0, subN: 0,
    };
    groups.set(key, group);
    group.runs += 1;
    group.attempts += attempts.length;
    group.relints += acc.relints;
    if (acc.terminal === undefined) group.censored += 1;
    else {
      group.terminalRuns += 1;
      group.outcomes[acc.terminal] += 1;
    }
    const costs = attempts.map(attemptCost);
    if (costs.includes(undefined)) group.cost.unknownCostRuns += 1;
    else {
      for (const c of costs) {
        if (c!.mode === "api") { group.api += c!.usd; group.apiN += 1; }
        else { group.sub += c!.usd; group.subN += 1; }
      }
    }
  }

  const out = [...groups.values()].sort((a, b) => (a.provider + a.model < b.provider + b.model ? -1 : 1)).map((g): TriageLaneGroup => {
    const { api, apiN, sub, subN, ...group } = g;
    group.attemptsPerRun = group.attempts / group.runs;
    group.cost.apiUsd = apiN > 0 ? Math.round(api * 1e6) / 1e6 : null;
    group.cost.subscriptionNotionalUsd = subN > 0 ? Math.round(sub * 1e6) / 1e6 : null;
    if (group.terminalRuns >= TRIAGE_LANE_MIN_TERMINAL_RUNS) {
      group.sample = "sufficient";
      group.rates = emptyOutcomes();
      for (const t of TRIAGE_TERMINALS) group.rates[t] = group.outcomes[t] / group.terminalRuns;
    }
    return group;
  });
  return {
    runs: out.reduce((n, g) => n + g.runs, 0),
    censoredRuns: out.reduce((n, g) => n + g.censored, 0),
    minTerminalRuns: TRIAGE_LANE_MIN_TERMINAL_RUNS,
    verdict: "none",
    confound: TRIAGE_LANE_CONFOUND,
    groups: out,
  };
}

function usd(value: number | null): string {
  return value === null ? "unknown" : `$${value.toFixed(2)}`;
}

export function renderTriageLaneReport(report: TriageLaneReport): string[] {
  const lines = [`rmd triage-outcomes — ${report.runs} triage runs, ${report.censoredRuns} censored (no terminal row); no verdict, no routing change`];
  for (const g of report.groups) {
    const outcomes = TRIAGE_TERMINALS.map((t) => `${t} ${g.outcomes[t]}`).join(", ");
    const sample = g.rates === null ? `INSUFFICIENT SAMPLE (${g.terminalRuns} of ${report.minTerminalRuns} terminal runs)` : `rates ${TRIAGE_TERMINALS.map((t) => `${t} ${(g.rates![t] * 100).toFixed(0)}%`).join(", ")}`;
    lines.push(`  ${g.provider}/${g.model}: ${g.runs} runs, ${g.censored} censored, terminal: ${outcomes}`);
    lines.push(`    ${sample}; attempts ${g.attemptsPerRun.toFixed(2)}/run, relints ${g.relints}`);
    lines.push(`    cost: api ${usd(g.cost.apiUsd)}, subscription notional ${usd(g.cost.subscriptionNotionalUsd)}, ${g.cost.unknownCostRuns} run(s) unknown cost (excluded from both)`);
  }
  lines.push(`  confound: ${report.confound}`);
  return lines;
}

/** `rmd triage-outcomes [--json]` — READ-ONLY. Refuses, rather than counting a partial corpus, when the ledger cannot be read whole. */
export function triageOutcomesCommand(
  rest: string[],
  fold: (rows: Row[]) => TriageLaneReport,
  opts: { stateDir?: string; write?: (line: string) => void } = {},
): number {
  const badArg = unknownArgError("triage-outcomes", rest, [], ["--json"]);
  if (badArg) {
    console.error(badArg);
    return 2;
  }
  const stateDir = opts.stateDir ?? dirname(ledgerPathFor(loadConfig()));
  const read = readLedgerUnionRawLinesSync(stateDir, { pattern: /"step":"(?:triage\.|pr\.opened")/, refuseIncomplete: true });
  if (!read.ok || !read.liveFileRead || read.unclassified.length > 0) {
    console.error(`rmd triage-outcomes: ledger at ${stateDir} is unreadable or incomplete (unread: ${read.unread.length}, unclassified: ${read.unclassified.length}, live file read: ${read.liveFileRead}) — refusing to count a partial corpus`);
    return 1;
  }
  const rows: Row[] = [];
  const torn: Array<{ reason: string }> = [];
  for (const line of read.rawLines) {
    try {
      rows.push(JSON.parse(line) as Row);
    } catch (error) {
      torn.push({ reason: (error as Error).message });
    }
  }
  const report = fold(rows);
  const write = opts.write ?? console.log;
  if (rest.includes("--json")) write(JSON.stringify({ ...report, tornRows: torn.length }, null, 2));
  else {
    for (const line of renderTriageLaneReport(report)) write(line);
    if (torn.length > 0) write(`  ${torn.length} unparseable row(s) skipped`);
  }
  return 0;
}
