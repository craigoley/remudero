// W1-T5050 (arch Phase 4 P4-T11): the `workstreams` view answers GET /v1/operator-activity's body from the
// projector's activity_ring, materialized in the read-model worker and debounced on ring inserts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { isFactStep } from "../src/lib/ledger-projector.js";
import { snapshotGithub } from "../src/lib/now-view.js";
import { buildOperatorActivityRoute, type OperatorActivityEnvelope, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createReadModelTicker, ledgerSource, type ReadModelInstanceState, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import type { ViewBodyEntry } from "../src/lib/views.js";
import { createWorkstreamsView, WORKSTREAMS_DEBOUNCE_MS, WORKSTREAMS_VIEW_NAME, type WorkstreamsData } from "../src/lib/workstreams-view.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";

type TestCtx = { after: (fn: () => void) => void };

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const REPO = "craigoley/remudero";
const PLAN_YAML = `
- id: A
  title: first task
  repo: ${REPO}
  type: implement
  depends_on: []
  status: queued
- id: B
  title: dependent task
  repo: ${REPO}
  type: implement
  depends_on: [A]
  status: queued
- id: D
  title: independent task
  repo: ${REPO}
  type: implement
  depends_on: []
  status: queued
`;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A ledger whose newest rows are mostly of steps the fact store does not keep. */
const ROWS: Array<Record<string, unknown>> = [
  { ts: iso(NOW - 6 * 3_600_000), step: "run.start", run_id: "r1", task_id: "A", repo: REPO, run_type: "implement" },
  { ts: iso(NOW - 5 * 3_600_000), step: "worker.activity", run_id: "r1", task_id: "A", kind: "working" },
  { ts: iso(NOW - 4 * 3_600_000), step: "worker.activity", run_id: "r1", task_id: "A", kind: "tool-executing" },
  { ts: iso(NOW - 3 * 3_600_000), step: "daemon.tick" },
  { ts: iso(NOW - 2 * 3_600_000), step: "run.start", run_id: "r2", task_id: "D", repo: REPO, run_type: "implement" },
  { ts: iso(NOW - 60_000), step: "worker.activity", run_id: "r2", task_id: "D", kind: "message" },
];

interface Fixture {
  root: string;
  stateDir: string;
  ledgerPath: string;
  planPath: string;
  instances: Array<{ name: string; ledgerDir: string; repo?: string; planPath?: string }>;
}

function fixture(t: TestCtx): Fixture {
  const root = makeTempDir("workstreams-view");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, PLAN_YAML);
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, ROWS.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return { root, stateDir, ledgerPath, planPath, instances: [{ name: "core", ledgerDir: stateDir, repo: REPO, planPath }] };
}

function movingClock(start: number): Clock & { set(ms: number): void } {
  let at = start;
  return { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString(), set: (ms) => void (at = ms) };
}

function routeDeps(f: Fixture): PanelGraphDeps {
  return {
    root: f.root,
    planPath: f.planPath,
    ledgerPath: f.ledgerPath,
    github: {} as never,
    // The same persisted-snapshot gateway the view reads, so both sides project the plan from one GitHub.
    statusGithub: snapshotGithub(f.root, "craigoley", "remudero").github,
    inboxRoot: f.stateDir,
    ratify: {} as never,
  };
}

async function routeBody(f: Fixture): Promise<Record<string, unknown>> {
  let status = 0;
  let body = "";
  const response = { writeHead: (code: number) => void (status = code), end: (value: string) => void (body = value) } as never;
  await buildOperatorActivityRoute(routeDeps(f)).handler({} as never, response, { params: {} });
  assert.equal(status, 200);
  return JSON.parse(body) as Record<string, unknown>;
}

/** The route stamps its own build time on the envelope and its plan rows; activity rows keep the row's time. */
function withoutProjectionTime(value: Record<string, unknown>): Record<string, unknown> {
  const { observedAt: _observedAt, ...rest } = value;
  if (!Array.isArray(rest.items)) return rest;
  return { ...rest, items: (rest.items as Array<{ kind: string }>).map((item) => (item.kind === "activity" ? item : { ...item, observedAt: "projection-time" })) };
}

function bodiesOf(posted: readonly ReadModelWorkerMessage[]): ViewBodyEntry[] {
  return posted.flatMap((m) => (m.type === "body" && m.entry.view === WORKSTREAMS_VIEW_NAME ? [m.entry] : []));
}

