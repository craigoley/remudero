/**
 * W1-T15047 — a record with no refs/rmd-id ref resolves only through its own shard, so W1-T14993 leaves it on core
 * while a public record cites its id in prose. 2026-11-26: seven such records (W1-T4201..W1-T4380) were pinned by
 * retired or merged citers that never move on their own. A citing record now joins the cited record's W1-T14825
 * group, so both move in one batch, and the real task-id-existence check still passes the public tree after.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { citingFiles, type MigrationSelection } from "#src/lib/plan-task-migration.js";
import { moveWorld, OPS, PUBLIC, record, shard, type MoveWorld } from "#test/helpers/plan-move-world.js";
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
  // The 2026-11-26 shape: an unreserved record is cited by a retired record and, transitively, by a merged record.
  // GitHub's recent merged list also credits that merged citer, which is history evidence rather than current ownership.
  const w = moveWorld(t, {
    "W1-T1": record("W1-T1"), "W1-T2": RETIRED_CITING("W1-T2", "W1-T1"), "W1-T3": MERGED_CITING("W1-T3", "W1-T2"),
  });
  unreserve(w, "W1-T1");
  unreserve(w, "W1-T2");
  const before = taskIdExistence(w, w.main("public"));
  assert.equal(before.status, 0, `positive control: the real check passes the public tree before the move: ${before.out}`);
  const copy = await w.run(true, { graphql: async query => {
    const answer = w.answer(query) as { data: { public: { merged: { nodes: unknown[]; totalCount: number } } } };
    answer.data.public.merged.nodes.push({ number: 700, state: "MERGED", headRefName: "operator-merge-700",
      body: "chore(plan): complete history\n\nRemudero-Task: W1-T3", mergeCommit: { oid: "f".repeat(40) } });
    answer.data.public.merged.totalCount++;
    return answer;
  } });
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

test("W1-T15047 refusal cycles: a lead is only blocked by a different unmovable member", async t => {
  const citing = (id: string, cited: string) => record(id, `  rationale: "Follows ${cited}."\n`);
  const malformed = (id: string, cited: string) => citing(id, cited).replace("  risk: low\n", "");
  const w = moveWorld(t, {
    "W1-T8": malformed("W1-T8", "W1-T9"), "W1-T9": citing("W1-T9", "W1-T8"),
    "W1-T10": malformed("W1-T10", "W1-T11"), "W1-T11": malformed("W1-T11", "W1-T10"),
  });
  for (const id of ["W1-T8", "W1-T9", "W1-T10", "W1-T11"]) unreserve(w, id);
  const result = await w.run(false);
  assert.equal(result.out.step, "none", result.lines.join("\n"));
  const refusals = result.out.refusals as MigrationSelection["refused"];
  assert.deepEqual(Object.fromEntries(refusals.map(({ id, reason }) => [id, reason])), {
    "W1-T8": "ops_gate_shape", "W1-T9": "public_dependants",
    "W1-T10": "public_dependants", "W1-T11": "public_dependants",
  });
});

test("W1-T15047 selection bound: overlapping prose groups with a fleet-sized ref set leave independent work movable", t => {
  const w = moveWorld(t, {});
  const chain = Array.from({ length: 3679 }, (_, i) => `W1-T${10000 + i}`);
  const [cited, retired, done] = ["W1-T5001", "W1-T5002", "W1-T5003"] as const;
  const checkout = w.pub.clone;
  mkdirSync(join(checkout.dir, "plan/tasks.d"));
  for (const [i, id] of chain.entries()) {
    const prior = chain[i - 1];
    writeFileSync(join(checkout.dir, shard(id)), record(id, prior ? `  rationale: "Follows ${prior}."\n` : ""));
  }
  writeFileSync(join(checkout.dir, shard(cited)), record(cited));
  writeFileSync(join(checkout.dir, shard(retired)), RETIRED_CITING(retired, cited));
  writeFileSync(join(checkout.dir, shard(done)), MERGED_CITING(done, retired).replace("status: merged", "status: done"));
  checkout.git("add", "plan");
  checkout.git("commit", "--quiet", "-m", "test: seed a plan-sized citation graph");
  checkout.git("push", "--quiet", "origin", "main");
  const publicCommit = w.main("public");
  const owned = chain.at(-1)!;
  const pullRefs = Array.from({ length: 21000 }, (_, i) => `refs/pull/${i + 1}/head`).sort();
  // Pack the synthetic pull refs at fixture setup to avoid creating 21,000 loose ref files per run.
  writeFileSync(join(w.pub.origin.dir, "packed-refs"), pullRefs.map(ref => `${publicCommit} ${ref}\n`).join(""));
  w.pub.origin.git("update-ref", `refs/heads/run-${owned}-1795000000000`, publicCommit);
  assert.equal(w.pub.origin.git("for-each-ref", "--format=%(refname)", "refs/pull").split("\n").length, pullRefs.length);

  // Bound selection in a child so a synchronous traversal cannot delay the timeout.
  const options = { publicRoot: checkout.dir, publicCommit, publicRepo: PUBLIC,
    opsRoot: w.ops.clone.dir, opsCommit: w.main("ops"), opsRepo: OPS };
  const start = performance.now();
  const selected = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { readFileSync } from "node:fs";
    import { selectPlanTaskMigration } from "#src/lib/plan-task-migration.js";
    const { options, snapshot } = JSON.parse(readFileSync(0, "utf8"));
    console.log(JSON.stringify(await selectPlanTaskMigration(options, async () => snapshot)));
  `], { cwd: REPO_ROOT, env: { ...process.env, ...w.env }, input: JSON.stringify({ options, snapshot: w.answer("") }),
    encoding: "utf8", timeout: 30_000 });
  assert.ifError(selected.error);
  assert.equal(selected.status, 0, selected.stderr);
  t.diagnostic(`Selection took ${Math.round(performance.now() - start)} ms`);
  const selection = JSON.parse(selected.stdout) as MigrationSelection;
  assert.deepEqual(selection.batch.map(member => member.id), [cited, retired, done]);
  assert.equal(selection.controls.candidateSearches, 3, "only the independently movable group spends merge-credit lookups");
  const refused = new Map(selection.refused.map(({ id, reason }) => [id, reason]));
  assert.equal(refused.size, chain.length);
  assert.equal(refused.get(owned), "owned");
  for (const id of chain.slice(0, -1)) assert.equal(refused.get(id), "public_dependants", id);
});

test("W1-T15047 citation scan: one token scan resolves many exact task ids", async t => {
  const w = moveWorld(t, {});
  const ids = Array.from({ length: 200 }, (_, i) => `W1-T${1000 + i}`);
  const source = `${ids.join(" ")} W1-T1000suffix prefixW1-T1001 W1-T9999\n`;
  w.commitTo("public", { "src/many-prose-citations.ts": source }, "docs: cite many task ids in prose");

  const found = await citingFiles(w.pub.clone.dir, w.main("public"), ids);
  assert.equal(found.size, ids.length, "every requested id is found without confusing prefix lookalikes");
  for (const id of ids) assert.deepEqual(found.get(id), ["src/many-prose-citations.ts"], id);
});
