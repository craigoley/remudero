import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = "deploy/install-host-units.sh";
const REAL_REGISTRY = ".remudero/daemon-instances.yaml";
const INSTANCES = ["core", "site", "console"];

function claudeDirOf(name: string): string {
  return name === "core" ? "/var/lib/remudero/claude" : `/var/lib/remudero/claude-${name}`;
}

function instanceRecord(root: string, name: string, claudeDir: string, primary: boolean): string {
  return [
    `  ${name}:`,
    "    repo: remudero",
    ...(primary ? ["    primary: true"] : []),
    `    state_dir: /srv/remudero-${name}`,
    `    container_name: remudero-${name}`,
    "    service_user: test-user",
    "    image: example.invalid/remudero:test",
    "    max_old_space_mb: 8192",
    `    service_name: remudero-${name}.service`,
    `    watchdog_service_name: remudero-${name}-watchdog.service`,
    `    watchdog_timer_name: remudero-${name}-watchdog.timer`,
    `    launcher_path: ${join(root, `${name}-launcher.sh`)}`,
    `    revival_log: ${join(root, `${name}-revivals.log`)}`,
    "    gh_app_id: 1",
    "    gh_app_installation_id: 2",
    "    gh_app_private_key_path: /etc/remudero/key.pem",
    `    claude_dir: ${claudeDir}`,
    "    codex_dir: /var/lib/remudero/codex",
    "    container_config_dir: /etc/remudero",
  ].join("\n");
}

/** Render every instance's launcher from a registry; returns launcher text by instance name. */
function renderLaunchers(claudeDir: (name: string) => string): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "rmd-credential-owner-"));
  const registry = join(root, "daemon-instances.yaml");
  writeFileSync(
    registry,
    INSTANCES.map((name) => instanceRecord(root, name, claudeDir(name), name === "core")).join("\n") + "\n",
  );
  try {
    const out: Record<string, string> = {};
    for (const name of INSTANCES) {
      const result = spawnSync("bash", [SCRIPT, "--install", "--instance", name], {
        encoding: "utf8",
        env: {
          ...process.env,
          RMD_INSTANCE_REGISTRY: registry,
          RMD_UNIT_DIR: join(root, "systemd", name),
          RMD_BIN_DIR: join(root, "bin", name),
        },
      });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      out[name] = readFileSync(join(root, `${name}-launcher.sh`), "utf8");
    }
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stateMountSource(launcher: string): string {
  const m = /-v (\S+):\/home\/node\/\.claude \\/.exec(launcher);
  assert.ok(m, "launcher must bind-mount a claude directory at /home/node/.claude");
  return m[1];
}

test("W1-T4863: each instance renders its own writable claude directory", () => {
  const launchers = renderLaunchers(claudeDirOf);
  const sources = INSTANCES.map((name) => stateMountSource(launchers[name]));
  assert.deepEqual(sources, INSTANCES.map(claudeDirOf));
  assert.equal(new Set(sources).size, INSTANCES.length, `two instances share one claude_dir: ${sources.join(", ")}`);
  for (const name of INSTANCES) {
    // the directory mount itself is never read-only: the instance writes transcripts and settings there
    assert.ok(!launchers[name].includes(`${stateMountSource(launchers[name])}:/home/node/.claude:ro`), `${name}`);
  }

  // The tracked registry must not name one directory twice either.
  const dirs = [...readFileSync(REAL_REGISTRY, "utf8").matchAll(/^ {4}claude_dir:\s*(\S+)/gm)].map((m) => m[1]);
  assert.equal(dirs.length, INSTANCES.length);
  assert.equal(new Set(dirs).size, dirs.length, `the tracked registry shares a claude_dir: ${dirs.join(", ")}`);
});

test("W1-T4863: the credential keeps one refresh owner across instances", () => {
  const launchers = renderLaunchers(claudeDirOf);
  const owner = claudeDirOf("core");
  for (const name of INSTANCES) {
    const credMounts = [...launchers[name].matchAll(/CREDENTIAL_ARGS=\(-v (\S+)\)/g)].map((m) => m[1]);
    if (name === "core") {
      // the owner's own directory already carries the one writable credential: nothing overlaid
      assert.deepEqual(credMounts, [], "the owner must not mount its credential read-only");
      continue;
    }
    // every other instance reads the owner's file, read-only, so it can never refresh the token
    assert.deepEqual(credMounts, [`${owner}/.credentials.json:/home/node/.claude/.credentials.json:ro`], name);
    assert.ok(launchers[name].includes('"${CREDENTIAL_ARGS[@]+"${CREDENTIAL_ARGS[@]}"}"'), `${name} must pass the mount to docker`);
    // a missing owner file is refused rather than letting docker create a directory in its place
    assert.ok(launchers[name].includes("the credential owner's file"), name);
  }
  // exactly one instance holds a writable credential: the registry's single primary row
  const writable = INSTANCES.filter((name) => !/CREDENTIAL_ARGS=\(-v/.test(launchers[name]));
  assert.deepEqual(writable, ["core"]);

  // the tracked registry has one primary and the others' directories differ from its
  const registry = readFileSync(REAL_REGISTRY, "utf8");
  assert.equal([...registry.matchAll(/^ {4}primary:\s*true/gm)].length, 1);
});
