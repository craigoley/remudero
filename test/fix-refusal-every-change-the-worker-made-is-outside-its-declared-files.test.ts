import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ciLogNamedSourcePaths, runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const inherited = "src/inherited.ts";
const rogue = "src/rogue.ts";
const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 20, contextBudget: 120000 };

async function repair(baseline: "known" | "absent" | "failed", edit: string, mixed = false) {
  const repo = gitRepo({ kind: "w1-t5385" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src/declared.ts"), "export const declared = 1;\n");
  repo.git("add", "src/declared.ts");
  repo.git("commit", "-qm", "seed declared surface");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, inherited), "export const inherited = 1;\n");
  repo.git("add", inherited);
  repo.git("commit", "-qm", "inherited implementation");
  const before = repo.git("rev-parse", "HEAD");
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  let spawns = 0;
  let pushes = 0;
  let waits = 0;
  let diffReads = 0;
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair inherited implementation", proof: "unit test: repair",
      met: false, reason: "wrong value", proof_exec: "not_executable" }],
    summary: "wrong value", testTheater: false, floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: before, reviewerOutcome: "failure",
  };
  const outcome = await runFixRung({
    taskId: "W1-T5385X", runId: "W1-T5385X-run",
    task: { id: "W1-T5385X", title: "repair inherited implementation", files: ["src/declared.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/1", branch: "run-W1-T5385X-1",
    worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    deps: {
      spawn: async () => {
        spawns++;
        writeFileSync(join(repo.dir, edit), "export const repaired = 2;\n");
        if (mixed) writeFileSync(join(repo.dir, rogue), "export const rogue = 2;\n");
        return {
          sessionId: "fix-session", costUsd: 0, numTurns: 1,
          text: "COMMIT_MESSAGE: fix(ci): repair inherited implementation", blocks: [], stderr: "",
          subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        } satisfies WorkerResult;
      },
      ...(baseline === "absent" ? {} : { fetchPrDiffFiles: async () => {
        diffReads++;
        if (baseline === "failed") throw new Error("diff unavailable");
        // The live view can change; commit permission comes from the pre-rung snapshot.
        return diffReads === 1 ? [inherited] : ["src/declared.ts"];
      } }),
      waitForCiGreen: async () => { waits++; return "green"; },
      runReview: async () => ({ ...review, state: "success", criteria: [],
        headSha: repo.git("rev-parse", "HEAD"), reviewerOutcome: "success" }),
      fetchPrBody: async () => "repair inherited implementation",
      readHeadShaForProvenance: () => repo.git("rev-parse", "HEAD"),
      push: () => { pushes++; },
      issues: { create: () => { throw new Error("unexpected escalation"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"),
      log: (step, extra) => rows.push({ step, ...extra }), say: () => {}, account: (result) => result,
    },
  });
  return { repo, before, outcome, rows, spawns, pushes, waits };
}

test("W1-T5385: fix_refusal:every-change-the-worker-made-is-outside-its-declared-files is prevented, not retried", async () => {
  const result = await repair("known", inherited);
  assert.equal(result.outcome.outcome, "fixed");
  assert.equal(result.spawns, 1, "the repair lands without another worker round or resume");
  assert.equal(result.outcome.strikes, 1);
  assert.equal(result.pushes, 1);
  assert.equal(result.waits, 1);
  assert.equal(result.rows.some((row) => row.step === "fix.commit_refused"), false);
  assert.equal(result.repo.git("show", "--format=", "--name-only", "HEAD"), inherited);
  assert.equal(result.repo.git("show", `HEAD:${inherited}`), "export const repaired = 2;");
});

test("W1-T5385: new out-of-scope edits stay refused", async () => {
  const result = await repair("known", rogue);
  assert.equal(result.outcome.outcome, "stood_down");
  assert.equal(result.spawns, 1);
  assert.equal(result.pushes, 0);
  assert.equal(result.waits, 0);
  assert.equal(result.repo.git("rev-parse", "HEAD"), result.before);
  const refusal = result.rows.find((row) => row.step === "fix.commit_refused");
  assert.equal(refusal?.reason, "every change the worker made is outside its declared files");
});

test("W1-T5385: unknown inherited scope never grants commit permission", async () => {
  for (const baseline of ["absent", "failed"] as const) {
    const result = await repair(baseline, inherited);
    assert.equal(result.outcome.outcome, "stood_down", baseline);
    assert.equal(result.pushes, 0);
    assert.equal(result.repo.git("rev-parse", "HEAD"), result.before);
  }
});

test("W1-T5385: a mixed repair stages only the inherited edit", async () => {
  const result = await repair("known", inherited, true);
  assert.equal(result.outcome.outcome, "fixed");
  assert.equal(result.repo.git("show", "--format=", "--name-only", "HEAD"), inherited);
  assert.match(result.repo.git("status", "--porcelain"), /\?\? src\/rogue.ts/);
  assert.deepEqual(result.rows.find((row) => row.step === "implement.harness_commit")?.undeclared, [rogue]);
});

test("W1-T5801: fix_refusal:every-change-the-worker-made-is-outside-its-declared-files is prevented, not retried", async () => {
  const repo = gitRepo({ kind: "w1-t5801" });
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src/named.ts"), "export const named = 1;\n");
  const failures = [{ name: "unit", logTail: "at f (src/named.ts:12:3)\nat g (src/missing.ts:1:1)\nat h (../src/named.ts:1:1)" }];
  // A file the failing log names and that exists is reachable for this repair, so the round is not refused.
  assert.deepEqual(ciLogNamedSourcePaths(failures, repo.dir), [{ path: "src/named.ts", job: "unit" }]);
  assert.deepEqual(ciLogNamedSourcePaths([{ name: "unit", logTail: "no paths here" }], repo.dir), []);
  // A path the log never names stays refused.
  const result = await repair("known", rogue);
  assert.equal(result.outcome.outcome, "stood_down");
});

// #10369: a fix round patched main's own typecheck break in an undeclared file the CI log named,
// then sat conflicting with main's real fix. A log-named path main moved since the merge base is main's red.
function branchBehindMain() {
  const repo = gitRepo({ kind: "main-owned-remedy" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src/declared.ts"), "export const declared = 1;\n");
  writeFileSync(join(repo.dir, "src/shared.ts"), "export const shared = 1;\n");
  writeFileSync(join(repo.dir, "src/both.ts"), "export const both = 1;\n");
  repo.git("add", "src");
  repo.git("commit", "-qm", "seed");
  const seed = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "src/shared.ts"), "export const shared = 2;\n");
  writeFileSync(join(repo.dir, "src/both.ts"), "export const both = 2;\n");
  repo.git("add", "src");
  repo.git("commit", "-qm", "main repairs shared");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("reset", "-q", "--hard", seed);
  writeFileSync(join(repo.dir, "src/declared.ts"), "export const declared = 2;\n");
  writeFileSync(join(repo.dir, "src/both.ts"), "export const both = 3;\n");
  repo.git("add", "src");
  repo.git("commit", "-qm", "the PR's own change");
  return repo;
}

test("a path main changed since the merge base and this branch did not is main's red, not this PR's", async () => {
  const runTask = await import("../src/run-task.js");
  const mainOwnedPaths = (runTask as Record<string, unknown>).mainOwnedPaths as
    ((dir: string, paths: string[]) => { outcome: string; owned: string[] }) | undefined;
  assert.equal(typeof mainOwnedPaths, "function");
  const repo = branchBehindMain();
  assert.deepEqual(mainOwnedPaths!(repo.dir, ["src/shared.ts", "src/both.ts", "src/declared.ts"]),
    { outcome: "compared", owned: ["src/shared.ts"] });
  repo.git("update-ref", "-d", "refs/remotes/origin/main");
  const noBase = mainOwnedPaths!(repo.dir, ["src/shared.ts"]);
  assert.deepEqual([noBase.outcome, noBase.owned], ["no-base", []]);
});

async function mainOwnedRound(report: string) {
  const repo = branchBehindMain();
  const before = repo.git("rev-parse", "HEAD");
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  let pushes = 0;
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "selector edge", proof: "unit test: edge", met: false, reason: "red",
      proof_exec: "not_executable" }], summary: "red", testTheater: false, floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: before, reviewerOutcome: "failure",
  };
  let spawns = 0;
  const outcome = await runFixRung({
    taskId: "W1-T9369X", runId: "W1-T9369X-run",
    task: { id: "W1-T9369X", title: "selector edge", files: ["src/declared.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/1", branch: "run-W1-T9369X-1",
    worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "ci-shard (1/8)", logTail: "src/shared.ts(1,14): error TS2339: Property 'readPaced' does not exist" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    deps: {
      spawn: async () => {
        spawns++;
        writeFileSync(join(repo.dir, "src/shared.ts"), "export const shared = 9;\n");
        return {
          sessionId: "fix-session", costUsd: 0, numTurns: 1,
          text: report, blocks: [], stderr: "",
          subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        } satisfies WorkerResult;
      },
      fetchPrDiffFiles: async () => ["src/declared.ts", "src/both.ts"],
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success", criteria: [], headSha: repo.git("rev-parse", "HEAD"), reviewerOutcome: "success" }),
      fetchPrBody: async () => "selector edge",
      readHeadShaForProvenance: () => repo.git("rev-parse", "HEAD"),
      push: () => { pushes++; },
      issues: { create: () => { throw new Error("unexpected escalation"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"),
      log: (step, extra) => rows.push({ step, ...extra }), say: () => {}, account: (result) => result,
    },
  });
  return { repo, before, rows, pushes, spawns, outcome };
}

test("a fix round never commits a log-named file main is repairing; the red is main's to fix", async () => {
  const round = await mainOwnedRound("FIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(read-model): work around main's typecheck");
  assert.equal(round.spawns, 1, "the round ran");
  assert.equal(round.repo.git("rev-parse", "HEAD"), round.before, "main's file never lands in this PR");
  assert.equal(round.pushes, 0);
  assert.notEqual(round.outcome.outcome, "fixed");
  assert.deepEqual(round.rows.find((row) => row.step === "fix.remedy_path_main_owned")?.paths, ["src/shared.ts"]);
});

test("a scope amendment for a file main is repairing is refused as main-owned, not filed", async () => {
  const round = await mainOwnedRound("FIX_OUTCOME: NEEDS_SCOPE src/shared.ts");
  const amendment = round.rows.find((row) => row.step === "fix.scope_amendment");
  assert.equal(amendment?.reason, "main-owned");
  assert.match(String(amendment?.detail), /main changed src\/shared\.ts since this PR's merge base/);
  assert.equal(round.repo.git("rev-parse", "HEAD"), round.before);
});
