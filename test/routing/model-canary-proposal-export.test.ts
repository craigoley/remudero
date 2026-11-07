import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExperimentProposal, type ImprovementEvidenceRowV1 } from "#src/lib/model-canary-proposal-export.js";

const digest = (n: number) => n.toString(16).padStart(64, "0");
function evidence(i: number, overrides: Partial<ImprovementEvidenceRowV1> = {}): ImprovementEvidenceRowV1 {
  return { signatureId: "sig-tool-timeout", failureClass: "tool-use-failure", caseId: `case-${i}`,
    sourceFamilyId: `family-${i}`, incidentRootId: `root-${i}`, evidenceDigest: digest(i + 1),
    executionSource: "native-provider-execution", split: "development", ...overrides };
}

test("W1-T11119 criterion 5: experiment proposal export stays unmeasured and writes no promotion event", () => {
  const result = buildExperimentProposal({ evidence: [evidence(1), evidence(2), evidence(3)] });
  assert.equal(result.state, "available");
  assert.equal(result.proposals.length, 1);
  const proposal = result.proposals[0]!;
  assert.equal(proposal.independentClusters, 3);
  assert.equal(proposal.outcome, "unmeasured");
  assert.equal(proposal.activation, "not-authorized");
  assert.ok(proposal.hypothesis);
  assert.ok(proposal.falsifier);
  assert.equal(result.effects.measured, false);
  assert.equal(result.effects.createsTasks, false);
  assert.equal(result.effects.createsSchedules, false);
  assert.equal(result.effects.writesLedger, false);
  assert.equal(result.effects.writesRoutingPolicy, false);
  assert.equal(result.effects.writesPromotionState, false);
  assert.deepEqual(result.exclusions, { syntheticControlEvidence: 0 });
});

test("experiment proposal export withholds repeated evidence from one family cluster", () => {
  const result = buildExperimentProposal({ evidence: [
    evidence(1), evidence(2, { sourceFamilyId: "family-1", incidentRootId: "root-1" }),
  ] });
  assert.equal(result.state, "unavailable");
  assert.equal(result.proposals.length, 0);
});

test("experiment proposal export rejects contradictory duplicate evidence", () => {
  assert.throws(() => buildExperimentProposal({ evidence: [
    evidence(1), evidence(1, { evidenceDigest: digest(99) }),
  ] }), /experiment-proposal-duplicate-evidence-contradictory/);
});

test("experiment proposal export keeps failure classes separate", () => {
  const result = buildExperimentProposal({ evidence: [
    evidence(1), evidence(2), evidence(3),
    evidence(4, { signatureId: "sig-cost", failureClass: "cost-regression" }),
    evidence(5, { signatureId: "sig-cost", failureClass: "cost-regression" }),
  ] });
  assert.equal(result.proposals.length, 2);
  assert.deepEqual(result.proposals.map(item => item.failureClass).sort(), ["cost-regression", "tool-use-failure"]);
});


test("W1-T11119 criterion 7: improvement proposal export is pure and invokes no writer or activation effects", () => {
  const result = buildExperimentProposal({ evidence: [evidence(1), evidence(2), evidence(3)] });
  assert.equal(result.proposals[0]!.outcome, "unmeasured");
  assert.equal(result.proposals[0]!.activation, "not-authorized");
  assert.deepEqual(result.effects, { measured: false, createsTasks: false, createsSchedules: false,
    writesLedger: false, writesRoutingPolicy: false, writesPromotionState: false });
});

test("synthetic-only failures never produce provider improvement proposals", () => {
  const result = buildExperimentProposal({ evidence: [
    evidence(1, { executionSource: "synthetic-control-replay" }),
    evidence(2, { executionSource: "synthetic-control-replay" }),
    evidence(3, { executionSource: "synthetic-control-replay" }),
  ] });
  assert.equal(result.state, "unavailable");
  assert.equal(result.proposals.length, 0);
  assert.equal(result.exclusions.syntheticControlEvidence, 3);
});

test("sealed holdout failures cannot create or steer development proposals", () => {
  const result = buildExperimentProposal({ evidence: [
    evidence(1, { split: "sealed-holdout" }), evidence(2, { split: "sealed-holdout" }),
    evidence(3, { split: "sealed-holdout" }),
  ] });
  assert.equal(result.state, "unavailable");
  assert.equal(result.proposals.length, 0);
  assert.equal(result.exclusions.syntheticControlEvidence, 0);
});
