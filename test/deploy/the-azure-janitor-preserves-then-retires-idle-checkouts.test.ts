/**
 * Preserve-then-retire on the Azure host (operator 2026-10-23): what the janitor used to KEEP forever
 * as unpublished, dirty, ignored-data or unverified is copied to the preserve root and then retired,
 * under the six-hour idle rule. The REAL deploy/rmd-host-cleanup.sh runs against the host layout
 * rebuilt under a fixture root; every hold case asserts the unit stays AND that nothing was copied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lutimesSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, git, run } from "#test/helpers/host-cleanup-fixture.js";
import { cloneAt, commitFile, phaseFixture, type PhaseFixture } from "#test/helpers/host-cleanup-phases.js";

function units(fx: PhaseFixture): string {
  const dir = join(fx.root, "units");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pass(fx: PhaseFixture, roots: string, extra: Record<string, string> = {}) {
  return run(fx, { ...fx.env, RMD_CLEANUP_PRESERVE_ROOTS: roots, RMD_CLEANUP_DUMP_ROOTS: "", ...extra });
}

function copiesOf(fx: PhaseFixture, repo: string): string[] {
  if (!existsSync(fx.preserved)) return [];
  const stem = repo.replace(/^\//, "").replace(/\//g, "__") + "@";
  return readdirSync(fx.preserved).filter(n => n.startsWith(stem)).map(n => join(fx.preserved, n));
}

function work(repo: string) {
  commitFile(repo, "feature.txt", "unpublished work\n", "unpublished commit");
  writeFileSync(join(repo, "README"), "edited, not committed\n");
  writeFileSync(join(repo, ".gitignore"), "*.out\nnode_modules/\n");
  writeFileSync(join(repo, "notes.md"), "untracked notes\n");
  writeFileSync(join(repo, "result.out"), "ignored output\n");
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "regenerable\n");
}

test("an idle unpublished clone is preserved, then retired, and its copy restores the commits, edits and untracked files", () => {
  const fx = phaseFixture();
  const unit = cloneAt(fx, join(units(fx), "creditq-x6LSzP"));
  work(unit);
  age(unit, 13);

  const r = pass(fx, units(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`REMOVE ${unit}: preserved then retired`));
  assert.equal(existsSync(unit), false, r.stdout);
  const [copy] = copiesOf(fx, unit);
  assert.ok(copy, `a stamped copy exists under ${fx.preserved}:\n${r.stdout}`);
  for (const f of ["unpublished.bundle", "uncommitted.patch", "untracked.tar.gz", "refs.txt", "MANIFEST.txt"]) {
    assert.equal(existsSync(join(copy, f)), true, `${f} in ${copy}`);
  }
  assert.match(readFileSync(join(copy, "MANIFEST.txt"), "utf8"), /commits not on a published remote: 1\n/);

  // restore: a fresh clone of the published origin gets back every piece of the retired work
  const restore = join(fx.root, "restore");
  git(fx.root, "clone", "--quiet", fx.origin, restore);
  git(restore, "fetch", "--quiet", join(copy, "unpublished.bundle"), "HEAD:restored");
  assert.equal(git(restore, "rev-list", "--count", "origin/main..restored").trim(), "1", "the bundle holds only the unpublished commit");
  git(restore, "checkout", "--quiet", "restored");
  assert.equal(readFileSync(join(restore, "feature.txt"), "utf8"), "unpublished work\n");
  git(restore, "apply", "--binary", join(copy, "uncommitted.patch"));
  assert.equal(readFileSync(join(restore, "README"), "utf8"), "edited, not committed\n");
  execFileSync("tar", ["-xzf", join(copy, "untracked.tar.gz")], { cwd: restore });
  assert.equal(readFileSync(join(restore, "notes.md"), "utf8"), "untracked notes\n");
  assert.equal(readFileSync(join(restore, "result.out"), "utf8"), "ignored output\n");
  assert.equal(existsSync(join(restore, "node_modules")), false, "regenerable dependencies are not preserved");
  assert.match(r.stdout, new RegExp(`reclaim-total preserve-retire ${units(fx)}: reclaimed`));
});

test("an idle linked worktree whose repository lives outside the unit is preserved and unregistered through Git", () => {
  const fx = phaseFixture();
  const lender = cloneAt(fx, join(fx.root, "lender"));
  const wt = join(units(fx), "wt-13324");
  git(lender, "worktree", "add", "--quiet", "-b", "wt-branch", wt, "main");
  commitFile(wt, "fix.txt", "fix\n", "unpublished fix");
  age(wt, 13);

  const r = pass(fx, units(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(wt), false, r.stdout);
  assert.equal(copiesOf(fx, wt).length, 1, r.stdout);
  assert.doesNotMatch(git(lender, "worktree", "list"), /wt-13324/, "the lender no longer registers the retired worktree");
  assert.equal(existsSync(lender), true, "the lender outside the unit stays");
});

test("a live dir written within six hours, a checkout held open and one named on a command line are kept", async () => {
  const fx = phaseFixture();
  const root = units(fx);
  const live = cloneAt(fx, join(root, "operator-stuck-pr-private"));
  const open = cloneAt(fx, join(root, "open-one"));
  const named = cloneAt(fx, join(root, "named-one"));
  for (const u of [live, open, named]) { work(u); age(u, 13); }
  writeFileSync(join(live, "fresh.txt"), "written now\n");
  age(join(live, "fresh.txt"), 2);
  writeFileSync(fx.lsofList, `${open}/notes.md\n`);
  // a live process whose command line names the checkout (an argument, never an open file)
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", named], { stdio: "ignore" });
  try {
    await new Promise(res => setTimeout(res, 200));
    const r = pass(fx, root);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`KEEP ${live}: written within 360 min`));
    assert.match(r.stdout, new RegExp(`KEEP ${open}: held open by a process`));
    assert.match(r.stdout, new RegExp(`KEEP ${named}: held open by a process`));
    for (const u of [live, open, named]) {
      assert.equal(existsSync(u), true, `${u}\n${r.stdout}`);
      assert.equal(copiesOf(fx, u).length, 0, `nothing is copied for a kept unit: ${u}`);
    }
  } finally {
    holder.kill();
  }
});

test("a locked worktree, unreadable history, a foreign owner and an oversized untracked file are held for a person", () => {
  const fx = phaseFixture();
  const root = units(fx);
  const lender = cloneAt(fx, join(fx.root, "lender"));
  const locked = join(root, "locked-wt");
  git(lender, "worktree", "add", "--quiet", "-b", "locked", locked, "main");
  git(lender, "worktree", "lock", locked);
  const orphan = join(root, "orphan-wt");
  git(lender, "worktree", "add", "--quiet", "-b", "orphan", orphan, "main");
  rmSync(join(lender, ".git", "worktrees", "orphan-wt"), { recursive: true, force: true });
  const big = cloneAt(fx, join(root, "big-untracked"));
  writeFileSync(join(big, "dump.bin"), Buffer.alloc(2 * 1024 * 1024, 1));
  const host = cloneAt(fx, join(root, "hosts-outside"));
  git(host, "worktree", "add", "--quiet", "-b", "elsewhere", join(fx.root, "elsewhere-wt"), "main");
  for (const u of [locked, orphan, big, host]) age(u, 13);

  const r = pass(fx, root, { RMD_CLEANUP_MAX_UNTRACKED_MB: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${locked}: preserve-then-retire hold: Git worktree is locked`));
  assert.match(r.stdout, new RegExp(`KEEP ${orphan}: preserve-then-retire hold: history-unrecoverable`));
  assert.match(r.stdout, new RegExp(`KEEP ${big}: preserve-then-retire hold: untracked-file-over-1MB \\(dump.bin\\)`));
  assert.match(r.stdout, new RegExp(`KEEP ${host}: preserve-then-retire hold: hosts linked worktree .*elsewhere-wt outside the unit`));
  for (const u of [locked, orphan, big, host]) {
    assert.equal(existsSync(u), true, `${u}\n${r.stdout}`);
    assert.equal(copiesOf(fx, u).length, 0, `a held unit leaves no copy: ${u}\n${r.stdout}`);
  }

  // a pass deciding as another identity holds every unit as foreign-owned
  const mine = cloneAt(fx, join(root, "mine"));
  work(mine);
  age(mine, 13);
  const foreign = pass(fx, root, { RMD_CLEANUP_UID: "4242" });
  assert.match(foreign.stdout, new RegExp(`KEEP ${mine}: preserve-then-retire hold: foreign owner \\(uid \\d+, pass uid 4242\\)`));
  assert.equal(existsSync(mine), true, foreign.stdout);
});

test("a folder of units kept only because one child is live has each idle child preserved and retired", () => {
  const fx = phaseFixture();
  const namespace = join(units(fx), "rmd-qa-namespace.ulkfFP");
  const idleA = cloneAt(fx, join(namespace, "operator", "wt-c5"));
  const idleB = cloneAt(fx, join(namespace, "issue-repairs-oct6", "spin-repro"));
  const liveChild = cloneAt(fx, join(namespace, "issue-repairs-oct6", "core-isolated-restore-1023-v1"));
  const loose = join(namespace, "issue-repairs-oct6", "repro.bundle");
  for (const u of [idleA, idleB, liveChild]) work(u);
  writeFileSync(loose, "bundle bytes\n");
  age(namespace, 13);
  writeFileSync(join(liveChild, "today.txt"), "live\n");
  age(join(liveChild, "today.txt"), 1);

  const r = pass(fx, units(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${namespace}: folder of units kept \\(written within 360 min\\); each child judged on its own`));
  assert.equal(existsSync(idleA), false, r.stdout);
  assert.equal(existsSync(idleB), false, r.stdout);
  assert.equal(existsSync(liveChild), true, "the live child stays");
  assert.equal(existsSync(namespace), true, "the parent stays while a child is live");
  assert.equal(copiesOf(fx, idleA).length + copiesOf(fx, idleB).length, 2, r.stdout);
  assert.equal(copiesOf(fx, liveChild).length, 0);
  assert.equal(existsSync(loose), true, "a live folder's loose bundle stays with it");
});

test("an instance folder holding a protected checkout is held whole, and the preserve root is never swept", () => {
  const fx = phaseFixture();
  const instance = join(fx.disk, "rmd", "rmd-state2");
  const checkout = cloneAt(fx, join(instance, "remudero"));
  const workerTree = cloneAt(fx, join(instance, "worker-homes", "w1", "repo"));
  work(workerTree);
  age(instance, 13);
  const copy = join(fx.preserved, "mnt__scratch__old@20261020T000000Z");
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "unpublished.bundle"), "bundle\n");
  age(fx.preserved, 13);

  // the user pass: the instance is held whole
  const r = pass(fx, fx.disk);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${instance}: preserve-then-retire hold: holds protected checkout ${checkout}`));
  assert.equal(existsSync(workerTree), true, r.stdout);

  // the hourly root pass sweeps the scratch disk's units, but never the preserve root's copies
  const root = run(fx, { ...fx.env, RMD_CLEANUP_UID: "0", RMD_CLEANUP_ONLY_TMP: "1", RMD_CLEANUP_SCRATCH_ROOTS: fx.disk, RMD_CLEANUP_SCRATCH_PARENTS: "" });
  assert.equal(root.status, 0, root.stderr + root.stdout);
  assert.match(root.stdout, new RegExp(`KEEP ${fx.preserved}: holds the janitor's preserve root`));
  assert.equal(existsSync(join(copy, "unpublished.bundle")), true, root.stdout);
});

test("a unit that becomes active between its copy and its removal is kept, with its copy", () => {
  const fx = phaseFixture();
  const unit = cloneAt(fx, join(units(fx), "late-writer"));
  work(unit);
  age(unit, 13);
  // lsof sees nothing on the pass's first snapshot and the unit open on every later one
  const count = join(fx.root, "lsof.count");
  const lsof = join(fx.root, "bin", "lsof-late");
  writeFileSync(lsof, `#!/usr/bin/env bash\nn=$(cat '${count}' 2>/dev/null || echo 0); echo $((n + 1)) > '${count}'\n[ "$n" -ge 1 ] && printf 'p1\\nn%s\\n' '${unit}/notes.md'\nexit 0\n`);
  chmodSync(lsof, 0o755);

  const r = pass(fx, units(fx), { RMD_CLEANUP_LSOF: lsof });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${unit}: preserve-then-retire hold: changed or active before retire`));
  assert.equal(existsSync(unit), true, r.stdout);
  assert.equal(copiesOf(fx, unit).length, 1, "the copy made before the recheck stays");
});

test("a preserved manifest never carries a remote's credentials", () => {
  const fx = phaseFixture();
  const unit = cloneAt(fx, join(units(fx), "token-remote"));
  work(unit);
  git(unit, "remote", "add", "mirror", "https://x-access-token:ghs_SECRET123@github.com/craigoley/remudero.git");
  age(unit, 13);

  const r = pass(fx, units(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [copy] = copiesOf(fx, unit);
  assert.ok(copy, r.stdout);
  const manifest = readFileSync(join(copy, "MANIFEST.txt"), "utf8");
  assert.match(manifest, /mirror https:\/\/github\.com\/craigoley\/remudero\.git/);
  assert.doesNotMatch(manifest + r.stdout, /ghs_SECRET123/);
});

test("retiring a worktree whose node_modules links to a live tree removes only the link, and a node_modules lender stays while a borrower does", () => {
  const fx = phaseFixture();
  const root = units(fx);
  // a live operator checkout with a real install, and worktrees of it under a scratch namespace
  const owner = cloneAt(fx, join(fx.root, "rmd-op"));
  const ownerDep = join(owner, "node_modules", "dep", "index.js");
  mkdirSync(join(ownerDep, ".."), { recursive: true });
  writeFileSync(ownerDep, "live install\n");
  const add = (name: string) => {
    const wt = join(root, name);
    git(owner, "worktree", "add", "--quiet", "-b", name, wt, "main");
    commitFile(wt, `${name}.txt`, "unpublished\n", `work in ${name}`);
    return wt;
  };
  const toLive = add("wt-c5");
  symlinkSync(join(owner, "node_modules"), join(toLive, "node_modules"));
  const lender = add("wt-batch1017-repro");
  mkdirSync(join(lender, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(lender, "node_modules", "pkg", "index.js"), "lent install\n");
  const borrower = add("wt-live");
  symlinkSync(join(lender, "node_modules"), join(borrower, "node_modules"));
  age(root, 13);
  age(owner, 13);
  // age() follows a link to its target; the links themselves are aged as on the host
  const old = new Date(Date.now() - 13 * 3600_000);
  for (const link of [join(toLive, "node_modules"), join(borrower, "node_modules")]) lutimesSync(link, old, old);
  writeFileSync(join(borrower, "today.txt"), "live\n");
  age(join(borrower, "today.txt"), 1);

  const first = pass(fx, root);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(existsSync(toLive), false, first.stdout);
  assert.equal(readFileSync(ownerDep, "utf8"), "live install\n", "the live tree behind the link is untouched");
  assert.doesNotMatch(git(owner, "worktree", "list"), /wt-c5/, "the owner's Git no longer registers the retired worktree");
  const [copy] = copiesOf(fx, toLive);
  const tarball = join(copy, "untracked.tar.gz");
  assert.ok(copy && (!existsSync(tarball) || !/node_modules/.test(execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }))),
    "the copy never holds node_modules, link or not");
  assert.match(first.stdout, new RegExp(`KEEP ${lender}: preserve-then-retire hold: lends files to symlinks ${borrower}/node_modules`));
  assert.equal(readFileSync(join(lender, "node_modules", "pkg", "index.js"), "utf8"), "lent install\n");
  assert.equal(existsSync(borrower), true);

  // once the borrower is idle too, it is retired first and the lender follows in the same pass
  age(borrower, 13);
  const second = pass(fx, root);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.equal(existsSync(borrower), false, second.stdout);
  assert.equal(existsSync(lender), false, `the lender goes once its last borrower is retired:\n${second.stdout}`);
  assert.equal(readFileSync(ownerDep, "utf8"), "live install\n");
});

test("a folder the pass is refused makes only what contains it unknown; every other checkout is still preserved and retired", () => {
  const fx = phaseFixture();
  const root = units(fx);
  const elsewhere = cloneAt(fx, join(root, "c2-operator-478.6DYT6I"));
  const namespace = join(root, "flow-followups.ISOfnj");
  const refused = cloneAt(fx, join(namespace, "foreign-hold"));
  const sibling = cloneAt(fx, join(namespace, "followup-1"));
  for (const u of [elsewhere, refused, sibling]) work(u);
  age(root, 13);
  // a find that is refused the one folder (a root- or foreign-owned directory on the host): it
  // prints the folder, hides what is inside it and exits 1 with find's own message, for every uid
  const deniedFind = join(fx.root, "bin", "find-refused");
  writeFileSync(deniedFind, [
    "#!/usr/bin/env bash",
    'args=(); for a; do if [ "$a" = -cmin ]; then args+=(-mmin); else args+=("$a"); fi; done',
    `deny='${refused}'`,
    'case "$deny/" in "${1%/}"/*) ;; *) exec find "${args[@]}" ;; esac',
    'find "${args[@]}" | awk -v d="$deny" \'index($0, d "/") != 1\'',
    "echo \"find: '$deny': Permission denied\" >&2",
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });

  const r = pass(fx, root, { RMD_CLEANUP_FIND: deniedFind });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /alternates scan failed \(unknown\)/);
  assert.match(r.stdout, new RegExp(`REMOVE ${elsewhere}: preserved then retired`), "a checkout outside the refused folder is judged normally");
  assert.match(r.stdout, new RegExp(`KEEP ${namespace}: folder of units kept \\(unreadable path inside \\(${refused}\\)\\)`));
  assert.equal(existsSync(sibling), false, `the refused folder's sibling is judged on its own:\n${r.stdout}`);
  assert.equal(existsSync(refused), true, "what the pass could not read stays");
  assert.equal(copiesOf(fx, refused).length, 0);
});

test("a keep marker past its keep-until date lapses, a future one holds, and one with no date holds and is listed once", () => {
  const fx = phaseFixture();
  const root = units(fx);
  const lapsed = cloneAt(fx, join(root, "lapsed"));
  const lapsedJson = cloneAt(fx, join(root, "lapsed-json"));
  const future = cloneAt(fx, join(root, "future"));
  const undated = cloneAt(fx, join(root, "rmd-qa-namespace.ulkfFP"));
  for (const u of [lapsed, lapsedJson, future, undated]) work(u);
  writeFileSync(join(lapsed, ".rmd-scratch-keep"), "keep-until: 2026-01-01\nrecovery snapshot\n");
  writeFileSync(join(lapsedJson, ".rmd-scratch-keep"), '{"until": "2026-01-02", "reason": "receipts"}\n');
  writeFileSync(join(future, ".rmd-scratch-keep"), "keep-until: 2999-01-01\n");
  writeFileSync(join(undated, ".rmd-scratch-keep"), "operator artifact namespace: protected snapshot\n");
  age(root, 13);

  const r = pass(fx, root, { RMD_CLEANUP_DUMP_ROOTS: root });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const u of [lapsed, lapsedJson]) {
    assert.match(r.stdout, new RegExp(`KEEP-EXPIRED ${u}/.rmd-scratch-keep: keep-until 2026-01-0[12] has passed`));
    assert.equal(existsSync(u), false, `a lapsed marker no longer holds ${u}:\n${r.stdout}`);
  }
  assert.match(r.stdout, new RegExp(`KEEP ${future}: preserve-then-retire hold: scratch keep marker`));
  assert.equal(existsSync(future), true);
  assert.equal(existsSync(undated), true);
  const listed = r.stdout.split("\n").filter(l => l.startsWith(`MARKER ${undated}/.rmd-scratch-keep: honoured with no machine-readable expiry, `));
  assert.equal(listed.length, 1, `an undated marker is listed once a pass:\n${r.stdout}`);
});
