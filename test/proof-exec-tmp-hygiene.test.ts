// test/proof-exec-tmp-hygiene.test.ts — the tmp-hygiene `--import` rides EVERY direct
// `node --test` argv the harness builds (proof executor + ci-parity).
//
// INCIDENT (2026-08-03, plan/feedback/fb-1785807201821-e4c9dc.yaml): the proof executor
// (`parseTestTarget`/`parseWhitelistedProof`, src/lib/review.ts) and ci-parity's two direct
// test spawns (src/lib/ci-parity.ts) built `node --test --import tsx …` WITHOUT
// `--import ./test/setup/tmp-hygiene.ts` — the reaper package.json's `test`/`test:ci`,
// scripts/check.mjs and stryker.conf.json all pass. Every proof execution and every local
// preflight therefore leaked one OS-tmpdir dir per fixture in the loaded files: 53,310
// `rmd-*` dirs, ~200/minute during a task, ENOSPC, daemon crash-loop, four dispatches killed.
//
// WHAT THIS FILE LOCKS: the PAIR `--import ./test/setup/tmp-hygiene.ts` is present, ADJACENT,
// and sorted AFTER `--import tsx` (tsx's loader is what lets node parse the .ts setup file) in
// every constructed argv — asserted on the argv itself, never on "a function ran". The
// ci-parity halves assert the args the REAL `runCiParity` table hands its spawn seam, not a
// hand-built fixture — a fixture-only assertion is exactly how the governors shipped with no
// caller (W1-T316's note), and how this leak survived three weeks of green suites.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { coverageGateLockDir, coverageScratchDir, runCiParity, testWithCoverageLeaf, type CoverageResourcePort } from "../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { narrowNameFilteredArgs, parseWhitelistedProof } from "../src/lib/review.js";
import { coverageParitySpawnResult, coverageResourceFixture } from "./helpers/coverage-parity-spawn.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HYGIENE = "./test/setup/tmp-hygiene.ts";

/** The pair must be ADJACENT (`--import` immediately followed by the hygiene path) and must
 * come AFTER `--import tsx` — node applies `--import` in order, and tsx must load first or the
 * .ts setup file is unparseable. Returns the pair's `--import` index for further ordering
 * assertions. */
function assertHygienePair(args: readonly string[], label: string): number {
  const hygieneAt = args.findIndex((a, i) => a === "--import" && args[i + 1] === HYGIENE);
  assert.notEqual(hygieneAt, -1, `${label}: argv must carry the adjacent pair --import ${HYGIENE} — got [${args.join(" ")}]`);
  const tsxAt = args.findIndex((a, i) => a === "--import" && args[i + 1] === "tsx");
  assert.notEqual(tsxAt, -1, `${label}: argv must carry --import tsx`);
  assert.ok(tsxAt < hygieneAt, `${label}: --import tsx must precede --import ${HYGIENE} (tsx parses the .ts setup file)`);
  return hygieneAt;
}

// ── the proof executor's three argv constructions (src/lib/review.ts) ────────────────────────

test("proof executor: the dialect path form ('unit test: test/<file>') builds its argv with the tmp-hygiene import", () => {
  const wp = parseWhitelistedProof("unit test: test/foo.test.ts");
  assert.ok(wp);
  assert.deepEqual(wp!.args, ["--test", "--test-reporter=tap", "--import", "tsx", "--import", HYGIENE, "test/foo.test.ts"]);
  assertHygienePair(wp!.args, "dialect path form");
});

test("proof executor: the dialect name-filtered form ('unit test: <title>') builds its argv with the tmp-hygiene import, BEFORE --test-name-pattern", () => {
  const wp = parseWhitelistedProof("unit test: a bare test title");
  assert.ok(wp);
  assert.ok(wp!.nameFiltered);
  assert.deepEqual(wp!.args, [
    "--test",
    "--test-reporter=tap",
    "--import",
    "tsx",
    "--import",
    HYGIENE,
    "--test-name-pattern",
    "a bare test title",
    "test/**/*.test.ts",
  ]);
  const hygieneAt = assertHygienePair(wp!.args, "name-filtered form");
  assert.ok(hygieneAt < wp!.args.indexOf("--test-name-pattern"), "imports must precede the name filter");
});

test("proof executor: the legacy bare-path shape (W1-T65, a test path inside prose) builds its argv with the tmp-hygiene import", () => {
  const wp = parseWhitelistedProof("run `test/foo.test.ts` and see it pass");
  assert.ok(wp);
  assert.deepEqual(wp!.args, ["--test", "--test-reporter=tap", "--import", "tsx", "--import", HYGIENE, "test/foo.test.ts"]);
  assertHygienePair(wp!.args, "legacy bare-path shape");
});

