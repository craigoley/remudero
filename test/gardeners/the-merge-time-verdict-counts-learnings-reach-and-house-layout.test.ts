// @source-text-subject: criterion 6 measures the affected-reach census's graph over the tracked code tree.
/**
 * W1-T12526 — THE MERGE-TIME VERDICT COUNTS THE LEARNINGS BUDGET, AFFECTED REACH AND HOUSE LAYOUT GATES.
 *
 * W1-T12509 counted five recorded-count gates on the merge-tree and left these three named uncounted, so two
 * pull requests could each pass one of them on their own base and cross it together. Each fixture below builds
 * that shape in a real repository: main inside the ceiling, PR A and PR B cut from it, A merged first, and B
 * judged through the production merge-tree read on the main it would land on.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { buildAffectedSuitesGraph } from "#src/lib/affected-suites.js";
import { runStepsSync } from "#src/lib/git-push.js";
import {
  COUNTED_RATCHET_GATES,
  UNCOUNTED_RATCHET_GATES,
  judgeMergedRatchets,
  readMergedRatchetInputsSteps,
  type MergedRatchetInputs,
  type MergedRatchetJudgement,
} from "#src/lib/merged-ratchet-verdict.js";
import { planSafetyGitSync, type PlanSafetyGit, type PlanSafetyGitResult } from "#src/lib/plan-pr-merge-safety.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-ignore executable census module has no declaration file.
import { changesReach, measureReach } from "#scripts/affected-reach-count.mjs";

type Files = Record<string, string | null>;

const LEARNINGS = "scripts/learnings-budget-baseline.json";
const REACH = "scripts/affected-reach-baseline.json";
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
/** One import line, built from its specifier so this file carries no relative specifier of its own. */
const use = (spec: string) => `import ${JSON.stringify(spec)};\n`;
const multilineUse = (spec: string) => `await import(\n  ${JSON.stringify(spec)}\n);\n`;
/** One shard of `n` active entries; each renders `- <20 f> [src: learnings#<id>]`, 43 chars with its newline. */
const shard = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `- id: ${prefix}${i}\n  fact: ${"f".repeat(20)}\n`).join("");

function write(repo: GitRepo, files: Files, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    const abs = join(repo.dir, path);
    if (text === null) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "--allow-empty", "-m", message);
  return repo.git("rev-parse", "HEAD");
}

const sync = (run: PlanSafetyGit, args: string[]) => run(args) as PlanSafetyGitResult;

/** Main at `start`, PR A (#1) and PR B (#2) cut from it, A merged first. */
function landTwo(start: Files, a: Files, b: Files, wrapRun: (run: PlanSafetyGit) => PlanSafetyGit = (run) => run) {
  const origin = gitRepo({ kind: "ratchet-three" });
  const m0 = write(origin, start, "m0: main inside its ceiling");
  origin.git("checkout", "-q", "-b", "a", m0);
  const aHead = write(origin, a, "a: inside the ceiling on its own base");
  origin.git("checkout", "-q", "-b", "b", m0);
  const bHead = write(origin, b, "b: inside the ceiling on its own base");
  origin.git("checkout", "-q", "main");
  origin.git("merge", "-q", "--no-ff", "-m", "merge a", "a");
  const m1 = origin.git("rev-parse", "HEAD");
  origin.git("update-ref", "refs/pull/1/head", aHead);
  origin.git("update-ref", "refs/pull/2/head", bHead);
  const local = gitRepo({ cloneFrom: origin.dir, kind: "ratchet-three-local" });
  const run = wrapRun(planSafetyGitSync(local.dir));
  const calls: string[][] = [];
  const recorded: PlanSafetyGit = (args, stdin) => { calls.push([...args]); return run(args, stdin); };
  /** PR `n` judged on `mainSha`, through the production merge-tree read. */
  const onto = (n: number, mainSha: string): MergedRatchetJudgement => {
    origin.git("update-ref", "refs/heads/judge-main", mainSha);
    return judgeMergedRatchets(runStepsSync(readMergedRatchetInputsSteps({ owner: "o", repo: "r", prNumber: n }, () => ({ base: { ref: "judge-main" } }), recorded)));
  };
  /** The head's own tree against its own base, with no merge: what its CI measured. */
  const own = (base: string, head: string): MergedRatchetJudgement => {
    const git = planSafetyGitSync(origin.dir);
    const read = (rev: string) => (path: string) => {
      const res = sync(git, ["cat-file", "blob", `${rev}:${path}`]);
      return res.status === 0 ? res.stdout : null;
    };
    const list = (...roots: string[]) => sync(git, ["ls-tree", "-r", "--name-only", head, "--", ...roots]).stdout.split("\n").filter(Boolean);
    const changed = sync(git, ["diff", "--name-only", base, head]).stdout.split("\n").filter(Boolean);
    return judgeMergedRatchets({ mainSha: base, headSha: head, changed, measuredFiles: [], populationFiles: list("src", "test", "learnings"),
      reachFiles: list("src", "scripts", "bin", "test"), readMerged: read(head), readMain: read(base) });
  };
  return { origin, m0, m1, aHead, bHead, onto, own, calls };
}

