import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { decideArmFromLedgerVerdict, priorReviewVerdictFromLedger } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  buildSweepEffects,
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  reviewStatusSupersedesLedgerAttempt,
  runSweep,
  type BuildSweepEffectsDeps,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T5813 ──────────────────────────────────────────────────────────────────────────────────
//
// #9155 (a plan filing on `run-unfiled-*`) sat clean at head c7a6af55 from 03:17Z to 04:44Z on
// 2026-10-05. Its review rows were written under TWO identities: `PR-9155` at 02:55:18.739Z and
// `unfiled` at 03:14:19.100Z and 03:43:12.418Z, all for the same exact input. A pass that read the
// PR as a plan filing keyed it `PR-9155`, so `reviewInputLastAttemptAt` was 02:55:18.739Z while
// GitHub's status was 03:14:18Z / 03:43:11Z: `reviewStatusSupersedesLedgerAttempt` demanded a
// re-review, and the review claim stood every one down because the verdict for that exact key was
// already DELIVERED. No reviewer ran, so the demand could never be met. A pass that keyed it
// `unfiled` disposed it mergeable, and the arm read the LAST `unfiled` verdict of ANY PR (#9209,
// #9198, #9234) — a different head, so `ledger-refused`. These fixtures replay those rows.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const HEAD = "c7a6af55912de44aa62ec051383c5eb851242515";
const URL = "https://github.com/craigoley/remudero/pull/9155";
const DIGEST = "v2:18fd92ac56f3c990bc16553c3c54675c584c6d0f8f91d7a24593596d8c259075";
const OTHER_URL = "https://github.com/craigoley/remudero/pull/9209";
const OTHER_HEAD = "e7c53ad0e7c53ad0e7c53ad0e7c53ad0e7c53ad0";
const NOW = Date.parse("2026-10-05T03:47:20.841Z");
const SUPERSEDES = /review_status_supersedes_ledger_attempt/;

function posted(ts: string, taskId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts,
    run_id: `review-PR9155-${Date.parse(ts)}`,
    task_id: taskId,
    step: "review.posted",
    lane: "review",
    context: "remudero-review",
    state: "success",
    head_sha: HEAD,
    pr_url: URL,
    review_input_digest: DIGEST,
    capped: false,
    plan_only: true,
    ...over,
  };
}

/** The exact-input review rows #9155 carried, plus the unrelated `unfiled` verdict the arm read. */
const LIVE_ROWS: Array<Record<string, unknown>> = [
  posted("2026-10-05T02:55:18.739Z", "PR-9155"),
  posted("2026-10-05T03:14:19.100Z", "unfiled"),
  posted("2026-10-05T03:35:43.940Z", "unfiled", { pr_url: OTHER_URL, head_sha: OTHER_HEAD, state: "failure",
    review_input_digest: "v2:other", plan_only: false }),
  posted("2026-10-05T03:43:12.418Z", "unfiled"),
];

/** The view a plan-filing pass built: no task id, so the exact-input key is `PR-9155`. */
function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9155,
    prUrl: URL,
    taskId: undefined,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-05T03:43:11Z",
    createdAt: "2026-10-04T20:30:00Z",
    headSha: HEAD,
    autoMergeArmed: false,
    isPlanFiling: true,
    mergeState: "clean",
    requiredContextsUnreadable: false,
    reviewInputDigest: DIGEST,
    priorReviewAttemptsForInput: 1,
    reviewInputLastAttemptAt: "2026-10-05T02:55:18.739Z",
    reviewVerdictPostedAt: "2026-10-05T03:43:11Z",
    reviewPostRefused: false,
    ...over,
  };
}

