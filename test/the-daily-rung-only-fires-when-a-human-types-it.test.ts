// test/the-daily-rung-only-fires-when-a-human-types-it.test.ts — W1-T2971.
//
// THE DEFECT, MEASURED AT d4004806 (the merge of W1-T2959). `git grep -c ciLearning --
// src/lib/daemon.ts` returns 0, and `ciLearningCadenceCheck` has exactly ONE caller in the tree:
// `ciLearningCommand`, the CLI verb a person types. Every sibling cadence has two — the verb and
// the daemon. So the loop the operator asked to run DAILY runs only by hand.
//
// THIS REPO HAS SHIPPED THIS SHAPE TWICE AND RECORDED BOTH IN THE CODE THAT FIXES IT.
// `checkBoardReview`'s doc in daemon.ts: "#2952 merged 385 tested lines and the rung never fired
// once, because nothing called it." The wiring line's own comment in run-task.ts: "exactly how
// #1066 merged auto-triage's consumer with no producer." W1-T2959 merged 747 green lines and made
// it three.
//
// SO THESE TESTS DRIVE THE REAL `daemonCommand` AND ASSERT ON THE DaemonDeps IT ACTUALLY HANDS TO
// runDaemon — the seam test/auto-triage-wiring.test.ts pins for that rung, for the same reason
// stated there: "A test that called buildCiLearningDaemonHooks() directly would pass just as
// happily on the unwired code." Deleting the producer line reddens the first test below.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonCommand } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";

function fixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-ci-learning-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, root, planPath };
}

async function captureDeps(planPath: string): Promise<DaemonDeps> {
  let captured: DaemonDeps | undefined;
  const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
    runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  });
  assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
  assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
  return captured;
}

