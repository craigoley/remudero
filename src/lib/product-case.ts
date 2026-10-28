import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { systemClock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import {
  bootstrapConfirmed, ghProductBuildTarget, productBuildCommandSchema, ProductBuildService,
  type ProductBuildCode, type ProductBuildOptions, type ProductBuildReceipt,
} from "./product-build.js";
import {
  productCasePlanText, productPlanAssociationReferences, productPlanProposalSchema, ProductPlanOperationService, verifyProductPlanEvidence,
  type PlanHandoffPort, type PlanRepository, type ProductPlanObservation, type ProductPlanOperationCode,
} from "./product-plan-operation.js";
import { ProductIntentStore } from "./product-intent-store.js";
import { productIdSchema, productRequestIdSchema, productTransitionSchema, productWriteSchema, type StoredProduct } from "./product-intent.js";
import { ghProductRepositoryProvider, productRepositoryCommandSchema, ProductRepositoryService, type ProductRepositoryCode } from "./product-repository.js";

export const PRODUCT_CASE_VERSION = "product-case-v1" as const;
/** PRIMARY CONTROL: the import includes a bounded brief; no command grants execution authority. */
export const PRODUCT_CASE_LIMITS = { requestBytes: 64 * 1024 } as const;
export { productCasePlanText };
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const planCommandSchema = z.object({
  requestId: productRequestIdSchema, productId: productIdSchema, expectedRevision: revision, expectedObjectiveRevision: revision,
  planEvidenceId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  taskId: productBuildCommandSchema.shape.taskId, pullRequest: revision,
}).strict();
export const productCaseCommandSchema = z.discriminatedUnion("action", [
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("import"),
    command: productWriteSchema.refine((value) => value.id === undefined && value.expectedRevision === 0) }).strict(),
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("adopt"),
    command: productRepositoryCommandSchema.refine((value) => value.action === "adopt") }).strict(),
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("plan"), command: planCommandSchema }).strict(),
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("build"), command: productBuildCommandSchema }).strict(),
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("propose"), command: productPlanProposalSchema }).strict(),
]);
type PlanCommand = z.infer<typeof planCommandSchema>;
type EvidenceReference = { id: string; reference: string };
export interface ProductCaseReply {
  productId: string; revision: number; objectiveRevision: number; replayed: boolean;
  evidence: Record<"source" | "local" | "hosted" | "review" | "merge" | "deploy" | "mobile", EvidenceReference[]>;
  build?: ProductBuildReceipt;
  planOperation?: ProductPlanObservation;
}
export type ProductCaseCode = ProductBuildCode | ProductRepositoryCode | ProductPlanOperationCode;
/** The plan-operation seams the served composition supplies; every default is the real one. */
export interface ProductCaseOptions extends ProductBuildOptions {
  /** The maintained gateway port (`RatifyCliGateway`); without its owned runner a proposal refuses before journaling. */
  planGateway?: PlanHandoffPort;
  /** The core ledger the hand-off's `ratify.cli_*` rows and the native plan run's rows land in. */
  planLedgerPath?: string;
  /** The verified managed checkout of a target repository; defaults to its sibling `repos/<name>` clone. */
  planCheckout?: (repository: PlanRepository) => string | undefined;
  planIsAlive?: (pid: number) => boolean;
}
export type ProductCaseResult = { ok: true; value: ProductCaseReply; code?: never } | { ok: false; code: ProductCaseCode; value?: never };
class CaseFault extends RmdError {
  constructor(readonly code: ProductCaseCode) { super("usage", GENERIC_EXIT_CODE, `product case: ${code}`); }
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Resumable adoption case. Durable state and all external actions use the existing product mechanisms. */
export class ProductCaseService {
  private readonly store: ProductIntentStore;
  private readonly builds: ProductBuildService;
  private readonly repositories: ProductRepositoryService;
  private readonly plans: ProductPlanOperationService;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ProductCaseOptions) {
    this.store = options.store ?? new ProductIntentStore({ root: options.root });
    this.builds = new ProductBuildService({ ...options, store: this.store });
    this.repositories = new ProductRepositoryService({ root: options.root });
    const checkout = (repository: PlanRepository) => {
      if (options.repoRoot === undefined) return undefined;
      const path = join(dirname(options.repoRoot), repository.name);
      return existsSync(join(path, ".git")) ? path : undefined;
    };
    this.plans = new ProductPlanOperationService({ root: options.root, store: this.store, provider: options.provider ?? ghProductRepositoryProvider(),
      target: options.target ?? ghProductBuildTarget({ repoRoot: options.repoRoot, text: options.planText }), bootstrapConfirmed, gateway: options.planGateway,
      ledgerPath: options.planLedgerPath, checkout: options.planCheckout ?? checkout, text: options.planText, clock: options.clock, isAlive: options.planIsAlive });
  }

