import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { appendLedger, ledgerRotationLockPath, rotateLedger, type LedgerLine } from "../src/lib/ledger.js";

// ── R-1 (docs/audits/recon-2026-09-05.md, reproduced twice at f7ceb86 / origin/main 35b6683):
// `appendLedger` calls `rotateLedger` with no cross-process exclusion (src/lib/ledger.ts
// :190-192). `rmd serve` and the daemon append to ONE ledger. When two processes append while
// the live file is over the ceiling, both snapshot the big file; the second rotation's
// catch-up read (:1486-1489, `sizeNow > size0 ? readSyncRange(...) : ""`) sees the FIRST's
// small live file, takes tail = "", and its final rename (:1546, `writeFileAtomic(path,
// newLiveContent)`) overwrites it. Every line appended between the two renames is afterwards
// in neither the live file nor any archive, and each rotator leaves a duplicate archive.
//
// THE REPRODUCTION SHAPE, driven through rotateLedger's injected `now()` seam: `now` is
// called twice per rotation (archive name, then the retention clock). On its SECOND call —
// with the outer rotation's snapshot taken and its archive written, before its catch-up read
// — this test runs a whole nested `rotateLedger` to completion (the second process) and then
// `appendLedger`s one line X (the row that lands between the two renames). Unlocked, the
// nested rotation shrinks the live file, X lands on the small file, the outer catch-up reads
// an empty tail, and the outer rename drops X. Locked, the nested call finds a live holder
// and skips, X lands on the still-big live file, and the outer catch-up folds it in. ────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-ledger-rotation-lock-"));
}

function noiseLine(n: number): string {
  return JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

/** Every rotation archive next to the live file, in either form (`.ndjson.gz` or plain). */
function archivesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f !== "ledger.ndjson" && (f.endsWith(".ndjson") || f.endsWith(".ndjson.gz")))
    .sort();
}

function readArchiveContent(path: string): string {
  const buf = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
}

/** Union read — the live file plus every archive — because the claim under test is "the
 *  appended line exists SOMEWHERE", never "it is live" (a rotation may legitimately archive
 *  it if it lands in the snapshot). */
function unionText(dir: string, ledgerPath: string): string {
  return [readFileSync(ledgerPath, "utf8"), ...archivesIn(dir).map((f) => readArchiveContent(join(dir, f)))].join("");
}

function writeOversizedLedger(ledgerPath: string, ceiling: number): void {
  const lines: string[] = [];
  while (Buffer.byteLength(lines.join("\n") + "\n", "utf8") <= ceiling * 2) lines.push(noiseLine(lines.length));
  writeFileSync(ledgerPath, lines.join("\n") + "\n");
  assert.ok(statSync(ledgerPath).size > ceiling, "fixture: the ledger starts over the ceiling");
}

const CEILING = 4096;

