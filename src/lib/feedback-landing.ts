/**
 * lib/feedback-landing.ts — the durable-inbox commit bridge (W1-T243).
 *
 * `captureFeedback()` (feedback.ts) only writes to the calling checkout's filesystem, so `rmd
 * triage` — which reads a fresh origin/main worktree — cannot see an entry until something
 * commits it there. {@link landFeedback} is that one choke point every capture call inherits.
 *
 * Best-effort, never throws: the local write already satisfies durability the moment it lands on
 * disk; landing only gets it onto origin/main sooner. A failure here (offline, no `gh`) is
 * swallowed, and a later capture retries what's unlanded.
 *
 * Never touches the caller's index or local branches (the W1-T60 rule): it commits against a
 * scratch index rebuilt fresh from origin/main's tip, force-pushes one shared branch, and opens
 * or reuses one gated PR — never a direct push to main.
 * Why: the full precedent this replaced is archived in docs/forensics/feedback-landing.md#module-header.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ghExec } from "./github-transport.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { assertLiveWriteAllowed } from "./live-write-guard.js";
import { loadPlanFromYaml } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { slug as kebabSlug } from "./feedback-docket.js";
import { mergeFeedbackRecord } from "./feedback-record-merge.js";

/**
 * Mirrors measurement-cadence.ts's `CiLearningShardDraft`/`CiLearningFiledShard`/
 * `CiLearningFilingResult`, defined LOCALLY rather than imported (W1-T3492): measurement-cadence.ts
 * already reaches this module via `task-linter -> plan-architect -> escalate -> feedback ->
 * feedback-landing`, so importing it here — even `import type` — closes that chain into the cycle
 * `.dependency-cruiser.cjs`'s `no-circular` rule holds at zero. Structural typing keeps every real
 * caller (run-task.ts, which imports both modules) type-compatible with no cast at the call site.
 */
export interface CiLearningShardDraft {
  findingId: string;
  title: string;
  gate: string;
  pr: number;
  prs: number[];
  repairFiles: string[];
  dominantRepairFiles: { file: string; prs: number }[];
  action?: "gate" | "docs" | "build" | "unclear";
  author_class: "machine";
  verify: "human";
  remedySurface: string;
}

export interface CiLearningFiledShard {
  relPath: string;
  taskId: string;
  findingId: string;
}

export interface CiLearningFilingResult {
  filed: CiLearningFiledShard[];
  skipped: string[];
  refused: { findingId: string; reason: string }[];
}

const FEEDBACK_REL_DIR = "plan/feedback";

/** The one shared branch every landing call force-pushes to (never a per-capture branch — no PR spam). */
export const LANDING_BRANCH = "feedback-landing";
/** The one shared PR title/head every landing call opens or reuses. */
export const LANDING_PR_TITLE = "chore(feedback): land pending filings";

/**
 * `plan/decisions.d` — the decision-record sibling of `plan/feedback` (W1-T191). One file per
 * resolution, never a shared growing log — sharding rules out the git append-conflict two
 * concurrent `run-task` orchestrators would hit on one shared file.
 * Why: docs/forensics/feedback-landing.md#decisions_rel_dir.
 */
const DECISIONS_REL_DIR = "plan/decisions.d";
/** The one shared branch every decision-record landing call force-pushes to. */
export const DECISIONS_LANDING_BRANCH = "decisions-landing";
/** The one shared PR title/head every decision-record landing call opens or reuses. */
export const DECISIONS_LANDING_PR_TITLE = "chore(decisions): land pending decision records";
const PLAN_RECONCILE_LANDING_BRANCH = "plan-reconcile-landing";
const PLAN_RECONCILE_LANDING_PR_TITLE = "chore(plan): reconcile credited task statuses";
const CI_LEARNING_PENDING_REL_DIR = "state/ci-learning-pending";
const CI_LEARNING_SLUG_MAX = 72;
/** The one shared branch every automated CI-learning shard landing call force-pushes to. */
export const CI_LEARNING_LANDING_BRANCH = "ci-learning-landing";
/** The one shared PR title/head every automated CI-learning shard landing call opens or reuses. */
export const CI_LEARNING_LANDING_PR_TITLE = "chore(ci-learning): land pending lessons";

const LANDING_AUTHOR_NAME = "remudero-fleet[bot]";
const LANDING_AUTHOR_EMAIL = "318611788+remudero-fleet[bot]@users.noreply.github.com";

type GitExec = (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => string;
type GhExec = (args: string[]) => string;
export type LandingReviewRequest = (prUrl: string) => void | Promise<void>;

export interface LandingRepository {
  owner: string;
  repo: string;
}

type LandingFamily = "feedback" | "decisions" | "ci-learning" | "plan-reconcile";

export interface LandingIdentityInput {
  family?: LandingFamily;
  targetRepository?: LandingRepository;
  sourceRepository?: LandingRepository;
  landingOwner?: string;
}

export interface LandingIdentity {
  branch: string;
  prHead: string;
  ownedDir: string;
  prTitle: string;
  targetRepository?: LandingRepository;
  landingOwner?: string;
}

export interface LandFeedbackOpts {
  /** Injectable `git` exec — real callers omit it; tests can force specific failure paths. */
  git?: GitExec;
  /**
   * Injectable `gh` exec (the `ghGateway` pattern, lib/status.ts) — real callers omit it; tests
   * inject a fake so PR open/list/merge never hits real GitHub.
   */
  gh?: GhExec;
  /**
   * Legacy compatibility seam retained for callers that already pass the daemon ledger reader.
   * Review and auto-merge are now owned by the shared post-review sweep; this bridge never uses
   * the reader to arm a fresh PR before review.
   */
  ledgerLines?: () => Array<Record<string, unknown>>;
  /** Repository the landing PR is opened against. Omitted: resolved from this checkout's origin. */
  targetRepository?: LandingRepository;
  /**
   * Stable owner for this landing writer, e.g. a daemon instance/state owner. Omitted keeps the
   * existing self/core branch names unless the target repo is visibly not this source repo.
   */
  landingOwner?: string;
  /** Test seam for preserving the self/core identity without reading the caller's cwd. */
  sourceRepository?: LandingRepository;
  requestReview?: LandingReviewRequest;
}

export interface LandFeedbackResult {
  /** True iff the content is on the landing branch, pushed now or by an earlier call — rendered
   *  to an operator as "landed" vs "landing pending". Awaiting-gate content still counts. */
  landed: boolean;
  /** Repo-relative, forward-slash paths landed this call (empty when `landed` is false). */
  files: string[];
  /** The landing PR url, when known (freshly opened, or an already-open one reused). */
  prUrl?: string;
  /** Set only when landing was attempted but failed — never thrown, always swallowed by the caller. */
  error?: string;
  /**
   * True iff THIS call actually force-pushed the branch. False for every no-op path, including
   * the already-landed short-circuit ({@link finishLanding}). {@link sweepFeedbackLanding} logs
   * an acting pass (true) in detail and a quiet one (false) as a summary only.
   * Why: docs/forensics/feedback-landing.md#landfeedbackresult_pushed.
   */
  pushed?: boolean;
  /** Present only when this call removed redundant, untracked queue copies once fetched
   *  origin/main proved their bytes durable at the same paths. `paths` is bounded. */
  acknowledgement?: {
    count: number;
    paths: string[];
    truncated: boolean;
  };
  /** Present only when this call REFUSED to stage one or more feedback records because the local
   *  copy sat at an earlier §7B lifecycle position than `origin/main`'s (W1-T3561) — never
   *  silently dropped. A refused record is excluded from `files`/the pushed tree entirely, so it
   *  can never ride into an armed auto-merge PR by construction. */
  refused?: FeedbackRefusal[];
}

const ACKNOWLEDGEMENT_PATH_LIMIT = 50;

function defaultGit(root: string): GitExec {
  return (args, opts) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? process.env,
    });
}

