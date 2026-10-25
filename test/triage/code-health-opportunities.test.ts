import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { repoRoot } from "#test/helpers/repo-root.js";
import { withTempDir } from "#src/lib/tmp.js";
import { buildCodeHealthOpportunities, codeqlQualityProposalId, qualityScanFromCollectedEvidence } from "#src/lib/codeql-quality-intake.js";
import { prepareCodeHealthCollection, readCodeHealthQualityEvidence } from "#src/lib/code-health-collector.js";
import { projectCodeHealth, codeHealthFindingFingerprint } from "#src/lib/code-health-projection.js";
import { readCodeHealthSnapshot, publishCodeHealthSnapshot, readCodeHealthCoverageSource, saveCodeHealthCoverageSource } from "#src/lib/code-health-store.js";
import type { CodeHealthProjectionInput, CodeHealthScanFinding } from "#src/lib/code-health-projection.js";
import { readCoverageNightlySummary } from "#src/lib/coverage-nightly-intake.js";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { fixedClock } from "#src/lib/clock.js";
import { readCodeScanningAlerts } from "#src/lib/ops.js";
import { ghStubPath, pathWith } from "#test/helpers/gh-stub.js";

function copyMeasurementMethod(dir: string): string {
  for (const relative of ["scripts/code-health-provenance.mjs", "scripts/coverage-ratchet.mjs", "scripts/lib/lcov.mjs", "scripts/lib/argv.mjs"]) {
    const target = join(dir, relative); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repoRoot(), relative), target);
  }
  return join(dir, "scripts/code-health-provenance.mjs");
}

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
  const payload = [{ number: 41, state: "fixed", fixed_at: "2026-11-02T04:59:00Z", created_at: "2026-11-01T05:00:00Z",
    html_url: "https://github.com/acme/atlas/security/code-scanning/41",
    tool: { name: "CodeQL", version: "2.25.0" },
    rule: { id: "js/repeated-work", severity: "warning", tags: ["quality", "maintainability"] },
    most_recent_instance: { ref: "refs/heads/main", commit_sha: "a".repeat(40), analysis_key: ".github/workflows/codeql.yml:analyze",
      category: "/language:javascript-typescript", environment: '{"language":"javascript-typescript","private":"do-not-copy"}', state: "fixed",
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
    assert.equal(source.instanceState, "fixed");
    assert.equal(source.fixedAt, "2026-11-02T04:59:00.000Z");
    assert.equal(source.dismissedAt, null);
    assert.match(source.environmentHash!, /^[a-f0-9]{64}$/);
    assert(!JSON.stringify(source).includes("do-not-copy"), "retain a stable environment identity without copying its private values");
    assert.deepEqual(read.analysisInstances![1], { alertId: "42", analyzedSha: null, toolVersion: null, ref: null, analysisKey: null,
      category: null, environmentHash: null, instanceState: null, fixedAt: null, dismissedAt: null }, "missing source metadata stays unknown");
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
    const run = (value: unknown, script = join(repoRoot(), "scripts/code-health-provenance.mjs")) => {
      writeFileSync(inputPath, JSON.stringify(value));
      const outputPath = join(dir, `output-${outputIndex++}.json`);
      execFileSync(process.execPath, [script, "--input", inputPath, "--output", outputPath], { encoding: "utf8" });
      return JSON.parse(readFileSync(outputPath, "utf8"));
    };
    const manifest = run(raw);
    const copiedScript = copyMeasurementMethod(join(dir, "method"));
    assert.equal(run(raw, copiedScript).configHash, manifest.configHash, "identical method bytes have the same identity in another checkout");
    writeFileSync(copiedScript, readFileSync(copiedScript, "utf8") + "\n// Changed measurement implementation.\n");
    assert.notEqual(run(raw, copiedScript).configHash, manifest.configHash, "a changed quality measurement method cannot reuse its predecessor's comparison identity");
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
    const run = (value = summary, coverage = lcov, policy = baseline, script = join(repoRoot(), "scripts/code-health-provenance.mjs")) => {
      const input = join(dir, "summary.json"), report = join(dir, "lcov.info"), config = join(dir, "baseline.json"), workflow = join(dir, "workflow.yml"), output = join(dir, `coverage-${serial++}.json`);
      writeFileSync(input, JSON.stringify(value)); writeFileSync(report, coverage); writeFileSync(config, JSON.stringify(policy));
      writeFileSync(workflow, 'node --select-all --experimental-test-coverage --test-coverage-exclude="test/**"\n');
      execFileSync(process.execPath, [script, "--coverage-summary", input,
        "--lcov", report, "--baseline", config, "--workflow", workflow, "--output", output], { stdio: "pipe", env: { ...process.env, GITHUB_REPOSITORY: "acme/atlas" } });
      return JSON.parse(readFileSync(output, "utf8")).code_health;
    };
    const measured = run();
    assert.equal(measured.state, "complete"); assert.equal(measured.scope.fileCount, 1);
    assert.equal(measured.repository, "acme/atlas"); assert.equal(measured.analyzedSha, summary.sha);
    assert.equal(measured.observedAt, summary.measured_at);
    assert.deepEqual(measured.exclusions, ["test/**"]);
    assert.equal(measured.check.met, true);
    const copiedScript = copyMeasurementMethod(join(dir, "method"));
    assert.equal(run(summary, lcov, baseline, copiedScript).configHash, measured.configHash);
    const parser = join(dirname(copiedScript), "lib/lcov.mjs");
    writeFileSync(parser, readFileSync(parser, "utf8") + "\n// Changed coverage measurement implementation.\n");
    const methodChanged = run(summary, lcov, baseline, copiedScript);
    assert.notEqual(methodChanged.configHash, measured.configHash, "a parser change is a measurement-method change, not a code improvement");
    assert.equal(methodChanged.rulesVersion, measured.rulesVersion, "the repository's tier policy has not changed");
    assert.deepEqual(methodChanged.measurement, measured.measurement);
    const missing = structuredClone(summary); delete (missing.shard_test_exits as Record<string, number>)["8"];
    assert.equal(run(missing).state, "partial", "all eight required shards must be present");
    const red = structuredClone(summary); red.shard_test_exits["3"] = 1;
    assert.equal(run(red).state, "partial", "a failing suite cannot certify complete coverage");
    const wrongTotal = { ...summary, lf: 3 };
    assert.equal(run(wrongTotal).state, "partial", "summary and original LCOV must agree");
    const empty = run(summary, "");
    assert.equal(empty.state, "partial", "an empty measured population is unknown");
    assert.equal(empty.check.met, false, "an empty report cannot emit a passing check beneath its partial state");
    const moreCode = { ...summary, lf: 3, lh: 3, brf: 12, brh: 11, branches_pct: 100 * 11 / 12 };
    const changedLines = "SF:src/example.ts\nDA:1,1\nDA:2,1\nDA:3,1\nLF:3\nLH:3\nBRF:12\nBRH:11\nend_of_record\n";
    const expanded = run(moreCode, changedLines);
    assert.equal(expanded.scope.hash, measured.scope.hash, "code changes within the same measured files do not change the measurement selection");
    assert.deepEqual(expanded.measurement, { branches: { covered: 11, total: 12 }, lines: { covered: 3, total: 3 } }, "keep changed denominators as explicit facts");
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
      rulesVersion: "b".repeat(64), configHash: "c".repeat(64), exclusions: ["test/**"], scope: { kind: "instrumented-source-files", fileCount: 1, hash: "d".repeat(64) },
      measurement: { branches: { covered: 9, total: 10 }, lines: { covered: 2, total: 2 } },
      check: { id: "coverage-existing-tier", met: true, reason: "Instrumented branch coverage is in the existing healthy tier." } };
    const summary = { kind: "coverage_nightly.measured", sha, ref: "refs/heads/main", run_id: "123", measured_at: at,
      lines_pct: 100, branches_pct: 90, lf: 2, lh: 2, brf: 10, brh: 9, skipped_records: 0, tier: "healthy",
      shard_test_exits: Object.fromEntries(Array.from({ length: 8 }, (_, n) => [String(n + 1), 0])), code_health: provenance };
    const opts = { ledgerPath, owner: "acme", repo: "atlas", clock: fixedClock(Date.parse(at)), cadence: { check: () => ({ fire: true, reason: "due" }), record: () => {} },
      reader: { newestCompletedRun: async () => ({ id: 123, head_sha: sha, head_branch: "main", status: "completed", conclusion: "success" }), summaryForRun: async () => summary }, log: () => {} };
    assert.equal((await readCoverageNightlySummary(opts)).status, "appended");
    const stored = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
    assert.deepEqual(stored.code_health, provenance, "keep allowlisted source facts in the same durable ledger");
    const cached = readCodeHealthCoverageSource(dir, "acme/atlas");
    assert.equal(cached.state, "observed", "reuse the existing intake's validated artifact rather than downloading coverage again");
    assert("provenance" in cached); assert.deepEqual(cached.provenance, provenance);
    assert.equal(readCodeHealthCoverageSource(dir, "acme/foreign").state, "unavailable");
    assert.equal(readCodeHealthCoverageSource(join(dir, "not-yet-collected"), "acme/atlas").state, "not_collected");
    const sourcePath = join(dir, "code-health", "coverage-source.json"), originalBytes = readFileSync(sourcePath, "utf8");
    assert.equal(saveCodeHealthCoverageSource({ stateDir: dir, repository: "acme/atlas", provenance, clock: opts.clock }).state, "duplicate");
    const live = acquireInflightLock(join(dir, "code-health", "locks"), "publication", { run_id: "own-cache-fixture", reclaim: false });
    try { assert.equal(saveCodeHealthCoverageSource({ stateDir: dir, repository: "acme/atlas", provenance, clock: opts.clock }).state, "busy"); }
    finally { live.release(); }
    assert.equal(readFileSync(sourcePath, "utf8"), originalBytes, "a live publication keeps its existing source evidence");
    assert.equal(saveCodeHealthCoverageSource({ stateDir: dir, repository: "acme/foreign", provenance, clock: opts.clock }).state, "unavailable");
    assert.equal(saveCodeHealthCoverageSource({ stateDir: dir, repository: "acme/atlas", provenance: { ...provenance, configHash: "e".repeat(64) }, clock: opts.clock }).state, "unavailable");
    assert.equal(saveCodeHealthCoverageSource({ stateDir: dir, repository: "acme/atlas", provenance, clock: fixedClock(Date.parse(at) - 1) }).state, "unavailable");
    const earlier = new Date(Date.parse(at) - 60_000).toISOString();
    assert.equal(saveCodeHealthCoverageSource({ stateDir: dir, repository: "acme/atlas", provenance: { ...provenance, runId: "122", scanId: "coverage-nightly:122", observedAt: earlier }, clock: opts.clock }).state, "superseded");
    writeFileSync(sourcePath, "broken");
    assert.equal(readCodeHealthCoverageSource(dir, "acme/atlas").state, "unavailable");
    assert.equal(saveCodeHealthCoverageSource({ stateDir: dir, repository: "acme/atlas", provenance, clock: opts.clock }).state, "unavailable");
    writeFileSync(sourcePath, originalBytes);
    unlinkSync(sourcePath);
    opts.reader.summaryForRun = async () => { throw new Error("A repeated intake must not download the artifact again."); };
    assert.equal((await readCoverageNightlySummary(opts)).status, "duplicate");
    assert.equal(readCodeHealthCoverageSource(dir, "acme/atlas").state, "observed", "recover a missed cache write from the existing durable ledger receipt");
    assert.equal(readFileSync(sourcePath, "utf8"), originalBytes);

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
  const value = { repository: "acme/atlas", analyzedSha: sha, runId: "123", requiredLanguages, artifacts, analyses, knownFindingIds: ["42"],
    source: { ok: true as const, alerts: [{ source: "code-scanning" as const, id: "42", severity: "high" as const, state: "open", createdAt: "2026-11-01T05:00:00.000Z",
      summary: "Repeated work is hard to change.", url: "https://github.com/acme/atlas/security/code-scanning/42", toolName: "CodeQL", ruleId: "js/repeated-work",
      ruleTags: ["quality", "maintainability"], location: { path: "src/example.ts" } }],
      analysisInstances: [{ alertId: "42", analyzedSha: sha, toolVersion: "2.23.0", ref: "refs/heads/main", analysisKey: analyses[0]!.analysisKey,
        category: analyses[0]!.category, environmentHash: analyses[0]!.environmentHash, instanceState: "open" }] } };
  const positive = qualityScanFromCollectedEvidence(value);
  assert.equal(positive.state, "complete"); assert.equal(positive.findings.length, 1); assert.equal(positive.checks[0]!.met, false);
  assert.equal(positive.observedAt, artifacts[0]!.observedAt);
  assert.deepEqual(positive.componentIds, artifacts.map(artifact => artifact.scanId).sort(), "retain each original language analysis identity for independence checks");
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
  const newerAnalysis = structuredClone(value);
  newerAnalysis.analyses.unshift({ ...newerAnalysis.analyses[0]!, sarifId: "f2345678-1234-1234-1234-123456789012", createdAt: "2026-11-02T05:30:00.000Z" });
  assert.equal(qualityScanFromCollectedEvidence(newerAnalysis).state, "partial", "an older artifact cannot stand in for a later analysis at the same code revision");
  const fixed = structuredClone(value); fixed.source.alerts[0]!.state = "fixed"; fixed.source.analysisInstances[0]!.instanceState = "fixed";
  fixed.source.analysisInstances[0]!.analyzedSha = "f".repeat(40);
  const fixedInstance = fixed.source.analysisInstances[0] as typeof fixed.source.analysisInstances[number] & { fixedAt?: string | null };
  fixedInstance.fixedAt = "2026-11-02T04:59:00.000Z";
  const confirmed = qualityScanFromCollectedEvidence(fixed);
  assert.equal(confirmed.state, "complete", "a resolved older revision is not a missing current analysis");
  assert.equal(confirmed.findings[0]!.status, "fixed");
  assert.equal(confirmed.findings[0]!.fixedSha, "f".repeat(40));
  assert.equal(confirmed.findings[0]!.fixedAt, fixedInstance.fixedAt);
  fixedInstance.fixedAt = null;
  const history = qualityScanFromCollectedEvidence(fixed);
  assert.equal(history.state, "complete", "unconfirmed older closed history cannot permanently invalidate every new scan");
  assert.equal(history.findings.length, 0, "no fix credit is minted from history without a recorded fix time");
  fixedInstance.fixedAt = "2026-11-02T06:00:00.000Z";
  assert.equal(qualityScanFromCollectedEvidence(fixed).state, "partial", "a later fix cannot be attributed to an earlier scan");
  const dismissed = structuredClone(value); dismissed.source.alerts[0]!.state = "dismissed";
  const retained = qualityScanFromCollectedEvidence(dismissed);
  assert.equal(retained.state, "complete", "GitHub can retain an open most-recent instance for a dismissed alert");
  assert.equal(retained.findings[0]!.status, "dismissed"); assert.equal(retained.checks[0]!.met, false);
  assert.equal(qualityScanFromCollectedEvidence({ ...value, source: { ok: false, error: "unavailable" } }).state, "unavailable");
});


