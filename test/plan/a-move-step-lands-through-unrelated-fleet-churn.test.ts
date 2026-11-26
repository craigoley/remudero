/**
 * W1-T14447: a catalog move step lands while unrelated pull requests push and merge and both mains move on. The
 * mover's selection (src/lib/plan-task-migration.ts) re-reads GitHub once per candidate and once per selected member;
 * the step (src/lib/plan-task-move.ts) reads it once more. Measured 2026-11-23: on the live fleet public main moves
 * every ~11 minutes and open pull requests are pushed continuously, so a whole-snapshot comparison and an exact head
 * pin answered ownership_changed or ref_moved on every run and no step landed. Each case below drives the real
 * selection or the real mover over two real Git origins (test/helpers/plan-move-world.ts), changes the world between
 * its reads exactly as another writer would, and reads the answer: only a change that touches a task the step
 * carries may refuse it, and every such change still does.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { moveReservation, PreviewUnknown, selectPlanTaskMigration, type MigrationGraphqlReader, type MigrationSelection } from "#src/lib/plan-task-migration.js";
import { MOVE_RESERVATION_TRAILER } from "#src/lib/plan-task-move.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { moveWorld, OPS, PUBLIC, record, shard, type MoveWorld, type Side } from "#test/helpers/plan-move-world.js";

type Json = Record<string, unknown>;
/** Which of the selection's reads a GraphQL query is: its first, a candidate's lookup, or a member's final re-read. */
type Phase = "initial" | "lookup" | "final" | "movers";
interface Read { phase: Phase; n: number; id?: string }

/** A merged pull request node as the merged-PR connection answers it. */
const mergedNode = (number: number, headRefName: string, body: string) =>
  ({ number, state: "MERGED", headRefName, body, mergeCommit: { oid: "c".repeat(40) } });

/**
 * The world's own GitHub answer, with a hook that sees (and may change) the world before each read is answered.
 * `candidates` is how many lookups the selection makes before its final re-reads.
 */
function reader(w: MoveWorld, candidates: number, hook: (read: Read) => void, merged: () => Json[] = () => [],
  edit: (data: { public: Json; ops: Json }) => void = () => undefined): MigrationGraphqlReader {
  let searches = 0, initials = 0;
  return async query => {
    // The trailer search names the looked-up id inside a JSON-quoted search term.
    const id = /Remudero-Task: ([A-Z0-9]+-T[0-9]+)\\" in:body/.exec(query)?.[1];
    const phase: Phase = query.includes("publicMoves:") ? "movers" : id === undefined ? "initial" : ++searches <= candidates ? "lookup" : "final";
    const n = phase === "initial" ? ++initials : phase === "lookup" ? searches : phase === "final" ? searches - candidates : 1;
    hook({ phase, n, ...(id ? { id } : {}) });
    const answer = w.answer(query) as { data: { public: { merged: { nodes: Json[]; totalCount: number } }; ops: Json } };
    const extra = merged();
    if (extra.length > 0) {
      const nodes = [...extra, ...answer.data.public.merged.nodes];
      answer.data.public.merged = { ...answer.data.public.merged, nodes, totalCount: nodes.length };
    }
    edit(answer.data);
    return answer;
  };
}

/** Another writer's commit straight to an origin's main, from its own clone: the mover's checkout never sees it. */
function advance(t: TestContext, w: MoveWorld, side: Side, files: Record<string, string>, message: string): string {
  const writer = gitRepo({ cloneFrom: w.sides[side].origin.dir, scope: t, kind: `churn-${side}` });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(writer.dir, rel)), { recursive: true });
    writeFileSync(join(writer.dir, rel), text);
    writer.git("add", rel);
  }
  writer.git("commit", "--quiet", "-m", message);
  writer.git("push", "--quiet", "origin", "HEAD:main");
  return w.main(side);
}

