import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLedger } from "./ledger.js";
import { readLedgerUnionRawLinesSync } from "./ledger-union.js";
import { TASK_STATUSES, type Plan } from "./plan.js";
import {
  buildBatchedGithub, buildLedgerIndex, dispatchesWithoutNewOwnedPr, infrastructureRefusal,
  orphanedRunIds, PROJECTION_STEP_READS, projectPlan, readLedgerUnionBounded, STATUS_BOARD_MIN_ROTATIONS,
  STATUS_BOARD_WINDOW_MS, type GitHub,
} from "./status.js";

type Row = Record<string, unknown>;
type FigureValue = number | string | null;
export interface ReaderFigures {
  dispatchStreaks: Record<string, number>;
  openPrCount?: number;
  queuedTaskCount?: number;
  healthyDeploys: Record<string, string | null>;
}

export interface ReaderAgreementOptions {
  ledgerPath: string;
  runId: string;
  owner?: string;
  repo?: string;
  plan?: Plan;
  openPrCount?: number;
  readJson?: (args: string[]) => Promise<unknown>;
  /** The gateway the independent queue projection reads; omitted, {@link independentQueueGateway}. */
  queueGithub?: () => GitHub;
  boardReader?: () => ReaderFigures | Promise<ReaderFigures>;
  independentReader?: () => ReaderFigures | Promise<ReaderFigures>;
  appendLine?: (path: string, row: Row & { run_id: string; task_id: string; step: string }) => void;
  /** W1-T9981: the board figures' corpus reader; omitted, {@link readLedgerUnionBounded}. */
  boardCorpus?: typeof readLedgerUnionBounded;
  /** W1-T9981: the independent figures' corpus reader; omitted, {@link readLedgerUnionRawLinesSync}. */
  independentCorpus?: typeof readLedgerUnionRawLinesSync;
}

export interface ReaderDisagreement {
  figure: string;
  subject: string;
  board_value: FigureValue;
  independent_value: FigureValue;
}

function haltedTasks(rows: Row[]): string[] {
  return [...new Set(rows.filter(row => row.step === "dispatch.circuit_broken")
    .map(row => row.task ?? row.task_id).filter((id): id is string => typeof id === "string"))].sort();
}

function deployInstance(row: Row): string {
  return typeof row.instance === "string" ? row.instance : "local";
}

/** W1-T9981: what one reader's pre-parse filter was offered and kept, as the `reader.agreement` row reports it. */
interface ReaderStats { scanned: number; kept: number }

/** W1-T9981: one reader's walk of its window. A figure reads only a few steps and the halted tasks' rows, but the
 *  orphan rule and the plan projection take "now" from the newest `ts` anywhere, so that line is kept as well. */
interface WindowScan {
  scanned: number;
  newestMs?: number;
  newestLine?: string;
  /** The first line the unfiltered parse would have refused. */
  malformed?: unknown;
}

const TS_PREFIX = '{"ts":"';
const token = (value: string): string => JSON.stringify(value);
const FIGURE_STEP_TOKENS = ["dispatch.circuit_broken", "deploy.ok"].map(token);

/** Notes `line`'s `ts` without parsing a line that leads with it, as every ledger writer's line does. */
function noteLine(scan: WindowScan, line: string): void {
  scan.scanned++;
  const end = line.startsWith(TS_PREFIX) && line.endsWith("}") ? line.indexOf('"', TS_PREFIX.length) : -1;
  let ts: unknown = end > TS_PREFIX.length ? line.slice(TS_PREFIX.length, end) : undefined;
  if (typeof ts !== "string" || ts.includes("\\")) {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("independent ledger row is not an object");
      ts = (row as Row).ts;
    } catch (error) {
      scan.malformed ??= error;
      return;
    }
  }
  if (typeof ts !== "string") return;
  const ms = Date.parse(ts);
  if (Number.isFinite(ms) && (scan.newestMs === undefined || ms > scan.newestMs)) {
    scan.newestMs = ms;
    scan.newestLine = line;
  }
}

