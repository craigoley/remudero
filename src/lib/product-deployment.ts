import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { acquireInflightLock, InflightLockError } from "./inflight-lock.js";
import { ProductIntentStore } from "./product-intent-store.js";
import { productIdSchema, productRequestIdSchema, type ProductStoreCode } from "./product-intent.js";

export const PRODUCT_DEPLOYMENT_VERSION = "product-deployment-v1" as const;
/** PRIMARY CONTROL: maintained quotas; none of them grants a provider or execution authority. */
export const PRODUCT_DEPLOYMENT_LIMITS = { requestBytes: 4 * 1024, operations: 256, stateBytes: 1024 * 1024 } as const;
export const VERCEL_TOKEN_ENV = "VERCEL_TOKEN";
export const VERCEL_TEAM_ID_ENV = "VERCEL_TEAM_ID";
export const VERCEL_API_URL_ENV = "VERCEL_API_URL";
const DEFAULT_VERCEL_API = "https://api.vercel.com";

const repositoryOwner = z.string().min(1).max(39).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
const repositoryName = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine((value) => value !== "." && value !== "..");
const projectName = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/);
const teamId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const projectId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const instant = z.string().datetime();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const repositoryId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const boundRepository = z.object({ id: repositoryId, owner: repositoryOwner, name: repositoryName }).strict();

/** The exact action: adoption names the provider project ID; creation names only the project. */
export const productDeploymentCommandSchema = z.object({
  version: z.literal(PRODUCT_DEPLOYMENT_VERSION), requestId: productRequestIdSchema, productId: productIdSchema,
  action: z.enum(["adopt", "create"]), teamId, projectName, projectId: projectId.optional(), repository: boundRepository,
  expectedRevision: revision, expectedObjectiveRevision: revision,
}).strict().refine((value) => (value.action === "adopt") === (value.projectId !== undefined));

/** Binding a project is NOT a deployment: every downstream proof is its own, unverified field. */
const evidenceSchema = z.object({
  sourceSha: z.null(), deployment: z.literal("none"), servedRoute: z.literal("unverified"), physicalDevice: z.literal("unverified"),
}).strict();
const projectIdentitySchema = z.object({
  provider: z.literal("vercel"), id: projectId, name: projectName, teamId, repository: boundRepository, verifiedAt: instant,
}).strict();
export const productDeploymentReceiptSchema = z.object({
  operationId: z.string().regex(/^pdeploy_[a-f0-9]{64}$/), productId: productIdSchema,
  action: z.enum(["adopt", "create"]), outcome: z.enum(["adopted", "created"]),
  project: projectIdentitySchema, deployed: z.literal(false), playable: z.literal(false), evidence: evidenceSchema,
  completedAt: instant, payloadDigest: digestSchema, objectiveRevision: revision,
}).strict();
const operationSchema = z.object({
  operationId: z.string().regex(/^pdeploy_[a-f0-9]{64}$/), payloadDigest: digestSchema, productId: productIdSchema,
  action: z.enum(["adopt", "create"]), teamId, projectName, phase: z.enum(["intent", "complete"]), recordedAt: instant,
  receipt: productDeploymentReceiptSchema.optional(),
}).strict().refine((value) => (value.phase === "complete") === (value.receipt !== undefined));
const journalSchema = z.object({
  version: z.literal(PRODUCT_DEPLOYMENT_VERSION), ownerKey: digestSchema, operations: z.record(digestSchema, operationSchema),
}).strict().refine((value) => Object.keys(value.operations).length <= PRODUCT_DEPLOYMENT_LIMITS.operations);

export type ProductDeploymentCommand = z.infer<typeof productDeploymentCommandSchema>;
export type ProductDeploymentReceipt = z.infer<typeof productDeploymentReceiptSchema>;
type Operation = z.infer<typeof operationSchema>;
type Journal = z.infer<typeof journalSchema>;
export type ProductDeploymentCode = ProductStoreCode
  | "repository_required" | "repository_mismatch" | "team_mismatch" | "project_not_found" | "project_conflict"
  | "creation_denied" | "not_configured" | "provider_unreadable";
export type ProductDeploymentResult =
  | { ok: true; value: { receipt: ProductDeploymentReceipt; replayed: boolean }; code?: never }
  | { ok: false; code: ProductDeploymentCode; value?: never };

