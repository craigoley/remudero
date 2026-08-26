import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import type { RunResult } from "../src/lib/run-result.js";
import { waitForCiGreen, pollToGate } from "../src/run-task.js";

// ── W1-T276: the RETRO SWEEP TICKER ─────────────────────────────────────────
//
// `runOne` is wrapped by a light-sweep ticker (W1-T254, the #707 fix) so a
// long dispatch never blinds the sweep — but `runRetroTrigger` was a bare
// `await` in the same single-threaded `for (;;)` loop, with nothing ticking
// while it ran. MEASURED over the live ledger: the retro fired twice, holding
// the loop for 22.0 and 21.0 minutes respectively, with ZERO sweep
// dispositions in either window. This file proves `sweepLightDuringRetro`
// (src/lib/daemon.ts) closes that gap the same way W1-T254 closed it for
// `runOne`: same clock, same stopTicker discipline, same "never dispatch"
// restriction.

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "retro-sweep-ticker-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

function firingDecision() {
  // A fire:true decision shaped like retro.ts's `evaluateRetroTrigger` output
  // — this file's whole point is the DAEMON LOOP's ticker wiring around a
  // firing decision, not the trigger's own threshold logic (covered
  // elsewhere: test/retro-trigger-check.test.ts, test/daemon-retro-trigger.test.ts).
  return { fire: true as const, reason: "merges" as const, mergesSinceMarker: 99, daysSinceMarker: 0 };
}

