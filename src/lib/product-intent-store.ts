import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { RmdError, GENERIC_EXIT_CODE } from "./errors.js";
import { InflightLockError, withInflightLock } from "./inflight-lock.js";
import {
  PRODUCT_INTENT_LIMITS, PRODUCT_INTENT_VERSION, productIdSchema, productOwnerStateSchema,
  productRecordDigest, productRequestIdSchema, productTransitionSchema, productWriteSchema, storedProductSchema,
  type ProductOwnerState, type ProductProjection, type ProductReceipt, type ProductResult,
  type ProductStoreCode, type ProductSummary, type StoredProduct,
} from "./product-intent.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const errno = (error: unknown, code: string) => (error as NodeJS.ErrnoException | undefined)?.code === code;

class ProductStoreFault extends RmdError {
  constructor(readonly code: ProductStoreCode) { super("usage", GENERIC_EXIT_CODE, `product store: ${code}`); }
}

function requireActor(actor: string): void {
  if (typeof actor !== "string" || !actor.trim() || actor.length > 512) throw new ProductStoreFault("invalid_identity");
}

export function productStatePaths(root: string, actor: string) {
  requireActor(actor);
  if (!isAbsolute(root)) throw new ProductStoreFault("unavailable");
  const ownerKey = digest(actor);
  const directory = join(root, "state", "products", "v1");
  return { directory, state: join(directory, `${ownerKey}.json`), pending: join(directory, `.${ownerKey}.pending`), locks: join(directory, "locks"), ownerKey };
}

interface ProductStoreOptions {
  root?: string;
  clock?: Clock;
  sync?: (fd: number) => void;
  /** A caller may tighten budgets, never raise the maintained ceilings. */
  limits?: { maxProducts?: number; maxRequests?: number; maxStateBytes?: number };
}

function tighter(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new ProductStoreFault("unavailable");
  return value;
}

function syncDirectory(directory: string, sync = fsyncSync): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try { sync(fd); }
  finally { closeSync(fd); }
}

/** Every mutation re-reads under an exclusive lock; one atomic file commits data and receipts together. */
export class ProductIntentStore {
  private readonly clock: Clock;
  private readonly sync: (fd: number) => void;
  private readonly limits: { products: number; requests: number; stateBytes: number };

  constructor(private readonly options: ProductStoreOptions) {
    this.clock = options.clock ?? systemClock;
    this.sync = options.sync ?? fsyncSync;
    this.limits = {
      products: tighter(options.limits?.maxProducts, PRODUCT_INTENT_LIMITS.products),
      requests: tighter(options.limits?.maxRequests, PRODUCT_INTENT_LIMITS.requests),
      stateBytes: tighter(options.limits?.maxStateBytes, PRODUCT_INTENT_LIMITS.stateBytes),
    };
  }

  private attempt<T>(actor: string, operation: () => T): ProductResult<T> {
    try { requireActor(actor); return { ok: true, value: operation() }; }
    catch (error) {
      return { ok: false, code: error instanceof ProductStoreFault ? error.code : error instanceof InflightLockError ? "busy" : "unavailable" };
    }
  }

  private paths(actor: string, create: boolean): ReturnType<typeof productStatePaths> {
    if (!this.options.root || !isAbsolute(this.options.root)) throw new ProductStoreFault("unavailable");
    const root = realpathSync(this.options.root);
    if (!statSync(root).isDirectory()) throw new ProductStoreFault("unavailable");
    const paths = productStatePaths(root, actor);
    if (create) {
      mkdirSync(join(root, "state"), { recursive: true });
      syncDirectory(root);
    }
    // The configured state directory may be a managed mount/symlink. Our own subdirectories may not.
    for (const directory of [join(root, "state", "products"), paths.directory]) {
      if (create) {
        try { mkdirSync(directory, { mode: 0o700 }); }
        catch (error) { if (!errno(error, "EEXIST")) throw error; }
      }
      try {
        const info = lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new ProductStoreFault("unavailable");
        // Sync ancestry even if another writer created it: our acknowledgement must not race its fsync.
        if (create) syncDirectory(dirname(directory));
      } catch (error) {
        if (!create && errno(error, "ENOENT")) break;
        throw error;
      }
    }
    return paths;
  }

