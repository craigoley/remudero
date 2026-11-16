/**
 * W1-T12114 — the effect half of a stale fix-dispatch recovery: `rmd pr-owner-recover`.
 *
 * W1-T12113 DECIDES (`decideStaleFixDispatchRecovery`); this module gathers the evidence, takes the
 * PR's fix branch claim, preserves any local work create-only, and records the outcome. `--authorize`
 * appends one `pr_owner.recovery_authorized` row for an exact (repo, PR, task, run, round, head, base,
 * branch) tuple, written only by a repository admin. `--apply` releases ownership only when two live
 * reads, taken before and after preservation and both under the claim, decide `recover`.
 *
 * It never deletes or moves a ref, never removes a worktree, never pushes to the PR branch, and never
 * writes fix.done, a credit, or a plan or source file. Every I/O goes through {@link RecoveryPorts}.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIsPidAlive } from "./drain-lock.js";
import { defaultGetProcessStartTime, reclaimStaleLock } from "./fs-race-safe.js";
import { sameHost } from "./host-identity.js";
import { acquireInflightLock, inflightLockPath } from "./inflight-lock.js";
import { isFleetAutomationActor } from "./operator-interventions.js";
import { publishRecoveryRefs, RECOVERY_REF_NAMESPACE, type RecoveryGitAnswer } from "./recovery-refs.js";
import {
  decideStaleFixDispatchRecovery,
  STALE_FIX_DISPATCH_RECEIPT_STEP,
  staleFixDispatchRecoveryId,
  staleFixDispatchRecoveryReceipt,
  type StaleFixDispatchExpected,
  type StaleFixDispatchFacts,
  type StaleFixDispatchIdentity,
  type StaleFixDispatchProcess,
  type StaleFixDispatchReceipt,
  type StaleFixDispatchReclaimedPrior,
} from "./stale-fix-dispatch-recovery.js";

export const PR_OWNER_RECOVERY_AUTHORIZED_STEP = "pr_owner.recovery_authorized";
export const PR_OWNER_RECOVERY_RECEIPT_STEP = STALE_FIX_DISPATCH_RECEIPT_STEP;

type Row = Record<string, unknown>;

export interface RecoveryTuple {
  repo: string;
  prNumber: number;
  taskId: string;
  runId: string;
  roundId: string;
  headSha: string;
  baseSha: string;
  branch: string;
}

export interface LivePr {
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  branch: string;
}

export interface RecoveryLedgerRead {
  ok: boolean;
  unread: string[];
  rows: Row[];
}

export interface LockHolder {
  pid: number;
  run_id: string;
  host: string;
  startedAt: string;
}

export type RecoveryGit = (args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<RecoveryGitAnswer>;

export interface RecoveryPorts {
  stateDir: string;
  inflightDir: string;
  repoDir: string;
  readLedger(): Promise<RecoveryLedgerRead>;
  appendLedger(step: string, row: Row): void;
  readPr(repo: string, prNumber: number): Promise<LivePr>;
  /** The authenticated GitHub login (`gh api user`); a throw is an unreadable identity. */
  currentLogin(): Promise<string>;
  /** `repos/{repo}/collaborators/{login}/permission`'s `permission`; a throw is unreadable. */
  permission(repo: string, login: string): Promise<string>;
  /** The ledger actor of this process; a fleet-automation actor may never authorize or apply. */
  processActor(): string;
  probeProcess(holder: LockHolder): StaleFixDispatchProcess["state"];
  descendants(pid: number): StaleFixDispatchFacts["descendants"];
  cwdCensus(path: string): StaleFixDispatchFacts["cwdCensus"];
  git: RecoveryGit;
  nowIso(): string;
  nonce(): string;
  hostname(): string;
  pid: number;
  /** TEST seam: runs between the first read and preservation. */
  afterFirstRead?(): void | Promise<void>;
  /** TEST seam: runs after preservation, before the second read. */
  beforeSecondRead?(): void | Promise<void>;
  /** TEST seam: runs once the claim is held, before the under-claim history read. */
  underClaim?(): void | Promise<void>;
}

export type RecoveryResult =
  | { outcome: "authorized"; authorizationId: string; row: Row }
  | { outcome: "released"; receipt: Row; existing?: true; replayed?: true }
  | { outcome: "held"; reason: string; durable: boolean; receipt?: Row }
  | { outcome: "refused"; reason: string }
  | { outcome: "unknown"; reason: string };

