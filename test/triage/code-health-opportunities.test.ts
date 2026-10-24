import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCodeHealthOpportunities, codeqlQualityProposalId } from "#src/lib/codeql-quality-intake.js";
import type { CodeHealthProjectionInput, CodeHealthScanFinding } from "#src/lib/code-health-projection.js";

function input(): CodeHealthProjectionInput {
  const findings: CodeHealthScanFinding[] = [
    { id: "41", ruleId: "js/repeated-work", status: "open", severity: "critical", category: "maintainability", path: "src/first.ts", title: "Repeated work makes this function difficult to change.", effortMinutes: 10 },
    { id: "42", ruleId: "js/repeated-work", status: "open", severity: "low", category: "maintainability", path: "src/second.ts", title: "Repeated work makes this function difficult to change.", effortMinutes: null },
  ];
  const scans: CodeHealthProjectionInput["scans"] = ["quality", "coverage"].map(kind => ({
    kind: kind as "quality" | "coverage", repository: "acme/atlas", scanId: `${kind}:new`, analyzedSha: "a".repeat(40), observedAt: "2026-11-02T05:00:00.000Z",
    state: "complete", scopeHash: "scope1", toolVersion: "tool1", rulesVersion: "rules1", configHash: "config1", exclusions: [], reason: null,
    findings: kind === "quality" ? [...findings, structuredClone(findings[0]!)] : [], checks: [{ id: kind, met: kind !== "quality", reason: kind === "quality" ? "Two open findings in the measured maintainability subset." : "Meets the configured coverage baseline." }],
  }));
  return { repository: "acme/atlas", currentSha: "a".repeat(40), observedAt: "2026-11-02T05:01:00.000Z", nextDueAt: null,
    registry: { version: "checks1", checks: [{ id: "quality", sourceKind: "quality", category: "maintainability", description: "No findings in the measured maintainability subset." },
      { id: "coverage", sourceKind: "coverage", category: "tests", description: "Meets the existing coverage baseline." }] }, scans,
    baseline: { analyzedSha: "b".repeat(40), policyVersion: "checks1", scans: scans.map(scan => ({ ...structuredClone(scan), scanId: `${scan.kind}:old`, analyzedSha: "b".repeat(40), observedAt: "2026-11-01T05:00:00.000Z" })) } };
}

test("code health deduplicates opportunities and preserves urgent findings", () => {
  const value = input(), proposalId = codeqlQualityProposalId("js/repeated-work");
  const related = [{ repository: "acme/atlas", proposalId, taskId: "W1-T7", prUrl: "https://github.com/acme/atlas/pull/7", threadId: "thread:existing" },
    { repository: "acme/foreign", proposalId, taskId: "W1-T8", prUrl: "https://github.com/acme/foreign/pull/8", threadId: "thread:foreign" }];
  const opportunities = buildCodeHealthOpportunities(value, related);
  assert.equal(opportunities.length, 1, "the existing native rule identity groups related findings once");
  const opportunity = opportunities[0]!;
  assert.equal(opportunity.proposalId, proposalId);
  assert.equal(opportunity.id, `acme/atlas/${proposalId}`);
  assert.equal(opportunity.evidence.length, 2, "duplicate copies cannot inflate evidence or effort");
  assert.deepEqual(new Set(opportunity.evidence.map(finding => finding.severity)), new Set(["critical", "low"]));
  assert.deepEqual(opportunity.relatedWork, [related[0]], "reuse scoped existing work without linking a foreign repository");
  assert.equal(opportunity.effortMinutes, null, "one missing estimate cannot become an exact summed estimate");
  assert.equal(opportunity.estimateKind, null);
  assert.equal(opportunity.mayPlan, true);
  assert(opportunity.consequence.length > 0 && opportunity.expectedResult.length > 0 && opportunity.acceptanceIdeas.length > 0);
  const reordered = structuredClone(value); reordered.scans.reverse(); reordered.scans.find(scan => scan.kind === "quality")!.findings.reverse();
  const retry = buildCodeHealthOpportunities(reordered, related)[0]!;
  assert.equal(retry.id, opportunity.id);
  assert.equal(retry.snapshotId, opportunity.snapshotId, "source order does not mint a different immutable snapshot");
  const renamed = structuredClone(value); renamed.scans[0]!.findings.forEach(finding => { finding.title = "Updated source explanation."; finding.path = "src/moved.ts"; });
  const update = buildCodeHealthOpportunities(renamed, related)[0]!;
  assert.equal(update.id, opportunity.id, "a moved finding reuses its work package");
  assert.notEqual(update.snapshotId, opportunity.snapshotId, "changed evidence keeps a different snapshot identity");
  const stale = structuredClone(value); stale.scans[0]!.state = "stale"; stale.scans[0]!.reason = "The scan is overdue.";
  const held = buildCodeHealthOpportunities(stale, related)[0]!;
  assert.equal(held.evidence.length, 2, "stale evidence does not hide known urgent findings");
  assert.equal(held.mayPlan, false, "an old reading does not authorize a new actionable conversation");
  assert(held.uncertainty.length > 0);
});
