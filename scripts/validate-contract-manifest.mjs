#!/usr/bin/env node
// scripts/validate-contract-manifest.mjs — the cross-repository contract manifest gate (W1-T3896).
//
// WHY: core, console and site coordinate through several plan surfaces, but nothing proved a
// console adapter understands the same action, receipt, freshness and refusal states the daemon
// emits. contracts/automation-flow-v1.json is the ONE versioned compatibility object core
// publishes; this validator is what makes it binding rather than prose. It refuses:
//   - an undocumented state: a fixture value, or an openapi/daemon.yaml enum member, that the
//     manifest does not name and describe;
//   - a missing required field: in the manifest itself or in any fixture record;
//   - a breaking change without a new version: a published version's vocabulary is frozen by
//     its recorded digest, and a superseding version must link a checked-in migration note.
//
// DETERMINISTIC AND LOCAL: every input is a checked-in file under `--root` (the manifest, its
// fixture corpus, openapi/daemon.yaml, and the manifest it supersedes). Nothing is fetched; a
// manifest whose source revision is a branch name or a URL is refused, never resolved.
//
//   node scripts/validate-contract-manifest.mjs [--root .] [--manifest contracts/automation-flow-v1.json] [--print-digest]

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isMainModule, parseArgv } from "./lib/argv.mjs";

export const DEFAULT_MANIFEST_PATH = "contracts/automation-flow-v1.json";

const REQUIRED_TOP_LEVEL = ["manifest", "schemaVersion", "sourceRevision", "sources", "states", "fields", "redaction", "semantics", "fixtureCoverage", "compatibility"];
const REQUIRED_SEMANTICS = ["unavailable", "stale", "unknown", "expired"];
const PINNED_COMMIT_RE = /^[0-9a-f]{40}$/;
const REMOTE_RE = /^[a-z][a-z0-9+.-]*:\/\/|^git@/i;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const sorted = (values) => [...values].sort();

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The frozen part of a manifest: every state value and every field binding. Prose is excluded,
 *  so a description can be corrected in place without a new version. */
export function contractVocabulary(manifest) {
  const states = {};
  for (const [family, spec] of Object.entries(manifest?.states ?? {})) states[family] = sorted(Object.keys(spec?.values ?? {}));
  const fields = {};
  for (const [shape, spec] of Object.entries(manifest?.fields ?? {})) {
    fields[shape] = { required: sorted(spec?.required ?? []), optional: sorted(spec?.optional ?? []), stateFields: { ...(spec?.stateFields ?? {}) } };
  }
  return { states, fields };
}

export function contractVocabularyDigest(manifest) {
  return createHash("sha256").update(canonicalJson(contractVocabulary(manifest)), "utf8").digest("hex");
}

/** Every vocabulary difference between two manifests, split by whether a pinned consumer breaks. */
export function classifyContractChange(previous, next) {
  const before = contractVocabulary(previous);
  const after = contractVocabulary(next);
  const breaking = [];
  const nonBreaking = [];
  for (const [family, values] of Object.entries(before.states)) {
    const now = after.states[family];
    if (!now) { breaking.push(`state-family-removed:${family}`); continue; }
    for (const value of values) if (!now.includes(value)) breaking.push(`state-removed:${family}.${value}`);
    for (const value of now) if (!values.includes(value)) breaking.push(`state-added:${family}.${value}`);
  }
  for (const family of Object.keys(after.states)) if (!before.states[family]) nonBreaking.push(`state-family-added:${family}`);
  for (const [shape, was] of Object.entries(before.fields)) {
    const now = after.fields[shape];
    if (!now) { breaking.push(`shape-removed:${shape}`); continue; }
    for (const field of was.required) if (!now.required.includes(field)) breaking.push(`required-field-removed:${shape}.${field}`);
    for (const field of now.required) if (!was.required.includes(field)) breaking.push(`required-field-added:${shape}.${field}`);
    for (const field of was.optional) if (!now.optional.includes(field) && !now.required.includes(field)) breaking.push(`optional-field-removed:${shape}.${field}`);
    for (const field of now.optional) if (!was.optional.includes(field) && !was.required.includes(field)) nonBreaking.push(`optional-field-added:${shape}.${field}`);
    for (const [path, family] of Object.entries(was.stateFields)) if (now.stateFields[path] !== family) breaking.push(`state-field-rebound:${shape}.${path}`);
    for (const path of Object.keys(now.stateFields)) if (!(path in was.stateFields)) nonBreaking.push(`state-field-added:${shape}.${path}`);
  }
  for (const shape of Object.keys(after.fields)) if (!before.fields[shape]) nonBreaking.push(`shape-added:${shape}`);
  return { breaking, nonBreaking };
}

