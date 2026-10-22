import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import * as amendments from "../src/lib/proof-amendment.js";
import type { ProofAmendmentRecord, ProofAmendmentWritePorts } from "../src/lib/proof-amendment.js";
import { buildProofAmendmentGitOps, buildProofAmendmentWritePorts, runFixRung } from "./helpers/run-task-test.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { fixRoundTally } from "../src/lib/sweep.js";
import { ENTANGLEMENT_EXEMPT_INSTRUMENTS } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const taskId = "W1-T5534";
const shardPath = `plan/tasks.d/${taskId}-fixture.yaml`;
const shard = `- id: ${taskId}\n  files: [src/existing.ts]\n  acceptance:\n    - claim: unchanged\n      proof: 'unit test: unchanged'\n`;
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;

function ports(text = shard) {
  const writes: Array<{ path: string; text: string }> = [];
  const prs: Array<Parameters<ProofAmendmentWritePorts["createPr"]>[0]> = [];
  const effects: string[] = [];
  const records = new Map<string, ProofAmendmentRecord>();
  const updates: string[] = [];
  const deps: ProofAmendmentWritePorts = {
    repoDir: "/fixture", findShard: () => ({ path: shardPath, text }),
    worktreeAdd: (_repo, _wp, branch) => { effects.push(branch); },
    worktreeRemove: () => { effects.push("remove"); },
    writeFile: (path, text) => { writes.push({ path, text }); },
    gitAdd: (_wp, path) => { effects.push(path); }, gitCommit: () => "amendment-sha",
    gitPush: (_wp, branch, sha) => { effects.push(`${branch}@${sha}`); },
    probeExisting: () => undefined,
    createPr: (opts) => { prs.push(opts); return { prUrl: "https://github.com/acme/repo/pull/99", prNumber: 99 }; },
    worktreePathFor: () => "/amendment", lookupIdentity: (key) => records.get(key),
    recordIdentity: (key, record) => { records.set(key, record); },
    updateBranch: (_url, sha) => { updates.push(sha); return { ok: true }; },
  };
  return { deps, writes, prs, effects, records, updates };
}

function request(paths = ["src/new.ts"]) {
  return { taskId, prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42", headSha: "head-a",
    trailerTaskId: taskId, paths, changedPaths: paths };
}

function fixture(report = "REPORT\nFIX_OUTCOME: NEEDS_SCOPE src/new.ts", changePath: string | undefined = "src/new.ts") {
  const p = ports();
  const repo = gitRepo({ kind: "scope-amendment" });
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, shardPath), shard);
  writeFileSync(join(repo.dir, "src/existing.ts"), "old\n");
  repo.git("add", "-A"); repo.git("commit", "-qm", "seed source");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const headSha = repo.git("rev-parse", "HEAD");
  const rows: Array<Record<string, unknown>> = [];
  let spawns = 0;
  const review = { state: "failure", criteria: [{ claim: "repair", proof: "unit test: repair", met: false,
    reason: "broken", proof_exec: "not_executable" }], testTheater: false, summary: "broken",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha,
    reviewerOutcome: "failure" } as Parameters<typeof runFixRung>[0]["initialReview"];
  const opts: Parameters<typeof runFixRung>[0] = {
    taskId, runId: "scope-run", task: { id: taskId, title: "repair", files: ["src/existing.ts"] },
    prUrl: request().prUrl, branch: `run-${taskId}-1`, worktreePath: repo.dir,
    initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    reviewBase: { owner: "acme", repo: "repo", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      spawn: async () => {
        spawns++;
        if (changePath) writeFileSync(join(repo.dir, changePath), "needed repair\n");
        return { text: report, blocks: [], sessionId: "scope",
          costUsd: 1, numTurns: 1, subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          stderr: "", model: "sonnet", effort: "medium", compactionEvents: [], qualitySuspect: false,
          modelUsage: {}, provider: "codex" } as WorkerResult;
      },
      scopeAmendmentWritePorts: p.deps,
      fetchPrBody: async () => `Remudero-Task: ${taskId}`,
      push: () => { assert.fail("implementation must wait for the scope amendment"); },
      waitForCiGreen: async () => { assert.fail("no CI wait before scope merges"); },
      runReview: async () => review,
      issues: { create: () => { assert.fail("valid scope must not escalate"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, task_id: taskId, ...extra }); }, say: () => {}, account: (r) => r,
    },
  };
  return { p, repo, opts, rows, headSha, spawns: () => spawns };
}

