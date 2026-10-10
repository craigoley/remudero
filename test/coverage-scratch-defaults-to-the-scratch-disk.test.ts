import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { coverageScratchDir, testWithCoverageLeaf } from "../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { acquireTestSlot, TEST_SLOT_DIR_ENV, TEST_SLOTS_ENV } from "../src/lib/test-slot.js";

const GIB = 1024 ** 3;
const PINNED_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

interface Fixture { repo: string; state: string; scratch: string; seen: string[]; slotWaits: number }

/** Two directories standing in for the state volume (TMPDIR) and the scratch root; free space and
 *  device identity are injected, so no expectation depends on the host's real disks. */
function withFixture(body: (f: Fixture) => void): void {
  // Under /tmp, not tmpdir(): macOS's per-user TMPDIR is too long for the coverage scratch guard,
  // which would move the TMPDIR-derived scratch to /tmp and off the fixture's fake volumes.
  const base = mkdtempSync(join("/tmp", `${RMD_TMP_PREFIX}5-`));
  const previousTmp = process.env.TMPDIR;
  const repo = join(base, "repo");
  const state = join(base, "st");
  const scratch = join(base, "sc");
  for (const dir of [repo, state, scratch]) mkdirSync(dir, { recursive: true });
  const fixture: Fixture = { repo, state: realpathSync(state), scratch: realpathSync(scratch), seen: [], slotWaits: 0 };
  process.env.TMPDIR = state;
  try {
    body(fixture);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(base, { recursive: true, force: true });
  }
}

/** Records the TMPDIR each coverage shard is given, then fails the shard: the run stops after the first. */
function recordingSpawn(seen: string[]): PreflightSpawn {
  return (file, args, opts) => {
    if (file === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${PINNED_BASE_SHA}\n`, stderr: "" };
    if (args.includes("--experimental-test-coverage")) {
      seen.push(opts?.env?.TMPDIR ?? "");
      return { status: 1, stdout: "", stderr: "fixture shard failed" };
    }
    return { status: 0, stdout: "test/x.test.ts\n", stderr: "" };
  };
}

function fixtureSlot(f: Fixture) {
  return {
    dir: join(f.scratch, "slots"), slots: 1,
    load: () => ({ cores: 2, load1: 0 }),
    sleep: () => { f.slotWaits += 1; throw new Error("fixture tried to wait on another suite's slot"); },
    log: () => {},
  };
}

function run(f: Fixture, free: Record<string, number>, sameVolume: (a: string, b: string) => boolean) {
  return testWithCoverageLeaf(
    f.repo, recordingSpawn(f.seen), join(f.repo, "coverage", "lcov.info"),
    (path) => free[realpathSync(path)] ?? 0,
    undefined, fixtureSlot(f), { root: f.scratch, sameVolume },
  );
}

test("with TMPDIR on a fake 12 GiB-free state volume and a 300 GiB-free scratch root, the scratch dir lands under the scratch root", () => {
  withFixture((f) => {
    const result = run(f, { [f.state]: 12 * GIB, [f.scratch]: 300 * GIB }, () => false);
    assert.equal(f.seen.length, 1, `the run reached a coverage shard instead of refusing: ${result.detail}`);
    assert.equal(dirname(f.seen[0]!), f.scratch, "the shard's TMPDIR is a directory directly under the scratch root");
    assert.equal(basename(f.seen[0]!), basename(coverageScratchDir(f.repo)), "it keeps the checkout's stable scratch name");
    assert.equal(existsSync(join(f.state, basename(f.seen[0]!))), false, "nothing was written onto the state volume");
    assert.match(result.detail, new RegExp(`scratch=${f.scratch}.*scratch root`), "the chosen root is named in the gate's output");
  });
});

test("with both volumes under the 20 GiB reserve the run refuses naming both free figures", () => {
  withFixture((f) => {
    const result = run(f, { [f.state]: 12 * GIB, [f.scratch]: 15 * GIB }, () => false);
    assert.equal(result.ok, false);
    assert.equal(f.seen.length, 0, "no coverage shard started");
    assert.ok(result.detail.includes(String(12 * GIB)), `names the state volume's free bytes: ${result.detail}`);
    assert.ok(result.detail.includes(String(15 * GIB)), `names the scratch root's free bytes: ${result.detail}`);
    assert.ok(result.detail.includes(f.scratch) && result.detail.includes(f.state), "names both locations");
  });
});

