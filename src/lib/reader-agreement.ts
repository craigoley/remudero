import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLedger } from "./ledger.js";
import { readLedgerUnionRawLinesSync } from "./ledger-union.js";
import { TASK_STATUSES, type Plan } from "./plan.js";
import {
  buildBatchedGithub, buildLedgerIndex, dispatchesWithoutNewOwnedPr, infrastructureRefusal,
  orphanedRunIds, projectPlan, readLedgerUnionBounded, STATUS_BOARD_MIN_ROTATIONS, STATUS_BOARD_WINDOW_MS,
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
  boardReader?: () => ReaderFigures | Promise<ReaderFigures>;
  independentReader?: () => ReaderFigures | Promise<ReaderFigures>;
  appendLine?: (path: string, row: Row & { run_id: string; task_id: string; step: string }) => void;
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

function boardFigures(options: ReaderAgreementOptions): ReaderFigures {
  const rows = readLedgerUnionBounded(options.ledgerPath);
  if (!rows.present || rows.torn) throw new Error("board ledger is missing or contains malformed rows");
  const index = buildLedgerIndex(rows);
  const dispatchStreaks = Object.fromEntries(haltedTasks(rows)
    .map(id => [id, dispatchesWithoutNewOwnedPr(rows, id, index)]));
  const healthyDeploys: Record<string, string> = {};
  for (const row of rows) {
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

async function independentFigures(options: ReaderAgreementOptions): Promise<ReaderFigures> {
  const union = readLedgerUnionRawLinesSync(dirname(options.ledgerPath), {
    liveFirst: true, order: "newest-first", rotationWindowMs: STATUS_BOARD_WINDOW_MS,
    minRotations: STATUS_BOARD_MIN_ROTATIONS, refuseIncomplete: true,
  });
  if (!union.ok || !union.liveFileRead || union.unclassified.length) throw new Error("independent ledger corpus is incomplete");
  const rows: Row[] = union.rawLines.map(raw => {
    const row: unknown = JSON.parse(raw);
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("independent ledger row is not an object");
    return row as Row;
  });
  const dispatchStreaks = Object.fromEntries(haltedTasks(rows).map(id => [id, independentStreak(rows, id)]));
  const healthyDeploys: Record<string, string> = {};
  const deploys = rows.filter(row => row.step === "deploy.ok" && typeof row.ts === "string")
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
    const github = buildBatchedGithub(options.owner, options.repo);
    const projections = projectPlan(options.plan, {
      ledgerPath: options.ledgerPath, readLedger: () => rows,
      github, writeCreditStore: () => {},
    });
    if (github.readFailed?.()) throw new Error("independent queue projection is unavailable");
    queuedTaskCount = [...projections.values()].reduce((count, task) => count + Number(task.status === "queued"), 0);
  }
  return { dispatchStreaks, healthyDeploys, openPrCount, queuedTaskCount };
}

export async function checkReaderAgreement(options: ReaderAgreementOptions): Promise<ReaderDisagreement[]> {
  const board = await (options.boardReader ?? (() => boardFigures(options)))();
  const independent = await (options.independentReader ?? (() => independentFigures(options)))();
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
  return findings;
}