/** The selection at both current mains, in process, with the world's URL rewrites in this process's environment. */
async function select(w: MoveWorld, read: MigrationGraphqlReader): Promise<{ selection?: MigrationSelection; reason?: string; pins: { public: string; ops: string } }> {
  for (const side of ["public", "ops"] as const) w.sides[side].clone.git("fetch", "--quiet", "origin");
  const pins = { public: w.main("public"), ops: w.main("ops") };
  const previous = new Map(Object.keys(w.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, w.env);
  try {
    const selection = await selectPlanTaskMigration({ publicRoot: w.pub.clone.dir, publicCommit: pins.public, publicRepo: PUBLIC,
      opsRoot: w.ops.clone.dir, opsCommit: pins.ops, opsRepo: OPS }, read);
    return { selection, pins };
  } catch (error) {
    if (error instanceof PreviewUnknown) return { reason: error.reason, pins };
    throw error;
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

const batchIds = (selection: MigrationSelection | undefined) => (selection?.batch ?? []).map(member => String(member.id)).sort();

test("W1-T14447 criterion 1: a push to an unrelated open pull request between the selection's reads leaves the batch selected", async t => {
  const w = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T2": record("W1-T2") });
  // A fleet pull request for another task, open before the selection starts; pushed again before every later read.
  const fleet = w.openPull("public", { head: "run-W1-T77-1795000000000", body: "Remudero-Task: W1-T77", files: ["src/lib/unrelated.ts"], headOid: "1".repeat(40) });
  let pushes = 0;
  const result = await select(w, reader(w, 2, read => {
    if (read.phase === "initial") return;
    pushes++;
    fleet.headOid = String(pushes + 1).repeat(40).slice(0, 40);
    fleet.files = [...fleet.files, `src/lib/unrelated-${pushes}.ts`];
    // A second fleet pull request opens mid-selection, on code and on another task's record.
    if (pushes === 1) w.openPull("public", { head: "run-W1-T78-1795000000001", body: "Remudero-Task: W1-T78", files: ["src/cli/other.ts", shard("W1-T78")] });
  }));
  assert.equal(result.reason, undefined, `an unrelated push is not a change of ownership: ${result.reason}`);
  assert.ok(pushes >= 4, `the selection re-read the world after every push (${pushes} reads after the first)`);
  assert.equal(result.selection?.outcome, "candidate");
  assert.deepEqual(batchIds(result.selection), ["W1-T1", "W1-T2"], "the whole batch is still selected");
  assert.equal(result.selection?.publicCommit, result.pins.public);
});

test("W1-T14447 criterion 2: an unrelated merge during selection, and mains that moved past the pins by unrelated commits, leave the step written on its pinned commits", async t => {
  // (a) A pull request crediting another task merges between the selection's first read and its lookups.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    let landed = false;
    const result = await select(w, reader(w, 1, read => { if (read.phase !== "initial") landed = true; },
      () => landed ? [mergedNode(500, "run-W1-T88-1795000000002", "fix(x): another task\n\nRemudero-Task: W1-T88")] : []));
    assert.ok(landed);
    assert.equal(result.reason, undefined, `a merge crediting no carried task is not a change of ownership: ${result.reason}`);
    assert.deepEqual(batchIds(result.selection), ["W1-T1"]);
  }
  // (b) Both mains move on by unrelated commits while the copy step is read: the copy still lands on the pinned ops commit.
  const w = moveWorld(t, { "W1-T1": record("W1-T1") });
  const pinned = { public: w.main("public"), ops: w.main("ops") };
  let moved = false;
  const churn = (read: Read) => {
    if (moved || read.phase !== "movers") return;
    moved = true;
    advance(t, w, "public", { "src/lib/unrelated.ts": "export const x = 1;\n", [shard("W1-T600")]: record("W1-T600") }, "feat: unrelated public work");
    advance(t, w, "ops", { [shard("W1-T500")]: record("W1-T500") }, "chore(plan): file an unrelated ops task");
  };
  const copy = await w.run(true, { graphql: reader(w, 1, churn) });
  assert.ok(moved, "both mains moved after the pins were taken");
  assert.notEqual(w.main("public"), pinned.public);
  assert.notEqual(w.main("ops"), pinned.ops);
  assert.equal(copy.out.step, "copy", copy.lines.join("\n"));
  assert.equal(copy.out.applied, true, copy.lines.join("\n"));
  assert.equal(copy.out.opsCommit, pinned.ops);
  const copyPull = w.pulls.at(-1)!;
  assert.equal(w.ops.origin.git("rev-parse", `${copyPull.head}^`), pinned.ops, "the copy's parent is the pinned ops commit, not the live head");
  // (c) The copy lands; public main moves on again while the removal is read: the removal lands on the pinned public commit.
  w.merge(copyPull);
  const removalPin = w.main("public");
  let again = false;
  const removal = await w.run(true, { graphql: reader(w, 0, read => {
    if (again || read.phase !== "movers") return;
    again = true;
    advance(t, w, "public", { "docs/unrelated.md": "unrelated\n" }, "docs: unrelated public work");
  }) });
  assert.ok(again);
  assert.equal(removal.out.step, "remove", removal.lines.join("\n"));
  assert.equal(removal.out.applied, true, removal.lines.join("\n"));
  const removalPull = w.pulls.at(-1)!;
  assert.equal(w.pub.origin.git("rev-parse", `${removalPull.head}^`), removalPin, "the removal's parent is the pinned public commit");
});

test("W1-T14447 criterion 3: a live main the pin is not an ancestor of, or whose range from the pin changes a carried record, still answers ref_moved", async t => {
  // A public main rewritten so the pinned commit is no longer its ancestor.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    let rewritten = false;
    const result = await select(w, reader(w, 1, read => {
      if (rewritten || read.phase !== "initial") return;
      rewritten = true;
      const origin = w.pub.origin, tree = origin.git("rev-parse", "main^{tree}");
      origin.git("update-ref", "refs/heads/main", origin.git("commit-tree", tree, "-m", "a rewritten main"));
    }));
    assert.ok(rewritten);
    assert.equal(result.reason, "ref_moved", "a live head that does not descend from the pin is refused");
  }
  // An ops head the API names that no fetch of the ops origin brings.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    let named = false;
    const result = await select(w, reader(w, 1, read => { if (read.phase === "lookup") named = true; }, () => [],
      data => { if (named) data.ops = { ...data.ops, defaultBranchRef: { name: "main", target: { oid: "a".repeat(40) } } }; }));
    assert.ok(named);
    assert.equal(result.reason, "ref_moved", "a live head the checkout cannot read is refused");
  }
  // A public main whose range from the pin amends the candidate's record.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    let amended = false;
    const result = await select(w, reader(w, 1, read => {
      if (amended || read.phase !== "lookup") return;
      amended = true;
      advance(t, w, "public", { [shard("W1-T1")]: record("W1-T1").replace("priority: 1", "priority: 2") }, "chore(plan): amend W1-T1");
    }));
    assert.ok(amended);
    assert.equal(result.reason, "ref_moved", "a range that changes a carried record path is refused");
  }
  // An ops main whose range from the pin adds a record at the candidate's destination path.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    let taken = false;
    const result = await select(w, reader(w, 1, read => {
      if (taken || read.phase !== "final") return;
      taken = true;
      advance(t, w, "ops", { [shard("W1-T1")]: record("W1-T1") }, "chore(plan): another writer's ops copy");
    }));
    assert.ok(taken);
    assert.equal(result.reason, "ref_moved", "a range that writes a carried task's ops destination path is refused");
  }
  // A public main whose range files a record that depends on the candidate: it names a carried task.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    let filed = false;
    const result = await select(w, reader(w, 1, read => {
      if (filed || read.phase !== "lookup") return;
      filed = true;
      advance(t, w, "public", { [shard("W1-T3")]: record("W1-T3", "  depends_on: [W1-T1]\n") }, "chore(plan): file a dependant");
    }));
    assert.ok(filed);
    assert.equal(result.reason, "ref_moved", "a range whose catalog change names a carried task is refused");
  }
  // The step itself: an ops main that amended the ops copy since the pin refuses the public removal.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    const copy = await w.run();
    assert.equal(copy.out.step, "copy", copy.lines.join("\n"));
    w.merge(w.pulls.at(-1)!);
    const opened = w.pulls.length;
    let changed = false;
    const removal = await w.run(true, { graphql: reader(w, 0, read => {
      if (changed || read.phase !== "movers") return;
      changed = true;
      const text = w.bytes("ops", shard("W1-T1"))!;
      advance(t, w, "ops", { [shard("W1-T1")]: text.replace("priority: 1", "priority: 3") }, "chore(plan): amend the ops copy");
    }) });
    assert.ok(changed);
    assert.equal(removal.out.step, "unknown", removal.lines.join("\n"));
    assert.equal(removal.out.reason, "ref_moved");
    assert.equal(w.pulls.length, opened, "no removal pull request opens");
  }
});

