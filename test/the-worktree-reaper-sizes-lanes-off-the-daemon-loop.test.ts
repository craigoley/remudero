import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { reapStaleWorktrees, runAdhocLaneReapRung, writeRunLock } from "../src/lib/worker.js";

function fixture() {
  const root = makeTempDir("async-lane-size");
  const lanes = join(root, "lanes");
  mkdirSync(lanes);
  return { root, lanes, config: { root } as Config };
}

function lane(root: string, name: string) {
  const path = join(root, name);
  mkdirSync(path);
  utimesSync(path, 1, 1);
  return path;
}

const diskHeadroom = () => ({ freeBytes: 0, totalBytes: 100 });

test("W1-T6357: the loop turns while the reaper sizes lanes", async () => {
  const { root, lanes, config } = fixture();
  const candidate = lane(lanes, "terminal");
  const calls = join(root, "calls");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "du"), `#!${process.execPath}\n` +
    `require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'du\\n');\n` +
    "setTimeout(() => console.log('4\\t' + process.argv[3]), 200);\n", { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  try {
    const summary = await runAdhocLaneReapRung(config, (step, extra) => rows.push({ step, extra }), {
      enabled: () => true, diskHeadroom,
    });
    assert.ok(ticks > 0, "a sleeping du must leave the event loop free to run timers");
    assert.deepEqual(summary?.reaped, ["terminal"]);
    assert.equal(existsSync(candidate), false, "await completes removal");
    assert.equal(readFileSync(calls, "utf8"), "du\n");
    assert.deepEqual(rows.find((r) => r.step === "adhoc_lane.reap.census")?.extra?.reaped,
      { count: 1, bytes: 4096, bytes_unknown: 0 });
  } finally {
    clearInterval(timer);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("W1-T6357: reap decisions match the synchronous sizing", async () => {
  for (const enabled of [false, true]) {
    const { lanes, config } = fixture();
    lane(lanes, "terminal");
    const live = lane(lanes, "live");
    writeRunLock(live, { pid: process.pid, run_id: "live", startedAt: new Date().toISOString() });
    const expected = reapStaleWorktrees(lanes, { dryRun: true, maxAgeMs: 0, isPidAlive: () => true });
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const result = await runAdhocLaneReapRung(config, (step, extra) => rows.push({ step, extra }), {
      enabled: () => enabled, diskHeadroom, isPidAlive: () => true,
      sizeBytes: async (path) => { assert.ok(existsSync(path), "measure before deletion"); return 1024; },
    });
    assert.deepEqual(result, expected);
    assert.equal(existsSync(join(lanes, "terminal")), !enabled);
    assert.equal(existsSync(live), true);
    const census = rows.find((r) => r.step === "adhoc_lane.reap.census")!.extra!;
    assert.deepEqual(census.kept_by_reason, { "live-pid": { count: 1, bytes: 1024, bytes_unknown: 0 } });
    assert.deepEqual(census.reaped, { count: 1, bytes: 1024, bytes_unknown: 0 });
  }
});

test("W1-T6357: sizing is bounded and a repeated candidate reuses its measurement", async () => {
  const { lanes, config } = fixture();
  const paths = [lane(lanes, "first"), lane(lanes, "second")];
  writeFileSync(join(lanes, "ignored"), "not a lane");
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  await runAdhocLaneReapRung(config, () => {}, {
    diskHeadroom, repoDir: lanes, listUnmanaged: () => [paths[0]],
    sizeBytes: async (path) => {
      calls.push(path);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return 1024;
    },
  });
  assert.deepEqual(calls.sort(), paths.sort());
  assert.equal(peak, 1, "only one size probe runs at a time");
});

test("W1-T6357: failed and invalid measurements are cached as unknown bytes", async () => {
  for (const value of [undefined, NaN, -1, "reject"] as const) {
    const { lanes, config } = fixture();
    const candidate = lane(lanes, "terminal");
    let calls = 0;
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    await runAdhocLaneReapRung(config, (step, extra) => rows.push({ step, extra }), {
      diskHeadroom, repoDir: lanes, listUnmanaged: () => [candidate],
      sizeBytes: async () => {
        calls++;
        if (value === "reject") throw new Error("size unavailable");
        return value;
      },
    });
    assert.equal(calls, 1, "a failed size probe is not retried within the pass");
    assert.deepEqual(rows.find((r) => r.step === "adhoc_lane.reap.census")?.extra?.reaped,
      { count: 2, bytes: 0, bytes_unknown: 2 });
    assert.equal(rows.filter((r) => r.step === "adhoc_lane.reap.measurement_error").length,
      value === "reject" ? 1 : 0);
    assert.equal(existsSync(candidate), true, "survey remains disarmed despite unknown bytes");
  }
});

test("W1-T6357: rung completion waits for lane removal and its census", async () => {
  const { lanes, config } = fixture();
  const candidate = lane(lanes, "terminal");
  const rows: string[] = [];
  let finishSize!: (bytes: number) => void;
  const size = new Promise<number>((resolve) => { finishSize = resolve; });
  const completion = runAdhocLaneReapRung(config, (step) => rows.push(step), {
    enabled: () => true, diskHeadroom, sizeBytes: () => size,
  });
  let completed = false;
  void completion.then(() => { completed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false, "the rung remains pending while sizing is pending");
  assert.equal(existsSync(candidate), true, "the candidate survives until its size is known");
  assert.equal(rows.includes("adhoc_lane.reap.census"), false, "the census waits for the pass");
  finishSize(4096);
  const summary = await completion;
  assert.deepEqual(summary?.reaped, ["terminal"]);
  assert.equal(existsSync(candidate), false, "completion includes removal");
  assert.equal(rows.filter((step) => step === "adhoc_lane.reap.census").length, 1);
});
