/**
 * W1-T13680 criteria 3 and 8: every interrupted move converges in one run, read from both mains, and in every state
 * the fixtures drive the id is held by at least one main (or public history names its mover removal and the next
 * run restores it). Each run drives movePlanTask over two real Git origins (test/helpers/plan-move-world.ts).
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { blobAt, moveWorld, record, shard, type MoveWorld } from "#test/helpers/plan-move-world.js";

const ID = "W1-T1";
const ORIGINAL = record(ID);

/** A move whose ops copy has landed on ops main: both mains hold the id. */
async function bothHold(t: TestContext): Promise<MoveWorld> {
  const w = moveWorld(t, { [ID]: ORIGINAL });
  assert.equal((await w.run()).out.step, "copy");
  w.merge(w.pulls[0]!);
  assert.ok(w.holds("public", ID) && w.holds("ops", ID), "positive control: both mains hold the id");
  return w;
}
const lastPull = (w: MoveWorld) => w.pulls.at(-1)!;
const changeOf = (w: MoveWorld) => {
  const pr = lastPull(w);
  return `${pr.repository} ${w.sides[pr.repository].origin.git("diff", "--name-status", `main...${pr.head}`)}`;
};

test("W1-T13680 criterion 3: each interrupted state converges in one run, read from both mains", async t => {
  // Both hold it; the public copy is unchanged and unowned: the public removal opens.
  const unchanged = await bothHold(t);
  const removal = await unchanged.run();
  assert.equal(removal.out.step, "remove", removal.lines.join("\n"));
  assert.equal(changeOf(unchanged), `public D\t${shard(ID)}`);

  // Both hold it; the public copy was amended: an ops pull request removes the ops copy, and the public copy stays.
  const amended = await bothHold(t);
  amended.commitTo("public", { [shard(ID)]: ORIGINAL.replace("priority: 1", "priority: 2") }, "amend the public copy");
  const rolled = await amended.run();
  assert.equal(rolled.out.step, "rollback", rolled.lines.join("\n"));
  assert.equal(rolled.out.reason, "amended");
  assert.equal(changeOf(amended), `ops D\t${shard(ID)}`);
  amended.merge(lastPull(amended));
  assert.ok(amended.holds("public", ID) && !amended.holds("ops", ID), "the public copy stays");

  // Both hold it; the public copy is claimed, has a run branch, or has an open pull request on the id or its record.
  const owners: Array<[string, (w: MoveWorld) => void]> = [
    ["claimed", w => w.pub.origin.git("update-ref", `refs/rmd-dispatch/${ID}`, w.main("public"))],
    ["run_branch", w => w.pub.origin.git("update-ref", `refs/heads/run-${ID}-1795000000000`, w.main("public"))],
    ["open_pull_request", w => { w.openPull("public", { head: "an-amendment", files: [shard(ID)] }); }],
    ["open_pull_request", w => { w.openPull("public", { head: "hand-fix", body: `Fixes it.\n\nRemudero-Task: ${ID}` }); }],
  ];
  for (const [reason, own] of owners) {
    const w = await bothHold(t);
    own(w);
    const run = await w.run();
    assert.equal(run.out.step, "rollback", `${reason}: ${run.lines.join("\n")}`);
    assert.equal(run.out.reason, reason);
    assert.equal(changeOf(w), `ops D\t${shard(ID)}`);
    assert.ok(w.holds("public", ID), "the public copy stays");
  }

  // Neither holds it while public history holds a mover removal commit for it: the bound original is restored.
  const lost = await bothHold(t);
  await lost.run(); lost.merge(lastPull(lost));
  lost.commitTo("ops", { [shard(ID)]: null }, "the ops copy is deleted by hand");
  assert.ok(!lost.holds("public", ID) && !lost.holds("ops", ID), "positive control: neither main holds the id");
  const restore = await lost.run();
  assert.equal(restore.out.step, "restore", restore.lines.join("\n"));
  assert.equal(changeOf(lost), `public A\t${shard(ID)}`);
  assert.equal(blobAt(lost.pub.origin.dir, `${lastPull(lost).head}:${shard(ID)}`), ORIGINAL, "the bound original bytes, at their path");
  lost.merge(lastPull(lost));
  assert.equal(lost.bytes("public", shard(ID)), ORIGINAL);
  assert.equal((await lost.run()).out.step, "copy", "once restored, the record is an ordinary candidate again");

  // Only ops holds it with moved_from: the move is complete and nothing opens.
  const complete = await bothHold(t);
  await complete.run(); complete.merge(lastPull(complete));
  const opened = complete.pulls.length;
  const done = await complete.run();
  assert.equal(done.out.step, "complete", done.lines.join("\n"));
  assert.equal(complete.pulls.length, opened, "nothing opens");
});

