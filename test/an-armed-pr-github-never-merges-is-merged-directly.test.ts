import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger, rotateLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Config } from "../src/lib/config.js";
import { buildSweepEffects, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { ghShim } from "./helpers/gh-shim.js";

const HEAD = "5492549254925492549254925492549254925492";
const NEXT_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TASK = "W1-T5492";
const PR_URL = "https://github.com/craigoley/remudero/pull/5492";

function pr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 5492, prUrl: PR_URL, taskId: TASK, headSha: HEAD,
    autoMergeArmed: true, reviewState: "success", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-armed-idle-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const live = { state: "open", merged: false, auto_merge: {} as unknown, draft: false,
    head: { sha: HEAD }, base: { ref: "main" }, mergeable: true as boolean | null, mergeable_state: "blocked", body: "" };
  const shim = ghShim([
    { when: "/merge", stdout: '{"merged":true}' },
    { when: "/update-branch", stdout: '{}' },
    { when: "/files", stdout: '[{"filename":"src/example.ts"}]' },
    { when: "/compare/", stdout: '{"behind_by":0}' },
    { when: "/rules/branches/main", stdout: '[]' },
    { when: "/pulls/5492", stdout: JSON.stringify(live) },
  ], { kind: "armed-idle-gh" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const logs: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath, runId: "armed-idle", plan: { tasks: [], byId: new Map() },
    log: (step, fields = {}) => { logs.push({ step, fields }); },
    armSessionPrsOverride: true, spawnWallClockBoundMsOverride: 1,
  });
  const deps: SweepDeps = {
    arm: effects.arm, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath, runId: "armed-idle", readLedgerUnion: () => ({ complete: false, lines: [] }),
  };
  function review(head = HEAD, state = "success") {
    appendLedger(ledgerPath, { step: "review.posted", run_id: "review", task_id: TASK, head_sha: head,
      state, capped: false, plan_only: false, proof_exec: ["executed_pass"] });
  }
  review();
  const pass = (view = pr(), overrides: Partial<SweepDeps> = {}) =>
    withLiveWritesAllowed(() => runSweep([view], { ...deps, ...overrides }));
  const rows = (step: string) => readLedgerLines(ledgerPath).filter(row => row.step === step);
  const merges = () => shim.calls().filter(call => call.includes("/pulls/5492/merge"));
  const setLive = (changes: Partial<typeof live>) => {
    Object.assign(live, changes);
    shim.addRoute({ when: "/pulls/5492", stdout: JSON.stringify(live) });
  };
  return { pass, rows, merges, shim, review, setLive, logs, ledgerPath, deps };
}

test("W1-T5492: a second idle sighting merges an armed pr directly through fresh preflight", async t => {
  const h = harness(t);
  const first = await h.pass();
  assert.equal(first.actionsTaken, 0);
  assert.equal(h.merges().length, 0);
  assert.equal(h.rows("automerge.armed_idle").length, 1);
  assert.equal(h.rows("automerge.armed_idle")[0].dedupe_key, `5492@${HEAD}`);
  const second = await h.pass();
  assert.equal(h.merges().length, 1);
  assert.equal(second.actionsTaken, 1);
  assert.ok(h.merges()[0].includes(`sha=${HEAD}`));
  const calls = h.shim.calls();
  assert.ok(calls.findIndex(call => call.includes("/compare/")) < calls.findIndex(call => call.includes("/pulls/5492/merge")));
  assert.equal(calls.some(call => call.includes("--auto")), false);
  assert.equal(h.rows("automerge.armed_idle_merged").length, 1);
});

test("W1-T5492: a changed head clears the idle sighting and re-earns two passes", async t => {
  const h = harness(t);
  await h.pass();
  h.setLive({ head: { sha: NEXT_HEAD } });
  h.review(NEXT_HEAD);
  await h.pass(pr({ headSha: NEXT_HEAD }));
  assert.equal(h.merges().length, 0);
  assert.equal(h.rows("automerge.armed_idle_cleared").length, 1);
  assert.deepEqual(h.rows("automerge.armed_idle").map(row => row.head_sha), [HEAD, NEXT_HEAD]);
  await h.pass(pr({ headSha: NEXT_HEAD }));
  assert.equal(h.merges().length, 1);
});

for (const reviewState of ["failure", "pending", "none"] as const) {
  test(`W1-T5492: ${reviewState} review clears an idle sighting`, async t => {
    const h = harness(t);
    await h.pass();
    await h.pass(pr({ reviewState }));
    assert.equal(h.merges().length, 0);
    assert.equal(h.rows("automerge.armed_idle_cleared").length, 1);
    await h.pass();
    assert.equal(h.merges().length, 0, "recovery is a first sighting");
    await h.pass();
    assert.equal(h.merges().length, 1);
  });
}

