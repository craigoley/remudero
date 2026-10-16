// src/lib/daemon-closure.ts — W1-T9092 (ADR 0007 decisions B.1 and B.2): THE DAEMON IS STALE ONLY WHEN CODE ITS OWN
// PROCESS LOADS CHANGED.
//
// `advanceIsMaterial` (self-sync.ts) calls any src/ change material, so every merge started the staleness clock and
// `upper_age` released it within about 30 minutes (9 of 17 freshness boots on 2026-10-12/13), whether or not the
// running process loads the file. This module computes what it does load: the static-import closure of the module the
// process started from, read from git at one sha with one `ls-tree` and one `git grep` (as `importClosureAt` does in
// src/run-task.ts, W1-T8396), so no file is read per module and the working tree is never consulted.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { buildAffectedSuitesGraph } from "./affected-suites.js";
import { GATEWAY_FETCH_TIMEOUT_MS } from "./git-fetch-retry.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import type { AdvanceClosure, ServiceFreshness } from "./self-sync.js";

/** A text git read at a sha. Production passes a loop-bounded async child, so the daemon loop never waits on it. */
export type ClosureGit = (args: string[]) => Promise<string>;

/** The production {@link ClosureGit}: the hardened async leaf, whose child is bounded by LOOP-AVAILABLE time
 *  (loop-bounded-child.ts) at the freshness fetch's own budget, so a read it follows can neither hold the loop nor
 *  outlive it. */
export function daemonClosureGit(repoDir: string): ClosureGit {
  return (args) => hostWorktreeGitAsync(repoDir, args, { maxBuffer: 1 << 26, timeout: GATEWAY_FETCH_TIMEOUT_MS });
}

/** The trees a daemon module can import from: test/ is never loaded by the process. */
export const DAEMON_CLOSURE_ROOTS = ["src", "scripts", "bin"] as const;

/** What decides how the closure resolves or launches, whatever it imports: always in the closure when tracked. */
export const DAEMON_CLOSURE_ROOT_FILES = ["package.json", "package-lock.json", "tsconfig.json", "bin/rmd"] as const;

/** The lines that can name a module: an import, a re-export, a require (createRequire's too), a URL a worker starts
 *  from, or a repo path literal, `"src/x.ts"` and `join(root, "src", "x.ts")` alike. POSIX ERE: no `\s` here. */
const EDGE_LINE = "(from[[:space:]]*['\"]|import[[:space:]]*\\(|import[[:space:]]+['\"]|require[[:space:]]*\\(|Require[[:space:]]*\\(|URL[[:space:]]*\\(|['\"`](src|scripts|bin|openapi|packages)['\"`/])";

/** Specifiers a single edge line carries that the shared graph reads only in a whole file, re-written as imports. */
const REREAD = [
  /\bfrom\s*["']([^"']+)["']/g, // a multi-line import's closing `} from "x"` line
  /\bcreateRequire\([^)]*\)\(\s*["']([^"']+)["']/g, // child-entry-argv.ts loads scripts/build-child-entries.mjs so
  /\bnew\s+URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g, // a worker module started from its own URL
];

export type DaemonClosure =
  | { status: "read"; sha: string; entry: string; paths: ReadonlySet<string> }
  | { status: "unreadable"; sha: string; entry: string | undefined; reason: string };

/** The child entries the daemon spawns (scripts/build-child-entries.mjs `CHILD_ENTRIES`): their code arrives at spawn. */
function childEntrySources(): Set<string> {
  const script = createRequire(import.meta.url)("../../scripts/build-child-entries.mjs") as { CHILD_ENTRIES: ReadonlyArray<{ source: string }> };
  return new Set(script.CHILD_ENTRIES.map((entry) => entry.source));
}

/**
 * The module this process started from, as a repo-relative path: `process.argv[1]` under `repoDir`. Undefined when it
 * lies outside the repository (a bundle under dist/ still resolves, and then reads as unreadable at the sha, since no
 * tree tracks it), which fails toward restarting. Called once at wiring, so the two realpath reads are not per tick.
 */
