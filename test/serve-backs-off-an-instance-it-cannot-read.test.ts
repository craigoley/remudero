// W1-T14586: Serve backs off an instance it cannot read and names the action that mounts it: the now view
// classifies a failed build (state dir not mounted, plan unreadable, other), retries a repeated identical failure
// at a capped exponential back-off, writes one ledger row per change of state, and the instances view names
// deploy/serve-container.sh --replace for a registered instance it does not mount.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { INSTANCES_VIEW_NAME, SERVE_MOUNT_ACTION, createInstancesView, type InstancesData } from "#src/lib/instances-view.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { NOW_FAILED_BACKOFF_CAP_MS, NOW_REFRESH_MS, createNowView, type NowInstance, type NowViewContext } from "#src/lib/now-view.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import { createReadModelTicker, ledgerSource, readModelSwitchesPath, type ReadModelInstanceState, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import type { GitHub } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { declaredBody, resolve, violations, type Schema } from "#test/helpers/openapi-strict.js";
import { closeReadModelFixture, readModelFixtureDir, type ReadModelFixtureScope } from "#test/helpers/read-model-fixture.js";

const T0 = Date.parse("2026-10-01T08:00:00.000Z");
const IDS = ["W1-T1", "W1-T2"];
const PLAN_ERROR = "cannot read plan file (fixture/plan/tasks.yaml): ENOENT";

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}
const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };
const GATEWAY = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
  listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "t" }),
} as unknown as GitHub;

type SetClock = Clock & { set(ms: number): void };
function setClock(): SetClock {
  let ms = T0;
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString(), set: (to) => void (ms = to) };
}

/** Each instance with its own store and held lease; a mounted one has a seeded live file, an unmounted one no state dir. */
/** `planRoot` lets two worlds share one plan path, so a body that names it is the same in both. */
function world(t: ReadModelFixtureScope, specs: Array<{ name: string; mounted: boolean }>, planRoot?: string) {
  const root = readModelFixtureDir(t, "now-backoff");
  const clock = setClock();
  const rows = IDS.map((id) => ({ ts: new Date(T0).toISOString(), step: "worker.assignment", task_id: id, run_id: `r-${id}` }));
  const slots = specs.map(({ name, mounted }) => {
    const ledgerDir = mounted ? writeLedger(rows, { scope: t }).dir : join(root, name, "state");
    const db = openProjectorReadModel(join(root, "home"), name, clock);
    closeReadModelFixture(t, () => db.close());
    const got = acquireLease(db, { clock, ttlMs: 1e12 });
    assert.ok(got.ok);
    if (mounted) createLedgerProjector({ ledgerDir, db, lease: got.lease, clock }).tick();
    const planPath = join(planRoot ?? root, name, "plan", "tasks.yaml");
    mkdirSync(dirname(planPath), { recursive: true });
    if (!existsSync(planPath)) writeFileSync(planPath, "tasks: []\n");
    return { name, ledgerDir, planPath, db, lease: got.lease };
  });
  const instances: NowInstance[] = slots.map((s) => ({ name: s.name, ledgerDir: s.ledgerDir, repo: "o/r", planPath: s.planPath }));
  const ctx = (): NowViewContext => ({
    now: clock.now(), switches: { views: { now: "shadow" } },
    instances: slots.map((s) => ({ state: { instance: s.name, generation: Number(s.db.meta("generation")), lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null }, db: s.db, lease: s.lease })),
  });
  return { clock, slots, instances, ctx };
}

/** A now view whose plan and GitHub reads fail per instance as `fail` says, counting each read. */
function viewOver(w: ReturnType<typeof world>, fail: { plan: Map<string, string>; github: Set<string> }) {
  const logged: Array<Record<string, unknown>> = [];
  const reads = new Map<string, number>();
  const count = (name: string) => void reads.set(name, (reads.get(name) ?? 0) + 1);
  const view = createNowView({
    instances: w.instances, clock: w.clock, coreInstance: w.instances[0]!.name,
    log: (step, extra) => void logged.push({ step, ...extra }),
    readPlan: (instance) => {
      count(instance.name);
      const error = fail.plan.get(instance.name);
      if (error) throw new Error(error);
      return PLAN;
    },
    github: (instance) => {
      if (fail.github.has(instance.name)) {
        count(instance.name);
        throw new Error("synthetic github read failure");
      }
      return { github: GATEWAY, generation: "g", source: { asOf: null, state: "fresh" } };
    },
    hostProbe: { rateLimit: () => 5_000, diskFree: () => 1_000_000, readLive: () => [] },
    listGrilling: () => [],
    planBehind: () => ({ commits: 0 }),
  });
  const rows = (step: string) => logged.filter((r) => r.step === step);
  return { view, logged, reads, rows };
}

