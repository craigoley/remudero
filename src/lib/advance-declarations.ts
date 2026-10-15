// src/lib/advance-declarations.ts — W1-T6273's entry-point weight, read per declaration instead of per file.
//
// MEASURED 2026-10-13/14 (core ledger, ~/Remudero-notes/restart-cause-2026-10-14/): 37 of the 49 core boots were
// freshness restarts, and 34 of those were released by a full-weight "daemon self" advance. W1-T6273 weighs
// src/run-task.ts as a whole file, so all 53 of its commits in the window scored full weight, though only 12 touched
// daemonCommand; the rest changed CLI commands (approve, skill-eval, verify-human), the inbox drafter or the fix rung.
// For 10 of the 34 boots such a commit was the only full-weight change. This module reads which top-level
// declarations of the entry module each commit touched, so deploy-judge keeps full weight for the daemon's own.
import type { AsyncGitRunner } from "./git-fetch-retry.js";
import type { ServiceFreshness } from "./self-sync.js";

/** The daemon's entry module, whose changes are weighed by the top-level declarations they touch (W1-T6273). */
export const DECLARATION_WEIGHED_PATH = "src/run-task.ts";

/** Marks a hunk whose enclosing declaration could not be named; deploy-judge reads it as the daemon's own. */
export const UNNAMED_DECLARATION = "";

const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const MODULE_LINKAGE = /^(?:import\b|export\s*(?:type\s*)?[{*])/;

function declarationOf(line: string): string {
  const named = DECLARATION.exec(line);
  if (named) return named[1]!;
  return MODULE_LINKAGE.test(line) ? "import" : UNNAMED_DECLARATION;
}

/**
 * Parse `git log --format=%x1e%H -U0` output into the top-level declarations each commit touched: the enclosing
 * declaration git names on every hunk header (its default funcname is the nearest preceding column-0 line), plus every
 * declaration whose own header line a hunk adds or removes. A commit with no hunk maps to an empty list.
 */
export function parseTouchedDeclarations(text: string): Map<string, string[]> {
  const touched = new Map<string, string[]>();
  for (const chunk of text.split("\x1e").slice(1)) {
    const lines = chunk.split("\n");
    const sha = lines[0]!.trim();
    if (sha.length === 0) continue;
    const names = new Set<string>();
    // A hunk with no context line starts above every column-0 line (the file's top): it is named by its first changed
    // line when that is itself a declaration or an import, and is unnamed otherwise.
    let unnamedHunk = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith("@@")) {
        if (unnamedHunk) names.add(UNNAMED_DECLARATION);
        const context = (line.split("@@")[2] ?? "").trim();
        unnamedHunk = context.length === 0;
        if (!unnamedHunk) names.add(declarationOf(context));
      } else if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
        if (unnamedHunk) {
          names.add(declarationOf(line.slice(1)));
          unnamedHunk = false;
        }
        const header = DECLARATION.exec(line.slice(1));
        if (header) names.add(header[1]!);
      }
    }
    if (unnamedHunk) names.add(UNNAMED_DECLARATION);
    touched.set(sha, [...names]);
  }
  return touched;
}

/**
 * Attach `declarations` to each commit of a stale assessment that changed {@link DECLARATION_WEIGHED_PATH}. Reads one
 * local `git log -U0` over the advance, only when such a commit exists. Any failure returns the assessment untouched,
 * and a commit without `declarations` keeps full weight: an unread advance fails toward restarting.
 */
export async function withTouchedDeclarations(svc: ServiceFreshness, git: AsyncGitRunner): Promise<ServiceFreshness> {
  if (svc.status !== "assessed" || svc.behind === null || svc.behind.changes === undefined) return svc;
  const { oldSha, newSha, changes } = svc.behind;
  if (!changes.some((change) => change.files.includes(DECLARATION_WEIGHED_PATH))) return svc;
  let touched: Map<string, string[]>;
  try {
    touched = parseTouchedDeclarations(await git(["log", "--format=%x1e%H", "-U0", "--no-color", "--no-ext-diff", `${oldSha}..${newSha}`, "--", DECLARATION_WEIGHED_PATH]));
  } catch {
    // An unreadable log leaves every commit unannotated, which deploy-judge weighs as full: it fails toward restarting.
    return svc;
  }
  const annotated = changes.map((change) => {
    const declarations = change.files.includes(DECLARATION_WEIGHED_PATH) ? touched.get(change.sha) : undefined;
    return declarations === undefined ? change : { ...change, declarations };
  });
  return { ...svc, behind: { ...svc.behind, changes: annotated } };
}
