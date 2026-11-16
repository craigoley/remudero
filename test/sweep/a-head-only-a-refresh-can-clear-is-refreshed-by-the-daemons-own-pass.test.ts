/**
 * W1-T12945 — A HEAD ONLY A BRANCH REFRESH CAN CLEAR IS REFRESHED BY THE DAEMON'S OWN PASS.
 *
 * Core ledger, 2026-11-15: #18582 (a build head cut before its own task record merged) and #18705 (held as
 * base-red after main turned green) each waited on a refresh the light pass named and could not press, until a
 * person refreshed them. The light pass's per-PR fan-out carries no `updateBranch` (W1-T528), so W1-T9232's refresh
 * read "the branch refresh is unwired — escalating" and the base-red hold read "unwired on this surface (light pass)".
 *
 * The hook tests drive the real `buildSweepLightHook`, the production light-pass composition, over an in-memory
 * ledger and effect fakes. `updateBranch` is on the hook's effects alone, as in production.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Plan } from "#src/lib/plan.js";
import {
  BASE_FIXED_REFRESH_STEP,
  BASE_RED_REFRESH_ADMISSION_STEP,
  BASE_RED_REFRESH_STEP,
  BASE_RED_STOOD_DOWN_STEP,
  DEFAULT_SWEEP_POLICY,
  OWN_TASK_RECORD_MISSING_CAUSE,
  OWN_TASK_RECORD_REFRESH_STEP,
  REFRESH_ADMISSION_FORCED_BY,
  runLightPassRefreshAdmission,
  runSweepLightPass,
  type OpenPrView,
  type SweepDeps,
  type UpdateBranchOutcome,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildSweepLightHook } from "#test/helpers/run-task-test.js";

const NO_PLAN: Plan = { tasks: [], byId: new Map() };
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const MAIN = "c".repeat(40);
const CHECK = "test-slow-shard (2/4)";
const FILE = "test/sweep/a-suite-main-broke.test.ts";
// The ledger contract this task adds, spelled out: the disposition field and the cause a base-red hand-off names.
const HANDOFF_FIELD = "refresh_handoff";
const BASE_RED_CAUSE = "base-red-main-green";
const WAITS_FOR_ADMISSION = "the branch refresh waits for the light pass's refresh admission";
type Row = Record<string, unknown>;

/** #18582's shape: checks green, the review pending after it skipped for the head's missing task record. */
function ownRecordPr(prNumber: number, head = "a", over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`, reviewState: "pending", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, headSha: head.repeat(40), headRefName: `run-W1-T${prNumber}-1794000000000`, autoMergeArmed: false,
    mergeState: "clean", createdAt: ago(120), lastActivityAt: ago(2), reviewPendingSince: ago(2), changedFiles: ["src/subject.ts"], ...over,
  };
}

/** #18705's shape: one required shard red, held while main was red. */
function baseRedPr(prNumber: number, head = "b", over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`, reviewState: "pending", checksState: "red",
    unmetCriteria: [], priorStrikes: 0, headSha: head.repeat(40), headRefName: `run-W1-T${prNumber}-1794000000000`, autoMergeArmed: false,
    mergeState: "clean", createdAt: ago(120), lastActivityAt: ago(80), changedFiles: ["src/subject.ts"],
    ciFailures: [{ name: CHECK, logTail: `not ok 1 - ${FILE}`, conclusion: "FAILURE" }], ...over,
  };
}

const mainRow = (state: "green" | "red", minutesAgo: number): Row =>
  ({ step: "main.health.observed", ts: ago(minutesAgo), sha: MAIN, state, failing_checks: state === "red" ? [CHECK] : [] });
const skipRow = (pr: OpenPrView, minutesAgo: number): Row =>
  ({ step: "review.reviewer.skipped", ts: ago(minutesAgo), run_id: `review-PR${pr.prNumber}-1`, task_id: pr.taskId, lane: "review",
    reason: OWN_TASK_RECORD_MISSING_CAUSE, pr_number: pr.prNumber, pr_url: pr.prUrl, head_sha: pr.headSha });
