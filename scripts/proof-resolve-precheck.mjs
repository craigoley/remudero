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
 * TWO SEVERITIES, ON PURPOSE. A test-title miss BLOCKS, and so does a `grep: test("<title>"` miss against a test file that
 * exists (W1-T5026, #8156): naming a test with the proof's exact title is always within a worker's reach. Any other grep
 * miss is REPORTED and does not block: a plan's grep can be wrong in a way the worker may not
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
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlanAtRef, visibleCriteria } from "../src/lib/plan.js";
import { certainHeadRefusals, extractTaskTrailerId, parseWhitelistedProof, planOnlyDiff, resolvePlanCriteriaAtHead } from "../src/lib/review.js";
import { certainStaleProofs } from "../src/lib/proof-base-stale.js";
import { buildCommitTrailerIndex, creditsByAnchoredTrailer, ghGateway, taskIdFromRunBranch } from "../src/lib/status.js";
import { literalTestTitlesIn } from "../src/lib/task-linter.js";
import { stripComments } from "../src/lib/test-impact-map.js";
import { isMainModule } from "./lib/argv.mjs";
import { gitOrThrow } from "./lib/git.mjs";

const PLAN = "plan/tasks.yaml";

/** Pure over a plan, removed paths and added-file evidence: `{ path, matchingProofs: string[] }`.
 * The caller owns grep/file reads; a missing hint never suppresses an orphan. */
export function mergedProofOrphans({ plan, removedPaths, addedFiles }) {
  const removed = new Set(removedPaths);
  const rows = [];
  for (const task of plan.tasks) {
    if (task.status !== "merged") continue;
    for (const criterion of visibleCriteria(task.acceptance ?? [])) {
      const parsed = parseWhitelistedProof(criterion.proof ?? "");
      if (!parsed) continue;
      const path = parsed.kind === "test" && !parsed.nameFiltered ? parsed.label
        : parsed.kind === "grep" && !parsed.authorSelectedArgv ? parsed.args[3] : undefined;
      if (!removed.has(path)) continue;
      rows.push({
        taskId: task.id, claim: criterion.claim, proof: criterion.proof, removedPath: path,
        candidates: addedFiles.filter((file) => file.matchingProofs.includes(criterion.proof)).map((file) => file.path),
      });
    }
  }
  return rows;
}

/** Resolve only tasks whose proofs name removed paths. Shard status is decorative, not merge evidence. */
export function mergedProofPlan({ plan, removedPaths }, isMerged) {
  const possible = mergedProofOrphans({
    plan: { tasks: plan.tasks.map((task) => ({ ...task, status: "merged" })) }, removedPaths, addedFiles: [],
  });
  const affected = new Set(possible.map((row) => row.taskId));
  return { ...plan, tasks: plan.tasks.map((task) => ({
    ...task, status: affected.has(task.id) && isMerged(task.id) ? "merged" : "queued",
  })) };
}

/** Main's committed trailer index is cheap; missing credits use the installed PR trailer/branch resolver. */
export function mergedTaskResolver(repoRoot, baseSha, { commitCredits, github } = {}) {
  return (taskId) => {
    if (commitCredits === undefined) {
      const origin = gitOrThrow(["config", "--get", "remote.origin.url"], { cwd: repoRoot });
      const slug = origin.replace(/\.git$/, "").replace(/^.*[:/]([^/]+\/[^/]+)$/, "$1");
      commitCredits = buildCommitTrailerIndex({ slug, ref: baseSha, cwd: repoRoot })();
      if (commitCredits === null) throw new Error("cannot read merged commit trailers");
      const [owner, repo] = slug.split("/");
      github ??= ghGateway(owner, repo, { commitTrailerIndex: () => commitCredits });
    }
    if (commitCredits.has(taskId)) return true;
    const trailers = github.findMergedByTrailerAll(taskId);
    if (trailers === null || github.readFailed()) throw new Error(`cannot read merged PR trailers for ${taskId}`);
    for (const pr of trailers) {
      if (pr.state.toUpperCase() !== "MERGED") continue;
      const head = github.headRefName(pr.url);
      const body = github.prBody(pr.url);
      if (github.readFailed() || head === undefined || body === undefined) {
        throw new Error(`cannot verify merged PR ${pr.url}`);
      }
      if (creditsByAnchoredTrailer(pr.state, head, body, taskId)) return true;
    }
    const branches = github.findMergedByHeadBranch(taskId);
    if (branches === null || github.readFailed()) throw new Error(`cannot read merged PR branches for ${taskId}`);
    return branches.some((pr) => pr.state.toUpperCase() === "MERGED" && taskIdFromRunBranch(pr.headRefName ?? "") === taskId);
  };
}

