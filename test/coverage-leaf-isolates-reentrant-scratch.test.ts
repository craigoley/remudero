import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultPreflightSpawn, type PreflightSpawn } from "../src/lib/commit-message.js";
import { CI_PARITY_TABLE, coverageScratchDir } from "../src/lib/ci-parity.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

function coverageSpawn(
  onShardTmp: (tmp: string | undefined) => void,
  failShard = false,
): PreflightSpawn {
  return (file, args, opts) => {
    if (file === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: `${PINNED_BASE_SHA}\n`, stderr: "" };
    }
    if (args.some((arg) => arg.endsWith("scripts/test-tier-manifest.mjs")) && args.includes("--select-all")) {
      return { status: 0, stdout: "test/coverage-leaf-isolates-reentrant-scratch.test.ts\n", stderr: "" };
    }
    if (args.includes("--experimental-test-coverage")) {
      onShardTmp(opts?.env?.TMPDIR);
      return { status: failShard ? 1 : 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("nested coverage runs isolate scratch without deleting the parent TMPDIR", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "rmd-reentrant-coverage-"));
  const parentTmp = coverageScratchDir(repoRoot);
  const activeTmpAlias = join(repoRoot, "scratch-alias");
  const sentinel = join(parentTmp, "caller-fixture");
  const previousTmp = process.env.TMPDIR;
  const entry = CI_PARITY_TABLE.find((row) => row.job === "coverage-ratchet");
  assert.ok(entry?.run, "control: the coverage-ratchet job is mirrored locally");
  const invokeNested = (failShard: boolean) => {
    let nestedTmp: string | undefined;
    const spawn = coverageSpawn((tmp) => {
      assert.ok(existsSync(sentinel), "the nested coverage leaf must not erase its caller's active fixture");
      nestedTmp = tmp;
      assert.ok(nestedTmp, "each nested shard receives an isolated TMPDIR");
      assert.notEqual(nestedTmp, parentTmp, "a nested shard must not reuse its parent's live scratch");
      assert.equal(dirname(nestedTmp), realpathSync(parentTmp), "nested scratch stays under the canonical bounded sibling namespace");
      assert.ok(existsSync(nestedTmp), "the nested scratch exists while its shard runs");
    }, failShard);
    return { steps: entry!.run!(repoRoot, spawn), nestedTmp };
  };

  try {
    mkdirSync(parentTmp, { recursive: true });
    symlinkSync(parentTmp, activeTmpAlias, "dir");
    writeFileSync(sentinel, "owned by the active parent shard\n");
    process.env.TMPDIR = activeTmpAlias;

    const succeeded = invokeNested(false);
    assert.ok(succeeded.steps.find((step) => step.name === "coverage-ratchet:test-with-coverage")?.ok);
    assert.ok(existsSync(sentinel), "the parent fixture survives the complete nested coverage run");
    assert.ok(succeeded.nestedTmp, "the control reached a coverage shard");
    assert.equal(existsSync(succeeded.nestedTmp), false, "the nested invocation removes its own scratch on success");

    const failed = invokeNested(true);
    assert.equal(failed.steps.find((step) => step.name === "coverage-ratchet:test-with-coverage")?.ok, false);
    assert.ok(failed.nestedTmp, "the failing control reached a coverage shard");
    assert.notEqual(failed.nestedTmp, succeeded.nestedTmp, "each nested invocation owns a fresh scratch path");
    assert.equal(existsSync(failed.nestedTmp), false, "the nested invocation removes its scratch after a shard failure");
    assert.ok(existsSync(sentinel), "a failed nested run still preserves the parent's active fixture");
    assert.deepEqual(readdirSync(parentTmp), ["caller-fixture"], "cleanup leaves the parent's scratch contents intact");
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(parentTmp, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a top-level coverage run keeps the stable sibling TMPDIR and does not confuse a prefixed neighbor", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "rmd-top-level-coverage-"));
  const stableTmp = coverageScratchDir(repoRoot);
  const neighborTmp = `${stableTmp}-neighbor`;
  const stale = join(stableTmp, "stale-run");
  const neighbor = join(neighborTmp, "neighbor-fixture");
  const previousTmp = process.env.TMPDIR;
  let shardTmp: string | undefined;

  try {
    mkdirSync(stableTmp, { recursive: true });
    mkdirSync(neighborTmp, { recursive: true });
    writeFileSync(stale, "stale coverage scratch\n");
    writeFileSync(neighbor, "unrelated similarly-prefixed path\n");
    process.env.TMPDIR = neighborTmp;

    const entry = CI_PARITY_TABLE.find((row) => row.job === "coverage-ratchet");
    assert.ok(entry?.run, "control: the coverage-ratchet job is mirrored locally");
    const steps = entry!.run!(repoRoot, coverageSpawn((tmp) => {
      shardTmp = tmp;
      assert.equal(tmp, realpathSync(stableTmp), "a top-level shard uses the canonical stable scratch path");
      assert.equal(existsSync(stale), false, "a top-level run clears stale scratch first");
      assert.ok(existsSync(neighbor), "cleanup must not hit a path that merely shares its prefix");
    }));

    assert.ok(steps.find((step) => step.name === "coverage-ratchet:test-with-coverage")?.ok);
    assert.equal(shardTmp, realpathSync(stableTmp));
    assert.ok(existsSync(neighbor), "the unrelated neighbor remains intact after the run");
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(stableTmp, { recursive: true, force: true });
    rmSync(neighborTmp, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an unresolvable caller TMPDIR fails closed and preserves stable coverage scratch", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "rmd-unresolvable-coverage-"));
  const stableTmp = coverageScratchDir(repoRoot);
  const missingCallerTmp = join(repoRoot, "not-created-yet");
  const sentinel = join(stableTmp, "caller-fixture");
  const previousTmp = process.env.TMPDIR;
  let nestedTmp: string | undefined;

  try {
    mkdirSync(stableTmp, { recursive: true });
    writeFileSync(sentinel, "owned by the active parent shard\n");
    assert.equal(existsSync(missingCallerTmp), false, "the caller TMPDIR is deliberately unresolved before the probe");
    process.env.TMPDIR = missingCallerTmp;

    const entry = CI_PARITY_TABLE.find((row) => row.job === "coverage-ratchet");
    assert.ok(entry?.run, "control: the coverage-ratchet job is mirrored locally");
    const steps = entry!.run!(repoRoot, coverageSpawn((tmp) => {
      nestedTmp = tmp;
      assert.ok(existsSync(sentinel), "an unresolved caller TMPDIR must never authorize clearing stable scratch");
      assert.ok(nestedTmp, "the fail-closed path still gives the shard isolated scratch");
      assert.equal(dirname(nestedTmp), realpathSync(missingCallerTmp), "the isolated scratch is nested beneath the caller path once created");
      assert.ok(existsSync(nestedTmp), "nested scratch exists while its shard runs");
    }));

    const coverage = steps.find((step) => step.name === "coverage-ratchet:test-with-coverage");
    assert.ok(coverage?.ok, coverage?.detail);
    assert.ok(nestedTmp, "the fail-closed control reached a coverage shard");
    assert.equal(existsSync(nestedTmp), false, "the nested invocation removes only its own scratch");
    assert.deepEqual(readdirSync(stableTmp), ["caller-fixture"], "the unresolved path leaves parent scratch untouched");
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(stableTmp, { recursive: true, force: true });
    rmSync(missingCallerTmp, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("real coverage shards can run under nested TMPDIR without erasing the live parent fixture", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "rmd-real-reentrant-coverage-"));
  const parentTmp = coverageScratchDir(repoRoot);
  const sentinel = join(parentTmp, "caller-fixture");
  const probe = join(repoRoot, "test", "nested-coverage-probe.test.mjs");
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = parentTmp;

  const spawn: PreflightSpawn = (file, args, opts) => {
    if (file === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: `${PINNED_BASE_SHA}\n`, stderr: "" };
    }
    if (file === "git" && args[0] === "diff") {
      return { status: 0, stdout: "diff --git a/src/lib/ci-parity.ts b/src/lib/ci-parity.ts\n+fixture\n", stderr: "" };
    }
    if (file === "git") return { status: 0, stdout: "", stderr: "" };
    if (args.some((arg) => arg.endsWith("scripts/test-tier-manifest.mjs")) && args.includes("--select-all")) {
      return { status: 0, stdout: "test/nested-coverage-probe.test.mjs\n", stderr: "" };
    }
    if (args.some((arg) => arg.endsWith("coverage-merge-ratchet.mjs"))) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.includes("--experimental-test-coverage")) {
      assert.ok(existsSync(sentinel), "the parent fixture remains present before the real child starts");
      assert.notEqual(opts?.env?.TMPDIR, parentTmp, "the real child receives an isolated nested path");
      const result = defaultPreflightSpawn(file, args, {
        ...opts,
        env: { ...opts?.env, NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(sentinel), "the real coverage child does not erase its caller's fixture");
      return result;
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    mkdirSync(join(repoRoot, "test"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(repoRoot, "node_modules"), "dir");
    mkdirSync(join(repoRoot, "test", "setup"), { recursive: true });
    writeFileSync(join(repoRoot, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
    mkdirSync(parentTmp, { recursive: true });
    writeFileSync(sentinel, "owned by the active parent shard\n");
    writeFileSync(
      probe,
      [
        'import assert from "node:assert/strict";',
        'import { existsSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        'import test from "node:test";',
        'test("the real child sees its own tmp while the parent fixture survives", () => {',
        '  assert.ok(process.env.TMPDIR);',
        '  assert.ok(existsSync(join(dirname(process.env.TMPDIR), "caller-fixture")));',
        '});',
        "",
      ].join("\n"),
    );

    const entry = CI_PARITY_TABLE.find((row) => row.job === "coverage-ratchet");
    assert.ok(entry?.run, "control: the coverage-ratchet job is mirrored locally");
    const steps = entry!.run!(repoRoot, spawn);
    const coverage = steps.find((step) => step.name === "coverage-ratchet:test-with-coverage");
    assert.ok(coverage?.ok, coverage?.detail);
    assert.ok(existsSync(sentinel), "the parent fixture survives all real coverage shard processes");
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(parentTmp, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
