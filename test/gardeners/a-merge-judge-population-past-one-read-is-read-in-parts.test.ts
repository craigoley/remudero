/**
 * W1-T12792 — THE MERGE JUDGE READS A POPULATION PAST ONE READ'S BOUND IN PARTS.
 *
 * One `git cat-file --batch` call keeps at most 64 MiB of stdout, so the judge bounds each call at 48 MiB.
 * It applied that bound to the whole population, and on 2026-11-15 the test population alone was
 * 61,848,086 bytes: fixture-copy and deps-interface read unread on every pass. These fixtures build real
 * repositories with a few large generated files and judge them through the production read and git runner.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { runStepsSync } from "#src/lib/git-push.js";
import {
  judgeMergedRatchets,
  ratchetUpdateWithheld,
  ratchetVerdictHolds,
  readMergedRatchetInputsSteps,
  type MergedRatchetJudgement,
} from "#src/lib/merged-ratchet-verdict.js";
import { planSafetyGitSync, type PlanSafetyGit, type PlanSafetyGitResult } from "#src/lib/plan-pr-merge-safety.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import type { FixtureScope } from "#test/helpers/owned-fixture-dir.js";
// @ts-ignore executable census module has no declaration file.
import { countFixtureCopies } from "#scripts/fixture-copy-census.mjs";
// @ts-ignore executable census module has no declaration file.
import { depsInterfaceCounts } from "#scripts/deps-interface-census.mjs";

type Files = Record<string, string>;

/** The judge's bound of one call, as src/lib/merged-ratchet-verdict.ts holds it. */
const BOUND = 48 * 1024 * 1024;
/** Two of these fit in one call; three do not. */
const LARGE = 17 * 1024 * 1024;
const FIXTURE = "scripts/fixture-copy-baseline.json";
const DEPS = "scripts/deps-interface-baseline.json";
const CLOCK = "scripts/clock-signature-baseline.json";
const REACH = "scripts/affected-reach-baseline.json";
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const zeros = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, 0]));
const FIXTURE_FIELDS = ["gitInitSites", "gitInitFiles", "repoBuilderFunctionNames", "fakeGithubBuilderNames", "fakeGithubBuilderFiles", "ghPathShimFiles", "ledgerHelperNames"];
const DEPS_FIELDS: Record<string, string> = { declarations: "depsInterfaceCount", inline: "inlineSeamCount", aliased: "aliasedSeamCount" };
/** Census signatures, built from parts so this file's own source carries none of them. */
const initSite = `run([${JSON.stringify(["in", "it"].join(""))}]);\n`;
const builder = (name: string) => `${["function", `make${name}Repo`].join(" ")}() {}\n`;
const depsLine = (name: string) => `${["export", "interface", `${name}Deps`].join(" ")} {}\n`;
const seamsLine = (name: string) => `${["export", "type", `${name}Seams`].join(" ")} = {};\n`;
/** `head`, then comment lines to about `bytes`. */
const large = (head: string, bytes = LARGE) => {
  const line = `// ${"x".repeat(76)}\n`;
  return head + line.repeat(Math.ceil((bytes - head.length) / line.length));
};

/** The file's fixtures are shared by its tests and removed once they all end. */
const SUITE = { after: (fn: () => unknown) => { after(() => fn()); } } as FixtureScope;

function write(repo: GitRepo, files: Files, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "--allow-empty", "-m", message);
  return repo.git("rev-parse", "HEAD");
}