function ledgerWith(rows: Array<Record<string, unknown>>): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5813-`));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { dir, path };
}

function deps(path: string, armed: number[], reviewed: number[]): SweepDeps {
  return {
    arm: (pr) => { armed.push(pr.prNumber); return "armed"; },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: (pr) => { reviewed.push(pr.prNumber); },
    ledgerPath: path,
    runId: "DAEMON-W1-T5813",
    now: () => NOW,
    readLedgerUnion: () => ({ complete: false, lines: [] }),
  };
}

function disposedRows(path: string): Array<Record<string, unknown>> {
  return readLedgerLines(path).filter((row) => row.step === "sweep.disposed" && row.pr_number === 9155);
}

test("the predicate alone still names #9155's two timestamps: status 03:43:11Z after ledger 02:55:18.739Z", () => {
  assert.equal(reviewStatusSupersedesLedgerAttempt(view()), true, "blind to the claim, the predicate fires");
  assert.equal(reviewStatusSupersedesLedgerAttempt(view(), true), false, "a delivered verdict ends the demand");
  assert.match(deriveDisposition(view(), DEFAULT_SWEEP_POLICY, NOW).reason, SUPERSEDES);
  assert.notEqual(
    deriveDisposition(view(), DEFAULT_SWEEP_POLICY, NOW, { reviewVerdictDelivered: true }).disposition,
    "post-review",
  );
});

test("replaying #9155's rows, a delivered verdict disposes the PR to arm on every pass instead of post-review", async () => {
  const { dir, path } = ledgerWith([
    ...LIVE_ROWS,
    // The pass before: the supersedes demand, stood down by the review claim as DELIVERED.
    { ts: "2026-10-05T03:45:09.433Z", run_id: "DAEMON-1791170780650", task_id: "SWEEP", step: "sweep.disposed",
      pr_number: 9155, pr_url: URL, disposition: "post-review", acted: false, head_sha: HEAD, deduped: true,
      reason: "review_status_supersedes_ledger_attempt — re-running the authoritative reviewer",
      stand_down_reason: "a verdict was already DELIVERED for input:[...]", repeat_streak: 2 },
  ]);
  try {
    const armed: number[] = [];
    const reviewed: number[] = [];
    for (let pass = 0; pass < 3; pass++) await runSweep([view()], deps(path, armed, reviewed), DEFAULT_SWEEP_POLICY);
    const rows = disposedRows(path).slice(1);
    assert.equal(rows.length, 3, "one row per pass");
    for (const row of rows) {
      assert.notEqual(row.disposition, "post-review", `pass row must not re-demand a review: ${String(row.reason)}`);
      assert.doesNotMatch(String(row.reason), SUPERSEDES);
    }
    assert.equal(rows[0].disposition, "mergeable");
    assert.equal(rows[0].acted, true, "the first pass after the delivered verdict arms");
    assert.deepEqual(armed, [9155], "armed once; the later passes dedup on the arm, not on a review");
    assert.deepEqual(reviewed, [], "no reviewer is demanded for an input whose verdict was delivered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a status success with no delivered verdict for the input still disposes post-review and runs the reviewer", async () => {
  // Same view; the only exact-input verdicts in the ledger belong to OTHER inputs (an older digest).
  const { dir, path } = ledgerWith(LIVE_ROWS.map((row) => ({ ...row, review_input_digest: "v2:an-older-body" })));
  try {
    const armed: number[] = [];
    const reviewed: number[] = [];
    await runSweep([view()], deps(path, armed, reviewed), DEFAULT_SWEEP_POLICY);
    const [row] = disposedRows(path);
    assert.equal(row.disposition, "post-review");
    assert.match(String(row.reason), SUPERSEDES);
    assert.equal(row.acted, true);
    assert.deepEqual(reviewed, [9155]);
    assert.deepEqual(armed, [], "a live status never grants merge authority");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a post-review stood down as DELIVERED at one head logs the stand-down once, not every pass", async () => {
  // A residual delivered stand-down: no status yet on GitHub, but the exact-input verdict exists.
  const pending = view({ reviewState: "none", reviewVerdictPostedAt: undefined, priorReviewAttemptsForInput: 0,
    reviewInputLastAttemptAt: undefined, taskId: "unfiled", isPlanFiling: false });
  const { dir, path } = ledgerWith(LIVE_ROWS);
  try {
    const reviewed: number[] = [];
    for (let pass = 0; pass < 3; pass++) await runSweep([pending], deps(path, [], reviewed), DEFAULT_SWEEP_POLICY);
    const rows = disposedRows(path);
    assert.equal(rows.length, 3, "every pass still writes its row, so the repeat detector keeps counting");
    assert.deepEqual(rows.map((row) => row.disposition), ["post-review", "post-review", "post-review"]);
    assert.deepEqual(rows.map((row) => row.repeat_streak), [1, 2, 3]);
    assert.match(String(rows[0].stand_down_reason), /already DELIVERED/);
    assert.deepEqual(rows.slice(1).map((row) => row.stand_down_reason), [undefined, undefined],
      "the stand-down sentence is logged once per head");
    assert.deepEqual(rows.slice(1).map((row) => row.stand_down_unchanged), [true, true]);
    assert.deepEqual(reviewed, []);

    const moved = { ...pending, headSha: "f3019283f3019283f3019283f3019283f3019283" };
    const movedRows = LIVE_ROWS.map((row) => ({ ...row, head_sha: moved.headSha }));
    writeFileSync(path, [...readLedgerLines(path), ...movedRows].map((row) => JSON.stringify(row)).join("\n") + "\n");
    await runSweep([moved], deps(path, [], reviewed), DEFAULT_SWEEP_POLICY);
    const last = disposedRows(path).at(-1)!;
    assert.match(String(last.stand_down_reason), /already DELIVERED/, "a new head logs its own stand-down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function effectsDeps(root: string, armImpl: BuildSweepEffectsDeps["armImpl"]): BuildSweepEffectsDeps {
  return {
    owner: "craigoley",
    repo: "remudero-fixture",
    repoRoot: process.cwd(),
    localRepoName: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: "SWEEP-W1-T5813",
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: () => {},
    policy: DEFAULT_SWEEP_POLICY,
    reviewRunner: async () => 0,
    issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/5813" },
    stallNotice: () => {},
    armImpl,
    armSessionPrsOverride: true,
    updateBranchImpl: async () => "updated",
    captureRepairFeedbackImpl: () => {},
    ghRunImpl: () => {},
    spawnWallClockBoundMsOverride: 1,
    reclaimWorkerImpl: () => {},
    disarmImpl: () => undefined,
    readJsonImpl: async () => ({}),
    updatePrBodyImpl: async () => {},
    registeredWorktreeOwnerImpl: () => undefined,
    registeredOwnerRecovery: { capture: () => undefined, remove: () => undefined },
  };
}

test("the arm's ledger gate reads this PR's delivered verdict, never another PR's under a shared id", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5813-arm-`));
  try {
    // `unfiled` is the branch sentinel every run-unfiled PR shares: #9209's row is the newest one.
    const rows = [LIVE_ROWS[0], LIVE_ROWS[1], LIVE_ROWS[3], LIVE_ROWS[2]];
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "ledger.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    let decision: ReturnType<typeof decideArmFromLedgerVerdict> | undefined;
    let taskIdSeen: string | undefined;
    const effects = buildSweepEffects(effectsDeps(root, (_prUrl, taskId, armDeps) => {
      taskIdSeen = taskId;
      decision = decideArmFromLedgerVerdict(priorReviewVerdictFromLedger(armDeps!.ledgerLines(), taskId!), HEAD);
      return decision.arm ? "armed" : "ledger-refused";
    }));
    const outcome = await effects.arm!(view({ taskId: "unfiled", isPlanFiling: false }));
    assert.equal(taskIdSeen, "unfiled");
    assert.equal(decision?.arm, true, decision?.reason);
    assert.notEqual(outcome, "ledger-refused");
    assert.equal(
      decideArmFromLedgerVerdict(priorReviewVerdictFromLedger(rows, "unfiled"), HEAD).arm,
      false,
      "control: the unscoped ledger hands the arm #9209's verdict, the #9155 ledger-refused shape",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
