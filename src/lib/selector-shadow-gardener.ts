import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

import { affectedSelectionOrFull, changedSymbols, readAffectedSuitesInput, shadowRecord } from "./affected-suites.js";
import { callerReachableSuites } from "./ci-parity.js";
import { defaultPreflightSpawn, type PreflightSpawn } from "./commit-message.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { clockFromMillisFn, systemClock, type Clock } from "./clock.js";
import type { GardenCheckout, GardenCheckoutAsync, GardenerDeps } from "./gardener.js";
import { ghExec, ghJson, ghJsonAsync, ghTextAsync } from "./github-transport.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { linkWorktreeNodeModules } from "./worker.js";
import { loadPlan, loadPlanFromYaml } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { lintTask } from "./task-linter.js";
import { machineShardHeaderLines } from "./machine-filing.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

/** W1-T4439: evidence from the full coverage shards before W1-T4406 may narrow PR CI. */
// PRIMARY CONTROL: the live window one pass reads. Since W1-T5925 the verdict folds every stored
// observation, so this bounds the reads, not the evidence (30 failures in 60 runs needed a ~50% rate).
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

/** W1-T5952: "flake" (affected-suites.ts's shadowRecord, W1-T4462) is a failure caught only because
 *  recentFailures rescued its suite. It is counted, never scored as a selection or a miss. */
export type SelectorShadowVerdict = "selected" | "missed" | "flake";

function isSelectorShadowVerdict(value: unknown): value is SelectorShadowVerdict {
  return value === "selected" || value === "missed" || value === "flake";
}

export interface SelectorShadowFailure {
  file: string;
  floor: SelectorShadowVerdict;
  narrow?: SelectorShadowVerdict;
  /** The file's own retry in its shard (scripts/select-affected-suites.mjs's retryOutcomes). */
  retry?: "recovered" | "failed";
  /** Set once, when the gardener stores the observation: evidence read then that the diff did not cause it. */
  unattributed?: "base_red" | "flake_history";
}

/** Why a missed failure is not charged to the selector. A miss counts only when the diff plausibly
 *  caused it; each reason is a signal the data already records, never an inference:
 *  - retry_recovered: the file's own retry in that shard passed (W1-T4398 pass two did not name it).
 *  - base_red: main's own CI failed the file at the run's base sha (W1-T5409's reader).
 *  - flake_history: a coverage shard's retry recovered the file in a run inside the live window.
 *  - mass: the run missed more than SELECTOR_SHADOW_MASS_FAILURE_FILES distinct files (W1-T5350).
 *  An environmental signature (timeout, ENOSPC, a killed runner) is not among them: the kept job-log
 *  evidence does not record one. */
export type SelectorShadowUnattributedReason = "retry_recovered" | "base_red" | "flake_history" | "mass";

const SELECTOR_SHADOW_RETRY_OUTCOMES = new Set(["recovered", "failed"]);
const SELECTOR_SHADOW_STORED_REASONS = new Set(["base_red", "flake_history"]);

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

/** A miss the gate does not charge to the selector, with the reason the operator can audit. */
export interface SelectorShadowUnattributedMiss extends SelectorShadowMiss {
  reason: SelectorShadowUnattributedReason;
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
  /** W1-T5952: flake verdicts per selection, outside each selection's `failures`. */
  flakes: { floor: number; narrow: number };
  /** Attributed misses only: each one blocks the flip. */
  misses: SelectorShadowMiss[];
  /** Missed failures the diff did not plausibly cause, outside each selection's `failures`. */
  unattributed: { floor: number; narrow: number; misses: SelectorShadowUnattributedMiss[] };
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
          !isSelectorShadowVerdict(f.floor) || (f.narrow !== undefined && !isSelectorShadowVerdict(f.narrow)) ||
          (row.narrowSize !== undefined && f.narrow === undefined) ||
          (row.narrowSize === undefined && f.narrow !== undefined) ||
          (row.fullRun && f.floor !== "selected") || (f.retry !== undefined && !SELECTOR_SHADOW_RETRY_OUTCOMES.has(f.retry as string))) {
        throw new Error("selector shadow: invalid failure verdict");
      }
      return { file: f.file, floor: f.floor, ...(f.narrow === undefined ? {} : { narrow: f.narrow }),
        ...(f.retry === undefined ? {} : { retry: f.retry as "recovered" | "failed" }) };
    });
    records.push({ fullRun: row.fullRun, floorSize: row.floorSize as number,
      ...(row.narrowSize === undefined ? {} : { narrowSize: row.narrowSize as number }), failures });
  }
  return records;
}

/** One listed workflow run, validated: the fields both the live window and the replay read. */
interface SelectorShadowRunRow extends Omit<SelectorShadowRun, "log"> {
  status: string;
  conclusion?: string;
  createdMs: number;
}

function selectorShadowRunRows(response: unknown): SelectorShadowRunRow[] {
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
    return {
      id: run.id,
      headSha: run.head_sha,
      ...(typeof run.pull_requests?.[0]?.base?.sha === "string" ? { baseSha: run.pull_requests[0].base.sha } : {}),
      ...(nonnegativeInteger(run.pull_requests?.[0]?.number) ? { prNumber: run.pull_requests![0]!.number } : {}),
      status: run.status,
      ...(typeof run.conclusion === "string" ? { conclusion: run.conclusion } : {}),
      createdMs: typeof run.created_at === "string" ? Date.parse(run.created_at) : NaN,
    };
  });
}

function selectorShadowRunHeaders(response: unknown, limit: number, sinceMs: number, nowMs: number): Array<Omit<SelectorShadowRun, "log">> {
  return selectorShadowRunRows(response).map(({ status, conclusion, createdMs, ...run }) => {
    if (!Number.isFinite(createdMs) || createdMs < sinceMs || createdMs > nowMs + 5 * 60 * 1000) {
      throw new Error(`selector shadow: workflow run ${run.id} has a missing or stale creation date`);
    }
    // A cancelled run (29 of the newest 100 on 2026-09-29, superseded pushes) never has eight
    // coverage jobs, so counting it as incomplete kept every window short of a verdict.
    if (status !== "completed" || conclusion === "cancelled" || conclusion === "skipped") return null;
    return run;
  }).filter((run): run is Omit<SelectorShadowRun, "log"> => run !== null).slice(0, limit);
}

function selectorShadowRunListArgs(owner: string, repo: string, perPage: number, created: string): string[] {
  // The combined event+status query returned only Sept 22-23 runs on Sept 28, while event alone
  // returned today's runs (98 completed in its newest 100). Filter status locally so a stale
  // server-side intersection cannot replace the rolling evidence window with ancient history.
  return ["api", `repos/${owner}/${repo}/actions/workflows/ci.yml/runs?event=pull_request&per_page=${perPage}&created=${encodeURIComponent(created)}`,
    "--jq", SELECTOR_SHADOW_RUN_FIELDS];
}

/** The live window's listing: every run created inside the recent window, newest first. */
function selectorShadowWindowListArgs(owner: string, repo: string, limit: number, sinceMs: number): string[] {
  return selectorShadowRunListArgs(owner, repo, Math.min(100, Math.max(limit, SELECTOR_SHADOW_RUN_LIMIT) + 40), `>=${clockFromMillisFn(() => sinceMs).iso()}`);
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
/** W1-T6406: test-with-retry.mjs's per-attempt headline, which names the failing tests. Only the two
 *  attempt headlines are kept — not "declined retry" or "tracked-tree dirt", which name no retry outcome. */
const FLAKE_RETRY_HEADLINE = /^(?:\S+Z )?FLAKE-RETRY: (first attempt failed|retry ALSO failed) — (.+)$/;
const FLAKE_NO_NAME = "(no test name parsed from output)";

/** The only job-log lines this gardener keeps: the shadow record, the explicit fast-lane skip, the
 *  job verdict, and test-with-retry.mjs's own retry/recovery lines (anchored at the log timestamp, so
 *  the workflow's echoed source and nested test output never match). */
function isSelectorShadowEvidenceLine(line: string): boolean {
  return line.includes("AFFECTED-SUITES-SHADOW: ") || line.startsWith(SELECTOR_SHADOW_JOB_MARK) ||
    (line.includes("W1-T2428 fast-lane: class=") && line.includes("skipping Test with coverage")) ||
    FLAKE_RETRY_FILES.test(line) || FLAKE_RETRY_RECOVERED.test(line) || FLAKE_RETRY_HEADLINE.test(line);
}

interface ShardEvidence {
  conclusion?: string;
  retried: string[];
  recovered: boolean;
  /** W1-T6406: the retry ran and ALSO failed — the case that reds a PR. */
  alsoFailed: boolean;
  /** Test titles the first attempt / the failed retry named. */
  firstTitles: string[];
  failedTitles: string[];
}

/** W1-T7125: the titles in a FLAKE-RETRY label. A label starting with "[" that parses as a JSON array
 *  of strings is the unambiguous form (a title may contain ", "); anything else is the older
 *  ", "-joined form from logs written before the producer changed. */
function parseFlakeTitles(label: string): string[] {
  const trimmed = label.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((t): t is string => typeof t === "string")) {
        return parsed.map((t) => t.trim()).filter(Boolean);
      }
    } catch (error) {
      void error; // not the array form (an old-form title that starts with "["): split it below
    }
  }
  return label.split(", ").map((t) => t.trim()).filter(Boolean);
}

