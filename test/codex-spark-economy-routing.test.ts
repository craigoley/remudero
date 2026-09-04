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

test("Spark stays in economy and every non-economy candidate row remains unchanged", () => {
  assert.deepEqual(CAPABILITIES.codex.balanced, {
    low: ["gpt-5.4"],
    medium: ["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
    high: ["gpt-5.5", "gpt-5.6-terra", "gpt-5.4"],
  });
  assert.deepEqual(CAPABILITIES.codex.frontier, {
    low: ["gpt-5.5"],
    medium: ["gpt-5.6-sol", "gpt-5.5"],
    high: ["gpt-5.6-sol", "gpt-5.5"],
  });
  for (const rows of [CAPABILITIES.codex.balanced, CAPABILITIES.codex.frontier]) {
    for (const models of Object.values(rows)) assert.ok(!models.includes("gpt-5.3-codex-spark"));
  }
});