test("W1-T276: the light sweep runs while a fired retro is in flight, so the sweep is never blind for the retro's whole duration", async () => {
  const plan = fixturePlan();
  let lightSweeps = 0;
  let sleeps = 0;
  let releaseRetro: (() => void) | undefined;
  const retroGate = new Promise<void>((resolve) => {
    releaseRetro = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    if (sleeps >= 3) releaseRetro?.();
  };
  let stopChecks = 0;
  const summary = await runDaemon(plan, {
    refreshMerged: () => () => true, // everything merged -> nextRunnable would be "nothing runnable" if ever reached
    runOne: async (id): Promise<RunResult> => {
      throw new Error(`runOne must never be called in this fixture (task ${id}) — the retro trigger owns every tick`);
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 1 ? "test bound reached" : undefined;
    },
    checkRetroTrigger: () => firingDecision(),
    runRetroTrigger: async () => {
      // FALSIFIER: pre-fix, nothing ran again to sweep until this (unbounded)
      // call finally returned — stays "in flight" here until the ticker has
      // ticked a few times, proving it runs CONCURRENTLY, not only before/after.
      await retroGate;
    },
    sweepLight: async () => {
      lightSweeps++;
    },
    sleep,
  });
  assert.equal(summary.stopReason, "stopped");
  assert.ok(lightSweeps >= 3, `the light-sweep ticker ran while the retro was in flight (saw ${lightSweeps} tick(s))`);
});

test("W1-T276: the ticker stops on every retro exit path — including a THROWING runRetroTrigger — and never outlives it", async () => {
  const plan = fixturePlan();
  let lightSweeps = 0;
  let fired = false;
  let releaseRetro: (() => void) | undefined;
  const retroGate = new Promise<void>((resolve) => {
    releaseRetro = resolve;
  });
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let stopChecks = 0;
  const summary = await runDaemon(plan, {
    // everything already merged -> once the (one-shot) retro is done, the
    // loop only ever sees "nothing runnable" — an idle tick, never a dispatch.
    refreshMerged: () => () => true,
    runOne: async (id): Promise<RunResult> => {
      throw new Error(`runOne must never be called in this fixture (task ${id})`);
    },
    // Several idle ticks AFTER the retro settles — driven far enough past the
    // throw to give a leaked (not-actually-stopped) ticker room to keep
    // incrementing lightSweeps in the background if `sweepLightDuringRetro`
    // failed to await it to completion in its `finally`.
    checkStop: () => {
      stopChecks++;
      return stopChecks > 6 ? "test bound reached" : undefined;
    },
    // Fires exactly ONCE — a stale re-fire on every tick would make "idle
    // ticks after the retro" indistinguishable from "retro still running".
    checkRetroTrigger: () => {
      if (fired) return { fire: false as const, mergesSinceMarker: 0, daysSinceMarker: 0 };
      fired = true;
      return firingDecision();
    },
    runRetroTrigger: async () => {
      await retroGate;
      throw new Error("fixture: the automated retro run exploded");
    },
    // The release is tied to an OBSERVED sweep, not to a sleep counter shared
    // with the unrelated idle-poll sleeps that follow — so any lightSweeps
    // seen afterward can only come from the ticker itself still running.
    sweepLight: async () => {
      lightSweeps++;
      if (lightSweeps === 2) releaseRetro?.();
    },
    sleep: async () => {},
    log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
  });
  assert.equal(summary.stopReason, "stopped", "a throwing runRetroTrigger must never crash the daemon loop");
  const runFailed = lines.find((l) => l.step === "daemon.retro_trigger.run_failed");
  assert.ok(runFailed, "the retro's own throw is still ledgered as daemon.retro_trigger.run_failed");
  const idleTicks = lines.filter((l) => l.step === "daemon.idle").length;
  assert.ok(idleTicks >= 3, `several idle ticks ran after the one-shot retro settled (saw ${idleTicks})`);
  assert.ok(lightSweeps >= 2, "the ticker ran while the retro was in flight, up to the tick that released it");
  // Once the retro throws, `sweepLightDuringRetro`'s `finally` must clear
  // `tickerActive` AND await the ticker before returning control — so no
  // FURTHER sweepLight call can happen, no matter how many idle-poll sleeps
  // follow. At most ONE extra call is allowed past the release (the design's
  // documented "already in flight" tick), never one per subsequent idle tick.
  assert.ok(
    lightSweeps <= 3,
    `the ticker must have STOPPED once the retro threw, not kept ticking through the ${idleTicks} idle ticks that followed (saw ${lightSweeps} sweeps)`,
  );
});

test("W1-T276: the retro's light-sweep ticker never dispatches a task while the retro is running", async () => {
  const plan = fixturePlan();
  let runOneCalls = 0;
  let lightSweeps = 0;
  let sleeps = 0;
  let releaseRetro: (() => void) | undefined;
  const retroGate = new Promise<void>((resolve) => {
    releaseRetro = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    if (sleeps >= 4) releaseRetro?.();
  };
  let stopChecks = 0;
  const summary = await runDaemon(plan, {
    // Deliberately NOT already-merged: if the ticker (or anything else) drove
    // a real dispatch while the retro held the loop, `runOne` would fire on
    // task A and this fixture would catch it.
    refreshMerged: () => () => false,
    runOne: async (id): Promise<RunResult> => {
      runOneCalls++;
      throw new Error(`runOne must never be called while the retro is in flight (task ${id})`);
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 1 ? "test bound reached" : undefined;
    },
    checkRetroTrigger: () => firingDecision(),
    runRetroTrigger: async () => {
      await retroGate;
    },
    sweepLight: async () => {
      lightSweeps++;
    },
    sleep,
  });
  assert.equal(summary.stopReason, "stopped");
  assert.ok(lightSweeps >= 4, `the ticker ran multiple times during the retro (saw ${lightSweeps})`);
  assert.equal(runOneCalls, 0, "the light-sweep ticker restricted to sweepLight must never dispatch a task");
});

// ── W1-T463 — THE DIAGNOSIS: "a restricted light sweep ticks every 60s ... yet a PR sat
// 21-green and unreviewed for ~15 minutes". `startInFlightTicker` (src/lib/daemon.ts, the SAME
// ticker function this file's other tests exercise via the retro wiring) only schedules its
// NEXT `pollIntervalMs` sleep AFTER the CURRENT `sweepLight()` call resolves — it never runs on
// a fixed wall-clock schedule independent of that call's own duration. That is correct and
// deliberate on its own (no overlapping `sweepLight()` calls, so no second concurrent
// dedup-reader is ever introduced — design (iv)) — but it means "ticks every ~60s" only bounds
// when a NEW pass STARTS, never how long that pass takes to finish. `buildSweepLightHook`'s
// `postReview` effect (run-task.ts) runs the REAL `reviewCommand` — a worktree materialize plus
// every whitelisted proof for that PR — never a cheap status flip, and `runSweep`'s own
// per-PR loop is sequential, so a single `sweepLight()` call's wall time scales with however
// many PRs are due for post-review AND how long each one's proofs take. A PR ordered behind a
// slow sibling in that pass's `openPrs` snapshot silently misses the "checked every ~60s"
// expectation by however long the PRs ahead of it take — the observed ~15-minute shape.
// (`runSweepLightPass`, src/lib/sweep.ts, is W1-T463's fix for the OTHER half of this: it runs
// every open PR's own `runSweep` call CONCURRENTLY rather than the whole snapshot sequentially,
// so PRs no longer queue behind each other WITHIN one pass. This test pins the ticker-level
// mechanism that made a slow pass matter in the first place — it is deliberately NOT about
// sweepLight's internals, which this file's other tests treat as an opaque injected function.)
test("W1-T463: the ticker's next tick does not begin until the CURRENT sweepLight() call resolves — 'ticks every ~60s' bounds when a pass starts, never how long it runs", async () => {
  const plan = fixturePlan();
  let sweepLightCalls = 0;
  let releaseSlowPass: (() => void) | undefined;
  const slowPass = new Promise<void>((resolve) => {
    releaseSlowPass = resolve;
  });
  // W1-T1065: bound on TICKS ACTUALLY TAKEN, not on `checkStop` calls. The daemon now reads
  // checkStop twice per tick — top-of-tick and again immediately before admission — so a
  // call-counting bound stopped this run inside tick 1, before anything was ever dispatched and
  // before the in-flight ticker this test exists to exercise had started.
  let iterations = 0;
  const pending = runDaemon(plan, {
    refreshMerged: () => () => false, // stay OPEN — this fixture drives a real in-flight runOne
    runOne: async (): Promise<RunResult> => {
      // The dispatch this ticker exists to route around — it only settles once the test
      // releases it below, so the ticker stays "in flight" for the whole real-time window.
      await slowPass;
      return { taskId: "A", runId: "A-run", merged: true, costUsd: 0, verdict: "merged" };
    },
    log: (step) => {
      if (step === "daemon.iteration") iterations++;
    },
    checkStop: () => (iterations >= 1 ? "test bound reached" : undefined),
    sweepLight: async () => {
      sweepLightCalls++;
      if (sweepLightCalls === 1) {
        // Simulates a real pass that outran pollIntervalMs (e.g. a post-review action's
        // worktree-materialize-plus-proofs, or several such PRs queued in the same
        // snapshot): it holds here across the real-time window below, and the ticker must
        // not start a second sweepLight() call while this one is in flight — see
        // startInFlightTicker's own doc for why overlap is refused, not merely absent by luck.
        await slowPass;
      }
    },
    sleep: async () => {}, // the injected mock clock — instantaneous, never itself gates real time
  });
  // Let REAL wall-clock time pass while the first sweepLight() call is still gated. If the
  // ticker ran sweepLight() on a schedule independent of that call's own duration (the
  // property this test would catch a regression of), several more calls would already have
  // fired by now; instead it is coupled to the in-flight call's own completion.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sweepLightCalls, 1, "a slow sweepLight() call is never overlapped by a second one — the tick cadence is gated on ITS completion, not a fixed wall clock");
  releaseSlowPass?.();
  const summary = await pending;
  assert.equal(summary.stopReason, "stopped");
});

test("W1-T276: no sweepLight wired -> a fired retro behaves exactly as before this ticker existed", async () => {
  const plan = fixturePlan();
  let runCalls = 0;
  let stopChecks = 0;
  const summary = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id): Promise<RunResult> => {
      throw new Error(`runOne must never be called in this fixture (task ${id})`);
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 1 ? "test bound reached" : undefined;
    },
    checkRetroTrigger: () => firingDecision(),
    runRetroTrigger: async () => {
      runCalls++;
    },
    sleep: async () => {},
  });
  assert.equal(summary.stopReason, "stopped");
  assert.equal(runCalls, 1, "the retro still runs exactly once with no sweepLight wired");
});

