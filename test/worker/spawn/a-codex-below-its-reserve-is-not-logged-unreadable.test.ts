import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { selectWorkerProviderForPolicy, type EffectiveProviderRoutingPolicy } from "#src/lib/provider-routing-policy.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { providerEligibility, selectCodexModel, type CodexModelInfo, type ProviderCapacity } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const CAPABILITIES = loadMounts(mountsPath(REPO_ROOT)).capabilities!;
const CONFIG = { claudeBin: "/unused", root: REPO_ROOT, workerProviders: { enabled: ["codex" as const], reservePercent: 5 } };
const SPARK: CodexModelInfo = {
  id: "gpt-5.3-codex-spark",
  displayName: "GPT-5.3-Codex-Spark",
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};
const claude: ProviderCapacity = { provider: "claude", readable: true, windows: [{ name: "5h", usedPercent: 10 }] };

const reading = (used: number) => ({
  rateLimitsByLimitId: {
    spark: { limitId: "spark", limitName: "GPT-5.3-Codex-Spark", primary: { usedPercent: used, windowDurationMins: 300 } },
  },
});
const select = (rateLimits: unknown) => selectCodexModel([SPARK], rateLimits, CONFIG, "haiku", "low", CAPABILITIES);
const policy = (preference: "codex"): EffectiveProviderRoutingPolicy =>
  ({ preference, routableProviders: ["claude", "codex"], reservePercent: 5 }) as unknown as EffectiveProviderRoutingPolicy;

test("W1-T10383: an exhausted codex capacity reads below-reserve in considered", () => {
  const capacity = select(reading(95.5));
  assert.equal(capacity.readable, false);
  assert.equal(capacity.exhausted, true);
  const verdict = providerEligibility(capacity, 5);
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "below-reserve");
  assert.equal(verdict.headroomPercent, 4.5);
  const routed = selectWorkerProviderForPolicy([claude, capacity], policy("codex"));
  assert.equal(routed.preferenceBypass?.reason, "below-reserve");
});

test("W1-T10383: an unreadable codex probe still reads unreadable", () => {
  const missing = select({});
  assert.equal(missing.exhausted, undefined);
  assert.deepEqual(providerEligibility(missing, 5), { eligible: false, reason: "unreadable", headroomPercent: null });
  const unreadable = select({ rateLimitsByLimitId: { spark: { limitId: "spark", limitName: "GPT-5.3-Codex-Spark" } } });
  assert.equal(providerEligibility(unreadable, 5).reason, "unreadable");
  assert.equal(selectWorkerProviderForPolicy([claude, unreadable], policy("codex")).preferenceBypass?.reason, "unreadable");
  const absent = selectWorkerProviderForPolicy([claude], policy("codex"));
  assert.equal(absent.preferenceBypass?.reason, "unreadable");
});
