import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.js";
import { InflightLockError, withInflightLock } from "./inflight-lock.js";
import { productRequestIdSchema, productIdSchema, type ProductBrief, type ProductProjection, type ProductStoreCode } from "./product-intent.js";
import { ProductIntentStore, productStatePaths } from "./product-intent-store.js";

export const PRODUCT_RESEARCH_VERSION = "product-research-v1" as const;
/** PRIMARY CONTROL: storage quotas for research evidence; they grant no provider or spending authority. */
export const PRODUCT_RESEARCH_LIMITS = { requestBytes: 64 * 1024, stateBytes: 1024 * 1024, runs: 32, answers: 256, questions: 64, receipts: 1024 } as const;

export type ProductResearchCode = ProductStoreCode | "already_answered";
export type ProductResearchResult = { ok: true; value: ProductResearchView; code?: never } | { ok: false; code: ProductResearchCode; value?: never };
export type ProductResearchRunOutcome = "completed" | "unavailable" | "failed";
export type ProductResearchFailure = "provider_error" | "invalid_output" | "over_budget";

/** The existing automation/triage transport hands research to a provider through this seam; absent means unavailable. */
export interface ProductResearchProvider {
  readonly id: string;
  /** `sources` are untrusted DATA: the provider must never treat them as instructions or authority. */
  research(input: { objective: string; objectiveRevision: number; sources: { label: string; url: string }[] }): Promise<unknown>;
}

const MAX_ID = Number.MAX_SAFE_INTEGER;
const text = (max: number) => z.string().trim().min(1).max(max);
const questionId = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const instant = z.string().datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const productResearchCommandSchema = z.object({
  version: z.literal(PRODUCT_RESEARCH_VERSION), requestId: productRequestIdSchema, productId: productIdSchema,
  expectedObjectiveRevision: z.number().int().min(1).max(MAX_ID),
  answers: z.array(z.object({ questionId, answer: text(2000) }).strict()).max(16).optional(),
}).strict().refine((value) => new Set((value.answers ?? []).map((answer) => answer.questionId)).size === (value.answers ?? []).length);

/** Provider output is untrusted: only these fields are read, every other key is dropped unread. */
const providerOutputSchema = z.object({
  summary: text(4000), spendUsd: z.number().finite().min(0).max(10_000).optional(),
  questions: z.array(z.object({ text: text(500) })).max(8).optional(),
});

const sourceSchema = z.object({ label: text(120), url: z.string().max(2048), disposition: z.literal("data") }).strict();
const runSchema = z.object({
  id: z.string().regex(/^prun_[a-f0-9]{32}$/), objectiveRevision: z.number().int().min(1), productRevision: z.number().int().min(1),
  outcome: z.enum(["completed", "unavailable", "failed"]), failure: z.enum(["provider_error", "invalid_output", "over_budget"]).optional(),
  provider: z.string().max(120).nullable(), budgetUsd: z.number().min(0), spendUsd: z.number().min(0),
  sources: z.array(sourceSchema).max(16), summary: text(4000).optional(), executionAuthority: z.literal("none"),
  startedAt: instant, finishedAt: instant,
}).strict();
const questionSchema = z.object({ id: questionId, text: text(500), origin: z.enum(["catalog", "provider"]), objectiveRevision: z.number().int().min(1) }).strict();
const answerSchema = z.object({
  questionId, answer: text(2000), objectiveRevision: z.number().int().min(1), scopeDigest: hash,
  status: z.enum(["accepted", "invalidated"]), answeredAt: instant, invalidatedAt: instant.optional(),
}).strict();
const recordSchema = z.object({
  questions: z.array(questionSchema).max(PRODUCT_RESEARCH_LIMITS.questions),
  answers: z.array(answerSchema).max(PRODUCT_RESEARCH_LIMITS.answers),
  runs: z.array(runSchema).max(PRODUCT_RESEARCH_LIMITS.runs),
}).strict();
const stateSchema = z.object({
  version: z.literal(PRODUCT_RESEARCH_VERSION), ownerKey: hash,
  products: z.record(productIdSchema, recordSchema),
  receipts: z.record(hash, z.object({ payloadDigest: hash, productId: productIdSchema, runId: z.string().nullable(), savedAt: instant }).strict()),
}).strict();

