import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "#src/lib/plan.js";
import { implementPromptParts, renderImplementPromptWithParts } from "#src/lib/prompt-render.js";
import { assertProvenance } from "#src/lib/provenance.js";
import { judgeReview, reviewScopeContext, SCOPE_EXEMPT_GENERATED_ARTIFACTS } from "#src/lib/review.js";
import { REGENERABLE_ARTIFACT_GENERATORS } from "#src/lib/sweep.js";
import { declaresProofTitle } from "#src/run-task.js";

const titles = ["first proof [literal]", "second proof (literal)", "third proof in words"];
const task: Task = {
  id: "W1-T8834-FIXTURE", title: "implement a fixture", repo: "remudero", depends_on: [],
  type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0,
  files: ["src/x.ts"],
  acceptance: titles.map((title) => ({ claim: title, proof: `unit test: ${title}` })),
};

function patch(path: string, content: string, added = true): string {
  const lines = content.split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    ...(added ? ["new file mode 100644"] : []),
    `--- ${added ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`,
    `@@ -${added ? "0,0" : "1"} +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

test("W1-T8834: the build prompt names each proof title as admitted outside files", () => {
  const { prompt, parts } = renderImplementPromptWithParts(task, "", "RUN");
  const admission = parts.find((part) => part.name === "admitted_outside_files");
  assert.ok(admission, "the manifest must name the admission part");
  assert.match(admission.value, /NEW test\/ file.*committed.*not in files:/);
  for (const title of titles) {
    assert.ok(admission.value.includes(title), `verbatim title: ${title}`);
    assert.ok(prompt.includes(title), `the worker receives: ${title}`);
  }
  assert.match(admission.value, /existing test files.*not admitted/);
  const names = parts.map((part) => part.name);
  const index = names.indexOf("admitted_outside_files");
  assert.equal(names[index - 1], "capability_context");
  assert.equal(names[index + 1], "task_body");
  assert.ok(prompt.indexOf(admission.value) < prompt.indexOf("# TASK"));
  assert.doesNotThrow(() => assertProvenance(prompt));

  const noTitles = implementPromptParts({ ...task, acceptance: [
    { claim: "a file proof", proof: "unit test: test/existing.test.ts" },
    { claim: "a grep proof", proof: 'grep: test("unadmitted grep title" in test/declared.test.ts' },
  ] }, "", "RUN").find((part) => part.name === "admitted_outside_files");
  assert.ok(noTitles);
  assert.equal(noTitles.value.includes("unadmitted grep title"), false);
  assert.equal(noTitles.value.includes("NEW test/"), false);
});

test("W1-T8834: the build prompt names each regenerable artifact and its generator", () => {
  const { prompt, parts } = renderImplementPromptWithParts({ ...task, acceptance: [] }, "", "RUN");
  const admission = parts.find((part) => part.name === "admitted_outside_files");
  assert.ok(admission);
  assert.match(admission.value, /harness keeps a regenerated copy/);
  assert.equal(REGENERABLE_ARTIFACT_GENERATORS["docs/cli-reference.md"], "cli-reference");
  for (const [path, generator] of Object.entries(REGENERABLE_ARTIFACT_GENERATORS)) {
    const row = `${path}: npm run --silent ${generator}`;
    assert.ok(admission.value.includes(row), row);
    assert.ok(prompt.includes(row), row);
  }
  assert.match(admission.value, /only.*already admits/);
  assert.doesNotThrow(() => assertProvenance(prompt));
});

test("W1-T8834: review does not flag an admitted proof test or regenerable artifact as out of scope", () => {
  assert.deepEqual([...SCOPE_EXEMPT_GENERATED_ARTIFACTS].sort(),
    Object.keys(REGENERABLE_ARTIFACT_GENERATORS).sort());
  const admitted = 'test("first proof [literal] with detail", () => { assert.equal(1, 1); });';
  const diff = [
    patch("src/x.ts", "export const x = 1;", false),
    patch("test/proof.test.ts", admitted),
    ...Object.keys(REGENERABLE_ARTIFACT_GENERATORS).map((path) => patch(path, "generated")),
    patch("test/existing.test.ts", admitted, false),
    patch("test/unrelated.test.ts", 'test("unrelated", () => {});'),
    patch("test/comment.test.ts", `// ${admitted}`),
    patch("test/string.test.ts", `const example = ${JSON.stringify(admitted)};`),
    patch("test/template.test.ts", 'const example = `${prefix} test("first proof [literal]", () => {})`;'),
    patch("test/grep.test.ts", 'test("unadmitted grep title", () => {});'),
    patch("src/rogue.ts", admitted),
    patch("test/../rogue.test.ts", admitted),
  ].join("\n");
  const criteria = [...task.acceptance!, {
    claim: "a grep proof", proof: 'grep: test("unadmitted grep title" in test/declared.test.ts',
  }];
  const verdict = judgeReview(criteria, { diff, report: "", taskDeclaredFiles: task.files });
  const advisory = verdict.unwiredAdvisories?.find((row) => row.reasonCode === "scope_violation");
  assert.ok(advisory, "positive control: unrelated paths still produce an advisory");
  assert.deepEqual(advisory.symbols, [
    "test/existing.test.ts", "test/unrelated.test.ts", "test/comment.test.ts", "test/string.test.ts",
    "test/template.test.ts", "test/grep.test.ts", "src/rogue.ts", "test/../rogue.test.ts",
  ]);
  const noCriteria = judgeReview([], { diff, report: "", taskDeclaredFiles: task.files });
  assert.ok(noCriteria.unwiredAdvisories?.find((row) => row.reasonCode === "scope_violation")
    ?.symbols.includes("test/proof.test.ts"));
  assert.equal(reviewScopeContext(patch("docs/cli-reference.md", "generated"), task.files)
    .widenedFiles.length, 0);
});

test("W1-T8834: review proof-test admission matches the harness declaration scanner", () => {
  const samples = [
    'test.only("first proof [literal]", () => {});',
    'it.skip("first proof [literal]", () => {});',
    'test.todo("first proof [literal]", () => {});',
    'test(`first proof [literal]`, () => {});',
    'test(\n "first proof [literal]",\n () => {});',
    'const text = `${{nested: {}}} ## ${prefix}`; test("first proof [literal]", () => {});',
    'const example = /test("first proof [literal]", () => {})/;',
    'test.other("first proof [literal]", () => {});',
    'test("first proof [literal]");',
    'test("first proof [literal]',
    '#',
  ];
  for (const content of samples) {
    const diff = patch("test/new.test.ts", content);
    const verdict = judgeReview(task.acceptance!, { diff, report: "", taskDeclaredFiles: task.files });
    const flagged = verdict.unwiredAdvisories?.find((row) => row.reasonCode === "scope_violation")
      ?.symbols.includes("test/new.test.ts") === true;
    assert.equal(flagged, !declaresProofTitle(content, titles), content);
  }
  const symlink = patch("test/new.test.ts", 'test("first proof [literal]", () => {});')
    .replace("new file mode 100644", "new file mode 120000");
  assert.deepEqual(judgeReview(task.acceptance!, { diff: symlink, report: "", taskDeclaredFiles: task.files })
    .unwiredAdvisories?.find((row) => row.reasonCode === "scope_violation")?.symbols, ["test/new.test.ts"]);
});
