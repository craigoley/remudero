/** Runs the real preserve-then-retire helper and janitor against private fixture homes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { preserveRetireFixtureArgs } from "#test/helpers/preserve-retire-fixture.js";

const HELPER = join(REPO_ROOT, "deploy/mac/preserve-retire.py");
const JANITOR = join(REPO_ROOT, "deploy/mac/remudero-janitor.sh");
const HOUR = 3600;
// The helper's clock runs two days ahead, so every fixture file is idle unless a test dates it later.
const NOW = Math.floor(Date.now() / 1000) + 48 * HOUR;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

interface Fx { root: string; home: string; origin: string; bin: string; lsof: string }

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

function setup(config: Record<string, unknown> | null = {}): Fx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-preserve-retire-")));
  const home = join(root, "home");
  mkdirSync(join(home, ".local/state/remudero"), { recursive: true, mode: 0o700 });
  for (const dir of [home, join(home, ".local"), join(home, ".local/state"), join(home, ".local/state/remudero")]) chmodSync(dir, 0o700);
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  git(root, "clone", "--quiet", origin, seed);
  writeFileSync(join(seed, "README"), "published\n");
  git(seed, "add", "README"); git(seed, "commit", "--quiet", "-m", "published base");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const lsof = join(root, "open-paths");
  writeFileSync(lsof, "");
  writeFileSync(join(bin, "ps"), '#!/bin/bash\nprintf "%s\\n" "${LIVE_PATH:-/bin/sh}"\n', { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), `#!/bin/bash\nwhile IFS= read -r p; do [ -n "$p" ] && printf 'p1\\nn%s\\n' "$p"; done < '${lsof}'\nexit 0\n`, { mode: 0o755 });
  if (config) writeConfig({ root, home, origin, bin, lsof }, config);
  return { root, home, origin, bin, lsof };
}

function writeConfig(fx: Fx, extra: Record<string, unknown>, mode = 0o600) {
  const path = join(fx.home, ".local/state/remudero/preserve-retire.json");
  writeFileSync(path, JSON.stringify({ enabled: true, idle_hours: 24, retain_days: 7, interval_hours: 0,
    published_remotes: [fx.origin], ...extra }));
  chmodSync(path, mode);
}

function clone(fx: Fx, rel: string, ...extra: string[]): string {
  const path = join(fx.home, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  git(fx.root, "clone", "--quiet", ...extra, fx.origin, path);
  return path;
}

function commit(repo: string, file: string, text: string, message: string) {
  writeFileSync(join(repo, file), text);
  git(repo, "add", file); git(repo, "commit", "--quiet", "-m", message);
}

function helper(fx: Fx, args: string[] = ["--apply"], env: Record<string, string> = {}, now = NOW) {
  return spawnSync("python3", preserveRetireFixtureArgs(fx.home, HELPER, ["--home", fx.home, "--now", String(now), ...args]), {
    encoding: "utf8", timeout: 120_000,
    env: { ...GIT_ENV, PATH: `${fx.bin}:${process.env.PATH}`, ...env },
  });
}

function janitor(fx: Fx, apply: boolean) {
  return spawnSync("bash", [JANITOR, apply ? "--apply" : "--dry-run"], { encoding: "utf8", timeout: 120_000, env: {
    ...GIT_ENV, HOME: fx.home, PATH: `${fx.bin}:${process.env.PATH}`, TMPDIR: fx.root,
    REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.root,
    REMUDERO_JANITOR_DIRECTORY_ROOTS: join(fx.home, "Remudero"),
    REMUDERO_JANITOR_LOG: join(fx.root, "janitor.log"), REMUDERO_JANITOR_LOCK_DIR: join(fx.root, "janitor.lock"),
    REMUDERO_JANITOR_DECISION_LOG: join(fx.root, "decisions.tsv"),
  } });
}

function pythonProbe(fx: Fx, script: string) {
  const native = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
  writeFileSync(join(fx.bin, "python3"), `#!/bin/bash
case " $* " in *"/preserve-retire.py "*) ${script} ;; esac
exec '${native}' "$@"
`, { mode: 0o755 });
  return native;
}

function pythonAccountProbe(fx: Fx) {
  const native = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
  const bootstrap = join(fx.root, "fixture-preserve-retire.py");
  writeFileSync(bootstrap, `import importlib.util, sys
args = sys.argv[1:]
if args[0] == "-I":
    args.pop(0)
helper = args.pop(0)
spec = importlib.util.spec_from_file_location("pr", helper); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.account_home = lambda: ${JSON.stringify(fx.home)}
sys.argv = [helper, *args, "--now", "${NOW}"]
raise SystemExit(m.main())
`);
  pythonProbe(fx, `exec '${native}' -I -B '${bootstrap}' "$@"`);
}

function preserved(fx: Fx, rel: string): string {
  const root = join(fx.home, "Remudero-preserved");
  const name = readdirSync(root).find(n => n.startsWith(rel.replaceAll("/", "__") + "@"));
  assert.ok(name, `no preserved copy for ${rel} in ${readdirSync(root).join(", ")}`);
  return join(root, name);
}

/** Restore a preserved copy onto a fresh clone of the published origin, as MANIFEST.txt says. */
function restore(fx: Fx, copy: string, into: string): string {
  git(fx.root, "clone", "--quiet", fx.origin, into);
  const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8"));
  if (existsSync(join(copy, "unpublished.bundle"))) git(into, "bundle", "unbundle", join(copy, "unpublished.bundle"));
  git(into, "checkout", "--quiet", manifest.head);
  if (existsSync(join(copy, "uncommitted.patch"))) git(into, "apply", "--binary", join(copy, "uncommitted.patch"));
  if (existsSync(join(copy, "untracked.tar.gz"))) execFileSync("tar", ["-xzf", join(copy, "untracked.tar.gz"), "-C", into]);
  return into;
}

