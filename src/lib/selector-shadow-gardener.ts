import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GardenCheckout } from "./gardener.js";
import { ghExec, ghJson } from "./github-transport.js";
import { loadPlanFromYaml } from "./plan.js";
import { lintTask } from "./task-linter.js";

/** W1-T4439: evidence from the full coverage shards before W1-T4406 may narrow PR CI. */
// PRIMARY CONTROL: a rolling 60-run window holds the first-day rate (~20 failures in 40 runs)
// long enough to require 30 observed failures after repair, across at least 40 complete runs.
export const SELECTOR_SHADOW_RUN_LIMIT = 60;
export const SELECTOR_SHADOW_SHARDS = 8;
export const SELECTOR_SHADOW_MIN_FAILURES = 30;
export const SELECTOR_SHADOW_MIN_RUNS = 40;

export interface SelectorShadowRun {
  id: number;
  headSha: string;
  baseSha?: string;
  prNumber?: number;
  log: string;
}

export interface SelectorShadowFailure {
  file: string;
  floor: "selected" | "missed";
  narrow?: "selected" | "missed";
}

export interface SelectorShadowRecord {
  fullRun: boolean;
  floorSize: number;
  narrowSize?: number;
  failures: SelectorShadowFailure[];
}

export interface SelectorShadowMiss {
  runId: number;
  headSha: string;
  baseSha?: string;
  prNumber?: number;
  selection: "floor" | "narrow";
  file: string;
}

export interface SelectorShadowSelectionReport {
  failures: number;
  selected: number;
  missed: number;
  missRate: number | null;
  medianSize: number | null;
  medianSavingPercent: number | null;
}

