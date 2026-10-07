import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { coveragePrecheck, FixRoundPushError, pushFixRoundPrechecked, type CoveragePrecheckPorts } from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";
import { usePassThroughProofSandbox } from "./helpers/pass-through-proof-sandbox.js";

usePassThroughProofSandbox();

// Exercise the shipped runner, CI flags, source-mapped LCOV, committed diff and local push.
// Only the tiny fixture's selector/manifest are supplied; no coverage result is injected.
function fixture() {
  const origin = gitRepo({ bare: true, kind: "real-coverage-origin" });
  const repo = gitRepo({ cloneFrom: origin.dir, kind: "real-coverage-candidate" });
  const branch = "run-T-REAL-COVERAGE-1";
  const suite = "test/feature.test.ts";
  const put = (path: string, content: string) => {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), content);
  };
  for (const path of [
    "scripts/diff-coverage-local.mjs", "scripts/diff-coverage.mjs", "scripts/lib/argv.mjs",
    "scripts/lib/git.mjs", "scripts/lib/repo-root.mjs", "scripts/lib/lcov.mjs", ".github/workflows/ci.yml",
    // W1-T5923: ci.yml's coverage invocation names the duration reporter, so the fixture needs it.
    "scripts/test-duration-reporter.mjs",
  ]) {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    copyFileSync(join(process.cwd(), path), join(repo.dir, path));
  }
  // Use the real setup guards and exact installed dependencies, including child-process fences.
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  symlinkSync(join(process.cwd(), "test/setup"), join(repo.dir, "test/setup"), "dir");
  symlinkSync(join(process.cwd(), "node_modules"), join(repo.dir, "node_modules"), "dir");
  put("package.json", '{"type":"module"}\n');
  put(".gitignore", "node_modules/\ncoverage/\nhook.log\n");
  put("src/feature.ts", "export function normalize(n: number): number {\n  return n;\n}\n");
  const testSource = (negative: boolean) => [
    'import assert from "node:assert/strict";', 'import { test } from "node:test";',
    'import { normalize } from "../src/feature.ts";', 'test("normalization", () => {',
    "  assert.equal(normalize(1), 1);", ...(negative ? ["  assert.equal(normalize(-1), 1);"] : []), "});", "",
  ].join("\n");
  put(suite, testSource(false));
  const commit = (message: string) => {
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", message);
    return repo.git("rev-parse", "HEAD");
  };
  commit("seed the actual coverage pipeline");
  repo.git("push", "-q", "origin", "main");
  repo.git("checkout", "-q", "-b", branch);
  const hookLog = join(repo.dir, "hook.log");
  // W1-T6106: a host push runs only the HARNESS's pre-push, for a repo whose config enables hooks.
  const hooksDir = join(repo.dir, ".git", "harness-hooks");
  mkdirSync(hooksDir, { recursive: true });
  repo.git("config", "core.hooksPath", hooksDir);
  process.env.RMD_HARNESS_HOOKS_DIR = hooksDir;
  const hook = join(hooksDir, "pre-push");
  writeFileSync(hook, `#!/bin/sh\nwhile read -r _lref sha _rref _rsha; do\n  printf '%s\\n' "$sha" >> '${hookLog}'\ndone\n`);
  chmodSync(hook, 0o755);
  put("src/feature.ts", "export function normalize(n: number): number {\n  if (n < 0) {\n    return -n;\n  }\n  return n;\n}\n");
  const uncoveredHead = commit("add an initially untested negative path");
  const ports: CoveragePrecheckPorts = {
    select: () => ({ suites: [suite], fullRun: false, reasons: [], recentOnly: { floor: [] } }),
    manifest: () => ({ thresholdMs: 10_000, files: { [suite]: 1_000 } }),
  };
  return {
    repo, branch, uncoveredHead, ports, hookLog,
    repair: () => { put(suite, testSource(true)); return commit("cover the negative path"); },
    cleanup: () => { repo.cleanup(); origin.cleanup(); },
  };
}

test("real coverage instrumentation refuses an uncovered committed head and pushes only its tested repair", async () => {
  const fx = fixture();
  const receipts: Array<Record<string, unknown>> = [];
  const log = (step: string, extra?: Record<string, unknown>) => receipts.push({ step, ...extra });
  try {
    await assert.rejects(
      withLiveWritesAllowed(() => pushFixRoundPrechecked(log, fx.repo.dir, fx.branch, fx.uncoveredHead, fx.ports)),
      (error: unknown) => error instanceof FixRoundPushError && /src\/feature\.ts:3/.test(error.detail),
    );
    assert.equal(fx.repo.git("ls-remote", "origin", `refs/heads/${fx.branch}`), "", "the refused head never reaches even a local origin");
    const lcov = readFileSync(join(fx.repo.dir, "coverage/precheck-lcov.info"), "utf8");
    assert.equal(lcov.split("\n").filter(line => line === "SF:src/feature.ts").length, 1, "the gate actually instrumented the changed source");
    const block = lcov.split("SF:src/feature.ts\n")[1]!.split("end_of_record")[0]!;
    assert.match(block, /^DA:3,0$/m, "the refusal comes from the target's own real zero-hit line");
    const repairedHead = fx.repair();
    await withLiveWritesAllowed(() => pushFixRoundPrechecked(log, fx.repo.dir, fx.branch, repairedHead, fx.ports));
    assert.equal(fx.repo.git("ls-remote", "origin", `refs/heads/${fx.branch}`).split(/\s/)[0], repairedHead);
    assert.deepEqual(readFileSync(fx.hookLog, "utf8").trim().split("\n"), [repairedHead], "the actual push hook never observes the uncovered head");
    assert.deepEqual(receipts.map(row => row.outcome), ["uncovered", "covered"]);
  } finally {
    fx.cleanup();
  }
});

test("a real unavailable coverage report sink stays unavailable rather than claiming coverage", async () => {
  const fx = fixture();
  try {
    fx.repair();
    mkdirSync(join(fx.repo.dir, "coverage/precheck-lcov.info"), { recursive: true });
    const result = await coveragePrecheck(fx.repo.dir, fx.ports);
    assert.equal(result.outcome, "unavailable", JSON.stringify(result));
    assert.equal(fx.repo.git("ls-remote", "origin", `refs/heads/${fx.branch}`), "");
  } finally {
    fx.cleanup();
  }
});