test("W1-T14447 criterion 4: invariant:a-changed-carried-task-never-moves — a pull request newly owning or crediting a carried task still answers ownership_changed", async t => {
  // An open pull request that newly owns the candidate during its lookup by each of taskOwned's rules; it has closed
  // again by the final re-read, so only the lookup's own comparison can see it.
  const owners: Array<[string, Json]> = [
    ["its record path", { head: "operator-fix-1", files: [shard("W1-T1")] }],
    ["its run branch", { head: "run-W1-T1-1795000000003", files: ["src/lib/other.ts"] }],
    ["its trailer", { head: "operator-fix-3", body: "fix: build it\n\nRemudero-Task: W1-T1", files: ["src/lib/other.ts"] }],
  ];
  for (const [rule, pr] of owners) {
    const w = moveWorld(t, { "W1-T1": record("W1-T1", "  files:\n    - src/lib/moved-task-code.ts\n") });
    let owner: ReturnType<MoveWorld["openPull"]> | undefined;
    const result = await select(w, reader(w, 1, read => {
      if (read.phase === "lookup" && !owner) owner = w.openPull("public", { ...(pr as { head: string }) });
      if (read.phase === "final" && owner) w.close(owner);
    }));
    assert.ok(owner, rule);
    assert.equal(result.reason, "ownership_changed", `an open pull request newly owning the candidate by ${rule} refuses the selection`);
  }
  // A pushed open pull request that newly touches the candidate's record, during its lookup only.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    const fleet = w.openPull("public", { head: "run-W1-T77-1795000000000", files: ["src/lib/unrelated.ts"] });
    const result = await select(w, reader(w, 1, read => {
      if (read.phase === "lookup") { fleet.headOid = "2".repeat(40); fleet.files = ["src/lib/unrelated.ts", shard("W1-T1")]; }
      if (read.phase === "final") { fleet.headOid = "3".repeat(40); fleet.files = ["src/lib/unrelated.ts"]; }
    }));
    assert.equal(result.reason, "ownership_changed", "a push that makes an open pull request own the candidate refuses the selection");
  }
  // A member selected earlier is protected through the later lookups too.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T2": record("W1-T2") });
    let first: string | undefined, owner: ReturnType<MoveWorld["openPull"]> | undefined;
    const result = await select(w, reader(w, 2, read => {
      if (read.phase === "lookup" && read.n === 1) first = read.id;
      if (read.phase === "lookup" && read.n === 2) owner = w.openPull("public", { head: "operator-fix-4", files: [shard(first!)] });
      if (read.phase === "final" && owner) w.close(owner);
    }));
    assert.ok(first && owner);
    assert.equal(result.reason, "ownership_changed", "an open pull request newly owning a member selected earlier refuses the selection");
  }
  // A pull request crediting the candidate merges before the final re-read, while the search index still misses it.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    let landed = false;
    const result = await select(w, reader(w, 1, read => { if (read.phase === "final") landed = true; },
      () => landed ? [mergedNode(501, "operator-fix-5", "fix: build it\n\nRemudero-Task: W1-T1")] : []));
    assert.ok(landed);
    assert.equal(result.reason, "ownership_changed", "a newly merged pull request crediting the candidate refuses the selection");
  }
  // A merged pull request already in the read whose body is revised mid-selection to name the candidate.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    let revised = false;
    const result = await select(w, reader(w, 1, read => { if (read.phase === "lookup") revised = true; },
      () => [mergedNode(503, "run-W1-T89-1795000000005", `fix: another task\n\nRemudero-Task: W1-T89${revised ? "\nRemudero-Task: W1-T1" : ""}`)]));
    assert.ok(revised);
    assert.equal(result.reason, "ownership_changed", "a merged pull request revised to name the candidate refuses the selection");
  }
  // The same, by the merged pull request's run branch, during the lookup.
  {
    const w = moveWorld(t, { "W1-T1": record("W1-T1") });
    let landed = false;
    const result = await select(w, reader(w, 1, read => { if (read.phase === "lookup") landed = true; if (read.phase === "final") landed = false; },
      () => landed ? [mergedNode(502, "run-W1-T1-1795000000004", "fix: build it")] : []));
    assert.equal(result.reason, "ownership_changed", "a newly merged run branch of the candidate refuses the selection");
  }
});

