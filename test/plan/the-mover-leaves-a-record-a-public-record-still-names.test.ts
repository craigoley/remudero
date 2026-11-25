/**
 * W1-T14773 — the mover never removes a public record that another public record still names through depends_on or
 * superseded_by. 2026-11-24: W1-T13178 was copied to ops while core's retired W1-T2874 named it as superseded_by; the
 * public removal then failed core's plan read (`superseded_by unknown task`) at every pass and held 26 records.
 * Each run drives movePlanTask over two real Git origins (test/helpers/plan-move-world.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { moveWorld, record, shard, type MoveWorld } from "#test/helpers/plan-move-world.js";
import { publicReferences } from "#src/lib/plan-task-migration.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";

const RETIRED_NAMING = (id: string, named: string) => record(id, `  retirement: closed\n  superseded_by: ${named}\n`).replace("status: queued", "status: blocked");
const lastPull = (w: MoveWorld) => w.pulls.at(-1)!;
const changeOf = (w: MoveWorld) => {
  const pr = lastPull(w);
  return `${pr.repository} ${w.sides[pr.repository].origin.git("diff", "--name-status", `main...${pr.head}`)}`.split("\n").sort().join("\n");
};

test("W1-T14773 criterion 1: a record a public record names as superseded_by stays public, and the rest of the batch moves", async t => {
  const w = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T2": RETIRED_NAMING("W1-T2", "W1-T1"), "W1-T3": record("W1-T3") });
  const copy = await w.run();
  assert.equal(copy.out.step, "copy", copy.lines.join("\n"));
  assert.equal(changeOf(w), `ops A\t${shard("W1-T3")}`, "THE CLAIM: only the unnamed record is copied");

  const tasks = parseTasksFromYaml(RETIRED_NAMING("W1-T2", "W1-T1") + record("W1-T4", "  depends_on: [W1-T5]\n"), "fixture");
  assert.deepEqual([...publicReferences(tasks)].sort(), ["W1-T1", "W1-T5"], "depends_on and superseded_by both count");
});

test("W1-T14773 criterion 2: a copied record a public record still names is rolled back, and the other copies are removed", async t => {
  // The stuck state: both records were copied before the naming record existed on public main.
  const w = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T3": record("W1-T3") });
  assert.equal((await w.run()).out.step, "copy");
  w.merge(lastPull(w));
  w.commitTo("public", { [shard("W1-T2")]: RETIRED_NAMING("W1-T2", "W1-T1") }, "a retired record names W1-T1");
  assert.ok(w.holds("public", "W1-T1") && w.holds("ops", "W1-T1") && w.holds("ops", "W1-T3"), "positive control: both copies landed");

  const rolled = await w.run();
  assert.equal(rolled.out.step, "rollback", rolled.lines.join("\n"));
  assert.match(rolled.lines.join("\n"), /public_referrers/, "THE CLAIM: the named record's ops copy is rolled back");
  assert.equal(changeOf(w), `ops D\t${shard("W1-T1")}`);
  w.merge(lastPull(w));

  const removal = await w.run();
  assert.equal(removal.out.step, "remove", removal.lines.join("\n"));
  assert.equal(changeOf(w), `public D\t${shard("W1-T3")}`, "and the unnamed copy's public removal proceeds");
  w.merge(lastPull(w));
  assert.ok(w.holds("public", "W1-T1") && !w.holds("ops", "W1-T1"), "the named record stays public only");
  assert.ok(!w.holds("public", "W1-T3") && w.holds("ops", "W1-T3"), "the other record lives in ops only");
  assert.ok(w.holds("public", "W1-T2"));
});
