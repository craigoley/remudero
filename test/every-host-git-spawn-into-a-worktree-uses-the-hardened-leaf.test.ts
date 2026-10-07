import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * W1-T6106 — CENSUS: EVERY HOST GIT SPAWN WHOSE REPOSITORY IS A WORKER WORKTREE GOES THROUGH THE HARDENED LEAF.
 *
 * A worker worktree's `.git` pointer and tracked hooks/ are bytes the worker writes, so `git -C <worktree>` run raw by the
 * daemon runs the worker's code. `src/lib/worktree-git.ts` (`hostWorktreeGit` and its siblings) is the only place allowed to
 * spell that spawn; everything else must call it, or record a `worktreeGitInvocation(...)` argv that a default executor
 * routes through it. This suite WALKS every src file and fails, naming the file, on a raw spawn whose repository argument is a
 * worktree-shaped expression (`-C <worktree…>` or `cwd: <worktree…>` on a `git` spawn).
 *
 * The census is keyed on the OBSERVED expression, never on a line number, and has no allowlist: a site that is not a worker
 * worktree is not worktree-shaped (`repoDir`, `ownerPath`, `checkoutRoot`), and a site that is one routes through the leaf.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEAF = "src/lib/worktree-git.ts";

/** An expression naming a worker worktree: `worktreePath`, `opts.worktreePath`, `wt`, `cwd`, `batchWorktree`, … */
const WORKTREE_EXPR = /^(?:\w+\.)*(?:worktree\w*|wt|cwd|\w*Worktree\w*)$/;
/** `cwd:` is also how a repo CHECKOUT is named (`opts.cwd` in status.ts), so the `cwd:` shape needs the word worktree itself. */
const WORKTREE_CWD_OPTION = /^(?:\w+\.)*(?:worktree\w*|wt|\w*Worktree\w*)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** The text of the call whose `(` is at `open`, balanced over parens and skipping string/template literals. */
function callText(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

export interface RawWorktreeGitSpawn {
  file: string;
  expr: string;
  shape: "-C" | "cwd";
}

/** Every raw host git spawn into a worktree-shaped repository in `sources` (path -> text). */
export function findRawGitSpawns(sources: ReadonlyMap<string, string>): RawWorktreeGitSpawn[] {
  const found: RawWorktreeGitSpawn[] = [];
  for (const [file, text] of sources) {
    if (file === LEAF) continue;
    // Shape 1: `"-C", <expr>` inside a call that names "git".
    for (const match of text.matchAll(/(["'])-C\1,\s*([A-Za-z_][\w.]*)\s*,/g)) {
      const expr = match[2]!;
      if (!WORKTREE_EXPR.test(expr)) continue;
      const before = text.slice(Math.max(0, match.index! - 260), match.index!);
      if (!/(["'])git\1/.test(before) && !/\bgit\(/.test(before)) continue; // e.g. the codex CLI's own `-C <dir>`
      found.push({ file, expr, shape: "-C" });
    }
    // Shape 2: a `git` spawn whose options carry `cwd: <expr>`.
    for (const match of text.matchAll(/\b(?:execFileSync|execFile|spawnSync|spawn|execFilePromise)\(\s*(?:[\w.]+\s*\?\?\s*)?(["'])git\1/g)) {
      const open = text.indexOf("(", match.index!);
      const call = callText(text, open);
      const cwd = /\bcwd:\s*([A-Za-z_][\w.]*)/.exec(call);
      if (cwd !== null && WORKTREE_CWD_OPTION.test(cwd[1]!)) found.push({ file, expr: cwd[1]!, shape: "cwd" });
    }
  }
  return found;
}

function srcSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const path of walk(join(root, "src"))) sources.set(relative(root, path).replace(/\\/g, "/"), readFileSync(path, "utf8"));
  return sources;
}

test("every host git spawn in src whose repository is a worker worktree goes through the hardened leaf", () => {
  const raw = findRawGitSpawns(srcSources());
  assert.deepEqual(
    raw.map((r) => `${r.file}: raw git ${r.shape} ${r.expr}`),
    [],
    "a raw `git -C <worktree>` runs the worker's own .git pointer, config and hooks as the daemon — call hostWorktreeGit (src/lib/worktree-git.ts)",
  );
});

test("a raw git -C spawn into a worktree added to src fails the census naming its file", () => {
  const sources = new Map(srcSources());
  sources.set(
    "src/lib/a-new-host-status.ts",
    'import { execFileSync } from "node:child_process";\n' +
      'export const status = (worktreePath: string) => execFileSync("git", ["-C", worktreePath, "status", "--porcelain"]);\n',
  );
  sources.set(
    "src/lib/a-new-host-diff.ts",
    'import { spawnSync } from "node:child_process";\n' +
      'export const diff = (wt: string) => spawnSync("git", ["diff", "HEAD"], { cwd: wt, encoding: "utf8" });\n',
  );
  const raw = findRawGitSpawns(sources);
  assert.deepEqual(
    raw.map((r) => r.file).sort(),
    ["src/lib/a-new-host-diff.ts", "src/lib/a-new-host-status.ts"],
    "both spawn shapes fail, each naming its own file, and nothing else in src does",
  );
});

test("a spawn into a repository that is not worktree-shaped, and a non-git -C, are not the census's business", () => {
  const sources = new Map<string, string>([
    ["src/lib/a.ts", 'execFileSync("git", ["-C", repoDir, "fetch"]);\n'],
    ["src/lib/b.ts", 'const argv = ["exec", "-C", args.cwd, "-"];\n'],
    ["src/lib/c.ts", 'execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });\n'],
    ["src/lib/d.ts", 'hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]);\nworktreeGitInvocation(wt, ["push"]);\n'],
  ]);
  assert.deepEqual(findRawGitSpawns(sources), []);
});

test("the push leaf and the run loop call the hardened leaf", () => {
  const sources = srcSources();
  assert.match(sources.get("src/lib/git-push.ts")!, /hostWorktreeGit\(/, "gitPush's default executors run through hostWorktreeGit");
  assert.match(sources.get("src/run-task.ts")!, /hostWorktreeGit\(/, "run-task's commits, diffs and amends run through hostWorktreeGit");
  assert.match(sources.get("src/lib/worker.ts")!, /readWorktreePin\(/, "the assignment stamp takes its gitdir from the pin, not from rev-parse");
});
