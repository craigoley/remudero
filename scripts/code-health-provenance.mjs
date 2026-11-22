#!/usr/bin/env node
// Sanitized evidence from existing measurements; no scanner, network or filing side effects.
import { parseLcovRecords } from "./lib/lcov.mjs";
import { parseLcovTotals, classifyCoverageTier } from "./coverage-ratchet.mjs";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
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
const semanticVersion = value => text(value) && !/\s/.test(value) && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(value);
const extractedMethod = "codeql-extracted-files";
const extractedTag = "successfully-extracted-files";
const languageFamilies = new Map([["javascript-typescript", "js"], ["python", "py"], ["actions", "actions"]]);
const inventoryLimit = 100_000;
const boundedArray = (value, limit) => Array.isArray(value) && value.length <= limit;
const extractedId = id => typeof id === "string" && id.endsWith(`/diagnostics/${extractedTag}`);
const extractedDescriptor = descriptor => extractedId(descriptor?.id) ||
  extractedId(descriptor?.properties?.id) ||
  Array.isArray(descriptor?.properties?.tags) && descriptor.properties.tags.includes(extractedTag);

function originalToolVersion(driver) {
  if (!driver || !/CodeQL/i.test(driver.name ?? "")) return null;
  if (!Object.hasOwn(driver, "semanticVersion")) return text(driver.version) ? driver.version : null;
  if (!semanticVersion(driver.semanticVersion) || Object.hasOwn(driver, "version") &&
      (!text(driver.version) || semanticVersion(driver.version) && driver.version !== driver.semanticVersion)) return null;
  return driver.semanticVersion;
}