test("W1-T5050: the workstreams view equals the operator activity route over the same ledger", async (t) => {
  const f = fixture(t);
  const view = createWorkstreamsView<ReadModelInstanceState>({ instances: f.instances, ledgerSource });
  const posted: ReadModelWorkerMessage[] = [];
  switchViewsOn(f.stateDir, [WORKSTREAMS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [view], clock: movingClock(NOW), holder: "workstreams-test", oracle: "off", post: (m) => posted.push(m) });
  ticker.start();
  ticker.tick();
  ticker.release();
  const bodies = bodiesOf(posted);
  assert.equal(bodies.length, 1, "one workstreams body per pass");
  const data = bodies[0]!.body.data as WorkstreamsData;
  assert.deepEqual(data.instances.map((i) => i.instance), ["core"]);
  assert.deepEqual(bodies[0]!.body.sources.map((s) => s.name), ["ledger:core", "plan:core", "github:core"]);

  const route = await routeBody(f);
  const items = route.items as Array<{ kind: string; source: string; taskId?: string }>;
  // POSITIVE CONTROL: the route shows rows of a step the fact store drops, so a fact-only fold cannot match it.
  assert.equal(isFactStep("worker.activity"), false);
  assert.equal(items.filter((i) => i.source === "rmd:ledger:worker.activity").length, 3, JSON.stringify(items));
  assert.equal(items.filter((i) => i.kind === "activity").length, ROWS.length, "every ledger row is an activity");
  assert.ok(items.some((i) => i.kind === "workstream") && items.some((i) => i.kind === "artifact"), "the plan half is compared too");
  assert.deepEqual(withoutProjectionTime(data.instances[0]!.activity as unknown as Record<string, unknown>), withoutProjectionTime(route));
});

