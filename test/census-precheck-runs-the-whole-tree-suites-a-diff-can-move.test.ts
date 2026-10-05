import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore the executable .mjs module has no declaration file.
import * as precheck from "../scripts/census-precheck.mjs";

const CYCLE = "test/cycle-ratchet.test.ts";
const SIZE = "test/source-size-baseline-is-enforced.test.ts";
const CITATION = "test/citation-anchor-census.test.ts";
const LEDGER = "test/ledger-rotation.test.ts";

type Files = Record<string, string | null>;

/** Runs the evaluator over `changed` with head/base texts from `head`/`base`; every runSuites call is recorded. */
function evaluate(changed: string[], head: Files = {}, base: Files = {}, behave: (files: string[]) => string[] = () => []) {
  const runs: string[][] = [];
  const result = precheck.evaluateAdmittedCensusSuites({
    changed,
    readHead: (path: string) => head[path] ?? null,
    readBase: (path: string) => base[path] ?? null,
    loadMembers: () => [],
    runSuites: (files: string[]) => { runs.push(files); return behave(files); },
  });
  return { result, runs };
}

test("test/census-precheck-runs-the-whole-tree-suites-a-diff-can-move.test.ts: a ring-closing import starts cycle-ratchet alone, a src/lib import of src/cli starts source-size, a diff touching neither starts no structural child", () => {
  // A new import in a src file that could close a ring starts cycle-ratchet, in a child of its own.
  const ring = evaluate(
    ["src/lib/a.ts"],
    { "src/lib/a.ts": 'import { b } from "./b.js";\nimport { c } from "./c.js";' },
    { "src/lib/a.ts": 'import { b } from "./b.js";' },
  );
  assert.deepEqual(ring.runs, [[CYCLE]]);

  // A src/lib file that gains an import of src/cli starts source-size (and cycle-ratchet, the import being new).
  const layered = evaluate(
    ["src/lib/a.ts"],
    { "src/lib/a.ts": 'import { run } from "../cli/registry.js";' },
    { "src/lib/a.ts": "" },
  );
  assert.deepEqual(layered.runs, [[CYCLE], [SIZE]]);

  // src/lib importing the task runner is the same layering breach.
  assert.deepEqual(
    evaluate(["src/lib/x/a.ts"], { "src/lib/x/a.ts": 'import "../../run-task.js";' }, { "src/lib/x/a.ts": "" }).runs,
    [[CYCLE], [SIZE]],
  );

  // A new import that stays inside src/lib, or a cli import from a file outside src/lib, does not start source-size.
  assert.deepEqual(
    evaluate(["src/lib/a.ts"], { "src/lib/a.ts": 'import { x } from "./x.js";' }, { "src/lib/a.ts": "" }).runs,
    [[CYCLE]],
  );
  assert.deepEqual(
    evaluate(["src/run-task.ts"], { "src/run-task.ts": 'import { r } from "./cli/registry.js";' }, { "src/run-task.ts": "" }).runs,
    [[CYCLE]],
  );

  // A diff touching neither starts no structural child: no new import, removed imports, or a non-source file.
  const same = 'import { b } from "./b.js";';
  assert.deepEqual(evaluate(["src/lib/a.ts"], { "src/lib/a.ts": same + "\nconst x = 2;" }, { "src/lib/a.ts": same }).runs, []);
  assert.deepEqual(evaluate(["src/lib/a.ts"], { "src/lib/a.ts": "" }, { "src/lib/a.ts": same }).runs, []);
  assert.deepEqual(evaluate(["README.md", "docs/a.md"], { "README.md": 'import x from "./y.js"' }).runs, []);
  assert.deepEqual(evaluate(["test/a.test.ts"], { "test/a.test.ts": 'import x from "../src/cli/registry.js"' }).runs, []);
});

test("W1-T5693: the structural suites' own files, registries and plan shards start their suite", () => {
  for (const [path, suites] of [
    [".dependency-cruiser.cjs", [[CYCLE], [SIZE]]],
    ["scripts/cycle-baseline.json", [[CYCLE]]],
    ["scripts/cycle-ratchet.mjs", [[CYCLE]]],
    ["scripts/source-size-ratchet.mjs", [[SIZE]]],
    ["src/lib/ci-parity.ts", [[SIZE]]],
    ["plan/tasks.d/W1-T1-x.yaml", [[CITATION]]],
    ["MASTER-PLAN.md", [[CITATION]]],
    ["scripts/citation-anchor-census.mjs", [[CITATION]]],
  ] as [string, string[][]][]) {
    assert.deepEqual(evaluate([path], { [path]: "" }, { [path]: "" }).runs, suites, path);
  }
});

test("W1-T5693: each structural suite runs in its own child, so one that cannot finish does not read the others NOT MEASURED", () => {
  const changed = ["src/lib/a.ts", "plan/tasks.d/W1-T1-x.yaml"];
  const head = { "src/lib/a.ts": 'import { run } from "../cli/registry.js";' };
  const found = evaluate(changed, head, { "src/lib/a.ts": "" }, (files) => {
    if (files.includes(CYCLE)) throw new Error("the census suite child could not run to completion: ETIMEDOUT");
    return files.includes(SIZE) ? [SIZE] : [];
  });
  assert.deepEqual(found.runs, [[CYCLE], [SIZE], [CITATION]]);
  assert.match(found.result.unmeasured, /ETIMEDOUT/);
  assert.equal(found.result.violations.length, 1);
  assert.match(found.result.violations[0], /^census-suite: test\/source-size-baseline-is-enforced\.test\.ts fails — run npm run census:source-size/);

  // The literal-triggered suites still share one child; the structural ones stay out of it.
  const mixed = evaluate(
    ["src/lib/ledger.ts", "src/lib/a.ts"],
    { "src/lib/a.ts": 'import { b } from "./b.js";' },
    { "src/lib/a.ts": "" },
  );
  assert.equal(mixed.runs.length, 2);
  assert.ok(mixed.runs[0].includes(LEDGER) && !mixed.runs[0].includes(CYCLE));
  assert.deepEqual(mixed.runs[1], [CYCLE]);
});

test("W1-T5693: the structural suites expose executable scripts and have left the CI-only baseline", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  const ciOnly: string[] = JSON.parse(readFileSync(join(root, precheck.PRECHECK_PARITY_BASELINE), "utf8")).ciOnly;
  for (const testFile of [CYCLE, SIZE, CITATION]) {
    const member = precheck.PRECHECK_TRIGGERED_SUITES.find((m: { testFile: string }) => m.testFile === testFile);
    assert.equal(member?.structural, true, testFile);
    assert.deepEqual(precheck.PRECHECK_PARITY[testFile], { run: member.script });
    assert.ok(scripts[member.script].endsWith(testFile), testFile);
    assert.ok(!ciOnly.includes(testFile), `${testFile} is run, so it is not CI-only`);
  }
});
