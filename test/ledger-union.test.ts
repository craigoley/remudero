import { createIncrementalLedgerUnion, readLedgerUnionRawLinesAsync, readLedgerUnionRawLinesSync, realLedgerFs } from "#src/lib/ledger-union.js";
import assert from "node:assert/strict";
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import {
  auditLedgerUnion,
  openLedgerUnion,
  readLedgerUnionRecords,
  readLedgerUnionRecordsSync,
  type LedgerGrepFsDeps,
} from "../src/lib/ledger-union.js";

test("ledger union audits malformed rows without losing later records", async () => {
  const dir = tmpStateDir();
  try {
    const gzip = join(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz");
    const plain = join(dir, "ledger.2026-01-02T00-00-00-000Z.ndjson");
    writeFileSync(gzip, gzipSync(`${row("before")}\n{not-json}\n[]\n${row("after")}\n`));
    writeFileSync(plain, `{not-json}\n${row("plain")}\n`);
    const seen: string[] = [];
    const audit = await auditLedgerUnion(dir, {
      dedupeWindowPerStep: 200,
      strictMalformed: true,
      onRecord: (record) => seen.push(String(record.marker)),
    });
    assert.deepEqual(seen, ["before", "after", "plain"]);
    assert.equal(audit.archiveCount, 2);
    assert.equal(audit.records, 3);
    assert.deepEqual(audit.unread, []);
    assert.equal(audit.ok, false);
    assert.deepEqual(audit.malformed, [
      { path: gzip, form: "gzip", count: 2, firstRowOrdinal: 2, lastRowOrdinal: 3 },
      { path: plain, form: "plain", count: 1, firstRowOrdinal: 1, lastRowOrdinal: 1 },
    ]);
    assert.ok(!JSON.stringify(audit).includes("not-json"), "audit retains positions, not raw bad payloads");
    const operational = await auditLedgerUnion(dir, { dedupeWindowPerStep: 200, onRecord: () => undefined });
    assert.equal(operational.ok, true, "a benchmark-only completeness rule cannot change dispatch history");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger union reports only a canonical leading timestamp for damaged archive rows", async () => {
  const dir = tmpStateDir();
  try {
    const archive = join(dir, "ledger.2026-01-02T00-00-00-000Z.ndjson.gz");
    writeFileSync(archive, gzipSync('{"ts":"2026-01-01T12:00:00.000Z","secret":"never-report",BAD}\n'
      + '{"ts":"2026-01-99T12:00:00.000Z",BAD}\n'
      + '{"step":"worker.attempt",BAD}\n'));
    const findings: { timestamp?: string }[] = [];
    for await (const _row of openLedgerUnion(dir, { onMalformedRow: (finding) => findings.push(finding) })) void _row;
    assert.deepEqual(findings.map((finding) => finding.timestamp), ["2026-01-01T12:00:00.000Z", undefined, undefined]);
    assert.ok(!JSON.stringify(findings).includes("never-report"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ledger union distinguishes live torn tail from unread archive", async () => {
  const dir = tmpStateDir();
  try {
    const live = join(dir, LEDGER_FILENAME);
    const complete = `${row("complete")}\n`;
    writeFileSync(live, complete + '{"ts":"2026-01-01T00:00:00.000Z","step":"run.start","marker":"late');
    const findings: Array<{ kind: string; resumeOffset?: number }> = [];
    const seen: string[] = [];
    for await (const record of openLedgerUnion(dir, { onMalformedRow: (finding) => findings.push(finding) })) {
      seen.push(String(record.marker));
    }
    assert.deepEqual(seen, ["complete"]);
    assert.deepEqual(findings, [{ path: live, form: "live", rowOrdinal: 2,
      kind: "live-torn-tail", resumeOffset: Buffer.byteLength(complete) }]);
    const archiveAudit = await auditLedgerUnion(dir, { dedupeWindowPerStep: 200,
      strictMalformed: true, onRecord: () => undefined });
    assert.equal(archiveAudit.ok, false, "a live-only corpus cannot stand in for an archive audit");
    assert.deepEqual(archiveAudit.malformed, []);
    appendFileSync(live, '"}\n');
    const recovered: string[] = [];
    const laterFindings: unknown[] = [];
    for await (const record of openLedgerUnion(dir, {
      liveStartOffset: Buffer.byteLength(complete), onMalformedRow: (finding) => laterFindings.push(finding),
    })) recovered.push(String(record.marker));
    assert.deepEqual(recovered, ["late"]);
    assert.deepEqual(laterFindings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("W1-T4767: a strict union read reports a live-file read failure", () => {
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
    const result = readLedgerUnionRecordsSync(dir, { requireArchives: true, refuseIncomplete: true }, fsDeps);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unread, [join(dir, LEDGER_FILENAME)]);
    assert.deepEqual(result.rows, [], "partial rotations are not a measured complete corpus");
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


test("strict ledger readers refuse an unenumerated corpus while preserving best-effort live reads", async (t) => {
  const dir = tmpStateDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz"), gzipSync(`${row("gzip")}\n`));
  writeFileSync(join(dir, "ledger.2026-01-02T00-00-00-000Z.ndjson"), `${row("plain")}\n`);
  writeFileSync(join(dir, LEDGER_FILENAME), `${row("live")}\n`);
  const readers = [
    () => readLedgerUnionRecordsSync(dir, { refuseIncomplete: true }),
    () => readLedgerUnionRawLinesSync(dir, { refuseIncomplete: true }),
    () => readLedgerUnionRawLinesAsync(dir, { refuseIncomplete: true }),
  ];
  for (const read of readers) {
    const complete = await read();
    assert.equal(complete.ok, true);
    assert.equal(complete.archiveCount, 2);
    assert.equal(complete.filesRead, 3);
    assert.equal("rows" in complete ? complete.rows.length : complete.rawLines.length, 3);
  }
  for (const code of ["EACCES", "ENOENT"]) {
    let denied = 0;
    const listing = t.mock.method(realLedgerFs, "readdirSync", (path: string) => {
      assert.equal(path, dir);
      denied += 1;
      throw Object.assign(new Error(`controlled ${code}`), { code });
    });
    try {
      for (const read of readers) {
        const partial = await read();
        assert.equal(partial.ok, false, `${code}: a readable live path does not prove rotation absence`);
        assert.deepEqual(partial.unread, [dir]);
        assert.deepEqual("rows" in partial ? partial.rows : partial.rawLines, []);
        assert.equal(partial.liveFileRead, true);
      }
      const bestEffort = readLedgerUnionRecordsSync(dir);
      assert.equal(bestEffort.ok, true);
      assert.deepEqual(bestEffort.unread, []);
      assert.deepEqual(bestEffort.rows.map((record) => record.marker), ["live"]);
      for (const best of [readLedgerUnionRawLinesSync(dir), await readLedgerUnionRawLinesAsync(dir)]) {
        assert.equal(best.ok, true);
        assert.deepEqual(best.unread, []);
        assert.equal(best.rawLines.length, 1);
        assert.equal(JSON.parse(best.rawLines[0]).marker, "live");
      }
      assert.equal(denied, 6, "all three strict and best-effort entrypoints attempted enumeration");
    } finally { listing.mock.restore(); }
  }
  for (const read of readers) assert.equal((await read()).archiveCount, 2, "restored enumeration sees both archive forms");
});

test("strict ledger readers distinguish a readable empty directory from an actual non-directory", async (t) => {
  const dir = tmpStateDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "not-a-directory");
  writeFileSync(file, "owned fixture");
  for (const stateDir of [dir, file, join(dir, "absent")]) {
    const reads = [
      readLedgerUnionRecordsSync(stateDir, { refuseIncomplete: true }),
      readLedgerUnionRawLinesSync(stateDir, { refuseIncomplete: true }),
      await readLedgerUnionRawLinesAsync(stateDir, { refuseIncomplete: true }),
    ];
    for (const result of reads) {
      assert.equal(result.ok, stateDir === dir);
      assert.deepEqual(result.unread, stateDir === dir ? [] : [stateDir]);
      assert.deepEqual("rows" in result ? result.rows : result.rawLines, []);
    }
  }
});


test("strict incremental ledger reads cannot reuse an empty corpus signature after directory denial", (t) => {
  const dir = tmpStateDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let denied = false;
  const read = createIncrementalLedgerUnion({ holder: "strict-directory-test", reducerVersion: "1" }, {
    ...realLedgerFs,
    readdirSync: (path) => {
      if (denied) throw Object.assign(new Error("controlled enumeration denial"), { code: "EACCES" });
      return realLedgerFs.readdirSync(path);
    },
  });
  const opts = { step: "run.start", refuseIncomplete: true };
  const empty = read(dir, opts);
  assert.equal(empty.ok, true);
  assert.strictEqual(read(dir, opts), empty, "positive control: unchanged readable corpus uses the actual cache");
  denied = true;
  const refused = read(dir, opts);
  assert.equal(refused.ok, false, "a matching signature cannot prove that enumeration succeeded");
  assert.deepEqual(refused.unread, [dir]);
  assert.deepEqual(refused.rows, []);
  denied = false;
  assert.equal(read(dir, opts).ok, true, "a denied result is not cached as complete");
  writeFileSync(join(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz"), gzipSync(`${row("gzip")}\n`));
  writeFileSync(join(dir, "ledger.2026-01-02T00-00-00-000Z.ndjson"), `${row("plain")}\n`);
  writeFileSync(join(dir, LEDGER_FILENAME), `${row("live")}\n`);
  const populated = read(dir, opts);
  assert.deepEqual(populated.rows.map((record) => record.marker), ["gzip", "plain", "live"]);
  assert.strictEqual(read(dir, opts), populated);
  denied = true;
  assert.equal(read(dir, opts).ok, false);
  denied = false;
  assert.deepEqual(read(dir, opts).rows, populated.rows);
  const best = read(dir);
  denied = true;
  assert.equal(read(dir).ok, best.ok, "best-effort behavior remains available");
});
