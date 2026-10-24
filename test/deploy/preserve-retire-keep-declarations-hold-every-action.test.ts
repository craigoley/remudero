/** Keep declarations and seed stores hold every preserve-retire action, against private fixture homes.
 * Runs the real helper on its default roots; nothing here writes inside a node_modules folder. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

interface Fx { root: string; home: string; origin: string; bin: string }

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

function setup(config: Record<string, unknown>): Fx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-preserve-keep-")));
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
  writeFileSync(join(bin, "ps"), '#!/bin/bash\nprintf "%s\\n" /bin/sh\n', { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const path = join(home, ".local/state/remudero/preserve-retire.json");
  // Created owner-private, as the helper requires of its config: a policy input, not a denial fixture.
  writeFileSync(path, JSON.stringify({ enabled: true, idle_hours: 24, retain_days: 7, interval_hours: 0,
    published_remotes: [origin], ...config }), { mode: 0o600 });
  return { root, home, origin, bin };
}

function clone(fx: Fx, rel: string): string {
  const path = join(fx.home, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  git(fx.root, "clone", "--quiet", fx.origin, path);
  return path;
}

function commit(repo: string, file: string, text: string, message: string) {
  writeFileSync(join(repo, file), text);
  git(repo, "add", file); git(repo, "commit", "--quiet", "-m", message);
}

function helper(fx: Fx, now = NOW, apply = true) {
  return spawnSync("python3", ["-I", HELPER, "--home", fx.home, "--now", String(now), ...(apply ? ["--apply"] : [])], {
    encoding: "utf8", timeout: 120_000, env: { ...GIT_ENV, PATH: `${fx.bin}:${process.env.PATH}` },
  });
}

/** A seed generation shaped like materializeDependencySeed's, with a consumer record naming `checkout`.
 * Its node_modules stays empty: the scoped author sandbox forbids writes inside any node_modules. */
function seedGeneration(dir: string, checkout: string) {
  mkdirSync(join(dir, "consumers"), { recursive: true });
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "ready.json"), JSON.stringify({ key: dir.split("/").pop(), version: 1, lastUsed: 0 }));
  writeFileSync(join(dir, "consumers/7b7974c6.json"), JSON.stringify({ checkout, mountNamespace: "host" }));
}

/** Every entry under `top` — Git objects, refs, index and worktree admin included — by path, type,
 * mode and SHA-256 of its bytes (or its link target), read without running Git. */
