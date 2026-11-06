/** W1-T11327: the launcher asks for an in-place restart before recycling and falls back when it cannot write the request. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Renders the launcher against a fixture host whose progress-watchdog prints `verdict` (and whose
 *  `--request-restart` succeeds unless `requestFails`), runs one tick, and reports what it did. */
function tickWith(t: TestContext, verdict: Record<string, unknown>, requestFails = false) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t11327-launcher-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state-root");
  for (const dir of ["bin", "tmp", "state-root/state/inflight", "state-root/daemon-install/deploy", "state-root/remudero/bin"]) mkdirSync(join(root, dir), { recursive: true });
  const recycled = join(root, "recycled");
  const requestArgs = join(root, "request-args");
  executable(join(state, "daemon-install/deploy/recycle-container.sh"), `printf ran > '${recycled}'`);
  executable(join(state, "remudero/bin/rmd"), [
    'if [ "$1" = progress-watchdog ]; then',
    '  case " $* " in',
    `    *" --request-restart "*) ${requestFails ? "exit 3" : `printf '%s' "$*" > '${requestArgs}'; echo 'progress-watchdog: restart in place requested at 2026-11-04T13:04:08.000Z'`} ;;`,
    `    *) echo '${JSON.stringify(verdict)}' ;;`,
    "  esac",
    "fi",
  ].join("\n"));
  executable(join(root, "bin/docker"), 'case "$1" in ps) echo fixture-container ;; inspect) echo 1 ;; esac');
  executable(join(root, "bin/findmnt"), "exit 0");
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(base)) if (key.startsWith("RMD_RECYCLE_") || key === "RMD_SELF_SYNC_DONE") delete base[key];
  Object.assign(base, { PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: join(root, "tmp"), GH_TOKEN: "fixture-token" });
  const launcher = join(root, "launcher.sh");
  const revivals = join(root, "revivals");
  const rendered = spawnSync("bash", [join(REPO_ROOT, "deploy/install-host-units.sh"), "--install"], {
    encoding: "utf8",
    env: { ...base, RMD_STATE_DIR: state, RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "unitbin"), RMD_LAUNCHER_PATH: launcher,
      RMD_REVIVAL_LOG: revivals, RMD_NODE_MAX_OLD_SPACE_MB: "8192" },
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const tick = spawnSync("bash", [launcher], { encoding: "utf8", timeout: 60_000, env: base });
  assert.equal(tick.status, 0, tick.stdout + tick.stderr);
  return {
    recycled: existsSync(recycled),
    requestArgs: existsSync(requestArgs) ? readFileSync(requestArgs, "utf8") : undefined,
    revivals: existsSync(revivals) ? readFileSync(revivals, "utf8") : "",
    output: tick.stdout + tick.stderr,
    stateDir: join(state, "state"),
  };
}

test("W1-T11327 criterion 2: the launcher writes the request instead of recycling, and recycles when it cannot", (t) => {
  const asked = tickWith(t, { state: "STALLED", action: "restart-in-place", progressAgeMs: 2_595_011 });
  assert.equal(asked.recycled, false, `a restart-in-place tick runs no recycle\n${asked.output}`);
  assert.equal(asked.requestArgs, `progress-watchdog --request-restart --state-root ${asked.stateDir}`, asked.output);
  assert.match(asked.revivals, /watchdog-restart-in-place state=STALLED progress-watchdog: restart in place requested at 2026-11-04T13:04:08\.000Z/);

  const failed = tickWith(t, { state: "STALLED", action: "restart-in-place", progressAgeMs: 2_595_011 }, true);
  assert.equal(failed.recycled, true, `an unwritten request falls back to this tick's recycle\n${failed.output}`);

  const recycle = tickWith(t, { state: "STALLED", action: "recycle", progressAgeMs: 2_595_011 });
  assert.equal(recycle.requestArgs, undefined, "a recycle verdict writes no request");
  assert.equal(recycle.recycled, true);
});
