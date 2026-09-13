/**
 * test/disk-artifact-reclaim-refuses-a-live-or-dirty-target.test.ts — W1-T3528.
 *
 * Every seam is injected, so none of this touches a real filesystem at a real fill level — the
 * same contract W1-T1082 used for `statfs`. The three refusals asserted here each fired for real
 * during the 2026-09-13 hand cleanup that motivated the task; they are not hypotheticals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import {
  DEFAULT_ARTIFACT_REAP_GRACE_MS,
  RECLAIMABLE_ARTIFACT_NAMES,
  sweepReclaimableArtifacts,
  type ArtifactSweepOptions,
} from "../src/lib/disk-artifact-reclaim.js";

const NOW = 1_800_000_000_000;
const SCAN_ROOT = "/scan";
const CHECKOUT = join(SCAN_ROOT, "rmd-pf");
const ARTIFACT = join(CHECKOUT, "node_modules");

const config = { root: "/scan/managed" } as unknown as Config;

/** A host that is genuinely short of space, holding ONE clean idle checkout with one artifact.
 *  Each test overrides exactly the seam it is about, so a refusal can never pass for the wrong
 *  reason. */
function baseOpts(overrides: ArtifactSweepOptions = {}): ArtifactSweepOptions {
  const removed: string[] = [];
  return {
    scanRoot: () => SCAN_ROOT,
    listEntries: () => ["rmd-pf"],
    isDirectory: (p) => p === CHECKOUT || p === ARTIFACT,
    isCheckout: (p) => p === CHECKOUT,
    clock: fixedClock(NOW),
    freeBytes: () => 1 * 1024 * 1024 * 1024, // 1GiB free — well under the threshold
    countDirtyFiles: () => 0,
    isInUse: () => false,
    modifiedAtMs: () => NOW - DEFAULT_ARTIFACT_REAP_GRACE_MS - 1,
    sizeBytes: () => 836 * 1024 * 1024,
    removeDir: (p) => {
      removed.push(p);
    },
    ...overrides,
  };
}

test("a regenerable artifact in a clean idle checkout is reclaimed", () => {
  const removed: string[] = [];
  const summary = sweepReclaimableArtifacts(config, () => {}, baseOpts({ removeDir: (p) => void removed.push(p) }));

  assert.deepEqual(summary.reclaimed, [ARTIFACT], "the clean idle artifact must be reclaimed");
  assert.deepEqual(removed, [ARTIFACT], "and actually removed, not merely reported");
  assert.equal(summary.bytesReclaimed, 836 * 1024 * 1024, "the freed bytes are ledgered");
  // THE POSITIVE CASE IS THE ONE THAT CATCHES A VACUOUS PASS: a sweep that refuses everything
  // would satisfy all three refusal tests below while reclaiming nothing, forever.
});

test("a target in a dirty checkout is refused", () => {
  const removed: string[] = [];
  const summary = sweepReclaimableArtifacts(
    config,
    () => {},
    baseOpts({ countDirtyFiles: () => 45, removeDir: (p) => void removed.push(p) }),
  );

  assert.deepEqual(summary.reclaimed, [], "a tree with uncommitted work must never be reclaimed from");
  assert.deepEqual(removed, [], "and nothing may be removed");
  assert.equal(summary.kept.find((k) => k.path === ARTIFACT)?.reason, "checkout-dirty");
});

test("a target with an open file handle is refused", () => {
  const removed: string[] = [];
  const summary = sweepReclaimableArtifacts(
    config,
    () => {},
    baseOpts({ isInUse: () => true, removeDir: (p) => void removed.push(p) }),
  );

  assert.deepEqual(summary.reclaimed, [], "a live tree must never be reclaimed");
  assert.deepEqual(removed, [], "and nothing may be removed");
  assert.equal(summary.kept.find((k) => k.path === ARTIFACT)?.reason, "in-use");
});

test("an unanswerable in-use question is refused exactly like an open handle", () => {
  const summary = sweepReclaimableArtifacts(config, () => {}, baseOpts({ isInUse: () => undefined }));

  assert.deepEqual(summary.reclaimed, [], "fail closed: cannot-tell reads the same as in-use");
  assert.equal(summary.kept.find((k) => k.path === ARTIFACT)?.reason, "in-use");
});

test("age alone does not authorise a reclaim", () => {
  // Ancient, but dirty: age is satisfied and the reclaim must still be refused. This is the
  // review sweep's own doctrine — age cannot tell a stranded tree from a slow live one.
  const ancient = sweepReclaimableArtifacts(
    config,
    () => {},
    baseOpts({ modifiedAtMs: () => 0, countDirtyFiles: () => 1 }),
  );
  assert.deepEqual(ancient.reclaimed, [], "age must not override the dirty-tree refusal");

  // And the converse: young enough is refused on its own, so the guard is real in both directions.
  const young = sweepReclaimableArtifacts(config, () => {}, baseOpts({ modifiedAtMs: () => NOW - 1 }));
  assert.deepEqual(young.reclaimed, []);
  assert.equal(young.kept.find((k) => k.path === ARTIFACT)?.reason, "too-young");
});

