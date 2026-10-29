import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildCiLearningCadenceRunner, ciLearningCommand } from "#src/run-task.js";
import { runDaemon } from "#src/lib/daemon.js";
import type { CiLearningFilingResult, FeedbackRefusal } from "#src/lib/feedback-landing.js";
import { loadPlan } from "#src/lib/plan.js";
import { drainDetachedSweepActions } from "#src/lib/sweep.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const carryRefusals: FeedbackRefusal[] = [
  { path: "plan/tasks.d/W1-T9001-lesson.yaml", reason: "main changed this shard too" },
  { path: "plan/tasks.d/W1-T9002-lesson.yaml", reason: "main deleted this shard" },
];

const repairedWindow = () => ({
  prs: [{
    number: 9801,
    commits: [
      { sha: "red9801", rollup: [{ name: "ci-gate", conclusion: "FAILURE" }] },
      { sha: "green9801", rollup: [{ name: "ci-gate", conclusion: "SUCCESS" }], changedFiles: ["src/lib/x.ts"] },
    ],
  }],
});

test("W1-T9801: the cadence runner keeps the landing carry refusals", async (t) => {
  const { dir } = ownedFixtureDir(t, "ci-learning-carry");
  for (const landed of [true, false]) {
    let calls = 0;
    const result = await buildCiLearningCadenceRunner({
      root: dir,
      checkoutRoot: dir,
      loadWindow: repairedWindow,
      loadLessons: () => ({ status: "unreadable" }),
      planOrigins: [],
      pendingOrigins: () => [],
      mergedOrigins: () => [],
      recordAttempt: () => {},
      recordFire: () => {},
      landShards: async (drafts) => {
        calls++;
        assert.equal(drafts.length, 1, "control: a repaired failure reaches the landing");
        return {
          filed: landed ? [{ taskId: "W1-T9802", relPath: "plan/tasks.d/new.yaml", findingId: drafts[0]!.findingId }] : [],
          skipped: ["already filed"],
          refused: [{ findingId: "bad draft", reason: "task linter refusal" }],
          carryRefused: carryRefusals,
        };
      },
    })();
    assert.equal(calls, 1);
    assert.equal(result.filedCount, landed ? 1 : 0);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.refusedCount, 1);
    assert.equal(result.carryRefusedCount, 2);
    assert.deepEqual(result.carryRefused, carryRefusals);
  }
});

test("W1-T9801: the cadence runner explicitly reports no carry refusals", async (t) => {
  const { dir } = ownedFixtureDir(t, "ci-learning-no-carry");
  for (const mode of ["landing", "no-drafts", "pending", "legacy-filer", "failed-landing"] as const) {
    let calls = 0;
    const filing = (): CiLearningFilingResult => {
      calls++;
      if (mode === "failed-landing") throw new Error("landing unavailable");
      return { filed: [], skipped: [], refused: [] };
    };
    const result = await buildCiLearningCadenceRunner({
      root: dir,
      checkoutRoot: dir,
      loadWindow: () => mode === "no-drafts" || mode === "pending" ? { prs: [] } : repairedWindow(),
      loadLessons: () => ({ status: "unreadable" }),
      planOrigins: [],
      pendingOrigins: () => mode === "pending" ? ["pending-origin"] : [],
      mergedOrigins: () => [],
      recordAttempt: () => {},
      recordFire: () => {},
      ...(mode === "legacy-filer" ? { fileShards: filing } : { landShards: filing }),
    })();
    assert.equal(calls, mode === "no-drafts" ? 0 : 1, mode);
    assert.equal(result.carryRefusedCount, 0, mode);
    assert.deepEqual(result.carryRefused, [], mode);
  }
});

test("W1-T9801: the cadence ran row records carry refusals", async (t) => {
  const fixture = ownedFixtureDir(t, "ci-learning-carry-row");
  const planPath = join(fixture.dir, "tasks.yaml");
  writeFileSync(planPath, "- id: A\n  title: a task\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  for (const refusals of [carryRefusals, []]) {
    const rows: Array<{ step: string; fields?: Record<string, unknown> }> = [];
    await runDaemon(loadPlan(planPath), {
      refreshMerged: () => () => false,
      runOne: async (id) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
      sleep: async () => {},
      sweep: async () => {},
      log: (step, fields) => { rows.push({ step, fields }); },
      checkCiLearningCadence: () => ({ fire: true, reason: "due" }),
      runCiLearningCadence: async () => ({
        status: "clear",
        draftCount: 0,
        excludedCount: 0,
        unreadableCount: 0,
        filedCount: 1,
        skippedCount: 3,
        refusedCount: 4,
        carryRefusedCount: refusals.length,
        carryRefused: refusals,
        lessonRecurrences: { status: "unreadable" },
      }),
    }, { max: 1, pollIntervalMs: 60_000 });
    await drainDetachedSweepActions({ boundMs: 5_000 });
    const row = rows.find(({ step }) => step === "ci_learning_cadence.ran")?.fields;
    assert.ok(row, "control: the cadence emitted its durable row");
    assert.equal(row.refused, 4, "linter refusals retain their own count");
    assert.equal(row.carry_refused, refusals.length);
    assert.deepEqual(row.carry_refusals, refusals);
  }
});

test("W1-T9801: the manual command prints each carry refusal with its reason", (t) => {
  const { dir } = ownedFixtureDir(t, "ci-learning-carry-command");
  const lines: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { lines.push(args.join(" ")); });
  let calls = 0;
  const code = ciLearningCommand(["--force"], {
    root: dir,
    planOrigins: [],
    loadWindow: repairedWindow,
    landShards: () => {
      calls++;
      return {
        filed: [], skipped: [],
        refused: [{ findingId: "bad draft", reason: "task linter refusal" }],
        carryRefused: carryRefusals,
      };
    },
  });
  assert.equal(code, 0);
  assert.equal(calls, 1, "control: the manual command reached the landing");
  for (const refusal of carryRefusals) {
    assert.ok(lines.some((line) => line.includes("CARRY REFUSED") && line.includes(refusal.path) && line.includes(refusal.reason)));
  }
  assert.ok(lines.some((line) => line.includes("REFUSED by the task linter (task linter refusal): bad draft")));
});
