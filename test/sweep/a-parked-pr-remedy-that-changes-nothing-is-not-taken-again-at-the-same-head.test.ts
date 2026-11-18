import assert from "node:assert/strict";
import { test } from "node:test";

import type { OpenIssue } from "#src/lib/escalate.js";
import { actOnParkedPr, PARKED_PR_REMEDY_STEP, parkedPrRemedy, parkedPrUnchanged, type ParkedPrFacts, type ParkedPrHost,
  type ParkedPrSubject } from "#src/lib/parked-pr-remedy.js";
import { DEFAULT_SWEEP_POLICY, prBodyDigest, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";

// W1-T13361: three plan filings sat red for hours while the sweep wrote `parked_pr.remedy` outcome "taken" about 25 times
// each ("a plan-scoped round acts on 0 unmet criteria and 1 red checks on the pull request") and about 130 `sweep.disposed`
// wait rows, at one head, one body and one red check. No issue was opened. For a plan filing the fix-on-pr remedy is a
// wait: it dispatches nothing, so a pull request it did not move stays where it is on every later pass.

const PR = 13361, PR_URL = `https://github.com/o/r/pull/${PR}`;
const HEAD = "a".repeat(40), PUSHED = "b".repeat(40);
const NOW = Date.parse("2026-11-17T12:00:00Z");
const GATE = "acceptance-author-gate", REFUSAL = "the body carries no Acceptance block";
const BODY = "A plan filing.\n", EDITED = "A plan filing, edited.\n";
/** origin/main's judgment of a red plan filing no plan-scoped round can take: the remedy's first take. */
const MAIN_REASON = /^parked-pr remedy fix-on-pr \(W1-T12709\): a plan-scoped round acts on 0 unmet criteria and 1 red checks on the pull request; it replaces: plan-only PR is red on /;

function filing(over: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber: PR, prUrl: PR_URL, taskId: undefined, headSha: HEAD, headRefName: "plan-filing-13361", isPlanFiling: true,
    autoMergeArmed: false, priorStrikes: 0, lastActivityAt: new Date(NOW).toISOString(), checksState: "red", reviewState: "pending",
    unmetCriteria: [], body: BODY, ciFailures: [{ name: GATE, logTail: "acceptance: block", statusDescription: REFUSAL }], ...over } as OpenPrView;
}

function parkedHost() {
  const landed: string[][] = [], closed: string[] = [];
  const host: ParkedPrHost = {
    planFilingTarget: { owner: "o", repo: "r", checkoutDir: "/unused" },
    readTaskShard: async () => ({ outcome: "refused", reason: "task-absent" }),
    reserveTaskId: () => "W1-T913361",
    landTaskFiles: async (files) => { landed.push(files.map(f => f.relPath)); return { prUrl: "https://github.com/o/r/pull/99" }; },
    closePr: async (prUrl) => { closed.push(prUrl); },
  };
  return { host, landed, closed };
}

function fixture(over: Partial<SweepDeps> = {}) {
  const rows: Record<string, unknown>[] = [];
  const asked: string[] = [];
  const open: OpenIssue[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/w1-t13361", runId: "w1-t13361", now: () => NOW, readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); }, arm: () => {}, close: () => {}, dispatchFix: () => {},
    escalate: (pr, reason) => {
      asked.push(reason);
      open.push({ number: asked.length, title: "[BLOCKED] clarification", url: `https://github.com/o/r/issues/${asked.length}`,
        body: `**Task:** PR-${pr.prNumber}\n**Class:** BLOCKED\n${pr.prUrl}\n**Head:** ${pr.headSha}\n**Cause:** ci\n` });
    },
    parkedPr: parkedHost().host, ...over,
  };
  const remedyRows = () => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP);
  return { rows, asked, open, deps,
    pass: (pr: OpenPrView = filing()) => runSweep([pr], deps, DEFAULT_SWEEP_POLICY),
    taken: () => remedyRows().filter(r => r.outcome === "taken"),
    markers: () => remedyRows().filter(r => r.needs_human === true),
    refused: () => remedyRows().filter(r => r.outcome === "refused" && r.needs_human !== true),
    disposed: () => rows.filter(r => r.step === "sweep.disposed"),
    /** What a rotation does to the live file: `parked_pr.remedy` is not a retained step, so its rows leave it. */
    dropRemedyRows: () => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.step === PARKED_PR_REMEDY_STEP) rows.splice(i, 1); } };
}