type State = z.infer<typeof stateSchema>;
type Run = z.infer<typeof runSchema>;
type Question = z.infer<typeof questionSchema>;
type Answer = z.infer<typeof answerSchema>;
type Record_ = z.infer<typeof recordSchema>;
type Draft = { run: Omit<Run, "startedAt" | "finishedAt">; questions: { text: string }[] | undefined };

export interface ProductResearchView {
  version: typeof PRODUCT_RESEARCH_VERSION; productId: string; objectiveRevision: number; replayed: boolean;
  run: Run | null;
  open: { id: string; text: string; origin: "catalog" | "provider" }[];
  accepted: { questionId: string; text: string; answer: string; answeredAt: string }[];
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

class ResearchFault extends Error {
  constructor(readonly code: ProductResearchCode) { super(`product research: ${code}`); }
}

type CatalogQuestion = { id: string; text: string; dependsOn: (keyof ProductBrief)[]; satisfied: (brief: ProductBrief) => boolean };
/** Fixed clarification catalog: a field already carried by the brief never needs asking. */
const CATALOG: readonly CatalogQuestion[] = [
  { id: "q_objective", text: "What should a player accomplish in one session?", dependsOn: ["idea", "objective"], satisfied: (b) => b.objective !== undefined },
  { id: "q_constraints", text: "Which platform and quality constraints are fixed?", dependsOn: ["constraints"], satisfied: (b) => (b.constraints?.length ?? 0) > 0 },
  { id: "q_audience", text: "Who is the first audience?", dependsOn: ["idea"], satisfied: (b) => b.decisions?.some((d) => d.key === "audience") === true },
  { id: "q_budget", text: "What build budget and concurrency are acceptable?", dependsOn: ["resourceEnvelope"], satisfied: (b) => b.resourceEnvelope !== undefined },
];
const PROVIDER_DEPENDS: (keyof ProductBrief)[] = ["idea", "objective"];

const scopeDigest = (brief: ProductBrief, fields: (keyof ProductBrief)[]) => digest(JSON.stringify(fields.map((field) => brief[field] ?? null)));
const dependsOf = (id: string, record: Record_): (keyof ProductBrief)[] | undefined =>
  CATALOG.find((item) => item.id === id)?.dependsOn ?? (record.questions.some((item) => item.id === id) ? PROVIDER_DEPENDS : undefined);

function emptyRecord(): Record_ { return { questions: [], answers: [], runs: [] }; }

function validAnswer(answer: Answer, brief: ProductBrief, record: Record_): boolean {
  const fields = dependsOf(answer.questionId, record);
  return answer.status === "accepted" && fields !== undefined && answer.scopeDigest === scopeDigest(brief, fields);
}

/** An answer whose own scope changed is invalidated and kept; every unaffected answer stays accepted. */
function normalize(record: Record_, brief: ProductBrief, now: string): Record_ {
  return {
    ...record,
    answers: record.answers.map((answer) => answer.status === "accepted" && !validAnswer(answer, brief, record)
      ? { ...answer, status: "invalidated" as const, invalidatedAt: now } : answer),
  };
}

function project(productId: string, brief: ProductBrief, objectiveRevision: number, record: Record_, replayed: boolean): ProductResearchView {
  const known = [
    ...CATALOG.filter((item) => !item.satisfied(brief)).map((item) => ({ id: item.id, text: item.text, origin: "catalog" as const })),
    ...record.questions.filter((item) => item.objectiveRevision === objectiveRevision).map(({ id, text: body, origin }) => ({ id, text: body, origin })),
  ];
  const accepted = record.answers.filter((answer) => validAnswer(answer, brief, record));
  const titles = new Map([...CATALOG.map((item) => [item.id, item.text] as const), ...record.questions.map((item) => [item.id, item.text] as const)]);
  return {
    version: PRODUCT_RESEARCH_VERSION, productId, objectiveRevision, replayed,
    run: [...record.runs].reverse().find((run) => run.objectiveRevision === objectiveRevision) ?? null,
    open: known.filter((item) => !accepted.some((answer) => answer.questionId === item.id)),
    accepted: accepted.map(({ questionId: id, answer, answeredAt }) => ({ questionId: id, text: titles.get(id) ?? id, answer, answeredAt })),
  };
}

interface ResearchOptions {
  root?: string; store?: ProductIntentStore; provider?: ProductResearchProvider; clock?: Clock;
  /** Operator-configured spending ceiling per run; provider output can never raise it. Default 0. */
  budgetUsd?: number; sync?: (fd: number) => void;
}

/** Bounded research and clarification over an existing product: durable evidence, no authority. */
export class ProductResearchService {
  private readonly store: ProductIntentStore;
  private readonly clock: Clock;
  private readonly budgetUsd: number;
  private readonly sync: (fd: number) => void;

