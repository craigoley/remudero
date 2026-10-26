import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { isPaused, isSafeRepoName, isSafeTaskId, isStopped, requestKick } from "./fleet-control.js";
import { ghTextAsync } from "./github-transport.js";
import { loadManagedRepos } from "./managed-repos.js";
import { ProductIntentStore } from "./product-intent-store.js";
import {
  productIdSchema, productRequestIdSchema, type ProductStoreCode, type StoredProduct,
} from "./product-intent.js";
import { ghProductRepositoryProvider, type ProductRepositoryProvider } from "./product-repository.js";
import { explainUnitTestProofRefusal } from "./review.js";

export const PRODUCT_BUILD_VERSION = "product-build-v1" as const;
/** PRIMARY CONTROL: a transport quota only. It grants no dispatch, provider or spend authority. */
export const PRODUCT_BUILD_LIMITS = { requestBytes: 4 * 1024 } as const;
/** The four receipts a README-only repository needs, at its exact head, before any source task is filed. */
export const BOOTSTRAP_CHECKS = ["test", "typecheck", "build", "security"] as const;

/** Names a durable, reviewed handoff: the target task's `origin:` must carry exactly this. */
export const productPlanOrigin = (productId: string, planEvidenceId: string) => `product-plan#${productId}/${planEvidenceId}`;
/** The trusted bootstrap-receipt evidence id: bound to the exact head so a moved head never inherits it. */
export const bootstrapEvidenceId = (head: string, check: (typeof BOOTSTRAP_CHECKS)[number]) => `bootstrap:${head}:${check}`;

