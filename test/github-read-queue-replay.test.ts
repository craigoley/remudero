import assert from "node:assert/strict";
import test from "node:test";
import { CERTIFIED_REPLAY_READ_DESCRIPTORS, GithubReadQueueReplay, type ReplayObservation, type ReplayReadIdentity, type ReplayReadRequest, type ReplayReceipt } from "#src/lib/github-read-queue-replay.js";
import { DEFAULT_GH_READ_CADENCE_S, classifyGhLimitFailure, ghArgvIsWrite, ghReadCadenceDecision } from "#src/lib/github-transport.js";

const floor = DEFAULT_GH_READ_CADENCE_S * 1000;
const identity: ReplayReadIdentity = Object.freeze({ repository: "fixture/repo", authScope: "fixture-installation-1",
  exactHead: "a5d5698866eb8686117eb9d5ce265b2f2899027d", request: "failed-job-diagnostic", inputId: "sha256:fixture-input-1" });
const request = (id: string, extra: Partial<ReplayReadRequest> = {}): ReplayReadRequest => ({
  readId: id, clientId: id, operation: "READ", identity, ...extra,
});
const observation = (nowMs: number, extra: Partial<Extract<ReplayObservation, { kind: "complete" | "partial" }>> = {}): ReplayObservation => ({
  kind: "complete", identity, corpusId: "fixture-corpus", bodyId: "sha256:fixture-body", observedAtMs: nowMs,
  expiresAtMs: nowMs + 10 * floor, ...extra,
});
const enabled = () => new GithubReadQueueReplay({ enabled: true });
function refused(result: object): ReplayReceipt {
  assert.ok("reason" in result);
  return result as ReplayReceipt;
}
function accepted<T extends object>(result: T): Exclude<T, ReplayReceipt> {
  assert.ok(!("reason" in result));
  return result as Exclude<T, ReplayReceipt>;
}

test("replay is default-off and reuses the existing pure enforced 180-second floor", () => {
  const off = new GithubReadQueueReplay();
  assert.equal(refused(off.submit(request("off"), 0)).reason, "replay-disabled");
  assert.equal(refused(off.admit("owner", 0)).reason, "replay-disabled");
  assert.equal(off.report(0).replayReadAdmissions, 0);
  assert.equal(floor, 180_000);
  for (const nowMs of [0, floor - 1, floor]) {
    const decision = ghReadCadenceDecision({ isWrite: false, isExempt: false, mode: "enforce", nowMs, lastReadMs: 0 });
    assert.equal(decision.allow, nowMs >= floor);
  }
  assert.equal(ghArgvIsWrite(["pr", "merge", "1"]), true);
  assert.equal(classifyGhLimitFailure(new Error("secondary rate limit"), { remaining: 5000 }), "secondary");
  assert.equal(classifyGhLimitFailure(new Error("rate limit exceeded"), { remaining: 0 }), "primary");
});

test("replay coalesces identical readers once and freezes origin, READY history and input identity", () => {
  const queue = enabled();
  const mutableIdentity = { ...identity };
  queue.submit(request("first", { identity: mutableIdentity }), 0);
  mutableIdentity.exactHead = "changed-after-submit";
  const joined = queue.submit(request("second", { diagnostic: true }), 10);
  assert.deepEqual(joined, { state: "READY", readId: "first", readyAtMs: 0, readyExpiresAtMs: 8 * 60_000, coalesced: true });
  assert.equal(accepted(queue.admit("winner", 20)).readId, "first");
  assert.equal(refused(queue.admit("loser", 20)).reason, "active-owner");
  assert.equal(queue.cancelOwner("first", "loser", 20), false);
  assert.equal(queue.complete("first", "loser", observation(20), 20), false);
  assert.equal(queue.complete("first", "winner", observation(20), 20), true);
  const first = queue.receipt("first", 20, identity);
  assert.equal(first.status, "KNOWN");
  assert.equal(first, queue.receipt("second", 20, identity));
  assert.equal(first.origin!.identity.exactHead, identity.exactHead);
  assert.equal(first.origin!.readyAtMs, 0);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.origin), true);
  assert.equal(Object.isFrozen(first.origin!.identity), true);
  assert.equal(Object.isFrozen(first.origin!.observation!.identity), true);
  assert.throws(() => { (first.origin!.identity as { exactHead: string }).exactHead = "reset"; }, TypeError);
  assert.equal(queue.receipt("first", 20, { ...identity, exactHead: "stale-head" }).status, "UNKNOWN");
  assert.equal(queue.receipt("first", 20 + 10 * floor).reason, "observation-expired");
  assert.equal(first.status, "KNOWN"); // The immutable original does not change when it ages out.
  const report = queue.report(20 + 10 * floor);
  assert.equal(report.evidence, "deterministic-replay-only");
  assert.equal(report.replayReadAdmissions, 1);
  assert.equal(report.replayPotentialCoalescedClients, 1);
});