test("with TMPDIR already on the scratch device the TMPDIR volume is used unchanged", () => {
  withFixture((f) => {
    const result = run(f, { [f.state]: 300 * GIB, [f.scratch]: 300 * GIB }, () => true);
    assert.equal(f.seen.length, 1, `the run reached a coverage shard: ${result.detail}`);
    assert.equal(f.seen[0], join(f.state, basename(coverageScratchDir(f.repo))), "the shard's TMPDIR is the TMPDIR-derived scratch");
    assert.match(result.detail, /\(TMPDIR volume\)/, "the TMPDIR volume is named as the chosen root");
  });
});

type Policy = NonNullable<Parameters<typeof testWithCoverageLeaf>[6]>;

function runPolicy(f: Fixture, free: Record<string, number>, policy: Policy) {
  return testWithCoverageLeaf(
    f.repo, recordingSpawn(f.seen), join(f.repo, "coverage", "lcov.info"),
    (path) => free[realpathSync(path)] ?? 0,
    undefined, fixtureSlot(f), policy,
  );
}

test("with no device comparison injected, a scratch root on TMPDIR's own device leaves the TMPDIR volume in use", () => {
  withFixture((f) => {
    const result = runPolicy(f, { [f.state]: 300 * GIB, [f.scratch]: 300 * GIB }, { root: f.scratch });
    assert.equal(f.seen.length, 1, `the run reached a coverage shard: ${result.detail}`);
    assert.equal(f.seen[0], join(f.state, basename(coverageScratchDir(f.repo))), "both directories share this host's device, so TMPDIR is kept");
  });
});

test("a TMPDIR volume that cannot be stat'ed is not assumed to share the scratch root's device", () => {
  withFixture((f) => {
    process.env.TMPDIR = join(dirname(f.repo), "gone");
    const result = runPolicy(f, { [f.scratch]: 300 * GIB }, { root: f.scratch });
    assert.equal(f.seen.length, 1, `the run reached a coverage shard: ${result.detail}`);
    assert.equal(dirname(f.seen[0]!), f.scratch, "the unprovable device share sends the scratch dir to the scratch root");
  });
});

test("RMD_SCRATCH_ROOT names the scratch root without waiting on a parent coverage slot", () => {
  withFixture((f) => {
    const previous = { context: process.env.NODE_TEST_CONTEXT, root: process.env.RMD_SCRATCH_ROOT,
      slotDir: process.env[TEST_SLOT_DIR_ENV], slots: process.env[TEST_SLOTS_ENV] };
    const outerDir = join(dirname(f.repo), "outer-slots");
    const outer = acquireTestSlot("fixture parent coverage", { dir: outerDir, slots: 1, load: () => ({ cores: 2, load1: 0 }) });
    assert.equal(outer.outcome, "acquired", "the real parent-slot positive control is held");
    const outerPath = join(outerDir, "slot-1.json");
    const held = readFileSync(outerPath, "utf8");
    delete process.env.NODE_TEST_CONTEXT;
    process.env.RMD_SCRATCH_ROOT = f.scratch;
    process.env[TEST_SLOT_DIR_ENV] = outerDir;
    process.env[TEST_SLOTS_ENV] = "1";
    try {
      const result = runPolicy(f, { [f.state]: 12 * GIB, [f.scratch]: 300 * GIB }, { sameVolume: () => false });
      assert.equal(f.seen.length, 1, `the run reached a coverage shard: ${result.detail}`);
      assert.equal(dirname(f.seen[0]!), f.scratch, "the configured root is used");
      assert.equal(f.slotWaits, 0, "the fixture uses its own real slot instead of entering the parent's 45-minute wait");
      assert.equal(readFileSync(outerPath, "utf8"), held, "the parent lease is neither reclaimed nor rewritten");
      assert.equal(existsSync(join(f.scratch, "slots", "slot-1.json")), false, "the fixture releases its own slot");
    } finally {
      outer.release();
      if (previous.context === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = previous.context;
      if (previous.root === undefined) delete process.env.RMD_SCRATCH_ROOT;
      else process.env.RMD_SCRATCH_ROOT = previous.root;
      if (previous.slotDir === undefined) delete process.env[TEST_SLOT_DIR_ENV];
      else process.env[TEST_SLOT_DIR_ENV] = previous.slotDir;
      if (previous.slots === undefined) delete process.env[TEST_SLOTS_ENV];
      else process.env[TEST_SLOTS_ENV] = previous.slots;
    }
  });
});

test("a scratch root that does not resolve is not a candidate and the TMPDIR volume decides", () => {
  withFixture((f) => {
    const result = runPolicy(f, { [f.state]: 300 * GIB }, { root: join(dirname(f.repo), "missing-scratch"), sameVolume: () => false });
    assert.equal(f.seen.length, 1, `the run reached a coverage shard: ${result.detail}`);
    assert.equal(f.seen[0], join(f.state, basename(coverageScratchDir(f.repo))), "the TMPDIR-derived scratch is used");
  });
});
