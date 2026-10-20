// test/a-decided-restart-names-the-lanes-it-waits-on.test.ts — W1-T8503, repointed by W1-T9089 (ADR 0007 A.10).
//
// A restart decided while lanes run waits on exactly one kind of lane: a run still inside the daemon's own process. A
// child run is left running for the next boot to adopt, and the exit row names it so the operator can see who carries on.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

import { runDaemon } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const result = (id: string): RunResult => ({ taskId: id, runId: id, merged: false, verdict: "no_pr", costUsd: 0 });

test("W1-T9089: a decided restart waits on the in-process lane and names the child it leaves running", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9089-names-`));
  scratch.push(root);
  const path = join(root, "tasks.yaml");
  writeFileSync(path, ["A", "B"].map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const rows: Array<Record<string, unknown>> = [];
  const settles = new Map(["A", "B"].map((id) => [id, deferred<RunResult>()]));
  const started: string[] = [];
  let now = Date.now();
  let stale = false;
  let stop = false;
  const run = runDaemon(loadPlan(path), {
    refreshMerged: () => () => false,
    checkStop: () => stop ? "cleanup" : undefined,
    checkFreshness: () => stale ? { stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40), installNeeded: false,
      changes: [{ sha: "b".repeat(40), subject: "fix(daemon): reload the dispatch loop", files: ["src/lib/daemon.ts"] }] } : { stale: false },
    now: () => new Date(now),
    sleep: async () => { now += 3_600_000; await delay(1); },
    runOne: (id, options) => {
      started.push(id);
      const settled = settles.get(id)!.promise;
      // A is a child run; B never reports a child, so it runs inside this process.
      if (id === "A") {
        options!.onChild!({ started: true, runId: id, dir: root, pid: process.pid, settled,
          abort: async () => { throw new Error("a freshness restart never aborts a child"); } });
      }
      return settled;
    },
    log: (step, extra) => { rows.push({ step, ...extra }); },
  }, { laneCount: 2, pollIntervalMs: 5 });
  try {
    for (let i = 0; i < 1000 && started.length < 2; i++) await delay(2);
    assert.deepEqual([...started].sort(), ["A", "B"], "both lanes started");
    stale = true;
    for (let i = 0; i < 1000 && !rows.some((r) => r.step === "daemon.freshness_decision" && r.action === "restart"); i++) await delay(2);
    assert.equal(rows.some((r) => r.step === "daemon.freshness_decision" && r.action === "restart"), true, "the restart was decided");
    await delay(60);
    assert.equal(rows.some((r) => r.step === "daemon.freshness_exit"), false, "the daemon still waits on the in-process lane");
    settles.get("B")!.resolve(result("B"));
    const summary = await run;
    assert.equal(summary.stopReason, "stale");
    const exit = rows.find((r) => r.step === "daemon.freshness_exit")!;
    assert.deepEqual(exit.children_left_running, ["A"], "only the child run is left for the next boot");
    assert.equal(typeof (exit.phases_ms as Record<string, unknown>).lanes, "number", "the wait on the lane is measured");
  } finally {
    stop = true;
    for (const [id, settle] of settles) settle.resolve(result(id));
    await run;
  }
});
