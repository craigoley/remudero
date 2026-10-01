import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  buildDispatchValueContext,
  type DispatchValueContext,
  type DispatchValueCalibration,
} from "../src/lib/dispatch-value.js";
import { appendLedger } from "../src/lib/ledger.js";
import { dispatchOrder, runnableCandidates, type DrainDeps, type DrainSummary } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { Config } from "../src/lib/config.js";
import { drainCommand } from "../src/run-task.js";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

const NOW = Date.parse("2026-09-11T12:00:00.000Z");

/** Dispatched attempts for one class in the trailing window: `merged` of `total` attempts merged, each costing `cost`. */
function attempts(taskClass: string, merged: number, total: number, cost = 1, nowMs = NOW): Array<Record<string, unknown>> {
  const ts = new Date(nowMs - 60_000).toISOString();
  return Array.from({ length: total }, (_, i) => {
    const taskId = `W1-T${[...taskClass].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)}0${i}`;
    const runId = `${taskId}-1`;
    const rows: Array<Record<string, unknown>> = [
      { ts, run_id: runId, task_id: taskId, step: "run.start", task_class: taskClass },
      { ts, run_id: runId, task_id: taskId, step: "verdict", verdict: i < merged ? "merged" : "failed", cost_usd: cost },
    ];
    return rows;
  }).flat();
}

function ready(calibration: DispatchValueCalibration) {
  assert.equal(calibration.kind, "ready", calibration.kind === "refused" ? calibration.reasons.join(",") : "");
  return calibration.context;
}

function statePathForRoot(root: string): string {
  return join(root, "state", "ledger.ndjson");
}

function planYaml(...tasks: Task[]): string {
  return tasks
    .map((t) => {
      const files = t.files?.map((file) => `    - ${file}\n`).join("") ?? "";
      return `- id: ${t.id}
  title: ${t.title}
  repo: ${t.repo}
  type: ${t.type}
  depends_on: [${t.depends_on.join(", ")}]
  status: ${t.status}
${files ? `  files:\n${files}` : ""}`;
    })
    .join("");
}


