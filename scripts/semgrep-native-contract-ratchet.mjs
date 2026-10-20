#!/usr/bin/env node
// Native scanner contract non-regression ratchet, protected by the existing *-ratchet instrument
// surface. Cheap controls inside Scan, not a new runner, registry mirror or findings policy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainModule, parseArgv } from "./lib/argv.mjs";

const VERSION = "1.181.0";
const RULE_ID = "rmd-native-qualification-sentinel";
const PARSER_RULE_ID = "rmd-original-typescript-parser-marker";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const safePath = (path) => typeof path === "string" && path.length <= 256 &&
  /^[A-Za-z0-9_@.+/-]+$/.test(path) && !path.startsWith("/") &&
  !path.split("/").includes("..") ? path : null;
// Semgrep's JSON error_type has human-readable enum labels too. Accept only these
// schema labels, never arbitrary spaced strings that could carry source or secrets.
const humanErrorTypes = new Set(["Lexical error", "Syntax error", "Other syntax error", "AST builder error",
  "Rule parse error", "Invalid YAML", "Internal matching error", "Semgrep match found", "Too many matches",
  "Fatal error", "Out of memory", "Fixpoint timeout", "Stack overflow", "Timeout during interfile analysis",
  "OOM during interfile analysis", "Missing plugin", "Pattern parse error", "Incompatible rule"]);

