import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { TargetJobAdmission, TargetJobRead, TargetJobRecord } from "./drain.js";
import { systemClock, type Clock } from "./clock.js";
import { daemonInstanceRegistryPath } from "./deployer.js";
import { dispatchClaimRef } from "./dispatch-claim.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { isPaused, isSafeTaskId, isStopped, requestKick } from "./fleet-control.js";
import { ghTextAsync } from "./github-transport.js";
import { CORE_INSTANCE, DEFAULT_INSTANCE_STATE_BASE, instanceStateRoot } from "./instance-gateway.js";
import { parseInstanceRegistry, type RegistryInstance } from "./instance-registry.js";
import { ledgerRunBelongsToTask, readLedgerUnionRecordsSync, realLedgerFs, type LedgerGrepFsDeps } from "./ledger-union.js";
import { loadManagedRepos } from "./managed-repos.js";
import { DEFAULT_LIVENESS_BOUND_MS } from "./non-worker-verdict.js";
import { ProductIntentStore } from "./product-intent-store.js";
import {
  productIdSchema, productRequestIdSchema, type ProductStoreCode, type StoredProduct,
} from "./product-intent.js";
import { ghProductRepositoryProvider, type ProductRepositoryProvider } from "./product-repository.js";
import { resolveRepoLayout } from "./repo-layout.js";
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
/** The reviewed starter PR's own evidence id, bound to the head its merge produced. */
export const starterEvidenceId = (head: string) => `bootstrap-starter:${head}`;
/** The kick origin names THIS build request, so the target daemon's own dispatch row correlates to it, not to the product. */
export const productBuildKickOrigin = (productId: string, operationId: string) => `product:${productId}/${operationId}`;

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
  | "plan_not_approved" | "target_not_enrolled" | "target_unreadable" | "target_daemon_missing" | "runner_missing" | "bootstrap_unverified"
  | "task_not_found" | "task_unreadable" | "task_stale" | "task_claimed" | "task_merged" | "budget_exceeded"
  | "fleet_halted" | "kick_failed";
export type ProductBuildResult =
  | { ok: true; value: { receipt: ProductBuildReceipt; replayed: boolean }; code?: never }
  | { ok: false; code: ProductBuildCode; value?: never };

export interface BuildRepository { id: number; owner: string; name: string; defaultBranch: string }
export interface TargetInspection { enrolled: boolean | undefined; head: string | undefined; readmeOnly: boolean | undefined }
export interface BuildTask { id: string; origin: string | undefined; status: string; budgetUsd: number | undefined; claimed: boolean; merged: boolean }
export type TaskRead = { state: "found"; task: BuildTask } | { state: "absent" } | { state: "unreadable" };
/**
 * What the target's GitHub refs show. A held claim proves admission only, and the exact `run-<taskId>-<epochMs>`
 * branches are only links: neither can express `running`, which only the target daemon's own ledger evidences.
 */
export type BuildObservation = { state: "none" | "admitted"; branches: readonly string[] } | { state: "unknown" };
export type BootstrapCheck = (typeof BOOTSTRAP_CHECKS)[number];
/**
 * What GitHub shows for the starter/template change that produced EXACTLY this head: the merged pull request whose
 * merge commit is the head, whether a reviewer approved it, and which of the four checks concluded `success` on it.
 * `absent`: no such merged PR; `unreadable`: GitHub could not be read, which is never "no starter".
 */
export type BootstrapRead =
  | { state: "found"; starter: { number: number; reviewed: boolean }; checks: Record<BootstrapCheck, boolean> }
  | { state: "absent" } | { state: "unreadable" };
/** Everything the operation must verify about the target immediately before it acts. */
export interface ProductBuildTarget {
  inspect(repository: BuildRepository): Promise<TargetInspection>;
  /** Whether the target's acceptance runner is registered; the closed registry refuses an unknown owner. */
  runnerRegistered(repository: BuildRepository): boolean;
  task(repository: BuildRepository, taskId: string): Promise<TaskRead>;
  observe(repository: BuildRepository, taskId: string): Promise<BuildObservation>;
  /** The reviewed starter PR and real test/typecheck/build/security conclusions at the exact `head`. */
  bootstrap(repository: BuildRepository, head: string): Promise<BootstrapRead>;
}

