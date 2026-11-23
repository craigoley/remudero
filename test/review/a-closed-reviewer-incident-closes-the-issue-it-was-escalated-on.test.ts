/**
 * W1-T14427 — A CLOSED REVIEWER INCIDENT CLOSES THE ISSUE IT WAS ESCALATED ON. The live shape (host ledger, 2026-11-23
 * 03:39Z): incident reviewer-regression-8b37a0a1b86b raised #13968, which an operator session closed by hand on 11-16; its
 * healed-tree conflict escalation then opened #18909, and the URL it returned was discarded. The incident closed with
 * no-heal-not-regressed, its close closed only #13968, and #18909 stayed open. The incident now records the issue its
 * conflict escalation landed on, and a bounded sweep closes any open issue whose reviewer-regression incident is closed.
 * Every effect is a recording fake; the states are built in the reviewer-health file's own shape.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as health from "#src/lib/reviewer-health.js";
import { escalationIssueTitle, NEEDS_HUMAN_LABEL, renderIssueBody, type AsyncIssueGateway, type Escalation, type OpenIssue } from "#src/lib/escalate.js";
import type { MainRepairLane } from "#src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type Row = Record<string, unknown>;
type ShaRecord = health.ReviewerShaRecord;
const fake = (seed: string): string => createHash("sha1").update(seed).digest("hex");
const PULL = "https://github.com/acme/remudero/pull";
const ISSUES = "https://github.com/acme/remudero/issues";
const FIRST_ISSUE = `${ISSUES}/13968`;
const CONFLICT_ISSUE = `${ISSUES}/18909`;
const LIVE_ID = "reviewer-regression-8b37a0a1b86b";
let clock = Date.parse("2026-11-23T03:00:00.000Z");
const tick = (): string => new Date((clock += 1000)).toISOString();
const iso = { iso: () => new Date(clock).toISOString() };

function scratch(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}W1-T14427-${kind}-`));
  t.after(() => execFileSync("rm", ["-rf", dir]));
  return dir;
}

/** One tracked reviewer code sha: `posted` clean units and `refused` setup refusals, each a distinct PR head. */
function shaRecord(sha: string, seq: number, posted: number, refused: number, regressedAt?: string): ShaRecord {
  const units: ShaRecord["units"] = {};
  for (let i = 0; i < posted; i++) units[`${PULL}/${seq * 100 + i}#${fake(`${sha}-p${i}`)}`] = "posted";
  for (let i = 0; i < refused; i++) units[`${PULL}/${seq * 100 + 50 + i}#${fake(`${sha}-r${i}`)}`] = "setup-refused";
  return { sha, seq, firstSeen: tick(), healed: false, units, reasons: refused > 0 ? { "head-task-metadata-unavailable": refused } : {},
    ...(regressedAt === undefined ? {} : { regressedAt }) };
}

const offender = fake("offending-12954");

/** The live incident: opened on one refusal in six against a clean pooled history, regressed shas each followed by a clean
 *  one, its revert refused, then a healthy sha and today's reviewer at 0 of 1, so no heal in effect closes it. */
function liveShape(): { state: health.ReviewerHealthState; incident: health.ReviewerIncident; current: string } {
  const state = health.emptyReviewerHealthState();
  state.pooled = { k: 0, n: 5267, shas: 1475 };
  state.seq = 1475;
  state.seededAt = "2026-10-21T17:59:26.272Z";
  state.cursor = { liveOffset: 0 };
  const add = (rec: ShaRecord) => { state.shas[rec.sha] = rec; state.seq = rec.seq; return rec; };
  const onset = add(shaRecord(fake("live-onset"), 1476, 5, 1, "2026-10-21T17:59:25.101Z"));
  for (let i = 1; i < 12; i++) {
    add(shaRecord(fake(`live-regressed-${i}`), 1476 + 2 * i - 1, 0, 1, tick()));
    add(shaRecord(fake(`live-clean-${i}`), 1476 + 2 * i, 1, 0));
  }
  add(shaRecord(fake("live-newest-healthy"), state.seq + 1, 3, 0));
  const current = add(shaRecord(fake("live-today"), state.seq + 1, 1, 0)).sha;
  const incident: health.ReviewerIncident = {
    id: LIVE_ID, openedAt: "2026-10-21T17:59:25.101Z", regressedSha: onset.sha, regressedSeq: onset.seq,
    bootHeadSha: null, lastHealthySha: fake("live-last-healthy"),
    offending: { sha: offender, subject: "fix(review): refuse incomplete required semantic evaluation (#12954)", pr: 12954, reason: "touches src/lib/required-semantic-review.ts" },
    signature: ["head-task-metadata-unavailable"],
    evidence: { sha: onset.sha, state: "regressed", reason: null, k: 1, n: 6, baseline: { k: 0, n: 5267 },
      interval: { lower: 0.0075, upper: 0.84 }, baselineInterval: { lower: 0, upper: 0.0036 }, z: 4.518 },
    issueUrl: FIRST_ISSUE,
    revertRefused: { reason: "git revert did not apply cleanly on origin/main", paths: ["src/run-task.ts"] },
  };
  state.incident = incident;
  return { state, incident, current };
}

