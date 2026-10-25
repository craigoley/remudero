import { isDeepStrictEqual } from "node:util";
import { saveCodeHealthCoverageSource } from "./code-health-store.js";
import { validateCodeHealthProvenance } from "./code-health-projection.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { ghJsonAsync, ghTextAsync } from "./github-transport.js";
import { appendLedger } from "./ledger.js";
import { openLedgerUnion } from "./ledger-union.js";
import { withTempDir } from "./tmp.js";

export const COVERAGE_NIGHTLY_MEASURED_STEP = "coverage_nightly.measured";
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
  log?(line: string): void;
}): Promise<CoverageNightlyIntakeResult> {
  const clock = opts.clock ?? systemClock;
  const stateDir = dirname(opts.ledgerPath);
  const markerPath = join(stateDir, "last-coverage-nightly-intake.json");
  const log = opts.log ?? ((line: string) => console.error(line));
  const saveSource = (summary: Record<string, unknown>): void => {
    if (summary.code_health === undefined) return;
    const saved = saveCodeHealthCoverageSource({ stateDir, repository: `${opts.owner}/${opts.repo}`, provenance: summary.code_health, clock });
    if (saved.state !== "published" && saved.state !== "duplicate") log(`Code health coverage evidence was not saved: ${saved.reason}`);
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