// -- W1-T463: THE CI WAIT MUST NOT BLOCK THE DAEMON'S EVENT LOOP -----------------------------
//
// THE SIBLING DEFECT TO W1-T276 ABOVE, AND THE ONE THAT SURVIVED IT. W1-T276 closed a gap in
// ticker COVERAGE: a rung the ticker did not wrap. This is the opposite shape -- the ticker DID
// wrap the dispatch, and the sweep still went silent for 16m55s, because `waitForCiGreen` and
// `pollToGate` (src/run-task.ts) were declared `async` and contained ZERO `await`. Their GitHub
// read was `execFileSync` and their inter-poll delay was `execFileSync("sleep", ...)` -- a blocking
// child process, not a timer -- so the single JS thread never yielded and EVERY timer in the
// process was frozen, `startInFlightTicker`'s included.
//
// THE FALSIFIER THIS FILE MUST CARRY, and the reason a return-value test is worthless here: the
// function RETURNED CORRECTLY BEFORE. The only assertion that discriminates is that a timer
// scheduled BEFORE the wait FIRES DURING IT. The pair below drives the SAME real function twice --
// once with the shipped yielding sleep and once with a sleep that blocks the thread the way
// `execFileSync` did -- and the timer fires in exactly one of them.

/** A sleep that HOLDS the thread, exactly as `execFileSync("sleep", ...)` did. */
function blockingSleep(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin -- the event loop cannot turn, which is the whole point */
  }
  return Promise.resolve();
}

