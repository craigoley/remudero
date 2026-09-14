import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepHook, buildSweepLightHook, daemonCommand, reviewerCodeRecoveryFromLoadedModule } from "../src/run-task.js";
import type { DaemonSummary } from "../src/lib/daemon.js";
import type { SweepDeps } from "../src/lib/sweep.js";

type Recovery = NonNullable<SweepDeps["reviewerCodeRecovery"]>;

function fixtureHome(): { home: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-reviewer-code-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { home, planPath };
}

test("W1-T3581 daemon wires loaded reviewer provenance into both sweep paths", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  let fullRecovery: Recovery | undefined;
  let lightRecovery: Recovery | undefined;
  const captureFullHook = (...args: Parameters<typeof buildSweepHook>): ReturnType<typeof buildSweepHook> => {
    fullRecovery = args[13] as Recovery | undefined;
    return async () => {};
  };
  const captureLightHook = (...args: Parameters<typeof buildSweepLightHook>): ReturnType<typeof buildSweepLightHook> => {
    lightRecovery = args[7] as Recovery | undefined;
    return async () => {};
  };

  process.env.HOME = home;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      buildSweepHook: captureFullHook,
      buildSweepLightHook: captureLightHook,
      wireSweepWake: () => ({ sleep: async () => "timeout" as const, acknowledge: () => {}, close: () => {} }),
      runDaemon: async (): Promise<DaemonSummary> => ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 }),
    });
    assert.equal(code, 0);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }

  assert.ok(fullRecovery, "the production daemon supplies recovery provenance to the full sweep");
  assert.strictEqual(lightRecovery, fullRecovery, "full and light sweeps share the same boot-loaded provenance");
  assert.equal(fullRecovery.isLoadedCodeAtOrAfter(fullRecovery.loadedCodeSha ?? ""), true, "the captured module SHA proves itself through the fail-closed ancestry check");
  assert.equal(fullRecovery.isLoadedCodeAtOrAfter("definitely-not-a-commit"), false, "unreadable ancestry stays fail-closed");
});

test("W1-T3581 loaded reviewer provenance invokes git ancestry from the module tree", () => {
  const ancestryCalls: string[][] = [];
  const recovery = reviewerCodeRecoveryFromLoadedModule(
    "/module-root",
    "loaded-sha",
    ((_command: string, args: string[]) => {
      ancestryCalls.push(args);
      return { status: 0 };
    }) as never,
  );
  assert.equal(recovery.isLoadedCodeAtOrAfter("required-sha"), true);
  assert.deepEqual(ancestryCalls, [["-C", "/module-root", "merge-base", "--is-ancestor", "required-sha", "loaded-sha"]]);
  assert.equal(reviewerCodeRecoveryFromLoadedModule("/module-root", undefined).isLoadedCodeAtOrAfter("required"), false);

  const unreadable = reviewerCodeRecoveryFromLoadedModule(
    "/module-root",
    "loaded-sha",
    (() => { throw new Error("git unreadable"); }) as never,
  );
  assert.equal(unreadable.isLoadedCodeAtOrAfter("required-sha"), false, "an ancestry execution error fails closed");
  assert.equal(unreadable.takeAncestryFailure?.(), "Error", "the bounded stand-down reason can name the failed ancestry evidence");
  assert.equal(unreadable.takeAncestryFailure?.(), undefined, "a reported failure is consumed before the next ancestry check");
});
