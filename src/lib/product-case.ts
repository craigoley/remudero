import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { systemClock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import {
  bootstrapConfirmed, ghProductBuildTarget, productBuildCommandSchema, ProductBuildService,
  type ProductBuildCode, type ProductBuildOptions, type ProductBuildReceipt, type ProductBuildExecution,
} from "./product-build.js";
import {
  productCasePlanText, productPlanAssociationReferences, productPlanProposalSchema, ProductPlanOperationService, verifyProductPlanEvidence,
  type PlanHandoffPort, type PlanRepository, type ProductPlanObservation, type ProductPlanOperationCode,
} from "./product-plan-operation.js";
import { ProductIntentStore } from "./product-intent-store.js";
import { productEvidenceOutcomeSchema, productIdSchema, productRequestIdSchema, productEvidenceReceiptSchema, productTransitionSchema, productWriteSchema, type ProductRunReceipt, type ProductEvidenceReceipt, type ProductDeployReceipt, type StoredProduct } from "./product-intent.js";
import { ProductDeploymentService, probeDeploymentUrl, type ProductDeploymentCode } from "./product-deployment.js";
import { ghProductRepositoryProvider, productRepositoryCommandSchema, ProductRepositoryService, type ProductRepositoryCode } from "./product-repository.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { readLocalQualificationReceipt } from "./local-qualification-receipt.js";
import { ghTextAsync } from "./github-transport.js";
import { classifyChangesRequested } from "./open-prs-rest.js";
import { readReviewStatusEntry, resolveReviewProvenance, REVIEWER_IDENTITY_ENV } from "./review.js";

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
const deploymentObservationSchema = z.object({
  productId: productIdSchema, expectedRevision: revision, expectedObjectiveRevision: revision,
  operationId: z.string().regex(/^pdeploy_[a-f0-9]{64}$/),
}).strict();
export const productCaseCommandSchema = z.discriminatedUnion("action", [
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("import"),
    command: productWriteSchema.refine((value) => value.id === undefined && value.expectedRevision === 0) }).strict(),
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("adopt"),
    command: productRepositoryCommandSchema.refine((value) => value.action === "adopt") }).strict(),
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("plan"), command: planCommandSchema }).strict(),
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("build"), command: productBuildCommandSchema }).strict(),
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("propose"), command: productPlanProposalSchema }).strict(),
  z.object({ version: z.literal(PRODUCT_CASE_VERSION), action: z.literal("observe-deployment"), command: deploymentObservationSchema }).strict(),
]);
type PlanCommand = z.infer<typeof planCommandSchema>;
type EvidenceReference = { id: string; reference: string; outcome?: StoredProduct["stageEvidence"][number]["outcome"]; receipt?: ProductEvidenceReceipt; current?: boolean };
export interface ProductCaseReply {
  productId: string; revision: number; objectiveRevision: number; replayed: boolean;
  evidence: Record<"source" | "local" | "hosted" | "review" | "merge" | "deploy" | "mobile", EvidenceReference[]>;
  build?: ProductBuildReceipt;
  planOperation?: ProductPlanObservation;
}
export type ProductCaseCode = ProductBuildCode | ProductRepositoryCode | ProductPlanOperationCode | ProductDeploymentCode | "binding_not_found";
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
      let currentReceipts = new Set<string>();
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
        } else if (input.action === "observe-deployment") {
          const observed = await this.observeDeployment(actor, product, input.command);
          replayed = observed.replayed; currentReceipts = observed.currentReceipts;
        } else {
          if (!product.repository) throw new CaseFault("repository_missing");
          const evidence = product.stageEvidence.find((item) => item.id === input.command.planEvidenceId && item.stage === "plan");
          const review = evidence?.references.find((item) => item.label === `Reviewed task ${input.command.taskId}`);
          const match = review && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/.exec(review.url);
          if (!match) throw new CaseFault("plan_not_approved");
          // The build service applies the SAME shared plan rule to this plan record immediately before admitting the task.
          const started = await this.builds.executeForCase(actor, input.command);
          if (!started.ok) throw new CaseFault(started.code);
          replayed = started.value.replayed; build = started.value.receipt;
          if (started.value.execution) currentReceipts = await this.reconcile(actor, product, build, started.value.execution);
        }
      }
      const product = this.read(actor, id);
      return { ok: true, value: { productId: id, revision: product.revision, objectiveRevision: product.objectiveRevision,
        replayed, evidence: this.evidence(product, currentReceipts), ...(build ? { build } : {}), ...(planOperation ? { planOperation } : {}) } };
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
    outcome?: StoredProduct["stageEvidence"][number]["outcome"]; receipt?: ProductEvidenceReceipt;
  }) {
    const parsed = z.object({ requestId: productRequestIdSchema, productId: productIdSchema,
      expectedRevision: revision, expectedObjectiveRevision: revision, repositoryId: revision,
      channel: z.enum(["local", "hosted", "deploy", "mobile"]), observedAt: z.string().datetime(),
      references: productTransitionSchema.shape.stageEvidence.unwrap().element.shape.references.min(1),
      outcome: productEvidenceOutcomeSchema.optional(), receipt: productEvidenceReceiptSchema.optional(),
    }).strict().safeParse(input);
    if (!parsed.success) return { ok: false as const, code: "invalid_input" as const };
    const read = this.store.read(actor, parsed.data.productId);
    if (!read.ok) return read;
    if (read.value.repository?.id !== parsed.data.repositoryId) return { ok: false as const, code: "repository_conflict" as const };
    const receipt = parsed.data.receipt;
    if (receipt && (receipt.actor !== actor || receipt.productId !== input.productId || receipt.repository.id !== input.repositoryId ||
      receipt.channel !== input.channel || receipt.objectiveRevision !== input.expectedObjectiveRevision)) return { ok: false as const, code: "invalid_input" as const };
    if (receipt?.channel === "deploy" && receipt.outcome !== input.outcome) return { ok: false as const, code: "invalid_input" as const };
    const identity = receipt?.channel === "deploy" ? digest(receipt) : receipt ? digest([input.productId, input.expectedObjectiveRevision, input.channel, receipt.operationId, receipt.runId, receipt.head, input.outcome]) : digest(parsed.data);
    const stage = parsed.data.channel === "deploy" || parsed.data.channel === "mobile" ? "deploy" : "build";
    if (read.value.stageEvidence.length >= 128 && !read.value.stageEvidence.some(item => item.id === `case-${input.channel}:${identity}`)) return { ok: false as const, code: "capacity" as const };
    return this.store.transition(actor, { version: "product-intent-v1", requestId: parsed.data.requestId, id: parsed.data.productId,
      expectedRevision: parsed.data.expectedRevision, expectedObjectiveRevision: parsed.data.expectedObjectiveRevision,
      stageEvidence: [{ id: `case-${parsed.data.channel}:${identity}`, stage, outcome: parsed.data.outcome ?? "succeeded",
        objectiveRevision: parsed.data.expectedObjectiveRevision, observedAt: parsed.data.observedAt, references: parsed.data.references,
        ...(receipt ? { receipt } : {}) }],
    });
  }

  private async observeDeployment(actor: string, product: StoredProduct, input: z.infer<typeof deploymentObservationSchema>): Promise<{ replayed: boolean; currentReceipts: Set<string> }> {
    if (product.objectiveRevision !== input.expectedObjectiveRevision || input.expectedRevision > product.revision) throw new CaseFault("stale_revision");
    const observation = await new ProductDeploymentService({ root: this.options.root, store: this.store }).observe(actor, product.id, input.operationId);
    if (!observation.ok) throw new CaseFault(observation.code);
    const binding = observation.binding;
    const base = { channel: "deploy" as const, actor, productId: product.id, objectiveRevision: product.objectiveRevision,
      operationId: binding.operationId, repository: binding.project.repository, projectId: binding.project.id, teamId: binding.project.teamId };
    const receipts: ProductDeployReceipt[] = [];
    for (const deployment of observation.deployments.toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
      if (deployment.projectId !== base.projectId) throw new CaseFault("project_conflict");
      if (deployment.ownerId !== base.teamId) throw new CaseFault("team_mismatch");
      if (deployment.gitSource.repoId !== base.repository.id) throw new CaseFault("repository_mismatch");
      const receipt: ProductDeployReceipt = { ...base, deploymentId: deployment.id, target: deployment.target ?? "preview",
        providerCreatedAt: deployment.createdAt,
        commit: deployment.gitSource.sha, url: new URL(`https://${deployment.url}`).href, readyState: deployment.readyState,
        servedStatus: null, outcome: "unknown", reason: "unrecognized deployment state" };
      const source = await this.hostedSource(product, actor, deployment.gitSource.sha);
      if (!source.accepted) {
        receipt.outcome = source.unreadable ? "unknown" : "blocked"; receipt.reason = source.reason;
      } else if (["ERROR", "CANCELED"].includes(deployment.readyState)) {
        receipt.outcome = "failed"; receipt.reason = `provider deployment ${deployment.readyState}`;
      } else if (["BUILDING", "QUEUED", "INITIALIZING"].includes(deployment.readyState)) {
        receipt.outcome = "running"; receipt.reason = `provider deployment ${deployment.readyState}`;
      } else if (deployment.readyState === "BLOCKED") {
        receipt.outcome = "blocked"; receipt.reason = "provider deployment BLOCKED";
      } else if (deployment.readyState === "READY") Object.assign(receipt, await probeDeploymentUrl(receipt.url!));
      receipts.push(receipt);
    }
    if (!receipts.length) receipts.push({ ...base, deploymentId: null, target: null, providerCreatedAt: null, commit: null, url: null, readyState: null,
      servedStatus: null, outcome: "unknown", reason: observation.reason ?? "no provider deployment observed" });
    if (product.revision !== input.expectedRevision && receipts.some(receipt => !product.stageEvidence.some(item => item.id === `case-deploy:${digest(receipt)}`))) {
      throw new CaseFault("stale_revision");
    }
    let replayed = true;
    const currentReceipts = new Map<ProductDeployReceipt["target"], string>();
    for (const receipt of receipts) {
      const identity = digest(receipt), id = `case-deploy:${identity}`;
      currentReceipts.set(receipt.target, id);
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = this.read(actor, product.id);
        if (current.objectiveRevision !== product.objectiveRevision || current.repository?.id !== base.repository.id) throw new CaseFault("stale_revision");
        if (current.revision !== product.revision && receipt.outcome === "succeeded" && receipt.commit &&
          !(await this.hostedSource(current, actor, receipt.commit)).accepted) throw new CaseFault("stale_revision");
        if (current.stageEvidence.some(item => item.id === id)) break;
        if (current.stageEvidence.length >= 128) throw new CaseFault("capacity");
        const saved = this.recordEvidence(actor, { requestId: `case_${identity}`, productId: product.id,
          expectedRevision: current.revision, expectedObjectiveRevision: product.objectiveRevision, repositoryId: base.repository.id,
          channel: "deploy", outcome: receipt.outcome, receipt, observedAt: (this.options.clock ?? systemClock).iso(),
          references: [{ label: receipt.reason.slice(0, 120), url: receipt.url ?? `https://vercel.com/${base.teamId}/${binding.project.name}` }] });
        if (saved.ok) { replayed = replayed && saved.value.replayed; break; }
        const latest = this.read(actor, product.id);
        if (latest.objectiveRevision === product.objectiveRevision && latest.stageEvidence.some(item => item.id === id)) break;
        if (saved.code !== "stale_revision" || attempt === 1) throw new CaseFault(saved.code);
      }
    }
    return { replayed, currentReceipts: new Set(currentReceipts.values()) };
  }

  private async hostedSource(product: StoredProduct, actor: string, commit: string): Promise<{ accepted: boolean; unreadable?: boolean; reason: string }> {
    let unavailable: string | undefined;
    const latest = new Map<string, StoredProduct["stageEvidence"][number]>();
    for (const item of product.stageEvidence) {
      const receipt = item.receipt;
      if (receipt?.channel === "hosted" && receipt.actor === actor && receipt.productId === product.id &&
        receipt.repository.id === product.repository?.id && receipt.objectiveRevision === product.objectiveRevision && item.objectiveRevision === product.objectiveRevision) {
        latest.set(`${receipt.operationId}:${receipt.runId}`, item);
      }
    }
    for (const item of latest.values()) {
      const receipt = item.receipt;
      if (item.outcome !== "succeeded" || receipt?.channel !== "hosted" || receipt.review !== "success" ||
        !receipt.contexts.length || receipt.contexts.some(context => context.conclusion !== "success")) continue;
      if (receipt.head === commit) return { accepted: true, reason: "hosted-tested source" };
      const repo = product.repository!;
      for (const ref of item.references) {
        const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(ref.url);
        if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) continue;
        try {
          const pull = z.object({ number: revision, merged_at: z.string().datetime().nullable(), merge_commit_sha: z.string().nullable(), head: z.object({ sha: z.string() }),
            base: z.object({ ref: z.string(), repo: z.object({ id: revision }) }) }).parse(JSON.parse(await (this.options.planText ?? ghTextAsync)(
            ["api", `repos/${repo.owner}/${repo.name}/pulls/${match[3]}`], { timeout: 20_000, maxBuffer: 256 * 1024 })));
          if (pull.merged_at !== null && pull.number === Number(match[3]) && pull.head.sha === receipt.head && pull.base.repo.id === repo.id &&
            pull.base.ref === repo.defaultBranch && pull.merge_commit_sha === commit) return { accepted: true, reason: "verified default-branch merge of hosted-tested source" };
        } catch (error) {
          unavailable = `hosted source merge unreadable: ${String(error).slice(0, 400)}`;
        }
      }
    }
    return { accepted: false, ...(unavailable ? { unreadable: true } : {}), reason: unavailable ?? "deployment source has no current-objective succeeded hosted receipt" };
  }

  private async reconcile(actor: string, original: StoredProduct, build: ProductBuildReceipt, execution: ProductBuildExecution): Promise<Set<string>> {
    const current = new Set<string>();
    const native = execution.read;
    if (!original.repository) return current;
    const repository = { id: original.repository.id, owner: original.repository.owner, name: original.repository.name };
    const slug = `${repository.owner}/${repository.name}`;
    if (!("runId" in native)) {
      const prior = original.stageEvidence.findLast(item => item.receipt?.operationId === build.operationId && item.objectiveRevision === build.objectiveRevision)?.receipt;
      if (native.state !== "unknown" || !prior || prior.channel === "deploy") return current;
      const base = { actor, productId: original.id, objectiveRevision: build.objectiveRevision, repository,
        operationId: build.operationId, runId: prior.runId, taskId: build.taskId, head: "unknown", execution: "unknown" as const };
      const reference = `https://github.com/${slug}`;
      const reason = "native ledger incomplete or unreadable; prior run identity retained without a current head";
      current.add(this.persistRunEvidence(actor, base, { ...base, channel: "local", qualification: {
        producer: "unavailable", verdict: "unknown", tests: 0, suites: 0, reason } }, "unknown", reason, reference));
      current.add(this.persistRunEvidence(actor, base, { ...base, channel: "hosted", contexts: [], review: "unknown", reason }, "unknown", reason, reference));
      return current;
    }
    const read = readLedgerUnionRecordsSync(join(execution.stateRoot, "state"), { sinceTs: execution.requestedAt, refuseIncomplete: true,
      keep: line => line.includes(native.runId) });
    const rows = read.ok && read.torn === 0 ? read.rows.filter(row => row.run_id === native.runId && (row.task_id === undefined || row.task_id === build.taskId))
      .sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts))) : [];
    const heads = rows.filter(row => typeof row.head_sha === "string" && /^[a-f0-9]{40}$/.test(row.head_sha));
    // Cleanup may capture an older worktree after the run has observed a repaired PR head.
    const sourceHeads = heads.filter(row => row.step !== "local.qualification");
    const head = String(sourceHeads.at(-1)?.head_sha ?? heads.at(-1)?.head_sha ?? "unknown");
    const base = { actor, productId: original.id, objectiveRevision: build.objectiveRevision, repository,
      operationId: build.operationId, runId: native.runId, taskId: build.taskId, head, execution: native.state };
    const localRows = rows.filter(row => row.step === "local.qualification" && row.head_sha === head);
    const qualifications = localRows.length ? localRows : [{}];
    for (const row of qualifications) {
      const local = readLocalQualificationReceipt({ stateRoot: execution.stateRoot, repository: slug, taskId: build.taskId, runId: native.runId, head, row });
      const id = this.persistRunEvidence(actor, base, { ...base, channel: "local", qualification: local.qualification }, local.outcome,
        `Local qualification: ${local.qualification.verdict}`, `https://github.com/${slug}/commit/${head}`);
      if (row === qualifications.at(-1)) current.add(id);
    }
    const pr = rows.findLast(row => row.step === "pr.opened");
    const hosted = await this.hosted(original, head, pr);
    current.add(this.persistRunEvidence(actor, base, { ...base, channel: "hosted", contexts: hosted.contexts, review: hosted.review, reason: hosted.reason },
      hosted.outcome, hosted.outcome === "unknown" ? "Hosted qualification: unknown" : hosted.reason, hosted.reference));
    return current;
  }

  private persistRunEvidence(actor: string, base: { productId: string; objectiveRevision: number; repository: { id: number } }, receipt: ProductRunReceipt,
    outcome: "succeeded" | "failed" | "running" | "unknown", label: string, reference: string): string {
    const identity = digest([base.productId, base.objectiveRevision, receipt.channel, receipt.operationId, receipt.runId, receipt.head, outcome]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const product = this.read(actor, base.productId);
      if (product.objectiveRevision !== base.objectiveRevision) throw new CaseFault("stale_revision");
      if (product.stageEvidence.some(item => item.id === `case-${receipt.channel}:${identity}`)) return `case-${receipt.channel}:${identity}`;
      const saved = this.recordEvidence(actor, { requestId: `case_${identity}`, productId: product.id, expectedRevision: product.revision,
        expectedObjectiveRevision: base.objectiveRevision, repositoryId: base.repository.id, channel: receipt.channel, outcome, receipt,
        observedAt: (this.options.clock ?? systemClock).iso(), references: [{ label: label.slice(0, 120), url: reference }] });
      if (saved.ok) return `case-${receipt.channel}:${identity}`;
      if (saved.code === "idempotency_conflict") {
        const concurrent = this.read(actor, base.productId);
        if (concurrent.objectiveRevision !== base.objectiveRevision) throw new CaseFault("stale_revision");
        if (concurrent.stageEvidence.some(item => item.id === `case-${receipt.channel}:${identity}`)) return `case-${receipt.channel}:${identity}`;
      }
      if (saved.code !== "stale_revision" || attempt === 1) throw new CaseFault(saved.code);
    }
    throw new CaseFault("stale_revision");
  }

  private async hosted(product: StoredProduct, head: string, row: Record<string, unknown> | undefined): Promise<{
    outcome: "succeeded" | "failed" | "running" | "unknown"; contexts: { name: string; conclusion: string }[];
    review: "success" | "failure" | "pending" | "absent" | "unknown"; reason: string; reference: string;
  }> {
    const repo = product.repository!;
    const slug = `repos/${repo.owner}/${repo.name}`;
    const reference = `https://github.com/${repo.owner}/${repo.name}/commit/${head}`;
    const unavailable = (reason: string) => ({ outcome: "unknown" as const, contexts: [], review: "unknown" as const, reason: reason.slice(0, 500), reference });
    try {
      const match = typeof row?.pr_url === "string" ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(row.pr_url) : undefined;
      if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase() || head === "unknown") return unavailable("source PR unavailable for this run and head");
      const text = this.options.planText ?? ghTextAsync;
      const fetcher = async (args: string[]) => JSON.parse(await text(args, { timeout: 20_000, maxBuffer: 1024 * 1024 })) as unknown;
      const api = (path: string) => fetcher(["api", path]);
      const pull = z.object({ number: z.number(), head: z.object({ sha: z.string() }), base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }) }) });
      const live = pull.parse(await api(`${slug}/pulls/${match[3]}`));
      if (live.number !== Number(match[3]) || live.base.repo.id !== repo.id || live.head.sha !== head) return unavailable("stale head or foreign repository");
      const required = z.object({ contexts: z.array(z.string().min(1).max(255)).max(99),
        checks: z.array(z.object({ context: z.string().min(1).max(255), app_id: z.number().nullable().optional() })).max(99).optional() })
        .parse(await api(`${slug}/branches/${encodeURIComponent(live.base.ref)}/protection/required_status_checks`));
      const names = [...new Set([...required.contexts, ...(required.checks ?? []).map(check => check.context)])];
      if (!names.length || names.length >= 100) return unavailable("required contexts empty or truncated");
      const runs = z.object({ total_count: z.number().optional(), check_runs: z.array(z.object({ id: z.number(), name: z.string(), head_sha: z.string(),
        status: z.string(), conclusion: z.string().nullable(), app: z.object({ id: z.number() }).optional() })).max(99) })
        .parse(await api(`${slug}/commits/${head}/check-runs?per_page=100`));
      const statuses = z.object({ total_count: z.number().optional(), statuses: z.array(z.object({ context: z.string(), state: z.string(),
        creator: z.object({ login: z.string(), type: z.string().optional() }).optional() }).passthrough()).max(99) })
        .parse(await api(`${slug}/commits/${head}/status?per_page=100`));
      if ((runs.total_count ?? runs.check_runs.length) >= 100 || (statuses.total_count ?? statuses.statuses.length) >= 100 || runs.check_runs.some(run => run.head_sha !== head)) return unavailable("check page incomplete or foreign head");
      const reviews = z.array(z.object({ state: z.string(), commit_id: z.string(), user: z.object({ login: z.string(), type: z.string().optional() }).nullable() }).passthrough()).max(99)
        .parse(await api(`${slug}/pulls/${match[3]}/reviews?per_page=100`));
      const hold = classifyChangesRequested({ headSha: head }, reviews);
      const trusted = this.options.planTrustedReviewer ?? process.env[REVIEWER_IDENTITY_ENV] ?? "";
      // Bind provenance to the bounded status snapshot used for required contexts. The reader's
      // GraphQL identity fallback still verifies the repository, head and unchanged review state.
      const review = resolveReviewProvenance(await readReviewStatusEntry(repo.owner, repo.name, head,
        async args => args[1] === "graphql" ? fetcher(args) : statuses), trusted);
      const failures = ["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure", "stale"];
      const contexts = names.map(name => {
        const pin = required.checks?.find(check => check.context === name)?.app_id;
        const run = runs.check_runs.filter(run => run.name === name && (pin === undefined || pin === null || pin < 0 || run.app?.id === pin)).sort((a, b) => b.id - a.id)[0];
        const status = pin === undefined || pin === null || pin < 0 ? statuses.statuses.find(status => status.context === name) : undefined;
        const conclusions = run ? [run.status === "completed" ? run.conclusion ?? "unknown" :
          ["queued", "in_progress", "requested", "waiting", "pending"].includes(run.status) ? "pending" : "unknown"] : [];
        if (status) conclusions.push(status.state);
        const conclusion = conclusions.find(value => failures.includes(value)) ??
          conclusions.find(value => !["success", "pending"].includes(value)) ??
          conclusions.find(value => value === "pending") ?? (conclusions.length ? "success" : "pending");
        return { name, conclusion };
      });
      const failed = contexts.find(context => failures.includes(context.conclusion));
      const pending = contexts.find(context => context.conclusion === "pending");
      const unrecognized = contexts.find(context => !["success", "pending", "failure", "error", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(context.conclusion));
      const outcome = hold?.kind === "changes-requested" || failed || review === "failure" ? "failed" :
        unrecognized ? "unknown" : pending || review === "pending" ? "running" : review === "success" ? "succeeded" : "unknown";
      const reason = hold?.kind === "changes-requested" ? "standing human changes-requested hold" : failed ? `${failed.name.slice(0, 75)}: ${failed.conclusion.slice(0, 40)}` :
        unrecognized ? `${unrecognized.name}: ${unrecognized.conclusion}` : pending ? `${pending.name}: ${pending.conclusion}` : `native review: ${review}`;
      const final = pull.parse(await api(`${slug}/pulls/${match[3]}`));
      if (final.head.sha !== head || final.base.repo.id !== repo.id || final.base.ref !== live.base.ref) return unavailable("source head changed during hosted observation");
      return { outcome, contexts, review, reason: reason.slice(0, 500), reference: row!.pr_url as string };
    } catch (error) { return unavailable(`hosted evidence unreadable: ${String(error)}`); }
  }

  private evidence(product: StoredProduct, currentReceipts: Set<string>): ProductCaseReply["evidence"] {
    const plans = product.stageEvidence.filter((item) => item.stage === "plan" && item.objectiveRevision === product.objectiveRevision && item.outcome === "succeeded");
    return {
      source: (product.brief.decisions ?? []).map((item) => ({ id: item.key, reference: item.provenance.reference ?? item.provenance.kind })),
      review: plans.flatMap((item) => item.references.filter((ref) => ref.label.startsWith("Reviewed task ")).map((ref) => ({ id: item.id, reference: ref.url }))),
      merge: plans.flatMap((item) => item.references.filter((ref) => ref.label === "Plan merge").map((ref) => ({ id: item.id, reference: ref.url }))),
      local: this.recordedEvidence(product, "local", currentReceipts), hosted: this.recordedEvidence(product, "hosted", currentReceipts),
      deploy: this.recordedEvidence(product, "deploy", currentReceipts), mobile: this.recordedEvidence(product, "mobile"),
    };
  }

  private recordedEvidence(product: StoredProduct, channel: "local" | "hosted" | "deploy" | "mobile", currentReceipts = new Set<string>()): EvidenceReference[] {
    const evidence = product.stageEvidence.filter(item => item.id.startsWith(`case-${channel}:`));
    if (channel === "deploy") {
      return evidence.flatMap(item => item.references.map(ref => ({ id: item.id, reference: ref.url,
        outcome: item.receipt?.channel === "deploy" ? item.outcome : "unknown" as const,
        ...(item.receipt ? { receipt: item.receipt } : {}),
        current: Boolean(item.receipt?.channel === "deploy" && item.objectiveRevision === product.objectiveRevision && currentReceipts.has(item.id)) }))).slice(-128);
    }
    if (channel === "mobile") return evidence.filter(item => item.outcome === "succeeded" && item.objectiveRevision === product.objectiveRevision)
      .flatMap(item => item.references.map(ref => ({ id: item.id, reference: ref.url }))).slice(-128);
    return evidence.flatMap(item => item.references.map(ref => ({ id: item.id, reference: ref.url, outcome: item.receipt ? item.outcome : "unknown" as const,
      ...(item.receipt ? { receipt: item.receipt } : {}), current: Boolean(item.receipt && currentReceipts.has(item.id) && item.objectiveRevision === product.objectiveRevision) }))).slice(-128);
  }

}
