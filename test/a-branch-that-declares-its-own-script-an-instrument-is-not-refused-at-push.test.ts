import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { evaluateInstrumentSurface, main } from "../scripts/census-precheck.mjs";

// The push census tells a branch with a new gate script to "add a pattern to INSTRUMENT_SURFACE".
// The hook judges with main's reviewer, so before this it could not see that pattern and refused the
// very remedy it named (2026-10-10, the flake-screen branch). An exclusion was already honored.

const SCRIPT = "scripts/branch-gate.mjs";
const OTHER = "scripts/another-gate.mjs";

function declaringBranch(declaration: string, scripts = [SCRIPT]) {
  const repo = gitRepo({ kind: "branch-instrument-declaration" });
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  put("package.json", JSON.stringify({ scripts: { old: "node scripts/old-ratchet.mjs" } }));
  put("scripts/old-ratchet.mjs", "export {};\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed census candidates");
  repo.git("switch", "-qc", "work");
  for (const script of scripts) put(script, 'throw new Error("branch script must not execute");\n');
  put("package.json", JSON.stringify({ scripts: { old: "node scripts/old-ratchet.mjs", added: scripts.map((s) => `node ${s}`).join(" && ") } }));
  put("src/lib/review.ts", 'throw new Error("branch reviewer must not execute");\n' + declaration);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "add branch gates and their declaration");
  return repo;
}

function census(t: TestContext, repo: ReturnType<typeof declaringBranch>) {
  const lines: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => lines.push(args.join(" ")));
  t.mock.method(console, "log", (...args: unknown[]) => lines.push(args.join(" ")));
  const status = main(["--root", repo.dir, "--base", "main"], { admitted: () => [] });
  return { status, lines };
}

const declaredLine = (path: string) => `instrument-surface: ${path} declared an instrument by this branch (CI and review judge it)`;

test("a branch that declares its own new script on INSTRUMENT_SURFACE passes the push census", (t) => {
  const repo = declaringBranch(`export const INSTRUMENT_SURFACE: readonly string[] = [
    "^src/lib/review\\\\.ts$",
    // the branch's own gate
    "^scripts/branch-gate\\\\.mjs$",
  ];\n`);
  t.after(() => repo.cleanup());
  const result = census(t, repo);
  assert.equal(result.status, 0, result.lines.join("\n"));
  assert.ok(result.lines.includes(declaredLine(SCRIPT)), result.lines.join("\n"));
  assert.ok(result.lines.some((line) => line.startsWith("census-precheck: OK")));
});

test("a branch declaration covers only the paths its patterns match", (t) => {
  const repo = declaringBranch('export const INSTRUMENT_SURFACE = ["^scripts/branch-gate\\\\.mjs$"];', [SCRIPT, OTHER]);
  t.after(() => repo.cleanup());
  const result = census(t, repo);
  assert.equal(result.status, 1, result.lines.join("\n"));
  assert.ok(result.lines.includes(declaredLine(SCRIPT)));
  assert.ok(result.lines.some((line) => line.includes(`instrument-surface: ${OTHER} is neither`)));
});

test("an invalid, commented, dynamic or malformed INSTRUMENT_SURFACE declaration never covers a gap", () => {
  for (const source of [
    'export const INSTRUMENT_SURFACE = ["^scripts/branch-gate\\\\.mjs$("];',
    '// export const INSTRUMENT_SURFACE = ["^scripts/branch-gate"];',
    'export const INSTRUMENT_SURFACE = makeSurface();',
    'export const INSTRUMENT_SURFACE = ["^scripts/branch-gate", other];',
    'export const INSTRUMENT_SURFACE = ["^scripts/branch-gate" "^x"];',
    'export const INSTRUMENT_SURFACE = ["^scripts/branch-gate"] && [];',
    'export const INSTRUMENT_SURFACE = ["^scripts/branch-gate',
  ]) {
    const messages: string[] = [];
    const result = evaluateInstrumentSurface({
      changed: [SCRIPT],
      readHead: () => source,
      reportExcused: (line: string) => messages.push(line),
      measureInstrumentSurface: () => ({ head: { candidates: [SCRIPT], gaps: [SCRIPT] }, base: { candidates: [], gaps: [] } }),
    });
    assert.equal(result.unmeasured, null);
    assert.equal(result.violations.length, 1, source);
    assert.deepEqual(messages, [], source);
  }
});
