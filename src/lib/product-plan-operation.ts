import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { ghTextAsync } from "./github-transport.js";
import { acquireInflightLock, InflightLockError } from "./inflight-lock.js";
import { LEDGER_ROTATION_LOCK_SUFFIX } from "./ledger-path.js";
import { ledgerLivePath, ledgerRotationEntries, listedLedgerFiles, readLedgerUnionRawLinesAsync, readLedgerUnionRecords } from "./ledger-union.js";
import { isHumanHoldCandidate, type GhApiFetcher } from "./open-prs-rest.js";
import { ProductIntentStore } from "./product-intent-store.js";
import { readTargetRunnerConfig, type TargetRunnerConfig } from "./product-target-config.js";
import {
  productIdSchema, productRequestIdSchema, type ProductBrief, type ProductStoreCode, type StoredProduct,
} from "./product-intent.js";
import type { ProductRepositoryProvider } from "./product-repository.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { parseOwnerRepoFromRemoteUrl } from "./onboard/inventory.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

export const PRODUCT_PLAN_OPERATION_VERSION = "product-plan-operation-v1" as const;
/** W1-T13875 PRIMARY CONTROL: the longest an operation's ledger evidence read may take before it answers "no evidence" (state unknown). */
export const PRODUCT_PLAN_LEDGER_READ_BOUND_MS = 15_000;
/** PRIMARY CONTROL: maintained quotas on the plan-operation journal; none of it grants spend or planning authority. */
export const PRODUCT_PLAN_OPERATION_LIMITS = { operations: 256, stateBytes: 2 * 1024 * 1024, briefBytes: 60 * 1024, evidenceBytes: 256 * 1024 } as const;

/** Names a durable, reviewed handoff: the target task's `origin:` must carry exactly this (or an explicit association). */
export const productPlanOrigin = (productId: string, planEvidenceId: string) => `product-plan#${productId}/${planEvidenceId}`;

/** The reviewed task's design must carry the complete approved input the implementation worker consumes. */
export const productCasePlanText = (brief: ProductBrief) => `Approved product brief:\n${JSON.stringify(brief, (_key, value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value, 2)}`;

