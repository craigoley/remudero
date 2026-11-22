/**
 * W1-T13393 — A REVIEWER-REGRESSION INCIDENT IS RAISED ONCE AND RETIRES WHEN ITS BLAMED CODE NO LONGER RUNS. The
 * 2026-11-22 live shape: an incident opened on Wilson-era judgments (83 regressed shas), its revert refused, its healed
 * tree conflicting on every origin/main sha (one escalation call per sha), and today's reviewer at 0 of 1 after the
 * newest healthy sha — a level the normal close can never clear. The healed-tree outcome is now recorded on the
 * incident through noteHealedTreeOutcome (run-task.ts's route calls it), escalated once per incident, and an incident
 * with no heal in effect closes once today's reviewer is not regressed on its run, the regressed shas kept in the run.
 * Every effect is a recording fake; the states are built in the reviewer-health file's own shape.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as health from "#src/lib/reviewer-health.js";
import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import type { MainRepairLane } from "#src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type Row = Record<string, unknown>;
type ShaRecord = health.ReviewerShaRecord;
const fake = (seed: string): string => createHash("sha1").update(seed).digest("hex");
const PULL = "https://github.com/acme/remudero/pull";
const ISSUE = "https://github.com/acme/remudero/issues/18909";
let clock = Date.parse("2026-11-22T00:00:00.000Z");
const tick = (): string => new Date((clock += 1000)).toISOString();
const iso = { iso: () => new Date(clock).toISOString() };

function scratch(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}W1-T13393-${kind}-`));
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

/** The pre-incident history the live file carries pooled: 0 of 5267 over 1475 reviewer code shas. */
function pooledState(): health.ReviewerHealthState {
  const state = health.emptyReviewerHealthState();
  state.pooled = { k: 0, n: 5267, shas: 1475 };
  state.seq = 1475;
  state.seededAt = "2026-10-21T17:59:26.272Z";
  state.cursor = { liveOffset: 0 };
  return state;
}

const offender = fake("offending-12954");

/** The live incident on 2026-11-22: opened on one refusal in six, 83 shas judged regressed (Wilson era: no run on any),
 *  a clean sha between each, the revert refused, then a healthy sha and today's reviewer at 0 of 1. */
function liveShape(): { state: health.ReviewerHealthState; incident: health.ReviewerIncident; current: string; healthy: string } {
  const state = pooledState();
  const add = (rec: ShaRecord) => { state.shas[rec.sha] = rec; state.seq = rec.seq; return rec; };
  const onset = add(shaRecord(fake("live-onset"), 1476, 5, 1, "2026-10-21T17:59:25.101Z"));
  for (let i = 1; i < 83; i++) {
    add(shaRecord(fake(`live-regressed-${i}`), 1476 + 2 * i - 1, 0, 1, tick()));
    add(shaRecord(fake(`live-clean-${i}`), 1476 + 2 * i, 1, 0));
  }
  const healthy = add(shaRecord(fake("live-newest-healthy"), state.seq + 1, 3, 0)).sha;
  const current = add(shaRecord(fake("live-today"), state.seq + 1, 1, 0)).sha;
  const incident: health.ReviewerIncident = {
    id: `reviewer-regression-${onset.sha.slice(0, 12)}`, openedAt: "2026-10-21T17:59:25.101Z", regressedSha: onset.sha, regressedSeq: onset.seq,
    bootHeadSha: null, lastHealthySha: fake("live-last-healthy"),
    offending: { sha: offender, subject: "fix(review): refuse incomplete required semantic evaluation (#12954)", pr: 12954, reason: "touches src/lib/required-semantic-review.ts" },
    signature: ["head-task-metadata-unavailable"],
    evidence: { sha: onset.sha, state: "regressed", reason: null, k: 1, n: 6, baseline: { k: 0, n: 5267 },
      interval: { lower: 0.0075, upper: 0.84 }, baselineInterval: { lower: 0, upper: 0.0036 }, z: 4.518 },
    issueUrl: ISSUE,
    revertRefused: { reason: "git revert did not apply cleanly on origin/main", paths: ["src/run-task.ts"] },
  };
  state.incident = incident;
  return { state, incident, current, healthy };
}

