import { execFile } from "node:child_process";
import { readLedgerLines } from "./status.js";
import type { OpenPrView } from "./sweep.js";

export const MERGE_PROBE_STEP = "sweep.merge_probe";
/** PRIMARY CONTROL on the git work one pass may spend; unprobed pairs carry over to the next pass. */
export const MERGE_PROBE_LIMIT = 3;
/** BACKSTOP on one ledger row's size; a conflict touching more paths is truncated. */
export const MERGE_PROBE_MAX_PATHS = 20;
const GIT_TIMEOUT_MS = 60_000;

export interface MergeProbeGitResult {
  status: number | null;
  stdout: string;
}
export type MergeProbeGit = (args: readonly string[]) => MergeProbeGitResult | Promise<MergeProbeGitResult>;

export type MergeProbeResult =
  | { verdict: "clean"; tree: string }
  | { verdict: "conflict"; paths: string[] }
  | { verdict: "unreadable"; reason: string };

export function defaultMergeProbeGit(cwd: string): MergeProbeGit {
  // GitHub and merge-tree can take the full timeout. Keep that wait off the daemon's event loop so
  // its review clock can still admit and post reviews while this observation is in flight.
  return (args) => new Promise((resolve) => {
    try {
      execFile("git", [...args], { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ status: error ? (typeof code === "number" ? code : null) : 0, stdout: stdout ?? "" });
      });
    } catch {
      resolve({ status: null, stdout: "" });
    }
  });
}

/** Read-only test merge: exit 0 is clean, exit 1 a conflict, anything else unreadable. */
export async function probeMerge(input: { headSha: string; mainSha: string; git: MergeProbeGit }): Promise<MergeProbeResult> {
  try {
    const res = await input.git(["merge-tree", "--write-tree", "--name-only", "--no-messages", input.headSha, input.mainSha]);
    const lines = res.stdout.split("\n").filter((line) => line !== "");
    const tree = lines[0] ?? "";
    if (!/^[0-9a-f]{40,64}$/.test(tree) || (res.status !== 0 && res.status !== 1)) {
      return { verdict: "unreadable", reason: `git merge-tree exited ${res.status} without a tree` };
    }
    if (res.status === 0) return { verdict: "clean", tree };
    return { verdict: "conflict", paths: [...new Set(lines.slice(1))].slice(0, MERGE_PROBE_MAX_PATHS) };
  } catch (e) {
    return { verdict: "unreadable", reason: String((e as Error)?.message ?? e) };
  }
}

/** PR numbers a `Stacked on #N` line names, as data only. */
export function stackedOnNumbers(body: string | undefined): number[] {
  const line = (body ?? "").split(/\r?\n/).find((candidate) => /^\s*(?:[-*]\s+)?(?:\*\*)?Stacked on\b/i.test(candidate));
  return line ? [...new Set([...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))] : [];
}

export interface MergeProbeSummary {
  probed: number;
  mainSha?: string;
}

/** Probe each open, non-draft PR head against main once per (head, main) pair. Observation only:
 *  read-only verbs, nothing written to a PR. A throw is logged and never fails the pass. */
export async function probeOpenPrMerges(
  prs: readonly OpenPrView[],
  ledgerPath: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  cwd: string,
  opts: {
    dryRun?: boolean;
    behindMainByPr?: ReadonlyMap<number, number>;
    git?: MergeProbeGit;
    limit?: number;
  } = {},
): Promise<MergeProbeSummary> {
  const eligible = prs.filter((pr) => pr.isDraft !== true);
  if (eligible.length === 0 || opts.dryRun === true) return { probed: 0 };
  try {
    const git = opts.git ?? defaultMergeProbeGit(cwd);
    const fetched = await git(["fetch", "--no-tags", "--quiet", "origin", "main"]);
    const main = fetched.status === 0 ? await git(["rev-parse", "FETCH_HEAD"]) : fetched;
    const mainSha = main.status === 0 ? main.stdout.trim() : "";
    if (mainSha === "") {
      log(`${MERGE_PROBE_STEP}.main_unreadable`, { git_status: main.status });
      return { probed: 0 };
    }
    // ledger-read-intent: live
    const lines = readLedgerLines(ledgerPath);
    const seen = new Set(
      lines.filter((line) => line.step === MERGE_PROBE_STEP).map((line) => `${line.head_sha}:${line.main_sha}`),
    );
    const targets = eligible
      .filter((pr) => !seen.has(`${pr.headSha}:${mainSha}`))
      .sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt) || a.prNumber - b.prNumber)
      .slice(0, opts.limit ?? MERGE_PROBE_LIMIT);
    for (const pr of targets) {
      await git(["fetch", "--no-tags", "--quiet", "origin", `refs/pull/${pr.prNumber}/head`]);
      const result = await probeMerge({ headSha: pr.headSha, mainSha, git });
      const behind = opts.behindMainByPr?.get(pr.prNumber);
      log(MERGE_PROBE_STEP, {
        pr_number: pr.prNumber,
        head_sha: pr.headSha,
        main_sha: mainSha,
        verdict: result.verdict,
        conflict_paths: result.verdict === "conflict" ? result.paths : [],
        github_mergeable_state: pr.mergeableState ?? "absent",
        stacked_on: stackedOnNumbers(pr.body),
        ...(result.verdict === "unreadable" ? { reason: result.reason } : {}),
        ...(behind === undefined ? {} : { behind_by: behind }),
      });
    }
    return { probed: targets.length, mainSha };
  } catch (e) {
    log(`${MERGE_PROBE_STEP}.error`, { error: String((e as Error)?.message ?? e) });
    return { probed: 0 };
  }
}
