import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

// ── DEFECT 4: THE IDENTITY IS WRITTEN ABOVE THE SKIP ────────────────────────────────────────

test("RMD_SKIP_BOOTSTRAP=1 still gets a git identity, so the recovery path can commit", () => {
  // The skip `exec`s and never returns, so anything below it is unreachable on this path — which is
  // exactly the path the script's own failure messages tell an operator to use to inspect a broken
  // tree by hand. Someone salvaging uncommitted work is precisely who needs to commit.
  const home = freshHome();
  const origin = makeOrigin();
  const probe = mkdtempSync(join(tmpdir(), "entrypoint-probe-"));
  const run = boot(home, origin, {
    env: { RMD_SKIP_BOOTSTRAP: "1" },
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
  // REACHED THE CODE: the stubbed command really ran, exactly once — the throttle must not loop,
  // because looping would re-run the daemon without re-running the clone/fetch above it.
  assert.equal(run.calls, 1, "the command runs ONCE per container; the restart is docker's job");
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
    env: { RMD_SKIP_BOOTSTRAP: "1" },
    cmd: ["bash", "-c", `cd ${probe} && git init -q -b main . && echo x > f && git add f && git commit -qm probe`],
  });
  assert.notEqual(run.status, 0, "the mutant must fail to commit — that is the defect being locked out");
  assert.match(`${run.stderr}${run.stdout}`, /identity unknown|empty ident|Please tell me who you are/i);
});
