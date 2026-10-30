import { legacyHostScript, withoutRegistrySelection } from "#test/helpers/legacy-host-launch.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { REGISTERED_GARDEN_NAMES } from "../src/lib/garden-registry.js";
import { resolveSreLaneInstance, sreLaneStartRow } from "../src/lib/sre-lane.js";
import * as runTask from "../src/run-task.js";

/**
 * W1-T9500 — the SRE lane names its own registry instance from INSIDE its container. W1-T8232
 * matched the daemon's state root against the registry's `state_dir` values, but those are HOST
 * paths (core: /home/craigoleyagent/rmd-state2) and inside every container the root is
 * /home/node/Remudero, so the match never held. MEASURED 2026-10-14 on the core ledger: 63
 * `sre_lane.disabled` rows and 0 `sre_lane.started`; the newest (15:56:34.487Z) reads "state root
 * /home/node/Remudero is not exactly one instance's state_dir". The container's creator holds the
 * name, so the recycle (and the installed launcher) pass it as `RMD_INSTANCE_NAME`, and the lane
 * prefers it over the state-root match.
 *
 * HERMETIC: every case states its own `RMD_INSTANCE_NAME` — a fleet container carries one once
 * this ships, and the suite must read the same there as on a laptop or CI.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_REGISTRY = join(REPO_ROOT, ".remudero", "daemon-instances.yaml");
/** The state root the core daemon's 15:56:34.487Z `sre_lane.disabled` row named. */
const CONTAINER_ROOT = "/home/node/Remudero";
const RECYCLE = join(REPO_ROOT, "deploy", "recycle-container.sh");
const INSTALLER = join(REPO_ROOT, "deploy", "install-host-units.sh");

/** Run `fn` with `RMD_INSTANCE_NAME` set to `value` (or unset), restoring the runner's own after. */
function withInstanceName(t: TestContext, value: string | undefined): void {
  const old = process.env.RMD_INSTANCE_NAME;
  if (value === undefined) delete process.env.RMD_INSTANCE_NAME;
  else process.env.RMD_INSTANCE_NAME = value;
  t.after(() => {
    if (old === undefined) delete process.env.RMD_INSTANCE_NAME;
    else process.env.RMD_INSTANCE_NAME = old;
  });
}

/** Boot `rmd daemon` on a temp root the registry does NOT name (as inside a container), and return
 *  the gardens it hands the loop and the `sre_lane.*` rows it ledgered. */
async function startContainerisedDaemon(t: TestContext, instanceName: string, onRun?: () => void): Promise<{ gardens: unknown[]; laneRows: Array<Record<string, unknown>> }> {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t9500-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const registryPath = join(home, "daemon-instances.yaml");
  // The registry names HOST paths, exactly as the live one does; none of them is this daemon's root.
  writeFileSync(registryPath, [
    "instances:",
    "  core:",
    "    repo: remudero",
    "    github_repo: craigoley/remudero",
    "    primary: true",
    "    state_dir: /home/craigoleyagent/rmd-state2",
    "  site:",
    "    repo: remudero-site",
    "    github_repo: craigoley/remudero-site",
    "    state_dir: /home/craigoleyagent/rmd-site-state",
    "",
  ].join("\n"));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const old = { HOME: process.env.HOME, RMD_SRE_LANE: process.env.RMD_SRE_LANE, RMD_INSTANCE_REGISTRY: process.env.RMD_INSTANCE_REGISTRY };
  process.env.HOME = home;
  process.env.RMD_INSTANCE_REGISTRY = registryPath;
  delete process.env.RMD_SRE_LANE;
  withInstanceName(t, instanceName);
  t.after(() => {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  let gardens: unknown[] = [];
  await runTask.daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
    gardenPassSpawn: async () => 0,
    runDaemon: async (_plan, d) => {
      onRun?.();
      gardens = (d as { gardens?: unknown[] }).gardens ?? [];
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  } as Parameters<typeof runTask.daemonCommand>[1]);
  const laneRows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => typeof row.step === "string" && row.step.startsWith("sre_lane."));
  return { gardens, laneRows };
}

