/**
 * lib/field-trials-github.ts — W1-T4574: the GitHub half of the field-trials aggregate.
 *
 * Reads pull requests, main-branch commits and deployments for each opted-in repository through
 * ONE injectable page seam ({@link GithubPageFetch}; the default shells `gh api`). Each list is
 * swept newest-first and paged; a sweep that stops early (a failed page or the page budget)
 * records the page to resume from, and only a completed sweep advances its watermark. Per-PR
 * detail (reviews, commits, first-commit check runs) is re-read when the PR was edited, was still
 * open at its last read, or was never read. Every cursor keeps its as-of time, pages read and why
 * it is partial.
 *
 * The store written here is PRIVATE and local: it holds PR node ids, head refs, SHAs and the task
 * ids a PR body names. Bodies, titles and account logins are read and discarded — only the
 * derived trailer ids, revert target and a bot/human class survive. Nothing here decides whether a
 * change deployed or was correct; field-trials-flow.ts reads these facts and keeps those separate.
 */
import { fixedClock } from "./clock.js";
import { ghInteractiveRead } from "./github-transport.js";

export const FIELD_TRIALS_GITHUB_VERSION = "field-trials-github-v1" as const;

/** PRIMARY CONTROL: items requested per REST page — GitHub's maximum, so a sweep reads the fewest pages. */
export const GITHUB_PAGE_SIZE = 100;
/** BACKSTOP: pages one pass may read across every repository. A pass that reaches it stores the page
 *  to resume from, so a large backlog spreads over several operator passes and is never dropped. */
