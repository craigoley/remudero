import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DAEMON_EXIT_BLOCKED, DAEMON_EXIT_STALE } from "../src/lib/daemon.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "entrypoint.sh");

/**
 * `deploy/entrypoint.sh` IS THE BOOT PATH FOR EVERY CONTAINER RUN — it clones, checks out,
 * installs, writes the git identity and the credential helper, then execs. FOUR defects have been
 * found in it BY HAND, each after it shipped:
 *
 *   1. `git config --global` fails outright when HOME does not exist.
 *   2. Counting UNTRACKED files as dirt made boot 2 refuse to sync, because boot 1 had just created
 *      `node_modules` — pinning the container to its first clone forever while blaming the operator.
 *   3. `git fetch` updates only remote-tracking refs, so `checkout --detach main` resolved a LOCAL
 *      branch frozen at clone time and walked HEAD BACKWARD on every boot, with a silenced
 *      `merge --ff-only` as the only thing climbing back up.
 *   4. The identity write sat BELOW the `RMD_SKIP_BOOTSTRAP` block, which ends in `exec` and never
 *      returns — so the fix was unreachable on exactly the path an operator uses to inspect a
 *      broken tree, which is when they most need to commit.
 *
 * REAL GIT, STUBBED npm — and that choice is deliberate rather than convenient. The sibling suites
 * (test/verify-image-probes.test.ts, test/host-update-reclaim.test.ts) stub `docker`/`az` because
 * those are unavailable here. `git` is not: it is the thing under test, and every one of the four
 * defects above is a statement about what git actually does with refs, untracked files and frozen
 * local branches. A stub would have to model that behaviour — and a test whose fixture models the
 * bug cannot discover it. So this manufactures a REAL origin, does REAL clones and REAL checkouts,
 * the same approach deploy/verify-image.sh's own bootstrap section takes inside the image. Only
 * `npm` is stubbed, because the one thing genuinely unwanted here is a multi-minute install.
 *
 * `GIT_CONFIG_NOSYSTEM=1` on every run: a system-level identity on the host would make the
 * "already configured" branch fire and silently turn the identity tests into no-ops.
 */

interface Boot {
  status: number;
  stdout: string;
  stderr: string;
  /** argv of every stubbed `npm` invocation, in order. */
  npmCalls: string[][];
}

/** A git origin with one commit, plus the package files a real clone would carry. */
function makeOrigin(): string {
  const origin = mkdtempSync(join(tmpdir(), "entrypoint-origin-"));
  git(origin, ["init", "-q", "-b", "main"]);
  writeFileSync(join(origin, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(join(origin, "first.txt"), "one\n");
  git(origin, ["add", "-A"]);
  commit(origin, "c1");
  return origin;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/** Commit with an explicit identity, so the fixture never depends on the host's git config. */
function commit(cwd: string, message: string): string {
  spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd },
  });
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Add a commit to the origin that creates `file`, and return the new sha. */
function advanceOrigin(origin: string, file: string, body: string): string {
  writeFileSync(join(origin, file), body);
  git(origin, ["add", "-A"]);
  return commit(origin, `add ${file}`);
}

/**
 * The `npm` stub: records argv, and on `ci` creates the one artefact the script's install condition
 * looks for. Without that, boot 2 could never take the "already installed" branch and half the
 * install assertions would be untestable.
 */
function writeNpmStub(dir: string, rec: string): void {
  const npm = [
    "#!/usr/bin/env bash",
    `printf '%s' "npm" >> "${rec}/npm"`,
    `for a in "$@"; do printf '\\t%s' "$a" >> "${rec}/npm"; done`,
    `printf '\\n' >> "${rec}/npm"`,
    'if [ "$1" = "ci" ]; then mkdir -p node_modules/.bin; printf "#!/bin/sh\\n" > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi',
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "npm"), npm, { mode: 0o755 });
  chmodSync(join(dir, "npm"), 0o755);
}

/**
 * Boot the real entrypoint against `home`, which persists across calls so a SECOND boot sees the
 * tree the first one left. That persistence is the whole point: three of the four defects only
 * appear on boot 2.
 */
function boot(
  home: string,
  origin: string,
  opts: { ref?: string; env?: Record<string, string>; cmd?: string[]; script?: string; cwd?: string } = {},
): Boot {
  const stubs = mkdtempSync(join(tmpdir(), "entrypoint-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "entrypoint-rec-"));
  writeNpmStub(stubs, rec);
  const r = spawnSync("bash", [opts.script ?? SCRIPT, ...(opts.cmd ?? ["true"])], {
    encoding: "utf8",
    // NOT `home`: one test deliberately points HOME at a path that does not exist yet, and
    // spawnSync cannot chdir into it.
    cwd: opts.cwd ?? REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: opts.ref ?? "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...(opts.env ?? {}),
    },
  });
  let npmCalls: string[][] = [];
  try {
    npmCalls = readFileSync(join(rec, "npm"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t").slice(1));
  } catch {
    npmCalls = [];
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", npmCalls };
}

const treeOf = (home: string) => join(home, "Remudero", "remudero");
const headOf = (home: string) => git(treeOf(home), ["rev-parse", "HEAD"]);
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "entrypoint-home-"));
}

/**
 * A repository carrying an EXPLICIT LOCAL identity, for use as a boot cwd.
 *
 * Mutant 5 turns on local-vs-global config resolution, so the two readings have to provably
 * disagree. Booting from this repo's own checkout looked like it supplied that — and does here,
 * where `.git/config` names a committer — but a GitHub runner's checkout has no local identity, so
 * the bare read falls through to the global one the script just wrote, both readings agree, and the
 * mutant test fails on CI while passing locally. It did exactly that. The condition belongs to the
 * fixture, not to whichever tree the suite happens to be running in.
 */
function makeCwdRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "entrypoint-cwd-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "--local", "user.name", "CwdRepo"]);
  git(repo, ["config", "--local", "user.email", "cwd@example.invalid"]);
  return repo;
}

/**
 * FORCE GIT TO REFUSE A GUESSED IDENTITY — the same lesson as `makeCwdRepo`, in the other direction.
 *
 * With no `user.email` anywhere, git does not necessarily fail: it GUESSES `user@fqdn` from the
 * passwd entry and `gethostname`, and accepts that guess whenever the hostname looks domain-like.
 * On a GitHub runner the hostname carries no domain, the guess is rejected, and a commit fails —
 * which is what the defect-4 pair asserts. On this mini, Tailscale MagicDNS supplies an FQDN
 * (`…tail17e13a.ts.net`), git accepts the guess, and the SAME commit SUCCEEDS. So the mutant test
 * passed on CI and failed wherever proofs execute, and the positive test passed for the wrong
 * reason on any host that can guess.
 *
 * `user.useConfigOnly` is git's own switch for exactly this: an identity must come from config or
 * the commit fails. Set through `GIT_CONFIG_*` it reaches the probe's git through the entrypoint's
 * `exec` without touching the script, and it leaves the thing under test alone — the entrypoint
 * still writes the identity into `$HOME/.gitconfig`, and that write is now the ONLY thing that can
 * make the commit succeed, on every host.
 */
const NO_GUESSED_IDENTITY = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "user.useConfigOnly",
  GIT_CONFIG_VALUE_0: "true",
};

// ── DEFECT 3: A BRANCH MEANS THE TIP AS OF THIS BOOT ────────────────────────────────────────

