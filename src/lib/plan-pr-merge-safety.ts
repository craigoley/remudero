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
import { spawnSync } from "node:child_process";
import { execFileLoopBounded } from "./loop-bounded-child.js";
import { join, relative } from "node:path";
import { step, type Steps } from "./git-push.js";
import { singlePrRestArgs } from "./open-prs-rest.js";
import { mergePlanBlobsQuarantiningDuplicates, parseBlobBatch } from "./plan.js";
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
  | { state: "unreadable"; error: string; gitStderr?: string };

/** What {@link decidePlanPrMergeSafety} rules on. An absent path list was unreadable. */
export interface PlanMergeSafetyReadings {
  prPlanPaths?: string[];
  mainPlanPaths?: string[];
  /** Read for EVERY behind plan PR (W1-T5780): disjoint paths are evidence, never a merge basis. */
  mergedTree?: MergedTreePlan;
  /** W1-T9536 — the same two compares' full file lists, for the own-files overlap check. */
  ownFiles?: OwnFilesReadings;
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

/** W1-T9670: git's stderr tail behind an unreadable merged tree, for the ledger row's `git_stderr`. */
export function mergedTreeGitStderr(r: PlanMergeSafetyReadings | undefined): string | undefined {
  return r?.mergedTree?.state === "unreadable" ? r.mergedTree.gitStderr : undefined;
}

/** A merged tree git failed to READ (25 of 25 plan_pr_behind refreshes, 10-12..15), not one found unsafe. */
export function mergedTreeUnread(r: PlanMergeSafetyReadings | undefined): boolean {
  return r?.error === undefined && r?.mergedTree?.state === "unreadable";
}

export function plansDisjoint(prPaths: readonly string[], mainPaths: readonly string[]): boolean {
  const main = new Set(mainPaths);
  return !prPaths.some((p) => main.has(p));
}

/** W1-T5696 — the files `main` changed since a PR head, from the same compare call that measures the
 *  distance. `truncated` when GitHub capped the list (300), so absence of a path proves nothing. */
export interface BaseChangedFiles {
  files: readonly string[];
  truncated: boolean;
}

/** W1-T5696 — main-side paths that move a PR's verdict without touching any of the PR's own files:
 *  recorded baselines, the two CI workflows, and the dependency/compiler manifests. `*` matches within
 *  one path segment. */
export const REFRESH_RELEVANT_BASE_PATHS: readonly string[] = [
  "scripts/*-baseline.json",
  ".github/workflows/ci.yml",
  ".github/workflows/ci-gate.yml",
  "package.json",
  "package-lock.json",
  "tsconfig*.json",
];

/** `*` is the only glob character; every other character in a path glob is literal. */
function refreshPathMatches(glob: string, path: string): boolean {
  const parts = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]*")}$`).test(path);
}

/** W1-T5696 — does `main` carry a change this PR must re-run against, and which files say so? A
 *  missing map entry, unknown PR file list or truncated base list is `distance-unknown`: today's
 *  refresh is kept. */
export function distanceRefreshCause(
  behindBy: number,
  prFiles: readonly string[] | undefined,
  base: BaseChangedFiles | undefined,
  ceiling: number,
): { reason: "distance-overlap" | "distance-baseline" | "distance-ceiling" | "distance-unknown" | undefined; files: string[] } {
  if (base === undefined || prFiles === undefined || base.truncated) return { reason: "distance-unknown", files: [] };
  const own = new Set(prFiles);
  const overlap = base.files.filter((f) => own.has(f));
  if (overlap.length > 0) return { reason: "distance-overlap", files: overlap };
  const relevant = base.files.filter((f) => REFRESH_RELEVANT_BASE_PATHS.some((glob) => refreshPathMatches(glob, f)));
  if (relevant.length > 0) return { reason: "distance-baseline", files: relevant };
  if (behindBy > ceiling) return { reason: "distance-ceiling", files: [] };
  return { reason: undefined, files: [] };
}

/** W1-T9536 — the PR's own non-plan files (`undefined` when unread or cut short) and main's files
 *  since the merge base. Plan paths are left to the merged-plan load (W1-T5748). */
