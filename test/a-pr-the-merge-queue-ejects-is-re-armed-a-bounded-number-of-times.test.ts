import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import { readMergeQueueMembership, type MergeQueueMembership } from "../src/lib/arm-auto-merge.js";
import {
  buildSweepEffects,
  MAX_REARMS_AFTER_DISARM_PER_HEAD,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T5909 — LIVE 2026-10-05, #9392: the sweep armed it, the merge queue ejected it (a cancelled
// group run), GitHub disabled its auto-merge, and every later pass stood down "auto-merge already
// armed by a prior sweep pass at this head" because the `mergeable` dedup let the sweep's own
// memory outvote GitHub's observed disarm. A queued PR also reads `auto_merge: null`, so the
// sweep now asks the queue before it believes either.

const HEAD = "1f9c8198e0b0344153d1c20259ddf6c81f6ffc61";
const NEXT_HEAD = "2a0d9209f1c1455264e2d31360eef7d92a0eb172";
const PR_NUMBER = 9392;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
const TASK = "W1-T5908";

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER, prUrl: PR_URL, taskId: TASK, headSha: HEAD,
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
    ...over,
  };
}

/** The `acted:true` row the 19:31:25Z arm wrote — what seeds `prior.armed` at this head. */
function priorSweepArm(ledgerPath: string, head = HEAD): void {
  appendLedger(ledgerPath, { run_id: "DAEMON-1", task_id: "SWEEP", step: "sweep.disposed", pr_number: PR_NUMBER,
    pr_url: PR_URL, disposition: "mergeable", acted: true, arm_outcome: "armed", head_sha: head });
}

function harness(t: TestContext, membership: () => MergeQueueMembership | Promise<MergeQueueMembership>) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5909-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const arms: string[] = [];
  const escalations: Array<{ head: string; rearms: number; bound: number }> = [];
  const deps: SweepDeps = {
    arm: (p) => { arms.push(p.headSha); return "armed"; },
    close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath, runId: "SWEEP-W1-T5909",
    readLedgerUnion: () => ({ complete: false, lines: [] }),
    readMergeQueueMembership: () => membership(),
    escalateRearmExhausted: (p, rearms, bound) => { escalations.push({ head: p.headSha, rearms, bound }); return `https://github.com/o/r/issues/${escalations.length}`; },
  };
  const pass = (view = pr(), overrides: Partial<SweepDeps> = {}) => runSweep([view], { ...deps, ...overrides });
  const rows = (step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step);
  const lastDisposed = () => rows("sweep.disposed").at(-1)!;
  return { ledgerPath, arms, escalations, pass, rows, lastDisposed };
}

test("W1-T5909: a PR GitHub disarmed after a sweep arm, and not in the queue, is re-armed at the same head", async (t) => {
  const h = harness(t, () => "not-queued");
  priorSweepArm(h.ledgerPath);
  await h.pass();
  assert.deepEqual(h.arms, [HEAD], "the prior-arm memory no longer outvotes GitHub's observed disarm");
  const rearm = h.rows("automerge.rearmed_after_disarm");
  assert.equal(rearm.length, 1);
  assert.equal(rearm[0].pr_number, PR_NUMBER);
  assert.equal(rearm[0].head_sha, HEAD);
  assert.equal(rearm[0].rearm_count, 1);
  assert.equal(rearm[0].bound, MAX_REARMS_AFTER_DISARM_PER_HEAD);
  assert.equal(h.lastDisposed().acted, true);
  assert.equal(h.lastDisposed().queue_membership, "not-queued");
});

test("W1-T5909: a PR in the merge queue is armed, so it is never re-armed", async (t) => {
  const h = harness(t, () => "queued");
  priorSweepArm(h.ledgerPath);
  await h.pass();
  assert.deepEqual(h.arms, []);
  assert.equal(h.rows("automerge.rearmed_after_disarm").length, 0);
  assert.equal(h.lastDisposed().acted, false);
  assert.equal(h.lastDisposed().queue_membership, "queued");
  assert.match(String(h.lastDisposed().stand_down_reason), /in the merge queue \(observed on GitHub\)/);
});

test("W1-T5909: a queued PR no sweep pass armed is not armed either", async (t) => {
  const h = harness(t, () => "queued");
  await h.pass();
  assert.deepEqual(h.arms, [], "the review lane's arm put it in the queue; the sweep spends no write on it");
  assert.match(String(h.lastDisposed().stand_down_reason), /in the merge queue/);
});

