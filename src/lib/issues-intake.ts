import { execFileSync } from "node:child_process";
import { appendLedger } from "./ledger.js";
import { captureFeedback, feedbackEntryPath, type FeedbackEntry } from "./feedback.js";
import { existsSync } from "node:fs";
import type { ManagedRepo } from "./managed-repos.js";

/**
 * Issues intake (W1-T57, MASTER-PLAN §5D lane 3).
 *
 * "Open issues on repos the harness MANAGES become feedback so 'issues reviewed regularly' is a
 * LEDGERED fact, not an intention." This module is the read side: it polls open issues (via
 * `gh api`, never Octokit — matches ops.ts/escalate.ts/status.ts) for every repo named in
 * `.remudero/managed-repos.json` (lib/managed-repos.ts), turns each into a `plan/feedback/<id>.yaml`
 * entry with `origin: issue#<n>` (lib/feedback.ts), and folds a reviewed-count block into the
 * daily digest (digest.ts).
 *
 * SCOPE FENCE (mirrors ops.ts's P20 fence): this module only READS GitHub issues and WRITES
 * `plan/feedback/` entries. It never comments on, labels, or closes an issue, and never opens a
 * fix PR itself — turning a feedback entry into a corrective task is `rmd triage` (W1-T41),
 * already shipped and origin-agnostic (it reads `plan/feedback/<id>.yaml` regardless of which
 * origin produced it), so no source-specific triage logic is needed here. "One inbox, one triage
 * discipline, whatever the source" (MASTER-PLAN §5D).
 *
 * DEDUP (mirrors ops.ts's ledger-keyed idempotence, itself mirroring sweep.ts, W1-T77): a re-poll
 * of the SAME open issues must create NOTHING new. Rather than a second dedup store, each issue's
 * feedback id is DETERMINISTIC ({@link issueFeedbackId}) — `existsSync` on that one path IS the
 * dedup check, so a prior run's entry is directly visible to the next one with no extra bookkeeping.
 *
 * remudero's OWN public issues stay OFF this lane until WS-4 (G-6, operator standing decision) —
 * enforced simply by NOT listing this repo in `.remudero/managed-repos.json`, not by code here.
 */

// ── Issues, normalized across the one GitHub issues-list API ───────────────

/** One open issue, normalized to the shape this module reasons over. */
export interface RawIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  createdAt: string;
  url: string;
  labels: string[];
}

/**
 * `fb-issue-<owner>-<repo>-<n>` — the feedback entry's id AND the dedup key. Owner/repo are
 * slugged (lowercased, non-alnum collapsed to `-`) so the id is a safe filename regardless of
 * what characters GitHub allows in an org/repo name.
 */
export function issueFeedbackId(owner: string, repo: string, number: number): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `fb-issue-${slug(owner)}-${slug(repo)}-${number}`;
}

// ── Normalizer: GitHub's issues-list response shape → RawIssue ─────────────

interface GhIssueJson {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  created_at?: string;
  html_url?: string;
  labels?: Array<string | { name?: string }>;
  /**
   * GitHub's issues-list endpoint returns PULL REQUESTS too — every PR is also an "issue" in
   * their data model. Presence of this key (regardless of value) is the documented way to tell
   * them apart; only entries WITHOUT it are real issues.
   */
  pull_request?: unknown;
}

