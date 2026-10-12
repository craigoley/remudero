// W1-T5956 — A MERGE-QUEUE EJECTION DURING AN ACTIONS INCIDENT SPENDS NO RE-ARM. On 2026-10-05 the
// merge queue ejected #9391, #9392, #9388 and #9390 while GitHub Actions was degraded: group checks
// were cancelled after ~15 min without a runner. W1-T5909 re-arms a PR GitHub disarmed after an
// ejection and counts each re-arm against MAX_REARMS_AFTER_DISARM_PER_HEAD, so an outage longer than
// three group cycles escalated PRs that did nothing wrong. While W1-T5939's classifier reads degraded
// or major_outage the re-arm is free and the bound's escalation is not raised; once Actions is
// operational the count resumes. An unreadable status is an incident only for W1-T5939's hold
// BACKSTOP, measured from the first unreadable re-arm at the head, so a stuck read cannot hide a
// real ejection loop forever.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { ACTIONS_INCIDENT_HOLD_BACKSTOP_MS } from "../src/lib/actions-incident.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  MAX_REARMS_AFTER_DISARM_PER_HEAD,
  REARMED_AFTER_DISARM_STEP,
  REARM_EXHAUSTED_STEP,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-05T19:30:00Z");
const HOUR = 3_600_000;
const HEAD = "5956aaaa9392bbbbccccddddeeeeffff00001111";
const PR_NUMBER = 9392;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
const BOUND = MAX_REARMS_AFTER_DISARM_PER_HEAD;

function summary(actions: string): unknown {
  return { page: { id: "kctbh9vrtdwd" }, components: [{ name: "Git Operations", status: "operational" }, { name: "Actions", status: actions }],
    incidents: actions === "operational" ? [] : [{ name: "Incident with Actions", status: "investigating", components: [{ name: "Actions" }] }] };
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER, prUrl: PR_URL, taskId: "W1-T5908", headSha: HEAD,
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date(T0).toISOString(), autoMergeArmed: false,
    ...over,
  };
}

/** The `acted:true` arm row that seeds `prior.armed` at a head, as W1-T5909's suite writes it. */
function priorSweepArm(ledgerPath: string, prNumber = PR_NUMBER): void {
  appendLedger(ledgerPath, { run_id: "DAEMON-1", task_id: "SWEEP", step: "sweep.disposed", pr_number: prNumber,
    pr_url: `https://github.com/craigoley/remudero/pull/${prNumber}`, disposition: "mergeable", acted: true,
    arm_outcome: "armed", head_sha: HEAD });
}

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5956-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const arms: Array<{ pr: number; head: string }> = [];
  const escalations: Array<{ head: string; rearms: number }> = [];
  let statusReads = 0;
  let status: () => unknown = () => summary("operational");
  const deps: SweepDeps = {
    arm: (p) => { arms.push({ pr: p.prNumber, head: p.headSha }); return "armed"; },
    close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath, runId: "SWEEP-W1-T5956",
    readLedgerUnion: () => ({ complete: false, lines: [] }),
    readMergeQueueMembership: () => "not-queued",
    escalateRearmExhausted: (p, rearms) => { escalations.push({ head: p.headSha, rearms }); return `https://github.com/o/r/issues/${escalations.length}`; },
    readActionsStatusSummary: async () => { statusReads++; return status(); },
  };
  priorSweepArm(ledgerPath);
  const pass = (atMs: number, views: OpenPrView[] = [pr()], overrides: Partial<SweepDeps> = {}) =>
    runSweep(views, { ...deps, now: () => atMs, ...overrides });
  const rearmRows = () => readLedgerLines(ledgerPath).filter((row) => row.step === REARMED_AFTER_DISARM_STEP);
  const exhaustedRows = () => readLedgerLines(ledgerPath).filter((row) => row.step === REARM_EXHAUSTED_STEP);
  const lastDisposed = () => readLedgerLines(ledgerPath).filter((row) => row.step === "sweep.disposed").at(-1)!;
  return {
    ledgerPath, arms, escalations, pass, rearmRows, exhaustedRows, lastDisposed,
    setStatus: (next: () => unknown) => { status = next; },
    reads: () => statusReads,
  };
}