/** What the provider reports back; the creation response itself is never trusted. */
export interface VercelProject {
  id: string; name: string; accountId: string;
  link?: { type: string; org?: string; repo?: string; repoId?: number };
}
export type VercelRead = { state: "found"; project: VercelProject } | { state: "absent" } | { state: "unreadable" };
export interface VercelConfig { token: string; teamId: string; baseUrl: string }
export interface ProductDeploymentProvider {
  config(): VercelConfig | undefined;
  read(config: VercelConfig, name: string): Promise<VercelRead>;
  create(config: VercelConfig, spec: { name: string; repository: { owner: string; name: string } }): Promise<void>;
}
/** Thrown by a provider that was told, unambiguously, that creation is not permitted. */
export class VercelDenied extends RmdError {
  constructor(message: string) { super("usage", GENERIC_EXIT_CODE, message); }
}

const vercelProjectSchema = z.object({
  id: projectId, name: z.string().min(1).max(100), accountId: z.string().min(1).max(64),
  link: z.object({
    type: z.string().max(32), org: z.string().max(100).optional(), repo: z.string().max(100).optional(),
    repoId: z.union([z.number(), z.string().regex(/^\d{1,16}$/).transform(Number)]).pipe(z.number().int().positive()).optional(),
  }).passthrough().optional(),
}).passthrough();

/** The server-held credential, team and API origin; a non-https remote origin would leak the token, so it is refused. */
export function vercelConfigFromEnv(env: NodeJS.ProcessEnv): VercelConfig | undefined {
  const token = env[VERCEL_TOKEN_ENV]?.trim();
  const team = teamId.safeParse(env[VERCEL_TEAM_ID_ENV]?.trim());
  const baseUrl = (env[VERCEL_API_URL_ENV]?.trim() || DEFAULT_VERCEL_API).replace(/\/+$/, "");
  if (!token || !team.success || !URL.canParse(baseUrl)) return undefined;
  const url = new URL(baseUrl);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) return undefined;
  return { token, teamId: team.data, baseUrl };
}

