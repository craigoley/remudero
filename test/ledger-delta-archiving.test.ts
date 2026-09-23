/**
 * Delta archiving and day-bounded compaction (ledger fix, step 2b).
 *
 * MEASURED on the fleet host 2026-09-23: every rotation archived the WHOLE live snapshot, including
 * the ~3.6 MiB retained core the previous rotation had already archived, so adjacent archives shared
 * 99.3% of rows. A rotation now archives only the bytes past the carried prefix its predecessor
 * recorded; a compaction writes one archive per UTC day, so a window read opens only its days.
 *
 * THE FALSIFIERS ARE ROW SETS, not byte counts: no row archived twice across a rotation pair, EVERY
 * row archived at least once, and a mismatched prefix falls back to the full snapshot.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { fixedClock } from "../src/lib/clock.js";
import { compactRotations, compactedArchiveName, ledgerCarriedPrefixPath, rotateLedger } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const T0 = Date.parse("2026-09-23T10:00:00.000Z");

function line(step: string, id: string, tsMs: number): string {
  return JSON.stringify({ ts: new Date(tsMs).toISOString(), run_id: id, task_id: id, step });
}

/** A retained core (decision-relevant `run.start`) followed by archive-only noise. */
function batch(tag: string, tsMs: number, core = 10, noise = 60): string[] {
  const rows: string[] = [];
  for (let i = 0; i < core; i++) rows.push(line("run.start", `${tag}-core-${i}`, tsMs + i));
  for (let i = 0; i < noise; i++) rows.push(line("worker.progress", `${tag}-noise-${i}`, tsMs + core + i));
  return rows;
}

function archiveRows(path: string): string[] {
  const buf = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8").split("\n").filter(Boolean);
}

/** Runs `fn` against a fresh live ledger from the shared fixture, then removes its directory. */
function inTempState(fn: (ledgerPath: string, dir: string) => void): void {
  const fixture = writeLedger();
  try {
    fn(fixture.path, fixture.dir);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

const rotate = (ledgerPath: string, atMs: number, ceilingBytes = 4000) =>
  rotateLedger(ledgerPath, { ceilingBytes, now: () => new Date(atMs) });

test("two consecutive rotations archive no row twice", () => {
  inTempState((ledgerPath) => {
    const first = batch("A", T0);
    writeFileSync(ledgerPath, first.join("\n") + "\n");
    const r1 = rotate(ledgerPath, T0 + 60_000);
    assert.equal(r1.rotated, true);
    assert.ok(readFileSync(ledgerPath, "utf8").includes("A-core-0"), "sanity: the core was carried live");

    const second = batch("B", T0 + 120_000);
    writeFileSync(ledgerPath, second.join("\n") + "\n", { flag: "a" });
    const r2 = rotate(ledgerPath, T0 + 180_000);
    assert.equal(r2.rotated, true);

    const a1 = archiveRows(r1.archivePath!);
    const a2 = archiveRows(r2.archivePath!);
    const twice = a2.filter((row) => a1.includes(row));
    assert.deepEqual(twice, [], "the carried core is NOT re-archived by the next rotation");
    assert.deepEqual(new Set([...a1, ...a2]), new Set([...first, ...second]), "and every row is archived at least once");
  });
});

test("a shed pointer rides after the carried prefix and is archived by the next rotation", () => {
  inTempState((ledgerPath) => {
    // A core bigger than the ceiling forces a shed, which writes a pointer row that no archive holds yet.
    writeFileSync(ledgerPath, batch("S", T0, 60, 10).join("\n") + "\n");
    const r1 = rotate(ledgerPath, T0 + 60_000, 3000);
    const pointer = readFileSync(ledgerPath, "utf8").split("\n").find((row) => row.includes("ledger.rotation_shed"));
    assert.ok(pointer, "sanity: the rotation shed and left its pointer");
    assert.equal(r1.retainedLineCount, readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length);

    writeFileSync(ledgerPath, batch("T", T0 + 120_000, 0, 40).join("\n") + "\n", { flag: "a" });
    const r2 = rotate(ledgerPath, T0 + 180_000, 3000);
    assert.ok(archiveRows(r2.archivePath!).includes(pointer), "the pointer is a new row, so the delta archives it");
    assert.ok(!archiveRows(r1.archivePath!).includes(pointer));
  });
});

test("a rotation whose carried prefix does not match archives the full snapshot", () => {
  const sidecarCases: Array<[string, (ledgerPath: string) => void]> = [
    ["an intact sidecar over a REPLACED live file", (p) => writeFileSync(p, readFileSync(p, "utf8").replace("C-core-0", "X-core-0"))],
    ["an unparseable sidecar", (p) => writeFileSync(ledgerCarriedPrefixPath(p), "{not json")],
    ["a sidecar claiming more bytes than the file holds", (p) => writeFileSync(ledgerCarriedPrefixPath(p), JSON.stringify({ bytes: 10_000_000, sha256: "x" }))],
    ["a sidecar with no byte count", (p) => writeFileSync(ledgerCarriedPrefixPath(p), "null")],
    ["a missing sidecar", (p) => rmSync(ledgerCarriedPrefixPath(p))],
  ];
  for (const [label, damage] of [["CONTROL: an intact sidecar", () => {}] as [string, (p: string) => void], ...sidecarCases]) {
    inTempState((ledgerPath) => {
      writeFileSync(ledgerPath, batch("C", T0).join("\n") + "\n");
      rotate(ledgerPath, T0 + 60_000);
      damage(ledgerPath);
      writeFileSync(ledgerPath, batch("D", T0 + 120_000).join("\n") + "\n", { flag: "a" });
      const snapshot = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
      const r2 = rotate(ledgerPath, T0 + 180_000);
      const archived = archiveRows(r2.archivePath!);
      if (label.startsWith("CONTROL")) {
        assert.ok(archived.length < snapshot.length, "control: a matching prefix archives only the delta");
      } else {
        assert.deepEqual(archived, snapshot, `${label}: the whole snapshot is archived — duplication, never loss`);
      }
    });
  }
});

test("a rotation whose snapshot is exactly the carried prefix writes no archive", () => {
  inTempState((ledgerPath, dir) => {
    const body = Buffer.from(batch("E", T0, 0, 60).join("\n") + "\n", "utf8");
    writeFileSync(ledgerPath, body);
    const sha256 = createHash("sha256").update(body).digest("hex");
    writeFileSync(ledgerCarriedPrefixPath(ledgerPath), JSON.stringify({ bytes: body.length, sha256 }));
    const r = rotate(ledgerPath, T0 + 60_000);
    assert.equal(r.rotated, true);
    assert.equal(r.archivePath, undefined, "an empty delta has nothing to archive");
    assert.deepEqual(readdirSync(dir).filter((n) => /^ledger\..+\.ndjson(\.gz)?$/.test(n)), []);
  });
});

/** In-memory rotations directory: `write` and `remove` act on one map, so a removal that hits a file
 *  just written really loses its rows here. */
function memoryDir(initial: Record<string, string[]>) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, v.join("\n") + "\n"]));
  return {
    files,
    io: {
      readRows: (p: string) => (files.get(p) ?? "").split("\n"),
      write: (name: string, body: string) => void files.set(name, body),
      remove: (p: string) => void files.delete(p),
      clock: fixedClock(Date.parse("2026-09-10T00:00:00.000Z")),
    },
  };
}