test("W1-T14586 criterion 1: a first failure with no state dir is recorded at once as unmounted and names the mount action", (t) => {
  const w = world(t, [{ name: "fixture-instance", mounted: false }]);
  const v = viewOver(w, { plan: new Map([["fixture-instance", PLAN_ERROR]]), github: new Set() });
  assert.equal(v.view.prepare(w.ctx(), () => true), true);
  assert.deepEqual(v.rows("read_model.now_view_failed"), [{ step: "read_model.now_view_failed", instance: "fixture-instance", error: PLAN_ERROR,
    class: "unmounted", retryAfterMs: NOW_REFRESH_MS, action: "deploy/serve-container.sh --replace" }]);
});

test("W1-T14586 criterion 1: a first failure at the plan stage of a mounted instance is plan-unreadable, with no action", (t) => {
  const w = world(t, [{ name: "fixture-instance", mounted: true }]);
  const v = viewOver(w, { plan: new Map([["fixture-instance", PLAN_ERROR]]), github: new Set() });
  assert.deepEqual(v.view.materialize(w.ctx()), []);
  assert.deepEqual(v.rows("read_model.now_view_failed"), [{ step: "read_model.now_view_failed", instance: "fixture-instance", error: PLAN_ERROR,
    class: "plan-unreadable", retryAfterMs: NOW_REFRESH_MS }]);
});

test("W1-T14586 criterion 1: a first failure at a later stage is build-failed", (t) => {
  const w = world(t, [{ name: "fixture-instance", mounted: true }]);
  const v = viewOver(w, { plan: new Map(), github: new Set(["fixture-instance"]) });
  assert.deepEqual(v.view.materialize(w.ctx()), []);
  assert.deepEqual(v.rows("read_model.now_view_failed"), [{ step: "read_model.now_view_failed", instance: "fixture-instance", error: "synthetic github read failure",
    class: "build-failed", retryAfterMs: NOW_REFRESH_MS }]);
});

test("W1-T14586 criterion 2: an identical failure is retried at a doubling back-off capped at NOW_FAILED_BACKOFF_CAP_MS, with no limit on tries", (t) => {
  const w = world(t, [{ name: "fixture-instance", mounted: true }]);
  const v = viewOver(w, { plan: new Map([["fixture-instance", PLAN_ERROR]]), github: new Set() });
  v.view.materialize(w.ctx());
  assert.equal(v.reads.get("fixture-instance"), 1);
  // 1,000 calls inside the first back-off, prepare and materialize in turn: no build, no row.
  for (let i = 1; i <= 1_000; i++) {
    w.clock.set(T0 + i * 29);
    if (i % 2) assert.equal(v.view.prepare(w.ctx(), () => true), true);
    else assert.deepEqual(v.view.materialize(w.ctx()), []);
  }
  assert.equal(v.reads.get("fixture-instance"), 1, "no build ran inside the back-off");
  assert.equal(v.rows("read_model.now_view_failed").length, 1, "and no row was written");
  let last = T0;
  for (let k = 0; k < 12; k++) {
    const wait = Math.min(NOW_REFRESH_MS * 2 ** k, NOW_FAILED_BACKOFF_CAP_MS);
    w.clock.set(last + wait - 1);
    v.view.materialize(w.ctx());
    assert.equal(v.reads.get("fixture-instance"), k + 1, `try ${k + 2} waits ${wait} ms`);
    w.clock.set(last + wait);
    v.view.materialize(w.ctx());
    assert.equal(v.reads.get("fixture-instance"), k + 2, `try ${k + 2} runs after ${wait} ms`);
    last += wait;
  }
  assert.equal(Math.min(NOW_REFRESH_MS * 2 ** 11, NOW_FAILED_BACKOFF_CAP_MS), NOW_FAILED_BACKOFF_CAP_MS, "the last tries ran at the cap");
  assert.equal(v.rows("read_model.now_view_failed").length, 1, "an identical failure writes no new row");
});