const FULL_SHA = /^[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{16,64}$/;
const LEDGER_ADDED_KEYS = new Set(["host", "actor_pid", "gardener_origin", "actor"]);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function safeIntFrom(text: string): number | undefined {
  const n = Number(text);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(n) ? n : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

function prOf(row: Row): number | undefined {
  if (typeof row.pr_number === "number" && Number.isSafeInteger(row.pr_number) && row.pr_number > 0) return row.pr_number;
  const m = typeof row.pr_url === "string" ? /\/pull\/(\d+)(?:[/?#].*)?$/.exec(row.pr_url) : null;
  return m ? Number(m[1]) : undefined;
}

function tsMs(row: Row): number {
  return typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
}

export function recoveryTupleHash(t: RecoveryTuple): string {
  return sha256([t.repo, t.prNumber, t.taskId, t.runId, t.roundId, t.headSha, t.baseSha, t.branch]);
}

export function recoveryAuthorizationId(t: RecoveryTuple, login: string, ts: string): string {
  return sha256([t.repo, t.prNumber, t.taskId, t.runId, t.roundId, t.headSha, t.baseSha, t.branch, login, ts]);
}

function identityOf(t: RecoveryTuple, authorizationId: string): StaleFixDispatchIdentity {
  return {
    repo: t.repo, prNumber: t.prNumber, taskId: t.taskId, dispatchRunId: t.runId, dispatchRoundId: t.roundId,
    headSha: t.headSha, baseSha: t.baseSha, branch: t.branch, authorizationId,
  };
}

/** Owner and name of `owner/name`, or undefined for any other shape. */
export function splitRepo(repo: string): [string, string] | undefined {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  return m ? [m[1]!, m[2]!] : undefined;
}

/** The lock key `fixBranchClaimKey` (src/run-task.ts) derives; injected so this module stays a leaf. */
export type ClaimKeyOf = (owner: string, repo: string, branch: string) => string;

function sameDispatch(row: Row, t: RecoveryTuple, run = "prior_run_id", round = "prior_round_id"): boolean {
  return row.repo === t.repo && row.pr_number === t.prNumber && row.task_id === t.taskId && row[run] === t.runId && row[round] === t.roundId;
}

function newestDispatch(rows: readonly Row[], prNumber: number): Row | undefined {
  let newest: Row | undefined;
  for (const row of rows) {
    if (row.step !== "fix.dispatch" || prOf(row) !== prNumber) continue;
    if (newest === undefined || !(tsMs(row) < tsMs(newest))) newest = row;
  }
  return newest;
}

// ── authorization rows ───────────────────────────────────────────────────────────────────────

interface AuthorizationRow {
  authorizationId: string;
  tuple: RecoveryTuple;
  login: string;
  reason: string;
  ts: string;
  priorClaim?: StaleFixDispatchReclaimedPrior;
}

function tupleFromAuthRow(row: Row): RecoveryTuple | undefined {
  const t = {
    repo: row.repo, prNumber: row.pr_number, taskId: row.task_id, runId: row.dispatch_run_id, roundId: row.dispatch_round_id,
    headSha: row.head_sha, baseSha: row.base_sha, branch: row.branch,
  };
  const strings = [t.repo, t.taskId, t.runId, t.roundId, t.branch].every(nonEmpty);
  const shas = typeof t.headSha === "string" && FULL_SHA.test(t.headSha) && typeof t.baseSha === "string" && FULL_SHA.test(t.baseSha);
  const pr = typeof t.prNumber === "number" && Number.isSafeInteger(t.prNumber) && t.prNumber > 0;
  return strings && shas && pr ? (t as RecoveryTuple) : undefined;
}

/** A row is an authorization only when its id recomputes from its own tuple, login and ts. */
function parseAuthRow(row: Row): AuthorizationRow | undefined {
  const tuple = tupleFromAuthRow(row);
  if (!tuple || !nonEmpty(row.login) || !nonEmpty(row.ts) || !nonEmpty(row.reason)) return undefined;
  if (row.authorization_id !== recoveryAuthorizationId(tuple, row.login, row.ts)) return undefined;
  const prior = row.prior_claim as StaleFixDispatchReclaimedPrior | undefined;
  return {
    authorizationId: row.authorization_id, tuple, login: row.login, reason: row.reason, ts: row.ts,
    ...(prior !== undefined && typeof prior === "object" ? { priorClaim: prior } : {}),
  };
}

// ── receipt history ──────────────────────────────────────────────────────────────────────────

function receiptIdentity(row: Row): StaleFixDispatchIdentity {
  return {
    repo: String(row.repo), prNumber: Number(row.pr_number), taskId: String(row.task_id), dispatchRunId: String(row.prior_run_id),
    dispatchRoundId: String(row.prior_round_id), headSha: String(row.head_sha), baseSha: String(row.base_sha),
    branch: String(row.branch), ...(typeof row.authorization_id === "string" ? { authorizationId: row.authorization_id } : {}),
  };
}

function receiptBody(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !LEDGER_ADDED_KEYS.has(key)));
}

type ReleaseHistory = { kind: "none" } | { kind: "one"; receipt: Row } | { kind: "conflict" };

/** Released receipts for this exact dispatch, regardless of authorization. More than one distinct
 *  body, or a body whose recovery_id does not recompute, is a conflict. */
function releaseHistory(rows: readonly Row[], t: RecoveryTuple): ReleaseHistory {
  const released = rows.filter((row) => row.step === PR_OWNER_RECOVERY_RECEIPT_STEP && row.outcome === "released" && sameDispatch(row, t));
  if (released.length === 0) return { kind: "none" };
  const bodies = new Set(released.map((row) => JSON.stringify(receiptBody(row))));
  const valid = released.every((row) => row.recovery_id === staleFixDispatchRecoveryId(receiptIdentity(row)));
  return bodies.size === 1 && valid ? { kind: "one", receipt: released[released.length - 1]! } : { kind: "conflict" };
}

function heldFor(rows: readonly Row[], t: RecoveryTuple): Row[] {
  return rows.filter((row) => row.step === PR_OWNER_RECOVERY_RECEIPT_STEP && row.outcome === "held" && sameDispatch(row, t));
}

// ── the prior dispatch lock ──────────────────────────────────────────────────────────────────

const ROUND_START = (runId: string) => new RegExp(`^${escapeRegExp(runId)}:(?:merge-refused:)?(\\d+):(\\d+)$`);

/**
 * The prior dispatch's fix branch claim, proven to belong to exactly this dispatch round: its
 * stored run_id is the production `${runId}:fix-claim:${pr}:${claimMs}` shape (round-tripped
 * through `fixRoundClaimId`, injected), `claimMs <= startedAt <= roundStartedAtMs`, no other round
 * of this run started in that window, and it is later than every completed claim of this run and PR.
 */
export function parsePriorDispatchClaim(
  stored: { run_id: string; startedAt: string },
  t: RecoveryTuple,
  rows: readonly Row[],
  fixRoundClaimId: (runId: string, prNumber: number, nowMs: number) => string,
): { ok: true; claimMs: number; roundStartedAtMs: number } | { ok: false; reason: string } {
  const claimRe = new RegExp(`^${escapeRegExp(t.runId)}:fix-claim:${t.prNumber}:(\\d+)$`);
  const claim = claimRe.exec(stored.run_id);
  const claimMs = claim ? safeIntFrom(claim[1]!) : undefined;
  if (claimMs === undefined || fixRoundClaimId(t.runId, t.prNumber, claimMs) !== stored.run_id) {
    return { ok: false, reason: "stale_claim_identity_mismatch" };
  }
  const startedMs = Date.parse(stored.startedAt);
  if (!Number.isFinite(startedMs) || startedMs < 0) return { ok: false, reason: "stale_claim_started_at_invalid" };
  const round = new RegExp(`^${escapeRegExp(t.runId)}:(\\d+):(\\d+)$`).exec(t.roundId);
  const roundStartedAtMs = round ? safeIntFrom(round[2]!) : undefined;
  if (roundStartedAtMs === undefined) return { ok: false, reason: "round_id_unparseable" };
  if (!(claimMs <= startedMs && startedMs <= roundStartedAtMs)) return { ok: false, reason: "stale_claim_outside_round" };
  const runRows = rows.filter((row) => row.run_id === t.runId && prOf(row) === t.prNumber);
  const dispatches = runRows.filter((row) => row.step === "fix.dispatch");
  if (dispatches.filter((row) => row.round_id === t.roundId).length !== 1) return { ok: false, reason: "round_history_ambiguous" };
  const startRe = ROUND_START(t.runId);
  for (const row of dispatches) {
    if (row.round_id === t.roundId) continue;
    const other = typeof row.round_id === "string" ? startRe.exec(row.round_id) : null;
    const otherStart = other ? safeIntFrom(other[2]!) : undefined;
    if (otherStart === undefined) return { ok: false, reason: "round_history_ambiguous" };
    if (claimMs <= otherStart && otherStart <= roundStartedAtMs) return { ok: false, reason: "stale_claim_names_another_round" };
  }
  const completed: number[] = [];
  for (const row of runRows) {
    if (row.step !== "fix.done" || typeof row.branch_claim_run_id !== "string") continue;
    if (row.branch_claim_run_id === stored.run_id) return { ok: false, reason: "stale_claim_round_completed" };
    const done = claimRe.exec(row.branch_claim_run_id);
    const doneMs = done ? safeIntFrom(done[1]!) : undefined;
    if (doneMs === undefined) return { ok: false, reason: "round_history_ambiguous" };
    completed.push(doneMs);
  }
  if (new Set(completed).size !== completed.length) return { ok: false, reason: "round_history_ambiguous" };
  if (completed.some((ms) => ms >= claimMs)) return { ok: false, reason: "stale_claim_not_after_completed_round" };
  return { ok: true, claimMs, roundStartedAtMs };
}

export function parseLockHolder(raw: string): LockHolder | undefined {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    return void messageOf(error); // malformed bytes are not a holder; the caller holds on undefined
  }
  const pid = o?.pid;
  const ok = typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && nonEmpty(o.run_id) && nonEmpty(o.host) && nonEmpty(o.startedAt);
  return ok ? { pid, run_id: o.run_id as string, host: o.host as string, startedAt: o.startedAt as string } : undefined;
}

// ── evidence ─────────────────────────────────────────────────────────────────────────────────

type WorktreeLookup = { state: "found"; path: string } | { state: "none" } | { state: "unknown"; reason: string };

async function registeredWorktree(ports: RecoveryPorts, branch: string): Promise<WorktreeLookup> {
  const res = await ports.git(["worktree", "list", "--porcelain"], { cwd: ports.repoDir });
  if (res.status !== 0) return { state: "unknown", reason: `git worktree list failed: ${res.stderr.trim()}` };
  for (const block of res.stdout.split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path !== undefined && block.split("\n").includes(`branch refs/heads/${branch}`)) return { state: "found", path };
  }
  return { state: "none" };
}

