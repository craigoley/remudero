import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { CI_COVERAGE_SHARD_COUNT, coverageShardConcurrency, runCiParity } from "../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

interface Call {
  file: string;
  args: string[];
  opts?: { cwd?: string; input?: string; stream?: boolean; env?: NodeJS.ProcessEnv };
}

function selectorShardNumber(args: readonly string[]): number | undefined {
  if (!args.some((arg) => arg.endsWith("scripts/test-tier-manifest.mjs")) || !args.includes("--select-all")) return undefined;
  const shard = args[args.indexOf("--shard") + 1];
  const match = shard?.match(/^(\d+)\/4$/);
  return match ? Number(match[1]) : undefined;
}

function shardNumber(args: readonly string[]): number | undefined {
  const selected = args.find((arg) => /^test\/coverage-shard-\d+\.test\.ts$/.test(arg));
  const match = selected?.match(/^test\/coverage-shard-(\d+)\.test\.ts$/);
  return match ? Number(match[1]) : undefined;
}

function coverageFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coverage-entry-parity-`));
  const workflowDirectory = join(root, ".github", "workflows");
  mkdirSync(workflowDirectory, { recursive: true });
  copyFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), join(workflowDirectory, "ci.yml"));
  return root;
}

function coverageSpawn(repoRoot: string, options: { missingArtifactShard?: number; missingSummaryShard?: number } = {}) {
  const calls: Call[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const selectorShard = selectorShardNumber(args);
    if (selectorShard !== undefined) return { status: 0, stdout: `test/coverage-shard-${selectorShard}.test.ts\n`, stderr: "" };
    const shard = shardNumber(args);
    if (shard !== undefined) {
      const rawDir = opts?.env?.NODE_V8_COVERAGE;
      assert.ok(rawDir, "each shard must set NODE_V8_COVERAGE to its own raw directory");
      if (shard !== options.missingArtifactShard) {
        mkdirSync(rawDir, { recursive: true });
        writeFileSync(join(rawDir, `coverage-${shard}-0000000000000-0.json`), "{}\n");
      } else {
        rmSync(rawDir, { recursive: true, force: true });
      }
      const stdout = shard === options.missingSummaryShard ? "ok 1 - shard without totals\n" : "# tests 1\n# pass 1\n# fail 0\n";
      return { status: 0, stdout, stderr: "" };
    }
    if (args.some((a) => a.endsWith("coverage-merge-ratchet.mjs"))) {
      const output = args[args.indexOf("--output") + 1]!;
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, "SF:src/lib/ci-parity.ts\nDA:1,1\nend_of_record\n");
      return { status: 0, stdout: "coverage-merge-ratchet: merged 4 raw shard(s)\n", stderr: "" };
    }
    if (file === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${PINNED_BASE_SHA}\n`, stderr: "" };
    if (file === "git" && args[0] === "diff") return { status: 0, stdout: "diff --git a/src/lib/ci-parity.ts b/src/lib/ci-parity.ts\n+covered\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return {
    calls,
    spawn,
    cleanup: () => {
      // ONLY this suite's own artifact tree. `coverage/lcov.info` is deliberately NOT removed:
      // when this test runs inside CI's coverage-shard job, that path is the file the shard's own
      // `--test-reporter-destination` is writing, and deleting it made the job fail its
      // `[ ! -s coverage/lcov.info ]` check with "no lcov produced" — a green suite and a red job,
      // with no failing test to point at. The merge here is stubbed and never creates that file,
      // so there was nothing to clean up in the first place.
      rmSync(join(repoRoot, "coverage", "raw-shards"), { recursive: true, force: true });
    },
  };
}

