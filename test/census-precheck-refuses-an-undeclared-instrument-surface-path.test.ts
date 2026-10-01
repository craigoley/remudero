/**
 * THE PRE-PUSH CENSUS PRECHECK ASKS THE INSTRUMENT-SURFACE QUESTION — W1-T5101.
 *
 * #8235 added a workflow-referenced script with no INSTRUMENT_SURFACE entry and no reasoned
 * INSTRUMENT_SURFACE_EXCLUSIONS entry: every scoped local gate and the pre-push census-precheck
 * passed, then CI's test/instrument-surface-completeness.test.ts went red. The derivation now lives in
 * scripts/lib/instrument-surface-census.mjs, which both that suite and census-precheck consume.
 *
 * The pure cases drive `evaluateInstrumentSurface` over in-memory trees through the SAME shared
 * derivation CI uses; the two real-shell-out cases run `main` on fixture git repositories through the
 * default child seam, which spawns the real repo's child over the fixture tree.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { gitRepo } from "./helpers/git-repo.js";
import { INSTRUMENT_SURFACE } from "../src/lib/review.js";
import { censusPushRefusal } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { evaluateInstrumentSurface, main, measureViaChild } from "../scripts/census-precheck.mjs";
// @ts-ignore the executable .mjs module has no declaration file.
import { declaredInstrumentRe, deriveInstrumentCandidates, findUnexplainedGaps } from "../scripts/lib/instrument-surface-census.mjs";

type Tree = Record<string, string>;
type Side = { candidates: string[]; gaps: string[] };

const WORKFLOW = ".github/workflows/ci.yml";
const BASE_TREE: Tree = {
  [WORKFLOW]: "jobs:\n  a:\n    steps:\n      - run: node scripts/old-ratchet.mjs\n",
  "scripts/old-ratchet.mjs": "export {};\n",
  "package.json": '{"scripts":{}}\n',
};
const newGateTree = (script: string): Tree => ({
  ...BASE_TREE,
  [WORKFLOW]: `${BASE_TREE[WORKFLOW]}      - run: node ${script}\n`,
  [script]: "export {};\n",
});

/** One side of the measurement over an in-memory tree, by the derivation CI's census suite runs. */
function side(tree: Tree, exclusions: Record<string, string>): Side {
  const candidates: string[] = deriveInstrumentCandidates({
    tracked: new Set(Object.keys(tree)),
    readText: (p: string) => tree[p] ?? null,
  });
  return { candidates, gaps: findUnexplainedGaps(candidates, declaredInstrumentRe(INSTRUMENT_SURFACE), exclusions) };
}

function evaluate(head: Tree, base: Tree, exclusions: Record<string, string> = {}) {
  const changed = [...new Set([...Object.keys(head), ...Object.keys(base)])].filter((p) => head[p] !== base[p]);
  return evaluateInstrumentSurface({
    changed,
    measureInstrumentSurface: () => ({ head: side(head, exclusions), base: side(base, exclusions) }),
  });
}

test("W1-T5101: a diff that adds a workflow-referenced script with no declaration or exclusion is refused naming both places to record it", () => {
  const found = evaluate(newGateTree("scripts/new-gate.mjs"), BASE_TREE);
  assert.equal(found.unmeasured, null);
  assert.equal(found.violations.length, 1, found.violations.join("\n"));
  const row = found.violations[0];
  assert.ok(!row.includes("\n"), "the row, TO FIX text included, is one physical line");
  assert.match(row, /^instrument-surface: scripts\/new-gate\.mjs is neither on INSTRUMENT_SURFACE nor excused in INSTRUMENT_SURFACE_EXCLUSIONS/);
  assert.match(row, /TO FIX: add a "\^scripts\/new-gate\\\.mjs\$" pattern to INSTRUMENT_SURFACE/);
  assert.match(row, /both in src\/lib\/review\.ts$/);
});

test("W1-T5101: the same diff with the path declared on INSTRUMENT_SURFACE passes", () => {
  const found = evaluate(newGateTree("scripts/new-ratchet.mjs"), BASE_TREE);
  assert.deepEqual(found, { violations: [], unmeasured: null });
});

test("W1-T5101: the same diff with a reasoned exclusion passes and a blank reason does not", () => {
  const head = newGateTree("scripts/new-gate.mjs");
  assert.deepEqual(evaluate(head, BASE_TREE, { "scripts/new-gate.mjs": "a dev helper, never gate logic" }), {
    violations: [],
    unmeasured: null,
  });
  assert.equal(evaluate(head, BASE_TREE, { "scripts/new-gate.mjs": "" }).violations.length, 1);
  assert.equal(evaluate(head, BASE_TREE, { "scripts/new-gate.mjs": "   " }).violations.length, 1);
});