function errorLocations(error, type) {
  // PartialParsing's variant payload lists omitted source locations; ordinary spans
  // instead use `file`. Missing location evidence remains null, not an empty census.
  const raw = type === "PartialParsing" && Array.isArray(error.type?.[1]) ? error.type[1] : error.spans;
  if (!Array.isArray(raw)) return { locations: null, locationCount: null, locationsTruncated: false };
  return { locationCount: raw.length, locationsTruncated: raw.length > 8,
    locations: raw.slice(0, 8).map((span) => {
      const start = span?.start?.line, end = span?.end?.line;
      const valid = Number.isSafeInteger(start) && start > 0 && start <= 10000000 &&
        Number.isSafeInteger(end) && end >= start && end <= 10000000;
      return { path: safePath(span?.path ?? span?.file), startLine: valid ? start : null, endLine: valid ? end : null };
    }) };
}

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
  const errorInventory = report.errors.slice(0, 64).map((error) => {
    const type = Array.isArray(error.type) ? error.type[0] : error.type;
    const rawPath = error.path ?? error.spans?.[0]?.file;
    // Error messages and snippets may include source or secrets. Retain only constrained labels,
    // safe repository-relative identities and a hash of the complete private error corpus.
    const path = safePath(rawPath);
    const ruleIdObserved = error.rule_id == null ? null : ids.includes(error.rule_id);
    return { type: typeof type === "string" && (humanErrorTypes.has(type) || /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(type)) ? type : "UNKNOWN",
      level: ["error", "warn", "warning", "info"].includes(error.level) ? error.level : "UNKNOWN", path,
      // Echo only IDs in this run's already-rendered rule inventory, not raw error data.
      ruleId: ruleIdObserved && /^[A-Za-z0-9_.:-]{1,256}$/.test(error.rule_id) ? error.rule_id : null,
      ruleIdObserved, ...errorLocations(error, type) };
  });
  return {
    version: report.version, scannerExitCode: exitCode,
    status: exitCode === 0 && report.errors.length === 0 && successful && notificationErrors === 0 &&
      report.results.length === run.results.length && report.paths.scanned.length > 0 ? "COMPLETE" : "INCOMPLETE",
    engineRequested: report.engine_requested ?? null,
    findingCount: report.results.length, sarifFindingCount: run.results.length,
    errorCount: report.errors.length, targetCount: report.paths.scanned.length,
    errorInventory, errorInventoryTruncated: report.errors.length > errorInventory.length,
    errorInventorySha256: digest(JSON.stringify(report.errors)),
    skippedTargetCount: Array.isArray(report.paths.skipped) ? report.paths.skipped.length : null,
    skippedTargetInventory: Array.isArray(report.paths.skipped) ? "REPORTED" : "UNKNOWN",
    skippedRuleCount: Array.isArray(report.skipped_rules) ? report.skipped_rules.length : null,
    ruleCount: ids.length, ruleIdsSha256: digest(JSON.stringify([...ids].sort())),
    // Hash the rendered inventory, not a claim to possess the registry's source-rule bytes.
    renderedRuleInventorySha256: digest(JSON.stringify(run.tool.driver.rules)),
    targetInventorySha256: digest(JSON.stringify([...report.paths.scanned].sort())),
    successfulInvocation: successful, notificationErrorCount: notificationErrors,
    ruleSourceBytes: "NOT_CAPTURED", uploadProcessing: "NOT_VERIFIED",
    // COMPLETE describes the reports' execution contract, not every Git path or parser subtree.
    wholeCorpusCoverage: "NOT_ESTABLISHED", wholeAstCoverage: "NOT_ESTABLISHED",
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

export function parserControlSources() {
  const before = 'declare function rmdParserMarker(value: string): void;\nrmdParserMarker("before");\n';
  const after = '\nrmdParserMarker("after");\n';
  return {
    "module.ts": 'export interface Registration { version: string }\n',
    "inline-import.ts": before + 'export interface Inventory {\n  preventionSources?: { registrations: import("./module.js").Registration[]; unavailable: number };\n  rounds: string[];\n}\n' + after,
    "named-import.ts": 'import type { Registration } from "./module.js";\n' + before + 'export interface Inventory {\n  preventionSources?: { registrations: Registration[]; unavailable: number };\n  rounds: string[];\n}\n' + after,
  };
}

export function verifyParserControl(report, sarif, exitCode) {
  const summary = summarizeReports(report, sarif, exitCode);
  assert.equal(exitCode, 0, "parser control process failed");
  assert.equal(summary.engineRequested, "OSS", "parser control must use CE");
  assert.equal(summary.ruleCount, 1, "parser control must use one original rule");
  assert.ok(sarif.runs[0].tool.driver.rules[0].id.endsWith(PARSER_RULE_ID), "wrong parser rule");
  assert.ok(summary.successfulInvocation && summary.notificationErrorCount === 0, "parser invocation failed");
  assert.equal(summary.errorInventoryTruncated, false, "parser errors were truncated");
  const expected = ["inline-import.ts", "named-import.ts"];
  assert.deepEqual([...report.paths.scanned].sort(), expected, "parser target census differs");
  const markers = report.results.map((result) => {
    assert.ok(result.check_id.endsWith(PARSER_RULE_ID), "wrong parser finding rule");
    return `${result.path}:${result.start?.line}`;
  }).sort();
  const sarifMarkers = sarif.runs[0].results.map((result) => {
    assert.ok(result.ruleId.endsWith(PARSER_RULE_ID), "wrong parser SARIF rule");
    const location = result.locations?.[0]?.physicalLocation;
    return `${location?.artifactLocation?.uri}:${location?.region?.startLine}`;
  }).sort();
  assert.deepEqual(markers, ["inline-import.ts:2", "inline-import.ts:8", "named-import.ts:3", "named-import.ts:9"], "parser boundary markers missing");
  assert.deepEqual(sarifMarkers, markers, "parser JSON and SARIF markers differ");
  assert.ok(summary.errorInventory.every((error) => error.type === "PartialParsing" &&
    error.path === "inline-import.ts" && ["warn", "warning"].includes(error.level)), "unexpected parser-control error");
  return { ...summary, markerReachability: "VERIFIED", wholeAstCoverage: "NOT_ESTABLISHED",
    namedImport: "COMPLETE", inlineImport: summary.errorCount === 0 ? "COMPLETE" : "PARTIAL",
    sourceSha256: Object.fromEntries(Object.entries(parserControlSources()).map(([path, bytes]) => [path, digest(bytes)])),
    authority: "original paired parser diagnostic only; partial parsing is not waived or a source fix" };
}

export function qualifySemgrep({ command = "semgrep", enginePath = process.env.SEMGREP_QUALIFICATION_ENGINE } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-semgrep-qualification-"));
  const repo = join(root, "fixture");
  const deadline = Date.now() + 300_000;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") &&
    !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_TERMINAL_PROMPT"].includes(key)) delete env[key];
  for (const key of ["SEMGREP_APP_TOKEN", "SEMGREP_BASELINE_COMMIT", "SEMGREP_RULES"]) delete env[key];
  const run = (executable, args, cwd = repo) => {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "qualification deadline expired");
    const result = spawnSync(executable, args, { cwd, env, encoding: "utf8",
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
    assert.ok(enginePath, "actual Community Edition engine payload path is required");
    const engineBytes = readFileSync(enginePath);
    assert.ok(engineBytes.length > 0, "actual engine payload is empty");
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
    const parserRepo = join(root, "parser");
    mkdirSync(parserRepo);
    for (const [path, bytes] of Object.entries(parserControlSources())) writeFileSync(join(parserRepo, path), bytes);
    const parserRule = join(root, "parser-rule.json");
    const parserRuleBytes = JSON.stringify({ rules: [{ id: PARSER_RULE_ID, languages: ["typescript"],
      severity: "INFO", message: "original disposable parser boundary marker", pattern: "rmdParserMarker($X)" }] });
    writeFileSync(parserRule, parserRuleBytes);
    const parserOutput = join(root, "parser.json"), parserSarif = join(root, "parser.sarif");
    const parser = run(command, ["scan", "--config", parserRule, "--metrics", "off", "--disable-version-check",
      "--jobs", "1", "--timeout", "5", "--max-memory", "512", "--json", "--output", parserOutput,
      "--sarif-output", parserSarif, "inline-import.ts", "named-import.ts"], parserRepo);
    const parserControl = verifyParserControl(json(parserOutput), json(parserSarif), parser.status);
    assert.equal(git(["status", "--porcelain"]), "", "baseline fixture must stay clean");
    return { schema: "rmd-semgrep-native-qualification-v1", version: VERSION,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      enginePayload: { sha256: digest(engineBytes), bytes: engineBytes.length },
      workflowSha: process.env.GITHUB_SHA ?? null,
      lockSha256: {
        build: digest(readFileSync(new URL("../.github/semgrep/build-requirements.txt", import.meta.url))),
        runtime: digest(readFileSync(new URL("../.github/semgrep/requirements.txt", import.meta.url))),
      },
      controlRuleSha256: digest(ruleBytes), base, head, fullControl, baselineControl,
      invalidControl: { exitCode: bad.result.status, errorCount: invalidReport.errors.length },
      parserControl, parserRuleSha256: digest(parserRuleBytes),
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
  }, { helpText: "Usage: semgrep-native-contract-ratchet.mjs --receipt PATH [--json PATH --sarif PATH --exit CODE]" });
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
