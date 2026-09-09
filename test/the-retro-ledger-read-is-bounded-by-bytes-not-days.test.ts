/**
 * W1-T3229 — the retro's ledger read is bounded by RETAINED BYTES, not by a day count.
 *
 * The read this file covers used to be `openLedgerUnion(stateDir)` with no options, accumulating
 * every row of every rotation into an array and joining it. MEASURED on the fleet host
 * 2026-09-09: 646 rotations, 2.7GB uncompressed, 900,813 distinct rows = 270.4MB of ndjson, and
 * 641MB of heap to stream it once — SIGABRT against the retro subprocess's 1792MB heap on every
 * fire since 2026-09-03.
 *
 * THE FALSIFIER CONDITION. Every assertion here must FAIL against that reader, not merely pass
 * against this one. `droppedRows` does not exist on a string, so the budget cases cannot compile
 * against it; the window case records which rotations were OPENED, which the unwindowed reader
 * opens all of. A suite that only asserted "the result is short" would pass on any implementation
 * that truncates, including one that keeps the WRONG end — hence the newest-rows assertion below,
 * which is the half that actually pins the behaviour a retro depends on.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  RETRO_LEDGER_MAX_BYTES,
  RETRO_LEDGER_NO_MARKER_LOOKBACK_MS,
  RETRO_LEDGER_WINDOW_LEAD_MS,
  readRetroLedgerNdjson,
  retroLedgerScopeNote,
  retroLedgerWindowSince,
} from "../src/lib/retro.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function tmp(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}`));
}

/** One ledger row whose serialized size is dominated by `pad`, so a corpus can be built to an
 *  exact byte scale without writing thousands of lines. */
function row(index: number, ts: string, padBytes: number): string {
  return JSON.stringify({ ts, run_id: `R${index}`, task_id: "T", step: "run.start", pad: "x".repeat(padBytes) });
}

/** Writes a rotation (gzipped, stamped) or the live file. */
function writeRotation(stateDir: string, stampIso: string | "live", lines: readonly string[]): void {
  const body = lines.join("\n") + "\n";
  if (stampIso === "live") {
    writeFileSync(join(stateDir, "ledger.ndjson"), body);
    return;
  }
  const name = `ledger.${stampIso.replace(/[:.]/g, "-")}.ndjson.gz`;
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(body, "utf8")));
}

// ── The bound itself ─────────────────────────────────────────────────────────────────────────

