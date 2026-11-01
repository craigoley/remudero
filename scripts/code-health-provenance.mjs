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

function originalToolVersion(driver) {
  if (!driver || !/CodeQL/i.test(driver.name ?? "")) return null;
  if (!Object.hasOwn(driver, "semanticVersion")) return text(driver.version) ? driver.version : null;
  if (!semanticVersion(driver.semanticVersion) || Object.hasOwn(driver, "version") &&
      (!text(driver.version) || semanticVersion(driver.version) && driver.version !== driver.semanticVersion)) return null;
  return driver.semanticVersion;
}

const extractedId = id => typeof id === "string" && /^(?:js|py|actions)\/diagnostics\/successfully-extracted-files$/.test(id);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const boundedList = (value, limit) => Array.isArray(value) && value.length <= limit;

// CodeQL codeql-cli/v2.27.3, commit a1575b98: Diagnostics/{ExtractedFiles,SuccessfullyExtractedFiles}.ql.
// Only the SARIF 2.1.0 notification population is measured; unknown encodings stay partial.
function extractedFiles(input, completion) {
  const run = input.sarif.runs[0], driver = run.tool.driver, targets = new Set();
  const candidate = boundedList(driver.notifications, 20_000) && driver.notifications.some(value => extractedId(value?.id)) ||
    boundedList(run.invocations, 64) && run.invocations.some(invocation => boundedList(invocation?.toolExecutionNotifications, 100_000) &&
      invocation.toolExecutionNotifications.some(value => extractedId(value?.descriptor?.id)));
  if (!candidate) return null;
  const reasons = [], refuse = reason => { reasons.push(reason); return { targets: new Set(), reasons }; };
  const family = { "javascript-typescript": "js", javascript: "js", typescript: "js", python: "py", actions: "actions" }[input.language];
  const expected = `${family}/diagnostics/successfully-extracted-files`;
  if (!family || driver.name !== "CodeQL" || originalToolVersion(driver) !== "2.27.3")
    return refuse("The extracted-file diagnostic tool or language is unsupported.");
  if (run.tool.extensions !== undefined && !boundedList(run.tool.extensions, 127))
    return refuse("The extracted-file diagnostic components exceed their bound.");
  const source = run.versionControlProvenance;
  if (!boundedList(source, 1) || source.length !== 1 || !object(source[0]) ||
      !text(source[0].repositoryUri) || ![`https://github.com/${input.repository.toLowerCase()}`, `https://github.com/${input.repository.toLowerCase()}.git`].includes(source[0].repositoryUri.toLowerCase()) ||
      !text(source[0].revisionId) || source[0].revisionId.toLowerCase() !== input.analyzedSha.toLowerCase() || source[0].branch !== input.ref)
    return refuse("The extracted-file diagnostic source identity is unavailable or foreign.");
  if (source[0].mappedTo !== undefined && (!object(source[0].mappedTo) || !text(source[0].mappedTo.uri, 4096) ||
      source[0].mappedTo.uri !== run.originalUriBaseIds?.["%SRCROOT%"]?.uri || source[0].mappedTo.uriBaseId !== undefined))
    return refuse("The extracted-file diagnostic repository mapping is unresolved or contradictory.");
  if (input.analysisSucceeded === false || completion?.kind !== "original-invocations" || !boundedList(run.invocations, 64) || !run.invocations.length)
    return refuse("The extracted-file diagnostic invocations do not attest successful completion.");
  const descriptors = driver.notifications;
  if (!boundedList(descriptors, 20_000) || descriptors.some(value => !object(value) || !text(value.id)) ||
      new Set(descriptors.map(value => value.id)).size !== descriptors.length ||
      descriptors.some(value => extractedId(value.id) && (value.id !== expected || !boundedList(value.properties?.tags, 128) ||
        !value.properties.tags.every(value => text(value)) || !value.properties.tags.includes("successfully-extracted-files"))))
    return refuse("The extracted-file diagnostic descriptors are ambiguous or unsupported.");
  const byId = new Map(descriptors.map(value => [value.id, value]));
  const descriptor = reference => {
    if (!object(reference) || !Object.keys(reference).every(key => ["id", "index", "toolComponent"].includes(key))) return null;
    if (reference.toolComponent !== undefined) {
      const component = reference.toolComponent;
      if (!object(component) || !Object.keys(component).every(key => ["index", "name", "guid"].includes(key)) ||
          !Object.keys(component).length ||
          component.index !== undefined && component.index !== -1 || component.name !== undefined && component.name !== driver.name ||
          component.guid !== undefined && component.guid !== driver.guid) return null;
      if (component.index === undefined && [driver, ...(run.tool.extensions ?? [])].some(value => value !== driver &&
          (component.name !== undefined && component.name === value.name || component.guid !== undefined && component.guid === value.guid))) return null;
    }
    if (reference.index !== undefined && (!Number.isSafeInteger(reference.index) || reference.index < 0 || reference.index >= descriptors.length)) return null;
    if (reference.id !== undefined && !text(reference.id)) return null;
    const resolved = reference.index === undefined ? byId.get(reference.id) : descriptors[reference.index];
    return resolved && (reference.id === undefined || reference.id === resolved.id) ? resolved : null;
  };
  const path = location => {
    if (!object(location) || !text(location.uri, 4096) ||
        Object.keys(location).some(key => !["uri", "uriBaseId", "index", "description"].includes(key))) return null;
    const root = run.originalUriBaseIds?.["%SRCROOT%"];
    if (location.uriBaseId !== undefined && (location.uriBaseId !== "%SRCROOT%" || !object(root) ||
        root.uriBaseId !== undefined || !text(root.uri, 4096) || !/^file:\/\/\/[^?#\u0000-\u0020]*\/$/.test(root.uri))) return null;
    let uri;
    try { uri = decodeURIComponent(location.uri); }
    catch (error) { return null; } // Invalid URI encoding cannot attest a repository file.
    return relativePath(uri) && !/[\u0000-\u001f\u007f%?#:]/.test(uri) ? uri : null;
  };
  let notifications = 0, locations = 0;
  for (const invocation of run.invocations) {
    if (!object(invocation) || !boundedList(invocation.toolExecutionNotifications, 100_000) ||
        invocation.exitCode !== undefined && invocation.exitCode !== 0 ||
        [invocation.exitSignalName, invocation.exitSignalNumber, invocation.processStartFailureMessage].some(value => value !== undefined) ||
        invocation.startTimeUtc !== undefined && (!timestamp(invocation.startTimeUtc) || Date.parse(invocation.startTimeUtc) > Date.parse(invocation.endTimeUtc)) ||
        invocation.workingDirectory !== undefined && (!object(invocation.workingDirectory) ||
          invocation.workingDirectory.uri !== run.originalUriBaseIds?.["%SRCROOT%"]?.uri || invocation.workingDirectory.uriBaseId !== undefined) ||
        invocation.toolConfigurationNotifications !== undefined && (!boundedList(invocation.toolConfigurationNotifications, 20_000) ||
          invocation.toolConfigurationNotifications.some(value => !object(value) || value.level === "error")))
      return refuse("The extracted-file notification inventory is incomplete or malformed.");
    notifications += invocation.toolExecutionNotifications.length;
    if (notifications > 100_000) return refuse("The extracted-file notification inventory exceeds its bound.");
    for (const notification of invocation.toolExecutionNotifications) {
      const resolved = descriptor(notification?.descriptor);
      if (!object(notification) || !resolved || !object(notification.message) || notification.exception !== undefined ||
          notification.level !== undefined && !["none", "note", "warning"].includes(notification.level))
        return refuse("An original diagnostic reference or completion is invalid.");
      if (!extractedId(resolved.id)) continue;
      if (resolved.id !== expected || !boundedList(notification.locations, 100_000) || !notification.locations.length)
        return refuse("The extracted-file location population is empty, foreign or malformed.");
      locations += notification.locations.length;
      if (locations > 100_000) return refuse("The extracted-file location population exceeds its bound.");
      for (const location of notification.locations) {
        const reference = location?.physicalLocation?.artifactLocation;
        const indexed = reference?.index === undefined ? undefined : Number.isSafeInteger(reference.index) && reference.index >= 0 &&
          boundedList(run.artifacts, 100_000) ? run.artifacts[reference.index]?.location : null;
        const uri = path(reference?.uri === undefined && indexed ? { ...indexed, ...reference, uri: indexed.uri } : reference);
        if (!uri || reference?.index !== undefined && (!indexed || path(indexed) !== uri || indexed.index !== undefined && indexed.index !== reference.index))
          return refuse("An extracted file cannot be resolved within this repository.");
        targets.add(uri);
      }
    }
  }
  if (!targets.size) return refuse("Directly evidenced extracted files are unavailable.");
  return { targets, reasons };
}

// W1-T10889: inspect known structures only; baseline/extraction counts never attest measured scope.
function originalStructure(input, scopeMethod) {
  const run = input.sarif.runs[0], driver = run.tool.driver, limit = 20_000;
  const shape = value => value === undefined ? "absent" : Array.isArray(value) ? "array" : "invalid";
  const count = value => Array.isArray(value) ? Math.min(value.length, limit) : 0;
  const items = value => Array.isArray(value) ? value.slice(0, limit) : [];
  const versionShape = (key, valid) => !Object.hasOwn(driver, key) ? "absent" : valid(driver[key]) ? "valid" : "invalid";
  const expectedFiles = id => typeof id === "string" && /^cli\/expected-extracted-files\/(?:actions|c|cpp|csharp|go|java|javascript|kotlin|python|ruby|rust|swift|typescript)$/.test(id);
  const metrics = run.properties?.metricResults;
  const notificationCount = items(run.invocations).reduce((total, invocation) => Math.min(limit, total +
    items(invocation?.toolExecutionNotifications).filter(notification => expectedFiles(notification?.descriptor?.id)).length), 0);
  const extracted = items(run.invocations).map(invocation => items(invocation?.toolExecutionNotifications)
    .find(notification => extractedId(notification?.descriptor?.id))).find(Boolean);
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
      expectedFileNotifications: notificationCount,
      extractedFileDescriptors: items(driver.notifications).filter(notification => extractedId(notification?.id)).length,
      executionNotifications: shape(run.invocations?.[0]?.toolExecutionNotifications),
      sourceIdentity: shape(run.versionControlProvenance),
      extractedLocations: { shape: shape(extracted?.locations), count: count(extracted?.locations),
        physicalArtifacts: items(extracted?.locations).filter(value => object(value?.physicalLocation?.artifactLocation)).length } }
  };
}

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
  let scopeKind = "explicit-analysis-targets";
  const toolVersion = originalToolVersion(driver);
  if (toolVersion === null) reasons.push("The original analysis has no supported tool version.");
  if (!Array.isArray(run.artifacts) || run.artifacts.length > 100_000) reasons.push("The original analysis has no bounded measured-file inventory.");
  else for (const artifact of run.artifacts) {
    if (!artifact.roles?.includes("analysisTarget")) continue;
    let uri;
    try { uri = decodeURIComponent(artifact.location?.uri ?? ""); } catch { uri = ""; }
    if (relativePath(uri)) targets.add(uri);
    else reasons.push("A measured file cannot be resolved within this repository.");
  }
  const invocations = Array.isArray(run.invocations) && run.invocations.length <= 64 ? run.invocations : [];
  const contradictoryCompletion = invocations.some(invocation => !object(invocation) || invocation.executionSuccessful === false ||
    typeof invocation.endTimeUtc === "string" && (!timestamp(invocation.endTimeUtc) || Date.parse(invocation.endTimeUtc) > Date.parse(input.observedAt)) ||
    [invocation.toolExecutionNotifications, invocation.toolConfigurationNotifications].some(values => values !== undefined &&
      (!Array.isArray(values) || values.some(value => !object(value) || value.level === "error"))));
  const originalCompletion = invocations.length > 0 && invocations.every(invocation => object(invocation) && invocation.executionSuccessful === true && timestamp(invocation.endTimeUtc));
  const completion = contradictoryCompletion ? null : originalCompletion ? { kind: "original-invocations", state: "success",
    at: invocations.map(invocation => invocation.endTimeUtc).sort().at(-1) } : input.analysisSucceeded === true ?
    { kind: "workflow-analysis-step", state: "success", at: input.observedAt } : null;
  if (completion === null) reasons.push("Successful analysis completion is not fully attested in the original output or workflow step.");
  // An invalid legacy target cannot be rescued by switching methods, and populations are never unioned.
  const extracted = !targets.size && !reasons.some(reason => reason.includes("resolved")) ? extractedFiles(input, completion) : null;
  if (extracted) {
    scopeKind = "codeql-extracted-files";
    for (const target of extracted.targets) targets.add(target);
    reasons.push(...extracted.reasons);
  } else if (!targets.size) reasons.push("Explicit measured files are unavailable; result locations do not establish scan scope.");
  if (components.length > 128 || components.some(component => !component || !text(component.name) ||
      component.rules && (!Array.isArray(component.rules) || component.rules.length > 20_000 || component.rules.some(rule => !text(rule.id))))) {
    throw new Error("Code health tool or rule inventory is invalid.");
  }
  const rules = components.map(component => [component.name, component.semanticVersion ?? component.version ?? null,
    [...(component.rules ?? [])].map(rule => canonical(rule)).sort((a, b) => a.id.localeCompare(b.id))]).sort(([a], [b]) => a.localeCompare(b));
  const ruleCount = components.reduce((count, component) => count + (component.rules ?? []).filter(rule => rule.defaultConfiguration?.enabled !== false).length, 0);
  if (!ruleCount) reasons.push("The original analysis has no enabled-rule inventory.");
  const hasScope = targets.size > 0 && !reasons.some(reason => reason.includes("resolved"));
  return { version: "code-health-source-v1", kind: "quality", repository: input.repository.toLowerCase(), analyzedSha: input.analyzedSha.toLowerCase(),
    ref: input.ref, runId: input.runId, runAttempt: input.runAttempt, observedAt: input.observedAt, language: input.language, sarifId: input.sarifId,
    scanId: `codeql:${input.runId}:${input.runAttempt}:${input.language}:${input.sarifId}`, completion,
    state: reasons.length ? "partial" : "complete", reasons: [...new Set(reasons)],
    toolVersion, rulesVersion: ruleCount ? hash(rules) : null, ruleCount,
    configHash: hash([input.config, [...input.exclusions].sort(), methodHash(["./code-health-provenance.mjs"])]), exclusions: [...new Set(input.exclusions)].sort(),
    scope: { kind: scopeKind, fileCount: targets.size, hash: scopeKind === "codeql-extracted-files" ?
      targets.size && !reasons.length ? hash([scopeKind, [...targets].sort()]) : null : hasScope ? hash([...targets].sort()) : null } };
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
    result ??= codeqlProvenance(input);
    const serialized = JSON.stringify(result) + "\n";
    if (!values.output || Buffer.byteLength(serialized) > 32 * 1024) throw new Error("Invalid or oversized evidence publication.");
    const diagnostic = input ? JSON.stringify(originalStructure(input, result.scope.kind)) + "\n" : null;
    writeFileSync(values.output, serialized, { flag: "wx", mode: 0o600 });
    if (diagnostic) process.stdout.write(diagnostic);
  } catch {
    // Raw SARIF parse failures may contain security text. Keep the public diagnostic allowlisted too.
    process.stderr.write("Code health evidence export failed: invalid input or unavailable original analysis.\n");
    process.exitCode = 1;
  }
}
