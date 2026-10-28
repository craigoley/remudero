import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectWorkerProviderForPolicy, type EffectiveProviderRoutingPolicy } from "#src/lib/provider-routing-policy.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { providerEligibility, readCodexCapacity, selectCodexModel, type CodexModelInfo, type ProviderCapacity } from "#src/lib/worker-provider.js";
import { workerSelectionAssignment } from "#src/lib/worker.js";
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
    spark: {
      limitId: "spark",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: used, windowDurationMins: 300 },
      secondary: { usedPercent: 95, windowDurationMins: 10080 },
    },
  },
});
const select = (rateLimits: unknown) => selectCodexModel([SPARK], rateLimits, CONFIG, "haiku", "low", CAPABILITIES);
const POLICY: EffectiveProviderRoutingPolicy = {
  provenance: "overridden",
  committed: {
    enabledProviders: ["claude", "codex"], preference: "automatic", reservePercent: 5,
    parks: [], codexModelPreference: null,
  },
  enabledProviders: ["claude", "codex"], routableProviders: ["claude", "codex"],
  preference: "codex", reservePercent: 5, parks: [],
};

function assignment(capacity: ProviderCapacity) {
  const capacities = [claude, capacity];
  const routed = selectWorkerProviderForPolicy(capacities, POLICY);
  return workerSelectionAssignment({
    cwd: REPO_ROOT, prompt: "work", model: "haiku", effort: "low",
    permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings", "worker.json"),
  }, {
    provider: routed.selection.provider, model: "claude-haiku-4-5", effort: "low",
    capacity: routed.selection.capacity, capacities, mode: "multi-provider", selectionPath: "auction",
    policy: POLICY, selection: routed.selection, preferenceBypass: routed.preferenceBypass,
  });
}

test("W1-T10383: an exhausted codex capacity reads below-reserve in considered", () => {
  const capacity = select(reading(95.5));
  assert.equal(capacity.readable, false);
  assert.equal(capacity.exhausted, true);
  assert.deepEqual(capacity.windows.map((window) => window.usedPercent), [95.5, 95]);
  const verdict = providerEligibility(capacity, 5);
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "below-reserve");
  assert.equal(verdict.headroomPercent, 4.5);
  const row = assignment(capacity);
  assert.equal(row.selected.provider, "claude");
  assert.deepEqual(row.routing.preferenceBypass, { provider: "codex", reason: "below-reserve" });
  assert.deepEqual(row.routing.decision?.considered.find((candidate) => candidate.provider === "codex"), {
    provider: "codex", model: SPARK.id, eligible: false, selected: false, reason: "below-reserve",
  });
  assert.equal(row.routing.decision?.headroomPercent.codex, 4.5);
});

test("W1-T10383: an unreadable codex probe still reads unreadable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-unreadable-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let probeCalls = 0;
  const failed = await readCodexCapacity({
    ...CONFIG, root,
    workerProviders: { ...CONFIG.workerProviders, codexBin: process.execPath, codexHome: join(root, "codex") },
  }, {
    capabilities: CAPABILITIES, forceRefresh: true, requestedModel: "haiku", requestedEffort: "low",
    spawn: () => { probeCalls += 1; throw new Error("probe spawn refused"); },
  });
  assert.equal(probeCalls, 1);
  assert.match(failed.detail ?? "", /app-server spawn failed: probe spawn refused/);
  const missing = select({});
  assert.equal(missing.exhausted, undefined);
  assert.deepEqual(providerEligibility(missing, 5), { eligible: false, reason: "unreadable", headroomPercent: null });
  const unreadable = select({ rateLimitsByLimitId: { spark: { limitId: "spark", limitName: "GPT-5.3-Codex-Spark" } } });
  assert.equal(unreadable.modelDecision?.options.find((option) => option.id === SPARK.id)?.reason, "quota-unreadable");
  for (const capacity of [failed, missing, unreadable]) {
    assert.equal(capacity.readable, false);
    assert.equal(capacity.exhausted, undefined);
    assert.deepEqual(providerEligibility(capacity, 5), { eligible: false, reason: "unreadable", headroomPercent: null });
    const row = assignment(capacity);
    assert.equal(row.selected.provider, "claude");
    assert.deepEqual(row.routing.preferenceBypass, { provider: "codex", reason: "unreadable" });
    const considered = row.routing.decision?.considered.find((candidate) => candidate.provider === "codex");
    assert.ok(considered);
    assert.equal(considered.eligible, false);
    assert.equal(considered.selected, false);
    assert.equal(considered.reason, "unreadable");
    assert.equal(row.routing.decision?.headroomPercent.codex, null);
  }
  const absent = selectWorkerProviderForPolicy([claude], POLICY);
  assert.equal(absent.preferenceBypass?.reason, "unreadable");
});
