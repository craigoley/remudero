/**
 * W1-T14825 — the mover moves a record together with every public record that names it through depends_on or
 * superseded_by, transitively, in one batch. 2026-11-25: after W1-T14773, a depends_on chain drained one link per
 * round, and 15 open records named only by merged or retired records could never move at all.
 * Each run drives movePlanTask over two real Git origins (test/helpers/plan-move-world.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { moveWorld, record, shard, type MoveWorld } from "#test/helpers/plan-move-world.js";

const RETIRED_NAMING = (id: string, named: string) => record(id, `  retirement: closed\n  superseded_by: ${named}\n`).replace("status: queued", "status: blocked");
const lastPull = (w: MoveWorld) => w.pulls.at(-1)!;
const changeOf = (w: MoveWorld) => {
  const pr = lastPull(w);
  return w.sides[pr.repository].origin.git("diff", "--name-status", `main...${pr.head}`).split("\n").sort().join("\n");
};
const added = (...ids: string[]) => ids.map(id => `A\t${shard(id)}`).sort().join("\n");
const deleted = (...ids: string[]) => ids.map(id => `D\t${shard(id)}`).sort().join("\n");

/** Copy, merge, remove, merge: the whole move of one batch, returning the two step outputs. */
async function moveOnce(w: MoveWorld) {
  const copy = await w.run();
  assert.equal(copy.out.step, "copy", copy.lines.join("\n"));
  const copied = changeOf(w);
  w.merge(lastPull(w));
  const removal = await w.run();
  assert.equal(removal.out.step, "remove", removal.lines.join("\n"));
  const removed = changeOf(w);
  w.merge(lastPull(w));
  return { copied, removed };
}

test("W1-T14825 criterion 1: a depends_on chain moves in one batch, and core then holds none of it", async t => {
  const w = moveWorld(t, {
    "W1-T1": record("W1-T1"), "W1-T2": record("W1-T2", "  depends_on: [W1-T1]\n"), "W1-T3": record("W1-T3", "  depends_on: [W1-T2]\n"),
  });
  const { copied, removed } = await moveOnce(w);
  assert.equal(copied, added("W1-T1", "W1-T2", "W1-T3"), "THE CLAIM: the whole chain is copied in one batch");
  assert.equal(removed, deleted("W1-T1", "W1-T2", "W1-T3"), "and removed from core in the same move");
  for (const id of ["W1-T1", "W1-T2", "W1-T3"]) assert.ok(!w.holds("public", id) && w.holds("ops", id), id);
});

test("W1-T14825 criterion 2: an open record named only by a retired or merged record moves with its namers as history", async t => {
  // The 2026-11-25 shape: core's retired W1-T2874 named W1-T13178 as superseded_by, and a merged record depended on it.
  const merged = record("W1-T3", "  depends_on: [W1-T1]\n").replace("status: queued", "status: merged");
  const w = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T2": RETIRED_NAMING("W1-T2", "W1-T1"), "W1-T3": merged });
  const { copied, removed } = await moveOnce(w);
  assert.equal(copied, added("W1-T1", "W1-T2", "W1-T3"), "THE CLAIM: the named record moves with both namers");
  assert.equal(removed, deleted("W1-T1", "W1-T2", "W1-T3"));
  const unstamped = (id: string) => w.bytes("ops", shard(id))!.replace(/^  moved_from: remudero@[0-9a-f]{40}\n/m, "");
  assert.equal(unstamped("W1-T2"), RETIRED_NAMING("W1-T2", "W1-T1"), "the retired namer is copied byte for byte, plus its moved_from stamp");
  assert.equal(unstamped("W1-T3"), merged, "the merged namer is copied byte for byte, plus its moved_from stamp");
});

test("W1-T14825 criterion 3: invariant:a-group-with-an-unmovable-member-stays-whole — no member of it is copied", async t => {
  // The namer W1-T2 has no reservation, so it cannot move; W1-T1 and W1-T3, which W1-T2 links, stay with it.
  const w = moveWorld(t, {
    "W1-T1": record("W1-T1"), "W1-T2": record("W1-T2", "  depends_on: [W1-T1]\n"), "W1-T3": record("W1-T3", "  depends_on: [W1-T2]\n"), "W1-T4": record("W1-T4"),
  });
  w.pub.origin.git("update-ref", "refs/rmd-dispatch/W1-T2", w.main("public")); // W1-T14993: an unreserved id now moves; a dispatch claim keeps W1-T2 on core
  const copy = await w.run();
  assert.equal(copy.out.step, "copy", copy.lines.join("\n"));
  assert.equal(changeOf(w), added("W1-T3", "W1-T4"), "THE CLAIM: only records no unmovable record names are copied");

  // A record named by a record in the tasks.yaml monolith stays too: the monolith never moves.
  const m = moveWorld(t, { "W1-T5": record("W1-T5"), "W1-T6": record("W1-T6") });
  m.commitTo("public", { "plan/tasks.yaml": record("W1-T7", "  depends_on: [W1-T5]\n") }, "a monolith record names W1-T5");
  assert.equal((await m.run()).out.step, "copy");
  assert.equal(changeOf(m), added("W1-T6"), "THE CLAIM: a monolith namer pins the record it names");
  // Positive control: with no namer, both records move.
  const c = moveWorld(t, { "W1-T5": record("W1-T5"), "W1-T6": record("W1-T6") });
  assert.equal((await c.run()).out.step, "copy");
  assert.equal(changeOf(c), added("W1-T5", "W1-T6"));
});

test("W1-T14858 criterion 1: a retired namer whose status the ops gate reads as live work, with a shape the gate refuses, keeps its whole group on core", async t => {
  // The 2026-11-25 ops #859 shape: W1-T2874 is retired (retirement: closed) with status blocked, and a proof with no
  // dialect prefix. The ops gate judges it as moved live work by its status and refuses the copy.
  const bareProof = RETIRED_NAMING("W1-T2", "W1-T1").replace('proof: "grep: fixture in test/fixture.test.ts"', 'proof: "the fixture holds"');
  const w = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T2": bareProof, "W1-T3": record("W1-T3") });
  assert.equal((await w.run()).out.step, "copy");
  assert.equal(changeOf(w), added("W1-T3"), "THE CLAIM: neither the named record nor its refused namer is copied");
  // Positive control: the same namer with a prefixed proof moves with the record it names.
  const c = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T2": RETIRED_NAMING("W1-T2", "W1-T1"), "W1-T3": record("W1-T3") });
  assert.equal((await c.run()).out.step, "copy");
  assert.equal(changeOf(c), added("W1-T1", "W1-T2", "W1-T3"));
});
