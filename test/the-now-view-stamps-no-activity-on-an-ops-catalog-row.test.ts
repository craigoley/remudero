/**
 * An ops catalog task's board row carries its id, title, status and acceptance and no other field (W1-T12211). The now
 * view re-joined each task's newest activity time after that whitelist, so ops rows carried it, sorted by it, and took
 * the shown queued slots of public tasks, while legacy sorted them last.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createNowView, NOW_QUEUED_ROWS, type NowViewContext, type NowViewData } from "#src/lib/now-view.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import type { BoardCatalogClient, BoardCatalogContext } from "#src/lib/serve-plan-reload.js";
import type { GitHub } from "#src/lib/status.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-22T02:00:00.000Z");
const at = (secondsAgo: number): string => new Date(T0 - secondsAgo * 1_000).toISOString();
const task = (id: string): Task => ({ id, title: `${id} title`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const planOf = (tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map((t) => [t.id, t])) });
const GITHUB = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
  listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
  issueByUrl: () => null,
} as unknown as GitHub;

const PUBLIC = Array.from({ length: NOW_QUEUED_ROWS }, (_, i) => task(`W1-T${i + 1}`));
const OPS = [task("W1-T901"), task("W1-T902")];

function bodies(t: { after: (fn: () => void) => void }, shownPublic: readonly Task[] = PUBLIC): { view: NowViewData; legacy: NowViewData } {
  const root = readModelFixtureDir(t, "now-ops-activity").dir;
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  // The ops tasks' rows are the newest, so a row that sorts by them would lead the queued group.
  const rows = [
    ...shownPublic.map((p, i) => ({ ts: at(200 - i), step: "implement.done", task_id: p.id, host: "h1" })),
    ...OPS.map((o, i) => ({ ts: at(20 - i), step: "implement.done", task_id: o.id, host: "h1" })),
  ];
  appendFileSync(join(ledgerDir, "ledger.ndjson"), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const clock = fixedClock(T0);
  const db = openProjectorReadModel(join(root, "home"), "core", clock);
  onReadModelClose(t, () => db.close());
  const leased = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(leased.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: leased.lease, clock });
  for (let i = 0; i < 20; i++) projector.tick();
  const publicPlan = planOf([...shownPublic]);
  const context = { outcome: "ok", observedAt: at(1), taskCount: OPS.length, plan: planOf([...shownPublic, ...OPS]), publicPlan,
    opsIds: new Set(OPS.map((o) => o.id)) } as unknown as BoardCatalogContext;
  const catalogs: BoardCatalogClient = { current: () => context, revision: () => "r1", accept: () => {} };
  const view = createNowView({
    instances: [{ name: "core", ledgerDir, repo: "o/r" }], clock, catalogs,
    readPlan: () => publicPlan,
    github: () => ({ github: GITHUB, generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { readLive: () => [], diskFree: () => 1_000_000, rateLimit: () => 5_000 },
    dependencyGates: () => [], planBehind: () => ({ commits: 0 }), listGrilling: () => [],
  });
  const ctx: NowViewContext = { now: T0, switches: { views: { now: "shadow" } }, instances: [{
    state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: T0, newestTs: null },
    db, lease: leased.lease,
  }] };
  const [body] = view.materialize(ctx);
  assert.ok(body, "the now body materialized");
  const legacy = view.legacy!(body.key, T0, body.data);
  assert.ok(legacy, "the shadow's legacy side was computed");
  return { view: body.data, legacy: legacy.data as NowViewData };
}

test("W1-T14325 criterion 1: an ops row's activity neither orders the queued group nor takes a public task's shown slot", (t) => {
  const { view } = bodies(t);
  assert.deepEqual(view.board.groups.queued.slice(-OPS.length).sort(), OPS.map((o) => o.id).sort(), "ops rows sort after every public row with activity");
  assert.deepEqual(view.board.tasks.map((row) => row.taskId).sort(), PUBLIC.map((p) => p.id).sort(), "the shown queued rows are the public tasks");
});

test("W1-T14325 criterion 2: no ops row in the now body or in its legacy side carries an activity time", (t) => {
  // Few public tasks, so the ops rows take shown queued slots of their own.
  const few = PUBLIC.slice(0, 3);
  const { view, legacy } = bodies(t, few);
  for (const body of [view, legacy]) {
    assert.equal(body.board.tasks.filter((r) => r.catalog === "ops").length, OPS.length, "the ops rows are shown");
    for (const row of body.board.tasks.filter((r) => r.catalog === "ops")) assert.equal(Object.hasOwn(row, "lastActivityAt"), false, row.taskId);
  }
  assert.equal(view.board.tasks.find((row) => row.taskId === few.at(-1)!.id)?.lastActivityAt, at(200 - (few.length - 1)), "a public row keeps its activity time");
});

test("W1-T14325 criterion 3: the now view and legacy list the same groups and task rows for a composed catalog", (t) => {
  const { view, legacy } = bodies(t);
  assert.deepEqual(view.board.groups, legacy.board.groups);
  assert.deepEqual(view.board.tasks, legacy.board.tasks);
});
