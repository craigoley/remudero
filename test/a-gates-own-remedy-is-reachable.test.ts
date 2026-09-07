/**
 * test/a-gates-own-remedy-is-reachable.test.ts — W1-T2653.
 *
 * THE DEFECT. `scripts/source-size-ratchet.mjs`, on failure, prints the exact `"path": N` line to
 * write into `scripts/source-size-baseline.json` and says recording it in the SAME PR is safe
 * (rule 25's `ENTANGLEMENT_EXEMPT_INSTRUMENTS` already names this path). But
 * `fixRungScopeStandDownReason` stood the rung down the moment a repair added that path outside
 * `declaredFiles`, and `renderFixPrompt`'s DECLARED SCOPE line told the worker "this task's PR may
 * only touch: <declared>" with no carve-out — so the gate's own legible, rule-25-safe remedy was
 * still forbidden by the scope guard. Five distinct fix rungs (W1-T2485/2490/2497/2503/2504) hit
 * this identical wall in nearly identical words.
 *
 * THE FIX, TWO HALVES THAT MUST AGREE, SCOPED TO THE REPAIR (never a blanket grant):
 *   (i)   `FAST_GATE_STEPS` (lib/ci-parity.ts) — the repo's own per-gate registry — carries an
 *         OPTIONAL `remedyFiles` on an entry, declared beside that entry's own `reason`, never a
 *         second hand-list living inside the scope guard.
 *   (ii)  `remedyFilesForFailingChecks` (lib/ci-parity.ts) narrows that registry down to the
 *         check(s) CURRENTLY FAILING — a check that is not failing this round contributes nothing,
 *         even if it declares `remedyFiles`, so a strike repairing an unrelated gate never inherits
 *         a remedy that belongs to a different one.
 *   (iii) `fixRungScopeStandDownReason` gains a 4th, PURE parameter — `reachableRemedyFiles` — the
 *         caller's own `remedyFilesForFailingChecks` result (flattened to paths) for THIS round.
 *         Widens the scope-membership check for this call only; never persists, never touches
 *         `declaredFiles` itself, and is skipped entirely on a plan-only task (that regime is
 *         graded by plan-scope membership, never wired into this registry).
 *   (iv)  `renderFixPrompt`'s DECLARED SCOPE block gains a GATE REMEDY clause naming the exact
 *         reachable file(s) AND the gate that declares them, computed from the SAME
 *         `reachableRemedyFiles` value the scope gate itself was called with — instruction and
 *         enforcement can never name a different set.
 *
 * THE FALSIFIERS this task's own rationale demands (never a blanket grant):
 *   - a path that is NOT a declared remedy of ANY currently-failing check still stands the rung
 *     down exactly as before this task.
 *   - a remedy file belonging to a gate that is NOT currently failing (i.e. `reachableRemedyFiles`
 *     was computed from the wrong check set) still stands the rung down — the exemption tracks the
 *     repair, not the mere existence of a registry entry somewhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixRungScopeStandDownReason, outOfDeclaredScopeFiles, renderFixPrompt } from "../src/run-task.js";
import { FAST_GATE_STEPS, remedyFilesForFailingChecks, type FastGateStep } from "../src/lib/ci-parity.js";

const SOURCE_SIZE_REMEDY = "scripts/source-size-baseline.json";
const ROGUE_PATH = "src/lib/rogue.ts";

function ciEvidence(): { ciFailures: Array<{ name: string; logTail: string }> } {
  return { ciFailures: [{ name: "ci", logTail: "boom" }] };
}

// A fixture registry, independent of the real FAST_GATE_STEPS table, so the scoping property is
// exercised without depending on which gates the real table happens to carry today.
const FIXTURE_STEPS: FastGateStep[] = [
  { job: "gate-a", script: "gate-a:check", reason: "fixture reason a", remedyFiles: ["remedy/a.json"] },
  { job: "gate-b", script: "gate-b:check", reason: "fixture reason b", remedyFiles: ["remedy/b.json", "remedy/b2.json"] },
  { job: "gate-c", script: "gate-c:check", reason: "fixture reason c (no remedy declared)" },
];

// ── SANITY: the registry really carries the source-size entry's own remedy, per-entry ───────────

test("sanity: FAST_GATE_STEPS declares scripts/source-size-baseline.json as the source-size gate's own remedy", () => {
  const entry = FAST_GATE_STEPS.find((s) => s.job === "source-size");
  assert.ok(entry, "the source-size gate must still exist in the registry");
  assert.deepEqual(entry?.remedyFiles, [SOURCE_SIZE_REMEDY]);
  assert.ok(entry?.reason && entry.reason.length > 0, "the entry carries its own reason, never a borrowed one");
});

test("sanity: a gate with no declared remedy carries remedyFiles undefined, never an inferred value", () => {
  const entry = FAST_GATE_STEPS.find((s) => s.job === "claims");
  assert.ok(entry);
  assert.equal(entry?.remedyFiles, undefined);
});

// ── remedyFilesForFailingChecks: THE SCOPING PRIMITIVE ───────────────────────────────────────────

test("remedyFilesForFailingChecks: a currently-failing check's declared remedy is returned, named alongside its gate", () => {
  const got = remedyFilesForFailingChecks(["gate-a"], FIXTURE_STEPS);
  assert.deepEqual(got, [{ path: "remedy/a.json", job: "gate-a" }]);
});

test("remedyFilesForFailingChecks: a check that is NOT currently failing contributes nothing, even though it declares a remedy", () => {
  const got = remedyFilesForFailingChecks(["gate-c"], FIXTURE_STEPS);
  assert.deepEqual(got, [], "gate-a/gate-b's remedies must not leak in when only gate-c is failing");
});

test("remedyFilesForFailingChecks: multiple failing checks union their remedies, sorted and deduplicated", () => {
  const got = remedyFilesForFailingChecks(["gate-b", "gate-a"], FIXTURE_STEPS);
  assert.deepEqual(got, [
    { path: "remedy/a.json", job: "gate-a" },
    { path: "remedy/b.json", job: "gate-b" },
    { path: "remedy/b2.json", job: "gate-b" },
  ]);
});

test("remedyFilesForFailingChecks: no failing checks at all returns empty — never a default grant", () => {
  assert.deepEqual(remedyFilesForFailingChecks([], FIXTURE_STEPS), []);
});

test("remedyFilesForFailingChecks: against the REAL table, only a failing source-size check surfaces its remedy", () => {
  const got = remedyFilesForFailingChecks(["source-size"]);
  assert.deepEqual(got, [{ path: SOURCE_SIZE_REMEDY, job: "source-size" }]);
});

// ── ACCEPTANCE 1 — reachable: a fix rung repairing THAT gate's failure may write its remedy ─────

test("acceptance 1: fixRungScopeStandDownReason does not stand the rung down over a reachable remedy file", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, SOURCE_SIZE_REMEDY];
  const reachable = remedyFilesForFailingChecks(["source-size"]).map((r) => r.path);
  assert.equal(fixRungScopeStandDownReason(current, baseline, declared, reachable), undefined);
});

test("acceptance 1: outOfDeclaredScopeFiles agrees once the remedy path is folded into the declared set", () => {
  const declared = ["src/lib/worker.ts", SOURCE_SIZE_REMEDY];
  const diff = [...declared];
  assert.deepEqual(outOfDeclaredScopeFiles(diff, declared), []);
});

// ── ACCEPTANCE 2 — falsifier: an unrelated path is NOT a declared remedy, still stands down ──────

test("acceptance 2 (falsifier): a genuinely unrelated out-of-scope path still stands the rung down, reachable remedy present or not", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, ROGUE_PATH, SOURCE_SIZE_REMEDY];
  const reachable = remedyFilesForFailingChecks(["source-size"]).map((r) => r.path);
  const got = fixRungScopeStandDownReason(current, baseline, declared, reachable);
  assert.ok(got, "the rogue path must still stand the rung down");
  assert.deepEqual(got?.newOutOfScopePaths, [ROGUE_PATH]);
  assert.equal(got?.scopeKind, "files");
});

test("acceptance 2 (falsifier): with NO reachable remedy files supplied, behaviour is byte-identical to before this task", () => {
  // Deliberately NOT scripts/source-size-baseline.json: that path is ALSO exempt unconditionally
  // via the pre-existing REGENERABLE_ARTIFACT_GENERATORS registry (W1-T2651), which would pass
  // regardless of this parameter and so would not distinguish the new mechanism from the old one.
  // "remedy/a.json" belongs to neither registry, so it isolates THIS parameter's own default.
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, "remedy/a.json"];
  const withoutParam = fixRungScopeStandDownReason(current, baseline, declared);
  const withEmptyArray = fixRungScopeStandDownReason(current, baseline, declared, []);
  assert.ok(withoutParam, "omitting the 4th parameter must still refuse the remedy path — the default is []");
  assert.deepEqual(withoutParam, withEmptyArray);
  assert.deepEqual(withoutParam?.newOutOfScopePaths, ["remedy/a.json"]);
});

// ── ACCEPTANCE 3 — the exemption is SCOPED TO THE REPAIR, never a blanket grant ──────────────────

test("acceptance 3 (falsifier): a strike addressing a DIFFERENT failing check gets no exemption for a gate that isn't failing", () => {
  // gate-a is failing this round, gate-b is not — gate-b's own remedy is NOT reachable.
  const reachable = remedyFilesForFailingChecks(["gate-a"], FIXTURE_STEPS).map((r) => r.path);
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, "remedy/b.json"]; // gate-b's remedy, but gate-b is not in `reachable`
  const got = fixRungScopeStandDownReason(current, baseline, declared, reachable);
  assert.ok(got, "a remedy belonging to a gate that isn't currently failing must still stand the rung down");
  assert.deepEqual(got?.newOutOfScopePaths, ["remedy/b.json"]);
});

test("acceptance 3: the SAME failing check's own remedy IS reachable — the positive control for the falsifier above", () => {
  const reachable = remedyFilesForFailingChecks(["gate-a"], FIXTURE_STEPS).map((r) => r.path);
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, "remedy/a.json"];
  assert.equal(fixRungScopeStandDownReason(current, baseline, declared, reachable), undefined);
});

test("acceptance 3 (falsifier, plan-only): a plan-only task's rung still stands down over a reachable remedy — never wired into plan scope", () => {
  const declared = ["plan/tasks.d/foo.yaml"];
  const baseline = [...declared];
  const current = [...declared, SOURCE_SIZE_REMEDY];
  const reachable = remedyFilesForFailingChecks(["source-size"]).map((r) => r.path);
  const got = fixRungScopeStandDownReason(current, baseline, declared, reachable);
  assert.ok(got, "a plan-only task's rung must stand down even for a reachable remedy path");
  assert.equal(got?.scopeKind, "plan");
});

// ── ACCEPTANCE 4 — THE PROMPT NAMES THE REACHABLE REMEDY AND ITS GATE ────────────────────────────

test("acceptance 4: renderFixPrompt names the reachable remedy file and its gate alongside declared scope", () => {
  const task = { id: "W1-T2653X", title: "some task", files: ["src/lib/worker.ts"] };
  const reachableRemedyFiles = remedyFilesForFailingChecks(["source-size"]);
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2653X-1", evidence: ciEvidence(), reachableRemedyFiles });
  assert.match(prompt, /GATE REMEDY/);
  assert.match(prompt, new RegExp(SOURCE_SIZE_REMEDY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /gate: source-size/);
  assert.match(prompt, /MAY commit it\/them alongside the declared scope/);
});

test("acceptance 4: the ORIGINAL declared-scope sentence still renders verbatim alongside the new GATE REMEDY clause", () => {
  const task = { id: "W1-T2653X", title: "some task", files: ["src/lib/worker.ts"] };
  const reachableRemedyFiles = remedyFilesForFailingChecks(["source-size"]);
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2653X-1", evidence: ciEvidence(), reachableRemedyFiles });
  assert.ok(
    prompt.includes(
      "genuine fix requires a path outside that list, do NOT push it — say so in your REPORT's " +
        "'## Follow-ups' section instead and leave the branch as-is; this task's declared scope is not " +
        "yours to widen.",
    ),
    "the pre-existing refusal sentence must survive byte-for-byte",
  );
});

test("acceptance 4: with no reachable remedy files, no GATE REMEDY clause renders — never a guessed remedy", () => {
  const task = { id: "W1-T2653X", title: "some task", files: ["src/lib/worker.ts"] };
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2653X-1", evidence: ciEvidence() });
  assert.doesNotMatch(prompt, /GATE REMEDY/);
});

test("acceptance 4: a plan-only task's prompt renders no GATE REMEDY clause even when a remedy is reachable", () => {
  const task = { id: "W1-T2653X", title: "some task", files: ["plan/tasks.d/foo.yaml"] };
  const reachableRemedyFiles = remedyFilesForFailingChecks(["source-size"]);
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2653X-1", evidence: ciEvidence(), reachableRemedyFiles });
  assert.match(prompt, /DECLARED SCOPE/);
  assert.doesNotMatch(prompt, /GATE REMEDY/);
});

test("acceptance 4: a task declaring no files renders neither DECLARED SCOPE nor GATE REMEDY", () => {
  const reachableRemedyFiles = remedyFilesForFailingChecks(["source-size"]);
  const prompt = renderFixPrompt({
    task: { id: "W1-T2653X", title: "some task" },
    round: 1,
    branch: "run-W1-T2653X-1",
    evidence: ciEvidence(),
    reachableRemedyFiles,
  });
  assert.doesNotMatch(prompt, /DECLARED SCOPE/);
  assert.doesNotMatch(prompt, /GATE REMEDY/);
});

// ── ACCEPTANCE 5 — declared in the registry, with a per-entry reason, never inside the scope guard ──

test("acceptance 5: grep-shape sanity — remedyFiles lives on a FAST_GATE_STEPS entry, not a list inside the scope guard", () => {
  // fixRungScopeStandDownReason/scopeGuardOutOfScopeFiles take the reachable set as a plain
  // parameter (proven above); the only place a remedy path is DECLARED is this per-entry field.
  const entries = FAST_GATE_STEPS.filter((s) => s.remedyFiles && s.remedyFiles.length > 0);
  assert.ok(entries.length >= 1, "at least one FAST_GATE_STEPS entry declares remedyFiles");
  for (const e of entries) {
    assert.ok(e.reason && e.reason.length > 0, `entry ${e.job} must carry its own non-empty reason`);
  }
});
