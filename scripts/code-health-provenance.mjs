#!/usr/bin/env node
// Sanitized evidence from existing measurements; no scanner, network or filing side effects.
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
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
  const reasons = [], targets = new Set(), components = [driver, ...(run.tool?.extensions ?? [])];
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
  if (!Array.isArray(run.invocations) || !run.invocations.length || run.invocations.length > 64 ||
      run.invocations.some(invocation => invocation.executionSuccessful !== true ||
        !timestamp(invocation.endTimeUtc) || Date.parse(invocation.endTimeUtc) > Date.parse(input.observedAt) ||
        [...(invocation.toolExecutionNotifications ?? []), ...(invocation.toolConfigurationNotifications ?? [])].some(value => value.level === "error"))) {
    reasons.push("Successful analysis completion is not fully attested in the original output.");
  }
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
    scanId: `codeql:${input.runId}:${input.runAttempt}:${input.language}:${input.sarifId}`,
    state: reasons.length ? "partial" : "complete", reasons: [...new Set(reasons)],
    toolVersion: text(driver?.version) ? driver.version : null, rulesVersion: ruleCount ? hash(rules) : null, ruleCount,
    configHash: hash([input.config, [...input.exclusions].sort()]), exclusions: [...new Set(input.exclusions)].sort(),
    scope: { kind: "explicit-analysis-targets", fileCount: targets.size, hash: hasScope ? hash([...targets].sort()) : null } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" } } });
  if (!values.input || !values.output || !statSync(values.input).isFile() || statSync(values.input).size > 64 * 1024 ** 2)
    throw new Error("Code health export requires a bounded input file and a new output file.");
  const result = codeqlProvenance(JSON.parse(readFileSync(values.input, "utf8")));
  const serialized = JSON.stringify(result) + "\n";
  if (Buffer.byteLength(serialized) > 32 * 1024) throw new Error("Code health provenance exceeds its publication bound.");
  writeFileSync(values.output, serialized, { flag: "wx", mode: 0o600 });
}
