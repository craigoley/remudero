/**
 * W1-T14345: one catalog move step carries many open tasks. The mover (src/lib/plan-task-move.ts) copies a batch into
 * the ops catalog in one pull request and removes exactly that batch from the public catalog in one more, one
 * Remudero-Moved-To receipt per removed record, so the public catalog's open records reach the plan destination in tens
 * of steps instead of thousands. Every case drives the real mover over two real Git origins
 * (test/helpers/plan-move-world.ts); the REMOVE pull request it produced is read back through the author-time gate's
 * and the review's own readers (W1-T14195), so the batch shape cannot drift from the one they admit.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { MOVE_RESERVATION_TRAILER, MOVED_TO_TRAILER, withMovedFromLine } from "#src/lib/plan-task-move.js";
import type { PlanTaskMovePorts, PlanTaskMover } from "#src/lib/plan-task-move-janitor.js";
import { blobAt, moveWorld, OPS, PUBLIC, record, shard, type ModelPull, type MoveWorld } from "#test/helpers/plan-move-world.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Json = Record<string, unknown>;
const { judgeReview } = await import("#src/lib/review.js");
const { readMoverRemoval } = await import("#src/cli/commands/review.js");
const { runPlanTaskMoveTick } = await import("#src/lib/plan-task-move-janitor.js");
// Absent on a tree without the batch: undefined there, so each claim below reads red for its own reason.
const { MOVE_BATCH_BOUND } = await import("#src/lib/plan-task-migration.js") as { MOVE_BATCH_BOUND?: number };
const GATE = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "acceptance-author-gate.mjs")).href)) as {
  evaluateGate: (input: Record<string, unknown>) => { ok: boolean; defect?: string; message: string };
  moverPublicAtRange: (input: { baseSha?: string; headSha?: string; root?: string }) => unknown;
};
const LINT = { ran: true as const, label: "fixture", checked: 0, violations: [] };
const blobSha = (text: string): string => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
const blocked = (id: string, extra = "") => record(id, extra).replace("status: queued", "status: blocked");
const lines = (text: string, prefix: string) => text.split("\n").filter(line => line.startsWith(prefix));
const sorted = (ids: readonly unknown[]) => [...ids].map(String).sort();
/** The task ids a mover pull request's receipt lines name, in the order it wrote them. */
const receiptIds = (pr: ModelPull, prefix: string) => lines(pr.body, prefix).map(line => line.slice(prefix.length).trim().split(" ")[prefix === MOVED_TO_TRAILER ? 1 : 0]!);

/** The GitHub reads the review's ops half makes, answered from the ops origin the mover really wrote. */
function opsApi(w: MoveWorld): OpsCatalogApi {
  return async path => {
    const contents = /^repos\/fixture\/ops\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
    if (contents) {
      const text = blobAt(w.ops.origin.dir, `${contents[2]}:${contents[1]}`);
      if (text === undefined) throw new Error("HTTP 404");
      return { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64"), sha: blobSha(text) };
    }
    const compare = /^repos\/fixture\/ops\/compare\/([0-9a-f]{40})\.\.\.main$/.exec(path);
    if (compare) {
      const main = w.main("ops");
      if (compare[1] === main) return { status: "identical" };
      try { w.ops.origin.git("merge-base", "--is-ancestor", compare[1]!, main); return { status: "ahead" }; }
      catch (error) { void error; return { status: "diverged" }; }
    }
    throw new Error(`unexpected ops read ${path}`);
  };
}

/** The author-time gate and the review on the REMOVE pull request the mover just opened, as each reads it. */
async function gatesOn(t: TestContext, w: MoveWorld, pr: ModelPull) {
  const clone = w.pub.clone;
  clone.git("fetch", "--quiet", "origin");
  const base = w.pub.origin.git("rev-parse", "main"), head = w.pub.origin.git("rev-parse", pr.head);
  const stateDir = join(ownedFixtureDir(t, "batch-move-state").dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: OPS, kinds: ["task"] }));
  const gate = GATE.evaluateGate({ body: pr.body, headRefName: pr.head, moverPublic: GATE.moverPublicAtRange({ baseSha: base, headSha: head, root: clone.dir }) });
  const verdict = await readMoverRemoval({ headRefName: pr.head, headRefOid: head, repoDir: clone.dir, stateDir, api: opsApi(w), baseRef: base });
  const review = judgeReview([], { diff: clone.git("diff", base, head) + "\n", report: pr.body, moverRemoval: verdict, planLint: LINT });
  return { gate, verdict, review, message: clone.git("log", "-1", "--format=%B", head), status: clone.git("diff", "--name-status", base, head) };
}

