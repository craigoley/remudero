import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "#test/helpers/repo-root.js";
import { withTempDir } from "#src/lib/tmp.js";
import { buildCodeHealthOpportunities, codeqlQualityProposalId, qualityScanFromCollectedEvidence, readCodeHealthSnapshot, publishCodeHealthSnapshot } from "#src/lib/codeql-quality-intake.js";
import type { CodeHealthProjectionInput, CodeHealthScanFinding } from "#src/lib/code-health-projection.js";
import { readCoverageNightlySummary } from "#src/lib/coverage-nightly-intake.js";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { fixedClock } from "#src/lib/clock.js";
import { readCodeScanningAlerts } from "#src/lib/ops.js";
import { ghStubPath, pathWith } from "#test/helpers/gh-stub.js";

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
  return { repository: "acme/atlas", currentSha: "a".repeat(40), analyzedSha: "a".repeat(40), observedAt: "2026-11-02T05:01:00.000Z", nextDueAt: null,
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
  const otherBaseline = structuredClone(value); otherBaseline.baseline!.scans[0]!.scanId = "quality:another-baseline";
  assert.notEqual(buildCodeHealthOpportunities(otherBaseline, related)[0]!.snapshotId, opportunity.snapshotId,
    "another baseline scan is different immutable evidence even when its code and finding states match");
  const renamed = structuredClone(value); renamed.scans[0]!.findings.forEach(finding => { finding.title = "Updated source explanation."; finding.path = "src/moved.ts"; });
  const update = buildCodeHealthOpportunities(renamed, related)[0]!;
  assert.equal(update.id, opportunity.id, "a moved finding reuses its work package");
  assert.notEqual(update.snapshotId, opportunity.snapshotId, "changed evidence keeps a different snapshot identity");
  const stale = structuredClone(value); stale.scans[0]!.state = "stale"; stale.scans[0]!.reason = "The scan is overdue.";
  const held = buildCodeHealthOpportunities(stale, related)[0]!;
  assert.equal(held.evidence.length, 2, "stale evidence does not hide known urgent findings");
  assert.equal(held.mayPlan, false, "an old reading does not authorize a new actionable conversation");
  assert(held.uncertainty.length > 0);
  const dismissed = structuredClone(value); dismissed.scans[0]!.findings.forEach(finding => { finding.status = "dismissed"; });
  assert.equal(buildCodeHealthOpportunities(dismissed, related).length, 0, "retaining a dismissed finding does not silently reopen its work");
});

test("code health retains analysis identity through the real alert reader", () => {
  const payload = [{ number: 41, state: "open", created_at: "2026-11-01T05:00:00Z",
    html_url: "https://github.com/acme/atlas/security/code-scanning/41",
    tool: { name: "CodeQL", version: "2.25.0" },
    rule: { id: "js/repeated-work", severity: "warning", tags: ["quality", "maintainability"] },
    most_recent_instance: { ref: "refs/heads/main", commit_sha: "a".repeat(40), analysis_key: ".github/workflows/codeql.yml:analyze",
      category: "/language:javascript-typescript", environment: '{"language":"javascript-typescript","private":"do-not-copy"}', state: "open",
      location: { path: "src/first.ts", start_line: 5 } } },
    { number: 42, state: "open", created_at: "2026-11-01T05:00:00Z", html_url: "https://github.com/acme/atlas/security/code-scanning/42",
      tool: { name: "CodeQL" }, rule: { id: "js/repeated-work", severity: "warning", tags: ["quality", "maintainability"] } }];
  const bin = ghStubPath(`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`);
  const saved = process.env.PATH; process.env.PATH = pathWith(bin);
  try {
    const read = readCodeScanningAlerts("acme", "atlas", { includeAnalysisInstances: true });
    assert.equal(read.ok, true, "the default reader executes the real fixture process and decodes its response");
    assert.equal(read.alerts.length, 2);
    assert.equal(read.analysisInstances?.length, 2);
    const source = read.analysisInstances![0]!;
    assert.equal(source.alertId, "41");
    assert.equal(source.analyzedSha, "a".repeat(40));
    assert.equal(source.toolVersion, "2.25.0");
    assert.equal(source.ref, "refs/heads/main");
    assert.equal(source.category, "/language:javascript-typescript");
    assert.equal(source.analysisKey, ".github/workflows/codeql.yml:analyze");
    assert.equal(source.instanceState, "open");
    assert.match(source.environmentHash!, /^[a-f0-9]{64}$/);
    assert(!JSON.stringify(source).includes("do-not-copy"), "retain a stable environment identity without copying its private values");
    assert.deepEqual(read.analysisInstances![1], { alertId: "42", analyzedSha: null, toolVersion: null, ref: null, analysisKey: null,
      category: null, environmentHash: null, instanceState: null }, "missing source metadata stays unknown");
    const ordinary = readCodeScanningAlerts("acme", "atlas");
    assert.equal(ordinary.ok, true);
    assert.equal(Object.hasOwn(ordinary, "analysisInstances"), false, "ordinary alert callers keep their existing bounded response");
  } finally { process.env.PATH = saved; }
});