test("replay never mixes repository, auth, exact head, request or input; writes and payloads are refused", () => {
  for (const field of ["repository", "authScope", "exactHead", "request", "inputId"] as const) {
    const queue = enabled();
    queue.submit(request("first"), 0);
    const separate = accepted(queue.submit(request("second", { identity: { ...identity, [field]: field === "request" ? "pull-request-view" : "different" } }), 1));
    assert.equal(separate.coalesced, false, field);
    assert.equal(separate.readId, "second", field);
    assert.equal(queue.report(1).replayPotentialCoalescedClients, 0, field);
  }
  const queue = enabled();
  queue.submit(request("first"), 0);
  assert.equal(refused(queue.submit(request("write", { operation: "WRITE" }), 0)).reason, "mutation-refused");
  for (const key of ["token", "headers", "body", "argv", "executable"]) {
    assert.equal(refused(queue.submit({ ...request(key), [key]: "fixture-payload" }, 0)).reason, "malformed-request");
  }
  assert.equal(refused(queue.submit(request("secret", { identity: { ...identity, authScope: "ghp_fixture" } }), 0)).reason, "malformed-request");
  assert.equal(queue.report(0).replayPotentialCoalescedClients, 0);
});

test("replay client cancellation and expiry detach only clients; only the actual owner can cancel shared work", () => {
  const queue = enabled();
  queue.submit(request("first", { timeoutMs: 10 }), 0);
  queue.submit(request("second"), 0);
  queue.admit("winner", 0);
  assert.equal(queue.receipt("first", 10).reason, "client-expired");
  assert.equal(queue.receipt("first", 10).replayReadAdmitted, true);
  assert.equal(refused(queue.admit("loser", 10)).reason, "active-owner");
  assert.equal(queue.cancelOwner("first", "loser", 10), false);
  queue.complete("first", "winner", observation(10), 10);
  assert.equal(queue.receipt("second", 10).status, "KNOWN");
  assert.equal(queue.receipt("first", 10).status, "UNKNOWN");

  const cancel = enabled();
  cancel.submit(request("first"), 0);
  cancel.submit(request("second"), 0);
  cancel.admit("winner", 0);
  assert.equal(cancel.cancelClient("first", 1), true);
  assert.equal(refused(cancel.admit("loser", 1)).reason, "active-owner");
  assert.equal(cancel.cancelOwner("first", "winner", 1), true);
  assert.equal(cancel.receipt("first", 1).reason, "client-cancelled");
  assert.equal(cancel.receipt("second", 1).reason, "owner-cancelled");
  assert.equal(cancel.complete("first", "winner", observation(1), 1), false);
});

test("replay admission expires UNKNOWN without admission and refuses resetting a completed READY id", () => {
  const queue = enabled();
  queue.submit(request("expired", { timeoutMs: 10 }), 0);
  assert.equal(refused(queue.admit("owner", 10)).reason, "no-ready-read");
  assert.deepEqual(queue.receipt("expired", 10), { status: "UNKNOWN", reason: "client-expired", replayReadAdmitted: false });
  assert.equal(refused(queue.submit(request("expired", { clientId: "retry" }), 11)).reason, "read-id-reused");
  assert.equal(queue.report(11).replayReadAdmissions, 0);
});