test("a BRANCH ref lands on the freshly-fetched tip, and a SECOND boot ADVANCES when the remote moved", () => {
  // THE REGRESSION LOCK for the measured Azure defect: `git fetch` moves only remote-tracking refs,
  // so a checkout that resolved the LOCAL branch walked HEAD backward to the clone-time sha on every
  // boot — and reported a clean "checkout:" line while doing it.
  const home = freshHome();
  const origin = makeOrigin();
  const c1 = git(origin, ["rev-parse", "HEAD"]);

  const first = boot(home, origin);
  assert.equal(first.status, 0, `first boot failed: ${first.stderr}`);
  assert.equal(headOf(home), c1, "the first boot must land on the tip that existed then");

  const c2 = advanceOrigin(origin, "second.txt", "two\n");
  assert.notEqual(c1, c2);

  const second = boot(home, origin);
  assert.equal(second.status, 0, `second boot failed: ${second.stderr}`);
  assert.equal(headOf(home), c2, "the SECOND boot must advance to the moved tip, not walk back to the clone-time sha");
});

test("a SHA ref pins exactly, even when the branch has moved past it", () => {
  // The other direction of the same resolver. If a branch and a sha resolved the same way, RMD_REF
  // would not be a pin at all, and "run exactly this code again" would be unavailable.
  const home = freshHome();
  const origin = makeOrigin();
  const c1 = git(origin, ["rev-parse", "HEAD"]);
  const c2 = advanceOrigin(origin, "second.txt", "two\n");

  const run = boot(home, origin, { ref: c1 });
  assert.equal(run.status, 0, `boot failed: ${run.stderr}`);
  assert.equal(headOf(home), c1, "a sha must pin exactly");
  assert.notEqual(headOf(home), c2, "and must NOT follow the branch");
});

// ── DEFECTS 2 AND 3 PULL IN OPPOSITE DIRECTIONS, SO BOTH ARE PROVEN ─────────────────────────

test("an untracked COLLISION refuses loudly rather than running on a stale HEAD", () => {
  // Defect 3's silent half: the tracked-only dirty guard correctly calls this tree clean, git
  // refuses to overwrite the untracked file, and the old code discarded that error and carried on
  // at the regressed sha while printing success.
  const home = freshHome();
  const origin = makeOrigin();
  const first = boot(home, origin);
  assert.equal(first.status, 0);
  const before = headOf(home);

  // An UNTRACKED file at a path the incoming commit also adds.
  writeFileSync(join(treeOf(home), "collide.txt"), "local\n");
  advanceOrigin(origin, "collide.txt", "incoming\n");

  const second = boot(home, origin);
  assert.notEqual(second.status, 0, "a checkout that cannot proceed must DIE, not continue");
  assert.match(second.stderr, /CHECKOUT FAILED/, "and it must say so by name");
  assert.equal(headOf(home), before, "HEAD must be left where it was, not silently regressed");
});

test("an untracked NON-colliding file (node_modules) does NOT block the sync", () => {
  // Defect 2, and it pulls the opposite way from the test above: counting untracked files as dirt
  // made boot 2 refuse forever, because boot 1 had just installed node_modules. `-uno` is what
  // separates the two cases, and only having both tests makes that separation a locked behaviour.
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);
  assert.ok(existsSync(join(treeOf(home), "node_modules", ".bin", "tsx")), "boot 1 must have installed");

  const c2 = advanceOrigin(origin, "second.txt", "two\n");
  const second = boot(home, origin);
  assert.equal(second.status, 0, `second boot failed: ${second.stderr}`);
  assert.doesNotMatch(second.stderr, /REFUSING to sync/, "node_modules is untracked, and untracked files cannot conflict with a fast-forward");
  assert.equal(headOf(home), c2, "so the sync must proceed");
});

test("a TRACKED modification still refuses, so the -uno relaxation did not disable the guard", () => {
  // The negative control for the test above. Relaxing to `-uno` must not mean "never refuse".
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);
  const before = headOf(home);

  writeFileSync(join(treeOf(home), "first.txt"), "locally modified\n");
  advanceOrigin(origin, "second.txt", "two\n");

  const second = boot(home, origin);
  assert.match(second.stderr, /REFUSING to sync/, "uncommitted TRACKED work must still stop the sync");
  assert.equal(headOf(home), before, "and nothing may be discarded");
});

// ── W1-T1054: A PROVABLY-REDUNDANT UNTRACKED FILE CLEARS ITSELF, BEFORE THE CHECKOUT ───────────
// The daemon writes `plan/feedback/**` into this SAME working tree and later lands the identical
// content upstream (rationale (1)-(2) of the shard). That produces exactly the collision above —
// untracked locally, added by the incoming commit — except with IDENTICAL bytes, which the guard
// above can now prove safe to clear rather than dying on.

test("entrypoint: an identical untracked file at an incoming path is cleared and the boot proceeds", () => {
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);

  // Untracked locally with the EXACT bytes the incoming commit is about to add at the same path —
  // the shape a daemon that writes into its own boot checkout and then lands that content upstream
  // produces on every recurring sweep.
  writeFileSync(join(treeOf(home), "collide.txt"), "same\n");
  const c2 = advanceOrigin(origin, "collide.txt", "same\n");

  const second = boot(home, origin);
  assert.equal(second.status, 0, `second boot failed: ${second.stderr}`);
  assert.equal(headOf(home), c2, "the checkout must proceed onto the incoming commit");
  assert.equal(readFileSync(join(treeOf(home), "collide.txt"), "utf8"), "same\n", "and land the now-tracked copy");
});

test("entrypoint: a differing untracked file at an incoming path still refuses", () => {
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);
  const before = headOf(home);

  writeFileSync(join(treeOf(home), "collide.txt"), "local\n");
  advanceOrigin(origin, "collide.txt", "incoming\n");

  const second = boot(home, origin);
  assert.notEqual(second.status, 0, "different bytes are not provably redundant, so the boot must still refuse");
  assert.match(second.stderr, /CHECKOUT FAILED/, "and say so by name, exactly as before this change");
  assert.equal(headOf(home), before, "HEAD must be left where it was");
  assert.equal(readFileSync(join(treeOf(home), "collide.txt"), "utf8"), "local\n", "and the local file must be untouched, not discarded");
});

test("entrypoint: an untracked file outside the incoming diff is never removed", () => {
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);

  writeFileSync(join(treeOf(home), "untouched.txt"), "nobody claims this path\n");
  const c2 = advanceOrigin(origin, "second.txt", "two\n");

  const second = boot(home, origin);
  assert.equal(second.status, 0, `second boot failed: ${second.stderr}`);
  assert.equal(headOf(home), c2);
  assert.ok(existsSync(join(treeOf(home), "untouched.txt")), "an untracked file the incoming commit never touches must survive");
  assert.doesNotMatch(second.stderr, /clearing untracked 'untouched\.txt'/, "and must never be named as cleared");
});

test("entrypoint: every cleared path is named in the log before removal", () => {
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);

  writeFileSync(join(treeOf(home), "collide.txt"), "same\n");
  advanceOrigin(origin, "collide.txt", "same\n");

  const second = boot(home, origin);
  assert.equal(second.status, 0, `second boot failed: ${second.stderr}`);
  assert.match(
    second.stderr,
    /clearing untracked 'collide\.txt': the incoming commit adds this exact path with identical bytes/,
    "the discard must be named, not silent, even on a boot that then succeeds",
  );
});

