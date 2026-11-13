/**
 * W1-T12509 — TWO PULL REQUESTS THAT CROSS A CEILING TOGETHER ARE HELD AT MERGE TIME.
 *
 * Main's branch protection is not strict, so two pull requests that are each green on their own base
 * can cross a recorded ceiling together (doctrine/ci-and-merging/ratchet-collision.md: #10695 and
 * #10697). The merge-time verdict counted only clock-signature. Each test below builds that shape in a
 * real repository for one gate: main at its ceiling less some headroom, PR A and PR B each inside it,
 * A merged first, and B judged through the production merge-tree read on the main it would land on.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

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

type Files = Record<string, string | null>;

const CLOCK = "scripts/clock-signature-baseline.json";
const SIZE = "scripts/source-size-baseline.json";
const FIXTURE = "scripts/fixture-copy-baseline.json";
const DEPS = "scripts/deps-interface-baseline.json";
const CLAUDE = "scripts/claude-md-budget-baseline.json";
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const numbered = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `const ${prefix}${i} = ${i};\n`).join("");

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

/** One gate's two-PR shape: main at `start`, PR A (#1) and PR B (#2) cut from it, A merged first. */
function landTwo(start: Files, a: Files, b: Files, wrapRun: (run: PlanSafetyGit) => PlanSafetyGit = (run) => run) {
  const origin = gitRepo({ kind: "ratchet-pair" });
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
  const local = gitRepo({ cloneFrom: origin.dir, kind: "ratchet-pair-local" });
  const run = wrapRun(planSafetyGitSync(local.dir));
  /** PR `n` judged on `mainSha`, through the production merge-tree read. */
  const onto = (n: number, mainSha: string): MergedRatchetJudgement => {
    origin.git("update-ref", "refs/heads/judge-main", mainSha);
    return judgeMergedRatchets(runStepsSync(readMergedRatchetInputsSteps({ owner: "o", repo: "r", prNumber: n }, () => ({ base: { ref: "judge-main" } }), run)));
  };
  /** The head's own tree against its own base, with no merge: what its CI measured. */
  const own = (base: string, head: string): MergedRatchetJudgement => {
    const git = planSafetyGitSync(origin.dir);
    const read = (rev: string) => (path: string) => {
      const res = sync(git, ["cat-file", "blob", `${rev}:${path}`]);
      return res.status === 0 ? res.stdout : null;
    };
    const changed = sync(git, ["diff", "--name-only", base, head]).stdout.split("\n").filter(Boolean);
    const populationFiles = sync(git, ["ls-tree", "-r", "--name-only", head, "--", "src", "test"]).stdout.split("\n").filter(Boolean);
    return judgeMergedRatchets({ mainSha: base, headSha: head, changed, measuredFiles: [], populationFiles, readMerged: read(head), readMain: read(base) });
  };
  return { m0, m1, aHead, bHead, onto, own };
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
}

test("W1-T12509 criterion 1: the judge counts each recorded-count gate on the merge-tree with that gate's own counter", () => {
  assert.deepEqual([...COUNTED_RATCHET_GATES], ["clock-signature", "source-size", "fixture-copy", "deps-interface", "claude-md-budget"]);
  // One merge that lands every gate's scope: each gate is counted on both trees, none is unread.
  const word = ["in", "it"].join("");
  const fx = landTwo(
    { [CLOCK]: json({}), [SIZE]: json({ "src/a.ts": 500 }), [FIXTURE]: json({ gitInitSites: 9 }), [DEPS]: json({ depsInterfaceCount: 9 }),
      [CLAUDE]: json({ capBytes: 900 }), "CLAUDE.md": "rules\n", "src/a.ts": numbered("a", 3), "test/a.test.ts": "export {};\n" },
    { "src/b.ts": "export const b = 1;\n" },
    { "src/a.ts": numbered("a", 4), "test/a.test.ts": `run([${JSON.stringify(word)}]);\n`, "CLAUDE.md": "rules\nmore rules\n" },
  );
  const j = fx.onto(2, fx.m1);
  assert.equal(j.verdict, "clean", j.reason);
  assert.equal(j.reason, undefined);
  assert.deepEqual(j.counted, [...COUNTED_RATCHET_GATES]);
  // learnings-budget, affected-reach and house-layout have counters this module cannot run on two trees
  // (the task's note): they are named, with the reason, never counted as clean.
  for (const gate of ["learnings-budget", "affected-reach", "house-layout"]) assert.ok(j.uncounted.some((u) => u.gate === gate && u.reason), gate);
});

