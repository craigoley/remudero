import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Config } from "../src/lib/config.js";
import {
  buildSweepEffects, refreshStaleRollupAfterRefusal, runSweep, type ArmedStalledPr, type OpenPrView, type RollupCheckEntry, type SweepDeps,
} from "./helpers/sweep-test.js";
import { ghShim } from "./helpers/gh-shim.js";

const HEAD = "6404640464046404640464046404640464046404";
const NEXT_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TASK = "W1-T6404";
const PR_URL = "https://github.com/craigoley/remudero/pull/6404";

function pr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 6404, prUrl: PR_URL, taskId: TASK, headSha: HEAD, headRefName: "run-W1-T6404-1",
    autoMergeArmed: true, reviewState: "success", checksState: "green",
    mergeable: true, mergeableState: "blocked",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

// The newest ci-gate run is green; an older failed run on the same sha is the one GitHub still counts.
const ROLLUP: RollupCheckEntry[] = [
  { name: "ci-gate", conclusion: "FAILURE", workflowId: 7, workflowRunId: 100, checkRunId: 1,
    startedAt: "2026-10-08T09:00:00Z", completedAt: "2026-10-08T09:33:20Z" },
  { name: "ci-gate", conclusion: "SUCCESS", workflowId: 7, workflowRunId: 101, checkRunId: 2,
    startedAt: "2026-10-08T10:00:00Z", completedAt: "2026-10-08T10:20:00Z" },
];

function harness(t: TestContext, updateOutcome: ArmedStalledPr extends never ? never : "updated" | "up-to-date" = "updated") {
  const root = mkdtempSync(join(tmpdir(), "rmd-stale-rollup-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const live = { state: "open", merged: false, auto_merge: {} as unknown, draft: false,
    head: { sha: HEAD }, base: { ref: "main" }, mergeable: true as boolean | null, mergeable_state: "blocked", body: "" };
  const shim = ghShim([
    { when: "/merge", exit: 1, stderr: "HTTP 405: Pull Request is not mergeable" },
    { when: "/update-branch", stdout: "{}" },
    { when: "/files", stdout: '[{"filename":"src/example.ts"}]' },
    { when: "/compare/", stdout: '{"behind_by":0}' },
    { when: "/rules/branches/main", stdout: "[]" },
    { when: "/pulls/6404", stdout: JSON.stringify(live) },
  ], { kind: "stale-rollup-gh" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath, runId: "stale-rollup", plan: { tasks: [], byId: new Map() },
    log: () => {}, armSessionPrsOverride: true, spawnWallClockBoundMsOverride: 1,
  });
  const updates: ArmedStalledPr[] = [];
  const repushes: string[] = [];
  const escalations: string[] = [];
  const deps: SweepDeps = {
    arm: effects.arm, close: () => {}, dispatchFix: () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
    ledgerPath, runId: "stale-rollup", readLedgerUnion: () => ({ complete: false, lines: [] }),
    updateBranch: (target) => { updates.push(target); return updateOutcome; },
    repushAbsent: (view) => { repushes.push(view.headSha); return Promise.resolve(NEXT_HEAD); },
    readCiGateRollup: () => ROLLUP,
  };
  function review(head = HEAD) {
    appendLedger(ledgerPath, { step: "review.posted", run_id: "review", task_id: TASK, head_sha: head,
      state: "success", capped: false, plan_only: false, proof_exec: ["executed_pass"] });
  }
  review();
  const pass = (view = pr(), overrides: Partial<SweepDeps> = {}) =>
    withLiveWritesAllowed(() => runSweep([view], { ...deps, ...overrides }));
  const rows = (step: string) => readLedgerLines(ledgerPath).filter(row => row.step === step);
  const setLive = (changes: Partial<typeof live>) => {
    Object.assign(live, changes);
    shim.addRoute({ when: "/pulls/6404", stdout: JSON.stringify(live) });
    // addRoute prepends, and "/pulls/6404" also matches "/pulls/6404/merge": restore the refusal ahead of it.
    shim.addRoute({ when: "/merge", exit: 1, stderr: "HTTP 405: Pull Request is not mergeable" });
  };
  return { pass, rows, review, setLive, updates, repushes, escalations };
}

test("W1-T6404: a refused armed-idle merge on a green head refreshes the branch once", async t => {
  const h = harness(t);
  await h.pass();
  assert.equal(h.updates.length, 0, "the first idle sighting spends nothing");
  await h.pass();
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "direct-merge-failed");
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].prNumber, 6404);
  assert.equal(h.updates[0].headSha, HEAD);
  const refreshed = h.rows("automerge.stale_rollup_refreshed");
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].head_sha, HEAD);
  assert.equal(refreshed[0].outcome, "updated");
  assert.deepEqual(refreshed[0].superseded_failures, [
    { check: "ci-gate", run_id: 100, completed_at: "2026-10-08T09:33:20Z" },
  ]);
});

