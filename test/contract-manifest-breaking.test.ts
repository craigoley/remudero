import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T3896: the validator must refuse the three ways a cross-repository contract silently breaks
// a consumer — a state no manifest documents, a record missing a field the manifest requires, and
// a breaking state or field change shipped under the SAME version — and must accept a breaking
// change only as a new version that names what it supersedes and links a migration note.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "validate-contract-manifest.mjs");
const MANIFEST_PATH = "contracts/automation-flow-v1.json";

interface Migration { from: string; to: string; note: string }
interface Manifest {
  schemaVersion: string;
  states: Record<string, { values: Record<string, string>; openapi: string[] }>;
  fields: Record<string, { required: string[]; optional: string[] }>;
  compatibility: { supersedes: string | null; migrations: Migration[]; vocabularySha256: string };
  [key: string]: unknown;
}
interface Corpus { fixtures: Array<{ id: string; shape: string; record: Record<string, unknown> }> }
interface Validation { ok: boolean; errors: Array<{ code: string; path: string; detail: string }> }
interface Options { fixtures?: unknown; openapi?: unknown; previous?: unknown; fileExists?: (path: string) => boolean }

const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  validateContractManifest: (manifest: unknown, options?: Options) => Validation;
  loadContractManifest: (root: string, manifestPath?: string) => { manifest: Manifest; fixtures: Corpus; openapi: Record<string, unknown> };
  contractVocabularyDigest: (manifest: unknown) => string;
  classifyContractChange: (previous: unknown, next: unknown) => { breaking: string[]; nonBreaking: string[] };
};

const loaded = mod.loadContractManifest(ROOT, MANIFEST_PATH);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const codes = (result: Validation): string[] => result.errors.map((error) => error.code);

/** A manifest edited by `edit` whose lock is re-recorded, so ONLY the cross-version rules can refuse it. */
function relocked(edit: (manifest: Manifest) => void): Manifest {
  const next = clone(loaded.manifest);
  edit(next);
  next.compatibility.vocabularySha256 = mod.contractVocabularyDigest(next);
  return next;
}

/** The same edit published as automation-flow-v2, superseding v1. */
function asV2(edit: (manifest: Manifest) => void, migrations: Migration[] = []): Manifest {
  return relocked((next) => {
    edit(next);
    next.schemaVersion = "automation-flow-v2";
    next.compatibility.supersedes = "automation-flow-v1";
    next.compatibility.migrations = migrations;
  });
}

const addState = (manifest: Manifest): void => {
  const family = manifest.states["automation-preflight-outcome"];
  assert.ok(family);
  family.values.throttled = "Rate-limited by the connector.";
};

test("an undocumented state in a record is refused", () => {
  const corpus = clone(loaded.fixtures);
  const fixture = corpus.fixtures.find((item) => item.id === "preflight-ready");
  assert.ok(fixture);
  fixture.record.outcome = "throttled";
  const result = mod.validateContractManifest(loaded.manifest, { fixtures: corpus });
  assert.ok(codes(result).includes("undocumented-state"));
  assert.ok(result.errors.some((error) => error.detail.includes("throttled")));
});

test("a state served by openapi/daemon.yaml but absent from the manifest is refused as undocumented", () => {
  const openapi = clone(loaded.openapi) as { components: { schemas: Record<string, { properties: Record<string, { enum: string[] }> }> } };
  openapi.components.schemas.AutomationPreflightResult?.properties.outcome?.enum.push("throttled");
  const result = mod.validateContractManifest(loaded.manifest, { openapi });
  assert.ok(codes(result).includes("undocumented-state"));
});

test("a state that exists only as a name, with no description, is refused as undocumented", () => {
  const next = clone(loaded.manifest);
  const family = next.states["external-effect-state"];
  assert.ok(family);
  family.values.pending = " ";
  assert.ok(codes(mod.validateContractManifest(next)).includes("undocumented-state"));
});

test("a record missing a required field is refused", () => {
  const corpus = clone(loaded.fixtures);
  const receipt = corpus.fixtures.find((item) => item.shape === "AutomationActionReceipt");
  assert.ok(receipt);
  delete receipt.record.reason;
  const result = mod.validateContractManifest(loaded.manifest, { fixtures: corpus });
  assert.ok(codes(result).includes("missing-required-field"));
  assert.ok(result.errors.some((error) => error.path.endsWith("reason")));
});

test("a manifest missing a required top-level field is refused", () => {
  for (const key of ["sourceRevision", "schemaVersion", "states", "fields", "redaction", "compatibility", "semantics"]) {
    const next = clone(loaded.manifest);
    delete next[key];
    assert.ok(codes(mod.validateContractManifest(next)).includes("missing-required-field"), `${key} is required`);
  }
});