test("code health exports bounded provenance without publishing security results", async () => {
  await withTempDir("code-health-provenance", async dir => {
    const raw = { repository: "acme/atlas", analyzedSha: "a".repeat(40), ref: "refs/heads/main", runId: "123", runAttempt: "1",
      observedAt: "2026-11-02T05:00:00.000Z", language: "javascript-typescript", sarifId: "12345678-1234-1234-1234-123456789012",
      config: "paths-ignore: [test/**]", exclusions: ["test/**"],
      sarif: { version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL", version: "2.23.0", rules: [{ id: "js/example", defaultConfiguration: { enabled: true } }] }, extensions: [] },
        artifacts: [{ location: { uri: "src/example.ts" }, roles: ["analysisTarget"] }],
        invocations: [{ executionSuccessful: true, endTimeUtc: "2026-11-02T04:59:00.000Z" }],
        results: [{ ruleId: "js/example", message: { text: "private security detail must not escape" }, codeFlows: [{ private: "secret source code" }] }] }] } };
    const inputPath = join(dir, "input.json"), output = join(dir, "provenance.json");
    let outputIndex = 0;
    const run = (value: unknown) => {
      writeFileSync(inputPath, JSON.stringify(value));
      const outputPath = join(dir, `output-${outputIndex++}.json`);
      execFileSync(process.execPath, [join(repoRoot(), "scripts/code-health-provenance.mjs"), "--input", inputPath, "--output", outputPath], { encoding: "utf8" });
      return JSON.parse(readFileSync(outputPath, "utf8"));
    };
    const manifest = run(raw);
    const original = structuredClone(raw.sarif);
    original.runs[0]!.invocations[0]!.endTimeUtc = new Date(Date.now() - 1000).toISOString();
    const sarifDir = join(dir, "original"); mkdirSync(sarifDir);
    writeFileSync(join(sarifDir, "javascript.sarif"), JSON.stringify(original));
    const config = join(dir, "codeql.yml"), workflow = join(dir, "workflow.yml"), productionOutput = join(dir, "production.json");
    writeFileSync(config, '# Existing configuration\npaths-ignore:\n  - "test/**"\n');
    writeFileSync(workflow, 'queries: security-and-quality\n');
    execFileSync(process.execPath, [join(repoRoot(), "scripts/code-health-provenance.mjs"), "--sarif-dir", sarifDir,
      "--config", config, "--workflow", workflow, "--output", productionOutput], { encoding: "utf8", env: { ...process.env,
        GITHUB_REPOSITORY: raw.repository, GITHUB_SHA: raw.analyzedSha, GITHUB_REF: raw.ref, GITHUB_RUN_ID: raw.runId,
        GITHUB_RUN_ATTEMPT: raw.runAttempt, CODE_HEALTH_LANGUAGE: raw.language, CODE_HEALTH_SARIF_ID: raw.sarifId } });
    const produced = JSON.parse(readFileSync(productionOutput, "utf8"));
    assert.equal(produced.state, "complete", "the real workflow-facing CLI reads original output without installing dependencies");
    assert.deepEqual(produced.exclusions, ["test/**"]);
    assert.equal(produced.scope.hash, manifest.scope.hash);
    const withoutInvocation = structuredClone(original);
    delete (withoutInvocation.runs[0] as { invocations?: unknown }).invocations;
    writeFileSync(join(sarifDir, "javascript.sarif"), JSON.stringify(withoutInvocation));
    const completedOutput = join(dir, "workflow-completion.json");
    execFileSync(process.execPath, [join(repoRoot(), "scripts/code-health-provenance.mjs"), "--sarif-dir", sarifDir,
      "--config", config, "--workflow", workflow, "--output", completedOutput], { encoding: "utf8", env: { ...process.env,
        GITHUB_REPOSITORY: raw.repository, GITHUB_SHA: raw.analyzedSha, GITHUB_REF: raw.ref, GITHUB_RUN_ID: raw.runId,
        GITHUB_RUN_ATTEMPT: raw.runAttempt, CODE_HEALTH_LANGUAGE: raw.language, CODE_HEALTH_SARIF_ID: raw.sarifId,
        CODE_HEALTH_ANALYSIS_OUTCOME: "success" } });
    const completed = JSON.parse(readFileSync(completedOutput, "utf8"));
    assert.equal(completed.state, "complete", "the existing successful workflow step can attest optional SARIF completion fields");
    assert.equal(completed.completion.kind, "workflow-analysis-step");
    assert.equal(completed.completion.state, "success");

    assert.equal(manifest.version, "code-health-source-v1");
    assert.equal(manifest.repository, "acme/atlas");
    assert.equal(manifest.analyzedSha, raw.analyzedSha);
    assert.equal(manifest.scope.fileCount, 1);
    assert.match(manifest.scope.hash, /^[a-f0-9]{64}$/);
    assert.equal(manifest.state, "complete");
    assert.equal(manifest.toolVersion, "2.23.0");
    assert(!JSON.stringify(manifest).includes("private security"));
    assert(!JSON.stringify(manifest).includes("secret source code"));
    assert(!JSON.stringify(manifest).includes("src/example.ts"), "publish the measured inventory hash, not source locations");
    const resultOnly = structuredClone(raw); delete (resultOnly.sarif.runs[0]!.artifacts[0] as { roles?: string[] }).roles;
    const incomplete = run(resultOnly);
    assert.equal(incomplete.state, "partial", "result locations are not proof of measured files");
    assert.equal(incomplete.scope.hash, null);
    const failed = structuredClone(raw); failed.sarif.runs[0]!.invocations[0]!.executionSuccessful = false;
    assert.equal(run(failed).state, "partial");
    const narrowed = structuredClone(raw); narrowed.exclusions.push("src/private/**");
    assert.notEqual(run(narrowed).configHash, manifest.configHash);
    writeFileSync(inputPath, JSON.stringify({ ...raw, analyzedSha: "wrong" }));
    assert.throws(() => execFileSync(process.execPath, [join(repoRoot(), "scripts/code-health-provenance.mjs"), "--input", inputPath, "--output", output], { stdio: "pipe" }), /failed/i);
  });
});


