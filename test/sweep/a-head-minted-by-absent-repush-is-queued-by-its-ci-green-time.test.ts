import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RETAINED_LINES_PER_STEP, rotateLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, runSweepLightPass,
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

/** Runs one light pass at `width`, then frees one lane at a time. Returns the first admissions and the full start order. */
async function admissionOrder(prs: OpenPrView[], ledger: Row[], width: number, written?: Row[],
  overrides: Partial<SweepDeps> = {}) {
  const releases = new Map<number, () => void>();
  const started: number[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused", runId: "repush-order-test", now: () => NOW,
    readLedger: () => ledger, readActiveWorkerCount: () => 0,
    appendLine: (_path, row) => { written?.push({ ts: new Date(NOW).toISOString(), ...(row as Row) }); },
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
  }
}

test("W1-T12534 criterion 1: the 20:41 shape admits the PRs green first and queues the re-pushed heads after them", async () => {
  const prs = [
    pr(18328, at("15:39")), pr(18332, at("15:57")), pr(18343, at("17:23")),
    pr(18345, at("18:02")), pr(18346, at("18:15")), pr(18348, at("18:40")),
  ];
  const ledger = [
    eligible(18332, at("16:30")), eligible(18345, at("18:30")), eligible(18346, at("18:45")),
    eligible(18348, at("19:10")),
    repushed(18328, "2026-11-13T19:56:42.000Z"), repushed(18343, "2026-11-13T19:58:18.000Z"),
    eligible(18328, at("20:05")), eligible(18343, at("20:12")),
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

test("W1-T12534 criterion 4: a re-pushed head keeps its key after the ledger cap drops its first rows", async () => {
  const prs = [pr(711, at("09:00")), pr(712, at("12:00")), pr(713, at("19:20"))];
  const minted = [repushed(711, at("19:00")), eligible(711, at("19:10"))];
  const written: Row[] = [];
  // The pass writes a new eligibility row for each head, as it does after a same-head input update.
  const before = await admissionOrder(prs, minted, 1, written);
  assert.deepEqual(before.order, [712, 711, 713]);
  const rewritten = written.filter((row) => row.step === "sweep.review_eligible");
  assert.equal(rewritten.find((row) => row.pr_number === 711)?.queued_at, at("19:10"));
  assert.equal(rewritten.find((row) => row.pr_number === 712)?.queued_at, undefined);
  // The cap drops the oldest eligibility row; then it drops the absent_repush row too.
  const firstEligibleDropped = await admissionOrder(prs, [minted[0]!, ...rewritten], 1);
  assert.deepEqual(firstEligibleDropped.order, [712, 711, 713]);
});

test("W1-T12534 criterion 4: the first eligibility row of a minted head records its own queued time", async () => {
  const written: Row[] = [];
  await admissionOrder([pr(721, at("09:00"))], [repushed(721, at("19:00"))], 1, written);
  const row = written.find((r) => r.step === "sweep.review_eligible" && r.pr_number === 721);
  assert.equal(row?.queued_at, new Date(NOW).toISOString());
});

test("W1-T12534 criterion 4: archive history keeps the key through rotation and a same-head update", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}repush-queue-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const realLedger = { ledgerPath, readLedger: undefined, appendLine: undefined };
  const prs = [pr(731, at("09:00")), pr(732, at("19:05")), pr(733, at("18:00"))];
  const lines = (rows: Row[]) => rows.map((row) => JSON.stringify({ run_id: "repush-order-test", task_id: "SWEEP", ...row }))
    .join("\n") + "\n";
  try {
    writeFileSync(ledgerPath, lines([
      repushed(731, at("19:00")),
      { ...eligible(731, at("19:10")), review_key: "W1-T731@head-731" },
      ...Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, i) => repushed(800 + i, at("19:30"))),
      ...Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, i) => eligible(800 + i, at("20:00"))),
    ]));
    assert.deepEqual((await admissionOrder(prs, [], 1, undefined, realLedger)).order,
      [733, 732, 731]);
    assert.ok(!readLedgerLines(ledgerPath).some((row) => row.step === "sweep.review_eligible" &&
      row.pr_number === 731 && row.queued_at !== undefined),
    "the matching production review key suppresses queued_at backfill before rotation");
    const rotated = rotateLedger(ledgerPath, {
      ceilingBytes: statSync(ledgerPath).size - 1, smoothingWindowMs: 0, now: () => new Date(NOW),
    });
    assert.equal(rotated.rotated, true);
    const live = readLedgerLines(ledgerPath);
    assert.ok(!live.some((row) => row.step === "sweep.absent_repush" && row.pr_number === 731),
      "the mint row left the live ledger");
    assert.ok(!live.some((row) => row.step === "sweep.review_eligible" && row.ts === at("19:10")),
      "the first eligibility row left the live ledger");
    assert.ok(!live.some((row) => row.step === "sweep.review_eligible" && row.pr_number === 731),
      "no carried row for the matching key survives the cap");
    assert.deepEqual((await admissionOrder(prs, [], 1, undefined, realLedger)).order,
      [733, 732, 731], "cap removal alone keeps the first eligibility time");
    const updated = { ...prs[0]!, lastActivityAt: at("20:35"), reviewInputDigest: "updated-input" };
    assert.deepEqual((await admissionOrder([updated, prs[1]!, prs[2]!], [], 1, undefined, realLedger)).order,
      [733, 732, 731], "same-head re-observation keeps the head behind its 19:05 peer");
    const archivePath = rotated.archivePath;
    assert.ok(archivePath);
    assert.ok(archivePath.endsWith(".gz"));
    writeFileSync(archivePath, "unreadable archive");
    await assert.rejects(admissionOrder([updated, prs[1]!, prs[2]!], [], 1, undefined, realLedger),
      /repushed-head queue history unreadable/, "incomplete history must not assign a new key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
