import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { summarizeReports, verifyControl, verifyParserControl, parserControlSources, qualifySemgrep, main } = await import(
  new URL("../scripts/semgrep-native-contract-ratchet.mjs", import.meta.url).href);
const ruleId = "rmd-native-qualification-sentinel";
function reports(paths = ["old.js", "new.js"]) {
  return {
    report: { version: "1.181.0", engine_requested: "OSS", errors: [], skipped_rules: [], paths: { scanned: paths, skipped: [] },
      results: paths.map(path => ({ path, check_id: ruleId })) },
    sarif: { version: "2.1.0", runs: [{ tool: { driver: { semanticVersion: "1.181.0", rules: [{ id: ruleId }] } },
      invocations: [{ executionSuccessful: true, toolExecutionNotifications: [] }],
      results: paths.map(path => ({ ruleId, locations: [{ physicalLocation: { artifactLocation: { uri: path } } }] })) }] },
  };
}

function parserReports(partial = true) {
  const id = "rmd-original-typescript-parser-marker";
  const { report, sarif } = reports(["inline-import.ts", "named-import.ts"]);
  report.results = [2, 8, 3, 9].map((line, i) => ({ path: i < 2 ? "inline-import.ts" : "named-import.ts", check_id: id, start: { line } })) as typeof report.results;
  report.errors = (partial ? [{ type: ["PartialParsing", [{ path: "inline-import.ts", start: { line: 4 }, end: { line: 4 } }]],
    path: "inline-import.ts", level: "warn", message: "never retain source" }] : []) as typeof report.errors;
  sarif.runs[0]!.tool.driver.rules = [{ id }];
  sarif.runs[0]!.results = report.results.map((result: any) => ({ ruleId: id, locations: [{ physicalLocation: {
    artifactLocation: { uri: result.path }, region: { startLine: result.start.line } } }] })) as typeof sarif.runs[0]["results"];
  return { report, sarif };
}

test("native Semgrep paired parser controls preserve partial parsing separately from marker reachability", () => {
  const partial = parserReports();
  const observed = verifyParserControl(partial.report, partial.sarif, 0);
  assert.equal(observed.status, "INCOMPLETE");
  assert.equal(observed.inlineImport, "PARTIAL");
  assert.equal(observed.namedImport, "COMPLETE");
  assert.equal(observed.markerReachability, "VERIFIED");
  assert.equal(observed.wholeAstCoverage, "NOT_ESTABLISHED");
  assert.ok(!JSON.stringify(observed).includes("never retain source"));
  const complete = parserReports(false);
  assert.equal(verifyParserControl(complete.report, complete.sarif, 0).inlineImport, "COMPLETE");
  const sources = parserControlSources();
  assert.deepEqual(Object.keys(sources).sort(), ["inline-import.ts", "module.ts", "named-import.ts"]);
  assert.match(sources["inline-import.ts"], /registrations: import\("\.\/module.js"\)\.Registration\[\]/);
  assert.match(sources["named-import.ts"], /import type \{ Registration \}/);
  assert.match(observed.sourceSha256["inline-import.ts"], /^[a-f0-9]{64}$/);
});

test("native Semgrep parser controls refuse missing markers, unqualified targets and unexpected errors", () => {
  const original = parserReports();
  assert.throws(() => verifyParserControl(original.report, original.sarif, 2), /process failed/);
  for (const change of [
    (r: any) => { r.report.results.pop(); },
    (r: any) => { r.report.results[0].start.line = 99; },
    (r: any) => { r.sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine = 99; },
    (r: any) => { r.report.paths.scanned.push("unobserved.ts"); },
    (r: any) => { r.report.engine_requested = "PRO"; },
    (r: any) => { r.report.errors[0].path = "named-import.ts"; },
    (r: any) => { r.report.errors[0].type = "Timeout"; },
    (r: any) => { r.report.errors[0].level = "error"; },
    (r: any) => { r.report.errors = Array(65).fill(r.report.errors[0]); },
    (r: any) => { r.sarif.runs[0].tool.driver.rules[0].id = "wrong-rule"; },
    (r: any) => { r.report.results[0].check_id = "wrong-rule"; },
    (r: any) => { r.sarif.runs[0].results[0].ruleId = "wrong-rule"; },
    (r: any) => { r.sarif.runs[0].invocations[0].executionSuccessful = false; },
  ]) {
    const changed = structuredClone(original); change(changed);
    assert.throws(() => verifyParserControl(changed.report, changed.sarif, 0));
  }
});

