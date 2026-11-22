/**
 * W1-T13156 — IN THE LIGHT PASS A HEAD WHOSE RED MAIN ALREADY FIXED, AND A NO-COMMIT FIX THAT WAITS FOR A BRANCH UPDATE,
 * ENTER THE REFRESH ADMISSION INSTEAD OF STANDING STILL.
 *
 * W1-T12945 handed two causes from the light pass's fan-out to its whole-snapshot refresh admission. Core ledger,
 * 2026-11-15/16: ten dispositions read "failing test file(s) <path> already fixed on main <sha>; the branch refresh is
 * unwired on this surface (light pass)" and five read "no-commit CI fix awaits a branch-update gateway for the moved
 * main". The fan-out carries no `updateBranch` (W1-T528), so each such head got neither a refresh nor a fix.
 *
 * The hook tests drive the real `buildSweepLightHook`, the production light-pass composition, over an in-memory ledger and
 * effect fakes. `updateBranch` is on the hook's effects alone, as in production.
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
  DEFAULT_SWEEP_POLICY,
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
const OLD_MAIN = "d".repeat(40);
const RUN_BASE = "b".repeat(40);
const CHECK = "test-slow-shard (2/4)";
const FILE = "test/sweep/a-suite-main-fixed.test.ts";
// The ledger contract this task adds, spelled out: the disposition field and the two causes it names.
const HANDOFF_FIELD = "refresh_handoff";
const BASE_FIXED_CAUSE = "base-fixed-main";
const NO_COMMIT_CAUSE = "no-commit-fix-moved-main";
const WAITS_FOR_ADMISSION = "the branch refresh waits for the light pass's refresh admission";
type Row = Record<string, unknown>;

/** The ten observed rows' shape: one required shard red on a test file main has since fixed. */
function fixedPr(prNumber: number, head = "b", over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`, reviewState: "pending", checksState: "red",
    unmetCriteria: [], priorStrikes: 0, headSha: head.repeat(40), headRefName: `run-W1-T${prNumber}-1794000000000`, autoMergeArmed: false,
    mergeState: "clean", createdAt: ago(120), lastActivityAt: ago(80), changedFiles: ["src/subject.ts"],
    ciFailures: [{ name: CHECK, logTail: `not ok 1 - ${FILE}`, conclusion: "FAILURE" }], ...over,
  };
}

/** The five observed rows' shape: a red head whose one no-commit fix round left it unchanged, on a run cut from an older main. */
function noCommitPr(prNumber: number, head = "a", over: Partial<OpenPrView> = {}): OpenPrView {
  return fixedPr(prNumber, head, { ciFailures: [{ name: "coverage-shard (8/8)", logTail: "AssertionError: census", conclusion: "FAILURE" }], ...over });
}

const mainRow = (state: "green" | "red", minutesAgo: number): Row =>
  ({ step: "main.health.observed", ts: ago(minutesAgo), sha: MAIN, state, failing_checks: state === "red" ? [CHECK] : [] });
/** A probe that found the file failing at an older main: main once carried this red, so a head still red on it may have inherited it. */
const formerRed = (): Row =>
  ({ step: "sweep.base_reproduction", ts: ago(300), pr_number: 1, head_sha: "0".repeat(40), main_sha: OLD_MAIN, verdict: "reproduced",
    files: [{ file: FILE, outcome: "fails", duration_ms: 1, cached: false }] });
const noCommitRounds = (pr: OpenPrView): Row[] => [
  { step: "sweep.disposed", ts: ago(30), task_id: pr.taskId, pr_number: pr.prNumber, head_sha: pr.headSha, disposition: "blocked-fixable", acted: true },
  { step: "fix.dispatch", ts: ago(29), task_id: pr.taskId, head_sha: pr.headSha, round_id: "round-3", strike: 1, mode: "ci-log", verdict_regime: "executed" },
  { step: "fix.done", ts: ago(28), task_id: pr.taskId, head_sha: pr.headSha, round_id: "round-3", strike: 1, subtype: "success" },
];
/** One row of every refresh step, older than each fixture PR: the live ledger then covers the PR's whole life, so its
 *  refresh history is readable without an archive (W1-T8533). */
const liveHistory = (): Row[] => ["fix.base_refreshed", "sweep.base_red.refresh", BASE_FIXED_REFRESH_STEP, "refresh.clearance"]
  .map((step) => ({ step, ts: ago(600), pr_number: 1, head_sha: "0".repeat(40) }));

function fixture(rows: Row[], over: Partial<SweepDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13156-`));
  const logs: Row[] = [];
  const pressed: string[] = [];
  const claimedBeforePress: boolean[] = [];
  const dispatched: number[] = [];
  const outcomes = new Map<number, UpdateBranchOutcome | Error>();
  let views: OpenPrView[] = [];
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T13156", readLedger: () => [...rows],
    appendLine: (_path, row) => { rows.push({ ts: new Date(NOW).toISOString(), ...row }); },
    readLedgerUnion: () => ({ complete: true, lines: rows }), readActiveWorkerCount: () => 0, now: () => NOW,
    arm: () => assert.fail("unexpected arm"), close: () => assert.fail("unexpected close"), postReview: () => {},
    dispatchFix: (pr) => { dispatched.push(pr.prNumber); },
    escalate: () => {},
    readLiveState: (p) => ({ ok: true, state: "OPEN", headSha: p.headSha }), rereadPrAtAct: async (p) => p,
    readMainTip: async () => MAIN,
    reproduceFailingTestsOnMain: async (_pr, files) => files.map((file) => ({ file, outcome: "passes", duration_ms: 1, cached: false })),
    readFailedRunBase: async () => RUN_BASE,
    // The one press there is. Production wires it on the hook's effects; the fan-out's batches drop it.
    updateBranch: (pr) => {
      pressed.push(`${pr.prNumber}@${pr.headSha}`);
      claimedBeforePress.push(rows.at(-1)?.no_commit_rerun_attempted === true);
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
  const hook = buildSweepLightHook("o", "r", { root } as never, effects.ledgerPath, "T13156", NO_PLAN,
    (step, extra) => { logs.push({ step, ...extra }); }, undefined, () => false, () => NO_PLAN, undefined, undefined, ports);
  const disposed = (pr: OpenPrView) => rows.findLast((row) => row.step === "sweep.disposed" && row.pr_number === pr.prNumber);
  return {
    rows, pressed, claimedBeforePress, dispatched, outcomes, effects, disposed,
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
const green = () => [...liveHistory(), mainRow("green", 20), formerRed()];

test("W1-T13156 criterion 1: a head whose failing test file main already fixed, the reproduction clear, enters the light pass's refresh admission and is refreshed once", async () => {
  const pr = fixedPr(1315611);
  const f = fixture(green());
  try {
    // Pass 1: the fan-out reads the fix on main, presses nothing, and names the head for the admission.
    await f.pass([pr]);
    assert.deepEqual(f.pressed, []);
    assert.ok(f.text(pr).includes(`failing test file(s) ${FILE} already fixed on main ${MAIN}; ${WAITS_FOR_ADMISSION} — no fix dispatched`), f.text(pr));
    assert.doesNotMatch(f.text(pr), /unwired/);
    const handed = f.disposed(pr)?.[HANDOFF_FIELD] as Row | undefined;
    assert.equal(handed?.cause, BASE_FIXED_CAUSE, "the hand-off names its cause");
    assert.equal((handed?.refresh_row as Row | undefined)?.step, BASE_FIXED_REFRESH_STEP);

    // Pass 2: the whole-snapshot admission takes the named head and presses its one refresh.
    await f.pass([pr]);
    assert.deepEqual(f.pressed, [key(pr)]);
    assert.deepEqual(f.steps(BASE_FIXED_REFRESH_STEP, pr).map((row) => [row.head_sha, row.main_sha, row.cause, row.outcome, row.surface, row.forced_by]),
      [[pr.headSha, MAIN, BASE_FIXED_CAUSE, "updated", "light", REFRESH_ADMISSION_FORCED_BY]]);
    assert.deepEqual(f.admitted(), [[pr.prNumber, pr.headSha, "base-fixed", "updated"]], "the cause is named on the admission row");
    // A view that still shows the old head waits for the head the refresh produced: no fix, no strike.
    assert.match(f.text(pr), /refresh admission requested the branch refresh \(updated\) — awaiting the refreshed head, no fix dispatched/);
    assert.equal(f.disposed(pr)?.[HANDOFF_FIELD], undefined, "a refreshed head is no longer handed over");

    // One press per head: a third pass on the same view presses nothing and dispatches no fix.
    await f.pass([pr]);
    assert.deepEqual(f.pressed, [key(pr)]);
    assert.deepEqual(f.dispatched, []);
  } finally { f.cleanup(); }
});

test("W1-T13156 criterion 2: a no-commit CI fix that waits for a branch update for the moved main enters the same admission, and its disposition names the hand-off", async () => {
  const pr = noCommitPr(1315621);
  const f = fixture([...liveHistory(), mainRow("green", 20), ...noCommitRounds(pr)]);
  try {
    await f.pass([pr]);
    assert.deepEqual(f.pressed, []);
    assert.ok(f.text(pr).includes(`no-commit CI fix: the branch refresh for the moved main ${MAIN} — ${WAITS_FOR_ADMISSION}`), f.text(pr));
    assert.doesNotMatch(f.text(pr), /gateway|unwired/);
    assert.equal((f.disposed(pr)?.[HANDOFF_FIELD] as Row | undefined)?.cause, NO_COMMIT_CAUSE, "the hand-off names its cause");
    assert.deepEqual(f.dispatched, []);

    await f.pass([pr]);
    assert.deepEqual(f.pressed, [key(pr)]);
    assert.deepEqual(f.claimedBeforePress, [true], "the receipt is written before the press, as the full surface writes it");
    const receipts = f.rows.filter((row) => row.step === "sweep.disposed" && row.pr_number === pr.prNumber && row.cause === NO_COMMIT_CAUSE);
    assert.deepEqual(receipts.map((row) => [row.cause, row.run_base_sha, row.main_sha, row.no_commit_rerun_round_id, row.no_commit_refresh_outcome]),
      [[NO_COMMIT_CAUSE, RUN_BASE, MAIN, "round-3", undefined], [NO_COMMIT_CAUSE, RUN_BASE, MAIN, "round-3", "updated"]]);
    assert.deepEqual(f.admitted(), [[pr.prNumber, pr.headSha, "fix-rung", "updated"]]);
    assert.match(f.text(pr), /refresh admission requested the branch refresh \(updated\) — awaiting the refreshed head/);

    // The head's one receipt is spent: a view that still shows the old head is never pressed again.
    await f.pass([pr]);
    assert.deepEqual(f.pressed, [key(pr)]);
    for (const row of f.steps("sweep.disposed", pr)) assert.doesNotMatch(`${String(row.reason)} ${String(row.stand_down_reason)}`, /gateway|unwired/);
  } finally { f.cleanup(); }
});

test("W1-T13156 criterion 3: a refresh that does not take, or the same red on the head a refresh produced, keeps today's next step with its cause named, and no head and cause is pressed twice", async () => {
  const conflicted = fixedPr(1315631);
  const f = fixture(green());
  const produced = fixedPr(1315632);
  const g = fixture(green());
  const threw = noCommitPr(1315633);
  const h = fixture([...liveHistory(), mainRow("green", 20), ...noCommitRounds(threw)]);
  try {
    // A base-fixed refresh that does not take: the row names the cause and the outcome, and the head is not pressed again.
    f.outcomes.set(conflicted.prNumber, "conflict");
    await f.pass([conflicted]);
    await f.pass([conflicted]);
    assert.deepEqual(f.pressed, [key(conflicted)]);
    assert.deepEqual(f.steps(BASE_FIXED_REFRESH_STEP, conflicted).map((row) => [row.cause, row.outcome]), [[BASE_FIXED_CAUSE, "conflict"]]);
    await f.pass([conflicted]);
    assert.deepEqual(f.pressed, [key(conflicted)], "the head's one press is spent");
    assert.equal(f.disposed(conflicted)?.[HANDOFF_FIELD], undefined, "a spent head is no longer handed over");
    assert.doesNotMatch(f.text(conflicted), /unwired|awaiting the refreshed head/, "today's next step, not a wait for a head that never came");

    // The same red on the head a refresh produced: that head is never pressed, whatever the pass reads for it.
    await g.pass([produced]);
    await g.pass([produced]);
    assert.deepEqual(g.pressed, [key(produced)]);
    const next = fixedPr(produced.prNumber, "e");
    await g.pass([next]);
    await g.pass([next]);
    assert.deepEqual(g.pressed, [key(produced)], "no refresh of the head a refresh produced");
    assert.equal(g.disposed(next)?.[HANDOFF_FIELD], undefined);

    // A no-commit press that threw still spends the head's one receipt: the head named again is not pressed again.
    await h.pass([threw]);
    h.outcomes.set(threw.prNumber, new Error("422 merge conflict"));
    assert.deepEqual(await runLightPassRefreshAdmission([threw], h.effects), [threw.prNumber]);
    assert.deepEqual(h.rows.filter((row) => row.no_commit_refresh_outcome !== undefined).map((row) => [row.cause, row.no_commit_refresh_outcome]),
      [[NO_COMMIT_CAUSE, "error: 422 merge conflict"]]);
    assert.deepEqual(await runLightPassRefreshAdmission([threw], h.effects), []);
    assert.deepEqual(h.pressed, [key(threw)]);
  } finally { f.cleanup(); g.cleanup(); h.cleanup(); }
});

test("W1-T13156 criterion 4 invariant:one-refresh-selection: the fan-out presses no branch update, every press is the whole-snapshot admission's after its value test, and a dry run presses nothing", async () => {
  const fixed = fixedPr(1315641);
  const noCommit = noCommitPr(1315642);
  const valueTest: Partial<SweepDeps> = { readBranchProtectionStrict: async () => false, refreshCiRunForHead: async () => false };
  const f = fixture([...green(), ...noCommitRounds(noCommit)], valueTest);
  const busy = fixedPr(1315643);
  const ci = { inFlight: true };
  const g = fixture(green(), { ...valueTest, refreshCiRunForHead: async () => ci.inFlight });
  const idle = noCommitPr(1315644);
  const actions = { status: "major_outage" };
  const i = fixture([...liveHistory(), mainRow("green", 20), ...noCommitRounds(idle)],
    { readActionsStatusSummary: async () => ({ components: [{ name: "Actions", status: actions.status }], incidents: [] }) });
  const dryFixed = fixedPr(1315645);
  const dryNoCommit = noCommitPr(1315646);
  const d = fixture([...green(), ...noCommitRounds(dryNoCommit)]);
  try {
    // Pass 1: the fan-out presses nothing for either cause; both are named for the admission.
    await f.pass([fixed, noCommit]);
    assert.deepEqual(f.pressed, [], "the per-PR fan-out pressed nothing");
    assert.equal((f.disposed(fixed)?.[HANDOFF_FIELD] as Row | undefined)?.cause, BASE_FIXED_CAUSE);
    assert.equal((f.disposed(noCommit)?.[HANDOFF_FIELD] as Row | undefined)?.cause, NO_COMMIT_CAUSE);

    // Pass 2: the admission opens with one press; the other head waits behind it, named and unpressed.
    await f.pass([fixed, noCommit]);
    assert.equal(f.pressed.length, 1);
    const [first] = f.admitted();
    assert.ok(first !== undefined && ["base-fixed", "fix-rung"].includes(String(first[2])));
    // Every press is an entry of a whole-snapshot admission row, and each took the value test first.
    assert.deepEqual(f.steps("sweep.refresh.decided").map((row) => row.forced_by), [first![2] === "base-fixed" ? REFRESH_ADMISSION_FORCED_BY : NO_COMMIT_CAUSE]);
    const row = f.rows.findLast((r) => r.step === BASE_RED_REFRESH_ADMISSION_STEP && r.surface === "light")!;
    const waiting = (row.waiting as Row[]).map((entry) => [entry.pr_number, entry.arm, entry.behind]);
    const other = first![0] === fixed.prNumber ? noCommit : fixed;
    assert.deepEqual(waiting, [[other.prNumber, first![0] === fixed.prNumber ? "fix-rung" : "base-fixed", [first![0]]]], "the second head waits behind the first");

    // The value test can refuse: CI is in flight at the head and no judge rules. Nothing is pressed.
    await g.pass([busy]);
    await g.pass([busy]);
    assert.deepEqual(g.pressed, []);
    assert.deepEqual(g.steps("sweep.refresh.decided").map((row) => [row.pr_number, row.decision, row.forced_by]), [[busy.prNumber, "skip", REFRESH_ADMISSION_FORCED_BY]]);

    // An Actions incident holds every refresh (W1-T5939): the admission presses nothing until it is over.
    await i.pass([idle]);
    assert.deepEqual(await runLightPassRefreshAdmission([idle], i.effects), []);
    assert.deepEqual(i.pressed, []);
    actions.status = "operational";
    assert.deepEqual(await runLightPassRefreshAdmission([idle], i.effects), [idle.prNumber]);
    assert.deepEqual(i.pressed, [key(idle)]);

    // A dry run presses nothing: neither the admission nor the fan-out.
    assert.deepEqual(await runLightPassRefreshAdmission([dryFixed, dryNoCommit], { ...d.effects, dryRun: true }), []);
    await runSweepLightPass([dryFixed, dryNoCommit], { ...d.effects, updateBranch: undefined, dryRun: true }, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(d.pressed, []);
    assert.deepEqual([dryFixed, dryNoCommit].flatMap((pr) => d.steps(BASE_FIXED_REFRESH_STEP, pr)), []);
    assert.deepEqual(d.rows.filter((row) => row.no_commit_rerun_attempted === true && row.pr_number === dryNoCommit.prNumber), []);
  } finally { f.cleanup(); g.cleanup(); i.cleanup(); d.cleanup(); }
});