/** Each PR passes on its own base; B on the main A landed crosses, with one row for `gate`. */
function assertHeldTogether(gate: string, fx: ReturnType<typeof landTwo>, row: { path: string; field?: string; merged: number; ceiling: number }) {
  for (const [label, head] of [["A", fx.aHead], ["B", fx.bHead]] as const) {
    const alone = fx.own(fx.m0, head);
    assert.equal(alone.verdict, "clean", `${label} on its own base: ${alone.reason ?? ""}`);
    assert.deepEqual(alone.counted, [...COUNTED_RATCHET_GATES], `${label} on its own base counts every gate`);
  }
  const together = fx.onto(2, fx.m1);
  assert.equal(together.verdict, "crossing", together.reason ?? JSON.stringify(together.rows));
  assert.deepEqual(together.counted, [...COUNTED_RATCHET_GATES]);
  assert.deepEqual(together.rows.map((r) => ({ gate: r.gate, path: r.path, field: r.field, merged: r.merged, ceiling: r.prCeiling })),
    [{ gate, path: row.path, field: row.field, merged: row.merged, ceiling: row.ceiling }]);
  return together;
}

/** In-memory trees: `merged` and `main` map a path to its text; every other path is absent. */
function memory(merged: Files, main: Files, extra: Partial<Extract<MergedRatchetInputs, { changed: string[] }>> = {}): MergedRatchetInputs {
  const reader = (files: Files) => (p: string) => files[p] ?? null;
  const changed = [...new Set([...Object.keys(merged), ...Object.keys(main)])].filter((p) => merged[p] !== main[p]).sort();
  return { mainSha: "m", headSha: "h", changed, measuredFiles: [], populationFiles: Object.keys(merged).filter((p) => merged[p] !== null),
    readMerged: reader(merged), readMain: reader(main), ...extra };
}

/** A small code tree the reach census can measure: two modules, one suite importing src/run-task.ts. */
const REACH_TREE: Files = {
  "src/run-task.ts": "export const r = 1;\n",
  "src/a.ts": "export const a = 1;\n",
  "test/old.test.ts": use("../src/run-task.js"),
};
const reachBaseline = (importers: string[]) => json({ importerCount: 2, largestScc: 9, medianReachPercent: 100, importers, resolution: "package-imports" });

