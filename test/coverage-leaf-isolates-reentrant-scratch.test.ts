import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { CI_PARITY_TABLE, coverageScratchDir } from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

const PINNED_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

function runCoverageLeaf(repoRoot: string, sentinel: string, failShard?: number): { shardTmpdirs: string[]; testOk: boolean } {
  const shardTmpdirs: string[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    if (file === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: `${PINNED_BASE_SHA}\n`, stderr: "" };
    }
    if (args.some((arg) => arg.endsWith("scripts/test-tier-manifest.mjs")) && args.includes("--select-all")) {
      return { status: 0, stdout: "test/probe.test.ts\n", stderr: "" };
    }
    if (args.includes("--experimental-test-coverage")) {
      assert.equal(readFileSync(sentinel, "utf8"), "parent lives", "the caller's fixture survives until the shard runs");
      const scratch = opts?.env?.TMPDIR;
      const rawDir = opts?.env?.NODE_V8_COVERAGE;
      assert.ok(scratch && rawDir, "the shard receives both scratch and raw coverage paths");
      assert.ok(existsSync(scratch), "the shard's scratch is prepared before spawn");
      shardTmpdirs.push(scratch);
      if (shardTmpdirs.length === failShard) return { status: 1, stdout: "# tests 1\n# fail 1\n", stderr: "shard failed" };
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(join(rawDir, `coverage-${shardTmpdirs.length}.json`), "{}");
      return { status: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const entry = CI_PARITY_TABLE.find((candidate) => candidate.job === "coverage-ratchet");
  assert.ok(entry?.run, "control: the real coverage-ratchet entry is present");
  const steps = entry.run(repoRoot, spawn);
  return {
    shardTmpdirs,
    testOk: steps.find((step) => step.name === "coverage-ratchet:test-with-coverage")?.ok ?? false,
  };
}

function withParentTmpdir(parent: string, run: () => void): void {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = parent;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

test("nested coverage runs isolate scratch without deleting the parent TMPDIR", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-coverage-nested-"));
  const repoRoot = join(root, "repo");
  const parent = coverageScratchDir(repoRoot);
  const sentinel = join(parent, "caller-fixture.txt");
  mkdirSync(repoRoot);
  mkdirSync(parent, { recursive: true });
  writeFileSync(sentinel, "parent lives");
  try {
    withParentTmpdir(parent, () => {
      const result = runCoverageLeaf(repoRoot, sentinel);
      assert.equal(result.testOk, true);
      assert.equal(result.shardTmpdirs.length, 4);
      assert.equal(new Set(result.shardTmpdirs).size, 1, "all nested shards share this invocation's scratch");
      assert.notEqual(result.shardTmpdirs[0], parent, "nested shards never reuse their caller's TMPDIR");
      assert.equal(readFileSync(sentinel, "utf8"), "parent lives");
      assert.equal(existsSync(result.shardTmpdirs[0]!), false, "only the nested scratch is removed after all shards");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested coverage scratch is removed after a shard fails", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-coverage-failed-shard-"));
  const repoRoot = join(root, "repo");
  const parent = coverageScratchDir(repoRoot);
  const sentinel = join(parent, "caller-fixture.txt");
  mkdirSync(repoRoot);
  mkdirSync(parent, { recursive: true });
  writeFileSync(sentinel, "parent lives");
  try {
    withParentTmpdir(parent, () => {
      const result = runCoverageLeaf(repoRoot, sentinel, 2);
      assert.equal(result.testOk, false);
      assert.equal(result.shardTmpdirs.length, 2);
      assert.equal(readFileSync(sentinel, "utf8"), "parent lives");
      assert.equal(existsSync(result.shardTmpdirs[0]!), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested coverage refuses to spawn when its isolated scratch cannot be prepared", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-coverage-unwritable-scratch-"));
  const repoRoot = join(root, "repo");
  const parent = coverageScratchDir(repoRoot);
  mkdirSync(repoRoot);
  mkdirSync(dirname(parent), { recursive: true });
  writeFileSync(parent, "occupied parent");
  try {
    withParentTmpdir(parent, () => {
      const result = runCoverageLeaf(repoRoot, parent);
      assert.equal(result.testOk, false);
      assert.equal(result.shardTmpdirs.length, 0, "no shard can use an unprepared child path");
      assert.equal(readFileSync(parent, "utf8"), "occupied parent");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage shards use canonical TMPDIR paths when the sibling scratch parent is symlinked", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-coverage-alias-"));
  const repoRoot = join(root, "repo");
  const parent = coverageScratchDir(repoRoot);
  const physicalParent = join(root, "physical-scratch");
  const sentinel = join(parent, "caller-fixture.txt");
  mkdirSync(repoRoot);
  mkdirSync(physicalParent);
  symlinkSync(physicalParent, dirname(dirname(parent)), "dir");
  mkdirSync(parent, { recursive: true });
  writeFileSync(sentinel, "parent lives");
  try {
    withParentTmpdir(realpathSync(parent), () => {
      const result = runCoverageLeaf(repoRoot, sentinel);
      assert.equal(result.testOk, true);
      assert.equal(result.shardTmpdirs.length, 4);
      for (const scratch of result.shardTmpdirs) {
        assert.equal(scratch, join(realpathSync(dirname(scratch)), basename(scratch)));
        assert.ok(scratch.startsWith(`${realpathSync(parent)}/`), "nested scratch stays under physical parent");
      }
      assert.equal(readFileSync(sentinel, "utf8"), "parent lives");
      assert.equal(existsSync(result.shardTmpdirs[0]!), false, "nested scratch is cleaned after the run");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
