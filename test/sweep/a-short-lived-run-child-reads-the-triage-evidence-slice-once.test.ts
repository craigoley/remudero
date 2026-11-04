import assert from "node:assert/strict";
import fs, { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Config } from "#src/lib/config.js";
import { createEscalationTriageHistoryReader, ESCALATION_TRIAGE_EVIDENCE_SLICE } from "#src/lib/sweep.js";
import { buildEscalationTriageRuntime } from "#src/run-task.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const slice = ESCALATION_TRIAGE_EVIDENCE_SLICE;
const row = (id: string) => ({ step: "fix.dispatch", task_id: id, head_sha: "head", mode: "ci-log" });
const archiveName = "ledger.2026-10-01T00-00-00-000Z.ndjson.gz";
const snapshotPath = (dir: string) => join(dir, "cache", "rotation-slices", `${encodeURIComponent(slice.holder).replaceAll(".", "%2E")}.json`);

function fixture(t: { after(fn: () => void): void }) {
  const data = writeLedger([row("live")], { rotations: [
    { at: "2026-10-01T00:00:00.000Z", gz: true, rows: [row("old"), { step: "heartbeat.tick" }] },
    { at: "2026-10-02T00:00:00.000Z", gz: true, rows: [row("newer")] },
  ] });
  t.after(() => rmSync(data.dir, { recursive: true, force: true }));
  return data;
}

function countingReader() {
  const reads: string[] = [];
  let bytes = 0;
  const counted = (path: string, buf: Buffer) => { reads.push(path); bytes += buf.length; return buf; };
  const reader = createEscalationTriageHistoryReader({ slice,
    fs: { readdirSync: (path) => readdirSync(path), existsSync, statSync, gunzipSync,
      readFileSync: (path) => counted(path, readFileSync(path)),
      readRangeSync: (path, start, end) => {
        const fd = openSync(path, "r");
        try {
          const buf = Buffer.alloc(end - start);
          return counted(path, buf.subarray(0, readSync(fd, buf, 0, buf.length, start)));
        } finally { closeSync(fd); }
      },
    },
    readFile: async (path) => counted(path, await readFile(path)),
  });
  return { reader, reads, bytes: () => bytes };
}

