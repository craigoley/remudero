// @source-text-subject: src/lib/reviewer-health.ts and src/run-task.ts — the claim is about declarations, which have no runtime form.
// @census-reads: src/lib/reviewer-health.ts src/run-task.ts — their interface declarations, nothing else.
/**
 * W1-T10269 follow-up (operator ruling on #13384): reviewer health once declared its injected
 * dependencies as role interfaces (ReviewerHealthStore, HealedTreeGit, ReviewerHealthRouteOverrides),
 * which the deps-interface census cannot see because it matches the `*Deps`/`*Seams` suffix. W1-T3744
 * says the suffix is not the subject. This suite asks the structural question instead: an interface
 * whose members are functions is a dependency bag, whatever it is named. reviewer-health.ts declares
 * data records only; its effects reuse shapes the repo already had (EscalateDeps, MainRepairLane, the
 * Clock port, FreshTreeReviewSeams) and plain function parameters.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** Each `interface Name { ... }` in `text`, with its brace-matched body. */
function interfaces(text: string): Array<{ name: string; body: string }> {
  const found: Array<{ name: string; body: string }> = [];
  for (const match of text.matchAll(/^(?:export\s+)?interface\s+([A-Za-z0-9_]+)[^{\n]*\{/gm)) {
    const open = match.index! + match[0].length;
    let depth = 1;
    let i = open;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    found.push({ name: match[1]!, body: text.slice(open, i - 1) });
  }
  return found;
}

/** Members typed as functions: `name(...)`, `name?(...)` or `name: (...) =>`. */
function functionMembers(body: string): string[] {
  return body.split("\n").map((line) => line.trim())
    .filter((line) => /^[A-Za-z_$][\w$]*\??\s*(?:\(|:\s*(?:<[^>]*>\s*)?\([^)]*\)\s*=>)/.test(line));
}

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

test("W1-T10269: reviewer health declares no dependency-bag shape under any name", () => {
  const declared = interfaces(read("src/lib/reviewer-health.ts"));
  assert.ok(declared.length >= 5, `the scan sees reviewer health's records (found ${declared.map((d) => d.name).join(", ")})`);
  const bags = declared.filter((d) => functionMembers(d.body).length > 0).map((d) => `${d.name}: ${functionMembers(d.body).join(" | ")}`);
  assert.deepEqual(bags, [], "an interface of functions is a dependency bag: reuse an existing seam or pass the functions");
  const route = interfaces(read("src/run-task.ts")).filter((d) => d.name.startsWith("ReviewerHealth"));
  assert.deepEqual(route.map((d) => d.name), [], "the daemon route takes the review path's own FreshTreeReviewSeams");
});

test("W1-T10269: the dependency-bag scan sees a bag under any name", () => {
  const renamed = "export interface HealedTreeGit {\n  /** git */\n  git: GitText;\n  treeGit: (tree: string, args: string[]) => Promise<string>;\n  cut(prefix: string): string;\n}\n";
  assert.deepEqual(interfaces(renamed).map((d) => functionMembers(d.body)),
    [["treeGit: (tree: string, args: string[]) => Promise<string>;", "cut(prefix: string): string;"]]);
  const record = "export interface ReviewerIncident {\n  id: string;\n  offending: { sha: string } | null;\n  evidence: ReviewerShaJudgment;\n}\n";
  assert.deepEqual(functionMembers(interfaces(record)[0]!.body), [], "a data record is not a bag");
});
