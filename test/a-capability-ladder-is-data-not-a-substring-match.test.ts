import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadMounts,
  mountsPath,
  TierInvariantError,
  validateMounts,
  type CapabilityLadder,
} from "../src/lib/mounts.js";
import {
  codexCandidatesForCapability,
  codexCapabilityForRequestedModel,
  selectCodexModel,
  type ProviderCapacity,
} from "../src/lib/worker-provider.js";
import type { CodexModelInfo } from "../src/lib/worker-provider.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * A capability ladder deliberately shaped so a substring-matching implementation would get it
 * WRONG: "haiku-legacy" contains the literal substring "haiku" but is declared "frontier", and
 * "vega" (an invented model name) carries neither "haiku" nor "opus" yet is declared "economy".
 * Any implementation still doing `.includes("haiku")` / `.includes("opus")` fails these tests;
 * only a genuine table lookup against `capabilities.claude` passes them.
 */
const LADDER: CapabilityLadder = {
  ladder: { economy: 1, balanced: 2, frontier: 3 },
  claude: {
    haiku: "economy",
    sonnet: "balanced",
    opus: "frontier",
    "claude-opus-5": "frontier",
    "haiku-legacy": "frontier", // contains "haiku" as a substring, but is NOT economy
    vega: "economy", // carries neither "haiku" nor "opus"
  },
  codex: {
    economy: { low: ["gpt-econ-lo"], medium: ["gpt-econ-med"], high: ["gpt-econ-hi"] },
    balanced: { low: ["gpt-bal-lo"], medium: ["gpt-bal-med"], high: ["gpt-bal-hi"] },
    frontier: { low: ["gpt-front-lo"], medium: ["gpt-front-med"], high: ["gpt-front-hi"] },
  },
};

const CONFIG = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] as Array<"codex"> } };

/** One visible Codex model per candidate id referenced by {@link LADDER}, each its own default. */
const VISIBLE_MODELS: CodexModelInfo[] = [
  "gpt-econ-lo", "gpt-econ-med", "gpt-econ-hi",
  "gpt-bal-lo", "gpt-bal-med", "gpt-bal-hi",
  "gpt-front-lo", "gpt-front-med", "gpt-front-hi",
].map((id) => ({ id, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }));

const NO_LIMITS = {}; // no rate-limit buckets at all — every candidate reads as unreadable, so
// `selectCodexModel` returns the FIRST ranked candidate (preference order), letting these tests
// assert exactly which candidate the table lookup preferred.

function select(requestedModel: string | undefined, requestedEffort: string | undefined, ladder = LADDER): ProviderCapacity {
  return selectCodexModel(VISIBLE_MODELS, NO_LIMITS, CONFIG, requestedModel, requestedEffort, ladder);
}

// ── Criterion 1: a mount resolves through a declared capability lookup, never a substring ──────

test("a Claude model resolves to a Codex candidate through the declared capabilities table, not a substring of its name", () => {
  // "sonnet" contains neither "haiku" nor "opus" (the two substrings the retired function
  // matched on) — it can ONLY resolve correctly via `capabilities.claude.sonnet === "balanced"`.
  assert.equal(codexCapabilityForRequestedModel(LADDER, "sonnet"), "balanced");
  assert.equal(select("sonnet", "medium").model, "gpt-bal-med");
});

test("a model name that CONTAINS 'haiku' as a substring is NOT routed by that substring — the declared capability wins", () => {
  // A substring-matching implementation would classify "haiku-legacy" as economy on sight. The
  // table declares it "frontier" instead; only a real lookup gets this right.
  assert.equal(codexCapabilityForRequestedModel(LADDER, "haiku-legacy"), "frontier");
  assert.equal(select("haiku-legacy", "medium").model, "gpt-front-med");
});

// ── Criterion 2: effort survives the provider boundary ─────────────────────────────────────────

test("effort survives the provider boundary: a sonnet/high mount and a sonnet/medium mount are NOT the same Codex request", () => {
  const medium = select("sonnet", "medium");
  const high = select("sonnet", "high");
  assert.equal(medium.model, "gpt-bal-med");
  assert.equal(high.model, "gpt-bal-hi");
  assert.notEqual(medium.model, high.model, "sonnet/medium and sonnet/high must resolve different Codex candidates");
});

