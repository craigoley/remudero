// W1-T3878 acceptance: "every executable delegation carries a bounded scope, capability set, risk
// tier, budget, approval policy, expiry, and revocation reference". An incomplete profile is refused
// BY NAME, an unscoped one can never be issued, and an action outside the scope, link, or allowlist
// is refused at eligibility.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDelegationProfile,
  consoleRiskTier,
  delegationEligibility,
  delegationRevocationRef,
  DELEGATION_PROFILE_LEDGER_STEP,
  DELEGATION_PROFILE_MAX_COST_USD,
  DELEGATION_PROFILE_MAX_LIFETIME_MS,
  DELEGATION_PROFILE_MAX_LIST,
  riskWithinProfile,
  validateDelegationProfile,
} from "../src/lib/delegation-profile.js";
import {
  at,
  builtProfile,
  CLOCK,
  DAY,
  DELEGATION_ID,
  postJson,
  profileInput,
  readProfiles,
  stateOf,
  stepsAt,
  tempStatePath,
  validAction,
  withDelegationService,
} from "./helpers/delegation-profile-fixture.js";

test("W1-T3878: a built profile carries a bounded scope, capability set, risk tier, budget, approval policy, expiry, and revocation reference", () => {
  const profile = builtProfile();
  assert.equal(profile.version, "delegation-profile-v1");
  assert.equal(profile.revision, 1);
  assert.equal(profile.replaces, undefined);
  assert.deepEqual(profile.scope, { kind: "repository", repository: "owner/repo" });
  assert.deepEqual(profile.link, { flowId: "flow:canary" });
  assert.deepEqual(profile.capabilities, ["deploy.canary"]);
  assert.deepEqual(profile.dataClasses, ["status", "logs", "cost"]);
  assert.equal(profile.riskTier, "production");
  assert.deepEqual(profile.budget, { costUsd: 25, durationMinutes: 240 });
  assert.equal(profile.approvalLevel, "profile");
  assert.equal(profile.notification, "on-refusal");
  assert.equal(profile.fallbackOwner, "operator:owner");
  assert.equal(profile.humanDecision, "An operator approves every production promotion.");
  assert.equal(profile.createdAt, CLOCK.iso(), "createdAt is the SERVER clock, never the caller's");
  assert.equal(profile.expiresAt, at(7 * DAY));
  assert.equal(profile.revocationRef, delegationRevocationRef(DELEGATION_ID));
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.budget) && Object.isFrozen(profile.capabilities), "an issued profile is immutable");

  const instance = builtProfile({ scope: { kind: "instance", instanceId: " prod " }, link: { actionId: "action:deploy:canary" } });
  assert.deepEqual(instance.scope, { kind: "instance", instanceId: "prod" });
  assert.deepEqual(instance.link, { actionId: "action:deploy:canary" });
  const forged = buildDelegationProfile({ ...profileInput(), createdAt: at(-30 * DAY), revocationRef: "nowhere", revision: 9, version: "delegation-profile-v0" }, { clock: CLOCK });
  assert.ok(forged.ok, JSON.stringify(forged));
  assert.equal(forged.profile.createdAt, CLOCK.iso(), "a caller-supplied createdAt, revision, version, or revocationRef is ignored");
  assert.equal(forged.profile.revision, 1);
  assert.equal(forged.profile.revocationRef, delegationRevocationRef(DELEGATION_ID));
});

