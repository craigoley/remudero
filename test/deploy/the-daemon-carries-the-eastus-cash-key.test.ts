import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const KEY = "test-only-eastus-key-value";

/** Every captured artifact's text, so a leak anywhere is one assertion. */
function noLeak(label: string, ...texts: string[]): void {
  assert.equal(texts.join("\n").includes(KEY), false, `${label} must never carry the key value`);
}

test("W1-T10838: the boot launcher reads the eastus cash key from its durable secret", (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-eastus-boot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state-root");
  const secrets = join(root, "secrets");
  const bin = join(root, "stub-bin");
  const launcher = join(root, "rmd-relaunch.sh");
  const argvFile = join(root, "docker-argv");
  const envFile = join(root, "docker-env");
  for (const dir of [join(state, "state"), secrets, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(state, "state", "ledger.ndjson"), "{}\n");
  writeFileSync(join(secrets, "cash-eastus-api-key"), `${KEY}\n`, { mode: 0o600 });
  writeFileSync(join(bin, "findmnt"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "docker"), [
    "#!/usr/bin/env bash",
    'case "$1" in',
    "  ps) exit 0 ;;",
    "  inspect) echo none; exit 0 ;;",
    "  rm) exit 0 ;;",
    "  run)",
    '    printf "%s\\n" "$@" > "$RMD_TEST_DOCKER_ARGV"',
    '    printf "eastus=%s\\n" "${RMD_CASH_EASTUS_API_KEY:-}" > "$RMD_TEST_DOCKER_ENV"',
    "    exit 0 ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env,
    RMD_STATE_DIR: state,
    RMD_UNIT_DIR: join(root, "units"),
    RMD_BIN_DIR: join(root, "generated-bin"),
    RMD_LAUNCHER_PATH: launcher,
    RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: secrets,
    RMD_TEST_DOCKER_ARGV: argvFile,
    RMD_TEST_DOCKER_ENV: envFile,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  delete env.RMD_CASH_EASTUS_API_KEY;
  delete env.RMD_CASH_EASTUS_API_KEY_PATH;
  const install = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], { cwd: REPO_ROOT, encoding: "utf8", env });
  assert.equal(install.status, 0, install.stderr);
  noLeak("the installer output", install.stdout, install.stderr);
  const rendered = readFileSync(launcher, "utf8");
  assert.match(rendered, /cash-eastus-api-key/, "the launcher reads the durable secret by its file name");
  assert.match(rendered, /^ {2}-e RMD_CASH_EASTUS_API_KEY \\$/m, "docker receives the NAME only");
  noLeak("the rendered launcher", rendered);

  const boot = spawnSync("bash", [launcher, "--boot"], { encoding: "utf8", env });
  assert.equal(boot.status, 0, boot.stderr);
  assert.match(readFileSync(argvFile, "utf8"), /-e\nRMD_CASH_EASTUS_API_KEY\n/);
  assert.equal(readFileSync(envFile, "utf8"), `eastus=${KEY}\n`, "the key reaches docker through the launcher's environment");

  chmodSync(join(secrets, "cash-eastus-api-key"), 0o644);
  const unsafe = spawnSync("bash", [launcher, "--boot"], { encoding: "utf8", env });
  assert.equal(unsafe.status, 0, "an unsafe eastus key must never block boot");
  assert.match(unsafe.stderr, /eastus cash key unavailable; that deployment stays unavailable/);
  assert.equal(readFileSync(envFile, "utf8"), "eastus=\n", "an unsafe key file must not reach docker");

  rmSync(join(secrets, "cash-eastus-api-key"));
  const absent = spawnSync("bash", [launcher, "--boot"], { encoding: "utf8", env });
  assert.equal(absent.status, 0, "an absent eastus key must never block boot");
  assert.match(absent.stderr, /eastus cash key unavailable/);
});

const DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$REC/calls"
case "$1" in
  inspect)
    case "$*" in
      *Mounts*) printf '%s\t%s\ttrue\n' "$RMD_STATE_DIR" /home/node/Remudero
               printf '%s\t%s\ttrue\n' "$RMD_CLAUDE_DIR" /home/node/.claude ;;
      *Config.Image*) echo fixture/remudero:old ;;
      *Config.Env*) printf 'PATH=/usr/local/bin\nHOME=/home/node\nGH_TOKEN=fixture-token\n' ;;
      *Image*) echo sha256:PULLED ;;
    esac ;;
  image)
    if [ "$2" = inspect ]; then
      case "$*" in
        *Config.Env*) printf 'PATH=/usr/local/bin\nHOME=/home/node\n' ;;
        *) echo sha256:PULLED ;;
      esac
    fi ;;
  container)
    if [ "$2" = run ]; then
      printf 'eastus=%s\n' "$RMD_CASH_EASTUS_API_KEY" > "$REC/smoke-env"
      echo "WORKER-SMOKE PASS fixture"
      exit 0
    fi ;;
  run)
    printf 'eastus=%s\n' "$RMD_CASH_EASTUS_API_KEY" > "$REC/run-env" ;;
