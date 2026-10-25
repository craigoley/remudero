import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { OpenIssue } from "#src/lib/escalate.js";
import { scopeEscalationStandDown, unfiledScopeGrant } from "#src/lib/fix-progress-judge.js";
import { DEFAULT_SWEEP_POLICY, runSweep, runSweepLightPass, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

// #14217, 2026-10-25: an unfiled PR asked for scripts/mutation-relevant-paths.json (#14225, head 409e894a7). The fleet
// then merged main into it twice (ceb90ec37, 4ec1cb698); each new head released the hold, re-paid a round and filed a
// new issue (#14273) for the same path. The owner's approval landed nowhere a fix round reads.
const PR = 14217;
const KEY = `PR-${PR}`;
const HEAD = "4ec1cb698140a65a9b391f4974508b864d2f7f2d";
const ISSUE = "https://github.com/acme/remudero/issues/14273";
const HELD = "scripts/mutation-relevant-paths.json";
const RED = "test/mutation-trigger-covers-its-own-command.test.ts";
const held = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  task_id: KEY, step: "fix.scope_amendment", pr_number: PR, head_sha: HEAD, outcome: "unfiled-escalated",
  paths: [HELD], issue_url: ISSUE, red_test_files: [RED], ...extra,
});
const answered = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  task_id: KEY, step: "panel.question_answered", answer: "revise-pr", origin: "issue#14273:comment:9",
  author_login: "craigoley", authority: "repository-owner", ...extra,
});
const failure = (file = RED) => ({ name: "ci-shard (2/8)",
  logTail: `not ok 1 - W1-T108/R-42: positive control\n  location: '/home/runner/work/remudero/remudero/${file}:70:1'` });
const view = (extra: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: "unfiled", headSha: "a-refreshed-head",
  checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
  autoMergeArmed: false, lastActivityAt: new Date().toISOString(), redRequiredChecks: ["ci-shard (2/8)"],
  ciFailures: [failure()], changedFiles: ["stryker.conf.json"], ...extra,
});
function sweepFixture(initial: Record<string, unknown>[]) {
  const rows = [...initial];
  const calls = { judges: 0, fixes: 0, escalations: 0, arms: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/unfiled-scope-grant", runId: "unfiled-scope-grant", now: () => Date.now(),
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => { calls.judges++; return { verdict: "continue", reason: "fixture permits another round" }; },
    dispatchFix: () => { calls.fixes++; }, escalate: () => { calls.escalations++; },
    arm: () => { calls.arms++; }, close: () => {},
  };
  return { rows, calls, deps };
}

