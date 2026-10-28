import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { validateCodeHealthAssessment, type CodeHealthAssessment } from "#src/lib/code-health-contract.js";
import { buildRepositoryEvidenceInventory } from "#src/lib/daily-progress-contract.js";

function assessment(): CodeHealthAssessment {
  const sha = "a".repeat(40), baseline = "b".repeat(40);
  return {
    version: "code-health-v1", repository: "acme/atlas", analyzedSha: sha, currentSha: sha, baselineSha: baseline,
    policyVersion: "checks-v1", observedAt: "2026-11-02T05:00:00.000Z", nextDueAt: null, state: "measured",
    sources: ["quality", "coverage"].map((kind) => ({
      id: kind, kind, required: true, state: "complete", analyzedSha: sha, observedAt: "2026-11-02T05:00:00.000Z", scopeHash: "scope", toolVersion: "tool-v1", rulesVersion: "rules-v1", configHash: "config",
      baseline: { sha: baseline, scopeHash: "scope", toolVersion: "tool-v1", rulesVersion: "rules-v1", configHash: "config" }, exclusions: [], reason: null,
    })),
    checks: [{ id: "maintainability", category: "maintainability", state: "met", sourceIds: ["quality"], reason: "No maintainability findings in the analyzed scope" }, { id: "coverage", category: "tests", state: "met", sourceIds: ["coverage"], reason: "Meets the configured baseline" }],
    findings: [], summary: { met: 2, assessed: 2, expected: 2, healthy: true },
  };
}

test("quality contracts reject healthy scores from incomplete or incomparable evidence", () => {
  assert.equal(validateCodeHealthAssessment(assessment()).ok, true);
  const mutations: Array<(a: CodeHealthAssessment) => void> = [
    (a) => { a.sources = []; }, (a) => { a.currentSha = "c".repeat(40); },
    (a) => { a.sources[0]!.analyzedSha = "c".repeat(40); },
    (a) => { a.sources[0]!.state = "unavailable"; a.sources[0]!.reason = "scan unavailable"; },
    (a) => { a.sources[0]!.baseline!.scopeHash = "different"; },
    (a) => { a.sources[0]!.baseline!.toolVersion = "different"; },
    (a) => { a.sources[0]!.baseline!.configHash = "different"; },
    (a) => { a.sources[0]!.baseline!.rulesVersion = "different"; },
    (a) => { a.sources[0]!.baseline = null; },
    (a) => { a.sources.push({ ...a.sources[0]!, id: "additional-required", state: "not_collected", reason: "Required scan has not run" }); },
    (a) => { a.sources.push({ ...a.sources[0]!, id: "additional-required", baseline: null }); },
    (a) => { a.summary.assessed = 1; }, (a) => { a.summary.met = 3; },
    (a) => { a.checks[0]!.sourceIds = ["missing"]; },
    (a) => { a.checks[1]!.state = "not_measured"; },
  ];
  for (const mutate of mutations) { const a = assessment(); mutate(a); assert.equal(validateCodeHealthAssessment(a).ok, false, JSON.stringify(a)); }
  const unknown = assessment(); unknown.state = "partial"; unknown.summary = { met: 1, assessed: 1, expected: 2, healthy: null };
  unknown.checks[1]!.state = "not_measured"; unknown.sources[1]!.state = "not_collected"; unknown.sources[1]!.reason = "No coverage result";
  assert.equal(validateCodeHealthAssessment(unknown).ok, true, "unmeasured coverage remains an explicit gap");
  const optional = assessment();
  optional.sources.push({ ...optional.sources[0]!, id: "optional-scan", required: false, state: "not_collected", reason: "Optional scan has not run" });
  assert.equal(validateCodeHealthAssessment(optional).ok, true, "optional evidence does not change the declared required checks");
  for (const severity of ["high", "critical"] as const) {
    const a = assessment();
    a.findings.push({ fingerprint: "quality:1", sourceId: "quality", severity, category: "reliability", status: "new", path: "src/example.ts", title: "Urgent issue", effortMinutes: 20, estimateKind: "modeled" });
    assert.deepEqual(validateCodeHealthAssessment(a), { ok: true, value: a }, "urgent evidence stays visible independently of the declared check-count result");
    a.summary.healthy = false;
    assert.equal(validateCodeHealthAssessment(a).ok, false, "severity alone cannot override the policy's passing checks");
    a.checks[0]!.state = "not_met"; a.summary.met = 1;
    assert.equal(validateCodeHealthAssessment(a).ok, true, "a declared failing check supports an unhealthy result");
    a.summary.healthy = true;
    assert.equal(validateCodeHealthAssessment(a).ok, false, "a failed check cannot become healthy");
  }
});

