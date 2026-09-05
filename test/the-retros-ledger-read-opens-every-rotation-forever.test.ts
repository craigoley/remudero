/**
 * W1-T2833 — the retro follow-up reader must be bounded by a correctness-derived window, while
 * resolveLedgerUnion must return strings that do not keep each decompressed rotation reachable.
 *
 * The two controls are deliberately separate: read-call recording proves the window without
 * making a heap claim, and an --expose-gc child process measures retained bytes against returned
 * payload without relying on an explanation of V8's string representation.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { resolveLedgerUnion, type LedgerGrepFsDeps } from "../src/lib/ledger-grep.js";
import { mineFollowups } from "../src/lib/retro.js";
import { followupLedgerUnionNdjson } from "../src/run-task.js";

const NOW_MS = Date.parse("2026-09-01T00:00:00.000Z");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const EXPECTED_SINCE = "2026-08-02T00:00:00.000Z";

function line(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

test("the follow-up reader opens only rotations in its 30-day window and never decompresses an older one", () => {
  const names = [
    "ledger.2026-07-01T00-00-00-000Z.ndjson.gz",
    "ledger.2026-08-02T00-00-00-000Z.ndjson.gz",
    "ledger.2026-08-20T00-00-00-000Z.ndjson.gz",
  ];
  const opened: string[] = [];
  const decompressed: string[] = [];
  const fsDeps: LedgerGrepFsDeps = {
    readdirSync: () => names,
    existsSync: () => false,
    readFileSync: (path) => {
      opened.push(basename(path));
      return Buffer.from(basename(path), "utf8");
    },
    gunzipSync: (buf) => {
      const name = buf.toString("utf8");
      decompressed.push(name);
      return Buffer.from(
        line({
          ts: "2026-08-20T00:00:00.000Z",
          step: "report.followups",
          run_id: name,
          task_id: "W1-T2833",
          entries: [{ type: "task", text: name }],
        }) + "\n",
      );
    },
  };

  const result = followupLedgerUnionNdjson("/synthetic-state", {
    now: () => NOW_MS,
    fsDeps,
  });

  assert.equal(new Date(NOW_MS - THIRTY_DAYS_MS).toISOString(), EXPECTED_SINCE, "the fixed clock's derived floor is explicit");
  assert.deepEqual(
    opened,
    names.slice(1),
    `only rotations stamped at or after ${EXPECTED_SINCE} are opened`,
  );
  assert.deepEqual(decompressed, names.slice(1), "an out-of-window rotation is skipped before decompression");
  assert.equal(result.split("\n").filter(Boolean).length, 2, "both in-window matches are returned");
});

test("the 30-day floor preserves a source-to-harvest lag of 17.2 days without re-minting the follow-up", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-followup-window-lag-"));
  const sourceTs = new Date(NOW_MS - 17.2 * 24 * 60 * 60 * 1_000).toISOString();
  const runId = "RUN-FAR-LAG";
  const entryId = `${runId}:${sourceTs}:0`;
  try {
    const source = line({
      ts: sourceTs,
      step: "report.followups",
      run_id: runId,
      task_id: "W1-FAR-LAG",
      entries: [{ type: "task", text: "retain the delayed follow-up" }],
    });
    writeFileSync(join(dir, "ledger.2026-08-15T20-00-00-000Z.ndjson.gz"), gzipSync(Buffer.from(source + "\n")));
    writeFileSync(
      join(dir, "ledger.ndjson"),
      line({
        ts: new Date(NOW_MS).toISOString(),
        step: "followup.harvested",
        run_id: runId,
        task_id: "W1-FAR-LAG",
        entry_id: entryId,
        type: "task",
        text: "retain the delayed follow-up",
      }) + "\n",
    );

    const ndjson = followupLedgerUnionNdjson(dir, { now: () => NOW_MS });
    const records = ndjson.split("\n").filter(Boolean).map((raw) => JSON.parse(raw));
    assert.ok(records.some((record) => record.step === "report.followups"), "the 17.2-day-old source remains inside the window");
    assert.ok(records.some((record) => record.entry_id === entryId), "the later harvest marker remains visible beside its source");
    const harvest = mineFollowups(records);
    assert.deepEqual(harvest.candidates, [], "the already-harvested far-lag entry is not re-minted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matching lines own their backing: retained heap stays near returned payload, not decompressed corpus size", () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/lib/ledger-grep.ts")).href;
  const script = `
    import { resolveLedgerUnion } from ${JSON.stringify(moduleUrl)};
    const count = 48;
    const names = Array.from({ length: count }, (_, i) =>
      \`ledger.2026-08-\${String((i % 28) + 1).padStart(2, "0")}T00-\${String(Math.floor(i / 28)).padStart(2, "0")}-00-000Z.ndjson.gz\`);
    const matchBody = "v".repeat(16 * 1024);
    const padding = "z".repeat(2 * 1024 * 1024);
    const deps = {
      readdirSync: () => names,
      existsSync: () => false,
      readFileSync: (path) => Buffer.from(path),
      gunzipSync: (buf) => Buffer.from(
        \`{"step":"report.followups","run_id":"\${buf.toString()}","task_id":"T","ts":"2026-08-01T00:00:00.000Z","entries":[{"type":"task","text":"\${matchBody}"}]}\\n\${padding}\\n\`),
    };
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const result = resolveLedgerUnion("/state", /"step":"report\\.followups"/, deps);
    global.gc();
    const retainedBytes = process.memoryUsage().heapUsed - before;
    const payloadBytes = Buffer.byteLength(result.matches.join("\\n"));
    process.stdout.write(JSON.stringify({ retainedBytes, payloadBytes, ratio: retainedBytes / payloadBytes, matches: result.matches.length }));
  `;
  const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(child.status, 0, `heap probe exits cleanly: ${child.stderr}`);
  const measurement = JSON.parse(child.stdout) as { retainedBytes: number; payloadBytes: number; ratio: number; matches: number };
  assert.equal(measurement.matches, 48, "every rotation contributes one unique returned match");
  assert.ok(measurement.payloadBytes > 750_000, "the payload is large enough to make its ratio stable");
  assert.ok(
    measurement.ratio < 20,
    `retained/payload ratio must be <20 after GC; got ${measurement.ratio.toFixed(1)} (${measurement.retainedBytes}/${measurement.payloadBytes})`,
  );
});

test("resolveLedgerUnion without opts remains an unwindowed, byte-identical union", () => {
  const names = [
    "ledger.2026-01-01T00-00-00-000Z.ndjson.gz",
    "ledger.2026-02-01T00-00-00-000Z.ndjson.gz",
  ];
  const opened: string[] = [];
  const fsDeps: LedgerGrepFsDeps = {
    readdirSync: () => names,
    existsSync: () => false,
    readFileSync: (path) => {
      opened.push(basename(path));
      return Buffer.from(basename(path));
    },
    gunzipSync: (buf) => Buffer.from(`${buf.toString("utf8")}\n`),
  };
  const result = resolveLedgerUnion("/state", /ledger\./, fsDeps);
  assert.deepEqual(opened, names, "omitting opts opens all rotations exactly as before");
  assert.deepEqual(result.matches, names, "omitting opts returns the same line content in the same order");
});
