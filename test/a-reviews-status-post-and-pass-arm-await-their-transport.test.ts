// W1-T9549 — the daemon runs every review (`trackInFlightReview(runReview(job))`), and a PASS ended in the
// synchronous armIfVerdictPermits -> armAutoMergeDetailed -> realArmDeps, while the status post and its
// lifecycle read spawned `gh` synchronously too: about 90 s of a held loop in 6 h on 2026-10-14. The review
// now awaits armIfVerdictPermitsAsync (over armAutoMergeDetailedAsync / realArmDepsAsync), the status post
// awaits ghTextAsync with the poster's own env, and the lifecycle read awaits ghJsonAsync.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
  armAutoMergeDetailedAsync,
  armIfVerdictPermits,
  armIfVerdictPermitsAsync,
  type ArmAttemptResult,
  type ArmDeps,
  type ArmOutcome,
} from "#src/lib/arm-auto-merge.js";
import type { Config } from "#src/lib/config.js";
import { ghTextAsync } from "#src/lib/github-transport.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { REPAIR_LEASE_CONTEXT, fetchPrLifecycleAsync, postRepairLease, postReviewStatus } from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { runReview, buildSweepEffects, depReviewCommand } from "#src/run-task.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import { readFileSync } from "node:fs";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";

const HEAD_SHA = "9549aaaabbbbccccddddeeeeffff000011112222";
const PR_URL = "https://github.com/acme/remudero/pull/9549";
const TASK_ID = "W1-T9549";
const PASS = { state: "success", capped: false, planOnly: false } as const;

type Row = [string, Record<string, unknown>];

/** Every synchronous spawn primitive, replaced by one that records and THROWS — on the named imports too. */
async function withSyncSpawnsTrapped<T>(fn: () => Promise<T>): Promise<{ value: T; trapped: string[] }> {
  const trapped: string[] = [];
  const target = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  const mocks = (["execFileSync", "spawnSync", "execSync"] as const).map((name) =>
    mock.method(target, name, (file: unknown, args: unknown) => {
      trapped.push(`${name} ${String(file)} ${Array.isArray(args) ? args.join(" ") : ""}`.trim());
      throw new Error(`W1-T9549 trap: a synchronous ${name} on the review path`);
    }),
  );
  syncBuiltinESMExports();
  try {
    return { value: await fn(), trapped };
  } finally {
    for (const m of mocks) m.mock.restore();
    syncBuiltinESMExports();
  }
}

/** Runs `fn` with `shim` first on PATH, then restores PATH; the caller removes the shim after reading its calls. */
async function onShim<T>(shim: GhShim, fn: () => Promise<T>): Promise<T> {
  const priorPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${priorPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = priorPath;
  }
}

test("W1-T9549: a PASS review arms through the awaited transport with sync spawns trapped", async () => {
  // The head read fails before any write leaf, so the real default arm stops at `head-unavailable`;
  // the sync driver's readHeadShaRest would have spawned `gh` through the trapped execFileSync.
  const shim = ghShim([{ when: "pulls/9549", stderr: "HTTP 502", exit: 1 }], { kind: "t9549-arm" });
  const rows: Row[] = [];
  const { value: outcome, trapped } = await onShim(shim, () => withSyncSpawnsTrapped(() =>
    withLiveWritesAllowed(() => armIfVerdictPermitsAsync(PASS, {
      prUrl: PR_URL,
      taskId: TASK_ID,
      headSha: HEAD_SHA,
      ledgerPath: join(tmpdir(), `${RMD_TMP_PREFIX}t9549-unused-ledger.ndjson`),
      log: (step, extra = {}) => void rows.push([step, extra]),
    }))));
  assert.deepEqual(trapped, [], "the review arm made no synchronous spawn");
  assert.equal(outcome, "head-unavailable");
  assert.ok(shim.calls().some((c) => c.includes("pulls/9549")), `the default arm read the head through gh: ${shim.calls().join(" | ")}`);
  const outcomeRow = rows.find(([, extra]) => extra.outcome === "head-unavailable");
  assert.ok(outcomeRow, `the arm's outcome is ledgered: ${JSON.stringify(rows)}`);
  assert.equal(outcomeRow[1].head_sha, HEAD_SHA);
  rmSync(shim.dir, { recursive: true, force: true });
});

