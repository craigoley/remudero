import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import type { Config } from "#src/lib/config.js";
import type { FixProgressInput } from "#src/lib/fix-progress-judge.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { requestScopeAmendment, type ProofAmendmentWritePorts } from "#src/lib/proof-amendment.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { lintTask, machineAuthorVerifyViolation, taskRulingPin } from "#src/lib/task-linter.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

const taskId = "W1-T10259";
const path = "src/lib/scout-gardener.ts";
const shardPath = `plan/tasks.d/${taskId}-fixture.yaml`;
const now = Date.now();
const pr: OpenPrView = {
  taskId, prNumber: 13039, prUrl: "https://github.com/acme/repo/pull/13039", headSha: "head-a",
  checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0,
  ciFailures: [{ name: "typecheck", logTail: "missing repair" }], redRequiredChecks: ["typecheck"],
  autoMergeArmed: false, lastActivityAt: new Date(now).toISOString(),
};

function history(outcome: string, reason = "path-not-changed"): Record<string, unknown>[] {
  const common = { task_id: taskId, head_sha: pr.headSha, pr_number: pr.prNumber };
  return [
    { ...common, step: "sweep.disposed", disposition: "blocked-fixable", acted: true, red_checks: ["typecheck"] },
    { ...common, step: "fix.dispatch", round_id: "r1", mode: "ci-log", ci_failures: [{ check: "typecheck" }] },
    { ...common, step: "fix.scope_amendment", outcome, kind: outcome, reason, detail: path, paths: [path],
      ...(outcome === "refused" ? {} : { amendmentNumber: 13040 }) },
    { ...common, step: "fix.commit_refused", round_id: "r1", reason: `${reason}: ${path}`,
      scope_amendment_detail: `NEEDS_SCOPE ${path}` },
    { ...common, step: "fix.done", round_id: "r1", fix_outcome: "NEEDS_SCOPE", subtype: "success" },
  ];
}

function sweepFixture(rows: Record<string, unknown>[], escalate = false) {
  const fixed: OpenPrView[] = [];
  const judged: FixProgressInput[] = [];
  const escalations: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/scope-amendment-ledger", runId: "scope-refusal", now: () => now,
    readLedger: () => rows, appendLine: (_p, row) => { rows.push(row); },
    arm: () => assert.fail("red PR cannot arm"), close: () => assert.fail("red PR stays open"),
    dispatchFix: (view) => { fixed.push(view); },
    escalate: (_view, reason) => { escalations.push(reason); },
    fixProgressJudge: async (input) => {
      judged.push(input);
      return escalate ? { verdict: "escalate", loop: "no-op", reason: "repeated refused scope" }
        : { verdict: "continue", reason: "save the missing edit" };
    },
  };
  return { deps, fixed, judged, escalations };
}

test("W1-T10259: a refused scope amendment does not park the PR at its head", async () => {
  const f = sweepFixture(history("refused"));
  const result = await runSweep([{ ...pr, pendingAnswer: { constraint: "preserve the existing repair" } }], f.deps);
  assert.equal(f.fixed.length, 1, JSON.stringify(result.actions));
  assert.equal(result.actions[0]!.acted, true);
  assert.equal(f.escalations.length, 0);
  assert.equal(f.judged.length, 1);
  assert.match(f.judged[0]!.rounds[0]!.refusal!, /path-not-changed: src\/lib\/scout-gardener.ts/);
  assert.equal(f.judged[0]!.rounds[0]!.scopeAmendment?.state, "refused");
  assert.match(f.judged[0]!.parkedReason!, /path-not-changed: src\/lib\/scout-gardener.ts/);
  assert.equal(f.judged[0]!.signals.noOpRounds, 1);
  assert.match(f.fixed[0]!.pendingAnswer!.constraint, /preserve the existing repair/);
  assert.match(f.fixed[0]!.pendingAnswer!.constraint,
    /make the edit to src\/lib\/scout-gardener.ts and leave it saved and uncommitted, then report NEEDS_SCOPE/);
});

test("W1-T10259: a created scope amendment still holds the fix lane", async () => {
  for (const outcome of ["created", "resumed", "branch_update_requested"]) {
    const f = sweepFixture(history(outcome));
    const result = await runSweep([{ ...pr }], f.deps);
    assert.equal(f.fixed.length, 0, outcome);
    assert.equal(f.judged.length, 0, outcome);
    assert.equal(result.actions[0]!.acted, false);
    assert.match(result.actions[0]!.reason, /fix report requests a scope amendment/);
  }
});

