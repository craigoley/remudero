import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { benchmarkCohortDaemonPass, runBenchmarkCohortPass, runBenchmarkCohortPassOffLoop,
  type BenchmarkCohortSnapshot } from "../src/lib/benchmark-cohort.js";

const CHECKPOINT = "benchmark-cohort-index.json";

function cohortRoot(): { root: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-9845-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.ndjson"), [1, 2].map((n) => JSON.stringify({
    ts: `2026-10-16T06:0${n}:00.000Z`, step: "worker.assignment",
    worker_assignment: { id: `a${n}`, selected: { provider: "cash", model: "gpt-5-nano" } },
  })).join("\n") + "\n");
  return { root, stateDir };
}

/** Records every synchronous fs call this thread makes on the checkpoint path; a worker has its own fs. */
function recordCheckpointSyncCalls(): { calls: string[]; restore: () => void } {
  const fs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const calls: string[] = [];
  const originals = new Map<string, unknown>();
  for (const name of ["readFileSync", "writeFileSync", "renameSync", "openSync"]) {
    const original = fs[name] as (...args: unknown[]) => unknown;
    originals.set(name, original);
    fs[name] = (...args: unknown[]) => {
      if (args.slice(0, 2).some((arg) => String(arg).includes("benchmark-cohort-"))) calls.push(name);
      return original(...args);
    };
  }
  syncBuiltinESMExports();
  return { calls, restore: () => { for (const [name, original] of originals) fs[name] = original; syncBuiltinESMExports(); } };
}

const withoutTiming = (snapshot: BenchmarkCohortSnapshot): unknown => ({ ...snapshot, pressure: undefined });

test("W1-T9845: the daemon cohort pass never reads or writes its checkpoint on the loop", async () => {
  const { root, stateDir } = cohortRoot();
  const recorder = recordCheckpointSyncCalls();
  try {
    // The hook's default run (run-task.ts buildBenchmarkCohortDaemonHooks); a new suite may not import run-task.
    const first = await benchmarkCohortDaemonPass(stateDir);
    assert.equal(first.snapshot.sourceRows.assignments, 2, "the pass read the ledger");
    assert.ok((first.checkpointBytes ?? 0) > 0 && existsSync(join(stateDir, CHECKPOINT)), "the pass wrote its checkpoint");
    const second = await benchmarkCohortDaemonPass(stateDir);
    assert.equal(second.state, "complete");
    assert.equal(second.scannedSources, 0, "the second pass answered from the checkpoint it read");
    assert.deepEqual(recorder.calls, [], "no checkpoint read or write ran on the daemon thread");
    readFileSync(join(stateDir, CHECKPOINT), "utf8");
    assert.deepEqual(recorder.calls, ["readFileSync"], "positive control: a read on this thread is recorded");
  } finally {
    recorder.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9845: the off-loop cohort pass returns the in-thread result", async () => {
  const { root, stateDir } = cohortRoot();
  try {
    const nowIso = "2026-10-16T07:00:00.000Z";
    const offLoop = await runBenchmarkCohortPassOffLoop(stateDir, { maxSources: 4, nowIso });
    const index = JSON.parse(readFileSync(join(stateDir, CHECKPOINT), "utf8"));
    const written = statSync(join(stateDir, CHECKPOINT)).size
      + index.sources.reduce((sum: number, source: { segment: string }) => sum + statSync(join(stateDir, source.segment)).size, 0);
    unlinkSync(join(stateDir, CHECKPOINT));
    const inThread = await runBenchmarkCohortPass(stateDir, { maxSources: 4, nowIso });
    assert.equal(offLoop.state, inThread.state);
    assert.equal(offLoop.scannedSources, inThread.scannedSources);
    assert.equal(offLoop.pendingSources, inThread.pendingSources);
    assert.equal(offLoop.snapshot.cohorts.length, 1);
    assert.deepEqual(withoutTiming(offLoop.snapshot), withoutTiming(inThread.snapshot));
    assert.equal(offLoop.checkpointBytes, written, "the reported bytes are the checkpoint the worker wrote");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T9845: a failed cohort worker rejects the pass", async () => {
  const { root, stateDir } = cohortRoot();
  try {
    await assert.rejects(runBenchmarkCohortPassOffLoop(stateDir, { maxSources: 0 }),
      /benchmark-cohort-worker-failed: maxSources must be a positive integer/);
    await assert.rejects(runBenchmarkCohortPassOffLoop(stateDir, {}, () => { throw new Error("no threads"); }),
      /benchmark-cohort-worker-start-failed: no threads/);
    await assert.rejects(runBenchmarkCohortPassOffLoop(stateDir, {}, () => new Worker("process.exit(3)", { eval: true })),
      /benchmark-cohort-worker-exited-before-reporting: 3/);
    await assert.rejects(runBenchmarkCohortPassOffLoop(stateDir, {}, () => new Worker("throw new Error('boom')", { eval: true })),
      /benchmark-cohort-worker-error: boom/);
    assert.equal(existsSync(join(stateDir, CHECKPOINT)), false, "no failed pass wrote a checkpoint");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