const judged = (row: Record<string, unknown> | undefined) => [row?.disposition, row?.blocker, row?.acted, row?.reason];
const state = (row: Record<string, unknown> | undefined) => [row?.remedy, row?.cause, row?.outcome, row?.head_sha, row?.body_digest, row?.red_checks, row?.reason];

test("W1-T13361 criterion 1: a fix-on-pr that left the head, the body and the red checks unchanged is not taken again, and with no remedy left one needs-human issue names the red check and the remedies tried", async () => {
  const f = fixture();
  await f.pass();
  assert.deepEqual(f.taken().map(state), [["fix-on-pr", "plan-gate", "taken", HEAD, prBodyDigest(BODY), [GATE],
    "a plan-scoped round acts on 0 unmet criteria and 1 red checks on the pull request"]], "the row records the head, the body digest and the red checks");
  assert.equal(f.asked.length, 0, "the first pass takes the remedy and opens no issue");
  const taken = f.disposed().at(-1)!;
  assert.deepEqual([taken.disposition, taken.acted], ["wait", false], "the remedy is a wait: nothing is dispatched");
  assert.match(String(taken.reason), MAIN_REASON);

  await f.pass();
  assert.equal(f.taken().length, 1, "the remedy is not taken again at the same head, body and red checks");
  assert.equal(f.asked.length, 1, "no remedy is left in the ladder, so one needs-human issue is opened");
  const issue = f.asked[0]!;
  assert.match(issue, new RegExp(`Red checks: ${GATE} \\(${REFUSAL}\\)`), "the issue names the red check and its refusal line");
  assert.match(issue, /Remedies tried: 1 x fix-on-pr/, "the issue names the remedies tried and their count");
  assert.match(issue, /^plan-only PR is red on acceptance-author-gate/, "the issue carries the text the remedy replaced");
  assert.match(issue, new RegExp(`head ${HEAD.slice(0, 7)}`));
  const row = f.disposed().at(-1)!;
  assert.deepEqual([row.disposition, row.blocker, row.acted], ["wait", taken.blocker, false],
    "the pull request keeps its wait and its blocker, and is never refused-escalate (W1-T12709)");
  assert.match(String(row.reason), /left the head, the body and the red checks unchanged, so it is not taken again \(W1-T13361\)/);
  assert.match(String(row.reason), /one needs-human issue is opened/);
  assert.deepEqual(f.markers().map(r => [r.remedy, r.outcome, r.head_sha, r.body_digest, r.red_checks]),
    [["fix-on-pr", "refused", HEAD, prBodyDigest(BODY), [GATE]]], "one row records that the remedy was refused and a person asked");
});

test("W1-T13361 criterion 1: a red check with no refusal line is named alone, and a body the pass could not read compares as itself", async () => {
  const f = fixture();
  const bare = filing({ body: undefined, ciFailures: [{ name: "lint-plan", logTail: "task-linter: block" }] });
  await f.pass(bare);
  await f.pass(bare);
  assert.equal(f.taken().length, 1);
  assert.equal(f.taken()[0]!.body_digest, undefined);
  assert.equal(f.asked.length, 1);
  assert.match(f.asked[0]!, /Red checks: lint-plan\. Remedies tried: 1 x fix-on-pr/);
});

