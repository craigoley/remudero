// test/the-scarce-resource-is-the-window-not-the-notional-dollar.test.ts
//
// W1-T2577 — A ROUTER THAT OPTIMISES `cost_usd` IS OPTIMISING A NUMBER §9 ALREADY CALLS NOTIONAL.
// On subscription the dollars mount-recommender.ts (W1-T2575) compares are the API-equivalent
// price nobody is billed (§9); the resource that actually runs out is the subscription WINDOW,
// and with two providers there are now two independent windows to spend. This suite proves:
//
//   1. `routing-objective.ts`'s `routingObjectiveFor` is reached from `mount-recommender.ts`, not
//      only from this test (a grep, this task's own acceptance — also exercised here end to end).
//   2. on a subscription install the objective is window share consumed per settled task, not
//      notional dollars.
//   3. the two providers' windows are counted separately — the same underlying figures never get
//      conflated across providers, and a window-share evidence object naming the WRONG provider
//      is refused rather than silently applied.
//   4. an api-billed install selects the dollar objective instead, because there the dollars are
//      real (§9) — even when window-share evidence is present and would say otherwise.
//   5. an install that cannot read its windows falls back to the dollar objective LOUDLY (a named
//      warning, never silent) rather than optimising a proxy it cannot justify.
//   6. notional dollars remain available as the runaway tripwire and are never removed — every
//      recommendation still carries a real `costPerCompletedTaskUsd` on both arms, and the dollar
//      objective is directly requestable regardless of billing mode.
//
// PART ONE exercises `routingObjectiveFor` directly (the pure decision function). PART TWO wires
// it through `recommendMounts` (mount-recommender.ts) against hand-built `MountHeadroomCell`
// fixtures, the same structural shape test/a-routing-recommendation-is-a-proposal-never-a-live-
// mutation.test.ts already established for that module.

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMounts, type Mounts } from "../src/lib/mounts.js";
import {
  routingObjectiveFor,
  type ArmWindowShare,
  type RoutingObjectiveArm,
} from "../src/lib/routing-objective.js";
import {
  recommendMounts,
  type MountHeadroomArm,
  type MountHeadroomCell,
  type MountHeadroomComparison,
  type MountRecommendation,
  type MountRefusal,
} from "../src/lib/mount-recommender.js";

// ── PART ONE: routingObjectiveFor, exercised directly ──────────────────────────────────────

function captureWarn(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message: string) => messages.push(message), messages };
}

test("on a subscription install with a readable window, the objective is window share per completed task, not the dollar", () => {
  const { warn, messages } = captureWarn();
  const arm: RoutingObjectiveArm = {
    provider: "claude",
    costPerCompletedTaskUsd: 3.5,
    windowShare: { provider: "claude", percentConsumedPerCompletedTask: 2.25 },
  };
  const objective = routingObjectiveFor(arm, "subscription", { warn });
  assert.ok(objective);
  assert.equal(objective.kind, "window-share");
  assert.equal(objective.value, 2.25);
  assert.equal(objective.unit, "percent-per-completed-task");
  assert.equal(objective.fallbackReason, undefined, "a readable window is never a fallback");
  assert.deepEqual(messages, [], "a readable window needs no loud fallback warning");
});

test("the two providers' windows are counted separately, never conflated or summed", () => {
  const claudeArm: RoutingObjectiveArm = {
    provider: "claude",
    costPerCompletedTaskUsd: 1.2,
    windowShare: { provider: "claude", percentConsumedPerCompletedTask: 0.5 },
  };
  const codexArm: RoutingObjectiveArm = {
    provider: "codex",
    costPerCompletedTaskUsd: 1.2, // identical dollar figure — only the window differs
    windowShare: { provider: "codex", percentConsumedPerCompletedTask: 5.0 },
  };
  const claudeObjective = routingObjectiveFor(claudeArm, "subscription");
  const codexObjective = routingObjectiveFor(codexArm, "subscription");
  assert.ok(claudeObjective && codexObjective);
  assert.equal(claudeObjective.provider, "claude");
  assert.equal(codexObjective.provider, "codex");
  assert.equal(claudeObjective.value, 0.5, "claude's own window share, untouched by codex's");
  assert.equal(codexObjective.value, 5.0, "codex's own window share, untouched by claude's");
  assert.notEqual(
    claudeObjective.value,
    codexObjective.value,
    "identical notional dollars still yield DIFFERENT objectives once the two separate windows are read",
  );
});