/** Values at a dotted path; a `[]` suffix fans out over an array. Absent values are skipped. */
function valuesAt(record, path) {
  let current = [record];
  for (const raw of path.split(".")) {
    const fan = raw.endsWith("[]");
    const key = fan ? raw.slice(0, -2) : raw;
    current = current.flatMap((item) => {
      if (!isObject(item) || !(key in item)) return [];
      const child = item[key];
      return fan ? (Array.isArray(child) ? child : []) : [child];
    });
  }
  return current.filter((value) => value !== undefined);
}

function openapiSchema(spec, node) {
  if (isObject(node) && typeof node.$ref === "string") {
    const match = /^#\/components\/schemas\/([A-Za-z0-9_]+)$/.exec(node.$ref);
    return match ? spec?.components?.schemas?.[match[1]] : undefined;
  }
  return node;
}

/** The enum an openapi binding like `ExternalActionResult.observation.status` resolves to. */
function openapiEnum(spec, binding) {
  const [schemaName, ...segments] = binding.split(".");
  let node = openapiSchema(spec, spec?.components?.schemas?.[schemaName]);
  for (const raw of segments) {
    const fan = raw.endsWith("[]");
    node = openapiSchema(spec, node?.properties?.[fan ? raw.slice(0, -2) : raw]);
    if (fan) node = openapiSchema(spec, node?.items);
  }
  return Array.isArray(node?.enum) ? node.enum : undefined;
}

function walkKeys(value, visit, path = "", depth = 0) {
  if (depth > 12 || typeof value !== "object" || value === null) return;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  for (const [key, child] of entries) {
    const childPath = path ? `${path}.${key}` : key;
    visit(Array.isArray(value) ? undefined : key, child, childPath);
    walkKeys(child, visit, childPath, depth + 1);
  }
}

function redactionViolations(manifest, record) {
  const rules = Array.isArray(manifest.redaction?.rules) ? manifest.redaction.rules : [];
  const patterns = rules.filter((rule) => nonEmpty(rule.pattern)).map((rule) => ({ id: rule.id, re: new RegExp(rule.pattern, rule.flags ?? "") }));
  const connector = rules.find((rule) => Array.isArray(rule.sensitiveKeys));
  const sensitive = (connector?.sensitiveKeys ?? []).map((key) => key.toLowerCase().replace(/[-_]/g, ""));
  const found = [];
  walkKeys(record, (key, child, path) => {
    if (key !== undefined) {
      const forbidden = patterns.find((rule) => rule.id === "forbidden-field" && rule.re.test(key));
      if (forbidden) found.push({ path, rule: forbidden.id });
      const norm = key.toLowerCase().replace(/[-_]/g, "");
      if (sensitive.some((item) => norm.includes(item)) && child !== connector.replacement) found.push({ path, rule: connector.id });
    }
    if (typeof child === "string") {
      const secret = patterns.find((rule) => rule.id !== "forbidden-field" && rule.re.test(child));
      if (secret) found.push({ path, rule: secret.id });
    }
  });
  return found;
}

