import { createHash, createPublicKey, verify } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import type { FindingFlowRow, VerifiedFindingEvidence } from "./review-finding-outcomes.js";

/** BACKSTOP: bound private receipt ingestion and projection size; overflow remains counted. */
export const MAX_FINDING_EVIDENCE_RECEIPTS = 1_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const boundedText = z.string().min(1).max(512).refine((value) => value.trim().length > 0);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)));
const base = { version: z.literal("review-finding-evidence-v1"), findingId: boundedText,
  prUrl: z.string().max(512).regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9][0-9]*$/),
  headSha: sha, observedAt: timestamp, sourceReceipt: boundedText };
const execution = z.object({ headSha: sha, executedAt: timestamp,
  outcome: z.enum(["mechanism-failed", "passed", "execution-error", "unavailable"]) }).strict();
const payloadSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("repair"), scorerRevision: sha, caseDigest: digest, mechanismDigest: digest,
    before: execution, after: execution, repairedDescendsFromReviewed: z.boolean() }).strict(),
  z.object({ ...base, kind: z.literal("operator"), actor: boundedText,
    verdict: z.enum(["accepted", "rejected"]), reason: boundedText }).strict(),
]);
const envelopeSchema = z.object({ keyId: z.string().min(1).max(64), payload: z.string().min(1).max(8_192),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
const keysSchema = z.array(z.object({ id: z.string().min(1).max(64), role: z.enum(["scorer", "operator"]),
  subject: boundedText, publicKey: z.string().min(1).max(4_096) }).strict()).max(32);

export interface FindingEvidenceInput {
  state: "observed" | "unavailable";
  receipts: readonly unknown[];
  /** Trust anchors come from separate operator configuration, never from a receipt or a comment. */
  keys: unknown;
  reason?: string;
  unreadableSources?: number;
}
type EvidenceState = "verified" | "invalid" | "unauthenticated" | "unmatchable" | "stale-head" | "verification-failed";
export interface FindingEvidenceRecord {
  receiptDigest: string;
  state: EvidenceState;
  reason?: string;
  findingDigest?: string;
  authorityDigest?: string;
  sourceDigest?: string;
  beforeHead?: string;
  afterHead?: string;
  scorerRevision?: string;
  caseDigest?: string;
  mechanismDigest?: string;
  beforeOutcome?: string;
  afterOutcome?: string;
}
export interface FindingEvidenceReport {
  sourceState: "not-connected" | "observed" | "unavailable";
  reason: string | null;
  denominator: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  dropped: number;
  unreadableSources: number;
  records: FindingEvidenceRecord[];
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function readBoundedJson(path: string, limit: number): unknown {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      size += count;
      if (size > limit) throw new Error("finding-evidence-source-too-large");
      if (count === 0) break;
    }
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally { closeSync(fd); }
}

function sourceFailure(error: unknown): string {
  if (error instanceof SyntaxError) return "malformed-json";
  if (error instanceof Error && ["finding-evidence-source-too-large", "finding-evidence-source-invalid",
    "finding-evidence-path-missing", "finding-evidence-trust-missing", "finding-evidence-trust-invalid"].includes(error.message)) return error.message;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? `io-${code}` : `error-${hash(String(error)).slice(0, 16)}`;
}

/** Read private, independently signed execution/action receipts; verification never executes PR code. */
export function readReviewFindingEvidence(receiptsPath?: string, keysPath?: string): FindingEvidenceInput | undefined {
  if (receiptsPath === undefined && keysPath === undefined) return undefined;
  let receipts: unknown = [];
  let keys: unknown = [];
  let unreadableSources = 0;
  const failures: string[] = [];
  try {
    if (receiptsPath === undefined) throw new Error("finding-evidence-path-missing");
    receipts = readBoundedJson(receiptsPath, MAX_SOURCE_BYTES);
    if (!Array.isArray(receipts)) throw new Error("finding-evidence-source-invalid");
  } catch (error) {
    receipts = [];
    unreadableSources++;
    const reason = sourceFailure(error);
    failures.push(`receipts:${reason}`);
  }
  try {
    if (keysPath === undefined) throw new Error("finding-evidence-trust-missing");
    keys = readBoundedJson(keysPath, 64 * 1024);
    if (!keysSchema.safeParse(keys).success) throw new Error("finding-evidence-trust-invalid");
  } catch (error) {
    keys = [];
    unreadableSources++;
    const reason = sourceFailure(error);
    failures.push(`trust:${reason}`);
  }
  return { state: unreadableSources ? "unavailable" : "observed", receipts: receipts as unknown[], keys,
    unreadableSources, ...(unreadableSources ? { reason: failures.join(";") } : {}) };
}

/** Authenticate exact-head attestations from independent scorers or attributable operator actions (W1-T4928). */
export function deriveVerifiedReviewFindingEvidence(rows: readonly FindingFlowRow[], input: FindingEvidenceInput | undefined,
  asOf: string): FindingEvidenceReport & { evidence: VerifiedFindingEvidence[] } {
  const receipts = input?.receipts ?? [];
  const report: FindingEvidenceReport & { evidence: VerifiedFindingEvidence[] } = {
    sourceState: input?.state ?? "not-connected", reason: input?.reason ?? null,
    denominator: receipts.length, accepted: 0, rejected: 0, duplicates: 0,
    dropped: Math.max(0, receipts.length - MAX_FINDING_EVIDENCE_RECEIPTS),
    unreadableSources: input?.unreadableSources ?? 0, records: [], evidence: [] };
  const keys = keysSchema.safeParse(input?.keys ?? []);
  const anchors = keys.success ? keys.data : [];
  const findings = rows.filter((row) => row.step === "review.finding" && row.findingId && row.headSha);
  const seen = new Set<string>();
  for (const raw of receipts.slice(0, MAX_FINDING_EVIDENCE_RECEIPTS)) {
    const envelope = envelopeSchema.safeParse(raw);
    const receiptDigest = hash(envelope.success
      ? JSON.stringify([envelope.data.keyId, envelope.data.payload, envelope.data.signature]) : JSON.stringify(raw) ?? "null");
    if (seen.has(receiptDigest)) { report.duplicates++; continue; }
    seen.add(receiptDigest);
    const projected: FindingEvidenceRecord = { receiptDigest, state: "invalid" };
    report.records.push(projected);
    if (!envelope.success) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(envelope.data.payload); }
    catch (error) {
      const reason = sourceFailure(error);
      Object.assign(projected, { state: "invalid", reason });
      continue;
    }
    const payload = payloadSchema.safeParse(parsed);
    if (!payload.success) continue;
    const value = payload.data;
    projected.findingDigest = hash(`${value.findingId}|${value.prUrl}|${value.headSha}`);
    projected.sourceDigest = hash(value.sourceReceipt);
    projected.state = "unauthenticated";
    const matchingKeys = anchors.filter((key) => key.id === envelope.data.keyId);
    if (matchingKeys.length !== 1) continue;
    const key = matchingKeys[0]!;
    if (key.role !== (value.kind === "repair" ? "scorer" : "operator") ||
      (value.kind === "operator" && key.subject !== value.actor)) continue;
    try {
      const publicKey = createPublicKey(key.publicKey);
      if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(envelope.data.payload), publicKey,
        Buffer.from(envelope.data.signature, "base64"))) continue;
    } catch (error) {
      const reason = sourceFailure(error);
      Object.assign(projected, { state: "unauthenticated", reason });
      continue;
    }
    projected.authorityDigest = hash(`${key.id}|${key.role}|${key.subject}|${key.publicKey}`);
    const named = findings.filter((row) => row.findingId === value.findingId &&
      `https://github.com/${row.prRepo}/pull/${row.prNumber}` === value.prUrl);
    const exact = named.find((row) => row.headSha === value.headSha);
    if (!exact) { projected.state = named.length ? "stale-head" : "unmatchable"; continue; }
    projected.state = "verification-failed";
    const observedAt = Date.parse(value.observedAt);
    if (!Number.isFinite(Date.parse(asOf)) || observedAt > Date.parse(asOf) ||
      exact.ts === null || !Number.isFinite(Date.parse(exact.ts)) || observedAt < Date.parse(exact.ts) || exact.findingAnchorStatus !== "verified") continue;
    const common = { findingId: value.findingId, prUrl: value.prUrl, headSha: value.headSha, observedAt: value.observedAt };
    if (value.kind === "repair") {
      Object.assign(projected, { beforeHead: value.before.headSha, afterHead: value.after.headSha,
        scorerRevision: value.scorerRevision, caseDigest: value.caseDigest, mechanismDigest: value.mechanismDigest,
        beforeOutcome: value.before.outcome, afterOutcome: value.after.outcome });
      if (value.before.headSha !== value.headSha || value.after.headSha === value.headSha || !value.repairedDescendsFromReviewed ||
        value.before.outcome !== "mechanism-failed" || value.after.outcome !== "passed" ||
        Date.parse(value.before.executedAt) < Date.parse(exact.ts) ||
        Date.parse(value.after.executedAt) <= Date.parse(value.before.executedAt) || Date.parse(value.after.executedAt) > observedAt) continue;
      report.evidence.push({ ...common, kind: "mechanism-falsifier", beforeFails: true, afterPasses: true,
        mechanismMatched: true, provenance: `scorer-verified:${receiptDigest}` });
    } else {
      report.evidence.push({ ...common, kind: value.verdict === "accepted" ? "human-acceptance" : "human-rejection",
        reason: hash(value.reason), provenance: `github-verified:operator:${projected.authorityDigest}:${receiptDigest}` });
    }
    projected.state = "verified";
    report.accepted++;
  }
  report.rejected = report.denominator - report.accepted - report.duplicates;
  return report;
}
