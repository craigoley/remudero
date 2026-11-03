/** Private canary corpus validation, request projection and scorer storage. */
import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { canaryTools, gradeCanary, type CanaryCase, type CanaryToolEvent } from "./model-canary-suite.js";
import { codingRequestFixture, syntheticCodingFixture, type CodingFixture } from "./model-canary-coding.js";
import { fixedClock } from "./clock.js";

export type PrivateCanarySplit = "development" | "sealed-holdout";
export type PrivateCanaryRole = "worker" | "reviewer" | "coder";

export interface PrivateCanaryProvenanceV1 {
  sourceFamilyId: string;
  incidentRootId: string;
  sourceDigest: string;
  observedAt: string;
  splitId: string;
  split: PrivateCanarySplit;
  role: PrivateCanaryRole;
}

export interface PrivateCanaryCaseV1 {
  item: CanaryCase;
  provenance: PrivateCanaryProvenanceV1;
  /** Expected tools are scorer-only and are matched against recorder-captured events. */
  expectedToolTrace: readonly CanaryToolEvent[];
  scorerVersion: "exact-json-and-application-trace-v1" | "coding-control-v1";
}

export interface PrivateCanaryPayloadV1 {
  version: "model-canary-private-payload-v1";
  split: PrivateCanarySplit;
  cases: readonly PrivateCanaryCaseV1[];
}

export interface SignedPrivateCanaryHoldoutV1 {
  version: "model-canary-sealed-holdout-v1";
  keyId: string;
  payload: PrivateCanaryPayloadV1 & { split: "sealed-holdout" };
  signatureBase64: string;
}

export interface PrivateCanaryBundleV1 {
  version: "model-canary-private-bundle-v1";
  development: PrivateCanaryPayloadV1 & { split: "development" };
  sealedHoldout?: SignedPrivateCanaryHoldoutV1;
}

/** This registry is supplied out of band by operator configuration, never read from the corpus JSON. */
export type PrivateCorpusTrustAnchors = Readonly<Record<string, string>>;

export interface PrivateCanaryRequestV1 {
  requestId: string;
  prompt: string;
  allowedTools: readonly string[];
}

export interface PrivateTraceBindingV1 {
  version: "private-canary-trace-binding-v1";
  runId: string;
  slotId: string;
  caseId: string;
  suiteHash: string;
  corpusDigest: string;
  scorerDigest: string;
}

export interface PrivateTraceReceiptV1 {
  version: "private-canary-trace-receipt-v1";
  binding: PrivateTraceBindingV1;
  finalText: string | null;
  events: readonly CanaryToolEvent[];
  complete: boolean;
  reason: string | null;
  digest: string;
}

export interface PrivateCorpusMetadataV1 {
  version: "model-canary-private-corpus-metadata-v1";
  digest: string;
  state: "validated-private";
  splits: Readonly<Record<PrivateCanarySplit, number>>;
  cases: readonly {
    caseId: string;
    family: CanaryCase["family"];
    sourceFamilyId: string;
    incidentRootId: string;
    sourceDigest: string;
    observedAt: string;
    splitId: string;
    split: PrivateCanarySplit;
    role: PrivateCanaryRole;
    scorerDigest: string;
  }[];
}

export type ValidatedPrivateCorpus = object;
export type PrivateCorpusResult =
  | { state: "available"; corpus: ValidatedPrivateCorpus; metadata: PrivateCorpusMetadataV1 }
  | { state: "unavailable"; reason: string };

interface PrivateScorerCase {
  item: CanaryCase;
  provenance: PrivateCanaryProvenanceV1;
  expectedToolTrace: readonly CanaryToolEvent[];
  scorerDigest: string;
  codingFixture?: CodingFixture;
}
interface PrivateCorpusSnapshot {
  digest: string;
  cases: ReadonlyMap<string, PrivateScorerCase>;
  metadata: PrivateCorpusMetadataV1;
}

const corpusSnapshots = new WeakMap<object, PrivateCorpusSnapshot>();
const MAX_CORPUS_CASES = 256;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_PROMPT_BYTES = 65_536;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const codeUnitCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(reason: string): never { throw new Error(reason); }