/** Main at `start`; each PR `n` cut from it with its own files; then main moves on, so every PR is behind. */
function judgeFixture(kind: string, start: Files, prs: Record<number, Files>) {
  const origin = gitRepo({ scope: SUITE, kind });
  const m0 = write(origin, start, "m0");
  for (const [n, files] of Object.entries(prs)) {
    origin.git("checkout", "-q", "-b", `pr${n}`, m0);
    origin.git("update-ref", `refs/pull/${n}/head`, write(origin, files, `pr ${n}`));
  }
  origin.git("checkout", "-q", "main");
  const m1 = write(origin, { "docs/note.md": "main moved on\n" }, "m1");
  const local = gitRepo({ scope: SUITE, cloneFrom: origin.dir, kind: `${kind}-local` });
  const sizes = new Map<string, number>();
  for (const files of [start, ...Object.values(prs)]) for (const [p, t] of Object.entries(files)) sizes.set(p, Buffer.byteLength(t));
  /** PR `n` judged on main through the production read; `wrap` may stand between it and the production git runner. */
  const judge = (n: number, wrap: (run: PlanSafetyGit) => PlanSafetyGit = (run) => run) => {
    const calls: { paths: string[]; bytes: number }[] = [];
    const run = wrap(planSafetyGitSync(local.dir));
    const recorded: PlanSafetyGit = (args, stdin) => {
      if (args[0] === "cat-file") {
        const paths = (stdin ?? "").split("\n").filter(Boolean).map((l) => l.slice(l.indexOf(":") + 1));
        calls.push({ paths, bytes: paths.reduce((s, p) => s + (sizes.get(p) ?? 0), 0) });
      }
      return run(args, stdin);
    };
    const j = judgeMergedRatchets(runStepsSync(readMergedRatchetInputsSteps({ owner: "o", repo: "r", prNumber: n }, () => ({ base: { ref: "main" } }), recorded)));
    return { j, calls };
  };
  /** The two census scripts on a checkout of `rev`, or of `rev` with PR `n` merged into it. */
  const censusAt = (rev: string, n?: number) => {
    origin.git("checkout", "-q", "--detach", rev);
    if (n !== undefined) origin.git("merge", "-q", "--no-edit", `refs/pull/${n}/head`);
    const src = origin.git("ls-files", "--", "src").split("\n").filter(Boolean);
    const counts = { ...(countFixtureCopies(origin.dir) as Record<string, number>),
      ...(depsInterfaceCounts(src.map((p) => readFileSync(join(origin.dir, p), "utf8"))) as Record<string, number>) };
    origin.git("checkout", "-q", "main");
    return counts;
  };
  return { m1, judge, censusAt, sizes };
}

