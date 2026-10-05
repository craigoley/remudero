import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as precheck from "../scripts/census-precheck.mjs";

const LEDGER = "test/ledger-rotation.test.ts";
const UNION = "test/a-union-read-of-an-unretained-step-is-refused.test.ts";
const SPEND = "test/spend-is-counted-once-at-its-producer.test.ts";
const ENV = "test/env-var-registry.test.ts";
const ERROR = "test/error-subclass-census.test.ts";
const STEPS = [LEDGER, UNION, SPEND];
const SOURCE = "src/lib/sweep-plan.ts";

function evaluate(head: string | null, base: string | null = "", changed = [SOURCE], fail: string[] = []) {
  const runs: string[][] = [];
  const reads: string[] = [];
  const result = precheck.evaluateAdmittedCensusSuites({
    changed,
    readHead: (path: string) => { reads.push(path); return path === SOURCE ? head : null; },
    readBase: (path: string) => { reads.push(path); return path === SOURCE ? base : null; },
    loadMembers: () => [],
    runSuites: (files: string[]) => { runs.push(files); return fail; },
  });
  return { result, runs, reads };
}

test("test/census-precheck-runs-the-suites-a-new-literal-joins.test.ts: the #9041-shaped step diff runs and refuses ledger and spend; env additions run; no new literal starts no triggered child", () => {
  const base = 'if (row.step === "sweep.existing") return true;';
  const head = base + '\nif (row.step === "sweep.plan_round.pushed") return true;\nlog("sweep.plan_round.worker", { total_cost_usd: 3 });';
  const found = evaluate(head, base, [SOURCE], [LEDGER, SPEND]);
  assert.deepEqual(found.runs, [STEPS]);
  assert.equal(found.result.unmeasured, null);
  assert.equal(found.result.violations.length, 2);
  assert.match(found.result.violations[0], /^census-suite: test\/ledger-rotation\.test\.ts fails — run npm run census:ledger-rotation.*src\/lib\/ledger\.ts/);
  assert.match(found.result.violations[1], /census:spend.*src\/lib\/spend-rows\.ts/);
  assert.ok(found.reads.every((path) => path === SOURCE), "unchanged registry files are never read to select suites");
  assert.deepEqual(evaluate("process.env.RMD_NEW_CENSUS_TOKEN", "").runs, [[ENV]]);
  assert.deepEqual(evaluate("const value = 2;", "const value = 1;").runs, []);
});

test("W1-T5692: each step spelling joins all three ledger censuses; existing or removed literals do not", () => {
  for (const text of [
    'row.step === "fresh.step"', "step === 'fresh.step'", 'case "fresh.step": break;',
    'log("fresh.step", {})', "deps.logWorker('fresh.step', {})", '({ step: "fresh.step" })',
    'log(`fresh.step`, {})',
  ]) {
    assert.deepEqual(evaluate(text).runs, [STEPS], text);
    assert.deepEqual(evaluate(text + "\nconst value = 2;", text).runs, [], text);
    assert.deepEqual(evaluate(null, text).runs, [], text);
  }
  assert.deepEqual(evaluate('log("fresh.step", {})', null).runs, [STEPS]);
  assert.deepEqual(evaluate('const unrelated = "fresh.step";').runs, []);
  assert.deepEqual(evaluate('log("fresh.step", {})', "", ["test/example.test.ts"]).runs, []);
});

test("W1-T5692: env and direct Error class additions are compared with base token sets", () => {
  for (const text of ["process.env.RMD_NEW_TOKEN", "process.env.REMUDERO_NEW_TOKEN", "'RMD_NEW_TOKEN'"]) {
    assert.deepEqual(evaluate(text).runs, [[ENV]]);
    assert.deepEqual(evaluate(text + "; changed();", text).runs, []);
  }
  assert.deepEqual(evaluate("class FreshError extends Error {}").runs, [[ERROR]]);
  assert.deepEqual(evaluate("class FreshError extends Errorish {}").runs, []);
  assert.deepEqual(evaluate("class FreshError extends RmdError {}").runs, []);
  assert.deepEqual(evaluate("class FreshError extends Error {}", "class FreshError extends Error {}").runs, []);
});