test("W1-T9957: a fresh triage evidence reader answers from the shared slice snapshot", async (t) => {
  const data = fixture(t);
  const daemon = countingReader();
  const expected = await daemon.reader(data.dir);
  assert.equal(expected.ok, true);
  assert.equal(daemon.reads.filter((path) => path.endsWith(".gz")).length, 2, "positive control: cold load reads both archives");
  const snapshot = JSON.parse(readFileSync(snapshotPath(data.dir), "utf8"));
  assert.equal(snapshot.holder, slice.holder);
  assert.equal(snapshot.rotations.length, 2);
  assert.deepEqual(snapshot.rotations.map((entry: { read: { rows: unknown[] } }) => entry.read.rows.length), [1, 1]);

  const digestReads: string[] = [];
  const original = fs.promises.readFile;
  fs.promises.readFile = ((path: unknown, ...args: unknown[]) => {
    if (String(path).includes("rotation-digests")) digestReads.push(String(path));
    return (original as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    for (const refresh of [false, true]) {
      const child = countingReader();
      const actual = refresh ? await child.reader(data.dir) : child.reader.current(data.dir);
      assert.deepEqual(actual.rows, expected.rows);
      assert.equal(actual.ok, true);
      assert.deepEqual(child.reads.map((path) => basename(path)), [basename(snapshotPath(data.dir)), "ledger.ndjson"]);
      assert.equal(child.reader.lastLoad().snapshotHit, true);
      assert.equal(child.reader.lastLoad().rotationsRead, 0);
      assert.equal(child.reader.lastLoad().bytesRead, child.bytes());
      data.append([row(refresh ? "tail2" : "tail1")]);
      assert.equal(child.reader.current(data.dir).rows.at(-1)?.task_id, refresh ? "tail2" : "tail1");
      expected.rows = [...expected.rows, row(refresh ? "tail2" : "tail1")];
    }
  } finally {
    fs.promises.readFile = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(digestReads, [], "a fresh async load also reads no durable digest");
});

test("W1-T9957: a stale triage slice snapshot falls back to the per-rotation load", async (t) => {
  for (const damage of ["changed", "missing", "json", "entry", "shape", "torn", "duplicate", "version", "holder", "unreadable", "added", "removed"]) {
    await t.test(damage, async (t) => {
      const data = fixture(t);
      await createEscalationTriageHistoryReader({ slice })(data.dir);
      const path = snapshotPath(data.dir);
      const snapshot = JSON.parse(readFileSync(path, "utf8"));
      if (damage === "changed") writeFileSync(join(data.dir, archiveName), gzipSync(JSON.stringify(row("changed-with-more-bytes")) + "\n"));
      if (damage === "missing") rmSync(path);
      if (damage === "json") writeFileSync(path, "{broken");
      if (damage === "entry") { snapshot.rotations[0] = null; writeFileSync(path, JSON.stringify(snapshot)); }
      if (damage === "shape") { snapshot.rotations[0].read.rows = [null]; writeFileSync(path, JSON.stringify(snapshot)); }
      if (damage === "torn") { snapshot.rotations[0].read.torn = -1; writeFileSync(path, JSON.stringify(snapshot)); }
      if (damage === "duplicate") { snapshot.rotations.push(snapshot.rotations[0]); writeFileSync(path, JSON.stringify(snapshot)); }
      if (damage === "version") { snapshot.reducerVersion = "obsolete"; writeFileSync(path, JSON.stringify(snapshot)); }
      if (damage === "holder") { snapshot.holder = "foreign"; writeFileSync(path, JSON.stringify(snapshot)); }
      if (damage === "unreadable") writeFileSync(join(data.dir, archiveName), "broken gzip");
      if (damage === "added") writeFileSync(join(data.dir, "ledger.2026-10-03T00-00-00-000Z.ndjson.gz"), gzipSync(JSON.stringify(row("added")) + "\n"));
      if (damage === "removed") rmSync(join(data.dir, archiveName));
      const child = countingReader();
      const actual = await child.reader(data.dir);
      const expected = [row(damage === "changed" ? "changed-with-more-bytes" : "old"), row("newer")];
      if (damage === "removed") expected.shift();
      if (damage === "added") expected.push(row("added"));
      expected.push(row("live"));
      assert.equal(actual.ok, damage !== "unreadable");
      assert.deepEqual(actual.rows, damage === "unreadable" ? [] : expected);
      if (["changed", "added"].includes(damage)) assert.equal(child.reads.filter((file) => file.endsWith(".gz")).length, 1);
      if (["missing", "json", "entry", "shape", "torn", "duplicate", "version", "holder"].includes(damage)) {
        assert.equal(child.reader.lastLoad().snapshotHit, false);
        assert.equal(child.reader.lastLoad().digestHits, 2, "fallback uses the existing per-rotation digests");
      }
      if (damage === "unreadable") { assert.equal(actual.ok, false); assert.deepEqual(actual.rows, []); }
      assert.equal(readdirSync(join(data.dir, "cache", "rotation-slices")).some((name) => name.endsWith(".tmp")), false);
    });
  }
});

test("W1-T9957: a failed snapshot publication preserves the old snapshot and removes its temporary file", async (t) => {
  const data = fixture(t);
  const daemon = createEscalationTriageHistoryReader({ slice });
  const expected = await daemon(data.dir);
  const path = snapshotPath(data.dir);
  const originalText = readFileSync(path, "utf8");
  const rename = fs.promises.rename;
  let publications = 0;
  fs.promises.rename = async (from, to) => {
    if (String(to) === path) {
      publications++;
      assert.equal(JSON.parse(readFileSync(from, "utf8")).rotations.length, 2);
      assert.equal(readFileSync(path, "utf8"), originalText, "readers still see the complete old file before rename");
      throw new Error("EIO: publication failed");
    }
    return rename(from, to);
  };
  try {
    assert.deepEqual((await daemon(data.dir)).rows, expected.rows);
  } finally { fs.promises.rename = rename; }
  assert.equal(publications, 1);
  assert.match(daemon.lastLoad().snapshotError!, /EIO: publication failed/);
  assert.equal(readFileSync(path, "utf8"), originalText);
  assert.deepEqual(readdirSync(join(data.dir, "cache", "rotation-slices")), [basename(path)]);
  assert.deepEqual(createEscalationTriageHistoryReader({ slice }).current(data.dir).rows, expected.rows);
  const unlink = fs.promises.unlink;
  fs.promises.unlink = async (target) => {
    if (String(target).startsWith(`${path}.`)) throw Object.assign(new Error("EIO: cleanup failed"), { code: "EIO" });
    return unlink(target);
  };
  try { assert.deepEqual((await daemon(data.dir)).rows, expected.rows); }
  finally { fs.promises.unlink = unlink; }
  assert.match(daemon.lastLoad().snapshotError!, /EIO: cleanup failed/);
  assert.deepEqual(readdirSync(join(data.dir, "cache", "rotation-slices")), [basename(path)]);
});

test("W1-T9957: snapshot stat failures stay observable while authoritative reads recover", async (t) => {
  const data = fixture(t);
  await createEscalationTriageHistoryReader({ slice })(data.dir);
  let unavailable = true;
  const reader = createEscalationTriageHistoryReader({ slice,
    fs: { readdirSync: (path) => readdirSync(path), existsSync, readFileSync, gunzipSync,
      statSync: (path) => {
        if ((path === join(data.dir, archiveName) && unavailable) || path.includes("rotation-digests")) {
          unavailable = false;
          throw Object.assign(new Error("EIO: stat failed"), { code: "EIO" });
        }
        return statSync(path);
      },
    },
  });
  const actual = await reader(data.dir);
  assert.equal(actual.ok, true);
  assert.deepEqual(actual.rows, [row("old"), row("newer"), row("live")]);
  assert.match(reader.lastLoad().snapshotError!, /EIO: stat failed/);
});

test("W1-T9957: a synchronous child rejects a stale manifest and preserves unread-rotation refusal", async (t) => {
  const data = fixture(t);
  await createEscalationTriageHistoryReader({ slice })(data.dir);
  writeFileSync(join(data.dir, archiveName), gzipSync(JSON.stringify(row("sync-changed")) + "\n"));
  const changed = countingReader();
  assert.deepEqual(changed.reader.current(data.dir).rows, [row("sync-changed"), row("newer"), row("live")]);
  assert.equal(changed.reads.filter((path) => path.endsWith(".gz")).length, 1);
  assert.equal(changed.reader.lastLoad().rotationsRead, 1);
  writeFileSync(join(data.dir, archiveName), "unreadable gzip");
  const unread = countingReader();
  const result = unread.reader.current(data.dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rows, []);
});

test("W1-T9957: fallback accounts for a rejected digest as well as the archive it loads", async (t) => {
  const data = fixture(t);
  await createEscalationTriageHistoryReader({ slice })(data.dir);
  rmSync(snapshotPath(data.dir));
  const directory = join(data.dir, "cache", "rotation-digests", encodeURIComponent(slice.holder).replaceAll(".", "%2E"));
  writeFileSync(join(directory, `${archiveName}.json`), "{damaged digest");
  const original = fs.promises.readFile;
  let digestBytes = 0;
  fs.promises.readFile = (async (path: unknown, ...args: unknown[]) => {
    const value = await (original as (...args: unknown[]) => Promise<Buffer>)(path, ...args);
    if (String(path).includes("rotation-digests")) digestBytes += value.length;
    return value;
  }) as typeof original;
  syncBuiltinESMExports();
  const child = countingReader();
  try {
    assert.deepEqual((await child.reader(data.dir)).rows, [row("old"), row("newer"), row("live")]);
  } finally {
    fs.promises.readFile = original;
    syncBuiltinESMExports();
  }
  assert.ok(digestBytes > 0);
  assert.equal(child.reader.lastLoad().digestHits, 1);
  assert.equal(child.reader.lastLoad().digestMisses, 1);
  assert.equal(child.reader.lastLoad().rotationsRead, 1);
  assert.equal(child.reader.lastLoad().bytesRead, child.bytes() + digestBytes);
});

test("W1-T9957: the lazy triage runtime records the snapshot read cost", async (t) => {
  const data = fixture(t);
  await createEscalationTriageHistoryReader({ slice })(data.dir);
  const runtime = buildEscalationTriageRuntime({ root: data.dir, config: { root: data.dir } as Config, owner: "o", repo: "r" }, {
    readPolicy: () => undefined, seenAt: () => undefined, windowMs: () => 1,
  });
  const settings = runtime({ issues: {} as never, ledgerPath: data.path, runId: "child" });
  const evidence = settings.evidence!({ class: "BLOCKED", taskId: "old", headSha: "head", cause: "conflict",
    summary: "blocked", detail: "blocked", options: [], recommendation: "retry" });
  assert.equal(evidence.rekick?.newFailureSinceLastStrike, true);
  const receipt = readFileSync(data.path, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.step === "escalation_triage.evidence_read");
  assert.ok(receipt, "the real runtime records a read receipt");
  assert.equal(receipt.evidence_snapshot_hit, true);
  assert.equal(receipt.evidence_rotations_read, 0);
  assert.equal(receipt.evidence_bytes_read, readFileSync(snapshotPath(data.dir)).length + Buffer.byteLength(JSON.stringify(row("live")) + "\n"));
});

test("W1-T9957: repeated escalations record each evidence read byte once", async (t) => {
  const data = fixture(t);
  await createEscalationTriageHistoryReader({ slice })(data.dir);
  const child = countingReader();
  const runtime = buildEscalationTriageRuntime({ root: data.dir, config: { root: data.dir } as Config, owner: "o", repo: "r" }, {
    evidenceHistory: child.reader, readPolicy: () => undefined, seenAt: () => undefined, windowMs: () => 1,
  });
  const settings = runtime({ issues: {} as never, ledgerPath: data.path, runId: "child" });
  const escalation = { class: "BLOCKED" as const, taskId: "old", headSha: "head", cause: "conflict" as const,
    summary: "blocked", detail: "blocked", options: [], recommendation: "retry" };
  settings.evidence!(escalation);
  settings.evidence!(escalation);
  let receipts = readFileSync(data.path, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.step === "escalation_triage.evidence_read");
  assert.equal(receipts.length, 2);
  assert.equal(receipts.reduce((sum, entry) => sum + entry.evidence_bytes_read, 0), child.bytes());
  const before = child.bytes();
  await runtime.refresh(data.path);
  settings.evidence!(escalation);
  receipts = readFileSync(data.path, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.step === "escalation_triage.evidence_read");
  assert.equal(receipts.at(-1).evidence_bytes_read, child.bytes() - before);
  assert.equal(receipts.at(-1).evidence_rotations_read, 0);
});