test("native Semgrep controls distinguish full and baseline sentinels in both report formats", () => {
  const full = reports(), baseline = reports(["new.js"]);
  assert.equal(verifyControl(full.report, full.sarif, ["old.js", "new.js"]).status, "COMPLETE");
  assert.equal(verifyControl(baseline.report, baseline.sarif, ["new.js"]).findingCount, 1);
  assert.throws(() => verifyControl(full.report, full.sarif, ["new.js"]), /baseline did not distinguish/);
  assert.throws(() => verifyControl(baseline.report, baseline.sarif, ["old.js", "new.js"]), /baseline did not distinguish/);
  baseline.sarif.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri = "old.js";
  assert.throws(() => verifyControl(baseline.report, baseline.sarif, ["new.js"]), /SARIF and JSON/);
});

test("native Semgrep missing, mismatched and failed observations never become complete qualification", () => {
  const { report, sarif } = reports();
  const summary = summarizeReports(report, sarif, 0);
  assert.equal(summary.status, "COMPLETE"); // Positive corpus control.
  assert.equal(summary.ruleCount, 1);
  assert.equal(summary.targetCount, 2);
  assert.equal(summary.ruleSourceBytes, "NOT_CAPTURED");
  assert.equal(summary.uploadProcessing, "NOT_VERIFIED");
  assert.match(summary.renderedRuleInventorySha256, /^[a-f0-9]{64}$/);
  assert.equal(summarizeReports(report, sarif, 2).status, "INCOMPLETE");
  assert.throws(() => summarizeReports(report, sarif, NaN), /exit status is unavailable/);
  assert.throws(() => summarizeReports({ ...report, version: "1.167.0" }, sarif, 0), /scanner version/);
  assert.throws(() => summarizeReports({ ...report, paths: {} }, sarif, 0), /target inventory/);
  assert.throws(() => summarizeReports(report, { ...sarif, runs: [] }, 0), /one SARIF run/);
  const noRules = structuredClone(sarif); noRules.runs[0]!.tool.driver.rules = [];
  assert.throws(() => summarizeReports(report, noRules, 0), /rule inventory is empty/);
  assert.equal(summarizeReports({ ...report, errors: [{}] }, sarif, 0).status, "INCOMPLETE");
  const missing = structuredClone(sarif); missing.runs[0]!.invocations = [];
  assert.equal(summarizeReports(report, missing, 0).status, "INCOMPLETE");
  const failed = structuredClone(sarif); failed.runs[0]!.invocations[0]!.executionSuccessful = false;
  assert.equal(summarizeReports(report, failed, 0).status, "INCOMPLETE");
  const omitted = structuredClone(sarif); omitted.runs[0]!.results.pop();
  assert.equal(summarizeReports(report, omitted, 0).status, "INCOMPLETE");
  const unknown = { ...report, paths: { scanned: report.paths.scanned } };
  assert.equal(summarizeReports(unknown, sarif, 0).skippedTargetCount, null, "missingness is not zero");
});

