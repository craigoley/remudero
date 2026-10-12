/**
 * W1-T5631 — A TEST PROCESS NEVER READS THE HOST'S SCRATCH SWITCH.
 *
 * deploy/scratch-mounts.sh `scratch_enabled` reads RMD_SCRATCH unset as "auto" and then tests
 * `${RMD_SCRATCH_SWITCH:-/etc/remudero/scratch-mounts.on}`. On the fleet host that file exists and
 * /mnt/scratch is mounted, so every recycle fixture that spreads process.env planned seven scratch
 * binds its stub `docker inspect` never reported (FAILED RUNTIME CONTRACT ... missing) and mkdir'd
 * fixture dirs into the REAL /mnt/scratch/rmd. test/setup/no-live-remote.ts now points the switch at a
 * dead path and drops RMD_SCRATCH, so auto mode reads "off" in every child. A suite that tests the
 * scratch path passes its own RMD_SCRATCH / RMD_SCRATCH_SWITCH and is unaffected.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A namespace import, not a named one: this file must LOAD on the base tree (where the new export
// does not exist) so its assertions, not a module-load error, are what fail there.
import * as noLiveRemote from "./setup/no-live-remote.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const LIB = join(REPO_ROOT, "deploy", "scratch-mounts.sh");
const { installNoLiveRemote } = noLiveRemote;
const deadSwitch = (noLiveRemote as unknown as { DEAD_SCRATCH_SWITCH?: string }).DEAD_SCRATCH_SWITCH;

/** Source the scratch lib under `env`, ask `scratch_enabled`, then `scratch_plan`, and report both. */
function probeScratch(env: NodeJS.ProcessEnv, state: string): { enabled: number; planned: number; args: string } {
  const script = [
    `. '${LIB}'`,
    "scratch_enabled; enabled=$?",
    `scratch_plan '${state}' rmd_w1_t5631_probe; planned=$?`,
    'printf "%s %s %s" "$enabled" "$planned" "${#SCRATCH_ARGS[@]}"',
  ].join("\n");
  const run = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const [enabled, planned, args] = run.stdout.trim().split(" ");
  return { enabled: Number(enabled), planned: Number(planned), args: args ?? "" };
}

/** A throwaway host whose scratch root the mounts table declares mounted and whose switch file EXISTS:
 *  the switch is then the only thing standing between a probe and a planned bind. */
function liveScratchHost(t: { after: (fn: () => void) => void }): { root: string; scratch: string; state: string; switchFile: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5631-host-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "mnt", "scratch");
  const state = join(root, "rmd-state2");
  const switchFile = join(root, "scratch-mounts.on");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(root, "mounts"), `/dev/nvme1n1 ${scratch} ext4 rw,noatime 0 0\n`);
  writeFileSync(switchFile, "");
  return { root, scratch, state, switchFile, env: { RMD_SCRATCH_ROOT: scratch, RMD_SCRATCH_MOUNTS_FILE: join(root, "mounts") } };
}

test("W1-T5631: the shared setup points RMD_SCRATCH_SWITCH at a dead path and leaves RMD_SCRATCH unset", () => {
  assert.equal(typeof deadSwitch, "string", "no-live-remote must export DEAD_SCRATCH_SWITCH");
  assert.match(deadSwitch!, /W1-T5631-scratch-switch-blocked-by-the-test-suite/, "the dead path's name must say why");
  assert.equal(existsSync(deadSwitch!), false, "the dead switch path must not exist");
  assert.equal(process.env.RMD_SCRATCH_SWITCH, deadSwitch, "the shared setup must install the dead switch");
  assert.equal(process.env.RMD_SCRATCH, undefined, "the shared setup must leave RMD_SCRATCH to auto");
});

test("W1-T5631: a child spreading process.env reads scratch_enabled as false and plans no bind", (t) => {
  const host = liveScratchHost(t);
  // Under the suite's own env the switch is the dead path, so even a mounted scratch root plans nothing.
  const probe = probeScratch({ ...process.env, ...host.env }, host.state);
  assert.deepEqual(probe, { enabled: 1, planned: 1, args: "0" });
  // Positive control: the same probe with the host's real switch file DOES plan the seven binds, so the
  // zero above is the switch's doing, not a probe that could never see a bind.
  const control = probeScratch({ ...process.env, ...host.env, RMD_SCRATCH_SWITCH: host.switchFile }, host.state);
  assert.equal(control.enabled, 0);
  assert.equal(control.planned, 0);
  assert.notEqual(control.args, "0");
});

test("W1-T5631: the setup overrides an inherited RMD_SCRATCH and a real switch file on any host", (t) => {
  const host = liveScratchHost(t);
  // A host with a REAL switch file and an operator shell exporting RMD_SCRATCH=on.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_TEST_CONTEXT: "child-v8",
    RMD_SCRATCH: "on",
    RMD_SCRATCH_SWITCH: host.switchFile,
    ...host.env,
  };
  assert.deepEqual(probeScratch(env, host.state).enabled, 0, "control: before the setup the host plans binds");
  const installed = installNoLiveRemote(env);
  t.after(() => {
    if (installed.ghConfigDir !== undefined) rmSync(installed.ghConfigDir, { recursive: true, force: true });
  });
  assert.equal(env.RMD_SCRATCH, undefined);
  assert.equal(env.RMD_SCRATCH_SWITCH, deadSwitch);
  assert.deepEqual(probeScratch(env, host.state), { enabled: 1, planned: 1, args: "0" });
  assert.deepEqual(readdirSync(host.scratch), [], "nothing is created under the scratch root");
});