test("codexCandidatesForCapability is keyed on (capability, effort), not capability alone", () => {
  assert.deepEqual(codexCandidatesForCapability(LADDER, "balanced", "low"), ["gpt-bal-lo"]);
  assert.deepEqual(codexCandidatesForCapability(LADDER, "balanced", "high"), ["gpt-bal-hi"]);
});

// ── Criterion 3: a model without the "haiku"/"opus" substrings still resolves its own capability ──

test("a model whose name carries neither 'haiku' nor 'opus' resolves to its DECLARED capability, never silently to 'balanced'", () => {
  // "vega" is an invented name with neither substring. The retired function would have fallen
  // through to "balanced" for it purely because it matched nothing; the table declares it
  // "economy" explicitly, and that declaration must win.
  assert.equal(codexCapabilityForRequestedModel(LADDER, "vega"), "economy");
  assert.equal(select("vega", "medium").model, "gpt-econ-med");
});

test("a truly undeclared model name still falls back to 'balanced' — the documented degenerate default, not a crash", () => {
  assert.equal(codexCapabilityForRequestedModel(LADDER, "some-future-model-nobody-declared"), "balanced");
});

// ── Criterion 4: adding a provider model is a data edit, no code change ────────────────────────

test("adding a Codex model to the table routes to it immediately — a data edit, no code change", () => {
  const withNewModel: CapabilityLadder = {
    ...LADDER,
    codex: {
      ...LADDER.codex,
      balanced: { ...LADDER.codex.balanced, medium: ["gpt-bal-newcomer", ...LADDER.codex.balanced.medium] },
    },
  };
  const visibleWithNewcomer: CodexModelInfo[] = [
    { id: "gpt-bal-newcomer", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
    ...VISIBLE_MODELS,
  ];
  const before = select("sonnet", "medium");
  const after = selectCodexModel(visibleWithNewcomer, NO_LIMITS, CONFIG, "sonnet", "medium", withNewModel);
  assert.equal(before.model, "gpt-bal-med");
  assert.equal(after.model, "gpt-bal-newcomer", "the newly-declared model must be preferred with no code change");
});

// ── Criterion 5: the Tier Invariant survives the generalisation to capability rank ─────────────

/** A minimal, otherwise-VALID raw table (same shape as mounts.test.ts's `goodRaw`). */
function goodRaw() {
  return {
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 60, context_budget: 150000 },
    synthesis: {
      retro: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
      triage: { model: "opus", effort: "low", max_turns: 60, context_budget: 180000 },
      inbox_draft: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    },
    routes: {
      implement: {
        low: { src: { model: "sonnet", effort: "medium", max_turns: 30, context_budget: 120000 } },
        high: { src: { model: "sonnet", effort: "high", max_turns: 50, context_budget: 180000 } },
      },
      recon: {
        low: { src: { model: "haiku", effort: "medium", max_turns: 20, context_budget: 60000 } },
      },
    },
  };
}

test("a table with NO 'capabilities' block validates exactly as before (backward compatible, purely additive)", () => {
  assert.doesNotThrow(() => validateMounts(goodRaw()));
});

test("a capability assignment that would put a worker AT the Architect's capability rank is REFUSED, even though 'tiers' alone would allow it", () => {
  const bad = goodRaw() as unknown as Record<string, any>;
  // Under `tiers` alone this table is fine: sonnet(2) < opus(3). But the capabilities block
  // below deliberately assigns "sonnet" (the worker model) to the SAME capability as "opus"
  // (the Architect's model) — a misconfiguration `tiers` cannot see at all, since it is a
  // strictly Claude-vocabulary check. Only the capability-rank generalisation (W1-T2573) catches
  // this — proof that the invariant survived the generalisation instead of being weakened by it.
  bad.capabilities = {
    ladder: { economy: 1, frontier: 2 },
    claude: { haiku: "economy", sonnet: "frontier", opus: "frontier" },
    codex: {
      economy: { low: ["m"], medium: ["m"], high: ["m"] },
      frontier: { low: ["m"], medium: ["m"], high: ["m"] },
    },
  };
  assert.throws(
    () => validateMounts(bad),
    (e: unknown) =>
      e instanceof TierInvariantError &&
      /capability/i.test((e as Error).message) &&
      /G-17/.test((e as Error).message),
    "must be a TierInvariantError naming the capability axis and citing G-17",
  );
});

