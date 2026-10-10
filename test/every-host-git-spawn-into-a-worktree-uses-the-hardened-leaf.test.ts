/**
 * W1-T6106 — EVERY HOST GIT SPAWN INTO A WORKER WORKTREE USES THE HARDENED LEAF.
 *
 * `hostWorktreeGit` (src/lib/worktree-git.ts) is the one way host code may run git with a worker
 * worktree as its repository: it pins the gitdir and disables code-executing config, so the
 * worktree's `.git` pointer and tracked hooks/ never run. Two checks hold that in place:
 *
 *   1. THE CONVERTED SITES — each function named in LEAF_SITES calls the leaf and spawns no raw git.
 *   2. THE RATCHET — a raw `"-C", <worktree-named target>` argv in src/ is counted per file against
 *      RAW_SITE_EXCEPTIONS, each with its reason. A new one in any file (a new file starts at zero)
 *      fails naming that file; converting one fails until its exception is lowered, so the list stays
 *      exact and only ever shrinks.
 *
 *   3. THE WIDENED RATCHET (W1-T6123) — the two shapes (2) cannot see, counted per file against
 *      WIDENED_SITE_EXCEPTIONS: a `"-C", <any expression>` argv found by POSITION, not by variable
 *      name, and a `"git"` call with no `-C` that addresses its tree another way
 *      ({@link CWD_OPTION_GIT_SPAWN}): a `cwd` option, or a helper/injected seam that binds the tree
 *      out of sight (the `run("git", …)` shape). Sites (2) already counts are not counted again.
 *
 * The walk is the filesystem under src/, so a file not yet committed is counted too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { maskLiterals, stripComments } from "../src/lib/test-impact-map.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** A `-C` argv element naming a worker worktree by any of the names host code gives one. */