function defaultGh(): GhExec {
  return (args) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Remove only redundant untracked queue copies whose exact bytes are already readable from
 *  fetched origin/main. Every comparison is independent, so one bad path never suppresses the rest. */
function acknowledgeLandedQueueCopies(
  root: string,
  kind: LandingKind,
  git: GitExec,
): LandFeedbackResult["acknowledgement"] {
  let untracked: string[];
  try {
    untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", kind.ownedDir])
      .split("\0")
      .filter(Boolean)
      .sort();
  } catch {
    // A failed enumeration and an empty inbox both mean nothing to acknowledge.
    return undefined;
  }

  const acknowledged: string[] = [];
  for (const rel of untracked) {
    try {
      // Re-check immediately before the destructive step — another actor may have tracked it since.
      if (git(["ls-files", "--", rel]).trim() !== "") continue;
      const remoteSha = git(["rev-parse", `origin/main:${rel}`]).trim();
      git(["cat-file", "-e", `${remoteSha}^{blob}`]);
      const localSha = git(["hash-object", join(root, rel)]).trim();
      if (localSha !== remoteSha) continue;
      unlinkSync(join(root, rel));
      acknowledged.push(rel);
    } catch {
      // Best-effort only — never authority to discard an unproved path.
    }
  }

  if (acknowledged.length === 0) return undefined;
  return {
    count: acknowledged.length,
    paths: acknowledged.slice(0, ACKNOWLEDGEMENT_PATH_LIMIT),
    truncated: acknowledged.length > ACKNOWLEDGEMENT_PATH_LIMIT,
  };
}

/** Every file under `<root>/<relDir>/` (recursively — entries AND any nested attachments), repo-relative. */
function listRelFiles(root: string, relDir: string): string[] {
  const dir = join(root, relDir);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      const childAbs = join(abs, name);
      const childRel = `${rel}/${name}`;
      if (statSync(childAbs).isDirectory()) walk(childAbs, childRel);
      else out.push(childRel);
    }
  };
  walk(dir, relDir);
  return out;
}

/** One landing target's shape — every kind shares the same commit/push/PR tail (see
 *  {@link finishLanding}); only the branch, the commit/PR text, and which directory it walks differ. */
interface LandingKind {
  family: LandingFamily;
  branch: string;
  prHead: string;
  /** The one repo-relative directory this kind owns — {@link landContent}'s carry-forward is
   *  filtered to it, so a landing can only ever re-stage its own records.
   *  Why: docs/forensics/feedback-landing.md#landingkind_owneddir. */
  ownedDir: string;
  prTitle: string;
  targetRepository?: LandingRepository;
  landingOwner?: string;
  commitMessage: (unlanded: string[]) => string;
  prBody: (unlanded: string[]) => string;
}

const LANDING_BASES: Record<LandingFamily, { branch: string; ownedDir: string; prTitle: string }> = {
  feedback: { branch: LANDING_BRANCH, ownedDir: FEEDBACK_REL_DIR, prTitle: LANDING_PR_TITLE },
  decisions: { branch: DECISIONS_LANDING_BRANCH, ownedDir: DECISIONS_REL_DIR, prTitle: DECISIONS_LANDING_PR_TITLE },
  "ci-learning": {
    branch: CI_LEARNING_LANDING_BRANCH,
    ownedDir: "",
    prTitle: CI_LEARNING_LANDING_PR_TITLE,
  },
  "plan-reconcile": {
    branch: PLAN_RECONCILE_LANDING_BRANCH,
    ownedDir: "",
    prTitle: PLAN_RECONCILE_LANDING_PR_TITLE,
  },
};

function repoKey(repo: LandingRepository): string {
  return `${repo.owner}/${repo.repo}`;
}

function sameRepository(a: LandingRepository | undefined, b: LandingRepository | undefined): boolean {
  return Boolean(a && b && a.owner === b.owner && a.repo === b.repo);
}

function branchSlug(s: string, maxLen: number): string {
  return kebabSlug(s, maxLen).replace(/-+$/, "") || "owner";
}

function scopedLandingBranch(base: string, target: LandingRepository, owner: string): string {
  const scope = `${repoKey(target)}:${owner}`;
  const digest = createHash("sha256").update(scope).digest("hex").slice(0, 12);
  const targetSlug = branchSlug(`${target.owner}-${target.repo}`, 44);
  const ownerSlug = branchSlug(owner, 28);
  return `${base}-${targetSlug}-${ownerSlug}-${digest}`;
}

export function landingIdentity(input: LandingIdentityInput = {}): LandingIdentity {
  const family = input.family ?? "feedback";
  const base = LANDING_BASES[family];
  const owner = input.landingOwner?.trim();
  const target = input.targetRepository;
  const scoped = target !== undefined && (Boolean(owner) || !sameRepository(target, input.sourceRepository));
  const branch = scoped ? scopedLandingBranch(base.branch, target, owner || "default") : base.branch;
  return {
    branch,
    prHead: branch,
    ownedDir: base.ownedDir,
    prTitle: base.prTitle,
    ...(target ? { targetRepository: target } : {}),
    ...(owner ? { landingOwner: owner } : {}),
  };
}

const LEGACY_LANDING_REFS = new Set([
  LANDING_BRANCH,
  DECISIONS_LANDING_BRANCH,
  CI_LEARNING_LANDING_BRANCH,
  PLAN_RECONCILE_LANDING_BRANCH,
]);
const SCOPED_LANDING_REF =
  /^(?:feedback-landing|decisions-landing|ci-learning-landing)-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[0-9a-f]{12}$/;

export function isLandingRef(ref: string): boolean {
  return LEGACY_LANDING_REFS.has(ref) || SCOPED_LANDING_REF.test(ref);
}

function feedbackCommitMessage(unlanded: string[]): string {
  return [
    LANDING_PR_TITLE,
    "",
    "Data-only: no code, no plan/tasks.yaml edits, no triage. Each entry keeps its",
    "existing status. Automated by the durable-inbox commit bridge (W1-T243) — this",
    "step used to be a hand-run `git add`+commit+PR before every `rmd triage`.",
    "",
    ...unlanded.map((f) => `- ${f}`),
  ].join("\n");
}

function feedbackPrBody(unlanded: string[]): string {
  const ids = unlanded
    .filter((f) => f.startsWith(`${FEEDBACK_REL_DIR}/`) && f.endsWith(".yaml"))
    .map((f) => f.slice(FEEDBACK_REL_DIR.length + 1, -".yaml".length));
  return [
    `Lands ${unlanded.length} pending \`plan/feedback/**\` file(s) so they become`,
    "git-durable — the automated durable-inbox commit bridge (W1-T243).",
    "",
    "Data-only: no code, no `plan/tasks.yaml` edits, no triage. Each entry keeps",
    "whatever status it already had.",
    "",
    "## Acceptance",
    ...(ids.length > 0
      ? ids.map((id) => `- ${id} lands as a durable inbox entry | grep: ${id} in plan/feedback/${id}.yaml`)
      : unlanded.map((f) => `- ${f} lands durably on origin/main | grep: . in ${f}`)),
  ].join("\n");
}

function decisionsCommitMessage(unlanded: string[]): string {
  return [
    DECISIONS_LANDING_PR_TITLE,
    "",
    "Data-only: no code, no plan/tasks.yaml edits. Each record keeps the risk band and",
    "rationale the auto-choose gate assigned it. Automated by the decision-record",
    "commit bridge (W1-T191) — decision.autochoose used to append straight into this",
    "checkout's own DECISIONS.md, which no PR was ever cut from.",
    "",
    ...unlanded.map((f) => `- ${f}`),
  ].join("\n");
}

