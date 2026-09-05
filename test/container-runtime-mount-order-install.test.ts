import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// W1-T2856: docker.service AND containerd.service must both wait for their own runtime roots,
// and docker.service must also wait for the explicit Remudero state bind mount, before either
// service starts — see the script's own header for the Azure incident this closes, and
// plan/tasks.d/W1-T2856-docker-can-start-before-the-state-bind-mount.yaml for the acceptance
// criteria this file proves.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "install-container-runtime-mount-order.sh");
const OPERATOR_GUIDE = join(REPO_ROOT, "docs", "operator-guide.md");
const BASH_BIN = ["/opt/homebrew/opt/bash/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find(existsSync) ?? "bash";

const DOCKER_ROOT = "/mnt/rmd/docker";
const CONTAINERD_ROOT = "/var/lib/containerd";
const DATA_MOUNT = "/mnt/rmd";
const DROPIN_FILENAME = "20-remudero-mount-order.conf";

interface ScriptRun {
  status: number;
  output: string;
  dockerCalls: string[][];
  systemctlCalls: string[][];
}

interface Fixture {
  fixtureDir: string;
  binDir: string;
  dockerDropinDir: string;
  containerdDropinDir: string;
  mountsFile: string;
  stateDir: string;
  dockerCallsFile: string;
  systemctlCallsFile: string;
}

/** Writes stub `docker`, `systemctl` and `id` binaries onto a fixture PATH. `id -u` answers "0"
 * (root) so `--install` can be exercised without real privilege; `docker info --format ...`
 * answers DOCKER_ROOT; `systemctl show <service> --property=RequiresMountsFor` answers the UNION
 * of every `*.conf` file's `RequiresMountsFor=` row under that service's fixture drop-in
 * directory — the same accumulation real systemd performs across a unit's drop-ins — and
 * `daemon-reload` just records that it ran. Any other systemctl verb (start/stop/restart/reload
 * a service) is refused loudly so an accidental lifecycle call fails the test instead of passing
 * quietly. */
function makeFixture(): Fixture {
  const fixtureDir = mkdtempSync(join(tmpdir(), "rmd-container-runtime-mount-order-"));
  const binDir = join(fixtureDir, "bin");
  const dockerDropinDir = join(fixtureDir, "docker.service.d");
  const containerdDropinDir = join(fixtureDir, "containerd.service.d");
  const mountsFile = join(fixtureDir, "mounts");
  const stateDir = join(fixtureDir, "state-volume");
  const dockerCallsFile = join(fixtureDir, "docker-calls.tsv");
  const systemctlCallsFile = join(fixtureDir, "systemctl-calls.tsv");
  mkdirSync(binDir);
  mkdirSync(dockerDropinDir);
  mkdirSync(containerdDropinDir);
  mkdirSync(stateDir);
  writeFileSync(dockerCallsFile, "");
  writeFileSync(systemctlCallsFile, "");
  // The fstab shape docs/operator-guide.md documents: a top-level data-disk mount, a bind mount
  // of a subdirectory of it onto /var/lib/containerd, and the Remudero state bind mount.
  writeFileSync(
    mountsFile,
    [
      "tmpfs /some/unrelated/path tmpfs rw 0 0",
      `/dev/sdb1 ${DATA_MOUNT} ext4 rw 0 0`,
      `${DATA_MOUNT}/containerd ${CONTAINERD_ROOT} none rw,bind 0 0`,
      `none ${stateDir} ext4 rw 0 0`,
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(binDir, "id"),
    ["#!/usr/bin/env bash", 'if [ "$1" = "-u" ]; then echo 0; exit 0; fi', "exit 1", ""].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "docker"),
    [
      "#!/usr/bin/env bash",
      'printf "docker" >> "$RMD_TEST_DOCKER_CALLS"',
      'for arg in "$@"; do printf "\\t%s" "$arg" >> "$RMD_TEST_DOCKER_CALLS"; done',
      'printf "\\n" >> "$RMD_TEST_DOCKER_CALLS"',
      'if [ "$1" = "info" ] && [ "$2" = "--format" ]; then printf "%s\\n" "$RMD_TEST_DOCKER_ROOT"; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "systemctl"),
    [
      "#!/usr/bin/env bash",
      'printf "systemctl" >> "$RMD_TEST_SYSTEMCTL_CALLS"',
      'for arg in "$@"; do printf "\\t%s" "$arg" >> "$RMD_TEST_SYSTEMCTL_CALLS"; done',
      'printf "\\n" >> "$RMD_TEST_SYSTEMCTL_CALLS"',
      'case "$1" in',
      "  daemon-reload) exit 0 ;;",
      "  show)",
      '    unit="$2"',
      '    prop="${3#--property=}"',
      "    case \"$unit\" in",
      '      docker.service) dir="$RMD_TEST_DOCKER_DROPIN_DIR" ;;',
      '      containerd.service) dir="$RMD_TEST_CONTAINERD_DROPIN_DIR" ;;',
      "      *) exit 1 ;;",
      "    esac",
      '    if [ "$prop" != "RequiresMountsFor" ]; then printf "%s=\\n" "$prop"; exit 0; fi',
      '    paths=""',
      "    shopt -s nullglob",
      '    for f in "$dir"/*.conf; do',
      "      line=\"$(grep -m1 '^RequiresMountsFor=' \"$f\" || true)\"",
      '      if [ -n "$line" ]; then paths="$paths ${line#RequiresMountsFor=}"; fi',
      "    done",
      '    printf "RequiresMountsFor=%s\\n" "$(echo "$paths" | xargs)"',
      "    exit 0",
      "    ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  for (const bin of ["id", "docker", "systemctl"]) chmodSync(join(binDir, bin), 0o755);

  return {
    fixtureDir,
    binDir,
    dockerDropinDir,
    containerdDropinDir,
    mountsFile,
    stateDir,
    dockerCallsFile,
    systemctlCallsFile,
  };
}

function parseCalls(recordFile: string): string[][] {
  return readFileSync(recordFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function run(fx: Fixture, args: string[], env: Record<string, string | undefined> = {}): ScriptRun {
  const result = spawnSync(BASH_BIN, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fx.binDir}:${process.env.PATH ?? ""}`,
      RMD_TEST_DOCKER_CALLS: fx.dockerCallsFile,
      RMD_TEST_SYSTEMCTL_CALLS: fx.systemctlCallsFile,
      RMD_TEST_DOCKER_ROOT: DOCKER_ROOT,
      RMD_TEST_DOCKER_DROPIN_DIR: fx.dockerDropinDir,
      RMD_TEST_CONTAINERD_DROPIN_DIR: fx.containerdDropinDir,
      RMD_DOCKER_DROPIN_DIR: fx.dockerDropinDir,
      RMD_CONTAINERD_DROPIN_DIR: fx.containerdDropinDir,
      RMD_PROC_MOUNTS_FILE: fx.mountsFile,
      RMD_STATE_DIR: fx.stateDir,
      ...env,
    },
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    dockerCalls: parseCalls(fx.dockerCallsFile),
    systemctlCalls: parseCalls(fx.systemctlCallsFile),
  };
}

function dockerDropinPath(fx: Fixture): string {
  return join(fx.dockerDropinDir, DROPIN_FILENAME);
}
function containerdDropinPath(fx: Fixture): string {
  return join(fx.containerdDropinDir, DROPIN_FILENAME);
}

test("W1-T2856: the rendered containerd and Docker drop-ins require their runtime roots, and Docker also requires RMD_STATE_DIR", () => {
  const fx = makeFixture();
  const install = run(fx, ["--install"]);
  assert.equal(install.status, 0, install.output);

  const containerdContent = readFileSync(containerdDropinPath(fx), "utf8");
  const containerdLine = containerdContent.split("\n").find((l) => l.startsWith("RequiresMountsFor="));
  assert.ok(containerdLine, `no RequiresMountsFor row in containerd drop-in:\n${containerdContent}`);
  const containerdPaths = containerdLine!.slice("RequiresMountsFor=".length).trim().split(/\s+/);
  assert.deepEqual(new Set(containerdPaths), new Set([DATA_MOUNT, CONTAINERD_ROOT]));
  assert.doesNotMatch(containerdContent, new RegExp(fx.stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "containerd never requires the Remudero state mount");

  const dockerContent = readFileSync(dockerDropinPath(fx), "utf8");
  const dockerLine = dockerContent.split("\n").find((l) => l.startsWith("RequiresMountsFor="));
  assert.ok(dockerLine, `no RequiresMountsFor row in docker drop-in:\n${dockerContent}`);
  const dockerPaths = dockerLine!.slice("RequiresMountsFor=".length).trim().split(/\s+/);
  assert.deepEqual(new Set(dockerPaths), new Set([DOCKER_ROOT, CONTAINERD_ROOT, fx.stateDir]));
});

test("W1-T2856: check mode refuses a partial installation, names the service and missing state mount, and writes/reloads nothing", () => {
  const fx = makeFixture();
  // The real Azure shape: containerd's emergency drop-in already satisfies containerd's own
  // requirement (data mount + its own root); docker's emergency drop-in is missing the state dir.
  writeFileSync(
    join(fx.containerdDropinDir, "10-wait-for-data-disk.conf"),
    `[Unit]\nRequiresMountsFor=${DATA_MOUNT} ${CONTAINERD_ROOT}\n`,
  );
  writeFileSync(
    join(fx.dockerDropinDir, "10-wait-for-data-disk.conf"),
    `[Unit]\nRequiresMountsFor=${DOCKER_ROOT} ${CONTAINERD_ROOT}\n`,
  );

  const check = run(fx, []);
  assert.notEqual(check.status, 0, check.output);
  assert.match(check.output, /MISSING/);
  assert.match(check.output, /docker\.service/);
  assert.ok(check.output.includes(fx.stateDir), `missing-state message did not name ${fx.stateDir}:\n${check.output}`);
  assert.doesNotMatch(check.output, /MISSING from containerd\.service/, "containerd's own requirement was already satisfied");
  assert.ok(!existsSync(dockerDropinPath(fx)), "check mode must not write the repository-owned docker drop-in");
  assert.ok(!existsSync(containerdDropinPath(fx)), "check mode must not write the repository-owned containerd drop-in");
  assert.equal(readdirSync(fx.dockerDropinDir).length, 1, "check mode must not create or remove any docker drop-in file");
  assert.equal(readdirSync(fx.containerdDropinDir).length, 1, "check mode must not create or remove any containerd drop-in file");
  assert.equal(
    check.systemctlCalls.some((call) => call[1] === "daemon-reload"),
    false,
    "check mode must never reload systemd",
  );

  // The other half of the claim: only one service has ANY repository drop-in at all.
  const fxSolo = makeFixture();
  const soloCheck = run(fxSolo, []);
  assert.notEqual(soloCheck.status, 0, soloCheck.output);
  assert.match(soloCheck.output, /MISSING from containerd\.service/);
  assert.match(soloCheck.output, /MISSING from docker\.service/);
});

test("W1-T2856: install mode writes both drop-ins atomically, reloads systemd once, and proves both effective dependency sets after the write", () => {
  const fx = makeFixture();
  const install = run(fx, ["--install"]);
  assert.equal(install.status, 0, install.output);

  assert.ok(existsSync(dockerDropinPath(fx)), "install must write the repository-owned docker drop-in");
  assert.ok(existsSync(containerdDropinPath(fx)), "install must write the repository-owned containerd drop-in");
  const leftoverTemp = [...readdirSync(fx.dockerDropinDir), ...readdirSync(fx.containerdDropinDir)].filter((name) => name.startsWith("."));
  assert.deepEqual(leftoverTemp, [], "an atomic write leaves no temp file behind in either directory");

  const reloadCalls = install.systemctlCalls.filter((call) => call[1] === "daemon-reload");
  assert.equal(reloadCalls.length, 1, `expected exactly one daemon-reload call; calls:\n${JSON.stringify(install.systemctlCalls)}`);
  const reloadIndex = install.systemctlCalls.indexOf(reloadCalls[0]);

  const showsAfterReload = install.systemctlCalls.slice(reloadIndex + 1).filter((call) => call[1] === "show" && call.includes("--property=RequiresMountsFor"));
  const unitsChecked = new Set(showsAfterReload.map((call) => call[2]));
  assert.ok(unitsChecked.has("docker.service"), "install must re-check docker.service AFTER daemon-reload");
  assert.ok(unitsChecked.has("containerd.service"), "install must re-check containerd.service AFTER daemon-reload");
  assert.match(install.output, /docker\.service effective RequiresMountsFor covers all required paths/);
  assert.match(install.output, /containerd\.service effective RequiresMountsFor covers all required paths/);
});

test("W1-T2856: installation never starts, stops, restarts or reloads Docker or containerd, and never runs a container lifecycle command", () => {
  const fx = makeFixture();
  const install = run(fx, ["--install"]);
  assert.equal(install.status, 0, install.output);

  const dockerVerbs = install.dockerCalls.map((call) => call[1]);
  assert.deepEqual(dockerVerbs, ["info"], `expected the only docker call to be read-only info; got ${JSON.stringify(dockerVerbs)}`);

  const systemctlVerbs = install.systemctlCalls.map((call) => call[1]);
  for (const verb of systemctlVerbs) {
    assert.ok(
      verb === "show" || verb === "daemon-reload",
      `unexpected systemctl verb '${verb}' — installation must never start/stop/restart/reload docker.service or containerd.service`,
    );
  }
  assert.doesNotMatch(install.output, /docker (?:start|stop|restart|run|rm|kill)\b/);
  assert.doesNotMatch(install.output, /\b(?:ctr|nerdctl)\b/);
});

test("W1-T2856: an unset, relative, absent or unmounted RMD_STATE_DIR is refused before the host is changed", () => {
  const cases: Array<{ name: string; env: Record<string, string | undefined> }> = [
    { name: "unset", env: { RMD_STATE_DIR: undefined } },
    { name: "relative", env: { RMD_STATE_DIR: "relative/state" } },
    { name: "absent", env: {} },
    { name: "unmounted", env: {} },
  ];

  for (const c of cases) {
    const fx = makeFixture();
    let env = { ...c.env };
    if (c.name === "absent") {
      env = { ...env, RMD_STATE_DIR: join(fx.fixtureDir, "does-not-exist") };
    } else if (c.name === "unmounted") {
      // exists on disk, but is deliberately absent from the fixture's /proc/mounts.
      writeFileSync(fx.mountsFile, `tmpfs /some/unrelated/path tmpfs rw 0 0\n/dev/sdb1 ${DATA_MOUNT} ext4 rw 0 0\n${DATA_MOUNT}/containerd ${CONTAINERD_ROOT} none rw,bind 0 0\n`);
    }

    const result = run(fx, ["--install"], env);
    assert.notEqual(result.status, 0, `case '${c.name}' unexpectedly succeeded:\n${result.output}`);
    assert.ok(!existsSync(dockerDropinPath(fx)), `case '${c.name}' must not write the docker drop-in`);
    assert.ok(!existsSync(containerdDropinPath(fx)), `case '${c.name}' must not write the containerd drop-in`);
    assert.equal(result.dockerCalls.length, 0, `case '${c.name}' must not touch Docker at all`);
    assert.equal(
      result.systemctlCalls.some((call) => call[1] === "daemon-reload"),
      false,
      `case '${c.name}' must not reload systemd`,
    );
  }
});

test("W1-T2856: the operator guide records commissioning and post-install evidence without claiming the host lifecycle was exercised", () => {
  const guide = readFileSync(OPERATOR_GUIDE, "utf8");
  const start = guide.indexOf("### Container runtime mount ordering");
  const end = guide.indexOf("\n### ", start + 4);
  assert.ok(start >= 0, "the container runtime mount ordering commissioning section must be present");
  const section = guide.slice(start, end >= 0 ? end : undefined);

  assert.match(section, /RMD_STATE_DIR/);
  assert.match(section, /install-container-runtime-mount-order\.sh --install/);
  assert.match(section, /containerd\.service/);
  assert.match(section, /docker\.service/);
  assert.match(section, /RequiresMountsFor/);
  assert.match(section, /--property=Requires/);
  assert.match(section, /--property=After/);
  assert.match(section, /deliberate/i);
  assert.match(section, /does not take that reboot/);
  assert.match(section, /does not claim the host'?s Docker,\s*containerd,\s*or\s+container\s+lifecycle was exercised/);
  assert.doesNotMatch(section, /docker (?:start|stop|restart)\b/);
});

test("W1-T2856 (mutation): removing the state-directory dependency reproduces the partial-drop-in failure that remains on the Azure host", () => {
  const fx = makeFixture();
  const install = run(fx, ["--install"]);
  assert.equal(install.status, 0, install.output);

  const before = readFileSync(dockerDropinPath(fx), "utf8");
  assert.ok(before.includes(fx.stateDir), "precondition: the installed docker drop-in names the state directory");

  // MUTATE: strip the state directory back out of docker's effective dependency, reproducing
  // exactly the Azure host's live partial state (Docker + containerd roots only, containerd
  // service unaffected since it never required the state mount in the first place).
  const mutated = before.replace(new RegExp(` ${fx.stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), "");
  assert.notEqual(mutated, before, "mutation did not remove the state directory token");
  writeFileSync(dockerDropinPath(fx), mutated);

  const check = run(fx, []);
  assert.notEqual(check.status, 0, "the mutated (Azure-partial-shaped) drop-in must fail check mode");
  assert.match(check.output, /MISSING from docker\.service/);
  assert.ok(check.output.includes(fx.stateDir), `expected the missing-state message to name ${fx.stateDir}:\n${check.output}`);
  assert.doesNotMatch(check.output, /MISSING from containerd\.service/, "containerd's own requirement is unaffected by the mutation");
  assert.ok(!check.output.includes(`- docker.service: ${DOCKER_ROOT}\n`), "the Docker root must still be reported present, not missing");
});