/** Run the mover, assert the step it took, and return the pull request it opened. */
async function step(w: MoveWorld, expected: string, overrides: Parameters<MoveWorld["run"]>[1] = {}) {
  const before = w.pulls.length;
  const run = await w.run(true, overrides);
  assert.equal(run.out.step, expected, run.lines.join("\n"));
  assert.equal(w.pulls.length, before + 1, `one pull request per step: ${run.lines.join("\n")}`);
  return { run, pr: w.pulls.at(-1)! };
}

test("W1-T14345 criterion 1: a step's COPY pull request carries its whole batch and its REMOVE pull request removes exactly those, one Remudero-Moved-To receipt each, admitted by the gate and the review", async t => {
  const BATCH = ["W1-T1", "W1-T2", "W1-T3"];
  const originals: Record<string, string> = { "W1-T1": record("W1-T1"), "W1-T2": blocked("W1-T2"), "W1-T3": record("W1-T3") };
  const w = moveWorld(t, originals);
  const publicCommit = w.main("public");
  const { run: copyRun, pr: copy } = await step(w, "copy");
  assert.equal(copy.repository, "ops");
  assert.deepEqual(sorted(copy.files), sorted(BATCH.map(shard)), "THE CLAIM: one COPY pull request carries every task of the batch");
  assert.deepEqual(sorted(copyRun.out.ids as unknown[]), BATCH);
  assert.match(copy.head, /^plan-move-batch-\d+$/);
  assert.deepEqual(sorted(receiptIds(copy, "Remudero-Move-Copy:")), BATCH, "one copy receipt per task");
  assert.deepEqual(sorted(lines(copy.body, MOVE_RESERVATION_TRAILER).map(line => line.split(" ")[1])), BATCH);
  assert.doesNotMatch(copy.body, /^Remudero-Task:/m, "no merge credits a build");
  w.merge(copy);
  for (const id of BATCH) assert.equal(w.bytes("ops", shard(id)), withMovedFromLine(originals[id]!, id, publicCommit), `${id} lands byte for byte plus its moved_from line`);

  const { pr: removal } = await step(w, "remove");
  assert.equal(removal.repository, "public");
  assert.deepEqual(sorted(removal.files), sorted(BATCH.map(shard)), "THE CLAIM: the REMOVE pull request removes exactly the batch");
  assert.match(removal.head, /^plan-move-batch-\d+$/);
  const read = await gatesOn(t, w, removal);
  assert.deepEqual(sorted(lines(read.message, MOVED_TO_TRAILER).map(line => line.split(" ")[2])), BATCH, "each removed record leaves its receipt in the commit");
  assert.deepEqual(read.status.split("\n").map(line => line.split("\t")).sort(), BATCH.map(id => ["D", shard(id)]), "the diff is exactly their deletions");
  assert.equal(read.gate.ok, true, `the author-time gate admits the batch: ${read.gate.message}`);
  for (const id of BATCH) assert.match(read.gate.message, new RegExp(`\\b${id}\\b`));
  assert.equal(read.verdict.verified, true, `the review's two-repository read verifies every receipt: ${JSON.stringify(read.verdict)}`);
  assert.deepEqual(read.verdict.verified && sorted(read.verdict.receipts.map(r => r.id)), BATCH);
  assert.equal(read.review.state, "success", read.review.summary);

  w.merge(removal);
  const done = await w.run();
  assert.equal(done.out.step, "complete", done.lines.join("\n"));
  assert.deepEqual(sorted((done.out.completed as Json[]).map(row => row.id)), BATCH);
  assert.ok((done.out.completed as Json[]).every(row => row.reservationUnchanged === true), "every reservation ref is unchanged");
  assert.ok(BATCH.every(id => w.holds("ops", id) && !w.holds("public", id)), "all three moved in one pair of pull requests");
  assert.equal(w.pulls.length, 2);
});

