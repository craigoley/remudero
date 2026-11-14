import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { planFilingFixRoundRefusal, readPlanFilingFixRoundInput, type PlanFilingFixRoundInput } from "#src/lib/plan-filing-fix-guard.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runPlanScopedFixRound, runFixRung } from "#test/helpers/run-task-test.js";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { fixRoundTally } from "#src/lib/sweep.js";

const SHARD = "plan/tasks.d/W1-T12062-fixture.yaml";
const DECLARED = "test/plan/future.test.ts";
const OTHER = "test/plan/existing.test.ts";
const criteria = [
  { claim: "the future behavior is implemented", proof: `unit test: future behavior in ${DECLARED}` },
  { claim: "the named function is called", proof: "grep: `someSymbol(` in src/future.ts" },
];
function shard(acceptance = criteria) {
  return stringify([{ id: "W1-T12062", files: [DECLARED], acceptance }]);
}
function input(over: Partial<PlanFilingFixRoundInput> = {}): PlanFilingFixRoundInput {
  return { baselineDiffFiles: [SHARD], introducedTaskIds: ["W1-T12062"],
    newCommitMessages: [{ sha: "b836c50", message: "fix(plan): repair proofs" }],
    priorShards: { [SHARD]: shard() }, nextShards: { [SHARD]: shard() }, mainTestPaths: {},
    declaredFilesByTask: { "W1-T12062": [DECLARED] }, ...over };
}

function filing(t: TestContext) {
  const repo = gitRepo({ scope: t });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), content);
  };
  write(OTHER, 'test("unrelated existing behavior", () => {});');
  repo.git("add", "."); repo.git("commit", "-m", "test: existing behavior");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  write(SHARD, shard());
  repo.git("add", "."); repo.git("commit", "-m", "chore(plan): file task");
  return { repo, write, prior: repo.git("rev-parse", "HEAD") };
}

test("a plan-filing fix round that credits a filed task is refused", () => {
  for (const message of [
    "fix(plan): worker message\n\nRemudero-Task: W1-T12062",
    "fix(plan): harness message\n\nRemudero-Assignment: round\nRemudero-Task: W1-T12062\nCo-Authored-By: fixture",
  ]) {
    const commits = [{ sha: "b836c50", message }, { sha: "later-clean", message: "fix(plan): clean tip" }];
    const reason = planFilingFixRoundRefusal(input({ newCommitMessages: commits }));
    assert.match(reason!, /Remudero-Task: W1-T12062/);
    assert.match(reason!, /b836c50/);
    assert.match(reason!, /plan-pr-emitter/);
    assert.equal(planFilingFixRoundRefusal(input({ baselineDiffFiles: [SHARD, "src/future.ts"], newCommitMessages: commits })), undefined);
  }
  assert.equal(planFilingFixRoundRefusal(input()), undefined);
  assert.equal(planFilingFixRoundRefusal(input({ baselineDiffFiles: [] })), undefined);
  assert.equal(planFilingFixRoundRefusal(input({ newCommitMessages: [{ sha: "other", message: "Remudero-Task: W1-T999" }] })), undefined);
});