test("W1-T5692: changing a census registry starts its suites even without literal growth", () => {
  for (const [path, files] of [
    ["src/lib/ledger.ts", STEPS], ["src/lib/spend-rows.ts", STEPS],
    ["src/lib/config-schema.ts", [ENV]], ["scripts/error-subclass-baseline.json", [ERROR]],
  ] as [string, string[]][]) assert.deepEqual(evaluate("", "", [path]).runs, [files]);
});

test("W1-T5692: triggered and admitted suites share one deduplicated child; unreadable content and failed children name their reason", () => {
  const runs: string[][] = [];
  const input = {
    changed: [SOURCE], readHead: () => 'log("fresh.step", {}); process.env.RMD_NEW_TOKEN; class FreshError extends Error {}',
    readBase: () => "", loadMembers: () => [{ testFile: LEDGER, script: "census:ledger-rotation", walks: ["src/"] }],
    runSuites: (files: string[]) => { runs.push(files); return []; },
  };
  assert.deepEqual(precheck.evaluateAdmittedCensusSuites(input), { violations: [], unmeasured: null });
  assert.deepEqual(runs, [[...STEPS, ENV, ERROR]]);
  const unread = precheck.evaluateAdmittedCensusSuites({ ...input, readHead: () => { throw new Error("cannot read head"); } });
  assert.deepEqual(unread, { violations: [], unmeasured: "cannot read head" });
  const failed = precheck.evaluateAdmittedCensusSuites({ ...input, runSuites: () => { throw new Error("child timed out"); } });
  assert.deepEqual(failed, { violations: [], unmeasured: "child timed out" });
  const empty = precheck.evaluateAdmittedCensusSuites({ ...input, changed: [], loadMembers: () => { throw new Error("must not load"); } });
  assert.deepEqual(empty, { violations: [], unmeasured: null });
});

test("W1-T5692: triggered suite registrations expose executable scripts and leave the CI-only baseline", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  const ciOnly = JSON.parse(readFileSync(join(root, precheck.PRECHECK_PARITY_BASELINE), "utf8")).ciOnly;
  for (const member of precheck.PRECHECK_TRIGGERED_SUITES) {
    assert.deepEqual(precheck.PRECHECK_PARITY[member.testFile], { run: member.script });
    assert.equal(typeof member.trigger, "function");
    assert.ok(scripts[member.script].endsWith(member.testFile));
    assert.ok(!ciOnly.includes(member.testFile));
  }
  assert.equal(precheck.PRECHECK_TRIGGERED_SUITES.length, 5);
});

test("W1-T5692: the CLI supplies head and merge-base readers to the triggered suites", (t) => {
  const repo = gitRepo({ kind: "literal-census-precheck" });
  try {
    mkdirSync(join(repo.dir, "src", "lib"), { recursive: true });
    writeFileSync(join(repo.dir, SOURCE), 'log("sweep.existing", {});');
    repo.git("add", "src");
    repo.git("commit", "--quiet", "-m", "base source");
    repo.git("switch", "--quiet", "-c", "work");
    writeFileSync(join(repo.dir, SOURCE), 'log("sweep.plan_round.worker", { total_cost_usd: 3 });');
    const runs: string[][] = [];
    const errors: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.join(" ")));
    assert.equal(precheck.main(["--root", repo.dir, "--base", "main"], {
      admitted: () => [],
      runSuites: ({ root, files }: { root: string; files: string[] }) => {
        assert.equal(root, repo.dir);
        runs.push(files);
        return [SPEND];
      },
    }), 1);
    assert.deepEqual(runs, [STEPS]);
    assert.ok(errors.some((line) => line.includes("census:spend; declare SPEND_STEP_ROLES in src/lib/spend-rows.ts")));
  } finally {
    repo.cleanup();
  }
});

test("W1-T5692: the existing real suite child reports a triggered failure", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-literal-census-"));
  try {
    mkdirSync(join(root, "test"));
    const file = "test/literal.test.ts";
    writeFileSync(join(root, file), 'import { test } from "node:test"; import assert from "node:assert/strict"; test("a registration is required", () => assert.equal(1, 2));');
    assert.deepEqual(precheck.runCensusSuitesViaChild({ root, files: [file] }), [file]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
