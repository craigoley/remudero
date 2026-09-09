import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
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

const mod = (await import(SWEEP_URL)) as {
  CLOCK_ARTIFACTS: ReadonlyMap<string, string>;
  SPAWN_REACHING: ReadonlyMap<string, string>;
  SWEEP_SHIFT_DAYS: number;
  DRIFT_CEILING: number;
  DRIFT_BASELINE: { _comment: string; driftCeiling: number; driftingSuitesAtCapture?: string[] };
  classifySweep: (
    results: Map<string, { failed: boolean; output?: string }>,
    artifacts?: ReadonlyMap<string, string>,
    ceiling?: number,
    recorded?: string[],
  ) => {
    drifted: Array<{ suite: string }>;
    newDrift: Array<{ suite: string }>;
    staleExclusions: Array<{ suite: string; reason: string }>;
    ceiling: number;
    ok: boolean;
  };
  deriveCandidates: (testDir?: string) => string[];
  failingTitles: (output: string) => string[];
  firstFailureDetail: (output: string) => string;
  runnableCandidates: (candidates: string[]) => string[];
  runSuite: (
    suite: string,
    days: number,
    exec?: (file: string, args: string[], opts: { env: Record<string, string> }) => string,
  ) => { failed: boolean; output: string };
  bisectFuse: (
    suite: string,
    run?: (suite: string, days: number) => { failed: boolean; output?: string },
  ) => number | null;
  main: (opts?: {
    argv?: string[];
    run?: (suite: string, days: number) => { failed: boolean; output?: string };
    derive?: () => string[];
    ceiling?: number;
    recorded?: string[];
    log?: (m: string) => void;
    write?: (m: string) => void;
  }) => number;
};
const {
  CLOCK_ARTIFACTS,
  SPAWN_REACHING,
  SWEEP_SHIFT_DAYS,
  DRIFT_CEILING,
  DRIFT_BASELINE,
  classifySweep,
  deriveCandidates,
  failingTitles,
  firstFailureDetail,
  runnableCandidates,
  runSuite,
  bisectFuse,
  main,
} = mod;

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
  // Pinned at ceiling 0 (W1-T1128): this fixture's whole point is that the ONE real failure
  // cannot be swallowed, independent of whatever the real recorded ceiling happens to be today.
  const { drifted, staleExclusions, ok } = classifySweep(
    new Map([
      ["post-fix-reverification", failed],
      ["sweep", passed],
    ]),
    CLOCK_ARTIFACTS,
    0,
    SYNTHETIC_RECORDED,
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
  // The rot check, kept GENERIC over whichever suites CLOCK_ARTIFACTS currently names (W1-T1104
  // removed `emissions` — measured passing shifted — so this must not pin that literal name; the
  // property is "the FIRST artifact going immune is reported stale", not which suite it is today).
  const [immuneSuite, ...stillFailingSuites] = [...CLOCK_ARTIFACTS.keys()];
  const results = new Map<string, { failed: boolean; output: string }>([[immuneSuite, passed]]);
  for (const s of stillFailingSuites) results.set(s, failed);
  const { staleExclusions, drifted, ok } = classifySweep(results);
  assert.equal(ok, false, "a rotted exclusion must fail the sweep, not pass quietly");
  assert.deepEqual(drifted, [], "a stale exclusion is not a drift — they are different findings");
  assert.equal(staleExclusions.length, 1);
  assert.equal(staleExclusions[0].suite, immuneSuite);
  assert.equal(
    staleExclusions[0].reason,
    CLOCK_ARTIFACTS.get(immuneSuite),
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

// ── THE DRIFT CEILING (W1-T1128). `classifySweep` used to require `drifted.length === 0` --
// ABSOLUTE cleanliness -- a bound the real workflow has never once satisfied (9 runs: 4 failure /
// 5 cancelled / 0 success, across both its `pull_request` and `schedule` triggers). It is now a
// RATCHET against the recorded ceiling in scripts/clock-sweep-baseline.json, the same shape
// scripts/coverage-baseline.json and scripts/mutation-baseline.json already use: a run that does
// not REGRESS past the recorded figure is green. Every test below pins its OWN ceiling rather than
// reading the real DRIFT_CEILING, so these stay meaningful however the real baseline is ratcheted.

// W1-T3276 — the ceiling cases below use synthetic suite names and exist to pin the COUNT relation
// (over / at / under). They now declare those names as RECORDED, so each stays a statement about
// the ceiling rather than accidentally becoming a statement about new drift, which has its own
// cases at the end of this file.
const SYNTHETIC_RECORDED = ["a", "b", "c", "d", "e", "f", "g", "h", "learnings", "alpha", "one", "two", "three"];

test("a sweep whose drifting-suite count is at the recorded ceiling exits clean", () => {
  const { drifted, ok } = classifySweep(
    new Map([
      ["a", failed],
      ["b", failed],
      ["c", passed],
    ]),
    CLOCK_ARTIFACTS,
    2,
    SYNTHETIC_RECORDED,
  );
  assert.equal(drifted.length, 2);
  assert.equal(ok, true, "drifted.length === ceiling is NOT a regression and must exit clean");
});

test("a sweep that drifts further than the ceiling still fails", () => {
  const { drifted, ok } = classifySweep(
    new Map([
      ["a", failed],
      ["b", failed],
      ["c", failed],
    ]),
    CLOCK_ARTIFACTS,
    2,
    SYNTHETIC_RECORDED,
  );
  assert.equal(drifted.length, 3);
  assert.equal(ok, false, "drifted.length > ceiling IS a regression and must fail");
});

test("a sweep with fewer drifting suites than the ceiling exits clean and says so", () => {
  const lines: string[] = [];
  const code = main({
    argv: [],
    derive: () => ["learnings"],
    run: () => ({ failed: true, output: "not ok 1 - a fixture date goes stale\n" }),
    ceiling: 5,
    recorded: SYNTHETIC_RECORDED,
    log: (m) => lines.push(m),
    write: () => {},
  });
  assert.equal(code, 0, "one drifting suite under a ceiling of 5 must still exit clean");
  const out = lines.join("\n");
  assert.match(out, /BELOW CEILING/, "an improvement over the ceiling must be called out, not folded into a plain PASS");
  assert.match(out, /ceiling of 5/);
  assert.match(out, /^PASS — /m, "still a PASS -- exiting clean must read as clean");
});

test("a sweep whose drifting-suite count exactly matches the ceiling exits clean and says AT CEILING", () => {
  // The third relation (W1-T1128): neither an improvement (BELOW) nor a regression (OVER), so it
  // gets its own line rather than being folded into either neighbor.
  const lines: string[] = [];
  const code = main({
    argv: [],
    derive: () => ["learnings"],
    run: () => ({ failed: true, output: "not ok 1 - a fixture date goes stale\n" }),
    ceiling: 1,
    recorded: SYNTHETIC_RECORDED,
    log: (m) => lines.push(m),
    write: () => {},
  });
  assert.equal(code, 0, "drifted.length === ceiling is NOT a regression and must exit clean");
  const out = lines.join("\n");
  assert.match(out, /AT CEILING/, "matching the ceiling exactly must be named, not folded into BELOW or OVER");
  assert.match(out, /ceiling of 1/);
  assert.doesNotMatch(out, /BELOW CEILING/);
  assert.doesNotMatch(out, /OVER CEILING/);
  assert.match(out, /^PASS — /m, "still a PASS -- exiting clean must read as clean");
});

test("the recorded ceiling carries the rule that it may fall and must never rise", () => {
  // Reads the REAL committed baseline directly (same idiom as
  // test/claude-md-budget-ratchet.test.ts's "the real baseline carries ZERO headroom" test), so
  // this fails the moment the file's own rule is weakened or dropped, not just when the exported
  // constant drifts from it.
  const baseline = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clock-sweep-baseline.json"), "utf8"),
  );
  assert.equal(typeof baseline.driftCeiling, "number");
  assert.ok(baseline.driftCeiling >= 0);
  assert.equal(baseline.driftCeiling, DRIFT_CEILING, "the module must read the SAME file this test does");
  assert.equal(baseline._comment, DRIFT_BASELINE._comment);
  assert.match(baseline._comment, /never/i, "the comment must state the rule, not just carry a number");
  assert.match(baseline._comment, /rais(e|ed)/i, "must name the forbidden direction");
  assert.match(baseline._comment, /fall/i, "must name the permitted direction");
});

test("a stale exclusion still fails regardless of the drift ceiling", () => {
  // GENERIC over whichever suite CLOCK_ARTIFACTS currently names first (the same reason the
  // "becomes IMMUNE" test above reads `[...CLOCK_ARTIFACTS.keys()]` rather than a literal name):
  // W1-T1104 already removed `emissions` from the map once (measured passing shifted in CI), so a
  // test pinned to that literal name would fail the moment the map's membership moves, for a
  // reason that has nothing to do with the property under test here — a ceiling never forgiving a
  // stale exclusion. A ceiling of 100 is deliberately far above any plausible drift count, so a
  // pass here could ONLY come from the ceiling wrongly forgiving a stale exclusion.
  const [anyArtifact] = CLOCK_ARTIFACTS.keys();
  const { staleExclusions, drifted, ok } = classifySweep(new Map([[anyArtifact, passed]]), CLOCK_ARTIFACTS, 100);
  assert.equal(drifted.length, 0);
  assert.equal(staleExclusions.length, 1);
  assert.equal(ok, false, "a stale exclusion must fail even under a wildly generous ceiling");
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

test("firstFailureDetail carries the raw diagnostic block of the FIRST failing test — a title alone cannot tell an assertion mismatch from an unrelated throw", () => {
  const tap = [
    "TAP version 13",
    "ok 1 - fine",
    "not ok 2 - a disposition flipped to stale",
    "  ---",
    "  duration_ms: 3.5",
    "  error: 'ENOENT: no such file or directory'",
    "  code: 'ERR_TEST_FAILURE'",
    "  ...",
    "not ok 3 - second one",
    "  ---",
    "  error: 'a different failure entirely'",
    "  ...",
  ].join("\n");
  const detail = firstFailureDetail(tap);
  assert.match(detail, /^not ok 2 - a disposition flipped to stale$/m, "starts at the first failing line");
  assert.match(detail, /ENOENT: no such file or directory/, "carries the first failure's own diagnostic");
  assert.doesNotMatch(detail, /a different failure entirely/, "stops before the SECOND failing test's block");
});

test("firstFailureDetail is empty on a green run — nothing to name", () => {
  assert.equal(firstFailureDetail("ok 1 - all good\n# fail 0"), "");
});

test("the shift is a single large value — a second shorter shift would add cost, not signal", () => {
  // Pinned so a future 'let us also run +30d' edit has to argue with this: anything a smaller shift
  // catches, a larger one catches too, and the measured false-flag rate at +400d across the whole
  // population was zero.
  assert.equal(SWEEP_SHIFT_DAYS, 400);
});

// ── The orchestration half. Every collaborator is injected, so these exercise the real runner,
// bisector and report WITHOUT spawning a single child process — which matters because each suite
// the sweep runs is a real test file, so an un-injectable runner would make covering this cost a
// full sweep (tens of minutes).

// Recorders, deliberately SHARED across the tests below rather than written inline per test. A
// test whose whole point is "this collaborator is never called" cannot cover its own inline
// closure — the body is unreachable by construction — so an inline stub leaves permanently
// uncovered added lines. Hoisting them means the bodies are exercised by the tests that DO call
// them, and the non-invocation assertion reads a counter instead.
function runRecorder(result: (suite: string, days: number) => { failed: boolean; output?: string } = () => ({ failed: false })) {
  const calls: Array<{ suite: string; days: number }> = [];
  return {
    calls,
    run: (suite: string, days: number) => {
      calls.push({ suite, days });
      return result(suite, days);
    },
  };
}

function deriveRecorder(suites: string[]) {
  const state = { called: 0 };
  return {
    state,
    derive: () => {
      state.called += 1;
      return suites;
    },
  };
}

test("runSuite reports success and swallows no output when the child exits 0", () => {
  const seen: Array<{ file: string; days: string }> = [];
  const r = runSuite("emissions", 400, (file, _args, opts) => {
    seen.push({ file, days: opts.env.FK_SHIFT_DAYS });
    return "";
  });
  assert.deepEqual(r, { failed: false, output: "" });
  assert.equal(seen[0].days, "400", "the shift must reach the child as FK_SHIFT_DAYS");
});

test("runSuite captures BOTH stdout and stderr from a failing child, so the report can name tests", () => {
  const r = runSuite("emissions", 400, () => {
    const e = new Error("child failed") as Error & { stdout: string; stderr: string };
    e.stdout = "not ok 1 - a drifting title\n";
    e.stderr = "AssertionError\n";
    throw e;
  });
  assert.equal(r.failed, true);
  assert.match(r.output, /not ok 1 - a drifting title/);
  assert.match(r.output, /AssertionError/, "stderr must not be dropped -- node prints diffs there");
});

test("runSuite passes the shift for whatever rung it is asked about, not a hardcoded 400", () => {
  const days: string[] = [];
  runSuite("emissions", 7, (_f, _a, opts) => {
    days.push(opts.env.FK_SHIFT_DAYS);
    return "";
  });
  assert.deepEqual(days, ["7"]);
});

test("bisectFuse returns the SMALLEST rung that already fails, not the first tried", () => {
  // Fails from +30 onward: the operator needs the tightest bound, or the fuse reads longer than it is.
  const fuse = bisectFuse("x", (_s, days) => ({ failed: days >= 30 }));
  assert.equal(fuse, 30);
});

test("bisectFuse returns null when no rung fails, so the report says 'only at the full shift'", () => {
  assert.equal(bisectFuse("x", () => ({ failed: false })), null);
});

test("main --list prints the plan and runs nothing at all", () => {
  const lines: string[] = [];
  const r = runRecorder();
  const d = deriveRecorder(["emissions", "mounts-wiring"]);
  const code = main({ argv: ["--list"], derive: d.derive, run: r.run, log: (m) => lines.push(m), write: () => {} });
  assert.equal(code, 0);
  assert.equal(r.calls.length, 0, "--list must never execute a suite");
  assert.equal(d.state.called, 1, "the plan still comes from the real derivation");
  assert.match(lines.join("\n"), /will run\s+: 1/, "the spawn-reaching suite must be subtracted");
});

test("main returns 0 and reports the immune count from what actually RAN", () => {
  const lines: string[] = [];
  const code = main({
    argv: [],
    derive: () => ["emissions", "learnings"],
    run: (s) => ({ failed: CLOCK_ARTIFACTS.has(s) }), // artifacts fail as expected; others pass
    log: (m) => lines.push(m),
    write: () => {},
  });
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /^PASS — /m);
  assert.ok(!/-\d+ suite\(s\) immune/.test(out), "the immune count must never go negative");
});

test("main returns 1 on drift and names the suite, the failing test, the fuse and a reproduce line", () => {
  const lines: string[] = [];
  const code = main({
    argv: [],
    derive: () => ["learnings"],
    run: (_s, days) => ({
      failed: days >= 14,
      output: "not ok 1 - a fixture date goes stale\n",
    }),
    ceiling: 0, // pinned (W1-T1128): this fixture's ONE drift must still block at a zero ceiling.
    log: (m) => lines.push(m),
    write: () => {},
  });
  assert.equal(code, 1, "drift must exit non-zero or the workflow never notifies");
  const out = lines.join("\n");
  assert.match(out, /WALL-CLOCK DRIFT/);
  assert.match(out, /test\/learnings\.test\.ts/);
  assert.match(out, /fails by\s+: \+14 days/, "the fuse must be the tightest failing rung");
  assert.match(out, /failing test\s+: a fixture date goes stale/);
  assert.match(out, /reproduce\s+: FK_SHIFT_DAYS=14 node --test/);
});

test("main reports a STALE EXCLUSION when a listed clock artifact starts passing shifted", () => {
  const lines: string[] = [];
  const artifact = [...CLOCK_ARTIFACTS.keys()][0];
  const code = main({
    argv: [],
    derive: () => [artifact],
    run: () => ({ failed: false }), // the artifact no longer fails -- its stated mechanism is gone
    log: (m) => lines.push(m),
    write: () => {},
  });
  assert.equal(code, 1, "a stale exclusion must block: it is silently shrinking coverage");
  assert.match(lines.join("\n"), /STALE EXCLUSIONS/);
  assert.match(lines.join("\n"), new RegExp(`test/${artifact}\\.test\\.ts`));
});

test("main emits per-suite progress as it goes, so a long sweep is distinguishable from a hang", () => {
  const written: string[] = [];
  // Uses the SHARED recorders, which is what makes their bodies covered for the two
  // never-invoked assertions above and below.
  const r = runRecorder();
  const d = deriveRecorder(["emissions", "learnings"]);
  main({ argv: [], derive: d.derive, run: r.run, log: () => {}, write: (m) => written.push(m) });
  assert.equal(written.length, 2, "one progress line per suite actually run");
  assert.deepEqual(r.calls.map((c) => c.suite), ["emissions", "learnings"]);
  assert.equal(r.calls[0].days, SWEEP_SHIFT_DAYS, "the sweep runs at the full shift");
  assert.match(written[0], /\[\s*1\/2\]/);
});

test("main routes --only through the spawn guard, so even an explicit spawn suite runs nothing", () => {
  const spawnSuite = [...SPAWN_REACHING.keys()][0];
  const r = runRecorder();
  const d = deriveRecorder(["should-not-be-consulted"]);
  const code = main({ argv: ["--only", spawnSuite], derive: d.derive, run: r.run, log: () => {}, write: () => {} });
  assert.equal(r.calls.length, 0, "a paid spawn must be unreachable even when named explicitly");
  assert.equal(d.state.called, 0, "--only must not consult the derivation at all");
  assert.equal(code, 0);
});

// ── W1-T3276 — THE RATCHET COUNTED DRIFT INSTEAD OF NAMING IT ────────────────────────────────────
//
// `clock-sweep` reported SUCCESS on 2026-09-07 over a tree already carrying the fixture that took
// `main` red on 2026-09-09 (W1-T3270). The suite was a derived candidate, in `--list`, and in
// neither exclusion set — it was simply forgiven by a COUNT. The baseline records the eleven
// drifting suites BY NAME and nothing read them.

const RECORDED = ["alpha", "beta", "gamma"];
const CEILING = 3;
const drifting = (...names: string[]) => new Map(names.map((n) => [n, { failed: true }]));

test("W1-T3276: a NEW drifting suite fails the sweep even under the ceiling", () => {
  // THE MEASURED SHAPE: one recorded suite repaired, one brand-new bomb arrives, total unchanged.
  // Before this change that was `ok: true` with the new suite sitting IN the drifted list, unread.
  const r = mod.classifySweep(drifting("alpha", "beta", "stale-ci-gate-wiring"), new Map(), CEILING, RECORDED);
  assert.equal(r.drifted.length, 3, "the count is AT the ceiling, which used to be enough to pass");
  assert.deepEqual(r.newDrift.map((d) => d.suite), ["stale-ci-gate-wiring"], "the stranger must be named");
  assert.equal(r.ok, false, "a suite that STARTED drifting is a regression at any count");
});

test("W1-T3276: the recorded backlog is still forgiven up to the ceiling — W1-T1128 is preserved, not undone", () => {
  // The ceiling exists because `drifted.length === 0` had never once been satisfiable, so the job
  // was permanently red and told nobody anything. This task must not put it back there.
  const r = mod.classifySweep(drifting(...RECORDED), new Map(), CEILING, RECORDED);
  assert.equal(r.drifted.length, CEILING);
  assert.equal(r.newDrift.length, 0, "every drifting suite is one the baseline already records");
  assert.equal(r.ok, true, "the recorded backlog must still pass, or the gate is red forever again");
});

test("W1-T3276: a wholly different drifting population is refused — the ceiling can no longer be met by strangers", () => {
  // The extreme the old bound permitted: every recorded suite repaired, an equal number of NEW ones
  // drifting, and a green verdict over a set sharing not one member with the captured population.
  const r = mod.classifySweep(drifting("new-one", "new-two", "new-three"), new Map(), CEILING, RECORDED);
  assert.equal(r.drifted.length, CEILING, "still exactly at the ceiling");
  assert.equal(r.newDrift.length, 3);
  assert.equal(r.ok, false);
});

test("W1-T3276: a repaired suite is not drift — fixing one must never fail the sweep", () => {
  // The inverse guard. A recorded suite that now PASSES shifted is an improvement, not a
  // regression, and must not be reported as either drift or new drift.
  const r = mod.classifySweep(drifting("alpha"), new Map(), CEILING, RECORDED);
  assert.equal(r.drifted.length, 1);
  assert.equal(r.newDrift.length, 0);
  assert.equal(r.ok, true, "drift going DOWN is the outcome this gate wants");

  const clean = mod.classifySweep(new Map(), new Map(), CEILING, RECORDED);
  assert.equal(clean.ok, true, "and a fully repaired tree passes");
});

test("W1-T3276: the report names NEW drift separately, because a total is not actionable", () => {
  // "12 suites drifted" sends an operator to a list; "one NEW suite drifted" sends them to a fix.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clock-sweep.mjs"), "utf8");
  assert.match(src, /NEW DRIFT — \$\{newDrift\.length\}/, "the report must have its own NEW DRIFT section");
  assert.ok(
    src.indexOf("NEW DRIFT —") < src.indexOf("OVER CEILING —"),
    "and it must lead, ahead of the ceiling comparison an operator can already read",
  );
});

test("W1-T3276: the shipped baseline still records the names the ratchet now reads", () => {
  // THE WIRE THAT MAKES THIS REAL. The identity check is only as good as the recorded set; if a
  // future edit drops `driftingSuitesAtCapture`, `classifySweep` falls back to an EMPTY set and
  // every drifting suite becomes "new" — loud, not silent, but this pins the intended shape.
  const recorded = mod.DRIFT_BASELINE.driftingSuitesAtCapture;
  assert.ok(Array.isArray(recorded), "the baseline must carry the drifting suites by name");
  assert.equal(
    recorded!.length,
    mod.DRIFT_CEILING,
    "and the recorded names must match the ceiling they justify — a ceiling above its own list forgives strangers by that margin",
  );
});
