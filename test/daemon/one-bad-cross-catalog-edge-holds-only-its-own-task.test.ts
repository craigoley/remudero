/**
 * W1-T13749 — ONE BAD CROSS-CATALOG EDGE HOLDS ONLY ITS OWN TASK.
 *
 * composeSecondaryPlan used to answer a whole-composition refusal at the first bad edge: a shared id without a valid
 * moved_from, a public task naming an ops id, or an ops depends_on neither catalog holds. The daemon then held every
 * ops task, and `rmd approve` refused every ops release, for one record's edge. Now the bad task and its dependants
 * are held, each with its reason and the edge, and every other task composes. `rmd approve` reads the public plan at
 * the checkout's origin/main, the ref the daemon's plan reloader reads, instead of the boot's working tree.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon, type DaemonDeps, type OpsTaskDispatchRead } from "#src/lib/daemon.js";
import { fixedClock } from "#src/lib/clock.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { runnableCandidates } from "#src/lib/drain.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { loadPlan, parseTasksFromYaml, type Plan } from "#src/lib/plan.js";
import * as lookup from "#src/lib/task-lookup.js";
import { composeSecondaryPlan, findReleasePlanInCatalogs } from "#src/lib/task-lookup.js";
import { gitRepo, originWithClone, type GitRepo } from "#test/helpers/git-repo.js";

const SOURCE = "b".repeat(40);
const REPOSITORY = "fixture-private/ops";
const MISSING = "W1-T9";
const BAD_EDGE = "invalid_cross_catalog_dependency";

const record = (id: string, depends: string[] = [], priority = 1, extra = ""): string =>
  `- id: ${id}\n${extra}  title: one bad edge fixture ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n` +
  `  priority: ${priority}\n  depends_on: [${depends.join(", ")}]\n`;
const planOf = (text: string, label: string): Plan => {
  const tasks = parseTasksFromYaml(text, `${label}.yaml`);
  return { tasks, byId: new Map(tasks.map(task => [task.id, task])) };
};
const ids = (plan: Plan): string[] => plan.tasks.map(task => task.id);
const heldOf = (composition: ReturnType<typeof composeSecondaryPlan>): Record<string, unknown> => {
  assert.equal(composition.outcome, "ok", `the composition answers ok: ${JSON.stringify(composition)}`);
  const held = (composition as { held?: ReadonlyMap<string, unknown> }).held;
  assert.ok(held instanceof Map, "the composition carries a held map");
  return Object.fromEntries(held);
};

// One ops task naming an id neither catalog holds, its dependants (directly and through another), and sound tasks.
const PUBLIC_TEXT = record("PUB-1", [], 5) + record("PUB-2", [], 6);
const SOUND_OPS = record("OPS-GOOD", [], 1) + record("OPS-ON-PUBLIC", ["PUB-1"], 2) + record("OPS-ON-GOOD", ["OPS-GOOD"], 3);
const BAD_OPS = record("OPS-BAD", [MISSING], 0) + record("OPS-CHILD", ["OPS-BAD"], 0) + record("OPS-GRANDCHILD", ["OPS-CHILD"], 0);
const OPS_TEXT = BAD_OPS + SOUND_OPS;
const badHold = { reason: BAD_EDGE, task: "OPS-BAD", dependsOn: MISSING };

test("W1-T13749 criterion 1: one ops task depending on an id neither catalog holds is held with its dependants, and every other ops task composes", () => {
  const composition = composeSecondaryPlan(planOf(PUBLIC_TEXT, "public"), planOf(OPS_TEXT, "ops"));
  assert.deepEqual(heldOf(composition), { "OPS-BAD": badHold, "OPS-CHILD": badHold, "OPS-GRANDCHILD": badHold },
    "the task, its dependant and the dependant's dependant, each naming the reason and the missing id");
  if (composition.outcome !== "ok") return;
  for (const id of ["OPS-BAD", "OPS-CHILD", "OPS-GRANDCHILD"]) {
    assert.equal(composition.plan.byId.has(id), false, `${id} is absent from the composed plan`);
    assert.equal(composition.secondaryIds.has(id), false, `${id} is absent from secondaryIds`);
  }
  // Every other ops task composes as it does on origin/main with the bad records absent.
  const reference = composeSecondaryPlan(planOf(PUBLIC_TEXT, "public"), planOf(SOUND_OPS, "ops"));
  assert.equal(reference.outcome, "ok");
  if (reference.outcome !== "ok") return;
  assert.deepEqual(ids(composition.plan), ids(reference.plan));
  assert.deepEqual(ids(composition.plan), ["PUB-1", "PUB-2", "OPS-GOOD", "OPS-ON-PUBLIC", "OPS-ON-GOOD"]);
  assert.deepEqual([...composition.secondaryIds], [...reference.secondaryIds]);
  assert.deepEqual([...composition.plan.byId.values()], [...reference.plan.byId.values()]);
  assert.deepEqual([...composition.pendingMoveIds], []);
});

// A shared id with no valid moved_from, a dependant of it in each catalog, a public task naming an ops id, a pending move.
const DUP_PUBLIC = record("W1-T1") + record("W1-T2") + record("PUB-DEP", ["W1-T2"]) + record("PUB-REV", ["OPS-GOOD"]) +
  record("PUB-REV-CHILD", ["PUB-REV"]) + record("PUB-3");
const dupOps = (movedLine: string): string => record("W1-T1", [], 1, movedLine) + record("W1-T2") +
  record("OPS-DUP-CHILD", ["W1-T2"]) + record("OPS-GOOD");
const DUP_OPS = dupOps(`  moved_from: remudero@${SOURCE}\n`);

test("W1-T13749 criterion 2: a duplicate without moved_from holds both copies and their dependants, a public task naming an ops id is held, and a pending move stays a pending move", () => {
  const composition = composeSecondaryPlan(planOf(DUP_PUBLIC, "public"), planOf(DUP_OPS, "ops"));
  const duplicate = { reason: "duplicate_task_id", task: "W1-T2" };
  const reversed = { reason: BAD_EDGE, task: "PUB-REV", dependsOn: "OPS-GOOD" };
  assert.deepEqual(heldOf(composition), {
    "W1-T2": duplicate, "PUB-DEP": duplicate, "OPS-DUP-CHILD": duplicate, "PUB-REV": reversed, "PUB-REV-CHILD": reversed,
  });
  if (composition.outcome !== "ok") return;
  // Neither copy of the duplicate composes; the pending move is in neither catalog, as on origin/main.
  assert.deepEqual(ids(composition.plan), ["PUB-3", "OPS-GOOD"]);
  assert.deepEqual([...composition.secondaryIds], ["OPS-GOOD"]);
  assert.deepEqual([...composition.pendingMoveIds], ["W1-T1"]);
  // A moved_from naming no public commit is no pending move: that shared id is a held duplicate too.
  for (const line of ["", "  moved_from: remudero@abc\n", `  moved_from: elsewhere@${SOURCE}\n`]) {
    const refused = composeSecondaryPlan(planOf(DUP_PUBLIC, "public"), planOf(dupOps(line), "ops"));
    const held = heldOf(refused);
    assert.deepEqual(held["W1-T1"], { reason: "duplicate_task_id", task: "W1-T1" }, `moved_from line ${JSON.stringify(line)}`);
    if (refused.outcome === "ok") assert.deepEqual([...refused.pendingMoveIds], [], `moved_from line ${JSON.stringify(line)}`);
  }
});

// ── the daemon's ops dispatch ────────────────────────────────────────────────────────────────────
interface Dispatched { ran: string[]; rows: Array<{ step: string; data: Record<string, unknown> }> }

/** runDaemon over a public plan and a selected ops plan, both fixed; `reload` may hand the loop a new public plan. */
async function dispatched(publicPlan: Plan, opsPlan: Plan, opts: { max: number; merged?: string[]; reload?: (ran: readonly string[]) => Plan | null; throwOn?: string[] }): Promise<Dispatched> {
  const clock = fixedClock(Date.parse("2026-01-01T00:00:00Z"));
  const merged = new Set<string>(opts.merged ?? []), ran: string[] = [], rows: Dispatched["rows"] = [];
  let idle = 0;
  const read = (): OpsTaskDispatchRead => ({ outcome: "selected", publicCommit: "a".repeat(40),
    source: { outcome: "ok", plan: opsPlan, opsCommit: "b".repeat(40), identityDigest: "c".repeat(64) } });
  const deps: DaemonDeps = {
    refreshMerged: () => id => merged.has(id), targetRepo: "remudero",
    runOne: async id => { ran.push(id); merged.add(id); return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }; },
    checkPause: () => undefined,
    // Nothing runnable is left once the sound tasks ran: a bounded number of idle passes ends the loop.
    checkStop: () => idle > 25 ? "fixture stop" : undefined,
    sleep: async () => { idle++; }, now: clock.date, bootCheckoutBlocked: "",
    memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), heapUsed: () => 1, setFlags: () => {} }),
    heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
    log: (step, data = {}) => { rows.push({ step, data }); if (opts.throwOn?.includes(step)) throw new Error("fixture diagnostic failure"); },
    readOpsTaskDispatch: read,
    ...(opts.reload ? { reloadPlan: async () => opts.reload!(ran) } : {}),
  };
  await runDaemon(publicPlan, deps, { max: opts.max, laneCount: 1 });
  return { ran, rows };
}
const rowsOf = (run: Dispatched, step: string) => run.rows.filter(row => row.step === step);