test("W1-T5956: an ejection during an Actions incident re-arms without counting and never escalates", async (t) => {
  const h = harness(t);
  h.setStatus(() => summary("major_outage"));
  for (let i = 0; i < BOUND * 2; i++) await h.pass(T0 + i * 20 * 60_000);
  assert.equal(h.arms.length, BOUND * 2, "every incident ejection is re-armed, past the bound");
  assert.deepEqual(h.escalations, [], "an outage escalates nothing");
  assert.equal(h.exhaustedRows().length, 0);
  const rows = h.rearmRows();
  assert.equal(rows.length, BOUND * 2);
  for (const row of rows) {
    assert.equal(row.counted, false);
    assert.equal(row.rearm_count, 0, "the per-head count is not incremented");
    assert.equal(row.actions_status, "major_outage");
    assert.match(String(row.actions_detail), /Incident with Actions/);
  }
  assert.equal(h.lastDisposed().acted, true);

  h.setStatus(() => summary("partial_outage"));
  await h.pass(T0 + 3 * HOUR);
  assert.equal(h.rearmRows().at(-1)!.actions_status, "degraded", "degraded is an incident too");
  assert.equal(h.rearmRows().at(-1)!.counted, false);
  assert.deepEqual(h.escalations, []);
});

test("W1-T5956: once Actions is operational the count resumes and escalates at the bound as before", async (t) => {
  const h = harness(t);
  h.setStatus(() => summary("major_outage"));
  for (let i = 0; i < BOUND + 1; i++) await h.pass(T0 + i * 20 * 60_000);
  h.setStatus(() => summary("operational"));
  for (let i = 0; i < BOUND; i++) await h.pass(T0 + 3 * HOUR + i * 20 * 60_000);
  assert.deepEqual(h.rearmRows().filter((r) => r.counted !== false).map((r) => r.rearm_count), [1, 2, 3].slice(0, BOUND));
  assert.equal(h.rearmRows().at(-1)!.actions_status, "operational");
  assert.deepEqual(h.escalations, []);

  await h.pass(T0 + 5 * HOUR);
  assert.equal(h.arms.length, BOUND + 1 + BOUND, "the bound holds the arm after recovery");
  assert.deepEqual(h.escalations, [{ head: HEAD, rearms: BOUND }]);
  assert.match(String(h.lastDisposed().stand_down_reason), new RegExp(`bound ${BOUND}`));
});

test("W1-T5956: an ejection observed in an incident after counted re-arms reached the bound re-arms free, then escalates after recovery", async (t) => {
  const h = harness(t);
  for (let i = 0; i < BOUND; i++) await h.pass(T0 + i * 20 * 60_000);
  h.setStatus(() => summary("major_outage"));
  await h.pass(T0 + 2 * HOUR);
  assert.equal(h.arms.length, BOUND + 1, "the last ejection may be the incident's: no escalation, a free re-arm");
  assert.deepEqual(h.escalations, []);
  assert.equal(h.rearmRows().at(-1)!.counted, false);
  assert.equal(h.rearmRows().at(-1)!.rearm_count, BOUND);

  h.setStatus(() => summary("operational"));
  await h.pass(T0 + 4 * HOUR);
  assert.equal(h.arms.length, BOUND + 1);
  assert.deepEqual(h.escalations, [{ head: HEAD, rearms: BOUND }]);
});

test("W1-T5956: an incident does not re-arm a head whose re-arm bound already escalated", async (t) => {
  const h = harness(t);
  for (let i = 0; i <= BOUND; i++) await h.pass(T0 + i * 20 * 60_000);
  assert.equal(h.escalations.length, 1);
  const reads = h.reads();
  h.setStatus(() => summary("major_outage"));
  await h.pass(T0 + 3 * HOUR);
  assert.equal(h.arms.length, BOUND, "the escalation's promise stands: this head is not re-armed again");
  assert.equal(h.escalations.length, 1);
  assert.equal(h.reads(), reads, "no status read is spent on a head that is already escalated");
});

