import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { isUngrantableInstrumentPath } from "#src/lib/proof-amendment.js";
import { runFixRung } from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";

// OBSERVED on PR 13223 (W1-T10079), 2026-10-20T22:19Z..2026-10-21T07:49Z: five fix rounds asked for
// scripts/console-parity-ratchet.mjs beside docs/operator-guide.md; every scope amendment was refused
// (instrument-path, or path-not-changed when the unedited docs path sorted first), no round committed,
// and the sweep re-judged and re-dispatched the same refusal for eleven hours.
type Run = Parameters<typeof runFixRung>[0];
type Row = { step: string } & Record<string, unknown>;
const TASK = "W1-T9001";
const PR = 13223;
const ownPath = "src/lib/inbox-verdict-command.ts";
const instrument = "scripts/console-parity-ratchet.mjs";
const docs = "docs/operator-guide.md";
const signature = "comment-load-ratchet: console-parity UNMAPPED keep, reply";
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;

function rung(requested: string[], edited: string[]) {
  const repo = gitRepo({ kind: "instrument-scope" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  for (const path of [ownPath, instrument, docs]) put(path, "export const value = 1;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const branch = `run-${TASK}-1792528877094`;
  repo.git("checkout", "-qb", branch);
  put(ownPath, "export const value = 2;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "build");
  const headSha = repo.git("rev-parse", "HEAD");
  const rows: Row[] = [];
  const issues: Array<{ title: string; body: string }> = [];
  let pushes = 0;
  let shardReads = 0;
  const review = {
    state: "failure", criteria: [{ claim: "ci green", proof: "unit test: ci", met: false,
      reason: signature, proof_exec: "not_executable" }], testTheater: false, summary: signature,
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha,
    reviewerOutcome: "failure",
  } as Run["initialReview"];
  const run: Run = {
    taskId: TASK, runId: "instrument-scope-run",
    task: { id: TASK, title: "every inbox verb has a cli path", files: [ownPath] },
    prUrl: `https://github.com/acme/remudero/pull/${PR}`, branch,
    worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "comment-load-ratchet", logTail: signature }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "only the operator can grant an instrument" }),
    deps: {
      spawn: async () => {
        for (const path of edited) put(path, "export const value = 3;\n");
        return { text: `REPORT\nkeep and reply need ROUTE_MATCH rows.\nFIX_OUTCOME: NEEDS_SCOPE ${requested.join(",")}\n` +
            "COMMIT_MESSAGE: fix(console): map keep and reply", blocks: [], sessionId: "scope",
          costUsd: 1, numTurns: 1, subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          stderr: "", model: "sonnet", effort: "medium", compactionEvents: [], qualitySuspect: false,
          modelUsage: {}, provider: "codex" } as WorkerResult;
      },
      fetchPrBody: async () => `Builds the verb table.\n\nRemudero-Task: ${TASK}\n`,
      fetchPrDiffFiles: async () => repo.git("diff", "--name-only", "origin/main...HEAD").split("\n").filter(Boolean),
      scopeAmendmentWritePorts: { repoDir: repo.dir, findShard: () => { shardReads++; return undefined; },
        lookupIdentity: () => undefined, probeExisting: () => undefined } as unknown as
        NonNullable<Run["deps"]["scopeAmendmentWritePorts"]>,
      push: () => { pushes++; },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success", headSha: repo.git("rev-parse", "HEAD") }),
      issues: { create: (title, body) => { issues.push({ title, body }); return "https://github.com/acme/remudero/issues/1"; },
        listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: TASK, pr_number: PR, ...extra }),
      say: () => {}, account: (r) => r,
    },
  };
  return { repo, run, rows, issues, headSha, counts: () => ({ pushes, shardReads }) };
}

test("PR 13223: an instrument scope need escalates once with the exact paths instead of a refused amendment", async () => {
  const f = rung([docs, instrument], [instrument]);
  const result = await runFixRung(f.run);
  assert.equal(f.issues.length, 1, JSON.stringify({ result, rows: f.rows.map((row) => [row.step, row.outcome, row.reason]) }));
  const body = f.issues[0].body;
  for (const path of [docs, instrument]) assert.ok(body.includes(path), body);
  assert.match(body, /instrument-path/);
  assert.ok(body.includes(signature), body);
  const routed = f.rows.find((row) => row.step === "fix.scope_amendment");
  assert.equal(routed?.outcome, "instrument-escalated");
  assert.deepEqual(routed?.paths, [docs, instrument]);
  assert.equal(routed?.head_sha, f.headSha);
  assert.equal(f.rows.filter((row) => row.step === "fix.commit_refused").length, 0, "no refused round re-enters the loop");
  assert.equal(result.outcome, "stood_down");
  assert.match(result.reason ?? "", /instrument scope need escalated/);
  assert.deepEqual(f.counts(), { pushes: 0, shardReads: 0 }, "no amendment is attempted for a path it always refuses");
  await runFixRung(f.run);
  assert.equal(f.issues.length, 1, "the same instrument need at the same head is delivered once");
});

test("PR 13223: a scope need with no instrument still goes to the scope amendment", async () => {
  const f = rung([docs], [docs]);
  await runFixRung(f.run);
  assert.equal(f.issues.length, 0);
  assert.ok(f.counts().shardReads > 0, "positive control: the amendment writer was asked");
  assert.ok(!f.rows.some((row) => row.outcome === "instrument-escalated"));
});

test("PR 13223: the instrument predicate is the amendment validator's own refusal set", () => {
  for (const path of [instrument, "scripts/comment-load-baseline.json", ".github/workflows/ci.yml", "src/lib/review.ts"]) {
    assert.equal(isUngrantableInstrumentPath(path), true, path);
  }
  for (const path of [docs, ownPath, "stryker.conf.json", "scripts/mutation-relevant-paths.json"]) {
    assert.equal(isUngrantableInstrumentPath(path), false, path);
  }
});