test("W1-T3878: an incomplete or unbounded profile is refused by name for every required field", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["no delegationId", { delegationId: undefined }, "missing-identity"],
    ["blank principal", { principal: "   " }, "missing-identity"],
    ["no purpose", { purpose: undefined }, "missing-identity"],
    ["no link", { link: undefined }, "missing-link"],
    ["an empty link", { link: {} }, "missing-link"],
    ["an unbounded link", { link: { flowId: "f".repeat(161) } }, "missing-link"],
    ["UNSCOPED", { scope: undefined }, "missing-scope"],
    ["an unknown scope kind", { scope: { kind: "fleet" } }, "missing-scope"],
    ["an empty repository scope", { scope: { kind: "repository", repository: "" } }, "missing-scope"],
    ["no data classes", { dataClasses: [] }, "missing-data-classes"],
    ["duplicate data classes", { dataClasses: ["logs", "logs"] }, "missing-data-classes"],
    ["too many data classes", { dataClasses: Array.from({ length: DELEGATION_PROFILE_MAX_LIST + 1 }, (_, i) => `class-${i}`) }, "missing-data-classes"],
    ["no capabilities", { capabilities: undefined }, "missing-capabilities"],
    ["a non-string capability", { capabilities: [7] }, "missing-capabilities"],
    ["no capability summary", { capabilitySummary: undefined }, "missing-capabilities"],
    ["an unknown risk tier", { riskTier: "extreme" }, "invalid-risk"],
    ["no budget", { budget: undefined }, "missing-budget"],
    ["a cost budget over the cap", { budget: { costUsd: DELEGATION_PROFILE_MAX_COST_USD + 1, durationMinutes: 60 } }, "missing-budget"],
    ["a negative cost budget", { budget: { costUsd: -1, durationMinutes: 60 } }, "missing-budget"],
    ["a zero duration budget", { budget: { costUsd: 5, durationMinutes: 0 } }, "missing-budget"],
    ["a fractional duration budget", { budget: { costUsd: 5, durationMinutes: 1.5 } }, "missing-budget"],
    ["no notification policy", { notification: "loud" }, "missing-notification"],
    ["no approval level", { approvalLevel: undefined }, "missing-approval-level"],
    ["no human decision", { humanDecision: "" }, "missing-human-decision"],
    ["no fallback owner", { fallbackOwner: undefined }, "missing-fallback-owner"],
    ["no expiry", { expiresAt: undefined }, "invalid-expiry"],
    ["an expiry before creation", { expiresAt: at(-1) }, "invalid-expiry"],
    ["an expiry past the lifetime cap", { expiresAt: at(DELEGATION_PROFILE_MAX_LIFETIME_MS + 1) }, "invalid-expiry"],
  ];
  for (const [label, overrides, code] of cases) {
    const built = buildDelegationProfile(profileInput(overrides), { clock: CLOCK });
    assert.equal(built.ok, false, label);
    assert.equal(!built.ok && built.code, code, label);
  }
  assert.equal((buildDelegationProfile("not a profile", { clock: CLOCK }) as { code: string }).code, "not-an-object");
  assert.equal((buildDelegationProfile(profileInput({ expiresAt: at(DELEGATION_PROFILE_MAX_LIFETIME_MS) }), { clock: CLOCK })).ok, true, "exactly the lifetime cap is allowed");

  // A stored record read back from the ledger is re-validated with the same rules.
  const stored = { ...builtProfile() } as Record<string, unknown>;
  assert.equal(validateDelegationProfile(stored).ok, true);
  assert.equal((validateDelegationProfile([]) as { code: string }).code, "not-an-object");
  assert.equal((validateDelegationProfile({ ...stored, version: "delegation-profile-v0" }) as { code: string }).code, "invalid-version");
  assert.equal((validateDelegationProfile({ ...stored, revision: 2 }) as { code: string }).code, "missing-identity", "a later revision must name what it replaces");
  assert.equal((validateDelegationProfile({ ...stored, replaces: "delegation:other" }) as { code: string }).code, "missing-identity", "revision 1 replaces nothing");
  assert.equal((validateDelegationProfile({ ...stored, revision: 0 }) as { code: string }).code, "missing-identity");
  assert.equal((validateDelegationProfile({ ...stored, revocationRef: "/v1/elsewhere" }) as { code: string }).code, "missing-revocation-ref");
  assert.equal(validateDelegationProfile({ ...stored, revision: 2, replaces: " delegation:prior " }).ok, true);
});

test("W1-T3878: an action outside the profile's scope, link, or capability allowlist is refused at eligibility", () => {
  const profile = builtProfile();
  const eligible = (overrides: Record<string, unknown>, state = stateOf(profile)) => delegationEligibility({ state, action: validAction(overrides), clock: CLOCK }).map((finding) => finding.code);
  assert.deepEqual(eligible({}), [], "an in-scope, linked, allowed, low-risk action is eligible");
  assert.deepEqual(eligible({ scope: { flowId: "flow:canary", repo: "owner/other" } }), ["delegation-scope-mismatch"]);
  assert.deepEqual(eligible({ scope: { flowId: "flow:canary", instance: "prod" } }), ["delegation-scope-mismatch"], "a repository profile never admits an instance-only action");
  assert.deepEqual(eligible({ scope: { flowId: "flow:other", repo: "owner/repo" } }), ["delegation-link-mismatch"]);
  assert.deepEqual(eligible({ capability: "deploy.production" }), ["delegation-capability-not-allowed"]);

  const byInstance = stateOf(builtProfile({ scope: { kind: "instance", instanceId: "prod" }, link: { actionId: "action:deploy:canary" } }));
  assert.deepEqual(eligible({ scope: { flowId: "flow:elsewhere", instance: "prod" } }, byInstance), [], "linked by actionId, scoped by instance");
  assert.deepEqual(eligible({ scope: { flowId: "flow:elsewhere", instance: "staging" } }, byInstance), ["delegation-scope-mismatch"]);
  assert.deepEqual(eligible({ actionId: "action:other", scope: { flowId: "flow:elsewhere", instance: "prod" } }, byInstance), ["delegation-link-mismatch"]);
});

