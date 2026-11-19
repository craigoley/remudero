import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { openScratchReadModel } from "#src/lib/read-model-db.js";
import { buildBatchedGithub } from "#src/lib/status.js";
import { createWorkstreamsView, type WorkstreamsViewOptions } from "#src/lib/workstreams-view.js";
import { readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const RETAINED_BODY = "workstreams:retained-body";

function fixture(t: TestContext) {
  const { dir, onClose } = readModelFixtureDir(t, "workstreams-build-counts");
  writeFileSync(join(dir, "ledger.ndjson"), "");
  const db = openScratchReadModel();
  onClose(() => db.close());
  db.exec("CREATE TABLE activity_ring(seq INTEGER PRIMARY KEY, ts_ms INTEGER, h INTEGER, body TEXT)");
  const insert = db.prepare("INSERT INTO activity_ring(ts_ms, h, body) VALUES (?, ?, ?)");
  const plan = loadPlanFromYaml(`
- id: W1-T1
  title: fixture task
  repo: example/project
  type: implement
  depends_on: []
  status: queued
`, "workstreams build counts fixture");
  const github = buildBatchedGithub("example", "project", {
    fetchAll: () => [],
    fetchAllIssues: () => [],
    commitTrailerIndex: () => new Map(),
  });
  const state = { instance: "core", newestTs: null };
  const opts: WorkstreamsViewOptions<typeof state> = {
    instances: [{ name: state.instance, ledgerDir: dir, repo: "example/project" }],
    debounceMs: 0,
    ledgerSource: () => ({ name: "ledger:core", asOf: null, state: "fresh" }),
    readPlan: () => plan,
    github: () => ({ github, source: { asOf: null, state: "fresh" } }),
    planBehind: () => ({ commits: 0 }),
  };
  const rows: Record<string, unknown>[] = [];
  const view = createWorkstreamsView({
    ...opts,
    log: (step, extra) => { if (step === "workstreams.built") rows.push(extra); },
  });
  const build = (now: number) => view.materialize({ now, instances: [{ state, db }] })[0]!.data;
  const addActivity = (at: number) => {
    const ts = new Date(at).toISOString();
    insert.run(at, at, JSON.stringify({ ts, step: "worker.activity", run_id: `run-${at}` }));
  };
  return { view, rows, build, addActivity, opts, state, db };
}

test("W1-T11886 criterion 1: equal builds stay silent and the next changed row carries their exact count", (t) => {
  const { view, rows, build, addActivity } = fixture(t);
  build(NOW);
  addActivity(NOW + 1);
  build(NOW + 1);
  rows.length = 0;

  for (const at of [NOW + 2, NOW + 3]) {
    addActivity(at);
    build(at);
  }
  assert.deepEqual(rows, [], "equal builds stay silent");
  build(NOW + 11 * 60_000);
  assert.deepEqual(rows, [], "an idle pass past the old flush window neither emits nor increments repeats");

  view.materialize({ now: NOW + 13 * 60_000, instances: [] });
  assert.deepEqual(rows, [{ instances: 0, reused: 0, derived: 0, repeats: 2, builds: 3 }]);
  build(NOW + 14 * 60_000);
  assert.deepEqual(rows[1], { instances: 1, reused: 0, derived: 1, repeats: 0, builds: 1 });
});

test("W1-T11886 criterion 2: the first build and a changed build with no repeats log immediately", (t) => {
  const { rows, build, addActivity } = fixture(t);
  build(NOW);
  assert.deepEqual(rows, [{ instances: 1, reused: 0, derived: 1, repeats: 0, builds: 1 }]);
  addActivity(NOW + 1);
  build(NOW + 1);
  assert.deepEqual(rows[1], { instances: 1, reused: 1, derived: 0, repeats: 0, builds: 1 });
});

test("W1-T11886 criterion 3: a silent build still publishes the body and accounts for its retained bytes", (t) => {
  const { view, rows, build, addActivity, opts, state, db } = fixture(t);
  build(NOW);
  addActivity(NOW + 1);
  const prior = build(NOW + 1);
  assert.equal(rows.length, 2, "the cold and first warm builds have different counts");
  const now = NOW + 2;
  addActivity(now);
  const body = build(now);
  assert.equal(rows.length, 2);

  const controlRows: Record<string, unknown>[] = [];
  const control = createWorkstreamsView({
    ...opts,
    log: (step, extra) => { if (step === "workstreams.built") controlRows.push(extra); },
  });
  assert.deepEqual(body, control.materialize({ now, instances: [{ state, db }] })[0]!.data);
  assert.equal(controlRows.length, 1, "the control always logs its cold build");
  const activity = body.instances[0]!.activity;
  const priorActivity = prior.instances[0]!.activity;
  assert.ok("items" in activity && "items" in priorActivity);
  assert.equal(activity.items.filter((item) => item.kind === "activity").length,
    priorActivity.items.filter((item) => item.kind === "activity").length + 1);
  assert.deepEqual(view.heldSizes()[RETAINED_BODY], control.heldSizes()[RETAINED_BODY]);
  assert.deepEqual(view.heldSizes()[RETAINED_BODY], {
    entries: 1,
    bytes: Buffer.byteLength(JSON.stringify(body)),
    unit: "instances",
    bytes_basis: "serialized-payload-estimate-not-exclusive-v8",
  });
});
