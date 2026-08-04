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
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { runCiParity } from "../src/lib/ci-parity.js";
import { narrowNameFilteredArgs, parseWhitelistedProof } from "../src/lib/review.js";

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
  assert.deepEqual(wp!.args, ["--test", "--import", "tsx", "--import", HYGIENE, "test/foo.test.ts"]);
  assertHygienePair(wp!.args, "dialect path form");
});

test("proof executor: the dialect name-filtered form ('unit test: <title>') builds its argv with the tmp-hygiene import, BEFORE --test-name-pattern", () => {
  const wp = parseWhitelistedProof("unit test: a bare test title");
  assert.ok(wp);
  assert.ok(wp!.nameFiltered);
  assert.deepEqual(wp!.args, [
    "--test",
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
  assert.deepEqual(wp!.args, ["--test", "--import", "tsx", "--import", HYGIENE, "test/foo.test.ts"]);
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
    return { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

test("ci-parity: the coverage-ratchet full-glob test run is spawned with the tmp-hygiene import — this step does NOT route through package.json's protected scripts", () => {
  const { spawn, calls } = recordingSpawn();
  runCiParity(REPO_ROOT, { spawn });
  const coverage = calls.find((c) => c.args.includes("--experimental-test-coverage"));
  assert.ok(coverage, "expected the coverage-run invocation");
  assertHygienePair(coverage!.args, "coverage-ratchet:test-with-coverage");
});

test("ci-parity: the containment-probe test run (trigger REQUIRED) is spawned with the tmp-hygiene import", () => {
  const { spawn, calls } = recordingSpawn({
    "containment-diff-trigger.ts": { status: 0, stdout: "containment-probe: REQUIRED — touches .claude/settings.json\n" },
  });
  runCiParity(REPO_ROOT, { spawn });
  const probe = calls.find((c) => c.args.some((a) => a.includes("containment.test.ts")));
  assert.ok(probe, "expected the containment probe invocation");
  assertHygienePair(probe!.args, "containment-probe:test");
});
