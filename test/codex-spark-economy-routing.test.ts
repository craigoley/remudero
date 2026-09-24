import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import { selectCodexModel, type CodexModelInfo } from "../src/lib/worker-provider.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MOUNTS = loadMounts(mountsPath(REPO_ROOT));
const CAPABILITIES = MOUNTS.capabilities!;
const CONFIG = {
  claudeBin: "/unused",
  root: REPO_ROOT,
  workerProviders: { enabled: ["codex"] as Array<"codex">, reservePercent: 5 },
};

const SPARK: CodexModelInfo = {
  id: "gpt-5.3-codex-spark",
  displayName: "GPT-5.3-Codex-Spark",
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "medium" },
    { reasoningEffort: "high" },
    { reasoningEffort: "xhigh" },
  ],
};
const LUNA: CodexModelInfo = {
  id: "gpt-5.6-luna",
  displayName: "GPT-5.6-Luna",
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
};

function limits(sparkUsed: number, lunaUsed: number): unknown {
  return {
    rateLimitsByLimitId: {
      spark: {
        limitId: "spark",
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: sparkUsed, windowDurationMins: 300 },
      },
      luna: {
        limitId: "luna",
        limitName: "GPT-5.6-Luna",
        primary: { usedPercent: lunaUsed, windowDurationMins: 300 },
      },
    },
  };
}

function select(models: CodexModelInfo[], rateLimits: unknown) {
  return selectCodexModel(models, rateLimits, CONFIG, "haiku", "low", CAPABILITIES);
}

test("the real economy/low policy offers Spark first and Luna as its same-capability fallback", () => {
  assert.deepEqual(CAPABILITIES.codex.economy.low, [
    "gpt-5.3-codex-spark",
    "gpt-6-luna",
    "gpt-5.6-luna",
    "gpt-5.4-mini",
  ]);
});

test("an account-visible Spark with independent headroom serves an economy/low request", () => {
  const selected = select([SPARK, LUNA], limits(10, 35));
  assert.equal(selected.readable, true);
  assert.equal(selected.model, "gpt-5.3-codex-spark");
  assert.equal(selected.effort, "low");
  assert.deepEqual(selected.windows.map((window) => window.usedPercent), [10]);
});

test("an absent, unsupported, or below-reserve Spark is bypassed for eligible Luna", () => {
  assert.equal(select([LUNA], limits(10, 35)).model, "gpt-5.6-luna", "absent Spark");

  const unsupportedSpark = {
    ...SPARK,
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
  };
  assert.equal(select([unsupportedSpark, LUNA], limits(10, 35)).model, "gpt-5.6-luna", "unsupported effort");
  assert.equal(select([SPARK, LUNA], limits(96, 35)).model, "gpt-5.6-luna", "below reserve");
});

test("Spark and Luna stay in economy while balanced and frontier rows remain Sol-first", () => {
  // gpt-5.5 is being decommissioned (2026-09-14), so it remains only as a trailing frontier
  // fallback and leads no row. `frontier.low` no longer names it alone: a single-candidate row whose only model
  // stops being offered makes Codex read `readable:false`, which silently migrates that lane onto
  // Claude rather than failing loudly. Spark's economy containment below is unchanged.
  // The balanced worker can run a multi-turn chain, so its Codex ladder must not fall to Luna.
  // The exact shape below guards the 2026-09-24 operator follow-up.
  assert.deepEqual(CAPABILITIES.codex.balanced, {
    low: ["gpt-6-sol", "gpt-5.6-sol"],
    medium: ["gpt-6-sol", "gpt-5.6-sol"],
    high: ["gpt-6-sol", "gpt-5.6-sol"],
  });
  assert.deepEqual(CAPABILITIES.codex.frontier, {
    low: ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.5"],
    medium: ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.5"],
    high: ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.5"],
  });
  // A decommissioning model must never LEAD a row, and no row may be single-candidate.
  for (const rows of [CAPABILITIES.codex.balanced, CAPABILITIES.codex.frontier]) {
    for (const [effort, models] of Object.entries(rows)) {
      assert.notEqual(models[0], "gpt-5.5", `gpt-5.5 must not lead ${effort}`);
      if (models.includes("gpt-5.5")) assert.ok(models.length > 1, `${effort} needs a non-5.5 candidate`);
      // THE GAP THIS GUARD USED TO HAVE. "No row may be single-candidate" was only ENFORCED for
      // rows naming gpt-5.5, so `balanced.low: ["gpt-5.4"]` sat single-candidate and unflagged
      // until its one model stopped being offered. The rule is about the ROW, not about 5.5.
      assert.ok(models.length > 1, `${effort} is single-candidate: one withdrawn model empties it`);
    }
  }
  for (const rows of [CAPABILITIES.codex.balanced, CAPABILITIES.codex.frontier]) {
    for (const models of Object.values(rows)) assert.ok(!models.includes("gpt-5.3-codex-spark"));
  }
});