const conflictAt = (originMainSha: string): Extract<health.HealedTree, { state: "conflict" }> => ({
  state: "conflict", originMainSha, reason: `the revert of ${offender.slice(0, 12)} does not apply cleanly on origin/main ${originMainSha.slice(0, 12)}`,
  paths: ["src/run-task.ts"],
});

/** An open issue exactly as the escalation path renders it. */
const issueFor = (url: string, e: Escalation): OpenIssue =>
  ({ number: Number(url.split("/").at(-1)), url, title: escalationIssueTitle(e), body: renderIssueBody(e) });

/** The live incident as the state file holds it after its close: no conflict issue recorded, as on origin/main. */
function closedLive(): { state: health.ReviewerHealthState; current: string; orphan: OpenIssue } {
  const { state, incident, current } = liveShape();
  const healedTree = { ...conflictAt(current), at: "2026-11-16T18:33:09.000Z" };
  state.closed = [{ ...incident, healedTree, conflictEscalatedAt: healedTree.at, closedAt: "2026-11-23T03:39:16.000Z", closedReason: "no-heal-not-regressed" }];
  state.incident = null;
  return { state, current, orphan: issueFor(CONFLICT_ISSUE, health.reviewerRegressionEscalation(incident, conflictAt(current))) };
}

interface Calls { created: string[]; comments: Array<{ url: string; body: string }>; closed: Array<{ url: string; comment: string }>; reads: string[] }

/** The repo's open issues behind a recording gateway: create opens one (numbered from `next`), close removes it. */
function harness(t: TestContext, opts: { next?: number; lane?: Partial<MainRepairLane>; statePath?: string } = {}) {
  const dir = scratch(t, "state");
  const statePath = opts.statePath ?? health.reviewerHealthStatePath(dir);
  const open: OpenIssue[] = [];
  const calls: Calls = { created: [], comments: [], closed: [], reads: [] };
  let next = opts.next ?? 20001;
  const issues: AsyncIssueGateway = {
    create: async (title, body) => {
      const url = `${ISSUES}/${next}`;
      open.push({ number: next++, url, title, body });
      calls.created.push(url);
      return url;
    },
    listOpen: async (label) => { calls.reads.push(label); return label === NEEDS_HUMAN_LABEL ? [...open] : []; },
    ensureLabel: async () => true,
    comment: async (url, body) => { calls.comments.push({ url, body }); },
    closeWithComment: async (url, comment) => {
      calls.closed.push({ url, comment });
      const at = open.findIndex((issue) => issue.url === url);
      if (at >= 0) open.splice(at, 1);
    },
  };
  const lane: MainRepairLane = {
    openFixPr: async () => { throw new Error("a reviewer regression opens no fix PR"); },
    openRevertPr: async () => ({ refused: "the revert does not apply" }),
    closePr: async () => undefined,
    ...opts.lane,
  };
  const escalation = { issues, ledgerPath: join(dir, "ledger.ndjson"), runId: "reviewer-health-14427" };
  const logs: Array<{ step: string; extra: Row }> = [];
  const log = (step: string, extra: Row = {}) => { logs.push({ step, extra }); };
  const queue: Row[] = [];
  let duringRead: (() => Promise<void>) | undefined;
  const readRows = async () => { await duringRead?.(); duringRead = undefined; return { rows: queue.splice(0), cursor: { liveOffset: 0 } }; };
  const git: health.GitText = async (args) => { throw new Error(`no git in this fixture: ${args[0]}`); };
  /** One evaluation, then its queued background effects. */
  const evaluate = async (originMainSha: string | null) => {
    const decision = await health.evaluateReviewerHealthNow({ originMainSha, readEvidenceJson: async () => [] }, statePath, readRows, git,
      escalation, lane, log, iso);
    await health.settleReviewerModelJudgment(statePath);
    return decision;
  };
  const note = (incident: health.ReviewerIncident, healed: health.HealedTree) => health.noteHealedTreeOutcome(statePath, incident, healed, escalation, log, iso);
  return { statePath, open, calls, logs, queue, issues, evaluate, note,
    load: () => health.loadReviewerHealthState(statePath),
    save: (state: health.ReviewerHealthState) => health.saveReviewerHealthState(statePath, state),
    readDuring: (action: () => Promise<void>) => { duringRead = action; },
    steps: (step: string) => logs.filter((l) => l.step === step),
    closedOn: (url: string) => calls.closed.filter((c) => c.url === url) };
}

