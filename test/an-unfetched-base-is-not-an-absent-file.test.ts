// test/an-unfetched-base-is-not-an-absent-file.test.ts — W1-T3141.
//
// W1-T3037 taught `source-size-ratchet` to tell an author which reds they INHERITED from the base
// rather than grew. MEASURED on origin/main at 41231c67: none of it could ever fire in CI. The
// `source-size` job checked out with a BARE `actions/checkout` — the default `fetch-depth: 1`, and
// on a `pull_request` that fetches only the merge ref — so `origin/main` was not a ref there.
//
// AND A MISSING REF IS INDISTINGUISHABLE FROM A MISSING PATH BY EXIT STATUS: git exits 128 for
// both. `contentAtRef` reads that as `absent`, `splitInheritedViolations` calls every violation
// INTRODUCED, `inheritedNotice` returns undefined, and NOTHING PRINTS. The gate tells the author
// they grew every one of those files, in the one environment it actually runs in.
//
// The helper's own comment states the rule this broke: an unreadable ref "is not treated as clean
// either; it yields `undetermined`, because 'we could not ask' and 'the base is fine' must not
// arrive as the same answer."

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "source-size-ratchet.mjs");
const CI_YML = join(REPO_ROOT, ".github", "workflows", "ci.yml");

const mod = (await import(
  pathToFileURL(join(REPO_ROOT, "scripts/lib/inherited-violation.mjs")).href
)) as {
  contentAtRef: (run: unknown, ref: string, path: string) => { kind: string };
  refResolvable: (run: unknown, ref: string) => boolean;
  splitInheritedViolations: (
    v: unknown[],
    o: Record<string, unknown>,
  ) => {
    inherited: { path: string }[];
    introduced: { path: string }[];
    undetermined: { path: string }[];
  };
  undeterminedNotice: (
    v: { path: string }[],
    ref: string,
    tool: string,
  ) => string | undefined;
};
const {
  contentAtRef,
  refResolvable,
  splitInheritedViolations,
  undeterminedNotice,
} = mod;

/**
 * A real repository with one tracked file and NO `origin/main` — the shape a `pull_request`
 * checkout has at the default `fetch-depth: 1`.
 *
 * Built on the SHARED fixture (test/helpers/git-repo.ts), which carries its own committer identity
 * on every invocation — `actions/checkout` configures neither repo nor global `user.name`, and a
 * hand-rolled fixture that forgets it fails on every CI runner while passing on every dev machine
 * (#1971, twice). `test/fixture-copy-census.test.ts` counts a new hand-rolled `git init` site as
 * debt for exactly that reason, and caught this file's first draft adding one.
 */
function unfetchedBaseTree(): string {
  const repo = gitRepo({ kind: "unfetched-base" });
  writeFileSync(join(repo.dir, "f.txt"), "hi\n");
  repo.git("add", "f.txt");
  repo.git("commit", "-m", "add f.txt");
  return repo.dir;
}

/** A NON-THROWING git runner — the shape `contentAtRef` and `refResolvable` are handed, and the
 *  reason this cannot use the fixture's own `git()`, which throws on a non-zero exit. Reading the
 *  128s IS the measurement here. */
const runIn = (root: string) => (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { cwd: root, encoding: "utf8" });

