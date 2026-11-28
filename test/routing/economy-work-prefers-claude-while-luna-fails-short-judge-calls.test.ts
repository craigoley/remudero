// W1-T15178: economy work (the risk, ci, fix-progress and refresh judges) prefers Claude while Claude has headroom.
// OPERATOR DECISION 2026-11-27: Luna leaves the judging lanes until W1-T15168's stderr tail names why codex exits 1
// on short economy calls. Balanced and frontier preferences are unchanged, and the auction still decides when Claude
// is below its reserve or unreadable.
import assert from "node:assert/strict";
import test from "node:test";
import { headroomPolicyFromCurve } from "#src/lib/headroom.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { loadPolicy, policyPath } from "#src/lib/policy.js";
import {
  policyForCapability,
  selectWorkerProviderForPolicy,
  type EffectiveProviderRoutingPolicy,
} from "#src/lib/provider-routing-policy.js";
import type { ProviderCapacity, ProviderHeadroomTiming } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-27T18:00:00.000Z");
/** plan/policy.yaml's own headroom curve, so the expiring-budget stand-aside (W1-T14298) is judged as the daemon judges it. */
const TIMING: ProviderHeadroomTiming = { nowMs: NOW, policy: headroomPolicyFromCurve(loadPolicy(policyPath(REPO_ROOT)).values.headroom.curve) };

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

/** One window `hours` from its reset (30 h is outside every final rung), as each provider reports it. */
function capacity(provider: "claude" | "codex", usedPercent: number, hours = 30): ProviderCapacity {
  const seconds = NOW / 1000 + hours * 3600;
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} primary`, usedPercent, resetsAt: provider === "claude" ? new Date(seconds * 1000).toISOString() : seconds }],
    ...(provider === "codex" ? { model: "gpt-6-luna", effort: "low", accountLabel: "assigned-subscription" } : {}),
  };
}

test("W1-T15178 criterion 1: the committed table prefers Claude for economy work, so a judge spawn with headroom selects Claude", () => {
  const prefs = preferences();
  assert.equal(prefs.economy, "claude");
  // Codex with far more headroom than Claude, and no window in its final rung: the old pure auction would hand Codex
  // most of it; the row does not. The budget is passed so the stand-aside is judged, not skipped.
  const capacities = [capacity("claude", 70), capacity("codex", 5)];
  const economy = policyForCapability(policy(), "economy", prefs, undefined, { capacities, timing: TIMING });
  assert.equal(economy.policy.preference, "claude");
  assert.deepEqual(economy.capabilityPreference, { capability: "economy", provider: "claude" });
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
  // W1-T14298 is unchanged for economy: with Codex in its final rung before reset, the preference stands aside and
  // Codex's expiring budget goes back to the headroom auction; 30 hours out the same reading keeps the preference.
  const expiring = policyForCapability(policy(), "economy", prefs, undefined,
    { capacities: [capacity("claude", 60), capacity("codex", 30, 6)], timing: TIMING });
  assert.deepEqual(expiring.capabilityPreference, { capability: "economy", provider: "claude", stoodAside: "expiring-budget" });
  assert.equal(expiring.policy.preference, "automatic");
  const later = policyForCapability(policy(), "economy", prefs, undefined,
    { capacities: [capacity("claude", 60), capacity("codex", 30)], timing: TIMING });
  assert.deepEqual(later.capabilityPreference, { capability: "economy", provider: "claude" });
  assert.equal(later.policy.preference, "claude");
});
