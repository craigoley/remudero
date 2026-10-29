import { legacyHostScript, withoutRegistrySelection } from "#test/helpers/legacy-host-launch.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NAME = "RMD_CASH_EASTUS_API_KEY";
const KEY = "fixture-eastus-key-a91f3";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-eastus-"));
  const state = join(root, "state-root");
  const secrets = join(root, "secrets");
  const bin = join(root, "bin");
  const launcher = join(root, "relaunch.sh");
  const secret = join(secrets, "cash-eastus-api-key");
  const argvFile = join(root, "argv");
  const envFile = join(root, "env");
  const config = join(root, "config");
  for (const dir of [join(state, "state"), secrets, bin, config, join(root, "claude")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(state, "state", "ledger.ndjson"), "{}\n");
  writeFileSync(secret, `${KEY}\n`, { mode: 0o600 });
  writeFileSync(join(secrets, "openweight-api-key"), "fixture-primary-cash-key\n", { mode: 0o600 });
  writeFileSync(join(config, "config.json"), JSON.stringify({
    workerProviders: { enabled: ["cash"], cashFallbackWhenBlocked: true },
  }));
  writeFileSync(join(root, "target"), `${KEY}\n`, { mode: 0o600 });
  writeFileSync(join(bin, "findmnt"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "az"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
case "$1" in
  ps) exit 0 ;;
  image) case "$*" in *Config.Env*) echo 'PATH=/usr/bin' ;; *) echo sha256:FIXTURE ;; esac; exit 0 ;;
  inspect)
    case "$*" in
      *Mounts*) printf '%s\\t/home/node/Remudero\\ttrue\\n' "$RMD_STATE_DIR"; printf '%s\\t/home/node/.claude\\ttrue\\n' "$RMD_CLAUDE_DIR"; printf '%s\\t/home/node/.config/remudero\\ttrue\\n' "$RMD_CONTAINER_CONFIG_DIR" ;;
      *Config.Env*) echo 'PATH=/usr/bin'; echo 'GH_TOKEN=fixture-token'; [ -z "$FIXTURE_CONTAINER_KEY" ] || printf '${NAME}=%s\\n' "$FIXTURE_CONTAINER_KEY" ;;
      *Config.Image*) echo fixture/old ;;
      *) echo sha256:FIXTURE ;;
    esac; exit 0 ;;
  run)
    printf '%s\\n' "$@" > "$FIXTURE_ARGV"
    printf '%s' "\${RMD_CASH_EASTUS_API_KEY:-}" > "$FIXTURE_ENV"
    exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...withoutRegistrySelection(process.env),
    HOME: root,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RMD_STATE_DIR: state,
    RMD_CLAUDE_DIR: join(root, "claude"),
    RMD_CODEX_DIR: join(root, "absent-codex"),
    RMD_CONTAINER_CONFIG_DIR: config,
    RMD_UNIT_DIR: join(root, "units"),
    RMD_BIN_DIR: join(root, "generated-bin"),
    RMD_LAUNCHER_PATH: launcher,
    RMD_REVIVAL_LOG: join(root, "revivals"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: secrets,
    RMD_CASH_EASTUS_API_KEY_PATH: secret,
    RMD_OPENWEIGHT_API_KEY_PATH: join(secrets, "openweight-api-key"),
    RMD_CASH_EASTUS_API_KEY: "",
    RMD_OPENWEIGHT_API_KEY: "",
    RMD_FOUNDRY_CLAUDE_API_KEY: "",
    RMD_FOUNDRY_CLAUDE_ENDPOINT: "",
    RMD_RECYCLE_FIRST_BOOT: "1",
    RMD_RECYCLE_DOCKERENV_PATH: join(root, "absent-dockerenv"),
    RMD_RECYCLE_HOST_LOCK: join(root, "recycle.lock"),
    RMD_RECYCLE_WAIT_S: "1",
    RMD_RECYCLE_POLL_S: "1",
    GH_TOKEN: "fixture-token",
    GH_APP_ID: "",
    GH_APP_INSTALLATION_ID: "",
    GH_APP_PRIVATE_KEY_PATH: "",
    FIXTURE_CONTAINER_KEY: "",
    FIXTURE_ARGV: argvFile,
    FIXTURE_ENV: envFile,
  };
  function run(script: string, args: string[] = []) {
    const result = spawnSync("bash", [script.startsWith("deploy/") ? legacyHostScript(root, script) : script, ...args], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    return result.stdout + result.stderr;
  }
  return {
    root, secret, env, launcher, run,
    boot: () => run(launcher, ["--boot"]),
    install: () => run("deploy/install-host-units.sh", ["--install"]),
    recycle: () => run("deploy/recycle-container.sh"),
    value: () => readFileSync(envFile, "utf8"),
    argv: () => readFileSync(argvFile, "utf8"),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("W1-T10838: the boot launcher reads the eastus cash key from its durable secret", () => {
  const f = fixture();
  try {
    f.install();
    f.boot();
    assert.equal(f.value(), KEY);
    assert.equal(f.argv().includes(KEY), false);
    writeFileSync(f.secret, `${KEY}\r\n`);
    f.boot();
    assert.equal(f.value(), KEY);
    f.env[NAME] = "fixture-shell-key";
    f.boot();
    assert.equal(f.value(), "fixture-shell-key");
    f.env[NAME] = "";
    for (const unsafe of ["missing", "mode", "multiline", "empty", "symlink"]) {
      rmSync(f.secret, { force: true });
      if (unsafe === "symlink") symlinkSync(join(f.root, "target"), f.secret);
      else if (unsafe !== "missing") writeFileSync(f.secret, unsafe === "empty" ? "" : unsafe === "multiline" ? `${KEY}\nsecond\n` : `${KEY}\n`, { mode: unsafe === "mode" ? 0o644 : 0o600 });
      const output = f.boot();
      assert.equal(f.value(), "", unsafe);
      assert.match(output, /eastus cash key unavailable; that deployment stays unavailable/);
    }
  } finally { f.clean(); }
});

test("W1-T10838: a recycle carries the eastus key from its durable secret and an absent one refuses nothing", () => {
  const f = fixture();
  try {
    const output = f.recycle();
    assert.equal(f.value(), KEY);
    assert.equal(f.argv().includes(KEY), false);
    assert.match(output, /RMD_CASH_EASTUS_API_KEY.*durable-host-secret/);
    f.env.FIXTURE_CONTAINER_KEY = "fixture-container-key";
    f.recycle();
    assert.equal(f.value(), "fixture-container-key");
    f.env.FIXTURE_CONTAINER_KEY = "";
    for (const unsafe of ["missing", "mode", "multiline", "empty", "symlink"]) {
      rmSync(f.secret, { force: true });
      if (unsafe === "symlink") symlinkSync(join(f.root, "target"), f.secret);
      else if (unsafe !== "missing") writeFileSync(f.secret, unsafe === "empty" ? "" : unsafe === "multiline" ? `${KEY}\nsecond\n` : `${KEY}\n`, { mode: unsafe === "mode" ? 0o644 : 0o600 });
      f.recycle();
      assert.equal(f.value(), "", unsafe);
    }
  } finally { f.clean(); }
});

test("the eastus runtime lists contain only names and recycle uses the default durable path", () => {
  const lists = ["deploy/runtime-env-vars.sh", "deploy/recycle-container.sh", "deploy/host-update.sh"].map((path) => {
    const source = readFileSync(join(REPO_ROOT, path), "utf8");
    const array = source.match(/RMD_DAEMON_RUNTIME_ENV_VARS=\(([^)]*)\)/);
    assert.ok(array, path);
    const names = array[1].trim().split(/\s+/);
    assert.ok(names.includes(NAME), path);
    assert.ok(names.every((name) => /^[A-Z_][A-Z_0-9]*$/.test(name)), path);
    return names.sort();
  });
  assert.deepEqual(lists[1], lists[0]);
  assert.deepEqual(lists[2], lists[0]);
  const f = fixture();
  try {
    f.env.RMD_CASH_EASTUS_API_KEY_PATH = undefined;
    const directory = join(f.root, ".local/share/remudero/secrets");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "cash-eastus-api-key"), `${KEY}\r\n`, { mode: 0o600 });
    f.recycle();
    assert.equal(f.value(), KEY);
    f.env[NAME] = "fixture-shell-key";
    f.recycle();
    assert.equal(f.value(), "fixture-shell-key");
  } finally { f.clean(); }
});

test("W1-T10838: the eastus key value never reaches argv, a unit file or output", () => {
  const f = fixture();
  try {
    f.env[NAME] = KEY;
    let output = f.install() + f.boot();
    assert.match(f.argv(), /-e\nRMD_CASH_EASTUS_API_KEY\n/);
    assert.equal(f.argv().includes(KEY), false);
    for (const name of readdirSync(join(f.root, "units"))) {
      assert.equal(readFileSync(join(f.root, "units", name), "utf8").includes(KEY), false);
    }
    assert.equal(readFileSync(f.launcher, "utf8").includes(KEY), false);
    output += f.recycle();
    assert.equal(f.value(), KEY);
    assert.match(f.argv(), /-e\nRMD_CASH_EASTUS_API_KEY\n/);
    assert.equal(f.argv().includes(KEY), false);
    const printed = f.run("deploy/host-update.sh", ["--print-daemon-run"]);
    assert.match(printed, /-e RMD_CASH_EASTUS_API_KEY(?:\s|$)/);
    assert.equal((output + printed).includes(KEY), false);
  } finally { f.clean(); }
});
