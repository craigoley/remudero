import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import { readArmTimeline, type ArmReprobeFacts, type ArmTimeline, type ArmTimelineEvent } from "../src/lib/arm-auto-merge.js";
import {
  buildSweepEffects,
  isFleetAppAuthor,
  RISK_OVERRIDE_OBSERVED_STEP,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T5911 — LIVE 2026-10-05, #9391 (head d931064b): the W1-T5403 risk judge escalated the head
// (#9395), the operator read the diff and enqueued it by hand (AddedToMergeQueueEvent by cao825 at
// 19:52:27Z, again at 21:23:42Z), and every sweep pass still refused to arm it, because the refusal
// cleared only on a new head or a `capped_override_granted` row nothing but a full re-review writes.

const HEAD = "d931064b5e4f0a1c2b3d4e5f60718293a4b5c6d7";
const NEXT_HEAD = "e042175c6f5a1b2d3c4e5f6a7182930b4c5d6e7f";
const PR_NUMBER = 9391;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
const ISSUE_URL = "https://github.com/craigoley/remudero/issues/9395";
const TASK = "W1-T5534";
const ESCALATED_AT = "2026-10-05T19:46:30.000Z";

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER, prUrl: PR_URL, taskId: TASK, headSha: HEAD,
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
    ...over,
  };
}

function escalated(ledgerPath: string, head = HEAD, ts = ESCALATED_AT): void {
  appendLedger(ledgerPath, { ts, run_id: "RISK-JUDGE", task_id: TASK, step: "risk_judge.escalated",
    issue_url: ISSUE_URL, pr_number: PR_NUMBER, head_sha: head } as LedgerLine);
}

/** The `acted:true` row the sweep's own 19:30Z arm wrote. */
function priorSweepArm(ledgerPath: string): void {
  appendLedger(ledgerPath, { run_id: "DAEMON-1", task_id: "SWEEP", step: "sweep.disposed", pr_number: PR_NUMBER,
    pr_url: PR_URL, disposition: "mergeable", acted: true, arm_outcome: "armed", head_sha: HEAD });
}

const fleetEnqueue: ArmTimelineEvent = { kind: "AddedToMergeQueueEvent", actor: "remudero-fleet", at: "2026-10-05T19:30:12Z" };
const operatorEnqueue: ArmTimelineEvent = { kind: "AddedToMergeQueueEvent", actor: "cao825", at: "2026-10-05T19:52:27Z" };

function timeline(...events: ArmTimelineEvent[]): ArmTimeline {
  return { events };
}

function harness(t: TestContext, read: () => ArmTimeline | Promise<ArmTimeline>) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5911-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const arms: string[] = [];
  let reads = 0;
  const deps: SweepDeps = {
    arm: (p) => { arms.push(p.headSha); return "armed"; },
    close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath, runId: "SWEEP-W1-T5911",
    readLedgerUnion: () => ({ complete: false, lines: [] }),
    readArmTimeline: () => { reads++; return read(); },
  };
  const pass = (view = pr(), overrides: Partial<SweepDeps> = {}) => runSweep([view], { ...deps, ...overrides });
  const rows = (step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step);
  const lastDisposed = () => rows("sweep.disposed").at(-1)!;
  return { ledgerPath, arms, reads: () => reads, pass, rows, lastDisposed };
}

const REFUSED = `risk judge escalated this head, no operator override recorded — see ${ISSUE_URL}`;

test("W1-T5911: an operator's enqueue after the escalation is recorded once as a head-bound override and the head is armed", async (t) => {
  const h = harness(t, () => timeline(fleetEnqueue, operatorEnqueue));
  priorSweepArm(h.ledgerPath);
  escalated(h.ledgerPath);
  await h.pass(pr(), { readMergeQueueMembership: () => "not-queued" });
  assert.deepEqual(h.arms, [HEAD], "the operator's enqueue released the head; the ejection re-arms it");
  const observed = h.rows(RISK_OVERRIDE_OBSERVED_STEP);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].by, "cao825");
  assert.equal(observed[0].head_sha, HEAD);
  assert.equal(observed[0].pr_number, PR_NUMBER);
  assert.equal(observed[0].pr_url, PR_URL);
  assert.equal(observed[0].issue_url, ISSUE_URL);
  assert.match(String(observed[0].reason), /AddedToMergeQueueEvent by cao825 at 2026-10-05T19:52:27Z/);
  assert.match(String(observed[0].reason), new RegExp(ESCALATED_AT));
  assert.equal(h.lastDisposed().acted, true);
  assert.equal(h.rows("automerge.rearmed_after_disarm").length, 1, "W1-T5909's bounded re-arm path carries it");

  await h.pass(pr(), { readMergeQueueMembership: () => "not-queued" });
  assert.equal(h.rows(RISK_OVERRIDE_OBSERVED_STEP).length, 1, "recorded once");
  assert.equal(h.reads(), 1, "the recorded override is read back; the timeline is not asked again");
});