function publishFixture(opts: Parameters<typeof publishCodeHealthSnapshot>[0]) {
  return publishCodeHealthSnapshot({ clock: fixedClock(Date.parse("2026-11-02T06:00:00.000Z")), ...opts });
}

test("code health publishes immutable evidence and refuses stale or occupied publication", async () => {
  await withTempDir("code-health-store", async stateDir => {
    assert.equal(readCodeHealthSnapshot(stateDir, "acme/atlas").state, "not_collected");
    const first = publishFixture({ stateDir, input: input(), expectedSnapshotId: null });
    assert.equal(first.state, "published"); assert("snapshotId" in first);
    const read = readCodeHealthSnapshot(stateDir, "acme/atlas");
    assert.equal(read.state, "observed"); assert("snapshot" in read);
    assert.equal(read.snapshot.snapshotId, first.snapshotId);
    assert.deepEqual(read.snapshot.input, input());
    const reread = input(); reread.observedAt = "2026-11-02T05:02:00.000Z";
    const duplicate = publishFixture({ stateDir, input: reread, expectedSnapshotId: first.snapshotId });
    assert.equal(duplicate.state, "duplicate"); assert("snapshotId" in duplicate); assert.equal(duplicate.snapshotId, first.snapshotId);
    const next = input(); next.scans.forEach(scan => { scan.scanId += ":independent"; });
    const published = publishFixture({ stateDir, input: next, expectedSnapshotId: first.snapshotId });
    assert.equal(published.state, "published"); assert("snapshotId" in published);
    assert.notEqual(published.snapshotId, first.snapshotId);
    assert.equal(publishFixture({ stateDir, input: input(), expectedSnapshotId: first.snapshotId }).state, "superseded");
    const older = input(); older.scans.forEach(scan => { scan.observedAt = "2026-11-02T04:59:00.000Z"; scan.scanId += ":older"; });
    assert.equal(publishFixture({ stateDir, input: older, expectedSnapshotId: published.snapshotId }).state, "superseded",
      "even a successful CAS cannot replace a newer measured source with an older one");
    const current = readCodeHealthSnapshot(stateDir, "acme/atlas"); assert.equal(current.state, "observed"); assert("snapshot" in current);
    assert.equal(current.snapshot.snapshotId, published.snapshotId);
    assert.equal(current.snapshot.previousSnapshotId, first.snapshotId, "retain an explicit immutable history link");
    const historical = readCodeHealthSnapshot(stateDir, "acme/atlas", first.snapshotId);
    assert.equal(historical.state, "observed"); assert("snapshot" in historical); assert.deepEqual(historical.snapshot.input, input());
    assert.equal(readCodeHealthSnapshot(stateDir, "acme/foreign").state, "unavailable");
    const lock = acquireInflightLock(join(stateDir, "code-health", "locks"), "publication", { run_id: "test-owned-publication" });
    try {
      assert.equal(publishFixture({ stateDir, input: next, expectedSnapshotId: published.snapshotId }).state, "busy");
      assert.equal(existsSync(lock.path), true, "preserve a live publisher and its lock");
    } finally { lock.release(); }
    writeFileSync(join(stateDir, "code-health", "latest.json"), "broken");
    assert.equal(readCodeHealthSnapshot(stateDir, "acme/atlas").state, "unavailable", "corruption cannot become an empty healthy cache");
    assert.equal(publishFixture({ stateDir, input: next, expectedSnapshotId: published.snapshotId }).state, "unavailable");
    assert.equal(readCodeHealthSnapshot(stateDir, "acme/atlas", first.snapshotId).state, "observed", "retain immutable evidence after pointer failure");
  });
});


