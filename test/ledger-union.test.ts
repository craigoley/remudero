import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import {
  openLedgerUnion,
  readLedgerUnionRecords,
  readLedgerUnionRecordsSync,
  type LedgerGrepFsDeps,
} from "../src/lib/ledger-union.js";

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-ledger-union-"));
}

function row(marker: string, step = "run.start", ts = "2026-01-01T00:00:00.000Z"): string {
  return JSON.stringify({ ts, step, marker, task_id: `W1-${marker}` });
}

test("openLedgerUnion yields gzip rotation, plain rotation and live rows exactly once, oldest first", async () => {
  const dir = tmpStateDir();
  try {
    const shared = row("shared", "review.posted", "2026-01-01T00:00:02.000Z");
    writeFileSync(join(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz"), gzipSync(Buffer.from(row("gzip") + "\n" + shared + "\n")));
    writeFileSync(join(dir, "ledger.2026-01-02T00-00-00-000Z.ndjson"), row("plain") + "\n");
    writeFileSync(join(dir, LEDGER_FILENAME), shared + "\n" + row("live") + "\n");

    const markers: string[] = [];
    for await (const rec of openLedgerUnion(dir)) markers.push(String(rec.marker));

    assert.deepEqual(markers, ["gzip", "shared", "plain", "live"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLedgerUnionRecords applies sinceTs and step filters on top of the same union reader", async () => {
  const dir = tmpStateDir();
  try {
    writeFileSync(join(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson"), row("old", "run.start", "2026-01-01T00:00:00.000Z") + "\n");
    writeFileSync(join(dir, "ledger.2026-01-02T00-00-00-000Z.ndjson"), row("kept", "review.posted", "2026-01-02T00:00:00.000Z") + "\n");
    writeFileSync(join(dir, LEDGER_FILENAME), row("live", "review.posted", "2026-01-03T00:00:00.000Z") + "\n");

    const rows = await readLedgerUnionRecords(dir, {
      sinceTs: "2026-01-02T00:00:00.000Z",
      step: "review.posted",
    });

    assert.deepEqual(rows.map((rec) => rec.marker), ["kept", "live"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openLedgerUnion treats a missing state directory as an empty corpus", async () => {
  const dir = join(tmpStateDir(), "missing");
  const rows = [];
  for await (const rec of openLedgerUnion(dir)) rows.push(rec);
  assert.deepEqual(rows, []);
});

test("openLedgerUnion drops a torn (unparseable) line without aborting the stream", async () => {
  const dir = tmpStateDir();
  try {
    writeFileSync(join(dir, LEDGER_FILENAME), `${row("before")}\nnot json at all\n${row("after")}\n`);

    const markers: string[] = [];
    for await (const rec of openLedgerUnion(dir)) markers.push(String(rec.marker));

    assert.deepEqual(markers, ["before", "after"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLedgerUnionRecordsSync degrades to whatever rotations already supplied when the live file read throws", () => {
  const dir = tmpStateDir();
  try {
    writeFileSync(join(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson"), row("rotation") + "\n");
    writeFileSync(join(dir, LEDGER_FILENAME), row("live") + "\n");

    const fsDeps: LedgerGrepFsDeps = {
      readdirSync: (d) => readdirSync(d),
      existsSync: (p) => existsSync(p),
      readFileSync: (p) => {
        if (p.endsWith(LEDGER_FILENAME)) throw new Error("simulated unreadable live file");
        return readFileSync(p);
      },
      gunzipSync: (buf) => gunzipSync(buf),
    };

    const result = readLedgerUnionRecordsSync(dir, {}, fsDeps);

    assert.deepEqual(result.rows.map((rec) => rec.marker), ["rotation"]);
    assert.equal(result.liveFileRead, true, "the live file exists — it's the READ that fails, not the existsSync check");
    assert.deepEqual(result.unread, [], "an unreadable LIVE file is best-effort, unlike an unreadable archive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