const row = (ts: string, id: string) => JSON.stringify({ ts, step: "run.start", run_id: id, task_id: "T" });
const rowsOf = (body: string) => body.split("\n").filter(Boolean);

test("compaction writes one archive per day of its rows", () => {
  const d1a = row("2026-09-01T01:00:00.000Z", "D1A");
  const d1b = row("2026-09-01T23:00:00.000Z", "D1B");
  const d2 = row("2026-09-02T12:00:00.000Z", "D2");
  const d3 = row("2026-09-03T08:00:00.000Z", "D3");
  const torn = "{torn row";
  const future1 = row("2027-10-14T00:00:00.000Z", "F1");
  const future2 = row("2027-10-15T00:00:00.000Z", "F2");
  const m = memoryDir({ "src-a": [d1a, d2, torn], "src-b": [d1b, d3, future1, future2] });

  const r = compactRotations(["src-a", "src-b"], m.io);

  const expected = [
    compactedArchiveName("2026-09-01T23:00:00.000Z"),
    compactedArchiveName("2026-09-02T12:00:00.000Z"),
    compactedArchiveName("2026-09-03T08:00:00.000Z"),
    compactedArchiveName("2026-09-10T00:00:00.000Z"),
  ];
  assert.deepEqual(r.archiveNames, expected, "one archive per UTC day, each named by that day's newest row");
  assert.equal(r.archiveName, expected[3], "archiveName stays the newest output");
  assert.deepEqual(rowsOf(m.files.get(expected[0]!)!), [d1a, d1b]);
  assert.deepEqual(rowsOf(m.files.get(expected[1]!)!), [d2]);
  assert.deepEqual(rowsOf(m.files.get(expected[2]!)!), [d3]);
  assert.deepEqual(
    rowsOf(m.files.get(expected[3]!)!),
    [future1, future2, torn],
    "future rows join TODAY (never a name past now) and an undated row joins the newest day",
  );
});

test("day-bounded compaction preserves every distinct row", () => {
  // Sources named as the rotation that wrote them: an hour after their newest row. Two of them sit
  // exactly on a day output's name, which the cleanup must never remove.
  const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];
  const all: string[] = [];
  const initial: Record<string, string[]> = {};
  let carried: string[] = [];
  days.forEach((day, i) => {
    const fresh = Array.from({ length: 5 }, (_, j) => row(`${day}T0${j}:00:00.000Z`, `${day}-${j}`));
    all.push(...fresh);
    carried = [...carried.slice(-3), ...fresh];
    const stamp = i % 2 === 0 ? `${day}T04:00:00.000Z` : `${day}T05:00:00.000Z`;
    initial[compactedArchiveName(stamp)] = carried;
  });
  const m = memoryDir(initial);
  const sources = Object.keys(initial);

  const r = compactRotations(sources, m.io);

  const outputs = [...m.files.values()].map(rowsOf);
  const union = outputs.flat();
  assert.deepEqual(new Set(union), new Set(all), "the union of the day archives is exactly the distinct input rows");
  assert.equal(union.length, all.length, "and no row lands in two day archives");
  assert.equal(r.rowsWritten, all.length);
  for (const rows of outputs) {
    assert.equal(new Set(rows.map((x) => (JSON.parse(x) as { ts: string }).ts.slice(0, 10))).size, 1, "each archive holds one day");
  }
  assert.equal(m.files.size, days.length, "every source not named like an output is gone, every output remains");
});
