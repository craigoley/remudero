import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import { ledgerCarriedPrefixPath, ledgerRetainedStepsPath } from "../src/lib/ledger.js";
import {
  auditLedgerUnion,
  openLedgerUnion,
  readLedgerUnionRawLinesSync,
  readLedgerUnionRecordsSync,
  resolveLedgerUnion,
} from "../src/lib/ledger-union.js";

function row(marker: string): string {
  return JSON.stringify({ ts: "2026-10-04T12:00:00.000Z", step: "run.start", marker });
}

for (const form of ["plain", "gzip"] as const) {
  test(`the ledger's own sidecar files are not an unclassified archive (${form})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "rmd-ledger-sidecars-"));
    try {
      const live = join(dir, LEDGER_FILENAME);
      const archive = join(dir, `ledger.2026-10-04T12-00-00-000Z.ndjson${form === "gzip" ? ".gz" : ""}`);
      writeFileSync(live, row("live") + "\n");
      writeFileSync(archive, form === "gzip" ? gzipSync(row("rotation") + "\n") : row("rotation") + "\n");
      assert.equal(ledgerCarriedPrefixPath(live), join(dir, "ledger.ndjson.carried.json"));
      assert.equal(ledgerRetainedStepsPath(live), join(dir, "ledger.ndjson.retained-steps.json"));
      writeFileSync(ledgerCarriedPrefixPath(live), row("carried-sidecar") + "\n");
      writeFileSync(ledgerRetainedStepsPath(live), row("retained-sidecar") + "\n");

      const readRaw = () => readLedgerUnionRawLinesSync(dir);
      const readRecords = () => readLedgerUnionRecordsSync(dir);
      const resolve = () => resolveLedgerUnion(dir, '"step":"run\\.start"');
      const auditMarkers: unknown[] = [];
      const audit = () => auditLedgerUnion(dir, {
        dedupeWindowPerStep: 200,
        onRecord: (record) => auditMarkers.push(record.marker),
      });
      for (const result of [readRaw(), readRecords(), resolve(), await audit()]) {
        assert.equal(result.ok, true);
        assert.deepEqual(result.unclassified, []);
        assert.deepEqual(result.unread, []);
        assert.deepEqual(result.archiveFiles, [archive]);
        assert.equal(result.archiveCount, 1);
      }
      const expectedLines = [row("rotation"), row("live")];
      assert.deepEqual(readRaw().rawLines, expectedLines);
      assert.equal(readRaw().filesRead, 2);
      assert.deepEqual(resolve().matches, expectedLines);
      assert.deepEqual(readRecords().rows.map((record) => record.marker), ["rotation", "live"]);
      assert.deepEqual(auditMarkers, ["rotation"]);
      const streamMarkers: unknown[] = [];
      for await (const record of openLedgerUnion(dir)) streamMarkers.push(record.marker);
      assert.deepEqual(streamMarkers, ["rotation", "live"]);

      const unknownNames = [
        "ledger.ndjson.bak",
        "ledger.2026-10-04T12-00-00-000Z.ndjson.gzip",
        "ledger.other.carried.json",
        "ledger.ndjson.retained-steps.json.bak",
      ];
      for (const name of unknownNames) writeFileSync(join(dir, name), row("unknown") + "\n");
      const unknownPaths = unknownNames.map((name) => join(dir, name)).sort();
      for (const result of [readRaw(), readRecords(), resolve(), await audit()]) {
        assert.deepEqual(result.unclassified?.slice().sort(), unknownPaths);
        assert.deepEqual(result.archiveFiles, [archive]);
      }
      assert.deepEqual(readRaw().rawLines, expectedLines);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