test("coverage entry runs CI's four shard selectors, then merges the shard raw coverage into the lcov consumed by both gates", () => {
  const fixtureRoot = coverageFixtureRoot();
  const { calls, spawn, cleanup } = coverageSpawn(fixtureRoot);
  try {
    const result = runCiParity(fixtureRoot, { spawn });

    const selectorCalls = calls.filter((c) => selectorShardNumber(c.args) !== undefined);
    assert.deepEqual(
      selectorCalls.map((c) => c.args[c.args.indexOf("--shard") + 1]).sort(),
      ["1/4", "2/4", "3/4", "4/4"],
    );
    const shardCalls = calls.filter((c) => shardNumber(c.args) !== undefined);
    assert.deepEqual(shardCalls.map((c) => c.args.find((a) => a.startsWith("test/coverage-shard-"))).sort(), [
      "test/coverage-shard-1.test.ts",
      "test/coverage-shard-2.test.ts",
      "test/coverage-shard-3.test.ts",
      "test/coverage-shard-4.test.ts",
    ]);
    for (const call of shardCalls) {
      assert.equal(call.file, process.execPath, "each coverage shard shells node directly, as ci.yml does");
      assert.equal(call.args.includes(join(REPO_ROOT, "scripts", "test-with-retry.mjs")), false, "coverage shards do not use ci's retry wrapper");
      assert.equal(call.args.some((arg) => arg.startsWith("--test-shard=")), false, "coverage shards receive duration-balanced file lists, not Node's opaque shard assignment");
      assert.ok(call.opts?.env?.NODE_V8_COVERAGE?.includes("coverage/raw-shards/shard-"), "each shard writes raw coverage to its own artifact directory");
    }

    const mergeIndex = calls.findIndex((c) => c.args.some((a) => a.endsWith("coverage-merge-ratchet.mjs")));
    assert.ok(mergeIndex >= 0, "the coverage entry must invoke the existing merge script");
    const merge = calls[mergeIndex]!;
    assert.equal(merge.args[0], "--expose-internals");
    assert.deepEqual(merge.args.slice(2, 4), ["--output", join(fixtureRoot, "coverage", "lcov.info")]);
    assert.equal(merge.args.slice(4).length, CI_COVERAGE_SHARD_COUNT, "all four raw shard directories must be merge inputs");

    const ratchetIndex = calls.findIndex((c) => c.args.some((a) => a.endsWith("coverage-ratchet.mjs")));
    const diffIndex = calls.findIndex((c) => c.args.some((a) => a.endsWith("diff-coverage.mjs")));
    assert.ok(ratchetIndex > mergeIndex, "coverage-ratchet must consume the merged lcov, not a per-shard lcov");
    assert.ok(diffIndex > mergeIndex, "diff-coverage must consume the merged lcov, not a per-shard lcov");
    assert.ok(result.steps.find((s) => s.name === "coverage-ratchet:test-with-coverage")?.ok);
  } finally {
    cleanup();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("coverage entry refuses a partial shard artifact set before merge or coverage gates can report a number", () => {
  const fixtureRoot = coverageFixtureRoot();
  const { calls, spawn, cleanup } = coverageSpawn(fixtureRoot, { missingArtifactShard: 3 });
  try {
    const result = runCiParity(fixtureRoot, { spawn });
    const coverage = result.steps.find((s) => s.name === "coverage-ratchet:test-with-coverage")!;

    assert.equal(coverage.ok, false);
    assert.match(coverage.detail, /expected raw V8 coverage for shard 3/);
    assert.equal(calls.some((c) => c.args.some((a) => a.endsWith("coverage-merge-ratchet.mjs"))), false);
    assert.equal(calls.some((c) => c.args.some((a) => a.endsWith("coverage-ratchet.mjs"))), false);
    assert.equal(calls.some((c) => c.args.some((a) => a.endsWith("diff-coverage.mjs"))), false);
  } finally {
    cleanup();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("coverage entry refuses a shard with no # tests summary as unverified", () => {
  const fixtureRoot = coverageFixtureRoot();
  const { calls, spawn, cleanup } = coverageSpawn(fixtureRoot, { missingSummaryShard: 2 });
  try {
    const result = runCiParity(fixtureRoot, { spawn });
    const coverage = result.steps.find((s) => s.name === "coverage-ratchet:test-with-coverage")!;

    assert.equal(coverage.ok, false);
    assert.match(coverage.detail, /shard 2\/4 produced no # tests summary/);
    assert.equal(calls.some((c) => c.args.some((a) => a.endsWith("coverage-merge-ratchet.mjs"))), false);
  } finally {
    cleanup();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("coverage shard scheduling is CPU-bounded while the shard count stays CI's four", () => {
  assert.equal(CI_COVERAGE_SHARD_COUNT, 4);
  assert.equal(coverageShardConcurrency(8), 4);
  assert.equal(coverageShardConcurrency(4), 4);
  assert.equal(coverageShardConcurrency(2), 2);
  assert.equal(coverageShardConcurrency(1), 1);
  assert.equal(coverageShardConcurrency(0), 1);
});
