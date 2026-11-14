// W1-T12543: 48 h of ledger (2026-11-11 21:45Z to 2026-11-13 21:45Z) showed 47 PR-hours of escalation holds and
// 23 fix rounds that ended NEEDS_SCOPE or NEEDS_DESIGN. A scope amendment refused once for a reason a fresh read can
// clear sent the PR to a person. These tests drive the real fix rung through its production entry.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { SCOPE_AMENDMENT_RETRYABLE_REFUSALS, type ProofAmendmentRecord, type ProofAmendmentWritePorts } from "#src/lib/proof-amendment.js";
import { runFixRung } from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type Row = { step: string } & Record<string, unknown>;
const taskId = "W1-T12543X";
const prNumber = 7;
const shardPath = `plan/tasks.d/${taskId}-fixture.yaml`;
const goodShard = `- id: ${taskId}\n  files: [src/declared.ts]\n  acceptance:\n    - claim: unchanged\n      proof: 'unit test: unchanged'\n`;
const driftedShard = `- id: ${taskId}\n  files: src/declared.ts\n`;
const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 20, contextBudget: 120000 };
const mainLog = "src/shared.ts(1,14): error TS2339: Property 'readPaced' does not exist";

// main changes src/shared.ts after the merge base; the branch changes only its declared file.
function branchBehindMain() {
  const repo = gitRepo({ kind: "w1-t12543-scope" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  put("src/declared.ts", "export const declared = 1;\n");
  put("src/shared.ts", "export const shared = 1;\n");
  put(".github/workflows/ci.yml", "name: ci\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed");
  const seed = repo.git("rev-parse", "HEAD");
  put("src/shared.ts", "export const shared = 2;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main changes shared");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const mainSha = repo.git("rev-parse", "HEAD");
  repo.git("reset", "-q", "--hard", seed);
  put("src/declared.ts", "export const declared = 2;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "the PR's own change");
  return { repo, put, mainSha };
}

interface Plan {
  /** paths the worker names in NEEDS_SCOPE */ requested?: string[];
  /** paths the worker edits */ edited?: string[];
  /** shard text per findShard call; the last one repeats */ shards?: string[];
  /** fetchPrBody throws on these 1-based calls */ bodyThrowsOn?: number[];
  existingAmendment?: boolean;
  branch?: string;
  body?: string;
  taskId?: string;
}

function harness(plan: Plan = {}) {
  const { repo, put, mainSha } = branchBehindMain();
  const requested = plan.requested ?? ["src/shared.ts"];
  const edited = plan.edited ?? requested;
  const shards = plan.shards ?? [goodShard];
  const rows: Row[] = [];
  const records = new Map<string, ProofAmendmentRecord>();
  const prs: string[] = [];
  const issues: Array<{ title: string; body: string }> = [];
  const updates: number[] = [];
  let shardReads = 0;
  let bodyReads = 0;
  let spawns = 0;
  const ports: ProofAmendmentWritePorts = {
    repoDir: repo.dir,
    findShard: () => ({ path: shardPath, text: shards[Math.min(shardReads++, shards.length - 1)] }),
    worktreeAdd: () => {}, worktreeRemove: () => {}, writeFile: () => {}, gitAdd: () => {},
    gitCommit: () => "amendment-sha", gitPush: () => {}, probeExisting: () => plan.existingAmendment
      ? { prUrl: "https://github.com/acme/remudero/pull/99", prNumber: 99 } : undefined,
    createPr: (opts) => { prs.push(opts.head); return { prUrl: "https://github.com/acme/remudero/pull/99", prNumber: 99 }; },
    worktreePathFor: () => "/amendment", lookupIdentity: (key) => records.get(key),
    recordIdentity: (key, record) => { records.set(key, record); }, updateBranch: () => ({ ok: true }),
  };
  const round = async (ciLog?: string) => {
    const headSha = repo.git("rev-parse", "HEAD");
    const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
      state: "failure", criteria: [{ claim: "selector edge", proof: "unit test: edge", met: false, reason: "red",
        proof_exec: "not_executable" }], summary: "red", testTheater: false, floorDegraded: false, capped: false,
      keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "failure",
    };
    return runFixRung({
      taskId: plan.taskId ?? taskId, runId: `${taskId}-run`, task: { id: plan.taskId ?? taskId, title: "selector edge", files: ["src/declared.ts"] },
      prUrl: `https://github.com/acme/remudero/pull/${prNumber}`, branch: plan.branch ?? `run-${taskId}-1`,
      worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
      config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
      budgetUsd: 10, strikeCap: 2, initialReview: review,
      ...(ciLog === undefined ? {} : { ciFailures: [{ name: "ci-shard (1/8)", logTail: ciLog }] }),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
      escalationJudge: async () => ({ decision: "deliver", reason: "fixture delivers" }),
      deps: {
        spawn: async () => {
          spawns++;
          for (const path of edited) put(path, `export const edit = ${spawns};\n`);
          return {
            sessionId: "fix-session", costUsd: 0, numTurns: 1, text: `FIX_OUTCOME: NEEDS_SCOPE ${requested.join(",")}`, blocks: [],
            stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false,
          } satisfies WorkerResult;
        },
        scopeAmendmentWritePorts: ports,
        updateBranch: (n) => { updates.push(n); return { ok: true }; },
        fetchPrDiffFiles: async () => ["src/declared.ts"],
        waitForCiGreen: async () => "green",
        runReview: async () => review,
        fetchPrBody: async () => {
          bodyReads++;
          if (plan.bodyThrowsOn?.includes(bodyReads)) throw new Error(`gh pr view failed on read ${bodyReads}`);
          return plan.body ?? `Remudero-Task: ${taskId}`;
        },
        readHeadShaForProvenance: () => repo.git("rev-parse", "HEAD"),
        push: () => {},
        issues: { create: (title, body) => { issues.push({ title, body }); return "https://github.com/acme/remudero/issues/1"; },
          listOpen: () => [], comment: () => {} },
        ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
        log: (step, extra) => { rows.push({ step, task_id: plan.taskId ?? taskId, pr_number: prNumber, ...extra }); }, say: () => {}, account: (result) => result,
      },
    });
  };
  const scopeRows = () => rows.filter((row) => row.step === "fix.scope_amendment");
  const refusals = () => rows.filter((row) => row.step === "fix.commit_refused");
  return { repo, mainSha, rows, prs, issues, updates, round, scopeRows, refusals,
    counts: () => ({ spawns, shardReads, bodyReads }) };
}

async function replaySweep(rows: Row[], reviewFailure: boolean, headSha: string, priorStrikes = 0) {
  const delivered: Array<{ reason: string; question: string }> = [];
  let judgments = 0;
  let dispatches = 0;
  const now = Date.now();
  const pr: OpenPrView = {
    taskId, prNumber, prUrl: `https://github.com/acme/remudero/pull/${prNumber}`, headSha,
    checksState: reviewFailure ? "green" : "red", reviewState: reviewFailure ? "failure" : "pending",
    unmetCriteria: reviewFailure ? [{ claim: "selector edge", proof: "unit test: edge", reason: "repair the selector",
      met: false, proof_exec: "not_executable" }] : [],
    ciFailures: reviewFailure ? [] : [{ name: "ci-shard (1/8)", logTail: "selector assertion failed" }],
    priorStrikes, autoMergeArmed: false, lastActivityAt: new Date(now).toISOString(),
  };
  const ledger = rows.map(row => ({ ...row }));
  const deps: SweepDeps = {
    ledgerPath: "/unused/scope-escalation-ledger", runId: "scope-escalation-replay", now: () => now,
    readLedger: () => ledger, appendLine: (_path, row) => { ledger.push({ ...row, step: String(row.step) }); },
    arm: () => {}, close: () => {}, dispatchFix: () => { dispatches++; },
    fixProgressJudge: async () => {
      judgments++;
      return { verdict: "escalate", loop: "scope repair blocked", reason: "human decision required" };
    },
    escalate: (_pr, reason, question) => { delivered.push({ reason, question: question.question }); },
  };
  const result = await runSweep([pr], deps);
  return { delivered, judgments, dispatches, result };
}

async function replayEscalation(rows: Row[], reviewFailure: boolean, headSha: string, priorStrikes = 0) {
  const { delivered, judgments, dispatches } = await replaySweep(rows, reviewFailure, headSha, priorStrikes);
  assert.ok(judgments > 0, "control: the replay reached the progress judge");
  assert.equal(dispatches, 0, "an escalation must not dispatch another fix worker");
  assert.equal(delivered.length, 1, "control: the sweep delivered the escalation question");
  return delivered[0]!;
}

test("W1-T12543 criterion 1: a retryable refusal is asked once more in the same round and the round awaits the amendment", async () => {
  for (const plan of [
    { bodyThrowsOn: [1] }, { shards: [driftedShard, goodShard] },
    { bodyThrowsOn: [1], existingAmendment: true },
  ] satisfies Plan[]) {
    const h = harness(plan);
    const result = await h.round();
    const outcome = plan.existingAmendment ? "resumed" : "created";
    const scope = h.scopeRows().map((row) => [row.outcome, row.reason, row.retry]);
    assert.deepEqual(scope, [["refused", scope[0]?.[1], undefined], [outcome, undefined, 1]], JSON.stringify(plan));
    assert.ok(SCOPE_AMENDMENT_RETRYABLE_REFUSALS.has(String(scope[0]?.[1])), String(scope[0]?.[1]));
    assert.deepEqual(h.prs, plan.existingAmendment ? [] : [`scope-amendment/${taskId}-${prNumber}`],
      "the second ask creates or resumes the amendment");
    assert.equal(h.refusals().length, 0, "no refused commit, so no refusal can reach a person");
    assert.equal(h.issues.length, 0);
    assert.equal(result.outcome, "stood_down");
    assert.equal(result.reason, "awaiting scope amendment merge");
    assert.equal(h.rows.findLast((row) => row.step === "fix.done")?.subtype, "scope_amendment_pending");
    assert.equal(h.counts().spawns, 1, "one worker round");
    const headSha = String(h.scopeRows().at(-1)?.head_sha);
    for (const reviewFailure of [false, true]) {
      const replay = await replaySweep(h.rows, reviewFailure, headSha);
      assert.equal(replay.delivered.length, 0, `${outcome}: a pending amendment must not escalate`);
      assert.equal(replay.dispatches, 0, `${outcome}: no fix worker before the amendment merges`);
      assert.equal(replay.result.actions[0]?.acted, false);
      assert.match(String(replay.result.actions[0]?.reason), /fix report requests a scope amendment/);
    }
  }
});

test("W1-T12543 criterion 2: a main-owned refusal refreshes the base and the refreshed head asks for the amendment first", async () => {
  const h = harness();
  const first = await h.round(mainLog);
  assert.equal(h.scopeRows().at(-1)?.reason, "main-owned");
  assert.deepEqual(h.updates, [prNumber], "the round requests the base refresh itself");
  const refreshed = h.rows.find((row) => row.step === "fix.base_refreshed");
  assert.equal(refreshed?.reason, "scope-main-owned");
  assert.deepEqual(refreshed?.scope_amendment_after_refresh, ["src/shared.ts"]);
  assert.equal(first.reason, "scope_amendment_after_refresh");
  assert.deepEqual(h.prs, [], "main-owned never reaches the amendment writer");
  h.repo.git("checkout", "-q", "--", ".");
  h.repo.git("merge", "-q", "--no-edit", h.mainSha);
  const next = await h.round(mainLog);
  assert.equal(h.counts().spawns, 1, "the refreshed head asks for the amendment before any new worker round");
  assert.deepEqual(h.prs, [`scope-amendment/${taskId}-${prNumber}`]);
  assert.equal(h.scopeRows().at(-1)?.outcome, "created");
  assert.equal(next.reason, "awaiting scope amendment merge");
  assert.equal(h.issues.length, 0, "no escalation on either round");
});

test("W1-T12543 criterion 3: the delivered escalation names the last non-retryable or second scope refusal", async () => {
  const twice = harness({ shards: [driftedShard] });
  await twice.round();
  assert.deepEqual(twice.scopeRows().map((row) => [row.reason, row.retry]), [["shard-drifted", undefined], ["shard-drifted", 1]]);
  const [refused] = twice.refusals();
  assert.equal(refused?.scope_amendment_refusal, "shard-drifted");
  assert.match(String(refused?.scope_amendment_refusal_detail), /one readable files sequence/);
  assert.equal(refused?.scope_amendment_asks, 2);
  assert.match(String(refused?.reason), /^non-test paths need scope \(shard-drifted: /);
  assert.deepEqual(twice.prs, []);

  const once = harness({ requested: ["src/shared.ts"], edited: ["src/declared.ts"] });
  await once.round();
  assert.deepEqual(once.scopeRows().map((row) => [row.reason, row.retry]), [["path-not-changed", undefined]]);
  assert.equal(SCOPE_AMENDMENT_RETRYABLE_REFUSALS.has("path-not-changed"), false);
  const [plain] = once.refusals();
  assert.equal(plain?.scope_amendment_refusal, "path-not-changed");
  assert.equal(plain?.scope_amendment_asks, 1);
  assert.match(String(plain?.reason), /path-not-changed: src\/shared\.ts/);
  assert.equal(once.issues.length + twice.issues.length, 0, "the rung itself files no issue; the sweep reads the named refusal");

  const changed = harness({ bodyThrowsOn: [1], shards: [driftedShard] });
  await changed.round();
  assert.deepEqual(changed.scopeRows().map(row => [row.reason, row.retry]),
    [["scope-amendment-error", undefined], ["shard-drifted", 1]], "the retry can fail for a different reason");
  for (const h of [twice, once, changed]) {
    const refusal = h.refusals().at(-1)!;
    for (const [reviewFailure, strikes] of [[false, 0], [true, 0], [false, 3], [true, 3]] as const) {
      const delivered = await replayEscalation(h.rows, reviewFailure, String(refusal.head_sha), strikes);
      assert.match(delivered.reason, /scope repair blocked/);
      for (const text of [delivered.reason, delivered.question]) {
        assert.ok(text.includes(String(refusal.scope_amendment_refusal)), text);
        assert.ok(text.includes(String(refusal.scope_amendment_refusal_detail)), text);
        if (h === changed) assert.doesNotMatch(text, /scope-amendment-error|gh pr view failed/);
      }
    }
  }
});

test("scope refusal escalation context does not carry across a new head or a superseding round", async () => {
  const h = harness({ shards: [driftedShard] });
  await h.round();
  const headSha = String(h.refusals().at(-1)!.head_sha);
  const superseded: Row[] = [...h.rows,
    { step: "fix.dispatch", task_id: taskId, pr_number: prNumber, head_sha: headSha, round_id: "next-round", strike: 2 },
    { step: "fix.done", task_id: taskId, pr_number: prNumber, head_sha: headSha, round_id: "next-round", subtype: "success" },
  ];
  for (const [rows, head] of [[h.rows, "new-head"], [superseded, headSha]] as const) {
    const delivered = await replayEscalation([...rows], true, head);
    assert.doesNotMatch(delivered.reason, /last scope amendment refusal|shard-drifted/i);
    assert.doesNotMatch(delivered.question, /last scope amendment refusal|shard-drifted/i);
  }
});

test("W1-T12543 criterion 4: workflow, instrument and unfiled scope still escalate at once with no amendment asked", async () => {
  const cases: Array<[Plan, string]> = [
    [{ requested: [".github/workflows/ci.yml"] }, "workflow-escalated"],
    [{ requested: ["scripts/comment-load-baseline.json"] }, "instrument-escalated"],
    [{ taskId: `PR-${prNumber}`, branch: "run-unfiled-1794610450000", body: "no trailer" }, "unfiled-escalated"],
  ];
  for (const [plan, outcome] of cases) {
    const h = harness(plan);
    const result = await h.round();
    assert.equal(h.issues.length, 1, JSON.stringify(h.scopeRows()));
    assert.deepEqual(h.scopeRows().map((row) => [row.outcome, row.retry]), [[outcome, undefined]]);
    assert.equal(h.counts().shardReads, 0, "the amendment writer is never asked");
    assert.deepEqual(h.prs, []);
    assert.equal(result.outcome, "stood_down");
  }
});
