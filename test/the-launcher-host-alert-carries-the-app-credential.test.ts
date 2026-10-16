/**
 * W1-T9669: the launcher's host_alert runs `rmd host-alert` on the HOST, whose hostGithubToken needs
 * GH_APP_ID, GH_APP_INSTALLATION_ID and a host-readable GH_APP_PRIVATE_KEY_PATH. The launcher handed
 * those only to `docker run`, with a CONTAINER key path, so the direct post could never fire. These
 * cases render the real launcher, run its host_alert against a stub rmd that records its GH_*
 * environment, and pin the host-side key path. No key is read: the fixture key is a placeholder.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const CONTAINER_KEY = "/home/node/.claude/rmd-app.pem";

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-alert-cred-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The process env without any GitHub credential, so only what the launcher passes can reach the stub. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^(GH_|RMD_GH_|HOST_ALERT_)/.test(k)) delete env[k];
  return env;
}

/** Render the launcher with `extra` installer env, then run its host_alert and return the stub's GH_* env. */
function hostAlertEnv(t: TestContext, extra: (root: string) => Record<string, string>): { seen: Record<string, string>; launcher: string } {
  const root = scratch(t);
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    RMD_STATE_DIR: join(root, "state-root"),
    RMD_UNIT_DIR: join(root, "systemd"),
    RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
    RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
    RMD_CLAUDE_DIR: join(root, "claude"),
    ...extra(root),
  };
  const r = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], { encoding: "utf8", env });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  const launcher = readFileSync(join(root, "rmd-relaunch.sh"), "utf8");
  const assigns = launcher.match(/^HOST_ALERT_GH_[A-Z_]+=.*$/gm) ?? [];
  assert.equal(assigns.length, 3, "the launcher renders the three host_alert credential values");
  const fn = /^host_alert\(\) \{\n[\s\S]*?\n\}$/m.exec(launcher);
  assert.ok(fn, "the rendered launcher defines host_alert");

  const state = join(root, "host-state");
  mkdirSync(join(state, "remudero", "bin"), { recursive: true });
  const seenFile = join(root, "seen-env");
  writeFileSync(join(state, "remudero", "bin", "rmd"), `#!/usr/bin/env bash\nenv | grep '^GH_' > "$RMD_STUB_SEEN" || :\necho '{"tier":"escalated"}'\n`);
  chmodSync(join(state, "remudero", "bin", "rmd"), 0o755);
  const run = spawnSync("bash", ["-c", `set -euo pipefail\n${assigns.join("\n")}\n${fn[0]}\nhost_alert crash-loop --raise "5 revivals"`], {
    encoding: "utf8",
    env: { ...cleanEnv(), STATE_DIR: state, HOST_ALERT_INSTANCE: "remudero-daemon", RMD_STUB_SEEN: seenFile },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /host alert -- \{"tier":"escalated"\}/, "host_alert ran the stub rmd");
  const seen = Object.fromEntries(readFileSync(seenFile, "utf8").trim().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { seen, launcher };
}

const containerKeyArg = (launcher: string): string | undefined => /-e GH_APP_PRIVATE_KEY_PATH=(\S+)/.exec(launcher)?.[1];

test("W1-T9669: host_alert maps the container key path onto the host claude dir", (t) => {
  let claude = "";
  const { seen, launcher } = hostAlertEnv(t, (root) => ({ RMD_CLAUDE_DIR: (claude = join(root, "claude")) }));
  assert.deepEqual(seen, {
    GH_APP_ID: "4648213",
    GH_APP_INSTALLATION_ID: "155256285",
    GH_APP_PRIVATE_KEY_PATH: join(claude, "rmd-app.pem"),
  });
  assert.equal(containerKeyArg(launcher), CONTAINER_KEY, "the container keeps its own key path");
});

test("W1-T9669: an explicit host key path is what host_alert passes", (t) => {
  let key = "";
  const { seen, launcher } = hostAlertEnv(t, (root) => {
    key = join(root, "keys", "app.pem");
    mkdirSync(join(root, "keys"));
    writeFileSync(key, "placeholder, not a key\n");
    return { RMD_GH_APP_PRIVATE_KEY_HOST_PATH: key, RMD_GH_APP_ID: "77", RMD_GH_APP_INSTALLATION_ID: "88" };
  });
  assert.deepEqual(seen, { GH_APP_ID: "77", GH_APP_INSTALLATION_ID: "88", GH_APP_PRIVATE_KEY_PATH: key });
  assert.equal(containerKeyArg(launcher), CONTAINER_KEY, "the container keeps its own key path");
});

test("W1-T9669: a container key path outside /home/node/.claude, with no host path, passes no key path", (t) => {
  const { seen, launcher } = hostAlertEnv(t, () => ({ RMD_GH_APP_PRIVATE_KEY_PATH: "/run/app-key/rmd-app.pem" }));
  assert.deepEqual(seen, { GH_APP_ID: "4648213", GH_APP_INSTALLATION_ID: "155256285" }, "hostGithubToken names the gap");
  assert.equal(containerKeyArg(launcher), "/run/app-key/rmd-app.pem");
});