test("W1-T5534: a non-test NEEDS_SCOPE path opens one plan-only files amendment", async () => {
  const { p, opts, rows, headSha, spawns } = fixture();
  const result = await runFixRung(opts);
  assert.equal(result.outcome, "stood_down");
  assert.equal(p.prs.length, 1);
  assert.equal(result.strikes, 0);
  assert.equal(p.prs[0].head, `scope-amendment/${taskId}-42`);
  assert.equal(p.writes[0].path, join("/amendment", shardPath));
  assert.equal(p.writes[0].text, shard.replace("[src/existing.ts]", '[src/existing.ts, "src/new.ts"]'));
  assert.deepEqual(parse(p.writes[0].text)[0].files, ["src/existing.ts", "src/new.ts"]);
  assert.equal(rows.find((r) => r.step === "fix.scope_amendment")?.outcome, "created");
  assert.equal(rows.some((r) => r.step === "fix.commit_refused"), false);
  await runFixRung(opts);
  assert.equal(p.prs.length, 1);
  assert.equal(spawns(), 1);
  for (const [key, record] of p.records) p.records.set(key, { ...record, merged: true });
  await runFixRung(opts);
  assert.deepEqual(p.updates, [headSha]);
  assert.equal(spawns(), 1);
  assert.deepEqual(fixRoundTally(rows, taskId, headSha).refusals, []);
});