esac
exit 0
`;

function recycle(t: TestContext, keyFile: { mode: number } | null) {
  const root = mkdtempSync(join(tmpdir(), "rmd-eastus-recycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, "state-root");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(bin, "docker"), DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "cash-key"), "fixture-key\n");
  const eastusPath = join(root, "cash-eastus-api-key");
  if (keyFile) {
    writeFileSync(eastusPath, `${KEY}\n`);
    chmodSync(eastusPath, keyFile.mode);
  }
  const result = spawnSync("bash", [join(REPO_ROOT, "deploy/recycle-container.sh")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      REC: root,
      RMD_STATE_DIR: state,
      RMD_CLAUDE_DIR: join(root, "claude"),
      RMD_CODEX_DIR: join(root, "absent-codex"),
      RMD_CONTAINER_CONFIG_DIR: join(root, "absent-config"),
      RMD_DAEMON_CONTAINER: "fixture-daemon",
      RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_SKIP_RECLAIM: "1",
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_DOCKERENV_PATH: join(root, "absent-dockerenv"),
      RMD_OPENWEIGHT_API_KEY_PATH: join(root, "cash-key"),
      RMD_CASH_EASTUS_API_KEY_PATH: eastusPath,
      RMD_SCRATCH: "off",
      GH_TOKEN: "fixture-token",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_CASH_EASTUS_API_KEY: "",
    },
  });
  assert.ifError(result.error);
  const read = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "");
  return { result, calls: read("calls"), smokeEnv: read("smoke-env"), runEnv: read("run-env"), root };
}

test("W1-T10838: a recycle carries the eastus key from its durable secret and an absent one refuses nothing", (t: TestContext) => {
  const carried = recycle(t, { mode: 0o600 });
  assert.equal(carried.result.status, 0, carried.result.stderr);
  assert.equal(carried.smokeEnv, `eastus=${KEY}\n`, "the smoke container carries the durable key");
  assert.equal(carried.runEnv, `eastus=${KEY}\n`, "the replacement container carries the durable key");
  assert.match(carried.calls, /(^| )-e RMD_CASH_EASTUS_API_KEY( |$)/m, "docker receives the NAME only");
  assert.match(carried.result.stdout, /also carrying: .*RMD_CASH_EASTUS_API_KEY/, "reported by name");

  for (const [label, run] of [
    ["absent", recycle(t, null)],
    ["mode 0644", recycle(t, { mode: 0o644 })],
  ] as const) {
    assert.equal(run.result.status, 0, `${label}: refuses nothing — ${run.result.stderr}`);
    assert.match(run.result.stderr, /eastus cash key unavailable/, `${label}: names what is unavailable`);
    assert.equal(run.smokeEnv, "eastus=\n", `${label}: nothing carried`);
    assert.equal(run.runEnv, "eastus=\n", `${label}: nothing carried`);
  }
});

test("W1-T10838: the eastus key value never reaches argv, a unit file or output", (t: TestContext) => {
  const r = recycle(t, { mode: 0o600 });
  assert.equal(r.result.status, 0, r.result.stderr);
  noLeak("the docker argv log, the recycle stdout or stderr", r.calls, r.result.stdout, r.result.stderr);

  const printed = spawnSync("bash", [join(REPO_ROOT, "deploy/host-update.sh"), "--print-daemon-run"], {
    cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, RMD_CASH_EASTUS_API_KEY: KEY },
  });
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /RMD_CASH_EASTUS_API_KEY/, "the printed daemon run passes the name through");
  noLeak("the printed daemon run", printed.stdout, printed.stderr);

  const root = mkdtempSync(join(tmpdir(), "rmd-eastus-units-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secrets = join(root, "secrets");
  mkdirSync(join(root, "state", "state"), { recursive: true });
  mkdirSync(secrets);
  writeFileSync(join(secrets, "cash-eastus-api-key"), `${KEY}\n`, { mode: 0o600 });
  const install = spawnSync("bash", [join(REPO_ROOT, "deploy/install-host-units.sh"), "--install"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_STATE_DIR: join(root, "state"),
      RMD_UNIT_DIR: join(root, "units"),
      RMD_BIN_DIR: join(root, "generated-bin"),
      RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
      RMD_REVIVAL_LOG: join(root, "revivals.log"),
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
      RMD_CASH_SECRET_DIR: secrets,
      RMD_CASH_EASTUS_API_KEY: KEY,
    },
  });
  assert.equal(install.status, 0, install.stderr);
  noLeak("the installer output", install.stdout, install.stderr);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  for (const file of walk(root).filter((f) => !f.startsWith(secrets))) {
    noLeak(`rendered file ${file}`, readFileSync(file, "utf8"));
  }
});
