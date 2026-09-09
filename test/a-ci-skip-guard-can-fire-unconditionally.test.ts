// W1-T3220 - A ci.yml SKIP GUARD CAN FIRE UNCONDITIONALLY AND EVERY CHECK STAYS GREEN.
//
// MEASURED 2026-09-08 on #4733: mutating the `ci` job's source-skip guard to a constant-true
// condition left all 54 assertions across test/workflow-single-suite-run.test.ts,
// test/push-ci-on-main.test.ts and test/fast-lane-classifier.test.ts GREEN, while that mutant
// leaves a push to main with no test run at all (coverage-ratchet is PR-only, W1-T1033). Nothing
// covers this class: `stryker.conf.json`'s `mutate` list is exactly ["src/lib/classify.ts"] and
// Stryker mutates JavaScript, not shell inside YAML.
//
// Run over the real ci.yml at the time of writing: 14 skip-shaped guards, 4 covered, 10 uncovered.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// @ts-expect-error — this executable .mjs intentionally has no declaration output; the complete
// seam consumed by this TypeScript suite is declared immediately below rather than left as any.
import * as workflowGuard from "../scripts/workflow-guard-mutation-ratchet.mjs";

interface SkipGuard {
  key: string;
  job: string;
  line: number;
  text: string;
  form: "if" | "or";
}

interface GuardResult {
  covered: boolean;
  by: string | undefined;
}

const { enumerateSkipGuards, mutateGuardLine, ciReadingSuites, classifyGuard, redCorpus, OWN_SUITE } =
  workflowGuard as {
  enumerateSkipGuards(text: string): SkipGuard[];
  mutateGuardLine(text: string, guard: SkipGuard): string;
  ciReadingSuites(root?: string): string[];
  classifyGuard(
    guard: SkipGuard,
    original: string,
    suites: string[],
    runSuite?: (suite: string) => { failed: boolean | undefined; out?: string },
    apply?: (guard: SkipGuard, original: string, fn: () => GuardResult) => GuardResult,
  ): GuardResult;
  redCorpus(
    suites: string[],
    runSuite?: (suite: string) => { failed: boolean | undefined; out?: string },
  ): Array<{ suite: string; why: string }>;
  OWN_SUITE: string;
};

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CI_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const BASELINE = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "workflow-guard-mutation-baseline.json"), "utf8")) as {
  guards: Record<string, { reason: string }>;
};

/** A mutant-free `withMutant` stand-in: never touches disk, still proves the mutation was formed. */
const inMemory = (guard: SkipGuard, original: string, fn: () => GuardResult): GuardResult => {
  mutateGuardLine(original, guard); // must not throw - the same precondition the real path enforces
  return fn();
};