/** The first pass: every line is noted, and only the halted set's and the deploys' steps are kept. */
function keepFigureSteps(scan: WindowScan): (line: string) => boolean {
  return line => {
    noteLine(scan, line);
    return FIGURE_STEP_TOKENS.some(step => line.includes(step));
  };
}

/** A later pass: the lines naming one of `tokens`, `names` (when given) or the window's newest-`ts` line. */
function keepNamed(scan: WindowScan, tokens: string[], names?: (line: string) => boolean): (line: string) => boolean {
  return line => {
    scan.scanned++;
    return line === scan.newestLine || tokens.some(name => line.includes(name)) || names?.(line) === true;
  };
}

const TASK_ID_SHAPE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/;
const TASK_ID_TOKEN = /"([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)"/g;

/** True for a line naming a plan task as a whole JSON string, as its `task_id` or `task` does. */
function namesPlanTask(plan: Plan): (line: string) => boolean {
  const ids = new Set(plan.tasks.map(task => task.id).filter(id => TASK_ID_SHAPE.test(id)));
  const others = plan.tasks.map(task => task.id).filter(id => !TASK_ID_SHAPE.test(id)).map(token);
  return line => {
    for (const match of line.matchAll(TASK_ID_TOKEN)) if (ids.has(match[1]!)) return true;
    return others.some(id => line.includes(id));
  };
}

function boardFigures(options: ReaderAgreementOptions, stats: ReaderStats): ReaderFigures {
  const read = options.boardCorpus ?? readLedgerUnionBounded;
  const scan: WindowScan = { scanned: 0 };
  const steps = read(options.ledgerPath, { keep: keepFigureSteps(scan) });
  stats.kept += steps.length;
  if (!steps.present || steps.torn || scan.malformed !== undefined) {
    throw new Error("board ledger is missing or contains malformed rows");
  }
  const halted = haltedTasks(steps);
  let dispatchStreaks: Record<string, number> = {};
  if (halted.length > 0) {
    const rows = read(options.ledgerPath, { keep: keepNamed(scan, halted.map(token)) });
    stats.kept += rows.length;
    if (!rows.present || rows.torn) throw new Error("board ledger is missing or contains malformed rows");
    const index = buildLedgerIndex(rows);
    dispatchStreaks = Object.fromEntries(halted.map(id => [id, dispatchesWithoutNewOwnedPr(rows, id, index)]));
  }
  stats.scanned = scan.scanned;
  const healthyDeploys: Record<string, string> = {};
  for (const row of steps) {
    if (row.step !== "deploy.ok" || typeof row.ts !== "string") continue;
    const instance = deployInstance(row);
    if (healthyDeploys[instance] === undefined || row.ts > healthyDeploys[instance]) healthyDeploys[instance] = row.ts;
  }
  const cachePath = join(dirname(options.ledgerPath), "status.json");
  let queuedTaskCount: number | undefined;
  if (existsSync(cachePath)) {
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { tasks?: Record<string, { status: string }> };
    if (!cache.tasks || typeof cache.tasks !== "object" || Array.isArray(cache.tasks)) {
      throw new Error("board status cache has no task projection");
    }
    if (!Object.values(cache.tasks).every(task => task && TASK_STATUSES.includes(task.status as typeof TASK_STATUSES[number]))) {
      throw new Error("board status cache has an invalid task status");
    }
    queuedTaskCount = Object.values(cache.tasks).filter(task => task.status === "queued").length;
  }
  let openPrCount = options.openPrCount;
  if (openPrCount === undefined && options.owner && options.repo) {
    const prs = buildBatchedGithub(options.owner, options.repo).listOpenHeadBranches?.();
    if (!prs) throw new Error("board PR reader is unavailable");
    openPrCount = prs.length;
  }
  return { dispatchStreaks, healthyDeploys, openPrCount, queuedTaskCount };
}