function decisionsPrBody(unlanded: string[]): string {
  return [
    `Lands ${unlanded.length} pending \`plan/decisions.d/**\` record(s) so they become`,
    "git-durable — the automated decision-record commit bridge (W1-T191).",
    "",
    "Data-only: no code, no `plan/tasks.yaml` edits. Each record is exactly what",
    "decision.autochoose wrote at auto-choose time.",
    "",
    "## Acceptance",
    ...unlanded.map((f) => `- ${f} lands as a durable decision record | grep: . in ${f}`),
  ].join("\n");
}

const FEEDBACK_LANDING_KIND: Omit<LandingKind, keyof LandingIdentity> = {
  family: "feedback",
  commitMessage: feedbackCommitMessage,
  prBody: feedbackPrBody,
};

const DECISIONS_LANDING_KIND: Omit<LandingKind, keyof LandingIdentity> = {
  family: "decisions",
  commitMessage: decisionsCommitMessage,
  prBody: decisionsPrBody,
};

function ciLearningCommitMessage(unlanded: string[]): string {
  return [
    CI_LEARNING_LANDING_PR_TITLE,
    "",
    "Plan-only: parks machine-authored CI-learning lessons for human verify. Each",
    "record keeps author_class: machine and verify: human. Automated by the",
    "queue-backed CI-learning landing bridge (W1-T3492), which stages bytes outside",
    "the daemon checkout before opening this gated PR.",
    "",
    ...unlanded.map((f) => `- ${f}`),
  ].join("\n");
}

function ciLearningPrBody(unlanded: string[]): string {
  return [
    `Lands ${unlanded.length} pending CI-learning shard(s)`,
    "generated by the scheduled rung.",
    "",
    "Plan-only: machine-authored records stay parked with `verify: human`; the",
    "operator decides whether any lesson should graduate.",
    "",
    "## Acceptance",
    ...unlanded.map((f) => `- ${f} lands as a durable CI-learning shard | grep: author_class: machine in ${f}`),
  ].join("\n");
}

function ciLearningShardRelDir(checkoutRoot: string): string {
  return relative(checkoutRoot, join(resolveRepoLayout(checkoutRoot).planDir, "tasks.d"));
}

function ciLearningLandingKind(checkoutRoot: string, opts: LandFeedbackOpts, git: GitExec): LandingKind {
  const identity = {
    ...landingIdentity({
      family: "ci-learning",
      targetRepository: opts.targetRepository ?? repositoryFromGitConfig(git),
      landingOwner: opts.landingOwner,
      sourceRepository: opts.sourceRepository ?? sourceRepositoryFromCwd(),
    }),
    ownedDir: ciLearningShardRelDir(checkoutRoot),
  };
  return {
    family: "ci-learning",
    ...identity,
    commitMessage: ciLearningCommitMessage,
    prBody: ciLearningPrBody,
  };
}

