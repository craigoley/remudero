import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDetachedWorkHost, type DetachedWorkSpec, type spawnRunChild, type startRunChildProbe } from "#src/lib/run-child.js";
import { bootRunChildMode } from "#src/lib/run-child-mode.js";
import type { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";

// W1-T11341. MEASURED 2026-11-04 on core: a 353 s loop stall profiled sweep → spawnReview → detachedWorkModeNow →
// readRunChildModeUnion → readLedgerUnionRecordsSync at 34.2 s inclusive. A review spawn now decides `auto` from the
// tracker the daemon's boot folds, which read the union once, so N spawns after boot make zero union reads. COUNTS AND
// DECISIONS ONLY: no timing.

/** One whole promoted boot cycle (the shape W1-T9114's own suite promotes on), so `auto` decides `on`. */
const PROMOTED = [
  { step: "daemon.start", ts: "2026-11-04T12:00:00Z" },
  { step: "run_child.shadow", ts: "2026-11-04T12:01:00Z", contract: "ok", tree_peak_bytes: 100, class_estimate_bytes: 200 },
  { step: "daemon.start", ts: "2026-11-04T12:02:00Z" },
  { step: "run_child.adoption_pass", ts: "2026-11-04T12:02:01Z", live: 1, adopted: 1, misidentified: 0, unreadable: 0 },
];
const LOST = { step: "run_child.lost", ts: "2026-11-04T12:03:00Z", detail: "process exited without a terminal status" };
/** A review held a drain over the measured window, so a review placed `on` moves to a child. */
const DRAIN = [{ step: "daemon.freshness_drain.completed", duration_ms: 1_000, waited_on: [{ what: "review", kind: "review", settled_after_ms: 1_000 }] }];
const HEAD = "a".repeat(40);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-mode-from-tracker-"));
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  // The live ledger file starts EMPTY: only the boot's own (counted) union read sees the promoted cycle, so a host that
  // re-reads the file per spawn finds no promotion and cannot decide `on`.
  const ledger = join(stateRoot, "ledger.ndjson");
  const writeLedger = (rows: Array<Record<string, unknown>>) => writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  let unionReads = 0;
  const read = ((_dir: string) => {
    unionReads += 1;
    return { ok: true, rows: [...PROMOTED], unread: [] };
  }) as unknown as typeof readLedgerUnionRecordsSync;
  const rows: Array<Record<string, unknown>> = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, ...extra }); };
  const spawned: string[] = [];
  let lose = false;
  const spawn = (async (input: { work?: DetachedWorkSpec; log: (step: string, extra?: Record<string, unknown>) => void }) => {
    spawned.push(`PR${input.work!.prNumber}`);
    // A child the host started and lost: the host ledgers that loss through its own log, as spawnRunChild does.
    if (lose) input.log("run_child.lost", { run_id: `lost-${input.work!.prNumber}`, detail: LOST.detail });
    return { started: true, runId: `child-${input.work!.prNumber}`, dir: root, pid: 1, settled: new Promise(() => {}), abort: async () => ({}) };
  }) as unknown as typeof spawnRunChild;
  const host = () => createDetachedWorkHost({
    stateRoot, repoDir: root, root, repo: "fixture", log, readMode: () => "auto", readLedger: () => DRAIN, spawn,
    readUnion: (dir: string) => ({ rows: (read(dir, {} as never) as { rows: Array<Record<string, unknown>> }).rows, unread: [] }),
    probe: (async () => ({ started: false, reason: "fixture probe" })) as unknown as typeof startRunChildProbe,
  });
  const ask = (h: ReturnType<typeof host>, prNumber: number) => h.spawnReview({ pr: { prNumber, headSha: HEAD }, reviewKey: `key-${prNumber}`, reviewAttemptId: undefined });
  return {
    stateRoot, writeLedger, host, ask, spawned, rows, log, read,
    reads: () => unionReads, loseNext: () => { lose = true; }, cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("W1-T11341 criterion 2: N review spawns after boot make zero union reads, and each still starts its child under `auto`", async () => {
  const f = fixture();
  try {
    bootRunChildMode({ stateDir: f.stateRoot, auto: true, liveRows: [], log: f.log, read: f.read });
    const afterBoot = f.reads();
    assert.equal(afterBoot, 1, "the boot reads the union once");
    const h = f.host();
    const N = 5;
    for (let pr = 1; pr <= N; pr += 1) assert.notEqual(await f.ask(h, pr), undefined, `review ${pr} starts as a child: auto decided on`);
    assert.equal(f.spawned.length, N);
    assert.equal(f.reads() - afterBoot, 0, "no spawn re-read the union: each decided from the boot's tracker");
  } finally {
    f.cleanup();
  }
});

test("W1-T11341 criterion 2: a row written behind the daemon's back is not re-read per spawn; the boot's tracker decides", async () => {
  const f = fixture();
  try {
    bootRunChildMode({ stateDir: f.stateRoot, auto: true, liveRows: [], log: f.log, read: f.read });
    const h = f.host();
    // A per-spawn union re-read would see this loss and demote detached work to shadow (W1-T9114). The tracker the daemon
    // folds observes the rows this process writes, not the file under it, so the decision stands.
    f.writeLedger([...PROMOTED, LOST]);
    assert.notEqual(await f.ask(h, 7), undefined, "the review still starts as a child");
    assert.deepEqual(f.spawned, ["PR7"]);
  } finally {
    f.cleanup();
  }
});

test("W1-T11341 criterion 2: a run-child row the host itself writes reaches the tracker, so the next spawn decides on it", async () => {
  const f = fixture();
  try {
    bootRunChildMode({ stateDir: f.stateRoot, auto: true, liveRows: [], log: f.log, read: f.read });
    const h = f.host();
    f.loseNext();
    assert.notEqual(await f.ask(h, 8), undefined, "the first review starts as a child");
    assert.ok(f.rows.some((row) => row.step === "run_child.lost"), "the host ledgered the loss through its log");
    // The loss the host wrote demotes detached work: the next review stays in process, decided without a union read.
    const before = f.reads();
    assert.equal(await f.ask(h, 9), undefined, "after its own lost child, the host's next review stays in process");
    assert.deepEqual(f.spawned, ["PR8"]);
    assert.equal(f.reads(), before, "that decision read no union either");
  } finally {
    f.cleanup();
  }
});
