/**
 * W1-T15047 — a record with no refs/rmd-id ref resolves only through its own shard, so W1-T14993 leaves it on core
 * while a public record cites its id in prose. 2026-11-26: seven such records (W1-T4201..W1-T4380) were pinned by
 * retired or merged citers that never move on their own. A citing record now joins the cited record's W1-T14825
 * group, so both move in one batch, and the real task-id-existence check still passes the public tree after.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { moveWorld, record, shard, type MoveWorld } from "#test/helpers/plan-move-world.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** A retired record whose prose cites `cited`, with an open-shaped status as core's retired records carry. */
const RETIRED_CITING = (id: string, cited: string) =>
  record(id, `  retirement: closed\n  rationale: "Superseded; the work continues in ${cited}."\n`).replace("status: queued", "status: blocked");
/** A merged record whose prose cites `cited`. */
const MERGED_CITING = (id: string, cited: string) =>
  record(id, `  rationale: "Builds on ${cited}."\n`).replace("status: queued", "status: merged");

const unreserve = (w: MoveWorld, id: string) => w.pub.origin.git("update-ref", "-d", `refs/rmd-id/${id}`);
const lastPull = (w: MoveWorld) => w.pulls.at(-1)!;
const changeOf = (w: MoveWorld) => {
  const pr = lastPull(w);
  return w.sides[pr.repository].origin.git("diff", "--name-status", `main...${pr.head}`).split("\n").sort().join("\n");
};
const added = (...ids: string[]) => ids.map(id => `A\t${shard(id)}`).sort().join("\n");
const deleted = (...ids: string[]) => ids.map(id => `D\t${shard(id)}`).sort().join("\n");

/** The real scripts/task-id-existence-check.mjs, no stub, over the public tree at `commit`. */
function taskIdExistence(w: MoveWorld, commit: string): { status: number | null; out: string } {
  const dir = join(w.root, `gate-${commit.slice(0, 12)}`);
  w.pub.clone.git("fetch", "--quiet", "origin");
  w.pub.clone.git("worktree", "add", "--quiet", "--detach", dir, commit);
  const baseline = join(w.root, "empty-task-id-baseline.json");
  writeFileSync(baseline, "[]\n");
  const run = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "task-id-existence-check.mjs"), "--cwd", dir, "--baseline", baseline], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  w.pub.clone.git("worktree", "prune");
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

test("W1-T15047 criterion 1: a prose-cited record moves with its history citers", async t => {
  // The 2026-11-26 shape: W1-T4210 has no reservation and is cited by a retired record (W1-T5197) and, transitively,
  // through an unreserved citer that a merged record cites in turn.
  const w = moveWorld(t, {
    "W1-T1": record("W1-T1"), "W1-T2": RETIRED_CITING("W1-T2", "W1-T1"), "W1-T3": MERGED_CITING("W1-T3", "W1-T2"),
  });
  unreserve(w, "W1-T1");
  unreserve(w, "W1-T2");
  const before = taskIdExistence(w, w.main("public"));
  assert.equal(before.status, 0, `positive control: the real check passes the public tree before the move: ${before.out}`);
  const copy = await w.run();
  assert.equal(copy.out.step, "copy", copy.lines.join("\n"));
  assert.equal(changeOf(w), added("W1-T1", "W1-T2", "W1-T3"), "THE CLAIM: the cited record is copied with every citer, transitively");
  w.merge(lastPull(w));
  const removal = await w.run();
  assert.equal(removal.out.step, "remove", removal.lines.join("\n"));
  assert.equal(changeOf(w), deleted("W1-T1", "W1-T2", "W1-T3"), "and removed from core in the same move");
  w.merge(lastPull(w));
  for (const id of ["W1-T1", "W1-T2", "W1-T3"]) assert.ok(!w.holds("public", id) && w.holds("ops", id), id);
  const after = taskIdExistence(w, w.main("public"));
  assert.equal(after.status, 0, `THE CLAIM: the removal leaves no unresolved citation for the real check: ${after.out}`);
});

test("W1-T15047 criterion 2: a group with an unmovable citer stays public", async t => {
  // An open citer with a dispatch claim is owned, so it cannot move, and the record it cites stays with it.
  const w = moveWorld(t, {
    "W1-T1": record("W1-T1"), "W1-T2": record("W1-T2", `  rationale: "Follows W1-T1."\n`), "W1-T4": record("W1-T4"),
  });
  unreserve(w, "W1-T1");
  w.pub.origin.git("update-ref", "refs/rmd-dispatch/W1-T2", w.main("public"));
  const copy = await w.run();
  assert.equal(copy.out.step, "copy", copy.lines.join("\n"));
  assert.equal(changeOf(w), added("W1-T4"), "THE CLAIM: neither the cited record nor its unmovable citer is copied");

  // A citation from a file that is not a record cannot move, so the cited record stays though its record citer could go.
  const s = moveWorld(t, { "W1-T5": record("W1-T5"), "W1-T6": RETIRED_CITING("W1-T6", "W1-T5"), "W1-T7": record("W1-T7") });
  unreserve(s, "W1-T5");
  s.commitTo("public", { "src/cites-w1-t5.ts": "// Follows W1-T5.\nexport {};\n" }, "chore: cite W1-T5 from code");
  assert.equal((await s.run()).out.step, "copy");
  assert.equal(changeOf(s), added("W1-T7"), "THE CLAIM: a code citation keeps the whole group on core");
  const kept = taskIdExistence(s, s.main("public"));
  assert.equal(kept.status, 0, `the real check passes while the group stays: ${kept.out}`);
});
