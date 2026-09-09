/**
 * W1-T3237 — compaction preserves every distinct row. A size drop is not the claim.
 *
 * MEASURED on the fleet host 2026-09-09: 646 `.gz` rotations + 2 plain + live, 2,709,938,810 bytes
 * uncompressed, reducing to 900,813 DISTINCT rows = 283,539,709 bytes — a 9.6x collapse with no row
 * lost. `rotateLedger` archives what it trims and NOTHING has ever removed an archive; that pile is
 * the corpus that OOM-killed the retro (W1-T3229).
 *
 * THE FALSIFIER IS ROW-SET EQUALITY, NOT A SIZE DROP. A compaction that shrinks the corpus is
 * trivial to write and worthless to trust: a byte-count assertion passes on a TRUNCATION, which is
 * the one outcome this must never ship. So every case below compares the SET of rows, and the
 * window case proves the compacted archive is still reachable by the readers that consume it —
 * a file the union silently skips has lost its rows just as completely as one that was deleted.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { compactRotations, compactedArchiveName } from "../src/lib/ledger.js";
import { openLedgerUnion, rotationStampIso } from "../src/lib/ledger-union.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function tmp(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}`));
}

const row = (ts: string, step: string, id: string) => JSON.stringify({ ts, step, run_id: id, task_id: "T" });

/** An in-memory io, so the SET comparison is over what was written rather than over the disk. */
function memoryIo(sources: Record<string, string[]>) {
  const written: Record<string, string> = {};
  const removed: string[] = [];
  return {
    written,
    removed,
    io: {
      readRows: (p: string) => sources[p] ?? [],
      write: (name: string, body: string) => {
        written[name] = body;
      },
      remove: (p: string) => removed.push(p),
    },
  };
}

test("W1-T3237: the distinct row set is identical before and after compaction", () => {
  // Three rotations that OVERLAP heavily — the real shape, where most history exists only in the
  // older files and the newest subsumes nothing.
  const a = [row("2026-09-01T00:00:00.000Z", "run.start", "R1"), row("2026-09-01T01:00:00.000Z", "verdict", "R1")];
  const b = [...a, row("2026-09-02T00:00:00.000Z", "run.start", "R2")];
  const c = [...b, row("2026-09-03T00:00:00.000Z", "verdict", "R2")];
  const sources = { "a.gz": a, "b.gz": b, "c.gz": c };
  const before = new Set([...a, ...b, ...c]);

  const m = memoryIo(sources);
  const r = compactRotations(["a.gz", "b.gz", "c.gz"], m.io);

  const after = new Set(m.written[r.archiveName]!.split("\n").filter(Boolean));
  assert.deepEqual([...after].sort(), [...before].sort(), "the DISTINCT row set must be identical");
  assert.equal(r.rowsWritten, before.size);
  assert.equal(r.duplicatesCollapsed, a.length + b.length + c.length - before.size, "and every collapse is counted");

  // A size drop alone would pass on a truncation, so it is asserted only ALONGSIDE set equality.
  assert.ok(m.written[r.archiveName]!.length < [...a, ...b, ...c].join("\n").length, "and it does reclaim");

  // Sources are removed only AFTER the replacement is written — the other order costs history.
  assert.deepEqual(m.removed, ["a.gz", "b.gz", "c.gz"]);
});