test("a field the manifest does not name, or required fields that drift from openapi, are refused", () => {
  const corpus = clone(loaded.fixtures);
  const first = corpus.fixtures[0];
  assert.ok(first);
  first.record.surprise = 1;
  assert.ok(codes(mod.validateContractManifest(loaded.manifest, { fixtures: corpus })).includes("undocumented-field"));

  const openapi = clone(loaded.openapi) as { components: { schemas: Record<string, { required: string[] }> } };
  openapi.components.schemas.AutomationActionReceipt?.required.push("evidenceRef");
  assert.ok(codes(mod.validateContractManifest(loaded.manifest, { openapi })).includes("field-drift"));
});

test("a breaking state change under the same version is refused, whether or not the lock is re-recorded", () => {
  const unlocked = clone(loaded.manifest);
  addState(unlocked);
  assert.ok(codes(mod.validateContractManifest(unlocked)).includes("breaking-change-without-version"), "the frozen lock refuses it");

  const relockedEdit = relocked(addState);
  assert.equal(mod.validateContractManifest(relockedEdit).ok, true, "alone, a re-recorded lock is self-consistent");
  const result = mod.validateContractManifest(relockedEdit, { previous: loaded.manifest });
  assert.ok(codes(result).includes("breaking-change-without-version"), "against the published version it is refused");
});

test("a breaking field change under the same version is refused", () => {
  const dropRequired = relocked((next) => {
    const shape = next.fields.AutomationActionReceipt;
    assert.ok(shape);
    shape.required = shape.required.filter((field) => field !== "receiptRef");
  });
  assert.ok(codes(mod.validateContractManifest(dropRequired, { previous: loaded.manifest })).includes("breaking-change-without-version"));

  const dropOptional = clone(loaded.manifest);
  const shape = dropOptional.fields.AutomationActionReceipt;
  assert.ok(shape);
  shape.optional = shape.optional.filter((field) => field !== "evidenceRef");
  assert.ok(codes(mod.validateContractManifest(dropOptional)).includes("breaking-change-without-version"));
});

test("a breaking change as a new version must link a migration note that exists", () => {
  const unlinked = asV2(addState);
  assert.ok(codes(mod.validateContractManifest(unlinked, { previous: loaded.manifest })).includes("missing-migration-note"));

  const note = "docs/contracts/automation-flow-v2-migration.md";
  const linked = asV2(addState, [{ from: "automation-flow-v1", to: "automation-flow-v2", note }]);
  const exists = (path: string): boolean => path === note;
  assert.deepEqual(mod.validateContractManifest(linked, { previous: loaded.manifest, fileExists: exists }).errors, []);
  assert.ok(
    codes(mod.validateContractManifest(linked, { previous: loaded.manifest, fileExists: () => false })).includes("missing-migration-note"),
    "a note that is not checked in does not count",
  );

  const orphan = relocked((next) => {
    addState(next);
    next.schemaVersion = "automation-flow-v2";
  });
  assert.ok(codes(mod.validateContractManifest(orphan, { previous: loaded.manifest })).includes("version-not-superseding"));
});

test("an additive optional field is non-breaking: allowed as a new version without a note, frozen within one", () => {
  const addOptional = (next: Manifest): void => {
    next.fields.AutomationActionReceipt?.optional.push("attempt");
  };
  const change = mod.classifyContractChange(loaded.manifest, relocked(addOptional));
  assert.deepEqual(change.breaking, []);
  assert.ok(change.nonBreaking.some((item) => item.includes("optional-field-added")));
  assert.deepEqual(mod.validateContractManifest(asV2(addOptional), { previous: loaded.manifest }).errors, []);

  const sameVersion = clone(loaded.manifest);
  addOptional(sameVersion);
  assert.ok(codes(mod.validateContractManifest(sameVersion)).includes("breaking-change-without-version"), "a published vocabulary is frozen");
});

test("the CLI validates the checked-in files and exits non-zero naming the refusal when they break", () => {
  const ok = spawnSync(process.execPath, [SCRIPT, "--root", ROOT], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /"ok":true/);

  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}contract-manifest-breaking-`));
  try {
    mkdirSync(join(dir, "openapi"));
    cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true });
    cpSync(join(ROOT, "openapi", "daemon.yaml"), join(dir, "openapi", "daemon.yaml"));
    const edited = JSON.parse(readFileSync(join(dir, MANIFEST_PATH), "utf8")) as Manifest;
    addState(edited);
    writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(edited, null, 2));
    const refused = spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /breaking-change-without-version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
