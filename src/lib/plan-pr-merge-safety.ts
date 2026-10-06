/**
 * W1-T5748 — WHETHER A BEHIND PLAN PR CAN MERGE AS-IS. W1-T5472 refreshed every behind plan PR,
 * because #8871 merged two commits behind and git joined two `priority:` lines into one shard. A
 * refreshed plan PR needs ~15 min of checks and review and main moves faster, so batch 9 (#9138)
 * and batch 10 (#9155) were re-headed again and again on 2026-10-04 and never merged.
 *
 * The hazard is a merged plan that does not load. Only one case rules it out: the MERGED TREE LOADS
 * — `git merge-tree` of the PR head into main's tip is clean and the plan read from that tree's
 * blobs quarantines nothing. W1-T5780: path DISJOINTNESS is not that (two shards may declare one
 * new id, or a depends_on may name a task main removed), so it is evidence, never a basis.
 * Anything else, or an unreadable input: refresh, up to
 * {@link PLAN_PR_REFRESH_BOUND} times, then escalate to the operator.
 */
import { execFile, spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { step, type Steps } from "./git-push.js";
import { singlePrRestArgs } from "./open-prs-rest.js";
import { mergePlanBlobsQuarantiningDuplicates, readBlobsAtRef } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";

/** BACKSTOP: plan_pr_behind refreshes one PR may take before it is escalated instead. The safe
 *  merge above is the primary control; this fires only when the merged plan stays unprovable. */
export const PLAN_PR_REFRESH_BOUND = 3;

/** GitHub's compare lists at most 300 files; a list that long may hide a plan path past it. */
const COMPARE_FILES_SHOWN = 300;
/** BACKSTOP on one git call (a fetch can hang on the network). */
const GIT_CALL_MS = 60_000;

/** The plan's paths inside a repo, relative to its root: the monolith and the shard directory. */
export interface PlanRelPaths {
  monolith: string;
  planDir: string;
}

/** {@link PlanRelPaths} from the repo's own layout ({@link resolveRepoLayout}). */
export function planRelPaths(root: string, readOverride?: (path: string) => string | undefined): PlanRelPaths {
  const layout = resolveRepoLayout(root, readOverride); // undefined reads the root's own override file
  return { monolith: relative(root, layout.planMonolith), planDir: relative(root, layout.planDir) };
}

export type MergedTreePlan =
  | { state: "loads" }
  | { state: "conflict" }
  | { state: "quarantined"; ids: string[] }
  | { state: "refused"; detail: string }
  | { state: "unreadable"; error: string };

/** What {@link decidePlanPrMergeSafety} rules on. An absent path list was unreadable. */
export interface PlanMergeSafetyReadings {
  prPlanPaths?: string[];
  mainPlanPaths?: string[];
  /** Read for EVERY behind plan PR (W1-T5780): disjoint paths are evidence, never a merge basis. */
  mergedTree?: MergedTreePlan;
  error?: string;
}

/** W1-T5780: the only basis is a merged tree that loads; path disjointness is evidence beside it. */
export type PlanMergeSafeBasis = "merged_tree";

export interface PlanPrRefreshes {
  count: number;
  heads: string[];
}

export type PlanPrMergeSafetyDecision =
  | { action: "merge"; basis: PlanMergeSafeBasis; disjoint: boolean }
  | { action: "refresh"; why: string }
  | { action: "escalate"; why: string; refreshes: number; heads: string[] };

export function decidePlanPrMergeSafety(input: {
  readings: PlanMergeSafetyReadings | undefined;
  refreshes: PlanPrRefreshes;
  bound?: number;
}): PlanPrMergeSafetyDecision {
  const r = input.readings;
  // Disjoint PATHS do not make a disjoint PLAN: two shards can declare one new id, or a depends_on can
  // name a task main removed, with no path in common. Only the merged plan loading is a basis.
  if (r?.mergedTree?.state === "loads") {
    const disjoint = !!r.prPlanPaths && !!r.mainPlanPaths && plansDisjoint(r.prPlanPaths, r.mainPlanPaths);
    return { action: "merge", basis: "merged_tree", disjoint };
  }
  const why = unsafeReason(r);
  if (input.refreshes.count >= (input.bound ?? PLAN_PR_REFRESH_BOUND)) {
    return { action: "escalate", why, refreshes: input.refreshes.count, heads: input.refreshes.heads };
  }
  return { action: "refresh", why };
}

function unsafeReason(r: PlanMergeSafetyReadings | undefined): string {
  if (r === undefined) return "no plan merge-safety reader is wired";
  if (r.error !== undefined) return r.error;
  const tree = r.mergedTree;
  if (tree?.state === "conflict") return "the merged tree conflicts";
  if (tree?.state === "quarantined") return `the merged plan quarantines ${tree.ids.join(", ")}`;
  if (tree?.state === "refused") return `the merged plan does not load: ${tree.detail}`;
  if (tree?.state === "unreadable") return `the merged tree was unreadable: ${tree.error}`;
  if (!r.prPlanPaths) return "the PR's plan paths were unreadable";
  if (!r.mainPlanPaths) return "main's plan changes since the merge base were unreadable";
  return "the merged tree was not read";
}

export function plansDisjoint(prPaths: readonly string[], mainPaths: readonly string[]): boolean {
  const main = new Set(mainPaths);
  return !prPaths.some((p) => main.has(p));
}

/** This PR's earlier `plan_pr_behind` refreshes, with the head each one replaced. */
export function planPrRefreshesFromLedger(lines: ReadonlyArray<Record<string, unknown>>, prUrl: string): PlanPrRefreshes {
  const rows = lines.filter((l) => l.step === "automerge.direct_merge_updated" && l.reason === "plan_pr_behind" && l.pr_url === prUrl);
  return { count: rows.length, heads: rows.flatMap((l) => (typeof l.prior_head_sha === "string" ? [l.prior_head_sha] : [])) };
}

/** A compare's plan paths (a rename counts its old path), or `undefined` when the list cannot be
 *  trusted: absent, empty, or as long as GitHub ever shows. */
function comparePlanPaths(compare: unknown, planDir: string): string[] | undefined {
  const files = (compare as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files) || files.length === 0 || files.length >= COMPARE_FILES_SHOWN) return undefined;
  return files
    .flatMap((f) => [(f as { filename?: unknown })?.filename, (f as { previous_filename?: unknown })?.previous_filename])
    .filter((p): p is string => typeof p === "string" && p.startsWith(`${planDir}/`));
}

