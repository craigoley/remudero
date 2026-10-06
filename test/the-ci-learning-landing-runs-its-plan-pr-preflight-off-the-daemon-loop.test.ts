// test/the-ci-learning-landing-runs-its-plan-pr-preflight-off-the-daemon-loop.test.ts — W1-T5965.
//
// The daemon's ci_learning cadence filed through `landCiLearningShards`, whose plan-PR preflight is the sync
// `planPrPreflightAtCommit` (every check a spawnSync in plan-pr-emitter's runInTree). On 2026-10-06 04:50Z it
// held the daemon loop 143 s while opening #9473. These suites drive the daemon's REAL rung body,
// `buildCiLearningCadenceRunner` with its default lander, over a bare origin whose main carries a SLOW lint-plan
// script (a real child that marks its start, holds SLOW_CHECK_MS, marks its end and refuses). Only gh is faked.
//
// THE OBSERVATION is event-loop turns (the W1-T5620 shape): a ticker set before the rung reads the script's
// marks, and sees the check running only if the loop turns while the child is alive.
//
// The control wires the sync seam, `landCiLearningShards`, back into the rung (the task's falsifier). Its ticker
// must never see the check running; without it, a ticker that fires proves nothing.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import * as landing from "../src/lib/feedback-landing.js";
import type { CiLearningFilingResult, CiLearningShardDraft } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { ciLearningRecordVerdict, ciLearningShardYaml } from "../src/lib/measurement-cadence.js";
import type { PlanPrPreflightResult } from "../src/lib/plan-pr-emitter.js";
import { buildCiLearningCadenceRunner } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

// A namespace read, so this file still loads at origin/main (where the async form does not exist) and reds per subtest.
const { CI_LEARNING_LANDING_BRANCH, landCiLearningShards } = landing;
const landCiLearningShardsAsync = (landing as Record<string, unknown>).landCiLearningShardsAsync as (
  drafts: readonly CiLearningShardDraft[],
  checkoutRoot: string,
  deps: Record<string, unknown>,
) => Promise<CiLearningFilingResult>;

/** How long the fixture tree's lint-plan check holds its child process alive before it refuses. */
const SLOW_CHECK_MS = 2_000;
const REFUSES_LINE = "lint-plan-precheck: W1-T5965-FIXTURE REFUSES — slow fixture red";
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };

/** One repaired ci-gate failure: the corpus the rung mints exactly one draft from. */
function repairedWindow() {
  return {
    prs: [
      {
        number: 5965,
        commits: [
          { sha: "aaa5965", rollup: [{ name: "ci-gate", conclusion: "FAILURE" }], changedFiles: ["src/lib/x.ts"] },
          { sha: "bbb5965", rollup: [{ name: "ci-gate", conclusion: "SUCCESS" }], changedFiles: ["src/lib/x.ts"] },
        ],
      },
    ],
  } as never;
}

function draft(findingId: string): CiLearningShardDraft {
  return {
    findingId,
    title: "teach the ci gate its repaired failure shape",
    gate: "ci-gate",
    pr: 5965,
    prs: [5965],
    repairFiles: ["src/lib/x.ts"],
    dominantRepairFiles: [{ file: "src/lib/x.ts", prs: 1 }],
    action: "gate",
    author_class: "machine",
    verify: "human",
    remedySurface: "test",
  };
}

/**
 * A bare origin whose main carries the slow, red lint-plan script, a clone of it, and a state root. `nonce`
 * makes every fixture's landing tree distinct: a refused verdict is cached per tree sha for the process's life.
 */
function slowCiLearningFixture(nonce: string) {
  const seed = gitRepo({ kind: `w5965-${nonce}-seed` });
  const marks = join(dirname(seed.dir), `${seed.dir.split("/").pop()}-check-marks`);
  mkdirSync(join(seed.dir, "scripts"), { recursive: true });
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), `# ${nonce}\n[]\n`);
  writeFileSync(
    join(seed.dir, "scripts", "lint-plan-precheck.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(marks)}, "started\\n");`,
      "setTimeout(() => {",
      `  appendFileSync(${JSON.stringify(marks)}, "done\\n");`,
      `  console.log(${JSON.stringify(REFUSES_LINE)});`,
      "  process.exit(1);",
      `}, ${SLOW_CHECK_MS});`,
      "",
    ].join("\n"),
  );
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed the slow check");
  const origin = gitRepo({ bare: true, kind: `w5965-${nonce}-origin` });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: `w5965-${nonce}-clone` });
  const root = mkdtempSync(join(tmpdir(), `rmd-w5965-${nonce}-state-`));
  mkdirSync(join(root, "state"), { recursive: true });

  const ghCalls: string[][] = [];
  const gh = (args: string[]): string => {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/5965\n";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  const heads = () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
  const creates = () => ghCalls.filter((c) => c[0] === "pr" && c[1] === "create");
  const marksRead = () => (existsSync(marks) ? readFileSync(marks, "utf8") : "");
  const originSha = (branch: string) => origin.git("rev-parse", `refs/heads/${branch}`);
  let minted = 0;
  const landDeps = {
    stateRoot: root,
    mintTaskId: () => `W1-T${9650 + minted++}`,
    planOrigins: [] as string[],
    renderShard: ciLearningShardYaml,
    recordVerdict: ciLearningRecordVerdict,
    gh,
  };
  return { clone, root, marks, gh, heads, creates, marksRead, originSha, landDeps };
}

