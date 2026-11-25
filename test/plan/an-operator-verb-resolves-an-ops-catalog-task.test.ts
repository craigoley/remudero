/**
 * W1-T14828 — AN OPERATOR VERB RESOLVES AN OPS-CATALOG TASK.
 *
 * 2026-11-25: `rmd release W1-T9267` refused "unknown task" because releaseCommand, correctCommand and reportTaskPlan
 * found their task with verbTaskPlan, which reads only the public plan (cwd's, or the instance target's). Since 11-17
 * new tasks live only in the ops catalog. resolveVerbTask tries the public plan exactly as verbTaskPlan does, and on a
 * miss asks the two-catalog lookup rmd approve uses. Each case injects the public resolution (built here the way
 * verbTaskPlan builds it) and the lookup; no case imports src/run-task.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { parseTasksFromYaml, type Plan } from "#src/lib/plan.js";
import { resolveVerbPlanRoot, writeDaemonTargetRecord } from "#src/lib/repo-location.js";
import type { OpsCatalogSnapshot } from "#src/lib/ops-catalog-source.js";
import { findTaskInCatalogs, type TaskLookupOptions, type TaskLookupResult } from "#src/lib/task-lookup.js";
import { resolveVerbTask, type PublicVerbPlan } from "#src/lib/verb-task-lookup.js";

const CWD_ID = "W1-T1";
const TARGET_ID = "PORTAL-T7";
const OPS_ID = "W1-T9267";
const NOWHERE_ID = "W1-T404";

const planOf = (id: string, repo: string): Plan => {
  const tasks = parseTasksFromYaml(
    `- id: ${id}\n  title: "fixture ${id}"\n  repo: ${repo}\n  depends_on: []\n  type: implement\n  verify: auto\n` +
      `  risk: low\n  status: queued\n  files: [src/x.ts]\n`,
    `${id}.yaml`,
  );
  return { tasks, byId: new Map(tasks.map((task) => [task.id, task])) };
};

interface Fixture { stateDir: string; cwdRoot: string; targetRoot: string; plans: Map<string, Plan>; loads: string[] }

/** A state dir whose boot record names a non-self target checkout, and an in-memory plan per checkout root. */
function fixture(t: TestContext): Fixture {
  const home = mkdtempSync(join(tmpdir(), "rmd-t14828-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateDir = join(home, "state");
  const cwdRoot = join(home, "engine");
  const targetRoot = join(home, "repos", "portal");
  assert.deepEqual(
    writeDaemonTargetRecord(stateDir, { owner: "fixture-owner", repo: "portal", isSelf: false, checkoutRoot: targetRoot }),
    { written: true },
  );
  const plans = new Map([[cwdRoot, planOf(CWD_ID, "remudero")], [targetRoot, planOf(TARGET_ID, "portal")]]);
  return { stateDir, cwdRoot, targetRoot, plans, loads: [] };
}

/** verbTaskPlan's body as it stands on origin/main, with loadPlan reading the fixture's in-memory plans. */
function verbTaskPlanAsOnMain(f: Fixture): (taskId: string) => PublicVerbPlan {
  return (taskId) => {
    let loaded: Plan | undefined;
    const located = resolveVerbPlanRoot(taskId, {
      argv: [],
      cwdRoot: f.cwdRoot,
      stateDir: () => f.stateDir,
      holds: (root, id) => {
        f.loads.push(root);
        return (loaded = f.plans.get(root) ?? { tasks: [], byId: new Map() }).byId.has(id);
      },
    });
    return located.ok ? { ...located, plan: loaded!, planPath: join(located.root, "plan", "tasks.yaml") } : located;
  };
}

type Lookup = (taskId: string, sources: TaskLookupOptions & Pick<Plan, "byId">) => Promise<TaskLookupResult>;

/** A two-catalog lookup whose ops catalog holds `opsPlan`, recording each call. */
function opsLookup(opsPlan: Plan, calls: Array<{ taskId: string; stateDir?: string }>): Lookup {
  return async (taskId, sources) => {
    calls.push({ taskId, stateDir: sources.stateDir });
    const task = opsPlan.byId.get(taskId);
    return task === undefined ? { outcome: "absent" } : { outcome: "found", task: { ...task, catalog: "ops" }, catalog: "ops" };
  };
}

const named = () => ({ outcome: "named" as const, owner: "fixture-ops-owner", repo: "ops", checkoutDir: "/nowhere", kinds: [] });

test("W1-T14828 criterion 1: an id only the ops catalog holds resolves with its repo and the ops catalog; an id neither catalog holds misses naming both", async (t) => {
  const f = fixture(t);
  const publicPlan = verbTaskPlanAsOnMain(f);
  const calls: Array<{ taskId: string; stateDir?: string }> = [];
  const resolve = (id: string) => resolveVerbTask(id, publicPlan, () => f.stateDir, opsLookup(planOf(OPS_ID, "widget"), calls), named);

  // origin/main's verb lookup is the public resolution alone, and it refuses the ops id as unknown.
  const onMain = publicPlan(OPS_ID);
  assert.equal(onMain.ok, false);

  const found = await resolve(OPS_ID);
  assert.ok(found.ok, `the ops-only id resolves: ${JSON.stringify(found)}`);
  assert.equal(found.catalog, "ops");
  assert.equal(found.task.id, OPS_ID);
  assert.equal(found.repo, "widget", "the verb writes to the task's own repo");
  assert.equal(found.owner, "fixture-ops-owner", "under the owner the lookup's destination names");
  assert.deepEqual(calls, [{ taskId: OPS_ID, stateDir: f.stateDir }], "the lookup reads the instance state dir");

  const miss = await resolve(NOWHERE_ID);
  assert.equal(miss.ok, false);
  assert.ok(!miss.ok);
  assert.match(miss.error, new RegExp(join(f.cwdRoot, "plan", "tasks.yaml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the miss names the public plan searched");
  assert.match(miss.error, /not in the ops catalog either/, "and the ops catalog");
});

test("W1-T14828 criterion 2: an id the public plan holds resolves to the same plan root, plan and task verbTaskPlan returns, without the ops lookup", async (t) => {
  const f = fixture(t);
  const publicPlan = verbTaskPlanAsOnMain(f);
  const calls: Array<{ taskId: string; stateDir?: string }> = [];
  // The ops catalog holds a copy of each public id too: a public hit must never read it.
  const opsPlan: Plan = { tasks: [], byId: new Map([[CWD_ID, planOf(CWD_ID, "ops-copy").tasks[0]!], [TARGET_ID, planOf(TARGET_ID, "ops-copy").tasks[0]!]]) };
  const resolve = (id: string) => resolveVerbTask(id, publicPlan, () => f.stateDir, opsLookup(opsPlan, calls), named);

  for (const [id, root, via] of [[CWD_ID, f.cwdRoot, "cwd"], [TARGET_ID, f.targetRoot, "target"]] as const) {
    const expected = publicPlan(id);
    assert.ok(expected.ok, `${id} is in a public plan`);
    const got = await resolve(id);
    assert.ok(got.ok, `${id} resolves`);
    assert.equal(got.catalog, "public");
    assert.equal(got.root, root);
    assert.equal(got.root, expected.root);
    assert.equal(got.via, via);
    assert.equal(got.planPath, expected.planPath);
    assert.deepEqual(got.target, expected.target);
    assert.equal(got.plan, f.plans.get(root), "the very plan verbTaskPlan loaded");
    assert.equal(got.task, f.plans.get(root)!.byId.get(id), "the very task in that plan");
    assert.equal(got.repo, got.task.repo);
    assert.equal(got.owner, expected.target?.owner, "the owner verbTaskPlan's callers used: the target's, else none");
  }
  assert.deepEqual(calls, [], "a public hit never opens the ops catalog");
});

test("W1-T14828: an unreadable ops catalog or instance config misses with its reason; a host with no ops catalog misses as before", async (t) => {
  const f = fixture(t);
  const publicPlan = verbTaskPlanAsOnMain(f);
  const unreadable = await resolveVerbTask(OPS_ID, publicPlan, () => f.stateDir,
    async () => ({ outcome: "unreadable", reason: "ops-auth_missing" }), named);
  assert.ok(!unreadable.ok);
  assert.match(unreadable.error, /; ops catalog unreadable \(ops-auth_missing\)$/);

  const off = await resolveVerbTask(OPS_ID, publicPlan, () => f.stateDir,
    async () => ({ outcome: "absent" }), () => ({ outcome: "off" }));
  assert.ok(!off.ok);
  const publicMiss = publicPlan(OPS_ID);
  assert.ok(!publicMiss.ok);
  assert.equal(off.error, publicMiss.error, "a host with no ops catalog misses exactly as verbTaskPlan did");

  const config = await resolveVerbTask(OPS_ID,
    () => ({ ok: false, searched: [], error: "not found in /x/plan/tasks.yaml" }),
    () => { throw new Error("config.json is not JSON"); },
    async () => { throw new Error("the lookup must not run without a state dir"); });
  assert.ok(!config.ok);
  assert.equal(config.error, "not found in /x/plan/tasks.yaml; ops catalog unreadable (instance config: config.json is not JSON)");
});

test("W1-T14828: through findTaskInCatalogs and the default destination, an ops task is found via the instance's plan-destination file", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.stateDir, "plan-destination.json"), JSON.stringify({ repository: "fixture-private/ops", kinds: [] }));
  const opsPlan = planOf(OPS_ID, "widget");
  const opsSnapshot = { outcome: "ok", plan: opsPlan, counts: { treeEntries: 0, shards: 0, bytes: 0, passes: 1, fetchedObjects: [0], cachedObjects: 0 } } as OpsCatalogSnapshot;
  const found = await resolveVerbTask(OPS_ID, verbTaskPlanAsOnMain(f), () => f.stateDir,
    (id, sources) => findTaskInCatalogs(id, { ...sources, opsSnapshot }));
  assert.ok(found.ok, JSON.stringify(found));
  assert.equal(found.catalog, "ops");
  assert.equal(found.repo, "widget");
  assert.equal(found.owner, "fixture-private");
  assert.equal(found.target, undefined);
});