const conflictAt = (originMainSha: string): Extract<health.HealedTree, { state: "conflict" }> => ({
  state: "conflict", originMainSha, reason: `the revert of ${offender.slice(0, 12)} does not apply cleanly on origin/main ${originMainSha.slice(0, 12)}`,
  paths: ["src/run-task.ts", "test/event-driven-semantic-review.test.ts"],
});

interface Calls { created: Array<{ title: string; body: string }>; comments: string[]; closed: Array<{ url: string; comment: string }>; prsClosed: string[] }

function harness(t: TestContext, lane: Partial<MainRepairLane> = {}) {
  const dir = scratch(t, "state");
  const statePath = health.reviewerHealthStatePath(dir);
  const calls: Calls = { created: [], comments: [], closed: [], prsClosed: [] };
  const issues: AsyncIssueGateway = {
    create: async (title, body) => { calls.created.push({ title, body }); return `https://github.com/acme/remudero/issues/${20000 + calls.created.length}`; },
    listOpen: async () => [],
    ensureLabel: async () => true,
    comment: async (_url, body) => { calls.comments.push(body); },
    closeWithComment: async (url, comment) => { calls.closed.push({ url, comment }); },
  };
  const repair: MainRepairLane = {
    openFixPr: async () => { throw new Error("a reviewer regression opens no fix PR"); },
    openRevertPr: async () => ({ refused: "the revert does not apply" }),
    closePr: async (url) => { calls.prsClosed.push(url); },
    ...lane,
  };
  const escalation = { issues, ledgerPath: join(dir, "ledger.ndjson"), runId: "reviewer-health-13393" };
  const logs: Array<{ step: string; extra: Row }> = [];
  const log = (step: string, extra: Row = {}) => { logs.push({ step, extra }); };
  const queue: Row[] = [];
  let duringRead: (() => Promise<void>) | undefined;
  const readRows = async () => { await duringRead?.(); duringRead = undefined; return { rows: queue.splice(0), cursor: { liveOffset: 0 } }; };
  const git: health.GitText = async (args) => { throw new Error(`no git in this fixture: ${args[0]}`); };
  const evaluate = (originMainSha: string | null) =>
    health.evaluateReviewerHealthNow({ originMainSha, readEvidenceJson: async () => [] }, statePath, readRows, git, escalation, repair, log, iso);
  const note = (incident: health.ReviewerIncident, healed: health.HealedTree) => health.noteHealedTreeOutcome(statePath, incident, healed, escalation, log, iso);
  const load = () => health.loadReviewerHealthState(statePath);
  const save = (state: health.ReviewerHealthState) => health.saveReviewerHealthState(statePath, state);
  const escalations = () => calls.created.length + calls.comments.length;
  return { dir, statePath, calls, logs, queue, evaluate, note, load, save, escalations, escalation, log,
    readDuring: (action: () => Promise<void>) => { duringRead = action; }, steps: (step: string) => logs.filter((l) => l.step === step) };
}

