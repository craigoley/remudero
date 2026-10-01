import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DISPATCH_VALUE_WINDOW_MS,
  buildDispatchValueContext,
  estimateClassValues,
  type DispatchValueCalibration,
} from "../src/lib/dispatch-value.js";
import { appendLedger } from "../src/lib/ledger.js";
import { dispatchOrder, type DrainDeps, type DrainSummary } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { Config } from "../src/lib/config.js";
import { drainCommand } from "../src/run-task.js";

// MEASURED 2026-10-01: the calibration was refused every cycle (178 dispatch.value.refused in three days) because one
// class that never merges refused the whole queue, and `src` failed a 10% two-snapshot gate on a rate computed as a
// retro window's merges over the WHOLE open backlog. Value is now merges per dispatched attempt over a trailing
// window, smoothed toward the fleet rate, and an unmeasurable class degrades alone.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function task(id: string, files: string[]): Task {
  return { id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, files };
}

/** One dispatched attempt: its run.start, its terminal verdict with cost, and optionally a merge credit for its task. */
function attempt(taskId: string, taskClass: string, n: number, opts: { merged?: boolean; costUsd?: number; minutesAgo?: number } = {}) {
  const runId = `${taskId}-${1790000000000 + n}`;
  const ts = at(opts.minutesAgo ?? 60);
  const rows: Array<Record<string, unknown>> = [
    { ts, run_id: runId, task_id: taskId, step: "run.start", task_class: taskClass },
    { ts, run_id: runId, task_id: taskId, step: "verdict", verdict: opts.merged ? "merged" : "failed", cost_usd: opts.costUsd ?? 1 },
  ];
  if (opts.merged) rows.push({ ts, run_id: "DAEMON-1", task_id: taskId, step: "verdict.merged", verdict: "merged" });
  return rows;
}

function ready(calibration: DispatchValueCalibration) {
  assert.equal(calibration.kind, "ready", calibration.kind === "refused" ? calibration.reasons.join(",") : "");
  return calibration;
}

test("W1-T5112: an unmeasurable class no longer refuses the whole calibration", () => {
  const src = task("W1-T1", ["src/a.ts"]);
  const docs = task("W1-T2", ["docs/b.md"]);
  const rows = [
    ...attempt("W1-T10", "src", 1, { merged: true }),
    ...attempt("W1-T11", "src", 2, { merged: true }),
    ...attempt("W1-T12", "src", 3),
    ...attempt("W1-T20", "docs", 4),
    ...attempt("W1-T21", "docs", 5),
    ...attempt("W1-T22", "docs", 6),
  ];
  const calibrated = ready(buildDispatchValueContext([src, docs], rows, new Set([src.id, docs.id]), NOW));
  const scores = calibrated.context.scoreByClass;
  assert.ok(scores.has("src") && scores.has("docs"), "both classes are scored, the zero-merge one included");
  assert.ok(scores.get("src")! > scores.get("docs")!, "the class that merges ranks above the one that never does");
  assert.deepEqual(dispatchOrder([docs, src], calibrated.context).map((t) => t.id), [src.id, docs.id]);
});

test("W1-T5112: a thin class is scored near the fleet mean rather than refused", () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => attempt(`W1-T${100 + i}`, "src", i, { merged: i % 2 === 0 })).flat(),
    ...attempt("W1-T200", "triage", 99),
  ];
  const { byClass, fleet } = estimateClassValues(rows, NOW);
  const triage = byClass.get("triage");
  assert.ok(triage, "a class with one attempt is estimated, not refused");
  assert.equal(triage.attempts, 1);
  assert.equal(triage.merges, 0);
  assert.ok(triage.mean > 0, "one failed attempt does not drive the class to zero");
  assert.ok(triage.mean < fleet.mean, "it is pulled toward the fleet rate from its raw 0");
  assert.ok(fleet.mean - triage.mean < fleet.mean / 2, "a single attempt moves it less than halfway from the fleet mean");
});

test("W1-T5112: value is merges per dispatched attempt, not merges over the open backlog", () => {
  const open = Array.from({ length: 100 }, (_, i) => task(`W1-T${3000 + i}`, ["src/x.ts"]));
  const rows = [
    ...attempt("W1-T1", "src", 1, { merged: true }),
    ...attempt("W1-T2", "src", 2, { merged: true }),
    ...attempt("W1-T3", "src", 3),
    ...attempt("W1-T4", "src", 4),
  ];
  const narrow = estimateClassValues(rows, NOW).byClass.get("src")!;
  assert.equal(narrow.attempts, 4);
  assert.equal(narrow.merges, 2);
  assert.ok(Math.abs(narrow.mean - 0.5) < 1e-9, "2 merges in 4 attempts, with the fleet prior also at 0.5");
  const withBacklog = ready(buildDispatchValueContext(open, rows, new Set(open.map((t) => t.id)), NOW));
  assert.equal(withBacklog.estimates.get("src")!.mean, narrow.mean, "the open backlog's size never enters the rate");
});

