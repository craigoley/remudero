import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { daemonBoot, SPAWN_HELPER_SWITCH } from "#src/lib/daemon.js";
import { execFileLoopBounded } from "#src/lib/loop-bounded-child.js";
import { defaultMergeProbeGit } from "#src/lib/merge-probe.js";
import { installedSpawnHelper, installSpawnHelper, runDirect, runRouted, startSpawnHelper,
  type SpawnResult } from "#src/lib/spawn-helper.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T13437: the operator's ruling of 2026-11-17 turns the spawn helper on by default; RMD_SPAWN_HELPER=off turns it off.

type Row = { step: string } & Record<string, unknown>;
const capture = (): { rows: Row[]; log: (step: string, extra?: Record<string, unknown>) => void } => {
  const rows: Row[] = [];
  return { rows, log: (step, extra = {}) => { rows.push({ step, ...extra }); } };
};
const helperRows = (rows: Row[]): Row[] => rows.filter((row) => row.step === "daemon.spawn_helper");
const routedRows = (rows: Row[]): Row[] => rows.filter((row) => row.step === "spawn.routed");
const comparable = (result: SpawnResult): unknown =>
  [result.exitCode, result.signal, result.stdout, result.stderr, result.error ?? null];

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "condition never held");
}

/** Every test that boots stops what it started, so no helper process outlives it. */
function stopInstalled(): void {
  installedSpawnHelper()?.stop();
  installSpawnHelper(undefined);
}

test("W1-T13437 criterion 1: a boot with the switch unset, or set to anything but off, starts the helper", async () => {
  try {
    installSpawnHelper(undefined);
    const unset = capture();
    await daemonBoot(unset.log, { PATH: process.env.PATH });
    const helper = installedSpawnHelper();
    assert.ok(helper, "the switch unset: the boot installs a helper");
    assert.equal(helper.unhealthy(), undefined);
    assert.deepEqual(helperRows(unset.rows), [{ step: "daemon.spawn_helper", started: true, pid: helper.pid,
      switch: "RMD_SPAWN_HELPER", value: "unset" }], "one row, the switch and its value on it");
    const routed = await runRouted({ file: "git", args: ["--version"] });
    assert.equal(routed.via, "helper");
    assert.match(routed.stdout, /^git version /);
    for (const value of ["on", "1", ""]) {
      const booted = capture();
      await daemonBoot(booted.log, { PATH: process.env.PATH, [SPAWN_HELPER_SWITCH]: value });
      const next = installedSpawnHelper();
      assert.deepEqual(helperRows(booted.rows).map((row) => [row.started, row.pid, row.value]),
        [[true, next?.pid, value]], `the value ${JSON.stringify(value)} means on`);
    }
    assert.match(String(helper.unhealthy()), /^helper_stopped$/, "a second boot in one process stops the first helper");
  } finally {
    stopInstalled();
  }
});

test("W1-T13437 criterion 2: RMD_SPAWN_HELPER=off starts no helper and says so on the boot row", async () => {
  try {
    installSpawnHelper(undefined);
    const off = capture();
    await daemonBoot(off.log, { PATH: process.env.PATH, [SPAWN_HELPER_SWITCH]: "off" });
    assert.equal(installedSpawnHelper(), undefined, "the switch off: no helper");
    assert.deepEqual(helperRows(off.rows), [{ step: "daemon.spawn_helper", started: false, reason: "switch_off",
      switch: "RMD_SPAWN_HELPER", value: "off" }]);
    const direct = await runRouted({ file: "true" });
    assert.deepEqual([direct.via, direct.reason, direct.exitCode], ["direct", "helper_not_installed", 0]);
  } finally {
    stopInstalled();
  }
});