test("W1-T13749 criterion 3: the daemon dispatches the sound ops task, never the held one, writes one hold row while it stays held and one cleared row when a reload brings the missing id", async () => {
  const publicPlan = planOf(PUBLIC_TEXT, "public");
  const opsPlan = planOf(record("OPS-BAD", [MISSING], 0) + record("OPS-GOOD", [], 1), "ops");
  const healed = planOf(PUBLIC_TEXT + record(MISSING, [], 9), "public-reloaded");
  let reloadedAt: number | undefined;
  const run = await dispatched(publicPlan, opsPlan, {
    max: 4, merged: [MISSING],
    // The reload that brings the missing id comes only after every sound task ran with the edge still bad.
    reload: ran => (reloadedAt === undefined && ran.length >= 3 ? (reloadedAt = ran.length, healed) : null),
  });
  assert.ok(run.ran.includes("OPS-GOOD"), `the sound ops task is dispatched: ${JSON.stringify(run.ran)}`);
  assert.deepEqual(run.ran.slice(0, 3).sort(), ["OPS-GOOD", "PUB-1", "PUB-2"], "the held task never ran before the reload");
  assert.equal(reloadedAt, 3, "positive control: the reload happened, after three sound tasks");
  assert.deepEqual(rowsOf(run, "dispatch.ops_catalog_held"), [], "no whole-catalog hold");
  const held = rowsOf(run, "dispatch.ops_task_held");
  assert.equal(held.length, 1, `an unchanged hold writes one row: ${JSON.stringify(held)}`);
  assert.deepEqual(held[0]!.data, { task: "OPS-BAD", outcome: BAD_EDGE, edge: `OPS-BAD -> ${MISSING}` });
  const cleared = rowsOf(run, "dispatch.ops_task_hold_cleared");
  assert.deepEqual(cleared.map(row => row.data), [{ task: "OPS-BAD" }], "one cleared row when the reload brings the id");
  const order = run.rows.map(row => row.step);
  assert.ok(order.indexOf("daemon.plan_reloaded") < order.indexOf("dispatch.ops_task_hold_cleared"), "the hold clears on the tick after the reload");
  assert.deepEqual(run.ran.slice(3), ["OPS-BAD"], "the next dispatch composes and runs the task the reload healed");
});

