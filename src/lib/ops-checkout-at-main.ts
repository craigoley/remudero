/**
 * W1-T14617: the one read of the ops catalog. The daemon clones the ops checkout once at boot, and nothing moves its
 * working tree afterwards; a fetch moves only refs/remotes/origin/main. So a reader of the ops catalog reads that ref,
 * through this module, and never the working tree, which stays at the boot-time commit. Writes keep their homes: a
 * capture and a status write still go to the working tree and land from there.
 *
 * Rule 2 of the task, for a file under the ops checkout: main's bytes when main holds the path; absent when HEAD
 * tracks it and main does not (it was moved or deleted on main); the working-tree bytes only when neither main nor
 * HEAD tracks it (a capture not yet landed, the W1-T11374 rule auto-triage follows).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { runStepsAsync, runStepsSync, step, type Steps } from "./git-push.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { isTaskShardName } from "./task-shard-name.js";

/** The tracking ref every read is made at. */
export const OPS_MAIN_TRACKING_REF = "refs/remotes/origin/main";

/** A git rooted at the ops checkout: its stdout, or a throw on any failure. */
export type OpsCheckoutGit = (args: string[]) => string | Promise<string>;

/** What one read lists and reads. */
export interface OpsCatalogScope {
  /** Repo-relative files, or directories ending in "/" for their direct entries. */
  paths: readonly string[];
  /** Main's bytes are read only for a listed path this keeps; every listed path when absent. */
  select?: (relPath: string) => boolean;
  /** Also list what the checkout's HEAD tracks under `paths`, for rule 2. */
  head?: boolean;
}

/** The ops checkout's origin/main, as one read saw it. */
export interface OpsCheckoutAtMain {
  checkoutDir: string;
  mainSha: string;
  /** Every path main lists under the scope's paths. */
  mainPaths: ReadonlySet<string>;
  /** Main's bytes of each selected path, in listing order. */
  files: ReadonlyMap<string, string>;
  /** Every path HEAD lists under the scope's paths; empty unless the scope asked for it. */
  headPaths: ReadonlySet<string>;
  /** Whether `headPaths` was read, so rule 2 can be applied. */
  headListed: boolean;
}

function parseTree(out: string): Array<{ path: string; oid: string }> {
  return out.split("\0").flatMap((line) => {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line.replace(/^\n+/, ""));
    return m === null ? [] : [{ oid: m[1], path: m[2] }];
  });
}

