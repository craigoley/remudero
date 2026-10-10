import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

// 2026-10-10 — core's tree sat at bf5aea42e from 04:18Z to 06:03Z. Every watchdog tick logged
// "busy, and daemon tree … lacks install head …'s deploy logic; deferring." That deferral had no age:
// while workers ran it deferred forever, and only the daemon's own freshness restart ended it. The lag
// now accrues pressure keyed to the daemon tree's HEAD and, past two of the daemon's own restart
// horizons, hands the daemon to recycle-container.sh's pause-and-drain swap.

const DAEMON_HEAD = "0".repeat(39) + "1";

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** The daemon tree's HEAD is sha 1, the install checkout's sha 2; 1 never contains 2 and they differ
 *  on deploy/recycle-container.sh, so every tick reaches the "lacks deploy logic" branch, busy. */
function launcher(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}deploy-logic-lag-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state-root");
  const daemon = join(state, "remudero");
  const install = join(state, "daemon-install");
  const stubs = join(root, "stubs");
  const deployed = join(root, "deployed");
  const recycled = join(root, "recycled");
  const revivals = join(root, "revivals");
  for (const dir of [stubs, join(daemon, ".git"), join(daemon, "bin"), join(daemon, "src"), join(install, ".git"), join(install, "deploy"), join(state, "state", "inflight"), join(state, "worktrees")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(daemon, "src", "run-task.ts"), "export {};\n");
  executable(join(daemon, "bin", "rmd"), `#!/usr/bin/env bash\n[ "$1" = progress-watchdog ] && exit 0\nprintf '%s\\n' "$*" >> '${deployed}'\n`);
  executable(join(install, "deploy", "recycle-container.sh"), `#!/usr/bin/env bash\necho "container=$RMD_DAEMON_CONTAINER verdict=\${RMD_RECYCLE_VERDICT:-none}" >> '${recycled}'\nexit 0\n`);
  executable(join(stubs, "git"), `#!/usr/bin/env bash
if [ "$1" = -C ]; then tree="$2"; shift 2; else tree="$PWD"; fi
case "$1" in
  status|fetch) : ;;
  merge-base) exit 1;;
  merge) exit 1;;
  symbolic-ref) echo main;;
  rev-parse)
    if [ "$2" = --show-toplevel ]; then echo "$tree"; elif [ "$tree" = '${daemon}' ]; then printf '%040d\\n' 1; else printf '%040d\\n' 2; fi;;
  diff) exit 1;;
  log|show|rev-list) : ;;
  *) exit 2;;
esac
`);
  executable(join(stubs, "docker"), `#!/usr/bin/env bash
case "$1" in
  ps) echo healthy-container;;
  top) echo "PID COMMAND"; echo '7 node /tools/claude --output-format stream-json';;
  inspect) echo unknown;;
  *) exit 1;;
esac
`);
  const github = ghShim([{ when: "", exit: 1 }]);
  t.after(() => rmSync(github.dir, { recursive: true, force: true }));
  const path = join(root, "launcher");
  const render = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], {
    encoding: "utf8",
    env: { ...process.env, RMD_STATE_DIR: state, RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "bin"), RMD_LAUNCHER_PATH: path, RMD_REVIVAL_LOG: revivals, RMD_NODE_MAX_OLD_SPACE_MB: "8192" },
  });
  assert.equal(render.status, 0, render.stderr);
  const mark = join(state, "state", "deploy-logic-lag");
  const tick = () =>
    spawnSync("bash", [path], {
      encoding: "utf8",
      cwd: root,
      timeout: 30000,
      env: { ...process.env, PATH: `${stubs}:${github.dir}:${process.env.PATH}` },
    });
  return { mark, deployed, recycled, revivals, recycleAt: join(state, "state", "watchdog-recycle-at"), tick };
}

const nowS = (): number => Math.floor(Date.now() / 1000);

test("a fresh deploy-logic lag defers to the daemon's own restart and starts its clock", (t) => {
  const f = launcher(t);
  const r = f.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /lacks install head 0+2's deploy logic .*deferring/);
  assert.match(r.stderr, /deploy-logic lag \d+s at 0+1, pressure \d+ < 36; the daemon's own freshness restart has it/);
  assert.equal(read(f.recycled), "", "a young lag never recycles");
  assert.equal(read(f.deployed), "", "deploy-run is still not asked from a tree lacking deploy logic");
  const [since, head] = read(f.mark).trim().split(" ");
  assert.equal(head, DAEMON_HEAD);
  assert.ok(Math.abs(Number(since) - nowS()) < 60, `clock starts now, got ${since}`);
});

test("a deploy-logic lag past two daemon horizons hands the busy daemon to the drain recycle", (t) => {
  const f = launcher(t);
  writeFileSync(f.mark, `${nowS() - 3 * 3600} ${DAEMON_HEAD}\n`);
  const r = f.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deploy code -- deploy-logic lag 108\d\ds at 0+1, pressure 54 >= 36: the daemon never restarted onto it; recycling remudero-daemon via .*daemon-install\/deploy\/recycle-container\.sh/);
  assert.equal(read(f.recycled), "container=remudero-daemon verdict=none\n", "recycle-container.sh's pause-and-drain swap ran once, with no STALLED verdict");
  assert.equal(read(f.deployed), "", "deploy-run never runs from the lagging tree");
  assert.match(read(f.revivals), /watchdog-recycle result=ok rc=0 reason=replaced/);

  // The next tick is inside WATCHDOG_RECYCLE_GAP_S: no second recycle on top of the first.
  const again = f.tick();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /deploy code -- a recycle ran \d+s ago/);
  assert.equal(read(f.recycled).split("\n").filter(Boolean).length, 1);
});

test("the lag clock is keyed to the daemon tree's HEAD: a tree that moved starts over", (t) => {
  const f = launcher(t);
  writeFileSync(f.mark, `${nowS() - 3 * 3600} ${"9".repeat(40)}\n`);
  const r = f.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /pressure 0 < 36/);
  assert.equal(read(f.recycled), "");
  assert.equal(read(f.mark).trim().split(" ")[1], DAEMON_HEAD);
});