test("W1-T3878: the risk ceiling orders low to high and treats the four critical tiers as categorical", () => {
  assert.equal(riskWithinProfile("low", "medium"), true);
  assert.equal(riskWithinProfile("high", "high"), true);
  assert.equal(riskWithinProfile("high", "medium"), false);
  assert.equal(riskWithinProfile("medium", "production"), true, "a critical ceiling admits every ordinary tier");
  assert.equal(riskWithinProfile("production", "production"), true);
  assert.equal(riskWithinProfile("financial", "production"), false, "a production ceiling never admits a financial action");
  assert.equal(riskWithinProfile("destructive", "high"), false);
  assert.deepEqual(["low", "medium", "high", "production", "financial", "credential", "destructive"].map((tier) => consoleRiskTier(tier as "low")), ["low", "medium", "high", "critical", "critical", "critical", "critical"]);
});

test("W1-T3878: POST /v1/operator-agent/delegations issues a pending profile the read route serves in the console's shape", async () => {
  const path = tempStatePath();
  await withDelegationService(path, async (base) => {
    assert.deepEqual(await readProfiles(base), []);
    const issued = await postJson(base, "/v1/operator-agent/delegations", { profile: profileInput() });
    assert.equal(issued.status, 201);
    assert.equal((issued.body.profile as { delegationId: string }).delegationId, DELEGATION_ID);
    const [profile] = await readProfiles(base);
    assert.ok(profile);
    // Every field remudero-console's `normalizedDelegationProfile` reads, in its vocabulary.
    assert.deepEqual(
      {
        version: profile.version,
        delegationId: profile.delegationId,
        scope: profile.scope,
        dataClasses: profile.dataClasses,
        capabilitySummary: profile.capabilitySummary,
        riskTier: profile.riskTier,
        budget: profile.budget,
        approval: profile.approval,
        createdAt: profile.createdAt,
        expiresAt: profile.expiresAt,
        lifecycleState: profile.lifecycleState,
        receipts: profile.receipts,
        observedAt: profile.observedAt,
        freshness: profile.freshness,
      },
      {
        version: "delegation-profile-v1",
        delegationId: DELEGATION_ID,
        scope: { kind: "repository", repository: "owner/repo" },
        dataClasses: ["status", "logs", "cost"],
        capabilitySummary: "Promote canary builds inside the canary flow.",
        riskTier: "critical",
        budget: { costUsd: 25, durationMinutes: 240 },
        approval: { state: "pending" },
        createdAt: CLOCK.iso(),
        expiresAt: at(7 * DAY),
        lifecycleState: "active",
        receipts: [],
        observedAt: CLOCK.iso(),
        freshness: "verified",
      },
    );
    assert.equal(profile.actionRiskCeiling, "production");
    assert.equal(profile.status, "pending");
    assert.equal(profile.revocationRef, delegationRevocationRef(DELEGATION_ID));
    assert.equal(profile.spentCostUsd, 0);

    const again = await postJson(base, "/v1/operator-agent/delegations", { profile: profileInput({ purpose: "A different purpose under the same id." }) });
    assert.equal(again.status, 409, "an issued profile is never overwritten; change it by replacing it");
    const unscoped = await postJson(base, "/v1/operator-agent/delegations", { profile: profileInput({ delegationId: "delegation:unscoped", scope: undefined }) });
    assert.equal(unscoped.status, 400);
    assert.equal(unscoped.body.code, "missing-scope");
    assert.equal(unscoped.body.field, "scope");
    assert.equal((await postJson(base, "/v1/operator-agent/delegations", ["not", "an", "object"])).status, 400);
    assert.equal((await postJson(base, "/v1/operator-agent/delegations", {})).body.code, "not-an-object");
  });
  assert.deepEqual(stepsAt(path), [DELEGATION_PROFILE_LEDGER_STEP], "only the one valid profile is durable");
});
