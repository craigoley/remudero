/**
 * W1-T14547 — A PROMOTED DAEMON THAT DIES EARLY ROLLS BACK ONCE.
 *
 * After a blue-green handoff (exit 79) the entrypoint watches the successor by pid (W1-T14546). If that successor
 * crashes within 15 minutes of the handoff, the sha it runs is presumed bad: the daemon is started once from the
 * predecessor's code tree named in state/daemon-handoff/record.env, with no checkout sync. A second early death of
 * the same sha takes the normal crash route, and a deliberate exit (75) never rolls back.
 *
 * REAL BASH, as test/deploy/a-handed-off-daemon-is-supervised-by-pid.test.ts: the "daemon" is a bash stand-in that
 * records the directory each start ran in, and its successor's script name carries "daemon" for the pid watch.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy", "entrypoint.sh");
const OLD_SHA = "a".repeat(40);
const BAD_SHA = "b".repeat(40);

function script(path: string, lines: string[]): string {
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines, ""].join("\n"), { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

interface World { home: string; dir: string; predecessor: string; calls: string; cwds: string; env: NodeJS.ProcessEnv }

function world(t: TestContext): World {
  const home = ownedFixtureDir(t, "rollback-home").dir;
  const stubs = ownedFixtureDir(t, "rollback-stub").dir;
  script(join(stubs, "npm"), ["if [ \"$1\" = \"ci\" ]; then mkdir -p node_modules/.bin; printf '#!/bin/sh\\n' > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi", "exit 0"]);
  const origin = gitRepo({ scope: t, seedCommit: false, kind: "rollback-origin" });
  writeFileSync(join(origin.dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  mkdirSync(join(origin.dir, "bin"), { recursive: true });
  script(join(origin.dir, "bin", "rmd"), ["exit 0"]);
  origin.git("add", "-A");
  origin.git("commit", "-qm", "c1");
  const dir = ownedFixtureDir(t, "rollback-standin").dir;
  const predecessor = ownedFixtureDir(t, "rollback-predecessor-tree").dir;
  return {
    home, dir, predecessor, calls: join(dir, "calls"), cwds: join(dir, "cwds"),
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}`, HOME: home, RMD_REPO_URL: origin.dir, RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", RMD_RESTART_THROTTLE_S: "1", RMD_FRESHNESS_RESTART_PAUSE_S: "0",
      RMD_HANDOFF_WATCH_INTERVAL_S: "1" },
  };
}

/**
 * The supervised command. Each call appends its working directory to `cwds`. Calls listed in `handOff` start a
 * successor that exits `successorExit` after a second, name it in successor.pid and record.env (yielded `ageMs`
 * ago), and exit 79; every other call exits `laterExit`.
 */
function daemon(w: World, o: { handOff: number[]; successorExit: number; laterExit: number; ageMs?: number }): string {
  const successor = script(join(w.dir, "daemon-successor.sh"), [`dir="$1"; sleep 1; echo ${o.successorExit} > "$dir/$$.exit"; exit ${o.successorExit}`]);
  return script(join(w.dir, "old-daemon.sh"), [
    `calls="${w.calls}"`,
    'n=$(( $(cat "$calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$calls"',
    `pwd >> "${w.cwds}"`,
    `case " ${o.handOff.join(" ")} " in *" $n "*) ;; *) exit ${o.laterExit} ;; esac`,
    'dir="$HOME/Remudero/state/daemon-handoff"; mkdir -p "$dir"',
    `bash "${successor}" "$dir" </dev/null >/dev/null 2>&1 &`,
    'echo "$! DAEMON-SUCCESSOR-$n" > "$dir/successor.pid"',
    `printf 'predecessor_sha=${OLD_SHA}\\npredecessor_tree=${w.predecessor}\\nsuccessor_sha=${BAD_SHA}\\nsuccessor_tree=/slots/a\\nsuccessor_run_id=DAEMON-SUCCESSOR-%s\\nyielded_at_ms=%s\\n' "$n" "$(( $(date +%s%3N) - ${o.ageMs ?? 0} ))" > "$dir/record.env"`,
    "exit 79",
  ]);
}

function run(w: World, command: string, env: NodeJS.ProcessEnv = {}): { status: number | null; err: string; cwds: string[] } {
  const r = spawnSync("bash", [SCRIPT, "bash", command], { encoding: "utf8", cwd: REPO_ROOT, env: { ...w.env, ...env }, timeout: 90_000 });
  return { status: r.status, err: r.stderr ?? "", cwds: existsSync(w.cwds) ? readFileSync(w.cwds, "utf8").trim().split("\n") : [] };
}

test("W1-T14547 a promoted daemon that dies early rolls back once", async (t) => {
  // A successor crashing a second after its handoff: the next start runs from the predecessor's tree, unsynced.
  const w = world(t);
  const once = run(w, daemon(w, { handOff: [1], successorExit: 1, laterExit: 0 }));
  assert.equal(once.status, 0, once.err);
  assert.match(once.err, new RegExp(`handoff_rolled_back: successor ${BAD_SHA} \\(DAEMON-SUCCESSOR-1\\) exited 1 \\d+s after the handoff — starting the daemon once from ${w.predecessor} at ${OLD_SHA}`));
  assert.equal(once.cwds.length, 2);
  assert.equal(once.cwds[1], w.predecessor, "the rolled-back start runs in the predecessor's code tree");
  assert.doesNotMatch(once.err.slice(once.err.indexOf("handoff_rolled_back")), /checkout:/, "no sync before the rolled-back start");
  assert.equal(existsSync(join(w.home, "Remudero", "state", "daemon-handoff", "record.env")), false, "the record is consumed");

  // The rolled-back daemon hands off to the same sha again and it dies early again: the normal crash route.
  const v = world(t);
  const twice = run(v, daemon(v, { handOff: [1, 2], successorExit: 1, laterExit: 0 }));
  assert.equal(twice.status, 1, twice.err);
  assert.equal(twice.err.match(/handoff_rolled_back/g)?.length, 1, "one rollback per bad sha");
  assert.match(twice.err, /sleeping 1s before exiting/, "the second early death is a counted crash");

  // A deliberate freshness exit is never a rollback: 75 takes the freshness route and re-syncs.
  const f = world(t);
  const fresh = run(f, daemon(f, { handOff: [1], successorExit: 75, laterExit: 0 }));
  assert.equal(fresh.status, 0, fresh.err);
  assert.doesNotMatch(fresh.err, /handoff_rolled_back/);
  assert.match(fresh.err, /exited 75 \(freshness\)/);

  // Past the window, a crash is a crash.
  const l = world(t);
  const late = run(l, daemon(l, { handOff: [1], successorExit: 1, laterExit: 0, ageMs: 16 * 60_000 }));
  assert.equal(late.status, 1, late.err);
  assert.doesNotMatch(late.err, /handoff_rolled_back/);

  // Never while a live daemon holds the drain lock (this test process plays the holder).
  const k = world(t);
  mkdirSync(join(k.home, "Remudero", "state"), { recursive: true });
  writeFileSync(join(k.home, "Remudero", "state", "drain.lock"), JSON.stringify({ pid: process.pid, host: "test", startedAt: new Date().toISOString() }));
  const locked = run(k, daemon(k, { handOff: [1], successorExit: 1, laterExit: 0 }));
  assert.equal(locked.status, 1, locked.err);
  assert.doesNotMatch(locked.err, /handoff_rolled_back/);
});