test("entrypoint: an unreadable incoming blob refuses instead of clearing", () => {
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin).status, 0);
  const before = headOf(home);

  writeFileSync(join(treeOf(home), "collide.txt"), "same\n");
  advanceOrigin(origin, "collide.txt", "same\n");

  // Fetch the incoming commit into the tree's OWN object store first, then corrupt the blob from
  // under a resolvable tree. `git rev-parse "$target:$path"` only needs the TREE object to answer,
  // not the blob's content, so this reproduces "the path resolves but the object cannot be read"
  // without needing a genuinely broken remote.
  git(treeOf(home), ["fetch", "-q", "origin"]);
  const blob = git(treeOf(home), ["rev-parse", "origin/main:collide.txt"]);
  const objectPath = join(treeOf(home), ".git", "objects", blob.slice(0, 2), blob.slice(2));
  assert.ok(existsSync(objectPath), "the fetch must have written the blob as a loose object");
  unlinkSync(objectPath);

  const second = boot(home, origin);
  assert.notEqual(second.status, 0, "an unreadable blob is not provably redundant, so the boot must refuse");
  assert.match(second.stderr, /cannot read the incoming blob/, "and say why, rather than silently leaving it or clearing it");
  assert.match(second.stderr, /CHECKOUT FAILED/, "the checkout must still refuse, exactly as an ordinary collision does");
  assert.equal(headOf(home), before, "HEAD must be left where it was");
  assert.equal(readFileSync(join(treeOf(home), "collide.txt"), "utf8"), "same\n", "and the local file must be untouched");
});

// ── DEFECT 4: THE IDENTITY IS WRITTEN ABOVE THE SKIP ────────────────────────────────────────

test("RMD_SKIP_BOOTSTRAP=1 still gets a git identity, so the recovery path can commit", () => {
  // The skip `exec`s and never returns, so anything below it is unreachable on this path — which is
  // exactly the path the script's own failure messages tell an operator to use to inspect a broken
  // tree by hand. Someone salvaging uncommitted work is precisely who needs to commit.
  const home = freshHome();
  const origin = makeOrigin();
  const probe = mkdtempSync(join(tmpdir(), "entrypoint-probe-"));
  const run = boot(home, origin, {
    env: { RMD_SKIP_BOOTSTRAP: "1", ...NO_GUESSED_IDENTITY },
    cmd: [
      "bash",
      "-c",
      `cd ${probe} && git init -q -b main . && echo x > f && git add f && git commit -qm probe && git log -1 --format='COMMITTED-AS %an <%ae>'`,
    ],
  });
  assert.equal(run.status, 0, `the commit must succeed under the skip: ${run.stderr}`);
  assert.match(run.stdout, /^COMMITTED-AS .+ <.+@.+>$/m, "and it must carry a real identity");
});

test("RMD_GIT_AUTHOR_NAME/_EMAIL override the default, and the default is used when they are unset", () => {
  const origin = makeOrigin();

  const dflt = boot(freshHome(), origin, { env: { RMD_SKIP_BOOTSTRAP: "1" } });
  assert.match(dflt.stderr, /remudero-worker/, "the default identity must be used when nothing is set");

  const over = boot(freshHome(), origin, {
    env: { RMD_SKIP_BOOTSTRAP: "1", RMD_GIT_AUTHOR_NAME: "Fleet Operator", RMD_GIT_AUTHOR_EMAIL: "ops@example.invalid" },
  });
  assert.match(over.stderr, /Fleet Operator <ops@example\.invalid>/, "the override must win");
  assert.doesNotMatch(over.stderr, /remudero-worker/, "and the default must not also appear");
});

// ── THE CREDENTIAL NEVER LANDS ON THE VOLUME ────────────────────────────────────────────────

test("the credential helper stores the VARIABLE NAME, never the token value", () => {
  // The whole reason for a helper rather than a token-bearing remote: the gitconfig lives in the
  // mounted volume and OUTLIVES the container. A value here would be a secret on the operator's disk.
  const home = freshHome();
  const origin = makeOrigin();
  const FAKE = "ghp_FAKE_NOT_A_REAL_TOKEN_00000000000000";
  const run = boot(home, origin, { env: { GH_TOKEN: FAKE } });
  assert.equal(run.status, 0, `boot failed: ${run.stderr}`);

  const cfg = readFileSync(join(home, ".gitconfig"), "utf8");
  assert.match(cfg, /credential/, "a helper must be configured");
  assert.match(cfg, /\$GH_TOKEN/, "it must reference the VARIABLE, read at call time");
  assert.doesNotMatch(cfg, new RegExp(FAKE), "the token VALUE must never be written to disk");
});

// ── THE BOOTSTRAP INSTALL RUNS ONCE, THEN DEFERS ────────────────────────────────────────────

test("npm ci runs only when tsx is ABSENT, and a later boot defers to ensureInstallFresh", () => {
  // An unconditional install on every boot would be a silent cost nobody would notice, and it would
  // duplicate a mechanism (`ensureInstallFresh`) that is strictly better informed.
  const home = freshHome();
  const origin = makeOrigin();

  const first = boot(home, origin);
  assert.equal(first.status, 0);
  assert.deepEqual(first.npmCalls, [["ci"]], "the first boot must bootstrap exactly once");

  const second = boot(home, origin);
  assert.equal(second.status, 0);
  assert.deepEqual(second.npmCalls, [], "a boot with node_modules present must install NOTHING");
  assert.match(second.stderr, /leaving install freshness to ensureInstallFresh/);
});

// ── DEFECT 1: A HOME THAT DOES NOT EXIST YET ───────────────────────────────────────────────

test("a HOME that does not exist yet is created, rather than dying in git config --global", () => {
  // `git config --global` writes $HOME/.gitconfig and FAILS OUTRIGHT if HOME is absent — "could not
  // lock config file", a message that says nothing about the real cause. The image creates
  // /home/node, so this only bites a container started with a HOME that was never made.
  const parent = mkdtempSync(join(tmpdir(), "entrypoint-nohome-"));
  const home = join(parent, "not-created-yet");
  assert.equal(existsSync(home), false, "the fixture must actually start with HOME absent");
  const origin = makeOrigin();

  const run = boot(home, origin, { env: { RMD_SKIP_BOOTSTRAP: "1" } });
  assert.equal(run.status, 0, `boot must create HOME rather than dying: ${run.stderr}`);
  assert.ok(existsSync(join(home, ".gitconfig")), "and the identity must land in the HOME it created");
});

// ── THE RESTART RATE LIMIT (the container counterpart of launchd's ThrottleInterval) ────────
//
// `generateLaunchdPlist` gives the mini KeepAlive{SuccessfulExit:false} + ThrottleInterval 60.
// Docker's `--restart=on-failure:N` caps the COUNT, not the RATE. These prove the substitute:
// a non-zero exit WAITS, an exit 0 does not, and the default path is untouched.
//
// The throttle SLEEPS BEFORE EXITING rather than looping, because the clone/fetch runs once per
// container: only a container restart re-fetches, and `stale` is the daemon's only path onto
// merged code. A loop would re-run the daemon against the same tree forever.

/** A command stub that records each invocation and exits with a chosen code. */
function writeCmdStub(dir: string, rec: string, name: string, code: number): void {
  const body = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$(date +%s)" >> "${rec}/${name}"`,
    `exit ${code}`,
    "",
  ].join("\n");
  writeFileSync(join(dir, name), body, { mode: 0o755 });
  chmodSync(join(dir, name), 0o755);
}

