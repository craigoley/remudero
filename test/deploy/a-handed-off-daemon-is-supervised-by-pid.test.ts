/**
 * W1-T14546 — THE ENTRYPOINT SUPERVISES A HANDED-OFF DAEMON BY ITS PID.
 *
 * In a blue-green restart the old daemon starts a standby, hands it the run and exits
 * DAEMON_EXIT_HANDED_OFF (79). The standby is not a child of the entrypoint shell, so the loop
 * cannot `wait` it: it watches the pid named in `state/daemon-handoff/successor.pid`, forwards an
 * operator stop to it, and routes the code it writes to `<pid>.exit` through the usual cases.
 *
 * REAL BASH, REAL SIGNALS, as test/an-operator-stop-is-undone-by-the-restart-policy.test.ts: the
 * claims live in process plumbing a synthetic signal cannot exercise. The "daemon" is a bash
 * stand-in; its successor's script name carries "daemon" because the watch requires it in
 * /proc/<pid>/cmdline where readable (a reused pid or a zombie reads as gone).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy", "entrypoint.sh");

function tmp(t: TestContext, kind: string): string {
  return ownedFixtureDir(t, kind).dir;
}

function makeOrigin(t: TestContext): string {
  const origin = gitRepo({ scope: t, seedCommit: false, kind: "handoff-origin" });
  writeFileSync(join(origin.dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  mkdirSync(join(origin.dir, "bin"), { recursive: true });
  writeFileSync(join(origin.dir, "bin", "rmd"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(join(origin.dir, "bin", "rmd"), 0o755);
  origin.git("add", "-A");
  origin.git("commit", "-qm", "c1");
  return origin.dir;
}

function writeNpmStub(dir: string): void {
  writeFileSync(
    join(dir, "npm"),
    "#!/usr/bin/env bash\nif [ \"$1\" = \"ci\" ]; then mkdir -p node_modules/.bin; printf '#!/bin/sh\\n' > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi\nexit 0\n",
    { mode: 0o755 },
  );
  chmodSync(join(dir, "npm"), 0o755);
}

function script(path: string, lines: string[]): string {
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines, ""].join("\n"), { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

interface World { home: string; origin: string; stubs: string; dir: string; calls: string; env: NodeJS.ProcessEnv }

function world(t: TestContext): World {
  const home = tmp(t, "handoff-home");
  const stubs = tmp(t, "handoff-stub");
  writeNpmStub(stubs);
  const dir = tmp(t, "handoff-standin");
  const origin = makeOrigin(t);
  return {
    home, origin, stubs, dir, calls: join(dir, "calls"),
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      RMD_RESTART_THROTTLE_S: "1",
      RMD_FRESHNESS_RESTART_PAUSE_S: "0",
      RMD_HANDOFF_WATCH_INTERVAL_S: "1",
    },
  };
}

/**
 * The supervised command. Call 1 starts `successor` in the background, names it in successor.pid
 * (unless `namePid` is false) and exits 79; every later call exits `laterExit`.
 */
function oldDaemon(w: World, successor: string | undefined, laterExit: number, namePid = true): string {
  return script(join(w.dir, "old-daemon.sh"), [
    `calls="${w.calls}"`,
    'n=$(( $(cat "$calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$calls"',
    `if [ "$n" -gt 1 ]; then exit ${laterExit}; fi`,
    'dir="$HOME/Remudero/state/daemon-handoff"; mkdir -p "$dir"',
    ...(successor ? [`bash "${successor}" "$dir" </dev/null >/dev/null 2>&1 &`] : []),
    ...(successor && namePid ? ['echo "$! DAEMON-SUCCESSOR-1" > "$dir/successor.pid"'] : []),
    "exit 79",
  ]);
}

function callCount(w: World): number {
  return existsSync(w.calls) ? Number(readFileSync(w.calls, "utf8").trim()) : 0;
}

