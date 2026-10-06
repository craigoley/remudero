/**
 * tsx's transpile cache (os.tmpdir()/tsx-<uid>) reached 2.7 GB on the Azure host's 29 GB root disk
 * (2026-10-06). The janitor protects `tsx-*` as a whole unit and, until now, pruned nothing inside
 * it. Driven as the real deploy/rmd-host-cleanup.sh against a fixture tmp root: a stale FILE inside
 * the cache goes, a fresh one and the directory itself stay, DRY_RUN=1 changes nothing, and a
 * symlink inside the cache is never followed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, lutimesSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, fixture, run, type Fixture } from "./helpers/host-cleanup-fixture.js";

/** A tsx cache directly under the fixture tmp root: one entry 30 h old, one written just now. */
function tsxCache(fx: Fixture) {
  const dir = join(fx.scratch, "tsx-1000");
  mkdirSync(dir);
  const stale = join(dir, "17911-aaaaaaaa");
  const fresh = join(dir, "17912-bbbbbbbb");
  writeFileSync(stale, '{"code":"stale"}');
  age(stale, 30);
  writeFileSync(fresh, '{"code":"fresh"}');
  return { dir, stale, fresh };
}

test("a stale tsx cache file is pruned while a fresh one and the cache directory are kept", () => {
  const fx = fixture();
  const c = tsxCache(fx);
  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(c.stale), false, `the 30 h entry is pruned: ${r.stdout}`);
  assert.equal(readFileSync(c.fresh, "utf8"), '{"code":"fresh"}', "the fresh entry stays");
  assert.equal(lstatSync(c.dir).isDirectory(), true, "the cache directory itself is never removed");
  assert.match(r.stdout, new RegExp(`PRUNE ${c.dir}: [1-9][0-9]* bytes, 1 tsx cache files older than 24 h`));
  assert.match(r.stdout, /rmd-host-cleanup: pruned 1 stale tsx cache files \([1-9][0-9]* bytes\)/);
  assert.ok(r.stdout.includes(`KEEP ${c.dir}: tsx cache directory`), r.stdout);
});

test("a tsx cache prune under DRY_RUN=1 removes nothing", () => {
  const fx = fixture();
  const c = tsxCache(fx);
  const r = run(fx, { DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes(`PRUNE ${c.dir}: `), `control: the prune was decided: ${r.stdout}`);
  assert.ok(r.stdout.includes(`DRYRUN would: find ${c.dir} -xdev -type f`), r.stdout);
  assert.equal(readFileSync(c.stale, "utf8"), '{"code":"stale"}', "the stale entry is still there");
  assert.equal(existsSync(c.fresh), true);
});

test("a symlink inside a tsx cache is never followed", () => {
  const fx = fixture();
  const c = tsxCache(fx);
  const outside = join(fx.root, "outside");
  mkdirSync(outside);
  const precious = join(outside, "precious.js");
  writeFileSync(precious, "keep\n");
  age(outside, 30);
  const fileLink = join(c.dir, "17911-filelink");
  const dirLink = join(c.dir, "17911-dirlink");
  symlinkSync(precious, fileLink);
  symlinkSync(outside, dirLink);
  const old = new Date(Date.now() - 30 * 3600_000);
  for (const l of [fileLink, dirLink]) lutimesSync(l, old, old);

  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(c.stale), false, `control: the pass did prune the stale entry: ${r.stdout}`);
  assert.equal(readFileSync(precious, "utf8"), "keep\n", "the target of a linked entry is untouched");
  assert.equal(existsSync(outside), true, "a linked directory's target is never entered");
  assert.equal(lstatSync(fileLink).isSymbolicLink(), true, "the link itself is not a cache file");
});

test("a tsx cache that is itself a symlink is kept and never entered", () => {
  const fx = fixture();
  const target = join(fx.root, "elsewhere");
  mkdirSync(target);
  const entry = join(target, "17911-cccccccc");
  writeFileSync(entry, "{}");
  age(entry, 30);
  const link = join(fx.scratch, "tsx-1001");
  symlinkSync(target, link);
  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(entry), true, r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${link}: not a regular directory`), r.stdout);
});

test("a tsx cache max age that is not a positive integer is refused", () => {
  const fx = fixture();
  const c = tsxCache(fx);
  for (const bad of ["0", "abc", "-1"]) {
    const r = run(fx, { RMD_CLEANUP_TSX_MAX_AGE_HOURS: bad });
    assert.equal(r.status, 2, `${bad}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /RMD_CLEANUP_TSX_MAX_AGE_HOURS must be a positive integer/);
  }
  assert.equal(existsSync(c.stale), true, "a refused pass changes nothing");
});
