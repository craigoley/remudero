import assert from "node:assert/strict";
import test from "node:test";
import { betaDraw, buildDispatchValueContext, planSeed, type DispatchValueCalibration } from "../src/lib/dispatch-value.js";
import { dispatchOrder } from "../src/lib/drain.js";
import type { Task } from "../src/lib/plan.js";
import { deriveTaskClass } from "../src/lib/task-class.js";

// Each class carries a Beta posterior over P(merge per dispatched attempt), its prior pooled from the whole fleet.
// A seed turns the score into one Thompson draw from that posterior; no seed leaves the posterior mean.

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const ts = new Date(NOW - 60 * 60_000).toISOString();

function task(id: string, files: string[]): Task {
  return { id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, files };
}

/** `attempts` dispatched runs of one class, the first `merges` of them credited with a merge. */
function trials(taskClass: string, prefix: string, attempts: number, merges: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < attempts; i++) {
    const taskId = `W1-T${prefix}${i}`;
    const runId = `${taskId}-${1790000000000 + i}`;
    rows.push({ ts, run_id: runId, task_id: taskId, step: "run.start", task_class: taskClass });
    rows.push({ ts, run_id: runId, task_id: taskId, step: "verdict", verdict: i < merges ? "merged" : "failed", cost_usd: 1 });
    if (i < merges) rows.push({ ts, run_id: "DAEMON-1", task_id: taskId, step: "verdict.merged", verdict: "merged" });
  }
  return rows;
}

function ready(calibration: DispatchValueCalibration) {
  assert.equal(calibration.kind, "ready", calibration.kind === "refused" ? calibration.reasons.join(",") : "");
  return calibration;
}

const src = task("W1-T1", ["src/a.ts"]);
const docs = task("W1-T2", ["docs/b.md"]);
const open = new Set([src.id, docs.id]);

test("W1-T4006: a zero-merge class gets a finite positive score shrunk toward the pooled rate", () => {
  const rows = [...trials("src", "1", 10, 5), ...trials("docs", "2", 2, 0)];
  for (const seed of [undefined, "seed-a"]) {
    const calibrated = ready(buildDispatchValueContext([src, docs], rows, open, NOW, true, seed));
    const score = calibrated.context.scoreByClass.get("docs");
    assert.ok(score !== undefined && Number.isFinite(score) && score > 0, `docs is scored, finite and positive (seed ${seed})`);
  }
  const docsEstimate = ready(buildDispatchValueContext([src, docs], rows, open, NOW)).estimates.get("docs")!;
  assert.equal(docsEstimate.merges, 0);
  assert.ok(docsEstimate.mean > 0, "a zero-merge class is not driven to zero");
  assert.ok(docsEstimate.mean < 5 / 12, "it sits below the pooled rate it is shrunk toward");
  assert.ok(docsEstimate.mean > 0.1, "but prior evidence still pulls it well above its raw 0");
  const allFailed = ready(buildDispatchValueContext([docs], trials("docs", "2", 3, 0), new Set([docs.id]), NOW, true, "seed-a"));
  assert.ok((allFailed.context.scoreByClass.get("docs") ?? 0) > 0, "a fleet with no merges at all still yields a positive score");
});

test("W1-T4006: one thin class no longer refuses the whole calibration", () => {
  const thin = task("W1-T3", ["scripts/c.mjs"]);
  const rows = [...trials("src", "1", 10, 5), ...trials("docs", "2", 1, 0)];
  const calibrated = ready(buildDispatchValueContext([src, docs, thin], rows, new Set([src.id, docs.id, thin.id]), NOW, true, "seed-a"));
  for (const taskClass of ["src", "docs", deriveTaskClass(thin)]) {
    assert.ok(calibrated.context.scoreByClass.has(taskClass), `${taskClass} is scored`);
  }
  assert.ok(dispatchOrder([docs, src], calibrated.context).length === 2, "the selector still orders under the context");
});

test("W1-T4006: a class score converges to its measured rate as trials grow", () => {
  const rate = 0.8;
  const spread = (n: number) => {
    const distances: number[] = [];
    for (let k = 0; k < 40; k++) {
      const rows = [...trials("src", "1", n, Math.round(n * rate)), ...trials("docs", "2", n, Math.round(n * 0.2))];
      const cal = ready(buildDispatchValueContext([src, docs], rows, open, NOW, true, `seed-${k}`));
      const e = cal.estimates.get("src")!;
      distances.push(Math.abs(betaDraw(e.alpha, e.beta, `seed-${k}`, "src") - rate));
    }
    return distances.reduce((a, b) => a + b, 0) / distances.length;
  };
  const thin = spread(5);
  const thick = spread(400);
  assert.ok(thick < thin, `exploration shrinks with evidence (${thick} < ${thin})`);
  assert.ok(thick < 0.05, `a thick class draws within 0.05 of its measured rate (${thick})`);
  const rows = [...trials("src", "1", 400, 320), ...trials("docs", "2", 400, 80)];
  const mean = ready(buildDispatchValueContext([src, docs], rows, open, NOW)).estimates.get("src")!.mean;
  assert.ok(Math.abs(mean - rate) < 0.01, `the posterior mean converges to the measured rate (${mean})`);
});

test("W1-T4006: draws are reproducible for a fixed seed", () => {
  const rows = [...trials("src", "1", 6, 3), ...trials("docs", "2", 4, 1)];
  const tasks = [src, docs];
  const seed = planSeed(tasks);
  const a = ready(buildDispatchValueContext(tasks, rows, open, NOW, true, seed));
  const b = ready(buildDispatchValueContext([...tasks].reverse(), [...rows].reverse(), open, NOW, true, seed));
  assert.deepEqual([...a.context.scoreByClass].sort(), [...b.context.scoreByClass].sort(), "same seed, same scores");
  assert.deepEqual(
    dispatchOrder([docs, src], a.context).map((t) => t.id),
    dispatchOrder([src, docs], b.context).map((t) => t.id),
    "same seed, same order",
  );
  assert.equal(betaDraw(2, 3, "s", "x"), betaDraw(2, 3, "s", "x"));
  assert.notEqual(betaDraw(2, 3, "s", "x"), betaDraw(2, 3, "t", "x"), "a different seed moves the draw");
  assert.equal(planSeed(tasks), planSeed([...tasks].reverse()), "the plan seed ignores enumeration order");
});

test("W1-T4006: the selector reads a missing score as absent, never zero", () => {
  const calibrated = ready(buildDispatchValueContext([src], trials("src", "1", 4, 2), new Set([src.id]), NOW, true, "seed-a"));
  assert.equal(calibrated.context.scoreByClass.has("docs"), false, "an unseen class has no score");
  assert.deepEqual(
    dispatchOrder([docs, src], calibrated.context).map((t) => t.id),
    ["W1-T1", "W1-T2"].sort(),
    "with one side unscored the order falls back to id order",
  );
});

