// W1-T14757: a boot writes how long each boot sweep took before its first tick, so a slow boot names the sweep that
// held it (the 11-24 22:12Z hand-over spent 414 s in boot_sweeps and no row said where).
import assert from "node:assert/strict";
import test from "node:test";
import { daemonBoot, SPAWN_HELPER_SWITCH } from "#src/lib/daemon.js";

type Row = { step: string } & Record<string, unknown>;

/** A boot whose every sweep advances a fake clock by its own amount and records that it ran. */
async function timedBoot(): Promise<{ rows: Row[]; ran: string[] }> {
  const rows: Row[] = [];
  const ran: string[] = [];
  let nowMs = 1_000;
  const takes = (name: string, ms: number): void => { ran.push(name); nowMs += ms; };
  await daemonBoot(
    (step, extra = {}) => { rows.push({ step, ...extra }); },
    { PATH: process.env.PATH, [SPAWN_HELPER_SWITCH]: "off" },
    () => { takes("tmp_sweep", 3); return { removed: [], kept: [] }; },
    () => { takes("lock_sweep", 5); return { reaped: [], kept: [], live: [], unverifiableForeignHost: [] }; },
    () => { takes("worker_keychain", 2); return { keychainPath: "/k", provisioned: false, unlocked: true }; },
    { priorBoots: () => { takes("crashloop_check", 7); return []; }, now: () => new Date(nowMs).toISOString(), onBreach: () => {} },
    () => { takes("claude_bin", 11); return "/bin/claude"; },
    false,
    () => { takes("orphan_sweep", 13); return { killed: [], leftAlone: [] }; },
    undefined,
    async () => { takes("feedback_landing_sweep", 17); return { landed: false, files: [] } as never; },
    undefined,
    undefined,
    undefined,
    { now: () => nowMs },
  );
  return { rows, ran };
}

test("W1-T14757 a boot writes each boot sweep's duration before its first tick", async () => {
  const { rows } = await timedBoot();
  const timed = rows.filter((row) => row.step === "daemon.boot_sweeps");
  assert.equal(timed.length, 1, "one timing row per boot");
  assert.equal(rows.at(-1)?.step, "daemon.boot_sweeps", "written as the boot's last row, before the loop's first tick");
  const { step: _step, ...phases } = timed[0]!;
  assert.deepEqual(phases, {
    spawn_helper_ms: 0, crashloop_check_ms: 7, worker_keychain_ms: 2, tmp_sweep_ms: 3, lock_sweep_ms: 5,
    claude_bin_ms: 11, orphan_sweep_ms: 13, feedback_landing_sweep_ms: 17, total_ms: 58,
  });
});

test("W1-T14757 a timed boot runs its boot sweeps in the same order", async () => {
  const { rows, ran } = await timedBoot();
  assert.deepEqual(ran, ["crashloop_check", "worker_keychain", "tmp_sweep", "lock_sweep", "claude_bin", "orphan_sweep",
    "feedback_landing_sweep"]);
  const timed = rows.find((row) => row.step === "daemon.boot_sweeps");
  assert.ok(timed, "the timing row is written");
  assert.deepEqual(Object.keys(timed).filter((key) => key !== "step" && key !== "total_ms" && key !== "spawn_helper_ms"),
    ran.map((name) => `${name}_ms`), "the row names the sweeps in the order they ran");
});

test("W1-T14757 a boot handed no sweep writes no timing row", async () => {
  const rows: Row[] = [];
  await daemonBoot((step, extra = {}) => { rows.push({ step, ...extra }); }, { PATH: process.env.PATH, [SPAWN_HELPER_SWITCH]: "off" });
  assert.deepEqual(rows.map((row) => row.step), ["daemon.boot", "daemon.spawn_helper"]);
});
