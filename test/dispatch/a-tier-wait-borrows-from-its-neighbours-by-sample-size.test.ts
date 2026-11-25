import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildDispatchValueContext, costOfDelayReadyRow } from "#src/lib/dispatch-value.js";
import type { DispatchValueContext, OperatorHoldState, TierWait } from "#src/lib/dispatch-value.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { dispatchValueContextForSelection } from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-17T02:00:00Z");
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, ...over,
});

interface Started { id: string; priority: number; wait: number }
interface Waiting { task: Task; filedAgo: number }

/** Started tasks are merged history in the plan; waiting tasks are the open queue. */
function calibrate(started: readonly Started[], waiting: readonly Waiting[], holds?: OperatorHoldState): DispatchValueContext {
  const rows: Array<Record<string, unknown>> = [];
  const filed = new Map<string, number>();
  for (const s of started) {
    const at = NOW - 30 * HOUR;
    filed.set(s.id, at - s.wait * HOUR);
    rows.push({ step: "run.start", task_id: s.id, run_id: s.id, task_class: "src", ts: new Date(at).toISOString() });
    rows.push({ step: "verdict", task_id: s.id, run_id: s.id, verdict: "merged", cost_usd: 2, ts: new Date(at + HOUR).toISOString() });
  }
  for (const w of waiting) filed.set(w.task.id, NOW - w.filedAgo);
  const tasks = [...started.map(s => task(s.id, { priority: s.priority })), ...waiting.map(w => w.task)];
  const result = buildDispatchValueContext(tasks, rows, new Set(waiting.map(w => w.task.id)), NOW, true, "seed", {
    planTreeSha: "tree-sha", filedAtByTaskId: filed,
  }, holds);
  assert.equal(result.kind, "ready");
  return result.context;
}

const tierWaits = (context: DispatchValueContext): readonly TierWait[] => costOfDelayReadyRow("tree-sha", context).tier_waits ?? [];
const tier = (context: DispatchValueContext, priority: number) => tierWaits(context).find(w => w.priority === priority);
/** Twelve starts per tier, waits `from` .. `from + 11` h: the sixth, `from + 5` h, is the tier's median. */
const spread = (idBase: number, priority: number, from: number): Started[] =>
  Array.from({ length: 12 }, (_, i) => ({ id: `W1-T${idBase + i}`, priority, wait: from + i }));
const unitOf = (context: DispatchValueContext, id: string) => context.costOfDelayInputsByTaskId?.get(id)?.median_wait_ms ?? NaN;

test("W1-T14643 criterion 1: one stale 164 h start among tiers near 33 h borrows from its neighbours", () => {
  // P1 and P3 each hold twelve starts at 28..39 h (median 33 h); P2 holds the one stale 164 h start.
  const started = [...spread(7000, 1, 28), { id: "W1-T7100", priority: 2, wait: 164 }, ...spread(7200, 3, 28)];
  const below = task("W1-T7300", { priority: 4 });
  const context = calibrate(started, [{ task: below, filedAgo: HOUR }]);
  const p2 = tier(context, 2);
  assert.equal(p2?.source, "shrunk");
  assert.ok((p2?.wait_ms ?? Infinity) < 40 * HOUR, `P2 reads ${(p2?.wait_ms ?? 0) / HOUR} h, not its single 164 h start`);
  assert.ok(Math.abs((p2?.wait_ms ?? 0) - (tier(context, 1)?.wait_ms ?? 0)) < 5 * HOUR, "P2 sits beside its neighbours' waits");
  // The envelope below it: on origin/main the single start became the aging unit of every lower tier.
  assert.ok(unitOf(context, below.id) < 40 * HOUR, `the lower tier ages in ${unitOf(context, below.id) / HOUR} h`);
  assert.ok(unitOf(context, below.id) < 164 * HOUR);
});

