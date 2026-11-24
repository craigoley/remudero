/**
 * W1-T14732 — AN UNREADABLE PROGRESS VERDICT NAMES WHY.
 *
 * The launcher's read_progress_verdict (deploy/install-host-units.sh, render_progress_watchdog_ladder) runs
 * `rmd progress-watchdog --json` and, on a non-zero exit, logs the verdict unreadable and acts as before. Its
 * stderr used to go to /dev/null, so the host could not tell a timeout from a throw. The line now carries the exit
 * code and the verb's last stderr line; what the ladder does with an unreadable verdict is unchanged.
 *
 * REAL BASH: the ladder's literal text is sourced, and `bin/rmd` is a stand-in that fails.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** The ladder's text exactly as the installer renders it: the body of its quoted heredoc. */
function ladder(): string {
  const lines = readFileSync(join(REPO_ROOT, "deploy", "install-host-units.sh"), "utf8").split("\n");
  const start = lines.indexOf("render_progress_watchdog_ladder() {");
  const end = lines.indexOf("PROGRESS_WATCHDOG_LADDER", start);
  assert.ok(start >= 0 && end > start, "the ladder renderer is where this test expects it");
  return lines.slice(start + 2, end).join("\n") + "\n";
}

function read(t: TestContext, rmdBody: string[]): { status: number | null; out: string; err: string; tmp: string[] } {
  const root = ownedFixtureDir(t, "progress-verdict").dir;
  const code = join(root, "code");
  const tmp = join(root, "tmp");
  mkdirSync(join(code, "bin"), { recursive: true });
  mkdirSync(join(root, "state", "state"), { recursive: true });
  mkdirSync(tmp);
  writeFileSync(join(code, "bin", "rmd"), ["#!/usr/bin/env bash", ...rmdBody, ""].join("\n"));
  chmodSync(join(code, "bin", "rmd"), 0o755);
  writeFileSync(join(root, "ladder.sh"), ladder());
  const r = spawnSync("bash", ["-c", [
    `STATE_DIR="${join(root, "state")}"; REVIVAL_LOG="${join(root, "revivals.log")}"; DAEMON_CODE="${code}"`,
    "daemon_code_resolve() { :; }",
    `. "${join(root, "ladder.sh")}"`,
    "PROGRESS_STATE=stale; PROGRESS_ACTION=stale; PROGRESS_VERDICT=stale",
    "read_progress_verdict; rc=$?",
    'printf "rc=%s state=[%s] action=[%s] verdict=[%s]\\n" "$rc" "$PROGRESS_STATE" "$PROGRESS_ACTION" "$PROGRESS_VERDICT"',
  ].join("\n")], { encoding: "utf8", env: { ...process.env, TMPDIR: tmp }, timeout: 30_000 });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "", tmp: readdirSync(tmp) };
}

test("W1-T14732 an unreadable progress verdict names the exit code and the last stderr line", async (t) => {
  const r = read(t, ["echo 'loading the ledger union' >&2", "echo 'RangeError: Invalid string length' >&2", "echo >&2", "exit 3"]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /rmd-relaunch: progress-watchdog -- verdict unreadable \(exit 3: RangeError: Invalid string length\); acting as before\./);
  assert.deepEqual(r.tmp, [], "the stderr capture is removed");

  const slow = read(t, ["exit 124"]);
  assert.match(slow.err, /verdict unreadable \(exit 124, timed out: no stderr\)/);
});

test("W1-T14732 an unreadable progress verdict still sets no state or action", async (t) => {
  const r = read(t, ["echo boom >&2", "exit 1"]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^rc=0 state=\[\] action=\[\] verdict=\[\]$/m);
  // The unreadable verdict that sets nothing is the named one, and its capture is removed with it.
  assert.match(r.err, /verdict unreadable \(exit 1: boom\); acting as before\./);
  assert.deepEqual(r.tmp, []);

  // A readable verdict is read as before, and its stderr capture is removed too.
  const ok = read(t, ["echo 'a warning' >&2", `echo '{"state":"progressing","action":"none"}'`]);
  assert.match(ok.out, /^rc=0 state=\[progressing\] action=\[none\] /m);
  assert.match(ok.out, /progress-watchdog -- progressing action=none/);
  assert.deepEqual(ok.tmp, []);
});