test("W1-T14345 criterion 1: a batch is as large as the readers' limits allow, so forty open records drain in two steps", async t => {
  assert.equal(MOVE_BATCH_BOUND, 32, "the least of the merge-credit lookup cap (32) and the open-PR files page (100)");
  const ids = Array.from({ length: 40 }, (_, i) => `W1-T${i + 1}`);
  const w = moveWorld(t, Object.fromEntries(ids.map(id => [id, record(id)])));
  const rounds: number[] = [];
  for (let round = 0; round < 4 && ids.some(id => w.holds("public", id)); round++) {
    const { pr: copy } = await step(w, "copy");
    rounds.push(copy.files.length);
    w.merge(copy);
    const { pr: removal } = await step(w, "remove");
    assert.deepEqual(sorted(removal.files), sorted(copy.files), "the removal is exactly the copied batch");
    w.merge(removal);
  }
  assert.deepEqual(rounds, [MOVE_BATCH_BOUND, ids.length - MOVE_BATCH_BOUND!], "THE CLAIM: a full batch, then the rest");
  assert.ok(ids.every(id => w.holds("ops", id) && !w.holds("public", id)));
});

/** Seed the ops catalog with `count` records in one commit dated `at`. */
function padOps(w: MoveWorld, count: number, at: string): void {
  const dir = w.ops.clone.dir;
  const run = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  run("fetch", "--quiet", "origin");
  run("checkout", "--quiet", "-B", "main", "origin/main");
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, shard(`W1-T${9000 + i}`)), record(`W1-T${9000 + i}`));
  run("add", "plan/tasks.d");
  run("commit", "--quiet", "-m", "pad the ops catalog");
  run("push", "--quiet", "origin", "main");
}

test("W1-T14345 criterion 1: past the reader's baseline a batch carries every open task, however much the catalog grew that day", async t => {
  const ids = ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5"];
  const w = moveWorld(t, Object.fromEntries(ids.map(id => [id, record(id)])));
  padOps(w, 498, new Date().toISOString());
  // The ops catalog grew 498 shards today; the copy takes it past the 500-shard baseline. The catalog's growth is not
  // bounded, so nothing stops the batch short of the open tasks it has.
  const { pr: copy } = await step(w, "copy");
  assert.deepEqual(sorted(copy.files), sorted(ids.map(shard)), "THE CLAIM: the batch carries every open task past the baseline");
  w.merge(copy);
  w.merge((await step(w, "remove")).pr);
  const done = await w.run();
  assert.equal(done.out.step, "complete", done.lines.join("\n"));
  assert.ok(ids.every(id => w.holds("ops", id) && !w.holds("public", id)), "all five moved the same day in one step");
});

/** The janitor's ports over one move world: the switch on, every gate open, each move the real verb at both mains. */
function janitorOver(w: MoveWorld): PlanTaskMover {
  const merged = new Map<number, string>();
  const ports: PlanTaskMovePorts = {
    readSwitch: () => ({ move: { outcome: "on", repository: OPS, checkoutDir: "" }, dispatch: { outcome: "on", repository: OPS, checkoutDir: "" } }),
    readOpsCatalog: () => "ok",
    readHeads: async ops => ({ ops, publicRepository: PUBLIC, publicCommit: w.main("public"), opsCommit: w.main("ops"),
      key: `${w.sides.public.origin.git("for-each-ref")}\n${w.sides.ops.origin.git("for-each-ref")}` }),
    move: async (_pin, apply) => { const run = await w.run(apply); return { status: run.status, out: run.out }; },
    readPull: async (_pin, _side, number) => {
      const pr = w.pulls.find(row => row.number === number)!;
      if (pr.state === "MERGED" && !merged.has(number)) merged.set(number, w.main(pr.repository));
      return pr.state === "MERGED" ? { state: "MERGED", mergeCommit: merged.get(number)! } : { state: pr.state };
    },
    onMain: async () => true,
  };
  return { ports, memory: {} };
}

