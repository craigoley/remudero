/**
 * W1-T5708 — an idle `rmd-c-<12 hex>` coverage scratch with no lock is reaped at ANY depth under
 * the janitor's roots. Driven as the real deploy/rmd-host-cleanup.sh against a fixture tree: the
 * tmp sweep used to match `rmd-c-*` only directly under its roots, so a killed run's scratch nested
 * inside an ad-hoc checkout was never reclaimed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { age, fixture, run, type Fixture } from "./helpers/host-cleanup-fixture.js";

/** A scratch directory `<fx.scratch>/<parent>/<name>` holding a payload file, aged past idle. */
function nested(fx: Fixture, parent: string, name: string, aged = true): string {
  const p = join(fx.scratch, parent, name);
  mkdirSync(join(p, "raw-shards", "shard-1"), { recursive: true });
  writeFileSync(join(p, "raw-shards", "shard-1", "coverage-1.json"), "{}\n");
  if (aged) age(join(fx.scratch, parent));
  return p;
}

function env(fx: Fixture) {
  const locks = join(fx.root, "locks");
  mkdirSync(locks, { recursive: true });
  return { locks, extra: { RMD_CLEANUP_COVERAGE_LOCK_DIR: locks, RMD_CLEANUP_NESTED_COVERAGE_ROOTS: fx.scratch } };
}

function lockWithHolder(locks: string, name: string, pid: number, host = hostname()): void {
  const dir = join(locks, `${name}.lock`);
  mkdirSync(dir);
  writeFileSync(join(dir, "holder.json"), JSON.stringify({ pid, host, startedAt: new Date().toISOString(), scratch: "/x" }));
}

test("test/a-nested-coverage-scratch-with-no-lock-is-reaped.test.ts", () => {
  const fx = fixture();
  const { locks, extra } = env(fx);
  const idle = nested(fx, "x/tmp", "rmd-c-abcdef012345");
  const locked = nested(fx, "y/tmp", "rmd-c-0123456789ab");
  mkdirSync(join(locks, "rmd-c-0123456789ab.lock"));
  const notes = nested(fx, "z/tmp", "rmd-c-notes");
  const deep = nested(fx, "a/b/c/d", "rmd-c-ffffffffffff");

  const r = run(fx, extra);
  assert.equal(r.status, 0, r.stderr + r.stdout);

  assert.equal(existsSync(idle), false, `an idle nested scratch with no lock is reaped: ${r.stdout}`);
  assert.equal(existsSync(deep), false, `at depth too: ${r.stdout}`);
  assert.match(r.stdout, new RegExp(`REMOVE ${idle}: nested coverage scratch with no lock, [1-9][0-9]* bytes`));
  assert.equal(existsSync(locked), true, "the same shape with its lock present is kept");
  assert.ok(r.stdout.includes(`KEEP ${locked}: its lock ${join(locks, "rmd-c-0123456789ab.lock")} is present with no holder record`), r.stdout);
  assert.equal(existsSync(notes), true, "rmd-c-notes is never matched");
  assert.ok(!r.stdout.includes(notes), r.stdout);
  assert.equal(existsSync(join(fx.scratch, "x", "tmp")), true, "only the scratch goes, not its parent");
});

test("a fresh, symlinked, held-open or live-holder nested scratch is kept", () => {
  const fx = fixture();
  const { locks, extra } = env(fx);
  const fresh = nested(fx, "f/tmp", "rmd-c-111111111111", false);
  const open = nested(fx, "o/tmp", "rmd-c-222222222222");
  writeFileSync(fx.lsofList, `${open}/raw-shards\n`);
  const live = nested(fx, "l/tmp", "rmd-c-333333333333");
  lockWithHolder(locks, "rmd-c-333333333333", process.pid);
  const foreign = nested(fx, "h/tmp", "rmd-c-444444444444");
  lockWithHolder(locks, "rmd-c-444444444444", 1, "another-host.invalid");
  // a symlink named like a scratch is never followed
  const target = nested(fx, "t/tmp", "target-dir");
  mkdirSync(join(fx.scratch, "s"), { recursive: true });
  symlinkSync(target, join(fx.scratch, "s", "rmd-c-555555555555"));

  const r = run(fx, extra);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const p of [fresh, open, live, foreign, join(target, "raw-shards", "shard-1", "coverage-1.json")]) {
    assert.equal(existsSync(p), true, `${p} is kept: ${r.stdout}`);
  }
  assert.ok(r.stdout.includes(`KEEP ${fresh}: written within 720 min`), r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${open}: held open by a process`), r.stdout);
  assert.ok(r.stdout.includes(`is held by live pid ${process.pid}`), r.stdout);
  assert.ok(r.stdout.includes("is held from host another-host.invalid"), r.stdout);
});

test("a nested scratch whose lock names a dead pid is reaped, and DRY_RUN changes nothing", () => {
  const fx = fixture();
  const { locks, extra } = env(fx);
  const dead = spawnSync("true");
  assert.ok(dead.pid !== undefined && dead.pid > 0);
  const orphan = nested(fx, "d/tmp", "rmd-c-666666666666");
  lockWithHolder(locks, "rmd-c-666666666666", dead.pid);

  const dry = run(fx, { ...extra, DRY_RUN: "1" });
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.equal(existsSync(orphan), true, "DRY_RUN leaves it");
  assert.ok(dry.stdout.includes(`DRYRUN would: rm -rf -- ${orphan}`), dry.stdout);

  const r = run(fx, extra);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(orphan), false, r.stdout);
});
