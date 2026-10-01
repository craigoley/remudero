import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { NOW_SLOW_STAGE_MS, createNowView, type NowViewContext, type NowViewOptions } from "../src/lib/now-view.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { createReadModelTicker, readModelSwitchesPath, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-01T08:00:00.000Z");
const PASS_MS = 2_500;
/** The falsifier's stage clock: five of the seven stages read a seam that costs this much. */
const STAGE_MS = 600;
const IDS = ["W1-T1", "W1-T2", "W1-T3"];

type TestCtx = { after: (fn: () => void) => void };

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };

const GATEWAY = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
  listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "t" }),
} as unknown as GitHub;

function handClock(): Clock & { advance(ms: number): void } {
  let ms = T0;
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString(), advance: (by) => void (ms += by) };
}

function scratch(t: TestCtx): string {
  const dir = makeTempDir("now-steps");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seededDir(root: string, clock: Clock): string {
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  appendFileSync(join(ledgerDir, "ledger.ndjson"), IDS.map((id) => `${JSON.stringify({ ts: clock.iso(), step: "worker.assignment", task_id: id, run_id: `r-${id}` })}\n`).join(""));
  return ledgerDir;
}

/** Every seam a stage reads costs `costMs` on the clock: plan, github, probe, decisions and the plan source. */
function seams(clock: Clock & { advance(ms: number): void }, costMs: number): Partial<NowViewOptions> {
  const cost = <T>(value: T): T => (clock.advance(costMs), value);
  return {
    readPlan: () => cost(PLAN),
    github: () => cost({ github: GATEWAY, generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 5_000, diskFree: () => cost(1_000_000), readLive: () => [] },
    listGrilling: () => cost([]),
    planBehind: () => cost({ commits: 0 }),
  };
}

test("W1-T5066: the now view builds an instance across bounded steps within the pass budget", (t) => {
  const root = scratch(t);
  const clock = handClock();
  const ledgerDir = seededDir(root, clock);
  const feedbackRoot = join(root, "checkout");
  mkdirSync(join(feedbackRoot, "plan", "feedback"), { recursive: true });
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { now: "shadow" } }));
  const instance = { name: "core", ledgerDir, repo: "o/r", feedbackRoot };
  const view = createNowView({ instances: [instance], clock, ...seams(clock, STAGE_MS) });
  const calls: number[] = [];
  const timed = {
    ...view,
    prepare: (ctx: NowViewContext, more: () => boolean) => {
      const started = clock.now();
      try {
        return view.prepare(ctx, more);
      } finally {
        calls.push(clock.now() - started);
      }
    },
  };
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [instance], clock, views: [timed], oracle: "off", passBudgetMs: PASS_MS, post: (m) => void posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  let ticks = 0;
  while (!posted.some((m) => m.type === "body" && m.entry.view === "now") && ticks < 20) {
    ticker.tick();
    ticks++;
    clock.advance(250);
  }
  const body = posted.find((m) => m.type === "body" && m.entry.view === "now");
  assert.ok(body?.type === "body", "the body was built");
  assert.deepEqual((body.entry.body.data as { board: { counts: unknown } }).board.counts, { running: 0, queued: 3, blocked: 0 });
  const working = calls.filter((ms) => ms > 0);
  assert.ok(working.length >= 2, `the build took ${working.length} prepare steps`);
  assert.ok(Math.max(...working) <= PASS_MS, `no step exceeded the pass: ${working.join(", ")} ms`);
  assert.equal(working.reduce((a, b) => a + b, 0), 5 * STAGE_MS, "every stage ran exactly once");
  assert.deepEqual(posted.filter((m) => m.type === "log" && m.step === "read_model.slow_view"), [], "no unit outgrew the pass");
});

function world(t: TestCtx) {
  const root = scratch(t);
  const clock = handClock();
  const ledgerDir = seededDir(root, clock);
  const db = openProjectorReadModel(join(root, "home"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  createLedgerProjector({ ledgerDir, db, lease: got.lease, clock }).tick();
  const feedbackRoot = join(root, "checkout");
  mkdirSync(join(feedbackRoot, "plan", "feedback"), { recursive: true });
  const ctx: NowViewContext = {
    now: clock.now(), switches: { views: { now: "shadow" } },
    instances: [{ state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null }, db, lease: got.lease }],
  };
  return { clock, ctx, instance: { name: "core", ledgerDir, repo: "o/r", feedbackRoot }, feedbackRoot };
}

test("W1-T5066: a stepped now body equals an unstepped build", (t) => {
  const w = world(t);
  const stepped = createNowView({ instances: [w.instance], clock: w.clock, ...seams(w.clock, 0) });
  let steps = 0;
  const oneStage = (): (() => boolean) => {
    let first = true;
    return () => {
      const allowed = first;
      first = false;
      return allowed;
    };
  };
  while (!stepped.prepare(w.ctx, oneStage())) steps++;
  assert.equal(steps, 6, "seven stages, one per step");
  assert.equal(stepped.prepare(w.ctx, oneStage()), true, "a finished build waits for materialize");
  const fromSteps = stepped.materialize(w.ctx);
  const unstepped = createNowView({ instances: [w.instance], clock: w.clock, ...seams(w.clock, 0) }).materialize(w.ctx);
  assert.equal(fromSteps.length, 1);
  assert.deepEqual(fromSteps, unstepped);
  assert.deepEqual(stepped.materialize(w.ctx), [], "nothing is due again until something moves");
});

test("W1-T5066: a stage slower than the pass is named in its own row", (t) => {
  const w = world(t);
  const logged: Array<Record<string, unknown>> = [];
  const view = createNowView({
    instances: [w.instance], clock: w.clock, log: (step, extra) => void logged.push({ step, ...extra }),
    ...seams(w.clock, 0), readPlan: () => (w.clock.advance(NOW_SLOW_STAGE_MS + 1), PLAN),
  });
  assert.equal(view.materialize(w.ctx).length, 1);
  assert.deepEqual(logged, [{ step: "read_model.now_slow_stage", instance: "core", stage: "plan", ms: NOW_SLOW_STAGE_MS + 1 }]);
});
