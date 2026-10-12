import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { runDeployCycle, type DeployDeps, type IdleProbe, type RestartBackend } from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T6282 — after W1-T6249 core still sat 80+ min behind a published image on 2026-10-07. Two gates
// closed together: the launcher handed a busy tick to deploy-run only when the daemon tree CONTAINED
// the install head (one merge behind on a busy repo, every tick), and the one tick that got through
// was an auto-mode decision carrying no `recycle`, so deploy-run idle-gated it on boot-settling.

const NOW = Date.parse("2026-10-07T21:17:25.000Z");
const HEAD = "c".repeat(40);
const NEWEST = "b3fbc42d0000000000000000000000000000000a";
const SETTLING: IdleProbe = { workers: 0, inflightLocks: 0, worktreeLocks: 0, bootSettling: true };
const recycler = { name: "recycle-container", probe: () => true, describe: () => "pause, drain, swap", drainsItself: true };

function cycle(opts: { autoMode: boolean; marker: boolean }) {
  const logs: { step: string; data?: Record<string, unknown> }[] = [];
  const calls: string[] = [];
  const backend: RestartBackend = { ...recycler, restart: () => calls.push("restart:recycle-container") };
  const deps = {
    log: (step: string, data?: Record<string, unknown>) => logs.push({ step, data }),
    now: () => NOW,
    fetch: () => {},
    installHead: () => HEAD,
    originMain: () => HEAD,
    runningHead: () => HEAD,
    markerPresent: () => opts.marker,
    autoMode: () => opts.autoMode,
    lastFailedHead: () => undefined,
    daemonAlive: () => true,
    stopPresent: () => false,
    imageBakedCommitsBehind: () => 1,
    newestBakedSha: () => NEWEST,
    imagePublished: () => true,
    imageRecycleManual: () => false,
    lastFailedAtMs: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    discardLocal: () => {},
    pullFf: () => calls.push("pullFf"),
    resetHard: () => {},
    probeIdle: () => SETTLING,
    kickstart: () => calls.push("kickstart"),
    restartBackends: () => [backend],
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: () => calls.push("alert"),
    clearMarker: () => {},
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
    deferredSince: () => undefined,
    setDeferredSince: () => {},
    clearDeferredSince: () => {},
  } as DeployDeps;
  const out = runDeployCycle(deps, { imageDriftOnly: true });
  return { out, logs, calls };
}

// ── The rendered launcher (git and docker simulated; the generated launcher is real) ──────────────

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** The daemon tree's HEAD is sha 1, the install checkout's sha 2, and 1 never contains 2 (a busy
 *  repo merged since the daemon tree last moved). CHANGED names the one path the two heads differ
 *  on; `git diff --quiet A B -- <pathspec>...` exits 1 iff a pathspec covers it. */
