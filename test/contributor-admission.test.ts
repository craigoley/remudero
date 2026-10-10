import test from "node:test";
import assert from "node:assert/strict";
import { classifyContribution, type AdmissionPolicy, type AdmissionSubject, type MembershipEvidence } from "../src/lib/contributor-admission.js";
import { fetchOpenPrsRest, mapRestPr } from "../src/lib/open-prs-rest.js";

const NOW = 10_000;
const policy: AdmissionPolicy = {
  version: "test-policy-1", ownerIds: [1], organizationIds: [10],
  services: [{ id: 2, actions: ["review", "repair"] }], maxEvidenceAgeMs: 1_000,
};
function subject(actorId = 3, type = "User"): AdmissionSubject {
  return {
    repositoryId: 20, prNumber: 7, headSha: "a".repeat(40), observedAtMs: NOW,
    origin: {
      actor: { id: actorId, type, login: "example" },
      headRepository: { id: 21, fullName: "example/fork" },
      targetRepository: { id: 20, fullName: "example/core" },
    },
  };
}
function membership(state: MembershipEvidence["state"] = "member"): MembershipEvidence {
  return { actorId: 3, organizationId: 10, state, observedAtMs: NOW };
}
const decide = (s = subject(), evidence: MembershipEvidence[] = [membership()]) =>
  classifyContribution(s, "review", policy, evidence, NOW);

test("W1-T7752: REST origin survives enumeration without changing legacy sparse rows", () => {
  const legacy = { number: 7, html_url: "https://example.invalid/pull/7", updated_at: "t", head: { ref: "branch", sha: "a".repeat(40) } };
  assert.deepEqual(mapRestPr(legacy), {
    number: 7, url: legacy.html_url, updatedAt: "t", headRefName: "branch", headRefOid: legacy.head.sha,
    body: "", autoMergeRequest: null,
  });
  const row = {
    ...legacy, user: { id: 3, login: "example", type: "User" }, author_association: "MEMBER",
    head: { ...legacy.head, repo: { id: 21, full_name: "example/fork" } },
    base: { repo: { id: 20, full_name: "example/core" } },
  };
  const routes: Record<string, unknown> = {
    "repos/example/core/pulls?state=open&per_page=100": [row],
    [`repos/example/core/commits/${legacy.head.sha}/check-runs?per_page=100`]: { check_runs: [] },
    [`repos/example/core/commits/${legacy.head.sha}/status`]: { statuses: [] },
  };
  const prs = fetchOpenPrsRest("example", "core", (args) => {
    assert.ok(args[1] in routes, `unexpected request: ${args[1]}`);
    return routes[args[1]];
  });
  assert.deepEqual(prs[0].contributionOrigin, {
    ...subject().origin, association: "MEMBER",
  });
  assert.deepEqual(mapRestPr({ ...legacy, user: null, head: { ...legacy.head, repo: null } }).contributionOrigin,
    { actor: null, headRepository: null });
  assert.deepEqual(mapRestPr({ ...legacy, base: { repo: null } }).contributionOrigin, { targetRepository: null });
  assert.deepEqual(mapRestPr({ ...legacy, author_association: "OWNER" }).contributionOrigin, { association: "OWNER" });
});

test("W1-T7752: pinned trusted identities survive an unknown membership read", () => {
  assert.equal(decide(subject(1), []).outcome, "trusted");
  assert.equal(decide(subject(1), [membership("unknown")]).reason, "owner");
  assert.equal(decide(subject(2, "Bot"), []).reason, "scoped-service");
  assert.equal(classifyContribution(subject(2, "Bot"), "feedback", policy, [], NOW).outcome, "unknown");
  assert.equal(decide(subject(1, "Bot"), []).outcome, "unknown");
  assert.equal(decide(subject(2), []).outcome, "unknown");
  assert.equal(classifyContribution(subject(2), "review", { ...policy, organizationIds: [] }, [], NOW).outcome, "unknown");
  assert.equal(decide(subject(2), [membership()]).outcome, "unknown");
  assert.equal(decide(subject(900, "Bot"), []).outcome, "confirmed-external");
});

test("W1-T7752: verified organization membership admits its member on a fork", () => {
  assert.equal(decide().reason, "organization-member");
  assert.equal(decide().outcome, "trusted");
  const another = { ...membership(), organizationId: 11, state: "not-member" as const };
  const twoOrgs = { ...policy, organizationIds: [10, 11] };
  assert.equal(classifyContribution(subject(), "review", twoOrgs, [another, membership()], NOW).outcome, "trusted");
  assert.equal(classifyContribution(subject(), "review", twoOrgs, [another], NOW).outcome, "unknown");
  assert.equal(classifyContribution(subject(), "review", twoOrgs, [another, membership("not-member")], NOW).outcome, "confirmed-external");
});

test("W1-T7752: familiar metadata cannot grant trust", () => {
  const familiar = subject(900);
  familiar.origin!.actor!.login = "owner";
  familiar.origin!.association = "OWNER";
  familiar.origin!.headRepository = familiar.origin!.targetRepository;
  assert.equal(decide(familiar, []).outcome, "unknown");
  assert.equal(decide(familiar, [{ ...membership("not-member"), actorId: 900 }]).outcome, "confirmed-external");
  assert.equal(decide(subject(3, "Organization"), [membership()]).outcome, "unknown");
});

