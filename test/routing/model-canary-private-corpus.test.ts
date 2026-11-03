import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { CanarySlotOwner } from "#src/lib/model-canary-owner.js";
import { executeCanary, type CanaryResponse } from "#src/lib/model-canary-runner.js";
import { buildCanarySchedule } from "#src/lib/model-canary-schedule.js";
import { canarySuiteDigest } from "#src/lib/model-canary-suite.js";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import { buildPrivateCanaryRequest, gradeStoredPrivateCase, privateCorpusCaseMatches, privateCorpusMetadata, validatePrivateCorpus,
  canonicalPrivateCanaryJson, snapshotPrivateCanaryJson, type PrivateCanaryBundleV1, type PrivateCanaryCaseV1,
  type PrivateCanaryPayloadV1 } from "#src/lib/model-canary-private-corpus.js";
import { commonCanarySuite, weeklyCanarySuite, canaryTools } from "#src/lib/model-canary-suite.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const encoded=JSON.stringify(value); if(typeof encoded!=="string") throw new Error("test-json-invalid"); return encoded;
}
function item(id: string, split: "development" | "sealed-holdout", sourceFamilyId: string,
  incidentRootId: string, observedAt = "2026-11-03T00:00:00.000Z"): PrivateCanaryCaseV1 {
  const anchor = commonCanarySuite().find(value => value.id === "schema-deploy")!;
  return { item: { ...anchor, id, expected: { category: "deploy", ticket: 17, severity: "low" }, tools: "none" },
    provenance: { sourceFamilyId, incidentRootId, sourceDigest: digest(`source:${id}`), observedAt,
      splitId: split === "development" ? "dev-2026w45" : "holdout-2026w45", split, role: "worker" },
    expectedToolTrace: [], scorerVersion: "exact-json-and-application-trace-v1" };
}
function payload(split: "development" | "sealed-holdout", cases: readonly PrivateCanaryCaseV1[]): PrivateCanaryPayloadV1 {
  return { version: "model-canary-private-payload-v1", split, cases };
}
function bundle(developmentCases: readonly PrivateCanaryCaseV1[], sealedHoldout?: PrivateCanaryBundleV1["sealedHoldout"]): PrivateCanaryBundleV1 {
  return { version: "model-canary-private-bundle-v1", development: payload("development", developmentCases) as PrivateCanaryBundleV1["development"],
    ...(sealedHoldout ? { sealedHoldout } : {}) };
}
function signedHoldout(cases: readonly PrivateCanaryCaseV1[], privateKey: KeyObject) {
  const body = payload("sealed-holdout", cases) as PrivateCanaryPayloadV1 & { split: "sealed-holdout" };
  return { version: "model-canary-sealed-holdout-v1" as const, keyId: "test-holdout-key", payload: body,
    signatureBase64: sign(null, Buffer.from(canonical(body)), privateKey).toString("base64") };
}