test("W1-T5112: attempts outside the trailing window are not counted", () => {
  const rows = [
    ...attempt("W1-T1", "src", 1, { merged: true }),
    ...attempt("W1-T2", "src", 2, { minutesAgo: DISPATCH_VALUE_WINDOW_MS / 60_000 + 60 }),
  ];
  const src = estimateClassValues(rows, NOW).byClass.get("src")!;
  assert.equal(src.attempts, 1);
  assert.equal(src.merges, 1);
});

test("W1-T5112: at the same merge rate the cheaper class ranks higher", () => {
  const rows = [
    ...attempt("W1-T1", "src", 1, { merged: true, costUsd: 4 }),
    ...attempt("W1-T2", "src", 2, { costUsd: 4 }),
    ...attempt("W1-T3", "test", 3, { merged: true, costUsd: 0.5 }),
    ...attempt("W1-T4", "test", 4, { costUsd: 0.5 }),
  ];
  const scores = ready(buildDispatchValueContext([], rows, new Set(), NOW)).context.scoreByClass;
  assert.ok(scores.get("test")! > scores.get("src")!);
});

test("W1-T5112: an open class with no attempts is scored at the fleet prior and named", () => {
  const src = task("W1-T1", ["src/a.ts"]);
  const docs = task("W1-T2", ["docs/b.md"]);
  const rows = [...attempt("W1-T10", "src", 1, { merged: true }), ...attempt("W1-T11", "src", 2)];
  const calibrated = ready(buildDispatchValueContext([src, docs], rows, new Set([src.id, docs.id]), NOW));
  assert.ok(calibrated.refusals.includes("docs:no-attempts"));
  assert.equal(calibrated.estimates.get("docs")!.attempts, 0);
  assert.equal(calibrated.context.scoreByClass.get("docs"), calibrated.fleet.value, "a no-attempt class sits exactly at the prior");
});

test("W1-T5112: only an unreadable corpus refuses the calibration", () => {
  const calibration = buildDispatchValueContext([], [], new Set(), NOW, false);
  assert.equal(calibration.kind, "refused");
  if (calibration.kind === "refused") assert.deepEqual(calibration.reasons, ["incomplete-union"]);
  const empty = ready(buildDispatchValueContext([], [], new Set(), NOW));
  assert.equal(empty.context.scoreByClass.size, 0, "no attempts anywhere: ready, with fanout alone");
});

test("W1-T5112: drainCommand calibrates from dispatched attempts and logs each class", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-dispatch-value-5112-"));
  const planDir = mkdtempSync(join(tmpdir(), "rmd-dispatch-value-5112-plan-"));
  const planPath = join(planDir, "tasks.yaml");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(planPath, "- id: W1-T9001\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files:\n    - src/a.ts\n");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const recent = new Date(Date.now() - 60_000).toISOString();
    for (const row of attempt("W1-T10", "src", 1, { merged: true })) appendLedger(ledgerPath, { ...row, ts: recent } as never);
    for (const row of attempt("W1-T11", "src", 2)) appendLedger(ledgerPath, { ...row, ts: recent } as never);
    let scored: number | undefined;
    const code = await drainCommand([], {
      config: { claudeBin: "/bin/true", root } as Config,
      planPath,
      skipGitSync: true,
      githubFactory: () => ({ findMergedByTrailer: () => null }) as never,
      notifyChannel: { send: () => true } as never,
      runDrain: async (plan: Plan, deps: DrainDeps): Promise<DrainSummary> => {
        scored = deps.buildDispatchValueContext?.(plan, () => false)?.scoreByClass.get("src");
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
      },
    });
    assert.equal(code, 0);
    assert.ok(scored !== undefined && scored > 0, "the command layer hands drain a scored src class");
    const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const calibrated = rows.find((r) => r.step === "dispatch.value.calibrated") as { classes?: Record<string, { attempts: number; merges: number; mean: number }> } | undefined;
    assert.equal(calibrated?.classes?.src?.attempts, 2);
    assert.equal(calibrated?.classes?.src?.merges, 1);
    assert.equal(rows.some((r) => r.step === "dispatch.value.refused"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(planDir, { recursive: true, force: true });
  }
});

test("W1-T5112: synthetic lane runs are not counted as build attempts", () => {
  const rows = [
    ...attempt("W1-T1", "src", 1, { merged: true }),
    { ts: at(30), run_id: "RETRO-1790000000001", task_id: "RETRO", step: "run.start", task_class: "retro" },
    { ts: at(30), run_id: "TRIAGE-fb-1-1790000000002", task_id: "TRIAGE-fb-1", step: "run.start", task_class: "triage" },
  ];
  const { byClass, fleet } = estimateClassValues(rows, NOW);
  assert.deepEqual([...byClass.keys()], ["src"]);
  assert.equal(fleet.attempts, 1);
});
