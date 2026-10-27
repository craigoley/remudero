import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { ghTextAsync } from "./github-transport.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { isHumanHoldCandidate, type GhApiFetcher } from "./open-prs-rest.js";
import { ProductIntentStore } from "./product-intent-store.js";
import {
  productIdSchema, productRequestIdSchema, type ProductBrief, type ProductStoreCode, type StoredProduct,
} from "./product-intent.js";
import type { ProductRepositoryProvider } from "./product-repository.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { readReviewStatusEntry, resolveReviewProvenance, REVIEWER_IDENTITY_ENV } from "./review.js";

export const PRODUCT_PLAN_OPERATION_VERSION = "product-plan-operation-v1" as const;
/** PRIMARY CONTROL: maintained quotas on the plan-operation journal; none of it grants spend or planning authority. */
export const PRODUCT_PLAN_OPERATION_LIMITS = { operations: 256, stateBytes: 2 * 1024 * 1024, briefBytes: 60 * 1024 } as const;

/** Names a durable, reviewed handoff: the target task's `origin:` must carry exactly this (or an explicit association). */
export const productPlanOrigin = (productId: string, planEvidenceId: string) => `product-plan#${productId}/${planEvidenceId}`;

/** The reviewed task's design must carry the complete approved input the implementation worker consumes. */
export const productCasePlanText = (brief: ProductBrief) => `Approved product brief:\n${JSON.stringify(brief, (_key, value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value, 2)}`;

const layout = resolveRepoLayout(sep, () => undefined);
const shardDirectory = relative(layout.root, join(layout.planDir, "tasks.d")).split(sep).join("/");
const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const sha = /^[a-f0-9]{40}$/;
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

type GhText = (args: string[], opts?: { maxBuffer?: number; timeout?: number }) => Promise<string>;

// ── (4)+(5) ONE verification rule ─────────────────────────────────────────────────────────────────────────────

/** A frozen explicit link from a pre-existing task to this product's plan. It never rewrites that task's own origin. */
export interface ProductPlanAssociation { taskId: string; origin: string; pullRequest: number; head: string; merge: string }
export interface ProductPlanReceipt { head: string; reviewedHead: string; merge: string; url: string; review: "native-status" | "github-approval" }
export type ProductPlanRefusal = "plan_not_approved" | "task_stale" | "budget_exceeded" | "provider_unreadable";
export type ProductPlanVerdict =
  | { ok: true; value: { receipt?: ProductPlanReceipt; association?: ProductPlanAssociation }; code?: never }
  | { ok: false; code: ProductPlanRefusal; value?: never };

export interface ProductPlanVerification {
  product: Pick<StoredProduct, "id" | "brief" | "repository" | "stageEvidence">;
  planEvidenceId: string;
  taskId: string;
  /** `record`: the first verification, which may mint an association. `admit`: a re-check, which requires it already recorded. */
  purpose: "record" | "admit";
  /** The merged plan PR whose receipts are read. Omitted only for a plan record a trusted writer already verified. */
  pullRequest?: number;
  /** The target's CURRENT default-branch head: the task is read there, so any post-review drift refuses. */
  targetHead: string;
  /** The task as the build consumer already read it (origin and budget); the receipts' own current task is the fallback. */
  task?: { origin: string | undefined; budgetUsd: number | undefined };
  text?: GhText;
  /** The login a genuine remudero-review status is posted by; defaults to the reviewer identity the fleet is configured with. */
  trustedReviewer?: string;
}

/** The references a plan record carries to make an association explicit, or `undefined` when the origin cannot be labelled. */
export function productPlanAssociationReferences(association: ProductPlanAssociation, repo: { owner: string; name: string }) {
  const base = `https://github.com/${repo.owner}/${repo.name}`;
  const pull = `${base}/pull/${association.pullRequest}`;
  const labels = [
    { label: `Association ${association.taskId}`, url: pull }, { label: `Original origin ${association.origin}`, url: pull },
    { label: `Association head ${association.head}`, url: `${base}/commit/${association.head}` },
    { label: `Association merge ${association.merge}`, url: `${base}/commit/${association.merge}` },
  ];
  return labels.every((item) => item.label.length <= 120) ? labels : undefined;
}
const associationRecorded = (product: ProductPlanVerification["product"], planEvidenceId: string,
  want: Pick<ProductPlanAssociation, "taskId" | "origin"> & Partial<ProductPlanAssociation>, repo: { owner: string; name: string }) => {
  const item = product.stageEvidence.find((entry) => entry.id === planEvidenceId && entry.stage === "plan" && entry.outcome === "succeeded");
  if (!item) return false;
  const base = `https://github.com/${repo.owner}/${repo.name}`;
  const has = (label: string, url?: string) => item.references.some((ref) => ref.label === label && (url === undefined || ref.url === url));
  const pull = want.pullRequest === undefined ? undefined : `${base}/pull/${want.pullRequest}`;
  // Without receipts only the task and its original origin can be compared; with them, the exact PR, head and merge too.
  return has(`Association ${want.taskId}`, pull) && has(`Original origin ${want.origin}`, pull) &&
    (want.head === undefined || has(`Association head ${want.head}`, `${base}/commit/${want.head}`)) &&
    (want.merge === undefined || has(`Association merge ${want.merge}`, `${base}/commit/${want.merge}`));
};