test("W1-T14546 a handed-off successor is watched by pid and its exit code is routed", (t) => {
  const w = world(t);
  // The successor runs ~2 s, then reports 75 (freshness): the loop must route it to the freshness
  // restart, which re-syncs and starts the supervised command again (call 2, which exits 0).
  const successor = script(join(w.dir, "daemon-successor.sh"), [
    'dir="$1"; sleep 2; echo 75 > "$dir/$$.exit"; exit 75',
  ]);
  const r = spawnSync("bash", [SCRIPT, "bash", oldDaemon(w, successor, 0)], { encoding: "utf8", cwd: REPO_ROOT, env: w.env, timeout: 60_000 });
  const err = r.stderr ?? "";
  assert.equal(r.status, 0, err);
  assert.equal(callCount(w), 2, "the loop starts no daemon while the successor runs, and one after it exits 75");
  const watching = err.indexOf("watching successor pid");
  const exited = err.indexOf("exited 75");
  assert.ok(watching >= 0, err);
  assert.match(err, /handed-off successor pid \d+ exited 75/);
  assert.ok(exited > watching, "the successor's code is routed only after the watch");
  const between = err.slice(watching, err.indexOf("handed-off successor pid"));
  assert.doesNotMatch(between, /checkout:/, "no sync_tree while the successor runs");
  assert.match(err.slice(exited), /exited 75 \(freshness\)/, "75 from the successor takes the freshness route");
  assert.equal(existsSync(join(w.home, "Remudero", "state", "daemon-handoff", "successor.pid")), false, "the pid file is consumed");
});

test("W1-T14546 an operator stop reaches a handed-off successor", async (t) => {
  const w = world(t);
  const started = join(w.dir, "started");
  const cleaned = join(w.dir, "cleaned");
  const successor = script(join(w.dir, "daemon-successor.sh"), [
    `trap 'touch "${cleaned}"; trap - TERM; kill -TERM $$' TERM`,
    `touch "${started}"`,
    "while :; do sleep 0.1; done",
  ]);
  const child = spawn("bash", [SCRIPT, "bash", oldDaemon(w, successor, 0)], { cwd: REPO_ROOT, env: { ...w.env, RMD_RESTART_THROTTLE_S: "20" }, detached: true });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<{ code: number | null }>((resolve) => child.once("exit", (code) => resolve({ code })));
  try {
    const deadline = Date.now() + 60_000;
    while (!(existsSync(started) && stderr.includes("watching successor pid"))) {
      if (Date.now() > deadline) throw new Error(`never handed off: ${stderr}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    child.kill("SIGTERM");
    const { code } = await Promise.race([exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no exit: ${stderr}`)), 20_000))]);
    assert.equal(existsSync(cleaned), true, "the successor ran its own TERM cleanup");
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /sleeping 20s before exiting/, "a handled stop never pays the crash throttle");
    assert.match(stderr, /forwarding to handed-off successor pid \d+/);
    assert.match(stderr, /operator stop handled/);
    assert.equal(callCount(w), 1, "no daemon is started after the stop");
  } finally {
    if (child.pid !== undefined) try { process.kill(-child.pid, "SIGKILL"); } catch { /* deliberate: the group is already gone */ }
  }
});

test("W1-T14546 a missing successor falls back to a cold start", (t) => {
  // (a) a successor that exits without its exit file is a crash: exit 1 after the crash throttle.
  const w = world(t);
  const successor = script(join(w.dir, "daemon-successor.sh"), ["sleep 1; exit 0"]);
  const crashed = spawnSync("bash", [SCRIPT, "bash", oldDaemon(w, successor, 0)], { encoding: "utf8", cwd: REPO_ROOT, env: w.env, timeout: 60_000 });
  assert.equal(crashed.status, 1, crashed.stderr);
  assert.match(crashed.stderr ?? "", /exited with no exit file .* treating it as a crash/);
  assert.equal(callCount(w), 1, "a crashed successor is not restarted in the container");

  // (b) exit 79 with no successor named: say so and cold-start at once (call 2 exits 0).
  const v = world(t);
  const cold = spawnSync("bash", [SCRIPT, "bash", oldDaemon(v, undefined, 0)], { encoding: "utf8", cwd: REPO_ROOT, env: v.env, timeout: 60_000 });
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stderr ?? "", /handoff_successor_missing/);
  assert.equal(callCount(v), 2, "the cold start runs the daemon again");
  const missing = (cold.stderr ?? "").indexOf("handoff_successor_missing");
  assert.match((cold.stderr ?? "").slice(missing), /checkout:/, "the cold start re-syncs the checkout first");
  assert.doesNotMatch(cold.stderr ?? "", /sleeping 1s before exiting/, "a missing successor is not a crash");
});
