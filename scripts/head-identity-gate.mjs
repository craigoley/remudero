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
// A DEPENDENCY BUMP IS THE FOURTH ADMITTED FORM (W1-T3680), and it is deliberately the narrowest.
// A bump builds no task, so a `Remudero-Task` trailer would be a FALSE credit and a run-shaped
// branch would be a lie about its origin — it can satisfy none of the three forms above, for any
// bump, on any schedule, which made every dependabot pull request structurally unmergeable. The
// exemption therefore requires ALL THREE of: a `dependabot/` head ref, a `chore(deps)`/
// `chore(deps-dev)` subject, and a diff in which EVERY changed path is a dependency declaration.
// Most declarations are manifests; the deploy image's package manifests and Dockerfile are the
// remaining declarations and are kept explicit below because `deploy/` is not an npm workspace
// and the Dockerfile is intentionally not a manifest.
//
// THE PATH CONSTRAINT IS THE POINT AND MUST NOT BE DROPPED. Branch name and subject are both
// forgeable by any pusher, so name-only matching would turn this gate into a hole: a source change
// on a `dependabot/`-prefixed branch would merge unattributed — precisely the credit-surface
// incident W1-T1004's comment warns against repeating. Requiring a declaration-only diff makes the
// exemption self-limiting: a head that touches src/ is refused however it is named. An UNREADABLE
// diff is not a declaration-only diff, so it refuses too — the exemption fails closed.
//
// A FIFTH ADMITTED FORM IS KEYED ON THE DIFF, NOT THE SUBJECT (W1-T3706). The first three forms
// above enumerate a FORGEABLE, FREE-FORM subject spelling one incident at a time (plan filings,
// then `chore(deps)` bumps) — a `chore(docs):` ruling that would have been admitted as `docs:`
// was refused only for how it was worded (PR #5809). A plan filing, a dependency bump and a
// documentation ruling all share ONE property, and it is not the subject: each BUILDS NO TASK, so
// a `Remudero-Task` trailer would be a false credit and a run-shaped branch a lie about origin.
// What makes them safe to admit is that their diffs touch no code — a fact about the DIFF, which
// no author can misspell and no pusher can forge by renaming a branch. A head whose changed paths
// are ALL non-code (`isNonCodePath` / `NON_CODE_PATH_PATTERNS`, `src/run-task.ts`, imported rather
// than re-spelled here — see this file's own filing-subject import above for the same discipline)
// is admitted whatever its subject says. Asked LAST, exactly like the dependency-bump form, so it
// can only ever admit a head every earlier form already refused; one path outside the list (or an
// unreadable diff, `changedPathsAtHead`'s own `undefined`) refuses the whole head, the same
// self-limiting shape the bump exemption already proved.
//
// Usage: node --import tsx scripts/head-identity-gate.mjs --head-ref <ref>
// [--worktree-path <path>] (ref falls back to $GITHUB_HEAD_REF; path defaults to cwd).

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";
import {
  LINT_FILING_SUBJECT_RE,
  RUN_BRANCH_FILED_FORM,
  RUN_BRANCH_UNFILED_FORM,
  isDispatchedRunBranch,
  isNonCodePath,
} from "../src/run-task.ts";
import { extractTaskTrailerId } from "../src/lib/review.ts";
// W1-T3707: ONE manifest predicate, owned by the dependency-review lane. This script used to
// keep its own BASENAME matcher, which admitted test/fixtures/onboard/repo/package.json while
// dep-review's ROOT-ANCHORED list refused apps/dashboard/package.json -- two sources of truth
// for one concept, disagreeing in opposite directions, with #5757 stuck between them.
import { isDependencyDeclarationPath as isDependencyDeclarationPathFromReview, isManifestPath } from "../src/lib/dep-review.ts";

// Re-exported so a caller/test can name these shapes without a second import of src/run-task.ts.
export { LINT_FILING_SUBJECT_RE, RUN_BRANCH_FILED_FORM, RUN_BRANCH_UNFILED_FORM, isDispatchedRunBranch, isNonCodePath };

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
 * Is this path a dependency manifest? Delegates to {@link isManifestPath}
 * (src/lib/dep-review.ts) so this gate and the dependency-review lane can never disagree again
 * (W1-T3707). The root manifest is supplied as the workspace declaration: a NESTED manifest is
 * admitted only inside a DECLARED workspace, so a workspace bump passes and a fixture does not.
 * @param {string} path
 * @param {() => string} [readRootManifest] Seam for tests; defaults to the real root manifest.
 */
export function isDependencyManifestPath(path, readRootManifest = () => readFileSync("package.json", "utf8")) {
  return isManifestPath(String(path ?? ""), readRootManifest);
}

export function isDependencyDeclarationPath(path, readRootManifest = () => readFileSync("package.json", "utf8")) {
  return isDependencyDeclarationPathFromReview(String(path ?? ""), readRootManifest);
}