test("W1-T13393 criterion 1: A healed tree that cannot be built escalates once for the incident: the conflict is recorded on state.incident through a reviewer-health.ts helper, so two main advances and a process restart make one tryEscalateAsync call", async (t) => {
  health.resetHealedReviewerTrees();
  t.after(() => health.resetHealedReviewerTrees());
  const h = harness(t);
  const { state, incident } = liveShape();
  h.save(state);
  const [mainA, mainB, mainC] = [fake("main-a"), fake("main-b"), fake("main-c")];
  await h.note(incident, conflictAt(mainA));
  assert.equal(h.escalations(), 1, "the first conflict of the incident escalates");
  assert.match(h.calls.created[0]!.body, /does not apply/);
  assert.match(h.calls.created[0]!.body, /test\/event-driven-semantic-review\.test\.ts/);
  await h.note(incident, conflictAt(mainB));
  await h.note(incident, { ...conflictAt(mainB), remembered: true });
  // A process restart forgets every in-memory memo; the claim is on the state file.
  health.resetHealedReviewerTrees();
  await h.note(incident, conflictAt(mainC));
  assert.equal(h.escalations(), 1, "two main advances and a restart make one tryEscalateAsync call for the incident");
  const recorded = h.load().incident!;
  assert.equal(recorded.id, incident.id);
  assert.deepEqual(recorded.healedTree && { ...recorded.healedTree, at: "-" },
    { state: "conflict", originMainSha: mainC, reason: conflictAt(mainC).reason, paths: conflictAt(mainC).paths, at: "-" },
    "the conflict's reason, paths and origin/main sha are recorded on state.incident");
  assert.ok(recorded.conflictEscalatedAt, "the escalation is claimed on the incident itself");
  // Keyed on the incident id: an incident the file no longer holds open records nothing and raises nothing.
  await h.note({ ...incident, id: "reviewer-regression-000000000000" }, conflictAt(fake("main-d")));
  assert.equal(h.escalations(), 1);
  assert.equal(h.load().incident!.healedTree!.originMainSha, mainC);
  // The route's own call (run-task.ts) is driven end to end by a-reviewer-regression-heals-itself.test.ts.
});

test("W1-T13393: the route's healed-tree record follows the tree and survives a concurrent evaluation", async (t) => {
  health.resetHealedReviewerTrees();
  t.after(() => health.resetHealedReviewerTrees());
  const h = harness(t);
  const { state, incident, current } = liveShape();
  // A revert PR is open: this incident has a heal in effect, so the record alone closes nothing.
  state.incident!.revertPrUrl = `${PULL}/900`;
  h.save(state);
  // An evaluation that loaded the file BEFORE the route wrote its record keeps that record when it saves.
  h.readDuring(() => h.note(incident, conflictAt(current)));
  await h.evaluate(current);
  assert.equal(h.load().incident?.healedTree?.state, "conflict", "a concurrent evaluation never drops the route's record");
  assert.ok(h.load().incident?.conflictEscalatedAt);
  assert.equal(h.escalations(), 1);
  // Unavailable is no build outcome: nothing changes.
  await h.note(incident, { state: "unavailable", originMainSha: null, reason: "origin/main unreadable" });
  assert.equal(h.load().incident?.healedTree?.state, "conflict");
  // main already reverts the blamed merge: recorded as an empty revert, never escalated.
  await h.note(incident, { state: "empty", originMainSha: fake("main-reverted") });
  const empty = h.load().incident!.healedTree!;
  assert.equal(empty.state, "empty");
  assert.equal(empty.originMainSha, fake("main-reverted"));
  assert.deepEqual(empty.paths, []);
  assert.equal(h.escalations(), 1);
  // The healed tree builds again: the record clears (a heal is in effect), and the escalation claim stays.
  await h.note(incident, { state: "ready", path: "/nowhere", sha: fake("healed"), originMainSha: fake("main-e"), patch: "revert" });
  assert.equal(h.load().incident?.healedTree, undefined);
  assert.ok(h.load().incident?.conflictEscalatedAt);
  await h.note(incident, conflictAt(fake("main-f")));
  assert.equal(h.escalations(), 1, "a later conflict of the same incident is not escalated again");
});