function parseGithubRepository(value: string): LandingRepository | undefined {
  const m = /(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(value.trim());
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

function repositoryFromGitConfig(git: GitExec): LandingRepository | undefined {
  try {
    return parseGithubRepository(git(["config", "--get", "remote.origin.url"]).trim());
  } catch {
    // An unreadable target origin means there is no repository scope to derive.
    return undefined;
  }
}

function sourceRepositoryFromCwd(): LandingRepository | undefined {
  try {
    const out = execFileSync("git", ["-C", process.cwd(), "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseGithubRepository(out.trim());
  } catch {
    // An unreadable source checkout only disables the legacy self comparison.
    return undefined;
  }
}

function landingKind(
  template: Omit<LandingKind, keyof LandingIdentity>,
  root: string,
  opts: LandFeedbackOpts,
  git: GitExec,
): LandingKind {
  const identity = landingIdentity({
    family: template.family,
    targetRepository: opts.targetRepository ?? repositoryFromGitConfig(git),
    landingOwner: opts.landingOwner,
    sourceRepository: opts.sourceRepository ?? sourceRepositoryFromCwd(),
  });
  const layoutIdentity =
    template.family === "plan-reconcile"
      ? { ...identity, ownedDir: relative(root, join(resolveRepoLayout(root).planDir, "tasks.d")) }
      : identity;
  return { ...template, ...layoutIdentity };
}

/** The tree the landing branch carries on the remote, or `null` when that can't be determined —
 *  `null` means "push", never "skip", so an unreadable ref degrades to unconditional-push. */
function remoteBranchTree(git: GitExec, branch: string): string | null {
  try {
    return git(["rev-parse", `origin/${branch}^{tree}`]).trim();
  } catch {
    return null;
  }
}

function landingRepoArgs(identity: Pick<LandingIdentity, "targetRepository">): string[] {
  return identity.targetRepository ? ["--repo", repoKey(identity.targetRepository)] : [];
}

/**
 * Whether `refs/heads/<branch>` still exists on the remote, established before {@link
 * readBranchPending} fixes `branchTipSha` (W1-T3888, design (i)(b)) — a bare fetch never prunes a
 * gone remote-tracking ref (git-fetch(1) PRUNING), so a stale local ref reads as live, fooling
 * {@link remoteBranchTree}'s own read too. `ls-remote` answers "absent" without throwing, unlike a
 * targeted fetch (which THROWS on absence, conflating it with "the read failed" — design (iii)
 * forbids that); on absence, `update-ref -d <ref> <oldvalue>` reconciles it SHA-GUARDED, the live
 * hand repair this task's rationale describes. Touches exactly this ONE ref, never the falsifier's
 * forbidden broad sweep. A throw here propagates, never "assume absent".
 */
function refreshLandingRef(git: GitExec, branch: string): boolean {
  const advertised = git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).trim();
  if (advertised.length > 0) {
    git(["fetch", "origin", "--quiet", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    return true;
  }
  let staleSha: string | undefined;
  try {
    staleSha = git(["rev-parse", `refs/remotes/origin/${branch}`]).trim();
  } catch {
    staleSha = undefined; // nothing local to reconcile — a branch genuinely never pushed
  }
  if (staleSha) {
    try {
      git(["update-ref", "-d", `refs/remotes/origin/${branch}`, staleSha]);
    } catch {
      // Reconciled already, or moved under us — either way, `ls-remote`'s "absent" stands.
    }
  }
  return false;
}

/**
 * The tree {@link finishLanding} is about to push, plus the exact ref value it was read
 * against — the "value the compare-and-swap is computed from" (W1-T3560). Every writer (disk
 * scan or in-memory content) produces one of these the same way: `origin/main` union
 * `origin/<branch>`'s own still-pending records union this call's own new content.
 */
interface LandingTreeBuild {
  mainSha: string;
  treeSha: string;
  /** `origin/<branch>`'s commit sha at read time, or `undefined` when the branch has never been
   *  pushed — the exact value {@link finishLanding} leases the push against. */
  branchTipSha: string | undefined;
  /** This call's OWN new content only (never the carried-forward records) — what the commit
   *  message/PR body describe. */
  unlanded: string[];
  /** Feedback records this build refused to stage (W1-T3561) — a local copy that sat at an
   *  earlier §7B lifecycle position than `origin/main`'s. Always `[]` for the `decisions`/
   *  `ci-learning` families, which carry no status lifecycle. Never included in `unlanded`/the
   *  tree, so a refusal can never ride into an armed auto-merge PR by construction. */
  refused: FeedbackRefusal[];
}

/** One landing-time refusal (W1-T3561) — surfaced on {@link LandFeedbackResult.refused} and, for
 *  {@link sweepFeedbackLanding}, on its own ledger line, rather than being silently swallowed. */
export interface FeedbackRefusal {
  /** Repo-relative, forward-slash path of the refused record. */
  path: string;
  /** One line naming why — {@link import("./feedback-record-merge.js").FeedbackRecordMergeDecision}'s own `reason`. */
  reason: string;
}

/** True only for a TOP-LEVEL `plan/feedback/<id>.yaml` entry — never a nested attachment
 *  (`plan/feedback/attachments/**`), a stray non-yaml file, or any path outside the `feedback`
 *  family's own directory. Those keep the pre-existing byte-inequality behaviour: they carry no
 *  §7B status lifecycle for {@link mergeFeedbackRecord} to reason about. */
function isFeedbackRecordPath(kind: LandingKind, relPath: string): boolean {
  if (kind.family !== "feedback") return false;
  const prefix = `${kind.ownedDir}/`;
  if (!relPath.startsWith(prefix)) return false;
  const rest = relPath.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/") && rest.endsWith(".yaml");
}

/**
 * The one call site {@link mergeFeedbackRecord} has in this module (task acceptance criterion 7)
 * — both {@link landPending} and {@link landContent} route every feedback-record path through
 * this, rather than re-deciding the ordering inline the way the pre-fix `remoteSha !== localSha`/
 * `remoteSha === blobSha` checks did. `remoteSha` is only ever passed non-null (a null remote
 * means "nothing upstream yet", handled by the caller before this is reached — see both call
 * sites). Never throws: an unreadable upstream blob refuses rather than guesses a winner, the
 * same posture {@link mergeFeedbackRecord} itself takes on unparseable YAML.
 */
function decideFeedbackStage(git: GitExec, remoteSha: string, localBytes: string) {
  let upstreamBytes: string;
  try {
    upstreamBytes = git(["cat-file", "-p", remoteSha]);
  } catch (e) {
    return { kind: "refuse" as const, reason: `upstream record ${remoteSha} unreadable: ${String((e as Error)?.message ?? e)}` };
  }
  return mergeFeedbackRecord(upstreamBytes, localBytes);
}

/**
 * Whatever `kind.ownedDir` content `origin/<branch>` currently carries — the union half of the
 * writer (W1-T3560 design (i)): every owner's still-pending records, not just this call's own,
 * so a disjoint sibling's batch is carried forward exactly as {@link landContent} already did
 * before this task, instead of being silently replaced by a tree that never read it.
 *
 * `tipSha: undefined` means the branch was never pushed, or was deleted on the remote since
 * (W1-T3888) — either way nothing pending there. `ok: false` means the branch's content, or its
 * own remote existence, could not be established: never "assume empty", the failure mode the old
 * inline fallback-to-empty in {@link landContent} could not distinguish from "nothing pending".
 * Why: docs/forensics/feedback-landing.md#readbranchpending.
 */
function readBranchPending(
  git: GitExec,
  kind: LandingKind,
): { ok: true; tipSha: string | undefined; files: string[] } | { ok: false; reason: string } {
  let remoteHasBranch: boolean;
  try {
    remoteHasBranch = refreshLandingRef(git, kind.branch); // W1-T3888: the ACTUAL remote state
  } catch (e) {
    return { ok: false, reason: `cannot refresh ${kind.branch}'s remote ref: ${String((e as Error)?.message ?? e)}` };
  }
  // A positively observed absence (W1-T3888) — the "never pushed" shape below already handles.
  if (!remoteHasBranch) return { ok: true, tipSha: undefined, files: [] };
  let tipSha: string;
  try {
    tipSha = git(["rev-parse", `origin/${kind.branch}`]).trim();
  } catch (e) {
    // Confirmed EXISTENCE above, yet still unreadable — a genuine failure, not "assume empty".
    return { ok: false, reason: `cannot read ${kind.branch}'s tip after confirming it exists on the remote: ${String((e as Error)?.message ?? e)}` };
  }
  try {
    const files = git(["ls-tree", "-r", "--name-only", `origin/${kind.branch}`])
      .trim()
      .split("\n")
      .filter(Boolean)
      // Scoped to the directory this kind owns — unfiltered, this once reverted merged work
      // with a correct parent (PR #1025), caught only because the deletions broke the build.
      // Why: docs/forensics/feedback-landing.md#landcontent_scoped_carry_forward.
      .filter((f) => f.startsWith(`${kind.ownedDir}/`));
    return { ok: true, tipSha, files };
  } catch (e) {
    return { ok: false, reason: `cannot read ${kind.branch}'s pending content: ${String((e as Error)?.message ?? e)}` };
  }
}

/** Stage every carried-forward path at the blob `origin/<branch>` holds, skipping any already
 *  identical on `origin/main` (already merged for real) and any whose blob won't resolve (the
 *  ref moved between the `ls-tree` and this per-file read — dropped, never fatal; this is the
 *  W1-T191 regression lock, unchanged by this task). */
function stageBranchPending(git: GitExec, kind: LandingKind, files: string[], env: NodeJS.ProcessEnv): void {
  for (const f of files) {
    let pendingBlob: string;
    try {
      pendingBlob = git(["rev-parse", `origin/${kind.branch}:${f}`]).trim();
    } catch {
      continue;
    }
    let mainBlob: string | null;
    try {
      mainBlob = git(["rev-parse", `origin/main:${f}`]).trim();
    } catch {
      mainBlob = null;
    }
    if (pendingBlob === mainBlob) continue; // already merged into main for real
    git(["update-index", "--add", "--cacheinfo", `100644,${pendingBlob},${f}`], { env });
  }
}

/**
 * Open (or reuse) the one shared PR for `kind.branch`'s current tip. Shared by both branches of
 * {@link finishLanding} — the fresh-push path and the already-landed short-circuit — so a push
 * that succeeded but whose `gh pr create` failed still gets a PR on a later call (W1-T530).
 * Never pushes itself; the caller already decided that.
 *
 * An already-open PR is a one-call no-op (`gh pr list` only). This bridge deliberately does NOT
 * arm auto-merge: the daemon's shared post-review lane must first produce the current-head
 * `remudero-review` verdict, then its normal arm path may enable auto-merge. Arming here used to
 * create a race in which a freshly landed PR had no review context and could sit blocked until an
 * operator ran `rmd review` by hand (#5317/W1-T3990). Keeping the bridge at "open or reuse" also
 * makes a failed review retryable without a duplicate merge arm.
 */
function handoffLandingReview(
  prUrl: string,
  requestReview?: LandingReviewRequest,
): string | undefined {
  try {
    const pending = requestReview?.(prUrl);
    if (pending) {
      void Promise.resolve(pending).then(undefined, () => undefined);
    }
  } catch (e) {
    const reason = String((e as Error)?.message ?? e);
    return `review handoff failed for ${prUrl}: ${reason}`;
  }
  return undefined;
}

function ensurePrOpen(
  kind: LandingKind,
  gh: GhExec,
  unlanded: string[],
  requestReview?: LandingReviewRequest,
): { prUrl?: string; error?: string } {
  const existing = findPendingLandingPr({ gh, identity: kind });
  if (existing) {
    const error = handoffLandingReview(existing, requestReview);
    return error ? { prUrl: existing, error } : { prUrl: existing };
  }

  const body = kind.prBody(unlanded);
  let prUrl: string | undefined;
  try {
    assertLiveWriteAllowed("gh-pr-create", `opening the landing PR for ${kind.branch}`);
    const out = gh([
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      kind.prHead,
      "--title",
      kind.prTitle,
      "--body",
      body,
      ...landingRepoArgs(kind),
    ]);
    prUrl = out.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
  } catch (e) {
    // Push already succeeded — only opening the PR failed; a later call or a human `gh pr create` can pick it up.
    return { error: `\`gh pr create\` failed for ${kind.branch}: ${String((e as Error)?.message ?? e)}` };
  }
  // Do not call `gh pr merge` here. The shared daemon sweep owns the review -> arm transition;
  // this producer's responsibility ends once the landing PR is open and discoverable.
  if (prUrl) {
    const error = handoffLandingReview(prUrl, requestReview);
    return error ? { prUrl, error } : { prUrl };
  }
  return { prUrl };
}

/**
 * The commit/push/open-or-reuse-PR/arm tail every landing call shares, regardless of how its
 * tree was built ({@link landPending}'s disk scan or {@link landContent}'s in-memory content).
 * Never throws — callers already fold any error into `{ landed: false, error }`, except a
 * `gh pr create` failure, which still counts as `landed: true` since the push succeeded.
 *
 * W1-T3560: the push is a compare-and-swap (`--force-with-lease`) against exactly the ref value
 * `build.branchTipSha` was read at, never a bare `--force`. A lost lease means some OTHER owner's
 * tip moved between our read and our push — re-derive the union ONCE against the new tip
 * (`rebuild`) and retry; a second loss means a third writer squeezed in even under the retry, and
 * this call REFUSES rather than force-replacing a tip it never read. `ensurePrOpen` (the one
 * arm-origin site) is only ever reached once a push has actually landed under a held lease, or the
 * short-circuit proved the existing head already IS this exact tree — so whatever tree gets armed
 * is always the complete union as of the ref state it was computed against, never a partial one.
 */
function finishLanding(
  kind: LandingKind,
  git: GitExec,
  gh: GhExec,
  build: LandingTreeBuild,
  rebuild: () => LandingTreeBuild,
  env: NodeJS.ProcessEnv,
  requestReview?: LandingReviewRequest,
): LandFeedbackResult {
  // W1-T3561: fold a build's refusals onto a result — never onto the tree/files it names, so a
  // refused record can never ride into an armed auto-merge PR by construction (criterion 4).
  const withRefused = (result: LandFeedbackResult, refused: FeedbackRefusal[]): LandFeedbackResult =>
    refused.length > 0 ? { ...result, refused } : result;

  // Push only when the tree differs from what's already on the branch: the tree is deterministic
  // for unchanged content but `commit-tree` stamps the time, so comparing commits instead
  // force-pushed every call and once deadlocked a PR's CI (racing cancellations, no settled sha).
  // Why: docs/forensics/feedback-landing.md#finishlanding_shortcircuit.
  if (remoteBranchTree(git, kind.branch) === build.treeSha) {
    const { prUrl, error } = ensurePrOpen(kind, gh, build.unlanded, requestReview);
    return withRefused({ landed: true, files: build.unlanded, prUrl, error, pushed: false }, build.refused);
  }

  const pushOnce = (b: LandingTreeBuild): void => {
    const message = kind.commitMessage(b.unlanded);
    const commitSha = git(
      [
        "-c",
        `user.name=${LANDING_AUTHOR_NAME}`,
        "-c",
        `user.email=${LANDING_AUTHOR_EMAIL}`,
        "commit-tree",
        b.treeSha,
        "-p",
        b.mainSha,
        "-m",
        message,
      ],
      { env },
    ).trim();

    // Compare-and-swap, not a bare force-push (W1-T3560): the lease asserts the branch is still
    // exactly at `b.branchTipSha` (or still absent — never pushed, or deleted, W1-T3888) — the
    // value the union above was read against. The #954 guard below must move WITH this call on
    // any future refactor — dropping it silently reopens the hole #954 closed.
    assertLiveWriteAllowed("git-push", `force-pushing the ${kind.branch} branch`);
    const lease = b.branchTipSha
      ? `--force-with-lease=refs/heads/${kind.branch}:${b.branchTipSha}`
      : `--force-with-lease=refs/heads/${kind.branch}:`;
    git(["push", lease, "origin", `${commitSha}:refs/heads/${kind.branch}`]);
  };

  try {
    pushOnce(build);
  } catch (firstErr) {
    // Lost the lease: some OTHER owner's tip moved since we read it. Re-derive the union ONCE
    // against the NEW tip rather than force-replacing a tip we never read — the defect this task
    // fixes (W1-T3560 design (i)).
    let retried: LandingTreeBuild;
    try {
      retried = rebuild();
    } catch (e) {
      return { landed: false, files: [], error: String((e as Error)?.message ?? e) };
    }
    if (remoteBranchTree(git, kind.branch) === retried.treeSha) {
      const { prUrl, error } = ensurePrOpen(kind, gh, retried.unlanded, requestReview);
      return withRefused({ landed: true, files: retried.unlanded, prUrl, error, pushed: false }, retried.refused);
    }
    try {
      pushOnce(retried);
    } catch (secondErr) {
      // The ref moved again even under the retry (a third writer squeezed in) — refuse rather
      // than force-replacing a tip this call never actually read. Surfaced via `error`, never
      // swallowed, and `ensurePrOpen` is never reached — auto-merge is never armed on a refusal.
      return withRefused(
        {
          landed: false,
          files: [],
          error:
            `refused to force-replace ${kind.branch}: its tip moved again after re-deriving the ` +
            `union once (${String((secondErr as Error)?.message ?? secondErr)}); original failure: ` +
            `${String((firstErr as Error)?.message ?? firstErr)}`,
        },
        retried.refused,
      );
    }
    build = retried;
  }

  const { prUrl, error } = ensurePrOpen(kind, gh, build.unlanded, requestReview);
  if (error) {
    // Pushed fine; only the PR failed to open — pushed: true because the branch content did move.
    return withRefused(
      { landed: true, files: build.unlanded, error: `pushed to ${kind.branch} but ${error}`, pushed: true },
      build.refused,
    );
  }
  return withRefused({ landed: true, files: build.unlanded, prUrl, pushed: true }, build.refused);
}

/** Acknowledge any byte-identical, untracked queue copy already on fetched origin/main, then land
 *  every remaining `plan/feedback/**` file present on disk but absent or changed upstream. Never
 *  throws. Scans disk because `captureFeedback`'s local copy is the durable buffer even offline —
 *  unlike {@link landContent}, this path legitimately needs a real file to read. */
interface LandPendingOpts extends LandFeedbackOpts {
  /** Internal compatibility seam: only the named sweep publishes acknowledgement evidence. */
  reportAcknowledgement?: boolean;
}

function landPending(root: string, kind: LandingKind, opts: LandPendingOpts): LandFeedbackResult {
  const git = opts.git ?? defaultGit(root);
  const gh = opts.gh ?? defaultGh();
  let scratchDir: string | undefined;
  let acknowledgement: LandFeedbackResult["acknowledgement"];
  const withAcknowledgement = (result: LandFeedbackResult): LandFeedbackResult =>
    acknowledgement && opts.reportAcknowledgement ? { ...result, acknowledgement } : result;

  try {
    git(["fetch", "origin", "--quiet"]);
    acknowledgement = acknowledgeLandedQueueCopies(root, kind, git);

    // W1-T3561: a byte inequality alone no longer decides a feedback record's fate. `new
    // remoteSha => local wins trivially (nothing upstream yet); identical bytes => nothing to
    // stage; otherwise a top-level `plan/feedback/<id>.yaml` entry is routed through
    // {@link mergeFeedbackRecord} (via {@link decideFeedbackStage}), which may also REFUSE a
    // local copy that sits at an earlier §7B lifecycle position — reported below, never dropped
    // in the caller's tree. Every other path (attachments, a stray non-yaml file, and every
    // `decisions`/`ci-learning` family) keeps the exact pre-fix inequality behaviour.
    const scanLocalUnlanded = (): { files: string[]; refused: FeedbackRefusal[] } => {
      const files: string[] = [];
      const refused: FeedbackRefusal[] = [];
      for (const rel of listRelFiles(root, kind.ownedDir)) {
        const localSha = git(["hash-object", join(root, rel)]).trim();
        let remoteSha: string | null;
        try {
          remoteSha = git(["rev-parse", `origin/main:${rel}`]).trim();
        } catch {
          remoteSha = null; // not on origin/main at all yet
        }
        if (remoteSha === localSha) continue;
        if (remoteSha !== null && isFeedbackRecordPath(kind, rel)) {
          const decision = decideFeedbackStage(git, remoteSha, readFileSync(join(root, rel), "utf8"));
          if (decision.kind === "refuse") {
            refused.push({ path: rel, reason: decision.reason });
            continue;
          }
          if (decision.kind === "keep-upstream") continue;
        }
        files.push(rel);
      }
      return { files, refused };
    };
    const initialScan = scanLocalUnlanded();
    if (initialScan.files.length === 0) {
      return withAcknowledgement(
        initialScan.refused.length > 0
          ? { landed: false, files: [], refused: initialScan.refused }
          : { landed: false, files: [] },
      );
    }

    // Commit built against a SCRATCH index, never the caller's real one — the acknowledgement
    // above is the sole narrow working-tree mutation; this stays under W1-T60's isolation.
    scratchDir = mkdtempSync(join(tmpdir(), `rmd-${kind.branch}-`));
    const env = { ...process.env, GIT_INDEX_FILE: join(scratchDir, "index") };

    // W1-T3560: UNION WRITER. Read-tree from origin/main, then carry forward whatever
    // origin/<branch> already holds (every OTHER root's still-pending records — the disk-scanning
    // path never did this before; {@link landContent} always has), THEN overlay this root's own
    // local disk. `mainSha` is re-read every build so a retry after a lost lease sees a moved
    // origin/main too, not just a moved branch tip.
    const buildTree = (mainSha: string): LandingTreeBuild => {
      const pending = readBranchPending(git, kind);
      if (!pending.ok) throw new Error(pending.reason);
      git(["read-tree", "origin/main"], { env });
      if (pending.tipSha) stageBranchPending(git, kind, pending.files, env);
      const { files: unlanded, refused } = scanLocalUnlanded();
      for (const rel of unlanded) {
        const blobSha = git(["hash-object", "-w", join(root, rel)], { env }).trim();
        git(["update-index", "--add", "--cacheinfo", `100644,${blobSha},${rel}`], { env });
      }
      const treeSha = git(["write-tree"], { env }).trim();
      return { mainSha, treeSha, branchTipSha: pending.tipSha, unlanded, refused };
    };

    const initialMainSha = git(["rev-parse", "origin/main"]).trim();
    const initialBuild = buildTree(initialMainSha);
    const rebuild = (): LandingTreeBuild => {
      git(["fetch", "origin", "--quiet"]);
      return buildTree(git(["rev-parse", "origin/main"]).trim());
    };

    return withAcknowledgement(finishLanding(kind, git, gh, initialBuild, rebuild, env, opts.requestReview));
  } catch (e) {
    return withAcknowledgement({ landed: false, files: [], error: String((e as Error)?.message ?? e) });
  } finally {
    if (scratchDir) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup of a temp dir; never let this mask the real result above
      }
    }
  }
}

export function landFeedback(root: string, opts: LandFeedbackOpts = {}): LandFeedbackResult {
  const git = opts.git ?? defaultGit(root);
  return landPending(root, landingKind(FEEDBACK_LANDING_KIND, root, opts, git), { ...opts, git });
}

export interface SweepFeedbackLandingOpts extends LandFeedbackOpts {
  /**
   * One ledger line per call — see this function's own doc for the acting/quiet split.
   * Optional: omitted, no line is emitted (the caller can still inspect the returned
   * {@link LandFeedbackResult} directly, e.g. a one-off `rmd feedback land`).
   */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

/**
 * The level-triggered backstop over {@link landFeedback} (W1-T530, ratifies P22). `captureFeedback`
 * is landFeedback's only call site, so an entry captured while landing was unavailable is
 * stranded off origin/main — this thin wrapper re-runs the same scan so a daemon poll can retry
 * it. Idempotent and best-effort, like every rung beside it (`sweep`/`sweepOrphans`/`alertPoll`).
 * Logs in detail only when it actually pushed; a quiet pass logs a count, so a fast poll cadence
 * cannot flood the ledger.
 * Why: docs/forensics/feedback-landing.md#sweepfeedbacklanding.
 */
export function sweepFeedbackLanding(root: string, opts: SweepFeedbackLandingOpts = {}): LandFeedbackResult {
  const { log, ...landOpts } = opts;
  const git = landOpts.git ?? defaultGit(root);
  const result = landPending(root, landingKind(FEEDBACK_LANDING_KIND, root, landOpts, git), {
    ...landOpts,
    git,
    reportAcknowledgement: true,
  });
  if (log) {
    const acknowledgement = result.acknowledgement;
    const acknowledgementEvidence = acknowledgement
      ? {
          acknowledged_count: acknowledgement.count,
          acknowledged_paths: acknowledgement.paths,
          acknowledged_paths_truncated: acknowledgement.truncated,
        }
      : { acknowledged_count: 0 };
    // W1-T3561: a refused, backward-moving feedback record rides along on EITHER branch below —
    // never swallowed into just `acknowledgementEvidence`'s silence, regardless of whether this
    // pass also happened to push something else.
    const refusalEvidence = result.refused && result.refused.length > 0 ? { refused: result.refused } : {};
    if (result.pushed) {
      log("feedback.landing_sweep", {
        pushed: true,
        landed: result.landed,
        files: result.files,
        pr_url: result.prUrl,
        error: result.error,
        ...acknowledgementEvidence,
        ...refusalEvidence,
      });
    } else {
      // W1-T3560: a refusal (the ref moved twice under a lost lease, or its pending content
      // could not be read) also reports `pushed: false` — `error` must still ride along here, or
      // the exact failure this task makes visible (instead of a silent drop) goes right back to
      // being swallowed by this summary branch.
      log("feedback.landing_sweep", {
        pushed: false,
        landed: result.landed,
        file_count: result.files.length,
        error: result.error,
        ...acknowledgementEvidence,
        ...refusalEvidence,
      });
    }
  }
  return result;
}

export interface LandContentInput {
  /** Repo-relative, forward-slash path this content belongs at. */
  relPath: string;
  content: string;
}

/**
 * The in-memory sibling of {@link landPending}: lands explicit (path, content) pairs never
 * written to root's real working tree at all — a real local write of an already-tracked file
 * would itself count as dirt in `checkCliFreshness`'s git status (the W1-T191 defect). Content is
 * staged into a scratch tmp file outside root purely so `git hash-object -w` has bytes to read;
 * the blob lands in the repo's object database, never on disk under root.
 * Why: docs/forensics/feedback-landing.md#landcontent.
 */
function landContent(
  root: string,
  kind: LandingKind,
  inputs: LandContentInput[],
  opts: LandFeedbackOpts,
): LandFeedbackResult {
  const git = opts.git ?? defaultGit(root);
  const gh = opts.gh ?? defaultGh();
  let scratchDir: string | undefined;

  try {
    scratchDir = mkdtempSync(join(tmpdir(), `rmd-${kind.branch}-`));
    const env = { ...process.env, GIT_INDEX_FILE: join(scratchDir, "index") };

    const buildTree = (mainSha: string): LandingTreeBuild => {
      const pending = readBranchPending(git, kind);
      if (!pending.ok) throw new Error(pending.reason);

      // Always start from fresh origin/main, never a possibly-stale pending branch — unrelated
      // content landed on main since must not be silently reverted by this force-push.
      git(["read-tree", "origin/main"], { env });

      // Carry forward whatever an earlier, still-unmerged call already pushed here (W1-T191
      // criterion 2, extended by W1-T3560 to the disk-scanning sibling too): this content-only
      // path has no disk to re-scan the way {@link landPending} does, so without this a second
      // call would drop the first call's content entirely.
      if (pending.tipSha) stageBranchPending(git, kind, pending.files, env);

      const unlanded: string[] = [];
      // W1-T3561: `landFeedbackStatusContent` (the console's `POST /v1/feedback/decision` write
      // path) is the one `landContent` caller whose paths carry a §7B status lifecycle
      // (`recordDecision`/`recordRuling` use the `decisions` family, out of scope — see
      // `isFeedbackRecordPath`) — it must obey the same monotonic predicate {@link landPending}'s
      // disk scan does, per the task's design point (v), rather than the bare
      // `remoteSha === blobSha` identity check this loop used before.
      const refused: FeedbackRefusal[] = [];
      let i = 0;
      for (const { relPath, content } of inputs) {
        // A scratch tmp file, never inside root — hash-object just needs a path to read from.
        const tmpFile = join(scratchDir as string, `content-${i++}`);
        writeFileSync(tmpFile, content);
        const blobSha = git(["hash-object", "-w", tmpFile], { env }).trim();
        let remoteSha: string | null;
        try {
          remoteSha = git(["rev-parse", `origin/main:${relPath}`]).trim();
        } catch {
          remoteSha = null; // not on origin/main at all yet
        }
        if (remoteSha === blobSha) continue; // already identical upstream — nothing to land
        if (remoteSha !== null && isFeedbackRecordPath(kind, relPath)) {
          const decision = decideFeedbackStage(git, remoteSha, content);
          if (decision.kind === "refuse") {
            refused.push({ path: relPath, reason: decision.reason });
            continue;
          }
          if (decision.kind === "keep-upstream") continue;
        }
        git(["update-index", "--add", "--cacheinfo", `100644,${blobSha},${relPath}`], { env });
        unlanded.push(relPath);
      }
      const treeSha = git(["write-tree"], { env }).trim();
      return { mainSha, treeSha, branchTipSha: pending.tipSha, unlanded, refused };
    };

    git(["fetch", "origin", "--quiet"]);
    const initialBuild = buildTree(git(["rev-parse", "origin/main"]).trim());
    if (initialBuild.unlanded.length === 0) {
      return initialBuild.refused.length > 0
        ? { landed: false, files: [], refused: initialBuild.refused }
        : { landed: false, files: [] };
    }

    const rebuild = (): LandingTreeBuild => {
      git(["fetch", "origin", "--quiet"]);
      return buildTree(git(["rev-parse", "origin/main"]).trim());
    };

    return finishLanding(kind, git, gh, initialBuild, rebuild, env, opts.requestReview);
  } catch (e) {
    return { landed: false, files: [], error: String((e as Error)?.message ?? e) };
  } finally {
    if (scratchDir) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup of a temp dir; never let this mask the real result above
      }
    }
  }
}

export function landPlanReconcileShards(
  root: string,
  inputs: readonly LandContentInput[],
  opts: LandFeedbackOpts = {},
): LandFeedbackResult {
  const kind = landingKind(
    {
      family: "plan-reconcile",
      commitMessage: (files) => [PLAN_RECONCILE_LANDING_PR_TITLE, "", "Automated plan-status reconciliation from the measurement cadence.", "", ...files.map((file) => `- ${file}`)].join("\n"),
      prBody: (files) => ["Reconciles credited task shards whose decorative status is still queued.", "", "The change is derived from the existing credit projection and staged through the scratch-index landing bridge.", "", "## Acceptance", ...files.map((file) => `- ${file} is reconciled without a daemon checkout write | grep: status: merged in ${file}`)].join("\n"),
    },
    root,
    opts,
    opts.git ?? defaultGit(root),
  );
  return landContent(root, kind, [...inputs], opts);
}

/** `<root>/plan/decisions.d/<taskId>-<runId>.md` — one file per decision.autochoose resolution,
 *  so concurrent `run-task` runs never collide on a path. Never written to disk (see
 *  {@link recordDecision}) — only the path it lands at via the `decisions-landing` bridge. */
export function decisionRecordRelPath(taskId: string, runId: string): string {
  return `${DECISIONS_REL_DIR}/${taskId}-${runId}.md`;
}

export interface DecisionRecordParams {
  taskId: string;
  runId: string;
  options: string[];
  chosen: string;
  band: string;
  reason: string;
  /** Defaults to `new Date().toISOString()` — injectable so a test can pin the timestamp. */
  ts?: string;
}

/** Pure — the same human-readable body DECISIONS.md's append used to carry, now the sole content
 *  of its own shard rather than one more line on a shared growing file. */
export function decisionRecordContent(params: DecisionRecordParams): string {
  const ts = params.ts ?? new Date().toISOString();
  return (
    `## ${ts} — ${params.taskId} (${params.runId})\n` +
    `- Options: ${params.options.join(" | ")}\n` +
    `- Chosen (RECOMMENDED, auto): ${params.chosen}\n` +
    `- Risk: ${params.band} (${params.reason})\n` +
    `- Rollback: revert the PR.\n`
  );
}

/** Land one decision-record shard (harness-owned, never the worker's own commit) via
 *  {@link landContent} — see its doc for why this never touches root's working tree. A landing
 *  failure leaves the record as only the `decision.autochoose` ledger line (Standing rule 22's
 *  receipt half) until a later resolution retries; no local file to grep meanwhile. */
export function recordDecision(
  root: string,
  params: DecisionRecordParams,
  opts: LandFeedbackOpts = {},
): LandFeedbackResult {
  const relPath = decisionRecordRelPath(params.taskId, params.runId);
  const git = opts.git ?? defaultGit(root);
  return landContent(root, landingKind(DECISIONS_LANDING_KIND, root, opts, git), [{ relPath, content: decisionRecordContent(params) }], {
    ...opts,
    git,
  });
}

/** Land one agent-authored RULING record (W1-T3212) via {@link landContent} — the governance
 *  sibling of {@link recordDecision}, on the SAME branch, PR and landing kind so no second audit
 *  trail exists. Separate from it only because the CONTENT differs (rulingRecordContent,
 *  lib/ruling-judge.ts). */
export function recordRuling(
  root: string,
  relPath: string,
  content: string,
  opts: LandFeedbackOpts = {},
): LandFeedbackResult {
  const git = opts.git ?? defaultGit(root);
  return landContent(root, landingKind(DECISIONS_LANDING_KIND, root, opts, git), [{ relPath, content }], { ...opts, git });
}

/** Land one feedback entry's already-serialized YAML via {@link landContent} — the write-site-2
 *  sibling of {@link recordDecision}. `setFeedbackStatus` calls this instead of `writeFileSync`
 *  when `opts.land` is set, so a status flip never shows up as `M`-modified in
 *  `checkCliFreshness`'s git status (the W1-T191 dirt this removes). Trade-off: a caller
 *  re-reading root's own copy right after won't see the flip until the next self-sync. */
export function landFeedbackStatusContent(
  root: string,
  relPath: string,
  content: string,
  opts: LandFeedbackOpts = {},
): LandFeedbackResult {
  const git = opts.git ?? defaultGit(root);
  return landContent(root, landingKind(FEEDBACK_LANDING_KIND, root, opts, git), [{ relPath, content }], { ...opts, git });
}

function ciLearningPendingRoot(stateRoot: string): string {
  return join(stateRoot, CI_LEARNING_PENDING_REL_DIR);
}

function ciLearningPendingRelPaths(stateRoot: string, shardRelDir: string): string[] {
  return listRelFiles(ciLearningPendingRoot(stateRoot), shardRelDir).sort();
}

function ciLearningPendingAbsPath(stateRoot: string, relPath: string): string {
  return join(ciLearningPendingRoot(stateRoot), relPath);
}

function ciLearningOriginRead(contents: string, label: string): { ok: true; origin?: string } | { ok: false; reason: string } {
  try {
    const origin = loadPlanFromYaml(contents, label).tasks[0]?.origin;
    return { ok: true, origin: typeof origin === "string" && origin.length > 0 ? origin : undefined };
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message ?? e) };
  }
}

