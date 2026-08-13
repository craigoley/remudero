import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonCommand } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";

// ── W1-T126's MISSING PRODUCER: THE REACHABILITY SEAM ─────────────────────────────────────────
//
// The one assertion that could have caught W1-T126 shipping consumer-without-producer, and the
// same seam test/auto-triage-wiring.test.ts pins for the auto-triage rung after #1066 made the
// identical mistake. Every test in test/daemon-freshness.test.ts injects its own `checkFreshness`
// fake, so all eight passed for months against a production path that supplied none.
//
// IT LIVES IN ITS OWN FILE FOR ONE MEASURED REASON: driving the REAL `daemonCommand` costs ~42s
// on an idle host (a 26.7MB `board_gateway` fetch dominates it — the same cost its auto-triage
// sibling pays), against `plan/policy.yaml`'s `proofTimeoutMs` of 60000. review.ts's own
// `resolveNameFilteredCandidates` doc names that failure exactly: "the same unchanged proof coins
// `executed_pass` on an idle host and `exec_error` on a loaded one". MEASURED HERE: with the file
// still joined to the fast behavioural tests, `rmd check-proof` on it was KILLED mid-run with no
// `# tests` summary at all. Split, the behavioural file is sub-second and safe to cite as a proof;
// this file is exercised by CI's full suite, where its slow sibling already lives.
// ── THE SEAM #1066 DID NOT HAVE: the REAL daemonCommand's DaemonDeps ─────────────────────────

function fixtureHome(): { home: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-freshness-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, planPath };
}

test("REACHABILITY: daemonCommand WIRES checkFreshness into the deps it hands runDaemon", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  const oldCi = process.env.CI;
  process.env.HOME = home;
  process.env.CI = "1"; // makes the wired call deterministic: `guarded`, so it shells out to nothing
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");

    // THE ASSERTION THAT WAS MISSING FOR THE WHOLE LIFE OF W1-T126. Without the producer this is
    // `undefined`, the loop's whole branch is unreachable, and every test in
    // test/daemon-freshness.test.ts still passes because each supplies its own fake.
    assert.equal(typeof captured.checkFreshness, "function", "the daemon must wire a code-freshness check");

    // And it is CALLABLE and returns the loop's own contract — not merely present.
    const verdict = captured.checkFreshness!();
    assert.equal(verdict.stale, false, "under the CI guard it fails safe rather than bouncing the daemon");

    // runInstall stays deliberately unwired — serviceFreshnessGate already runs ensureInstallFresh
    // on every boot, which is the path a restart is guaranteed to take.
    assert.equal(captured.runInstall, undefined, "runInstall is intentionally NOT wired");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCi === undefined) delete process.env.CI;
    else process.env.CI = oldCi;
    rmSync(home, { recursive: true, force: true });
  }
});
