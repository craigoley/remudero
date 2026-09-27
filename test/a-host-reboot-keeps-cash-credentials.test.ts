import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a systemd boot launcher restores cash credentials from host files without putting values in docker argv", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-boot-"));
  try {
    const state = join(root, "state-root");
    const secrets = join(root, "secrets");
    const bin = join(root, "stub-bin");
    const launcher = join(root, "rmd-relaunch.sh");
    const argvFile = join(root, "docker-argv");
    const envFile = join(root, "docker-env");
    for (const dir of [join(state, "state"), secrets, bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(state, "state", "ledger.ndjson"), "{}\n");
    const openweightKey = "test-only-openweight-key";
    const foundryKey = "test-only-foundry-key";
    const foundryEndpoint = "https://foundry.example.test/anthropic";
    for (const [name, value] of [
      ["openweight-api-key", openweightKey],
      ["foundry-claude-api-key", foundryKey],
      ["foundry-claude-endpoint", foundryEndpoint],
    ]) writeFileSync(join(secrets, name), `${value}\n`, { mode: 0o600 });
    writeFileSync(join(bin, "findmnt"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "docker"), [
      "#!/usr/bin/env bash",
      'case "$1" in',
      "  ps) exit 0 ;;",
      "  inspect) echo none; exit 0 ;;",
      "  rm) exit 0 ;;",
      "  run)",
      '    printf "%s\\n" "$@" > "$RMD_TEST_DOCKER_ARGV"',
      '    printf "openweight=%s\\nfoundry_key=%s\\nfoundry_endpoint=%s\\n" "${RMD_OPENWEIGHT_API_KEY:-}" "${RMD_FOUNDRY_CLAUDE_API_KEY:-}" "${RMD_FOUNDRY_CLAUDE_ENDPOINT:-}" > "$RMD_TEST_DOCKER_ENV"',
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
    delete env.RMD_OPENWEIGHT_API_KEY;
    delete env.RMD_FOUNDRY_CLAUDE_API_KEY;
    delete env.RMD_FOUNDRY_CLAUDE_ENDPOINT;
    const install = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], { encoding: "utf8", env });
    assert.equal(install.status, 0, install.stderr);
    const boot = spawnSync("bash", [launcher, "--boot"], { encoding: "utf8", env });
    assert.equal(boot.status, 0, boot.stderr);
    const argv = readFileSync(argvFile, "utf8");
    assert.match(argv, /-e\nRMD_OPENWEIGHT_API_KEY\n/);
    assert.match(argv, /-e\nRMD_FOUNDRY_CLAUDE_API_KEY\n/);
    assert.match(argv, /-e\nRMD_FOUNDRY_CLAUDE_ENDPOINT\n/);
    for (const value of [openweightKey, foundryKey, foundryEndpoint]) {
      assert.equal((argv + boot.stdout + boot.stderr).includes(value), false, "credential values must not enter argv or logs");
    }
    assert.equal(readFileSync(envFile, "utf8"), `openweight=${openweightKey}\nfoundry_key=${foundryKey}\nfoundry_endpoint=${foundryEndpoint}\n`);

    chmodSync(join(secrets, "openweight-api-key"), 0o644);
    const unsafe = spawnSync("bash", [launcher, "--boot"], { encoding: "utf8", env });
    assert.equal(unsafe.status, 0, "missing cash authority must leave subscription boot available");
    assert.match(unsafe.stderr, /cash API key unavailable/);
    assert.match(readFileSync(envFile, "utf8"), /^openweight=\n/m, "an unsafe key file must not reach docker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