async function cwdOf(ports: RecoveryPorts, branch: string): Promise<StaleFixDispatchFacts["cwdCensus"]> {
  const wt = await registeredWorktree(ports, branch);
  if (wt.state === "unknown") return { state: "unknown" };
  return wt.state === "none" ? { state: "clear" } : ports.cwdCensus(wt.path);
}

async function dispatchClaimOf(ports: RecoveryPorts, taskId: string): Promise<StaleFixDispatchFacts["dispatchClaim"]> {
  const res = await ports.git(["ls-remote", "origin", `refs/rmd-dispatch/${taskId}`], { cwd: ports.repoDir });
  if (res.status !== 0) return { state: "unknown" };
  const holder = res.stdout.trim();
  return holder === "" ? { state: "clear" } : { state: "held", holder: holder.split(/\s+/)[0]! };
}

function processOf(ports: RecoveryPorts, holder: LockHolder | undefined): StaleFixDispatchProcess {
  if (holder === undefined) return { state: "unrecorded" };
  return { state: ports.probeProcess(holder), pid: holder.pid, host: holder.host, startedAt: holder.startedAt };
}

// ── the fix branch claim ─────────────────────────────────────────────────────────────────────

interface ClaimContext {
  tuple: RecoveryTuple;
  rows: readonly Row[];
  tupleHash: string;
  recoveryId?: string;
  fixRoundClaimId: (runId: string, prNumber: number, nowMs: number) => string;
}

interface HeldClaim {
  path: string;
  storedRunId: string;
  prior?: { holder: LockHolder; reclaimed: StaleFixDispatchReclaimedPrior };
  release(): void;
}

function ownedNonce(runId: string, prefix: string): boolean {
  return runId.startsWith(prefix) && NONCE.test(runId.slice(prefix.length));
}

