import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
// @ts-ignore the executable .mjs module has no declaration file.
import { LOCATION_RELATIVE_ERE, hasLocationRelativeSpecifier, rewriteSource } from "#scripts/test-location-codemod.mjs";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const fixtureImport = (spec: string) => `import value from '${spec}';`;
const fixtures = () => {
  const data = fixtureImport("./fixture.js");
  const dynamicPath = "../outside.js";
  const setupPath = "./setup.js";
  return [
    `const double = ${JSON.stringify(data)};`,
    `const single = '${data.replaceAll("'", '"')}';`,
    "const template = `" + data + "\n" + data + "`;",
    `const dynamic = ${JSON.stringify(`import('${dynamicPath}')`)};`,
    `const sideEffect = ${JSON.stringify(`import '${setupPath}';`)};`,
    "const returned = (() => { return /* fixture source */ `" + data + "`; })();",
    "[double, single, template, dynamic, sideEffect, returned];",
  ].join("\n");
};

const census = (source: string) => spawnSync("grep", ["-E", LOCATION_RELATIVE_ERE], {
  input: source, encoding: "utf8",
});

function assertRegularForRawPreservation() {
  const raw = fixtureImport("./fixture.js");
  for (const header of [
    "void of`DATA`; false;",
    "true && of`DATA`; false;",
    "0, of`DATA`; false;",
    "let value = of`DATA`; false;",
    "let value = 0, other = of`DATA`; false;",
    "; of`DATA` && false;",
    "let value = 0; value < 1; of`DATA`, value++",
    "let value = { raw: of`DATA` }; false;",
    "let value = [of`DATA`]; false;",
  ]) {
    const source = "let raw; const of = parts => (raw = String.raw(parts)); for ("
      + header.replace("DATA", raw) + ") {} raw;";
    assert.equal(runInNewContext(source), raw, "control: the tag observes the original raw text");
    const result = rewriteSource(source, "test/ci/suites/fixture.test.ts");
    assert.equal(runInNewContext(result.text), raw, header);
    assert.equal(result.text, source);
    assert.equal(result.rewritten, 0);
    assert.equal(result.unresolved.length, 1);
    assert.match(result.unresolved[0], /raw spelling/);
  }
}

test("regular for clauses preserve of-tagged template raw values", assertRegularForRawPreservation);

