// W1-T11978: serve wrote one agent.built and one workstreams.built row for every build: 2,072 of the 7,781 ledger rows
// every actor wrote between 2026-11-09T16:00Z and 2026-11-10T05:00Z, each one moving the ledger every reader folds.
// Agent builds are tallied by window. Workstreams builds are tallied until their counts change (W1-T11886).
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_BUILT_ROW_WINDOW_MS, AGENT_CLOCK_MS, createAgentView } from "#src/lib/agent-view.js";
import type { Clock } from "#src/lib/clock.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import { createReadModelTicker, ledgerSource, type ReadModelInstanceState } from "#src/lib/read-model-worker.js";
import { WORKSTREAMS_REUSE_AUDIT_MS } from "#src/lib/workstreams-projection-reuse.js";
import { createWorkstreamsView, WORKSTREAMS_DEBOUNCE_MS, WORKSTREAMS_VIEW_NAME } from "#src/lib/workstreams-view.js";
import { onReadModelClose, readModelFixtureDir, type ReadModelFixtureTestScope } from "#test/helpers/read-model-fixture-dir.js";
import { switchViewsOn } from "#test/helpers/read-model-switches.js";

const NOW = Date.parse("2026-11-10T05:00:00.000Z");
const REPO = "craigoley/remudero";
const TASKS = ["A", "B", "C", "D"];
const iso = (ms: number) => new Date(ms).toISOString();
type Rows = Array<Record<string, unknown>>;

function movingClock(start: number): Clock & { set(ms: number): void } {
  let at = start;
  return { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString(), set: (ms) => void (at = ms) };
}

/** An agent view over one projected store, built by hand at the times the test names. */
function agent(t: ReadModelFixtureTestScope, builtRowWindowMs?: number): { rows: Rows; build(now: number): void } {
  const stateDir = join(readModelFixtureDir(t, "agent-build-rows").dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.ndjson"), `${JSON.stringify({ ts: iso(NOW - 60_000), step: "daemon.tick" })}\n`);
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [], holder: "agent-build-rows", post: () => {} });
  for (let i = 0; i < 5; i++) ticker.tick();
  ticker.release();
  const db = openProjectorReadModel(stateDir, "core");
  onReadModelClose(t, () => db.close());
  const got = acquireLease(db, { holder: "agent-build-rows" });
  assert.ok(got.ok, "the test holds the store's lease");
  const rows: Rows = [];
  const view = createAgentView<ReadModelInstanceState>({
    instances: [{ name: "core", ledgerDir: stateDir, repo: REPO }], ledgerSource,
    ...(builtRowWindowMs === undefined ? {} : { builtRowWindowMs }),
    log: (step, extra) => void (step === "agent.built" && rows.push(extra)),
  });
  const instances = [{ state: { instance: "core", generation: 1, lease: "held", failures: 0, newestTs: null, tickedAt: NOW } satisfies ReadModelInstanceState, db, lease: got.lease }];
  return { rows, build: (now) => { assert.equal(view.prepare({ instances }, () => true), true); assert.ok(view.materialize({ now, instances }).length > 0); } };
}