export const productBuildCommandSchema = z.object({
  version: z.literal(PRODUCT_BUILD_VERSION), requestId: productRequestIdSchema, productId: productIdSchema,
  planEvidenceId: z.string().trim().min(1).max(128), taskId: z.string().min(1).max(64).refine((value) => isSafeTaskId(value)),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  expectedObjectiveRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ProductBuildCommand = z.infer<typeof productBuildCommandSchema>;

/** Each phase is independent evidence; only `queued` is ever written by this operation's own act. */
export type ProductBuildOutcome = "queued" | "admitted" | "running";
export interface ProductBuildReceipt {
  operationId: string; productId: string; taskId: string; planEvidenceId: string;
  outcome: ProductBuildOutcome; repository: { id: number; owner: string; name: string };
  objectiveRevision: number; payloadDigest: string; queuedAt: string;
  evidence: { outcome: ProductBuildOutcome; observedAt: string }[];
}
export type ProductBuildCode = ProductStoreCode
  | "repository_missing" | "repository_not_found" | "repository_conflict" | "provider_unreadable"
  | "plan_not_approved" | "target_not_enrolled" | "target_unreadable" | "runner_missing" | "bootstrap_unverified"
  | "task_not_found" | "task_unreadable" | "task_stale" | "task_claimed" | "task_merged" | "budget_exceeded"
  | "fleet_halted" | "kick_failed";
export type ProductBuildResult =
  | { ok: true; value: { receipt: ProductBuildReceipt; replayed: boolean }; code?: never }
  | { ok: false; code: ProductBuildCode; value?: never };

export interface BuildRepository { id: number; owner: string; name: string; defaultBranch: string }
export interface TargetInspection { enrolled: boolean | undefined; head: string | undefined; readmeOnly: boolean | undefined }
export interface BuildTask { id: string; origin: string | undefined; status: string; budgetUsd: number | undefined; claimed: boolean; merged: boolean }
export type TaskRead = { state: "found"; task: BuildTask } | { state: "absent" } | { state: "unreadable" };
export type BuildObservation = { state: "none" | "unknown" } | { state: "admitted" | "running"; url?: string };
/** Everything the operation must verify about the target immediately before it acts. */
export interface ProductBuildTarget {
  inspect(repository: BuildRepository): Promise<TargetInspection>;
  /** Whether the target's acceptance runner is registered; the closed registry refuses an unknown owner. */
  runnerRegistered(repository: BuildRepository): boolean;
  task(repository: BuildRepository, taskId: string): Promise<TaskRead>;
  observe(repository: BuildRepository, taskId: string): Promise<BuildObservation>;
}

export interface ProductBuildOptions {
  root?: string;
  /** The checkout whose reviewed `.remudero/managed-repos.json` enrolls targets. */
  repoRoot?: string;
  provider?: Pick<ProductRepositoryProvider, "read">;
  target?: ProductBuildTarget;
  store?: ProductIntentStore;
  /** The existing guarded repo-scoped kick marker; the daemon's own admission still decides. */
  kick?: (root: string, taskId: string, origin: string, repo: string) => void;
  now?: () => string;
}

class Fault extends RmdError {
  constructor(readonly code: ProductBuildCode) { super("usage", GENERIC_EXIT_CODE, `product build: ${code}`); }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

type GhText = (args: string[], opts?: { maxBuffer?: number; timeout?: number }) => Promise<string>;
const sha = /^[a-f0-9]{40}$/;

/** The production target port: the existing bounded `gh` transport, the reviewed managed set and the closed suite registry. */
export function ghProductBuildTarget(options: { repoRoot?: string; text?: GhText } = {}): ProductBuildTarget {
  const text = options.text ?? ghTextAsync;
  const limits = { maxBuffer: 1024 * 1024, timeout: 20_000 };
  const api = async (path: string, raw = false): Promise<string> =>
    text(["api", ...(raw ? ["-H", "Accept: application/vnd.github.raw"] : []), path], limits);
  const slug = (repo: BuildRepository) => `repos/${repo.owner}/${repo.name}`;
  return {
    async inspect(repo) {
      let enrolled: boolean | undefined;
      try {
        enrolled = options.repoRoot === undefined ? undefined : loadManagedRepos(options.repoRoot)
          .some((entry) => `${entry.owner}/${entry.repo}`.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase());
      } catch (error) {
        // A malformed managed set is unknown enrollment, which the caller refuses; it is never read as "not managed".
        void error; enrolled = undefined;
      }
      try {
        const head = z.object({ sha: z.string().regex(sha) }).parse(JSON.parse(await api(`${slug(repo)}/commits/${encodeURIComponent(repo.defaultBranch)}`))).sha;
        const entries = z.array(z.object({ name: z.string() })).parse(JSON.parse(await api(`${slug(repo)}/contents?ref=${head}`)));
        const readmeOnly = entries.every((entry) => /^(readme(\.[a-z]+)?|license(\.[a-z]+)?|\.gitignore)$/i.test(entry.name));
        return { enrolled, head, readmeOnly };
      } catch (error) {
        // An unreadable head or tree leaves bootstrap unprovable; the caller refuses rather than guessing a shape.
        void error; return { enrolled, head: undefined, readmeOnly: undefined };
      }
    },
    runnerRegistered(repo) {
      return explainUnitTestProofRefusal("unit test: tests/product-build-probe.test.ts", { owner: repo.owner, repo: repo.name }) === undefined;
    },
    async task(repo, taskId) {
      try {
        const names = z.array(z.object({ name: z.string() })).parse(JSON.parse(await api(`${slug(repo)}/contents/plan/tasks.d?ref=${repo.defaultBranch}`)));
        const shard = names.find((entry) => entry.name.startsWith(`${taskId}-`) && entry.name.endsWith(".yaml"));
        if (!shard) return { state: "absent" };
        const parsed = z.array(z.object({ id: z.string(), origin: z.string().optional(), status: z.string(), budget_usd: z.number().optional() }).passthrough())
          .parse(parseYaml(await api(`${slug(repo)}/contents/plan/tasks.d/${shard.name}?ref=${repo.defaultBranch}`, true)));
        const task = parsed.find((entry) => entry.id === taskId);
        if (!task) return { state: "absent" };
        const claims = z.array(z.unknown()).parse(JSON.parse(await api(`${slug(repo)}/git/matching-refs/rmd-dispatch/${taskId}`)));
        const credit = z.object({ total_count: z.number() }).parse(JSON.parse(await api(
          `search/issues?q=${encodeURIComponent(`repo:${repo.owner}/${repo.name} is:pr is:merged "Remudero-Task: ${taskId}"`)}`)));
        return { state: "found", task: { id: taskId, origin: task.origin, status: task.status, budgetUsd: task.budget_usd, claimed: claims.length > 0, merged: credit.total_count > 0 } };
      } catch (error) {
        // Unreadable is its own state: a claim or credit that cannot be read is never "free".
        void error; return { state: "unreadable" };
      }
    },
    async observe(repo, taskId) {
      try {
        const claims = z.array(z.unknown()).parse(JSON.parse(await api(`${slug(repo)}/git/matching-refs/rmd-dispatch/${taskId}`)));
        if (claims.length === 0) return { state: "none" };
        const branches = z.array(z.object({ ref: z.string() })).parse(JSON.parse(await api(`${slug(repo)}/git/matching-refs/heads/run-${taskId}-`)));
        const branch = branches[0]?.ref.replace(/^refs\/heads\//, "");
        return branch ? { state: "running", url: `https://github.com/${repo.owner}/${repo.name}/tree/${branch}` } : { state: "admitted" };
      } catch (error) {
        // Not observed is not "running": the caller records nothing beyond what it did itself.
        void error; return { state: "unknown" };
      }
    },
  };
}

/**
 * Starts ONE guarded target-repository task for an approved product plan. It never launches a worker:
 * it verifies everything immediately before acting, writes the existing repo-scoped kick marker the
 * daemon's own admission consumes, and records `queued` — never `running` — until real evidence says so.
 */
export class ProductBuildService {
  private readonly provider: Pick<ProductRepositoryProvider, "read">;
  private readonly target: ProductBuildTarget;
  private readonly store: ProductIntentStore;
  private readonly kick: NonNullable<ProductBuildOptions["kick"]>;
  private readonly now: () => string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ProductBuildOptions) {
    this.provider = options.provider ?? ghProductRepositoryProvider();
    this.target = options.target ?? ghProductBuildTarget({ repoRoot: options.repoRoot });
    this.store = options.store ?? new ProductIntentStore({ root: options.root });
    this.kick = options.kick ?? ((root, taskId, origin, repo) => { requestKick(root, taskId, origin, repo); });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async execute(actor: string, command: unknown): Promise<ProductBuildResult> {
    // One in-process chain: two identical requests cannot both pass the replay check and double-record.
    const run = this.chain.then(() => this.run(actor, command));
    this.chain = run.then(() => undefined, () => undefined /* the caller awaits `run`; the tail only orders the chain */);
    return run;
  }

  private async run(actor: string, command: unknown): Promise<ProductBuildResult> {
    try {
      if (typeof actor !== "string" || !actor.trim() || actor.length > 512) throw new Fault("invalid_identity");
      const parsed = productBuildCommandSchema.safeParse(command);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > PRODUCT_BUILD_LIMITS.requestBytes) throw new Fault("invalid_input");
      return { ok: true, value: await this.start(actor, parsed.data) };
    } catch (error) {
      return { ok: false, code: error instanceof Fault ? error.code : "unavailable" };
    }
  }

  private readProduct(actor: string, id: string): StoredProduct {
    const read = this.store.read(actor, id);
    if (!read.ok) throw new Fault(read.code);
    return read.value;
  }

  private async start(actor: string, input: ProductBuildCommand): Promise<{ receipt: ProductBuildReceipt; replayed: boolean }> {
    const payloadDigest = digest(JSON.stringify(input));
    const operationId = `pbuild_${payloadDigest}`;
    const requestKey = `pbuild_${digest(input.requestId).slice(0, 48)}`;
    let product = this.readProduct(actor, input.productId);
    const repository = product.repository;
    const prior = product.stageEvidence.find((item) => item.id === operationId);
    if (prior === undefined && this.store.receipt(actor, requestKey).ok) throw new Fault("idempotency_conflict");
    if (prior === undefined) {
      if (product.revision !== input.expectedRevision || product.objectiveRevision !== input.expectedObjectiveRevision) throw new Fault("stale_revision");
    } else if (product.objectiveRevision !== input.expectedObjectiveRevision) {
      throw new Fault("stale_revision");
    }
    if (!repository) throw new Fault("repository_missing");
    const subject: BuildRepository = { id: repository.id, owner: repository.owner, name: repository.name, defaultBranch: repository.defaultBranch };

    if (prior === undefined) {
      const root = this.options.root;
      if (root === undefined || !isAbsolute(root)) throw new Fault("unavailable");
      if (isStopped(root) || isPaused(root)) throw new Fault("fleet_halted");
      const live = await this.provider.read(repository.owner, repository.name);
      if (live.state === "unreadable") throw new Fault("provider_unreadable");
      if (live.state === "absent") throw new Fault("repository_not_found");
      const found = live.repository;
      if (found.id !== repository.id || found.owner.toLowerCase() !== repository.owner.toLowerCase() || found.name.toLowerCase() !== repository.name.toLowerCase() ||
        found.defaultBranch !== repository.defaultBranch) throw new Fault("repository_conflict");

      const plan = product.stageEvidence.find((item) => item.id === input.planEvidenceId);
      if (!plan || plan.stage !== "plan" || plan.outcome !== "succeeded" || plan.objectiveRevision !== product.objectiveRevision) throw new Fault("plan_not_approved");

      const inspected = await this.target.inspect(subject);
      if (inspected.enrolled === undefined) throw new Fault("target_unreadable");
      if (!inspected.enrolled) throw new Fault("target_not_enrolled");
      if (!this.target.runnerRegistered(subject)) throw new Fault("runner_missing");
      if (inspected.head === undefined || inspected.readmeOnly === undefined) throw new Fault("target_unreadable");
      if (!bootstrapConfirmed(product, inspected)) throw new Fault("bootstrap_unverified");

      const read = await this.target.task(subject, input.taskId);
      if (read.state === "unreadable") throw new Fault("task_unreadable");
      if (read.state === "absent") throw new Fault("task_not_found");
      const task = read.task;
      if (task.origin !== productPlanOrigin(product.id, input.planEvidenceId) || task.status !== "queued") throw new Fault("task_stale");
      if (task.merged) throw new Fault("task_merged");
      if (task.claimed) throw new Fault("task_claimed");
      const budget = product.brief.resourceEnvelope?.budgetUsd;
      if (budget === undefined || task.budgetUsd === undefined || task.budgetUsd > budget) throw new Fault("budget_exceeded");

      try { this.kick(root, input.taskId, `product:${product.id}`, subject.name); }
      catch (error) { throw Object.assign(new Fault("kick_failed"), { cause: error }); }
      const queued = this.append(actor, product, requestKey, { id: operationId, outcome: "queued", url: `https://github.com/${subject.owner}/${subject.name}` });
      product = queued;
    }
    const queuedEvidence = product.stageEvidence.find((item) => item.id === operationId);
    if (!queuedEvidence) throw new Fault("recovery_required");

    // Observation may add admitted/running evidence, each with its own record; absence adds nothing.
    const seen = await this.target.observe(subject, input.taskId);
    for (const outcome of ["admitted", "running"] as const) {
      const wanted = seen.state === "running" || (seen.state === "admitted" && outcome === "admitted");
      const id = `${operationId}:${outcome}`;
      if (!wanted || product.stageEvidence.some((item) => item.id === id)) continue;
      if (outcome === "running" && !(seen.state === "running" && seen.url)) continue;
      const url = (seen.state === "running" || seen.state === "admitted" ? seen.url : undefined) ?? `https://github.com/${subject.owner}/${subject.name}`;
      product = this.append(actor, product, `pbuild_${digest(id).slice(0, 48)}`, { id, outcome, url });
    }
    const evidence = product.stageEvidence.filter((item) => item.id === operationId || item.id.startsWith(`${operationId}:`))
      .map((item) => ({ outcome: item.outcome as ProductBuildOutcome, observedAt: item.observedAt }));
    const furthest = evidence.some((item) => item.outcome === "running") ? "running" : evidence.some((item) => item.outcome === "admitted") ? "admitted" : "queued";
    return {
      replayed: prior !== undefined,
      receipt: { operationId, productId: product.id, taskId: input.taskId, planEvidenceId: input.planEvidenceId, outcome: furthest,
        repository: { id: subject.id, owner: subject.owner, name: subject.name },
        objectiveRevision: product.objectiveRevision, payloadDigest, queuedAt: queuedEvidence.observedAt, evidence },
    };
  }

  private append(actor: string, product: StoredProduct, requestId: string, item: { id: string; outcome: ProductBuildOutcome; url: string }): StoredProduct {
    const saved = this.store.transition(actor, {
      version: "product-intent-v1", requestId, id: product.id, expectedRevision: product.revision, expectedObjectiveRevision: product.objectiveRevision,
      stageEvidence: [{ id: item.id, stage: "build", outcome: item.outcome, objectiveRevision: product.objectiveRevision,
        observedAt: this.now(), references: [{ label: "Target repository", url: item.url }] }],
    });
    if (!saved.ok) throw new Fault(saved.code);
    return this.readProduct(actor, product.id);
  }
}

/** The pure gate a source-task FILING caller applies before filing: README-only needs every receipt at the exact head. */
export function bootstrapConfirmed(product: Pick<StoredProduct, "stageEvidence">, inspected: Pick<TargetInspection, "head" | "readmeOnly">): boolean {
  if (inspected.head === undefined || inspected.readmeOnly === undefined) return false;
  return !inspected.readmeOnly || BOOTSTRAP_CHECKS.every((check) => product.stageEvidence.some((item) =>
    item.id === bootstrapEvidenceId(inspected.head!, check) && item.outcome === "succeeded"));
}