test("W1-T13749 criterion 3: a hold or cleared row that fails to write never dispatches the held task nor stops the sound one", async () => {
  const opsPlan = planOf(record("OPS-BAD", [MISSING], 0) + record("OPS-GOOD", [], 1), "ops");
  const healed = planOf(PUBLIC_TEXT + record(MISSING, [], 9), "public-reloaded");
  let reloaded = false;
  const run = await dispatched(planOf(PUBLIC_TEXT, "public"), opsPlan, {
    max: 4, merged: [MISSING], throwOn: ["dispatch.ops_task_held", "dispatch.ops_task_hold_cleared"],
    reload: ran => (!reloaded && ran.length >= 3 ? (reloaded = true, healed) : null),
  });
  assert.deepEqual(run.ran.slice(0, 3).sort(), ["OPS-GOOD", "PUB-1", "PUB-2"], JSON.stringify(run.ran));
  assert.equal(rowsOf(run, "dispatch.ops_task_held").length, 1, "the failed hold row is still written once, not retried each tick");
  assert.equal(rowsOf(run, "dispatch.ops_task_hold_cleared").length, 1, "positive control: the cleared row was attempted");
  assert.deepEqual(run.ran.slice(3), ["OPS-BAD"], "the healed task composes once its edge is valid");
});

