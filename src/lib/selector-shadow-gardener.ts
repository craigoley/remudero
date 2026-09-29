import { readdirSync } from "node:fs";
import { join } from "node:path";

import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { clockFromMillisFn, systemClock, type Clock } from "./clock.js";
import type { GardenerDeps } from "./gardener.js";
import { ghExec, ghJson, ghJsonAsync, ghTextAsync } from "./github-transport.js";
import { loadPlan, loadPlanFromYaml } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { lintTask } from "./task-linter.js";

/** W1-T4439: evidence from the full coverage shards before W1-T4406 may narrow PR CI. */
// PRIMARY CONTROL: a rolling 60-run window holds the first-day rate (~20 failures in 40 runs)
// long enough to require 30 observed failures after repair, across at least 40 complete runs.
export const SELECTOR_SHADOW_RUN_LIMIT = 60;
export const SELECTOR_SHADOW_SHARDS = 8;
export const SELECTOR_SHADOW_MIN_FAILURES = 30;
export const SELECTOR_SHADOW_MIN_RUNS = 40;
/** A background pass may fetch only this many previously unseen workflow logs. */
export const SELECTOR_SHADOW_FRESH_LOGS_PER_PASS = 8;
/** Incomplete completed-run logs get a second look, but never on every daemon tick. */
export const SELECTOR_SHADOW_INCOMPLETE_RETRY_MS = 6 * 60 * 60 * 1000;
/** A selector decision cannot rest on a workflow list older than the current PR activity. */
export const SELECTOR_SHADOW_RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

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
  runsSkipped: number;
  runsIncomplete: number;
  /** Failures in a coverage job that still concluded `success`: its retry passed, so no selector
   *  could have hidden a regression there. Counted, never scored as a selection verdict. */
  recovered: number;
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

function selectorShadowRunHeaders(response: unknown, limit: number, sinceMs: number, nowMs: number): Array<Omit<SelectorShadowRun, "log">> {
  const body = response as {
    workflow_runs?: Array<{ id?: number; head_sha?: string; status?: string; conclusion?: string | null; created_at?: string; pull_requests?: Array<{ number?: number; base?: { sha?: string } }> }>;
  } | null;
  if (body === null || typeof body !== "object") throw new Error("selector shadow: GitHub returned no workflow-runs object");
  if (!Array.isArray(body.workflow_runs)) throw new Error("selector shadow: GitHub returned no workflow_runs list");
  return body.workflow_runs.map((run) => {
    if (!nonnegativeInteger(run.id) || typeof run.head_sha !== "string") {
      throw new Error("selector shadow: a workflow run has no id or head SHA");
    }
    if (typeof run.status !== "string") throw new Error("selector shadow: a workflow run has no status");
    const createdMs = typeof run.created_at === "string" ? Date.parse(run.created_at) : NaN;
    if (!Number.isFinite(createdMs) || createdMs < sinceMs || createdMs > nowMs + 5 * 60 * 1000) {
      throw new Error(`selector shadow: workflow run ${run.id} has a missing or stale creation date`);
    }
    // A cancelled run (29 of the newest 100 on 2026-09-29, superseded pushes) never has eight
    // coverage jobs, so counting it as incomplete kept every window short of a verdict.
    if (run.status !== "completed" || run.conclusion === "cancelled" || run.conclusion === "skipped") return null;
    return {
      id: run.id,
      headSha: run.head_sha,
      ...(typeof run.pull_requests?.[0]?.base?.sha === "string" ? { baseSha: run.pull_requests[0].base.sha } : {}),
      ...(nonnegativeInteger(run.pull_requests?.[0]?.number) ? { prNumber: run.pull_requests![0]!.number } : {}),
    };
  }).filter((run): run is Omit<SelectorShadowRun, "log"> => run !== null).slice(0, limit);
}