test("window-share evidence naming a DIFFERENT provider than the arm's own is refused, not borrowed", () => {
  const { warn, messages } = captureWarn();
  const arm: RoutingObjectiveArm = {
    provider: "claude",
    costPerCompletedTaskUsd: 4.0,
    windowShare: { provider: "codex", percentConsumedPerCompletedTask: 1.0 } as ArmWindowShare,
  };
  const objective = routingObjectiveFor(arm, "subscription", { warn });
  assert.ok(objective);
  assert.equal(objective.kind, "notional-dollar", "a mismatched provider's window is never borrowed");
  assert.equal(objective.value, 4.0);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /not this arm's own provider/);
});

test("an api-billed install selects the dollar objective, even when window-share evidence is present", () => {
  const arm: RoutingObjectiveArm = {
    provider: "claude",
    costPerCompletedTaskUsd: 3.5,
    windowShare: { provider: "claude", percentConsumedPerCompletedTask: 99 }, // would dominate under subscription
  };
  const objective = routingObjectiveFor(arm, "api");
  assert.ok(objective);
  assert.equal(objective.kind, "notional-dollar", "§9: the dollars are REAL under api billing, not a proxy");
  assert.equal(objective.value, 3.5);
  assert.equal(objective.unit, "usd-per-completed-task");
});

test("an install that cannot read its window falls back to the dollar objective LOUDLY, never silently", () => {
  const { warn, messages } = captureWarn();
  const unreadable: RoutingObjectiveArm = { provider: "codex", costPerCompletedTaskUsd: 2.0 }; // no windowShare at all
  const objective = routingObjectiveFor(unreadable, "subscription", { warn });
  assert.ok(objective);
  assert.equal(objective.kind, "notional-dollar");
  assert.equal(objective.value, 2.0);
  assert.ok(objective.fallbackReason, "the fallback names WHY, never a bare code");
  assert.equal(messages.length, 1, "the fallback is reported exactly once, loudly");
  assert.match(messages[0], /no window-share evidence supplied/);
  assert.match(messages[0], /codex/);

  // A window that IS supplied but reads as null (unreadable capacity) falls back the same way.
  const { warn: warn2, messages: messages2 } = captureWarn();
  const nullWindow: RoutingObjectiveArm = {
    provider: "codex",
    costPerCompletedTaskUsd: 2.0,
    windowShare: { provider: "codex", percentConsumedPerCompletedTask: null },
  };
  const objective2 = routingObjectiveFor(nullWindow, "subscription", { warn: warn2 });
  assert.ok(objective2);
  assert.equal(objective2.kind, "notional-dollar");
  assert.equal(messages2.length, 1);
  assert.match(messages2[0], /unreadable/);
});

test("without a warn override, the fallback still reports LOUDLY via console.warn by default", () => {
  const original = console.warn;
  const seen: unknown[][] = [];
  console.warn = (...args: unknown[]) => seen.push(args);
  try {
    const objective = routingObjectiveFor({ provider: "claude", costPerCompletedTaskUsd: 1.0 }, "subscription");
    assert.ok(objective);
    assert.equal(seen.length, 1);
    assert.match(String(seen[0][0]), /\[routing-objective\]/);
  } finally {
    console.warn = original;
  }
});

test("notional dollars remain available as the runaway tripwire — always requestable, never removed", () => {
  // Under api billing, the dollar figure is the objective outright.
  const apiObjective = routingObjectiveFor({ provider: "claude", costPerCompletedTaskUsd: 7.25 }, "api");
  assert.equal(apiObjective?.value, 7.25);

  // Under subscription with no window evidence, the SAME dollar figure survives as the fallback.
  const fallbackObjective = routingObjectiveFor({ provider: "claude", costPerCompletedTaskUsd: 7.25 }, "subscription", {
    warn: () => {},
  });
  assert.equal(fallbackObjective?.value, 7.25);

  // With neither a dollar figure nor a window reading, there is genuinely nothing to minimise.
  const nothing = routingObjectiveFor({ provider: "claude", costPerCompletedTaskUsd: null }, "subscription", { warn: () => {} });
  assert.equal(nothing, undefined);
  const nothingApi = routingObjectiveFor({ provider: "claude", costPerCompletedTaskUsd: null }, "api");
  assert.equal(nothingApi, undefined);
});

// ── PART TWO: wired through mount-recommender.ts's recommendMounts ─────────────────────────

function testMounts(): Mounts {
  return validateMounts({
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
        medium: { src: { model: "sonnet", effort: "medium", max_turns: 30, context_budget: 120000 } },
      },
    },
  });
}

const CELL_KEY = "implement::medium::src";

