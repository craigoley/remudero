/**
 * W1-T14971: a scratch hold that protects history (a bare repository, a clone borrowing missing objects, a
 * folder holding a dependency seed store) used to be kept on every pass. Once the folder is idle past the
 * hold window it is preserved (verified bundle or listed tarball, plus a MANIFEST), then retired. Driven as
 * the real deploy/rmd-host-cleanup.sh against fixture roots only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, fixture, git, repos, run, type Fixture } from "#test/helpers/host-cleanup-fixture.js";

const DAY_HOURS = 24;
const scratchOnly = (fx: Fixture, extra: Record<string, string> = {}) => ({
  RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_SCRATCH_PARENTS: "", RMD_CLEANUP_TMP_ROOTS: "", ...extra,
});

function preserved(fx: Fixture, unit: string): string[] {
  const root = join(fx.root, "preserved");
  if (!existsSync(root)) return [];
  const stem = unit.replace(/^\//, "").replace(/\//g, "__") + "@";
  return readdirSync(root).filter(n => n.startsWith(stem) && n.endsWith(".held")).map(n => join(root, n));
}

/** A bare repository at <scratch>/<name> holding the fixture's published main. */
function bareUnit(fx: Fixture, main: string, name: string): string {
  const p = join(fx.scratch, name);
  git(fx.root, "clone", "--quiet", "--no-local", "--bare", main, p); // no hardlinks: each unit ages on its own
  return p;
}

/** <scratch>/<name>/repo borrows objects from a store that no longer exists. */
function brokenUnit(fx: Fixture, main: string, name: string): { unit: string; missing: string } {
  const lender = join(fx.root, `lender-${name}`);
  git(fx.root, "clone", "--quiet", main, lender);
  const unit = join(fx.scratch, name);
  mkdirSync(unit, { recursive: true });
  git(fx.root, "clone", "--quiet", "--shared", lender, join(unit, "repo"));
  const missing = join(lender, ".git", "objects");
  rmSync(lender, { recursive: true, force: true });
  return { unit, missing };
}

/** <scratch>/<name> holding a nested dependency seed store. */
function seedUnit(fx: Fixture, name: string): string {
  const unit = join(fx.scratch, name);
  mkdirSync(join(unit, "seeds", "store", "pkg"), { recursive: true });
  writeFileSync(join(unit, "seeds", "store", ".rmd-dependency-seed-root.json"), "{}\n");
  writeFileSync(join(unit, "seeds", "store", "pkg", "index.js"), "module.exports = 1;\n");
  return unit;
}

test("W1-T14971 criterion 1: an idle bare repository is bundled and verified, then removed; one written within the window is kept", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const old = bareUnit(fx, main, "flow-followups.AbC123");
  const fresh = bareUnit(fx, main, "fresh-bare.XyZ789");
  age(old, 10 * DAY_HOURS);
  age(fresh, 13);

  const r = run(fx, scratchOnly(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`REMOVE ${old}: bare repository; Git history retained expired after 7 idle days`));
  assert.equal(existsSync(old), false, r.stdout);
  const [copy] = preserved(fx, old);
  assert.ok(copy, `a preserved copy exists:\n${r.stdout}`);
  const bundle = join(copy, "all.bundle");
  assert.equal(existsSync(bundle), true, `the bundle is in ${copy}`);
  git(main, "bundle", "verify", bundle); // verify reads inside a repository
  assert.match(readFileSync(join(copy, "MANIFEST.txt"), "utf8"), /kind:   bare/);
  const restored = join(fx.root, "restored");
  git(fx.root, "clone", "--quiet", "--bare", bundle, restored);
  assert.equal(git(restored, "rev-parse", "main").trim(), git(main, "rev-parse", "HEAD").trim(), "the bundle restores the history");

  assert.equal(existsSync(fresh), true, "a bare repository written within the window stays");
  assert.match(r.stdout, new RegExp(`KEEP ${fresh}: bare repository; Git history retained \\(written within 7 days\\)`));
  assert.deepEqual(preserved(fx, fresh), [], "nothing is copied for a kept unit");
});

