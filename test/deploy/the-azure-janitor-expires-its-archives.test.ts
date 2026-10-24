/**
 * The Azure host janitor's archive expiry (operator ruling 2026-10-23: preserved and archived copies of
 * unpublished work expire after seven days). Each case drives the REAL deploy/rmd-host-cleanup.sh
 * against the host layout rebuilt under a fixture root (#test/helpers/host-cleanup-phases.js), with
 * the defaults derived from RMD_CLEANUP_STATE_DISK, so a wrong default path reads as a red here.
 * Every expiry case asserts that it found entries to expire: a pass that compares nothing fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "#test/helpers/host-cleanup-fixture.js";
import { ageDays, phaseFixture } from "#test/helpers/host-cleanup-phases.js";

function file(path: string, text = "x\n"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function removals(stdout: string, why: RegExp): string[] {
  return stdout.split("\n").filter(l => l.startsWith("REMOVE ") && why.test(l));
}

test("the transcript archive expiry covers the host's real archive at /mnt/rmd/host/archive by default", () => {
  const fx = phaseFixture();
  const archive = join(fx.state, "host", "archive", "claude-projects", "-home-node-Remudero-worktrees-run-1");
  const old = file(join(archive, "old.jsonl"));
  const recent = file(join(archive, "recent.jsonl"));
  ageDays(old, 40);
  ageDays(recent, 3);

  const r = run(fx, fx.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const expired = removals(r.stdout, /archive older than 30 days/);
  assert.ok(expired.length >= 1, `the pass must find a transcript to expire, found none:\n${r.stdout}`);
  assert.equal(existsSync(old), false, r.stdout);
  assert.equal(existsSync(recent), true, "a transcript younger than ARCHIVE_DAYS stays");
  assert.match(r.stdout, new RegExp(`reclaim-total archive-expire ${fx.state}/host/archive: reclaimed`));
});

test("archived copies of unpublished work expire after seven days, entry by entry, in every archive root", () => {
  const fx = phaseFixture();
  const wtArchive = join(fx.state, "host-cleanup-worktree-archive");
  const oldBundle = file(join(wtArchive, "W1-T1-aaaa.bundle"));
  const freshBundle = file(join(wtArchive, "W1-T2-bbbb.bundle"));
  const oldScratch = file(join(wtArchive, "scratch", "run-x.bundle-1.bundle"));
  const freshScratch = file(join(wtArchive, "scratch", "run-y.bundle-2.bundle"));
  const dated = join(fx.state, "archive", "work-2026-09-02");
  const oldWork = join(dated, "t1061-scratch");
  file(join(oldWork, "notes.md"));
  const youngInsideOld = join(dated, "f1209-recent");
  file(join(youngInsideOld, "old.md"));
  const recentLeaf = file(join(youngInsideOld, "new.md"));
  const oldTar = file(join(fx.state, "archive", "attic-2026-10-01-nongit-trees.tar.gz"));
  const legacy = file(join(fx.state, "host-cleanup-archive", "worktrees", "W1-T4596-cccc.bundle"));
  // out of scope: the live validation bundles and any state beside the archive roots
  const validation = file(join(fx.state, "host-cleanup-validation-bundles-20261014", "v.bundle"));
  const state = file(join(fx.state, "state2", "ledger.ndjson"));
  // youngInsideOld is itself nine days old; only a leaf inside it changed recently, which keeps it
  for (const p of [oldBundle, oldScratch, oldWork, oldTar, legacy, validation, state, youngInsideOld]) ageDays(p, 9);
  ageDays(freshBundle, 3);
  ageDays(freshScratch, 6);
  ageDays(recentLeaf, 2);

  const r = run(fx, fx.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const expired = removals(r.stdout, /archived copy unchanged 7 days \(operator ruling 2026-10-23\)/);
  assert.ok(expired.length >= 5, `expected at least five expired entries, found ${expired.length}:\n${r.stdout}`);
  for (const gone of [oldBundle, oldScratch, oldWork, oldTar, legacy]) assert.equal(existsSync(gone), false, `${gone}\n${r.stdout}`);
  for (const kept of [freshBundle, freshScratch, recentLeaf, validation, state]) assert.equal(existsSync(kept), true, `${kept}\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(`reclaim-total retention ${wtArchive}: reclaimed`));
});

test("the hourly temp-only pass expires the archives too", () => {
  const fx = phaseFixture();
  const old = file(join(fx.state, "host-cleanup-worktree-archive", "scratch", "old.bundle"));
  const legacy = file(join(fx.state, "host-cleanup-archive", "worktrees", "old.bundle"));
  ageDays(old, 10);
  ageDays(legacy, 10);
  const r = run(fx, { ...fx.env, RMD_CLEANUP_ONLY_TMP: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /temporary-roots-only mode/);
  assert.equal(removals(r.stdout, /archived copy unchanged 7 days/).length, 2, r.stdout);
  assert.equal(existsSync(old), false, r.stdout);
  assert.equal(existsSync(legacy), false, r.stdout);
});

test("preserved copies expire after seven days; unstamped folders and fresh copies stay", () => {
  const fx = phaseFixture();
  const old = join(fx.preserved, "mnt__scratch__u1@20261001T000000Z");
  const fresh = join(fx.preserved, "mnt__scratch__u2@20261022T000000Z");
  const unstamped = join(fx.preserved, "operator-notes");
  const interrupted = join(fx.preserved, ".incoming-mnt__scratch__u3@20261022T000000Z");
  for (const d of [old, fresh, unstamped, interrupted]) file(join(d, "MANIFEST.txt"));
  ageDays(old, 8);
  ageDays(unstamped, 30);
  ageDays(fresh, 2);
  ageDays(interrupted, 1);

  const r = run(fx, { ...fx.env, RMD_CLEANUP_PRESERVE_ROOTS: "" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(removals(r.stdout, /preserved copy older than 7 days/).length, 1, r.stdout);
  assert.equal(existsSync(old), false, r.stdout);
  assert.equal(existsSync(interrupted), false, `an interrupted copy idle six hours goes:\n${r.stdout}`);
  assert.equal(existsSync(fresh), true, r.stdout);
  assert.equal(existsSync(unstamped), true, "a folder the phase did not stamp is never touched");
});

test("a retention root that could reach live data is refused", () => {
  const fx = phaseFixture();
  const validation = join(fx.state, "host-cleanup-validation-bundles-20261014");
  const inside = file(join(validation, "batch", "v.bundle"));
  const ledger = file(join(fx.state, "state2", "x", "ledger.ndjson"));
  ageDays(inside, 20);
  ageDays(ledger, 20);
  const r = run(fx, { ...fx.env, RMD_CLEANUP_RETAIN_ROOTS: `${validation}:${fx.state}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`REFUSE retention ${validation}: a live validation-bundles tree`));
  assert.match(r.stdout, new RegExp(`REFUSE retention ${fx.state}: contains`));
  assert.equal(existsSync(inside), true);
  assert.equal(existsSync(ledger), true);
});
