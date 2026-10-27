import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { InflightLockError, withInflightLock } from "./inflight-lock.js";
import { ProductIntentStore } from "./product-intent-store.js";
import { productIdSchema, productRequestIdSchema, type ProductStoreCode, type StoredProduct } from "./product-intent.js";

export const PRODUCT_EVALUATION_VERSION = "product-evaluation-v1" as const;
/**
 * PRIMARY CONTROL: maintained quotas. A proposal may ask for at most this many pull requests and
 * never more spend than the product's own resource envelope; none of it grants execution authority.
 */
export const PRODUCT_EVALUATION_LIMITS = { requestBytes: 16 * 1024, operations: 256, stateBytes: 2 * 1024 * 1024, holdouts: 32, pullRequests: 3 } as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const score = z.number().finite().min(0).max(1);
const version = text(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const httpsUrl = z.string().max(2048).url().refine((value) => URL.canParse(value) && new URL(value).protocol === "https:" && !new URL(value).username && !new URL(value).password);

const versionsSchema = z.object({ objectiveVersion: version, evaluatorVersion: version }).strict();
const holdoutCommand = z.object({ kind: z.enum(["geography", "device"]), id: text(64), baseline: score.nullable(), candidate: score.nullable() }).strict();
const evidenceCommand = z.object({ channel: z.enum(["replay", "bot", "device"]), reference: httpsUrl }).strict();
const proposalCommand = z.object({
  summary: text(500), pullRequests: z.number().int().min(0).max(PRODUCT_EVALUATION_LIMITS.pullRequests),
  costUsd: z.number().finite().min(0).max(10_000),
}).strict();

/** The held-out objective and evaluator are declared once; baseline and candidate must both be measured against exactly them. */
export const productEvaluationCommandSchema = z.object({
  version: z.literal(PRODUCT_EVALUATION_VERSION), requestId: productRequestIdSchema, productId: productIdSchema,
  expectedRevision: revision, expectedObjectiveRevision: revision,
  objective: versionsSchema, baseline: versionsSchema, candidate: versionsSchema,
  holdouts: z.array(holdoutCommand).min(1).max(PRODUCT_EVALUATION_LIMITS.holdouts)
    .refine((cells) => new Set(cells.map((cell) => `${cell.kind}:${cell.id}`)).size === cells.length),
  evidence: z.array(evidenceCommand).max(16), proposal: proposalCommand,
}).strict();

const outcome = z.enum(["held", "regressed", "unknown"]);
const refusalCode = z.enum(["objective_changed", "holdout_failed"]);
/** Bots prove geometry and rule invariants only; every human or physical judgement stays its own unverified field. */
const acceptanceSchema = z.object({
  humanFun: z.literal("unverified"), recognizableGeography: z.literal("unverified"),
  originality: z.literal("unverified"), physicalDevice: z.literal("unverified"),
}).strict();
export const productEvaluationReceiptSchema = z.object({
  operationId: z.string().regex(/^peval_[a-f0-9]{64}$/), productId: productIdSchema, objectiveRevision: revision,
  objective: versionsSchema, baseline: versionsSchema, candidate: versionsSchema,
  holdouts: z.array(holdoutCommand.extend({ outcome })).min(1).max(PRODUCT_EVALUATION_LIMITS.holdouts),
  coverage: z.object({ geography: outcome, device: outcome }).strict(), confidence: score,
  verdict: z.enum(["reviewable", "unknown", "refused"]), refusal: refusalCode.optional(),
  evidence: z.array(evidenceCommand).max(16), proposal: proposalCommand.extend({ state: z.literal("proposed") }).strict(),
  acceptance: acceptanceSchema, executionAuthority: z.literal("none"), autoDeploy: z.literal(false), deployed: z.literal(false),
  recordedAt: instant, payloadDigest: digestSchema,
}).strict().refine((value) => (value.verdict === "refused") === (value.refusal !== undefined));
const journalSchema = z.object({
  version: z.literal(PRODUCT_EVALUATION_VERSION), ownerKey: digestSchema, operations: z.record(digestSchema, productEvaluationReceiptSchema),
}).strict().refine((value) => Object.keys(value.operations).length <= PRODUCT_EVALUATION_LIMITS.operations);

export type ProductEvaluationCommand = z.infer<typeof productEvaluationCommandSchema>;
export type ProductEvaluationReceipt = z.infer<typeof productEvaluationReceiptSchema>;
type Journal = z.infer<typeof journalSchema>;
type Outcome = z.infer<typeof outcome>;
export type ProductEvaluationCode = ProductStoreCode | "objective_changed" | "holdout_failed" | "budget_exceeded";
export type ProductEvaluationResult =
  | { ok: true; value: { receipt: ProductEvaluationReceipt; replayed: boolean }; code?: never }
  | { ok: false; code: ProductEvaluationCode; value?: never };

class Fault extends RmdError {
  constructor(readonly code: ProductEvaluationCode) { super("usage", GENERIC_EXIT_CODE, `product evaluation: ${code}`); }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const errno = (error: unknown, code: string) => (error as NodeJS.ErrnoException | undefined)?.code === code;
const sameVersions = (a: z.infer<typeof versionsSchema>, b: z.infer<typeof versionsSchema>) =>
  a.objectiveVersion === b.objectiveVersion && a.evaluatorVersion === b.evaluatorVersion;

/** A missing measurement is unknown: never zero, never a pass. A regression is the only failure. */
function judgeCell(cell: { baseline: number | null; candidate: number | null }): Outcome {
  if (cell.baseline === null || cell.candidate === null) return "unknown";
  return cell.candidate < cell.baseline ? "regressed" : "held";
}
function judgeKind(cells: { outcome: Outcome }[]): Outcome {
  if (cells.some((cell) => cell.outcome === "regressed")) return "regressed";
  return cells.length === 0 || cells.some((cell) => cell.outcome === "unknown") ? "unknown" : "held";
}

/** Pure comparison. It cannot widen the budget, loosen a gate, or turn a failure into a pass. */
export function evaluateProductImprovement(
  input: ProductEvaluationCommand, product: Pick<StoredProduct, "objectiveRevision" | "brief">, operationId: string, payloadDigest: string, recordedAt: string,
): ProductEvaluationReceipt {
  const holdouts = input.holdouts.map((cell) => ({ ...cell, outcome: judgeCell(cell) }));
  const coverage = { geography: judgeKind(holdouts.filter((cell) => cell.kind === "geography")), device: judgeKind(holdouts.filter((cell) => cell.kind === "device")) };
  const measured = holdouts.filter((cell) => cell.outcome !== "unknown").length;
  const changed = !sameVersions(input.baseline, input.objective) || !sameVersions(input.candidate, input.objective);
  const failed = coverage.geography === "regressed" || coverage.device === "regressed";
  const refusal = changed ? "objective_changed" as const : failed ? "holdout_failed" as const : undefined;
  const verdict = refusal ? "refused" as const : coverage.geography === "held" && coverage.device === "held" ? "reviewable" as const : "unknown" as const;
  return productEvaluationReceiptSchema.parse({
    operationId, productId: input.productId, objectiveRevision: product.objectiveRevision,
    objective: input.objective, baseline: input.baseline, candidate: input.candidate, holdouts, coverage,
    confidence: Math.round((measured / holdouts.length) * 1000) / 1000, verdict, ...(refusal ? { refusal } : {}),
    evidence: input.evidence, proposal: { ...input.proposal, state: "proposed" },
    acceptance: { humanFun: "unverified", recognizableGeography: "unverified", originality: "unverified", physicalDevice: "unverified" },
    executionAuthority: "none", autoDeploy: false, deployed: false, recordedAt, payloadDigest,
  });
}

export interface ProductEvaluationOptions {
  root?: string;
  clock?: Clock;
  sync?: (fd: number) => void;
  store?: ProductIntentStore;
}

type Paths = { root: string; directory: string; state: string; locks: string; ownerKey: string };

/**
 * Records a bounded improvement proposal against an unchanged held-out objective. The comparison and
 * its failures are journaled durably; the proposal is also appended to the product's own stage
 * evidence, which is the existing review authority. Nothing here builds, spends or deploys.
 */
export class ProductEvaluationService {
  private readonly clock: Clock;
  private readonly sync: (fd: number) => void;
  private readonly intents: ProductIntentStore;

  constructor(private readonly options: ProductEvaluationOptions) {
    this.clock = options.clock ?? systemClock;
    this.sync = options.sync ?? fsyncSync;
    this.intents = options.store ?? new ProductIntentStore({ root: options.root });
  }

  execute(actor: string, command: unknown): ProductEvaluationResult {
    try {
      if (typeof actor !== "string" || !actor.trim() || actor.length > 512) throw new Fault("invalid_identity");
      const parsed = productEvaluationCommandSchema.safeParse(command);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > PRODUCT_EVALUATION_LIMITS.requestBytes) throw new Fault("invalid_input");
      const input = parsed.data;
      const paths = this.paths(actor);
      this.ensureDirectory(paths);
      return withInflightLock(paths.locks, paths.ownerKey, () => this.run(paths, actor, input), { run_id: `product-evaluation-${randomUUID()}` });
    } catch (error) {
      return { ok: false, code: error instanceof Fault ? error.code : error instanceof InflightLockError ? "busy" : "unavailable" };
    }
  }

  /** The operator's own durable proposal history for one product, oldest first. */
  history(actor: string, productId: string): { ok: true; value: ProductEvaluationReceipt[] } | { ok: false; code: ProductEvaluationCode } {
    try {
      if (typeof actor !== "string" || !actor.trim() || actor.length > 512) throw new Fault("invalid_identity");
      if (!productIdSchema.safeParse(productId).success) throw new Fault("invalid_input");
      const product = this.intents.read(actor, productId);
      if (!product.ok) throw new Fault(product.code);
      const journal = this.read(this.paths(actor));
      // The journal is append-only, so its own key order is the recorded order.
      return { ok: true, value: Object.values(journal.operations).filter((entry) => entry.productId === productId) };
    } catch (error) {
      return { ok: false, code: error instanceof Fault ? error.code : "unavailable" };
    }
  }

  private run(paths: Paths, actor: string, input: ProductEvaluationCommand): ProductEvaluationResult {
    const requestKey = digest(input.requestId);
    const payloadDigest = digest(JSON.stringify(input));
    let journal = this.read(paths);
    const existing = journal.operations[requestKey];
    if (existing && existing.payloadDigest !== payloadDigest) throw new Fault("idempotency_conflict");
    const product = this.intents.read(actor, input.productId);
    if (!product.ok) throw new Fault(product.code);
    let receipt = existing;
    if (!receipt) {
      if (product.value.revision !== input.expectedRevision || product.value.objectiveRevision !== input.expectedObjectiveRevision) throw new Fault("stale_revision");
      const budget = product.value.brief.resourceEnvelope?.budgetUsd ?? 0;
      if (input.proposal.costUsd > budget) throw new Fault("budget_exceeded");
      if (Object.keys(journal.operations).length >= PRODUCT_EVALUATION_LIMITS.operations) throw new Fault("capacity");
      receipt = evaluateProductImprovement(input, product.value, `peval_${digest(`${paths.ownerKey}:${requestKey}`)}`, payloadDigest, this.clock.iso());
      journal = { ...journal, operations: Object.fromEntries([...Object.entries(journal.operations), [requestKey, receipt] as const]) };
      this.commit(paths, journal);
    } else {
      try { this.syncDirectory(paths.directory); } catch { throw new Fault("outcome_unknown"); }
    }
    // The product transition is idempotent on requestId, so a journaled receipt whose stage evidence was lost is completed by retrying.
    const saved = this.intents.transition(actor, { version: "product-intent-v1", requestId: input.requestId, id: input.productId,
      expectedRevision: input.expectedRevision, expectedObjectiveRevision: input.expectedObjectiveRevision,
      stageEvidence: [{ id: `peval:${receipt.operationId.slice(6, 38)}`, stage: "improve",
        outcome: receipt.verdict === "reviewable" ? "proposed" : receipt.verdict === "unknown" ? "unknown" : "failed",
        objectiveRevision: receipt.objectiveRevision, observedAt: receipt.recordedAt,
        references: receipt.evidence.map((item) => ({ label: `${item.channel} evidence`, url: item.reference })) }] });
    if (!saved.ok) throw new Fault(saved.code);
    if (receipt.refusal) return { ok: false, code: receipt.refusal };
    return { ok: true, value: { receipt, replayed: existing !== undefined } };
  }

  private paths(actor: string): Paths {
    if (!this.options.root || !isAbsolute(this.options.root)) throw new Fault("unavailable");
    const root = realpathSync(this.options.root);
    const ownerKey = digest(actor);
    const directory = join(root, "state", "products", "v1", "evaluations");
    return { root, directory, state: join(directory, `${ownerKey}.json`), locks: join(directory, "locks"), ownerKey };
  }

  /** Our own directory is private and never a symlink; the product store already owns its parents. */
  private ensureDirectory(paths: Paths): void {
    try { mkdirSync(paths.directory, { mode: 0o700 }); }
    catch (error) { if (!errno(error, "EEXIST")) throw new Fault("unavailable"); }
    const info = lstatSync(paths.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Fault("unavailable");
    this.syncDirectory(dirname(paths.directory));
  }

  private syncDirectory(directory: string): void {
    const fd = openSync(directory, constants.O_RDONLY);
    try { this.sync(fd); } finally { closeSync(fd); }
  }

  private read(paths: Paths): Journal {
    let fd: number | undefined;
    try {
      fd = openSync(paths.state, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1 || (info.mode & 0o077) !== 0 || info.size > PRODUCT_EVALUATION_LIMITS.stateBytes) throw new Fault("unavailable");
      const buffer = Buffer.alloc(info.size);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      let raw: unknown;
      try { raw = size === info.size ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) : undefined; }
      catch { throw new Fault("corrupt"); }
      const parsed = journalSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerKey !== paths.ownerKey) throw new Fault("corrupt");
      return parsed.data;
    } catch (error) {
      if (errno(error, "ENOENT")) return { version: PRODUCT_EVALUATION_VERSION, ownerKey: paths.ownerKey, operations: {} };
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** Atomic replace. A failure before the rename is `unavailable`; after it, the outcome is unknowable. */
  private commit(paths: Paths, journal: Journal): void {
    const body = JSON.stringify(journal);
    if (Buffer.byteLength(body) > PRODUCT_EVALUATION_LIMITS.stateBytes) throw new Fault("capacity");
    const temporary = join(paths.directory, `.${paths.ownerKey}.${randomUUID()}.pending`);
    let renamed = false;
    try {
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); writeFileSync(fd, body, "utf8"); this.sync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, paths.state);
      renamed = true;
      this.syncDirectory(paths.directory);
    } catch {
      if (!renamed) this.discard(temporary);
      throw new Fault(renamed ? "outcome_unknown" : "unavailable");
    }
  }

  /** Removes a stage that will never be renamed; one already gone is the outcome wanted. */
  private discard(path: string): void {
    try { unlinkSync(path); } catch (cleanup) { if (!errno(cleanup, "ENOENT")) throw new Fault("unavailable"); }
  }
}