test("W1-T9500: a containerised core daemon resolves its instance by name and starts the lane", async (t) => {
  // The defect, as measured: the container's root against the repo registry resolves nothing.
  const byRoot = resolveSreLaneInstance({ stateRoot: CONTAINER_ROOT, registryPath: REPO_REGISTRY, env: {} });
  assert.equal(byRoot.resolved, false, "control: the container root is no registry state_dir");
  assert.equal(sreLaneStartRow({ instance: byRoot, env: {} }).fields.resolved_by, "state_root");

  // The creator named it: the same root now resolves core, the live primary, and the lane starts.
  const byName = resolveSreLaneInstance({ stateRoot: CONTAINER_ROOT, registryPath: REPO_REGISTRY, env: { RMD_INSTANCE_NAME: "core" } });
  assert.deepEqual(byName, { resolved: true, name: "core", live: true, primary: true, resolvedBy: "env" });
  assert.deepEqual(sreLaneStartRow({ instance: byName, env: {} }), {
    step: "sre_lane.started",
    fields: { instance: "core", enabled_by: "primary", resolved_by: "env" },
  });

  // A host-side caller with no variable (or a blank one) still matches its state root, unchanged.
  for (const env of [{}, { RMD_INSTANCE_NAME: "  " }]) {
    assert.deepEqual(
      resolveSreLaneInstance({ stateRoot: "/home/craigoleyagent/rmd-state2", registryPath: REPO_REGISTRY, env }),
      { resolved: true, name: "core", live: true, primary: true, resolvedBy: "state_root" },
    );
  }

  // The daemon itself reads the variable from its own environment, which is how a container gets it.
  const { gardens, laneRows } = await startContainerisedDaemon(t, "core");
  assert.deepEqual(
    laneRows.map((row) => ({ step: row.step, instance: row.instance, enabled_by: row.enabled_by, resolved_by: row.resolved_by })),
    [{ step: "sre_lane.started", instance: "core", enabled_by: "primary", resolved_by: "env" }],
  );
  assert.equal(gardens.length, REGISTERED_GARDEN_NAMES.length + 1, "the SRE starter is added after every registered garden");
});

test("W1-T9500: an unknown instance name disables the lane by name", async (t) => {
  const instance = resolveSreLaneInstance({ stateRoot: CONTAINER_ROOT, registryPath: REPO_REGISTRY, env: { RMD_INSTANCE_NAME: "nonesuch" } });
  assert.equal(instance.resolved, false);
  const row = sreLaneStartRow({ instance, env: {} });
  assert.equal(row.step, "sre_lane.disabled");
  assert.equal(row.fields.resolved_by, "env");
  assert.equal(row.fields.reason, `RMD_INSTANCE_NAME 'nonesuch' names no instance in ${REPO_REGISTRY}`);
  // The name is never silently dropped for the state-root match, even when the root WOULD match.
  const hostRoot = resolveSreLaneInstance({ stateRoot: "/home/craigoleyagent/rmd-state2", registryPath: REPO_REGISTRY, env: { RMD_INSTANCE_NAME: "nonesuch" } });
  assert.equal(hostRoot.resolved, false, "a wrong name is a misconfiguration to surface, not a reason to guess");
  // Explicit selection refuses the unknown binding before the daemon or any lane can run.
  let daemonRuns = 0;
  await assert.rejects(startContainerisedDaemon(t, "nonesuch", () => daemonRuns++), /target_missing_or_mismatched/);
  assert.equal(daemonRuns, 0);
});

// ── the creator names the instance: deploy/recycle-container.sh ─────────────────────────────────

/** A stub `docker` (the W1-T5281/W1-T9409 technique) recording every call; `inspect` reports the
 *  live container's env from STUB_CONTAINER_ENV and an image env of its own that is empty. */
function writeDockerStub(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
    'case "$1" in',
    "  image)",
    '    if [ "$2" = "inspect" ]; then',
    "      shift 2",
    '      fmt=""',
    '      if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '      case "$fmt" in',
    '        *Config.Env*) echo ""; exit 0 ;;',
    '        *) echo "sha256:PULLEDID"; exit 0 ;;',
    "      esac",
    "    fi",
    "    exit 0 ;;",
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    [ -n "$fmt" ] || exit 0',
    '    case "$fmt" in',
    '      *Config.Image*) echo "test-registry/remudero:old"; exit 0 ;;',
    '      *Config.Env*) printf "%s\\n" "GH_TOKEN=captured-token-value" $STUB_CONTAINER_ENV; exit 0 ;;',
    "      *Mounts*)",
    '        printf "%s\\t/home/node/Remudero\\ttrue\\n" "$RMD_STATE_DIR"',
    '        printf "%s\\t/home/node/.claude\\ttrue\\n" "${RMD_CLAUDE_DIR:-$HOME/.claude}"',
    '        printf "%s\\t/home/node/.codex\\ttrue\\n" "$RMD_CODEX_DIR"',
    '        printf "%s\\t/home/node/.config/remudero\\ttrue\\n" "$RMD_CONTAINER_CONFIG_DIR"',
    "        exit 0 ;;",
    '      *.Image}}*) echo "sha256:PULLEDID"; exit 0 ;;',
    "    esac",
    "    exit 0 ;;",
    "  pull)",
    '    echo "Status: Downloaded newer image"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
}

