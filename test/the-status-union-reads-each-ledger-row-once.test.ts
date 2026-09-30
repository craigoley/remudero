import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchesWithoutNewOwnedPr, orphanedRunIds, readLedgerUnionBounded } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// MEASURED 2026-09-29: rotateLedger keeps each step's newest rows in the live file, so every later
// rotation archives them again. The board's union read did not dedupe, and returned 1,042,796 rows of
// which 676,741 were distinct; W1-T2982's 32 real dispatches read as 1,584.

const TASK = "W1-T9002";
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const rotationName = (msAgo: number): string => `ledger.${iso(msAgo).replace(/[:.]/g, "-")}.ndjson`;

test("a dispatch every rotation re-archived counts once", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}union-once-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Two runs, each with an outcome row so neither reads as an orphan, retained across three rotations.
  const rows = ["a", "b"].flatMap((id, i) => [
    JSON.stringify({ ts: iso(5 * 3_600_000 - i * 60_000), task_id: TASK, run_id: id, step: "run.start" }),
    JSON.stringify({ ts: iso(5 * 3_600_000 - i * 60_000 - 1_000), task_id: TASK, run_id: id, step: "implement.done" }),
  ]);
  for (const hoursAgo of [4, 3, 2]) writeFileSync(join(dir, rotationName(hoursAgo * 3_600_000)), rows.join("\n") + "\n");
  writeFileSync(join(dir, "ledger.ndjson"), rows.join("\n") + "\n");
  const lines = readLedgerUnionBounded(join(dir, "ledger.ndjson"));
  // W1-T4820: the union itself now returns each row once, so the replays are rebuilt here to keep the
  // streak's own guard (#7920) under test.
  assert.equal(lines.filter((l) => l.task_id === TASK && l.step === "run.start").length, 2);
  const replayed = [...lines, ...lines, ...lines, ...lines];
  assert.equal(replayed.filter((l) => l.task_id === TASK && l.step === "run.start").length, 8, "the replays must be present or this proves nothing");
  assert.equal(dispatchesWithoutNewOwnedPr(replayed, TASK), 2);
});

test("a lone run.start replayed across rotations is still an orphan", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}union-orphan-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const start = JSON.stringify({ ts: iso(5 * 3_600_000), task_id: TASK, run_id: "dead", step: "run.start" });
  for (const hoursAgo of [4, 3, 2]) writeFileSync(join(dir, rotationName(hoursAgo * 3_600_000)), start + "\n");
  writeFileSync(join(dir, "ledger.ndjson"), [start, JSON.stringify({ ts: iso(60_000), task_id: "OTHER", step: "daemon.tick" })].join("\n") + "\n");
  const lines = readLedgerUnionBounded(join(dir, "ledger.ndjson"));
  assert.ok(orphanedRunIds(lines, TASK).has("dead"));
  assert.equal(dispatchesWithoutNewOwnedPr(lines, TASK), 0);
});