/** A process restart: every in-memory memo, the sweep's start included, is forgotten. */
function restart(t: TestContext): void {
  health.resetHealedReviewerTrees();
  t.after(() => health.resetHealedReviewerTrees());
}

test("W1-T14427 criterion 1: When the healed-tree conflict escalation (reviewer-health.ts ~:1332) lands on an issue other than the incident's recorded one, the incident records that issue, and the incident's close closes it with the close comment; on origin/main the URL is discarded and the close skips the issue", async (t) => {
  restart(t);
  const h = harness(t, { next: 18909 });
  const { state, incident, current } = liveShape();
  h.save(state);
  // #13968 was closed by hand on 11-16, so it is not open: the conflict escalation opens #18909.
  await h.note(incident, conflictAt(current));
  assert.deepEqual(h.calls.created, [CONFLICT_ISSUE]);
  assert.equal(h.load().incident?.conflictIssueUrl, CONFLICT_ISSUE, "the incident records the issue its conflict escalation landed on");
  assert.equal(h.load().incident?.issueUrl, FIRST_ISSUE, "the incident's first issue stays recorded");

  // No heal is in effect and today's reviewer is not regressed: the next evaluation closes the incident.
  await h.evaluate(current);
  const after = h.load();
  assert.equal(after.incident, null);
  assert.equal(after.closed.at(-1)?.id, LIVE_ID);
  assert.equal(after.closed.at(-1)?.closedReason, "no-heal-not-regressed");
  const onConflict = h.closedOn(CONFLICT_ISSUE);
  assert.equal(onConflict.length, 1, "the close closes the conflict issue, once");
  assert.match(onConflict[0]!.comment, /No heal is in effect/, "with the incident's own close comment");
  assert.match(onConflict[0]!.comment, /W1-T13393/);
  assert.equal(h.closedOn(FIRST_ISSUE).length, 1, "the first issue is closed as before");
  assert.equal(h.closedOn(FIRST_ISSUE)[0]!.comment, onConflict[0]!.comment);
  assert.deepEqual(h.open, [], "the incident leaves no issue open");
  assert.deepEqual(h.steps("reviewer.regression_issue_close_failed"), []);

  // Reopened by the same failure, it is a new incident: the closed one's conflict issue stays behind with it.
  h.queue.push(...[0, 1, 2, 3].map((i) => ({ ts: tick(), host: "core", step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable",
    reviewer_code_sha: fake("live-relapse"), pr_url: `${PULL}/${7000 + i}`, head_sha: fake(`relapse-head-${i}`) })));
  await h.evaluate(fake("live-relapse"));
  const reopened = h.load().incident!;
  assert.equal(reopened.reopenedFrom, LIVE_ID);
  assert.equal(reopened.conflictIssueUrl, undefined);
});

test("W1-T14427 criterion 1: a conflict escalation that lands on the incident's own open issue records nothing new, and the close closes it once", async (t) => {
  restart(t);
  const h = harness(t);
  const { state, incident, current } = liveShape();
  h.save(state);
  const conflict = conflictAt(current);
  h.open.push(issueFor(FIRST_ISSUE, health.reviewerRegressionEscalation(incident, conflict)));
  await h.note(incident, conflict);
  assert.deepEqual(h.calls.created, [], "deduped onto the open issue");
  assert.equal(h.calls.comments.at(-1)?.url, FIRST_ISSUE);
  assert.equal(h.load().incident?.conflictIssueUrl, undefined);
  await h.evaluate(current);
  assert.equal(h.load().incident, null);
  assert.equal(h.closedOn(FIRST_ISSUE).length, 1);
  assert.deepEqual(h.open, []);
});

