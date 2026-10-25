/** Preserve-retire discovers managed checkouts anywhere in the home and every registered worktree,
 * against private fixture homes with real Git. Nothing here writes inside a node_modules folder. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { preserveRetireFixtureArgs } from "#test/helpers/preserve-retire-fixture.js";

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

interface Fx { root: string; home: string; origin: string; personal: string; bin: string; config: string }

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

function bareOrigin(root: string, name: string): string {
  const origin = join(root, name);
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  const seed = join(root, `seed-${name}`);
  git(root, "clone", "--quiet", origin, seed);
  writeFileSync(join(seed, "README"), `${name}\n`);
  git(seed, "add", "README"); git(seed, "commit", "--quiet", "-m", "published base");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  return origin;
}

/** A private home whose config names `origin.git` as the managed remote; `personal.git` is not one. */
function setup(config: Record<string, unknown> = {}): Fx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-preserve-discover-")));
  const home = join(root, "home");
  mkdirSync(join(home, ".local/state/remudero"), { recursive: true, mode: 0o700 });
  for (const dir of [home, join(home, ".local"), join(home, ".local/state"), join(home, ".local/state/remudero")]) chmodSync(dir, 0o700);
  const origin = bareOrigin(root, "origin.git");
  const personal = bareOrigin(root, "personal.git");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), '#!/bin/bash\nprintf "%s\\n" /bin/sh\n', { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const path = join(home, ".local/state/remudero/preserve-retire.json");
  // Created owner-private, as the helper requires of its config: a policy input, not a denial fixture.
  writeFileSync(path, JSON.stringify({ enabled: true, idle_hours: 24, retain_days: 7, interval_hours: 0,
    published_remotes: [origin], managed_remotes: [origin], ...config }), { mode: 0o600 });
  return { root, home, origin, personal, bin, config: path };
}