test("replay active join reuses the immutable origin and queued cancellation stops wait accounting", () => {
  const queue = enabled();
  queue.submit(request("first"), 0);
  queue.admit("owner", 0);
  assert.deepEqual(queue.submit(request("join"), 5), {
    state: "ACTIVE", readId: "first", readyAtMs: 0, readyExpiresAtMs: 8 * 60_000, coalesced: true,
  });
  const mutable = { ...identity };
  queue.complete("first", "owner", observation(10, { identity: mutable }), 10);
  mutable.inputId = "changed-after-observation";
  assert.equal(queue.receipt("first", 10), queue.receipt("join", 10));
  assert.equal(queue.receipt("join", 10).origin!.observation!.identity.inputId, identity.inputId);
  assert.deepEqual(queue.report(10).replayAdmissionWaitMs, [0, 0]);
  assert.equal(queue.report(10).replayPotentialCoalescedClients, 1);

  const cancelled = enabled();
  cancelled.submit(request("waiting"), 0);
  cancelled.cancelClient("waiting", 5);
  const scope = JSON.stringify([identity.repository, identity.authScope]);
  assert.equal(cancelled.report(floor).replayWorstObservedWaitByScopeMs[scope], 5);
  assert.equal(refused(cancelled.admit("owner", floor)).reason, "no-ready-read");
  assert.equal(cancelled.receipt("waiting", floor).replayReadAdmitted, false);
  assert.equal(cancelled.receipt("missing", floor).reason, "missing-client");
});

test("replay partial, HTTP error, close, stale identity and expired observations never become empty success", () => {
  const cases: [ReplayObservation, string][] = [
    [observation(1, { kind: "partial" }), "partial"],
    [{ kind: "http-error" }, "http-error"],
    [{ kind: "closed" }, "closed"],
    [observation(1, { identity: { ...identity, exactHead: "stale-head" } }), "identity-mismatch"],
    [observation(1, { expiresAtMs: 1 }), "observation-expired"],
    [observation(1, { observedAtMs: 2 }), "observation-time-invalid"],
    [observation(1, { bodyId: "" }), "malformed-observation"],
  ];
  for (const [result, reason] of cases) {
    const queue = enabled();
    queue.submit(request("read"), 0);
    queue.admit("owner", 0);
    queue.complete("read", "owner", result, 1);
    const receipt = queue.receipt("read", 1);
    assert.equal(receipt.status, "UNKNOWN", reason);
    assert.equal(receipt.reason, reason);
    assert.equal(receipt.replayReadAdmitted, true);
  }
});

test("replay preserves the floor across auth/repo scopes and secondary backoff; harness refusals teach no capacity", () => {
  for (const retryAfterMs of [1, 2 * floor]) {
    const queue = enabled();
    queue.submit(request("first"), 0);
    queue.admit("owner", 0);
    queue.complete("first", "owner", { kind: "secondary-limit", retryAfterMs }, 1);
    const next = Math.max(floor, retryAfterMs) + 1;
    queue.submit(request("second", { identity: { ...identity, repository: "other/repo", authScope: "other-auth" } }), 1);
    assert.equal(refused(queue.admit("owner", next - 1)).reason, "secondary-backoff");
    assert.equal(accepted(queue.admit("owner", next)).readId, "second");
    assert.equal(queue.report(next).replayCadenceFloorMs, floor);
    assert.equal(queue.report(next).replaySecondaryLimitSamples, 1);
  }
  const queue = new GithubReadQueueReplay({ enabled: true, maxPending: 1 });
  queue.submit(request("first"), 0);
  queue.admit("owner", 0);
  queue.complete("first", "owner", { kind: "harness-config-refusal" }, 1);
  queue.submit(request("second", { identity: { ...identity, authScope: "other-auth" } }), 1);
  assert.equal(refused(queue.submit(request("third"), 1)).reason, "queue-bound");
  assert.equal(refused(queue.admit("owner", floor - 1)).reason, "cadence-floor");
  assert.equal(accepted(queue.admit("owner", floor)).readId, "second");
  const report = queue.report(floor);
  assert.equal(report.replayMaxPending, 1);
  assert.equal(report.replaySecondaryLimitSamples, 0);
  assert.equal(report.replayBackoffUntilMs, 0);
  assert.equal(queue.receipt("first", floor).reason, "harness-config-refusal");
});