/**
 * W1-T2268: `pollToGate`/`waitForCiGreen` now read REST across THREE calls per iteration — the
 * PR row, then the composed rollup's own check-runs + combined-status — never one combined
 * `gh pr view --json statusCheckRollup`. `n` pending iterations, then `final`; `calls()` still
 * counts ITERATIONS (the PR-row read), exactly as it counted single combined reads before.
 */
function rollupReads(n: number, final: Array<Record<string, unknown>>): {
  read: (args: string[]) => Promise<unknown>;
  calls: () => number;
} {
  let i = 0;
  let step = 0;
  let current: Array<Record<string, unknown>> = [];
  return {
    read: async () => {
      const which = step % 3;
      step++;
      if (which === 0) {
        const pending = [{ name: "ci", status: "IN_PROGRESS" }];
        current = i < n ? pending : final;
        i++;
        return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } };
      }
      if (which === 1) {
        return { check_runs: current.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })) };
      }
      return { statuses: [] };
    },
    calls: () => i,
  };
}

const GREEN = [{ name: "ci", conclusion: "SUCCESS" }];

test("W1-T463 FALSIFIER: a timer scheduled BEFORE the CI wait FIRES DURING it", async () => {
  const { read } = rollupReads(3, GREEN);
  let firedAt: number | undefined;
  const started = Date.now();
  // Scheduled BEFORE the wait, due while the wait is still polling. Under the shipped
  // (yielding) sleep this MUST run; under the old blocking one it could not.
  const timer = setTimeout(() => {
    firedAt = Date.now();
  }, 30);
  const outcome = await waitForCiGreen("https://github.com/acme/remudero/pull/1", () => {}, 0.02, { readJson: read });
  clearTimeout(timer);
  assert.equal(outcome, "green");
  assert.notEqual(firedAt, undefined, "the timer never fired -- the event loop did not turn during the wait");
  assert.ok(
    (firedAt ?? Infinity) < Date.now(),
    "the timer must fire DURING the wait, not after it -- otherwise this proves only that the wait ended",
  );
  assert.ok(Date.now() - started >= 30, "sanity: the wait really did outlast the timer's due time");
});

