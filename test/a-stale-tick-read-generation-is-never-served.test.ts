import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  freezeReadGeneration, freshReadGeneration, onePassPerGeneration, startReadPlane, TICK_READ_MAX_AGE_MS,
  type ReadGeneration,
} from "../src/lib/read-plane.js";
import { daemonCommand } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T5762: the 10-04 22:05Z boot published its tick-read generation at ~22:08Z, its own full pass
// was skipped (one already in flight), and the next consumer came from a dispatch phase that ran to
// 23:35Z — and was handed the 22:08Z open-PR views. An aged generation is refused, never served.

const PUBLISHED_AT_MS = Date.parse("2026-10-04T22:08:00Z");
const HOUR_MS = 60 * 60_000;

type Facts = { openPrs: number[] };

function harness(nowMs: number) {
  let clockMs = nowMs;
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const published = freezeReadGeneration<ReadGeneration<Facts>>({ generation: 1, source: "worker",
    publishedAtMs: PUBLISHED_AT_MS, facts: { openPrs: [9162, 9166] } });
  const reads: number[] = [];
  let generation = 1;
  const read = async (input: { openPrs: number[] }): Promise<ReadGeneration<Facts>> => {
    reads.push(clockMs);
    return freezeReadGeneration({ generation: ++generation, source: "worker", publishedAtMs: clockMs, facts: input });
  };
  const bound = { clock: clockFromMillisFn(() => clockMs), log: (step: string, extra?: Record<string, unknown>) => {
    rows.push({ step, extra });
  } };
  return { published, read, reads, rows, bound, setNow: (ms: number) => { clockMs = ms; } };
}

test("an hour-old generation is not served by onePassPerGeneration: the consumer reads its own", async () => {
  const h = harness(PUBLISHED_AT_MS + HOUR_MS);
  const tickRead = onePassPerGeneration(() => h.published, h.read, () => ({ openPrs: [9200] }), h.bound);
  assert.deepEqual(await tickRead(), { openPrs: [9200] }, "the first pass reads its own generation");
  assert.deepEqual(h.reads, [PUBLISHED_AT_MS + HOUR_MS]);
  assert.deepEqual(h.rows, [{ step: "tick_read.stale_refused", extra: { consumer: "full_sweep", generation: 1,
    age_ms: HOUR_MS, max_age_ms: TICK_READ_MAX_AGE_MS } }], "one row names the refusal and the age");
  assert.deepEqual(await tickRead(), { openPrs: [9200] }, "the refused generation is never served later either");
  assert.equal(h.reads.length, 2);
  assert.equal(h.rows.length, 1, "a generation is refused once, not once per pass");
  assert.deepEqual(h.published.facts.openPrs, [9162, 9166], "the published generation is untouched");
});

test("a generation younger than the bound is served exactly once, as before", async () => {
  const h = harness(PUBLISHED_AT_MS + TICK_READ_MAX_AGE_MS);
  const tickRead = onePassPerGeneration(() => h.published, h.read, () => ({ openPrs: [9200] }), h.bound);
  assert.equal(await tickRead(), h.published.facts, "a generation at the bound is still served");
  assert.deepEqual(h.reads, []);
  assert.deepEqual(await tickRead(), { openPrs: [9200] }, "a consumed generation is never served twice");
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.rows, []);
});

test("an aged generation with no read plane leaves the consumer on its own live read", async () => {
  const h = harness(PUBLISHED_AT_MS + TICK_READ_MAX_AGE_MS + 1);
  const planeless = onePassPerGeneration(() => h.published, undefined, () => ({ openPrs: [] }), h.bound);
  assert.equal(await planeless(), undefined);
  assert.equal(h.rows[0]?.step, "tick_read.stale_refused");
  assert.equal(h.rows[0]?.extra?.age_ms, TICK_READ_MAX_AGE_MS + 1);
});

