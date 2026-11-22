import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { appendLedger, MAX_RETAINED_LINES_PER_STEP, rotateLedger } from "#src/lib/ledger.js";
import { fixedClock } from "#src/lib/clock.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import type { FixtureScope } from "#test/helpers/owned-fixture-dir.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, runSweepLightPass, type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

// A PR that re-enters review after its earlier-head eligibility rows fall out of the per-step cap must
// still be keyed as re-entered, while the sweep keeps a sweep.disposed row for it.

const NOW = Date.parse("2026-11-21T20:41:00Z");
const at = (hhmm: string): string => `2026-11-21T${hhmm}:00.000Z`;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
type Row = Record<string, unknown>;

function pr(n: number, created: string, head = `head-${n}`): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: head, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: created, createdAt: created,
  };
}
const eligible = (n: number, ts: string, head = `head-${n}`): Row =>
  ({ ts, step: "sweep.review_eligible", pr_number: n, head_sha: head, review_key: `${n}@${head}@${ts}` });
const disposed = (n: number, ts: string, head: string): Row =>
  ({ ts, step: "sweep.disposed", pr_number: n, head_sha: head, disposition: "await_review", acted: false });
const others = (count: number, from = 1000): Row[] =>
  Array.from({ length: count }, (_, i) => eligible(from + i, `2026-11-21T11:${String(i % 60).padStart(2, "0")}:00.000Z`));
const stamped = (row: Row): Row => ({ run_id: "t14203", task_id: "SWEEP", ...row });
const paddingRow = (): Row => ({ run_id: "t14203", task_id: "noise", step: "ci.polling", padding: "x".repeat(64) });
const padding = (): string => JSON.stringify(paddingRow()) + "\n";

/** Writes the rows plus one padding line through the shared ledger fixture, rotates once just over
 *  the size, and returns the ledger path with the rotation result. */
function rotateRows(t: FixtureScope, rows: Row[]) {
  const { path: ledgerPath } = writeLedger([...rows.map(stamped), paddingRow()], { scope: t });
  return { ledgerPath, result: rotateAgain(ledgerPath) };
}
function rotateAgain(ledgerPath: string) {
  const result = rotateLedger(ledgerPath, {
    ceilingBytes: statSync(ledgerPath).size - 1, smoothingWindowMs: 0, now: () => new Date(NOW),
  });
  assert.equal(result.rotated, true);
  return result;
}
const eligibleRows = (ledgerPath: string): Row[] =>
  readLedgerLines(ledgerPath).filter((row) => row.step === "sweep.review_eligible");

/** Runs one production light pass at width 1 on the real ledger file and returns the review start order. */
async function admissionOrder(prs: OpenPrView[], ledgerPath: string): Promise<number[]> {
  const releases = new Map<number, () => void>();
  const started: number[] = [];
  const deps: SweepDeps = {
    ledgerPath, runId: "t14203", now: () => NOW, readActiveWorkerCount: () => 0,
    appendLine: (path, row) => appendLedger(path, row, { clock: fixedClock(NOW) }),
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      await new Promise<void>((resolve) => { releases.set(p.prNumber, resolve); });
    },
  };
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };
  try {
    await runSweepLightPass(prs, deps, policy);
    for (let i = 0; i < 100 && started.length < 1; i++) await settle();
    for (let freed = 0; freed < started.length && freed < prs.length; freed++) {
      releases.get(started[freed]!)?.();
      for (let i = 0; i < 100 && started.length < Math.min(prs.length, freed + 2); i++) await settle();
    }
    return [...started];
  } finally {
    for (const release of releases.values()) release();
    await drainInFlightReviews({ boundMs: 1000 });
  }
}

// PR 9 was created at 09:00 and first eligible at h1 at 10:00; it is now at fix head h2. PR 10 was created
// at 12:00 and is at its first head, so it ranks on createdAt. Re-entered, PR 9 queues from now (20:41).
const prs = (): OpenPrView[] => [pr(9, at("09:00"), "h2"), pr(10, at("12:00"))];
const reentryRows = (): Row[] => [
  eligible(9, at("10:00"), "h1"),
  ...others(MAX_RETAINED_LINES_PER_STEP + 10),
  disposed(9, at("20:00"), "h1"),
];