test("W1-T463 MUTANT: a BLOCKING sleep starves that same timer -- the falsifier discriminates", async () => {
  const { read } = rollupReads(3, GREEN);
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
  }, 30);
  // Same function, same reads, same cadence -- only the sleep is the pre-W1-T463 shape.
  const outcome = await waitForCiGreen("https://github.com/acme/remudero/pull/1", () => {}, 0.05, { readJson: read, sleep: blockingSleep });
  clearTimeout(timer);
  assert.equal(outcome, "green", "the mutant still RETURNS correctly, which is exactly why a return-value test proves nothing");
  assert.equal(fired, false, "a blocking sleep must starve the timer -- if this fires, the falsifier above is vacuous");
});

test("W1-T463: the poll CADENCE is unchanged -- one sleep per poll, at everySec * 1000 ms", async () => {
  const { read, calls } = rollupReads(4, GREEN);
  const slept: number[] = [];
  const outcome = await waitForCiGreen("https://github.com/acme/remudero/pull/1", () => {}, 6, {
    readJson: read,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.equal(outcome, "green");
  assert.equal(calls(), 5, "four pending reads then the green one");
  assert.deepEqual(slept, [6000, 6000, 6000, 6000], "six seconds between polls, unchanged -- a faster poll burns the secondary rate limit");
});

test("W1-T463: the ci.polling LOG cadence is unchanged -- i === 0 || i % 5 === 0", async () => {
  const { read } = rollupReads(12, GREEN);
  const steps: string[] = [];
  await waitForCiGreen("https://github.com/acme/remudero/pull/1", (s) => steps.push(s), 6, { readJson: read, sleep: async () => {} });
  // 13 polls (0..12): logged at i = 0, 5, 10 -- three rows, exactly as before. 467 recorded rows
  // imply ~2,335 real polls precisely because of this 1-in-5 sampling.
  assert.equal(steps.filter((s) => s === "ci.polling").length, 3);
});

test("W1-T463: the RED direction still returns red, and stops polling immediately", async () => {
  const { read, calls } = rollupReads(1, [{ name: "ci", conclusion: "FAILURE" }]);
  const outcome = await waitForCiGreen("https://github.com/acme/remudero/pull/1", () => {}, 6, { readJson: read, sleep: async () => {} });
  assert.equal(outcome, "red", "blocked_ci handling depends on this exact value");
  assert.equal(calls(), 2, "one pending read then the red one -- it must not keep polling past a red");
});

test("W1-T463: the TIMEOUT direction still returns timeout on a stalled rollup", async () => {
  // Every read identical AND NOT RUNNING: `checkWaitStalled` refuses to call a still-moving check
  // stalled (`rollupHasRunningCheck`, the W1-T382 correction), so `IN_PROGRESS` here would poll
  // forever -- correctly. QUEUED is pending-but-not-moving, which is the real stall shape.
  let step = 0;
  const read = async () => {
    const which = step % 3;
    step++;
    if (which === 0) return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } };
    if (which === 1) return { check_runs: [{ name: "ci", status: "queued" }] };
    return { statuses: [] };
  };
  const steps: string[] = [];
  const outcome = await waitForCiGreen("https://github.com/acme/remudero/pull/1", (s) => steps.push(s), 6, { readJson: read, sleep: async () => {} });
  assert.equal(outcome, "timeout");
  assert.ok(steps.includes("ci.stalled"), "and it must say which checks were still pending when it gave up");
});

test("W1-T463: pollToGate yields too -- fixing ONE of the two daemon sites would leave the symptom alive", async () => {
  let prReads = 0;
  let step = 0;
  const read = async () => {
    const which = step % 3;
    step++;
    if (which === 0) {
      prReads++;
      return prReads < 3
        ? { number: 1, state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } }
        : { number: 1, state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z", head: { sha: "deadbeef" } };
    }
    if (which === 1) return { check_runs: [{ name: "ci", status: "in_progress" }] };
    return { statuses: [] };
  };
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
  }, 30);
  const outcome = await pollToGate("https://github.com/acme/remudero/pull/1", () => {}, 0.02, { readJson: read });
  clearTimeout(timer);
  assert.equal(outcome.merged, true, "a MERGED pr still resolves merged");
  assert.equal(fired, true, "pollToGate must release the loop as well -- it is the same shape and the same freeze");
});