/** One build request, as the target daemon's ledger must name it before its run can read as this build's. */
export interface ExecutionQuery { taskId: string; origin: string; repo: string; requestedAt: string; nowMs: number }
/**
 * Native execution evidence for ONE build request. `dispatched`: the daemon's admission consumed this request's kick;
 * `running`: the run that dispatch started has no terminal row and wrote inside the liveness bound; `ended`: it wrote a
 * terminal row; `silent`: it wrote none, and nothing inside the bound either. `unknown`: the ledger could not be read.
 */
export type ExecutionRead = { state: "unknown" | "none" | "refused" | "dispatched" } | { state: "running" | "ended" | "silent"; runId: string };

/** The daemon's kick steps (daemon.ts runDaemon) and a task run's own steps (run-task-verb.ts) this reader trusts. */
const KICK_DISPATCHED_STEP = "console.kick_dispatched";
const KICK_REFUSED_STEP = "console.kick_refused";
const RUN_START_STEP = "run.start";
/** Every run writes exactly one `verdict` (run-task-verb.ts endRunOnce, refusals included); a thrown run `run.error` first. */
const RUN_TERMINAL_STEPS: ReadonlySet<string> = new Set(["verdict", "run.error"]);

/**
 * Reads the TARGET daemon's own ledger (`stateDir`, every rotation) for this request's execution. Correlation, never
 * freshness: the kick row must name this request's origin, task and repository at or after its recorded time; the
 * run is the first `run.start` of this task at or after that dispatch; it is live only with no terminal row and an
 * own row inside the board's liveness bound (W1-T179), which only bounds a run that died without a verdict.
 */
export function readTargetExecution(stateDir: string, query: ExecutionQuery, fsDeps: LedgerGrepFsDeps = realLedgerFs): ExecutionRead {
  const read = readLedgerUnionRecordsSync(stateDir, { sinceTs: query.requestedAt, refuseIncomplete: true, keep: (line) => line.includes(query.taskId) }, fsDeps);
  // An unlisted or unreadable file, or no ledger at all, is a daemon this process cannot see: never "nothing ran".
  if (!read.ok || (!read.liveFileRead && read.archiveCount === 0)) return { state: "unknown" };
  const at = (row: Record<string, unknown>) => (typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN);
  const rows = read.rows.filter((row) => Number.isFinite(at(row))).sort((a, b) => at(a) - at(b));
  const kick = rows.find((row) => (row.step === KICK_DISPATCHED_STEP || row.step === KICK_REFUSED_STEP) && row.task === query.taskId &&
    row.origin === query.origin && typeof row.repo === "string" && row.repo.toLowerCase() === query.repo.toLowerCase());
  if (!kick) return { state: "none" };
  if (kick.step === KICK_REFUSED_STEP) return { state: "refused" };
  const start = rows.find((row) => row.step === RUN_START_STEP && row.task_id === query.taskId &&
    ledgerRunBelongsToTask(query.taskId, row.run_id) && at(row) >= at(kick));
  if (!start) return { state: "dispatched" };
  const runId = start.run_id as string;
  const own = rows.filter((row) => row.run_id === runId);
  if (own.some((row) => typeof row.step === "string" && RUN_TERMINAL_STEPS.has(row.step))) return { state: "ended", runId };
  if (!(query.nowMs - Math.max(...own.map(at)) <= DEFAULT_LIVENESS_BOUND_MS)) return { state: "silent", runId };
  return { state: "running", runId };
}

/** Which daemon drives the target: its config root, the root that daemon's own kick port reads. */
export type DaemonRootRead = { state: "found"; root: string; instance: string; native?: true } | { state: "absent" } | { state: "unreadable" };

/** Where the daemon instances live, as serve's own instance gateway names them. */
export interface ProductBuildInstances {
  /** The repo-tracked daemon instance registry; defaults to the one under `repoRoot`. */
  registryPath?: string;
  /** Where each non-core instance's config root is mounted for this process. */
  stateBase?: string;
  coreInstance?: string;
  readText?: (path: string) => string;
}

export interface ProductBuildOptions {
  /** This process's fleet root: the product store, and the core instance's daemon root. */
  root?: string;
  /** The checkout whose reviewed managed-repository set enrolls targets and whose registry names their daemons. */
  repoRoot?: string;
  provider?: Pick<ProductRepositoryProvider, "read">;
  target?: ProductBuildTarget;
  store?: ProductIntentStore;
  instances?: ProductBuildInstances;
  /** The target's own daemon root; defaults to {@link registryDaemonRoot}. */
  daemonRoot?: (repository: BuildRepository) => DaemonRootRead;
  /** The existing guarded repo-scoped kick marker, written under the TARGET daemon's root; its admission still decides. */
  kick?: (root: string, taskId: string, origin: string, repo: string) => void;
  clock?: Clock;
}

