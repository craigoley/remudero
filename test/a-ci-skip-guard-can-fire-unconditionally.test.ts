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
import { fileURLToPath, pathToFileURL } from "node:url";

type SkipGuard = {
  key: string;
  job: string;
  line: number;
  text: string;
  form: "if" | "or";
};

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "workflow-guard-mutation-check.mjs");
const CI_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const BASELINE = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "workflow-guard-mutation-baseline.json"), "utf8")) as {
  guards: Record<string, { reason: string }>;
};
const {
  enumerateSkipGuards,
  mutateGuardLine,
  ciReadingSuites,
  classifyGuard,
  suiteFails,
  readBaseline,
  withMutant,
  main,
  runCli,
} = (await import(pathToFileURL(SCRIPT).href)) as {
  enumerateSkipGuards: (text: string) => SkipGuard[];
  mutateGuardLine: (text: string, guard: SkipGuard) => string;
  ciReadingSuites: (root?: string) => string[];
  suiteFails: (
    suite: string,
    spawn?: (
      command: string,
      args: string[],
      options: { cwd: string; encoding: "utf8"; stdio: ["ignore", "pipe", "pipe"] },
    ) => { stdout?: string; stderr?: string },
  ) => { failed: boolean | undefined; out: string };
  readBaseline: (
    path?: string,
    read?: (path: string, encoding: "utf8") => string,
  ) => { guards: Record<string, { reason: string }> };
  withMutant: (
    guard: SkipGuard,
    original: string,
    fn: () => { ok: boolean },
    io?: {
      path: string;
      write: (path: string, text: string) => void;
      mutate: (original: string, guard: SkipGuard) => string;
      once: (event: "exit", listener: () => void) => void;
      removeListener: (event: "exit", listener: () => void) => void;
    },
  ) => { ok: boolean };
  classifyGuard: (
    guard: SkipGuard,
    original: string,
    suites: string[],
    runSuite?: (suite: string) => { failed: boolean | undefined; out?: string },
    apply?: (guard: SkipGuard, original: string, fn: () => { covered: boolean; by: string | undefined }) => {
      covered: boolean;
      by: string | undefined;
    },
  ) => { covered: boolean; by: string | undefined };
  main: (
    argv: string[],
    deps?: {
      readWorkflow?: () => string;
      enumerate?: (text: string) => SkipGuard[];
      baseline?: () => { guards: Record<string, { reason: string }> };
      suitesForWorkflow?: () => string[];
      classify?: (guard: SkipGuard, original: string, suites: string[]) => { covered: boolean; by: string | undefined };
      writeBaseline?: (path: string, text: string) => void;
      log?: (text: string) => void;
      error?: (text: string) => void;
      baselinePath?: string;
    },
  ) => number;
  runCli: (
    entry?: string,
    argv?: string[],
    exit?: (code: number) => void,
    run?: (argv: string[]) => number,
  ) => void;
};

