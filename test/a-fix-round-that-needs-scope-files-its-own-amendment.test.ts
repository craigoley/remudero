import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import * as amendments from "../src/lib/proof-amendment.js";
import type { ProofAmendmentRecord, ProofAmendmentWritePorts } from "../src/lib/proof-amendment.js";
import { runFixRung } from "./helpers/run-task-test.js";
import { fixRoundTally } from "../src/lib/sweep.js";
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
  delete opts.deps.scopeAmendmentWritePorts;
  opts.deps.scopeAmendmentPortsIo = {
    worktreeAddFn: (_repo, wp, branch) => { repo.addWorktree(wp, branch, "origin/main"); },
    worktreeRemoveFn: (_repo, wp) => { repo.git("worktree", "remove", "--force", wp); },
    writeFileFn: (path, text) => { p.deps.writeFile(path, text); writeFileSync(path, text); },
    gitPushFn: p.deps.gitPush, probeExistingPlanPrFn: () => undefined,
    createPlanPrRestFn: (_fetch, _owner, _repo, opts) => p.deps.createPr(opts),
    isPrMergedNowFn: () => merged, assertLiveWriteAllowedFn: () => {},
    ghExecFn: (() => { p.updates.push(headSha); return Buffer.from(""); }) as unknown as NonNullable<NonNullable<typeof opts.deps.scopeAmendmentPortsIo>["ghExecFn"]>,
  };
  assert.equal((await runFixRung(opts)).strikes, 0);
  assert.deepEqual(repo.git("diff", "--name-only", "origin/main", `scope-amendment/${taskId}-42`).split("\n"), [shardPath]);
  assert.deepEqual(parse(repo.git("show", `scope-amendment/${taskId}-42:${shardPath}`))[0].files, ["src/existing.ts", "src/new.ts"]);
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
    updateBranch: () => ({ ok: false, error: "head moved" }) }), { kind: "branch_update_requested", ok: false, error: "head moved" });
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
