#!/usr/bin/env node
// scripts/credit-surface-gate.mjs
//
// AUTHOR-TIME CREDIT-SURFACE GATE (W1-T1214).
//
// W1-T1012 (#2240) fixed the harness's OWN commits: `appendTaskTrailerToCommit` (src/run-task.ts)
// amends the `Remudero-Task: <id>` trailer onto the tip of a run the harness itself pushes. But
// that function is called at exactly two sites — the implement lane and the retro lane — both
// INSIDE the harness run loop. A branch pushed BY HAND from an operator lane's scratch worktree
// never enters that loop, so its commit is never amended, and a descriptive branch name (`fix/…`,
// `retro/…`, `ci/…`) carries no `run-<taskId>-<epochMs>` head-ref credit either. Measured in the
// task shard this script implements: since W1-T1012 merged, eight of eighty implementation-shaped
// merges to `origin/main` landed credited on NEITHER surface. Nothing anywhere refused them.
//
// THE DELIVERABLE IS THE REFUSAL, NOT THE APPEND (design (i)). Whichever seam is eventually
// chosen for WRITING the trailer onto a hand-pushed branch (push-time amend vs. merge-time
// compose — deliberately left open, see the task shard's rationale (7)/design (v)), a pull
// request whose merge would land credited on neither surface can be refused TODAY, and doing so
// does not pre-empt that seam choice.
//
// THE PREDICATE IS A DISJUNCTION OVER TWO EXISTING RULES, NEVER A THIRD ONE (design (ii)/(iv)):
// either the head commit carries an anchored `^Remudero-Task: <id>$` trailer, or the head ref
// matches the fleet's own dispatched-run shape (`run-<taskId>-<epochMs>`). Either alone is enough,
// because either alone is already enough for the READERS (`findMergedByTrailer`,
// `findMergedByHeadBranch`/`ownsBranch`) — this file adds no new credit vocabulary and does not
// touch either reader. `isDispatchedRunBranch` is imported straight out of `src/run-task.ts`
// rather than re-spelled, so the "is this a run branch" shape has exactly one home.
//
// IT MUST NOT FIRE ON A FILING (design (iii)). A plan/docs/feedback/triage pull request carries no
// trailer BY RULE (W1-T1004) — refusing one for lacking a trailer would be the exact false-credit
// defect W1-T1004 exists to prevent. `LINT_FILING_SUBJECT_RE` (src/run-task.ts,
// `classifyFailingMergeEvidence`'s own classifier) is imported and applied to the head commit's
// SUBJECT before either credit limb is even asked, so a filing is exempt independent of whether it
// happens to carry a trailer or sit on a run-shaped branch.
//
// OUT OF SCOPE, ON PURPOSE (design (v)): which seam appends the trailer to a hand-pushed branch;
// W1-T1012's harness append; W1-T1004's filing rule; back-crediting the eight already-merged
// uncredited commits; wiring this script into a CI workflow step (a separate PR, same pattern
// `scripts/acceptance-author-gate.mjs`/the coverage-ratchet producer already follow — this
// producer's diff stays free of any `.github/workflows/*.yml` edit).
//
// Usage (CI, once wired): node --import tsx scripts/credit-surface-gate.mjs --head-ref <ref>
//   (falls back to $GITHUB_HEAD_REF, which GitHub Actions sets automatically for a
//   `pull_request`-triggered job — no extra API call) with the worktree checked out at the PR's
//   actual head sha, so `git log -1 --format=%B` reads the real head commit message.
// Usage (local/test): node --import tsx scripts/credit-surface-gate.mjs --head-ref <ref> --worktree-path <path>

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { LINT_FILING_SUBJECT_RE, isDispatchedRunBranch } from "../src/run-task.ts";

// Re-exported for callers/tests that want the exact shape this gate reuses, without a second
// import of all of src/run-task.ts just to name it.
export { LINT_FILING_SUBJECT_RE, isDispatchedRunBranch };

/**
 * The SAME anchored `Remudero-Task: <id>` line shape `appendTaskTrailerToCommit`/
 * `creditsByAnchoredTrailer` (src/run-task.ts, src/lib/status.ts) already construct per-call via
 * `new RegExp(\`^Remudero-Task:\\s*${escapeRegExp(taskId)}\\s*$\`, "m")` — this gate has no
 * expected task id to anchor against (it asks "is THIS commit credited on SOME id", not "credited
 * for taskId X"), so it mirrors the same anchor and id character class as src/lib/status.ts's own
 * (unexported) `TRAILER_RE` rather than inventing a looser or stricter one.
 */
const CREDIT_TRAILER_RE = /^Remudero-Task:[ \t]*[A-Za-z0-9-]+[ \t]*$/m;

/**
 * Is `subject` (a commit's first line) a filing-family subject — citing a task rather than
 * implementing it? Thin wrapper over the imported {@link LINT_FILING_SUBJECT_RE} so callers never
 * need to know it is a regex, matching {@link isDispatchedRunBranch}'s own already-a-function shape.
 * @param {string} subject
 */
