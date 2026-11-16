/**
 * W1-T12954: the sweep's fix-round and refresh history (the rows the conflict round and the terminal design handoff
 * read) comes from an awaited reader that loads rotations off the loop and keeps them across passes. Before, one
 * synchronous union read of every rotation blocked the core daemon loop for up to 354 s.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { REFRESH_CLEARANCE_STEP } from "#src/lib/base-reproduction.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import {
  BASE_FIXED_REFRESH_STEP, BASE_RED_REFRESH_STEP, conflictRoundHeldHead, readSweepRepairHistory, terminalFixDesignHandoff,
} from "#src/lib/sweep.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const STEPS = ["fix.base_refreshed", BASE_RED_REFRESH_STEP, BASE_FIXED_REFRESH_STEP, REFRESH_CLEARANCE_STEP,
  "fix.dispatch", "fix.retrigger", "fix.done", "fix.needs_design", "sweep.conflict_regenerated"];
const TASK = "W1-T7001";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const PR = { taskId: TASK, prNumber: 41, prUrl: "https://github.com/o/r/pull/41", headSha: HEAD_B };

let tick = 0;
const at = (): string => new Date(Date.UTC(2026, 9, 1) + (tick++) * 1000).toISOString();
const row = (step: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ts: at(), run_id: `r-${tick}`, task_id: TASK, step, ...extra });

/** The strict union read the sweep made before W1-T12954, for the same directory. */
const syncRead = (dir: string) => readLedgerUnionRecordsSync(dir, { step: STEPS, refuseIncomplete: true });

test("W1-T12954 criterion 1: the repair-history read over at least 50 MB of rotations lets a 50 ms timer fire every 500 ms", async (scope) => {
  const pad = "p".repeat(24);
  const rotations = Array.from({ length: 12 }, (_, r) => ({
    at: `2026-10-${String(r + 1).padStart(2, "0")}T00:00:00.000Z`, gz: true,
    rows: Array.from({ length: 50_000 }, (_, i) => i % 20 === 0
      ? row("fix.dispatch", { round_id: `round-${r}-${i}`, head_sha: HEAD_A, mode: "merge-conflict" })
      : row("sweep.disposed", { pr_number: i, note: pad })),
  }));
  const bytes = rotations.reduce((sum, rotation) => sum + rotation.rows.reduce((n, r) => n + JSON.stringify(r).length + 1, 0), 0);
  assert.ok(bytes >= 50 * 1024 * 1024, `the rotations hold ${bytes} bytes`);
  const ledger = writeLedger([row("fix.done", { round_id: "live", head_sha: HEAD_A, pushed_head_sha: HEAD_B })], { scope, rotations });

  const fires: number[] = [];
  const started = performance.now();
  const timer = setInterval(() => fires.push(performance.now()), 50);
  let read;
  try {
    read = await readSweepRepairHistory(ledger.path);
  } finally {
    clearInterval(timer);
  }
  const ended = performance.now();
  assert.equal(read.ok, true);
  assert.equal(read.rows.length, 12 * 2_500 + 1);
  const marks = [started, ...fires, ended];
  const gaps = marks.slice(1).map((mark, i) => mark - marks[i]!);
  assert.ok(Math.max(...gaps) <= 500, `longest loop gap ${Math.round(Math.max(...gaps))} ms over a ${Math.round(ended - started)} ms read`);
});

