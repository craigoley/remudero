/**
 * The ledger compaction rung MOVES already-folded rotations to `ledger-superseded/` and writes their
 * rows to one archive named no later than its newest source. The analytics checkpoint refused to
 * resume whenever a prior rotation was gone, so after each compaction every refresh rescanned the
 * whole corpus: 58 s on this Mac's 4.0M-row corpus against 1.8 s for the resume, and past the
 * 120 s bound on the fleet host's larger one. A resume across a compaction must fold the new rows
 * once and nothing else; every vanished archive it cannot explain must still force the full scan.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import * as analytics from "../src/lib/analytics-route.js";
import { ledgerCompactCommand } from "../src/lib/ledger-compact.js";
import { fixedClock } from "../src/lib/clock.js";

const clock = fixedClock(Date.parse("2026-10-06T21:00:00.000Z"));
const OLD = ["ledger.2026-09-20T10-00-00-000Z.ndjson.gz", "ledger.2026-09-20T11-00-00-000Z.ndjson.gz", "ledger.2026-09-20T12-00-00-000Z.ndjson.gz"];

function invoked(verb: string, ts: string): string {
  return JSON.stringify({ ts, task_id: "CLI", run_id: `CLI-${verb}`, step: "cli.invoked", verb });
}

function corpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-compacted-"));
  ["alpha", "bravo", "charlie"].forEach((verb, index) => {
    writeFileSync(join(dir, OLD[index]!), gzipSync(`${invoked(verb, `2026-09-20T${10 + index - 1}:30:00.000Z`)}\n`));
  });
  writeFileSync(join(dir, "ledger.ndjson"), `${invoked("delta", "2026-10-06T20:00:00.000Z")}\n`);
  return dir;
}

test("unit test: an analytics checkpoint resumes across a ledger compaction instead of rescanning the corpus", async () => {
  const dir = corpus();
  const first = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock);
  const prior = JSON.parse(JSON.stringify(first.checkpoint)) as analytics.AnalyticsCheckpoint;

  // The real compactor, as the daemon rung runs it: the three rotations become one archive.
  const out: string[] = [];
  assert.equal(ledgerCompactCommand(["--older-than", "7"], { stateDir: dir, clock, out: (line) => void out.push(line), error: () => {} }), 0);
  const archives = readdirSync(dir).filter((name) => name.endsWith(".ndjson.gz"));
  assert.equal(archives.length, 1, `positive control: the compaction ran (${out.join(" ")})`);
  assert.ok(archives[0]! <= OLD[2]!, `its output ${archives[0]} sorts no later than the newest source`);
  assert.deepEqual(readdirSync(join(dir, "ledger-superseded")).sort(), OLD, "and every source moved to the cold store");

  // New work after the checkpoint: one appended live row and one rotation.
  appendFileSync(join(dir, "ledger.ndjson"), `${invoked("echo", "2026-10-06T20:10:00.000Z")}\n`);
  writeFileSync(join(dir, "ledger.2026-10-06T20-20-00-000Z.ndjson.gz"), gzipSync(`${invoked("foxtrot", "2026-10-06T20:15:00.000Z")}\n`));

  const resumed = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, prior);
  assert.equal(resumed.scan?.mode, "resume", `a compaction is not a reason to rescan (refused: ${resumed.scan?.reason})`);
  assert.equal(resumed.scan?.rotationsRead, 1, "only the rotation written after the checkpoint is read");
  assert.equal(resumed.snapshot.invocationsByVerb.foxtrot, 1);
  assert.equal(resumed.snapshot.invocationsByVerb.alpha, 1, "the compacted rows are not folded a second time");
  assert.equal(resumed.snapshot.invocationsByVerb.bravo, 1);
  assert.equal(resumed.snapshot.invocationsByVerb.charlie, 1);
});

test("unit test: an analytics checkpoint refuses to resume when a vanished archive is unexplained or a compaction took unread rows", async () => {
  const refusal = async (name: string, mutate: (dir: string) => void, edit?: (checkpoint: analytics.AnalyticsCheckpoint) => void): Promise<string | undefined> => {
    const dir = corpus();
    const first = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock);
    const prior = JSON.parse(JSON.stringify(first.checkpoint)) as analytics.AnalyticsCheckpoint;
    edit?.(prior);
    mutate(dir);
    const next = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, prior);
    return next.scan?.mode === "full" ? next.scan.reason : `resumed:${next.scan?.mode}`;
  };
  const cold = (dir: string): string => { mkdirSync(join(dir, "ledger-superseded"), { recursive: true }); return join(dir, "ledger-superseded"); };

  assert.equal(await refusal("noop", () => {}), "resumed:resume", "positive control: an untouched source resumes");
  assert.equal(await refusal("deleted", (dir) => rmSync(join(dir, OLD[0]!))), "archive-missing",
    "a vanished rotation the cold store does not hold is unexplained");
  assert.equal(await refusal("superseded", (dir) => renameSync(join(dir, OLD[0]!), join(cold(dir), OLD[0]!))), "resumed:resume");
  assert.equal(await refusal("unread", (dir) => {
    renameSync(join(dir, OLD[0]!), join(cold(dir), OLD[0]!));
    writeFileSync(join(cold(dir), "ledger.2026-10-06T20-30-00-000Z.ndjson.gz"), gzipSync("{}\n"));
  }), "compaction-consumed-unread");
  assert.equal(await refusal("rewritten", (dir) => writeFileSync(join(dir, OLD[1]!), gzipSync(`${invoked("zulu", "2026-09-20T10:45:00.000Z")}\n`))), "archive-rewritten");
  assert.equal(await refusal("truncated", (dir) => writeFileSync(join(dir, "ledger.ndjson"), "")), "live-truncated");
  assert.equal(await refusal("live-gone", (dir) => rmSync(join(dir, "ledger.ndjson"))), "live-missing");
  assert.equal(await refusal("version", () => {}, (checkpoint) => { delete checkpoint.state.goalAccountingVersion; }), "checkpoint-version");
  assert.equal(await refusal("incomplete", () => {}, (checkpoint) => { delete checkpoint.state.workIntegrityRows; }), "checkpoint-incomplete");
  assert.equal(await refusal("corrupt", () => {}, (checkpoint) => { (checkpoint.state as { startsByRun: unknown }).startsByRun = 7; }), "checkpoint-corrupt");
  assert.equal(await refusal("live-malformed", (dir) => {
    writeFileSync(join(dir, "ledger.2026-10-06T20-40-00-000Z.ndjson.gz"), gzipSync(`${invoked("golf", "2026-10-06T20:35:00.000Z")}\n`));
  }, (checkpoint) => {
    checkpoint.state.routingTelemetry.malformedSources = [["ledger.ndjson", { form: "live", count: 1, firstRowOrdinal: 1, lastRowOrdinal: 1 }]];
  }), "live-malformed-rotated");

  const missing = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(join(tmpdir(), "rmd-analytics-refusal-absent-dir"), clock, undefined,
    (await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(corpus(), clock)).checkpoint);
  assert.equal(missing.scan?.reason, "source-unreadable");
  const none = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(corpus(), clock);
  assert.equal(none.scan?.reason, "no-checkpoint");
});
