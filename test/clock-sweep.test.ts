import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/clock-sweep.mjs"` is a TS7016 — the same reason
// test/mutation-ratchet.test.ts reaches its script through a runtime import rather than a typed
// one. A dynamic specifier is not statically resolved, so this loads the REAL module with no
// shadow copy to drift from it.
const SWEEP_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clock-sweep.mjs"),
).href;

const {
  CLOCK_ARTIFACTS,
  SPAWN_REACHING,
  SWEEP_SHIFT_DAYS,
  classifySweep,
  deriveCandidates,
  failingTitles,
  runnableCandidates,
} = (await import(SWEEP_URL)) as {
  CLOCK_ARTIFACTS: ReadonlyMap<string, string>;
  SPAWN_REACHING: ReadonlyMap<string, string>;
  SWEEP_SHIFT_DAYS: number;
  classifySweep: (
    results: Map<string, { failed: boolean; output?: string }>,
    artifacts?: ReadonlyMap<string, string>,
  ) => { drifted: Array<{ suite: string }>; staleExclusions: Array<{ suite: string; reason: string }>; ok: boolean };
  deriveCandidates: (testDir?: string) => string[];
  failingTitles: (output: string) => string[];
  runnableCandidates: (candidates: string[]) => string[];
};

// ── The scheduled sweep's own logic, guarded. The sweep itself takes minutes and spawns dozens of
// child processes; everything decision-shaped here is pure, so it is asserted directly instead.
//
// The two properties that matter are opposites and both must hold: the exclusion list must SILENCE
// the three known artifacts, and it must NOT be able to silence anything else. A list that can
// swallow a genuine failure is worse than no list, because it looks like coverage.

/** The exact shape `classifySweep` consumes, so the fixtures below cannot drift from the real one. */
const failed = { failed: true, output: "" };
const passed = { failed: false, output: "" };

test("a non-excluded suite that fails shifted IS reported — the list cannot swallow a real failure", () => {
  const { drifted, staleExclusions, ok } = classifySweep(
    new Map([
      ["post-fix-reverification", failed],
      ["sweep", passed],
    ]),
  );
  assert.equal(ok, false);
  assert.deepEqual(drifted.map((d) => d.suite), ["post-fix-reverification"]);
  assert.deepEqual(staleExclusions, []);
});

test("an excluded artifact that STILL fails is silent — that is the entry doing its job", () => {
  const { drifted, staleExclusions, ok } = classifySweep(
    new Map([...CLOCK_ARTIFACTS.keys()].map((s) => [s, failed])),
  );
  assert.equal(ok, true, "the three known artifacts failing shifted is the expected steady state");
  assert.deepEqual(drifted, []);
  assert.deepEqual(staleExclusions, []);
});

test("an excluded artifact that becomes IMMUNE surfaces as a STALE entry, carrying its reason", () => {
  // The rot check. If `emissions` stops failing shifted, the mechanism its exclusion cites no longer
  // holds and the entry must not sit there silently widening the blind spot.
  const { staleExclusions, drifted, ok } = classifySweep(
    new Map([
      ["emissions", passed],
      ["prune-liveness", failed],
      ["serve.glance", failed],
    ]),
  );
  assert.equal(ok, false, "a rotted exclusion must fail the sweep, not pass quietly");
  assert.deepEqual(drifted, [], "a stale exclusion is not a drift — they are different findings");
  assert.equal(staleExclusions.length, 1);
  assert.equal(staleExclusions[0].suite, "emissions");
  assert.match(
    staleExclusions[0].reason,
    /REAL on-disk ledger/,
    "the report must carry WHY it was excluded, or nobody can judge whether removing it is right",
  );
});

test("every exclusion reason names a MECHANISM — 'flaky' is not a reason", () => {
  assert.ok(CLOCK_ARTIFACTS.size > 0 && SPAWN_REACHING.size > 0, "a vacuous list would make this assertion meaningless");
  for (const [suite, reason] of [...CLOCK_ARTIFACTS, ...SPAWN_REACHING]) {
    assert.ok(reason.length >= 40, `${suite}'s reason is too thin to be a mechanism: ${reason}`);
    assert.doesNotMatch(reason, /^\s*(flaky|todo|tbd|unstable)\b/i, `${suite} has a placeholder reason`);
  }
});

// ── THE SPAWN GUARD. Not "they happen not to match the derivation today" — that is a coincidence a
// future edit to the derivation would silently revoke.

test("none of the six spawn-reaching suites can ever be in the run set", () => {
  const six = [...SPAWN_REACHING.keys()];
  assert.equal(six.length, 6);

  // (a) Subtracted from whatever the derivation produces, even if the derivation later widens to
  //     include them — this is the property, not the coincidence.
  const runnable = runnableCandidates([...deriveCandidates(), ...six]);
  for (const s of six) {
    assert.ok(!runnable.includes(s), `${s} reached the run set — it spawns a real paid worker`);
  }

  // (b) And they are not in today's derived population either, so the subtraction is defence in
  //     depth rather than the only line.
  const derived = deriveCandidates();
  for (const s of six) assert.ok(!derived.includes(s), `${s} is in the derived candidate set`);
});

test("the derived population is non-trivial and includes the suites the real outage touched", () => {
  const derived = deriveCandidates();
  assert.ok(derived.length >= 40, `expected a real population, got ${derived.length}`);
  // The suite the 2026-08-02 outage actually broke must be swept, or this instrument would have
  // missed the one incident it exists to catch.
  assert.ok(derived.includes("post-fix-reverification"), "the #1116 suite must be in the sweep");
});

test("failingTitles extracts the failing test names a report must name", () => {
  const tap = ["ok 1 - fine", "not ok 2 - a disposition flipped to stale", "not ok 3 - second one", "# fail 2"].join("\n");
  assert.deepEqual(failingTitles(tap), ["a disposition flipped to stale", "second one"]);
  assert.deepEqual(failingTitles("ok 1 - all good\n# fail 0"), [], "a green run names nothing");
});

test("the shift is a single large value — a second shorter shift would add cost, not signal", () => {
  // Pinned so a future 'let us also run +30d' edit has to argue with this: anything a smaller shift
  // catches, a larger one catches too, and the measured false-flag rate at +400d across the whole
  // population was zero.
  assert.equal(SWEEP_SHIFT_DAYS, 400);
});
