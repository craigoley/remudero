/**
 * lib/feedback-landing.ts — the durable-inbox COMMIT BRIDGE (W1-T243).
 *
 * `captureFeedback()` (feedback.ts) is a PURE FILESYSTEM WRITE — the entry lands only in
 * whatever checkout ran the capture. `rmd triage` deliberately reads the entry from a
 * FRESH origin/main worktree (never `repoRoot`, which may be stale) — so a captured entry
 * was invisible to triage until a human hand-landed it via `git add` + commit + PR (the
 * `chore(feedback): land ...` precedent: PRs #591/#609/#611). NO STEP BETWEEN CAPTURE AND
 * TRIAGE COMMITTED THE ENTRY — this module is that step.
 *
 * {@link landFeedback} is the ONE choke point `captureFeedback()` calls right after its
 * write (never per-caller), so all five call sites (cli, ops alerts, issues intake,
 * panel UI, panel grill) inherit it by construction — a sixth caller inherits it too, for
 * free, just by calling `captureFeedback()`.
 *
 * BEST-EFFORT, NEVER THROWS: the local write already satisfies §7B's durability promise
 * the instant `writeFileSync` returns (an entry survives a machine reboot, is diffable,
 * grep-able); landing merely gets it onto `origin/main` sooner so triage can act on it.
 * Any failure here — no git repo, no `origin` remote, no network, no/unauthenticated
 * `gh` — is swallowed: capture must never fail because landing is unavailable (W1-T243
 * acceptance claim 3). A later capture (or a manual `rmd feedback land`, not yet built)
 * retries the same unlanded files.
 *
 * MECHANISM — plumbing only. It NEVER touches the caller's index, tracked files, or local
 * branches (the W1-T60 rule: a background/library call must not mutate operator work). The one
 * narrow working-tree mutation is the W1-T2749 queue acknowledgement: after fetching
 * `origin/main`, an untracked `plan/feedback/**` copy is removed only when Git proves the same
 * bytes are already durable at that exact upstream path. It fetches `origin/main`,
 * diffs the local `plan/feedback/**` tree against it, and — only for files that actually
 * differ — builds one new commit against a SCRATCH index (`GIT_INDEX_FILE`, never the
 * repo's real index) via `hash-object`/`write-tree`/`commit-tree`, then force-pushes it to
 * ONE shared branch (`feedback-landing`) and opens (or reuses) ONE gated PR for it — never
 * a direct push to `main` (the §2 gate invariant: "the Architect proposes, merges
 * nothing"). Rebuilding the branch fresh from origin/main's CURRENT tip every call means
 * it can never conflict and never accumulates history — it is always exactly
 * "origin/main plus whatever plan/feedback/** content is still unlanded locally".
 */

import { execFileSync } from "node:child_process";
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
 * `plan/decisions.d` — the decision-record sibling of `plan/feedback` (W1-T191). One file PER
 * RESOLUTION (`<taskId>-<runId>.md`), never a shared growing log: `decision.autochoose`
 * (run-task.ts) used to append every resolution straight into THIS checkout's own
 * `DECISIONS.md`, which no PR was ever cut from — the exact "capture lands locally, nothing
 * commits it" defect W1-T243 already fixed for feedback. Sharding (rather than moving the
 * shared-file append into a worker's worktree) is the deliberate choice: two concurrent
 * `run-task` orchestrators each appending a line to the SAME file's end, merged one after the
 * other, is a textbook git append-conflict (the exact class W1-T122 solved for
 * `plan/tasks.yaml` by sharding) — a per-decision file makes that structurally impossible
 * instead of retrying around it.
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
   * Injectable `gh` exec (the W1-T119 `ghGateway` pattern, lib/status.ts) — real callers
   * omit it and get the actual `execFileSync("gh", ...)`; tests inject a fake so
   * PR-open/list/merge never hits real GitHub, while the `git` half above still runs for
   * real against a local bare "origin".
   */
  gh?: GhExec;
  /**
   * W1-T1000002 — the SAME hold reader the sweep's own arm path consults
   * ({@link import("./review.js").automergeHoldFromLedger}), so this file's inline
   * `gh pr merge --auto --squash` (the ONE arm-origin site {@link ensurePrOpen} owns — recon
   * question (3) of that task's rationale: this call bypasses `attemptArm`/`armAutoMerge`
   * entirely, reaching neither) honours a standing operator hold instead of arming around it.
   * Optional: omitted (every pre-existing caller/fixture), a landing PR arms exactly as it did
   * before this task — fail OPEN, matching every other optional evidence read in this codebase.
   * A hold engaged AFTER this PR was already created and armed is still caught by the sweep's
   * own converging disarm (lib/sweep.ts), which reconciles every open PR, including this one.
   */
  ledgerLines?: () => Array<Record<string, unknown>>;
}

