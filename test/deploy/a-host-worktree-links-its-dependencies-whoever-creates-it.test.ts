import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { test, type TestContext } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HOOK = join(REPO_ROOT, "hooks/post-checkout");
const INSTALLER = join(REPO_ROOT, "deploy/install-host-units.sh");
const NULL_SHA = "0".repeat(40);

function executable(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text, { mode: 0o755 });
}

function fixture(t: TestContext, occupied?: "file" | "dir" | "link" | "dangling") {
  const repo = gitRepo({ kind: "t10507-host-hook" });
  t.after(() => repo.cleanup());
  const hook = join(repo.dir, "hooks/post-checkout");
  mkdirSync(join(hook, ".."));
  copyFileSync(HOOK, hook);
  writeFileSync(join(repo.dir, "package-lock.json"), "{}\n");
  if (occupied === "file") writeFileSync(join(repo.dir, "node_modules"), "keep\n");
  if (occupied === "dir") {
    mkdirSync(join(repo.dir, "node_modules"));
    writeFileSync(join(repo.dir, "node_modules/keep"), "keep\n");
  }
  if (occupied === "link" || occupied === "dangling") {
    symlinkSync(occupied === "link" ? "hooks" : "missing", join(repo.dir, "node_modules"));
  }
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "hook fixture");
  repo.git("config", "core.hooksPath", join(repo.dir, "hooks"));
  const home = join(repo.dir, "home"), bin = join(repo.dir, "tools"), calls = join(repo.dir, "calls");
  mkdirSync(home);
  mkdirSync(bin);
  executable(join(bin, "uname"), "#!/bin/sh\necho Linux\n");
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CALLS: calls,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (args: string[], cwd = repo.dir) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const recorded = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  const tool = (body: string, fallback = false) => executable(
    join(fallback ? join(home, ".local/bin") : bin, "remudero-dependencies"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$CALLS"\n${body}\n`,
  );
  const cut = (name: string, cwd = repo.dir) => {
    const worktree = join(repo.dir, `${name} worktree`);
    const result = git(["worktree", "add", "-b", name, worktree], cwd);
    assert.equal(result.status, 0, result.stderr);
    return { worktree, result };
  };
  return { ...repo, hook, home, bin, env, git, recorded, tool, cut };
}

test("W1-T10507: a raw git worktree add primes the new worktree from the seed store and never fails the cut", (t) => {
  const f = fixture(t);
  f.tool('printf \'{"method":"readonly-links","key":"fixture-key"}\\n\'');
  const first = f.cut("success");
  assert.deepEqual(f.recorded(), [`prime ${first.worktree} --source ${f.dir}`]);
  assert.match(first.result.stderr, /post-checkout: linking dependencies from the account seed store/);
  assert.match(first.result.stderr, /"method":"readonly-links","key":"fixture-key"/);
  const checkout = f.git(["checkout", "-b", "later"], first.worktree);
  assert.equal(checkout.status, 0, checkout.stderr);
  assert.equal(f.recorded().length, 1, "a later checkout must not prime again");

  f.tool('if [ "$#" = 4 ]; then echo "dependency-seeds: donor inputs do not match" >&2; exit 1; fi\necho \'{"method":"readonly-links","key":"new-lock"}\'');
  const retry = f.cut("retry", first.worktree);
  assert.deepEqual(f.recorded().slice(1), [`prime ${retry.worktree} --source ${f.dir}`, `prime ${retry.worktree}`]);
  assert.match(retry.result.stderr, /new-lock/);

  f.tool('printf "dependency-seeds: store unavailable\\nprivate details\\n" >&2; exit 7');
  const refused = f.cut("refused");
  assert.equal(f.recorded().length, 4, "an unrelated refusal must not retry");
  assert.match(refused.result.stderr, /dependency-seeds: store unavailable/);
  assert.doesNotMatch(refused.result.stderr, /private details/);

  f.tool('echo "dependency-seeds: donor inputs do not match" >&2; exit 9');
  f.cut("retry-refused");
  assert.equal(f.recorded().length, 6, "both failed attempts still leave a successful cut");
});

for (const occupied of ["file", "dir", "link", "dangling"] as const) {
  test(`W1-T10507: an existing node_modules ${occupied} is left alone`, (t) => {
    const f = fixture(t, occupied);
    f.tool("exit 0");
    const { result } = f.cut(`occupied-${occupied}`);
    assert.deepEqual(f.recorded(), []);
    assert.doesNotMatch(result.stderr, /post-checkout:/);
  });
}

test("W1-T10507: clones, darwin, missing lockfiles and file checkouts stay silent", (t) => {
  const f = fixture(t);
  f.tool("exit 0");
  const clone = f.git(["-c", `core.hooksPath=${join(f.dir, "hooks")}`, "clone", f.dir, join(f.dir, "clone")]);
  assert.equal(clone.status, 0, clone.stderr);
  assert.deepEqual(f.recorded(), []);
  executable(join(f.bin, "uname"), "#!/bin/sh\necho Darwin\n");
  f.cut("darwin");
  executable(join(f.bin, "uname"), "#!/bin/sh\necho Linux\n");
  f.git(["rm", "package-lock.json"]);
  f.git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "no lock"]);
  const noLock = f.cut("no-lock");
  writeFileSync(join(noLock.worktree, "package-lock.json"), "{}\n");
  const direct = spawnSync("bash", ["-u", f.hook, NULL_SHA, "HEAD", "0"], {
    cwd: noLock.worktree, env: f.env, encoding: "utf8",
  });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stderr, "");
  assert.deepEqual(f.recorded(), []);
  assert.doesNotMatch(clone.stderr + noLock.result.stderr, /post-checkout:/);
});

