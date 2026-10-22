/**
 * THE HOUSE-LAYOUT CENSUS'S COUNTER, moved out of test/repo-layout.test.ts so a caller that must
 * not start a test runner can ask the census's own question: scripts/census-precheck.mjs, run by
 * hooks/pre-push. Importing a `node:test` file runs its tests, and W1-T3225 removed the runner
 * from that hook. The suite imports these and keeps its merge-base-relative assertion.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const HOUSE_LITERALS = ["plan/tasks.d", "MASTER-PLAN.md", ".remudero/", "learnings/"];

/** Every `.ts` file under `<root>/src`, repo-relative with `/` separators. */
export function listHouseLayoutSrcFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
    }
  };
  try {
    walk("src");
  } catch {
    return []; // no src/ at all — every count is zero
  }
  return out;
}

/** Per-literal file-presence counts over already-read file contents (never re-reads anything —
 *  the caller decides whether that content came from the working tree or a git ref). */
export function houseLiteralCounts(contents) {
  const counts = {};
  for (const literal of HOUSE_LITERALS) counts[literal] = 0;
  for (const content of contents) {
    for (const literal of HOUSE_LITERALS) if (content.includes(literal)) counts[literal] += 1;
  }
  return counts;
}

// W1-T9332 structural split exception; application requires an explicit operator ruling.
// The physical-file scanner above is unchanged. Only this pair and these observed tokens qualify.
const RUN_TASK_LAYOUT_SPLIT = { old: "src/run-task.ts", moved: "src/cli/commands/run-task-verb.ts" };
const RUN_TASK_LAYOUT_SPLIT_LITERALS = ["plan/tasks.d", "MASTER-PLAN.md", ".remudero/", "learnings/"];

/** One physical duplicate per conserved token; readers supply complete merge-base/head maps.
 * An unreadable base entry must remain present (with a non-string value), never look absent. */
export function qualifiedRunTaskLayoutSplit(base, current) {
  const oldBase = base.get(RUN_TASK_LAYOUT_SPLIT.old);
  if (typeof oldBase !== "string" || base.has(RUN_TASK_LAYOUT_SPLIT.moved)) return {};
  const oldNow = current.get(RUN_TASK_LAYOUT_SPLIT.old);
  const movedNow = current.get(RUN_TASK_LAYOUT_SPLIT.moved);
  if (typeof oldNow !== "string" || typeof movedNow !== "string") return {};
  const relief = {};
  for (const literal of RUN_TASK_LAYOUT_SPLIT_LITERALS) {
    if (!oldBase.includes(literal) || !oldNow.includes(literal) || !movedNow.includes(literal)) continue;
    const occurrences = (text) => text.split(literal).length - 1;
    if (occurrences(oldNow) + occurrences(movedNow) <= occurrences(oldBase)) relief[literal] = 1;
  }
  return relief;
}