test("W1-T13680 criterion 8: no task is lost in any state the fixtures drive, and a converging run leaves exactly one holder", async t => {
  const w = moveWorld(t, { [ID]: ORIGINAL });
  const removedInHistory = () => w.pub.origin.git("log", "--format=%B", "main").includes(`Remudero-Moved-To: `);
  const held = (label: string) => {
    const holders = (["public", "ops"] as const).filter(side => w.holds(side, ID));
    assert.ok(holders.length > 0 || removedInHistory(), `${label}: the id is held by a main, or public history names its removal`);
    return holders.length;
  };
  // A crash after the push and before the pull request: no pull request, and the next run takes the step again.
  w.failCreate(new Error("connection reset"));
  const crashed = await w.run();
  assert.equal(crashed.status, 1);
  assert.equal(crashed.out.outcome, "pull_request_failed");
  assert.equal(held("crash in the copy step"), 1);
  w.failCreate(undefined);
  assert.equal((await w.run()).out.step, "copy");
  assert.equal(held("copy open"), 1);
  // The copy refused: closed unmerged. The public copy is never touched, and the same blob is not picked again.
  w.close(lastPull(w));
  assert.equal(held("copy closed"), 1);
  assert.equal((await w.run()).out.step, "none");
  // An amendment makes it a new candidate; this copy lands.
  w.commitTo("public", { [shard(ID)]: ORIGINAL.replace("priority: 1", "priority: 3") }, "amend");
  assert.equal((await w.run()).out.step, "copy");
  w.merge(lastPull(w));
  assert.equal(held("copy landed"), 2);
  // The public removal refused (closed): both still hold it, and the next run opens it again.
  assert.equal((await w.run()).out.step, "remove");
  w.close(lastPull(w));
  assert.equal(held("removal closed"), 2);
  assert.equal((await w.run()).out.step, "remove");
  w.merge(lastPull(w));
  assert.equal(held("removal landed"), 1);
  assert.ok(w.holds("ops", ID) && !w.holds("public", ID));
  // The ops copy deleted by hand: neither holds it, history names the removal, and one run restores it.
  w.commitTo("ops", { [shard(ID)]: null }, "lose the ops copy");
  assert.equal(held("neither holds"), 0);
  assert.equal((await w.run()).out.step, "restore");
  w.merge(lastPull(w));
  assert.equal(held("restored"), 1);
  assert.ok(w.holds("public", ID));

  // The mover never deletes a record it has not first found byte-identical in the other catalog.
  const differs = moveWorld(t, { [ID]: ORIGINAL });
  differs.commitTo("ops", { [shard(ID)]: ORIGINAL.replace(`- id: ${ID}\n`, `- id: ${ID}\n  moved_from: remudero@${differs.main("public")}\n`).replace("Move fixture", "Moved fixture") }, "a differing copy");
  const refused = await differs.run();
  assert.equal(refused.out.step, "held");
  assert.equal(differs.pulls.length, 0, "neither copy is deleted while they differ");
  for (const [label, run] of [["after a converging rollback", await bothHoldThenRollback(t)], ["after a converging removal", await bothHoldThenRemove(t)]] as const) {
    assert.equal((["public", "ops"] as const).filter(side => run.holds(side, ID)).length, 1, `${label}: exactly one catalog holds it`);
  }
});

async function bothHoldThenRollback(t: TestContext): Promise<MoveWorld> {
  const w = await bothHold(t);
  w.pub.origin.git("update-ref", `refs/rmd-dispatch/${ID}`, w.main("public"));
  assert.equal((await w.run()).out.step, "rollback");
  w.merge(lastPull(w));
  return w;
}
async function bothHoldThenRemove(t: TestContext): Promise<MoveWorld> {
  const w = await bothHold(t);
  assert.equal((await w.run()).out.step, "remove");
  w.merge(lastPull(w));
  return w;
}