test("expected code quality sources are present before any scan is observed", () => {
  const value = buildRepositoryEvidenceInventory([{ instanceId: "one", options: { instanceRepository: { owner: "acme", repo: "atlas" } } }]);
  assert.deepEqual(value.repositories[0]!.expectedQualitySources, ["quality", "coverage"]);
  assert.equal(value.measurementState, "not_collected");
  assert.deepEqual(buildRepositoryEvidenceInventory([{ instanceId: "one", options: { instanceRepository: { owner: "..", repo: "not-a-repo" } } }]).unresolvedInstances, ["one"]);
});

test("quality evidence preserves known failures and rejects malformed provenance", () => {
  for (const value of [null, [], {}, { ...assessment(), daemonUrl: "https://private.invalid" }]) assert.equal(validateCodeHealthAssessment(value).ok, false);
  const changes: Array<(a: CodeHealthAssessment) => void> = [
    (a) => { a.repository = "acme/.."; }, (a) => { a.analyzedSha = "bad"; },
    (a) => { a.observedAt = "2026-02-30T05:00:00.000Z"; },
    (a) => { a.sources[0]!.observedAt = "2026-11-02T06:00:00.000Z"; },
    (a) => { a.sources[0]!.scopeHash = null; },
    (a) => { a.sources[0]!.baseline!.sha = "c".repeat(40); },
    (a) => { a.sources.push(a.sources[0]!); },
    (a) => { a.checks.push(a.checks[0]!); },
    (a) => { a.checks[0]!.sourceIds = []; },
    (a) => { a.checks[0]!.sourceIds.push("quality"); },
    (a) => { a.summary.expected = 1; },
    (a) => { a.summary.healthy = false; },
  ];
  for (const change of changes) { const a = assessment(); change(a); assert.equal(validateCodeHealthAssessment(a).ok, false, JSON.stringify(a)); }
  const failing = assessment(); failing.checks[0]!.state = "not_met"; failing.summary = { met: 1, assessed: 2, expected: 2, healthy: false };
  failing.findings = [{ fingerprint: "quality:1", sourceId: "quality", severity: "high", category: "reliability", status: "existing", path: "src/example.ts", title: "Observed issue", effortMinutes: null, estimateKind: null }];
  assert.equal(validateCodeHealthAssessment(failing).ok, true, "a measured failure does not disappear because its score is poor");
  for (const patch of [{ sourceId: "missing" }, { path: "../private" }, { effortMinutes: 20, estimateKind: null }, { effortMinutes: -1, estimateKind: "modeled" }]) {
    const a = structuredClone(failing); Object.assign(a.findings[0]!, patch); assert.equal(validateCodeHealthAssessment(a).ok, false);
  }
  const unknown = structuredClone(failing); unknown.state = "partial"; unknown.sources[0]!.baseline = null; unknown.findings[0]!.status = "unknown";
  assert.equal(validateCodeHealthAssessment(unknown).ok, true, "a known finding can remain unclassified until comparable baseline evidence exists");
});

