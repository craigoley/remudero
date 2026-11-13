import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runFixRung } from "#test/helpers/run-task-test.js";
import type { Config } from "#src/lib/config.js";

function fixture(t: TestContext, reason = "the worker changed nothing", repairs = true) {
  const root = mkdtempSync(join(tmpdir(), "rmd-no-edit-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const prompts: string[] = [];
  let pushes = 0;
  const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 20, contextBudget: 120000 };
  const review = { state: "failure" as const, headSha: "head-a", reviewerOutcome: "failure",
    criteria: [{ claim: "repair", proof: "unit test: repair", met: false, reason: "still red", proof_exec: "not_executable" as const }],
    testTheater: false, summary: "blocked", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false };
  const options: Parameters<typeof runFixRung>[0] = {
    taskId: "W1-T11014", runId: "W1-T11014-fixture",
    task: { id: "W1-T11014", title: "repair", files: ["repair.txt"] },
    prUrl: "https://github.com/acme/remudero/pull/1", branch: "run-W1-T11014-1",
    worktreePath: root, initialSessionId: "initial", initialReview: review,
    mount, strikeCap: 2, settingsFile: join(root, "settings.json"), budgetUsd: 1,
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async args => {
        prompts.push(args.prompt);
        if (repairs && args.prompt.includes("NO_EDIT_RECOVERY:")) writeFileSync(join(root, "repair.txt"), "repaired\n");
        return { sessionId: "session", text: "REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(worker): repair",
          blocks: [], stderr: "", model: "sonnet", effort: "medium", subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], costUsd: 0, numTurns: 1,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
          compactionEvents: [], qualitySuspect: false } as Awaited<ReturnType<Parameters<typeof runFixRung>[0]["deps"]["spawn"]>>;
      },
      harnessCommitForShellLessWorker: input => {
        if (existsSync(join(root, "repair.txt"))) {
          assert.equal(readFileSync(join(root, "repair.txt"), "utf8"), "repaired\n");
          input.onCommit?.("repaired-head", []);
          return 1;
        }
        input.onRefusal?.(reason, []);
        return 0;
      },
      worktreeHasUncommittedChanges: () => existsSync(join(root, "repair.txt")),
      commitsAhead: () => 0,
      push: () => { pushes++; },
      waitForCiGreen: async () => "green",
      runReview: async () => existsSync(join(root, "repair.txt"))
        ? { ...review, state: "success", summary: "repaired", criteria: [{ ...review.criteria[0], met: true }] } : review,
      fetchPrBody: async () => "REPORT",
      issues: { create: () => { assert.fail("recovery must not need a person"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, fields) => { rows.push({ step, ...fields }); }, say: () => {}, account: result => result,
    },
  };
  return { options, rows, prompts, pushes: () => pushes };
}

test("W1-T11014: fix-lane-commit-refused-the-worker-changed-nothing clears without a person", async t => {
  const f = fixture(t);
  const result = await runFixRung(f.options);
  assert.equal(result.outcome, "fixed");
  assert.equal(f.prompts.length, 2);
  assert.equal(f.prompts[0].includes("NO_EDIT_RECOVERY:"), false);
  assert.match(f.prompts[1], /A FIXED report requires actual edits/);
  assert.equal(f.rows.filter(row => row.step === "fix.no_edit_recovery").length, 1);
  assert.equal(f.pushes(), 1);
});

test("an unchanged recovery is refused without another recovery or a push", async t => {
  const f = fixture(t, "the worker changed nothing", false);
  const result = await runFixRung(f.options);
  assert.equal(result.outcome, "stood_down");
  assert.equal(result.standDownReason, "the worker changed nothing");
  assert.equal(f.prompts.filter(prompt => prompt.includes("NO_EDIT_RECOVERY:")).length, 1);
  assert.equal(f.pushes(), 0);
});

test("other commit refusals do not receive a no-edit recovery", async t => {
  const f = fixture(t, "outside declared files");
  const result = await runFixRung(f.options);
  assert.equal(result.outcome, "stood_down");
  assert.equal(f.prompts.length, 1);
  assert.equal(f.rows.some(row => row.step === "fix.no_edit_recovery"), false);
  assert.equal(f.pushes(), 0);
});