function sourcePath(location) {
  const uri = location?.uri;
  if (location?.uriBaseId !== "%SRCROOT%" || !text(uri, 4096) ||
      !/^(?:[a-z\d._~!$&'()*+,;=@/-]|%[a-f\d]{2})+$/i.test(uri) || /%2f|%5c/i.test(uri)) return null;
  let path;
  try { path = decodeURIComponent(uri); } catch { return null; }
  return relativePath(path) && !/[:\x00-\x1f\x7f\uFFFD]/.test(path) ? path : null;
}

function extractedPath(notification, artifacts) {
  const locations = notification.locations;
  if (notification.level !== "none" || !Array.isArray(locations) || locations.length !== 1) return null;
  const physical = locations[0]?.physicalLocation;
  const location = physical?.artifactLocation;
  if (!Number.isSafeInteger(location?.index) || location.index < 0 || location.index >= artifacts.length ||
      Object.keys(physical).length !== 1) return null;
  const artifact = artifacts[location.index];
  const original = artifact?.location;
  const path = sourcePath(location);
  return path !== null && (artifact?.parentIndex === undefined || artifact.parentIndex === -1) &&
    original?.index === location.index && sourcePath(original) === path ? path : null;
}

function matchingOriginalSource(run, input) {
  const category = `/language:${input.language}`;
  const provenance = run.versionControlProvenance;
  const bases = run.originalUriBaseIds;
  if (run.automationDetails !== undefined && ![category, `${category}/`].includes(run.automationDetails?.id)) return false;
  if (bases !== undefined && (!bases || typeof bases !== "object" || Array.isArray(bases) || Object.hasOwn(bases, "%SRCROOT%"))) return false;
  if (provenance === undefined) return true;
  const repository = `https://github.com/${input.repository.toLowerCase()}`;
  return boundedArray(provenance, 1) && provenance.length === 1 && provenance.every(entry => typeof entry?.revisionId === "string" &&
    entry.revisionId.toLowerCase() === input.analyzedSha.toLowerCase() && (entry.repositoryUri === undefined ||
      typeof entry.repositoryUri === "string" && [repository, `${repository}.git`].includes(entry.repositoryUri.toLowerCase())));
}

// CodeQL emits one diagnostic location per file with matching descriptor and artifact references.
function extractedScope(input, completion, toolVersion) {
  const run = input.sarif.runs[0], { driver, extensions = [] } = run.tool;
  const absent = { state: "absent" }, unverified = { state: "unverified" };
  const descriptors = driver.notifications;
  const invocation = run.invocations?.[0], notifications = invocation?.toolExecutionNotifications;
  if (descriptors === undefined && notifications === undefined) return absent;
  if (!Array.isArray(run.invocations) || run.invocations.length !== 1 || !boundedArray(descriptors, 20_000) ||
      descriptors.some(descriptor => !text(descriptor?.id)) || !boundedArray(notifications, inventoryLimit) ||
      !boundedArray(extensions, 127) || extensions.some(extension => extension?.notifications !== undefined &&
        (!boundedArray(extension.notifications, 20_000) || extension.notifications.some(extractedDescriptor)))) return unverified;
  const family = languageFamilies.get(input.language), id = `${family}/diagnostics/${extractedTag}`;
  const entries = descriptors.filter(extractedDescriptor);
  if (!entries.length && !notifications.some(note => extractedId(note?.descriptor?.id))) return absent;
  const descriptor = entries[0], index = descriptors.indexOf(descriptor);
  if (!family || driver.name !== "CodeQL" || !semanticVersion(toolVersion) || entries.length !== 1 ||
      descriptor.id !== id || descriptor.properties?.id !== id || descriptor.properties.kind !== "diagnostic" ||
      descriptor.defaultConfiguration?.enabled === false || !Array.isArray(descriptor.properties.tags) ||
      !descriptor.properties.tags.includes(extractedTag) || !boundedArray(run.artifacts, inventoryLimit) ||
      run.externalPropertyFileReferences !== undefined) return unverified;

  const paths = new Set();
  for (const note of notifications) {
    const reference = note?.descriptor;
    if (!text(reference?.id) || !Number.isSafeInteger(reference.index) || reference.index < 0 ||
        reference.toolComponent !== undefined || descriptors[reference.index]?.id !== reference.id) return unverified;
    if (reference.index !== index) continue;
    const path = extractedPath(note, run.artifacts);
    if (path === null) return unverified;
    paths.add(path);
  }
  if (!paths.size) return absent;
  if (!completion || (input.analysisSucceeded !== undefined && input.analysisSucceeded !== true) ||
      invocation.executionSuccessful !== true || invocation.endTimeUtc !== undefined && !timestamp(invocation.endTimeUtc) ||
      (invocation.toolConfigurationNotifications !== undefined && !boundedArray(invocation.toolConfigurationNotifications, inventoryLimit)) ||
      !matchingOriginalSource(run, input)) return unverified;
  return { state: "verified", scope: { kind: extractedMethod, fileCount: paths.size, hash: hash([extractedMethod, [...paths].sort()]) } };
}

// W1-T10889: expose known structures and bounded counts without publishing the original contents.
function originalStructure(input, scopeMethod, extractedFiles) {
  const run = input.sarif.runs[0], driver = run.tool.driver, limit = 20_000;
  const shape = value => value === undefined ? "absent" : Array.isArray(value) ? "array" : "invalid";
  const count = value => Array.isArray(value) ? Math.min(value.length, limit) : 0;
  const items = value => Array.isArray(value) ? value.slice(0, limit) : [];
  const versionShape = (key, valid) => !Object.hasOwn(driver, key) ? "absent" : valid(driver[key]) ? "valid" : "invalid";
  const expectedFiles = id => typeof id === "string" && /^cli\/expected-extracted-files\/(?:actions|c|cpp|csharp|go|java|javascript|kotlin|python|ruby|rust|swift|typescript)$/.test(id);
  const metrics = run.properties?.metricResults;
  const notificationCount = items(run.invocations).reduce((total, invocation) => Math.min(limit, total +
    items(invocation?.toolExecutionNotifications).filter(notification => expectedFiles(notification?.descriptor?.id)).length), 0);
  return {
    version: "code-health-original-structure-v1", sourceFormat: "original-sarif", scopeMethod, countLimit: limit,
    tool: { codeql: /CodeQL/i.test(driver.name), semanticVersion: versionShape("semanticVersion", semanticVersion),
      version: versionShape("version", text), selected: originalToolVersion(driver) === null ? "unsupported" :
        Object.hasOwn(driver, "semanticVersion") ? "semanticVersion" : "version" },
    artifacts: { shape: shape(run.artifacts), count: count(run.artifacts),
      analysisTargets: items(run.artifacts).filter(artifact => Array.isArray(artifact?.roles) && artifact.roles.includes("analysisTarget")).length },
    codeql: { metricResults: shape(metrics), metricCount: count(metrics),
      baselineMetrics: items(metrics).filter(metric => Number.isFinite(metric?.baseline)).length,
      expectedFileDescriptors: items(driver.notifications).filter(notification => expectedFiles(notification?.id)).length,
      expectedFileNotifications: notificationCount, extractedFiles }
  };
}

/** Scopes describe the measured subset of one original SARIF run. */
function measureCodeqlProvenance(input) {
  if (!input || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(input.repository) ||
      !/^[a-f0-9]{40}$/i.test(input.analyzedSha) || input.ref !== "refs/heads/main" ||
      !/^[1-9][0-9]{0,19}$/.test(input.runId) || !/^[1-9][0-9]{0,5}$/.test(input.runAttempt) ||
      !timestamp(input.observedAt) || !/^[a-z][a-z0-9-]{0,63}$/.test(input.language) ||
      !/^[a-f0-9-]{36}$/i.test(input.sarifId) || !text(input.config, 1_048_576) ||
      !Array.isArray(input.exclusions) || input.exclusions.length > 128 || !input.exclusions.every(value => text(value)) ||
      input.sarif?.version !== "2.1.0" || !Array.isArray(input.sarif.runs) || input.sarif.runs.length !== 1) {
    throw new Error("Code health provenance identity, configuration or original SARIF is invalid.");
  }
  const run = input.sarif.runs[0], driver = run?.tool?.driver;
  const components = [driver, ...(run?.tool?.extensions ?? [])];
  if (components.length > 128 || components.some(component => !component || !text(component.name) ||
      component.rules && (!Array.isArray(component.rules) || component.rules.length > 20_000 || component.rules.some(rule => !text(rule?.id))))) {
    throw new Error("Code health tool or rule inventory is invalid.");
  }
  const reasons = input.exclusionsKnown === false ? ["The configured exclusions could not be read without ambiguity."] : [];
  const toolVersion = originalToolVersion(driver);
  if (toolVersion === null) reasons.push("The original analysis has no supported tool version.");
  const targets = new Set();
  let unresolvedTarget = false;
  if (!boundedArray(run.artifacts, inventoryLimit)) reasons.push("The original analysis has no bounded measured-file inventory.");
  else for (const artifact of run.artifacts) {
    const roles = artifact?.roles;
    if (roles !== undefined && !Array.isArray(roles)) {
      unresolvedTarget = true;
      continue;
    }
    if (!roles?.includes("analysisTarget")) continue;
    let uri;
    try { uri = decodeURIComponent(artifact.location?.uri ?? ""); } catch { uri = ""; }
    if (relativePath(uri)) targets.add(uri);
    else unresolvedTarget = true;
  }
  if (unresolvedTarget) reasons.push("A measured file cannot be resolved within this repository.");
  const invocations = Array.isArray(run.invocations) && run.invocations.length <= 64 ? run.invocations : [];
  const notificationError = notifications => notifications !== undefined &&
    (!Array.isArray(notifications) || notifications.some(value => !value || value.level === "error"));
  const contradictoryCompletion = invocations.some(invocation => !invocation || invocation.executionSuccessful === false ||
    typeof invocation.endTimeUtc === "string" && (!timestamp(invocation.endTimeUtc) || Date.parse(invocation.endTimeUtc) > Date.parse(input.observedAt)) ||
    notificationError(invocation.toolExecutionNotifications) || notificationError(invocation.toolConfigurationNotifications));
  const originalCompletion = invocations.length > 0 && invocations.every(invocation => invocation?.executionSuccessful === true && timestamp(invocation.endTimeUtc));
  const completion = contradictoryCompletion ? null : originalCompletion ? { kind: "original-invocations", state: "success",
    at: invocations.map(invocation => invocation.endTimeUtc).sort().at(-1) } : input.analysisSucceeded === true ?
    { kind: "workflow-analysis-step", state: "success", at: input.observedAt } : null;
  const extracted = targets.size || unresolvedTarget ? { state: "not-checked" } : extractedScope(input, completion, toolVersion);
  if (!targets.size && !extracted.scope) reasons.push("Explicit measured files are unavailable; result locations do not establish scan scope.");
  if (extracted.state === "unverified") reasons.push("The original CodeQL extracted-file evidence could not be verified.");
  if (completion === null) reasons.push("Successful analysis completion is not fully attested in the original output or workflow step.");
  const rules = components.map(component => [component.name, component.semanticVersion ?? component.version ?? null,
    [...(component.rules ?? [])].map(rule => canonical(rule)).sort((a, b) => a.id.localeCompare(b.id))]).sort(([a], [b]) => a.localeCompare(b));
  const ruleCount = components.reduce((count, component) => count + (component.rules ?? []).filter(rule => rule.defaultConfiguration?.enabled !== false).length, 0);
  if (!ruleCount) reasons.push("The original analysis has no enabled-rule inventory.");
  const scope = extracted.scope ?? { kind: "explicit-analysis-targets", fileCount: targets.size,
    hash: targets.size > 0 && !unresolvedTarget ? hash([...targets].sort()) : null };
  const metadata = { version: "code-health-source-v1", kind: "quality", repository: input.repository.toLowerCase(), analyzedSha: input.analyzedSha.toLowerCase(),
    ref: input.ref, runId: input.runId, runAttempt: input.runAttempt, observedAt: input.observedAt, language: input.language, sarifId: input.sarifId,
    scanId: `codeql:${input.runId}:${input.runAttempt}:${input.language}:${input.sarifId}`, completion,
    state: reasons.length ? "partial" : "complete", reasons: [...new Set(reasons)],
    toolVersion, rulesVersion: ruleCount ? hash(rules) : null, ruleCount,
    configHash: hash([input.config, [...input.exclusions].sort(), methodHash(["./code-health-provenance.mjs"])]), exclusions: [...new Set(input.exclusions)].sort(),
    scope };
  return { metadata, extractedFiles: extracted.state };
}

export function codeqlProvenance(input) {
  return measureCodeqlProvenance(input).metadata;
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
  // Operate on one open handle only, and bound the bytes actually read rather than trusting a
  // size observed earlier, so a file that grows after the type check is still refused.
  // No link is followed and a pipe or device is refused at once instead of blocking for a writer.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Unbounded or unavailable analysis input.");
    const buffer = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > limit) throw new Error("Unbounded or unavailable analysis input.");
    }
    return buffer.toString("utf8", 0, length);
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
    const quality = result === undefined ? measureCodeqlProvenance(input) : null;
    const serialized = JSON.stringify(quality ? quality.metadata : result) + "\n";
    if (!values.output || Buffer.byteLength(serialized) > 32 * 1024) throw new Error("Invalid or oversized evidence publication.");
    const diagnostic = quality ? JSON.stringify(originalStructure(input, quality.metadata.scope.kind, quality.extractedFiles)) + "\n" : null;
    writeFileSync(values.output, serialized, { flag: "wx", mode: 0o600 });
    if (diagnostic) process.stdout.write(diagnostic);
  } catch {
    // Raw SARIF parse failures may contain security text. Keep the public diagnostic allowlisted too.
    process.stderr.write("Code health evidence export failed: invalid input or unavailable original analysis.\n");
    process.exitCode = 1;
  }
}
