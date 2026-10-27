// test/serve-memory-names-what-the-heavy-view-lane-holds-beyond-its-boards.test.ts — W1-T9983.
// Retained-view accounting is named, cached at fill, and never substitutes for a heap reading.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { createHostView } from "#src/lib/host-view.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createNowView } from "#src/lib/now-view.js";
import type { Plan } from "#src/lib/plan.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import {
  createReadModelTicker, ledgerSource, type ReadModelInstanceState, type ReadModelWorkerMessage,
} from "#src/lib/read-model-worker.js";
import { createRepositoriesReadModelView, createRepositoriesSourcePublisher } from "#src/lib/repositories-view.js";
import type { GitHub } from "#src/lib/status.js";
import { closeReadModelFixture, readModelFixtureDir } from "#test/helpers/read-model-fixture.js";
import { answerThreadHeaps, THREAD_HEAPS_REQUEST, type WorkerThread } from "#src/lib/worker-heaps.js";
import * as heapMemory from "#src/lib/worker-heaps.js";
import { createWorkstreamsView } from "#src/lib/workstreams-view.js";
import { switchViewsOn } from "#test/helpers/read-model-switches.js";

type Hold = { entries: number; bytes?: number; unsized?: string; rows?: number; keptBytes?: number };
type Holds = Record<string, Hold>;
const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const CLOCK: Clock = { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() };
const PLAN: Plan = { tasks: [], byId: new Map() };
const GITHUB = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
  listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined,
  prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "fixture" }),
} as unknown as GitHub;

function scratch(t: TestContext): string {
  return readModelFixtureDir(t, "heavy-view-holders");
}

function sizes(view: unknown): Holds {
  const method = (view as { heldSizes?: () => Holds }).heldSizes;
  assert.equal(typeof method, "function", "every heavy-lane view exposes its own retained state");
  return method!();
}