function checkManifestShape(manifest, push) {
  for (const key of REQUIRED_TOP_LEVEL) if (manifest[key] === undefined || manifest[key] === null) push("missing-required-field", key, `the manifest must name ${key}`);
  if (manifest.schemaVersion !== undefined && !(nonEmpty(manifest.manifest) && new RegExp(`^${manifest.manifest}-v\\d+$`).test(manifest.schemaVersion))) {
    push("invalid-schema-version", "schemaVersion", `${JSON.stringify(manifest.schemaVersion)} must be ${manifest.manifest}-v<N>`);
  }
  const revision = manifest.sourceRevision;
  if (isObject(revision)) {
    for (const key of ["repository", "commit", "reviewedAt"]) if (!nonEmpty(revision[key])) push("missing-required-field", `sourceRevision.${key}`, `the source revision must name ${key}`);
    if (nonEmpty(revision.commit) && !PINNED_COMMIT_RE.test(revision.commit)) {
      push("floating-source-revision", "sourceRevision.commit", `${JSON.stringify(revision.commit)} is not a pinned 40-hex commit; a branch, ref or URL floats`);
    }
  }
  for (const [index, source] of (Array.isArray(manifest.sources) ? manifest.sources : []).entries()) {
    if (!nonEmpty(source?.contract) || !nonEmpty(source?.module)) push("missing-required-field", `sources[${index}]`, "a source names its contract and checked-in module");
    else if (REMOTE_RE.test(source.module)) push("floating-source-revision", `sources[${index}].module`, `${source.module} is remote; a source must be a checked-in path`);
  }
  for (const key of ["fixtures", "openapi"]) if (nonEmpty(manifest[key]) && REMOTE_RE.test(manifest[key])) push("floating-source-revision", key, `${manifest[key]} is remote; it must be a checked-in path`);
  if (isObject(manifest.semantics)) for (const key of REQUIRED_SEMANTICS) if (!nonEmpty(manifest.semantics[key])) push("missing-required-field", `semantics.${key}`, `explicit ${key} semantics are required`);
  const rules = manifest.redaction?.rules;
  if (manifest.redaction !== undefined && (!Array.isArray(rules) || rules.length === 0)) push("missing-required-field", "redaction.rules", "at least one redaction rule is required");
  for (const [index, rule] of (Array.isArray(rules) ? rules : []).entries()) {
    if (!nonEmpty(rule?.id) || !nonEmpty(rule?.rule)) push("missing-required-field", `redaction.rules[${index}]`, "a redaction rule names its id and rule");
    if (nonEmpty(rule?.pattern)) {
      try { new RegExp(rule.pattern, rule.flags ?? ""); } catch (error) { push("invalid-redaction-rule", `redaction.rules[${index}].pattern`, `does not compile: ${error.message}`); }
    }
  }
}

function checkVocabulary(manifest, push) {
  const contracts = new Set((Array.isArray(manifest.sources) ? manifest.sources : []).map((source) => source?.contract));
  for (const [family, spec] of Object.entries(isObject(manifest.states) ? manifest.states : {})) {
    if (!isObject(spec?.values) || Object.keys(spec.values).length === 0) { push("missing-required-field", `states.${family}.values`, `${family} names no values`); continue; }
    if (!contracts.has(spec.contract)) push("unknown-contract", `states.${family}.contract`, `${spec.contract} is not a named source contract`);
    for (const [value, description] of Object.entries(spec.values)) {
      if (!nonEmpty(description)) push("undocumented-state", `states.${family}.values.${value}`, `${family} "${value}" has no description; a state must be documented, not only named`);
    }
  }
  for (const [shape, spec] of Object.entries(isObject(manifest.fields) ? manifest.fields : {})) {
    if (!Array.isArray(spec?.required) || spec.required.length === 0) push("missing-required-field", `fields.${shape}.required`, `${shape} names no required fields`);
    if (!Array.isArray(spec?.optional)) push("missing-required-field", `fields.${shape}.optional`, `${shape} must list its optional fields, even when empty`);
    for (const [path, family] of Object.entries(spec?.stateFields ?? {})) {
      if (!manifest.states?.[family]) push("undocumented-state", `fields.${shape}.stateFields.${path}`, `${shape}.${path} binds to undocumented state family ${family}`);
    }
  }
  for (const [index, entry] of (Array.isArray(manifest.fixtureCoverage) ? manifest.fixtureCoverage : []).entries()) {
    const matches = Array.isArray(entry?.matches) ? entry.matches : [];
    if (!nonEmpty(entry?.outcome) || matches.length === 0) push("missing-required-field", `fixtureCoverage[${index}]`, "a coverage entry names its outcome and the states that exhibit it");
    for (const match of matches) {
      if (!(match?.value in (manifest.states?.[match?.family]?.values ?? {}))) push("undocumented-state", `fixtureCoverage[${index}]`, `coverage "${entry?.outcome}" names ${match?.family}.${match?.value}, which the manifest does not document`);
    }
  }
}

