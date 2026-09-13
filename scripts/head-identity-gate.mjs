#!/usr/bin/env node
// scripts/head-identity-gate.mjs — refuse a head with no conforming identity (W1-T3388).
//
// THREE INDEPENDENT REASONS A WORKER CAN VIOLATE THE BRANCH-NAME RULE WHILE FOLLOWING IT (see
// plan/tasks.d/W1-T3388-*.yaml's rationale in full): CLAUDE.md's own rule excludes unfiled work
// (PR 5106 was an ad-hoc repair with no filed task and therefore no id for
// `run-<taskId>-<epochMs>`), a DISPATCHED WORKER never loads CLAUDE.md at all
// (`spawnWorker` passes `settingSources: []`), and — the gap this file closes — NOTHING REFUSES A
// NON-CONFORMING HEAD. This gate refuses a head that matches neither conforming form and carries
// no valid `Remudero-Task: <id>` trailer, naming both forms in its refusal text.
//
// The two conforming forms are `src/run-task.ts`'s own {@link RUN_BRANCH_FILED_FORM} (`
// run-<taskId>-<epochMs>`, when building a filed task) and {@link RUN_BRANCH_UNFILED_FORM} (`
// run-unfiled-<epochMs>`, when the work has no filed task) — imported, never re-spelled, so the
// turn-0 prompt's `BRANCH_NAME_CONTRACT_PART` and this gate's refusal text can never drift onto
// different spellings for the same two cases. `isDispatchedRunBranch` (lib/sweep.ts, re-exported
// from run-task.ts) already accepts both literally — it is a task-agnostic shape test,
// `/^run-.+-\d+$/` — so this gate reuses it rather than re-testing the unfiled shape a second way.
//
// A filing-shaped subject (`LINT_FILING_SUBJECT_RE`, the SAME predicate
// scripts/credit-surface-gate.mjs already reuses for the analogous exemption) is exempt outright:
// a plan-only filing legitimately carries neither a trailer nor a fleet-dispatched head, by design
// (W1-T1004), and refusing it here would be the credit-surface incident's mistake repeated.
//
// Usage: node --import tsx scripts/head-identity-gate.mjs --head-ref <ref>
// [--worktree-path <path>] (ref falls back to $GITHUB_HEAD_REF; path defaults to cwd).

import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";
import { LINT_FILING_SUBJECT_RE, RUN_BRANCH_FILED_FORM, RUN_BRANCH_UNFILED_FORM, isDispatchedRunBranch } from "../src/run-task.ts";
import { extractTaskTrailerId } from "../src/lib/review.ts";

// Re-exported so a caller/test can name these shapes without a second import of src/run-task.ts.
export { LINT_FILING_SUBJECT_RE, RUN_BRANCH_FILED_FORM, RUN_BRANCH_UNFILED_FORM, isDispatchedRunBranch };

/**
 * Is `subject` (a commit's first line) filing-shaped — citing a task rather than building it?
 * Thin wrapper over the imported {@link LINT_FILING_SUBJECT_RE}, restated here (rather than
 * imported from credit-surface-gate.mjs) so this gate has no runtime dependency on that one —
 * two independently-refusing gates over the same predicate, never one importing the other.
 * @param {string} subject
 */
export function isFilingShapedSubject(subject) {
  return LINT_FILING_SUBJECT_RE.test((subject ?? "").trim());
}

/**
 * Does `commitMessage` carry a valid, anchored `Remudero-Task: <id>` trailer? Reuses
 * {@link extractTaskTrailerId} (src/lib/review.ts) — the SAME anchored, last-wins reader
 * `acceptanceAuthorTimeCheck`/`resolvePlanCriteriaAtHead` already resolve criteria through
 * (W1-T2624 fixed the three-way disagreement a fourth hand-rolled regex here would risk
 * repeating) — rather than a fourth independently-drifting trailer regex.
 * @param {string} commitMessage
 */
export function hasValidTaskTrailer(commitMessage) {
  return extractTaskTrailerId(commitMessage ?? "") !== undefined;
}

/**
 * The gate's predicate: a filing-shaped subject is exempt outright; otherwise a conforming
 * identity requires the run-branch shape (either named form) or the trailer — either is enough —
 * and a refusal names BOTH conforming forms plus the trailer route.
 * @param {{ headCommitMessage: string, headRef: string | undefined }} input
 */
