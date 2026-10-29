import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { selectWorkerProviderForPolicy, type EffectiveProviderRoutingPolicy } from "#src/lib/provider-routing-policy.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import {
  ProviderCapacityBlockedError,
  clearCodexCapacityCache,
  codexCapacityFromRateLimits,
  parseResetCredits,
  providerEligibility,
  readCodexCapacity,
  selectCodexModel,
  selectWorkerProvider,
  type CodexModelInfo,
  type ProviderCapacity,
} from "#src/lib/worker-provider.js";
import { auctionDrawSeed, workerSelectionAssignment } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// The 2026-10-21T22:06Z rollout: the weekly window at 95% against a 5% reserve, with 63581.78
// prepaid credits on the same bucket. `credits` is spelled as the installed app-server's own
// generated `CreditsSnapshot` (`codex app-server generate-ts`): hasCredits, unlimited, balance.
const CAPABILITIES = loadMounts(mountsPath(REPO_ROOT)).capabilities!;
const CONFIG = { claudeBin: "/unused", root: REPO_ROOT, workerProviders: { enabled: ["claude" as const, "codex" as const], reservePercent: 5 } };
const SPARK: CodexModelInfo = {
  id: "gpt-5.3-codex-spark",
  displayName: "GPT-5.3-Codex-Spark",
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};
const BALANCE = "63581.7845140000";
const CREDITS = { hasCredits: true, unlimited: false, balance: BALANCE };
const claudeFull: ProviderCapacity = { provider: "claude", readable: true, windows: [{ name: "7d", usedPercent: 99 }] };
const claudeHealthy: ProviderCapacity = { provider: "claude", readable: true, windows: [{ name: "5h", usedPercent: 10 }] };

const bucket = (extra: Record<string, unknown>) => ({
  limitId: "codex",
  primary: { usedPercent: 95, windowDurationMins: 10080 },
  ...extra,
});
const reading = (extra: Record<string, unknown>) => ({ rateLimitsByLimitId: { codex: bucket(extra) } });
const select = (rateLimits: unknown) => selectCodexModel([SPARK], rateLimits, CONFIG, "haiku", "low", CAPABILITIES);
/** A stdio app-server stand-in: answers initialize, rateLimits and model/list, and records every method asked. */
function fakeAppServer(rateLimits: unknown, models: CodexModelInfo[], methods: string[]) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      if (!line) continue;
      const request = JSON.parse(line) as { id?: number; method?: string };
      if (request.method) methods.push(request.method);
      const result = request.id === 1 ? {} : request.id === 2 ? rateLimits : request.id === 3 ? { data: models, nextCursor: null } : undefined;
      if (result !== undefined) stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  return proc;
}

const AUTOMATIC: EffectiveProviderRoutingPolicy = {
  provenance: "default",
  committed: {
    enabledProviders: ["claude", "codex"], preference: "automatic", reservePercent: 5,
    parks: [], codexModelPreference: null,
  },
  enabledProviders: ["claude", "codex"], routableProviders: ["claude", "codex"],
  preference: "automatic", reservePercent: 5, parks: [],
};

