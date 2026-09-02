/**
 * test/fix-prompt-inherited-scope.test.ts — W1-T2607.
 *
 * THE DEFECT. `renderFixPrompt`'s DECLARED SCOPE block (W1-T1227, src/run-task.ts) told a round-N
 * fix worker two things, and both were wrong. First, it named a CONSEQUENCE the guard does not
 * impose: "A commit outside declared scope makes the WHOLE PR unreviewable … and only a human can
 * undo it." The implement path's real disposition (W1-T434) is push-and-flag — it logs
 * `scope_guard.overrun` and pushes anyway; nothing refuses the PR. Second, it HID the one
 * exemption the guard actually grants: `fixRungScopeStandDownReason` (:4121) deliberately never
 * re-flags a path already present in `baselineDiffFiles` — the diff as it stood before this
 * invocation's first strike — because that guard judges the rung only on what IT adds, not what
 * it inherited. A round-N worker was never told which of its own branch's out-of-scope paths were
 * already exempt, so it would re-litigate an inherited file and spend a follow-up proposal (and an
 * Architect cycle) on a decision the guard had already made for it.
 *
 * THE FIX. `renderFixPrompt` gains an optional `baselineDiffFiles` input (the SAME baseline
 * `fixRungScopeStandDownReason` already reads, threaded from `runFixRung`'s own pre-captured
 * variable — no second fetch). When declared files are non-empty and that baseline carries a path
 * outside them, an INHERITED SCOPE line names it as predating this invocation, judged only via
 * what this rung itself adds, and requiring neither removal nor a repeated report. The
 * out-of-scope selection is computed by `outOfDeclaredScopeFiles` — factored out of
 * `fixRungScopeStandDownReason` so both callers read ONE implementation of "which regime, which
 * predicate" (design note i). The DECLARED SCOPE sentence itself now states the real consequence
 * (pushed and flagged, next round stands down only on a NEW out-of-scope path) and drops the
 * "whole PR unreviewable / only a human can undo it" claim entirely. The prohibition on widening
 * declared scope, and the instruction to report a genuinely-needed out-of-scope path via
 * '## Follow-ups' instead of pushing it, are both unchanged.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderFixPrompt, fixRungScopeStandDownReason, outOfDeclaredScopeFiles } from "../src/run-task.js";

const TASK = { id: "W1-T2607X", title: "fix the flaky check", files: ["src/foo.ts", "test/foo.test.ts"] };
const EVIDENCE = { ciFailures: [{ name: "build", logTail: "boom" }] };

function render(baselineDiffFiles?: string[]): string {
  return renderFixPrompt({
    task: TASK,
    round: 2,
    branch: "run-W1-T2607X-1",
    evidence: EVIDENCE,
    baselineDiffFiles,
  });
}

// ── acceptance 1: an inherited out-of-scope path is NAMED as inherited and exempt ──────────────

test("acceptance 1: an out-of-scope path already in the branch baseline is named as INHERITED SCOPE", () => {
  const prompt = render(["src/foo.ts", "docs/pre-existing-note.md"]);
  assert.match(prompt, /INHERITED SCOPE/);
  assert.match(prompt, /docs\/pre-existing-note\.md/);
  // Says WHY it needs no action from this round — predates the invocation, judged only on what
  // this rung itself adds, neither removal nor a repeat report required.
  assert.match(prompt, /predate/i);
  assert.match(prompt, /this rung/i);
});

test("acceptance 1: a MULTI-file inherited baseline names every out-of-scope path, not just the first", () => {
  const prompt = render(["src/foo.ts", "docs/a.md", "scripts/b.json"]);
  assert.match(prompt, /docs\/a\.md/);
  assert.match(prompt, /scripts\/b\.json/);
});

// ── acceptance 2: the block states the REAL consequence, never the false one ───────────────────

test("acceptance 2: the block states push-and-flag, and drops the whole-PR/only-a-human claim", () => {
  const prompt = render(["src/foo.ts"]);
  assert.match(prompt, /PUSHED AND FLAGGED/i);
  assert.match(prompt, /scope_guard\.overrun/);
  assert.doesNotMatch(prompt, /unreviewable/i);
  assert.doesNotMatch(prompt, /only a human can undo/i);
});

test("acceptance 2: the false consequence is gone even with NO inherited paths at all", () => {
  const prompt = render([]);
  assert.doesNotMatch(prompt, /unreviewable/i);
  assert.doesNotMatch(prompt, /only a human can undo/i);
});

// ── acceptance 3: the exemption is not a licence — a NEW out-of-scope path still stands down ───

test("acceptance 3: the prompt still forbids pushing a NEW out-of-scope path", () => {
  const prompt = render(["src/foo.ts"]);
  assert.match(prompt, /do NOT push it/);
});

test("acceptance 3: fixRungScopeStandDownReason still stands the rung down on a path NEWLY added beyond the baseline — the inherited exemption never widens", () => {
  const declared = TASK.files;
  const baseline = ["src/foo.ts", "docs/pre-existing-note.md"]; // pre-existing.md already exempt
  const current = [...baseline, "scripts/rogue.json"]; // a genuinely NEW out-of-scope path
  const got = fixRungScopeStandDownReason(current, baseline, declared);
  assert.ok(got, "a newly added out-of-scope path still stands the rung down");
  assert.deepEqual(got.newOutOfScopePaths, ["scripts/rogue.json"]);
  // The inherited path is never re-flagged as new.
  assert.ok(!got.newOutOfScopePaths.includes("docs/pre-existing-note.md"));
});

// ── acceptance 4: the worker may still not widen its own declared scope ────────────────────────

test("acceptance 4: the prompt still tells the worker to REPORT a genuinely out-of-scope need, not self-edit its declared files", () => {
  const prompt = render(["src/foo.ts"]);
  assert.match(prompt, /Follow-ups/);
  assert.match(prompt, /leave the branch as-is/);
});

// ── acceptance 5: the clean path — nothing inherited, or no readable baseline — is unchanged ───

test("acceptance 5: a baseline with NO out-of-scope paths renders no INHERITED SCOPE line", () => {
  const prompt = render(["src/foo.ts", "test/foo.test.ts"]); // both declared — nothing out of scope
  assert.doesNotMatch(prompt, /INHERITED SCOPE/);
});

test("acceptance 5: an UNDEFINED baseline (fetchPrDiffFiles absent or threw) renders no INHERITED SCOPE line — fail OPEN, never guessed", () => {
  const prompt = render(undefined);
  assert.doesNotMatch(prompt, /INHERITED SCOPE/);
  // The DECLARED SCOPE block itself still renders — this task never touches that gate.
  assert.match(prompt, /DECLARED SCOPE/);
});

test("acceptance 5: a task with no declared files renders neither DECLARED SCOPE nor INHERITED SCOPE, baseline or not", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-T2607X", title: "t" },
    round: 1,
    branch: "run-W1-T2607X-1",
    evidence: EVIDENCE,
    baselineDiffFiles: ["docs/anything.md"],
  });
  assert.doesNotMatch(prompt, /DECLARED SCOPE/);
  assert.doesNotMatch(prompt, /INHERITED SCOPE/);
});

// ── the factored predicate itself — the ONE implementation both callers now read ───────────────

test("outOfDeclaredScopeFiles: selects exact declared-file membership for a non-plan-only task, matching fixRungScopeStandDownReason's own regime", () => {
  const declared = ["src/foo.ts", "src/bar.ts"];
  assert.deepEqual(outOfDeclaredScopeFiles(["src/foo.ts", "src/bar.ts", "src/rogue.ts"], declared), ["src/rogue.ts"]);
});

test("outOfDeclaredScopeFiles: selects plan-scope membership when every declared file is itself plan-scoped", () => {
  const declaredPlanOnly = ["plan/tasks.d/W1-T2607X.yaml"];
  const got = outOfDeclaredScopeFiles(["plan/tasks.d/W1-T2607X.yaml", "test/w1-t187-benchmark.test.ts"], declaredPlanOnly);
  assert.deepEqual(got, ["test/w1-t187-benchmark.test.ts"]);
});

test("outOfDeclaredScopeFiles: empty/undefined declared scope yields no out-of-scope paths — nothing to compare against", () => {
  assert.deepEqual(outOfDeclaredScopeFiles(["src/foo.ts"], undefined), []);
  assert.deepEqual(outOfDeclaredScopeFiles(["src/foo.ts"], []), []);
});