test("W1-T13393: a state file that cannot be written still escalates a conflict once in this process", async (t) => {
  health.resetHealedReviewerTrees();
  t.after(() => health.resetHealedReviewerTrees());
  const dir = scratch(t, "unwritable");
  // The state file's directory is a regular file: the lock's directory cannot be made, whatever the uid.
  writeFileSync(join(dir, "state"), "not a directory\n");
  const statePath = join(dir, "state", "reviewer-health.json");
  const created: string[] = [];
  const logs: string[] = [];
  const escalation = { issues: { create: async (title: string) => { created.push(title); return "https://github.com/acme/remudero/issues/1"; },
    listOpen: async () => [], ensureLabel: async () => true }, ledgerPath: join(dir, "ledger.ndjson"), runId: "reviewer-health-13393" };
  const { incident } = liveShape();
  for (const main of ["a", "b", "c"]) {
    await health.noteHealedTreeOutcome(statePath, incident, conflictAt(fake(`unwritable-${main}`)), escalation, (step) => { logs.push(step); }, iso);
  }
  assert.equal(created.length, 1);
  assert.deepEqual(logs, ["reviewer.health_unavailable", "reviewer.health_unavailable", "reviewer.health_unavailable"]);
  await health.noteHealedTreeOutcome(statePath, incident, { state: "empty", originMainSha: fake("unwritable-e") }, escalation, () => {}, iso);
  assert.equal(created.length, 1, "an empty revert never escalates");
});

test("W1-T13393 criterion 2: An incident with no revert PR open, no operatorHeal, and a recorded healed-tree conflict or empty revert closes through closeIncident with its own reason when A's run judgment for the current sha is not regressed: the live shape closes on its next evaluation", async (t) => {
  health.resetHealedReviewerTrees();
  t.after(() => health.resetHealedReviewerTrees());
  const h = harness(t);
  const { state, incident, current } = liveShape();
  assert.equal(Object.values(state.shas).filter((rec) => rec.regressedAt !== undefined).length, 83);
  // The normal close can never clear it: one refusal in one is a level no clean pool lies below.
  assert.equal(health.returnedToBaseline(state, incident, current).returned, false);
  // Without a recorded conflict the incident stays open, as on origin/main.
  h.save(state);
  assert.equal((await h.evaluate(current)).route, "healed");
  assert.equal(h.load().incident?.id, incident.id);
  // The conflict the route met, recorded on the incident: the next evaluation closes it, closing its issue.
  const recorded = h.load();
  recorded.incident!.healedTree = { ...conflictAt(current), at: tick() };
  h.save(recorded);
  const decision = await h.evaluate(current);
  assert.equal(decision.route, "normal");
  const after = h.load();
  assert.equal(after.incident, null);
  assert.equal(after.closed.at(-1)?.id, incident.id);
  assert.equal(after.closed.at(-1)?.closedReason, "no-heal-not-regressed", "closed with its own reason");
  assert.equal(h.calls.closed.length, 1);
  assert.equal(h.calls.closed[0]!.url, ISSUE);
  assert.match(h.calls.closed[0]!.comment, /No heal is in effect/);
  assert.match(h.calls.closed[0]!.comment, /W1-T13393/);
  const closedRow = h.steps("reviewer.regression_closed").at(-1)!;
  assert.equal(closedRow.extra.closed_reason, "no-heal-not-regressed");
  assert.equal(closedRow.extra.current_reviewer_code_sha, current);
  assert.deepEqual([closedRow.extra.k, closedRow.extra.n], [0, 1]);
  const today = health.todaysReviewerNotRegressed(liveShape().state, current);
  assert.equal(today.notRegressed, true);
  assert.deepEqual([today.judgment.k, today.judgment.n], [0, 1], "run 0 of 1 after the newest healthy sha");
  // Reopened by the same failure, it is a new incident: the closed one's heal record and escalation stay behind.
  const relapse = fake("live-relapse");
  h.queue.push(...[0, 1, 2, 3].map((i) => ({ ts: tick(), host: "core", step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable",
    reviewer_code_sha: relapse, pr_url: `${PULL}/${7000 + i}`, head_sha: fake(`relapse-head-${i}`) })));
  await h.evaluate(relapse);
  const reopened = h.load().incident!;
  assert.equal(reopened.reopenedFrom, incident.id);
  assert.equal(reopened.healedTree, undefined);
  assert.equal(reopened.conflictEscalatedAt, undefined);
  const before = h.escalations();
  await h.note(reopened, conflictAt(fake("main-after-reopen")));
  assert.equal(h.escalations(), before + 1, "once per incident: the reopened incident's conflict is its own");
});

