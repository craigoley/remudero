/**
 * W1-T13680 criteria 4 and 9: an id both catalogs hold, whose ops copy carries moved_from, is a pending move. The
 * composed plan the daemon dispatches from holds it in neither catalog, so neither copy can be built, while every
 * other ops task stays dispatchable. An id both hold without a valid moved_from is still a duplicate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runnableCandidates } from "#src/lib/drain.js";
import { parseTasksFromYaml, type Plan } from "#src/lib/plan.js";
import { composeSecondaryPlan } from "#src/lib/task-lookup.js";
import { moveWorld, record as moverRecord, shard, type MoveWorld } from "#test/helpers/plan-move-world.js";

const SOURCE = "b".repeat(40);
const record = (id: string, extra = "") =>
  `- id: ${id}\n${extra}  title: pending move fixture ${id}\n  repo: remudero\n  type: implement\n  priority: 1\n  depends_on: []\n`;
const plan = (texts: string[], label: string): Plan => {
  const tasks = texts.flatMap((text, i) => parseTasksFromYaml(text, `${label}/${i}.yaml`));
  return { tasks, byId: new Map(tasks.map(task => [task.id, task])) };
};
const PUBLIC = plan([record("W1-T1"), record("W1-T2")], "public");
const moved = (line: string) => plan([record("W1-T1", line), record("W1-T3")], "ops");

test("W1-T13680 criterion 4: composeSecondaryPlan names a moved_from id both catalogs hold as a pending move and composes the rest", () => {
  const composition = composeSecondaryPlan(PUBLIC, moved(`  moved_from: remudero@${SOURCE}\n`));
  assert.equal(composition.outcome, "ok", JSON.stringify(composition));
  if (composition.outcome !== "ok") return;
  assert.deepEqual(composition.plan.tasks.map(task => task.id), ["W1-T2", "W1-T3"]);
  assert.deepEqual([...composition.plan.byId.keys()].sort(), ["W1-T2", "W1-T3"]);
  assert.deepEqual([...composition.secondaryIds], ["W1-T3"]);
  assert.deepEqual([...composition.pendingMoveIds], ["W1-T1"]);
  // Every other ops task stays dispatchable: the daemon's own selector reads this composed plan.
  const frontier = runnableCandidates(composition.plan, () => false, 10).map(task => task.id).sort();
  assert.deepEqual(frontier, ["W1-T2", "W1-T3"]);

  // Without a moved_from line, or with one that names no public commit, a shared id is still a duplicate: since
  // W1-T13749 the duplicate holds both of its copies, never the rest of the catalog.
  for (const line of ["", "  moved_from: remudero@abc\n", `  moved_from: elsewhere@${SOURCE}\n`]) {
    const refused = composeSecondaryPlan(PUBLIC, moved(line));
    assert.equal(refused.outcome, "ok", `moved_from line ${JSON.stringify(line)}`);
    if (refused.outcome !== "ok") continue;
    assert.deepEqual(Object.fromEntries(refused.held), { "W1-T1": { reason: "duplicate_task_id", task: "W1-T1" } }, `moved_from line ${JSON.stringify(line)}`);
    assert.deepEqual(refused.plan.tasks.map(task => task.id), ["W1-T2", "W1-T3"], "neither copy of the duplicate composes");
    assert.deepEqual([...refused.secondaryIds], ["W1-T3"]);
    assert.deepEqual([...refused.pendingMoveIds], []);
  }
  // An ops task whose dependency neither catalog holds is still held, pending move or not.
  const orphan = plan([record("W1-T1", `  moved_from: remudero@${SOURCE}\n`), record("W1-T4").replace("depends_on: []", "depends_on: [W1-T9]")], "ops");
  const orphaned = composeSecondaryPlan(PUBLIC, orphan);
  assert.equal(orphaned.outcome, "ok");
  if (orphaned.outcome === "ok") {
    assert.deepEqual(Object.fromEntries(orphaned.held), { "W1-T4": { reason: "invalid_cross_catalog_dependency", task: "W1-T4", dependsOn: "W1-T9" } });
    assert.deepEqual([...orphaned.pendingMoveIds], ["W1-T1"]);
    assert.equal(orphaned.plan.byId.has("W1-T4"), false);
  }
  // A plan with no shared id composes as before, with an empty pending set.
  const plain = composeSecondaryPlan(PUBLIC, plan([record("W1-T3")], "ops"));
  assert.equal(plain.outcome, "ok");
  if (plain.outcome === "ok") assert.deepEqual([...plain.pendingMoveIds], []);
});

test("W1-T13680 criterion 9: during the transient neither copy is a dispatch candidate, and a claim, run branch or open pull request on the id rolls the ops copy back", async t => {
  const id = "W1-T1";
  const w = moveWorld(t, { [id]: moverRecord(id), "W1-T2": moverRecord("W1-T2") }, { "W1-T3": moverRecord("W1-T3") });
  w.pub.origin.git("update-ref", "refs/rmd-dispatch/W1-T2", w.main("public")); // keep the candidate fixed to W1-T1
  assert.equal((await w.run()).out.step, "copy");
  w.merge(w.pulls[0]!);
  // Both mains hold the id: the plans the daemon composes from those exact commits dispatch it from neither.
  const at = (side: "public" | "ops") => plan(["W1-T1", "W1-T2", "W1-T3"].flatMap(task => w.bytes(side, shard(task)) ?? []), side);
  const composition = composeSecondaryPlan(at("public"), at("ops"));
  assert.equal(composition.outcome, "ok", JSON.stringify(composition));
  if (composition.outcome !== "ok") return;
  assert.deepEqual([...composition.pendingMoveIds], [id]);
  const frontier = runnableCandidates(composition.plan, () => false, 10).map(task => task.id);
  assert.ok(!frontier.includes(id), `a pending move is a candidate in neither catalog: ${frontier.join(",")}`);
  assert.ok(frontier.includes("W1-T3"), "every other ops task stays dispatchable");

  // A claim on the public copy stops the public removal and rolls the ops copy back, so only one copy is buildable.
  for (const [reason, own] of [
    ["claimed", (x: MoveWorld) => x.pub.origin.git("update-ref", `refs/rmd-dispatch/${id}`, x.main("public"))],
    ["run_branch", (x: MoveWorld) => x.pub.origin.git("update-ref", `refs/heads/run-${id}-1795000000001`, x.main("public"))],
    ["open_pull_request", (x: MoveWorld) => { x.openPull("public", { head: `run-${id}-1795000000002` }); }],
  ] as const) {
    const x = moveWorld(t, { [id]: moverRecord(id) });
    await x.run(); x.merge(x.pulls[0]!);
    own(x);
    const run = await x.run();
    assert.equal(run.out.step, "rollback", `${reason}: ${run.lines.join("\n")}`);
    assert.equal(run.out.reason, reason);
    assert.equal(x.pulls.filter(pr => pr.repository === "public" && pr.head.startsWith("plan-move-")).length, 0, "no public removal opens");
    x.merge(x.pulls.at(-1)!);
    assert.ok(x.holds("public", id) && !x.holds("ops", id), `${reason}: only the public copy remains`);
  }
});
