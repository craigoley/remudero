// W1-T12360: host-update.sh printed a daemon command from its own copy of the Claude directory path,
// with no account file mount. These tests run the real script in its print mode with a temp HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HOST_UPDATE = join(REPO_ROOT, "deploy", "host-update.sh");
const CLAUDE_DIRECTORY = join(REPO_ROOT, "deploy", "claude-directory.sh");
const ACCOUNT_DEST = "/home/node/.rmd-claude-account.json";

function home(t: TestContext): string {
  const dir = ownedFixtureDir(t, "w1-t12360-home").dir;
  mkdirSync(join(dir, ".claude"));
  return dir;
}

function printDaemonRun(script: string, env: NodeJS.ProcessEnv) {
  const run = spawnSync("bash", [script, "--print-daemon-run"], {
    encoding: "utf8", cwd: env.HOME, env: { PATH: process.env.PATH, RMD_SCRATCH: "off", ...env },
  });
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout;
  const daemon = out.slice(out.indexOf("docker run -d --name remudero-daemon"), out.indexOf("./bin/rmd daemon"));
  const serve = out.slice(out.indexOf("docker run -d --name remudero-serve"));
  assert.ok(daemon.length > 100 && serve.length > 100, `both printed blocks are present: ${out}`);
  return { daemon, serve, stderr: run.stderr, all: `${out}${run.stderr}` };
}

function sharedDirectory(env: NodeJS.ProcessEnv): string {
  const run = spawnSync("bash", ["-c", 'set -euo pipefail; source "$1"; claude_host_directory', "probe", CLAUDE_DIRECTORY], {
    encoding: "utf8", env: { PATH: process.env.PATH, ...env },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test("W1-T12360: host-update takes the Claude directory from the shared function", (t) => {
  const dir = home(t);
  const copy = join(dir, "deploy");
  mkdirSync(copy);
  copyFileSync(HOST_UPDATE, join(copy, "host-update.sh"));
  const only = join(dir, "only-the-shared-function-gives-this");
  writeFileSync(join(copy, "claude-directory.sh"),
    `claude_host_directory() { printf '%s\\n' '${only}'; }\nclaude_host_account_file() { printf '%s\\n' '${only}.json'; }\n`);
  const env = { HOME: dir, RMD_CLAUDE_DIR: join(dir, "env-claude") };
  const copied = printDaemonRun(join(copy, "host-update.sh"), env);
  assert.ok(copied.daemon.includes(`-v ${only}:/home/node/.claude \\`), `the mount follows the shared function: ${copied.daemon}`);
  assert.ok(copied.stderr.includes(`${only}/.credentials.json`), "the credential check reads the same directory");
  assert.ok(!copied.all.includes(join(dir, "env-claude")), "no local default is left in the script");

  for (const pinned of [{ HOME: dir }, env]) {
    const real = printDaemonRun(HOST_UPDATE, pinned);
    assert.ok(real.daemon.includes(`-v ${sharedDirectory(pinned)}:/home/node/.claude \\`),
      `HOME and RMD_CLAUDE_DIR give the launchers' path: ${real.daemon}`);
  }
});

test("W1-T12360: the printed daemon command mounts the account file read-only", (t) => {
  const dir = home(t);
  const account = join(dir, ".claude.json");
  writeFileSync(account, `${JSON.stringify({ oauthAccount: { emailAddress: "marker-5b2e@example.test" } })}\n`);
  const run = printDaemonRun(HOST_UPDATE, { HOME: dir });
  const credMount = run.daemon.indexOf(`-v ${join(dir, ".claude")}:/home/node/.claude \\`);
  const accountMount = run.daemon.indexOf(`-v ${account}:${ACCOUNT_DEST}:ro \\`);
  assert.ok(credMount >= 0 && accountMount > credMount, `the account mount sits beside the directory mount: ${run.daemon}`);
  assert.ok(!run.serve.includes(ACCOUNT_DEST), "the printed serve command has no account file mount");
  assert.ok(!run.all.includes("no Claude account file"), "no note when the file exists");
  assert.ok(!run.all.includes("marker-5b2e"), "the file content is never printed");
});

test("W1-T12360: with no account file the printed command has no account mount", (t) => {
  const dir = home(t);
  const run = printDaemonRun(HOST_UPDATE, { HOME: dir });
  assert.ok(!run.all.includes(ACCOUNT_DEST), `no account file mount is printed: ${run.daemon}`);
  const notes = run.all.split("\n").filter((line) => line.includes("no Claude account file"));
  assert.deepEqual(notes, [
    `host-update: NOTE — no Claude account file at ${join(dir, ".claude.json")}; printing the daemon without an account file mount`,
  ]);
});
