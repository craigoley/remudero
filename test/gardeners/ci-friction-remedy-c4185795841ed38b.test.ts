/**
 * W1-T10217 — check:mutation-ratchet cost 98.2 PR minutes in 12 fix rounds; the recent three
 * (#12776, 2026-10-18) were "timed out with no test result".
 *
 * CAUSE, read from the job logs: every PR's first mutation-ratchet run is a COLD Stryker run. Its
 * incremental cache is saved on the PR's own ref ("Cache not found for input keys: mutation-
 * incremental-…" opens all seven runs below), and a run cancelled at the job's ceiling saves nothing,
 * so every re-run of that head starts cold again and is cancelled again. The 10-minute ceiling held
 * the two cold runs that finished (7m56s, 9m38s) and cut off all five later ones at 43-84% of 367
 * mutants: a fix round cannot change that outcome, and nothing about the ratchet itself failed.
 *
 * REMEDY: the job's ceiling holds a cold run, derived below from those runs. The ratchet, its
 * baseline and its mutant set are untouched.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { repoRoot } from "#test/helpers/repo-root.js";

/** One measured cold Stryker run of the mutation-ratchet job (GitHub Actions job id), from its log:
 *  `preSeconds` job start → "Initial test run succeeded"; `mutationSeconds` from there to the last
 *  "Mutation testing" progress line (or "Done in" for a finished run); `tested`/`total` from that line. */
interface ColdRun {
  readonly job: number;
  readonly head: string;
  readonly finished: boolean;
  readonly preSeconds: number;
  readonly mutationSeconds: number;
  readonly tested: number;
  readonly total: number;
}

const COLD_RUNS: readonly ColdRun[] = [
  { job: 117544535379, head: "f58c5af06", finished: true, preSeconds: 34.1, mutationSeconds: 445, tested: 358, total: 358 },
  { job: 117552285471, head: "61bfd7649", finished: true, preSeconds: 36.0, mutationSeconds: 548, tested: 342, total: 342 },
  { job: 117696548316, head: "f6e521919", finished: false, preSeconds: 37.6, mutationSeconds: 570.1, tested: 310, total: 367 },
  { job: 117704770417, head: "f6e521919", finished: false, preSeconds: 43.9, mutationSeconds: 560.1, tested: 231, total: 367 },
  { job: 117762125354, head: "04ba63933", finished: false, preSeconds: 45.3, mutationSeconds: 560.1, tested: 158, total: 367 },
  { job: 117784555547, head: "aa9df30aa", finished: false, preSeconds: 41.2, mutationSeconds: 570.2, tested: 162, total: 367 },
  { job: 117797177363, head: "aa9df30aa", finished: false, preSeconds: 39.1, mutationSeconds: 570.1, tested: 224, total: 367 },
];

/** The seconds a whole cold job needs at that run's own per-mutant pace. */
const projectedJobSeconds = (r: ColdRun): number => r.preSeconds + (r.mutationSeconds / r.tested) * r.total;

/** The runner-to-runner pace spread on ONE head: the same code tested at different speeds. */
function sameHeadPaceSpread(runs: readonly ColdRun[]): number {
  let spread = 1;
  for (const head of new Set(runs.map((r) => r.head))) {
    const paces = runs.filter((r) => r.head === head).map((r) => r.mutationSeconds / r.tested);
    if (paces.length > 1) spread = Math.max(spread, Math.max(...paces) / Math.min(...paces));
  }
  return spread;
}

function ciJobs(): Record<string, { "timeout-minutes"?: number; if?: string; steps?: Array<{ run?: string; uses?: string }> }> {
  return (parseYaml(readFileSync(join(repoRoot(), ".github", "workflows", "ci.yml"), "utf8")) as { jobs: never }).jobs;
}

function waitCapSeconds(): number {
  const gate = parseYaml(readFileSync(join(repoRoot(), ".github", "workflows", "ci-gate.yml"), "utf8")) as {
    jobs: Record<string, { env?: Record<string, string> }>;
  };
  return Number(gate.jobs["ci-gate"]?.env?.WAIT_CAP_SECONDS);
}

test("W1-T10217: check:mutation-ratchet is prevented, not retried", () => {
  // The evidence is the bound: a scan that read no runs, or no cancelled one, proves nothing.
  assert.ok(COLD_RUNS.length >= 2 && COLD_RUNS.some((r) => !r.finished), "the bound needs measured cold runs, cancelled ones included");
  const worst = Math.max(...COLD_RUNS.map(projectedJobSeconds));
  const spread = sameHeadPaceSpread(COLD_RUNS);
  assert.ok(spread > 1, "two runs of one head must show the runner's own pace spread");
  const needSeconds = worst * spread;

  const job = ciJobs()["mutation-ratchet"];
  assert.ok(job, "ci.yml must declare the mutation-ratchet job");
  assert.ok(job.steps?.some((s) => /\bnpx stryker run\b/.test(s.run ?? "")), "the job must still run Stryker");
  const minutes = job["timeout-minutes"];
  assert.equal(typeof minutes, "number", "mutation-ratchet must bound its own runtime");
  assert.ok(
    minutes! * 60 >= needSeconds,
    `mutation-ratchet's ${minutes}m ceiling cancels a cold Stryker run: the slowest measured cold run projects to ` +
      `${(worst / 60).toFixed(1)}m and one head's runs differ ${spread.toFixed(2)}x in pace, so it needs ` +
      `${(needSeconds / 60).toFixed(1)}m — a cancelled run saves no incremental cache, so every re-run is cancelled again`,
  );
  const cap = waitCapSeconds();
  assert.ok(Number.isFinite(cap) && minutes! * 60 < cap, `mutation-ratchet (${minutes}m) must stay below ci-gate's WAIT_CAP_SECONDS (${cap}s)`);
});

test("W1-T10217: every cancelled cold run was cut off by the old 10-minute ceiling, not finished by it", () => {
  for (const r of COLD_RUNS.filter((run) => !run.finished)) {
    assert.ok(r.tested < r.total, `job ${r.job} is recorded cancelled, so it tested fewer than all mutants`);
    assert.ok(projectedJobSeconds(r) > 10 * 60, `job ${r.job} projects past the old 10-minute ceiling`);
  }
  for (const r of COLD_RUNS.filter((run) => run.finished)) {
    assert.equal(r.tested, r.total, `job ${r.job} finished, so it tested every mutant`);
    assert.ok(projectedJobSeconds(r) < 10 * 60, `job ${r.job} finished inside the old ceiling`);
  }
});
