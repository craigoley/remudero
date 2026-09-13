import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(REPO_ROOT, "deploy", "install-host-units.sh");
const RECYCLE = join(REPO_ROOT, "deploy", "recycle-container.sh");

interface Fixture {
  root: string;
  bin: string;
  unitDir: string;
  registry: string;
  calls: string;
  coreState: string;
  siteState: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-instance-registry-"));
  const bin = join(root, "bin");
  const unitDir = join(root, "systemd");
  const calls = join(root, "calls.tsv");
  const coreState = join(root, "core-state");
  const siteState = join(root, "site-state");
  for (const dir of [bin, unitDir, join(coreState, "state"), join(siteState, "state")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(coreState, "state", "ledger.ndjson"), "{}\n");
  writeFileSync(join(siteState, "state", "ledger.ndjson"), "{}\n");
  writeFileSync(calls, "");
  writeStubs(bin);
  const registry = join(root, "instances.yaml");
  writeFileSync(
    registry,
    [
      "instances:",
      "  core:",
      "    repo: remudero",
      `    state_dir: ${coreState}`,
      "    container_name: remudero-daemon",
      "    service_user: node",
      "    image: synthwatcholey0620.azurecr.io/remudero:latest",
      "    max_old_space_mb: 8192",
      "    service_name: rmd-fleet.service",
      "    watchdog_service_name: rmd-fleet-watchdog.service",
      "    watchdog_timer_name: rmd-fleet-watchdog.timer",
      `    launcher_path: ${join(root, "rmd-relaunch.sh")}`,
      `    revival_log: ${join(root, "core-revivals.log")}`,
      "    gh_app_id: 1",
      "    gh_app_installation_id: 2",
      "    gh_app_private_key_path: /home/node/.claude/rmd-app.pem",
      "    claude_dir: /home/node/.claude",
      "    codex_dir: /home/node/.codex",
      "    container_config_dir: /home/node/.config/remudero-container",
      "  site:",
      "    repo: remudero-site",
      `    state_dir: ${siteState}`,
      "    container_name: remudero-site-daemon",
      "    service_user: node",
      "    image: synthwatcholey0620.azurecr.io/remudero:latest",
      "    max_old_space_mb: 4096",
      "    service_name: rmd-site-fleet.service",
      "    watchdog_service_name: rmd-site-fleet-watchdog.service",
      "    watchdog_timer_name: rmd-site-fleet-watchdog.timer",
      `    launcher_path: ${join(root, "rmd-site-relaunch.sh")}`,
      `    revival_log: ${join(root, "site-revivals.log")}`,
      "    gh_app_id: 1",
      "    gh_app_installation_id: 2",
      "    gh_app_private_key_path: /home/node/.claude/rmd-app.pem",
      "    claude_dir: /home/node/.claude",
      "    codex_dir: /home/node/.codex",
      "    container_config_dir: /home/node/.config/remudero-container",
      "",
    ].join("\n"),
  );
  return { root, bin, unitDir, registry, calls, coreState, siteState };
}

function writeStubs(bin: string): void {
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/usr/bin/env bash",
      'printf "docker" >> "$RMD_TEST_CALLS"',
      'for arg in "$@"; do printf "\\t%s" "$arg" >> "$RMD_TEST_CALLS"; done',
      'printf "\\n" >> "$RMD_TEST_CALLS"',
      'case "$1" in',
      "  ps)",
      '    case " $* " in *"^${RMD_TEST_RUNNING_CONTAINER}$"*) echo running-id ;; esac',
      "    exit 0",
      "    ;;",
      "  inspect)",
      '    case "$*" in',
      '      *State.Status*) echo "${RMD_TEST_INSPECT_STATUS:-exited}" ;;',
      '      *State.ExitCode*) echo "${RMD_TEST_INSPECT_EXIT:-0}" ;;',
      '      *RestartCount*) echo "${RMD_TEST_INSPECT_RESTARTS:-0}" ;;',
      "      *) exit 0 ;;",
      "    esac",
      "    exit 0",
      "    ;;",
      "  rm|run|stop|pull|image|exec) exit 0 ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "findmnt"),
    [
      "#!/usr/bin/env bash",
      'printf "findmnt" >> "$RMD_TEST_CALLS"',
      'for arg in "$@"; do printf "\\t%s" "$arg" >> "$RMD_TEST_CALLS"; done',
      'printf "\\n" >> "$RMD_TEST_CALLS"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "findmnt"), 0o755);
}

function run(command: string, args: string[], fx: Fixture, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("bash", [command, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH ?? ""}`,
      RMD_INSTANCE_REGISTRY: fx.registry,
      RMD_UNIT_DIR: fx.unitDir,
      RMD_BIN_DIR: fx.bin,
      RMD_TEST_CALLS: fx.calls,
      RMD_RECYCLE_DOCKERENV_PATH: join(fx.root, "absent-dockerenv"),
      ...extraEnv,
    },
  });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

function installInstance(fx: Fixture, instance: string): string {
  const result = run(INSTALLER, ["--install", "--instance", instance], fx);
  assert.equal(result.status, 0, result.output);
  return instance === "site" ? join(fx.root, "rmd-site-relaunch.sh") : join(fx.root, "rmd-relaunch.sh");
}

function calls(fx: Fixture): string[] {
  return readFileSync(fx.calls, "utf8").split("\n").filter(Boolean);
}

test("W1-T3532: a site instance's clean exit relaunches the site instance only, never core", () => {
  const fx = makeFixture();
  const launcher = installInstance(fx, "site");

  const result = run(launcher, [], fx);
  assert.equal(result.status, 0, result.output);

  const recorded = calls(fx).join("\n");
  assert.match(recorded, /docker\trm\t-f\tremudero-site-daemon/);
  assert.match(recorded, /docker\trun\t-d\t--name\tremudero-site-daemon/);
  assert.match(recorded, /\t--repo\tremudero-site\t--allow-self-target/);
  assert.doesNotMatch(recorded, /remudero-daemon/);
});

test("W1-T3532: STOP set for the site instance blocks only site revival; core's tick is unaffected", () => {
  const fx = makeFixture();
  const siteLauncher = installInstance(fx, "site");
  const coreLauncher = installInstance(fx, "core");
  writeFileSync(join(fx.siteState, "state", "STOP"), "");

  const site = run(siteLauncher, [], fx);
  assert.equal(site.status, 0, site.output);
  assert.match(site.output, /state\/STOP present/);
  assert.deepEqual(calls(fx), [], "site STOP must refuse before any Docker action");

  const core = run(coreLauncher, [], fx, { RMD_TEST_RUNNING_CONTAINER: "remudero-daemon" });
  assert.equal(core.status, 0, core.output);
  assert.match(core.output, /remudero-daemon already running/);
  assert.match(calls(fx).join("\n"), /\^remudero-daemon\$/);
});

test("W1-T3532: a tick over one instance never checks or writes another instance's units", () => {
  const fx = makeFixture();
  installInstance(fx, "site");

  const check = run(INSTALLER, ["--instance", "site"], fx);
  assert.equal(check.status, 0, check.output);
  assert.match(check.output, /rmd-site-fleet\.service/);
  assert.match(check.output, /rmd-site-fleet-watchdog\.timer/);
  assert.doesNotMatch(check.output, /rmd-fleet\.service/);
  assert.doesNotMatch(check.output, /rmd-reap-stray/);
});

test("W1-T3532: an unknown or malformed instance record is refused before Docker or systemd writes", () => {
  const fx = makeFixture();
  const missing = run(INSTALLER, ["--install", "--instance", "missing"], fx);
  assert.equal(missing.status, 2, missing.output);
  assert.match(missing.output, /not declared/);
  assert.deepEqual(calls(fx), []);

  const badRegistry = join(fx.root, "bad.yaml");
  writeFileSync(badRegistry, "instances:\n  site:\n    repo: remudero-site\n");
  const malformed = run(INSTALLER, ["--install", "--instance", "site"], fx, { RMD_INSTANCE_REGISTRY: badRegistry });
  assert.equal(malformed.status, 2, malformed.output);
  assert.match(malformed.output, /missing required field/);
  assert.deepEqual(calls(fx), []);
});

test("W1-T3532: a healthy instance's repeated tick is idempotent and issues no redundant Docker action", () => {
  const fx = makeFixture();
  const launcher = installInstance(fx, "site");

  const result = run(launcher, [], fx, { RMD_TEST_RUNNING_CONTAINER: "remudero-site-daemon" });
  assert.equal(result.status, 0, result.output);

  const recorded = calls(fx).join("\n");
  assert.match(recorded, /\^remudero-site-daemon\$/);
  assert.doesNotMatch(recorded, /docker\trm/);
  assert.doesNotMatch(recorded, /docker\trun/);
  assert.doesNotMatch(recorded, /systemctl/);
});

test("W1-T3532: existing recycle-container.sh guarded refusals remain intact through the registry", () => {
  const fx = makeFixture();
  const uncommissionedState = join(fx.root, "uncommissioned-site");
  const registry = readFileSync(fx.registry, "utf8").replace(fx.siteState, uncommissionedState);
  writeFileSync(fx.registry, registry);

  const result = run(RECYCLE, ["--instance", "site"], fx);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /STATE_DIR resolved to/);
  assert.match(result.output, new RegExp(uncommissionedState.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const recorded = calls(fx).join("\n");
  assert.doesNotMatch(recorded, /docker\tpull/);
  assert.doesNotMatch(recorded, /docker\tstop/);
  assert.doesNotMatch(recorded, /docker\trm/);
  assert.doesNotMatch(recorded, /docker\trun/);
});
