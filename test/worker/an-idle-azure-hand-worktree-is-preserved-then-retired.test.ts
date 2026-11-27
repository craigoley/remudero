/**
 * W1-T14400: on the Azure host a linked hand worktree held for unsaved work (uncommitted changes or unpublished
 * commits) used to be kept on every pass. Idle past the held-worktree window, it is preserved in the preserve-retire
 * format (patch, unpublished bundle, untracked tarball, MANIFEST), each read back, then removed with git worktree
 * remove; its branch stays. Driven as the real deploy/rmd-host-cleanup.sh against fixture roots only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { age, fixture, git, repos, run, type Fixture } from "#test/helpers/host-cleanup-fixture.js";

const DAY_HOURS = 24;
const handOnly = (root: string, extra: Record<string, string> = {}) => ({
  RMD_CLEANUP_WORKTREE_ROOTS: root, RMD_CLEANUP_LIVE_CHECKOUTS: "", RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: "",
  RMD_CLEANUP_TMP_ROOTS: "", ...extra,
});

function copies(fx: Fixture, wt: string, root = join(fx.root, "preserved")): string[] {
  if (!existsSync(root)) return [];
  const stem = wt.replace(/^\//, "").replace(/\//g, "__") + "@";
  return readdirSync(root).filter(n => n.startsWith(stem)).map(n => join(root, n));
}

/** A linked worktree with an unpublished commit, an uncommitted edit and an untracked note. */
function heldHandTree(fx: Fixture, name: string) {
  const { main, addWorktree } = repos(fx);
  const branch = `hand/${name}`;
  const wt = addWorktree(name, branch);
  writeFileSync(join(wt, "feature.txt"), "unpublished work\n");
  git(wt, "add", "feature.txt");
  git(wt, "commit", "--quiet", "-m", "unpublished commit");
  writeFileSync(join(wt, "README"), "edited, not committed\n");
  writeFileSync(join(wt, "notes.md"), "untracked notes\n");
  mkdirSync(join(wt, "test", "ci", "coverage"), { recursive: true });
  writeFileSync(join(wt, "test", "ci", "coverage", "new-test.ts"), "export {};\n");
  mkdirSync(join(wt, "src", "dist"), { recursive: true });
  writeFileSync(join(wt, "src", "dist", "new-source.ts"), "export {};\n");
  mkdirSync(join(wt, "vendor", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(wt, "vendor", "node_modules", "pkg", "generated.js"), "nested cache\n");
  mkdirSync(join(wt, "build", "dist"), { recursive: true });
  writeFileSync(join(wt, "build", "dist", "chunk.js"), "build output\n");
  mkdirSync(join(wt, ".next", "cache"), { recursive: true });
  writeFileSync(join(wt, ".next", "cache", "render"), "framework cache\n");
  mkdirSync(join(wt, ".turbo", "cache"), { recursive: true });
  writeFileSync(join(wt, ".turbo", "cache", "task"), "task cache\n");
  mkdirSync(join(wt, "node_modules"), { recursive: true });
  writeFileSync(join(wt, "node_modules", "generated.js"), "generated cache\n");
  mkdirSync(join(wt, "coverage"), { recursive: true });
  writeFileSync(join(wt, "coverage", "report.json"), "generated report\n");
  return { main, wt, branch, root: join(wt, "..") };
}

test("W1-T14400 criterion 1: an idle hand worktree with uncommitted and unpushed work is saved and then removed, and git worktree add plus the patch restores it", () => {
  const fx = fixture();
  const { main, wt, branch, root } = heldHandTree(fx, "wt-T9001");
  writeFileSync(join(main, ".git", "info", "exclude"), "node_modules/\ndist/\n.next/\n.turbo/\n", { flag: "a" });
  age(wt, 10 * DAY_HOURS);

  const r = run(fx, handOnly(root));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`REMOVE ${wt}: .*idle 7 days, preserved then retired`));
  assert.equal(existsSync(wt), false, r.stdout);
  const [copy] = copies(fx, wt);
  assert.ok(copy, `a preserved copy exists:\n${r.stdout}`);
  for (const f of ["unpublished.bundle", "uncommitted.patch", "untracked.tar.gz", "refs.txt", "MANIFEST.txt"]) {
    assert.equal(existsSync(join(copy, f)), true, `${f} in ${copy}`);
  }
  assert.match(git(main, "branch", "--list", branch), new RegExp(branch.replace("/", "\\/")), "the branch stays in the clone");

  const restore = join(fx.root, "restore");
  git(main, "worktree", "add", "--quiet", restore, branch);
  assert.equal(readFileSync(join(restore, "feature.txt"), "utf8"), "unpublished work\n", "the commit is on the kept branch");
  git(restore, "apply", "--binary", join(copy, "uncommitted.patch"));
  assert.equal(readFileSync(join(restore, "README"), "utf8"), "edited, not committed\n", "the patch restores the edit");
  const extracted = join(fx.root, "untracked-restore");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", join(copy, "untracked.tar.gz"), "-C", extracted]);
  for (const path of ["test/ci/coverage/new-test.ts"]) {
    assert.equal(readFileSync(join(extracted, path), "utf8"), "export {};\n", `${path} survives the skipped-name class`);
  }
  assert.equal(readFileSync(join(extracted, "coverage", "report.json"), "utf8"), "generated report\n", "unignored root coverage is preserved");
  assert.equal(existsSync(join(extracted, "node_modules", "generated.js")), false, "Git-ignored root node_modules stays excluded");
  const archivedPaths = execFileSync("tar", ["-tzf", join(copy, "untracked.tar.gz")], { encoding: "utf8" });
  assert.doesNotMatch(archivedPaths, /(^|\/)node_modules\//, "ignored nested node_modules stays excluded");
  assert.doesNotMatch(archivedPaths, /(^|\/)dist\//, "ignored dist output stays excluded");
  assert.doesNotMatch(archivedPaths, /(^|\/)\.next\//, "ignored framework cache stays excluded");
  assert.doesNotMatch(archivedPaths, /(^|\/)\.turbo\//, "ignored task cache stays excluded");
});

test("W1-T14400 criterion 1: pruning an ignored cache does not restart an idle hand worktree's retirement clock", () => {
  const fx = fixture();
  const { main, wt, root } = heldHandTree(fx, "wt-pruned-cache");
  writeFileSync(join(main, ".git", "info", "exclude"), "/node_modules/\n", { flag: "a" });
  git(main, "worktree", "lock", wt);
  age(wt, 10 * DAY_HOURS);

  const prune = run(fx, handOnly(root));
  assert.equal(prune.status, 0, prune.stderr + prune.stdout);
  assert.match(prune.stdout, new RegExp(`PRUNE ${wt}/node_modules:`));
  assert.equal(existsSync(wt), true, "a locked worktree stays while its ignored cache is pruned");
  assert.equal(existsSync(join(wt, "node_modules")), false, "the ignored cache was removed");

  git(main, "worktree", "unlock", wt);
  const retire = run(fx, handOnly(root));
  assert.equal(retire.status, 0, retire.stderr + retire.stdout);
  assert.match(retire.stdout, new RegExp(`REMOVE ${wt}: .*idle 7 days, preserved then retired`));
  assert.equal(existsSync(wt), false, "the prior idle timestamp survives pruning");
  assert.ok(copies(fx, wt)[0], "the unsaved work is preserved before retirement");
});

test("W1-T14400 criterion 2: invariant:nothing-unsaved-is-removed — a failed save, a held worktree or a recent one is kept", () => {
  const fx = fixture();
  const { main, wt, root } = heldHandTree(fx, "wt-recent");
  age(wt, 13);
  writeFileSync(join(wt, "README"), "recent edit\n");
  const recentRun = run(fx, handOnly(root));
  assert.equal(recentRun.status, 0, recentRun.stderr + recentRun.stdout);
  assert.equal(existsSync(wt), true, "a recent worktree stays when the preserve root is writable");
  assert.match(recentRun.stdout, new RegExp(`KEEP ${wt}: written within 360 min`));

  const locked = join(root, "wt-locked");
  git(main, "worktree", "add", "--quiet", "-b", "hand/locked", locked, "main");
  writeFileSync(join(locked, "README"), "locked edit\n");
  git(main, "worktree", "lock", locked);
  const unsavable = join(root, "wt-unsavable");
  git(main, "worktree", "add", "--quiet", "-b", "hand/unsavable", unsavable, "main");
  writeFileSync(join(unsavable, "README"), "dirty\n");
  age(locked, 10 * DAY_HOURS);
  age(unsavable, 10 * DAY_HOURS);

  // The preserve root cannot be created, so the third worktree's save fails.
  const blocked = join(fx.root, "not-a-dir");
  writeFileSync(blocked, "a file, not a folder\n");
  const r = run(fx, handOnly(root, { RMD_CLEANUP_PRESERVE_ROOT: join(blocked, "preserved") }));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const kept of [locked, unsavable]) {
    assert.equal(existsSync(kept), true, `${kept} stays:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, new RegExp(`REMOVE ${kept}[: ]`));
  }
  assert.match(r.stdout, new RegExp(`KEEP ${unsavable}: uncommitted changes; cannot create`));
  assert.match(r.stdout, new RegExp(`KEEP ${locked}: Git worktree is locked`));
});

test("W1-T14400 criterion 2: invariant:nothing-unsaved-is-removed — a watched preserve-disk mark holds retirement", () => {
  const fx = fixture();
  const { wt, root } = heldHandTree(fx, "wt-disk-mark");
  age(wt, 10 * DAY_HOURS);
  const r = run(fx, handOnly(root, {
    RMD_CLEANUP_WATCH_FS: `${fx.rootfs}:40`,
    FAKE_DF_PCT: "95",
  }));
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(existsSync(wt), true, "the worktree stays when the preserve disk is beyond its watched mark");
  assert.match(r.stdout, new RegExp(`KEEP ${wt}: uncommitted changes; preserve root .* past its watched mark`));
  assert.deepEqual(copies(fx, wt), [], "no copy is started when the watched mark already fails");
});

/** A dirty linked worktree at `<handRoot>/<name>`, not yet aged. */
function dirtyTreeUnder(fx: Fixture, main: string, handRoot: string, name: string): string {
  mkdirSync(handRoot, { recursive: true });
  const wt = join(handRoot, name);
  git(main, "worktree", "add", "--quiet", "-b", `hand/${name}`, wt, "main");
  writeFileSync(join(wt, "README"), `${name} dirty\n`);
  return wt;
}

test("W1-T14400 criterion 2: a keep marker on, above or inside an idle hand worktree holds it, and a lapsed one does not", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const held = (name: string, markerAt: (wt: string, handRoot: string) => string, text: string) => {
    const handRoot = join(fx.root, `above-${name}`, "hand");
    const wt = dirtyTreeUnder(fx, main, handRoot, name);
    const marker = markerAt(wt, handRoot);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, text);
    age(wt, 10 * DAY_HOURS);
    return { handRoot, wt, marker };
  };
  const until = "keep-until: 2099-01-01\n";
  const kept = [
    held("scratch-on-tree", wt => join(wt, ".rmd-scratch-keep"), until),
    held("scratch-undated", wt => join(wt, ".rmd-scratch-keep"), "operator hold\n"),
    held("janitor-on-tree", wt => join(wt, ".rmd-janitor-keep"), ""),
    held("scratch-on-root", (_wt, handRoot) => join(handRoot, ".rmd-scratch-keep"), until),
    held("janitor-on-root", (_wt, handRoot) => join(handRoot, ".rmd-janitor-keep"), ""),
    held("scratch-above-root", (_wt, handRoot) => join(handRoot, "..", ".rmd-scratch-keep"), until),
    held("scratch-inside", wt => join(wt, "deep", "er", ".rmd-scratch-keep"), until),
    held("janitor-inside", wt => join(wt, "deep", "er", ".rmd-janitor-keep"), ""),
  ];
  const lapsed = held("scratch-lapsed", wt => join(wt, ".rmd-scratch-keep"), "keep-until: 2000-01-01\n");

  const r = run(fx, handOnly([...kept, lapsed].map(t => t.handRoot).join(":")));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const { wt, marker } of kept) {
    assert.equal(existsSync(wt), true, `${wt} stays for ${marker}:\n${r.stdout}`);
    assert.ok(r.stdout.includes(`KEEP ${wt}: uncommitted changes; keep marker `), `${wt} names its hold:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, new RegExp(`REMOVE ${wt}[: ]`));
    assert.deepEqual(copies(fx, wt), [], `no copy is started for held ${wt}`);
  }
  assert.equal(existsSync(lapsed.wt), false, `a lapsed marker holds nothing:\n${r.stdout}`);
  assert.ok(copies(fx, lapsed.wt)[0], "the lapsed-marker worktree is saved first");
});

test("W1-T14400 criterion 2: a keep marker placed on the hand root during the save holds the worktree before removal", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const handRoot = join(fx.root, "hand-late");
  const wt = dirtyTreeUnder(fx, main, handRoot, "late-marker");
  age(wt, 10 * DAY_HOURS);
  // The first open-file probe taken after a finished copy exists writes the marker, then answers as before.
  const marker = join(handRoot, ".rmd-janitor-keep");
  const lsof = join(fx.root, "bin", "lsof-late-marker");
  writeFileSync(lsof, `#!/usr/bin/env bash\nfor m in "${join(fx.root, "preserved")}"/*/MANIFEST.txt; do [ -e "$m" ] && : > "${marker}"; done\nexec "${fx.env.RMD_CLEANUP_LSOF}" "$@"\n`);
  chmodSync(lsof, 0o755);

  const r = run(fx, handOnly(handRoot, { RMD_CLEANUP_LSOF: lsof }));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(wt), true, r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${wt}: keep marker ${marker} before retire (copy kept: `), r.stdout);
  assert.ok(copies(fx, wt)[0], "the copy was written before the marker appeared");
});

test("W1-T14400 criterion 2: with no preserve root set the copy lands on the state disk, and expires there", () => {
  const fx = fixture();
  const { wt, root } = heldHandTree(fx, "wt-state-disk");
  age(wt, 10 * DAY_HOURS);
  const state = join(fx.root, "state-disk");
  const disk = join(fx.root, "scratch-disk");
  for (const d of [state, disk]) mkdirSync(d);
  const env = handOnly(root, { RMD_CLEANUP_PRESERVE_ROOT: "", RMD_CLEANUP_STATE_DISK: state, RMD_SCRATCH_ROOT: disk });

  const r = run(fx, env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(wt), false, r.stdout);
  const [copy] = copies(fx, wt, join(state, "host", "preserved-worktrees"));
  assert.ok(copy, `the copy is on the state disk:\n${r.stdout}`);
  assert.equal(existsSync(join(copy, "uncommitted.patch")), true);
  assert.equal(existsSync(join(copy, "unpublished.bundle")), true);
  assert.deepEqual(copies(fx, wt, join(disk, "host-cleanup-preserved")), [], "nothing is saved to the scratch disk");

  age(copy, 10 * DAY_HOURS);
  const later = run(fx, env);
  assert.equal(later.status, 0, later.stderr + later.stdout);
  assert.equal(existsSync(copy), false, `the state-disk copy follows the retention:\n${later.stdout}`);
});

test("W1-T14400 criterion 2: a state disk past its watched mark holds retirement, whatever the scratch disk has free", () => {
  const fx = fixture();
  const { wt, root } = heldHandTree(fx, "wt-state-full");
  age(wt, 10 * DAY_HOURS);
  const state = join(fx.root, "state-disk");
  const disk = join(fx.root, "scratch-disk");
  for (const d of [state, disk]) mkdirSync(d);
  const df = join(fx.root, "bin", "df-by-disk");
  writeFileSync(df, `#!/usr/bin/env bash\ncase "$1" in "${state}"*) dev=/dev/state pct=95 ;; *) dev=/dev/other pct=50 ;; esac\necho 'Filesystem 1024-blocks Used Available Capacity Mounted on'\necho "$dev 1000000 500000 500000 $pct% /"\n`);
  chmodSync(df, 0o755);

  const r = run(fx, handOnly(root, {
    RMD_CLEANUP_PRESERVE_ROOT: "", RMD_CLEANUP_STATE_DISK: state, RMD_SCRATCH_ROOT: disk,
    RMD_CLEANUP_DF: df, RMD_CLEANUP_WATCH_FS: `${state}:85 ${disk}:90`,
  }));
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(existsSync(wt), true, r.stdout);
  const held = join(state, "host", "preserved-worktrees");
  assert.ok(r.stdout.includes(`KEEP ${wt}: uncommitted changes; preserve root ${held} is past its watched mark`), r.stdout);
  assert.deepEqual(copies(fx, wt, held), []);
});

test("W1-T14400 criterion 2: preserve-retire keeps nested repositories, bundles and implicit agent worktrees", () => {
  const fx = fixture();
  const { main, addWorktree } = repos(fx);
  const handRoot = join(fx.root, "hand-roots");
  mkdirSync(handRoot);
  const addHand = (name: string, branch: string) => {
    const wt = join(handRoot, name);
    git(main, "worktree", "add", "--quiet", "-b", branch, wt, "main");
    writeFileSync(join(wt, "README"), `${name} dirty\n`);
    age(wt, 10 * DAY_HOURS);
    return wt;
  };
  const nested = addHand("nested", "hand/nested");
  const nestedRepo = join(nested, "vendor", "clone");
  mkdirSync(join(nested, "vendor"), { recursive: true });
  git(fx.root, "clone", "--quiet", join(fx.root, "origin.git"), nestedRepo);
  age(nested, 10 * DAY_HOURS);
  const bare = addHand("bare", "hand/bare");
  const bareRepo = join(bare, "vendor", "bare.git");
  git(fx.root, "init", "--quiet", "--bare", bareRepo);
  age(bare, 10 * DAY_HOURS);
  const cachedBundle = addHand("bundle", "hand/bundle");
  mkdirSync(join(cachedBundle, "node_modules"), { recursive: true });
  writeFileSync(join(cachedBundle, "node_modules", "only-copy.bundle"), "bundle data\n");
  age(cachedBundle, 10 * DAY_HOURS);

  const agent = addWorktree("implicit-agent", "agent/implicit-agent");
  writeFileSync(join(agent, "README"), "agent dirty\n");
  age(agent, 10 * DAY_HOURS);

  const r = run(fx, handOnly(handRoot));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const kept of [nested, bare, cachedBundle, agent]) {
    assert.equal(existsSync(kept), true, `${kept} remains:
${r.stdout}`);
    assert.doesNotMatch(r.stdout, new RegExp(`REMOVE ${kept}[: ]`));
  }
  assert.match(r.stdout, new RegExp(`KEEP ${nested}: .*nested repository or bundle found`));
  assert.match(r.stdout, new RegExp(`KEEP ${bare}: .*nested repository or bundle found`));
  assert.match(r.stdout, new RegExp(`KEEP ${cachedBundle}: .*nested repository or bundle found`));
  assert.match(r.stdout, new RegExp(`KEEP ${agent}: .*outside configured hand worktree roots`));
});