test("native Semgrep error inventory preserves partial scans without exposing messages or outside paths", () => {
  const { report, sarif } = reports();
  const errors = [
    { type: "ParseError", level: "warn", path: "test/fixtures/invalid.ts", message: "private source bytes" },
    { type: ["PartialParsing", []], level: "warning", spans: [{ file: "src/example.ts" }], message: "private source bytes" },
    { type: "secret type with spaces", level: "unknown", path: "/Users/secret/file.ts", message: "private source bytes" },
    { type: "Timeout", level: "error", path: "../outside.ts", message: "private source bytes" },
  ];
  const summary = summarizeReports({ ...report, errors }, sarif, 0);
  assert.equal(summary.status, "INCOMPLETE", "exit zero with parser errors is never complete");
  assert.deepEqual(summary.errorInventory.map(({ type, level, path }: { type: string; level: string; path: string | null }) => ({ type, level, path })), [
    { type: "ParseError", level: "warn", path: "test/fixtures/invalid.ts" },
    { type: "PartialParsing", level: "warning", path: "src/example.ts" },
    { type: "UNKNOWN", level: "UNKNOWN", path: null },
    { type: "Timeout", level: "error", path: null },
  ]);
  assert.equal(summary.errorInventoryTruncated, false);
  assert.ok(!JSON.stringify(summary).includes("private source bytes"));
  assert.ok(!JSON.stringify(summary).includes("/Users/secret"));
  const many = summarizeReports({ ...report, errors: Array.from({ length: 65 }, () => errors[0]) }, sarif, 0);
  assert.equal(many.errorCount, 65);
  assert.equal(many.errorInventory.length, 64);
  assert.equal(many.errorInventoryTruncated, true);
});

test("native Semgrep warning diagnostics retain schema labels, observed rules and omitted source ranges", () => {
  const { report, sarif } = reports();
  const omitted = { path: "src/partial.ts", start: { line: 12 }, end: { line: 18 }, snippet: "never emit source" };
  const errors = [
    { type: "Syntax error", level: "warn", path: ".mcp.json" },
    { type: "Timeout", level: "warn", path: "src/review.ts", rule_id: ruleId },
    { type: ["PartialParsing", [omitted]], level: "warn", path: "src/partial.ts" },
    { type: "Timeout", level: "warn", rule_id: "unobserved-private-rule" },
    { type: "secret type with spaces", level: "warn", spans: [
      { file: "../private.ts", start: { line: 0 }, end: { line: 5 } },
      { file: "/private/source.ts", start: { line: 10 }, end: { line: 2 } },
      null, { file: "src/valid.ts", start: { line: 2 }, end: { line: 2 } },
      { file: "src/huge.ts", start: { line: 10000001 }, end: { line: 10000002 } },
    ] },
  ];
  const summary = summarizeReports({ ...report, errors }, sarif, 0);
  assert.equal(summary.status, "INCOMPLETE", "better diagnostics do not waive warnings");
  assert.equal(summary.errorInventory[0].type, "Syntax error");
  assert.equal(summary.errorInventory[0].locations, null, "missing spans are not zero locations");
  assert.equal(summary.errorInventory[0].ruleIdObserved, null, "missing rule is not an unobserved rule");
  assert.equal(summary.errorInventory[1].ruleId, ruleId);
  assert.equal(summary.errorInventory[1].ruleIdObserved, true);
  assert.deepEqual(summary.errorInventory[2].locations, [{ path: "src/partial.ts", startLine: 12, endLine: 18 }]);
  assert.equal(summary.errorInventory[2].locationCount, 1);
  assert.equal(summary.errorInventory[3].ruleId, null);
  assert.equal(summary.errorInventory[3].ruleIdObserved, false);
  assert.equal(summary.errorInventory[4].type, "UNKNOWN");
  assert.deepEqual(summary.errorInventory[4].locations, [
    { path: null, startLine: null, endLine: null }, { path: null, startLine: null, endLine: null },
    { path: null, startLine: null, endLine: null }, { path: "src/valid.ts", startLine: 2, endLine: 2 },
    { path: "src/huge.ts", startLine: null, endLine: null },
  ]);
  const bounded = summarizeReports({ ...report, errors: [{ type: ["PartialParsing", Array(9).fill(omitted)] }] }, sarif, 0);
  assert.equal(bounded.errorInventory[0].locations.length, 8);
  assert.equal(bounded.errorInventory[0].locationCount, 9);
  assert.equal(bounded.errorInventory[0].locationsTruncated, true);
  assert.ok(!JSON.stringify(summary).includes("never emit source"));
  assert.ok(!JSON.stringify(summary).includes("unobserved-private-rule"));
});

