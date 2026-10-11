import assert from "node:assert/strict";
import { test } from "node:test";
import { executeAdmissionDisposition, type AdmissionDispositionReceipt, type AdmissionDispositionStore,
  type AdmissionDispositionSimulation } from "../src/lib/action-executor.js";
import type { AdmissionRead, AdmissionSettings } from "../src/lib/contributor-admission.js";

const sha = "a".repeat(40);
const target = { owner: "acme", repo: "core", prNumber: 42, headSha: sha };
const settings: AdmissionSettings = { mode: "shadow", disposition: "shadow", repositoryId: 3,
  policy: { version: "fixture-v1", ownerIds: [1], organizationIds: [], services: [{ id: 2, actions: ["disposition"] }], maxEvidenceAgeMs: 60_000 },
  organizations: [] };
const NOW = Date.parse("2026-10-11T12:00:00Z");
const clock = { now: () => NOW };
const pull = (id = 8, head = sha, state = "open") => ({ id: 1042, number: 42, state, merged: false, merged_at: null,
  user: { id, type: id === 2 ? "Bot" : "User", login: `actor-${id}` },
  head: { sha: head, ref: "feature", repo: { id: 4, full_name: "outside/core", private: false } },
  base: { ref: "main", repo: { id: 3, full_name: "acme/core", private: false } } });

function memoryStore(domain: AdmissionDispositionStore["domain"] = "shadow") {
  const rows: AdmissionDispositionReceipt[] = [];
  const store: AdmissionDispositionStore = { domain,
    load: async cause => structuredClone(rows.filter(r => r.cause === cause)),
    append: async receipt => { assert.equal(receipt.sequence, rows.filter(r => r.cause === receipt.cause).length);
      rows.push(structuredClone(receipt)); } };
  return { store, rows };
}
function source(row: ReturnType<typeof pull> = pull()): AdmissionRead {
  return async path => ({ status: 200, body: path === "repos/acme/core" ? { id: 3, full_name: "acme/core", private: false }
    : path.includes("/pulls/") ? structuredClone(row) : {} });
}
function rehearsal() {
  let closes = 0, escalations = 0;
  const simulation: AdmissionDispositionSimulation = { domain: "rehearsal",
    simulateClose: async () => { closes++; }, simulateEscalation: async () => { escalations++; },
    reconcile: async () => ({ closed: closes > 0, escalated: escalations > 0 }) };
  return { simulation, counts: () => [closes, escalations] };
}

test("W1-T7755: close preflight rejects unknown trusted changed and terminal PRs", async () => {
  for (const [row, expected] of [[pull(1), "trusted"], [pull(2), "trusted"],
    [pull(8, "b".repeat(40)), "pending"], [pull(8, sha, "closed"), "noop"],
    [{ ...pull(), merged: true }, "noop"]] as const) {
    const { store } = memoryStore("rehearsal"); const sim = rehearsal();
    const result = await executeAdmissionDisposition({ settings, target }, store, source(row), () => {}, clock, sim.simulation);
    assert.equal(result.status, expected); assert.deepEqual(sim.counts(), [0, 0]);
    assert.equal(result.permission, "not-granted");
  }
  const { store } = memoryStore("rehearsal"); const sim = rehearsal();
  const result = await executeAdmissionDisposition({ settings, target }, store, async () => ({ status: 403, body: {} }), () => {}, clock, sim.simulation);
  assert.equal(result.status, "pending"); assert.deepEqual(sim.counts(), [0, 0]);
});

test("W1-T7755: close and escalation replay produces one durable terminal receipt", async () => {
  const { store, rows } = memoryStore("rehearsal"); const sim = rehearsal();
  const result = await executeAdmissionDisposition({ settings, target }, store, source(), () => {}, clock, sim.simulation);
  assert.equal(result.status, "simulated-closed");
  const replay = await executeAdmissionDisposition({ settings, target }, store, source(), () => {}, clock, sim.simulation);
  assert.equal(replay.status, "simulated-closed"); assert.deepEqual(sim.counts(), [1, 1]);
  assert.equal(rows.filter(r => r.status === "simulated-closed").length, 1);
  assert.equal(rows.at(-1)?.closeAttempts, 1); assert.equal(rows.at(-1)?.escalationAttempts, 1);
  assert.equal(rows.at(-1)?.domain, "rehearsal");
});

test("W1-T7755: unknown recovery is bounded without closing or blocking trusted PRs", async () => {
  const { store, rows } = memoryStore("rehearsal"); const sim = rehearsal(); let reads = 0;
  const outage: AdmissionRead = async () => { reads++; throw Error("unavailable"); };
  for (let attempt = 0; attempt < 5; attempt++) {
    const revision = { ...settings, policy: { ...settings.policy, version: `v${attempt}` } };
    await executeAdmissionDisposition({ settings: revision, target: { ...target, headSha: String(attempt).repeat(40) } }, store, outage, () => {}, clock, sim.simulation);
  }
  assert.equal(rows.at(-1)?.status, "owner-action"); assert.equal(rows.at(-1)?.identityAttempts, 3);
  assert.ok(reads <= 3); assert.deepEqual(sim.counts(), [0, 0]);
  assert.equal(rows.every(r => r.firstReason === rows[0].firstReason), true);
  const trusted = await executeAdmissionDisposition({ settings, target: { ...target, prNumber: 43 } }, store,
    async path => ({ status: 200, body: path.endsWith("/43") ? { ...pull(1), number: 43, id: 1043 }
      : { id: 3, full_name: "acme/core", private: false } }), () => {}, clock, sim.simulation);
  assert.equal(trusted.status, "trusted"); assert.equal(trusted.laneReleased, true);
});

test("W1-T7755: owner adoption resumes flow with honest required checks", async () => {
  const { store } = memoryStore();
  for (let i = 0; i < 3; i++) await executeAdmissionDisposition({ settings, target }, store,
    async () => ({ status: 503, body: {} }), () => {}, clock);
  const instruction = { id: 9, user: { id: 1, type: "User" }, updated_at: new Date(NOW).toISOString(),
    issue_url: "https://api.github.com/repos/acme/core/issues/42", body: `Remudero-Admission: adopt 3/42@${sha}` };
  const read: AdmissionRead = async path => path.endsWith("/comments/9") ? { status: 200, body: instruction } : source()(path);
  const adopted = await executeAdmissionDisposition({ settings, target, ownerInstructionId: 9 }, store, read, () => {}, clock);
  assert.equal(adopted.status, "adopted"); assert.equal(adopted.laneReleased, true);
  assert.equal(adopted.requiredChecks, "ordinary-current-head-checks-required");
  assert.equal(adopted.permission, "not-granted");
  const bad = await executeAdmissionDisposition({ settings, target: { ...target, headSha: "b".repeat(40) }, ownerInstructionId: 9 }, store, read, () => {}, clock);
  assert.notEqual(bad.status, "adopted");
});

test("W1-T7755: shadow and absent config never invoke disposable effects", async () => {
  const { store } = memoryStore(); let reads = 0;
  const read: AdmissionRead = async path => { reads++; return source()(path); };
  const absent = await executeAdmissionDisposition({ target }, store, read, () => {}, clock);
  assert.equal(absent.status, "not-enabled"); assert.equal(reads, 0);
  const observed = await executeAdmissionDisposition({ settings, target }, store, read, () => {}, clock);
  assert.equal(observed.status, "would-close"); assert.equal(observed.permission, "not-granted");
});