test("W1-T14971 criterion 2: an idle clone whose alternates name missing objects is archived with a MANIFEST, then removed", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const { unit, missing } = brokenUnit(fx, main, "g");
  age(unit, 10 * DAY_HOURS);

  const r = run(fx, scratchOnly(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes(`REMOVE ${unit}: borrows from missing ${missing} expired after 7 idle days`), r.stdout);
  assert.equal(existsSync(unit), false, r.stdout);
  const [copy] = preserved(fx, unit);
  assert.ok(copy, r.stdout);
  const listing = execFileSync("tar", ["-tzf", join(copy, "unit.tar.gz")], { encoding: "utf8" });
  assert.match(listing, /^g\/repo\/\.git\/objects\/info\/alternates$/m, "the tarball holds the clone");
  assert.match(readFileSync(join(copy, "MANIFEST.txt"), "utf8"), /kind:   broken/);
});

test("W1-T14971 criterion 3: an idle folder whose seed store no live checkout links to is archived, then removed; a linked one is kept", () => {
  const fx = fixture();
  const orphan = seedUnit(fx, "rmd-w9651-p1.5QAuRk");
  const lent = seedUnit(fx, "rmd-quickstart-demo.jBCbtI");
  const live = join(fx.root, "live-checkout");
  mkdirSync(live, { recursive: true });
  symlinkSync(join(lent, "seeds", "store", "pkg"), join(live, "node_modules"));
  age(orphan, 10 * DAY_HOURS);
  age(lent, 10 * DAY_HOURS);

  const r = run(fx, scratchOnly(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: live, RMD_CLEANUP_PRESERVE_ROOTS: "" }));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`REMOVE ${orphan}: contains dependency seed store`));
  assert.equal(existsSync(orphan), false, r.stdout);
  const [copy] = preserved(fx, orphan);
  assert.ok(copy, r.stdout);
  const listing = execFileSync("tar", ["-tzf", join(copy, "unit.tar.gz")], { encoding: "utf8" });
  assert.match(listing, /seeds\/store\/pkg\/index\.js$/m);

  assert.equal(existsSync(lent), true, "a seed folder a live checkout links into stays");
  assert.match(r.stdout, new RegExp(`KEEP ${lent}: contains dependency seed store.*lends files to symlinks`));
  assert.deepEqual(preserved(fx, lent), []);
});