const layout = resolveRepoLayout(sep, () => undefined);
const shardDirectory = relative(layout.root, join(layout.planDir, "tasks.d")).split(sep).join("/");
const masterPlanFile = relative(layout.root, layout.masterPlan).split(sep).join("/");
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
 * the native contract (a trusted `remudero-review` success at the exact head, resolved through its poster, on a plan-only PR); no standing CHANGES_REQUESTED review or human hold; one task content at the reviewed
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
      // Manual approval can withdraw a human hold; it never substitutes for the filed native plan protocol.
      const { readReviewStatusEntry, resolveReviewProvenance, REVIEWER_IDENTITY_ENV } = await import("./review.js");
      const trusted = (input.trustedReviewer ?? process.env[REVIEWER_IDENTITY_ENV] ?? "").trim();
      if (!trusted || files.length >= 100 || !files.every((file) => file.filename.startsWith("plan/") || file.filename === masterPlanFile)) return refuse("plan_not_approved");
      const fetcher: GhApiFetcher = async (args) => JSON.parse(await text(args, { maxBuffer: 1024 * 1024, timeout: 20_000 })) as unknown;
      const entry = await readReviewStatusEntry(repo.owner, repo.name, pull.head.sha, fetcher);
      if (resolveReviewProvenance(entry, trusted) !== "success") return refuse("plan_not_approved");
      const review = "native-status" as const;
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
  | "runner_config_missing" | "runner_config_invalid"
  | "envelope_missing" | "handoff_unavailable" | "task_stale";
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
  /** Accepted calls register synchronously under their ledger task id before returning their promise. */
  inFlight?(taskId: string): boolean;
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
  checkout: (repository: PlanRepository, targetHead: string) => string | undefined | Promise<string | undefined>;
  /** Reads the target's runner configuration at the frozen head; the committed-tree reader unless a test supplies one. */
  runnerConfig?: (checkout: string, targetHead: string) => Promise<TargetRunnerConfig>;
  text?: GhText;
  clock?: Clock;
  isAlive?: (pid: number) => boolean;
  /** W1-T13875: overrides PRODUCT_PLAN_LEDGER_READ_BOUND_MS; a test seam for the bounded evidence read. */
  ledgerReadBoundMs?: number;
  /** W1-T13875: test seam for the evidence reader. */
  readLedgerLines?: (stateDir: string, opts: { sinceTs: string; untilMs?: number; refuseIncomplete: true; keep: (line: string) => boolean }) =>
    Promise<{ ok: boolean; rawLines: readonly string[] }>;
  sync?: (fd: number) => void;
}

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const modeSchema = z.enum(["create", "clarify"]);
// `settled`: a legacy refusal whose hand-off window shows no run, so nothing ran.
const finalEvidenceSchema = z.object({
  exited: z.boolean(), failed: z.boolean(), opened: z.string().max(512).optional(), settled: z.literal(true).optional(),
}).strict().refine((seen) => seen.exited || seen.failed || seen.opened !== undefined || seen.settled === true);
type LedgerEvidence = z.infer<typeof finalEvidenceSchema> & { pid?: number };
type LedgerRead = LedgerEvidence | "unread";
const recordSchema = z.object({
  operationId: hex64, productId: productIdSchema, revision, objectiveRevision: revision, briefDigest: hex64,
  repository: z.object({ id: revision, owner: z.string().min(1).max(64), name: z.string().min(1).max(128) }).strict(),
  targetHead: z.string().regex(sha), mode: modeSchema, planEvidenceId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  command: z.object({ verb: z.literal("plan"), mode: modeSchema, repoRoot: z.string().min(1).max(1024), briefBytes: z.number().int().positive(), briefDigest: hex64 }).strict(),
  requestedAt: z.string().datetime(),
  // "exited" is a nonzero child exit, which the gateway reports as refused. `beforeLaunch` marks a refusal where nothing
  // ran; a "refused" saved before this marker existed may be either, so only its hand-off window is read, once.
  handoff: z.object({ outcome: z.enum(["queued", "refused", "exited", "unknown"]), at: z.string().datetime(), beforeLaunch: z.literal(true).optional() }).strict().optional(),
}).strict();
type Record_ = z.infer<typeof recordSchema>;
const journalSchema = z.object({
  version: z.literal(PRODUCT_PLAN_OPERATION_VERSION), ownerKey: hex64,
  operations: z.record(hex64, recordSchema), requests: z.record(hex64, z.object({ operationId: hex64, payloadDigest: hex64 }).strict()),
}).strict();
type Journal = z.infer<typeof journalSchema>;
/** Final evidence lives beside the journal, so a journal at its byte limit still keeps what was read. */
const keptSchema = z.object({
  version: z.literal(PRODUCT_PLAN_OPERATION_VERSION), ownerKey: hex64, evidence: z.record(hex64, finalEvidenceSchema),
}).strict();
type Kept = z.infer<typeof keptSchema>;
interface Paths { directory: string; state: string; kept: string; ownerKey: string }

type LedgerSubject = Pick<Record_, "operationId" | "mode" | "repository" | "requestedAt"> & { briefDigest: string; untilMs?: number };
const keepEvidenceLine = (taskId: string) => (line: string) =>
  line.includes(taskId) || line.includes("plan.start") || line.includes("pr.opened");
const runLedgerReader = promisify(execFile);
// Resolved on use, not at load: a CommonJS bundle of this module shims import.meta.url but not import.meta.resolve.
const ledgerReaderLoader = (): string => import.meta.resolve("tsx");
const ledgerReaderEntry = fileURLToPath(import.meta.url);
const ledgerReaderArg = "--read-product-plan-evidence";