/** W1-T14993: drop an id's refs/rmd-id ref, as the ids filed before reservations (W1-T4190..W1-T4216) never had one. */
const unreserve = (w: MoveWorld, id: string) => w.pub.origin.git("update-ref", "-d", `refs/rmd-id/${id}`);

test("W1-T14993 criterion 1: a record with no refs/rmd-id ref that the public plan holds at the base is selected", async t => {
  // OBSERVED 2026-11-26: the 14:04:32Z stand_down refused W1-T4210 and W1-T4215 as reservation_absent.
  const w = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T2": record("W1-T2") });
  unreserve(w, "W1-T1");
  assert.equal(w.reservations().includes("refs/rmd-id/W1-T1"), false, "positive control: W1-T1 has no reservation ref");
  const result = await select(w, reader(w, 2, () => undefined));
  assert.equal(result.reason, undefined, String(result.reason));
  assert.deepEqual(result.selection?.refused.filter(r => r.reason === "reservation_absent"), [], "THE CLAIM: no reservation_absent refusal");
  assert.deepEqual(batchIds(result.selection), ["W1-T1", "W1-T2"], "THE CLAIM: the unreserved record is selected with the reserved one");
});

test("W1-T14993 criterion 2: invariant:reservation-still-checked — an id with no ref and absent from the public plan at the base is refused", () => {
  const refs = new Map([["refs/rmd-id/W1-T2", "a".repeat(40)]]);
  const base = { commit: "b".repeat(40), ids: new Set(["W1-T1"]) };
  assert.equal(moveReservation("W1-T3", refs, base), undefined, "THE CLAIM: neither a ref nor the base holds W1-T3, so nothing proves it");
  assert.equal(moveReservation("W1-T2", refs, base), "a".repeat(40), "a reservation ref is still the evidence when it exists");
  assert.equal(moveReservation("W1-T1", refs, base), `held-at=remudero@${"b".repeat(40)}`, "positive control: the base holds W1-T1");
});