function chargeJsonString(text: string, charge: (bytes: number) => void, maxBytes: number): void {
  if (Buffer.byteLength(text, "utf8") > maxBytes) fail("private-corpus-json-bound");
  let bytes=2;
  for(let index=0;index<text.length;index++) {
    const code=text.charCodeAt(index);
    if(code===0x22||code===0x5c||code===0x08||code===0x09||code===0x0a||code===0x0c||code===0x0d) bytes+=2;
    else if(code<0x20) bytes+=6;
    else if(code>=0xd800&&code<=0xdbff) {
      const next=text.charCodeAt(index+1);
      if(next>=0xdc00&&next<=0xdfff) { bytes+=4; index++; } else bytes+=6;
    } else if(code>=0xdc00&&code<=0xdfff) bytes+=6;
    else if(code<=0x7f) bytes++;
    else if(code<=0x7ff) bytes+=2;
    else bytes+=3;
  }
  charge(bytes);
}

/** Clone JSON without invoking getters, accepting lossy values, retaining references, or expanding unbounded DAGs. */
function cloneFiniteJson(value: unknown, maxBytes = MAX_JSON_BYTES): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_JSON_BYTES)
    fail("private-corpus-json-bound");
  let remaining = maxBytes;
  let nodes = 0;
  const charge = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining) fail("private-corpus-json-bound");
    remaining -= bytes;
  };
  const ancestors = new Set<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) fail("private-corpus-json-complexity-bound");
    if (input === null) { charge(4); return null; }
    if (typeof input === "boolean") { charge(input ? 4 : 5); return input; }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) fail("private-corpus-json-invalid");
      const text = JSON.stringify(input)!; charge(Buffer.byteLength(text)); return input;
    }
    if (typeof input === "string") { chargeJsonString(input,charge,maxBytes); return input; }
    if (typeof input !== "object") fail("private-corpus-json-invalid");
    if (ancestors.has(input)) fail("private-corpus-json-cycle");
    ancestors.add(input);
    let result: unknown;
    if (Array.isArray(input)) {
      const keys = Reflect.ownKeys(input);
      if (Object.getPrototypeOf(input) !== Array.prototype || keys.length !== input.length + 1)
        fail("private-corpus-json-array-invalid");
      charge(2 + Math.max(0, input.length - 1));
      const out: unknown[] = [];
      for (let i = 0; i < input.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value"))
          fail("private-corpus-json-array-invalid");
        out.push(visit(descriptor.value, depth + 1));
      }
      result = Object.freeze(out);
    } else {
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) fail("private-corpus-json-object-invalid");
      const keys = Reflect.ownKeys(input);
      if (keys.some(key => typeof key !== "string")) fail("private-corpus-json-object-invalid");
      const stringKeys = (keys as string[]).sort(codeUnitCompare);
      charge(2 + Math.max(0, stringKeys.length - 1));
      const out: Record<string, unknown> = Object.create(null);
      for (const key of stringKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value"))
          fail("private-corpus-json-object-invalid");
        chargeJsonString(key,charge,maxBytes); charge(1);
        Object.defineProperty(out, key, { value: visit(descriptor.value, depth + 1), enumerable: true,
          configurable: false, writable: false });
      }
      result = Object.freeze(out);
    }
    ancestors.delete(input);
    return result;
  };
  return visit(value, 0);
}

export function snapshotPrivateCanaryJson(value: unknown, maxBytes = MAX_JSON_BYTES): unknown {
  return cloneFiniteJson(value, maxBytes);
}