test("W1-T12509 criterion 2: clock-signature — two PRs each inside the row cross it together", () => {
  const filler = numbered("f", 20);
  assertHeldTogether("clock-signature", landTwo(
    { [CLOCK]: json({ "src/a.ts": { legacy: 0, dateNow: 2, newDate: 0 } }), "src/a.ts": `export const t0 = Date.now();\n${filler}` },
    { "src/a.ts": `export const ta = Date.now();\nexport const t0 = Date.now();\n${filler}` },
    { "src/a.ts": `export const t0 = Date.now();\n${filler}export const tb = Date.now();\n` },
  ), { path: "src/a.ts", field: "dateNow", merged: 3, ceiling: 2 });
});

test("W1-T12509 criterion 2: source-size — two PRs each inside a file's line ceiling cross it together", () => {
  const body = numbered("s", 480);
  assertHeldTogether("source-size", landTwo(
    { [SIZE]: json({ "src/big.ts": 500 }), "src/big.ts": body },
    { "src/big.ts": `${numbered("top", 15)}${body}` },
    { "src/big.ts": `${body}${numbered("end", 15)}` },
  ), { path: "src/big.ts", merged: 510, ceiling: 500 });
});

test("W1-T12509 criterion 2: fixture-copy — two PRs each inside a signature's count cross it together", () => {
  const site = `run([${JSON.stringify(["in", "it"].join(""))}]);\n`;
  const ceilings = { gitInitSites: 2, gitInitFiles: 9, repoBuilderFunctionNames: 9, fakeGithubBuilderNames: 9, fakeGithubBuilderFiles: 9, ghPathShimFiles: 9, ledgerHelperNames: 9 };
  assertHeldTogether("fixture-copy", landTwo(
    { [FIXTURE]: json(ceilings), "test/one.test.ts": site },
    { "test/two.test.ts": site },
    { "test/gardeners/three.test.ts": site },
  ), { path: FIXTURE, field: "gitInitSites", merged: 3, ceiling: 2 });
});

test("W1-T12509 criterion 2: deps-interface — two PRs each inside the declaration count cross it together", () => {
  assertHeldTogether("deps-interface", landTwo(
    { [DEPS]: json({ depsInterfaceCount: 2, inlineSeamCount: 9, aliasedSeamCount: 9 }), "src/one.ts": "export interface OneDeps { a: number }\n" },
    { "src/two.ts": "export interface TwoDeps { b: number }\n" },
    { "src/lib/three.ts": "export interface ThreeDeps { c: number }\n" },
  ), { path: DEPS, field: "depsInterfaceCount", merged: 3, ceiling: 2 });
});

test("W1-T12509 criterion 2: house-layout — its counter closes an import ring here, so it is named uncounted, never counted clean", () => {
  const literal = `export const dir = ${JSON.stringify("learnings/")};\n`;
  const fx = landTwo({ "src/one.ts": literal }, { "src/one.ts": "export const dir = 1;\n", "src/two.ts": literal },
    { "src/one.ts": "export const dir = 1;\n", "src/three.ts": literal });
  const together = fx.onto(2, fx.m1);
  assert.ok(!together.counted.includes("house-layout"));
  assert.match(together.uncounted.find((u) => u.gate === "house-layout")?.reason ?? "", /names the run-task and sweep command files/);
});

test("W1-T12509 criterion 2: claude-md-budget — two PRs each inside the fold-debt ceiling cross it together", () => {
  const body = Array.from({ length: 10 }, (_, i) => `line-${String(i).padStart(4, "0")}\n`).join("");
  assertHeldTogether("claude-md-budget", landTwo(
    { [CLAUDE]: json({ capBytes: 100, foldDebtCeilingBytes: 120 }), "CLAUDE.md": body },
    { "CLAUDE.md": `aaaaaaaaaaaaaa\n${body}` },
    { "CLAUDE.md": `${body}bbbbbbbbbbbbbb\n` },
  ), { path: "CLAUDE.md", merged: 130, ceiling: 120 });
});

/** In-memory trees: `merged` and `main` map a path to its text; every other path is absent. */
function memory(merged: Files, main: Files, extra: Partial<Extract<MergedRatchetInputs, { changed: string[] }>> = {}): MergedRatchetInputs {
  const reader = (files: Files) => (p: string) => files[p] ?? null;
  const changed = [...new Set([...Object.keys(merged), ...Object.keys(main)])].filter((p) => merged[p] !== main[p]).sort();
  return { mainSha: "m", headSha: "h", changed, measuredFiles: [], populationFiles: Object.keys(merged).filter((p) => merged[p] !== null),
    readMerged: reader(merged), readMain: reader(main), ...extra };
}

