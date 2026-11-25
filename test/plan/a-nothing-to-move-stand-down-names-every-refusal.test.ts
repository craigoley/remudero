/**
 * W1-T14870 — a stand-down with nothing to move names every record selection refused and why. 2026-11-25 18:45Z: the
 * core daemon's row was {"reason":"nothing_to_move"} alone, while four record groups with no visible blocker stayed on
 * core; no row said why.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlanTaskMover, PLAN_MOVE_STAND_DOWN, runPlanTaskMoveTick, type MovePin, type PlanTaskMoveSwitch } from "#src/lib/plan-task-move-janitor.js";
import { moveWorld, record } from "#test/helpers/plan-move-world.js";

type Json = Record<string, unknown>;
const ON: PlanTaskMoveSwitch = { move: { outcome: "on", repository: "fixture/ops", checkoutDir: "" }, dispatch: { outcome: "on", repository: "fixture/ops", checkoutDir: "" } };
const pin: MovePin = { ops: { repository: "fixture/ops", checkoutDir: "/nonexistent" }, publicRepository: "fixture/remudero", publicCommit: "a".repeat(40), opsCommit: "b".repeat(40), key: "k" };

test("W1-T14870 criterion 1: the mover's none answer lists every refused record and its reason", async t => {
  // W1-T2 has no reservation, so it cannot move, and W1-T1, which it names, stays with it.
  const w = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T2": record("W1-T2", "  depends_on: [W1-T1]\n") });
  w.pub.origin.git("update-ref", "-d", "refs/rmd-id/W1-T2");
  const run = await w.run(false);
  assert.equal(run.out.step, "none", run.lines.join("\n"));
  assert.equal(run.out.refused, 2, "positive control: the count origin/main reports");
  assert.deepEqual([...(run.out.refusals as Array<{ id: string; reason: string }>)].sort((a, b) => a.id.localeCompare(b.id)),
    [{ id: "W1-T1", reason: "public_dependants" }, { id: "W1-T2", reason: "reservation_absent" }], "THE CLAIM: each refusal is named");
});

test("W1-T14870 criterion 2: the nothing_to_move row carries the refusals, and a changed list writes a new row", async () => {
  let refusals: Json[] = [{ id: "W1-T1", reason: "public_dependants" }];
  const mover = createPlanTaskMover({ readSwitch: () => ON, readOpsCatalog: () => "ok", readHeads: async () => pin,
    move: async () => ({ status: 0, out: { step: "none", refused: refusals.length, refusals } }), readPull: async () => ({ state: "OPEN" }), onMain: async () => true });
  const rows: Array<{ step: string; data: Json }> = [];
  const tick = () => { mover.memory.answer = undefined; return runPlanTaskMoveTick({ opsDispatchHold: undefined, log: (step, data) => { rows.push({ step, data }); } }, mover); };
  assert.deepEqual(await tick(), { outcome: "stand_down", reason: "nothing_to_move" });
  await tick();
  const standDowns = () => rows.filter(row => row.step === PLAN_MOVE_STAND_DOWN);
  assert.equal(standDowns().length, 1, "an unchanged list writes no second row");
  assert.deepEqual(standDowns()[0]!.data.refusals, refusals, "THE CLAIM: the row names each refused record and why");
  refusals = [];
  await tick();
  assert.equal(standDowns().length, 2, "a changed list writes a new row");
  assert.deepEqual(standDowns()[1]!.data.refusals, []);
});

test("W1-T14870 criterion 2: a refusal that only records history is counted, not listed, so the row stays small", async () => {
  // Review of #20939: listing all ~5,400 refusals on the real plan made one row about 225 KB.
  const history: Json[] = Array.from({ length: 5_000 }, (_, i) => ({ id: `W1-T${100_000 + i}`, reason: i % 2 === 0 ? "merged" : "retired" }));
  const open: Json[] = [{ id: "W1-T7", reason: "owned" }, { id: "W1-T8", reason: "reservation_absent" }];
  const mover = createPlanTaskMover({ readSwitch: () => ON, readOpsCatalog: () => "ok", readHeads: async () => pin,
    move: async () => ({ status: 0, out: { step: "none", refused: history.length + open.length, refusals: [...history, ...open] } }), readPull: async () => ({ state: "OPEN" }), onMain: async () => true });
  const rows: Array<{ step: string; data: Json }> = [];
  await runPlanTaskMoveTick({ opsDispatchHold: undefined, log: (step, data) => { rows.push({ step, data }); } }, mover);
  const row = rows.find(r => r.step === PLAN_MOVE_STAND_DOWN)!.data;
  assert.deepEqual(row.refusals, open, "THE CLAIM: each refusal that is not history is named with its reason");
  assert.deepEqual(row.refused_by_reason, { merged: 2_500, owned: 1, reservation_absent: 1, retired: 2_500 }, "every refusal is counted by reason");
  assert.ok(JSON.stringify(row).length < 4_096, `the row stays small: ${JSON.stringify(row).length} bytes`);
});