test("W1-T9549: a review status post and lifecycle read await gh with sync spawns trapped", async () => {
  const pull = { number: 9549, state: "open", merged_at: null, body: "the body", head: { sha: HEAD_SHA }, base: { ref: "main" } };
  const shim = ghShim([
    { when: "statuses/", stdout: "{}", delaySeconds: 0.4 },
    { when: "pulls/9549", stdout: JSON.stringify(pull) },
    { when: "token-probe", stdoutEnv: "GH_TOKEN" },
  ], { kind: "t9549-post" });
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9549-post-`));
  const ticks: string[] = [];
  try {
    const { value, trapped } = await onShim(shim, () => withSyncSpawnsTrapped(async () => {
      const timer = setTimeout(() => ticks.push("timer"), 50);
      await postReviewStatus({ owner: "acme", repo: "remudero", sha: HEAD_SHA, state: "success", description: "remudero-review: PASS" });
      ticks.push("posted");
      clearTimeout(timer);
      const lifecycle = await fetchPrLifecycleAsync(PR_URL);
      const lease = await postRepairLease({ owner: "acme", repo: "remudero", sha: HEAD_SHA, taskId: TASK_ID, runId: "RUN-T9549", ledgerPath: join(root, "ledger.ndjson") });
      const token = await ghTextAsync(["api", "token-probe"], { env: { ...process.env, GH_TOKEN: "t9549-reviewer-token" } });
      return { lifecycle, lease, token };
    }));
    assert.deepEqual(trapped, [], "neither the post, the lifecycle read nor the lease spawned synchronously");
    assert.deepEqual(ticks, ["timer", "posted"], "a timer fired while the status POST's gh child was in flight");
    const calls = shim.calls();
    assert.ok(calls.some((c) => c.includes(`repos/acme/remudero/statuses/${HEAD_SHA}`) && c.includes("context=remudero-review")), calls.join(" | "));
    assert.ok(calls.some((c) => c.includes(`context=${REPAIR_LEASE_CONTEXT}`)), `the repair lease posts through the same exec: ${calls.join(" | ")}`);
    assert.equal(value.lease.posted, true);
    assert.equal(value.lifecycle.merged, false);
    assert.equal(value.lifecycle.closed, false);
    assert.equal(value.lifecycle.baseRef, "main");
    assert.equal(typeof value.lifecycle.reviewInputDigest, "string", "the same fold keeps the head+body identity");
    assert.equal(value.token.trim(), "t9549-reviewer-token", "the poster's own env (the reviewer token) reaches the gh child");
    await assert.rejects(fetchPrLifecycleAsync("not-a-pr-url"), /cannot resolve owner\/repo\/number/, "an unparseable PR url is refused, never guessed");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

// A plan-only diff: W1-T205's carve-out arms a structurally capped filing PR, so the run reaches the arm
// without executing a proof (the fixture test/a-lost-review-posted-row-is-reappended-before-the-arm-gate-reads uses).
const DIFF = [
  "diff --git a/plan/tasks.d/W1-T9549.yaml b/plan/tasks.d/W1-T9549.yaml",
  "--- a/plan/tasks.d/W1-T9549.yaml",
  "+++ b/plan/tasks.d/W1-T9549.yaml",
  "@@ -1 +1 @@",
  "-status: queued",
  "+status: queued # noted",
].join("\n");
const CRITERION = { claim: "the shard carries its note", proof: "grep: noted plan/tasks.d/W1-T9549.yaml" };
const BODY = `Acceptance: ${CRITERION.claim} — ${CRITERION.proof} matched`;

test("W1-T9549: a slow gh during the review arm does not delay a concurrent timer", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9549-review-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const shim = ghShim([
    { when: "arm-probe", stdout: "{}", delaySeconds: 1 },
    { when: "headRefOid", stdout: JSON.stringify({ headRefOid: HEAD_SHA }) },
    { when: "pr diff", stdout: DIFF },
    {
      when: "pulls/",
      stdout: JSON.stringify({ number: 9549, html_url: PR_URL, updated_at: "t", body: BODY, state: "open", head: { ref: `run-${TASK_ID}-1`, sha: HEAD_SHA } }),
    },
    { when: "/statuses?", stdout: "[[]]" },
    { when: "/status", stdout: JSON.stringify({ state: "success", statuses: [] }) },
  ], { kind: "t9549-review" });
  const order: string[] = [];
  const ticks: number[] = [];
  let window: { start: number; end: number } | undefined;
  // The REAL W1-T230 gate under the awaited driver, reading the review's own ledger; only its write
  // leaf is faked, and that leaf awaits a gh child that takes a second.
  const gate = {
    headSha: async () => HEAD_SHA,
    ledgerLines: () => readLedgerLines(ledgerPath),
    armAuto: async () => {
      const start = Date.now();
      await ghTextAsync(["api", "repos/acme/remudero/arm-probe"]);
      window = { start, end: Date.now() };
    },
    mergeDirect: async () => {
      throw new Error("the fixture never merges directly");
    },
    disableAuto: async () => {},
    say: () => {},
  } as unknown as ArmDeps<true>;
  const interval = setInterval(() => ticks.push(Date.now()), 50);
  try {
    await onShim(shim, async () => {
      await runReview({
        owner: "acme",
        repo: "remudero",
        prUrl: PR_URL,
        task: { id: TASK_ID, acceptance: [CRITERION] },
        report: BODY,
        settingsFile: join(root, "settings.json"),
        config: { claudeBin: "/bin/true", root } as Config,
        log: (step, extra = {}) => appendLedger(ledgerPath, { run_id: "RUN-T9549", task_id: TASK_ID, step, lane: "review", ...extra }),
        say: () => {},
        account: (r: WorkerResult) => r,
        spawnReviewer: false,
        lintPlanForReviewFn: async () => ({ ran: true as const, label: "fixture", checked: 1, violations: [] }),
        disarm: () => "not-armed" as const,
        arm: async (prUrl, taskId) => {
          order.push("arm-started");
          const result = await armAutoMergeDetailedAsync(prUrl, taskId, gate);
          order.push(`arm-settled:${result.outcome}`);
          return result.outcome;
        },
        ledgerPath,
        runId: "RUN-T9549",
      });
      order.push("review-returned");
    });
    assert.deepEqual(order, ["arm-started", "arm-settled:armed", "review-returned"], "runReview awaits its arm");
    assert.ok(window, "the arm's gh child ran");
    const during = ticks.filter((t) => t > window!.start && t < window!.end);
    assert.ok(during.length >= 5, `the timer kept firing while the arm's gh was in flight: ${during.length} tick(s) in ${window!.end - window!.start} ms`);
    const armed = readLedgerLines(ledgerPath).filter((l) => l.step === "automerge.armed");
    assert.equal(armed.length, 1, "the awaited arm still ledgers automerge.armed");
    assert.equal(armed[0]?.lane, "review");
  } finally {
    clearInterval(interval);
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T9549: the awaited review arm keeps the sync gate order and rows", async () => {
  type Case = {
    name: string;
    verdict: { state: "success" | "failure"; capped: boolean; planOnly: boolean };
    ctx?: { headRefName?: string; isDraft?: boolean };
    result?: ArmOutcome | ArmAttemptResult;
  };
  const cases: Case[] = [
    { name: "dependabot", verdict: PASS, ctx: { headRefName: "dependabot/npm/x" }, result: "armed" },
    { name: "draft", verdict: PASS, ctx: { isDraft: true }, result: "armed" },
    { name: "refused verdict", verdict: { state: "failure", capped: false, planOnly: false }, result: "armed" },
    { name: "capped without an override", verdict: { state: "success", capped: true, planOnly: false }, result: "armed" },
    { name: "armed", verdict: PASS, result: "armed" },
    { name: "ledger refused", verdict: PASS, result: { outcome: "ledger-refused" } },
    { name: "direct merge failed with its error", verdict: PASS, result: { outcome: "direct-merge-failed", error: "HTTP 405" } },
  ];
  for (const c of cases) {
    const run = (kind: "sync" | "async") => {
      const rows: Row[] = [];
      const armCalls: string[] = [];
      const ctx = { prUrl: PR_URL, taskId: TASK_ID, headSha: HEAD_SHA, ledgerPath: "/nonexistent/ledger.ndjson", ...c.ctx, log: (step: string, extra: Record<string, unknown> = {}) => void rows.push([step, extra]) };
      const ledgerLines = () => [];
      return { rows, armCalls, ctx, ledgerLines, arm: (prUrl: string) => {
        armCalls.push(`${kind}:${prUrl}`);
        return c.result!;
      } };
    };
    const sync = run("sync");
    const syncOutcome = armIfVerdictPermits(c.verdict, sync.ctx, { arm: sync.arm, ledgerLines: sync.ledgerLines });
    const awaited = run("async");
    const asyncOutcome = await armIfVerdictPermitsAsync(c.verdict, awaited.ctx, {
      // An effector that settles on a later turn: the awaited arm must wait for it before it ledgers.
      arm: async (prUrl) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return awaited.arm(prUrl);
      },
      ledgerLines: awaited.ledgerLines,
    });
    assert.equal(asyncOutcome, syncOutcome, `${c.name}: the same outcome`);
    assert.deepEqual(awaited.rows, sync.rows, `${c.name}: the same rows in the same order`);
    assert.deepEqual(awaited.armCalls.map((a) => a.replace(/^async:/, "")), sync.armCalls.map((a) => a.replace(/^sync:/, "")), `${c.name}: the effector is reached exactly when the sync arm reaches it`);
    if (["dependabot", "draft", "refused verdict", "capped without an override"].includes(c.name)) {
      assert.equal(asyncOutcome, "skipped", `${c.name}: gated before the effector`);
      assert.deepEqual(awaited.armCalls, [], `${c.name}: never reaches the arm`);
      assert.equal(awaited.rows[0]?.[0], "automerge.arm_skipped");
    } else {
      assert.deepEqual(awaited.armCalls, [`async:${PR_URL}`]);
    }
  }
});