function originalOutput() {
  return {
    repository: "acme/atlas", analyzedSha: "a".repeat(40), ref: "refs/heads/main",
    runId: "123", runAttempt: "1", observedAt: "2026-10-27T05:00:00.000Z",
    language: "javascript-typescript", sarifId: "12345678-1234-1234-1234-123456789abc",
    config: "original configuration", exclusions: ["vendor/**"], analysisSucceeded: true,
    sarif: { version: "2.1.0", runs: [{
      tool: { driver: { name: "CodeQL", version: "2.27.3", rules: [{ id: "js/example" }] } as Record<string, unknown> },
      artifacts: [{ location: { uri: "src/example.ts" }, roles: ["analysisTarget"] }],
      invocations: [{ executionSuccessful: true, endTimeUtc: "2026-10-27T04:59:00.000Z" }],
      properties: {} as Record<string, unknown>, results: [] as unknown[],
    }] },
  };
}

function exportOriginal(input: ReturnType<typeof originalOutput> | string, directoryMode = false) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-code-health-original-"));
  try {
    const output = join(dir, "metadata.json"), inputPath = join(dir, "input.json");
    const env = { ...process.env };
    let args = ["--input", inputPath];
    if (directoryMode) {
      assert.notEqual(typeof input, "string");
      const value = input as ReturnType<typeof originalOutput>;
      const sarifDir = join(dir, "sarif"); mkdirSync(sarifDir);
      writeFileSync(join(sarifDir, "original.sarif"), JSON.stringify(value.sarif));
      writeFileSync(join(sarifDir, "ignored.quality.sarif"), "invalid ignored security text");
      writeFileSync(join(sarifDir, "ignored.csra.sarif"), "invalid ignored security text");
      writeFileSync(join(dir, "config.yml"), 'paths-ignore:\n  - "vendor/**"\n');
      writeFileSync(join(dir, "workflow.yml"), "original workflow");
      Object.assign(env, { GITHUB_REPOSITORY: value.repository, GITHUB_SHA: value.analyzedSha,
        GITHUB_REF: value.ref, GITHUB_RUN_ID: value.runId, GITHUB_RUN_ATTEMPT: value.runAttempt,
        CODE_HEALTH_LANGUAGE: value.language, CODE_HEALTH_SARIF_ID: value.sarifId,
        CODE_HEALTH_ANALYSIS_OUTCOME: "success" });
      args = ["--sarif-dir", sarifDir, "--config", join(dir, "config.yml"), "--workflow", join(dir, "workflow.yml")];
    } else writeFileSync(inputPath, typeof input === "string" ? input : JSON.stringify(input));
    const child = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/code-health-provenance.mjs"), ...args, "--output", output],
      { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 10_000 });
    assert.ifError(child.error);
    return { status: child.status, stdout: child.stdout, stderr: child.stderr,
      metadata: existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("Code health accepts original semantic tool identity without granting unmeasured scope", () => {
  const input = originalOutput(), run = input.sarif.runs[0]!;
  delete run.tool.driver.version;
  run.tool.driver.semanticVersion = "2.27.3";
  run.artifacts[0]!.roles = ["resultFile"];
  run.properties.metricResults = [{ ruleId: "js/summary/lines-of-code", value: 1, baseline: 1000 }];
  run.results = [{ locations: [{ physicalLocation: { artifactLocation: { uri: "src/example.ts" } } }] }];
  for (const directoryMode of [false, true]) {
    const result = exportOriginal(input, directoryMode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.metadata.state, "partial");
    assert.deepEqual(result.metadata.scope, { kind: "explicit-analysis-targets", fileCount: 0, hash: null });
    assert.equal(result.metadata.toolVersion, "2.27.3");
    assert.deepEqual(result.metadata.reasons, ["Explicit measured files are unavailable; result locations do not establish scan scope."]);
    const diagnostic = JSON.parse(result.stdout);
    assert.equal(diagnostic.sourceFormat, "original-sarif");
    assert.equal(diagnostic.scopeMethod, "explicit-analysis-targets");
    assert.equal(diagnostic.tool.selected, "semanticVersion");
    assert.equal(diagnostic.artifacts.analysisTargets, 0);
    assert.equal(diagnostic.codeql.baselineMetrics, 1);
  }
  run.artifacts = [];
  assert.equal(exportOriginal(input).metadata.state, "partial");
  run.artifacts = [{ location: { uri: "src/example.ts" }, roles: ["analysisTarget"] }];
  run.tool.driver.version = "CodeQL CLI release";
  const complete = exportOriginal(input);
  assert.equal(complete.metadata.state, "complete");
  assert.equal(complete.metadata.toolVersion, "2.27.3", "semantic identity takes priority over native display text");
  const semanticRules = complete.metadata.rulesVersion;
  delete run.tool.driver.version;
  assert.equal(exportOriginal(input).metadata.rulesVersion, semanticRules);
  run.tool.driver.version = "2.27.3";
  assert.equal(exportOriginal(input).metadata.state, "complete");
});

test("Code health exporter keeps original source diagnostics bounded and private", () => {
  const input = originalOutput(), run = input.sarif.runs[0]!, sentinel = "SECURITY_SENTINEL_TOKEN_PRIVATE";
  const secretPath = `/private/${sentinel}/source.ts`;
  run.results = [{ message: { text: sentinel }, locations: [{ physicalLocation: {
    artifactLocation: { uri: secretPath }, region: { snippet: { text: sentinel } },
  } }] }];
  run.properties = { [sentinel]: { [secretPath]: sentinel }, metricResults: [
    { ruleId: sentinel, baseline: 999, value: sentinel, locations: [{ uri: secretPath }] },
    { baseline: sentinel }, null,
  ] };
  run.tool.driver.notifications = [{ id: "cli/expected-extracted-files/javascript", name: sentinel }, { id: sentinel }, null];
  Object.assign(run.invocations[0]!, { commandLine: sentinel, toolExecutionNotifications: [
    { descriptor: { id: "cli/expected-extracted-files/javascript" }, message: { text: sentinel }, locations: [{ uri: secretPath }] },
    { descriptor: { id: sentinel }, properties: { [sentinel]: secretPath } },
  ] });
  const result = exportOriginal(input, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  for (const publicOutput of [result.stdout, result.stderr, JSON.stringify(result.metadata)]) {
    assert.ok(!publicOutput.includes(sentinel)); assert.ok(!publicOutput.includes(secretPath));
  }
  assert.ok(Buffer.byteLength(result.stdout) < 1024);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: "code-health-original-structure-v1", sourceFormat: "original-sarif", scopeMethod: "explicit-analysis-targets", countLimit: 20_000,
    tool: { codeql: true, semanticVersion: "absent", version: "valid", selected: "version" },
    artifacts: { shape: "array", count: 1, analysisTargets: 1 },
    codeql: { metricResults: "array", metricCount: 3, baselineMetrics: 1, expectedFileDescriptors: 1, expectedFileNotifications: 1 },
  });
  for (const malformed of [`{"${sentinel}": "${secretPath}", broken`, JSON.stringify({ sarif: sentinel }),
    JSON.stringify({ ...input, sarif: { ...input.sarif, runs: [null] } })]) {
    const failed = exportOriginal(malformed);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
    assert.equal(failed.metadata, null);
    assert.equal(failed.stderr, "Code health evidence export failed: invalid input or unavailable original analysis.\n");
  }
  for (const metricResults of [undefined, { [sentinel]: secretPath }, new Array(20_001).fill({ baseline: 1 })]) {
    run.properties.metricResults = metricResults;
    const diagnostic = JSON.parse(exportOriginal(input).stdout);
    assert.equal(diagnostic.codeql.metricResults, metricResults === undefined ? "absent" : Array.isArray(metricResults) ? "array" : "invalid");
    assert.equal(diagnostic.codeql.metricCount, Array.isArray(metricResults) ? 20_000 : 0);
    assert.equal(diagnostic.codeql.baselineMetrics, Array.isArray(metricResults) ? 20_000 : 0);
    assert.ok(!JSON.stringify(diagnostic).includes(sentinel));
  }
});