test("W1-T13361 criterion 1: the ladder skips a remedy that left the pull request unchanged and takes the next one it names", async () => {
  const needsInput = { claim: "a criterion that needs a design answer", needsInput: true };
  const red: ParkedPrFacts = { unmetCriteria: [], redChecks: [GATE], isPlanFiling: true };
  const unanswered: ParkedPrFacts = { unmetCriteria: [{ ...needsInput, ladderSpent: false }], redChecks: [], isPlanFiling: true };
  const splittable: ParkedPrFacts = { unmetCriteria: [{ ...needsInput, ladderSpent: true }], redChecks: [], isPlanFiling: false, taskCriteria: 3 };
  const held: ParkedPrFacts = { ...red, designHoldChecks: [GATE] };
  for (const facts of [red, unanswered, splittable, held]) {
    assert.deepEqual(parkedPrRemedy(facts, []), parkedPrRemedy(facts), "with nothing spent the ladder names its first remedy, as before");
  }
  assert.equal(parkedPrRemedy(red).remedy, "fix-on-pr");
  assert.equal(parkedPrRemedy(red, ["fix-on-pr"]), undefined, "a red check on a plan filing has no remedy after fix-on-pr");
  assert.equal(parkedPrRemedy(unanswered).remedy, "fix-on-pr");
  assert.equal(parkedPrRemedy(unanswered, ["fix-on-pr"]), undefined, "a criterion that has not had the stall remedies is never closed");
  assert.equal(parkedPrRemedy(splittable).remedy, "split-follow-up");
  assert.equal(parkedPrRemedy(splittable, ["split-follow-up"])?.remedy, "close-and-rebuild", "after a spent split the ladder names the rebuild");
  assert.equal(parkedPrRemedy(splittable, ["split-follow-up", "close-and-rebuild"])?.remedy, "fix-on-pr");
  assert.equal(parkedPrRemedy(splittable, ["split-follow-up", "close-and-rebuild", "fix-on-pr"]), undefined);
  assert.equal(parkedPrRemedy(held).remedy, "close-and-rebuild");
  assert.equal(parkedPrRemedy(held, ["fix-on-pr"])?.remedy, "close-and-rebuild");

  // The sweep's own decision for `held` is the rebuild. A fix-on-pr decision is passed here to show that a remedy which
  // left the pull request unchanged is skipped for the ladder's next rung, and that no issue is opened while one is left.
  const { host, landed, closed } = parkedHost();
  const rows: Record<string, unknown>[] = [{ step: PARKED_PR_REMEDY_STEP, pr_number: PR, head_sha: HEAD, cause: "plan-gate", remedy: "fix-on-pr",
    outcome: "taken", body_digest: prBodyDigest(BODY), red_checks: [GATE] }];
  const asked: string[] = [];
  const subject: ParkedPrSubject = { prNumber: PR, prUrl: PR_URL, headSha: HEAD, isPlanFiling: true, unmetCriteria: [],
    planFiles: ["plan/tasks.d/W1-T900001-a-fixture.yaml"] };
  const out = await actOnParkedPr(subject, { remedy: "fix-on-pr", reason: "a plan-scoped round", inputCriteria: [] }, held, rows, host,
    { runId: "w1-t13361", ledgerTaskId: `PR-${PR}`, nowIso: new Date(NOW).toISOString(), cause: "plan-gate", text: "plan-only PR is red",
      append: (row) => { rows.push(row); },
      observed: { bodyDigest: prBodyDigest(BODY), redChecks: [GATE], refusalLine: () => undefined,
        escalate: (text) => { asked.push(text); }, issueOpen: () => false } });
  assert.equal(out.remedy, "close-and-rebuild", "the next remedy in the ladder is taken");
  assert.deepEqual([out.disposition, out.blocker], ["wait", "other"]);
  assert.equal(out.heldTaskId, "W1-T913361");
  assert.deepEqual([landed.length, closed], [1, [PR_URL]]);
  assert.deepEqual(asked, [], "no needs-human issue is opened while the ladder names a remedy");
  assert.deepEqual(rows.filter(r => r.outcome === "taken").map(r => r.remedy), ["fix-on-pr", "close-and-rebuild"]);
});

