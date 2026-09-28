import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// W1-T3056 — TWO RISK-JUDGE PREDICATES WERE EXPORTED, TESTED AND CALLED BY NOTHING.
//
// @source-text-subject: this test detects call sites in the risk judge's production source.
// W1-T3056's first half wires declaredFilesAbsentFromChange into the prompt. The second predicate
// remains an unwired fixture until a merge-base fact producer exists.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RISK_JUDGE_REL_PATH = "src/lib/risk-judge.ts";

/** Every top-level `export function NAME(` declared directly in `risk-judge.ts` — the shape both
 *  W1-T3056 predicates and every wired sibling in this file share. */
export function exportedFunctionSymbols(source: string): string[] {
  const re = /^export function (\w+)\(/gm;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.push(m[1]);
  return names;
}

/** Enumerate the production paths without depending on checkout metadata in CI. */
function productionFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    for (const entry of readdirSync(join(REPO_ROOT, path), { withFileTypes: true })) {
      const relative = join(path, entry.name);
      if (entry.isDirectory()) files.push(...productionFiles([relative]));
      else if (entry.isFile()) files.push(relative);
    }
  }
  return files;
}

/** True when `symbol` has a real CALL — `symbol(` — somewhere in `src/ scripts/ bin/ .github/`
 *  other than its own `export function` declaration line. A doc-comment mention of the bare name
 *  has no trailing `(` immediately after it and is correctly never counted. */
export function hasNonTestCaller(symbol: string, paths: string[] = ["src", "scripts", "bin", ".github"]): boolean {
  const callRe = new RegExp(`\\b${symbol}\\(`);
  const declRe = new RegExp(`^export function ${symbol}\\(`);
  for (const rel of productionFiles(paths)) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    for (const line of text.split("\n")) {
      if (!callRe.test(line)) continue;
      if (declRe.test(line.trim())) continue; // the definition line itself is not a caller
      return true;
    }
  }
  return false;
}

/** Every exported function in `risk-judge.ts` with no non-test caller — named, not merely
 *  counted, so a failure states exactly which symbol sits inert. */
export function unwiredRiskJudgeExports(): string[] {
  const source = readFileSync(join(REPO_ROOT, RISK_JUDGE_REL_PATH), "utf8");
  return exportedFunctionSymbols(source).filter((name) => !hasNonTestCaller(name));
}

// ── (1) an unwired symbol is detected and NAMED ──────────────────────────────────────────────

test("W1-T3056: an exported risk-judge symbol with no caller outside its own tests is detected and named", () => {
  const unwired = unwiredRiskJudgeExports();
  assert.ok(
    unwired.includes("isTestOnlyCompletionOfExistingBehaviour"),
    `expected isTestOnlyCompletionOfExistingBehaviour among the unwired exports, got: ${JSON.stringify(unwired)}`,
  );
});

// ── (2) the falsifier: a symbol that IS called must not trip the detector ───────────────────

test("W1-T3056: a symbol that IS called from production code does not trip the detector", () => {
  // This task's own edit wires declaredFilesAbsentFromChange into buildRiskJudgePrompt — a real
  // call, not a mention — so the detector must discriminate rather than firing on every export.
  assert.equal(
    hasNonTestCaller("declaredFilesAbsentFromChange"),
    true,
    "declaredFilesAbsentFromChange is called from buildRiskJudgePrompt as of this task's own wiring",
  );
  const unwired = unwiredRiskJudgeExports();
  assert.ok(
    !unwired.includes("declaredFilesAbsentFromChange"),
    `declaredFilesAbsentFromChange must not be reported unwired, got: ${JSON.stringify(unwired)}`,
  );
  // A second, long-wired sibling — the detector must not merely be tuned to one pair of names.
  assert.ok(
    !unwired.includes("buildRiskJudgePrompt"),
    "buildRiskJudgePrompt has real callers across the codebase and must never read as unwired",
  );
});
