/**
 * The deterministic, harness-owned docs/ORIENTATION.md regeneration STEP
 * (W1-T39). Extracted from `retroCommand` (src/run-task.ts) into its own
 * module so the mechanism itself — write, `git add`, commit-if-changed —
 * is independently exercisable against a REAL git worktree, not merely
 * described. Standing rule 13: "A doc that DESCRIBES a mechanism is never
 * proof the mechanism EXISTS." test/orientation.test.ts drives this against
 * a real temp git repo across two simulated retro passes and asserts the
 * actual `git show` diff of the second commit names the REFRESHED
 * state/next-task — the falsifier this module exists to make possible.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractStandingRules, renderOrientation, type RetroGather } from "./retro.js";
import type { Task } from "./plan.js";

export interface RegenerateOrientationOpts {
  /** The git worktree to write docs/ORIENTATION.md into and commit within. */
  worktreePath: string;
  /** ISO timestamp (or any caller-supplied label) stamped into the doc. */
  generatedAt: string;
  /** The same deterministic gather the retro's plan-sync PR is built from. */
  gather: RetroGather;
  /** The next runnable task (see {@link import("./drain.js").nextRunnable}), if any. */
  nextTask?: Task;
}

export interface RegenerateOrientationResult {
  /** Repo-relative path written (always `docs/ORIENTATION.md`). */
  relPath: string;
  /** The rendered content (whether or not it differed from what was on disk). */
  content: string;
  /** True iff content differed from HEAD and a new commit was made. */
  committed: boolean;
  /** `git show` of the new commit (patch + stat) — OMITTED when `committed` is false
   *  (nothing changed, so there is no new commit to show). Real, observable proof of
   *  the regeneration, not a description of it. */
  diff?: string;
}

const REL_PATH = "docs/ORIENTATION.md";

/**
 * Render docs/ORIENTATION.md from `opts.gather`/`opts.nextTask` + the
 * worktree's own MASTER-PLAN.md §12 Standing rules, write it, and — ONLY if
 * the content changed from what's currently committed — stage + commit it
 * as its own labeled commit ("rmd retro: regenerate docs/ORIENTATION.md").
 * Never relies on a caller to remember to `git add` it. Idempotent: calling
 * this twice with an UNCHANGED gather/nextTask produces `committed: false`
 * the second time (no spurious commit).
 */
export function regenerateOrientation(opts: RegenerateOrientationOpts): RegenerateOrientationResult {
  const { worktreePath, generatedAt, gather, nextTask } = opts;
  const standingRules = extractStandingRules(readFileSync(join(worktreePath, "MASTER-PLAN.md"), "utf8"));
  const content = renderOrientation({ generatedAt, gather, nextTask, standingRules });

  mkdirSync(join(worktreePath, "docs"), { recursive: true });
  writeFileSync(join(worktreePath, REL_PATH), content);
  execFileSync("git", ["-C", worktreePath, "add", REL_PATH]);

  try {
    execFileSync("git", ["-C", worktreePath, "diff", "--cached", "--quiet"]);
    // exit 0 ⇒ nothing staged ⇒ content is unchanged from HEAD; nothing to commit.
    return { relPath: REL_PATH, content, committed: false };
  } catch {
    // non-zero ⇒ staged changes exist ⇒ commit them as their own, clearly-labeled commit.
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "rmd retro: regenerate docs/ORIENTATION.md"]);
    const diff = execFileSync("git", ["-C", worktreePath, "show", "--stat=200", "-p", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return { relPath: REL_PATH, content, committed: true, diff };
  }
}
