import { createHash } from "node:crypto";
import { z } from "zod";

export const PRODUCT_INTENT_VERSION = "product-intent-v1" as const;
/** PRIMARY CONTROL: maintained storage and transport quotas; these grant no execution or provider authority. */
export const PRODUCT_INTENT_LIMITS = {
  requestBytes: 64 * 1024, productBytes: 24 * 1024, stateBytes: 4 * 1024 * 1024,
  products: 64, requests: 4096, history: 128,
} as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const productIdSchema = z.string().regex(/^prd_[a-f0-9]{32}$/);
export const productRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const instant = z.string().datetime();
const repositoryName = text(100).regex(/^[A-Za-z0-9_.-]+$/).refine((value) => value !== "." && value !== "..");
const repositoryOwner = text(39).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
const httpUrl = z.string().max(2048).url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password &&
    ![...url.searchParams.keys()].some((key) => /^(token|access_token|api_key|x-vercel-protection-bypass)$/i.test(key));
});

/** Requested facts remain proposals. Verified repository and stage evidence are not writable here. */
export const productBriefSchema = z.object({
  idea: text(6000),
  name: text(80).optional(),
  portfolio: text(120).optional(),
  objective: text(2000).optional(),
  constraints: z.array(text(500)).max(24).optional(),
  decisions: z.array(z.object({
    key: text(80), value: text(2000),
    provenance: z.object({ kind: z.enum(["operator", "research", "recommendation"]), reference: text(500).optional() }).strict(),
  }).strict()).max(32).optional(),
  research: z.array(z.object({ label: text(120), url: httpUrl }).strict()).max(16).optional(),
  requestedRepository: z.object({ owner: repositoryOwner, name: repositoryName }).strict().optional(),
  resourceEnvelope: z.object({
    budgetUsd: z.number().finite().positive().max(10_000),
    maxConcurrentBuilds: z.number().int().min(1).max(16), existingSetupOnly: z.boolean(),
  }).strict().optional(),
}).strict();

export const productWriteSchema = z.object({
  version: z.literal(PRODUCT_INTENT_VERSION), requestId: productRequestIdSchema,
  id: productIdSchema.optional(), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  brief: productBriefSchema,
}).strict().refine((value) => value.id !== undefined || value.expectedRevision === 0);

const repositoryIdentitySchema = z.object({
  provider: z.literal("github"), id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  owner: repositoryOwner, name: repositoryName, defaultBranch: text(255),
  visibility: z.enum(["public", "private", "internal"]), verifiedAt: instant,
}).strict();
export const productEvidenceOutcomeSchema = z.enum(["proposed", "queued", "admitted", "running", "succeeded", "failed", "unknown", "blocked"]);
const runReceiptFields = {
  actor: text(512), productId: productIdSchema, objectiveRevision: revision,
  operationId: z.string().regex(/^pbuild_[a-f0-9]{64}$/), runId: text(160), taskId: text(120),
  repository: z.object({ id: revision, owner: repositoryOwner, name: repositoryName }).strict(),
  head: z.string().regex(/^(?:[a-f0-9]{40}|unknown)$/),
  execution: z.enum(["running", "ended", "silent", "unknown"]),
};
export const localQualificationSchema = z.object({
  producer: z.enum(["core-author", "consumer", "unavailable"]),
  verdict: z.enum(["passed", "failed", "partial", "unknown"]),
  tests: z.number().int().nonnegative(), suites: z.number().int().nonnegative(),
  reason: text(500), originalVerdict: text(80).optional(),
  reference: text(160).optional(), digest: hash.optional(),
}).strict();
export const productRunReceiptSchema = z.discriminatedUnion("channel", [
  z.object({ ...runReceiptFields, channel: z.literal("local"), qualification: localQualificationSchema }).strict(),
  z.object({ ...runReceiptFields, channel: z.literal("hosted"),
    contexts: z.array(z.object({ name: text(255), conclusion: text(80) }).strict()).max(99),
    review: z.enum(["success", "failure", "pending", "absent", "unknown"]),
    reason: text(500),
  }).strict(),
]);
export type ProductRunReceipt = z.infer<typeof productRunReceiptSchema>;
export type LocalQualification = z.infer<typeof localQualificationSchema>;
const stageEvidenceSchema = z.object({
  id: text(128), stage: z.enum(["research", "repository", "plan", "build", "review", "deploy", "improve"]),
  outcome: productEvidenceOutcomeSchema,
  objectiveRevision: revision, observedAt: instant,
  references: z.array(z.object({ label: text(120), url: httpUrl }).strict()).max(16),
  receipt: productRunReceiptSchema.optional(),
}).strict();

