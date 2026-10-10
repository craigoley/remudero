/**
 * W1-T5957: after `fix.ci_not_green` a fix round either spends its next strike or writes exactly one
 * terminal row naming why it stopped. Fleet #9450 (W1-T5538, DAEMON-1791254466681) logged
 * `fix.ci_not_green` (red, strike 1 of 2) at 03:46:21Z; its outcome row, `fix.stood_down` at
 * `rung.strike` for a dirty merge state, was written at 03:47:21Z but survived only in the rotated
 * archive, so the live ledger read as a silent end. The silent exit was the CI-wait hand-off: it
 * logged `fix.ci_not_green` and returned `handed_off` with no outcome row at all.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung, type CiGateOutcome, type WorktreeSnapshot } from "./helpers/run-task-test.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

type Row = { step: string } & Record<string, unknown>;
type Run = Parameters<typeof runFixRung>[0];
type Deps = Run["deps"];

const HEAD = "cd7e7dfb0ee5fd1c8aaf26771a3c2884ce701417";
const PR_URL = "https://github.com/acme/remudero/pull/9450";
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
/** The rows that end a round: exactly one of them, or a further strike, follows `fix.ci_not_green`. */
const TERMINAL_STEPS = new Set(["fix.stood_down", "fix.exhausted", "fix.resolved"]);

function worker(n: number): WorkerResult {
  return {
    sessionId: `fix-session-${n}`, costUsd: 0, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: mount.model, effort: mount.effort,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false,
  };
}

function initialReview(state: "failure" | "success" = "failure"): Run["initialReview"] {
  return {
    state, criteria: [], testTheater: false, summary: "sweep-reconstructed: required checks red - ci-log dispatch",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: HEAD,
    reviewerOutcome: "sweep-reconstructed-ci-log",
  };
}

/** A ci-log dispatch shaped like #9450's: strike cap 2, one red required check, a worker that commits. */
function harness(over: Partial<Deps> & { strikeCap?: number; birthWorktreeSnapshot?: WorktreeSnapshot } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-not-green-outcome-"));
  const rows: Row[] = [];
  const issues: string[] = [];
  let spawns = 0;
  let mined = 0;
  const { strikeCap, birthWorktreeSnapshot, ...deps } = over;
  const run: Run = {
    taskId: "W1-T5538", runId: "DAEMON-1791254466681", task: { id: "W1-T5538", title: "flow remedy gardener" },
    prUrl: PR_URL, branch: "run-W1-T5538-1791251630540", worktreePath: root, initialSessionId: "implement-session",
    mount, settingsFile: join(root, "settings.json"), config: { root } as Config, budgetUsd: 5,
    strikeCap: strikeCap ?? 2, initialReview: initialReview(),
    ciFailures: [{ name: "comment-load-ratchet", logTail: "comment load over ceiling" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    ...(birthWorktreeSnapshot ? { birthWorktreeSnapshot } : {}),
    deps: {
      spawn: async () => worker(++spawns),
      harnessCommitForShellLessWorker: () => 1,
      commitsAhead: () => 1,
      worktreeHasUncommittedChanges: () => false,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      waitForCiGreen: async () => ({ state: "red", sha: HEAD }),
      // A fresh failure each strike: the round's evidence moved, so no ci-log false-block fires.
      fetchCiFailures: async (): Promise<CiFailure[]> => [{ name: `coverage-shard (${++mined}/8)`, logTail: `shard ${mined} red` }],
      runReview: async () => ({ ...initialReview("success"), headSha: "fixed-head" }),
      fetchPrBody: async () => "## Summary\n\nfixture body\n\nRemudero-Task: W1-T5538\n",
      push: () => {},
      issues: {
        create: (title) => { issues.push(title); return `https://github.com/acme/remudero/issues/${900 + issues.length}`; },
        listOpen: () => [],
        comment: () => {},
      },
      ledgerPath: join(root, "ledger.ndjson"),
      ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, ...extra }),
      say: () => {},
      account: (r) => r,
      ...deps,
    },
  };
  const afterNotGreen = () => rows.slice(rows.findIndex((r) => r.step === "fix.ci_not_green") + 1);
  return { run, rows, issues, spawns: () => spawns, afterNotGreen, terminal: () => rows.filter((r) => TERMINAL_STEPS.has(r.step)) };
}

test("the #9450 shape: CI red after strike 1 of 2 on a PR gone dirty ends in exactly one fix.stood_down naming the dirty merge state", async () => {
  let reads = 0;
  const h = harness({ readMergeFacts: () => ({ mergeable: ++reads === 1 ? "MERGEABLE" : "CONFLICTING" }) });
  const outcome = await runFixRung(h.run);
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 1);
  assert.equal(h.spawns(), 1, "a conflicted PR registers no check runs, so the second strike is not spent");
  const notGreen = h.rows.filter((r) => r.step === "fix.ci_not_green");
  assert.deepEqual(notGreen.map((r) => [r.strike, r.ci, r.sha]), [[1, "red", HEAD]]);
  assert.deepEqual(h.terminal(), h.afterNotGreen().filter((r) => TERMINAL_STEPS.has(r.step)));
  assert.equal(h.terminal().length, 1);
  assert.equal(h.terminal()[0].step, "fix.stood_down");
  assert.equal(h.terminal()[0].site, "rung.strike");
  assert.equal(h.terminal()[0].strike, 2);
  assert.match(String(h.terminal()[0].reason), /merge state is dirty/);
});