export interface OwnFilesReadings {
  prFiles?: string[];
  mainFiles?: BaseChangedFiles;
  error?: string;
}

/** W1-T9536 — W1-T5696's overlap and baseline arms, with no distance arm: main changed this PR's own
 *  files, a refresh-relevant path, or a list went unread. Any cause refreshes a behind PR. */
export function mainChangedOwnFiles(own: OwnFilesReadings | undefined): { cause: "overlap" | "baseline" | "unread"; files: string[] } | undefined {
  // A plan-only PR (#11901, 10-15) has no own file main can change: the merged-plan load judges it.
  if (own?.error === undefined && own?.prFiles?.length === 0) return undefined;
  const cause = distanceRefreshCause(0, own?.prFiles, own?.error === undefined ? own?.mainFiles : undefined, Infinity);
  if (cause.reason === "distance-overlap") return { cause: "overlap", files: cause.files };
  if (cause.reason === "distance-baseline") return { cause: "baseline", files: cause.files };
  return cause.reason === undefined ? undefined : { cause: "unread", files: [] };
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
  /** W1-T9670: the signal that ended the child (its timeout's kill); absent or null when it exited. */
  signal?: string | null;
  /** W1-T9670: the tail of what git wrote to stderr ({@link STDERR_TAIL_CHARS}). */
  stderr?: string;
}

/** W1-T9670: how much of git's stderr a reading keeps — its last lines name the failure. */
const STDERR_TAIL_CHARS = 800;

function stderrTail(text: string | undefined): string {
  const t = (text ?? "").trim();
  return t.length > STDERR_TAIL_CHARS ? `...${t.slice(-STDERR_TAIL_CHARS)}` : t;
}
/** One git call in the repo clone; never throws for a non-zero exit. */
export type PlanSafetyGit = (args: readonly string[], stdin?: string) => PlanSafetyGitResult | Promise<PlanSafetyGitResult>;

export function planSafetyGitSync(cwd: string): PlanSafetyGit {
  return (args, stdin) => {
    const res = spawnSync("git", [...args], { cwd, encoding: "utf8", input: stdin, timeout: GIT_CALL_MS, maxBuffer: 1 << 26 });
    return { status: res.status, stdout: res.stdout ?? "", signal: res.signal, stderr: stderrTail(res.stderr) };
  };
}

export function planSafetyGitAsync(cwd: string): PlanSafetyGit {
  return (args, stdin) =>
    new Promise((resolve) => {
      const command = execFileLoopBounded("git", [...args], { cwd, encoding: "utf8", timeout: GIT_CALL_MS, maxBuffer: 1 << 26 });
      command.then(
        ({ stdout, stderr }) => resolve({ status: 0, stdout: stdout ?? "", signal: null, stderr: stderrTail(stderr) }),
        (error: { code?: unknown; stdout?: unknown; stderr?: unknown; signal?: string | null }) => {
          const { code } = error;
          const stderr = typeof error.stderr === "string" ? error.stderr : "";
          // a non-numeric code (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) is Node's reason, kept beside git's own words.
          const said = typeof code === "string" ? `${stderr}\n${code}` : stderr;
          resolve({ status: typeof code === "number" ? code : null, stdout: typeof error.stdout === "string" ? error.stdout : "", signal: error.signal ?? null, stderr: stderrTail(said) });
        },
      );
      const child = command.child;
      // a verb that exits before reading stdin must not surface as an EPIPE on the daemon.
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin);
    });
}

/** Both lists a compare names (a rename counts its old path); `undefined` without a files array. */
function compareFiles(compare: unknown): BaseChangedFiles | undefined {
  const files = (compare as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files)) return undefined;
  const names = files
    .flatMap((f) => [(f as { filename?: unknown })?.filename, (f as { previous_filename?: unknown })?.previous_filename])
    .filter((p): p is string => typeof p === "string");
  return { files: names, truncated: files.length >= COMPARE_FILES_SHOWN };
}