export function normalizeIssue(owner: string, repo: string, raw: GhIssueJson): RawIssue {
  return {
    owner,
    repo,
    number: raw.number ?? 0,
    title: raw.title ?? "(untitled)",
    body: raw.body ?? "",
    state: raw.state ?? "unknown",
    createdAt: raw.created_at ?? "",
    url: raw.html_url ?? "",
    labels: (raw.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter((l) => l.length > 0),
  };
}

// ── Gateway: `gh api`, fail-soft (an unreadable/forbidden repo ⇒ zero issues) ──

export interface IssueListGateway {
  list(owner: string, repo: string): RawIssue[];
}

/**
 * Real gateway: `gh api repos/<owner>/<repo>/issues?state=open --paginate`, filtered to drop
 * pull requests. Wrapped in try/catch so ONE unreadable/forbidden managed repo (wrong token
 * scope, repo renamed/deleted, `gh` itself erroring) degrades only that repo to `[]` — mirrors
 * ghAlertGateway's per-source fail-soft discipline, never crashes the whole poll.
 */
export function ghIssueListGateway(): IssueListGateway {
  return {
    list(owner, repo) {
      try {
        const raw = execFileSync("gh", ["api", `repos/${owner}/${repo}/issues?state=open`, "--paginate"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const parsed = JSON.parse(raw) as unknown;
        const arr = Array.isArray(parsed) ? (parsed as GhIssueJson[]) : [];
        return arr.filter((i) => i.pull_request === undefined).map((i) => normalizeIssue(owner, repo, i));
      } catch {
        return [];
      }
    },
  };
}

// ── Render: one plan/feedback/<id>.yaml `raw` body per issue ───────────────

export function renderIssueRaw(issue: RawIssue): string {
  const labels = issue.labels.length ? ` [${issue.labels.join(", ")}]` : "";
  return `${issue.owner}/${issue.repo}#${issue.number}: ${issue.title}${labels}\n\n${issue.body}\n\n${issue.url}`.trim();
}

// ── The digest's issues-reviewed block ──────────────────────────────────────

export interface IssuesPollSummary {
  /** When this poll ran — the digest shows the LATEST such snapshot inside its window. */
  polledAt: string;
  /** `owner/repo` strings polled this run — empty when no repo is managed yet. */
  repos: string[];
  /** Total OPEN issues seen across every managed repo this poll — the "issues reviewed" count. */
  reviewedCount: number;
  /** New `plan/feedback/` entries created this poll (dedup already applied). */
  createdCount: number;
}

/** One-line render of an {@link IssuesPollSummary} — what the digest prints. */
export function renderIssuesSummary(s: IssuesPollSummary): string {
  if (s.repos.length === 0) return "(no managed repos configured)";
  return `${s.reviewedCount} open across ${s.repos.length} managed repo(s) (${s.createdCount} new)`;
}

// ── The poll entry point: fetch → create feedback entries (deduped) → ledger ──

export interface IssuesIntakeDeps {
  issues: IssueListGateway;
  /** Repo root `plan/feedback/` is written under — the harness's OWN checked-out repo. */
  root: string;
  ledgerPath: string;
  runId: string;
  now?: () => number;
  /** Preview only: fetch + summarize, create NOTHING, write no ledger line. Mirrors rmd ops --dry-run. */
  dryRun?: boolean;
}

export interface IssuesIntakeResult {
  summary: IssuesPollSummary;
  /** Open issues with NO existing feedback entry (dedup already applied) — populated even under --dry-run, as a preview. */
  newIssues: RawIssue[];
  /** Feedback entries actually created this poll — always `[]` under --dry-run. */
  created: FeedbackEntry[];
  /** Open issues that already had a feedback entry from a prior poll (dedup skips). */
  skippedExisting: number;
}

/**
 * Fetch open issues for every managed repo, create a `plan/feedback/` entry (origin: `issue#<n>`)
 * for each one not already captured, and ledger ONE `issues.polled` line (digest.ts reads the
 * latest such line inside its window) carrying the full {@link IssuesPollSummary} — skipped under
 * `dryRun`, matching ops.ts's "a preview must leave no trace" discipline. The dedup check itself
 * ({@link issueFeedbackId} + `existsSync`) is a plain filesystem READ, so it always runs — a
 * `--dry-run` preview accurately reports which issues WOULD create a new entry, same as `rmd ops
 * --dry-run` previews which alerts would escalate.
 */
export async function pollIssues(managedRepos: ManagedRepo[], deps: IssuesIntakeDeps): Promise<IssuesIntakeResult> {
  const now = deps.now ? deps.now() : Date.now();

  const open = managedRepos.flatMap(({ owner, repo }) => deps.issues.list(owner, repo).filter((i) => i.state === "open"));

  const newIssues: RawIssue[] = [];
  let skippedExisting = 0;
  for (const issue of open) {
    const id = issueFeedbackId(issue.owner, issue.repo, issue.number);
    if (existsSync(feedbackEntryPath(deps.root, id))) {
      skippedExisting++;
    } else {
      newIssues.push(issue);
    }
  }

  const created: FeedbackEntry[] = [];
  if (!deps.dryRun) {
    for (const issue of newIssues) {
      const id = issueFeedbackId(issue.owner, issue.repo, issue.number);
      created.push(
        captureFeedback(deps.root, {
          id,
          raw: renderIssueRaw(issue),
          origin: `issue#${issue.number}`,
        }),
      );
    }
  }

  const summary: IssuesPollSummary = {
    polledAt: new Date(now).toISOString(),
    repos: managedRepos.map((r) => `${r.owner}/${r.repo}`),
    reviewedCount: open.length,
    createdCount: created.length,
  };

  if (!deps.dryRun) {
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: "ISSUES",
      step: "issues.polled",
      issues: summary,
      skipped_existing: skippedExisting,
    });
  }

  return { summary, newIssues, created, skippedExisting };
}