test("W1-T12954 criterion 2: the conflict round and the design handoff get the same rows as the synchronous read", async (scope) => {
  const dispatch = row("fix.dispatch", { round_id: "r1", head_sha: HEAD_A, mode: "merge-conflict" });
  const question = row("fix.needs_design", { head_sha: HEAD_A, reason: "needs a design", host: "h", actor_pid: 7 });
  const done = row("fix.done", { round_id: "r1", head_sha: HEAD_A, pushed_head_sha: HEAD_B });
  const ledger = writeLedger([
    done, row(BASE_RED_REFRESH_STEP, { pr_number: 41 }), row("review.done"), row("fix.retrigger", { round_id: "r2" }),
  ], { scope, rotations: [
    { at: "2026-10-01T00:00:00.000Z", gz: true, rows: [dispatch, row("sweep.disposed"), question, row(REFRESH_CLEARANCE_STEP, { pr_number: 41 })] },
    { at: "2026-10-02T00:00:00.000Z", rows: [dispatch, row("sweep.conflict_regenerated", { pr_number: 41 }), row("fix.base_refreshed"),
      row(BASE_FIXED_REFRESH_STEP, { pr_number: 41 })] },
  ] });
  writeFileSync(ledger.path, `${readFileSync(ledger.path, "utf8")}{"torn":\n`);

  const want = syncRead(ledger.dir);
  const got = await readSweepRepairHistory(ledger.path);
  assert.equal(want.ok, true);
  assert.equal(got.ok, true);
  assert.deepEqual(got.rows, want.rows, "same rows in the same order");
  assert.equal(got.rows.filter((r) => r.round_id === "r1" && r.step === "fix.dispatch").length, 1, "a replayed row is read once");
  assert.deepEqual([...new Set(got.rows.map((r) => r.step))].sort(), [...STEPS].sort());

  const asyncArchive = () => (got.ok ? got.rows : undefined);
  const syncArchive = () => (want.ok ? want.rows : undefined);
  const holds = (head: string) => head === HEAD_A;
  assert.equal(conflictRoundHeldHead(PR, [], undefined, asyncArchive, holds), HEAD_A, "the archive walks the push back to the held head");
  assert.equal(conflictRoundHeldHead(PR, [], undefined, syncArchive, holds), HEAD_A);
  assert.equal(conflictRoundHeldHead(PR, [], undefined, () => undefined, holds), HEAD_B, "control: no archive, no walk");
  const atA = { ...PR, headSha: HEAD_A };
  assert.deepEqual(terminalFixDesignHandoff(atA, [], asyncArchive), terminalFixDesignHandoff(atA, [], syncArchive));
  assert.notEqual(terminalFixDesignHandoff(atA, [], asyncArchive).kind, "none", "the archived question is found");

  // An incomplete corpus gives undefined to both readers' callers, as refuseIncomplete did.
  const broken = writeLedger([done], { scope, rotations: [{ at: "2026-10-01T00:00:00.000Z", rows: [dispatch] }] });
  writeFileSync(join(broken.dir, "ledger.2026-10-03T00-00-00-000Z.ndjson.gz"), "not gzip");
  const strict = syncRead(broken.dir);
  const incomplete = await readSweepRepairHistory(broken.path);
  assert.equal(strict.ok, false);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.rows.length, 0);
  assert.ok(incomplete.unread.some((path) => path.endsWith(".ndjson.gz")), "the unread rotation is named");
  const archive = () => (incomplete.ok ? incomplete.rows : undefined);
  assert.equal(archive(), undefined);
  assert.equal(conflictRoundHeldHead(PR, [done], undefined, archive, holds), HEAD_B, "an incomplete corpus releases nothing new");
});

test("W1-T12954 criterion 3: a second pass parses only the live file and the rotation cut since the first", async (scope) => {
  const kept = row("fix.done", { round_id: "r1", head_sha: HEAD_A, pushed_head_sha: HEAD_B });
  const live = row("fix.dispatch", { round_id: "live-1" });
  const ledger = writeLedger([live], { scope, rotations: [
    { at: "2026-10-01T00:00:00.000Z", rows: [kept, row("sweep.disposed")] },
  ] });
  const rotation = join(ledger.dir, "ledger.2026-10-01T00-00-00-000Z.ndjson");
  utimesSync(rotation, 1_790_000_000, 1_790_000_000);
  const first = await readSweepRepairHistory(ledger.path);
  assert.equal(first.ok, true);
  assert.deepEqual(first.rows.map((r) => r.round_id), ["r1", "live-1"]);

  // Rewrite the first rotation in place with the same size and time, and drop the durable digests: a pass that
  // parsed it again would read the changed head; a kept rotation keeps the old one.
  const size = statSync(rotation).size;
  writeFileSync(rotation, readFileSync(rotation, "utf8").replace(HEAD_A, "c".repeat(40)));
  utimesSync(rotation, 1_790_000_000, 1_790_000_000);
  assert.equal(statSync(rotation).size, size);
  rmSync(join(ledger.dir, "cache"), { recursive: true, force: true });
  // A rotation cut: the live rows move into a new rotation and the live file starts again.
  writeLedger([], { dir: ledger.dir, rotations: [{ at: "2026-10-02T00:00:00.000Z", rows: [live, row("fix.dispatch", { round_id: "cut" })] }] });
  ledger.append([row("fix.dispatch", { round_id: "live-2" })]);

  const second = await readSweepRepairHistory(ledger.path);
  assert.equal(second.ok, true);
  assert.deepEqual(second.rows.map((r) => r.round_id), ["r1", "live-1", "cut", "live-2"], "the new rotation and the new live rows are read");
  assert.equal(second.rows[0]!.head_sha, HEAD_A, "the first rotation was not parsed again");
});
