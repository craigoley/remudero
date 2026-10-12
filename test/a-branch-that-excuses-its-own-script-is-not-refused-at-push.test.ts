import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { evaluateInstrumentSurface, main } from "../scripts/census-precheck.mjs";

const SCRIPT = "scripts/branch-helper.mjs";
const OTHER = "scripts/another-helper.mjs";

function branch(declaration: string, scripts = [SCRIPT], baseDeclaration?: string) {
  const repo = gitRepo({ kind: "branch-instrument-exclusion" });
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  put("package.json", JSON.stringify({ scripts: { old: "node scripts/old-ratchet.mjs" } }));
  put("scripts/old-ratchet.mjs", "export {};\n");
  if (baseDeclaration !== undefined) put("src/lib/review.ts", baseDeclaration);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed census candidates");
  repo.git("switch", "-qc", "work");
  for (const script of scripts) put(script, 'throw new Error("branch script must not execute");\n');
  put("package.json", JSON.stringify({ scripts: { old: "node scripts/old-ratchet.mjs", added: scripts.map((s) => `node ${s}`).join(" && ") } }));
  put("src/lib/review.ts", 'throw new Error("branch reviewer must not execute");\n' + declaration);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "add branch helpers and declarations");
  return repo;
}

function census(t: TestContext, repo: ReturnType<typeof branch>) {
  const lines: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => lines.push(args.join(" ")));
  t.mock.method(console, "log", (...args: unknown[]) => lines.push(args.join(" ")));
  const status = main(["--root", repo.dir, "--base", "main"], { admitted: () => [] });
  return { status, lines };
}

test("W1-T6237: a branch that excuses its own new script passes the push census", (t) => {
  const repo = branch(`export const INSTRUMENT_SURFACE_EXCLUSIONS: Readonly<Record<string, string>> = {
    "${SCRIPT}": "a developer helper, " + "not gate logic",
  };\n`);
  t.after(() => repo.cleanup());
  const result = census(t, repo);
  assert.equal(result.status, 0, result.lines.join("\n"));
  assert.ok(result.lines.includes(`instrument-surface: ${SCRIPT} excused by this branch (CI and review judge the reason)`), result.lines.join("\n"));
  assert.ok(result.lines.some((line) => line.startsWith("census-precheck: OK")));
});

test("W1-T6237: an unexcused or blank-reason script is still refused at push", (t) => {
  for (const declaration of [
    "export const INSTRUMENT_SURFACE_EXCLUSIONS = {};",
    `export const INSTRUMENT_SURFACE_EXCLUSIONS = { "${SCRIPT}": "" };`,
    `export const INSTRUMENT_SURFACE_EXCLUSIONS = { "${SCRIPT}": " \\t\\n " };`,
    `// export const INSTRUMENT_SURFACE_EXCLUSIONS = { "${SCRIPT}": "comment decoy" };`,
    `const decoy = 'export const INSTRUMENT_SURFACE_EXCLUSIONS = { "${SCRIPT}": "string decoy" };';`,
    `export const INSTRUMENT_SURFACE_EXCLUSIONS = { "${SCRIPT}": (() => "dynamic reason")() };`,
  ]) {
    const repo = branch(declaration);
    t.after(() => repo.cleanup());
    const result = census(t, repo);
    assert.equal(result.status, 1, result.lines.join("\n"));
    assert.ok(result.lines.some((line) => line.includes(`instrument-surface: ${SCRIPT} is neither`)), result.lines.join("\n"));
    assert.ok(!result.lines.some((line) => line.startsWith("census-precheck: OK")));
  }
});

