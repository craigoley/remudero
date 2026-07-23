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
 * MECHANISM — plumbing only, and it NEVER touches the caller's own working tree, index,
 * or local branches (the W1-T60 rule: a background/library call must never mutate the
 * operator's checkout — `syncPlanFromOrigin`, run-task.ts, follows the identical
 * `git fetch` + read-only-blob discipline for the same reason). It fetches `origin/main`,
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
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FEEDBACK_REL_DIR = "plan/feedback";

/** The one shared branch every landing call force-pushes to (never a per-capture branch — no PR spam). */
export const LANDING_BRANCH = "feedback-landing";
/** The one shared PR title/head every landing call opens or reuses. */
export const LANDING_PR_TITLE = "chore(feedback): land pending filings";

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
}

export interface LandFeedbackResult {
  /** True iff at least one file was pushed to the landing branch by THIS call. */
  landed: boolean;
  /** Repo-relative, forward-slash paths landed this call (empty when `landed` is false). */
  files: string[];
  /** The landing PR url, when known (freshly opened, or an already-open one reused). */
  prUrl?: string;
  /** Set only when landing was attempted but failed — never thrown, always swallowed by the caller. */
  error?: string;
}

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

/** Every file under `<root>/plan/feedback/` (recursively — entries AND their attachments), repo-relative. */
function listFeedbackFiles(root: string): string[] {
  const dir = join(root, FEEDBACK_REL_DIR);
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
  walk(dir, FEEDBACK_REL_DIR);
  return out;
}

/**
 * Best-effort land any `plan/feedback/**` file present in `root` but absent or changed on
 * `origin/main`, onto the one shared gated landing PR. NEVER throws: every failure — not a
 * git checkout, no `origin` remote, offline, `gh` unavailable/unauthenticated — resolves to
 * `{ landed: false, files: [], error }` instead.
 */
export function landFeedback(root: string, opts: LandFeedbackOpts = {}): LandFeedbackResult {
  const git = opts.git ?? defaultGit(root);
  const gh = opts.gh ?? defaultGh();
  let scratchDir: string | undefined;

  try {
    git(["fetch", "origin", "--quiet"]);
    const mainSha = git(["rev-parse", "origin/main"]).trim();

    const unlanded = listFeedbackFiles(root).filter((rel) => {
      const localSha = git(["hash-object", join(root, rel)]).trim();
      let remoteSha: string | null;
      try {
        remoteSha = git(["rev-parse", `origin/main:${rel}`]).trim();
      } catch {
        remoteSha = null; // not on origin/main at all yet
      }
      return remoteSha !== localSha;
    });
    if (unlanded.length === 0) return { landed: false, files: [] };

    // Build the new commit against a SCRATCH index — never the caller's real index/working
    // tree (W1-T60: this module must never mutate the operator's own checkout).
    scratchDir = mkdtempSync(join(tmpdir(), "rmd-feedback-landing-"));
    const env = { ...process.env, GIT_INDEX_FILE: join(scratchDir, "index") };
    git(["read-tree", "origin/main"], { env });
    for (const rel of unlanded) {
      const blobSha = git(["hash-object", "-w", join(root, rel)], { env }).trim();
      git(["update-index", "--add", "--cacheinfo", `100644,${blobSha},${rel}`], { env });
    }
    const treeSha = git(["write-tree"], { env }).trim();
    const message = [
      LANDING_PR_TITLE,
      "",
      "Data-only: no code, no plan/tasks.yaml edits, no triage. Each entry keeps its",
      "existing status. Automated by the durable-inbox commit bridge (W1-T243) — this",
      "step used to be a hand-run `git add`+commit+PR before every `rmd triage`.",
      "",
      ...unlanded.map((f) => `- ${f}`),
    ].join("\n");
    const commitSha = git([
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
    ]).trim();

    // ONE shared branch, always rebuilt from origin/main's CURRENT tip — force-push is
    // safe (and required) because this branch is bot-owned and never diverges by history,
    // only by content, so it can never actually conflict.
    git(["push", "--force", "origin", `${commitSha}:refs/heads/${LANDING_BRANCH}`]);

    let prUrl = findPendingLandingPr({ gh });
    if (!prUrl) {
      const ids = unlanded
        .filter((f) => f.startsWith(`${FEEDBACK_REL_DIR}/`) && f.endsWith(".yaml"))
        .map((f) => f.slice(FEEDBACK_REL_DIR.length + 1, -".yaml".length));
      const body = [
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
      try {
        const out = gh([
          "pr",
          "create",
          "--base",
          "main",
          "--head",
          LANDING_BRANCH,
          "--title",
          LANDING_PR_TITLE,
          "--body",
          body,
        ]);
        prUrl = out.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
      } catch (e) {
        // Pushed fine, opening the PR failed (no `gh`, no auth) — still landed on the
        // branch; a future call (or a human `gh pr create`) can pick the PR up from there.
        return {
          landed: true,
          files: unlanded,
          error: `pushed to ${LANDING_BRANCH} but \`gh pr create\` failed: ${String((e as Error)?.message ?? e)}`,
        };
      }
    }
    if (prUrl) {
      try {
        gh(["pr", "merge", prUrl, "--auto", "--squash"]);
      } catch {
        // Best-effort — the ci + remudero-review gate decides; GitHub does the merging
        // either way (Standing rule 3B), this call only arms auto-merge when it can.
      }
    }
    return { landed: true, files: unlanded, prUrl };
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
 * The URL of the currently-open shared landing PR, if any — best-effort, never throws
 * (a missing/unauthenticated `gh` resolves to `undefined`, same as "no PR yet"). Used both
 * by {@link landFeedback} (to reuse rather than duplicate an open PR) and by `rmd
 * triage`'s exit-2 branch (to name the pending PR instead of the misleading "no such
 * feedback entry" — W1-T243 acceptance claim 4).
 */
export function findPendingLandingPr(opts: { gh?: GhExec } = {}): string | undefined {
  const gh = opts.gh ?? defaultGh();
  try {
    const existing = JSON.parse(
      gh(["pr", "list", "--head", LANDING_BRANCH, "--state", "open", "--json", "url"]),
    ) as Array<{ url: string }>;
    return existing[0]?.url;
  } catch {
    return undefined;
  }
}