/** Per-shard verdicts and retry evidence from `coverage-shard (k/8)\t`-prefixed lines. */
function shardEvidence(log: string): Map<number, ShardEvidence> {
  const shards = new Map<number, ShardEvidence>();
  for (const line of log.split(/\r?\n/)) {
    const prefix = /^coverage-shard \(([1-8])\/8\)\t(.*)$/.exec(line);
    if (!prefix) continue;
    const shard = Number(prefix[1]);
    const body = prefix[2]!;
    const entry = shards.get(shard) ?? { retried: [], recovered: false, alsoFailed: false, firstTitles: [], failedTitles: [] };
    if (body.startsWith(SELECTOR_SHADOW_JOB_MARK)) entry.conclusion = body.slice(SELECTOR_SHADOW_JOB_MARK.length);
    const files = FLAKE_RETRY_FILES.exec(body);
    if (files) entry.retried.push(...files[1]!.split(", ").map((f) => f.trim()).filter(Boolean));
    if (FLAKE_RETRY_RECOVERED.test(body)) entry.recovered = true;
    const headline = FLAKE_RETRY_HEADLINE.exec(body);
    if (headline) {
      const titles = headline[2]!.trim() === FLAKE_NO_NAME ? [] : parseFlakeTitles(headline[2]!);
      if (headline[1] === "retry ALSO failed") {
        entry.alsoFailed = true;
        entry.failedTitles.push(...titles);
      } else {
        entry.firstTitles.push(...titles);
      }
    }
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

/** W1-T6406: one retried test file in one shard, with how its retry ended. `titles` is set only when
 *  the shard retried exactly that one file, since the headline names tests without their file. */
export interface SelectorShadowFlake {
  shard: number;
  file: string;
  retryOutcome?: "recovered" | "also_failed";
  titles?: string[];
}

/** The run a flake was read from: what the flake-incident gardener groups by PR and diffs by sha. */
export interface SelectorShadowFlakeRun { prNumber?: number; headSha: string; baseSha?: string }

export type SelectorShadowFlakeSink = (runId: number, flakes: SelectorShadowFlake[], run?: SelectorShadowFlakeRun) => void;

/** Every retried file the logs show, recovered or not (W1-T6406). A shard whose retry also failed is
 *  reported for each file it retried, since the log does not say which of them failed again. */
export function selectorShadowFlakeEvidence(log: string): SelectorShadowFlake[] {
  const out: SelectorShadowFlake[] = [];
  for (const [shard, entry] of shardEvidence(log)) {
    const outcome = entry.alsoFailed ? "also_failed" : entry.recovered && entry.conclusion === "success" ? "recovered" : undefined;
    if (outcome === undefined) continue;
    const named = outcome === "also_failed" && entry.failedTitles.length > 0 ? entry.failedTitles : entry.firstTitles;
    const titles = entry.retried.length === 1 ? [...new Set(named)] : [];
    for (const file of entry.retried) out.push({ shard, file, retryOutcome: outcome, ...(titles.length > 0 ? { titles } : {}) });
  }
  return out.sort((a, b) => a.shard - b.shard || a.file.localeCompare(b.file));
}

/** W1-T5703: every class scripts/diff-class.mjs's COVERAGE_CLASSES skips coverage on (all but SOURCE). */
export const SELECTOR_SHADOW_SKIP_CLASSES = Object.freeze(["PLAN_ONLY", "DOCS_ONLY", "TEST_ONLY", "NO_SRC"] as const);
const EXPLICIT_SKIP_LINE = new RegExp(
  `coverage-shard \\(([1-8])\\/8\\).*W1-T2428 fast-lane: class=(${SELECTOR_SHADOW_SKIP_CLASSES.join("|")}) — skipping Test with coverage`,
);

/** A skip-class coverage job explicitly skips the shadow command. Require all eight
 * actual skip lines before excluding a run; a missing or unreadable job is still incomplete. */
function explicitlySkippedRun(log: string): boolean {
  const shards = new Set<number>();
  for (const line of log.split(/\r?\n/)) {
    const match = EXPLICIT_SKIP_LINE.exec(line);
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
  return selectorShadowRunHeaders(readJson(selectorShadowWindowListArgs(owner, repo, limit, sinceMs)), limit, sinceMs, nowMs).map((run) => ({
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
    /** Each newly complete run's retried test files, reported exactly once, with the run's PR and shas. */
    onFlakes?: SelectorShadowFlakeSink;
  } = {},
): Promise<SelectorShadowRun[]> {
  const readJson = io.readJson ?? ghJsonAsync;
  const writeCache = io.writeCache ?? writeAtomic;
  const nowMs = (io.clock ?? systemClock).now();
  const sinceMs = nowMs - SELECTOR_SHADOW_RECENT_WINDOW_MS;
  const headers = selectorShadowRunHeaders(await readJson(selectorShadowWindowListArgs(owner, repo, limit, sinceMs)), limit, sinceMs, nowMs);
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
      // W1-T6406: no reader-version bump — a run cached before this change was already reported, and
      // re-reading it would ledger its recovered files twice.
      if (complete) {
        io.onFlakes?.(run.id, selectorShadowFlakeEvidence(log), {
          headSha: run.headSha,
          ...(run.baseSha === undefined ? {} : { baseSha: run.baseSha }),
          ...(run.prNumber === undefined ? {} : { prNumber: run.prNumber }),
        });
      }
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
  owner: string, repo: string, miss: Pick<SelectorShadowMiss, "baseSha" | "headSha">,
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

/** W1-T5925: one complete run's scored evidence, appended once to the ledger and folded by every
 *  later report. `failures` are those its shard did not recover; a recovered one is only counted. */
export interface SelectorShadowObservation {
  runId: number;
  headSha: string;
  baseSha?: string;
  prNumber?: number;
  source: "live" | "replay";
  fullRun: boolean;
  floorSize: number;
  narrowSize?: number;
  failures: SelectorShadowFailure[];
  recovered: number;
}

type SelectorShadowReading = { kind: "skipped" | "incomplete" } | { kind: "complete"; observation: SelectorShadowObservation };

/** Only complete eight-shard runs are observations. An absent narrow decision cannot inflate its evidence. */
function selectorShadowReading(run: SelectorShadowRun, source: SelectorShadowObservation["source"] = "live"): SelectorShadowReading {
  if (explicitlySkippedRun(run.log)) return { kind: "skipped" };
  const records = parseSelectorShadowLines(run.log);
  if (records.length !== SELECTOR_SHADOW_SHARDS) return { kind: "incomplete" };
  const jobs = shardEvidence(run.log);
  const shards = run.log.split(/\r?\n/).filter((line) => line.includes("AFFECTED-SUITES-SHADOW: "))
    .map((line) => Number(/^coverage-shard \(([1-8])\/8\)/.exec(line)?.[1]));
  const failures: SelectorShadowFailure[] = [];
  let recovered = 0;
  for (const [index, record] of records.entries()) {
    // The shard exits non-zero on any failure its retry did not recover (ci.yml's TEST_EXIT), so a
    // failure inside a job that concluded `success` was a flake no selection could have hidden.
    // 25 of the first 35 filed "misses" were exactly this (2026-09-29 audit).
    if (jobs.get(shards[index]!)?.conclusion === "success") recovered += record.failures.length;
    else failures.push(...record.failures);
  }
  // Every shard computes the same selection from the same diff (35 of 35 cached live runs, 2026-10-06).
  const narrowSize = median(records.flatMap((record) => record.narrowSize === undefined ? [] : [record.narrowSize]));
  return { kind: "complete", observation: {
    runId: run.id, headSha: run.headSha,
    ...(run.baseSha === undefined ? {} : { baseSha: run.baseSha }),
    ...(run.prNumber === undefined ? {} : { prNumber: run.prNumber }),
    source, fullRun: records.some((record) => record.fullRun), floorSize: median(records.map((record) => record.floorSize))!,
    ...(narrowSize === null ? {} : { narrowSize }), failures, recovered,
  } };
}

type SelectorShadowFold = Pick<SelectorShadowReport, "runsComplete" | "recovered" | "floor" | "narrow" | "flakes" | "misses" | "unattributed">;

/** The reason a missed failure is unattributed, or undefined when the diff plausibly caused it. The
 *  stored reason wins; the retry and mass reasons are re-derived from the row, so they also apply to
 *  observations stored before attribution existed. */
export function selectorShadowUnattributedReason(
  failure: SelectorShadowFailure, run: Pick<SelectorShadowObservation, "failures">,
): SelectorShadowUnattributedReason | undefined {
  if (failure.unattributed !== undefined) return failure.unattributed;
  if (failure.retry === "recovered") return "retry_recovered";
  const missedFiles = new Set(run.failures.filter((f) => f.floor === "missed" || f.narrow === "missed").map((f) => f.file));
  return missedFiles.size > SELECTOR_SHADOW_MASS_FAILURE_FILES ? "mass" : undefined;
}

function foldSelectorShadowObservations(observations: readonly SelectorShadowObservation[], fullSuiteSize: number): SelectorShadowFold {
  const floorVerdicts: Array<"selected" | "missed"> = [];
  const narrowVerdicts: Array<"selected" | "missed"> = [];
  const floorSizes: number[] = [];
  const narrowSizes: number[] = [];
  const misses: SelectorShadowMiss[] = [];
  const flakes = { floor: 0, narrow: 0 };
  const unattributed: SelectorShadowFold["unattributed"] = { floor: 0, narrow: 0, misses: [] };
  let recovered = 0;
  for (const run of observations) {
    floorSizes.push(run.fullRun ? fullSuiteSize : run.floorSize);
    if (run.narrowSize !== undefined) narrowSizes.push(run.narrowSize);
    recovered += run.recovered;
    for (const failure of run.failures) {
      const reason = selectorShadowUnattributedReason(failure, run);
      for (const selection of ["floor", "narrow"] as const) {
        const verdict = failure[selection];
        if (verdict === undefined) continue;
        if (verdict === "flake") {
          flakes[selection] += 1;
          continue;
        }
        const miss = verdict === "missed" ? {
          runId: run.runId, headSha: run.headSha,
          ...(run.baseSha === undefined ? {} : { baseSha: run.baseSha }),
          ...(run.prNumber === undefined ? {} : { prNumber: run.prNumber }),
          selection, file: failure.file,
        } : undefined;
        // An unattributed miss is neither a selection nor a miss: it leaves the gate's arithmetic.
        if (miss !== undefined && reason !== undefined) {
          unattributed[selection] += 1;
          unattributed.misses.push({ ...miss, reason });
          continue;
        }
        (selection === "floor" ? floorVerdicts : narrowVerdicts).push(verdict);
        if (miss !== undefined) misses.push(miss);
      }
    }
  }
  return {
    runsComplete: observations.length, recovered, flakes, misses, unattributed,
    floor: selectionReport(floorVerdicts, floorSizes, fullSuiteSize),
    narrow: selectionReport(narrowVerdicts, narrowSizes, fullSuiteSize),
  };
}

/** The window's verdict also refuses an incomplete run (`runsIncomplete`); the accumulated one counts it. */
function selectorShadowVerdict(fold: SelectorShadowFold, runsIncomplete?: number): Pick<SelectorShadowReport, "verdict" | "reason"> {
  const verdict = fold.misses.length > 0 ? "misses" :
    (runsIncomplete ?? 0) > 0 || fold.runsComplete < SELECTOR_SHADOW_MIN_RUNS ||
    fold.narrow.failures < SELECTOR_SHADOW_MIN_FAILURES || fold.narrow.medianSize === null
      ? "insufficient" : "ready";
  const reason = verdict === "misses"
    ? `${fold.misses.length} diff-attributed missed failure(s); repair their selector edges before W1-T4406`
    : verdict === "ready"
      ? `${fold.narrow.failures} failures across ${fold.runsComplete} complete runs with zero misses; W1-T4406 may be reviewed for narrowing`
      : `need ${SELECTOR_SHADOW_MIN_FAILURES} narrow-observed failures across ${SELECTOR_SHADOW_MIN_RUNS} complete runs${runsIncomplete === undefined ? "" : ", zero incomplete runs"} and a measured narrow size`;
  return { verdict, reason };
}

function selectorShadowWindowReport(readings: readonly SelectorShadowReading[], fullSuiteSize: number): SelectorShadowReport {
  const fold = foldSelectorShadowObservations(readings.flatMap((r) => r.kind === "complete" ? [r.observation] : []), fullSuiteSize);
  const runsSkipped = readings.filter((r) => r.kind === "skipped").length;
  const runsIncomplete = readings.filter((r) => r.kind === "incomplete").length;
  return { runsRequested: readings.length, runsSkipped, runsIncomplete, fullSuiteSize, ...fold, ...selectorShadowVerdict(fold, runsIncomplete) };
}

/** The report over one window of runs; only complete eight-shard runs count. */
export function selectorShadowReport(runs: readonly SelectorShadowRun[], fullSuiteSize: number): SelectorShadowReport {
  return selectorShadowWindowReport(runs.map((run) => selectorShadowReading(run)), fullSuiteSize);
}

/** W1-T5925: the durable store. Rotation never archives this step (DECISION_RELEVANT_LEDGER_STEPS),
 *  so the live ledger holds every observation the fold reads, bounded by MAX_RETAINED_LINES_PER_STEP. */
export const SELECTOR_SHADOW_OBSERVATION_STEP = "selector-shadow.observation";
const SELECTOR_SHADOW_OBSERVATION_LINE = /"step":"selector-shadow\.observation"/;

function selectorShadowObservationRow(o: SelectorShadowObservation): Record<string, unknown> {
  return {
    ci_run_id: o.runId, head_sha: o.headSha,
    ...(o.baseSha === undefined ? {} : { base_sha: o.baseSha }),
    ...(o.prNumber === undefined ? {} : { pr: o.prNumber }),
    source: o.source, full_run: o.fullRun, floor_size: o.floorSize,
    ...(o.narrowSize === undefined ? {} : { narrow_size: o.narrowSize }),
    failures: o.failures, recovered: o.recovered,
  };
}

function selectorShadowObservationFromRow(row: Record<string, unknown>): SelectorShadowObservation | undefined {
  if (!nonnegativeInteger(row.ci_run_id) || typeof row.head_sha !== "string" || (row.source !== "live" && row.source !== "replay") ||
      typeof row.full_run !== "boolean" || !nonnegativeInteger(row.floor_size) || !nonnegativeInteger(row.recovered) ||
      (row.narrow_size !== undefined && !nonnegativeInteger(row.narrow_size)) || !Array.isArray(row.failures)) return undefined;
  const failures: SelectorShadowFailure[] = [];
  for (const entry of row.failures as unknown[]) {
    const f = entry as Record<string, unknown> | null;
    if (!f || typeof f.file !== "string" || !isSelectorShadowVerdict(f.floor) || (f.narrow !== undefined && !isSelectorShadowVerdict(f.narrow)) ||
        (row.full_run && f.floor !== "selected") || (f.retry !== undefined && !SELECTOR_SHADOW_RETRY_OUTCOMES.has(f.retry as string)) ||
        (f.unattributed !== undefined && !SELECTOR_SHADOW_STORED_REASONS.has(f.unattributed as string))) return undefined;
    failures.push({ file: f.file, floor: f.floor, ...(f.narrow === undefined ? {} : { narrow: f.narrow as SelectorShadowVerdict }),
      ...(f.retry === undefined ? {} : { retry: f.retry as "recovered" | "failed" }),
      ...(f.unattributed === undefined ? {} : { unattributed: f.unattributed as "base_red" | "flake_history" }) });
  }
  return {
    runId: row.ci_run_id, headSha: row.head_sha,
    ...(typeof row.base_sha === "string" ? { baseSha: row.base_sha } : {}),
    ...(nonnegativeInteger(row.pr) ? { prNumber: row.pr } : {}),
    source: row.source, fullRun: row.full_run, floorSize: row.floor_size,
    ...(row.narrow_size === undefined ? {} : { narrowSize: row.narrow_size as number }),
    failures, recovered: row.recovered,
  };
}

/** Every stored observation, the first row per run winning; a row that does not parse is counted. An
 *  unreadable live ledger throws: a report folded over an empty store would read as less evidence. */
export function readSelectorShadowObservations(stateDir: string): { observations: SelectorShadowObservation[]; unreadable: number } {
  // ledger-read-intent: live — the step is retained live across rotation, so no archive is read.
  const read = readLedgerUnionRecordsSync(stateDir, { pattern: SELECTOR_SHADOW_OBSERVATION_LINE, maxRotations: 0, refuseIncomplete: true });
  if (!read.ok) throw new Error(`selector shadow: the observation store is unreadable: ${read.unread.join(", ")}`);
  const observations = new Map<number, SelectorShadowObservation>();
  let unreadable = read.torn;
  for (const row of read.rows) {
    const observation = selectorShadowObservationFromRow(row);
    if (observation === undefined) unreadable += 1;
    else if (!observations.has(observation.runId)) observations.set(observation.runId, observation);
  }
  return { observations: [...observations.values()], unreadable };
}

/** BACKSTOP (W1-T5925): historical runs one pass may replay — one job list, eight log reads and one
 *  recomputed selection each — so a backfill spreads over the gardener's own cadence. */
export const SELECTOR_SHADOW_REPLAY_RUNS_PER_PASS = 2;
/** BACKSTOP: replayed observations the store may hold before the backfill stops — half of the
 *  MAX_RETAINED_LINES_PER_STEP rows rotation keeps of the step, so live rows always have room. */
export const SELECTOR_SHADOW_REPLAY_MAX_OBSERVATIONS = 100;
/** BACKSTOP: how far before its first pass the replay walks; GitHub keeps run logs for 90 days. */
export const SELECTOR_SHADOW_REPLAY_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
/** The replay's resumable cursor: the newest creation time it has not yet walked past. */
export const SELECTOR_SHADOW_REPLAY_STATE_FILE = "selector-shadow-replay.json";
const SELECTOR_SHADOW_REPLAY_PAGE = 100;

export interface SelectorShadowReplayRun {
  id: number;
  headSha: string;
  baseSha?: string;
  prNumber?: number;
}

/** A recomputed selection: the shadow record for the run's failed files, and why it ran what it ran. */
export interface SelectorShadowReplaySelection {
  record: { fullRun: boolean; floorSize: number; narrowSize?: number; failures: Array<{ file: string; floor: string; narrow?: string }> };
  reasons: readonly string[];
}

/** The replay's reads: GitHub through `gh` and the selection in a checkout, unless injected. */
export interface SelectorShadowReplay {
  owner: string;
  repo: string;
  readJson?: (args: string[]) => Promise<unknown>;
  readText?: (args: string[]) => Promise<string>;
  select?: (run: SelectorShadowReplayRun, failed: readonly string[]) => Promise<SelectorShadowReplaySelection>;
}

export interface SelectorShadowReplayPass {
  attempted: number;
  observed: number;
  skipped: number;
  before: string;
  exhausted: boolean;
  capped: boolean;
}

/** The narrow selection CI's shadow step (scripts/select-affected-suites.mjs) makes for the run's diff
 *  against its base, recomputed by the same functions in `root` checked out at the run's head. */
export async function selectorShadowReplaySelection(
  root: string, run: SelectorShadowReplayRun, failed: readonly string[], spawn: PreflightSpawn = defaultPreflightSpawn,
): Promise<SelectorShadowReplaySelection> {
  const git = (...args: string[]): string => {
    const result = spawn("git", args, { cwd: root });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim().slice(0, 200)}`);
    return result.stdout;
  };
  git("fetch", "--quiet", "origin", run.headSha, ...(run.baseSha === undefined ? [] : [run.baseSha]));
  git("checkout", "--quiet", "--detach", run.headSha);
  const range = `${run.baseSha ?? "origin/main"}...${run.headSha}`;
  const changed = git("diff", "--name-only", range).split("\n").map((line) => line.trim()).filter(Boolean);
  const selection = affectedSelectionOrFull(changed, () => {
    const symbols = changedSymbols(git("diff", "-U0", range), (path) => readFileSync(join(root, path), "utf8"));
    return readAffectedSuitesInput(root, changed, { symbolSuites: callerReachableSuites(symbols, root, spawn).suites });
  });
  return { record: shadowRecord(selection, failed), reasons: selection.reasons };
}

/** The default selection: one gardener checkout per pass, given the daemon's node_modules for tsx. */
function workspaceReplaySelector(deps: GardenerDeps) {
  let workspace: GardenCheckout | GardenCheckoutAsync | undefined;
  return {
    select: async (run: SelectorShadowReplayRun, failed: readonly string[]) => {
      if (workspace === undefined) {
        workspace = await deps.openWorkspace();
        linkWorktreeNodeModules(deps.repoRoot, workspace.root);
      }
      return selectorShadowReplaySelection(workspace.root, run, failed);
    },
    dispose: async () => { await workspace?.dispose(); },
  };
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

interface SelectorShadowReplayState { before: string; horizon: string; exhausted: boolean }

function readReplayState(deps: GardenerDeps, nowMs: number): SelectorShadowReplayState {
  const fresh = {
    before: clockFromMillisFn(() => nowMs - SELECTOR_SHADOW_RECENT_WINDOW_MS).iso(),
    horizon: clockFromMillisFn(() => nowMs - SELECTOR_SHADOW_REPLAY_HORIZON_MS).iso(),
    exhausted: false,
  };
  try {
    const raw = readFileIfExists(join(deps.stateDir, SELECTOR_SHADOW_REPLAY_STATE_FILE));
    if (raw === undefined) return fresh;
    const state = JSON.parse(raw) as Partial<SelectorShadowReplayState>;
    if (typeof state.before !== "string" || typeof state.horizon !== "string" || typeof state.exhausted !== "boolean") {
      throw new Error("invalid replay state");
    }
    return { before: state.before, horizon: state.horizon, exhausted: state.exhausted };
  } catch (error) {
    // Restarting is safe: the store's run ids keep a re-walked run from being observed twice.
    deps.log("selector-shadow.replay_state_unreadable", { error: errorText(error) });
    return fresh;
  }
}

type ReplayOutcome = SelectorShadowObservation | { reason: string; detail?: string };

/** One historical failing run: its own failures (from its shadow records, minus recovered shards), and
 *  whether today's narrow selection for its diff would have run each. */
async function replaySelectorShadowRun(replay: SelectorShadowReplay, select: NonNullable<SelectorShadowReplay["select"]>, row: SelectorShadowRunRow): Promise<ReplayOutcome> {
  const run: SelectorShadowReplayRun = {
    id: row.id, headSha: row.headSha,
    ...(row.baseSha === undefined ? {} : { baseSha: row.baseSha }),
    ...(row.prNumber === undefined ? {} : { prNumber: row.prNumber }),
  };
  let reading: SelectorShadowReading;
  try {
    const log = await readCoverageShardLogsAsync(replay.owner, replay.repo, row.id, { readJson: replay.readJson, readText: replay.readText });
    reading = selectorShadowReading({ ...run, log }, "replay");
  } catch (error) {
    return { reason: "unreadable", detail: errorText(error) };
  }
  if (reading.kind !== "complete") return { reason: "no_shadow_record" };
  const failed = [...new Set(reading.observation.failures.map((f) => f.file))];
  if (failed.length === 0) return { reason: "recovered" };
  // W1-T5350: a mass (or base) failure is not selector evidence; replaying it would read as misses.
  if (failed.length > SELECTOR_SHADOW_MASS_FAILURE_FILES) return { reason: "mass", detail: `${failed.length} failing files, more than K = ${SELECTOR_SHADOW_MASS_FAILURE_FILES}` };
  let selection: SelectorShadowReplaySelection;
  try {
    selection = await select(run, failed);
  } catch (error) {
    return { reason: "unselectable", detail: errorText(error) };
  }
  // A full run carries no narrow decision; its reason names an input the selector could not read.
  if (selection.record.fullRun) return { reason: "full_run", detail: selection.reasons[0] };
  const [record] = parseSelectorShadowLines(`AFFECTED-SUITES-SHADOW: ${JSON.stringify(selection.record)}`);
  const { id: runId, ...identity } = run;
  // The recomputed selection knows nothing of the run's retries; each file keeps its recorded outcome.
  const retryOf = new Map(reading.observation.failures.flatMap((f) => f.retry === undefined ? [] : [[f.file, f.retry] as const]));
  return {
    runId, ...identity, source: "replay", fullRun: false, floorSize: record!.floorSize,
    ...(record!.narrowSize === undefined ? {} : { narrowSize: record!.narrowSize }),
    failures: record!.failures.map((f) => retryOf.has(f.file) ? { ...f, retry: retryOf.get(f.file)! } : f),
    recovered: reading.observation.recovered,
  };
}

/** W1-T5925: one bounded replay pass over pull_request CI runs older than the live window, newest first.
 *  The cursor is saved after every pass, so the next resumes where this one stopped. */
async function replaySelectorShadowHistory(
  deps: GardenerDeps, replay: SelectorShadowReplay, known: ReadonlySet<number>, replayed: number,
): Promise<{ observations: SelectorShadowObservation[]; pass: SelectorShadowReplayPass }> {
  const state = readReplayState(deps, (deps.clock ?? systemClock).now());
  const observations: SelectorShadowObservation[] = [];
  const pass = { attempted: 0, skipped: 0, capped: replayed >= SELECTOR_SHADOW_REPLAY_MAX_OBSERVATIONS };
  const summary = () => ({ ...pass, observed: observations.length, before: state.before, exhausted: state.exhausted });
  if (state.exhausted || pass.capped) return { observations, pass: summary() };
  const beforeMs = Date.parse(state.before);
  const horizonMs = Date.parse(state.horizon);
  const listed = selectorShadowRunRows(await (replay.readJson ?? ghJsonAsync)(
    selectorShadowRunListArgs(replay.owner, replay.repo, SELECTOR_SHADOW_REPLAY_PAGE, `<${state.before}`)));
  // A listing that ignored its own created filter answers nothing older than the cursor.
  const rows = listed.filter((row) => row.createdMs < beforeMs).sort((a, b) => b.createdMs - a.createdMs);
  const selector = replay.select ? { select: replay.select, dispose: async () => {} } : workspaceReplaySelector(deps);
  let stopped = false;
  try {
    for (const row of rows) {
      if (row.createdMs < horizonMs) {
        state.exhausted = true;
        break;
      }
      const eligible = row.status === "completed" && row.conclusion === "failure" && !known.has(row.id);
      if (eligible && (pass.attempted >= SELECTOR_SHADOW_REPLAY_RUNS_PER_PASS || replayed + observations.length >= SELECTOR_SHADOW_REPLAY_MAX_OBSERVATIONS)) {
        stopped = true;
        break;
      }
      state.before = clockFromMillisFn(() => row.createdMs).iso();
      if (!eligible) continue;
      pass.attempted += 1;
      const outcome = await replaySelectorShadowRun(replay, selector.select, row);
      if ("reason" in outcome) {
        pass.skipped += 1;
        deps.log("selector-shadow.replay_skipped", { ci_run_id: row.id, reason: outcome.reason, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) });
      } else {
        observations.push(outcome);
      }
    }
  } finally {
    await selector.dispose();
  }
  if (!stopped && (listed.length < SELECTOR_SHADOW_REPLAY_PAGE || rows.length === 0)) state.exhausted = true;
  writeAtomic(join(deps.stateDir, SELECTOR_SHADOW_REPLAY_STATE_FILE), JSON.stringify(state) + "\n");
  return { observations, pass: summary() };
}

export interface SelectorShadowSourceReport {
  runs: number;
  floor: SelectorShadowSelectionReport;
  narrow: SelectorShadowSelectionReport;
}

/** The report a pass ledgers: the whole store folded, with the live window and each source beside it. */
export interface SelectorShadowAccumulatedReport extends SelectorShadowReport {
  window: Pick<SelectorShadowReport, "runsRequested" | "runsComplete" | "runsSkipped" | "runsIncomplete" | "verdict">;
  observations: { live: number; replay: number; appended: number; unreadable: number };
  live: SelectorShadowSourceReport;
  replay: SelectorShadowSourceReport;
  replayPass?: Partial<SelectorShadowReplayPass> & { error?: string };
}

/** Append each newly complete window run once, replay a bounded slice of history, and fold the whole
 *  store. An incomplete window run is counted, never stored, and never resets the verdict. */
async function accumulateSelectorShadow(
  deps: GardenerDeps, readings: readonly SelectorShadowReading[], window: SelectorShadowReport, replay: SelectorShadowReplay | undefined,
  attribute: (observation: SelectorShadowObservation) => Promise<SelectorShadowObservation>,
): Promise<SelectorShadowAccumulatedReport> {
  const stored = readSelectorShadowObservations(deps.stateDir);
  const all = new Map(stored.observations.map((o) => [o.runId, o]));
  let appended = 0;
  const append = (observation: SelectorShadowObservation): void => {
    all.set(observation.runId, observation);
    deps.log(SELECTOR_SHADOW_OBSERVATION_STEP, selectorShadowObservationRow(observation));
    appended += 1;
  };
  for (const reading of readings) {
    if (reading.kind === "complete" && !all.has(reading.observation.runId)) append(reading.observation);
  }
  let replayPass: SelectorShadowAccumulatedReport["replayPass"];
  if (replay !== undefined) {
    try {
      const replayed = [...all.values()].filter((o) => o.source === "replay").length;
      const result = await replaySelectorShadowHistory(deps, replay, new Set(all.keys()), replayed);
      for (const observation of result.observations) append(await attribute(observation));
      replayPass = result.pass;
    } catch (error) {
      deps.log("selector-shadow.replay_failed", { error: errorText(error) });
      replayPass = { error: errorText(error) };
    }
  }
  const observations = [...all.values()];
  const fold = foldSelectorShadowObservations(observations, window.fullSuiteSize);
  const source = (name: SelectorShadowObservation["source"]): SelectorShadowSourceReport => {
    const of = observations.filter((o) => o.source === name);
    const part = foldSelectorShadowObservations(of, window.fullSuiteSize);
    return { runs: of.length, floor: part.floor, narrow: part.narrow };
  };
  const live = source("live");
  const replayed = source("replay");
  return {
    runsRequested: window.runsRequested, runsSkipped: window.runsSkipped, runsIncomplete: window.runsIncomplete,
    fullSuiteSize: window.fullSuiteSize, ...fold, ...selectorShadowVerdict(fold),
    window: { runsRequested: window.runsRequested, runsComplete: window.runsComplete, runsSkipped: window.runsSkipped, runsIncomplete: window.runsIncomplete, verdict: window.verdict },
    observations: { live: live.runs, replay: replayed.runs, appended, unreadable: stored.unreadable },
    live, replay: replayed,
    ...(replayPass === undefined ? {} : { replayPass }),
  };
}

const execAsync = promisify(execFile);
const suiteSizes = new Map<string, { tree: string; size: number }>();

export async function selectorShadowFullSuiteSizeAsync(root: string, cachePath?: string): Promise<number> {
  let tree: string | undefined;
  try {
    const io = { log: () => { /* An unpinned checkout uses the uncached async walk below. */ } };
    const id = await hostWorktreeGitAsync(root, ["rev-parse", "HEAD:test"], io);
    const dirty = await hostWorktreeGitAsync(root, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", "test/"], io);
    if (!dirty.trim()) tree = id.trim();
  } catch (error) {
    // Without a readable git identity, count asynchronously and never reuse an unverified size.
    suiteSizes.delete(root);
  }
  let cached = suiteSizes.get(root);
  if (tree !== undefined && cachePath !== undefined && cached?.tree !== tree) {
    try {
      const stored = JSON.parse(await readFile(cachePath, "utf8")) as { root?: string; tree?: string; size?: number };
      if (stored.root === root && stored.tree === tree && nonnegativeInteger(stored.size)) cached = { tree, size: stored.size };
    } catch (error) {
      // A missing or corrupt optional cache establishes no size; recompute from the actual tree.
      cached = undefined;
    }
  }
  if (tree !== undefined && cached?.tree === tree) return cached.size;
  const walk = async (dir: string): Promise<number> => {
    let count = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      count += entry.isDirectory() ? await walk(join(dir, entry.name))
        : Number(entry.isFile() && entry.name.endsWith(".test.ts"));
    }
    return count;
  };
  const size = await walk(join(root, "test"));
  if (tree !== undefined) {
    suiteSizes.set(root, { tree, size });
    if (cachePath !== undefined) {
      const temporary = `${cachePath}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ root, tree, size }) + "\n");
        await rename(temporary, cachePath);
      } finally { await rm(temporary, { force: true }); }
    }
  }
  else suiteSizes.delete(root);
  return size;
}