test("W1-T13393: the no-heal close reads the revert PR and the operator heal, and an empty revert counts as no heal", async (t) => {
  const run = async (setup: (state: health.ReviewerHealthState) => void, lane: Partial<MainRepairLane> = {}) => {
    const h = harness(t, lane);
    const { state, current } = liveShape();
    state.incident!.healedTree = { ...conflictAt(current), at: tick() };
    setup(state);
    h.save(state);
    await h.evaluate(current);
    return h.load().closed.at(-1)?.closedReason ?? "open";
  };
  assert.equal(await run((s) => { s.incident!.healedTree = { state: "empty", originMainSha: fake("m"), reason: "reverted", paths: [], at: tick() }; }),
    "no-heal-not-regressed", "an empty revert: main already undid the blamed merge");
  assert.equal(await run((s) => { s.incident!.revertPrUrl = `${PULL}/900`; }, { readPr: async () => ({ state: "merged" }) }), "no-heal-not-regressed");
  assert.equal(await run((s) => { s.incident!.revertPrUrl = `${PULL}/900`; }, { readPr: async () => ({ state: "closed" }) }), "no-heal-not-regressed");
  assert.equal(await run((s) => { s.incident!.revertPrUrl = `${PULL}/900`; }, { readPr: async () => ({ state: "open" }) }), "open", "an open revert PR is a heal");
  assert.equal(await run((s) => { s.incident!.revertPrUrl = `${PULL}/900`; }, { readPr: async () => { throw new Error("HTTP 502"); } }), "open",
    "an unreadable revert PR may be open");
  assert.equal(await run((s) => { s.incident!.revertPrUrl = `${PULL}/900`; }), "open", "a lane that cannot read the PR leaves it open");
  assert.equal(await run((s) => { s.operatorHeal = { withPr: 4242, at: tick() }; }), "open", "the operator's fix PR is a heal");
  // Today's reviewer must have evidence of its own, and be neither healed nor regressed.
  assert.equal(health.todaysReviewerNotRegressed(liveShape().state, fake("never-seen")).notRegressed, false);
  const healed = liveShape();
  healed.state.shas[healed.current]!.healed = true;
  assert.equal(health.todaysReviewerNotRegressed(healed.state, healed.current).notRegressed, false);
  const silent = liveShape();
  silent.state.shas[silent.current]!.units = { [`${PULL}/1#${fake("silent")}`]: "withheld-failure" };
  assert.equal(health.todaysReviewerNotRegressed(silent.state, silent.current).notRegressed, false, "a sha with no counted outcome is no evidence");
});