test("W1-T14427 criterion 1: an evaluation that loaded the file before the conflict issue was recorded keeps the record", async (t) => {
  restart(t);
  const h = harness(t, { next: 18909, lane: { readPr: async () => ({ state: "open" as const }) } });
  const { state, incident, current } = liveShape();
  // A revert PR is open: a heal is in effect, so this evaluation closes nothing.
  state.incident!.revertPrUrl = `${PULL}/900`;
  h.save(state);
  h.readDuring(() => h.note(incident, conflictAt(current)));
  assert.equal((await h.evaluate(current)).route, "healed");
  assert.equal(h.load().incident?.conflictIssueUrl, CONFLICT_ISSUE, "a concurrent evaluation never drops the recorded conflict issue");
  assert.equal(h.load().incident?.healedTree?.state, "conflict");
});

test("W1-T14427 criterion 1: a state file that cannot record the conflict issue ledgers it", async (t) => {
  restart(t);
  const dir = scratch(t, "unwritable");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir);
  const h = harness(t, { next: 18909, statePath: join(stateDir, "reviewer-health.json") });
  const { state, incident, current } = liveShape();
  h.save(state);
  // The escalation is claimed on the file; while it files, the file's directory becomes a regular file, so the
  // record that follows cannot be written, whatever the uid.
  const create = h.issues.create;
  h.issues.create = async (...args) => {
    renameSync(stateDir, `${stateDir}-moved`);
    writeFileSync(stateDir, "not a directory\n");
    return create(...args);
  };
  await h.note(incident, conflictAt(current));
  assert.deepEqual(h.calls.created, [CONFLICT_ISSUE]);
  const unrecorded = h.steps("reviewer.health_unavailable").filter((l) => l.extra.phase === "conflict-issue-record");
  assert.equal(unrecorded.length, 1, JSON.stringify(h.logs));
  assert.equal(unrecorded[0]!.extra.issue_url, CONFLICT_ISSUE);
  assert.equal(unrecorded[0]!.extra.incident_id, LIVE_ID);
});

test("W1-T14427 criterion 2: An open issue for a reviewer-regression incident id that is not the open incident's id is closed with a comment naming the closed incident, read through the gateway's listOpen at most once per evaluator start and once after each close; a failed read closes nothing and is ledgered", async (t) => {
  restart(t);
  const h = harness(t);
  const { state, current, orphan } = closedLive();
  h.save(state);
  h.open.push(orphan);
  // The first evaluation after a start: #18909 closes, with a comment naming the incident's close.
  await h.evaluate(current);
  assert.deepEqual(h.calls.reads, [NEEDS_HUMAN_LABEL], "one read, on the escalation label");
  assert.deepEqual(h.calls.closed.map((c) => c.url), [CONFLICT_ISSUE]);
  const comment = h.calls.closed[0]!.comment;
  assert.match(comment, new RegExp(LIVE_ID));
  assert.match(comment, /2026-11-23T03:39:16\.000Z/);
  assert.match(comment, /no-heal-not-regressed/);
  assert.match(comment, /W1-T14427/);

  // Further evaluations with no close read nothing more, whatever opens meanwhile.
  h.open.push({ ...orphan, number: 18910, url: `${ISSUES}/18910` });
  for (let i = 0; i < 3; i++) await h.evaluate(current);
  assert.equal(h.calls.reads.length, 1, "at most once per evaluator start");
  // A restart is a new start: one more read, which closes the issue opened since.
  restart(t);
  await h.evaluate(current);
  assert.equal(h.calls.reads.length, 2);
  assert.deepEqual(h.calls.closed.map((c) => c.url), [CONFLICT_ISSUE, `${ISSUES}/18910`]);
  await h.evaluate(current);
  assert.equal(h.calls.reads.length, 2);
});

