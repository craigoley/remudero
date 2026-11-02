import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { runFixRung } from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type Run = Parameters<typeof runFixRung>[0];
type Row = { step: string } & Record<string, unknown>;
const ownPath = "scripts/lib/native-author-runtime.mjs";
const outsidePaths = ["scripts/pure-test-pool.mjs", "scripts/test-tier-manifest.mjs"];
const diagnosis = "The inherited pure-test pool times out; both pool scripts need repair.";
const signature = "ci-shard (7/8): pure-test pool timed out";
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;

function fixture(paths: string[]) {
  const repo = gitRepo({ kind: "w1-t8043" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  for (const path of [ownPath, ...outsidePaths]) put(path, "export const value = 1;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("checkout", "-qb", "run-unfiled-1791718425961");
  put(ownPath, "export const value = 2;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "unfiled repair");
  const headSha = repo.git("rev-parse", "HEAD");
  const rows: Row[] = [];
  const issues: Array<{ title: string; body: string }> = [];
  let pushes = 0;
  let amendments = 0;
  let requested = paths;
  const review = {
    state: "failure", criteria: [{ claim: "ci green", proof: "unit test: ci", met: false,
      reason: signature, proof_exec: "not_executable" }], testTheater: false, summary: signature,
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha,
    reviewerOutcome: "failure",
  } as Run["initialReview"];
  const run: Run = {
    taskId: "PR-10852", runId: "w1-t8043-run",
    task: { id: "PR-10852", title: "unfiled repair", files: [ownPath] },
    prUrl: "https://github.com/acme/remudero/pull/10852", branch: "run-unfiled-1791718425961",
    worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "ci-shard (7/8)", logTail: signature }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "owner must route the repair" }),
    deps: {
      spawn: async () => {
        for (const path of requested) put(path, "export const value = 3;\n");
        return { text: `REPORT\n${diagnosis}\nFIX_OUTCOME: NEEDS_SCOPE ${requested.join(",")}\n` +
            "COMMIT_MESSAGE: fix(ci): repair the pool", blocks: [], sessionId: "scope",
          costUsd: 1, numTurns: 1, subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          stderr: "", model: "sonnet", effort: "medium", compactionEvents: [], qualitySuspect: false,
          modelUsage: {}, provider: "codex" } as WorkerResult;
      },
      fetchPrBody: async () => "An unfiled repair with no task trailer.",
      fetchPrDiffFiles: async () => repo.git("diff", "--name-only", "origin/main...HEAD").split("\n").filter(Boolean),
      scopeAmendmentWritePorts: { findShard: () => { amendments++; return undefined; } } as unknown as
        NonNullable<Run["deps"]["scopeAmendmentWritePorts"]>,
      push: () => { pushes++; },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success", headSha: repo.git("rev-parse", "HEAD") }),
      issues: { create: (title, body) => { issues.push({ title, body }); return "https://github.com/acme/remudero/issues/1"; },
        listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: "PR-10852", pr_number: 10852, ...extra }),
      say: () => {}, account: (r) => r,
    },
  };
  return { repo, run, rows, issues, headSha, put, counts: () => ({ pushes, amendments }),
    request: (next: string[]) => { requested = next; } };
}

test("W1-T8043: an unfiled PR scope need outside its diff escalates once with the exact paths", async () => {
  const f = fixture(outsidePaths);
  const result = await runFixRung(f.run);
  assert.equal(f.issues.length, 1, JSON.stringify({ result, rows: f.rows }));
  const body = f.issues[0].body;
  for (const path of outsidePaths) assert.ok(body.includes(path), body);
  assert.ok(body.includes(diagnosis), body);
  assert.ok(body.includes(signature), body);
  assert.ok(body.includes(f.run.prUrl), body);
  const round = f.rows.find((row) => row.step === "fix.dispatch")?.round_id;
  assert.equal(typeof round, "string");
  assert.ok(body.includes(String(round)), body);
  const routed = f.rows.find((row) => row.step === "fix.scope_amendment");
  assert.equal(routed?.outcome, "unfiled-escalated");
  assert.deepEqual(routed?.paths, outsidePaths);
  assert.equal(routed?.head_sha, f.headSha);
  assert.equal(result.outcome, "stood_down");
  assert.match(result.reason ?? "", /unfiled.*scope/i);
  assert.equal(f.repo.git("rev-parse", "HEAD"), f.headSha);
  assert.deepEqual(f.counts(), { pushes: 0, amendments: 0 });
  f.request([...outsidePaths].reverse());
  await runFixRung(f.run);
  assert.equal(f.issues.length, 1, "the same path set at the same head is delivered once");
  assert.deepEqual(f.counts(), { pushes: 0, amendments: 0 });
});

