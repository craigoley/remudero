import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import { findTaskShard, requestScopeAmendment, restoreScopeAmendmentWork, saveScopeAmendmentWork,
  type ProofAmendmentWritePorts } from "#src/lib/proof-amendment.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { runFixRung } from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const taskId = "W1-T9805";
const prUrl = "https://github.com/acme/repo/pull/42";
const branch = `run-${taskId}-1`;
const path = "src/lib/rule-suites.ts";
const shardPath = `plan/tasks.d/${taskId}-fixture.yaml`;
const shard = `- id: ${taskId}\n  title: repair\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [src/existing.ts]\n  acceptance:\n    - claim: repaired\n      proof: 'unit test: repaired'\n`;
const content = "export const repaired = true;\n";

function fixture(t: TestContext, pending = true) {
  const origin = gitRepo({ scope: t, bare: true });
  const repo = gitRepo({ scope: t });
  repo.git("config", "user.name", "scope fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), "[]\n");
  writeFileSync(join(repo.dir, shardPath), shard);
  writeFileSync(join(repo.dir, "src/existing.ts"), "export const existing = 1;\n");
  repo.git("add", "-A"); repo.git("commit", "-qm", "seed");
  repo.addRemote("origin", origin.dir);
  repo.git("push", "-q", "origin", "main");
  repo.git("checkout", "-qb", branch);
  writeFileSync(join(repo.dir, "src/existing.ts"), "export const existing = 2;\n");
  repo.git("commit", "-qam", "implementation");
  repo.git("push", "-q", "origin", branch);
  const headSha = repo.git("rev-parse", "HEAD");
  const rows: Array<Record<string, unknown>> = pending ? [{ step: "fix.scope_amendment", task_id: taskId,
    pr_number: 42, head_sha: headSha, outcome: "created", paths: [path] }] : [];
  let merged = pending;
  let identity = pending;
  let updates = 0;
  let spawns = 0;
  let pushes = 0;
  let prompt = "";
  let asking = !pending;
  const ports: ProofAmendmentWritePorts = {
    repoDir: repo.dir, findShard: () => ({ path: shardPath, text: shard }),
    worktreeAdd: () => {}, worktreeRemove: () => {}, writeFile: () => {}, gitAdd: () => {},
    gitCommit: () => "amendment", gitPush: () => {}, probeExisting: () => undefined,
    createPr: () => ({ prUrl: "https://github.com/acme/repo/pull/99", prNumber: 99 }),
    worktreePathFor: () => "/amendment", lookupIdentity: () => identity ? {
      amendmentUrl: "https://github.com/acme/repo/pull/99", amendmentNumber: 99, merged,
    } : undefined,
    recordIdentity: () => { identity = true; },
    updateBranch: () => { updates++; return { ok: true }; },
  };
  const review = { state: "failure", criteria: [{ claim: "repaired", proof: "unit test: repaired", met: false,
    reason: "broken", proof_exec: "executed_fail" }], summary: "broken", testTheater: false, floorDegraded: false,
    capped: false, keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "failure" } as
    Parameters<typeof runFixRung>[0]["initialReview"];
  const opts: Parameters<typeof runFixRung>[0] = {
    guardRoundHead: true, taskId, runId: "scope-round", task: { id: taskId, title: "repair", files: ["src/existing.ts"] },
    prUrl, branch, worktreePath: repo.dir, initialSessionId: "initial",
    mount: { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 }, settingsFile: join(origin.dir, "settings.json"),
    config: { root: join(origin.dir, "state-root"), workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "typecheck", logTail: `missing ${path}` }],
    reviewBase: { owner: "acme", repo: "repo", headCheckoutDir: repo.dir,
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      spawn: async (args) => {
        spawns++; prompt = args.prompt;
        if (!asking && !pending) assert.equal(readFileSync(join(repo.dir, path), "utf8"), content);
        writeFileSync(join(repo.dir, path), content);
        return { text: asking ? `REPORT\nFIX_OUTCOME: NEEDS_SCOPE ${path}` :
          "REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(scope): repair admitted file", blocks: [], sessionId: "fix",
          costUsd: 1, numTurns: 1, subtype: "success", isError: false, apiError: false, permissionDenials: [],
          childEnvKeys: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, stderr: "",
          model: "sonnet", effort: "medium", compactionEvents: [], qualitySuspect: false, modelUsage: {}, provider: "codex" } as WorkerResult;
      },
      scopeAmendmentWritePorts: ports, fetchPrBody: async () => `Remudero-Task: ${taskId}`,
      push: (_wt, _branch, sha, prior) => {
        pushes++;
        assert.equal(prior, headSha, "the local merge must not become the expected remote tip");
        assert.equal(sha, repo.git("rev-parse", "HEAD"));
        repo.git("merge-base", "--is-ancestor", "origin/main", "HEAD");
        assert.equal(repo.git("show", `HEAD:${path}`) + "\n", content);
      },
      readRemoteBranchHead: async () => repo.git("rev-parse", "HEAD"),
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success", criteria: [], headSha: repo.git("rev-parse", "HEAD") }),
      issues: { create: () => assert.fail("must not escalate"), listOpen: () => [], comment: () => {} },
      ledgerPath: join(origin.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, task_id: taskId, ...extra }); }, say: () => {}, account: (r) => r,
    },
  };
  const mergeAmendment = (conflict = false) => {
    repo.git("checkout", "-q", "main");
    writeFileSync(join(repo.dir, shardPath), shard.replace("[src/existing.ts]", `[src/existing.ts, ${path}]`));
    if (conflict) writeFileSync(join(repo.dir, "src/existing.ts"), "export const existing = 3;\n");
    repo.git("commit", "-qam", "scope amendment");
    repo.git("push", "-q", "origin", "main");
    repo.git("checkout", "-q", branch);
    merged = true; asking = false;
  };
  return { repo, opts, rows, ports, headSha, mergeAmendment,
    counts: () => ({ updates, spawns, pushes }), prompt: () => prompt };
}

