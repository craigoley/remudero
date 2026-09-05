import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonCommand } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";

// ── W1-T160: daemonCommand wires the retro cadence hooks into runDaemon (self-target) ──
//
// retroTriggerCheck (test/retro-trigger-check.test.ts) and the daemon LOOP's handling of
// a fired trigger (test/daemon-retro-trigger.test.ts) are covered independently. This
// file pins the SEAM between them: that `daemonCommand`, on a SELF-TARGET non-dry-run
// boot, actually builds and hands `checkRetroTrigger`/`runRetroTrigger` to `runDaemon`
// (and withholds them for a non-self target). It drives the REAL daemonCommand past its
// dry-run early return to the runDaemon call, injecting a stub `runDaemon` that captures
// the wired DaemonDeps and returns immediately — so the loop never actually spawns.

function fixtureHome(): { home: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-retro-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root }),
  );
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, planPath };
}

test("daemonCommand: a SELF-TARGET non-dry-run boot wires checkRetroTrigger + runRetroTrigger into runDaemon", async () => {
  const { home, planPath } = fixtureHome();
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
    assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }

  assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
  assert.equal(
    typeof captured.checkRetroTrigger,
    "function",
    "a self-target daemon wires the retro cadence check (retroTriggerCheck)",
  );
  assert.equal(
    typeof captured.runRetroTrigger,
    "function",
    "a self-target daemon wires the automated-retro runner",
  );
  const source = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  // `buildRetroDaemonHooks()` itself stays a bare, zero-arg construction call (byte-identical
  // to before W1-T2870) so test/owner-self-host-gating.test.ts's isSelf source-grep still
  // matches; the daemon's per-boot ledger sink is instead handed to `runRetroTrigger` at
  // INVOCATION time, in the wiring line below.
  assert.ok(
    /const retroHooks = target\.isSelf \? buildRetroDaemonHooks\(\) : undefined;/.test(source),
    "buildRetroDaemonHooks's construction call stays gated on target.isSelf and takes no deps",
  );
  assert.ok(
    /runRetroTrigger: retroHooks \? \(decision\) => retroHooks\.runRetroTrigger\(decision, log\) : undefined,/.test(
      source,
    ),
    "the production wiring hands its ledger sink to runRetroTrigger at call time",
  );
  assert.ok(
    /else\s+await\s+runAutomatedRetroSubprocess\(decision,\s*\{\s*log\s*\}\)/.test(source),
    "the default automated-retro hook reaches the subprocess adapter rather than retroCommand in the daemon pid",
  );
});