test("W1-T3220: the guards are enumerated from the real ci.yml at run time, not from a recorded list", () => {
  const guards = enumerateSkipGuards(CI_YML);
  assert.ok(guards.length > 0, "the enumerator must find the workflow's own skip guards");
  for (const g of guards) {
    // Every guard must point at a line that IS that guard - the property a frozen list loses the
    // moment anyone inserts a line above it.
    assert.equal(CI_YML.split("\n")[g.line - 1], g.text, `guard ${g.key} does not match ci.yml:${g.line}`);
    assert.match(g.key, /^[^#]+#\d+: /, "a key must carry its job and occurrence, never a bare line number");
  }
  const keys = guards.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length, "keys must be unique, or a baseline entry covers two guards");
});

test("W1-T3220: a guard added to the workflow is enumerated with no registry edit", () => {
  const before = enumerateSkipGuards(CI_YML).length;
  const withNewGuard = CI_YML.replace(
    "jobs:",
    'jobs:\n  # synthetic\n  invented-job:\n    steps:\n      - run: |\n          if [ "$X" = "1" ]; then\n            echo skipping\n            exit 0\n          fi\n',
  );
  const after = enumerateSkipGuards(withNewGuard);
  assert.equal(after.length, before + 1, "a guard added to the tree must be found by the run that adds it");
  assert.ok(
    after.some((g) => g.job === "invented-job"),
    "and attributed to its own job, so its baseline key does not collide with another job's",
  );
});

test("W1-T3220: only skip-shaped guards count - a conditional whose block cannot exit 0 is not one", () => {
  const notASkip = 'jobs:\n  j:\n    steps:\n      - run: |\n          if [ "$X" = "1" ]; then\n            echo "just a branch"\n          fi\n';
  assert.deepEqual(enumerateSkipGuards(notASkip), [], "an always-true condition here fails loudly, not silently");
  const isASkip = 'jobs:\n  j:\n    steps:\n      - run: |\n          if [ "$X" = "1" ]; then\n            exit 0\n          fi\n';
  assert.equal(enumerateSkipGuards(isASkip).length, 1);
});

test("W1-T3220: the mutation rewrites exactly one line, identified by index, and refuses anything wider", () => {
  // THE FALSIFIER'S OWN TRAP, pinned as a test. `[ -n "${GITHUB_BASE_REF}" ]` occurs three times in
  // ci.yml; during the session that filed this task a replace-first mutation hit line 131 instead
  // of 205, reddened an unrelated case, and left the guard under test intact - so a new test
  // appeared to survive a falsifier it had never been given.
  const repeated = enumerateSkipGuards(CI_YML).filter(
    (g, _i, all) => all.filter((o) => o.text === g.text).length > 1,
  );
  assert.ok(repeated.length > 1, "ci.yml must still contain repeated guard text, or this case proves nothing");
  for (const guard of repeated) {
    const before = CI_YML.split("\n");
    const after = mutateGuardLine(CI_YML, guard).split("\n");
    const changed = after.flatMap((l, i) => (l === before[i] ? [] : [i + 1]));
    assert.deepEqual(changed, [guard.line], `mutating ${guard.key} must touch only ci.yml:${guard.line}`);
    assert.equal(after.length, before.length, "the file must not gain or lose lines");
  }
});

test("W1-T3220: a guard whose recorded line no longer holds it is refused, never mutated blind", () => {
  const [guard] = enumerateSkipGuards(CI_YML);
  const shifted = { ...guard, line: guard.line + 1 };
  assert.throws(
    () => mutateGuardLine(CI_YML, shifted),
    /is not the guard it was enumerated as/,
    "a stale index must refuse rather than rewrite whatever happens to sit there",
  );
});

test("W1-T3220: both guard forms are mutated to ALWAYS SKIP, which means opposite constants", () => {
  // An `if` guard skips when its condition is true; an `[ .. ] || { .. }` guard skips when its
  // test is FALSE. Forcing both to "true" would leave the second one never skipping at all - the
  // mutant would be weaker than the original and every guard would read COVERED for the wrong reason.
  const ifGuard = 'jobs:\n  j:\n    steps:\n      - run: |\n          if [ "$X" = "1" ]; then\n            exit 0\n          fi\n';
  const orGuard = 'jobs:\n  j:\n    steps:\n      - run: |\n          [ "$X" = "1" ] || { echo skip; exit 0; }\n';
  assert.match(mutateGuardLine(ifGuard, enumerateSkipGuards(ifGuard)[0]), /if \[ "1" = "1" \]; then/);
  assert.match(mutateGuardLine(orGuard, enumerateSkipGuards(orGuard)[0]), /\[ "1" = "0" \] \|\| \{ echo skip; exit 0; \}/);
});

test("W1-T3220: a guard some suite notices is COVERED, and the first noticing suite is named", () => {
  const [guard] = enumerateSkipGuards(CI_YML);
  const seen: string[] = [];
  const run = (suite: string) => {
    seen.push(suite);
    return { failed: suite === "test/b.test.ts" };
  };
  const out = classifyGuard(guard, CI_YML, ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"], run, inMemory);
  assert.deepEqual(out, { covered: true, by: "test/b.test.ts" });
  assert.deepEqual(seen, ["test/a.test.ts", "test/b.test.ts"], "it must stop at the first suite that notices");
});

test("W1-T3220: a guard no suite notices is UNCOVERED - the whole finding, as a case", () => {
  const [guard] = enumerateSkipGuards(CI_YML);
  const out = classifyGuard(guard, CI_YML, ["test/a.test.ts", "test/b.test.ts"], () => ({ failed: false }), inMemory);
  assert.deepEqual(out, { covered: false, by: undefined });
});

test("W1-T3220: a suite that produced NO summary is not read as a pass", () => {
  // A killed or timed-out run prints the assertions it reached and no totals, so its failure set is
  // a subset by construction. Counting that as "did not fail" would let a guard read COVERED or
  // UNCOVERED on a run that never finished.
  const [guard] = enumerateSkipGuards(CI_YML);
  const out = classifyGuard(guard, CI_YML, ["test/truncated.test.ts"], () => ({ failed: undefined }), inMemory);
  assert.equal(out.covered, false, "absent totals must never be counted as a suite noticing the mutant");
});

test("W1-T3220: an already-failing suite makes the corpus RED, because it would make every guard read COVERED", () => {
  // THE FAILURE THIS RATCHET COMMITTED AGAINST ITSELF. classifyGuard calls a guard covered the
  // moment any suite fails under the mutant, and cannot tell "failed because of the mutant" from
  // "was already failing". MEASURED while building this: a stale baseline entry left THIS suite
  // red, it sorts first in the corpus, and a full re-seed reported "0 uncovered" against a tree
  // with ten. A vacuous pass, produced by the gate written to refuse vacuous passes.
  const red = redCorpus(["test/ok.test.ts", "test/broken.test.ts"], (s) => ({ failed: s === "test/broken.test.ts" }));
  assert.deepEqual(
    red.map((r) => r.suite),
    ["test/broken.test.ts"],
    "an already-failing suite must be named before any mutant is written",
  );
  assert.match(red[0].why, /already failing/);
});


test("W1-T3220: a suite that produced no summary makes the corpus RED too, never quietly green", () => {
  // A killed or timed-out suite proves nothing about the tree, and counting "no totals" as green
  // is the same mistake one level down from the control itself.
  const red = redCorpus(["test/truncated.test.ts"], () => ({ failed: undefined }));
  assert.equal(red.length, 1);
  assert.match(red[0].why, /no `# fail` summary/);
});


test("W1-T3220: a green corpus produces no refusal, so the control does not block an ordinary run", () => {
  assert.deepEqual(redCorpus(["test/a.test.ts", "test/b.test.ts"], () => ({ failed: false })), []);
});


test("W1-T3220: this suite is NOT in its own corpus, or it would fake coverage for every guard", () => {
  // It asserts the guard INVENTORY, so it fails under ANY mutation of ANY guard - including a
  // correct edit. Left in the corpus it "distinguishes" all sixteen mutants while testing no
  // behaviour at all. MEASURED: a re-seed with it included read 14 covered / 2 uncovered where the
  // honest figure was 4 / 10. The general hazard is a purely structural suite over ci.yml's text
  // reacting to the edit rather than to what the guard does.
  const corpus = ciReadingSuites(REPO_ROOT);
  assert.ok(!corpus.includes(OWN_SUITE), `${OWN_SUITE} must not measure itself`);
  assert.ok(corpus.length > 10, "and excluding it must not empty the corpus");
});

test("W1-T3220: every baselined guard carries a real recorded reason and still exists in ci.yml", () => {
  const keys = new Set(enumerateSkipGuards(CI_YML).map((g) => g.key));
  const recorded = Object.entries(BASELINE.guards);
  assert.ok(recorded.length > 0, "the baseline must record the guards this landed uncovered, or it claims a clean tree");
  for (const [key, entry] of recorded) {
    assert.ok(keys.has(key), `baselined guard is no longer in ci.yml: ${key} - a stale entry silently exempts nothing`);
    assert.ok(
      typeof entry.reason === "string" && entry.reason.length > 60,
      `baselined guard ${key} must record WHY, not merely that it is exempt`,
    );
    assert.doesNotMatch(
      entry.reason,
      /RECORDED UNMEASURED/,
      `baselined guard ${key} still carries --seed's placeholder; a reviewer must read a decision, not a to-do`,
    );
  }
});

test("W1-T3220: the corpus includes an UNSTAGED suite, because that is the one a new guard ships with", () => {
  // `git grep` reads the INDEX. A suite added in the very commit that adds a guard is invisible to
  // it until staged — and this check exists to ask whether that new guard is covered, usually by
  // exactly that new suite. An under-counted corpus reports UNCOVERED for want of a reader rather
  // than for want of coverage. MEASURED while building this: 35 without the flag, 36 with it.
  const probe = join(REPO_ROOT, "test", "zz-w1t3220-untracked-probe.test.ts");
  const before = ciReadingSuites(REPO_ROOT).length;
  writeFileSync(probe, 'import { test } from "node:test";\n// reads .github/workflows/ci.yml\ntest("probe", () => {});\n');
  try {
    assert.equal(
      ciReadingSuites(REPO_ROOT).length,
      before + 1,
      "an unstaged suite naming the workflow must be in the corpus",
    );
  } finally {
    rmSync(probe, { force: true });
  }
  assert.equal(ciReadingSuites(REPO_ROOT).length, before, "and the probe must leave the corpus as it found it");
});

test("W1-T3220: the ci.yml-reading suites are found from the tree, and this suite is one of them", () => {
  const suites = ciReadingSuites(REPO_ROOT);
  assert.ok(suites.length > 10, `expected a real corpus of ci.yml-reading suites, got ${suites.length}`);
  assert.ok(
    suites.includes("test/push-ci-on-main.test.ts"),
    "the suite that distinguishes four of the four covered guards must be in the corpus",
  );
  for (const s of suites) assert.match(s, /^test\/.*\.test\.ts$/);
});

// ── THE RATCHET'S OWN VERDICTS, DRIVEN ─────────────────────────────────────────────────────────
//
// Every refusal below is a verdict about the tree, and a verdict nothing can drive is a verdict
// nobody has shown works. `main`'s `io` seam exists for that; omitted, every field is the real one.

const CI_FIXTURE = [
  "jobs:",
  "  j:",
  "    steps:",
  "      - run: |",
  '          if [ "$X" = "1" ]; then',
  "            exit 0",
  "          fi",
  "",
].join("\n");

function mainIo(over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const errs: string[] = [];
  const io = {
    readCi: () => CI_FIXTURE,
    readBaseline: () => ({ guards: {} }),
    suites: () => ["test/a.test.ts"],
    redCorpus: () => [],
    classify: () => ({ covered: true, by: "test/a.test.ts" }),
    writeBaseline: () => {},
    log: (m: string) => void out.push(m),
    err: (m: string) => void errs.push(m),
    ...over,
  };
  return { io, out, errs };
}

const runMain = (argv: string[], over: Record<string, unknown> = {}) => {
  const { io, out, errs } = mainIo(over);
  return { code: (workflowGuard as { main(a: string[], io: unknown): number }).main(argv, io), out, errs };
};

test("W1-T3220: --list prints every guard with its line and exits 0 without running a suite", () => {
  const { code, out } = runMain(["--list"], {
    classify: () => assert.fail("--list must not measure anything"),
    suites: () => assert.fail("--list must not enumerate the corpus"),
  });
  assert.equal(code, 0);
  assert.ok(out.some((l) => l.includes('if [ "$X" = "1" ]; then')), "each guard is named");
  assert.ok(out.some((l) => l.includes("1 skip-shaped guard(s)")), "and counted");
});

test("W1-T3220: a ci.yml the enumerator finds NO guard in FAILS — an empty read is a defect here, not a clean tree", () => {
  const { code, errs } = runMain([], { readCi: () => "jobs:\n  j:\n    steps: []\n" });
  assert.equal(code, 1, "zero guards means the enumerator is broken, and a broken detector must not pass");
  assert.ok(errs.some((e) => e.includes("a defect in this script, not a clean tree")));
});

test("W1-T3220: an EMPTY corpus FAILS rather than reporting every guard uncovered for want of a reader", () => {
  const { code, errs } = runMain([], { suites: () => [] });
  assert.equal(code, 1);
  assert.ok(errs.some((e) => e.includes("for want of a corpus, not for want of coverage")));
});

test("W1-T3220: a RED corpus refuses before a single mutant is written", () => {
  let mutated = 0;
  const { code, errs } = runMain([], {
    redCorpus: () => [{ suite: "test/b.test.ts", why: "is already failing" }],
    classify: () => {
      mutated += 1;
      return { covered: true, by: "x" };
    },
  });
  assert.equal(code, 1);
  assert.equal(mutated, 0, "the control must run BEFORE any mutation, or the refusal comes too late");
  assert.ok(errs.some((e) => e.includes("test/b.test.ts") && e.includes("REFUSING to measure")));
});

test("W1-T3220: an UNCOVERED guard blocks and is named with its ci.yml line", () => {
  const { code, errs, out } = runMain([], { classify: () => ({ covered: false, by: undefined }) });
  assert.equal(code, 1);
  assert.ok(errs.some((e) => e.includes("ci.yml:5") && e.includes("BLOCKED")), `expected a located refusal; got ${JSON.stringify(errs)}`);
  assert.ok(out.some((l) => l.startsWith("UNCOVERED")));
});

test("W1-T3220: a BASELINED guard is skipped with its reason and never measured", () => {
  let measured = 0;
  const { code, out } = runMain([], {
    readBaseline: () => ({ guards: { 'j#1: if [ "$X" = "1" ]; then': { reason: "recorded, with a stated reason" } } }),
    classify: () => {
      measured += 1;
      return { covered: false, by: undefined };
    },
  });
  assert.equal(code, 0, "a recorded guard must not block");
  assert.equal(measured, 0, "nor cost a measurement");
  assert.ok(out.some((l) => l.includes("recorded, with a stated reason")), "the reason is printed, so a reader sees the decision");
});

test("W1-T3220: --all measures a baselined guard anyway and still exits 0 — a report, not a gate", () => {
  let measured = 0;
  const { code } = runMain(["--all"], {
    readBaseline: () => ({ guards: { 'j#1: if [ "$X" = "1" ]; then': { reason: "recorded" } } }),
    classify: () => {
      measured += 1;
      return { covered: false, by: undefined };
    },
  });
  assert.equal(measured, 1, "--all re-measures what the baseline exempts");
  assert.equal(code, 0, "and reports rather than blocking");
});

test("W1-T3220: --seed records the uncovered guards it found, with a placeholder reason a reviewer must replace", () => {
  let written = "";
  const { code } = runMain(["--seed"], {
    classify: () => ({ covered: false, by: undefined }),
    writeBaseline: (text: string) => {
      written = text;
    },
  });
  assert.equal(code, 0);
  const guards = (JSON.parse(written) as { guards: Record<string, { reason: string }> }).guards;
  assert.deepEqual(Object.keys(guards), ['j#1: if [ "$X" = "1" ]; then']);
  assert.match(guards[Object.keys(guards)[0]].reason, /RECORDED UNMEASURED/, "the placeholder must be obvious enough that shipping it is a choice");
});

test("W1-T3220: --seed never overwrites a reason someone already wrote", () => {
  let written = "";
  runMain(["--seed"], {
    readBaseline: () => ({ guards: { 'j#1: if [ "$X" = "1" ]; then': { reason: "a real, considered reason" } } }),
    classify: () => ({ covered: false, by: undefined }),
    writeBaseline: (text: string) => {
      written = text;
    },
  });
  assert.match(written, /a real, considered reason/, "re-seeding must not erase written reasons");
  assert.doesNotMatch(written, /RECORDED UNMEASURED/);
});

test("W1-T3220: a suite's verdict comes from its `# fail` line, and a run with no totals is UNKNOWN", () => {
  const { suiteVerdictFrom } = workflowGuard as { suiteVerdictFrom(out: string): boolean | undefined };
  assert.equal(suiteVerdictFrom("# tests 3\n# pass 3\n# fail 0\n"), false, "a green run did not notice the mutant");
  assert.equal(suiteVerdictFrom("# tests 3\n# pass 2\n# fail 1\n"), true, "a failing run did");
  assert.equal(
    suiteVerdictFrom("ok 1 - something\nok 2 - something else\n"),
    undefined,
    "a truncated run has no totals, and its failure set is a subset by construction — never read as green",
  );
});

test("W1-T3220: an unreadable baseline is an EMPTY one, not a crash", () => {
  const { readBaseline } = workflowGuard as { readBaseline(p: string, r: () => string): { guards: Record<string, unknown> } };
  assert.deepEqual(
    readBaseline("/nonexistent", () => {
      throw new Error("ENOENT");
    }),
    { guards: {} },
    "a ratchet that dies on its own record file cannot report the thing it exists to report",
  );
  assert.deepEqual(readBaseline("/x", () => "{ not json"), { guards: {} });
});

test("W1-T3220: withMutant restores the workflow even when the body throws", () => {
  const { withMutant } = workflowGuard as {
    withMutant(g: SkipGuard, o: string, fn: () => unknown, io: { path: string; write: (p: string, t: string) => void }): unknown;
  };
  const writes: string[] = [];
  const guard = enumerateSkipGuards(CI_FIXTURE)[0];
  assert.throws(() =>
    withMutant(guard, CI_FIXTURE, () => {
      throw new Error("a suite blew up mid-measurement");
    }, { path: "/tmp/x", write: (_p, t) => void writes.push(t) }),
  );
  assert.equal(writes.length, 2, "the mutant is written, then the original is written back");
  assert.equal(writes[1], CI_FIXTURE, "a crashed run must never leave a mutant on disk");
});

test("W1-T3220: a mutation that changes NOTHING is refused — a no-op mutant would read COVERED for free", () => {
  // The guard on the guard. If the rewrite leaves the line identical, no mutant was ever applied,
  // and every suite would pass exactly as it does on the real tree — so the guard would be scored
  // against a file nobody changed. An already-constant condition is the reachable case.
  const alreadyConstant = [
    "jobs:",
    "  j:",
    "    steps:",
    "      - run: |",
    '          if [ "1" = "1" ]; then',
    "            exit 0",
    "          fi",
    "",
  ].join("\n");
  const [guard] = enumerateSkipGuards(alreadyConstant);
  assert.throws(
    () => mutateGuardLine(alreadyConstant, guard),
    /refusing a mutant that touched line\(s\)  rather than only 5/,
    "a rewrite that changes no line must refuse rather than measure an unmutated tree",
  );
});