function ciLearningFiledShardRead(
  relPath: string,
  contents: string,
): { ok: true; filed?: CiLearningFiledShard } | { ok: false; reason: string } {
  try {
    const task = loadPlanFromYaml(contents, `pending-ci-learning:${relPath}`).tasks[0];
    if (typeof task?.id !== "string" || typeof task.origin !== "string") return { ok: true };
    return { ok: true, filed: { relPath, taskId: task.id, findingId: task.origin } };
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message ?? e) };
  }
}

/** Every CI-learning finding already staged outside the checkout and awaiting its landing PR. */
export function ciLearningPendingOrigins(stateRoot: string, checkoutRoot: string): string[] {
  const origins = new Set<string>();
  for (const relPath of ciLearningPendingRelPaths(stateRoot, ciLearningShardRelDir(checkoutRoot))) {
    const read = ciLearningOriginRead(
      readFileSync(ciLearningPendingAbsPath(stateRoot, relPath), "utf8"),
      `pending-ci-learning:${relPath}`,
    );
    if (read.ok && read.origin) origins.add(read.origin);
  }
  return [...origins].sort();
}

function ciLearningShardRelPath(draft: CiLearningShardDraft, taskId: string, shardRelDir: string): string {
  const stem = kebabSlug(draft.title, CI_LEARNING_SLUG_MAX).replace(/-+$/, "");
  return `${shardRelDir}/${taskId}${stem ? `-${stem}` : ""}.yaml`;
}