test("an unfiled scope hold carries to a refreshed head that still lacks its paths and spends no round", async () => {
  for (const pass of [runSweep, runSweepLightPass]) {
    const f = sweepFixture([held()]);
    await pass([view()], f.deps, DEFAULT_SWEEP_POLICY);
    await pass([view()], f.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(f.calls, { judges: 0, fixes: 0, escalations: 0, arms: 0 }, pass.name);
    const disposed = f.rows.filter(r => r.step === "sweep.disposed");
    assert.ok(disposed.length >= 2, "positive control: both passes disposed the real PR");
    assert.ok(disposed.every(r => r.acted === false));
    assert.ok(disposed.some(r => String(r.stand_down_reason).includes(`${ISSUE}; held since head ${HEAD}`)),
      "the carried question and the head it was asked at stay visible");
    assert.ok(disposed.some(r => String(r.stand_down_reason).includes(`grants exactly ${HELD} to this PR by answering revise-pr`)),
      "the stand-down names the one answer that releases it");
  }
});

test("an unfiled scope hold releases at a head that changed what the question was about", async () => {
  for (const [extra, row] of [
    [{ changedFiles: ["stryker.conf.json", HELD] }, {}], // the owner pushed the held path
    [{ changedFiles: undefined }, {}], // the head's paths are unread: no evidence the question is unchanged
    [{ ciFailures: [failure("test/another-suite.test.ts")] }, {}], // a red the question never saw
    [{ ciFailures: [{ name: "ci-shard (1/8)", logTail: "error TS2304: Cannot find name 'x'" }] }, {}], // a red naming no test file
    [{}, { red_test_files: undefined }], // a hold recorded before this carry existed
    [{ prNumber: PR + 1, prUrl: `https://github.com/acme/remudero/pull/${PR + 1}` }, {}],
    [{ taskId: "W1-T9001" }, {}],
  ] as const) {
    const f = sweepFixture([held(row)]);
    await runSweep([view(extra as Partial<OpenPrView>)], f.deps, DEFAULT_SWEEP_POLICY);
    assert.ok(f.calls.fixes > 0, JSON.stringify({ extra, row, calls: f.calls }));
  }
});

test("the owner's revise-pr answer on the escalation issue grants exactly the held paths and releases the hold", async () => {
  assert.deepEqual(unfiledScopeGrant([held(), answered()], { prNumber: PR }),
    { paths: [HELD], issueUrl: ISSUE, origin: "issue#14273:comment:9", heldHead: HEAD });
  assert.equal(unfiledScopeGrant([held(), answered({ origin: "console-token-1" })], { prNumber: PR })?.origin, "console-token-1",
    "the console's answer route is the other channel the question names");
  for (const pass of [runSweep, runSweepLightPass]) {
    const f = sweepFixture([held(), answered()]);
    await pass([view({ headSha: HEAD })], f.deps, DEFAULT_SWEEP_POLICY);
    assert.ok(f.calls.judges + f.calls.fixes > 0, `${pass.name}: a granted hold is released: ${JSON.stringify(f.calls)}`);
    assert.equal(f.rows.filter(r => r.step === "sweep.disposed" && String(r.stand_down_reason).includes(ISSUE)).length, 0);
  }
});

test("no other answer, issue, order or PR grants an unfiled scope", () => {
  const atHead = { taskId: "unfiled", prNumber: PR, headSha: HEAD };
  for (const ledger of [
    [held()],
    [answered(), held()], // an answer older than the question
    [held(), answered({ answer: "route-repair" })],
    [held(), answered({ answer: "revise-pr, but only the test" })],
    [held(), answered({ origin: "issue#14225:comment:9" })], // a reply on another issue
    [held(), answered({ task_id: `PR-${PR + 1}` })],
    [held(), answered({ step: "escalation_answer.ignored" })],
  ]) {
    assert.equal(unfiledScopeGrant(ledger, { prNumber: PR }), undefined, JSON.stringify(ledger));
    assert.match(scopeEscalationStandDown(ledger, atHead)?.reason ?? "", /^unfiled scope decision awaits resolution at this head/);
  }
  assert.ok(scopeEscalationStandDown([held()], atHead)?.reason.endsWith(
    `; the repository owner grants exactly ${HELD} to this PR by answering revise-pr on that issue`), "the hold names its release");
  assert.equal(scopeEscalationStandDown([held(), answered()], atHead), undefined, "positive control: the grant releases");
  assert.match(scopeEscalationStandDown([held(), answered(), held({ round_id: "after-grant" })], atHead)?.reason ?? "",
    /^unfiled scope decision awaits resolution/, "a question asked after the grant is held again");
});

// ── the fix rung, driven for real against a git fixture ─────────────────────────────────────────────────────────────
type Run = Parameters<typeof runFixRung>[0];
type Row = { step: string } & Record<string, unknown>;
const ownPath = "stryker.conf.json";
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
const signature = `ci-shard (2/8): not ok 1 - W1-T108/R-42 — ${RED}`;

function rungFixture(seed: (headSha: string) => Row[]) {
  const repo = gitRepo({ kind: "unfiled-scope-grant" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  for (const path of [ownPath, HELD]) put(path, "{}\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("checkout", "-qb", "run-unfiled-1792950900000");
  put(ownPath, '{"command":"new"}\n');
  repo.git("add", "-A");
  repo.git("commit", "-qm", "unfiled change");
  const headSha = repo.git("rev-parse", "HEAD");
  const rows: Row[] = seed(headSha);
  const issues: Array<{ title: string; body: string; url: string }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  let pushes = 0;
  const review = {
    state: "failure", criteria: [{ claim: "ci green", proof: "unit test: ci", met: false,
      reason: signature, proof_exec: "not_executable" }], testTheater: false, summary: signature,
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha,
    reviewerOutcome: "failure",
  } as Run["initialReview"];
  const run: Run = {
    taskId: KEY, runId: "unfiled-scope-grant-run",
    task: { id: KEY, title: "unfiled change", files: [ownPath] },
    prUrl: `https://github.com/acme/remudero/pull/${PR}`, branch: "run-unfiled-1792950900000",
    worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [failure()],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "owner must decide the scope" }),
    deps: {
      spawn: async () => {
        put(HELD, '{"paths":["new"]}\n');
        return { text: `REPORT\nThe command now runs a suite the inventory does not list.\nFIX_OUTCOME: NEEDS_SCOPE ${HELD}\n` +
            "COMMIT_MESSAGE: fix(test): list the suite in the mutation inventory", blocks: [], sessionId: "scope",
          costUsd: 1, numTurns: 1, subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          stderr: "", model: "sonnet", effort: "medium", compactionEvents: [], qualitySuspect: false,
          modelUsage: {}, provider: "codex" } as WorkerResult;
      },
      fetchPrBody: async () => "An unfiled change with no task trailer.",
      fetchPrDiffFiles: async () => repo.git("diff", "--name-only", "origin/main...HEAD").split("\n").filter(Boolean),
      push: () => { pushes++; },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success", headSha: repo.git("rev-parse", "HEAD") }),
      issues: {
        create: (title, body) => {
          const url = `https://github.com/acme/remudero/issues/${issues.length + 1}`;
          issues.push({ title, body, url });
          return url;
        },
        listOpen: (): OpenIssue[] => issues.map((issue, i) => ({ number: i + 1, ...issue })),
        comment: (url, body) => { comments.push({ url, body }); },
      },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: KEY, pr_number: PR, ...extra }),
      say: () => {}, account: (r) => r,
    },
  };
  const refresh = () => {
    repo.git("commit", "--allow-empty", "-qm", "Merge branch 'main' into run-unfiled-1792950900000");
    run.initialReview = { ...run.initialReview, headSha: repo.git("rev-parse", "HEAD") };
  };
  return { repo, run, rows, issues, comments, headSha, refresh, pushes: () => pushes };
}

