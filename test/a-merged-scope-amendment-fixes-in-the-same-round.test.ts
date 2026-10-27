import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import { findTaskShard, requestScopeAmendment, restoreScopeAmendmentWork, saveScopeAmendmentWork,
  type ProofAmendmentWritePorts } from "#src/lib/proof-amendment.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { isRmdError, exitCodeFor } from "#src/lib/errors.js";
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

test("scope recovery verifies content, preserves modes and deletions, and never replaces an asking round's save", async (t) => {
  const f = fixture(t);
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42, amendmentNumber: 99,
    paths: [path, "src/deleted.ts"] };
  const bytes = Buffer.from([0, 1, 255, 10]);
  writeFileSync(join(f.repo.dir, path), bytes); chmodSync(join(f.repo.dir, path), 0o755);
  const saved = await saveScopeAmendmentWork(input);
  rmSync(join(f.repo.dir, path));
  assert.equal(await saveScopeAmendmentWork(input), saved);
  writeFileSync(join(f.repo.dir, "src/deleted.ts"), "must be deleted again");
  assert.deepEqual(await restoreScopeAmendmentWork(input), ["src/deleted.ts", path]);
  assert.deepEqual(readFileSync(join(f.repo.dir, path)), bytes);
  assert.equal(statSync(join(f.repo.dir, path)).mode & 0o777, 0o755);
  assert.equal(existsSync(join(f.repo.dir, "src/deleted.ts")), false);
  await assert.rejects(restoreScopeAmendmentWork({ ...input, prNumber: 43 }), /missing/);
  const record = JSON.parse(readFileSync(saved, "utf8"));
  writeFileSync(saved, JSON.stringify({ ...record, payload: "[]" }));
  await assert.rejects(saveScopeAmendmentWork(input), /digest did not verify/);
  await assert.rejects(restoreScopeAmendmentWork(input), /digest did not verify/);
  assert.deepEqual(readFileSync(join(f.repo.dir, path)), bytes);
  const payload = JSON.stringify([{ path: "src/unrequested.ts", data: "", mode: 0o644 }]);
  writeFileSync(saved, JSON.stringify({ ...record, payload, digest: createHash("sha256").update(payload).digest("hex") }));
  await assert.rejects(restoreScopeAmendmentWork(input), /paths or file content did not verify/);
  assert.equal(existsSync(join(f.repo.dir, "src/unrequested.ts")), false);
});

test("scope recovery adopts a record created between its missing read and exclusive publish", async (t) => {
  const f = fixture(t);
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42,
    amendmentNumber: 99, paths: [path] };
  writeFileSync(join(f.repo.dir, path), "winner's work");
  const saved = await saveScopeAmendmentWork(input);
  const winner = readFileSync(saved, "utf8");
  rmSync(saved);
  writeFileSync(join(f.repo.dir, path), "loser's work");
  let winnerPublished = 0;
  const racingInput = { ...input, get worktreePath() {
    winnerPublished++;
    writeFileSync(saved, winner, { flag: "wx" });
    return f.repo.dir;
  } };
  assert.equal(await saveScopeAmendmentWork(racingInput), saved);
  assert.equal(winnerPublished, 1);
  assert.equal(readFileSync(saved, "utf8"), winner);
  assert.deepEqual(readdirSync(dirname(saved)).filter((name) => name.endsWith(".tmp")), []);
  assert.deepEqual(await restoreScopeAmendmentWork(input), [path]);
  assert.equal(readFileSync(join(f.repo.dir, path), "utf8"), "winner's work");
});

test("scope recovery refuses symlinks and traversal at both save and restore", async (t) => {
  const f = fixture(t);
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42, amendmentNumber: 99, paths: [path] };
  writeFileSync(join(f.repo.dir, path), content);
  await saveScopeAmendmentWork(input);
  rmSync(join(f.repo.dir, "src/lib"), { recursive: true });
  const outside = join(f.opts.config.root, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(f.repo.dir, "src/lib"));
  await assert.rejects(restoreScopeAmendmentWork(input), /regular path/);
  await assert.rejects(saveScopeAmendmentWork({ ...input, amendmentNumber: 100 }), /regular path/);
  assert.equal(existsSync(join(outside, "rule-suites.ts")), false);
  await assert.rejects(saveScopeAmendmentWork({ ...input, paths: ["../outside.ts"] }), /unsafe/);
});

