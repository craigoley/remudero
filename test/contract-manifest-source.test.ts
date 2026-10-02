import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  AUTOMATION_ACTION_FORBIDDEN_FIELD_RE,
  AUTOMATION_ACTION_MAX_ID_CHARS,
  AUTOMATION_ACTION_MAX_TEXT_CHARS,
  AUTOMATION_ACTION_SECRET_VALUE_RE,
  AUTOMATION_ACTION_VERSION,
  AUTOMATION_PREFLIGHT_OUTCOMES,
} from "../src/lib/automation-action.js";
import { EXTERNAL_EFFECT_STATES, EXTERNAL_EFFECT_VERSION, redactConnectorEvidence } from "../src/lib/action-reconciliation.js";
import { INTENT_PLAN_VERSION } from "../src/lib/intent-plan.js";

// W1-T3896: the automation-flow-v1 manifest is the ONE compatibility object core publishes for the
// console. This suite proves it names its reviewed source revision, schema version, states, fields,
// redaction rules and compatibility policy, and that every state family and redaction rule it
// claims to derive from a core module actually equals that module's runtime value.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = "contracts/automation-flow-v1.json";

interface ManifestError { code: string; path: string; detail: string }
interface Validation { ok: boolean; errors: ManifestError[] }
interface StateFamily { contract: string; sourceSymbol?: string; openapi: string[]; values: Record<string, string> }
interface RedactionRule { id: string; pattern?: string; flags?: string; sourceSymbol?: string; sensitiveKeys?: string[]; replacement?: string }
interface Manifest {
  schemaVersion: string;
  sourceRevision: { repository: string; commit: string; reviewedAt: string };
  sources: Array<{ contract: string; module: string; task: string }>;
  states: Record<string, StateFamily>;
  fields: Record<string, { required: string[]; optional: string[] }>;
  redaction: { rules: RedactionRule[]; limits: { maxIdChars: number; maxTextChars: number } };
  semantics: Record<string, string>;
  compatibility: { policy: string; breaking: string[]; vocabularySha256: string };
}
interface Loaded { manifest: Manifest; fixtures: unknown; openapi: unknown }

// `scripts/**` sits outside tsconfig's `include`, so the real module is reached through a runtime
// import (as test/clock-sweep.test.ts does) rather than a typed static one.
const mod = (await import(pathToFileURL(join(ROOT, "scripts", "validate-contract-manifest.mjs")).href)) as {
  validateContractManifest: (manifest: unknown, options?: { fixtures?: unknown; openapi?: unknown }) => Validation;
  loadContractManifest: (root: string, manifestPath?: string) => Loaded;
  contractVocabularyDigest: (manifest: unknown) => string;
};

const loaded = mod.loadContractManifest(ROOT, MANIFEST_PATH);
const manifest = loaded.manifest;
const codes = (result: Validation): string[] => result.errors.map((error) => error.code);

test("the manifest names its reviewed source revision, schema version, states, fields, redaction rules and compatibility policy", () => {
  assert.equal(manifest.schemaVersion, "automation-flow-v1");
  assert.match(manifest.sourceRevision.commit, /^[0-9a-f]{40}$/, "a pinned 40-hex commit, never a branch");
  assert.equal(manifest.sourceRevision.repository, "craigoley/remudero");
  assert.match(manifest.sourceRevision.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Object.keys(manifest.states).length >= 8, "every console-facing state family is machine-readable");
  for (const [family, spec] of Object.entries(manifest.states)) {
    assert.ok(Object.keys(spec.values).length > 0, `${family} names its values`);
    for (const [value, description] of Object.entries(spec.values)) assert.ok(description.trim().length > 0, `${family}.${value} is documented`);
  }
  assert.ok(Object.keys(manifest.fields).length >= 4);
  for (const [shape, spec] of Object.entries(manifest.fields)) assert.ok(spec.required.length > 0, `${shape} names its required fields`);
  assert.deepEqual(manifest.redaction.rules.map((rule) => rule.id), ["forbidden-field", "secret-value", "connector-evidence"]);
  assert.equal(manifest.compatibility.policy, "frozen-per-version");
  assert.ok(manifest.compatibility.breaking.includes("state-added") && manifest.compatibility.breaking.includes("required-field-removed"));
  for (const key of ["unavailable", "stale", "unknown", "expired"]) assert.ok(manifest.semantics[key], `explicit ${key} semantics`);
  assert.equal(manifest.compatibility.vocabularySha256, mod.contractVocabularyDigest(manifest), "the recorded lock is this vocabulary's digest");
});