test("W1-T3141 criterion 2: git exits 128 for a MISSING REF exactly as for a MISSING PATH — the premise, measured, not restated", () => {
  const root = unfetchedBaseTree();
  const run = runIn(root);
  // The positive control FIRST: a readable ref and a real path, so a 128 below means something.
  assert.equal(
    run("git", ["show", "main:f.txt"]).status,
    0,
    "control: a real ref and path must read",
  );

  const missingPath = run("git", ["show", "main:nosuch.txt"]);
  const missingRef = run("git", ["show", "origin/main:f.txt"]);
  assert.equal(
    missingPath.status,
    128,
    "a path absent at a real ref exits 128",
  );
  assert.equal(
    missingRef.status,
    128,
    "and a ref that does not exist AT ALL exits the same 128",
  );

  // Which is exactly why contentAtRef cannot tell them apart, and calls the second one `absent`.
  assert.equal(contentAtRef(run, "origin/main", "f.txt").kind, "absent");

  // rev-parse does separate them, which is what makes the repair possible.
  assert.equal(
    run("git", ["rev-parse", "--verify", "--quiet", "main^{commit}"]).status,
    0,
  );
  assert.notEqual(
    run("git", ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"])
      .status,
    0,
  );
});

test("W1-T3141: refResolvable answers TRUE for a ref that is there and FALSE for one that is not", () => {
  const root = unfetchedBaseTree();
  const run = runIn(root);
  assert.equal(
    refResolvable(run, "main"),
    true,
    "the ref the fixture just committed to",
  );
  assert.equal(
    refResolvable(run, "origin/main"),
    false,
    "the ref a shallow PR checkout does not have",
  );
});

test("W1-T3141: refResolvable reads a THROWING run as unresolvable — git not answering is not git saying yes", () => {
  const thrower = () => {
    throw new Error("spawn ENOMEM");
  };
  assert.equal(refResolvable(thrower, "origin/main"), false);
});

test("W1-T3141 criterion 1: an unresolvable ref leaves every violation UNDETERMINED, and blames none of them on this diff", () => {
  // The run answers 128 to everything, which is precisely the ambiguity: without the predicate this
  // reads as "absent at the base" and every violation is INTRODUCED.
  const run = () => ({ status: 128, stdout: "" });
  const split = splitInheritedViolations(
    [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    {
      run,
      ref: "origin/main",
      measure: (t: string) => t.length,
      baselineFor: () => 1,
      refPresent: () => false,
    },
  );
  assert.deepEqual(
    split.undetermined.map((v) => v.path),
    ["src/a.ts", "src/b.ts"],
  );
  assert.deepEqual(
    split.introduced,
    [],
    "a base nobody could read cannot substantiate INTRODUCED",
  );
  assert.deepEqual(
    split.inherited,
    [],
    "nor INHERITED — the point is that no claim is made",
  );
});

test("W1-T3141 criterion 5: the predicate is LOAD-BEARING — the identical inputs without it still read as introduced", () => {
  // Delete the fix and the defect returns: this is the same call, minus `refPresent`. It is also
  // W1-T3037's untouched contract, which is why the option is optional.
  const run = () => ({ status: 128, stdout: "" });
  const opts = {
    run,
    ref: "origin/main",
    measure: (t: string) => t.length,
    baselineFor: () => 1,
  };
  const without = splitInheritedViolations([{ path: "src/a.ts" }], opts);
  assert.deepEqual(
    without.introduced.map((v) => v.path),
    ["src/a.ts"],
    "unchanged for a caller that passes no predicate",
  );
  assert.deepEqual(without.undetermined, []);

  const withIt = splitInheritedViolations([{ path: "src/a.ts" }], {
    ...opts,
    refPresent: () => false,
  });
  assert.deepEqual(
    withIt.introduced,
    [],
    "and the predicate is what changes the answer",
  );
});

test("W1-T3141: a resolvable ref runs the real split — the predicate gates nothing when the base is readable", () => {
  const run = () => ({ status: 0, stdout: "x\n".repeat(500) });
  const split = splitInheritedViolations([{ path: "src/big.ts" }], {
    run,
    ref: "origin/main",
    measure: (t: string) => t.split("\n").length - 1,
    baselineFor: () => 100,
    refPresent: () => true,
  });
  assert.deepEqual(
    split.inherited.map((v) => v.path),
    ["src/big.ts"],
    "over its ceiling at the base — INHERITED",
  );
  assert.deepEqual(split.undetermined, []);
});

test("W1-T3141: undeterminedNotice names the ref and every path, and says NO claim is being made", () => {
  const n = undeterminedNotice(
    [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    "origin/main",
    "source-size-ratchet",
  );
  assert.ok(n);
  assert.match(n!, /could not determine/i);
  assert.match(
    n!,
    /origin\/main/,
    "a reader must be able to check which ref was unreadable",
  );
  assert.match(n!, /src\/a\.ts, src\/b\.ts/);
  assert.match(
    n!,
    /no claim is made/i,
    "the whole point is that it is NOT an accusation",
  );
});

test("W1-T3141: nothing undetermined prints no notice, so a clean refusal is not diluted", () => {
  assert.equal(
    undeterminedNotice([], "origin/main", "source-size-ratchet"),
    undefined,
  );
});

test("W1-T3141 criterion 3: the SHIPPED ratchet, run where origin/main does not resolve, says so instead of printing nothing", () => {
  // The end-to-end case: a real git repository with no `origin/main`, a real baselined file over its
  // ceiling, and the real CLI as a subprocess — the configuration CI runs, not a re-derivation.
  const root = unfetchedBaseTree();
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "src", "lib", "subject.ts"),
    "const x = 1;\n".repeat(101),
  );
  const baseline = join(root, "scripts", "source-size-baseline.json");
  writeFileSync(
    baseline,
    `${JSON.stringify({ "src/lib/subject.ts": 100 }, null, 2)}\n`,
  );

  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--root", root, "--baseline", baseline],
    {
      encoding: "utf8",
    },
  );
  const out = `${r.stdout}${r.stderr}`;

  assert.notEqual(
    r.status,
    0,
    `the file is over its ceiling, so the gate must still BLOCK:\n${out}`,
  );
  assert.match(
    out,
    /could not determine/i,
    `it must say the comparison could not be run:\n${out}`,
  );
  assert.match(
    out,
    /src\/lib\/subject\.ts/,
    "and name the file it could not place",
  );
  // The defect this replaces was SILENCE, not a wrong sentence: before the fix the same run
  // classified the violation as introduced and printed no line about the base at all.
  assert.equal(
    /already exceed their ceiling/.test(out),
    false,
    "it must not claim INHERITED on a base it could not read",
  );
});

test("W1-T3141 criterion 4: the source-size job checks out deeply enough for origin/main, with exactly one checkout step", () => {
  // PARSED, NOT GREPPED — the job's own comments mention `fetch-depth` and a text scan reads them.
  const ci = parseYaml(readFileSync(CI_YML, "utf8")) as {
    jobs: Record<
      string,
      { steps: Array<{ uses?: string; with?: Record<string, unknown> }> }
    >;
  };
  const job = ci.jobs["source-size"];
  assert.ok(job, "the job key must exist");

  const checkouts = job.steps.filter((s) =>
    String(s.uses ?? "").startsWith("actions/checkout"),
  );
  // EXACTLY ONE. Two guards this session were unambiguous only while one thing matched them
  // (#4493's three-item set became four; #4505 found "the step mentioning X"). Asserting the count
  // is what stops this one going quietly wrong when a second checkout is added.
  assert.equal(
    checkouts.length,
    1,
    `expected one checkout step, saw ${checkouts.length}`,
  );
  assert.equal(
    checkouts[0].with?.["fetch-depth"],
    0,
    "without full history `origin/main` is not a ref here, and the inherited/introduced split reads every violation as introduced",
  );

  // Positive control: the parse found the real corpus, so an absent job could never read as present.
  assert.ok(
    Object.keys(ci.jobs).length >= 15,
    `sanity: ci.yml must carry its real job set, saw ${Object.keys(ci.jobs).length}`,
  );
  assert.equal(ci.jobs["no-such-job-exists"], undefined);
});