test("scope amendment production ports commit only the shard and resume from ledger identity", async () => {
  const { p, repo, opts, rows, headSha, spawns } = fixture();
  repo.git("config", "user.name", "scope fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  let merged = false;
  let amendmentLocalBranch = "";
  delete opts.deps.scopeAmendmentWritePorts;
  opts.deps.scopeAmendmentPortsIo = {
    worktreeAddFn: (_repo, wp, branch) => { amendmentLocalBranch = branch; repo.addWorktree(wp, branch, "origin/main"); },
    worktreeRemoveFn: (_repo, wp) => { repo.git("worktree", "remove", "--force", wp); },
    writeFileFn: (path, text) => { p.deps.writeFile(path, text); writeFileSync(path, text); },
    gitPushFn: p.deps.gitPush, probeExistingPlanPrFn: () => undefined,
    createPlanPrRestFn: (_fetch, _owner, _repo, opts) => p.deps.createPr(opts),
    isPrMergedNowFn: () => merged, assertLiveWriteAllowedFn: () => {},
    ghExecFn: (() => { p.updates.push(headSha); return Buffer.from(""); }) as unknown as NonNullable<NonNullable<typeof opts.deps.scopeAmendmentPortsIo>["ghExecFn"]>,
  };
  assert.equal((await runFixRung(opts)).strikes, 0);
  assert.deepEqual(repo.git("diff", "--name-only", "origin/main", amendmentLocalBranch).split("\n"), [shardPath]);
  assert.deepEqual(parse(repo.git("show", `${amendmentLocalBranch}:${shardPath}`))[0].files, ["src/existing.ts", "src/new.ts"]);
  assert.equal(readFileSync(join(repo.dir, shardPath), "utf8"), shard);
  await runFixRung(opts);
  assert.equal(p.prs.length, 1);
  merged = true;
  await runFixRung(opts);
  assert.equal(spawns(), 1);
  assert.deepEqual(p.updates, [headSha]);
  assert.equal(rows.findLast((row) => row.step === "fix.scope_amendment")?.outcome, "branch_update_requested");
});

test("scope amendment failures retain the scope escalation fallback", async () => {
  for (const mode of ["unchanged", "body-unreadable", "diff-unreadable", "write-failed"] as const) {
    const f = fixture("REPORT\nFIX_OUTCOME: NEEDS_SCOPE src/absent.ts", mode === "unchanged" ? "" : "src/absent.ts");
    if (mode === "body-unreadable") f.opts.deps.fetchPrBody = async () => { throw new Error("body unavailable"); };
    if (mode === "diff-unreadable") {
      const spawn = f.opts.deps.spawn;
      f.opts.deps.worktreeHasUncommittedChanges = () => false;
      f.opts.deps.spawn = async (args) => {
        const worker = await spawn(args);
        f.opts.worktreePath = join(f.repo.dir, "absent-worktree");
        return worker;
      };
    }
    if (mode === "write-failed") f.opts.deps.scopeAmendmentWritePorts = { ...f.p.deps, writeFile: () => { throw new Error("write failed"); } };
    const result = await runFixRung(f.opts);
    assert.equal(result.outcome, "stood_down");
    assert.equal(f.rows.findLast((row) => row.step === "fix.scope_amendment")?.outcome, "refused", mode);
    assert.match(String(f.rows.find((row) => row.step === "fix.commit_refused")?.scope_amendment_detail), /src\/absent.ts/);
    assert.equal(f.p.prs.length, 0);
  }
  const pending = fixture();
  await runFixRung(pending.opts);
  pending.opts.deps.fetchPrBody = async () => "no task trailer";
  // W1-T6465: a run-<taskId>-<epochMs> head is identity too, so the resume must lose BOTH to refuse.
  pending.opts.branch = "feature/no-task-identity";
  await runFixRung(pending.opts);
  assert.equal(pending.spawns(), 1);
  assert.equal(pending.rows.findLast((row) => row.step === "fix.scope_amendment")?.reason, "no-task-trailer");
  assert.match(String(pending.rows.findLast((row) => row.step === "fix.commit_refused")?.scope_amendment_detail), /src\/new.ts/);
});

test("W1-T5534: a plan or instrument scope request is refused with no write", () => {
  for (const path of ["plan/tasks.d/other.yaml", ".github/workflows/ci.yml", "scripts/new-ratchet.mjs",
    "scripts/new-baseline.json", "test/new.test.ts", "../src/new.ts", "/src/new.ts", "src/./new.ts"]) {
    const p = ports();
    assert.equal(amendments.requestScopeAmendment(request([path]), p.deps).kind, "refused", path);
    assert.deepEqual(p.effects, []);
    assert.deepEqual(p.writes, []);
    assert.deepEqual(p.prs, []);
  }
  for (const overrides of [{ changedPaths: [] }, { trailerTaskId: undefined }, { trailerTaskId: "W1-T9999" }]) {
    const p = ports();
    assert.equal(amendments.requestScopeAmendment({ ...request(), ...overrides }, p.deps).kind, "refused");
    assert.deepEqual(p.effects, []);
    assert.deepEqual(p.writes, []);
  }
  for (const input of [{ ...request(), paths: [] }, { ...request(), prNumber: 0 }]) {
    const p = ports();
    assert.equal(amendments.requestScopeAmendment(input, p.deps).kind, "refused");
    assert.deepEqual(p.effects, []);
  }
});

test("a Stryker registration file is grantable scope, and no other instrument is", () => {
  // #12776: a task adding a classify.ts suite must register it, and review already admits exactly these two files.
  assert.deepEqual([...amendments.SCOPE_GRANTABLE_INSTRUMENTS].sort(), ["scripts/mutation-relevant-paths.json", "stryker.conf.json"]);
  for (const path of amendments.SCOPE_GRANTABLE_INSTRUMENTS) {
    assert.ok(ENTANGLEMENT_EXEMPT_INSTRUMENTS.has(path), `${path} is granted beyond review's entanglement exemption`);
    const p = ports();
    assert.equal(amendments.requestScopeAmendment(request([path]), p.deps).kind, "created", path);
    assert.match(p.writes.at(-1)?.text ?? "", new RegExp(`"${path.replace(/\./g, "\\.")}"`));
    const unchanged = ports();
    assert.equal(amendments.requestScopeAmendment({ ...request([path]), changedPaths: [] }, unchanged.deps).kind, "refused", path);
  }
  for (const path of ["scripts/mutation-baseline.json", "scripts/mutation-ratchet.mjs", "scripts/clock-signature-baseline.json"]) {
    const p = ports();
    const outcome = amendments.requestScopeAmendment(request([path]), p.deps);
    assert.equal(outcome.kind === "refused" ? outcome.reason : outcome.kind, "instrument-path", path);
    assert.deepEqual(p.writes, []);
  }
});

test("scope amendments refuse shard drift and leave the implementation contract unchanged", () => {
  for (const text of ["not yaml: [", shard.replace("files: [src/existing.ts]", "files: null"),
    shard + shard, shard.replace(taskId, "OTHER"), shard.replace("[src/existing.ts]", "[123]"),
    shard.replace("[src/existing.ts]", "[src/new.ts]")]) {
    const p = ports(text);
    assert.equal(amendments.requestScopeAmendment(request(), p.deps).kind, "refused");
    assert.deepEqual(p.writes, []);
  }
  const p = ports();
  assert.equal(amendments.requestScopeAmendment(request(), { ...p.deps, findShard: () => undefined }).kind, "refused");
  assert.equal(amendments.requestScopeAmendment(request(), { ...p.deps,
    findShard: (root) => ({ path: shardPath, text: root === "/amendment" ? shard.replace("unchanged", "changed") : shard }) }).kind, "refused");
  assert.deepEqual(p.writes, []);
  assert.equal(p.effects.at(-1), "remove");
  const empty = ports(shard.replace("[src/existing.ts]", "[]"));
  assert.equal(amendments.requestScopeAmendment(request(), empty.deps).kind, "created");
  assert.deepEqual(parse(empty.writes[0].text)[0].files, ["src/new.ts"]);
  const trailingComma = ports(shard.replace("[src/existing.ts]", "[src/existing.ts,]"));
  assert.equal(amendments.requestScopeAmendment(request(), trailingComma.deps).kind, "created");
  assert.deepEqual(parse(trailingComma.writes[0].text)[0].files, ["src/existing.ts", "src/new.ts"]);
  const merged = ports();
  amendments.requestScopeAmendment(request(), merged.deps);
  for (const [key, record] of merged.records) merged.records.set(key, { ...record, merged: true });
  assert.deepEqual(amendments.requestScopeAmendment(request(), { ...merged.deps,
    updateBranch: () => assert.fail("the caller owns branch-update fallback after a merged amendment") }),
  { kind: "amendment_merged", amendmentNumber: 99 });
});

test("scope amendments deduplicate a path set and preserve block files and other tasks", () => {
  const text = `- id: OTHER\n  files: [src/other.ts]\n` + shard.replace("files: [src/existing.ts]", "files:\n    - src/existing.ts");
  const p = ports(text);
  const first = amendments.requestScopeAmendment(request(["src/b.ts", "src/a.ts", "src/a.ts"]), p.deps);
  assert.equal(first.kind, "created");
  assert.equal(amendments.requestScopeAmendment(request(["src/a.ts", "src/b.ts"]), p.deps).kind, "resumed");
  assert.equal(p.prs.length, 1);
  assert.deepEqual(parse(p.writes[0].text)[1].files, ["src/existing.ts", "src/a.ts", "src/b.ts"]);
  assert.ok(p.writes[0].text.startsWith("- id: OTHER\n  files: [src/other.ts]\n"));
  const probed = ports();
  assert.equal(amendments.requestScopeAmendment(request(), { ...probed.deps,
    probeExisting: () => ({ prUrl: "existing", prNumber: 99 }) }).kind, "resumed");
  assert.deepEqual(probed.writes, []);
});


test("a scope amendment retries after shard drift without reusing or deleting any existing local branch", t => {
  const repo = gitRepo({ scope: t, kind: "scope-attempt-collision" });
  const remote = gitRepo({ scope: t, kind: "scope-attempt-origin", bare: true });
  repo.git("config", "user.name", "scope attempt fixture");
  repo.git("config", "user.email", "scope-attempt@example.invalid");
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, shardPath), shard);
  repo.git("add", "."); repo.git("commit", "-qm", "test: original observed scope");
  const oldHead = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, shardPath), "# protected main advanced\n" + shard);
  repo.git("add", "."); repo.git("commit", "-qm", "test: current protected main scope");
  const mainHead = repo.git("rev-parse", "HEAD"), stable = `scope-amendment/${taskId}-42`;
  repo.addRemote("origin", remote.dir);
  repo.git("push", "origin", "HEAD:refs/heads/main");
  repo.git("update-ref", "refs/remotes/origin/main", mainHead);
  repo.git("branch", stable, mainHead);
  repo.git("checkout", "--detach", oldHead);
  const rows: Record<string, unknown>[] = [], attempts: string[] = [], creations: string[] = [];
  const ports = buildProofAmendmentWritePorts({ taskId, prNumber: 42, owner: "fixture", repo: "fixture",
    worktreePath: repo.dir, config: { root: repo.dir } as Config, amendmentKind: "scope_amendment",
    ledgerLinesNow: rows, log: (step, extra) => {
      rows.push({ step, ...extra });
      if (step === "worktree.add" && typeof extra?.branch === "string") attempts.push(extra.branch);
    }, gitOps: buildProofAmendmentGitOps(),
  }, {
    worktreeRemoveFn: (_repo, wp) => { repo.git("worktree", "remove", "--force", wp); },
    probeExistingPlanPrFn: (_read, _owner, _repo, branch) => { assert.equal(branch, stable); return undefined; },
    isPrMergedNowFn: () => false,
    createPlanPrRestFn: (_read, _owner, _repo, options) => {
      assert.equal(options.head, stable); creations.push(options.head);
      return { prUrl: "https://github.com/fixture/fixture/pull/99", prNumber: 99 };
    }, assertLiveWriteAllowedFn: () => {},
  });
  const first = amendments.requestScopeAmendment(request(), ports);
  assert.equal(first.kind, "refused");
  if (first.kind === "refused") assert.equal(first.reason, "shard-drifted");
  assert.equal(repo.git("rev-parse", stable), mainHead, "preserve the legacy amendment branch");
  assert.equal(repo.git("rev-parse", attempts[0]!), mainHead, "preserve the refused attempt's branch");
  assert.equal(existsSync(ports.worktreePathFor(taskId, 42)), false, "ordinary finally removes only the owned worktree");
  repo.git("checkout", "--detach", mainHead);
  // Only the real default push boundary is enabled, against the asserted private bare origin.
  assert.equal(repo.git("remote", "get-url", "origin"), remote.dir);
  const second = withLiveWritesAllowed(() => amendments.requestScopeAmendment(request(), ports));
  assert.equal(second.kind, "created");
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0], attempts[1]);
  for (const name of attempts) assert.match(name, new RegExp(`^scope-amendment/${taskId}-42-attempt-[0-9a-f-]{36}$`));
  assert.deepEqual(creations, [stable]);
  assert.equal(repo.git("rev-parse", stable), mainHead);
  assert.equal(repo.git("rev-parse", attempts[0]!), mainHead);
  const pushed = remote.git("rev-parse", `refs/heads/${stable}`);
  assert.equal(pushed, repo.git("rev-parse", attempts[1]!));
  assert.deepEqual(parse(remote.git("show", `${pushed}:${shardPath}`))[0].files, ["src/existing.ts", "src/new.ts"]);
  assert.equal(amendments.requestScopeAmendment(request(), ports).kind, "resumed");
  assert.equal(attempts.length, 2, "existing identity resumes without creating another local attempt");
  withLiveWritesAllowed(() => assert.throws(() => amendments.requestScopeAmendment(request(["src/another.ts"]), ports)));
  assert.equal(remote.git("rev-parse", `refs/heads/${stable}`), pushed,
    "a divergent remote identity is preserved by the default ordinary fast-forward push");
  assert.deepEqual(creations, [stable], "a rejected push creates no second PR");
  assert.equal(repo.git("rev-parse", stable), mainHead);
  assert.equal(repo.git("rev-parse", attempts[0]!), mainHead);
});