/**
 * The ONE plan rule both {@link ProductCaseService} and `ProductBuildService.start` apply. With a pull request it reads
 * GitHub through the bounded default transport and requires: the PR merged into the verified repository's default branch;
 * a latest GitHub approval at the head OR the native contract (a trusted `remudero-review` success at the exact head, resolved
 * through its poster, on a plan-only PR); no standing CHANGES_REQUESTED review or human hold; one task content at the reviewed
 * head, the merge and the current target head; the complete approved brief in its design. Always: the task's origin is this
 * plan's, or an explicit recorded association; its budget fits the product's resource envelope. Nothing is waived: foreign,
 * stale, missing or ambiguous receipts refuse, and an unreadable source is never read as "approved".
 */
export async function verifyProductPlanEvidence(input: ProductPlanVerification): Promise<ProductPlanVerdict> {
  const repo = input.product.repository;
  const refuse = (code: ProductPlanRefusal): ProductPlanVerdict => ({ ok: false, code });
  if (!repo) return refuse("plan_not_approved");
  const text = input.text ?? ghTextAsync;
  const slug = `repos/${repo.owner}/${repo.name}`;
  const api = (path: string, raw = false) => text(["api", path, ...(raw ? ["-H", "Accept: application/vnd.github.raw+json"] : [])], { maxBuffer: 1024 * 1024, timeout: 20_000 });
  const expectedOrigin = productPlanOrigin(input.product.id, input.planEvidenceId);
  const taskRefusal: ProductPlanRefusal = input.task === undefined ? "plan_not_approved" : "task_stale";
  let receipt: ProductPlanReceipt | undefined;
  let current: { origin?: string; budget_usd?: number; design: string } | undefined;
  try {
    if (input.pullRequest !== undefined) {
      const pull = z.object({ number: revision, merged_at: z.string().nullable(), merge_commit_sha: z.string().regex(sha).nullable(),
        mergeable: z.boolean().nullable().optional(), mergeable_state: z.string().optional(),
        base: z.object({ ref: z.string(), repo: z.object({ id: revision }) }), head: z.object({ sha: z.string().regex(sha) }) })
        .parse(JSON.parse(await api(`${slug}/pulls/${input.pullRequest}`)));
      const reviews = z.array(z.object({ state: z.string(), commit_id: z.string(), user: z.object({ login: z.string() }).nullable() }))
        .parse(JSON.parse(await api(`${slug}/pulls/${input.pullRequest}/reviews?per_page=100`)));
      const latest = new Map<string, { state: string; commit_id: string }>();
      for (const review of reviews) if (review.user && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user.login, review);
      if (reviews.length >= 100 || pull.number !== input.pullRequest || !pull.merged_at || !pull.merge_commit_sha || pull.base.repo.id !== repo.id ||
        pull.base.ref !== repo.defaultBranch || [...latest.values()].some((review) => review.state === "CHANGES_REQUESTED")) return refuse("plan_not_approved");
      const files = z.array(z.object({ filename: z.string() })).parse(JSON.parse(await api(`${slug}/pulls/${input.pullRequest}/files?per_page=100`)));
      let review: "native-status" | "github-approval" = "github-approval";
      if (![...latest.values()].some((entry) => entry.state === "APPROVED" && entry.commit_id === pull.head.sha)) {
        // The native contract: the trusted reviewer's own success status at the EXACT head, on a plan-only pull request.
        const trusted = (input.trustedReviewer ?? process.env[REVIEWER_IDENTITY_ENV] ?? "").trim();
        if (!trusted || files.length >= 100 || !files.every((file) => file.filename.startsWith("plan/") || file.filename === "MASTER-PLAN.md")) return refuse("plan_not_approved");
        const fetcher: GhApiFetcher = async (args) => JSON.parse(await text(args, { maxBuffer: 1024 * 1024, timeout: 20_000 })) as unknown;
        const entry = await readReviewStatusEntry(repo.owner, repo.name, pull.head.sha, fetcher);
        if (resolveReviewProvenance(entry, trusted) !== "success") return refuse("plan_not_approved");
        review = "native-status";
      }
      if (isHumanHoldCandidate({ autoMergeArmed: false, isPlanFiling: true, checksState: "green", reviewState: "success",
        mergeable: pull.mergeable ?? undefined, mergeableState: pull.mergeable_state, changedFiles: files.map((file) => file.filename) })) return refuse("plan_not_approved");
      const names = z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+$/) })).parse(JSON.parse(await api(`${slug}/contents/${shardDirectory}?ref=${input.targetHead}`)));
      const shard = names.find((entry) => entry.name.startsWith(`${input.taskId}-`) && entry.name.endsWith(".yaml"));
      if (!shard) return refuse("plan_not_approved");
      const shardPath = `${shardDirectory}/${shard.name}`;
      if (!files.some((file) => file.filename === shardPath)) return refuse("plan_not_approved");
      const tasks = z.array(z.object({ id: z.string(), origin: z.string().optional(), design: z.string(), budget_usd: z.number().optional() }).passthrough());
      const read = async (ref: string) => tasks.parse(parseYaml(await api(`${slug}/contents/${shardPath}?ref=${ref}`, true))).find((task) => task.id === input.taskId);
      const [now, reviewed, merged] = [await read(input.targetHead), await read(pull.head.sha), await read(pull.merge_commit_sha)];
      if (!now || !reviewed || !merged || digest(now) !== digest(reviewed) || digest(now) !== digest(merged) ||
        !now.design.includes(productCasePlanText(input.product.brief))) return refuse("plan_not_approved");
      current = now;
      receipt = { head: input.targetHead, reviewedHead: pull.head.sha, merge: pull.merge_commit_sha, url: `https://github.com/${repo.owner}/${repo.name}/pull/${input.pullRequest}`, review };
    }
  } catch (error) {
    // A GitHub read or parse that failed is its own refusal: an unreadable receipt is never "approved" and never "absent".
    void error; return refuse("provider_unreadable");
  }
  const task = input.task ?? (current ? { origin: current.origin, budgetUsd: current.budget_usd } : undefined);
  if (!task) return refuse("plan_not_approved");
  let association: ProductPlanAssociation | undefined;
  if (task.origin !== expectedOrigin) {
    // A legitimate pre-existing task keeps its own origin and id: it passes only through an explicit, exact association.
    if (task.origin === undefined || (input.pullRequest !== undefined && !(current?.design ?? "").includes(expectedOrigin))) return refuse(taskRefusal);
    const exact: ProductPlanAssociation | undefined = receipt && input.pullRequest !== undefined
      ? { taskId: input.taskId, origin: task.origin, pullRequest: input.pullRequest, head: receipt.reviewedHead, merge: receipt.merge } : undefined;
    if (input.purpose === "record") {
      if (!exact || !productPlanAssociationReferences(exact, repo)) return refuse(taskRefusal);
      association = exact;
    } else if (!associationRecorded(input.product, input.planEvidenceId, exact ?? { taskId: input.taskId, origin: task.origin }, repo)) return refuse(taskRefusal);
  }
  const budget = input.product.brief.resourceEnvelope?.budgetUsd;
  if (budget === undefined || task.budgetUsd === undefined || task.budgetUsd > budget) return refuse("budget_exceeded");
  return { ok: true, value: { ...(receipt ? { receipt } : {}), ...(association ? { association } : {}) } };
}