test("W1-T8043: an unfiled PR scope need inside its own diff is admitted", async () => {
  const f = fixture([ownPath]);
  const result = await runFixRung(f.run);
  assert.equal(result.outcome, "fixed", JSON.stringify({ result, rows: f.rows }));
  assert.deepEqual(f.counts(), { pushes: 1, amendments: 0 });
  assert.equal(f.issues.length, 0);
  assert.equal(f.repo.git("show", `HEAD:${ownPath}`), "export const value = 3;");
  assert.notEqual(f.repo.git("rev-parse", "HEAD"), f.headSha);
  const routed = f.rows.find((row) => row.step === "fix.scope_amendment");
  assert.equal(routed?.outcome, "unfiled-own-diff");
  assert.deepEqual(routed?.paths, [ownPath]);
  assert.equal(routed?.head_sha, f.headSha);
  assert.equal(f.rows.filter((row) => row.step === "fix.commit_refused").length, 0);
});

test("W1-T8043: an unfiled escalation distinguishes path sets and heads", async () => {
  const f = fixture([outsidePaths[0]]);
  await runFixRung(f.run);
  f.request(outsidePaths);
  await runFixRung(f.run);
  assert.equal(f.issues.length, 2, "a new requested path changes the owner ask");
  f.repo.git("commit", "--allow-empty", "-qm", "new head");
  f.run.initialReview = { ...f.run.initialReview, headSha: f.repo.git("rev-parse", "HEAD") };
  await runFixRung(f.run);
  assert.equal(f.issues.length, 3, "a new head gets its own escalation");
  assert.deepEqual(f.counts(), { pushes: 0, amendments: 0 });
});

test("W1-T8043: a mixed request cannot admit an outside path", async () => {
  const f = fixture([ownPath, ...outsidePaths]);
  await runFixRung(f.run);
  assert.equal(f.issues.length, 1);
  assert.equal(f.repo.git("rev-parse", "HEAD"), f.headSha);
  assert.deepEqual(f.counts(), { pushes: 0, amendments: 0 });
});

test("W1-T8043: main-owned paths still reach the unfiled PR owner", async () => {
  const f = fixture(outsidePaths);
  f.repo.git("checkout", "main");
  f.put(outsidePaths[0], "export const value = 4;\n");
  f.repo.git("add", outsidePaths[0]);
  f.repo.git("commit", "-qm", "inherited pool change");
  f.repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.repo.git("checkout", f.run.branch);
  await runFixRung(f.run);
  assert.equal(f.issues.length, 1);
  assert.ok(f.issues[0].body.includes(diagnosis));
  assert.ok(f.issues[0].body.includes(signature));
  assert.equal(f.rows.find((row) => row.step === "fix.scope_amendment")?.outcome, "unfiled-escalated");
  assert.deepEqual(f.counts(), { pushes: 0, amendments: 0 });
});

test("W1-T8043: a failed escalation stays visible and can be delivered later", async () => {
  const f = fixture(outsidePaths);
  const create = f.run.deps.issues.create;
  f.run.deps.issues.create = () => { throw new Error("issue transport unavailable"); };
  const result = await runFixRung(f.run);
  assert.equal(result.reason, "unfiled scope escalation undelivered");
  const row = f.rows.find((entry) => entry.step === "fix.scope_amendment");
  assert.equal(row?.outcome, "unfiled-escalation-failed");
  assert.match(String(row?.error), /issue transport unavailable/);
  f.run.deps.issues.create = create;
  await runFixRung(f.run);
  assert.equal(f.issues.length, 1);
  assert.equal(f.rows.filter((entry) => entry.outcome === "unfiled-escalated").length, 1);
});

test("W1-T8043: an unreadable escalation dedup surface is not a delivered escalation", async () => {
  const f = fixture(outsidePaths);
  f.run.deps.issues.listOpen = () => { throw new Error("cannot enumerate issues"); };
  const result = await runFixRung(f.run);
  assert.equal(result.reason, "unfiled scope escalation undelivered");
  assert.equal(f.issues.length, 0);
  assert.equal(f.rows.find((row) => row.step === "fix.scope_amendment")?.outcome, "unfiled-escalation-failed");
  f.run.deps.issues.listOpen = () => [];
  await runFixRung(f.run);
  assert.equal(f.issues.length, 1);
});