export interface LandFeedbackResult {
  /** True iff the content is ON the landing branch — pushed by this call, or already there from
   *  an earlier one (see finishLanding's already-landed short-circuit). The one consumer renders
   *  this to an operator as "landed" vs "landing pending", and content sitting on the branch
   *  awaiting its gate is landed. */
  landed: boolean;
  /** Repo-relative, forward-slash paths landed this call (empty when `landed` is false). */
  files: string[];
  /** The landing PR url, when known (freshly opened, or an already-open one reused). */
  prUrl?: string;
  /** Set only when landing was attempted but failed — never thrown, always swallowed by the caller. */
  error?: string;
  /**
   * True iff THIS call actually force-pushed the landing branch (new or changed content).
   * False for every no-op path: nothing unlanded (`landed: false`), and the ALREADY-LANDED
   * short-circuit in {@link finishLanding} (`landed: true` with the same content already on
   * the branch, awaiting its gate). {@link sweepFeedbackLanding} uses this to tell an ACTING
   * pass (worth a detailed ledger line) from a QUIET one (worth a summary at most) — see its
   * own doc for why that split exists (W1-T530).
   */
  pushed?: boolean;
  /**
   * Present only when this call removed one or more redundant, untracked queue copies after
   * fetched `origin/main` proved their bytes durable at the same paths. `count` is exact while
   * `paths` is deliberately bounded so one large inbox cannot create an unbounded ledger line.
   */
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
  return (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Remove only redundant UNTRACKED queue copies whose exact bytes are already readable from the
 * fetched `origin/main`. Every comparison is independent: a missing/corrupt object, a racing
 * path, or a failed unlink leaves that path untouched without suppressing the rest of the inbox.
 */
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
    return undefined;
  }

