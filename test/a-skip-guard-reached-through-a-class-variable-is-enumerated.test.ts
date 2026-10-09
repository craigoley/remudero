import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error — the executable .mjs has no declaration output.
import * as workflowGuard from "../scripts/workflow-guard-mutation-ratchet.mjs";

interface SkipGuard {
  key: string;
  job: string;
  line: number;
  text: string;
  form: "if" | "or" | "case";
}

const { enumerateSkipGuards, mutateGuardLine, ciReadingSuites } = workflowGuard as {
  enumerateSkipGuards(text: string): SkipGuard[];
  mutateGuardLine(text: string, guard: SkipGuard): string;
  ciReadingSuites(): string[];
};

const proof = "test/a-skip-guard-reached-through-a-class-variable-is-enumerated.test.ts";
const step = (body: string) => `jobs:\n  fixture:\n    steps:\n      - run: |\n${body.split("\n").map((line) => `          ${line}`).join("\n")}\n`;
const body = `CLASS=SOURCE
if [ "$INPUT" = "skip" ]; then
  CLASS=SKIP
fi
if [ "$INPUT" = "unrelated" ]; then
  OTHER=SKIP
fi
echo classified
echo preparing
echo ready
case "$CLASS" in
  SKIP|DOCS)
    echo skipped
    exit 0
    ;;
  *) echo ran ;;
esac
echo finished`;

test(`${proof}: today's workflow enumerates both W1-T5700 guards and their skip case as inherited`, () => {
  const text = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const guards = enumerateSkipGuards(text).filter((guard) => guard.job === "test-slow-shard");
  const baseline = JSON.parse(readFileSync(new URL("../scripts/workflow-guard-mutation-baseline.json", import.meta.url), "utf8")) as {
    guards: Record<string, { reason: string }>;
  };
  for (const expected of [
    'if [ "$CLASS" = "TEST_ONLY" ]; then',
    'if [ "$(printf \'%s\\n\' "$TEST_ONLY_RUN" | head -n 1)" = "files" ]; then',
    'case "$CLASS" in',
  ]) {
    const guard = guards.find((candidate) => candidate.text.trim() === expected);
    assert.ok(guard, `missing W1-T5700 guard: ${expected}`);
    assert.equal(text.split("\n")[guard.line - 1], guard.text);
    assert.equal(guard.key, `test-slow-shard#1: ${expected}`);
    assert.match(baseline.guards[guard.key].reason, /inherited/i);
    if (expected.startsWith("case")) assert.equal(guard.form, "case");
  }
});

test(`${proof}: an assignment feeding a later skip case counts and an unrelated assignment does not`, () => {
  const guards = enumerateSkipGuards(step(body));
  assert.deepEqual(guards.map((guard) => guard.text.trim()), [
    'if [ "$INPUT" = "skip" ]; then',
    'case "$CLASS" in',
  ]);
  const adjacent = step('if [ "$OTHER" ]; then\n  UNRELATED=1\nfi\ncase "$CLASS" in\n  SKIP) exit 0 ;;\n  *) echo ran ;;\nesac');
  assert.deepEqual(enumerateSkipGuards(adjacent).map((guard) => guard.form), ["case"]);
});

test(`${proof}: variable readers remain inside their own step and job`, () => {
  const writer = 'if [ "$INPUT" = "skip" ]; then\n  CLASS=SKIP\nfi';
  const reader = 'case "${CLASS}" in\n  SKIP) exit 0 ;;\nesac';
  const sameJob = step(writer) + `      - run: |\n${reader.split("\n").map((line) => `          ${line}`).join("\n")}\n`;
  for (const text of [sameJob, step(writer) + step(reader).replace("jobs:\n", "").replace("fixture:", "other:")]) {
    assert.deepEqual(enumerateSkipGuards(text).map((guard) => guard.form), ["case"]);
  }
});

test(`${proof}: nested block boundaries do not depend on shell indentation`, () => {
  const text = step('if [ "$OUTER" ]; then\nif [ "$INNER" ]; then\necho branch\nfi\nexit 0\nfi');
  assert.deepEqual(enumerateSkipGuards(text).map((guard) => guard.text.trim()), ['if [ "$OUTER" ]; then']);
});