test("Code health exporter preserves source identity refusals and legacy evidence", () => {
  const input = originalOutput(), legacy = exportOriginal(input);
  assert.equal(legacy.status, 0, legacy.stderr);
  const facts = legacy.metadata;
  assert.deepEqual(Object.keys(facts).sort(), ["version", "kind", "repository", "analyzedSha", "ref", "runId", "runAttempt",
    "observedAt", "language", "sarifId", "scanId", "completion", "state", "reasons", "toolVersion", "rulesVersion",
    "ruleCount", "configHash", "exclusions", "scope"].sort());
  assert.equal(facts.version, "code-health-source-v1");
  assert.equal(facts.state, "complete");
  assert.equal(facts.toolVersion, "2.27.3");
  for (const key of ["repository", "analyzedSha", "ref", "runId", "runAttempt", "observedAt", "language", "sarifId"] as const) {
    assert.equal(facts[key], input[key]);
  }
  assert.equal(facts.scanId, "codeql:123:1:javascript-typescript:12345678-1234-1234-1234-123456789abc");
  assert.deepEqual(facts.completion, { kind: "original-invocations", state: "success", at: "2026-10-27T04:59:00.000Z" });
  assert.deepEqual(facts.exclusions, ["vendor/**"]);
  assert.equal(facts.ruleCount, 1);
  assert.deepEqual(facts.reasons, []);
  assert.equal(facts.scope.fileCount, 1);
  for (const value of [facts.scope.hash, facts.rulesVersion, facts.configHash]) assert.match(value, /^[a-f0-9]{64}$/);
  for (const driver of [
    { name: "Foreign scanner", version: "2.27.3", semanticVersion: "2.27.3" },
    { name: "CodeQL" }, { name: "CodeQL", version: "x".repeat(257) },
    ...[null, 27, "", "2.27", "02.27.3", "2.27.3-01", "2.27.3\nprivate", "2.27.3\n", "2.27.3\r\n", "x".repeat(257)].map(semanticVersion => ({ name: "CodeQL", version: "2.27.3", semanticVersion })),
    { name: "CodeQL", version: "2.26.0", semanticVersion: "2.27.3" },
    { name: "CodeQL", version: null, semanticVersion: "2.27.3" },
  ]) {
    const value = originalOutput(); Object.assign(value.sarif.runs[0]!.tool, { driver: { rules: [{ id: "js/example" }], ...driver } });
    const result = exportOriginal(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.metadata.state, "partial");
    assert.equal(result.metadata.toolVersion, null);
    assert.ok(result.metadata.reasons.includes("The original analysis has no supported tool version."));
    assert.equal(JSON.parse(result.stdout).tool.selected, "unsupported");
  }
  for (const patch of [{ repository: "../private" }, { analyzedSha: "bad" }, { ref: "refs/heads/feature" },
    { runId: "0" }, { runAttempt: "0" }, { language: "../private" }, { sarifId: "bad" }, { config: "" }]) {
    const failed = exportOriginal({ ...input, ...patch }); assert.equal(failed.status, 1); assert.equal(failed.metadata, null);
  }
  for (const change of [
    (value: ReturnType<typeof originalOutput>) => { value.sarif.runs[0]!.invocations[0]!.executionSuccessful = false; },
    (value: ReturnType<typeof originalOutput>) => { value.sarif.runs[0]!.tool.driver.rules = []; },
    (value: ReturnType<typeof originalOutput>) => { value.sarif.runs[0]!.artifacts[0]!.location.uri = "../private"; },
    (value: ReturnType<typeof originalOutput>) => { value.sarif.runs[0]!.artifacts[0]!.location.uri = "%invalid"; },
  ]) {
    const value = originalOutput(); change(value); assert.equal(exportOriginal(value).metadata.state, "partial");
  }
  const workflow = originalOutput(); workflow.sarif.runs[0]!.invocations = [];
  assert.equal(exportOriginal(workflow).metadata.completion.kind, "workflow-analysis-step");
  for (const semanticVersion of ["2.27.3-beta.1+build.2", "2.27.3"]) {
    const value = originalOutput(); delete value.sarif.runs[0]!.tool.driver.version;
    value.sarif.runs[0]!.tool.driver.semanticVersion = semanticVersion;
    assert.equal(exportOriginal(value).metadata.toolVersion, semanticVersion);
  }
});
