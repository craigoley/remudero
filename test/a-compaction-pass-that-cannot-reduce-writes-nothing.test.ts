import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { fixedClock } from "../src/lib/clock.js";
import { ledgerCompactCommand, LEDGER_COLD_STORE_DIRNAME, selectLedgerCompactionSources } from "../src/lib/ledger-compact.js";
import { compactedArchiveName } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const row = (ts: string, id: string) => JSON.stringify({ ts, step: "run.start", run_id: id });

function stateDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}no-reduction-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function source(dir: string, ts: string, rows: string[], plain = false): string {
  const name = compactedArchiveName(ts).replace(/\.gz$/, plain ? "" : ".gz");
  const path = join(dir, name);
  const body = Buffer.from(`${rows.join("\n")}\n`);
  writeFileSync(path, plain ? body : gzipSync(body));
  utimesSync(path, 1_000, 1_000);
  return name;
}

function snapshot(dir: string) {
  return readdirSync(dir).sort().filter((name) => statSync(join(dir, name)).isFile()).map((name) => {
    const path = join(dir, name);
    return { name, bytes: readFileSync(path).toString("base64"), mtimeMs: statSync(path).mtimeMs };
  });
}

function run(dir: string, args: string[] = [], maxArchiveBytes?: number) {
  const out: string[] = [];
  const errors: string[] = [];
  const code = ledgerCompactCommand(args, {
    stateDir: dir, clock: fixedClock(NOW), maxArchiveBytes,
    out: (line) => out.push(line), error: (line) => errors.push(line),
  });
  assert.equal(code, 0, errors.join("\n"));
  assert.deepEqual(errors, []);
  assert.equal(out.length, 1);
  return JSON.parse(out[0]!);
}

function assertNoReduction(report: ReturnType<typeof run>) {
  assert.match(report.reason, /no-reduction/);
  assert.equal(report.sourceCount, 0, "the daemon must receive the nothing-eligible outcome");
  assert.equal(report.rowsWritten, 0);
  assert.equal(report.duplicatesCollapsed, 0);
  assert.equal(report.archiveName, "");
  assert.deepEqual(report.archiveNames, []);
}

describe("test/a-compaction-pass-that-cannot-reduce-writes-nothing.test.ts", () => {
  test("single-day rotations keep their bytes and mtimes across repeated apply and preview passes", (t) => {
    const dir = stateDir(t);
    for (let day = 8; day <= 22; day += 1) {
      const ts = `2026-08-${day.toString().padStart(2, "0")}T23:59:57.233Z`;
      source(dir, ts, [row(ts, `day-${day}`)]);
    }
    const before = snapshot(dir);

    for (const args of [[], [], ["--dry-run"]]) {
      const report = run(dir, args);
      assert.deepEqual(snapshot(dir), before, "no source may be rewritten or moved to cold storage");
      assert.deepEqual(readdirSync(dir).sort(), before.map((entry) => entry.name));
      assertNoReduction(report);
      assert.equal(report.eligibleCount, 15);
    }
  });

  test("rotations sharing a UTC day still merge into one archive and preserve every distinct row", (t) => {
    const dir = stateDir(t);
    const firstTs = "2026-08-22T01:00:00.000Z";
    const lastTs = "2026-08-22T23:00:00.000Z";
    const firstRow = row(firstTs, "first");
    const lastRow = row(lastTs, "last");
    const first = source(dir, firstTs, [firstRow], true);
    const last = source(dir, lastTs, [firstRow, lastRow]);
    const before = snapshot(dir);
    const preview = run(dir, ["--dry-run"]);
    assert.equal(preview.sourceCount, 2);
    assert.deepEqual(snapshot(dir), before);

    const report = run(dir);

    assert.equal(report.sourceCount, 2);
    assert.equal(report.rowsWritten, 2);
    assert.equal(report.duplicatesCollapsed, 1);
    assert.deepEqual(report.archiveNames, [last]);
    assert.equal(report.reason, undefined);
    assert.deepEqual(readdirSync(dir).sort(), [LEDGER_COLD_STORE_DIRNAME, last].sort());
    assert.deepEqual(
      new Set(gunzipSync(readFileSync(join(dir, last))).toString("utf8").trim().split("\n")),
      new Set([firstRow, lastRow]),
    );
    assert.equal(readFileSync(join(dir, LEDGER_COLD_STORE_DIRNAME, first)).toString("base64"), before.find((entry) => entry.name === first)!.bytes);
  });

  test("selection reaches a shared day beyond the oldest singleton window and retains the age floor", (t) => {
    const dir = stateDir(t);
    const singles = Array.from({ length: 15 }, (_, index) => compactedArchiveName(
      new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
    ));
    const pair = ["2026-09-10T01:00:00.000Z", "2026-09-10T02:00:00.000Z"].map(compactedArchiveName);
    const atCutoff = compactedArchiveName("2026-10-01T12:00:00.000Z");
    const beforeCutoff = compactedArchiveName("2026-10-01T01:00:00.000Z");
    const names = [...singles, ...pair, beforeCutoff, atCutoff];
    const selected = selectLedgerCompactionSources(names.reverse(), dir, 7, 2, new Date(NOW));
    assert.deepEqual(selected.sources.map((entry) => entry.path), pair.map((name) => join(dir, name)));
    assert.equal(selected.eligibleCount, 18);

    for (const name of singles) {
      const ts = new Date(Date.UTC(2026, 7, singles.indexOf(name) + 1)).toISOString();
      source(dir, ts, [row(ts, name)]);
    }
    for (const [index, ts] of ["2026-09-10T01:00:00.000Z", "2026-09-10T02:00:00.000Z"].entries()) {
      source(dir, ts, [row(ts, `pair-${index}`)]);
    }
    const before = snapshot(dir).filter((entry) => singles.includes(entry.name));
    const report = run(dir, ["--max-sources", "2"]);
    assert.equal(report.sourceCount, 2);
    assert.deepEqual(report.archiveNames, [pair[1]]);
    assert.deepEqual(snapshot(dir).filter((entry) => singles.includes(entry.name)), before);
  });

  test("the output count follows row UTC days rather than source filename days", (t) => {
    const dir = stateDir(t);
    source(dir, "2026-08-22T01:00:00.000Z", [row("2026-08-20T23:30:00-02:00", "utc-21")]);
    source(dir, "2026-08-22T02:00:00.000Z", [
      row("2026-08-22T01:00:00.000Z", "utc-22"), row("2026-08-23T01:00:00.000Z", "utc-23"),
    ]);
    const before = snapshot(dir);

    assertNoReduction(run(dir));
    assert.deepEqual(snapshot(dir), before, "a two-source pass that would write three days must be declined");
  });

  test("an oversized source is not rewritten into more archives", (t) => {
    const dir = stateDir(t);
    const first = row("2026-08-22T01:00:00.000Z", "first");
    const last = row("2026-08-22T02:00:00.000Z", "last");
    source(dir, "2026-08-22T02:00:00.000Z", [first, last]);
    const before = snapshot(dir);

    assertNoReduction(run(dir, [], Buffer.byteLength(first) + 1));
    assert.deepEqual(snapshot(dir), before);
  });
});