test("W1-T14971 criterion 4: invariant:foreign-owner-is-never-removed — a folder owned by another user is reported with its size and kept", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const theirs = bareUnit(fx, main, "rp27");
  age(theirs, 10 * DAY_HOURS);
  const uid = Number(spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim());

  const r = run(fx, scratchOnly(fx, { RMD_CLEANUP_UID: String(uid + 1) }));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${theirs}: bare repository; Git history retained; foreign owner \\(uid ${uid}, \\d+ bytes\\)`));
  assert.equal(existsSync(theirs), true, "another user's folder is never removed");
  assert.deepEqual(preserved(fx, theirs), [], "and nothing is copied");
});

test("W1-T14971 criterion 1: a bare repository something outside depends on is kept: an alternates borrower, a hosted worktree or a link into it", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const lent = bareUnit(fx, main, "lent.Aa1111");
  const borrower = join(fx.scratch, "borrower.Bb2222");
  git(fx.root, "clone", "--quiet", "--shared", lent, borrower);
  writeFileSync(join(borrower, ".git", "objects", "info", "alternates"), `${join(lent, "objects")}\n`);
  const host = bareUnit(fx, main, "host.Cc3333");
  mkdirSync(join(host, "worktrees", "outside"), { recursive: true });
  writeFileSync(join(host, "worktrees", "outside", "gitdir"), `${join(fx.root, "elsewhere", "wt")}/.git\n`);
  const linked = bareUnit(fx, main, "linked.Dd4444");
  const live = join(fx.root, "live-checkout");
  mkdirSync(live, { recursive: true });
  symlinkSync(linked, join(live, "upstream.git"));
  for (const p of [lent, host, linked]) age(p, 10 * DAY_HOURS);

  const r = run(fx, scratchOnly(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: live }));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const kept of [lent, host, linked]) {
    assert.equal(existsSync(kept), true, `${kept} stays:\n${r.stdout}`);
    assert.deepEqual(preserved(fx, kept), [], `nothing is copied for ${kept}`);
  }
  assert.match(r.stdout, new RegExp(`KEEP ${lent}: .*lends objects to`));
  assert.match(r.stdout, new RegExp(`KEEP ${host}: .*hosts linked worktree`));
  assert.match(r.stdout, new RegExp(`KEEP ${linked}: .*lends files to symlinks`));
});

test("W1-T14971 criterion 1: an idle bare repository with no refs or a shallow history is tarred whole, then removed", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const empty = join(fx.scratch, "empty-bare.Ee5555");
  git(fx.root, "init", "--quiet", "--bare", empty);
  const shallow = join(fx.scratch, "shallow-bare.Ff6666");
  git(fx.root, "clone", "--quiet", "--bare", "--depth", "1", `file://${main}`, shallow);
  for (const p of [empty, shallow]) age(p, 10 * DAY_HOURS);

  const r = run(fx, scratchOnly(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const gone of [empty, shallow]) {
    assert.equal(existsSync(gone), false, `${gone} is retired:\n${r.stdout}`);
    const [copy] = preserved(fx, gone);
    assert.ok(copy, r.stdout);
    const listing = execFileSync("tar", ["-tzf", join(copy, "unit.tar.gz")], { encoding: "utf8" });
    assert.match(listing, /\/HEAD$/m, `the repository is in the tarball of ${gone}`);
  }
});

test("W1-T14971 criterion 1: an expired hold copy is removed with the other preserved copies, and a full preserve disk holds the unit", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const old = join(fx.root, "preserved", "tmp__old-unit@20260101T000000Z.held");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "MANIFEST.txt"), "old copy\n");
  age(old, 30 * DAY_HOURS);
  const r = run(fx, scratchOnly(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(old), false, `an old .held copy expires:\n${r.stdout}`);

  const full = bareUnit(fx, main, "full-disk.Gg7777");
  age(full, 10 * DAY_HOURS);
  const f = run(fx, scratchOnly(fx, { RMD_CLEANUP_WATCH_FS: `${fx.rootfs}:40`, FAKE_DF_PCT: "95" }));
  assert.equal(existsSync(full), true, `the unit stays when the preserve disk is past its mark:\n${f.stdout}`);
  assert.match(f.stdout, new RegExp(`KEEP ${full}: .*past its watched mark`));
});

test("W1-T14971 criterion 2: a broken clone something outside links into is kept", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const { unit } = brokenUnit(fx, main, "h");
  const live = join(fx.root, "live-checkout");
  mkdirSync(live, { recursive: true });
  symlinkSync(join(unit, "repo"), join(live, "vendored"));
  age(unit, 10 * DAY_HOURS);

  const r = run(fx, scratchOnly(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: live }));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(unit), true, r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${unit}: borrows from missing .*lends files to symlinks`));
  assert.deepEqual(preserved(fx, unit), []);
});

test("W1-T14971 criterion 3: a seed store a live checkout uses through a link inside its node_modules is kept", () => {
  const fx = fixture();
  const used = seedUnit(fx, "rmd-seeded.Hh8888");
  const live = join(fx.root, "live-checkout");
  mkdirSync(join(live, "node_modules"), { recursive: true });
  symlinkSync(join(used, "seeds", "store", "pkg"), join(live, "node_modules", "pkg"));
  age(used, 10 * DAY_HOURS);

  const r = run(fx, scratchOnly(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: live, RMD_CLEANUP_PRESERVE_ROOTS: "" }));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(used), true, r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${used}: contains dependency seed store.*seed store used by ${join(live, "node_modules", "pkg")}`));
  assert.deepEqual(preserved(fx, used), []);
});