test("a capability assignment that would put a worker AT the flight judge's capability rank is REFUSED (even while the Architect's own capability check still passes)", () => {
  // The Architect rides a model with its OWN top capability ("apex") so the architect-axis check
  // passes cleanly, isolating the judge-axis check: the worker and the judge share a capability
  // on THIS table even though `tiers` keeps them apart (sonnet=2 < opus=3).
  const bad = goodRaw() as unknown as Record<string, any>;
  bad.tiers = { haiku: 1, sonnet: 2, opus: 3, "claude-opus-5": 4 };
  bad.architect.model = "claude-opus-5";
  bad.judge.model = "opus";
  bad.capabilities = {
    ladder: { economy: 1, frontier: 2, apex: 3 },
    claude: { haiku: "economy", sonnet: "frontier", opus: "frontier", "claude-opus-5": "apex" },
    codex: {
      economy: { low: ["m"], medium: ["m"], high: ["m"] },
      frontier: { low: ["m"], medium: ["m"], high: ["m"] },
      apex: { low: ["m"], medium: ["m"], high: ["m"] },
    },
  };
  assert.throws(
    () => validateMounts(bad),
    (e: unknown) => e instanceof TierInvariantError && /flight judge/.test((e as Error).message),
  );
});

test("a capability assignment that keeps every worker strictly below the Architect is ACCEPTED", () => {
  const good = goodRaw() as unknown as Record<string, any>;
  good.capabilities = {
    ladder: { economy: 1, balanced: 2, frontier: 3 },
    claude: { haiku: "economy", sonnet: "balanced", opus: "frontier" },
    codex: {
      economy: { low: ["m"], medium: ["m"], high: ["m"] },
      balanced: { low: ["m"], medium: ["m"], high: ["m"] },
      frontier: { low: ["m"], medium: ["m"], high: ["m"] },
    },
  };
  assert.doesNotThrow(() => validateMounts(good));
});

test("'capabilities.claude' missing a capability for a declared 'tiers' model is REJECTED at load, once 'capabilities' is present at all", () => {
  const bad = goodRaw() as unknown as Record<string, any>;
  bad.capabilities = {
    ladder: { economy: 1, frontier: 2 },
    claude: { haiku: "economy", sonnet: "frontier" }, // "opus" (a `tiers` key) is missing
    codex: {
      economy: { low: ["m"], medium: ["m"], high: ["m"] },
      frontier: { low: ["m"], medium: ["m"], high: ["m"] },
    },
  };
  assert.throws(() => validateMounts(bad), /missing a capability for 'opus'/);
});

// ── The shipped table: the real fix landed as DATA, not just as tested code ────────────────────

test("the SHIPPED .remudero/mounts.yaml declares a capability ladder covering every 'tiers' model", () => {
  const m = loadMounts(mountsPath(REPO_ROOT));
  assert.ok(m.capabilities, "the shipped table must declare 'capabilities'");
  for (const model of Object.keys(m.tiers)) {
    assert.ok(m.capabilities!.claude[model], `capabilities.claude must cover the 'tiers' model '${model}'`);
  }
  for (const capability of Object.keys(m.capabilities!.ladder)) {
    for (const effort of Object.keys(m.efforts)) {
      const row = m.capabilities!.codex[capability]?.[effort];
      assert.ok(Array.isArray(row) && row.length > 0, `capabilities.codex.${capability}.${effort} must be a non-empty list`);
    }
  }
});

test("the SHIPPED table's real worker routes resolve a Codex tier through the capability lookup, matching the declared claude->capability map", () => {
  const m = loadMounts(mountsPath(REPO_ROOT));
  for (const [type, byRisk] of Object.entries(m.routes)) {
    for (const [risk, byClass] of Object.entries(byRisk)) {
      for (const [cls, mount] of Object.entries(byClass)) {
        const expected = m.capabilities!.claude[mount.model];
        assert.equal(
          codexCapabilityForRequestedModel(m.capabilities, mount.model),
          expected,
          `routes.${type}.${risk}.${cls} (${mount.model}) must resolve its declared capability`,
        );
      }
    }
  }
});