function arm(opts: {
  armKey: string;
  provider: string;
  servedModel: string;
  n: number;
  passing: number;
  costP50: number;
  costP90: number;
  costPerCompletedTaskUsd: number;
  windowShare?: ArmWindowShare;
}): MountHeadroomArm {
  return {
    cellKey: CELL_KEY,
    armKey: opts.armKey,
    provider: opts.provider,
    servedModel: opts.servedModel,
    effort: "medium",
    n: opts.n,
    outcomes: { passing: opts.passing, blockedCi: opts.n - opts.passing, redispatched: 0 },
    costP50: opts.costP50,
    costP90: opts.costP90,
    costMax: opts.costP90,
    costPerCompletedTaskUsd: opts.costPerCompletedTaskUsd,
    ...(opts.windowShare ? { windowShare: opts.windowShare } : {}),
  };
}

function comparison(armKeyA: string, armKeyB: string, cheaperByCostPerCompletedTask: string): MountHeadroomComparison {
  return {
    cellKey: CELL_KEY,
    armKeyA,
    armKeyB,
    nA: 40,
    nB: 40,
    cheaperByCostP50: cheaperByCostPerCompletedTask,
    cheaperByCostPerCompletedTask,
    advantageHoldsUnderRedispatch: true,
    note: `${cheaperByCostPerCompletedTask} is cheaper per completed task`,
  };
}

test("routingObjectiveFor( is called from src/lib/mount-recommender.ts, not only from this test", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const src = readFileSync(join(repoRoot, "src", "lib", "mount-recommender.ts"), "utf8");
  assert.match(src, /\broutingObjectiveFor\(/, "mount-recommender.ts must call routingObjectiveFor(...) from a production rung");
});

test("a subscription install with readable, agreeing windows recommends on window share, not the raw dollar figure", () => {
  const mounts = testMounts();
  const cheap = arm({
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    n: 40,
    passing: 36,
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
    windowShare: { provider: "claude", percentConsumedPerCompletedTask: 0.4 },
  });
  const costly = arm({
    armKey: "codex::gpt-5.4::medium",
    provider: "codex",
    servedModel: "sonnet", // resolves in the tier table; a real second-provider model is out of this fixture's scope
    n: 40,
    passing: 32,
    costP50: 3.0,
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
    windowShare: { provider: "codex", percentConsumedPerCompletedTask: 4.0 },
  });
  const cell: MountHeadroomCell = {
    cellKey: CELL_KEY,
    type: "implement",
    risk: "medium",
    taskClass: "src",
    arms: [cheap, costly],
    comparisons: [comparison(cheap.armKey, costly.armKey, cheap.armKey)],
  };

  const [outcome] = recommendMounts([cell], mounts, { billingMode: "subscription", warn: () => {} });
  assert.equal(outcome.kind, "recommendation");
  const rec = outcome as MountRecommendation;
  assert.equal(rec.recommendedArm.armKey, cheap.armKey);
  assert.equal(rec.objective.kind, "window-share");
  assert.equal(rec.objective.unit, "percent-per-completed-task");
  assert.equal(rec.objective.cheaperValue, 0.4);
  assert.equal(rec.objective.costlierValue, 4.0);
  // The dollar figures are STILL carried, never stripped by the window-share objective — see the
  // "notional dollars never removed" claim below for the dedicated assertion.
  assert.equal(rec.recommendedArm.costPerCompletedTaskUsd, 1.2);
});

test("a dollar-cheaper arm that consumes MORE window share per task is refused, never recommended, on subscription", () => {
  const mounts = testMounts();
  // Cheaper in notional dollars...
  const dollarCheap = arm({
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    n: 40,
    passing: 36,
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
    windowShare: { provider: "claude", percentConsumedPerCompletedTask: 8.0 }, // ...but burns a lot of claude's window
  });
  const dollarCostly = arm({
    armKey: "codex::gpt-5.4::medium",
    provider: "codex",
    servedModel: "sonnet",
    n: 40,
    passing: 32,
    costP50: 3.0,
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
    windowShare: { provider: "codex", percentConsumedPerCompletedTask: 1.0 }, // costlier in $, but barely touches codex's window
  });
  const cell: MountHeadroomCell = {
    cellKey: CELL_KEY,
    type: "implement",
    risk: "medium",
    taskClass: "src",
    arms: [dollarCheap, dollarCostly],
    comparisons: [comparison(dollarCheap.armKey, dollarCostly.armKey, dollarCheap.armKey)],
  };

  const [outcome] = recommendMounts([cell], mounts, { billingMode: "subscription", warn: () => {} });
  assert.equal(outcome.kind, "refusal", "optimising the notional dollar here would argue against the real, scarce window");
  const refusal = outcome as MountRefusal;
  assert.equal(refusal.reason, "objective-disagreement");
  assert.match(refusal.detail, /window/);
  assert.match(refusal.detail, /notional/);
});

