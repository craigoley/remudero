import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  architectLaneShare,
  assertArchitectAboveWorker,
  buildGather,
  renderArchitectLaneShare,
  renderGather,
  UNATTRIBUTED_MODEL,
  type LedgerRecord,
} from "../src/lib/retro.js";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** A minimal but complete ledger corpus over the six named lanes (four Architect
 *  authoring lanes + the two comparison lanes), deliberately spanning a wide `ts`
 *  window and deliberately leaving one row of each kind with NO `model` key —
 *  the shape W1-T2239's rationale found for real (451 of 613 `verdict` rows). */
function fixtureLedger(): string {
  const lines = [
    // Architect lanes.
    { run_id: "RETRO-1", task_id: "RETRO", step: "retro.synthesized", ts: "2026-07-14T11:14:29.696Z", cost_usd: 5.12, model: "opus" },
    { run_id: "RETRO-2", task_id: "RETRO", step: "retro.synthesized", ts: "2026-08-12T12:47:53.000Z", cost_usd: 6.5, model: "claude-opus-5" },
    { run_id: "TRIAGE-1", task_id: "TRIAGE-1", step: "triage.synthesized", ts: "2026-08-14T15:04:16.143Z", cost_usd: 3.0, model: "claude-opus-5" },
    { run_id: "TRIAGE-2", task_id: "TRIAGE-2", step: "triage.synthesized", ts: "2026-08-01T00:00:00.000Z", cost_usd: 2.0 }, // no model
    { run_id: "PLAN-1", task_id: "PLAN-full", step: "plan.synthesized", ts: "2026-08-02T00:00:00.000Z", cost_usd: 1.0, model: "opus" },
    { run_id: "INBOX-1", task_id: "INBOX", step: "inbox.draft_synthesized", ts: "2026-08-03T00:00:00.000Z", cost_usd: 0.5, model: "opus" },
    // Comparison lanes.
    { run_id: "W1-T1", task_id: "W1-T1", step: "run.start", ts: "2026-07-01T00:00:00.000Z", type: "implement" },
    { run_id: "W1-T1", task_id: "W1-T1", step: "verdict", ts: "2026-07-01T01:00:00.000Z", verdict: "merged", cost_usd: 10.0, model: "sonnet" },
    { run_id: "W1-T2", task_id: "W1-T2", step: "run.start", ts: "2026-07-02T00:00:00.000Z", type: "implement" },
    { run_id: "W1-T2", task_id: "W1-T2", step: "verdict", ts: "2026-08-13T00:30:48.000Z", verdict: "merged", cost_usd: 20.0 }, // no model
    { run_id: "REV-1", task_id: "W1-T1", step: "review.reviewer", ts: "2026-08-12T23:47:20.000Z", total_cost_usd: 4.0, model: "sonnet" },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

// ── (1) the retro gather reports the architect-lane share of spend beside the
//     per-class routing data it already collects ───────────────────────────

test("buildGather wires architectLaneShare into RetroGather, and renderGather prints it beside the per-class table", () => {
  const gather = buildGather({ ledgerNdjson: fixtureLedger(), learningsMd: "" });
  assert.ok(gather.architectLaneShare, "RetroGather must carry an architectLaneShare field");
  assert.equal(gather.architectLaneShare.architectRows, 6, "4 architect-lane rows across retro/triage/plan/inbox_draft");

  const rendered = renderGather(gather);
  const classIdx = rendered.indexOf("## Calibration (BY TASK CLASS");
  const shareIdx = rendered.indexOf("## G-17 Architect-lane share of spend");
  assert.ok(classIdx >= 0, "the per-class calibration section must still render");
  assert.ok(shareIdx >= 0, "the architect-lane share section must render");
  assert.ok(shareIdx > classIdx, "the share section must be printed AFTER (beside) the per-class table, not detached from it");
  // Nothing else (byType, replay, etc.) is printed between them.
  const between = rendered.slice(classIdx, shareIdx);
  assert.equal((between.match(/^## /gm) ?? []).length, 1, "only the per-class heading itself sits between it and the share section");
});

// ── (2) the report names the window it covers and the newest row it saw ────

test("architectLaneShare names the oldest/newest ts across all six lanes, and the render states the newest row explicitly", () => {
  const records = fixtureLedger()
    .split("\n")
    .map((l) => JSON.parse(l) as LedgerRecord);
  const report = architectLaneShare(records);
  // The W1-T1 `run.start` line (ts 2026-07-01T00:00:00.000Z) does NOT count — its step is
  // not one of the six lanes; the oldest LANE row is that same run's `verdict` line, an hour later.
  assert.equal(report.windowStartTs, "2026-07-01T01:00:00.000Z", "oldest ts across the six lanes (verdict, W1-T1)");
  assert.equal(report.windowEndTs, "2026-08-14T15:04:16.143Z", "newest ts across all lanes (triage.synthesized TRIAGE-1)");

  const rendered = renderArchitectLaneShare(report);
  assert.match(rendered, /Window covered: 2026-07-01T01:00:00\.000Z → 2026-08-14T15:04:16\.143Z/);
  assert.match(rendered, /newest row seen: 2026-08-14T15:04:16\.143Z/);

  // A corpus with zero rows in every lane must never print a window as if it had one.
  const empty = architectLaneShare([]);
  assert.equal(empty.windowStartTs, undefined);
  assert.equal(empty.windowEndTs, undefined);
  assert.match(renderArchitectLaneShare(empty), /no window, no share to trust/);
});

// ── (3) a lane whose rows carry no model key is reported as unattributed
//     rather than folded into a model total ─────────────────────────────────

test("a row with no model key reports as unattributed, never folded into a real model's count", () => {
  const records = fixtureLedger()
    .split("\n")
    .map((l) => JSON.parse(l) as LedgerRecord);
  const report = architectLaneShare(records);

  const triage = report.architectLanes.find((l) => l.lane === "triage")!;
  assert.deepEqual(
    triage.models.sort((a, b) => (a.model < b.model ? -1 : 1)),
    [
      { model: "claude-opus-5", rows: 1 },
      { model: UNATTRIBUTED_MODEL, rows: 1 },
    ].sort((a, b) => (a.model < b.model ? -1 : 1)),
    "the model-less triage.synthesized row must land under UNATTRIBUTED_MODEL, not vanish or join claude-opus-5's count",
  );

  const implement = report.comparisonLanes.find((l) => l.lane === "implement")!;
  const unattributedRow = implement.models.find((m) => m.model === UNATTRIBUTED_MODEL);
  assert.ok(unattributedRow, "the model-less verdict row must be visible as its own unattributed bucket");
  assert.equal(unattributedRow!.rows, 1);
  const sonnetRow = implement.models.find((m) => m.model === "sonnet");
  assert.equal(sonnetRow!.rows, 1, "the model-less row must not have been counted into sonnet's total");

  assert.match(renderArchitectLaneShare(report), /unattributed/);
});

// ── (4) notional cost is labelled as api-equivalent rather than presented as
//     billed spend ─────────────────────────────────────────────────────────

test("the rendered report labels every cost figure notional/api-equivalent, never billed spend", () => {
  const records = fixtureLedger()
    .split("\n")
    .map((l) => JSON.parse(l) as LedgerRecord);
  const rendered = renderArchitectLaneShare(architectLaneShare(records));
  assert.match(rendered, /NOTIONAL/i);
  assert.match(rendered, /api-equivalent/i);
  assert.match(rendered, /never billed spend/i, "the report must explicitly disclaim billed spend, not just omit the word");
});

// ── (5) the tier invariant still throws on a same-or-lower-tier architect
//     exactly as it does today ─────────────────────────────────────────────

test("assertArchitectAboveWorker is untouched by this shard: same-or-lower tier still throws, a higher tier still passes", () => {
  assert.throws(() => assertArchitectAboveWorker("sonnet", "sonnet"), /G-17 Tier Invariant/);
  assert.throws(() => assertArchitectAboveWorker("haiku", "sonnet"), /G-17 Tier Invariant/);
  assert.doesNotThrow(() => assertArchitectAboveWorker("opus", "sonnet"));
  assert.doesNotThrow(() => assertArchitectAboveWorker("claude-opus-5", "sonnet"));
});

// ── (6) no mount row and no configured model is altered by this change ─────

test("architectLaneShare touches no mount row or configured model: .remudero/mounts.yaml is read unchanged, and the function takes no config/mounts input", () => {
  // architectLaneShare's own signature is (records) only — it cannot read or
  // write a mount row or a config model because it is never handed either.
  assert.equal(architectLaneShare.length, 1, "architectLaneShare must take ONLY the ledger records, no mounts/config parameter");

  const before = readFileSync(mountsPath(repoRoot), "utf8");
  const mountsBefore = loadMounts(mountsPath(repoRoot));
  assert.equal(mountsBefore.architect.model, "claude-opus-5", "the committed architect mount row, unchanged by this shard");

  // Exercise the new code path (buildGather -> architectLaneShare -> render) and
  // confirm the on-disk mount table is byte-for-byte the same afterward.
  const gather = buildGather({ ledgerNdjson: fixtureLedger(), learningsMd: "", mounts: mountsBefore, now: Date.parse("2026-08-14T00:00:00.000Z") });
  renderGather(gather);

  const after = readFileSync(mountsPath(repoRoot), "utf8");
  assert.equal(after, before, ".remudero/mounts.yaml must be byte-identical after running this shard's new code");
  const mountsAfter = loadMounts(mountsPath(repoRoot));
  assert.deepEqual(mountsAfter.architect, mountsBefore.architect, "the architect row must be unchanged in-memory too");
});
