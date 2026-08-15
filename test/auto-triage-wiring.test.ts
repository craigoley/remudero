import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonCommand, triageCommand } from "../src/run-task.js";
import { acquireDrainLock } from "../src/lib/drain-lock.js";
import { triageLockPath } from "../src/lib/auto-triage.js";
import { loadPolicy, policyPath } from "../src/lib/policy.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";

// ── impl-DM: the auto-triage rung's PRODUCER is wired into daemonCommand ──────────────────
//
// PR #1066 shipped this rung's CONSUMER — daemon.ts reads `deps.checkAutoTriage` in its idle
// branch — and never wired a producer. `deps.checkAutoTriage` was `undefined` on every production
// boot, the branch never ran, and `autoTriage.enabled: true` did nothing. Eighteen tests passed and
// the review went green, because every one of those tests called the rung's functions DIRECTLY.
//
// THAT IS THE MISTAKE THIS FILE EXISTS TO MAKE IMPOSSIBLE. These tests drive the REAL
// `daemonCommand` and assert on the DaemonDeps it actually hands to runDaemon — the same seam
// test/daemon-command-retro-wiring.test.ts pins for the retro. A test that called
// `buildAutoTriageDaemonHooks()` directly would pass just as happily on the unwired code.

function fixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-auto-triage-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root }),
  );
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