test("code health recovers a proven dead publisher while preserving unknown lock ownership", async () => {
  await withTempDir("code-health-locks", async root => {
    for (const kind of ["dead", "unknown"] as const) {
      const stateDir = join(root, kind), lockDir = join(stateDir, "code-health", "locks"); mkdirSync(lockDir, { recursive: true });
      const lockPath = join(lockDir, "publication.lock");
      const startedAt = new Date().toISOString();
      const deadPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
      const bytes = kind === "dead" ? JSON.stringify({ pid: deadPid, run_id: "completed-own-fixture", host: hostname(), startedAt }) : "unknown ownership";
      writeFileSync(lockPath, bytes);
      const result = publishFixture({ stateDir, input: input(), expectedSnapshotId: null });
      assert.equal(result.state, kind === "dead" ? "published" : "busy");
      if (kind === "unknown") assert.equal(readFileSync(lockPath, "utf8"), bytes);
      else assert.equal(existsSync(lockPath), false, "release only this fixture's own new publication lock");
    }
  });
});


test("code health does not publish measurements from after the collection attempt", async () => {
  await withTempDir("code-health-future", async stateDir => {
    const result = publishCodeHealthSnapshot({ stateDir, input: input(), expectedSnapshotId: null,
      clock: fixedClock(Date.parse("2026-11-02T05:00:00.000Z")) });
    assert.equal(result.state, "unavailable");
    assert.equal(existsSync(join(stateDir, "code-health", "latest.json")), false);
  });
});


