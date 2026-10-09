import { extractTaskTrailerId } from "./review.js";
import { taskIdFromRunBranch } from "./status.js";
import { ghJson } from "./github-transport.js";

export interface HeadRehomePr {
  prNumber: number;
  prUrl: string;
  headSha: string;
  headRefName?: string;
  checksState: string;
  reviewState: string;
  redRequiredChecks?: readonly string[];
  ciFailures?: readonly { name: string; sha?: string }[];
  mergeState?: string;
  isDraft?: boolean;
}

export interface HeadRehomeObservation extends HeadRehomePr {
  state: string;
  title: string;
  body: string;
  baseRef?: string;
  changedFiles?: readonly string[];
  commitMessages: readonly string[];
  activity: readonly { committedAt: string; author?: string }[];
  updatedAt?: string;
  pendingChecks?: readonly string[];
  sameRepository?: boolean;
}

export interface QuietHeadDecision { quiet: boolean; reason: string }
export interface HeadRehomeAction { action: "rehome"; headName: string; headSha: string; reason: string }
export type HeadRehomePlan = HeadRehomeAction | { action: "none" | "refused"; reason: string; needsQuietJudgment?: boolean };
export interface ReplacementPr { prNumber: number; prUrl: string; headSha: string }

export function headIdentityRed(pr: HeadRehomePr): boolean {
  return [...(pr.redRequiredChecks ?? []), ...(pr.ciFailures ?? []).map(f => f.name)].includes("head-identity-gate");
}

export function headRehomePlan(pr: HeadRehomePr, deps: {
  conformingHead: boolean;
  observation: HeadRehomeObservation;
  quiet?: QuietHeadDecision;
  nowMs: number;
}): HeadRehomePlan {
  const live = deps.observation;
  if (deps.conformingHead || !headIdentityRed(pr)) return { action: "none", reason: "head needs no branch repair" };
  if (live.headSha !== pr.headSha || live.headRefName !== pr.headRefName) return { action: "refused", reason: "head moved" };
  if (live.state !== "open" || live.isDraft || live.mergeState === "dirty" || live.sameRepository === false) {
    return { action: "refused", reason: "PR is closed, draft, conflicted or from a fork" };
  }
  const reds = new Set([...(live.redRequiredChecks ?? []), ...(live.ciFailures ?? []).map(f => f.name)]);
  if (!reds.has("head-identity-gate") || [...reds].some(name => name !== "head-identity-gate" && name !== "ci-gate") ||
      live.reviewState === "failure" || live.ciFailures?.some(f => f.sha !== undefined && f.sha !== pr.headSha)) {
    return { action: "refused", reason: "other reds present or identity red no longer at this head" };
  }
  if (live.pendingChecks?.length) return { action: "refused", reason: `checks unfinished: ${live.pendingChecks.join(", ")}` };
  if (!live.changedFiles?.length) return { action: "refused", reason: "diff unreadable or empty" };
  if (!live.commitMessages.length) return { action: "refused", reason: "head commits unreadable" };
  if (extractTaskTrailerId(live.commitMessages.at(-1)!) !== undefined) return { action: "none", reason: "head commit already has a task trailer" };
  if (!deps.quiet?.quiet) return { action: "refused", reason: `quietness not established: ${deps.quiet?.reason ?? "no judgment"}`,
    needsQuietJudgment: deps.quiet === undefined };
  const trailered = new Set(live.commitMessages.map(extractTaskTrailerId).filter((id): id is string => id !== undefined));
  const mentioned = new Set(live.commitMessages.flatMap(message => message.match(/\bW\d+-T\d+\b/g) ?? []));
  const ids = trailered.size ? trailered : mentioned;
  const taskId = ids.size === 1 ? [...ids][0] : undefined;
  if (taskId !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(taskId) || taskIdFromRunBranch(`run-${taskId}-1`) !== taskId)) {
    return { action: "refused", reason: "task identity cannot form a branch" };
  }
  return { action: "rehome", headName: `run-${taskId ?? "unfiled"}-${deps.nowMs}`, headSha: pr.headSha,
    reason: `head-identity-only red; ${deps.quiet.reason}` };
}

export interface HeadRehomePorts {
  observe: (pr: HeadRehomePr) => Promise<HeadRehomeObservation>;
  judgeQuiet: (pr: HeadRehomeObservation) => Promise<QuietHeadDecision>;
  ensureBranch: (headName: string, sha: string) => Promise<void>;
  findReplacement: (pr: HeadRehomePr, headName: string) => Promise<ReplacementPr | undefined>;
  openReplacement: (pr: HeadRehomeObservation, plan: HeadRehomeAction, body: string) => Promise<ReplacementPr>;
  readHead: (pr: HeadRehomePr) => Promise<string>;
  closeOriginal: (pr: HeadRehomePr, replacement: ReplacementPr) => Promise<void>;
}

export function rehomeBody(pr: HeadRehomeObservation): string {
  const backlink = `Rehomed from ${pr.prUrl} (head-identity-gate).`;
  const trailer = /^Remudero-Task:[^\n]*\s*$/.exec(pr.body.split("\n").at(-1) ?? "");
  return trailer ? `${pr.body.slice(0, pr.body.lastIndexOf(trailer[0])).trimEnd()}\n\n${backlink}\n\n${trailer[0]}`
    : `${pr.body}\n\n${backlink}`;
}

