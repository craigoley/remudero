// src/lib/serve-own-code.ts — W1-T14987: DOES AN ADVANCE HOLD A MERGE THAT CHANGES ONLY SERVE'S OWN CODE?
//
// OPERATOR RULING 2026-11-26 14:43Z: "A merge that changes only serve's own code hands serve over without the merge-burst
// spacing; the daemon keeps its spacing." Serve's generation runs src/run-task.ts, whose closure the daemon shares, so
// "serve's own code" is what that closure reaches ONLY through src/lib/serve.ts: the same reader (daemonProcessClosure),
// once whole and once with serve.ts as a stop node. Fail-closed: anything this cannot read answers `unreadable`, and the
// supervisor then spaces the handoff exactly as before.
import { DAEMON_CLOSURE_ROOT_FILES, daemonClosureGit, daemonProcessClosure, type ClosureGit, type DaemonClosure } from "./daemon-closure.js";

/** The process both serve's generation and the daemon start from. */
export const SERVE_OWN_CODE_ENTRY = "src/run-task.ts";
/** The module through which, and only through which, serve's own code is reached. */
export const SERVE_OWN_CODE_STOP = "src/lib/serve.ts";

/**
 * Files the daemon's closure holds that the daemon reads only inside a CLI verb, never on its own loop: counted as serve's
 * own code when the whole closure holds them. Add one only with its reader named beside it and a census test pinning the
 * claim (test/console-api/serve/a-serve-only-merge-hands-serve-over-without-the-spacing.test.ts). Craig approved the seed
 * 2026-11-26 14:54Z ("Yes, with a census guard").
 */
export const SERVE_OWN_CODE_DAEMON_INERT_PATHS: ReadonlyArray<{ path: string; reader: string }> = [
  // Imported only by src/lib/report-commands.ts, and only for meaningOfStep, whose one call site is ledgerGrepCommand:
  // the `rmd ledger-grep` verb an operator runs; nothing in the daemon's loop decides on a row of it.
  { path: "src/lib/ledger-steps.ts", reader: "meaningOfStep, called only by ledgerGrepCommand (src/lib/report-commands.ts), the rmd ledger-grep verb" },
];

/** What the supervisor's spacing gate learns about an advance. */
export type ServeOnlyAdvance =
  | { status: "serve_only"; merge: string; paths: string[] }
  | { status: "spaced"; reason: string }
  | { status: "unreadable"; reason: string };

/** Judges the advance from the active sha to the target sha; never throws. */
export type ServeOnlyAdvanceReader = (fromSha: string, toSha: string) => Promise<ServeOnlyAdvance>;

const INERT = new Set(SERVE_OWN_CODE_DAEMON_INERT_PATHS.map((row) => row.path));
const ROOT_FILES = new Set<string>(DAEMON_CLOSURE_ROOT_FILES);

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** The two closures at one sha, or why one of them is unreadable. */
async function sidesAt(git: ClosureGit, sha: string): Promise<{ whole: ReadonlySet<string>; daemon: ReadonlySet<string> } | string> {
  const [whole, daemon]: DaemonClosure[] = await Promise.all([
    daemonProcessClosure(git, sha, SERVE_OWN_CODE_ENTRY),
    daemonProcessClosure(git, sha, SERVE_OWN_CODE_ENTRY, { stopAt: [SERVE_OWN_CODE_STOP] }),
  ]);
  for (const side of [whole, daemon]) if (side.status === "unreadable") return `closure at ${sha}: ${side.reason}`;
  return { whole: (whole as Extract<DaemonClosure, { status: "read" }>).paths, daemon: (daemon as Extract<DaemonClosure, { status: "read" }>).paths };
}

/**
 * The oldest first-parent merge in `fromSha..toSha` that changes at least one path of serve's own code and no path the
 * daemon loads, at either sha. A path in neither closure (docs, tests) counts for nothing. Never throws.
 */
export async function classifyServeOnlyAdvance(git: ClosureGit, fromSha: string, toSha: string): Promise<ServeOnlyAdvance> {
  let merges: string[];
  try {
    merges = (await git(["rev-list", "--first-parent", "--reverse", `${fromSha}..${toSha}`])).split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    return { status: "unreadable", reason: `merges ${fromSha}..${toSha}: ${failure(error)}` };
  }
  if (merges.length === 0) return { status: "spaced", reason: `no merge in ${fromSha}..${toSha}` };
  const before = await sidesAt(git, fromSha);
  if (typeof before === "string") return { status: "unreadable", reason: before };
  const after = await sidesAt(git, toSha);
  if (typeof after === "string") return { status: "unreadable", reason: after };
  const daemonLoads = (path: string): boolean => ROOT_FILES.has(path) || (!INERT.has(path) && (before.daemon.has(path) || after.daemon.has(path)));
  const serveOwn = (path: string): boolean => !daemonLoads(path) && (before.whole.has(path) || after.whole.has(path));
  for (const merge of merges) {
    let paths: string[];
    try {
      paths = (await git(["diff-tree", "-r", "-z", "--name-only", "--no-commit-id", `${merge}^1`, merge])).split("\0").filter(Boolean);
    } catch (error) {
      return { status: "unreadable", reason: `diff of ${merge}: ${failure(error)}` };
    }
    if (paths.some(serveOwn) && !paths.some(daemonLoads)) return { status: "serve_only", merge, paths };
  }
  return { status: "spaced", reason: `none of ${merges.length} merge(s) changes only serve's own code` };
}

/** What the active generation carries on its handoff ask (serve.ts): the verdict, and the advance it judged. */
export type ServeOnlyVerdict = ServeOnlyAdvance & { fromSha: string; toSha?: string };

/** The verdict for one ask, off the loop; never rejects. An ask with no target is unreadable, named so. */
export async function serveOnlyVerdict(reader: ServeOnlyAdvanceReader, fromSha: string, toSha: string | undefined): Promise<ServeOnlyVerdict> {
  if (toSha === undefined) return { status: "unreadable", reason: "the ask names no target sha", fromSha };
  const verdict = await reader(fromSha, toSha).catch((error: unknown): ServeOnlyAdvance => ({ status: "unreadable", reason: `the reader threw: ${failure(error)}` }));
  return { ...verdict, fromSha, toSha };
}

/** The production reader, run by the active generation in its own checkout: a worktree of the serve clone, sharing its objects. */
export function serveOnlyAdvanceIn(repoDir: string): ServeOnlyAdvanceReader {
  const git = daemonClosureGit(repoDir);
  return (fromSha, toSha) => classifyServeOnlyAdvance(git, fromSha, toSha);
}
