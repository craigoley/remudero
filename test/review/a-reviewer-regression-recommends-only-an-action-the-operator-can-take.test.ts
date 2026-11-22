/**
 * W1-T14351 — A REVIEWER REGRESSION RECOMMENDS ONLY AN ACTION THE OPERATOR CAN TAKE. With a healed-tree conflict the
 * escalation used to recommend "Heal with a fix PR": record the PR as `operatorHeal` in state/reviewer-health.json through
 * reviewerHealCommand, a verb no COMMANDS row or console route registers. #18909 carried that text for six days and the
 * garden's judge read the named symbol as proof the heal was applied (4 `resolved` verdicts on 2026-11-16). With the
 * conflict recorded, W1-T13393's close rule closes the incident by itself once today's reviewer is not regressed, so that
 * is the honest recommendation. Every effect is a recording fake; the states are built in the reviewer-health file's shape.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as health from "#src/lib/reviewer-health.js";
import type { Escalation } from "#src/lib/escalate.js";
import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import type { MainRepairLane } from "#src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type Row = Record<string, unknown>;
type ShaRecord = health.ReviewerShaRecord;
const fake = (seed: string): string => createHash("sha1").update(seed).digest("hex");
const PULL = "https://github.com/acme/remudero/pull";
const ISSUE = "https://github.com/acme/remudero/issues/18909";
let clock = Date.parse("2026-11-22T00:00:00.000Z");
const tick = (): string => new Date((clock += 1000)).toISOString();
const iso = { iso: () => new Date(clock).toISOString() };
const offender = fake("offending-12954");

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}W1-T14351-`));
  t.after(() => execFileSync("rm", ["-rf", dir]));
  return dir;
}

function shaRecord(sha: string, seq: number, posted: number, refused: number, regressedAt?: string): ShaRecord {
  const units: ShaRecord["units"] = {};
  for (let i = 0; i < posted; i++) units[`${PULL}/${seq * 100 + i}#${fake(`${sha}-p${i}`)}`] = "posted";
  for (let i = 0; i < refused; i++) units[`${PULL}/${seq * 100 + 50 + i}#${fake(`${sha}-r${i}`)}`] = "setup-refused";
  return { sha, seq, firstSeen: tick(), healed: false, units, reasons: refused > 0 ? { "head-task-metadata-unavailable": refused } : {},
    ...(regressedAt === undefined ? {} : { regressedAt }) };
}

/** The live #18909 shape: opened on one refusal in six, revert refused, healed tree conflicting, today's reviewer at 0 of 1. */
function liveShape(): { state: health.ReviewerHealthState; incident: health.ReviewerIncident; current: string } {
  const state = health.emptyReviewerHealthState();
  state.pooled = { k: 0, n: 5267, shas: 1475 };
  state.seq = 1475;
  state.seededAt = "2026-10-21T17:59:26.272Z";
  state.cursor = { liveOffset: 0 };
  const add = (rec: ShaRecord) => { state.shas[rec.sha] = rec; state.seq = rec.seq; return rec; };
  const onset = add(shaRecord(fake("live-onset"), 1476, 5, 1, "2026-10-21T17:59:25.101Z"));
  for (let i = 1; i < 6; i++) {
    add(shaRecord(fake(`live-regressed-${i}`), 1476 + 2 * i - 1, 0, 1, tick()));
    add(shaRecord(fake(`live-clean-${i}`), 1476 + 2 * i, 1, 0));
  }
  add(shaRecord(fake("live-newest-healthy"), state.seq + 1, 3, 0));
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
  return { state, incident, current };
}

const CONFLICT = { reason: "the revert does not apply cleanly on origin/main", paths: ["src/run-task.ts"] };

/** Everything an option or the recommendation can tell the operator to run or edit. */
const COMMAND_SHAPED = /reviewerHealCommand|operatorHeal|state\/|\brmd\b|reviewer-heal|--with-pr/;
const textOf = (e: Escalation): string[] => [...e.options.flatMap((o) => [o.label, o.detail]), e.recommendation];

