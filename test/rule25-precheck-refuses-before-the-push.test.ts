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
const { judgeRule25 } = (await import(pathToFileURL(SCRIPT).href)) as {
  judgeRule25: (diff: string, files: string[]) => Verdict;
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

test("#4950's repair shape is refused before push", () => {
  const files = [
    "scripts/console-parity-baseline.json",
    "scripts/console-parity-ratchet.mjs",
    "src/lib/ledger-compact.ts",
    "src/run-task.ts",
  ];
  const diff = diffAdding("src/lib/ledger-compact.ts", "export function ledgerCompact() { return true; }");
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

test("an unreadable diff exits 2 rather than reporting clean", () => {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/rule25-precheck.mjs", "--base", "refs/heads/no-such-base-xyzzy"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(res.status, 2, `an unreadable base must exit 2; stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REFUSING to report clean/);
});