test("W1-T10382: codex past its reserve with credits is routed as the credits lane before cash", () => {
  const capacity = select(reading({ credits: CREDITS }));
  assert.equal(capacity.readable, true, "a credits-carried model is selected, not refused as exhausted");
  assert.equal(capacity.exhausted, undefined);
  assert.equal(capacity.model, SPARK.id);
  assert.deepEqual(capacity.credits, { hasCredits: true, unlimited: false, balance: 63581.784514 });
  assert.equal(capacity.modelDecision?.options.find((option) => option.id === SPARK.id)?.lane, "codex-credits");
  assert.deepEqual(providerEligibility(capacity, 5), { eligible: true, lane: "codex-credits", headroomPercent: 5 });

  // Claude is full: before this change the auction threw ProviderCapacityBlockedError, which is
  // exactly the condition spawnWorker's cash fallbacks run under. The credits lane carries it.
  const routed = selectWorkerProvider([claudeFull, capacity], 5, 0.999);
  assert.equal(routed.provider, "codex");
  assert.equal(routed.lane, "codex-credits");
  assert.equal(selectWorkerProviderForPolicy([claudeFull, capacity], AUTOMATIC, 0.5).selection.lane, "codex-credits");

  // Subscription headroom wins even when the operator or capability policy prefers Codex.
  for (const preference of ["automatic", "codex", "claude"] as const) {
    const policy = { ...AUTOMATIC, preference };
    for (const draw of [0, 0.5, 0.999]) {
      const label = `${preference}, draw ${draw}`;
      const healthy = selectWorkerProviderForPolicy([claudeHealthy, capacity], policy, draw);
      assert.equal(healthy.selection.provider, "claude", label);
      assert.equal(healthy.selection.lane, undefined, label);
      assert.deepEqual(healthy.preferenceBypass, preference === "codex"
        ? { provider: "codex", reason: "below-reserve" } : undefined, label);

      const credits = selectWorkerProviderForPolicy([claudeFull, capacity], policy, draw);
      assert.equal(credits.selection.provider, "codex", label);
      assert.equal(credits.selection.lane, "codex-credits", label);
    }
  }

  // Unlimited credits carry without a balance, and a plain rate-limit hit is what credits exist for.
  for (const extra of [
    { credits: { hasCredits: false, unlimited: true, balance: null } },
    { credits: CREDITS, rateLimitReachedType: "rate_limit_reached" },
  ]) {
    const carried = select(reading(extra));
    assert.equal(providerEligibility(carried, 5).lane, "codex-credits", JSON.stringify(extra));
    assert.equal(selectWorkerProvider([claudeFull, carried], 5).provider, "codex", JSON.stringify(extra));
  }

  // Control: under the reserve the subscription lane serves, with no credits label.
  const fresh = select({ rateLimitsByLimitId: { codex: { ...bucket({ credits: CREDITS }), primary: { usedPercent: 40, windowDurationMins: 10080 } } } });
  assert.deepEqual(providerEligibility(fresh, 5), { eligible: true, headroomPercent: 60 });
  const preferred = selectWorkerProviderForPolicy([claudeHealthy, fresh], { ...AUTOMATIC, preference: "codex" });
  assert.equal(preferred.selection.provider, "codex", "preference still wins between subscription lanes");
  assert.equal(preferred.selection.lane, undefined);
  assert.equal(preferred.preferenceBypass, undefined);
  const codexOnly = selectWorkerProviderForPolicy([claudeHealthy, capacity], {
    ...AUTOMATIC, preference: "codex", routableProviders: ["codex"],
  });
  assert.equal(codexOnly.selection.provider, "codex", "non-routable subscription headroom cannot bypass policy");
  assert.equal(codexOnly.selection.lane, "codex-credits");
  assert.equal(codexOnly.preferenceBypass, undefined);
});

