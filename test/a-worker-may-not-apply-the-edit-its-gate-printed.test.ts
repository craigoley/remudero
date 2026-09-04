/**
 * test/a-worker-may-not-apply-the-edit-its-gate-printed.test.ts — W1-T2651.
 *
 * THE DEFECT. `scripts/source-size-ratchet.mjs`, on failure, prints the exact
 * `"path": bucket` line to write and says recording it in the SAME PR is the ordinary, safe
 * outcome. But `renderFixPrompt`'s DECLARED SCOPE block told EVERY fix worker, mode-agnostically,
 * the opposite: "this task's PR may only touch: <files>... do NOT push it... this task's declared
 * scope is not yours to widen." A worker that obeyed the prompt filed a Follow-up and left the PR
 * red on a required `ci` check. A worker that obeyed the gate instead was caught by the
 * belt-and-suspenders half, `fixRungScopeStandDownReason`, which compared the live diff against
 * the declared `files:` and stood the rung down over the newly added path — so obedience filed a
 * follow-up and disobedience halted the rung: no automated lane could ever clear the gate.
 *
 * THE FIX, ONE PROPERTY, TWO HALVES THAT MUST AGREE.
 *   (i) The permitted set is read off `REGENERABLE_ARTIFACT_GENERATORS` (src/lib/sweep.ts) — the
 *       repo's own registry of paths a generator reproduces from the tree, already relied on by
 *       the merge-conflict rung (W1-T2548) — never a second hand-maintained list.
 *   (ii) `renderFixPrompt`'s DECLARED SCOPE block keeps its ORIGINAL sentence VERBATIM for every
 *        other path, and gains a bounded REGISTRY EXCEPTION clause: a registry-named artifact may
 *        be committed alongside the declared scope when a failing gate calls for it. Rendered only
 *        for a non-plan-only task — a plan-only PR's scope regime never consults this registry.
 *   (iii) `fixRungScopeStandDownReason` (via `outOfDeclaredScopeFiles` -> `scopeGuardOutOfScopeFiles`)
 *         treats a newly added registry-named artifact as in-scope, not as new out-of-scope work,
 *         in the `files` regime — so obeying the gate is never punished by the next one.
 *
 * THE FALSIFIER (acceptance 5). A genuinely unrelated out-of-scope path still stands the rung down
 * exactly as before this task, in BOTH the `files` regime and the plan-only regime — this is never
 * a general licence to widen scope.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixRungScopeStandDownReason,
  outOfDeclaredScopeFiles,
  renderFixPrompt,
  scopeGuardOutOfScopeFiles,
} from "../src/run-task.js";
import { REGENERABLE_ARTIFACT_GENERATORS } from "../src/lib/sweep.js";

const REGISTRY_PATH = "scripts/source-size-baseline.json";
const OTHER_REGISTRY_PATH = "plan/plan-index.json";
const ROGUE_PATH = "src/lib/rogue.ts";

const ORIGINAL_SENTENCE =
  "genuine fix requires a path outside that list, do NOT push it — say so in your REPORT's " +
  "'## Follow-ups' section instead and leave the branch as-is; this task's declared scope is not " +
  "yours to widen.";

function ciEvidence(): { ciFailures: Array<{ name: string; logTail: string }> } {
  return { ciFailures: [{ name: "ci", logTail: "boom" }] };
}

// ── SANITY: the registry really names the path this task's own rationale is about ──────────────

test("sanity: REGENERABLE_ARTIFACT_GENERATORS declares the size-baseline path", () => {
  assert.ok(Object.hasOwn(REGENERABLE_ARTIFACT_GENERATORS, REGISTRY_PATH));
});

// ── ACCEPTANCE #1/#2 — the prompt CARVE-OUT is present, and BOUNDED ────────────────────────────

test("acceptance 1: renderFixPrompt tells a non-plan-only fix worker it MAY commit a registry-named artifact alongside declared scope", () => {
  const task = { id: "W1-T2651X", title: "some task", files: ["src/lib/worker.ts"] };
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2651X-1", evidence: ciEvidence() });
  assert.match(prompt, /REGISTRY EXCEPTION/);
  assert.match(prompt, /REGENERABLE_ARTIFACT_GENERATORS/);
  assert.match(prompt, new RegExp(REGISTRY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /MAY commit it alongside the declared scope/);
  assert.match(prompt, /will NOT stand down/);
});

test("acceptance 2 (bounded): the ORIGINAL declared-scope sentence still renders verbatim, unchanged, alongside the new clause", () => {
  const task = { id: "W1-T2651X", title: "some task", files: ["src/lib/worker.ts"] };
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2651X-1", evidence: ciEvidence() });
  assert.ok(prompt.includes(ORIGINAL_SENTENCE), "the pre-existing refusal sentence must survive byte-for-byte");
});

test("acceptance 2 (bounded): the carve-out clause itself says every OTHER out-of-scope path still follows the do-not-push rule", () => {
  const task = { id: "W1-T2651X", title: "some task", files: ["src/lib/worker.ts"] };
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2651X-1", evidence: ciEvidence() });
  assert.match(prompt, /not a general licence to widen scope/);
});

test("acceptance 2 (bounded): a plan-only task's prompt renders NO registry exception — that regime never consults the registry", () => {
  const task = { id: "W1-T2651X", title: "some task", files: ["plan/tasks.d/foo.yaml"] };
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2651X-1", evidence: ciEvidence() });
  assert.match(prompt, /DECLARED SCOPE/);
  assert.doesNotMatch(prompt, /REGISTRY EXCEPTION/);
});

test("acceptance 2 (bounded): a task declaring no files renders no scope block and no carve-out — silence is never a licence", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-T2651X", title: "some task" },
    round: 1,
    branch: "run-W1-T2651X-1",
    evidence: ciEvidence(),
  });
  assert.doesNotMatch(prompt, /DECLARED SCOPE/);
  assert.doesNotMatch(prompt, /REGISTRY EXCEPTION/);
});

// ── ACCEPTANCE #3 — the permitted set is a FACT about the repo, not a second list ───────────────

test("acceptance 3: scopeGuardOutOfScopeFiles admits ANY path REGENERABLE_ARTIFACT_GENERATORS declares, not just the size baseline", () => {
  const declared = ["src/lib/worker.ts"];
  const diff = [...declared, REGISTRY_PATH, OTHER_REGISTRY_PATH];
  assert.deepEqual(scopeGuardOutOfScopeFiles(diff, declared), []);
});

// ── ACCEPTANCE #4 — THE PRE-STRIKE GATE AGREES WITH THE PROMPT ─────────────────────────────────

test("acceptance 4: fixRungScopeStandDownReason does not stand the rung down over a registry-named artifact the rung itself added", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, REGISTRY_PATH];
  assert.equal(fixRungScopeStandDownReason(current, baseline, declared), undefined);
});

test("acceptance 4: outOfDeclaredScopeFiles agrees — the registry path is in-scope for the files regime", () => {
  const declared = ["src/lib/worker.ts"];
  const diff = [...declared, REGISTRY_PATH];
  assert.deepEqual(outOfDeclaredScopeFiles(diff, declared), []);
});

// ── ACCEPTANCE #5 — THE FALSIFIER: an unrelated path still stands the rung down, both regimes ───

test("acceptance 5 (falsifier, files regime): a genuinely unrelated out-of-scope path is still refused by the push/fix-rung guard", () => {
  const declared = ["src/lib/worker.ts"];
  const diff = [...declared, ROGUE_PATH, REGISTRY_PATH];
  assert.deepEqual(scopeGuardOutOfScopeFiles(diff, declared), [ROGUE_PATH]);
});

test("acceptance 5 (falsifier, files regime): fixRungScopeStandDownReason still stands the rung down over the unrelated path", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, ROGUE_PATH, REGISTRY_PATH];
  const got = fixRungScopeStandDownReason(current, baseline, declared);
  assert.ok(got, "a genuinely out-of-scope new path must still stand the rung down");
  assert.deepEqual(got?.newOutOfScopePaths, [ROGUE_PATH]);
  assert.equal(got?.scopeKind, "files");
});

test("acceptance 5 (falsifier, plan-only regime): a non-plan path still stands the rung down on a plan-only task, registry or not", () => {
  const declared = ["plan/tasks.d/foo.yaml"];
  const baseline = [...declared];
  const current = [...declared, ROGUE_PATH];
  const got = fixRungScopeStandDownReason(current, baseline, declared);
  assert.ok(got, "a plan-only task's fix rung must still stand down on a non-plan addition");
  assert.deepEqual(got?.newOutOfScopePaths, [ROGUE_PATH]);
  assert.equal(got?.scopeKind, "plan");
});

test("acceptance 5 (falsifier, plan-only regime): even a REGISTRY path stands a plan-only task's rung down — the registry is never wired into plan scope", () => {
  const declared = ["plan/tasks.d/foo.yaml"];
  const baseline = [...declared];
  const current = [...declared, REGISTRY_PATH];
  const got = fixRungScopeStandDownReason(current, baseline, declared);
  assert.ok(got, "a plan-only task's rung must stand down even for a registry path — it is not plan-scoped");
  assert.deepEqual(got?.newOutOfScopePaths, [REGISTRY_PATH]);
  assert.equal(got?.scopeKind, "plan");
});

test("acceptance 5 (falsifier): an empty/absent declared scope still refuses every non-empty diff, registry path included", () => {
  assert.deepEqual(scopeGuardOutOfScopeFiles([REGISTRY_PATH], undefined), [REGISTRY_PATH]);
  assert.deepEqual(scopeGuardOutOfScopeFiles([REGISTRY_PATH], []), [REGISTRY_PATH]);
});
