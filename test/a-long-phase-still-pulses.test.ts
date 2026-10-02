/**
 * E32 — a daemon busy in a phase with no ticker must still read as polling, and a blocked or finished
 * one must not. 93 of 119 "silent" gaps measured on 2026-10-02 were a free event loop doing work that
 * writes no `daemon.*` row (see src/lib/liveness-pulse.ts for the measurement).
 *
 * Both directions are asserted, because a pulse that wrote unconditionally would pass the first test
 * and is exactly what the second and third exist to catch.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlan, type Plan } from "../src/lib/plan.js";
import { daemonCommand, type RunResult } from "../src/run-task.js";
import { runDaemon, type DaemonDeps, type DaemonSummary } from "../src/lib/daemon.js";
import { deriveLastPoll } from "../src/lib/daemon-health.js";
import { LIVENESS_PULSE_STEP, livenessPulseTick, noteDaemonRow, type LivenessPulseState } from "../src/lib/liveness-pulse.js";

const POLL_MS = 20;

function onePlan(): { plan: Plan; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-pulse-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return { plan: loadPlan(f), dir };
}

interface Row { step: string; extra: Record<string, unknown>; atMs: number }

/** One dispatch whose worker holds the loop's attention for `workMs`, optionally blocking it first. */
async function longDispatch(opts: { workMs: number; blockMs?: number; pulse: boolean }): Promise<Row[]> {
  const { plan, dir } = onePlan();
  const merged = new Set<string>();
  const rows: Row[] = [];
  try {
    await runDaemon(
      plan,
      {
        refreshMerged: () => (id) => merged.has(id),
        runOne: async (id): Promise<RunResult> => {
          if (opts.blockMs) {
            const until = Date.now() + opts.blockMs;
            while (Date.now() < until) { /* a synchronous block, as a sync gh/git call would be */ }
          }
          await new Promise((r) => setTimeout(r, opts.workMs));
          merged.add(id);
          return { taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged" };
        },
        sleep: async () => {},
        log: (step, extra = {}) => rows.push({ step, extra, atMs: Date.now() }),
        livenessPulse: opts.pulse,
      } satisfies DaemonDeps,
      { max: 1, pollIntervalMs: POLL_MS },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}

test("a daemon in a long phase with no ticker writes daemon.pulse, so the newest daemon.* row stays fresh", async () => {
  const rows = await longDispatch({ workMs: 200, pulse: true });
  const iteration = rows.findIndex((r) => r.step === "daemon.iteration");
  const settled = rows.findIndex((r) => r.step === "dispatch.settled_set");
  assert.ok(iteration >= 0 && settled > iteration, "the fixture must dispatch and settle");
  const inside = rows.slice(iteration + 1, settled).filter((r) => r.step === LIVENESS_PULSE_STEP);
  assert.ok(inside.length >= 3, `expected pulses during the 200 ms phase at a ${POLL_MS} ms interval, saw ${inside.length}`);
  assert.equal(inside[0].extra.poll_interval_ms, POLL_MS, "the pulse declares its cadence, so readers size their bound from it");
  const quiet = inside.map((r) => r.extra.quiet_ms as number);
  assert.ok(quiet[quiet.length - 1] > quiet[0], `quiet_ms keeps growing while no work row lands: ${quiet.join(",")}`);

  // Through the real reader: the newest daemon.* row inside the phase is a pulse, at most ~2 intervals old.
  const lastInside = inside[inside.length - 1];
  const poll = deriveLastPoll(rows.slice(0, settled).map((r) => ({ ts: new Date(r.atMs).toISOString(), step: r.step, ...r.extra })));
  assert.equal(poll.lastPollTs, new Date(lastInside.atMs).toISOString());
  assert.equal(poll.pollIntervalMs, POLL_MS);
});

test("without the pulse, the same long phase writes no daemon.* row — the gap the now view read as silent", async () => {
  const rows = await longDispatch({ workMs: 200, pulse: false });
  const iteration = rows.findIndex((r) => r.step === "daemon.iteration");
  const settled = rows.findIndex((r) => r.step === "dispatch.settled_set");
  assert.ok(iteration >= 0 && settled > iteration, "the fixture must dispatch and settle");
  const daemonRowsInside = rows.slice(iteration + 1, settled).filter((r) => r.step.startsWith("daemon."));
  assert.deepEqual(daemonRowsInside.map((r) => r.step), [], "the control: nothing else covers this phase");
});

test("a blocked event loop writes no pulse while blocked, and the next pulse tick names the stall as daemon.loop_lag", async () => {
  const rows = await longDispatch({ blockMs: 150, workMs: 60, pulse: true });
  const iteration = rows.find((r) => r.step === "daemon.iteration");
  assert.ok(iteration, "the fixture must dispatch");
  const blockEndMs = iteration.atMs + 150;
  const duringBlock = rows.filter((r) => r.step === LIVENESS_PULSE_STEP && r.atMs > iteration.atMs && r.atMs < blockEndMs - 5);
  assert.equal(duringBlock.length, 0, "a blocked loop must not look alive");
  const lag = rows.find((r) => r.step === "daemon.loop_lag" && r.extra.phase === "pulse");
  assert.ok(lag, `the pulse reports the stall; steps were ${rows.map((r) => r.step).join(",")}`);
  assert.ok((lag.extra.lag_ms as number) > POLL_MS, "the reported lag exceeds one interval");
});

test("the pulse stops with the run, so a finished daemon still goes stale", async () => {
  const rows = await longDispatch({ workMs: 60, pulse: true });
  const countAtEnd = rows.length;
  assert.equal(rows[countAtEnd - 1].step, "daemon.summary");
  await new Promise((r) => setTimeout(r, POLL_MS * 5));
  assert.equal(rows.length, countAtEnd, "no row may be written after daemon.summary");
});

test("a pulse tick writes nothing while a daemon.* work row is fresher than one interval, and its own rows never reset quiet_ms", () => {
  const written: string[] = [];
  const lags: number[] = [];
  const state: LivenessPulseState = { lastWorkRowAtMs: 0, lastTickAtMs: 0 };
  noteDaemonRow(state, "daemon.alive", 1_000);
  livenessPulseTick(state, 1_050, 60, (s) => written.push(s), (x) => lags.push(x.observedAtMs - x.dueAtMs));
  assert.equal(written.length, 0, "a daemon whose phases already report pays nothing");
  noteDaemonRow(state, LIVENESS_PULSE_STEP, 1_100);
  noteDaemonRow(state, "daemon.loop_lag", 1_100);
  noteDaemonRow(state, "sweep.pass", 1_100);
  livenessPulseTick(state, 1_110, 60, (s, e) => written.push(`${s}:${String(e?.quiet_ms)}`), (x) => lags.push(x.observedAtMs - x.dueAtMs));
  assert.deepEqual(written, ["daemon.pulse:110"], "only daemon.* work rows move the quiet clock");
  assert.deepEqual(lags, [990, 0], "each tick reports its own lateness against the previous tick");
});

test("daemonCommand wires the liveness pulse into the real daemon", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-pulse-home-"));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(captured?.livenessPulse, true);
});