async function driveDrainDispatchValue(
  seed: (root: string) => void,
): Promise<{ context: DispatchValueContext | undefined; ledgerRows: Array<Record<string, unknown>>; summaryLines: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-dispatch-value-"));
  const planDir = mkdtempSync(join(tmpdir(), "rmd-dispatch-value-plan-"));
  const planPath = join(planDir, "tasks.yaml");
  const srcTask = task("W1-T3412A", { files: ["src/a.ts"] });
  const docsTask = task("W1-T3412B", { files: ["docs/b.md"] });
  mkdirSync(join(root, "state"), { recursive: true });
  writePlan(planPath, planYaml(srcTask, docsTask));
  seed(root);

  let context: DispatchValueContext | undefined;
  const summaryLines: string[] = [];
  try {
    // Node 22's test runner can misparse a child's non-ASCII stdout as its serialized result
    // (nodejs/node#64061). The drain summary contains box-drawing characters, so capture only
    // this fixture's own console output while retaining it for assertions below.
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => { summaryLines.push(parts.map(String).join(" ")); };
    let code: number;
    try {
      code = await drainCommand([], {
        config: { claudeBin: "/bin/true", root } as Config,
        planPath,
        skipGitSync: true,
        githubFactory: () => ({ findMergedByTrailer: () => null }) as never,
        notifyChannel: { send: () => true } as never,
        runDrain: async (plan: Plan, deps: DrainDeps): Promise<DrainSummary> => {
          context = deps.buildDispatchValueContext?.(plan, () => false);
          return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
        },
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0, "the injected drain loop returns a clean stop");
    const ledgerRows = readFileSync(statePathForRoot(root), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { context, ledgerRows, summaryLines };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(planDir, { recursive: true, force: true });
  }
}

test("dispatch-value fixture captures its Unicode drain summary before Node 22's test transport sees it", async () => {
  const originalLog = console.log;
  let leaked = 0;
  console.log = () => { leaked++; };
  try {
    const { summaryLines } = await driveDrainDispatchValue(() => {});
    assert.equal(leaked, 0, "the fixture must not write the Unicode banner into node:test stdout");
    assert.ok(summaryLines.some((line) => line.includes("── drain summary")), "the real summary was rendered and captured");
  } finally {
    console.log = originalLog;
  }
});

function writePlan(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

test("W1-T3412 value respects explicit priority", () => {
  const lowValue = task("W1-T1", { files: ["src/a.ts"] });
  const highValue = task("W1-T2", { files: ["docs/b.md"] });
  const context = ready(
    buildDispatchValueContext([lowValue, highValue], [...attempts("src", 1, 5, 2), ...attempts("docs", 4, 5, 1)], new Set([lowValue.id, highValue.id]), NOW),
  );

  assert.deepEqual(dispatchOrder([lowValue, highValue], context).map((item) => item.id), [highValue.id, lowValue.id]);
  const explicitPriority = { ...lowValue, priority: 0 };
  assert.deepEqual(
    dispatchOrder([explicitPriority, highValue], context).map((item) => item.id),
    [explicitPriority.id, highValue.id],
    "measured value cannot override an explicit operator priority",
  );
});

test("W1-T3412 refuses untrusted calibration", () => {
  const left = task("W1-T1", { files: ["src/a.ts"] });
  const right = task("W1-T2", { files: ["docs/b.md"] });
  const calibration = buildDispatchValueContext([left, right], attempts("src", 1, 5), new Set([left.id, right.id]), NOW, false);
  assert.equal(calibration.kind, "refused");
  if (calibration.kind === "refused") assert.deepEqual(calibration.reasons, ["incomplete-union"]);
  assert.deepEqual(dispatchOrder([right, left]).map((item) => item.id), [left.id, right.id], "an unreadable corpus retains historic priority/scope/id order");
});

test("W1-T3412 fanout breaks unavailable value ties", () => {
  const parent = task("W1-T20", { files: ["plan/tasks.d/parent.yaml"] });
  const childA = task("W1-T30", { files: ["plan/tasks.d/child-a.yaml"], depends_on: [parent.id] });
  const childB = task("W1-T40", { files: ["plan/tasks.d/child-b.yaml"], depends_on: [parent.id] });
  const peer = task("W1-T1", { files: ["plan/tasks.d/peer.yaml"] });
  // Both compared tasks share one class, so their value scores tie and the open-dependent fanout decides.
  const context = ready(
    buildDispatchValueContext([parent, childA, childB, peer], attempts("src", 4, 5), new Set([parent.id, childA.id, childB.id, peer.id]), NOW),
  );
  const plan: Plan = { tasks: [peer, parent, childA, childB], byId: new Map([[peer.id, peer], [parent.id, parent], [childA.id, childA], [childB.id, childB]]) };
  assert.deepEqual(dispatchOrder([peer, parent], context).map((item) => item.id), [parent.id, peer.id]);
  assert.equal(runnableCandidates(plan, () => false, 1, { dispatchValueContext: context })[0]?.id, parent.id);
});

test("W1-T3412 mutation rejects value bypass", () => {
  const lowValue = task("W1-T1", { files: ["src/a.ts"] });
  const highValue = task("W1-T2", { files: ["docs/b.md"] });
  const context = ready(
    buildDispatchValueContext([lowValue, highValue], [...attempts("src", 1, 5, 2), ...attempts("docs", 4, 5, 1)], new Set([lowValue.id, highValue.id]), NOW),
  );
  const ordered = dispatchOrder([lowValue, highValue], context).map((item) => item.id);
  const bypassed = dispatchOrder([lowValue, highValue]).map((item) => item.id);
  assert.deepEqual(ordered, [highValue.id, lowValue.id]);
  assert.deepEqual(bypassed, [lowValue.id, highValue.id]);
  assert.notDeepEqual(ordered, bypassed, "removing the value context must fail this discriminating assertion");
});

test("W1-T3412 drainCommand builds calibrated dispatch value from dispatched attempts", async () => {
  const { context, ledgerRows } = await driveDrainDispatchValue((root) => {
    const ledgerPath = statePathForRoot(root);
    for (const row of [...attempts("src", 1, 5, 2, Date.now()), ...attempts("docs", 4, 5, 1, Date.now())]) appendLedger(ledgerPath, row as never);
  });

  assert.ok(context, "dispatched attempts produce a dispatch value context");
  assert.deepEqual([...context.scoreByClass.keys()].sort(), ["docs", "src"]);
  const calibrated = ledgerRows.find((row) => row.step === "dispatch.value.calibrated") as { classes?: Record<string, unknown> } | undefined;
  assert.deepEqual(Object.keys(calibrated?.classes ?? {}).sort(), ["docs", "src"], "the command layer logs each class it handed to drain.ts");
});

test("W1-T3412 drainCommand refuses an incomplete ledger union", async () => {
  const { context, ledgerRows } = await driveDrainDispatchValue((root) => {
    const insideWindow = new Date(Date.now() - 60_000).toISOString().replace(/[:.]/g, "-");
    mkdirSync(join(root, "state", `ledger.${insideWindow}.ndjson`));
  });

  assert.equal(context, undefined);
  const refusal = ledgerRows.find((row) => row.step === "dispatch.value.refused");
  assert.equal(refusal?.reason, "incomplete-union");
  assert.equal(refusal?.unread_rotations, 1);
});