test("W1-T12526 criterion 1: the three gates are counted on the merge-tree with their own counters, and none is named uncounted", () => {
  for (const gate of ["learnings-budget", "affected-reach", "house-layout"]) {
    assert.ok((COUNTED_RATCHET_GATES as readonly string[]).includes(gate), `${gate} is counted`);
    assert.ok(!UNCOUNTED_RATCHET_GATES.some((u) => u.gate === gate), `${gate} is not named uncounted`);
  }
  // One merge that lands every new gate's scope: a shard, an import line and a src file. Each is counted, none unread.
  const fx = landTwo(
    { [LEARNINGS]: json({ hardCapChars: 1000 }), "learnings/one.yaml": shard("o", 1), [REACH]: reachBaseline(["test/old.test.ts"]), ...REACH_TREE },
    { "src/b.ts": "export const b = 1;\n" },
    { "learnings/two.yaml": shard("t", 1), "test/a.test.ts": use("../src/a.js"), "src/dir.ts": "export const d = 1;\n" },
  );
  const j = fx.onto(2, fx.m1);
  assert.equal(j.verdict, "clean", j.reason);
  assert.equal(j.reason, undefined);
  assert.deepEqual(j.counted, [...COUNTED_RATCHET_GATES]);
});

test("W1-T12526 criterion 2: learnings-budget — two PRs each under the hard cap cross it together", () => {
  // Main 1 entry (43 chars), A and B 2 each (86), merged 3 (129) over a cap of 100.
  const together = assertHeldTogether("learnings-budget", landTwo(
    { [LEARNINGS]: json({ capChars: 50, hardCapChars: 100 }), "learnings/one.yaml": shard("o", 1) },
    { "learnings/two.yaml": shard("a", 1) },
    { "learnings/three.d/b.yaml": shard("b", 1) },
  ), { path: LEARNINGS, field: "hardCapChars", merged: 129, ceiling: 100 });
  assert.equal(together.rows[0]!.mainCeiling, 100);
});

test("W1-T12526 criterion 3: affected-reach — two PRs that each add a run-task importer cross importerCount together", () => {
  const fx = landTwo(
    { [REACH]: reachBaseline(["test/old.test.ts"]), ...REACH_TREE },
    { "test/a.test.ts": use("../src/run-task.js") },
    { "test/b.test.ts": use("../src/run-task.js") },
  );
  const together = assertHeldTogether("affected-reach", fx, { path: REACH, field: "importerCount", merged: 3, ceiling: 2 });
  // The count is the census's own counter over the merged tree, not a copy of it.
  const merged = new Map(Object.entries({ ...REACH_TREE, "test/a.test.ts": use("../src/run-task.js"), "test/b.test.ts": use("../src/run-task.js") }) as Array<[string, string]>);
  assert.equal(together.rows[0]!.merged, (measureReach(merged, {}) as { importerCount: number }).importerCount);
});

test("W1-T12526 criterion 3: affected-reach counts multiline specifier edits on the merged tree", () => {
  const start = {
    [REACH]: reachBaseline(["test/old.test.ts"]),
    ...REACH_TREE,
    "test/a.test.ts": multilineUse("../src/a.js"),
    "test/b.test.ts": multilineUse("../src/a.js"),
  };
  const a = { "test/a.test.ts": multilineUse("../src/run-task.js") };
  const b = { "test/b.test.ts": multilineUse("../src/run-task.js") };
  assert.equal(changesReach("test/a.test.ts", start["test/a.test.ts"]!, a["test/a.test.ts"]!), true,
    "the complete module specifier is part of the reach trigger");
  const together = assertHeldTogether("affected-reach", landTwo(start, a, b),
    { path: REACH, field: "importerCount", merged: 3, ceiling: 2 });
  const merged = new Map(Object.entries({ ...start, ...a, ...b }) as Array<[string, string]>);
  assert.equal(together.rows[0]!.merged, (measureReach(merged, {}) as { importerCount: number }).importerCount);
});

