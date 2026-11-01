import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { runDaemon } from "#src/lib/daemon.js";
import {
  CI_LEARNING_LANDING_BRANCH,
  landCiLearningShards,
  landCiLearningShardsAsync,
  type LandingGitMeter,
  type CiLearningShardDraft,
} from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { ciLearningRecordVerdict, ciLearningShardYaml } from "#src/lib/measurement-cadence.js";
import { loadPlan } from "#src/lib/plan.js";
import { drainDetachedSweepActions } from "#src/lib/sweep.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { buildCiLearningCadenceRunner } from "#test/helpers/run-task-test.js";

function queuedLanding(t: TestContext) {
  const seed = gitRepo({ scope: t, kind: "ci-learning-meter-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(seed.dir, "plan", "tasks.d", "seed.yaml"), "- id: W1-T1\n  origin: ci-learning:1:seed\n");
  seed.git("add", "plan");
  seed.git("commit", "--quiet", "-m", "chore: seed the plan");
  const origin = gitRepo({ scope: t, bare: true, kind: "ci-learning-meter-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const checkout = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "ci-learning-meter-clone" });
  checkout.git("config", "user.name", "meter fixture");
  checkout.git("config", "user.email", "meter@remudero.invalid");
  const { dir: root } = ownedFixtureDir(t, "ci-learning-meter-state");
  const draft: CiLearningShardDraft = {
    findingId: "ci-learning:9914:meter",
    title: "teach the gate its repaired failure",
    gate: "ci-gate",
    pr: 9914,
    prs: [9914],
    repairFiles: ["src/lib/example.ts"],
    dominantRepairFiles: [{ file: "src/lib/example.ts", prs: 1 }],
    author_class: "machine",
    verify: "human",
    remedySurface: "test",
  };
  const relPath = "plan/tasks.d/W1-T9915-queued.yaml";
  const contents = ciLearningShardYaml(draft, "W1-T9915");
  const pending = join(root, "state", "ci-learning-pending", relPath);
  mkdirSync(dirname(pending), { recursive: true });
  writeFileSync(pending, contents);
  const deps = {
    stateRoot: root,
    mintTaskId: (): never => { throw new Error("the queued draft already has an id"); },
    planOrigins: [],
    renderShard: ciLearningShardYaml,
    recordVerdict: ciLearningRecordVerdict,
    planPrPreflight: () => ({ ok: true, failures: [], unreadable: [] }),
    gh: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") return "[]";
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/9914";
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    },
  };
  return { checkout, origin, deps, relPath, contents, draft };
}

function assertMeter(meter: LandingGitMeter | undefined, driver: LandingGitMeter["driver"]) {
  assert.ok(meter, "a landing returns its measured git work");
  assert.equal(meter.driver, driver);
  assert.ok(Number.isInteger(meter.calls) && meter.calls > 0, "real git calls were counted");
  assert.ok(Number.isFinite(meter.wallMs) && meter.wallMs > 0);
  assert.ok(Number.isFinite(meter.loopMs) && meter.loopMs > 0);
  assert.ok(meter.loopMs <= meter.wallMs, "loop time is bounded by elapsed git time");
  if (driver === "sync") assert.equal(meter.loopMs, meter.wallMs);
}

test("W1-T9914: an async ci-learning landing returns its git meter", async (t) => {
  const f = queuedLanding(t);
  const result = await withLiveWritesAllowed(() => landCiLearningShardsAsync([], f.checkout.dir, f.deps));
  assert.deepEqual(result.filed, [{ taskId: "W1-T9915", relPath: f.relPath, findingId: f.draft.findingId }]);
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(f.origin.git("show", `${CI_LEARNING_LANDING_BRANCH}:${f.relPath}`), f.contents.trim());
  assertMeter(result.git, "async");
  const snapshot = { ...result.git };
  const next = await withLiveWritesAllowed(() => landCiLearningShardsAsync([], f.checkout.dir, f.deps));
  assertMeter(next.git, "async");
  assert.notStrictEqual(next.git, result.git, "each landing owns a fresh meter");
  assert.deepEqual(result.git, snapshot, "later landings cannot change the earlier receipt");
});

test("W1-T9914: a sync ci-learning landing returns its own git meter", (t) => {
  const f = queuedLanding(t);
  const result = withLiveWritesAllowed(() => landCiLearningShards([], f.checkout.dir, f.deps));
  assert.equal(result.filed.length, 1);
  assert.equal(f.origin.git("show", `${CI_LEARNING_LANDING_BRANCH}:${f.relPath}`), f.contents.trim());
  assertMeter(result.git, "sync");
});

test("W1-T9914: an admission refusal has no landing git meter", async (t) => {
  const f = queuedLanding(t);
  rmSync(join(f.deps.stateRoot, "state", "ci-learning-pending"), { recursive: true, force: true });
  const deps = {
    ...f.deps,
    mintTaskId: () => "W1-T9916",
    recordVerdict: () => ({ ok: false, reason: "admission refused" }),
  };
  const expected = {
    filed: [], skipped: [],
    refused: [{ findingId: f.draft.findingId, reason: "admission refused" }],
  };
  const sync = withLiveWritesAllowed(() => landCiLearningShards([f.draft], f.checkout.dir, deps));
  assert.deepEqual(sync, expected);
  const asyncResult = await withLiveWritesAllowed(() => landCiLearningShardsAsync([f.draft], f.checkout.dir, deps));
  assert.deepEqual(asyncResult, expected);
});

test("W1-T9914: the cadence runner forwards the meter only when it lands", async (t) => {
  const { dir } = ownedFixtureDir(t, "ci-learning-runner-meter");
  const git: LandingGitMeter = { driver: "async", calls: 17, wallMs: 13.6, loopMs: 4.4 };
  for (const mode of ["draft", "pending", "empty"] as const) {
    let calls = 0;
    const result = await buildCiLearningCadenceRunner({
      root: dir,
      checkoutRoot: dir,
      loadWindow: () => mode !== "draft" ? { prs: [] } : ({ prs: [{
        number: 9914,
        commits: [
          { sha: "red9914", rollup: [{ name: "ci-gate", conclusion: "FAILURE" }] },
          { sha: "green9914", rollup: [{ name: "ci-gate", conclusion: "SUCCESS" }], changedFiles: ["src/lib/example.ts"] },
        ],
      }] }),
      loadLessons: () => ({ status: "unreadable" }),
      planOrigins: [],
      pendingOrigins: () => mode === "pending" ? ["pending-origin"] : [],
      mergedOrigins: () => [],
      recordAttempt: () => {},
      recordFire: () => {},
      landShards: async (drafts) => {
        calls++;
        assert.equal(drafts.length, mode === "draft" ? 1 : 0);
        return { filed: [], skipped: [], refused: [], git };
      },
    })();
    assert.equal(calls, mode === "empty" ? 0 : 1, mode);
    assert.equal(result.draftCount, mode === "draft" ? 1 : 0, mode);
    if (mode === "empty") assert.equal(Object.hasOwn(result, "git"), false);
    else assert.strictEqual(result.git, git, "the landing's meter reaches the runner unchanged");
  }
});

test("W1-T9914: the cadence ran row carries the landing git meter", async (t) => {
  const { dir } = ownedFixtureDir(t, "ci-learning-cadence-meter");
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "- id: A\n  title: a task\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  for (const driver of ["async", "sync", "none"] as const) {
    const rows: Record<string, unknown>[] = [];
    let calls = 0;
    await runDaemon(loadPlan(planPath), {
      refreshMerged: () => () => false,
      runOne: async (id) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
      sleep: async () => {},
      sweep: async () => {},
      log: (step, fields) => { if (step === "ci_learning_cadence.ran") rows.push(fields ?? {}); },
      checkCiLearningCadence: () => ({ fire: true, reason: "due" }),
      runCiLearningCadence: async () => {
        calls++;
        return {
          status: "clear",
          draftCount: 0, excludedCount: 0, unreadableCount: 0,
          filedCount: 0, skippedCount: 0, refusedCount: 0,
          carryRefusedCount: 0, carryRefused: [],
          lessonRecurrences: { status: "unreadable" },
          ...(driver === "none" ? {} : { git: { driver, calls: 17, wallMs: 13.6, loopMs: 4.4 } }),
        };
      },
    }, { max: 1, pollIntervalMs: 60_000 });
    await drainDetachedSweepActions({ boundMs: 5_000 });
    assert.equal(calls, 1, "control: the daemon ran the cadence");
    assert.equal(rows.length, 1, "control: the cadence emitted its ran row");
    assert.equal(rows[0]!.git_driver, driver);
    assert.equal(rows[0]!.git_calls, driver === "none" ? 0 : 17);
    assert.equal(rows[0]!.git_wall_ms, driver === "none" ? 0 : 14);
    assert.equal(rows[0]!.git_loop_ms, driver === "none" ? 0 : 4);
  }
});
