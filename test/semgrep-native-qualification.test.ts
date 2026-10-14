import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { summarizeReports, verifyControl, qualifySemgrep, main } = await import(
  new URL("../scripts/semgrep-native-contract-ratchet.mjs", import.meta.url).href);
const ruleId = "rmd-native-qualification-sentinel";
function reports(paths = ["old.js", "new.js"]) {
  return {
    report: { version: "1.180.0", engine_requested: "OSS", errors: [], skipped_rules: [], paths: { scanned: paths, skipped: [] },
      results: paths.map(path => ({ path, check_id: ruleId })) },
    sarif: { version: "2.1.0", runs: [{ tool: { driver: { semanticVersion: "1.180.0", rules: [{ id: ruleId }] } },
      invocations: [{ executionSuccessful: true, toolExecutionNotifications: [] }],
      results: paths.map(path => ({ ruleId, locations: [{ physicalLocation: { artifactLocation: { uri: path } } }] })) }] },
  };
}

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

test("native Semgrep real subprocess fixture exercises CLI contracts without pretending to be native engine evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-semgrep-cli-contract-"));
  const command = join(root, "fake-semgrep");
  try {
    // A deliberately labelled emulator, not Semgrep. Actual engine qualification belongs to Scan.
    writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.180.0'); process.exit(0); }
const value = flag => args[args.indexOf(flag) + 1];
const invalid = value('--config').endsWith('invalid.json');
const paths = args.includes('--baseline-commit') ? ['new.js'] : ['old.js', 'new.js'];
const data = ${JSON.stringify(reports())};
data.report.results = paths.map(path => ({path, check_id: '${ruleId}'}));
data.report.paths.scanned = paths;
data.sarif.runs[0].results = paths.map(path => ({ruleId: '${ruleId}', locations: [{physicalLocation: {artifactLocation: {uri: path}}}]}));
if (invalid) data.report.errors = [{type: 'InvalidRuleSchemaError'}];
fs.writeFileSync(value('--output'), JSON.stringify(data.report));
fs.writeFileSync(value('--sarif-output'), JSON.stringify(data.sarif));
process.exit(invalid ? 4 : 0);
`);
    chmodSync(command, 0o755);
    const receipt = qualifySemgrep({ command, enginePath: command });
    assert.equal(receipt.fullControl.findingCount, 2);
    assert.equal(receipt.baselineControl.findingCount, 1);
    assert.equal(receipt.invalidControl.exitCode, 4);
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
