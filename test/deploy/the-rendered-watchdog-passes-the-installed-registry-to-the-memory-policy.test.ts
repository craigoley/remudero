/**
 * W1-T11130 criterion 3, the production wiring: the memory policy reads each peer's learned peak from
 * that peer's own state root, found through the instance registry. On the host that policy runs inside
 * the RENDERED watchdog (install-host-units.sh's launcher): the revival sources it, and the memory-high
 * tuner sources it on every tick. The launcher stores the installed registry as INSTANCE_REGISTRY, so
 * both must receive it as RMD_INSTANCE_REGISTRY, or they fall back to the checkout's own registry and
 * ignore a custom selection's peer roots (#16468 review, 2026-11-04).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const policySource = join(REPO_ROOT, "deploy", "resource-policy.sh");
const CONSOLE_PEAK_MIB = 9000;

/** A launcher installed from a custom registry whose console row names its own peer root. */
function watchdogFixture(t: TestContext) {
  const { dir } = ownedFixtureDir(t, "rendered-watchdog-registry");
  const state = join(dir, "state-root"), peer = join(dir, "console-root"), bin = join(dir, "bin"), stubs = join(dir, "stubs");
  const install = join(state, "daemon-install"), launcher = join(dir, "rmd-relaunch.sh");
  const argv = join(dir, "docker-run-argv"), meminfo = join(dir, "meminfo"), registry = join(dir, "custom-instances.yaml");
  for (const path of [join(state, "state"), join(peer, "state"), bin, stubs, join(install, "deploy")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(state, "state", "ledger.ndjson"), '{"step":"fixture.control"}\n');
  writeFileSync(meminfo, "MemTotal:       33554432 kB\n");
  // The console's learned peak lives ONLY under the peer root this custom registry names.
  writeFileSync(join(peer, "state", "memory-peak-remudero-console-daemon.json"),
    `{"container":"remudero-console-daemon","peak_mib":${CONSOLE_PEAK_MIB}}\n`);
  writeFileSync(registry, [
    "instances:",
    "  core:",
    "    container_name: remudero-daemon",
    `    state_dir: ${state}`,
    "    primary: true",
    "  console:",
    "    container_name: remudero-console-daemon",
    `    state_dir: ${peer}`,
    "",
  ].join("\n"));
  writeFileSync(join(stubs, "docker"), `#!/usr/bin/env bash
set -eu
case "$1" in
  ps) exit 0 ;;
  inspect) exit 1 ;;
  rm) exit 0 ;;
  run) printf '%s\\0' "$@" > "$FIXTURE_DOCKER_ARGV"; printf 'fixture-container\\n' ;;
  *) exit 97 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(stubs, "findmnt"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubs}:${process.env.PATH}`,
    RMD_STATE_DIR: state,
    RMD_DAEMON_CONTAINER: "remudero-daemon",
    RMD_UNIT_DIR: join(dir, "systemd"),
    RMD_BIN_DIR: bin,
    RMD_LAUNCHER_PATH: launcher,
    RMD_REVIVAL_LOG: join(dir, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_SERVICE_UID: "42424",
    RMD_MEMINFO_PATH: meminfo,
    RMD_CASH_SECRET_DIR: join(dir, "absent-secrets"),
    RMD_SCRATCH: "off",
    RMD_SCRATCH_CHECKOUTS: "off",
    RMD_SCRATCH_ROOT: join(dir, "absent-scratch"),
    RMD_MEMORY_HIGH_TUNED_DIR: undefined,
    FIXTURE_DOCKER_ARGV: argv,
  };
  const installed = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], {
    cwd: REPO_ROOT, env: { ...env, RMD_INSTANCE_REGISTRY: registry }, encoding: "utf8", timeout: 15_000, maxBuffer: 1 << 20,
  });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  copyFileSync(policySource, join(install, "deploy", "resource-policy.sh"));
  // The launcher itself runs WITHOUT RMD_INSTANCE_REGISTRY in its environment, as the systemd unit does.
  const launchEnv: NodeJS.ProcessEnv = { ...env, RMD_INSTANCE_REGISTRY: undefined };
  return { dir, state, install, launcher, registry, argv, env, launchEnv };
}