function scopeRace(t: TestContext, f: ReturnType<typeof fixture>, action: "save" | "restore", component: "leaf" | "ancestor") {
  const outside = join(f.opts.config.root, "outside-race");
  mkdirSync(join(outside, "lib"), { recursive: true });
  const sentinel = join(outside, "lib/rule-suites.ts");
  writeFileSync(sentinel, "OUTSIDE_SENTINEL", { mode: 0o640 });
  const outsideMode = statSync(sentinel).mode & 0o777;
  const target = component === "leaf" ? join(f.repo.dir, path) : join(f.repo.dir, "src");
  const destination = component === "leaf" ? sentinel : outside;
  let fires = 0;
  const original = fs.lstatSync;
  const mock = t.mock.method(fs, "lstatSync", ((name: Parameters<typeof fs.lstatSync>[0], options?: unknown) => {
    const result = original(name, options as never);
    if (String(name) === target && fires === 0) {
      fires++;
      renameSync(target, target + "-raced"); symlinkSync(destination, target);
    }
    return result;
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const operation = action === "restore" && component === "leaf" ? "stat" : "open";
  const needle = component === "leaf" ? "rule-suites.ts" : "src";
  const hook = `
import os, sys
original = os.${operation}
fired = False
def racing(*args, **kwargs):
    global fired
    result = original(*args, **kwargs)
    if args[0] == ${JSON.stringify(needle)} and kwargs.get("dir_fd") is not None and not fired:
        fired = True
        parent = kwargs["dir_fd"]
        os.rename(args[0], args[0] + "-raced", src_dir_fd=parent, dst_dir_fd=parent)
        os.symlink(${JSON.stringify(destination)}, args[0], dir_fd=parent)
        sys.stderr.write("scope-race-fired\\n")
    return result
os.${operation} = racing
os.supports_dir_fd.add(racing)
`;
  const io = { run(script: string, input: string): string {
    const result = spawnSync("python3", ["-I", "-c", hook + script], { input, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "scope-race-fired\n", "the descriptor-path race must actually fire once");
    fires++;
    return result.stdout;
  } };
  return { io, sentinel, outside, outsideMode, fired: () => fires };
}

for (const component of ["leaf", "ancestor"] as const) {
  test(`scope recovery pins its save descriptors across a ${component} replacement`, async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.repo.dir, path), content);
    const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42,
      amendmentNumber: 99, paths: [path] };
    const race = scopeRace(t, f, "save", component);
    const saved = await saveScopeAmendmentWork(input, race.io);
    assert.equal(race.fired(), 1, "one real replacement, including on the pre-fix implementation");
    const entries = JSON.parse(JSON.parse(readFileSync(saved, "utf8")).payload);
    assert.equal(Buffer.from(entries[0].data, "base64").toString(), content, "save followed an outside-worktree replacement");
    assert.equal(readFileSync(race.sentinel, "utf8"), "OUTSIDE_SENTINEL");
  });
  test(`scope recovery pins its restore descriptors across a ${component} replacement`, async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.repo.dir, path), content);
    const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42,
      amendmentNumber: 99, paths: [path] };
    await saveScopeAmendmentWork(input);
    const race = scopeRace(t, f, "restore", component);
    assert.deepEqual(await restoreScopeAmendmentWork(input, race.io), [path]);
    assert.equal(race.fired(), 1);
    assert.equal(readFileSync(race.sentinel, "utf8"), "OUTSIDE_SENTINEL", "restore followed an outside-worktree replacement");
    assert.equal(statSync(race.sentinel).mode & 0o777, race.outsideMode, "restore changed an outside file's mode");
    assert.equal(readFileSync(join(f.repo.dir, component === "ancestor" ? "src-raced/lib/rule-suites.ts" : path), "utf8"), content);
  });
}