test("W1-T14345 criterion 2: the janitor picks open records first, oldest filing first, and never a merged or done record", async t => {
  // Filed in this order: W1-T5 with the history (merged W1-T7 and done W1-T8 beside it), then W1-T9 (blocked), then
  // W1-T2. Neither id order nor the reverse dispatch order the preview read before is the filing order.
  const w = moveWorld(t, { "W1-T5": record("W1-T5"), "W1-T7": record("W1-T7").replace("status: queued", "status: merged"),
    "W1-T8": record("W1-T8").replace("status: queued", "status: done"), "W1-T6": record("W1-T6").replace("verify: auto", "verify: human") });
  for (const [id, text] of [["W1-T9", blocked("W1-T9")], ["W1-T2", record("W1-T2")]] as const) {
    const main = w.commitTo("public", { [shard(id)]: text }, `file ${id}`);
    w.pub.origin.git("update-ref", `refs/rmd-id/${id}`, main);
  }
  const dry = await w.run(false);
  const rows: Array<{ step: string; data: Json }> = [];
  const mover = janitorOver(w);
  const outcome = await runPlanTaskMoveTick({ opsDispatchHold: undefined, log: (step, data) => { rows.push({ step, data }); } }, mover);
  assert.deepEqual(outcome, { outcome: "step", step: "copy" }, JSON.stringify(rows));
  const [copy] = w.pulls;
  assert.deepEqual(receiptIds(copy!, "Remudero-Move-Copy:"), ["W1-T5", "W1-T6", "W1-T9", "W1-T2"], "THE CLAIM: open records (a verify:human one included, W1-T14425), oldest filing first");
  assert.deepEqual(rows.find(row => row.step === "plan.move.janitor_step")?.data.task_ids, ["W1-T5", "W1-T6", "W1-T9", "W1-T2"], "the step row names every task it carried");
  for (const id of ["W1-T7", "W1-T8"]) assert.ok(!copy!.files.includes(shard(id)), `${id} is history: never picked`);
  // W1-T14425 replaces the W1-T14345 contract that kept a verify:human record public: its release survives the move (W1-T14408).
  assert.ok(copy!.files.includes(shard("W1-T6")), "a verify:human record is carried like any other open record");
  assert.equal(dry.out.step, "copy");
  assert.deepEqual(dry.out.ids, ["W1-T5", "W1-T6", "W1-T9", "W1-T2"], "the dry run admits the same batch, in the same order");

  // The whole catalog drained of its open records, the merged and done ones stay public, through the janitor alone.
  for (let round = 0; round < 6 && w.pulls.some(pr => pr.state === "OPEN"); round++) {
    w.merge(w.pulls.find(pr => pr.state === "OPEN")!);
    await runPlanTaskMoveTick({ opsDispatchHold: undefined, log: () => undefined }, mover);
  }
  assert.ok(["W1-T5", "W1-T6", "W1-T9", "W1-T2"].every(id => w.holds("ops", id) && !w.holds("public", id)));
  assert.ok(["W1-T7", "W1-T8"].every(id => w.holds("public", id) && !w.holds("ops", id)), "history stays public");
  const rest = await w.run(false);
  assert.equal(rest.out.step, "complete");
});

test("W1-T14345 criterion 3: a claimed task or one with an open pull request is left out of the batch rather than holding it", async t => {
  const ids = ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5"];
  const w = moveWorld(t, Object.fromEntries(ids.map(id => [id, record(id)])));
  w.pub.origin.git("update-ref", "refs/rmd-dispatch/W1-T2", w.main("public"));
  w.openPull("public", { head: "run-W1-T3-1795000000001" });
  const { pr: copy } = await step(w, "copy");
  assert.deepEqual(sorted(copy.files), ["W1-T1", "W1-T4", "W1-T5"].map(shard), "THE CLAIM: the owned tasks are left out, the rest carried");
  w.merge(copy);
  // A member claimed after its copy landed is rolled back alone; the rest are then removed together.
  w.pub.origin.git("update-ref", "refs/rmd-dispatch/W1-T4", w.main("public"));
  const { run: back, pr: rollback } = await step(w, "rollback");
  assert.deepEqual([rollback.repository, rollback.files], ["ops", [shard("W1-T4")]]);
  assert.equal(back.out.reason, "claimed");
  w.merge(rollback);
  const { pr: removal } = await step(w, "remove");
  assert.deepEqual(sorted(removal.files), ["W1-T1", "W1-T5"].map(shard));
  // A removal closed unmerged leaves the batch pending: the next step removes the same batch again.
  w.close(removal);
  const { pr: retry } = await step(w, "remove");
  assert.deepEqual(sorted(retry.files), ["W1-T1", "W1-T5"].map(shard));
  w.merge(retry);
  assert.ok(["W1-T1", "W1-T5"].every(id => w.holds("ops", id) && !w.holds("public", id)));
  assert.ok(["W1-T2", "W1-T3", "W1-T4"].every(id => w.holds("public", id) && !w.holds("ops", id)), "every owned task has only its public copy");
});