test("code health binds coverage provenance to the existing measured inventory and policy", async () => {
  await withTempDir("code-health-coverage", async dir => {
    const summary = { kind: "coverage_nightly.measured", repository: "acme/atlas", sha: "a".repeat(40), ref: "refs/heads/main", run_id: "123",
      measured_at: "2026-11-02T05:00:00.000Z", lines_pct: 100, branches_pct: 90, lf: 2, lh: 2, brf: 10, brh: 9,
      skipped_records: 0, tier: "healthy", shard_test_exits: Object.fromEntries(Array.from({ length: 8 }, (_, n) => [String(n + 1), 0])) };
    const lcov = "SF:src/example.ts\nDA:1,1\nDA:2,1\nLF:2\nLH:2\nBRF:10\nBRH:9\nend_of_record\n";
    const baseline = { tierPassPct: 90, tierBlockPct: 85 };
    let serial = 0;
    const run = (value = summary, coverage = lcov, policy = baseline) => {
      const input = join(dir, "summary.json"), report = join(dir, "lcov.info"), config = join(dir, "baseline.json"), workflow = join(dir, "workflow.yml"), output = join(dir, `coverage-${serial++}.json`);
      writeFileSync(input, JSON.stringify(value)); writeFileSync(report, coverage); writeFileSync(config, JSON.stringify(policy));
      writeFileSync(workflow, 'node --select-all --experimental-test-coverage --test-coverage-exclude="test/**"\n');
      execFileSync(process.execPath, [join(repoRoot(), "scripts/code-health-provenance.mjs"), "--coverage-summary", input,
        "--lcov", report, "--baseline", config, "--workflow", workflow, "--output", output], { stdio: "pipe", env: { ...process.env, GITHUB_REPOSITORY: "acme/atlas" } });
      return JSON.parse(readFileSync(output, "utf8")).code_health;
    };
    const measured = run();
    assert.equal(measured.state, "complete"); assert.equal(measured.scope.fileCount, 1);
    assert.equal(measured.repository, "acme/atlas"); assert.equal(measured.analyzedSha, summary.sha);
    assert.equal(measured.observedAt, summary.measured_at);
    assert.deepEqual(measured.exclusions, ["test/**"]);
    assert.equal(measured.check.met, true);
    const missing = structuredClone(summary); delete (missing.shard_test_exits as Record<string, number>)["8"];
    assert.equal(run(missing).state, "partial", "all eight required shards must be present");
    const red = structuredClone(summary); red.shard_test_exits["3"] = 1;
    assert.equal(run(red).state, "partial", "a failing suite cannot certify complete coverage");
    const wrongTotal = { ...summary, lf: 3 };
    assert.equal(run(wrongTotal).state, "partial", "summary and original LCOV must agree");
    assert.equal(run(summary, "").state, "partial", "an empty measured population is unknown");
    const changed = run(summary, lcov.replace("src/example.ts", "src/other.ts"));
    assert.notEqual(changed.scope.hash, measured.scope.hash);
    const newPolicy = run(summary, lcov, { tierPassPct: 91, tierBlockPct: 85 });
    assert.notEqual(newPolicy.rulesVersion, measured.rulesVersion);
    assert.equal(newPolicy.check.met, false, "use existing policy rather than inventing a score threshold");
  });
});


