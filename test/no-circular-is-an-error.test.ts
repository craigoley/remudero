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
// in the same file.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ORIENTATION_DOC, isInPlanScope, outOfPlanScopeFiles } from "../src/lib/plan-scope.js";
import { utcDayWindowMs, utcWeekWindowMs } from "../src/lib/time-window.js";
import { DEFAULT_POLL_INTERVAL_MS } from "../src/lib/poll-interval.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPCRUISE_BIN = join(REPO_ROOT, "node_modules", ".bin", "depcruise");
const CONFIG_PATH = join(REPO_ROOT, ".dependency-cruiser.cjs");

// Every module that sat on one of the thirteen rings this task cut (import specifiers, as they'd
// appear in a `from "./<name>.js"` clause) — the leaves below must import NONE of these.
const FORMER_RING_MODULES = [
  "review",
  "plan-architect",
  "status",
  "worker",
  "worker-home",
  "sweep",
  "retro",
  "cost-anomaly",
  "escalate",
  "feedback",
  "feedback-landing",
  "risk-judge",
  "plan-pr-emitter",
  "daemon",
  "daemon-health",
  "board",
  "status-board",
  "task-card",
];

/** Every local (`./x.js`) import specifier a source file's text declares, basename only. */
function localImportSpecifiers(sourceText: string): string[] {
  return [...sourceText.matchAll(/from\s+["']\.\/([^"'.]+)\.js["']/g)].map((m) => m[1]);
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

test("PROPERTY the repo's shipped tree — carrying zero cycles as of W1-T2895 — passes the same real depcruise gate", () => {
  const result = spawnSync(DEPCRUISE_BIN, ["src", "--config", CONFIG_PATH], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, `the shipped tree must pass its own now-error gate:\n${result.stdout}${result.stderr}`);
});

test("PROPERTY plan-scope.ts calls through and imports nothing from the ring it cut (isInPlanScope, review.ts -> plan-architect.ts)", () => {
  assert.equal(isInPlanScope("MASTER-PLAN.md"), true);
  assert.equal(isInPlanScope(ORIENTATION_DOC), true);
  assert.equal(isInPlanScope("plan/tasks.d/x.yaml"), true);
  assert.equal(isInPlanScope("src/lib/review.ts"), false);
  assert.deepEqual(outOfPlanScopeFiles(["plan/x.yaml", "src/lib/review.ts", "MASTER-PLAN.md"]), ["src/lib/review.ts"]);

  const source = readFileSync(join(REPO_ROOT, "src", "lib", "plan-scope.ts"), "utf8");
  const imported = localImportSpecifiers(source);
  assert.deepEqual(imported.filter((m) => FORMER_RING_MODULES.includes(m)), [], `plan-scope.ts must import nothing from the ring it cut; saw [${imported.join(", ")}]`);
});

test("PROPERTY time-window.ts calls through and imports nothing from the ring it cut (utcWeekWindowMs, retro.ts -> sweep.ts)", () => {
  const NOW = Date.parse("2026-09-10T15:30:00.000Z"); // a Thursday
  const [dayStart, dayEnd] = utcDayWindowMs(NOW);
  assert.equal(new Date(dayStart).toISOString(), "2026-09-10T00:00:00.000Z");
  assert.equal(dayEnd - dayStart, 24 * 60 * 60 * 1000);
  const [weekStart, weekEnd] = utcWeekWindowMs(NOW);
  assert.equal(new Date(weekStart).toISOString(), "2026-09-07T00:00:00.000Z", "the ISO week starts Monday");
  assert.equal(weekEnd - weekStart, 7 * 24 * 60 * 60 * 1000);

  const source = readFileSync(join(REPO_ROOT, "src", "lib", "time-window.ts"), "utf8");
  const imported = localImportSpecifiers(source);
  assert.deepEqual(imported.filter((m) => FORMER_RING_MODULES.includes(m)), [], `time-window.ts must import nothing from the ring it cut; saw [${imported.join(", ")}]`);
});

test("PROPERTY poll-interval.ts calls through and imports nothing from the ring it cut (DEFAULT_POLL_INTERVAL_MS, daemon-health.ts -> daemon.ts)", () => {
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 60_000);

  const source = readFileSync(join(REPO_ROOT, "src", "lib", "poll-interval.ts"), "utf8");
  const imported = localImportSpecifiers(source);
  assert.deepEqual(imported.filter((m) => FORMER_RING_MODULES.includes(m)), [], `poll-interval.ts must import nothing from the ring it cut; saw [${imported.join(", ")}]`);
});

test("PROPERTY the ceiling this task ratcheted down is zero, and no-circular is error", () => {
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "cycle-baseline.json"), "utf8"));
  assert.equal(baseline.maxCycles, 0);
  const config = readFileSync(CONFIG_PATH, "utf8");
  const at = config.indexOf('name: "no-circular"');
  assert.ok(at > 0, "sanity: the rule must still be named in the config");
  assert.match(config.slice(at - 700, at + 200), /severity:\s*"error"/);
});