test("replay bounds queue/client admission and rejects invalid bounds or backwards time", () => {
  const queue = new GithubReadQueueReplay({ enabled: true, maxPending: 1, maxClientsPerRead: 2 });
  queue.submit(request("first"), 0);
  assert.equal(refused(queue.submit(request("same-client", { clientId: "first" }), 0)).reason, "client-id-reused");
  queue.submit(request("second"), 1);
  assert.equal(refused(queue.submit(request("third"), 1)).reason, "client-bound");
  assert.equal(refused(queue.submit(request("different", { identity: { ...identity, inputId: "different" } }), 1)).reason, "queue-bound");
  assert.equal(refused(queue.submit(request("bad", { timeoutMs: 0 }), 1)).reason, "invalid-wait-bound");
  assert.throws(() => new GithubReadQueueReplay({ maxPending: 0 }), /invalid replay options/);
  assert.throws(() => queue.admit("owner", 0), /monotonic/);
});

test("replay trace compares synthetic starvation baseline to fair admission under repeated later arrivals", (t) => {
  function trace(policy: "fair" | "latest-arrival-baseline") {
    const queue = new GithubReadQueueReplay({ enabled: true, maxWaitMs: 4 * floor }, policy);
    queue.submit(request("old-diagnostic", { diagnostic: true }), 0);
    const replayAdmissions: string[] = [];
    for (let tick = 1; tick <= 4; tick++) {
      const now = tick * floor;
      const id = `later-${tick}`;
      const arrivalIdentity = { ...identity, inputId: id };
      queue.submit(request(id, { diagnostic: true, identity: arrivalIdentity }), now);
      const admitted = queue.admit("owner", now);
      assert.ok("readId" in admitted);
      replayAdmissions.push(admitted.readId);
      queue.complete(admitted.readId, "owner", observation(now, {
        identity: admitted.readId === "old-diagnostic" ? identity : { ...identity, inputId: admitted.readId },
      }), now);
    }
    return { replayAdmissions, replayOldDiagnostic: queue.receipt("old-diagnostic", 4 * floor), ...queue.report(4 * floor) };
  }
  const baseline = trace("latest-arrival-baseline");
  const candidate = trace("fair");
  assert.deepEqual(baseline.replayAdmissions, ["later-1", "later-2", "later-3", "later-4"]);
  assert.equal(baseline.replayOldDiagnostic.reason, "read-admission-expired");
  assert.equal(baseline.replayOldDiagnostic.replayReadAdmitted, false);
  assert.deepEqual(candidate.replayAdmissions, ["old-diagnostic", "later-1", "later-2", "later-3"]);
  assert.equal(candidate.replayOldDiagnostic.status, "KNOWN");
  assert.equal(candidate.replayOldDiagnostic.origin!.admittedAtMs, floor);
  const scope = JSON.stringify([identity.repository, identity.authScope]);
  assert.equal(baseline.replayWorstObservedWaitByScopeMs[scope], 4 * floor);
  assert.equal(candidate.replayWorstObservedWaitByScopeMs[scope], floor);
  t.diagnostic(JSON.stringify({ evidence: "deterministic-replay-only",
    replayBaselineAdmissions: baseline.replayAdmissions, replayCandidateAdmissions: candidate.replayAdmissions,
    replayBaselineOldDiagnostic: baseline.replayOldDiagnostic.reason,
    replayCandidateOldDiagnosticWaitMs: candidate.replayOldDiagnostic.origin!.admittedAtMs,
    replayBaselineWorstScopeWaitMs: baseline.replayWorstObservedWaitByScopeMs[scope],
    replayCandidateWorstScopeWaitMs: candidate.replayWorstObservedWaitByScopeMs[scope] }));
});