export async function selectorShadowPlanTasksAsync(repoRoot: string): Promise<SelectorShadowPlanTask[]> {
  const { stdout } = await execAsync(process.execPath, ["--import", import.meta.resolve("tsx"),
    "--input-type=module", "--eval",
    `const { selectorShadowPlanTasks } = await import(${JSON.stringify(import.meta.url)});
     process.stdout.write(JSON.stringify(selectorShadowPlanTasks(process.argv[1])));`, repoRoot],
    { maxBuffer: 1 << 26 });
  return JSON.parse(stdout) as SelectorShadowPlanTask[];
}

export type SelectorShadowTaskIdMinter = ((filingBranch: string) => string | Promise<string>) & {
  async?: (filingBranch: string) => Promise<string>;
};

export function selectorShadowMissKey(miss: SelectorShadowMiss): string {
  return `selector-shadow:${miss.headSha}:${miss.selection}:${miss.file}`;
}

/** One plan task per missed test file: every later miss of the same file is evidence for that
 *  task, never a new shard (33 near-duplicate shards were filed 2026-09-27..29 under the old
 *  one-shard-per-observation key). */
export function selectorShadowCauseOrigin(file: string): string {
  return `selector-shadow-miss:${file}`;
}

/** W1-T4839: the one structural task a test missed AGAIN after its narrow repair merged. */
export function selectorShadowStructuralOrigin(file: string): string {
  return `selector-shadow-structural:${file}`;
}

