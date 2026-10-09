// W1-T5409: W1-T5350 gave the selector-shadow mass-failure guard a `mainFailures(baseSha)` reader seam,
// but the daemon's own selector-shadow pass passed none, so a run whose misses also fail on main
// filed them whenever they stayed under K = 5. These tests build that production pass over a
// stubbed GitHub (the PR run list, main's CI run at the base sha, its job list and job logs).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Namespace imports: the pass and the reader are new, so this suite still loads (and fails) at the base sha.
import * as registry from "../src/lib/garden-registry.js";
import * as gardener from "../src/lib/selector-shadow-gardener.js";
import { clockFromMillisFn, systemClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const RED = ["test/red-on-main-a.test.ts", "test/red-on-main-b.test.ts"];

/** The cached evidence lines of a complete PR run whose shard 1 failed every file in `missed`, all missed by narrow. */
function prRunLog(missed: readonly string[]): string {
  const record = { fullRun: false, floorSize: 1, narrowSize: 0, failures: missed.map((file) => ({ file, floor: "selected", narrow: "missed" })) };
  return Array.from({ length: gardener.SELECTOR_SHADOW_SHARDS }, (_, shard) =>
    `coverage-shard (${shard + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify(shard === 0 ? record : { ...record, failures: [] })}\n` +
    `coverage-shard (${shard + 1}/8)\tSELECTOR-SHADOW-JOB: conclusion=${shard === 0 ? "failure" : "success"}`,
  ).join("\n");
}

/** Main's eight test shards for one run; shard 3 failed with `failed` named by test-with-retry's own line. */
function mainJobs(runId: number) {
  return {
    total_count: 9,
    jobs: [
      { id: runId * 10, name: "commitlint", status: "completed", conclusion: "success" },
      ...Array.from({ length: 8 }, (_, i) => ({ id: runId * 10 + i + 1, name: `ci-shard (${i + 1}/8)`, status: "completed", conclusion: i === 2 ? "failure" : "success" })),
    ],
  };
}

function harness(main: { conclusion: string; failed?: readonly string[] }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-main-red-`));
  // The filing checkout holds the files a narrow edge declares, as main does: lint-plan's admission reads them.
  for (const owner of ["src/lib/affected-suites.ts", gardener.SELECTOR_SHADOW_MISS_TEST_PATH]) {
    mkdirSync(join(root, owner, ".."), { recursive: true });
    writeFileSync(join(root, owner), "// fixture\n");
  }
  for (const dir of ["test", "state", join("plan", "tasks.d")]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const nowMs = systemClock.now();
  // The PR run's evidence is already in the daemon's log cache, as it is after the pass that first read it.
  writeFileSync(join(root, "state", "selector-shadow-log-cache.json"), JSON.stringify({
    "8001": { headSha: "head-8001", log: prRunLog(RED), fetchedAt: nowMs, complete: true, readerVersion: gardener.SELECTOR_SHADOW_READER_VERSION },
  }));
  const reads: string[] = [];
  const landed: string[] = [];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const readJson = async (args: string[]): Promise<unknown> => {
    const url = args[1]!;
    reads.push(url);
    if (url.includes("runs?event=pull_request")) {
      return { workflow_runs: [{ id: 8001, head_sha: "head-8001", status: "completed", conclusion: "failure",
        created_at: clockFromMillisFn(() => nowMs).iso(), pull_requests: [{ number: 8001, base: { sha: "base-sha" } }] }] };
    }
    if (url.includes("runs?branch=main")) return { workflow_runs: [{ id: 9001, status: "completed", conclusion: main.conclusion }] };
    if (url.endsWith("runs/9001/jobs?per_page=100")) return mainJobs(9001);
    if (url.includes("/compare/")) return { files: [{ filename: "src/lib/changed.ts" }] };
    throw new Error(`unexpected read ${url}`);
  };
  const readText = async (args: string[]): Promise<string> => {
    reads.push(args[1]!);
    return [
      "2026-10-02T12:00:00.0000000Z not ok 4 - a red test",
      `2026-10-02T12:00:01.0000000Z FLAKE-RETRY-FILES: retrying ${main.failed?.length ?? 0} failed file(s) — ${(main.failed ?? []).join(", ")}`,
    ].join("\n");
  };
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: () => ({
      root,
      branch: "selector-shadow-garden-test",
      land: (opts: { title: string }) => (landed.push(opts.title), `https://github.com/acme/remudero/pull/${100 + landed.length}`),
      dispose: () => {},
    }),
    log: (step: string, extra?: Record<string, unknown>) => { events.push({ step, extra }); },
  };
  const pass = registry.selectorShadowGardenPass(deps, "acme", "remudero", () => "W1-T9001", { readJson, readText });
  const rows = (step: string) => events.filter((e) => e.step === step).map((e) => e.extra!);
  return { pass, reads, landed, rows };
}