test("W1-T13361 criterion 2: the issue is opened once per head and body, and a new head or a new body starts the ladder again", async () => {
  const f = fixture();
  for (let pass = 0; pass < 5; pass++) await f.pass();
  assert.equal(f.asked.length, 1, "five passes at one head and body open one issue");
  assert.equal(f.taken().length, 1);
  assert.equal(f.markers().length, 1);
  assert.match(String(f.disposed().at(-1)!.reason), /one needs-human issue was opened for this head and body/);

  const edited = filing({ body: EDITED });
  await f.pass(edited);
  assert.equal(f.asked.length, 1, "a new body starts the ladder again: the remedy is taken, and no issue is opened on that pass");
  assert.deepEqual(f.taken().map(r => [r.head_sha, r.body_digest]), [[HEAD, prBodyDigest(BODY)], [HEAD, prBodyDigest(EDITED)]]);
  assert.match(String(f.disposed().at(-1)!.reason), MAIN_REASON);
  for (let pass = 0; pass < 3; pass++) await f.pass(edited);
  assert.equal(f.asked.length, 2, "the edited body, unchanged in turn, is asked about once");

  const pushed = filing({ headSha: PUSHED, body: EDITED });
  await f.pass(pushed);
  assert.equal(f.asked.length, 2, "a new head starts the ladder again");
  assert.equal(f.taken().at(-1)!.head_sha, PUSHED);
  assert.match(String(f.disposed().at(-1)!.reason), MAIN_REASON);
  for (let pass = 0; pass < 3; pass++) await f.pass(pushed);
  assert.equal(f.asked.length, 3);
  assert.deepEqual(f.markers().map(r => [r.head_sha, r.body_digest]),
    [[HEAD, prBodyDigest(BODY)], [HEAD, prBodyDigest(EDITED)], [PUSHED, prBodyDigest(EDITED)]], "one issue for each head and body");
  assert.equal(f.taken().length, 3, "each remedy is taken once for its head and body");
});

test("W1-T13361 criterion 2: a rotation that drops the remedy rows opens no second issue while the first one is open at this head", async () => {
  const lost = fixture();
  for (let pass = 0; pass < 2; pass++) await lost.pass();
  lost.dropRemedyRows();
  for (let pass = 0; pass < 3; pass++) await lost.pass();
  assert.equal(lost.asked.length, 2, "with no open-issue read the ledger is the only record, and a rotation loses it");

  const f = fixture();
  f.deps.readOpenEscalations = () => f.open;
  for (let pass = 0; pass < 2; pass++) await f.pass();
  assert.equal(f.asked.length, 1);
  for (let round = 0; round < 3; round++) {
    f.dropRemedyRows();
    for (let pass = 0; pass < 3; pass++) await f.pass();
  }
  assert.equal(f.asked.length, 1, "the open issue names this head, so it is not asked again");
  assert.equal(f.markers().length, 1, "the row is written again, so a later pass reads the ledger and not GitHub");
  assert.match(String(f.markers()[0]!.reason), /an open needs-human issue already names this head, so no second one is opened$/);
  assert.match(String(f.disposed().at(-1)!.reason), /one needs-human issue was opened for this head and body/);

  const other = fixture();
  other.deps.readOpenEscalations = () => [{ ...f.open[0]!, body: f.open[0]!.body!.replace(HEAD, PUSHED) }];
  for (let pass = 0; pass < 2; pass++) await other.pass();
  assert.equal(other.asked.length, 1, "an open issue that names another head does not stand for this one");
});

test("W1-T13361 criterion 2: light passes and rotations between two full passes neither hide the issue nor open a second one", async () => {
  // The live shape: full passes are many minutes apart, light passes run between them, and a rotation drops the remedy rows
  // more often than a full pass comes round.
  const f = fixture();
  f.deps.readOpenEscalations = () => f.open;
  const light = () => { f.deps.actionable = () => false; return f.pass(); };
  const full = () => { f.deps.actionable = undefined; return f.pass(); };
  await full();
  f.dropRemedyRows();
  await full();
  assert.equal(f.asked.length, 0, "a full pass that is the first after a rotation finds no row, and takes the remedy");
  await light();
  await light();
  assert.equal(f.asked.length, 0);
  assert.equal(f.taken().length, 1, "the light passes find the row and do not take the remedy again");
  await full();
  assert.equal(f.asked.length, 1, "the next full pass that finds the row opens the issue");
  for (let round = 0; round < 4; round++) {
    f.dropRemedyRows();
    await light();
    await light();
    await full();
    await full();
  }
  assert.equal(f.asked.length, 1, "four more rotations open no second issue");
});