function ownFilesFrom(prCompare: unknown, mainCompare: unknown, planDir: string): OwnFilesReadings {
  const pr = compareFiles(prCompare);
  const mainFiles = compareFiles(mainCompare);
  const prFiles = pr && !pr.truncated ? pr.files.filter((p) => !p.startsWith(`${planDir}/`)) : undefined;
  return { ...(prFiles ? { prFiles } : {}), ...(mainFiles ? { mainFiles } : {}) };
}

type CompareReads =
  | { base: string; head: string; prCompare: unknown; mainCompare: unknown; mainTip: string }
  | { error: string; prCompare?: unknown };

/** The PR's row (base ref, head), `compare/<base>...<head>` (its files, merge base and main's tip),
 *  then `compare/<merge base>...<main tip>` (main's files since). A read that throws propagates. */
function* compareReadsSteps(target: { owner: string; repo: string; prNumber: number }, rest: (args: string[]) => unknown): Steps<CompareReads> {
  const api = `repos/${target.owner}/${target.repo}`;
  const pr = (yield* step(() => rest(singlePrRestArgs(target.owner, target.repo, target.prNumber)))) as
    | { base?: { ref?: unknown }; head?: { sha?: unknown } }
    | undefined;
  const base = pr?.base?.ref;
  const head = pr?.head?.sha;
  if (typeof base !== "string" || typeof head !== "string") return { error: "the pull read named no base ref or head sha" };
  const prCompare = (yield* step(() => rest(["api", `${api}/compare/${encodeURIComponent(base)}...${head}`]))) as
    | { base_commit?: { sha?: unknown }; merge_base_commit?: { sha?: unknown } }
    | undefined;
  const mergeBase = prCompare?.merge_base_commit?.sha;
  const mainTip = prCompare?.base_commit?.sha;
  if (typeof mergeBase !== "string" || typeof mainTip !== "string") return { prCompare, error: "the compare named no merge base or main tip" };
  const mainCompare = yield* step(() => rest(["api", `${api}/compare/${mergeBase}...${mainTip}`]));
  return { base, head, prCompare, mainCompare, mainTip };
}

/** W1-T9536 — {@link OwnFilesReadings} for a behind PR that touches no plan path. */
export function* readOwnFilesSteps(
  target: { owner: string; repo: string; prNumber: number },
  rest: (args: string[]) => unknown,
  plan: PlanRelPaths = planRelPaths("/", () => undefined),
): Steps<OwnFilesReadings> {
  try {
    const reads = yield* compareReadsSteps(target, rest);
    if ("error" in reads) return { error: reads.error };
    return ownFilesFrom(reads.prCompare, reads.mainCompare, plan.planDir);
  } catch (e) {
    // an unread list is the reading: mainChangedOwnFiles refreshes on it.
    return { error: String((e as Error)?.message ?? e) };
  }
}

/**
 * The readings for one PR, from {@link compareReadsSteps}'s reads. Git then merges the two for EVERY
 * PR: the path lists are evidence only (W1-T5780).
 */