test("not green with a strike left spends the next strike", async () => {
  let waits = 0;
  const h = harness({ waitForCiGreen: async () => ({ state: ++waits === 1 ? "red" : "green", sha: HEAD }) });
  const outcome = await runFixRung(h.run);
  assert.equal(outcome.outcome, "fixed");
  assert.equal(h.spawns(), 2);
  assert.deepEqual(h.rows.filter((r) => r.step === "fix.dispatch").map((r) => r.strike), [1, 2]);
  assert.deepEqual(h.afterNotGreen().filter((r) => r.step === "fix.dispatch").map((r) => r.strike), [2]);
  assert.deepEqual(h.terminal().map((r) => r.step), ["fix.resolved"]);
});

test("not green at the last strike writes fix.exhausted carrying its escalation", async () => {
  const h = harness();
  const outcome = await runFixRung(h.run);
  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.reason, "ci_never_green");
  assert.equal(h.spawns(), 2);
  assert.deepEqual(h.rows.filter((r) => r.step === "fix.ci_not_green").map((r) => r.strike), [1, 2]);
  assert.equal(h.issues.length, 1, "exactly one escalation is filed");
  assert.match(h.issues[0], /checks never went green/);
  assert.deepEqual(h.terminal().map((r) => r.step), ["fix.exhausted"]);
  assert.equal(h.terminal()[0].reason, "ci_never_green");
  assert.equal(h.terminal()[0].issue_url, outcome.issueUrl);
  assert.ok(String(outcome.issueUrl).startsWith("https://github.com/acme/remudero/issues/"));
});

test("a hand-off at the CI wait writes exactly one terminal row naming the sweep as its owner", async () => {
  const handoffs: Array<[CiGateOutcome, string, string]> = [
    [{ state: "freshness_handoff", sha: HEAD, recycle: "PAUSE requested: deploy" }, "recycle", "recycle_yield"],
    [{ state: "freshness_handoff", sha: HEAD, oldSha: "old-code", newSha: "new-code" }, "freshness", "freshness_yield"],
    [{ state: "freshness_handoff", sha: HEAD, trigger: "pr_open" }, "pr_open", "freshness_yield"],
  ];
  for (const [ci, trigger, reason] of handoffs) {
    const h = harness({ waitForCiGreen: async () => ci });
    const outcome = await runFixRung(h.run);
    assert.equal(outcome.outcome, "handed_off");
    assert.equal(outcome.reason, reason);
    assert.equal(h.spawns(), 1);
    assert.equal(h.rows.filter((r) => r.step === "fix.ci_not_green").length, 1);
    const ended = h.afterNotGreen().filter((r) => TERMINAL_STEPS.has(r.step));
    assert.equal(ended.length, 1, `${trigger}: the hand-off names its outcome in one row`);
    assert.deepEqual(h.terminal(), ended);
    assert.deepEqual(
      { site: ended[0].site, outcome: ended[0].outcome, owner: ended[0].owner, trigger: ended[0].trigger, reason: ended[0].reason, strike: ended[0].strike, sha: ended[0].sha },
      { site: "rung.ci_handoff", outcome: "handed_off", owner: "sweep", trigger, reason, strike: 1, sha: HEAD },
    );
  }
});

test("each gate read that throws before the next strike names its error, and the strike is still spent", async () => {
  let waits = 0;
  const h = harness({
    birthWorktreeSnapshot: { status: "", diff: "", untrackedHash: "" },
    waitForCiGreen: async () => ({ state: ++waits === 1 ? "red" : "green", sha: HEAD }),
    captureWorktreeSnapshot: () => { throw new Error("snapshot unreadable"); },
    readRegisteredWorktrees: () => { throw new Error("worktree list unreadable"); },
    readMergeFacts: () => { throw new Error("merge facts unreadable"); },
    readCiRollup: () => { throw new Error("rollup unreadable"); },
  });
  const outcome = await runFixRung(h.run);
  assert.equal(outcome.outcome, "fixed");
  assert.equal(h.spawns(), 2, "a failed read fails open: the next strike still spends");
  const named = h.afterNotGreen().filter((r) => r.step === "fix.gate_read_error");
  assert.deepEqual(
    named.map((r) => [r.site, r.read, r.error]),
    [
      ["rung.strike", "worktree_snapshot", "Error: snapshot unreadable"],
      ["rung.strike", "registered_worktrees", "Error: worktree list unreadable"],
      ["rung.strike", "merge_facts", "Error: merge facts unreadable"],
      ["rung.strike", "ci_rollup", "Error: rollup unreadable"],
    ],
  );
  assert.deepEqual(h.terminal().map((r) => r.step), ["fix.resolved"]);
});