test("code health reads immutable source history without running today's assessment", async () => {
  await withTempDir("code-health-history", async stateDir => {
    const saved = publishFixture({ stateDir, input: input(), expectedSnapshotId: null }); assert("snapshotId" in saved);
    const format = Date.prototype.toISOString;
    try {
      // Simulate an unavailable current assessment formatter. Historical evidence needs only its sealed source bytes.
      Date.prototype.toISOString = () => { throw new Error("a source-history read must not run the current assessment"); };
      assert.equal(readCodeHealthSnapshot(stateDir, "acme/atlas", saved.snapshotId).state, "observed");
    } finally { Date.prototype.toISOString = format; }
  });
});

test("code health detects corruption of an immutable snapshot's history link", async () => {
  await withTempDir("code-health-history-integrity", async stateDir => {
    const saved = publishFixture({ stateDir, input: input(), expectedSnapshotId: null }); assert("snapshotId" in saved);
    const path = join(stateDir, "code-health", "snapshots", `${saved.snapshotId}.json`);
    const original = readFileSync(path, "utf8"), changed = JSON.parse(original);
    changed.previousSnapshotId = "e".repeat(64);
    writeFileSync(path, JSON.stringify(changed));
    assert.equal(readCodeHealthSnapshot(stateDir, "acme/atlas", saved.snapshotId).state, "unavailable");
    writeFileSync(path, original);
    assert.equal(readCodeHealthSnapshot(stateDir, "acme/atlas", saved.snapshotId).state, "observed");
  });
});


