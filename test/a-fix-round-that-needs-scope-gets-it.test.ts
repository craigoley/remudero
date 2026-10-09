import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { requestScopeAmendment } from "../src/lib/proof-amendment.js";
import type { ProofAmendmentRecord, ProofAmendmentWritePorts } from "../src/lib/proof-amendment.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import { runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

// W1-T6465: a fleet build PR identifies its task by its run-<taskId>-<epochMs> head ref, not a
// `Remudero-Task:` trailer — and every scope amendment on 2026-10-08 was refused for lacking one.
const taskId = "W1-T1";
const runHead = `run-${taskId}-1791469669000`;
const shardPath = `plan/tasks.d/${taskId}-fixture.yaml`;
const shard = `- id: ${taskId}\n  files: [src/existing.ts]\n  acceptance:\n    - claim: unchanged\n      proof: 'unit test: unchanged'\n`;
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;

function writePorts() {
  const writes: Array<{ path: string; text: string }> = [];
  const prs: Array<Parameters<ProofAmendmentWritePorts["createPr"]>[0]> = [];
  const effects: string[] = [];
  const records = new Map<string, ProofAmendmentRecord>();
  const deps: ProofAmendmentWritePorts = {
    repoDir: "/fixture", findShard: () => ({ path: shardPath, text: shard }),
    worktreeAdd: (_repo, _wp, branch) => { effects.push(branch); },
    worktreeRemove: () => { effects.push("remove"); },
    writeFile: (path, text) => { writes.push({ path, text }); },
    gitAdd: (_wp, path) => { effects.push(path); }, gitCommit: () => "amendment-sha",
    gitPush: (_wp, branch, sha) => { effects.push(`${branch}@${sha}`); },
    probeExisting: () => undefined,
    createPr: (opts) => { prs.push(opts); return { prUrl: "https://github.com/acme/repo/pull/99", prNumber: 99 }; },
    worktreePathFor: () => "/amendment", lookupIdentity: (key) => records.get(key),
    recordIdentity: (key, record) => { records.set(key, record); },
    updateBranch: () => ({ ok: true }),
  };
  return { deps, writes, prs, effects };
}

function rung(branch: string, body: string) {
  const p = writePorts();
  const repo = gitRepo({ kind: "scope-identity" });
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, shardPath), shard);
  writeFileSync(join(repo.dir, "src/existing.ts"), "old\n");
  repo.git("add", "-A"); repo.git("commit", "-qm", "seed source");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const headSha = repo.git("rev-parse", "HEAD");
  const rows: Array<Record<string, unknown>> = [];
  const review = { state: "failure", criteria: [{ claim: "repair", proof: "unit test: repair", met: false,
    reason: "broken", proof_exec: "not_executable" }], testTheater: false, summary: "broken",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha,
    reviewerOutcome: "failure" } as Parameters<typeof runFixRung>[0]["initialReview"];
  const opts: Parameters<typeof runFixRung>[0] = {
    taskId, runId: "scope-identity-run", task: { id: taskId, title: "repair", files: ["src/existing.ts"] },
    prUrl: "https://github.com/acme/repo/pull/42", branch, worktreePath: repo.dir,
    initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    reviewBase: { owner: "acme", repo: "repo", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      spawn: async () => {
        // The worker leaves its out-of-scope edit SAVED (uncommitted) when it reports NEEDS_SCOPE.
        writeFileSync(join(repo.dir, "src/consumer.ts"), "needed consumer edit\n");
        return { text: "REPORT\nFIX_OUTCOME: NEEDS_SCOPE src/consumer.ts", blocks: [], sessionId: "scope",
          costUsd: 1, numTurns: 1, subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          stderr: "", model: "sonnet", effort: "medium", compactionEvents: [], qualitySuspect: false,
          modelUsage: {}, provider: "codex" } as WorkerResult;
      },
      scopeAmendmentWritePorts: p.deps,
      fetchPrBody: async () => body,
      push: () => { assert.fail("implementation must wait for the scope amendment"); },
      waitForCiGreen: async () => { assert.fail("no CI wait before scope merges"); },
      runReview: async () => review,
      issues: { create: () => "https://github.com/acme/repo/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, task_id: taskId, ...extra }); }, say: () => {}, account: (r) => r,
    },
  };
  return { p, opts, rows };
}