test("an api-billed install selects the dollar objective, even against window-share evidence that disagrees", () => {
  const mounts = testMounts();
  // Same shape as the disagreement fixture above — a dollar-cheap arm that would be refused on
  // subscription for burning more window. Under billing_mode == "api" the window is not the
  // constraint (§9) and the dollar-cheaper arm is recommended outright.
  const dollarCheap = arm({
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    n: 40,
    passing: 36,
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
    windowShare: { provider: "claude", percentConsumedPerCompletedTask: 8.0 },
  });
  const dollarCostly = arm({
    armKey: "codex::gpt-5.4::medium",
    provider: "codex",
    servedModel: "sonnet",
    n: 40,
    passing: 32,
    costP50: 3.0,
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
    windowShare: { provider: "codex", percentConsumedPerCompletedTask: 1.0 },
  });
  const cell: MountHeadroomCell = {
    cellKey: CELL_KEY,
    type: "implement",
    risk: "medium",
    taskClass: "src",
    arms: [dollarCheap, dollarCostly],
    comparisons: [comparison(dollarCheap.armKey, dollarCostly.armKey, dollarCheap.armKey)],
  };

  const [outcome] = recommendMounts([cell], mounts, { billingMode: "api" });
  assert.equal(outcome.kind, "recommendation");
  const rec = outcome as MountRecommendation;
  assert.equal(rec.recommendedArm.armKey, dollarCheap.armKey);
  assert.equal(rec.objective.kind, "notional-dollar");
  assert.equal(rec.objective.unit, "usd-per-completed-task");
});

test("a subscription install with no window evidence at all falls back to the dollar objective LOUDLY and still recommends", () => {
  const mounts = testMounts();
  const cheap = arm({
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    n: 40,
    passing: 36,
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
    // no windowShare
  });
  const costly = arm({
    armKey: "claude::sonnet::medium",
    provider: "claude",
    servedModel: "sonnet",
    n: 40,
    passing: 32,
    costP50: 3.0,
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
    // no windowShare
  });
  const cell: MountHeadroomCell = {
    cellKey: CELL_KEY,
    type: "implement",
    risk: "medium",
    taskClass: "src",
    arms: [cheap, costly],
    comparisons: [comparison(cheap.armKey, costly.armKey, cheap.armKey)],
  };

  const messages: string[] = [];
  const [outcome] = recommendMounts([cell], mounts, { billingMode: "subscription", warn: (m) => messages.push(m) });
  assert.equal(outcome.kind, "recommendation", "an unreadable window still degrades to the dollar objective, it does not block dispatch");
  const rec = outcome as MountRecommendation;
  assert.equal(rec.objective.kind, "notional-dollar");
  assert.ok(messages.length >= 1, "the fallback must be reported, never silent");
  assert.ok(
    messages.some((m) => /falling back to the notional-dollar objective/.test(m)),
    "the loud fallback names what it is doing",
  );
});

test("notional dollars remain available as the runaway tripwire and are never removed from a recommendation", () => {
  const mounts = testMounts();
  const cheap = arm({
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    n: 40,
    passing: 36,
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
    windowShare: { provider: "claude", percentConsumedPerCompletedTask: 0.4 },
  });
  const costly = arm({
    armKey: "claude::sonnet::medium",
    provider: "claude",
    servedModel: "sonnet",
    n: 40,
    passing: 32,
    costP50: 3.0,
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
    windowShare: { provider: "claude", percentConsumedPerCompletedTask: 4.0 },
  });
  const cell: MountHeadroomCell = {
    cellKey: CELL_KEY,
    type: "implement",
    risk: "medium",
    taskClass: "src",
    arms: [cheap, costly],
    comparisons: [comparison(cheap.armKey, costly.armKey, cheap.armKey)],
  };

  // Even in window-share mode, the recommendation still carries the notional-dollar figures the
  // runaway tripwire / api-mode meter (§9) needs — they are demoted, never deleted.
  const [outcome] = recommendMounts([cell], mounts, { billingMode: "subscription", warn: () => {} });
  assert.equal(outcome.kind, "recommendation");
  const rec = outcome as MountRecommendation;
  assert.equal(rec.objective.kind, "window-share");
  assert.equal(typeof rec.recommendedArm.costPerCompletedTaskUsd, "number");
  assert.equal(typeof rec.currentArm.costPerCompletedTaskUsd, "number");
  assert.equal(typeof rec.effectSizeUsd, "number");
  assert.ok(rec.effectSizeUsd > 0);
  assert.equal(typeof rec.interval.lowUsd, "number");
  assert.equal(typeof rec.interval.highUsd, "number");

  // And the same arms, read under billing_mode == "api", still yield the dollar objective
  // directly — the dollar path was never deleted, only demoted under subscription.
  const [apiOutcome] = recommendMounts([cell], mounts, { billingMode: "api" });
  assert.equal(apiOutcome.kind, "recommendation");
  assert.equal((apiOutcome as MountRecommendation).objective.kind, "notional-dollar");
});