/** Trusted mechanisms only: never reachable from the browser brief schema; grants no execution authority. */
export const productTransitionSchema = z.object({
  version: z.literal(PRODUCT_INTENT_VERSION), requestId: productRequestIdSchema, id: productIdSchema,
  expectedRevision: revision, expectedObjectiveRevision: revision,
  repository: repositoryIdentitySchema.optional(),
  stageEvidence: z.array(stageEvidenceSchema).min(1).max(16).optional(),
}).strict().refine((value) => value.repository !== undefined || value.stageEvidence !== undefined);

export const storedProductSchema = z.object({
  version: z.literal(PRODUCT_INTENT_VERSION), id: productIdSchema, revision, objectiveRevision: revision,
  createdAt: instant, updatedAt: instant, brief: productBriefSchema,
  repository: repositoryIdentitySchema.nullable(), stageEvidence: z.array(stageEvidenceSchema).max(128),
  executionAuthority: z.literal("none"),
}).strict().refine((value) => value.objectiveRevision <= value.revision);

export const productReceiptSchema = z.object({
  operationId: z.string().regex(/^pwrite_[a-f0-9]{64}$/), productId: productIdSchema,
  revision, objectiveRevision: revision, savedAt: instant, payloadDigest: hash, recordDigest: hash,
}).strict();

export const productOwnerStateSchema = z.object({
  version: z.literal(PRODUCT_INTENT_VERSION), ownerKey: hash,
  products: z.record(productIdSchema, storedProductSchema), receipts: z.record(hash, productReceiptSchema),
}).strict().superRefine((state, context) => {
  if (Object.keys(state.products).length > PRODUCT_INTENT_LIMITS.products || Object.keys(state.receipts).length > PRODUCT_INTENT_LIMITS.requests) {
    context.addIssue({ code: "custom", message: "product state exceeds its collection budget" });
  }
  for (const [id, product] of Object.entries(state.products)) {
    if (id !== product.id) context.addIssue({ code: "custom", message: "product identity mismatch" });
  }
  const latest = new Map<string, ProductReceipt>();
  const revisions = new Set<string>();
  for (const receipt of Object.values(state.receipts)) {
    const product = state.products[receipt.productId];
    if (!product || receipt.revision > product.revision || receipt.objectiveRevision > product.objectiveRevision) {
      context.addIssue({ code: "custom", message: "product receipt has no matching revision" });
    }
    const revisionKey = `${receipt.productId}:${receipt.revision}`;
    if (revisions.has(revisionKey)) context.addIssue({ code: "custom", message: "duplicate product revision receipt" });
    revisions.add(revisionKey);
    if (product && receipt.revision === product.revision) latest.set(receipt.productId, receipt);
  }
  for (const product of Object.values(state.products)) {
    if (latest.get(product.id)?.recordDigest !== productRecordDigest(product)) {
      context.addIssue({ code: "custom", message: "product revision does not match its durable receipt" });
    }
  }
});

export type ProductBrief = z.infer<typeof productBriefSchema>;
export type ProductWrite = z.infer<typeof productWriteSchema>;
export type ProductTransition = z.infer<typeof productTransitionSchema>;
export type StoredProduct = z.infer<typeof storedProductSchema>;
export type ProductReceipt = z.infer<typeof productReceiptSchema>;
export type ProductOwnerState = z.infer<typeof productOwnerStateSchema>;
export function productRecordDigest(product: StoredProduct): string {
  return createHash("sha256").update(JSON.stringify(product)).digest("hex");
}
export type ProductProjection = StoredProduct & { history: ProductReceipt[] };
export type ProductSummary = Pick<StoredProduct, "id" | "revision" | "objectiveRevision" | "createdAt" | "updatedAt"> & { name: string; portfolio?: string };
export type ProductStoreCode = "invalid_identity" | "invalid_input" | "not_found" | "stale_revision" | "idempotency_conflict" | "capacity" | "busy" | "corrupt" | "unavailable" | "outcome_unknown" | "recovery_required";
export type ProductResult<T> = { ok: true; value: T; code?: never } | { ok: false; code: ProductStoreCode; value?: never };
