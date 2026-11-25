// W1-T14788: after a decided restart the settle leaves its lifetime-pressure judging to the successor, whose own
// selection re-signals the same tasks. Measured 2026-11-25: the predecessor's settle awaited that judging 542,001 ms
// after the restart was decided, and the standby waited 802,337 ms for its promote marker.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const result = (id: string): RunResult => ({ taskId: id, runId: id, merged: false, verdict: "no_pr", costUsd: 0 });

function harness() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14788-`));
  scratch.push(root);
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ["A", "B"].map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const rows: Array<Record<string, unknown>> = [];
  const settles = new Map(["A", "B"].map((id) => [id, deferred<RunResult>()]));
  const judging = deferred<void>();
  const state = { started: 0, judged: [] as string[][], judgingDone: false, stop: false, now: Date.now(),
    armed: undefined as { origin: string; requestedAt: string; codeSha: string } | undefined };
  const deps: DaemonDeps = {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => () => false,
    checkStop: () => state.stop ? "cleanup" : undefined,
    checkFreshness: () => ({ stale: false }),
    consumeRestartRequest: () => { const request = state.armed ?? null; state.armed = undefined; return request; },
    // Every task is under lifetime pressure, and its judging never ends until the test ends it.
    isLifetimeCapExceeded: () => true,
    onLifetimePressure: async (tasks) => {
      state.judged.push(tasks.map((task) => task.id));
      await judging.promise;
      state.judgingDone = true;
    },
    now: () => new Date(state.now),
    sleep: async () => { state.now += 60_000; await delay(1); },
    runOne: (id, options) => {
      state.started++;
      const settled = settles.get(id)!.promise;
      options!.onChild!({ started: true, runId: id, dir: root, pid: process.pid, settled,
        abort: async () => { throw new Error("a requested restart never aborts a child"); } });
      return settled;
    },
    log: (step, extra) => { rows.push({ step, ...extra }); },
  };
  const run = runDaemon(loadPlan(planPath), deps, { laneCount: 2, pollIntervalMs: 5 });
  const finish = async (): Promise<void> => {
    state.stop = true;
    judging.resolve();
    for (const [id, settle] of settles) settle.resolve(result(id));
    await run;
  };
  return { rows, settles, judging, state, run, finish };
}

const waitFor = async (done: () => boolean): Promise<void> => { for (let i = 0; i < 2000 && !done(); i++) await delay(2); };

test("W1-T14788 a settle after a decided restart does not await the lifetime-pressure judging", async () => {
  const h = harness();
  try {
    await waitFor(() => h.state.started >= 2);
    assert.equal(h.state.started, 2, "both runs started as children");
    h.state.armed = { origin: "progress-watchdog", requestedAt: new Date(h.state.now).toISOString(), codeSha: "c".repeat(40) };
    const summary = await Promise.race([h.run, delay(10_000).then(() => undefined)]);
    assert.ok(summary, "the daemon exits while the judging it would have awaited never ends");
    assert.equal(h.state.judgingDone, false, "no judging finished before the exit");
    const exit = h.rows.find((r) => r.step === "daemon.freshness_exit");
    assert.ok(exit, "positive control: the restart exited through the freshness exit");
    assert.deepEqual([...(exit.lifetime_pressure_left_to_successor as string[])].sort(), ["A", "B"],
      `the exit names the tasks left to the successor: ${JSON.stringify(exit)}`);
  } finally {
    await h.finish();
  }
});

test("W1-T14788 a settle with no restart decided still awaits the lifetime-pressure judging", async () => {
  const h = harness();
  try {
    await waitFor(() => h.state.started >= 2);
    assert.equal(h.state.started, 2, "both runs started as children");
    for (const [id, settle] of h.settles) settle.resolve(result(id));
    await waitFor(() => h.state.judged.length > 0);
    assert.deepEqual([...h.state.judged[0]!].sort(), ["A", "B"], "the settle hands both pressured tasks to the judging");
    const ticksAtJudging = h.rows.filter((r) => r.step === "daemon.tick").length;
    await delay(200);
    assert.equal(h.rows.filter((r) => r.step === "daemon.tick").length, ticksAtJudging, "no new tick starts while the judging runs");
    assert.equal(h.rows.some((r) => r.step === "daemon.freshness_exit"), false, "no restart was decided");
    h.judging.resolve();
    await waitFor(() => h.rows.filter((r) => r.step === "daemon.tick").length > ticksAtJudging);
    assert.equal(h.state.judgingDone, true, "the settle awaited the judging to its end");
    assert.ok(h.rows.filter((r) => r.step === "daemon.tick").length > ticksAtJudging, "the loop goes on once the judging ends");
  } finally {
    await h.finish();
  }
  // Contrast under the same pressure: only a decided restart leaves the judging to the successor (base awaited it here).
  const restarted = harness();
  try {
    await waitFor(() => restarted.state.started >= 2);
    restarted.state.armed = { origin: "progress-watchdog", requestedAt: new Date(restarted.state.now).toISOString(), codeSha: "c".repeat(40) };
    const summary = await Promise.race([restarted.run, delay(10_000).then(() => undefined)]);
    assert.ok(summary, "with a restart decided, the settle does not await the judging");
    assert.equal(restarted.state.judgingDone, false, "the restart's settle left the judging unfinished");
    const exit = restarted.rows.find((r) => r.step === "daemon.freshness_exit");
    assert.deepEqual([...((exit?.lifetime_pressure_left_to_successor ?? []) as string[])].sort(), ["A", "B"],
      "the tasks the no-restart settle judged are the ones a decided restart leaves to the successor");
  } finally {
    await restarted.finish();
  }
});