test("W1-T5911: a hand arm (AutoMergeEnabledEvent) releases the head with the merge queue off", async (t) => {
  const h = harness(t, () => timeline({ kind: "AutoMergeEnabledEvent", actor: "cao825", at: "2026-10-05T20:01:00Z" }));
  escalated(h.ledgerPath);
  await h.pass();
  assert.deepEqual(h.arms, [HEAD]);
  assert.match(String(h.rows(RISK_OVERRIDE_OBSERVED_STEP)[0].reason), /AutoMergeEnabledEvent by cao825/);
});

test("W1-T5911: a fleet-actor event after the escalation leaves the refusal standing, reason named", async (t) => {
  const h = harness(t, () => timeline({ ...fleetEnqueue, at: "2026-10-05T19:50:00Z" }));
  escalated(h.ledgerPath);
  await h.pass();
  assert.deepEqual(h.arms, []);
  assert.equal(h.rows(RISK_OVERRIDE_OBSERVED_STEP).length, 0);
  assert.equal(h.lastDisposed().acted, false);
  assert.equal(h.lastDisposed().stand_down_reason,
    `${REFUSED}; no hand arm taken: no arm or enqueue by anyone but the fleet App after the escalation at ${ESCALATED_AT}`);
});

test("W1-T5911: all three fleet spellings are the fleet — none releases the head", async (t) => {
  for (const actor of ["remudero-fleet", "remudero-fleet[bot]", "app/remudero-fleet"]) {
    await t.test(actor, async (st) => {
      assert.equal(isFleetAppAuthor(actor), true);
      const h = harness(st, () => timeline({ kind: "AutoMergeEnabledEvent", actor, at: "2026-10-05T19:50:00Z" }));
      escalated(h.ledgerPath);
      await h.pass();
      assert.deepEqual(h.arms, []);
      assert.equal(h.rows(RISK_OVERRIDE_OBSERVED_STEP).length, 0);
      assert.match(String(h.lastDisposed().stand_down_reason), /no arm or enqueue by anyone but the fleet App/);
    });
  }
  assert.equal(isFleetAppAuthor("cao825"), false);
});

test("W1-T5911: an operator event before the escalation leaves the refusal standing", async (t) => {
  const h = harness(t, () => timeline({ ...operatorEnqueue, at: "2026-10-05T19:40:00Z" }));
  escalated(h.ledgerPath);
  await h.pass();
  assert.deepEqual(h.arms, []);
  assert.equal(h.rows(RISK_OVERRIDE_OBSERVED_STEP).length, 0);
  assert.match(String(h.lastDisposed().stand_down_reason), /no arm or enqueue by anyone but the fleet App after the escalation/);
});

test("W1-T5911: the override binds its head only — a new escalated head stays refused", async (t) => {
  const h = harness(t, () => timeline(operatorEnqueue));
  escalated(h.ledgerPath);
  await h.pass();
  assert.deepEqual(h.arms, [HEAD]);
  escalated(h.ledgerPath, NEXT_HEAD, "2026-10-05T22:00:00.000Z");
  await h.pass(pr({ headSha: NEXT_HEAD }));
  assert.deepEqual(h.arms, [HEAD], "the HEAD-bound override never carries to the new head");
  assert.deepEqual(h.rows(RISK_OVERRIDE_OBSERVED_STEP).map((r) => r.head_sha), [HEAD]);
  assert.match(String(h.lastDisposed().stand_down_reason), /^risk judge escalated this head, no operator override recorded/);
});

