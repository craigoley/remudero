/**
 * W1-T14856 — the mover's preflight reads the root's refs/remotes/origin/main as its base, and the mover never wrote that
 * ref. 2026-11-25 16:27Z: a copy batch built on ops main 7d84178 was refused by task-id-existence because the shared
 * checkout's ref predated ops #847, so W1-T14855, already on ops main, read as an id the batch added.
 * Each run drives movePlanTask over two real Git origins (test/helpers/plan-move-world.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { moveWorld, record, shard } from "#test/helpers/plan-move-world.js";
import { fastForwardTrackingMain } from "#src/lib/plan-task-move.js";

const REF = "refs/remotes/origin/main";

test("W1-T14856 criterion 1: a step's preflight sees origin/main at the commit the step is built on, even when the checkout's ref lagged", async t => {
  const w = moveWorld(t, { "W1-T1": record("W1-T1") });
  const stale = w.main("ops");
  w.commitTo("ops", { [shard("W1-T9")]: record("W1-T9") }, "another writer files W1-T9 on ops main");
  const opsClone = w.sides.ops.clone;
  let seen: { ref: string; parent: string } | undefined;
  let lagged = false;
  const run = await w.run(true, {
    // The selection's GitHub read happens after the world's fetch: put the ref back where a lagging checkout holds it.
    graphql: async query => { if (!lagged) { opsClone.git("update-ref", REF, stale); lagged = true; } return w.answer(query); },
    preflight: async (repoDir, commit) => {
      seen = { ref: opsClone.git("rev-parse", REF), parent: opsClone.git("rev-parse", `${commit}^1`) };
      assert.equal(repoDir, opsClone.dir);
      return { ok: true, failures: [], unreadable: [] };
    },
  });
  assert.equal(run.out.step, "copy", run.lines.join("\n"));
  assert.ok(lagged, "positive control: the ref was put behind main before the step");
  assert.notEqual(stale, seen!.parent, "positive control: main moved past the lagging ref");
  assert.equal(seen!.ref, seen!.parent, "THE CLAIM: the preflight's base is the commit the step is built on");
});

test("W1-T14856 criterion 2: invariant:a-tracking-ref-at-or-past-or-off-the-parent-is-left-alone — only an absent or ancestor ref moves", async t => {
  const w = moveWorld(t, { "W1-T1": record("W1-T1") });
  const clone = w.sides.ops.clone;
  const old = w.main("ops");
  const parent = w.commitTo("ops", { [shard("W1-T9")]: record("W1-T9") }, "main advances");
  clone.git("update-ref", REF, old);
  assert.equal(await fastForwardTrackingMain(clone.dir, parent), "advanced");
  assert.equal(clone.git("rev-parse", REF), parent, "an ancestor ref fast-forwards to the parent");
  assert.equal(await fastForwardTrackingMain(clone.dir, parent), "unchanged", "a ref at the parent stays");
  assert.equal(await fastForwardTrackingMain(clone.dir, old), "unchanged", "a ref past the parent stays");
  assert.equal(clone.git("rev-parse", REF), parent);
  // A ref on another line of history is not an ancestor of the parent: it is left as it is.
  clone.git("checkout", "--quiet", "--orphan", "side");
  clone.git("commit", "--quiet", "--allow-empty", "-m", "unrelated");
  const side = clone.git("rev-parse", "HEAD");
  clone.git("update-ref", REF, side);
  assert.equal(await fastForwardTrackingMain(clone.dir, parent), "unchanged");
  assert.equal(clone.git("rev-parse", REF), side, "THE CLAIM: a ref off the parent's line never moves");
  clone.git("update-ref", "-d", REF);
  assert.equal(await fastForwardTrackingMain(clone.dir, parent), "advanced", "an absent ref is written at the parent");
  assert.equal(clone.git("rev-parse", REF), parent);
});
