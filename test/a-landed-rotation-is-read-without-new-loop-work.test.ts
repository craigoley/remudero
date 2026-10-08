import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { createLedgerRotationMemo, ledgerRotationEntries } from "../src/lib/ledger-union.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const holder = "landed-rotation";
const noParse = () => { throw new Error("the memo must supply the rotation"); };

test("digest worker replies validate rows and errors before a clean exit", async () => {
  const digest = { schema: 1, holder, reducerVersion: "1", archive: "ledger.ndjson.1.gz", key: "1:2",
    read: { rows: [{ keep: true, value: "🚀\u2028" }], torn: 1, tornLines: ["broken row"] } };
  const invalid = [null, {}, { ...digest, schema: 2 }, ...[
    { ...digest.read, rows: null }, { ...digest.read, rows: [null] },
    { ...digest.read, rows: [[]] }, { ...digest.read, rows: [1] },
    { ...digest.read, torn: -1 }, { ...digest.read, torn: 0.5 },
    { ...digest.read, tornLines: null }, { ...digest.read, tornLines: [] },
    { ...digest.read, tornLines: [1] },
  ].map((read) => ({ ...digest, read }))];
  const requests = [
    { operation: "stringify", value: digest },
    { operation: "parse", value: JSON.stringify(digest) },
    ...invalid.map((value) => ({ operation: "parse", value: JSON.stringify(value) })),
    { operation: "parse", value: "{" },
    { operation: "stringify", value: { ...digest, value: 1n } },
  ].map((request, id) => ({ id, ...request }));
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    import("tsx/esm/api").then(({ register }) => {
      register();
      return import(workerData.moduleUrl);
    }).then(() => {
      let received = 0;
      parentPort.on("message", () => {
        if (++received === workerData.requestCount) parentPort.close();
      });
      parentPort.postMessage({ ready: true });
    });
  `, { eval: true, execArgv: ["--enable-source-maps"],
    workerData: { kind: "rotation-digest-codec", requestCount: requests.length,
      moduleUrl: new URL("../src/lib/ledger-union.ts", import.meta.url).href } });
  try {
    const [ready] = await once(worker, "message");
    assert.deepEqual(ready, { ready: true });
    const replies: Array<{ id: number; value?: unknown; error?: string }> = [];
    worker.on("message", (reply) => replies.push(reply));
    const exited = once(worker, "exit");
    for (const request of requests) worker.postMessage(request);
    assert.deepEqual(await exited, [0], "the worker exits normally after replying to every request");
    assert.deepEqual(replies, [
      { id: 0, value: JSON.stringify(digest) }, { id: 1, value: digest },
      ...invalid.map((_, index) => ({ id: index + 2, value: undefined })),
      { id: requests.length - 2, error: "SyntaxError" },
      { id: requests.length - 1, error: "TypeError" },
    ]);
  } finally {
    await worker.terminate();
  }
});

test("digest worker failure settles concurrent writes and the next load restarts it", async () => {
  const workers = createRequire(import.meta.url)("node:worker_threads") as typeof import("node:worker_threads");
  const original = workers.Worker;
  const fx = writeLedger([], { rotations: [{ at: "2026-10-01T00:00:00.000Z", rows: [{ keep: true }] }] });
  let requests = 0;
  try {
    workers.Worker = class extends original {
      override postMessage(): void {
        if (++requests === 2) {
          this.emit("error", new Error("fixture worker failure"));
          void this.terminate();
        }
      }
    };
    syncBuiltinESMExports();
    const entries = ledgerRotationEntries(readdirSync(fx.dir), fx.dir);
    const make = (name: string) => createLedgerRotationMemo((rows) => rows,
      { holder: name, durableDigest: { reducerVersion: "1" } });
    const memos = [make("failed-one"), make("failed-two")];
    await Promise.all(memos.map((memo) => memo.load(entries)));
    assert.equal(requests, 2);
    for (const memo of memos) {
      assert.equal(memo.retention().digestOutcomes?.writeFailed, 1);
      assert.equal(memo.retention().digestErrors?.writeFailed, "Error");
      assert.equal(memo.retention().failedArchives, 0);
      assert.deepEqual(memo.pass().rotationRecords(entries[0], noParse).rows, [{ keep: true }]);
    }
    workers.Worker = original;
    syncBuiltinESMExports();
    const recovered = make("recovered");
    await recovered.load(entries);
    assert.equal(recovered.retention().digestOutcomes?.written, 1);
  } finally {
    workers.Worker = original;
    syncBuiltinESMExports();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("W1-T6337: the read that lands a rotation does not serialize its digest inline", async (t) => {
  for (const gz of [false, true]) {
    const fx = writeLedger([], { rotations: [] });
    try {
      const memo = createLedgerRotationMemo((rows) => rows, { holder, durableDigest: { reducerVersion: "1" } });
      await memo.load([]);
      const rows = Array.from({ length: 20_001 }, (_, index) => ({ step: "fixture", index }));
      writeLedger([], { dir: fx.dir, rotations: [{ at: "2026-10-01T01:00:00.000Z", rows, gz }] });
      const entries = ledgerRotationEntries(readdirSync(fx.dir), fx.dir);
      assert.equal(entries.length, 1, "positive control: the newly landed rotation exists");
      const pass = memo.pass();
      pass.rotationRecords(entries[0], noParse);
      assert.equal(pass.complete(), false);
      const original = JSON.stringify;
      let serializedDigests = 0;
      const spy = t.mock.method(JSON, "stringify", (...args: Parameters<typeof JSON.stringify>) => {
        if (args[0]?.holder === holder && args[0]?.read?.rows) serializedDigests++;
        return original(...args);
      });
      JSON.stringify({ holder, read: { rows: [] } });
      assert.equal(serializedDigests, 1, "positive control: the spy sees digest serialization");
      serializedDigests = 0;
      try {
        await memo.load(pass.missing());
        assert.equal(serializedDigests, 0, "the reading thread must not serialize an archive digest");
      } finally {
        spy.mock.restore();
      }
      assert.deepEqual(memo.pass().rotationRecords(entries[0], noParse).rows, rows);
      assert.equal(memo.retention().digestMisses, 1);
      assert.equal(memo.retention().digestOutcomes?.written, 1);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  }
});

test("W1-T6337: a landed rotation still leaves a digest a cold memo hits", async () => {
  const fx = writeLedger([], { rotations: [{ at: "2026-10-01T02:00:00.000Z", gz: true,
    rows: [{ keep: true, value: "🚀\u2028" }, { keep: false }] }] });
  try {
    const entries = ledgerRotationEntries(readdirSync(fx.dir), fx.dir);
    const options = { holder, durableDigest: { reducerVersion: "1" } };
    const reduce = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row.keep);
    const first = createLedgerRotationMemo(reduce, options);
    await first.load(entries);
    const target = join(fx.dir, "cache", "rotation-digests", holder, `${basename(entries[0].path)}.json`);
    const saved = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(saved.read, { rows: [{ keep: true, value: "🚀\u2028" }], torn: 0, tornLines: [] });
    assert.equal(saved.schema, 1);
    assert.equal(saved.holder, holder);
    assert.equal(saved.archive, basename(entries[0].path));
    assert.equal(saved.reducerVersion, "1");
    const original = Array.prototype.every;
    let rowWalks = 0;
    Array.prototype.every = (function (this: unknown[], ...args: Parameters<typeof original>) {
      if (this.some((row) => row && typeof row === "object" && "keep" in row)) rowWalks++;
      return original.apply(this, args);
    }) as typeof original;
    [{ keep: true }].every(() => true);
    assert.equal(rowWalks, 1, "positive control: the spy sees per-row validation");
    rowWalks = 0;
    const cold = createLedgerRotationMemo(reduce, { ...options,
      readFile: async () => { throw new Error("a digest hit must not read the archive"); } });
    try {
      await cold.load(entries);
      assert.equal(rowWalks, 0, "restoring a digest must not validate every row on the reading thread");
    } finally {
      Array.prototype.every = original;
    }
    assert.equal(cold.retention().digestHits, 1);
    assert.equal(cold.retention().digestMisses, 0);
    assert.deepEqual(cold.pass().rotationRecords(entries[0], noParse), saved.read);
    for (const read of [
      { ...saved.read, rows: [null] }, { ...saved.read, rows: [[]] }, { ...saved.read, rows: [1] },
      { ...saved.read, torn: 1, tornLines: [1] }, { ...saved.read, torn: 1, tornLines: [] },
    ]) {
      writeFileSync(target, JSON.stringify({ ...saved, read }));
      const corrupt = createLedgerRotationMemo(reduce, options);
      await corrupt.load(entries);
      assert.equal(corrupt.retention().digestOutcomes?.corrupt, 1);
      assert.equal(corrupt.retention().digestMisses, 1);
      assert.deepEqual(corrupt.pass().rotationRecords(entries[0], noParse), saved.read);
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("digest serialization failures preserve rows and carry the codec error", async () => {
  const fx = writeLedger([], { rotations: [{ at: "2026-10-01T03:00:00.000Z", rows: [{ keep: true }] }] });
  try {
    const entries = ledgerRotationEntries(readdirSync(fx.dir), fx.dir);
    for (const value of [1n, () => "cannot clone"]) {
      const memo = createLedgerRotationMemo((rows) => rows.map((row) => ({ ...row, value })),
        { holder, durableDigest: { reducerVersion: "1" } });
      await memo.load(entries);
      assert.equal(memo.retention().digestOutcomes?.writeFailed, 1);
      assert.equal(memo.retention().digestErrors?.writeFailed, typeof value === "bigint" ? "TypeError" : "25");
      assert.equal(memo.retention().failedArchives, 0);
      assert.deepEqual(memo.pass().rotationRecords(entries[0], noParse).rows, [{ keep: true, value }]);
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("concurrent digest requests keep each holder's contents and accounting", async () => {
  const fx = writeLedger([], { rotations: [{ at: "2026-10-01T04:00:00.000Z", rows: [{ keep: true }, { keep: false }] }] });
  try {
    const entries = ledgerRotationEntries(readdirSync(fx.dir), fx.dir);
    const make = (name: string) => createLedgerRotationMemo((rows) => rows.filter((row) => row.keep),
      { holder: name, durableDigest: { reducerVersion: "1" } });
    const holders = ["concurrent-one", "concurrent-two"];
    const first = holders.map(make);
    await Promise.all(first.map((memo) => memo.load(entries)));
    const cold = holders.map(make);
    await Promise.all(cold.map((memo) => memo.load(entries)));
    for (const memo of first) {
      assert.equal(memo.retention().digestOutcomes?.written, 1);
      assert.equal(memo.retention().digestMisses, 1);
    }
    for (const memo of cold) {
      assert.equal(memo.retention().digestHits, 1);
      assert.equal(memo.retention().digestMisses, 0);
      assert.deepEqual(memo.pass().rotationRecords(entries[0], noParse).rows, [{ keep: true }]);
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