test("scope amendment attempt selection preserves a foreign occupied worktree and reuses the stable open PR", t => {
  const repo = gitRepo({ scope: t, kind: "scope-attempt-occupied" });
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true }); writeFileSync(join(repo.dir, shardPath), shard);
  repo.git("add", "."); repo.git("commit", "-qm", "test: scope fixture");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  let existing = false, adds = 0;
  const stable = `scope-amendment/${taskId}-42`;
  const ports = buildProofAmendmentWritePorts({ taskId, prNumber: 42, owner: "fixture", repo: "fixture",
    worktreePath: repo.dir, config: { root: repo.dir } as Config, amendmentKind: "scope_amendment",
    ledgerLinesNow: [], log: () => {}, gitOps: buildProofAmendmentGitOps(),
  }, {
    worktreeAddFn: (_repo, wp, name) => { adds++; repo.addWorktree(wp, name, "origin/main"); },
    worktreeRemoveFn: () => assert.fail("never remove a worktree this attempt did not create"),
    gitPushFn: () => assert.fail("an occupied worktree cannot publish"),
    probeExistingPlanPrFn: (_read, _owner, _repo, name) => {
      assert.equal(name, stable);
      return existing ? { prUrl: "https://github.com/fixture/fixture/pull/99", prNumber: 99 } : undefined;
    }, createPlanPrRestFn: () => assert.fail("no new PR"), assertLiveWriteAllowedFn: () => {},
  });
  const path = ports.worktreePathFor(taskId, 42), foreign = repo.addWorktree(path, "foreign-owner", "origin/main");
  writeFileSync(join(path, "unpublished.txt"), "foreign work must survive\n");
  const before = foreign.git("rev-parse", "HEAD");
  assert.throws(() => amendments.requestScopeAmendment(request(), ports));
  assert.equal(foreign.git("branch", "--show-current"), "foreign-owner");
  assert.equal(foreign.git("rev-parse", "HEAD"), before);
  assert.equal(readFileSync(join(path, "unpublished.txt"), "utf8"), "foreign work must survive\n");
  existing = true;
  assert.equal(amendments.requestScopeAmendment(request(), ports).kind, "resumed");
  assert.equal(adds, 1, "the stable existing PR is reused before another worktree attempt");
});