export function daemonProcessEntry(repoDir: string, argv1: string | undefined = process.argv[1]): string | undefined {
  if (!argv1) return undefined;
  let rel: string;
  try {
    rel = relative(realpathSync(repoDir), realpathSync(argv1));
  } catch {
    return undefined;
  }
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/** Modules parsed between two yields to the event loop: a scheduling grain, never a cap on what is read. */
const GRAPH_SLICE = 32;

/** BOUNDED BY THE COMPARISON: a materiality read compares two shas (the loaded code and main), so the memo keeps the
 *  two most recently used closures; the loaded sha's stays resident and each new main tip replaces the last. */
const memo = new Map<string, Promise<DaemonClosure>>();
const MEMO_SIDES = 2;

function remember(key: string, pending: Promise<DaemonClosure>): void {
  memo.delete(key);
  memo.set(key, pending);
  while (memo.size > MEMO_SIDES) memo.delete(memo.keys().next().value!);
}

/**
 * The paths whose change can alter what a process started from `entry` runs, at `sha`:
 *  - the static-import closure of `entry` over `buildAffectedSuitesGraph`'s `directImports`;
 *  - the named data edges (`namedDependencies`) of closure modules, except edges to the child entries the daemon
 *    spawns and to scripts/ it executes, whose code arrives at spawn;
 *  - {@link DAEMON_CLOSURE_ROOT_FILES}.
 * Memoized per (sha, entry); a failed read is never memoized, so the next tick retries it. Never throws: a read that
 * fails, or an entry the tree does not hold, is `unreadable`, which the caller treats as material.
 */
export async function daemonProcessClosure(gitText: ClosureGit, sha: string, entry: string | undefined): Promise<DaemonClosure> {
  if (!entry) return { status: "unreadable", sha, entry, reason: "the process entry is not a path in this repository" };
  const key = `${sha}\0${entry}`;
  const known = memo.get(key);
  if (known) {
    remember(key, known);
    return known;
  }
  const pending = readClosure(gitText, sha, entry).catch((error: unknown): DaemonClosure => ({
    status: "unreadable", sha, entry, reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  }));
  remember(key, pending);
  const closure = await pending;
  if (closure.status === "unreadable" && memo.get(key) === pending) memo.delete(key);
  return closure;
}

async function readClosure(gitText: ClosureGit, sha: string, entry: string): Promise<DaemonClosure> {
  const paths = (await gitText(["ls-tree", "-r", "--name-only", sha])).split("\n").filter(Boolean);
  const tracked = new Set(paths);
  if (!tracked.has(entry)) throw new Error(`the entry ${entry} is not tracked at ${sha}`);
  let edges: string;
  try {
    edges = await gitText(["grep", "-I", "-E", EDGE_LINE, sha, "--", ...DAEMON_CLOSURE_ROOTS]);
  } catch (error) {
    // git grep exits 1 when no line matches: a tree with no edges, not an unreadable one.
    if ((error as { code?: unknown }).code !== 1) throw error;
    edges = "";
  }
  const files = new Map<string, string>();
  for (const line of edges.split("\n")) {
    const rest = line.startsWith(`${sha}:`) ? line.slice(sha.length + 1) : undefined;
    const at = rest?.indexOf(":") ?? -1;
    if (rest === undefined || at < 0) continue;
    const file = rest.slice(0, at);
    const text = rest.slice(at + 1);
    const reread = REREAD.flatMap((re) => [...text.matchAll(re)].map((m) => `import "${m[1]}";`)).join("\n");
    files.set(file, `${files.get(file) ?? ""}${text}\n${reread}\n`);
  }
  // Walked a slice of the frontier at a time, yielding between slices: the graph is CPU, and one whole-tree pass held
  // the loop ~60 ms on a Mac (2026-10-16), longer on a loaded host. A module with no edge line is a leaf.
  const spawned = childEntrySources();
  const closure = new Set<string>([entry]);
  let frontier = [entry];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (let at = 0; at < frontier.length; at += GRAPH_SLICE) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const slice = new Map(frontier.slice(at, at + GRAPH_SLICE).map((file) => [file, files.get(file) ?? ""] as const));
      const { directImports, namedDependencies } = buildAffectedSuitesGraph(slice, paths);
      for (const file of slice.keys()) {
        const named = [...namedDependencies.get(file) ?? []].filter((dep) => !spawned.has(dep) && !dep.startsWith("scripts/"));
        for (const dep of [...directImports.get(file) ?? [], ...named]) {
          if (!closure.has(dep)) {
            closure.add(dep);
            next.push(dep);
          }
        }
      }
    }
    frontier = next;
  }
  for (const root of DAEMON_CLOSURE_ROOT_FILES) if (tracked.has(root)) closure.add(root);
  return { status: "read", sha, entry, paths: closure };
}

/**
 * Judge an advance against the process closure: material when a changed path is in the closure at the old sha OR the
 * new sha (a module the advance deletes is in the first, one it adds in the second). An unreadable closure on either
 * side is material, as `advanceIsMaterial` fails today.
 */
export function judgeAdvanceByClosure(changedPaths: readonly string[], before: DaemonClosure, after: DaemonClosure): AdvanceClosure {
  for (const side of [before, after]) {
    if (side.status === "unreadable") return { status: "unreadable", reason: `${side.sha}: ${side.reason}` };
  }
  const inside = (path: string) => (before as Extract<DaemonClosure, { status: "read" }>).paths.has(path) ||
    (after as Extract<DaemonClosure, { status: "read" }>).paths.has(path);
  const outside = changedPaths.filter((path) => !inside(path)).length;
  return { status: "read", material: outside < changedPaths.length, outside };
}

/**
 * Attach the closure verdict to a clean or dirty assessment that is behind with a readable diff. An unreadable diff
 * is left to `advanceIsMaterial`, which already reads it as material; so is every other status.
 */
export async function withDaemonClosure(
  svc: ServiceFreshness, closureAt: (sha: string) => Promise<DaemonClosure>,
): Promise<ServiceFreshness> {
  if (svc.status !== "assessed" || svc.behind === null) return svc;
  const { oldSha, newSha, changedPaths } = svc.behind;
  if (!changedPaths || changedPaths.length === 0 || changedPaths.some((path) => path.trim().length === 0)) return svc;
  const [before, after] = await Promise.all([closureAt(oldSha), closureAt(newSha)]);
  return { ...svc, behind: { ...svc.behind, closure: judgeAdvanceByClosure(changedPaths, before, after) } };
}
