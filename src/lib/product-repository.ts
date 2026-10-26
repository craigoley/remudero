import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { ghTextAsync } from "./github-transport.js";
import { acquireInflightLock, InflightLockError } from "./inflight-lock.js";
import { ProductIntentStore } from "./product-intent-store.js";
import { productIdSchema, productRequestIdSchema, productTransitionSchema, type ProductStoreCode } from "./product-intent.js";

export const PRODUCT_REPOSITORY_VERSION = "product-repository-v1" as const;
/** PRIMARY CONTROL: maintained quotas; none of them grants a provider or execution authority. */
export const PRODUCT_REPOSITORY_LIMITS = { requestBytes: 4 * 1024, operations: 256, stateBytes: 1024 * 1024 } as const;

const repositoryOwner = z.string().min(1).max(39).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
const repositoryName = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine((value) => value !== "." && value !== "..");
const instant = z.string().datetime();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const visibility = z.enum(["public", "private"]);
const repositoryId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** The exact action: adoption names the provider repository ID; creation names the visibility. */
export const productRepositoryCommandSchema = z.object({
  version: z.literal(PRODUCT_REPOSITORY_VERSION), requestId: productRequestIdSchema, productId: productIdSchema,
  action: z.enum(["adopt", "create"]), owner: repositoryOwner, name: repositoryName, visibility,
  repositoryId: repositoryId.optional(),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  expectedObjectiveRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict().refine((value) => (value.action === "adopt") === (value.repositoryId !== undefined));

const identitySchema = z.object({
  provider: z.literal("github"), id: repositoryId, owner: repositoryOwner, name: repositoryName,
  defaultBranch: z.string().min(1).max(255), visibility: z.enum(["public", "private", "internal"]), verifiedAt: instant,
}).strict();
export const productRepositoryReceiptSchema = z.object({
  operationId: z.string().regex(/^prepo_[a-f0-9]{64}$/), productId: productIdSchema,
  action: z.enum(["adopt", "create"]), outcome: z.enum(["adopted", "created"]),
  repository: identitySchema, completedAt: instant, payloadDigest: digestSchema,
  objectiveRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const operationSchema = z.object({
  operationId: z.string().regex(/^prepo_[a-f0-9]{64}$/), payloadDigest: digestSchema, productId: productIdSchema,
  action: z.enum(["adopt", "create"]), owner: repositoryOwner, name: repositoryName, visibility,
  phase: z.enum(["intent", "complete"]), recordedAt: instant, receipt: productRepositoryReceiptSchema.optional(),
  canonicalTransition: productTransitionSchema.optional(),
}).strict().refine((value) => (value.phase === "complete") === (value.receipt !== undefined));
const journalSchema = z.object({
  version: z.literal(PRODUCT_REPOSITORY_VERSION), ownerKey: digestSchema, operations: z.record(digestSchema, operationSchema),
}).strict().refine((value) => Object.keys(value.operations).length <= PRODUCT_REPOSITORY_LIMITS.operations);

export type ProductRepositoryCommand = z.infer<typeof productRepositoryCommandSchema>;
export type ProductRepositoryReceipt = z.infer<typeof productRepositoryReceiptSchema>;
type Operation = z.infer<typeof operationSchema>;
type Journal = z.infer<typeof journalSchema>;
export type ProductRepositoryCode = ProductStoreCode
  | "repository_not_found" | "repository_conflict"
  | "idempotency_conflict" | "creation_denied" | "capacity" | "busy" | "corrupt" | "unavailable"
  | "provider_unreadable" | "outcome_unknown";
export type ProductRepositoryResult =
  | { ok: true; value: { receipt: ProductRepositoryReceipt; replayed: boolean }; code?: never }
  | { ok: false; code: ProductRepositoryCode; value?: never };

export interface ProviderRepository { id: number; owner: string; name: string; defaultBranch: string; visibility: "public" | "private" | "internal" }
export type ProviderRead = { state: "found"; repository: ProviderRepository } | { state: "absent" } | { state: "unreadable" };
export type ProviderCapability = "user" | "org" | "denied" | "unknown";
/** The creation response is never trusted: the service reads the repository back before it records anything. */
export interface ProductRepositoryProvider {
  read(owner: string, name: string): Promise<ProviderRead>;
  capability(owner: string): Promise<ProviderCapability>;
  create(spec: { owner: string; name: string; visibility: "public" | "private"; scope: "user" | "org" }): Promise<void>;
}
/** Thrown by a provider that was told, unambiguously, that creation is not permitted. */
export class ProviderDenied extends RmdError {
  constructor(message: string) { super("github", GENERIC_EXIT_CODE, message); }
}

type GhText = (args: string[], opts?: { maxBuffer?: number; timeout?: number }) => Promise<string>;
const httpStatus = (error: unknown): number | undefined => {
  const detail = error as { stderr?: unknown; message?: unknown } | undefined;
  const text = `${String(detail?.stderr ?? "")}\n${String(detail?.message ?? "")}`;
  const match = /\(HTTP (\d{3})\)|\bHTTP (\d{3})\b/.exec(text);
  return match ? Number(match[1] ?? match[2]) : undefined;
};
const providerRepositorySchema = z.object({
  id: repositoryId, name: repositoryName, owner: z.object({ login: repositoryOwner }),
  private: z.boolean(), visibility: z.enum(["public", "private", "internal"]).optional(), default_branch: z.string().min(1).max(255),
});

/** The production provider: the existing paced, bounded `gh` transport, with no second GitHub client. */
export function ghProductRepositoryProvider(text: GhText = ghTextAsync): ProductRepositoryProvider {
  const options = { maxBuffer: 1024 * 1024, timeout: 20_000 };
  const viewer = async (): Promise<string | undefined> => {
    try {
      const parsed = z.object({ login: repositoryOwner }).safeParse(JSON.parse(await text(["api", "user"], options)));
      return parsed.success ? parsed.data.login : undefined;
    } catch {
      // An unreadable viewer is surfaced as an unknown capability by the caller, never as a denial.
      return undefined;
    }
  };
  return {
    async read(owner, name) {
      try {
        const parsed = providerRepositorySchema.safeParse(JSON.parse(await text(["api", `repos/${owner}/${name}`], options)));
        if (!parsed.success) return { state: "unreadable" };
        const { id, name: canonical, owner: { login }, default_branch: defaultBranch } = parsed.data;
        return { state: "found", repository: { id, owner: login, name: canonical, defaultBranch,
          visibility: parsed.data.visibility ?? (parsed.data.private ? "private" : "public") } };
      } catch (error) {
        const reason = httpStatus(error) === 404 ? "absent" : "unreadable";
        return reason === "absent" ? { state: "absent" } : { state: "unreadable" };
      }
    },
    async capability(owner) {
      const login = await viewer();
      if (login === undefined) return "unknown";
      if (login.toLowerCase() === owner.toLowerCase()) return "user";
      try {
        const parsed = z.object({ state: z.string() }).safeParse(JSON.parse(await text(["api", `user/memberships/orgs/${owner}`], options)));
        return parsed.success && parsed.data.state === "active" ? "org" : "denied";
      } catch (error) {
        const status = httpStatus(error);
        return status === 403 || status === 404 ? "denied" : "unknown";
      }
    },
    async create({ owner, name, visibility: wanted, scope }) {
      try {
        await text(["api", "-X", "POST", scope === "user" ? "user/repos" : `orgs/${owner}/repos`, "-f", `name=${name}`,
          "-F", `private=${wanted === "private"}`], options);
      } catch (error) {
        const status = httpStatus(error);
        if (status === 401 || status === 403) throw new ProviderDenied(`repository creation refused (HTTP ${status})`);
        throw error;
      }
    },
  };
}

class Fault extends RmdError {
  constructor(readonly code: ProductRepositoryCode) { super("usage", GENERIC_EXIT_CODE, `product repository: ${code}`); }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const errno = (error: unknown, code: string) => (error as NodeJS.ErrnoException | undefined)?.code === code;

/** Creates, writes and flushes a fresh 0600 stage through its one exclusive descriptor. */
function writeStage(path: string, body: string, sync: (fd: number) => void): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, body, "utf8"); sync(fd); }
  finally { closeSync(fd); }
}
/** Removes a stage that will never be renamed; one already gone is the outcome wanted. */
function discardStage(path: string): void {
  try { unlinkSync(path); } catch (cleanup) { if (!errno(cleanup, "ENOENT")) throw new Fault("unavailable"); }
}

export interface ProductRepositoryOptions {
  root?: string;
  provider?: ProductRepositoryProvider;
  clock?: Clock;
  sync?: (fd: number) => void;
  store?: ProductIntentStore;
}

const chains = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tail = next.catch(() => undefined /* the caller awaits `next` and sees the failure; the tail only orders the chain */);
  chains.set(key, tail);
  try { return await next; }
  finally { if (chains.get(key) === tail) chains.delete(key); }
}

/**
 * Create-or-adopt the product's exact GitHub repository. The intent is journaled and fsynced BEFORE
 * the one create call, so a lost response is reconciled by reading the provider, never by a second
 * POST. Nothing here ever deletes a repository to compensate for anything.
 */
export class ProductRepositoryService {
  private readonly provider: ProductRepositoryProvider;
  private readonly clock: Clock;
  private readonly sync: (fd: number) => void;
  private readonly intents: ProductIntentStore;

  constructor(private readonly options: ProductRepositoryOptions) {
    this.provider = options.provider ?? ghProductRepositoryProvider();
    this.clock = options.clock ?? systemClock;
    this.sync = options.sync ?? fsyncSync;
    this.intents = options.store ?? new ProductIntentStore({ root: options.root });
  }

  async execute(actor: string, command: unknown): Promise<ProductRepositoryResult> {
    try {
      if (typeof actor !== "string" || !actor.trim() || actor.length > 512) throw new Fault("invalid_identity");
      const parsed = productRepositoryCommandSchema.safeParse(command);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > PRODUCT_REPOSITORY_LIMITS.requestBytes) throw new Fault("invalid_input");
      const input = parsed.data;
      const product = this.intents.read(actor, input.productId);
      if (!product.ok) throw new Fault(product.code);
      const requested = product.value.brief.requestedRepository;
      if (requested && (requested.owner.toLowerCase() !== input.owner.toLowerCase() || requested.name.toLowerCase() !== input.name.toLowerCase())) {
        throw new Fault("repository_conflict");
      }
      const paths = this.paths(actor);
      return await serialized(paths.ownerKey, async () => {
        this.ensureDirectory(paths);
        const handle = this.lock(paths);
        try {
          const value = await this.run(paths, input, actor);
          this.recordCanonical(paths, input, value.receipt, actor);
          return { ok: true as const, value };
        }
        finally { handle.release(); }
      });
    } catch (error) {
      return { ok: false, code: error instanceof Fault ? error.code : error instanceof InflightLockError ? "busy" : "unavailable" };
    }
  }

  private lock(paths: ReturnType<ProductRepositoryService["paths"]>) {
    try { return acquireInflightLock(paths.locks, paths.ownerKey, { run_id: `product-repository-${randomUUID()}` }); }
    catch (error) { if (error instanceof InflightLockError) throw error; throw new Fault("unavailable"); }
  }

  private paths(actor: string) {
    if (!this.options.root || !isAbsolute(this.options.root)) throw new Fault("unavailable");
    const root = realpathSync(this.options.root);
    const ownerKey = digest(actor);
    const directory = join(root, "state", "products", "v1", "repositories");
    return { root, directory, state: join(directory, `${ownerKey}.json`), locks: join(directory, "locks"), ownerKey };
  }

  /** Each level is qualified through ONE no-follow descriptor, never checked and then re-used by name. */
  private ensureDirectory(paths: ReturnType<ProductRepositoryService["paths"]>): void {
    const parts = ["state", "products", "v1", "repositories"];
    for (const [index, directory] of parts.map((_, at) => join(paths.root, ...parts.slice(0, at + 1))).entries()) {
      const owned = index > 0;
      let created = false;
      if (owned) {
        try { mkdirSync(directory, { mode: 0o700 }); created = true; }
        catch (error) { if (!errno(error, "EEXIST")) throw error; }
      } else { mkdirSync(directory, { recursive: true }); }
      const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (created) fchmodSync(fd, 0o700);
        const info = fstatSync(fd);
        if (!info.isDirectory() || (owned && (info.mode & 0o077) !== 0)) throw new Fault("unavailable");
      } finally { closeSync(fd); }
      this.syncDirectory(dirname(directory));
    }
  }

  private syncDirectory(directory: string): void {
    const fd = openSync(directory, constants.O_RDONLY);
    try { this.sync(fd); } finally { closeSync(fd); }
  }

  private read(paths: ReturnType<ProductRepositoryService["paths"]>): Journal {
    let fd: number | undefined;
    try {
      fd = openSync(paths.state, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1 || (info.mode & 0o077) !== 0 || info.size > PRODUCT_REPOSITORY_LIMITS.stateBytes) throw new Fault("unavailable");
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
      if (errno(error, "ENOENT")) return { version: PRODUCT_REPOSITORY_VERSION, ownerKey: paths.ownerKey, operations: {} };
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** Atomic replace. A failure before the rename is `unavailable`; after it, the result is unknowable. */
  private commit(paths: ReturnType<ProductRepositoryService["paths"]>, journal: Journal): void {
    const body = JSON.stringify(journal);
    if (Buffer.byteLength(body) > PRODUCT_REPOSITORY_LIMITS.stateBytes) throw new Fault("capacity");
    const temporary = join(paths.directory, `.${paths.ownerKey}.${randomUUID()}.pending`);
    let renamed = false;
    try {
      writeStage(temporary, body, this.sync);
      renameSync(temporary, paths.state);
      renamed = true;
      this.syncDirectory(paths.directory);
    } catch (error) {
      if (!renamed) discardStage(temporary);
      throw new Fault(renamed ? "outcome_unknown" : "unavailable");
    }
  }

  private persist(paths: ReturnType<ProductRepositoryService["paths"]>, journal: Journal, key: string, operation: Operation | undefined): Journal {
    const operations = Object.fromEntries([...Object.entries(journal.operations).filter(([existing]) => existing !== key),
      ...(operation ? [[key, operation] as const] : [])]);
    const next = { ...journal, operations };
    this.commit(paths, next);
    return next;
  }

  /** Journal the exact canonical input before applying it, so an unknown acknowledgement replays durably. */
  private recordCanonical(paths: ReturnType<ProductRepositoryService["paths"]>, input: ProductRepositoryCommand, receipt: ProductRepositoryReceipt, actor: string): void {
    const key = digest(input.requestId);
    let journal = this.read(paths);
    let operation = journal.operations[key];
    if (operation === undefined || operation.receipt === undefined || operation.receipt.operationId !== receipt.operationId) throw new Fault("corrupt");
    let transition = operation.canonicalTransition;
    if (!transition) {
      const product = this.intents.read(actor, input.productId);
      if (!product.ok) throw new Fault(product.code);
      if (product.value.objectiveRevision !== receipt.objectiveRevision) throw new Fault("stale_revision");
      if (product.value.repository && product.value.repository.id !== receipt.repository.id) throw new Fault("repository_conflict");
      if (product.value.stageEvidence.some((item) => item.id === receipt.operationId)) throw new Fault("recovery_required");
      transition = {
        version: "product-intent-v1", requestId: `prepo_${digest(`canonical:${receipt.operationId}`)}`, id: input.productId,
        expectedRevision: product.value.revision, expectedObjectiveRevision: receipt.objectiveRevision,
        repository: receipt.repository,
        stageEvidence: [{ id: receipt.operationId, stage: "repository", outcome: "succeeded",
          objectiveRevision: receipt.objectiveRevision, observedAt: receipt.completedAt,
          references: [{ label: "GitHub repository", url: `https://github.com/${receipt.repository.owner}/${receipt.repository.name}` }] }],
      };
      operation = { ...operation, canonicalTransition: transition };
      journal = this.persist(paths, journal, key, operation);
    }
    let saved = this.intents.transition(actor, transition);
    // A stale result wrote nothing. One refresh may reconcile another trusted stage, never a changed objective.
    if (!saved.ok && saved.code === "stale_revision") {
      const latest = this.intents.read(actor, input.productId);
      if (!latest.ok) throw new Fault(latest.code);
      if (latest.value.objectiveRevision === receipt.objectiveRevision && !latest.value.stageEvidence.some((item) => item.id === receipt.operationId)) {
        if (latest.value.repository && latest.value.repository.id !== receipt.repository.id) throw new Fault("repository_conflict");
        const revised = { ...transition, expectedRevision: latest.value.revision,
          requestId: `prepo_${digest(`${receipt.operationId}:${latest.value.revision}`)}` };
        journal = this.read(paths);
        operation = journal.operations[key];
        if (operation === undefined || operation.receipt === undefined) throw new Fault("corrupt");
        this.persist(paths, journal, key, { ...operation, canonicalTransition: revised });
        saved = this.intents.transition(actor, revised);
      }
    }
    if (!saved.ok) throw new Fault(saved.code);
  }

  private async run(paths: ReturnType<ProductRepositoryService["paths"]>, input: ProductRepositoryCommand, actor: string): Promise<{ receipt: ProductRepositoryReceipt; replayed: boolean }> {
    let journal = this.read(paths);
    const requestKey = digest(input.requestId);
    const payloadDigest = digest(JSON.stringify(input));
    const operationId = `prepo_${digest(`${paths.ownerKey}:${requestKey}`)}`;
    const existing = journal.operations[requestKey];
    if (existing && existing.payloadDigest !== payloadDigest) throw new Fault("idempotency_conflict");
    if (existing?.receipt) {
      try { this.syncDirectory(paths.directory); } catch { throw new Fault("outcome_unknown"); }
      return { receipt: existing.receipt, replayed: true };
    }
    if (!existing) {
      const product = this.intents.read(actor, input.productId);
      if (!product.ok) throw new Fault(product.code);
      if (product.value.revision !== input.expectedRevision || product.value.objectiveRevision !== input.expectedObjectiveRevision) throw new Fault("stale_revision");
      const requested = product.value.brief.requestedRepository;
      if (requested && (requested.owner.toLowerCase() !== input.owner.toLowerCase() || requested.name.toLowerCase() !== input.name.toLowerCase())) throw new Fault("repository_conflict");
      // A bound product never creates again: refuse before any provider read, capability lookup or intent write.
      if (input.action === "create" && product.value.repository) throw new Fault("repository_conflict");
    }
    const sameProduct = Object.entries(journal.operations).filter(([key]) => key !== requestKey).map(([, operation]) => operation)
      .filter((operation) => operation.productId === input.productId);
    const target = (operation: Operation) => operation.owner.toLowerCase() === input.owner.toLowerCase() && operation.name.toLowerCase() === input.name.toLowerCase();
    if (sameProduct.some((operation) => operation.phase === "intent")) throw new Fault("outcome_unknown");
    const bound = sameProduct.find((operation) => operation.receipt && !target(operation));
    if (bound) throw new Fault("repository_conflict");

    const matches = (found: ProviderRepository) => found.owner.toLowerCase() === input.owner.toLowerCase() &&
      found.name.toLowerCase() === input.name.toLowerCase() && found.visibility === input.visibility &&
      (input.repositoryId === undefined || found.id === input.repositoryId);
    const complete = (found: ProviderRepository, outcome: "adopted" | "created"): { receipt: ProductRepositoryReceipt; replayed: boolean } => {
      const product = this.intents.read(actor, input.productId);
      if (!product.ok) throw new Fault(product.code);
      if (product.value.repository && product.value.repository.id !== found.id) throw new Fault("repository_conflict");
      const now = this.clock.iso();
      const receipt = productRepositoryReceiptSchema.parse({
        operationId, productId: input.productId, action: input.action, outcome, completedAt: now, payloadDigest,
        objectiveRevision: input.expectedObjectiveRevision,
        repository: { provider: "github", id: found.id, owner: found.owner, name: found.name, defaultBranch: found.defaultBranch, visibility: found.visibility, verifiedAt: now },
      });
      journal = this.persist(paths, journal, requestKey, { operationId, payloadDigest, productId: input.productId, action: input.action,
        owner: input.owner, name: input.name, visibility: input.visibility, phase: "complete", recordedAt: now, receipt });
      return { receipt, replayed: false };
    };

    if (!existing && Object.keys(journal.operations).length >= PRODUCT_REPOSITORY_LIMITS.operations) throw new Fault("capacity");
    const before = await this.provider.read(input.owner, input.name);
    if (before.state === "unreadable") throw new Fault(existing ? "outcome_unknown" : "provider_unreadable");
    if (input.action === "adopt") {
      if (before.state === "absent") throw new Fault("repository_not_found");
      if (!matches(before.repository)) throw new Fault("repository_conflict");
      return complete(before.repository, "adopted");
    }
    if (before.state === "found") {
      // A journaled intent is the only proof a repository we find is the one we asked for.
      if (!existing || !matches(before.repository)) throw new Fault("repository_conflict");
      return complete(before.repository, "created");
    }
    // A 404 may lag a successful POST. A durable intent can only be reconciled, never posted again.
    if (existing) throw new Fault("outcome_unknown");
    const scope = await this.provider.capability(input.owner);
    if (scope === "denied") throw new Fault("creation_denied");
    if (scope === "unknown") throw new Fault(existing ? "outcome_unknown" : "provider_unreadable");
    if (!existing) {
      journal = this.persist(paths, journal, requestKey, { operationId, payloadDigest, productId: input.productId, action: "create",
        owner: input.owner, name: input.name, visibility: input.visibility, phase: "intent", recordedAt: this.clock.iso() });
    }
    let refused = false;
    try { await this.provider.create({ owner: input.owner, name: input.name, visibility: input.visibility, scope }); }
    catch (error) { refused = error instanceof ProviderDenied; /* any other failure is an unknown outcome: the read-back decides */ }
    const after = await this.provider.read(input.owner, input.name);
    if (after.state === "found") {
      if (!matches(after.repository)) throw new Fault("repository_conflict");
      return complete(after.repository, "created");
    }
    if (refused && after.state === "absent") {
      // The provider refused and nothing exists: retire the intent so the refusal leaves no record.
      this.persist(paths, journal, requestKey, undefined);
      throw new Fault("creation_denied");
    }
    throw new Fault("outcome_unknown");
  }
}

export const PRODUCT_REPOSITORY_PREVIEW_VERSION = "product-repository-preview-v1" as const;
export type ProductRepositoryPreviewState = "ready" | "absent" | "conflict" | "stale" | "denied" | "unavailable";
export type ProductRepositoryPreviewReason =
  | "stale_revision" | "requested_repository_mismatch" | "product_already_bound" | "bound_repository_mismatch"
  | "repository_exists" | "repository_absent" | "provider_unreadable" | "creation_denied" | "creation_unknown";
/** What the provider said about creating in the owner's namespace; "not_checked" means no read got that far. */
export type ProductRepositoryPreviewCreation = ProviderCapability | "not_checked";

export const productRepositoryPreviewQuerySchema = z.object({
  id: productIdSchema, action: z.enum(["adopt", "create"]), owner: repositoryOwner, name: repositoryName,
  expectedRevision: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  expectedObjectiveRevision: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

export interface ProductRepositoryPreview {
  version: typeof PRODUCT_REPOSITORY_PREVIEW_VERSION; productId: string; revision: number; objectiveRevision: number;
  action: "adopt" | "create"; target: { owner: string; name: string };
  state: ProductRepositoryPreviewState; reasons: ProductRepositoryPreviewReason[];
  repository: Omit<z.infer<typeof identitySchema>, "verifiedAt"> | null;
  creation: ProductRepositoryPreviewCreation; observedAt: string;
}
export type ProductRepositoryPreviewResult =
  | { ok: true; value: ProductRepositoryPreview; code?: never } | { ok: false; code: ProductRepositoryCode; value?: never };

/**
 * Read-only observation of the exact repository a create or adopt would act on. It reads the product and
 * the provider and writes nothing: no journal, no product record, no create call. Preview is informational;
 * the mutation rechecks every prerequisite itself, so a "ready" here authorizes nothing.
 */
export async function inspectProductRepository(
  deps: { store: ProductIntentStore; provider: ProductRepositoryProvider; clock?: Clock },
  actor: string, query: unknown,
): Promise<ProductRepositoryPreviewResult> {
  if (typeof actor !== "string" || !actor.trim() || actor.length > 512) return { ok: false, code: "invalid_identity" };
  const parsed = productRepositoryPreviewQuerySchema.safeParse(query);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  const input = parsed.data;
  const product = deps.store.read(actor, input.id);
  if (!product.ok) return { ok: false, code: product.code };
  const { revision, objectiveRevision, repository: bound } = product.value;
  const requested = product.value.brief.requestedRepository;
  const same = (owner: string, name: string) => owner.toLowerCase() === input.owner.toLowerCase() && name.toLowerCase() === input.name.toLowerCase();
  const observedAt = (deps.clock ?? systemClock).iso();
  const outcome = (state: ProductRepositoryPreviewState, reasons: ProductRepositoryPreviewReason[],
    repository: ProductRepositoryPreview["repository"] = null, creation: ProductRepositoryPreviewCreation = "not_checked"): ProductRepositoryPreviewResult => ({
    ok: true, value: { version: PRODUCT_REPOSITORY_PREVIEW_VERSION, productId: input.id, revision, objectiveRevision, action: input.action,
      target: { owner: input.owner, name: input.name }, state, reasons, repository, creation, observedAt },
  });
  if ((input.expectedRevision !== undefined && input.expectedRevision !== revision) ||
    (input.expectedObjectiveRevision !== undefined && input.expectedObjectiveRevision !== objectiveRevision)) return outcome("stale", ["stale_revision"]);
  if (requested && !same(requested.owner, requested.name)) return outcome("conflict", ["requested_repository_mismatch"]);
  // A bound product never becomes a fresh create candidate; no provider read is spent on it.
  if (bound && input.action === "create") return outcome("conflict", ["product_already_bound"]);
  if (bound && input.action === "adopt" && !same(bound.owner, bound.name)) return outcome("conflict", ["bound_repository_mismatch"]);

  let before: ProviderRead;
  try { before = await deps.provider.read(input.owner, input.name); }
  catch { before = { state: "unreadable" }; /* a throwing provider is unreadable, never absent and never ready */ }
  if (before.state === "unreadable") return outcome("unavailable", ["provider_unreadable"]);
  let creation: ProductRepositoryPreviewCreation;
  try { creation = await deps.provider.capability(input.owner); }
  catch { creation = "unknown"; /* an unreadable capability is unknown, never a denial */ }
  if (before.state === "found") {
    const { id, owner, name, defaultBranch, visibility } = before.repository;
    const found = { provider: "github" as const, id, owner, name, defaultBranch, visibility };
    if (input.action === "create") return outcome("conflict", ["repository_exists"], found, creation);
    if (bound && bound.id !== id) return outcome("conflict", ["bound_repository_mismatch"], found, creation);
    // Adoption needs the exact existing repository; creation capability alone never gates it.
    return outcome("ready", [], found, creation);
  }
  if (input.action === "adopt") return outcome("absent", ["repository_absent"], null, creation);
  if (creation === "denied") return outcome("denied", ["repository_absent", "creation_denied"], null, creation);
  if (creation === "unknown") return outcome("unavailable", ["repository_absent", "creation_unknown"], null, creation);
  return outcome("ready", ["repository_absent"], null, creation);
}
