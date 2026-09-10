import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * W1-T3072 — the local check must reproduce the reviewer's verdict, not offer a second opinion.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "rule25-precheck.mjs");

type Verdict = { ok: boolean; reason?: string; instrumentPaths: string[]; srcPaths: string[] };
type RunnerDeps = {
  diffAgainstBase?: (base: string) => string;
  changedFiles?: (base: string) => string[];
  log?: (line: string) => void;
  error?: (line: string) => void;
};
const { baseFromArgv, judgeRule25, runRule25Precheck } = (await import(pathToFileURL(SCRIPT).href)) as {
  baseFromArgv: (argv: string[]) => string;
  judgeRule25: (diff: string, files: string[]) => Verdict;
  runRule25Precheck: (base: string, deps?: RunnerDeps) => number;
};

function diffAdding(file: string, line: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,0 +1,1 @@",
    `+${line}`,
    "",
  ].join("\n");
}

function capturePrecheck(base: string, deps: RunnerDeps = {}): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runRule25Precheck(base, {
    ...deps,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out, err };
}

test("--base parsing defaults to origin/main and consumes the following argument", () => {
  assert.equal(baseFromArgv(["node", "scripts/rule25-precheck.mjs"]), "origin/main");
  assert.equal(baseFromArgv(["node", "scripts/rule25-precheck.mjs", "--base", "HEAD^"]), "HEAD^");
  assert.equal(baseFromArgv(["node", "scripts/rule25-precheck.mjs", "--base"]), "origin/main");
});

test("#4950's repair shape is refused before push", () => {
  const files = [
    "scripts/console-parity-baseline.json",
    "scripts/console-parity-ratchet.mjs",
    "src/lib/ledger-compact.ts",
    "src/run-task.ts",
  ];
  const diff = diffAdding("src/lib/ledger-compact.ts", "export function compactedRows() { return true; }");
  const verdict = judgeRule25(diff, files);
  assert.equal(verdict.ok, false, "the precheck must refuse what the reviewer refused on #4950");
  assert.deepEqual(verdict.instrumentPaths, ["scripts/console-parity-baseline.json", "scripts/console-parity-ratchet.mjs"]);
  assert.deepEqual(verdict.srcPaths, ["src/lib/ledger-compact.ts", "src/run-task.ts"]);
});

test("an instrument-only prerequisite passes", () => {
  const files = [
    "scripts/console-parity-baseline.json",
    "scripts/console-parity-ratchet.mjs",
    "test/ledger-compact-is-preregistered-as-cli-only.test.ts",
  ];
  assert.equal(judgeRule25(diffAdding(files[2], "// falsifier"), files).ok, true);
});

test("a src-only diff passes", () => {
  assert.equal(judgeRule25(diffAdding("src/lib/clock.ts", "export const y = 2;"), ["src/lib/clock.ts"]).ok, true);
});

test("an exempt per-file ledger does not entangle", () => {
  const files = ["scripts/source-size-baseline.json", "src/lib/clock.ts"];
  assert.equal(judgeRule25(diffAdding("src/lib/clock.ts", "export const z = 3;"), files).ok, true);
});

test("the detector receives the diff, so a comment-only src change is not product code", () => {
  const instrument = "scripts/console-parity-ratchet.mjs";
  const product = "src/lib/clock.ts";
  const files = [instrument, product];
  const instrumentDiff = diffAdding(instrument, "export const rule = true;");
  assert.equal(judgeRule25(instrumentDiff + diffAdding(product, "// comment only"), files).ok, true);
  assert.equal(judgeRule25(instrumentDiff + diffAdding(product, "export const w = 4;"), files).ok, false);
});

test("the runner's real diff readers report this instrument-only branch clean", () => {
  const res = capturePrecheck("origin/main");
  assert.equal(res.code, 0, `this branch should be rule-25 clean; stderr:\n${res.err.join("\n")}`);
  assert.deepEqual(res.err, []);
  assert.match(res.out.join("\n"), /rule25-precheck: OK --/);
});

test("the runner prints the reviewer refusal and names both sides of an entangled diff", () => {
  const files = ["scripts/console-parity-ratchet.mjs", "src/lib/ledger-compact.ts"];
  const diff = diffAdding(files[0], "export const instrument = true;") + diffAdding(files[1], "export const product = true;");
  const res = capturePrecheck("HEAD^", {
    diffAgainstBase: () => diff,
    changedFiles: () => files,
  });
  assert.equal(res.code, 1);
  assert.deepEqual(res.out, []);
  assert.match(res.err.join("\n"), /THIS DIFF WILL BE REFUSED under Standing rule 25/);
  assert.match(res.err.join("\n"), /instrument path\(s\): scripts\/console-parity-ratchet\.mjs/);
  assert.match(res.err.join("\n"), /src\/ product path\(s\): src\/lib\/ledger-compact\.ts/);
  assert.match(res.err.join("\n"), /TO FIX, either: \(1\) split/);
});

test("the runner reports an unreadable diff in-process rather than reporting clean", () => {
  const res = capturePrecheck("refs/heads/no-such-base-xyzzy", {
    diffAgainstBase: () => {
      throw new Error("bad base");
    },
  });
  assert.equal(res.code, 2);
  assert.deepEqual(res.out, []);
  assert.match(res.err.join("\n"), /could not read the diff against refs\/heads\/no-such-base-xyzzy \(bad base\)/);
  assert.match(res.err.join("\n"), /REFUSING to report clean/);
});

test("an unreadable diff exits 2 rather than reporting clean", () => {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/rule25-precheck.mjs", "--base", "refs/heads/no-such-base-xyzzy"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(res.status, 2, `an unreadable base must exit 2; stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REFUSING to report clean/);
});