test("W1-T13361 criterion 2: an issue that could not be opened is tried again on the next pass, and is then opened once", async () => {
  let down = true;
  const f = fixture();
  const opens = f.deps.escalate;
  f.deps.escalate = (pr, reason, question) => {
    if (down) throw new Error("gh is unreachable");
    return opens(pr, reason, question);
  };
  for (let pass = 0; pass < 3; pass++) await f.pass();
  assert.equal(f.asked.length, 0);
  assert.equal(f.markers().length, 0, "no row says a person was asked");
  assert.deepEqual(f.refused().map(r => r.reason), Array(2).fill("the needs-human issue could not be opened: gh is unreachable"));
  assert.match(String(f.disposed().at(-1)!.reason), /the needs-human issue could not be opened, and the next pass tries it again: gh is unreachable/);
  assert.equal(f.disposed().length, 3, "a refused escalation never ends the pass");
  down = false;
  for (let pass = 0; pass < 3; pass++) await f.pass();
  assert.equal(f.asked.length, 1);
  assert.equal(f.markers().length, 1);
});

test("W1-T13361 criterion 3: invariant:a-remedy-that-moved-the-pr-is-unaffected, a remedy after which the head, the body or the red checks changed is judged as on origin/main", async () => {
  const moves: [string, OpenPrView][] = [
    ["the head", filing({ headSha: PUSHED })],
    ["the body", filing({ body: EDITED })],
    ["the red checks", filing({ ciFailures: [{ name: "lint-plan", logTail: "task-linter: block" }] })],
    ["a second red check", filing({ ciFailures: [{ name: GATE, logTail: "acceptance: block", statusDescription: REFUSAL },
      { name: "lint-plan", logTail: "task-linter: block" }] })],
  ];
  for (const [what, moved] of moves) {
    // origin/main judges a pull request the remedy moved as it judges the remedy's first take: fix-on-pr, and a wait.
    const first = fixture();
    await first.pass(moved);
    const f = fixture();
    await f.pass();
    await f.pass(moved);
    assert.deepEqual(judged(f.disposed().at(-1)), judged(first.disposed().at(-1)), `${what} changed: the judgment is the first take's`);
    assert.deepEqual([f.disposed().at(-1)!.disposition, f.disposed().at(-1)!.acted], ["wait", false], what);
    assert.match(String(f.disposed().at(-1)!.reason),
      /^parked-pr remedy fix-on-pr \(W1-T12709\): a plan-scoped round acts on 0 unmet criteria and \d red checks on the pull request; it replaces: plan-only PR is red on /, what);
    assert.equal(f.asked.length, 0, `${what} changed: no issue is opened`);
    assert.deepEqual(state(f.taken().at(-1)), state(first.taken().at(-1)), `${what} changed: the remedy is taken and its row records the new state`);
    assert.equal(f.taken().length, 2, what);
    assert.equal(f.markers().length + f.refused().length, 0, what);
  }
  const row = { step: PARKED_PR_REMEDY_STEP, pr_number: PR, head_sha: HEAD, cause: "plan-gate", remedy: "fix-on-pr", outcome: "taken",
    body_digest: "body", red_checks: ["b", "a"] };
  const pr = { prNumber: PR, headSha: HEAD };
  const same = { bodyDigest: "body", redChecks: ["a", "b"] };
  assert.equal(parkedPrUnchanged([row], pr, "plan-gate", same), true, "the red checks compare as a set");
  assert.equal(parkedPrUnchanged([row], { ...pr, headSha: PUSHED }, "plan-gate", same), false);
  assert.equal(parkedPrUnchanged([row], pr, "plan-gate", { ...same, bodyDigest: "edited" }), false);
  assert.equal(parkedPrUnchanged([row], pr, "plan-gate", { ...same, redChecks: ["a"] }), false);
  assert.equal(parkedPrUnchanged([row], pr, "needs-design", same), false, "another cause is another parking");
  assert.equal(parkedPrUnchanged([row], { ...pr, prNumber: PR + 1 }, "plan-gate", same), false);
  assert.equal(parkedPrUnchanged([{ ...row, outcome: "refused" }], pr, "plan-gate", same), false);
  assert.equal(parkedPrUnchanged([row, { ...row, head_sha: PUSHED }], pr, "plan-gate", same), false, "only the last taken row is compared");
  const { red_checks: _unrecorded, ...legacy } = row;
  assert.equal(parkedPrUnchanged([legacy], pr, "plan-gate", same), false, "a row that recorded no red checks proves nothing");
});