test("W1-T3237: a compacted archive is still found and windowed by the union reader", async () => {
  const root = tmp("ledger-compact-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const early = row("2026-09-01T00:00:00.000Z", "run.start", "EARLY");
    const late = row("2026-09-05T00:00:00.000Z", "verdict", "LATE");
    for (const [name, rows] of [
      ["ledger.2026-09-01T00-00-00-000Z.ndjson.gz", [early]],
      ["ledger.2026-09-05T00-00-00-000Z.ndjson.gz", [early, late]],
    ] as [string, string[]][]) {
      writeFileSync(join(stateDir, name), gzipSync(Buffer.from(rows.join("\n") + "\n", "utf8")));
    }
    writeFileSync(join(stateDir, "ledger.ndjson"), "");

    const sources = readdirSync(stateDir).filter((n) => n.endsWith(".gz")).map((n) => join(stateDir, n));
    const r = compactRotations(sources, {
      readRows: (p) => gunzipSync(readFileSync(p)).toString("utf8").split("\n"),
      write: (name, body) => writeFileSync(join(stateDir, name), gzipSync(Buffer.from(body, "utf8"))),
      remove: (p) => rmSync(p),
    });

    // THE NAME MUST PARSE, or every windowed union silently ignores the file.
    assert.equal(rotationStampIso(r.archiveName), "2026-09-05T00:00:00.000Z", "stamp = the NEWEST row it carries");

    // Unwindowed: both rows still reachable.
    const all: string[] = [];
    for await (const rec of openLedgerUnion(stateDir)) all.push(String(rec.run_id));
    assert.deepEqual(all.sort(), ["EARLY", "LATE"], "no row lost through compaction");

    // WINDOWED PAST THE EARLY ROW: the archive must NOT be skipped whole. Stamped with its OLDEST
    // row it would be, and the LATE row would vanish — a silent loss no size assertion could see.
    const windowed: string[] = [];
    for await (const rec of openLedgerUnion(stateDir, { sinceTs: "2026-09-03T00:00:00.000Z" })) windowed.push(String(rec.run_id));
    assert.deepEqual(windowed, ["LATE"], "the window filters ROWS, never the whole compacted file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3237: a torn row is carried, never dropped to tidy the ordering", () => {
  const torn = "{not json";
  const good = row("2026-09-01T00:00:00.000Z", "run.start", "R1");
  const m = memoryIo({ "a.gz": [good, torn] });
  const r = compactRotations(["a.gz"], m.io);

  const after = m.written[r.archiveName]!.split("\n").filter(Boolean);
  assert.equal(after.length, 2, "both rows survive");
  assert.ok(after.includes(torn), "a row with no parseable ts is kept, and sorts last");
  assert.equal(after[after.length - 1], torn);
});

test("W1-T3237: compacting nothing writes nothing and removes nothing", () => {
  const m = memoryIo({ "a.gz": [], "b.gz": ["  ", ""] });
  const r = compactRotations(["a.gz", "b.gz"], m.io);
  assert.equal(r.rowsWritten, 0);
  assert.deepEqual(m.written, {}, "an empty compaction must not write an empty archive");
  assert.deepEqual(m.removed, [], "and must not remove its sources — there is nothing to replace them with");
});

test("W1-T3237: the archive name mirrors rotationStampIso's parser exactly", () => {
  // A name that parser cannot read is a file every windowed union ignores, so this is a contract
  // between two modules and is asserted as one rather than assumed.
  for (const ts of ["2026-09-05T00:00:00.000Z", "2026-01-02T03:04:05.006Z", "2026-12-31T23:59:59.999Z"]) {
    assert.equal(rotationStampIso(compactedArchiveName(ts)), ts, `${ts} must round-trip through the name`);
  }
});

test("W1-T3237: the compacted archive is never deleted by its own cleanup", () => {
  // THE STAMP IS THE NEWEST ROW'S ts, which is very often the stamp of the newest SOURCE — so the
  // replacement lands on that source's own name. Removing sources blindly then deletes the file
  // just written, taking every row with it. This is a real bug the window case caught by reading
  // back an EMPTY union, and it is pinned here so it cannot return quietly.
  const newest = row("2026-09-05T00:00:00.000Z", "verdict", "LATE");
  const older = row("2026-09-01T00:00:00.000Z", "run.start", "EARLY");
  const collidingName = "ledger.2026-09-05T00-00-00-000Z.ndjson.gz";
  const m = memoryIo({
    "ledger.2026-09-01T00-00-00-000Z.ndjson.gz": [older],
    [collidingName]: [older, newest],
  });

  const r = compactRotations(["ledger.2026-09-01T00-00-00-000Z.ndjson.gz", collidingName], m.io);

  assert.equal(r.archiveName, collidingName, "the fixture must actually collide, or this proves nothing");
  assert.ok(!m.removed.includes(collidingName), "the file just written must never be removed");
  assert.deepEqual(m.removed, ["ledger.2026-09-01T00-00-00-000Z.ndjson.gz"], "every OTHER source still goes");
  assert.deepEqual(
    new Set(m.written[r.archiveName]!.split("\n").filter(Boolean)),
    new Set([older, newest]),
    "and both rows survive the collision",
  );
});