test(`${proof}: assignment links can reach a later skip if through another variable-linked guard`, () => {
  const text = step(`if [ "$INPUT" = "skip" ]; then
  FIRST=SKIP
fi
echo separator
echo separator
echo separator
echo separator
echo separator
if [ "\${FIRST:-}" = "SKIP" ]; then
  SECOND=SKIP
fi
echo separator
echo separator
echo separator
echo separator
echo separator
if [ "$SECOND" = "SKIP" ]; then
  exit 0
fi`);
  assert.equal(enumerateSkipGuards(text).length, 3);
});

test(`${proof}: each variable-linked guard and skip case mutant forces its branch in bash`, () => {
  const text = step(body);
  const run = (workflow: string) => {
    const shell = workflow.split("      - run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
    const result = spawnSync("bash", ["-c", shell], { encoding: "utf8", env: { ...process.env, INPUT: "run" } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(run(text), /ran\nfinished/);
  const guards = enumerateSkipGuards(text);
  assert.equal(guards.length, 2);
  for (const guard of guards) {
    const mutant = mutateGuardLine(text, guard);
    assert.match(run(mutant), /skipped/);
    assert.doesNotMatch(run(mutant), /ran|finished/);
    const before = text.split("\n");
    assert.deepEqual(mutant.split("\n").flatMap((line, index) => line === before[index] ? [] : [index + 1]), [guard.line]);
  }
});

test(`${proof}: a default skip case is forced even when a preceding arm would run`, () => {
  const text = step('case "$CLASS" in\n  SOURCE) echo ran ;;\n  *) echo skipped; exit 0 ;;\nesac');
  const [guard] = enumerateSkipGuards(text);
  assert.ok(guard);
  assert.equal(guard.form, "case");
  const mutant = mutateGuardLine(text, guard);
  const shell = mutant.split("      - run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const result = spawnSync("bash", ["-c", shell], { encoding: "utf8", env: { ...process.env, CLASS: "SOURCE" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "skipped\n");
});

test(`${proof}: both nested reclassification guards receive executable branch-forcing mutants`, () => {
  const text = step(`if [ "$CLASS" = "TEST_ONLY" ]; then
  if [ "$RUN" = "files" ]; then
    CLASS=SKIP
  fi
fi
echo preparing
echo waiting
echo waiting
echo waiting
echo waiting
case "$CLASS" in
  SKIP) echo skipped; exit 0 ;;
  *) echo ran ;;
esac`);
  const guards = enumerateSkipGuards(text);
  assert.deepEqual(guards.map((guard) => guard.form), ["if", "if", "case"]);
  for (const [index, env] of [{ CLASS: "SOURCE", RUN: "files" }, { CLASS: "TEST_ONLY", RUN: "full" }].entries()) {
    for (const [workflow, expected] of [[text, "ran"], [mutateGuardLine(text, guards[index]), "skipped"]]) {
      const shell = workflow.split("      - run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
      const result = spawnSync("bash", ["-c", shell], { encoding: "utf8", env: { ...process.env, ...env } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`${expected}\\n$`));
    }
  }
});

test(`${proof}: case mutants match quoted literals and bracket patterns`, () => {
  for (const pattern of ["[Ss]KIP", "[!a-z]", '"don\'t"', "'[a]'"]) {
    const text = step(`case "$CLASS" in\n  ${pattern}) echo skipped; exit 0 ;;\n  *) echo ran ;;\nesac`);
    const [guard] = enumerateSkipGuards(text);
    assert.ok(guard);
    const mutant = mutateGuardLine(text, guard);
    const shell = mutant.split("      - run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
    const result = spawnSync("bash", ["-c", shell], { encoding: "utf8", env: { ...process.env, CLASS: "run" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "skipped\n", pattern);
  }
});

test(`${proof}: a case with no exit-zero arm is not a skip guard`, () => {
  assert.deepEqual(enumerateSkipGuards(step('case "$CLASS" in\n  SOURCE) echo ran ;;\n  *) exit 1 ;;\nesac')), []);
});

test(`${proof}: guard inventory assertions do not supply mutation coverage`, () => {
  assert.ok(!ciReadingSuites().includes(proof));
});