interface Recycle {
  status: number;
  output: string;
  /** The argv of the replacement `docker run -d`, or undefined when none ran. */
  runArgv: string[] | undefined;
}

/** Run the REAL recycle against a temp state dir and a stub docker; `instance` adds `--instance`
 *  against a one-record fixture registry, otherwise the legacy path is scoped by RMD_STATE_DIR. */
function recycle(t: TestContext, opts: { instance?: string; containerEnv?: string }): Recycle {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t9500-recycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { bin: join(root, "bin"), rec: join(root, "rec"), state: join(root, "state-dir"), claude: join(root, "claude"), codex: join(root, "codex"), config: join(root, "config"), tmp: join(root, "tmp") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  mkdirSync(join(dirs.state, "state"), { recursive: true });
  writeDockerStub(dirs.bin);
  const cashKeyPath = join(root, "openweight-api-key");
  writeFileSync(cashKeyPath, "fixture-durable-openweight-key\n", { mode: 0o600 });
  const registry = join(root, "daemon-instances.yaml");
  writeFileSync(registry, [
    "instances:",
    `  ${opts.instance ?? "core"}:`,
    "    repo: remudero",
    `    state_dir: ${dirs.state}`,
    "    container_name: remudero-daemon",
    "    image: test-registry.azurecr.io/remudero:latest",
    `    claude_dir: ${dirs.claude}`,
    `    codex_dir: ${dirs.codex}`,
    `    container_config_dir: ${dirs.config}`,
    "",
  ].join("\n"));
  const r = spawnSync("bash", [legacyHostScript(root, RECYCLE, registry), ...(opts.instance === undefined ? [] : ["--instance", opts.instance])], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...withoutRegistrySelection(process.env),
      PATH: `${dirs.bin}:${process.env.PATH ?? ""}`,
      STUB_REC: dirs.rec,
      STUB_CONTAINER_ENV: opts.containerEnv ?? "",
      RMD_STATE_DIR: dirs.state,
      RMD_CLAUDE_DIR: dirs.claude,
      RMD_CODEX_DIR: dirs.codex,
      RMD_CONTAINER_CONFIG_DIR: dirs.config,
      RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
      RMD_RECYCLE_FIRST_BOOT: "1",
      GH_TOKEN: "",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_INSTANCE_NAME: "",
      RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-such-dockerenv-marker"),
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      TMPDIR: dirs.tmp,
    },
  });
  let calls: string[][] = [];
  try {
    calls = readFileSync(join(dirs.rec, "calls"), "utf8").split("\n").filter(Boolean).map((line) => line.split("\t").slice(1));
  } catch {
    calls = [];
  }
  return {
    status: r.status ?? -1,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    runArgv: calls.find((argv) => argv[0] === "run" && argv[1] === "-d"),
  };
}

/** The values of every `-e RMD_INSTANCE_NAME=<v>` in an argv. */
function instanceNameArgs(argv: string[]): string[] {
  return argv.flatMap((a, i) => (argv[i - 1] === "-e" && a.startsWith("RMD_INSTANCE_NAME=") ? [a.slice("RMD_INSTANCE_NAME=".length)] : []));
}

test("W1-T9500: the recycle names the instance to the container it runs", (t) => {
  const named = recycle(t, { instance: "core" });
  assert.equal(named.status, 0, named.output);
  assert.ok(named.runArgv, `a replacement docker run must have happened:\n${named.output}`);
  assert.deepEqual(instanceNameArgs(named.runArgv), ["core"], "the container is told which instance it is");
  // The image and its command come after every option, so the variable is an option, not an argument.
  assert.ok(named.runArgv.indexOf("RMD_INSTANCE_NAME=core") < named.runArgv.indexOf("./bin/rmd"));
  // The legacy no-instance path names nothing: it has no instance to name.
  const legacy = recycle(t, {});
  assert.equal(legacy.status, 0, legacy.output);
  assert.ok(legacy.runArgv, `a replacement docker run must have happened:\n${legacy.output}`);
  assert.deepEqual(instanceNameArgs(legacy.runArgv), []);
});

