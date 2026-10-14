#!/usr/bin/env node
// Cheap controls inside the existing Scan job, not a new runner, registry mirror or policy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainModule, parseArgv } from "./lib/argv.mjs";

const VERSION = "1.180.0";
const RULE_ID = "rmd-native-qualification-sentinel";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

export function summarizeReports(report, sarif, exitCode) {
  assert.ok(Number.isInteger(exitCode), "scanner exit status is unavailable");
  assert.equal(report.version, VERSION, "unexpected scanner version");
  assert.ok(Array.isArray(report.results) && Array.isArray(report.errors), "incomplete JSON report");
  assert.ok(Array.isArray(report.paths?.scanned), "target inventory is unavailable");
  assert.ok(report.paths.scanned.every((path) => typeof path === "string"), "invalid target identity");
  assert.equal(sarif.version, "2.1.0", "unsupported SARIF version");
  assert.equal(sarif.runs?.length, 1, "expected one SARIF run");
  const run = sarif.runs[0];
  assert.equal(run.tool?.driver?.semanticVersion, VERSION, "SARIF scanner identity differs");
  assert.ok(Array.isArray(run.tool.driver.rules) && run.tool.driver.rules.length > 0, "rule inventory is empty");
  assert.ok(Array.isArray(run.results), "SARIF results are unavailable");
  const ids = run.tool.driver.rules.map((rule) => rule.id);
  assert.ok(ids.every((id) => typeof id === "string" && id.length > 0), "invalid rule identity");
  assert.equal(new Set(ids).size, ids.length, "duplicate rule identity");
  const invocations = run.invocations;
  const successful = Array.isArray(invocations) && invocations.length > 0 &&
    invocations.every((item) => item.executionSuccessful === true);
  const notificationErrors = Array.isArray(invocations) ? invocations.flatMap((item) =>
    item.toolExecutionNotifications ?? []).filter((item) => item.level === "error").length : null;
  return {
    version: report.version, scannerExitCode: exitCode,
    status: exitCode === 0 && report.errors.length === 0 && successful && notificationErrors === 0 &&
      report.results.length === run.results.length && report.paths.scanned.length > 0 ? "COMPLETE" : "INCOMPLETE",
    engineRequested: report.engine_requested ?? null,
    findingCount: report.results.length, sarifFindingCount: run.results.length,
    errorCount: report.errors.length, targetCount: report.paths.scanned.length,
    skippedTargetCount: Array.isArray(report.paths.skipped) ? report.paths.skipped.length : null,
    skippedRuleCount: Array.isArray(report.skipped_rules) ? report.skipped_rules.length : null,
    ruleCount: ids.length, ruleIdsSha256: digest(JSON.stringify([...ids].sort())),
    // Hash the rendered inventory, not a claim to possess the registry's source-rule bytes.
    renderedRuleInventorySha256: digest(JSON.stringify(run.tool.driver.rules)),
    targetInventorySha256: digest(JSON.stringify([...report.paths.scanned].sort())),
    successfulInvocation: successful, notificationErrorCount: notificationErrors,
    ruleSourceBytes: "NOT_CAPTURED", uploadProcessing: "NOT_VERIFIED",
  };
}

export function verifyControl(report, sarif, expectedPaths) {
  const summary = summarizeReports(report, sarif, 0);
  assert.equal(summary.status, "COMPLETE", "positive control did not complete");
  assert.equal(summary.engineRequested, "OSS", "control did not request the Community Edition engine");
  assert.equal(summary.ruleCount, 1, "control must run exactly its original rule");
  assert.ok(sarif.runs[0].tool.driver.rules[0].id.endsWith(RULE_ID), "wrong control rule");
  const paths = report.results.map((result) => {
    assert.ok(result.check_id.endsWith(RULE_ID), "wrong finding rule");
    return result.path;
  });
  assert.deepEqual(paths.sort(), [...expectedPaths].sort(), "baseline did not distinguish old and new sentinels");
  const sarifPaths = sarif.runs[0].results.map((result) => {
    assert.ok(result.ruleId.endsWith(RULE_ID), "wrong SARIF finding rule");
    return result.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
  });
  assert.deepEqual(sarifPaths.sort(), [...expectedPaths].sort(), "SARIF and JSON controls differ");
  assert.ok(expectedPaths.every((path) => report.paths.scanned.includes(path)), "sentinel target was not scanned");
  return summary;
}