/**
 * The config root the target repository's OWN daemon reads kick markers from. The registry names one
 * live instance per repository: core's root is this process's fleet root, and every other instance's is
 * its state root under `stateBase`, the convention instance-gateway.ts reads that instance's ledger and
 * control flags through. A repository no live instance drives has no daemon to deliver to, and a root
 * whose `state/` directory this process cannot reach is unknown: writing there would mint a directory
 * no daemon reads.
 */
export function registryDaemonRoot(coreRoot: string | undefined, options: ProductBuildInstances & { repoRoot?: string }): (repository: BuildRepository) => DaemonRootRead {
  return (repository) => {
    const path = options.registryPath ?? (options.repoRoot === undefined ? undefined : daemonInstanceRegistryPath(options.repoRoot));
    if (path === undefined) return { state: "unreadable" };
    let instances: RegistryInstance[];
    try {
      instances = parseInstanceRegistry((options.readText ?? ((file: string) => readFileSync(file, "utf8")))(path)).instances;
    } catch (error) {
      // An unreadable or malformed registry is an unknown daemon, which the caller refuses; it is never "no daemon".
      void error; return { state: "unreadable" };
    }
    const wanted = `${repository.owner}/${repository.name}`.toLowerCase();
    const instance = instances.find((entry) => entry.live && entry.repo.toLowerCase() === wanted);
    if (!instance) return { state: "absent" };
    const root = instance.name === (options.coreInstance ?? CORE_INSTANCE) ? coreRoot
      : instanceStateRoot(instance, options.stateBase ?? DEFAULT_INSTANCE_STATE_BASE).root;
    if (root === undefined || !existsSync(join(root, "state"))) return { state: "unreadable" };
    return { state: "found", root, instance: instance.name };
  };
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
  // A target's shard directory is repository-relative; the one layout resolver names it, never a repeated literal.
  const layout = resolveRepoLayout(sep, () => undefined);
  const shardDirectory = relative(layout.root, join(layout.planDir, "tasks.d")).split(sep).join("/");
  const refs = z.array(z.object({ ref: z.string(), object: z.object({ sha: z.string().regex(sha) }).optional() }).passthrough());
  // `matching-refs` is a PREFIX match (W9-T1 also lists W9-T10's claim), so only the exact ref is this task's claim.
  const claimOf = async (repo: BuildRepository, taskId: string) =>
    refs.parse(JSON.parse(await api(`${slug(repo)}/git/matching-refs/rmd-dispatch/${taskId}`))).find((entry) => entry.ref === dispatchClaimRef(taskId));
  /** The exact published `run-<taskId>-<epochMs>` branches (run-task-verb.ts names a run's branch `run-<runId>`). */
  const runBranches = async (repo: BuildRepository, taskId: string): Promise<string[]> => {
    const prefix = `run-${taskId}-`;
    return refs.parse(JSON.parse(await api(`${slug(repo)}/git/matching-refs/heads/${prefix}`)))
      .map((branch) => branch.ref.replace(/^refs\/heads\//, ""))
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)));
  };
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
        const names = z.array(z.object({ name: z.string() })).parse(JSON.parse(await api(`${slug(repo)}/contents/${shardDirectory}?ref=${repo.defaultBranch}`)));
        const shard = names.find((entry) => entry.name.startsWith(`${taskId}-`) && entry.name.endsWith(".yaml"));
        if (!shard) return { state: "absent" };
        const parsed = z.array(z.object({ id: z.string(), origin: z.string().optional(), status: z.string(), budget_usd: z.number().optional() }).passthrough())
          .parse(parseYaml(await api(`${slug(repo)}/contents/${shardDirectory}/${shard.name}?ref=${repo.defaultBranch}`, true)));
        const task = parsed.find((entry) => entry.id === taskId);
        if (!task) return { state: "absent" };
        const claim = await claimOf(repo, taskId);
        const credit = z.object({ total_count: z.number() }).parse(JSON.parse(await api(
          `search/issues?q=${encodeURIComponent(`repo:${repo.owner}/${repo.name} is:pr is:merged "Remudero-Task: ${taskId}"`)}`)));
        return { state: "found", task: { id: taskId, origin: task.origin, status: task.status, budgetUsd: task.budget_usd, claimed: claim !== undefined, merged: credit.total_count > 0 } };
      } catch (error) {
        // Unreadable is its own state: a claim or credit that cannot be read is never "free".
        void error; return { state: "unreadable" };
      }
    },
    async observe(repo, taskId) {
      try {
        // A held claim proves a lane admitted the task (it is taken before any spend). Neither it nor a fresh branch
        // proves THIS build is executing: a claim can precede the worker, and an ended or refused run leaves both behind.
        const claim = await claimOf(repo, taskId);
        return { state: claim ? "admitted" : "none", branches: await runBranches(repo, taskId) };
      } catch (error) {
        // Not observed is not "running": the caller records nothing beyond what it did itself.
        void error; return { state: "unknown" };
      }
    },
    async bootstrap(repo, head) {
      try {
        const pulls = z.array(z.object({ number: z.number().int().positive(), merged_at: z.string().nullable(), merge_commit_sha: z.string().nullable(),
          base: z.object({ ref: z.string() }) }).passthrough()).parse(JSON.parse(await api(`${slug(repo)}/commits/${head}/pulls`)));
        // Only the merged PR whose merge commit IS this head, into the default branch, is this head's starter.
        const starter = pulls.find((pull) => pull.merged_at !== null && pull.merge_commit_sha === head && pull.base.ref === repo.defaultBranch);
        if (!starter) return { state: "absent" };
        const reviews = z.array(z.object({ state: z.string(), user: z.object({ login: z.string() }).passthrough().nullable() }).passthrough())
          .parse(JSON.parse(await api(`${slug(repo)}/pulls/${starter.number}/reviews`)));
        // A reviewer's LATEST verdict stands: an approval later withdrawn by that reviewer does not count.
        const latest = new Map<string, string>();
        for (const review of reviews) if (review.user !== null && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user.login, review.state);
        const reviewed = [...latest.values()].includes("APPROVED") && ![...latest.values()].includes("CHANGES_REQUESTED");
        const runs = z.object({ check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }).passthrough()) })
          .parse(JSON.parse(await api(`${slug(repo)}/commits/${head}/check-runs?per_page=100`))).check_runs;
        const passed = (check: BootstrapCheck) => {
          const named = runs.filter((run) => { const name = run.name.toLowerCase(); return name === check || name.endsWith(`/ ${check}`); });
          return named.length > 0 && named.every((run) => run.status === "completed" && run.conclusion === "success");
        };
        return { state: "found", starter: { number: starter.number, reviewed },
          checks: { test: passed("test"), typecheck: passed("typecheck"), build: passed("build"), security: passed("security") } };
      } catch (error) {
        // Unreadable bootstrap evidence is unknown, which leaves the gate closed; it is never read as "bootstrapped".
        void error; return { state: "unreadable" };
      }
    },
  };
}