test("W1-T10822: check:test:test/a-test-imports-through-the-subpath-alias.test.ts is prevented, not retried", () => {
  assertRegularForRawPreservation();
  const source = fixtures();
  assert.equal(census(source).status, 0, "control: the census sees the original fixture imports");
  const result = rewriteSource(source, "test/ci/suites/fixture.test.ts");
  assert.equal(result.rewritten, 7);
  assert.deepEqual(result.unresolved, []);
  assert.equal(hasLocationRelativeSpecifier(result.text), false);
  const checked = census(result.text);
  assert.equal(checked.status, 1, checked.stderr);
  assert.deepEqual(Array.from(runInNewContext(result.text)), Array.from(runInNewContext(source)));
  assert.deepEqual(rewriteSource(result.text, "test/ci/suites/fixture.test.ts"), {
    text: result.text, rewritten: 0, selfPathRemoved: false, unresolved: [],
  });

  const tagged = "const of = String.raw; of`" + fixtureImport("./fixture.js") + "`;";
  assert.equal(census(tagged).status, 0);
  const taggedResult = rewriteSource(tagged, "test/ci/suites/fixture.test.ts");
  assert.equal(taggedResult.text, tagged);
  assert.equal(taggedResult.rewritten, 0);
  assert.equal(taggedResult.unresolved.length, 1);
  assert.match(taggedResult.unresolved[0], /raw spelling/);
  assert.equal(runInNewContext(taggedResult.text), runInNewContext(tagged));

  for (const binding of ["value", "of"]) {
    const forOf = `const values = []; for (const ${binding} of \`` + fixtureImport("./fixture.js")
      + `\`) values.push(${binding}); values.join('');`;
    const forOfResult = rewriteSource(forOf, "test/ci/suites/fixture.test.ts");
    assert.equal(forOfResult.rewritten, 1);
    assert.deepEqual(forOfResult.unresolved, []);
    assert.equal(census(forOfResult.text).status, 1);
    assert.equal(runInNewContext(forOfResult.text), runInNewContext(forOf));

    for (const trivia of [" ", " /* raw tag */ "]) {
      const declaration = binding === "of" ? "var" : "const";
      const rawLoop = `${declaration} of = String.raw; const values = []; for (${declaration} ${binding} of of${trivia}\``
        + fixtureImport("./fixture.js") + `\`) values.push(${binding}); values.join('');`;
      assert.equal(census(rawLoop).status, 0, "control: the census sees the raw fixture import");
      const rawResult = rewriteSource(rawLoop, "test/ci/suites/fixture.test.ts");
      assert.equal(runInNewContext(rawLoop), fixtureImport("./fixture.js"));
      assert.equal(runInNewContext(rawResult.text), fixtureImport("./fixture.js"));
      assert.equal(rawResult.text, rawLoop);
      assert.equal(rawResult.rewritten, 0);
      assert.equal(rawResult.unresolved.length, 1);
      assert.match(rawResult.unresolved[0], /raw spelling/);
      assert.equal(census(rawResult.text).status, 0);
    }
  }

  const forInTagged = "const of = String.raw; const keys = []; for (const key in of`"
    + fixtureImport("./fixture.js") + "`) keys.push(key); keys.join(',');";
  const forInTaggedResult = rewriteSource(forInTagged, "test/ci/suites/fixture.test.ts");
  assert.equal(census(forInTagged).status, 0);
  assert.equal(forInTaggedResult.text, forInTagged, "the for-in right operand is an of tag");
  assert.equal(forInTaggedResult.rewritten, 0);
  assert.equal(forInTaggedResult.unresolved.length, 1);
  assert.match(forInTaggedResult.unresolved[0], /raw spelling/);
  assert.equal(runInNewContext(forInTaggedResult.text), runInNewContext(forInTagged));

  const observedRaw = "let raw; const of = (parts) => { raw = String.raw(parts); return { key: 1 }; }; "
    + "for (const key in of`" + fixtureImport("./fixture.js") + "`) {} raw;";
  const observedResult = rewriteSource(observedRaw, "test/ci/suites/fixture.test.ts");
  assert.equal(runInNewContext(observedResult.text), fixtureImport("./fixture.js"));
  assert.equal(observedResult.rewritten, 0);
  assert.match(observedResult.unresolved[0], /raw spelling/);

  for (const expression of [
    "function(parts) { return String.raw(parts); }",
    "function named(parts) { return String.raw(parts); }",
  ]) {
    const functionTag = `const raw = ${expression}\`` + fixtureImport("./fixture.js") + "`; raw;";
    assert.equal(census(functionTag).status, 0, "control: the census sees the function tag's import");
    assert.equal(runInNewContext(functionTag), fixtureImport("./fixture.js"));
    const functionResult = rewriteSource(functionTag, "test/ci/suites/fixture.test.ts");
    assert.equal(functionResult.text, functionTag, "the function expression observes raw template text");
    assert.equal(functionResult.rewritten, 0);
    assert.equal(functionResult.unresolved.length, 1);
    assert.match(functionResult.unresolved[0], /raw spelling/);
    assert.equal(runInNewContext(functionResult.text), fixtureImport("./fixture.js"));
  }
  const afterDeclaration = "function named(parts) { return String.raw(parts); } const value = `"
    + fixtureImport("./fixture.js") + "`; value;";
  const declarationResult = rewriteSource(afterDeclaration, "test/ci/suites/fixture.test.ts");
  assert.equal(declarationResult.rewritten, 1, "a template after a function declaration is ordinary data");
  assert.deepEqual(declarationResult.unresolved, []);
  assert.equal(runInNewContext(declarationResult.text), runInNewContext(afterDeclaration));

  const forInOrdinary = "const keys = []; for (const key in `"
    + fixtureImport("./fixture.js") + "`) keys.push(key); keys.join(',');";
  const forInOrdinaryResult = rewriteSource(forInOrdinary, "test/ci/suites/fixture.test.ts");
  assert.equal(forInOrdinaryResult.rewritten, 1, "the ordinary template can become location-free");
  assert.deepEqual(forInOrdinaryResult.unresolved, []);
  assert.equal(census(forInOrdinaryResult.text).status, 1);
  assert.equal(runInNewContext(forInOrdinaryResult.text), runInNewContext(forInOrdinary));

  for (const binding of ["{ value = 1 }", "[value = 1]"]) {
    const iterable = binding.startsWith("{") ? "[{}]" : "[[]]";
    const source = `const values = []; for (const ${binding} of ${iterable}) values.push(value); `
      + `for (const ${binding} of \`` + fixtureImport("./fixture.js")
      + "`) {} values.join(',');";
    const result = rewriteSource(source, "test/ci/suites/fixture.test.ts");
    assert.equal(result.rewritten, 1, "binding defaults still permit a for-of separator");
    assert.deepEqual(result.unresolved, []);
    assert.equal(census(result.text).status, 1);
    assert.equal(runInNewContext(result.text), runInNewContext(source));
  }
});

