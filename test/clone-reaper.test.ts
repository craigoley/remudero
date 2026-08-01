/**
 * test/clone-reaper.test.ts — the four safety locks on lib/clone-reaper.ts.
 *
 * CONFINEMENT (impl-EK trap 3). Every fixture here is built under ONE `mkdtempSync` root
 * created by the test itself and removed in `after`. No test ever names a real scratch root,
 * and `reaper cannot escape its root` asserts that property directly rather than trusting it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  cloneReapRoots,
  DEFAULT_CLONE_REAP_MAX_AGE_MS,
  defaultOpenFileCount,
  defaultOriginOf,
  dirSizeBytes,
  isFleetReviewClone,
  reapStaleClones,
  surveyRoot,
  tallyDispositions,
} from "../src/lib/clone-reaper.js";

const SANDBOX = mkdtempSync(join(tmpdir(), "rmd-clonereap-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

let seq = 0;
/** A fresh reap root under the sandbox — never a real scratch root. */
function newRoot(): string {
  const root = join(SANDBOX, `root-${seq++}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Build a directory that LOOKS like a fleet review clone: `<dir>/repo/.git/` + payload. */
function makeClone(root: string, name: string, payloadBytes = 4096): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  writeFileSync(join(dir, "repo", "payload.bin"), Buffer.alloc(payloadBytes, 7));
  return dir;
}

const OURS = () => "https://github.com/craigoley/remudero.git";
/** A clock two ceilings past the fixtures' real mtimes — they are created "now". */
const STALE = { now: () => Date.now() + DEFAULT_CLONE_REAP_MAX_AGE_MS * 2 };
const IDLE = { openFileCount: () => 0 };

describe("clone-reaper", () => {
  it("reaps a stale, fleet-owned, unused clone and reports the bytes reclaimed", () => {
    const root = newRoot();
    const dir = makeClone(root, "review-w1t999", 8192);
    const before = dirSizeBytes(dir);
    assert.ok(before >= 8192, `fixture should hold its payload, got ${before}`);

    const summary = reapStaleClones([root], { originOf: OURS, ...IDLE, ...STALE });

    assert.deepEqual(summary.reaped, [dir]);
    assert.equal(existsSync(dir), false, "the clone must be gone");
    assert.equal(summary.bytesReclaimed, before, "reclamation must equal the tree's measured size");
    assert.ok(summary.bytesReclaimed >= 8192);
    assert.deepEqual(tallyDispositions(summary.candidates), { reaped: 1 });
  });

  it("dry run deletes nothing and still reports what it would reclaim", () => {
    const root = newRoot();
    const dir = makeClone(root, "review-dry", 8192);

    const summary = reapStaleClones([root], { originOf: OURS, ...IDLE, ...STALE, dryRun: true });

    assert.equal(existsSync(dir), true, "dry run must not delete");
    assert.deepEqual(summary.reaped, []);
    assert.equal(summary.bytesReclaimed, 0);
    assert.deepEqual(tallyDispositions(summary.candidates), { "would-reap": 1 });
    assert.ok(summary.candidates[0].bytes >= 8192, "a dry run still measures the tree");
  });

  // ── LOCK 1: liveness ────────────────────────────────────────────────────────
  // The lock that stops a repeat of the two worktrees reapStaleWorktrees destroyed mid-run.

  it("liveness lock: a clone held by a running process is NOT reaped", () => {
    const root = newRoot();
    const dir = makeClone(root, "review-held");

    // Held by THIS live process — one open descriptor inside the tree.
    const fd = openSync(join(dir, "repo", "payload.bin"), "r");
    try {
      const summary = reapStaleClones([root], { originOf: OURS, ...STALE, openFileCount: () => 1 });
      assert.deepEqual(summary.reaped, [], "a held clone must never be reaped");
      assert.equal(existsSync(dir), true);
      assert.deepEqual(tallyDispositions(summary.candidates), { "in-use": 1 });
    } finally {
      closeSync(fd);
    }
  });

  it("liveness lock: the REAL lsof probe sees a live holder, and reports none once released", () => {
    const root = newRoot();
    const dir = makeClone(root, "review-lsof");

    const fd = openSync(join(dir, "repo", "payload.bin"), "r");
    let heldCount: number;
    try {
      heldCount = defaultOpenFileCount(dir);
    } finally {
      closeSync(fd);
    }
    assert.ok(heldCount > 0, `real lsof must see the open descriptor, got ${heldCount}`);
    assert.equal(defaultOpenFileCount(dir), 0, "released tree must probe as idle");
  });

  it("liveness lock: age alone never authorises a reap — a stale clone in use is kept", () => {
    const root = newRoot();
    makeClone(root, "review-old-but-busy");
    const survey = surveyRoot(root, { originOf: OURS, ...STALE, openFileCount: () => 3 });
    assert.equal(survey[0].disposition, "in-use");
    assert.ok(survey[0].ageMs > DEFAULT_CLONE_REAP_MAX_AGE_MS, "fixture must be past the age ceiling");
  });

  it("a fresh clone is kept even when idle", () => {
    const root = newRoot();
    makeClone(root, "review-fresh");
    const survey = surveyRoot(root, { originOf: OURS, ...IDLE, now: () => Date.now() });
    assert.equal(survey[0].disposition, "too-recent");
  });

  // ── LOCK 2: symlinks (trap 2) ───────────────────────────────────────────────

  it("symlink lock: a symlink in the root is never reaped and its target survives", () => {
    const root = newRoot();
    const outside = join(SANDBOX, `target-${seq++}`);
    mkdirSync(join(outside, "repo", ".git"), { recursive: true });
    writeFileSync(join(outside, "repo", "payload.bin"), Buffer.alloc(4096, 3));
    symlinkSync(outside, join(root, "review-link"));

    const summary = reapStaleClones([root], { originOf: OURS, ...IDLE, ...STALE });

    assert.deepEqual(summary.reaped, [], "a symlink must never be a reap candidate");
    assert.equal(existsSync(outside), true, "the symlink's TARGET must be untouched");
    assert.equal(existsSync(join(outside, "repo", "payload.bin")), true);
    assert.deepEqual(tallyDispositions(summary.candidates), { symlink: 1 });
  });

  it("symlink lock: sizing never follows a symlink out of the tree", () => {
    const root = newRoot();
    const dir = makeClone(root, "review-sized", 4096);
    const fat = join(SANDBOX, `fat-${seq++}`);
    mkdirSync(fat, { recursive: true });
    writeFileSync(join(fat, "big.bin"), Buffer.alloc(200_000, 1));
    symlinkSync(fat, join(dir, "node_modules"));

    const measured = dirSizeBytes(dir);
    assert.ok(measured < 100_000, `sizing must not count the link target, got ${measured}`);
    assert.equal(existsSync(join(fat, "big.bin")), true);
  });

  // ── LOCK 3: ownership ───────────────────────────────────────────────────────

  it("ownership lock: a directory the fleet did not create is untouched", () => {
    const root = newRoot();
    // A foreign app's cache, and a foreign git clone — neither is ours.
    const foreignApp = join(root, "podcast-cache");
    mkdirSync(foreignApp, { recursive: true });
    writeFileSync(join(foreignApp, "scores.json"), "{}");
    const foreignRepo = join(root, "tmp.SomeOtherRepo");
    mkdirSync(join(foreignRepo, "repo", ".git"), { recursive: true });

    const summary = reapStaleClones([root], {
      originOf: (d) => (d.includes("SomeOtherRepo") ? "https://github.com/someone/other.git" : null),
      ...IDLE,
      ...STALE,
    });

    assert.deepEqual(summary.reaped, []);
    assert.equal(existsSync(join(foreignApp, "scores.json")), true);
    assert.equal(existsSync(foreignRepo), true);
    assert.deepEqual(tallyDispositions(summary.candidates), { "not-a-fleet-clone": 2 });
  });

  it("ownership lock: a LINKED WORKTREE (.git is a file) never qualifies", () => {
    const root = newRoot();
    const dir = join(root, "review-linked-worktree");
    mkdirSync(join(dir, "repo"), { recursive: true });
    // A linked worktree's .git is a FILE pointing into the parent clone's admin dir.
    writeFileSync(join(dir, "repo", ".git"), "gitdir: /Users/x/Remudero/remudero/.git/worktrees/w\n");

    assert.equal(isFleetReviewClone(dir, { originOf: OURS }), null, ".git as a FILE must be refused");
    const summary = reapStaleClones([root], { originOf: OURS, ...IDLE, ...STALE });
    assert.deepEqual(summary.reaped, []);
    assert.equal(existsSync(dir), true);
  });

  it("ownership lock: the bare <dir>/.git layout is accepted when the origin matches", () => {
    const root = newRoot();
    const dir = join(root, "bare-layout");
    mkdirSync(join(dir, ".git"), { recursive: true });
    assert.equal(isFleetReviewClone(dir, { originOf: OURS }), dir);
    assert.equal(isFleetReviewClone(dir, { originOf: () => "https://github.com/x/y.git" }), null);
    assert.equal(isFleetReviewClone(dir, { originOf: () => null }), null);
  });

  it("ownership lock: the real origin probe returns null for a non-repo directory", () => {
    const root = newRoot();
    assert.equal(defaultOriginOf(root), null);
  });

  // ── LOCK 4: confinement (trap 3) ────────────────────────────────────────────

  it("confinement: the reaper cannot escape its root", () => {
    const root = newRoot();
    const sibling = join(SANDBOX, `sibling-${seq++}`);
    mkdirSync(join(sibling, "repo", ".git"), { recursive: true });
    writeFileSync(join(sibling, "repo", "payload.bin"), Buffer.alloc(4096, 9));
    makeClone(root, "review-inside");

    const summary = reapStaleClones([root], { originOf: OURS, ...IDLE, ...STALE });

    // The sibling is a perfect fleet clone by every other test — only its LOCATION saves it.
    assert.equal(existsSync(sibling), true, "a clone outside the root must be untouched");
    assert.equal(summary.reaped.length, 1);
    for (const c of summary.candidates) {
      assert.ok(c.path.startsWith(root), `candidate escaped the root: ${c.path}`);
    }
  });

  it("confinement: an absent or unreadable root yields nothing and never throws", () => {
    const summary = reapStaleClones([join(SANDBOX, "does-not-exist")], { originOf: OURS, ...IDLE, ...STALE });
    assert.deepEqual(summary.candidates, []);
    assert.deepEqual(summary.reaped, []);
  });

  it("a plain file in the root is skipped entirely", () => {
    const root = newRoot();
    writeFileSync(join(root, "notes.txt"), "hello");
    const survey = surveyRoot(root, { originOf: OURS, ...IDLE, ...STALE });
    assert.deepEqual(survey, []);
  });

  it("sizing an absent directory is 0, and an unreadable entry contributes 0", () => {
    assert.equal(dirSizeBytes(join(SANDBOX, "no-such-dir")), 0);
    const root = newRoot();
    writeFileSync(join(root, "a.bin"), Buffer.alloc(1000, 1));
    const measured = dirSizeBytes(root, {
      ...fs,
      lstatSync: ((p: string) => {
        if (String(p).endsWith("a.bin")) throw new Error("EACCES");
        return fs.lstatSync(p);
      }) as never,
    } as never);
    assert.equal(measured, 0, "an unreadable entry must contribute 0, not throw");
  });

  it("containment: a traversal name from readdir is refused before anything else runs", () => {
    const root = newRoot();
    const survey = surveyRoot(root, {
      originOf: OURS,
      ...IDLE,
      ...STALE,
      fsImpl: { ...fs, readdirSync: (() => ["..", "."]) as never } as never,
    });
    assert.ok(survey.length > 0);
    for (const c of survey) assert.equal(c.disposition, "outside-root");
  });

  it("an entry that vanishes between readdir and lstat is skipped silently", () => {
    const root = newRoot();
    const survey = surveyRoot(root, {
      originOf: OURS,
      ...IDLE,
      ...STALE,
      fsImpl: {
        ...fs,
        readdirSync: (() => ["ghost"]) as never,
        lstatSync: (() => {
          throw new Error("ENOENT");
        }) as never,
      } as never,
    });
    assert.deepEqual(survey, []);
  });

  it("cloneReapRoots: darwin adds /private/tmp, absent roots are dropped, duplicates deduped", () => {
    const seenRoots = new Set<string>();
    const fsAllPresent = { ...fs, existsSync: ((p: string) => (seenRoots.add(p), true)) as never } as never;

    const darwin = cloneReapRoots({ platform: "darwin", fsImpl: fsAllPresent });
    assert.ok(darwin.includes("/private/tmp"), "darwin must survey /private/tmp");
    assert.equal(new Set(darwin).size, darwin.length, "roots must be deduped");

    const linux = cloneReapRoots({ platform: "linux", fsImpl: fsAllPresent });
    assert.equal(linux.includes("/private/tmp"), false, "non-darwin must not survey /private/tmp");

    const none = cloneReapRoots({ platform: "darwin", fsImpl: { ...fs, existsSync: (() => false) as never } as never });
    assert.deepEqual(none, [], "a root that does not exist is never surveyed");
  });

  it("a failed removal is recorded, never thrown, and does not abort the sweep", () => {
    const root = newRoot();
    makeClone(root, "review-a");
    makeClone(root, "review-b");
    const summary = reapStaleClones([root], {
      originOf: OURS,
      ...IDLE,
      ...STALE,
      fsImpl: {
        ...fs,
        rmSync: (p: string) => {
          if (String(p).endsWith("review-a")) throw new Error("EPERM");
        },
      } as never,
    });
    const tally = tallyDispositions(summary.candidates);
    assert.equal(tally["remove-failed"], 1);
    assert.equal(tally.reaped, 1, "the sibling must still be processed");
  });
});
