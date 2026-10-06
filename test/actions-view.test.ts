// W1-T5052 (arch Phase 4 P4-T13): the `actions` view answers GET /v1/action-results's body from the
// projector's external_effect.reconciled facts, materialized in the read-model worker.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildActionResultsRoute } from "../src/lib/action-results.js";
import { ACTIONS_VIEW_NAME, createActionsView, type ActionsData } from "../src/lib/actions-view.js";
import type { Clock } from "../src/lib/clock.js";
import { isFactStep } from "../src/lib/ledger-projector.js";
import { createReadModelTicker, ledgerSource, type ReadModelInstanceState, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import type { ViewBodyEntry } from "../src/lib/views.js";
import { writeLedger, type LedgerFixture } from "./helpers/ledger-fixture.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";

type TestCtx = { after: (fn: () => void) => void };

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const STEP = "external_effect.reconciled";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function effect(id: string, at: number): Record<string, unknown> {
  return {
    version: "external-effect-v1", originatingActionId: id, originatingReceiptId: `receipt-${id}`, capabilityGrantId: `grant-${id}`,
    connector: "provider", targetIdentity: "provider:account", requestedOperation: "rotate-secret", preconditionSnapshot: { status: "ready" },
    expectedPostconditions: [{ path: "status", equals: "ready" }], observation: { status: "fresh", observedAt: iso(at), ageMs: 10, maxAgeMs: 5_000 },
    idempotencyKey: `key-${id}`, reconciliationState: "applied", retryPath: { kind: "none", allowed: false, reason: "applied" },
    evidenceReference: `sha256:${"a".repeat(64)}`, safeToComplete: true,
  };
}

function reconciled(id: string, at: number): Record<string, unknown> {
  return { ts: iso(at), step: STEP, task_id: "W1-T1", external_effect: effect(id, at) };
}

/** Core's state dir: one reconciled row in a rotated archive, one in the live file, among rows of other steps. */
function seeded(t: TestCtx): { stateDir: string; instances: Array<{ name: string; ledgerDir: string }>; rows: LedgerFixture } {
  const root = makeTempDir("actions-view");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const rows = writeLedger([reconciled("live-action", NOW - 60_000), { ts: iso(NOW - 30_000), step: "daemon.tick" }], {
    dir: stateDir,
    rotations: [{ at: iso(NOW - 3_600_000), rows: [{ ts: iso(NOW - 2 * 3_600_000), step: "run.start", run_id: "r1", task_id: "W1-T1" }, reconciled("archived-action", NOW - 2 * 3_600_000 + 1)] }],
  });
  return { stateDir, instances: [{ name: "core", ledgerDir: stateDir }], rows };
}

function movingClock(start: number): Clock & { set(ms: number): void } {
  let at = start;
  return { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString(), set: (ms) => void (at = ms) };
}

function bodiesOf(posted: readonly ReadModelWorkerMessage[]): ViewBodyEntry[] {
  return posted.flatMap((m) => (m.type === "body" && m.entry.view === ACTIONS_VIEW_NAME ? [m.entry] : []));
}

async function routeBody(ledgerPath: string): Promise<Record<string, unknown>> {
  let status = 0;
  let body = "";
  const response = { writeHead: (code: number) => void (status = code), end: (value: string) => void (body = value) } as never;
  await buildActionResultsRoute(ledgerPath).handler({ url: "/v1/action-results" } as never, response, { params: {} });
  assert.equal(status, 200);
  return JSON.parse(body) as Record<string, unknown>;
}

/** The route stamps its own request time; the view stamps its build time. */
function withoutGeneratedAt(value: object): Record<string, unknown> {
  const { generatedAt: _generatedAt, ...rest } = value as Record<string, unknown>;
  return rest;
}

test("W1-T5052: the actions view equals the action results route over the same ledger", async (t) => {
  const f = seeded(t);
  const view = createActionsView<ReadModelInstanceState>({ instances: f.instances, ledgerSource });
  const posted: ReadModelWorkerMessage[] = [];
  switchViewsOn(f.stateDir, [ACTIONS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [view], clock: movingClock(NOW), holder: "actions-test", oracle: "off", post: (m) => posted.push(m) });
  ticker.start();
  ticker.tick();
  ticker.release();
  const bodies = bodiesOf(posted);
  assert.equal(bodies.length, 1, "one actions body per pass");
  assert.deepEqual(bodies[0]!.body.sources.map((s) => s.name), ["ledger:core"]);
  const data = bodies[0]!.body.data as ActionsData;
  assert.deepEqual(data.instances.map((i) => i.instance), ["core"]);

  const route = await routeBody(f.rows.path);
  // POSITIVE CONTROL: the route reaches the archived row, so a live-file-only fold cannot match it.
  assert.equal(isFactStep(STEP), true);
  assert.deepEqual((route.results as Array<{ originatingActionId: string }>).map((r) => r.originatingActionId), ["live-action", "archived-action"]);
  assert.deepEqual(withoutGeneratedAt(data.instances[0]!.results), withoutGeneratedAt(route));
});

test("unit test: the actions view rebuilds only when a reconciled fact is applied", (t) => {
  const f = seeded(t);
  const clock = movingClock(NOW);
  const view = createActionsView<ReadModelInstanceState>({ instances: f.instances, ledgerSource });
  const posted: ReadModelWorkerMessage[] = [];
  switchViewsOn(f.stateDir, [ACTIONS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [view], clock, holder: "actions-test", oracle: "off", post: (m) => posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  const datas = (): ActionsData[] => bodiesOf(posted).map((b) => b.body.data as ActionsData);
  const first = datas().at(-1)!;
  f.rows.append([{ ts: iso(NOW + 500), step: "run.start", run_id: "r2", task_id: "W1-T2" }]);
  clock.set(NOW + 1_000);
  ticker.tick();
  assert.deepEqual(datas().at(-1), first, "control: a fact of another step leaves the body as built");
  assert.equal(datas().at(-1)!.instances[0]!.results.generatedAt, iso(NOW), "it was not rebuilt");
  f.rows.append([reconciled("new-action", NOW + 1_500)]);
  clock.set(NOW + 2_000);
  ticker.tick();
  const rebuilt = datas().at(-1)!.instances[0]!.results;
  assert.equal(rebuilt.generatedAt, iso(NOW + 2_000));
  assert.deepEqual(rebuilt.results?.map((r) => r.originatingActionId), ["new-action", "live-action", "archived-action"]);
});

test("unit test: the actions shadow side reads the route's ledger union and an instance with no store answers unavailable", (t) => {
  const f = seeded(t);
  const instances = [...f.instances, { name: "orphan", ledgerDir: join(f.stateDir, "orphan") }];
  const view = createActionsView<ReadModelInstanceState>({ instances, ledgerSource });
  const state = (instance: string): ReadModelInstanceState => ({ instance, generation: 1, lease: "none", failures: 0, newestTs: null } as ReadModelInstanceState);
  // `orphan` has no store; `ghost` is projected but is no instance of this view.
  const widened = { name: view.name, version: view.version, materialize: (ctx: Parameters<typeof view.materialize>[0]) =>
    view.materialize({ ...ctx, instances: [...ctx.instances, { state: state("orphan") }, { state: state("ghost") }] }) };
  const posted: ReadModelWorkerMessage[] = [];
  switchViewsOn(f.stateDir, [ACTIONS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: f.instances, views: [widened], clock: movingClock(NOW), holder: "actions-test", oracle: "off", post: (m) => posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  const data = bodiesOf(posted)[0]!.body.data as ActionsData;
  assert.deepEqual(data.instances.map((i) => [i.instance, i.results.state, i.results.reason]), [["core", "verified", undefined], ["orphan", "unavailable", "ledger-unavailable"]]);
  // A row appended after the build is past the projector's frontier, so the shadow side does not read it as a diff.
  f.rows.append([reconciled("unapplied-action", NOW + 1_000)]);
  const legacy = view.legacy("", NOW + 60_000, data);
  assert.ok(legacy);
  assert.equal(legacy.asOfMs, NOW, "legacy is computed as of the body's build");
  assert.equal(data.instances[0]!.results.results?.length, 2, "control: the compared body has results");
  assert.deepEqual(legacy.data, data, "the route's union read, up to the projector's newest row, is the facts' body");
  assert.equal(view.legacy("", NOW, { instances: [] }), undefined, "a body this view did not build has no legacy side");
});