test("W1-T12526 criterion 4: affected-reach is bounded — no graph when no import line lands, and unread past the read bound", () => {
  // No landed file changes an import line: the gate is counted with no listing of the code tree at all.
  const quiet = judgeMergedRatchets(memory({ [REACH]: reachBaseline([]), "src/a.ts": "export const a = 2;\n" }, { [REACH]: reachBaseline([]), "src/a.ts": "export const a = 1;\n" }));
  assert.ok(quiet.counted.includes("affected-reach"), quiet.reason);
  const fx = landTwo({ [REACH]: reachBaseline(["test/old.test.ts"]), ...REACH_TREE }, { "src/a.ts": "export const a = 2;\n" }, { "src/run-task.ts": "export const r = 2;\n" });
  const read = fx.onto(2, fx.m1);
  assert.equal(read.verdict, "clean", read.reason);
  const reachListing = (args: readonly string[]) => args[0] === "ls-tree" && args.includes("-l") && args.includes("bin");
  assert.ok(!fx.calls.some(reachListing), "the code tree is never listed");

  // Past the bound: the code tree's listing names more bytes than one read may take.
  const big = landTwo({ [REACH]: reachBaseline(["test/old.test.ts"]), ...REACH_TREE }, { "src/a.ts": "export const a = 2;\n" },
    { "test/b.test.ts": use("../src/run-task.js") },
    (run) => (args, stdin) => {
      const res = run(args, stdin) as PlanSafetyGitResult;
      if (args[0] !== "ls-tree" || !args.includes("-l") || !args.includes("bin")) return res;
      return { ...res, stdout: res.stdout.replace(/^(\d+ blob [0-9a-f]+) +\d+\t/gm, "$1 60000000\t").replace(/\0(\d+ blob [0-9a-f]+) +\d+\t/g, "\0$1 60000000\t") };
    });
  const bounded = big.onto(2, big.m1);
  assert.equal(bounded.verdict, "unread");
  assert.match(bounded.reason ?? "", /^affected-reach: the code tree could not be read: the code tree is \d+ bytes, past the 50331648-byte bound$/);
  assert.ok(!bounded.counted.includes("affected-reach"));
  assert.ok(big.calls.some(reachListing), "control: an import line that lands lists the code tree");
});

test("W1-T12526 criterion 5: house-layout — the merged tree crosses main's tip with a break neither PR has on its own base", () => {
  const literal = `export const dir = ${JSON.stringify(".remudero/")};\n`;
  const together = assertHeldTogether("house-layout", landTwo({ "src/one.ts": literal }, { "src/one.ts": "export const dir = 1;\n", "src/two.ts": literal },
    { "src/one.ts": "export const dir = 1;\n", "src/lib/three.ts": literal }), { path: "src", field: ".remudero/", merged: 2, ceiling: 1 });
  assert.equal(together.rows[0]!.mainCeiling, 1);
  // The W1-T9332 split table is data the census reads, with the pair and the restoration it names.
  const table = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/house-layout-split-table.json"), "utf8")) as { runTaskSplit: { old: string; moved: string }; sweepRestoration: { path: string } };
  assert.deepEqual([table.runTaskSplit.old, table.runTaskSplit.moved, table.sweepRestoration.path], ["src/run-task.ts", "src/cli/commands/run-task-verb.ts", "src/cli/commands/sweep.ts"]);
});

test("W1-T12526 criterion 6: with the verdict importing all three counters, the reach graph closes no ring and stays inside its baseline", () => {
  const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", "src", "scripts", "bin", "test"], { cwd: REPO_ROOT, encoding: "utf8" })
    .trim().split("\n").filter((p) => /\.(?:ts|mts|mjs|js|cjs)$/.test(p));
  const files = new Map(paths.map((p) => [p, readFileSync(join(REPO_ROOT, p), "utf8")]));
  const graph = buildAffectedSuitesGraph(files, [], { root: REPO_ROOT });
  for (const counter of ["scripts/learnings-budget-ratchet.mjs", "scripts/affected-reach-count.mjs", "scripts/house-layout-census.mjs"]) {
    assert.ok(graph.importers.get(counter)?.has("src/lib/merged-ratchet-verdict.ts"), `control: the verdict imports ${counter}`);
    const named = [...(graph.dependencies.get(counter) ?? [])].filter((d) => d === "src/run-task.ts" || d.startsWith("src/cli/"));
    assert.deepEqual(named, [], `${counter} has no edge to the run-task or command files`);
  }
  const reach = measureReach(files, { root: REPO_ROOT }) as { largestScc: number; medianReachPercent: number };
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, REACH), "utf8")) as { largestScc: number; medianReachPercent: number };
  assert.ok(reach.largestScc <= baseline.largestScc, `largestScc ${reach.largestScc} > ${baseline.largestScc}`);
  assert.ok(reach.medianReachPercent <= baseline.medianReachPercent, `medianReachPercent ${reach.medianReachPercent} > ${baseline.medianReachPercent}`);
});