test("W1-T14351 criterion 1: with a healed-tree conflict the escalation recommends an offered option that needs no host command, and names no heal verb, symbol or state path", () => {
  const { incident } = liveShape();
  const e = health.reviewerRegressionEscalation(incident, CONFLICT);
  const recommended = e.options.find((o) => o.label === e.recommendation);
  assert.ok(recommended, `the recommendation ${e.recommendation} is one of the offered options`);
  assert.notEqual(e.recommendation, "Heal with a fix PR");
  assert.ok(!e.options.some((o) => o.label === "Heal with a fix PR"), "the heal option is not offered while nothing registered records operatorHeal");
  for (const text of textOf(e)) assert.doesNotMatch(text, COMMAND_SHAPED, `no option text names a command or host file: ${text}`);
  assert.match(recommended.detail, /closes?/i, "the recommended option says the incident closes");
  assert.match(recommended.detail, /W1-T13393/, "and states the close rule it rests on");
  assert.match(recommended.detail, /not regressed/i);
  // The incident the escalation shows is one whose revert was refused, as in the live case.
  assert.ok(incident.revertRefused !== undefined);
  // The death of a healed child is the same escalation family: it never recommends the heal, or a close no rule grants it.
  const died = health.reviewerHealedChildDiedEscalation(incident, "SyntaxError: no export");
  assert.ok(died.options.some((o) => o.label === died.recommendation), "the death's recommendation is an offered option");
  for (const text of textOf(died)) assert.doesNotMatch(text, COMMAND_SHAPED, `the death names no command or host file: ${text}`);
  assert.doesNotMatch(died.recommendation, /close itself/i, "a ready healed tree clears the record the close rule reads, so no self-close is promised");
});

function harness(t: TestContext, lane: Partial<MainRepairLane> = {}) {
  const dir = scratch(t);
  const statePath = health.reviewerHealthStatePath(dir);
  const closed: Array<{ url: string; comment: string }> = [];
  const issues: AsyncIssueGateway = {
    create: async () => "https://github.com/acme/remudero/issues/20001",
    listOpen: async () => [],
    ensureLabel: async () => true,
    comment: async () => {},
    closeWithComment: async (url, comment) => { closed.push({ url, comment }); },
  };
  const repair: MainRepairLane = {
    openFixPr: async () => { throw new Error("a reviewer regression opens no fix PR"); },
    openRevertPr: async () => ({ refused: "the revert does not apply" }),
    closePr: async () => {},
    ...lane,
  };
  const escalation = { issues, ledgerPath: join(dir, "ledger.ndjson"), runId: "reviewer-health-14351" };
  const logs: Array<{ step: string; extra: Row }> = [];
  const log = (step: string, extra: Row = {}) => { logs.push({ step, extra }); };
  const readRows = async () => ({ rows: [] as Row[], cursor: { liveOffset: 0 } });
  const git: health.GitText = async (args) => { throw new Error(`no git in this fixture: ${args[0]}`); };
  const evaluate = (originMainSha: string | null) =>
    health.evaluateReviewerHealthNow({ originMainSha, readEvidenceJson: async () => [] }, statePath, readRows, git, escalation, repair, log, iso);
  return { statePath, closed, logs, evaluate, load: () => health.loadReviewerHealthState(statePath),
    save: (state: health.ReviewerHealthState) => health.saveReviewerHealthState(statePath, state) };
}