test("W1-T2971 REACHABILITY: daemonCommand WIRES the ci-learning rung into the deps it hands runDaemon", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const deps = await captureDeps(planPath);
    // THE ASSERTION W1-T2959 DID NOT HAVE. Without the producer line these are `undefined` and the
    // rung's whole branch is unreachable, however many unit tests the rung itself carries.
    assert.equal(typeof deps.checkCiLearningCadence, "function", "a self-target daemon must wire the decision hook");
    assert.equal(typeof deps.runCiLearningCadence, "function", "a self-target daemon must wire the runner");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T2971 a NON-SELF target does not wire the rung at all", async () => {
  // Same gate every sibling rung uses: the marker and the corpus join against THIS process's own
  // config.root, never a drained target's.
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    await daemonCommand(["--repo", "remudero-sandbox", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_p, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    if (captured) {
      assert.equal(captured.checkCiLearningCadence, undefined, "a drained target must not run this repo's rung");
      assert.equal(captured.runCiLearningCadence, undefined);
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── THE HOOK BODY, CALLED FOR REAL — not just its type ───────────────────────────────────────

import { buildCiLearningDaemonHooks } from "../src/run-task.js";
import { ciLearningCadenceMarkerPath, readMeasurementCadenceMarker } from "../src/lib/measurement-cadence.js";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import type { MergedSet } from "../src/lib/drain.js";
import type { Config } from "../src/lib/config.js";
import type { Policy } from "../src/lib/policy.js";

const NOW = new Date("2026-09-06T12:00:00Z");

/** The rung's own policy row at the values plan/policy.yaml commits — except `enabled`, which
 *  ships FALSE. A disabled row would never fire, so these tests supply an enabled one and the
 *  shipped default stays the operator's switch. */
const ON = { values: { ciLearningCadence: { enabled: true, minIntervalMinutes: 1440, maxPerDay: 1 } } } as unknown as Policy;

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "rmd-ci-learning-hook-"));
  mkdirSync(join(d, "state"), { recursive: true });
  return d;
}

/** A window shaped like `loadCiFailureWindow`'s output: one PR whose gate goes red then green. */
const repairedWindow = () => ({
  prs: [
    {
      number: 42,
      commits: [
        { sha: "redsha01", rollup: [{ name: "coverage-ratchet", conclusion: "FAILURE" as const }] },
        { sha: "greensha1", rollup: [{ name: "coverage-ratchet", conclusion: "SUCCESS" as const }], files: ["src/lib/x.ts"] },
      ],
    },
  ],
});

test("W1-T2971 THE WIRED HOOK, CALLED FOR REAL: check fires on a fresh root and run advances the marker", async () => {
  const root = tmpRoot();
  try {
    const hooks = buildCiLearningDaemonHooks({
      config: { root } as Config,
      policy: ON,
      now: () => NOW,
      loadWindow: () => repairedWindow() as never,
    });
    assert.equal(hooks.checkCiLearningCadence().fire, true, "no marker under this fresh root — must fire");

    const before = readMeasurementCadenceMarker(ciLearningCadenceMarkerPath(root));
    assert.equal(before.kind, "absent", "control: the marker really is absent before the run");

    const result = await hooks.runCiLearningCadence();
    assert.equal(result.status, "backlog", "the repaired pair is mintable, so the run has a backlog");
    assert.equal(result.draftCount, 1);

    const after = readMeasurementCadenceMarker(ciLearningCadenceMarkerPath(root));
    assert.equal(after.kind, "ok", "the fire is recorded on the rung's OWN marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2971 THE FIRE IS RECORDED BEFORE THE RUN BODY — a run that throws cannot re-fire next tick", async () => {
  // buildMeasurementCadenceDaemonHooks' stated crash-safety discipline. Without it a daemon that
  // crashes inside the rung re-fires it on every poll, forever.
  const root = tmpRoot();
  try {
    const hooks = buildCiLearningDaemonHooks({
      config: { root } as Config,
      policy: ON,
      now: () => NOW,
      loadWindow: () => {
        throw new Error("window unreadable mid-run");
      },
    });
    await assert.rejects(() => hooks.runCiLearningCadence(), /unreadable/);
    const after = readMeasurementCadenceMarker(ciLearningCadenceMarkerPath(root));
    assert.equal(after.kind, "ok", "the marker MUST have advanced before the body threw");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE POLL LOOP: consulted every tick, run only on a fire, best-effort throughout ──────────

/** `MergedSet` is a PREDICATE, not a collection — `refreshMerged` returns the function
 *  `isDispatchEligible` calls. A bare Set typechecks through the `as never` cast and then throws
 *  "isMerged is not a function" inside drain.ts. */
const NONE_MERGED: MergedSet = () => false;

/** ONE RUNNABLE TASK, deliberately. `opts.max` counts ATTEMPTED TASKS, not iterations, so an empty
 *  plan never reaches the cap and the loop idles forever — measured, by hanging this suite twice. */
function fixturePlan() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ci-learning-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    `
- id: W1-T2971FIX
  title: a runnable task
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`,
  );
  return loadPlan(f);
}

async function tickWith(extra: Partial<Parameters<typeof runDaemon>[1]>): Promise<void> {
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => NONE_MERGED,   // returns the predicate; it is not the predicate
      runOne: async (id: string) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
      sleep: async () => {},
      // EVERY seam this tick touches must be faked. A deps object supplying SOME fakes leaves the
      // rest on their REAL defaults — omitting `sweep` here ran the real one and hung the suite,
      // which is the exact trap CLAUDE.md's coverage section documents (#2237, #2248).
      sweep: async () => {},
      log: () => {},
      ...extra,
    } as never,
    // `max` bounds the ITERATIONS — the field a-bound-that-stops-waiting-does-not-stop-the-work
    // uses. `maxTasks` is not an option, so passing it leaves the loop unbounded.
    { max: 1, pollIntervalMs: 1 } as never,
  );
}

test("W1-T2971 the poll loop runs the rung ONLY on a tick that decided to fire", async () => {
  let ran = 0;
  await tickWith({
    checkCiLearningCadence: () => ({ fire: false, reason: "held by the interval bound" }),
    runCiLearningCadence: async () => {
      ran++;
      return { status: "clear", draftCount: 0, excludedCount: 0, unreadableCount: 0 };
    },
  } as never);
  assert.equal(ran, 0, "a tick that did not fire must not run the rung");

  let ranOnFire = 0;
  await tickWith({
    checkCiLearningCadence: () => ({ fire: true, reason: "interval elapsed" }),
    runCiLearningCadence: async () => {
      ranOnFire++;
      return { status: "clear", draftCount: 0, excludedCount: 0, unreadableCount: 0 };
    },
  } as never);
  assert.equal(ranOnFire, 1, "a tick that fired must run it exactly once");
});

test("W1-T2971 a run that THROWS is best-effort and never stops the tick that contains it", async () => {
  await tickWith({
    checkCiLearningCadence: () => ({ fire: true, reason: "interval elapsed" }),
    runCiLearningCadence: async () => {
      throw new Error("rung blew up");
    },
  } as never);
  // Reaching here at all is the assertion: runDaemon resolved rather than rejecting.
  assert.ok(true, "the tick completed despite the rung throwing");
});

test("W1-T2971 a daemon given NEITHER hook ticks exactly as it did before this change", async () => {
  // The optionality every sibling rung relies on: absent hooks mean the block is skipped, never
  // that the loop refuses to run.
  await tickWith({});
  assert.ok(true, "a daemon with no ci-learning hooks still completes its tick");
});
