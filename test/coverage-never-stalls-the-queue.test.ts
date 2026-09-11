/**
 * test/coverage-never-stalls-the-queue.test.ts — W1-T3380.
 *
 * OPERATOR RULING 2026-09-11: "i don't want hard floors on anything, including code coverage …
 * when it drops below that threshold we fix the pr as much as we can, but then let it through and
 * kick out a priority follow up task to improve coverage. If it keeps dropping to a really low
 * threshold then we continue to kick off more tasks until its in a state we're happy with."
 *
 * TWO FLOORS STOOD BETWEEN THAT RULING AND THE GATE:
 *   (i)  `classifyCoverageTier`'s deepest band returned `blocking: true`, so branches under 85%
 *        failed the build instead of landing and owing work.
 *   (ii) `evaluateRatchet` enforced a LINES floor of 95.62 against a real ~98.32-98.37% — a floor
 *        that could not fail, guarded nothing, and was a floor.
 *
 * WHAT THIS PINS, AND THE OBJECTION IT ANSWERS. A gate that never blocks is usually a gate that
 * asserts nothing, which is the failure CLAUDE.md names outright. This suite proves the
 * distinction the change actually makes: coverage LEVEL no longer blocks, and measurement
 * INTEGRITY still does. A baseline declaring a floor it cannot compare still throws; a run that
 * cannot be measured is still red.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// @ts-expect-error — a plain .mjs instrument outside tsconfig's include, imported for its pure exports.
import { classifyCoverageTier, evaluateRatchet } from "../scripts/coverage-ratchet.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/coverage-baseline.json"), "utf8")) as Record<string, unknown>;

test("W1-T3380: branches far below the block cut PASS — the deepest band owes work, it does not stall the queue", () => {
  const tier = classifyCoverageTier({ branchesPct: 61.4 }, BASELINE);
  assert.equal(tier.tier, "remediate", "the band is still NAMED, so severity is still observable");
  assert.equal(tier.blocking, false, "a PR must land and owe work, never be parked alongside the debt");
  assert.match(tier.message, /escalating improvement tasks/, "the message must say what happens instead of blocking");
});

test("W1-T3380: every band is non-blocking — no coverage LEVEL fails the build", () => {
  for (const branchesPct of [99.9, 92, 90, 87.5, 85, 84.9, 40, 0]) {
    assert.equal(
      classifyCoverageTier({ branchesPct }, BASELINE).blocking,
      false,
      `branches ${branchesPct}% must not block`,
    );
  }
});

test("W1-T3380: the three bands still DISCRIMINATE, so severity can drive how much work is filed", () => {
  assert.equal(classifyCoverageTier({ branchesPct: 95 }, BASELINE).tier, "healthy");
  assert.equal(classifyCoverageTier({ branchesPct: 87 }, BASELINE).tier, "improve");
  assert.equal(classifyCoverageTier({ branchesPct: 70 }, BASELINE).tier, "remediate");
});

test("W1-T3380: the shipped baseline declares NO lines floor", () => {
  assert.equal(BASELINE.linesPct, undefined, "a retired floor must be absent, not set to 0 or left stale");
  assert.equal(evaluateRatchet({ linesPct: 12.5, branchesPct: 99 }, BASELINE).length, 0,
    "with no floor recorded, even catastrophic lines coverage is not a ratchet violation");
});

test("W1-T3380: MEASUREMENT INTEGRITY STILL BLOCKS — a floor that cannot be compared is still refused", () => {
  assert.throws(
    () => evaluateRatchet({ linesPct: 98, branchesPct: 91 }, { linesPct: "95.62" }),
    /must be a number/,
    "a hand-edited baseline that quotes its floor is a config defect and must still fail loudly",
  );
});
