/**
 * W1-T14752 — A PROMOTED STANDBY'S OUTPUT REACHES THE CONTAINER LOG.
 *
 * spawnStandbyDaemon (src/lib/daemon-handoff.ts) sends a standby's stdout and stderr to
 * state/daemon-standby/<runId>.log. After a handoff (exit 79) that standby is the live daemon, so the entrypoint copies
 * its log to the container's stderr until it exits; before, docker logs went silent for the rest of the run.
 *
 * REAL BASH, as test/deploy/a-promoted-daemon-that-dies-early-rolls-back-once.test.ts: the "daemon" is a bash stand-in.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy", "entrypoint.sh");

function script(path: string, lines: string[]): string {
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines, ""].join("\n"), { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function run(t: TestContext, writesLog: boolean): { status: number | null; err: string } {
  const home = ownedFixtureDir(t, "standby-log-home").dir;
  const stubs = ownedFixtureDir(t, "standby-log-stub").dir;
  script(join(stubs, "npm"), ["if [ \"$1\" = \"ci\" ]; then mkdir -p node_modules/.bin; printf '#!/bin/sh\\n' > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi", "exit 0"]);
  const origin = gitRepo({ scope: t, seedCommit: false, kind: "standby-log-origin" });
  writeFileSync(join(origin.dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  mkdirSync(join(origin.dir, "bin"), { recursive: true });
  script(join(origin.dir, "bin", "rmd"), ["exit 0"]);
  origin.git("add", "-A");
  origin.git("commit", "-qm", "c1");
  const dir = ownedFixtureDir(t, "standby-log-standin").dir;
  // The standby writes one line before the handoff and one while it holds the run, then exits 0.
  const successor = script(join(dir, "daemon-successor.sh"), [
    'dir="$1"; log="$2"',
    writesLog ? 'echo "standby: warmed before the handoff" >> "$log"' : ":",
    "sleep 2",
    writesLog ? 'echo "standby: first tick as the live daemon" >> "$log"' : ":",
    'sleep 1; echo 0 > "$dir/$$.exit"; exit 0',
  ]);
  const daemon = script(join(dir, "old-daemon.sh"), [
    `calls="${dir}/calls"`,
    'n=$(( $(cat "$calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$calls"',
    '[ "$n" -eq 1 ] || exit 0',
    'dir="$HOME/Remudero/state/daemon-handoff"; mkdir -p "$dir" "$HOME/Remudero/state/daemon-standby"',
    'log="$HOME/Remudero/state/daemon-standby/DAEMON-SUCCESSOR-1.log"',
    writesLog ? ': > "$log"' : ":",
    `bash "${successor}" "$dir" "$log" </dev/null >/dev/null 2>&1 &`,
    'echo "$! DAEMON-SUCCESSOR-1" > "$dir/successor.pid"',
    "exit 79",
  ]);
  const r = spawnSync("bash", [SCRIPT, "bash", daemon], { encoding: "utf8", cwd: REPO_ROOT, timeout: 90_000,
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}`, HOME: home, RMD_REPO_URL: origin.dir, RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", RMD_RESTART_THROTTLE_S: "1", RMD_FRESHNESS_RESTART_PAUSE_S: "0",
      RMD_HANDOFF_WATCH_INTERVAL_S: "1" } });
  return { status: r.status, err: r.stderr ?? "" };
}

test("W1-T14752 a promoted standby's log is copied to the container's stderr until it exits", async (t) => {
  const r = run(t, true);
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /standby: warmed before the handoff/);
  assert.match(r.err, /standby: first tick as the live daemon/, "lines written while it holds the run reach the log");
  assert.ok(r.err.indexOf("first tick as the live daemon") < r.err.indexOf("handed-off successor pid"),
    "the successor's lines come before the entrypoint reports its exit");
});

test("W1-T14752 a successor with no standby log is watched as before", async (t) => {
  const r = run(t, false);
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /handed-off successor pid \d+ exited 0/);
  // The watch is the same with a log: its exit is still reported, once, and the copy stops with it (no line twice).
  const logged = run(t, true);
  assert.equal(logged.status, 0, logged.err);
  assert.equal(logged.err.match(/handed-off successor pid \d+ exited 0/g)?.length, 1);
  assert.equal(logged.err.match(/standby: first tick as the live daemon/g)?.length, 1, "each copied line appears once");
});