test("replay bounded aging prevents a stream of diagnostics from starving another repository's routine read", () => {
  const queue = new GithubReadQueueReplay({ enabled: true, maxWaitMs: 6 * floor });
  queue.submit(request("routine", { identity: { ...identity, repository: "routine/repo" } }), 0);
  const replayAdmissions: string[] = [];
  for (let tick = 1; tick <= 3; tick++) {
    const now = tick * floor;
    queue.submit(request(`diagnostic-${tick}`, { diagnostic: true, identity: { ...identity, inputId: `input-${tick}` } }), now);
    const admitted = queue.admit("owner", now);
    assert.ok("readId" in admitted);
    replayAdmissions.push(admitted.readId);
    queue.complete(admitted.readId, "owner", { kind: "http-error" }, now);
  }
  assert.deepEqual(replayAdmissions, ["diagnostic-1", "routine", "diagnostic-2"]);
  const receipt = queue.receipt("routine", 3 * floor);
  assert.equal(receipt.origin!.readyAtMs, 0);
  assert.equal(receipt.origin!.admittedAtMs, 2 * floor);
  assert.equal(queue.report(3 * floor).replayWorstObservedWaitByScopeMs[JSON.stringify(["routine/repo", identity.authScope])], 2 * floor);
});


test("replay exact key whitelist rejects extra own keys without reading accessors", () => {
  let getterCalls = 0;
  const fieldGetter = () => { getterCalls++; return "fixture-raw-secret"; };
  const identityGetter = { ...identity };
  Object.defineProperty(identityGetter, "exactHead", { enumerable: true, get: fieldGetter });
  const requestGetter = { ...request("getter") };
  Object.defineProperty(requestGetter, "operation", { enumerable: true, get: fieldGetter });
  const inheritedIdentity = Object.assign(Object.create(identity), {
    token: "fixture-raw-secret", headers: {}, body: {}, argv: [], executable: "fixture-program",
  });
  const symbolIdentity = { ...identity, [Symbol("secret")]: "fixture-raw-secret" };
  const hiddenIdentity = { ...identity };
  Object.defineProperty(hiddenIdentity, "token", { value: "fixture-raw-secret", enumerable: false });
  const hiddenRequest = { ...request("hidden-request") };
  Object.defineProperty(hiddenRequest, "token", { value: "fixture-raw-secret", enumerable: false });
  const { exactHead: _omittedHead, ...missingIdentity } = identity;
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const malformed = [
    null, undefined, [], "READ", 42, () => 0, revoked.proxy, requestGetter, hiddenRequest,
    { ...request("extra"), token: "fixture-raw-secret" },
    { ...request("symbol"), [Symbol("secret")]: "fixture-raw-secret" },
    ...[identityGetter, inheritedIdentity, symbolIdentity, hiddenIdentity, missingIdentity,
      { ...identity, token: "fixture-raw-secret" }, Object.create(null)].map((id) => ({ ...request("bad-id"), identity: id })),
  ];
  for (const input of malformed) {
    const queue = enabled();
    const result = refused(queue.submit(input, 0));
    assert.equal(result.reason, "malformed-request");
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.replayReadAdmitted, false);
    assert.equal(queue.report(0).replayRetainedRecords, 0);
    assert.equal(queue.report(0).replayRetainedClients, 0);
    assert.ok(!JSON.stringify(result).includes("fixture-raw-secret"));
  }
  assert.equal(getterCalls, 0);
});

test("replay accepts only certified finite non-executable read descriptors, including READ-tagged mutations", () => {
  assert.deepEqual(Object.keys(CERTIFIED_REPLAY_READ_DESCRIPTORS).sort(),
    ["failed-job-diagnostic", "pull-request-checks", "pull-request-view"]);
  for (const descriptor of Object.keys(CERTIFIED_REPLAY_READ_DESCRIPTORS)) {
    const queue = enabled();
    const id = { ...identity, request: descriptor };
    accepted(queue.submit({ ...request("first"), identity: id }, 0));
    assert.equal(accepted(queue.submit({ ...request("second"), identity: id }, 0)).coalesced, true);
    const certified = CERTIFIED_REPLAY_READ_DESCRIPTORS[descriptor as ReplayReadIdentity["request"]];
    assert.deepEqual(certified, { effect: "READ", execution: "none" });
    assert.equal(Object.isFrozen(certified), true);
  }
  const queue = enabled();
  queue.submit(request("valid"), 0);
  for (const descriptor of ["pr.merge", "POST", "graphql-mutation", "unknown", "constructor", "__proto__", "toString",
    { kind: "failed-job-diagnostic", effect: "READ", execute: () => 0 }]) {
    const result = refused(queue.submit({ ...request("mutation"), identity: { ...identity, request: descriptor } }, 0));
    assert.equal(result.reason, "malformed-request");
  }
  assert.equal(refused(queue.submit(request("write", { operation: "WRITE" }), 0)).reason, "mutation-refused");
  assert.equal(queue.report(0).replayRetainedClients, 1);
  assert.equal(queue.report(0).replayPotentialCoalescedClients, 0);
});