function checkCompatibility(manifest, options, push) {
  const compat = manifest.compatibility;
  for (const key of ["policy", "vocabularySha256"]) if (!nonEmpty(compat[key])) push("missing-required-field", `compatibility.${key}`, `the compatibility policy must name ${key}`);
  if (!Array.isArray(compat.breaking) || compat.breaking.length === 0) push("missing-required-field", "compatibility.breaking", "the policy must name what is breaking");
  const digest = contractVocabularyDigest(manifest);
  if (nonEmpty(compat.vocabularySha256) && compat.vocabularySha256 !== digest) {
    push("breaking-change-without-version", "compatibility.vocabularySha256", `${manifest.schemaVersion}'s vocabulary no longer matches its published lock (${compat.vocabularySha256} != ${digest}); a published version is frozen, so publish a new version instead`);
  }
  const previous = options.previous;
  if (!isObject(previous)) return;
  const change = classifyContractChange(previous, manifest);
  if (previous.schemaVersion === manifest.schemaVersion) {
    const all = [...change.breaking, ...change.nonBreaking];
    if (all.length > 0) push("breaking-change-without-version", "schemaVersion", `${manifest.schemaVersion} changed its published vocabulary in place: ${all.join(", ")}`);
    return;
  }
  const versionOf = (value) => Number(/-v(\d+)$/.exec(value ?? "")?.[1] ?? Number.NaN);
  if (compat.supersedes !== previous.schemaVersion || !(versionOf(manifest.schemaVersion) > versionOf(previous.schemaVersion))) {
    push("version-not-superseding", "compatibility.supersedes", `${manifest.schemaVersion} must supersede ${previous.schemaVersion} with a higher version number`);
  }
  if (change.breaking.length === 0) return;
  const migrations = Array.isArray(compat.migrations) ? compat.migrations : [];
  const note = migrations.find((entry) => entry?.from === previous.schemaVersion && entry?.to === manifest.schemaVersion && nonEmpty(entry?.note));
  if (!note) {
    push("missing-migration-note", "compatibility.migrations", `breaking change from ${previous.schemaVersion} (${change.breaking.join(", ")}) needs a migration note linked from ${previous.schemaVersion} to ${manifest.schemaVersion}`);
  } else if (typeof options.fileExists === "function" && !options.fileExists(note.note)) {
    push("missing-migration-note", "compatibility.migrations", `migration note ${note.note} is not checked in`);
  }
}