test("W1-T5101: a gap the merge base already carries is not caused by this branch", () => {
  const base = newGateTree("scripts/new-gate.mjs");
  assert.equal(side(base, {}).gaps.length, 1, "control: the base really does carry the gap");
  const head = { ...base, "package.json": '{"scripts":{"x":"node scripts/old-ratchet.mjs"}}\n' };
  assert.deepEqual(evaluate(head, base), { violations: [], unmeasured: null });
});

test("W1-T5101: a diff touching no workflow, manifest, script or reviewer path skips the derivation", () => {
  let calls = 0;
  const found = evaluateInstrumentSurface({
    changed: ["src/lib/widget.ts", "plan/tasks.d/x.yaml", "test/x.test.ts", "docs/scripts/readme.md"],
    measureInstrumentSurface: () => {
      calls++;
      throw new Error("the derivation must not run");
    },
  });
  assert.deepEqual(found, { violations: [], unmeasured: null });
  assert.equal(calls, 0);
  // Control: the same seam IS reached by an in-scope path, and an in-scope diff with no seam is not a skip.
  assert.equal(evaluateInstrumentSurface({ changed: ["scripts/x.mjs"], measureInstrumentSurface: () => ({}) as never }).unmeasured !== null, true);
  assert.equal(calls, 0);
  assert.equal(evaluateInstrumentSurface({ changed: ["package.json"] }).unmeasured, "no measurement supplied");
});

/** A fixture repo whose `work` branch changes `change` over `seed` committed on main, for `main` to measure. */
function fixtureRepo(seed: Tree, change: Tree): string {
  const repo = gitRepo({ kind: "instrument-surface" });
  const write = (tree: Tree) => {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
      writeFileSync(join(repo.dir, path), text);
    }
  };
  write(seed);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the base");
  repo.git("switch", "--quiet", "-c", "work");
  write(change);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the change");
  return repo.dir;
}

function capture(t: { mock: { method: (o: object, k: string, f: (...a: unknown[]) => void) => unknown } }) {
  const err: string[] = [];
  const out: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void err.push(a.join(" ")));
  t.mock.method(console, "log", (...a: unknown[]) => void out.push(a.join(" ")));
  return { err, out };
}

const HOUSE_NAMES = 'export const dir = "plan/tasks.d";\n';

test("W1-T5101: a tree the derivation cannot read is reported not measured, exits 2 and never prints OK", (t) => {
  assert.deepEqual(
    evaluateInstrumentSurface({
      changed: ["scripts/x.mjs"],
      measureInstrumentSurface: () => {
        throw new Error("package.json is not JSON");
      },
    }),
    { violations: [], unmeasured: "package.json is not JSON" },
  );
  const io = capture(t);
  const repo = fixtureRepo({ "src/lib/a.ts": HOUSE_NAMES }, { "scripts/x.mjs": "export {};\n" });
  const unreadable = () => {
    throw new Error("the tree cannot be read");
  };
  assert.equal(main(["--root", repo, "--base", "main"], { measure: unreadable }), 2);
  assert.ok(io.err.some((l) => /^census-precheck: instrument-surface NOT MEASURED - the tree cannot be read$/.test(l)), io.err.join("\n"));
  assert.ok(!io.out.some((l) => /census-precheck: OK/.test(l)), "never an OK line");
  // Another census refusing too: exit 1, and the not-measured line still prints, after the rows.
  const both = fixtureRepo({ "src/lib/a.ts": HOUSE_NAMES }, { "src/lib/b.ts": HOUSE_NAMES, "scripts/x.mjs": "export {};\n" });
  io.err.length = 0;
  assert.equal(main(["--root", both, "--base", "main"], { measure: unreadable }), 1);
  assert.match(io.err.at(-1) ?? "", /instrument-surface NOT MEASURED - the tree cannot be read$/);
});

test("W1-T5101: a derivation that finds no candidates is not measured rather than clean", () => {
  const empty: Side = { candidates: [], gaps: [] };
  const found = evaluateInstrumentSurface({ changed: [WORKFLOW], measureInstrumentSurface: () => ({ head: empty, base: empty }) });
  assert.deepEqual(found.violations, []);
  assert.match(found.unmeasured ?? "", /found no candidates at all/);
});