test("W1-T14203 criterion 1: rotation keeps the h1 row and PR 9 at h2 still queues as re-entered", async (t) => {
  const { ledgerPath } = rotateRows(t, reentryRows());
  const live = eligibleRows(ledgerPath);
  assert.ok(!live.some((row) => row.pr_number === 1000), "the cap archived the oldest other eligibility row");
  assert.ok(live.some((row) => row.pr_number === 9 && row.head_sha === "h1" && row.ts === at("10:00")),
    "the earliest eligibility row of PR 9 is live");
  assert.deepEqual(await admissionOrder(prs(), ledgerPath), [10, 9],
    "PR 9 at h2 queues from its re-entry (now), not from its createdAt");
});

test("W1-T14203 criterion 2: a PR with no kept sweep.disposed row is capped as before", async (t) => {
  const { ledgerPath, result } = rotateRows(t, reentryRows().filter((row) => row.step !== "sweep.disposed"));
  const live = eligibleRows(ledgerPath);
  assert.equal(live.length, MAX_RETAINED_LINES_PER_STEP);
  assert.ok(!live.some((row) => row.pr_number === 9), "without a disposed row the h1 row is archived");
  assert.ok(result.archivePath, "the rotation wrote an archive");
  assert.ok(gunzipSync(readFileSync(result.archivePath)).toString("utf8").includes('"head_sha":"h1"'),
    "the h1 row is in the archive");
  assert.deepEqual(await admissionOrder(prs(), ledgerPath), [9, 10], "PR 9 falls back to its createdAt");
});

test("W1-T14203 criterion 2: kept rows are one per PR and bounded by the distinct disposed PRs", (t) => {
  const early = [
    ...Array.from({ length: 30 }, (_, i) => eligible(9, `2026-11-21T08:${String(i).padStart(2, "0")}:00.000Z`, `h${i}`)),
    eligible(20, at("08:40")), eligible(20, at("08:41")), eligible(21, at("08:42")),
  ];
  const { ledgerPath } = rotateRows(t, [
    ...early, ...others(MAX_RETAINED_LINES_PER_STEP),
    disposed(9, at("19:00"), "h0"), disposed(9, at("20:00"), "h29"), disposed(20, at("20:00"), "head-20"),
    disposed(30, at("20:00"), "head-30"),
  ]);
  const live = eligibleRows(ledgerPath);
  const rescued = live.filter((row) => (row.pr_number as number) < 1000);
  assert.deepEqual(rescued.map((row) => [row.pr_number, row.head_sha, row.ts]),
    [[9, "h0", "2026-11-21T08:00:00.000Z"], [20, "head-20", at("08:40")]],
    "the first row of each disposed PR, none for PR 21, none for PR 30 that has no dropped row");
  assert.ok(rescued.length <= new Set([9, 20, 30]).size);
  assert.equal(live.length, MAX_RETAINED_LINES_PER_STEP + 2);
});

test("W1-T14203 criterion 3: kept rows count as kept in the archived-line count, and a second rotation keeps them", (t) => {
  const input = reentryRows();
  const { ledgerPath, result } = rotateRows(t, input);
  const kept = readLedgerLines(ledgerPath).filter((row) => row.run_id === "t14203");
  assert.equal(result.archivedLineCount, input.length + 1 - kept.length,
    "every input line is either kept live or counted as archived");
  assert.equal(result.archivedLineCount, 10 + 1, "ten capped rows and the padding line; the h1 row is kept");
  const first = eligibleRows(ledgerPath);
  appendFileSync(ledgerPath, padding());
  const before = readLedgerLines(ledgerPath);
  const again = rotateAgain(ledgerPath);
  assert.deepEqual(eligibleRows(ledgerPath), first, "the second rotation keeps the same eligibility rows");
  const keptAgain = readLedgerLines(ledgerPath).filter((row) => row.run_id === "t14203");
  assert.equal(again.archivedLineCount, before.length - keptAgain.length,
    "the new padding line and the first rotation's own row are archived; nothing else is");
  assert.equal(keptAgain.length, kept.length);
});