test("W1-T463: pollToGate's red and closed directions are unchanged", async () => {
  let redStep = 0;
  const red = await pollToGate("https://github.com/acme/remudero/pull/1", () => {}, 6, {
    readJson: async () => {
      const which = redStep % 3;
      redStep++;
      if (which === 0) return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } };
      if (which === 1) return { check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] };
      return { statuses: [] };
    },
    sleep: async () => {},
  });
  assert.equal(red.merged, false);
  assert.match(red.reason, /required check red/);

  const closed = await pollToGate("https://github.com/acme/remudero/pull/1", () => {}, 6, {
    readJson: async () => ({ number: 1, state: "closed", merged: false, merged_at: null }),
    sleep: async () => {},
  });
  assert.equal(closed.merged, false);
  assert.match(closed.reason, /pr closed/);
});

test("W1-T463: NO BLOCKING SLEEP SURVIVES in src/run-task.ts -- the regression this file exists to pin", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "run-task.ts"), "utf8");
  // Comments naming the old call are fine and wanted; a real CALL is not. Anchored on the
  // statement form so the explanatory prose above the two loops cannot satisfy it.
  const realCalls = src.split("\n").filter((l) => /^\s*execFileSync\("sleep"/.test(l));
  assert.deepEqual(realCalls, [], `a blocking sleep came back to the daemon's own file: ${realCalls.join(" | ")}`);
  // POSITIVE CONTROL on that zero: the same predicate DOES find the two deferred, non-daemon sites.
  const deferred = ["src/lib/inbox.ts", "src/spike.ts"].filter((p) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", p), "utf8")
      .split("\n")
      .some((l) => /^\s*execFileSync\("sleep"/.test(l)),
  );
  assert.deepEqual(deferred, ["src/lib/inbox.ts", "src/spike.ts"], "the predicate must be able to find one at all");
});

test("W1-T463: the DEFAULT gh read is driven for real -- an async execFile, not the sync one it replaced", async () => {
  // THE DEFAULT SEAM, NOT A FAKE. Every test above injects `readJson`, which leaves `ghJsonAsync`'s
  // own body unreachable -- the #977/#978 shape ("when every test injects a fake, the seam's DEFAULT
  // implementation is unreachable"). This drives it by putting a stub `gh` FIRST on PATH, so the
  // real `execFileAsync("gh", ...)` runs, its stdout is really parsed, and the promise really
  // resolves.
  // IT DELIBERATELY ASSERTS NOTHING ABOUT THE LOOP TURNING. A first draft also checked that a 5ms
  // timer fired during the call, and that assertion RACED: the stub answers green on the FIRST read,
  // so the function returns before any sleep and the timer's due time is a coin flip against the
  // spawn. It failed once and passed once on identical code, which is a flake, not evidence. The
  // loop-turns claim is carried by the FALSIFIER above and its discriminating mutant, where it is
  // deterministic; adding a racy second copy of it here would only make the suite lie sometimes.
  const dir = mkdtempSync(join(tmpdir(), "rmd-gh-stub-"));
  const stub = join(dir, "gh");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      // W1-T2268: `waitForCiGreen`'s default reader now shells `gh api …` (REST), never `gh pr
      // view --json statusCheckRollup` — three distinct endpoints, matched on argv[2] (`$2`).
      'case "$2" in',
      '  */check-runs*) printf %s \'{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}\' ;;',
      '  */status) printf %s \'{"statuses":[]}\' ;;',
      '  *) printf %s \'{"number":1,"state":"open","merged":false,"merged_at":null,"head":{"sha":"deadbeef"}}\' ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath ?? ""}`;
  try {
    const outcome = await waitForCiGreen("https://github.com/acme/remudero/pull/1", () => {}, 0.02);
    assert.equal(outcome, "green", "the default reader must really parse the child's stdout");
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