/**
 * Is this head a dependency bump with nothing else in it? ALL THREE limbs are required — see this
 * file's header for why dropping the path constraint turns the gate into a credit hole.
 *
 * `changedPaths` absent, unreadable or EMPTY returns `false`: the exemption fails closed, so an
 * unreadable diff is refused exactly as an unidentified head already was, never admitted on the
 * strength of a forgeable branch name.
 * @param {{ headRef: string | undefined, subject: string, changedPaths: readonly string[] | undefined }} input
 */
export function isDependencyBumpHead({ headRef, subject, changedPaths }) {
  if (!String(headRef ?? "").startsWith("dependabot/")) return false;
  if (!/^chore\(deps(?:-dev)?\)/i.test(String(subject ?? "").trim())) return false;
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return false;
  return changedPaths.every((path) => isDependencyDeclarationPath(path));
}

/**
 * Is this head's ENTIRE diff non-code (W1-T3706)? Unlike {@link isDependencyBumpHead} it asks
 * nothing of the head ref or subject — a documentation/plan ruling carries neither a `dependabot/`
 * ref nor a `chore(deps)` subject, and asking for either would just be a fourth spelling instead
 * of a fifth incident.
 *
 * `changedPaths` absent or EMPTY returns `false`, the same fail-closed direction
 * {@link isDependencyBumpHead} already takes: an unreadable diff is not a non-code diff, and a
 * head with literally nothing changed has nothing to admit on this route either.
 * @param {{ changedPaths: readonly string[] | undefined }} input
 */
export function isNonCodeHead({ changedPaths }) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return false;
  return changedPaths.every((path) => isNonCodePath(path));
}

/**
 * The gate's predicate: a filing-shaped subject is exempt outright; otherwise a conforming
 * identity requires the run-branch shape (either named form) or the trailer — either is enough —
 * and a refusal names BOTH conforming forms plus the trailer route.
 * @param {{ headCommitMessage: string, headRef: string | undefined }} input
 */
export function evaluateHeadIdentityGate({ headCommitMessage, headRef, changedPaths }) {
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

  // W1-T3680: asked LAST, so it can only ever ADMIT a head the three forms above already
  // refused — the refusal text below stays byte-identical and no existing form is relaxed.
  if (isDependencyBumpHead({ headRef, subject, changedPaths })) {
    return {
      ok: true,
      message:
        `dependency-bump head (${headRef}) whose diff touches only dependency manifests — admitted ` +
        "without a task credit, because a bump builds no task to credit (W1-T3680)",
    };
  }

  // W1-T3706: asked LAST OF ALL, so it can only ever ADMIT a head every form above already
  // refused. Keyed on the diff, not the subject, so no spelling of a documentation or plan
  // ruling needs its own entry on this allowlist ever again.
  if (isNonCodeHead({ changedPaths })) {
    return {
      ok: true,
      message:
        "non-code head whose entire diff is documentation or plan — admitted whatever its subject " +
        "spelling, because a diff with nothing to attribute has nothing to credit (W1-T3706)",
    };
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
 */

/**
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
 * The paths this head changes against its merge-base with the pull request's base branch.
 *
 * Best-effort in the same sense {@link readHeadCommitMessage} is: `undefined` on any git failure
 * or a missing base ref, never a throw. `undefined` is SAFE here because
 * {@link isDependencyBumpHead} treats it as "not a manifest-only diff" and refuses — the one
 * direction an unreadable diff may take.
 *
 * The workflow checks out with `fetch-depth: 0`, so the merge-base resolves without an API call.
 * @param {string} worktreePath
 * @param {string | undefined} baseRef
 * @param {typeof git} [run] Seam for tests — defaults to the real runner, the same shape
 *   `changedPathsAtRange` (scripts/acceptance-author-gate.mjs) already uses for its own `git`.
 */
export function changedPathsAtHead(worktreePath, baseRef, run = git, env = process.env) {
  // THE ENV FALLBACK IS RESOLVED IN THE BODY, NOT IN A DEFAULT PARAMETER. A JS default fires on
  // `undefined`, so `changedPathsAtHead(w, undefined, run)` silently picked up $GITHUB_BASE_REF --
  // which is UNSET on a dev machine and SET on every pull_request runner. The no-base-ref test
  // therefore passed locally and failed only in CI, which is the least useful place to find out.
  // Injecting `env` lets a caller ask the question without the ambient answer.
  const ref = baseRef ?? env.GITHUB_BASE_REF;
  if (!ref || ref.length === 0) return undefined;
  const mergeBase = run(["merge-base", `origin/${ref}`, "HEAD"], { cwd: worktreePath });
  if (mergeBase.error || mergeBase.status !== 0) return undefined;
  const base = mergeBase.stdout.trim();
  if (base === "") return undefined;
  const diff = run(["diff", "--name-only", "-z", "--no-renames", `${base}...HEAD`], { cwd: worktreePath });
  if (diff.error || diff.status !== 0) return undefined;
  return [...new Set(diff.stdout.split("\0").filter(Boolean))];
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

  const result = evaluateHeadIdentityGate({
    headCommitMessage,
    headRef: resolvedRef.headRef,
    changedPaths: changedPathsAtHead(worktreePath),
  });
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
