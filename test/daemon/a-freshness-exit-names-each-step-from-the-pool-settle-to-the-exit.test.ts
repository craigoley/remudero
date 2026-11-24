// W1-T14684: a decided restart's freshness exit names, in phases_ms.settle, how long each step took from the lane
// pool's settle to the exit. The 2026-11-24 16:07Z hand-over lost 8 min 40 s there and no row said where.
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

test("W1-T14684 a decided restart's exit names each step from the pool settle to the exit", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14684-`));
  scratch.push(root);
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ["A", "B"].map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const rows: Array<Record<string, unknown>> = [];
  const settles = new Map(["A", "B"].map((id) => [id, deferred<RunResult>()]));
  let started = 0;
  let now = Date.now();
  let stop = false;
  let armed: { origin: string; requestedAt: string; codeSha: string } | undefined;
  const run = runDaemon(loadPlan(planPath), {
    refreshMerged: () => () => false,
    checkStop: () => stop ? "cleanup" : undefined,
    checkFreshness: () => ({ stale: false }),
    consumeRestartRequest: () => { const request = armed ?? null; armed = undefined; return request; },
    now: () => new Date(now),
    sleep: async () => { now += 60_000; await delay(1); },
    runOne: (id, options) => {
      started++;
      const settled = settles.get(id)!.promise;
      options!.onChild!({ started: true, runId: id, dir: root, pid: process.pid, settled,
        abort: async () => { throw new Error("a requested restart never aborts a child"); } });
      return settled;
    },
    log: (step, extra) => { rows.push({ step, ...extra }); },
  }, { laneCount: 2, pollIntervalMs: 5 });
  try {
    for (let i = 0; i < 1000 && started < 2; i++) await delay(2);
    assert.equal(started, 2, "both runs started as children");
    armed = { origin: "progress-watchdog", requestedAt: new Date(now).toISOString(), codeSha: "c".repeat(40) };
    const summary = await Promise.race([run, delay(10_000).then(() => undefined)]);
    assert.ok(summary, "the daemon exits");
    const exit = rows.find((r) => r.step === "daemon.freshness_exit");
    const phases = exit?.phases_ms as Record<string, unknown> | undefined;
    const settle = phases?.settle as Record<string, unknown> | undefined;
    assert.ok(settle, `the exit names the settlement steps: ${JSON.stringify(phases)}`);
    for (const part of ["stop_ticker", "lifetime_pressure", "classify", "claim_stall", "interphase_stop"]) {
      assert.equal(typeof settle[part], "number", `${part}: ${JSON.stringify(settle)}`);
    }
    assert.deepEqual(settle.process_by_task, {}, "the children ran on, so no run was processed before the exit");
    const named = Object.entries(settle).filter(([key]) => key !== "process_by_task")
      .reduce((sum, [, ms]) => sum + (ms as number), 0);
    assert.ok(typeof phases?.total !== "number" || named <= (phases.total as number), "the steps fit inside the exit's total");
  } finally {
    stop = true;
    for (const [id, settle] of settles) settle.resolve(result(id));
    await run;
  }
});
