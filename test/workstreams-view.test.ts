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
import { buildOperatorActivityProjection, buildOperatorActivityRoute, OPERATOR_ACTIVITY_MAX_ITEMS, type OperatorActivityEnvelope, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import type { ReadModelDb } from "../src/lib/read-model-db.js";
import { createReadModelTicker, ledgerSource, type ReadModelInstanceState, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { buildBatchedGithub, projectPlan, readLedgerLines, SERVE_KEEPS_CREDITS_IN_MEMORY, type BatchedPr, type GitHub } from "../src/lib/status.js";
import { threadPlan } from "../src/lib/thread-plan.js";
import { makeTempDir } from "../src/lib/tmp.js";
import type { ViewBodyEntry } from "../src/lib/views.js";
import { createWorkstreamsView, readActivityRing, WORKSTREAMS_DEBOUNCE_MS, WORKSTREAMS_VIEW_NAME, type WorkstreamsData } from "../src/lib/workstreams-view.js";
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

/** A gateway over merged PRs: A credited off its run branch, D's run-branch merge refused by an override. */
function creditedGateway(): ReturnType<NonNullable<Parameters<typeof createWorkstreamsView>[0]["github"]>> {
  const pr = (number: number, headRefName: string, title: string): BatchedPr => ({ number, url: `https://github.com/${REPO}/pull/${number}`, state: "MERGED", headRefName, title, body: `${title}\n` });
  const github = buildBatchedGithub("craigoley", "remudero", {
    ttlMs: Number.MAX_SAFE_INTEGER,
    fetchAll: () => [pr(11, "run-A-1700000000000", "build A"), pr(12, "run-D-1700000000000", "build D"), pr(13, "feature-x", "an unrelated change")],
    fetchAllIssues: () => [],
    commitTrailerIndex: () => new Map(),
    // A credit's plan-only check asks for a PR's changed files: this fixture's own refusal, not the shared stub's.
    exec: () => {
      throw new Error("offline: this fixture answers no GitHub read");
    },
  });
  return { github, source: { asOf: iso(NOW), state: "fresh" } };
}

/** The pre-2026-10-06 build of one instance's entry, verbatim: a full `projectPlan` pass, its warning and prose walk included. */
function previousBuild(f: Fixture, db: ReadModelDb, gateway: GitHub, now: number): OperatorActivityEnvelope {
  const ring = readActivityRing(db);
  const plan = threadPlan(f.planPath);
  const live = readLedgerLines(f.ledgerPath);
  const projection = projectPlan(plan, { ledgerPath: f.ledgerPath, github: gateway, readLedger: () => live, writeCreditStore: SERVE_KEEPS_CREDITS_IN_MEMORY });
  const githubReadFailed = gateway.readFailed?.() === true;
  return buildOperatorActivityProjection({
    plan, projection, ledgerLines: Object.assign(ring, { torn: 0, present: live.present !== false }), frontierLedgerLines: live, githubReadFailed, now: () => now,
  });
}

/** One tick of the projector fills the ring; the context it hands a view is kept, its store open until release. */
function projectedContext(t: TestCtx, f: Fixture): Parameters<ReturnType<typeof createWorkstreamsView<ReadModelInstanceState>>["prepare"]>[0] {
  let captured: Parameters<ReturnType<typeof createWorkstreamsView<ReadModelInstanceState>>["prepare"]>[0] | undefined;
  const capture = { name: WORKSTREAMS_VIEW_NAME, version: 1, materialize: (ctx: typeof captured) => ((captured = ctx), []) };
  switchViewsOn(f.stateDir, [WORKSTREAMS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [capture as never], clock: movingClock(NOW), holder: "workstreams-test", oracle: "off", post: () => {} });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  assert.ok(captured?.instances[0]?.db, "control: the projector handed the view its store");
  return captured;
}

test("unit test: the workstreams build answers the body the previous full-pass build answered over the same inputs", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "plan", "credit-overrides.yaml"), `- task: D\n  pr: 12\n  action: remove-credit\n  reason: "built the wrong thing"\n  author_class: operator\n`);
  const gateway = creditedGateway();
  const ctx = projectedContext(t, f);
  const view = createWorkstreamsView<ReadModelInstanceState>({ instances: f.instances, ledgerSource, github: () => gateway, planBehind: () => ({ commits: 0 }) });
  const [built] = view.materialize(ctx);
  const was = previousBuild(f, ctx.instances[0]!.db!, gateway.github, ctx.now);
  const items = (was as Extract<OperatorActivityEnvelope, { items: unknown }>).items;
  // POSITIVE CONTROLS: the credit, the override and the activity rows all reach the compared body.
  assert.ok(items.some((i) => i.taskId === "B" && i.kind === "workstream" && i.state === "queued"), `A's credit frees B: ${JSON.stringify(items)}`);
  assert.ok(items.some((i) => i.taskId === "D" && i.kind === "workstream" && i.state === "queued"), "the override keeps D unbuilt");
  assert.equal(items.filter((i) => i.kind === "activity").length, ROWS.length);
  assert.equal(JSON.stringify(built!.data.instances[0]!.activity), JSON.stringify(was), "byte-identical to the previous build's body");
});

