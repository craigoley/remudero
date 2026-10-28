// test/a-now-view-body-is-stamped-as-of-what-its-board-read.test.ts — W1-T9458.
//
// The now view builds in stages. The board stage derives from the fact table as the projector had filled it; later
// stages run while the projector keeps ingesting. On 2026-10-14 a `verdict handed_off / freshness_yield` landed
// between them: the board still showed the run in review, the body's ledger source said it was as of a later row, and
// the shadow's gap window (view asOf, legacy asOf] no longer held the verdict, so 300 diffs from one task read `real`.
// This drives a real projector, store and view, and lands the verdict in that window from the host probe's seam,
// which runs after the board stage.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createNowView, type NowSlotState, type NowViewContext } from "#src/lib/now-view.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease, type ReadModelDb } from "#src/lib/read-model-db.js";
import type { GitHub } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";
import type { ViewSource } from "#src/lib/views.js";

const T0 = Date.parse("2026-10-14T12:42:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

function gateway(): GitHub {
  return {
    readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
    issueByUrl: () => ({ state: "OPEN", title: "stuck" }),
  } as unknown as GitHub;
}

test("W1-T9458: a now-view body is stamped as of what its board read", (t) => {
  const root = makeTempDir("now-board-asof");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock: Clock = { now: () => T0, date: () => new Date(T0), iso: () => new Date(T0).toISOString() };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const db: ReadModelDb = openProjectorReadModel(join(root, "read-model-home"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock });
  const live = join(ledgerDir, "ledger.ndjson");
  const append = (row: Record<string, unknown>): void => appendFileSync(live, `${JSON.stringify({ host: "h1", run_id: "RUN-1", task_id: "W1-T1", ...row })}\n`);
  append({ ts: at(-1_200_000), step: "run.start", lane: "run-task" });
  append({ ts: at(-600_000), step: "implement.done", lane: "run-task" });
  projector.tick();

  // The slot state is one live object, as the worker's is: the projector's ticks move its newestTs.
  const state: NowSlotState = { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: T0, newestTs: at(-600_000) };
  const VERDICT_AT = at(-8_000);
  let landed = false;
  const stamped: Array<string | null> = [];
  const tasks = [task("W1-T1")];
  const plan = (): Plan => ({ tasks, byId: new Map(tasks.map((x) => [x.id, x])) });
  const view = createNowView({
    instances: [{ name: "core", ledgerDir }], clock, readPlan: plan,
    github: () => ({ github: gateway(), generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: {
      // The probe stage runs after the board stage: the verdict lands here, between the board and assemble.
      rateLimit: () => {
        if (!landed) {
          landed = true;
          append({ ts: at(-8_001), step: "run.freshness_handoff", lane: "run-task" });
          append({ ts: VERDICT_AT, step: "verdict", lane: "run-task", verdict: "handed_off", reason: "freshness_yield", waiting_on: "worker_round" });
          projector.tick();
          state.newestTs = VERDICT_AT;
        }
        return 4321;
      },
      diskFree: () => 1,
    },
    ledgerSource: (s, now): ViewSource => {
      stamped.push(s.newestTs);
      void now;
      return { name: `ledger:${s.instance}`, asOf: s.newestTs, state: "fresh" };
    },
  });
  const ctx: NowViewContext = { now: T0, switches: { views: { now: "serve" } }, instances: [{ state, db }] };
  const bodies = view.materialize(ctx);
  assert.equal(bodies.length, 1);
  assert.ok(landed, "the verdict landed while the build ran");

  // The board read the fact table before the verdict: the run is still in review.
  const board = (bodies[0]!.data as { board: { tasks: Array<{ taskId: string; phase?: string }> } }).board;
  assert.equal(board.tasks.find((x) => x.taskId === "W1-T1")?.phase, "review", "the board stage read no verdict");

  // So the body must not claim the verdict: its ledger source is as of what the board read.
  assert.deepEqual(stamped, [at(-600_000)], "the ledger source is stamped with the board stage's newestTs");
  const ledger = bodies[0]!.sources.find((s) => s.name === "ledger:core");
  assert.equal(ledger?.asOf, at(-600_000));
  assert.ok(ledger!.asOf! < VERDICT_AT, "the verdict falls inside the shadow's gap window (view asOf, legacy asOf]");
  assert.equal(state.newestTs, VERDICT_AT, "the live state moved on, and the stamp did not follow it");

  // Control: the next build reads the verdict, which ends the run as legacy reads it (any verdict is terminal), and
  // is stamped as of it.
  state.generation = Number(db.meta("generation"));
  const next = view.materialize(ctx);
  assert.equal(next.length, 1, "the next generation rebuilds");
  const after = (next[0]!.data as { board: { tasks: Array<{ taskId: string; phase?: string; status?: string }> } }).board.tasks.find((x) => x.taskId === "W1-T1");
  assert.equal(after?.phase, undefined, "a freshness yield ends the run");
  assert.equal(after?.status, "queued");
  assert.equal(stamped.at(-1), VERDICT_AT);
});
