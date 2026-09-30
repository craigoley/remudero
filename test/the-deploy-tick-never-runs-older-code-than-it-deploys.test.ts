import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// The healthy-daemon tick runs deploy-run from the daemon tree ("$STATE_DIR/remudero/bin/rmd"), as it
// did before the install-checkout runtime experiment was reverted. The tick must not build a runtime
// in the install checkout (no npm ci) and must not ask that checkout's rmd to take the deploy.

const SCRIPT = "deploy/install-host-units.sh";

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

test("the generated watchdog runs deploy-run from the daemon tree, never the install checkout", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}deploy-tick-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const installLog = join(root, "install-deploy-run.log");
  const daemonLog = join(root, "daemon-deploy-run.log");
  const npmLog = join(root, "npm.log");

  const installBin = join(stateDir, "daemon-install", "bin");
  mkdirSync(installBin, { recursive: true });
  executable(join(installBin, "rmd"), `#!/usr/bin/env bash\necho "$@" >> "${installLog}"\nexit 0\n`);
  const daemonBin = join(stateDir, "remudero", "bin");
  mkdirSync(daemonBin, { recursive: true });
  executable(join(daemonBin, "rmd"), `#!/usr/bin/env bash\necho "$@" >> "${daemonLog}"\nexit 0\n`);

  const stubDir = join(root, "stubbin");
  mkdirSync(stubDir, { recursive: true });
  executable(join(stubDir, "docker"), `#!/usr/bin/env bash\nif [ "\${1:-}" = "ps" ]; then echo fake-container-id; fi\nexit 0\n`);
  executable(join(stubDir, "npm"), `#!/usr/bin/env bash\necho "$@" >> "${npmLog}"\nexit 0\n`);

  const renderRoot = join(root, "render");
  mkdirSync(renderRoot, { recursive: true });
  const rendered = spawnSync("bash", [SCRIPT, "--install"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_STATE_DIR: stateDir,
      RMD_UNIT_DIR: join(renderRoot, "systemd"),
      RMD_BIN_DIR: join(renderRoot, "bin"),
      RMD_LAUNCHER_PATH: join(renderRoot, "rmd-relaunch.sh"),
      RMD_REVIVAL_LOG: join(renderRoot, "revivals.log"),
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    },
  });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stderr}`);

  const tick = spawnSync("bash", [join(renderRoot, "rmd-relaunch.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
  });
  assert.equal(tick.status, 0, tick.stderr);
  assert.match(read(daemonLog), /deploy-run --image-drift-only/, "the daemon tree must take the deploy");
  assert.equal(read(installLog), "", "the install checkout's rmd must not be asked");
  assert.equal(read(npmLog), "", "the tick must not build a runtime in the install checkout");
});