for (const checksState of ["red", "pending", "none"] as const) {
  test(`W1-T5492: ${checksState} required checks clear an idle sighting`, async t => {
    const h = harness(t);
    await h.pass();
    await h.pass(pr({ checksState }));
    assert.equal(h.merges().length, 0);
    assert.equal(h.rows("automerge.armed_idle_cleared").length, 1);
    await h.pass();
    assert.equal(h.merges().length, 0);
  });
}

test("W1-T5492: a fresh head change or closed pr refuses the later merge", async t => {
  const h = harness(t);
  await h.pass();
  h.setLive({ head: { sha: NEXT_HEAD } });
  await h.pass();
  assert.equal(h.merges().length, 0);
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "head-unavailable");
  h.setLive({ head: { sha: HEAD } });
  await h.pass();
  h.setLive({ head: { sha: HEAD }, state: "closed" });
  await h.pass();
  assert.equal(h.merges().length, 0);
  assert.equal(h.rows("automerge.armed_idle_refused").length, 2);
});

test("W1-T5492: unknown fresh mergeability refuses without a rest merge", async t => {
  const h = harness(t);
  await h.pass();
  h.shim.addRoute({ when: "/compare/", stdout: '{"behind_by":0}' });
  h.setLive({ mergeable: null });
  await h.pass();
  assert.equal(h.merges().length, 0);
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "direct-merge-preflight-refused");
  assert.ok(h.logs.some(row => row.step === "automerge.direct_merge_preflight_refused"));
});

test("W1-T5492: a merge queue enqueues the idle pr without a direct merge", async t => {
  const h = harness(t);
  await h.pass();
  h.shim.addRoute({ when: "/rules/branches/main", stdout: '[{"type":"merge_queue"}]' });
  await h.pass();
  assert.equal(h.merges().length, 0);
  assert.ok(h.shim.calls().includes(`pr merge ${PR_URL}`));
  assert.equal(h.rows("automerge.armed_idle_enqueued").length, 1);
});

test("W1-T5492: a behind plan pr updates once and awaits new checks", async t => {
  const h = harness(t);
  await h.pass();
  h.shim.addRoute({ when: "/compare/", stdout: '{"behind_by":2}' });
  h.shim.addRoute({ when: "/files", stdout: '[{"filename":"plan/tasks.d/example.yaml"}]' });
  await h.pass();
  assert.equal(h.merges().length, 0);
  assert.equal(h.shim.calls().filter(call => call.includes("/update-branch")).length, 1);
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "direct-merge-updated");
  assert.ok(h.logs.some(row => row.fields.reason === "plan_pr_behind"));
});

test("W1-T5492: an operator hold prevents the idle fallback", async t => {
  const h = harness(t);
  await h.pass();
  appendLedger(h.ledgerPath, { step: "automerge.hold_engaged", run_id: "hold", task_id: TASK,
    pr_number: 5492, by: "operator", reason: "wait", authority: "interactive-cli" });
  await h.pass();
  assert.equal(h.merges().length, 0);
  assert.equal(h.rows("automerge.armed_idle_cleared").length, 1);
});

test("W1-T5492: preview and light passes do not earn an idle sighting", async t => {
  const h = harness(t);
  await h.pass(pr(), { dryRun: true });
  await h.pass(pr(), { actionable: disposition => disposition === "post-review" });
  assert.equal(h.rows("automerge.armed_idle").length, 0);
  await h.pass();
  assert.equal(h.merges().length, 0);
});

test("W1-T5492: shadow effects refuse the idle fallback", async t => {
  const h = harness(t);
  const effects = buildSweepEffects({ owner: "craigoley", repo: "remudero", repoMode: "shadow",
    config: { root: tmpdir() } as Config, ledgerPath: h.ledgerPath, runId: "shadow",
    plan: { tasks: [], byId: new Map() }, log: () => {}, spawnWallClockBoundMsOverride: 1 });
  await h.pass(pr(), { arm: effects.arm });
  await h.pass(pr(), { arm: effects.arm });
  assert.equal(h.merges().length, 0);
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "shadow-refused");
});

test("W1-T5492: a fresh non-success ledger verdict refuses the idle fallback", async t => {
  const h = harness(t);
  await h.pass();
  h.review(HEAD, "failure");
  const result = await h.pass();
  assert.equal(h.merges().length, 0);
  assert.equal(result.actionsTaken, 0);
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "ledger-refused");
});

