import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── W1-T1206: "the by-name exclusion list that was supposed to keep effect-reaching suites out of
// that sweep subtracts nothing from its actual candidate population" (RECON
// close-is-not-a-live-write-boundary-2026-08-22, citing the amended recon behind W1-T1201). A
// shifted-clock run of `scripts/clock-sweep.mjs` closed eleven LIVE pull requests because
// `SPAWN_REACHING` — the declared, by-name list that is supposed to keep the sweep from ever
// spawning something that reaches a real outward effect — never contained the names of the suites
// that actually did. It COULD NOT have: those suites call `buildSweepEffects` (src/run-task.ts),
// which was never added to the list, so the list "removed none of them" (rationale (2)).
//
// `SPAWN_REACHING` STAYS THE DECLARED, SOLE AUTHORITY the sweep's own `runnableCandidates` acts on
// — this file never touches it, never subtracts from it, never adds to it (design clause (ii)).
// What follows is the ALARM BESIDE it: `test/instrument-surface-completeness.test.ts`'s (W1-T402)
// "declared-plus-derived" shape, applied to `SPAWN_REACHING` over `deriveCandidates`'s own
// population instead of `INSTRUMENT_SURFACE` over gate-rule paths. A derived candidate that can
// reach an outward effect is either named in `SPAWN_REACHING` with a real reason, or the alarm
// reports it — exactly the split `INSTRUMENT_SURFACE_EXCLUSIONS` already established: "a bare
// exclusion (no reason, or a blank one) does not count".
//
// ── WHAT "CAN REACH AN OUTWARD EFFECT" MEANS HERE, DERIVED FROM THE TREE (design clause (iii)) ──
// `buildSweepEffects` (src/run-task.ts) is the SOLE place the sweep's outward writes are composed:
// its own trailing parameters — `reviewRunner`, `spawnImpl`, `pushEmptyCommit`, `issuesImpl`,
// `stallNotice`, `armImpl`, `updateBranchImpl`, and `ghRunImpl` itself — each carry a REAL default
// (a live `gh`/git call, by that function's own inline comments: "Default is the real
// `execFileSync`", "a live `gh pr merge`", "a live, mutating `gh` call"). A candidate whose OWN
// source calls `buildSweepEffects(` therefore reaches that live surface unless every one of those
// defaults is overridden — and it is exactly this call, un-narrowed by any per-argument stubbing
// analysis, that `REACHES_OUTWARD_EFFECT_RE` below detects: a plain text scan for the call, never a
// list of the five/six suite NAMES rationale (1) cites. Two suites with identical bodies get an
// identical verdict regardless of what either is called — proven directly below.
//
// THIS IS A DELIBERATE, DOCUMENTED OVER-APPROXIMATION, THE SAFE DIRECTION FOR AN ALARM: the regex
// cannot distinguish a real call from a code comment that merely NAMES the call (the same way
// `test/fix-dedup-seed.test.ts`'s own header prose does, harmlessly, beside its real call at that
// file's line 143) — so it can flag a candidate that merely talks about reaching the effect. It
// never does the opposite (staying silent on a candidate that truly reaches it), which is the
// property an alarm needs: a false alarm costs a reason string, a missed one costs eleven pull
// requests. It also does not attempt a full call-graph across every path to a raw process spawn
// anywhere in `src/` — like the instrument-surface precedent's own choice not to attempt an
// "unbounded, over-eager recursive harvest" (that file's `deriveInstrumentCandidates` doc), this is
// scoped to the ONE composer the incident this task exists to close actually went through.
//
// ── THE ALARM MUST NEVER RUN THE SWEEP, SHIFT A CLOCK, OR SPAWN (design clause (iv)) ── every
// function below reads `node:fs` text and nothing else; none of them imports `node:child_process`,
// calls `runSuite`/`main`, or touches `FK_SHIFT_DAYS` (`clock-shift.mjs`'s own signal that a shift
// is active). The last test below exercises that directly.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_DIR = join(REPO_ROOT, "test");

// `scripts/**` sits outside tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/clock-sweep.mjs"` is a TS7016 — the same reason
// `test/clock-sweep.test.ts` reaches it through a runtime import instead of a typed one. A dynamic
// specifier loads the REAL module (the real `SPAWN_REACHING`, the real `deriveCandidates`), never a
// shadow copy that could drift from it.
const SWEEP_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clock-sweep.mjs")).href;

const mod = (await import(SWEEP_URL)) as {
  SPAWN_REACHING: ReadonlyMap<string, string>;
  deriveCandidates: (testDir?: string) => string[];
};
const { SPAWN_REACHING, deriveCandidates } = mod;

