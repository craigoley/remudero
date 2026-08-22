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

const mod = (await import(SWEEP_URL)) as {
  CLOCK_ARTIFACTS: ReadonlyMap<string, string>;
  SPAWN_REACHING: ReadonlyMap<string, string>;
  SWEEP_SHIFT_DAYS: number;
  classifySweep: (
    results: Map<string, { failed: boolean; output?: string }>,
    artifacts?: ReadonlyMap<string, string>,
  ) => { drifted: Array<{ suite: string }>; staleExclusions: Array<{ suite: string; reason: string }>; ok: boolean };
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
    log?: (m: string) => void;
    write?: (m: string) => void;
  }) => number;
};
const {
  CLOCK_ARTIFACTS,
  SPAWN_REACHING,
  SWEEP_SHIFT_DAYS,
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