test("an unfiled scope question re-asked at a refreshed head appends to its open issue instead of filing another", async () => {
  const f = rungFixture(() => []);
  await runFixRung(f.run);
  assert.equal(f.issues.length, 1, JSON.stringify(f.rows.filter(r => r.step.startsWith("fix.scope"))));
  f.refresh();
  await runFixRung(f.run);
  assert.equal(f.issues.length, 1, "the same paths at a refreshed head are the same open question");
  assert.equal(f.comments.length, 1, "the refreshed head's observation is appended to that issue");
  assert.equal(f.comments[0]!.url, f.issues[0]!.url);
  const asked = f.rows.filter(r => r.step === "fix.scope_amendment" && r.outcome === "unfiled-escalated");
  assert.equal(asked.length, 2);
  assert.notEqual(asked[0]!.head_sha, asked[1]!.head_sha, "positive control: two different heads asked");
  assert.equal(asked[0]!.identity_key, asked[1]!.identity_key);
  assert.deepEqual(asked.map(r => r.issue_url), [f.issues[0]!.url, f.issues[0]!.url]);
  assert.deepEqual(asked[1]!.red_test_files, [RED], "the red the question saw is recorded for the sweep's carry");
  assert.equal(f.pushes(), 0);
});

test("a granted unfiled fix round commits exactly the granted out-of-diff path", async () => {
  const f = rungFixture((headSha) => [held({ head_sha: headSha }) as Row, answered() as Row]);
  const result = await runFixRung(f.run);
  assert.equal(result.outcome, "fixed", JSON.stringify({ result, rows: f.rows.filter(r => r.step.startsWith("fix.")) }));
  assert.equal(f.pushes(), 1);
  assert.equal(f.issues.length, 0, "a granted path is not asked again");
  assert.equal(f.repo.git("show", `HEAD:${HELD}`), '{"paths":["new"]}');
  assert.deepEqual(f.repo.git("diff", "--name-only", `${f.headSha}..HEAD`).split("\n"), [HELD]);
  const admitted = f.rows.find(r => r.step === "fix.scope_amendment" && r.outcome === "unfiled-granted");
  assert.deepEqual(admitted?.granted_paths, [HELD]);
  assert.equal(admitted?.issue_url, ISSUE);
  assert.equal(admitted?.grant_origin, "issue#14273:comment:9");
});

test("a grant for other paths never admits an unfiled PR's out-of-diff path", async () => {
  const f = rungFixture((headSha) => [held({ head_sha: headSha, paths: ["scripts/another-inventory.json"] }) as Row, answered() as Row]);
  const result = await runFixRung(f.run);
  assert.equal(result.outcome, "stood_down");
  assert.equal(f.pushes(), 0);
  assert.equal(f.repo.git("rev-parse", "HEAD"), f.headSha, "nothing outside the diff or the grant was committed");
  assert.equal(f.issues.length, 1, "the new path is asked");
  assert.equal(f.rows.filter(r => r.outcome === "unfiled-granted").length, 0);
});