async function judgeHolder(
  ports: RecoveryPorts,
  holder: LockHolder,
  ctx: ClaimContext,
): Promise<{ ok: true; prior?: number } | { ok: false; reason: string }> {
  if (!sameHost(holder.host, ports.hostname())) return { ok: false, reason: "stale_claim_foreign_host" };
  let priorMs: number | undefined;
  if (holder.run_id.startsWith(`${ctx.tuple.runId}:fix-claim:`)) {
    const parsed = parsePriorDispatchClaim(holder, ctx.tuple, ctx.rows, ctx.fixRoundClaimId);
    if (!parsed.ok) return parsed;
    priorMs = parsed.claimMs;
  } else if (
    !(ctx.recoveryId !== undefined && ownedNonce(holder.run_id, `PR-OWNER-RECOVER:${ctx.recoveryId}:`)) &&
    !ownedNonce(holder.run_id, `PR-OWNER-AUTH:${ctx.tupleHash}:`)
  ) {
    return { ok: false, reason: "competing_branch_claim_held" };
  }
  const state = ports.probeProcess(holder);
  // A live holder of this recovery's or authorization's own claim is a concurrent invocation.
  if (state !== "dead") return { ok: false, reason: priorMs === undefined ? "competing_branch_claim_held" : `process_${state}` };
  if (priorMs === undefined) return { ok: true };
  const descendants = ports.descendants(holder.pid);
  if (descendants.state !== "none") return { ok: false, reason: `descendants_${descendants.state}` };
  const cwd = await cwdOf(ports, ctx.tuple.branch);
  if (cwd.state !== "clear") return { ok: false, reason: `cwd_${cwd.state}` };
  return { ok: true, prior: priorMs };
}

/** Take the claim O_EXCL. An occupied claim is reclaimed only for a proven-dead holder this
 *  invocation may replace, by compare-and-reclaim on its inode and raw bytes; anything else holds. */
async function acquireClaim(ports: RecoveryPorts, key: string, runId: string, ctx: ClaimContext): Promise<HeldClaim | { reason: string }> {
  const info = { pid: ports.pid, host: ports.hostname(), startedAt: ports.nowIso() };
  const path = inflightLockPath(ports.inflightDir, key);
  const create = (): boolean => {
    try {
      acquireInflightLock(ports.inflightDir, key, { reclaim: false, run_id: runId, info });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };
  let prior: HeldClaim["prior"];
  if (!create()) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      return { reason: `branch_claim_unreadable: ${messageOf(error)}` };
    }
    const holder = parseLockHolder(raw);
    if (holder === undefined) return { reason: "branch_claim_malformed" };
    const judged = await judgeHolder(ports, holder, ctx);
    if (!judged.ok) return { reason: judged.reason };
    const reclaim = reclaimStaleLock(path, {
      parseHolder: (bytes) => ({ same: bytes === raw }),
      isStale: (seen) => seen.same,
      onReclaim: () => undefined,
      onLostReclaim: () => undefined,
    });
    if (reclaim.outcome !== "reclaimed") return { reason: reclaim.outcome === "live" ? "branch_claim_changed" : "branch_claim_lost" };
    if (!create()) return { reason: "competing_branch_claim_held" };
    if (judged.prior !== undefined) {
      prior = {
        holder,
        reclaimed: {
          run_id: holder.run_id, dispatchRunId: ctx.tuple.runId, claimMs: judged.prior, host: holder.host, pid: holder.pid,
          startedAt: holder.startedAt, rawSha256: createHash("sha256").update(raw).digest("hex"), compareAndReclaim: "matched",
        },
      };
    }
  }
  const back = parseLockHolder(readFileSync(path, "utf8"));
  if (back?.run_id !== runId) return { reason: "branch_claim_readback_mismatch" };
  return {
    path,
    storedRunId: back.run_id,
    ...(prior !== undefined ? { prior } : {}),
    release() {
      let now: LockHolder | undefined;
      try {
        now = parseLockHolder(readFileSync(path, "utf8"));
      } catch (error) {
        return void messageOf(error); // already gone: nothing of ours to release
      }
      if (now?.run_id === runId) unlinkSync(path);
    },
  };
}

function claimFacts(path: string, ours: string, prior: HeldClaim["prior"]): StaleFixDispatchFacts["fixBranchClaim"] {
  let holder: LockHolder | undefined;
  try {
    holder = parseLockHolder(readFileSync(path, "utf8"));
  } catch (error) {
    return { state: "unknown", holder: messageOf(error) };
  }
  if (holder === undefined) return { state: "unknown" };
  return {
    state: "held", holder: `${holder.host}:${holder.pid}`, holderRunId: holder.run_id,
    ...(holder.run_id === ours && prior !== undefined ? { reclaimedPrior: prior.reclaimed } : {}),
  };
}

/** Prior-lock evidence this recovery already compare-and-reclaimed, re-validated against history. */
function recordedPrior(rows: readonly Row[], auth: AuthorizationRow, recoveryId: string, ctx: ClaimContext, file: ReceiptFile): HeldClaim["prior"] {
  const held = rows.filter((row) => row.step === PR_OWNER_RECOVERY_RECEIPT_STEP && row.recovery_id === recoveryId);
  const reclaimedIn = (row: Row) => (row.liveness as StaleFixDispatchReceipt["liveness"] | undefined)?.fix_branch_claim?.reclaimedPrior;
  // Newest first: the crash-orphaned canonical file, then held receipts, then the authorization.
  const candidates = [auth.priorClaim, ...held.map(reclaimedIn), file.state === "valid" ? reclaimedIn(file.receipt) : undefined];
  for (const rp of candidates.reverse()) {
    if (rp === undefined || typeof rp?.run_id !== "string" || typeof rp.startedAt !== "string") continue;
    const parsed = parsePriorDispatchClaim(rp, ctx.tuple, rows, ctx.fixRoundClaimId);
    if (parsed.ok && parsed.claimMs === rp.claimMs) {
      return { holder: { pid: rp.pid, run_id: rp.run_id, host: rp.host, startedAt: rp.startedAt }, reclaimed: rp };
    }
  }
  return undefined;
}