// ── (1)-(3) the durable saved-product plan operation ─────────────────────────────────────────────────────────

export const productPlanProposalSchema = z.object({
  requestId: productRequestIdSchema, productId: productIdSchema, expectedRevision: revision, expectedObjectiveRevision: revision,
}).strict();
export type ProductPlanProposal = z.infer<typeof productPlanProposalSchema>;

/** The ledger task id a hand-off's `ratify.cli_*` rows carry; panel-graph.ts's productPlan gateway writes the same string. */
export const productPlanLedgerTaskId = (operationId: string) => `product-plan:${operationId}`;

export type ProductPlanState = "pending" | "proposed" | "refused" | "unknown" | "changed-brief" | "stale-target";
export interface ProductPlanObservation {
  operationId: string; state: ProductPlanState; mode: "create" | "clarify"; planEvidenceId: string;
  repository: { id: number; owner: string; name: string }; targetHead: string;
  revision: number; objectiveRevision: number; briefDigest: string; requestedAt: string; proposal?: string;
}
export type ProductPlanOperationCode = ProductStoreCode
  | "repository_missing" | "repository_not_found" | "repository_conflict" | "provider_unreadable"
  | "target_not_enrolled" | "target_unreadable" | "runner_missing" | "bootstrap_unverified"
  | "envelope_missing" | "handoff_unavailable";