test("code health collection preserves source clocks and prior partial findings", () => {
  const previous = input(); previous.baseline = null;
  const old = previous.scans[0]!; old.state = "partial"; old.reason = "A configured analysis did not finish.";
  const value = prepareCodeHealthCollection({ repository: previous.repository, currentSha: previous.currentSha,
    observedAt: "2026-11-02T06:00:00.000Z", scans: [], previous });
  assert.equal(value.baseline, null, "a partial source cannot become a comparison baseline");
  const report = projectCodeHealth(value);
  assert.equal(report.findings.length, new Set(old.findings.map(finding => finding.id)).size);
  assert.equal(report.sources.filter(source => source.required).length, 2);
  assert.equal(report.summary.healthy, null);
  for (const known of report.findings) {
    const source = report.sources.find(source => source.id === known.sourceId)!;
    assert.equal(source.observedAt, old.observedAt); assert.equal(source.analyzedSha, old.analyzedSha);
  }
  const retry = prepareCodeHealthCollection({ repository: previous.repository, currentSha: previous.currentSha,
    observedAt: "2026-11-02T07:00:00.000Z", scans: [], previous: value });
  assert.equal(projectCodeHealth(retry).findings.length, new Set(old.findings.map(finding => finding.id)).size, "two failed reads cannot erase prior partial findings");
  const complete = input(), scans = structuredClone(complete.scans);
  for (const scan of scans) scan.observedAt = "2026-11-02T05:59:00.000Z";
  const repeated = prepareCodeHealthCollection({ repository: complete.repository, currentSha: complete.currentSha,
    observedAt: "2026-11-02T06:00:00.000Z", scans, previous: complete });
  assert.equal(repeated.scans[0]!.observedAt, complete.scans[0]!.observedAt, "re-reading a source cannot move its own measurement clock");
  assert.notEqual(projectCodeHealth(repeated).summary.healthy, true, "a repeated scan is not an independent baseline");
});