export interface PlanSafetyGitResult {
  status: number | null;
  stdout: string;
}
/** One git call in the repo clone; never throws for a non-zero exit. */
export type PlanSafetyGit = (args: readonly string[], stdin?: string) => PlanSafetyGitResult | Promise<PlanSafetyGitResult>;

export function planSafetyGitSync(cwd: string): PlanSafetyGit {
  return (args, stdin) => {
    const res = spawnSync("git", [...args], { cwd, encoding: "utf8", input: stdin, timeout: GIT_CALL_MS, maxBuffer: 1 << 26 });
    return { status: res.status, stdout: res.stdout ?? "" };
  };
}

export function planSafetyGitAsync(cwd: string): PlanSafetyGit {
  return (args, stdin) =>
    new Promise((resolve) => {
      const child = execFile("git", [...args], { cwd, encoding: "utf8", timeout: GIT_CALL_MS, maxBuffer: 1 << 26 }, (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ status: error ? (typeof code === "number" ? code : null) : 0, stdout: stdout ?? "" });
      });
      // a verb that exits before reading stdin must not surface as an EPIPE on the daemon.
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin);
    });
}

/**
 * The readings for one PR: its row (base ref, head), `compare/<base>...<head>` (the PR's plan
 * paths, its merge base and main's tip), then `compare/<merge base>...<main tip>` (main's plan
 * paths since). Git then merges the two for EVERY PR: the path lists are evidence only (W1-T5780).
 */