test("W1-T6237: a branch exclusion excuses only its own gap", (t) => {
  const repo = branch(`export const INSTRUMENT_SURFACE_EXCLUSIONS = { '${SCRIPT}': 'a helper' };`, [SCRIPT, OTHER]);
  t.after(() => repo.cleanup());
  const result = census(t, repo);
  assert.equal(result.status, 1, result.lines.join("\n"));
  assert.ok(result.lines.includes(`instrument-surface: ${SCRIPT} excused by this branch (CI and review judge the reason)`));
  assert.ok(result.lines.some((line) => line.includes(`instrument-surface: ${OTHER} is neither`)));
  assert.ok(!result.lines.some((line) => line.includes(`instrument-surface: ${SCRIPT} is neither`)));
});

test("W1-T6237: removing an existing harness exclusion does not change push admission", (t) => {
  const repo = branch("export const INSTRUMENT_SURFACE_EXCLUSIONS = {};", ["scripts/node-pin-follows-the-image.mjs"],
    'export const INSTRUMENT_SURFACE_EXCLUSIONS = { "scripts/node-pin-follows-the-image.mjs": "node pin sync helper" };');
  t.after(() => repo.cleanup());
  const result = census(t, repo);
  assert.equal(result.status, 0, result.lines.join("\n"));
  assert.ok(!result.lines.some((line) => line.includes("excused by this branch")));
});

test("W1-T6237: literal exclusions survive templates, regexes and escaped reasons in reviewer text", () => {
  const source = [
    'export const other = /`/g;',
    '/** A regex backtick must not turn this # comment into a private identifier. */',
    'const nested = `prefix ${ { value: `inner ${"value"}` }.value } suffix`;',
    'const empty = ``;',
    '/* export const INSTRUMENT_SURFACE_EXCLUSIONS = { "scripts/branch-helper.mjs": "decoy" }; */',
    `export const INSTRUMENT_SURFACE_EXCLUSIONS: Readonly<Record<string, string>> = {`,
    `  '${SCRIPT}': '' + 'a helper with a \\u0072eason and } brace',`,
    '};',
  ].join("\n");
  const messages: string[] = [];
  const result = evaluateInstrumentSurface({
    changed: [SCRIPT],
    readHead: () => source,
    reportExcused: (line: string) => messages.push(line),
    measureInstrumentSurface: () => ({ head: { candidates: [SCRIPT], gaps: [SCRIPT] }, base: { candidates: [], gaps: [] } }),
  });
  assert.deepEqual(result, { violations: [], unmeasured: null });
  assert.deepEqual(messages, [`instrument-surface: ${SCRIPT} excused by this branch (CI and review judge the reason)`]);
});

test("W1-T6237: unsupported or incomplete exclusion declarations never excuse a gap", () => {
  for (const source of [
    'export const INSTRUMENT_SURFACE_EXCLUSIONS;',
    'export const INSTRUMENT_SURFACE_EXCLUSIONS',
    'export const INSTRUMENT_SURFACE_EXCLUSIONS = makeExclusions();',
    'export const INSTRUMENT_SURFACE_EXCLUSIONS = {',
    `export const INSTRUMENT_SURFACE_EXCLUSIONS = { '${SCRIPT}' 'missing colon' };`,
    `export const INSTRUMENT_SURFACE_EXCLUSIONS = { '${SCRIPT}': 'unterminated`,
    `export const INSTRUMENT_SURFACE_EXCLUSIONS = { '${SCRIPT}': 'reason' + 1 };`,
    `export const INSTRUMENT_SURFACE_EXCLUSIONS = { '${SCRIPT}': 'reason'; };`,
    `export const INSTRUMENT_SURFACE_EXCLUSIONS = { '${SCRIPT}': 'reason' } && {};`,
    `export const INSTRUMENT_SURFACE_EXCLUSIONS = { '${SCRIPT}': 'reason', '${SCRIPT}': '' };`,
  ]) {
    const result = evaluateInstrumentSurface({
      changed: [SCRIPT],
      readHead: () => source,
      measureInstrumentSurface: () => ({ head: { candidates: [SCRIPT], gaps: [SCRIPT] }, base: { candidates: [], gaps: [] } }),
    });
    assert.equal(result.unmeasured, null);
    assert.equal(result.violations.length, 1, source);
  }
});