test("W1-T14993 criterion 3: an unreserved record is copied and removed with held-at evidence, and its removal completes unchanged", async t => {
  const w = moveWorld(t, { "W1-T1": record("W1-T1") });
  unreserve(w, "W1-T1");
  const publicCommit = w.main("public");
  const copyRun = await w.run();
  assert.equal(copyRun.out.step, "copy", copyRun.lines.join("\n"));
  const copy = w.pulls.at(-1)!;
  assert.ok(copy.body.split("\n").includes(`${MOVE_RESERVATION_TRAILER} W1-T1 held-at=remudero@${publicCommit}`), `THE CLAIM: the copy names its held-at evidence: ${copy.body}`);
  w.merge(copy);
  const removeRun = await w.run();
  assert.equal(removeRun.out.step, "remove", removeRun.lines.join("\n"));
  const removal = w.pulls.at(-1)!;
  assert.match(removal.body, new RegExp(`^${MOVE_RESERVATION_TRAILER} W1-T1 held-at=remudero@[0-9a-f]{40}$`, "m"), `THE CLAIM: the removal names its held-at evidence: ${removal.body}`);
  w.merge(removal);
  const done = await w.run();
  assert.equal(done.out.step, "complete", done.lines.join("\n"));
  assert.deepEqual((done.out.completed as Array<Record<string, unknown>>).map(row => [row.id, row.reservation, row.reservationUnchanged]), [["W1-T1", null, true]],
    "THE CLAIM: the removal completes with its id still unreserved");
  assert.ok(w.holds("ops", "W1-T1") && !w.holds("public", "W1-T1"), "the record moved");
});