test("W1-T7752: malformed or stale identity remains unknown", () => {
  const cases: AdmissionSubject[] = [
    { ...subject(), origin: undefined },
    { ...subject(), headSha: "" },
    { ...subject(), prNumber: 0 },
    { ...subject(), repositoryId: 0 },
    { ...subject(), observedAtMs: NOW - 1_001 },
    { ...subject(), observedAtMs: NOW + 1 },
    { ...subject(), observedAtMs: NaN },
    { ...subject(), origin: { ...subject().origin, actor: null } },
    { ...subject(), origin: { ...subject().origin, actor: { id: 3 } } },
    { ...subject(), origin: { ...subject().origin, actor: { id: 0, type: "User" } } },
    { ...subject(), origin: { ...subject().origin, actor: { id: NaN, type: "User" } } },
    { ...subject(), origin: { ...subject().origin, headRepository: null } },
    { ...subject(), origin: { ...subject().origin, headRepository: { id: 0 } } },
    { ...subject(), origin: { ...subject().origin, targetRepository: null } },
    { ...subject(), origin: { ...subject().origin, targetRepository: { id: 99 } } },
  ];
  for (const s of cases) assert.equal(decide(s).outcome, "unknown", JSON.stringify(s));
  assert.equal(decide({ ...subject(), origin: undefined }).reason, "missing-origin");
  assert.equal(decide({ ...subject(), origin: { ...subject().origin, actor: null } }).reason, "missing-actor");
  assert.equal(decide({ ...subject(), origin: { ...subject().origin, actor: { id: 0 } } }).reason, "invalid-actor");
  assert.equal(decide({ ...subject(), origin: { ...subject().origin, headRepository: null } }).reason, "missing-head-repository");
  assert.equal(decide({ ...subject(), origin: { ...subject().origin, headRepository: { id: 0 } } }).reason, "invalid-head-repository");
  assert.equal(decide({ ...subject(), origin: { ...subject().origin, targetRepository: null } }).reason, "missing-target-repository");
  assert.equal(decide({ ...subject(), origin: { ...subject().origin, targetRepository: { id: 99 } } }).reason, "target-mismatch");
  for (const evidence of [[], [membership("unknown")], [{ ...membership(), observedAtMs: NOW - 1_001 }],
    [{ ...membership(), observedAtMs: NOW + 1 }], [{ ...membership(), actorId: 999 }],
    [{ ...membership(), organizationId: 999 }], [{ ...membership(), observedAtMs: NaN }]]) {
    assert.equal(decide(subject(), evidence).outcome, "unknown");
  }
  assert.equal(decide(subject(), [membership("not-member")]).outcome, "confirmed-external");
  assert.equal(decide({ ...subject(), observedAtMs: NOW - 1_000 }).outcome, "trusted");
  assert.equal(classifyContribution(subject(), "review", { ...policy, organizationIds: [] }, [], NOW).outcome, "confirmed-external");
  for (const p of [{ ...policy, version: "" }, { ...policy, maxEvidenceAgeMs: -1 },
    { ...policy, ownerIds: [] }, { ...policy, ownerIds: [NaN] },
    { ...policy, organizationIds: [0] }, { ...policy, services: [{ id: 0, actions: ["review" as const] }] }]) {
    assert.equal(classifyContribution(subject(), "review", p, [], NOW).outcome, "unknown");
  }
  assert.equal(classifyContribution(subject(), "review", policy, [membership()], NaN).outcome, "unknown");
  assert.equal(decide(subject(), [membership("not-member"), membership()]).outcome, "unknown", "conflicting same-time membership cannot grant trust");
  assert.equal(decide(subject(), [membership("not-member"), { ...membership(), observedAtMs: NOW - 1 }]).outcome, "confirmed-external", "newer evidence wins over a cached member");
});

test("W1-T7752: admission receipt changes with head target actor action and policy", () => {
  const baseline = decide().receiptKey;
  assert.match(baseline, /^[a-f0-9]{64}$/);
  for (const s of [{ ...subject(), headSha: "b".repeat(40) }, { ...subject(), prNumber: 8 },
    { ...subject(), repositoryId: 30, origin: { ...subject().origin, targetRepository: { id: 30 } } },
    subject(4), { ...subject(), origin: { ...subject().origin, headRepository: { id: 22 } } }]) {
    assert.notEqual(decide(s).receiptKey, baseline);
  }
  assert.notEqual(classifyContribution(subject(), "repair", policy, [membership()], NOW).receiptKey, baseline);
  assert.notEqual(classifyContribution(subject(), "review", { ...policy, version: "test-policy-2" }, [membership()], NOW).receiptKey, baseline);
  assert.notEqual(classifyContribution(subject(), "review", { ...policy, ownerIds: [1, 5] }, [membership()], NOW).receiptKey, baseline);
  assert.notEqual(decide(subject(), [membership("not-member")]).receiptKey, baseline);
  assert.notEqual(classifyContribution(subject(), "review", policy, [membership()], NOW + 1_001).receiptKey, baseline);
  assert.equal(decide().receiptKey, baseline, "deterministic with identical evidence");
});
