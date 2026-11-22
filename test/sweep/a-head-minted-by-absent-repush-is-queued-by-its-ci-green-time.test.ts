import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, MAX_RETAINED_LINES_PER_STEP, rotateLedger } from "#src/lib/ledger.js";
import { fixedClock } from "#src/lib/clock.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, observeLightPassReviewEligibility, runSweep, runSweepLightPass,
  type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

// The light pass keys a head that sweep.absent_repush minted by when that head went review-eligible,
// not by the pull request's createdAt. The shape is the operator's 2026-11-13 20:41 ledger.

const NOW = Date.parse("2026-11-13T20:41:28Z");
const at = (hhmm: string): string => `2026-11-13T${hhmm}:00.000Z`;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
type Row = Record<string, unknown>;

function pr(n: number, created: string, extra: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: `head-${n}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: created, createdAt: created, ...extra,
  };
}
const repushed = (n: number, ts: string, newHead: unknown = `head-${n}`): Row =>
  ({ ts, step: "sweep.absent_repush", pr_number: n, old_head: `old-${n}`, new_head: newHead });
const eligible = (n: number, ts: string, head = `head-${n}`): Row =>
  ({ ts, step: "sweep.review_eligible", pr_number: n, head_sha: head, review_key: `${n}@${head}@${ts}` });
const lines = (rows: Row[]) => rows.map((row) => JSON.stringify({ run_id: "repush-order-test", task_id: "SWEEP", ...row }))
  .join("\n") + "\n";

/** Runs one light pass at `width`, then frees one lane at a time. Returns the first admissions and the full start order. */
async function admissionOrder(prs: OpenPrView[], ledger: Row[], width: number, written?: Row[],
  overrides: Partial<SweepDeps> = {}) {
  const releases = new Map<number, () => void>();
  const started: number[] = [];
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}repush-admission-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, lines(ledger));
  const deps: SweepDeps = {
    ledgerPath, runId: "repush-order-test", now: () => NOW,
    readActiveWorkerCount: () => 0,
    appendLine: (path, row) => {
      appendLedger(path, row, { clock: fixedClock(NOW) });
      written?.push({ ts: new Date(NOW).toISOString(), ...(row as Row) });
    },
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      await new Promise<void>((resolve) => { releases.set(p.prNumber, resolve); });
    },
    ...overrides,
  };
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: width, reviewLaneMin: width, reviewLaneMax: width };
  try {
    await runSweepLightPass(prs, deps, policy);
    for (let i = 0; i < 100 && started.length < Math.min(width, prs.length); i++) await settle();
    const first = [...started].sort((a, b) => a - b);
    for (let freed = 0; freed < started.length && freed < prs.length; freed++) {
      releases.get(started[freed]!)?.();
      for (let i = 0; i < 100 && started.length < Math.min(prs.length, freed + 1 + width); i++) await settle();
    }
    return { first, order: [...started] };
  } finally {
    for (const release of releases.values()) release();
    await drainInFlightReviews({ boundMs: 1000 });
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T12534 criterion 1: the 20:41 shape admits the PRs green first and queues the re-pushed heads after them", async () => {
  const prs = [
    pr(18328, at("15:39")), pr(18332, at("15:57")), pr(18343, at("17:23")),
    pr(18345, at("18:02")), pr(18346, at("18:15")), pr(18348, "2026-11-13T19:59:59.995Z"),
  ];
  const ledger = [
    eligible(18332, at("16:30")), eligible(18345, at("18:30")), eligible(18346, at("18:45")),
    eligible(18348, "2026-11-13T19:59:59.999Z"),
    repushed(18328, "2026-11-13T19:56:42.000Z"), repushed(18343, "2026-11-13T19:58:18.000Z"),
    { ...eligible(18328, "2026-11-13T20:00:00.010Z"), queued_at: "2026-11-13T19:59:59.990Z" },
    { ...eligible(18343, at("20:12")), queued_at: at("20:11") },
  ];
  const { first, order } = await admissionOrder(prs, ledger, 3);
  assert.deepEqual(first, [18332, 18345, 18346], "the pass admits #18332 and the two oldest later PRs");
  assert.deepEqual(order.slice(3), [18348, 18328, 18343],
    "the refill tail is the third later PR, then #18328, then #18343");
});

test("W1-T12534 criterion 2: with no re-pushed head the pass keeps the createdAt order and the PR-number tie-break", async () => {
  // Eligibility runs opposite to createdAt here, so keying every PR by eligibility would reverse the order.
  const prs = [pr(501, at("12:00")), pr(502, at("11:00")), pr(503, at("10:00")), pr(504, at("11:00"))];
  const ledger = [
    { ...eligible(501, at("12:05")), queued_at: at("09:00") },
    eligible(502, at("13:00")), eligible(503, at("14:00")), eligible(504, at("15:00")),
    repushed(501, at("12:30"), "head-older-501"),
  ];
  const { first, order } = await admissionOrder(prs, ledger, 1);
  assert.deepEqual(first, [503]);
  assert.deepEqual(order, [503, 502, 504, 501]);
});

test("W1-T12534 criterion 3: a re-pushed head with no eligibility row is keyed by its absent_repush ts", async () => {
  const prs = [
    pr(601, at("10:00")), pr(602, at("18:00")), pr(603, at("19:30")), pr(604, at("18:30")), pr(605, at("18:45")),
  ];
  const ledger = [
    repushed(601, at("19:00")),
    // A row for an older head of #604 and a row with no ts key nothing: both keep createdAt.
    repushed(604, at("20:00"), "head-older-604"),
    { step: "sweep.absent_repush", pr_number: 605, old_head: "old-605", new_head: "head-605" },
  ];
  const { order } = await admissionOrder(prs, ledger, 1);
  assert.deepEqual(order, [602, 604, 605, 601, 603]);
});

test("W1-T12534 criterion 4: a verdict or an update without a new head does not move a re-pushed head", async () => {
  const minted = [repushed(701, at("19:00")), eligible(701, at("19:10"))];
  const before = await admissionOrder([pr(701, at("09:00")), pr(702, at("19:20"))], minted, 1);
  assert.deepEqual(before.order, [701, 702]);
  // The PR was updated (a verdict posted, a new review input) at the same head: a later eligibility row and a later activity.
  const after = await admissionOrder(
    [pr(701, at("09:00"), { lastActivityAt: at("20:35") }), pr(702, at("19:20"))],
    [...minted, eligible(701, at("20:30"))], 1);
  assert.deepEqual(after.order, [701, 702]);
});

test("W1-T12534 criterion 3: production selection uses mint fallback, then createdAt when neither row is live", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}repush-rotation-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const realLedger = { ledgerPath, appendLine: undefined };
  const prs = [pr(731, at("09:00")), pr(732, at("19:05")), pr(733, at("18:00"))];
  try {
    writeFileSync(ledgerPath, lines([repushed(731, at("19:00"))]));
    assert.deepEqual((await admissionOrder(prs, [], 1, undefined, realLedger)).order,
      [733, 731, 732], "without eligibility the selection snapshot uses the mint time");
    writeFileSync(ledgerPath, lines([
      repushed(731, at("19:00")),
      { ...eligible(731, at("19:10")), review_key: "W1-T731@head-731" },
      ...Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, i) => repushed(800 + i, at("19:30"))),
      ...Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, i) => eligible(800 + i, at("20:00"))),
    ]));
    assert.deepEqual((await admissionOrder(prs, [], 1, undefined, realLedger)).order,
      [733, 732, 731], "positive control: both receipts change selection before rotation");
    // W1-T14203 keeps a PR's first eligibility row while a sweep.disposed row of it is kept. Drop the rows
    // the control pass wrote, so this case still pins the fallback when neither row is live.
    writeFileSync(ledgerPath, lines(readLedgerLines(ledgerPath).filter((row) => row.step !== "sweep.disposed")));
    const rotated = rotateLedger(ledgerPath, {
      ceilingBytes: statSync(ledgerPath).size - 1, smoothingWindowMs: 0, now: () => new Date(NOW),
    });
    assert.equal(rotated.rotated, true);
    assert.ok(rotated.archivePath);
    const live = readLedgerLines(ledgerPath);
    assert.ok(!live.some((row) => (row.step === "sweep.absent_repush" || row.step === "sweep.review_eligible") &&
      row.pr_number === 731), "neither receipt remains in the actual selection ledger");
    assert.deepEqual((await admissionOrder(prs, [], 1, undefined, realLedger)).order,
      [731, 733, 732], "archive receipts cannot override the neither-row createdAt fallback");
    const updated = { ...prs[0]!, lastActivityAt: at("20:35"), reviewInputDigest: "updated-input" };
    assert.deepEqual((await admissionOrder([updated, prs[1]!, prs[2]!], [], 1, undefined, realLedger)).order,
      [731, 733, 732], "an unminted current head still uses createdAt after re-observation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T12534 criterion 4: delayed overlapping production observations preserve the first row ts across verdicts", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}repush-overlap-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const subject = pr(741, at("09:00"));
  const peer = pr(742, at("20:00"));
  const next = pr(743, "2026-11-13T20:05:00.001Z");
  let appendTime = at("19:59");
  const deps: SweepDeps = {
    ledgerPath, runId: "repush-overlap-test", now: () => Date.parse(appendTime),
    readActiveWorkerCount: () => 0,
    appendLine: (path, row) => appendLedger(path, row, { clock: fixedClock(Date.parse(appendTime)) }),
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, actionable: () => false,
  };
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let delayed: ReturnType<typeof runSweep> | undefined;
  try {
    writeFileSync(ledgerPath, lines([repushed(741, at("19:00"))]));
    delayed = runSweep([subject, pr(749, at("10:00"), { checksState: "red", priorStrikes: 100 })], {
      ...deps,
      fixProgressJudge: async () => {
        entered();
        await gate;
        return { verdict: "continue", reason: "overlap released" };
      },
    });
    await blocked;
    appendTime = at("20:05");
    observeLightPassReviewEligibility([subject], deps);
    const first = readLedgerLines(ledgerPath).filter(row => row.step === "sweep.review_eligible");
    assert.equal(first.length, 1);
    assert.equal(first[0]!.ts, at("20:05"));
    const before = await admissionOrder([subject, peer, next], [], 1, undefined, { ledgerPath });
    assert.deepEqual(before.order, [742, 741, 743]);
    appendTime = at("20:30");
    release();
    await delayed;
    const observations = readLedgerLines(ledgerPath).filter(row => row.step === "sweep.review_eligible" && row.pr_number === 741);
    assert.equal(observations.length, 2, "the full pass observed an older snapshot before awaiting the judge");
    assert.equal(observations[1]!.surface, "full");
    assert.equal(observations[1]!.ts, at("20:30"), "the writer timestamps the delayed observation at append time");
    const updated = { ...subject, lastActivityAt: at("20:35"), reviewInputDigest: "after-verdict" };
    appendLedger(ledgerPath, {
      ts: at("20:34"), run_id: deps.runId, task_id: subject.taskId!, step: "review.posted",
      pr_url: subject.prUrl, headSha: subject.headSha, review_input_digest: "old-input",
      review_key: "W1-T741@head-741#old-input", verdict: "FAIL",
    });
    assert.deepEqual((await admissionOrder([updated, peer, next], [], 1, undefined, { ledgerPath })).order,
      [742, 741, 743], "the first observation stays between the 20:00 and 20:05:00.001 peers");
    // Even a stale explicit timestamp appended later cannot replace the first ledger receipt.
    appendLedger(ledgerPath, {
      run_id: deps.runId, task_id: subject.taskId!,
      ...eligible(741, at("19:58")), step: "sweep.review_eligible", queued_at: at("19:57"),
    });
    assert.deepEqual((await admissionOrder([updated, peer, next], [], 1, undefined, { ledgerPath })).order, [742, 741, 743]);
  } finally {
    release();
    await delayed;
    await drainInFlightReviews({ boundMs: 1000 });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T12534 criterion 3: invalid timestamps and other heads cannot supply a queue key", async () => {
  const { order } = await admissionOrder([
    pr(751, at("09:00")), pr(752, at("10:00")), pr(753, at("19:30")),
  ], [
    repushed(751, "invalid"), repushed(751, at("19:00"), null),
    eligible(751, at("20:30")), repushed(752, at("19:00")),
    eligible(752, "invalid"), eligible(752, at("20:00"), "old-752"),
  ], 1);
  assert.deepEqual(order, [751, 752, 753]);
});

test("W1-T12534 criterion 4: a rotation that keeps the head's rows live leaves its key fixed", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}repush-live-rotation-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const realLedger = { ledgerPath, appendLine: undefined };
  // #761 created 09:00, minted 19:00, first eligible 19:10. #762 (19:05) sits between the 19:10 key and
  // both fallbacks (mint 19:00, createdAt 09:00); #763 (19:20) sits before any later eligibility row.
  const prs = [pr(761, at("09:00")), pr(762, at("19:05")), pr(763, at("19:20"))];
  try {
    writeFileSync(ledgerPath, lines([
      ...Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, i) => eligible(900 + i, at("18:00"))),
      repushed(761, at("19:00")),
      { ...eligible(761, at("19:10")), review_key: "W1-T761@head-761" },
    ]));
    assert.deepEqual((await admissionOrder(prs, [], 1, undefined, realLedger)).order, [762, 761, 763]);
    const rotated = rotateLedger(ledgerPath, {
      ceilingBytes: statSync(ledgerPath).size - 1, smoothingWindowMs: 0, now: () => new Date(NOW),
    });
    assert.equal(rotated.rotated, true);
    const live = readLedgerLines(ledgerPath);
    assert.ok(!live.some((row) => row.pr_number === 900), "the rotation archived the oldest other eligibility row");
    assert.ok(live.some((row) => row.step === "sweep.review_eligible" && row.pr_number === 761), "the head's row is live");
    assert.deepEqual((await admissionOrder(prs, [], 1, undefined, realLedger)).order, [762, 761, 763],
      "the key is the first eligibility ts after the rotation");
    // A verdict and a changed review input at the same head append a later eligibility row; the key stays.
    const updated = { ...prs[0]!, lastActivityAt: at("20:35"), reviewInputDigest: "after-verdict" };
    assert.deepEqual((await admissionOrder([updated, prs[1]!, prs[2]!], [], 1, undefined, realLedger)).order, [762, 761, 763]);
    assert.equal(readLedgerLines(ledgerPath).filter((row) => row.step === "sweep.review_eligible" && row.pr_number === 761)
      .length, 2, "the update appended a later eligibility row");
    assert.deepEqual((await admissionOrder([updated, prs[1]!, prs[2]!], [], 1, undefined, realLedger)).order,
      [762, 761, 763], "the next pass reads the later row and still keys the head by the first one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