const legacyEvidenceSteps: readonly unknown[] = ["ratify.cli_started", "ratify.cli_exited", "ratify.handoff_failed", "plan.start", "pr.opened"];

/**
 * A legacy refusal's window ends at its saved refusal. A rotation's NAME cannot end the read: its stamp is taken after
 * its snapshot, so rows written between the two sit in the NEXT file. Only a file holding a row stamped after the window
 * proves it was cut after the window, so every row written by then is in it or an earlier file; the read stops there.
 */
async function readLegacyPlanLedgerRows(stateDir: string, subject: LedgerSubject, taskId: string, untilMs: number) {
  let ok = true;
  const markUnread = () => { ok = false; };
  const corpusSnapshot = listedLedgerFiles(stateDir, { readdirSync }, markUnread);
  if (!ok) return undefined;
  let cutAfterWindow = false;
  const rows = await readLedgerUnionRecords(stateDir, {
    // No step filter: a row of ANY step stamped after the window is what proves its file's cut.
    corpusSnapshot, sinceTs: subject.requestedAt,
    where: (row) => {
      const ts = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
      if (ts > untilMs) { cutAfterWindow = true; return false; }
      return Number.isFinite(ts) && legacyEvidenceSteps.includes(row.step) &&
        (row.task_id === taskId || row.step === "plan.start" || row.step === "pr.opened");
    },
    stopAfterRotation: () => cutAfterWindow,
    onUnreadArchive: markUnread, onUnreadLive: markUnread,
  });
  return { ok, archiveFiles: corpusSnapshot.rotations.map(({ path }) => path), rows };
}

/**
 * Subprocess entry. Rotation publishes an archive before replacing the live inode. Check both sides of that swap. After
 * the swap, rows written to the replaced inode reach the new live file only when the rotation drains it, under the
 * rotation lock: the new file can already hold the child's exit while the old one still holds its `pr.opened`. A view
 * taken while that lock is held is never an answer; the parent's deadline bounds the wait.
 */
async function readProductPlanLedgerEvidence(stateDir: string, subject: LedgerSubject): Promise<LedgerRead> {
  const livePath = ledgerLivePath(stateDir);
  const liveIdentity = () => {
    const stat = statSync(livePath, { bigint: true, throwIfNoEntry: false });
    return stat && `${stat.dev}:${stat.ino}`;
  };
  const rotationLock = `${livePath}${LEDGER_ROTATION_LOCK_SUFFIX}`;
  const rotating = () => lstatSync(rotationLock, { throwIfNoEntry: false }) !== undefined;
  const taskId = productPlanLedgerTaskId(subject.operationId);
  for (;;) {
    if (rotating()) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      continue;
    }
    const before = liveIdentity();
    const read = subject.untilMs === undefined
      ? await readLedgerUnionRawLinesAsync(stateDir, { sinceTs: subject.requestedAt, refuseIncomplete: true, keep: keepEvidenceLine(taskId) })
      : await readLegacyPlanLedgerRows(stateDir, subject, taskId, subject.untilMs);
    if (read === undefined || ("unread" in read && read.unread.includes(stateDir))) return "unread";
    const after = liveIdentity();
    const archives = ledgerRotationEntries(readdirSync(stateDir), stateDir);
    if (rotating() || before !== after || archives.length !== read.archiveFiles.length ||
      archives.some((entry, index) => entry.path !== read.archiveFiles[index])) continue;
    return read.ok ? correlateLedger(subject, taskId, "rows" in read ? read.rows : parseEvidenceLines(read.rawLines)) : "unread";
  }
}

function parseEvidenceLines(rawLines: readonly string[]): Array<Record<string, unknown>> {
  return rawLines.flatMap((line): Array<Record<string, unknown>> => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch (error) { void error; return []; /* a torn line is no evidence */ }
  });
}