test("W1-T5492: an unready stack clears the idle sighting", async t => {
  const h = harness(t);
  await h.pass();
  await h.pass(pr(), {
    stackPrerequisite: () => ({ state: "blocked", parentNumbers: [5491], detail: "parent is open" }),
    withdrawStackAutoMerge: () => "disarmed",
  });
  assert.equal(h.merges().length, 0);
  assert.equal(h.rows("automerge.armed_idle_cleared").length, 1);
  await h.pass();
  assert.equal(h.merges().length, 0);
});

test("W1-T5492: branch protection refusing the rest merge remains retryable", async t => {
  const h = harness(t);
  await h.pass();
  h.shim.addRoute({ when: "/merge", exit: 1, stderr: "HTTP 405: Pull Request is not mergeable" });
  const result = await h.pass();
  assert.equal(result.actionsTaken, 0);
  assert.equal(h.rows("automerge.armed_idle_merged").length, 0);
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "direct-merge-failed");
  h.shim.addRoute({ when: "/merge", stdout: '{"merged":true}' });
  await h.pass();
  assert.equal(h.rows("automerge.armed_idle_merged").length, 1);
});

test("W1-T5492: an enqueue failure records refusal rather than completion", async t => {
  const h = harness(t);
  await h.pass();
  h.shim.addRoute({ when: "/rules/branches/main", stdout: '[{"type":"merge_queue"}]' });
  h.shim.addRoute({ when: `pr merge ${PR_URL}`, exit: 1, stderr: "queue refused the request" });
  const result = await h.pass();
  assert.equal(h.merges().length, 0);
  assert.equal(result.actionsTaken, 0);
  assert.equal(h.rows("automerge.armed_idle_enqueued").length, 0);
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "arm-error-ignored");
});

test("W1-T5492: the idle observation survives rotation and a rebuilt sweep", async t => {
  const h = harness(t);
  appendLedger(h.ledgerPath, { step: "sweep.disposed", run_id: "prior-arm", task_id: TASK,
    pr_number: 5492, head_sha: HEAD, disposition: "mergeable", acted: true });
  await h.pass();
  for (let i = 0; i < 40; i++) appendLedger(h.ledgerPath, {
    step: "fixture.noise", run_id: "noise", task_id: TASK, payload: "x".repeat(100),
  });
  const rotation = withLiveWritesAllowed(() => rotateLedger(h.ledgerPath, { ceilingBytes: 4000, smoothingWindowMs: 0 }));
  assert.equal(rotation.rotated, true);
  assert.equal(h.rows("automerge.armed_idle").length, 0, "audit events may be archived");
  assert.equal(h.rows("automerge.arm_skipped")[0].armed_idle_observed, true);
  await h.pass();
  assert.equal(h.merges().length, 1, "the retained sweep row recovers the first sighting");
});

test("W1-T5492: losing the observed arm clears the idle sighting", async t => {
  const h = harness(t);
  await h.pass();
  await h.pass(pr({ autoMergeArmed: false }), { arm: () => "armed" });
  assert.equal(h.rows("automerge.armed_idle_cleared").length, 1);
  await h.pass();
  assert.equal(h.merges().length, 0);
});

test("W1-T5492: a legacy void arm result cannot prove idle completion", async t => {
  const h = harness(t);
  await h.pass();
  const result = await h.pass(pr(), { arm: () => {} });
  assert.equal(result.actionsTaken, 0);
  assert.equal(h.rows("automerge.armed_idle_merged").length, 0);
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "unknown");
});

test("W1-T5492: invalidation on a light pass survives rotation", async t => {
  const h = harness(t);
  await h.pass();
  await h.pass(pr({ checksState: "red" }), { actionable: disposition => disposition === "post-review" });
  for (let i = 0; i < 40; i++) appendLedger(h.ledgerPath, {
    step: "fixture.noise", run_id: "noise", task_id: TASK, payload: "x".repeat(100),
  });
  const rotation = withLiveWritesAllowed(() => rotateLedger(h.ledgerPath, { ceilingBytes: 4000, smoothingWindowMs: 0 }));
  assert.equal(rotation.rotated, true);
  await h.pass();
  assert.equal(h.merges().length, 0, "a red observation cannot be forgotten into a second sighting");
  await h.pass();
  assert.equal(h.merges().length, 1);
});

test("W1-T5492: a fresh disarm refuses the idle fallback", async t => {
  const h = harness(t);
  await h.pass();
  h.setLive({ auto_merge: null });
  await h.pass();
  assert.equal(h.merges().length, 0);
  assert.equal(h.rows("automerge.armed_idle_refused")[0].outcome, "head-unavailable");
});