/** A workstreams view under the real ticker; each `insert` is one ledger row and the one build it causes. */
function workstreams(t: ReadModelFixtureTestScope): { rows: Rows; insert(at: number): void; idle(at: number): void } {
  const root = readModelFixtureDir(t, "workstreams-build-rows").dir;
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, TASKS.map((id) => `- id: ${id}\n  title: task ${id}\n  repo: ${REPO}\n  type: implement\n  depends_on: []\n  status: queued\n`).join(""));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: iso(NOW - 60_000), step: "worker.activity", task_id: "A", run_id: "r-a" })}\n`);
  const instances = [{ name: "core", ledgerDir: stateDir, repo: REPO, planPath }];
  const clock = movingClock(NOW);
  const rows: Rows = [];
  const view = createWorkstreamsView<ReadModelInstanceState>({
    instances, ledgerSource, clock,
    log: (step, extra) => void (step === "workstreams.built" && rows.push(extra)),
  });
  switchViewsOn(stateDir, [WORKSTREAMS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir, instances, views: [view], clock, holder: "workstreams-build-rows", oracle: "off", post: () => {} });
  onReadModelClose(t, () => ticker.release());
  ticker.start();
  ticker.tick();
  const idle = (at: number) => { clock.set(at); ticker.tick(); };
  return {
    rows, idle,
    insert(at) {
      appendFileSync(ledgerPath, `${JSON.stringify({ ts: iso(at - 10), step: "worker.activity", task_id: "B", run_id: "r-b", n: at })}\n`);
      idle(at);
      idle(at + WORKSTREAMS_DEBOUNCE_MS);
    },
  };
}

test("W1-T11978 criterion 1: agent-view writes one agent.built row per instance per window, carrying the builds, the last seq and the last row count", (t) => {
  const { rows, build } = agent(t);
  build(NOW);
  const first = rows.splice(0);
  // Each clock bucket is one build with no new fact, the cheapest build the view has.
  const minutes = AGENT_BUILT_ROW_WINDOW_MS / AGENT_CLOCK_MS;
  for (let i = 1; i < minutes; i++) build(NOW + i * AGENT_CLOCK_MS);
  assert.deepEqual(rows, [], `${minutes - 1} builds inside the window write no row of their own`);
  build(NOW + AGENT_BUILT_ROW_WINDOW_MS);
  assert.deepEqual(rows, [{ instance: "core", builds: minutes, seq: first[0]!.seq, rows: first[0]!.rows }], "the window's builds are one row");

  // Control: the per-build row this replaces is what a zero window still writes, so the tally above is not an accident of the fixture.
  const each = agent(t, 0);
  for (let i = 0; i <= 3; i++) each.build(NOW + i * AGENT_CLOCK_MS);
  assert.deepEqual(each.rows.map((row) => row.builds), [1, 1, 1, 1]);
});

test("W1-T11978 criterion 2 (updated by W1-T11886): workstreams-view tallies equal builds on the next changed row", (t) => {
  const { rows, insert, idle } = workstreams(t);
  rows.splice(0);
  insert(NOW + 10_000);
  assert.deepEqual(rows.splice(0), [{ instances: 1, builds: 1, reused: TASKS.length - 1, derived: 1, repeats: 0 }],
    "the first warm build logs its changed counts immediately");
  insert(NOW + 20_000);
  insert(NOW + 30_000);
  idle(NOW + WORKSTREAMS_REUSE_AUDIT_MS + 1_000);
  assert.deepEqual(rows, [], "two equal builds stay silent even after the old flush window");
  insert(NOW + WORKSTREAMS_REUSE_AUDIT_MS + 5_000);
  assert.deepEqual(rows, [{ instances: 1, builds: 3, reused: 0, derived: TASKS.length, repeats: 2 }],
    "the audited build logs its own counts and tallies the two silent builds");
});

test("W1-T11978 criterion 3: a window with no build writes no row, and a view's first build after start is written at once", (t) => {
  const a = agent(t);
  a.build(NOW);
  assert.deepEqual(a.rows.map((row) => [row.instance, row.builds]), [["core", 1]], "the agent view's cold build is on the ledger at once");
  // The same clock bucket is not a build, however many windows the caller waits inside it.
  a.rows.splice(0);
  a.build(NOW + 1);
  a.build(NOW + 2);
  assert.deepEqual(a.rows, []);

  const w = workstreams(t);
  assert.deepEqual(w.rows.splice(0), [{ instances: 1, builds: 1, reused: 0, derived: TASKS.length, repeats: 0 }],
    "the workstreams view's cold build is on the ledger at once");
  w.insert(NOW + 10_000);
  assert.deepEqual(w.rows.splice(0).map((row) => row.reused), [TASKS.length - 1], "warm the view before the idle passes");
  for (const windows of [1, 2, 3]) w.idle(NOW + windows * WORKSTREAMS_REUSE_AUDIT_MS + 1_000);
  assert.equal(w.rows.length, 0, "three audit intervals with no build write nothing");
  w.insert(NOW + 4 * WORKSTREAMS_REUSE_AUDIT_MS);
  assert.deepEqual(w.rows, [{ instances: 1, builds: 1, reused: 0, derived: TASKS.length, repeats: 0 }],
    "the next changed build after idle passes is counted alone");
});