function touch(path: string, at: number) { utimesSync(path, at, at); }

test("preserve-then-retire saves unpublished commits, uncommitted edits and untracked files before it retires an idle clone", () => {
  const fx = setup();
  try {
    const repo = clone(fx, "Remudero/task-run/repo");
    commit(repo, "work.ts", "export const work = 1;\n", "unpublished local work");
    writeFileSync(join(repo, "README"), "published\nedited locally\n");
    writeFileSync(join(repo, "notes.md"), "untracked report\n");
    writeFileSync(join(repo, ".env"), "IGNORED=kept\n");
    writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\n");
    mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules/pkg/index.js"), "regenerable\n");
    const head = git(repo, "rev-parse", "HEAD");

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /PRESERVED 1 commits/);
    assert.match(r.stdout, /RETIRED clone .*task-run\/repo/);
    assert.equal(existsSync(repo), false, r.stdout);

    const copy = preserved(fx, "Remudero/task-run/repo");
    assert.equal(existsSync(join(copy, "MANIFEST.txt")), true);
    const back = restore(fx, copy, join(fx.root, "restored"));
    assert.equal(git(back, "rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(back, "work.ts"), "utf8"), "export const work = 1;\n");
    assert.equal(readFileSync(join(back, "README"), "utf8"), "published\nedited locally\n");
    assert.equal(readFileSync(join(back, "notes.md"), "utf8"), "untracked report\n");
    assert.equal(readFileSync(join(back, ".env"), "utf8"), "IGNORED=kept\n");
    assert.equal(existsSync(join(back, "node_modules")), false, "dependency trees are regenerated, not preserved");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("preserved restore instructions name the actual upstream repository", () => {
  const fx = setup();
  try {
    clone(fx, "Remudero/a-different-project");
    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const copy = preserved(fx, "Remudero/a-different-project");
    const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8"));
    assert.equal(manifest.remotes.origin, fx.origin);
    assert.ok(readFileSync(join(copy, "MANIFEST.txt"), "utf8").includes(`git clone ${fx.origin} <dir>`));
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a checkout changed within the idle window, named by a live command, or held open is kept", () => {
  const fx = setup();
  try {
    const recent = clone(fx, "Remudero/recent");
    touch(join(recent, "README"), NOW - 2 * HOUR);
    const live = clone(fx, "rmd-work/live");
    const open = clone(fx, ".codex/work-artifacts/open");
    writeFileSync(fx.lsof, join(open, "README") + "\n");
    const r = helper(fx, ["--apply"], { LIVE_PATH: `node ${live}/run.js` });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const path of [recent, live, open]) assert.equal(existsSync(path), true, path + r.stdout);
    assert.match(r.stdout, /HOLD active <24h .*Remudero\/recent/);
    assert.match(r.stdout, /HOLD live command names it .*rmd-work\/live/);
    assert.match(r.stdout, /HOLD open file or cwd inside .*work-artifacts\/open/);
    assert.match(r.stdout, /retired=0/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("an object lender stays while its borrower stays, and both are preserved before either is retired", () => {
  const fx = setup();
  try {
    const lender = clone(fx, "Remudero/lender");
    commit(lender, "lent.ts", "export const lent = true;\n", "commit stored only in the lender");
    const lent = git(lender, "rev-parse", "HEAD");
    const borrower = clone(fx, "Remudero/borrower", "--reference", lender);
    // The fetch writes no objects: the borrower's new branch points into the lender's store.
    git(borrower, "fetch", "--quiet", lender, `${lent}:refs/heads/borrowed`);
    git(borrower, "checkout", "--quiet", "borrowed");
    touch(join(borrower, "README"), NOW - HOUR);

    const first = helper(fx);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.equal(existsSync(lender), true, first.stdout);
    assert.match(first.stdout, /HOLD lends-objects-to-kept .*Remudero\/lender/);

    // A day later both are idle: both are preserved first, then both retire.
    const second = helper(fx, ["--apply"], {}, NOW + 24 * HOUR);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.equal(existsSync(lender), false, second.stdout);
    assert.equal(existsSync(borrower), false, second.stdout);
    const order = second.stdout.split("\n").map(l => l.split(" ")[1]).filter(a => a === "PRESERVED" || a === "RETIRED");
    assert.deepEqual(order, ["PRESERVED", "PRESERVED", "RETIRED", "RETIRED"], second.stdout);
    const back = restore(fx, preserved(fx, "Remudero/borrower"), join(fx.root, "restored"));
    assert.equal(readFileSync(join(back, "lent.ts"), "utf8"), "export const lent = true;\n");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a worktree whose git dir is gone, a locked worktree, and an oversized untracked file are held for a person", () => {
  const fx = setup({ max_untracked_mb: 1 });
  try {
    const main = clone(fx, "Remudero/main");
    const orphan = join(fx.home, "Remudero/orphan");
    git(main, "worktree", "add", "--quiet", "-b", "orphan", orphan);
    rmSync(join(main, ".git/worktrees/orphan"), { recursive: true, force: true });
    const locked = join(fx.home, "Remudero/locked");
    git(main, "worktree", "add", "--quiet", "-b", "locked", locked);
    git(main, "worktree", "lock", locked);
    const big = clone(fx, "Remudero/big");
    writeFileSync(join(big, "capture.bin"), Buffer.alloc(2 * 1024 * 1024));

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const path of [orphan, locked, big, main]) assert.equal(existsSync(path), true, path + r.stdout);
    assert.match(r.stdout, /HOLD history-unrecoverable \(worktree git dir missing\) .*Remudero\/orphan/);
    assert.match(r.stdout, /HOLD worktree-locked .*Remudero\/locked/);
    assert.match(r.stdout, /HOLD untracked-file-over-1MB \(capture.bin\) .*Remudero\/big/);
    assert.match(r.stdout, /HOLD has-kept-worktree .*Remudero\/main/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a refused worktree removal keeps its parent repository and counts each held repository once", () => {
  const fx = setup();
  try {
    const parent = clone(fx, "Remudero/parent");
    const child = join(fx.home, "Remudero/child");
    git(parent, "worktree", "add", "--quiet", "-b", "child", child);
    const nativeGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(fx.bin, "git"), `#!/bin/bash
case " $* " in *" worktree remove "*) echo "fixture removal refused" >&2; exit 1;; esac
exec '${nativeGit}' "$@"
`, { mode: 0o755 });
    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(child), true, r.stdout);
    assert.equal(existsSync(parent), true, r.stdout);
    assert.match(r.stdout, /HOLD has-kept-worktree .*Remudero\/parent/);
    assert.match(r.stdout, /summary candidates=2 retired=0 held=2 apply=1/, "the refused child and retained parent are each counted once");
    assert.equal(git(child, "cat-file", "-t", "HEAD"), "commit");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a bare repository's unpublished refs are bundled before it is retired", () => {
  const fx = setup();
  try {
    const bare = join(fx.home, "Remudero/offline-origin.git");
    git(fx.root, "clone", "--quiet", "--bare", fx.origin, bare);
    const work = join(fx.root, "pusher");
    git(fx.root, "clone", "--quiet", bare, work);
    commit(work, "only-here.ts", "export {};\n", "pushed only to the local bare origin");
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/offline-only");
    const tip = git(work, "rev-parse", "HEAD");
    rmSync(work, { recursive: true, force: true });

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(bare), false, r.stdout);
    const copy = preserved(fx, "Remudero/offline-origin.git");
    assert.match(readFileSync(join(copy, "refs.txt"), "utf8"), new RegExp(`${tip} refs/heads/offline-only`));
    const into = join(fx.root, "restored");
    git(fx.root, "clone", "--quiet", fx.origin, into);
    git(into, "bundle", "unbundle", join(copy, "unpublished.bundle"));
    assert.equal(git(into, "cat-file", "-t", tip), "commit");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("without an owner-private config the phase changes nothing, and a dry run plans only", () => {
  const fx = setup(null);
  try {
    const repo = clone(fx, "Remudero/idle");
    const none = helper(fx);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /disabled \(no config\)/);
    writeConfig(fx, {}, 0o644);
    const loose = helper(fx);
    assert.equal(loose.status, 2);
    assert.match(loose.stdout, /refused: config must be an owner-private 0600 file/);
    writeConfig(fx, {});
    chmodSync(join(fx.home, ".local/state"), 0o775);
    const shared = helper(fx);
    assert.equal(shared.status, 2, "a parent inside the home that others can write voids the config");
    chmodSync(join(fx.home, ".local/state"), 0o700);
    const dry = helper(fx, []);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /WOULD-RETIRE clone .*Remudero\/idle/);
    assert.equal(existsSync(repo), true);
    assert.equal(existsSync(join(fx.home, "Remudero-preserved")) && readdirSync(join(fx.home, "Remudero-preserved")).length > 0, false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("retention expires only stamped copies older than retain_days", () => {
  const fx = setup();
  try {
    const root = join(fx.home, "Remudero-preserved");
    const stamped = (name: string, at: number) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "manifest.json"), JSON.stringify({ preserved_at: at }));
      return join(root, name);
    };
    const old = stamped("Remudero__old@20260101T000000Z", NOW - 8 * 24 * HOUR);
    const fresh = stamped("Remudero__fresh@20260102T000000Z", NOW - 6 * 24 * HOUR);
    const manual = stamped("manual-copy", NOW - 30 * 24 * HOUR);
    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(old), false, r.stdout);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(manual), true, "copies the phase did not stamp are never expired");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the janitor runs the preserve-then-retire phase and rotates its human log", () => {
  const fx = setup();
  try {
    pythonAccountProbe(fx);
    const log = join(fx.root, "janitor.log");
    writeFileSync(log, "x".repeat(16 * 1024 * 1024 + 1));
    const r = spawnSync("bash", [JANITOR, "--dry-run"], { encoding: "utf8", timeout: 120_000, env: {
      ...GIT_ENV, HOME: fx.home, PATH: `${fx.bin}:${process.env.PATH}`, TMPDIR: fx.root,
      REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.root,
      REMUDERO_JANITOR_DIRECTORY_ROOTS: join(fx.home, "Remudero"),
      REMUDERO_JANITOR_LOG: log, REMUDERO_JANITOR_LOCK_DIR: join(fx.root, "janitor.lock"),
      REMUDERO_JANITOR_DECISION_LOG: join(fx.root, "decisions.tsv"),
    } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /preserve-retire: summary candidates=\d+ retired=0 held=\d+ apply=0/);
    assert.equal(existsSync(log + ".1"), true, "the oversized log was rotated");
    assert.ok(readFileSync(log, "utf8").length < 1024 * 1024, "the live log restarted small");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the janitor summary counts an actual preserved retirement in its total", () => {
  const fx = setup();
  try {
    const repo = clone(fx, "Remudero/unpublished");
    commit(repo, "work.ts", "export const work = true;\n", "unpublished work");
    pythonAccountProbe(fx);
    const r = janitor(fx, true);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(repo), false, r.stdout);
    const summary = r.stdout.split("\n").find(l => l.includes("=== done:"));
    assert.ok(summary, r.stdout);
    assert.match(summary, /removed=1 removed-complete=yes/);
    assert.match(summary, /preservation-status=completed preservation-retired=1 preservation-held=0 preservation-planned=0/);
    assert.match(summary, /reclaimed-scope=legacy/);
    const restored = restore(fx, preserved(fx, "Remudero/unpublished"), join(fx.root, "restored"));
    assert.equal(readFileSync(join(restored, "work.ts"), "utf8"), "export const work = true;\n");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the janitor summary distinguishes dry-run, disabled, throttled and unknown preservation outcomes", () => {
  const fx = setup();
  try {
    const output = join(fx.root, "preservation-output");
    const exit = join(fx.root, "preservation-exit");
    pythonProbe(fx, `cat '${output}'; exit "$(cat '${exit}')"`);
    const cases = [
      { apply: false, output: "summary candidates=2 retired=0 held=3 apply=0", exit: 0, fields: "preservation-status=completed preservation-retired=0 preservation-held=3 preservation-planned=2", complete: "yes" },
      { apply: true, output: "disabled (no config)", exit: 0, fields: "preservation-status=disabled preservation-retired=0 preservation-held=unknown preservation-planned=0", complete: "yes" },
      { apply: true, output: "skip ran within 6h", exit: 0, fields: "preservation-status=throttled preservation-retired=0 preservation-held=unknown preservation-planned=0", complete: "yes" },
      { apply: true, output: "summary candidates=2 retired=2 held=3 apply=1", exit: 17, fields: "preservation-status=failed preservation-retired=unknown", complete: "no" },
      { apply: true, output: "summary candidates=2 retired=999 held=3 apply=1", exit: 0, fields: "preservation-status=unverified preservation-retired=unknown", complete: "no" },
      { apply: true, output: "summary candidates=2 retired=0 held=3 apply=0", exit: 0, fields: "preservation-status=unverified preservation-retired=unknown", complete: "no" },
    ];
    for (const c of cases) {
      writeFileSync(output, `preserve-retire: ${c.output}\n`); writeFileSync(exit, String(c.exit));
      const r = janitor(fx, c.apply);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const summary = r.stdout.split("\n").find(l => l.includes("=== done:"));
      assert.ok(summary, r.stdout);
      assert.ok(summary.includes(c.fields), summary);
      assert.ok(summary.includes(`removed=0 removed-complete=${c.complete}`), summary);
    }
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("housekeeping repacks a repository with too many packs and keeps every object, even in a kept checkout", () => {
  const fx = setup({ repack_min_packs: 3 });
  try {
    const repo = clone(fx, "Remudero/many-packs");
    git(repo, "config", "maintenance.auto", "false");  // or a commit's background maintenance merges them
    // One pack per fetch-sized batch, as repeated fetches with automatic gc off leave them.
    const pack = () => execFileSync("git", ["-C", repo, "pack-objects", "--revs", "-q", ".git/objects/pack/pack"], { input: "HEAD\n", env: GIT_ENV });
    for (let i = 0; i < 4; i++) { commit(repo, `f${i}.txt`, `${i}\n`, `commit ${i}`); pack(); }
    const orphan = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: "unreachable\n", encoding: "utf8", env: GIT_ENV }).trim();
    // Packed and no longer loose, so only --keep-unreachable can carry it through the repack.
    execFileSync("git", ["-C", repo, "pack-objects", "-q", ".git/objects/pack/pack"], { input: orphan + "\n", env: GIT_ENV });
    git(repo, "prune-packed");
    const packs = () => readdirSync(join(repo, ".git/objects/pack")).filter(n => n.endsWith(".pack")).length;
    assert.ok(packs() >= 4, `fixture made ${packs()} packs`);
    // The real clock makes the checkout active, so it is kept and only repacked.
    const r = helper(fx, ["--apply"], {}, Math.floor(Date.now() / 1000));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /REPACKED packs=\d+->1 .*many-packs\/\.git/);
    assert.match(r.stdout, /housekeeping repacked=1 /);
    assert.equal(packs(), 1);
    assert.equal(existsSync(repo), true);
    git(repo, "cat-file", "-e", orphan);
    git(repo, "fsck", "--no-dangling");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("outside any checkout an idle dump is compressed, an old one expires and idle build folders are removed", () => {
  const fx = setup({ dump_min_mb: 1, dump_retain_days: 14 });
  try {
    const run = join(fx.home, "Remudero/run-notes");
    const pkg = join(run, "pkg"), fixtures = join(run, "source/test/ci");
    for (const dir of [join(run, "node_modules/x"), join(pkg, "coverage"), join(fixtures, "coverage")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(run, "node_modules/x/index.js"), "x\n");
    writeFileSync(join(pkg, "package.json"), "{}\n");
    writeFileSync(join(pkg, "coverage/lcov.info"), "SF:a\n");
    writeFileSync(join(fixtures, "coverage/expected.txt"), "fixture data\n");
    const big = "[" + '"subject",'.repeat(150_000) + '"end"]';
    writeFileSync(join(run, "subjects.json"), big);
    writeFileSync(join(run, "open.json"), big);
    writeFileSync(join(run, "small.json"), "{}\n");
    writeFileSync(join(run, "old.json.gz"), "compressed earlier\n");
    touch(join(run, "old.json.gz"), NOW - 20 * 24 * HOUR);
    const kept = clone(fx, "Remudero/run-notes/checkout");
    writeFileSync(join(kept, "inside.json"), big);
    mkdirSync(join(kept, "node_modules"));
    writeFileSync(join(fx.lsof), [join(run, "open.json"), join(kept, "README")].join("\n") + "\n");

    const dry = helper(fx, []);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /housekeeping repacked=0 compressed=1 dumps-expired=1 build-dirs-removed=2 codex-sessions-removed=0 apply=0/);
    assert.equal(existsSync(join(run, "subjects.json")), true, "a dry run changes nothing");

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(gunzipSync(readFileSync(join(run, "subjects.json.gz"))).toString("utf8"), big);
    assert.equal(existsSync(join(run, "subjects.json")), false);
    assert.equal(existsSync(join(run, "old.json.gz")), false, "unchanged for 14 days");
    assert.equal(existsSync(join(run, "node_modules")), false);
    assert.equal(existsSync(join(pkg, "coverage")), false);
    for (const path of [join(run, "open.json"), join(run, "small.json"), join(fixtures, "coverage/expected.txt"),
      join(kept, "inside.json"), join(kept, "node_modules")]) assert.equal(existsSync(path), true, path);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a root pattern scans every folder it matches and nothing beside them", () => {
  const fx = setup();
  try {
    const matched = clone(fx, "Downloads/remudero-recovery-1/repo");
    const other = clone(fx, "Downloads/other-project/repo");
    writeFileSync(join(fx.home, "Downloads/remudero-key.pem"), "secret\n");
    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /RETIRED clone .*Downloads\/remudero-recovery-1\/repo/);
    assert.equal(existsSync(matched), false);
    assert.equal(existsSync(other), true);
    assert.equal(readFileSync(join(fx.home, "Downloads/remudero-key.pem"), "utf8"), "secret\n");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("dump expiry spares small files, a package root's files and anything inside an application bundle", () => {
  const fx = setup({ dump_min_mb: 1, dump_retain_days: 7 });
  try {
    const run = join(fx.home, "Remudero/run-notes");
    const project = join(run, "unpacked-project"), bundle = join(run, "browsers/Chrome for Testing.app/Contents");
    for (const dir of [project, bundle]) mkdirSync(dir, { recursive: true });
    const big = "[" + '"subject",'.repeat(150_000) + '"end"]';
    const files = {
      dump: join(run, "subjects.json"), small: join(run, "build.log"), pkg: join(project, "package.json"),
      lock: join(project, "package-lock.json"), bundled: join(bundle, "Resources.json"),
    };
    for (const [key, path] of Object.entries(files)) writeFileSync(path, key === "small" ? "ok\n" : big);
    for (const path of Object.values(files)) touch(path, NOW - 20 * 24 * HOUR);

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /housekeeping .*dumps-expired=1 /);
    assert.equal(existsSync(files.dump), false, r.stdout);
    for (const key of ["small", "pkg", "lock", "bundled"] as const) assert.equal(existsSync(files[key]), true, `${key}\n${r.stdout}`);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("an owned temp root is scanned, a clone in a root other accounts can enter is preserved then retired, and a symlinked one is never a root", () => {
  const fx = setup({ temp_roots: ["remudero-*"] });
  try {
    const tmp = join(fx.root, "tmp");
    for (const [dir, mode] of [["remudero-shared", 0o755], ["remudero-private", 0o700], ["outside/remudero-elsewhere", 0o700]] as const) {
      mkdirSync(join(tmp, dir), { recursive: true }); chmodSync(join(tmp, dir), mode);
    }
    execFileSync("ln", ["-s", join(tmp, "outside/remudero-elsewhere"), join(tmp, "remudero-link")]);
    const shared = join(tmp, "remudero-shared/repo");
    git(fx.root, "clone", "--quiet", fx.origin, shared);
    const worktree = join(tmp, "remudero-shared/task");
    git(shared, "worktree", "add", "--quiet", "-b", "task", worktree);
    commit(worktree, "task.ts", "export const task = 1;\n", "unpublished task work");
    const owned = join(tmp, "remudero-private/repo");
    git(fx.root, "clone", "--quiet", fx.origin, owned);
    const linked = join(tmp, "outside/remudero-elsewhere/repo");
    git(fx.root, "clone", "--quiet", fx.origin, linked);

    const r = helper(fx, ["--apply", "--temp-base", tmp]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /RETIRED worktree .*remudero-shared\/task/);
    assert.match(r.stdout, /RETIRED clone .*remudero-private\/repo/);
    assert.match(r.stdout, /RETIRED clone .*remudero-shared\/repo/);
    assert.doesNotMatch(r.stdout, /shared-temp-root/);
    assert.equal(existsSync(worktree), false);
    assert.equal(existsSync(owned), false);
    assert.equal(existsSync(shared), false, "a 755 temp root no longer holds its clone forever");
    assert.ok(readdirSync(join(fx.home, "Remudero-preserved")).some(n => n.includes("remudero-shared__repo@")), "it is preserved before it goes");
    assert.equal(existsSync(linked), true, r.stdout);
    assert.doesNotMatch(r.stdout, /remudero-link|outside\/remudero-elsewhere/);
    const back = restore(fx, readdirSync(join(fx.home, "Remudero-preserved")).filter(n => n.includes("remudero-shared__task@"))
      .map(n => join(fx.home, "Remudero-preserved", n))[0], join(fx.root, "restored"));
    assert.equal(readFileSync(join(back, "task.ts"), "utf8"), "export const task = 1;\n");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the borrower census walks the temp folder, so a home clone lending to a temp clone stays", () => {
  const fx = setup({ temp_roots: ["remudero-*"] });
  try {
    const tmp = join(fx.root, "tmp");
    mkdirSync(join(tmp, "unrelated-scratch"), { recursive: true });
    const lender = clone(fx, "Remudero/lender");
    commit(lender, "lent.ts", "export const lent = true;\n", "commit stored only in the lender");
    const lent = git(lender, "rev-parse", "HEAD");
    const borrower = join(tmp, "unrelated-scratch/borrower");
    git(fx.root, "clone", "--quiet", "--reference", lender, fx.origin, borrower);
    git(borrower, "fetch", "--quiet", lender, `${lent}:refs/heads/borrowed`);

    const r = helper(fx, ["--apply", "--temp-base", tmp]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /HOLD lends-objects-to-kept .*Remudero\/lender/);
    assert.equal(existsSync(lender), true);
    git(borrower, "cat-file", "-e", `${lent}^{commit}`);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("codex session logs idle past codex_session_days are removed; recent, open and other files stay", () => {
  const fx = setup({ codex_session_days: 7 });
  try {
    const day = join(fx.home, ".codex/sessions/2026/09/20");
    const archived = join(fx.home, ".codex/archived_sessions");
    mkdirSync(day, { recursive: true }); mkdirSync(archived, { recursive: true });
    const idle = join(day, "rollout-2026-09-20T18-19-07-idle.jsonl");
    const idleArchived = join(archived, "rollout-2026-09-24T12-43-58-archived.jsonl");
    const recent = join(day, "rollout-2026-09-20T19-00-00-recent.jsonl");
    const open = join(day, "rollout-2026-09-20T20-00-00-open.jsonl");
    const other = join(day, "notes.jsonl");
    for (const p of [idle, idleArchived, recent, open, other]) writeFileSync(p, "{}\n");
    // ctime cannot be set back, so the helper's clock runs ahead instead.
    const later = NOW + 8 * 24 * HOUR;
    touch(recent, later - HOUR);
    writeFileSync(fx.lsof, open + "\n");

    const dry = helper(fx, [], {}, later);
    assert.match(dry.stdout, /housekeeping .*codex-sessions-removed=2 apply=0/);
    assert.equal(existsSync(idle), true);
    const r = helper(fx, ["--apply"], {}, later);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(idle), false, r.stdout);
    assert.equal(existsSync(idleArchived), false, r.stdout);
    for (const p of [recent, open, other]) assert.equal(existsSync(p), true, `${p}\n${r.stdout}`);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a failed preservation bundle is held with git's own reason", () => {
  const fx = setup();
  try {
    const repo = clone(fx, "Remudero/task-run/repo");
    commit(repo, "work.ts", "export const work = 1;\n", "unpublished local work");
    const native = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(fx.bin, "git"), `#!/bin/bash
case " $* " in *" bundle create "*) echo "fatal: simulated pack failure" >&2; exit 128 ;; esac
exec '${native}' "$@"
`, { mode: 0o755 });
    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /HOLD bundle-create-failed \(fatal: simulated pack failure\) .*Remudero\/task-run\/repo/);
    assert.equal(existsSync(repo), true);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the janitor sweeps unreferenced dependency seeds, and names a stray URL-encoded store with --root", () => {
  const fx = setup();
  try {
    mkdirSync(join(fx.home, ".local/bin"), { recursive: true });
    const calls = join(fx.root, "seed-calls");
    writeFileSync(join(fx.home, ".local/bin/remudero-dependencies"), `#!/bin/bash
printf '%s %s\\n' "\${RMD_DEPENDENCY_SEED_ROOT:-default}" "$*" >> '${calls}'
echo '[{"seed":"/s/a","action":"remove","reason":"unreferenced and idle for six hours"},{"seed":"/s/b","action":"keep","reason":"referenced by checkout"}]'
`, { mode: 0o755 });
    const r = janitor(fx, true);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /dependency-seeds: removed=1 kept=1/);
    assert.equal(readFileSync(calls, "utf8"), "default sweep --apply\n", "no stray store, no stray sweep");
    rmSync(calls);
    const stray = join(fx.home, "Library/Application%20Support/Remudero/dependencies");
    mkdirSync(stray, { recursive: true }); writeFileSync(join(stray, ".rmd-dependency-seed-root.json"), '{"version":1}');
    const again = janitor(fx, true);
    assert.match(again.stdout, /dependency-seeds-stray: removed=1 kept=1/);
    assert.equal(readFileSync(calls, "utf8"), `default sweep --apply\ndefault sweep --root ${stray} --apply\n`);
    rmSync(calls);
    assert.equal(janitor(fx, false).status, 0);
    assert.equal(existsSync(calls), false, "a dry run never sweeps");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
