/**
 * W1-T5545 — A LEDGER THAT GROWS DURING THE COPY IS RE-COPIED, NEVER PUBLISHED TORN.
 *
 * The snapshot runs with the fleet up, so a daemon can append, or a rotation (W1-T5514) can replace
 * the live file, between the moment the ledger is read and the moment the copy is judged. A size,
 * mtime or inode change across the read means the bytes in hand may not be the ledger: read again,
 * a bounded number of times, and refuse only when the race outlasts the bound. A rotation that lands
 * mid-copy moves live rows into a `.gz` the first pass never listed, so the archives are re-listed and
 * the late ones copied with the ledger again. `afterLedgerRead` is the moment a live daemon would
 * strike; nothing in production supplies it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { StateBackupError, snapshotState } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const row = (n: number) => `${JSON.stringify({ step: "run.start", seq: n })}\n`;

function liveState(ledger: string): { state: string; backups: string; ledger: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ledger-grows-`));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "ledger.ndjson"), ledger);
  return { state, backups: join(root, "state-backups"), ledger: join(state, "ledger.ndjson") };
}

test("a ledger that grows during the copy is re-copied, never published torn", () => {
  const live = liveState(row(1) + row(2));
  const reads: number[] = [];
  const snap = snapshotState(live.state, live.backups, {
    afterLedgerRead: (attempt) => {
      reads.push(attempt);
      // A daemon appends while the first read is in hand — half a row, the torn shape a live
      // append leaves for an instant.
      if (attempt === 1) appendFileSync(live.ledger, '{"step":"run.end","se');
    },
  });
  assert.deepEqual(reads, [1, 2], "the raced read is discarded and the ledger read again");
  const copied = readFileSync(join(snap.archiveDir, "ledger.ndjson"), "utf8");
  assert.equal(copied, row(1) + row(2), "the second read's torn tail is trimmed, never published");
  for (const line of copied.split("\n").filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line));
});

test("a rotation that replaces the ledger mid-copy is chased: its archive and the new ledger are both copied", () => {
  const live = liveState(row(1) + row(2));
  const rotation = "ledger.2026-10-03T04-17-00-000Z.ndjson.gz";
  const snap = snapshotState(live.state, live.backups, {
    afterLedgerRead: (attempt) => {
      if (attempt !== 1 || readdirSync(live.state).includes(rotation)) return;
      // What rotateLedger does: archive the rows, then rename a fresh live file over the old one.
      writeFileSync(join(live.state, rotation), gzipSync(row(1) + row(2)));
      writeFileSync(`${live.ledger}.next`, row(3));
      renameSync(`${live.ledger}.next`, live.ledger);
    },
  });
  assert.ok(snap.entries.includes(rotation), "the archive that landed mid-copy is in the snapshot");
  assert.equal(gunzipSync(readFileSync(join(snap.archiveDir, rotation))).toString(), row(1) + row(2));
  assert.equal(readFileSync(join(snap.archiveDir, "ledger.ndjson"), "utf8"), row(3), "the ledger is the post-rotation file");
});

test("a ledger that changes on every read past the bound refuses and publishes nothing", () => {
  const live = liveState(row(1));
  let n = 1;
  assert.throws(
    () =>
      snapshotState(live.state, live.backups, {
        maxRaceAttempts: 3,
        afterLedgerRead: () => appendFileSync(live.ledger, row(++n)),
      }),
    (err: unknown) => err instanceof StateBackupError && /changed during each of 3 copy attempts — refusing to publish a torn copy/.test(err.message),
  );
  assert.equal(n, 4, "exactly the bound's worth of reads");
  assert.deepEqual(readdirSync(live.backups), [], "no archive and no temp dir");
});

test("rotations that keep landing past the bound refuse rather than publish a snapshot missing their rows", () => {
  const live = liveState(row(1));
  let n = 0;
  assert.throws(
    () =>
      snapshotState(live.state, live.backups, {
        maxRaceAttempts: 3,
        afterLedgerRead: () => writeFileSync(join(live.state, `ledger.2026-10-03T04-17-0${n++}-000Z.ndjson.gz`), gzipSync(row(n))),
      }),
    (err: unknown) => err instanceof StateBackupError && /rotations kept landing in .* across 3 copy passes/.test(err.message),
  );
  assert.deepEqual(readdirSync(live.backups), []);
});