test("only this PR head's latest amendment can hold the lane", async () => {
  for (const extra of [{ head_sha: "old-head" }, { task_id: "W1-TOTHER" }, { pr_number: 999 }]) {
    const rows = history("refused");
    rows.push({ ...history("created")[2], ...extra });
    const f = sweepFixture(rows);
    await runSweep([{ ...pr }], f.deps);
    assert.equal(f.fixed.length, 1, JSON.stringify(extra));
  }
  const rows = [...history("created"), ...history("refused")];
  const f = sweepFixture(rows);
  await runSweep([{ ...pr }], f.deps);
  assert.equal(f.fixed.length, 1, "a later refusal supersedes the pending row");
});

test("a merged or closed amendment releases the pending hold", async () => {
  for (const state of ["merged", "closed"]) {
    const rows = [...history("created"), { step: "pr.terminal", pr_number: 13040, state }];
    const f = sweepFixture(rows);
    await runSweep([{ ...pr }], f.deps);
    if (state === "closed") await runSweep([{ ...pr }], f.deps);
    assert.equal(f.fixed.length, 1, state);
  }
});

test("refusals keep their reason and repeated refusals reach the progress judge", async () => {
  for (const reason of ["instrument-path", "test-path", "plan-path", "invalid-path", "no-task-trailer", "main-owned"]) {
    const f = sweepFixture(history("refused", reason), true);
    await runSweep([{ ...pr }], f.deps);
    assert.equal(f.fixed.length, 0);
    assert.equal(f.judged.length, 1, reason);
    assert.match(f.judged[0]!.rounds[0]!.refusal!, new RegExp(reason));
    assert.match(f.escalations[0]!, /repeated refused scope/);
  }
});

test("an older generic refusal still gives the judge the amendment's reason and detail", async () => {
  const rows = history("refused");
  rows[3]!.reason = "non-test paths need scope";
  const f = sweepFixture(rows);
  await runSweep([{ ...pr }], f.deps);
  assert.equal(f.fixed.length, 1);
  assert.match(f.judged[0]!.parkedReason!, /path-not-changed: src\/lib\/scout-gardener.ts/);
});

test("a refused fix round records the amendment reason and detail in the judge's refusal history", async (t) => {
  const repo = gitRepo({ scope: t });
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src/existing.ts"), "export const existing = true;\n");
  repo.git("add", "src/existing.ts");
  repo.git("commit", "-qm", "seed source");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const rows: Record<string, unknown>[] = [];
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
  const review = { state: "failure", criteria: [{ claim: "repair", proof: "unit test: repair", met: false,
    reason: "broken", proof_exec: "not_executable" }], testTheater: false, summary: "broken",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: repo.git("rev-parse", "HEAD"), reviewerOutcome: "failure" } as Parameters<typeof runFixRung>[0]["initialReview"];
  await runFixRung({
    taskId, runId: "scope-missing-edit", task: { id: taskId, title: "repair", files: ["src/existing.ts"] },
    prUrl: pr.prUrl, branch: `run-${taskId}-1`, worktreePath: repo.dir, initialSessionId: "initial",
    mount, settingsFile: join(repo.dir, "settings.json"), budgetUsd: 10, strikeCap: 2, initialReview: review,
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    reviewBase: { owner: "acme", repo: "repo", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      spawn: async () => ({ text: `REPORT\nFIX_OUTCOME: NEEDS_SCOPE ${path}`, blocks: [], sessionId: "fix",
        costUsd: 1, numTurns: 1, subtype: "success", isError: false, apiError: false, permissionDenials: [],
        childEnvKeys: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, stderr: "",
        model: "sonnet", effort: "medium", compactionEvents: [], qualitySuspect: false, modelUsage: {},
        provider: "codex" } as WorkerResult),
      fetchPrBody: async () => `Remudero-Task: ${taskId}`,
      scopeAmendmentWritePorts: { lookupIdentity: () => undefined, probeExisting: () => undefined } as unknown as ProofAmendmentWritePorts,
      push: () => assert.fail("no edit to push"), waitForCiGreen: async () => assert.fail("no new head"),
      runReview: async () => review,
      issues: { create: () => assert.fail("refusal returns to the sweep"), listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, task_id: taskId, ...extra }); }, say: () => {}, account: r => r,
    },
  });
  assert.equal(rows.findLast(row => row.step === "fix.scope_amendment")?.reason, "path-not-changed");
  assert.match(String(rows.findLast(row => row.step === "fix.commit_refused")?.reason),
    /path-not-changed: src\/lib\/scout-gardener.ts/);
});