test("a healthy disk is left entirely alone", () => {
  const summary = sweepReclaimableArtifacts(
    config,
    () => {},
    baseOpts({ freeBytes: () => 100 * 1024 * 1024 * 1024 }),
  );

  assert.deepEqual(summary.reclaimed, [], "no pressure, no deletion");
  assert.equal(summary.kept[0]?.reason, "headroom-ok");
});

test("an unreadable disk reading never authorises a reclaim", () => {
  const summary = sweepReclaimableArtifacts(config, () => {}, baseOpts({ freeBytes: () => undefined }));

  assert.deepEqual(summary.reclaimed, [], "an unanswerable statfs is never a yes");
  assert.equal(summary.kept[0]?.reason, "unreadable");
});

test("a directory that is not a checkout is never a candidate", () => {
  const summary = sweepReclaimableArtifacts(config, () => {}, baseOpts({ isCheckout: () => false }));

  assert.deepEqual(summary.reclaimed, []);
  assert.deepEqual(summary.kept, [], "a non-checkout is skipped silently, not ledgered as a refusal");
});

test("the allowlist is names whose contents regenerate, never a size sweep", () => {
  assert.deepEqual([...RECLAIMABLE_ARTIFACT_NAMES].sort(), ["coverage", "node_modules"]);
  // Size is deliberately absent from the option surface: the checkout that motivated this task
  // held 546MB of node_modules beside 45 uncommitted files, so size would have selected exactly
  // the tree the dirty check had to save.
  const summary = sweepReclaimableArtifacts(
    config,
    () => {},
    baseOpts({ isDirectory: (p) => p === CHECKOUT || p === join(CHECKOUT, "src") }),
  );
  assert.deepEqual(summary.reclaimed, [], "a non-allowlisted directory is never reclaimed");
});

/**
 * THE DEFAULTS MUST BE EXERCISED FOR REAL, or every seam above stays a fake and the module's own
 * `statfs`, `git status`, `lsof`, `du` and `rm` paths ship untested — the documented trap where a
 * fully-injected suite leaves each default and each catch arm unreachable.
 */
test("with nothing injected, the real defaults reclaim a real artifact on disk", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "rmd-artifact-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const checkout = join(tmp, "clone");
  mkdirSync(join(checkout, "coverage"), { recursive: true });
  writeFileSync(join(checkout, "coverage", "lcov.info"), "TN:\n");
  // `coverage/` is ignored AND the ignore is committed, so `git status --porcelain` is genuinely
  // empty — a clean tree, which is the only state the sweep will act on.
  writeFileSync(join(checkout, ".gitignore"), "coverage/\n");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", checkout, "-c", "user.email=t@e", "-c", "user.name=t", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  };
  execFileSync("git", ["init", "-q", checkout], { stdio: ["ignore", "ignore", "pipe"] });
  git("add", ".gitignore");
  git("commit", "-qm", "seed");

  const artifact = join(checkout, "coverage");
  assert.equal(existsSync(artifact), true, "fixture must start with the artifact present");

  const summary = sweepReclaimableArtifacts({ root: join(tmp, "managed") } as unknown as Config, () => {}, {
    scanRoot: () => tmp,
    // The ONLY injected values: a threshold high enough that the REAL statfs reading is below it,
    // and a zero grace so the just-created fixture is old enough. Every other seam is the default.
    reclaimBelowBytes: Number.MAX_SAFE_INTEGER,
    graceMs: 0,
  });

  assert.deepEqual(summary.reclaimed, [artifact], "the real default path must reclaim the artifact");
  assert.equal(existsSync(artifact), false, "and it must actually be gone from disk");
  assert.equal(existsSync(join(checkout, ".gitignore")), true, "the tree itself must survive");
});

test("with nothing injected, a real dirty checkout is refused", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "rmd-artifact-dirty-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const checkout = join(tmp, "clone");
  mkdirSync(join(checkout, "coverage"), { recursive: true });
  writeFileSync(join(checkout, "coverage", "lcov.info"), "TN:\n");
  execFileSync("git", ["init", "-q", checkout], { stdio: ["ignore", "ignore", "pipe"] });
  // No .gitignore and no commit: `coverage/` is untracked, so the real `git status --porcelain`
  // reports a dirty tree and the real refusal must fire.
  const summary = sweepReclaimableArtifacts({ root: join(tmp, "managed") } as unknown as Config, () => {}, {
    scanRoot: () => tmp,
    reclaimBelowBytes: Number.MAX_SAFE_INTEGER,
    graceMs: 0,
  });

  assert.deepEqual(summary.reclaimed, [], "a genuinely dirty tree must be refused by the real reader");
  assert.equal(existsSync(join(checkout, "coverage")), true, "and the artifact must survive on disk");
  assert.equal(summary.kept.find((k) => k.path === join(checkout, "coverage"))?.reason, "checkout-dirty");
});