test("W1-T12526 criterion 7: invariant:no-clean-without-count — a counter that throws or a tree it cannot read is unread, never clean", () => {
  const unreadBy = (j: MergedRatchetJudgement, gate: string, why: RegExp) => {
    assert.equal(j.verdict, "unread", JSON.stringify(j.rows));
    assert.ok(!j.counted.includes(gate), `${gate} is not counted`);
    assert.match(j.reason ?? "", why);
  };
  // learnings-budget: a shard the ratchet's own parse refuses, and a cap its own check refuses.
  unreadBy(judgeMergedRatchets(memory({ [LEARNINGS]: json({ hardCapChars: 100 }), "learnings/one.yaml": "id: x\n" }, { [LEARNINGS]: json({ hardCapChars: 100 }) })),
    "learnings-budget", /^learnings-budget: a ratchet counter threw: .*learnings\/one\.yaml must be a YAML list of entries$/);
  unreadBy(judgeMergedRatchets(memory({ [LEARNINGS]: json({ hardCapChars: "100" }), "learnings/one.yaml": shard("o", 1) }, {})),
    "learnings-budget", /^learnings-budget: a ratchet counter threw: 'hardCapChars' must be a number/);
  // affected-reach: a tree the census cannot measure (no suite), and a tree the read could not list.
  unreadBy(judgeMergedRatchets(memory({ [REACH]: reachBaseline([]), "src/a.ts": "export {};\n" }, { [REACH]: reachBaseline([]) }, { reachFiles: ["src/a.ts"] })),
    "affected-reach", /^affected-reach: a ratchet counter threw: the census needs source modules and suites$/);
  unreadBy(judgeMergedRatchets(memory({ [REACH]: reachBaseline([]), "src/a.ts": "export {};\n" }, { [REACH]: reachBaseline([]) })),
    "affected-reach", /^affected-reach: the code tree could not be read: no listing of src\/, scripts\/, bin\/ and test\/ was read$/);
  // A multiline specifier that the alias resolver cannot model must run the counter and become unread,
  // not take the no-graph shortcut and claim a clean count.
  const imports = JSON.stringify({ imports: { "#bad": { import: "./src/a.ts" } } });
  const aliasMain = { [REACH]: reachBaseline(["test/old.test.ts"]), ...REACH_TREE, "package.json": imports,
    "test/bad.test.ts": multilineUse("../src/a.js") };
  const aliasMerged = { ...aliasMain, "test/bad.test.ts": multilineUse("#bad") };
  unreadBy(judgeMergedRatchets(memory(aliasMerged, aliasMain, { reachFiles: ["src/run-task.ts", "src/a.ts", "test/old.test.ts", "test/bad.test.ts"] })),
    "affected-reach", /^affected-reach: a ratchet counter threw: package imports target for/);
  // house-layout: a src population the read could not list.
  const layout = judgeMergedRatchets(memory({ "src/a.ts": "export const a = 1;\n" }, {}, { populationUnread: "git ls-tree -l exited 128" }));
  unreadBy(layout, "house-layout", /house-layout: the tree could not be read: git ls-tree -l exited 128/);
  // A tree that cannot be read at all: every gate the merge touches is unread by name, none is clean.
  const blind = judgeMergedRatchets({ mainSha: "m", headSha: "h", changed: ["src/a.ts", "learnings/one.yaml"], measuredFiles: [],
    readMerged: () => { throw new Error("blob read failed"); }, readMain: () => null });
  for (const gate of ["learnings-budget", "affected-reach", "house-layout"]) unreadBy(blind, gate, new RegExp(`${gate}: a ratchet counter threw: blob read failed`));
});