test("W1-T14643 criterion 1: the shrinkage weight is derived from the tiers' spread, not fixed", () => {
  // The same stale tier and the same neighbours, but the neighbours now differ (33 h and 53 h): the well-sampled
  // tiers disagree, so a tier is worth more on its own and the stale start borrows less than it did.
  const queue = (id: string) => [{ task: task(id, { priority: 4 }), filedAgo: HOUR }];
  const agree = calibrate([...spread(7400, 1, 28), { id: "W1-T7500", priority: 2, wait: 164 }, ...spread(7600, 3, 28)], queue("W1-T7550"));
  const differ = calibrate([...spread(7700, 1, 28), { id: "W1-T7800", priority: 2, wait: 164 }, ...spread(7900, 3, 48)], queue("W1-T7850"));
  assert.ok((tier(differ, 2)?.wait_ms ?? 0) > (tier(agree, 2)?.wait_ms ?? Infinity), "a wider spread between tiers lets the sparse tier keep more of its own");
});

test("W1-T14643 criterion 2: a record held on operator input is not a censored wait; a released or answered one is", () => {
  const started = Array.from({ length: 4 }, (_, i) => ({ id: `W1-T${8000 + i}`, priority: 1, wait: 2 }));
  const asked = { question: "which?", asked_at: "2026-10-01T00:00:00Z" };
  const held = [
    { task: task("W1-T8010", { priority: 1, needs_input: asked }), filedAgo: 20 * HOUR },
    { task: task("W1-T8011", { priority: 1, verify: "human" }), filedAgo: 20 * HOUR },
  ];
  const waiting = { task: task("W1-T8012", { priority: 1 }), filedAgo: 20 * HOUR };
  const without = calibrate(started, [waiting]);
  const unanswered = calibrate(started, [waiting, ...held], {});
  assert.equal(tier(unanswered, 1)?.censored, 1, "an unanswered question and an unreleased verify: human wait on the operator");
  assert.deepEqual(tier(unanswered, 1), tier(without, 1));
  const resolved = calibrate(started, [waiting, ...held], { releasedIds: () => new Set(["W1-T8011"]), inputAnswer: id => id === "W1-T8010" ? "the first" : undefined });
  assert.equal(tier(resolved, 1)?.censored, 3, "the answered and the released record are runnable, so they wait on the schedule");
  const blankAnswer = calibrate(started, [waiting, ...held], { inputAnswer: () => "  " });
  assert.equal(tier(blankAnswer, 1)?.censored, 1, "a blank answer is no answer, as plan.ts reads it");
});