function machineShard(scout = false, flow = false): string {
  const record = {
    id: taskId, title: "repair a fixture", repo: "remudero", type: "implement", verify: "auto",
    author_class: "machine", origin: scout ? "scout:fixture" : "flow-blocker:fixture", risk: "high",
    band_meaning: "span", depends_on: [], status: "queued", attempts: 0, priority: 1,
    files: ["src/lib/view-shadow.ts", scout ? "test/scout-fixture.test.ts" : "test/fixture.test.ts"],
    acceptance: [{ claim: "repair the fixture", proof: "unit test: repair the fixture" }],
  };
  const task = parseTasksFromYaml(stringify([record]), shardPath)[0]!;
  const text = stringify([{ ...record, risk_ruling: {
    verdict: "low", action: "proceed", confidence: 0.9, reasons: ["bounded fixture"],
    judged_at: new Date(now).toISOString(), pin: taskRulingPin(task),
  } }]);
  return flow ? text.replace(/  files:\n(?:    - .*\n)+/, `  files: [${record.files.join(", ")}]\n`) : text;
}

function amendment(text: string) {
  let written = "";
  let body = "";
  let commit = "";
  const deps: ProofAmendmentWritePorts = {
    repoDir: "/fixture", findShard: () => ({ path: shardPath, text }),
    worktreeAdd: () => {}, worktreeRemove: () => {}, gitAdd: () => {}, gitPush: () => {},
    writeFile: (_p, next) => { written = next; },
    gitCommit: (_p, message) => { commit = message; return "amendment-sha"; },
    probeExisting: () => undefined, lookupIdentity: () => undefined, recordIdentity: () => {},
    worktreePathFor: () => "/amendment", updateBranch: () => ({ ok: true }),
    createPr: (opts) => { body = opts.body; return { prUrl: "https://github.com/acme/repo/pull/13040", prNumber: 13040 }; },
  };
  const outcome = requestScopeAmendment({ taskId, prNumber: pr.prNumber, prUrl: pr.prUrl,
    headSha: pr.headSha, trailerTaskId: taskId, paths: [path], changedPaths: [path] }, deps);
  assert.equal(outcome.kind, "created", JSON.stringify(outcome));
  return { task: parseTasksFromYaml(written, shardPath)[0]!, written, body, commit };
}

test("W1-T10259: a machine task scope amendment re-parks it for the judge", () => {
  const text = machineShard();
  const before = parseTasksFromYaml(text, shardPath)[0]!;
  assert.equal(machineAuthorVerifyViolation(before), undefined, "control: the base ruling is valid");
  const { task, body, commit } = amendment(text);
  assert.equal(task.verify, "human");
  assert.deepEqual(task.files, [...before.files!, path]);
  assert.equal(task.risk_ruling, undefined, "the old ruling must not travel with the amendment");
  assert.equal(machineAuthorVerifyViolation(task), undefined);
  assert.deepEqual(lintTask(task).violations.filter(v => v.severity === "block"), []);
  assert.match(body, /verify.*human/);
  assert.match(commit, /verify.*human/);
});

test("W1-T10259: an amended scout draft keeps the scout test last", () => {
  for (const flow of [false, true]) {
    const { task } = amendment(machineShard(true, flow));
    assert.deepEqual(task.files, ["src/lib/view-shadow.ts", path, "test/scout-fixture.test.ts"]);
    assert.equal(task.verify, "human");
    assert.deepEqual(lintTask(task).violations.filter(v => v.severity === "block"), []);
  }
});

test("a machine scout amendment's generated proofs execute on block and flow files", (t) => {
  const { dir } = ownedFixtureDir(t, "scope-amendment-proofs");
  const file = join(dir, "shard.yaml");
  for (const flow of [false, true]) {
    const before = machineShard(true, flow);
    const { written, body } = amendment(before);
    const proofs = body.split("\n").filter(line => line.startsWith("- ") && line.includes(" | grep: "));
    assert.equal(proofs.length, 2);
    for (const proof of proofs) {
      const pattern = proof.slice(proof.indexOf(" | grep: ") + " | grep: ".length, proof.lastIndexOf(" in "));
      writeFileSync(file, before);
      assert.equal(spawnSync("grep", ["-arn", "--", pattern, file]).status, 1, "proof must miss at base");
      writeFileSync(file, written);
      assert.equal(spawnSync("grep", ["-arn", "--", pattern, file]).status, 0, `${flow}: ${proof}`);
    }
  }
});