function bytes(top: string): string[] {
  if (!existsSync(top) && !(() => { try { return lstatSync(top).isSymbolicLink(); } catch { return false; } })()) return ["<removed>"];
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

test("loose-folder housekeeping leaves seed stores, seed generations and keep-declared folders whole, and still removes an unreferenced build dir", () => {
  const fx = setup({ dump_min_mb: 1, dump_retain_days: 1 });
  const recovery = join(fx.home, ".local/share/remudero/source-recovery/20261019");
  try {
    const consumer = clone(fx, "Remudero/consumer");
    const big = "[" + '"subject",'.repeat(150_000) + '"end"]';
    const store = join(recovery, "private-foundation-dependencies");
    const marked = join(store, "5741d32373be98b605347f2875306b1e1a59cbd67484ab25bf8cd08b1f0287c1");
    seedGeneration(marked, consumer);
    writeFileSync(join(store, ".rmd-dependency-seed-root.json"), '{"version":1}');
    writeFileSync(join(marked, "subjects.json"), big);
    const unmarked = join(recovery, "private-foundation-dependencies-restored/b312649b2eb9f1579951d385ec71b609d85833d1396b9e2d84ac4ec7f3699a99");
    seedGeneration(unmarked, consumer);
    const kept = join(recovery, "kept");
    for (const dir of [join(kept, "proj/node_modules"), join(recovery, "scratch-kept/node_modules"),
      join(recovery, "vendored/coverage"), join(recovery, "disposable/node_modules")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(kept, ".rmd-janitor-keep"), "foundation inputs\n");
    writeFileSync(join(kept, "proj/run.json"), big);
    writeFileSync(join(kept, "old.json.gz"), "compressed earlier\n");
    utimesSync(join(kept, "old.json.gz"), NOW - 20 * 24 * HOUR, NOW - 20 * 24 * HOUR);
    symlinkSync(join(fx.root, "absent-marker-target"), join(recovery, "scratch-kept/.rmd-scratch-keep"));
    writeFileSync(join(recovery, "vendored/package.json"), "{}\n");
    writeFileSync(join(recovery, "vendored/coverage/.rmd-dependency-seed-root.json"), '{"version":1}');
    const before = [store, unmarked, kept].map(bytes);

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /housekeeping repacked=0 compressed=0 dumps-expired=0 build-dirs-removed=1 /);
    assert.match(r.stdout, /REMOVED build-dir .*source-recovery\/20261019\/disposable\/node_modules/);
    assert.equal(existsSync(join(recovery, "disposable/node_modules")), false);
    assert.deepEqual([store, unmarked, kept].map(bytes), before, "every byte of a store, generation or kept folder is unchanged");
    for (const path of [join(recovery, "scratch-kept/node_modules"), join(recovery, "vendored/coverage/.rmd-dependency-seed-root.json")]) {
      assert.equal(existsSync(path), true, `${path}\n${r.stdout}`);
    }
    assert.match(r.stdout, /HOLD keep-declared \(\.rmd-dependency-seed-root\.json\) at .*vendored\/coverage/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a ready.json beside a dangling, linked or non-folder consumers entry holds as seed-shaped evidence", () => {
  const fx = setup({});
  try {
    const recovery = join(fx.home, ".local/share/remudero/source-recovery/20261019");
    const cases = { dangling: "", linked: "", file: "" };
    for (const name of Object.keys(cases) as (keyof typeof cases)[]) {
      const generation = join(recovery, `restored-${name}/4f2a`);
      mkdirSync(join(generation, "node_modules"), { recursive: true });
      writeFileSync(join(generation, "ready.json"), '{"version":1}');
      cases[name] = generation;
    }
    symlinkSync(join(fx.root, "absent-consumers"), join(cases.dangling, "consumers"));
    mkdirSync(join(fx.root, "consumers-elsewhere"));
    symlinkSync(join(fx.root, "consumers-elsewhere"), join(cases.linked, "consumers"));
    writeFileSync(join(cases.file, "consumers"), "not a folder\n");
    mkdirSync(join(recovery, "disposable/node_modules"), { recursive: true });

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const generation of Object.values(cases)) assert.equal(existsSync(join(generation, "node_modules")), true, `${generation}\n${r.stdout}`);
    assert.equal(existsSync(join(recovery, "disposable/node_modules")), false, "an unmarked build dir beside them still goes");
    assert.match(r.stdout, /build-dirs-removed=1 /);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("discovery never preserves, retires, repacks or prunes a repository under, inside or sharing a store with a keep declaration, and still retires an unmarked idle clone", () => {
  const fx = setup({ repack_min_packs: 1 });
  try {
    const control = clone(fx, "Remudero/idle-control");
    commit(control, "work.ts", "export const work = 1;\n", "unpublished control work");
    const under = clone(fx, "Remudero/kept-tree/repo");
    writeFileSync(join(fx.home, "Remudero/kept-tree/.rmd-janitor-keep"), "");
    commit(under, "kept.ts", "export const kept = 1;\n", "unpublished work under a keep declaration");
    const worktree = join(fx.home, "Remudero/worktree-of-kept");
    git(under, "worktree", "add", "--quiet", "-b", "side", worktree);
    commit(worktree, "side.ts", "export const side = 1;\n", "unpublished work in a worktree of a kept store");
    const containing = clone(fx, "Remudero/has-inner");
    mkdirSync(join(containing, "vendor"));
    writeFileSync(join(containing, "vendor/.rmd-scratch-keep"), "");
    // A worktree elsewhere of a store whose main checkout holds a marker: its path and store show none.
    const sibling = join(fx.home, "Remudero/worktree-of-has-inner");
    git(containing, "worktree", "add", "--quiet", "-b", "sibling", sibling);
    commit(sibling, "sibling.ts", "export const sibling = 1;\n", "unpublished work in a sibling worktree");
    const seeded = clone(fx, ".local/share/remudero/source-recovery/store/5741d323/packages/pkg");
    writeFileSync(join(fx.home, ".local/share/remudero/source-recovery/store/.rmd-dependency-seed-root.json"), '{"version":1}');
    for (const repo of [under, containing, seeded]) git(repo, "repack", "-a", "-d", "-q"); // one pack each: a repack candidate
    const held = [join(fx.home, "Remudero/kept-tree"), worktree, containing, sibling, seeded];
    const before = held.map(bytes);

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(held.map(bytes), before, "every byte of a held repository — objects, refs, index, worktree admin, working files — is unchanged");
    assert.match(r.stdout, /RETIRED clone .*Remudero\/idle-control/);
    assert.equal(existsSync(control), false);
    assert.match(r.stdout, /HOLD keep-declared \(\.rmd-janitor-keep\) at .*Remudero\/kept-tree .*Remudero\/kept-tree\/repo/);
    assert.match(r.stdout, /HOLD keep-declared \(\.rmd-janitor-keep\) at .*Remudero\/kept-tree .*Remudero\/worktree-of-kept/);
    assert.match(r.stdout, /HOLD keep-declared \(\.rmd-scratch-keep\) at .*has-inner\/vendor .*Remudero\/has-inner/);
    assert.match(r.stdout, /HOLD store-of-a-keep-scoped-checkout .*Remudero\/worktree-of-has-inner/);
    assert.match(r.stdout, /HOLD keep-declared \(\.rmd-dependency-seed-root\.json\) at .*source-recovery\/store .*packages\/pkg/);
    assert.doesNotMatch(r.stdout, /REPACKED .*(kept-tree|has-inner|source-recovery)/);
    assert.doesNotMatch(r.stdout, /PRESERVED .*(kept-tree|worktree-of|has-inner|packages__pkg)/, "a held repository is never even a candidate");
    git(under, "fsck", "--no-progress");
    git(containing, "fsck", "--no-progress");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a keep declaration above a scan root holds the whole root, and a kept Codex log or preserved copy is never removed", () => {
  const fx = setup({ codex_session_days: 7 });
  try {
    const recovery = join(fx.home, ".local/share/remudero/source-recovery");
    mkdirSync(recovery, { recursive: true });
    writeFileSync(join(fx.home, ".local/share/remudero/.rmd-scratch-keep"), "every recovery input\n");
    mkdirSync(join(recovery, "disposable/node_modules"), { recursive: true });
    const inside = clone(fx, ".local/share/remudero/source-recovery/repo");
    const sessions = join(fx.home, ".codex/sessions/2026/09/20"), archived = join(fx.home, ".codex/archived_sessions");
    mkdirSync(sessions, { recursive: true }); mkdirSync(archived, { recursive: true });
    writeFileSync(join(fx.home, ".codex/sessions/.rmd-janitor-keep"), "");
    const keptLog = join(sessions, "rollout-2026-09-20T18-19-07-kept.jsonl"), idleLog = join(archived, "rollout-2026-09-24T12-43-58-idle.jsonl");
    for (const p of [keptLog, idleLog]) writeFileSync(p, "{}\n");
    const later = NOW + 8 * 24 * HOUR;
    const copies = join(fx.home, "Remudero-preserved");
    const stamped = (name: string) => {
      mkdirSync(join(copies, name), { recursive: true });
      writeFileSync(join(copies, name, "manifest.json"), JSON.stringify({ preserved_at: later - 9 * 24 * HOUR }));
      return join(copies, name);
    };
    const keptCopy = stamped("Remudero__kept@20260101T000000Z"), oldCopy = stamped("Remudero__old@20260101T000000Z");
    writeFileSync(join(keptCopy, ".rmd-janitor-keep"), "");
    const before = [inside, keptCopy].map(bytes);

    const r = helper(fx, later);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(join(recovery, "disposable/node_modules")), true, r.stdout);
    assert.deepEqual([inside, keptCopy].map(bytes), before, "the held clone and the kept copy are byte-for-byte unchanged");
    assert.match(r.stdout, /HOLD keep-declared \(\.rmd-scratch-keep\) at .*\.local\/share\/remudero .*source-recovery\/repo/);
    assert.equal(readFileSync(keptLog, "utf8"), "{}\n", r.stdout);
    assert.equal(existsSync(idleLog), false, "an unkept idle log still goes");
    assert.equal(existsSync(oldCopy), false, "an unkept old copy still expires");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("worktree prune leaves a kept or keep-scoped store's stale worktree records alone and still prunes an unmarked store", () => {
  const fx = setup({});
  try {
    // Three stores, each with one worktree whose folder is gone, leaving only stale admin records.
    const stale = (repo: string, name: string) => {
      const wt = join(fx.home, "Remudero", name);
      git(repo, "worktree", "add", "--quiet", "-b", name, wt);
      rmSync(wt, { recursive: true, force: true });
      return join(repo, ".git/worktrees", name);
    };
    const kept = clone(fx, "Remudero/kept-tree/repo");
    writeFileSync(join(fx.home, "Remudero/kept-tree/.rmd-janitor-keep"), "");
    const shared = clone(fx, "Remudero/shared-store");
    const plain = clone(fx, "Remudero/plain");
    const records = { kept: stale(kept, "wt-kept"), shared: stale(shared, "wt-shared"), plain: stale(plain, "wt-plain") };
    const before = [records.kept, records.shared].map(bytes);
    const probe = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pr", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
holder = m.Repo(sys.argv[3], "clone"); holder.store = sys.argv[3] + "/.git"; holder.scoped = "a keep marker in its working tree"
print(json.dumps(m.prune_worktrees([sys.argv[2] + "/.git", holder.store, sys.argv[4] + "/.git"], [holder])))`;
    // -B: importing the helper must not write deploy/mac/__pycache__ into the tracked tree.
    const r = spawnSync("python3", ["-I", "-B", "-c", probe, HELPER, kept, shared, plain], { encoding: "utf8", env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [join(plain, ".git")], "only the unmarked store is pruned");
    assert.equal(existsSync(records.plain), false, "an unmarked store's stale record is pruned");
    assert.deepEqual([records.kept, records.shared].map(bytes), before, "a kept store keeps every byte of its worktree records");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a dry run never prunes worktree records, and an apply run still prunes an unmarked store's stale record", () => {
  const fx = setup({});
  try {
    const repo = clone(fx, "Remudero/plain");
    const live = join(fx.home, "Remudero/wt-live"), gone = join(fx.home, "Remudero/wt-gone");
    git(repo, "worktree", "add", "--quiet", "-b", "live", live); // healthy and idle: a retirement candidate
    git(repo, "worktree", "add", "--quiet", "-b", "gone", gone);
    rmSync(gone, { recursive: true, force: true }); // its folder is gone; only the stale record remains
    // The main checkout stays active, so its store survives and only prune can remove the stale record.
    utimesSync(join(repo, "README"), NOW - HOUR, NOW - HOUR);
    const admin = join(repo, ".git/worktrees");
    const before = bytes(admin);

    const dry = helper(fx, NOW, false);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /WOULD-RETIRE worktree .*Remudero\/wt-live/);
    assert.deepEqual(bytes(admin), before, "a dry run leaves every worktree administration byte unchanged");
    assert.equal(existsSync(live), true);

    const r = helper(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /RETIRED worktree .*Remudero\/wt-live/);
    assert.equal(existsSync(repo), true, r.stdout);
    assert.match(r.stdout, /HOLD active <24h .*Remudero\/plain/);
    assert.equal(existsSync(join(admin, "gone")), false, "the apply run prunes the stale record");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("an inspection that raises PermissionError holds the path, for every uid", () => {
  const fx = setup({});
  try {
    const top = join(fx.home, "probe"), inner = join(top, "inner");
    mkdirSync(join(inner, "deeper"), { recursive: true });
    // The denial is injected at the os seam, so root and every other uid see the same refusal.
    const probe = `import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("pr", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
top, inner = sys.argv[2], sys.argv[3]
real_lstat, real_scandir = os.lstat, os.scandir
def lstat(path, *a, **k):
    if os.path.basename(str(path)) == ".rmd-janitor-keep" and os.path.dirname(str(path)) == top:
        raise PermissionError(13, "denied", str(path))
    return real_lstat(path, *a, **k)
def scandir(path=".", *a, **k):
    if str(path) == inner:
        raise PermissionError(13, "denied", str(path))
    return real_scandir(path, *a, **k)
out = {}
os.lstat = lstat
out["marker"] = m.keep_here(top)
out["below"] = m.keep_scope(os.path.join(top, "inner", "deeper"))
os.lstat = real_lstat
os.scandir = scandir
out["walk"] = m.keep_scope(top)
os.scandir = real_scandir
out["clean"] = m.keep_scope(os.path.join(inner, "deeper"))
print(json.dumps(out))`;
    const r = spawnSync("python3", ["-I", "-B", "-c", probe, HELPER, top, inner], { encoding: "utf8", env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.marker, /^keep-inspection-unknown \(\.rmd-janitor-keep: PermissionError\)/, "an unreadable marker holds its folder");
    assert.match(out.below, /^keep-inspection-unknown \(\.rmd-janitor-keep: PermissionError\) at .*\/probe$/, "and everything below it");
    assert.match(out.walk, /^keep-inspection-unknown \(PermissionError\) in .*\/probe$/, "a subtree that cannot be listed holds the whole path");
    assert.equal(out.clean, "", "with nothing denied the same folders are not held");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