test("REACHABILITY: daemonCommand actually WIRES checkAutoTriage into the deps it hands runDaemon", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const deps = await captureDeps(planPath);

    // THE ASSERTION #1066 DID NOT HAVE. Without the producer this is `undefined` and the rung's
    // whole branch is unreachable, however many unit tests the rung itself carries.
    assert.equal(
      typeof deps.checkAutoTriage,
      "function",
      "a self-target daemon must wire the auto-triage decision hook",
    );
    assert.equal(
      typeof deps.runAutoTriage,
      "function",
      "a self-target daemon must wire the auto-triage runner",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("THE FLAG IS OBEYED THROUGH THE WIRING: the wired hook's decision tracks the checked-in policy", async () => {
  // The bound that matters most for spend: ~$2.00 a fire. Proven through the REAL wired hook.
  //
  // THIS TEST USED TO BE COUPLED TO THE SHIPPED VALUE. It was titled "with the policy flag ABSENT"
  // and asserted `fire === false`, but `fixtureHome` writes no policy.yaml at all — and
  // `autoTriageCheck` reads `policyPath(repoRoot)`, where `repoRoot` is resolved from the TEST
  // PROCESS's own cwd (run-task.ts). So it read the repo's CHECKED-IN plan/policy.yaml and was
  // really asserting "the shipped default is false". It passed by coincidence of that value, and
  // flipping the flag for real broke it — a test failing for the one reason it should not care
  // about. The absent-block default it CLAIMED to cover is asserted directly below, where that
  // semantics actually lives.
  //
  // What is invariant, and what this now pins: the wired hook DERIVES its answer from that policy
  // file. Asserted in both directions so it holds whichever way the flag is set.
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const deps = await captureDeps(planPath);
    const decision = deps.checkAutoTriage!({ deferralPending: true, dispatchCount: 1, laneBudget: 1 });
    const shipped = loadPolicy(policyPath(process.cwd())).values.autoTriage;

    if (!shipped.enabled) {
      assert.equal(decision.fire, false, "flag off in the checked-in policy ⇒ the wired rung must not fire");
      assert.match(
        (decision as { reason: string }).reason,
        /disabled/,
        "and it must say the FLAG is why, not some incidental refusal that would vanish if the flag flipped",
      );
    } else {
      // Flag on: the rung may still legitimately refuse (lock held, marker unreadable, no
      // candidates) — but it must never refuse for the DISABLED reason, which would mean the wiring
      // is not reading the flag it claims to read.
      assert.doesNotMatch(
        (decision as { reason?: string }).reason ?? "",
        /disabled/,
        "flag on in the checked-in policy ⇒ the wired rung must not claim it is disabled",
      );
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("DEFAULT OFF: a policy.yaml with no autoTriage block loads as disabled", () => {
  // The absent-block default, asserted where it actually lives (policy.ts's loader) rather than
  // through a daemon fixture that never had a policy.yaml to omit the block FROM. Absence must mean
  // OFF: a rung that spends unsupervised is opted into, never inherited by an older policy file.
  const dir = mkdtempSync(join(tmpdir(), "rmd-auto-triage-default-"));
  try {
    const shipped = readFileSync(policyPath(process.cwd()), "utf8");
    const withoutBlock = shipped.replace(/^autoTriage:\n(?:[ \t].*\n|\n)*/m, "");
    assert.ok(!/^autoTriage:/m.test(withoutBlock), "the fixture really has no autoTriage block");

    const file = join(dir, "policy.yaml");
    writeFileSync(file, withoutBlock);
    const values = loadPolicy(file).values.autoTriage;

    assert.equal(values.enabled, false, "absence means OFF");
    assert.equal(values.minIntervalMinutes, 60);
    assert.equal(values.maxPerDay, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE LOCK IS CONTENDED THROUGH THE WIRING: a held lock refuses the wired hook", async () => {
  // The daemon path can now genuinely contend for the lock, which it never could before. A lock
  // that was never contended is a lock that has never been tested in anger.
  const { home, root, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const held = acquireDrainLock(triageLockPath(root));
    try {
      const deps = await captureDeps(planPath);
      const decision = deps.checkAutoTriage!({ deferralPending: true, dispatchCount: 1, laneBudget: 1 });
      assert.equal(decision.fire, false, "a held lock must stop the wired rung");
    } finally {
      held.release();
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the CLI still REFUSES while the lock is held, and spawns nothing", async () => {
  // The other half of #1066 was live and must stay live — now that the daemon can take this lock,
  // the CLI's refusal is load-bearing rather than theoretical.
  const { home, root } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const errs: string[] = [];
  const origError = console.error;
  console.error = (m?: unknown) => void errs.push(String(m));
  let spawned = 0;
  let code: number;
  try {
    const held = acquireDrainLock(triageLockPath(root));
    try {
      code = await triageCommand(["fb-anything"], {
        config: { root } as never,
        spawn: (async () => {
          spawned++;
          throw new Error("a refused triage must never spawn a paid worker");
        }) as never,
      });
    } finally {
      held.release();
    }
  } finally {
    console.error = origError;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }

  assert.equal(code, 2, "the CLI must exit non-zero rather than race the daemon's rung");
  assert.equal(spawned, 0, "and must not spawn a paid worker");
  assert.match(errs.join("\n"), /REFUSED/);
});

test("a NON-SELF target does not wire the rung at all", async () => {
  // Same gate the retro uses: triage reads THIS repo's plan/feedback, never a drained target's.
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
      assert.equal(captured.checkAutoTriage, undefined, "a drained target must not auto-triage this repo");
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("BOUNDS SURVIVE THE WIRING: runAutoTriage records the fire BEFORE running triage", async () => {
  // The interval and daily cap are enforced by the PURE decideAutoTriage (18 tests, unchanged by
  // this PR) reading the marker. This pins the half the WIRING owns: the marker must advance before
  // the ~$2.00 run, so a triage that throws or a process that dies mid-run costs one skipped period
  // rather than authorising an immediate retry.
  const { buildAutoTriageDaemonHooks } = await import("../src/run-task.js");
  const { readAutoTriageMarker, autoTriageMarkerPath } = await import("../src/lib/auto-triage.js");
  const { home, root } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let markerAtRunTime: number | undefined;
    const hooks = buildAutoTriageDaemonHooks({
      config: { root } as never,
      runTriage: async () => {
        const m = readAutoTriageMarker(autoTriageMarkerPath(root));
        markerAtRunTime = m.kind === "ok" ? m.marker.fires.length : 0;
        throw new Error("simulated triage failure");
      },
    });

    await assert.rejects(() => hooks.runAutoTriage("fb-x"), /simulated triage failure/);

    assert.equal(markerAtRunTime, 1, "the marker must already carry this fire when triage starts");
    const after = readAutoTriageMarker(autoTriageMarkerPath(root));
    assert.equal(
      after.kind === "ok" ? after.marker.fires.length : 0,
      1,
      "and it must survive the failure, so the interval bound still holds on the next poll",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