test("W1-T14643 criterion 2: dispatch selection carries its lane's release and answer state into the censored sample", () => {
  const started = Array.from({ length: 4 }, (_, i) => ({ id: `W1-T${8100 + i}`, wait: 2 }));
  const asked = { question: "which?", asked_at: "2026-10-01T00:00:00Z" };
  const queued = [task("W1-T8110", { priority: 1, needs_input: asked }), task("W1-T8111", { priority: 1, verify: "human" }),
    task("W1-T8112", { priority: 1 })];
  const filed = new Map<string, number>(queued.map(t => [t.id, NOW - 20 * HOUR]));
  // The newest row pins the selection's clock at NOW, as calibrate() does.
  const rows: Array<Record<string, unknown>> = [{ step: "dispatch.refused_already_merged", task_id: "W1-T8199", ts: new Date(NOW).toISOString() }];
  for (const s of started) {
    const at = NOW - 30 * HOUR;
    filed.set(s.id, at - s.wait * HOUR);
    rows.push({ step: "run.start", task_id: s.id, run_id: s.id, task_class: "src", ts: new Date(at).toISOString() });
    rows.push({ step: "verdict", task_id: s.id, run_id: s.id, verdict: "merged", cost_usd: 2, ts: new Date(at + HOUR).toISOString() });
  }
  const tasks = [...started.map(s => task(s.id, { priority: 1 })), ...queued];
  const plan: Plan = { tasks, byId: new Map(tasks.map(t => [t.id, t])) };
  const open = new Set(queued.map(t => t.id));
  const select = (holds?: OperatorHoldState) => {
    const context = dispatchValueContextForSelection(plan, id => !open.has(id), "/fixture/state", () => {}, "/fixture/tasks.yaml",
      (() => ({ ok: true, rows, unread: [] })) as never,
      () => ({ kind: "ready", snapshot: { planTreeSha: "tree-sha", filedAtByTaskId: filed } }), holds);
    assert.ok(context);
    return tier(context, 1)?.censored;
  };
  assert.equal(select(), 1, "with no state, dispatch's own default holds back both records");
  assert.equal(select({ releasedIds: () => new Set(["W1-T8111"]), inputAnswer: id => id === "W1-T8110" ? "the first" : undefined }), 3,
    "the state the lane passes reaches the censored sample");
  // The production callers pass that state: the daemon its release readers and the answer reader its dispatch uses,
  // the drain its release readers (its dispatch reads no answers).
  const daemon = readFileSync(join(REPO_ROOT, "src/cli/commands/daemon.ts"), "utf8");
  const daemonCall = daemon.slice(daemon.indexOf("dispatchValueContextForSelection(dispatchPlan"), daemon.indexOf("inputAnswer: dispatchInputAnswer,"));
  assert.match(daemonCall, /releasedIds: \(\) => resolveReleasedIds\(/);
  assert.match(daemon, /taskInputAnswer: dispatchInputAnswer,/, "dispatch and the censored sample share one answer reader");
  const drain = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
  const drainCall = drain.slice(drain.indexOf("dispatchValueContextForSelection(dispatchPlan"));
  assert.match(drainCall.slice(0, 400), /releasedIds: \(\) => resolveReleasedIds\(releaseReadersFor\(/);
});

test("W1-T14643 criterion 3: a well-sampled tier keeps a wait within its own median's confidence band; the envelope stays monotone", () => {
  // Three tiers of twelve starts, medians 13 h, 33 h and 53 h; each within-tier variance is 13 h^2.
  const started = [...spread(8100, 1, 28), ...spread(8200, 2, 8), ...spread(8300, 3, 48)];
  const waiting = [1, 2, 3].map(priority => ({ task: task(`W1-T840${priority}`, { priority }), filedAgo: HOUR }));
  const context = calibrate(started, waiting);
  const band = 1.96 * Math.sqrt(Math.PI / 2 * 13 / 12) * HOUR;
  for (const [priority, median] of [[1, 33], [2, 13], [3, 53]] as const) {
    const wait = tier(context, priority)?.wait_ms ?? NaN;
    assert.ok(Math.abs(wait - median * HOUR) <= band, `P${priority} reads ${wait / HOUR} h against its own ${median} h`);
  }
  const units = [1, 2, 3].map(priority => unitOf(context, `W1-T840${priority}`));
  assert.ok(units[0] <= units[1] && units[1] <= units[2], `the envelope runs ${units.map(u => u / HOUR).join(" <= ")} h`);
  assert.ok(units[1] >= (tier(context, 1)?.wait_ms ?? Infinity), "a lower tier never ages faster than a higher tier waits");
});

test("W1-T14643 criterion 3: an unequal sample (200/200/50) keeps the smaller tier's own 40 h inside its band", () => {
  // `count` starts at `median` h with five evenly filled levels a quarter hour apart: the median is exact and
  // the within-tier variance is about 0.13 h^2, so a 50-start tier's band is about 0.12 h.
  const level = (idBase: number, priority: number, count: number, median: number): Started[] =>
    Array.from({ length: count }, (_, i) => ({ id: `W1-T${idBase + i}`, priority, wait: median + ((i % 5) - 2) * 0.25 }));
  const started = [...level(10000, 1, 200, 10), ...level(10500, 2, 200, 10), ...level(11000, 3, 50, 40)];
  const waiting = [1, 2, 3].map(priority => ({ task: task(`W1-T1200${priority}`, { priority }), filedAgo: HOUR }));
  const context = calibrate(started, waiting);
  const sigma2 = 0.125 * 200 / 199;
  const bandOf = (n: number) => 1.96 * Math.sqrt(Math.PI / 2 * sigma2 / n) * HOUR;
  for (const [priority, median, n] of [[1, 10, 200], [2, 10, 200], [3, 40, 50]] as const) {
    const wait = tier(context, priority)?.wait_ms ?? NaN;
    assert.ok(Math.abs(wait - median * HOUR) <= bandOf(n), `P${priority} reads ${wait / HOUR} h against its own ${median} h`);
  }
  const units = [1, 2, 3].map(priority => unitOf(context, `W1-T1200${priority}`));
  assert.ok(units[0] <= units[1] && units[1] <= units[2], `the envelope runs ${units.map(u => u / HOUR).join(" <= ")} h`);
  assert.ok(Math.abs(units[2] - 40 * HOUR) <= bandOf(50), "the lowest tier ages in its own 40 h wait");
});