test("W1-T14345 criterion 3: a step interrupted after COPY converges for the whole batch, by REMOVE, ROLLBACK or RESTORE, and a held member is left out", async t => {
  const BATCH = ["W1-T1", "W1-T2", "W1-T3"];
  const originals = Object.fromEntries(BATCH.map(id => [id, record(id)]));
  const copied = async () => { const w = moveWorld(t, originals); const { pr } = await step(w, "copy"); w.merge(pr); return w; };

  // ROLLBACK: every public copy amended after the copy landed: one ops pull request removes every ops copy.
  const amended = await copied();
  amended.commitTo("public", Object.fromEntries(BATCH.map(id => [shard(id), originals[id]!.replace("priority: 1", "priority: 2")])), "amend all three");
  const { pr: rollback } = await step(amended, "rollback");
  assert.deepEqual([rollback.repository, sorted(rollback.files)], ["ops", BATCH.map(shard)], "THE CLAIM: one rollback for the whole batch");
  assert.deepEqual(sorted(receiptIds(rollback, "Remudero-Move-Rollback:")), BATCH);
  amended.merge(rollback);
  assert.ok(BATCH.every(id => amended.holds("public", id) && !amended.holds("ops", id)));

  // RESTORE: the removal landed, then every ops copy was lost: one public pull request restores every original.
  const lost = await copied();
  lost.merge((await step(lost, "remove")).pr);
  lost.commitTo("ops", Object.fromEntries(BATCH.map(id => [shard(id), null])), "lose the ops copies");
  const { pr: restore } = await step(lost, "restore");
  assert.deepEqual([restore.repository, sorted(restore.files)], ["public", BATCH.map(shard)], "THE CLAIM: one restore for the whole batch");
  lost.merge(restore);
  for (const id of BATCH) assert.equal(lost.bytes("public", shard(id)), originals[id], `${id} is restored byte for byte`);

  // HELD: one ops copy edited after it landed: that member is left out and the rest are removed; then it alone holds.
  const edited = await copied();
  edited.commitTo("ops", { [shard("W1-T2")]: edited.bytes("ops", shard("W1-T2"))!.replace("priority: 1", "priority: 3") }, "edit one ops copy");
  const { pr: removal } = await step(edited, "remove");
  assert.deepEqual(sorted(removal.files), ["W1-T1", "W1-T3"].map(shard), "THE CLAIM: the held member does not hold the batch");
  edited.merge(removal);
  const held = await edited.run();
  assert.deepEqual([held.out.step, held.out.id, held.out.reason], ["held", "W1-T2", "ops_copy_differs"], "and no new pick while it is pending");
});