test("private corpus keeps expected outputs outside requests and seals holdouts", () => {
  const keys = generateKeyPairSync("ed25519");
  const development = item("dev-a", "development", "family-dev-a", "root-dev-a");
  const holdout = item("hold-a", "sealed-holdout", "family-held-a", "root-held-a", "2026-10-20T00:00:00.000Z");
  const sealed = signedHoldout([holdout], keys.privateKey);
  const result = validatePrivateCorpus(bundle([development], sealed), {
    "test-holdout-key": keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  assert.deepEqual(result.metadata.splits, { development: 1, "sealed-holdout": 1 });
  const request = buildPrivateCanaryRequest(result.corpus, "hold-a");
  assert.equal(request.state, "available");
  if (request.state !== "available") return;
  assert.equal(request.request.prompt, holdout.item.prompt);
  assert.deepEqual(request.request.allowedTools, []);
  assert.equal(Object.hasOwn(request.request, "expected"), false);
  assert.equal(JSON.stringify(request.request).includes("sourceFamilyId"), false);
  assert.equal(JSON.stringify(request.request).includes("scorerDigest"), false);
  assert.equal(privateCorpusCaseMatches(result.corpus, holdout.item), true);
  assert.equal(privateCorpusCaseMatches(result.corpus, { ...holdout.item, prompt: "changed" }), false);
  assert.equal(validatePrivateCorpus(bundle([development], sealed)).state, "unavailable",
    "an embedded signature/key id is not its own trust anchor");
});

test("private corpus preserves family provenance without exposing source material", () => {
  const first = item("dev-family-a", "development", "source-family-17", "incident-root-4");
  const second = item("dev-family-b", "development", "source-family-17", "incident-root-4", "2026-11-03T00:01:00.000Z");
  const result = validatePrivateCorpus(bundle([first, second]));
  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  const metadata = privateCorpusMetadata(result.corpus)!;
  assert.deepEqual(metadata.cases.map(row => [row.sourceFamilyId, row.incidentRootId, row.splitId, row.split]), [
    ["source-family-17", "incident-root-4", "dev-2026w45", "development"],
    ["source-family-17", "incident-root-4", "dev-2026w45", "development"],
  ]);
  const request = buildPrivateCanaryRequest(result.corpus, "dev-family-a");
  assert.equal(request.state, "available");
  if (request.state === "available") {
    assert.equal(request.request.prompt.includes("source-family-17"), false);
    assert.equal(request.request.prompt.includes("incident-root-4"), false);
  }
  const keys = generateKeyPairSync("ed25519");
  const leakedHoldout = item("held-family-a", "sealed-holdout", "source-family-17", "incident-root-4");
  const signed = signedHoldout([leakedHoldout], keys.privateKey);
  const crossSplit = validatePrivateCorpus(bundle([first], signed), {
    "test-holdout-key": keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  assert.deepEqual(crossSplit, { state: "unavailable", reason: "private-corpus-cross-split-leakage" });
  const duplicateId = item("dev-duplicate", "development", "family-dev-duplicate", "root-dev-duplicate");
  const duplicateHoldout = item("dev-duplicate", "sealed-holdout", "family-held-duplicate", "root-held-duplicate");
  const duplicate = validatePrivateCorpus(bundle([duplicateId], signedHoldout([duplicateHoldout], keys.privateKey)), {
    "test-holdout-key": keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  assert.deepEqual(duplicate, { state: "unavailable", reason: "private-corpus-case-id-duplicate-across-splits" });
  assert.deepEqual(validatePrivateCorpus(bundle([item("bad-time", "development", "fam", "root", "2026-11-03T00:00:00-05:00")])),
    { state: "unavailable", reason: "private-corpus-provenance-invalid" });
});

test("private corpus verifies signed holdout JSON with numeric object keys in lexical order", () => {
  const keys = generateKeyPairSync("ed25519");
  const holdout = item("numeric-key-holdout", "sealed-holdout", "family-numeric", "root-numeric");
  holdout.item.expected = { "2": "two", "10": "ten" };
  const signed = signedHoldout([holdout], keys.privateKey);
  const result = validatePrivateCorpus(bundle([], signed), {
    "test-holdout-key": keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  assert.deepEqual(result, { state: "unavailable", reason: "private-corpus-scorer-invalid" },
    "signature verification must succeed before the intentionally invalid scorer shape is rejected");
  assert.equal(canonicalPrivateCanaryJson({ "2": "two", "10": "ten" }), '{"10":"ten","2":"two"}');
});

test("private corpus charges exact encoded bytes for unicode strings", () => {
  const samples = [
    ["😀", '"😀"'],
    ["\ud800", '"\\ud800"'],
    ["\ud800a", '"\\ud800a"'],
    ["\udc00", '"\\udc00"'],
    ["é", '"é"'],
    ["漢", '"漢"'],
  ];
  for (const [value, expected] of samples) {
    const bytes = Buffer.byteLength(expected, "utf8");
    assert.equal(snapshotPrivateCanaryJson(value, bytes), value);
    assert.throws(() => snapshotPrivateCanaryJson(value, bytes - 1), /private-corpus-json-bound/);
    assert.equal(canonicalPrivateCanaryJson(value, bytes), expected);
    assert.throws(() => canonicalPrivateCanaryJson(value, bytes - 1), /private-corpus-json-bound/);
  }
});

test("private corpus case matching refuses cyclic and accessor inputs without reading getters", () => {
  const source = item("case-matching", "development", "matching-family", "matching-root");
  const result = validatePrivateCorpus(bundle([source]));
  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  assert.equal(privateCorpusCaseMatches(result.corpus, source.item), true);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(privateCorpusCaseMatches(result.corpus, { ...source.item, expected: cycle }), false);
  let getterCalls = 0;
  const accessor = Object.defineProperty({ ...source.item }, "prompt", {
    enumerable: true, get() { getterCalls++; return source.item.prompt; },
  });
  assert.equal(privateCorpusCaseMatches(result.corpus, accessor), false);
  assert.equal(getterCalls, 0);
});

test("private corpus scorer keeps malformed trace inputs unavailable", () => {
  const source = item("scorer-error", "development", "scorer-family", "scorer-root");
  const result = validatePrivateCorpus(bundle([source]));
  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  const answer = JSON.stringify(source.item.expected);
  const control = gradeStoredPrivateCase(result.corpus, source.item.id, answer, []);
  assert.equal(control.state, "scored");
  if (control.state === "scored") assert.equal(control.passed, true);

  const args: Record<string, unknown> = {};
  args.self = args;
  assert.deepEqual(gradeStoredPrivateCase(result.corpus, source.item.id, answer,
    [{ name: "unlisted-tool", args, result: null, denied: true }]),
  { state: "unavailable", reason: "private-corpus-scorer-error" });
  assert.deepEqual(gradeStoredPrivateCase(result.corpus, source.item.id, answer, []), control);
});

test("private corpus strictly validates expected output keys and types for every family", () => {
  const retention = item("retention-schema", "development", "retention-family", "retention-root").item;
  const anchors = [...commonCanarySuite(), ...weeklyCanarySuite(),
    { ...retention, family: "retention" as const, expected: { turn: 1, key: "price", answer: 7, source: "D1" } },
    { ...retention, family: "retention" as const, expected: { turn: 2, key: "absent", answer: null, source: null } }];
  for (const anchor of anchors) {
    const source = item(anchor.id, "development", "strict-output-family", "strict-output-root");
    source.item = anchor;
    const dispatch = canaryTools(anchor);
    source.expectedToolTrace = anchor.tools === "none" ? [] : anchor.tools === "inventory"
      ? [dispatch("inventory", { item: anchor.id === "tools-A" ? "A" : "B" })]
      : anchor.tools === "retry" ? [dispatch("lookup", {}), dispatch("lookup", {})] : [dispatch("lookup", {})];
    const control = validatePrivateCorpus(bundle([source]));
    assert.equal(control.state, "available", `${anchor.id}: supported oracle`);
    if (control.state !== "available") return;
    const grade = gradeStoredPrivateCase(control.corpus, anchor.id, JSON.stringify(anchor.expected), source.expectedToolTrace);
    assert.equal(grade.state, "scored");
    if (grade.state === "scored") assert.equal(grade.passed, true);
    const malformed: Record<string, unknown>[] = [{ ...anchor.expected, extra: true }];
    for (const [key, value] of Object.entries(anchor.expected)) {
      const missing = { ...anchor.expected };
      delete missing[key];
      malformed.push(missing);
      for (const wrongType of [[value], {}, true]) malformed.push({ ...anchor.expected, [key]: wrongType });
    }
    if (anchor.family === "schema") malformed.push({ ...anchor.expected, category: "unsupported" },
      { ...anchor.expected, severity: "medium" }, { ...anchor.expected, ticket: 1.5 });
    if (anchor.family === "recovery") malformed.push({ ...anchor.expected, status: "unsupported" });
    if (anchor.family === "tools") malformed.push({ quantity: 1.5 });
    if (anchor.family === "retention") malformed.push({ ...anchor.expected, turn: 1.5 });
    for (const expected of malformed) assert.deepEqual(validatePrivateCorpus(bundle([
      { ...source, item: { ...anchor, expected } },
    ])), { state: "unavailable", reason: "private-corpus-scorer-invalid" },
    `${anchor.id}: malformed oracle ${JSON.stringify(expected)}`);
  }
});

test("private corpus rejects enum arrays instead of coercing them into supported values", () => {
  const source = item("strict-enum", "development", "strict-enum-family", "strict-enum-root");
  const review = { ...source.item, family: "review", expected: { finding: "empty-input" }, cadence: "weekly" };
  const approvalTrace = [{ name: "lookup", args: {}, result: { error: "approval-required" }, denied: false }];
  const malformedCases = [
    { ...source, item: { ...review, family: ["review"] } },
    { ...source, item: { ...review, tools: ["approval"] }, expectedToolTrace: approvalTrace },
    { ...source, item: { ...review, cadence: ["weekly"] } },
    { ...source, item: review, provenance: { ...source.provenance, role: ["coder"] } },
  ];
  for (const [index, malformedCase] of malformedCases.entries()) {
    const raw: unknown = { version: "model-canary-private-bundle-v1", development: {
      version: "model-canary-private-payload-v1", split: "development", cases: [malformedCase],
    } };
    assert.deepEqual(validatePrivateCorpus(raw), { state: "unavailable",
      reason: index === 3 ? "private-corpus-provenance-invalid" : "private-corpus-case-invalid" });
  }
});

test("private corpus rejects lossy scorer JSON without invoking getters", () => {
  let getterCalls = 0;
  const accessor = item("accessor", "development", "family-accessor", "root-accessor");
  Object.defineProperty(accessor.item, "expected", { enumerable: true, configurable: true,
    get() { getterCalls++; return { category: "deploy", ticket: 17, severity: "low" }; } });
  assert.deepEqual(validatePrivateCorpus(bundle([accessor])),
    { state: "unavailable", reason: "private-corpus-json-object-invalid" });
  assert.equal(getterCalls, 0);

  const cyclic = item("cyclic", "development", "family-cycle", "root-cycle");
  const loop: Record<string, unknown> = {}; loop.self = loop;
  cyclic.item.expected = loop;
  assert.deepEqual(validatePrivateCorpus(bundle([cyclic])),
    { state: "unavailable", reason: "private-corpus-json-cycle" });

  const nonFinite = item("nonfinite", "development", "family-nan", "root-nan");
  nonFinite.item.expected = { count: Number.POSITIVE_INFINITY };
  assert.deepEqual(validatePrivateCorpus(bundle([nonFinite])),
    { state: "unavailable", reason: "private-corpus-json-invalid" });

  const oversized = item("oversized", "development", "family-large", "root-large");
  oversized.item.prompt = "x".repeat(2 * 1024 * 1024 + 1);
  assert.deepEqual(validatePrivateCorpus(bundle([oversized])),
    { state: "unavailable", reason: "private-corpus-json-bound" });
});

function runPrivateCommand(args: string[]): Record<string, unknown> {
  const output = execFileSync(process.execPath, ["--import", "tsx",
    join(REPO_ROOT, "src/lib/model-canary-command.ts"), ...args], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024,
  });
  return JSON.parse(output) as Record<string, unknown>;
}

test("private corpus command keeps request manifests separate and private", t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-private-corpus-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = item("cli-private-a", "development", "private-source-family", "private-incident-root");
  const corpusFile = join(dir, "corpus.json"), out = join(dir, "prepared");
  const bytes = JSON.stringify(bundle([source]));
  writeFileSync(corpusFile, bytes, { mode: 0o600 });
  const prepared = runPrivateCommand(["prepare-private", out, corpusFile]);
  assert.equal(prepared.state, "prepared-not-activated");
  assert.equal(prepared.cases, 1);
  const requestFile = join(out, "model-canary-private-requests.json");
  const manifest = JSON.parse(readFileSync(requestFile, "utf8"));
  assert.equal(manifest.state, "prepared-not-activated");
  assert.deepEqual(Object.keys(manifest.requests[0]).sort(), ["allowedTools", "prompt", "requestId"]);
  assert.equal(manifest.requests[0].prompt, source.item.prompt);
  assert.equal(JSON.stringify(manifest).includes("private-source-family"), false);
  assert.equal(JSON.stringify(manifest).includes("private-incident-root"), false);
  const scorer = JSON.parse(readFileSync(join(out, "model-canary-private-scorer.json"), "utf8"));
  assert.deepEqual(scorer.development.cases[0].item.expected, source.item.expected);
  const joins = JSON.parse(readFileSync(join(out, "model-canary-private-joins.json"), "utf8"));
  assert.equal(joins.joins[0].requestId, manifest.requests[0].requestId);
  assert.equal(joins.joins[0].caseId, source.item.id);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  for (const name of ["model-canary-private-requests.json", "model-canary-private-scorer.json", "model-canary-private-joins.json"])
    assert.equal(statSync(join(out, name)).mode & 0o777, 0o600);
  assert.equal(readFileSync(corpusFile, "utf8"), bytes);
  assert.throws(() => runPrivateCommand(["prepare-private", out, corpusFile]), /EEXIST/);
  const publicCorpusFile = join(dir, "public-corpus.json");
  const priorUmask = process.umask(0);
  try { writeFileSync(publicCorpusFile, bytes, { mode: 0o644 }); }
  finally { process.umask(priorUmask); }
  assert.throws(() => runPrivateCommand(["prepare-private", join(dir, "public-input"), publicCorpusFile]),
    /canary-input-private-owned-file-required/);
  assert.equal(existsSync(join(dir, "public-input")), false);
});

test("private corpus command verifies separately selected anchors", t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-private-anchor-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const held = item("cli-held", "sealed-holdout", "held-family", "held-root");
  const corpusFile = join(dir, "corpus.json"), anchorFile = join(dir, "anchors.json");
  writeFileSync(corpusFile, JSON.stringify(bundle([], signedHoldout([held], keys.privateKey))), { mode: 0o600 });
  writeFileSync(anchorFile, JSON.stringify({ "test-holdout-key": keys.publicKey.export({ type: "spki", format: "pem" }).toString() }), { mode: 0o600 });
  assert.throws(() => runPrivateCommand(["prepare-private", join(dir, "untrusted"), corpusFile]),
    /private-corpus-holdout-trust-anchor-unavailable/);
  const prepared = runPrivateCommand(["prepare-private", join(dir, "verified"), corpusFile, "--trust-anchors", anchorFile]);
  assert.deepEqual(prepared.splits, { development: 0, "sealed-holdout": 1 });
  assert.throws(() => runPrivateCommand(["prepare-private", join(dir, "bad-flag"), corpusFile, "--embedded-trust", anchorFile]),
    /canary-private-trust-anchor-argument-invalid/);
  const publicAnchorFile = join(dir, "public-anchors.json");
  const anchorBytes = JSON.stringify({ "test-holdout-key": keys.publicKey.export({ type: "spki", format: "pem" }).toString() });
  const priorUmask = process.umask(0);
  try { writeFileSync(publicAnchorFile, anchorBytes, { mode: 0o644 }); }
  finally { process.umask(priorUmask); }
  assert.throws(() => runPrivateCommand(["prepare-private", join(dir, "public-key-input"), corpusFile,
    "--trust-anchors", publicAnchorFile]), /canary-input-private-owned-file-required/);
  writeFileSync(anchorFile, JSON.stringify({ key: { embedded: "not-an-anchor" } }));
  assert.throws(() => runPrivateCommand(["prepare-private", join(dir, "bad-key-shape"), corpusFile, "--trust-anchors", anchorFile]),
    /canary-private-trust-anchors-invalid/);
});

test("private trace command regrades native owner custody and rejects imported claims", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-private-regrade-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = item("cli-regrade", "development", "private-cli-family", "private-cli-root");
  const pack = bundle([source]), validated = validatePrivateCorpus(pack);
  assert.equal(validated.state, "available");
  if (validated.state !== "available") return;
  const pin = { model: "fixture-model", route: "fixture-route", effort: "low",
    suiteHash: canarySuiteDigest([source.item]), billing: "subscription" as const };
  const slot = buildCanarySchedule("2026-11-03", "private-command-fixture", [source.item], [pin]).slots[0]!;
  const ownerDir = join(dir, "native-owner");
  mkdirSync(ownerDir, { mode: 0o700 });
  const owner = new CanarySlotOwner(ownerDir);
  let clock = 0;
  const resources: CanaryResponse["resources"] = { durationMs: null, firstTextMs: null, generationMs: null,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    reasoningTokens: null, usageRatedUsd: null, billing: "subscription", servedModel: null, terminal: "complete" };
  try {
    assert.equal(owner.claim(slot), "claimed");
    const outcome = await executeCanary(source.item, pin, {
      admit: async () => ({ state: "admitted" }),
      request: async () => ({ text: JSON.stringify(source.item.expected), toolCalls: [], resources }),
      save: async () => {}, monotonicMs: () => clock++,
    }, undefined, { corpus: validated.corpus, slotId: slot.id });
    assert.equal(outcome.state, "scored");
    assert.equal(outcome.run.verified, true);
    owner.terminal(slot, outcome);
    const corpusFile = join(dir, "corpus.json"), bindingFile = join(dir, "binding.json");
    writeFileSync(corpusFile, JSON.stringify(pack), { mode: 0o600 });
    const request = { version: "model-canary-private-grade-input-v1", slot, binding: outcome.privateTrace!.binding };
    writeFileSync(bindingFile, JSON.stringify(request), { mode: 0o600 });
    const result = runPrivateCommand(["grade-private", join(dir, "regraded"), corpusFile, ownerDir, bindingFile]);
    assert.equal(result.gradeState, "scored");
    assert.equal(result.passed, true);
    const artifact = JSON.parse(readFileSync(join(dir, "regraded", "model-canary-private-grade.json"), "utf8"));
    assert.equal(artifact.evidenceSource, "operator-selected-private-owner-custody");
    assert.deepEqual(artifact.binding, {
      version: "private-canary-trace-binding-v1", runId: outcome.run.id, slotId: slot.id,
      caseId: source.item.id, suiteHash: pin.suiteHash, corpusDigest: validated.metadata.digest,
      scorerDigest: validated.metadata.cases.find(row => row.caseId === source.item.id)!.scorerDigest,
    });
    writeFileSync(bindingFile, JSON.stringify({ ...request, trusted: true, trace: outcome.privateTrace }));
    assert.throws(() => runPrivateCommand(["grade-private", join(dir, "imported-claim"), corpusFile, ownerDir, bindingFile]),
      /canary-private-binding-input-invalid/);
    writeFileSync(bindingFile, JSON.stringify(request));
    const missingOwner = join(dir, "missing-owner");
    const absent = runPrivateCommand(["grade-private", join(dir, "unavailable"), corpusFile, missingOwner, bindingFile]);
    assert.equal(absent.gradeState, "unavailable");
    assert.equal(absent.passed, null);
    assert.equal(existsSync(missingOwner), false);
    const unavailableArtifact = JSON.parse(readFileSync(join(dir, "unavailable", "model-canary-private-grade.json"), "utf8"));
    assert.equal(unavailableArtifact.binding, null);
    assert.equal(unavailableArtifact.evidenceSource, "unavailable");
    writeFileSync(bindingFile, JSON.stringify({ ...request, binding: { ...request.binding, runId: "wrong-run" } }));
    const mismatch = runPrivateCommand(["grade-private", join(dir, "mismatch"), corpusFile, ownerDir, bindingFile]);
    assert.equal(mismatch.gradeState, "unavailable");
    assert.equal(mismatch.passed, null);
    const mismatchArtifact = JSON.parse(readFileSync(join(dir, "mismatch", "model-canary-private-grade.json"), "utf8"));
    assert.equal(mismatchArtifact.binding, null);
  } finally { owner.close(); }
});


test("private corpus refuses malformed and unsupported holdout trust keys", () => {
  const ed = generateKeyPairSync("ed25519"), ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const held = item("held-key-type", "sealed-holdout", "held-key-family", "held-key-root");
  const pack = bundle([], signedHoldout([held], ed.privateKey));
  assert.deepEqual(validatePrivateCorpus(pack, { "test-holdout-key": "invalid-public-key" }),
    { state: "unavailable", reason: "private-corpus-holdout-trust-anchor-invalid" });
  assert.deepEqual(validatePrivateCorpus(pack, {
    "test-holdout-key": ec.publicKey.export({ type: "spki", format: "pem" }).toString(),
  }), { state: "unavailable", reason: "private-corpus-holdout-key-type-invalid" });
});

test("private corpus accepts only bounded goldens matching the deterministic tool simulator", () => {
  const valid = item("tool-control-valid", "development", "family-valid", "root-valid");
  valid.item = { ...valid.item, family: "tools", tools: "inventory", expected: { quantity: 4 } };
  valid.expectedToolTrace = [{ name: "inventory", args: { item: "A" }, result: { quantity: 4 }, denied: false }];
  assert.equal(validatePrivateCorpus(bundle([valid])).state, "available", "known-good app trace remains accepted");

  const wrongArgs = item("tool-control-wrong-args", "development", "family-wrong-args", "root-wrong-args");
  wrongArgs.item = { ...wrongArgs.item, family: "tools", tools: "inventory", expected: { quantity: 4 } };
  wrongArgs.expectedToolTrace = [{ name: "inventory", args: { item: "B" }, result: { quantity: 4 }, denied: false }];
  assert.deepEqual(validatePrivateCorpus(bundle([wrongArgs])),
    { state: "unavailable", reason: "private-corpus-scorer-invalid" });

  const wrongResult = item("tool-control-wrong-result", "development", "family-wrong-result", "root-wrong-result");
  wrongResult.item = { ...wrongResult.item, family: "tools", tools: "inventory", expected: { quantity: 100 } };
  wrongResult.expectedToolTrace = [{ name: "inventory", args: { item: "A" }, result: { quantity: 100 }, denied: false }];
  assert.deepEqual(validatePrivateCorpus(bundle([wrongResult])),
    { state: "unavailable", reason: "private-corpus-scorer-invalid" });

  const oversizedAnswer = item("tool-control-oversized-answer", "development", "family-large-answer", "root-large-answer");
  oversizedAnswer.item = { ...oversizedAnswer.item, family: "review", tools: "none",
    expected: { finding: "x".repeat(70_000) } };
  assert.deepEqual(validatePrivateCorpus(bundle([oversizedAnswer])),
    { state: "unavailable", reason: "private-corpus-scorer-invalid" });

  const oversizedTrace = item("tool-control-oversized-trace", "development", "family-large-trace", "root-large-trace");
  oversizedTrace.item = { ...oversizedTrace.item, family: "tools", tools: "inventory", expected: { quantity: 4 } };
  oversizedTrace.expectedToolTrace = [{ name: "inventory", args: { item: "A", pad: "x".repeat(40_000) },
    result: { quantity: 4 }, denied: false }];
  assert.deepEqual(validatePrivateCorpus(bundle([oversizedTrace])),
    { state: "unavailable", reason: "private-corpus-scorer-invalid" });
});