test("W1-T6465: a run-branch fix round with saved out-of-scope edits gets its scope amendment", async () => {
  const { p, opts, rows } = rung(runHead, "A fleet build PR body with no task trailer.");
  await runFixRung(opts);
  const amendment = rows.find((row) => row.step === "fix.scope_amendment");
  assert.equal(amendment?.outcome, "created", JSON.stringify(amendment));
  assert.equal(p.prs.length, 1);
  assert.equal(p.prs[0].head, `scope-amendment/${taskId}-42`);
  assert.deepEqual(parse(p.writes[0].text)[0].files, ["src/existing.ts", "src/consumer.ts"]);
});

test("W1-T6465: a run-branch for a DIFFERENT task, or no identity at all, is still refused no-task-trailer", async () => {
  for (const branch of ["run-W1-T2-1791469669000", "feature/scope", "run-unfiled-1791469669000"]) {
    const { p, opts, rows } = rung(branch, "no trailer here");
    await runFixRung(opts);
    assert.equal(rows.find((row) => row.step === "fix.scope_amendment")?.reason, "no-task-trailer", branch);
    assert.deepEqual(p.prs, []);
  }
});

test("W1-T6465: identity from the head ref or the trailer, never against a conflicting one", () => {
  const base = { taskId, prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42", headSha: "head-a",
    paths: ["src/consumer.ts"], changedPaths: ["src/consumer.ts"] };
  const kind = (overrides: Record<string, unknown>) => {
    const p = writePorts();
    const outcome = requestScopeAmendment({ ...base, ...overrides }, p.deps);
    return outcome.kind === "refused" ? outcome.reason : outcome.kind;
  };
  assert.equal(kind({ headRef: runHead }), "created");
  assert.equal(kind({ trailerTaskId: taskId }), "created");
  assert.equal(kind({ trailerTaskId: taskId, headRef: runHead }), "created");
  assert.equal(kind({}), "no-task-trailer");
  assert.equal(kind({ headRef: "run-W1-T2-1791469669000" }), "no-task-trailer");
  assert.equal(kind({ headRef: `run-${taskId}-build-1791469669000` }), "no-task-trailer");
  assert.equal(kind({ headRef: runHead, trailerTaskId: "W1-T2" }), "no-task-trailer");
  assert.equal(kind({ trailerTaskId: taskId, headRef: "run-W1-T2-1791469669000" }), "no-task-trailer");
  // Every other refusal is unchanged by a head-ref identity.
  assert.equal(kind({ headRef: runHead, changedPaths: [] }), "path-not-changed");
  assert.equal(kind({ headRef: runHead, paths: ["test/a.test.ts"], changedPaths: ["test/a.test.ts"] }), "test-path");
  assert.equal(kind({ headRef: runHead, paths: ["plan/x.yaml"], changedPaths: ["plan/x.yaml"] }), "plan-path");
});

test("W1-T6465: the NEEDS_SCOPE line tells the worker to keep its out-of-scope edits saved", () => {
  const prompt = renderFixPrompt({ task: { id: taskId, title: "scope", files: ["src/existing.ts"] },
    round: 1, branch: runHead, evidence: { review: { unmetCriteria: [], summary: "repair" } } });
  const line = prompt.split("\n").find((l) => l.startsWith("FIX_OUTCOME: NEEDS_SCOPE"));
  assert.ok(line, "the NEEDS_SCOPE outcome line is rendered");
  assert.match(line, /leave .*edits saved.*uncommitted/i);
  assert.match(line, /only paths .*actually changed/i);
});