export function evaluateHeadIdentityGate({ headCommitMessage, headRef }) {
  const message = headCommitMessage ?? "";
  const subject = message.split("\n")[0] ?? "";

  if (isFilingShapedSubject(subject)) {
    return {
      ok: true,
      message:
        `filing-shaped subject "${subject.trim()}" carries no Remudero-Task trailer by rule ` +
        `(W1-T1004) — exempt from the head-identity check`,
    };
  }

  const trailered = hasValidTaskTrailer(message);
  const runShaped = isDispatchedRunBranch(headRef);

  if (trailered && runShaped) {
    return { ok: true, message: "identified on both surfaces: the head commit's Remudero-Task trailer and its run-shaped head ref" };
  }
  if (trailered) {
    return { ok: true, message: "identified via the head commit's Remudero-Task trailer" };
  }
  if (runShaped) {
    return { ok: true, message: `identified via its run-shaped head ref (${headRef})` };
  }

  return {
    ok: false,
    defect: "unidentified-head",
    message:
      "REFUSED — this head matches neither conforming form and carries no valid Remudero-Task " +
      "trailer. Satisfy one: (1) push to a session branch shaped " +
      `\`${RUN_BRANCH_FILED_FORM}\` when building a filed task, or \`${RUN_BRANCH_UNFILED_FORM}\` ` +
      "when the work has no filed task, or (2) carry an anchored `Remudero-Task: <id>` trailer " +
      "on the head commit (either is enough — see W1-T3388).",
  };
}

/**
 * The newest message an AUTHOR wrote on this head. Best-effort: `undefined` on any git failure rather
 * than throwing, matching {@link "./credit-surface-gate.mjs".readHeadCommitMessage}'s own contract at
 * the analogous call site.
 *
 * THE FLAGS ARE THE WHOLE FIX, and this is the second half of a two-part defect.
 *
 * The first half was the checkout: a `pull_request` event lands on GitHub's synthetic merge commit, so
 * a bare `git log -1` read "Merge <sha> into <sha>" and neither the filing-subject nor the trailer route
 * could match. Pinning the checkout to the event's head sha fixed that (merged 11:48:34Z).
 *
 * The second half survives it. "Update branch" — the GitHub button, or `PUT .../update-branch` — merges
 * base into the PR branch, so the head becomes `Merge branch 'main' into <branch>`, equally unable to
 * carry a subject or trailer. Three PRs (#5342, #5367, #5372) were refused at 12:35Z, forty-seven
 * minutes AFTER the checkout fix landed, purely because their branches had been updated. A gate that a
 * routine GitHub button turns red is one nobody can satisfy.
 *
 * BOTH FLAGS ARE LOAD-BEARING, and `--no-merges` ALONE IS A HOLE — measured on the branch this was
 * written against, where the three queries return three different commits:
 *
 *   git log -1                            -> "Merge branch 'main' into chore/file-w1-t3512-fast-lane"
 *   git log -1 --no-merges                -> "chore(feedback): land pending filings (#5380)"  <- MAIN's
 *   git log -1 --first-parent --no-merges -> "chore(plan): file the ten source-only gates ..." <- ours
 *
 * Without `--first-parent`, git walks BOTH parents in date order, so after an update it returns a commit
 * off MAIN — letting an unrelated PR's subject or trailer satisfy this gate for a head that declared
 * nothing. `--first-parent` confines the walk to the branch's own line.
 *
 * A merge commit that genuinely carries a trailer is the deliberate trade: it is not read, because
 * admitting one would re-open the synthetic-merge hole the first half closed.
 * @param {string} worktreePath
 */
export function readHeadCommitMessage(worktreePath) {
  const result = git(["log", "-1", "--first-parent", "--no-merges", "--format=%B"], { cwd: worktreePath });
  if (result.error || result.status !== 0) return undefined;
  // A branch of nothing but merges yields an empty message rather than a git failure; `undefined` keeps
  // that indistinguishable from an unreadable worktree, which both mean "no identity declared here".
  return result.stdout.trim() === "" ? undefined : result.stdout;
}

/**
 * Resolve the head ref from the flag, falling back to `$GITHUB_HEAD_REF` (set automatically on a
 * `pull_request`-triggered job, so this costs no event-payload parse and no API call). Extracted
 * and pure so its refusal arm is reachable from a test.
 * @param {string | undefined} flagValue
 * @param {Record<string, string | undefined>} env
 */
export function resolveHeadRef(flagValue, env = process.env) {
  const headRef = flagValue ?? env.GITHUB_HEAD_REF;
  return headRef && headRef.length > 0
    ? { ok: true, headRef }
    : {
        ok: false,
        message: "head-identity-gate: REFUSED — no head ref (pass --head-ref or set GITHUB_HEAD_REF)",
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
    console.error(`head-identity-gate: REFUSED — cannot read the HEAD commit message at ${worktreePath}`);
    process.exitCode = 1;
    return;
  }

  const result = evaluateHeadIdentityGate({ headCommitMessage, headRef: resolvedRef.headRef });
  if (!result.ok) {
    console.error(`head-identity-gate: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`head-identity-gate: OK — ${result.message}`);
  process.exitCode = 0;
}

// Only runs when executed directly, never on import.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