function launcher(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}busy-recycle-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state-root");
  const daemon = join(state, "remudero");
  const install = join(state, "daemon-install");
  const stubs = join(root, "stubs");
  const deployed = join(root, "deployed");
  for (const dir of [stubs, join(daemon, ".git"), join(daemon, "bin"), join(daemon, "src"), join(install, ".git"), join(state, "state", "inflight"), join(state, "worktrees")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(daemon, "src", "run-task.ts"), "export {};\n");
  writeFileSync(join(daemon, "version"), "old");
  executable(join(daemon, "bin", "rmd"), `#!/usr/bin/env bash\n[ "$1" = progress-watchdog ] && exit 0\nprintf '%s %s\\n' "$(cat '${daemon}/version')" "$*" >> '${deployed}'\n`);
  executable(join(stubs, "git"), `#!/usr/bin/env bash
if [ "$1" = -C ]; then tree="$2"; shift 2; else tree="$PWD"; fi
case "$1" in
  status) : ;;
  fetch) : ;;
  merge-base) exit 1;;
  merge) [ "$tree" != '${daemon}' ] || echo new > '${daemon}/version';;
  symbolic-ref) echo main;;
  rev-parse)
    if [ "$2" = --show-toplevel ]; then echo "$tree"; elif [ "$tree" = '${daemon}' ]; then printf '%040d\\n' 1; else printf '%040d\\n' 2; fi;;
  diff)
    [ "\${DIFF_FAIL:-}" != 1 ] || exit 128
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
    [ "$#" -gt 1 ] || exit 2
    shift
    for p in "$@"; do
      [ "$CHANGED" = "$p" ] && exit 1
      case "$p" in */) case "$CHANGED" in "$p"*) exit 1;; esac;; esac
    done
    exit 0;;
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
    env: { ...process.env, RMD_STATE_DIR: state, RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "bin"), RMD_LAUNCHER_PATH: path, RMD_REVIVAL_LOG: join(root, "revivals"), RMD_NODE_MAX_OLD_SPACE_MB: "8192" },
  });
  assert.equal(render.status, 0, render.stderr);
  const tick = (changed: string, diffFails = false) => {
    rmSync(deployed, { force: true });
    return spawnSync("bash", [path], {
      encoding: "utf8",
      cwd: root,
      timeout: 30000,
      env: { ...process.env, PATH: `${stubs}:${github.dir}:${process.env.PATH}`, CHANGED: changed, DIFF_FAIL: diffFails ? "1" : "" },
    });
  };
  return { daemon, deployed, tick };
}

/** src/lib/deployer.ts and every local module it reaches — the code that decides and performs a deploy. */
function deployLogicModules(): string[] {
  const seen = new Set<string>();
  const queue = ["src/lib/deployer.ts"];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const next = join(dirname(file), m[1]!).replace(/\.js$/, ".ts");
      if (existsSync(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

test("W1-T6282: a busy primary behind only on non-deploy paths hands its image recycle off", (t) => {
  // The launcher: the daemon tree lacks one docs-only install commit, and the busy tick still asks.
  const f = launcher(t);
  const r = f.tick("docs/forensics/deployer.md");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /active workers; deferring/, "the code refresh itself still defers");
  assert.doesNotMatch(r.stderr, /does not contain install head/);
  assert.match(r.stdout, /carries install head 0+2's deploy logic/);
  assert.match(read(f.deployed), /^old deploy-run --image-drift-only/, "deploy-run is asked on the busy tick");
  assert.equal(read(join(f.daemon, "version")), "old", "the busy tree is never fast-forwarded");

  // deploy-run: core runs DEPLOY_AUTO, and a boot-settling daemon with a published image not running
  // is handed to recycle-container's own drain rather than idle-gated (the 21:17:25Z tick).
  const d = cycle({ autoMode: true, marker: false });
  assert.equal(d.out.deployed, true, d.out.reason);
  assert.ok(d.calls.includes("restart:recycle-container"), d.calls.join(","));
  const handoffs = d.logs.filter((l) => l.step === "deploy.drain_handoff");
  assert.deepEqual(handoffs.map((l) => l.data?.phase), ["pre-pull", "pre-kickstart"]);
  assert.equal(handoffs[0]?.data?.recycle, "image");
  assert.deepEqual(handoffs[0]?.data?.blockers, ["boot-settling"]);
  assert.equal(d.logs.some((l) => l.step === "deploy.not_idle"), false, "boot-settling no longer defers it");

  // An operator's marker on the same tick asks for the same published image: handed off too.
  const m = cycle({ autoMode: false, marker: true });
  assert.equal(m.out.deployed, true, m.out.reason);
  assert.equal(m.logs.find((l) => l.step === "deploy.drain_handoff")?.data?.recycle, "image");
});

test("W1-T6282: a daemon tree behind on deploy logic still defers, naming the paths", (t) => {
  const f = launcher(t);
  const modules = deployLogicModules();
  assert.ok(modules.length > 1 && modules.includes("src/lib/deployer.ts"), modules.join(","));
  for (const changed of ["deploy/recycle-container.sh", "deploy/install-host-units.sh", "bin/rmd", ...modules]) {
    const r = f.tick(changed);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(f.deployed), "", `${changed} is deploy logic: the busy tick must not ask deploy-run`);
    assert.match(r.stderr, /lacks install head 0+2's deploy logic .*deferring/, changed);
  }
});

test("W1-T6282: an unreadable deploy-logic diff defers", (t) => {
  const f = launcher(t);
  const r = f.tick("docs/x.md", true);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(f.deployed), "");
  assert.match(r.stderr, /deploy logic unreadable .*deferring/);
});