test("a plan-filing fix round that lowers or rewrites the filing's criteria is refused", async (t) => {
  const call = { claim: "the filing guard is called",
    proof: "grep: planFilingFixRoundRefusal[(] in src/lib/plan-filing-fix-guard.ts" };
  const unrelatedCallProof = "grep: import in src/lib/plan-filing-fix-guard.ts";
  const callInput = input({ priorShards: { [SHARD]: shard([call]) },
    nextShards: { [SHARD]: shard([{ ...call, proof: unrelatedCallProof }]) } });
  assert.match(planFilingFixRoundRefusal(callInput)!, /dropped symbol planFilingFixRoundRefusal/);
  assert.equal(planFilingFixRoundRefusal(input({ priorShards: { [SHARD]: shard([call]) },
    nextShards: { [SHARD]: shard([{ ...call,
      proof: "grep: planFilingFixRoundRefusal( in src/lib/plan-filing-fix-guard.ts" }]) } })), undefined);
  const unrelated = "unit test: unrelated existing behavior";
  for (const [acceptance, pattern] of [
    [criteria.slice(0, 1), /criterion count/],
    [[{ ...criteria[0], claim: "a weaker claim" }, criteria[1]], /claim/],
    [[{ ...criteria[0], proof: "" }, criteria[1]], /dropped its proof/],
    [[criteria[0], { ...criteria[1], proof: "unit test: a generic existing test" }], /someSymbol/],
    [[{ ...criteria[0], proof: unrelated }, criteria[1]], /existing.*outside.*declared/],
  ] as const) {
    assert.match(planFilingFixRoundRefusal(input({ nextShards: { [SHARD]: shard([...acceptance]) },
      mainTestPaths: { [unrelated]: [OTHER] } }))!, pattern);
  }
  const repaired = criteria.map(c => ({ ...c, proof: c.proof.replaceAll("`", "") }));
  assert.equal(planFilingFixRoundRefusal(input({ nextShards: { [SHARD]: shard(repaired) } })), undefined);
  const namedTest = "unit test: someSymbol rejects an invalid filing";
  assert.equal(planFilingFixRoundRefusal(input({ nextShards: { [SHARD]: shard([criteria[0], { ...criteria[1], proof: namedTest }]) },
    mainTestPaths: { [namedTest]: [DECLARED] } })), undefined);
  assert.equal(planFilingFixRoundRefusal(input({ mainTestPaths: { [criteria[0].proof]: [DECLARED] } })), undefined);
  assert.match(planFilingFixRoundRefusal(input({ nextShards: {} }))!, /unreadable|missing/);
  const wrapped = `\`unit test: unrelated existing behavior\``;
  assert.match(planFilingFixRoundRefusal(input({ nextShards: { [SHARD]: shard([{ ...criteria[0], proof: wrapped }, criteria[1]]) },
    mainTestPaths: { [wrapped]: [OTHER] } }))!, /existing.*outside.*declared/);
  const { repo, write, prior } = filing(t);
  for (const target of [OTHER, "test//plan/existing.test.ts", "test/plan/./existing.test.ts",
    "test/plan/../plan/existing.test.ts", "./test/plan/existing.test.ts"]) {
    write(SHARD, shard([{ ...criteria[0], proof: `unit test: ${target}` }, criteria[1]]));
    repo.git("add", "."); repo.git("commit", "-m", "fix(plan): replace proof target");
    const evidence = await readPlanFilingFixRoundInput([SHARD], prior, "HEAD", args => repo.git(...args));
    assert.match(planFilingFixRoundRefusal(evidence)!, /existing.*outside.*declared/, target);
  }
  const explicit = `unit test: ${DECLARED}`;
  for (const [resolved, declared] of [[DECLARED, "test//plan/future.test.ts"],
    ["test/plan/./future.test.ts", DECLARED]]) {
    assert.equal(planFilingFixRoundRefusal(input({
      nextShards: { [SHARD]: shard([{ ...criteria[0], proof: explicit }, criteria[1]]) },
      mainTestPaths: { [explicit]: [resolved] }, declaredFilesByTask: { "W1-T12062": [declared] },
    })), undefined, "equivalent declared paths allow proof-form repair");
  }
});

test("unreadable filing evidence refuses rather than treating it as an empty contract", () => {
  for (const field of ["baselineDiffFiles", "introducedTaskIds", "newCommitMessages", "priorShards", "nextShards", "mainTestPaths", "declaredFilesByTask"] as const) {
    assert.match(planFilingFixRoundRefusal(input({ [field]: undefined }))!, /unreadable|missing/);
  }
  assert.match(planFilingFixRoundRefusal(input({ priorShards: { [SHARD]: "[broken yaml" } }))!, /unreadable/);
  for (const text of ["{}", "[]", "[null]", '[{id: W1-T12062, files: broken}]',
    '[{id: W1-T12062, acceptance: broken}]', '[{id: W1-T12062, acceptance: [null]}]']) {
    assert.match(planFilingFixRoundRefusal(input({ priorShards: { [SHARD]: text } }))!, /unreadable/);
  }
  assert.match(planFilingFixRoundRefusal(input({ priorShards: {} }))!, /missing.*prior shard/);
  assert.match(planFilingFixRoundRefusal(input({ nextShards: { [SHARD]: shard().replace("W1-T12062", "W1-T999") } }))!, /missing introduced task/);
  assert.match(planFilingFixRoundRefusal(input({ declaredFilesByTask: {} }))!, /missing declared files/);
  assert.match(planFilingFixRoundRefusal(input({ nextShards: { [SHARD]: shard([{ ...criteria[0], proof: "unit test: replacement title" }, criteria[1]]) } }))!, /unreadable test paths/);
  assert.match(planFilingFixRoundRefusal(input({ unreadable: "git show failed" }))!, /git show failed/);
});

