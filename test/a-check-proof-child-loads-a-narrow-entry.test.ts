// @census-reads: src/ — the import graph walked from src/check-proof-main.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { stripComments } from "../src/lib/test-impact-map.js";
import { gitRepo } from "./helpers/git-repo.js";
import { makeRuntimeFixture } from "./helpers/native-runtime-fixture.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = resolve(root, "src/check-proof-main.ts");

function runNarrow(argv: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(process.execPath, argv, { cwd, env, input, encoding: "utf8", timeout: 60_000 });
}

// @source-text-subject: the static import graph is the task's isolation contract.
test("W1-T7728: the narrow check-proof entry never imports the run-task module", () => {
  const visited = new Set<string>();
  function walk(path: string): void {
    assert.notEqual(path, resolve(root, "src/run-task.ts"), "a narrow child must not load the CLI");
    if (visited.has(path)) return;
    visited.add(path);
    const source = stripComments(readFileSync(path, "utf8"));
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*)(["'])(\.[^"']+)\1/g);
    for (const [, , specifier] of imports) {
      const target = resolve(dirname(path), specifier!);
      const candidates = [target.replace(/\.js$/, ".ts"), target];
      const next = candidates.find(existsSync);
      assert.ok(next, `cannot resolve ${specifier} from ${path}`);
      walk(next);
    }
  }
  walk(entry);
  assert.ok(visited.has(resolve(root, "src/lib/check-proof.ts")), "the entry must use the extracted executor");
  assert.ok(visited.has(resolve(root, "src/lib/review.ts")), "positive control: the reviewer executor was traversed");
});

test("W1-T7728: the narrow entry and rmd check-proof agree on verdict and exit code", async () => {
  const { checkProofChildArgv } = await import("../src/lib/check-proof.js");
  const fixture = gitRepo({ kind: "narrow-proof" });
  try {
    writeFileSync(resolve(fixture.dir, "marker.txt"), "shared\n");
    fixture.git("add", "marker.txt");
    fixture.git("commit", "-qm", "base marker");
    writeFileSync(resolve(fixture.dir, "marker.txt"), "shared\nadded\n");
    fixture.git("add", "marker.txt");
    fixture.git("commit", "-qm", "head marker");
    const env: NodeJS.ProcessEnv = { ...process.env, RMD_SELF_SYNC_DONE: "1" };
    delete env.NODE_TEST_CONTEXT;
    for (const [pattern, code, verdict] of [["added", 0, "pass"], ["missing", 1, "fail"], ["shared", 5, "pass"]] as const) {
      const args = [`grep: ${pattern} in marker.txt`, "--base", "HEAD~1"];
      const argv = checkProofChildArgv(args[0]!, "HEAD~1");
      assert.equal(argv[2], entry, "the shared builder must launch the narrow entry");
      const narrow = runNarrow(argv, fixture.dir, env);
      const cli = spawnSync(resolve(root, "bin/rmd"), ["check-proof", ...args], {
        cwd: fixture.dir, env, encoding: "utf8", timeout: 60_000,
      });
      assert.equal(narrow.error, undefined);
      assert.equal(cli.error, undefined);
      assert.equal(narrow.status, code, `${narrow.stdout}\n${narrow.stderr}`);
      assert.equal(cli.status, code, `${cli.stdout}\n${cli.stderr}`);
      const reading = (stdout: string) => stdout.split("\n").filter((line) => /^(verdict:|base:|discrimination:)/.test(line));
      assert.match(narrow.stdout, new RegExp(`^verdict:\\s+${verdict}$`, "m"));
      assert.deepEqual(reading(narrow.stdout), reading(cli.stdout));
      if (code === 5) assert.match(narrow.stdout, /discrimination: executed_stale/);
    }
  } finally {
    fixture.cleanup();
  }
});

function exportFixture(t: TestContext, baseSource: string) {
  const fixture = makeRuntimeFixture();
  t.after(() => fixture.cleanup());
  fixture.git("add", "-f", "node_modules");
  writeFileSync(resolve(fixture.dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(resolve(fixture.dir, "src/a.ts"), baseSource);
  writeFileSync(resolve(fixture.dir, "test/probe.test.ts"),
    'import {test} from "node:test";import assert from "node:assert/strict";import {added} from "../src/a.js";test("observed CLI export",()=>assert.equal(added,3));\n');
  fixture.git("add", "."); fixture.git("commit", "-qm", "test: base export fixture");
  writeFileSync(resolve(fixture.dir, "src/a.ts"), "export const added = 3;\n");
  fixture.git("add", "."); fixture.git("commit", "-qm", "test: head export fixture");
  return fixture;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test("the narrow CLI awaits a real missing-export observation before claiming discrimination", async t => {
  const fixture = exportFixture(t, "export const kept = 1;\n");
  const { checkProofChildArgv } = await import("../src/lib/check-proof.js");
  const out = runNarrow(checkProofChildArgv("unit test: test/probe.test.ts", "HEAD~1"), fixture.dir, childEnv());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /COULD NOT LINK — base lacks export\(s\) added/);
  assert.match(out.stdout, /discrimination: discriminates/);
  assert.doesNotMatch(out.stdout, /\[object Promise\]/);
});

test("the narrow CLI retains unknown for an unrelated base load failure", async t => {
  const fixture = exportFixture(t, "export const malformed = ;\n");
  const { checkProofChildArgv } = await import("../src/lib/check-proof.js");
  const out = runNarrow(checkProofChildArgv("unit test: test/probe.test.ts", "HEAD~1"), fixture.dir, childEnv());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /discrimination: unknown/);
  assert.doesNotMatch(out.stdout, /COULD NOT LINK|\[object Promise\]/);
});

test("the narrow observation protocol reads real fixtures and refuses invalid requests", async t => {
  const fixture = exportFixture(t, "export const kept = 1;\n");
  const base = gitRepo({ scope: t, kind: "narrow-observation-base" });
  mkdirSync(resolve(base.dir, "src"));
  writeFileSync(resolve(base.dir, "src/a.ts"), "export const kept = 1;\n");
  const { checkProofObservationChildArgv } = await import("../src/lib/check-proof.js");
  const output = `# ${resolve(base.dir, "test/probe.test.ts")}:1\n# SyntaxError: The requested module '../src/a.js' does not provide an export named 'added'\n`;
  const request = { output, base: base.dir, head: fixture.dir };
  const valid = runNarrow(checkProofObservationChildArgv(), fixture.dir, childEnv(), JSON.stringify(request));
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).state, "attributed");
  assert.match(JSON.parse(valid.stdout).note, /base lacks export\(s\) added/);
  const unproven = runNarrow(checkProofObservationChildArgv(), fixture.dir, childEnv(),
    JSON.stringify({ ...request, output: "unrelated load failure" }));
  assert.deepEqual(JSON.parse(unproven.stdout), { state: "unproven" });
  for (const input of ["{", "null", JSON.stringify({ ...request, base: "relative" }),
    JSON.stringify({ ...request, output: 3 }), JSON.stringify({ ...request, head: null }),
    " ".repeat(4 * 1024 ** 2 + 1)]) {
    const out = runNarrow(checkProofObservationChildArgv(), fixture.dir, childEnv(), input);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { state: "unavailable", reason: "invalid-request" });
  }
  const extra = runNarrow([...checkProofObservationChildArgv(), "extra"], fixture.dir, childEnv(), JSON.stringify(request));
  assert.equal(extra.status, 0, extra.stderr);
  assert.deepEqual(JSON.parse(extra.stdout), { state: "unavailable", reason: "invalid-request" });
});