test("W1-T10382: codex without spendable credits stays ineligible past its reserve", () => {
  // Each case names the credits reading the capacity must carry: absent or unparseable is absent,
  // an unreadable balance is `null` (never 0), and a block the credits cannot lift says why.
  const blockedCredits = (blocked: string) => ({ hasCredits: true, unlimited: false, balance: 63581.784514, blocked });
  const cases: Array<[Record<string, unknown>, unknown]> = [
    [{}, undefined],
    [{ credits: null }, undefined],
    [{ credits: { hasCredits: "yes", unlimited: false, balance: BALANCE } }, undefined],
    [{ credits: { hasCredits: false, unlimited: false, balance: null } }, { hasCredits: false, unlimited: false, balance: null }],
    [{ credits: { hasCredits: true, unlimited: false, balance: "0" } }, { hasCredits: true, unlimited: false, balance: 0 }],
    [{ credits: { hasCredits: true, unlimited: false, balance: "0.0000000000" } }, { hasCredits: true, unlimited: false, balance: 0 }],
    [{ credits: { hasCredits: true, unlimited: false, balance: "not-a-number" } }, { hasCredits: true, unlimited: false, balance: null }],
    [{ credits: { hasCredits: true, unlimited: false, balance: "-5" } }, { hasCredits: true, unlimited: false, balance: null }],
    [{ credits: { hasCredits: true, unlimited: false, balance: "Infinity" } }, { hasCredits: true, unlimited: false, balance: null }],
    [{ credits: { hasCredits: true, unlimited: false } }, { hasCredits: true, unlimited: false, balance: null }],
    [{ credits: CREDITS, spendControlReached: true }, blockedCredits("spend-control-reached")],
    [{ credits: { hasCredits: false, unlimited: true, balance: null }, spendControlReached: true },
      { hasCredits: false, unlimited: true, balance: null, blocked: "spend-control-reached" }],
    [{ credits: CREDITS, rateLimitReachedType: "workspace_owner_credits_depleted" }, blockedCredits("workspace_owner_credits_depleted")],
    [{ credits: CREDITS, rateLimitReachedType: "workspace_member_usage_limit_reached" }, blockedCredits("workspace_member_usage_limit_reached")],
  ];
  for (const [extra, credits] of cases) {
    const label = JSON.stringify(extra);
    const capacity = select(reading(extra));
    assert.equal(capacity.readable, false, label);
    assert.equal(capacity.exhausted, true, label);
    assert.deepEqual(capacity.credits, credits, label);
    const verdict = providerEligibility(capacity, 5);
    assert.equal(verdict.eligible, false, label);
    assert.equal(verdict.reason, "below-reserve", label);
    assert.equal(verdict.lane, undefined, label);
    // No credits lane: the auction blocks, and only then does spawnWorker reach for cash.
    assert.throws(() => selectWorkerProvider([claudeFull, capacity], 5), ProviderCapacityBlockedError, label);
  }
  // Only a Codex capacity takes the credits lane: a hand-built Claude row carrying credits never borrows it.
  const borrowed: ProviderCapacity = { provider: "claude", readable: true, windows: [{ name: "7d", usedPercent: 99 }],
    credits: { hasCredits: true, unlimited: false, balance: 10 } };
  assert.equal(providerEligibility(borrowed, 5).eligible, false);
});

test("W1-T10382: a credits-lane assignment records its lane and balance", () => {
  const RESET = { availableCount: 2, credits: [{ id: "RateLimitResetCredit_secret", status: "available", expiresAt: 1790000000 }] };
  const capacity = select({ ...reading({ credits: CREDITS }), rateLimitResetCredits: RESET });
  const capacities = [claudeFull, capacity];
  const routed = selectWorkerProviderForPolicy(capacities, AUTOMATIC, 0.5);
  const row = workerSelectionAssignment({
    cwd: REPO_ROOT, prompt: "work", model: "haiku", effort: "low",
    permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings", "worker.json"),
  }, {
    provider: routed.selection.provider, model: capacity.model, effort: "low",
    capacity: routed.selection.capacity, capacities, mode: "multi-provider", selectionPath: "auction",
    policy: AUTOMATIC, selection: routed.selection,
  });
  assert.equal(row.selected.provider, "codex");
  assert.equal(row.routing.decision?.rule, "codex-credits");
  assert.deepEqual(row.routing.decision?.considered.find((entry) => entry.provider === "codex"), {
    provider: "codex", model: SPARK.id, eligible: true, selected: true, lane: "codex-credits", creditsBalance: 63581.784514,
  });
  assert.deepEqual(row.routing.decision?.considered.find((entry) => entry.provider === "claude"), {
    provider: "claude", eligible: false, selected: false, reason: "below-reserve",
  });

  // Reset credits are a different thing: readiness is still read the same way and never spent.
  // The id that `account/rateLimitResetCredit/consume` would need never reaches the assignment.
  const generic = codexCapacityFromRateLimits({ rateLimits: bucket({ credits: CREDITS }), rateLimitResetCredits: RESET });
  assert.deepEqual(generic.resetCredits, parseResetCredits(RESET));
  assert.deepEqual(generic.resetCredits, { availableCount: 2, earliestExpiresAt: 1790000000 });
  assert.equal(generic.credits?.balance, 63581.784514);
  assert.doesNotMatch(JSON.stringify(row), /RateLimitResetCredit_secret/);
});

