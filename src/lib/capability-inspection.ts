import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { fixedClock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { CAPABILITY_GRANT_SCHEMA_VERSION, verifyCapabilityGrant,
  type CapabilityGrant, type CapabilityGrantReadStore, type CapabilityRefusalCode,
  type CapabilityCheckedPredicate, type CapabilityUseRequest } from "./capability-grant.js";

export const CAPABILITY_INSPECTION_MAX_CASES = 100; // PRIMARY CONTROL: bound snapshot and replay populations.
export const CAPABILITY_INSPECTION_MAX_STRING = 512; // PRIMARY CONTROL: reject overlong input fields.
export const CAPABILITY_INSPECTION_MAX_FILE_BYTES = 1024 * 1024; // PRIMARY CONTROL: cap local reads before parsing.
type SourceFailure = "missing-source" | "unreadable-source" | "malformed-source";
export type CapabilityInspectionSource = CapabilityGrantReadStore | { unavailable: SourceFailure } | null;
type InspectionCode = CapabilityRefusalCode | SourceFailure | "allow" | "invalid-request" | "invalid-clock";
type Predicates = Record<CapabilityCheckedPredicate | "repo" | "instance", "pass" | "fail" | "not-checked">;
export interface CapabilityInspectionResult {
  readonly schema: "capability-inspection-v1";
  readonly observedAt: string | null;
  readonly verdict: "allow" | "refuse" | "unknown" | "unavailable";
  readonly code: InspectionCode;
  readonly predicates: Predicates;
  readonly remainingUsesAfterHypotheticalUse?: number;
}
export interface CapabilityReplayResult {
  readonly schema: "capability-replay-v1";
  readonly observedAt: string | null;
  readonly code: "evaluated" | "invalid-cases" | "too-many-cases";
  readonly results: readonly CapabilityInspectionResult[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= CAPABILITY_INSPECTION_MAX_STRING;
}
function instant(value: unknown): string | null {
  if (!(text(value) || typeof value === "number")) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? fixedClock(ms).iso() : null;
}
function strings(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(text);
}
function validGrant(value: unknown, id: string): value is CapabilityGrant {
  if (!object(value)) return false;
  return value.schema === CAPABILITY_GRANT_SCHEMA_VERSION && value.id === id && text(value.id)
    && text(value.targetIdentity) && text(value.audience) && text(value.expiresAt) && instant(value.expiresAt) !== null
    && strings(value.operations, 100) && value.operations.length > 0
    && Number.isSafeInteger(value.useLimit) && Number(value.useLimit) > 0
    && object(value.scope) && (value.scope.repo === undefined || text(value.scope.repo))
    && (value.scope.instance === undefined || text(value.scope.instance))
    && object(value.approval) && text(value.approval.approvedBy) && text(value.approval.approvedAt) && instant(value.approval.approvedAt) !== null
    && (value.approval.reason === undefined || text(value.approval.reason))
    && object(value.redaction) && strings(value.redaction.redactFields, 100) && text(value.revocationLink);
}
function request(value: unknown): CapabilityUseRequest | null {
  if (!object(value)) return null;
  const { grantId, operation, target, audience, nonce } = value;
  return text(grantId) && text(operation) && text(target) && text(audience) && text(nonce)
    ? { grantId, operation, target, audience, nonce } : null;
}
function predicates(): Predicates {
  return { "canonical-grant": "not-checked", revoked: "not-checked", expired: "not-checked",
    "wrong-audience": "not-checked", "wrong-target": "not-checked", "operation-not-granted": "not-checked",
    "replayed-nonce": "not-checked", "use-limit-exceeded": "not-checked", repo: "not-checked", instance: "not-checked" };
}
function result(observedAt: string | null, verdict: CapabilityInspectionResult["verdict"], code: InspectionCode): CapabilityInspectionResult {
  return { schema: "capability-inspection-v1", observedAt, verdict, code, predicates: predicates() };
}
class MalformedSource extends RmdError {
  constructor() {
    super("read-model", GENERIC_EXIT_CODE, "malformed capability inspection source");
  }
}
interface CapturedGrant {
  grant: CapabilityGrant;
  revoked: boolean;
  count: number;
  nonces: Map<string, boolean>;
}

// Capture only read methods, once per grant and nonce. The verifier gets no mutation or secret seam.
function snapshot(source: CapabilityInspectionSource, cases: readonly CapabilityUseRequest[]): CapabilityInspectionSource {
  if (!source || "unavailable" in source) return source;
  const rows = new Map<string, CapturedGrant | undefined>();
  try {
    for (const input of cases) {
      if (!rows.has(input.grantId)) {
        const stored = source.get(input.grantId);
        if (stored === undefined) rows.set(input.grantId, undefined);
        else {
          if (!validGrant(stored, input.grantId)) throw new MalformedSource();
          const grant = structuredClone(stored);
          const revoked = source.isRevoked(grant.id);
          const count = source.useCount(grant.id);
          if (typeof revoked !== "boolean" || !Number.isSafeInteger(count) || count < 0) throw new MalformedSource();
          rows.set(input.grantId, { grant, revoked, count, nonces: new Map() });
        }
      }
      const row = rows.get(input.grantId);
      if (row && !row.nonces.has(input.nonce)) {
        const seen = source.hasSeenNonce(input.grantId, input.nonce);
        if (typeof seen !== "boolean") throw new MalformedSource();
        row.nonces.set(input.nonce, seen);
      }
    }
  } catch (error) {
    const reason = error instanceof MalformedSource ? "malformed-source" : "unreadable-source";
    return { unavailable: reason };
  }
  return {
    get: (id) => rows.get(id)?.grant,
    isRevoked: (id) => rows.get(id)!.revoked,
    useCount: (id) => rows.get(id)!.count,
    hasSeenNonce: (id, nonce) => rows.get(id)!.nonces.get(nonce)!,
  };
}
function evaluate(source: CapabilityInspectionSource, input: CapabilityUseRequest | null, at: string | null): CapabilityInspectionResult {
  if (at === null) return result(at, "unknown", "invalid-clock");
  if (!input) return result(at, "unknown", "invalid-request");
  if (!source) return result(at, "unavailable", "missing-source");
  if ("unavailable" in source) return result(at, "unavailable", source.unavailable);
  const checked = predicates();
  const verification = verifyCapabilityGrant(source, input, { now: at,
    onCheck: (name, passed) => { checked[name] = passed ? "pass" : "fail"; } });
  return verification.ok
    ? { ...result(at, "allow", "allow"), predicates: checked, remainingUsesAfterHypotheticalUse: verification.remainingUses }
    : { ...result(at, "refuse", verification.code), predicates: checked };
}
export function inspectCapabilityDecision(source: CapabilityInspectionSource, input: unknown, observedAt: unknown): CapabilityInspectionResult {
  const at = instant(observedAt);
  const parsed = request(input);
  return evaluate(at && parsed ? snapshot(source, [parsed]) : source, parsed, at);
}
export function replayCapabilityDecisions(source: CapabilityInspectionSource, inputs: unknown, observedAt: unknown): CapabilityReplayResult {
  const at = instant(observedAt);
  if (!Array.isArray(inputs) || inputs.length > CAPABILITY_INSPECTION_MAX_CASES) {
    return { schema: "capability-replay-v1", observedAt: at,
      code: Array.isArray(inputs) ? "too-many-cases" : "invalid-cases", results: [] };
  }
  const parsed = inputs.map(request);
  const captured = at ? snapshot(source, parsed.filter((r): r is CapabilityUseRequest => r !== null)) : source;
  return { schema: "capability-replay-v1", observedAt: at, code: "evaluated",
    results: parsed.map((input) => evaluate(captured, input, at)) };
}
export function compareCapabilityReplays(baseline: CapabilityReplayResult, candidate: CapabilityReplayResult): {
  schema: "capability-comparison-v1"; changes: ("changed" | "unchanged" | "incomparable")[];
} {
  const length = Math.min(CAPABILITY_INSPECTION_MAX_CASES, Math.max(baseline.results.length, candidate.results.length));
  return { schema: "capability-comparison-v1", changes: Array.from({ length }, (_, index) => {
    const left = baseline.results[index];
    const right = candidate.results[index];
    if (baseline.code !== "evaluated" || candidate.code !== "evaluated" || !left || !right
      || left.verdict === "unknown" || left.verdict === "unavailable"
      || right.verdict === "unknown" || right.verdict === "unavailable") return "incomparable";
    return left.verdict === right.verdict && left.code === right.code ? "unchanged" : "changed";
  }) };
}

export type InspectionJson = { ok: true; value: unknown } | { ok: false; code: SourceFailure };
export function readInspectionJson(path: string): InspectionJson {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > CAPABILITY_INSPECTION_MAX_FILE_BYTES) throw new MalformedSource();
    const buffer = Buffer.alloc(CAPABILITY_INSPECTION_MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > CAPABILITY_INSPECTION_MAX_FILE_BYTES) throw new MalformedSource();
    return { ok: true, value: JSON.parse(buffer.subarray(0, size).toString("utf8")) as unknown };
  } catch (error) {
    return { ok: false, code: error instanceof SyntaxError || error instanceof MalformedSource ? "malformed-source"
      : object(error) && error.code === "ENOENT" ? "missing-source" : "unreadable-source" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// An operator-selected canonical export is separate from request files; this adapter never persists it.
export function loadCapabilityInspectionSource(path: string): CapabilityInspectionSource {
  const read = readInspectionJson(path);
  if (!read.ok) return { unavailable: read.code };
  const value = read.value;
  if (!object(value) || value.schema !== "capability-inspection-source-v1"
    || !Array.isArray(value.grants) || value.grants.length > CAPABILITY_INSPECTION_MAX_CASES) {
    return { unavailable: "malformed-source" };
  }
  const rows = new Map<string, { grant: CapabilityGrant; revoked: boolean; count: number; nonces: Set<string> }>();
  for (const row of value.grants) {
    if (!object(row) || !object(row.grant) || !text(row.grant.id) || !validGrant(row.grant, row.grant.id)
      || rows.has(row.grant.id) || typeof row.revoked !== "boolean"
      || !Number.isSafeInteger(row.useCount) || Number(row.useCount) < 0 || !strings(row.nonces, 1000)) {
      return { unavailable: "malformed-source" };
    }
    rows.set(row.grant.id, { grant: row.grant, revoked: row.revoked, count: Number(row.useCount), nonces: new Set(row.nonces) });
  }
  return { get: (id) => rows.get(id)?.grant, isRevoked: (id) => rows.get(id)!.revoked,
    useCount: (id) => rows.get(id)!.count, hasSeenNonce: (id, nonce) => rows.get(id)!.nonces.has(nonce) };
}