  private readState(paths: ReturnType<typeof productStatePaths>): ProductOwnerState {
    let fd: number | undefined;
    try {
      fd = openSync(paths.state, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1 || (info.mode & 0o077) !== 0 || info.size > PRODUCT_INTENT_LIMITS.stateBytes) {
        throw new ProductStoreFault("unavailable");
      }
      const buffer = Buffer.alloc(info.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size !== info.size) throw new ProductStoreFault("corrupt");
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))); }
      catch { throw new ProductStoreFault("corrupt"); }
      const parsed = productOwnerStateSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerKey !== paths.ownerKey) throw new ProductStoreFault("corrupt");
      return parsed.data;
    } catch (error) {
      if (errno(error, "ENOENT")) return { version: PRODUCT_INTENT_VERSION, ownerKey: paths.ownerKey, products: {}, receipts: {} };
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  private commit(paths: ReturnType<typeof productStatePaths>, state: ProductOwnerState): void {
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > this.limits.stateBytes) throw new ProductStoreFault("capacity");
    // One pending file per principal bounds retained failures; never overwrite an older uncommitted save.
    const temporary = paths.pending;
    let fd: number | undefined;
    let temporaryExists = false;
    let renameAttempted = false;
    try {
      try {
        fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        temporaryExists = true;
        fchmodSync(fd, 0o600);
        writeFileSync(fd, body, "utf8");
        this.sync(fd);
        closeSync(fd);
        fd = undefined;
        renameAttempted = true;
        renameSync(temporary, paths.state);
        temporaryExists = false;
        fd = openSync(paths.directory, constants.O_RDONLY);
        this.sync(fd);
      } finally {
        try { if (fd !== undefined) closeSync(fd); }
        finally {
          if (temporaryExists) {
            try { unlinkSync(temporary); }
            catch (error) { if (!errno(error, "ENOENT")) throw error; }
          }
        }
      }
    } catch (error) {
      if (!temporaryExists && !renameAttempted && errno(error, "EEXIST")) throw new ProductStoreFault("recovery_required");
      // Once rename was attempted, a retry must reconcile the durable request receipt first.
      throw new ProductStoreFault(renameAttempted ? "outcome_unknown" : "unavailable");
    }
  }

  private durableReceipt(paths: ReturnType<typeof productStatePaths>, receipt: ProductReceipt): ProductReceipt {
    try { syncDirectory(paths.directory, this.sync); }
    catch (error) { throw Object.assign(new ProductStoreFault("outcome_unknown"), { cause: error }); }
    return receipt;
  }

  /** One save path for briefs and trusted transitions: lock, replay, revision guard, quota, atomic commit. */
  private persist(
    actor: string, input: { requestId: string; id?: string; expectedRevision: number }, payloadDigest: string,
    derive: (previous: StoredProduct | undefined, id: string, now: string) => unknown,
  ): { receipt: ProductReceipt; replayed: boolean } {
    const paths = this.paths(actor, true);
    const requestKey = digest(input.requestId);
    return withInflightLock(paths.locks, paths.ownerKey, () => {
      const state = this.readState(paths);
      const previousReceipt = state.receipts[requestKey];
      if (previousReceipt) {
        if (previousReceipt.payloadDigest !== payloadDigest) throw new ProductStoreFault("idempotency_conflict");
        return { receipt: this.durableReceipt(paths, previousReceipt), replayed: true };
      }
      const id = input.id ?? `prd_${digest(`${paths.ownerKey}:${requestKey}`).slice(0, 32)}`;
      const previous = state.products[id];
      if (input.id && !previous) throw new ProductStoreFault("not_found");
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new ProductStoreFault("stale_revision");
      if ((!previous && Object.keys(state.products).length >= this.limits.products) || Object.keys(state.receipts).length >= this.limits.requests) {
        throw new ProductStoreFault("capacity");
      }
      const now = this.clock.iso();
      const product = storedProductSchema.parse(derive(previous, id, now));
      const serialized = JSON.stringify(product);
      if (Buffer.byteLength(serialized) > PRODUCT_INTENT_LIMITS.productBytes) throw new ProductStoreFault("invalid_input");
      const receipt: ProductReceipt = {
        operationId: `pwrite_${digest(`${paths.ownerKey}:${requestKey}`)}`, productId: id,
        revision: product.revision, objectiveRevision: product.objectiveRevision,
        savedAt: now, payloadDigest, recordDigest: productRecordDigest(product),
      };
      // Rebuild the records: no property write is keyed by a request-derived name.
      this.commit(paths, {
        ...state,
        products: Object.fromEntries([...Object.entries(state.products).filter(([key]) => key !== id), [id, product] as const]),
        receipts: Object.fromEntries([...Object.entries(state.receipts), [requestKey, receipt] as const]),
      });
      return { receipt, replayed: false };
    }, { run_id: `product-${randomUUID()}` });
  }

  write(actor: string, command: unknown): ProductResult<{ receipt: ProductReceipt; replayed: boolean }> {
    return this.attempt(actor, () => {
      const parsed = productWriteSchema.safeParse(command);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > PRODUCT_INTENT_LIMITS.requestBytes) throw new ProductStoreFault("invalid_input");
      const input = parsed.data;
      return this.persist(actor, input, digest(JSON.stringify(input)), (previous, id, now) => {
        const changedObjective = previous && digest(JSON.stringify(previous.brief)) !== digest(JSON.stringify(input.brief));
        return {
          version: PRODUCT_INTENT_VERSION, id, revision: (previous?.revision ?? 0) + 1,
          objectiveRevision: previous ? previous.objectiveRevision + (changedObjective ? 1 : 0) : 1,
          createdAt: previous?.createdAt ?? now, updatedAt: now, brief: input.brief,
          repository: previous?.repository ?? null, stageEvidence: previous?.stageEvidence ?? [], executionAuthority: "none",
        };
      });
    });
  }

  /**
   * Trusted-mechanism seam: records verified repository identity and appended stage evidence in the
   * same owner record. Never reachable from a browser request; the brief and authority stay untouched.
   */
  transition(actor: string, command: unknown): ProductResult<{ receipt: ProductReceipt; replayed: boolean }> {
    return this.attempt(actor, () => {
      const parsed = productTransitionSchema.safeParse(command);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > PRODUCT_INTENT_LIMITS.requestBytes) throw new ProductStoreFault("invalid_input");
      const input = parsed.data;
      return this.persist(actor, input, digest(JSON.stringify(input)), (previous, _id, now) => {
        if (!previous) throw new ProductStoreFault("not_found");
        if (previous.objectiveRevision !== input.expectedObjectiveRevision) throw new ProductStoreFault("stale_revision");
        const added = input.stageEvidence ?? [];
        const known = new Set(previous.stageEvidence.map((item) => item.id));
        if (added.some((item, index) => item.objectiveRevision !== previous.objectiveRevision || known.has(item.id) ||
          added.findIndex((other) => other.id === item.id) !== index)) throw new ProductStoreFault("invalid_input");
        if (previous.repository && input.repository && previous.repository.id !== input.repository.id) throw new ProductStoreFault("invalid_input");
        if (previous.stageEvidence.length + added.length > 128) throw new ProductStoreFault("capacity");
        return {
          ...previous, revision: previous.revision + 1, updatedAt: now,
          repository: input.repository ?? previous.repository, stageEvidence: [...previous.stageEvidence, ...added],
        };
      });
    });
  }

  read(actor: string, id: string): ProductResult<ProductProjection> {
    return this.attempt(actor, () => {
      if (!productIdSchema.safeParse(id).success) throw new ProductStoreFault("invalid_input");
      const state = this.readState(this.paths(actor, false));
      const product = state.products[id];
      if (!product) throw new ProductStoreFault("not_found");
      const history = Object.values(state.receipts).filter((receipt) => receipt.productId === id)
        .sort((a, b) => a.revision - b.revision).slice(-PRODUCT_INTENT_LIMITS.history);
      return { ...product, history };
    });
  }

  list(actor: string): ProductResult<ProductSummary[]> {
    return this.attempt(actor, () => Object.values(this.readState(this.paths(actor, false)).products)
      .map(({ id, revision, objectiveRevision, createdAt, updatedAt, brief }) => ({
        id, revision, objectiveRevision, createdAt, updatedAt, name: brief.name ?? "Untitled product", portfolio: brief.portfolio,
      })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
  }

  receipt(actor: string, requestId: string): ProductResult<ProductReceipt> {
    return this.attempt(actor, () => {
      if (!productRequestIdSchema.safeParse(requestId).success) throw new ProductStoreFault("invalid_input");
      const paths = this.paths(actor, false);
      const receipt = this.readState(paths).receipts[digest(requestId)];
      if (!receipt) throw new ProductStoreFault("not_found");
      return this.durableReceipt(paths, receipt);
    });
  }
}