function selectorShadowRunListArgs(owner: string, repo: string, limit: number, sinceMs: number): string[] {
  // The combined event+status query returned only Sept 22-23 runs on Sept 28, while event alone
  // returned today's runs (98 completed in its newest 100). Filter status locally so a stale
  // server-side intersection cannot replace the rolling evidence window with ancient history.
  const created = encodeURIComponent(`>=${clockFromMillisFn(() => sinceMs).iso()}`);
  return ["api", `repos/${owner}/${repo}/actions/workflows/ci.yml/runs?event=pull_request&per_page=${Math.min(100, Math.max(limit, SELECTOR_SHADOW_RUN_LIMIT) + 40)}&created=${created}`,
    "--jq", SELECTOR_SHADOW_RUN_FIELDS];
}

/** The full 100-run page is ~1.3 MB; gh projects it to the six fields read here (~20 KB), so the
 *  child's stdout fits one pipe buffer and cannot stall behind a busy daemon event loop. */
export const SELECTOR_SHADOW_RUN_FIELDS =
  "{workflow_runs: [.workflow_runs[] | {id, head_sha, status, conclusion, created_at, pull_requests: [.pull_requests[]? | {number, base: {sha: .base.sha}}]}]}";

function selectorShadowRunLogArgs(owner: string, repo: string, id: number): string[] {
  return ["run", "view", String(id), "--repo", `${owner}/${repo}`, "--log"];
}

/** `gh run view --log` silently omitted all eight coverage jobs in a live 39-job CI run under
 * App auth. Read the eight job logs by ID so absent evidence stays visible as an error. */
export async function readCoverageShardLogsAsync(
  owner: string,
  repo: string,
  runId: number,
  io: { readJson?: (args: string[]) => Promise<unknown>; readText?: (args: string[]) => Promise<string> } = {},
): Promise<string> {
  const response = await (io.readJson ?? ghJsonAsync)(["api", `repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`]);
  const body = response as { total_count?: number; jobs?: Array<{ id?: number; name?: string; status?: string; conclusion?: string | null }> } | null;
  if (!body || !Array.isArray(body.jobs) || !nonnegativeInteger(body.total_count) || body.total_count > body.jobs.length) {
    throw new Error(`selector shadow: incomplete job list for run ${runId}`);
  }
  const jobs = new Map<number, number>();
  const conclusions = new Map<number, string>();
  for (const job of body.jobs) {
    const match = /^coverage-shard \(([1-8])\/8\)$/.exec(job.name ?? "");
    if (!match) continue;
    const shard = Number(match[1]);
    if (!nonnegativeInteger(job.id) || job.status !== "completed" || jobs.has(shard)) {
      throw new Error(`selector shadow: invalid coverage job ${shard} for run ${runId}`);
    }
    jobs.set(shard, job.id);
    if (typeof job.conclusion === "string") conclusions.set(shard, job.conclusion);
  }
  if (jobs.size !== SELECTOR_SHADOW_SHARDS) throw new Error(`selector shadow: missing coverage jobs for run ${runId}`);
  const readText = io.readText ?? ((args: string[]) => ghTextAsync(args, { maxBuffer: 16 * 1024 * 1024 }));
  const evidence: string[] = [];
  for (let shard = 1; shard <= SELECTOR_SHADOW_SHARDS; shard++) {
    const conclusion = conclusions.get(shard);
    if (conclusion !== undefined) evidence.push(`coverage-shard (${shard}/8)\t${SELECTOR_SHADOW_JOB_MARK}${conclusion}`);
    const raw = await readText(["api", `repos/${owner}/${repo}/actions/jobs/${jobs.get(shard)}/logs`]);
    for (const line of raw.split(/\r?\n/)) {
      if (isSelectorShadowEvidenceLine(line)) evidence.push(`coverage-shard (${shard}/8)\t${line}`);
    }
  }
  return evidence.join("\n");
}

/** The job's own verdict, carried beside its log lines so a report can tell a retry-recovered
 *  first-pass failure (the job still concluded `success`) from one that failed the shard. */
const SELECTOR_SHADOW_JOB_MARK = "SELECTOR-SHADOW-JOB: conclusion=";
const FLAKE_RETRY_FILES = /^(?:\S+Z )?FLAKE-RETRY-FILES: retrying \d+ failed file\(s\)(?: uninstrumented)? — (.+)$/;
const FLAKE_RETRY_RECOVERED = /^(?:\S+Z )?FLAKE-RETRY-RECOVERED: /;