  execute(actor: string, command: unknown): Promise<ProductCaseResult> {
    const run = this.chain.then(() => this.run(actor, command));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private read(actor: string, id: string): StoredProduct {
    const result = this.store.read(actor, id);
    if (!result.ok) throw new CaseFault(result.code);
    return result.value;
  }

  private async run(actor: string, command: unknown): Promise<ProductCaseResult> {
    try {
      if (typeof actor !== "string" || !actor.trim() || actor.length > 512) throw new CaseFault("invalid_identity");
      const parsed = productCaseCommandSchema.safeParse(command);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > PRODUCT_CASE_LIMITS.requestBytes) throw new CaseFault("invalid_input");
      const input = parsed.data;
      let id: string;
      let replayed: boolean;
      let build: ProductBuildReceipt | undefined;
      let planOperation: ProductPlanObservation | undefined;
      if (input.action === "import") {
        const saved = this.store.write(actor, input.command);
        if (!saved.ok) throw new CaseFault(saved.code);
        id = saved.value.receipt.productId; replayed = saved.value.replayed;
      } else {
        id = input.command.productId;
        const product = this.read(actor, id);
        if (input.action === "adopt") {
          const adopted = await this.repositories.execute(actor, input.command);
          if (!adopted.ok) throw new CaseFault(adopted.code);
          replayed = adopted.value.replayed;
        } else if (input.action === "plan") {
          replayed = await this.plan(actor, product, input.command);
        } else if (input.action === "propose") {
          const proposed = await this.plans.execute(actor, input.command);
          if (!proposed.ok) throw new CaseFault(proposed.code);
          replayed = proposed.value.replayed; planOperation = proposed.value.observation;
        } else {
          if (!product.repository) throw new CaseFault("repository_missing");
          const evidence = product.stageEvidence.find((item) => item.id === input.command.planEvidenceId && item.stage === "plan");
          const review = evidence?.references.find((item) => item.label === `Reviewed task ${input.command.taskId}`);
          const match = review && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/.exec(review.url);
          if (!match) throw new CaseFault("plan_not_approved");
          // The build service applies the SAME shared plan rule to this plan record immediately before admitting the task.
          const started = await this.builds.execute(actor, input.command);
          if (!started.ok) throw new CaseFault(started.code);
          replayed = started.value.replayed; build = started.value.receipt;
        }
      }
      const product = this.read(actor, id);
      return { ok: true, value: { productId: id, revision: product.revision, objectiveRevision: product.objectiveRevision,
        replayed, evidence: this.evidence(product), ...(build ? { build } : {}), ...(planOperation ? { planOperation } : {}) } };
    } catch (error) {
      return { ok: false, code: error instanceof CaseFault ? error.code : "unavailable" };
    }
  }

  private async verifyPlan(product: StoredProduct, input: Pick<PlanCommand, "planEvidenceId" | "taskId" | "pullRequest">, purpose: "record" | "admit") {
    const repo = product.repository;
    if (!repo) throw new CaseFault("repository_missing");
    const subject = { id: repo.id, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch };
    const live = await (this.options.provider ?? ghProductRepositoryProvider()).read(repo.owner, repo.name);
    if (live.state === "unreadable") throw new CaseFault("provider_unreadable");
    if (live.state === "absent") throw new CaseFault("repository_not_found");
    if (live.repository.id !== repo.id || live.repository.owner.toLowerCase() !== repo.owner.toLowerCase() ||
      live.repository.name.toLowerCase() !== repo.name.toLowerCase() || live.repository.defaultBranch !== repo.defaultBranch) throw new CaseFault("repository_conflict");
    const target = this.options.target ?? ghProductBuildTarget({ repoRoot: this.options.repoRoot, text: this.options.planText });
    const inspected = await target.inspect(subject);
    if (inspected.enrolled === undefined || inspected.head === undefined || inspected.readmeOnly === undefined) throw new CaseFault("target_unreadable");
    if (!inspected.enrolled) throw new CaseFault("target_not_enrolled");
    if (!target.runnerRegistered(subject)) throw new CaseFault("runner_missing");
    if (!bootstrapConfirmed(product, inspected)) throw new CaseFault("bootstrap_unverified");
    const verdict = await verifyProductPlanEvidence({ product, planEvidenceId: input.planEvidenceId, taskId: input.taskId, purpose, pullRequest: input.pullRequest,
      targetHead: inspected.head, text: this.options.planText, trustedReviewer: this.options.planTrustedReviewer });
    if (!verdict.ok) throw new CaseFault(verdict.code);
    const receipt = verdict.value.receipt!;
    return { head: inspected.head, merge: receipt.merge, url: receipt.url, association: verdict.value.association };
  }