// W1-T4841: scan backward from the newest reset; do not call the board's streak reducer.
function independentStreak(rows: Row[], id: string): number {
  const unique = new Map<string, Row>();
  const own = rows.filter(row => row.task_id === id).filter((row, ordinal) => {
    const key = typeof row.ts === "string" && typeof row.run_id === "string"
      ? JSON.stringify([row.ts, row.run_id, row.step]) : String(ordinal);
    if (unique.has(key)) return false;
    unique.set(key, row);
    return true;
  });
  if (own.every(row => typeof row.ts === "string")) own.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const excluded = new Set(own.filter(row => row.step === "verdict" && infrastructureRefusal(row) !== undefined)
    .map(row => row.run_id));
  const orphans = orphanedRunIds(rows, id);
  let count = 0;
  for (let i = own.length - 1; i >= 0; i--) {
    const row = own[i]!;
    if (row.step === "pr.opened" || row.step === "dispatch.breaker_released" || row.step === "verdict.merged" ||
        (row.step === "verdict" && row.verdict === "merged")) break;
    if (row.step === "run.start" && !excluded.has(row.run_id) &&
        !(typeof row.run_id === "string" && orphans.has(row.run_id))) count++;
  }
  return count;
}

const independentQueueGateways = new Map<string, GitHub>();

/** W1-T6246 — the independent queue figure's gateway, one per repository for the process's life. It never spawns gh
 *  on the calling thread: `warm()` walks on a worker and reads serve the facts it last held. A per-pass gateway
 *  was cold every pass, so projectPlan walked GitHub synchronously on the daemon loop (89.6 s, live profile). */
export function independentQueueGateway(owner: string, repo: string): GitHub {
  const key = `${owner}/${repo}`;
  let gateway = independentQueueGateways.get(key);
  if (!gateway) {
    gateway = buildBatchedGithub(owner, repo, { offLoop: true });
    independentQueueGateways.set(key, gateway);
  }
  return gateway;
}

async function independentFigures(options: ReaderAgreementOptions, stats: ReaderStats): Promise<ReaderFigures> {
  const read = options.independentCorpus ?? readLedgerUnionRawLinesSync;
  const scan: WindowScan = { scanned: 0 };
  // Each pass parses only the lines it kept, and its raw lines are dropped once parsed.
  const readRows = (keep: (line: string) => boolean): Row[] => {
    const union = read(dirname(options.ledgerPath), {
      liveFirst: true, order: "newest-first", rotationWindowMs: STATUS_BOARD_WINDOW_MS,
      minRotations: STATUS_BOARD_MIN_ROTATIONS, refuseIncomplete: true, keep,
    });
    stats.scanned = scan.scanned;
    if (!union.ok || !union.liveFileRead || union.unclassified.length) throw new Error("independent ledger corpus is incomplete");
    if (scan.malformed !== undefined) throw scan.malformed;
    stats.kept += union.rawLines.length;
    return union.rawLines.map(raw => {
      const row: unknown = JSON.parse(raw);
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("independent ledger row is not an object");
      return row as Row;
    });
  };
  const steps = readRows(keepFigureSteps(scan));
  const halted = haltedTasks(steps);
  const rows = halted.length > 0 ? readRows(keepNamed(scan, halted.map(token))) : [];
  const dispatchStreaks = Object.fromEntries(halted.map(id => [id, independentStreak(rows, id)]));
  const healthyDeploys: Record<string, string> = {};
  const deploys = steps.filter(row => row.step === "deploy.ok" && typeof row.ts === "string")
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  for (const row of deploys) healthyDeploys[deployInstance(row)] ??= row.ts as string;
  let openPrCount: number | undefined;
  if (options.readJson && options.owner && options.repo) {
    const pages = await options.readJson(["api", `repos/${options.owner}/${options.repo}/pulls?state=open&per_page=100`,
      "--paginate", "--slurp"]);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("independent PR listing is not paginated arrays");
    const numbers = pages.flat().map((pr: { number?: unknown }) => pr?.number);
    if (!numbers.every(number => typeof number === "number" && Number.isInteger(number) && number > 0)) {
      throw new Error("independent PR listing has an invalid PR number");
    }
    openPrCount = new Set(numbers).size;
  }
  let queuedTaskCount: number | undefined;
  if (options.plan && options.owner && options.repo && existsSync(join(dirname(options.ledgerPath), "status.json"))) {
    const github = options.queueGithub?.() ?? independentQueueGateway(options.owner, options.repo);
    github.warm?.();
    // W1-T6246: a cross-check never waits on GitHub. Until the off-loop walk has fresh facts the figure is absent.
    if (github.factsStale?.() !== false) return { dispatchStreaks, healthyDeploys, openPrCount, queuedTaskCount };
    // W1-T9981: the projection reads the plan tasks' own rows and the steps it reads by step, never the whole window.
    const projected = readRows(keepNamed(scan, [...PROJECTION_STEP_READS].map(token), namesPlanTask(options.plan)));
    const projections = projectPlan(options.plan, {
      ledgerPath: options.ledgerPath, readLedger: () => projected,
      github, writeCreditStore: () => {},
    });
    if (github.readFailed?.()) throw new Error("independent queue projection is unavailable");
    queuedTaskCount = [...projections.values()].reduce((count, task) => count + Number(task.status === "queued"), 0);
  }
  return { dispatchStreaks, healthyDeploys, openPrCount, queuedTaskCount };
}