test("the filing reader compares real commits and resolves unrelated existing test titles", async (t) => {
  const { repo, write, prior } = filing(t);
  write(SHARD, shard([{ ...criteria[0], proof: "unit test: unrelated existing behavior" }, criteria[1]]));
  repo.git("add", "."); repo.git("commit", "-m", "fix(plan): change proof");
  const read = () => readPlanFilingFixRoundInput([SHARD], prior, "HEAD", args => repo.git(...args));
  assert.match(planFilingFixRoundRefusal(await read())!, /existing.*outside.*declared/);
  write(SHARD, shard([{ ...criteria[0], proof: `unit test: ${OTHER}` }, criteria[1]]));
  repo.git("add", "."); repo.git("commit", "-m", "fix(plan): point at existing test path");
  assert.match(planFilingFixRoundRefusal(await read())!, /existing.*outside.*declared/);
  write(SHARD, shard([{ ...criteria[0], proof: `unit test: ${DECLARED}` }, criteria[1]]));
  repo.git("add", "."); repo.git("commit", "-m", "fix(plan): retain declared future test path");
  assert.equal(planFilingFixRoundRefusal(await read()), undefined);
  repo.git("commit", "--allow-empty", "-m", "fix(plan): credit task\n\nRemudero-Task: W1-T12062");
  assert.match(planFilingFixRoundRefusal(await read())!, /Remudero-Task: W1-T12062/);
  const failed = await readPlanFilingFixRoundInput([SHARD], prior, "HEAD", () => { throw new Error("cannot read tree"); });
  assert.match(planFilingFixRoundRefusal(failed)!, /cannot read tree/);
  write(SHARD, shard());
  repo.git("add", "."); repo.git("commit", "-m", "fix(plan): restore title proof");
  const failedGrep = await readPlanFilingFixRoundInput([SHARD], prior, "HEAD", args => {
    if (args[0] === "grep") throw Object.assign(new Error("cannot search tests"), { status: 2 });
    return repo.git(...args);
  });
  assert.match(planFilingFixRoundRefusal(failedGrep)!, /cannot search tests/);
});

test("the plan round refuses appended credit and criterion loss before push or metadata writes", async (t) => {
  for (const scenario of ["credit", "drop", "repair"] as const) {
    const { repo, write, prior } = filing(t);
    const rows: Record<string, unknown>[] = [];
    let pushes = 0;
    let edits = 0;
    const taskId = scenario === "credit" ? "W1-T12062" : "PR-9000";
    const result = await runPlanScopedFixRound({
      task: { id: taskId, title: "filing", files: [SHARD] },
      title: "chore(plan): file task", body: `## Acceptance\n- the task is filed | grep: W1-T12062 in ${SHARD}`,
      worktreePath: repo.dir,
      pr: { prNumber: 9000, prUrl: "https://github.com/acme/remudero/pull/9000", headSha: prior,
        headRefName: `run-${taskId}-123`, priorStrikes: 0, checksState: "red", reviewState: "pending",
        unmetCriteria: [], lastActivityAt: new Date().toISOString(), autoMergeArmed: false },
      deps: {
        preflight: async () => ({ ok: true, failures: [], unreadable: [] }),
        spawn: async () => {
          write(SHARD, shard(scenario === "drop" ? criteria.slice(0, 1) : criteria.map(c => ({ ...c, proof: c.proof.replaceAll("`", "") }))));
          return "COMMIT_MESSAGE: fix(plan): repair proof form\nPR_TITLE: chore(plan): repaired title";
        },
        push: async () => { pushes++; }, updateMetadata: async () => { edits++; },
        log: (step, extra) => rows.push({ step, ...extra }),
      },
    });
    if (scenario === "repair") {
      assert.equal(result.outcome, "pushed", result.reason);
      assert.equal(pushes, 1); assert.equal(edits, 1);
    } else {
      assert.equal(result.outcome, "refused");
      assert.match(result.reason!, scenario === "credit" ? /Remudero-Task: W1-T12062/ : /criterion count/);
      assert.equal(pushes, 0); assert.equal(edits, 0);
      assert.equal(fixRoundTally(rows, taskId, prior).strikes, 0);
    }
  }
});