export type ProductPlanOperationResult =
  | { ok: true; value: { observation: ProductPlanObservation; replayed: boolean }; code?: never }
  | { ok: false; code: ProductPlanOperationCode; value?: never };

export interface PlanRepository { id: number; owner: string; name: string; defaultBranch: string }
/** The two target reads this operation needs; `ProductBuildTarget` satisfies it, and nothing here imports it. */
export interface PlanTargetPort {
  inspect(repository: PlanRepository): Promise<{ enrolled: boolean | undefined; head: string | undefined; readmeOnly: boolean | undefined }>;
  runnerRegistered(repository: PlanRepository): boolean;
}
export type PlanHandoffOutcome = "queued" | "refused" | "unknown";
export interface PlanHandoffPort {
  productPlan?(target: { operationId: string; mode: "create" | "clarify"; brief: string; repoRoot: string }): Promise<{ outcome: PlanHandoffOutcome }>;
}

export interface ProductPlanOperationOptions {
  root?: string;
  store?: ProductIntentStore;
  provider: Pick<ProductRepositoryProvider, "read">;
  target: PlanTargetPort;
  bootstrapConfirmed: (product: Pick<StoredProduct, "stageEvidence">, inspected: { head: string | undefined; readmeOnly: boolean | undefined }) => boolean;
  /** The public gateway port. Without its owned fresh-source runner the operation refuses before it journals anything. */
  gateway?: PlanHandoffPort;
  /** The core ledger the gateway's `ratify.cli_*` rows and the native plan run's own rows land in. */
  ledgerPath?: string;
  /** The verified managed checkout of the target repository, or `undefined` when it is not there. */
  checkout: (repository: PlanRepository) => string | undefined;
  text?: GhText;
  clock?: Clock;
  isAlive?: (pid: number) => boolean;
  sync?: (fd: number) => void;
}

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const modeSchema = z.enum(["create", "clarify"]);
const recordSchema = z.object({
  operationId: hex64, productId: productIdSchema, revision, objectiveRevision: revision, briefDigest: hex64,
  repository: z.object({ id: revision, owner: z.string().min(1).max(64), name: z.string().min(1).max(128) }).strict(),
  targetHead: z.string().regex(sha), mode: modeSchema, planEvidenceId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  command: z.object({ verb: z.literal("plan"), mode: modeSchema, repoRoot: z.string().min(1).max(1024), briefBytes: z.number().int().positive(), briefDigest: hex64 }).strict(),
  requestedAt: z.string().datetime(),
  handoff: z.object({ outcome: z.enum(["queued", "refused", "unknown"]), at: z.string().datetime() }).strict().optional(),
}).strict();
type Record_ = z.infer<typeof recordSchema>;
const journalSchema = z.object({
  version: z.literal(PRODUCT_PLAN_OPERATION_VERSION), ownerKey: hex64,
  operations: z.record(hex64, recordSchema), requests: z.record(hex64, z.object({ operationId: hex64, payloadDigest: hex64 }).strict()),
}).strict();
type Journal = z.infer<typeof journalSchema>;
interface Paths { directory: string; state: string; ownerKey: string }

class Fault extends RmdError {
  constructor(readonly code: ProductPlanOperationCode) { super("usage", GENERIC_EXIT_CODE, `product plan operation: ${code}`); }
}
const errno = (error: unknown, code: string) => (error as NodeJS.ErrnoException | undefined)?.code === code;
const processAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) {
    // Signal 0 only probes: EPERM means the process exists under another user; any other failure means it is gone.
    return errno(error, "EPERM");
  }
};

/**
 * Turns a saved, verified product brief into ONE native `rmd plan` run against the managed target checkout, through the
 * maintained gateway port and never a launcher of its own. The operation is journaled (private, fsynced) BEFORE the hand-off;
 * every later request, reload or restart reads the same record and the correlated ledger rows, never a branch name.
 */