const sharedFailureHead = "90be1a69eaea5510184cf6eec69f7c72afd13c39";
// W1-T11847: a reused verdict posts only while the reviewer code that judged it is current at origin/main.
const sharedReviewerCode = "c".repeat(40);
const sharedFailureBody = `**remudero-review=failure**\n\n1. laneTarget's CPU bound is measured\n   - proof executed and PASSED on the PR head — NOTE: reviewer judged the proof non-responsive: an in-memory runDaemon replay adopting a review child in shadow mode throws ReferenceError at daemon.ts:4218. The proof omits review-child adoption.`;
const sharedHistory = [{ context: "remudero-review", state: "failure" }, { context: "remudero-review", state: "success" }];
const sharedComputed = {
  state: "success", summary: "PASS", criteria: [{ claim: "laneTarget's CPU bound is measured", proof: "unit test: laneTarget", met: true,
    floorMet: true, reason: "proof passed", proof_exec: "executed_pass" }],
  testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
};

test("W1-T11443 criteria 1/2: direct sweep and dependency publishers guard exact-head shared history", async t => {
  for (const lane of ["reuse", "discriminate-only", "dependency"] as const) {
    for (const scenario of ["sticky", "unreadable", "clear", "unreproduced", "other-head"] as const) {
      await t.test(`${lane}/${scenario}`, async st => {
        const ledger = writeLedger([], { scope: st });
        const prUrl = "https://github.com/acme/remudero/pull/1";
        const body = "Bumps [example](https://example.com) from 1.0.0 to 1.0.1.";
        const rows = scenario === "clear" ? [] : sharedHistory;
        const findings = scenario === "unreproduced" ? [{ commit_id: sharedFailureHead, body: "remudero-review=failure: unable to inspect" }]
          : [{ commit_id: scenario === "other-head" ? "older-head" : sharedFailureHead, body: sharedFailureBody }];
        const shim = ghShim([
          { when: `/commits/${sharedFailureHead}/statuses?`, stdout: scenario === "unreadable" ? "{}" : JSON.stringify([rows]) },
          { when: "pulls/1/reviews?", stdout: JSON.stringify([findings]) },
          { when: "pulls/1", stdout: JSON.stringify({ state: "open", merged: false, head: { sha: sharedFailureHead }, body }) },
          { when: "pr diff", stdout: "diff --git a/src/changed.ts b/src/changed.ts\n+laneTarget\n" },
          { when: "api ", stdout: "{}" },
        ], { kind: "direct-publisher-history" });
        const oldPath = process.env.PATH;
        process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
        let arms = 0;
        try {
          let code: number | void;
          if (lane === "dependency") {
            code = await withLiveWritesAllowed(() => depReviewCommand("1", ["--repo", "acme/remudero"], {
              config: { root: ledger.dir, ledger: ledger.path } as never,
              gh: args => args[0] === "api"
                ? { state: "open", merged: false, head: { sha: sharedFailureHead }, body }
                : { number: 1, url: prUrl, title: "build(deps): bump example from 1.0.0 to 1.0.1", body,
                  headRefOid: sharedFailureHead, author: { login: "app/dependabot" }, statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }] },
              prDiff: () => 'diff --git a/package.json b/package.json\n-"example": "1.0.0"\n+"example": "1.0.1"\n',
              arm: () => { arms++; return "armed"; },
            }));
          } else {
            const prior = { ...sharedComputed, criteria: [{ ...sharedComputed.criteria[0], proof: "grep: laneTarget in src/changed.ts" }] };
            ledger.append([{ run_id: "prior", task_id: "W1-T11443", step: "review.posted", state: "success",
              head_sha: "older-head", pr_url: prUrl, decision_verdict: prior, reviewer_code_sha: sharedReviewerCode }]);
            const effects = buildSweepEffects({ owner: "acme", repo: "remudero", localRepoName: "other",
              config: { root: ledger.dir } as never, ledgerPath: ledger.path, runId: "direct-history",
              plan: { tasks: [], byId: new Map() } as never, log: () => {},
              reviewRunner: async () => { assert.fail("direct publishing must not fall back to a full review"); },
              reviewerCodeFreshnessImpl: () => ({ status: "fresh", codeSha: sharedReviewerCode, originMainSha: sharedReviewerCode, advance: "none" }),
              materializeReviewWorktreeImpl: () => ({ worktreePath: "/head" }),
              buildBaseProofDirImpl: () => ({ baseCheckoutDir: "/base", baseUnreadablePaths: new Set(), baseIsCheckout: true, addedTestFiles: new Set() }),
              reviewReuseExecProofImpl: (_proof, cwd) => cwd === "/head" ? "pass" : "fail",
              worktreeRemoveImpl: () => {},
            });
            const pr = { prNumber: 1, prUrl, taskId: "W1-T11443", headSha: sharedFailureHead, reviewState: "none", checksState: "green",
              unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false, body,
              currentOwnDiffDigest: "current-diff", currentMergeBaseSha: "current-base" } as OpenPrView;
            code = await withLiveWritesAllowed(() => effects.postReview!(pr, { kind: lane, judgedHeadSha: "older-head" }));
          }
          const calls = shim.calls();
          assert.ok(calls.some(call => call.includes(`/commits/${sharedFailureHead}/statuses?`)), "each direct publisher reads the exact-head statuses list");
          const posts = calls.filter(call => call.includes(`statuses/${sharedFailureHead}`));
          const recorded = readFileSync(lane === "dependency" ? join(ledger.dir, "state", "ledger.ndjson") : ledger.path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
          const terminal = recorded.findLast(row => row.step === "review.posted" && row.head_sha === sharedFailureHead);
          if (scenario === "sticky") {
            if (lane === "dependency") assert.equal(code, 1);
            assert.ok(posts.some(call => call.includes("state=failure") && call.includes("ReferenceError at daemon.ts:4218")), posts.join("\n"));
            assert.equal(terminal?.state, "failure", "callers ledger the effective failure");
            assert.ok(recorded.some(row => row.step === "review.history_guarded" && row.findings[0].finding.includes("shadow mode throws ReferenceError")));
          } else if (scenario === "unreadable") {
            if (lane === "dependency") assert.equal(code, 1);
            assert.equal(posts.length, 0);
            assert.equal(terminal, undefined);
            assert.ok(recorded.some(row => row.step === "review.post_refused" && /pending:.*status history unreadable/.test(row.reason)));
          } else {
            if (lane === "dependency") assert.equal(code, 0);
            assert.ok(posts.some(call => call.includes("state=success")));
            assert.equal(terminal?.state, "success");
          }
          if (scenario === "sticky" || scenario === "unreadable") {
            assert.equal(posts.some(call => call.includes("state=success")), false);
            assert.equal(arms, 0, "dependency review cannot arm a held or failed result");
          } else if (lane === "dependency") assert.equal(arms, 1, "healthy history preserves dependency arming");
        } finally {
          if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
          rmSync(shim.dir, { recursive: true, force: true });
        }
      });
    }
  }
});

