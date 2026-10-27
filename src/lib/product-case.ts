import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { systemClock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { ghTextAsync } from "./github-transport.js";
import {
  bootstrapConfirmed, ghProductBuildTarget, productBuildCommandSchema, productPlanOrigin, ProductBuildService,
  type ProductBuildCode, type ProductBuildOptions, type ProductBuildReceipt,
} from "./product-build.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { ProductIntentStore } from "./product-intent-store.js";
import { productIdSchema, productRequestIdSchema, productTransitionSchema, productWriteSchema, type ProductBrief, type StoredProduct } from "./product-intent.js";
import { ghProductRepositoryProvider, productRepositoryCommandSchema, ProductRepositoryService, type ProductRepositoryCode } from "./product-repository.js";

export const PRODUCT_CASE_VERSION = "product-case-v1" as const;
/** PRIMARY CONTROL: the import includes a bounded brief; no command grants execution authority. */
export const PRODUCT_CASE_LIMITS = { requestBytes: 64 * 1024 } as const;
const layout = resolveRepoLayout(sep, () => undefined);
const shardDirectory = relative(layout.root, join(layout.planDir, "tasks.d")).split(sep).join("/");
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
]);
type PlanCommand = z.infer<typeof planCommandSchema>;
type EvidenceReference = { id: string; reference: string };
export interface ProductCaseReply {
  productId: string; revision: number; objectiveRevision: number; replayed: boolean;
  evidence: Record<"source" | "local" | "hosted" | "review" | "merge" | "deploy" | "mobile", EvidenceReference[]>;
  build?: ProductBuildReceipt;
}
export type ProductCaseCode = ProductBuildCode | ProductRepositoryCode;
export type ProductCaseResult = { ok: true; value: ProductCaseReply; code?: never } | { ok: false; code: ProductCaseCode; value?: never };
class CaseFault extends RmdError {
  constructor(readonly code: ProductCaseCode) { super("usage", GENERIC_EXIT_CODE, `product case: ${code}`); }
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** The reviewed task's design must carry the complete approved input the implementation worker consumes. */
export const productCasePlanText = (brief: ProductBrief) => `Approved product brief:\n${JSON.stringify(brief, (_key, value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value, 2)}`;

/** Resumable adoption case. Durable state and all external actions use the existing product mechanisms. */
export class ProductCaseService {
  private readonly store: ProductIntentStore;
  private readonly builds: ProductBuildService;
  private readonly repositories: ProductRepositoryService;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ProductBuildOptions) {
    this.store = options.store ?? new ProductIntentStore({ root: options.root });
    this.builds = new ProductBuildService({ ...options, store: this.store });
    this.repositories = new ProductRepositoryService({ root: options.root });
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
        } else {
          if (!product.repository) throw new CaseFault("repository_missing");
          const evidence = product.stageEvidence.find((item) => item.id === input.command.planEvidenceId && item.stage === "plan");
          const review = evidence?.references.find((item) => item.label === `Reviewed task ${input.command.taskId}`);
          const match = review && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/.exec(review.url);
          if (!match) throw new CaseFault("plan_not_approved");
          const priorBuild = product.stageEvidence.some((item) => item.id === `pbuild_${digest(input.command)}` && item.stage === "build");
          if (!priorBuild) await this.verifyPlan(product, { ...input.command, pullRequest: Number(match[1]) });
          const started = await this.builds.execute(actor, input.command);
          if (!started.ok) throw new CaseFault(started.code);
          replayed = started.value.replayed; build = started.value.receipt;
        }
      }
      const product = this.read(actor, id);
      return { ok: true, value: { productId: id, revision: product.revision, objectiveRevision: product.objectiveRevision,
        replayed, evidence: this.evidence(product), ...(build ? { build } : {}) } };
    } catch (error) {
      return { ok: false, code: error instanceof CaseFault ? error.code : "unavailable" };
    }
  }

  private async verifyPlan(product: StoredProduct, input: Pick<PlanCommand, "planEvidenceId" | "taskId" | "pullRequest">) {
    const repo = product.repository;
    if (!repo) throw new CaseFault("repository_missing");
    const subject = { id: repo.id, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch };
    const live = await ghProductRepositoryProvider().read(repo.owner, repo.name);
    if (live.state === "unreadable") throw new CaseFault("provider_unreadable");
    if (live.state === "absent") throw new CaseFault("repository_not_found");
    if (live.repository.id !== repo.id || live.repository.owner.toLowerCase() !== repo.owner.toLowerCase() ||
      live.repository.name.toLowerCase() !== repo.name.toLowerCase() || live.repository.defaultBranch !== repo.defaultBranch) throw new CaseFault("repository_conflict");
    const target = ghProductBuildTarget({ repoRoot: this.options.repoRoot });
    const inspected = await target.inspect(subject);
    if (inspected.enrolled === undefined || inspected.head === undefined || inspected.readmeOnly === undefined) throw new CaseFault("target_unreadable");
    if (!inspected.enrolled) throw new CaseFault("target_not_enrolled");
    if (!target.runnerRegistered(subject)) throw new CaseFault("runner_missing");
    if (!bootstrapConfirmed(product, inspected)) throw new CaseFault("bootstrap_unverified");
    const slug = `repos/${repo.owner}/${repo.name}`;
    const api = (path: string, raw = false) => ghTextAsync(["api", path, ...(raw ? ["-H", "Accept: application/vnd.github.raw+json"] : [])], { maxBuffer: 1024 * 1024, timeout: 20_000 });
    try {
      const pull = z.object({ number: revision, merged_at: z.string().nullable(), merge_commit_sha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
        base: z.object({ ref: z.string(), repo: z.object({ id: revision }) }), head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }).parse(JSON.parse(await api(`${slug}/pulls/${input.pullRequest}`)));
      const reviews = z.array(z.object({ state: z.string(), commit_id: z.string(), user: z.object({ login: z.string() }).nullable() }))
        .parse(JSON.parse(await api(`${slug}/pulls/${input.pullRequest}/reviews?per_page=100`)));
      const latest = new Map<string, { state: string; commit_id: string }>();
      for (const review of reviews) if (review.user && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user.login, review);
      if (reviews.length >= 100 || pull.number !== input.pullRequest || !pull.merged_at || !pull.merge_commit_sha || pull.base.repo.id !== repo.id ||
        pull.base.ref !== repo.defaultBranch || ![...latest.values()].some((review) => review.state === "APPROVED" && review.commit_id === pull.head.sha) ||
        [...latest.values()].some((review) => review.state === "CHANGES_REQUESTED")) throw new CaseFault("plan_not_approved");
      const names = z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+$/) })).parse(JSON.parse(await api(`${slug}/contents/${shardDirectory}?ref=${inspected.head}`)));
      const shard = names.find((entry) => entry.name.startsWith(`${input.taskId}-`) && entry.name.endsWith(".yaml"));
      if (!shard) throw new CaseFault("task_not_found");
      const shardPath = `${shardDirectory}/${shard.name}`;
      const files = z.array(z.object({ filename: z.string() })).parse(JSON.parse(await api(`${slug}/pulls/${input.pullRequest}/files?per_page=100`)));
      if (!files.some((file) => file.filename === shardPath)) throw new CaseFault("plan_not_approved");
      const path = `${slug}/contents/${shardPath}`;
      const tasks = z.array(z.object({ id: z.string(), origin: z.string(), design: z.string() }).passthrough());
      const current = tasks.parse(parseYaml(await api(`${path}?ref=${inspected.head}`, true))).find((task) => task.id === input.taskId);
      const reviewed = tasks.parse(parseYaml(await api(`${path}?ref=${pull.head.sha}`, true))).find((task) => task.id === input.taskId);
      const merged = tasks.parse(parseYaml(await api(`${path}?ref=${pull.merge_commit_sha}`, true))).find((task) => task.id === input.taskId);
      if (!current || !merged || !reviewed || digest(current) !== digest(reviewed) || digest(current) !== digest(merged) || current.origin !== productPlanOrigin(product.id, input.planEvidenceId) ||
        !current.design.includes(productCasePlanText(product.brief))) throw new CaseFault("plan_not_approved");
      return { head: inspected.head, merge: pull.merge_commit_sha, url: `https://github.com/${repo.owner}/${repo.name}/pull/${input.pullRequest}` };
    } catch (error) {
      if (error instanceof CaseFault) throw error;
      throw Object.assign(new CaseFault("provider_unreadable"), { cause: error });
    }
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
    const verified = await this.verifyPlan(product, input);
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
            { label: "Plan merge", url: `https://github.com/${repo.owner}/${repo.name}/commit/${verified.merge}` }] },
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
