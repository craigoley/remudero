import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadMounts,
  mountsPath,
  providerCapabilityForModel,
  TierInvariantError,
  validateMounts,
} from "../src/lib/mounts.js";
import { selectCodexModel, type CodexModelInfo } from "../src/lib/worker-provider.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
type ProviderDeclaration = { capability: string; efforts: string[] };

function rawRouting() {
  return {
    tiers: { "acme-nano": 1, "acme-core": 2, "acme-architect": 3 },
    capabilities: { economy: 1, balanced: 2, architect: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    provider_models: {
      claude: {
        "acme-nano": { capability: "economy", efforts: ["low", "medium", "high"] },
        "acme-core": { capability: "balanced", efforts: ["low", "medium", "high"] },
        "acme-architect": { capability: "architect", efforts: ["low", "medium", "high"] },
      } as Record<string, ProviderDeclaration>,
      codex: {
        "o4-compact": { capability: "economy", efforts: ["low"] },
        "codex-balanced-low": { capability: "balanced", efforts: ["low"] },
        "codex-balanced-high": { capability: "balanced", efforts: ["high"] },
        "codex-architect": { capability: "architect", efforts: ["high"] },
      } as Record<string, ProviderDeclaration>,
    },
    architect: { model: "acme-architect", effort: "high", max_turns: 60, context_budget: 180000 },
    judge: { model: "acme-architect", effort: "high", max_turns: 60, context_budget: 150000 },
    synthesis: {
      retro: { model: "acme-architect", effort: "high", max_turns: 60, context_budget: 180000 },
      triage: { model: "acme-architect", effort: "low", max_turns: 60, context_budget: 180000 },
      inbox_draft: { model: "acme-architect", effort: "high", max_turns: 60, context_budget: 180000 },
    },
    routes: {
      implement: {
        low: { src: { model: "acme-nano", effort: "low", max_turns: 30, context_budget: 60000 } },
        high: { src: { model: "acme-core", effort: "high", max_turns: 50, context_budget: 120000 } },
      },
    },
  };
}

const openCapacity = {
  rateLimits: { limitId: "codex", primary: { usedPercent: 10 } },
};

function visible(id: string, efforts: string[]): CodexModelInfo {
  return {
    id,
    defaultReasoningEffort: efforts[0],
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
  };
}

test("W1-T2573: a mount model resolves to Codex only through its declared provider-neutral capability", () => {
  const mounts = validateMounts(rawRouting());
  assert.equal(providerCapabilityForModel(mounts, "claude", "acme-nano", "low"), "economy");
  const selected = selectCodexModel(
    [visible("o4-compact", ["low"]), visible("codex-balanced-low", ["low"])],
    openCapacity,
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] } },
    "acme-nano",
    "low",
    mounts,
  );
  assert.equal(selected.model, "o4-compact", "the name contains neither haiku nor opus; declared capability alone routes it");
  assert.equal(selected.effort, "low");
});

test("W1-T2573: effort is part of the provider lookup, so effort-only mount changes produce different requests", () => {
  const mounts = validateMounts(rawRouting());
  const models = [visible("codex-balanced-low", ["low"]), visible("codex-balanced-high", ["high"])];
  const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] as Array<"codex"> } };
  const low = selectCodexModel(models, openCapacity, config, "acme-core", "low", mounts);
  const high = selectCodexModel(models, openCapacity, config, "acme-core", "high", mounts);
  assert.deepEqual({ model: low.model, effort: low.effort }, { model: "codex-balanced-low", effort: "low" });
  assert.deepEqual({ model: high.model, effort: high.effort }, { model: "codex-balanced-high", effort: "high" });
});

test("W1-T2573: adding an account-visible Codex model is only a routing-data edit", () => {
  const raw = rawRouting();
  raw.provider_models.codex["brand-new-codex"] = { capability: "economy", efforts: ["low"] };
  delete raw.provider_models.codex["o4-compact"];
  const selected = selectCodexModel(
    [visible("brand-new-codex", ["low"])],
    openCapacity,
    { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] } },
    "acme-nano",
    "low",
    validateMounts(raw),
  );
  assert.equal(selected.model, "brand-new-codex");
});

test("W1-T2573: provider-neutral capability rank still refuses a worker at the Architect", () => {
  const raw = rawRouting();
  raw.provider_models.claude["acme-core"].capability = "architect";
  assert.throws(() => validateMounts(raw), TierInvariantError);
});

test("W1-T2573: the shipped Codex ladder prefers Luna, Terra, and Sol for economy, balanced, and frontier", () => {
  const mounts = loadMounts(mountsPath(REPO_ROOT));
  const models = [
    visible("gpt-5.6-luna", ["low", "medium", "high"]),
    visible("gpt-5.6-terra", ["low", "medium", "high"]),
    visible("gpt-5.6-sol", ["low", "medium", "high"]),
  ];
  const config = { claudeBin: "/unused", root: REPO_ROOT, workerProviders: { enabled: ["codex"] as Array<"codex"> } };
  assert.deepEqual(
    selectCodexModel(models, openCapacity, config, "haiku", "low", mounts),
    { provider: "codex", readable: true, windows: [{ name: "codex primary", usedPercent: 10 }], model: "gpt-5.6-luna", effort: "low" },
  );
  assert.equal(selectCodexModel(models, openCapacity, config, "sonnet", "high", mounts).model, "gpt-5.6-terra");
  assert.equal(selectCodexModel(models, openCapacity, config, "claude-opus-5", "high", mounts).model, "gpt-5.6-sol");
});

test("W1-T2573: the selector contains no Claude-name substring routing", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "worker-provider.ts"), "utf8");
  assert.doesNotMatch(source, /includes\(["']haiku["']\)|includes\(["']opus["']\)/);
});