test("W1-T13437 criterion 3: a helper that cannot start, or dies, costs no spawn, and an in-flight request is never re-run", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}spawn-helper-default-`));
  const execPath = process.execPath;
  try {
    installSpawnHelper(undefined);
    // A NUL byte in the executable path makes spawn throw at once: the start fails with no new seam.
    const failed = capture();
    process.execPath = "/no-such-node\u0000";
    try {
      await daemonBoot(failed.log, { PATH: process.env.PATH });
    } finally {
      process.execPath = execPath;
    }
    assert.equal(installedSpawnHelper(), undefined, "a helper that cannot start is not installed");
    const [row] = helperRows(failed.rows);
    assert.deepEqual([row?.started, row?.value], [false, "unset"]);
    assert.match(String(row?.reason), /^start_failed: /);
    assert.ok(failed.rows.some((r) => r.step === "daemon.boot"), "the boot continues");
    const afterFailed = await runRouted({ file: "sh", args: ["-c", "echo out; exit 3"] });
    assert.deepEqual([afterFailed.via, afterFailed.exitCode, afterFailed.stdout], ["direct", 3, "out\n"]);

    // The default boot's helper dies: the next spawn runs directly with the same result, its reason named.
    const booted = capture();
    await daemonBoot(booted.log, { PATH: process.env.PATH });
    const helper = installedSpawnHelper();
    assert.ok(helper?.pid, "the default boot started a helper");
    process.kill(helper.pid, "SIGKILL");
    await until(() => helper.unhealthy() !== undefined);
    const request = { file: "sh", args: ["-c", "echo out; echo err >&2; exit 4"] };
    const fallback = await runRouted(request);
    assert.deepEqual([fallback.via, fallback.reason], ["direct", "helper_exited: SIGKILL"]);
    assert.deepEqual(comparable(fallback), comparable(await runDirect(request)));
    stopInstalled();

    // A request written to a helper that then dies settles as failed and is run by nobody a second time.
    const seen = join(dir, "seen");
    const ran = join(dir, "ran");
    const dying = startSpawnHelper({ source: `require("node:readline").createInterface({ input: process.stdin })
      .on("line", (line) => { require("node:fs").appendFileSync(${JSON.stringify(seen)}, line + "\\n"); process.exit(1); });` });
    try {
      const inFlight = await dying.run({ file: "sh", args: ["-c", `echo ran >> '${ran}'`] });
      assert.deepEqual([inFlight.via, inFlight.error, inFlight.exitCode], ["helper", "helper_died_in_flight", null]);
      assert.match(String(inFlight.reason), /^helper_exited: 1$/);
      const after = await dying.run({ file: "true" });
      assert.deepEqual([after.via, after.exitCode], ["direct", 0], "the next request takes the direct path");
    } finally {
      dying.stop();
    }
    assert.equal(readFileSync(seen, "utf8").trim().split("\n").length, 1, "the helper received the request once");
    assert.equal(existsSync(ran), false, "the request in flight was never run again, by the helper or directly");
  } finally {
    process.execPath = execPath;
    stopInstalled();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The elements of a bash array literal, single- or multi-line. */
function bashArray(path: string, name: string): string[] {
  const match = readFileSync(join(REPO_ROOT, path), "utf8").match(new RegExp(`${name}=\\(([\\s\\S]*?)\\)`));
  assert.ok(match, `${name}=(...) in ${path}`);
  return match[1].split(/\s+/).filter(Boolean);
}

test("W1-T13437 criterion 4: the switch is in every runtime passthrough list, and the lists stay equal", () => {
  const shared = bashArray("deploy/runtime-env-vars.sh", "RMD_DAEMON_RUNTIME_ENV_VARS");
  const recycle = bashArray("deploy/recycle-container.sh", "RMD_DAEMON_RUNTIME_ENV_VARS");
  const hostUpdate = bashArray("deploy/host-update.sh", "RMD_DAEMON_RUNTIME_ENV_VARS");
  assert.ok(shared.includes(SPAWN_HELPER_SWITCH), "deploy/runtime-env-vars.sh names the switch");
  assert.deepEqual([...recycle].sort(), [...shared].sort(), "recycle-container.sh's fallback equals the shared list");
  assert.deepEqual([...hostUpdate].sort(), [...shared].sort(), "host-update.sh's fallback equals the shared list");

  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}spawn-helper-print-`));
  try {
    const printed = spawnSync("bash", [join(REPO_ROOT, "deploy/host-update.sh"), "--print-daemon-run"], {
      encoding: "utf8", cwd: REPO_ROOT,
      env: { ...process.env, RMD_STATE_DIR: join(dir, "state-root"), RMD_OP_DIR: join(dir, "op"),
        RMD_CLAUDE_DIR: join(dir, "claude"), RMD_CODEX_DIR: join(dir, "codex"),
        RMD_CONTAINER_CONFIG_DIR: join(dir, "config"), RMD_SCRATCH: "off" },
    });
    assert.equal(printed.status, 0, printed.stderr);
    const block = printed.stdout.slice(printed.stdout.indexOf("docker run -d --name remudero-daemon"),
      printed.stdout.indexOf("./bin/rmd daemon"));
    const names = [...block.matchAll(/-e\s+([A-Z_][A-Z0-9_]*)(?==|\s|$)/g)].map((m) => m[1]);
    assert.deepEqual(names.sort(), [...shared].sort(), "the printed launch passes exactly the declared names");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T13437 criterion 5: the default changes whether the helper runs, not which callers use it", async () => {
  try {
    installSpawnHelper(undefined);
    const booted = capture();
    await daemonBoot(booted.log, { PATH: process.env.PATH });
    assert.ok(installedSpawnHelper(), "the default boot installed a helper");
    const version = await defaultMergeProbeGit(REPO_ROOT)(["--version"]);
    assert.equal(version.status, 0);
    assert.deepEqual(routedRows(booted.rows).map((row) => [row.via, row.command]), [["helper", "git"]],
      "a caller that already routes rides the helper");
    const direct = await execFileLoopBounded("git", ["--version"], { encoding: "utf8" });
    assert.match(direct.stdout, /^git version /);
    assert.equal(routedRows(booted.rows).length, 1, "a direct execFileLoopBounded call is not routed and writes no row");
  } finally {
    stopInstalled();
  }
});
