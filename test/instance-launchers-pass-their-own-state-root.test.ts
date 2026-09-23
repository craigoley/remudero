import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = "deploy/install-host-units.sh";

function instanceRecord(root: string, name: string, stateRoot: string): string {
  return [
    `  ${name}:`,
    "    repo: remudero",
    `    state_dir: ${stateRoot}`,
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
    "    claude_dir: /var/lib/remudero/claude",
    "    codex_dir: /var/lib/remudero/codex",
    "    container_config_dir: /etc/remudero",
  ].join("\n");
}

test("core, site and console launchers pass their own state root to deploy-run", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-instance-launchers-"));
  const registry = join(root, "daemon-instances.yaml");
  const instances = ["core", "site", "console"];
  writeFileSync(
    registry,
    instances.map((name) => instanceRecord(root, name, `/srv/remudero-${name}`)).join("\n") + "\n",
  );
  try {
    for (const name of instances) {
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
      const launcher = readFileSync(join(root, `${name}-launcher.sh`), "utf8");
      assert.ok(
        launcher.includes('deploy-run --image-drift-only --state-root "$STATE_DIR"'),
        `${name} must pass its registry state root to deploy-run`,
      );
      assert.ok(launcher.includes(`STATE_DIR=/srv/remudero-${name}`));
      // W1-T4267: the drift reader inspects THIS instance's container, named at install time.
      assert.ok(launcher.includes(`RMD_RESOURCE_POLICY_CONTAINER='remudero-${name}'`), `${name} must name its own container`);
      assert.ok(launcher.includes(`CHECKOUT=/srv/remudero-${name}/daemon-install`));
    }
    const roots = instances.map((name) => `/srv/remudero-${name}/daemon-install`);
    assert.equal(new Set(roots).size, instances.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
