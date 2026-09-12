import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CI_PARITY_TABLE } from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const PINNED_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

function ciEntry() {
  const entry = CI_PARITY_TABLE.find((e) => e.job === "ci");
  assert.ok(entry?.mirrored && entry.run, "expected the ci parity entry to be mirrored");
  return entry;
}

function recordingSpawn(map: Record<string, { status: number | null; stdout?: string; stderr?: string; error?: string }> = {}) {
  const calls: { file: string; args: string[]; opts?: { cwd?: string; input?: string; stream?: boolean } }[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const key = [file, ...args].join(" ");
    for (const [needle, result] of Object.entries(map)) {
      if (key.includes(needle)) {
        return {
          status: result.status,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          ...(result.error ? { error: result.error } : {}),
        };
      }
    }
    if (file === "git" && args.join(" ") === "rev-parse origin/main") {
      return { status: 0, stdout: `${PINNED_BASE_SHA}\n`, stderr: "" };
    }
    if (file === "git" && args[0] === "diff") {
      return { status: 0, stdout: "docs/guide.md\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

function runCiEntry(diffClass: "PLAN_ONLY" | "DOCS_ONLY" | "SOURCE") {
  const { spawn, calls } = recordingSpawn({
    "diff-class.mjs --changed-files": { status: 0, stdout: `${diffClass}\n` },
  });
  const steps = ciEntry().run!(REPO_ROOT, spawn);
  return { calls, steps };
}

test("ci entry shells test-tier-manifest --run fast with one shard argument per CI shard", () => {
  const { calls } = runCiEntry("DOCS_ONLY");
  const shardCalls = calls.filter((c) => c.args.some((arg) => arg.endsWith("scripts/test-tier-manifest.mjs")));

  assert.equal(shardCalls.length, 4, "expected the ci parity entry to shell every CI test shard exactly once");
  assert.deepEqual(
    shardCalls.map((c) => c.args[c.args.indexOf("--shard") + 1]),
    ["1/4", "2/4", "3/4", "4/4"],
  );
  for (const call of shardCalls) {
    assert.equal(call.file, process.execPath);
    assert.ok(call.args.some((arg) => arg.endsWith("scripts/test-with-retry.mjs")), "the shard must route through test-with-retry");
    assert.ok(call.args.includes("--run"));
    assert.equal(call.args[call.args.indexOf("--run") + 1], "fast");
  }
  assert.equal(
    calls.some((c) => c.file === "npm" && c.args.join(" ") === "run test:ci"),
    false,
    "the ordinary classified path must not shell the unsharded full-suite script",
  );
});

test("ci entry reports SKIPPED on a SOURCE diff and names the W1-T3207 coverage-ratchet reason", () => {
  const { calls, steps } = runCiEntry("SOURCE");

  const ciTest = steps.find((s) => s.name === "ci:test");
  assert.ok(ciTest, "expected a named ci:test step");
  assert.equal(ciTest.ok, true);
  assert.match(ciTest.detail, /SKIPPED/);
  assert.match(ciTest.detail, /W1-T3207/);
  assert.match(ciTest.detail, /coverage-ratchet owns the single instrumented full-suite run/);
  assert.equal(
    calls.some((c) => c.args.some((arg) => arg.endsWith("scripts/test-tier-manifest.mjs"))),
    false,
    "a SOURCE-class PR diff must not run the quieter ci harness locally",
  );
});

test("ci entry falls back to the full suite when diff classification cannot be determined", () => {
  const { spawn, calls } = recordingSpawn({
    "diff-class.mjs --changed-files": { status: 1, stderr: "cannot enumerate candidates" },
  });
  const steps = ciEntry().run!(REPO_ROOT, spawn);

  const fallbackCall = calls.find((c) => c.file === "npm" && c.args.join(" ") === "run test:ci");
  assert.ok(fallbackCall, "an unreadable class must run the expensive full-suite fallback");
  const ciTest = steps.find((s) => s.name === "ci:test");
  assert.ok(ciTest, "expected the fallback to report through ci:test");
  assert.match(ciTest.detail, /FULL suite fallback/);
  assert.match(ciTest.detail, /diff class could not be determined/);
  assert.match(ciTest.detail, /cannot enumerate candidates/);
});

test("ci entry passes the resolved pinned base sha to every tier-manifest shard, never origin/main", () => {
  const { calls } = runCiEntry("PLAN_ONLY");
  const shardCalls = calls.filter((c) => c.args.some((arg) => arg.endsWith("scripts/test-tier-manifest.mjs")));

  assert.equal(shardCalls.length, 4);
  for (const call of shardCalls) {
    assert.equal(call.args[call.args.indexOf("--base") + 1], PINNED_BASE_SHA);
    assert.equal(call.args.includes("origin/main"), false);
  }
});