test("W1-T5909: past the per-head bound the pass stops re-arming and escalates once, naming the PR and head", async (t) => {
  const h = harness(t, () => "not-queued");
  priorSweepArm(h.ledgerPath);
  for (let i = 0; i < MAX_REARMS_AFTER_DISARM_PER_HEAD; i++) await h.pass();
  assert.equal(h.arms.length, MAX_REARMS_AFTER_DISARM_PER_HEAD);
  assert.deepEqual(h.rows("automerge.rearmed_after_disarm").map((r) => r.rearm_count), [1, 2, 3].slice(0, MAX_REARMS_AFTER_DISARM_PER_HEAD));
  assert.deepEqual(h.escalations, []);

  await h.pass();
  assert.equal(h.arms.length, MAX_REARMS_AFTER_DISARM_PER_HEAD, "the bound holds the arm");
  assert.deepEqual(h.escalations, [{ head: HEAD, rearms: MAX_REARMS_AFTER_DISARM_PER_HEAD, bound: MAX_REARMS_AFTER_DISARM_PER_HEAD }]);
  const exhausted = h.rows("automerge.rearm_exhausted");
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].pr_number, PR_NUMBER);
  assert.equal(exhausted[0].head_sha, HEAD);
  assert.equal(exhausted[0].escalated, true);
  assert.equal(h.lastDisposed().acted, false);
  assert.match(String(h.lastDisposed().stand_down_reason), new RegExp(`bound ${MAX_REARMS_AFTER_DISARM_PER_HEAD}`));

  await h.pass();
  assert.equal(h.arms.length, MAX_REARMS_AFTER_DISARM_PER_HEAD);
  assert.equal(h.escalations.length, 1, "escalated once, not once per pass");
  assert.equal(h.rows("automerge.rearm_exhausted").length, 1);
});

test("W1-T5909: a new head resets the re-arm count", async (t) => {
  const h = harness(t, () => "not-queued");
  priorSweepArm(h.ledgerPath);
  for (let i = 0; i <= MAX_REARMS_AFTER_DISARM_PER_HEAD; i++) await h.pass();
  assert.equal(h.escalations.length, 1);
  await h.pass(pr({ headSha: NEXT_HEAD }));
  await h.pass(pr({ headSha: NEXT_HEAD }));
  assert.deepEqual(h.arms.slice(MAX_REARMS_AFTER_DISARM_PER_HEAD), [NEXT_HEAD, NEXT_HEAD],
    "the first arm at the new head, then its own first re-arm");
  const atNext = h.rows("automerge.rearmed_after_disarm").filter((r) => r.head_sha === NEXT_HEAD);
  assert.deepEqual(atNext.map((r) => r.rearm_count), [1]);
});

test("W1-T5909: an unreadable queue read falls back to the prior-arm dedup and names the fallback", async (t) => {
  const h = harness(t, () => ({ unreadable: true, reason: "graphql 502" }));
  priorSweepArm(h.ledgerPath);
  await h.pass();
  assert.deepEqual(h.arms, []);
  assert.equal(h.lastDisposed().queue_membership, "unreadable");
  assert.equal(
    h.lastDisposed().stand_down_reason,
    "queue membership unreadable (graphql 502) — fell back to the prior-pass arm memory: " +
      "auto-merge already armed by a prior sweep pass at this head (1f9c819)",
  );
});

test("W1-T5909: a queue read that throws is an unreadable read, never a disarm", async (t) => {
  const h = harness(t, () => { throw new Error("socket hang up"); });
  priorSweepArm(h.ledgerPath);
  await h.pass();
  assert.deepEqual(h.arms, []);
  assert.equal(h.lastDisposed().queue_membership, "unreadable");
  assert.match(String(h.lastDisposed().stand_down_reason), /queue membership unreadable \(socket hang up\)/);
});

test("W1-T5909: with no queue read wired the prior-arm dedup is today's, sentence for sentence", async (t) => {
  const h = harness(t, () => "not-queued");
  priorSweepArm(h.ledgerPath);
  await h.pass(pr(), { readMergeQueueMembership: undefined });
  assert.deepEqual(h.arms, []);
  assert.equal("queue_membership" in h.lastDisposed(), false);
  assert.equal(h.lastDisposed().stand_down_reason, "auto-merge already armed by a prior sweep pass at this head (1f9c819)");
});

test("W1-T5909: a failed escalation is recorded and retried on the next pass", async (t) => {
  const h = harness(t, () => "not-queued");
  priorSweepArm(h.ledgerPath);
  for (let i = 0; i < MAX_REARMS_AFTER_DISARM_PER_HEAD; i++) await h.pass();
  await h.pass(pr(), { escalateRearmExhausted: () => { throw new Error("issues API 503"); } });
  const failed = h.rows("automerge.rearm_exhausted");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].escalated, false);
  assert.match(String(failed[0].reason), /issues API 503/);
  await h.pass();
  assert.equal(h.escalations.length, 1, "the retry escalates");
  assert.deepEqual(h.rows("automerge.rearm_exhausted").map((r) => r.escalated), [false, true]);
  assert.equal(h.arms.length, MAX_REARMS_AFTER_DISARM_PER_HEAD, "and never re-arms past the bound");
});