test("W1-T14427 criterion 2: each close reads once more, and closes the issue its incident never recorded", async (t) => {
  restart(t);
  let revert: "open" | "merged" = "open";
  const h = harness(t, { lane: { readPr: async () => ({ state: revert }) } });
  const { state, incident, current } = liveShape();
  state.incident!.revertPrUrl = `${PULL}/900`;
  state.incident!.healedTree = { ...conflictAt(current), at: tick() };
  h.save(state);
  // An issue the open incident's route opened and never recorded (the healed child's death escalation, run-task.ts).
  const death = issueFor(`${ISSUES}/18950`, health.reviewerHealedChildDiedEscalation(incident, "exit 1 before judging"));
  h.open.push(death);
  await h.evaluate(current);
  await h.evaluate(current);
  assert.equal(h.calls.reads.length, 1, "the start's one read");
  assert.equal(h.calls.closed.length, 0, "the open incident's issue stays open");
  // The revert PR merged: no heal is in effect, and the incident closes. Its close is followed by one read.
  revert = "merged";
  await h.evaluate(current);
  assert.equal(h.load().incident, null);
  assert.equal(h.calls.reads.length, 2, "once after the close");
  assert.deepEqual(h.calls.closed.map((c) => c.url), [FIRST_ISSUE, death.url]);
  assert.match(h.calls.closed[1]!.comment, new RegExp(`${LIVE_ID} closed`));
  await h.evaluate(current);
  assert.equal(h.calls.reads.length, 2);
});

test("W1-T14427 criterion 2: a failed read closes nothing and is ledgered, and a failed close is ledgered", async (t) => {
  restart(t);
  const h = harness(t);
  const { state, current, orphan } = closedLive();
  h.save(state);
  h.open.push(orphan);
  h.issues.listOpen = async (label) => { h.calls.reads.push(label); throw new Error("HTTP 502 from the issues endpoint"); };
  await h.evaluate(current);
  assert.equal(h.calls.reads.length, 1);
  assert.deepEqual(h.calls.closed, [], "a failed read closes nothing");
  const failed = h.steps("reviewer.health_unavailable").filter((l) => l.extra.phase === "closed-incident-issue-sweep");
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]!.extra.error), /HTTP 502/);
  assert.equal(failed[0]!.extra.label, NEEDS_HUMAN_LABEL);

  restart(t);
  const r = harness(t);
  r.save(closedLive().state);
  r.open.push(orphan);
  r.issues.closeWithComment = async () => { throw new Error("HTTP 403 secondary rate limit"); };
  await r.evaluate(current);
  const closeFailed = r.steps("reviewer.regression_issue_close_failed").filter((l) => l.extra.phase === "closed-incident-issue-sweep");
  assert.deepEqual(closeFailed.map((l) => [l.extra.incident_id, l.extra.issue_url]), [[LIVE_ID, CONFLICT_ISSUE]]);
  assert.match(String(closeFailed[0]!.extra.error), /HTTP 403/);
});

test("W1-T14427 criterion 3: invariant:an-open-incidents-issue-stays-open — the open incident's own issue, and every issue that is not a reviewer-regression escalation, is never closed by the sweep", async (t) => {
  restart(t);
  const h = harness(t);
  const { state, current, orphan } = closedLive();
  const open = { ...liveShape().incident, id: `reviewer-regression-${fake("open-incident").slice(0, 12)}`, issueUrl: `${ISSUES}/20001` };
  state.incident = open;
  state.incident.revertPrUrl = `${PULL}/901`;
  h.save(state);
  const kept: OpenIssue[] = [
    issueFor(`${ISSUES}/20001`, health.reviewerRegressionEscalation(open)),
    issueFor(`${ISSUES}/20002`, health.reviewerRegressionEscalation(open, conflictAt(current))),
    issueFor(`${ISSUES}/20003`, health.reviewerHealedChildDiedEscalation(open, "exit 1 before judging")),
    { number: 20004, url: `${ISSUES}/20004`, title: "a task's own escalation", body: "**Task:** W1-T13968\n**Class:** BLOCKED\n" },
    { number: 20005, url: `${ISSUES}/20005`, title: "a model divergence", body: "**Task:** reviewer-model-divergence-gpt-6.2-sol\n" },
    { number: 20006, url: `${ISSUES}/20006`, title: "no body at all" },
    // Another process's new incident: its issue is open before the state file names the incident.
    { number: 20007, url: `${ISSUES}/20007`, title: "a newer incident", body: `**Task:** reviewer-regression-${fake("not-yet-saved").slice(0, 12)}\n` },
  ];
  h.open.push(...kept, orphan);
  await h.evaluate(current);
  assert.equal(h.load().incident?.id, open.id, "the incident is still open");
  assert.deepEqual(h.calls.closed.map((c) => c.url), [CONFLICT_ISSUE], "the sweep ran, and closed only the closed incident's issue");
  assert.deepEqual(h.open.map((issue) => issue.url), kept.map((issue) => issue.url));
});