test("W1-T13361 criterion 3: a row written before the state was recorded is not read as an unchanged pull request", async () => {
  const f = fixture();
  f.rows.push({ step: PARKED_PR_REMEDY_STEP, pr_number: PR, head_sha: HEAD, cause: "plan-gate", remedy: "fix-on-pr", outcome: "taken" });
  await f.pass();
  assert.equal(f.asked.length, 0);
  assert.equal(f.taken().length, 2, "the remedy is taken, and its row records the state");
  assert.match(String(f.disposed().at(-1)!.reason), MAIN_REASON);
  await f.pass();
  assert.equal(f.asked.length, 1);
});

test("W1-T13361: a fix-on-pr that hands the pull request to the fix lane, and a pass that may not escalate, are judged as before", async () => {
  // A fix round is the fix lane's to bound (its dedup, its stand-down hold, its strike ladder): the same head on the
  // next pass means a round is running or was refused, not that the remedy did nothing.
  const claim = "the second criterion needs a design answer";
  const refused = filing({ taskId: "W1-T13361-FIXTURE", headRefName: "run-W1-T13361-FIXTURE-1", isPlanFiling: undefined, body: undefined, checksState: "green",
    reviewState: "failure", ciFailures: undefined, unmetCriteria: [{ claim, proof: `grep: ${claim} in src/x.ts`, met: false,
      reason: "the worker refused it", proof_exec: "executed_fail", refusal: { class: "premise-rotted", detail: "the premise moved" } }] as OpenPrView["unmetCriteria"] });
  const dispatched: unknown[] = [];
  const lane = fixture({ dispatchFix: (_pr, evidence) => { dispatched.push(evidence); }, fixProgressJudge: async () => ({ verdict: "continue", reason: "another round" }) });
  for (let pass = 0; pass < 3; pass++) await lane.pass(refused);
  assert.equal(dispatched.length, 3, "each pass dispatches, as on origin/main: this fixture's fix lane writes no row for the next pass to dedup on");
  assert.equal(lane.asked.length, 0, "no issue is opened for a remedy that dispatched a fix round");
  assert.deepEqual(lane.taken().map(r => [r.remedy, r.head_sha]), [["fix-on-pr", HEAD]]);
  assert.equal(lane.markers().length + lane.refused().length, 0);
  assert.deepEqual(lane.disposed().map(r => [r.disposition, r.acted]), Array(3).fill(["blocked-fixable", true]));

  // A light pass may not escalate (W1-T254). It records and compares as a full pass does, keeps the wait, and leaves
  // the issue to the next pass that may escalate.
  const light = fixture({ actionable: () => false });
  for (let pass = 0; pass < 3; pass++) await light.pass();
  assert.equal(light.asked.length, 0, "a light pass opens no issue");
  assert.deepEqual(light.taken().map(r => [r.head_sha, r.red_checks]), [[HEAD, [GATE]]], "it takes the remedy once");
  assert.equal(light.markers().length + light.refused().length, 0, "and writes no row for an issue it did not open");
  assert.deepEqual(light.disposed().map(r => [r.disposition, r.acted]), Array(3).fill(["wait", false]));
  assert.match(String(light.disposed()[0]!.reason), MAIN_REASON);
  assert.match(String(light.disposed().at(-1)!.reason), /no remedy is left; the needs-human issue waits for a pass that may escalate/);
  light.deps.actionable = undefined;
  await light.pass();
  assert.equal(light.asked.length, 1, "the next full pass opens it");
});