test("code health retains coverage provenance at the existing ledger boundary", async () => {
  await withTempDir("code-health-intake", async dir => {
    const at = new Date().toISOString(), sha = "a".repeat(40), ledgerPath = join(dir, "ledger.ndjson");
    const provenance = { version: "code-health-source-v1", kind: "coverage", repository: "acme/atlas", analyzedSha: sha,
      ref: "refs/heads/main", runId: "123", observedAt: at, scanId: "coverage-nightly:123", state: "complete", reasons: [], toolVersion: "v24.21.0",
      rulesVersion: "b".repeat(64), configHash: "c".repeat(64), exclusions: ["test/**"], scope: { kind: "instrumented-source-lines", fileCount: 1, hash: "d".repeat(64) },
      check: { id: "coverage-existing-tier", met: true, reason: "Instrumented branch coverage is in the existing healthy tier." } };
    const summary = { kind: "coverage_nightly.measured", sha, ref: "refs/heads/main", run_id: "123", measured_at: at,
      lines_pct: 100, branches_pct: 90, lf: 2, lh: 2, brf: 10, brh: 9, skipped_records: 0, tier: "healthy",
      shard_test_exits: Object.fromEntries(Array.from({ length: 8 }, (_, n) => [String(n + 1), 0])), code_health: provenance };
    const opts = { ledgerPath, owner: "acme", repo: "atlas", clock: fixedClock(Date.parse(at)), cadence: { check: () => ({ fire: true, reason: "due" }), record: () => {} },
      reader: { newestCompletedRun: async () => ({ id: 123, head_sha: sha, head_branch: "main", status: "completed", conclusion: "success" }), summaryForRun: async () => summary }, log: () => {} };
    assert.equal((await readCoverageNightlySummary(opts)).status, "appended");
    const stored = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
    assert.deepEqual(stored.code_health, provenance, "keep allowlisted source facts in the same durable ledger");
    const foreignDir = join(dir, "foreign"); mkdirSync(foreignDir);
    const foreign = { ...summary, code_health: { ...provenance, repository: "acme/foreign" } };
    const refused = await readCoverageNightlySummary({ ...opts, ledgerPath: join(foreignDir, "ledger.ndjson"),
      reader: { ...opts.reader, summaryForRun: async () => foreign } });
    assert.equal(refused.status, "failed", "foreign source metadata is refused before publication");
  });
});


