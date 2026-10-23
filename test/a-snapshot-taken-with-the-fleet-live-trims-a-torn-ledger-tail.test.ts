/**
 * W1-T5545 — A SNAPSHOT TAKEN WITH THE FLEET LIVE TRIMS A TORN LEDGER TAIL, AND EVERY COPIED LINE PARSES.
 *
 * The nightly rung now snapshots with every daemon running, because the fleet runs 24/7 and
 * W1-T3677's refusal meant no snapshot was ever taken. A daemon may be mid-append when the ledger
 * is read, so its last line can be half-written. The ledger is append-only, so everything up to the
 * final `\n` is whole: the copy keeps exactly that, and a line that still does not parse is refused
 * rather than archived. Falsifier: copy the live ledger without trimming, and the archive holds an
 * unparseable line (here, snapshotState refuses it and these tests go red).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StateBackupError, snapshotState } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const WHOLE = '{"step":"run.start","task":"W1-T5545"}\n{"step":"run.end","task":"W1-T5545"}\n';
const TORN = '{"step":"run.st';

function liveState(ledger: string): { state: string; backups: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}torn-tail-`));
  const state = join(root, "state");
  mkdirSync(join(state, "locks"), { recursive: true });
  writeFileSync(join(state, "ledger.ndjson"), ledger);
  writeFileSync(join(state, "inbox-proposals.json"), "{}\n");
  return { state, backups: join(root, "state-backups") };
}

const linesOf = (text: string) => text.split("\n").filter(Boolean);

test("a snapshot taken with the fleet live trims a torn ledger tail and every copied line parses", () => {
  const { state, backups } = liveState(WHOLE + TORN);
  const snap = snapshotState(state, backups);
  const copied = readFileSync(join(snap.archiveDir, "ledger.ndjson"), "utf8");
  assert.equal(copied, WHOLE, "the copy ends at the last whole line");
  for (const line of linesOf(copied)) assert.doesNotThrow(() => JSON.parse(line), `unparseable copied line: ${line}`);
  assert.equal(snap.ledgerTrimmedBytes, Buffer.byteLength(TORN), "the result says how much tail was left out");
  assert.equal(readFileSync(join(state, "ledger.ndjson"), "utf8"), WHOLE + TORN, "the live ledger is never touched");
});

test("a ledger that is ONE torn line still publishes, with an empty ledger copy", () => {
  const { state, backups } = liveState(TORN);
  const snap = snapshotState(state, backups);
  assert.ok(snap.entries.includes("ledger.ndjson"), "the ledger is present, so the missing-ledger check is satisfied");
  assert.equal(readFileSync(join(snap.archiveDir, "ledger.ndjson"), "utf8"), "");
});

test("a whole ledger is copied byte-for-byte with nothing trimmed", () => {
  const { state, backups } = liveState(WHOLE);
  const snap = snapshotState(state, backups);
  assert.equal(readFileSync(join(snap.archiveDir, "ledger.ndjson"), "utf8"), WHOLE);
  assert.equal(snap.ledgerTrimmedBytes, 0);
});

test("a line that does not parse in the MIDDLE of the ledger is refused, naming the line", () => {
  const { state, backups } = liveState(`${linesOf(WHOLE)[0]}\nnot json\n${linesOf(WHOLE)[1]}\n`);
  assert.throws(
    () => snapshotState(state, backups),
    (err: unknown) => err instanceof StateBackupError && /line 2 does not parse as JSON — refusing to publish it/.test(err.message),
  );
  assert.deepEqual(readdirSync(backups), [], "nothing is published and no temp dir is left");
});

test("an untrimmed copy is refused by the on-disk verification, whichever copier ran", () => {
  const { state, backups } = liveState(WHOLE + TORN);
  // The falsifier, run directly: a copier that does NOT trim. The verification reads the staged
  // file from disk, so it refuses this one rather than trusting the copier.
  const untrimmed = (src: string, dst: string, rels: readonly string[]) => {
    for (const rel of rels) writeFileSync(join(dst, rel), readFileSync(join(src, rel)));
  };
  assert.throws(
    () => snapshotState(state, backups, { copy: untrimmed }),
    (err: unknown) => err instanceof StateBackupError && /its last line has no newline/.test(err.message),
  );
  assert.deepEqual(readdirSync(backups), []);
});

test("a file a live writer removes mid-copy is recorded as vanished, not a failure", () => {
  const { state, backups } = liveState(WHOLE);
  const tmpFile = "inbox-proposals.json.tmp-42-abc";
  writeFileSync(join(state, tmpFile), "{}");
  const snap = snapshotState(state, backups, {
    beforeCopy: (rel) => {
      if (rel === tmpFile) rmSync(join(state, tmpFile));
    },
  });
  assert.deepEqual(snap.vanished, [tmpFile], "the vanished file is named in the result");
  assert.ok(!snap.entries.includes(tmpFile));
  assert.equal(readFileSync(join(snap.archiveDir, "ledger.ndjson"), "utf8"), WHOLE, "the rest of the snapshot is whole");
});

test("a copy failure that is not a vanished file still fails the snapshot", () => {
  const { state, backups } = liveState(WHOLE);
  writeFileSync(join(state, "worker-token"), "s3cr3t");
  // The source is still there, so this is NOT a vanished file: a directory occupies the staged
  // destination. It must surface as a failure, never be counted as removed by a live writer.
  assert.throws(
    () =>
      snapshotState(state, backups, {
        beforeCopy: (rel) => {
          if (rel !== "worker-token") return;
          const staging = readdirSync(backups).find((n) => n.startsWith(".state-backup-tmp-"));
          mkdirSync(join(backups, String(staging), "worker-token"), { recursive: true });
        },
      }),
    (err: unknown) => err instanceof StateBackupError && /snapshot of .* failed: /.test(err.message),
  );
  assert.deepEqual(readdirSync(backups), [], "the staging dir is removed");
});

for (const listing of [1, 2]) {
  test(listing === 1
    ? "a source engine lost during the initial snapshot inventory remains a loud failure"
    : "the late archive check never revisits an already copied engine directory", (t) => {
    const { state, backups } = liveState(WHOLE);
    t.after(() => rmSync(join(state, ".."), { recursive: true, force: true }));
    const engineRel = join("engines", "a".repeat(64));
    const engine = join(state, engineRel);
    mkdirSync(engine, { recursive: true });
    writeFileSync(join(engine, "engine.json"), "{}\n");
    const original = fs.realpathSync;
    let visits = 0;
    const replacement = ((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === engine && ++visits === listing) rmSync(engine, { recursive: true });
      return (original as (...args: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.realpathSync;
    t.mock.method(fs, "realpathSync", replacement);
    syncBuiltinESMExports();
    let snap: ReturnType<typeof snapshotState>;
    try {
      if (listing === 1) {
        assert.throws(() => snapshotState(state, backups), StateBackupError);
        assert.deepEqual(readdirSync(backups), []);
        return;
      }
      snap = snapshotState(state, backups);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(visits, 1, "the archive catch-up must not walk engine directories again");
    assert.equal(readFileSync(join(snap.archiveDir, "ledger.ndjson"), "utf8"), WHOLE);
    assert.equal(readFileSync(join(snap.archiveDir, "inbox-proposals.json"), "utf8"), "{}\n");
    assert.ok(snap.entries.includes(join(engineRel, "engine.json")), "the copied engine is retained, not excluded");
    assert.equal(readFileSync(join(snap.archiveDir, engineRel, "engine.json"), "utf8"), "{}\n");
  });
}

test("a vanished non-engine directory is not silently excluded from a live snapshot", (t) => {
  const { state, backups } = liveState(WHOLE);
  t.after(() => rmSync(join(state, ".."), { recursive: true, force: true }));
  const locks = join(state, "locks");
  writeFileSync(join(locks, "run.lock"), "irreplaceable\n");
  const original = fs.realpathSync;
  t.mock.method(fs, "realpathSync", ((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path) === locks) rmSync(locks, { recursive: true });
    return (original as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.realpathSync);
  syncBuiltinESMExports();
  try {
    assert.throws(() => snapshotState(state, backups), StateBackupError);
    assert.deepEqual(readdirSync(backups), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("an ENOENT beneath an engine that still exists remains a loud snapshot failure", (t) => {
  const { state, backups } = liveState(WHOLE);
  t.after(() => rmSync(join(state, ".."), { recursive: true, force: true }));
  const engine = join(state, "engines", "b".repeat(64));
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "engine.json"), "{}\n");
  const original = fs.realpathSync;
  t.mock.method(fs, "realpathSync", ((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path) === engine) throw Object.assign(new Error("fixture: missing child, not a pruned engine"), {
      code: "ENOENT", path: join(engine, "not-there"),
    });
    return (original as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.realpathSync);
  syncBuiltinESMExports();
  try {
    assert.throws(() => snapshotState(state, backups), StateBackupError);
    assert.deepEqual(readdirSync(backups), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("the top-level archive catch-up still copies a rotation published during the first copy", (t) => {
  const { state, backups } = liveState(WHOLE);
  t.after(() => rmSync(join(state, ".."), { recursive: true, force: true }));
  const archive = "ledger.2026-10-23T00-00-00-000Z.ndjson";
  let published = false;
  const snap = snapshotState(state, backups, {
    beforeCopy: (rel) => {
      if (rel !== "ledger.ndjson" || published) return;
      writeFileSync(join(state, archive), WHOLE);
      published = true;
    },
  });
  assert.equal(published, true);
  assert.ok(snap.entries.includes(archive));
  assert.equal(readFileSync(join(snap.archiveDir, archive), "utf8"), WHOLE);
  assert.equal(readFileSync(join(snap.archiveDir, "ledger.ndjson"), "utf8"), WHOLE);
});

test("an archive-shaped dangling link created during copying remains a loud failure", (t) => {
  const { state, backups } = liveState(WHOLE);
  t.after(() => rmSync(join(state, ".."), { recursive: true, force: true }));
  const archive = "ledger.2026-10-23T00-00-00-001Z.ndjson";
  let published = false;
  assert.throws(() => snapshotState(state, backups, {beforeCopy: (rel) => {
    if (rel !== "ledger.ndjson" || published) return;
    fs.symlinkSync(join(state, "missing-archive"), join(state, archive));
    published = true;
  }}), StateBackupError);
  assert.equal(published, true);
  assert.deepEqual(readdirSync(backups), []);
});