test("W1-T5050: a ring insert re-materializes the workstreams view once inside the debounce", (t) => {
  const f = fixture(t);
  const built: number[] = [];
  const clock = movingClock(NOW);
  const view = createWorkstreamsView<ReadModelInstanceState>({ instances: f.instances, ledgerSource, log: (step) => step === "workstreams.built" && built.push(clock.now()) });
  const posted: ReadModelWorkerMessage[] = [];
  switchViewsOn(f.stateDir, [WORKSTREAMS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [view], clock, holder: "workstreams-test", oracle: "off", post: (m) => posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  assert.deepEqual(built, [NOW], "the first body is built at once");
  ticker.tick();
  assert.equal(built.length, 1, "control: an unchanged ring builds nothing");
  // A burst: one insert per 250 ms tick, all inside one debounce window.
  for (const step of [1, 2, 3]) {
    const at = NOW + step * 250;
    appendFileSync(f.ledgerPath, `${JSON.stringify({ ts: iso(at - 10), step: "worker.activity", run_id: "r2", task_id: "D", n: step })}\n`);
    clock.set(at);
    ticker.tick();
  }
  assert.equal(built.length, 1, "no insert of the burst builds before the debounce elapses");
  clock.set(NOW + 250 + WORKSTREAMS_DEBOUNCE_MS);
  ticker.tick();
  clock.set(NOW + 250 + 2 * WORKSTREAMS_DEBOUNCE_MS);
  ticker.tick();
  assert.deepEqual(built, [NOW, NOW + 250 + WORKSTREAMS_DEBOUNCE_MS], "the burst is built once, a debounce after its first insert");
  const bodies = bodiesOf(posted);
  assert.equal(bodies.length, 2);
  const activity = (bodies[1]!.body.data as WorkstreamsData).instances[0]!.activity as Extract<OperatorActivityEnvelope, { items: unknown }>;
  assert.equal(activity.items.filter((i) => i.kind === "activity").length, ROWS.length + 3, "the one build carries every insert of the burst");
});

test("unit test: the workstreams shadow side reads the route's ledger union and a broken instance answers unavailable", (t) => {
  const f = fixture(t);
  const instances = [...f.instances, { name: "orphan", ledgerDir: join(f.root, "orphan") }];
  const view = createWorkstreamsView<ReadModelInstanceState>({ instances, ledgerSource });
  const state = (instance: string): ReadModelInstanceState => ({ instance, generation: 1, lease: "none", failures: 0, newestTs: null } as ReadModelInstanceState);
  // `orphan` has no store and no repository; `ghost` is projected but is no instance of this view.
  const widened = { name: view.name, version: view.version, materialize: (ctx: Parameters<typeof view.materialize>[0]) =>
    view.materialize({ ...ctx, instances: [...ctx.instances, { state: state("orphan") }, { state: state("ghost") }] }) };
  const posted: ReadModelWorkerMessage[] = [];
  switchViewsOn(f.stateDir, [WORKSTREAMS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [widened], clock: movingClock(NOW), holder: "workstreams-test", oracle: "off", post: (m) => posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  const [body] = bodiesOf(posted);
  const data = body!.body.data as WorkstreamsData;
  assert.deepEqual(data.instances.map((i) => [i.instance, i.activity.state]), [["core", "verified"], ["orphan", "unavailable"]]);
  const orphan = data.instances[1]!.activity as Extract<OperatorActivityEnvelope, { reason: string }>;
  assert.equal(orphan.reason, "projection-unavailable");
  assert.match(String(orphan.detail), /names no repository/);
  const legacy = view.legacy("", NOW + 60_000, data);
  assert.ok(legacy);
  assert.equal(legacy.asOfMs, NOW, "legacy is computed as of the body's build");
  assert.equal(((data.instances[0]!.activity as { items: unknown[] }).items).length > 0, true, "control: the compared body has items");
  assert.deepEqual(legacy.data, data, "the route's union read, up to the ring's newest row, is the ring's body");
  assert.equal(view.legacy("", NOW, { instances: [] }), undefined, "a body this view did not build has no legacy side");
});

test("unit test: same-millisecond rows of different steps and repositories, appended against their hash order, give the workstreams view the route's body", async (t) => {
  const f = fixture(t);
  // The 2026-10-05 shadow diffs: rows sharing one millisecond, numbered `:<n>` and ranked in file order by the
  // route but in `h` order by a version-1 ring. Two of one step, task and run differ only by repository.
  const at = iso(NOW - 30_000);
  const tied = [
    { ts: at, step: "serve.analytics_refresh.started", task_id: "SERVE", run_id: "SERVE-1", repository: "craigoley/remudero-site" },
    { ts: at, step: "serve.analytics_refresh.started", task_id: "SERVE", run_id: "SERVE-1", repository: "craigoley/remudero" },
    { ts: at, step: "board_gateway.fetch_bytes", task_id: "DAEMON", run_id: "DAEMON-1", repository: "craigoley/remudero-console" },
    { ts: at, step: "board_snapshot.unchanged", task_id: "DAEMON", run_id: "DAEMON-1" },
  ].map((row) => JSON.stringify(row));
  const h = (line: string): bigint => createHash("sha1").update(line).digest().readBigInt64BE(0);
  const byHash = [...tied].sort((a, b) => (h(a) < h(b) ? -1 : 1));
  const appended = [...byHash].reverse();
  assert.notDeepEqual(appended, byHash, "control: the file order is not the hash order");
  // An exact duplicate line is one event: the route's union keeps it once, and so must the ring.
  appendFileSync(f.ledgerPath, [...appended, appended[0]!].map((line) => `${line}\n`).join(""));
  const view = createWorkstreamsView<ReadModelInstanceState>({ instances: f.instances, ledgerSource });
  const posted: ReadModelWorkerMessage[] = [];
  switchViewsOn(f.stateDir, [WORKSTREAMS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [view], clock: movingClock(NOW), holder: "workstreams-test", oracle: "off", post: (m) => posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  const [body] = bodiesOf(posted);
  const activity = (body!.body.data as WorkstreamsData).instances[0]!.activity as unknown as Record<string, unknown>;
  const route = await routeBody(f);
  const ties = (route.items as Array<{ id: string; observedAt: string }>).filter((i) => i.observedAt === at);
  assert.equal(ties.length, tied.length, "positive control: every tied row, and its duplicate once, reaches the route");
  assert.deepEqual(withoutProjectionTime(activity), withoutProjectionTime(route));
});

test("unit test: a same-millisecond tie split by a rotation gives the workstreams view the route's body", async (t) => {
  const f = fixture(t);
  // The 2026-10-06 console shadow diffs: `sweep.repair_filing_suppressed` then `sweep.summary` at one
  // millisecond; the rotation at 10:06:52.919Z archived both and carried only the summary into the new live
  // file. The union reads it live first, the ring in the order the projector first applied the pair.
  const at = iso(NOW - 30_000);
  const suppressed = JSON.stringify({ ts: at, run_id: "DAEMON-1", task_id: "DAEMON", step: "sweep.repair_filing_suppressed", id: "fb-repair-blocked-fixable-2961" });
  const summary = JSON.stringify({ ts: at, run_id: "DAEMON-1", task_id: "DAEMON", step: "sweep.summary", mergeable: 0 });
  // Two rows of one step, task and millisecond: their `:<n>` numbers must not follow the read order either.
  const firstTick = JSON.stringify({ ts: at, step: "daemon.tick", n: 1 });
  const secondTick = JSON.stringify({ ts: at, step: "daemon.tick", n: 2 });
  const tied = [suppressed, summary, firstTick, secondTick];
  appendFileSync(f.ledgerPath, tied.map((line) => `${line}\n`).join(""));
  const view = createWorkstreamsView<ReadModelInstanceState>({ instances: f.instances, ledgerSource });
  const posted: ReadModelWorkerMessage[] = [];
  const clock = movingClock(NOW);
  switchViewsOn(f.stateDir, [WORKSTREAMS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [view], clock, holder: "workstreams-test", oracle: "off", post: (m) => posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  renameSync(f.ledgerPath, join(f.stateDir, "ledger.2026-09-30T11-59-45-000Z.ndjson"));
  writeFileSync(f.ledgerPath, [summary, secondTick].map((line) => `${line}\n`).join(""));
  clock.set(NOW + WORKSTREAMS_DEBOUNCE_MS);
  ticker.tick();
  clock.set(NOW + 2 * WORKSTREAMS_DEBOUNCE_MS);
  ticker.tick();
  const body = bodiesOf(posted).at(-1);
  const activity = (body!.body.data as WorkstreamsData).instances[0]!.activity as unknown as Record<string, unknown>;
  const route = await routeBody(f);
  const ties = (route.items as Array<{ id: string; observedAt: string }>).filter((i) => i.observedAt === at);
  assert.equal(ties.length, tied.length, "positive control: each tied row reaches the route once, from the live file or the archive");
  assert.ok(ties.some((i) => i.id === "fb-repair-blocked-fixable-2961"), "positive control: the archived-only partner is in the route's body");
  assert.deepEqual(withoutProjectionTime(activity), withoutProjectionTime(route));
});