function* atMainSteps(
  checkoutDir: string, scope: OpsCatalogScope, git: OpsCheckoutGit,
  opts: { fetch: boolean; mainSha?: string; headSha?: string; blobs?: Map<string, string> },
): Steps<OpsCheckoutAtMain> {
  if (opts.fetch) {
    yield* step(() => git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/main:${OPS_MAIN_TRACKING_REF}`]));
  }
  const mainSha = opts.mainSha ?? String(yield* step(() => git(["rev-parse", OPS_MAIN_TRACKING_REF]))).trim();
  const listed = parseTree(String(yield* step(() => git(["ls-tree", "-z", mainSha, "--", ...scope.paths]))));
  const files = new Map<string, string>();
  for (const { path, oid } of listed) {
    if (scope.select !== undefined && !scope.select(path)) continue;
    let text = opts.blobs?.get(oid);
    if (text === undefined) {
      text = String(yield* step(() => git(["show", `${mainSha}:${path}`])));
      if (opts.blobs !== undefined) {
        if (opts.blobs.size >= 4096) opts.blobs.clear(); // BACKSTOP on memory: a blob never changes, so a reread is only slower
        opts.blobs.set(oid, text);
      }
    }
    files.set(path, text);
  }
  const headPaths = scope.head === true
    ? new Set(parseTree(String(yield* step(() => git(["ls-tree", "-z", opts.headSha ?? "HEAD", "--", ...scope.paths])))).map((e) => e.path))
    : new Set<string>();
  return { checkoutDir, mainSha, mainPaths: new Set(listed.map((e) => e.path)), files, headPaths, headListed: scope.head === true };
}

/**
 * The async arm: fetch main into refs/remotes/origin/main, rev-parse it, list the scope and show each selected blob.
 * Any git failure throws; there is no fallback to the working tree or to another repository.
 */
export async function readOpsCheckoutAtMain(
  checkoutDir: string, scope: OpsCatalogScope, runGit: OpsCheckoutGit, opts: { fetch?: boolean } = {},
): Promise<OpsCheckoutAtMain> {
  return runStepsAsync(atMainSteps(checkoutDir, scope, runGit, { fetch: opts.fetch !== false }));
}

const keptReads = new Map<string, OpsCheckoutAtMain & { headSha: string }>();
const keptBlobs = new Map<string, string>();

/**
 * The arm for a caller already written as steps (feedback.ts's capture), driven sync or async by that caller, and the
 * body of {@link readOpsCheckoutAtMainSync}: read at the checkout's existing refs/remotes/origin/main, with no fetch.
 * The ref and HEAD shas are read from the ref files, so a read whose main and HEAD have not moved spawns nothing, and
 * a moved main shows only the blobs it changed. Any git failure throws.
 */
export function* readOpsCheckoutAtMainSteps(checkoutDir: string, scope: OpsCatalogScope, runGit: OpsCheckoutGit): Steps<OpsCheckoutAtMain> {
  const refs = refShasOf(checkoutDir);
  const key = scope.select === undefined ? `${resolve(checkoutDir)}\0${scope.paths.join("\0")}\0${String(scope.head === true)}` : undefined;
  const kept = key === undefined ? undefined : keptReads.get(key);
  if (refs !== undefined && kept !== undefined && kept.mainSha === refs.mainSha && kept.headSha === refs.headSha) return kept;
  const read = yield* atMainSteps(checkoutDir, scope, runGit, {
    fetch: false, blobs: keptBlobs, ...(refs === undefined ? {} : { mainSha: refs.mainSha, headSha: refs.headSha }),
  });
  if (key !== undefined && refs !== undefined) {
    if (keptReads.size >= 256) keptReads.clear(); // BACKSTOP on memory, not a control
    keptReads.set(key, { ...read, headSha: refs.headSha });
  }
  return read;
}

/** The sync arm, for the sync readers; `runGit` must return a string. See {@link readOpsCheckoutAtMainSteps}. */
export function readOpsCheckoutAtMainSync(checkoutDir: string, scope: OpsCatalogScope, runGit: (args: string[]) => string): OpsCheckoutAtMain {
  return runStepsSync(readOpsCheckoutAtMainSteps(checkoutDir, scope, runGit));
}

/** The scope of one task's shard file under the checkout's plan/tasks.d/. */
export function taskShardScope(checkoutDir: string, taskId: string): OpsCatalogScope {
  const shardDir = relative(checkoutDir, join(resolveRepoLayout(checkoutDir).planDir, "tasks.d")).split(sep).join("/");
  return {
    paths: [`${shardDir}/`],
    select: (path) => isTaskShardName(path.slice(path.lastIndexOf("/") + 1), taskId) && /\.ya?ml$/.test(path),
  };
}

/** The first selected file of a read: a task shard read through {@link taskShardScope}, or undefined. */
export function firstOpsCatalogFile(read: OpsCheckoutAtMain): { relPath: string; text: string } | undefined {
  for (const [relPath, text] of read.files) return { relPath, text };
  return undefined;
}

/** Rule 2 for one repo-relative path: main's bytes, absent, or the bytes of a working-tree file neither tracks. */
export function opsCatalogFile(read: OpsCheckoutAtMain, relPath: string): { from: "main" | "working-tree"; text: string } | undefined {
  if (!read.headListed) throw new Error("rule 2 needs the HEAD listing: read the scope with head: true");
  const main = read.files.get(relPath);
  if (main !== undefined) return { from: "main", text: main };
  if (read.mainPaths.has(relPath) || read.headPaths.has(relPath)) return undefined;
  const abs = join(read.checkoutDir, relPath);
  return existsSync(abs) && statSync(abs).isFile() ? { from: "working-tree", text: readFileSync(abs, "utf8") } : undefined;
}

/** Rule 2 for a directory (`dirRel`, no trailing slash): the repo-relative paths it holds, sorted. */
export function opsCatalogPaths(read: OpsCheckoutAtMain, dirRel: string): string[] {
  if (!read.headListed) throw new Error("rule 2 needs the HEAD listing: read the scope with head: true");
  const inDir = (path: string) => path.startsWith(`${dirRel}/`) && !path.slice(dirRel.length + 1).includes("/");
  const out = new Set([...read.mainPaths].filter(inDir));
  const abs = join(read.checkoutDir, dirRel);
  if (existsSync(abs)) {
    for (const name of readdirSync(abs)) {
      const path = `${dirRel}/${name}`;
      if (!read.mainPaths.has(path) && !read.headPaths.has(path) && statSync(join(abs, name)).isFile()) out.add(path);
    }
  }
  return [...out].sort();
}

function refShasOf(checkoutDir: string): { mainSha: string; headSha: string } | undefined {
  const dot = join(checkoutDir, ".git");
  const gitDirText = !existsSync(dot) ? undefined : statSync(dot).isDirectory() ? dot : /^gitdir:\s*(.+?)\s*$/m.exec(textOf(dot) ?? "")?.[1];
  if (gitDirText === undefined) return undefined;
  const gitDir = resolve(checkoutDir, gitDirText);
  const common = textOf(join(gitDir, "commondir"))?.trim();
  const commonDir = common === undefined ? gitDir : resolve(gitDir, common);
  const mainSha = refSha(commonDir, OPS_MAIN_TRACKING_REF);
  const head = textOf(join(gitDir, "HEAD"))?.trim();
  const symbolic = head === undefined ? undefined : /^ref:\s*(\S+)$/.exec(head)?.[1];
  const headSha = symbolic !== undefined ? refSha(commonDir, symbolic) : head !== undefined && /^[0-9a-f]{40,64}$/.test(head) ? head : undefined;
  return mainSha === undefined || headSha === undefined ? undefined : { mainSha, headSha };
}

function refSha(commonDir: string, ref: string): string | undefined {
  const loose = textOf(join(commonDir, ref))?.trim();
  if (loose !== undefined && /^[0-9a-f]{40,64}$/.test(loose)) return loose;
  for (const line of (textOf(join(commonDir, "packed-refs")) ?? "").split("\n")) {
    const [sha, name] = line.split(" ");
    if (name === ref && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
  }
  return undefined;
}

function textOf(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    void error; // absent or unreadable: the ref is unknown, so the read asks git instead of the cache
    return undefined;
  }
}