test("scope recovery deletes through a pinned parent after an ancestor replacement", async (t) => {
  const f = fixture(t);
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42,
    amendmentNumber: 99, paths: [path] };
  rmSync(join(f.repo.dir, path), { force: true });
  await saveScopeAmendmentWork(input);
  writeFileSync(join(f.repo.dir, path), "delete this inside file");
  const race = scopeRace(t, f, "restore", "ancestor");
  assert.deepEqual(await restoreScopeAmendmentWork(input, race.io), [path]);
  assert.equal(race.fired(), 1);
  assert.equal(readFileSync(race.sentinel, "utf8"), "OUTSIDE_SENTINEL", "restore deleted an outside-worktree file");
  assert.equal(existsSync(join(f.repo.dir, "src-raced/lib/rule-suites.ts")), false);
});

test("scope recovery refuses a hard-linked save rather than reading an outside file", async (t) => {
  const f = fixture(t);
  const outside = join(f.opts.config.root, "outside-hardlink");
  mkdirSync(dirname(outside), { recursive: true });
  writeFileSync(outside, "OUTSIDE_SENTINEL");
  linkSync(outside, join(f.repo.dir, path));
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42,
    amendmentNumber: 99, paths: [path] };
  await assert.rejects(saveScopeAmendmentWork(input), /regular path/);
  assert.equal(readFileSync(outside, "utf8"), "OUTSIDE_SENTINEL");
});

test("scope recovery replaces restore targets without modifying their other hard links", async (t) => {
  const f = fixture(t);
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42,
    amendmentNumber: 99, paths: [path] };
  writeFileSync(join(f.repo.dir, path), content);
  await saveScopeAmendmentWork(input);
  const outside = join(f.opts.config.root, "outside-hardlink");
  writeFileSync(outside, "OUTSIDE_SENTINEL", { mode: 0o640 });
  const outsideMode = statSync(outside).mode & 0o777;
  rmSync(join(f.repo.dir, path)); linkSync(outside, join(f.repo.dir, path));
  await restoreScopeAmendmentWork(input);
  assert.equal(readFileSync(outside, "utf8"), "OUTSIDE_SENTINEL");
  assert.equal(statSync(outside).mode & 0o777, outsideMode);
  assert.equal(readFileSync(join(f.repo.dir, path), "utf8"), content);
});

test("scope recovery creates missing parents safely and refuses unavailable descriptor operations", async (t) => {
  const f = fixture(t);
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42,
    amendmentNumber: 99, paths: [path] };
  writeFileSync(join(f.repo.dir, path), content); await saveScopeAmendmentWork(input);
  rmSync(join(f.repo.dir, "src/lib"), { recursive: true });
  assert.deepEqual(await restoreScopeAmendmentWork(input), [path]);
  assert.equal(readFileSync(join(f.repo.dir, path), "utf8"), content);
  await assert.rejects(restoreScopeAmendmentWork(input, { run: () => JSON.stringify({ ok: false,
    error: "descriptor-relative scope recovery is unavailable" }) }), /unavailable/);
  await assert.rejects(restoreScopeAmendmentWork(input, { run: () => '{"ok":true}' }), /response did not verify/);
  await assert.rejects(restoreScopeAmendmentWork(input, { run: () => { throw new Error("python3 unavailable"); } }), /python3 unavailable/);
});

test("scope recovery awaits asynchronous IO before publishing its immutable record", async (t) => {
  const f = fixture(t);
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42,
    amendmentNumber: 99, paths: [path] };
  let release!: (value: string) => void;
  const pending = saveScopeAmendmentWork(input, { run: () => new Promise<string>((resolveIo) => { release = resolveIo; }) });
  assert.equal(typeof release, "function", "the async filesystem request actually began");
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(settled, false, "no recovery record is published before the awaited filesystem response");
  release(JSON.stringify({ ok: true, entries: [{ path, data: Buffer.from(content).toString("base64"), mode: 0o644 }] }));
  const saved = await pending;
  const entries = JSON.parse(JSON.parse(readFileSync(saved, "utf8")).payload);
  assert.equal(Buffer.from(entries[0].data, "base64").toString(), content);
});

