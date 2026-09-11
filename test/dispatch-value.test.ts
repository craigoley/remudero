import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  buildDispatchValueContext,
  type DispatchValueContext,
  type ClosureCalibrationSnapshot,
  type DispatchValueCalibration,
} from "../src/lib/dispatch-value.js";
import { appendLedger } from "../src/lib/ledger.js";
import { dispatchOrder, runnableCandidates, type DrainDeps, type DrainSummary } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { ClassClosure } from "../src/lib/retro-closure.js";
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

function closure(taskClass: string, rate: number | "thin", costPerMerge: number | null): ClassClosure {
  return {
    taskClass,
    filed: 5,
    merged: rate === "thin" ? 1 : 4,
    open: 1,
    mergeRate:
      rate === "thin"
        ? { kind: "refused", merged: 1, denominator: 2, floor: 5 }
        : { kind: "rate", value: rate, merged: 4, denominator: 5 },
    costPerMerge,
  };
}

function snapshots(rows: readonly ClassClosure[], prior = rows): ClosureCalibrationSnapshot[] {
  return [
    { ts: "2026-09-11T12:00:00.000Z", rows },
    { ts: "2026-09-10T12:00:00.000Z", rows: prior },
  ];
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

function closureSnapshotLine(ts: string, rows: readonly unknown[]): Record<string, unknown> {
  return { ts, run_id: `RETRO-${ts}`, task_id: "RETRO", step: "retro.closure_by_class", lane: "retro", rows };
}

async function driveDrainDispatchValue(
  seed: (root: string) => void,
): Promise<{ context: DispatchValueContext | undefined; ledgerRows: Array<Record<string, unknown>> }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-dispatch-value-"));
  const planDir = mkdtempSync(join(tmpdir(), "rmd-dispatch-value-plan-"));
  const planPath = join(planDir, "tasks.yaml");
  const srcTask = task("W1-T3412A", { files: ["src/a.ts"] });
  const docsTask = task("W1-T3412B", { files: ["docs/b.md"] });
  mkdirSync(join(root, "state"), { recursive: true });
  writePlan(planPath, planYaml(srcTask, docsTask));
  seed(root);

  let context: DispatchValueContext | undefined;
  try {
    const code = await drainCommand([], {
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
    assert.equal(code, 0, "the injected drain loop returns a clean stop");
    const ledgerRows = readFileSync(statePathForRoot(root), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { context, ledgerRows };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(planDir, { recursive: true, force: true });
  }
}

function writePlan(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

test("W1-T3412 value respects explicit priority", () => {
  const lowValue = task("W1-T1", { files: ["src/a.ts"] });
  const highValue = task("W1-T2", { files: ["docs/b.md"] });
  const context = ready(
    buildDispatchValueContext(
      [lowValue, highValue],
      snapshots([closure("src", 0.2, 2), closure("docs", 0.8, 1)]),
      new Set([lowValue.id, highValue.id]),
    ),
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
  const fixtures: Array<{ name: string; calibration: DispatchValueCalibration }> = [
    { name: "incomplete-union", calibration: buildDispatchValueContext([left, right], snapshots([closure("src", 0.2, 1)]), new Set([left.id, right.id]), false) },
    { name: "missing-prior-snapshot", calibration: buildDispatchValueContext([left, right], [snapshots([closure("src", 0.2, 1)])[0]], new Set([left.id, right.id])) },
    { name: "missing-prior-class", calibration: buildDispatchValueContext([left, right], snapshots([closure("src", 0.2, 1), closure("docs", 0.4, 1)], [closure("src", 0.2, 1)]), new Set([left.id, right.id])) },
    { name: "thin-class", calibration: buildDispatchValueContext([left, right], snapshots([closure("src", "thin", 1)]), new Set([left.id, right.id])) },
    { name: "zero-merge-class", calibration: buildDispatchValueContext([left, right], snapshots([closure("src", 0.2, null)]), new Set([left.id, right.id])) },
    { name: "unstable-value", calibration: buildDispatchValueContext([left, right], snapshots([closure("src", 0.8, 1)], [closure("src", 0.2, 1)]), new Set([left.id, right.id])) },
  ];
  for (const fixture of fixtures) {
    assert.equal(fixture.calibration.kind, "refused", fixture.name);
    if (fixture.calibration.kind === "refused") assert.ok(fixture.calibration.reasons.some((reason) => reason.includes(fixture.name)));
    assert.deepEqual(
      dispatchOrder([right, left]).map((item) => item.id),
      [left.id, right.id],
      `${fixture.name} retains historic priority/scope/id order`,
    );
  }
});

test("W1-T3412 fanout breaks unavailable value ties", () => {
  const parent = task("W1-T20", { files: ["plan/tasks.d/parent.yaml"] });
  const childA = task("W1-T30", { files: ["plan/tasks.d/child-a.yaml"], depends_on: [parent.id] });
  const childB = task("W1-T40", { files: ["plan/tasks.d/child-b.yaml"], depends_on: [parent.id] });
  const peer = task("W1-T1", { files: ["plan/tasks.d/peer.yaml"] });
  // The complete calibration has a trusted src class but no plan-lint row. Neither compared task
  // therefore has a value score, so the ratified open-dependent fanout term decides the tie.
  const context = ready(
    buildDispatchValueContext(
      [parent, childA, childB, peer],
      snapshots([closure("src", 0.8, 1)]),
      new Set([parent.id, childA.id, childB.id, peer.id]),
    ),
  );
  const plan: Plan = { tasks: [peer, parent, childA, childB], byId: new Map([[peer.id, peer], [parent.id, parent], [childA.id, childA], [childB.id, childB]]) };
  assert.deepEqual(dispatchOrder([peer, parent], context).map((item) => item.id), [parent.id, peer.id]);
  assert.equal(runnableCandidates(plan, () => false, 1, { dispatchValueContext: context })[0]?.id, parent.id);
});

test("W1-T3412 mutation rejects value bypass", () => {
  const lowValue = task("W1-T1", { files: ["src/a.ts"] });
  const highValue = task("W1-T2", { files: ["docs/b.md"] });
  const context = ready(
    buildDispatchValueContext(
      [lowValue, highValue],
      snapshots([closure("src", 0.2, 2), closure("docs", 0.8, 1)]),
      new Set([lowValue.id, highValue.id]),
    ),
  );
  const ordered = dispatchOrder([lowValue, highValue], context).map((item) => item.id);
  const bypassed = dispatchOrder([lowValue, highValue]).map((item) => item.id);
  assert.deepEqual(ordered, [highValue.id, lowValue.id]);
  assert.deepEqual(bypassed, [lowValue.id, highValue.id]);
  assert.notDeepEqual(ordered, bypassed, "removing the value context must fail this discriminating assertion");
});

test("W1-T3412 drainCommand builds calibrated dispatch value from closure ledger snapshots", async () => {
  const { context, ledgerRows } = await driveDrainDispatchValue((root) => {
    const ledgerPath = statePathForRoot(root);
    const rows = [closure("src", 0.2, 2), closure("docs", 0.8, 1)];
    appendLedger(ledgerPath, closureSnapshotLine("2026-09-10T12:00:00.000Z", rows) as never);
    appendLedger(ledgerPath, closureSnapshotLine("2026-09-11T12:00:00.000Z", rows) as never);
  });

  assert.ok(context, "complete stable snapshots produce a dispatch value context");
  assert.deepEqual([...context.scoreByClass.keys()].sort(), ["docs", "src"]);
  assert.deepEqual(
    ledgerRows.find((row) => row.step === "dispatch.value.calibrated")?.classes,
    ["src", "docs"],
    "the command layer logs the calibrated classes it handed to drain.ts",
  );
});

test("W1-T3412 drainCommand refuses malformed closure snapshots before selection", async () => {
  const { context, ledgerRows } = await driveDrainDispatchValue((root) => {
    appendLedger(
      statePathForRoot(root),
      closureSnapshotLine("2026-09-11T12:00:00.000Z", [
        { taskClass: "src", merged: 4, open: 1, costPerMerge: 1, mergeRate: { kind: "rate", value: 0.2, merged: 4 } },
      ]) as never,
    );
  });

  assert.equal(context, undefined);
  assert.equal(
    ledgerRows.find((row) => row.step === "dispatch.value.refused")?.reason,
    "malformed-closure-snapshot",
  );
});

test("W1-T3412 drainCommand refuses an incomplete closure ledger union", async () => {
  const { context, ledgerRows } = await driveDrainDispatchValue((root) => {
    mkdirSync(join(root, "state", "ledger.2026-09-09T00-00-00-000Z.ndjson"));
  });

  assert.equal(context, undefined);
  const refusal = ledgerRows.find((row) => row.step === "dispatch.value.refused");
  assert.equal(refusal?.reason, "incomplete-union");
  assert.equal(refusal?.unread_rotations, 1);
});

test("W1-T3412 drainCommand names valid closure classes that are too thin to calibrate", async () => {
  const { context, ledgerRows } = await driveDrainDispatchValue((root) => {
    const ledgerPath = statePathForRoot(root);
    const rows = [closure("src", "thin", 1)];
    appendLedger(ledgerPath, closureSnapshotLine("2026-09-10T12:00:00.000Z", rows) as never);
    appendLedger(ledgerPath, closureSnapshotLine("2026-09-11T12:00:00.000Z", rows) as never);
  });

  assert.equal(context, undefined);
  assert.equal(
    ledgerRows.find((row) => row.step === "dispatch.value.refused")?.reason,
    "src:thin-class",
  );
});
