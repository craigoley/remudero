import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchesWithoutNewOwnedPr, readLedgerUnionBounded } from "../src/lib/status.js";
import { deriveCircuitBrokenBlockers } from "../src/lib/status-board.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// MEASURED 2026-09-29: `rmd release` reset seven halted tasks and the live dispatcher counted each at
// 0, yet `rmd status` still listed six of them circuit-broken at 26-113 dispatches. The board reads
// readLedgerUnionBounded, which returns the live file FIRST and rotations after it, so walking that
// array in order met the live reset, then counted every archived dispatch that followed it.

const TASK = "W1-T9001";
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const rotationName = (msAgo: number): string => `ledger.${iso(msAgo).replace(/[:.]/g, "-")}.ndjson`;

function unionWithArchivedStreak(): { dir: string; lines: Array<Record<string, unknown>> } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}streak-order-`));
  // Each run has an outcome row, as a real run does; a lone run.start is an orphan and never counted.
  const archived = Array.from({ length: 6 }, (_, i) => [
    JSON.stringify({ ts: iso(3 * 3_600_000 - i * 60_000), task_id: TASK, run_id: `${TASK}-${i}`, step: "run.start" }),
    JSON.stringify({ ts: iso(3 * 3_600_000 - i * 60_000 - 30_000), task_id: TASK, run_id: `${TASK}-${i}`, step: "implement.done" }),
  ]).flat();
  writeFileSync(join(dir, rotationName(2 * 3_600_000)), archived.join("\n") + "\n");
  const live = [JSON.stringify({ ts: iso(60_000), task_id: TASK, run_id: `RELEASE-${TASK}`, step: "dispatch.breaker_released" })];
  writeFileSync(join(dir, "ledger.ndjson"), live.join("\n") + "\n");
  return { dir, lines: readLedgerUnionBounded(join(dir, "ledger.ndjson")) };
}

test("a reset in the live file ends the streak its archived dispatches began", (t) => {
  const { dir, lines } = unionWithArchivedStreak();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(lines.filter((l) => l.task_id === TASK).length, 13, "the union must carry both halves or this proves nothing");
  assert.equal(dispatchesWithoutNewOwnedPr(lines, TASK), 0);
});

test("the status board does not list a released task as circuit-broken", (t) => {
  const { dir, lines } = unionWithArchivedStreak();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(deriveCircuitBrokenBlockers(lines, undefined, undefined).map((b) => b.taskId), []);
});

test("dispatches after the reset still count, whatever order the union returns them in", () => {
  const run = (id: string, hour: number) => [
    { ts: `2026-09-29T${hour}:00:00.000Z`, task_id: TASK, run_id: id, step: "run.start" },
    { ts: `2026-09-29T${hour}:30:00.000Z`, task_id: TASK, run_id: id, step: "implement.done" },
  ];
  const release = { ts: "2026-09-29T12:00:00.000Z", task_id: TASK, run_id: "R", step: "dispatch.breaker_released" };
  const [a, b, c] = [run("a", 10), run("b", 13), run("c", 14)];
  assert.equal(dispatchesWithoutNewOwnedPr([...a!, release, ...b!, ...c!], TASK), 2);
  assert.equal(dispatchesWithoutNewOwnedPr([...b!, ...c!, release, ...a!], TASK), 2);
});