test("W1-T14351 criterion 2: the recommended close is true of the code — the live shape closes the incident and its issue on the next evaluation", async (t) => {
  health.resetHealedReviewerTrees();
  t.after(() => health.resetHealedReviewerTrees());
  const h = harness(t);
  const { state, incident, current } = liveShape();
  // The state the escalation was raised from: a conflict recorded, no revert PR, no operatorHeal.
  state.incident!.healedTree = { state: "conflict", originMainSha: current, reason: CONFLICT.reason, paths: [...CONFLICT.paths], at: tick() };
  assert.equal(state.operatorHeal, null);
  assert.equal(state.incident!.revertPrUrl, undefined);
  const e = health.reviewerRegressionEscalation(incident, CONFLICT);
  assert.equal(e.recommendation, "Let the incident close itself", "the recommendation is the self-close this evaluation then performs");
  h.save(state);
  const decision = await h.evaluate(current);
  assert.equal(decision.route, "normal");
  const after = h.load();
  assert.equal(after.incident, null, "the incident closes on the next evaluation");
  assert.equal(after.closed.at(-1)?.id, incident.id);
  assert.equal(after.closed.at(-1)?.closedReason, "no-heal-not-regressed");
  assert.equal(h.closed.length, 1, "and so does its issue");
  assert.equal(h.closed[0]!.url, ISSUE);
  // The same state with the operator's heal in effect stays open: the self-close is offered only where it is true.
  const held = liveShape();
  held.state.incident!.healedTree = { state: "conflict", originMainSha: held.current, reason: CONFLICT.reason, paths: [...CONFLICT.paths], at: tick() };
  held.state.operatorHeal = { withPr: 4242, at: tick() };
  const h2 = harness(t);
  h2.save(held.state);
  await h2.evaluate(held.current);
  assert.equal(h2.load().incident?.id, held.incident.id, "an operatorHeal in the state file keeps the incident open");
  assert.equal(h2.closed.length, 0);
});

/** origin/main's no-conflict escalation, verbatim (d32ffeb1c0), for the incident liveShape builds. */
function mainsRevertableEscalation(incident: health.ReviewerIncident): Escalation {
  return {
    class: "BLOCKED",
    taskId: incident.id,
    summary: `Reviewer regression: reviewer code ${incident.regressedSha.slice(0, 12)} departed from its own history`,
    detail: [
      health.reviewerRegressionEvidenceText(incident),
      "",
      "Reviews now run from origin/main with the offending merge reverted on top (W1-T228 reads that tree fresh), and a revert PR goes through ordinary CI, review and branch protection.",
    ].join("\n"),
    options: [
      { label: "Let the revert PR merge", detail: "Its review runs on the healed tree; the incident closes once the reviewer's outcomes return to baseline.", kind: { type: "operator-only" } },
      { label: "Heal with a fix PR", detail: "Record the fix PR as `operatorHeal` in state/reviewer-health.json (reviewerHealCommand) to review from origin/main merged with it instead of the revert of #12954.", kind: { type: "operator-only" } },
      { label: "Close as a false alarm", detail: "Close this issue and the revert PR; the detector keeps measuring and closes the incident itself once the reviewer reads healthy.", kind: { type: "operator-only" } },
    ],
    recommendation: "Let the revert PR merge",
    headDedup: "independent",
    consequence: "Reviews keep running from the healed tree until the incident closes; nothing merges without review.",
  };
}

test("W1-T14351 criterion 3: invariant:a-revertable-incident-escalates-as-today — no conflict, the escalation is origin/main's; operatorHeal and reviewerHealCommand are unchanged", async (t) => {
  const { incident } = liveShape();
  assert.deepEqual(health.reviewerRegressionEscalation(incident), mainsRevertableEscalation(incident));
  const noPr = { ...incident, offending: { ...incident.offending!, pr: null } };
  assert.match(health.reviewerRegressionEscalation(noPr).options[1]!.detail, /instead of the revert\.$/);
  // reviewerHealCommand records and clears operatorHeal exactly as before.
  const dir = scratch(t);
  const statePath = health.reviewerHealthStatePath(dir);
  const out: string[] = [];
  const heal = (rest: string[]) => health.reviewerHealCommand(rest, statePath, iso, (l) => out.push(l), (l) => out.push(l));
  assert.equal(heal(["--with-pr", "4242"]), 0);
  assert.equal(health.loadReviewerHealthState(statePath).operatorHeal?.withPr, 4242);
  assert.equal(heal(["--clear"]), 0);
  assert.equal(health.loadReviewerHealthState(statePath).operatorHeal, null);
  // An operatorHeal already in the state file still routes reviews through the heal (withPr).
  const h = harness(t);
  const live = liveShape();
  live.state.operatorHeal = { withPr: 4242, at: tick() };
  h.save(live.state);
  const decision = await h.evaluate(live.current);
  assert.equal(decision.route, "healed");
  assert.equal(decision.route === "healed" ? decision.withPr : null, 4242);
});
