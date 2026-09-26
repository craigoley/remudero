import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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

test("ledger union selects one source and reports unreadable live evidence", async () => {
  const dir = tmpStateDir();
  try {
    const first = "ledger.2026-01-01T00-00-00-000Z.ndjson.gz";
    const second = "ledger.2026-01-02T00-00-00-000Z.ndjson";
    const live = join(dir, LEDGER_FILENAME);
    writeFileSync(join(dir, first), gzipSync(Buffer.from(row("first") + "\n")));
    writeFileSync(join(dir, second), row("second") + "\n");
    writeFileSync(live, row("live") + "\n");
    const markers = async (opts: Parameters<typeof openLedgerUnion>[1], io?: Parameters<typeof openLedgerUnion>[2]): Promise<string[]> => {
      const found: string[] = [];
      for await (const rec of openLedgerUnion(dir, opts, io)) found.push(String(rec.marker));
      return found;
    };
    assert.deepEqual(await markers({ throughRotation: first, includeLive: false }), ["first"]);
    assert.deepEqual(await markers({ afterRotation: first, throughRotation: second, includeLive: false }), ["second"]);
    assert.deepEqual(await markers({ afterRotation: second }), ["live"]);
    const unread: string[] = [];
    assert.deepEqual(await markers({ afterRotation: second, onUnreadLive: (path) => unread.push(path) }, {
      readdirSync,
      existsSync,
      createReadStream: (path, options) => path === live
        ? Readable.from((async function* () { throw new Error("unreadable live"); })())
        : createReadStream(path, options),
    }), []);
    assert.deepEqual(unread, [live]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger union keeps three-form defaults with and without a cursor", async () => {
  const dir = tmpStateDir();
  try {
    const first = "ledger.2026-01-01T00-00-00-000Z.ndjson.gz";
    const second = "ledger.2026-01-02T00-00-00-000Z.ndjson";
    const replay = row("replayed", "worker.assignment");
    writeFileSync(join(dir, first), gzipSync(Buffer.from(row("gzip") + "\n" + replay + "\n")));
    writeFileSync(join(dir, second), replay + "\n" + row("plain") + "\n");
    writeFileSync(join(dir, LEDGER_FILENAME), row("live") + "\n");
    const collect = async (opts: Parameters<typeof openLedgerUnion>[1] = {}): Promise<string[]> => {
      const found: string[] = [];
      for await (const rec of openLedgerUnion(dir, opts)) found.push(String(rec.marker));
      return found;
    };
    assert.deepEqual(await collect({ throughRotation: first, includeLive: false }), ["gzip", "replayed"]);
    assert.deepEqual(await collect(), ["gzip", "replayed", "plain", "live"]);
    assert.deepEqual(await collect({ afterRotation: first, throughRotation: second, includeLive: false }), ["replayed", "plain"]);
    assert.deepEqual(await collect(), ["gzip", "replayed", "plain", "live"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openLedgerUnion bounds exact replay dedupe per step instead of retaining the corpus", async () => {
  const dir = tmpStateDir();
  try {
    const rare = row("rare", "rare.step", "2026-01-01T00:00:00.000Z");
    writeFileSync(
      join(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson"),
      [
        rare,
        row("busy-1", "busy.step", "2026-01-01T00:00:01.000Z"),
        row("busy-2", "busy.step", "2026-01-01T00:00:02.000Z"),
        row("busy-3", "busy.step", "2026-01-01T00:00:03.000Z"),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(dir, LEDGER_FILENAME),
      rare + "\n" + row("same-ts-a", "busy.step", "2026-01-01T00:00:04.000Z") + "\n" +
        row("same-ts-b", "busy.step", "2026-01-01T00:00:04.000Z") + "\n" +
        row("busy-1", "busy.step", "2026-01-01T00:00:01.000Z") + "\n",
    );

    const markers: string[] = [];
    for await (const rec of openLedgerUnion(dir, { dedupeWindowPerStep: 2 })) {
      markers.push(String(rec.marker));
    }

    assert.deepEqual(
      markers,
      ["rare", "busy-1", "busy-2", "busy-3", "same-ts-a", "same-ts-b", "busy-1"],
      "other steps cannot evict a retained row, exact replays inside the window collapse, distinct same-ts rows survive, and old keys are evicted",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openLedgerUnion refuses invalid or contradictory bounded-dedupe options", async () => {
  const dir = tmpStateDir();
  try {
    const collect = async (opts: Parameters<typeof openLedgerUnion>[1]): Promise<void> => {
      for await (const _row of openLedgerUnion(dir, opts)) {
        // The option guard runs before the first row; there is intentionally nothing to consume.
      }
    };
    await assert.rejects(() => collect({ dedupeWindowPerStep: 0 }), /must be a positive integer/);
    await assert.rejects(
      () => collect({ dedupe: false, dedupeWindowPerStep: 2 }),
      /dedupe=false and dedupeWindowPerStep are contradictory/,
    );
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

test("a rotation window reads by the newest rotation's stamp and never guesses an unstamped archive old", () => {
  const dir = tmpStateDir();
  try {
    writeFileSync(join(dir, "ledger.2026-01-10T00-00-00-000Z.ndjson"), row("newest") + "\n");
    writeFileSync(join(dir, "ledger.2026-01-08T00-00-00-000Z.ndjson"), row("inside") + "\n");
    writeFileSync(join(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson"), row("outside") + "\n");
    writeFileSync(join(dir, "ledger.unstamped.ndjson"), row("unstamped") + "\n");
    const threeDays = 3 * 86_400_000;
    const markers = (opts: { minRotations?: number }): string[] =>
      readLedgerUnionRecordsSync(dir, { order: "newest-first", rotationWindowMs: threeDays, ...opts }).rows.map((r) => String(r.marker)).sort();
    assert.deepEqual(markers({}), ["inside", "newest", "unstamped"], "the week-old rotation stays shut; its row is older than any in the window");
    assert.deepEqual(markers({ minRotations: 4 }), ["inside", "newest", "outside", "unstamped"], "a floor only ever adds files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rotation window over archives with no parseable stamp reads them all", () => {
  const dir = tmpStateDir();
  try {
    writeFileSync(join(dir, "ledger.a.ndjson"), row("a") + "\n");
    writeFileSync(join(dir, "ledger.b.ndjson"), row("b") + "\n");
    const rows = readLedgerUnionRecordsSync(dir, { rotationWindowMs: 1 }).rows;
    assert.deepEqual(rows.map((r) => String(r.marker)).sort(), ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