test("W1-T14586 criterion 3: a different error writes one new row and restarts the back-off from NOW_REFRESH_MS", (t) => {
  const w = world(t, [{ name: "fixture-instance", mounted: true }]);
  const fail = { plan: new Map([["fixture-instance", PLAN_ERROR]]), github: new Set<string>() };
  const v = viewOver(w, fail);
  v.view.materialize(w.ctx());
  w.clock.set(T0 + NOW_REFRESH_MS);
  v.view.materialize(w.ctx());
  assert.equal(v.rows("read_model.now_view_failed").length, 1);
  // Identical twice: the next wait is 2 x NOW_REFRESH_MS. A new error at that retry restarts the wait from NOW_REFRESH_MS.
  fail.plan.set("fixture-instance", "a different plan read failure");
  w.clock.set(T0 + 3 * NOW_REFRESH_MS);
  v.view.materialize(w.ctx());
  assert.deepEqual(v.rows("read_model.now_view_failed").at(-1), { step: "read_model.now_view_failed", instance: "fixture-instance",
    error: "a different plan read failure", class: "plan-unreadable", retryAfterMs: NOW_REFRESH_MS });
  w.clock.set(T0 + 4 * NOW_REFRESH_MS);
  v.view.materialize(w.ctx());
  assert.equal(v.reads.get("fixture-instance"), 4, "the retry ran NOW_REFRESH_MS after the new error");
  // A different class: the plan reads, GitHub fails.
  fail.plan.delete("fixture-instance");
  fail.github.add("fixture-instance");
  w.clock.set(T0 + 6 * NOW_REFRESH_MS);
  v.view.materialize(w.ctx());
  assert.deepEqual(v.rows("read_model.now_view_failed").map((r) => r.class), ["plan-unreadable", "plan-unreadable", "build-failed"]);
});

test("W1-T14586 criterion 3: a changed plan key or state dir ends the back-off at once", (t) => {
  const w = world(t, [{ name: "fixture-instance", mounted: false }]);
  const v = viewOver(w, { plan: new Map([["fixture-instance", PLAN_ERROR]]), github: new Set() });
  v.view.materialize(w.ctx());
  w.clock.set(T0 + 1_000);
  v.view.materialize(w.ctx());
  assert.equal(v.reads.get("fixture-instance"), 1, "inside the back-off with nothing moved");
  utimesSync(w.slots[0]!.planPath, new Date(T0 - 86_400_000), new Date(T0 - 86_400_000));
  w.clock.set(T0 + 2_000);
  v.view.materialize(w.ctx());
  assert.equal(v.reads.get("fixture-instance"), 2, "a changed plan key retries at once");
  assert.equal(v.rows("read_model.now_view_failed").length, 1, "the same class and error writes no row");
  mkdirSync(w.slots[0]!.ledgerDir, { recursive: true });
  w.clock.set(T0 + 3_000);
  v.view.materialize(w.ctx());
  assert.equal(v.reads.get("fixture-instance"), 3, "a state dir that appeared retries at once");
  assert.deepEqual(v.rows("read_model.now_view_failed").map((r) => r.class), ["unmounted", "plan-unreadable"]);
});

test("W1-T14586 criterion 3: the first build that reaches its body writes one recovered row and clears the state", (t) => {
  const w = world(t, [{ name: "fixture-instance", mounted: true }]);
  const fail = { plan: new Map([["fixture-instance", PLAN_ERROR]]), github: new Set<string>() };
  const v = viewOver(w, fail);
  v.view.materialize(w.ctx());
  w.clock.set(T0 + NOW_REFRESH_MS);
  v.view.materialize(w.ctx());
  fail.plan.delete("fixture-instance");
  w.clock.set(T0 + 3 * NOW_REFRESH_MS);
  assert.equal(v.view.materialize(w.ctx()).length, 1, "the recovered build publishes its body");
  assert.deepEqual(v.rows("read_model.now_view_recovered"), [{ step: "read_model.now_view_recovered", instance: "fixture-instance",
    class: "plan-unreadable", failures: 2, failingForMs: 3 * NOW_REFRESH_MS }]);
  // The state is cleared: a new failure is recorded at once, with no back-off carried over.
  fail.plan.set("fixture-instance", PLAN_ERROR);
  utimesSync(w.slots[0]!.planPath, new Date(T0 - 86_400_000), new Date(T0 - 86_400_000));
  w.clock.set(T0 + 3 * NOW_REFRESH_MS + 1);
  v.view.materialize(w.ctx());
  assert.equal(v.rows("read_model.now_view_failed").length, 2);
  assert.equal(v.rows("read_model.now_view_recovered").length, 1);
});