test("W1-T9805: a merged scope amendment dispatches the fix in the same round", async (t) => {
  const f = fixture(t); f.mergeAmendment();
  const result = await runFixRung(f.opts);
  assert.equal(result.outcome, "fixed", JSON.stringify({ result, rows: f.rows }));
  assert.equal(result.strikes, 1);
  assert.deepEqual(f.counts(), { updates: 0, spawns: 1, pushes: 1 });
  const row = f.rows.findLast((r) => r.step === "fix.scope_amendment");
  assert.equal(row?.outcome, "amendment_merged");
  assert.equal(row?.merged_locally, true);
  assert.equal(row?.merge_sha, f.repo.git("rev-parse", "HEAD^"));
  assert.deepEqual(parse(findTaskShard(f.repo.dir, taskId)!.text)[0].files, ["src/existing.ts", path]);
  assert.match(f.prompt(), /typecheck/);
  assert.match(f.prompt(), /missing.*src\/lib\/rule-suites.ts/);
  assert.match(String(row?.recovery_reason), /missing/i);
  assert.match(f.prompt(), /src\/lib\/rule-suites.ts/);
});

test("W1-T9805: a conflicting local merge falls back to the branch update", async (t) => {
  const f = fixture(t); f.mergeAmendment(true);
  const result = await runFixRung(f.opts);
  assert.equal(result.outcome, "stood_down");
  assert.equal(result.strikes, 0);
  assert.deepEqual(f.counts(), { updates: 1, spawns: 0, pushes: 0 });
  const row = f.rows.findLast((r) => r.step === "fix.scope_amendment");
  assert.equal(row?.outcome, "branch_update_requested");
  assert.match(String(row?.reason), /CONFLICT|conflict/);
  assert.equal(f.repo.git("rev-parse", "HEAD"), f.headSha);
  assert.equal(f.repo.git("status", "--porcelain"), "");
});