function checkFixtures(manifest, corpus, push) {
  if (corpus.schemaVersion !== manifest.schemaVersion) push("fixture-version-mismatch", "fixtures.schemaVersion", `fixtures are ${corpus.schemaVersion}, manifest is ${manifest.schemaVersion}`);
  const fixtures = Array.isArray(corpus.fixtures) ? corpus.fixtures : [];
  const coverage = Array.isArray(manifest.fixtureCoverage) ? manifest.fixtureCoverage : [];
  for (const fixture of fixtures) {
    const at = `fixtures[${fixture?.id}]`;
    const shape = manifest.fields?.[fixture?.shape];
    if (!shape) { push("unknown-shape", `${at}.shape`, `${fixture?.shape} is not a shape the manifest names`); continue; }
    if (!isObject(fixture.record)) { push("missing-required-field", `${at}.record`, "a fixture carries its record"); continue; }
    for (const field of shape.required ?? []) if (!(field in fixture.record)) push("missing-required-field", `${at}.record.${field}`, `${fixture.shape} requires ${field}`);
    const known = new Set([...(shape.required ?? []), ...(shape.optional ?? [])]);
    for (const field of Object.keys(fixture.record)) if (!known.has(field)) push("undocumented-field", `${at}.record.${field}`, `${fixture.shape} does not name ${field}`);
    for (const [path, family] of Object.entries(shape.stateFields ?? {})) {
      const values = manifest.states?.[family]?.values ?? {};
      for (const value of valuesAt(fixture.record, path)) {
        if (!(typeof value === "string" && value in values)) push("undocumented-state", `${at}.record.${path}`, `${JSON.stringify(value)} is not a documented ${family} state`);
      }
    }
    for (const violation of redactionViolations(manifest, fixture.record)) push("redaction-violation", `${at}.record.${violation.path}`, `breaks redaction rule ${violation.rule}`);
    for (const tag of Array.isArray(fixture.covers) ? fixture.covers : []) {
      const matches = coverage.find((item) => item?.outcome === tag)?.matches ?? [];
      const bindings = Object.entries(shape.stateFields ?? {});
      const exhibits = matches.some((match) => bindings.some(([path, family]) => family === match?.family && valuesAt(fixture.record, path).includes(match?.value)));
      if (!exhibits) push("fixture-coverage-mismatch", `${at}.covers`, `claims "${tag}" but its record exhibits none of ${JSON.stringify(matches)}`);
    }
  }
  for (const entry of coverage) {
    if (!fixtures.some((fixture) => Array.isArray(fixture?.covers) && fixture.covers.includes(entry?.outcome))) {
      push("missing-fixture-coverage", "fixtureCoverage", `no fixture covers "${entry?.outcome}"`);
    }
  }
}

function checkOpenapi(manifest, spec, push) {
  const links = Array.isArray(spec?.["x-contract-manifests"]) ? spec["x-contract-manifests"] : [];
  if (!links.some((link) => link?.schemaVersion === manifest.schemaVersion)) push("openapi-unlinked", "openapi.x-contract-manifests", `openapi does not link ${manifest.schemaVersion}`);
  for (const [family, stateSpec] of Object.entries(manifest.states ?? {})) {
    const documented = Object.keys(stateSpec?.values ?? {});
    for (const binding of Array.isArray(stateSpec?.openapi) ? stateSpec.openapi : []) {
      const served = openapiEnum(spec, binding);
      if (!served) { push("state-drift", `states.${family}.openapi`, `${binding} resolves to no enum in openapi`); continue; }
      for (const value of served) if (!documented.includes(value)) push("undocumented-state", `states.${family}`, `openapi ${binding} serves "${value}", which ${family} does not document`);
      for (const value of documented) if (!served.includes(value)) push("state-drift", `states.${family}`, `${family} documents "${value}", which openapi ${binding} does not serve`);
    }
  }
  for (const [shape, fieldSpec] of Object.entries(manifest.fields ?? {})) {
    if (!nonEmpty(fieldSpec?.openapi)) continue;
    const schema = openapiSchema(spec, spec?.components?.schemas?.[fieldSpec.openapi]);
    if (!schema) { push("field-drift", `fields.${shape}.openapi`, `${fieldSpec.openapi} is not an openapi schema`); continue; }
    const served = sorted(schema.required ?? []);
    if (canonicalJson(served) !== canonicalJson(sorted(fieldSpec.required ?? []))) push("field-drift", `fields.${shape}.required`, `openapi requires [${served.join(", ")}]`);
    const properties = Object.keys(schema.properties ?? {});
    for (const field of fieldSpec.optional ?? []) if (!properties.includes(field)) push("field-drift", `fields.${shape}.optional`, `openapi ${fieldSpec.openapi} has no ${field}`);
    const named = new Set([...(fieldSpec.required ?? []), ...(fieldSpec.optional ?? [])]);
    for (const field of properties) if (!named.has(field)) push("undocumented-field", `fields.${shape}`, `openapi ${fieldSpec.openapi}.${field} is not named by the manifest`);
  }
}

/**
 * Validate a manifest against whatever checked-in inputs are supplied. `fixtures` adds the corpus
 * checks, `openapi` the served-enum and field checks, `previous` the cross-version rules, and
 * `fileExists` the migration-note check. Pure: it reads nothing itself.
 */
