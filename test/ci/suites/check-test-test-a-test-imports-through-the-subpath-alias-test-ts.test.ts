import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
// @ts-ignore executable module has no declaration file.
import { hasLocationRelativeSpecifier, main, rewriteSource } from "#scripts/test-location-codemod.mjs";

const spec = "../../src/lib/example.js";
const imp = (path: string) => `import value from ${JSON.stringify(path)};`;

// Recorded round: PR #14066, 2026-10-25T06:46:53.318Z (W1-T10822's RECENT ROUNDS).
// Its alias census grew from 3537 to 3538 files. This is the offending helper's import block:
// https://github.com/craigoley/remudero/blob/6258ed5d8ecfafce3f421ae123f400038d639949/test/helpers/review-finding-fix-prompt.ts#L1-L8
// Blob: 6321cb0e9dee551d08ea0d0f6e9b4e8e419acd1c. The repair changed only these four imports:
// https://github.com/craigoley/remudero/commit/f71f2f4dcb3cf25c46035ced4cf960bcc46d5e53
// Assemble specifiers separately so this replay does not itself trip the text-based alias census.
const recordedImports = (helper: string, src: string) => [
  'import assert from "node:assert/strict";',
  'import { mkdtempSync, rmSync, writeFileSync } from "node:fs";',
  'import { tmpdir } from "node:os";',
  'import { join } from "node:path";',
  `import { buildFixRungDispatchArgs, runFixRung } from ${JSON.stringify(helper)};`,
  `import type { Config } from ${JSON.stringify(src + "config.js")};`,
  `import type { CriterionVerdict } from ${JSON.stringify(src + "review.js")};`,
  `import type { WorkerResult } from ${JSON.stringify(src + "worker.js")};`,
].join("\n") + "\n";

test("test/ci/suites/check-test-test-a-test-imports-through-the-subpath-alias-test-ts.test.ts", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-alias-parser-"));
  const file = "test/helpers/review-finding-fix-prompt.ts";
  const source = recordedImports("./run-task-test.js", "../../src/lib/");
  const expected = recordedImports("#test/helpers/run-task-test.js", "#src/lib/");
  const output = process.stdout.write;
  let stdout = "";
  try {
    mkdirSync(join(root, "test/helpers"), { recursive: true });
    writeFileSync(join(root, file), source);
    assert.equal(hasLocationRelativeSpecifier(source), true, "positive control reproduces the census finding");
    process.stdout.write = ((chunk: string) => ((stdout += chunk), true)) as typeof process.stdout.write;
    assert.equal(main([file], root), 0);
    assert.equal(readFileSync(join(root, file), "utf8"), source, "dry run preserves the input");
    assert.equal(main(["--write", file], root), 0);
    const healed = readFileSync(join(root, file), "utf8");
    assert.equal(healed, expected, "real codemod reproduces the recorded repair's four alias imports");
    assert.ok(stdout.includes(`REWROTE ${file}: 4 specifier(s)`));
    assert.equal(hasLocationRelativeSpecifier(healed), false, "the recorded census failure is healed");
    assert.equal(main(["--write", file], root), 0);
    assert.equal(readFileSync(join(root, file), "utf8"), healed, "replay is idempotent");
  } finally {
    process.stdout.write = output;
    rmSync(root, { recursive: true, force: true });
  }
});

test("parser rewrites an executable import after a control-flow regex containing a quote", () => {
  const source = `const ready = true, value = 'x'; if (ready) /'/.test(value); ${imp(spec)}\n`;
  const result = rewriteSource(source, "test/nested/replay.test.ts");
  assert.equal(result.text, source.replace(imp(spec), imp("#src/lib/example.js")));
  assert.equal(result.rewritten, 1);
});

test("parser preserves fixture values and tagged-template raw spelling while rewriting executable imports", () => {
  const data = imp("./fixture.js");
  const fixture = [
    `const unicode = '🦊';`,
    `const ordinary = ${JSON.stringify(data)};`,
    "if (true) /`/.test('x'); const template = `" + data + "`;",
    "const raw = String.raw`" + data + "\\n\\u0061`;",
    "const tag = (strings, value) => [strings.raw[0], strings.raw[1], value];",
    "const tagged = tag`" + data + "\\n${'value'}tail\\u0061`;",
    "({ ordinary, template, raw, tagged });",
  ].join("\n");
  const source = fixture + "\n" + imp(spec);
  const result = rewriteSource(source, "test/nested/fixture.test.ts");
  assert.equal(result.text, fixture + "\n" + imp("#src/lib/example.js"));
  const actual = runInNewContext(result.text.slice(0, fixture.length));
  assert.equal(actual.ordinary, data);
  assert.equal(actual.template, data);
  assert.equal(actual.raw, data + "\\n\\u0061");
  assert.deepEqual(Array.from(actual.tagged), [data + "\\n", "tail\\u0061", "value"]);
  assert.equal(result.rewritten, 1);
  assert.equal(result.unresolved.length, 3);
});

test("parser visits real imports inside template substitutions without changing template text", () => {
  const dynamic = (path: string) => `import(${JSON.stringify(path)})`;
  const data = imp("./fixture.js");
  const source = "const tpl = String.raw`" + data + "${" + dynamic(spec) + "}\\n`;";
  const result = rewriteSource(source, "test/nested/template.test.ts");
  assert.equal(result.text, source.replace(dynamic(spec), dynamic("#src/lib/example.js")));
  assert.equal(result.rewritten, 1);
  assert.equal(result.unresolved.length, 1);
});