  constructor(private readonly options: ResearchOptions) {
    this.store = options.store ?? new ProductIntentStore({ root: options.root });
    this.clock = options.clock ?? systemClock;
    this.budgetUsd = options.budgetUsd !== undefined && Number.isFinite(options.budgetUsd) && options.budgetUsd > 0 ? options.budgetUsd : 0;
    this.sync = options.sync ?? fsyncSync;
  }

  private paths(actor: string) {
    if (!this.options.root) throw new ResearchFault("unavailable");
    const base = productStatePaths(this.options.root, actor);
    const directory = join(base.directory, "research");
    return { ...base, research: directory, file: join(directory, `${base.ownerKey}.json`) };
  }

  private read(paths: ReturnType<ProductResearchService["paths"]>): State {
    let fd: number | undefined;
    try {
      fd = openSync(paths.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1 || (info.mode & 0o077) !== 0 || info.size > PRODUCT_RESEARCH_LIMITS.stateBytes) throw new ResearchFault("unavailable");
      const buffer = Buffer.alloc(info.size);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      let parsed: State | undefined;
      try { parsed = size === info.size ? stateSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer))) : undefined; }
      catch (cause) { throw Object.assign(new ResearchFault("corrupt"), { cause }); }
      if (!parsed || parsed.ownerKey !== paths.ownerKey) throw new ResearchFault("corrupt");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: PRODUCT_RESEARCH_VERSION, ownerKey: paths.ownerKey, products: {}, receipts: {} };
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  private ensureDirectory(paths: ReturnType<ProductResearchService["paths"]>): void {
    try { mkdirSync(paths.research, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = lstatSync(paths.research);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new ResearchFault("unavailable");
  }

  private commit(paths: ReturnType<ProductResearchService["paths"]>, state: State): void {
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > PRODUCT_RESEARCH_LIMITS.stateBytes) throw new ResearchFault("capacity");
    const temporary = join(paths.research, `.${paths.ownerKey}.${randomUUID()}.pending`);
    let fd: number | undefined;
    let renamed = false;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, body, "utf8");
      this.sync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, paths.file);
      renamed = true;
      const directory = openSync(paths.research, constants.O_RDONLY);
      try { this.sync(directory); } finally { closeSync(directory); }
    } catch (cause) {
      if (fd !== undefined) closeSync(fd);
      if (!renamed) {
        try { unlinkSync(temporary); }
        catch (leftover) { if ((leftover as NodeJS.ErrnoException).code !== "ENOENT") throw Object.assign(new ResearchFault("recovery_required"), { cause }); }
      }
      // After rename a retry reconciles through the request receipt.
      throw Object.assign(new ResearchFault(renamed ? "outcome_unknown" : "unavailable"), { cause });
    }
  }

  private async execute(actor: string, command: unknown): Promise<ProductResearchView> {
    const parsed = productResearchCommandSchema.safeParse(command);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > PRODUCT_RESEARCH_LIMITS.requestBytes) throw new ResearchFault("invalid_input");
    const input = parsed.data;
    const loaded = (): ProductProjection => {
      const result = this.store.read(actor, input.productId);
      if (!result.ok) throw new ResearchFault(result.code);
      if (result.value.objectiveRevision !== input.expectedObjectiveRevision) throw new ResearchFault("stale_revision");
      return result.value;
    };
    const first = loaded();
    const paths = this.paths(actor);
    const requestKey = digest(input.requestId);
    const payloadDigest = digest(JSON.stringify(input));
    this.ensureDirectory(paths);

    const before = this.read(paths);
    const prior = before.receipts[requestKey];
    if (prior && prior.payloadDigest !== payloadDigest) throw new ResearchFault("idempotency_conflict");
    const record = before.products[input.productId] ?? emptyRecord();

    // At most one completed run per objective revision; an unavailable provider is not asked again to say so.
    const here = record.runs.filter((run) => run.objectiveRevision === first.objectiveRevision);
    const provider = this.options.provider;
    const needsRun = !prior && !here.some((run) => run.outcome === "completed") && !(provider === undefined && here.some((run) => run.outcome === "unavailable"));
    const draft = needsRun ? await this.runResearch(first, requestKey, paths.ownerKey, provider) : undefined;

    const outcome = withInflightLock(paths.locks, `research-${paths.ownerKey}`, () => {
      const product = loaded();
      const state = this.read(paths);
      const existing = state.receipts[requestKey];
      if (existing) {
        if (existing.payloadDigest !== payloadDigest) throw new ResearchFault("idempotency_conflict");
        const current = state.products[input.productId] ?? emptyRecord();
        return { run: current.runs.find((run) => run.id === existing.runId), view: project(product.id, product.brief, product.objectiveRevision, current, true) };
      }
      if (Object.keys(state.receipts).length >= PRODUCT_RESEARCH_LIMITS.receipts) throw new ResearchFault("capacity");
      const now = this.clock.iso();
      let next = normalize(state.products[input.productId] ?? emptyRecord(), product.brief, now);
      if (draft) {
        if (next.runs.length >= PRODUCT_RESEARCH_LIMITS.runs) throw new ResearchFault("capacity");
        const known = new Set([...CATALOG.map((item) => item.id), ...next.questions.map((item) => item.id)]);
        const proposed: Question[] = (draft.questions ?? []).map((item) => ({ id: `pq_${digest(item.text).slice(0, 16)}`, text: item.text, origin: "provider" as const, objectiveRevision: product.objectiveRevision }))
          .filter((item, index, all) => !known.has(item.id) && all.findIndex((other) => other.id === item.id) === index);
        next = { ...next, runs: [...next.runs, { ...draft.run, startedAt: now, finishedAt: now }], questions: [...next.questions, ...proposed] };
      }
      const answered: Answer[] = [];
      for (const item of input.answers ?? []) {
        const fields = dependsOf(item.questionId, next);
        if (!fields) throw new ResearchFault("invalid_input");
        const standing = next.answers.find((answer) => answer.questionId === item.questionId && validAnswer(answer, product.brief, next));
        if (standing) {
          if (standing.answer !== item.answer) throw new ResearchFault("already_answered");
          continue;
        }
        answered.push({ questionId: item.questionId, answer: item.answer, objectiveRevision: product.objectiveRevision, scopeDigest: scopeDigest(product.brief, fields), status: "accepted", answeredAt: now });
      }
      if (next.answers.length + answered.length > PRODUCT_RESEARCH_LIMITS.answers || next.questions.length > PRODUCT_RESEARCH_LIMITS.questions) throw new ResearchFault("capacity");
      next = { ...next, answers: [...next.answers, ...answered] };
      this.commit(paths, {
        ...state,
        products: Object.fromEntries([...Object.entries(state.products).filter(([key]) => key !== input.productId), [input.productId, next] as const]),
        receipts: Object.fromEntries([...Object.entries(state.receipts), [requestKey, { payloadDigest, productId: input.productId, runId: draft?.run.id ?? null, savedAt: now }] as const]),
      });
      return { run: draft ? next.runs.find((run) => run.id === draft.run.id) : undefined, view: project(product.id, product.brief, product.objectiveRevision, next, false) };
    }, { run_id: `product-research-${randomUUID()}` });

    // Canonical record: the run is stage evidence in the product's own durable record. A retry heals a failure here.
    if (outcome.run) this.recordEvidence(actor, input.productId, outcome.run);
    return outcome.view;
  }

  private recordEvidence(actor: string, productId: string, run: Run): void {
    const result = this.store.read(actor, productId);
    if (!result.ok) throw new ResearchFault(result.code);
    const product = result.value;
    if (run.objectiveRevision !== product.objectiveRevision || product.stageEvidence.some((item) => item.id === run.id)) return;
    const saved = this.store.transition(actor, {
      version: "product-intent-v1", requestId: `prsrch_${digest(run.id).slice(0, 40)}`, id: productId,
      expectedRevision: product.revision, expectedObjectiveRevision: product.objectiveRevision,
      stageEvidence: [{
        id: run.id, stage: "research", outcome: run.outcome === "completed" ? "succeeded" : run.outcome === "failed" ? "failed" : "blocked",
        objectiveRevision: run.objectiveRevision, observedAt: run.finishedAt,
        references: run.sources.map(({ label, url }) => ({ label, url })),
      }],
    });
    if (!saved.ok) throw new ResearchFault(saved.code);
  }

  private async runResearch(product: ProductProjection, requestKey: string, ownerKey: string, provider: ProductResearchProvider | undefined): Promise<Draft> {
    const sources = (product.brief.research ?? []).map(({ label, url }) => ({ label, url, disposition: "data" as const }));
    const base = {
      id: `prun_${digest(`${ownerKey}:${requestKey}`).slice(0, 32)}`, objectiveRevision: product.objectiveRevision, productRevision: product.revision,
      provider: provider?.id ?? null, budgetUsd: this.budgetUsd, spendUsd: 0, sources, executionAuthority: "none" as const,
    };
    const make = (outcome: ProductResearchRunOutcome, extra: { failure?: ProductResearchFailure; summary?: string; spendUsd?: number } = {}): Draft =>
      ({ run: { ...base, ...extra, outcome }, questions: undefined });
    if (!provider) return make("unavailable");
    let raw: unknown;
    try {
      raw = await provider.research({ objective: product.brief.objective ?? product.brief.idea, objectiveRevision: product.objectiveRevision, sources: sources.map(({ label, url }) => ({ label, url })) });
    } catch {
      // The provider's own message is untrusted text: only the closed failure code is recorded.
      return make("failed", { failure: "provider_error" });
    }
    const output = providerOutputSchema.safeParse(raw);
    if (!output.success) return make("failed", { failure: "invalid_output" });
    const spendUsd = output.data.spendUsd ?? 0;
    if (spendUsd > this.budgetUsd) return make("failed", { failure: "over_budget", spendUsd });
    return { ...make("completed", { summary: output.data.summary, spendUsd }), questions: output.data.questions };
  }

  async run(actor: string, command: unknown): Promise<ProductResearchResult> {
    try { return { ok: true, value: await this.execute(actor, command) }; }
    catch (error) {
      if (error instanceof ResearchFault) return { ok: false, code: error.code };
      if (error instanceof InflightLockError) return { ok: false, code: "busy" };
      return { ok: false, code: "unavailable" };
    }
  }
}
