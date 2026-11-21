import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error The executable JavaScript module has no declaration file.
import { codeqlProvenance } from "#scripts/code-health-provenance.mjs";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { validateCodeHealthAssessment, type CodeHealthAssessment } from "#src/lib/code-health-contract.js";
import { readCodeHealthQualityEvidence } from "#src/lib/code-health-collector.js";
import { compareCodeHealthScanPair, validateCodeHealthProvenance, type CodeHealthProjectionInput } from "#src/lib/code-health-projection.js";
import { qualityScanFromCollectedEvidence } from "#src/lib/codeql-quality-intake.js";
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

type OriginalInput = Omit<ReturnType<typeof originalOutput>, "sarif"> & { sarif: unknown };

function exportOriginal(input: OriginalInput | string, directoryMode = false) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-code-health-original-"));
  try {
    const output = join(dir, "metadata.json"), inputPath = join(dir, "input.json");
    const env = { ...process.env };
    let args = ["--input", inputPath];
    if (directoryMode) {
      assert.ok(typeof input !== "string");
      const value = input;
      const sarifDir = join(dir, "sarif"); mkdirSync(sarifDir);
      writeFileSync(join(sarifDir, "original.sarif"), JSON.stringify(value.sarif));
      writeFileSync(join(sarifDir, "ignored.quality.sarif"), "invalid ignored security text");
      writeFileSync(join(sarifDir, "ignored.csra.sarif"), "invalid ignored security text");
      writeFileSync(join(dir, "config.yml"), 'paths-ignore:\n  - "vendor/**"\n');
      writeFileSync(join(dir, "workflow.yml"), "original workflow");
      Object.assign(env, { GITHUB_REPOSITORY: value.repository, GITHUB_SHA: value.analyzedSha,
        GITHUB_REF: value.ref, GITHUB_RUN_ID: value.runId, GITHUB_RUN_ATTEMPT: value.runAttempt,
        CODE_HEALTH_LANGUAGE: value.language, CODE_HEALTH_SARIF_ID: value.sarifId,
        CODE_HEALTH_ANALYSIS_OUTCOME: value.analysisSucceeded ? "success" : "failure" });
      args = ["--sarif-dir", sarifDir, "--config", join(dir, "config.yml"), "--workflow", join(dir, "workflow.yml")];
    } else writeFileSync(inputPath, typeof input === "string" ? input : JSON.stringify(input));
    const child = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/code-health-provenance.mjs"), ...args, "--output", output],
      { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 10_000 });
    assert.ifError(child.error);
    return { status: child.status, stdout: child.stdout, stderr: child.stderr,
      metadata: existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Descriptor, invocation, and artifact shape from the 2.27.3 example in docs/views.md.
function extractedOutput(language = "javascript-typescript", family = "js") {
  const input = originalOutput();
  input.language = language;
  const run = input.sarif.runs[0]!;
  const id = `${family}/diagnostics/successfully-extracted-files`;
  const expected = `${family}/baseline/expected-extracted-files`;
  const descriptors = [
    { id, properties: { id, kind: "diagnostic", tags: ["successfully-extracted-files"] } },
    { id: expected, properties: { id: expected, kind: "diagnostic", tags: ["expected-extracted-files"] } },
  ];
  const extension = family === "py" ? "py" : family === "actions" ? "yml" : "ts";
  const directory = family === "actions" ? ".github/workflows" : "src";
  const location = (name: string, index: number) => ({ uri: `${directory}/${name}.${extension}`, uriBaseId: "%SRCROOT%", index });
  const a = location("check%20file", 0);
  const b = location("another", 1);
  const pending = location("unprocessed", 2);
  const notification = (id: string, index: number, artifactLocation: typeof a) => ({
    descriptor: { id, index }, level: "none", message: { text: "" },
    locations: [{ physicalLocation: { artifactLocation: { ...artifactLocation } } }],
  });
  const invocation = { executionSuccessful: true, toolExecutionNotifications: [
    notification(id, 0, a), notification(id, 0, b), notification(id, 0, a), notification(expected, 1, pending),
  ] };
  const sarifRun = {
    ...run, automationDetails: { id: `/language:${language}/` }, artifacts: [a, b, pending].map(location => ({ location })),
    tool: { driver: { name: "CodeQL", semanticVersion: "2.27.3", rules: [{ id: `${family}/example` }], notifications: descriptors }, extensions: [] },
    invocations: [invocation],
  };
  return { ...input, sarif: { ...input.sarif, runs: [sarifRun] } };
}

test("the CodeQL provenance function returns metadata for original extracted files", () => {
  const result = codeqlProvenance(extractedOutput());
  assert.equal(result.version, "code-health-source-v1");
  assert.equal(result.state, "complete");
  assert.deepEqual(result.scope, {
    kind: "codeql-extracted-files",
    fileCount: 2,
    hash: createHash("sha256")
      .update(JSON.stringify(["codeql-extracted-files", ["src/another.ts", "src/check file.ts"]]))
      .digest("hex"),
  });
});

test("Code health preserves original extracted-file coverage with its own method identity", () => {
  const paths = ["src/another.ts", "src/check file.ts"];
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  for (const [language, family, expectedPaths] of [
    ["javascript-typescript", "js", paths],
    ["python", "py", ["src/another.py", "src/check file.py"]],
    ["actions", "actions", [".github/workflows/another.yml", ".github/workflows/check file.yml"]],
  ] as const) {
    const input = extractedOutput(language, family);
    const run = input.sarif.runs[0]!;
    // A different encoding of the same file across both references still counts once.
    run.invocations[0]!.toolExecutionNotifications[2]!.locations[0]!.physicalLocation.artifactLocation.uri =
      run.artifacts[0]!.location.uri.replace("check", "%63heck");
    const result = exportOriginal(input, true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.metadata.state, "complete");
    assert.equal(result.metadata.language, language);
    assert.equal(result.metadata.completion.kind, "workflow-analysis-step");
    assert.deepEqual(result.metadata.scope, { kind: "codeql-extracted-files", fileCount: 2, hash: hash(["codeql-extracted-files", expectedPaths]) });
    assert.equal(JSON.parse(result.stdout).scopeMethod, "codeql-extracted-files");
    assert.doesNotMatch(JSON.stringify(result), /check file|%20file|unprocessed|\.github\/workflows/);
  }
  const legacy = originalOutput();
  legacy.sarif.runs[0]!.artifacts = paths.map(uri => ({ location: { uri }, roles: ["analysisTarget"] }));
  assert.deepEqual(exportOriginal(legacy, true).metadata.scope, { kind: "explicit-analysis-targets", fileCount: 2, hash: hash(paths) });
  const both = extractedOutput();
  Object.assign(both.sarif.runs[0]!.artifacts[1]!, { roles: ["analysisTarget"] });
  assert.deepEqual(exportOriginal(both, true).metadata.scope, { kind: "explicit-analysis-targets", fileCount: 1, hash: hash([paths[0]]) });
  Object.assign(both.sarif.runs[0]!.artifacts[0]!, { roles: ["analysisTarget"], location: { uri: "../outside.ts" } });
  assert.equal(exportOriginal(both, true).metadata.scope.hash, null);
  const original = extractedOutput();
  const endTimeUtc = "2026-10-27T04:59:00.000Z";
  Object.assign(original.sarif.runs[0]!.invocations[0]!, { endTimeUtc });
  assert.deepEqual(exportOriginal(original).metadata.completion, { kind: "original-invocations", state: "success", at: endTimeUtc });
});

test("Code health extracted-file evidence refuses inferred foreign and incomplete populations", () => {
  type Input = ReturnType<typeof extractedOutput>;
  const cases: Record<string, (input: Input, run: Input["sarif"]["runs"][number]) => void> = {
    "missing original notifications": (_input, run) => { run.invocations[0]!.toolExecutionNotifications.length = 0; },
    "expected files and findings only": (_input, run) => {
      const notes = run.invocations[0]!.toolExecutionNotifications;
      run.results = [{ locations: notes[0]!.locations }];
      run.properties.metricResults = [{ baseline: 2000 }];
      notes.splice(0, 3);
    },
    "foreign diagnostics": input => { input.language = "python"; input.sarif.runs[0]!.automationDetails.id = "/language:python/"; },
    "foreign category": (_input, run) => { run.automationDetails.id = "/language:actions/"; },
    "another revision": (_input, run) => { Object.assign(run, { versionControlProvenance: [{ revisionId: "b".repeat(40) }] }); },
    "another repository": (input, run) => {
      Object.assign(run, { versionControlProvenance: [{ revisionId: input.analyzedSha, repositoryUri: "https://github.com/foreign/atlas" }] });
    },
    "ambiguous descriptor": (_input, run) => { run.tool.driver.notifications.push(run.tool.driver.notifications[0]!); },
    "nested descriptor conflict": (_input, run) => {
      const descriptor = run.tool.driver.notifications[0]!;
      run.tool.driver.notifications.push({ ...descriptor, id: "another/diagnostic", properties: { ...descriptor.properties, tags: [] } });
    },
    "descriptor conflict": (_input, run) => { run.invocations[0]!.toolExecutionNotifications[0]!.descriptor.index = 1; },
    "extension descriptor reference": (_input, run) => {
      Object.assign(run.invocations[0]!.toolExecutionNotifications[0]!.descriptor, { toolComponent: { index: 0 } });
    },
    "bad descriptor metadata": (_input, run) => { run.tool.driver.notifications[0]!.properties.tags = ["expected-extracted-files"]; },
    "malformed descriptor tags": (_input, run) => { Object.assign(run.tool.driver.notifications[0]!.properties, { tags: 1 }); },
    "unresolved file": (_input, run) => { run.invocations[0]!.toolExecutionNotifications[0]!.locations.length = 0; },
    "result region": (_input, run) => {
      Object.assign(run.invocations[0]!.toolExecutionNotifications[0]!.locations[0]!.physicalLocation, { region: { startLine: 1 } });
    },
    "conflicting index": (_input, run) => { run.invocations[0]!.toolExecutionNotifications[0]!.locations[0]!.physicalLocation.artifactLocation.index = 1; },
    "nested artifact": (_input, run) => { Object.assign(run.artifacts[0]!, { parentIndex: 1 }); },
    "untrusted base": (_input, run) => { Object.assign(run, { originalUriBaseIds: { "%SRCROOT%": { uri: "file:///elsewhere/" } } }); },
    "externalized population": (_input, run) => { Object.assign(run, { externalPropertyFileReferences: { artifacts: [{}] } }); },
    "too many original notifications": (_input, run) => {
      run.invocations[0]!.toolExecutionNotifications = new Array(100_001).fill({});
    },
    "multiple invocations": (_input, run) => { run.invocations.push(run.invocations[0]!); },
    "foreign invocation container": (_input, run) => { Object.assign(run, { invocations: { ...run.invocations, length: 1 } }); },
    "failed invocation": (_input, run) => { run.invocations[0]!.executionSuccessful = false; },
    "missing completion": (_input, run) => { Object.assign(run.invocations[0]!, { executionSuccessful: undefined }); },
    "workflow failure": input => { input.analysisSucceeded = false; },
    "invalid end time": (_input, run) => { Object.assign(run.invocations[0]!, { endTimeUtc: "invalid clock" }); },
    "execution error": (_input, run) => { run.invocations[0]!.toolExecutionNotifications[3]!.level = "error"; },
  };
  for (const uri of ["%2e%2e/private", "file:///private", "/private", "src/%ZZ", "src/%FF", "src%2fprivate", "src/%00"]) {
    cases[uri] = (_input, run) => {
      run.artifacts[0]!.location.uri = uri;
      run.invocations[0]!.toolExecutionNotifications[0]!.locations[0]!.physicalLocation.artifactLocation.uri = uri;
    };
  }
  for (const [name, mutate] of Object.entries(cases)) {
    const input = extractedOutput();
    mutate(input, input.sarif.runs[0]!);
    const result = exportOriginal(input, true);
    assert.equal(result.status, 0, name);
    assert.equal(result.metadata.state, "partial", name);
    assert.equal(result.metadata.scope.hash, null, name);
    assert.equal(result.metadata.scope.fileCount, 0, name);
    assert.equal(JSON.parse(result.stdout).codeql.extractedFiles, name === "missing original notifications" || name === "expected files and findings only" ? "absent" : "unverified", name);
  }
  const role = extractedOutput();
  Object.assign(role.sarif.runs[0]!.artifacts[0]!, { roles: "not-an-analysisTarget" });
  assert.equal(exportOriginal(role, true).metadata.scope.hash, null);
});

test("Code health source reader preserves extracted-file identity and comparison guards", async () => {
  const first = extractedOutput();
  const second = {
    ...extractedOutput(), analyzedSha: "b".repeat(40), runId: "124", runAttempt: "2",
    sarifId: "12345678-1234-1234-1234-123456789abd",
  };
  const read = (input: OriginalInput, directoryMode = true) => {
    const { metadata, status, stderr } = exportOriginal(input, directoryMode);
    assert.equal(status, 0, stderr);
    const expected = { repository: input.repository, analyzedSha: input.analyzedSha, runId: input.runId, kind: "quality" } as const;
    const artifact = validateCodeHealthProvenance(metadata, expected);
    const scan = qualityScanFromCollectedEvidence({
      ...expected, requiredLanguages: [input.language], artifacts: [metadata], collectedAt: artifact.observedAt,
      analyses: [{ sarifId: input.sarifId, analyzedSha: input.analyzedSha, category: `/language:${input.language}`,
        toolVersion: "2.27.3", rulesCount: 1, analysisKey: "analyze", environmentHash: "a".repeat(64),
        createdAt: artifact.observedAt, error: "", warning: "" }],
      source: { ok: true, alerts: [], analysisInstances: [] },
    });
    return { artifact, scan, expected };
  };
  const { artifact, scan, expected } = read(first);
  assert.equal(artifact.scope.kind, "codeql-extracted-files");
  assert.equal(scan.state, "complete");
  const workflow = Buffer.from([
    "jobs:", "  analyze:", "    strategy:", "      matrix:", "        language: [javascript-typescript]",
    "    steps:", `      - uses: github/codeql-action/analyze@${"f".repeat(40)}`,
  ].join("\n"));
  const runId = Number(artifact.runId), sha = artifact.analyzedSha, name = `code-health-quality-${artifact.language}`;
  const retained = await readCodeHealthQualityEvidence(artifact.repository, async args => {
    if (args[0] === "run") {
      const dir = args[args.indexOf("--dir") + 1]!;
      assert.deepEqual(args, ["run", "download", artifact.runId, "--repo", artifact.repository, "--name", name, "--dir", dir]);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "code-health-quality.json"), JSON.stringify(artifact));
      return "";
    }
    const route = args[1]!.slice(`repos/${artifact.repository}/`.length);
    if (route === "commits/main") return JSON.stringify({ sha });
    if (route.startsWith("actions/workflows/codeql.yml/runs?")) return JSON.stringify({
      workflow_runs: [{ id: runId, head_sha: sha, head_branch: "main", status: "completed", path: ".github/workflows/codeql.yml" }],
    });
    if (route === `contents/.github/workflows/codeql.yml?ref=${sha}`) return JSON.stringify({
      type: "file", encoding: "base64", size: workflow.length, content: workflow.toString("base64"),
    });
    if (route === `actions/runs/${runId}/artifacts?per_page=100`) return JSON.stringify({ total_count: 1, artifacts: [{
      id: 1, name, expired: false, size_in_bytes: 1000,
      workflow_run: { id: runId, head_sha: sha, head_branch: "main", repository_id: 1, head_repository_id: 1 },
    }] });
    assert.ok(route.startsWith("code-scanning/analyses?"), route);
    return JSON.stringify([{ ref: "refs/heads/main", tool: { name: "CodeQL", version: artifact.toolVersion },
      sarif_id: artifact.sarifId, commit_sha: sha, category: `/language:${artifact.language}`, analysis_key: "analyze", environment: "runner",
      created_at: artifact.observedAt, rules_count: artifact.ruleCount, error: "", warning: "" }]);
  });
  const collection = { ...retained.quality, repository: first.repository, collectedAt: artifact.observedAt,
    source: { ok: true as const, alerts: [], analysisInstances: [] } };
  assert.equal(qualityScanFromCollectedEvidence(collection).scopeHash, scan.scopeHash);
  assert.equal(qualityScanFromCollectedEvidence(collection).state, "complete");
  const mismatched = collection.analyses.map(analysis => ({ ...analysis, category: "/language:actions" }));
  assert.equal(qualityScanFromCollectedEvidence({ ...collection, analyses: mismatched }).state, "partial");

  const rejects = [
    { repository: "elsewhere/atlas" }, { analyzedSha: "c".repeat(40) }, { runId: "125" }, { runAttempt: "2" },
    { completion: null }, { rawPaths: ["src/check file.ts"] }, { scope: { ...artifact.scope, hash: null } },
    { scope: { ...artifact.scope, fileCount: 0 } }, { scope: { ...artifact.scope, fileCount: 100_001 } },
  ];
  for (const patch of rejects) assert.throws(() => validateCodeHealthProvenance({ ...artifact, ...patch }, expected), /invalid or belongs/);
  const partial = { ...artifact, state: "partial", reasons: ["The exclusions are unavailable."] };
  assert.equal(validateCodeHealthProvenance(partial, expected).scope.kind, "codeql-extracted-files");
  assert.throws(() => validateCodeHealthProvenance({ ...partial, scope: { ...artifact.scope, hash: null } }, expected), /invalid or belongs/);
  const coverage = { ...artifact, kind: "coverage", scanId: `coverage-nightly:${artifact.runId}`,
    check: { id: "coverage-existing-tier", met: true, reason: "Measured." },
    measurement: { branches: { covered: 1, total: 1 }, lines: { covered: 1, total: 1 } },
  };
  for (const key of ["runAttempt", "language", "sarifId", "completion", "ruleCount"] as const) delete coverage[key];
  const expectedCoverage = { ...expected, kind: "coverage" } as const;
  assert.throws(() => validateCodeHealthProvenance(coverage, expectedCoverage), /invalid or belongs/);
  assert.equal(validateCodeHealthProvenance({ ...coverage, scope: { ...coverage.scope, kind: "instrumented-source-files" } }, expectedCoverage).kind, "coverage");

  // Give the second independent workflow run a later clock without depending on the test runner's clock.
  const newer = read(second).scan;
  const observedAt = new Date(Math.max(Date.parse(scan.observedAt), Date.parse(newer.observedAt)) + 1).toISOString();
  const current = { ...newer, observedAt };
  const projection: CodeHealthProjectionInput = {
    repository: first.repository, currentSha: second.analyzedSha, analyzedSha: second.analyzedSha,
    observedAt: current.observedAt, nextDueAt: null, registry: { version: "v1", checks: [] }, scans: [current],
    baseline: { analyzedSha: first.analyzedSha, policyVersion: "v1", scans: [scan] },
  };
  assert.equal(compareCodeHealthScanPair(projection, current, scan), "comparable");
  const legacy = originalOutput();
  legacy.sarif.runs[0]!.artifacts = [{ location: { uri: "src/check%20file.ts" }, roles: ["analysisTarget"] },
    { location: { uri: "src/another.ts" }, roles: ["analysisTarget"] }];
  const prior = read(legacy).scan;
  assert.equal(prior.state, "complete");
  assert.equal(compareCodeHealthScanPair(projection, current, { ...scan, scopeHash: prior.scopeHash }), "measurement_changed");
});

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
    codeql: { metricResults: "array", metricCount: 3, baselineMetrics: 1, expectedFileDescriptors: 1, expectedFileNotifications: 1, extractedFiles: "not-checked" },
  });
  for (const malformed of ["null", "false", "0", `{"${sentinel}": "${secretPath}", broken`, JSON.stringify({ sarif: sentinel }),
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