  const acknowledged: string[] = [];
  for (const rel of untracked) {
    try {
      // Re-check the index immediately before the destructive step. The initial enumeration is
      // not authority if another local actor tracked the path while this pass was running.
      if (git(["ls-files", "--", rel]).trim() !== "") continue;
      const remoteSha = git(["rev-parse", `origin/main:${rel}`]).trim();
      git(["cat-file", "-e", `${remoteSha}^{blob}`]);
      const localSha = git(["hash-object", join(root, rel)]).trim();
      if (localSha !== remoteSha) continue;
      unlinkSync(join(root, rel));
      acknowledged.push(rel);
    } catch {
      // This is a queue acknowledgement, never authority to discard an unproved path. The
      // ordinary landing scan below still gets its independent chance to submit the remainder.
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
 *  {@link finishLanding}); only the branch name, the human-facing commit/PR text, and (for a
 *  disk-scanning kind) which directory it walks differ. */
interface LandingKind {
  branch: string;
  /**
   * The ONE repo-relative directory this kind owns. The carry-forward below is filtered to
   * it, so a landing can only ever re-stage its OWN records — never arbitrary repo content
   * that happens to differ between the stale landing branch and current origin/main.
   */
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

/**
 * The commit/push/open-or-reuse-PR/arm-auto-merge tail every landing call shares, regardless
 * of how its tree was built (a real working-tree scan for {@link landPending}, or purely
 * in-memory content for {@link landContent}). NEVER throws on its own — callers already run
 * inside a try/catch that folds any error into `{ landed: false, error }`, except the
 * `gh pr create` failure below, which still counts as `landed: true` (the push already
 * succeeded).
 */
/**
 * The tree the landing branch currently carries on the remote, or `null` when that cannot be
 * determined. `null` means "push" — never "skip" — so an unreadable ref degrades to the previous
 * unconditional-push behaviour rather than silently withholding a landing.
 */
/**
 * W1-T1000002 — ANCHORED ON `/pull/<n>`, mirroring run-task.ts's own `prUrlTarget` /
 * review.ts's own `prLifecycleUrlTarget` — duplicated locally rather than imported (this file
 * must not import run-task.ts, and review.ts's own copy is private) so each consumer reads the
 * URL on its own terms, the SAME "each file reads on its own terms" idiom review.ts's own copy
 * already documents. Returns `undefined` — never a guess — on anything that is not a PR URL.
 */
function landingPrNumberFromUrl(prUrl: string): number | undefined {
  const m = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl.trim());
  return m ? Number(m[1]) : undefined;
}

function remoteBranchTree(git: GitExec, branch: string): string | null {
  try {
    return git(["rev-parse", `origin/${branch}^{tree}`]).trim();
  } catch {
    return null;
  }
}

/**
 * Open (or reuse) the ONE shared PR for `kind.branch`'s CURRENT tip. Shared by both
 * `finishLanding` branches below (W1-T530): the fresh-push path (content just changed) and the
 * ALREADY-LANDED short-circuit (content unchanged but no PR was ever successfully opened for it
 * — the "pushed fine, `gh pr create` failed" retry gap this split closes). Never pushes anything
 * itself — the caller already decided whether a push was needed.
 *
 * ALREADY-OPEN IS A ONE-CALL NO-OP (`gh pr list` only, no create/merge): auto-merge is armed
 * only in the SAME call that actually creates the PR, never re-armed on a later call that finds
 * it already open. Without this, EVERY quiet pass over an already-open PR would re-issue
 * `gh pr merge` — a repeated `gh` MUTATION call on a pass this task's own acceptance requires do
 * nothing observable (criterion 3).
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
    // Content is (or was already) on the branch — only opening the PR failed (no `gh`, no
    // auth). A future call (or a human `gh pr create`) can pick the PR up from there.
    return { error: `\`gh pr create\` failed for ${kind.branch}: ${String((e as Error)?.message ?? e)}` };
  }
  if (prUrl) {
    // W1-T1000002 — THE SAME HOLD READER THE SWEEP'S ARM PATH CONSULTS, at the ONE site this
    // file ever arms auto-merge (recon question (3): this call reaches neither `attemptArm` nor
    // `armAutoMerge`, so it needed its own consult rather than inheriting one). Omitted
    // `ledgerLines` fails OPEN — arms exactly as before this task.
    const prNumber = landingPrNumberFromUrl(prUrl);
    const hold = ledgerLines && prNumber !== undefined ? automergeHoldFromLedger(ledgerLines(), prNumber) : undefined;
    if (!hold) {
      try {
        assertLiveWriteAllowed("gh-pr-merge", `arming auto-merge on ${prUrl}`);
        gh(["pr", "merge", prUrl, "--auto", "--squash"]);
      } catch {
        // Best-effort — the ci + remudero-review gate decides; GitHub does the merging
        // either way (Standing rule 3B), this call only arms auto-merge when it can.
      }
    }
  }
  return { prUrl };
}

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
  // ── ALREADY-LANDED SHORT-CIRCUIT: push only when the CONTENT differs. ────────────────────────
  // The tree is deterministic — `read-tree origin/main` plus the same blobs yields the same
  // `treeSha` on every call for unchanged content. The COMMIT is not: `commit-tree` stamps the
  // current time, so an unchanged landing minted a fresh sha and force-pushed it EVERY call.
  //
  // MEASURED ON PR #1113, and it is a deadlock rather than mere noise. The daemon calls this each
  // poll, so the branch head moved every ~60s (`02e270a4 → 187cf42f → 379c4160 → fa15cc73` in four
  // minutes, one commit each, identical message). Every push cancelled the in-flight CI run —
  // `CI gate 16:28:37 -> CANCELLED 16:29:51`, superseded before it could finish — so `ci-gate`, a
  // REQUIRED context, could never complete and `remudero-review` never posted (`count=0`, no
  // settled sha to post against). The PR therefore could not merge, which kept the files unlanded,
  // which kept this function pushing. Self-sustaining.
  //
  // Comparing the TREE and not the commit is the whole point: the commit sha is guaranteed to
  // differ, the tree is guaranteed not to. A parent-only difference (origin/main moved under an
  // unchanged landing) deliberately does NOT force a push either — protection is `strict: false`,
  // so a behind-but-mergeable branch is fine, and re-pushing to advance the parent is exactly the
  // churn this removes.
  //
  // FAILS OPEN: an unreadable/absent remote ref (the first landing for this branch, or no
  // remote-tracking ref configured) falls through to the push, i.e. to the previous behaviour.
  //
  // W1-T530: unchanged content does not mean nothing is left to do — a PRIOR call may have
  // pushed this exact tree and then had its OWN `gh pr create` fail (offline `gh`, no auth).
  // Without retrying the PR here, that entry sits on the branch forever with no open PR and no
  // further push ever fires again for IDENTICAL content — exactly the retry gap this task's
  // level-triggered sweep exists to close. `ensurePrOpen` is a no-op besides one `gh pr list`
  // when a PR is already open (the common case), so this costs nothing on a truly quiet pass.
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

  // ONE shared branch per kind, always rebuilt from origin/main's CURRENT tip — force-push
  // is safe (and required) because this branch is bot-owned and never diverges by history,
  // only by content, so it can never actually conflict.
  // #954 GUARD, CARRIED ACROSS THE finishLanding REFACTOR: main added this inline to the body
  // this function replaced, so the merge had to move it WITH the code — resolving to either
  // side alone would have silently dropped it and reopened the hole #954 closed.
  assertLiveWriteAllowed("git-push", `force-pushing the ${kind.branch} branch`);
  git(["push", "--force", "origin", `${commitSha}:refs/heads/${kind.branch}`]);

  const { prUrl, error } = ensurePrOpen(kind, gh, unlanded, ledgerLines);
  if (error) {
    // Pushed fine, opening the PR failed (no `gh`, no auth) — still landed on the branch; a
    // future call (or a human `gh pr create`) can pick the PR up from there. `pushed: true`
    // because the branch content itself DID move this call — see LandFeedbackResult.pushed.
    return { landed: true, files: unlanded, error: `pushed to ${kind.branch} but ${error}`, pushed: true };
  }
  return { landed: true, files: unlanded, prUrl, pushed: true };
}

/**
 * Best-effort acknowledge any byte-identical, untracked queue copy already on fetched
 * `origin/main`, then land every remaining `plan/feedback/**` file present in `root`'s REAL
 * working tree but absent or changed upstream onto the shared `feedback-landing` PR. NEVER throws:
 * every failure — not a git checkout, no `origin` remote, offline, `gh`
 * unavailable/unauthenticated — resolves to `{ landed: false, files: [], error }` instead.
 * Scans disk because `captureFeedback`'s local copy is the durable buffer §7B promises even
 * offline — unlike {@link landContent}, this one legitimately needs a real file to read.
 */
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

    // Build the new commit against a SCRATCH index — never the caller's real index or tracked
    // work. W1-T2749's proved-redundant untracked queue acknowledgement above is the sole narrow
    // working-tree mutation; the landing commit itself retains W1-T60's isolation.
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
 * THE LEVEL-TRIGGERED BACKSTOP OVER {@link landFeedback} (W1-T530, ratifies P22 the same way
 * `sweep.credit_backfill` already did for merge credit). `landFeedback` is the bridge's
 * mechanism and it is already correct and idempotent (see its own doc); the ONE thing missing
 * is a caller that runs it when no capture is happening at all — `captureFeedback` (feedback.ts)
 * is its only call site, so an entry captured while landing was unavailable (offline, no `gh`,
 * `gh pr create` refused — all swallowed by contract) or on a host that never captures again is
 * stranded off `origin/main` forever, and `rmd triage` refuses it as not-on-origin because it
 * deliberately reads from a fresh origin/main worktree, never `root`.
 *
 * A THIN WRAPPER, NOT A REWRITE: this re-runs the same whole-inbox scan/reconcile and reports
 * W1-T2749's exact-byte queue acknowledgements — nothing about the scratch-index discipline
 * (W1-T60), the
 * rebuild-from-current-origin/main force-push, or the shared `feedback-landing` branch/PR
 * changes. Calling it twice over unchanged state is safe by the SAME idempotence
 * `findPendingLandingPr` + the tree-compare short-circuit in {@link finishLanding} already give
 * `landFeedback` — see {@link LandFeedbackResult.pushed}. Best-effort like every other rung
 * beside it (`sweep`/`sweepOrphans`/`alertPoll`, daemon.ts): a throw here never reaches the
 * caller, resolving instead to `landFeedback`'s own `{ landed: false, files: [], error }`.
 *
 * OBSERVABILITY IS THE ACTING/QUIET SPLIT `sweep.credit_backfill` already uses (sweep.ts): a
 * pass that actually force-pushed new/changed content (`pushed: true`) names the files landed
 * and the PR url — that is the one line worth reading. A pass that pushed nothing — nothing
 * unlanded at all, OR the same content already sitting on the branch awaiting its gate — logs a
 * count-only summary instead, so the daemon's own poll cadence (as low as tens of seconds)
 * cannot flood the ledger with a repeated file list for content that has not changed since the
 * last time this ran.
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
 * The IN-MEMORY sibling of {@link landPending}: lands explicit `(path, content)` pairs that
 * are NEVER written to `root`'s real working tree — not merely "untouched after writing"
 * (landPending's guarantee for feedback's own local durable copy) but literally never written
 * there at all. This is the piece that makes W1-T191 actually work: a real local write of an
 * ALREADY-TRACKED file (a status flip) or a brand-new one (a decision record) would itself
 * count as dirt in `checkCliFreshness`'s `git status --porcelain` the instant it lands on
 * disk — landing it via a bridge afterward doesn't undo that, since the bridge (by design,
 * the W1-T60 rule) never touches the working tree either. So the fix is to never put it there
 * to begin with: content is staged into a scratch tmp file OUTSIDE `root` (under `os.tmpdir()`)
 * purely so `git hash-object -w` has a path to read bytes from — the blob it writes goes to
 * the repo's OBJECT DATABASE (`root/.git/objects`), never to `root`'s working tree. Same
 * skip-if-already-identical-upstream idempotence and NEVER-THROWS contract as
 * {@link landPending}.
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
    // Always start from FRESH origin/main (never a possibly-stale pending branch — unrelated
    // content that landed on main since an earlier still-open landing PR must not be
    // silently reverted by this force-push).
    git(["read-tree", "origin/main"], { env });

