/**
 * W1-T6158 — THE LITERAL MASKER PARSES A NESTED TEMPLATE SUBSTITUTION.
 *
 * `scanSource` (behind `maskLiterals` and `stripComments`) used to end a template literal at the first
 * backtick even inside a `${...}` substitution, so containment.ts `shellSingleQuote`'s nested template
 * flipped the parse of everything after it. A substitution is code: nested strings, templates, comments,
 * regexes and braces are scanned until the matching `}`; only template TEXT is a literal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { maskLiterals, stripComments } from "#src/lib/test-impact-map.js";
import { readAffectedSuitesInput } from "#src/lib/affected-suites.js";
import { widenedGitSites } from "#test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const conservative = { conservative: true };
const strictMask = (source: string) => maskLiterals(stripComments(source, { keepLines: true, ...conservative }), conservative);

const SHELL_QUOTE = "export function shellSingleQuote(s: string): string {\n  return `'${s.split(\"'\").join(`'\\\\''`)}'`;\n}\n";
const GIT_CALL = '  execFileSync("git", ["status", "-s"], { cwd: d });';
const FIXTURE = `${SHELL_QUOTE}\nexport function after(d: string, token: string) {\n  const base = \`worker-smoke-\${token}\`;\n${GIT_CALL}\n  return base;\n}\n`;

test("unit test: test/the-literal-masker-parses-a-nested-template-substitution.test.ts keeps code after a nested template", () => {
  const masked = maskLiterals(stripComments(FIXTURE, { keepLines: true }));
  assert.ok(masked.includes('  execFileSync("   ", ["      ", "  "], { cwd: d });'), masked);
  assert.match(masked, /execFileSync\(/);
  assert.match(masked, /cwd: d/);
  // The template text is blanked, the delimiters survive.
  assert.match(masked, /`\s+\$\{token\}`/);
});

test("maskLiterals and stripComments preserve offsets and line numbers across a nested substitution", () => {
  assert.equal(maskLiterals(FIXTURE).length, FIXTURE.length);
  const lines = FIXTURE.split("\n");
  const masked = maskLiterals(stripComments(FIXTURE, { keepLines: true })).split("\n");
  assert.equal(masked.length, lines.length);
  const at = lines.findIndex((l) => l.includes("execFileSync"));
  assert.match(masked[at]!, /execFileSync\(/);
});

test("a comment, string and regex inside a substitution are scanned as code", () => {
  const src = "const a = `x ${f(/`/.test(s), \"}\", /* } */ { k: 1 })} y`;\nexecFileSync(\"git\", []);\n";
  const masked = maskLiterals(stripComments(src));
  assert.match(masked, /execFileSync\(/);
  assert.ok(!masked.includes("/*"), masked);
  assert.match(masked, /\{ k: 1 \}\)\} {2}`|\{ k: 1 \}\)\} y`/);
});

test("a quote string still ends at its line's end inside a substitution", () => {
  const src = "const a = `${'unterminated}\nexecFileSync(\"git\", []);\n";
  assert.match(maskLiterals(src), /execFileSync\(/);
});

test("the leaf census counts containment.ts runWorkerSmoke's git init", () => {
  const text = readFileSync(`${REPO}src/lib/containment.ts`, "utf8");
  const fns = widenedGitSites(text).map((s) => s.fn);
  assert.ok(fns.includes("runWorkerSmoke"), JSON.stringify(fns));
  assert.equal(fns.length, 2);
});