test("code health collection rejects foreign evidence under a reused scan identity", () => {
  const previous = input(), scans = structuredClone(previous.scans);
  scans[0]!.repository = "acme/foreign";
  assert.throws(() => prepareCodeHealthCollection({ repository: previous.repository, currentSha: previous.currentSha,
    observedAt: "2026-11-02T06:00:00.000Z", scans, previous }), /repository/i);
});

test("code health collection flags changed facts under one scan identity without losing urgent evidence", () => {
  const previous = input(), scans = structuredClone(previous.scans);
  scans[0]!.scopeHash = "different-scope";
  scans[0]!.findings = [{ ...scans[0]!.findings[0]!, id: "99", severity: "critical" }];
  const changed = prepareCodeHealthCollection({ repository: previous.repository, currentSha: previous.currentSha,
    observedAt: "2026-11-02T06:00:00.000Z", scans, previous });
  assert.equal(changed.scans[0]!.state, "partial", "one saved measurement identity cannot silently change its measured facts");
  const report = projectCodeHealth(changed);
  assert(report.findings.some(finding => finding.severity === "critical" && finding.fingerprint === codeHealthFindingFingerprint(previous.repository, "quality", scans[0]!.findings[0]!)), "keep newly known urgent evidence explicit while unassessed");
  assert.equal(report.summary.healthy, null);
});

test("code health collection preserves a valid comparison when the same source evidence is read again", () => {
  const value = input();
  for (const scan of value.scans) {
    scan.findings = []; scan.checks = [{ id: scan.kind === "quality" ? "quality-maintainability-open" : "coverage-existing-tier", met: true, reason: "Meets the existing repository policy." }];
  }
  const first = prepareCodeHealthCollection({ repository: value.repository, currentSha: value.currentSha, observedAt: value.observedAt, scans: value.scans, previous: null });
  assert.equal(projectCodeHealth(first).summary.healthy, null, "a first measured source has no independent comparison yet");
  const scans = first.scans.map(scan => ({ ...structuredClone(scan), scanId: `${scan.kind}:independent`, analyzedSha: "c".repeat(40), observedAt: "2026-11-02T06:00:00.000Z" }));
  const second = prepareCodeHealthCollection({ repository: value.repository, currentSha: "c".repeat(40), observedAt: "2026-11-02T06:01:00.000Z", scans, previous: first });
  assert.equal(projectCodeHealth(second).summary.healthy, true, "two independent complete sources confirm the existing policy checks");
  const repeated = prepareCodeHealthCollection({ repository: value.repository, currentSha: second.currentSha, observedAt: "2026-11-02T07:01:00.000Z", scans: second.scans, previous: second });
  assert.equal(projectCodeHealth(repeated).summary.healthy, true, "rereading evidence retains its established comparison instead of making the source its own baseline");
  assert.deepEqual(repeated.baseline, second.baseline);
  assert.equal(repeated.scans[0]!.observedAt, second.scans[0]!.observedAt);
});


