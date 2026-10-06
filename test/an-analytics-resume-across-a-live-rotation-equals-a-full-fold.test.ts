/**
 * The analytics checkpoint records how far it read the LIVE ledger as a byte offset. Rotation renames
 * nothing in place: it archives the live file's bytes past the carried prefix to a new
 * `ledger.<ts>.ndjson.gz` and swaps in a NEW live file that starts with the retained core. A resume
 * that reused the old offset inside the new file skipped every new row below it, and re-read the
 * whole new archive, whose head the checkpoint had already folded; only the 200-per-step replay
 * window hid that, so a step with more rows than the window was counted twice. A resumed fold must
 * equal a fold of the same ledger from scratch.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import * as analytics from "../src/lib/analytics-route.js";
import * as ledger from "../src/lib/ledger.js";
import { fixedClock } from "../src/lib/clock.js";

const clock = fixedClock(Date.parse("2026-10-06T21:00:00.000Z"));

function rows(verb: string, count: number, minute: number): string {
  let out = "";
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(Date.parse("2026-10-06T00:00:00.000Z") + minute * 60_000 + i * 1000).toISOString();
    out += `${JSON.stringify({ ts, task_id: "CLI", run_id: `CLI-${verb}-${i}`, step: "cli.invoked", verb, tokens: { total: i } })}\n`;
    out += `${JSON.stringify({ ts, task_id: `W1-T${minute}${i}`, run_id: `run-${verb}-${i}`, step: "run.start", lane: "claude", model: "opus" })}\n`;
  }
  return out;
}

function rotate(dir: string, at: string): void {
  const result = ledger.rotateLedger(join(dir, "ledger.ndjson"), { ceilingBytes: 8000, smoothingWindowMs: 0, now: () => new Date(at) });
  assert.equal(result.rotated, true, "positive control: the real rotation ran");
}

async function fromScratch(dir: string): Promise<unknown> {
  return JSON.parse(JSON.stringify((await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock)).snapshot));
}

test("unit test: an analytics resume across a live-ledger rotation folds exactly what a fold from scratch folds", async () => {
  for (const shape of ["one rotation", "two rotations", "rotation with a carried prefix"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-live-rotation-"));
    try {
      const live = join(dir, "ledger.ndjson");
      appendFileSync(live, rows("alpha", 60, 1));
      if (shape === "rotation with a carried prefix") {
        rotate(dir, "2026-10-06T02:00:00.000Z");
        appendFileSync(live, rows("bravo", 260, 130));
      } else {
        appendFileSync(live, rows("bravo", 260, 130));
      }
      const first = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock);
      const prior = JSON.parse(JSON.stringify(first.checkpoint)) as analytics.AnalyticsCheckpoint;
      if (shape === "rotation with a carried prefix") {
        const carried = JSON.parse(readFileSync(`${live}.carried.json`, "utf8")) as { bytes: number };
        assert.ok(carried.bytes > 0, "positive control: the checkpointed live file opens with a carried prefix");
      }
      appendFileSync(live, rows("charlie", 40, 400));
      rotate(dir, "2026-10-06T08:00:00.000Z");
      appendFileSync(live, rows("delta", 250, 500));
      if (shape === "two rotations") {
        rotate(dir, "2026-10-06T10:00:00.000Z");
        appendFileSync(live, rows("echo", 5, 700));
      }
      assert.ok(readdirSync(dir).some((name) => name.endsWith(".ndjson.gz")), "positive control: an archive landed");
      const resumed = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, prior);
      assert.equal(resumed.scan?.mode, "resume", `${shape}: a rotation is reconcilable (refused: ${resumed.scan?.reason})`);
      const want = await fromScratch(dir) as { invocationsByVerb: Record<string, number> };
      assert.equal(want.invocationsByVerb.bravo, 260, `${shape}: positive control: the scratch fold counts each row once`);
      assert.deepEqual(JSON.parse(JSON.stringify(resumed.snapshot)), want, `${shape}: the resumed fold equals the scratch fold`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("unit test: a live-ledger position an analytics resume cannot reconcile is a named full scan, never a guess", async () => {
  const outcome = async (edit: (prior: analytics.AnalyticsCheckpoint) => void, change: (dir: string) => void,
    setup = (dir: string): void => appendFileSync(join(dir, "ledger.ndjson"), rows("alpha", 60, 1))): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-live-unreconciled-"));
    try {
      setup(dir);
      const prior = JSON.parse(JSON.stringify((await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock)).checkpoint)) as analytics.AnalyticsCheckpoint;
      edit(prior);
      change(dir);
      const next = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, prior);
      assert.deepEqual(JSON.parse(JSON.stringify(next.snapshot)), await fromScratch(dir), "whichever way it read, the fold is the scratch fold");
      return next.scan?.mode === "full" ? String(next.scan.reason) : `resumed:${next.scan?.mode}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const anchor = (prior: analytics.AnalyticsCheckpoint): Record<string, unknown> => (prior.source as unknown as { liveAnchor: Record<string, unknown> }).liveAnchor;
  const rotated = (dir: string): void => {
    appendFileSync(join(dir, "ledger.ndjson"), rows("bravo", 10, 300));
    rotate(dir, "2026-10-06T08:00:00.000Z");
    appendFileSync(join(dir, "ledger.ndjson"), rows("charlie", 5, 500));
  };
  const appended = (dir: string): void => appendFileSync(join(dir, "ledger.ndjson"), rows("bravo", 10, 300));
  const replaced = (content: string) => (dir: string): void => {
    writeFileSync(join(dir, "ledger.next"), content);
    renameSync(join(dir, "ledger.next"), join(dir, "ledger.ndjson"));
  };

  assert.equal(await outcome(() => {}, rotated), "resumed:resume", "positive control: an anchored rotation resumes");
  assert.equal(await outcome(() => {}, appended), "resumed:resume", "positive control: the same live file resumes at its offset");
  assert.equal(await outcome((prior) => { anchor(prior).tailSha256 = "0".repeat(64); }, rotated), "live-rotation-unreconciled");
  assert.equal(await outcome((prior) => { delete (prior.source as { liveAnchor?: unknown }).liveAnchor; }, rotated), "live-position-unanchored",
    "a checkpoint written before the anchor existed cannot place its offset after a rotation");
  assert.equal(await outcome((prior) => { delete (prior.source as { liveAnchor?: unknown }).liveAnchor; }, appended), "resumed:resume",
    "and still resumes a live file that only grew");
  assert.equal(await outcome(() => {}, replaced(`${rows("delta", 70, 600)}`)), "live-replaced-without-rotation");
  // An empty-delta rotation: the live file held only its carried prefix, every row of it already archived.
  const core = rows("alpha", 60, 1);
  const onlyCore = (dir: string): void => {
    writeFileSync(join(dir, "ledger.2026-10-06T02-00-00-000Z.ndjson.gz"), gzipSync(core));
    writeFileSync(join(dir, "ledger.ndjson"), core);
    writeFileSync(join(dir, "ledger.ndjson.carried.json"), JSON.stringify({
      bytes: Buffer.byteLength(core), sha256: createHash("sha256").update(core).digest("hex") }));
  };
  assert.equal(await outcome((prior) => {
    assert.equal(anchor(prior).prefixBytes, prior.source.liveOffset, "positive control: the fold stopped at the end of the prefix");
  }, replaced(core + rows("echo", 70, 700)), onlyCore), "resumed:resume", "a fold that read only the carried prefix lost nothing to it");
});
