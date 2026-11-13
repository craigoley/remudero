import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { REPO_ROOT } from "#test/helpers/repo-root.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-session-cpu-weight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = join(root, "systemctl-calls");
  const systemctl = join(root, "systemctl");
  writeFileSync(join(root, "meminfo"), "MemTotal: 16371996 kB\n");
  writeFileSync(systemctl, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RMD_TEST_CALLS"
case "$1" in
  show)
    case "$4" in
      CPUWeight) printf '%s\\n' "\${RMD_TEST_LIVE_CPU:-100}" ;;
      MemoryHigh) printf '%s\\n' "\${RMD_TEST_LIVE_HIGH:-6442450944}" ;;
    esac ;;
  set-property) [ "\${RMD_TEST_SET_FAIL:-0}" != 1 ] ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  const env = {
    ...process.env,
    RMD_UNIT_DIR: join(root, "systemd"), RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"), RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_STATE_DIR: join(root, "state"), RMD_SERVICE_UID: "1000", RMD_SERVICE_USER: "rmd-fixture",
    RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_CLEANUP_PATH: "", RMD_LEGACY_USER_UNIT_DIR: "",
    RMD_NODESOURCE_PATH: join(root, "absent-nodesource"), RMD_SYSTEMCTL_CMD: systemctl,
    RMD_TEST_CALLS: calls, RMD_MEMINFO_PATH: join(root, "meminfo"),
    RMD_SESSION_CPU_WEIGHT: "30", RMD_SESSION_MEMORY_WEIGHT: "24", RMD_SESSION_HIGH_STEP_MIB: "256",
    RMD_MEMORY_WEIGHTS: "remudero-daemon=16 remudero-serve=10 remudero-console-daemon=3 remudero-site-daemon=2",
    RMD_HOST_RESERVE_MIB: "2048",
  };
  const run = (args: string[] = ["--install"], extra: Record<string, string> = {}) => {
    writeFileSync(calls, "");
    const result = spawnSync("bash", [join(REPO_ROOT, "deploy/install-host-units.sh"), ...(args.length ? args : ["--install"])], {
      cwd: REPO_ROOT, env: { ...env, ...extra }, encoding: "utf8",
    });
    if (!args.includes("--check")) assert.equal(result.status, 0, result.stdout + result.stderr);
    return { ...result, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) };
  };
  const cpu = join(root, "systemd/user.slice.d/50-rmd-cap.conf");
  const memory = join(root, "systemd/user-1000.slice.d/50-rmd-cap.conf");
  return { root, cpu, memory, run, env };
}

const directives = (text: string) => text.split("\n").filter(line => line.trim() && !line.startsWith("#"));

test("W1-T12060 criterion 1: user.slice gets the persisted and live session CPU weight", (t) => {
  const fx = fixture(t);
  mkdirSync(join(fx.root, "systemd/user-1000.slice.d"), { recursive: true });
  const legacy = "[Slice]\nCPUWeight=30\nMemoryHigh=6G\n";
  writeFileSync(fx.memory, legacy);
  const missing = fx.run(["--check"]);
  assert.equal(missing.status, 1);
  assert.ok(missing.stdout.includes(`MISSING ${fx.cpu}`));
  assert.equal(existsSync(fx.cpu), false, "check mode must leave the tree untouched");
  assert.deepEqual(missing.calls, []);
  const first = fx.run();
  assert.deepEqual(directives(readFileSync(fx.cpu, "utf8")), ["[Slice]", "CPUWeight=30"]);
  assert.equal(statSync(fx.cpu).mode & 0o777, 0o644);
  assert.equal(readFileSync(fx.memory, "utf8"), legacy, "an upgrade preserves the existing memory policy");
  assert.ok(first.calls.includes("show user.slice -p CPUWeight --value"));
  const apply = "set-property --runtime user.slice CPUWeight=30";
  assert.ok(first.calls.includes(apply), first.calls.join("\n"));
  assert.ok(first.calls.indexOf("daemon-reload") < first.calls.indexOf(apply));
  const before = statSync(fx.cpu).mtimeMs;
  const repeat = fx.run([], { RMD_TEST_LIVE_CPU: "30" });
  assert.equal(statSync(fx.cpu).mtimeMs, before);
  assert.ok(!repeat.calls.some(call => call.startsWith("set-property")));
  assert.ok(!repeat.calls.includes("daemon-reload"));
  const runtimeDrift = fx.run();
  assert.ok(runtimeDrift.calls.includes(apply), "runtime drift is corrected even when the drop-in matches");
  assert.ok(!runtimeDrift.calls.includes("daemon-reload"));
  assert.equal(fx.run(["--check"]).status, 0);
  writeFileSync(fx.cpu, "[Slice]\nCPUWeight=100\n");
  assert.equal(fx.run(["--check"]).status, 1);
  fx.run();
  assert.deepEqual(directives(readFileSync(fx.cpu, "utf8")), ["[Slice]", "CPUWeight=30"]);
});