test("W1-T10507: an absent tool is silent and the account-local fallback works under bash nounset", (t) => {
  const f = fixture(t);
  const isolated = join(f.dir, "isolated-bin");
  mkdirSync(isolated);
  for (const name of ["bash", "git"]) {
    const path = execFileSync("which", [name], { encoding: "utf8" }).trim();
    symlinkSync(path, join(isolated, name));
  }
  executable(join(isolated, "uname"), "#!/bin/sh\necho Linux\n");
  const worktree = join(f.dir, "no-tool");
  const env = { ...f.env, PATH: isolated };
  const cut = spawnSync("git", ["worktree", "add", "-b", "no-tool", worktree], { cwd: f.dir, env, encoding: "utf8" });
  assert.equal(cut.status, 0, cut.stderr);
  assert.doesNotMatch(cut.stderr, /post-checkout:/);
  assert.deepEqual(f.recorded(), []);
  f.tool('echo \'{"method":"readonly-links","key":"fallback"}\'', true);
  const fallback = spawnSync("bash", ["-u", f.hook, NULL_SHA, "HEAD", "1"], { cwd: worktree, env, encoding: "utf8" });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.deepEqual(f.recorded(), [`prime ${worktree} --source ${f.dir}`]);
  assert.match(fallback.stderr, /fallback/);
});

test("W1-T10507: the installer reports a live checkout whose hooks dir lacks the post-checkout hook", (t) => {
  const f = fixture(t);
  const root = join(f.dir, "installer"), cron = join(root, "crontab");
  mkdirSync(root);
  const cronTool = join(root, "cron-tool");
  executable(cronTool, '#!/bin/sh\nif [ "$1" = -l ]; then cat "$CRON_FILE" 2>/dev/null; else cat > "$CRON_FILE"; fi\n');
  const env = { ...f.env, CRON_FILE: cron, RMD_SERVICE_USER: userInfo().username, RMD_SERVICE_UID: "",
    RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: join(root, "launcher"), RMD_REVIVAL_LOG: join(root, "revivals"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_CLEANUP_PATH: join(root, "cleanup"),
    RMD_CLEANUP_LIVE_CHECKOUTS: `${join(root, "not-a-repo")}:${f.dir}`,
    RMD_TMP_SWEEP_CRON_PATH: "", RMD_CRONTAB_CMD: cronTool, RMD_HOST_KERNEL: "Linux" };
  const run = (install = false) => spawnSync("bash", [INSTALLER, install ? "--install" : "--check"], {
    cwd: REPO_ROOT, env, encoding: "utf8",
  });
  const config = () => f.git(["config", "--get", "core.hooksPath"]);
  f.git(["config", "--unset", "core.hooksPath"]);
  let r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stdout.includes(`MISSING ${f.dir} post-checkout`), r.stdout);
  assert.equal(config().status, 1, "check mode must not set configuration");
  r = run(true);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(config().stdout.trim(), "hooks");
  r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  f.git(["config", "core.hooksPath", ""]);
  r = run(true);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(config().status, 0, "an explicitly empty hooksPath remains set");
  assert.equal(config().stdout.trim(), "");

  const absolute = join(root, "absolute hooks");
  mkdirSync(absolute);
  f.git(["config", "core.hooksPath", absolute]);
  r = run();
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(`MISSING ${f.dir} post-checkout`), r.stdout);
  const alternate = join(absolute, "post-checkout");
  executable(alternate, "#!/bin/sh\nexit 0\n");
  const before = readFileSync(alternate, "utf8");
  r = run();
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(`DRIFTED ${f.dir} post-checkout`), r.stdout);
  assert.match(r.stdout, /bring .* checkout to main/);
  r = run(true);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(config().stdout.trim(), absolute);
  assert.equal(readFileSync(alternate, "utf8"), before, "install must not replace a hook");
  copyFileSync(HOOK, alternate);
  chmodSync(alternate, 0o644);
  assert.ok(run().stdout.includes(`MISSING ${f.dir} post-checkout`));
  chmodSync(alternate, 0o755);
  assert.equal(run().status, 0);
  f.git(["config", "core.hooksPath", "installer/absolute hooks"]);
  assert.equal(run().status, 0, "relative hooksPath resolves from the checkout");

  f.git(["config", "core.hooksPath", "hooks"]);
  executable(f.hook, "#!/bin/sh\nexit 0\n");
  const stale = readFileSync(f.hook, "utf8");
  r = run(true);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`DRIFTED ${f.dir} post-checkout`));
  assert.equal(readFileSync(f.hook, "utf8"), stale, "a stale tracked hook is never rewritten");

  const sudoCalls = join(root, "sudo-calls");
  executable(join(f.bin, "sudo"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SERVICE_CALLS"\nshift 3\nexec "$@"\n');
  Object.assign(env, { RMD_SERVICE_USER: "fixture-service", SERVICE_CALLS: sudoCalls });
  f.git(["config", "--unset", "core.hooksPath"]);
  r = run(true);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(config().stdout.trim(), "hooks");
  assert.ok(readFileSync(sudoCalls, "utf8").includes(`-n -u fixture-service git -C ${f.dir} config core.hooksPath hooks`));
});