/** The missed test file a plan origin names, in the cause form or the older per-observation form. */
export function selectorShadowCauseOf(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  if (origin.startsWith("selector-shadow-miss:")) return origin.slice("selector-shadow-miss:".length);
  if (origin.startsWith("selector-shadow-structural:")) return origin.slice("selector-shadow-structural:".length);
  return /^selector-shadow:[^:]+:(?:floor|narrow):(.+)$/.exec(origin)?.[1];
}

/** Where a narrow edge repair's regression test lives. Every narrow edge adds an uncovered line to
 *  src/lib/affected-suites.ts, so a shard declaring only that file yields a diff-coverage red that
 *  no worker may fix in scope: #10073, #10250, #10306 and #10441 were each covered by hand. */
export const SELECTOR_SHADOW_MISS_TEST_PATH = "test/the-affected-suite-selector-runs-in-shadow.test.ts";

/** A parked plan task names the missed suite and the first observed changed paths into it, without
 *  guessing imports. */
export function selectorShadowMissTask(miss: SelectorShadowMiss, taskId: string, changedPaths: readonly string[] = []): string {
  const origin = selectorShadowCauseOrigin(miss.file);
  const edge = `${changedPaths.length ? changedPaths.join(", ") : miss.headSha} -> ${miss.file}`;
  const pattern = miss.file.replaceAll(".", "\\.");
  const files = ["src/lib/affected-suites.ts", SELECTOR_SHADOW_MISS_TEST_PATH];
  const q = JSON.stringify;
  return [
    `- id: ${taskId}`,
    `  title: ${q(`REPAIR THE SELECTOR EDGE INTO ${miss.file} — a coverage shard failure its retry did not recover was missed`)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    ...machineShardHeaderLines(files),
    `  origin: ${q(origin)}`,
    `  files: [${files.join(", ")}]`,
    `  note: ${q(`W1-T4439 first observed a ${miss.selection} miss on coverage run ${miss.runId}${miss.prNumber ? ` for PR #${miss.prNumber}` : ""} at ${miss.headSha}: ${edge}. The failing shard concluded failure, so its retry did not recover it. The changed paths are candidate missing edges, not guessed import edges. Later misses of the same suite are ledgered as selector-shadow.miss_evidence rows naming this task rather than filed again. Add a test in ${SELECTOR_SHADOW_MISS_TEST_PATH} that selects ${miss.file} for each edge: diff-coverage blocks an edge no test exercises.`)}`,
    "  acceptance:",
    `    - claim: ${q(`the ${miss.selection} selector includes ${miss.file} when this edge is exercised`)}`,
    `      proof: ${q(`grep: ${pattern} in src/lib/affected-suites.ts`)}`,
    `    - claim: ${q(`a regression test selects ${miss.file} for each recorded edge`)}`,
    `      proof: ${q(`grep: ${pattern} in ${SELECTOR_SHADOW_MISS_TEST_PATH}`)}`,
    "",
  ].join("\n");
}

/** The regression test a structural repair must add: its proof greps for the missed file there. */
export function selectorShadowStructuralTestPath(file: string): string {
  return `test/affected-suites-selects-${file.split("/").at(-1)!.replace(/\.test\.ts$/, "")}.test.ts`;
}

/** W1-T4839: a test that missed again after its narrow edge merged. The narrow edges did not hold,
 *  so the task names every edge seen and asks for the selector's rule to be fixed, not one more edge. */
export function selectorShadowStructuralTask(file: string, taskId: string, edges: readonly string[], repairedTaskId: string): string {
  const testPath = selectorShadowStructuralTestPath(file);
  const files = ["src/lib/affected-suites.ts", testPath];
  const q = JSON.stringify;
  return [
    `- id: ${taskId}`,
    `  title: ${q(`FIX THE SELECTOR STRUCTURALLY FOR ${file} — it was missed again after its narrow edge merged`)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    ...machineShardHeaderLines(files),
    `  origin: ${q(selectorShadowStructuralOrigin(file))}`,
    `  files: [${files.join(", ")}]`,
    `  note: ${q(`W1-T4839: ${file} was missed again after ${repairedTaskId} (its narrow edge) merged, so another narrow edge is not the repair. Every edge seen: ${edges.join("; ")}. Find what these edges share and fix the selector's rule for it. Later misses of this suite are ledgered as selector-shadow.miss_evidence rows naming this task; no further task is filed for it.`)}`,
    "  acceptance:",
    `    - claim: ${q(`the selector includes ${file} for every edge seen (${edges.join("; ")}), with a regression test`)}`,
    `      proof: ${q(`grep: ${file.replaceAll(".", "\\.")} in ${testPath}`)}`,
    "",
  ].join("\n");
}

/** W1-T5350 PRIMARY CONTROL: a CI run whose unseen misses span MORE than this many distinct test
 *  files is a mass (or base) failure, not a set of selector misses, and files nothing. Evidence: on
 *  2026-10-02, 44 of the 46 selector-shadow filings came from two CI runs read while main was itself
 *  red (~590 "missed" failures, narrow missRate 0.66 over 24 runs), one one-file PR at a time; 45 of
 *  that day's 118 cancelled main CI runs (38%) followed a selector-shadow push. A genuine missing
 *  selector edge has missed one or two suites per run. Operator decision 2026-10-02: K = 5. */
export const SELECTOR_SHADOW_MASS_FAILURE_FILES = 5;

/** Test files failing in main's own CI at a base sha, or `undefined` when no result is readable. */
export type SelectorShadowMainFailures = (baseSha: string) => readonly string[] | undefined | Promise<readonly string[] | undefined>;

type SelectorShadowPlanTask = { id: string; origin?: string; retirement?: string; status?: string };

/** A home task counts as repaired once its plan status reads merged or done. */
const SELECTOR_SHADOW_REPAIRED_STATUSES = new Set(["merged", "done"]);
/** Changed-path reads (one GitHub compare each) an evidence-only pass may spend on naming edges. */
const SELECTOR_SHADOW_EDGE_READS_PER_PASS = 8;
const SELECTOR_SHADOW_EDGES_KEPT = 40;

/** The daemon checkout's plan, read only when an unseen miss needs a home. */
export function selectorShadowPlanTasks(repoRoot: string): SelectorShadowPlanTask[] {
  return loadPlan(resolveRepoLayout(repoRoot).planMonolith).tasks;
}

/** One `test.flake_retry` ledger row per retried file: the test gardener's retier-flaker input
 *  (W1-T4112), which test-with-retry.mjs writes only into a CI runner's own discarded state. W1-T6406
 *  adds what the flake-incident gardener groups on — the PR, the shas its changed files are read from,
 *  the test titles when the log names them, and whether the retry recovered or also failed. */
export function selectorShadowFlakeLedger(log: GardenerDeps["log"]): SelectorShadowFlakeSink {
  return (runId, flakes, run) => {
    for (const flake of flakes) {
      const outcome = flake.retryOutcome ?? "recovered";
      log("test.flake_retry", {
        file: flake.file, headline: outcome === "recovered" ? "recovered on retry" : "retry also failed",
        ci_run_id: runId, shard: flake.shard, source: "selector-shadow", retry_outcome: outcome,
        ...(run === undefined ? {} : { head_sha: run.headSha }),
        ...(run?.baseSha === undefined ? {} : { base_sha: run.baseSha }),
        ...(run?.prNumber === undefined ? {} : { pr_numbers: [run.prNumber] }),
        ...(flake.titles === undefined ? {} : { titles: flake.titles }),
      });
    }
  };
}

/** The evidence a pass reads once to attribute its observations' misses. */
export interface SelectorShadowAttributionEvidence {
  /** Files a coverage shard's retry recovered in any run of the live window (W1-T4398). */
  recoveredInWindow: ReadonlySet<string>;
  mainFailures?: SelectorShadowMainFailures;
}

/** Stamp each still-charged missed failure the diff did not plausibly cause: retry-recovered in the
 *  window → flake_history, failing on main at the run's base → base_red. Main is read only when a
 *  non-mass run still has a charged miss, through the memoized reader the W1-T5350 guard shares. */
export async function attributeSelectorShadowObservation(
  observation: SelectorShadowObservation, evidence: SelectorShadowAttributionEvidence,
): Promise<SelectorShadowObservation> {
  const charged = (f: SelectorShadowFailure): boolean =>
    (f.floor === "missed" || f.narrow === "missed") && selectorShadowUnattributedReason(f, observation) === undefined;
  if (!observation.failures.some(charged)) return observation;
  let red = new Set<string>();
  const needsBase = observation.failures.some((f) => charged(f) && !evidence.recoveredInWindow.has(f.file));
  if (needsBase && evidence.mainFailures !== undefined && observation.baseSha !== undefined) {
    try {
      red = new Set((await evidence.mainFailures(observation.baseSha)) ?? []);
    } catch {
      // Unread base: the miss stays charged (conservative); withoutMassFailures ledgers base_unread.
      red = new Set();
    }
  }
  const failures = observation.failures.map((f): SelectorShadowFailure => {
    if (!charged(f)) return f;
    if (evidence.recoveredInWindow.has(f.file)) return { ...f, unattributed: "flake_history" };
    return red.has(f.file) ? { ...f, unattributed: "base_red" } : f;
  });
  return { ...observation, failures };
}

/** One main-CI read per base sha per pass: attribution and the W1-T5350 guard share it. */
function memoizedMainFailures(mainFailures: SelectorShadowMainFailures | undefined): SelectorShadowMainFailures | undefined {
  if (mainFailures === undefined) return undefined;
  const reads = new Map<string, Promise<readonly string[] | undefined>>();
  return (baseSha) => {
    let read = reads.get(baseSha);
    if (read === undefined) {
      read = Promise.resolve().then(() => mainFailures(baseSha));
      reads.set(baseSha, read);
    }
    return read;
  };
}

/** W1-T5350: group the unseen misses by CI run. A run whose distinct missed files exceed K, or whose
 *  missed file also fails in main's own CI at the run's base sha, files nothing: one
 *  `selector-shadow.mass_failure_skipped` row names it, and its miss keys are marked seen so the next
 *  pass does not read them as new. A run with no readable base result is judged by K alone. */
async function withoutMassFailures<M extends SelectorShadowMiss>(
  deps: GardenerDeps,
  unseen: readonly M[],
  seen: Set<string>,
  mainFailures: SelectorShadowMainFailures | undefined,
): Promise<M[]> {
  const byRun = new Map<number, M[]>();
  for (const miss of unseen) byRun.set(miss.runId, [...(byRun.get(miss.runId) ?? []), miss]);
  const kept: M[] = [];
  for (const [runId, misses] of byRun) {
    const files = [...new Set(misses.map((m) => m.file))];
    const { headSha, baseSha } = misses[0]!;
    let failingOnMain: string[] = [];
    if (files.length <= SELECTOR_SHADOW_MASS_FAILURE_FILES && mainFailures && baseSha !== undefined) {
      try {
        const red = new Set((await mainFailures(baseSha)) ?? []);
        failingOnMain = files.filter((file) => red.has(file));
      } catch (error) {
        deps.log("selector-shadow.base_unread", { ci_run_id: runId, base_sha: baseSha, error: String((error as Error)?.message ?? error) });
      }
    }
    const reason = files.length > SELECTOR_SHADOW_MASS_FAILURE_FILES ? "mass" : failingOnMain.length > 0 ? "base" : undefined;
    if (reason === undefined) {
      kept.push(...misses);
      continue;
    }
    for (const miss of misses) seen.add(selectorShadowMissKey(miss));
    deps.log("selector-shadow.mass_failure_skipped", {
      ci_run_id: runId, head_sha: headSha, files: files.length, reason, k: SELECTOR_SHADOW_MASS_FAILURE_FILES,
      ...(reason === "base" ? { failing_on_main: failingOnMain } : {}),
    });
  }
  return kept;
}

/** Report every pass. A missed TEST is the unit (W1-T4839): a miss whose suite already has a task is
 *  ledgered as evidence for it, whatever edge it names. A suite missed again AFTER its narrow task
 *  merged is filed once more as a structural task naming every edge seen, and never again. At most
 *  one new task files per pass, so the daemon cannot flood the plan, and a mass- or base-failure run files
 *  nothing (W1-T5350; `mainFailures` reads main's CI at a run's base sha). The shared gardener seam carries
 *  state, checkout, workspace and log; the reads are this gardener's own inputs, passed beside it
 *  rather than declared as another seam shape. `isRepaired` overrides the default repair test (the
 *  home task's plan status is merged/done, or src/lib/affected-suites.ts already names the suite). */
export async function runSelectorShadowGardener(
  deps: GardenerDeps,
  readRuns: () => SelectorShadowRun[],
  readChangedPaths: (miss: SelectorShadowMiss) => string[] | Promise<string[]>,
  mintTaskId: SelectorShadowTaskIdMinter,
  planTasks: () => SelectorShadowPlanTask[] | Promise<SelectorShadowPlanTask[]> = () => selectorShadowPlanTasksAsync(deps.repoRoot),
  isRepaired?: (homeTaskId: string, file: string) => boolean,
  mainFailures?: SelectorShadowMainFailures,
  options: { replay?: SelectorShadowReplay } = {},
): Promise<SelectorShadowAccumulatedReport> {
  const path = join(deps.stateDir, "selector-shadow-gardener.json");
  const stored = readFileIfExists(path);
  const prior = stored === undefined ? {} : JSON.parse(stored) as {
    filedKeys?: string[]; causes?: Record<string, string>; edges?: Record<string, string[]>; structural?: Record<string, string>;
  };
  if (prior.filedKeys !== undefined && !Array.isArray(prior.filedKeys)) throw new Error("selector shadow: invalid filed-keys state");
  const seen = new Set(prior.filedKeys ?? []);
  const causes: Record<string, string> = { ...(prior.causes ?? {}) };
  const edges: Record<string, string[]> = { ...(prior.edges ?? {}) };
  const structural: Record<string, string> = { ...(prior.structural ?? {}) };
  const noteEdge = (file: string, edge: string): void => {
    const held = edges[file] ?? [];
    if (!held.includes(edge)) edges[file] = [...held, edge].slice(-SELECTOR_SHADOW_EDGES_KEPT);
  };
  const runs = readRuns();
  const main = memoizedMainFailures(mainFailures);
  const evidence: SelectorShadowAttributionEvidence = {
    recoveredInWindow: new Set(runs.flatMap((run) => selectorShadowRecoveredFlakes(run.log).map((flake) => flake.file))),
    ...(main === undefined ? {} : { mainFailures: main }),
  };
  const attribute = (observation: SelectorShadowObservation) => attributeSelectorShadowObservation(observation, evidence);
  const readings: SelectorShadowReading[] = [];
  for (const run of runs) {
    const reading = selectorShadowReading(run);
    readings.push(reading.kind === "complete" ? { kind: "complete", observation: await attribute(reading.observation) } : reading);
  }
  const report = selectorShadowWindowReport(readings,
    await selectorShadowFullSuiteSizeAsync(deps.repoRoot, join(deps.stateDir, "selector-shadow-suite-size.json")));
  // W1-T5925: the verdict folds every stored observation; filing below still reads this window's misses.
  const accumulated = await accumulateSelectorShadow(deps, readings, report, options.replay, attribute);
  deps.log("selector-shadow.report", {
    ...accumulated, misses: accumulated.misses.slice(0, 20),
    unattributed: { ...accumulated.unattributed, misses: accumulated.unattributed.misses.slice(0, 20) },
  });
  // The W1-T5350 guard still sees every unseen miss, so a mass or base run is skipped whole as before;
  // an unattributed miss it keeps is ledgered with its reason and never files a repair shard.
  const candidates = [...report.misses, ...report.unattributed.misses].filter((m) => !seen.has(selectorShadowMissKey(m)));
  const unseen: SelectorShadowMiss[] = [];
  for (const miss of await withoutMassFailures(deps, candidates, seen, main)) {
    if (!("reason" in miss)) {
      unseen.push(miss);
      continue;
    }
    seen.add(selectorShadowMissKey(miss));
    deps.log("selector-shadow.miss_unattributed", {
      ci_run_id: miss.runId, head_sha: miss.headSha, file: miss.file, selection: miss.selection, reason: miss.reason,
      ...(miss.prNumber === undefined ? {} : { pr: miss.prNumber }),
    });
  }
  // The plan is read only when there is something new to place, never on an idle pass.
  const planned = new Map<string, { id: string; retired: boolean; structural: boolean }>();
  const statusOf = new Map<string, string | undefined>();
  if (unseen.length > 0) {
    for (const task of await planTasks()) {
      statusOf.set(task.id, task.status);
      const file = selectorShadowCauseOf(task.origin);
      if (file === undefined) continue;
      const isStructural = task.origin?.startsWith("selector-shadow-structural:") === true;
      const held = planned.get(file);
      const better = !held || (isStructural && !held.structural) ||
        (!isStructural && !held.structural && held.retired && task.retirement === undefined);
      if (better) planned.set(file, { id: task.id, retired: task.retirement !== undefined, structural: isStructural });
      if (isStructural) structural[file] ??= task.id;
    }
  }
  const repaired = (home: string, file: string): boolean => {
    if (isRepaired) return isRepaired(home, file);
    const status = statusOf.get(home);
    if (status !== undefined && SELECTOR_SHADOW_REPAIRED_STATUSES.has(status)) return true;
    return (readFileIfExists(join(deps.repoRoot, "src", "lib", "affected-suites.ts")) ?? "").includes(file);
  };
  const edgeOf = (miss: SelectorShadowMiss, paths: readonly string[]): string =>
    `${paths.length ? paths.join(", ") : miss.headSha} -> ${miss.file}`;
  /** Land one plan-task file for a miss, returning the PR url and the id minted for it. */
  const land = async (miss: SelectorShadowMiss, build: (taskId: string) => { contents: string; title: string; body: (relativePath: string) => string }) => {
    const workspace = await deps.openWorkspace();
    try {
      if (!workspace.branch) throw new Error("selector shadow: filing workspace has no branch for task-id reservation");
      const taskId = await (mintTaskId.async ?? mintTaskId)(workspace.branch);
      const name = `${taskId.toLowerCase()}-selector-shadow-miss.yaml`;
      const relativePath = join("plan", "tasks.d", name);
      const made = build(taskId);
      const task = loadPlanFromYaml(made.contents, name).tasks[0];
      const lint = lintTask(task);
      if (!lint.ok) throw new Error(`selector shadow: missed-edge task failed lint: ${lint.violations.map((v) => v.check).join(", ")}`);
      writeAtomic(join(workspace.root, relativePath), made.contents);
      const prUrl = await workspace.land({ paths: [relativePath], title: made.title, body: made.body(relativePath) });
      if (!prUrl) throw new Error("selector shadow: task PR was not opened");
      return { taskId, prUrl };
    } finally {
      await workspace.dispose();
    }
  };
  let filedThisPass = false;
  let edgeReads = 0;
  for (const miss of unseen) {
    const key = selectorShadowMissKey(miss);
    const plannedHome = planned.get(miss.file);
    const home = structural[miss.file] ?? causes[miss.file] ?? plannedHome?.id;
    // A suite that already has its one structural task only ever gains evidence.
    const escalate = home !== undefined && structural[miss.file] === undefined && plannedHome?.structural !== true &&
      plannedHome?.retired !== true && repaired(home, miss.file);
    if (home !== undefined && !escalate) {
      let paths: string[] = [];
      if (edgeReads < SELECTOR_SHADOW_EDGE_READS_PER_PASS) {
        edgeReads++;
        try {
          paths = await readChangedPaths(miss);
        } catch (error) {
          deps.log("selector-shadow.edge_unread", { file: miss.file, head_sha: miss.headSha, error: String((error as Error)?.message ?? error) });
        }
      }
      noteEdge(miss.file, edgeOf(miss, paths));
      seen.add(key);
      causes[miss.file] = home;
      deps.log("selector-shadow.miss_evidence", {
        task_id: home, file: miss.file, selection: miss.selection, ci_run_id: miss.runId, head_sha: miss.headSha,
        ...(miss.prNumber === undefined ? {} : { pr: miss.prNumber }),
        ...(plannedHome?.retired && plannedHome.id === home ? { task_retired: true } : {}),
      });
      continue;
    }
    if (filedThisPass) continue;
    filedThisPass = true;
    const changedPaths = await readChangedPaths(miss);
    const edge = edgeOf(miss, changedPaths);
    if (escalate) {
      noteEdge(miss.file, edge);
      const every = edges[miss.file]!;
      const filed = await land(miss, (taskId) => ({
        contents: selectorShadowStructuralTask(miss.file, taskId, every, home),
        title: `fix(selector): file structural repair for ${miss.file.split("/").at(-1)}`,
        body: (relativePath) => `${miss.file} was missed again (run ${miss.runId}: ${edge}) after ${home} merged its narrow edge, so this files ONE structural selector task naming every edge seen: ${every.join("; ")}.\n\nThe task is parked for review; later misses of this suite are ledgered as evidence, not filed.\n\n## Acceptance\n\n- claim: the structural repair is recorded as a parked task\n  proof: grep: ${selectorShadowStructuralOrigin(miss.file).replaceAll(".", "\\.")} in ${relativePath}`,
      }));
      seen.add(key);
      causes[miss.file] = filed.taskId;
      structural[miss.file] = filed.taskId;
      deps.log("selector-shadow.structural_filed", { task_id: filed.taskId, pr_url: filed.prUrl, repaired_task_id: home, file: miss.file, edges: every });
      continue;
    }
    const filed = await land(miss, (taskId) => ({
      contents: selectorShadowMissTask(miss, taskId, changedPaths),
      title: `fix(selector): file missed ${miss.selection} edge for ${miss.file.split("/").at(-1)}`,
      body: (relativePath) => `The W1-T4439 shadow record observed ${miss.selection} miss on run ${miss.runId}: ${edge}.\n\nThe task is parked for review; W1-T4406 remains gated.\n\n## Acceptance\n\n- claim: the missed selector edge is recorded as a parked task\n  proof: grep: ${selectorShadowCauseOrigin(miss.file).replaceAll(".", "\\.")} in ${relativePath}`,
    }));
    seen.add(key);
    causes[miss.file] = filed.taskId;
    noteEdge(miss.file, edge);
    deps.log("selector-shadow.miss_filed", { task_id: filed.taskId, pr_url: filed.prUrl, edge });
  }
  writeAtomic(path, JSON.stringify({ filedKeys: [...seen], causes, edges, structural, report: accumulated }) + "\n");
  return accumulated;
}

/** Run immediately, then on the daemon interval; one pass at a time. */
export function startSelectorShadowGardener(
  deps: GardenerDeps,
  readRuns: () => SelectorShadowRun[] | Promise<SelectorShadowRun[]>,
  readChangedPaths: (miss: SelectorShadowMiss) => string[] | Promise<string[]>,
  mintTaskId: SelectorShadowTaskIdMinter,
  intervalMs: number,
  planTasks?: () => SelectorShadowPlanTask[] | Promise<SelectorShadowPlanTask[]>,
  isRepaired?: (homeTaskId: string, file: string) => boolean,
): { stop: () => void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const runs = await readRuns();
      await runSelectorShadowGardener(deps, () => runs, readChangedPaths, mintTaskId, planTasks, isRepaired);
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