/** The real policy's --memory for a container, with or without the registry naming the peer roots. */
function policyMemory(env: NodeJS.ProcessEnv, container: string, registry: string | undefined): string | undefined {
  const result = spawnSync("bash", ["-c", '. "$1"; resource_policy_build_args "$2"; printf "%s\\n" "${RESOURCE_POLICY_BUILD_ARGS[@]}"', "fixture", policySource, container], {
    env: { ...env, RMD_INSTANCE_REGISTRY: registry ?? "" }, encoding: "utf8", timeout: 5_000, maxBuffer: 1 << 16,
  });
  assert.equal(result.status, 0, result.stderr);
  return /^--memory=\d+m$/m.exec(result.stdout)?.[0];
}

test("W1-T11130 criterion 3: the rendered watchdog's revival sizes memory.max from the installed registry's peer roots", (t) => {
  const f = watchdogFixture(t);
  const withRegistry = policyMemory(f.launchEnv, "remudero-daemon", f.registry);
  const without = policyMemory(f.launchEnv, "remudero-daemon", undefined);
  // Positive control: the custom peer root's 9000 MiB console peak really changes core's formula.
  assert.ok(withRegistry && without && withRegistry !== without, `the peer peak must move the formula: ${withRegistry} vs ${without}`);
  const revived = spawnSync("bash", [f.launcher, "--boot"], { env: f.launchEnv, encoding: "utf8", timeout: 20_000, maxBuffer: 1 << 20 });
  assert.equal(revived.status, 0, `${revived.stdout}\n${revived.stderr}`);
  const args = readFileSync(f.argv, "utf8").split("\0").filter(Boolean);
  assert.ok(args.includes(withRegistry!), `the revival reads the installed registry's peer roots: ${withRegistry} in ${args.filter((a) => a.startsWith("--memory")).join(" ")}`);
  // Nothing later in the launcher inherits the registry: it is restored after the one policy call.
  assert.match(readFileSync(f.launcher, "utf8"), /unset RMD_INSTANCE_REGISTRY/);
});

test("W1-T11130 criterion 3: the rendered watchdog hands the memory-high tuner the installed registry, never exporting it", (t) => {
  const f = watchdogFixture(t);
  const seen = join(f.dir, "tuner-saw");
  // The tuner's own stand-in records the registry its environment carries, for core and for serve.
  writeFileSync(join(f.install, "deploy", "memory-high-tuner.sh"),
    `#!/usr/bin/env bash\nprintf '%s %s\\n' "$2" "\${RMD_INSTANCE_REGISTRY-unset}" >> "${seen}"\n`, { mode: 0o755 });
  const launcher = readFileSync(f.launcher, "utf8");
  // The two rendered tuner lines, run with the rendered POLICY_ENV setup, exactly as the tick runs them.
  const setup = /^POLICY_ENV=\(\)\n.*$/m.exec(launcher)?.[0];
  const lines = launcher.split("\n");
  const tuner = lines.flatMap((line, i) => (line.includes("memory-high-tuner.sh\" \\") ? [line, lines[i + 1]!] : []));
  assert.ok(setup && tuner.length === 4, `the launcher renders POLICY_ENV and both tuner calls: ${tuner.length / 2}`);
  const script = [`INSTANCE_REGISTRY='${f.registry}'`, `CHECKOUT='${f.install}'`, `STATE_DIR='${f.state}'`, "MHT_TMO=()", setup,
    ...tuner].join("\n");
  const ran = spawnSync("bash", ["-euc", script], { env: f.launchEnv, encoding: "utf8", timeout: 10_000 });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(readFileSync(seen, "utf8").trim().split("\n"),
    [`remudero-daemon ${f.registry}`, `remudero-serve ${f.registry}`]);
  // A legacy install with no registry hands the tuner nothing, so its checkout default stands.
  writeFileSync(seen, "");
  const legacy = spawnSync("bash", ["-euc", script.replace(`INSTANCE_REGISTRY='${f.registry}'`, "INSTANCE_REGISTRY=''")],
    { env: f.launchEnv, encoding: "utf8", timeout: 10_000 });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.deepEqual(readFileSync(seen, "utf8").trim().split("\n"), ["remudero-daemon unset", "remudero-serve unset"]);
});