test("code health requires every configured analysis before treating quality evidence as complete", () => {
  const sha = "a".repeat(40), requiredLanguages = ["javascript-typescript", "actions", "python"];
  const artifacts = requiredLanguages.map((language, n) => ({ version: "code-health-source-v1", kind: "quality", repository: "acme/atlas", analyzedSha: sha,
    ref: "refs/heads/main", runId: "123", runAttempt: "1", observedAt: "2026-11-02T05:00:00.000Z", language,
    sarifId: `${n + 1}2345678-1234-1234-1234-123456789012`, scanId: `codeql:123:1:${language}:${n + 1}2345678-1234-1234-1234-123456789012`,
    state: "complete", reasons: [], toolVersion: "2.23.0", rulesVersion: "b".repeat(64), configHash: "c".repeat(64), ruleCount: 12,
    exclusions: ["test/**"], scope: { kind: "explicit-analysis-targets", fileCount: 2, hash: "d".repeat(64) },
    completion: { kind: "workflow-analysis-step", state: "success", at: "2026-11-02T05:00:00.000Z" } }));
  const analyses = artifacts.map(artifact => ({ sarifId: artifact.sarifId, analyzedSha: sha, category: `/language:${artifact.language}`,
    toolVersion: "2.23.0", analysisKey: ".github/workflows/codeql.yml:analyze", environmentHash: "e".repeat(64), createdAt: "2026-11-02T04:59:00.000Z", rulesCount: 12, error: "", warning: "" }));
  const value = { repository: "acme/atlas", analyzedSha: sha, runId: "123", requiredLanguages, artifacts, analyses,
    source: { ok: true as const, alerts: [{ source: "code-scanning" as const, id: "42", severity: "high" as const, state: "open", createdAt: "2026-11-01T05:00:00.000Z",
      summary: "Repeated work is hard to change.", url: "https://github.com/acme/atlas/security/code-scanning/42", toolName: "CodeQL", ruleId: "js/repeated-work",
      ruleTags: ["quality", "maintainability"], location: { path: "src/example.ts" } }],
      analysisInstances: [{ alertId: "42", analyzedSha: sha, toolVersion: "2.23.0", ref: "refs/heads/main", analysisKey: analyses[0]!.analysisKey,
        category: analyses[0]!.category, environmentHash: analyses[0]!.environmentHash, instanceState: "open" }] } };
  const positive = qualityScanFromCollectedEvidence(value);
  assert.equal(positive.state, "complete"); assert.equal(positive.findings.length, 1); assert.equal(positive.checks[0]!.met, false);
  assert.equal(positive.observedAt, artifacts[0]!.observedAt);
  const zero = qualityScanFromCollectedEvidence({ ...value, source: { ok: true, alerts: [], analysisInstances: [] } });
  assert.equal(zero.state, "complete", "a zero-alert result has all required source-population controls"); assert.equal(zero.checks[0]!.met, true);
  const missing = qualityScanFromCollectedEvidence({ ...value, artifacts: artifacts.slice(0, 2) });
  assert.equal(missing.state, "partial"); assert.equal(missing.findings.length, 1);
  const foreign = structuredClone(value); foreign.artifacts[0]!.repository = "acme/foreign";
  assert.throws(() => qualityScanFromCollectedEvidence(foreign), /provenance|repository/i);
  const mismatch = structuredClone(value); mismatch.source.analysisInstances[0]!.analyzedSha = "f".repeat(40);
  assert.equal(qualityScanFromCollectedEvidence(mismatch).state, "partial");
  const wrongAnalysis = structuredClone(value); wrongAnalysis.analyses[0]!.sarifId = "f2345678-1234-1234-1234-123456789012";
  assert.equal(qualityScanFromCollectedEvidence(wrongAnalysis).state, "partial");
  const dismissed = structuredClone(value); dismissed.source.alerts[0]!.state = "dismissed";
  const retained = qualityScanFromCollectedEvidence(dismissed);
  assert.equal(retained.state, "complete", "GitHub can retain an open most-recent instance for a dismissed alert");
  assert.equal(retained.findings[0]!.status, "dismissed"); assert.equal(retained.checks[0]!.met, false);
  assert.equal(qualityScanFromCollectedEvidence({ ...value, source: { ok: false, error: "unavailable" } }).state, "unavailable");
});


