/**
 * test/a-satellite-worktree-gets-its-own-dependency-tree.test.ts — W1-T4260.
 *
 * THE FAILURE MODE. One image runs three daemons (core, remudero-site, remudero-console). In each
 * container the target clone at `<config.root>/repos/<repo>` has no node_modules, so
 * `resolveNodeModulesSource` falls back to the rmd install root — CORE's tree — for every
 * worktree. A satellite needs next, react and @clerk/nextjs, which core lacks, and the symlink
 * also stops review's `ensureDeps` from installing the right tree.
 *
 * THE FIX. `worktreeAdd` gives a CROSS-PACKAGE worktree (its package.json name differs from the
 * install root's, and its clone has no tree of its own) a tree at
 * `<config.root>/deps/<package>/<hashInstallInputs>/node_modules`, installed once under a lock
 * and renamed into place atomically. Every failure falls back to today's link plus a
 * `deps.install_failed` ledger line: this task never refuses a dispatch. A core worktree reads
 * two package names and changes nothing else.
 *
 * Every git fixture is real (`worktreeAdd` shells git end to end); the installer is injected
 * except in the one test that shells the REAL default `npm ci` over a zero-dependency lockfile,
 * which succeeds offline.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { hashInstallInputs } from "../src/lib/install-hash.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import {
  DEPS_INSTALL_TIMEOUT_MS,
  DEPS_LOCK_STALE_MS,
  DEPS_LOCK_WAIT_MS,
  dependencyInstallEnv,
  dependencyTreeBytes,
  worktreeAdd,
} from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

/** The install root `resolveNodeModulesSource` falls back to: this checkout, package "remudero". */
const INSTALL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_ROOT_NM = join(INSTALL_ROOT, "node_modules");

type LogLine = { step: string } & Record<string, unknown>;
type AddDeps = NonNullable<Parameters<typeof worktreeAdd>[4]>;

function pkg(name: string, deps: Record<string, string> = {}): string {
  return JSON.stringify({ name, version: "0.0.0", dependencies: deps }, null, 2) + "\n";
}

function lock(name: string, deps: Record<string, string> = {}): string {
  const packages: Record<string, unknown> = { "": { name, version: "0.0.0", dependencies: deps } };
  for (const [n, v] of Object.entries(deps)) packages[`node_modules/${n}`] = { version: v.replace(/^\^/, "") };
  return JSON.stringify({ name, version: "0.0.0", lockfileVersion: 3, requires: true, packages }, null, 2) + "\n";
}

/** A bare origin seeded with `files`, cloned to `<root>/repos/<repo>` — the fleet's canonical-clone shape. Every repo here is
 * built by the shared `gitRepo()` fixture; this only places the clone where `worktreeAdd` derives `<config.root>` from. */
function seededUnderRoot(root: string, repo: string, files: Record<string, string>): string {
  const seed = gitRepo({ kind: `w1-t4260-seed-${repo}` });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(seed.dir, name), body);
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  const origin = gitRepo({ bare: true, kind: `w1-t4260-origin-${repo}` });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const repoDir = join(root, "repos", repo);
  mkdirSync(join(root, "repos"), { recursive: true });
  renameSync(gitRepo({ cloneFrom: origin.dir, kind: `w1-t4260-clone-${repo}` }).dir, repoDir);
  return repoDir;
}

function satellite(root: string, repo: string, deps: Record<string, string> = { next: "^15.0.0" }): string {
  return seededUnderRoot(root, repo, { "package.json": pkg(repo, deps), "package-lock.json": lock(repo, deps) });
}

function newRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4260-${label}-`));
}

/** A fake installer that lays down one package the way `npm ci` would, recording each call's cwd. */
function fakeInstaller(calls: string[]): AddDeps["installDependencies"] {
  return (dir: string) => {
    calls.push(dir);
    const pkgName = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string }).name;
    mkdirSync(join(dir, "node_modules", "installed-for"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "installed-for", "package.json"), JSON.stringify({ name: pkgName }));
  };
}

function add(
  t: TestContext,
  repoDir: string,
  root: string,
  name: string,
  extra: Partial<AddDeps> = {},
): { wt: string; logs: LogLine[]; errors: string[] } {
  const errors: string[] = [];
  t.mock.method(console, "error", (m: string) => errors.push(m));
  const logs: LogLine[] = [];
  const wt = join(root, "worktrees", name);
  worktreeAdd(repoDir, wt, `run-${name}`, "origin/main", {
    log: (step, x) => logs.push({ step, ...(x ?? {}) }),
    ...extra,
  });
  return { wt, logs, errors };
}

const stepOf = (logs: LogLine[], step: string): LogLine | undefined => logs.find((l) => l.step === step);

// ── the four acceptance proofs ──────────────────────────────────────────────────────────────

test("W1-T4260: a satellite worktree links a tree keyed by its own repo and lockfile hash", (t) => {
  const root = newRoot("keyed");
  try {
    const repoDir = satellite(root, "remudero-site");
    const calls: string[] = [];
    const a = add(t, repoDir, root, "a", { installDependencies: fakeInstaller(calls) });
    const hash = hashInstallInputs(a.wt);
    const tree = join(root, "deps", "remudero-site", hash, "node_modules");
    assert.equal(readlinkSync(join(a.wt, "node_modules")), tree, "linked to <config.root>/deps/<package>/<hash>/node_modules");
    assert.equal(hashInstallInputs(dirname(tree)), hash, "the tree's own install inputs are the worktree's, byte for byte");
    assert.equal(calls.length, 1);
    assert.equal(dirname(calls[0]!), join(root, "deps", "remudero-site"), "installed in a temp dir BESIDE the target");
    assert.notEqual(calls[0], dirname(tree), "never installed into the final path directly");
    const installed = stepOf(a.logs, "deps.installed");
    assert.equal(installed?.package, "remudero-site");
    assert.equal(installed?.hash, hash);
    assert.equal(typeof installed?.duration_ms, "number");
    assert.equal(installed?.tree_count, 1, "the tree count under the package is recorded (design vi)");
    assert.ok(Number(installed?.size_bytes) > 0, "and the tree's size");
    assert.equal(installed?.timeout_ms, DEPS_INSTALL_TIMEOUT_MS);
    assert.deepEqual(a.errors.filter((m) => m.startsWith("node_modules lockfile mismatch:")), [], "the link matches its inputs");
    assert.equal(stepOf(a.logs, "worktree.node_modules_cross_package"), undefined, "no cross-link happened to report");
    assert.deepEqual(
      readdirSync(join(root, "deps", "remudero-site")),
      [hash],
      "no temp dir or lock file is left beside the tree",
    );

    // A second worktree at the same lockfile REUSES the exact-hash tree: no second install.
    const b = add(t, repoDir, root, "b", { installDependencies: fakeInstaller(calls) });
    assert.equal(readlinkSync(join(b.wt, "node_modules")), tree);
    assert.equal(calls.length, 1, "exact-hash reuse installs nothing");
    assert.equal(stepOf(b.logs, "deps.reused")?.hash, hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: two repos with distinct lockfiles never share a tree", (t) => {
  const root = newRoot("distinct");
  try {
    const site = satellite(root, "remudero-site", { next: "^15.0.0" });
    const consoleRepo = satellite(root, "remudero-console", { next: "^15.0.0", "@clerk/nextjs": "^6.0.0" });
    const calls: string[] = [];
    const s = add(t, site, root, "site", { installDependencies: fakeInstaller(calls) });
    const c = add(t, consoleRepo, root, "console", { installDependencies: fakeInstaller(calls) });
    const siteTree = readlinkSync(join(s.wt, "node_modules"));
    const consoleTree = readlinkSync(join(c.wt, "node_modules"));
    assert.notEqual(siteTree, consoleTree);
    assert.equal(siteTree, join(root, "deps", "remudero-site", hashInstallInputs(s.wt), "node_modules"));
    assert.equal(consoleTree, join(root, "deps", "remudero-console", hashInstallInputs(c.wt), "node_modules"));
    assert.equal(calls.length, 2, "each repo installs its own tree");
    const installedFor = (tree: string) =>
      (JSON.parse(readFileSync(join(tree, "installed-for", "package.json"), "utf8")) as { name: string }).name;
    assert.equal(installedFor(siteTree), "remudero-site");
    assert.equal(installedFor(consoleTree), "remudero-console");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a failed install falls back to the install root link and is never refused", (t) => {
  const root = newRoot("failed");
  try {
    const repoDir = satellite(root, "remudero-console");
    let calls = 0;
    const r = add(t, repoDir, root, "a", {
      installDependencies: () => {
        calls += 1;
        throw new Error("simulated: npm ci exited 1 (ETARGET)");
      },
    });
    assert.equal(calls, 1);
    assert.equal(readlinkSync(join(r.wt, "node_modules")), INSTALL_ROOT_NM, "today's link to the install root");
    const failed = stepOf(r.logs, "deps.install_failed");
    assert.equal(failed?.package, "remudero-console");
    assert.equal(failed?.stage, "install");
    assert.match(String(failed?.reason), /simulated: npm ci exited 1/);
    assert.equal(failed?.fallback, INSTALL_ROOT_NM);
    const cross = stepOf(r.logs, "worktree.node_modules_cross_package");
    assert.equal(cross?.worktree_package, "remudero-console", "the cross-link is ledgered as W1-T4193 names it");
    assert.equal(cross?.node_modules_package, "remudero");
    assert.deepEqual(readdirSync(join(root, "deps", "remudero-console")), [], "the half tree and the lock are both removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a core worktree is unchanged", (t) => {
  const root = newRoot("core");
  try {
    // Core: its package name IS the install root's, and its clone carries no node_modules.
    const repoDir = seededUnderRoot(root, "remudero", {
      "package.json": pkg("remudero"),
      "package-lock.json": lock("remudero"),
    });
    let calls = 0;
    const r = add(t, repoDir, root, "core", {
      installDependencies: () => {
        calls += 1;
      },
    });
    assert.equal(readlinkSync(join(r.wt, "node_modules")), INSTALL_ROOT_NM, "linked to the install root, as today");
    assert.equal(calls, 0, "never installs");
    assert.equal(existsSync(join(root, "deps")), false, "never creates a deps root");
    assert.deepEqual(r.logs.map((l) => l.step).filter((s) => s.startsWith("deps.")), [], "no deps.* line");
    assert.deepEqual(r.logs.map((l) => l.step), ["worktree.add"], "the ledger is exactly today's");
    assert.equal(execFileSync("git", ["-C", r.wt, "status", "--porcelain"], { encoding: "utf8" }), "", "a clean tree");

    // A satellite whose OWN clone carries node_modules keeps linking it, byte-identically too.
    const own = satellite(root, "remudero-site");
    mkdirSync(join(own, "node_modules"));
    const o = add(t, own, root, "own", {
      installDependencies: () => {
        calls += 1;
      },
    });
    assert.equal(readlinkSync(join(o.wt, "node_modules")), join(own, "node_modules"));
    assert.equal(calls, 0);
    assert.equal(existsSync(join(root, "deps")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the default installer, really shelled ───────────────────────────────────────────────────

test("W1-T4260: the default installer really runs npm ci over a zero-dependency lockfile", (t) => {
  const root = newRoot("real-npm");
  try {
    const repoDir = satellite(root, "remudero-site", {});
    const r = add(t, repoDir, root, "real");
    const failed = stepOf(r.logs, "deps.install_failed");
    assert.equal(failed, undefined, `the real npm ci must succeed offline: ${String(failed?.reason)}`);
    const tree = join(root, "deps", "remudero-site", hashInstallInputs(r.wt), "node_modules");
    assert.equal(readlinkSync(join(r.wt, "node_modules")), tree);
    assert.equal(lstatSync(tree).isDirectory(), true, "an empty dependency set is still a real, empty tree");
    assert.equal(stepOf(r.logs, "deps.installed")?.package, "remudero-site");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── each fallback arm ───────────────────────────────────────────────────────────────────────

test("W1-T4260: a failed rename removes the temp tree and falls back", (t) => {
  const root = newRoot("rename");
  try {
    const repoDir = satellite(root, "remudero-site");
    const calls: string[] = [];
    const r = add(t, repoDir, root, "a", {
      installDependencies: fakeInstaller(calls),
      renameDir: () => {
        throw new Error("simulated: EXDEV cross-device rename");
      },
    });
    assert.equal(readlinkSync(join(r.wt, "node_modules")), INSTALL_ROOT_NM);
    const failed = stepOf(r.logs, "deps.install_failed");
    assert.equal(failed?.stage, "rename");
    assert.match(String(failed?.reason), /EXDEV/);
    assert.deepEqual(readdirSync(join(root, "deps", "remudero-site")), [], "no half tree survives");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a rename that loses to a finished tree reuses it", (t) => {
  const root = newRoot("rename-race");
  try {
    const repoDir = satellite(root, "remudero-site");
    const r = add(t, repoDir, root, "a", {
      installDependencies: fakeInstaller([]),
      // Another installer finished the same hash first: the target exists and the rename fails.
      renameDir: (from, to) => {
        renameSync(from, to);
        throw new Error("simulated: ENOTEMPTY");
      },
    });
    const tree = join(root, "deps", "remudero-site", hashInstallInputs(r.wt), "node_modules");
    assert.equal(readlinkSync(join(r.wt, "node_modules")), tree);
    assert.equal(stepOf(r.logs, "deps.reused")?.hash, hashInstallInputs(r.wt));
    assert.equal(stepOf(r.logs, "deps.install_failed"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a lock held past the wait bound falls back without waiting forever", (t) => {
  const root = newRoot("lock-timeout");
  try {
    const repoDir = satellite(root, "remudero-site");
    // Hash the committed inputs through a throwaway worktree-free read: the clone carries them.
    const hash = hashInstallInputs(repoDir);
    mkdirSync(join(root, "deps", "remudero-site"), { recursive: true });
    const lockPath = join(root, "deps", "remudero-site", `${hash}.lock`);
    writeFileSync(lockPath, "held by a live installer\n");
    const start = Date.now();
    let clock = start;
    let slept = 0;
    let calls = 0;
    const r = add(t, repoDir, root, "a", {
      installDependencies: () => {
        calls += 1;
      },
      clock: clockFromMillisFn(() => clock),
      sleepMs: (ms) => {
        slept += 1;
        clock += ms;
      },
    });
    assert.equal(calls, 0, "never installs without the lock");
    assert.ok(slept > 0, "it waited");
    assert.ok(clock - start >= DEPS_LOCK_WAIT_MS, "for the whole bound");
    assert.equal(readlinkSync(join(r.wt, "node_modules")), INSTALL_ROOT_NM);
    const failed = stepOf(r.logs, "deps.install_failed");
    assert.equal(failed?.stage, "lock_timeout");
    assert.equal(existsSync(lockPath), true, "another holder's lock is never deleted while fresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: the default sleep really waits one poll before the bound expires", (t) => {
  const root = newRoot("lock-real-sleep");
  try {
    const repoDir = satellite(root, "remudero-site");
    const hash = hashInstallInputs(repoDir);
    mkdirSync(join(root, "deps", "remudero-site"), { recursive: true });
    writeFileSync(join(root, "deps", "remudero-site", `${hash}.lock`), "held\n");
    // The clock stands still for the first poll (start, stale check, bound check), then jumps past the bound.
    const base = Date.now();
    let reads = 0;
    const started = Date.now();
    const r = add(t, repoDir, root, "a", {
      installDependencies: fakeInstaller([]),
      clock: clockFromMillisFn(() => (++reads <= 3 ? base : base + DEPS_LOCK_WAIT_MS)),
    });
    assert.ok(Date.now() - started >= 900, "the REAL default sleep blocked for about one poll");
    assert.equal(stepOf(r.logs, "deps.install_failed")?.stage, "lock_timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a waiter reuses the tree the lock holder finishes", (t) => {
  const root = newRoot("lock-wait");
  try {
    const repoDir = satellite(root, "remudero-site");
    const hash = hashInstallInputs(repoDir);
    const pkgDir = join(root, "deps", "remudero-site");
    mkdirSync(pkgDir, { recursive: true });
    const lockPath = join(pkgDir, `${hash}.lock`);
    writeFileSync(lockPath, "held\n");
    let calls = 0;
    const r = add(t, repoDir, root, "a", {
      installDependencies: () => {
        calls += 1;
      },
      // The holder finishes while this caller sleeps: the tree appears and the lock goes.
      sleepMs: () => {
        mkdirSync(join(pkgDir, hash, "node_modules"), { recursive: true });
        rmSync(lockPath, { force: true });
      },
    });
    assert.equal(calls, 0);
    assert.equal(readlinkSync(join(r.wt, "node_modules")), join(pkgDir, hash, "node_modules"));
    assert.equal(stepOf(r.logs, "deps.reused")?.hash, hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a lock released without a tree is re-acquired and installed", (t) => {
  const root = newRoot("lock-released");
  try {
    const repoDir = satellite(root, "remudero-site");
    const hash = hashInstallInputs(repoDir);
    const pkgDir = join(root, "deps", "remudero-site");
    mkdirSync(pkgDir, { recursive: true });
    const lockPath = join(pkgDir, `${hash}.lock`);
    writeFileSync(lockPath, "held\n");
    const calls: string[] = [];
    const r = add(t, repoDir, root, "a", {
      installDependencies: fakeInstaller(calls),
      // The holder failed and let go: no tree, no lock.
      sleepMs: () => rmSync(lockPath, { force: true }),
    });
    assert.equal(calls.length, 1);
    assert.equal(readlinkSync(join(r.wt, "node_modules")), join(pkgDir, hash, "node_modules"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a lock older than the stale bound is reclaimed", (t) => {
  const root = newRoot("lock-stale");
  try {
    const repoDir = satellite(root, "remudero-site");
    const hash = hashInstallInputs(repoDir);
    const pkgDir = join(root, "deps", "remudero-site");
    mkdirSync(pkgDir, { recursive: true });
    const lockPath = join(pkgDir, `${hash}.lock`);
    writeFileSync(lockPath, "left by a SIGKILLed holder\n");
    // The REAL default age read: an mtime older than the install bound means the holder is dead.
    const past = (Date.now() - DEPS_LOCK_STALE_MS - 60_000) / 1000;
    utimesSync(lockPath, past, past);
    const calls: string[] = [];
    const r = add(t, repoDir, root, "a", { installDependencies: fakeInstaller(calls) });
    assert.equal(calls.length, 1, "the stale lock was reclaimed and the tree installed");
    assert.equal(readlinkSync(join(r.wt, "node_modules")), join(pkgDir, hash, "node_modules"));
    assert.equal(stepOf(r.logs, "deps.lock_reclaimed")?.hash, hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a lock that cannot be created falls back", (t) => {
  const root = newRoot("lock-error");
  try {
    const repoDir = satellite(root, "remudero-site");
    // A FILE where the package dir must be: mkdir and the lock open both fail with a non-EEXIST error.
    mkdirSync(join(root, "deps"), { recursive: true });
    writeFileSync(join(root, "deps", "remudero-site"), "not a directory\n");
    const r = add(t, repoDir, root, "a", { installDependencies: fakeInstaller([]) });
    assert.equal(readlinkSync(join(r.wt, "node_modules")), INSTALL_ROOT_NM);
    assert.equal(stepOf(r.logs, "deps.install_failed")?.stage, "lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a satellite with no lockfile falls back without shelling npm", (t) => {
  const root = newRoot("no-lock");
  try {
    const repoDir = seededUnderRoot(root, "remudero-site", { "package.json": pkg("remudero-site", { next: "^15.0.0" }) });
    let calls = 0;
    const r = add(t, repoDir, root, "a", {
      installDependencies: () => {
        calls += 1;
      },
    });
    assert.equal(calls, 0);
    assert.equal(readlinkSync(join(r.wt, "node_modules")), INSTALL_ROOT_NM);
    assert.equal(stepOf(r.logs, "deps.install_failed")?.stage, "no_lockfile");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a clone outside <root>/repos has no deps root and falls back", (t) => {
  const root = newRoot("no-root");
  try {
    const repoDir = satellite(root, "remudero-site");
    const moved = join(root, "elsewhere", "remudero-site");
    mkdirSync(dirname(moved), { recursive: true });
    renameSync(repoDir, moved);
    const r = add(t, moved, root, "a", { installDependencies: fakeInstaller([]) });
    assert.equal(readlinkSync(join(r.wt, "node_modules")), INSTALL_ROOT_NM);
    assert.equal(stepOf(r.logs, "deps.install_failed")?.stage, "no_deps_root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: an explicit deps root is honoured wherever the clone lives", (t) => {
  const root = newRoot("explicit-root");
  try {
    const repoDir = satellite(root, "remudero-site");
    const depsRoot = join(root, "custom-deps");
    const r = add(t, repoDir, root, "a", { installDependencies: fakeInstaller([]), depsRoot });
    assert.equal(
      readlinkSync(join(r.wt, "node_modules")),
      join(depsRoot, "remudero-site", hashInstallInputs(r.wt), "node_modules"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: an unsafe package name never becomes a path and falls back", (t) => {
  const root = newRoot("unsafe-name");
  try {
    const repoDir = seededUnderRoot(root, "remudero-site", { "package.json": pkg(".."), "package-lock.json": lock("..") });
    const r = add(t, repoDir, root, "a", { installDependencies: fakeInstaller([]) });
    assert.equal(readlinkSync(join(r.wt, "node_modules")), INSTALL_ROOT_NM);
    assert.equal(stepOf(r.logs, "deps.install_failed")?.stage, "unsafe_package_name");
    assert.equal(existsSync(join(root, "deps")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: a scoped package name is flattened to one path segment", (t) => {
  const root = newRoot("scoped");
  try {
    const repoDir = seededUnderRoot(root, "remudero-site", {
      "package.json": pkg("@remudero/site"),
      "package-lock.json": lock("@remudero/site"),
    });
    const r = add(t, repoDir, root, "a", { installDependencies: fakeInstaller([]) });
    assert.equal(
      readlinkSync(join(r.wt, "node_modules")),
      join(root, "deps", "_remudero_site", hashInstallInputs(r.wt), "node_modules"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: an unexpected throw anywhere in provisioning still links the install root", (t) => {
  const root = newRoot("unexpected");
  try {
    const repoDir = satellite(root, "remudero-site");
    const r = add(t, repoDir, root, "a", {
      installDependencies: fakeInstaller([]),
      clock: clockFromMillisFn(() => {
        throw new Error("simulated: clock unavailable");
      }),
    });
    assert.equal(readlinkSync(join(r.wt, "node_modules")), INSTALL_ROOT_NM);
    const failed = stepOf(r.logs, "deps.install_failed");
    assert.equal(failed?.stage, "unexpected");
    assert.match(String(failed?.reason), /clock unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: the implement lane ledgers the cross-link once, not twice", (t) => {
  const root = newRoot("implement");
  try {
    const repoDir = satellite(root, "remudero-site");
    const r = add(t, repoDir, root, "a", {
      installDependencies: () => {
        throw new Error("simulated failure");
      },
      refuseSamePackageLockfileMismatch: true,
    });
    assert.equal(readlinkSync(join(r.wt, "node_modules")), INSTALL_ROOT_NM, "never refused");
    assert.equal(r.logs.filter((l) => l.step === "worktree.node_modules_cross_package").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: dependencyTreeBytes sums a tree and reads an absent one as zero", () => {
  const root = newRoot("bytes");
  try {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "one"), "12345");
    writeFileSync(join(root, "a", "b", "two"), "123");
    assert.equal(dependencyTreeBytes(root), 8);
    assert.equal(dependencyTreeBytes(join(root, "absent")), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4260: the install bound is named and SIGKILL-sized under the lock bounds", () => {
  assert.equal(DEPS_INSTALL_TIMEOUT_MS, 120_000, "review's ensureDeps bound: the install blocks the daemon's own process");
  assert.ok(DEPS_LOCK_STALE_MS > DEPS_INSTALL_TIMEOUT_MS, "a live holder is never reclaimed as stale");
  assert.ok(DEPS_LOCK_WAIT_MS > DEPS_INSTALL_TIMEOUT_MS, "a waiter outlasts a live holder's bounded install");
  assert.ok(DEPS_LOCK_WAIT_MS < DEPS_LOCK_STALE_MS, "and never reclaims a lock that was fresh when it arrived");
});

test("W1-T4260: a satellite install never sees the daemon's tokens", () => {
  const env = dependencyInstallEnv({
    PATH: "/usr/bin",
    HOME: "/home/node",
    HTTPS_PROXY: "http://proxy:3128",
    npm_config_cache: "/home/node/.npm",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    GH_TOKEN: "ghs_secret",
    GITHUB_TOKEN: "ghs_secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    OPENAI_API_KEY: "sk-secret",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "HTTPS_PROXY", "NPM_CONFIG_REGISTRY", "PATH", "npm_config_cache"]);
});