test("code health reads configured original-output artifacts through the real GitHub read port", async () => {
  const sha = "a".repeat(40), repository = "acme/atlas", languages = ["javascript-typescript", "actions", "python"];
  const workflow = "jobs:\n  analyze:\n    strategy:\n      matrix:\n        include:\n" + languages.map(language => `          - language: ${language}\n`).join("") + "    steps:\n      - uses: github/codeql-action/analyze@" + "f".repeat(40) + "\n";
  const metadata = languages.map((language, n) => ({ version: "code-health-source-v1", kind: "quality", repository, analyzedSha: sha,
    ref: "refs/heads/main", runId: "123", runAttempt: "1", observedAt: "2026-11-02T05:00:00.000Z", language,
    sarifId: `${n + 1}2345678-1234-1234-1234-123456789012`, scanId: `codeql:123:1:${language}:${n + 1}2345678-1234-1234-1234-123456789012`,
    state: "complete", reasons: [], toolVersion: "2.23.0", rulesVersion: "b".repeat(64), configHash: "c".repeat(64), ruleCount: 12,
    exclusions: ["test/**"], scope: { kind: "explicit-analysis-targets", fileCount: 2, hash: "d".repeat(64) },
    completion: { kind: "workflow-analysis-step", state: "success", at: "2026-11-02T05:00:00.000Z" } }));
  const analyses = metadata.map(item => ({ ref: "refs/heads/main", commit_sha: sha, analysis_key: ".github/workflows/codeql.yml:analyze",
    environment: JSON.stringify({ language: item.language }), category: `/language:${item.language}`, created_at: "2026-11-02T04:59:00Z",
    rules_count: 12, sarif_id: item.sarifId, tool: { name: "CodeQL", version: "2.23.0" }, error: "", warning: "" }));
  const payload = { sha, repository, languages, metadata, analyses, workflow };
  const bin = ghStubPath(`#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs"); const { join } = require("node:path");
const p = ${JSON.stringify(payload)}, a = process.argv.slice(2), route = a[1] || "", mode=process.env.RMD_CODE_HEALTH_FIXTURE_CASE || "";
if (a[0] === "api") {
 if (!route.startsWith("repos/"+p.repository+"/")) process.exit(45);
 if (mode === "transport") process.exit(42);
 let result;
 if (route.includes("/commits/main")) result = {sha:p.sha};
 else if (route.includes("/actions/workflows/codeql.yml/runs")) result = {workflow_runs:[{id:123,head_sha:p.sha,head_branch:"main",status:"completed",conclusion:"success",path:".github/workflows/codeql.yml"}]};
 else if (route.includes("/contents/.github/workflows/codeql.yml")) result = {type:"file",encoding:"base64",size:Buffer.byteLength(p.workflow),content:Buffer.from(p.workflow).toString("base64")};
 else if (route.includes("/actions/runs/123/artifacts")) result = {total_count:p.languages.length,artifacts:p.languages.map((language,n)=>({id:n+1,name:"code-health-quality-"+language,expired:false,size_in_bytes:1000,workflow_run:{id:123,head_sha:p.sha,head_branch:"main",repository_id:1,head_repository_id:1}}))};
 else if (route.includes("/code-scanning/analyses")) result = p.analyses;
 else {process.stderr.write("Unexpected read: "+route);process.exit(42);}
 if (route.includes("/actions/runs/123/artifacts")) {
  if (mode === "truncated") result.total_count++;
  if (mode === "foreign-run") result.artifacts[0].workflow_run.head_sha="b".repeat(40);
  if (mode === "expired") result.artifacts[0].expired=true;
  if (mode === "oversized-artifact") result.artifacts[0].size_in_bytes=256*1024+1;
 }
 if (route.includes("/code-scanning/analyses")) {
  if (mode === "missing-analysis") result=result.slice(0,2);
  if (mode === "many-analyses") result=result.concat(Array.from({length:97},(_,n)=>({...result[0],sarif_id:String(n+100).padStart(8,"0")+"-1234-1234-1234-123456789012",commit_sha:"b".repeat(40),created_at:"2026-11-01T04:00:00Z"})));
  if (mode === "newer-analysis") result=[{...result[0],sarif_id:"92345678-1234-1234-1234-123456789012",created_at:"2026-11-02T05:01:00Z"},...result];
  if (mode === "unordered-analysis") result[result.length-1].created_at="2026-11-02T05:02:00Z";
 }
 process.stdout.write(mode === "invalid-json" ? "{" : JSON.stringify(result));
} else if (a[0] === "run" && a[1] === "download") {
 const name=a[a.indexOf("--name")+1], dir=a[a.indexOf("--dir")+1], item=p.metadata.find(item=>"code-health-quality-"+item.language===name);
 if (!item || !dir || a[2]!=="123" || a[a.indexOf("--repo")+1]!==p.repository) process.exit(43);
 mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,"code-health-quality.json"),mode === "oversized-metadata" ? " ".repeat(128*1024+1) : JSON.stringify(mode === "foreign-metadata" ? {...item,repository:"acme/foreign"} : item));
} else {process.stderr.write("Unexpected command");process.exit(44);}
`);
  const saved = process.env.PATH, savedMode = process.env.RMD_CODE_HEALTH_FIXTURE_CASE; process.env.PATH = pathWith(bin); delete process.env.RMD_CODE_HEALTH_FIXTURE_CASE;
  try {
    const read = await readCodeHealthQualityEvidence(repository);
    assert.equal(read.currentSha, sha);
    assert.deepEqual([...read.quality.requiredLanguages].sort(), [...languages].sort());
    assert.equal(read.quality.artifacts.length, 3); assert.equal(read.quality.analyses.length, 3);
    const scan = qualityScanFromCollectedEvidence({ ...read.quality, repository, source: { ok: true, alerts: [], analysisInstances: [] } });
    assert.equal(scan.state, "complete", "zero findings need all configured original-output and API-analysis controls");
    assert.deepEqual(scan.componentIds, metadata.map(item => item.scanId).sort());
    assert.equal(scan.observedAt, metadata[0]!.observedAt);
    assert(!JSON.stringify(read).includes('"environment":'), "retain only the environment fingerprint");
    const readAndScan = async () => {
      const result = await readCodeHealthQualityEvidence(repository);
      return qualityScanFromCollectedEvidence({ ...result.quality, repository, source: { ok: true, alerts: [], analysisInstances: [] } });
    };
    process.env.RMD_CODE_HEALTH_FIXTURE_CASE = "many-analyses";
    assert.equal((await readAndScan()).state, "complete", "a full recent page is usable when it covers every selected original identity and all newer analyses");
    process.env.RMD_CODE_HEALTH_FIXTURE_CASE = "newer-analysis";
    assert.equal((await readAndScan()).state, "partial", "a later unrepresented analysis cannot be replaced by an older artifact");
    for (const mode of ["transport", "invalid-json", "truncated", "foreign-run", "expired", "oversized-artifact", "missing-analysis", "unordered-analysis", "foreign-metadata", "oversized-metadata"]) {
      process.env.RMD_CODE_HEALTH_FIXTURE_CASE = mode;
      await assert.rejects(readAndScan, (error: unknown) => error instanceof Error, `refuse ${mode} without an empty successful scan`);
    }
  } finally {
    process.env.PATH = saved;
    if (savedMode === undefined) delete process.env.RMD_CODE_HEALTH_FIXTURE_CASE; else process.env.RMD_CODE_HEALTH_FIXTURE_CASE = savedMode;
  }
});