const WORKTREE_TARGET = /"-C",\s*(?:wt|worktreePath|[A-Za-z_$][\w$]*\.worktreePath|worktreeRoot|batchWorktree|ownerPath)\b/g;
const RAW_GIT_SPAWN = /\b(?:execFileSync|execFile|execFilePromise|spawnSync|spawn)\(\s*"git"/;
const LEAF_CALL = /\bhostWorktreeGit(?:Async)?\(|\bworktreeGitCapture(?:Async)?\(|\bworktreePushExec(?:Async)?\(/;

/** The sites W1-T6106 converted; each must reach the leaf and spawn no raw git of its own. */
const LEAF_SITES: ReadonlyArray<readonly [string, string]> = [
  ["src/lib/git-push.ts", "gitPushRunBranch"],
  ["src/lib/git-push.ts", "gitPushRunBranchAsync"],
  ["src/lib/git-push.ts", "worktreeGitCapture"],
  ["src/lib/git-push.ts", "worktreeGitCaptureAsync"],
  ["src/lib/git-push.ts", "worktreePushExec"],
  ["src/lib/git-push.ts", "worktreePushExecAsync"],
  ["src/run-task.ts", "commitWorkerEdits"],
  ["src/run-task.ts", "appendTaskTrailerToCommit"],
  ["src/run-task.ts", "irreversibleSignalForWorktree"],
  ["src/run-task.ts", "pushFixRound"],
  ["src/lib/worker.ts", "stampRunWorktreeAssignment"],
  // W1-T6122: the WORKER/REVIEWER sites outside run-task.ts.
  ["src/lib/worker.ts", "excludeNodeModulesFromGit"],
  ["src/lib/sweep.ts", "headIsInWorktree"],
  ["src/lib/sweep.ts", "readBaselineRatchetWorktreeState"],
  ["src/lib/retro.ts", "defaultFreshShardTextReader"],
  ["src/lib/retro.ts", "stampCitationsAndCommit"],
  ["src/lib/orientation.ts", "regenerateOrientation"],
  ["src/lib/relint.ts", "newMonolithIdsAgainstBase"],
  ["src/lib/composition-root.ts", "realReviewWorktree"],
  ["src/lib/review-worktree-reclaim.ts", "defaultReadHeadSha"],
  // W1-T6133: the sweep's PR-head trees and the worker's credential wiring and lane-reaper reads.
  ["src/lib/sweep.ts", "prHeadTreeGit"],
  ["src/lib/sweep.ts", "planRepairGitRun"],
  ["src/lib/worker.ts", "wireCredentialHelperSocket"],
  ["src/lib/worker.ts", "credentialHelperSocketWired"],
  ["src/lib/worker.ts", "laneWorkKeepReason"],
  ["src/lib/worker-provider.ts", "isGitWorktree"],
  ["src/lib/worker-provider.ts", "selectOpenWeightUnitTestSuites"],
  ["src/lib/report-commands.ts", "defaultReadWorktreeHead"],
  ["src/lib/report-commands.ts", "defaultIsWorktreeBaseAncestor"],
];

/**
 * Raw `-C <worktree>` argv still in src/, per file, and why. SEAM ARGV is argv a step builds for an
 * injectable `capture`/`exec` whose DEFAULT strips the `-C` and runs it through the leaf. Everything
 * else is a site W1-T6106 has not converted yet: named here so the remaining exposure is a list, not a
 * guess, and so it can only shrink.
 */
const RAW_SITE_EXCEPTIONS: Readonly<Record<string, { count: number; reason: string }>> = {
  "src/lib/git-push.ts": { count: 4, reason: "seam argv: pushRunBranchSteps/leasedForcePushSteps; the defaults run it through the leaf" },
  "src/run-task.ts": {
    count: 13,
    reason:
      "W1-T6121 converted every worker and reviewer site; what is left is HARNESS-only, each recorded with " +
      "its function and reason in test/run-task-git-calls-into-a-worker-worktree-go-through-the-leaf.test.ts: " +
      "2 seam argv in pushFixRound (its exec/capture default to the leaf), the fresh origin/main reviewer " +
      "tree inspectFreshReviewerWorktree reads, the clone the test-only triageClaimReserverFor and " +
      "mergedTriageSubjects bind, and the approve worktrees approveCommand/approveBatchCommand write themselves",
  },
  "src/lib/worker.ts": {
    count: 9,
    reason:
      "HARNESS (W1-T6122): worktreeAdd 3 + worktreeAddAsync 6 cut and wire the tree before any worker runs; " +
      "they read the gitdir the leaf later pins to, so they must precede it; the add and the async catch-up " +
      "merge run the leaf's HOST_GIT_CONFIG, so no tracked or gitdir hook fires while the tree is cut (W1-T6147)",
  },
  "src/lib/sweep.ts": {
    count: 7,
    reason:
      "HARNESS (W1-T6122): the refusal-amendment 4 and plan-repair 3 commits run in trees worktreeAdd cut " +
      "from origin/main that only the sweep writes; they keep main's own commit hooks",
  },
};

/**
 * W1-T6123 — every raw git site the widened count sees, per file, and why: KEPT APART from
 * RAW_SITE_EXCEPTIONS so the two ratchets can move independently (W1-T6121/W1-T6122 lower that one).
 * Each reason opens with what the site addresses: WORKTREE (a worker, fix or reviewer worktree, so a
 * conversion is owed — the file's owner task is named, or none yet), CHECKOUT (a harness-owned
 * checkout, clone or scratch dir no worker writes) or NOT GIT (a `-C` flag of another program). W1-T6136
 * resolved every caller-chosen tree at its callers. Exact in both directions, so it only shrinks.
 */
export const WIDENED_SITE_EXCEPTIONS: Readonly<Record<string, { count: number; reason: string }>> = {
  "src/lib/benchmark-aa-readiness.ts": { count: 1, reason: "CHECKOUT: deriveRuntimePins reads the harness checkout it runs from (-C cwd)" },
  "src/lib/benchmark-run.ts": { count: 1, reason: "CHECKOUT: executingHarnessRevision reads the harness checkout (-C cwd)" },
  "src/lib/branch-reaper.ts": { count: 5, reason: "CHECKOUT: the reaper's injected exec(\"git\", …) steps run in the managed checkout" },
  "src/lib/ci-friction-gardener.ts": { count: 3, reason: "CHECKOUT: gardener reads of the repo root (-C repoRoot/deps.repoRoot, run(\"git\", …))" },
  "src/lib/ci-parity.ts": { count: 21, reason: "CHECKOUT: parity reads of the repo root (cwd: repoRoot) and runIsolatedLocalMergeRoute's own sandbox clone" },
  "src/lib/clone-reaper.ts": { count: 2, reason: "CHECKOUT: defaultOriginOf(Async) read a reaped clone's origin (-C dir)" },
  "src/lib/commit-message.ts": { count: 1, reason: "CHECKOUT: readRangeCommitMessages reads the repo root (cwd: repoRoot)" },
  "src/lib/composition-root.ts": { count: 2, reason: "CHECKOUT (W1-T6122's file): realReviewWorktree's repoDir reads/adds against the managed checkout" },
  "src/lib/containment.ts": { count: 1, reason: "CHECKOUT (W1-T6136): defaultExecutor's git init runs in the probe scratch dir it mkdirs itself" },
  "src/lib/deployer.ts": { count: 1, reason: "CHECKOUT: realDeployDeps reads the install checkout (-C o.installPath)" },
  "src/lib/dispatch-claim.ts": { count: 1, reason: "CHECKOUT: gitClaimRunnerAsync runs claim refs in the managed checkout (-C repoDir)" },
  "src/lib/export-gardener.ts": { count: 1, reason: "CHECKOUT: referencesOutside reads the repo root (-C root)" },
  "src/lib/feedback-landing.ts": {
    count: 3,
    reason:
      "CHECKOUT: defaultGit and its off-loop twin defaultGitAsync (W1-T5672) (-C root), and " +
      "sourceRepositoryFromCwd (-C process.cwd())",
  },
  "src/lib/feedback-reconcile.ts": { count: 1, reason: "CHECKOUT: defaultGit reads the repo root (-C root)" },
  "src/lib/feedback.ts": { count: 1, reason: "CHECKOUT: defaultUpstreamGit reads the repo root (-C root)" },
  "src/lib/fleet-control.ts": { count: 1, reason: "CHECKOUT: realSharedPauseGitDeps pushes the pause ref from the repo root" },
  "src/lib/fleet-lane.ts": { count: 1, reason: "CHECKOUT: mergedInLastDaySteps reads origin/main in the managed checkout" },
  "src/lib/flow-remedy-gardener.ts": { count: 3, reason: "CHECKOUT: readPlan/flowGardenSpec read the repo root (-C repoRoot)" },
  "src/lib/gardener-overseer.ts": { count: 1, reason: "CHECKOUT: productionGardenerOverseerPorts reads the repo root" },
  "src/lib/gate-gardener.ts": { count: 2, reason: "CHECKOUT: defuseCandidates' run(\"git\", …) and gateGardenSpec read the repo root" },
  "src/lib/git-push.ts": {
    count: 6,
    reason:
      "seam argv + CHECKOUT: io.exec(\"git\", args) in push/leasedForcePushSteps run leaf-built argv; " +
      "gitPushEmptyCommit uses repoDir",
  },
  "src/lib/hand-worktree.ts": { count: 5, reason: "CHECKOUT: findDonor/duplicateWork/createHandWorktree run against the source checkout (-C repoDir)" },
  "src/lib/host-resource-gardener.ts": { count: 1, reason: "CHECKOUT: gitHeartbeatSource reads the repo root" },
  "src/lib/hot-file-gardener.ts": { count: 2, reason: "CHECKOUT: readMainHistory/hotFileGardenSpec read the repo root" },
  "src/lib/image-drift.ts": { count: 1, reason: "CHECKOUT: defaultGit reads the managed checkout (-C repoDir)" },
  "src/lib/inbox.ts": {
    count: 2,
    reason:
      "CHECKOUT (W1-T6136): gitGrepAnchorTrue(Async) grep origin/main in the harness repoRoot (run-task.ts " +
      "buildInboxDraftHook/inboxCommand), status-board's deps.repoDir and panel-graph's deps.root",
  },
  "src/lib/install-root.ts": { count: 4, reason: "CHECKOUT: inspect/provisionInstallRoot clone and read the install root (-C path)" },
  "src/lib/learnings.ts": { count: 2, reason: "CHECKOUT: defaultGitBlobReader/defaultChurnCommitReader read the managed checkout" },
  "src/lib/machine-filing-judge.ts": { count: 1, reason: "CHECKOUT: mainRecords reads origin/main at the repo root" },
  "src/lib/measurement-cadence.ts": { count: 4, reason: "CHECKOUT: adoption-date and cadence git log reads of the checkout (cwd: checkoutDir/cwd)" },
  "src/lib/merge-probe.ts": { count: 2, reason: "CHECKOUT + NOT GIT: defaultMergeProbeGit runs in the probe's own clone; mergedHeadTypechecks's -C is tar -x" },
  "src/lib/now-view.ts": { count: 2, reason: "CHECKOUT: gitPlanBehind reads the plan checkout (-C dir)" },
  "src/lib/object-reaper.ts": { count: 5, reason: "CHECKOUT: the object reaper's reads and gc of the managed checkout (-C repoDir/dir)" },
  "src/lib/onboard/inventory.ts": { count: 1, reason: "CHECKOUT: parseOwnerRepoFromRemoteUrl reads an onboarded repo (-C targetDir)" },
  "src/lib/onboard/synthesize.ts": { count: 1, reason: "CHECKOUT: draftPlanUntilClean runs git in the onboarded checkout (cwd)" },
  "src/lib/operator-sync.ts": { count: 1, reason: "CHECKOUT: defaultGit runs in the operator checkout (-C repoDir)" },
  "src/lib/opportunity-intake.ts": { count: 1, reason: "CHECKOUT: opportunityIntakePortsOver reads the workspace root (-C ws.root)" },
  "src/lib/owner-repo.ts": { count: 3, reason: "CHECKOUT: resolveOwnerRepoAt(Async)/gitFailureReason read a checkout's origin (-C root)" },
  "src/lib/panel-graph.ts": { count: 1, reason: "CHECKOUT: replyRefusal reads the repo root (-C root)" },
  "src/lib/plan-gardener.ts": { count: 4, reason: "CHECKOUT: the plan gardener's origin/main reads at the repo root" },
  "src/lib/plan-pr-emitter.ts": { count: 8, reason: "CHECKOUT: plan-PR reads in the emitter's cwd and its own preflight worktree (-C repoDir); timeout cleanup uses the hardened leaf" },
  "src/lib/plan-pr-merge-safety.ts": {
    count: 2,
    reason: "CHECKOUT (W1-T6136): arm-auto-merge.ts planMergeSafetyInClone binds planSafetyGitSync/Async to <root>/repos/<repo>",
  },
  "src/lib/plan.ts": { count: 1, reason: "CHECKOUT: loadPlanAtRef reads a ref at the repo root" },
  "src/lib/pr-open.ts": { count: 1, reason: "CHECKOUT: mergeBaseFor reads the repo root" },
  "src/lib/prevention-source-evidence.ts": { count: 1, reason: "CHECKOUT: captureImportedModule reads the harness module's own checkout" },
  "src/lib/replay-harness.ts": { count: 1, reason: "CHECKOUT: sourceGit reads the replay source checkout (-C sourceDir)" },
  "src/lib/repo-location.ts": { count: 1, reason: "CHECKOUT: resolveRepoRoot asks git for a directory's top level (-C dir)" },
  "src/lib/report-commands.ts": {
    count: 5,
    reason:
      "CHECKOUT (W1-T6134): reportOwnerRepo, readCheckoutDepth (2), statusCommand and " +
      "learningsExportCommand read the repo root",
  },
  "src/lib/review-findings.ts": { count: 2, reason: "CHECKOUT: fileLine/extractReviewFindings read the review root (-C root)" },
  "src/lib/review-worktree-reclaim.ts": { count: 1, reason: "CHECKOUT (W1-T6122's file): defaultReadRemoteHeadSha reads the managed checkout (-C repoDir)" },
  "src/lib/review.ts": { count: 6, reason: "CHECKOUT: review's ref and blob reads of the managed checkout (-C repoDir/repoRoot)" },
  "src/lib/selector-shadow-gardener.ts": { count: 1, reason: "CHECKOUT: selectorShadowReplaySelection reads the repo root (cwd: root)" },
  "src/lib/self-sync.ts": { count: 5, reason: "CHECKOUT: self-sync's freshness reads of the service and reviewer checkouts" },
  "src/lib/serve-plan-reload.ts": { count: 1, reason: "CHECKOUT: gitAsync reads the serve plan checkout" },
  "src/lib/serve-policy-convergence.ts": { count: 1, reason: "CHECKOUT: realServePolicyDeps reads the install checkout" },
  "src/lib/serve-restart-relevance.ts": { count: 1, reason: "CHECKOUT: changedPathsSince reads the serve checkout" },
  "src/lib/serve-slots.ts": { count: 9, reason: "CHECKOUT: slotUnfit/createSlotPreparer cut and read serve's own slot checkouts" },
  "src/lib/serve-supervisor-main.ts": { count: 1, reason: "CHECKOUT: runServeSupervisor reads the supervised checkout" },
  "src/lib/serve.ts": { count: 5, reason: "CHECKOUT: serve's console/gateway checkout reads (-C dir/repoDir)" },
  "src/lib/sre-lane.ts": { count: 3, reason: "CHECKOUT: mergedPrsSince reads origin/main in the managed checkout" },
  "src/lib/sre-runbooks.ts": { count: 1, reason: "CHECKOUT: daemonSreRunbookHost reads the managed checkout" },
  "src/lib/status-board.ts": { count: 4, reason: "CHECKOUT: status-board ref reads of the managed checkout (-C repoDir)" },
  "src/lib/status.ts": {
    count: 2,
    reason:
      "CHECKOUT (W1-T6136): buildCommitTrailerIndex reads the process cwd or run-task.ts's repoRoot / " +
      "<root>/repos/<repo>; buildGitLogSupersessionSearch has no production caller",
  },
  "src/lib/sweep.ts": {
    count: 6,
    reason:
      "CHECKOUT (W1-T6133): buildSweepEffects's 4 address the managed checkout; renumberPlanPrIds's and " +
      "rebaseDirtyFleetBranchViaGit's -C argv goes to their git seam, whose default prHeadTreeGit runs the " +
      "PR-head tree through the leaf and leaves only rebaseDirtyFleetBranchViaGit's repoDir steps raw",
  },
  "src/lib/synthetic-tasks.ts": { count: 2, reason: "CHECKOUT: git/mergedCommit read the managed checkout" },
  "src/lib/task-id-reservation.ts": { count: 2, reason: "CHECKOUT: reservation reads of the harness module checkout and the managed checkout" },
  "src/lib/test-gardener.ts": { count: 1, reason: "CHECKOUT: manifestLastCommitMs reads the repo root" },
  "src/lib/test-impact-map.ts": { count: 2, reason: "CHECKOUT: impactDrift/readImpactArmInput read the repo root (cwd: root)" },
  "src/lib/wipe-test.ts": { count: 2, reason: "CHECKOUT: runWipeTestPair reads its own scratch checkout (-C repoDir)" },
  "src/lib/worker-provider.ts": {
    count: 6,
    reason:
      "SEAM ARGV (W1-T6134): selectOpenWeightUnitTestSuites's 5 run(\"git\", …) use the leaf " +
      "in the default spawn; NOT GIT: codexExecArgs's -C is codex's",
  },
  "src/lib/worker.ts": {
    count: 24,
    reason:
      "CHECKOUT (W1-T6133 converted the WORKTREE sites): defaultLaneListGit lists the managed checkout's " +
      "registration (cwd: repoDir); the rest are worktreeAdd/Remove, pruneStaleRuns and branch reads of the " +
      "managed checkout",
  },
  "src/run-task.ts": {
    count: 76,
    reason:
      "CHECKOUT (W1-T6135): every site classed per function, with the tree it addresses, in RUN_TASK_WIDENED_SITES " +
      "in test/run-task-s-widened-git-sites-are-classified-and-converted.test.ts, whose sum this count must equal",
  },
};

function srcFiles(dir = join(REPO, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return srcFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relative(REPO, path)] : [];
  });
}

/** The text of top-level function `name` in `source`: its declaration to the first column-0 `}`. */
export function functionBody(source: string, name: string): string | undefined {
  const at = new RegExp(`^(?:export )?(?:async )?function\\*? ${name}\\(`, "m").exec(source);
  if (!at) return undefined;
  const end = source.indexOf("\n}\n", at.index);
  return source.slice(at.index, end < 0 ? undefined : end);
}

/** Every file whose raw `-C <worktree>` count differs from its exception, with both numbers. */
function rawLeafSiteViolations(texts: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of texts) {
    const actual = text.match(WORKTREE_TARGET)?.length ?? 0;
    const allowed = RAW_SITE_EXCEPTIONS[file]?.count ?? 0;
    if (actual > allowed) {
      out.push(`${file}: ${actual} raw git -C <worktree> spawn(s) > ${allowed} — route each through hostWorktreeGit (src/lib/worktree-git.ts)`);
    } else if (actual < allowed) {
      out.push(`${file}: ${actual} raw git -C <worktree> spawn(s) < exception ${allowed} — lower RAW_SITE_EXCEPTIONS to ${actual}`);
    }
  }
  return out.sort();
}

/** The leaf itself: the one file whose git spawns ARE the hardened path, so none is counted. */
const LEAF_FILE = "src/lib/worktree-git.ts";

/**
 * W1-T6123 — the head of a `"git"` call: a callee (an identifier or member chain) applied to the
 * literal `"git"` as its first argument. Matched over comment-free text and confirmed against the
 * literal-masked copy, so a `"git"` inside another string, a template or a regex is never a call.
 * {@link widenedGitSites} counts such a call when it carries no `-C` (the position count owns those)
 * and addresses its tree another way: a `cwd` option (`{ cwd: at }` or shorthand `{ cwd }`), or a
 * callee that is not a node:child_process primitive — a helper or injected seam that binds the tree
 * where the call site cannot show it, as `run("git", …)` in selectOpenWeightUnitTestSuites does.
 */
export const CWD_OPTION_GIT_SPAWN = /(?<![\w$.])(?<!\bnew\s+)([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*(?:\?\.)?\(\s*(["'`])git\2\s*[,)]/g;

/** A `-C` argv element: the quoted flag, a comma, then any expression (not a closing bracket). */
const POSITIONAL_C = /(["'`])-C\1\s*,\s*(?=[^\s\])])/g;

/** Callees that take "git" first but spawn nothing: an error subclass's `super("git", …)`, and
 *  run-task.ts's `keyOf("git", args)`, which only builds a replay cache key. */
const NOT_A_SPAWN = new Set(["super", "keyOf"]);

export interface WidenedGitSite {
  readonly kind: "-C argv" | "cwd option" | "helper";
  /** Offset into the comment-free text. */
  readonly at: number;
  /** The enclosing top-level function, when one is found. */
  readonly fn: string | undefined;
}

/** True when `code[at]` opens a real string token: its delimiter survives masking and its body does not. */
function isStringToken(code: string, masked: string, at: number, length: number): boolean {
  return masked[at] === code[at] && masked.slice(at + 1, at + length - 1).trim() === "" && masked[at + length - 1] === code[at + length - 1];
}

/** The offset just past the bracket that closes the one at `open`, walking literal-masked text. */
function closeOf(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i]!;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return masked.length;
}

/** Names that call a node:child_process primitive in this file: its imports and their promisified aliases. */
function childProcessPrimitives(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
      if (name) names.add(name);
    }
  }
  for (const m of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*promisify\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    if (names.has(m[2]!)) names.add(m[1]!);
  }
  return names;
}

/** The top-level function (column-0 declaration) whose text holds `at`, if any. */
function enclosingFunction(code: string, at: number): string | undefined {
  let name: string | undefined;
  for (const m of code.slice(0, at).matchAll(/^(?:export )?(?:async )?function\*? ([A-Za-z_$][\w$]*)\(/gm)) name = m[1];
  return name;
}

/**
 * Every git site W1-T6106's named count cannot see in `text`: each `-C` argv by position whose target
 * is not one of WORKTREE_TARGET's spellings, and each {@link CWD_OPTION_GIT_SPAWN} call without a `-C`.
 */
export function widenedGitSites(text: string): WidenedGitSite[] {
  const code = stripComments(text);
  const masked = maskLiterals(code);
  const sites: WidenedGitSite[] = [];
  const named = new RegExp(WORKTREE_TARGET.source, "y");
  for (const m of code.matchAll(POSITIONAL_C)) {
    if (!isStringToken(code, masked, m.index, 4)) continue;
    named.lastIndex = m.index;
    if (named.test(code)) continue;
    sites.push({ kind: "-C argv", at: m.index, fn: enclosingFunction(code, m.index) });
  }
  const primitives = childProcessPrimitives(code);
  for (const m of code.matchAll(CWD_OPTION_GIT_SPAWN)) {
    const callee = m[1]!;
    const quote = m.index + m[0].indexOf(m[2]!);
    if (NOT_A_SPAWN.has(callee) || !isStringToken(code, masked, quote, 5)) continue;
    const open = code.lastIndexOf("(", quote);
    if (masked[open] !== "(") continue;
    const args = code.slice(open, closeOf(masked, open));
    const maskedArgs = masked.slice(open, open + args.length);
    if ([...args.matchAll(/(["'`])-C\1/g)].some((c) => isStringToken(args, maskedArgs, c.index, 4))) continue;
    const kind = /[{,]\s*cwd\s*[:,}]/.test(maskedArgs) ? "cwd option" : primitives.has(callee) ? undefined : "helper";
    if (kind) sites.push({ kind, at: m.index, fn: enclosingFunction(code, m.index) });
  }
  return sites.sort((a, b) => a.at - b.at);
}

/** Every file whose widened count differs from its WIDENED_SITE_EXCEPTIONS entry, with both numbers. */
export function widenedLeafSiteViolations(texts: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of texts) {
    if (file === LEAF_FILE) continue;
    const actual = widenedGitSites(text).length;
    const allowed = WIDENED_SITE_EXCEPTIONS[file]?.count ?? 0;
    if (actual > allowed) {
      out.push(`${file}: ${actual} raw git -C/cwd site(s) > ${allowed} — route each through hostWorktreeGit (src/lib/worktree-git.ts) or reason it in WIDENED_SITE_EXCEPTIONS`);
    } else if (actual < allowed) {
      out.push(`${file}: ${actual} raw git -C/cwd site(s) < exception ${allowed} — lower WIDENED_SITE_EXCEPTIONS to ${actual}`);
    }
  }
  return out.sort();
}

/**
 * W1-T6123 — the positive control's population: every git site the census can see, COMPLIANT AND RAW —
 * named `-C <worktree>` argv, widened sites, and calls into the leaf. A conversion moves a site from a
 * raw count to the leaf count, so this total holds while W1-T6121/W1-T6122 shrink the raw tables in any
 * merge order (measured 2026-10-07: 487 on main, 487 with W1-T6122's head, 476 with W1-T6121's); a
 * floor on the RAW count alone would fall through itself as the conversions land.
 */
export const VISIBLE_GIT_SITE_FLOOR = 400;

export function visibleGitSiteCount(texts: ReadonlyMap<string, string>): number {
  let n = 0;
  for (const [file, text] of texts) {
    n += text.match(WORKTREE_TARGET)?.length ?? 0;
    n += text.match(new RegExp(LEAF_CALL.source, "g"))?.length ?? 0;
    if (file !== LEAF_FILE) n += widenedGitSites(text).length;
  }
  return n;
}

/**
 * W1-T7269 — the walk lists src/ and THEN reads each file, so a file that vanishes in between (a
 * sibling test's scratch `.ts`, a checkout switching) made `readFileSync` throw ENOENT and red this
 * census on a PR that never touched it. A vanished file is not a site: it is skipped, any other
 * read error still throws.
 */
export function readAll(
  list: () => string[] = srcFiles,
  read: (file: string) => string = (file) => readFileSync(join(REPO, file), "utf8"),
): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of list()) {
    try {
      out.set(file, read(file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return out;
}

test("W1-T6106: every converted host git site calls the hardened leaf and spawns no raw git", () => {
  const texts = readAll();
  assert.ok(texts.size > 400, `the walk must see the src/ population, saw ${texts.size} file(s)`);
  assert.match(texts.get("src/lib/worktree-git.ts") ?? "", /^export function hostWorktreeGit\(/m, "the leaf exists");
  const failures: string[] = [];
  for (const [file, name] of LEAF_SITES) {
    const body = functionBody(texts.get(file) ?? "", name);
    if (body === undefined) failures.push(`${file}: ${name} not found`);
    else if (!LEAF_CALL.test(body)) failures.push(`${file}: ${name} does not call the hardened leaf`);
    else if (RAW_GIT_SPAWN.test(body)) failures.push(`${file}: ${name} still spawns git directly`);
  }
  assert.deepEqual(failures, []);
});

test("W1-T6106: no src file holds a raw git -C <worktree> spawn beyond its reasoned exception", () => {
  const texts = readAll();
  const counted = visibleGitSiteCount(texts);
  assert.ok(counted >= VISIBLE_GIT_SITE_FLOOR, `positive control: the census must see the src/ git population, saw ${counted}`);
  for (const file of Object.keys(RAW_SITE_EXCEPTIONS)) assert.ok(texts.has(file), `exception names a missing file: ${file}`);
  assert.deepEqual(rawLeafSiteViolations(texts), []);
});

test("W1-T6106: a raw git -C spawn into a worktree added to src fails the census naming its file", () => {
  const texts = readAll();
  const spawn = '\nexecFileSync("git", ["-C", worktreePath, "status"], { encoding: "utf8" });\n';
  const grown = new Map(texts);
  grown.set("src/lib/sweep.ts", `${texts.get("src/lib/sweep.ts")}${spawn}`);
  grown.set("src/lib/a-new-file.ts", spawn);
  const found = rawLeafSiteViolations(grown);
  assert.equal(found.length, 2, found.join("\n"));
  assert.match(found[0]!, /^src\/lib\/a-new-file\.ts: 1 raw git -C <worktree> spawn\(s\) > 0/);
  assert.ok(found[1]!.startsWith(`src/lib/sweep.ts: ${RAW_SITE_EXCEPTIONS["src/lib/sweep.ts"]!.count + 1} raw git -C <worktree> spawn(s) > `), found[1]);
});

test("W1-T6123: no src file holds a raw git -C/cwd site beyond its widened reasoned exception", () => {
  const texts = readAll();
  const counted = visibleGitSiteCount(texts);
  assert.ok(counted >= VISIBLE_GIT_SITE_FLOOR, `positive control: the census must see the src/ git population, saw ${counted}`);
  for (const file of Object.keys(WIDENED_SITE_EXCEPTIONS)) assert.ok(texts.has(file), `widened exception names a missing file: ${file}`);
  assert.deepEqual(widenedLeafSiteViolations(texts), []);
});

test("W1-T7269: a src file that vanishes between the listing and the read is skipped, not a failure", () => {
  const texts = readAll(
    () => ["src/lib/kept.ts", "src/lib/vanished-scratch.ts"],
    (file) => {
      if (file === "src/lib/vanished-scratch.ts") throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      return "export const kept = 1;\n";
    },
  );
  assert.deepEqual([...texts.keys()], ["src/lib/kept.ts"]);
  assert.throws(
    () => readAll(() => ["src/lib/x.ts"], () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }),
    /EACCES/,
    "only a vanished file is tolerated; any other read error still fails the census",
  );
});
