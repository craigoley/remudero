// W1-T12293: a daemon container lost ~/.claude.json on every recreate, because the launcher mounts
// ~/.claude but not the account file beside it. These tests run the real shell steps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const CLAUDE_DIRECTORY = join(REPO_ROOT, "deploy", "claude-directory.sh");
const ENTRYPOINT = join(REPO_ROOT, "deploy", "entrypoint.sh");

/** A login the CLI wrote, with a marker that must never reach the log. */
const LOGIN = `${JSON.stringify({ oauthAccount: { emailAddress: "secret-marker-7f3a@example.test", accountUuid: "u-1" }, numStartups: 9 })}\n`;
/** The thin file the CLI writes when it finds none (84 bytes on the host, 2026-11-11). */
const THIN = `${JSON.stringify({ firstStartTime: "2026-11-11T11:48:00.000Z", userID: "thin-marker-0c1d" })}\n`;

function accountFile(env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-c", 'set -euo pipefail; source "$1"; claude_host_account_file', "probe", CLAUDE_DIRECTORY], {
    encoding: "utf8", env: { PATH: process.env.PATH, ...env },
  });
}

function boot(t: TestContext, files: { target?: string; side?: string }) {
  const home = ownedFixtureDir(t, "w1-t12293-home").dir;
  const target = join(home, ".claude.json");
  const side = join(home, ".rmd-claude-account.json");
  if (files.target !== undefined) writeFileSync(target, files.target);
  if (files.side !== undefined) writeFileSync(side, files.side);
  const ran = join(home, "command-ran");
  const run = spawnSync("bash", [ENTRYPOINT, "touch", ran], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, RMD_SKIP_BOOTSTRAP: "1", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(ran), "the container command still runs");
  const lines = run.stderr.split("\n").filter((l) => l.includes("claude account file"));
  assert.equal(lines.length, 1, `one line says which case ran: ${run.stderr}`);
  for (const marker of ["secret-marker-7f3a", "thin-marker-0c1d", "other-marker-92be"]) {
    assert.ok(!(run.stdout + run.stderr).includes(marker), "the content of either file is never printed");
  }
  return { home, target, line: lines[0]!, leftovers: readdirSync(home).filter((n) => n.includes("rmd-seed")) };
}

test("W1-T12293 criterion 1: the account file is the Claude directory path with .json added, and one override", () => {
  const dflt = accountFile({ HOME: "/fixture/home" });
  assert.equal(dflt.status, 0, dflt.stderr);
  assert.equal(dflt.stdout, "/fixture/home/.claude.json\n");
  assert.equal(accountFile({ HOME: "/fixture/home", RMD_CLAUDE_DIR: "/srv/claude-store/" }).stdout, "/srv/claude-store.json\n");
  assert.equal(accountFile({ HOME: "/fixture/home", RMD_CLAUDE_DIR: "/srv/claude-store", RMD_CLAUDE_JSON_PATH: "/srv/account.json" }).stdout,
    "/srv/account.json\n");
  const failed = spawnSync("bash", ["-c",
    'source "$1"; claude_host_directory() { return 17; }; claude_host_account_file; echo "rc=$?"', "probe", CLAUDE_DIRECTORY], { encoding: "utf8" });
  assert.equal(failed.stdout.trim(), "rc=17", "a failed directory derivation gives no account path");
});

test("W1-T12293 criterion 5: a missing account file is seeded from the host copy, mode 0600, through a rename", (t) => {
  const run = boot(t, { side: LOGIN });
  assert.equal(readFileSync(run.target, "utf8"), LOGIN);
  assert.equal(statSync(run.target).mode & 0o777, 0o600);
  assert.equal(run.leftovers.length, 0, "no temp file is left");
  assert.match(run.line, /seeded from the host copy \(it was missing\)/);
});

test("W1-T12293 criterion 6: an account file that holds no login is replaced from the host copy", (t) => {
  const run = boot(t, { target: THIN, side: LOGIN });
  assert.equal(readFileSync(run.target, "utf8"), LOGIN);
  assert.equal(statSync(run.target).mode & 0o777, 0o600);
  assert.match(run.line, /seeded from the host copy \(it held no login\)/);
});

test("W1-T12293 criterion 7: a file that holds a login is kept, and a host copy with no login is never copied", (t) => {
  const own = `${JSON.stringify({ oauthAccount: { emailAddress: "other-marker-92be@example.test" } })}\n`;
  const kept = boot(t, { target: own, side: LOGIN });
  assert.equal(readFileSync(kept.target, "utf8"), own);
  assert.match(kept.line, /kept/);
  const thinSide = boot(t, { target: THIN, side: THIN.replace("thin-marker-0c1d", "other-marker-92be") });
  assert.equal(readFileSync(thinSide.target, "utf8"), THIN);
  assert.match(thinSide.line, /NOT seeded .*holds no login/);
  const absent = boot(t, { side: "{}" });
  assert.equal(existsSync(absent.target), false);
  assert.match(absent.line, /NOT seeded/);
});

test("W1-T12293 criterion 8: no host copy, or one that is not JSON, changes nothing and the command runs", (t) => {
  const none = boot(t, {});
  assert.equal(existsSync(none.target), false);
  assert.match(none.line, /no host copy/);
  const thin = boot(t, { target: THIN });
  assert.equal(readFileSync(thin.target, "utf8"), THIN);
  const garbled = boot(t, { side: "{ not json other-marker-92be" });
  assert.equal(existsSync(garbled.target), false);
  assert.match(garbled.line, /NOT seeded/);
});
