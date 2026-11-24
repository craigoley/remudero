import { isDeepStrictEqual } from "node:util";
import { saveCodeHealthCoverageSource } from "./code-health-store.js";
import { validateCodeHealthProvenance } from "./code-health-projection.js";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { writeAtomicAsync } from "./fs-race-safe.js";
import { ghJsonAsync, ghTextAsync } from "./github-transport.js";
import { appendLedger } from "./ledger.js";
import { openLedgerUnion } from "./ledger-union.js";
import { PINNING_IMPACT_MAP_FILE } from "./pinning-tests.js";
import { readImpactMap } from "./test-impact-map.js";
import { withTempDir } from "./tmp.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

export const COVERAGE_NIGHTLY_MEASURED_STEP = "coverage_nightly.measured";
export const COVERAGE_NIGHTLY_IMPACT_MAP_STEP = "coverage_nightly.impact_map";
export const IMPACT_MAP_RUN_RECORD_FILE = "test-impact-map.run.json";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CoverageNightlyRun {
  id: number;
  head_sha: string;
  head_branch: string;
  status: string;
  conclusion: string;
}

export interface CoverageNightlyReader {
  newestCompletedRun(owner: string, repo: string): Promise<CoverageNightlyRun | undefined>;
  summaryForRun(owner: string, repo: string, run: CoverageNightlyRun): Promise<unknown>;
  /** Downloads the run's test-impact-map artifact into `dir`; absent, no map is refreshed. */
  impactMapForRun?(owner: string, repo: string, run: CoverageNightlyRun, dir: string): Promise<"downloaded" | "no-artifact">;
}

function completedMainRun(value: unknown): CoverageNightlyRun {
  const run = value as CoverageNightlyRun | undefined;
  if (!run || !Number.isSafeInteger(run.id) || run.id <= 0 || run.status !== "completed" ||
      run.head_branch !== "main" || typeof run.head_sha !== "string" || !run.head_sha ||
      typeof run.conclusion !== "string" || !run.conclusion) {
    throw new Error("coverage-nightly run is not a completed main run with a conclusion and head sha");
  }
  return run;
}

export function coverageNightlyGithubReader(
  deps: Partial<Pick<typeof import("./github-transport.js"), "ghJsonAsync" | "ghTextAsync">> = {},
): CoverageNightlyReader {
  return {
    async newestCompletedRun(owner, repo) {
      const payload = await (deps.ghJsonAsync ?? ghJsonAsync)([
        "api", `repos/${owner}/${repo}/actions/workflows/coverage-nightly.yml/runs?branch=main&status=completed&per_page=1`,
      ]) as { workflow_runs?: unknown[] } | null;
      if (payload === null) throw new Error("coverage-nightly workflow run response is null");
      if (!Array.isArray(payload.workflow_runs)) throw new Error("coverage-nightly workflow run list is unreadable");
      return payload.workflow_runs.length === 0 ? undefined : completedMainRun(payload.workflow_runs[0]);
    },
    async summaryForRun(owner, repo, run) {
      return withTempDir("coverage-nightly", async (dir) => {
        await (deps.ghTextAsync ?? ghTextAsync)([
          "run", "download", String(run.id), "--repo", `${owner}/${repo}`,
          "--name", "coverage-nightly", "--dir", dir,
        ]);
        return JSON.parse(readFileSync(join(dir, "coverage-nightly-summary.json"), "utf8"));
      });
    },
    async impactMapForRun(owner, repo, run, dir) {
      try {
        await (deps.ghTextAsync ?? ghTextAsync)([
          "run", "download", String(run.id), "--repo", `${owner}/${repo}`,
          "--name", "test-impact-map", "--dir", dir,
        ]);
        return "downloaded";
      } catch (error) {
        const detail = `${error instanceof Error ? error.message : String(error)} ${String((error as { stderr?: unknown }).stderr ?? "")}`;
        if (/no valid artifacts found|no artifact matches/i.test(detail)) return "no-artifact";
        throw error;
      }
    },
  };
}