test("unit test: the workstreams build yields after each stage and publishes the one-pass body", (t) => {
  const f = fixture(t);
  const gateway = creditedGateway();
  const ctx = projectedContext(t, f);
  const opts = { instances: f.instances, ledgerSource, github: () => gateway, planBehind: () => ({ commits: 0 }) };
  const onePass = createWorkstreamsView<ReadModelInstanceState>(opts).materialize(ctx)[0]!;
  const view = createWorkstreamsView<ReadModelInstanceState>(opts);
  // A pass whose budget is spent after its first step, as `stepsUntil` past its deadline allows.
  const oneStep = (): (() => boolean) => {
    let first = true;
    return () => {
      const allowed = first;
      first = false;
      return allowed;
    };
  };
  const passes: Array<string[]> = [];
  let ready = false;
  while (!ready && passes.length < 20) {
    ready = view.prepare(ctx, oneStep());
    passes.push(Object.keys(view.stages() ?? {}));
  }
  assert.deepEqual(passes, [["core.ring"], ["core.plan"], ["core.github"], ["core.ledger"], ["core.projection"], ["core.assemble"]], "one stage a pass, each named for slow_view");
  const [built] = view.materialize(ctx);
  assert.equal(JSON.stringify(built!.data), JSON.stringify(onePass.data), "the yielding build publishes the one-pass body");
  assert.ok(Object.keys(view.stages() ?? {}).includes("core.behind"), "materialize times its plan-behind read too");
  assert.equal(view.prepare(ctx, oneStep()), true, "an unchanged ring starts no new build");
});

/** A ring and projection both full: 210 rows a second apart before NOW, so one more row pushes the oldest out. */
function fullLedger(f: Fixture): void {
  const rows = Array.from({ length: 210 }, (_, n) => JSON.stringify({ ts: iso(NOW - (210 - n) * 1_000), step: "worker.activity", run_id: "r2", task_id: "D", n }));
  appendFileSync(f.ledgerPath, rows.map((line) => `${line}\n`).join(""));
}

function capped(data: WorkstreamsData): Array<{ id: string }> {
  return (data.instances[0]!.activity as unknown as { items: Array<{ id: string }> }).items;
}

test("unit test: a row appended after the ring was read, with a ts before its newest, is not a workstreams shadow diff", (t) => {
  const f = fixture(t);
  fullLedger(f);
  const view = createWorkstreamsView<ReadModelInstanceState>({ instances: f.instances, ledgerSource });
  const posted: ReadModelWorkerMessage[] = [];
  switchViewsOn(f.stateDir, [WORKSTREAMS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [view], clock: movingClock(NOW), holder: "workstreams-test", oracle: "off", post: (m) => posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  const data = bodiesOf(posted).at(-1)!.body.data as WorkstreamsData;
  assert.equal(capped(data).length, OPERATOR_ACTIVITY_MAX_ITEMS, "positive control: the body is at its cap, so one more row drops the oldest");
  // The 2026-10-06 16:39:03Z shape: `pr.stuck` stamped 16:38:29Z was appended after rows stamped up to 16:38:43Z,
  // so the ring, read before the projector applied it, lacked it while legacy's ts bound let it in.
  const late = { ts: iso(NOW - 30_000), step: "pr.stuck", run_id: "DAEMON-1", task_id: "SWEEP", blocker: "awaiting-review" };
  assert.ok(Date.parse(late.ts) < NOW - 1_000, "control: the late row's ts is before the ring's newest row");
  appendFileSync(f.ledgerPath, `${JSON.stringify(late)}\n`);
  const legacy = view.legacy("", NOW + 60_000, data);
  assert.ok(legacy);
  assert.deepEqual(legacy.data, data, "legacy reads the live file only as far as the projector had applied it");
});

test("unit test: a row the projector applied but the ring lacks is still a workstreams shadow diff", (t) => {
  const f = fixture(t);
  fullLedger(f);
  const view = createWorkstreamsView<ReadModelInstanceState>({ instances: f.instances, ledgerSource });
  // The ring loses a row the projector applied: the shadow must still see it, never derive legacy from the ring.
  const lossy = { name: view.name, version: view.version, materialize: (ctx: Parameters<typeof view.materialize>[0]) => {
    for (const { db } of ctx.instances) db?.prepare("DELETE FROM activity_ring WHERE body LIKE '%\"n\":205%'").run();
    return view.materialize(ctx);
  } };
  const posted: ReadModelWorkerMessage[] = [];
  switchViewsOn(f.stateDir, [WORKSTREAMS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [lossy], clock: movingClock(NOW), holder: "workstreams-test", oracle: "off", post: (m) => posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  const data = bodiesOf(posted).at(-1)!.body.data as WorkstreamsData;
  const legacy = view.legacy("", NOW + 60_000, data);
  assert.ok(legacy);
  const legacyIds = capped(legacy.data as WorkstreamsData).map((i) => i.id);
  const viewIds = new Set(capped(data).map((i) => i.id));
  assert.deepEqual(legacyIds.filter((id) => !viewIds.has(id)).length, 1, "the lost row is legacy's alone");
  assert.notDeepEqual(legacy.data, data);
});