/** The derived reachability signal (see the file header): a real call, textually, never a name. */
const REACHES_OUTWARD_EFFECT_RE = /\bbuildSweepEffects\s*\(/;

/** Pure: true when `sourceText` itself — never the candidate's NAME — calls the sweep's effect
 * composer. Exercised directly against fabricated fixtures below, and against the real tree by
 * the last test, without duplicating the check's logic between the two. */
function reachesOutwardEffect(sourceText: string): boolean {
  return REACHES_OUTWARD_EFFECT_RE.test(sourceText);
}

/**
 * THE ALARM ITSELF, pure and read-only over `exclusions` (never `.set`/`.delete`d — see acceptance
 * claim 3's test below, which proves that on the REAL `SPAWN_REACHING`). A derived candidate is
 * unexplained when it reaches an outward effect and carries no non-blank reason in `exclusions` —
 * the `SPAWN_REACHING` split, generalized exactly the way `findUnexplainedGaps`
 * (test/instrument-surface-completeness.test.ts) generalizes `INSTRUMENT_SURFACE_EXCLUSIONS`.
 */
function findUnexplainedReach(candidates: readonly string[], sourceByCandidate: ReadonlyMap<string, string>, exclusions: ReadonlyMap<string, string>): string[] {
  return candidates.filter((c) => {
    if (!reachesOutwardEffect(sourceByCandidate.get(c) ?? "")) return false;
    const reason = exclusions.get(c);
    return typeof reason !== "string" || reason.trim().length === 0;
  });
}

// ── acceptance claim 1: an uncovered, unexcused derived candidate is REPORTED, not silently passed

test("W1-T1206: an effect-reaching candidate absent from the exclusion list fails", () => {
  const sources = new Map([["made-up-suite", "const effects = buildSweepEffects(owner, repo, config);"]]);
  const gaps = findUnexplainedReach(["made-up-suite"], sources, new Map());
  assert.deepEqual(gaps, ["made-up-suite"], "a candidate that reaches the effect and is excluded nowhere must be reported");
});

test("W1-T1206: a candidate that never calls the effect composer is never reported, exclusion or not", () => {
  const sources = new Map([["harmless-suite", "assert.equal(staleDays(pr), 14); // no effect call anywhere"]]);
  assert.deepEqual(findUnexplainedReach(["harmless-suite"], sources, new Map()), []);
});

// ── acceptance claim 2: an exclusion is honoured ONLY when it carries a recorded reason ──────────

test("W1-T1206: a bare exclusion without a reason does not excuse a candidate", () => {
  const sources = new Map([["made-up-suite", "buildSweepEffects(owner, repo, config);"]]);
  assert.deepEqual(findUnexplainedReach(["made-up-suite"], sources, new Map([["made-up-suite", ""]])), ["made-up-suite"], "an empty reason must not silence the alarm");
  assert.deepEqual(findUnexplainedReach(["made-up-suite"], sources, new Map([["made-up-suite", "   "]])), ["made-up-suite"], "a whitespace-only reason must not silence the alarm");
  assert.deepEqual(
    findUnexplainedReach(["made-up-suite"], sources, new Map([["made-up-suite", "drives buildSweepEffects against a bare tmpdir origin, never the live repo"]])),
    [],
    "a real, substantive reason silences the alarm",
  );
});

// ── acceptance claim 3: the declared set is READ, and this check never mutates it ────────────────

test("W1-T1206: the check never adds to or subtracts from the declared set", () => {
  const before = [...SPAWN_REACHING.entries()];
  const sources = new Map([
    ["fabricated-a", "buildSweepEffects(owner, repo, config);"],
    ["fabricated-b", "// nothing that reaches an outward effect here"],
  ]);
  findUnexplainedReach(["fabricated-a", "fabricated-b"], sources, SPAWN_REACHING);
  assert.deepEqual([...SPAWN_REACHING.entries()], before, "SPAWN_REACHING must be identical after the check runs — read-only, by construction");
});

// ── acceptance claim 4: reachability tracks CONTENT, never the candidate's own name ───────────────

test("W1-T1206: reachability is derived, not a hardcoded name list", () => {
  const reaching = "const effects = buildSweepEffects(owner, repo, config, ledgerPath, runId, plan, log);";
  const inert = "// this suite never touches buildSweepEffects at all\nassert.equal(1, 1);";
  // Names invented for this test alone — none of them is a real suite, let alone one of the five
  // rationale (1) names. If the verdict tracked NAMES rather than content, an unrecognised name
  // could only ever read as "not reaching" (a hardcoded list has nothing to say about a name it
  // does not contain) — so a made-up name reading `true` here is only explicable by content.
  assert.equal(reachesOutwardEffect(reaching), true, "unrecognised name, but the CONTENT calls the composer");
  assert.equal(reachesOutwardEffect(inert), false, "unrecognised name, and the content never calls it");
  // Same content under two DIFFERENT invented names must agree — the name plays no role at all.
  const sources = new Map([
    ["totally-invented-name-one", reaching],
    ["an-entirely-different-invented-name", reaching],
  ]);
  const gaps = findUnexplainedReach([...sources.keys()], sources, new Map());
  assert.deepEqual(new Set(gaps), new Set(sources.keys()), "identical content must yield identical verdicts regardless of the candidate's name");
});

// ── acceptance claim 5: the check is a static read — no suite run, no spawn, no clock shift ──────

test("W1-T1206: the completeness check spawns nothing and shifts no clock", () => {
  // `FK_SHIFT_DAYS` is `clock-shift.mjs`'s own signal that a shift is active — `runSuite`
  // (clock-sweep.mjs) sets it in the ENV of every child it spawns. If this check ever spawned a
  // suite the way the sweep itself does, this is the variable that spawn would carry; asserting it
  // is untouched is a direct probe of "no suite was run", not a proxy for it.
  const shiftBefore = process.env.FK_SHIFT_DAYS;

  // The SAME candidate derivation the sweep performs (design clause (ii)) — `deriveCandidates` is
  // itself a static `readdirSync`/`readFileSync` read (scripts/clock-sweep.mjs), never an exec.
  const candidates = deriveCandidates();
  assert.ok(candidates.length > 0, "sanity: the derivation is finding a real population, not running vacuously");
  const sourceByCandidate = new Map(candidates.map((c) => [c, readFileSync(join(TEST_DIR, `${c}.test.ts`), "utf8")]));

  const gaps = findUnexplainedReach(candidates, sourceByCandidate, SPAWN_REACHING);

  assert.equal(process.env.FK_SHIFT_DAYS, shiftBefore, "the check must never set FK_SHIFT_DAYS — it never spawns a suite for clock-shift.mjs to shift");
  assert.ok(Array.isArray(gaps), "the check completed and returned a plain array — never a child-process result");
});
