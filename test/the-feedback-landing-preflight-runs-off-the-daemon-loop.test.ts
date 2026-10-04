// test/the-feedback-landing-preflight-runs-off-the-daemon-loop.test.ts — W1-T5620.
//
// W1-T5521 (#8993) moved the sweep's plan-PR rungs to `planPrPreflightAtCommitAsync`, but feedback-landing's push
// still ran the sync `planPrPreflightAtCommit`, and the daemon reaches that push every iteration through
// `sweepFeedbackLandingRung` (src/run-task.ts). These suites drive the daemon's REAL rungs, built by
// `feedbackLandingSweepRungs`, over a real bare origin whose main carries a SLOW lint-plan script (a real child
// process that marks its start, holds SLOW_CHECK_MS, marks its end and refuses). Only `gh` is faked.
//
// THE OBSERVATION is event-loop turns, never a wall-clock bound: a ticker set before the rung starts reads the
// script's marks, and sees the check running only if the loop turns while the child is alive.
//
// The control runs the boot rung, which keeps the sync form by design (as the falsifier wires it back into the
// per-poll rung). Its ticker must never see the check running; without it, a ticker that fires proves nothing.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import * as landing from "../src/lib/feedback-landing.js";
import type { LandFeedbackResult } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "../src/lib/plan-pr-emitter.js";
import * as runTask from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

// Namespace reads, so this file still loads at origin/main (where these forms do not exist) and reds per subtest.
const { LANDING_BRANCH } = landing;
const { feedbackLandingSweepRungs } = runTask;
const sweepFeedbackLandingAsync = (landing as Record<string, unknown>).sweepFeedbackLandingAsync as (
  root: string,
  opts: Record<string, unknown>,
) => Promise<LandFeedbackResult>;

/** How long the fixture tree's lint-plan check holds its child process alive before it refuses. */
const SLOW_CHECK_MS = 2_000;
const REFUSES_LINE = "lint-plan-precheck: W1-T5620-FIXTURE REFUSES — slow fixture red";
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };

type Row = { step: string; extra?: Record<string, unknown> };

/**
 * A bare origin whose main carries the slow, red lint-plan script, and a clone holding one uncaptured feedback
 * record. `nonce` makes every fixture's landing tree distinct: feedback-landing caches a refused verdict per
 * tree sha for the life of the process, so two fixtures with identical trees would share one verdict.
 */