/** The daemon's rung body over the fixture; `over` swaps one dep (the control's sync lander). */
function cadenceRunner(f: ReturnType<typeof slowCiLearningFixture>, over: Record<string, unknown> = {}) {
  return buildCiLearningCadenceRunner({
    root: f.root,
    checkoutRoot: f.clone.dir,
    loadWindow: () => repairedWindow(),
    loadLessons: () => ({ status: "unreadable" }),
    planOrigins: [],
    mintTaskId: f.landDeps.mintTaskId,
    recordFire: () => {},
    gh: f.gh,
    ...over,
  } as Parameters<typeof buildCiLearningCadenceRunner>[0]);
}

/** Run `rung` with a ticker scheduled first; reports whether a tick landed while the slow check was alive. */
async function observeLoop<T>(marks: string, rung: () => Promise<T>): Promise<{ result: T; sawCheckRunning: boolean }> {
  let sawCheckRunning = false;
  const ticker = setInterval(() => {
    if (existsSync(marks) && readFileSync(marks, "utf8") === "started\n") sawCheckRunning = true;
  }, 20);
  try {
    const result = await rung();
    return { result, sawCheckRunning };
  } finally {
    clearInterval(ticker);
  }
}

function assertRedPushedNothing(f: ReturnType<typeof slowCiLearningFixture>, filedCount: number): void {
  assert.equal(f.marksRead(), "started\ndone\n", "the slow check ran to completion in a real child process");
  assert.equal(filedCount, 0, "a red preflight files nothing");
  assert.deepEqual(f.heads(), ["main"], "a red preflight pushes no landing branch");
  assert.equal(f.creates().length, 0, "a red preflight opens no PR");
  assert.equal(f.clone.git("worktree", "list").split("\n").length, 1, "the preflight's tree is removed");
}

test("W1-T5965: the daemon's ci-learning rung runs its plan-PR preflight check while a timer set before it fires, and its red still pushes nothing", async () => {
  const f = slowCiLearningFixture("daemon");

  const { result, sawCheckRunning } = await observeLoop(f.marks, () => withLiveWritesAllowed(() => cadenceRunner(f)()));

  assert.equal(result.draftCount, 1, "the window minted one draft to land");
  assert.ok(sawCheckRunning, "a tick landed while the preflight's child process was still running: the sync seam was never called");
  assertRedPushedNothing(f, result.filedCount);
});

test("W1-T5965 control: the sync landCiLearningShards wired back into the rung holds the loop for the whole check", async () => {
  const f = slowCiLearningFixture("control");

  const { result, sawCheckRunning } = await observeLoop(f.marks, () =>
    withLiveWritesAllowed(() => cadenceRunner(f, { landShards: landCiLearningShards })()),
  );

  assert.equal(result.draftCount, 1);
  assert.equal(sawCheckRunning, false, "no tick can land while spawnSync holds the thread");
  assertRedPushedNothing(f, result.filedCount);
});

test("W1-T5965: landCiLearningShardsAsync awaits a Promise-returning planPrPreflight and lands the staged shard on a green verdict", async () => {
  const f = slowCiLearningFixture("green");
  const asked: Array<{ sha: string; title: string }> = [];

  const result = await withLiveWritesAllowed(() =>
    landCiLearningShardsAsync([draft("ci-learning:5965:green")], f.clone.dir, {
      ...f.landDeps,
      planPrPreflight: async (sha: string, pr: { title: string; body: string }) => (asked.push({ sha, title: pr.title }), GREEN),
    }),
  );

  assert.deepEqual(result.filed.map((x) => x.taskId), ["W1-T9650"], JSON.stringify(result));
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.refused, []);
  assert.equal(asked.length, 1, "the preflight is asked once");
  assert.equal(asked[0]!.sha, f.originSha(CI_LEARNING_LANDING_BRANCH), "the commit the preflight judged is the commit pushed");
  assert.equal(f.marksRead(), "", "an injected verdict runs no check of the tree's own");
  assert.equal(f.creates().length, 1, "the landing PR is opened");
});

test("W1-T5965: a preflight that throws is read the same by the sync and the awaited ci-learning landing — nothing filed, nothing pushed", async () => {
  const sync = slowCiLearningFixture("throws-sync");
  const awaited = slowCiLearningFixture("throws-async");
  const boom = (): never => {
    throw new Error("preflight could not start");
  };

  const r1 = withLiveWritesAllowed(() =>
    landCiLearningShards([draft("ci-learning:5965:throws")], sync.clone.dir, { ...sync.landDeps, planPrPreflight: boom }),
  );
  const r2 = await withLiveWritesAllowed(() =>
    landCiLearningShardsAsync([draft("ci-learning:5965:throws")], awaited.clone.dir, { ...awaited.landDeps, planPrPreflight: async () => boom() }),
  );

  assert.deepEqual(r2, r1, "the awaited landing reads a rejection exactly as the sync landing reads a throw");
  assert.deepEqual(r1.filed, []);
  for (const f of [sync, awaited]) {
    assert.deepEqual(f.heads(), ["main"], "a throwing preflight pushes nothing");
    assert.equal(f.creates().length, 0);
  }
});