function readPendingCiLearningInputs(stateRoot: string, shardRelDir: string): LandContentInput[] {
  return ciLearningPendingRelPaths(stateRoot, shardRelDir).map((relPath) => ({
    relPath,
    content: readFileSync(ciLearningPendingAbsPath(stateRoot, relPath), "utf8"),
  }));
}

function ciLearningMainOrigins(shardRelDir: string, git: GitExec): Set<string> {
  const origins = new Set<string>();
  const output = git([
    "grep",
    "--no-color",
    "-h",
    "-E",
    "^[[:space:]]*origin:[[:space:]]*[^#]+",
    "origin/main",
    "--",
    shardRelDir,
  ]);
  for (const line of output.split(/\r?\n/)) {
    const raw = line.replace(/^[ \t]*origin:[ \t]*/, "").trim();
    const origin = raw.replace(/\\"/g, '"').replace(/^(['"])(.*)\1$/, "$2").trim();
    if (origin) origins.add(origin);
  }
  return origins;
}

function acknowledgeMergedCiLearningShards(stateRoot: string, shardRelDir: string, git: GitExec): void {
  const mainOrigins = ciLearningMainOrigins(shardRelDir, git);
  for (const relPath of ciLearningPendingRelPaths(stateRoot, shardRelDir)) {
    try {
      const queuedPath = ciLearningPendingAbsPath(stateRoot, relPath);
      const queued = readFileSync(queuedPath, "utf8");
      const parsed = ciLearningOriginRead(queued, `pending-ci-learning:${relPath}`);
      if (parsed.ok && parsed.origin && mainOrigins.has(parsed.origin)) {
        unlinkSync(queuedPath);
        continue;
      }
      const remoteSha = git(["rev-parse", `origin/main:${relPath}`]).trim();
      const localSha = git(["hash-object", queuedPath]).trim();
      if (remoteSha === localSha) unlinkSync(ciLearningPendingAbsPath(stateRoot, relPath));
    } catch {
      // The queue is durable by default: remove only when fetched origin/main proves the same blob.
    }
  }
}

export interface LandCiLearningShardsOptions extends LandFeedbackOpts {
  /** Daemon state root; staged shards live under `state/ci-learning-pending`, never the checkout. */
  stateRoot: string;
  /**
   * THE RESERVATION PATH (task-id-reservation.ts), never `max(id)+1`. The landing identity
   * supplies the branch it will actually push, so a command started on `main` never creates an
   * unmatchable holder claim for its isolated landing PR.
   */
  mintTaskId: (filingBranch: string) => string;
  /** Every `origin:` the plan ALREADY holds. */
  planOrigins: readonly string[];
  /** Render one draft as the shard's YAML bytes. INJECTED rather than imported from
   *  measurement-cadence.ts's `ciLearningShardYaml` — see the cycle note on
   *  {@link CiLearningShardDraft} above. run-task.ts passes the real renderer for both the
   *  scheduled and directly-tested paths. */
  renderShard: (draft: CiLearningShardDraft, taskId: string) => string;
  /** Parse the rendered bytes back and lint them before they are staged. INJECTED for the same
   *  cycle reason as `renderShard`; the real, lint-backed verdict is
   *  measurement-cadence.ts's `ciLearningRecordVerdict`. */
  recordVerdict: (contents: string, label: string) => { ok: boolean; reason: string };
}

/** Stage CI-learning shards in daemon state, then land that durable queue via a gated PR. */
export function landCiLearningShards(
  drafts: readonly CiLearningShardDraft[],
  checkoutRoot: string,
  deps: LandCiLearningShardsOptions,
): CiLearningFilingResult {
  const git = deps.git ?? defaultGit(checkoutRoot);
  const kind = ciLearningLandingKind(checkoutRoot, deps, git);
  const shardRelDir = ciLearningShardRelDir(checkoutRoot);
  const held = new Set([...deps.planOrigins, ...ciLearningPendingOrigins(deps.stateRoot, checkoutRoot)]);
  const skipped: string[] = [];
  const refused: { findingId: string; reason: string }[] = [];

  try {
    git(["fetch", "origin", "--quiet"]);
    acknowledgeMergedCiLearningShards(deps.stateRoot, shardRelDir, git);
  } catch {
    // Fetch/ack failure must not discard staged bytes or prevent a new durable staging write.
  }

  for (const draft of drafts) {
    if (held.has(draft.findingId)) {
      skipped.push(draft.findingId);
      continue;
    }
    const taskId = deps.mintTaskId(kind.branch);
    const content = deps.renderShard(draft, taskId);
    const verdict = deps.recordVerdict(content, `ci-learning:${taskId}`);
    if (!verdict.ok) {
      refused.push({ findingId: draft.findingId, reason: verdict.reason });
      continue;
    }
    const relPath = ciLearningShardRelPath(draft, taskId, shardRelDir);
    const absPath = ciLearningPendingAbsPath(deps.stateRoot, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
    held.add(draft.findingId);
  }

  const inputs = readPendingCiLearningInputs(deps.stateRoot, shardRelDir);
  if (inputs.length === 0) return { filed: [], skipped, refused };

  const landing = landContent(checkoutRoot, kind, inputs, deps);
  try {
    acknowledgeMergedCiLearningShards(deps.stateRoot, shardRelDir, git);
  } catch {
    // Best-effort acknowledgement only; pending bytes remain retryable.
  }
  if (!landing.landed || landing.error) return { filed: [], skipped, refused };

  const landed = new Set(landing.files);
  const filed = inputs
    .filter((input) => landed.has(input.relPath))
    .map((input) => ciLearningFiledShardRead(input.relPath, input.content))
    .filter((read): read is { ok: true; filed: CiLearningFiledShard } => read.ok && read.filed !== undefined)
    .map((read) => read.filed);
  return { filed, skipped, refused };
}

/** The URL of the currently-open landing PR for this identity, if any — best-effort,
 *  `undefined` on any `gh` failure, same as "no PR yet". Also used by `rmd triage`'s exit-2 branch
 *  to name the pending PR instead of a misleading "no such feedback entry" (W1-T243 claim 4). */
export function findPendingLandingPr(
  opts: { gh?: GhExec; branch?: string; identity?: LandingIdentity; targetRepository?: LandingRepository } = {},
): string | undefined {
  const gh = opts.gh ?? defaultGh();
  const identity = opts.identity ?? landingIdentity({ targetRepository: opts.targetRepository });
  const branch = opts.branch ?? identity.prHead;
  const repoArgs = landingRepoArgs(opts.targetRepository ? { targetRepository: opts.targetRepository } : identity);
  try {
    const existing = JSON.parse(
      gh(["pr", "list", "--head", branch, "--state", "open", "--json", "url", ...repoArgs]),
    ) as Array<{ url: string }>;
    return existing[0]?.url;
  } catch {
    return undefined;
  }
}