/** The only job-log lines this gardener keeps: the shadow record, the explicit fast-lane skip, the
 *  job verdict, and test-with-retry.mjs's own retry/recovery lines (anchored at the log timestamp, so
 *  the workflow's echoed source and nested test output never match). */
function isSelectorShadowEvidenceLine(line: string): boolean {
  return line.includes("AFFECTED-SUITES-SHADOW: ") || line.startsWith(SELECTOR_SHADOW_JOB_MARK) ||
    (line.includes("W1-T2428 fast-lane: class=") && line.includes("skipping Test with coverage")) ||
    FLAKE_RETRY_FILES.test(line) || FLAKE_RETRY_RECOVERED.test(line);
}

interface ShardEvidence {
  conclusion?: string;
  retried: string[];
  recovered: boolean;
}

/** Per-shard verdicts and retry evidence from `coverage-shard (k/8)\t`-prefixed lines. */
function shardEvidence(log: string): Map<number, ShardEvidence> {
  const shards = new Map<number, ShardEvidence>();
  for (const line of log.split(/\r?\n/)) {
    const prefix = /^coverage-shard \(([1-8])\/8\)\t(.*)$/.exec(line);
    if (!prefix) continue;
    const shard = Number(prefix[1]);
    const body = prefix[2]!;
    const entry = shards.get(shard) ?? { retried: [], recovered: false };
    if (body.startsWith(SELECTOR_SHADOW_JOB_MARK)) entry.conclusion = body.slice(SELECTOR_SHADOW_JOB_MARK.length);
    const files = FLAKE_RETRY_FILES.exec(body);
    if (files) entry.retried.push(...files[1]!.split(", ").map((f) => f.trim()).filter(Boolean));
    if (FLAKE_RETRY_RECOVERED.test(body)) entry.recovered = true;
    shards.set(shard, entry);
  }
  return shards;
}

/** Test files whose failure a shard's own retry recovered — the evidence the test gardener's
 *  retier-flaker class counts (W1-T4112), which no CI runner can write into the fleet ledger. */
export function selectorShadowRecoveredFlakes(log: string): Array<{ shard: number; file: string }> {
  const out: Array<{ shard: number; file: string }> = [];
  for (const [shard, entry] of shardEvidence(log)) {
    if (entry.recovered && entry.conclusion === "success") for (const file of entry.retried) out.push({ shard, file });
  }
  return out.sort((a, b) => a.shard - b.shard || a.file.localeCompare(b.file));
}

/** PLAN_ONLY and DOCS_ONLY coverage jobs explicitly skip the shadow command. Require all eight
 * actual skip lines before excluding a run; a missing or unreadable job is still incomplete. */
function explicitlySkippedRun(log: string): boolean {
  const shards = new Set<number>();
  for (const line of log.split(/\r?\n/)) {
    const match = /coverage-shard \(([1-8])\/8\).*W1-T2428 fast-lane: class=(PLAN_ONLY|DOCS_ONLY) — skipping Test with coverage/.exec(line);
    if (match) shards.add(Number(match[1]));
  }
  return shards.size === SELECTOR_SHADOW_SHARDS && parseSelectorShadowLines(log).length === 0;
}