test("code health collection compacts redundant known facts without dropping unresolved evidence", () => {
  const value = input();
  for (const scan of value.scans) scan.checks[0]!.id = scan.kind === "quality" ? "quality-maintainability-open" : "coverage-existing-tier";
  let previous = prepareCodeHealthCollection({ repository: value.repository, currentSha: value.currentSha, observedAt: value.observedAt, scans: value.scans, previous: null });
  for (let n = 1; n <= 20; n++) {
    const at = Date.parse("2026-11-02T05:00:00.000Z") + n * 60_000, sha = String(n).padStart(40, "a");
    const scans = previous.scans.map(scan => ({ ...structuredClone(scan), scanId: `${scan.kind}:measurement:${n}`, analyzedSha: sha, observedAt: new Date(at).toISOString() }));
    previous = prepareCodeHealthCollection({ repository: value.repository, currentSha: sha, observedAt: new Date(at + 1000).toISOString(), scans, previous });
    assert.equal(projectCodeHealth(previous).findings.length, 2);
    assert((previous.retainedEvidence?.length ?? 0) <= 1, "ordinary independent reruns must not fill the history bound with facts freshly confirmed by the current scan");
  }
  const at = Date.parse(previous.observedAt) + 60_000, sha = "c".repeat(40);
  const fixed = previous.scans.map(scan => ({ ...structuredClone(scan), scanId: `${scan.kind}:confirmed-fixed`, analyzedSha: sha, observedAt: new Date(at).toISOString(),
    checks: scan.checks.map(check => ({ ...check, met: true })), findings: scan.findings.map(finding => ({ ...finding, status: "fixed" as const, fixedSha: sha, fixedAt: new Date(at).toISOString() })) }));
  const result = prepareCodeHealthCollection({ repository: value.repository, currentSha: sha, observedAt: new Date(at + 1000).toISOString(), scans: fixed, previous });
  assert.equal(result.retainedEvidence?.length ?? 0, 0, "only independently confirmed fixes retire unresolved source facts");
  assert.equal(projectCodeHealth(result).summary.healthy, true);
});