test("replay snapshots auth/head/input and rejects all cross-identity observation bindings", () => {
  for (const field of ["repository", "authScope", "exactHead", "request", "inputId"] as const) {
    const changed = { ...identity, [field]: field === "request" ? "pull-request-view" : "different" };
    const queue = enabled();
    queue.submit(request("read"), 0);
    queue.admit("owner", 0);
    queue.complete("read", "owner", observation(1, { identity: changed }), 1);
    assert.equal(queue.receipt("read", 1).reason, "identity-mismatch", field);
    assert.equal(queue.receipt("read", 1).status, "UNKNOWN", field);
    assert.equal(queue.receipt("read", 1).origin!.identity[field], identity[field], field);
  }
  let reads = 0;
  const id = { ...identity };
  Object.defineProperty(id, "authScope", { enumerable: true, get() { reads++; return reads < 3 ? identity.authScope : "other-auth"; } });
  const queue = enabled();
  assert.equal(refused(queue.submit({ ...request("accessor"), identity: id }, 0)).reason, "malformed-request");
  assert.equal(reads, 0);
});

test("replay malformed observations produce fixed UNKNOWN reasons without invoking getters or leaking input", () => {
  let getterCalls = 0;
  const kindGetter = {};
  Object.defineProperty(kindGetter, "kind", { enumerable: true, get() { getterCalls++; return "complete"; } });
  const nestedGetter = { ...identity };
  Object.defineProperty(nestedGetter, "exactHead", { enumerable: true, get() { getterCalls++; return "head-A"; } });
  const hidden = { ...observation(1) };
  Object.defineProperty(hidden, "token", { value: "fixture-raw-secret", enumerable: false });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const malformed = [
    null, undefined, [], 42, "complete", revoked.proxy, kindGetter, Object.create({ kind: "http-error" }),
    { kind: "fixture-raw-secret" }, { kind: { raw: "fixture-raw-secret" } },
    { ...observation(1), token: "fixture-raw-secret" }, hidden,
    { ...observation(1), [Symbol("secret")]: "fixture-raw-secret" },
    { ...observation(1), identity: nestedGetter },
    { ...observation(1), identity: Object.create(identity) },
    { ...observation(1), observedAtMs: NaN },
    { ...observation(1), expiresAtMs: Infinity },
    { kind: "secondary-limit", retryAfterMs: -1 },
    { kind: "secondary-limit", retryAfterMs: Number.MAX_SAFE_INTEGER },
    { kind: "harness-config-refusal", retryAfterMs: 1 },
    { kind: "complete", identity, corpusId: "fixture-corpus", bodyId: "fixture-body", observedAtMs: 1 },
  ];
  for (const input of malformed) {
    const queue = enabled();
    queue.submit(request("read"), 0);
    queue.admit("owner", 0);
    assert.equal(queue.complete("read", "foreign-owner", input, 1), false);
    assert.equal(queue.complete("read", "owner", input, 1), true);
    const receipt = queue.receipt("read", 1);
    assert.equal(receipt.status, "UNKNOWN");
    assert.equal(receipt.reason, "malformed-observation");
    assert.equal(receipt.origin!.observation, undefined);
    assert.ok(!JSON.stringify(receipt).includes("fixture-raw-secret"));
    assert.equal(queue.report(1).replaySecondaryLimitSamples, 0);
    assert.equal(queue.report(1).replayBackoffUntilMs, 0);
  }
  assert.equal(getterCalls, 0);

  const known = enabled();
  known.submit(request("read"), 0);
  known.admit("owner", 0);
  known.complete("read", "owner", observation(1), 1);
  assert.equal(known.receipt("read", 1, null).reason, "identity-mismatch");
  assert.equal(known.receipt("read", 1, nestedGetter).reason, "identity-mismatch");
  assert.equal(getterCalls, 0);
  assert.equal(known.receipt("read", 1, identity).status, "KNOWN");
});