/**
 * Starts ONE guarded target-repository task for an approved product plan. It never launches a worker:
 * it verifies everything immediately before acting, writes the existing repo-scoped kick marker the
 * daemon's own admission consumes, and records `queued` — never `running` — until the target daemon's
 * own ledger shows the run this request's kick started ({@link readTargetExecution}).
 */
export class ProductBuildService {
  private readonly provider: Pick<ProductRepositoryProvider, "read">;
  private readonly target: ProductBuildTarget;
  private readonly store: ProductIntentStore;
  private readonly kick: NonNullable<ProductBuildOptions["kick"]>;
  private readonly daemonRoot: NonNullable<ProductBuildOptions["daemonRoot"]>;
  private readonly clock: Clock;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ProductBuildOptions) {
    this.provider = options.provider ?? ghProductRepositoryProvider();
    this.clock = options.clock ?? systemClock;
    this.target = options.target ?? ghProductBuildTarget({ repoRoot: options.repoRoot });
    this.store = options.store ?? new ProductIntentStore({ root: options.root });
    this.kick = options.kick ?? ((root, taskId, origin, repo) => { requestKick(root, taskId, origin, repo); });
    this.daemonRoot = options.daemonRoot ?? registryDaemonRoot(options.root, { ...options.instances, repoRoot: options.repoRoot });
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

  /**
   * W1-T10799: where the request's marker goes. A live instance of the target keeps its own root unchanged. Only a
   * READABLE registry that names no live instance (`absent`) routes to the CORE daemon's root, which owns one bounded
   * native job; an unreadable registry stays unreadable, and a core root without a `state/` directory is unreadable
   * too, because a marker written there would mint a directory no daemon reads.
   */
  private routeDaemon(subject: BuildRepository): Exclude<DaemonRootRead, { state: "absent" }> {
    const read = this.daemonRoot(subject);
    if (read.state !== "absent") return read;
    const core = this.options.root;
    if (core === undefined || !isAbsolute(core) || !existsSync(join(core, "state"))) return { state: "unreadable" };
    return { state: "found", root: core, instance: this.options.instances?.coreInstance ?? CORE_INSTANCE, native: true };
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
    const origin = productBuildKickOrigin(product.id, operationId);
    let daemon: DaemonRootRead | undefined;

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
      // The marker goes where the target's OWN daemon reads it, and that daemon must not be halted either.
      daemon = this.routeDaemon(subject);
      if (daemon.state === "unreadable") throw new Fault("target_unreadable");
      if (!isAbsolute(daemon.root)) throw new Fault("unavailable");
      if (isStopped(daemon.root) || isPaused(daemon.root)) throw new Fault("fleet_halted");
      if (inspected.head === undefined || inspected.readmeOnly === undefined) throw new Fault("target_unreadable");
      // A README-only head records its reviewed starter PR and real check receipts from GitHub BEFORE the gate reads them.
      if (inspected.readmeOnly && !bootstrapConfirmed(product, inspected)) product = await this.reconcileBootstrap(actor, product, subject, inspected.head);
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

      // The request's own time is taken BEFORE the marker exists, so the daemon's dispatch row is never earlier.
      const requestedAt = this.clock.iso();
      try { this.kick(daemon.root, input.taskId, origin, subject.name); }
      catch (error) { throw Object.assign(new Fault("kick_failed"), { cause: error }); }
      const queued = this.append(actor, product, requestKey, { id: operationId, outcome: "queued", url: `https://github.com/${subject.owner}/${subject.name}` }, requestedAt);
      product = queued;
    }
    const queuedEvidence = product.stageEvidence.find((item) => item.id === operationId);
    if (!queuedEvidence) throw new Fault("recovery_required");

    // Observation may add admitted/running evidence, each with its own record; absence adds nothing. Admission is a
    // held claim or the daemon's dispatch of this request; running is ONLY the target daemon's native evidence.
    const seen = await this.target.observe(subject, input.taskId);
    daemon ??= this.routeDaemon(subject);
    // A daemon whose state this process cannot reach (a remote or unmounted instance) has no readable evidence.
    const execution: ExecutionRead = daemon.state !== "found" || !isAbsolute(daemon.root) ? { state: "unknown" }
      : readTargetExecution(join(daemon.root, "state"), { taskId: input.taskId, origin, repo: subject.name, requestedAt: queuedEvidence.observedAt, nowMs: this.clock.now() });
    const repositoryUrl = `https://github.com/${subject.owner}/${subject.name}`;
    const branch = execution.state === "running" ? `run-${execution.runId}` : undefined;
    const runUrl = branch !== undefined && seen.state !== "unknown" && seen.branches.includes(branch) ? `${repositoryUrl}/tree/${branch}` : repositoryUrl;
    // The daemon refusing THIS request's kick outranks a claim some other dispatch holds: that claim is not this admission.
    const wanted = {
      admitted: execution.state !== "refused" && (seen.state === "admitted" || ["dispatched", "running", "ended", "silent"].includes(execution.state)),
      running: execution.state === "running",
    };
    for (const outcome of ["admitted", "running"] as const) {
      const id = `${operationId}:${outcome}`;
      if (!wanted[outcome] || product.stageEvidence.some((item) => item.id === id)) continue;
      product = this.append(actor, product, `pbuild_${digest(id).slice(0, 48)}`, { id, outcome, url: outcome === "running" ? runUrl : repositoryUrl });
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

  /**
   * Persists what GitHub shows for this exact head: the reviewed starter PR and each check that really concluded
   * `success`. Nothing is invented or waived: an unreviewed starter, a failing or absent check, or a PR that is not
   * this head's merge records nothing, so the gate stays closed and the missing receipt stays actionable.
   */
  private async reconcileBootstrap(actor: string, product: StoredProduct, subject: BuildRepository, head: string): Promise<StoredProduct> {
    const read = await this.target.bootstrap(subject, head);
    if (read.state !== "found" || !read.starter.reviewed) return product;
    const url = `https://github.com/${subject.owner}/${subject.name}/pull/${read.starter.number}`;
    const wanted = [
      { id: starterEvidenceId(head), label: "Reviewed starter PR" },
      ...BOOTSTRAP_CHECKS.filter((check) => read.checks[check]).map((check) => ({ id: bootstrapEvidenceId(head, check), label: `Starter ${check} receipt` })),
    ].filter((item) => !product.stageEvidence.some((known) => known.id === item.id));
    if (wanted.length === 0) return product;
    const saved = this.store.transition(actor, {
      version: "product-intent-v1", requestId: `pboot_${digest(`${product.id}:${wanted.map((item) => item.id).join(",")}`).slice(0, 48)}`,
      id: product.id, expectedRevision: product.revision, expectedObjectiveRevision: product.objectiveRevision,
      stageEvidence: wanted.map((item) => ({ id: item.id, stage: "repository" as const, outcome: "succeeded" as const,
        objectiveRevision: product.objectiveRevision, observedAt: this.clock.iso(), references: [{ label: item.label, url }] })),
    });
    if (!saved.ok) throw new Fault(saved.code);
    return this.readProduct(actor, product.id);
  }

  private append(actor: string, product: StoredProduct, requestId: string, item: { id: string; outcome: ProductBuildOutcome; url: string }, observedAt = this.clock.iso()): StoredProduct {
    const saved = this.store.transition(actor, {
      version: "product-intent-v1", requestId, id: product.id, expectedRevision: product.revision, expectedObjectiveRevision: product.objectiveRevision,
      stageEvidence: [{ id: item.id, stage: "build", outcome: item.outcome, objectiveRevision: product.objectiveRevision,
        observedAt, references: [{ label: "Target repository", url: item.url }] }],
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

/**
 * W1-T10799: who may run an enrolled target's task when its kick marker sits under the CORE root. The same two
 * reviewed sources the build request read: the managed set enrolls the repository, and the live instance registry
 * says whether it has a daemon of its own. Either source unreadable is `unreadable`, never "no daemon" and never
 * "not enrolled", so neither a malformed file nor an ambiguous owner can start a job.
 */
export function nativeTargetAdmission(repoName: string, options: ProductBuildInstances & { repoRoot: string }): TargetJobAdmission {
  let registry: RegistryInstance[];
  let managed: { owner: string; repo: string }[];
  try {
    const path = options.registryPath ?? daemonInstanceRegistryPath(options.repoRoot);
    registry = parseInstanceRegistry((options.readText ?? ((file: string) => readFileSync(file, "utf8")))(path)).instances;
    managed = loadManagedRepos(options.repoRoot);
  } catch (error) {
    void error; return { state: "unreadable" };
  }
  const wanted = repoName.toLowerCase();
  const enrolled = managed.filter((entry) => entry.repo.toLowerCase() === wanted);
  if (enrolled.length === 0) return { state: "not_enrolled" };
  if (enrolled.length > 1) return { state: "unreadable" };
  const { owner, repo } = enrolled[0]!;
  const live = registry.find((entry) => entry.live && entry.repo.toLowerCase() === `${owner}/${repo}`.toLowerCase());
  return live ? { state: "own_instance", instance: live.name } : { state: "native", owner };
}

const targetJobRecordSchema = z.object({
  origin: z.string().min(1), taskId: z.string().min(1), repo: z.string().min(1), status: z.enum(["queued", "admitted", "ended", "refused"]),
  attempts: z.number().int().min(0), updatedAt: z.string(), reason: z.string().optional(), stopReason: z.string().optional(),
}).strict();

/** The durable job record: one file per kick origin under `<root>/state/target-jobs`, replaced atomically. */
export function fileTargetJobStore(root: string): { read: (origin: string) => TargetJobRead; write: (record: TargetJobRecord) => void } {
  const dir = join(root, "state", "target-jobs");
  const pathFor = (origin: string) => join(dir, `${digest(origin).slice(0, 48)}.json`);
  return {
    read(origin) {
      const path = pathFor(origin);
      if (!existsSync(path)) return { state: "absent" };
      try {
        const record = targetJobRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        // A record filed under this name for another origin is a corrupt store, never this job.
        return record.origin === origin ? { state: "found", record } : { state: "unreadable" };
      } catch (error) {
        // A torn or foreign record is unknown, which the caller holds; it is never "no job", which would respend.
        void error; return { state: "unreadable" };
      }
    },
    write(record) {
      mkdirSync(dir, { recursive: true });
      const path = pathFor(record.origin);
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(targetJobRecordSchema.parse(record)), { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}