export function canonicalPrivateCanaryJson(value: unknown, maxBytes = MAX_JSON_BYTES): string {
  const clone = snapshotPrivateCanaryJson(value, maxBytes);
  const encode = (item: unknown): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item)!;
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    const keys = Object.keys(item).sort(codeUnitCompare);
    return `{${keys.map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
  };
  const result = encode(clone);
  if (Buffer.byteLength(result, "utf8") > maxBytes) fail("private-corpus-json-bound");
  return result;
}

const canonicalJson = canonicalPrivateCanaryJson;

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!record(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every(key => typeof key === "string")
    && required.every(key => Object.hasOwn(value, key))
    && (keys as string[]).every(key => required.includes(key) || optional.includes(key));
}

function validDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && fixedClock(ms).iso() === value;
}

/** Validate oracle types and keys independently of the legacy grader's self-agreement control. */
function validExpectedOutput(family: CanaryCase["family"], expected: Record<string, unknown>): boolean {
  const numberOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
  const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value);
  switch (family) {
    case "schema": return exactKeys(expected, ["category", "ticket", "severity"])
      && typeof expected.category === "string" && ["deploy", "incident", "other"].includes(expected.category)
      && (expected.ticket === null || integer(expected.ticket))
      && (expected.severity === null || expected.severity === "low" || expected.severity === "high");
    case "evidence": return exactKeys(expected, ["answer", "sources"]) && numberOrNull(expected.answer)
      && Array.isArray(expected.sources) && expected.sources.every(source => typeof source === "string");
    case "tools": return exactKeys(expected, ["quantity"]) && integer(expected.quantity);
    case "recovery": return exactKeys(expected, ["status", "value"])
      && typeof expected.status === "string" && ["complete", "blocked", "approval-required"].includes(expected.status)
      && numberOrNull(expected.value);
    case "review": return exactKeys(expected, ["finding"])
      && (expected.finding === null || typeof expected.finding === "string");
    case "retention": return exactKeys(expected, ["turn", "key", "answer", "source"])
      && integer(expected.turn) && typeof expected.key === "string" && numberOrNull(expected.answer)
      && (expected.source === null || typeof expected.source === "string");
    case "coding": return false;
  }
}

function normalizeCase(raw: unknown, split: PrivateCanarySplit): PrivateScorerCase {
  const safe = cloneFiniteJson(raw);
  if (!exactKeys(safe, ["item", "provenance", "expectedToolTrace", "scorerVersion"])
    || !(safe.scorerVersion === "exact-json-and-application-trace-v1" || safe.scorerVersion === "coding-control-v1")
    || !exactKeys(safe.provenance, ["sourceFamilyId", "incidentRootId", "sourceDigest", "observedAt", "splitId", "split", "role"])
    || !Array.isArray(safe.expectedToolTrace)) fail("private-corpus-case-invalid");
  const item = safe.item;
  if (!exactKeys(item, ["id", "family", "prompt", "expected", "tools", "cadence"], ["codingControl"])
    || typeof item.id !== "string" || item.id.length < 1 || item.id.length > 120
    || typeof item.family !== "string"
    || !["schema", "evidence", "tools", "recovery", "review", "retention", "coding"].includes(item.family)
    || typeof item.prompt !== "string" || Buffer.byteLength(item.prompt) > MAX_PROMPT_BYTES
    || !record(item.expected)
    || typeof item.tools !== "string" || !["none", "inventory", "retry", "approval"].includes(item.tools)
    || typeof item.cadence !== "string" || !["daily", "weekly"].includes(item.cadence))
    fail("private-corpus-case-invalid");
  const p = safe.provenance as Record<string, unknown>;
  if (typeof p.sourceFamilyId !== "string" || p.sourceFamilyId.length < 1 || p.sourceFamilyId.length > 160
    || typeof p.incidentRootId !== "string" || p.incidentRootId.length < 1 || p.incidentRootId.length > 160
    || !validDigest(p.sourceDigest) || !validTime(p.observedAt)
    || typeof p.splitId !== "string" || p.splitId.length < 1 || p.splitId.length > 100
    || p.split !== split || typeof p.role !== "string" || !["worker", "reviewer", "coder"].includes(p.role))
    fail("private-corpus-provenance-invalid");
  if (safe.expectedToolTrace.length > 32) fail("private-corpus-trace-bound");
  for (const event of safe.expectedToolTrace) {
    if (!exactKeys(event, ["name", "args", "result", "denied"]) || typeof event.name !== "string"
      || event.name.length > 100 || event.denied !== false) fail("private-corpus-scorer-invalid");
  }
  const itemSnapshot = safe.item as unknown as CanaryCase;
  const provenance = safe.provenance as unknown as PrivateCanaryProvenanceV1;
  const expectedToolTrace = safe.expectedToolTrace as unknown as readonly CanaryToolEvent[];
  const codingCase = itemSnapshot.family === "coding";
  let codingFixture: CodingFixture | undefined;
  if (codingCase) {
    const control = (itemSnapshot as CanaryCase).codingControl;
    if (safe.scorerVersion !== "coding-control-v1" || !exactKeys(control, ["version", "seed"])
      || control.version !== "coding-control-v1" || typeof control.seed !== "string"
      || control.seed.length < 1 || control.seed.length > 256 || Object.keys(itemSnapshot.expected).length !== 0
      || itemSnapshot.tools !== "none" || expectedToolTrace.length !== 0)
      fail("private-corpus-coding-case-invalid");
    codingFixture = syntheticCodingFixture(control.seed);
    if (itemSnapshot.prompt !== codingFixture.prompt) fail("private-corpus-coding-case-invalid");
  } else {
    if (safe.scorerVersion !== "exact-json-and-application-trace-v1" || itemSnapshot.codingControl !== undefined)
      fail("private-corpus-case-invalid");
    if (!validExpectedOutput(itemSnapshot.family, itemSnapshot.expected)) fail("private-corpus-scorer-invalid");
    const scorerControl = gradeCanary(itemSnapshot, JSON.stringify(itemSnapshot.expected), expectedToolTrace);
    if (!scorerControl.passed) fail("private-corpus-scorer-invalid");
    // Goldens must fit the same bounds as an actual final response and owner-captured trace.
    const finalText = JSON.stringify(itemSnapshot.expected);
    if (Buffer.byteLength(finalText, "utf8") > 65_536) fail("private-corpus-scorer-invalid");
  }
  try { canonicalJson(expectedToolTrace, 32 * 1024); }
  catch { // A trace that exceeds the real recorder bound cannot be a usable golden.
    fail("private-corpus-scorer-invalid");
  }
  // Check the signed gold trace against the same deterministic application simulator the
  // recorder uses. Scorer agreement with a self-consistent but impossible claimed result is
  // insufficient (for example, inventory A is quantity 4, not an arbitrary signed quantity).
  if (!codingCase) {
    const dispatch = canaryTools(itemSnapshot);
    const simulatedToolTrace = expectedToolTrace.map(event => dispatch(event.name, event.args));
    if (canonicalJson(simulatedToolTrace, 32 * 1024) !== canonicalJson(expectedToolTrace, 32 * 1024))
      fail("private-corpus-scorer-invalid");
  }
  const scorerDigest = sha256(canonicalJson({ version: safe.scorerVersion, expected: itemSnapshot.expected,
    family: itemSnapshot.family, tools: itemSnapshot.tools, expectedToolTrace,
    ...(codingFixture ? { codingFixtureDigest: codingFixture.digest } : {}) }));
  return Object.freeze({ item: itemSnapshot, provenance, expectedToolTrace, scorerDigest, ...(codingFixture ? { codingFixture } : {}) });
}

function payloadCases(payload: unknown, split: PrivateCanarySplit): PrivateScorerCase[] {
  if (!exactKeys(payload, ["version", "split", "cases"]) || payload.version !== "model-canary-private-payload-v1"
    || payload.split !== split || !Array.isArray(payload.cases) || payload.cases.length > MAX_CORPUS_CASES)
    fail("private-corpus-payload-invalid");
  const cases = payload.cases.map(value => normalizeCase(value, split));
  if (new Set(cases.map(item => item.item.id)).size !== cases.length) fail("private-corpus-case-id-duplicate");
  return cases;
}

function verifyHoldout(envelope: unknown, anchors: PrivateCorpusTrustAnchors): PrivateScorerCase[] {
  if (!exactKeys(envelope, ["version", "keyId", "payload", "signatureBase64"])
    || envelope.version !== "model-canary-sealed-holdout-v1"
    || typeof envelope.keyId !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(envelope.keyId)
    || typeof envelope.signatureBase64 !== "string")
    fail("private-corpus-holdout-envelope-invalid");
  const publicKey = Object.hasOwn(anchors, envelope.keyId) ? anchors[envelope.keyId] : undefined;
  if (typeof publicKey !== "string" || publicKey.length > 4096) fail("private-corpus-holdout-trust-anchor-unavailable");
  let key: ReturnType<typeof createPublicKey>;
  try { key = createPublicKey(publicKey); }
  catch { // An unparseable configured key cannot authenticate a holdout.
    fail("private-corpus-holdout-trust-anchor-invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") fail("private-corpus-holdout-key-type-invalid");
  const payload = envelope.payload;
  const signature = Buffer.from(envelope.signatureBase64, "base64");
  // This authenticates the signed corpus bytes, not whether the content was absent from training.
  if (signature.length !== 64 || signature.toString("base64") !== envelope.signatureBase64
    || !verifySignature(null, Buffer.from(canonicalJson(payload)), key, signature))
    fail("private-corpus-holdout-signature-invalid");
  return payloadCases(payload, "sealed-holdout");
}

/**
 * Validate a development pack plus optional signed holdout. The trust map is a separate argument
 * loaded by the application from operator-controlled configuration; it is never read from `input`.
 */
export function validatePrivateCorpus(input: unknown, trustAnchors: PrivateCorpusTrustAnchors = {}): PrivateCorpusResult {
  try {
    const safe = cloneFiniteJson(input);
    const safeAnchors = cloneFiniteJson(trustAnchors);
    if (!record(safeAnchors)) fail("private-corpus-trust-anchor-invalid");
    if (!exactKeys(safe, ["version", "development"], ["sealedHoldout"])
      || safe.version !== "model-canary-private-bundle-v1") fail("private-corpus-bundle-invalid");
    const development = payloadCases(safe.development, "development");
    const holdout = safe.sealedHoldout === undefined ? []
      : verifyHoldout(safe.sealedHoldout, safeAnchors as PrivateCorpusTrustAnchors);
    if (development.length + holdout.length === 0 || development.length + holdout.length > MAX_CORPUS_CASES)
      fail("private-corpus-case-bound");
    const all = [...development, ...holdout];
    if (new Set(all.map(item => item.item.id)).size !== all.length) fail("private-corpus-case-id-duplicate-across-splits");
    const familySplits = new Map<string, string>();
    const rootSplits = new Map<string, string>();
    const sourceSplits = new Map<string, string>();
    for (const item of all) {
      const p = item.provenance;
      const splitIdentity = `${p.split}:${p.splitId}`;
      for (const [map, key] of [[familySplits, p.sourceFamilyId], [rootSplits, p.incidentRootId], [sourceSplits, p.sourceDigest]] as const) {
        const prior = map.get(key);
        if (prior !== undefined && prior !== splitIdentity) fail("private-corpus-cross-split-leakage");
        map.set(key, splitIdentity);
      }
    }
    const cases = new Map(all.map(item => [item.item.id, item]));
    const metadataCases = all.map(item => ({ caseId: item.item.id, family: item.item.family,
      sourceFamilyId: item.provenance.sourceFamilyId, incidentRootId: item.provenance.incidentRootId,
      sourceDigest: item.provenance.sourceDigest, observedAt: item.provenance.observedAt,
      splitId: item.provenance.splitId, split: item.provenance.split, role: item.provenance.role,
      scorerDigest: item.scorerDigest })).sort((a, b) => codeUnitCompare(a.caseId, b.caseId));
    const digest = sha256(canonicalJson({ development: safe.development, sealedHoldout: safe.sealedHoldout ?? null }));
    const metadata: PrivateCorpusMetadataV1 = Object.freeze({ version: "model-canary-private-corpus-metadata-v1", digest,
      state: "validated-private", splits: Object.freeze({ development: development.length, "sealed-holdout": holdout.length }),
      cases: Object.freeze(metadataCases.map(item => Object.freeze(item))) });
    const token = Object.freeze(Object.create(null)) as ValidatedPrivateCorpus;
    corpusSnapshots.set(token, { digest, cases, metadata });
    return { state: "available", corpus: token, metadata };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "private-corpus-invalid";
    return { state: "unavailable", reason: reason.startsWith("private-corpus-") ? reason : "private-corpus-invalid" };
  }
}

function toolsFor(item: CanaryCase): readonly string[] {
  if (item.tools === "none") return Object.freeze([]);
  return Object.freeze([item.tools === "inventory" ? "inventory" : "lookup"]);
}

/** Request projection contains only the case prompt and permitted tool names, never scorer/provenance. */
export function buildPrivateCanaryRequest(corpus: ValidatedPrivateCorpus, caseId: string):
  | { state: "available"; request: PrivateCanaryRequestV1 }
  | { state: "unavailable"; reason: string } {
  const snapshot = corpusSnapshots.get(corpus);
  if (!snapshot) return { state: "unavailable", reason: "private-corpus-capability-unrecognized" };
  const item = snapshot.cases.get(caseId);
  if (!item) return { state: "unavailable", reason: "private-corpus-case-unknown" };
  const prompt = item.codingFixture ? codingRequestFixture(item.codingFixture).prompt : item.item.prompt;
  return { state: "available", request: Object.freeze({ requestId: randomUUID(),
    prompt, allowedTools: toolsFor(item.item) }) };
}

/** App-only execution input; never place its expectedStdout in a provider or host request. */
export function privateCorpusCodingFixture(corpus: ValidatedPrivateCorpus, caseId: string): CodingFixture | null {
  return corpusSnapshots.get(corpus)?.cases.get(caseId)?.codingFixture ?? null;
}

export function privateCorpusMetadata(corpus: ValidatedPrivateCorpus): PrivateCorpusMetadataV1 | null {
  return corpusSnapshots.get(corpus)?.metadata ?? null;
}

/** True only for the process-local capability minted by validatePrivateCorpus; JSON copies never qualify. */
export function isValidatedPrivateCorpus(value: unknown): value is ValidatedPrivateCorpus {
  return value !== null && typeof value === "object" && !Array.isArray(value) && corpusSnapshots.has(value);
}

/** Native schedule input only; scorer-bearing cases must never be projected into provider requests. */
export function privateCorpusCases(corpus: ValidatedPrivateCorpus): readonly CanaryCase[] | null {
  const snapshot = corpusSnapshots.get(corpus);
  return snapshot ? Object.freeze([...snapshot.cases.values()].map(row => row.item)) : null;
}

/** True only when the full native case body exactly matches the validated private scorer snapshot. */
export function privateCorpusCaseMatches(corpus: ValidatedPrivateCorpus, item: CanaryCase): boolean {
  const snapshot = corpusSnapshots.get(corpus);
  if (!snapshot) return false;
  try {
    const safe = cloneFiniteJson(item);
    if (!exactKeys(safe, ["id", "family", "prompt", "expected", "tools", "cadence"], ["codingControl"])
      || typeof safe.id !== "string") return false;
    const stored = snapshot.cases.get(safe.id);
    return stored !== undefined && canonicalJson(safe) === canonicalJson(stored.item);
  }
  catch { // Invalid case bytes and a mismatched case both refuse execution before admission.
    return false;
  }
}

/** @internal Creates only the existing deterministic application tool simulator for a validated case. */
export function createStoredApplicationToolDispatcher(corpus: ValidatedPrivateCorpus, caseId: string):
  ((name: string, args: unknown) => CanaryToolEvent) | null {
  const item = corpusSnapshots.get(corpus)?.cases.get(caseId);
  return item ? canaryTools(item.item) : null;
}

/** @internal Called only by the trusted trace grader; this reveals a grade, never scorer material. */
export function gradeStoredPrivateCase(corpus: ValidatedPrivateCorpus, caseId: string,
  finalText: string, events: readonly CanaryToolEvent[]) {
  const snapshot = corpusSnapshots.get(corpus), item = snapshot?.cases.get(caseId);
  if (!item) return { state: "unavailable" as const, reason: "private-corpus-capability-unrecognized" };
  if (item.codingFixture) return { state: "unavailable" as const, reason: "coding-native-scorer-required" };
  if (typeof finalText !== "string" || Buffer.byteLength(finalText, "utf8") > 65_536 || !Array.isArray(events) || events.length > 32)
    return { state: "unavailable" as const, reason: "private-corpus-grader-input-bound" };
  try {
    const safeEvents = cloneFiniteJson(events) as CanaryToolEvent[];
    if (safeEvents.some(event => !exactKeys(event, ["name", "args", "result", "denied"])
      || typeof event.name !== "string" || typeof event.denied !== "boolean"))
      return { state: "unavailable" as const, reason: "private-corpus-trace-invalid" };
    const grade = gradeCanary(item.item, finalText, safeEvents);
    const finalGrade = gradeCanary(item.item, finalText, item.expectedToolTrace);
    const traceMatches = canonicalJson(safeEvents) === canonicalJson(item.expectedToolTrace);
    const unauthorized = safeEvents.some(event => event.denied);
    return { state: "scored" as const,
      finalPassed: finalGrade.passed,
      tracePassed: traceMatches && !unauthorized,
      passed: grade.passed && traceMatches && !unauthorized,
      schemaValid: grade.schemaValid,
      reason: unauthorized ? "unauthorized-action" : !traceMatches ? "trusted-trace-mismatch" : grade.reason };
  } catch {
    return { state: "unavailable" as const, reason: "private-corpus-scorer-error" };
  }
}