/**
 * What the core ledger shows for THIS operation: the gateway's `ratify.cli_started` row (bound by the operation id it
 * carries), the native `plan.start` whose complete brief and mode match the frozen command, and that run's own `pr.opened`.
 * The maintained tsx launcher can have a different PID from its inner native runtime. Its PID remains a liveness hint,
 * never the correlation key. Ambiguous native runs or a pull request outside the target are never this proposal.
 */
function correlateLedger(record: LedgerSubject, taskId: string, parsed: readonly Record<string, unknown>[]): LedgerEvidence {
  const at = (row: Record<string, unknown>) => (typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN);
  // Only rows inside the operation's window: from its request, and for a legacy refusal up to that refusal.
  const from = Date.parse(record.requestedAt);
  const until = record.untilMs ?? Number.POSITIVE_INFINITY;
  const rows = parsed.filter((row) => at(row) >= from && at(row) <= until).sort((a, b) => at(a) - at(b));
  const mine = rows.filter((row) => row.task_id === taskId);
  const started = mine.find((row) => row.step === "ratify.cli_started" && typeof row.pid === "number");
  const pid = started?.pid as number | undefined;
  const exited = mine.some((row) => row.step === "ratify.cli_exited");
  const failed = mine.some((row) => row.step === "ratify.handoff_failed");
  const candidates = started === undefined ? [] : rows.filter((row) => row.step === "plan.start" && row.lane === "plan" &&
    row.task_id === `PLAN-${record.mode}` && row.mode === record.mode && typeof row.run_id === "string" &&
    typeof row.brief === "string" && digest(row.brief) === record.briefDigest && at(row) >= Date.parse(record.requestedAt));
  const runs = new Map(candidates.map((row) => [row.run_id, row]));
  // Native starts can share a timestamp-based run id; conflicting identities are ambiguous.
  const conflictingStart = rows.some((row) => row.step === "plan.start" && typeof row.run_id === "string" && runs.has(row.run_id) &&
    (row.lane !== "plan" || row.task_id !== `PLAN-${record.mode}` || row.mode !== record.mode ||
      typeof row.brief !== "string" || digest(row.brief) !== record.briefDigest));
  if (conflictingStart) return { exited: false, failed: true };
  const run = runs.size === 1 ? [...runs.values()][0] : undefined;
  const pull = run === undefined ? undefined : rows.find((row) => row.step === "pr.opened" && row.run_id === run.run_id && typeof row.pr_url === "string");
  const url = pull?.pr_url as string | undefined;
  const own = url !== undefined && url.startsWith(`https://github.com/${record.repository.owner}/${record.repository.name}/pull/`) && /^\d+$/.test(url.slice(url.lastIndexOf("/") + 1));
  return { pid, exited: exited && runs.size < 2, failed: failed || runs.size > 1, opened: own ? url : undefined };
}

// Service instances share one actor journal. Order in-process writers before taking the real cross-process lock.
const journalChains = new Map<string, Promise<unknown>>();
async function serializedJournal<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = journalChains.get(path) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => undefined /* the caller awaits next and receives its failure */);
  journalChains.set(path, tail);
  try { return await next; }
  finally { if (journalChains.get(path) === tail) journalChains.delete(path); }
}

class Fault extends RmdError {
  constructor(readonly code: ProductPlanOperationCode) { super("usage", GENERIC_EXIT_CODE, `product plan operation: ${code}`); }
}