export function* readPlanMergeSafetySteps(
  target: { owner: string; repo: string; prNumber: number },
  rest: (args: string[]) => unknown,
  git: PlanSafetyGit,
  plan: PlanRelPaths = planRelPaths("/", () => undefined),
): Steps<PlanMergeSafetyReadings> {
  try {
    const reads = yield* compareReadsSteps(target, rest);
    if ("error" in reads) {
      return "prCompare" in reads ? { prPlanPaths: comparePlanPaths(reads.prCompare, plan.planDir), error: reads.error } : { error: reads.error };
    }
    const prPlanPaths = comparePlanPaths(reads.prCompare, plan.planDir);
    const mainPlanPaths = comparePlanPaths(reads.mainCompare, plan.planDir);
    const readings = { ...(prPlanPaths ? { prPlanPaths } : {}), ...(mainPlanPaths ? { mainPlanPaths } : {}) };
    const ownFiles = ownFilesFrom(reads.prCompare, reads.mainCompare, plan.planDir);
    const mergedTree = yield* mergedTreePlanSteps(git, plan, { sha: reads.mainTip, ref: reads.base }, { sha: reads.head, ref: `refs/pull/${target.prNumber}/head` });
    return { ...readings, ownFiles, mergedTree };
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
      const fetched = yield* gitStep(git, ["fetch", "--no-tags", "--quiet", "origin", c.ref]);
      if ((yield* gitStep(git, ["cat-file", "-e", `${c.sha}^{commit}`])).status !== 0) {
        return fetched.status === 0 ? { state: "unreadable", error: `${c.sha} is not in the clone after fetching ${c.ref}` }
          : gitStepUnreadable(`git fetch ${c.ref}`, fetched);
      }
    }
    const merged = yield* gitStep(git, ["merge-tree", "--write-tree", "--no-messages", main.sha, head.sha]);
    const tree = merged.stdout.split("\n")[0]?.trim() ?? "";
    if (merged.status === 1) return { state: "conflict" };
    if (merged.status !== 0) return gitStepUnreadable("git merge-tree", merged);
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return { state: "unreadable", error: `git merge-tree exited ${merged.status} without a tree` };
    // One listing that carries each blob id, and the batch reads by id. A `<tree>:<path>` request
    // re-resolves the path through tasks.d's tree once per shard: 4,577 shards took ~10 s that way
    // against 0.2 s by id, and the host's 60 s bound killed the read 74 times in 48 h (2026-10-28).
    const shardDir = `${join(plan.planDir, "tasks.d")}/`;
    const listing = yield* gitStep(git, ["ls-tree", tree, "--", plan.monolith, shardDir]);
    if (listing.status !== 0) return gitStepUnreadable("git ls-tree", listing);
    const ids = new Map<string, string>();
    for (const line of listing.stdout.split("\n").filter(Boolean)) {
      const entry = /^\d{6} [a-z]+ ([0-9a-f]{40,64})\t(.+)$/.exec(line);
      if (!entry) return withStderr({ state: "unreadable", error: `git ls-tree gave an unusable line: ${line}` }, listing);
      ids.set(entry[2]!, entry[1]!);
    }
    const shards = [...ids.keys()].filter((p) => p.startsWith(shardDir) && p.endsWith(".yaml")).sort();
    const paths = [plan.monolith, ...shards];
    // a monolith the listing lacks is still requested by path, so git itself says it is missing.
    const request = paths.map((p) => ids.get(p) ?? `${tree}:${p}`).join("\n") + "\n";
    const batch = yield* gitStep(git, ["cat-file", "--batch"], request);
    if (batch.status !== 0) return gitStepUnreadable("git cat-file --batch", batch);
    let texts: string[];
    try {
      texts = parseBlobBatch(batch.stdout, tree, paths);
    } catch (e) {
      // exit 0 with too little stdout: the third case, told apart from a kill and a git failure.
      const message = String((e as Error)?.message ?? e);
      const shape = /ended before|unusable size/.test(message) ? "truncated" : "unusable";
      return withStderr({ state: "unreadable", error: `the batch read was ${shape}: ${message}` }, batch);
    }
    return mergedPlanState(paths.map((p, i) => ({ label: `merged:${p}`, text: texts[i] })));
  } catch (e) {
    // a git spawn or blob read that fails is unreadable, which refreshes — never "loads".
    return { state: "unreadable", error: String((e as Error)?.message ?? e) };
  }
}

/** W1-T9670: one failed git step, named with its verb: killed by its bound, or git failed in its own words. */
function gitStepUnreadable(verb: string, res: PlanSafetyGitResult): MergedTreePlan {
  const how = res.signal ? `exited null, killed by ${res.signal} (its bound)`
    : res.status === null ? "exited null (killed or failed mid-read)" : `exited ${res.status}, git failed`;
  return withStderr({ state: "unreadable", error: `${verb} ${how}` }, res);
}

function withStderr(reading: { state: "unreadable"; error: string }, res: PlanSafetyGitResult): MergedTreePlan {
  return res.stderr ? { ...reading, error: `${reading.error}: ${res.stderr}`, gitStderr: res.stderr } : reading;
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
