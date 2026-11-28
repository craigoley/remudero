// W1-T15178: economy work (the risk, ci, fix-progress and refresh judges) prefers Claude while Claude has headroom.
// OPERATOR DECISION 2026-11-27: Luna leaves the judging lanes until W1-T15168's stderr tail names why codex exits 1
// on short economy calls. Balanced and frontier preferences are unchanged, and the auction still decides when Claude
// is below its reserve or unreadable.
import assert from "node:assert/strict";
import test from "node:test";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import {
  policyForCapability,
  selectWorkerProviderForPolicy,
  type EffectiveProviderRoutingPolicy,
} from "#src/lib/provider-routing-policy.js";
import type { ProviderCapacity } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-27T18:00:00.000Z");

function preferences(): Record<string, "claude" | "codex"> {
  const value = loadMounts(mountsPath(REPO_ROOT)).capabilities?.providerPreference;
  assert.ok(value, "the committed table declares capability preferences");
  return value;
}

function policy(): EffectiveProviderRoutingPolicy {
  return {
    provenance: "default",
    committed: { enabledProviders: ["claude", "codex"], preference: "automatic", reservePercent: 5, parks: [], codexModelPreference: null },
    enabledProviders: ["claude", "codex"],
    routableProviders: ["claude", "codex"],
    preference: "automatic",
    reservePercent: 5,
    parks: [],
  };
}

function capacity(provider: "claude" | "codex", usedPercent: number): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} primary`, usedPercent, resetsAt: NOW / 1000 + 30 * 3600 }],
    ...(provider === "codex" ? { model: "gpt-6-luna", effort: "low", accountLabel: "assigned-subscription" } : {}),
  };
}

test("W1-T15178 criterion 1: the committed table prefers Claude for economy work, so a judge spawn with headroom selects Claude", () => {
  const prefs = preferences();
  assert.equal(prefs.economy, "claude");
  const economy = policyForCapability(policy(), "economy", prefs);
  assert.equal(economy.policy.preference, "claude");
  assert.deepEqual(economy.capabilityPreference, { capability: "economy", provider: "claude" });
  // Codex with far more headroom than Claude: the old pure auction would hand Codex most of it; the row does not.
  const capacities = [capacity("claude", 70), capacity("codex", 5)];
  for (let tieBreaker = 0; tieBreaker < 20; tieBreaker += 1) {
    assert.equal(selectWorkerProviderForPolicy(capacities, economy.policy, tieBreaker).selection.provider, "claude");
  }
});

test("W1-T15178 criterion 2: balanced and frontier are unchanged, and economy returns to the auction when Claude cannot serve", () => {
  const prefs = preferences();
  assert.equal(prefs.balanced, "codex");
  assert.equal(prefs.frontier, "claude");
  assert.equal(policyForCapability(policy(), "balanced", prefs).policy.preference, "codex");
  assert.equal(policyForCapability(policy(), "frontier", prefs).policy.preference, "claude");
  const economy = policyForCapability(policy(), "economy", prefs).policy;
  const below = selectWorkerProviderForPolicy([capacity("claude", 97), capacity("codex", 5)], economy);
  assert.equal(below.selection.provider, "codex");
  assert.deepEqual(below.preferenceBypass, { provider: "claude", reason: "below-reserve" });
  const unreadable: ProviderCapacity = { provider: "claude", readable: false, windows: [], detail: "usage read failed" };
  const blind = selectWorkerProviderForPolicy([unreadable, capacity("codex", 5)], economy);
  assert.equal(blind.selection.provider, "codex");
});