test("W1-T9983: each heavy-lane view names what it keeps across builds", async (t) => {
  const root = scratch(t);
  mkdirSync(join(root, "state"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  let measured = 0;
  const measurement = { status: "unreadable" as const, reason: "fixture measurement",
    toJSON: () => { measured++; return { status: "unreadable", reason: "fixture measurement" }; } };
  const host = createHostView({ clock: CLOCK,
    config: { controlRoot: root, ledgerPath, skillsRoot: root },
    ledgerSource, rateLimit: async () => 1234, diskFree: () => 1_000_000,
    selfMeasurement: async () => measurement,
  });
  const workstreams = createWorkstreamsView({ instances: [], clock: CLOCK, ledgerSource });
  const views = [
    createNowView({ instances: [], clock: CLOCK }),
    workstreams,
    createRepositoriesReadModelView(ledgerSource), host,
  ];
  for (const view of views) sizes(view);
  assert.equal(workstreams.materialize({ now: NOW, instances: [] }).length, 1, "the real workstreams view retains its built body");
  const workstreamHolds = workstreams.heldSizes();
  assert.ok(workstreamHolds["workstreams:retained-body"]!.bytes! > 0);
  assert.equal(workstreamHolds["workstreams:shown"]!.bytes, undefined);
  assert.match(workstreamHolds["workstreams:shown"]!.unsized ?? "", /WeakMap/);
  const state: ReadModelInstanceState = { instance: "core", generation: 1, lease: "held", failures: 0, tickedAt: NOW, newestTs: null };
  const context = { now: NOW, instances: [{ state }] };
  assert.equal(host.materialize(context).length, 1, "positive control: the host retained a real materialized body");
  await new Promise<void>((resolve) => setImmediate(resolve));
  host.materialize(context);
  assert.ok(measured > 0, "the landed retained payload was accounted at fill, not left as a guessed zero");
  const atFill = measured;
  const held = sizes(host);
  assert.ok(Object.keys(held).some((name) => name.startsWith("host:")), "the holder keeps its view identity");
  assert.ok(Object.values(held).some((hold) => typeof hold.bytes === "number" && hold.bytes > 0), "positive accounted-byte control");
  const unsized = Object.values(held).filter((hold) => typeof hold.unsized === "string");
  assert.ok(unsized.length > 0, "shared or opaque state is explicitly named, not silently absent");
  for (const hold of unsized) assert.equal(hold.bytes, undefined, "an unknown size is not zero");
  for (let n = 0; n < 5; n++) sizes(host);
  assert.equal(measured, atFill, "reporting reads insertion-time counters instead of serializing the retained payload again");
});

test("W1-T9983: a lane that never builds now still reports its holds", (t) => {
  const stateDir = scratch(t);
  const instances = ["core", "site"].map(name => {
    const ledgerDir = join(stateDir, name);
    mkdirSync(ledgerDir);
    writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
    return { name, ledgerDir };
  });
  switchViewsOn(stateDir, ["workstreams"], "shadow");
  const projectorPosts: ReadModelWorkerMessage[] = [];
  const projector = createReadModelTicker({ stateDir, instances, views: [], oracle: "off", holder: "holders-fixture", clock: CLOCK,
    post: (message) => void projectorPosts.push(message) });
  projector.start();
  closeReadModelFixture(t, () => projector.release());
  const posts: ReadModelWorkerMessage[] = [];
  let built = 0;
  const view = { name: "workstreams", version: 1, perInstance: true,
    heldSizes: () => ({ "workstreams:fixture": { entries: built, bytes: built * 64 },
      "workstreams:opaque": { entries: 1, unsized: "fixture closure has no safe byte estimator" } }),
    materialize: () => { built++; return [{ key: "", data: { built }, sources: [] }]; },
  };
  const lane = createReadModelTicker({ stateDir, instances, views: [view], viewsOnly: true, lane: "fast", oracle: "off", holder: "holders-fixture", clock: CLOCK,
    passBudgetMs: 1_000_000, post: (message) => void posts.push(message) });
  lane.start();
  closeReadModelFixture(t, () => lane.release());
  projector.tick();
  const state = projectorPosts.findLast((message) => message.type === "state");
  assert.ok(state?.type === "state");
  lane.observe(state.instances as ReadModelInstanceState[]);
  lane.tick();
  assert.ok(posts.some((message) => message.type === "body" && message.entry.view === "workstreams"), `positive control: a non-now unit built (materialized=${built}; posts=${JSON.stringify(posts)})`);
  const reports = posts.filter((message) => message.type === "view_holds");
  assert.ok(reports.length > 0, "non-now builds publish their retained state");
  const last = reports.at(-1) as unknown as { holds: Holds };
  assert.equal(last.holds["workstreams:fixture@core"]?.bytes, built * 64);
  assert.equal(last.holds["workstreams:opaque@core"]?.bytes, undefined);
  assert.match(last.holds["workstreams:opaque@core"]?.unsized ?? "", /no safe byte estimator/);
  assert.ok(last.holds["lane:fast"], "the lane names its unit bookkeeping too");
  assert.equal(last.holds["workstreams:fixture@site"]?.bytes, built * 64, "same-named per-instance holders do not overwrite each other");
  assert.equal(last.holds["board:workstreams:fixture"], undefined, "a non-board holder is not relabeled as a board");
});

test("W1-T9983: payload counters replace, forget and leave unserializable state explicitly unknown", () => {
  const book = heapMemory.createViewHoldBook();
  const value = { label: "é", nested: new Map([["key", new Set([1, 2])]]) };
  book.account("fixture:payload", value, 1);
  const first = book.read()["fixture:payload"]!;
  assert.equal(first.bytes, Buffer.byteLength(JSON.stringify({ label: "é", nested: [["key", [1, 2]]] })));
  assert.match(first.bytes_basis ?? "", /not-exclusive-v8/);
  book.account("fixture:payload", { value: 1n }, 1);
  assert.equal(book.read()["fixture:payload"]!.bytes, undefined);
  assert.match(book.read()["fixture:payload"]!.unsized ?? "", /cannot be serialized/);
  book.account("fixture:missing", undefined, 1);
  assert.equal(book.read()["fixture:missing"]!.bytes, undefined);
  book.known("fixture:known", 3, 120);
  assert.equal(book.read()["fixture:known"]!.bytes, 120);
  book.known("fixture:known", 3, 0);
  assert.equal(book.read()["fixture:known"]!.bytes, undefined, "failed accounting is not zero bytes for retained rows");
  book.forget("fixture:known");
  book.known("fixture:empty", 0, 0);
  assert.equal(book.read()["fixture:empty"]!.bytes, 0, "an actually empty accounted store is different from unknown accounting");
  book.known("fixture:invalid", 1, Number.NaN);
  assert.equal(book.read()["fixture:invalid"]!.bytes, undefined);
  book.forget("fixture:empty");
  book.forget("fixture:invalid");
  book.forget("fixture:payload");
  book.forget("fixture:missing");
  assert.deepEqual(book.read(), {});
});

test("W1-T9983: a future holder timestamp is unknown age, not fresh zero", async () => {
  const thread = { threadId: 17, getHeapStatistics: async () => ({ total_heap_size: 1_000, used_heap_size: 600, external_memory: 50 }),
    once: () => undefined } as unknown as WorkerThread;
  const readings = await heapMemory.readWorkerHeaps([{ kind: "fixture:views", thread }], 1_000,
    () => ({ holds: { "fixture:payload": { entries: 1, bytes: 10 } }, observedAt: NOW + 1 }), CLOCK);
  const part = readings[0]!.parts!["thread-17"]!;
  assert.equal(part.holds_age_ms, undefined);
  assert.match(part.holds_age_reason ?? "", /ahead of sample clock/);
  assert.equal(part.unattributed_used_bytes, 640, "the arithmetic is separate from report-time certainty");
});

test("W1-T9983: a views-lane part carries its unattributed used bytes", async () => {
  const worker = (threadId: number, used: boolean): WorkerThread => ({ threadId,
    getHeapStatistics: async () => ({ total_heap_size: 1_000, external_memory: 50, ...(used ? { used_heap_size: 600 } : {}) }),
    once: () => undefined,
  }) as unknown as WorkerThread;
  const holds: Holds = { "workstreams:payload": { entries: 3, bytes: 120 },
    "workstreams:shared": { entries: 1, unsized: "shared plan identity; no exclusive byte size" } };
  const observedAt = NOW - 1_000;
  type Part = { bytes: number; used_bytes?: number; holds?: Holds; holds_age_ms?: number; unattributed_used_bytes?: number; unattributed_used_reason?: string };
  const answers: Array<{ readings: Array<{ parts: Record<string, Part> }> }> = [];
  const port = { postMessage: (message: unknown) => void answers.push(message as typeof answers[number]) };
  const ask = answerThreadHeaps as unknown as (p: typeof port, request: unknown, book: unknown, readHolds: (id: number) => { holds: Holds; observedAt: number }, clock: Clock) => boolean;
  assert.equal(ask(port, { type: THREAD_HEAPS_REQUEST, id: 1 }, { live: () => [
    { kind: "fixture:views", thread: worker(7, true) }, { kind: "fixture:views", thread: worker(8, false) },
  ] }, () => ({ holds, observedAt }), CLOCK), true);
  for (let n = 0; n < 20 && !answers.length; n++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(answers.length, 1, "the real heap-answer path completed");
  const parts = answers[0]!.readings[0]!.parts;
  assert.equal(parts["thread-7"]!.used_bytes, 650, "used heap plus external stays unchanged");
  assert.equal(parts["thread-7"]!.unattributed_used_bytes, 530, "known payload bytes are subtracted; unknown sizes are not invented");
  assert.deepEqual(parts["thread-7"]!.holds, holds);
  assert.equal(parts["thread-7"]!.holds_age_ms, 1_000, "the clock port says exactly how old the attribution is");
  assert.equal(parts["thread-8"]!.unattributed_used_bytes, undefined, "unknown used heap is never zero");
  assert.match(parts["thread-8"]!.unattributed_used_reason ?? "", /used.*(unavailable|unknown|not reported)/i);
});

test("W1-T9983: the real now view names its state beside its boards", (t) => {
  const root = scratch(t);
  const ledgerDir = join(root, "state");
  mkdirSync(ledgerDir);
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  const ledgerPath = join(ledgerDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const db = openProjectorReadModel(join(root, "home"), "core", CLOCK);
  closeReadModelFixture(t, () => db.close());
  const lease = acquireLease(db, { clock: CLOCK, ttlMs: 1e12 });
  assert.ok(lease.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: lease.lease, clock: CLOCK });
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date(NOW - 1_000).toISOString(), host: "fixture", step: "run.start", run_id: "fixture", task_id: "W1-T1" }) + "\n");
  projector.tick();
  const view = createNowView({ instances: [{ name: "core", ledgerDir, repo: "o/r", feedbackRoot: root }], clock: CLOCK,
    readPlan: () => PLAN, github: () => ({ github: GITHUB, generation: "fixture", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 1234, diskFree: () => 1_000_000, readLive: () => [] },
    listGrilling: () => [], planBehind: () => ({ commits: 0 }), boardOptions: { keepEveryRow: true },
  });
  const state: ReadModelInstanceState = { instance: "core", generation: 1, lease: "held", failures: 0, tickedAt: NOW, newestTs: null };
  const context = { now: NOW, switches: { views: { now: "shadow" as const } }, instances: [{ state, db }] };
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  createRepositoriesSourcePublisher({ stateDir: join(root, "home"), instances: () => [{ instanceId: "core", options: {
    root, ledgerPath, planPath: join(root, "plan", "tasks.yaml"), controlRoot: root, incidentsDir: ledgerDir,
    instanceRepository: { owner: "o", repo: "r" },
  } }] })();
  const repositories = createRepositoriesReadModelView(ledgerSource);
  assert.equal(repositories.materialize(context).length, 1, "the real repository view reads its private published inputs");
  const repositoryHolds = repositories.heldSizes();
  assert.equal(repositoryHolds["repositories:computed"]?.entries, 1, "the retained per-instance summary attempt is counted");
  for (const name of ["sources-reader", "registry-reader", "plan-reader", "parsed-repo-rows", "shown"]) {
    assert.match(repositoryHolds[`repositories:${name}`]?.unsized ?? "", /\S/);
    assert.equal(repositoryHolds[`repositories:${name}`]?.bytes, undefined);
  }
  while (!view.prepare(context, () => true)) { /* complete the private fixture build */ }
  assert.equal(view.materialize(context).length, 1, "positive control: the real now view built");
  const held = sizes(view);
  const board = held["board:core"] ?? held.core;
  assert.ok(board && (board.bytes ?? board.keptBytes ?? 0) > 0, "the board's positive byte control survives");
  assert.ok(Object.keys(held).some((name) => name.startsWith("now:") && name.includes("plan")), "retained plan state is named");
  assert.ok(Object.keys(held).some((name) => name.startsWith("now:") && name.includes("shown")), "weakly paired bodies remain explicit and unsized");
  const unsized = Object.values(held).filter((hold) => typeof hold.unsized === "string");
  assert.ok(unsized.length > 0);
  assert.ok(unsized.every((hold) => hold.bytes === undefined && hold.keptBytes === undefined));
});
