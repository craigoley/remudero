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
import { ghTextAsync } from "./github-transport.js";

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
  const items = Array.isArray(parsed) ? parsed : record(parsed)?.check_runs;
  return Array.isArray(items) ? { ok: true, items } : { ok: false, reason: "github-page-not-a-list" };
}

/** The default seam: `gh api <path>` through the paced, bounded GitHub transport. A failed or refused
 *  read is a reason, never a throw, so the pass records where to resume. */
export function ghApiFetch(read: (args: string[]) => Promise<string> = (args) => ghTextAsync(args, { maxBuffer: GH_MAX_BUFFER_BYTES })): GithubPageFetch {
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
}

function blankCursor(): GithubCursor {
  return { state: "never-read", reason: null, watermark: null, sweepHigh: null, resumePage: null, pagesRead: 0, asOf: null };
}

export interface GithubRepoStore {
  pulls: Record<string, GithubPull>;
  commits: Record<string, string>;
  deployments: Record<string, GithubDeployment>;
  cursors: { pulls: GithubCursor; commits: GithubCursor; deployments: GithubCursor };
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

/** Sweep one newest-first list. The watermark moves only when a sweep completes; a stop records its page. */
async function sweepList(fetch: GithubPageFetch, path: string, cursor: GithubCursor, budget: Budget, asOf: string,
  timeOf: (item: unknown) => string | null, upsert: (item: unknown) => void): Promise<void> {
  let page = cursor.resumePage ?? 1;
  for (;;) {
    if (budget.left <= 0) {
      Object.assign(cursor, { resumePage: page, state: "partial", reason: "page-budget-exhausted" });
      return;
    }
    budget.left -= 1;
    const result = await fetch(`${path}${path.includes("?") ? "&" : "?"}per_page=${GITHUB_PAGE_SIZE}&page=${page}`);
    if (!result.ok) {
      Object.assign(cursor, { resumePage: page, reason: result.reason,
        state: cursor.watermark === null && page === 1 ? "unavailable" : "partial" });
      return;
    }
    cursor.pagesRead += 1;
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
    page += 1;
  }
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
    : await fetch(`repos/${repo}/commits/${firstSha}/check-runs?per_page=${GITHUB_PAGE_SIZE}`);
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
}

async function ingestRepo(fetch: GithubPageFetch, repo: string, store: GithubRepoStore, budget: Budget,
  asOf: string): Promise<FieldTrialsGithubRepoPass> {
  await sweepList(fetch, `repos/${repo}/pulls?state=all&sort=updated&direction=desc`, store.cursors.pulls, budget, asOf,
    (item) => iso(record(item)?.updated_at), (item) => {
      const pull = pullOf(item);
      if (pull === null) return;
      const prior = store.pulls[pull.nodeId];
      // An unchanged PR keeps its detail; an edit, rerun or late event bumps updated_at and re-reads it.
      store.pulls[pull.nodeId] = prior && prior.updatedAt === pull.updatedAt ? { ...pull, detail: prior.detail } : pull;
    });
  await sweepList(fetch, `repos/${repo}/commits`, store.cursors.commits, budget, asOf,
    (item) => iso(record(record(record(item)?.commit)?.committer)?.date), (item) => {
      const sha = text(record(item)?.sha);
      const at = iso(record(record(record(item)?.commit)?.committer)?.date);
      if (sha !== null && at !== null) store.commits[sha] = at;
    });
  await sweepList(fetch, `repos/${repo}/deployments`, store.cursors.deployments, budget, asOf,
    (item) => iso(record(item)?.created_at), (item) => {
      const deployment = record(item);
      if (deployment === undefined || !Number.isSafeInteger(deployment.id)) return;
      const id = deployment.id as number;
      store.deployments[String(id)] = store.deployments[String(id)]
        ?? { id, sha: text(deployment.sha), createdAt: iso(deployment.created_at), status: { state: "pending-read" } };
    });
  for (const deployment of Object.values(store.deployments)) {
    if (TERMINAL_DEPLOYMENT_STATES.has(deployment.status.state) || budget.left <= 0) continue;
    budget.left -= 1;
    const statuses = await fetch(`repos/${repo}/deployments/${deployment.id}/statuses?per_page=${GITHUB_PAGE_SIZE}`);
    const newest = statuses.ok ? record(statuses.items[0]) : undefined;
    deployment.status = !statuses.ok ? { state: "unavailable", reason: statuses.reason }
      : newest === undefined ? { state: "no-status", at: null } : { state: String(newest.state), at: iso(newest.created_at) };
  }
  for (const pull of Object.values(store.pulls).filter(needsDetail).sort((a, b) => a.number - b.number)) {
    const detail = await readDetail(fetch, repo, pull, budget, asOf);
    if (detail !== null) pull.detail = detail;
  }
  const pulls = Object.values(store.pulls);
  return { pulls: { ...store.cursors.pulls }, commits: { ...store.cursors.commits }, deployments: { ...store.cursors.deployments },
    detailsPending: pulls.filter((pull) => pull.detail.state === "pending").length,
    detailsUnavailable: pulls.filter((pull) => pull.detail.state === "unavailable").length };
}

export interface FieldTrialsGithubPass {
  state: "complete" | "partial" | "unavailable" | "skipped";
  asOf: string;
  pagesRead: number;
  repos: Record<string, FieldTrialsGithubRepoPass>;
}

/**
 * One resumable pass over every repository. The page budget is shared evenly, so one large
 * repository cannot starve the others. The store is mutated in place and returned with the pass.
 */
export async function ingestFieldTrialsGithub(fetch: GithubPageFetch, repos: readonly string[],
  store: FieldTrialsGithubStore, asOf: string, maxPages: number = DEFAULT_MAX_PAGES): Promise<FieldTrialsGithubPass> {
  const pass: FieldTrialsGithubPass = { state: "complete", asOf, pagesRead: 0, repos: {} };
  const share = Math.max(1, Math.floor(maxPages / Math.max(1, repos.length)));
  for (const repo of repos) {
    const repoStore = store.repos[repo] ??= emptyRepoStore();
    const budget = { left: share };
    const before = ["pulls", "commits", "deployments"].reduce((sum, key) =>
      sum + repoStore.cursors[key as keyof GithubRepoStore["cursors"]].pagesRead, 0);
    pass.repos[repo] = await ingestRepo(fetch, repo, repoStore, budget, asOf);
    const cursors = Object.values(repoStore.cursors);
    pass.pagesRead += cursors.reduce((sum, cursor) => sum + cursor.pagesRead, 0) - before;
    if (cursors.some((cursor) => cursor.state !== "complete") || pass.repos[repo].detailsPending > 0) pass.state = "partial";
  }
  if (repos.length > 0 && Object.values(pass.repos).every((repo) => repo.pulls.state === "unavailable")) pass.state = "unavailable";
  return pass;
}
