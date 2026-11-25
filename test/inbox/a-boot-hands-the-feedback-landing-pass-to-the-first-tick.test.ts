import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { daemonBoot, DaemonDeps } from "#src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

// W1-T14787: the boot's feedback-landing pass was the per-poll pass, awaited after promotion. Measured 2026-11-25 at the
// 02:48Z hand-over: 34,610 ms of a 36,686 ms boot_sweeps phase, with no daemon dispatching. The first tick owes the
// per-poll pass to the due-rungs timer, so the boot passes none and the loop still sweeps the inbox.

type CommandDeps = NonNullable<Parameters<typeof daemonCommand>[1]>;
type BootArgs = Parameters<typeof daemonBoot>;
/** daemonBoot's positional params: sweepOrphanWorkers is 8, sweepFeedbackLanding is 10. */
const ORPHAN_SWEEP_ARG = 8;
const FEEDBACK_LANDING_ARG = 10;
const PLAN_YAML = "- id: PUB-A\n  title: public PUB-A\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n";

async function boot(): Promise<{ code: number; bootArgs: BootArgs | undefined; loopDeps: DaemonDeps | undefined }> {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}boot-feedback-landing-`));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, PLAN_YAML);
  const shim = ghShim([{ when: "", exit: 1, stderr: "fixture: GitHub is unavailable" }], { kind: "boot-feedback-landing-gh" });
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  let bootArgs: BootArgs | undefined;
  let loopDeps: DaemonDeps | undefined;
  const deps: CommandDeps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: REPO_ROOT,
    githubFactory: () => ({}) as never,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async (...args) => {
      bootArgs = args;
      return { env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version };
    },
    checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    runDaemon: async (_plan, wired) => {
      loopDeps = wired;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  };
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], deps);
    return { code, bootArgs, loopDeps };
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("W1-T14787 a self-target boot passes no feedback-landing sweep to daemonBoot", async () => {
  const run = await boot();
  assert.equal(run.code, 0);
  assert.ok(run.bootArgs, "positive control: the command reached daemonBoot");
  assert.equal(typeof run.bootArgs![ORPHAN_SWEEP_ARG], "function", "positive control: the boot's orphan sweep is still passed");
  assert.equal(run.bootArgs![FEEDBACK_LANDING_ARG], undefined, "the boot awaits no feedback-landing pass");
});

test("W1-T14787 the per-poll feedback-landing pass is still wired into the loop", async () => {
  const run = await boot();
  assert.equal(run.code, 0);
  assert.ok(run.loopDeps, "positive control: the command reached runDaemon");
  assert.equal(typeof run.loopDeps!.sweepFeedbackLanding, "function", "the loop's tick sweeps still land the inbox");
});