test("W1-T9805: a merged amendment identity is reported, not branch-updated", (t) => {
  const f = fixture(t);
  assert.deepEqual(requestScopeAmendment({ taskId, prNumber: 42, prUrl, headSha: f.headSha,
    trailerTaskId: taskId, paths: [path], changedPaths: [path] }, f.ports), { kind: "amendment_merged", amendmentNumber: 99 });
  assert.deepEqual(f.counts(), { updates: 0, spawns: 0, pushes: 0 });
});

test("W1-T9805: the file the asking round wrote is restored once its amendment merges", async (t) => {
  const f = fixture(t, false);
  assert.equal((await runFixRung(f.opts)).outcome, "stood_down");
  const saved = f.rows.findLast((r) => r.step === "fix.scope_amendment");
  assert.equal(saved?.recovery_status, "saved");
  assert.ok(typeof saved?.recovery_path === "string" && existsSync(saved.recovery_path));
  rmSync(join(f.repo.dir, path));
  f.mergeAmendment();
  const result = await runFixRung(f.opts);
  assert.equal(result.outcome, "fixed", JSON.stringify({ result, rows: f.rows }));
  assert.deepEqual(f.counts(), { updates: 0, spawns: 2, pushes: 1 });
  const restored = f.rows.findLast((r) => r.step === "fix.scope_amendment");
  assert.equal(restored?.recovery_status, "restored");
  assert.deepEqual(restored?.restored_paths, [path]);
  assert.match(f.prompt(), /restored.*round that asked for scope/i);
});

test("scope recovery verifies content, preserves modes and deletions, and never replaces an asking round's save", (t) => {
  const f = fixture(t);
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42, amendmentNumber: 99,
    paths: [path, "src/deleted.ts"] };
  const bytes = Buffer.from([0, 1, 255, 10]);
  writeFileSync(join(f.repo.dir, path), bytes); chmodSync(join(f.repo.dir, path), 0o755);
  const saved = saveScopeAmendmentWork(input);
  writeFileSync(join(f.repo.dir, path), "later work");
  assert.equal(saveScopeAmendmentWork(input), saved);
  writeFileSync(join(f.repo.dir, "src/deleted.ts"), "must be deleted again");
  assert.deepEqual(restoreScopeAmendmentWork(input), ["src/deleted.ts", path]);
  assert.deepEqual(readFileSync(join(f.repo.dir, path)), bytes);
  assert.equal(statSync(join(f.repo.dir, path)).mode & 0o777, 0o755);
  assert.equal(existsSync(join(f.repo.dir, "src/deleted.ts")), false);
  assert.throws(() => restoreScopeAmendmentWork({ ...input, prNumber: 43 }), /missing/);
  const record = JSON.parse(readFileSync(saved, "utf8"));
  writeFileSync(saved, JSON.stringify({ ...record, payload: "[]" }));
  assert.throws(() => restoreScopeAmendmentWork(input), /digest did not verify/);
  assert.deepEqual(readFileSync(join(f.repo.dir, path)), bytes);
  const payload = JSON.stringify([{ path: "src/unrequested.ts", data: "", mode: 0o644 }]);
  writeFileSync(saved, JSON.stringify({ ...record, payload, digest: createHash("sha256").update(payload).digest("hex") }));
  assert.throws(() => restoreScopeAmendmentWork(input), /paths or file content did not verify/);
  assert.equal(existsSync(join(f.repo.dir, "src/unrequested.ts")), false);
});

test("scope recovery refuses symlinks and traversal at both save and restore", (t) => {
  const f = fixture(t);
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42, amendmentNumber: 99, paths: [path] };
  writeFileSync(join(f.repo.dir, path), content);
  saveScopeAmendmentWork(input);
  rmSync(join(f.repo.dir, "src/lib"), { recursive: true });
  const outside = join(f.opts.config.root, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(f.repo.dir, "src/lib"));
  assert.throws(() => restoreScopeAmendmentWork(input), /regular path/);
  assert.throws(() => saveScopeAmendmentWork({ ...input, amendmentNumber: 100 }), /regular path/);
  assert.equal(existsSync(join(outside, "rule-suites.ts")), false);
  assert.throws(() => saveScopeAmendmentWork({ ...input, paths: ["../outside.ts"] }), /unsafe/);
});