// ── the release plan ─────────────────────────────────────────────────────────────────────────────
/** A state directory naming the ops repository, and that repository's read-only routes over `text`. */
function opsCatalog(t: TestContext, text: string): { stateDir: string; api: OpsCatalogApi } {
  const root = mkdtempSync(join(tmpdir(), "rmd-one-bad-edge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: REPOSITORY, kinds: [] }));
  const hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text), tree = hash(commit + "root"), planTree = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`);
  const api: OpsCatalogApi = async path => {
    const base = `repos/${REPOSITORY}`;
    if (path === base) return { id: 42, full_name: REPOSITORY, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${planTree}`) return { sha: planTree, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${base}/git/blobs/${blob}`, "only pinned read-only fixture routes may run");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  return { stateDir, api };
}

test("W1-T13749 criterion 4: findReleasePlanInCatalogs answers found for the sound ops task from the composed plan, and held with the reason and the edge for the held one", async t => {
  const fx = opsCatalog(t, OPS_TEXT), publicPlan = planOf(PUBLIC_TEXT, "public");
  const found = await findReleasePlanInCatalogs("OPS-GOOD", publicPlan, fx);
  assert.equal(found.outcome, "found", JSON.stringify(found));
  if (found.outcome !== "found") return;
  assert.equal(found.catalog, "ops");
  const composed = composeSecondaryPlan(publicPlan, planOf(OPS_TEXT, "ops"));
  assert.equal(composed.outcome, "ok");
  if (composed.outcome !== "ok") return;
  assert.deepEqual(ids(found.plan), ids(composed.plan), "the plan the tick composes");
  // The record exactly as ops main's plan/tasks.yaml parses: the release pins the bytes the tick reads.
  assert.deepEqual(found.plan.byId.get("OPS-GOOD"), planOf(OPS_TEXT, "tasks").byId.get("OPS-GOOD"), "its record from ops main");
  for (const id of ["OPS-BAD", "OPS-CHILD", "OPS-GRANDCHILD"]) {
    const held = await findReleasePlanInCatalogs(id, publicPlan, fx);
    assert.deepEqual(held, { outcome: "held", hold: badHold }, `${id} is held by the edge, never unreadable`);
  }
});

// ── the public plan `rmd approve` composes against ───────────────────────────────────────────────
/** The shared origin-and-clone fixture with `before` on main; then origin/main moves to `after` and the clone's working
 *  tree is detached at the older commit, the shape of the host's checkout between boots. */
function detachedBehindOrigin(t: TestContext, before: string, after: string): GitRepo {
  const parent = mkdtempSync(join(tmpdir(), "rmd-one-bad-edge-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const { clone } = originWithClone(join(parent, "checkout"), { scope: t, seed: { "plan/tasks.yaml": before } });
  writeFileSync(join(clone.dir, "plan", "tasks.yaml"), after);
  clone.git("commit", "-qam", "fixture plan moves on");
  clone.git("push", "-q", "origin", "HEAD:refs/heads/main");
  clone.git("fetch", "-q", "origin");
  clone.git("checkout", "-q", "--detach", "HEAD~1");
  return clone;
}

test("W1-T13749 criterion 5: readReleasePublicPlan reads the checkout's origin/main, so an ops task depending on a public id filed after the detached commit composes and is released", async t => {
  const { readReleasePublicPlan, findApproveReleasePlan } = lookup;
  assert.equal(typeof readReleasePublicPlan, "function", "src/lib/task-lookup.ts exports readReleasePublicPlan");
  const checkout = detachedBehindOrigin(t, PUBLIC_TEXT, PUBLIC_TEXT + record(MISSING, [], 9));
  const workingTree = loadPlan(join(checkout.dir, "plan", "tasks.yaml"));
  assert.equal(workingTree.byId.has(MISSING), false, "control: the detached working tree predates the public id");
  const fx = opsCatalog(t, OPS_TEXT);
  assert.equal((await findReleasePlanInCatalogs("OPS-BAD", workingTree, fx)).outcome, "held", "control: the working tree's plan holds the task");

  const read = await readReleasePublicPlan(checkout.dir);
  assert.equal(read.read, "origin/main");
  assert.equal(read.plan.byId.has(MISSING), true, "origin/main holds the public id the ops edge names");
  const released = await findApproveReleasePlan("OPS-BAD", workingTree, () => readReleasePublicPlan(checkout.dir), fx);
  assert.equal(released?.outcome, "found", JSON.stringify(released));
  if (released?.outcome === "found") {
    assert.equal(released.catalog, "ops");
    assert.equal(released.plan.byId.has("OPS-BAD"), true, "the task composes against origin/main and is released");
  }

  // With that ref unreadable, the working-tree plan is read, and the answer says so.
  const bare = gitRepo({ kind: "one-bad-edge-no-origin", scope: t });
  mkdirSync(join(bare.dir, "plan"));
  writeFileSync(join(bare.dir, "plan", "tasks.yaml"), PUBLIC_TEXT);
  const fallback = await readReleasePublicPlan(bare.dir);
  assert.equal(fallback.read, "working_tree");
  assert.equal(typeof (fallback as { reason?: unknown }).reason, "string", "the fallback names why");
  assert.deepEqual(ids(fallback.plan), ["PUB-1", "PUB-2"]);
});

test("W1-T13749 criterion 6: approve's release plan resolves a working-tree id origin/main no longer holds through the catalogs, and answers held for a held ops task", async t => {
  const { readReleasePublicPlan, findApproveReleasePlan } = lookup;
  const moved = record("W1-T7", [], 4);
  const checkout = detachedBehindOrigin(t, PUBLIC_TEXT + moved, PUBLIC_TEXT);
  const workingTree = loadPlan(join(checkout.dir, "plan", "tasks.yaml"));
  assert.equal(workingTree.byId.has("W1-T7"), true, "control: the boot's working tree still holds the moved id");
  const fx = opsCatalog(t, record("W1-T7", [], 4, `  moved_from: remudero@${SOURCE}\n`) + OPS_TEXT);
  const readPublic = () => readReleasePublicPlan(checkout.dir);
  const movedAnswer = await findApproveReleasePlan("W1-T7", workingTree, readPublic, fx);
  assert.equal(movedAnswer?.outcome, "found", JSON.stringify(movedAnswer));
  if (movedAnswer?.outcome === "found") assert.equal(movedAnswer.catalog, "ops", "a moved id is released from the catalog that holds it now");
  assert.equal(await findApproveReleasePlan("PUB-1", workingTree, readPublic, fx), undefined, "a public id main still holds keeps the local plan");
  assert.deepEqual(await findApproveReleasePlan("OPS-CHILD", workingTree, readPublic, fx), { outcome: "held", hold: badHold });
});

// ── the invariants, across every fixture ─────────────────────────────────────────────────────────
interface World { name: string; publicText: string; opsText: string; held: string[]; clean: { publicText: string; opsText: string } }
const WORLDS: World[] = [
  { name: "a dangling ops edge", publicText: PUBLIC_TEXT, opsText: OPS_TEXT, held: ["OPS-BAD", "OPS-CHILD", "OPS-GRANDCHILD"],
    clean: { publicText: PUBLIC_TEXT, opsText: OPS_TEXT.replace(`depends_on: [${MISSING}]`, "depends_on: []") } },
  { name: "a duplicate without moved_from", publicText: PUBLIC_TEXT, opsText: record("PUB-2", [], 0) + record("OPS-DUP-CHILD", ["PUB-2"], 0) + SOUND_OPS,
    held: ["PUB-2", "OPS-DUP-CHILD"], clean: { publicText: PUBLIC_TEXT, opsText: record("OPS-DUP-CHILD", ["PUB-2"], 0) + SOUND_OPS } },
  { name: "a public task naming an ops id", publicText: PUBLIC_TEXT + record("PUB-REV", ["OPS-GOOD"], 4) + record("PUB-REV-CHILD", ["PUB-REV"], 4),
    opsText: SOUND_OPS, held: ["PUB-REV", "PUB-REV-CHILD"],
    clean: { publicText: PUBLIC_TEXT + record("PUB-REV", [], 4) + record("PUB-REV-CHILD", ["PUB-REV"], 4), opsText: SOUND_OPS } },
  { name: "no bad edge", publicText: PUBLIC_TEXT, opsText: SOUND_OPS, held: [], clean: { publicText: PUBLIC_TEXT, opsText: SOUND_OPS } },
];
const NONE_MERGED = () => false;

interface Observed { composed: Plan; candidates: Set<string>; ran: Set<string>; releases: Map<string, string> }
async function observe(t: TestContext, publicText: string, opsText: string): Promise<Observed> {
  const publicPlan = planOf(publicText, "public"), opsPlan = planOf(opsText, "ops");
  const composition = composeSecondaryPlan(publicPlan, opsPlan);
  heldOf(composition);
  if (composition.outcome !== "ok") throw new Error("unreachable");
  const candidates = new Set(runnableCandidates(composition.plan, NONE_MERGED, 50).map(task => task.id));
  const run = await dispatched(publicPlan, opsPlan, { max: 12 });
  const fx = opsCatalog(t, opsText), releases = new Map<string, string>();
  for (const task of opsPlan.tasks) {
    if (publicPlan.byId.has(task.id)) continue; // a public record keeps the public plan's release path
    const answer = await findReleasePlanInCatalogs(task.id, publicPlan, fx);
    releases.set(task.id, answer.outcome === "found" ? `found:${JSON.stringify(answer.plan.byId.get(task.id))}` : answer.outcome);
  }
  return { composed: composition.plan, candidates, ran: new Set(run.ran), releases };
}

test("W1-T13749 criterion 8: invariant no-task-runs-on-its-own-invalid-edge — no held task or dependant composes, is a candidate, starts or is released, and a malformed snapshot still holds the whole catalog", async t => {
  for (const world of WORLDS) {
    const seen = await observe(t, world.publicText, world.opsText);
    assert.deepEqual(Object.keys(heldOf(composeSecondaryPlan(planOf(world.publicText, "public"), planOf(world.opsText, "ops")))).sort(),
      [...world.held].sort(), `${world.name}: the held set`);
    for (const id of world.held) {
      assert.equal(seen.composed.byId.has(id), false, `${world.name}: ${id} is not in the composed plan`);
      assert.equal(seen.candidates.has(id), false, `${world.name}: ${id} is not a dispatch candidate`);
      assert.equal(seen.ran.has(id), false, `${world.name}: ${id} never starts a lane`);
      if (seen.releases.has(id)) assert.equal(seen.releases.get(id), "held", `${world.name}: ${id} is never released`);
    }
  }
  const malformed = planOf(SOUND_OPS, "ops");
  malformed.tasks[1]!.not_before = "not a date";
  assert.deepEqual(composeSecondaryPlan(planOf(PUBLIC_TEXT, "public"), malformed), { outcome: "malformed" });
  // ...and the daemon holds the whole ops catalog on it, dispatching public work alone, as on origin/main.
  const whole = await dispatched(planOf(PUBLIC_TEXT, "public"), malformed, { max: 2 });
  assert.deepEqual(whole.ran, ["PUB-1", "PUB-2"]);
  assert.deepEqual(rowsOf(whole, "dispatch.ops_catalog_held").map(row => row.data), [{ outcome: "malformed" }]);
  assert.deepEqual(rowsOf(whole, "dispatch.ops_task_held"), []);
});

test("W1-T13749 criterion 9: invariant a-sound-task-is-never-held-for-another — a sound task composes, is a candidate, starts and is released as with the bad edge removed, and a clean fixture composes as on origin/main", async t => {
  for (const world of WORLDS) {
    const bad = await observe(t, world.publicText, world.opsText);
    const clean = await observe(t, world.clean.publicText, world.clean.opsText);
    const sound = [...clean.composed.byId.keys()].filter(id => !world.held.includes(id));
    assert.ok(sound.length >= 4, `${world.name}: positive control, sound tasks exist`);
    for (const id of sound) {
      assert.deepEqual(bad.composed.byId.get(id), clean.composed.byId.get(id), `${world.name}: ${id} composes the same record`);
      assert.equal(bad.candidates.has(id), clean.candidates.has(id), `${world.name}: ${id} is a candidate exactly as without the bad edge`);
      assert.equal(bad.ran.has(id), clean.ran.has(id), `${world.name}: ${id} starts exactly as without the bad edge`);
      assert.equal(bad.releases.get(id), clean.releases.get(id), `${world.name}: ${id} is released exactly as without the bad edge`);
    }
    assert.ok(sound.some(id => bad.ran.has(id) && bad.releases.get(id)?.startsWith("found:")), `${world.name}: a sound ops task starts and is released`);
  }
  // No bad edge: public then ops records, every ops id in secondaryIds, nothing held, as origin/main composes.
  const composition = composeSecondaryPlan(planOf(PUBLIC_TEXT, "public"), planOf(SOUND_OPS, "ops"));
  assert.deepEqual(heldOf(composition), {});
  if (composition.outcome !== "ok") return;
  assert.deepEqual(ids(composition.plan), ["PUB-1", "PUB-2", "OPS-GOOD", "OPS-ON-PUBLIC", "OPS-ON-GOOD"]);
  assert.deepEqual([...composition.secondaryIds], ["OPS-GOOD", "OPS-ON-PUBLIC", "OPS-ON-GOOD"]);
});