test("the default bound reads the real clock, so a generation stamped an hour ago is refused", async () => {
  const published = freezeReadGeneration<ReadGeneration<Facts>>({ generation: 4, source: "inline",
    publishedAtMs: Date.now() - HOUR_MS, facts: { openPrs: [1] } });
  assert.equal(freshReadGeneration(published, { consumer: "refresh_merged" }), undefined);
  assert.equal(freshReadGeneration(undefined, { consumer: "refresh_merged" }), undefined);
  const fresh = { ...published, publishedAtMs: Date.now() };
  assert.equal(freshReadGeneration(fresh, { consumer: "refresh_merged" }), fresh);
  const served = await onePassPerGeneration(() => fresh, undefined, () => ({}))();
  assert.equal(served, fresh.facts);
});

test("the read plane stamps each generation with the instant its read began, worker and inline alike", async () => {
  let clockMs = PUBLISHED_AT_MS;
  const plane = startReadPlane({
    workerUrl: new URL("../src/run-task.ts", import.meta.url), workerInput: {},
    spawn: () => { clockMs += 1_000; throw new Error("worker unavailable"); },
    inline: (input: { n: number }) => { clockMs += 60_000; return input; },
    clock: clockFromMillisFn(() => clockMs), log: () => {},
  });
  try {
    const first = await plane.read({ n: 1 });
    assert.equal(first.source, "inline");
    assert.equal(first.publishedAtMs, PUBLISHED_AT_MS + 1_000, "the inline read's own start, not the failed attempt's");
    const second = await plane.read({ n: 2 });
    assert.equal(second.publishedAtMs, PUBLISHED_AT_MS + 62_000);
    assert.ok(Object.isFrozen(second));
  } finally { await plane.stop(); }
  const worker = startReadPlane({
    workerUrl: new URL("../src/run-task.ts", import.meta.url), workerInput: {},
    spawn: () => new Worker(`const { parentPort } = require('node:worker_threads');
      parentPort.on('message', ({ generation, input }) => parentPort.postMessage({ generation, facts: input }));`,
    { eval: true }),
    inline: () => { throw new Error("the worker answers"); },
    clock: clockFromMillisFn(() => clockMs), log: () => {},
  });
  try {
    clockMs = PUBLISHED_AT_MS + HOUR_MS;
    const read = await worker.read({ n: 3 });
    assert.equal(read.source, "worker");
    assert.equal(read.publishedAtMs, PUBLISHED_AT_MS + HOUR_MS);
  } finally { await worker.stop(); }
});

test("daemonCommand's refreshMerged and board binder refuse an aged tick-read generation and read live", async () => {
  const home = makeTempDir("stale-tick-read");
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const now = new Date();
  utimesSync(home, now, now);
  const gh = ghShim([{ when: "", stdout: "[]" }], { kind: "stale-tick-read" });
  const previous = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = `${gh.dir}:${previous.PATH}`;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      startGithubAppRefresh: () => ({ armed: false }),
      runDaemon: (async (_plan: unknown, deps: DaemonDeps): Promise<DaemonSummary> => {
        assert.ok(deps.refreshMergedAsync, "the real wiring owns a read plane");
        assert.ok(deps.prefetchBoardReview, "the self-target wiring binds the board items to the generation");
        await deps.refreshMergedAsync();
        deps.refreshMerged();
        await deps.prefetchBoardReview();
        mock.timers.enable({ apis: ["Date"], now: Date.now() + TICK_READ_MAX_AGE_MS + 60_000 });
        let prefetching: Promise<void> | undefined;
        try {
          deps.refreshMerged();
          prefetching = deps.prefetchBoardReview();
        } finally { mock.timers.reset(); }
        await prefetching;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      }) as never,
    });
    assert.equal(code, 0);
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { step: string; consumer?: string; age_ms?: number });
    assert.ok(rows.some((row) => row.step === "daemon.target"), "positive control: this is the daemon's own ledger");
    const refused = rows.filter((row) => row.step === "tick_read.stale_refused");
    assert.deepEqual(refused.map((row) => row.consumer), ["refresh_merged", "board_items"],
      "only the aged reads are refused");
    assert.ok((refused[0]?.age_ms ?? 0) > TICK_READ_MAX_AGE_MS);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(gh.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