    // CARRY FORWARD whatever an EARLIER, still-unmerged call already pushed to this shared
    // branch (W1-T191 acceptance criterion 2): unlike {@link landPending} (which naturally
    // re-includes an earlier call's still-pending files on every re-scan of `root`'s real
    // disk), this content-only path has no disk to re-scan — without this, a second call
    // landing before the first call's PR merges would force-push a tree missing the first
    // call's content entirely, silently discarding it. Anything already merged into
    // origin/main is skipped (no need to carry forward what's already landed for real).
    let pendingFiles: string[] = [];
    try {
      pendingFiles = git(["ls-tree", "-r", "--name-only", `origin/${kind.branch}`])
        .trim()
        .split("\n")
        .filter(Boolean)
        // SCOPED TO THE DIRECTORY THIS KIND OWNS. `ls-tree -r` lists the branch's ENTIRE repo
        // tree, and the branch was built from an OLDER origin/main, so every file that changed
        // on main since carries a differing blob. Unfiltered, the loop below re-staged each of
        // them at its STALE value -- a silent revert of merged work with a correct parent, which
        // is exactly what commit e8443ad (PR #1025) shipped on 2026-07-31: it reverted 6 src/
        // and 2 test/ files (-515 lines, undoing PRs #1020/#1008/#1017) plus 274 lines of the
        // append-only DECISIONS.md, and was caught only because the deletions happened not to
        // compile. Carrying forward anything outside this directory is never correct: the bridge
        // owns these records and nothing else.
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
      // A scratch tmp file, never inside `root` — `git hash-object` just needs a path to
      // read; where it lives is irrelevant to the blob it writes.
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

/**
 * `<root>/plan/decisions.d/<taskId>-<runId>.md` — one file per decision.autochoose resolution
 * (never a shared growing log), so concurrent `run-task` runs across different tasks/runs can
 * never collide on the same path. Never actually written to disk (see {@link recordDecision})
 * — this is the path it lands at on `origin/main`, via the `decisions-landing` bridge.
 */
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

/** Pure — the exact human-readable body `DECISIONS.md`'s append used to carry, unchanged in
 *  substance, just now the sole content of its own shard rather than one more line on a
 *  shared growing file. */
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

/**
 * Land one decision-record shard (harness-owned, deterministic — never delegated to the
 * worker's own commit, which the resume prompt never even mentions) via {@link landContent}.
 * DELIBERATELY never writes `plan/decisions.d/**` to `root`'s real working tree at all — see
 * {@link landContent}'s own doc for why a real local write would itself be the dirt this task
 * removes. Best-effort like every other write in this module: a landing failure (offline, no
 * `gh`) means the record exists ONLY as the `decision.autochoose` ledger line (already
 * ledgered regardless — the RECEIPT half of standing rule 22's receipt/claim split) until a
 * later resolution's call retries; there is no local file for a human to grep in the meantime,
 * which is the one durability property this trades away in exchange for never dirtying the
 * checkout (out of scope here — see the accompanying follow-up).
 */
export function recordDecision(
  root: string,
  params: DecisionRecordParams,
  opts: LandFeedbackOpts = {},
): LandFeedbackResult {
  const relPath = decisionRecordRelPath(params.taskId, params.runId);
  return landContent(root, DECISIONS_LANDING_KIND, [{ relPath, content: decisionRecordContent(params) }], opts);
}

/**
 * Land one feedback entry's already-serialized YAML content via {@link landContent} — the
 * write-site-2 (console `POST /v1/feedback/decision`) sibling of {@link recordDecision}.
 * DELIBERATELY never writes to `root`'s real working tree: `setFeedbackStatus` calls this
 * INSTEAD OF its normal `writeFileSync` when `opts.land` is set, because writing the flip to
 * an ALREADY-TRACKED file locally would leave it `M`-modified in `checkCliFreshness`'s `git
 * status --porcelain` — the exact dirt W1-T191 removes — even though `landFeedback`'s bridge
 * would separately get it onto `origin/main`. The trade: a caller that reads `root`'s own
 * `plan/feedback/<id>.yaml` again right after (e.g. the console's own feedback list) won't see
 * the flip until this checkout's next self-sync past the landing PR's merge — out of scope for
 * this task's acceptance bar (a clean working tree, not read-your-own-write), noted as a
 * follow-up.
 */
export function landFeedbackStatusContent(
  root: string,
  relPath: string,
  content: string,
  opts: LandFeedbackOpts = {},
): LandFeedbackResult {
  return landContent(root, FEEDBACK_LANDING_KIND, [{ relPath, content }], opts);
}

/**
 * The URL of the currently-open shared landing PR for `opts.branch` (default
 * {@link LANDING_BRANCH}), if any — best-effort, never throws (a missing/unauthenticated `gh`
 * resolves to `undefined`, same as "no PR yet"). Used by {@link landFeedback}/
 * {@link landDecisions} (to reuse rather than duplicate an open PR) and by `rmd triage`'s
 * exit-2 branch (to name the pending feedback-landing PR instead of the misleading "no such
 * feedback entry" — W1-T243 acceptance claim 4).
 */
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