export function* readPlanMergeSafetySteps(
  target: { owner: string; repo: string; prNumber: number },
  rest: (args: string[]) => unknown,
  git: PlanSafetyGit,
  plan: PlanRelPaths = planRelPaths("/", () => undefined),
): Steps<PlanMergeSafetyReadings> {
  const api = `repos/${target.owner}/${target.repo}`;
  try {
    const pr = (yield* step(() => rest(singlePrRestArgs(target.owner, target.repo, target.prNumber)))) as
      | { base?: { ref?: unknown }; head?: { sha?: unknown } }
      | undefined;
    const base = pr?.base?.ref;
    const head = pr?.head?.sha;
    if (typeof base !== "string" || typeof head !== "string") return { error: "the pull read named no base ref or head sha" };
    const prCompare = (yield* step(() => rest(["api", `${api}/compare/${encodeURIComponent(base)}...${head}`]))) as
      | { base_commit?: { sha?: unknown }; merge_base_commit?: { sha?: unknown } }
      | undefined;
    const prPlanPaths = comparePlanPaths(prCompare, plan.planDir);
    const mergeBase = prCompare?.merge_base_commit?.sha;
    const mainTip = prCompare?.base_commit?.sha;
    if (typeof mergeBase !== "string" || typeof mainTip !== "string") return { prPlanPaths, error: "the compare named no merge base or main tip" };
    const mainCompare = yield* step(() => rest(["api", `${api}/compare/${mergeBase}...${mainTip}`]));
    const mainPlanPaths = comparePlanPaths(mainCompare, plan.planDir);
    const readings = { ...(prPlanPaths ? { prPlanPaths } : {}), ...(mainPlanPaths ? { mainPlanPaths } : {}) };
    const mergedTree = yield* mergedTreePlanSteps(git, plan, { sha: mainTip, ref: base }, { sha: head, ref: `refs/pull/${target.prNumber}/head` });
    return { ...readings, mergedTree };
  } catch (e) {
    // the read failure is the reading: decidePlanPrMergeSafety refreshes on it, naming it.
    return { error: String((e as Error)?.message ?? e) };
  }
}

function* mergedTreePlanSteps(
  git: PlanSafetyGit,
  plan: PlanRelPaths,
  main: { sha: string; ref: string },
  head: { sha: string; ref: string },
): Steps<MergedTreePlan> {
  try {
    for (const c of [main, head]) {
      if ((yield* gitStep(git, ["cat-file", "-e", `${c.sha}^{commit}`])).status === 0) continue;
      yield* gitStep(git, ["fetch", "--no-tags", "--quiet", "origin", c.ref]);
      if ((yield* gitStep(git, ["cat-file", "-e", `${c.sha}^{commit}`])).status !== 0) {
        return { state: "unreadable", error: `${c.sha} is not in the clone after fetching ${c.ref}` };
      }
    }
    const merged = yield* gitStep(git, ["merge-tree", "--write-tree", "--no-messages", main.sha, head.sha]);
    const tree = merged.stdout.split("\n")[0]?.trim() ?? "";
    if (merged.status === 1) return { state: "conflict" };
    if (merged.status !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) {
      return { state: "unreadable", error: `git merge-tree exited ${merged.status} without a tree` };
    }
    const listing = yield* gitStep(git, ["ls-tree", "--name-only", tree, `${join(plan.planDir, "tasks.d")}/`]);
    if (listing.status !== 0) return { state: "unreadable", error: `git ls-tree exited ${listing.status}` };
    const paths = [plan.monolith, ...listing.stdout.split("\n").filter((p) => p.endsWith(".yaml")).sort()];
    const batch = yield* gitStep(git, ["cat-file", "--batch"], paths.map((p) => `${tree}:${p}`).join("\n") + "\n");
    const texts = readBlobsAtRef(() => batch.stdout, tree, paths);
    return mergedPlanState(paths.map((p, i) => ({ label: `merged:${p}`, text: texts[i] })));
  } catch (e) {
    // a git spawn or blob read that fails is unreadable, which refreshes — never "loads".
    return { state: "unreadable", error: String((e as Error)?.message ?? e) };
  }
}

function* gitStep(git: PlanSafetyGit, args: readonly string[], stdin?: string): Steps<PlanSafetyGitResult> {
  return yield* step(() => git(args, stdin));
}

function mergedPlanState(blobs: Array<{ label: string; text: string }>): MergedTreePlan {
  try {
    const { quarantined } = mergePlanBlobsQuarantiningDuplicates(blobs);
    return quarantined.length === 0 ? { state: "loads" } : { state: "quarantined", ids: quarantined.map((q) => q.id) };
  } catch (e) {
    // the monolith, or a dependency the merge left unresolved, refuses the whole plan.
    return { state: "refused", detail: String((e as Error)?.message ?? e).split("\n")[0] };
  }
}