export async function checkReaderAgreement(options: ReaderAgreementOptions): Promise<ReaderDisagreement[]> {
  const heapUsedBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const boardStats: ReaderStats | undefined = options.boardReader ? undefined : { scanned: 0, kept: 0 };
  const independentStats: ReaderStats | undefined = options.independentReader ? undefined : { scanned: 0, kept: 0 };
  const board = await (options.boardReader ?? (() => boardFigures(options, boardStats!)))();
  const independent = await (options.independentReader ?? (() => independentFigures(options, independentStats!)))();
  const heapUsedAfter = process.memoryUsage().heapUsed;
  const findings: ReaderDisagreement[] = [];
  const compare = (figure: string, subject: string, a: FigureValue, b: FigureValue): void => {
    if (a !== b) findings.push({ figure, subject, board_value: a, independent_value: b });
  };
  for (const id of [...new Set([...Object.keys(board.dispatchStreaks), ...Object.keys(independent.dispatchStreaks)])].sort()) {
    compare("dispatch_streak", id, board.dispatchStreaks[id] ?? null, independent.dispatchStreaks[id] ?? null);
  }
  if (board.openPrCount !== undefined && independent.openPrCount !== undefined) {
    compare("open_pr_count", "repository", board.openPrCount, independent.openPrCount);
  }
  if (board.queuedTaskCount !== undefined && independent.queuedTaskCount !== undefined) {
    compare("queued_task_count", "repository", board.queuedTaskCount, independent.queuedTaskCount);
  }
  for (const instance of [...new Set([...Object.keys(board.healthyDeploys), ...Object.keys(independent.healthyDeploys)])].sort()) {
    compare("last_healthy_deploy", instance, board.healthyDeploys[instance] ?? null, independent.healthyDeploys[instance] ?? null);
  }
  for (const finding of findings) (options.appendLine ?? appendLedger)(options.ledgerPath, {
    run_id: options.runId, task_id: finding.figure === "dispatch_streak" ? finding.subject : "SWEEP",
    step: "reader.disagreement", reason: "independent readers returned different values", ...finding,
  });
  // W1-T9981: the saving, read live. A check whose readers were both injected read no corpus to report.
  if (boardStats || independentStats) {
    const per = (pick: (stats: ReaderStats) => number) => ({
      ...(boardStats ? { board: pick(boardStats) } : {}), ...(independentStats ? { independent: pick(independentStats) } : {}),
    });
    (options.appendLine ?? appendLedger)(options.ledgerPath, {
      run_id: options.runId, task_id: "SWEEP", step: "reader.agreement",
      lines_scanned: per(stats => stats.scanned), rows_kept: per(stats => stats.kept),
      heap_used_before_bytes: heapUsedBefore, heap_used_after_bytes: heapUsedAfter,
      duration_ms: Math.round(performance.now() - started), disagreements: findings.length,
    });
  }
  return findings;
}