test("native Semgrep real subprocess fixture exercises CLI contracts without pretending to be native engine evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-semgrep-cli-contract-"));
  const command = join(root, "fake-semgrep");
  try {
    // A deliberately labelled emulator, not Semgrep. Actual engine qualification belongs to Scan.
    writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.181.0'); process.exit(0); }
const value = flag => args[args.indexOf(flag) + 1];
const invalid = value('--config').endsWith('invalid.json');
const paths = args.includes('--baseline-commit') ? ['new.js'] : ['old.js', 'new.js'];
const data = ${JSON.stringify(reports())};
data.report.results = paths.map(path => ({path, check_id: '${ruleId}'}));
data.report.paths.scanned = paths;
data.sarif.runs[0].results = paths.map(path => ({ruleId: '${ruleId}', locations: [{physicalLocation: {artifactLocation: {uri: path}}}]}));
if (invalid) data.report.errors = [{type: 'InvalidRuleSchemaError'}];
if (value('--config').endsWith('parser-rule.json')) Object.assign(data, ${JSON.stringify(parserReports())});
fs.writeFileSync(value('--output'), JSON.stringify(data.report));
fs.writeFileSync(value('--sarif-output'), JSON.stringify(data.sarif));
process.exit(invalid ? 4 : 0);
`);
    chmodSync(command, 0o755);
    const receipt = qualifySemgrep({ command, enginePath: command });
    assert.equal(receipt.fullControl.findingCount, 2);
    assert.equal(receipt.baselineControl.findingCount, 1);
    assert.equal(receipt.invalidControl.exitCode, 4);
    assert.equal(receipt.parserControl.inlineImport, "PARTIAL");
    assert.equal(receipt.parserControl.namedImport, "COMPLETE");
    assert.equal(receipt.parserControl.wholeAstCoverage, "NOT_ESTABLISHED");
    assert.notEqual(receipt.base, receipt.head, "real isolated git baseline and head differ");
    assert.match(receipt.enginePayload.sha256, /^[a-f0-9]{64}$/);
    assert.ok(receipt.enginePayload.bytes > 0, "fake payload identity is observed, not native proof");
    assert.throws(() => qualifySemgrep({ command, enginePath: "" }), /engine payload path/);
    writeFileSync(command, "#!/usr/bin/env node\nconsole.log('wrong-version');\n");
    assert.throws(() => qualifySemgrep({ command }), /installed scanner version differs/);
    assert.throws(() => qualifySemgrep({ command: join(root, "absent") }), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Semgrep report receipts are immutable and never imply upload processing", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-semgrep-report-cli-"));
  try {
    const { report, sarif } = reports();
    const json = join(root, "report.json"), sarifPath = join(root, "report.sarif"), receipt = join(root, "receipt.json");
    writeFileSync(json, JSON.stringify(report)); writeFileSync(sarifPath, JSON.stringify(sarif));
    const lines: string[] = [];
    const args = ["--receipt", receipt, "--json", json, "--sarif", sarifPath, "--exit", "0"];
    assert.equal(main(args, (line: string) => lines.push(line)), 0);
    assert.equal(JSON.parse(lines[0]!).uploadProcessing, "NOT_VERIFIED");
    assert.ok(existsSync(receipt));
    assert.throws(() => main(args, () => {}), { code: "EEXIST" });
    assert.throws(() => main(["--receipt", receipt, "--json", json], () => {}), /all report inputs/);
    assert.throws(() => main(args.map(arg => arg === "0" ? "unknown" : arg), () => {}), /exit status/);
    assert.equal(main(["--help"], () => {}), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