test("fixture-only files are written by the codemod CLI", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-fixture-escape-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "fixture.test.ts");
  const source = fixtures();
  writeFileSync(file, source);
  const run = (...args: string[]) => spawnSync(process.execPath, [
    join(REPO_ROOT, "scripts/test-location-codemod.mjs"), ...args, file,
  ], { encoding: "utf8" });
  const dry = run();
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /1 of 1 file\(s\) would change/);
  assert.equal(readFileSync(file, "utf8"), source);
  const written = run("--write");
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /1 of 1 file\(s\) rewritten/);
  const actual = readFileSync(file, "utf8");
  assert.equal(census(actual).status, 1);
  assert.deepEqual(Array.from(runInNewContext(actual)), Array.from(runInNewContext(source)));
});

test("tagged templates retain observable raw spelling and report unresolved imports", () => {
  const source = "String.raw`" + fixtureImport("./fixture.js") + "`;";
  const result = rewriteSource(source, "test/ci/suites/fixture.test.ts");
  assert.equal(result.text, source);
  assert.equal(result.rewritten, 0);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0], /raw spelling/);
  assert.equal(runInNewContext(result.text), runInNewContext(source));
});

test("Unicode identifier tags retain the raw fixture value", () => {
  for (const name of ["τ", "𝛕", "τ2"]) {
    const source = `const ${name} = String.raw; ${name}\`` + fixtureImport("./fixture.js") + "`;";
    assert.equal(census(source).status, 0);
    const result = rewriteSource(source, "test/ci/suites/fixture.test.ts");
    assert.equal(result.text, source);
    assert.equal(result.rewritten, 0);
    assert.equal(result.unresolved.length, 1);
    assert.match(result.unresolved[0], /raw spelling/);
    assert.equal(runInNewContext(result.text), runInNewContext(source));
  }
});

test("returned templates keep their values while becoming location-free", () => {
  for (const trivia of [" ", " /* fixture */ ", " /* a comment longer than the old lookbehind window */ /* next */ "]) {
    const source = "(() => { return" + trivia + "`" + fixtureImport("../fixture.js") + "`; })();";
    assert.equal(census(source).status, 0);
    const result = rewriteSource(source, "test/ci/suites/fixture.test.ts");
    assert.equal(result.rewritten, 1);
    assert.deepEqual(result.unresolved, []);
    assert.equal(census(result.text).status, 1);
    assert.equal(runInNewContext(result.text), runInNewContext(source));
  }
});

test("chained and keyword-named tags preserve their observable raw values", () => {
  for (const tag of ["tag`first`", "tag`first` /* next tag */", "tags.return /* property tag */"]) {
    const source = "const tag = () => String.raw; const tags = { return: String.raw }; "
      + tag + "`" + fixtureImport("./fixture.js") + "`;";
    const result = rewriteSource(source, "test/ci/suites/fixture.test.ts");
    assert.equal(result.text, source);
    assert.equal(result.rewritten, 0);
    assert.equal(result.unresolved.length, 1);
    assert.match(result.unresolved[0], /raw spelling/);
    assert.equal(census(result.text).status, 0);
    assert.equal(runInNewContext(result.text), runInNewContext(source));
  }
});
