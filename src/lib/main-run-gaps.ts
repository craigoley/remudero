import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * W1-T4817 — A MAIN COMMIT NO WORKFLOW RAN ON IS NEVER NOTICED.
 *
 * OBSERVED 2026-09-29: main commits 30f3c7b58 (#7823) and 9b694d664 have zero workflow runs of any
 * kind — `gh run list --commit` is empty and GitHub's activity log for main has no entry moving
 * main to either. Each merged seconds before another fleet auto-merge; GitHub fired no push event
 * for the first. The next push's `before..after` diff then excluded them, so a path-filtered
 * workflow (acr-build) never saw their changes, and CI's verdict on them exists only through a
 * later commit's run.
 *
 * THE RULE THIS MODULE HOLDS: a commit is covered by ITS OWN runs, never by its successor's. A
 * later commit's runs prove only that the event pipeline was alive afterwards — which is exactly
 * what makes an earlier commit's ZERO runs a real gap rather than a delivery that has not
 * happened yet ({@link findMainCommitsWithNoRuns}). The head itself is never judged.
 *
 * Every read and effect is injected, so the module never spawns `gh` and a test drives both arms
 * (a gap found / none found, a dispatch that lands / one that throws) with fakes.
 */

/** The ledger step a recorded reconcile is written under — one row per gap commit per pass. */
export const MAIN_RUN_GAP_STEP = "main.run_gap.dispatched";

/** How many first-parent commits back the finder looks. A gap older than this ages out rather
 *  than costing an API read per commit on every pass, forever. */
export const MAIN_RUN_GAP_LOOKBACK = 15;

/** A main commit as `GET /repos/{o}/{r}/commits` reports it: its own sha and its parents'. */
export interface MainCommitRef {
  sha: string;
  parents: readonly string[];
}

export interface MainRunGapReader {
  /** Newest-first commits reachable from main, as the REST list endpoint returns them. */
  listMainCommits(limit: number): Promise<readonly MainCommitRef[]>;
  /** How many workflow runs exist for this head sha; `undefined` when the read failed. */
  countRunsForSha(sha: string): Promise<number | undefined>;
}

/**
 * The first-parent chain from the newest commit, newest first. The list endpoint returns every
 * reachable commit by date, which interleaves a merge commit's side branch; following
 * `parents[0]` from the head keeps only the commits that were themselves pushed to main.
 */
export function firstParentChain(commits: readonly MainCommitRef[]): string[] {
  const bySha = new Map(commits.map((c) => [c.sha, c] as const));
  const chain: string[] = [];
  let cursor: MainCommitRef | undefined = commits[0];
  while (cursor && !chain.includes(cursor.sha)) {
    chain.push(cursor.sha);
    const parent: string | undefined = cursor.parents[0];
    cursor = parent === undefined ? undefined : bySha.get(parent);
  }
  return chain;
}

export interface FindMainRunGapOptions {
  lookback?: number;
  /** Commits already handled — skipped without a read, and never used as evidence. */
  skip?: ReadonlySet<string>;
}

/**
 * The first-parent main commits with ZERO workflow runs, newest first. A commit is judged only
 * once a NEWER commit's runs exist: without that, "no runs yet" is just an event still in flight
 * (the head, always) rather than a delivery that never happened. A commit whose count could not be
 * read is neither a gap nor evidence.
 */
export async function findMainCommitsWithNoRuns(
  reader: MainRunGapReader,
  opts: FindMainRunGapOptions = {},
): Promise<string[]> {
  const lookback = opts.lookback ?? MAIN_RUN_GAP_LOOKBACK;
  const skip = opts.skip ?? new Set<string>();
  const chain = firstParentChain(await reader.listMainCommits(lookback)).slice(0, lookback);
  const gaps: string[] = [];
  let newerHasRuns = false;
  for (const sha of chain) {
    if (skip.has(sha)) continue;
    const count = await reader.countRunsForSha(sha);
    if (count === undefined) continue;
    if (count > 0) newerHasRuns = true;
    else if (newerHasRuns) gaps.push(sha);
  }
  return gaps;
}

// ── which workflows a commit's paths call for ────────────────────────────────────────────────

/** One workflow's push trigger, reduced to what deciding "would this push have run me" needs. */
export interface WorkflowPushTrigger {
  /** Basename under `.github/workflows/`, the form the dispatches endpoint takes. */
  file: string;
  /** `workflow_dispatch` is declared — without it there is nothing to re-run by hand. */
  dispatchable: boolean;
  /** `undefined`: no `push` trigger at all. */
  push?: {
    branches?: readonly string[];
    branchesIgnore?: readonly string[];
    paths?: readonly string[];
    pathsIgnore?: readonly string[];
  };
}

function stringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

/** Reduce one workflow file's text to its {@link WorkflowPushTrigger}. */
export function parseWorkflowPushTrigger(file: string, text: string): WorkflowPushTrigger {
  const doc = parseYaml(text) as { on?: unknown } | null;
  const on = doc?.on;
  if (typeof on === "string") return { file, dispatchable: on === "workflow_dispatch", push: on === "push" ? {} : undefined };
  if (Array.isArray(on)) {
    return { file, dispatchable: on.includes("workflow_dispatch"), push: on.includes("push") ? {} : undefined };
  }
  if (on === null || typeof on !== "object") return { file, dispatchable: false };
  const triggers = on as Record<string, unknown>;
  const dispatchable = "workflow_dispatch" in triggers;
  if (!("push" in triggers)) return { file, dispatchable };
  const push = (triggers.push ?? {}) as Record<string, unknown>;
  return {
    file,
    dispatchable,
    push: {
      branches: stringList(push.branches),
      branchesIgnore: stringList(push["branches-ignore"]),
      paths: stringList(push.paths),
      pathsIgnore: stringList(push["paths-ignore"]),
    },
  };
}

/** Read every workflow's trigger from a checkout's `.github/workflows` directory. */
export function readWorkflowPushTriggers(repoRoot: string): WorkflowPushTrigger[] {
  const dir = join(repoRoot, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => parseWorkflowPushTrigger(name, readFileSync(join(dir, name), "utf8")));
}

/** GitHub's filter-pattern glob: `**` crosses `/`, `*` and `?` do not. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Positive patterns include, a later `!pattern` excludes, the last match wins. */
function matchesFilter(patterns: readonly string[], value: string): boolean {
  let matched = false;
  for (const p of patterns) {
    const negated = p.startsWith("!");
    if (globToRegExp(negated ? p.slice(1) : p).test(value)) matched = !negated;
  }
  return matched;
}

/**
 * The dispatchable workflows a push of `changed` paths to `branch` would have started. A
 * workflow with no `push` trigger, no `workflow_dispatch`, a branch filter that excludes the
 * branch, or a path filter the change does not touch is never named.
 */
export function workflowsForPaths(
  triggers: readonly WorkflowPushTrigger[],
  changed: readonly string[],
  branch = "main",
): string[] {
  const out: string[] = [];
  for (const t of triggers) {
    if (!t.dispatchable || !t.push) continue;
    const { branches, branchesIgnore, paths, pathsIgnore } = t.push;
    if (branches && !matchesFilter(branches, branch)) continue;
    if (branchesIgnore && matchesFilter(branchesIgnore, branch)) continue;
    if (paths && !changed.some((f) => matchesFilter(paths, f))) continue;
    if (pathsIgnore && changed.length > 0 && changed.every((f) => matchesFilter(pathsIgnore, f))) continue;
    out.push(t.file);
  }
  return out;
}

// ── dedupe: never dispatch twice for one commit ──────────────────────────────────────────────

export interface MainRunGapHistory {
  /** Commits a row recorded with nothing failed — finished, never re-read. */
  complete: ReadonlySet<string>;
  /** Per commit, every workflow a row says was dispatched for it. */
  dispatched: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Fold the ledger's {@link MAIN_RUN_GAP_STEP} rows into the dedupe history. */
export function mainRunGapHistoryFromLedger(lines: ReadonlyArray<Record<string, unknown>>): MainRunGapHistory {
  const complete = new Set<string>();
  const dispatched = new Map<string, Set<string>>();
  for (const line of lines) {
    if (line.step !== MAIN_RUN_GAP_STEP || typeof line.commit !== "string") continue;
    const done = dispatched.get(line.commit) ?? new Set<string>();
    for (const w of stringList(line.workflows) ?? []) done.add(w);
    dispatched.set(line.commit, done);
    if ((stringList(line.failed) ?? []).length === 0) complete.add(line.commit);
  }
  return { complete, dispatched };
}

/** What one reconcile did for one gap commit — the payload of its ledger row. */
export interface MainRunGapDispatch {
  commit: string;
  /** Main's head the workflows were dispatched at (a ref, so it contains the commit). */
  head: string;
  ref: string;
  /** Workflows whose dispatch landed for this commit. */
  workflows: string[];
  /** Workflows whose dispatch threw — retried by a later pass, since the row is not complete. */
  failed: string[];
  /** Why each `failed` workflow was refused, keyed by workflow file. */
  errors: Record<string, string>;
}

export interface DispatchMainRunGapsInput {
  gaps: readonly string[];
  head: string;
  history: MainRunGapHistory;
  triggers: readonly WorkflowPushTrigger[];
  /** Paths a commit changed; `undefined` when unreadable, which leaves the commit for a later pass. */
  changedFiles(sha: string): Promise<readonly string[] | undefined>;
  /** Start one workflow at `ref`. Throws when GitHub refuses. */
  dispatch(workflowFile: string, ref: string): void | Promise<void>;
  ref?: string;
}

/**
 * Dispatch, at main's head, each workflow the gap commits' paths call for. One dispatch per
 * workflow per pass however many gaps want it (the run at head covers them all), credited to every
 * commit that wanted it; a (commit, workflow) pair already in the history is never dispatched
 * again, and a commit whose row is complete is never re-read.
 */
export async function dispatchMainRunGaps(input: DispatchMainRunGapsInput): Promise<MainRunGapDispatch[]> {
  const ref = input.ref ?? "main";
  const wanted = new Map<string, string[]>();
  for (const commit of input.gaps) {
    if (input.history.complete.has(commit)) continue;
    const changed = await input.changedFiles(commit);
    if (changed === undefined) continue;
    const already = input.history.dispatched.get(commit) ?? new Set<string>();
    wanted.set(commit, workflowsForPaths(input.triggers, changed, ref).filter((w) => !already.has(w)));
  }
  // true = landed; a string = the reason GitHub refused.
  const outcome = new Map<string, true | string>();
  for (const files of wanted.values()) {
    for (const file of files) {
      if (outcome.has(file)) continue;
      try {
        await input.dispatch(file, ref);
        outcome.set(file, true);
      } catch (error) {
        // A refused dispatch is recorded on the row (`failed`, with its reason) and retried next
        // pass; it must not stop the workflows after it.
        outcome.set(file, String((error as Error)?.message ?? error));
      }
    }
  }
  const results: MainRunGapDispatch[] = [];
  for (const [commit, files] of wanted) {
    results.push({
      commit,
      head: input.head,
      ref,
      workflows: files.filter((f) => outcome.get(f) === true),
      failed: files.filter((f) => outcome.get(f) !== true),
      errors: Object.fromEntries(
        files.flatMap((f) => {
          const o = outcome.get(f);
          return typeof o === "string" ? [[f, o] as const] : [];
        }),
      ),
    });
  }
  return results;
}