test("W1-T3229: a corpus larger than the budget is read to completion and RETAINS no more than the budget", async () => {
  const root = tmp("retro-ledger-budget-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    // ~40KB of rows across four rotations, against a 10KB budget: the corpus is 4x the bound.
    const budget = 10_000;
    const perRotation = 20;
    const stamps = ["2026-09-01T00-00-00-000Z", "2026-09-02T00-00-00-000Z", "2026-09-03T00-00-00-000Z"];
    let index = 0;
    for (const stamp of stamps) {
      const lines: string[] = [];
      for (let i = 0; i < perRotation; i += 1, index += 1) {
        lines.push(row(index, `2026-09-0${stamps.indexOf(stamp) + 1}T00:00:0${i % 10}.000Z`, 500));
      }
      writeRotation(stateDir, stamp.replace(/-(\d\d)-(\d\d)-(\d\d\d)Z$/, ":$1:$2.$3Z"), lines);
    }
    const liveLines: string[] = [];
    for (let i = 0; i < perRotation; i += 1, index += 1) liveLines.push(row(index, `2026-09-04T00:00:0${i % 10}.000Z`, 500));
    writeRotation(stateDir, "live", liveLines);

    const read = await readRetroLedgerNdjson(stateDir, { maxBytes: budget });

    // (1) It completed rather than dying, and (2) it kept less than the budget.
    assert.ok(read.rowsKept > 0, "the read must return rows, not an empty corpus");
    assert.ok(
      read.ndjson.length <= budget,
      `retained ${read.ndjson.length} bytes against a ${budget}-byte budget`,
    );

    // (3) It DROPPED, and said how much. This is the assertion that cannot exist against the
    // pre-fix reader, whose return type is a bare string.
    assert.ok(read.droppedRows > 0, "a corpus 4x the budget must report a non-zero drop");
    assert.equal(read.droppedRows + read.rowsKept, index, "every row is either kept or counted as dropped");
    assert.ok(read.droppedBytes > 0, "a non-zero row drop must carry a non-zero byte count");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3229: the rows it keeps are the NEWEST — a budget that kept the wrong end would still be 'bounded'", async () => {
  const root = tmp("retro-ledger-newest-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const oldest = Array.from({ length: 20 }, (_, i) => row(i, `2026-09-01T00:00:${String(i).padStart(2, "0")}.000Z`, 500));
    const newest = Array.from({ length: 20 }, (_, i) => row(100 + i, `2026-09-05T00:00:${String(i).padStart(2, "0")}.000Z`, 500));
    writeRotation(stateDir, "2026-09-02T00:00:00.000Z", oldest);
    writeRotation(stateDir, "live", newest);

    const read = await readRetroLedgerNdjson(stateDir, { maxBytes: 6_000 });

    assert.ok(read.droppedRows > 0, "the fixture must exceed the budget or this case proves nothing");
    // The survivors carry the LATE run ids and none of the early ones.
    assert.ok(read.ndjson.includes('"run_id":"R119"'), "the newest row must survive");
    assert.ok(!read.ndjson.includes('"run_id":"R0"'), "the oldest row must be the one dropped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3229: a single row larger than the whole budget terminates, keeping exactly that row", async () => {
  const root = tmp("retro-ledger-oversized-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeRotation(stateDir, "live", [row(0, "2026-09-05T00:00:00.000Z", 5_000)]);

    // The drop loop's `head < kept.length - 1` guard is what makes this terminate instead of
    // spinning on an empty array; without it this case hangs rather than failing.
    const read = await readRetroLedgerNdjson(stateDir, { maxBytes: 100 });
    assert.equal(read.rowsKept, 1, "the last row is never evicted, however large");
    assert.equal(read.droppedRows, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── The window (a cost optimisation on top of the bound, not the bound) ──────────────────────

test("W1-T3229: rotations stamped before the window are never opened", async () => {
  const root = tmp("retro-ledger-window-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeRotation(stateDir, "2026-08-01T00:00:00.000Z", [row(0, "2026-08-01T00:00:00.000Z", 10)]);
    writeRotation(stateDir, "2026-09-05T00:00:00.000Z", [row(1, "2026-09-05T00:00:00.000Z", 10)]);
    writeRotation(stateDir, "live", [row(2, "2026-09-06T00:00:00.000Z", 10)]);

    const windowed = await readRetroLedgerNdjson(stateDir, { sinceTs: "2026-09-04T00:00:00.000Z" });
    assert.ok(!windowed.ndjson.includes('"run_id":"R0"'), "a pre-window rotation contributes nothing");
    assert.ok(windowed.ndjson.includes('"run_id":"R1"'));
    assert.ok(windowed.ndjson.includes('"run_id":"R2"'));
    assert.equal(windowed.sinceTs, "2026-09-04T00:00:00.000Z");

    // CONTROL: the same corpus with no window really does carry the row the window excluded, so
    // the zero above is the window's doing and not an unreadable fixture.
    const unwindowed = await readRetroLedgerNdjson(stateDir);
    assert.ok(unwindowed.ndjson.includes('"run_id":"R0"'), "positive control: the old row IS readable");
    assert.equal(unwindowed.sinceTs, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3229: the window comes from the marker with a lead margin, and from a lookback floor when there is none", () => {
  const now = Date.parse("2026-09-09T12:00:00.000Z");

  const fromMarker = retroLedgerWindowSince("2026-09-03T02:24:39.835Z", now);
  assert.equal(fromMarker, new Date(Date.parse("2026-09-03T02:24:39.835Z") - RETRO_LEDGER_WINDOW_LEAD_MS).toISOString());

  const noMarker = retroLedgerWindowSince(undefined, now);
  assert.equal(noMarker, new Date(now - RETRO_LEDGER_NO_MARKER_LOOKBACK_MS).toISOString());

  // A marker that cannot be parsed falls to the floor rather than producing an Invalid Date, which
  // openLedgerUnion would read as "no window at all" — the exact unbounded read this task removes.
  assert.equal(retroLedgerWindowSince("not-a-timestamp", now), noMarker);

  // A marker frozen for WEEKS is NOT clamped to the floor. That is the state this defect produces,
  // and clamping it would make the recovery run silently skip the history it exists to consume —
  // the byte budget bounds that case instead, and reports what it dropped.
  const stale = retroLedgerWindowSince("2026-07-01T00:00:00.000Z", now);
  assert.ok(
    Date.parse(stale) < Date.parse(noMarker),
    `a stale marker must reach further back than the no-marker floor, got ${stale} vs ${noMarker}`,
  );
});

// ── The honesty half ────────────────────────────────────────────────────────────────────────

test("W1-T3229: the report's scope note says the counts are windowed, and names the drop when there was one", () => {
  const clean = retroLedgerScopeNote({
    ndjson: "",
    sinceTs: "2026-09-01T00:00:00.000Z",
    rowsKept: 12,
    droppedRows: 0,
    droppedBytes: 0,
  });
  assert.match(clean, /since 2026-09-01T00:00:00\.000Z/);
  assert.match(clean, /12 row\(s\), not over all history/);
  assert.ok(!/DROPPED/.test(clean), "a complete read must not claim a truncation");

  const truncated = retroLedgerScopeNote({
    ndjson: "",
    sinceTs: "2026-09-01T00:00:00.000Z",
    rowsKept: 12,
    droppedRows: 7,
    droppedBytes: 4_096,
  });
  assert.match(truncated, /7 older row\(s\) \(4096 bytes\) were DROPPED/);
  assert.match(truncated, /itself incomplete at its old end/);
});

test("W1-T3229: the shipped budget is a real ceiling, not a placeholder that disables the bound", () => {
  assert.ok(Number.isFinite(RETRO_LEDGER_MAX_BYTES), "the budget must be a finite number of bytes");
  // The measured corpus that OOM'd was 283,539,709 bytes of ndjson against a 1792MB heap. A budget
  // at or above that would ship the defect with a bound-shaped name on it.
  assert.ok(
    RETRO_LEDGER_MAX_BYTES < 283_539_709,
    `the budget must be below the corpus that was measured to OOM, got ${RETRO_LEDGER_MAX_BYTES}`,
  );
});
