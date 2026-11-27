// W1-T15064: a fix round never edits source to answer a red step the base already carries, and never rewrites an
// existing test's expectation unless the finding it answers names that test. On core #21035, round 1835b8af3
// answered inherited expiring-fixture-census crossings by loosening `=== false` to `!== true` in src/lib/inbox.ts.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { BASE_INHERITED_MARKER, baseInheritedRedSteps, rewrittenTestExpectations, unaskedExpectationRewrites } from "#src/lib/ci-remedy-execution.js";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 20, contextBudget: 120000 };
const SOURCE = "src/inbox.ts";
const TEST = "test/inbox.test.ts";
const GUARDED = "export const released = (r?: (id: string) => boolean) => r?.(\"x\") === false;\n";
const LOOSENED = "export const released = (r?: (id: string) => boolean) => r?.(\"x\") !== true;\n";
const EXPECT = "import assert from \"node:assert/strict\";\nassert.equal(released(undefined), false);\n";
const REWRITTEN = "import assert from \"node:assert/strict\";\nassert.equal(released(undefined), true);\n";

/** The census log of core #21035's comment-load-ratchet step: every crossing is marked inherited. */
const inheritedLog = [
  "expiring-fixture-census: BLOCKED -- 2 fixture(s) CROSS their threshold within 3 day(s):",
  `  - test/a.test.ts:12  ts="2026-11-20T00:00:00Z" vs 7d  --  goes red 2026-11-27 (0.4d)  ${BASE_INHERITED_MARKER}`,
  `  - test/b.test.ts:40  ts="2026-11-21T00:00:00Z" vs 7d  --  goes red 2026-11-28 (1.4d)  ${BASE_INHERITED_MARKER}`,
  "  2 of these are ALREADY crossing on the base ref, so this diff did not plant them.",
  "##[error]Process completed with exit code 1.",
].join("\n");