test("W1-T5409: the production selector-shadow pass skips a run whose two misses also fail on main at its base sha", async () => {
  const h = harness({ conclusion: "failure", failed: RED });
  await h.pass();
  assert.deepEqual(h.rows("selector-shadow.gardener_failed"), []);
  assert.deepEqual(h.landed, [], "two misses under K that main also fails file nothing");
  assert.deepEqual(h.rows("selector-shadow.mass_failure_skipped"), [
    { ci_run_id: 8001, head_sha: "head-8001", files: 2, reason: "base", k: 5, failing_on_main: RED },
  ]);
  assert.ok(h.reads.some((url) => url.includes("runs?branch=main&head_sha=base-sha")), "main's CI is read at the run's base sha");
  assert.deepEqual(h.reads.filter((url) => url.endsWith("/logs")), ["repos/acme/remudero/actions/jobs/90013/logs"], "only the failed shard's log is read");
});

test("W1-T5409: the production pass still files a miss when main is green at the base sha", async () => {
  const h = harness({ conclusion: "success" });
  await h.pass();
  assert.deepEqual(h.rows("selector-shadow.gardener_failed"), []);
  assert.deepEqual(h.rows("selector-shadow.mass_failure_skipped"), []);
  assert.equal(h.landed.length, 1, "a real miss files one task per pass");
  assert.ok(!h.reads.some((url) => url.includes("/jobs")), "a green main run needs no job reads");
});

test("W1-T5409: main failing other files at the base sha does not hide the run's own misses", async () => {
  const h = harness({ conclusion: "failure", failed: ["test/unrelated.test.ts"] });
  await h.pass();
  assert.deepEqual(h.rows("selector-shadow.mass_failure_skipped"), []);
  assert.equal(h.landed.length, 1);
});

test("W1-T5409: main's failures are read from the newest completed main run, or not at all", async () => {
  const runs = (rows: unknown[]) => async (args: string[]) => {
    if (args[1]!.includes("runs?branch=main")) return { workflow_runs: rows };
    if (args[1]!.endsWith("jobs?per_page=100")) return mainJobs(5);
    throw new Error(`unexpected read ${args[1]}`);
  };
  const reader = (rows: unknown[]) => registry.selectorShadowMainFailures("acme", "remudero", {
    readJson: runs(rows),
    readText: async () => "FLAKE-RETRY-FILES: retrying 1 failed file(s) — test/x.test.ts",
  });
  assert.equal(await reader([])("sha"), undefined, "no main run at the sha is no result");
  assert.equal(await reader([{ id: 4, status: "in_progress" }, { id: 3, status: "completed", conclusion: "cancelled" }])("sha"), undefined,
    "an unfinished or cancelled run is no result");
  assert.deepEqual(await reader([{ id: 4, status: "queued" }, { id: 5, status: "completed", conclusion: "failure" }])("sha"), ["test/x.test.ts"]);
  assert.deepEqual(await reader([{ id: 6, status: "completed", conclusion: "success" }])("sha"), []);
});

test("W1-T5409: an unreadable main CI result throws, so the guard ledgers it as unread rather than as green", async () => {
  const reader = (list: unknown, jobs: unknown) => registry.selectorShadowMainFailures("acme", "remudero", {
    readJson: async (args) => (args[1]!.includes("runs?branch=main") ? list : jobs),
    readText: async () => "",
  });
  await assert.rejects(reader(null, null)("sha"), /no main CI runs for sha/);
  await assert.rejects(reader({ workflow_runs: [{ status: "completed", conclusion: "failure" }] }, null)("sha"), /no main CI runs for sha/);
  const failed = { workflow_runs: [{ id: 5, status: "completed", conclusion: "failure" }] };
  await assert.rejects(reader(failed, { total_count: 20, jobs: mainJobs(5).jobs })("sha"), /incomplete job list for main run 5/);
  await assert.rejects(reader(failed, null)("sha"), /incomplete job list for main run 5/);
  const sevenShards = { total_count: 8, jobs: mainJobs(5).jobs.slice(0, 8) };
  await assert.rejects(reader(failed, sevenShards)("sha"), /main run 5 lacks eight completed test shards/);
  const running = { total_count: 9, jobs: mainJobs(5).jobs.map((job) => (job.id === 53 ? { ...job, status: "in_progress" } : job)) };
  await assert.rejects(reader(failed, running)("sha"), /main run 5 lacks eight completed test shards/);
});

test("W1-T5409: with no gh on PATH the default reader fails loudly instead of reading main as green", async (t) => {
  const oldPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  t.after(() => { process.env.PATH = oldPath; });
  await assert.rejects(registry.selectorShadowMainFailures("acme", "remudero")("sha"));
});