/** The 10-20 storm: six reviewer code shas, five units each, every one refused or withheld; main moves on every failure. */
function stormRows(): Row[] {
  const rows: Row[] = [];
  let pr = 1000;
  for (let i = 0; i < 6; i++) {
    for (let u = 0; u < 5; u++) {
      pr += 1;
      const base = { ts: tick(), host: "h", pr_url: `${PULL}/${pr}`, head_sha: fake(`storm-head-${pr}`), reviewer_code_sha: fake(`storm-${i}`) };
      rows.push(u % 2 ? { ...base, step: "review.semantic_incomplete", reviewer_outcome: "success", reason: "required-semantic-incomplete-verdicts" }
        : { ...base, step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable" });
    }
  }
  return rows;
}

test("W1-T13393 criterion 3: The storm shape with a conflicting revert stays open (6 regressed, 0 closed): the close run keeps the regressed shas, and a revertable incident is untouched by this rule", async (t) => {
  const h = harness(t);
  h.save(pooledState());
  let checked = false;
  for (const row of stormRows()) {
    h.queue.push(row);
    await h.evaluate(String(row.reviewer_code_sha));
    const state = h.load();
    if (state.incident !== null && state.incident.healedTree === undefined) {
      // Its revert conflicts: the route's record, from the first evaluation after it opened.
      state.incident.healedTree = { ...conflictAt(String(row.reviewer_code_sha)), at: tick() };
      h.save(state);
    }
    const sixth = fake("storm-5");
    if (!checked && state.shas[sixth] !== undefined) {
      checked = true;
      // The 6th sha's first row: alone it is 1 of 1 and never regressed; its run, regressed shas kept, is the storm.
      assert.deepEqual([health.judgeReviewerSha(state, sixth).k, health.judgeReviewerSha(state, sixth).n], [1, 1]);
      assert.notEqual(health.judgeReviewerSha(state, sixth).state, "regressed");
      const today = health.todaysReviewerNotRegressed(state, sixth);
      assert.equal(today.notRegressed, false, "excluding the regressed shas would close it here, on k=1 n=1");
      assert.equal(today.judgment.state, "regressed");
      assert.deepEqual([today.judgment.k, today.judgment.n, today.judgment.run?.shas], [26, 26, 6]);
    }
  }
  assert.ok(checked);
  const final = h.load();
  assert.equal(Object.values(final.shas).filter((rec) => rec.regressedAt !== undefined).length, 6);
  assert.equal(h.steps("reviewer.regression_closed").length, 0);
  assert.notEqual(final.incident, null, "the storm stays open");
  assert.equal(final.incident!.healedTree?.state, "conflict");

  // A revertable incident: its revert PR is open, or its healed tree builds. Today's reviewer reads 0 of 1 and is not
  // regressed, yet neither closes: only the normal close (returnedToBaseline) can.
  for (const [label, setup, lane] of [
    ["revert PR open", (s: health.ReviewerHealthState) => { s.incident!.revertPrUrl = `${PULL}/900`; s.incident!.healedTree = { ...conflictAt(fake("x")), at: tick() }; },
      { readPr: async () => ({ state: "open" as const }) }],
    ["healed tree builds", (_s: health.ReviewerHealthState) => {}, {}],
  ] as const) {
    const r = harness(t, lane);
    const live = liveShape();
    setup(live.state);
    r.save(live.state);
    assert.equal(health.todaysReviewerNotRegressed(live.state, live.current).notRegressed, true);
    assert.equal((await r.evaluate(live.current)).route, "healed", label);
    assert.equal(r.load().incident?.id, live.incident.id, `${label}: untouched by the no-heal close`);
    assert.equal(r.steps("reviewer.regression_closed").length, 0);
  }
});

/** The 10-20 baseline the W1-T10269 and W1-T11448 suites use: twenty reviewer code shas then c0, five posted each. */
function baselineRows(c0: string): Row[] {
  const rows: Row[] = [];
  let pr = 1;
  const posted = (sha: string) => ({ ts: tick(), host: "core", step: "review.posted", state: "success", plan_only: false,
    pr_url: `${PULL}/${pr}`, head_sha: fake(`head-${pr++}`), reviewer_code_sha: sha });
  for (let i = 0; i < 20; i++) for (let j = 0; j < 5; j++) rows.push(posted(fake(`baseline-${i}`)));
  for (let j = 0; j < 5; j++) rows.push(posted(c0));
  return rows;
}
const onsetRows = (sha: string, firstPr: number): Row[] => Array.from({ length: 6 }, (_, i) => ({ ts: tick(), host: "core", pr_url: `${PULL}/${firstPr + i}`,
  head_sha: fake(`head-${firstPr + i}`), reviewer_code_sha: sha,
  ...(i < 4 ? { step: "review.semantic_incomplete", reason: "required-semantic-incomplete-verdicts", reviewer_outcome: "success" }
    : { step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable" }) }));
const shadowRows = (sha: string, firstPr: number, count: number): Row[] => Array.from({ length: count }, (_, i) => ({ ts: tick(), host: "core",
  step: "shadow.review.shadow_verdict", state: "success", plan_only: false, pr_url: `${PULL}/${firstPr + i}`, head_sha: fake(`head-${firstPr + i}`), reviewer_code_sha: sha }));

test("W1-T13393 criterion 4: invariant:a-healed-incident-keeps-its-route — an incident whose blamed merge still reverts cleanly, or whose current reviewer reads regressed, keeps its healed route, the healed-tree build, the normal fallback and returnedToBaseline exactly as on origin/main", async (t) => {
  health.resetHealedReviewerTrees();
  t.after(() => health.resetHealedReviewerTrees());
  // The healed-tree build: a blamed merge that reverts cleanly on origin/main builds, and clears any record.
  const root = scratch(t, "repos");
  const origin = gitRepo({ bare: true, kind: "13393-origin" });
  const work = gitRepo({ kind: "13393-work" });
  t.after(() => { work.cleanup(); origin.cleanup(); });
  mkdirSync(join(work.dir, "src/lib"), { recursive: true });
  writeFileSync(join(work.dir, "src/lib/required-semantic-review.ts"), "export const refusal = () => undefined;\n");
  work.git("add", "src/lib/required-semantic-review.ts");
  work.git("commit", "-q", "-m", "the healthy reviewer (#100)");
  writeFileSync(join(work.dir, "src/lib/required-semantic-review.ts"), 'export const refusal = () => "required-semantic-incomplete-verdicts";\n');
  work.git("commit", "-q", "-am", "fix(review): refuse incomplete required semantic evaluation (#102)");
  const blamed = work.git("rev-parse", "HEAD");
  work.addRemote("origin", origin.dir);
  work.git("push", "-q", "origin", "main");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "13393-daemon" });
  t.after(() => daemon.cleanup());
  const cut = (prefix: string, sha: string) => { const path = join(root, `${prefix}-${sha.slice(0, 12)}`); daemon.git("worktree", "add", "-q", "--detach", path, sha); return path; };
  const remove = (path: string) => { daemon.git("worktree", "remove", "--force", path); };
  const built = await health.buildHealedReviewerTree(daemon.dir, blamed, cut, remove);
  assert.equal(built.state, "ready", "the blamed merge reverts cleanly on origin/main");

  const h = harness(t);
  const live = liveShape();
  live.state.incident!.offending = { ...live.state.incident!.offending!, sha: blamed };
  live.state.incident!.healedTree = { ...conflictAt(fake("an-older-main")), at: tick() };
  h.save(live.state);
  await h.note(live.incident, built);
  assert.equal(h.load().incident?.healedTree, undefined, "a healed tree that builds is a heal in effect");
  const decision = await h.evaluate(live.current);
  assert.equal(decision.route, "healed", "the healed route is kept");
  assert.equal(decision.route === "healed" && decision.incident.offending?.sha, blamed);
  assert.equal(h.load().incident?.id, live.incident.id);
  // The normal fallback: an incident naming no offending merge routes normally, as on origin/main.
  const unblamed = harness(t);
  const none = liveShape();
  none.state.incident!.offending = null;
  unblamed.save(none.state);
  const normal = await unblamed.evaluate(none.current);
  assert.equal(normal.route, "normal");
  assert.equal(normal.reason, `incident ${none.incident.id} names no offending merge to revert`);

  // A current reviewer that reads regressed keeps the incident, conflict recorded or not.
  const regressed = harness(t);
  const storm = liveShape();
  storm.state.incident!.healedTree = { ...conflictAt(storm.current), at: tick() };
  regressed.save(storm.state);
  regressed.queue.push(...[0, 1, 2].map((i) => ({ ts: tick(), host: "core", step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable",
    reviewer_code_sha: storm.current, pr_url: `${PULL}/${8000 + i}`, head_sha: fake(`regressed-head-${i}`) })));
  assert.equal((await regressed.evaluate(storm.current)).route, "healed");
  assert.equal(regressed.load().incident?.id, storm.incident.id);
  assert.equal(regressed.steps("reviewer.regression_closed").length, 0);

  // returnedToBaseline exactly as on origin/main: the 10-20 incident (6 of 6, its own sample) closes on the 22nd clean
  // review at today's reviewer, the close point origin/main measures on these rows, with the normal close's reason.
  const close = async (clean: number): Promise<string | undefined> => {
    const r = harness(t);
    const c0 = fake("c0-close"), m2 = fake("m2-close"), fixed = fake("fixed-close");
    r.queue.push(...baselineRows(c0));
    await r.evaluate(c0);
    r.queue.push(...onsetRows(m2, 200));
    await r.evaluate(m2);
    assert.equal(r.load().incident?.regressedSha, m2);
    r.queue.push(...shadowRows(fixed, 300, clean));
    await r.evaluate(fixed);
    const closed = r.load().closed.at(-1);
    return closed === undefined ? undefined : closed.closedReason ?? "returned-to-baseline";
  };
  assert.equal(await close(21), undefined);
  assert.equal(await close(22), "returned-to-baseline");
});

test("W1-T13393: a sha that read regressed on its run is measured at the run's level, not its own thin sample", async (t) => {
  // A thin total outage: two refusals per sha while main moves; the run opens it, and each sha records its run.
  const h = harness(t);
  h.save(pooledState());
  const outage = [0, 1, 2].map((i) => fake(`thin-${i}`));
  let pr = 500;
  for (const sha of outage) {
    for (let u = 0; u < 2; u++) {
      h.queue.push({ ts: tick(), host: "h", step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable",
        reviewer_code_sha: sha, pr_url: `${PULL}/${pr}`, head_sha: fake(`thin-head-${pr++}`) });
      await h.evaluate(sha);
    }
  }
  const state = h.load();
  const incident = state.incident!;
  assert.ok(incident, "the run opens the thin outage");
  const newest = Object.values(state.shas).filter((rec) => rec.regressedAt !== undefined).sort((a, b) => b.seq - a.seq)[0]!;
  assert.ok(newest.regressedRun, "the newest regressed sha read regressed on its run");
  assert.ok(newest.regressedRun.n > health.shaCounts(newest).n, "its run is wider than its own sample");
  // The level a clean pool is measured against is the run's: count the fewest clean reviews that close it.
  const closesAt = (level: health.ReviewerHealthState): number => {
    const fixed = fake("thin-fixed");
    for (let clean = 1; clean <= 2000; clean++) {
      const s = structuredClone(level);
      s.shas[fixed] = shaRecord(fixed, s.seq + 1, clean, 0);
      if (health.returnedToBaseline(s, s.incident!, fixed).returned) return clean;
    }
    return -1;
  };
  const byRun = closesAt(state);
  const ownOnly = structuredClone(state);
  for (const rec of Object.values(ownOnly.shas)) delete rec.regressedRun;
  delete ownOnly.incident!.evidence.run;
  const byOwn = closesAt(ownOnly);
  assert.ok(byRun > 0, "a clean pool closes the run-opened incident");
  assert.ok(byOwn === -1 || byOwn > byRun, `the run's level closes sooner than the thin own sample (${byRun} vs ${byOwn})`);
  // A file written before W1-T13393 carries no run on its shas: the opening sha's evidence still names its run.
  const legacy = structuredClone(state);
  for (const rec of Object.values(legacy.shas)) delete rec.regressedRun;
  for (const rec of Object.values(legacy.shas)) if (rec.seq > legacy.incident!.regressedSeq) delete legacy.shas[rec.sha];
  assert.ok(legacy.incident!.evidence.run, "the incident opened on its run");
  const legacyOwn = structuredClone(legacy);
  delete legacyOwn.incident!.evidence.run;
  const [byEvidence, byOpeningSample] = [closesAt(legacy), closesAt(legacyOwn)];
  assert.ok(byEvidence > 0 && (byOpeningSample === -1 || byOpeningSample > byEvidence), `${byEvidence} vs ${byOpeningSample}`);
  // No regressed sha tracked at all: the incident's opening evidence is the level.
  const untracked = structuredClone(legacy);
  delete untracked.shas[untracked.incident!.regressedSha];
  assert.ok(closesAt(untracked) > 0);
});