async function round(ciFailures: Array<{ name: string; logTail: string }>, edit: (dir: string) => void) {
  const repo = gitRepo({ kind: "w1-t15064" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, SOURCE), GUARDED);
  writeFileSync(join(repo.dir, TEST), EXPECT);
  repo.git("add", "src", "test");
  repo.git("commit", "-qm", "seed");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const before = repo.git("rev-parse", "HEAD");
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  let spawns = 0, pushes = 0;
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [], summary: "checks red", testTheater: false, floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: before, reviewerOutcome: "failure",
  };
  const outcome = await runFixRung({
    taskId: "W1-T15064X", runId: "W1-T15064X-run",
    task: { id: "W1-T15064X", title: "inbox released asks", files: [SOURCE, TEST] },
    prUrl: "https://github.com/acme/remudero/pull/21035", branch: "run-W1-T15064X-1",
    worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review, ciFailures,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    deps: {
      spawn: async () => {
        spawns++;
        edit(repo.dir);
        return {
          sessionId: "fix-session", costUsd: 0, numTurns: 1, text: "COMMIT_MESSAGE: fix(inbox): answer the red check",
          blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        } satisfies WorkerResult;
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success", criteria: [], headSha: repo.git("rev-parse", "HEAD"), reviewerOutcome: "success" }),
      fetchPrBody: async () => "inbox released asks",
      readHeadShaForProvenance: () => repo.git("rev-parse", "HEAD"),
      push: () => { pushes++; },
      issues: { create: () => { throw new Error("unexpected escalation"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"),
      log: (step, extra) => { rows.push({ step, ...extra }); }, say: () => {}, account: (result) => result,
    },
  });
  return { repo, before, outcome, rows, spawns, pushes };
}

const loosenAndRewrite = (dir: string) => {
  writeFileSync(join(dir, SOURCE), LOOSENED);
  writeFileSync(join(dir, TEST), REWRITTEN);
};

test("W1-T15064 criterion 1: an all-inherited red step dispatches no source edit", async (t) => {
  const result = await round([{ name: "comment-load-ratchet", logTail: inheritedLog }], loosenAndRewrite);
  t.after(() => result.repo.cleanup());
  assert.equal(result.spawns, 0, "no worker is dispatched to edit source for a base-inherited red step");
  assert.equal(result.pushes, 0);
  assert.equal(result.outcome.outcome, "stood_down");
  assert.equal(result.repo.git("rev-parse", "HEAD"), result.before);
  const why = result.rows.find((row) => row.step === "fix.stood_down" && row.reason === "base_inherited");
  assert.deepEqual(why?.steps, ["comment-load-ratchet"], "the stand-down records why, naming the step");
  // The marker is the one the census really prints.
  assert.equal(readFileSync(join(REPO_ROOT, "scripts/expiring-fixture-census.mjs"), "utf8").includes(BASE_INHERITED_MARKER), true);
  // Any doubt dispatches as before: one crossing the diff planted, another failure in the log, or no failure at all.
  const planted = inheritedLog.replace(`(1.4d)  ${BASE_INHERITED_MARKER}`, "(1.4d)");
  assert.equal(baseInheritedRedSteps([{ name: "comment-load-ratchet", logTail: planted }]).inherited, false);
  assert.equal(baseInheritedRedSteps([{ name: "comment-load-ratchet", logTail: `${inheritedLog}\nnot ok 3 - inbox` }]).inherited, false);
  assert.equal(baseInheritedRedSteps([{ name: "comment-load-ratchet", logTail: inheritedLog },
    { name: "unit", logTail: "✖ inbox released asks" }]).inherited, false);
  assert.equal(baseInheritedRedSteps([]).inherited, false);
});

test("W1-T15064 criterion 1: a red step this diff owns still dispatches its source edit", async (t) => {
  const result = await round([{ name: "unit", logTail: "✖ inbox guard\n    at released (src/inbox.ts:1:1)" }],
    (dir) => writeFileSync(join(dir, SOURCE), `${GUARDED}// repaired\n`));
  t.after(() => result.repo.cleanup());
  assert.equal(result.spawns, 1);
  assert.equal(result.pushes, 1);
  assert.equal(result.rows.some((row) => row.reason === "base_inherited"), false);
});

test("W1-T15064 criterion 2: a changed test expectation is refused unless its finding names the test", async (t) => {
  // The finding names the source only: the rewritten assertion in test/inbox.test.ts is refused and nothing is pushed.
  const refused = await round([{ name: "unit", logTail: "✖ inbox guard\n    at released (src/inbox.ts:1:1)" }], loosenAndRewrite);
  t.after(() => refused.repo.cleanup());
  assert.equal(refused.spawns, 1);
  assert.equal(refused.pushes, 0, "the round that rewrote an unnamed test's expectation does not push");
  assert.equal(refused.outcome.outcome, "stood_down");
  const row = refused.rows.find((r) => r.step === "fix.commit_refused" && r.reason === "the round changed a test expectation the answered finding does not name");
  assert.deepEqual(row?.tests, [TEST]);
  assert.deepEqual(row?.changed_assertions, ["assert.equal(released(undefined), false)"]);
  // The finding names the test: the same rewrite is the asked-for repair and is pushed.
  const named = await round([{ name: "unit", logTail: `✖ inbox guard\n    at (${TEST}:2:8)\n    at released (src/inbox.ts:1:1)` }], loosenAndRewrite);
  t.after(() => named.repo.cleanup());
  assert.equal(named.pushes, 1);
  // A new assertion beside the existing ones changes no expectation.
  assert.deepEqual(rewrittenTestExpectations([{ path: TEST, base: EXPECT, head: `${EXPECT}assert.equal(released(() => false), true);\n` }]), []);
  // A multi-line expectation is compared whole, and a match by file name counts as naming the test.
  const multi = rewrittenTestExpectations([{ path: TEST, base: "assert.deepEqual(rows,\n  [1, 2]);\n", head: "assert.deepEqual(rows,\n  [1]);\n" }]);
  assert.deepEqual(multi, [{ path: TEST, changed: ["assert.deepEqual(rows, [1, 2])"] }]);
  assert.deepEqual(unaskedExpectationRewrites(multi, "fails in inbox.test.ts"), []);
  assert.deepEqual(unaskedExpectationRewrites(multi, "fails in src/inbox.ts"), multi);
});