test("W1-T10382: a live read admits the credits lane without asking the app-server to consume anything", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-credits-"));
  t.after(() => { clearCodexCapacityCache(); rmSync(root, { recursive: true, force: true }); });
  clearCodexCapacityCache();
  const methods: string[] = [];
  const RESET = { availableCount: 1, credits: [{ id: "RateLimitResetCredit_live", status: "available", expiresAt: 1790000000 }] };
  const capacity = await readCodexCapacity({
    ...CONFIG, root,
    workerProviders: { ...CONFIG.workerProviders, codexBin: process.execPath, codexHome: join(root, "codex") },
  }, {
    capabilities: CAPABILITIES, forceRefresh: true, requestedModel: "haiku", requestedEffort: "low",
    spawn: () => fakeAppServer({ ...reading({ credits: CREDITS }), rateLimitResetCredits: RESET }, [SPARK], methods) as never,
  });
  assert.equal(capacity.model, SPARK.id);
  assert.deepEqual(providerEligibility(capacity, 5), { eligible: true, lane: "codex-credits", headroomPercent: 5 });
  assert.deepEqual(methods, ["initialize", "initialized", "account/rateLimits/read", "model/list"]);
  assert.ok(!methods.some((method) => /consume/i.test(method)), "a reset credit is never spent");
  // The last-good record keeps the credits as read, so a carried reading cannot silently lose them.
  const saved = JSON.parse(readFileSync(join(root, "state", "codex-capacity-last-good.json"), "utf8")) as {
    current: { value: { rateLimits: { rateLimitsByLimitId: { codex: { credits: unknown } } } } } };
  assert.deepEqual(saved.current.value.rateLimits.rateLimitsByLimitId.codex.credits, CREDITS);
  assert.doesNotMatch(JSON.stringify(saved), /RateLimitResetCredit_live/);
});

test("W1-T10382: a credits-lane codex never enrols a routing experiment nor outranks headroom", () => {
  const sol = { provider: "codex" as const, readable: true, model: "gpt-6-sol",
    credits: { hasCredits: true, unlimited: false, balance: 10 } };
  const sonnet: ProviderCapacity = { ...claudeHealthy, model: "claude-sonnet-5-5" };
  const args = { taskId: "W1-T1", runId: "r", model: "sonnet", effort: "high", prompt: "work" };
  const policy = { preference: "automatic" as const, reservePercent: 5 };
  const healthy: ProviderCapacity = { ...sol, windows: [{ name: "7d", usedPercent: 40 }] };
  const carried: ProviderCapacity = { ...sol, windows: [{ name: "7d", usedPercent: 95 }] };
  // Control: with headroom on both arms the task enrols; on credits alone codex could never be drawn.
  assert.equal(auctionDrawSeed(args, policy, [sonnet, healthy], "balanced").unit, "task");
  assert.equal(auctionDrawSeed(args, policy, [sonnet, carried], "balanced").unit, "spawn");
  const assign = (codex: ProviderCapacity) => {
    const capacities = [sonnet, codex];
    const selection = selectWorkerProvider(capacities, 5, 0);
    return workerSelectionAssignment({
      cwd: REPO_ROOT, prompt: "work", model: "sonnet", effort: "high", taskId: "W1-T1",
      permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    }, {
      provider: selection.provider, model: selection.capacity.model, effort: "high", capacity: selection.capacity, capacities,
      mode: "multi-provider", selectionPath: "auction", policy: AUTOMATIC, selection, capability: "balanced",
    }).routing.decision;
  };
  assert.ok(assign(healthy)?.ab, "control: the healthy pair joins an experiment");
  const decision = assign(carried);
  assert.equal(decision?.rule, "headroom-auction");
  assert.equal(decision?.ab, undefined);
  assert.equal(decision?.considered.find((entry) => entry.provider === "codex")?.lane, "codex-credits");

  // Within Codex, a model with headroom is served over the one its credits carry, even when preferred.
  const LUNA: CodexModelInfo = { id: "gpt-6-luna", displayName: "GPT-6-Luna", defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }] };
  const both = { rateLimitsByLimitId: { codex: bucket({ credits: CREDITS }),
    luna: { limitId: "luna", limitName: "GPT-6-Luna", primary: { usedPercent: 30, windowDurationMins: 10080 } } } };
  const preferred = selectCodexModel([SPARK, LUNA], both, CONFIG, "haiku", "low", CAPABILITIES,
    { preferredModel: { capability: "economy", effort: "low", model: SPARK.id } });
  assert.equal(preferred.model, LUNA.id);
  assert.equal(preferred.modelDecision?.preferenceBypass, "below-reserve");
  assert.equal(preferred.modelDecision?.options.find((option) => option.id === SPARK.id)?.lane, "codex-credits");
});
