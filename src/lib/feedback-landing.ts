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

import { execFileSync } from "node:child_process";
import { ghExec } from "./github-transport.js";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLiveWriteAllowed } from "./live-write-guard.js";
import { automergeHoldFromLedger } from "./review.js";

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

const LANDING_AUTHOR_NAME = "rmd-feedback-bridge";
const LANDING_AUTHOR_EMAIL = "rmd-feedback-bridge@users.noreply.github.com";

type GitExec = (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => string;
type GhExec = (args: string[]) => string;

export interface LandFeedbackOpts {
  /** Injectable `git` exec — real callers omit it; tests can force specific failure paths. */
  git?: GitExec;
  /**
   * Injectable `gh` exec (the `ghGateway` pattern, lib/status.ts) — real callers omit it; tests
   * inject a fake so PR open/list/merge never hits real GitHub.
   */
  gh?: GhExec;
  /**
   * W1-T1000002 — the same hold reader the sweep's arm path consults
   * ({@link import("./review.js").automergeHoldFromLedger}), so this file's one arm-origin site
   * ({@link ensurePrOpen}) honours a standing operator hold instead of arming around it. Omitted:
   * arms exactly as before this task (fail open).
   * Why: docs/forensics/feedback-landing.md#landfeedbackopts_ledgerlines.
   */
  ledgerLines?: () => Array<Record<string, unknown>>;
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
  branch: string;
  /** The one repo-relative directory this kind owns — {@link landContent}'s carry-forward is
   *  filtered to it, so a landing can only ever re-stage its own records.
   *  Why: docs/forensics/feedback-landing.md#landingkind_owneddir. */
  ownedDir: string;
  prTitle: string;
  commitMessage: (unlanded: string[]) => string;
  prBody: (unlanded: string[]) => string;
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

const FEEDBACK_LANDING_KIND: LandingKind = {
  branch: LANDING_BRANCH,
  ownedDir: FEEDBACK_REL_DIR,
  prTitle: LANDING_PR_TITLE,
  commitMessage: feedbackCommitMessage,
  prBody: feedbackPrBody,
};

const DECISIONS_LANDING_KIND: LandingKind = {
  branch: DECISIONS_LANDING_BRANCH,
  ownedDir: DECISIONS_REL_DIR,
  prTitle: DECISIONS_LANDING_PR_TITLE,
  commitMessage: decisionsCommitMessage,
  prBody: decisionsPrBody,
};

/** Anchors on `/pull/<n>`, mirroring `prUrlTarget` (run-task.ts) — duplicated locally since this
 *  file must not import run-task.ts. Returns `undefined`, never a guess, on any non-PR URL. */
function landingPrNumberFromUrl(prUrl: string): number | undefined {
  const m = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl.trim());
  return m ? Number(m[1]) : undefined;
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

/**
 * Open (or reuse) the one shared PR for `kind.branch`'s current tip. Shared by both branches of
 * {@link finishLanding} — the fresh-push path and the already-landed short-circuit — so a push
 * that succeeded but whose `gh pr create` failed still gets a PR on a later call (W1-T530).
 * Never pushes itself; the caller already decided that.
 *
 * An already-open PR is a one-call no-op (`gh pr list` only): auto-merge arms only in the call
 * that creates the PR, never re-armed later, so a quiet poll never re-issues `gh pr merge`.
 */
function ensurePrOpen(
  kind: LandingKind,
  gh: GhExec,
  unlanded: string[],
  ledgerLines?: () => Array<Record<string, unknown>>,
): { prUrl?: string; error?: string } {
  const existing = findPendingLandingPr({ gh, branch: kind.branch });
  if (existing) return { prUrl: existing };

  const body = kind.prBody(unlanded);
  let prUrl: string | undefined;
  try {
    assertLiveWriteAllowed("gh-pr-create", `opening the landing PR for ${kind.branch}`);
    const out = gh(["pr", "create", "--base", "main", "--head", kind.branch, "--title", kind.prTitle, "--body", body]);
    prUrl = out.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
  } catch (e) {
    // Push already succeeded — only opening the PR failed; a later call or a human `gh pr create` can pick it up.
    return { error: `\`gh pr create\` failed for ${kind.branch}: ${String((e as Error)?.message ?? e)}` };
  }
  if (prUrl) {
    // Consults the same hold reader as LandFeedbackOpts.ledgerLines documents above.
    const prNumber = landingPrNumberFromUrl(prUrl);
    const hold = ledgerLines && prNumber !== undefined ? automergeHoldFromLedger(ledgerLines(), prNumber) : undefined;
    if (!hold) {
      try {
        assertLiveWriteAllowed("gh-pr-merge", `arming auto-merge on ${prUrl}`);
        gh(["pr", "merge", prUrl, "--auto", "--squash"]);
      } catch {
        // Best-effort — the ci + remudero-review gate decides either way (Standing rule 3B).
      }
    }
  }
  return { prUrl };
}

/** The commit/push/open-or-reuse-PR/arm tail every landing call shares, regardless of how its
 *  tree was built ({@link landPending}'s disk scan or {@link landContent}'s in-memory content).
 *  Never throws — callers already fold any error into `{ landed: false, error }`, except a
 *  `gh pr create` failure, which still counts as `landed: true` since the push succeeded. */
function finishLanding(
  kind: LandingKind,
  git: GitExec,
  gh: GhExec,
  mainSha: string,
  treeSha: string,
  unlanded: string[],
  env: NodeJS.ProcessEnv,
  ledgerLines?: () => Array<Record<string, unknown>>,
): LandFeedbackResult {
  // Push only when the tree differs from what's already on the branch: the tree is deterministic
  // for unchanged content but `commit-tree` stamps the time, so comparing commits instead
  // force-pushed every call and once deadlocked a PR's CI (racing cancellations, no settled sha).
  // Why: docs/forensics/feedback-landing.md#finishlanding_shortcircuit.
  if (remoteBranchTree(git, kind.branch) === treeSha) {
    const { prUrl, error } = ensurePrOpen(kind, gh, unlanded, ledgerLines);
    return { landed: true, files: unlanded, prUrl, error, pushed: false };
  }

  const message = kind.commitMessage(unlanded);
  const commitSha = git(
    [
      "-c",
      `user.name=${LANDING_AUTHOR_NAME}`,
      "-c",
      `user.email=${LANDING_AUTHOR_EMAIL}`,
      "commit-tree",
      treeSha,
      "-p",
      mainSha,
      "-m",
      message,
    ],
    { env },
  ).trim();

  // Force-push is safe here: this branch is bot-owned and never diverges by history, only by
  // content, so it can never actually conflict. The #954 guard below must move WITH this call on
  // any future refactor — dropping it silently reopens the hole #954 closed.
  assertLiveWriteAllowed("git-push", `force-pushing the ${kind.branch} branch`);
  git(["push", "--force", "origin", `${commitSha}:refs/heads/${kind.branch}`]);

  const { prUrl, error } = ensurePrOpen(kind, gh, unlanded, ledgerLines);
  if (error) {
    // Pushed fine; only the PR failed to open — pushed: true because the branch content did move.
    return { landed: true, files: unlanded, error: `pushed to ${kind.branch} but ${error}`, pushed: true };
  }
  return { landed: true, files: unlanded, prUrl, pushed: true };
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
    const mainSha = git(["rev-parse", "origin/main"]).trim();
    acknowledgement = acknowledgeLandedQueueCopies(root, kind, git);

    const unlanded = listRelFiles(root, FEEDBACK_REL_DIR).filter((rel) => {
      const localSha = git(["hash-object", join(root, rel)]).trim();
      let remoteSha: string | null;
      try {
        remoteSha = git(["rev-parse", `origin/main:${rel}`]).trim();
      } catch {
        remoteSha = null; // not on origin/main at all yet
      }
      return remoteSha !== localSha;
    });
    if (unlanded.length === 0) return withAcknowledgement({ landed: false, files: [] });

    // Commit built against a SCRATCH index, never the caller's real one — the acknowledgement
    // above is the sole narrow working-tree mutation; this stays under W1-T60's isolation.
    scratchDir = mkdtempSync(join(tmpdir(), `rmd-${kind.branch}-`));
    const env = { ...process.env, GIT_INDEX_FILE: join(scratchDir, "index") };
    git(["read-tree", "origin/main"], { env });
    for (const rel of unlanded) {
      const blobSha = git(["hash-object", "-w", join(root, rel)], { env }).trim();
      git(["update-index", "--add", "--cacheinfo", `100644,${blobSha},${rel}`], { env });
    }
    const treeSha = git(["write-tree"], { env }).trim();
    return withAcknowledgement(finishLanding(kind, git, gh, mainSha, treeSha, unlanded, env, opts.ledgerLines));
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
  return landPending(root, FEEDBACK_LANDING_KIND, opts);
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
  const result = landPending(root, FEEDBACK_LANDING_KIND, { ...landOpts, reportAcknowledgement: true });
  if (log) {
    const acknowledgement = result.acknowledgement;
    const acknowledgementEvidence = acknowledgement
      ? {
          acknowledged_count: acknowledgement.count,
          acknowledged_paths: acknowledgement.paths,
          acknowledged_paths_truncated: acknowledgement.truncated,
        }
      : { acknowledged_count: 0 };
    if (result.pushed) {
      log("feedback.landing_sweep", {
        pushed: true,
        landed: result.landed,
        files: result.files,
        pr_url: result.prUrl,
        error: result.error,
        ...acknowledgementEvidence,
      });
    } else {
      log("feedback.landing_sweep", {
        pushed: false,
        landed: result.landed,
        file_count: result.files.length,
        ...acknowledgementEvidence,
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
    git(["fetch", "origin", "--quiet"]);
    const mainSha = git(["rev-parse", "origin/main"]).trim();

    scratchDir = mkdtempSync(join(tmpdir(), `rmd-${kind.branch}-`));
    const env = { ...process.env, GIT_INDEX_FILE: join(scratchDir, "index") };
    // Always start from fresh origin/main, never a possibly-stale pending branch — unrelated
    // content landed on main since must not be silently reverted by this force-push.
    git(["read-tree", "origin/main"], { env });

    // Carry forward whatever an earlier, still-unmerged call already pushed here (W1-T191
    // criterion 2): this content-only path has no disk to re-scan the way {@link landPending}
    // does, so without this a second call would drop the first call's content entirely.
    let pendingFiles: string[] = [];
    try {
      pendingFiles = git(["ls-tree", "-r", "--name-only", `origin/${kind.branch}`])
        .trim()
        .split("\n")
        .filter(Boolean)
        // Scoped to the directory this kind owns — unfiltered, this once reverted merged work
        // with a correct parent (PR #1025), caught only because the deletions broke the build.
        // Why: docs/forensics/feedback-landing.md#landcontent_scoped_carry_forward.
        .filter((f) => f.startsWith(`${kind.ownedDir}/`));
    } catch {
      pendingFiles = []; // no pending branch yet — nothing to carry forward
    }
    for (const f of pendingFiles) {
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

    const unlanded: string[] = [];
    let i = 0;
    for (const { relPath, content } of inputs) {
      // A scratch tmp file, never inside root — hash-object just needs a path to read from.
      const tmpFile = join(scratchDir, `content-${i++}`);
      writeFileSync(tmpFile, content);
      const blobSha = git(["hash-object", "-w", tmpFile], { env }).trim();
      let remoteSha: string | null;
      try {
        remoteSha = git(["rev-parse", `origin/main:${relPath}`]).trim();
      } catch {
        remoteSha = null; // not on origin/main at all yet
      }
      if (remoteSha === blobSha) continue; // already identical upstream — nothing to land
      git(["update-index", "--add", "--cacheinfo", `100644,${blobSha},${relPath}`], { env });
      unlanded.push(relPath);
    }
    if (unlanded.length === 0) return { landed: false, files: [] };

    const treeSha = git(["write-tree"], { env }).trim();
    return finishLanding(kind, git, gh, mainSha, treeSha, unlanded, env, opts.ledgerLines);
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
  return landContent(root, DECISIONS_LANDING_KIND, [{ relPath, content: decisionRecordContent(params) }], opts);
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
  return landContent(root, DECISIONS_LANDING_KIND, [{ relPath, content }], opts);
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
  return landContent(root, FEEDBACK_LANDING_KIND, [{ relPath, content }], opts);
}

/** The URL of the currently-open shared landing PR for `opts.branch` (default
 *  {@link LANDING_BRANCH}), if any — best-effort, `undefined` on any `gh` failure, same as "no PR
 *  yet". Also used by `rmd triage`'s exit-2 branch to name the pending PR instead of a misleading
 *  "no such feedback entry" (W1-T243 acceptance claim 4). */
export function findPendingLandingPr(opts: { gh?: GhExec; branch?: string } = {}): string | undefined {
  const gh = opts.gh ?? defaultGh();
  const branch = opts.branch ?? LANDING_BRANCH;
  try {
    const existing = JSON.parse(
      gh(["pr", "list", "--head", branch, "--state", "open", "--json", "url"]),
    ) as Array<{ url: string }>;
    return existing[0]?.url;
  } catch {
    return undefined;
  }
}