test("an unverifiable asking-round save is named in the ledger and the worker evidence", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo.dir, path), content);
  const saved = saveScopeAmendmentWork({ root: f.opts.config.root, worktreePath: f.repo.dir,
    taskId, prNumber: 42, amendmentNumber: 99, paths: [path] });
  writeFileSync(saved, "{}"); rmSync(join(f.repo.dir, path));
  f.mergeAmendment();
  assert.equal((await runFixRung(f.opts)).outcome, "fixed");
  const row = f.rows.findLast((r) => r.step === "fix.scope_amendment");
  assert.equal(row?.recovery_status, "unavailable");
  assert.match(String(row?.recovery_reason), /did not verify/);
  assert.match(f.prompt(), /admitted src\/lib\/rule-suites.ts.*Saved work unavailable/);
});

test("a failed local fetch and branch update are reported without spending a strike", async (t) => {
  const f = fixture(t);
  f.repo.git("remote", "set-url", "origin", join(f.repo.dir, "absent-origin"));
  f.opts.deps.scopeAmendmentWritePorts = { ...f.ports, updateBranch: () => { throw new Error("update unavailable"); } };
  assert.equal((await runFixRung(f.opts)).outcome, "stood_down");
  assert.equal(f.counts().spawns, 0);
  const row = f.rows.findLast((r) => r.step === "fix.scope_amendment");
  assert.equal(row?.outcome, "branch_update_requested");
  assert.equal(row?.ok, false);
  assert.match(String(row?.error), /update unavailable/);
  assert.match(String(row?.reason), /absent-origin/);
  assert.equal(f.repo.git("rev-parse", "HEAD"), f.headSha);
});

test("a merge abort failure is carried into the fallback reason", async (t) => {
  const f = fixture(t); f.mergeAmendment(true);
  f.opts.deps.scopeAmendmentGit = async (cwd, args, options) => {
    if (args[0] === "merge" && args[1] === "--abort") throw new Error("abort unavailable");
    return hostWorktreeGitAsync(cwd, args, options);
  };
  assert.equal((await runFixRung(f.opts)).outcome, "stood_down");
  assert.deepEqual(f.counts(), { updates: 1, spawns: 0, pushes: 0 });
  assert.match(String(f.rows.findLast((r) => r.step === "fix.scope_amendment")?.reason), /merge abort:.*abort unavailable/);
});

test("a save failure names the asking round's unavailable recovery", async (t) => {
  const f = fixture(t, false);
  const spawn = f.opts.deps.spawn;
  f.opts.deps.spawn = async (args) => {
    const result = await spawn(args);
    rmSync(join(f.repo.dir, path));
    symlinkSync(join(f.repo.dir, "src/existing.ts"), join(f.repo.dir, path));
    return result;
  };
  assert.equal((await runFixRung(f.opts)).outcome, "stood_down");
  const row = f.rows.findLast((r) => r.step === "fix.scope_amendment");
  assert.equal(row?.outcome, "created");
  assert.equal(row?.recovery_status, "unavailable");
  assert.match(String(row?.recovery_reason), /regular path/);
});

test("a merged identity without its widened contract falls back without running the worker", async (t) => {
  const f = fixture(t);
  assert.equal((await runFixRung(f.opts)).outcome, "stood_down");
  assert.deepEqual(f.counts(), { updates: 1, spawns: 0, pushes: 0 });
  const row = f.rows.findLast((r) => r.step === "fix.scope_amendment");
  assert.equal(row?.outcome, "branch_update_requested");
  assert.match(String(row?.reason), /locally merged task contract does not admit/);
  assert.equal(f.repo.git("status", "--porcelain"), "");
});