function clone(fx: Fx, rel: string, origin = fx.origin): string {
  const path = join(fx.home, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  git(fx.root, "clone", "--quiet", origin, path);
  return path;
}

function commit(repo: string, file: string, text: string, message: string) {
  writeFileSync(join(repo, file), text);
  git(repo, "add", file); git(repo, "commit", "--quiet", "-m", message);
}

/** Dates a checkout's working file at the helper's clock, so the checkout is active, not idle. */
function touchActive(repo: string) {
  writeFileSync(join(repo, "active.txt"), "in use\n");
  utimesSync(join(repo, "active.txt"), NOW, NOW);
}

function helper(fx: Fx, apply = true) {
  return spawnSync("python3", preserveRetireFixtureArgs(fx.home, HELPER, ["--home", fx.home, "--now", String(NOW), ...(apply ? ["--apply"] : [])]), {
    encoding: "utf8", timeout: 300_000, env: { ...GIT_ENV, PATH: `${fx.bin}:${process.env.PATH}` },
  });
}

/** Runs `body` with the helper imported as `m`, its account home substituted with the fixture's. */
function probe(fx: Fx, body: string, ...args: string[]) {
  const code = `import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location("pr", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
home, config, temp = sys.argv[2:5]
m.account_home = lambda: home
args = sys.argv[5:]
${body}`;
  // -B: importing the helper must not write deploy/mac/__pycache__ into the tracked tree.
  return spawnSync("python3", ["-I", "-B", "-c", code, HELPER, fx.home, fx.config, join(fx.root, "no-temp"), ...args], {
    encoding: "utf8", timeout: 300_000, env: GIT_ENV,
  });
}

/** Every entry under `top` by path, type, mode and SHA-256 of its bytes (or its link target). */
function bytes(top: string): string[] {
  if (!existsSync(top)) return ["<removed>"];
  const out: string[] = [];
  const visit = (path: string) => {
    const st = lstatSync(path), rel = path.slice(top.length) || "/";
    if (st.isSymbolicLink()) out.push(`${rel} link ${readlinkSync(path)}`);
    else if (st.isDirectory()) { out.push(`${rel} dir ${st.mode}`); for (const name of readdirSync(path).sort()) visit(join(path, name)); }
    else out.push(`${rel} file ${st.mode} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
  };
  visit(top);
  return out;
}

test("an idle worktree of a managed origin in a folder outside every root is preserved, then retired", () => {
  const fx = setup();
  try {
    const store = clone(fx, "Remudero/store");
    touchActive(store); // the store itself stays: only the worktree outside the roots is idle
    const wt = join(fx.home, "Developer/agent-x/wt");
    mkdirSync(join(wt, ".."), { recursive: true });
    git(store, "worktree", "add", "--quiet", "-b", "agent-x", wt);
    commit(wt, "work.ts", "export const work = 1;\n", "unpublished work outside the roots");

    const plan = helper(fx, false);
    assert.equal(plan.status, 0, plan.stderr + plan.stdout);
    assert.match(plan.stdout, /WOULD-RETIRE worktree .*\/home\/Developer\/agent-x\/wt\n/);

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /PRESERVED 1 commits .*Remudero-preserved\/Developer__agent-x__wt@/);
    assert.match(r.stdout, /RETIRED worktree .*\/home\/Developer\/agent-x\/wt\n/);
    assert.equal(existsSync(wt), false, r.stdout);
    const copies = readdirSync(join(fx.home, "Remudero-preserved")).filter((n) => n.startsWith("Developer__agent-x__wt@"));
    assert.equal(copies.length, 1, r.stdout);
    assert.equal(existsSync(join(fx.home, "Remudero-preserved", copies[0], "unpublished.bundle")), true);
    assert.match(r.stdout, /HOLD active <24h .*\/home\/Remudero\/store\n/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("an idle clone with no managed remote outside the roots is never a candidate and keeps every byte", () => {
  const fx = setup();
  try {
    const personal = clone(fx, "Developer/agent-y/personal", fx.personal);
    commit(personal, "notes.md", "my own project\n", "personal unpublished work");
    writeFileSync(join(personal, "draft.txt"), "untracked personal draft\n");
    // Positive control in the same walk: a managed clone beside it is found and retired.
    const control = clone(fx, "Developer/agent-y/managed");
    const before = bytes(personal);

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /RETIRED clone .*\/home\/Developer\/agent-y\/managed\n/);
    assert.equal(existsSync(control), false);
    assert.doesNotMatch(r.stdout, /agent-y\/personal/, "a repository without a managed remote is not even reported");
    assert.deepEqual(bytes(personal), before);
    assert.match(r.stdout, /summary candidates=1 retired=1 /);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a registered worktree inside a store's .git folder is retired when idle and unlocked, and held as worktree-locked when locked", () => {
  const fx = setup();
  try {
    // The store's own remote is not managed: these worktrees are found by registration alone.
    const store = clone(fx, "Remudero/recovery/ops-compat-operator", fx.personal);
    const spaces = join(store, ".git/operator-plan-workspaces");
    mkdirSync(spaces);
    const idle = join(spaces, "plan-1"), locked = join(spaces, "plan-2");
    git(store, "worktree", "add", "--quiet", "-b", "plan-1", idle);
    git(store, "worktree", "add", "--quiet", "-b", "plan-2", locked);
    git(store, "worktree", "lock", "--reason", "operator plan", locked);
    commit(idle, "plan.md", "plan one\n", "unpublished plan one");
    const before = bytes(locked);

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /PRESERVED \d+ commits .*ops-compat-operator__\.git__operator-plan-workspaces__plan-1@/);
    assert.match(r.stdout, /RETIRED worktree .*\.git\/operator-plan-workspaces\/plan-1\n/);
    assert.equal(existsSync(idle), false, r.stdout);
    assert.match(r.stdout, /HOLD worktree-locked .*\.git\/operator-plan-workspaces\/plan-2\n/);
    assert.deepEqual(bytes(locked), before);
    assert.match(r.stdout, /HOLD has-kept-worktree .*\/Remudero\/recovery\/ops-compat-operator\n/);
    git(store, "fsck", "--no-progress");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("home-wide discovery still skips Library, Documents, symlinked folders, protected paths, the preserve root and shared object pools", () => {
  const fx = setup();
  try {
    const skipped = [
      clone(fx, "Library/Caches/agent/repo"), clone(fx, "Documents/agent/repo"), clone(fx, "rmd-state2/repo"),
      clone(fx, "Remudero-preserved/agent/repo"), clone(fx, "Desktop/repo"), clone(fx, ".Trash/repo"),
    ];
    const pool = join(fx.home, ".local/share/remudero/git-pools/remudero.git");
    mkdirSync(join(pool, ".."), { recursive: true });
    git(fx.root, "clone", "--quiet", "--bare", fx.origin, pool);
    const outside = join(fx.root, "outside");
    mkdirSync(outside);
    git(fx.root, "clone", "--quiet", fx.origin, join(outside, "repo"));
    symlinkSync(outside, join(fx.home, "linked"));
    const watched = [...skipped, pool, join(outside, "repo")];
    const control = clone(fx, "Developer/agent-z/repo");
    const before = watched.map(bytes);

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /RETIRED clone .*\/home\/Developer\/agent-z\/repo\n/, "positive control: the walk ran");
    assert.equal(existsSync(control), false);
    assert.deepEqual(watched.map(bytes), before);
    assert.doesNotMatch(r.stdout, /Library|Documents|rmd-state2|Remudero-preserved\/agent|Desktop|\.Trash|git-pools|linked|outside/);
    assert.match(r.stdout, /summary candidates=1 retired=1 /);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("remove refuses a path that is neither under a root nor discovered, and one discovered outside the home", () => {
  const fx = setup();
  try {
    const stray = clone(fx, "Developer/stray/repo");
    const allowed = clone(fx, "Developer/allowed/repo");
    const away = join(fx.root, "away");
    git(fx.root, "clone", "--quiet", fx.origin, away);
    const r = probe(fx, `
roots = [os.path.join(home, "Remudero")]
def attempt(path, via):
    repo = m.Repo(path, "clone"); repo.store = path + "/.git"; repo.via = via
    try:
        m.remove(repo, roots, [], [repo], home)
        return "removed"
    except m.Hold as h:
        return str(h)
print(json.dumps([attempt(args[0], "root"), attempt(args[2], "managed-remote"), attempt(args[1], "managed-remote")]))`, stray, allowed, away);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ["path-guard", "path-guard", "removed"]);
    assert.equal(existsSync(stray), true, "a path under no root and not discovered stays");
    assert.equal(existsSync(away), true, "a discovered path outside the home stays");
    assert.equal(existsSync(allowed), false, "positive control: a discovered path inside the home is removable");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("home-wide discovery over a synthetic home of 24,000 folders stays fast and finds only managed checkouts", () => {
  const fx = setup();
  try {
    // 20,000 ordinary folders (the deepest beyond the depth limit) and 4,000 under Library it must never enter.
    for (let a = 0; a < 40; a++) for (let b = 0; b < 50; b++) mkdirSync(join(fx.home, `Developer/p${a}/d${b}/x/y/z/w/v/u/t/s`), { recursive: true });
    for (let a = 0; a < 40; a++) for (let b = 0; b < 100; b++) mkdirSync(join(fx.home, `Library/c${a}/d${b}`), { recursive: true });
    clone(fx, "Developer/p3/d4/managed");
    clone(fx, "Developer/p5/d6/personal", fx.personal);
    clone(fx, "Library/c1/d1/managed");
    const r = probe(fx, `
cfg, why = m.load_config(home, config, temp)
assert cfg, why
start = time.monotonic(); repos = m.discover(cfg, m.protected_paths(home, cfg)); elapsed = time.monotonic() - start
print(json.dumps({"elapsed": elapsed, "found": [[os.path.relpath(r.path, home), r.via] for r in repos]}))`);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { elapsed: number; found: [string, string][] };
    console.log(`# discovery over the synthetic home took ${out.elapsed.toFixed(2)} s`);
    assert.deepEqual(out.found, [["Developer/p3/d4/managed", "managed-remote"]]);
    assert.ok(out.elapsed < 30, `discovery took ${out.elapsed} s`);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