const stoodDownRow = (pr: OpenPrView, minutesAgo: number): Row =>
  ({ step: BASE_RED_STOOD_DOWN_STEP, ts: ago(minutesAgo), pr_number: pr.prNumber, pr_url: pr.prUrl, head_sha: pr.headSha,
    check_name: CHECK, main_sha: "d".repeat(40) });
/** One row of every refresh step, older than each fixture PR: the live ledger then covers the PR's whole life, so its
 *  refresh history is readable without an archive (W1-T8533). */
const liveHistory = (): Row[] => ["fix.base_refreshed", BASE_RED_REFRESH_STEP, BASE_FIXED_REFRESH_STEP, "refresh.clearance"]
  .map((step) => ({ step, ts: ago(600), pr_number: 1, head_sha: "0".repeat(40) }));

function fixture(rows: Row[], over: Partial<SweepDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12945-`));
  const logs: Row[] = [];
  const pressed: string[] = [];
  const escalated: number[] = [];
  const dispatched: number[] = [];
  const outcomes = new Map<number, UpdateBranchOutcome | Error>();
  let views: OpenPrView[] = [];
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T12945", readLedger: () => [...rows],
    appendLine: (_path, row) => { rows.push({ ts: new Date(NOW).toISOString(), ...row }); },
    readLedgerUnion: () => ({ complete: true, lines: rows }), readActiveWorkerCount: () => 0, now: () => NOW,
    arm: () => assert.fail("unexpected arm"), close: () => assert.fail("unexpected close"), postReview: () => {},
    dispatchFix: (pr) => { dispatched.push(pr.prNumber); },
    escalate: (pr) => { escalated.push(pr.prNumber); },
    readLiveState: (p) => ({ ok: true, state: "OPEN", headSha: p.headSha }), rereadPrAtAct: async (p) => p,
    readMainTip: async () => MAIN,
    // The one press there is. Production wires it on the hook's effects; the fan-out's batches drop it.
    updateBranch: (pr) => {
      pressed.push(`${pr.prNumber}@${pr.headSha}`);
      const outcome = outcomes.get(pr.prNumber) ?? "updated";
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    ...over,
  };
  const ports = {
    effects: () => effects,
    readCompare: async () => ({ ahead_by: 0, files: [] }),
    openPrViews: () => Promise.resolve(structuredClone(views)),
    clock: { now: () => NOW },
  };
  const hook = buildSweepLightHook("o", "r", { root } as never, effects.ledgerPath, "T12945", NO_PLAN,
    (step, extra) => { logs.push({ step, ...extra }); }, undefined, () => false, () => NO_PLAN, undefined, undefined, ports);
  const disposed = (pr: OpenPrView) => rows.findLast((row) => row.step === "sweep.disposed" && row.pr_number === pr.prNumber);
  return {
    rows, pressed, escalated, dispatched, outcomes, effects, disposed,
    /** One daemon light pass over `next`; a pass that threw is a test failure, not a quiet stand-down. */
    pass: async (next: OpenPrView[]) => {
      views = next;
      await hook();
      assert.deepEqual(logs.filter((row) => row.step === "sweep_light.error"), []);
    },
    /** The latest disposition's two sentences for this PR. */
    text: (pr: OpenPrView) => { const row = disposed(pr); return `${String(row?.reason)} | ${String(row?.stand_down_reason ?? "")}`; },
    steps: (step: string, pr?: OpenPrView) => rows.filter((row) => row.step === step && (pr === undefined || row.pr_number === pr.prNumber)),
    admitted: () => rows.filter((row) => row.step === BASE_RED_REFRESH_ADMISSION_STEP && row.surface === "light")
      .flatMap((row) => (row.admitted as Row[]).map((entry) => [entry.pr_number, entry.head_sha, entry.arm, entry.outcome])),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const key = (pr: OpenPrView) => `${pr.prNumber}@${pr.headSha}`;

test("W1-T12945 criterion 1: a build head missing its own task record enters the light pass's refresh admission and is refreshed once, with no escalation before the refresh is tried", async () => {
  const own = ownRecordPr(1294511);
  const f = fixture([mainRow("red", 40), skipRow(own, 25)]);
  try {
    // Main is red, so the admission is closed. The head waits for it; it is not escalated.
    await f.pass([own]);
    assert.deepEqual(f.pressed, []);
    assert.equal(f.disposed(own)?.disposition, "wait", f.text(own));
    assert.ok(f.text(own).includes(`${OWN_TASK_RECORD_MISSING_CAUSE} → base refresh: ${WAITS_FOR_ADMISSION}`), f.text(own));
    assert.doesNotMatch(f.text(own), /unwired|escalating/);

    // Main turns green. The next pass's whole-snapshot admission takes the head and presses its one refresh.
    f.rows.push(mainRow("green", 5));
    await f.pass([own]);
    assert.deepEqual(f.pressed, [key(own)]);
    assert.deepEqual(f.steps(OWN_TASK_RECORD_REFRESH_STEP).map((row) => [row.pr_number, row.head_sha, row.cause, row.outcome, row.surface, row.forced_by]),
      [[own.prNumber, own.headSha, OWN_TASK_RECORD_MISSING_CAUSE, "updated", "light", OWN_TASK_RECORD_MISSING_CAUSE]]);
    assert.deepEqual(f.admitted(), [[own.prNumber, own.headSha, OWN_TASK_RECORD_MISSING_CAUSE, "updated"]], "the cause is named on the admission row");
    // That pass's fan-out reads the press's outcome and waits for the refreshed head.
    assert.equal(f.disposed(own)?.disposition, "wait", f.text(own));
    assert.ok(f.text(own).includes(`${OWN_TASK_RECORD_MISSING_CAUSE} → base refresh (updated) — re-reviewing the refreshed head`), f.text(own));

    // A view that still shows the old head is not pressed again, and is never escalated.
    await f.pass([own]);
    assert.deepEqual(f.pressed, [key(own)]);
    assert.deepEqual(f.escalated, []);
    for (const row of f.steps("sweep.disposed", own)) assert.doesNotMatch(`${String(row.reason)} ${String(row.stand_down_reason)}`, /unwired|escalating/);
  } finally { f.cleanup(); }
});

test("W1-T12945 criterion 2: a head held as base-red whose check is green on main enters the same admission, and its disposition no longer reads that the refresh is unwired", async () => {
  const red = baseRedPr(1294521);
  const f = fixture([...liveHistory(), mainRow("green", 20), stoodDownRow(red, 70)]);
  try {
    // Pass 1: the fan-out derives the refresh, presses nothing, and names the head for the admission.
    await f.pass([red]);
    assert.deepEqual(f.pressed, []);
    assert.equal(f.disposed(red)?.disposition, "blocked-fixable", f.text(red));
    assert.ok(f.text(red).includes(`base red: ${CHECK} was held while main was red; main is green, but ${WAITS_FOR_ADMISSION} — no fix dispatched`), f.text(red));
    assert.doesNotMatch(f.text(red), /unwired/);
    const handed = f.disposed(red)?.[HANDOFF_FIELD] as Row | undefined;
    assert.equal(handed?.cause, BASE_RED_CAUSE, "the hand-off names its cause");
    assert.equal(handed?.held_since, ago(70));

    // Pass 2: the whole-snapshot admission takes the named head and presses its one refresh.
    await f.pass([red]);
    assert.deepEqual(f.pressed, [key(red)]);
    assert.deepEqual(f.steps(BASE_RED_REFRESH_STEP, red).map((row) => [row.head_sha, row.check_name, row.cause, row.outcome, row.surface, row.forced_by]),
      [[red.headSha, CHECK, BASE_RED_CAUSE, "updated", "light", REFRESH_ADMISSION_FORCED_BY]]);
    assert.deepEqual(f.admitted(), [[red.prNumber, red.headSha, "base-red", "updated"]]);
    // The same pass still holds the old head in its view: it waits for the head the refresh produces, with no fix.
    assert.match(f.text(red), /refresh admission requested the branch refresh \(updated\) — awaiting the refreshed head, no fix dispatched/);
    assert.equal(f.disposed(red)?.[HANDOFF_FIELD], undefined, "a refreshed head is no longer handed over");

    // One press per head: a third pass on the same view presses nothing and dispatches no fix.
    await f.pass([red]);
    assert.deepEqual(f.pressed, [key(red)]);
    assert.deepEqual(f.dispatched, []);
  } finally { f.cleanup(); }
});

test("W1-T12945 criterion 2: with unreadable refresh history a base-red head is handed over only on a clear trial merge, probed once", async () => {
  // No refresh row older than the PR and no archive: the history is unreadable, so W1-T8396's evidence decides.
  const probe = (outcome: "passes" | "fails", probes: number[]): Partial<SweepDeps> => ({
    reproduceFailingTestsOnMerge: async (pr, files) => { probes.push(pr.prNumber); return files.map((file) => ({ file, outcome, duration_ms: 1, cached: false })); },
  });
  const clear = baseRedPr(1294531);
  // An earlier admission's refresh of another PR has not started CI, so the admission stays closed for two passes.
  const earlier = ownRecordPr(1294532, "f", { checksState: "pending", reviewState: "none" });
  const clearProbes: number[] = [];
  const f = fixture([mainRow("green", 20), stoodDownRow(clear, 70),
    { step: BASE_RED_REFRESH_ADMISSION_STEP, ts: ago(10), surface: "light", signal: "slow-start", width: 1, waiting: [],
      admitted: [{ pr_number: earlier.prNumber, head_sha: "e".repeat(40), arm: "base-red", outcome: "updated" }] }], probe("passes", clearProbes));
  const refusedProbes: number[] = [];
  const refused = baseRedPr(1294533);
  const g = fixture([mainRow("green", 20), stoodDownRow(refused, 70)], probe("fails", refusedProbes));
  try {
    await f.pass([clear, earlier]);
    await f.pass([clear, earlier]);
    assert.deepEqual(f.pressed, [], "an admitted refresh whose CI has not started holds the admission");
    assert.deepEqual(clearProbes, [clear.prNumber], "a handed head is probed once per head and main, not on every pass it waits");
    assert.ok(f.text(clear).includes(WAITS_FOR_ADMISSION), f.text(clear));
    await f.pass([clear, { ...earlier, checksPendingSince: ago(1) }]);
    assert.deepEqual(f.pressed, [key(clear)]);

    await g.pass([refused]);
    assert.match(g.text(refused), /base red refresh refused: merged-probe — every failing test file still fails on a trial merge with main/);
    await g.pass([refused]);
    assert.match(g.text(refused), /base red refresh refused: merged-probe/);
    assert.equal(g.disposed(refused)?.[HANDOFF_FIELD], undefined);
    assert.deepEqual(g.pressed, [], "a refused head is never handed over");
    assert.deepEqual(refusedProbes, [refused.prNumber], "the refusal is recorded and reused");
  } finally { f.cleanup(); g.cleanup(); }
});

test("W1-T12945 criterion 3: a refresh that does not take, or the same miss on the head a refresh produced, keeps the escalation with its cause named, and no head and cause is pressed twice", async () => {
  const conflicted = ownRecordPr(1294541);
  const f = fixture([mainRow("green", 20), skipRow(conflicted, 25)]);
  const own = ownRecordPr(1294542);
  const g = fixture([mainRow("green", 20), skipRow(own, 25)]);
  const red = baseRedPr(1294543);
  const h = fixture([...liveHistory(), mainRow("green", 20), stoodDownRow(red, 70)]);
  try {
    // A refresh that does not take: the escalation stays, and names the cause and the outcome.
    f.outcomes.set(conflicted.prNumber, "conflict");
    await f.pass([conflicted]);
    assert.deepEqual(f.pressed, [key(conflicted)]);
    assert.equal(f.disposed(conflicted)?.disposition, "blocked-ambiguous", f.text(conflicted));
    assert.ok(f.text(conflicted).includes(`${OWN_TASK_RECORD_MISSING_CAUSE}: base refresh did not take (conflict) — escalating`), f.text(conflicted));
    await f.pass([conflicted]);
    assert.deepEqual(f.pressed, [key(conflicted)], "the head's one press is spent");
    assert.equal(f.disposed(conflicted)?.disposition, "blocked-ambiguous");

    // The same miss on the head the refresh produced: escalated by name, and that head is never pressed.
    await g.pass([own]);
    assert.deepEqual(g.pressed, [key(own)]);
    const produced = ownRecordPr(own.prNumber, "e");
    g.rows.push(skipRow(produced, 0));
    await g.pass([produced]);
    await g.pass([produced]);
    assert.deepEqual(g.pressed, [key(own)], "no refresh of the head a refresh produced");
    assert.equal(g.disposed(produced)?.disposition, "blocked-ambiguous", g.text(produced));
    assert.ok(g.text(produced).includes(`${OWN_TASK_RECORD_MISSING_CAUSE} persists after a base refresh — escalating`), g.text(produced));

    // A base-red press that threw still spends the head's one record: the head named again is not pressed again.
    await h.pass([red]);
    h.outcomes.set(red.prNumber, new Error("422 merge conflict"));
    assert.deepEqual(await runLightPassRefreshAdmission([red], h.effects), [red.prNumber]);
    assert.deepEqual(h.steps(BASE_RED_REFRESH_STEP, red).map((row) => row.outcome), ["error: 422 merge conflict"]);
    assert.equal((h.disposed(red)?.[HANDOFF_FIELD] as Row | undefined)?.cause, BASE_RED_CAUSE, "control: the latest disposition still names the head");
    assert.deepEqual(await runLightPassRefreshAdmission([red], h.effects), []);
    assert.deepEqual(h.pressed, [key(red)]);
  } finally { f.cleanup(); g.cleanup(); h.cleanup(); }
});

test("W1-T12945 criterion 4 invariant:one-refresh-selection: the fan-out presses no branch update, every press is the whole-snapshot admission's after its value test, and a dry run presses nothing", async () => {
  const own = ownRecordPr(1294551);
  const red = baseRedPr(1294552);
  const valueTest: Partial<SweepDeps> = { readBranchProtectionStrict: async () => false, refreshCiRunForHead: async () => false };
  const f = fixture([...liveHistory(), mainRow("green", 20), stoodDownRow(red, 70), skipRow(own, 25)], valueTest);
  const busy = ownRecordPr(1294553);
  const ci = { inFlight: true };
  const g = fixture([mainRow("green", 20), skipRow(busy, 25)], { ...valueTest, refreshCiRunForHead: async () => ci.inFlight });
  const waiting = ownRecordPr(1294556);
  const actions = { status: "major_outage" };
  const i = fixture([mainRow("green", 20), skipRow(waiting, 25)],
    { readActionsStatusSummary: async () => ({ components: [{ name: "Actions", status: actions.status }], incidents: [] }) });
  const dryOwn = ownRecordPr(1294554);
  const dryRed = baseRedPr(1294555);
  const d = fixture([...liveHistory(), mainRow("green", 20), stoodDownRow(dryRed, 70), skipRow(dryOwn, 25)]);
  try {
    // Pass 1. The fan-out derives a refresh for the base-red head and cannot press it: only the head the admission
    // already saw (the review's own skip row) is pressed, and the base-red head is named for the next admission.
    await f.pass([own, red]);
    assert.deepEqual(f.pressed, [key(own)], "the per-PR fan-out pressed nothing");
    assert.equal((f.disposed(red)?.[HANDOFF_FIELD] as Row | undefined)?.cause, BASE_RED_CAUSE);

    // Pass 2. The refreshed head's CI has not started, so the admission stays closed: no fan-out of refreshes.
    const produced = ownRecordPr(own.prNumber, "e", { checksState: "pending", reviewState: "none" });
    await f.pass([produced, red]);
    assert.deepEqual(f.pressed, [key(own)]);
    assert.ok(f.text(red).includes(WAITS_FOR_ADMISSION), f.text(red));

    // Pass 3. Its CI started, so the admission takes the next head.
    await f.pass([{ ...produced, checksPendingSince: ago(1) }, red]);
    assert.deepEqual(f.pressed, [key(own), key(red)]);
    // Every press is an entry of a whole-snapshot admission row, and each took the value test first.
    assert.deepEqual(f.admitted(), [[own.prNumber, own.headSha, OWN_TASK_RECORD_MISSING_CAUSE, "updated"], [red.prNumber, red.headSha, "base-red", "updated"]]);
    assert.deepEqual(f.steps("sweep.refresh.decided").map((row) => [row.pr_number, row.head_sha, row.path, row.decision, row.forced_by]),
      [[own.prNumber, own.headSha, "plan-repair", "refresh", OWN_TASK_RECORD_MISSING_CAUSE], [red.prNumber, red.headSha, "base-red", "refresh", REFRESH_ADMISSION_FORCED_BY]]);

    // The value test can refuse: CI is in flight at the head and no judge rules. Nothing is pressed and nothing is
    // spent, so the head is still waiting, not escalated, and is pressed once its CI has ended.
    await g.pass([busy]);
    await g.pass([busy]);
    assert.deepEqual(g.pressed, []);
    assert.deepEqual(g.steps("sweep.refresh.decided").map((row) => [row.pr_number, row.decision, row.forced_by]), [[busy.prNumber, "skip", OWN_TASK_RECORD_MISSING_CAUSE]]);
    assert.deepEqual(g.steps(OWN_TASK_RECORD_REFRESH_STEP), []);
    assert.equal(g.disposed(busy)?.disposition, "wait", g.text(busy));
    assert.ok(g.text(busy).includes(WAITS_FOR_ADMISSION), g.text(busy));
    ci.inFlight = false;
    await g.pass([busy]);
    assert.deepEqual(g.pressed, [key(busy)]);

    // An Actions incident holds every refresh (W1-T5939): the admission presses nothing until it is over.
    assert.deepEqual(await runLightPassRefreshAdmission([waiting], i.effects), []);
    assert.deepEqual(i.pressed, []);
    actions.status = "operational";
    assert.deepEqual(await runLightPassRefreshAdmission([waiting], i.effects), [waiting.prNumber]);
    assert.deepEqual(i.pressed, [key(waiting)]);

    // A dry run presses nothing: neither the admission nor the fan-out.
    assert.deepEqual(await runLightPassRefreshAdmission([dryOwn, dryRed], { ...d.effects, dryRun: true }), []);
    const summaries = await runSweepLightPass([dryOwn, dryRed], { ...d.effects, updateBranch: undefined, dryRun: true }, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(d.pressed, []);
    assert.deepEqual([OWN_TASK_RECORD_REFRESH_STEP, BASE_RED_REFRESH_ADMISSION_STEP].flatMap((step) => d.steps(step)), []);
    assert.deepEqual(d.steps(BASE_RED_REFRESH_STEP, dryRed), []);
    const dryReason = summaries.flatMap((summary) => summary.actions).find((action) => action.prNumber === dryOwn.prNumber)?.reason;
    assert.ok(dryReason?.includes("(dry run: not pressed)"), String(dryReason));
  } finally { f.cleanup(); g.cleanup(); i.cleanup(); d.cleanup(); }
});