/** The production provider: bounded `fetch` against the Vercel REST API; the token never appears in an error. */
export function vercelDeploymentProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ProductDeploymentProvider {
  const call = (config: VercelConfig, path: string, init: { method: "GET" | "POST"; body?: unknown }) =>
    fetchImpl(`${config.baseUrl}${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(config.teamId)}`, {
      method: init.method, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${config.token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
  return {
    config: () => vercelConfigFromEnv(env),
    async read(config, name) {
      let response: Response;
      try { response = await call(config, `/v9/projects/${encodeURIComponent(name)}`, { method: "GET" }); }
      catch { return { state: "unreadable" }; /* a transport failure is unknown, never absence */ }
      if (response.status === 404) return { state: "absent" };
      if (!response.ok) return { state: "unreadable" };
      try {
        const parsed = vercelProjectSchema.safeParse(await response.json());
        if (!parsed.success) return { state: "unreadable" };
        const { id, name: canonical, accountId, link } = parsed.data;
        return { state: "found", project: { id, name: canonical, accountId,
          ...(link ? { link: { type: link.type, org: link.org, repo: link.repo, repoId: link.repoId } } : {}) } };
      } catch { return { state: "unreadable" }; /* a malformed body is unknown, never a project */ }
    },
    async create(config, spec) {
      const response = await call(config, "/v10/projects", { method: "POST",
        body: { name: spec.name, gitRepository: { type: "github", repo: `${spec.repository.owner}/${spec.repository.name}` } } });
      if (response.status === 401 || response.status === 403) throw new VercelDenied(`project creation refused (HTTP ${response.status})`);
      if (!response.ok) throw new Error(`project creation failed (HTTP ${response.status})`);
    },
  };
}

class Fault extends RmdError {
  constructor(readonly code: ProductDeploymentCode) { super("usage", GENERIC_EXIT_CODE, `product deployment: ${code}`); }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const errno = (error: unknown, code: string) => (error as NodeJS.ErrnoException | undefined)?.code === code;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface ProductDeploymentOptions {
  root?: string;
  provider?: ProductDeploymentProvider;
  env?: NodeJS.ProcessEnv;
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

type Paths = { root: string; directory: string; state: string; locks: string; ownerKey: string };

/**
 * Bind a product to its Vercel project. The intent is journaled and fsynced BEFORE the one create
 * call, so a lost response is reconciled by reading the provider, never by a second POST. The
 * project is read back and its team and GitHub identity verified before anything is recorded.
 * Nothing here deploys, purchases, changes DNS or deletes a project.
 */
export class ProductDeploymentService {
  private readonly provider: ProductDeploymentProvider;
  private readonly clock: Clock;
  private readonly sync: (fd: number) => void;
  private readonly intents: ProductIntentStore;

  constructor(private readonly options: ProductDeploymentOptions) {
    this.provider = options.provider ?? vercelDeploymentProvider(options.env);
    this.clock = options.clock ?? systemClock;
    this.sync = options.sync ?? fsyncSync;
    this.intents = options.store ?? new ProductIntentStore({ root: options.root });
  }

  async execute(actor: string, command: unknown): Promise<ProductDeploymentResult> {
    try {
      if (typeof actor !== "string" || !actor.trim() || actor.length > 512) throw new Fault("invalid_identity");
      const parsed = productDeploymentCommandSchema.safeParse(command);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > PRODUCT_DEPLOYMENT_LIMITS.requestBytes) throw new Fault("invalid_input");
      const input = parsed.data;
      const product = this.intents.read(actor, input.productId);
      if (!product.ok) throw new Fault(product.code);
      this.assertBound(input, product.value.repository);
      const config = this.provider.config();
      if (!config) throw new Fault("not_configured");
      if (config.teamId !== input.teamId) throw new Fault("team_mismatch");
      const paths = this.paths(actor);
      return await serialized(paths.ownerKey, async () => {
        this.ensureDirectory(paths);
        const handle = this.lock(paths);
        try { return { ok: true as const, value: await this.run(paths, input, actor, config) }; }
        finally { handle.release(); }
      });
    } catch (error) {
      return { ok: false, code: error instanceof Fault ? error.code : error instanceof InflightLockError ? "busy" : "unavailable" };
    }
  }

  /** The repository in the command must be the one the product is verified to be bound to. */
  private assertBound(input: ProductDeploymentCommand, bound: { id: number; owner: string; name: string } | null): void {
    if (!bound) throw new Fault("repository_required");
    if (bound.id !== input.repository.id || !same(bound.owner, input.repository.owner) || !same(bound.name, input.repository.name)) {
      throw new Fault("repository_mismatch");
    }
  }

  private lock(paths: Paths) {
    try { return acquireInflightLock(paths.locks, paths.ownerKey, { run_id: `product-deployment-${randomUUID()}` }); }
    catch (error) { if (error instanceof InflightLockError) throw error; throw new Fault("unavailable"); }
  }

  private paths(actor: string): Paths {
    if (!this.options.root || !isAbsolute(this.options.root)) throw new Fault("unavailable");
    const root = realpathSync(this.options.root);
    const ownerKey = digest(actor);
    const directory = join(root, "state", "products", "v1", "deployments");
    return { root, directory, state: join(directory, `${ownerKey}.json`), locks: join(directory, "locks"), ownerKey };
  }

  /** Each level is qualified through ONE no-follow descriptor, never checked and then re-used by name. */
  private ensureDirectory(paths: Paths): void {
    const parts = ["state", "products", "v1", "deployments"];
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

  private read(paths: Paths): Journal {
    let fd: number | undefined;
    try {
      fd = openSync(paths.state, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1 || (info.mode & 0o077) !== 0 || info.size > PRODUCT_DEPLOYMENT_LIMITS.stateBytes) throw new Fault("unavailable");
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
      if (errno(error, "ENOENT")) return { version: PRODUCT_DEPLOYMENT_VERSION, ownerKey: paths.ownerKey, operations: {} };
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** Atomic replace. A failure before the rename is `unavailable`; after it, the result is unknowable. */
  private commit(paths: Paths, journal: Journal): void {
    const body = JSON.stringify(journal);
    if (Buffer.byteLength(body) > PRODUCT_DEPLOYMENT_LIMITS.stateBytes) throw new Fault("capacity");
    const temporary = join(paths.directory, `.${paths.ownerKey}.${randomUUID()}.pending`);
    let renamed = false;
    try {
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); writeFileSync(fd, body, "utf8"); this.sync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, paths.state);
      renamed = true;
      this.syncDirectory(paths.directory);
    } catch (error) {
      if (!renamed) this.discard(temporary);
      throw new Fault(renamed ? "outcome_unknown" : "unavailable");
    }
  }

  /** Removes a stage that will never be renamed; one already gone is the outcome wanted. */
  private discard(path: string): void {
    try { unlinkSync(path); } catch (cleanup) { if (!errno(cleanup, "ENOENT")) throw new Fault("unavailable"); }
  }

  private persist(paths: Paths, journal: Journal, key: string, operation: Operation | undefined): Journal {
    const operations = Object.fromEntries([...Object.entries(journal.operations).filter(([existing]) => existing !== key),
      ...(operation ? [[key, operation] as const] : [])]);
    const next = { ...journal, operations };
    this.commit(paths, next);
    return next;
  }

  /** Team and GitHub identity are read back from the provider; the command's claim proves nothing. */
  private verify(project: VercelProject, input: ProductDeploymentCommand, config: VercelConfig): void {
    if (project.accountId !== config.teamId) throw new Fault("team_mismatch");
    const link = project.link;
    if (!project.name || !same(project.name, input.projectName)) throw new Fault("project_conflict");
    if (!link || link.type !== "github" || link.repoId !== input.repository.id ||
      !link.org || !same(link.org, input.repository.owner) || !link.repo || !same(link.repo, input.repository.name)) {
      throw new Fault("repository_mismatch");
    }
    if (input.projectId !== undefined && project.id !== input.projectId) throw new Fault("project_conflict");
  }

  private async run(paths: Paths, input: ProductDeploymentCommand, actor: string, config: VercelConfig): Promise<{ receipt: ProductDeploymentReceipt; replayed: boolean }> {
    let journal = this.read(paths);
    const requestKey = digest(input.requestId);
    const payloadDigest = digest(JSON.stringify(input));
    const operationId = `pdeploy_${digest(`${paths.ownerKey}:${requestKey}`)}`;
    const existing = journal.operations[requestKey];
    if (existing && existing.payloadDigest !== payloadDigest) throw new Fault("idempotency_conflict");
    if (existing?.receipt) {
      try { this.syncDirectory(paths.directory); } catch { throw new Fault("outcome_unknown"); }
      return { receipt: existing.receipt, replayed: true };
    }
    if (!existing) {
      const product = this.intents.read(actor, input.productId);
      if (!product.ok) throw new Fault(product.code);
      this.assertBound(input, product.value.repository);
      if (product.value.revision !== input.expectedRevision || product.value.objectiveRevision !== input.expectedObjectiveRevision) throw new Fault("stale_revision");
    }
    const sameProduct = Object.entries(journal.operations).filter(([key]) => key !== requestKey).map(([, operation]) => operation)
      .filter((operation) => operation.productId === input.productId);
    if (sameProduct.some((operation) => operation.phase === "intent")) throw new Fault("outcome_unknown");
    if (sameProduct.some((operation) => operation.receipt && (operation.receipt.project.name !== input.projectName || operation.receipt.project.teamId !== input.teamId))) {
      throw new Fault("project_conflict");
    }
    if (!existing && Object.keys(journal.operations).length >= PRODUCT_DEPLOYMENT_LIMITS.operations) throw new Fault("capacity");

    const complete = (project: VercelProject, outcome: "adopted" | "created") => {
      this.verify(project, input, config);
      const now = this.clock.iso();
      const receipt = productDeploymentReceiptSchema.parse({
        operationId, productId: input.productId, action: input.action, outcome, completedAt: now, payloadDigest,
        objectiveRevision: input.expectedObjectiveRevision, deployed: false, playable: false,
        evidence: { sourceSha: null, deployment: "none", servedRoute: "unverified", physicalDevice: "unverified" },
        project: { provider: "vercel", id: project.id, name: project.name, teamId: project.accountId, repository: input.repository, verifiedAt: now },
      });
      journal = this.persist(paths, journal, requestKey, { operationId, payloadDigest, productId: input.productId, action: input.action,
        teamId: input.teamId, projectName: input.projectName, phase: "complete", recordedAt: now, receipt });
      return { receipt, replayed: false };
    };

    const before = await this.provider.read(config, input.projectName);
    if (before.state === "unreadable") throw new Fault(existing ? "outcome_unknown" : "provider_unreadable");
    if (input.action === "adopt") {
      if (before.state === "absent") throw new Fault("project_not_found");
      return complete(before.project, "adopted");
    }
    if (before.state === "found") {
      // A journaled intent is the only proof a project we find is the one we asked for.
      if (!existing) throw new Fault("project_conflict");
      return complete(before.project, "created");
    }
    // A 404 may lag a successful POST. A durable intent can only be reconciled, never posted again.
    if (existing) throw new Fault("outcome_unknown");
    journal = this.persist(paths, journal, requestKey, { operationId, payloadDigest, productId: input.productId, action: "create",
      teamId: input.teamId, projectName: input.projectName, phase: "intent", recordedAt: this.clock.iso() });
    let refused = false;
    try { await this.provider.create(config, { name: input.projectName, repository: input.repository }); }
    catch (error) { refused = error instanceof VercelDenied; /* any other failure is an unknown outcome: the read-back decides */ }
    const after = await this.provider.read(config, input.projectName);
    if (after.state === "found") return complete(after.project, "created");
    if (refused && after.state === "absent") {
      // The provider refused and nothing exists: retire the intent so the refusal leaves no record.
      this.persist(paths, journal, requestKey, undefined);
      throw new Fault("creation_denied");
    }
    throw new Fault("outcome_unknown");
  }
}
