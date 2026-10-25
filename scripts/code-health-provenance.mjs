#!/usr/bin/env node
// Sanitized evidence from existing measurements; no scanner, network or filing side effects.
import { parseLcovRecords } from "./lib/lcov.mjs";
import { parseLcovTotals, classifyCoverageTier } from "./coverage-ratchet.mjs";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
// Fingerprint measurement code, not the application commit or its changing line counts.
const methodHash = files => hash(files.map(path => [path, readFileSync(new URL(path, import.meta.url), "utf8")]));
const text = (value, bound = 256) => typeof value === "string" && value.length > 0 && value.length <= bound && !value.includes("\0");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const relativePath = value => text(value, 4096) && !/^(?:\/|[a-z]+:)/i.test(value) && !value.includes("\\") &&
  value.split("/").every(part => part !== ".." && part !== "." && part !== "");

/** Original SARIF's explicit analysis targets describe the measured subset, never the whole repository. */
export function codeqlProvenance(input) {
  if (!input || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(input.repository) ||
      !/^[a-f0-9]{40}$/i.test(input.analyzedSha) || input.ref !== "refs/heads/main" ||
      !/^[1-9][0-9]{0,19}$/.test(input.runId) || !/^[1-9][0-9]{0,5}$/.test(input.runAttempt) ||
      !timestamp(input.observedAt) || !/^[a-z][a-z0-9-]{0,63}$/.test(input.language) ||
      !/^[a-f0-9-]{36}$/i.test(input.sarifId) || !text(input.config, 1_048_576) ||
      !Array.isArray(input.exclusions) || input.exclusions.length > 128 || !input.exclusions.every(value => text(value)) ||
      input.sarif?.version !== "2.1.0" || !Array.isArray(input.sarif.runs) || input.sarif.runs.length !== 1) {
    throw new Error("Code health provenance identity, configuration or original SARIF is invalid.");
  }
  const run = input.sarif.runs[0], driver = run.tool?.driver;
  const reasons = input.exclusionsKnown === false ? ["The configured exclusions could not be read without ambiguity."] : [], targets = new Set(), components = [driver, ...(run.tool?.extensions ?? [])];
  if (!driver || !/CodeQL/i.test(driver.name ?? "") || !text(driver.version)) reasons.push("The original analysis has no supported tool version.");
  if (!Array.isArray(run.artifacts) || run.artifacts.length > 100_000) reasons.push("The original analysis has no bounded measured-file inventory.");
  else for (const artifact of run.artifacts) {
    if (!artifact.roles?.includes("analysisTarget")) continue;
    let uri;
    try { uri = decodeURIComponent(artifact.location?.uri ?? ""); } catch { uri = ""; }
    if (relativePath(uri)) targets.add(uri);
    else reasons.push("A measured file cannot be resolved within this repository.");
  }
  if (!targets.size) reasons.push("Explicit measured files are unavailable; result locations do not establish scan scope.");
  const invocations = Array.isArray(run.invocations) && run.invocations.length <= 64 ? run.invocations : [];
  const contradictoryCompletion = invocations.some(invocation => invocation.executionSuccessful === false ||
    typeof invocation.endTimeUtc === "string" && (!timestamp(invocation.endTimeUtc) || Date.parse(invocation.endTimeUtc) > Date.parse(input.observedAt)) ||
    [...(invocation.toolExecutionNotifications ?? []), ...(invocation.toolConfigurationNotifications ?? [])].some(value => value.level === "error"));
  const originalCompletion = invocations.length > 0 && invocations.every(invocation => invocation.executionSuccessful === true && timestamp(invocation.endTimeUtc));
  const completion = contradictoryCompletion ? null : originalCompletion ? { kind: "original-invocations", state: "success",
    at: invocations.map(invocation => invocation.endTimeUtc).sort().at(-1) } : input.analysisSucceeded === true ?
    { kind: "workflow-analysis-step", state: "success", at: input.observedAt } : null;
  if (completion === null) reasons.push("Successful analysis completion is not fully attested in the original output or workflow step.");
  if (components.length > 128 || components.some(component => !component || !text(component.name) ||
      component.rules && (!Array.isArray(component.rules) || component.rules.length > 20_000 || component.rules.some(rule => !text(rule.id))))) {
    throw new Error("Code health tool or rule inventory is invalid.");
  }
  const rules = components.map(component => [component.name, component.version ?? component.semanticVersion ?? null,
    [...(component.rules ?? [])].map(rule => canonical(rule)).sort((a, b) => a.id.localeCompare(b.id))]).sort(([a], [b]) => a.localeCompare(b));
  const ruleCount = components.reduce((count, component) => count + (component.rules ?? []).filter(rule => rule.defaultConfiguration?.enabled !== false).length, 0);
  if (!ruleCount) reasons.push("The original analysis has no enabled-rule inventory.");
  const hasScope = targets.size > 0 && !reasons.some(reason => reason.includes("resolved"));
  return { version: "code-health-source-v1", kind: "quality", repository: input.repository.toLowerCase(), analyzedSha: input.analyzedSha.toLowerCase(),
    ref: input.ref, runId: input.runId, runAttempt: input.runAttempt, observedAt: input.observedAt, language: input.language, sarifId: input.sarifId,
    scanId: `codeql:${input.runId}:${input.runAttempt}:${input.language}:${input.sarifId}`, completion,
    state: reasons.length ? "partial" : "complete", reasons: [...new Set(reasons)],
    toolVersion: text(driver?.version) ? driver.version : null, rulesVersion: ruleCount ? hash(rules) : null, ruleCount,
    configHash: hash([input.config, [...input.exclusions].sort(), methodHash(["./code-health-provenance.mjs"])]), exclusions: [...new Set(input.exclusions)].sort(),
    scope: { kind: "explicit-analysis-targets", fileCount: targets.size, hash: hasScope ? hash([...targets].sort()) : null } };
}