test("W1-T14586 criterion 4: a readable instance builds the same bodies, order and rows beside a failing one", (t) => {
  const planRoot = readModelFixtureDir(t, "now-backoff-plans");
  const run = (names: Array<{ name: string; mounted: boolean }>) => {
    const w = world(t, names, planRoot);
    const fail = { plan: new Map([["failing-instance", PLAN_ERROR]]), github: new Set<string>() };
    const v = viewOver(w, fail);
    const bodies: unknown[] = [];
    for (let i = 0; i < 120; i++) {
      w.clock.set(T0 + i * 10_000);
      if (i === 60) fail.plan.delete("failing-instance");
      if (i % 3 === 0) v.view.prepare(w.ctx(), () => true);
      bodies.push(v.view.materialize(w.ctx()).filter((b) => b.key === "instance=readable-instance").map((b) => [b.key, b.data]));
    }
    return { bodies, rows: v.logged.filter((r) => r.instance === "readable-instance"), failing: v.logged.filter((r) => r.instance === "failing-instance") };
  };
  const control = run([{ name: "readable-instance", mounted: true }]);
  const beside = run([{ name: "readable-instance", mounted: true }, { name: "failing-instance", mounted: true }]);
  assert.ok(beside.failing.some((r) => r.step === "read_model.now_view_failed"), "the other instance really failed");
  assert.ok(beside.failing.some((r) => r.step === "read_model.now_view_recovered"), "and recovered within the run");
  assert.ok(control.bodies.some((b) => (b as unknown[]).length > 0), "the readable instance built bodies");
  assert.deepEqual(beside.bodies, control.bodies);
  assert.deepEqual(beside.rows, control.rows);
});

test("W1-T14586 criterion 5: a registered instance serve does not mount carries mountAction; a served one carries none", (t) => {
  const root = readModelFixtureDir(t, "instances-mount-action");
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeLedger([{ ts: new Date(T0).toISOString(), step: "daemon.tick", host: "h1" }], { dir: stateDir });
  const registry = "instances:\n  served-instance:\n    github_repo: o/served\n    project: demo\n  fixture-instance:\n    github_repo: o/fixture\n    project: demo\n";
  const repoPath = join(root, "daemon-instances.yaml");
  const hostPath = join(root, "host-instances.yaml");
  writeFileSync(repoPath, registry);
  writeFileSync(hostPath, registry);
  const instances = [
    { name: "served-instance", ledgerDir: stateDir, repo: "o/served" },
    { name: "fixture-instance", ledgerDir: join(root, "fixture-instance", "state"), repo: "o/fixture" },
  ];
  const view = createInstancesView<ReadModelInstanceState>({ instances, repoPath, hostPath, ledgerSource });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { [INSTANCES_VIEW_NAME]: "serve" } }));
  const posted: ReadModelWorkerMessage[] = [];
  const clock = setClock();
  const ticker = createReadModelTicker({ stateDir, instances, views: [view], clock, holder: "mount-action-test", oracle: "off", post: (m) => void posted.push(m) });
  ticker.start();
  ticker.tick();
  ticker.release();
  const entry = posted.flatMap((m) => (m.type === "body" && m.entry.view === INSTANCES_VIEW_NAME ? [m.entry] : []))[0];
  assert.ok(entry, "the instances view built a body");
  const data = entry.body.data as InstancesData;
  const byId = Object.fromEntries(data.instances.map((i) => [i.id, i]));
  assert.equal(byId["fixture-instance"]!.served, false);
  assert.equal(byId["fixture-instance"]!.mountAction, "deploy/serve-container.sh --replace");
  assert.equal(byId["served-instance"]!.served, true);
  assert.equal("mountAction" in byId["served-instance"]!, false, "a served entry carries no mountAction");
  // openapi/daemon.yaml declares the field: the strict validator refuses any key the schema never declares.
  const schema = (resolve(declaredBody(`/v1/views/${INSTANCES_VIEW_NAME}`, "GET", 200)).properties as Record<string, Schema>).data!;
  assert.deepEqual(violations(data, schema), []);
  // The shadow side carries the same entry.
  const legacy = view.legacy?.("", T0, data)?.data as InstancesData | undefined;
  assert.equal(legacy?.instances.find((i) => i.id === "fixture-instance")?.mountAction, SERVE_MOUNT_ACTION);
  // The now view's unmounted row names the very same action.
  const w = world(t, [{ name: "fixture-instance", mounted: false }]);
  const v = viewOver(w, { plan: new Map([["fixture-instance", PLAN_ERROR]]), github: new Set() });
  v.view.materialize(w.ctx());
  assert.equal(v.rows("read_model.now_view_failed")[0]?.action, byId["fixture-instance"]!.mountAction);
});