export function isFilingShapedSubject(subject) {
  return LINT_FILING_SUBJECT_RE.test((subject ?? "").trim());
}

/**
 * Does `commitMessage` carry an anchored `Remudero-Task: <id>` trailer line (any id)?
 * @param {string} commitMessage
 */
export function hasCreditTrailer(commitMessage) {
  return CREDIT_TRAILER_RE.test(commitMessage ?? "");
}

/**
 * THE GATE'S OWN PREDICATE (design (ii)/(iii)): classify the head commit's subject first — a
 * filing is exempt outright, independent of either credit limb — then ask the disjunction. Pure
 * over its inputs; never reads git/env itself (see {@link main}/{@link readHeadCommitMessage} for
 * the impure edges), so this is trivially unit-testable with fixture strings.
 *
 * Returns `{ ok: true, message }` when either credit limb (or the filing exemption) is satisfied,
 * `{ ok: false, defect: "uncredited-merge", message }` otherwise — the message NAMES BOTH ways to
 * satisfy it (design (i): "a message naming both ways to satisfy it"), never only the one the
 * caller happens to be closer to.
 * @param {{ headCommitMessage: string, headRef: string | undefined }} input
 */
export function evaluateCreditSurfaceGate({ headCommitMessage, headRef }) {
  const message = headCommitMessage ?? "";
  const subject = message.split("\n")[0] ?? "";

  if (isFilingShapedSubject(subject)) {
    return {
      ok: true,
      message:
        `filing-shaped subject "${subject.trim()}" carries no Remudero-Task trailer by rule ` +
        `(W1-T1004) — exempt from the credit-surface check`,
    };
  }

  const trailered = hasCreditTrailer(message);
  const runShaped = isDispatchedRunBranch(headRef);

  if (trailered && runShaped) {
    return { ok: true, message: "credited on both surfaces: the head commit's Remudero-Task trailer and its run-shaped head ref" };
  }
  if (trailered) {
    return { ok: true, message: "credited via the head commit's Remudero-Task trailer" };
  }
  if (runShaped) {
    return { ok: true, message: `credited via its run-shaped head ref (${headRef})` };
  }

  return {
    ok: false,
    defect: "uncredited-merge",
    message:
      "REFUSED — this merge would land credited on NEITHER surface. Satisfy either: " +
      "(1) carry an anchored `Remudero-Task: <id>` trailer on the head commit, or " +
      "(2) push to a `run-<taskId>-<epochMs>` head ref (either is enough — see W1-T1214).",
  };
}

/**
 * The worktree's actual HEAD commit message, read fresh from git — never re-derived, so a caller
 * cannot drift from what will actually be squash-merged. Best-effort: returns `undefined` on any
 * git failure rather than throwing, matching {@link "../src/run-task.js".lastCommitSubject}'s own
 * contract at the analogous call site.
 * @param {string} worktreePath
 */
export function readHeadCommitMessage(worktreePath) {
  try {
    return execFileSync("git", ["-C", worktreePath, "log", "-1", "--format=%B"], { encoding: "utf8" });
  } catch {
    return undefined;
  }
}

/**
 * Resolve the PR's head ref from the flag, falling back to `$GITHUB_HEAD_REF` — the env var GitHub
 * Actions sets automatically on a `pull_request`-triggered job, so this costs no event-payload
 * parse and no API call (the same "no extra call" property `scripts/acceptance-author-gate.mjs`'s
 * own doc insists on for its own inputs).
 *
 * EXTRACTED AND PURE so its refusal arm is reachable from a test, the same
 * extraction-and-injection shape `scripts/acceptance-author-gate.mjs`'s `resolveEventPath` uses.
 * @param {string | undefined} flagValue
 * @param {Record<string, string | undefined>} env
 */
export function resolveHeadRef(flagValue, env = process.env) {
  const headRef = flagValue ?? env.GITHUB_HEAD_REF;
  return headRef && headRef.length > 0
    ? { ok: true, headRef }
    : {
        ok: false,
        message: "credit-surface-gate: REFUSED — no head ref (pass --head-ref or set GITHUB_HEAD_REF)",
      };
}

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "head-ref": { type: "string" },
      "worktree-path": { type: "string" },
    },
  });

  const resolvedRef = resolveHeadRef(values["head-ref"]);
  if (!resolvedRef.ok) {
    console.error(resolvedRef.message);
    process.exitCode = 1;
    return;
  }

  const worktreePath = values["worktree-path"] ?? process.cwd();
  const headCommitMessage = readHeadCommitMessage(worktreePath);
  if (headCommitMessage === undefined) {
    console.error(`credit-surface-gate: REFUSED — cannot read the HEAD commit message at ${worktreePath}`);
    process.exitCode = 1;
    return;
  }

  const result = evaluateCreditSurfaceGate({ headCommitMessage, headRef: resolvedRef.headRef });
  if (!result.ok) {
    console.error(`credit-surface-gate: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`credit-surface-gate: OK — ${result.message}`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/credit-surface-gate.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