test("scope recovery exposes descriptor refusals through a concrete typed error", async (t) => {
  const f = fixture(t);
  const input = { root: f.opts.config.root, worktreePath: f.repo.dir, taskId, prNumber: 42,
    amendmentNumber: 99, paths: [path] };
  for (const response of [{ ok: false, error: "descriptor operation refused" }, { ok: false }]) {
    await assert.rejects(saveScopeAmendmentWork(input, { run: () => JSON.stringify(response) }), (error) => {
      assert.ok(isRmdError(error));
      assert.equal(error.name, "ScopeRecoveryError");
      assert.equal(error.kind, "scope_recovery");
      assert.equal(exitCodeFor(error), 1);
      assert.equal(error.message, response.error ?? "scope recovery filesystem unavailable");
      return true;
    });
  }
});

test("an unverifiable asking-round save is named in the ledger and the worker evidence", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo.dir, path), content);
  const saved = await saveScopeAmendmentWork({ root: f.opts.config.root, worktreePath: f.repo.dir,
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

const refusedUpdate = (f: ReturnType<typeof fixture>) => {
  let refused = 0;
  f.opts.deps.scopeAmendmentWritePorts = { ...f.ports, updateBranch: () => { refused++; return { ok: false, error: "HTTP 422" }; } };
  const spawn = f.opts.deps.spawn;
  f.opts.deps.spawn = async (args) => {
    if (existsSync(join(f.repo.dir, ".git/MERGE_HEAD"))) writeFileSync(join(f.repo.dir, "src/existing.ts"), "export const existing = 4;\n");
    return spawn(args);
  };
  return () => refused;
};

test("W1-T10787: an actual conflicted scope merge with a refused branch update reaches the bounded repair", async (t) => {
  const f = fixture(t); f.mergeAmendment(true);
  const refused = refusedUpdate(f);
  const result = await runFixRung(f.opts);
  assert.equal(result.outcome, "fixed", JSON.stringify({ result, rows: f.rows }));
  assert.equal(refused(), 1);
  assert.deepEqual(f.counts(), { updates: 0, spawns: 1, pushes: 1 });
  const resumed = f.rows.findLast((r) => r.step === "fix.scope_amendment" && r.outcome === "conflict_repair_resumed");
  assert.deepEqual(resumed?.conflicted_files, ["src/existing.ts"]);
  assert.equal(resumed?.merged_locally, false);
  assert.equal(resumed?.main_sha, f.repo.git("rev-parse", "origin/main"));
  assert.ok(f.rows.some((r) => r.step === "fix.merge_started"), "the harness started the merge of main for the worker");
  assert.match(f.prompt(), /src\/existing\.ts/);
  assert.equal(f.repo.git("show", "HEAD:src/existing.ts"), "export const existing = 4;");
  assert.equal(f.repo.git("show", "HEAD:src/lib/rule-suites.ts") + "\n", content);
  assert.equal(f.repo.git("rev-parse", "HEAD^1"), f.headSha, "the repair merge sits on the original published head");
});

test("W1-T10787: a successful branch update retains its existing zero-worker fallback", async (t) => {
  const f = fixture(t); f.mergeAmendment(true);
  const result = await runFixRung(f.opts);
  assert.equal(result.outcome, "stood_down");
  assert.deepEqual(f.counts(), { updates: 1, spawns: 0, pushes: 0 });
  assert.equal(f.rows.some((r) => r.outcome === "conflict_repair_resumed"), false);
  assert.equal(f.rows.some((r) => r.step === "fix.merge_started"), false);
  assert.equal(f.repo.git("rev-parse", "HEAD"), f.headSha);
  assert.equal(f.repo.git("status", "--porcelain"), "");
});

test("W1-T10787: missing conflict evidence or an unproved amended contract never dispatches repair", async (t) => {
  // (a) a local failure that is not a conflict: no unmerged paths exist, so there is no evidence to repair.
  const a = fixture(t);
  a.repo.git("remote", "set-url", "origin", join(a.repo.dir, "absent-origin"));
  const aRefused = refusedUpdate(a);
  assert.equal((await runFixRung(a.opts)).outcome, "stood_down");
  assert.equal(aRefused(), 1);
  assert.equal(a.counts().spawns, 0);
  assert.equal(a.rows.some((r) => r.outcome === "conflict_repair_resumed"), false);

  // (b) a real conflict whose evidence cannot be read stays a stand-down.
  const b = fixture(t); b.mergeAmendment(true);
  const bRefused = refusedUpdate(b);
  b.opts.deps.scopeAmendmentGit = async (cwd, args, options) => {
    if (args[0] === "diff" && args.includes("--diff-filter=U")) throw new Error("index unreadable");
    return hostWorktreeGitAsync(cwd, args, options);
  };
  assert.equal((await runFixRung(b.opts)).outcome, "stood_down");
  assert.equal(bRefused(), 1);
  assert.equal(b.counts().spawns, 0);
  assert.match(String(b.rows.findLast((r) => r.outcome === "branch_update_requested")?.reason), /conflict evidence: .*index unreadable/);
  assert.equal(b.repo.git("status", "--porcelain"), "");

  // (c) a real conflict on a main that does not admit the amendment paths is never repaired.
  const c = fixture(t);
  c.repo.git("checkout", "-q", "main");
  writeFileSync(join(c.repo.dir, "src/existing.ts"), "export const existing = 3;\n");
  c.repo.git("commit", "-qam", "unrelated conflicting change"); c.repo.git("push", "-q", "origin", "main");
  c.repo.git("checkout", "-q", branch);
  const cRefused = refusedUpdate(c);
  assert.equal((await runFixRung(c.opts)).outcome, "stood_down");
  assert.equal(cRefused(), 1);
  assert.equal(c.counts().spawns, 0);
  assert.equal(c.rows.some((r) => r.outcome === "conflict_repair_resumed"), false);
  assert.equal(c.repo.git("rev-parse", "HEAD"), c.headSha);

  // (d) a dirty worktree after the aborted merge is never read as conflict evidence.
  const d = fixture(t); d.mergeAmendment(true);
  const dRefused = refusedUpdate(d);
  d.opts.deps.scopeAmendmentGit = async (cwd, args, options) => {
    const out = await hostWorktreeGitAsync(cwd, args, options);
    if (args[0] === "merge" && args[1] === "--abort") writeFileSync(join(d.repo.dir, "stray.txt"), "dirty");
    return out;
  };
  assert.equal((await runFixRung(d.opts)).outcome, "stood_down");
  assert.equal(dRefused(), 1);
  assert.equal(d.counts().spawns, 0);
  assert.match(String(d.rows.findLast((r) => r.outcome === "conflict_repair_refused")?.reason), /not clean/);
});

test("W1-T10787: the resumed scope repair preserves its original publish base and requires fresh evidence", async (t) => {
  const f = fixture(t); f.mergeAmendment(true);
  refusedUpdate(f);
  const reads: string[][] = [];
  f.opts.deps.scopeAmendmentGit = async (cwd, args, options) => {
    reads.push([...args]);
    return hostWorktreeGitAsync(cwd, args, options);
  };
  const result = await runFixRung(f.opts);
  assert.equal(result.outcome, "fixed", JSON.stringify({ result, rows: f.rows }));
  const mergeAt = reads.findIndex((a) => a[0] === "merge" && a[1] !== "--abort");
  const captureAt = reads.findIndex((a) => a[0] === "diff" && a.includes("--diff-filter=U"));
  const abortAt = reads.findIndex((a) => a[0] === "merge" && a[1] === "--abort");
  assert.ok(mergeAt >= 0 && captureAt > mergeAt && abortAt > captureAt, "evidence is read from this round's pending merge, before the abort");
  // The fixture's push asserts `prior === headSha`: the lease stays on the original published tip.
  assert.equal(f.counts().pushes, 1);
  assert.equal(f.repo.git("rev-parse", "HEAD^1"), f.headSha);
  assert.equal(f.repo.git("status", "--porcelain"), "");
});
