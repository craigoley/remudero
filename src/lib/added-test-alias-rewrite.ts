// W1-T10084: the one added-test alias rewrite both harness commits share, `commitWorkerEdits` (run-task.ts) and the
// Codex writer's `commitCodexWriterEdits` (worker-provider.ts), which cannot import the CLI module.
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

type AliasGitRunner = (args: string[]) => string;

/** W1-T10064: the W1-T9864 codemod's `rewriteSource` contract. */
export type TestAliasRewriter = (text: string, file: string) => { text: string; rewritten: number; unresolved: string[] };

/** W1-T10064: what the alias rewrite did to the new tests a harness commit stages. */
export interface AddedTestAliasRewrite {
  readonly rewritten: string[];
  readonly unresolved: { path: string; specifier: string }[];
  readonly failed: { path: string; error: string }[];
}

// Loaded on first use, so a src/-only sandbox that imports worker-provider.ts never needs scripts/ (ledger-rotation's W1-T964).
const codemodRewriteSource: TestAliasRewriter = (text, file) =>
  (createRequire(import.meta.url)("../../scripts/test-location-codemod.mjs") as { rewriteSource: TestAliasRewriter }).rewriteSource(text, file);

/** True when the worktree `runGit` targets is mid-merge (MERGE_HEAD is set). */
export function mergeHeadPresent(runGit: AliasGitRunner): boolean {
  try {
    runGit(["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
    return true;
  } catch {
    // No MERGE_HEAD: nothing is mid-merge.
    return false;
  }
}

/**
 * W1-T10064: REWRITE THE RELATIVE IMPORTS OF THE TESTS THE WORKER ADDED to `#src/`/`#scripts/`/`#test/`, the
 * mechanical edit the W1-T9864 census asks of every new test. Only `??`/`A` test files absent from a merge's
 * MERGE_HEAD are touched; an existing file is never rewritten. A throw leaves the file as written and is named.
 */
export function rewriteAddedTestImports(
  repoDir: string,
  status: string,
  staged: readonly string[],
  runGit: AliasGitRunner,
  rewrite: TestAliasRewriter = codemodRewriteSource,
): AddedTestAliasRewrite {
  const result: AddedTestAliasRewrite = { rewritten: [], unresolved: [], failed: [] };
  let candidates = status.split("\0").filter((entry) => ["?? ", "A  ", "AM "].includes(entry.slice(0, 3)))
    .map((entry) => entry.slice(3)).filter((path) => staged.includes(path) && /^test\/.+\.test\.m?ts$/.test(path) &&
      !path.split("/").includes("..") && existsSync(join(repoDir, path)) && lstatSync(join(repoDir, path)).isFile());
  if (candidates.length > 0 && mergeHeadPresent(runGit)) {
    const fromMain = new Set(runGit(["ls-tree", "-r", "--name-only", "MERGE_HEAD", "--", ...candidates]).split("\n"));
    candidates = candidates.filter((path) => !fromMain.has(path));
  }
  for (const path of candidates) {
    try {
      const out = rewrite(readFileSync(join(repoDir, path), "utf8"), path);
      result.unresolved.push(...out.unresolved.map((specifier) => ({ path, specifier })));
      if (out.rewritten > 0) {
        writeFileSync(join(repoDir, path), out.text);
        result.rewritten.push(path);
      }
    } catch (error) {
      result.failed.push({ path, error: String((error as Error)?.message ?? error) });
    }
  }
  return result;
}

/** W1-T10064: the harness-commit row fields of an alias rewrite, each present only when non-empty. */
export function aliasRewriteFields(rewrite: AddedTestAliasRewrite | undefined): Record<string, unknown> {
  if (rewrite === undefined) return {};
  return {
    ...(rewrite.rewritten.length > 0 ? { alias_rewritten: rewrite.rewritten } : {}),
    ...(rewrite.unresolved.length > 0 ? { alias_unresolved: rewrite.unresolved } : {}),
    ...(rewrite.failed.length > 0 ? { alias_rewrite_failed: rewrite.failed } : {}),
  };
}
