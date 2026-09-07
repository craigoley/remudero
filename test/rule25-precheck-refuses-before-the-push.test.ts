import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * test/rule25-precheck-refuses-before-the-push.test.ts — W1-T3072.
 *
 * The falsifier for the local rule-25 precheck. It asserts the script reproduces the REVIEWER's
 * verdict, not a second opinion: a local check that disagreed would send an author to split a PR
 * the gate would have passed, or clear one it is about to refuse.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "rule25-precheck.mjs");

/** `scripts/**` sits OUTSIDE tsconfig's `include`, so a STATIC import of the .mjs is a TS7016 —
 *  the same reason test/a-gate-shaped-instrument-that-nothing-invokes.test.ts reaches its script
 *  through a runtime import. A dynamic specifier is not statically resolved, so this loads the REAL
 *  module with no shadow copy that could drift from it. */
type Verdict = { ok: boolean; reason?: string; instrumentPaths: string[]; srcPaths: string[] };
const { judgeRule25 } = (await import(pathToFileURL(SCRIPT).href)) as {
  judgeRule25: (diff: string, files: string[]) => Verdict;
};

/** A unified diff adding one executable line to `file` — what `srcChangeIsExecutable` looks for. */
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

test("#4493's real shape is REFUSED: a new baseline riding with src/ product code", () => {
  // The exact file list that made remudero-review report `entangled` on 2026-09-07.
  const files = [
    "scripts/clock-signature-baseline.json",
    "src/lib/clock.ts",
    "src/lib/daemon.ts",
    "test/clock-port.test.ts",
  ];
  const diff = diffAdding("src/lib/clock.ts", "export const x = 1;");
  const verdict = judgeRule25(diff, files);
  assert.equal(verdict.ok, false, "the precheck must refuse what the reviewer refuses");
  assert.ok(
    verdict.instrumentPaths.includes("scripts/clock-signature-baseline.json"),
    "the refusal must NAME the instrument, not merely report a boolean",
  );
  assert.ok(verdict.srcPaths.includes("src/lib/clock.ts"), "and name the product half too");
});

test("an INSTRUMENT-ONLY diff passes — the sanctioned shape, falsifier and docs included", () => {
  const files = [
    "scripts/clock-signature-baseline.json",
    "test/clock-signature-census.test.ts",
    "docs/forensics/clock.md",
  ];
  const verdict = judgeRule25(diffAdding("test/clock-signature-census.test.ts", "// x"), files);
  assert.equal(verdict.ok, true, "an instrument plus its own falsifier is the shape rule 25 permits");
});

test("a src-ONLY diff passes — the rule is entanglement, never instrument-touching alone", () => {
  const verdict = judgeRule25(diffAdding("src/lib/clock.ts", "export const y = 2;"), ["src/lib/clock.ts"]);
  assert.equal(verdict.ok, true);
});

test("an EXEMPT ledger does not entangle — the exemption is the reviewer's, not a second list here", () => {
  // scripts/source-size-baseline.json is in ENTANGLEMENT_EXEMPT_INSTRUMENTS: a per-file ledger,
  // where raising a row records debt and cannot make a failing falsifier pass. Every PR that grows
  // a src file must record it, so treating this as entanglement would make the gate unsatisfiable.
  const files = ["scripts/source-size-baseline.json", "src/lib/clock.ts"];
  const verdict = judgeRule25(diffAdding("src/lib/clock.ts", "export const z = 3;"), files);
  assert.equal(verdict.ok, true, "recording a size ledger beside the growth that caused it is the ordinary outcome");
});

test("the DIFF is passed, not just the file list — a non-executable src change is not the product half", () => {
  // detectInstrumentEntanglement only counts a src/ path when the diff shows executable content for
  // it. Passing paths alone would report entanglement the gate itself clears, which is precisely
  // the "second opinion" failure this script exists not to be.
  const files = ["scripts/clock-signature-baseline.json", "src/lib/clock.ts"];
  const commentOnly = diffAdding("src/lib/clock.ts", "// a comment, no executable content");
  assert.equal(judgeRule25(commentOnly, files).ok, true, "a comment-only src change is not product code");
  const real = diffAdding("src/lib/clock.ts", "export const w = 4;");
  assert.equal(judgeRule25(real, files).ok, false, "control: the same file list DOES refuse on an executable change");
});

test("an UNREADABLE diff exits 2 — a check that could not look must never report clean", () => {
  // The pure judge above cannot reach this path, so it is exercised through the real script. Without
  // it, changing the `return 2` to `return 0` passes every other test in this file — measured.
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/rule25-precheck.mjs", "--base", "refs/heads/no-such-base-xyzzy"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(res.status, 2, `an unreadable base must exit 2, not 0; stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REFUSING to report clean/, "and must say so rather than failing silently");
});
