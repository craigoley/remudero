import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BUILD_ROLE_IMAGE_BAKED_PATHS } from "../src/lib/deploy-judge.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T9645 — 2026-10-15: W1-T9623's deploy/entrypoint.sh fix (f3f591c, image built 11:57Z) did not
// deploy. Every 5-minute tick said the busy daemon tree da9af5ecc "lacks install head …'s deploy logic",
// then "deploy-logic lag 2082s … pressure 10 < 36; the daemon's own freshness restart has it". That
// restart re-execs node in the SAME container, so a baked path can never arrive through it. A baked-path
// or priority-0 lag now goes to deploy-run's busy recycle at once, and the backstop's fixed 36 is the
// longest lag a freshness restart has actually cleared in.

const DAEMON_HEAD = "0".repeat(39) + "1";

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");
const nowS = (): number => Math.floor(Date.now() / 1000);

/** The daemon tree is at sha 1, the install checkout at sha 2, workers busy, and the two differ on deploy
 *  logic. `changed` is what `git diff --name-only` names among the baked paths; `log` is the commit
 *  bodies between them; `shards` are plan shards in the install checkout. */
function launcher(t: TestContext, opts: { changed?: string[]; log?: string; shards?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}baked-lag-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state-root");
  const daemon = join(state, "remudero");
  const install = join(state, "daemon-install");
  const stubs = join(root, "stubs");
  const deployed = join(root, "deployed");
  const recycled = join(root, "recycled");
  const revivals = join(root, "revivals");
  for (const dir of [stubs, join(daemon, ".git"), join(daemon, "bin"), join(daemon, "src"), join(install, ".git"), join(install, "deploy"), join(install, "plan", "tasks.d"), join(state, "state", "inflight"), join(state, "worktrees")]) mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(opts.shards ?? {})) writeFileSync(join(install, "plan", "tasks.d", name), body);
  writeFileSync(join(daemon, "src", "run-task.ts"), "export {};\n");
  writeFileSync(join(root, "changed"), (opts.changed ?? []).map((p) => `${p}\n`).join(""));
  writeFileSync(join(root, "log"), opts.log ?? "");
  executable(join(daemon, "bin", "rmd"), `#!/usr/bin/env bash\ncase "$1" in progress-watchdog|host-alert) exit 0;; esac\nprintf '%s\\n' "$*" >> '${deployed}'\n`);
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
  diff)
    if [ "$2" = --name-only ]; then cat '${join(root, "changed")}'; exit 0; fi
    exit 1;;
  log) cat '${join(root, "log")}';;
  show|rev-list) : ;;
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
  const tick = () =>
    spawnSync("bash", [path], {
      encoding: "utf8",
      cwd: root,
      timeout: 30000,
      env: { ...process.env, PATH: `${stubs}:${github.dir}:${process.env.PATH}` },
    });
  return {
    mark: join(state, "state", "deploy-logic-lag"),
    history: join(state, "state", "deploy-logic-lag-history"),
    deployed,
    recycled,
    tick,
  };
}