test("a concurrent rotator cannot drop a row appended between two renames — the lock makes the second rotation skip, and the appended line survives", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath, CEILING);
    const lockPath = ledgerRotationLockPath(ledgerPath);

    const X: LedgerLine = { step: "review.posted", run_id: "run-X", task_id: "W1-T1", pr_number: 4075 };
    let nowCalls = 0;
    let nestedResult: ReturnType<typeof rotateLedger> | undefined;
    let lockSeenDuringNested: boolean | undefined;

    const outer = rotateLedger(ledgerPath, {
      ceilingBytes: CEILING,
      now: () => {
        nowCalls++;
        if (nowCalls === 2) {
          // THE SECOND PROCESS: a whole rotation, start to finish, inside the outer one's
          // window — then the append that R-1 loses.
          lockSeenDuringNested = existsSync(lockPath);
          nestedResult = rotateLedger(ledgerPath, { ceilingBytes: CEILING });
          appendLedger(ledgerPath, X, { ceilingBytes: CEILING });
        }
        return new Date("2026-01-01T00:00:00.000Z"); // a fixed stamp, distinct from the nested rotation's real clock
      },
    });

    assert.equal(nowCalls >= 2, true, "fixture: the injected clock was read at least twice, so the nested rotation ran");
    assert.equal(outer.rotated, true, "the outer rotation completes");

    // THE CLAIM FIRST: the row survives, and there is one archive — the two things R-1 breaks.
    const union = unionText(dir, ledgerPath);
    assert.match(union, /"run_id":"run-X"/, "the line appended between the two rotations exists in the live file or an archive — R-1 dropped it from both");
    assert.match(readFileSync(ledgerPath, "utf8"), /"run_id":"run-X"/, "and it is in the LIVE file — the outer catch-up read folded it in");
    assert.equal(archivesIn(dir).length, 1, `exactly one archive per rotation — R-1 emitted a duplicate; saw ${archivesIn(dir).join(", ")}`);

    // THE MECHANISM: how the claim holds.
    assert.equal(lockSeenDuringNested, true, "the outer rotation holds its lock while it is between snapshot and rename");
    assert.deepEqual(nestedResult, { rotated: false }, "the nested rotator finds a live holder and SKIPS rather than rotating under it");
    assert.equal(existsSync(lockPath), false, "the lock is released in finally");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale rotation lock (dead pid, old startedAt) is reclaimed and the rotation proceeds", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath, CEILING);
    const lockPath = ledgerRotationLockPath(ledgerPath);

    // A pid that provably no longer exists: a child that has already exited and been reaped.
    const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
    assert.equal(child.status, 0, "fixture: the throwaway child ran");
    const deadPid = child.pid as number;
    assert.ok(deadPid > 0, "fixture: spawnSync reports the child's pid");
    const staleRaw = JSON.stringify({ pid: deadPid, host: hostname(), startedAt: "2020-01-01T00:00:00.000Z" });
    writeFileSync(lockPath, staleRaw);

    const result = rotateLedger(ledgerPath, { ceilingBytes: CEILING });
    assert.equal(result.rotated, true, "a dead holder does not block rotation");
    assert.equal(archivesIn(dir).length, 1, "the rotation archived once");
    assert.equal(statSync(ledgerPath).size <= CEILING, true, "the live file converged under the ceiling");
    assert.equal(existsSync(lockPath), false, "the stale lock was reclaimed (and this rotation's own lock released) — an unlocked rotation leaves the stale file untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a LIVE rotation lock holder makes appendLedger skip rotation — the append still lands, no archive is written", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath, CEILING);
    const lockPath = ledgerRotationLockPath(ledgerPath);

    // THIS process, started before `startedAt`: alive by pid, matching host, and its real start
    // time precedes the lock's — isHolderStale's every rung says "live".
    const liveRaw = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
    writeFileSync(lockPath, liveRaw);

    const Y: LedgerLine = { step: "run.start", run_id: "run-Y", task_id: "W1-T2" };
    appendLedger(ledgerPath, Y, { ceilingBytes: CEILING });

    assert.match(readFileSync(ledgerPath, "utf8"), /"run_id":"run-Y"/, "the append lands regardless of the lock — append is the priority");
    assert.equal(archivesIn(dir).length, 0, "rotation was skipped: no archive");
    assert.equal(statSync(ledgerPath).size > CEILING, true, "rotation was skipped: the live file is still over the ceiling");
    assert.equal(readFileSync(lockPath, "utf8"), liveRaw, "the live holder's lock is neither reclaimed nor rewritten");
    assert.deepEqual(rotateLedger(ledgerPath, { ceilingBytes: CEILING }), { rotated: false }, "a direct rotateLedger call skips for the same reason");

    // POSITIVE CONTROL: it was the lock, and nothing else, that held rotation back.
    unlinkSync(lockPath);
    const after = rotateLedger(ledgerPath, { ceilingBytes: CEILING });
    assert.equal(after.rotated, true, "with the holder gone the same ledger rotates");
    assert.equal(archivesIn(dir).length, 1, "and archives exactly once");
    assert.match(unionText(dir, ledgerPath), /"run_id":"run-Y"/, "Y is still in the union after the deferred rotation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pre-rename identity guard: a file replaced under a held rotation is never renamed over — the rotation withdraws, its lines stay, the archive is kept", () => {
  // DEFENCE IN DEPTH for the case the lock cannot cover: a rotator that does not honour it
  // (a pre-lock binary still running off the mount, or a holder mis-judged stale and
  // reclaimed). It replaces the live file while this rotation is between snapshot and
  // rename. Without the guard this rotation's rename would clobber that replacement — and
  // every line appended to it — exactly R-1's loss by another door.
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath, CEILING);
    const replacement = JSON.stringify({ step: "review.posted", run_id: "run-Z", task_id: "W1-T3" }) + "\n";
    let nowCalls = 0;
    const result = rotateLedger(ledgerPath, {
      ceilingBytes: CEILING,
      now: () => {
        nowCalls++;
        if (nowCalls === 2) {
          // The other rotator's atomic swap: a NEW inode lands on the path.
          writeFileSync(join(dir, "other-rotator.tmp"), replacement);
          renameSync(join(dir, "other-rotator.tmp"), ledgerPath);
        }
        return new Date("2026-01-01T00:00:00.000Z");
      },
    });
    assert.deepEqual(result, { rotated: false }, "the swap is withdrawn, reported as not rotated");
    assert.equal(readFileSync(ledgerPath, "utf8"), replacement, "the replacement file is byte-for-byte untouched");
    assert.equal(archivesIn(dir).length, 1, "the snapshot archive already written is kept — relocated, never deleted");
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes("rotate-tmp")),
      [],
      "the withdrawn stage file is removed",
    );
    assert.equal(existsSync(ledgerRotationLockPath(ledgerPath)), false, "the lock is released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock cleared out from under a held rotation (a reclaimer that mis-judged it stale) does not make release throw — with the file identity unchanged the rotation still completes", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath, CEILING);
    const lockPath = ledgerRotationLockPath(ledgerPath);
    let nowCalls = 0;
    const result = rotateLedger(ledgerPath, {
      ceilingBytes: CEILING,
      now: () => {
        nowCalls++;
        if (nowCalls === 2) unlinkSync(lockPath);
        return new Date("2026-01-01T00:00:00.000Z");
      },
    });
    assert.equal(result.rotated, true, "no competing swap happened, so the snapshot is still what is on disk and the rotation lands");
    assert.equal(archivesIn(dir).length, 1);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a garbage rotation lock (unparseable holder) is reclaimed like a dead one", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath, CEILING);
    const lockPath = ledgerRotationLockPath(ledgerPath);
    writeFileSync(lockPath, "not json {");
    const result = rotateLedger(ledgerPath, { ceilingBytes: CEILING });
    assert.equal(result.rotated, true);
    assert.equal(existsSync(lockPath), false, "the garbage lock was cleared and this rotation's own lock released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