function changedProofPaths(nameStatus) {
  const fields = nameStatus.split("\0");
  const removedPaths = [];
  const addedPaths = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    const path = fields[index++];
    if (status.startsWith("R")) {
      removedPaths.push(path);
      addedPaths.push(fields[index++]);
    } else if (status === "D") removedPaths.push(path);
    else if (status === "A") addedPaths.push(path);
  }
  return { removedPaths, addedPaths };
}

function addedProofEvidence(orphans, addedPaths, repoRoot, baseSha) {
  const titles = new Map();
  return addedPaths.map((path) => {
    const matchingProofs = [];
    for (const orphan of orphans) {
      const parsed = parseWhitelistedProof(orphan.proof);
      let matches;
      if (parsed.kind === "grep") {
        const result = spawnSync("grep", ["-an", "--", parsed.args[2], path], { cwd: repoRoot, encoding: "utf8" });
        if (result.error || (result.status !== 0 && result.status !== 1)) {
          throw new Error(`cannot check replacement ${path}: ${result.error?.message ?? result.stderr}`);
        }
        matches = result.status === 0;
      } else {
        const target = parseWhitelistedProof(`unit test: ${path}`);
        if (target?.kind !== "test" || target.nameFiltered) continue;
        if (!titles.has(orphan.removedPath)) {
          titles.set(orphan.removedPath, literalTestTitlesIn(stripComments(gitOrThrow(["show", `${baseSha}:${orphan.removedPath}`], { cwd: repoRoot }))));
        }
        const addedTitles = literalTestTitlesIn(stripComments(readFileSync(join(repoRoot, path), "utf8")));
        matches = titles.get(orphan.removedPath).some((title) => addedTitles.some((addedTitle) => addedTitle.includes(title)));
      }
      if (matches) matchingProofs.push(orphan.proof);
    }
    return { path, matchingProofs };
  });
}

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
  const blocking = refusals.filter((r) => r.blocking === true || !/^grep:/.test(r.proof));
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
      "  A `grep: test(\"<title>\"` proof ends at the closing quote: the test's title must end exactly there, or the",
      "  operator must re-anchor the proof (a builder may not edit a criterion). Report the pattern defect, do not push.",
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
    const baseSha = gitOrThrow(["merge-base", base, "HEAD"]);
    const headPlan = loadPlanAtRef(repoRoot, PLAN, headSha);
    const { removedPaths, addedPaths } = changedProofPaths(gitOrThrow(["diff", "--name-status", "-z", "-M", `${baseSha}...HEAD`]));
    const plan = mergedProofPlan({ plan: headPlan, removedPaths }, mergedTaskResolver(repoRoot, baseSha));
    const orphans = mergedProofOrphans({ plan, removedPaths, addedFiles: [] });
    const addedFiles = addedProofEvidence(orphans, addedPaths, repoRoot, baseSha);
    const orphanLines = mergedProofOrphans({ plan, removedPaths, addedFiles }).map((row) =>
      `proof-resolve-precheck: merged proof orphan (reported, never blocking): ${row.taskId}; claim: ${row.claim}; ` +
      `removed: ${row.removedPath}; candidates: ${row.candidates.join(", ") || "none"}; ` +
      "a builder may not edit a merged criterion (Standing rule 15): name this in your PR body so the operator files the amendment",
    );
    verdict = proofResolveVerdict({
      diff: gitOrThrow(["diff", `${base}...HEAD`]),
      headRef: flag("--head-ref") || gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"]),
      headMessage: gitOrThrow(["log", "-1", "--format=%B"]),
      resolveCriteria: (taskId) => resolvePlanCriteriaAtHead(`Remudero-Task: ${taskId}`, repoRoot, PLAN, headSha).criteria,
      refusalsFor: (criteria) => certainHeadRefusals(criteria, repoRoot),
      staleFor: (criteria) => certainStaleProofs(criteria, repoRoot, baseSha),
    });
    verdict.lines.unshift(...orphanLines);
  } catch (e) {
    console.error(`proof-resolve-precheck: could not read this head (${e.message}) -- NOT reporting clean`);
    return 2;
  }
  for (const line of verdict.lines) (verdict.exit === 0 && verdict.lines.length === 1 ? console.log : console.error)(line);
  return verdict.exit;
}

if (isMainModule(import.meta.url)) process.exit(main());