test("W1-T14982 criterion 1: an open pull request that only edits code a record's files lists does not own it, and the record moves", async t => {
  // OBSERVED 2026-11-26: unrelated open pull requests on shared files (src/lib/review.ts) pinned 30 open core records.
  const w = moveWorld(t, { "W1-T1": record("W1-T1", "  files:\n    - src/lib/moved-task-code.ts\n") });
  w.openPull("public", { head: "operator-fix-2", body: "fix: something else", files: ["src/lib/moved-task-code.ts"] });
  w.openPull("public", { head: "run-W1-T77-1795000000000", body: "Remudero-Task: W1-T77", files: ["src/lib/moved-task-code.ts", shard("W1-T77")] });
  const result = await select(w, reader(w, 1, () => undefined));
  assert.equal(result.reason, undefined, String(result.reason));
  assert.equal(result.selection?.outcome, "candidate");
  assert.deepEqual(batchIds(result.selection), ["W1-T1"], "THE CLAIM: a file overlap alone pins nothing");
});

test("W1-T14982 criterion 2: a record stays owned while a pull request names its task or edits its record", async t => {
  const owners: Array<[string, { head: string; body?: string; files: string[] }]> = [
    ["its record path", { head: "operator-fix-1", files: [shard("W1-T1")] }],
    ["its run branch", { head: "run-W1-T1-1795000000003", files: ["src/lib/other.ts"] }],
    ["its trailer", { head: "operator-fix-3", body: "fix: build it\n\nRemudero-Task: W1-T1", files: ["src/lib/other.ts"] }],
  ];
  for (const [rule, pr] of owners) {
    const w = moveWorld(t, { "W1-T1": record("W1-T1", "  files:\n    - src/lib/moved-task-code.ts\n"), "W1-T2": record("W1-T2") });
    w.openPull("public", pr);
    const result = await select(w, reader(w, 1, () => undefined));
    assert.equal(result.reason, undefined, `${rule}: ${String(result.reason)}`);
    assert.deepEqual(batchIds(result.selection), ["W1-T2"], `THE CLAIM: a pull request owning W1-T1 by ${rule} keeps it on core`);
  }
  // A dispatch claim or a pushed run branch owns it with no pull request at all.
  for (const ref of ["refs/rmd-dispatch/W1-T1", "refs/heads/run-W1-T1-1795000000004"]) {
    const w = moveWorld(t, { "W1-T1": record("W1-T1", "  files:\n    - src/lib/moved-task-code.ts\n"), "W1-T2": record("W1-T2") });
    w.pub.clone.git("push", "--quiet", "origin", `HEAD:${ref}`);
    const result = await select(w, reader(w, 1, () => undefined));
    assert.equal(result.reason, undefined, `${ref}: ${String(result.reason)}`);
    assert.deepEqual(batchIds(result.selection), ["W1-T2"], `THE CLAIM: ${ref} keeps W1-T1 on core`);
  }
});