test("regex expression keywords preserve following real code and its line", () => {
  for (const statement of ['return /`/.test(value);', 'return !/`/.test(value);', 'throw /`/;', 'yield /`/.test(value);']) {
    const source = [`function* owner(value) {`, `  ${statement}`, '}', 'function actualLater() { return 1; }', ''].join("\n");
    new Function(source);
    const masked = strictMask(source);
    assert.equal(masked.split("\n").length, source.split("\n").length, statement);
    assert.match(masked.split("\n")[3]!, /^function actualLater\(/, statement);
    assert.ok(!masked.includes('/`/'), "a regex body is data, not an opening template");
  }
});

test("a control-condition regex must not consume code after its backtick", () => {
  const source = ['if (ready) /`/.test(value);', 'function actualLater() { return 1; }', ''].join("\n");
  new Function(source);
  const masked = strictMask(source);
  assert.equal(masked.split("\n").length, source.split("\n").length);
  assert.match(masked.split("\n")[1]!, /^function actualLater\(/);
});

test("property keyword names, call results and contextual yield keep genuine division code", () => {
  for (const expression of ['obj.return / liveDivisor() / divisor', 'obj?.throw / liveDivisor() / divisor',
    'obj.yield / liveDivisor() / divisor', 'fn(ready) / liveDivisor() / divisor', 'yield / liveDivisor() / divisor',
    'obj.return++ / liveDivisor() / divisor', 'obj.return-- / liveDivisor() / divisor', '/x/ / liveDivisor() / divisor']) {
    const source = `function ordinary(obj, fn, ready, liveDivisor, divisor) {\n  var yield = 8;\n  const result = ${expression};\n  return result;\n}\nfunction actualLater() {}\n`;
    new Function(source);
    const masked = strictMask(source);
    assert.ok(masked.includes(expression.replace('/x/', '/ /')), expression);
    assert.match(masked.split("\n")[5]!, /^function actualLater\(/, expression);
  }
});

test("control parentheses and generator function contexts are scoped, not slash heuristics", () => {
  const cases = [
    ['if (fn(ready)) /`/.test(value);', false],
    ['while (fn(ready)) /`/.test(value);', false],
    ['for (; fn(ready);) /`/.test(value);', false],
    ['with (obj) /`/.test(value);', false],
    ['function* gen() { yield /`/.test(value); }', false],
    ['function* gen() { function plain() { var yield = 8; return yield / liveDivisor() / divisor; } yield /`/.test(value); }', true],
    ['function plain() { function* gen() { yield /`/.test(value); } var yield = 8; return yield / liveDivisor() / divisor; }', true],
    ['function* gen() { const plain = () => { var yield = 8; return yield / liveDivisor() / divisor; }; yield /`/.test(value); }', true],
    ['obj.if(ready) / liveDivisor() / divisor;', true],
    ['obj?.while(ready) / liveDivisor() / divisor;', true],
    ['fn((ready)) / liveDivisor() / divisor;', true],
  ] as const;
  for (const [body, division] of cases) {
    const source = `${body}\nfunction actualLater() {}\n`;
    new Function(source);
    const masked = strictMask(source);
    assert.match(masked.split("\n")[1]!, /^function actualLater\(/, body);
    assert.equal(masked.includes('liveDivisor()'), division, body);
    assert.ok(!masked.includes('/`/'), body);
  }
});

test("keyword regexes and real code remain distinct inside nested template holes", () => {
  const source = ['const text = `raw const child = 1; ${(() => {',
    'function* gen() { yield /`/.test(value); }',
    'return /[`"/*]/.test(value) ? `nested ${liveCall()}` : "}";',
    '})()} raw`;', 'function actualLater() {}', ''].join("\n");
  new Function(source);
  const masked = strictMask(source);
  assert.equal(maskLiterals(source, conservative).length, source.length);
  assert.equal(masked.split("\n").length, source.split("\n").length);
  assert.match(masked.split("\n")[4]!, /^function actualLater\(/);
  assert.ok(masked.includes('liveCall()'));
  assert.ok(!masked.includes('const child'));
  assert.ok(!masked.includes('/[`"/*]/'));
});

test("a grammar context the helper cannot resolve is refused instead of blanking live code", () => {
  for (const source of ['if (ready) {} /`/.test(value);\nfunction actualLater() {}\n',
    'const obj = { *method() { yield /`/.test(value); } };\nfunction actualLater() {}\n',
    'const obj = { *method() { return `${yield /`/.test(value)}`; } };\nfunction actualLater() {}\n']) {
    new Function(source);
    assert.throws(() => strictMask(source), /lexical context unknown/);
  }
});

test("contextual of and for-await goals refuse rather than erase subsequent code", () => {
  for (const source of ['for (const value of /`/) {}\nfunction actualLater() {}\n',
    'async function owner() { for await (const value of values) /`/.test(value); }\nfunction actualLater() {}\n']) {
    assert.throws(() => strictMask(source), /lexical context unknown/);
  }
});

test("expression and statement keyword regex goals retain following declarations", () => {
  for (const source of ['const value = new /`/;\nfunction actualLater() {}\n',
    'export default /`/;\nfunction actualLater() {}\n',
    'while (ready) { break\n/`/.test(value); }\nfunction actualLater() {}\n']) {
    assert.match(strictMask(source), /function actualLater/);
    assert.ok(!strictMask(source).includes('/`/'));
  }
});

test("regex-valued arrow bodies and non-null division preserve their real code", () => {
  const source = 'const f = (x) => /`/.test(x);\nconst ratio = value! / liveDivisor();\nfunction actualLater() {}\n';
  const masked = strictMask(source);
  assert.ok(masked.includes('value! / liveDivisor()'));
  assert.match(masked.split("\n")[2]!, /^function actualLater\(/);
  assert.ok(!masked.includes('/`/'));
});

test("a newline before bang does not guess between a new statement and a TypeScript postfix assertion", () => {
  for (const separator of ["\n", "/* newline\n */"]) {
    const source = `value${separator}!/\x60/.test(value);\nfunction actualLater() {}\n`;
    new Function(source);
    assert.throws(() => strictMask(source), /lexical context unknown/);
  }
});

test("private keyword properties remain division rather than regex expression keywords", () => {
  const source = 'class Owner { #return = 8; value() { return this.#return / liveDivisor() / divisor; } }\nfunction actualLater() {}\n';
  new Function(source);
  assert.ok(strictMask(source).includes('this.#return / liveDivisor() / divisor'));
});

test("non-ASCII identifier boundaries and unsupported physical line endings refuse explicitly", () => {
  for (const prefix of ['const éreturn = 8; éreturn / liveDivisor() / divisor;', '// comment\u2028éreturn / liveDivisor() / divisor;',
    '// comment\rfunction actualLater() {}']) {
    new Function(prefix);
    assert.throws(() => strictMask(prefix + '\nfunction actualLater() {}\n'), /lexical context unknown/);
  }
});

test("unsupported Script comments and keyword-named method contexts refuse without hiding later declarations", async t => {
  for (const body of ['<!-- `comment data', '--> `comment data',
    'const obj = { *function() { yield /`/.test(value); } };',
    'const obj = { *if() { yield /`/.test(value); } };',
    'function* gen() { const obj = { if() { var yield = 8; return yield / liveDivisor() / divisor; } }; }']) {
    await t.test(body, () => {
      const source = `${body}\nfunction actualLater() {}\n`;
      new Function(source);
      assert.throws(() => strictMask(source), /lexical context unknown/);
    });
  }
});

// @census-reads: src/ scripts/ bin/ test/ — compatibility of the physical inputs current lexical consumers scan.
test("legacy output equals the committed base over every physical tracked code input; strict refusals are counted separately and refused in src", async t => {
  const base = "98bc4f34d178ea25775c8020172b55cf1d0852f5";
  const original = execFileSync("git", ["show", `${base}:src/lib/test-impact-map.ts`], { cwd: REPO, encoding: "utf8" });
  const dir = mkdtempSync(join(tmpdir(), "rmd-lexical-base-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "test-impact-map.ts");
  writeFileSync(path, original);
  const baseline: typeof import("#src/lib/test-impact-map.js") = await import(pathToFileURL(path).href);
  const inputs = readAffectedSuitesInput(REPO, []).files;
  const paths = [...inputs.keys()].sort();
  assert.ok(paths.length > 4000, `positive corpus control: ${paths.length}`);
  assert.ok(paths.includes("src/lib/test-impact-map.ts") && paths.includes("src/lib/affected-suites.ts"));
  assert.ok(paths.includes("test/the-literal-masker-parses-a-nested-template-substitution.test.ts"));
  const unknowns: { path: string; message: string }[] = [];
  let completed = 0, bytes = 0, comparisons = 0;
  const corpus = createHash("sha256");
  for (const path of paths) {
    const physical = `${REPO}${path}`;
    assert.ok(statSync(physical).isFile(), path);
    const text = readFileSync(physical, "utf8");
    assert.equal(text, inputs.get(path), `${path}: maintained input reader must match the physical file`);
    bytes += Buffer.byteLength(text);
    corpus.update(path + "\0" + text + "\0");
    const oldComments = baseline.stripComments(text), newComments = stripComments(text);
    const oldLines = baseline.stripComments(text, { keepLines: true }), newLines = stripComments(text, { keepLines: true });
    for (const [name, actual, expected] of [
      ["comments", newComments, oldComments], ["comment lines", newLines, oldLines],
      ["raw mask", maskLiterals(text), baseline.maskLiterals(text)],
      ["comment mask", maskLiterals(newComments), baseline.maskLiterals(oldComments)],
      ["line mask", maskLiterals(newLines), baseline.maskLiterals(oldLines)],
    ]) {
      assert.equal(actual, expected, `${path}: legacy ${name} changed`);
      comparisons++;
    }
    try {
      const masked = strictMask(text);
      assert.equal(masked.split("\n").length, text.split("\n").length, path);
      completed++;
    } catch (error) {
      assert.match(String((error as Error).message), /lexical context unknown/, path);
      unknowns.push({ path, message: String((error as Error).message) });
    }
  }
  console.log(JSON.stringify({ lexicalPhysicalCorpus: { base, listed: paths.length, legacyComparisons: comparisons,
    legacyMismatches: 0, strictCompleted: completed, bytes, sha256: corpus.digest("hex"), strictUnknowns: unknowns } }));
  assert.equal(comparisons, paths.length * 5);
  assert.equal(completed + unknowns.length, paths.length);
  // W1-T10250 design step 4: a PR touching a src file the conservative lexer refuses cannot name its changed
  // symbols, so preflight-author falls back to the full suite set. Refuse that regression here, once.
  const srcUnknowns = unknowns.filter(({ path }) => /^src\/.*\.ts$/.test(path));
  assert.deepEqual(srcUnknowns, [], `the conservative lexer refuses ${srcUnknowns.length} src file(s)`);
  assert.match(strictMask('function owner() { return /`/.test(value); }\nfunction actualLater() {}'), /function actualLater/);
  assert.throws(() => strictMask('await / liveCall() /g;'), /lexical context unknown/);
});

test("a valid uncertain input does not introduce an uncaught error in an existing lexical consumer", async t => {
  for (const prefix of ['if (ready) {} /`/.test(value);', 'await / liveCall() /g;']) {
    await t.test(prefix, () => {
      const source = `${prefix}\nexecFileSync("git", ["status"], { cwd: root });\n`;
      new Function(source);
      let sites: ReturnType<typeof widenedGitSites> | undefined;
      assert.doesNotThrow(() => { sites = widenedGitSites(source); });
      assert.equal(sites?.length, 1, "legacy caller contract must not change");
      assert.throws(() => strictMask(source), /lexical context unknown/);
    });
  }
});

test("the same await-slash source bytes compile with different script and module meanings", () => {
  const source = 'await / liveCall() /g;\n';
  const executable = 'globalThis.await = 8; globalThis.g = 2; globalThis.lexicalCalls = 0; ' +
    'globalThis.liveCall = () => { globalThis.lexicalCalls++; return 2; };\n' + source +
    'console.log(globalThis.lexicalCalls);\n';
  for (const [goal, calls] of [["commonjs", "1\n"], ["module", "0\n"]] as const) {
    assert.equal(execFileSync(process.execPath, [`--input-type=${goal}`, "--check"], {
      input: source, encoding: "utf8", timeout: 10_000,
    }), "");
    assert.equal(execFileSync(process.execPath, [`--input-type=${goal}`, "-e", executable], {
      encoding: "utf8", timeout: 10_000,
    }), calls, `${goal} language-goal control`);
  }
  assert.throws(() => maskLiterals(source, conservative), /lexical context unknown/);
});