/** Verify the default checkout before freezing a new command; replay never resolves or retargets it. */
export async function verifyProductPlanCheckout(checkout: string, repository: PlanRepository, targetHead: string): Promise<string> {
  try {
    const read = (args: string[]) => hostWorktreeGitAsync(checkout, args, { timeout: 20_000, maxBuffer: 64 * 1024 });
    const identity = parseOwnerRepoFromRemoteUrl(await read(["config", "--get", "remote.origin.url"]));
    if (!identity) throw new Fault("target_unreadable");
    if (identity.owner.toLowerCase() !== repository.owner.toLowerCase() || identity.repo.toLowerCase() !== repository.name.toLowerCase())
      throw new Fault("repository_conflict");
    if (realpathSync((await read(["rev-parse", "--show-toplevel"])).trim()) !== realpathSync(checkout)) throw new Fault("target_unreadable");
    if ((await read(["rev-parse", "HEAD"])).trim() !== targetHead) throw new Fault("task_stale");
    return checkout;
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw Object.assign(new Fault("target_unreadable"), { cause: error });
  }
}
const runnerConfigRefusal = {
  absent: "runner_config_missing", invalid: "runner_config_invalid", unreadable: "target_unreadable",
} as const satisfies Record<Exclude<TargetRunnerConfig["state"], "present">, ProductPlanOperationCode>;
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
 * later requests read the same record and its correlated evidence, which the journal keeps once final.
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
      // An unbound product cannot have a plan operation: refuse before creating its journal lock directory.
      // The locked path reads the product again, so this early read never replaces the live mutation checks.
      if (!this.readProduct(actor, parsed.data.productId).repository) throw new Fault("repository_missing");
      return { ok: true, value: await this.mutate(this.paths(actor), () => this.propose(actor, parsed.data)) };
    } catch (error) {
      return { ok: false, code: error instanceof Fault ? error.code : error instanceof InflightLockError ? "busy" : "unavailable" };
    }
  }

  private mutate<T>(paths: Paths, work: () => Promise<T>): Promise<T> {
    return serializedJournal(paths.state, async () => {
      this.ensureDirectory(paths);
      const handle = acquireInflightLock(join(paths.directory, "locks"), paths.ownerKey, { run_id: `product-plan-${randomUUID()}` });
      try { return await work(); }
      finally { handle.release(); }
    });
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
    let selectedEvidence: LedgerRead | undefined;
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
      // A refused operation is resolved: once the target head moves, a fresh request plans again at the new head.
      let reusable = journal.operations[operationId];
      for (const entry of reusable ? [] : sameBrief) {
        const seen = await this.readEvidence(paths, journal, entry);
        const state = this.observeWith(entry, product, head, seen).state;
        if (state === "stale-target" ? this.observeWith(entry, product, undefined, seen).state !== "refused" : state === "pending" || state === "unknown") {
          reusable = entry;
          selectedEvidence = seen;
          break;
        }
      }
      if (reusable) {
        record = reusable;
        replayed = true;
        journal = this.bind(paths, journal, requestKey, { operationId: reusable.operationId, payloadDigest });
      } else {
        if (Object.keys(journal.operations).length >= PRODUCT_PLAN_OPERATION_LIMITS.operations) throw new Fault("capacity");
        const checkout = await this.options.checkout(subject, head);
        if (checkout === undefined || !isAbsolute(checkout)) throw new Fault("target_unreadable");
        // A target with no valid runner configuration can only fail its native plan: refuse before anything is frozen.
        const config = this.options.runnerConfig === undefined ? await readTargetRunnerConfig(checkout, head)
          : await this.options.runnerConfig(checkout, head);
        if (config.state !== "present") throw new Fault(runnerConfigRefusal[config.state]);
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
    const seen = selectedEvidence ?? await this.readEvidence(paths, journal, record);
    const observation = this.observeWith(record, product, head, seen);
    product = this.settle(actor, product, observation);
    return { observation: this.observeWith(record, product, head, seen), replayed };
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
    let accepted: boolean | undefined;
    const finished = (outcome: PlanHandoffOutcome) => this.enqueue(async () => {
      // Completion is known in memory even if another writer prevents persisting its outcome.
      // With no durable result or ledger row, observeWith() must report unknown instead of pending.
      this.flying.delete(record.operationId);
      await this.mutate(paths, async () => {
        const journal = this.readJournal(paths);
        const stored = journal.operations[record.operationId];
        if (!stored) return;
        // The gateway reports a nonzero child exit as refused too. Keep it eligible for proposal recovery.
        const handoff = { outcome: outcome === "refused" && accepted ? "exited" as const : outcome, at: this.clock.iso(),
          ...(outcome === "refused" && accepted === false ? { beforeLaunch: true as const } : {}) };
        this.commit(paths, { ...journal, operations: { ...journal.operations, [record.operationId]: { ...stored, handoff } } });
      });
    }).catch((error: unknown) => { void error; /* the journal keeps its last durable state; the ledger rows still say what ran */ });
    let started: Promise<{ outcome: PlanHandoffOutcome }>;
    try { started = gateway.productPlan!({ operationId: record.operationId, mode: record.mode, brief, repoRoot: record.command.repoRoot }); }
    catch (error) {
      // A gateway that throws before returning a promise has handed nothing off; the outcome is recorded unknown, never retried.
      void error; started = Promise.resolve({ outcome: "unknown" as const });
    }
    accepted = gateway.inFlight?.(productPlanLedgerTaskId(record.operationId));
    void started.then((result) => finished(result.outcome), () => finished("unknown"));
  }

  private inFlight(operationId: string): boolean {
    return this.flying.has(operationId) || this.options.gateway?.inFlight?.(productPlanLedgerTaskId(operationId)) === true;
  }

  /** The observation for evidence already read; every caller reads the ledger once, off the request loop. */
  private observeWith(record: Record_, product: StoredProduct, liveHead: string | undefined, seen: LedgerRead): ProductPlanObservation {
    let state: ProductPlanState = "unknown";
    const proposal = seen === "unread" ? undefined : seen.opened;
    if (seen !== "unread") {
      if (proposal !== undefined) state = "proposed";
      else if (seen.exited) state = "refused";
      else if (seen.failed) state = "unknown";
      else if (seen.settled) state = "refused";
      else if (seen.pid !== undefined) state = (this.options.isAlive ?? processAlive)(seen.pid) ? "pending" : "unknown";
      else if (this.inFlight(record.operationId)) state = "pending";
      else if (record.handoff?.outcome === "refused") state = "refused";
      // A late proposal is historical evidence for its frozen brief, never for a newer objective.
      if (product.objectiveRevision !== record.objectiveRevision || digest(productCasePlanText(product.brief)) !== record.briefDigest) state = "changed-brief";
      // An opened plan can itself advance the target when merged; do not relabel that normal completion as stale.
      else if (state !== "proposed" && liveHead !== undefined && liveHead !== record.targetHead) state = "stale-target";
    }
    return { operationId: record.operationId, state, mode: record.mode, planEvidenceId: record.planEvidenceId, repository: record.repository,
      targetHead: record.targetHead, revision: record.revision, objectiveRevision: record.objectiveRevision, briefDigest: record.briefDigest,
      requestedAt: record.requestedAt, ...(proposal !== undefined ? { proposal } : {}) };
  }

  /**
   * Final evidence is read once and kept beside the journal, never read again. The bound covers the WHOLE lookup, from
   * its first filesystem call: the kept file is opened asynchronously under the same timer as the ledger read, and an
   * answer that arrives past the deadline is "unread" whatever it holds. Evidence is answered as final only once it is
   * durably kept: a failed write refuses the request instead of answering from memory a restart would not have.
   */
  private async readEvidence(paths: Paths, journal: Journal, record: Record_): Promise<LedgerRead> {
    const bound = this.options.ledgerReadBoundMs ?? PRODUCT_PLAN_LEDGER_READ_BOUND_MS;
    const deadline = performance.now() + bound;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"unread">((resolve) => { timer = setTimeout(() => resolve("unread"), bound); });
    try {
      const kept = await Promise.race([this.readKept(paths), expired]);
      if (kept === "unread" || performance.now() >= deadline) return "unread";
      const known = kept?.evidence[record.operationId];
      if (known) return known;
      const seen = await this.ledger(record, expired, deadline);
      if (seen === "unread") return seen;
      const { opened, exited, failed } = seen;
      const final = opened !== undefined || exited || failed ? { exited, failed, ...(opened !== undefined ? { opened } : {}) }
        : this.legacyRefusal(record) ? { exited: false, failed: false, settled: true as const } : undefined;
      if (final === undefined) return seen;
      this.keep(paths, journal, kept, record.operationId, final);
      return final;
    } catch (error) {
      // A failure that lands past the deadline, even before the timer's callback has run, is past the bound: unknown.
      if (performance.now() >= deadline) return "unread";
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private legacyRefusal(record: Record_): boolean {
    return record.handoff?.outcome === "refused" && record.handoff.beforeLaunch !== true && !this.inFlight(record.operationId);
  }

  /** The kept final evidence, read without blocking serve's loop; undefined only when no file exists yet. */
  private async readKept(paths: Paths): Promise<Kept | undefined> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(paths.kept, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errno(error, "ENOENT")) return undefined;
      // An unreadable kept file is never "nothing kept": reading the ledger again, then rewriting it, would drop it.
      throw Object.assign(new Fault("unavailable"), { cause: error });
    }
    try {
      const info = await handle.stat();
      const limit = PRODUCT_PLAN_OPERATION_LIMITS.evidenceBytes;
      if (!info.isFile() || info.nlink > 1 || (info.mode & 0o077) !== 0 || info.size > limit) throw new Fault("unavailable");
      const buffer = Buffer.alloc(info.size);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size !== info.size) throw new Fault("corrupt");
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
      catch (error) { void error; throw new Fault("corrupt"); }
      const parsed = keptSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerKey !== paths.ownerKey) throw new Fault("corrupt");
      return parsed.data;
    } finally {
      await handle.close();
    }
  }

  /** Durably keeps one operation's final evidence; a failure propagates, so nothing is answered as kept that is not. */
  private keep(paths: Paths, journal: Journal, kept: Kept | undefined, operationId: string, final: LedgerEvidence): void {
    // Only operations the journal still holds, so the file stays within operations x one entry.
    const evidence = Object.fromEntries(Object.entries({ ...kept?.evidence, [operationId]: final }).filter(([id]) => journal.operations[id] !== undefined));
    this.writePrivate(paths, paths.kept, JSON.stringify({ version: PRODUCT_PLAN_OPERATION_VERSION, ownerKey: paths.ownerKey, evidence }),
      PRODUCT_PLAN_OPERATION_LIMITS.evidenceBytes);
  }

  private async ledger(record: Record_, expired: Promise<"unread">, deadline: number): Promise<LedgerRead> {
    const none = { exited: false, failed: false };
    const ledgerPath = this.options.ledgerPath;
    const refused = record.handoff?.outcome === "refused" && !this.inFlight(record.operationId);
    if (ledgerPath === undefined || (refused && record.handoff?.beforeLaunch === true)) return none;
    // A legacy refusal can be a nonzero exit after a proposal opened. The gateway saves the refusal only after the child
    // exited and its exit row was written, so its window ends exactly at the saved refusal.
    const untilMs = refused ? Date.parse(record.handoff!.at) : undefined;
    const taskId = productPlanLedgerTaskId(record.operationId);
    const controller = new AbortController();
    try {
      const { operationId, mode, repository, requestedAt } = record;
      const subject: LedgerSubject = { operationId, mode, repository, requestedAt, briefDigest: record.command.briefDigest,
        ...(untilMs !== undefined ? { untilMs } : {}) };
      const stateDir = dirname(ledgerPath);
      const seen = await Promise.race([
        expired,
        this.options.readLedgerLines
          ? this.options.readLedgerLines(stateDir, { sinceTs: requestedAt, ...(untilMs !== undefined ? { untilMs } : {}), refuseIncomplete: true,
            keep: keepEvidenceLine(taskId) })
            .then((read): LedgerRead => read.ok && performance.now() < deadline ? correlateLedger(subject, taskId, parseEvidenceLines(read.rawLines)) : "unread")
          // Directory enumeration and correlation run outside serve. The deadline need not wait for the child to exit.
          : runLedgerReader(process.execPath, ["--import", ledgerReaderLoader(), ledgerReaderEntry, ledgerReaderArg, stateDir, JSON.stringify(subject)],
            { signal: controller.signal, killSignal: "SIGKILL" })
            .then(({ stdout }): LedgerRead => JSON.parse(stdout) as LedgerRead),
      ]);
      return performance.now() >= deadline ? "unread" : seen;
    } catch (error) {
      if (performance.now() >= deadline) return "unread";
      throw error;
    } finally {
      controller.abort();
    }
  }

  /** Terminal fates become the product's own supported stage evidence, once each. */
  private settle(actor: string, product: StoredProduct, observation: ProductPlanObservation): StoredProduct {
    if (product.objectiveRevision !== observation.objectiveRevision || digest(productCasePlanText(product.brief)) !== observation.briefDigest) return product;
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
    return { directory, state: join(directory, `${ownerKey}.json`), kept: join(directory, `${ownerKey}.evidence.json`), ownerKey };
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
    const raw = this.readPrivate(paths.state, PRODUCT_PLAN_OPERATION_LIMITS.stateBytes);
    if (raw === undefined) return { version: PRODUCT_PLAN_OPERATION_VERSION, ownerKey: paths.ownerKey, operations: {}, requests: {} };
    const parsed = journalSchema.safeParse(raw);
    if (!parsed.success || parsed.data.ownerKey !== paths.ownerKey) throw new Fault("corrupt");
    return parsed.data;
  }

  /** One private (owner-only, single-link, bounded) JSON file; undefined when it does not exist. */
  private readPrivate(file: string, limit: number): unknown {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1 || (info.mode & 0o077) !== 0 || info.size > limit) throw new Fault("unavailable");
      const buffer = Buffer.alloc(info.size);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size !== info.size) throw new Fault("corrupt");
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) as unknown; }
      catch (error) { void error; throw new Fault("corrupt"); }
    } catch (error) {
      if (errno(error, "ENOENT")) return undefined;
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** Atomic replace. A failure before the rename is `unavailable`; after it the outcome is unknowable. */
  private commit(paths: Paths, journal: Journal): void {
    this.writePrivate(paths, paths.state, JSON.stringify(journal), PRODUCT_PLAN_OPERATION_LIMITS.stateBytes);
  }

  private writePrivate(paths: Paths, file: string, body: string, limit: number): void {
    if (Buffer.byteLength(body) > limit) throw new Fault("capacity");
    this.ensureDirectory(paths);
    const temporary = join(paths.directory, `.${paths.ownerKey}.${randomUUID()}.pending`);
    let renamed = false;
    try {
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); writeFileSync(fd, body, "utf8"); this.sync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, file);
      renamed = true;
      this.syncDirectory(paths.directory);
    } catch (error) {
      void error;
      if (!renamed && existsSync(temporary)) { try { unlinkSync(temporary); } catch (cleanup) { void cleanup; /* a stage that cannot be removed is reaped with the directory */ } }
      throw new Fault(renamed ? "outcome_unknown" : "unavailable");
    }
  }
}

if (import.meta.main && process.argv[2] === ledgerReaderArg) {
  void readProductPlanLedgerEvidence(process.argv[3]!, JSON.parse(process.argv[4]!) as LedgerSubject).then(
    (evidence) => process.stdout.write(JSON.stringify(evidence)),
    (error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; },
  );
}
