import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderCapacity } from "#src/lib/worker-provider.js";
import type { EffectiveProviderRoutingPolicy } from "#src/lib/provider-routing-policy.js";
import { reviewerUnavailableProvidersForReadmission } from "#src/lib/sweep.js";
import { selectWorkerProviderWithExclusions } from "#src/lib/worker.js";
import type { OpenPrView } from "#src/lib/sweep.js";

const NOW = Date.parse("2026-11-06T00:00:00.000Z");
const policy: EffectiveProviderRoutingPolicy = {
  provenance: "default",
  committed: { enabledProviders: ["claude", "codex"], preference: "automatic", reservePercent: 5,
    parks: [], codexModelPreference: null },
  enabledProviders: ["claude", "codex"], routableProviders: ["claude", "codex"],
  preference: "automatic", reservePercent: 5, parks: [],
};

function capacity(provider: "claude" | "codex", usedPercent: number): ProviderCapacity {
  return { provider, readable: true,
    windows: [{ name: `${provider} weekly`, usedPercent, resetsAt: NOW / 1000 + 3600 }] };
}

test("W1-T11432 criterion 1: the provider auction excludes an eligible provider when another is eligible", () => {
  const routed = selectWorkerProviderWithExclusions(
    [capacity("claude", 15), capacity("codex", 25)], policy, 0.5, ["claude"],
  );
  assert.equal(routed.selection.provider, "codex");
  assert.equal(routed.exclusion_unhonoured, undefined);
  assert.deepEqual(routed.excludeProviders, ["claude"]);
});

test("W1-T11432 criterion 1: with no eligible alternative the auction keeps the provider and records the unhonoured exclusion", () => {
  const routed = selectWorkerProviderWithExclusions([capacity("claude", 15)], policy, 0.5, ["claude"]);
  assert.equal(routed.selection.provider, "claude");
  assert.deepEqual(routed.exclusion_unhonoured, {
    reason: "no-eligible-alternative", excludedProviders: ["claude"],
  });
});

test("W1-T11432 criterion 2: only the provider from the matching cannot-evaluate review is excluded on re-admission", () => {
  const pr = { prNumber: 16758, prUrl: "https://github.com/acme/remudero/pull/16758",
    headSha: "a".repeat(40), taskId: "W1-T9716", reviewState: "pending" } as Pick<OpenPrView,
      "prNumber" | "prUrl" | "headSha" | "taskId" | "reviewState" | "reviewInputDigest">;
  const rows = [
    { run_id: "review-PR16758-old", task_id: "W1-T9716", step: "review.reviewer", provider: "claude", unable: 1 },
    { run_id: "review-PR16758-current", task_id: "W1-T9716", step: "review.reviewer", provider: "codex", unable: 1 },
    { run_id: "review-PR16758-current", task_id: "W1-T9716", step: "review.posted", pr_url: pr.prUrl,
      head_sha: pr.headSha, state: "pending", decision_verdict: { cannotEvaluate: true,
        criteria: [{ reviewerUnavailable: "sandbox launcher failed" }] } },
  ];
  assert.deepEqual(reviewerUnavailableProvidersForReadmission(pr, rows), ["codex"]);
  assert.equal(reviewerUnavailableProvidersForReadmission(pr, [
    ...rows.slice(0, 2), { ...rows[2]!, decision_verdict: { cannotEvaluate: true, criteria: [] } },
  ]), undefined, "missing reviewer-unavailable evidence does not exclude a provider");
  assert.equal(reviewerUnavailableProvidersForReadmission(pr, [
    ...rows.slice(0, 1), { ...rows[2]!, run_id: "review-PR16758-current" },
  ]), undefined, "a reviewer row from another attempt cannot choose the exclusion");
});