function validatedSummary(value: unknown, run: CoverageNightlyRun, repository: string): Record<string, unknown> {
  const s = value as Record<string, unknown> | null;
  if (!s || s.kind !== COVERAGE_NIGHTLY_MEASURED_STEP || s.run_id !== String(run.id) ||
      s.sha !== run.head_sha || s.ref !== "refs/heads/main" ||
      typeof s.measured_at !== "string" || !Number.isFinite(Date.parse(s.measured_at))) {
    throw new Error("coverage-nightly summary identity does not match the selected run");
  }
  for (const key of ["lines_pct", "branches_pct"]) {
    if (typeof s[key] !== "number" || !Number.isFinite(s[key]) || s[key] < 0 || s[key] > 100) {
      throw new Error(`coverage-nightly summary has invalid ${key}`);
    }
  }
  for (const key of ["lf", "lh", "brf", "brh", "skipped_records"]) {
    if (typeof s[key] !== "number" || !Number.isSafeInteger(s[key]) || s[key] < 0) {
      throw new Error(`coverage-nightly summary has invalid ${key}`);
    }
  }
  if ((s.lh as number) > (s.lf as number) || (s.brh as number) > (s.brf as number) ||
      !["healthy", "improve", "remediate"].includes(String(s.tier)) ||
      !s.shard_test_exits || typeof s.shard_test_exits !== "object" || Array.isArray(s.shard_test_exits) ||
      Object.values(s.shard_test_exits).some((exit) => !Number.isInteger(exit) || exit < 0)) {
    throw new Error("coverage-nightly summary has invalid totals, tier or shard exits");
  }
  const provenance = s.code_health === undefined ? undefined : validateCodeHealthProvenance(s.code_health, {
    repository, analyzedSha: run.head_sha, runId: String(run.id), kind: "coverage",
  });
  if (provenance && (!provenance.measurement || provenance.measurement.branches.covered !== s.brh || provenance.measurement.branches.total !== s.brf ||
      provenance.measurement.lines.covered !== s.lh || provenance.measurement.lines.total !== s.lf)) throw new Error("coverage-nightly provenance totals do not match the original summary");
  if (provenance && provenance.observedAt !== s.measured_at) throw new Error("coverage-nightly provenance clock does not match the original measurement");
  return { ...(provenance ? { code_health: provenance } : {}), ...Object.fromEntries([
    "kind", "sha", "ref", "measured_at", "lines_pct", "branches_pct", "lf", "lh", "brf", "brh",
    "skipped_records", "tier", "shard_test_exits",
  ].map((key) => [key, s[key]])) };
}

export type ImpactMapRefreshResult =
  | { outcome: "refreshed"; map_sha: string; bytes: number }
  | { outcome: "unchanged" }
  | { outcome: "no-artifact" | "invalid" | "failed"; reason: string };

async function recordedRunId(path: string): Promise<unknown> {
  try {
    return (JSON.parse(await readFile(path, "utf8")) as { run_id?: unknown } | null)?.run_id;
  } catch {
    return undefined; // An absent or unreadable run record only means this run is downloaded again.
  }
}