// ── preservation ─────────────────────────────────────────────────────────────────────────────

/** Snapshot dirty or unpublished work into a create-only refs/rmd-recovery commit and publish it
 *  create-only. A clean tree whose head the PR head contains has nothing to preserve. */
export async function preserveRecoveryWork(
  ports: RecoveryPorts,
  t: RecoveryTuple,
  prHead: string,
  recoveryId: string,
): Promise<StaleFixDispatchFacts["preservation"]> {
  const wt = await registeredWorktree(ports, t.branch);
  if (wt.state === "unknown") return { state: "unknown", reason: wt.reason };
  const at = wt.state === "found" ? wt.path : ports.repoDir;
  const head = await ports.git(["rev-parse", "--verify", "--quiet", wt.state === "found" ? "HEAD" : `refs/heads/${t.branch}^{commit}`], { cwd: at });
  if (head.status !== 0) {
    return wt.state === "none" ? { state: "nothing_to_preserve", headContained: true } : { state: "unknown", reason: "worktree HEAD unreadable" };
  }
  const headSha = head.stdout.trim();
  let dirty = false;
  if (wt.state === "found") {
    const status = await ports.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: at });
    if (status.status !== 0) return { state: "unknown", reason: `git status failed: ${status.stderr.trim()}` };
    dirty = status.stdout.length > 0;
  }
  const contained = (await ports.git(["merge-base", "--is-ancestor", headSha, prHead], { cwd: ports.repoDir })).status === 0;
  if (!dirty && contained) return { state: "nothing_to_preserve", headContained: true };
  let sha = headSha;
  if (dirty) {
    const index = join(tmpdir(), `rmd-pr-owner-recover-${recoveryId.slice(0, 16)}-${ports.nonce()}.index`);
    try {
      const env = { GIT_INDEX_FILE: index };
      for (const args of [["read-tree", headSha], ["add", "-A"]]) {
        const res = await ports.git(args, { cwd: at, env });
        if (res.status !== 0) return { state: "failed", reason: `git ${args[0]} failed: ${res.stderr.trim()}` };
      }
      const tree = await ports.git(["write-tree"], { cwd: at, env });
      const commit = tree.status === 0
        ? await ports.git(["commit-tree", tree.stdout.trim(), "-p", headSha, "-m", `rmd pr-owner-recover ${recoveryId}`], { cwd: at, env })
        : tree;
      if (commit.status !== 0) return { state: "failed", reason: `snapshot commit failed: ${commit.stderr.trim()}` };
      sha = commit.stdout.trim();
    } finally {
      rmSync(index, { force: true });
    }
  }
  const ref = `${RECOVERY_REF_NAMESPACE}/pr-owner/${recoveryId}`;
  const created = await ports.git(["update-ref", ref, sha, ""], { cwd: ports.repoDir });
  if (created.status !== 0) {
    const existing = await ports.git(["rev-parse", "--verify", "--quiet", ref], { cwd: ports.repoDir });
    if (existing.stdout.trim() !== sha) return { state: "failed", reason: `local ${ref} already names another commit` };
  }
  const published = await publishRecoveryRefs((args) => ports.git(args, { cwd: ports.repoDir }), (step, extra) => ports.appendLedger(step, extra));
  if (published.unreachable !== undefined) return { state: "failed", reason: published.unreachable };
  if (published.conflicts.includes(ref)) return { state: "failed", reason: `origin ${ref} already names another commit` };
  if (published.origin?.get(ref) !== sha) return { state: "failed", reason: `origin did not accept ${ref}` };
  return { state: "published", recoveryRef: ref, sha };
}

// ── the receipt file ─────────────────────────────────────────────────────────────────────────

type ReceiptFile = { state: "absent" } | { state: "valid"; receipt: Row } | { state: "invalid"; reason: string };

function receiptDir(stateDir: string): string {
  return join(stateDir, "pr-owner-recoveries");
}

function readReceiptFile(stateDir: string, recoveryId: string, t: RecoveryTuple, authorizationId: string): ReceiptFile {
  const path = join(receiptDir(stateDir), `${recoveryId}.json`);
  let raw: string;
  try {
    const dir = lstatSync(receiptDir(stateDir));
    const st = lstatSync(path);
    const uid = process.getuid?.();
    if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700) return { state: "invalid", reason: "receipt directory is not owner-only" };
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || (uid !== undefined && st.uid !== uid)) {
      return { state: "invalid", reason: "receipt file type, owner or mode mismatch" };
    }
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "invalid", reason: messageOf(error) };
  }
  let receipt: Row;
  try {
    receipt = JSON.parse(raw) as Row;
  } catch (error) {
    return { state: "invalid", reason: `receipt file unparseable: ${messageOf(error)}` };
  }
  const exact = JSON.stringify(receipt) + "\n" === raw && receipt.step === PR_OWNER_RECOVERY_RECEIPT_STEP && receipt.outcome === "released" &&
    receipt.recovery_id === recoveryId && sameDispatch(receipt, t) && receipt.head_sha === t.headSha && receipt.base_sha === t.baseSha &&
    receipt.branch === t.branch && receipt.authorization_id === authorizationId;
  return exact ? { state: "valid", receipt } : { state: "invalid", reason: "receipt file is not this recovery's canonical receipt" };
}