test("a baked-path lag asks deploy-run instead of waiting on the daemon's freshness restart", (t) => {
  const f = launcher(t, { changed: ["deploy/entrypoint.sh"] });
  const r = f.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /daemon tree 0+1 lacks install head 0+2's deploy logic, but it changes baked path\(s\) deploy\/entrypoint\.sh: a freshness restart keeps the old image, so asking deploy-run to recycle at the next drain/,
  );
  assert.doesNotMatch(r.stderr, /the daemon's own freshness restart has it/, "a baked path is never waited out");
  assert.match(read(f.deployed), /^deploy-run --image-drift-only --state-root /m, "deploy-run decides the recycle and its drain");
  assert.equal(read(f.recycled), "", "the watchdog does not recycle behind deploy-run's back");
  assert.match(read(f.mark), new RegExp(`^\\d+ ${DAEMON_HEAD} recycled$`, "m"), "the recycle it causes is not a measured freshness clear");

  // A priority-0 task in the lag goes the same way; a priority-1 one still defers.
  const p0 = launcher(t, {
    log: "fix(entrypoint): move a differing untracked file aside\n\nRemudero-Task: W1-T9623\n",
    shards: { "W1-T9623-a-differing-untracked-file.yaml": "- id: W1-T9623\n  priority: 0\n" },
  });
  const urgent = p0.tick();
  assert.equal(urgent.status, 0, urgent.stderr);
  assert.match(urgent.stdout, /but it carries W1-T9623, a priority-0 task: a freshness restart keeps the old image, so asking deploy-run/);
  assert.match(read(p0.deployed), /^deploy-run --image-drift-only /m);

  const p1 = launcher(t, {
    log: "fix(x): y\n\nRemudero-Task: W1-T1\n",
    shards: { "W1-T1-routine.yaml": "- id: W1-T1\n  priority: 1\n" },
  });
  const routine = p1.tick();
  assert.equal(routine.status, 0, routine.stderr);
  assert.match(routine.stderr, /pressure \d+ < 36; the daemon's own freshness restart has it/);
  assert.equal(read(p1.deployed), "", "mounted deploy logic still waits for the tree to carry it");
});

test("the lag backstop is the longest lag a freshness restart cleared in, not a fixed 36", (t) => {
  // Two measured clears, 15 and 25 minutes: a 30-minute lag is past the longest of them.
  const f = launcher(t);
  writeFileSync(f.history, `${nowS() - 9000} 900 ${"7".repeat(40)}\n${nowS() - 5000} 1500 ${"8".repeat(40)}\n`);
  writeFileSync(f.mark, `${nowS() - 1800} ${DAEMON_HEAD}\n`);
  const r = f.tick();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deploy-logic lag 18\d\ds at 0+1, pressure 9 >= 7: the daemon never restarted onto it; recycling remudero-daemon/);
  assert.equal(read(f.recycled), "container=remudero-daemon verdict=none\n");
  assert.match(read(f.mark), / recycled$/m, "the lag this recycle ends is not recorded as a freshness clear");

  // With no history the same lag waits the two horizons the fixed 36 stood for.
  const fresh = launcher(t);
  writeFileSync(fresh.mark, `${nowS() - 1800} ${DAEMON_HEAD}\n`);
  const waits = fresh.tick();
  assert.match(waits.stderr, /pressure 9 < 36; the daemon's own freshness restart has it \(bound: the longest lag one has cleared in, 7200s\)/);
  assert.equal(read(fresh.recycled), "");
});

test("a tree that moved off its lag records the clear, unless the watchdog's own recycle moved it", (t) => {
  const f = launcher(t);
  const old = "9".repeat(40);
  writeFileSync(f.mark, `${nowS() - 1200} ${old}\n`);
  assert.equal(f.tick().status, 0);
  const rows = read(f.history).trim().split("\n");
  assert.equal(rows.length, 1, read(f.history));
  const [, lag, head] = rows[0].split(" ");
  assert.ok(Math.abs(Number(lag) - 1200) < 60, lag);
  assert.equal(head, old);
  assert.equal(read(f.mark).trim().split(" ")[1], DAEMON_HEAD, "the clock restarts on the new head");

  const flagged = launcher(t);
  writeFileSync(flagged.mark, `${nowS() - 1200} ${old} recycled\n`);
  assert.equal(flagged.tick().status, 0);
  assert.equal(read(flagged.history), "", "a recycle-ended lag is not a freshness clear");

  // Only the newest clears are kept.
  const many = launcher(t);
  writeFileSync(many.history, Array.from({ length: 25 }, (_, i) => `${nowS() - 100_000 + i} ${100 + i} ${old}\n`).join(""));
  writeFileSync(many.mark, `${nowS() - 60} ${old}\n`);
  assert.equal(many.tick().status, 0);
  const kept = read(many.history).trim().split("\n");
  assert.equal(kept.length, 20);
  assert.match(kept[0], / 106 /, "the oldest rows are dropped first");
});

test("the launcher's baked paths are the build role's image inputs", () => {
  const installer = readFileSync("deploy/install-host-units.sh", "utf8");
  const m = /^DEPLOY_BAKED_PATHS=\(([^)]*)\)/m.exec(installer);
  assert.ok(m, "DEPLOY_BAKED_PATHS is declared");
  assert.deepEqual(m[1].split(/\s+/).filter(Boolean), [...BUILD_ROLE_IMAGE_BAKED_PATHS]);
});
