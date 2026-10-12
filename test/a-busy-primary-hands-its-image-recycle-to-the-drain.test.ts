import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runDeployCycle, type DeployDeps, type IdleProbe, type RestartBackend } from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T6249 — on 2026-10-07 core sat on the old image for hours after the Node 24 image published:
// every busy tick deferred on the idle gate (or never reached deploy-run at all), while a hand
// recycle-container.sh run paused dispatch, drained in 100 s and swapped. The recycler drains itself.

const NOW = Date.parse("2026-10-07T15:13:58.000Z");
const HEAD = "c".repeat(40);
const NEWEST = "a0548a6bd3a461b6598bb9e8580b1c92152a97ca";
const BUSY: IdleProbe = { workers: 2, inflightLocks: 1, worktreeLocks: 0 };

function cycle(opts: { imageDrift: boolean; marker: boolean; backend: Omit<RestartBackend, "restart"> }) {
  const logs: { step: string; data?: Record<string, unknown> }[] = [];
  const calls: string[] = [];
  let deferredSince: number | undefined;
  const backend: RestartBackend = { ...opts.backend, restart: () => calls.push(`restart:${opts.backend.name}`) };
  const deps = {
    log: (step: string, data?: Record<string, unknown>) => logs.push({ step, data }),
    now: () => NOW,
    fetch: () => {},
    installHead: () => HEAD,
    // A mount-side restart: the install checkout is behind origin/main and the operator asked.
    originMain: () => (opts.imageDrift ? HEAD : "d".repeat(40)),
    runningHead: () => HEAD,
    markerPresent: () => opts.marker,
    autoMode: () => false,
    lastFailedHead: () => undefined,
    daemonAlive: () => true,
    stopPresent: () => false,
    imageBakedCommitsBehind: () => (opts.imageDrift ? 1 : 0),
    newestBakedSha: () => NEWEST,
    imagePublished: () => true,
    imageRecycleManual: () => false,
    lastFailedAtMs: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    discardLocal: () => {},
    pullFf: () => calls.push("pullFf"),
    resetHard: () => {},
    probeIdle: () => BUSY,
    kickstart: () => calls.push("kickstart"),
    restartBackends: () => [backend],
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: () => calls.push("alert"),
    clearMarker: () => {},
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
    deferredSince: () => deferredSince,
    setDeferredSince: (ms: number) => {
      deferredSince = ms;
    },
    clearDeferredSince: () => {
      deferredSince = undefined;
    },
  } as DeployDeps;
  const out = runDeployCycle(deps, { imageDriftOnly: !opts.marker });
  return { out, logs, calls, deferredSince: () => deferredSince };
}

const recycler = { name: "recycle-container", probe: () => true, describe: () => "pause, drain, swap", drainsItself: true };

test("W1-T6249: a busy image recycle is handed to the self-draining backend", () => {
  const r = cycle({ imageDrift: true, marker: false, backend: recycler });
  assert.equal(r.out.deployed, true, r.out.reason);
  assert.ok(r.calls.includes("restart:recycle-container"), r.calls.join(","));
  const handoffs = r.logs.filter((l) => l.step === "deploy.drain_handoff");
  assert.deepEqual(handoffs.map((l) => l.data?.phase), ["pre-pull", "pre-kickstart"]);
  assert.equal(handoffs[0]?.data?.recycle, "image");
  assert.equal(handoffs[0]?.data?.backend, "recycle-container");
  assert.deepEqual(handoffs[0]?.data?.blockers, ["workers", "inflight-locks"]);
  assert.equal(r.logs.some((l) => l.step === "deploy.not_idle"), false, "the idle gate no longer defers it");
  assert.equal(r.deferredSince(), undefined, "a handed-off recycle starts no ceiling clock");
});

test("W1-T6249: a busy mount-side restart still waits on the idle gate", () => {
  const r = cycle({ imageDrift: false, marker: true, backend: recycler });
  assert.equal(r.out.deployed, false);
  assert.match(r.out.reason, /not-idle/);
  assert.deepEqual(r.calls, [], "neither a pull nor a restart over the busy fleet");
  assert.ok(r.logs.some((l) => l.step === "deploy.not_idle"));
  assert.equal(r.logs.some((l) => l.step === "deploy.drain_handoff"), false);
  assert.equal(r.deferredSince(), NOW, "the 30-minute ceiling clock still starts");

  // A backend that does NOT drain itself (launchd's kickstart) keeps the gate even for an image recycle.
  const kick = cycle({ imageDrift: true, marker: false, backend: { name: "launchctl", probe: () => true, describe: () => "kickstart -k" } });
  assert.equal(kick.out.deployed, false);
  assert.match(kick.out.reason, /not-idle/);
  assert.equal(kick.logs.some((l) => l.step === "deploy.drain_handoff"), false);
});

// ── The rendered launcher (git and docker simulated; the generated launcher is real) ──────────────

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

function launcher(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}drain-handoff-`));
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
  // The daemon tree's HEAD is sha 1, the install checkout's sha 2; BEHIND makes 1 not contain 2.
  executable(join(stubs, "git"), `#!/usr/bin/env bash
if [ "$1" = -C ]; then tree="$2"; shift 2; else tree="$PWD"; fi
case "$1" in
  status) : ;;
  fetch) : ;;
  merge-base) [ "\${BEHIND:-}" != 1 ] || exit 1;;
  merge) [ "$tree" != '${daemon}' ] || echo new > '${daemon}/version';;
  symbolic-ref) echo main;;
  rev-parse)
    if [ "$2" = --show-toplevel ]; then echo "$tree"; elif [ "$tree" = '${daemon}' ]; then printf '%040d\\n' 1; else printf '%040d\\n' 2; fi;;
  diff) [ "\${BEHIND:-}" != 1 ] || exit 1;; # W1-T6282: BEHIND differs on deploy logic too
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
  const tick = (behind: boolean) =>
    spawnSync("bash", [path], { encoding: "utf8", cwd: root, timeout: 30000, env: { ...process.env, PATH: `${stubs}:${github.dir}:${process.env.PATH}`, BEHIND: behind ? "1" : "" } });
  return { daemon, deployed, tick };
}

test("W1-T6249: a tick deferred only on active work still asks deploy-run", (t) => {
  const f = launcher(t);
  const r = f.tick(false);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /active workers; deferring/, "the code refresh itself still defers");
  assert.match(read(f.deployed), /^old deploy-run --image-drift-only/, "deploy-run is asked on the busy tick");
  assert.equal(read(join(f.daemon, "version")), "old", "the busy tree is never fast-forwarded");

  // Control: a daemon tree lacking the install head's deploy logic defers, naming both shas (W1-T6282).
  const g = launcher(t);
  const behind = g.tick(true);
  assert.equal(behind.status, 0, behind.stderr);
  assert.equal(read(g.deployed), "");
  assert.match(behind.stderr, new RegExp(`daemon tree ${"0".repeat(39)}1 lacks install head ${"0".repeat(39)}2's deploy logic`));
});
