/**
 * `daemon.alive` — LIVENESS STOPS BEING INFERRED FROM WORK COMPLETION.
 *
 * THE DEFECT. Every `daemon.`-prefixed step is written when a tick CLOSES, so "the daemon
 * is alive" and "the daemon finished something recently" were ONE signal. A daemon inside
 * a long dispatch is byte-identical, to every liveness reader, to a daemon that has died —
 * this repo's own cannot-observe-is-not-a-no distinction, arriving as BUSY versus DEAD.
 *
 * MEASURED (live ledger + all 666 gzipped rotations, 898 `daemon.iteration` rows): the
 * window from a dispatch to the next `daemon.`-prefixed row runs p50 2.4m, p75 21.2m,
 * p90 39.5m, p95 52.5m. 36.5% of dispatches exceeded `fleet-heartbeat.sh`'s 600s
 * threshold; 15.9% exceeded the console's 30-minute `DEFAULT_LIVENESS_BOUND_MS`. Both
 * surfaces reported a working fleet as stale or dead, on a third of its dispatches.
 *
 * BOTH DIRECTIONS ARE PROVEN HERE, and that pairing is the point — a change that reported
 * "live" unconditionally would satisfy the first test and is exactly what the second one
 * exists to catch:
 *   (i)  a daemon INSIDE a dispatch emits `daemon.alive`, so it reads LIVE;
 *   (ii) once the loop STOPS, no further row appears, so a genuinely dead daemon still
 *        goes stale — the ticker is not a free-running "I am fine" generator.
 *
 * The off-machine half of the same claim (the real `scripts/fleet-heartbeat.sh` reading
 * these rows out of a ledger, in both directions) lives in `test/fleet-heartbeat.test.ts`
 * alongside that script's other guards, rather than being re-shaped here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { deriveLastPoll } from "../src/lib/daemon-health.js";

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "daemon-alive-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({
  taskId: id,
  runId: id + "-run",
  merged: true,
  costUsd: 0.5,
  verdict: "merged",
});

interface Line {
  step: string;
  extra: Record<string, unknown>;
}

/**
 * One dispatch held open until the ticker has slept `ticksBeforeRelease` times — the same
 * gate W1-T254's own tests use to prove the ticker runs CONCURRENTLY with `runOne` rather
 * than merely before or after it.
 */
async function dispatchHoldingOpen(
  ticksBeforeRelease: number,
  extra: Partial<DaemonDeps> = {},
): Promise<Line[]> {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const lines: Line[] = [];
  let sleeps = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `ticksBeforeRelease <= 0` releases up front: used by the no-ticker case below, which would
  // otherwise deadlock waiting for a sleep that never comes.
  if (ticksBeforeRelease <= 0) release?.();
  await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await gate;
        merged.add(id);
        return okResult(id);
      },
      // The liveness row rides the W1-T254 light-sweep ticker, whose start condition is
      // `deps.sweepLight` being wired — as it always is in production
      // (`buildSweepLightHook`). See `startInFlightTicker`'s doc for why that coupling was
      // kept rather than removed, and the last test in this file for its guard.
      sweepLight: async () => {},
      sleep: async (_ms) => {
        sleeps++;
        if (sleeps >= ticksBeforeRelease) release?.();
      },
      log: (step, e = {}) => lines.push({ step, extra: e }),
      ...extra,
    },
    { max: 1 },
  );
  return lines;
}

test("daemon.alive is emitted WHILE a dispatch is in flight — the daemon says it is alive without finishing anything", async () => {
  const lines = await dispatchHoldingOpen(3);
  const alive = lines.filter((l) => l.step === "daemon.alive");
  assert.ok(alive.length >= 1, `expected at least one daemon.alive row during the dispatch, saw ${alive.length}`);
  assert.equal(alive[0].extra.phase, "dispatch");

  // ORDERING IS THE CLAIM, not merely presence: the row must land AFTER the dispatch began
  // (`daemon.iteration`) and BEFORE it settled (`dispatch.settled_set`). A row emitted only
  // after the lanes returned would be another work-completion signal wearing a new name.
  const iteration = lines.findIndex((l) => l.step === "daemon.iteration");
  const settled = lines.findIndex((l) => l.step === "dispatch.settled_set");
  const firstAlive = lines.findIndex((l) => l.step === "daemon.alive");
  assert.ok(iteration >= 0 && settled >= 0, "the fixture must actually dispatch and settle");
  assert.ok(
    firstAlive > iteration && firstAlive < settled,
    `daemon.alive must fall strictly inside the dispatch window (iteration=${iteration}, alive=${firstAlive}, settled=${settled})`,
  );
});