test("W1-T14345 criterion 4: invariant:a-one-task-move-is-unchanged — a batch of one writes exactly origin/main's branches, files, receipts and pull requests", async t => {
  const ID = "W1-T1", ORIGINAL = record(ID, "  files: [src/lib/moved.ts]\n");
  const w = moveWorld(t, { [ID]: ORIGINAL });
  const publicCommit = w.main("public"), opsBase = w.main("ops"), reservation = w.pub.origin.git("rev-parse", `refs/rmd-id/${ID}`);
  const blob = w.pub.origin.git("rev-parse", `main:${shard(ID)}`);
  const { run: copyRun, pr: copy } = await step(w, "copy");
  const copyBody = `The public record, byte for byte, plus one moved_from line after its id line.\n\nRemudero-Move-Copy: ${ID} path=${shard(ID)} blob=${blob} from=remudero@${publicCommit}\n${MOVE_RESERVATION_TRAILER} ${ID} ${reservation}\n`;
  assert.deepEqual({ repository: copy.repository, head: /^plan-move-W1-T1-\d+$/.test(copy.head), title: copy.title, body: copy.body, files: copy.files, base: copy.base },
    { repository: "ops", head: true, title: `chore(plan): move ${ID} into the ops catalog`, body: copyBody, files: [shard(ID)], base: "main" });
  assert.equal(w.sides.ops.origin.git("log", "-1", "--format=%B", copy.head), `chore(plan): move ${ID} into the ops catalog\n\n${copyBody}`.trim());
  assert.equal(w.sides.ops.origin.git("rev-parse", `${copy.head}^`), opsBase, "one commit on the pinned ops main");
  assert.deepEqual(Object.keys(copyRun.out).sort(), ["applied", "branch", "commit", "evidence", "id", "opsCommit", "publicCommit", "pullRequest", "reason", "repository", "step", "url"]);
  assert.deepEqual(Object.keys(copyRun.out.evidence as Json).sort(), ["completed", "reservation", "sourceBlob", "sourceCommit"]);
  assert.deepEqual(Object.keys(w.ledger.at(-1)!).sort(), ["commit", "move_step", "ops_commit", "outcome", "preflight_unreadable", "public_commit", "pull_request", "repository", "run_id", "step", "task_id"]);
  const opsCommit = w.merge(copy);
  const { pr: removal } = await step(w, "remove");
  const removeBody = `The ops catalog holds this record byte for byte plus its moved_from line.\n\n${MOVED_TO_TRAILER} ${OPS}@${opsCommit} ${ID} path=${shard(ID)} blob=${blob}\n${MOVE_RESERVATION_TRAILER} ${ID} ${reservation}\n`;
  assert.deepEqual({ repository: removal.repository, head: /^plan-move-W1-T1-\d+$/.test(removal.head), title: removal.title, body: removal.body, files: removal.files },
    { repository: "public", head: true, title: `chore(plan): move ${ID} to the ops catalog`, body: removeBody, files: [shard(ID)] });
  const read = await gatesOn(t, w, removal);
  assert.equal(read.message, `chore(plan): move ${ID} to the ops catalog\n\n${removeBody}`.trim());
  assert.equal(read.gate.ok, true, read.gate.message);
  assert.equal(read.verdict.verified, true, JSON.stringify(read.verdict));
  w.merge(removal);
  // ROLLBACK and RESTORE of one task, too.
  const owned = moveWorld(t, { [ID]: ORIGINAL });
  owned.merge((await step(owned, "copy")).pr);
  owned.pub.origin.git("update-ref", `refs/rmd-dispatch/${ID}`, owned.main("public"));
  const { pr: rollback } = await step(owned, "rollback");
  assert.deepEqual({ head: /^plan-move-W1-T1-\d+$/.test(rollback.head), title: rollback.title, body: rollback.body, files: rollback.files },
    { head: true, title: `chore(plan): roll back the move of ${ID} into the ops catalog`, files: [shard(ID)],
      body: `The public copy is claimed, so it stays and this ops copy is removed.\n\nRemudero-Move-Rollback: ${ID} path=${shard(ID)} reason=claimed\n` });
  const lost = moveWorld(t, { [ID]: ORIGINAL });
  lost.merge((await step(lost, "copy")).pr);
  const removalCommit = lost.merge((await step(lost, "remove")).pr);
  lost.commitTo("ops", { [shard(ID)]: null }, "lose the ops copy");
  const { pr: restore } = await step(lost, "restore");
  assert.deepEqual({ head: /^plan-move-W1-T1-\d+$/.test(restore.head), title: restore.title, body: restore.body, files: restore.files },
    { head: true, title: `chore(plan): restore ${ID} after an interrupted move`, files: [shard(ID)],
      body: `Neither catalog holds this record, and public history names its mover removal.\n\nRemudero-Move-Restored: ${ID} path=${shard(ID)} blob=${blob} removal=${removalCommit}\n` });
});