async function refreshImpactMapFile(opts: {
  owner: string; repo: string; run: CoverageNightlyRun; reader: Required<Pick<CoverageNightlyReader, "impactMapForRun">>;
  checkoutRoot: string; clock: Clock;
}): Promise<ImpactMapRefreshResult> {
  const { run } = opts;
  const commonDir = resolve(opts.checkoutRoot, (await hostWorktreeGitAsync(opts.checkoutRoot, ["rev-parse", "--git-common-dir"])).trim());
  const target = join(commonDir, PINNING_IMPACT_MAP_FILE);
  const recordPath = join(dirname(target), IMPACT_MAP_RUN_RECORD_FILE);
  if (await recordedRunId(recordPath) === String(run.id)) return { outcome: "unchanged" };
  const recordRun = (): Promise<void> => writeAtomicAsync(recordPath,
    `${JSON.stringify({ run_id: String(run.id), sha: run.head_sha, refreshed_at: opts.clock.iso() })}\n`);
  return withTempDir("test-impact-map", async (dir): Promise<ImpactMapRefreshResult> => {
    let got: "downloaded" | "no-artifact";
    try {
      got = await opts.reader.impactMapForRun(opts.owner, opts.repo, run, dir);
    } catch (error) {
      return { outcome: "failed", reason: `download failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (got === "no-artifact") {
      await recordRun();
      return { outcome: "no-artifact", reason: `run ${run.id} has no test-impact-map artifact` };
    }
    const staged = join(dir, "test-impact-map.json");
    const read = await readFile(staged).then((bytes) => ({ bytes }), (error: unknown) => ({ error }));
    const { map, problem } = readImpactMap(staged, () => {
      if ("error" in read) throw read.error;
      return read.bytes.toString("utf8");
    });
    if (!map || "error" in read) {
      await recordRun();
      return { outcome: "invalid", reason: problem ?? "impact map unreadable" };
    }
    if (map.sha !== run.head_sha) {
      await recordRun();
      return { outcome: "invalid", reason: `impact map sha ${map.sha} is not the run's head sha ${run.head_sha}` };
    }
    await writeAtomicAsync(target, read.bytes);
    await recordRun();
    return { outcome: "refreshed", map_sha: map.sha, bytes: read.bytes.length };
  });
}

/** One refresh of the test impact map from `run`; appends one coverage_nightly.impact_map row and never throws. */
export async function refreshTestImpactMap(opts: {
  ledgerPath: string; owner: string; repo: string; run: CoverageNightlyRun;
  reader: Required<Pick<CoverageNightlyReader, "impactMapForRun">>;
  checkoutRoot?: string; clock?: Clock; log?(line: string): void;
}): Promise<ImpactMapRefreshResult> {
  const clock = opts.clock ?? systemClock;
  let result: ImpactMapRefreshResult;
  try {
    result = await refreshImpactMapFile({ ...opts, checkoutRoot: opts.checkoutRoot ?? process.cwd(), clock });
  } catch (error) {
    result = { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    appendLedger(opts.ledgerPath, {
      step: COVERAGE_NIGHTLY_IMPACT_MAP_STEP, task_id: "coverage-nightly", repository: `${opts.owner}/${opts.repo}`,
      run_id: String(opts.run.id), head_sha: opts.run.head_sha, ...result,
    }, { clock });
  } catch (error) {
    (opts.log ?? ((line: string) => console.error(line)))(`coverage-nightly impact map row was not written: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

let runningImpactMapRefresh: Promise<void> | undefined;

function startImpactMapRefresh(opts: Omit<Parameters<typeof refreshTestImpactMap>[0], "reader"> & { reader: CoverageNightlyReader }): Promise<void> | undefined {
  const { reader } = opts;
  if (runningImpactMapRefresh !== undefined || reader.impactMapForRun === undefined) return undefined;
  const impactMapForRun = reader.impactMapForRun.bind(reader);
  runningImpactMapRefresh = refreshTestImpactMap({ ...opts, reader: { impactMapForRun } })
    .then(() => undefined, (error: unknown) => (opts.log ?? console.error)(`coverage-nightly impact map refresh failed: ${String(error)}`))
    .finally(() => { runningImpactMapRefresh = undefined; });
  return runningImpactMapRefresh;
}

export type CoverageNightlyIntakeResult =
  | { status: "appended" | "duplicate"; runId: string }
  | { status: "not-due" | "failed"; reason: string }
  | { status: "no-run" };

export async function readCoverageNightlySummary(opts: {
  ledgerPath: string;
  owner: string;
  repo: string;
  cadence: {
    check(markerPath: string, now: Date): { fire: boolean; reason: string };
    record(markerPath: string, at: Date, windowMs: number): unknown;
  };
  clock?: Clock;
  reader?: CoverageNightlyReader;
  /** The checkout whose git common dir holds the test impact map; default the process cwd. */
  checkoutRoot?: string;
  log?(line: string): void;
}): Promise<CoverageNightlyIntakeResult> {
  const clock = opts.clock ?? systemClock;
  const stateDir = dirname(opts.ledgerPath);
  const markerPath = join(stateDir, "last-coverage-nightly-intake.json");
  const log = opts.log ?? ((line: string) => console.error(line));
  const saveSource = (summary: Record<string, unknown>): void => {
    if (summary.code_health === undefined) return;
    const saved = saveCodeHealthCoverageSource({ stateDir, repository: `${opts.owner}/${opts.repo}`, provenance: summary.code_health, clock });
    if ("reason" in saved) log(`Code health coverage evidence was not saved: ${saved.reason}`);
  };
  try {
    const decision = opts.cadence.check(markerPath, clock.date());
    if (!decision.fire) return { status: "not-due", reason: decision.reason };
    // Stamp attempts before reading, including failures, so retries wait for the next daily cadence.
    opts.cadence.record(markerPath, clock.date(), DAY_MS);
    const reader = opts.reader ?? coverageNightlyGithubReader();
    const candidate = await reader.newestCompletedRun(opts.owner, opts.repo);
    if (candidate === undefined) return { status: "no-run" };
    const run = completedMainRun(candidate);
    void startImpactMapRefresh({ ledgerPath: opts.ledgerPath, owner: opts.owner, repo: opts.repo, run, reader, checkoutRoot: opts.checkoutRoot, clock, log });
    const runId = String(run.id);
    const repository = `${opts.owner}/${opts.repo}`;
    let incomplete = false;
    let duplicate = false, duplicateSummary: Record<string, unknown> | undefined;
    for await (const row of openLedgerUnion(stateDir, {
      step: COVERAGE_NIGHTLY_MEASURED_STEP, dedupe: false,
      onUnreadArchive: () => { incomplete = true; },
      onUnreadLive: () => { incomplete = true; },
      onMalformedRow: () => { incomplete = true; },
    })) {
      if (row.kind === COVERAGE_NIGHTLY_MEASURED_STEP && row.repository === repository && row.run_id === runId) {
        duplicate = true;
        if (row.code_health !== undefined) {
          const measured = validatedSummary(row, run, repository);
          if (duplicateSummary !== undefined && !isDeepStrictEqual(duplicateSummary, measured)) throw new Error("coverage-nightly ledger contains conflicting source evidence for one run");
          duplicateSummary = measured;
        }
      }
    }
    if (incomplete) throw new Error("coverage-nightly dedup ledger union is incomplete or malformed");
    if (duplicate) {
      if (duplicateSummary !== undefined) saveSource(duplicateSummary);
      return { status: "duplicate", runId };
    }
    const summary = validatedSummary(await reader.summaryForRun(opts.owner, opts.repo, run), run, repository);
    appendLedger(opts.ledgerPath, {
      ...summary, step: COVERAGE_NIGHTLY_MEASURED_STEP, task_id: "coverage-nightly",
      run_id: runId, head_sha: run.head_sha, conclusion: run.conclusion, repository,
    }, { clock });
    saveSource(summary);
    return { status: "appended", runId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`coverage-nightly intake failed: ${reason}`);
    return { status: "failed", reason };
  }
}
