import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// W1-T3056 — TWO RISK-JUDGE PREDICATES WERE EXPORTED, TESTED AND CALLED BY NOTHING.
//
// MEASURED 2026-09-07: `git grep -n '<symbol>' -- src/ scripts/ bin/ .github/` returned EXACTLY
// ONE line for each of `declaredFilesAbsentFromChange` and `isTestOnlyCompletionOfExistingBehaviour`
// — their own `export function` declaration in src/lib/risk-judge.ts. Neither had a real caller;
// the declared-versus-actual mismatch the judge acts on was an LLM inference over two rendered
// lists, never a fact the pure predicates written to compute it actually fed it.
//
// OPERATOR RULING 2026-09-22 took ending (a) — WIRE THEM — and this task's own edit to
// src/lib/risk-judge.ts wires `declaredFilesAbsentFromChange` into `buildRiskJudgePrompt` as a
// rendered "DECLARED FILES THE ACTUAL CHANGE DOES NOT TOUCH" line. `isTestOnlyCompletionOfExisting-
// Behaviour` stays unwired, DELIBERATELY (the sanctioned partial-(a) split: nothing today produces
// the `DeclaredFileBaseFact`s it needs) — which makes it the live, undisputed fixture for this
// file's detector, exactly as clause (iv) says: "risk-judge.ts exports many symbols that ARE wired,
// so the discriminating fixture is available in the same file rather than needing invention."
//
// THE DETECTOR ITSELF (below) is the buildable-either-way instrument clause (iv) asks for: it
// fails when an exported `risk-judge.ts` function has no CALL — `name(` — anywhere in
// src/ scripts/ bin/ .github/ outside its own `export function` declaration line. A bare mention
// (this file's own header comment above, or risk-judge.ts's own doc comment naming
// `declaredFilesAbsentFromChange` in prose) has no trailing `(` immediately after the identifier
// and is correctly never counted as a call — the exact trap the falsifier's plain `git grep` walks
// into and a call-shaped search does not.

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

/** Tracked files under the exact paths the task's own falsifier names — `src/ scripts/ bin/
 *  .github/` — read fresh via `git ls-files` each call so the detector never operates on a stale
 *  worktree snapshot. */
function trackedFiles(paths: string[]): string[] {
  const res = spawnSync("git", ["ls-files", ...paths], { cwd: REPO_ROOT, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`a-risk-judge-predicate-nothing-calls: git ls-files failed: ${res.stderr}`);
  }
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** True when `symbol` has a real CALL — `symbol(` — somewhere in `src/ scripts/ bin/ .github/`
 *  other than its own `export function` declaration line. A doc-comment mention of the bare name
 *  has no trailing `(` immediately after it and is correctly never counted. */
export function hasNonTestCaller(symbol: string, paths: string[] = ["src", "scripts", "bin", ".github"]): boolean {
  const callRe = new RegExp(`\\b${symbol}\\(`);
  const declRe = new RegExp(`^export function ${symbol}\\(`);
  for (const rel of trackedFiles(paths)) {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, rel), "utf8");
    } catch {
      continue; // a symlink or a path git tracks but the worktree lacks — skip, never crash the scan
    }
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

// ── the trap the falsifier's plain `git grep` walks into, and this detector does not ─────────

test("W1-T3056: a bare doc-comment mention of a symbol's name is not counted as a call", () => {
  // risk-judge.ts's own doc comment on isPlanOnlyAmendment names declaredFilesAbsentFromChange in
  // prose, with no trailing "(" — exactly the shape that made the falsifier's own recon note a
  // plain `git grep -n '<symbol>'` would over-count. hasNonTestCaller must still return the right
  // answer for that symbol's REAL wiring rather than being fooled into false-positive OR
  // false-negative by that mention alone.
  const source = readFileSync(join(REPO_ROOT, RISK_JUDGE_REL_PATH), "utf8");
  assert.match(
    source,
    /reasoning `declaredFilesAbsentFromChange` already applies/,
    "sanity: the bare doc-comment mention this test is about must still exist",
  );
  assert.equal(hasNonTestCaller("declaredFilesAbsentFromChange"), true, "the REAL call site decides, not the comment");
});
