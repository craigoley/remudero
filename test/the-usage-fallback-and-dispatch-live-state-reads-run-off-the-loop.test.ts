import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { prefetchLiveStates, runDrain, type DrainDeps, type MergedSet } from "../src/lib/drain.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import {
  defaultAsyncUsageProbeRunner,
  ghLiveStateByNumberAsync,
  readUsageSnapshotAsync,
  readUsageSnapshotPreferSdk,
  type AsyncUsageProbeRunner,
  type RunResult,
} from "../src/run-task.js";

// W1-T5719 — the usage CLI fallback and dispatch's live-state reads run OFF THE LOOP.
//
// The two admission-path reads that froze the daemon loop for ~14 s and ~45 s after the 10-04 19:09
// boot were an `execFileSync` (the usage fallback) and a synchronous `gh` read per candidate. Each
// test below schedules a TIMER before the slow work and asserts the timer fires while that work is
// still pending: with a synchronous read in the path the timer could not fire until the read ended,
// so `timerFiredAt < settledAt` is the falsifier (restore `execFileSync` and it fails).

const SAMPLE_USAGE_TEXT = [
  "Using your subscription",
  "Current session: 12% used · resets 3pm",
  "Current week (all models): 34% used · resets Jan 8",
  "",
].join("\n");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function withHome<T>(realHome: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.HOME;
  process.env.HOME = realHome;
  return fn().finally(() => {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  });
}

test("a usage CLI runner that never answers resolves as a spawn failure within its timeout while a timer scheduled before it still fires", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5719-root-"));
  const home = mkdtempSync(join(tmpdir(), "rmd-t5719-home-"));
  try {
    const config: Config = { claudeBin: "claude-never-answers", root };
    const failures: Array<{ stage: string; reason: string }> = [];
    const never: AsyncUsageProbeRunner = () => new Promise<string>(() => undefined);
    let timerFiredAt = Number.POSITIVE_INFINITY;
    const started = Date.now();
    setTimeout(() => {
      timerFiredAt = Date.now() - started;
    }, 15);

    const snap = await withHome(home, () =>
      readUsageSnapshotAsync(config, never, (stage, reason) => failures.push({ stage, reason }), 80),
    );
    const settledAt = Date.now() - started;

    assert.equal(snap, undefined, "an unanswered probe is unreadable, polarity unchanged");
    assert.deepEqual(failures.map((f) => f.stage), ["spawn"], "a timeout is the existing spawn failure kind");
    assert.match(failures[0]!.reason, /timed out after 80ms/);
    assert.ok(settledAt >= 70 && settledAt < 2000, `bounded by its timeout, took ${settledAt}ms`);
    assert.ok(timerFiredAt < settledAt, `the loop stayed free: timer fired at ${timerFiredAt}ms, probe settled at ${settledAt}ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the async usage runner still parses a good read and keeps parse failures distinct from spawn failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5719-root-"));
  const home = mkdtempSync(join(tmpdir(), "rmd-t5719-home-"));
  try {
    const config: Config = { claudeBin: "claude-fake", root };
    const failures: string[] = [];
    const good = await withHome(home, () =>
      readUsageSnapshotAsync(config, async () => SAMPLE_USAGE_TEXT, (stage) => failures.push(stage), 1000),
    );
    assert.equal(good?.session.percentUsed, 12);
    const garbled = await withHome(home, () =>
      readUsageSnapshotAsync(config, async () => "not a usage panel", (stage) => failures.push(stage), 1000),
    );
    assert.equal(garbled, undefined);
    const rejected = await withHome(home, () =>
      readUsageSnapshotAsync(config, () => Promise.reject(new Error("boom")), (stage) => failures.push(stage), 1000),
    );
    assert.equal(rejected, undefined);
    assert.deepEqual(failures, ["parse", "spawn"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the default async usage runner runs a real child off the loop, returns its stdout as text, and rejects on a failing or timed-out child", async () => {
  const opts = { encoding: "utf8" as const, env: { ...process.env } as Record<string, string>, maxBuffer: 1 << 20, timeout: 5000 };
  let timerFiredAt = Number.POSITIVE_INFINITY;
  const started = Date.now();
  setTimeout(() => {
    timerFiredAt = Date.now() - started;
  }, 10);
  const out = await defaultAsyncUsageProbeRunner(
    process.execPath,
    ["-e", "setTimeout(() => process.stdout.write('probe-ok'), 150)"],
    opts,
  );
  const settledAt = Date.now() - started;
  assert.equal(out, "probe-ok");
  assert.equal(typeof out, "string");
  assert.ok(timerFiredAt < settledAt, `timer fired at ${timerFiredAt}ms before the child settled at ${settledAt}ms`);

  await assert.rejects(defaultAsyncUsageProbeRunner(process.execPath, ["-e", "process.exit(3)"], opts));
  await assert.rejects(
    defaultAsyncUsageProbeRunner(process.execPath, ["-e", "setTimeout(() => undefined, 10000)"], { ...opts, timeout: 100 }),
  );
});

test("readUsageSnapshotPreferSdk awaits an asynchronous CLI fallback while a timer scheduled before it fires", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5719-root-"));
  try {
    const config: Config = { claudeBin: "claude-unused", root };
    let timerFiredAt = Number.POSITIVE_INFINITY;
    const started = Date.now();
    setTimeout(() => {
      timerFiredAt = Date.now() - started;
    }, 10);
    const snap = await readUsageSnapshotPreferSdk(config, {
      viaSdk: async () => undefined,
      viaCli: async () => {
        await sleep(60);
        return { session: { percentUsed: 7, resetsAt: undefined }, weekly: { percentUsed: 9, resetsAt: undefined } } as never;
      },
    });
    const settledAt = Date.now() - started;
    assert.equal((snap as { session: { percentUsed: number } }).session.percentUsed, 7);
    assert.ok(timerFiredAt < settledAt, `timer fired at ${timerFiredAt}ms before the fallback settled at ${settledAt}ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── dispatch live-state reads ────────────────────────────────────────────────────────────────

const IDS = ["A", "B", "C", "D", "E"];

function fivePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t5719-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    IDS.map((id) => `- id: ${id}\n  title: ${id.toLowerCase()}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`).join(""),
  );
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

test("a dispatch selection over five candidates with a slow live-state reader keeps the loop responsive and treats a timed-out read as unknown", async () => {
  const plan = fivePlan();
  const prOf = (id: string) => 100 + IDS.indexOf(id);
  let inFlight = 0;
  let peak = 0;
  const readLiveState = async (id: string): Promise<string | undefined> => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      if (id === "A") return await new Promise<string>(() => undefined); // never answers
      await sleep(40);
      return "CLOSED"; // stood down: the cached in-flight read was stale, the task is runnable
    } finally {
      inFlight--;
    }
  };

  let timerFiredAt = Number.POSITIVE_INFINITY;
  const started = Date.now();
  setTimeout(() => {
    timerFiredAt = Date.now() - started;
  }, 10);

  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const merged = new Set<string>();
  const deps: DrainDeps = {
    refreshMerged: () => (id) => merged.has(id),
    isOpenPr: (id) => prOf(id),
    readLiveState,
    liveStateTimeoutMs: 150,
    runOne: async (id) => {
      ran.push(id);
      merged.add(id);
      return okResult(id);
    },
    log: (step, extra = {}) => lines.push({ step, extra }),
  };
  const summary = await runDrain(plan, deps, { max: 1 });
  const settledAt = Date.now() - started;

  assert.equal(peak, 5, "all five candidates' reads were in flight at once, not one after another");
  assert.ok(timerFiredAt < settledAt, `timer fired at ${timerFiredAt}ms, selection settled at ${settledAt}ms`);
  assert.ok(settledAt >= 140, "selection waited out the unanswered read's timeout, never forever");
  assert.deepEqual(ran, ["B"], "A's timed-out read is unknown, so A stays in flight and is skipped; B is the next runnable");
  assert.equal(summary.stopReason, "max_reached");
  const indeterminate = lines.find((l) => l.step === "dispatch.live_state_indeterminate");
  assert.ok(indeterminate, "the unknown read is ledgered, exactly as a failed read is");
  assert.equal(indeterminate!.extra.task, "A");
  assert.equal(indeterminate!.extra.timed_out, true, "and it names the timeout as the cause");
  assert.equal(lines.filter((l) => l.step === "dispatch.skipped" && l.extra.task === "A").length, 1);
});