test("proof executor: narrowNameFilteredArgs PRESERVES the tmp-hygiene pair on real parse output — glob-swapping must never drop the reaper", () => {
  const wp = parseWhitelistedProof("unit test: some title resolved to one file");
  assert.ok(wp);
  const narrowed = narrowNameFilteredArgs(wp!.args, ["test/one.test.ts"]);
  assert.ok(!narrowed.includes("test/**/*.test.ts"), "narrowing must still swap out the glob");
  assertHygienePair(narrowed, "narrowed name-filtered argv");
});

// ── ci-parity's two direct `node --test` spawns (src/lib/ci-parity.ts) ───────────────────────
// Recorder duplicated locally per test/preflight-ci-parity.test.ts's own file-scoping
// convention (see its recordingSpawn comment).

function recordingSpawn(map: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { file: string; args: string[]; opts?: { cwd?: string; input?: string } }[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const key = [file, ...args].join(" ");
    for (const [needle, result] of Object.entries(map)) {
      if (key.includes(needle)) {
        return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
    }
    // W1-T3017: every diff-consuming entry now needs `origin/main` RESOLVED to a sha before it will
    // run at all — an unpinnable base refuses rather than diffing against the moving ref. Real git
    // answers this; an empty default would refuse the probe before it was ever spawned.
    if (file === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
    }
    if (file === "git" && args[0] === "diff" && !args.includes("--name-only")) {
      return { status: 0, stdout: "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n", stderr: "" };
    }
    if (file === process.execPath && args.some((arg) => arg.endsWith("scripts/test-tier-manifest.mjs")) && args.includes("--select-all")) {
      const shard = args[args.indexOf("--shard") + 1]?.match(/^([1-8])\/8$/)?.[1];
      return shard ? { status: 0, stdout: `test/coverage-shard-${shard}.test.ts\n`, stderr: "" } : { status: 1, stdout: "", stderr: "invalid selector shard" };
    }
    const coverage = coverageParitySpawnResult(file, args, opts);
    if (coverage) return coverage;
    return { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

test("ci-parity: the coverage-ratchet full-glob test run is spawned with the tmp-hygiene import — this step does NOT route through package.json's protected scripts", () => {
  const { spawn, calls } = recordingSpawn();
  const fixture = coverageResourceFixture();
  try {
    const result = runCiParity(REPO_ROOT, { spawn, coverageFreeBytes: () => 0, coverageResources: fixture.resources });
    const step = result.steps.find((s) => s.name === "coverage-ratchet:test-with-coverage");
    assert.equal(step?.ok, true, step?.detail);
    const coverage = calls.filter((c) => c.args.includes("--experimental-test-coverage"));
    assert.equal(coverage.length, 8, "expected a coverage-run invocation for every CI shard");
    for (const shard of coverage) assertHygienePair(shard.args, "coverage-ratchet:test-with-coverage");
  } finally { fixture.cleanup(); }
});

test("ci-parity: the containment-probe test run (trigger REQUIRED) is spawned with the tmp-hygiene import", () => {
  const { spawn, calls } = recordingSpawn({
    "containment-diff-trigger.ts": { status: 0, stdout: "containment-probe: REQUIRED — touches .claude/settings.json\n" },
  });
  const fixture = coverageResourceFixture();
  try {
    const result = runCiParity(REPO_ROOT, { spawn, coverageFreeBytes: () => 0, coverageResources: fixture.resources });
    const step = result.steps.find((s) => s.name === "coverage-ratchet:test-with-coverage");
    assert.equal(step?.ok, true, step?.detail);
    const probe = calls.find((c) => c.args.some((a) => a.includes("containment.test.ts")));
    assert.ok(probe, "expected the containment probe invocation");
    assertHygienePair(probe!.args, "containment-probe:test");
  } finally { fixture.cleanup(); }
});

test("parity coverage argv fixtures use supplied scratch through the real table", () => {
  const fixture = coverageResourceFixture(), recorded = recordingSpawn();
  const sibling = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}parity-unowned-`));
  writeFileSync(join(sibling, "keep"), "not this lease's bytes");
  const spawn: PreflightSpawn = (file, args, opts) => {
    if (args.includes("--experimental-test-coverage")) {
      assert.equal(opts?.env?.TMPDIR, fixture.scratchDir);
      assert.ok(opts?.env?.NODE_V8_COVERAGE?.startsWith(`${fixture.scratchDir}/raw-shards/`));
      assert.equal(existsSync(fixture.scratchDir), true);
    }
    if (args.some((a) => a.endsWith("/coverage-ratchet.mjs") || a.endsWith("/diff-coverage.mjs"))) {
      assert.equal(args[args.indexOf("--lcov") + 1], fixture.lcovPath);
      assert.equal(existsSync(dirname(fixture.lcovPath)), true, "lease lives through both artifact consumers");
    }
    return recorded.spawn(file, args, opts);
  };
  try {
    const result = runCiParity(REPO_ROOT, { spawn, coverageResources: fixture.resources, coverageFreeBytes: () => 0 });
    const steps = result.steps.filter((s) => s.name.startsWith("coverage-ratchet:"));
    assert.equal(steps.length, 4);
    assert.ok(steps.every((s) => s.ok), JSON.stringify(steps));
    const children = recorded.calls.filter((c) => c.args.includes("--experimental-test-coverage"));
    assert.equal(children.length, 8);
    for (const c of children) assertHygienePair(c.args, "real table shard");
    assert.deepEqual(fixture.events, [`acquire:${REPO_ROOT}`, ...Array(8).fill("refresh"), "release", "slot-release"]);
    assert.equal(existsSync(fixture.root), false);
    assert.equal(existsSync(join(sibling, "keep")), true);
  } finally { fixture.cleanup(); rmSync(sibling, { recursive: true, force: true }); }
});

test("parity fixture resources leave default coverage admission unchanged", () => {
  const { spawn, calls } = recordingSpawn();
  const result = testWithCoverageLeaf(REPO_ROOT, spawn, join(REPO_ROOT, "coverage", "lcov.info"), () => 0);
  assert.equal(result.ok, false);
  const scratch = coverageScratchDir(REPO_ROOT);
  if (scratch.length > 60) assert.match(result.detail, /must be outside the checkout and at most 60 characters/);
  else assert.match(result.detail, /scratch volume has 0 free bytes; need 21474836480 before starting coverage shards/);
  assert.equal(calls.length, 0);
  const table = runCiParity(REPO_ROOT, { spawn, coverageFreeBytes: () => 0 });
  const step = table.steps.find((s) => s.name === "coverage-ratchet:test-with-coverage");
  assert.equal(step?.ok, false);
  assert.equal(step?.detail, `coverage-ratchet:test-with-coverage: ${result.detail}`);
  assert.equal(calls.filter((c) => c.args.includes("--experimental-test-coverage")).length, 0);
  assert.match(coverageGateLockDir(REPO_ROOT), /^\/tmp\/rmd-c-[0-9a-f]{12}\.lock$/);
  assert.notEqual(coverageGateLockDir(REPO_ROOT), coverageGateLockDir(REPO_ROOT, "fixture"), "only an explicit discriminator changes default lock identity");
  const owned = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}parity-unreadable-`));
  try { assert.throws(() => testWithCoverageLeaf(join(owned, "never-created"), spawn, "unused"), /ENOENT/); }
  finally { rmSync(owned, { recursive: true, force: true }); }
});

test("parity fixture lease failures preserve refusal and owned cleanup", () => {
  for (const mode of ["child", "raw", "compact", "metrics", "throw"] as const) {
    const fixture = coverageResourceFixture(), recorded = recordingSpawn();
    const spawn: PreflightSpawn = (file, args, opts) => {
      if (mode === "throw" && args.includes("--experimental-test-coverage")) throw new Error("fixture transport unreadable");
      const result = recorded.spawn(file, args, opts);
      if (args.includes("--experimental-test-coverage")) {
        if (mode === "child") return { status: 7, stdout: "# tests 1\n# pass 0\n# fail 1\n", stderr: "fixture child red" };
        if (mode === "raw") rmSync(opts!.env!.NODE_V8_COVERAGE!, { recursive: true });
      }
      if (args.includes("--compact-output") && mode === "compact") rmSync(args[args.indexOf("--compact-output") + 1]!, { recursive: true });
      if (args.includes("--output") && mode === "metrics") return { status: 0, stdout: "not measured", stderr: "" };
      return result;
    };
    try {
      const result = runCiParity(REPO_ROOT, { spawn, coverageResources: fixture.resources, coverageFreeBytes: () => 0 });
      const step = result.steps.find((s) => s.name === "coverage-ratchet:test-with-coverage");
      assert.equal(step?.ok, false);
      const reasons = { child: /fixture child red/, raw: /expected raw V8 coverage for shard 1/, compact: /expected compact V8 coverage for shard 1/, metrics: /merger reported no byte measurements/, throw: /fixture transport unreadable/ };
      assert.match(step!.detail, reasons[mode]);
      assert.equal(fixture.events.filter((e) => e === "release").length, 1);
      assert.equal(existsSync(fixture.root), false);
      assert.equal(result.steps.some((s) => s.name === "coverage-ratchet:ratchet"), false);
    } finally { fixture.cleanup(); }
  }
});

test("parity fixture forwarding and hygiene imports are load-bearing", () => {
  const fixture = coverageResourceFixture(), { spawn, calls } = recordingSpawn();
  try {
    const result = runCiParity(REPO_ROOT, { spawn, coverageResources: fixture.resources, coverageFreeBytes: () => 0 });
    const step = result.steps.find((s) => s.name === "coverage-ratchet:test-with-coverage");
    assert.equal(step?.ok, true, step?.detail);
    assert.equal(fixture.events[0], `acquire:${REPO_ROOT}`, "actual dependency reaches the real table");
    const children = calls.filter((c) => c.args.includes("--experimental-test-coverage"));
    assert.equal(children.length, 8);
    for (const c of children) assertHygienePair(c.args, "actual coverage argv");
    assert.equal(existsSync(fixture.root), false);
  } finally { fixture.cleanup(); }
});

test("parity fixture acquisition failures are named and do not authorize a shard", () => {
  for (const resources of [
    () => ({ ok: false as const, detail: "FAIL — fixture lease unavailable" }),
    () => { throw new Error("fixture lease unreadable"); },
  ] satisfies CoverageResourcePort[]) {
    const { spawn, calls } = recordingSpawn();
    const result = runCiParity(REPO_ROOT, { spawn, coverageResources: resources, coverageFreeBytes: () => 0 });
    const step = result.steps.find((s) => s.name === "coverage-ratchet:test-with-coverage");
    assert.equal(step?.ok, false);
    assert.match(step!.detail, /fixture lease (unavailable|unreadable)/);
    assert.equal(calls.filter((c) => c.args.includes("--experimental-test-coverage")).length, 0);
  }
});

test("parity fixture slot refusal and refresh errors preserve NOT_RUN and release", () => {
  for (const mode of ["not-run", "refresh"] as const) {
    const fixture = coverageResourceFixture(), { spawn, calls } = recordingSpawn();
    const resources: CoverageResourcePort = (root) => {
      const acquired = fixture.resources(root);
      assert.equal(acquired.ok, true);
      if (!acquired.ok) return acquired;
      if (mode === "not-run") acquired.lease.slot.executionAllowed = false;
      else acquired.lease.slot.refresh = () => { throw new Error("fixture slot lost"); };
      return acquired;
    };
    try {
      const result = runCiParity(REPO_ROOT, { spawn, coverageResources: resources, coverageFreeBytes: () => 0 });
      const step = result.steps.find((s) => s.name === "coverage-ratchet:test-with-coverage");
      assert.equal(step?.ok, false);
      assert.match(step!.detail, mode === "not-run" ? /NOT_RUN/ : /fixture slot lost/);
      assert.equal(calls.filter((c) => c.args.includes("--experimental-test-coverage")).length, 0);
      assert.equal(fixture.events.filter((e) => e === "release").length, 1);
      assert.equal(existsSync(fixture.root), false);
    } finally { fixture.cleanup(); }
  }
});

test("parity fixture lease survives consumers and a cleanup error cannot become PASS", () => {
  for (const mode of ["ratchet", "diff", "release"] as const) {
    const fixture = coverageResourceFixture();
    const { spawn } = recordingSpawn(mode === "release" ? {} : {
      [mode === "ratchet" ? "/coverage-ratchet.mjs" : "/diff-coverage.mjs"]: { status: 9, stderr: `fixture ${mode} red` },
    });
    const resources: CoverageResourcePort = (root) => {
      const acquired = fixture.resources(root);
      if (acquired.ok && mode === "release") {
        const release = acquired.lease.release;
        acquired.lease.release = () => { release(); throw new Error("fixture release unconfirmed"); };
      }
      return acquired;
    };
    try {
      const result = runCiParity(REPO_ROOT, { spawn, coverageResources: resources, coverageFreeBytes: () => 0 });
      const step = result.steps.find((s) => s.name === (mode === "release" ? "coverage-ratchet:error" : `coverage-ratchet:${mode === "ratchet" ? "ratchet" : "diff-coverage"}`));
      assert.equal(step?.ok, false);
      assert.match(step!.detail, mode === "release" ? /fixture release unconfirmed/ : new RegExp(`fixture ${mode} red`));
      assert.equal(fixture.events.filter((e) => e === "release").length, 1);
      assert.equal(existsSync(fixture.root), false);
    } finally { fixture.cleanup(); }
  }
});
