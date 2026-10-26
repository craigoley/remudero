/** A worktree's retirement is judged by what removing it loses, against private fixture homes.
 * Runs the real helper on its default roots with real Git stores and worktrees. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HELPER = join(REPO_ROOT, "deploy/mac/preserve-retire.py");
const HOUR = 3600;
// The helper's clock runs two days ahead, so every fixture file is idle unless a test dates it later.
const NOW = Math.floor(Date.now() / 1000) + 48 * HOUR;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

interface Fx { root: string; home: string; store: string; bin: string }

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

/** An active common store under the Remudero root (recent README) with idle worktrees beside it. */
function setup(worktrees: string[]): Fx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-preserve-scope-")));
  const home = join(root, "home");
  mkdirSync(join(home, ".local/state/remudero"), { recursive: true, mode: 0o700 });
  for (const dir of [home, join(home, ".local"), join(home, ".local/state"), join(home, ".local/state/remudero")]) chmodSync(dir, 0o700);
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  const store = join(home, "Remudero/store");
  mkdirSync(join(store, ".."), { recursive: true });
  git(root, "clone", "--quiet", origin, store);
  writeFileSync(join(store, "README"), "published\n");
  git(store, "add", "README"); git(store, "commit", "--quiet", "-m", "published base");
  git(store, "push", "--quiet", "origin", "HEAD:main");
  for (const name of worktrees) {
    const path = join(home, "Remudero", name);
    git(store, "worktree", "add", "--quiet", "-b", name, path);
    writeFileSync(join(path, "work"), `${name}\n`);
    git(path, "add", "work"); git(path, "commit", "--quiet", "-m", `${name} work`);
  }
  utimesSync(join(store, "README"), NOW - HOUR, NOW - HOUR);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), '#!/bin/bash\nprintf "%s\\n" /bin/sh\n', { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  // Created owner-private, as the helper requires of its config: a policy input, not a denial fixture.
  writeFileSync(join(home, ".local/state/remudero/preserve-retire.json"), JSON.stringify({ enabled: true, idle_hours: 24,
    retain_days: 7, interval_hours: 0, published_remotes: [origin] }), { mode: 0o600 });
  return { root, home, store, bin };
}

/** Runs main() with `hook(path)` called after each successful preservation. */
function runWithHook(fx: Fx, hook: string) {
  const probe = `import importlib.util, os, subprocess, sys
spec = importlib.util.spec_from_file_location("pr", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
home, now, store = sys.argv[2], sys.argv[3], sys.argv[4]
def git(cwd, *a):
    return subprocess.run(["git", "-C", cwd, *a], check=True, capture_output=True, text=True).stdout.strip()
${hook}
original = m.preserve
def preserve(repo, *a):
    saved = original(repo, *a)
    after(repo.path)
    return saved
m.preserve = preserve
m.account_home = lambda: home
sys.argv = [sys.argv[1], "--home", home, "--now", now, "--apply"]
raise SystemExit(m.main())`;
  return spawnSync("python3", ["-I", "-B", "-c", probe, HELPER, fx.home, String(NOW), fx.store], {
    encoding: "utf8", timeout: 120_000, env: { ...GIT_ENV, PATH: `${fx.bin}:${process.env.PATH}` },
  });
}

function copies(fx: Fx, name: string): string[] {
  const top = join(fx.home, "Remudero-preserved");
  return existsSync(top) ? readdirSync(top).filter((d) => d.startsWith(`Remudero__${name}@`)).map((d) => join(top, d)) : [];
}

test("a worktree retires while its active common store moves and adds branches, and its saved copy holds only what removal loses", () => {
  const fx = setup(["wt-a", "wt-b"]);
  try {
    const tip = git(join(fx.home, "Remudero/wt-a"), "rev-parse", "HEAD");
    const r = runWithHook(fx, `n = 0
def after(path):
    global n
    n += 1
    git(store, "commit", "--quiet", "--allow-empty", "-m", f"coordinator {n}")
    git(store, "branch", f"coordinator-{n}")`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /RETIRED worktree .*Remudero\/wt-a/);
    assert.match(r.stdout, /RETIRED worktree .*Remudero\/wt-b/);
    assert.equal(existsSync(join(fx.home, "Remudero/wt-a")), false, "the idle worktree really retires");
    assert.equal(git(fx.store, "rev-parse", "refs/heads/wt-a"), tip, "its branch stays in the common store");
    assert.equal(git(fx.store, "rev-parse", "--verify", "-q", "refs/heads/coordinator-2").length, 40, "the store really moved");
    const [saved] = copies(fx, "wt-a");
    assert.ok(saved, "the retired worktree keeps its preserved copy");
    const header = readFileSync(join(saved, "unpublished.bundle")).subarray(0, 4096).toString("latin1").split("\n\n")[0];
    assert.match(header, new RegExp(`${tip} HEAD`));
    assert.doesNotMatch(header, /refs\/heads\//, "store branches are not the worktree's to save");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a worktree whose own HEAD or per-worktree ref moves after preservation is held, and its unused preserved copy is discarded", () => {
  const fx = setup(["wt-a", "wt-bisect", "wt-head"]);
  try {
    const r = runWithHook(fx, `def after(path):
    if path.endswith("/wt-bisect"):
        git(path, "update-ref", "refs/bisect/bad", "HEAD~1")
    if path.endswith("/wt-head"):
        git(path, "update-ref", "--no-deref", "HEAD", "HEAD~1")`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const name of ["wt-bisect", "wt-head"]) {
      assert.match(r.stdout, new RegExp(`HOLD refs-changed-before-retire .*Remudero/${name}\\n`));
      assert.equal(existsSync(join(fx.home, "Remudero", name)), true, `${name} stays`);
      assert.match(r.stdout, new RegExp(`DISCARDED source kept .*Remudero__${name}@`));
      assert.deepEqual(copies(fx, name), [], `${name}'s copy protects nothing and is removed`);
    }
    assert.match(r.stdout, /RETIRED worktree .*Remudero\/wt-a/);
    assert.equal(copies(fx, "wt-a").length, 1, "a retired worktree's copy is kept");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
