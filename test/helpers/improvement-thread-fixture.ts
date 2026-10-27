import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "#src/lib/clock.js";
import { CODE_HEALTH_POLICY_VERSION } from "#src/lib/code-health-collector.js";
import { codeHealthRepositoryStateDir, publishCodeHealthSnapshot } from "#src/lib/code-health-store.js";
import { buildCodeHealthOpportunities } from "#src/lib/codeql-quality-intake.js";
import type { CodeHealthProjectionInput } from "#src/lib/code-health-projection.js";

export function sourceFixture(dir: string, options: { findingTitle?: string; findingCount?: number; repository?: string; planPath?: string; stateDir?: string } = {}) {
  const stateDir = options.stateDir ?? join(dir, "fleet-state"), inboxRoot = join(dir, "atlas-instance"), repository = options.repository ?? "acme/atlas", instance = "atlas";
  const now = Date.now(), clock = fixedClock(now), sha = "a".repeat(40);
  const finding = { id: "42", ruleId: "js/repeated-work", status: "open" as const, severity: "medium" as const, category: "maintainability",
    path: "src/example.ts", title: options.findingTitle ?? "Repeated work makes this function difficult to change.", effortMinutes: null };
  const scans: CodeHealthProjectionInput["scans"] = ["quality", "coverage"].map(kind => ({ kind: kind as "quality" | "coverage", repository, scanId: `${kind}:new`, componentIds: [`${kind}:new`], analyzedSha: sha,
    observedAt: new Date(now - 3_600_000).toISOString(), state: "complete", scopeHash: `${kind}:scope`, toolVersion: "tool1", rulesVersion: "rules1", configHash: "config1", exclusions: [], reason: null,
    checks: [{ id: kind === "quality" ? "quality-maintainability-open" : "coverage-existing-tier", met: kind !== "quality", reason: kind === "quality" ? "A known code-maintenance finding remains open." : "Meets the existing coverage tier." }], findings: kind === "quality" ? Array.from({ length: options.findingCount ?? 1 }, (_, index) => ({ ...finding, id: String(42 + index) })) : [] }));
  const input: CodeHealthProjectionInput = { repository, analyzedSha: sha, currentSha: sha, observedAt: new Date(now - 3_540_000).toISOString(), nextDueAt: null,
    registry: { version: CODE_HEALTH_POLICY_VERSION, checks: [{ id: "quality-maintainability-open", sourceKind: "quality", category: "maintainability", description: "No unresolved findings in the measured maintainability scope." },
      { id: "coverage-existing-tier", sourceKind: "coverage", category: "tests", description: "Meets the existing instrumented coverage tier." }] }, scans,
    baseline: { analyzedSha: "b".repeat(40), policyVersion: CODE_HEALTH_POLICY_VERSION, scans: scans.map(scan => ({ ...structuredClone(scan), scanId: `${scan.kind}:old`, componentIds: [`${scan.kind}:old`], analyzedSha: "b".repeat(40), observedAt: new Date(now - 90_000_000).toISOString() })) } };
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "repositories-sources.json"), JSON.stringify({ instances: [{ instanceId: instance, options: { root: inboxRoot, controlRoot: inboxRoot, ledgerPath: join(inboxRoot, "state", "ledger.ndjson"), planPath: options.planPath ?? join(inboxRoot, "repos", "atlas", "plan", "tasks.yaml") } }], improvementEvidence: {
    version: "repository-evidence-inventory-v1", measurementState: "not_collected", repositories: [{ repository, instanceIds: [instance], expectedDailySources: ["pull_requests", "ledger_activity", "deployments"], expectedQualitySources: ["quality", "coverage"] }], unresolvedInstances: [] } }));
  const saved = publishCodeHealthSnapshot({ stateDir: codeHealthRepositoryStateDir(stateDir, repository), input, expectedSnapshotId: null, clock });
  assert(saved.state === "published"); const opportunity = buildCodeHealthOpportunities(input)[0]!; assert(opportunity.mayPlan);
  return { deps: { stateDir, actorId: "operator:test", clock }, request: { repository, instance, opportunityId: opportunity.id, snapshotId: saved.snapshotId,
    goal: "Simplify the repeated work while preserving behavior.", constraints: ["Keep required checks passing."], idempotencyKey: "creation-request-00000001" }, inboxRoot, input };
}