test("the checked-in manifest, fixtures and openapi/daemon.yaml validate together", () => {
  const result = mod.validateContractManifest(loaded.manifest, { fixtures: loaded.fixtures, openapi: loaded.openapi });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("every source the manifest names exists and carries the contract version it claims", () => {
  assert.deepEqual(
    manifest.sources.map((source) => source.contract),
    [AUTOMATION_ACTION_VERSION, INTENT_PLAN_VERSION, EXTERNAL_EFFECT_VERSION],
  );
  for (const source of manifest.sources) assert.ok(existsSync(join(ROOT, source.module)), `${source.module} is checked in`);
  for (const family of Object.values(manifest.states)) {
    assert.ok(manifest.sources.some((source) => source.contract === family.contract), `${family.contract} is a named source`);
  }
});

test("state families derived from a runtime constant equal that constant exactly", () => {
  const preflight = manifest.states["automation-preflight-outcome"];
  assert.equal(preflight?.sourceSymbol, "AUTOMATION_PREFLIGHT_OUTCOMES");
  assert.deepEqual(Object.keys(preflight.values), [...AUTOMATION_PREFLIGHT_OUTCOMES]);
  const external = manifest.states["external-effect-state"];
  assert.equal(external?.sourceSymbol, "EXTERNAL_EFFECT_STATES");
  assert.deepEqual(Object.keys(external.values), [...EXTERNAL_EFFECT_STATES]);
});

test("the redaction rules are the source's own patterns, limits and connector keys", () => {
  const rule = (id: string): RedactionRule => {
    const found = manifest.redaction.rules.find((item) => item.id === id);
    assert.ok(found, `rule ${id}`);
    return found;
  };
  assert.equal(rule("forbidden-field").pattern, AUTOMATION_ACTION_FORBIDDEN_FIELD_RE.source);
  assert.equal(rule("forbidden-field").flags, AUTOMATION_ACTION_FORBIDDEN_FIELD_RE.flags);
  assert.equal(rule("secret-value").pattern, AUTOMATION_ACTION_SECRET_VALUE_RE.source);
  assert.equal(rule("secret-value").flags, AUTOMATION_ACTION_SECRET_VALUE_RE.flags);
  assert.equal(manifest.redaction.limits.maxIdChars, AUTOMATION_ACTION_MAX_ID_CHARS);
  assert.equal(manifest.redaction.limits.maxTextChars, AUTOMATION_ACTION_MAX_TEXT_CHARS);
  const connector = rule("connector-evidence");
  assert.ok((connector.sensitiveKeys ?? []).length > 0);
  for (const key of connector.sensitiveKeys ?? []) {
    assert.deepEqual(redactConnectorEvidence({ [key]: "value" }), { [key]: connector.replacement }, `${key} is redacted by the engine`);
  }
});

test("a floating source revision is refused: a branch, HEAD, a remote URL, or a short SHA", () => {
  for (const commit of ["main", "origin/main", "HEAD", "https://github.com/craigoley/remudero/tree/main", "221bd27"]) {
    const floating = { ...manifest, sourceRevision: { ...manifest.sourceRevision, commit } };
    assert.ok(codes(mod.validateContractManifest(floating)).includes("floating-source-revision"), `${commit} is refused`);
  }
});

test("the loader reads the checked-in files under the root it is given, never a remote", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}contract-manifest-source-`));
  try {
    mkdirSync(join(dir, "openapi"));
    cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true });
    cpSync(join(ROOT, "openapi", "daemon.yaml"), join(dir, "openapi", "daemon.yaml"));
    const copy = mod.loadContractManifest(dir, MANIFEST_PATH);
    assert.deepEqual(mod.validateContractManifest(copy.manifest, copy).errors, []);

    const edited = JSON.parse(readFileSync(join(dir, MANIFEST_PATH), "utf8")) as Manifest;
    delete edited.states["automation-approval-state"]?.values.pending;
    writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(edited, null, 2));
    const local = mod.loadContractManifest(dir, MANIFEST_PATH);
    assert.equal(mod.validateContractManifest(local.manifest, local).ok, false, "the edit under this root is what was validated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