test("daemon.alive carries poll_interval_ms, so deriveLastPoll does not silently fall back to its default when this row wins the max", async () => {
  const lines = await dispatchHoldingOpen(2);
  const alive = lines.find((l) => l.step === "daemon.alive");
  assert.ok(alive, "a daemon.alive row was emitted");
  assert.equal(typeof alive.extra.poll_interval_ms, "number");

  // Driven through the REAL reader, not by re-asserting the field: `deriveLastPoll` takes the
  // max ts over the `daemon.` prefix AND reads `poll_interval_ms` off that winning line.
  const now = Date.now();
  const info = deriveLastPoll(
    [
      { ts: new Date(now - 21 * 60_000).toISOString(), step: "daemon.iteration" },
      { ts: new Date(now - 30_000).toISOString(), step: "daemon.alive", ...alive.extra },
    ],
    999_999,
  );
  assert.equal(info.pollIntervalMs, alive.extra.poll_interval_ms, "the injected default must NOT win");
  assert.ok(now - Date.parse(info.lastPollTs!) < 60_000, "the in-dispatch row is the freshest poll");
});

test("the liveness signal is the PREFIX both readers already select on — daemon.alive needs no reader change", async () => {
  const lines = await dispatchHoldingOpen(2);
  const alive = lines.find((l) => l.step === "daemon.alive");
  assert.ok(alive, "a daemon.alive row was emitted");
  // `deriveLastPoll` (console + GET /v1/daemon-health) and scripts/fleet-heartbeat.sh both
  // select `step.startsWith("daemon.")`. If this row were renamed off the prefix, every
  // reader would silently go back to inferring liveness from work completion.
  assert.ok(alive.step.startsWith("daemon."), `the liveness step must keep the daemon. prefix, got ${alive.step}`);
});

test("THE OTHER DIRECTION: the ticker stops with the dispatch, so a dead daemon still goes stale — no free-running I-am-fine row", async () => {
  const lines = await dispatchHoldingOpen(3);
  const settled = lines.findIndex((l) => l.step === "dispatch.settled_set");
  assert.ok(settled >= 0, "the fixture must actually settle");

  // FALSIFIER FOR "reports live unconditionally": once the loop that emits it has stopped,
  // nothing keeps writing. A ticker that outlived its dispatch would keep a dead daemon
  // looking alive forever, which is strictly worse than the bug being fixed.
  const aliveAfterStop = lines.slice(settled + 1).filter((l) => l.step === "daemon.alive");
  assert.equal(aliveAfterStop.length, 0, "no daemon.alive row may be written after the dispatch settled");

  // And the run really did end — the ticker did not hold the daemon open.
  assert.ok(
    lines.some((l) => l.step === "daemon.summary"),
    "the daemon reached its summary, so the ticker was awaited and cleared",
  );
});

test("THE COUPLING, STATED NOT HIDDEN: with no sweepLight wired there is no ticker and so no daemon.alive — and no added sleep either", async () => {
  // This asserts a LIMIT of the fix rather than a capability, because the alternative was
  // measured and rejected. Starting the ticker unconditionally (so liveness could not depend
  // on an unrelated hook) adds a `deps.sleep` call to every dispatch, and eight suites across
  // four files count sleeps as their IDLE proxy — a dispatch ticker that slept would forge
  // evidence the daemon had idled. Production always wires `sweepLight`
  // (`buildSweepLightHook`), guarded by run-task.test.ts's "daemonCommand: builds the real
  // daemon deps (sweep + sweepLight wiring)". If that wiring is ever removed, THIS test is the
  // one that documents what is lost with it.
  const lines = await dispatchHoldingOpen(0, { sweepLight: undefined });
  assert.equal(
    lines.filter((l) => l.step === "daemon.alive").length,
    0,
    "no sweep hook means no ticker, hence no liveness row — the accepted, documented limit",
  );
  assert.ok(
    lines.some((l) => l.step === "daemon.iteration"),
    "the dispatch still happened; only the ticker is absent",
  );
});