export function qualifySemgrep({ command = "semgrep" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-semgrep-qualification-"));
  const repo = join(root, "fixture");
  const deadline = Date.now() + 300_000;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") &&
    !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_TERMINAL_PROMPT"].includes(key)) delete env[key];
  for (const key of ["SEMGREP_APP_TOKEN", "SEMGREP_BASELINE_COMMIT", "SEMGREP_RULES"]) delete env[key];
  const run = (executable, args) => {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "qualification deadline expired");
    const result = spawnSync(executable, args, { cwd: repo, env, encoding: "utf8",
      timeout: Math.min(60_000, remaining), maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, "qualification child was interrupted");
    assert.ok(Number.isInteger(result.status), "qualification child status unavailable");
    return result;
  };
  const git = (args) => {
    const result = run("git", args);
    assert.equal(result.status, 0, "disposable git fixture failed");
    return result.stdout.trim();
  };
  try {
    mkdirSync(repo);
    const version = run(command, ["--version"]);
    assert.equal(version.status, 0, "scanner version command failed");
    assert.equal(version.stdout.trim(), VERSION, "installed scanner version differs from lock");
    const rule = join(root, "rule.json");
    const ruleBytes = JSON.stringify({ rules: [{ id: RULE_ID, languages: ["javascript"],
      severity: "WARNING", message: "original disposable qualification sentinel", pattern: "rmdHarnessSentinel($X)" }] });
    writeFileSync(rule, ruleBytes);
    const invalid = join(root, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ rules: [{ id: "invalid-control", languages: ["javascript"] }] }));
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["config", "user.name", "Remudero qualification fixture"]);
    git(["config", "user.email", "fixture@localhost"]);
    writeFileSync(join(repo, "old.js"), 'rmdHarnessSentinel("old");\n');
    git(["add", "."]); git(["commit", "--quiet", "-m", "old sentinel"]);
    const base = git(["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "new.js"), 'rmdHarnessSentinel("new");\n');
    git(["add", "."]); git(["commit", "--quiet", "-m", "new sentinel"]);
    const head = git(["rev-parse", "HEAD"]);
    assert.notEqual(head, base);
    const scan = (name, config, extra = []) => {
      const output = join(root, `${name}.json`), sarif = join(root, `${name}.sarif`);
      const result = run(command, ["scan", "--config", config, "--metrics", "off", "--disable-version-check",
        "--jobs", "1", "--timeout", "10", "--max-memory", "512", "--json", "--output", output,
        "--sarif-output", sarif, ...extra, "."]);
      return { result, output, sarif };
    };
    const full = scan("full", rule);
    assert.equal(full.result.status, 0, "full positive scan failed");
    const fullControl = verifyControl(json(full.output), json(full.sarif), ["old.js", "new.js"]);
    const baseline = scan("baseline", rule, ["--baseline-commit", base]);
    assert.equal(baseline.result.status, 0, "baseline positive scan failed");
    const baselineControl = verifyControl(json(baseline.output), json(baseline.sarif), ["new.js"]);
    const bad = scan("invalid", invalid);
    assert.ok(bad.result.status > 0, "invalid rule was accepted as a successful scan");
    const invalidReport = json(bad.output);
    assert.ok(Array.isArray(invalidReport.errors) && invalidReport.errors.length > 0,
      "invalid-rule refusal lacks an explicit scanner error");
    assert.equal(git(["status", "--porcelain"]), "", "baseline fixture must stay clean");
    return { schema: "rmd-semgrep-native-qualification-v1", version: VERSION,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      controlRuleSha256: digest(ruleBytes), base, head, fullControl, baselineControl,
      invalidControl: { exitCode: bad.result.status, errorCount: invalidReport.errors.length },
      authority: "original synthetic controls only; no registry-rule redistribution, Pro engine or pilot activation",
      uploadProcessing: "NOT_VERIFIED" };
  } finally {
    // Exactly this invocation's freshly created fixture; never cache, worktree or fleet state.
    rmSync(root, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const { values, positionals, helpRequested } = parseArgv(argv, {
    receipt: { type: "string" }, json: { type: "string" }, sarif: { type: "string" }, exit: { type: "string" },
  }, { helpText: "Usage: qualify-semgrep-native.mjs --receipt PATH [--json PATH --sarif PATH --exit CODE]" });
  if (helpRequested) return 0;
  assert.equal(positionals.length, 0, "unexpected qualification arguments");
  assert.ok(values.receipt, "immutable receipt path is required");
  const reports = [values.json, values.sarif, values.exit];
  assert.ok(reports.every((item) => item === undefined) || reports.every((item) => item !== undefined), "all report inputs are required");
  const receipt = values.json ? summarizeReports(json(values.json), json(values.sarif),
    /^\d+$/.test(values.exit) ? Number(values.exit) : NaN) : qualifySemgrep();
  writeFileSync(values.receipt, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  log(JSON.stringify(receipt));
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