export function createHeadRehomePorts(opts: {
  owner: string; repo: string;
  judgeQuiet: HeadRehomePorts["judgeQuiet"];
  readJson?: (args: string[]) => unknown;
  latestChecks?: <T extends { name?: string; context?: string }>(checks: readonly T[]) => T[];
  requiredChecks?: readonly string[];
}): HeadRehomePorts {
  const api = opts.readJson ?? ghJson;
  const root = `repos/${opts.owner}/${opts.repo}`;
  const pull = (pr: HeadRehomePr) => api(["api", `${root}/pulls/${pr.prNumber}`]) as {
    state: string; draft: boolean; title: string; body: string | null; updated_at: string;
    changed_files: number; commits: number; mergeable_state: string;
    head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { ref: string };
  };
  return {
    judgeQuiet: opts.judgeQuiet,
    observe: async (pr) => {
      const live = pull(pr);
      const commits = (api(["api", "--paginate", "--slurp", `${root}/pulls/${pr.prNumber}/commits?per_page=100`]) as
        { commit: { message: string; committer: { date: string } }; author: { login: string } | null }[][]).flat();
      const files = (api(["api", "--paginate", "--slurp", `${root}/pulls/${pr.prNumber}/files?per_page=100`]) as { filename: string }[][]).flat();
      const checks = api(["pr", "view", pr.prUrl, "--json", "headRefOid,statusCheckRollup"]) as {
        headRefOid: string; statusCheckRollup: { name?: string; context?: string; conclusion?: string; state?: string; status?: string; startedAt?: string }[];
      };
      if (checks.headRefOid !== live.head.sha) throw new Error("head moved while reading checks");
      const protection = api(["api", `${root}/branches/${encodeURIComponent(live.base.ref)}/protection/required_status_checks`]) as {
        contexts: string[]; checks?: { context: string }[];
      };
      const required = new Set(["head-identity-gate", "ci-gate", ...protection.contexts,
        ...(protection.checks ?? []).map(c => c.context), ...(opts.requiredChecks ?? [])]);
      const latest = (opts.latestChecks ? opts.latestChecks(checks.statusCheckRollup) : checks.statusCheckRollup)
        .filter(c => required.has(c.name ?? c.context ?? ""));
      const bad = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"];
      const failures = latest.filter(c => bad.includes(c.conclusion || c.state || c.status || ""));
      const pending = latest.filter(c => !["SUCCESS", "NEUTRAL", "SKIPPED", ...bad].includes(c.conclusion || c.state || c.status || ""));
      return { ...pr, state: live.state, headSha: live.head.sha, headRefName: live.head.ref,
        isDraft: live.draft, mergeState: live.mergeable_state, title: live.title, body: live.body ?? "",
        baseRef: live.base.ref, updatedAt: live.updated_at, sameRepository: live.head.repo?.full_name === `${opts.owner}/${opts.repo}`,
        changedFiles: files.length === live.changed_files ? files.map(f => f.filename) : undefined,
        commitMessages: commits.length === live.commits ? commits.map(c => c.commit.message) : [],
        activity: commits.map(c => ({ committedAt: c.commit.committer.date, author: c.author?.login })),
        ciFailures: failures.map(c => ({ name: c.name ?? c.context ?? "unknown", sha: live.head.sha })),
        redRequiredChecks: [], pendingChecks: [...pending.map(c => c.name ?? c.context ?? "unknown"),
          ...[...required].filter(name => !latest.some(c => (c.name ?? c.context) === name))].filter(name => name !== "remudero-review") };
    },
    ensureBranch: async (headName, sha) => {
      const refs = (api(["api", `${root}/git/matching-refs/heads/${headName}`]) as { ref: string; object: { sha: string } }[])
        .filter(ref => ref.ref === `refs/heads/${headName}`);
      if (refs.length) {
        if (refs[0].object.sha !== sha) throw new Error("replacement branch points to another head");
        return;
      }
      api(["api", "-X", "POST", `${root}/git/refs`, "-f", `ref=refs/heads/${headName}`, "-f", `sha=${sha}`]);
    },
    findReplacement: async (pr, headName) => {
      const prs = api(["api", `${root}/pulls?state=all&head=${opts.owner}:${headName}`]) as
        { number: number; html_url: string; body: string; state: string; head: { sha: string } }[];
      if (!prs.length) return undefined;
      const existing = prs.find(row => row.body?.includes(`Rehomed from ${pr.prUrl} (head-identity-gate).`));
      if (!existing || existing.head.sha !== pr.headSha || existing.state !== "open") throw new Error("replacement PR does not match open source head and backlink");
      return { prNumber: existing.number, prUrl: existing.html_url, headSha: existing.head.sha };
    },
    openReplacement: async (pr, plan, body) => {
      const created = api(["api", "-X", "POST", `${root}/pulls`, "-f", `head=${plan.headName}`, "-f", `base=${pr.baseRef ?? "main"}`,
        "-f", `title=${pr.title}`, "-f", `body=${body}`]) as { number: number; html_url: string; head: { sha: string } };
      return { prNumber: created.number, prUrl: created.html_url, headSha: created.head.sha };
    },
    readHead: async (pr) => {
      const live = pull(pr);
      if (live.state !== "open" || live.draft || live.head.ref !== pr.headRefName) throw new Error("source PR no longer open on its observed branch");
      return live.head.sha;
    },
    closeOriginal: async (pr, replacement) => {
      api(["api", "-X", "POST", `${root}/issues/${pr.prNumber}/comments`, "-f", `body=Rehomed by rmd sweep to ${replacement.prUrl}; same head ${pr.headSha}.`]);
      api(["api", "-X", "PATCH", `${root}/pulls/${pr.prNumber}`, "-f", "state=closed"]);
    },
  };
}