test("W1-T9500: a container that carries its instance name is recycled again", (t) => {
  // The NEXT recycle meets the variable this one set. It is the recycle's own, re-derived from
  // --instance, so the undeclared-runtime-variable refusal (W1-T1069) must not stop it.
  const again = recycle(t, { instance: "core", containerEnv: "RMD_INSTANCE_NAME=core" });
  assert.equal(again.status, 0, again.output);
  assert.doesNotMatch(again.output, /carries a runtime variable this recycle does not declare/);
  assert.deepEqual(instanceNameArgs(again.runArgv ?? []), ["core"], "named once, from --instance — never captured and doubled");
  // Control: the refusal still fires for a name nobody declared.
  const foreign = recycle(t, { instance: "core", containerEnv: "RMD_SOMETHING_UNDECLARED=1" });
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.output, /carries a runtime variable this recycle does not declare: RMD_SOMETHING_UNDECLARED/);
});

// ── the creator names the instance: deploy/install-host-units.sh's launcher ─────────────────────

/** The `INSTANCE_ENV_ARGS` a rendered launcher would pass to `docker run`, evaluated by bash. */
function launcherInstanceArgs(launcher: string): string[] {
  const line = launcher.split("\n").find((l) => l.startsWith("INSTANCE_ENV_ARGS=("));
  assert.ok(line, "the launcher must declare INSTANCE_ENV_ARGS");
  const r = spawnSync("bash", ["-c", `${line}\nprintf '%s\\n' "\${INSTANCE_ENV_ARGS[@]+"\${INSTANCE_ENV_ARGS[@]}"}"`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean);
}

test("W1-T9500: the installed launcher names the instance to the container it runs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t9500-units-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const meminfo = join(root, "meminfo");
  writeFileSync(meminfo, "MemTotal:       16371996 kB\n");
  const registry = join(root, "daemon-instances.yaml");
  writeFileSync(registry, [
    "  core:",
    "    repo: remudero",
    "    state_dir: /srv/remudero-core",
    "    container_name: remudero-daemon",
    "    service_user: test-user",
    "    image: example.invalid/remudero:test",
    "    max_old_space_mb: 8192",
    "    service_name: remudero-core.service",
    "    watchdog_service_name: remudero-core-watchdog.service",
    "    watchdog_timer_name: remudero-core-watchdog.timer",
    `    launcher_path: ${join(root, "core-launcher.sh")}`,
    `    revival_log: ${join(root, "core-revivals.log")}`,
    "    gh_app_id: 1",
    "    gh_app_installation_id: 2",
    "    gh_app_private_key_path: /etc/remudero/key.pem",
    "    claude_dir: /var/lib/remudero/claude",
    "    codex_dir: /var/lib/remudero/codex",
    "    container_config_dir: /etc/remudero",
    "",
  ].join("\n"));
  const install = (args: string[], env: Record<string, string>) =>
    spawnSync("bash", [INSTALLER, "--install", ...args], {
      encoding: "utf8",
      env: { ...process.env, RMD_SERVICE_UID: "42424", RMD_MEMINFO_PATH: meminfo, ...env },
    });
  const named = install(["--instance", "core"], {
    RMD_INSTANCE_REGISTRY: registry,
    RMD_UNIT_DIR: join(root, "systemd-core"),
    RMD_BIN_DIR: join(root, "bin-core"),
  });
  assert.equal(named.status, 0, named.stderr);
  const launcher = readFileSync(join(root, "core-launcher.sh"), "utf8");
  assert.deepEqual(launcherInstanceArgs(launcher), ["-e", "RMD_INSTANCE_NAME=core"]);
  const run = launcher.slice(launcher.indexOf("docker run -d --name"));
  assert.ok(run.indexOf('"${INSTANCE_ENV_ARGS[@]+"${INSTANCE_ENV_ARGS[@]}"}"') > 0, "the docker run must pass INSTANCE_ENV_ARGS");
  assert.ok(run.indexOf("INSTANCE_ENV_ARGS") < run.indexOf("./bin/rmd daemon"), "as an option, before the image");
  // The legacy no-instance install names nothing.
  const legacyLauncher = join(root, "legacy-launcher.sh");
  const legacy = install([], {
    RMD_UNIT_DIR: join(root, "systemd-legacy"),
    RMD_BIN_DIR: join(root, "bin-legacy"),
    RMD_LAUNCHER_PATH: legacyLauncher,
    RMD_REVIVAL_LOG: join(root, "legacy-revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
  });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.deepEqual(launcherInstanceArgs(readFileSync(legacyLauncher, "utf8")), []);
});