export class ProductPlanOperationService {
  private readonly store: ProductIntentStore;
  private readonly clock: Clock;
  private readonly sync: (fd: number) => void;
  private readonly flying = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ProductPlanOperationOptions) {
    this.store = options.store ?? new ProductIntentStore({ root: options.root });
    this.clock = options.clock ?? systemClock;
    this.sync = options.sync ?? fsyncSync;
  }

  execute(actor: string, command: unknown): Promise<ProductPlanOperationResult> {
    const run = this.enqueue(() => this.run(actor, command));
    return run;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(() => undefined, () => undefined /* the caller awaits `run`; the tail only orders the chain */);
    return run;
  }

  private async run(actor: string, command: unknown): Promise<ProductPlanOperationResult> {
    try {
      if (typeof actor !== "string" || !actor.trim() || actor.length > 512) throw new Fault("invalid_identity");
      const parsed = productPlanProposalSchema.safeParse(command);
      if (!parsed.success) throw new Fault("invalid_input");
      return { ok: true, value: await this.propose(actor, parsed.data) };
    } catch (error) {
      return { ok: false, code: error instanceof Fault ? error.code : "unavailable" };
    }
  }

  private readProduct(actor: string, id: string): StoredProduct {
    const read = this.store.read(actor, id);
    if (!read.ok) throw new Fault(read.code);
    return read.value;
  }

  private async propose(actor: string, input: ProductPlanProposal): Promise<{ observation: ProductPlanObservation; replayed: boolean }> {
    const paths = this.paths(actor);
    let journal = this.readJournal(paths);
    const requestKey = digest(input.requestId);
    const payloadDigest = digest(input);
    const known = journal.requests[requestKey];
    if (known && known.payloadDigest !== payloadDigest) throw new Fault("idempotency_conflict");
    let product = this.readProduct(actor, input.productId);
    const repository = product.repository;
    let record = known ? journal.operations[known.operationId] : undefined;
    if (known && !record) throw new Fault("corrupt");
    let replayed = known !== undefined;
    let head: string | undefined;
    if (!record) {
      // A fresh request: everything the operation will freeze is verified against the live target first.
      if (!repository) throw new Fault("repository_missing");
      if (!product.brief.resourceEnvelope) throw new Fault("envelope_missing");
      if (product.revision !== input.expectedRevision || product.objectiveRevision !== input.expectedObjectiveRevision) throw new Fault("stale_revision");
      if (this.options.gateway === undefined || typeof this.options.gateway.productPlan !== "function") throw new Fault("handoff_unavailable");
      const subject: PlanRepository = { id: repository.id, owner: repository.owner, name: repository.name, defaultBranch: repository.defaultBranch };
      const live = await this.options.provider.read(repository.owner, repository.name);
      if (live.state === "unreadable") throw new Fault("provider_unreadable");
      if (live.state === "absent") throw new Fault("repository_not_found");
      if (live.repository.id !== repository.id || live.repository.owner.toLowerCase() !== repository.owner.toLowerCase() ||
        live.repository.name.toLowerCase() !== repository.name.toLowerCase() || live.repository.defaultBranch !== repository.defaultBranch) throw new Fault("repository_conflict");
      const inspected = await this.options.target.inspect(subject);
      if (inspected.enrolled === undefined || inspected.head === undefined || inspected.readmeOnly === undefined) throw new Fault("target_unreadable");
      if (!inspected.enrolled) throw new Fault("target_not_enrolled");
      if (!this.options.target.runnerRegistered(subject)) throw new Fault("runner_missing");
      if (!this.options.bootstrapConfirmed(product, inspected)) throw new Fault("bootstrap_unverified");
      head = inspected.head;
      const briefDigest = digest(productCasePlanText(product.brief));
      const operationId = digest(`${product.id}\n${product.objectiveRevision}\n${briefDigest}\n${head}`);
      const sameBrief = Object.values(journal.operations).filter((entry) => entry.productId === product.id &&
        entry.objectiveRevision === product.objectiveRevision && entry.briefDigest === briefDigest);
      // The same product, objective and brief never gets a second plan while one is in flight or its fate is unknown.
      const reusable = journal.operations[operationId] ?? sameBrief.find((entry) => {
        const state = this.state(entry, product, head);
        return state === "pending" || state === "unknown" || state === "stale-target";
      });
      if (reusable) {
        record = reusable;
        replayed = true;
        journal = this.bind(paths, journal, requestKey, { operationId: reusable.operationId, payloadDigest });
      } else {
        if (Object.keys(journal.operations).length >= PRODUCT_PLAN_OPERATION_LIMITS.operations) throw new Fault("capacity");
        const checkout = this.options.checkout(subject);
        if (checkout === undefined || !isAbsolute(checkout)) throw new Fault("target_unreadable");
        const mode = await this.planMode(subject, head);
        const planEvidenceId = `pplan-${operationId.slice(0, 24)}`;
        const brief = this.briefArgument(product, planEvidenceId, operationId);
        if (Buffer.byteLength(brief) > PRODUCT_PLAN_OPERATION_LIMITS.briefBytes) throw new Fault("invalid_input");
        record = { operationId, productId: product.id, revision: product.revision, objectiveRevision: product.objectiveRevision, briefDigest,
          repository: { id: subject.id, owner: subject.owner, name: subject.name }, targetHead: head, mode, planEvidenceId,
          command: { verb: "plan", mode, repoRoot: checkout, briefBytes: Buffer.byteLength(brief), briefDigest: digest(brief) }, requestedAt: this.clock.iso() };
        // The durable record exists BEFORE the hand-off: a crash after this line replays it and never plans twice.
        journal = { ...journal, operations: { ...journal.operations, [operationId]: record }, requests: { ...journal.requests, [requestKey]: { operationId, payloadDigest } } };
        this.commit(paths, journal);
        product = this.append(actor, product, { id: `pplan-op:${operationId.slice(0, 32)}`, outcome: "queued", repository: record.repository });
        this.handOff(paths, record, brief);
      }
    } else {
      try { this.syncDirectory(paths.directory); } catch (error) { void error; throw new Fault("outcome_unknown"); }
    }
    // A reload may follow a lost response or a restart: the live head is read only to tell a stale target, never to retry.
    if (head === undefined && repository) {
      try {
        head = (await this.options.target.inspect({ id: repository.id, owner: repository.owner, name: repository.name, defaultBranch: repository.defaultBranch })).head;
      } catch (error) {
        // An unreadable head tells nothing: the state is then read without it, never as "stale".
        void error; head = undefined;
      }
    }
    product = this.readProduct(actor, input.productId);
    const observation = this.observe(record, product, head);
    product = this.settle(actor, product, observation);
    return { observation: this.observe(record, product, head), replayed };
  }

  private bind(paths: Paths, journal: Journal, requestKey: string, entry: { operationId: string; payloadDigest: string }): Journal {
    const next = { ...journal, requests: { ...journal.requests, [requestKey]: entry } };
    this.commit(paths, next);
    return next;
  }

  private briefArgument(product: StoredProduct, planEvidenceId: string, operationId: string): string {
    const envelope = product.brief.resourceEnvelope!;
    const constraints = (product.brief.constraints ?? []).map((item) => `- ${item}`).join("\n");
    return [productCasePlanText(product.brief), constraints ? `Constraints:\n${constraints}` : "",
      `Resource envelope: budgetUsd=${envelope.budgetUsd} maxConcurrentBuilds=${envelope.maxConcurrentBuilds} existingSetupOnly=${envelope.existingSetupOnly}`,
      `Task origin: ${productPlanOrigin(product.id, planEvidenceId)}`, `Operation: ${operationId}`].filter(Boolean).join("\n\n");
  }

  /** `clarify` when the verified head already holds a plan to reconcile; `create` only when it holds none. */
  private async planMode(subject: PlanRepository, head: string): Promise<"create" | "clarify"> {
    const text = this.options.text ?? ghTextAsync;
    try {
      const names = z.array(z.object({ name: z.string() })).parse(JSON.parse(await text(
        ["api", `repos/${subject.owner}/${subject.name}/contents/${shardDirectory}?ref=${head}`], { maxBuffer: 1024 * 1024, timeout: 20_000 })));
      return names.some((entry) => entry.name.endsWith(".yaml")) ? "clarify" : "create";
    } catch (error) {
      // Only an ABSENT directory is "no plan"; an unreadable one is never guessed into a second plan.
      if (/404|not found/i.test(String((error as Error)?.message ?? error))) return "create";
      throw Object.assign(new Fault("target_unreadable"), { cause: error });
    }
  }

  /** Starts the one hand-off and returns at once; the gateway's owner keeps the child's lifetime through its completion. */
  private handOff(paths: Paths, record: Record_, brief: string): void {
    const gateway = this.options.gateway!;
    this.flying.add(record.operationId);
    const finished = (outcome: PlanHandoffOutcome) => this.enqueue(async () => {
      this.flying.delete(record.operationId);
      const journal = this.readJournal(paths);
      const stored = journal.operations[record.operationId];
      if (!stored) return;
      this.commit(paths, { ...journal, operations: { ...journal.operations, [record.operationId]: { ...stored, handoff: { outcome, at: this.clock.iso() } } } });
    }).catch((error: unknown) => { void error; /* the journal keeps its last durable state; the ledger rows still say what ran */ });
    let started: Promise<{ outcome: PlanHandoffOutcome }>;
    try { started = gateway.productPlan!({ operationId: record.operationId, mode: record.mode, brief, repoRoot: record.command.repoRoot }); }
    catch (error) {
      // A gateway that throws before returning a promise has handed nothing off; the outcome is recorded unknown, never retried.
      void error; started = Promise.resolve({ outcome: "unknown" as const });
    }
    void started.then((result) => finished(result.outcome), () => finished("unknown"));
  }

  /** The state this record is in NOW: the ledger's correlated rows first, the live brief and target head only on top. */
  private state(record: Record_, product: StoredProduct, liveHead: string | undefined): ProductPlanState {
    return this.observe(record, product, liveHead).state;
  }

  private observe(record: Record_, product: StoredProduct, liveHead: string | undefined): ProductPlanObservation {
    const seen = this.ledger(record);
    let state: ProductPlanState;
    if (seen.opened !== undefined) state = "proposed";
    else if (seen.exited) state = "refused";
    else if (seen.failed) state = "unknown";
    else if (seen.pid !== undefined) state = (this.options.isAlive ?? processAlive)(seen.pid) ? "pending" : "unknown";
    else if (this.flying.has(record.operationId)) state = "pending";
    else state = record.handoff?.outcome === "refused" ? "refused" : "unknown";
    if (state !== "proposed") {
      if (product.objectiveRevision !== record.objectiveRevision || digest(productCasePlanText(product.brief)) !== record.briefDigest) state = "changed-brief";
      else if (liveHead !== undefined && liveHead !== record.targetHead) state = "stale-target";
    }
    return { operationId: record.operationId, state, mode: record.mode, planEvidenceId: record.planEvidenceId, repository: record.repository,
      targetHead: record.targetHead, revision: record.revision, objectiveRevision: record.objectiveRevision, briefDigest: record.briefDigest,
      requestedAt: record.requestedAt, ...(seen.opened !== undefined ? { proposal: seen.opened } : {}) };
  }

  /**
   * What the core ledger shows for THIS operation: the gateway's `ratify.cli_started` row (bound by the operation id it
   * carries), the native plan run that child's pid wrote (`plan.start` with `actor_pid`), and that run's own `pr.opened`.
   * A pull request outside the target repository, or a run no row ties to the child, is never this proposal.
   */
  private ledger(record: Record_): { pid?: number; exited: boolean; failed: boolean; opened?: string } {
    const none = { exited: false, failed: false };
    if (this.options.ledgerPath === undefined) return none;
    const taskId = productPlanLedgerTaskId(record.operationId);
    const read = readLedgerUnionRecordsSync(dirname(this.options.ledgerPath), { sinceTs: record.requestedAt, refuseIncomplete: true,
      keep: (line) => line.includes(taskId) || line.includes("plan.start") || line.includes("pr.opened") });
    if (!read.ok) return none;
    const at = (row: Record<string, unknown>) => (typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN);
    const rows = read.rows.filter((row) => Number.isFinite(at(row))).sort((a, b) => at(a) - at(b));
    const mine = rows.filter((row) => row.task_id === taskId);
    const started = mine.find((row) => row.step === "ratify.cli_started" && typeof row.pid === "number");
    const pid = started?.pid as number | undefined;
    const exited = mine.some((row) => row.step === "ratify.cli_exited");
    const failed = mine.some((row) => row.step === "ratify.handoff_failed");
    const run = started === undefined ? undefined : rows.find((row) => row.step === "plan.start" && row.actor_pid === pid && at(row) >= Date.parse(record.requestedAt));
    const pull = run === undefined ? undefined : rows.find((row) => row.step === "pr.opened" && row.run_id === run.run_id && typeof row.pr_url === "string");
    const url = pull?.pr_url as string | undefined;
    const own = url !== undefined && url.startsWith(`https://github.com/${record.repository.owner}/${record.repository.name}/pull/`) && /^\d+$/.test(url.slice(url.lastIndexOf("/") + 1));
    return { ...(pid !== undefined ? { pid } : {}), exited, failed, ...(own ? { opened: url } : {}) };
  }

  /** Terminal fates become the product's own supported stage evidence, once each. */
  private settle(actor: string, product: StoredProduct, observation: ProductPlanObservation): StoredProduct {
    const base = `pplan-op:${observation.operationId.slice(0, 32)}`;
    const terminal = observation.state === "proposed" ? { id: `${base}:proposed`, outcome: "proposed" as const, url: observation.proposal! }
      : observation.state === "refused" ? { id: `${base}:refused`, outcome: "failed" as const, url: undefined } : undefined;
    if (!terminal || product.stageEvidence.some((item) => item.id === terminal.id)) return product;
    return this.append(actor, product, { id: terminal.id, outcome: terminal.outcome, repository: observation.repository, url: terminal.url });
  }

  private append(actor: string, product: StoredProduct, item: { id: string; outcome: "queued" | "proposed" | "failed"; repository: { owner: string; name: string }; url?: string }): StoredProduct {
    if (product.stageEvidence.some((known) => known.id === item.id)) return product;
    const saved = this.store.transition(actor, {
      version: "product-intent-v1", requestId: `pplan_${digest(`${product.id}:${item.id}`).slice(0, 48)}`, id: product.id,
      expectedRevision: product.revision, expectedObjectiveRevision: product.objectiveRevision,
      stageEvidence: [{ id: item.id, stage: "plan", outcome: item.outcome, objectiveRevision: product.objectiveRevision, observedAt: this.clock.iso(),
        references: [{ label: item.url === undefined ? "Target repository" : "Plan proposal", url: item.url ?? `https://github.com/${item.repository.owner}/${item.repository.name}` }] }],
    });
    if (!saved.ok) throw new Fault(saved.code);
    return this.readProduct(actor, product.id);
  }

  // ── private journal: atomic, fsynced, owner-keyed ───────────────────────────────────────────────────────

  private paths(actor: string): Paths {
    if (!this.options.root || !isAbsolute(this.options.root)) throw new Fault("unavailable");
    const ownerKey = digest(actor);
    const directory = join(realpathSync(this.options.root), "state", "products", "v1", "plan-operations");
    return { directory, state: join(directory, `${ownerKey}.json`), ownerKey };
  }

  private ensureDirectory(paths: Paths): void {
    try { mkdirSync(paths.directory, { recursive: true, mode: 0o700 }); }
    catch (error) { void error; throw new Fault("unavailable"); }
    const info = lstatSync(paths.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Fault("unavailable");
  }

  private syncDirectory(directory: string): void {
    const fd = openSync(directory, constants.O_RDONLY);
    try { this.sync(fd); } finally { closeSync(fd); }
  }

  private readJournal(paths: Paths): Journal {
    let fd: number | undefined;
    try {
      fd = openSync(paths.state, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1 || (info.mode & 0o077) !== 0 || info.size > PRODUCT_PLAN_OPERATION_LIMITS.stateBytes) throw new Fault("unavailable");
      const buffer = Buffer.alloc(info.size);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      let raw: unknown;
      try { raw = size === info.size ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) : undefined; }
      catch (error) { void error; throw new Fault("corrupt"); }
      const parsed = journalSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerKey !== paths.ownerKey) throw new Fault("corrupt");
      return parsed.data;
    } catch (error) {
      if (errno(error, "ENOENT")) return { version: PRODUCT_PLAN_OPERATION_VERSION, ownerKey: paths.ownerKey, operations: {}, requests: {} };
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** Atomic replace. A failure before the rename is `unavailable`; after it the outcome is unknowable. */
  private commit(paths: Paths, journal: Journal): void {
    const body = JSON.stringify(journal);
    if (Buffer.byteLength(body) > PRODUCT_PLAN_OPERATION_LIMITS.stateBytes) throw new Fault("capacity");
    this.ensureDirectory(paths);
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
      void error;
      if (!renamed && existsSync(temporary)) { try { unlinkSync(temporary); } catch (cleanup) { void cleanup; /* a stage that cannot be removed is reaped with the directory */ } }
      throw new Fault(renamed ? "outcome_unknown" : "unavailable");
    }
  }
}