test("W1-T5101: a child that prints malformed output or is stopped on its time bound is not measured", () => {
  const run = (res: object) => () => measureViaChild({ root: ".", mergeBase: "HEAD", run: () => res });
  const good = JSON.stringify({ head: { candidates: ["a"], gaps: [] }, base: { candidates: ["a"], gaps: [] } });
  assert.equal(run({ status: 0, stdout: `${good}\n` })().head.candidates[0], "a", "control: well-formed output is read");
  assert.throws(run({ status: 0, stdout: "not json" }), /not JSON/);
  assert.throws(run({ status: 0, stdout: '{"head":{},"base":{}}' }), /not \{ head, base \}/);
  assert.throws(run({ status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) }), /could not run to completion/);
  assert.throws(run({ status: null, signal: "SIGKILL" }), /ended by SIGKILL/);
  assert.throws(run({ status: 1, stdout: "", stderr: "boom" }), /exited 1: boom/);
  // Each arm surfaces through the check as not measured, never as a clean tree.
  const found = evaluateInstrumentSurface({
    changed: ["scripts/x.mjs"],
    measureInstrumentSurface: run({ status: 0, stdout: "not json" }),
  });
  assert.deepEqual(found.violations, []);
  assert.match(found.unmeasured ?? "", /not JSON/);
});

test("W1-T5101: a refusal row keeps the shape the census push rung parses and offers the reviewer file as its remedy", (t) => {
  const io = capture(t);
  const repo = fixtureRepo(BASE_TREE, newGateTree("scripts/new-gate.mjs"));
  const gap: Side = { candidates: ["scripts/new-gate.mjs"], gaps: ["scripts/new-gate.mjs"] };
  const clean: Side = { candidates: ["scripts/old-ratchet.mjs"], gaps: [] };
  assert.equal(main(["--root", repo, "--base", "main"], { measure: () => ({ head: gap, base: clean }) }), 1);
  const refusal = censusPushRefusal(new Error(io.err.join("\n")));
  assert.deepEqual(refusal?.censuses, ["instrument-surface"]);
  assert.deepEqual(refusal?.offeredBaselines, ["src/lib/review.ts"]);

  // A not-measured line after the rows must not drop a row: a second census row precedes it.
  io.err.length = 0;
  const both = fixtureRepo({ "src/lib/a.ts": HOUSE_NAMES }, { "src/lib/b.ts": HOUSE_NAMES, "scripts/x.mjs": "export {};\n" });
  const unreadable = () => {
    throw new Error("the tree cannot be read");
  };
  assert.equal(main(["--root", both, "--base", "main"], { measure: unreadable }), 1);
  assert.ok(io.err.some((l) => /NOT MEASURED/.test(l)), "control: the not-measured line printed");
  assert.deepEqual(censusPushRefusal(new Error(io.err.join("\n")))?.censuses, ["house-layout"]);
});

test("W1-T5101: the CLI run on a real fixture git repository refuses an undeclared path and passes a declared one", (t) => {
  const io = capture(t);
  assert.equal(main(["--root", fixtureRepo(BASE_TREE, newGateTree("scripts/new-gate.mjs")), "--base", "main"]), 1, io.err.join("\n"));
  assert.ok(io.err.some((l) => /instrument-surface: scripts\/new-gate\.mjs is neither/.test(l)), io.err.join("\n"));
  io.err.length = 0;
  assert.equal(main(["--root", fixtureRepo(BASE_TREE, newGateTree("scripts/new-ratchet.mjs")), "--base", "main"]), 0, io.err.join("\n"));
  assert.ok(io.out.some((l) => /^census-precheck: OK/.test(l)));
});

test("W1-T5101: a real child run on a directory that is not a git repository is not measured", (t) => {
  const io = capture(t);
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}instrument-surface-not-git-`));
  assert.throws(() => measureViaChild({ root: dir, mergeBase: "HEAD" }), /the derivation child exited 1: .*not a git repository/s);
  const found = evaluateInstrumentSurface({
    changed: ["scripts/x.mjs"],
    measureInstrumentSurface: () => measureViaChild({ root: dir, mergeBase: "HEAD" }),
  });
  assert.deepEqual(found.violations, []);
  assert.match(found.unmeasured ?? "", /not a git repository/);
  assert.equal(main(["--root", dir, "--base", "main"]), 2);
  assert.ok(!io.out.some((l) => /census-precheck: OK/.test(l)));
});