function createReceiptFile(stateDir: string, recoveryId: string, receipt: Row): void {
  mkdirSync(receiptDir(stateDir), { recursive: true, mode: 0o700 });
  writeFileSync(join(receiptDir(stateDir), `${recoveryId}.json`), JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
}

function appendReceipt(ports: RecoveryPorts, receipt: Row): void {
  const { step, ...row } = receipt;
  ports.appendLedger(String(step), { ...row, operator_login: row.actor });
}

// ── shared checks ────────────────────────────────────────────────────────────────────────────

async function readLedgerSafe(ports: RecoveryPorts): Promise<RecoveryLedgerRead> {
  try {
    const read = await ports.readLedger();
    return read.ok && read.unread.length === 0 ? read : { ...read, ok: false };
  } catch (error) {
    return { ok: false, unread: [messageOf(error)], rows: [] };
  }
}

/** The authenticated login when it is an admin of exactly `repo`, else a refusal reason. */
async function adminLogin(ports: RecoveryPorts, repo: string): Promise<{ login: string } | { reason: string }> {
  if (isFleetAutomationActor(ports.processActor())) return { reason: `fleet_automation_actor:${ports.processActor()}` };
  let login: string;
  try {
    login = await ports.currentLogin();
  } catch (error) {
    return { reason: `identity_unreadable: ${messageOf(error)}` };
  }
  if (!nonEmpty(login) || login.endsWith("[bot]")) return { reason: `identity_not_operator:${login}` };
  return (await isAdmin(ports, repo, login)) ? { login } : { reason: `not_admin:${login}` };
}

async function isAdmin(ports: RecoveryPorts, repo: string, login: string): Promise<boolean> {
  try {
    return (await ports.permission(repo, login)) === "admin";
  } catch (error) {
    void error;
    return false; // deliberate: an unreadable permission lookup is never admin, so every caller refuses
  }
}

// ── --authorize ──────────────────────────────────────────────────────────────────────────────

export interface AuthorizeArgs extends RecoveryTuple {
  reason: string;
}

export interface RecoveryDeps {
  ports: RecoveryPorts;
  claimKeyOf: ClaimKeyOf;
  fixRoundClaimId: (runId: string, prNumber: number, nowMs: number) => string;
}

function validTuple(t: RecoveryTuple): string | undefined {
  if (!splitRepo(t.repo)) return "--repo must be owner/name";
  if (!Number.isSafeInteger(t.prNumber) || t.prNumber <= 0) return "<pr> must be a positive integer";
  for (const [flag, value] of [["--task", t.taskId], ["--run", t.runId], ["--round", t.roundId], ["--branch", t.branch]] as const) {
    if (!nonEmpty(value)) return `${flag} is required`;
  }
  if (!FULL_SHA.test(t.headSha)) return "--head must be a full 40-hex sha";
  if (!FULL_SHA.test(t.baseSha)) return "--base must be a full 40-hex sha";
  return undefined;
}

function dispatchMatches(rows: readonly Row[], t: RecoveryTuple): string | undefined {
  const latest = newestDispatch(rows, t.prNumber);
  if (latest === undefined) return "no_fix_dispatch_for_pr";
  if (latest.run_id !== t.runId || latest.round_id !== t.roundId || latest.task_id !== t.taskId) return "not_newest_dispatch";
  return undefined;
}

export async function authorizeStaleFixDispatchRecovery(args: AuthorizeArgs, deps: RecoveryDeps): Promise<RecoveryResult> {
  const { ports } = deps;
  const invalid = validTuple(args) ?? (nonEmpty(args.reason) ? undefined : "--reason is required");
  if (invalid) return { outcome: "refused", reason: invalid };
  const t: RecoveryTuple = { ...args };
  const admin = await adminLogin(ports, t.repo);
  if ("reason" in admin) return { outcome: "refused", reason: admin.reason };
  let live: LivePr;
  try {
    live = await ports.readPr(t.repo, t.prNumber);
  } catch (error) {
    return { outcome: "refused", reason: `pr_unreadable: ${messageOf(error)}` };
  }
  if (live.repo !== t.repo || live.prNumber !== t.prNumber) return { outcome: "refused", reason: "pr_identity_mismatch" };
  if (live.branch !== t.branch) return { outcome: "refused", reason: `branch_mismatch: live head branch is ${live.branch}` };
  const [owner, name] = splitRepo(t.repo)!;
  const tupleHash = recoveryTupleHash(t);
  const before = await readLedgerSafe(ports);
  const ctx: ClaimContext = { tuple: t, rows: before.rows, tupleHash, fixRoundClaimId: deps.fixRoundClaimId };
  const claim = await acquireClaim(ports, deps.claimKeyOf(owner, name, live.branch), `PR-OWNER-AUTH:${tupleHash}:${ports.nonce()}`, ctx);
  if (!("storedRunId" in claim)) return { outcome: "refused", reason: claim.reason };
  try {
    await ports.underClaim?.();
    const ledger = await readLedgerSafe(ports);
    if (!ledger.ok) return { outcome: "refused", reason: "ledger_unreadable" };
    let again: LivePr;
    try {
      again = await ports.readPr(t.repo, t.prNumber);
    } catch (error) {
      return { outcome: "refused", reason: `pr_unreadable: ${messageOf(error)}` };
    }
    if (again.branch !== t.branch) return { outcome: "refused", reason: "branch_mismatch" };
    const stale = dispatchMatches(ledger.rows, t);
    if (stale) return { outcome: "refused", reason: stale };
    const history = releaseHistory(ledger.rows, t);
    if (history.kind !== "none") return { outcome: "refused", reason: history.kind === "one" ? "already_released" : "release_history_conflict" };
    const rows = ledger.rows.filter((row) => row.step === PR_OWNER_RECOVERY_AUTHORIZED_STEP && sameDispatch(row, t, "dispatch_run_id", "dispatch_round_id"));
    const parsed = rows.map(parseAuthRow);
    if (parsed.some((a) => a === undefined)) return { outcome: "refused", reason: "authorization_history_unreadable" };
    const open = parsed.find((a) => a !== undefined);
    if (open) return { outcome: "refused", reason: `authorization_exists:${open.authorizationId}` };
    if (!(await isAdmin(ports, t.repo, admin.login))) return { outcome: "refused", reason: `not_admin:${admin.login}` };
    const ts = ports.nowIso();
    const authorizationId = recoveryAuthorizationId(t, admin.login, ts);
    const row: Row = {
      task_id: t.taskId, repo: t.repo, pr_number: t.prNumber, dispatch_run_id: t.runId, dispatch_round_id: t.roundId,
      head_sha: t.headSha, base_sha: t.baseSha, branch: t.branch, login: admin.login, reason: args.reason, ts,
      authorization_id: authorizationId, ...(claim.prior !== undefined ? { prior_claim: claim.prior.reclaimed } : {}),
    };
    ports.appendLedger(PR_OWNER_RECOVERY_AUTHORIZED_STEP, row);
    return { outcome: "authorized", authorizationId, row };
  } finally {
    claim.release();
  }
}

// ── --apply ──────────────────────────────────────────────────────────────────────────────────

interface Gathered {
  facts: StaleFixDispatchFacts;
  latestTs?: string;
}

async function gather(
  ports: RecoveryPorts,
  t: RecoveryTuple,
  authorizationId: string,
  claim: HeldClaim,
  prior: HeldClaim["prior"],
  preservation: StaleFixDispatchFacts["preservation"],
): Promise<Gathered | { reason: string }> {
  const ledger = await readLedgerSafe(ports);
  let pr: LivePr;
  try {
    pr = await ports.readPr(t.repo, t.prNumber);
  } catch (error) {
    return { reason: `pr_unreadable: ${messageOf(error)}` };
  }
  const latest = newestDispatch(ledger.rows, t.prNumber);
  // The authorized dispatch as the ledger still records it; the newest one is compared separately.
  const own = ledger.rows.find((row) => row.step === "fix.dispatch" && prOf(row) === t.prNumber && row.run_id === t.runId && row.round_id === t.roundId);
  const observed: StaleFixDispatchIdentity = {
    repo: pr.repo, prNumber: pr.prNumber, taskId: String(own?.task_id ?? ""), dispatchRunId: String(own?.run_id ?? ""),
    dispatchRoundId: String(own?.round_id ?? ""), headSha: pr.headSha, baseSha: pr.baseSha, branch: pr.branch, authorizationId,
  };
  const latestTs = typeof latest?.ts === "string" ? latest.ts : undefined;
  return {
    latestTs,
    facts: {
      observed,
      ...(latest !== undefined ? { latestDispatch: { runId: String(latest.run_id ?? ""), roundId: String(latest.round_id ?? ""), ...(latestTs ? { ts: latestTs } : {}) } } : {}),
      process: processOf(ports, prior?.holder),
      descendants: prior ? ports.descendants(prior.holder.pid) : { state: "unknown" },
      cwdCensus: await cwdOf(ports, t.branch),
      fixBranchClaim: claimFacts(claim.path, claim.storedRunId, prior),
      dispatchClaim: await dispatchClaimOf(ports, t.taskId),
      preservation,
      ledgerRead: { ok: ledger.ok, unread: ledger.unread },
    },
  };
}

function laterThanAll(now: string, stamps: ReadonlyArray<string | undefined>): boolean {
  const nowMs = Date.parse(now);
  return Number.isFinite(nowMs) && stamps.every((s) => s !== undefined && Number.isFinite(Date.parse(s)) && nowMs > Date.parse(s));
}

async function lostClaim(ports: RecoveryPorts, t: RecoveryTuple, reason: string): Promise<RecoveryResult> {
  const ledger = await readLedgerSafe(ports);
  const history = ledger.ok ? releaseHistory(ledger.rows, t) : { kind: "conflict" as const };
  if (history.kind === "one") return { outcome: "released", receipt: history.receipt, existing: true };
  return { outcome: "held", reason, durable: false };
}

export async function applyStaleFixDispatchRecovery(args: { authorizationId: string }, deps: RecoveryDeps): Promise<RecoveryResult> {
  const { ports } = deps;
  const first = await readLedgerSafe(ports);
  if (!first.ok) return { outcome: "unknown", reason: "ledger_unreadable" };
  const candidates = first.rows.filter((row) => row.step === PR_OWNER_RECOVERY_AUTHORIZED_STEP && row.authorization_id === args.authorizationId);
  const candidate = candidates.length === 1 ? parseAuthRow(candidates[0]!) : undefined;
  if (!candidate) return { outcome: "refused", reason: candidates.length === 0 ? "authorization_missing" : "authorization_invalid" };
  const t = candidate.tuple;
  const recoveryId = staleFixDispatchRecoveryId(identityOf(t, candidate.authorizationId));
  const [owner, name] = splitRepo(t.repo) ?? ["", ""];
  const ctx: ClaimContext = { tuple: t, rows: first.rows, tupleHash: recoveryTupleHash(t), recoveryId, fixRoundClaimId: deps.fixRoundClaimId };
  const claim = await acquireClaim(ports, deps.claimKeyOf(owner, name, t.branch), `PR-OWNER-RECOVER:${recoveryId}:${ports.nonce()}`, ctx);
  if (!("storedRunId" in claim)) return lostClaim(ports, t, claim.reason === "competing_branch_claim_held" ? "branch_claim_held" : claim.reason);
  try {
    await ports.underClaim?.();
    return await applyUnderClaim(ports, t, recoveryId, claim, ctx, args.authorizationId);
  } finally {
    claim.release();
  }
}

async function applyUnderClaim(
  ports: RecoveryPorts,
  t: RecoveryTuple,
  recoveryId: string,
  claim: HeldClaim,
  ctx: ClaimContext,
  authorizationId: string,
): Promise<RecoveryResult> {
  const ledger = await readLedgerSafe(ports);
  if (!ledger.ok) return { outcome: "unknown", reason: "ledger_unreadable" };
  const history = releaseHistory(ledger.rows, t);
  if (history.kind === "one") return { outcome: "released", receipt: history.receipt, existing: true };
  if (history.kind === "conflict") return { outcome: "held", reason: "release_history_conflict", durable: false };
  const auths = ledger.rows.filter((row) => row.step === PR_OWNER_RECOVERY_AUTHORIZED_STEP && row.authorization_id === authorizationId);
  const auth = auths.length === 1 ? parseAuthRow(auths[0]!) : undefined;
  if (!auth || recoveryTupleHash(auth.tuple) !== ctx.tupleHash) return { outcome: "refused", reason: "authorization_invalid" };
  const admin = await adminLogin(ports, t.repo);
  if ("reason" in admin) return { outcome: "refused", reason: admin.reason };
  if (admin.login !== auth.login) return { outcome: "refused", reason: `authorization_login_mismatch:${admin.login}` };
  const file = readReceiptFile(ports.stateDir, recoveryId, t, authorizationId);
  if (file.state === "invalid") return { outcome: "unknown", reason: file.reason };
  const prior = claim.prior ?? recordedPrior(ledger.rows, auth, recoveryId, { ...ctx, rows: ledger.rows }, file);
  const expected: StaleFixDispatchExpected = {
    ...identityOf(t, authorizationId), recoveryInvocationRunId: claim.storedRunId,
    ...(prior !== undefined ? { priorFixBranchClaimRunId: prior.reclaimed.run_id } : {}),
  };
  const meta = (nowIso: string) => ({ actor: admin.login, nowIso, reason: auth.reason });
  const hold = (facts: StaleFixDispatchFacts): RecoveryResult => {
    if (file.state === "valid") return { outcome: "held", reason: "receipt_replay_pending", durable: false };
    const receipt = staleFixDispatchRecoveryReceipt(expected, facts, meta(ports.nowIso())) as unknown as Row;
    appendReceipt(ports, receipt);
    return { outcome: "held", reason: String(receipt.hold_reason), durable: true, receipt };
  };

  const firstRead = await gather(ports, t, authorizationId, claim, prior, { state: "unknown", reason: "first read: preservation runs after this decision" });
  if ("reason" in firstRead) return { outcome: "unknown", reason: firstRead.reason };
  const d1 = decideStaleFixDispatchRecovery(expected, firstRead.facts);
  if (d1.kind === "hold" && d1.reason !== "preservation_unknown") return hold(firstRead.facts);
  await ports.afterFirstRead?.();

  const preservation = await preserveRecoveryWork(ports, t, firstRead.facts.observed.headSha, recoveryId);
  await ports.beforeSecondRead?.();
  const second = await gather(ports, t, authorizationId, claim, prior, preservation);
  if ("reason" in second) return { outcome: "unknown", reason: second.reason };
  if (decideStaleFixDispatchRecovery(expected, second.facts).kind === "hold") return hold(second.facts);

  if (file.state === "valid") {
    appendReceipt(ports, file.receipt);
    return { outcome: "released", receipt: file.receipt, replayed: true };
  }
  const nowIso = ports.nowIso();
  const priorStamps = [second.latestTs, ...heldFor(ledger.rows, t).map((row) => (typeof row.ts === "string" ? row.ts : undefined))];
  if (!laterThanAll(nowIso, priorStamps)) return { outcome: "held", reason: "receipt_time_not_after_prior_evidence", durable: false };
  const receipt = staleFixDispatchRecoveryReceipt(expected, second.facts, meta(nowIso)) as unknown as Row;
  try {
    createReceiptFile(ports.stateDir, recoveryId, receipt);
  } catch (error) {
    return { outcome: "unknown", reason: `receipt_file_not_created: ${messageOf(error)}` };
  }
  appendReceipt(ports, receipt);
  return { outcome: "released", receipt };
}

// ── default probes (the production ports in src/run-task.ts wire these) ──────────────────────

/** Same-host liveness of a lock holder: dead, alive, reused (a newer process on the pid) or foreign. */
export function defaultProbeProcess(
  holder: LockHolder,
  deps: { hostname: () => string; isPidAlive?: (pid: number) => boolean; startTime?: (pid: number) => number | null },
): StaleFixDispatchProcess["state"] {
  if (!sameHost(holder.host, deps.hostname())) return "foreign_host";
  if (!(deps.isPidAlive ?? defaultIsPidAlive)(holder.pid)) return "dead";
  const started = (deps.startTime ?? defaultGetProcessStartTime)(holder.pid);
  const lockMs = Date.parse(holder.startedAt);
  return started !== null && Number.isFinite(lockMs) && started - lockMs > 2000 ? "reused" : "alive";
}

/** Every live descendant of `pid` by a ppid walk over `/proc/<n>/stat`; unknown off Linux. */
export function defaultDescendants(pid: number, procRoot = "/proc", platform: string = process.platform): StaleFixDispatchFacts["descendants"] {
  if (platform !== "linux") return { state: "unknown" };
  let entries: string[];
  try {
    entries = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch (error) {
    void error;
    return { state: "unknown" }; // deliberate: an unlistable process table proves no absence, so it holds
  }
  const children = new Map<number, number[]>();
  for (const name of entries) {
    let stat: string;
    try {
      stat = readFileSync(join(procRoot, name, "stat"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue; // exited mid-walk
      return { state: "unknown" };
    }
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    children.set(ppid, [...(children.get(ppid) ?? []), Number(name)]);
  }
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found.length > 0 ? { state: "present", pids: found } : { state: "none" };
}

/** `git <args>` resolving on every outcome, with an optional cwd and extra environment. */
export function defaultRecoveryGit(repoDir: string): RecoveryGit {
  return (args, opts = {}) =>
    new Promise((resolve) => {
      execFile("git", args, { cwd: opts.cwd ?? repoDir, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ status: error ? (typeof code === "number" ? code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}