test("W1-T5909: an undelivered escalation (no issue url) is recorded as not escalated and retried", async (t) => {
  const h = harness(t, () => "not-queued");
  priorSweepArm(h.ledgerPath);
  for (let i = 0; i < MAX_REARMS_AFTER_DISARM_PER_HEAD; i++) await h.pass();
  await h.pass(pr(), { escalateRearmExhausted: () => null });
  assert.deepEqual(h.rows("automerge.rearm_exhausted").map((r) => [r.escalated, r.issue_url]), [[false, undefined]]);
  await h.pass();
  assert.deepEqual(h.rows("automerge.rearm_exhausted").map((r) => r.escalated), [false, true]);
  assert.equal(h.rows("automerge.rearm_exhausted")[1].issue_url, "https://github.com/o/r/issues/1");
});

test("W1-T5909: a dry run and a light pass neither re-arm nor escalate", async (t) => {
  const h = harness(t, () => "not-queued");
  priorSweepArm(h.ledgerPath);
  for (let i = 0; i < MAX_REARMS_AFTER_DISARM_PER_HEAD; i++) await h.pass();
  await h.pass(pr(), { dryRun: true });
  await h.pass(pr(), { actionable: (d) => d === "post-review" });
  assert.deepEqual(h.escalations, []);
  assert.equal(h.rows("automerge.rearm_exhausted").length, 0);
});

// ── The real effect: the default `readJsonImpl` shells out to `gh` (a PATH shim here). ──────────

function realEffects(t: TestContext, graphql: { stdout?: string; exit?: number; stderr?: string }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5909-real-`));
  const shim = ghShim([{ when: "graphql", ...graphql }], { kind: "w1t5909-gh" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const issues: Array<{ title: string; body: string }> = [];
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-W1-T5909-real", plan: { tasks: [], byId: new Map() },
    issuesImpl: { create: (title, body) => { issues.push({ title, body }); return "https://github.com/craigoley/remudero/issues/1"; } },
    log: () => {}, spawnWallClockBoundMsOverride: 1,
  });
  return { effects, shim, issues };
}

test("W1-T5909: the real queue read asks GitHub's isInMergeQueue for this PR", async (t) => {
  const queued = realEffects(t, { stdout: '{"data":{"repository":{"pullRequest":{"isInMergeQueue":true}}}}' });
  assert.equal(await queued.effects.readMergeQueueMembership!(pr()), "queued");
  const call = queued.shim.calls().find((c) => c.includes("graphql"))!;
  assert.match(call, /isInMergeQueue/);
  assert.match(call, /number=9392/);
  assert.match(call, /owner=craigoley/);
  assert.match(call, /name=remudero/);
});

test("W1-T5909: the real queue read answers not-queued, and unreadable for a missing field or a failed gh", async (t) => {
  const out = realEffects(t, { stdout: '{"data":{"repository":{"pullRequest":{"isInMergeQueue":false}}}}' });
  assert.equal(await out.effects.readMergeQueueMembership!(pr()), "not-queued");
  const missing = realEffects(t, { stdout: '{"data":{"repository":{"pullRequest":null}}}' });
  assert.deepEqual(await missing.effects.readMergeQueueMembership!(pr()),
    { unreadable: true, reason: "the GraphQL answer carried no isInMergeQueue boolean" });
  const failed = realEffects(t, { exit: 1, stderr: "HTTP 502" });
  const result = await failed.effects.readMergeQueueMembership!(pr());
  assert.equal(typeof result, "object");
  assert.equal((result as { unreadable: boolean }).unreadable, true);
});

test("W1-T5909: a PR url the read cannot parse is unreadable, and nothing is asked", async () => {
  const asked: string[][] = [];
  const result = await readMergeQueueMembership("not-a-pr-url", (args) => { asked.push(args); return {}; });
  assert.deepEqual(result, { unreadable: true, reason: "cannot resolve owner/repo/number from not-a-pr-url" });
  assert.deepEqual(asked, []);
});

test("W1-T5909: the real escalation opens one issue naming the PR, the head and the bound", async (t) => {
  const { effects, issues } = realEffects(t, {});
  const url = await effects.escalateRearmExhausted!(pr(), MAX_REARMS_AFTER_DISARM_PER_HEAD, MAX_REARMS_AFTER_DISARM_PER_HEAD);
  assert.equal(issues.length, 1);
  assert.equal(typeof url, "string", "the delivered issue's url comes back to the caller");
  assert.match(issues[0].title + issues[0].body, new RegExp(PR_URL.replaceAll("/", "\\/")));
  assert.match(issues[0].body, new RegExp(HEAD));
  assert.match(issues[0].body, new RegExp(`${MAX_REARMS_AFTER_DISARM_PER_HEAD} times`));
});