test("code health publishes immutable evidence and refuses stale or occupied publication", async () => {
  await withTempDir("code-health-store", async stateDir => {
    assert.equal(readCodeHealthSnapshot(stateDir, "acme/atlas").state, "not_collected");
    const first = publishCodeHealthSnapshot({ stateDir, input: input(), expectedSnapshotId: null });
    assert.equal(first.state, "published"); assert("snapshotId" in first);
    const read = readCodeHealthSnapshot(stateDir, "acme/atlas");
    assert.equal(read.state, "observed"); assert("snapshot" in read);
    assert.equal(read.snapshot.snapshotId, first.snapshotId);
    assert.deepEqual(read.snapshot.input, input());
    const reread = input(); reread.observedAt = "2026-11-02T05:02:00.000Z";
    const duplicate = publishCodeHealthSnapshot({ stateDir, input: reread, expectedSnapshotId: first.snapshotId });
    assert.equal(duplicate.state, "duplicate"); assert("snapshotId" in duplicate); assert.equal(duplicate.snapshotId, first.snapshotId);
    const next = input(); next.scans.forEach(scan => { scan.scanId += ":independent"; });
    const published = publishCodeHealthSnapshot({ stateDir, input: next, expectedSnapshotId: first.snapshotId });
    assert.equal(published.state, "published"); assert("snapshotId" in published);
    assert.notEqual(published.snapshotId, first.snapshotId);
    assert.equal(publishCodeHealthSnapshot({ stateDir, input: input(), expectedSnapshotId: first.snapshotId }).state, "superseded");
    const current = readCodeHealthSnapshot(stateDir, "acme/atlas"); assert.equal(current.state, "observed"); assert("snapshot" in current);
    assert.equal(current.snapshot.snapshotId, published.snapshotId);
    const historical = readCodeHealthSnapshot(stateDir, "acme/atlas", first.snapshotId);
    assert.equal(historical.state, "observed"); assert("snapshot" in historical); assert.deepEqual(historical.snapshot.input, input());
    assert.equal(readCodeHealthSnapshot(stateDir, "acme/foreign").state, "unavailable");
    const lock = acquireInflightLock(join(stateDir, "code-health", "locks"), "publication", { run_id: "test-owned-publication" });
    try {
      assert.equal(publishCodeHealthSnapshot({ stateDir, input: next, expectedSnapshotId: published.snapshotId }).state, "busy");
      assert.equal(existsSync(lock.path), true, "preserve a live publisher and its lock");
    } finally { lock.release(); }
    writeFileSync(join(stateDir, "code-health", "latest.json"), "broken");
    assert.equal(readCodeHealthSnapshot(stateDir, "acme/atlas").state, "unavailable", "corruption cannot become an empty healthy cache");
    assert.equal(publishCodeHealthSnapshot({ stateDir, input: next, expectedSnapshotId: published.snapshotId }).state, "unavailable");
    assert.equal(readCodeHealthSnapshot(stateDir, "acme/atlas", first.snapshotId).state, "observed", "retain immutable evidence after pointer failure");
  });
});
