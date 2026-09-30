#!/usr/bin/env node
/**
 * WILL THE REVIEWER REFUSE ONE OF THIS BRANCH'S PROOFS OUTRIGHT? Ask before pushing, not after CI.
 *
 * MEASURED 2026-09-15..29 on the core ledger: 40 reviewer-unmet fix rounds, and 14 of them (131 fix-worker minutes) were
 * a build head whose `unit test:` proof title matched no test — named differently, never written, or present only in a
 * comment — plus 4 whose `grep:` proof matched nothing. The reviewer found each one only after a full CI cycle; each
 * was knowable offline in about a second.
 *
 * ONE PREDICATE, NEVER TWO. The criteria come from the reviewer's own `resolvePlanCriteriaAtHead` (the task the run
 * branch or the head commit's `Remudero-Task:` trailer names) and the verdicts from `certainHeadRefusals`, which is
 * built on the reviewer's own resolver and executor and reports only what the reviewer is CERTAIN to refuse.
 *
 * TWO SEVERITIES, ON PURPOSE. A test-title miss BLOCKS: naming a test with the proof's exact title is always within a
 * worker's reach. A grep miss is REPORTED and does not block: a plan's grep can be wrong in a way the worker may not
 * edit (Standing rule 15), and refusing the push there would strand the task with no pull request at all, which is
 * worse than the review refusal it predicts.
 *
 * A THIRD, REPORT-ONLY ARM (W1-T4921): a `grep:` proof that ALSO passes at the merge base, which the reviewer grades
 * `executed_stale`. A worker may not edit a criterion, so it is reported and never blocks; the builder names the defect
 * and stops rather than pushing a pull request that can never go green. A `plan-only` diff on a `run-<taskId>` branch
 * is a BUILD, not a filing, so it is asked too.
 *
 * Exit 0 clean or reported-only, 1 a blocking refusal, 2 could not read (the hook never blocks on 2).
 */
import { certainHeadRefusals, extractTaskTrailerId, planOnlyDiff, resolvePlanCriteriaAtHead } from "../src/lib/review.js";
import { certainStaleProofs } from "../src/lib/proof-base-stale.js";
import { taskIdFromRunBranch } from "../src/lib/status.js";
import { isMainModule } from "./lib/argv.mjs";
import { gitOrThrow } from "./lib/git.mjs";

const PLAN = "plan/tasks.yaml";

/**
 * The pure verdict. `resolveCriteria(taskId)` and `refusalsFor(criteria)` are injected so a test drives every arm
 * without a checkout; `main` below wires the reviewer's real functions.
 */
export function proofResolveVerdict({ diff, headRef, headMessage, resolveCriteria, refusalsFor, staleFor = () => [] }) {
  const branchTask = taskIdFromRunBranch(headRef);
  if (planOnlyDiff(diff) && !branchTask) {
    return { exit: 0, lines: ["proof-resolve-precheck: SKIP -- a plan-only filing (no run-<taskId> branch); its proofs are the build PR's"] };
  }
  const taskId = branchTask ?? extractTaskTrailerId(headMessage);
  if (!taskId) return { exit: 0, lines: ["proof-resolve-precheck: SKIP -- no task resolved from the branch or a Remudero-Task: trailer"] };
  const criteria = resolveCriteria(taskId);
  if (criteria.length === 0) return { exit: 0, lines: [`proof-resolve-precheck: SKIP -- ${taskId} resolves no acceptance criteria at HEAD`] };
  const refusals = refusalsFor(criteria);
  const stale = staleFor(criteria);
  if (refusals.length === 0 && stale.length === 0) {
    return { exit: 0, lines: [`proof-resolve-precheck: OK -- ${criteria.length} ${taskId} criteria, none the reviewer is certain to refuse`] };
  }
  const blocking = refusals.filter((r) => !/^grep:/.test(r.proof));
  const lines = [];
  if (refusals.length > 0) {
    lines.push(
      `proof-resolve-precheck: remudero-review WILL REFUSE ${refusals.length} of ${taskId}'s proofs on this head:`,
      ...refusals.map((r) => `  - ${r.proof}\n      why: ${r.why}\n      claim: ${r.claim}`),
    );
  }
  if (stale.length > 0) {
    lines.push(
      `proof-resolve-precheck: ${stale.length} of ${taskId}'s grep proofs ALSO PASS at the merge base (reported, never blocking):`,
      ...stale.map((r) => `  - ${r.proof}\n      why: ${r.why}\n      claim: ${r.claim}`),
      "  A builder may not edit a criterion (Standing rule 15): name this defect in your report and stop, so the operator",
      "  can re-anchor the pattern on text the build adds, or declare `kind: guard` when preserving the text is the point.",
    );
  }
  if (refusals.length === 0) return { exit: 0, lines };
  if (blocking.length > 0) {
    lines.push(
      "  TO FIX: a `unit test:` proof is matched as a LITERAL substring of a test NAME (test(\"...\") / it(\"...\")),",
      "  never of a comment or a file name. Rename or add the test so its title contains the proof text exactly.",
      "  Doing it now costs one edit; after the push it costs a CI cycle, a review and a fix round.",
    );
  } else {
    lines.push("  (grep misses are reported, not blocking: make the text appear on ONE line, or name it in your PR body.)");
  }
  return { exit: blocking.length > 0 ? 1 : 0, lines };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const base = flag("--base") ?? "origin/main";
  let verdict;
  try {
    const repoRoot = gitOrThrow(["rev-parse", "--show-toplevel"]);
    const headSha = gitOrThrow(["rev-parse", "HEAD"]);
    verdict = proofResolveVerdict({
      diff: gitOrThrow(["diff", `${base}...HEAD`]),
      headRef: flag("--head-ref") || gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"]),
      headMessage: gitOrThrow(["log", "-1", "--format=%B"]),
      resolveCriteria: (taskId) => resolvePlanCriteriaAtHead(`Remudero-Task: ${taskId}`, repoRoot, PLAN, headSha).criteria,
      refusalsFor: (criteria) => certainHeadRefusals(criteria, repoRoot),
      staleFor: (criteria) => certainStaleProofs(criteria, repoRoot, gitOrThrow(["merge-base", base, "HEAD"])),
    });
  } catch (e) {
    console.error(`proof-resolve-precheck: could not read this head (${e.message}) -- NOT reporting clean`);
    return 2;
  }
  for (const line of verdict.lines) (verdict.exit === 0 && verdict.lines.length === 1 ? console.log : console.error)(line);
  return verdict.exit;
}

if (isMainModule(import.meta.url)) process.exit(main());