test("W1-T6404: a branch already up to date is refreshed by an empty commit", async t => {
  const h = harness(t, "up-to-date");
  await h.pass();
  await h.pass();
  assert.equal(h.updates.length, 1);
  assert.deepEqual(h.repushes, [HEAD]);
  const refreshed = h.rows("automerge.stale_rollup_refreshed");
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].outcome, "repushed");
  assert.equal(refreshed[0].new_head_sha, NEXT_HEAD);
});

test("W1-T6404: a head GitHub does not report blocked is not refreshed", async t => {
  const h = harness(t);
  await h.pass();
  await h.pass(pr({ mergeableState: "clean" }));
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "direct-merge-failed");
  assert.equal(h.updates.length, 0);
  assert.equal(h.rows("automerge.stale_rollup_refreshed").length, 0);
});

function direct(t: TestContext, overrides: Partial<SweepDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-stale-rollup-direct-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const deps = { ledgerPath, runId: "direct", escalate: () => {}, readCiGateRollup: () => ROLLUP, ...overrides };
  return { deps, ledgerPath, rows: (step: string) => readLedgerLines(ledgerPath).filter(row => row.step === step) };
}

test("W1-T6404: a refresh with no updateBranch wired ledgers outcome unwired", async t => {
  const d = direct(t);
  const msg = await refreshStaleRollupAfterRefusal(d.deps, pr(), []);
  assert.equal(msg, "stale-rollup refresh: unwired");
  assert.equal(d.rows("automerge.stale_rollup_refreshed")[0].outcome, "unwired");
});

test("W1-T6404: a throwing updateBranch is ledgered as an error outcome, not propagated", async t => {
  const d = direct(t, { updateBranch: () => { throw new Error("update-branch exploded"); } });
  const msg = await refreshStaleRollupAfterRefusal(d.deps, pr(), []);
  assert.equal(msg, "stale-rollup refresh: error: update-branch exploded");
  assert.equal(d.rows("automerge.stale_rollup_refreshed")[0].outcome, "error: update-branch exploded");
});

test("W1-T6404: a failed exhaustion escalation is ledgered as escalated:false with its reason", async t => {
  const d = direct(t, { escalate: () => { throw new Error("escalation transport down"); } });
  const prior = [{ step: "automerge.stale_rollup_refreshed", pr_number: 6404, head_sha: HEAD }];
  const msg = await refreshStaleRollupAfterRefusal(d.deps, pr({ headSha: NEXT_HEAD }), prior);
  assert.match(msg, /escalation failed$/);
  const exhausted = d.rows("automerge.stale_rollup_refresh_exhausted");
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].escalated, false);
  assert.equal(exhausted[0].reason, "escalation transport down");
  assert.equal(exhausted[0].head_sha, NEXT_HEAD);
});

test("W1-T6404: a refreshed head is never refreshed twice", async t => {
  const h = harness(t);
  await h.pass();
  await h.pass();
  assert.equal(h.updates.length, 1);
  // The refresh minted a new head; it earns two idle passes and is refused again.
  h.setLive({ head: { sha: NEXT_HEAD } });
  h.review(NEXT_HEAD);
  const next = () => pr({ headSha: NEXT_HEAD });
  await h.pass(next());
  await h.pass(next());
  await h.pass(next());
  assert.equal(h.rows("automerge.armed_idle_refused").filter(row => row.head_sha === NEXT_HEAD).length >= 1, true);
  assert.equal(h.updates.length, 1, "no second update-branch press at the refreshed head");
  assert.equal(h.repushes.length, 0);
  assert.equal(h.rows("automerge.stale_rollup_refreshed").length, 1);
  assert.equal(h.escalations.length, 1, "the second refusal escalates once rather than looping");
  const exhausted = h.rows("automerge.stale_rollup_refresh_exhausted");
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].head_sha, NEXT_HEAD);
});