/** Synchronous reader retained for direct/offline callers. The daemon uses the async reader below. */
export function readSelectorShadowRuns(
  owner: string,
  repo: string,
  limit = SELECTOR_SHADOW_RUN_LIMIT,
  io: { readJson?: (args: string[]) => unknown; readLog?: (args: string[]) => string; clock?: Clock } = {},
): SelectorShadowRun[] {
  const readJson = io.readJson ?? ghJson;
  const readLog = io.readLog ?? ((args: string[]) => ghExec(args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const nowMs = (io.clock ?? systemClock).now();
  const sinceMs = nowMs - SELECTOR_SHADOW_RECENT_WINDOW_MS;
  return selectorShadowRunHeaders(readJson(selectorShadowRunListArgs(owner, repo, limit, sinceMs)), limit, sinceMs, nowMs).map((run) => ({
    ...run,
    log: readLog(selectorShadowRunLogArgs(owner, repo, run.id)),
  }));
}

/** Version 3 keeps each coverage job's conclusion and its retry lines; a version-2 entry lacks
 *  them, so it would still count retry-recovered flakes as misses and is read again. */
export const SELECTOR_SHADOW_READER_VERSION = 3;

/** Reading many run logs must yield the daemon event loop between bounded GitHub calls. */
export async function readSelectorShadowRunsAsync(
  owner: string,
  repo: string,
  limit = SELECTOR_SHADOW_RUN_LIMIT,
  io: {
    readJson?: (args: string[]) => Promise<unknown>;
    readLog?: (args: string[]) => Promise<string>;
    cachePath?: string;
    clock?: Clock;
    freshLogsPerPass?: number;
    warn?: (message: string) => void;
    writeCache?: (path: string, contents: string) => void;
    /** Each newly complete run's retry-recovered test files, reported exactly once. */
    onFlakes?: (runId: number, flakes: Array<{ shard: number; file: string }>) => void;
  } = {},
): Promise<SelectorShadowRun[]> {
  const readJson = io.readJson ?? ghJsonAsync;
  const writeCache = io.writeCache ?? writeAtomic;
  const nowMs = (io.clock ?? systemClock).now();
  const sinceMs = nowMs - SELECTOR_SHADOW_RECENT_WINDOW_MS;
  const headers = selectorShadowRunHeaders(await readJson(selectorShadowRunListArgs(owner, repo, limit, sinceMs)), limit, sinceMs, nowMs);
  type CachedLog = { headSha: string; log: string; fetchedAt: number; complete: boolean; readerVersion: number };
  let cached: Record<string, CachedLog> = {};
  if (io.cachePath) {
    try {
      const raw = readFileIfExists(io.cachePath);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid cache object");
        for (const [key, value] of Object.entries(parsed)) {
          if (!value || typeof value !== "object") continue;
          const row = value as Partial<CachedLog>;
          if (typeof row.headSha === "string" && typeof row.log === "string" &&
              typeof row.fetchedAt === "number" && typeof row.complete === "boolean" && row.readerVersion === SELECTOR_SHADOW_READER_VERSION) {
            cached[key] = row as CachedLog;
          }
        }
      }
    } catch (error) {
      io.warn?.(`selector shadow log cache unreadable: ${String((error as Error).message)}`);
    }
  }
  const clock = io.clock ?? systemClock;
  const freshLimit = io.cachePath ? (io.freshLogsPerPass ?? SELECTOR_SHADOW_FRESH_LOGS_PER_PASS) : Infinity;
  let freshReads = 0;
  const runs: SelectorShadowRun[] = [];
  for (const run of headers) {
    const key = String(run.id);
    const hit = cached[key];
    const reusable = hit?.headSha === run.headSha &&
      (hit.complete || (clock.now() - hit.fetchedAt >= 0 && clock.now() - hit.fetchedAt < SELECTOR_SHADOW_INCOMPLETE_RETRY_MS));
    if (reusable) {
      runs.push({ ...run, log: hit.log });
      continue;
    }
    if (freshReads >= freshLimit) {
      // A placeholder keeps the report INSUFFICIENT until the whole requested window is read.
      // Returning only the fetched prefix could certify narrowing while newer runs are absent.
      runs.push({ ...run, log: "" });
      continue;
    }
    let fullLog: string;
    try {
      fullLog = io.readLog
        ? await io.readLog(selectorShadowRunLogArgs(owner, repo, run.id))
        : await readCoverageShardLogsAsync(owner, repo, run.id);
    } catch (error) {
      const detail = `${String((error as Error).message)} ${String((error as { stderr?: string }).stderr ?? "")}`;
      if (!io.cachePath || /Bad credentials|HTTP 401/i.test(detail)) throw error;
      io.warn?.(`selector shadow run ${run.id} log unreadable: ${String((error as Error).message)}`);
      fullLog = "";
    }
    freshReads++;
    const log = io.cachePath
      ? fullLog.split(/\r?\n/).filter((line) => isSelectorShadowEvidenceLine(line.replace(/^coverage-shard \([1-8]\/8\)\t/, ""))).join("\n")
      : fullLog;
    runs.push({ ...run, log });
    if (io.cachePath) {
      const complete = parseSelectorShadowLines(log).length === SELECTOR_SHADOW_SHARDS || explicitlySkippedRun(log);
      // Reported once: a complete run is cached and never fetched again, so its flakes are never recounted.
      if (complete) io.onFlakes?.(run.id, selectorShadowRecoveredFlakes(log));
      cached[key] = { headSha: run.headSha, log, fetchedAt: clock.now(), complete, readerVersion: SELECTOR_SHADOW_READER_VERSION };
      try {
        writeCache(io.cachePath, JSON.stringify(cached) + "\n");
      } catch (error) {
        io.warn?.(`selector shadow log cache write failed: ${String((error as Error).message)}`);
      }
    }
  }
  if (io.cachePath) {
    const wanted = new Set(headers.map((run) => String(run.id)));
    cached = Object.fromEntries(Object.entries(cached).filter(([key]) => wanted.has(key)));
    try { writeCache(io.cachePath, JSON.stringify(cached) + "\n"); }
    catch (error) { io.warn?.(`selector shadow log cache prune failed: ${String((error as Error).message)}`); }
  }
  return runs;
}

/** Fetch the changed side of the exact PR-run comparison only when a miss needs a task. */
export async function readSelectorShadowChangedPaths(
  owner: string, repo: string, miss: SelectorShadowMiss,
  readJson: (args: string[]) => unknown = ghJsonAsync,
): Promise<string[]> {
  if (!miss.baseSha) return [];
  const response = await readJson(["api", `repos/${owner}/${repo}/compare/${miss.baseSha}...${miss.headSha}`]) as {
    files?: Array<{ filename?: string }>;
  } | null;
  if (response === null || typeof response !== "object") throw new Error(`selector shadow: GitHub returned no comparison object for ${miss.headSha}`);
  if (!Array.isArray(response.files) || response.files.length >= 300 ||
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
  let runsSkipped = 0;
  let runsIncomplete = 0;
  let recovered = 0;
  for (const run of runs) {
    if (explicitlySkippedRun(run.log)) {
      runsSkipped += 1;
      continue;
    }
    const records = parseSelectorShadowLines(run.log);
    if (records.length !== SELECTOR_SHADOW_SHARDS) {
      runsIncomplete += 1;
      continue;
    }
    runsComplete += 1;
    const jobs = shardEvidence(run.log);
    const shards = run.log.split(/\r?\n/).filter((line) => line.includes("AFFECTED-SUITES-SHADOW: "))
      .map((line) => Number(/^coverage-shard \(([1-8])\/8\)/.exec(line)?.[1]));
    for (const [index, record] of records.entries()) {
      floorSizes.push(record.fullRun ? fullSuiteSize : record.floorSize);
      if (record.narrowSize !== undefined) narrowSizes.push(record.narrowSize);
      // The shard exits non-zero on any failure its retry did not recover (ci.yml's TEST_EXIT), so a
      // failure inside a job that concluded `success` was a flake no selection could have hidden.
      // 28 of the first 35 filed "misses" were exactly this (2026-09-29 audit).
      if (jobs.get(shards[index]!)?.conclusion === "success") {
        recovered += record.failures.length;
        continue;
      }
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
  return { runsRequested: runs.length, runsComplete, runsSkipped, runsIncomplete, recovered, fullSuiteSize, floor, narrow, misses, verdict, reason };
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

/** One plan task per missed test file: every later miss of the same file is evidence for that
 *  task, never a new shard (33 near-duplicate shards were filed 2026-09-27..29 under the old
 *  one-shard-per-observation key). */
export function selectorShadowCauseOrigin(file: string): string {
  return `selector-shadow-miss:${file}`;
}

/** The missed test file a plan origin names, in the cause form or the older per-observation form. */
export function selectorShadowCauseOf(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  if (origin.startsWith("selector-shadow-miss:")) return origin.slice("selector-shadow-miss:".length);
  return /^selector-shadow:[^:]+:(?:floor|narrow):(.+)$/.exec(origin)?.[1];
}

/** A parked plan task names the missed suite and the first observed changed paths into it, without
 *  guessing imports. */
export function selectorShadowMissTask(miss: SelectorShadowMiss, taskId: string, changedPaths: readonly string[] = []): string {
  const origin = selectorShadowCauseOrigin(miss.file);
  const edge = `${changedPaths.length ? changedPaths.join(", ") : miss.headSha} -> ${miss.file}`;
  const q = JSON.stringify;
  return [
    `- id: ${taskId}`,
    `  title: ${q(`REPAIR THE SELECTOR EDGE INTO ${miss.file} — a coverage shard failure its retry did not recover was missed`)}`,
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
    `  note: ${q(`W1-T4439 first observed a ${miss.selection} miss on coverage run ${miss.runId}${miss.prNumber ? ` for PR #${miss.prNumber}` : ""} at ${miss.headSha}: ${edge}. The failing shard concluded failure, so its retry did not recover it. The changed paths are candidate missing edges, not guessed import edges. Later misses of the same suite are ledgered as selector-shadow.miss_evidence rows naming this task rather than filed again.`)}`,
    "  acceptance:",
    `    - claim: ${q(`the ${miss.selection} selector includes ${miss.file} when this edge is exercised`)}`,
    `      proof: ${q(`grep: ${miss.file.replaceAll(".", "\\.")} in src/lib/affected-suites.ts`)}`,
    "",
  ].join("\n");
}

type SelectorShadowPlanTask = { id: string; origin?: string; retirement?: string };

/** The daemon checkout's plan, read only when an unseen miss needs a home. */
export function selectorShadowPlanTasks(repoRoot: string): SelectorShadowPlanTask[] {
  return loadPlan(resolveRepoLayout(repoRoot).planMonolith).tasks;
}

/** One `test.flake_retry` ledger row per retry-recovered file: the test gardener's retier-flaker
 *  input (W1-T4112), which test-with-retry.mjs writes only into a CI runner's own discarded state. */
export function selectorShadowFlakeLedger(log: GardenerDeps["log"]): (runId: number, flakes: Array<{ shard: number; file: string }>) => void {
  return (runId, flakes) => {
    for (const flake of flakes) {
      log("test.flake_retry", { file: flake.file, headline: "recovered on retry", ci_run_id: runId, shard: flake.shard, source: "selector-shadow" });
    }
  };
}

/** Report every pass. A miss whose suite already has a task is ledgered as evidence for it; at most
 *  one miss with no task files a new one, so the daemon cannot flood the plan. The shared gardener
 *  seam carries state, checkout, workspace and log; the reads are this gardener's own inputs, passed
 *  beside it rather than declared as another seam shape. */
export async function runSelectorShadowGardener(
  deps: GardenerDeps,
  readRuns: () => SelectorShadowRun[],
  readChangedPaths: (miss: SelectorShadowMiss) => string[] | Promise<string[]>,
  mintTaskId: (filingBranch: string) => string,
  planTasks: () => SelectorShadowPlanTask[] = () => selectorShadowPlanTasks(deps.repoRoot),
): Promise<SelectorShadowReport> {
  const path = join(deps.stateDir, "selector-shadow-gardener.json");
  const stored = readFileIfExists(path);
  const prior = stored === undefined ? {} : JSON.parse(stored) as { filedKeys?: string[]; causes?: Record<string, string> };
  if (prior.filedKeys !== undefined && !Array.isArray(prior.filedKeys)) throw new Error("selector shadow: invalid filed-keys state");
  const seen = new Set(prior.filedKeys ?? []);
  const causes: Record<string, string> = { ...(prior.causes ?? {}) };
  const report = selectorShadowReport(readRuns(), selectorShadowFullSuiteSize(deps.repoRoot));
  deps.log("selector-shadow.report", { ...report, misses: report.misses.slice(0, 20) });
  const unseen = report.misses.filter((m) => !seen.has(selectorShadowMissKey(m)));
  // The plan is read only when there is something new to place, never on an idle pass.
  const planned = new Map<string, { id: string; retired: boolean }>();
  if (unseen.length > 0) {
    for (const task of planTasks()) {
      const file = selectorShadowCauseOf(task.origin);
      if (file === undefined) continue;
      const held = planned.get(file);
      if (!held || (held.retired && task.retirement === undefined)) planned.set(file, { id: task.id, retired: task.retirement !== undefined });
    }
  }
  let filedThisPass = false;
  for (const miss of unseen) {
    const key = selectorShadowMissKey(miss);
    const home = causes[miss.file] ?? planned.get(miss.file)?.id;
    if (home !== undefined) {
      seen.add(key);
      causes[miss.file] = home;
      deps.log("selector-shadow.miss_evidence", {
        task_id: home, file: miss.file, selection: miss.selection, ci_run_id: miss.runId, head_sha: miss.headSha,
        ...(miss.prNumber === undefined ? {} : { pr: miss.prNumber }),
        ...(planned.get(miss.file)?.retired && planned.get(miss.file)?.id === home ? { task_retired: true } : {}),
      });
      continue;
    }
    if (filedThisPass) continue;
    filedThisPass = true;
    const changedPaths = await readChangedPaths(miss);
    const workspace = deps.openWorkspace();
    try {
      if (!workspace.branch) throw new Error("selector shadow: filing workspace has no branch for task-id reservation");
      const taskId = mintTaskId(workspace.branch);
      const name = `${taskId.toLowerCase()}-selector-shadow-miss.yaml`;
      const relativePath = join("plan", "tasks.d", name);
      const contents = selectorShadowMissTask(miss, taskId, changedPaths);
      const task = loadPlanFromYaml(contents, name).tasks[0];
      const lint = lintTask(task);
      if (!lint.ok) throw new Error(`selector shadow: missed-edge task failed lint: ${lint.violations.map((v) => v.check).join(", ")}`);
      writeAtomic(join(workspace.root, relativePath), contents);
      const originProof = selectorShadowCauseOrigin(miss.file).replaceAll(".", "\\.");
      const prUrl = workspace.land({
        paths: [relativePath],
        title: `fix(selector): file missed ${miss.selection} edge for ${miss.file.split("/").at(-1)}`,
        body: `The W1-T4439 shadow record observed ${miss.selection} miss on run ${miss.runId}: ${changedPaths.length ? changedPaths.join(", ") : miss.headSha} -> ${miss.file}.\n\nThe task is parked for review; W1-T4406 remains gated.\n\n## Acceptance\n\n- claim: the missed selector edge is recorded as a parked task\n  proof: grep: ${originProof} in ${relativePath}`,
      });
      if (!prUrl) throw new Error("selector shadow: task PR was not opened");
      seen.add(key);
      causes[miss.file] = taskId;
      deps.log("selector-shadow.miss_filed", { task_id: taskId, pr_url: prUrl, edge: `${changedPaths.length ? changedPaths.join(", ") : miss.headSha} -> ${miss.file}` });
    } finally {
      workspace.dispose();
    }
  }
  writeAtomic(path, JSON.stringify({ filedKeys: [...seen], causes, report }) + "\n");
  return report;
}

/** Run immediately, then on the daemon interval; one pass at a time. */
export function startSelectorShadowGardener(
  deps: GardenerDeps,
  readRuns: () => SelectorShadowRun[] | Promise<SelectorShadowRun[]>,
  readChangedPaths: (miss: SelectorShadowMiss) => string[] | Promise<string[]>,
  mintTaskId: (filingBranch: string) => string,
  intervalMs: number,
  planTasks?: () => SelectorShadowPlanTask[],
): { stop: () => void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const runs = await readRuns();
      await runSelectorShadowGardener(deps, () => runs, readChangedPaths, mintTaskId, planTasks);
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
