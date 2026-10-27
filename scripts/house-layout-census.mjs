/**
 * THE HOUSE-LAYOUT CENSUS'S COUNTER, moved out of test/repo-layout.test.ts so a caller that must
 * not start a test runner can ask the census's own question: scripts/census-precheck.mjs, run by
 * hooks/pre-push. Importing a `node:test` file runs its tests, and W1-T3225 removed the runner
 * from that hook. The suite imports these and keeps its merge-base-relative assertion.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

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
// Exact post-merge restoration of W1-T9338's approved source comment. These source hashes
// bind the complete before/after module; no other source byte or owner can change under it.
const SWEEP_RESTORATION = {
  path: "src/cli/commands/sweep.ts",
  before: "9e4c57e7a16a1adca59fde97f35c36baef713655e49c5211dfa6c90f5dbb1b87",
  after: "d8d16e2c1376d6080ddf1128c3d3777f63551e8c1fb3b5f266c36b538c90ef3f",
};
function qualifiedSweepCommentRestoration(base, current) {
  if (base.size !== current.size || typeof base.get(RUN_TASK_LAYOUT_SPLIT.old) !== "string") return false;
  if (!base.get(RUN_TASK_LAYOUT_SPLIT.old).includes(".remudero/")) return false;
  for (const [path, text] of base) {
    const next = current.get(path);
    if (typeof text !== "string" || typeof next !== "string") return false;
    if (path !== SWEEP_RESTORATION.path && text !== next) return false;
  }
  const before = base.get(SWEEP_RESTORATION.path), after = current.get(SWEEP_RESTORATION.path);
  return typeof before === "string" && typeof after === "string" &&
    createHash("sha256").update(before).digest("hex") === SWEEP_RESTORATION.before &&
    createHash("sha256").update(after).digest("hex") === SWEEP_RESTORATION.after;
}

export function qualifiedRunTaskLayoutSplit(base, current) {
  if (qualifiedSweepCommentRestoration(base, current)) return { ".remudero/": 1 };
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
