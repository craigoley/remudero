// W1-T12756: ledger rotation keeps the first sweep.review_eligible row of each head that a kept
// sweep.absent_repush row names, so W1-T12534's live-only fold keys that head by the same time after rotation.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_RETAINED_LINES_PER_STEP, rotateLedger } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-11-14T23:40:00Z");
const at = (minutes: number) => new Date(NOW - 24 * 3_600_000 + minutes * 60_000).toISOString();
const repush = (pr: number, head: string, minute: number): Row =>
  ({ ts: at(minute), run_id: "sweep-1", task_id: "SWEEP", step: "sweep.absent_repush", pr_number: pr, new_head: head });
const eligible = (pr: number, head: string, minute: number): Row =>
  ({ ts: at(minute), run_id: "sweep-1", task_id: "SWEEP", step: "sweep.review_eligible", pr_number: pr, head_sha: head });
/** Rows of no retained step, enough to push the file over the ceiling so rotation runs. */
const filler = (n: number): Row[] => Array.from({ length: n }, (_, i) =>
  ({ ts: at(1300), run_id: "noise", task_id: "NOISE", step: "w1-t12756.noise", n: i, pad: "x".repeat(400) }));

function rotate(rows: Row[]): { live: Row[]; archived: number | undefined } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12756-`));
  try {
    const path = join(dir, "ledger.ndjson");
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const result = rotateLedger(path, { ceilingBytes: 256 * 1024, smoothingWindowMs: 0, now: () => new Date(NOW) });
    assert.equal(result.rotated, true, "the fixture is over the ceiling, so rotation runs");
    const live = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
    return { live, archived: result.archivedLineCount };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** W1-T12534's key for a minted head, read from the live rows only: its first eligibility time, else its mint time. */
function queuedAt(rows: readonly Row[], pr: number, head: string): string | undefined {
  const first = rows.find((row) => row.step === "sweep.review_eligible" && row.pr_number === pr && row.head_sha === head);
  const minted = rows.find((row) => row.step === "sweep.absent_repush" && row.pr_number === pr && row.new_head === head);
  return (first ?? minted)?.ts as string | undefined;
}
const eligibility = (rows: readonly Row[]) => rows.filter((row) => row.step === "sweep.review_eligible");

test("W1-T12756 criterion 1: rotation keeps the first eligibility row of a head a kept sweep.absent_repush row names, so its key does not move", () => {
  const others = Array.from({ length: MAX_RETAINED_LINES_PER_STEP + 4 }, (_, i) => eligible(1000 + i, "other", 20 + i));
  const rows = [repush(18533, "minted", 10), eligible(18533, "minted", 15), ...others, eligible(18533, "minted", 1200),
    ...filler(700)];
  const before = queuedAt(rows, 18533, "minted");
  assert.equal(before, at(15));
  const { live } = rotate(rows);
  assert.equal(queuedAt(live, 18533, "minted"), before, "a light pass after rotation keys the head by the same time");
  assert.equal(eligibility(live).filter((row) => row.pr_number === 18533).length, 2);
});

test("W1-T12756 criterion 2: invariant cap-unchanged-for-other-heads — other heads are capped as before, and the extra rows are at most one per kept repush row", () => {
  const cap = MAX_RETAINED_LINES_PER_STEP;
  // cap + 1 repush rows: the oldest is dropped by its own cap, so the head it names gets no kept row.
  const repushes = Array.from({ length: cap + 1 }, (_, i) => repush(2000 + i, "minted", i));
  const firsts = Array.from({ length: cap + 1 }, (_, i) => eligible(2000 + i, "minted", 300 + i));
  const seconds = Array.from({ length: 3 }, (_, i) => eligible(2000 + i, "minted", 600 + i));
  const others = Array.from({ length: cap }, (_, i) => eligible(5000 + i, "other", 700 + i));
  const rows = [...repushes, ...firsts, ...seconds, ...others, ...filler(700)];
  const { live, archived } = rotate(rows);
  const kept = eligibility(live);
  const newest = eligibility(rows).slice(-cap);
  assert.deepEqual(kept.filter((row) => row.head_sha === "other"), newest.filter((row) => row.head_sha === "other"),
    "every row of a head no kept repush row names is capped exactly as before");
  const extra = kept.filter((row) => !newest.includes(row) && !newest.some((n) => JSON.stringify(n) === JSON.stringify(row)));
  const keptRepushes = live.filter((row) => row.step === "sweep.absent_repush");
  assert.equal(keptRepushes.length, cap);
  assert.ok(extra.length <= keptRepushes.length, `${extra.length} extra rows for ${keptRepushes.length} kept repush rows`);
  assert.deepEqual(extra.map((row) => row.pr_number), Array.from({ length: cap }, (_, i) => 2001 + i),
    "one first row for each head a kept repush row names; the dropped repush row's head keeps none");
  assert.equal(kept.some((row) => row.pr_number === 2000 && row.ts === at(300)), false);
  assert.deepEqual(kept, eligibility(rows).filter((row) => kept.some((k) => JSON.stringify(k) === JSON.stringify(row))),
    "file order is kept");
  assert.equal(archived, rows.length - live.length, "the kept rows are not counted as archived");
});