export function validateContractManifest(manifest, options = {}) {
  const errors = [];
  const push = (code, path, detail) => errors.push({ code, path, detail });
  if (!isObject(manifest)) {
    push("missing-required-field", "", "the manifest must be a JSON object");
    return { ok: false, errors };
  }
  checkManifestShape(manifest, push);
  checkVocabulary(manifest, push);
  if (isObject(manifest.compatibility)) checkCompatibility(manifest, options, push);
  if (isObject(options.fixtures)) checkFixtures(manifest, options.fixtures, push);
  if (isObject(options.openapi)) checkOpenapi(manifest, options.openapi, push);
  return { ok: errors.length === 0, errors };
}

/** Read a manifest, its fixture corpus and openapi document from checked-in files under `root`. */
export function loadContractManifest(root, manifestPath = DEFAULT_MANIFEST_PATH) {
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
  const local = (path) => (nonEmpty(path) && !REMOTE_RE.test(path) ? path : undefined);
  const fixturesPath = local(manifest.fixtures);
  const openapiPath = local(manifest.openapi);
  const fixtures = fixturesPath && existsSync(join(root, fixturesPath)) ? JSON.parse(readFileSync(join(root, fixturesPath), "utf8")) : undefined;
  const openapi = openapiPath && existsSync(join(root, openapiPath)) ? parseYaml(readFileSync(join(root, openapiPath), "utf8")) : undefined;
  const supersedes = manifest.compatibility?.supersedes;
  const previousPath = nonEmpty(supersedes) ? join("contracts", `${supersedes}.json`) : undefined;
  const previous = previousPath && existsSync(join(root, previousPath)) ? JSON.parse(readFileSync(join(root, previousPath), "utf8")) : undefined;
  return { manifest, fixtures, openapi, previous, manifestPath, fileExists: (path) => existsSync(join(root, path)) };
}

/** The CLI's whole check: every loaded input, plus the rule that a file is named for its version. */
export function validateCheckedInContract(root, manifestPath = DEFAULT_MANIFEST_PATH) {
  const loaded = loadContractManifest(root, manifestPath);
  const result = validateContractManifest(loaded.manifest, loaded);
  const errors = [...result.errors];
  if (basename(manifestPath) !== `${loaded.manifest.schemaVersion}.json`) errors.push({ code: "manifest-path-mismatch", path: manifestPath, detail: `a ${loaded.manifest.schemaVersion} manifest lives at contracts/${loaded.manifest.schemaVersion}.json` });
  for (const [key, value] of [["fixtures", loaded.fixtures], ["openapi", loaded.openapi]]) {
    if (value === undefined) errors.push({ code: "missing-required-field", path: key, detail: `${loaded.manifest[key]} is not a checked-in file under ${root}` });
  }
  if (nonEmpty(loaded.manifest.compatibility?.supersedes) && loaded.previous === undefined) {
    errors.push({ code: "version-not-superseding", path: "compatibility.supersedes", detail: `the superseded manifest ${loaded.manifest.compatibility.supersedes} is not checked in` });
  }
  return { ok: errors.length === 0, manifest: loaded.manifest.schemaVersion, sourceRevision: loaded.manifest.sourceRevision?.commit, errors };
}

if (isMainModule(import.meta.url)) {
  const { values, helpRequested } = parseArgv(
    process.argv.slice(2),
    { root: { type: "string", default: "." }, manifest: { type: "string", default: DEFAULT_MANIFEST_PATH }, "print-digest": { type: "boolean" } },
    { helpText: "usage: node scripts/validate-contract-manifest.mjs [--root .] [--manifest contracts/automation-flow-v1.json] [--print-digest]" },
  );
  if (!helpRequested) {
    if (values["print-digest"]) {
      console.log(contractVocabularyDigest(loadContractManifest(values.root, values.manifest).manifest));
    } else {
      const result = validateCheckedInContract(values.root, values.manifest);
      console.log(JSON.stringify(result));
      process.exitCode = result.ok ? 0 : 1;
    }
  }
}