test("prefetchLiveStates reads only unmerged in-flight candidates, treats a throwing or rejecting reader as unknown, and accepts a synchronous reader", async () => {
  const plan = fivePlan();
  const seen: string[] = [];
  const read = (id: string): string | undefined | Promise<string | undefined> => {
    seen.push(id);
    if (id === "B") throw new Error("sync throw");
    if (id === "C") return Promise.reject(new Error("async reject"));
    if (id === "D") return "MERGED"; // synchronous value
    return Promise.resolve("OPEN");
  };
  const isMerged: MergedSet = (id) => id === "E";
  const live = await prefetchLiveStates(plan, isMerged, (id) => (id === "A" || id === "B" || id === "C" || id === "D" || id === "E" ? 1 : undefined), read, 100);
  assert.deepEqual([...seen].sort(), ["A", "B", "C", "D"], "the already-merged E is never read");
  assert.equal(live.read("A", 1), "OPEN");
  assert.equal(live.read("B", 1), undefined);
  assert.equal(live.read("C", 1), undefined);
  assert.equal(live.read("D", 1), "MERGED");
  assert.equal(live.timedOut.size, 0);
});

test("ghLiveStateByNumberAsync folds the REST row like the synchronous reader and resolves undefined on a failed read", async () => {
  const argvs: string[][] = [];
  const merged = await ghLiveStateByNumberAsync("o", "r", 7, async (args) => {
    argvs.push(args);
    return { state: "closed", merged: true };
  });
  assert.equal(merged, "MERGED");
  assert.match(argvs[0]!.join(" "), /repos\/o\/r\/pulls\/7/);
  const open = await ghLiveStateByNumberAsync("o", "r", 7, async () => ({ state: "open", merged: false }));
  assert.equal(open, "OPEN");
  const failed = await ghLiveStateByNumberAsync("o", "r", 7, async () => {
    throw new Error("network");
  });
  assert.equal(failed, undefined);
});