test("W1-T5956: an unreadable status within the hold BACKSTOP counts as an incident, from a throw or an unreadable body", async (t) => {
  const h = harness(t);
  h.setStatus(() => { throw new Error("githubstatus.com 503"); });
  for (let i = 0; i < BOUND + 1; i++) await h.pass(T0 + i * HOUR);
  h.setStatus(() => ({ page: { id: "kctbh9vrtdwd" } }));
  await h.pass(T0 + ACTIONS_INCIDENT_HOLD_BACKSTOP_MS - 1);
  assert.equal(h.arms.length, BOUND + 2);
  assert.deepEqual(h.escalations, []);
  const rows = h.rearmRows();
  assert.deepEqual(rows.map((r) => r.counted), Array(BOUND + 2).fill(false));
  assert.deepEqual(rows.map((r) => r.actions_status), Array(BOUND + 2).fill("unreadable"));
  assert.match(String(rows[0].actions_detail), /githubstatus\.com 503/);
  assert.match(String(rows.at(-1)!.actions_detail), /no components/);
  assert.equal(rows[0].at_ms, T0);
});

test("W1-T5956: an unreadable status past the hold BACKSTOP counts normally and escalates at the bound", async (t) => {
  const h = harness(t);
  h.setStatus(() => { throw new Error("socket hang up"); });
  await h.pass(T0);
  for (let i = 0; i < BOUND; i++) await h.pass(T0 + ACTIONS_INCIDENT_HOLD_BACKSTOP_MS + i * 20 * 60_000);
  assert.deepEqual(h.rearmRows().map((r) => [r.counted, r.rearm_count]),
    [[false, 0], ...Array.from({ length: BOUND }, (_, i) => [true, i + 1])]);
  assert.deepEqual(h.escalations, []);
  await h.pass(T0 + ACTIONS_INCIDENT_HOLD_BACKSTOP_MS + HOUR);
  assert.deepEqual(h.escalations, [{ head: HEAD, rearms: BOUND }], "a stuck read cannot hide the loop forever");
});

test("W1-T5956: a readable status between unreadable reads starts a fresh unreadable window", async (t) => {
  const h = harness(t);
  h.setStatus(() => { throw new Error("timeout"); });
  await h.pass(T0);
  h.setStatus(() => summary("operational"));
  await h.pass(T0 + HOUR);
  h.setStatus(() => { throw new Error("timeout"); });
  await h.pass(T0 + ACTIONS_INCIDENT_HOLD_BACKSTOP_MS + HOUR);
  assert.deepEqual(h.rearmRows().map((r) => [r.actions_status, r.counted]),
    [["unreadable", false], ["operational", true], ["unreadable", false]]);
});

test("W1-T5956: one status read answers every disarmed PR in a pass", async (t) => {
  const h = harness(t);
  priorSweepArm(h.ledgerPath, PR_NUMBER + 1);
  h.setStatus(() => summary("major_outage"));
  await h.pass(T0, [pr(), pr({ prNumber: PR_NUMBER + 1, prUrl: `https://github.com/craigoley/remudero/pull/${PR_NUMBER + 1}` })]);
  assert.deepEqual(h.arms.map((a) => a.pr), [PR_NUMBER, PR_NUMBER + 1]);
  assert.equal(h.reads(), 1, "the incident reader is shared, not a second status read per PR");
  assert.deepEqual(h.rearmRows().map((r) => r.counted), [false, false]);
});

test("W1-T5956: with no status reader wired every re-arm counts, as W1-T5909 shipped it", async (t) => {
  const h = harness(t);
  for (let i = 0; i <= BOUND; i++) await h.pass(T0 + i * HOUR, [pr()], { readActionsStatusSummary: undefined });
  assert.deepEqual(h.rearmRows().map((r) => r.rearm_count), [1, 2, 3].slice(0, BOUND));
  assert.equal(h.rearmRows().some((r) => "counted" in r), false);
  assert.deepEqual(h.escalations, [{ head: HEAD, rearms: BOUND }]);
  assert.equal(h.reads(), 0);
});