/** Boot with a stubbed command whose exit code we choose, timing the whole run. */
function bootTimed(
  home: string,
  origin: string,
  exitCode: number,
  env: Record<string, string>,
): { status: number; stderr: string; elapsedMs: number; calls: number } {
  const stubs = mkdtempSync(join(tmpdir(), "entrypoint-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "entrypoint-rec-"));
  writeNpmStub(stubs, rec);
  writeCmdStub(stubs, rec, "rmd-fake", exitCode);
  const started = Date.now();
  const r = spawnSync("bash", [SCRIPT, "rmd-fake", "daemon"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
  });
  const elapsedMs = Date.now() - started;
  let calls = 0;
  try {
    calls = readFileSync(join(rec, "rmd-fake"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    calls = 0;
  }
  return { status: r.status ?? -1, stderr: r.stderr ?? "", elapsedMs, calls };
}

test("a NON-ZERO exit sleeps the throttle interval before exiting, so docker restarts at that rate", () => {
  const run = bootTimed(freshHome(), makeOrigin(), 7, { RMD_RESTART_THROTTLE_S: "2" });
  // REACHED THE CODE: the stubbed command really ran, exactly once. W1-T490 added an in-container
  // loop, but ONLY for the freshness code — 7 is a crash, so it still exits on the first attempt and
  // docker still counts it. That is the half of the bound this test now also pins.
  assert.equal(run.calls, 1, "the command runs ONCE per container; a CRASH's restart is docker's job");
  assert.equal(run.status, 7, "the command's own exit code is propagated, not swallowed");
  assert.ok(run.elapsedMs >= 2000, `must have slept ~2s before exiting, took ${run.elapsedMs}ms`);
  assert.match(run.stderr, /restart throttle: a NON-ZERO exit will sleep 2s/);
  assert.match(run.stderr, /exited 7 — sleeping 2s/);
});

test("an exit 0 is NEVER throttled, so a STOP file stops the fleet immediately", () => {
  // `daemonExitCode` maps stopped/max_reached to 0, and a STOP file yields `stopped`. Sleeping
  // there would delay a requested stop by the throttle for no reason, and `--restart=on-failure`
  // leaves the container down either way.
  const run = bootTimed(freshHome(), makeOrigin(), 0, { RMD_RESTART_THROTTLE_S: "5" });
  assert.equal(run.calls, 1);
  assert.equal(run.status, 0);
  assert.ok(run.elapsedMs < 5000, `an exit 0 must not sleep, took ${run.elapsedMs}ms`);
  assert.match(run.stderr, /exited 0 — not throttled/);
});

test("with the throttle UNSET the script still execs, so one-shot verbs keep today's latency", () => {
  const run = bootTimed(freshHome(), makeOrigin(), 3, {});
  assert.equal(run.status, 3, "the exit code still propagates through exec");
  assert.ok(run.elapsedMs < 2000, `the default path must not sleep, took ${run.elapsedMs}ms`);
  assert.doesNotMatch(run.stderr, /restart throttle/, "and must not announce a throttle it is not applying");
});

test("a non-numeric throttle is refused loudly and falls back to exec rather than dying", () => {
  const run = bootTimed(freshHome(), makeOrigin(), 3, { RMD_RESTART_THROTTLE_S: "60s" });
  assert.equal(run.status, 3);
  assert.match(run.stderr, /not a whole number of seconds/);
  assert.ok(run.elapsedMs < 2000, "a rejected value must not sleep");
});

// ── W1-T490: A FRESHNESS RESTART MUST NOT SPEND THE CRASH-LOOP BUDGET, AND A CRASH STILL MUST ──
//
// THE DEFECT. `--restart=on-failure:N` counts every non-zero exit against N and MEASURED cannot read
// the value (`exit 1` and `exit 42` behaved identically); health never refunds it (containers
// exiting after 0s, 20s and 120s of clean work all parked). So a freshness restart — one per merge —
// burned the same budget as a crash and a healthy fleet exhausted `on-failure:5` in half a day.
//
// THE ONLY WAY TO SPEND NO BUDGET IS NOT TO EXIT, because docker counts exits and cannot be told
// otherwise. Hence an in-container restart for that ONE code. The whole risk of that shape is that
// it also swallows a crash loop, so these tests assert BOTH directions: a `stale` exit must re-enter
// without exiting, and a crash must still exit on its first attempt so N still bounds it.

/** A stub that walks a SEQUENCE of exit codes, one per invocation, so a loop is observable. */
function writeSeqCmdStub(dir: string, rec: string, name: string, codes: readonly number[]): void {
  const body = [
    "#!/usr/bin/env bash",
    `n=$(wc -l < "${rec}/${name}" 2>/dev/null || echo 0)`,
    `printf '%s\\n' "call" >> "${rec}/${name}"`,
    `codes=(${codes.join(" ")})`,
    'if [ "$n" -ge "${#codes[@]}" ]; then exit "${codes[${#codes[@]}-1]}"; fi',
    'exit "${codes[$n]}"',
    "",
  ].join("\n");
  writeFileSync(join(dir, name), body, { mode: 0o755 });
  chmodSync(join(dir, name), 0o755);
}

/** Boot with a stub whose exit code changes per call, returning how many times it ran. */
function bootSeq(
  home: string,
  origin: string,
  codes: readonly number[],
  env: Record<string, string>,
): { status: number; stderr: string; calls: number } {
  const stubs = mkdtempSync(join(tmpdir(), "entrypoint-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "entrypoint-rec-"));
  writeNpmStub(stubs, rec);
  writeSeqCmdStub(stubs, rec, "rmd-fake", codes);
  const r = spawnSync("bash", [SCRIPT, "rmd-fake", "daemon"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
  });
  let calls = 0;
  try {
    calls = readFileSync(join(rec, "rmd-fake"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    calls = 0;
  }
  return { status: r.status ?? -1, stderr: r.stderr ?? "", calls };
}

const STALE = 75;

test("W1-T490 DIRECTION 1: a FRESHNESS exit restarts IN-CONTAINER, so docker's budget is never charged", () => {
  // 75 then 0: the freshness restart is served here, and the second run stops cleanly.
  const run = bootSeq(freshHome(), makeOrigin(), [STALE, 0], { RMD_RESTART_THROTTLE_S: "1" });
  assert.equal(run.calls, 2, "the daemon must be re-run in-container rather than the container exiting");
  // THE ASSERTION THAT IS THE WHOLE POINT: the container exits 0. `--restart=on-failure` does not
  // restart on 0 and does not count it, so RestartCount is untouched by a routine merge.
  assert.equal(run.status, 0, "a freshness restart must not surface as a non-zero container exit");
  // The number is the DEFAULT `FRESHNESS_RESTART_MAX` this test deliberately does not override, so it moves
  // with that default: 20 until 2026-08-18, 100 after. Kept exact rather than loosened to \d+ —
  // matching any number would stop proving the log names the budget actually in force.
  assert.match(run.stderr, /freshness\) — restart 1\/100 IN-CONTAINER/);
  assert.match(run.stderr, /budget is not spent/);
});

test("W1-T490 DIRECTION 2: a CRASH still exits on its FIRST attempt, so on-failure:N still bounds a crash loop", () => {
  // 1 is what `blocked`/`error` map to. If this ever loops, the crash-loop bound is gone — which is
  // the regression the in-container loop above would cause if it were unconditional.
  const run = bootSeq(freshHome(), makeOrigin(), [1, 1, 1], { RMD_RESTART_THROTTLE_S: "1" });
  assert.equal(run.calls, 1, "a crash must NOT be retried in-container; docker has to see the exit to count it");
  assert.equal(run.status, 1, "and the code must propagate so on-failure actually fires");
  assert.doesNotMatch(run.stderr, /IN-CONTAINER/, "a crash must not take the freshness path at all");
});

test("W1-T490: the freshness loop is itself BOUNDED, so a stale STORM still reaches docker's count", () => {
  // THE OBJECTION THIS ANSWERS, verbatim from the entrypoint's own note: an internal loop "would
  // render inert" the count cap, because a container that never exits is never counted. MEASURED
  // precedent: 5 boots and 3 lock collisions in 150 seconds on 2026-08-13. So the loop has its own
  // bound and then hands the container back.
  const run = bootSeq(freshHome(), makeOrigin(), [STALE, STALE, STALE, STALE], {
    RMD_RESTART_THROTTLE_S: "1",
    RMD_FRESHNESS_RESTART_MAX: "2",
  });
  assert.equal(run.calls, 3, "the initial run plus exactly 2 in-container restarts");
  assert.equal(run.status, STALE, "once the bound is spent the container exits, so docker counts it again");
  assert.match(run.stderr, /2 in-container restarts are already spent/);
});

test("W1-T490: a freshness restart RE-RUNS the fetch/checkout, so the staleness it restarted for actually clears", () => {
  // THE OBJECTION THE ENTRYPOINT USED TO RAISE AGAINST LOOPING: "the clone/fetch/checkout above runs
  // ONCE, before this line — so an in-container retry loop would re-run the daemon against the SAME
  // tree forever and `stale` would never clear." That is retired by extracting `sync_tree`, and this
  // is the test that holds the retirement honest: the remote MOVES between the two runs, and the
  // tree must be on the new sha afterwards. Without the re-sync this fails on the sha comparison.
  const home = freshHome();
  const origin = makeOrigin();
  const before = git(origin, ["rev-parse", "HEAD"]);
  // The stub advances origin on its FIRST call, so the restart has something newer to land on.
  const stubs = mkdtempSync(join(tmpdir(), "entrypoint-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "entrypoint-rec-"));
  writeNpmStub(stubs, rec);
  const body = [
    "#!/usr/bin/env bash",
    `n=$(wc -l < "${rec}/rmd-fake" 2>/dev/null || echo 0)`,
    `printf '%s\\n' "call" >> "${rec}/rmd-fake"`,
    'if [ "$n" -eq 0 ]; then exit 75; fi',
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(stubs, "rmd-fake"), body, { mode: 0o755 });
  chmodSync(join(stubs, "rmd-fake"), 0o755);
  const after = advanceOrigin(origin, "moved.txt", "a commit that merged while the daemon was up");
  assert.notEqual(before, after, "sanity: the remote really moved");
  const r = spawnSync("bash", [SCRIPT, "rmd-fake", "daemon"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      RMD_RESTART_THROTTLE_S: "1",
    },
  });
  assert.equal(r.status, 0, `expected a clean exit, got ${r.status}: ${r.stderr}`);
  assert.equal(headOf(home), after, "the restart must land on the NEWER sha — otherwise the loop re-runs stale code forever");
});

test("W1-T490: the freshness loop belongs to SUPERVISED mode — with the throttle unset the script still plain execs", () => {
  // THE COUPLING, PINNED RATHER THAN LEFT IMPLICIT. `exec "$@"` replaces this shell, so nothing can
  // observe the exit code afterwards — the freshness branch is unreachable by construction on that
  // path. Rather than quietly abandon the documented "unset ⇒ byte-for-byte what it was" contract
  // (which exists because `exec` serves every one-shot container verb, not just the daemon), the
  // freshness handling lives in the SAME opt-in supervised branch the throttle already created.
  // THIS IS NOT A GAP IN PRODUCTION: the daemon container is launched with
  // RMD_RESTART_THROTTLE_S=120 (deploy/host-update.sh passes it, and the live container carries it),
  // so the supervised branch is exactly the branch the fleet runs.
  const run = bootSeq(freshHome(), makeOrigin(), [STALE, 0], {});
  assert.equal(run.calls, 1, "with no throttle the script execs, so there is no shell left to retry in");
  assert.equal(run.status, STALE, "and the code propagates untouched through exec");
  assert.doesNotMatch(run.stderr, /IN-CONTAINER/);
});

test("W1-T490: the entrypoint's freshness code is the SAME NUMBER as DAEMON_EXIT_STALE, not a drifting literal", () => {
  // THE DUPLICATION THIS PINS. The entrypoint cannot import src/lib/daemon.ts — it runs at exactly
  // the moment the daemon has failed, and the throttle note above records why nothing here may
  // depend on the repo being loadable then. So the constant is written twice and this is what stops
  // the two drifting: a silent drift would restore the whole defect with every unit test green.
  const script = readFileSync(SCRIPT, "utf8");
  const m = script.match(/^DAEMON_EXIT_STALE=(\d+)$/m);
  assert.ok(m, "the entrypoint must define DAEMON_EXIT_STALE as a plain assignment this test can read");
  assert.equal(Number(m![1]), DAEMON_EXIT_STALE, "entrypoint and daemon.ts disagree about the freshness exit code");
  // POSITIVE CONTROL on that match: the same predicate must FAIL against a mutated script, or it
  // would pass for a file that no longer carries the assignment at all.
  assert.equal(/^DAEMON_EXIT_STALE=(\d+)$/m.test(script.replace(/^DAEMON_EXIT_STALE=\d+$/m, "# gone")), false);
});

test("W1-T2537: the entrypoint's blocked code is the SAME NUMBER as DAEMON_EXIT_BLOCKED, not a drifting literal", () => {
  // The sibling of the W1-T490 test directly above, for the same reason: the entrypoint cannot
  // import src/lib/daemon.ts (it runs at exactly the moment the daemon has stopped), so the
  // constant is written twice. A silent drift here would route a blocked exit down the crash
  // path and restore the whole outage, with every other test green.
  const script = readFileSync(SCRIPT, "utf8");
  const m = script.match(/^DAEMON_EXIT_BLOCKED=(\d+)$/m);
  assert.ok(m, "the entrypoint must define DAEMON_EXIT_BLOCKED as a plain assignment this test can read");
  assert.equal(Number(m![1]), DAEMON_EXIT_BLOCKED, "entrypoint and daemon.ts disagree about the blocked exit code");
  // POSITIVE CONTROL on the match, exactly as the freshness test runs one: the predicate must
  // FAIL against a mutated script, or it would pass for a file no longer carrying the assignment.
  assert.equal(/^DAEMON_EXIT_BLOCKED=(\d+)$/m.test(script.replace(/^DAEMON_EXIT_BLOCKED=\d+$/m, "# gone")), false);
  // AND THE TWO CODES MUST DIFFER IN THE SCRIPT ITSELF — reading each constant correctly is not
  // enough if both resolve to the same number, since the two arms would then be unreachable past
  // whichever is checked first.
  const stale = script.match(/^DAEMON_EXIT_STALE=(\d+)$/m);
  assert.notEqual(Number(m![1]), Number(stale![1]), "the two in-container arms must not share a code");
});

test("W1-T2537: a blocked exit restarts IN-CONTAINER and never reaches the crash throttle", () => {
  // The behavioural half. A blocked stop must take the same in-container path freshness takes —
  // re-sync then loop — so docker's on-failure budget is untouched by a pass that ran to
  // completion.
  const script = readFileSync(SCRIPT, "utf8");
  const arm = script.match(/if \[ "\$rc" -eq "\$DAEMON_EXIT_BLOCKED" \][\s\S]*?\n  fi/);
  assert.ok(arm, "the entrypoint must carry a DAEMON_EXIT_BLOCKED arm");
  const body = arm![0];
  assert.match(body, /blocked_restarts=\$\(\(blocked_restarts \+ 1\)\)/, "the arm must count its own restarts");
  assert.match(body, /-lt "\$BLOCKED_RESTART_MAX"/, "the arm must be bounded, never unconditional");
  assert.match(body, /sleep "\$BLOCKED_RESTART_PAUSE_S"/, "it must pace itself on its own pause");
  assert.doesNotMatch(body, /RESTART_THROTTLE_S/, "the crash throttle is exactly what this path must NOT pay");
  assert.match(body, /sync_tree/, "re-syncing is what makes the retry meaningful: PRs may have merged mid-pass");
  assert.match(body, /continue/, "it loops rather than exiting, so docker never counts it");
});

test("W1-T2537: a blocked exit past the cap still falls through, so the bound is replaced and not removed", () => {
  // The in-container loop must never become an unbounded one — that would delete the crash-loop
  // bound entirely, which is the objection W1-T490 recorded as STILL BINDING.
  const script = readFileSync(SCRIPT, "utf8");
  const armIdx = script.indexOf('if [ "$rc" -eq "$DAEMON_EXIT_BLOCKED" ] && [ "$blocked_restarts" -lt "$BLOCKED_RESTART_MAX" ]');
  const throttleIdx = script.indexOf('sleep "$RESTART_THROTTLE_S"');
  assert.ok(armIdx > 0, "the bounded arm must exist");
  assert.ok(throttleIdx > armIdx, "and the crash throttle must sit BELOW it, as the fall-through");
  assert.match(
    script.slice(armIdx, throttleIdx),
    /in-container restarts are already spent, so this one goes to docker's count/,
    "an exhausted cap must say so, exactly as the freshness path does",
  );
});

test("W1-T2537: the entrypoint no longer calls a blocked stop a crash", () => {
  // The false equation, in the script's own words: "A crash (`blocked`/`error` => 1) reaches here
  // on its first attempt". `error` is a crash; a completed pass reporting a blocked task is not.
  const script = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(script, /A crash \(`blocked`\/`error`/, "the comment asserting blocked IS a crash must be gone");
});

// ── W1-T498: THE FRESHNESS RETRY MUST NOT PAY THE CRASH THROTTLE ───────────────────────────────
//
// THE DEFECT. W1-T490 stopped a freshness restart from spending docker's `on-failure` BUDGET, but the
// in-container retry still slept the FULL `RMD_RESTART_THROTTLE_S` (120s in production) before every
// re-sync — a sleep sized for the measured 2026-08-13 lock storm (same boot failing 13-17s apart),
// not for a freshness restart, which happens once per merge with a real fetch/checkout in between.
// MEASURED (Azure, 2026-08-14): 16 freshness restarts x 115s saved = ~30.7 minutes of daemon idle a
// day. `RMD_FRESHNESS_RESTART_PAUSE_S` (default 5) replaces that sleep in the freshness branch ONLY;
// the crash-exit sleep and the exhausted-budget hand-off both keep the full throttle, each pinned
// below, because shortening either would shorten the bound that guards an actual crash loop.

/** Boot with a stub whose exit code changes per call, timing the whole run. */
function bootSeqTimed(
  home: string,
  origin: string,
  codes: readonly number[],
  env: Record<string, string>,
): { status: number; stderr: string; elapsedMs: number; calls: number } {
  const stubs = mkdtempSync(join(tmpdir(), "entrypoint-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "entrypoint-rec-"));
  writeNpmStub(stubs, rec);
  writeSeqCmdStub(stubs, rec, "rmd-fake", codes);
  const started = Date.now();
  const r = spawnSync("bash", [SCRIPT, "rmd-fake", "daemon"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
  });
  const elapsedMs = Date.now() - started;
  let calls = 0;
  try {
    calls = readFileSync(join(rec, "rmd-fake"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    calls = 0;
  }
  return { status: r.status ?? -1, stderr: r.stderr ?? "", elapsedMs, calls };
}

test("W1-T498: a freshness retry pauses its own short interval not the crash throttle", () => {
  // The crash throttle is set HIGH (5s) and the freshness pause LOW (1s) — if the freshness branch
  // ever slept the crash throttle instead of its own pause, this boot would take >=5s, not ~1s.
  const run = bootSeqTimed(freshHome(), makeOrigin(), [STALE, 0], {
    RMD_RESTART_THROTTLE_S: "5",
    RMD_FRESHNESS_RESTART_PAUSE_S: "1",
  });
  assert.equal(run.calls, 2, "the freshness restart must still re-run in-container, as W1-T490 pinned");
  assert.equal(run.status, 0, "and still hand back a clean exit");
  assert.ok(run.elapsedMs >= 1000, `must pay its own 1s pause, took ${run.elapsedMs}ms`);
  assert.ok(run.elapsedMs < 4000, `must NOT pay the 5s crash throttle, took ${run.elapsedMs}ms`);
  assert.match(run.stderr, /sleeping 1s \(not the 5s crash throttle\)/);
});

test("W1-T498: a genuine crash still pays the full crash throttle", () => {
  // A crash never reaches the freshness branch at all (W1-T490 DIRECTION 2), so it must still sleep
  // the FULL RESTART_THROTTLE_S, unaffected by the new, smaller FRESHNESS_RESTART_PAUSE_S sitting
  // right beside it.
  const run = bootTimed(freshHome(), makeOrigin(), 1, {
    RMD_RESTART_THROTTLE_S: "2",
    RMD_FRESHNESS_RESTART_PAUSE_S: "1",
  });
  assert.equal(run.calls, 1, "a crash exits on its first attempt; it is never retried in-container");
  assert.equal(run.status, 1);
  assert.ok(run.elapsedMs >= 2000, `must sleep the FULL 2s crash throttle, took ${run.elapsedMs}ms`);
  assert.match(run.stderr, /exited 1 — sleeping 2s/);
});

test("W1-T498: an exhausted freshness budget falls back onto the full throttle", () => {
  // Once RMD_FRESHNESS_RESTART_MAX in-container restarts are spent, the LAST sleep before handing the
  // container back to docker's count must be the full crash throttle, not the short freshness pause
  // it paid on every restart up to that point.
  const run = bootSeq(freshHome(), makeOrigin(), [STALE, STALE], {
    RMD_RESTART_THROTTLE_S: "3",
    RMD_FRESHNESS_RESTART_PAUSE_S: "1",
    RMD_FRESHNESS_RESTART_MAX: "1",
  });
  assert.equal(run.calls, 2, "one in-container restart, then the budget is spent");
  assert.equal(run.status, STALE, "the second stale exit is handed back to docker, counted once again");
  assert.match(
    run.stderr,
    /sleeping 1s \(not the 3s crash throttle\)/,
    "the in-container restart pays its own short pause",
  );
  assert.match(run.stderr, /sleeping 3s before exiting/, "the hand-off to docker pays the FULL crash throttle");
});

test("W1-T498: a non-numeric pause value is refused loudly and falls back", () => {
  // A crash code, so the freshness branch is never reached — this isolates the validation itself,
  // exactly as the existing RMD_RESTART_THROTTLE_S non-numeric test does for its own variable.
  const run = bootTimed(freshHome(), makeOrigin(), 3, {
    RMD_RESTART_THROTTLE_S: "1",
    RMD_FRESHNESS_RESTART_PAUSE_S: "soon",
  });
  assert.equal(run.status, 3, "a rejected value must not break the boot");
  assert.match(
    run.stderr,
    /RMD_FRESHNESS_RESTART_PAUSE_S is not a whole number of seconds — ignoring it and using 5/,
  );
  assert.ok(
    run.elapsedMs >= 1000 && run.elapsedMs < 4000,
    `must pay only the 1s crash throttle, not hang on the rejected value, took ${run.elapsedMs}ms`,
  );
});

// ── THE THROTTLE IS ONLY REAL IF THE HOST ACTUALLY PASSES IT ────────────────────────────────
//
// The four tests above prove the ENTRYPOINT honours `RMD_RESTART_THROTTLE_S`, and they proved it
// while the variable was reaching no container at all: `deploy/host-update.sh --print-daemon-run`
// — the documented invocation, and the only place this repo says how to start the daemon — passed
// no `-e` for it, so every one of those tests passed against a throttle that could never fire in
// production. A test suite green on a feature nothing wires is the exact shape this file exists to
// refuse, so the wiring is asserted here as a CHAIN rather than as two independent greps.
//
// AND IT IS ASSERTED BY EFFECT, NOT BY NAME. The env var name is read OUT of host-update.sh's own
// printed invocation and then fed to the real entrypoint with `sleep` stubbed to record its
// argument. A typo'd `-e` name on the host side sets a variable the entrypoint does not read, so
// nothing sleeps and this fails — which a `grep RMD_RESTART_THROTTLE_S deploy/host-update.sh`
// would have called green.

const HOST_UPDATE = join(REPO_ROOT, "deploy", "host-update.sh");

/** Env var names the printed daemon invocation passes through `-e`, in order. */
function daemonRunEnvNames(scriptPath = HOST_UPDATE): string[] {
  const printed = spawnSync("bash", [scriptPath, "--print-daemon-run"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  assert.equal(printed.status, 0, `--print-daemon-run failed: ${printed.stderr}`);
  // Only the DAEMON container's block — the console container below it has its own policy.
  const block = printed.stdout.slice(
    printed.stdout.indexOf("docker run -d --name remudero-daemon"),
    printed.stdout.indexOf("./bin/rmd daemon"),
  );
  assert.ok(block.length > 0, "the daemon invocation must be present in --print-daemon-run output");
  return [...block.matchAll(/-e\s+([A-Z_][A-Z0-9_]*)=/g)].map((m) => m[1]);
}

/** Boot with `sleep` stubbed, returning every argument it was called with. */
function bootSleepArgs(env: Record<string, string>, exitCode: number): { args: string[]; stderr: string; status: number } {
  const stubs = mkdtempSync(join(tmpdir(), "entrypoint-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "entrypoint-rec-"));
  writeNpmStub(stubs, rec);
  writeCmdStub(stubs, rec, "rmd-fake", exitCode);
  // Records the ARGUMENT and returns immediately, so the assertion is on the value the script
  // asked for rather than on how long the test happened to block.
  writeFileSync(join(stubs, "sleep"), `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> "${rec}/sleep"\nexit 0\n`, { mode: 0o755 });
  chmodSync(join(stubs, "sleep"), 0o755);
  const r = spawnSync("bash", [SCRIPT, "rmd-fake", "daemon"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: freshHome(),
      RMD_REPO_URL: makeOrigin(),
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
  });
  let args: string[] = [];
  try {
    args = readFileSync(join(rec, "sleep"), "utf8").split("\n").filter(Boolean);
  } catch {
    args = [];
  }
  return { args, stderr: r.stderr ?? "", status: r.status ?? -1 };
}

test("host-update's printed daemon invocation passes the throttle var, and the entrypoint sleeps EXACTLY that value", () => {
  const names = daemonRunEnvNames();
  assert.ok(
    names.includes("RMD_RESTART_THROTTLE_S"),
    `--print-daemon-run must pass the throttle through; it passes only ${JSON.stringify(names)}`,
  );

  // THE CHAIN: set the variable BY THE NAME THE HOST SCRIPT PASSES, and prove the entrypoint acts
  // on it. `sleep` is stubbed, so this asserts the argument, not a duration.
  const run = bootSleepArgs({ RMD_RESTART_THROTTLE_S: "4" }, 7);
  assert.equal(run.status, 7, "the command's exit code must still propagate");
  assert.deepEqual(run.args, ["4"], "the entrypoint must sleep the configured interval exactly once");
});

test("with the throttle UNSET — what the printed invocation delivers by default — nothing sleeps at all", () => {
  // The printed line passes `-e RMD_RESTART_THROTTLE_S="${RMD_RESTART_THROTTLE_S:-}"`, so an
  // operator who sets nothing delivers an EMPTY value, not an absent one. Empty must resolve to
  // today's behaviour; if it ever threw or slept, wiring the variable would have changed the
  // default deployment, which this change explicitly must not do.
  const run = bootSleepArgs({ RMD_RESTART_THROTTLE_S: "" }, 3);
  assert.equal(run.status, 3);
  assert.deepEqual(run.args, [], "an empty throttle must not sleep");
  assert.doesNotMatch(run.stderr, /restart throttle/, "and must not announce a throttle it is not applying");
});

test("MUTANT (the defect that actually shipped): dropping the -e leaves the throttle unreachable, and the chain test catches it", () => {
  // THIS IS NOT HYPOTHETICAL. It is the state `origin/main` was in until this change: the throttle
  // was written, tested and merged (#1536) while `--print-daemon-run` passed no `-e` for it, so it
  // could not fire on any container the documented invocation started. Reinstating that exact
  // omission must turn the chain test above RED, or that test is decoration.
  const src = readFileSync(HOST_UPDATE, "utf8");
  const line = '    -e RMD_RESTART_THROTTLE_S="\\${RMD_RESTART_THROTTLE_S:-}" \\\\\n';
  assert.equal(src.split(line).length - 1, 1, "the mutation target must be unique and present");
  const dir = mkdtempSync(join(tmpdir(), "host-update-mutant-"));
  const mutant = join(dir, "host-update.sh");
  writeFileSync(mutant, src.replace(line, ""), { mode: 0o755 });
  chmodSync(mutant, 0o755);

  const names = daemonRunEnvNames(mutant);
  // NON-VACUITY: extraction still works on the mutant (other `-e` flags are still found), so the
  // assertion below fails because the throttle is GONE, never because the regex stopped matching.
  assert.ok(names.includes("GH_TOKEN"), `extraction must still work on the mutant; got ${JSON.stringify(names)}`);
  assert.ok(
    !names.includes("RMD_RESTART_THROTTLE_S"),
    "the mutant must drop the throttle var — otherwise the chain test proves nothing about the -e",
  );
});

// ── `--privileged` IS WIDER THAN THE FLEET NEEDS (W1-T508) ──────────────────────────────────
//
// MEASURED (2026-08-15, throwaway containers, never the fleet's own): an eleven-row bwrap matrix
// found `--cap-drop ALL --security-opt seccomp=unconfined --security-opt apparmor=unconfined
// --security-opt systempaths=unconfined` passes the fleet's own containment preflight
// (`defaultExecutor`, src/lib/containment.ts) IDENTICALLY to `--privileged`, while dropping any
// ONE of the three relaxations fails. `--privileged` additionally grants the full 41-capability
// bounding set and all 16 host block devices, `nvme0n1p1` (the host root disk, holding the GH
// token and the ledger) among them — none of which the sandbox ever used. These four tests read
// the printed invocation the same way the throttle chain above does: BY EFFECT on
// `--print-daemon-run`'s own output, not by grepping the script's source for a flag name.

/** Raw text of the printed DAEMON container's `docker run` block (not the console container). */
function daemonRunBlock(scriptPath = HOST_UPDATE): string {
  const printed = spawnSync("bash", [scriptPath, "--print-daemon-run"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  assert.equal(printed.status, 0, `--print-daemon-run failed: ${printed.stderr}`);
  const block = printed.stdout.slice(
    printed.stdout.indexOf("docker run -d --name remudero-daemon"),
    printed.stdout.indexOf("./bin/rmd daemon"),
  );
  assert.ok(block.length > 0, "the daemon invocation must be present in --print-daemon-run output");
  return block;
}

test("W1-T505: the printed daemon invocation drops blanket privilege", () => {
  const block = daemonRunBlock();
  assert.doesNotMatch(
    block,
    /--privileged\b/,
    `the printed invocation must not carry --privileged any more: ${block}`,
  );
});

test("W1-T505: the printed invocation carries all three relaxations", () => {
  const block = daemonRunBlock();
  // Measured as a MATRIX, not independently: dropping any one of these three fails the fleet's
  // own containment preflight, so all three must be present together.
  for (const opt of [
    "--security-opt seccomp=unconfined",
    "--security-opt apparmor=unconfined",
    "--security-opt systempaths=unconfined",
  ]) {
    assert.ok(block.includes(opt), `the printed invocation must carry ${JSON.stringify(opt)}: ${block}`);
  }
});

test("W1-T505: the printed invocation adds back no capability", () => {
  const block = daemonRunBlock();
  assert.ok(
    block.includes("--cap-drop ALL"),
    `the printed invocation must empty the bounding capability set: ${block}`,
  );
  assert.doesNotMatch(
    block,
    /--cap-add\b/,
    `the printed invocation must not add any capability back — that is the whole prize: ${block}`,
  );
});

test("W1-T505: the recorded doctrine names confinement rather than capability", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "deploy", "Dockerfile"), "utf8");
  const reqStart = dockerfile.indexOf("REQ 9:");
  assert.ok(reqStart >= 0, "deploy/Dockerfile must still carry the REQ 9 sandbox-permissions doctrine");
  const nextReq = dockerfile.indexOf("# ── REQ", reqStart + 1);
  const doctrine = dockerfile.slice(reqStart, nextReq > 0 ? nextReq : dockerfile.length);

  assert.match(
    doctrine,
    /CONFINEMENT, NOT A CAPABILITY/,
    "the doctrine must name confinement (settable seccomp/AppArmor, unmasked /proc) as the requirement",
  );
  assert.doesNotMatch(
    doctrine,
    /the caps have to come from the container being privileged/,
    "the doctrine must no longer carry the superseded capability-shaped explanation",
  );
});

// ── MUTANTS: each reproduces a defect that actually shipped ─────────────────────────────────

function mutate(find: string, replace: string): string {
  const src = readFileSync(SCRIPT, "utf8");
  assert.equal(src.split(find).length - 1, 1, `the mutation target must be unique: ${JSON.stringify(find)}`);
  const dir = mkdtempSync(join(tmpdir(), "entrypoint-mutant-"));
  const p = join(dir, "entrypoint.sh");
  writeFileSync(p, src.replace(find, replace), { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

test("MUTANT (defect 5): a bare git config --get makes the boot log report the CWD repo's identity", () => {
  // FOUND BY THIS SUITE rather than by hand — the first of the five. The guard above the write was
  // corrected to `git -C /` when the same trap was found there; the LOG LINE below it was missed.
  // Booting from inside a checkout, the mutant announces that checkout's committer instead of the
  // global identity it just wrote.
  const mutant = mutate(
    "$(git -C / config --get user.name) <$(git -C / config --get user.email)> (override with",
    "$(git config --get user.name) <$(git config --get user.email)> (override with",
  );
  // Boot from a repository carrying a LOCAL identity of its own — the fixture owns that condition
  // rather than borrowing it from this checkout, which has one here and none on a CI runner.
  const cwd = makeCwdRepo();
  const run = boot(freshHome(), makeOrigin(), { script: mutant, env: { RMD_SKIP_BOOTSTRAP: "1" }, cwd });
  assert.match(
    run.stderr,
    /git identity: CwdRepo/,
    "the mutant must report the CWD repo's committer, not the identity it just wrote",
  );
  assert.doesNotMatch(run.stderr, /git identity: remudero-worker/);
  // And the real script must name the identity it actually configured, from that same cwd.
  const real = boot(freshHome(), makeOrigin(), { env: { RMD_SKIP_BOOTSTRAP: "1" }, cwd });
  assert.match(real.stderr, /git identity: remudero-worker/);
});

test("MUTANT (defect 1): dropping the mkdir leaves git config unable to write a missing HOME", () => {
  const mutant = mutate(
    'mkdir -p "${HOME:?HOME must be set',
    ': "${HOME:?HOME must be set',
  );
  const parent = mkdtempSync(join(tmpdir(), "entrypoint-nohome-"));
  const home = join(parent, "not-created-yet");
  const run = boot(home, makeOrigin(), { script: mutant, env: { RMD_SKIP_BOOTSTRAP: "1" } });
  assert.notEqual(run.status, 0, "the mutant must fail — otherwise the mkdir is not what makes this work");
});

test("MUTANT (defect 3): resolving the LOCAL branch pins the container at its clone-time sha", () => {
  const mutant = mutate('checkout --detach "$TARGET"', 'checkout --detach "$REF"');
  const home = freshHome();
  const origin = makeOrigin();
  const c1 = git(origin, ["rev-parse", "HEAD"]);
  assert.equal(boot(home, origin, { script: mutant }).status, 0);
  const c2 = advanceOrigin(origin, "second.txt", "two\n");

  boot(home, origin, { script: mutant });
  assert.equal(headOf(home), c1, "the mutant must reproduce the walk-back — otherwise this proves nothing");
  assert.notEqual(headOf(home), c2);
});

test("MUTANT (defect 2): counting untracked files as dirt makes boot 2 refuse forever", () => {
  const mutant = mutate('status --porcelain -uno', 'status --porcelain');
  const home = freshHome();
  const origin = makeOrigin();
  assert.equal(boot(home, origin, { script: mutant }).status, 0, "boot 1 clones and installs");
  advanceOrigin(origin, "second.txt", "two\n");

  const second = boot(home, origin, { script: mutant });
  assert.match(second.stderr, /REFUSING to sync/, "the mutant must refuse because boot 1 created node_modules");
});

test("MUTANT (defect 4): skipping before the identity is written leaves the recovery path unable to commit", () => {
  const mutant = mutate(
    'mkdir -p "${HOME:?HOME must be set',
    'if [ "${RMD_SKIP_BOOTSTRAP:-}" = "1" ]; then exec "$@"; fi\nmkdir -p "${HOME:?HOME must be set',
  );
  const home = freshHome();
  const origin = makeOrigin();
  const probe = mkdtempSync(join(tmpdir(), "entrypoint-probe-"));
  const run = boot(home, origin, {
    script: mutant,
    env: { RMD_SKIP_BOOTSTRAP: "1", ...NO_GUESSED_IDENTITY },
    cmd: ["bash", "-c", `cd ${probe} && git init -q -b main . && echo x > f && git add f && git commit -qm probe`],
  });
  assert.notEqual(run.status, 0, "the mutant must fail to commit — that is the defect being locked out");
  assert.match(`${run.stderr}${run.stdout}`, /identity unknown|empty ident|Please tell me who you are/i);
});