function slowLandingFixture(nonce: string) {
  const seed = gitRepo({ kind: `w5620-${nonce}-seed` });
  const marks = join(dirname(seed.dir), `${seed.dir.split("/").pop()}-check-marks`);
  mkdirSync(join(seed.dir, "scripts"), { recursive: true });
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
  const origin = gitRepo({ bare: true, kind: `w5620-${nonce}-origin` });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: `w5620-${nonce}-clone` });
  mkdirSync(join(clone.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(clone.dir, "plan", "feedback", `fb-${nonce}.yaml`), `id: fb-${nonce}\nstatus: new\nraw: ${nonce}\n`);

  const rows: Row[] = [];
  const ghCalls: string[][] = [];
  const gh = (args: string[]): string => {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/5620\n";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  const log = (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra });
  const heads = () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
  const creates = () => ghCalls.filter((c) => c[0] === "pr" && c[1] === "create");
  const marksRead = () => (existsSync(marks) ? readFileSync(marks, "utf8") : "");
  const originSha = (branch: string) => origin.git("rev-parse", `refs/heads/${branch}`);
  return { clone, marks, rows, gh, log, heads, creates, marksRead, originSha };
}

/** Run `rung` with a ticker scheduled first; reports whether a tick landed while the slow check was alive. */
async function observeLoop<T>(marks: string, rung: () => T | Promise<T>): Promise<{ result: T; sawCheckRunning: boolean }> {
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

function assertRedPushedNothing(f: ReturnType<typeof slowLandingFixture>, result: LandFeedbackResult): void {
  assert.equal(result.landed, false, JSON.stringify(result));
  assert.equal(result.pushed, undefined, "nothing was pushed");
  assert.match(result.error ?? "", /^plan-PR preflight refused the feedback-landing push: \[lint-plan\] /);
  assert.deepEqual(f.heads(), ["main"], "a red preflight pushes no landing branch");
  assert.equal(f.creates().length, 0, "a red preflight opens no PR");
  const refused = f.rows.filter((r) => r.step === "plan_pr.preflight_refused");
  assert.equal(refused.length, 1, "the refusal is ledgered once");
  assert.equal(refused[0]!.extra!.lane, "feedback-landing");
  assert.equal(refused[0]!.extra!.branch, LANDING_BRANCH);
  assert.deepEqual(refused[0]!.extra!.failures, [{ check: "lint-plan", firstLine: REFUSES_LINE }], "the slow check's red is the named failure");
  const sweepRows = f.rows.filter((r) => r.step === "feedback.landing_sweep");
  assert.deepEqual(sweepRows.map((r) => [r.extra!.pushed, r.extra!.error]), [[false, result.error]], "the sweep's one quiet row carries the refusal");
  assert.equal(f.clone.git("worktree", "list").split("\n").length, 1, "the preflight's tree is removed");
}

test("W1-T5620: the daemon's per-poll feedback-landing rung runs its preflight check while a timer set before it fires, and its red still pushes nothing", async () => {
  const f = slowLandingFixture("perpoll");
  const rungs = feedbackLandingSweepRungs(f.clone.dir, { gh: f.gh, log: f.log });

  const { result, sawCheckRunning } = await observeLoop(f.marks, () => withLiveWritesAllowed(() => rungs.perPoll()));

  assert.equal(f.marksRead(), "started\ndone\n", "the slow check ran to completion in a real child process");
  assert.ok(sawCheckRunning, "a tick landed while the preflight's child process was still running");
  assertRedPushedNothing(f, result);

  // The refused tree's verdict is still cached: the next poll over the same tree re-runs no check and pushes nothing.
  f.rows.length = 0;
  const again = await withLiveWritesAllowed(() => rungs.perPoll());
  assert.equal(f.marksRead(), "started\ndone\n", "a cached red verdict runs the slow check no second time");
  assert.equal(again.error, result.error);
  assert.deepEqual(f.heads(), ["main"]);
});

test("W1-T5620 control: the boot rung keeps the sync preflight, which holds the loop for the whole check", async () => {
  const f = slowLandingFixture("boot");
  const rungs = feedbackLandingSweepRungs(f.clone.dir, { gh: f.gh, log: f.log });

  const { result, sawCheckRunning } = await observeLoop(f.marks, () => withLiveWritesAllowed(() => rungs.atBoot()));

  assert.equal(f.marksRead(), "started\ndone\n", "the same slow check ran");
  assert.equal(sawCheckRunning, false, "no tick can land while spawnSync holds the thread");
  assertRedPushedNothing(f, result);
});

test("W1-T5620: sweepFeedbackLandingAsync awaits a Promise-returning planPrPreflight and lands on a green verdict", async () => {
  const f = slowLandingFixture("green");
  const asked: Array<{ sha: string; title: string }> = [];
  const result = await withLiveWritesAllowed(() =>
    sweepFeedbackLandingAsync(f.clone.dir, {
      gh: f.gh,
      log: f.log,
      planPrPreflight: async (sha: string, pr: { title: string; body: string }) => (asked.push({ sha, title: pr.title }), GREEN),
    }),
  );

  assert.equal(result.landed, true, JSON.stringify(result));
  assert.equal(result.pushed, true);
  assert.deepEqual(result.files, ["plan/feedback/fb-green.yaml"]);
  assert.equal(result.prUrl, "https://github.com/o/r/pull/5620");
  assert.equal(asked.length, 1, "the preflight is asked once");
  assert.deepEqual(f.heads(), [LANDING_BRANCH, "main"].sort());
  assert.equal(asked[0]!.sha, f.originSha(LANDING_BRANCH), "the commit the preflight judged is the commit pushed");
  assert.deepEqual(f.creates().length, 1, "the landing PR is opened");
});

test("W1-T5620: a preflight that throws is read the same by the sync and the awaited sweep — no push, the same error", async () => {
  const sync = slowLandingFixture("throws-sync");
  const awaited = slowLandingFixture("throws-async");
  const boom = (): never => {
    throw new Error("preflight could not start");
  };

  const r1 = withLiveWritesAllowed(() => landing.sweepFeedbackLanding(sync.clone.dir, { gh: sync.gh, log: sync.log, planPrPreflight: boom }));
  const r2 = await withLiveWritesAllowed(() =>
    sweepFeedbackLandingAsync(awaited.clone.dir, { gh: awaited.gh, log: awaited.log, planPrPreflight: async () => boom() }),
  );

  for (const [f, r] of [[sync, r1], [awaited, r2]] as const) {
    assert.equal(r.landed, false, JSON.stringify(r));
    assert.match(r.error ?? "", /^refused to force-replace feedback-landing: .*\(preflight could not start\); original failure: preflight could not start$/);
    assert.deepEqual(f.heads(), ["main"], "a throwing preflight pushes nothing");
    assert.equal(f.creates().length, 0);
  }
  assert.equal(r2.error, r1.error, "the awaited sweep reads a rejection exactly as the sync sweep reads a throw");
});
