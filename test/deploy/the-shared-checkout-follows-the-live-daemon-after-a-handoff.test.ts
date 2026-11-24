/**
 * W1-T14730 — THE SHARED CHECKOUT FOLLOWS THE LIVE DAEMON AFTER A HANDOFF.
 *
 * After a blue-green handoff (exit 79) the successor runs from its own daemon slot, but the host watchdog and the
 * deploy read the daemon's code as the shared checkout's HEAD. The entrypoint moves that checkout to the successor's
 * sha when it takes the run, and back to the predecessor's sha on a rollback, so the two never disagree.
 *
 * REAL BASH and a real git origin with two commits, as test/deploy/a-promoted-daemon-that-dies-early-rolls-back-once.test.ts:
 * the "daemon" is a bash stand-in that records the checkout's HEAD each time it starts.
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

function script(path: string, lines: string[]): string {
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines, ""].join("\n"), { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

interface World { home: string; tree: string; dir: string; older: string; newer: string; heads: string; env: NodeJS.ProcessEnv }

function world(t: TestContext): World {
  const home = ownedFixtureDir(t, "follow-home").dir;
  const stubs = ownedFixtureDir(t, "follow-stub").dir;
  script(join(stubs, "npm"), ["if [ \"$1\" = \"ci\" ]; then mkdir -p node_modules/.bin; printf '#!/bin/sh\\n' > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi", "exit 0"]);
  const origin = gitRepo({ scope: t, seedCommit: false, kind: "follow-origin" });
  writeFileSync(join(origin.dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  mkdirSync(join(origin.dir, "bin"), { recursive: true });
  script(join(origin.dir, "bin", "rmd"), ["exit 0"]);
  origin.git("add", "-A");
  origin.git("commit", "-qm", "c1");
  const older = origin.git("rev-parse", "HEAD").trim();
  writeFileSync(join(origin.dir, "next.txt"), "c2\n");
  origin.git("add", "-A");
  origin.git("commit", "-qm", "c2");
  const newer = origin.git("rev-parse", "HEAD").trim();
  const dir = ownedFixtureDir(t, "follow-standin").dir;
  return {
    home, tree: join(home, "Remudero", "remudero"), dir, older, newer, heads: join(dir, "heads"),
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}`, HOME: home, RMD_REPO_URL: origin.dir, RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", RMD_RESTART_THROTTLE_S: "1", RMD_FRESHNESS_RESTART_PAUSE_S: "0",
      RMD_HANDOFF_WATCH_INTERVAL_S: "1" },
  };
}

/**
 * The supervised command. Each call appends the checkout's HEAD to `heads`. The first call starts a successor that
 * exits `successorExit` after a second, names it in successor.pid and record.env (predecessor: the checkout at its
 * HEAD; successor: `successorSha` in a slot), and exits 79; every later call exits 0.
 */
function daemon(w: World, o: { successorSha: string; successorExit: number }): string {
  const successor = script(join(w.dir, "daemon-successor.sh"), [`dir="$1"; sleep 1; echo ${o.successorExit} > "$dir/$$.exit"; exit ${o.successorExit}`]);
  return script(join(w.dir, "old-daemon.sh"), [
    `calls="${w.dir}/calls"`,
    'n=$(( $(cat "$calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$calls"',
    `git -C "${w.tree}" rev-parse HEAD >> "${w.heads}"`,
    '[ "$n" -eq 1 ] || exit 0',
    'dir="$HOME/Remudero/state/daemon-handoff"; mkdir -p "$dir"',
    `bash "${successor}" "$dir" </dev/null >/dev/null 2>&1 &`,
    'echo "$! DAEMON-SUCCESSOR-$n" > "$dir/successor.pid"',
    `printf 'predecessor_sha=%s\\npredecessor_tree=%s\\nsuccessor_sha=${o.successorSha}\\nsuccessor_tree=/slots/a\\nsuccessor_run_id=DAEMON-SUCCESSOR-%s\\nyielded_at_ms=%s\\n' "$(git -C "${w.tree}" rev-parse HEAD)" "${w.tree}" "$n" "$(date +%s%3N)" > "$dir/record.env"`,
    "exit 79",
  ]);
}

function run(w: World, command: string): { status: number | null; err: string; heads: string[]; head: string } {
  const r = spawnSync("bash", [SCRIPT, "bash", command], { encoding: "utf8", cwd: REPO_ROOT, env: w.env, timeout: 90_000 });
  const head = spawnSync("git", ["-C", w.tree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  return { status: r.status, err: r.stderr ?? "", heads: existsSync(w.heads) ? readFileSync(w.heads, "utf8").trim().split("\n") : [], head };
}

test("W1-T14730 the shared checkout moves to the successor's sha when the successor takes the run", async (t) => {
  const w = world(t);
  const r = run(w, daemon(w, { successorSha: w.older, successorExit: 0 }));
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.heads, [w.newer], "the predecessor booted on the synced checkout");
  assert.match(r.err, new RegExp(`handoff_tree_followed: \\S+ moved from ${w.newer} to ${w.older}`));
  assert.equal(r.head, w.older, "the shared checkout names the sha the live daemon runs");
});

test("W1-T14730 a rollback first moves the shared checkout to the predecessor sha", async (t) => {
  const w = world(t);
  const r = run(w, daemon(w, { successorSha: w.older, successorExit: 1 }));
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /handoff_rolled_back/);
  assert.deepEqual(r.heads, [w.newer, w.newer], "the rolled-back start runs the predecessor's code from the checkout");
  assert.equal(r.head, w.newer);
});

test("W1-T14730 a successor sha the checkout cannot reach leaves it where it is and says so", async (t) => {
  const w = world(t);
  const r = run(w, daemon(w, { successorSha: "c".repeat(40), successorExit: 0 }));
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, new RegExp(`handoff_tree_unmoved: \\S+ stays at ${w.newer}: commit c{40} is not in it after a fetch`));
  assert.equal(r.head, w.newer);
});