test("W1-T12060 criterion 2: the policy names user.slice and its configured CPU weight", (t) => {
  const fx = fixture(t);
  for (const weight of ["30", "20"]) {
    const result = spawnSync("bash", ["-c", '. "$1"; resource_policy_session_slice; printf "%s\\n" "$RP_SESSION_NOTE"',
      "policy", join(REPO_ROOT, "deploy/resource-policy.sh")], {
      cwd: REPO_ROOT, encoding: "utf8", env: { ...fx.env, RMD_SESSION_CPU_WEIGHT: weight },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`CPUWeight ${weight} on user.slice`), result.stdout);
    const installed = fx.run([], { RMD_SESSION_CPU_WEIGHT: weight });
    assert.deepEqual(directives(readFileSync(fx.cpu, "utf8")), ["[Slice]", `CPUWeight=${weight}`]);
    assert.ok(installed.calls.includes(`set-property --runtime user.slice CPUWeight=${weight}`));
    assert.ok(installed.stdout.includes(`user.slice CPUWeight`), installed.stdout);
  }
  const defaults = spawnSync("bash", ["-c", 'unset RMD_SESSION_CPU_WEIGHT; . "$1"; resource_policy_session_slice; printf "%s\\n" "$RP_SESSION_NOTE"',
    "policy", join(REPO_ROOT, "deploy/resource-policy.sh")], { cwd: REPO_ROOT, encoding: "utf8", env: fx.env });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.ok(defaults.stdout.includes("CPUWeight 30 on user.slice"), defaults.stdout);
});

test("W1-T12060 criterion 3: the UID slice keeps its memory sizing and runtime fallback", (t) => {
  const fx = fixture(t);
  const result = fx.run([], { RMD_TEST_LIVE_HIGH: "infinity" });
  assert.deepEqual(directives(readFileSync(fx.cpu, "utf8")), ["[Slice]", "CPUWeight=30"]);
  assert.deepEqual(directives(readFileSync(fx.memory, "utf8")), ["[Slice]", "CPUWeight=30", "MemoryHigh=6G"]);
  assert.ok(result.calls.includes("set-property --runtime user-1000.slice MemoryHigh=6144M CPUWeight=30"));
  assert.ok(!result.calls.some(call => call.includes("user.slice MemoryHigh")));
  writeFileSync(join(fx.root, "meminfo"), "MemTotal: 65536000 kB\n");
  fx.run();
  assert.deepEqual(directives(readFileSync(fx.memory, "utf8")), ["[Slice]", "CPUWeight=30", "MemoryHigh=27136M"]);
});

test("session CPU weight remains available when MemTotal or the service UID is unknown", (t) => {
  const fx = fixture(t);
  const result = fx.run([], { RMD_MEMINFO_PATH: join(fx.root, "absent"), RMD_SERVICE_UID: "unknown" });
  assert.deepEqual(directives(readFileSync(fx.cpu, "utf8")), ["[Slice]", "CPUWeight=30"]);
  assert.equal(existsSync(fx.memory), false);
  assert.ok(result.calls.includes("set-property --runtime user.slice CPUWeight=30"));
});

test("session CPU weight reports a failed runtime application and keeps the reboot drop-in", (t) => {
  const fx = fixture(t);
  const result = fx.run([], { RMD_TEST_SET_FAIL: "1" });
  assert.ok(result.calls.includes("set-property --runtime user.slice CPUWeight=30"));
  assert.match(result.stderr, /WARNING user\.slice CPUWeight reads 100, not 30/);
  assert.deepEqual(directives(readFileSync(fx.cpu, "utf8")), ["[Slice]", "CPUWeight=30"]);
});

test("session CPU weight renders without invoking systemd in a temporary unit tree", (t) => {
  const fx = fixture(t);
  fx.run([], { RMD_SYSTEMCTL_CMD: "" });
  assert.deepEqual(directives(readFileSync(fx.cpu, "utf8")), ["[Slice]", "CPUWeight=30"]);
  assert.equal(readFileSync(join(fx.root, "systemctl-calls"), "utf8"), "");
});