export const DEFAULT_MAX_PAGES = 300;
/** BACKSTOP: bytes one `gh api` page may print before the read is treated as failed. */
const GH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** A plan-task trailer line in a PR body, anchored to the whole line. */
export const TRAILER_LINE_RE = /^Remudero-Task:[ \t]*([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*$/;
/** The fleet's branch credit path: `run-<taskId>-<digits>`. */
export const RUN_BRANCH_RE = /^run-(.+)-\d+$/;
/** GitHub's own revert body line, `Reverts owner/repo#123`. */
export const REVERTS_LINE_RE = /^Reverts [\w.-]+\/[\w.-]+#(\d+)\s*$/;

export type GithubPage = { ok: true; items: unknown[] } | { ok: false; reason: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function iso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? fixedClock(Date.parse(value)).iso() : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type GithubPageFetch = (path: string) => Promise<GithubPage>;

/** One REST page as a list: a plain array, or the `check_runs` array GitHub wraps that endpoint in. */
export function pageOf(body: string): GithubPage {
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch {
    const reason = "github-page-unparseable";
    return { ok: false, reason };
  }
  const value = record(parsed);
  const action = value !== undefined && Number.isSafeInteger(value.id) && text(value.head_sha) !== null
    && (Number.isSafeInteger(value.workflow_id) || (Number.isSafeInteger(value.run_id) && text(value.check_run_url) !== null));
  const items = Array.isArray(parsed) ? parsed : value?.check_runs ?? (action ? [parsed] : undefined);
  return Array.isArray(items) ? { ok: true, items } : { ok: false, reason: "github-page-not-a-list" };
}

/** The default seam: `gh api <path>` through the paced, bounded GitHub transport. A failed or refused
 *  read is a reason, never a throw, so the pass records where to resume. */
export function ghApiFetch(read: (args: string[]) => Promise<string> = async (args) => String(await ghInteractiveRead(args,
  { encoding: "utf8", maxBuffer: GH_MAX_BUFFER_BYTES }))): GithubPageFetch {
  return async (path) => {
    let body: string;
    try { body = await read(["api", path]); }
    catch {
      const reason = "github-read-failed";
      return { ok: false, reason };
    }
    return pageOf(body);
  };
}

export type AuthorClass = "bot" | "human" | "unknown";

/** A login is read only to classify it; it is never stored. */
export function authorClassOf(user: unknown): AuthorClass {
  const value = record(user);
  const login = text(value?.login);
  if (value === undefined || login === null) return "unknown";
  return value.type === "Bot" || login.endsWith("[bot]") ? "bot" : "human";
}

/** Every distinct `Remudero-Task:` id a body names, in order. More than one makes the PR ambiguous. */
export function trailerTaskIds(body: unknown): string[] {
  const ids: string[] = [];
  for (const line of typeof body === "string" ? body.split(/\r?\n/) : []) {
    const id = TRAILER_LINE_RE.exec(line)?.[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function revertedPrNumber(body: unknown): number | null {
  for (const line of typeof body === "string" ? body.split(/\r?\n/) : []) {
    const match = REVERTS_LINE_RE.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

export interface CheckSummary {
  sha: string;
  state: "green" | "red" | "pending" | "none";
  distinctChecks: number;
  /** Extra runs of an already-counted check name on the same SHA: a rerun, never a new PR. */
  reruns: number;
}

/** Latest attempt per check name only, so a rerun that went green replaces its own red attempt. */
export function summarizeChecks(sha: string, items: readonly unknown[]): CheckSummary {
  const latest = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const run = record(item);
    const name = text(run?.name);
    if (run === undefined || name === null) continue;
    const prior = latest.get(name);
    if (prior === undefined || Number(run.id) > Number(prior.id)) latest.set(name, run);
  }
  const runs = [...latest.values()];
  const counted = items.filter((item) => text(record(item)?.name) !== null).length;
  const state = runs.length === 0 ? "none"
    : runs.some((run) => run.status !== "completed") ? "pending"
      : runs.every((run) => ["success", "neutral", "skipped"].includes(String(run.conclusion))) ? "green" : "red";
  return { sha, state, distinctChecks: runs.length, reruns: counted - runs.length };
}

export interface PullDetail {
  state: "observed";
  readAt: string;
  /** The PR was open at this read; open work keeps changing, so it is re-read next pass. */
  readWhileOpen: boolean;
  reviews: { total: number; human: number; changesRequested: number; approvals: number; truncated: boolean };
  commits: { count: number; firstSha: string | null; lastCommittedAt: string | null; truncated: boolean };
  checks: CheckSummary | { state: "unavailable"; reason: string };
}

export interface GithubPull {
  nodeId: string;
  number: number;
  state: "open" | "closed";
  createdAt: string | null;
  updatedAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  headRef: string | null;
  headSha: string | null;
  mergeCommitSha: string | null;
  trailerTaskIds: string[];
  revertsPr: number | null;
  authorClass: AuthorClass;
  detail: PullDetail | { state: "pending" } | { state: "unavailable"; reason: string };
  headGreen?: HeadGreenObservation;
}

/** BACKSTOP: a head's traversal and pending producer identities stay bounded in the private store. */
const HEAD_GREEN_MAX_PAGES = 10;
const HEAD_GREEN_MAX_CANDIDATES = 100;
interface HeadGreenCandidate {
  checkId: number; suiteId: number; runId: number; jobId: number;
  checkCompletedAt: string; firstReadAt: string;
  producer?: { workflowId: number; path: string };
}
export interface HeadGreenEvidence extends HeadGreenCandidate {
  completedAt: string; validatedAt: string;
  producer: { workflowId: number; path: string };
}
export interface HeadGreenObservation {
  version: 1;
  headSha: string;
  state: "pending" | "observed" | "unavailable";
  readAt: string | null;
  history: { state: "pending" | "partial" | "complete"; nextPage: number; pagesRead: number; reason: string | null };
  pending: HeadGreenCandidate[];
  seenCheckIds: number[];
  firstObserved: HeadGreenEvidence | null;
  firstEver: "unavailable-retention-uncertified";
}

const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const shaIdentity = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const gateWorkflow = (value: unknown): value is string => value === ".github/workflows/ci.yml" || value === ".github/workflows/ci-gate.yml";
function freshHeadGreen(headSha: string): HeadGreenObservation {
  return { version: 1, headSha, state: "pending", readAt: null,
    history: { state: "pending", nextPage: 1, pagesRead: 0, reason: null }, pending: [], seenCheckIds: [], firstObserved: null,
    firstEver: "unavailable-retention-uncertified" };
}
function validCandidate(value: unknown): value is HeadGreenCandidate {
  const row = record(value); const producer = record(row?.producer);
  return row !== undefined && [row.checkId, row.suiteId, row.runId, row.jobId].every(positiveId)
    && iso(row.checkCompletedAt) !== null && iso(row.firstReadAt) !== null
    && (row.producer === undefined || (positiveId(producer?.workflowId) && gateWorkflow(producer?.path)));
}
function headObservation(pull: GithubPull): HeadGreenObservation | null {
  if (!shaIdentity(pull.headSha)) return null;
  const prior = pull.headGreen;
  if (prior?.version === 1 && prior.headSha === pull.headSha && prior.firstEver === "unavailable-retention-uncertified"
    && positiveId(prior.history?.nextPage) && prior.history.nextPage <= HEAD_GREEN_MAX_PAGES + 1
    && Array.isArray(prior.pending) && prior.pending.length <= HEAD_GREEN_MAX_CANDIDATES && prior.pending.every(validCandidate)
    && Array.isArray(prior.seenCheckIds) && prior.seenCheckIds.length <= HEAD_GREEN_MAX_PAGES * GITHUB_PAGE_SIZE
    && prior.seenCheckIds.every(positiveId)) return prior;
  return pull.headGreen = freshHeadGreen(pull.headSha);
}

/** One positive current-head receipt; a completed page traversal never certifies retained first-ever history. */
export function observedCurrentHeadGreen(pull: GithubPull, asOf: string): HeadGreenEvidence | null {
  const observation = pull.headGreen; const found = observation?.firstObserved;
  if (iso(asOf) === null || observation?.version !== 1 || observation.headSha !== pull.headSha || observation.state !== "observed"
    || observation.firstEver !== "unavailable-retention-uncertified" || !validCandidate(found)
    || !found.producer || iso(found.completedAt) === null || iso(found.validatedAt) === null
    || pull.createdAt === null || Date.parse(found.completedAt) < Date.parse(pull.createdAt)
    || [found.completedAt, found.checkCompletedAt, found.firstReadAt, found.validatedAt].some((at) => Date.parse(at) > Date.parse(asOf))) return null;
  return found;
}

function gateCandidate(item: unknown, repo: string, pull: GithubPull, asOf: string): HeadGreenCandidate | null {
  const row = record(item); const completed = iso(row?.completed_at);
  const checkSuite = record(row?.check_suite);
  if (checkSuite === undefined) return null;
  if (!row || row.name !== "ci-gate" || row.status !== "completed" || row.conclusion !== "success"
    || record(row.app)?.slug !== "github-actions" || row.head_sha !== pull.headSha || completed === null
    || !positiveId(row.id) || !positiveId(checkSuite.id) || pull.createdAt === null
    || Date.parse(completed) < Date.parse(pull.createdAt) || Date.parse(completed) > Date.parse(asOf)) return null;
  if (typeof row.details_url !== "string" || !URL.canParse(row.details_url)) return null;
  const url = new URL(row.details_url);
  if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash) return null;
  const prefix = "/" + repo + "/";
  if (!url.pathname.startsWith(prefix)) return null;
  const match = /^(?:actions\/runs\/([0-9]+)\/job\/([0-9]+)|runs\/([0-9]+)\/jobs\/([0-9]+))$/.exec(url.pathname.slice(prefix.length));
  const runId = Number(match?.[1] ?? match?.[3]); const jobId = Number(match?.[2] ?? match?.[4]);
  if (!positiveId(runId) || !positiveId(jobId)) return null;
  return { checkId: row.id, suiteId: checkSuite.id as number, runId, jobId,
    checkCompletedAt: completed, firstReadAt: asOf };
}

async function readHeadGreen(fetch: GithubPageFetch, repo: string, pull: GithubPull, budget: Budget, asOf: string): Promise<boolean> {
  const observation = headObservation(pull);
  if (observation === null || budget.left <= 0) return false;
  const candidate = observation.pending[0];
  const read = async (path: string) => { budget.left -= 1; observation.readAt = asOf; return fetch(path); };
  if (candidate) {
    const path = candidate.producer ? `repos/${repo}/actions/jobs/${candidate.jobId}` : `repos/${repo}/actions/runs/${candidate.runId}`;
    const response = await read(path);
    if (!response.ok) { observation.history.reason = response.reason; return false; }
    const row = record(response.items[0]);
    if (!candidate.producer) {
      const related = Array.isArray(row?.pull_requests) && row.pull_requests.some((item) => {
        const pr = record(item); return pr?.number === pull.number && record(pr.head)?.sha === pull.headSha;
      });
      if (row?.id === candidate.runId && row.head_sha === pull.headSha && row.check_suite_id === candidate.suiteId
        && record(row.repository)?.full_name === repo && row.event === "pull_request" && related
        && positiveId(row.workflow_id) && gateWorkflow(row.path)) {
        candidate.producer = { workflowId: row.workflow_id, path: row.path };
        return true;
      }
      observation.history.reason = "head-gate-producer-identity-mismatch";
    } else {
      const completed = iso(row?.completed_at);
      if (row?.id === candidate.jobId && row.run_id === candidate.runId && row.head_sha === pull.headSha
        && row.name === "ci-gate" && row.status === "completed" && row.conclusion === "success"
        && row.check_run_url === `https://api.github.com/repos/${repo}/check-runs/${candidate.checkId}`
        && completed !== null && pull.createdAt !== null && Date.parse(completed) >= Date.parse(pull.createdAt)
        && Date.parse(completed) <= Date.parse(asOf)) {
        const evidence: HeadGreenEvidence = { ...candidate, producer: candidate.producer, completedAt: completed, validatedAt: asOf };
        if (observation.firstObserved === null || evidence.completedAt < observation.firstObserved.completedAt) observation.firstObserved = evidence;
        observation.state = "observed";
      } else observation.history.reason = "head-gate-job-identity-mismatch";
    }
    observation.pending.shift();
    return true;
  }
  if (observation.history.state === "complete" || observation.history.nextPage > HEAD_GREEN_MAX_PAGES) return false;
  const page = observation.history.nextPage;
  const response = await read(`repos/${repo}/commits/${pull.headSha}/check-runs?check_name=ci-gate&filter=all&per_page=${GITHUB_PAGE_SIZE}&page=${page}`);
  if (!response.ok) { observation.history.state = "partial"; observation.history.reason = response.reason; return false; }
  observeHeadCheckPage(observation, response.items, repo, pull, asOf);
  return true;
}

function observeHeadCheckPage(observation: HeadGreenObservation, items: unknown[], repo: string, pull: GithubPull, asOf: string): void {
  const seen = new Set(observation.seenCheckIds); observation.readAt = asOf;
  for (const item of items.slice(0, GITHUB_PAGE_SIZE)) {
    const id = record(item)?.id;
    if (!positiveId(id) || seen.has(id)) continue;
    seen.add(id);
    const found = gateCandidate(item, repo, pull, asOf);
    if (found && observation.pending.length < HEAD_GREEN_MAX_CANDIDATES) observation.pending.push(found);
  }
  observation.seenCheckIds = [...seen]; observation.history.pagesRead += 1; observation.history.nextPage += 1;
  observation.history.state = items.length < GITHUB_PAGE_SIZE ? "complete" : "partial";
  observation.history.reason = items.length < GITHUB_PAGE_SIZE ? null : "head-check-history-page-bound-or-pending";
  if (observation.firstObserved === null && observation.history.state === "complete" && observation.pending.length === 0) observation.state = "unavailable";
}

export function pullOf(item: unknown): GithubPull | null {
  const pr = record(item);
  const nodeId = text(pr?.node_id);
  if (pr === undefined || nodeId === null || !Number.isSafeInteger(pr.number)) return null;
  const head = record(pr.head);
  return {
    nodeId, number: pr.number as number, state: pr.state === "open" ? "open" : "closed",
    createdAt: iso(pr.created_at), updatedAt: iso(pr.updated_at), mergedAt: iso(pr.merged_at), closedAt: iso(pr.closed_at),
    headRef: text(head?.ref), headSha: text(head?.sha), mergeCommitSha: pr.merged_at ? text(pr.merge_commit_sha) : null,
    trailerTaskIds: trailerTaskIds(pr.body), revertsPr: revertedPrNumber(pr.body), authorClass: authorClassOf(pr.user),
    detail: { state: "pending" },
  };
}

export interface GithubDeployment {
  id: number;
  sha: string | null;
  createdAt: string | null;
  /** The newest deployment status. Only `success` is a deployment; creation alone is an attempt. */
  status: { state: string; at: string | null } | { state: "pending-read" } | { state: "unavailable"; reason: string };
}

export interface GithubCursor {
  state: "never-read" | "complete" | "partial" | "unavailable";
  reason: string | null;
  /** Newest item time a COMPLETED sweep reached; a later sweep stops once it pages past it. */
  watermark: string | null;
  sweepHigh: string | null;
  resumePage: number | null;
  pagesRead: number;
  asOf: string | null;
  /** A recent head read is separate from completion of the historical sweep. */
  head?: { state: "observed" | "unavailable"; asOf: string; reason: string | null };
}

function blankCursor(): GithubCursor {
  return { state: "never-read", reason: null, watermark: null, sweepHigh: null, resumePage: null, pagesRead: 0, asOf: null };
}

export interface GithubRepoStore {
  pulls: Record<string, GithubPull>;
  commits: Record<string, string>;
  deployments: Record<string, GithubDeployment>;
  cursors: { pulls: GithubCursor; commits: GithubCursor; deployments: GithubCursor };
  /** Rotate historical pages so a large resource cannot starve its siblings. */
  backfillResourceIndex?: number;
}

export function emptyRepoStore(): GithubRepoStore {
  return { pulls: {}, commits: {}, deployments: {},
    cursors: { pulls: blankCursor(), commits: blankCursor(), deployments: blankCursor() } };
}

export interface FieldTrialsGithubStore {
  version: typeof FIELD_TRIALS_GITHUB_VERSION;
  repos: Record<string, GithubRepoStore>;
}

/** A missing, damaged or foreign store is a full replay from page one, never a healthy empty history. */
export function parseGithubStore(value: unknown): FieldTrialsGithubStore {
  const store = record(value);
  const repos = record(store?.repos);
  if (store?.version !== FIELD_TRIALS_GITHUB_VERSION || repos === undefined
    || Object.values(repos).some((repo) => record(record(repo)?.cursors) === undefined)) {
    return { version: FIELD_TRIALS_GITHUB_VERSION, repos: {} };
  }
  return store as unknown as FieldTrialsGithubStore;
}

type Budget = { left: number };

function laterIso(a: string | null, b: string | null): string | null {
  return a === null ? b : b === null || a >= b ? a : b;
}

/** Read one newest-first page. Only completion advances the historical watermark. */
async function sweepListPage(fetch: GithubPageFetch, path: string, cursor: GithubCursor, budget: Budget, asOf: string,
  timeOf: (item: unknown) => string | null, upsert: (item: unknown) => void): Promise<void> {
  const page = cursor.resumePage ?? 1;
  if (budget.left <= 0) {
    Object.assign(cursor, { resumePage: page, state: "partial", reason: "page-budget-exhausted" });
    return;
  }
  budget.left -= 1;
  const result = await fetch(`${path}${path.includes("?") ? "&" : "?"}per_page=${GITHUB_PAGE_SIZE}&page=${page}`);
  if (!result.ok) {
    if (page === 1) cursor.head = { state: "unavailable", asOf, reason: result.reason };
    Object.assign(cursor, { resumePage: page, reason: result.reason,
      state: cursor.watermark === null && page === 1 ? "unavailable" : "partial" });
    return;
  }
  cursor.pagesRead += 1;
  if (page === 1) cursor.head = { state: "observed", asOf, reason: null };
  let reachedWatermark = false;
  for (const item of result.items) {
    const at = timeOf(item);
    cursor.sweepHigh = laterIso(cursor.sweepHigh, at);
    if (at !== null && cursor.watermark !== null && at <= cursor.watermark) reachedWatermark = true;
    upsert(item);
  }
  if (result.items.length < GITHUB_PAGE_SIZE || reachedWatermark) {
    Object.assign(cursor, { watermark: laterIso(cursor.watermark, cursor.sweepHigh), sweepHigh: null,
      resumePage: null, state: "complete", reason: null, asOf });
    return;
  }
  Object.assign(cursor, { resumePage: page + 1, state: "partial", reason: "page-budget-exhausted" });
}

async function readDetail(fetch: GithubPageFetch, repo: string, pull: GithubPull, budget: Budget,
  asOf: string): Promise<GithubPull["detail"] | null> {
  if (budget.left < 3) return null;
  budget.left -= 3;
  const reviews = await fetch(`repos/${repo}/pulls/${pull.number}/reviews?per_page=${GITHUB_PAGE_SIZE}`);
  const commits = await fetch(`repos/${repo}/pulls/${pull.number}/commits?per_page=${GITHUB_PAGE_SIZE}`);
  if (!reviews.ok) return { state: "unavailable", reason: reviews.reason };
  if (!commits.ok) return { state: "unavailable", reason: commits.reason };
  const firstSha = text(record(commits.items[0])?.sha);
  const last = record(record(record(commits.items.at(-1))?.commit)?.committer);
  const checks = firstSha === null ? { ok: false as const, reason: "no-commits-read" }
    : await fetch(`repos/${repo}/commits/${firstSha}/check-runs?filter=all&per_page=${GITHUB_PAGE_SIZE}`);
  const head = headObservation(pull);
  if (checks.ok && firstSha === pull.headSha && checks.items.length < GITHUB_PAGE_SIZE && head?.history.pagesRead === 0) {
    observeHeadCheckPage(head, checks.items, repo, pull, asOf);
  }
  const states = reviews.items.map((item) => record(item)?.state);
  return {
    state: "observed", readAt: asOf, readWhileOpen: pull.state === "open",
    reviews: { total: reviews.items.length, human: reviews.items.filter((item) => authorClassOf(record(item)?.user) === "human").length,
      changesRequested: states.filter((state) => state === "CHANGES_REQUESTED").length,
      approvals: states.filter((state) => state === "APPROVED").length, truncated: reviews.items.length >= GITHUB_PAGE_SIZE },
    commits: { count: commits.items.length, firstSha, lastCommittedAt: iso(last?.date), truncated: commits.items.length >= GITHUB_PAGE_SIZE },
    checks: checks.ok ? summarizeChecks(firstSha!, checks.items) : { state: "unavailable", reason: checks.reason },
  };
}

function needsDetail(pull: GithubPull): boolean {
  return pull.detail.state !== "observed" || pull.detail.readWhileOpen;
}

const TERMINAL_DEPLOYMENT_STATES = new Set(["success", "failure", "error", "inactive"]);

export interface FieldTrialsGithubRepoPass {
  pulls: GithubCursor;
  commits: GithubCursor;
  deployments: GithubCursor;
  detailsPending: number;
  detailsUnavailable: number;
  /** Counts over stored deployments; an unreadable deployment list is still unknown. */
  statusesPending?: number;
  statusesUnavailable?: number;
  headGreensPending?: number;
  headGreensUnavailable?: number;
}

async function ingestRepo(fetch: GithubPageFetch, repo: string, store: GithubRepoStore, budget: Budget,
  asOf: string): Promise<FieldTrialsGithubRepoPass> {
  const resources: Array<{ key: keyof GithubRepoStore["cursors"]; path: string;
    timeOf: (item: unknown) => string | null; upsert: (item: unknown) => void }> = [
    { key: "pulls", path: `repos/${repo}/pulls?state=all&sort=updated&direction=desc`,
      timeOf: (item) => iso(record(item)?.updated_at), upsert: (item) => {
        const pull = pullOf(item);
        if (pull === null) return;
        const prior = store.pulls[pull.nodeId];
        // An unchanged PR keeps its detail; an edit, rerun or late event bumps updated_at and re-reads it.
        const unchangedHead = prior?.headSha === pull.headSha;
        store.pulls[pull.nodeId] = prior && prior.updatedAt === pull.updatedAt && unchangedHead ? { ...pull, detail: prior.detail } : pull;
        if (unchangedHead && prior?.headGreen) store.pulls[pull.nodeId]!.headGreen = prior.headGreen;
    } },
    { key: "commits", path: `repos/${repo}/commits`,
      timeOf: (item) => iso(record(record(record(item)?.commit)?.committer)?.date), upsert: (item) => {
        const sha = text(record(item)?.sha);
        const at = iso(record(record(record(item)?.commit)?.committer)?.date);
        if (sha !== null && at !== null) store.commits[sha] = at;
    } },
    { key: "deployments", path: `repos/${repo}/deployments`,
      timeOf: (item) => iso(record(item)?.created_at), upsert: (item) => {
        const deployment = record(item);
        if (deployment === undefined || !Number.isSafeInteger(deployment.id)) return;
        const id = deployment.id as number;
        store.deployments[String(id)] = store.deployments[String(id)]
          ?? { id, sha: text(deployment.sha), createdAt: iso(deployment.created_at), status: { state: "pending-read" } };
    } },
  ];
  const blocked = new Set<string>();
  // Refresh page one without discarding a historical resume page or advancing its watermark.
  for (const resource of resources) {
    const cursor = store.cursors[resource.key];
    const resuming = (cursor.resumePage ?? 1) > 1;
    const head = resuming ? blankCursor() : cursor;
    await sweepListPage(fetch, resource.path, head, budget, asOf, resource.timeOf, resource.upsert);
    if (resuming) {
      cursor.pagesRead += head.pagesRead;
      cursor.sweepHigh = laterIso(cursor.sweepHigh, head.sweepHigh ?? head.watermark);
      if (head.head !== undefined) cursor.head = head.head;
      if (head.state === "unavailable") Object.assign(cursor, { state: "partial", reason: head.reason });
    }
    if (head.head?.state === "unavailable" && head.head.asOf === asOf) blocked.add(resource.key);
  }
  const detailCandidates = () => Object.values(store.pulls).filter(needsDetail)
    .sort((a, b) => Number(a.detail.state === "observed") - Number(b.detail.state === "observed")
      || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || b.number - a.number);
  const detailReserve = detailCandidates().length > 0 && budget.left >= 3 ? 3 : 0;
  const statusCandidates = () => Object.values(store.deployments).filter((deployment) => !TERMINAL_DEPLOYMENT_STATES.has(deployment.status.state))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id - a.id);
  const pendingStatuses = statusCandidates();
  const statusReserve = pendingStatuses.length > 0 && budget.left > detailReserve ? 1 : 0;
  const blockedHeads = new Set<string>();
  const headCandidates = () => Object.values(store.pulls).filter((pull) => {
    const observation = headObservation(pull);
    if (blockedHeads.has(pull.nodeId)) return false;
    if (observation !== null && observation.pending.length === 0 && observation.history.nextPage > HEAD_GREEN_MAX_PAGES) {
      if (observation.firstObserved === null) observation.state = "unavailable";
      return false;
    }
    return observation !== null && (observation.pending.length > 0 || (observation.history.state !== "complete" && observation.history.nextPage <= HEAD_GREEN_MAX_PAGES)
      || (pull.state === "open" && observation.firstObserved === null));
  }).sort((a, b) => Number((a.headGreen?.pending.length ?? 0) === 0) - Number((b.headGreen?.pending.length ?? 0) === 0)
    || (a.headGreen?.readAt ?? "").localeCompare(b.headGreen?.readAt ?? "") || b.number - a.number);
  const headReserve = headCandidates().length > 0 ? Math.min(3, Math.max(0, budget.left - detailReserve - statusReserve)) : 0;
  let next = Number.isInteger(store.backfillResourceIndex) ? (store.backfillResourceIndex ?? 0) % resources.length : 0;
  if (next < 0) next = 0;
  while (budget.left > detailReserve + statusReserve + headReserve) {
    let chosen = -1;
    for (let offset = 0; offset < resources.length; offset++) {
      const index = (next + offset) % resources.length;
      const resource = resources[index]!;
      if (!blocked.has(resource.key) && (store.cursors[resource.key].resumePage ?? 1) > 1) { chosen = index; break; }
    }
    if (chosen < 0) break;
    const resource = resources[chosen]!;
    const cursor = store.cursors[resource.key];
    await sweepListPage(fetch, resource.path, cursor, budget, asOf, resource.timeOf, resource.upsert);
    if (cursor.reason !== null && cursor.reason !== "page-budget-exhausted") blocked.add(resource.key);
    next = (chosen + 1) % resources.length;
    store.backfillResourceIndex = next;
  }
  for (const deployment of statusCandidates()) {
    if (budget.left <= detailReserve + headReserve) break;
    budget.left -= 1;
    const statuses = await fetch(`repos/${repo}/deployments/${deployment.id}/statuses?per_page=${GITHUB_PAGE_SIZE}`);
    const newest = statuses.ok ? record(statuses.items[0]) : undefined;
    deployment.status = !statuses.ok ? { state: "unavailable", reason: statuses.reason }
      : newest === undefined ? { state: "no-status", at: null } : { state: String(newest.state), at: iso(newest.created_at) };
  }
  const legacyBudget = { left: budget.left - headReserve };
  for (const pull of detailCandidates()) {
    const detail = await readDetail(fetch, repo, pull, legacyBudget, asOf);
    if (detail !== null) pull.detail = detail;
  }
  budget.left = legacyBudget.left + headReserve;
  for (let reads = 0; reads < headReserve && budget.left > 0; reads++) {
    const pull = headCandidates()[0];
    if (!pull) break;
    const observation = headObservation(pull)!;
    if (observation.history.state === "complete" && observation.pending.length === 0 && observation.firstObserved === null) {
      observation.history = { state: "pending", nextPage: 1, pagesRead: 0, reason: null }; observation.seenCheckIds = [];
    }
    const before = budget.left;
    if (!await readHeadGreen(fetch, repo, pull, budget, asOf)) blockedHeads.add(pull.nodeId);
    if (observation.pending.length === 0 && observation.firstObserved === null && observation.history.state === "complete") blockedHeads.add(pull.nodeId);
    if (before === budget.left) break;
  }
  const pulls = Object.values(store.pulls);
  return { pulls: { ...store.cursors.pulls }, commits: { ...store.cursors.commits }, deployments: { ...store.cursors.deployments },
    detailsPending: pulls.filter((pull) => pull.detail.state === "pending").length,
    detailsUnavailable: pulls.filter((pull) => pull.detail.state === "unavailable").length,
    statusesPending: Object.values(store.deployments).filter((item) => item.status.state === "pending-read").length,
    statusesUnavailable: Object.values(store.deployments).filter((item) => item.status.state === "unavailable").length,
    headGreensPending: pulls.filter((pull) => pull.headGreen?.state === "pending" || (pull.headGreen?.pending.length ?? 0) > 0).length,
    headGreensUnavailable: pulls.filter((pull) => pull.headGreen?.state === "unavailable").length };
}

export interface FieldTrialsGithubPass {
  state: "complete" | "partial" | "unavailable" | "skipped";
  asOf: string;
  pagesRead: number;
  /** Actual transport attempts, including failures; pagesRead counts successful pages only. */
  requestsMade?: number;
  repos: Record<string, FieldTrialsGithubRepoPass>;
}

/**
 * One resumable pass over every repository. The page budget is shared evenly, so one large
 * repository cannot starve the others. The store is mutated in place and returned with the pass.
 */
export async function ingestFieldTrialsGithub(fetch: GithubPageFetch, repos: readonly string[],
  store: FieldTrialsGithubStore, asOf: string, maxPages: number = DEFAULT_MAX_PAGES): Promise<FieldTrialsGithubPass> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 0) throw new RangeError("field-trials page budget must be a nonnegative safe integer");
  const pass: FieldTrialsGithubPass = { state: "complete", asOf, pagesRead: 0, requestsMade: 0, repos: {} };
  const share = Math.floor(maxPages / Math.max(1, repos.length));
  for (const [index, repo] of repos.entries()) {
    const repoStore = store.repos[repo] ??= emptyRepoStore();
    const budget = { left: share + (index < maxPages % Math.max(1, repos.length) ? 1 : 0) };
    let requests = 0;
    let pages = 0;
    const countedFetch: GithubPageFetch = async (path) => {
      requests += 1;
      const result = await fetch(path);
      if (result.ok) pages += 1;
      return result;
    };
    pass.repos[repo] = await ingestRepo(countedFetch, repo, repoStore, budget, asOf);
    const cursors = Object.values(repoStore.cursors);
    pass.pagesRead += pages;
    pass.requestsMade = (pass.requestsMade ?? 0) + requests;
    if (cursors.some((cursor) => cursor.state !== "complete") || pass.repos[repo].detailsPending > 0
      || (pass.repos[repo].statusesPending ?? 0) > 0 || (pass.repos[repo].headGreensPending ?? 0) > 0) pass.state = "partial";
  }
  if (repos.length > 0 && Object.values(pass.repos).every((repo) => repo.pulls.state === "unavailable")) pass.state = "unavailable";
  return pass;
}