// One population of six large files (about 102 MiB): src/one.ts and src/zthree.ts declare the same seam names, and
// test/a and test/c the same builder name, each pair in different parts. Every part's listed bytes fit one call.
const PARTED: Files = {
  [FIXTURE]: json(zeros(FIXTURE_FIELDS)),
  [DEPS]: json(zeros(Object.values(DEPS_FIELDS))),
  [CLOCK]: json({ "src/clock.ts": { legacy: 0, dateNow: 1, newDate: 0 } }),
  [REACH]: json({ importerCount: 99, largestScc: 99, medianReachPercent: 100, importers: [], resolution: "package-imports" }),
  "src/one.ts": large(depsLine("Share") + seamsLine("Core")),
  "src/two.ts": large(""),
  "src/zthree.ts": large(depsLine("Share") + seamsLine("Core")),
  "test/a.test.ts": large(builder("Share") + initSite),
  "test/b.test.ts": large(""),
  "test/c.test.ts": large(builder("Share")),
};
const parted = judgeFixture("judge-parts", PARTED, {
  // Lands one src and one test file: the src and test population, read in parts.
  1: { "src/land.ts": depsLine("Land") + seamsLine("Land") + "export const x = (deps: { a: number }) => deps.a;\n",
    "test/land.test.ts": builder("Land") + initSite },
  // Lands one import line in src only: the test files are the reach tree's extra files.
  2: { "src/reach.ts": `import ${JSON.stringify("./one.js")};\n` },
  // A clock-signature crossing, and a test file that makes the population src and test.
  4: { "src/clock.ts": "Date.now();\nDate.now();\n", "test/four.test.ts": "export {};\n" },
});
const LARGE_PATHS = ["src/one.ts", "src/two.ts", "src/zthree.ts", "test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
const partCalls = (calls: { paths: string[] }[], within: string[]) =>
  calls.filter((c) => c.paths.length > 0 && c.paths.every((p) => within.includes(p)));

test("W1-T12792 criterion 1: a population past one read's bound is read in several calls under it, and counted", () => {
  const total = LARGE_PATHS.reduce((s, p) => s + parted.sizes.get(p)!, 0);
  assert.ok(total > 2 * BOUND, `control: the population is ${total} bytes, past twice the bound`);
  const { j, calls } = parted.judge(1);
  const parts = partCalls(calls, LARGE_PATHS);
  assert.equal(parts.length, 3, JSON.stringify(calls.map((c) => c.paths)));
  assert.deepEqual(parts.flatMap((c) => c.paths).sort(), LARGE_PATHS, "every large file is read once, in some part");
  for (const c of calls) assert.ok(c.bytes <= BOUND, `a call read ${c.bytes} listed bytes: ${c.paths.join(", ")}`);
  for (const gate of ["fixture-copy", "deps-interface", "house-layout"]) {
    assert.ok(j.counted.includes(gate), `${gate} is counted: ${j.reason ?? ""}`);
    assert.ok(!(j.reason ?? "").includes(`${gate}: `), `${gate} is not unread: ${j.reason ?? ""}`);
  }
  assert.ok(j.rows.some((r) => r.gate === "fixture-copy"), "the fixture-copy count was read: the landed builder crosses a 0 ceiling");
});

test("W1-T12792 criterion 2: invariant:same-count — the counts from the parts equal the census scripts on a checkout of each tree", () => {
  const { j } = parted.judge(1);
  const merged = parted.censusAt(parted.m1, 1);
  const main = parted.censusAt(parted.m1);
  // Every ceiling is 0, so each count the PR adds to is a row: merged is the judge's count, merged - prAdds main's.
  const fields: Array<[gate: string, count: string, key: string]> = [
    ...FIXTURE_FIELDS.map((f): [string, string, string] => ["fixture-copy", f, f]),
    ...Object.entries(DEPS_FIELDS).map(([c, k]): [string, string, string] => ["deps-interface", c, k]),
  ];
  for (const [gate, count, key] of fields) {
    const row = j.rows.find((r) => r.gate === gate && r.field === key);
    if (row === undefined) { assert.equal(merged[count], main[count], `${gate} ${key}: no row, so the PR adds nothing`); continue; }
    assert.equal(row.merged, merged[count], `${gate} ${key}: merged count`);
    assert.equal(row.merged - row.prAdds, main[count], `${gate} ${key}: main's count`);
  }
  // A name defined in two parts is one name: counted per part and added, each of these would be one more.
  assert.equal(merged.repoBuilderFunctionNames, 2);
  assert.equal(merged.declarations, 2);
  assert.equal(merged.aliased, 2);
  for (const key of ["repoBuilderFunctionNames", "gitInitSites", "depsInterfaceCount", "aliasedSeamCount", "inlineSeamCount"]) {
    assert.ok(j.rows.some((r) => r.field === key), `control: ${key} has a row to compare`);
  }
});

// A population with one blob just past the bound; the PR lands a builder that would cross fixture-copy if it were read.
const oversized = judgeFixture("judge-oversized", {
  [FIXTURE]: json(zeros(FIXTURE_FIELDS)),
  [REACH]: PARTED[REACH]!,
  "test/huge.test.ts": `//${"x".repeat(BOUND + 1 - 3)}\n`,
}, { 3: { "test/x.test.ts": builder("X") } });

test("W1-T12792 criterion 3: invariant:no-ceiling-raise — one blob past the bound makes its gate unread, naming the path and size", () => {
  assert.equal(oversized.sizes.get("test/huge.test.ts"), BOUND + 1);
  const { j, calls } = oversized.judge(3);
  assert.equal(j.verdict, "unread");
  assert.match(j.reason ?? "", /^fixture-copy: the tree could not be read: the test population file test\/huge\.test\.ts is 50331649 bytes, past the 50331648-byte bound of one read(;|$)/);
  assert.ok(!j.counted.includes("fixture-copy"));
  assert.ok(!calls.some((c) => c.paths.includes("test/huge.test.ts")), "no call asks for the blob past the bound");
  for (const c of calls) assert.ok(c.bytes <= BOUND);
});

test("W1-T12792 criterion 4: invariant:no-clean-on-a-part — a failed part makes the population unread, and a crossing elsewhere still holds", () => {
  let failedOnce = false;
  const { j, calls } = parted.judge(4, (run) => (args, stdin) => {
    if (!failedOnce && args[0] === "cat-file" && (stdin ?? "").split("\n")[0]!.endsWith(":src/zthree.ts")) {
      failedOnce = true;
      return { status: 1, stdout: "", signal: null, stderr: "fatal: the part read failed" } as PlanSafetyGitResult;
    }
    return run(args, stdin);
  });
  assert.ok(failedOnce, "control: the second part was asked for");
  const parts = partCalls(calls, LARGE_PATHS);
  assert.equal(parts[1]!.paths[0], "src/zthree.ts", "the failed call is the second of three parts");
  assert.equal(j.verdict, "crossing", j.reason);
  assert.deepEqual(j.rows.map((r) => r.gate), ["clock-signature"]);
  for (const gate of ["fixture-copy", "deps-interface", "house-layout"]) {
    assert.ok(!j.counted.includes(gate), `${gate} is not counted on a part that failed`);
    assert.ok((j.reason ?? "").includes(`${gate}: the tree could not be read: the src and test population, part 2 of 3: git cat-file --batch exited 1: fatal: the part read failed`), j.reason);
  }
});

test("W1-T12792 criterion 5: the reach tree's extra files are read in parts, and one blob past the bound names the file", () => {
  const { j, calls } = parted.judge(2);
  const testPaths = LARGE_PATHS.filter((p) => p.startsWith("test/"));
  const extra = partCalls(calls, testPaths);
  assert.equal(extra.length, 2, "three large test files are two reads of the reach tree");
  for (const c of calls) assert.ok(c.bytes <= BOUND);
  assert.ok(j.counted.includes("affected-reach"), j.reason);
  assert.ok(!(j.reason ?? "").includes("affected-reach: "), j.reason);
  // The oversized fixture's landed test file moves the import graph too: the blob past the bound is named.
  const big = oversized.judge(3).j;
  assert.ok(!big.counted.includes("affected-reach"));
  assert.ok((big.reason ?? "").includes("affected-reach: the code tree could not be read: the code tree file test/huge.test.ts is 50331649 bytes, past the 50331648-byte bound of one read"), big.reason);
});

test("W1-T12792 criterion 6: invariant:unread-never-crossing — an unread population gives no row and never holds", () => {
  const { j } = oversized.judge(3);
  assert.equal(j.verdict, "unread");
  assert.equal(j.rows.length, 0, "the gate that could not be read adds no row");
  assert.equal(ratchetVerdictHolds(j), false);
  assert.equal(ratchetUpdateWithheld(j, 3, []), undefined, "no update-branch or fix-lane hand-off is chosen");
  // With a failed part, the only row is the clock-signature crossing that was read.
  const failing = (run: PlanSafetyGit): PlanSafetyGit => (args, stdin) =>
    args[0] === "cat-file" && LARGE_PATHS.some((p) => (stdin ?? "").includes(`:${p}\n`)) ? { status: 1, stdout: "", signal: null, stderr: "boom" } : run(args, stdin);
  const held: MergedRatchetJudgement = parted.judge(4, failing).j;
  assert.ok(held.rows.every((r) => r.gate === "clock-signature"), JSON.stringify(held.rows));
  const quiet = parted.judge(1, failing).j;
  assert.equal(quiet.verdict, "unread", "the same failed parts with no read crossing: unread, not crossing");
  assert.equal(quiet.rows.length, 0);
});
