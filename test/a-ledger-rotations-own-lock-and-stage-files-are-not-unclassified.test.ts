import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { LEDGER_FILENAME, LEDGER_ROTATION_LOCK_SUFFIX, LEDGER_STAGE_TAGS } from "../src/lib/ledger-path.js";
import { ledgerRotationLockPath } from "../src/lib/ledger.js";
import {
  auditLedgerUnion,
  readLedgerUnionRawLinesSync,
  readLedgerUnionRecordsSync,
  resolveLedgerUnion,
} from "../src/lib/ledger-union.js";

function row(marker: string): string {
  return JSON.stringify({ ts: "2026-10-04T12:00:00.000Z", step: "run.start", marker });
}

const ARCHIVE = "ledger.2026-10-04T12-00-00-000Z.ndjson.gz";
const stage = (base: string, tag: string): string => `${base}.${tag}-${process.pid}-${randomUUID()}`;

test("a ledger rotation's own lock and stage files are not unclassified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ledger-rotation-own-"));
  try {
    const live = join(dir, LEDGER_FILENAME);
    writeFileSync(live, row("live") + "\n");
    writeFileSync(join(dir, ARCHIVE), gzipSync(row("rotation") + "\n"));
    assert.equal(ledgerRotationLockPath(live), `${live}${LEDGER_ROTATION_LOCK_SUFFIX}`);
    assert.equal(ledgerRotationLockPath(live), join(dir, "ledger.ndjson.rotate.lock"));
    assert.deepEqual([...LEDGER_STAGE_TAGS].sort(), ["ledger-compact-tmp", "rotate-tmp"]);
    writeFileSync(ledgerRotationLockPath(live), "{}\n");
    for (const tag of LEDGER_STAGE_TAGS) {
      writeFileSync(join(dir, stage(LEDGER_FILENAME, tag)), row("stage-live") + "\n");
      writeFileSync(join(dir, stage(ARCHIVE, tag)), row("stage-archive") + "\n");
    }

    const readRaw = () => readLedgerUnionRawLinesSync(dir);
    const resolve = () => resolveLedgerUnion(dir, '"step":"run\\.start"');
    const markers: unknown[] = [];
    const audit = () => auditLedgerUnion(dir, { dedupeWindowPerStep: 200, onRecord: (r) => markers.push(r.marker) });
    for (const result of [readRaw(), readLedgerUnionRecordsSync(dir), resolve(), await audit()]) {
      assert.equal(result.ok, true);
      assert.deepEqual(result.unclassified, []);
      assert.deepEqual(result.unread, []);
      assert.deepEqual(result.archiveFiles, [join(dir, ARCHIVE)]);
    }
    assert.deepEqual(readRaw().rawLines, [row("rotation"), row("live")]);
    assert.equal(readRaw().filesRead, 2);

    const unknownNames = [
      "ledger.ndjson.bak",
      `ledger.ndjson.unknown-tmp-${process.pid}-${randomUUID()}`,
      `ledger.ndjson.rotate-tmp-notapid-${randomUUID()}`,
      `ledger.other.ndjson.rotate-tmp-${process.pid}-${randomUUID()}`,
      "ledger.ndjson.rotate.lock.bak",
    ];
    for (const name of unknownNames) writeFileSync(join(dir, name), row("unknown") + "\n");
    const unknownPaths = unknownNames.map((n) => join(dir, n)).sort();
    for (const result of [readRaw(), resolve(), await audit()]) {
      assert.deepEqual(result.unclassified?.slice().sort(), unknownPaths);
    }
    assert.deepEqual(readRaw().rawLines, [row("rotation"), row("live")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