/** A mutant-free `withMutant` stand-in: never touches disk, still proves the mutation was formed. */
const inMemory = (guard: SkipGuard, original: string, fn: () => { covered: boolean; by: string | undefined }) => {
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

test("W1-T3220: an already-constant mutant is refused because no line changed", () => {
  const text = 'jobs:\n  j:\n    steps:\n      - run: |\n          if [ "1" = "1" ]; then\n            exit 0\n          fi\n';
  const [guard] = enumerateSkipGuards(text);
  assert.throws(
    () => mutateGuardLine(text, guard),
    /refusing a mutant that touched line\(s\)  rather than only/,
    "the mutation must prove it actually rewrote the target line",
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

test("W1-T3220: suiteFails reads node-test summaries as failure, pass, or unknown", () => {
  const spawn = (_command: string, _args: string[], _options: { cwd: string; encoding: "utf8"; stdio: ["ignore", "pipe", "pipe"] }) => ({
    stdout: "# fail 1\n",
    stderr: "",
  });
  assert.deepEqual(suiteFails("test/failing.test.ts", spawn), { failed: true, out: "# fail 1\n" });
  const pass = () => ({ stdout: "# fail 0\n", stderr: "" });
  assert.deepEqual(suiteFails("test/passing.test.ts", pass), { failed: false, out: "# fail 0\n" });
  const truncated = () => ({ stdout: "TAP version 13\n", stderr: "killed\n" });
  assert.deepEqual(suiteFails("test/truncated.test.ts", truncated), {
    failed: undefined,
    out: "TAP version 13\nkilled\n",
  });
});

test("W1-T3220: a missing or corrupt baseline reads as an empty decision file", () => {
  assert.deepEqual(
    readBaseline("/tmp/missing-baseline.json", () => {
      throw new Error("nope");
    }),
    { guards: {} },
  );
});

test("W1-T3220: withMutant restores the workflow after the callback and unregisters its listener", () => {
  const [guard] = enumerateSkipGuards(CI_YML);
  const writes: string[] = [];
  const listeners: Array<() => void> = [];
  const out = withMutant(guard, CI_YML, () => ({ ok: true }), {
    path: "ci.yml",
    write: (_path, text) => writes.push(text),
    mutate: (original, target) => mutateGuardLine(original, target),
    once: (_event, listener) => listeners.push(listener),
    removeListener: (_event, listener) => {
      assert.equal(listener, listeners[0]);
    },
  });
  assert.deepEqual(out, { ok: true });
  assert.equal(writes.length, 2, "the mutant is written once, then the original is restored once");
  assert.notEqual(writes[0], CI_YML);
  assert.equal(writes[1], CI_YML);
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
  const probe = join(REPO_ROOT, "test", `zz-w1t3220-untracked-probe-${process.pid}.test.ts`);
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

test("W1-T3220: main refuses an empty guard enumeration and an empty suite corpus", () => {
  const errors: string[] = [];
  assert.equal(main([], { readWorkflow: () => "jobs:\n", enumerate: () => [], error: (text) => errors.push(text) }), 1);
  assert.match(errors[0], /NO skip-shaped guards/);

  const [guard] = enumerateSkipGuards(CI_YML);
  assert.equal(
    main([], {
      readWorkflow: () => CI_YML,
      enumerate: () => [guard],
      baseline: () => ({ guards: {} }),
      suitesForWorkflow: () => [],
      error: (text) => errors.push(text),
    }),
    1,
  );
  assert.match(errors.at(-1) ?? "", /no ci\.yml-reading suites/);
});

test("W1-T3220: main lists guards without consulting baseline or suites", () => {
  const [guard] = enumerateSkipGuards(CI_YML);
  const logs: string[] = [];
  assert.equal(
    main(["--list"], {
      readWorkflow: () => CI_YML,
      enumerate: () => [guard],
      baseline: () => {
        throw new Error("baseline must not be read in list mode");
      },
      log: (text) => logs.push(text),
    }),
    0,
  );
  assert.match(logs.join("\n"), new RegExp(guard.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(logs.at(-1) ?? "", /1 skip-shaped guard/);
});

test("W1-T3220: main reports baselined, covered, and blocking uncovered guards", () => {
  const guards = enumerateSkipGuards(CI_YML).slice(0, 3);
  const logs: string[] = [];
  const errors: string[] = [];
  const result = main([], {
    readWorkflow: () => CI_YML,
    enumerate: () => guards,
    baseline: () => ({ guards: { [guards[0].key]: { reason: "already reviewed" } } }),
    suitesForWorkflow: () => ["test/a.test.ts"],
    classify: (guard) =>
      guard.key === guards[1].key ? { covered: true, by: "test/a.test.ts" } : { covered: false, by: undefined },
    log: (text) => logs.push(text),
    error: (text) => errors.push(text),
    baselinePath: "baseline.json",
  });
  assert.equal(result, 1);
  assert.match(logs.join("\n"), /BASELINED/);
  assert.match(logs.join("\n"), /COVERED/);
  assert.match(logs.join("\n"), /UNCOVERED/);
  assert.match(errors.join("\n"), /BLOCKED -- 1 skip guard/);
  assert.match(errors.join("\n"), /baseline\.json/);
});

test("W1-T3220: main --all measures baselined guards and exits green in report mode", () => {
  const [guard] = enumerateSkipGuards(CI_YML);
  const logs: string[] = [];
  assert.equal(
    main(["--all"], {
      readWorkflow: () => CI_YML,
      enumerate: () => [guard],
      baseline: () => ({ guards: { [guard.key]: { reason: "recorded but still measured" } } }),
      suitesForWorkflow: () => ["test/a.test.ts"],
      classify: () => ({ covered: false, by: undefined }),
      log: (text) => logs.push(text),
    }),
    0,
  );
  assert.match(logs.join("\n"), /UNCOVERED/);
  assert.match(logs.at(-1) ?? "", /1 uncovered/);
});

test("W1-T3220: main --seed writes placeholders only for newly uncovered guards", () => {
  const guards = enumerateSkipGuards(CI_YML).slice(0, 2);
  let written = "";
  const logs: string[] = [];
  assert.equal(
    main(["--seed"], {
      readWorkflow: () => CI_YML,
      enumerate: () => guards,
      baseline: () => ({ guards: { [guards[0].key]: { reason: "existing decision" } } }),
      suitesForWorkflow: () => ["test/a.test.ts"],
      classify: () => ({ covered: false, by: undefined }),
      writeBaseline: (_path, text) => {
        written = text;
      },
      log: (text) => logs.push(text),
      baselinePath: "seed.json",
    }),
    0,
  );
  const parsed = JSON.parse(written) as { guards: Record<string, { reason: string }> };
  assert.equal(parsed.guards[guards[0].key].reason, "existing decision");
  assert.match(parsed.guards[guards[1].key].reason, /RECORDED UNMEASURED/);
  assert.match(logs.at(-1) ?? "", /recorded 2 uncovered guard\(s\) in seed\.json/);
});

test("W1-T3220: the CLI entrypoint exits only when this script is the process entry", () => {
  const exits: number[] = [];
  const runs: string[][] = [];
  const exit = (code: number) => {
    exits.push(code);
  };
  const run = (argv: string[]) => {
    runs.push(argv);
    return 7;
  };

  runCli("node", ["--list"], exit, run);
  assert.deepEqual(exits, []);
  assert.deepEqual(runs, []);

  runCli("/tmp/workflow-guard-mutation-check.mjs", ["--list"], exit, run);
  assert.deepEqual(runs, [["--list"]]);
  assert.deepEqual(exits, [7]);
});