test("W1-T5911: an unreadable timeline leaves the refusal standing with the read's reason", async (t) => {
  const reason = "timeline unreadable: HTTP 502";
  const h = harness(t, () => ({ unreadable: true, reason }));
  escalated(h.ledgerPath);
  await h.pass();
  assert.deepEqual(h.arms, []);
  assert.equal(h.rows(RISK_OVERRIDE_OBSERVED_STEP).length, 0);
  assert.equal(h.lastDisposed().stand_down_reason, `${REFUSED}; no hand arm taken: ${reason}`);
});

test("W1-T5911: a timeline read that throws is unreadable, never a release", async (t) => {
  const h = harness(t, () => { throw new Error("socket hang up"); });
  escalated(h.ledgerPath);
  await h.pass();
  assert.deepEqual(h.arms, []);
  assert.equal(h.lastDisposed().stand_down_reason, `${REFUSED}; no hand arm taken: socket hang up`);
});

test("W1-T5911: an operator hold outranks a hand enqueue — nothing is read or recorded", async (t) => {
  const h = harness(t, () => timeline(operatorEnqueue));
  escalated(h.ledgerPath);
  appendLedger(h.ledgerPath, { step: "automerge.hold_engaged", pr_number: PR_NUMBER, reason: "operator hold",
    task_id: TASK, authority: "interactive-cli", by: "operator", run_id: "hold" });
  await h.pass();
  assert.deepEqual(h.arms, []);
  assert.equal(h.reads(), 0);
  assert.equal(h.rows(RISK_OVERRIDE_OBSERVED_STEP).length, 0);
  assert.equal(h.lastDisposed().stand_down_reason,
    `${REFUSED}; no hand arm taken: an operator merge hold stands over this PR`);
});

test("W1-T5911: an escalation row with no readable ts leaves the refusal standing, unread", async (t) => {
  const h = harness(t, () => timeline(operatorEnqueue));
  escalated(h.ledgerPath, HEAD, "not-a-time");
  await h.pass();
  assert.deepEqual(h.arms, []);
  assert.equal(h.reads(), 0);
  assert.equal(h.lastDisposed().stand_down_reason,
    `${REFUSED}; no hand arm taken: this head's risk_judge.escalated row carries no readable ts`);
});

test("W1-T5911: an override row that cannot be written leaves the refusal standing, reason named", async (t) => {
  const h = harness(t, () => timeline(operatorEnqueue));
  escalated(h.ledgerPath);
  await h.pass(pr(), {
    appendLine: (path, line) => {
      if (line.step === RISK_OVERRIDE_OBSERVED_STEP) throw new Error("EROFS");
      appendLedger(path, line);
    },
  });
  assert.deepEqual(h.arms, []);
  assert.equal(h.lastDisposed().stand_down_reason, `${REFUSED}; no hand arm taken: override row not written: EROFS`);
});

test("W1-T5911: a dry run and a light pass neither read the timeline nor record", async (t) => {
  const h = harness(t, () => timeline(operatorEnqueue));
  escalated(h.ledgerPath);
  await h.pass(pr(), { dryRun: true });
  await h.pass(pr(), { actionable: (d) => d === "post-review" });
  assert.equal(h.reads(), 0);
  assert.equal(h.rows(RISK_OVERRIDE_OBSERVED_STEP).length, 0);
  assert.deepEqual(h.arms, []);
});

test("W1-T5911: with no timeline reader wired the refusal sentence is today's, word for word", async (t) => {
  const h = harness(t, () => timeline(operatorEnqueue));
  escalated(h.ledgerPath);
  await h.pass(pr(), { readArmTimeline: undefined });
  assert.deepEqual(h.arms, []);
  assert.equal(h.lastDisposed().stand_down_reason, REFUSED);
});

test("W1-T5911: a failed arm's fresh-evidence recheck honours the observed override", async (t) => {
  const facts: ArmReprobeFacts = { prNumber: PR_NUMBER, headSha: HEAD, state: "open", autoMergeArmed: false,
    mergeable: true, mergeableState: "clean", baseSha: "base-a", reviewPublished: true, checksGreen: true };
  let current: ArmReprobeFacts = { ...facts, mergeable: null, mergeableState: "unknown", reviewPublished: false };
  const h = harness(t, () => timeline(operatorEnqueue));
  const failing: Partial<SweepDeps> = {
    arm: (p) => { h.arms.push(p.headSha); return { outcome: "arm-error-ignored", failureClass: "unknown" }; },
    readArmFacts: async () => current,
  };
  await h.pass(pr(), failing);
  assert.deepEqual(h.arms, [HEAD]);
  escalated(h.ledgerPath);
  appendLedger(h.ledgerPath, { run_id: "SWEEP-earlier", task_id: TASK, step: RISK_OVERRIDE_OBSERVED_STEP, pr_number: PR_NUMBER,
    pr_url: PR_URL, head_sha: HEAD, by: "cao825", reason: "AddedToMergeQueueEvent by cao825", issue_url: ISSUE_URL });
  current = facts;
  await h.pass(pr(), failing);
  assert.deepEqual(h.arms, [HEAD, HEAD], "fresh evidence plus the head's observed override reopens the arm");
  assert.equal(h.reads(), 0);
});

