import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const workflow = () => parseYaml(readFileSync(new URL("../.github/workflows/semgrep.yml", import.meta.url), "utf8"));

test("W1-T9979: check:ci-log:scan is prevented, not retried", () => {
  const steps = workflow().jobs.semgrep.steps;
  const install = steps.find((step: any) => step.name === "Install hash-locked Community Edition");
  assert.ok(install);
  assert.equal(install["continue-on-error"], undefined);
  assert.equal((install.run.match(/source-runtime-qualification\.py/g) ?? []).length, 1);
  assert.match(install.run, /--install-root "\$ROOT" --workspace "\$GITHUB_WORKSPACE"/);
  assert.doesNotMatch(install.run, /pip --isolated install|\bretry\b|\|\| true|--no-require-hashes/);
  assert.ok(install.run.indexOf("HASH_BOUND_INSTALL_AND_MCP_CONTROLS_COMPLETE") < install.run.indexOf('>> "$GITHUB_PATH"'));
  assert.ok(steps.indexOf(install) < steps.findIndex((step: any) => step.name === "Run Semgrep"));
  const source = readFileSync(new URL("../.github/semgrep/source-runtime-qualification.py", import.meta.url), "utf8");
  assert.match(source, /result = audit\(root, workspace, head\)/);
  assert.match(source, /run\(root, \[root \/ "runtime-env\/bin\/python", "-I", "-B", probe, "--probe-mcp-root", root\], "mcp", 90\)/);
});

test("W1-T9979: source runtime closure never bypasses provenance hashes or pip check", () => {
  const module = fileURLToPath(new URL("../.github/semgrep/source-runtime-qualification.py", import.meta.url));
  const suite = fileURLToPath(new URL("../.github/semgrep/test_source_runtime_qualification.py", import.meta.url));
  assert.ok(existsSync(module), "the bounded source-runtime qualifier must exist");
  assert.ok(existsSync(suite), "physical Python qualification controls must exist");
  const result = spawnSync("python3", ["-I", "-S", "-B", suite], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 15 tests/);
  assert.match(result.stderr, /\bOK\b/);
});

test("W1-T9979: real MCP compatibility and authentication probes fail closed", () => {
  const suite = fileURLToPath(new URL("../.github/semgrep/test_source_runtime_qualification.py", import.meta.url));
  assert.ok(existsSync(suite));
  const result = spawnSync("python3", ["-I", "-S", "-B", suite,
    "SourceQualificationControls.test_mcp_missing_revised_partial_or_timeout_evidence_is_not_healthy",
    "SourceQualificationControls.test_each_auth_and_transport_negative_requires_the_healthy_bound_corpus"], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 2 tests/);
  assert.match(result.stderr, /\bOK\b/);
});

test("W1-T9979: actual scanner controls and inventories distinguish complete from unknown", async () => {
  const { summarizeReports } = await import(new URL("../scripts/semgrep-native-contract-ratchet.mjs", import.meta.url).href);
  const report = { version: "1.181.0", engine_requested: "OSS", results: [], errors: [], paths: { scanned: ["control.js"] }, skipped_rules: [] };
  const sarif = { version: "2.1.0", runs: [{ tool: { driver: { semanticVersion: "1.181.0", rules: [{ id: "original-control" }] } },
    results: [], invocations: [{ executionSuccessful: true, toolExecutionNotifications: [] }] }] };
  const healthy = summarizeReports(report, sarif, 0);
  assert.equal(healthy.status, "COMPLETE", "reported execution completed, not a whole-AST grant");
  assert.equal(healthy.skippedTargetCount, null);
  assert.equal(healthy.skippedTargetInventory, "UNKNOWN");
  assert.equal(healthy.wholeCorpusCoverage, "NOT_ESTABLISHED");
  assert.equal(healthy.wholeAstCoverage, "NOT_ESTABLISHED");
  assert.equal(summarizeReports({ ...report, paths: { ...report.paths, skipped: ["unsupported.ext"] } }, sarif, 0).skippedTargetCount, 1);
  assert.equal(summarizeReports({ ...report, errors: [{ type: "PartialParsing" }] }, sarif, 0).status, "INCOMPLETE");
  assert.equal(summarizeReports(report, sarif, 2).status, "INCOMPLETE");
  assert.throws(() => summarizeReports({ ...report, paths: {} }, sarif, 0), /target inventory/);
});

test("W1-T9979: Scan adoption preserves policy owner override and forbidden effects", () => {
  const doc = workflow(), job = doc.jobs.semgrep;
  assert.equal(job.name, "Scan");
  assert.equal(job["timeout-minutes"], 20);
  assert.deepEqual(doc.permissions, { contents: "read" });
  assert.deepEqual(job.permissions, { "security-events": "write", contents: "read", actions: "read" });
  assert.deepEqual(doc.on.schedule, [{ cron: "46 3 * * *" }], "existing cadence only, no recreated schedule");
  const scan = job.steps.find((step: any) => step.name === "Run Semgrep");
  assert.equal(scan["continue-on-error"], true, "finding policy is unchanged");
  assert.deepEqual([...scan.run.matchAll(/--config (p\/[^\s]+)/g)].map((match: any) => match[1]),
    ["p/typescript", "p/javascript", "p/security-audit", "p/secrets"]);
  assert.equal(scan.env.BASELINE_REF, "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || '' }}");
  const install = job.steps.find((step: any) => step.name === "Install hash-locked Community Edition");
  assert.match(install.run, /'pilotDefaultOff', 'ownerOverrideUnchanged'/);
  assert.match(install.run, /productionOAuthIdentity.*NOT_QUALIFIED/);
  assert.match(install.run, /wholeCorpusQualified.*False/);
  assert.doesNotMatch(install.run, /secrets\.|SEMGREP_APP_TOKEN|install-semgrep-pro|sudo|docker|settings set|gh api/);
});