test("replay immutable shared READY expiry cannot be extended by later clients or reset with the same id", () => {
  const queue = new GithubReadQueueReplay({ enabled: true, maxWaitMs: 10 });
  const first = accepted(queue.submit(request("first"), 0));
  const later = accepted(queue.submit(request("later"), 9));
  assert.equal(first.readyAtMs, 0);
  assert.equal(later.readyAtMs, 0);
  assert.equal(first.readyExpiresAtMs, 10);
  assert.equal(later.readyExpiresAtMs, 10);
  assert.equal(refused(queue.admit("owner", 15)).reason, "no-ready-read");
  for (const client of ["first", "later"]) {
    assert.deepEqual(queue.receipt(client, 15), {
      status: "UNKNOWN", reason: "read-admission-expired", replayReadAdmitted: false,
    });
  }
  assert.equal(refused(queue.submit(request("first", { clientId: "retry" }), 15)).reason, "read-id-reused");
  assert.equal(queue.report(15).replayReadAdmissions, 0);
  assert.equal(queue.report(15).replayWorstObservedWaitByScopeMs[JSON.stringify([identity.repository, identity.authScope])], 10);
});

test("replay shared admission expiry and all client expiries never steal an ACTIVE owner or clear cadence", () => {
  const queue = new GithubReadQueueReplay({ enabled: true, maxWaitMs: 10 });
  queue.submit(request("first", { timeoutMs: 5 }), 0);
  queue.admit("winner", 0);
  assert.equal(queue.receipt("first", 11).reason, "client-expired");
  assert.equal(refused(queue.admit("loser", 11)).reason, "active-owner");
  const join = accepted(queue.submit(request("late-client"), 11));
  assert.equal(join.state, "ACTIVE");
  assert.equal(join.readyExpiresAtMs, 10);
  assert.equal(queue.cancelOwner("first", "loser", 11), false);
  assert.equal(queue.complete("first", "loser", observation(12), 12), false);
  assert.equal(queue.complete("first", "winner", observation(12), 12), true);
  assert.equal(queue.receipt("late-client", 12).status, "KNOWN");
  assert.equal(queue.receipt("first", 12).status, "UNKNOWN");
  assert.equal(refused(queue.admit("loser", 12)).reason, "cadence-floor");
  assert.equal(queue.report(12).replayReadAdmissions, 1);
});

test("replay record and client history limits remain bounded after repeated DONE submissions", () => {
  const records = new GithubReadQueueReplay({ enabled: true, maxRecords: 2, maxClients: 10 });
  for (let i = 0; i < 2; i++) {
    const now = i * floor;
    const id = "completed-" + i;
    records.submit(request(id, { identity: { ...identity, inputId: id } }), now);
    assert.equal(accepted(records.admit("owner", now)).readId, id);
    records.complete(id, "owner", { kind: "http-error" }, now);
  }
  for (let i = 0; i < 50; i++) {
    assert.equal(refused(records.submit(request("extra-" + i), floor)).reason, "history-record-bound");
  }
  assert.equal(refused(records.submit(request("completed-0", { clientId: "retry" }), floor)).reason, "read-id-reused");
  const report = records.report(floor);
  assert.equal(report.replayRetainedRecords, 2);
  assert.equal(report.replayRetainedClients, 2);
  assert.equal(report.replayMaxRecords, 2);
  assert.equal(report.replayAdmissionWaitMs.length, 2);

  const clients = new GithubReadQueueReplay({ enabled: true, maxClients: 2, maxRecords: 10 });
  clients.submit(request("first", { timeoutMs: 1 }), 0);
  clients.submit(request("second", { timeoutMs: 1 }), 0);
  clients.receipt("first", 1);
  for (let i = 0; i < 50; i++) {
    assert.equal(refused(clients.submit(request("extra-" + i), 1)).reason, "history-client-bound");
    assert.equal(refused(clients.submit(null, 1)).reason, "malformed-request");
  }
  assert.equal(clients.report(1).replayRetainedRecords, 1);
  assert.equal(clients.report(1).replayRetainedClients, 2);
  assert.equal(clients.report(1).replayMaxClients, 2);
  assert.equal(clients.report(1).replayReadAdmissions, 0);
});