// ── The real read: the default `readJsonImpl` shells out to `gh` (a PATH shim here). ────────────

function realEffects(t: TestContext, routes: Array<{ when: string; stdout?: string; exit?: number; stderr?: string }>) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5911-real-`));
  const shim = ghShim(routes, { kind: "w1t5911-gh" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-W1-T5911-real", plan: { tasks: [], byId: new Map() },
    log: () => {}, spawnWallClockBoundMsOverride: 1,
  });
  return { effects, shim };
}

const TIMELINE_NODES = JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: [
  { __typename: "AutoMergeEnabledEvent", createdAt: "2026-10-05T19:24:00Z", actor: { login: "remudero-fleet" } },
  { __typename: "AddedToMergeQueueEvent", createdAt: "2026-10-05T19:30:12Z", actor: { login: "remudero-fleet" } },
  { __typename: "AddedToMergeQueueEvent", createdAt: "2026-10-05T19:52:27Z", actor: { login: "cao825" } },
  { __typename: "AddedToMergeQueueEvent", createdAt: "2026-10-05T20:00:00Z", actor: null },
  { __typename: "SomethingElse", createdAt: "2026-10-05T20:01:00Z", actor: { login: "cao825" } },
] } } } } });

test("W1-T5911: the real read asks only the timeline and returns each attributable arm and enqueue", async (t) => {
  const { effects, shim } = realEffects(t, [{ when: "timelineItems", stdout: TIMELINE_NODES }]);
  const read = await effects.readArmTimeline!(pr());
  assert.deepEqual(read, { events: [
    { kind: "AutoMergeEnabledEvent", actor: "remudero-fleet", at: "2026-10-05T19:24:00Z" },
    { kind: "AddedToMergeQueueEvent", actor: "remudero-fleet", at: "2026-10-05T19:30:12Z" },
    { kind: "AddedToMergeQueueEvent", actor: "cao825", at: "2026-10-05T19:52:27Z" },
  ] });
  assert.equal(shim.calls().length, 1, "one GraphQL read, no identity lookup");
  const call = shim.calls()[0];
  assert.match(call, /AUTO_MERGE_ENABLED_EVENT/);
  assert.match(call, /ADDED_TO_MERGE_QUEUE_EVENT/);
  assert.match(call, /number=9391/);
  assert.match(call, /owner=craigoley/);
  assert.match(call, /name=remudero/);
});

test("W1-T5911: the real read is unreadable for a failed gh or a timeline-less answer", async (t) => {
  const cases: Array<[string, Array<{ when: string; stdout?: string; exit?: number; stderr?: string }>, RegExp]> = [
    ["timeline gh fails", [{ when: "timelineItems", exit: 1, stderr: "HTTP 502" }], /^timeline unreadable: /],
    ["timeline missing", [{ when: "timelineItems", stdout: '{"data":{"repository":{"pullRequest":null}}}' }],
      /^timeline unreadable: the GraphQL answer carried no timelineItems nodes$/],
  ];
  for (const [name, routes, reason] of cases) {
    await t.test(name, async (st) => {
      const { effects } = realEffects(st, routes);
      const read = await effects.readArmTimeline!(pr());
      assert.equal((read as { unreadable?: boolean }).unreadable, true);
      assert.match((read as { reason: string }).reason, reason);
    });
  }
});

test("W1-T5911: a PR url the read cannot parse is unreadable, and nothing is asked", async () => {
  const asked: string[][] = [];
  const read = await readArmTimeline("not-a-pr-url", (args) => { asked.push(args); return {}; });
  assert.deepEqual(read, { unreadable: true, reason: "cannot resolve owner/repo/number from not-a-pr-url" });
  assert.deepEqual(asked, []);
});