test("the code lane refuses both worker and generator filing commits without spending a strike", async (t) => {
  for (const files of [[SHARD], [DECLARED]]) {
    for (const scenario of ["credit", "worker", "generator", "head", "evidence"] as const) {
      const { repo, write, prior } = filing(t);
      const rows: Record<string, unknown>[] = [];
      let pushes = 0;
      let workerCommitted = false;
      let headReadFailures = 0;
      let evidenceReadFailures = 0;
      let evidenceReads = 0;
      const execFileSync = childProcess.execFileSync;
      const headRead = t.mock.method(childProcess, "execFileSync", (...args: Parameters<typeof execFileSync>) => {
        if (scenario === "head" && workerCommitted && args[0] === "git" &&
          args[1]?.slice(-2).join(" ") === "rev-parse HEAD") {
          headReadFailures++;
          throw new Error("fixture cannot read result head");
        }
        return execFileSync(...args);
      });
      syncBuiltinESMExports();
      const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = { state: "failure", criteria: [], testTheater: false,
        summary: "blocked", floorDegraded: false, capped: false, keywordOnly: false, planOnly: true, headSha: prior, reviewerOutcome: "failure" };
      const result = await runFixRung({
        taskId: "W1-T12062", runId: `filing-${scenario}`, task: { id: "W1-T12062", title: "filing", files },
        initialSessionId: "fixture-session",
        prUrl: "https://github.com/acme/remudero/pull/9000", branch: "run-W1-T12062-123", worktreePath: repo.dir,
        mount: { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 },
        settingsFile: join(repo.dir, "settings.json"), config: { root: repo.dir } as Config, budgetUsd: 10,
        strikeCap: 1, initialReview: review,
        ciFailures: [{ name: "fixture", logTail: scenario === "generator" ? "Run 'npm run docs-index' and commit the result." : "proof form is invalid" }],
        reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir,
          reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 } },
        deps: {
          spawn: async () => {
            write(SHARD, shard(scenario === "credit" || scenario === "head" || scenario === "evidence"
              ? criteria.map(c => ({ ...c, proof: c.proof.replaceAll("`", "") })) : criteria.slice(0, 1)));
            repo.git("add", "."); repo.git("commit", "-m", "fix(plan): repair filing proof" +
              (scenario === "credit" ? "\n\nRemudero-Task: W1-T12062" : ""));
            workerCommitted = true;
            return { sessionId: "fixture", text: "REPORT\nCOMMIT_MESSAGE: fix(plan): repair proof", blocks: [], stderr: "",
              subtype: "success", isError: false, apiError: false, costUsd: 0, numTurns: 1, permissionDenials: [],
              childEnvKeys: [], model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
              modelUsage: {}, compactionEvents: [], qualitySuspect: false } as WorkerResult;
          },
          waitForCiGreen: async () => { assert.fail("a refused round never waits for CI"); },
          runReview: async () => { assert.fail("a refused round never reviews"); },
          fetchPrBody: async () => "## Acceptance\n- filing | grep: id: in plan/tasks.d/",
          updatePrBody: () => { assert.fail("a refused round never edits the PR body"); },
          fetchPrDiffFiles: async () => [SHARD],
          scopeAmendmentGit: async (_worktree, args) => {
            evidenceReads++;
            if (scenario === "evidence") {
              evidenceReadFailures++;
              throw new Error("fixture cannot read filing evidence");
            }
            return repo.git(...args);
          },
          push: () => { pushes++; },
          issues: { create: () => { assert.fail("no escalation"); }, listOpen: () => [], comment() {} },
          ledgerPath: join(repo.dir, "ledger.ndjson"), log: (step, extra) => rows.push({ step, ...extra }), say() {},
          account: result => result,
          ...(scenario === "generator" ? {
            packageScripts: { "docs-index": "generate", "docs-index:check": "check" },
            runGeneratorScript: async () => ({ status: 0, stdout: "", stderr: "" }),
            commitGeneratorOutput: ({ message }: { message: string }) => {
              repo.git("commit", "--allow-empty", "-m", message);
              return { changed: true, sha: repo.git("rev-parse", "HEAD") };
            },
          } : {}),
        },
      });
      headRead.mock.restore();
      syncBuiltinESMExports();
      assert.equal(result.outcome, "stood_down");
      assert.match(result.reason!, scenario === "generator" || scenario === "credit" ? /Remudero-Task: W1-T12062/ :
        scenario === "head" ? /unreadable.*nextHead/ : scenario === "evidence" ? /cannot read filing evidence/ : /criterion count/);
      if (scenario !== "head") assert.ok(evidenceReads > 0, `filing evidence was read for ${files.join(", ")}`);
      if (scenario === "head") assert.ok(headReadFailures > 0, "the result head read actually failed");
      if (scenario === "evidence") assert.ok(evidenceReadFailures > 0, "the filing evidence read actually failed");
      assert.equal(result.strikes, 0); assert.equal(pushes, 0);
      assert.equal(fixRoundTally(rows, "W1-T12062", prior).strikes, 0);
    }
  }
});
