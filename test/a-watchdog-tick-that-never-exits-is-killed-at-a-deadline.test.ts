import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

/** Only fixture artifacts are installed; this never invokes systemctl or a live host. */
function render(t: TestContext, instance = "core") {
  const root = mkdtempSync(join(tmpdir(), "rmd-watchdog-deadline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state-root");
  const registry = join(root, "instances.yaml");
  writeFileSync(registry, "instances:\n" + ["core", "site", "console"].map(name => {
    const prefix = name === "core" ? "" : `${name}-`;
    return [`  ${name}:`, "    repo: remudero", `    state_dir: ${state}`,
      `    container_name: remudero-${prefix}daemon`, "    service_user: fixture",
      "    image: example.invalid/remudero:fixture", "    max_old_space_mb: 8192",
      `    service_name: rmd-${prefix}fleet.service`, `    watchdog_service_name: rmd-${prefix}fleet-watchdog.service`,
      `    watchdog_timer_name: rmd-${prefix}fleet-watchdog.timer`, `    launcher_path: ${root}/launcher`,
      `    revival_log: ${root}/revivals.log`, "    gh_app_id: 1234", "    gh_app_installation_id: 5678",
      "    gh_app_private_key_path: /home/node/.claude/fixture.pem", `    claude_dir: ${root}/claude`,
      `    codex_dir: ${root}/codex`, `    container_config_dir: ${root}/config`].join("\n");
  }).join("\n") + "\n");
  const env = {
    ...process.env,
    RMD_STATE_DIR: state,
    RMD_INSTANCE_REGISTRY: registry,
    RMD_UNIT_DIR: join(root, "units"),
    RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: join(root, "launcher"),
    RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
  };
  const installed = spawnSync("bash", ["deploy/install-host-units.sh", "--install", "--instance", instance], {
    env, encoding: "utf8",
  });
  assert.equal(installed.status, 0, installed.stderr);
  return { root, state, env, launcher: join(root, "launcher"), revivals: join(root, "revivals.log") };
}

function executable(path: string, text: string) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** A real timeout on Linux; only Mac's missing GNU utility gets this equivalent fixture shim. */
function timeoutOnMac(stubbin: string) {
  if (spawnSync("timeout", ["--version"]).status === 0) return;
  assert.equal(process.platform, "darwin", "the Linux fixture must exercise the real GNU timeout");
  executable(join(stubbin, "timeout"), `#!/usr/bin/env python3
import os, signal, subprocess, sys
args = sys.argv[1:]
if args[:1] != ["-k"]:
    os.execvp(args[1], args[1:])
grace, deadline = float(args[1]), float(args[2])
child = subprocess.Popen(args[3:], start_new_session=True)
try:
    sys.exit(child.wait(timeout=deadline))
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=grace)
        sys.exit(124)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        sys.exit(137)
`);
}

function healthyFixture(t: TestContext, result: "hang" | "kill" | "ok" | "fail" = "hang") {
  const h = render(t);
  const stubbin = join(h.root, "stubs");
  for (const dir of [stubbin, join(h.state, "state"), join(h.state, "remudero", "bin")]) {
    mkdirSync(dir, { recursive: true });
  }
  executable(join(stubbin, "docker"), `#!/usr/bin/env bash
case "$1" in ps) echo fixture-daemon ;; inspect) echo 1 ;; esac
`);
  timeoutOnMac(stubbin);
  const calls = join(h.root, "calls");
  const sleepers = join(h.root, "sleepers");
  executable(join(stubbin, "sleep"), `#!/usr/bin/env bash
printf '%s\\n' "$$" >> "${sleepers}"
exec /bin/sleep "$@"
`);
  const rmd = join(h.state, "remudero", "bin", "rmd");
  executable(rmd, `#!/usr/bin/env bash
case "$1" in
  progress-watchdog) echo '{"state":"PROGRESSING","action":"none"}' ;;
  deploy-run)
    printf '%s\n' '{"step":"deploy.skip","reason":"fixture decided before hanging"}'
    ${result === "hang" ? "sleep 120" : result === "kill" ? "trap '' TERM; sleep 120" : `sleep 0.1; exit ${result === "ok" ? "0" : "7"}`}
    ;;
  host-alert) printf '%s\n' "$@" >> "${calls}" ;;
esac
`);
  const original = readFileSync(h.launcher, "utf8");
  // There is no environment knob. Keep the production proposal pinned and shorten the rendered
  // fixture only; it still executes the real branch, process observer, timeout and alert path.
  assert.match(original, /^WATCHDOG_DEPLOY_DEADLINE_S=3600$/m);
  writeFileSync(h.launcher, original.replace("WATCHDOG_DEPLOY_DEADLINE_S=3600", "WATCHDOG_DEPLOY_DEADLINE_S=2")
    .replace("timeout -k 30", "timeout -k 1"));
  return { ...h, calls, sleepers, env: { ...h.env, PATH: `${stubbin}:${process.env.PATH ?? ""}` } };
}

/** An independent harness deadline makes reverting the production timeout fail without hanging CI. */
function tick(h: ReturnType<typeof healthyFixture>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [h.launcher], { env: h.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", expired = false;
    child.stdout.on("data", b => { stdout += String(b); });
    child.stderr.on("data", b => { stderr += String(b); });
    const harnessDeadline = setTimeout(() => {
      expired = true;
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }, 8_000);
    child.once("error", e => { clearTimeout(harnessDeadline); reject(e); });
    child.once("close", code => {
      clearTimeout(harnessDeadline);
      if (expired) reject(new Error(`the rendered tick exceeded its harness deadline\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr, code });
    });
  });
}

test("W1-T9800: every instance watchdog service carries a bounded start timeout", t => {
  for (const instance of ["core", "site", "console"]) {
    const h = render(t, instance);
    const service = readFileSync(join(h.root, "units", `rmd-${instance === "core" ? "" : `${instance}-`}fleet-watchdog.service`), "utf8");
    assert.match(service, /^TimeoutStartSec=75min$/m, `${instance} has the proposed finite backstop`);
    assert.match(service, /^KillMode=control-group$/m, `${instance} kills the complete tick cgroup`);
    assert.match(service, /^SendSIGKILL=yes$/m, `${instance} does not let an unresponsive child survive`);
    assert.match(service, /^Type=oneshot$/m);
    assert.ok(3_600 > 3_158, "the proposed step deadline exceeds the captured longest legitimate tick");
    assert.ok(75 * 60 > 3_600 + 30, "the unit leaves room for step diagnostics and kill escalation");
  }
});

test("W1-T9800: a deploy-run that never exits is killed at its deadline and named", async t => {
  const h = healthyFixture(t);
  const run = await tick(h);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /"step":"deploy.skip"/, "the decision printed before the hang is retained");
  assert.match(run.stderr, /deploy-run -- no exit after 2s; killed/);
  assert.match(run.stderr, /deploy-run process tree before deadline: PID PPID STAT COMM/);
  assert.match(run.stderr, /[0-9]+[ \t]+[0-9]+[ \t]+[A-Za-z+<]+[ \t]+(?:\/bin\/)?sleep/, "the actual hung child's state is visible");
  assert.match(readFileSync(h.revivals, "utf8"), /^\S+ watchdog-step-timeout step=deploy-run deadline_s=2$/m);
});

test("W1-T9800: a timed-out deploy-run raises the deploy-run-problem alert", async t => {
  const h = healthyFixture(t, "kill");
  const run = await tick(h);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /deploy-run -- no exit after 2s; killed/);
  const calls = readFileSync(h.calls, "utf8");
  assert.match(calls, /--condition\ndeploy-run-problem\n--raise\n.*deploy-run -- no exit after 2s; killed/);
  assert.doesNotMatch(calls, /--clear/);
  assert.match(readFileSync(h.revivals, "utf8"), /watchdog-step-timeout step=deploy-run deadline_s=2/);
});

test("W1-T9800: clean and ordinary failed deploy runs retain their existing alert behavior", async t => {
  for (const result of ["ok", "fail"] as const) {
    const h = healthyFixture(t, result);
    const run = await tick(h);
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /no exit after|process tree before deadline/);
    assert.equal(existsSync(h.revivals), false, "an ordinary result is never ledgered as a timeout");
    const pids = readFileSync(h.sleepers, "utf8").trim().split("\n");
    assert.ok(pids.length >= 2, "the real command and owned observer both started a sleep child");
    for (const pid of pids) {
      const stat = spawnSync("ps", ["-p", pid, "-o", "stat="], { encoding: "utf8" });
      assert.equal(stat.status, 1, `owned sleep ${pid} was stopped and reaped: ${stat.stdout}`);
    }
    if (result === "ok") assert.equal(existsSync(h.calls), false, "no prior alert means no clear process is spawned");
    else assert.match(readFileSync(h.calls, "utf8"), /deploy-run-problem\n--raise\nrmd deploy-run --image-drift-only exited non-zero:/);
  }
});
