// test/no-circular-is-an-error.test.ts — W1-T2895.
//
// `npm run cycle-ratchet -- --print` reported thirteen tolerated import cycles, every one of
// them passing through one of six single-symbol edges (`isInPlanScope`, `ghJson`,
// `readLedgerLines`, `playwrightCacheRoot`, `utcWeekWindowMs`, `DEFAULT_POLL_INTERVAL_MS`) or one
// `import type { BoardDeps }` edge dependency-cruiser's `swc` parser counted as circular exactly
// like a value import. This task moved each of the six symbols (bar `ghJson`, whose definition
// W1-T2896 already relocated to `github-transport.ts` — this task only redirected `review.ts`'s
// import there) to a LEAF module that imports nothing from the ring it cut, and moved `BoardDeps`
// beside the `DeriveDeps` it extends in `status.ts` so `task-card.ts` never needs an `import
// type` from `board.ts`. `scripts/cycle-baseline.json`'s `maxCycles` is now 0, and
// `.dependency-cruiser.cjs`'s `no-circular` rule is `severity: "error"`.
//
// THIS SUITE PROVES THREE THINGS, matching the task's own falsifier design: (1) a NEW import
// cycle under the repo's OWN depcruise config fails the CLI's exit code rather than merely
// warning — the structural change this task made, driven for real rather than asserted from the
// config text; (2) each of the three genuinely NEW leaf modules this task created
// (`plan-scope.ts`, `time-window.ts`, `poll-interval.ts`) is exercised — called through, not just
// imported — proving the moved code still works; (3) each of those three leaves imports NOTHING
// from the ring it cut, so the cycle it closed cannot silently reopen through a different symbol
// in the same file. (3) is asserted against dependency-cruiser's OWN cruise of `src` (the exact
// tool the cycle-ratchet drives) rather than a source-text regex over the leaf files: a `depcruise
// --output-type json` dependency LIST is the tool's real, behavioural verdict on what a module
// imports, so this drives the tool rather than re-deriving its answer from a second, weaker parser.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ORIENTATION_DOC, isInPlanScope, outOfPlanScopeFiles } from "../src/lib/plan-scope.js";
import { detectInstrumentEntanglement } from "../src/lib/review.js";
import { utcDayWindowMs, utcWeekWindowMs } from "../src/lib/time-window.js";
import { DEFAULT_POLL_INTERVAL_MS } from "../src/lib/poll-interval.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPCRUISE_BIN = join(REPO_ROOT, "node_modules", ".bin", "depcruise");
const CONFIG_PATH = join(REPO_ROOT, ".dependency-cruiser.cjs");

const NEW_LEAF_MODULES = ["src/lib/plan-scope.ts", "src/lib/time-window.ts", "src/lib/poll-interval.ts"];

/** `depcruise --output-type json`'s own dependency list for `source`, per its OWN cruise of
 *  `src` — the exact graph the cycle-ratchet and the `no-circular` rule both act on, so a leaf
 *  module's claim to import nothing is checked against the tool's real verdict, not re-derived. */
function dependenciesOf(cruise: { modules: Array<{ source: string; dependencies: unknown[] }> }, source: string): unknown[] {
  const mod = cruise.modules.find((m) => m.source === source);
  assert.ok(mod, `depcruise's own cruise must include ${source}`);
  return mod.dependencies;
}

test("PROPERTY a new import cycle under the repo's own depcruise config fails rather than warns", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-no-circular-"));
  writeFileSync(join(root, "a.ts"), 'import { b } from "./b.js";\nexport const a = 1;\nexport { b };\n');
  writeFileSync(join(root, "b.ts"), 'import { a } from "./a.js";\nexport const b = 2;\nexport { a };\n');
  const result = spawnSync(DEPCRUISE_BIN, [root, "--config", CONFIG_PATH], { cwd: REPO_ROOT, encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `a planted cycle must fail depcruise's own exit code, not merely warn:\n${output}`);
  assert.match(output, /error\s+no-circular/, "the failure must be attributed to the no-circular rule, at error severity");
});

test("PROPERTY the repo's shipped tree — carrying zero cycles as of W1-T2895 — passes the same real depcruise gate, and each new leaf imports nothing", () => {
  const result = spawnSync(DEPCRUISE_BIN, ["src", "--config", CONFIG_PATH, "--output-type", "json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `the shipped tree must pass its own now-error gate:\n${result.stdout}${result.stderr}`);
  const cruise = JSON.parse(result.stdout);
  for (const source of NEW_LEAF_MODULES) {
    assert.deepEqual(dependenciesOf(cruise, source), [], `${source} must be a true leaf — it cut a cycle by importing nothing from the ring, not by depending on it more quietly`);
  }
});

test("PROPERTY plan-scope.ts calls through — the isInPlanScope edge review.ts -> plan-architect.ts closed", () => {
  assert.equal(isInPlanScope("MASTER-PLAN.md"), true);
  assert.equal(isInPlanScope(ORIENTATION_DOC), true);
  assert.equal(isInPlanScope("plan/tasks.d/x.yaml"), true);
  assert.equal(isInPlanScope("src/lib/review.ts"), false);
  assert.deepEqual(outOfPlanScopeFiles(["plan/x.yaml", "src/lib/review.ts", "MASTER-PLAN.md"]), ["src/lib/review.ts"]);
});

test("PROPERTY time-window.ts calls through — the utcWeekWindowMs edge retro.ts -> sweep.ts closed", () => {
  const NOW = Date.parse("2026-09-10T15:30:00.000Z"); // a Thursday
  const [dayStart, dayEnd] = utcDayWindowMs(NOW);
  assert.equal(new Date(dayStart).toISOString(), "2026-09-10T00:00:00.000Z");
  assert.equal(dayEnd - dayStart, 24 * 60 * 60 * 1000);
  const [weekStart, weekEnd] = utcWeekWindowMs(NOW);
  assert.equal(new Date(weekStart).toISOString(), "2026-09-07T00:00:00.000Z", "the ISO week starts Monday");
  assert.equal(weekEnd - weekStart, 7 * 24 * 60 * 60 * 1000);
});

test("PROPERTY poll-interval.ts calls through — the DEFAULT_POLL_INTERVAL_MS edge daemon-health.ts -> daemon.ts closed", () => {
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 60_000);
});

test("PROPERTY the ceiling this task ratcheted down is zero", () => {
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "cycle-baseline.json"), "utf8"));
  assert.equal(baseline.maxCycles, 0);
});

test("PROPERTY the cycle baseline can ride with the source moves it records", () => {
  const verdict = detectInstrumentEntanglement(["scripts/cycle-baseline.json", "src/lib/review.ts"]);
  assert.equal(verdict.entangled, false);
  assert.deepEqual(verdict.instrumentPaths, []);
});
