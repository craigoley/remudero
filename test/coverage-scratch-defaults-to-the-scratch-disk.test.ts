import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { coverageScratchDir, testWithCoverageLeaf } from "../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const GIB = 1024 ** 3;
const PINNED_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

interface Fixture { repo: string; state: string; scratch: string; seen: string[] }

/** Two directories standing in for the state volume (TMPDIR) and the scratch root; free space and
 *  device identity are injected, so no expectation depends on the host's real disks. */
function withFixture(body: (f: Fixture) => void): void {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}5-`));
  const previousTmp = process.env.TMPDIR;
  const repo = join(base, "repo");
  const state = join(base, "st");
  const scratch = join(base, "sc");
  for (const dir of [repo, state, scratch]) mkdirSync(dir, { recursive: true });
  const fixture: Fixture = { repo, state: realpathSync(state), scratch: realpathSync(scratch), seen: [] };
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

function run(f: Fixture, free: Record<string, number>, sameVolume: (a: string, b: string) => boolean) {
  return testWithCoverageLeaf(
    f.repo, recordingSpawn(f.seen), join(f.repo, "coverage", "lcov.info"),
    (path) => free[realpathSync(path)] ?? 0,
    undefined, {}, { root: f.scratch, sameVolume },
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