export interface SelectorShadowReport {
  runsRequested: number;
  runsComplete: number;
  runsIncomplete: number;
  fullSuiteSize: number;
  floor: SelectorShadowSelectionReport;
  narrow: SelectorShadowSelectionReport;
  misses: SelectorShadowMiss[];
  verdict: "misses" | "insufficient" | "ready";
  reason: string;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Log lines may have a `gh run view --log` job prefix; malformed records fail the whole pass. */
export function parseSelectorShadowLines(log: string): SelectorShadowRecord[] {
  const records: SelectorShadowRecord[] = [];
  for (const line of log.split(/\r?\n/)) {
    const marker = line.indexOf("AFFECTED-SUITES-SHADOW: ");
    if (marker < 0) continue;
    const raw = line.slice(marker + "AFFECTED-SUITES-SHADOW: ".length).trim();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("selector shadow: record is not an object");
    const row = value as Record<string, unknown>;
    if (typeof row.fullRun !== "boolean" || !nonnegativeInteger(row.floorSize) ||
        (row.narrowSize !== undefined && !nonnegativeInteger(row.narrowSize)) || !Array.isArray(row.failures)) {
      throw new Error("selector shadow: invalid record sizes or failures");
    }
    const failures = row.failures.map((entry: unknown): SelectorShadowFailure => {
      if (!entry || typeof entry !== "object") throw new Error("selector shadow: invalid failure");
      const f = entry as Record<string, unknown>;
      if (typeof f.file !== "string" || !/^test\/.*\.test\.ts$/.test(f.file) ||
          (f.floor !== "selected" && f.floor !== "missed") ||
          (f.narrow !== undefined && f.narrow !== "selected" && f.narrow !== "missed") ||
          (row.narrowSize !== undefined && f.narrow === undefined) ||
          (row.narrowSize === undefined && f.narrow !== undefined) ||
          (row.fullRun && f.floor !== "selected")) {
        throw new Error("selector shadow: invalid failure verdict");
      }
      return { file: f.file, floor: f.floor, ...(f.narrow === undefined ? {} : { narrow: f.narrow }) };
    });
    records.push({ fullRun: row.fullRun, floorSize: row.floorSize as number,
      ...(row.narrowSize === undefined ? {} : { narrowSize: row.narrowSize as number }), failures });
  }
  return records;
}

/** The installed `gh` transport reads completed PR runs, then each run's coverage job log. */
export function readSelectorShadowRuns(
  owner: string,
  repo: string,
  limit = SELECTOR_SHADOW_RUN_LIMIT,
  io: { readJson?: (args: string[]) => unknown; readLog?: (args: string[]) => string } = {},
): SelectorShadowRun[] {
  const readJson = io.readJson ?? ghJson;
  const readLog = io.readLog ?? ((args: string[]) => ghExec(args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const response = readJson(["api", `repos/${owner}/${repo}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&per_page=${limit}`]) as {
    workflow_runs?: Array<{ id?: number; head_sha?: string; pull_requests?: Array<{ number?: number; base?: { sha?: string } }> }>;
  };
  if (!Array.isArray(response?.workflow_runs)) throw new Error("selector shadow: GitHub returned no workflow_runs list");
  return response.workflow_runs.map((run) => {
    if (!nonnegativeInteger(run.id) || typeof run.head_sha !== "string") {
      throw new Error("selector shadow: a workflow run has no id or head SHA");
    }
    return {
      id: run.id,
      headSha: run.head_sha,
      ...(typeof run.pull_requests?.[0]?.base?.sha === "string" ? { baseSha: run.pull_requests[0].base.sha } : {}),
      ...(nonnegativeInteger(run.pull_requests?.[0]?.number) ? { prNumber: run.pull_requests![0]!.number } : {}),
      log: readLog(["run", "view", String(run.id), "--repo", `${owner}/${repo}`, "--log"]),
    };
  });
}

/** Fetch the changed side of the exact PR-run comparison only when a miss needs a task. */
export function readSelectorShadowChangedPaths(
  owner: string, repo: string, miss: SelectorShadowMiss,
  readJson: (args: string[]) => unknown = ghJson,
): string[] {
  if (!miss.baseSha) return [];
  const response = readJson(["api", `repos/${owner}/${repo}/compare/${miss.baseSha}...${miss.headSha}`]) as {
    files?: Array<{ filename?: string }>;
  };
  if (!Array.isArray(response?.files) || response.files.length >= 300 ||
      response.files.some((file) => typeof file.filename !== "string")) {
    throw new Error(`selector shadow: incomplete comparison for ${miss.headSha}`);
  }
  return response.files.map((file) => file.filename!);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function selectionReport(verdicts: Array<"selected" | "missed">, sizes: number[], fullSuiteSize: number): SelectorShadowSelectionReport {
  const missed = verdicts.filter((v) => v === "missed").length;
  const size = median(sizes);
  return {
    failures: verdicts.length,
    selected: verdicts.length - missed,
    missed,
    missRate: verdicts.length ? missed / verdicts.length : null,
    medianSize: size,
    medianSavingPercent: size !== null && fullSuiteSize > 0 ? 100 * (fullSuiteSize - size) / fullSuiteSize : null,
  };
}

/** Only complete eight-shard runs count. An absent narrow decision cannot inflate its evidence. */
export function selectorShadowReport(runs: readonly SelectorShadowRun[], fullSuiteSize: number): SelectorShadowReport {
  const floorVerdicts: Array<"selected" | "missed"> = [];
  const narrowVerdicts: Array<"selected" | "missed"> = [];
  const floorSizes: number[] = [];
  const narrowSizes: number[] = [];
  const misses: SelectorShadowMiss[] = [];
  let runsComplete = 0;
  let runsIncomplete = 0;
  for (const run of runs) {
    const records = parseSelectorShadowLines(run.log);
    if (records.length !== SELECTOR_SHADOW_SHARDS) {
      runsIncomplete += 1;
      continue;
    }
    runsComplete += 1;
    for (const record of records) {
      floorSizes.push(record.fullRun ? fullSuiteSize : record.floorSize);
      if (record.narrowSize !== undefined) narrowSizes.push(record.narrowSize);
      for (const failure of record.failures) {
        floorVerdicts.push(failure.floor);
        if (failure.narrow !== undefined) narrowVerdicts.push(failure.narrow);
        for (const selection of ["floor", "narrow"] as const) {
          if (failure[selection] === "missed") misses.push({
            runId: run.id, headSha: run.headSha,
            ...(run.baseSha === undefined ? {} : { baseSha: run.baseSha }),
            ...(run.prNumber === undefined ? {} : { prNumber: run.prNumber }),
            selection, file: failure.file,
          });
        }
      }
    }
  }
  const floor = selectionReport(floorVerdicts, floorSizes, fullSuiteSize);
  const narrow = selectionReport(narrowVerdicts, narrowSizes, fullSuiteSize);
  const verdict = misses.length > 0 ? "misses" :
    runsIncomplete > 0 || runsComplete < SELECTOR_SHADOW_MIN_RUNS ||
    narrow.failures < SELECTOR_SHADOW_MIN_FAILURES || narrow.medianSize === null
      ? "insufficient" : "ready";
  const reason = verdict === "misses"
    ? `${misses.length} missed failure(s); repair their selector edges before W1-T4406`
    : verdict === "ready"
      ? `${narrow.failures} failures across ${runsComplete} complete runs with zero misses; W1-T4406 may be reviewed for narrowing`
      : `need ${SELECTOR_SHADOW_MIN_FAILURES} narrow-observed failures across ${SELECTOR_SHADOW_MIN_RUNS} complete runs, zero incomplete runs and a measured narrow size`;
  return { runsRequested: runs.length, runsComplete, runsIncomplete, fullSuiteSize, floor, narrow, misses, verdict, reason };
}

/** Count test files with the same suffix the full run selects, from this checkout. */
export function selectorShadowFullSuiteSize(root: string): number {
  const walk = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((count, entry) => {
    if (entry.isDirectory()) return count + walk(join(dir, entry.name));
    return count + Number(entry.isFile() && entry.name.endsWith(".test.ts"));
  }, 0);
  return walk(join(root, "test"));
}

export function selectorShadowMissKey(miss: SelectorShadowMiss): string {
  return `selector-shadow:${miss.headSha}:${miss.selection}:${miss.file}`;
}

/** A parked plan task names the observed changed-path to suite edge without guessing imports. */
export function selectorShadowMissTask(miss: SelectorShadowMiss, taskId: string, changedPaths: readonly string[] = []): string {
  const origin = selectorShadowMissKey(miss);
  const edge = `${changedPaths.length ? changedPaths.join(", ") : miss.headSha} -> ${miss.file}`;
  const q = JSON.stringify;
  return [
    `- id: ${taskId}`,
    `  title: ${q(`REPAIR THE ${miss.selection.toUpperCase()} SELECTOR EDGE ${edge} — a real coverage shard failure was missed`)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: human",
    "  risk: high",
    "  status: queued",
    "  attempts: 0",
    "  author_class: machine",
    `  origin: ${q(origin)}`,
    "  files: [src/lib/affected-suites.ts]",
    `  note: ${q(`W1-T4439 observed ${miss.selection} miss on coverage run ${miss.runId}${miss.prNumber ? ` for PR #${miss.prNumber}` : ""} at ${miss.headSha}: ${edge}. The changed paths are candidate missing edges, not guessed import edges. Inspect the exact head and teach the selector the missing dependency before W1-T4406 narrows CI.`)}`,
    "  acceptance:",
    `    - claim: ${q(`the ${miss.selection} selector includes ${miss.file} when this edge is exercised`)}`,
    `      proof: ${q(`grep: ${miss.file} in src/lib/affected-suites.ts`)}`,
    "",
  ].join("\n");
}

export interface SelectorShadowGardenerDeps {
  stateDir: string;
  repoRoot: string;
  readRuns: () => SelectorShadowRun[];
  readChangedPaths?: (miss: SelectorShadowMiss) => string[];
  openWorkspace: () => GardenCheckout;
  mintTaskId: () => string;
  log: (step: string, extra?: Record<string, unknown>) => void;
}

/** Report every pass, and file at most one new missed edge so the daemon cannot flood the plan. */
export function runSelectorShadowGardener(deps: SelectorShadowGardenerDeps): SelectorShadowReport {
  const path = join(deps.stateDir, "selector-shadow-gardener.json");
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as { filedKeys?: string[] } : {};
  if (prior.filedKeys !== undefined && !Array.isArray(prior.filedKeys)) throw new Error("selector shadow: invalid filed-keys state");
  const filed = new Set(prior.filedKeys ?? []);
  const report = selectorShadowReport(deps.readRuns(), selectorShadowFullSuiteSize(deps.repoRoot));
  deps.log("selector-shadow.report", { ...report, misses: report.misses.slice(0, 20) });
  const miss = report.misses.find((m) => !filed.has(selectorShadowMissKey(m)));
  if (miss) {
    const changedPaths = deps.readChangedPaths?.(miss) ?? [];
    const taskId = deps.mintTaskId();
    const name = `${taskId.toLowerCase()}-selector-shadow-miss.yaml`;
    const relativePath = join("plan", "tasks.d", name);
    const contents = selectorShadowMissTask(miss, taskId, changedPaths);
    const task = loadPlanFromYaml(contents, name).tasks[0];
    const lint = lintTask(task);
    if (!lint.ok) throw new Error(`selector shadow: missed-edge task failed lint: ${lint.violations.map((v) => v.check).join(", ")}`);
    const workspace = deps.openWorkspace();
    try {
      mkdirSync(join(workspace.root, "plan", "tasks.d"), { recursive: true });
      writeFileSync(join(workspace.root, relativePath), contents);
      const prUrl = workspace.land({
        paths: [relativePath],
        title: `fix(selector): file missed ${miss.selection} edge for ${miss.file.split("/").at(-1)}`,
        body: `The W1-T4439 shadow record observed ${miss.selection} miss on run ${miss.runId}: ${changedPaths.length ? changedPaths.join(", ") : miss.headSha} -> ${miss.file}.\n\nThe task is parked for review; W1-T4406 remains gated.\n\nRemudero-Task: ${taskId}`,
      });
      if (!prUrl) throw new Error("selector shadow: task PR was not opened");
      filed.add(selectorShadowMissKey(miss));
      deps.log("selector-shadow.miss_filed", { task_id: taskId, pr_url: prUrl, edge: `${changedPaths.length ? changedPaths.join(", ") : miss.headSha} -> ${miss.file}` });
    } finally {
      workspace.dispose();
    }
  }
  mkdirSync(deps.stateDir, { recursive: true });
  writeFileSync(path, JSON.stringify({ filedKeys: [...filed], report }) + "\n");
  return report;
}

/** Run immediately, then on the daemon interval; one pass at a time. */
export function startSelectorShadowGardener(deps: SelectorShadowGardenerDeps, intervalMs: number): { stop: () => void } {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      runSelectorShadowGardener(deps);
    } catch (error) {
      deps.log("selector-shadow.gardener_failed", { error: String((error as Error)?.message ?? error) });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 0);
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