test("W1-T12509 criterion 3: a counter that throws, or a tree it cannot read, is unread with the gate named, never clean", () => {
  // The source-size counter refuses a row that is not a whole number.
  const thrown = judgeMergedRatchets(memory({ [SIZE]: json({ "src/a.ts": "many" }), "src/a.ts": "x\n" }, { [SIZE]: json({ "src/a.ts": 5 }), "src/a.ts": "" }));
  assert.equal(thrown.verdict, "unread");
  assert.match(thrown.reason ?? "", /^source-size: a ratchet counter threw: .*must carry a non-negative integer/);
  assert.ok(!thrown.counted.includes("source-size"));

  // A population the read could not list: each population gate the merge touches is unread, by name.
  const unlisted = judgeMergedRatchets(memory({ "src/a.ts": "x\n" }, {}, { populationUnread: "git ls-tree -l exited 128" }));
  assert.equal(unlisted.verdict, "unread");
  assert.match(unlisted.reason ?? "", /deps-interface: the tree could not be read: git ls-tree -l exited 128/);
  assert.deepEqual(unlisted.counted, ["clock-signature", "source-size", "fixture-copy", "claude-md-budget"]);

  // The same through the production read, when git cannot list the merged tree.
  const fx = landTwo({ "src/one.ts": "export const one = 1;\n" }, { "src/two.ts": "export const two = 2;\n" }, { "src/three.ts": "export const three = 3;\n" },
    (run) => (args, stdin) => (args.includes("-l") ? { status: 128, stdout: "", stderr: "fatal: not a tree object" } : run(args, stdin)));
  const read = fx.onto(2, fx.m1);
  assert.equal(read.verdict, "unread");
  assert.match(read.reason ?? "", /deps-interface: the tree could not be read: git ls-tree -l exited 128: fatal: not a tree object/);

  // A crossing on a counted gate still holds when another gate is unread.
  const held = judgeMergedRatchets(memory(
    { [SIZE]: json({ "src/a.ts": 1 }), "src/a.ts": "x\ny\n" }, { [SIZE]: json({ "src/a.ts": 1 }), "src/a.ts": "x\n" }, { populationUnread: "listing failed" }));
  assert.equal(held.verdict, "crossing");
  assert.match(held.reason ?? "", /deps-interface: the tree could not be read: listing failed/);
});

test("W1-T12509 criterion 4: the uncounted gates are comment-load (advisory), coverage and mutation (run-derived), and three whose counters cannot run here", () => {
  assert.deepEqual(UNCOUNTED_RATCHET_GATES.map((u) => `${u.gate}:${u.class}`),
    ["comment-load:advisory", "coverage:run-derived", "mutation:run-derived", "learnings-budget:needs-worktree", "affected-reach:test-suite-counter", "house-layout:import-ring"]);
  for (const gate of COUNTED_RATCHET_GATES) assert.ok(!UNCOUNTED_RATCHET_GATES.some((u) => u.gate === gate), `${gate} is counted, so it is not named uncounted`);
  for (const u of UNCOUNTED_RATCHET_GATES.filter((g) => g.class !== "advisory" && g.class !== "run-derived")) assert.ok(u.reason, u.gate);
});

function withoutListing(input: MergedRatchetInputs): MergedRatchetInputs {
  const copy = { ...(input as Extract<MergedRatchetInputs, { changed: string[] }>) };
  delete copy.populationFiles;
  return copy;
}

test("W1-T12509 criterion 5: invariant:no-clean-without-count — every counted gate is counted on both trees, unread by name, or the verdict is not clean", () => {
  const judgements = [
    judgeMergedRatchets(memory({ "src/a.ts": "x\n" }, {})),
    judgeMergedRatchets(memory({ "src/a.ts": "x\n" }, {}, { populationUnread: "listing failed" })),
    judgeMergedRatchets(withoutListing(memory({ "test/a.test.ts": "x\n" }, {}))),
    judgeMergedRatchets({ mainSha: "m", headSha: "h", changed: ["src/a.ts"], measuredFiles: [], readMerged: () => { throw new Error("blob read failed"); }, readMain: () => null }),
  ];
  for (const j of judgements) {
    for (const gate of COUNTED_RATCHET_GATES) {
      const unreadByName = (j.reason ?? "").split("; ").some((part) => part.startsWith(`${gate}: `));
      assert.ok(j.counted.includes(gate) !== unreadByName, `${gate}: counted or unread by name, never both and never neither`);
    }
    if (j.verdict === "clean") assert.deepEqual(j.counted, [...COUNTED_RATCHET_GATES]);
    else assert.ok(j.counted.length < COUNTED_RATCHET_GATES.length || j.rows.length > 0, "a verdict that is not clean has a row or an unread gate");
  }
  assert.deepEqual(judgements.map((j) => j.verdict), ["clean", "unread", "unread", "unread"]);
  // With no listing of test/, fixture-copy is unread rather than counted from nothing.
  assert.match(judgements[2]!.reason ?? "", /^fixture-copy: the tree could not be read: no listing of test\/ was read$/);
});