test("an unavailable CLI export observation never produces an attribution", async () => {
  const { observeCliMissingExports } = await import("../src/lib/check-proof.js");
  const unavailable = (() => { throw new Error("controlled observer unavailable"); }) as typeof spawnSync;
  assert.deepEqual(observeCliMissingExports("controlled load error", root, root, unavailable),
    { state: "unavailable", reason: "observer-error" });
  for (const [script, expected] of [
    ["process.stdout.write('{')", { state: "unavailable", reason: "observer-error" }],
    ["process.exitCode=1", { state: "unavailable", reason: "child-failed" }],
    ["process.kill(process.pid, 'SIGTERM')", { state: "unavailable", reason: "child-failed" }],
    ["process.stdout.write('null')", { state: "unavailable", reason: "invalid-response" }],
    ["process.stdout.write(JSON.stringify({state:'attributed',note:''}))", { state: "unavailable", reason: "invalid-response" }],
    ["process.stdout.write(JSON.stringify({state:'unavailable',reason:'invalid-request'}))", { state: "unavailable", reason: "invalid-request" }],
    ["process.stdout.write(JSON.stringify({state:'unavailable',reason:'observer-error'}))", { state: "unavailable", reason: "observer-error" }],
  ] as const) {
    const child = ((_file: string, _args: string[], options: Parameters<typeof spawnSync>[2]) =>
      spawnSync(process.execPath, ["-e", script], options)) as typeof spawnSync;
    assert.deepEqual(observeCliMissingExports("controlled load error", root, root, child), expected);
  }
  const missingPath = resolve(root, "coverage/nonexistent-observer-executable");
  assert.equal(existsSync(missingPath), false);
  const missingExecutable = ((_file: string, _args: string[], options: Parameters<typeof spawnSync>[2]) =>
    spawnSync(missingPath, [], options)) as typeof spawnSync;
  assert.deepEqual(observeCliMissingExports("controlled load error", root, root, missingExecutable),
    { state: "unavailable", reason: "child-failed" });
  assert.deepEqual(observeCliMissingExports(" ".repeat(4 * 1024 ** 2), root, root, unavailable),
    { state: "unavailable", reason: "request-too-large" });
});

test("the CLI reports an unavailable export observer while retaining unknown", async t => {
  const fixture = exportFixture(t, "export const kept = 1;\n");
  const { checkProofCommand } = await import("../src/lib/check-proof.js");
  const lines: string[] = [], previous = process.cwd();
  t.mock.method(console, "log", (...args: unknown[]) => { lines.push(args.join(" ")); });
  process.chdir(fixture.dir);
  try {
    const result = checkProofCommand(["unit test: test/probe.test.ts", "--base", "HEAD~1"], {
      observeMissingExports: () => ({ state: "unavailable", reason: "child-failed" }),
    });
    assert.equal(result, 0);
    assert.match(lines.join("\n"), /export observation unavailable \(child-failed\) — no attribution made/);
    assert.match(lines.join("\n"), /discrimination: unknown/);
    assert.doesNotMatch(lines.join("\n"), /COULD NOT LINK/);
  } finally { process.chdir(previous); }
});