  private async plan(actor: string, product: StoredProduct, input: PlanCommand): Promise<boolean> {
    const existing = product.stageEvidence.find((item) => item.id === input.planEvidenceId);
    const commandLabel = `Case command ${digest(input)}`;
    if (existing && !existing.references.some((ref) => ref.label === commandLabel)) throw new CaseFault("idempotency_conflict");
    if ((!existing && product.revision !== input.expectedRevision) || product.objectiveRevision !== input.expectedObjectiveRevision) throw new CaseFault("stale_revision");
    if (existing) {
      const receipt = this.store.receipt(actor, input.requestId);
      if (!receipt.ok) throw new CaseFault(receipt.code);
      return true;
    }
    const verified = await this.verifyPlan(product, input, "record");
    const repo = product.repository!;
    const now = (this.options.clock ?? systemClock).iso();
    const onboardingReferences = [{ label: "Verified target head", url: `https://github.com/${repo.owner}/${repo.name}/commit/${verified.head}` }];
    const saved = this.store.transition(actor, { version: "product-intent-v1", requestId: input.requestId, id: product.id,
      expectedRevision: input.expectedRevision, expectedObjectiveRevision: input.expectedObjectiveRevision,
      stageEvidence: [
        { id: `case-onboarding:${input.planEvidenceId}`, stage: "repository", outcome: "succeeded", objectiveRevision: product.objectiveRevision, observedAt: now,
          references: onboardingReferences },
        { id: input.planEvidenceId, stage: "plan", outcome: "succeeded", objectiveRevision: product.objectiveRevision, observedAt: now,
          references: [{ label: `Reviewed task ${input.taskId}`, url: verified.url }, { label: commandLabel, url: verified.url },
            { label: "Plan merge", url: `https://github.com/${repo.owner}/${repo.name}/commit/${verified.merge}` },
            ...(verified.association ? productPlanAssociationReferences(verified.association, repo) ?? [] : [])] },
      ],
    });
    if (!saved.ok) throw new CaseFault(saved.code);
    return saved.value.replayed;
  }

  /** Trusted receipt collectors only. The HTTP command union deliberately exposes no evidence writer. */
  recordEvidence(actor: string, input: {
    requestId: string; productId: string; expectedRevision: number; expectedObjectiveRevision: number;
    repositoryId: number; channel: "local" | "hosted" | "deploy" | "mobile";
    observedAt: string; references: StoredProduct["stageEvidence"][number]["references"];
  }) {
    const parsed = z.object({ requestId: productRequestIdSchema, productId: productIdSchema,
      expectedRevision: revision, expectedObjectiveRevision: revision, repositoryId: revision,
      channel: z.enum(["local", "hosted", "deploy", "mobile"]), observedAt: z.string().datetime(),
      references: productTransitionSchema.shape.stageEvidence.unwrap().element.shape.references.min(1),
    }).strict().safeParse(input);
    if (!parsed.success) return { ok: false as const, code: "invalid_input" as const };
    const read = this.store.read(actor, parsed.data.productId);
    if (!read.ok) return read;
    if (read.value.repository?.id !== parsed.data.repositoryId) return { ok: false as const, code: "repository_conflict" as const };
    const stage = parsed.data.channel === "deploy" || parsed.data.channel === "mobile" ? "deploy" : "build";
    return this.store.transition(actor, { version: "product-intent-v1", requestId: parsed.data.requestId, id: parsed.data.productId,
      expectedRevision: parsed.data.expectedRevision, expectedObjectiveRevision: parsed.data.expectedObjectiveRevision,
      stageEvidence: [{ id: `case-${parsed.data.channel}:${digest(parsed.data)}`, stage, outcome: "succeeded",
        objectiveRevision: parsed.data.expectedObjectiveRevision, observedAt: parsed.data.observedAt, references: parsed.data.references }],
    });
  }

  private evidence(product: StoredProduct): ProductCaseReply["evidence"] {
    const plans = product.stageEvidence.filter((item) => item.stage === "plan" && item.objectiveRevision === product.objectiveRevision && item.outcome === "succeeded");
    return {
      source: (product.brief.decisions ?? []).map((item) => ({ id: item.key, reference: item.provenance.reference ?? item.provenance.kind })),
      review: plans.flatMap((item) => item.references.filter((ref) => ref.label.startsWith("Reviewed task ")).map((ref) => ({ id: item.id, reference: ref.url }))),
      merge: plans.flatMap((item) => item.references.filter((ref) => ref.label === "Plan merge").map((ref) => ({ id: item.id, reference: ref.url }))),
      local: this.recordedEvidence(product, "local"), hosted: this.recordedEvidence(product, "hosted"),
      deploy: this.recordedEvidence(product, "deploy"), mobile: this.recordedEvidence(product, "mobile"),
    };
  }

  private recordedEvidence(product: StoredProduct, channel: "local" | "hosted" | "deploy" | "mobile"): EvidenceReference[] {
    return product.stageEvidence.filter((item) => item.id.startsWith(`case-${channel}:`) && item.outcome === "succeeded" &&
      item.objectiveRevision === product.objectiveRevision).flatMap((item) => item.references.map((ref) => ({ id: item.id, reference: ref.url }))).slice(-128);
  }

}