test("replay exhausted history never evicts a winner, drops receipts or resets its READY history", () => {
  const queue = new GithubReadQueueReplay({ enabled: true, maxRecords: 1, maxClients: 1 });
  queue.submit(request("winner"), 0);
  queue.admit("owner", 0);
  assert.equal(refused(queue.submit(request("peer"), 1)).reason, "history-client-bound");
  assert.equal(queue.cancelOwner("winner", "loser", 1), false);
  assert.equal(queue.complete("winner", "loser", observation(1), 1), false);
  assert.equal(queue.complete("winner", "owner", observation(1), 1), true);
  assert.equal(queue.receipt("winner", 1).status, "KNOWN");
  assert.equal(refused(queue.submit(request("winner", { clientId: "retry" }), 1)).reason, "read-id-reused");
  assert.equal(queue.receipt("winner", 1).origin!.readyAtMs, 0);
});

test("replay reports admissions and potential coalescing honestly even after a harness refusal", () => {
  const queue = enabled();
  queue.submit(request("first"), 0);
  queue.submit(request("second"), 0);
  queue.admit("owner", 0);
  queue.complete("first", "owner", { kind: "harness-config-refusal" }, 1);
  const report = queue.report(1);
  const receipt = queue.receipt("first", 1);
  assert.equal(report.replayReadAdmissions, 1);
  assert.equal(report.replayPotentialCoalescedClients, 1);
  assert.equal(report.replaySecondaryLimitSamples, 0);
  assert.equal(report.replayBackoffUntilMs, 0);
  assert.equal(report.replayMaxPending, 32);
  assert.equal(report.replayCadenceFloorMs, floor);
  assert.equal(receipt.reason, "harness-config-refusal");
  assert.equal(receipt.replayReadAdmitted, true);
  for (const oldClaim of ["replayReadAttempts", "replayCallsAvoided", "replayCoalescedClients", "replayReadAttempted"]) {
    assert.equal(Object.hasOwn(report, oldClaim), false);
    assert.equal(Object.hasOwn(receipt, oldClaim), false);
  }
  const cancelled = enabled();
  cancelled.submit(request("first"), 0);
  cancelled.submit(request("second"), 0);
  cancelled.cancelClient("first", 1);
  cancelled.cancelClient("second", 1);
  assert.equal(cancelled.report(1).replayPotentialCoalescedClients, 1);
  assert.equal(cancelled.report(1).replayReadAdmissions, 0);
});

test("replay snapshots bounded options without accessors, prototypes or symbols and refuses deadline overflow", () => {
  const options = { enabled: true, maxRecords: 1 };
  const queue = new GithubReadQueueReplay(options);
  options.maxRecords = 100;
  assert.equal(queue.report(0).replayMaxRecords, 1);
  let calls = 0;
  const accessor = { get enabled() { calls++; return true; } };
  for (const input of [null, [], accessor, Object.create({ enabled: true }), { enabled: true, [Symbol("extra")]: 1 },
    { enabled: true, maxRecords: 0 }, { enabled: true, token: "fixture-secret" }, { enabled: true, maxClients: Infinity }]) {
    assert.throws(() => new GithubReadQueueReplay(input), /invalid replay options/);
  }
  assert.equal(calls, 0);
  assert.equal(refused(queue.submit(request("overflow"), Number.MAX_SAFE_INTEGER)).reason, "invalid-wait-bound");
  assert.equal(queue.report(Number.MAX_SAFE_INTEGER).replayRetainedClients, 0);
});
