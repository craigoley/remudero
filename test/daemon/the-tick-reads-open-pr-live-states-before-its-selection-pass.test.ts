import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";

import { daemonLiveStateReader } from "#src/cli/commands/daemon.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";

type Row = { step: string; fields: Record<string, unknown> };
const PR_PATH = "repos/craigoley/remudero/pulls/7";

function scratch(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13671-`)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function plan(t: TestContext, tasks: Array<{ id: string; dependsOn?: string[] }>): Plan {
  const path = join(scratch(t), "tasks.yaml");
  writeFileSync(path, tasks.map(({ id, dependsOn = [] }) =>
    `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  status: queued\n` +
    `  depends_on: [${dependsOn.join(", ")}]\n  files: [src/${id.toLowerCase()}.ts]\n`).join(""));
  return loadPlan(path);
}

const ok = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 });

/** One daemon tick: the loop stops at its first sleep, so exactly one selection pass runs. */
async function oneTick(p: Plan, overrides: Partial<DaemonDeps>) {
  const rows: Row[] = [];
  const started: string[] = [];
  let stop = false;
  const deps: DaemonDeps = {
    refreshMerged: () => () => false, readLedgerLines: () => [],
    checkCostGovernor: () => undefined, checkQueueGovernor: () => undefined,
    checkMemoryGovernor: () => undefined, checkQuietHours: () => undefined,
    sweepLight: async () => {},
    runOne: async (id) => { started.push(id); return ok(id); },
    log: (step, fields = {}) => { rows.push({ step, fields }); },
    checkStop: () => stop ? "one tick observed" : undefined,
    sleep: async () => { stop = true; await yieldTurn(); },
    ...overrides,
  };
  await runDaemon(p, deps, { laneCount: 1, pollIntervalMs: 10 });
  return { rows, started };
}

test("W1-T13671 criterion 1: the tick reads an open PR's live state through the production reader with no synchronous child", async (t) => {
  const root = scratch(t);
  const done = join(root, "pr.done");
  const shim = ghShim([{ when: PR_PATH, stdout: JSON.stringify({ number: 7, state: "open", merged: false }),
    delaySeconds: 0.3, doneFile: done }], { kind: "t13671-gh" });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; rmSync(shim.dir, { recursive: true, force: true }); });
  let timerRanWhileInFlight: boolean | undefined;
  const timer = setTimeout(() => { timerRanWhileInFlight = !existsSync(done); }, 0);
  const { rows, started } = await oneTick(plan(t, [{ id: "A" }]), {
    isOpenPr: (id) => id === "A" ? 7 : undefined,
    readLiveState: daemonLiveStateReader("craigoley", "remudero"),
  });
  clearTimeout(timer);
  assert.equal(timerRanWhileInFlight, true, "a timer set before the tick ran while the gh read was in flight");
  assert.equal(shim.calls().filter((call) => call.includes(PR_PATH)).length, 1);
  assert.deepEqual(started, [], "an open PR is never dispatched again");
  const skipped = rows.filter((row) => row.step === "dispatch.skipped");
  assert.deepEqual(skipped.map((row) => row.fields), [{ task: "A", reason: "open-pr", pr_number: 7 }]);
});

test("W1-T13671 criterion 2: MERGED and CLOSED stand down as before; a failed, rejected or timed-out read is indeterminate and never dispatches", async (t) => {
  for (const state of ["MERGED", "CLOSED"]) {
    const { rows, started } = await oneTick(plan(t, [{ id: "A" }]), {
      isOpenPr: (id) => id === "A" ? 7 : undefined,
      readLiveState: async () => state,
    });
    const stood = rows.filter((row) => row.step === "dispatch.stood_down");
    assert.deepEqual(stood.map((row) => row.fields),
      [{ task: "A", pr_number: 7, state, reason: "cached in-flight read was stale" }], state);
    assert.deepEqual(started, ["A"], `${state}: the stale in-flight reading no longer blocks the task`);
  }
  const unknown: Array<[string, DaemonDeps["readLiveState"]]> = [
    ["failed", async () => undefined],
    ["rejected", async () => { throw new Error("gh unreachable"); }],
    ["thrown", () => { throw new Error("gh unreachable"); }],
  ];
  for (const [kind, readLiveState] of unknown) {
    const { rows, started } = await oneTick(plan(t, [{ id: "A" }]), { isOpenPr: (id) => id === "A" ? 7 : undefined, readLiveState });
    const indeterminate = rows.filter((row) => row.step === "dispatch.live_state_indeterminate");
    assert.ok(indeterminate.length >= 1, kind);
    assert.deepEqual(indeterminate[0]!.fields, { task: "A", pr_number: 7 }, kind);
    assert.deepEqual(started, [], `${kind}: an unknown state never dispatches`);
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const tick = oneTick(plan(t, [{ id: "A" }]), {
    isOpenPr: (id) => id === "A" ? 7 : undefined,
    readLiveState: () => { readStarted(); return new Promise<string>(() => {}); },
  });
  await started;
  await yieldTurn();
  t.mock.timers.tick(15_000);
  const timedOut = await tick;
  t.mock.timers.reset();
  assert.ok(timedOut.rows.some((row) => row.step === "dispatch.live_state_indeterminate" && row.fields.task === "A"), "timed out");
  assert.deepEqual(timedOut.started, [], "a timed-out read never dispatches");
});

test("W1-T13671 criterion 3: one selection pass reads each in-flight open PR once and skips tasks with no open or a merged PR", async (t) => {
  const reads: string[] = [];
  const { rows, started } = await oneTick(plan(t, [{ id: "A" }, { id: "C" }, { id: "D", dependsOn: ["A"] }]), {
    refreshMerged: () => (id) => id === "C",
    isOpenPr: (id) => id === "A" ? 7 : id === "C" ? 9 : undefined,
    readLiveState: async (taskId, prNumber) => { reads.push(`${taskId}#${prNumber}`); return "OPEN"; },
  });
  assert.deepEqual(reads, ["A#7"], "A is read once; C (merged) and D (no open PR) are not read");
  assert.deepEqual(started, []);
  assert.ok(rows.some((row) => row.step === "dispatch.skipped" && row.fields.task === "A"));
});