/** Keep the original LCOV population and the existing policy; never turn a missing denominator into 100%. */
export function coverageProvenance(summary, lcov, baseline, workflow, repository) {
  if (!summary || summary.kind !== "coverage_nightly.measured" || !/^[a-f0-9]{40}$/i.test(summary.sha) ||
      summary.ref !== "refs/heads/main" || !/^[1-9][0-9]{0,19}$/.test(summary.run_id) || !timestamp(summary.measured_at) ||
      !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(repository) ||
      summary.repository && summary.repository.toLowerCase() !== repository.toLowerCase()) throw new Error("Coverage provenance identity is invalid.");
  const records = parseLcovRecords(lcov), totals = parseLcovTotals(lcov), reasons = [];
  if (!records.length || records.length > 100_000 || !totals.lf || !totals.brf) reasons.push("A nonempty bounded coverage population is unavailable.");
  if (records.some(record => !relativePath(record.sourceFile) ||
      ![record.lf, record.lh, record.brf, record.brh].every(value => Number.isSafeInteger(value) && value >= 0) ||
      record.lh > record.lf || record.brh > record.brf || record.da.some(value => !Number.isSafeInteger(value.line) || value.line <= 0 || !Number.isSafeInteger(value.hits) || value.hits < 0)) ||
      new Set(records.map(record => record.sourceFile)).size !== records.length ||
      lcov.split(/\r?\n/).filter(line => line === "end_of_record").length !== records.length) reasons.push("The measured coverage inventory is incomplete or malformed.");
  if (!["lf", "lh", "brf", "brh"].every(key => summary[key] === totals[key]) || summary.skipped_records !== totals.skippedRecords ||
      !Number.isFinite(summary.lines_pct) || !Number.isFinite(summary.branches_pct) ||
      Math.abs(summary.lines_pct - totals.linesPct) > 1e-9 || Math.abs(summary.branches_pct - totals.branchesPct) > 1e-9 || totals.skippedRecords) reasons.push("The summary does not match the original measured coverage.");
  const exits = summary.shard_test_exits;
  if (!exits || typeof exits !== "object" || Array.isArray(exits) || Object.keys(exits).sort().join(",") !== "1,2,3,4,5,6,7,8" ||
      Object.values(exits).some(exit => exit !== 0)) reasons.push("All eight required instrumented shards have not completed successfully.");
  const exclusions = [...workflow.matchAll(/--test-coverage-exclude=(?:"([^"\n]+)"|'([^'\n]+)'|([^\s\n]+))/g)].map(match => match[1] ?? match[2] ?? match[3]);
  if (!workflow.includes("--select-all") || !exclusions.length) reasons.push("The complete selection and coverage exclusions are not attested.");
  const tier = classifyCoverageTier(totals, baseline);
  const validScope = records.length > 0 && !reasons.some(reason => /population|inventory|summary/.test(reason));
  return { version: "code-health-source-v1", kind: "coverage", repository: repository.toLowerCase(), analyzedSha: summary.sha.toLowerCase(),
    ref: summary.ref, runId: summary.run_id, observedAt: summary.measured_at, scanId: `coverage-nightly:${summary.run_id}`,
    state: reasons.length ? "partial" : "complete", reasons, toolVersion: process.version,
    rulesVersion: hash(canonical(baseline)), configHash: hash([workflow, methodHash(["./code-health-provenance.mjs", "./coverage-ratchet.mjs", "./lib/lcov.mjs"])]), exclusions: [...new Set(exclusions)].sort(),
    scope: { kind: "instrumented-source-files", fileCount: records.length, hash: validScope ? hash(["instrumented-source-files", records.map(record => record.sourceFile).sort()]) : null },
    measurement: { branches: { covered: totals.brh, total: totals.brf }, lines: { covered: totals.lh, total: totals.lf } },
    check: { id: "coverage-existing-tier", met: reasons.length === 0 && tier.tier === "healthy", reason: reasons.length ? "Coverage could not be assessed because its source evidence is incomplete." : `Instrumented branch coverage is in this repository's existing ${tier.tier} tier.` } };
}

function boundedRead(path, limit) {
  if (!path) throw new Error("Unbounded or unavailable analysis input.");
  // Check and read through one open handle so the file cannot change between the two.
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Unbounded or unavailable analysis input.");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

// Recognize the repository's simple YAML block list; unsupported YAML stays explicitly unknown.
function exclusionsFromConfig(config) {
  const lines = config.split(/\r?\n/), starts = lines.map((line, index) => /^paths-ignore\s*:/.test(line) ? index : -1).filter(index => index >= 0);
  if (!starts.length) return { values: [], known: true };
  if (starts.length !== 1 || !/^paths-ignore:\s*(?:#.*)?$/.test(lines[starts[0]])) return { values: [], known: false };
  const values = [];
  for (const line of lines.slice(starts[0] + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+-\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*(?:#.*)?$/);
    if (!match) return { values: [], known: false };
    try { values.push(match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1).replaceAll("''", "'")); }
    catch { return { values: [], known: false }; }
  }
  return { values, known: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" },
      "coverage-summary": { type: "string" }, lcov: { type: "string" }, baseline: { type: "string" },
      "sarif-dir": { type: "string" }, config: { type: "string" }, workflow: { type: "string" } } });
    let input, result;
    if (values["coverage-summary"]) {
      if (values.input || values["sarif-dir"] || values.config) throw new Error("Choose one evidence source.");
      const summary = JSON.parse(boundedRead(values["coverage-summary"], 1024 ** 2));
      result = { ...summary, code_health: coverageProvenance(summary, boundedRead(values.lcov, 64 * 1024 ** 2),
        JSON.parse(boundedRead(values.baseline, 1024 ** 2)), boundedRead(values.workflow, 1024 ** 2), process.env.GITHUB_REPOSITORY) };
    } else if (values.input) {
      if (values["sarif-dir"] || values.config || values.workflow) throw new Error("Choose one original-output input mechanism.");
      input = JSON.parse(boundedRead(values.input, 64 * 1024 ** 2));
    } else {
      const files = readdirSync(values["sarif-dir"]).filter(name => name.endsWith(".sarif") && !name.endsWith(".quality.sarif") && !name.endsWith(".csra.sarif"));
      if (files.length !== 1) throw new Error("Each language job must supply exactly one original analysis.");
      const config = boundedRead(values.config, 1024 ** 2), workflow = boundedRead(values.workflow, 1024 ** 2), exclusions = exclusionsFromConfig(config);
      input = { repository: process.env.GITHUB_REPOSITORY, analyzedSha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF,
        runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, observedAt: new Date().toISOString(),
        analysisSucceeded: process.env.CODE_HEALTH_ANALYSIS_OUTCOME === "success",
        language: process.env.CODE_HEALTH_LANGUAGE, sarifId: process.env.CODE_HEALTH_SARIF_ID,
        config: JSON.stringify([config, workflow]), exclusions: exclusions.values, exclusionsKnown: exclusions.known,
        sarif: JSON.parse(boundedRead(join(values["sarif-dir"], files[0]), 64 * 1024 ** 2)) };
    }
    const serialized = JSON.stringify(result ?? codeqlProvenance(input)) + "\n";
    if (!values.output || Buffer.byteLength(serialized) > 32 * 1024) throw new Error("Invalid or oversized evidence publication.");
    writeFileSync(values.output, serialized, { flag: "wx", mode: 0o600 });
  } catch {
    // Raw SARIF parse failures may contain security text. Keep the public diagnostic allowlisted too.
    process.stderr.write("Code health evidence export failed: invalid input or unavailable original analysis.\n");
    process.exitCode = 1;
  }
}
