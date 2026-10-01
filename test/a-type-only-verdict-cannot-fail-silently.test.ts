// W1-T3305: `isTypeOnlyModule` answered a bare `false` for two different facts — "this module emits
// real code" and "the check could not run" — and a type-only module cannot be covered by any test
// (it transpiles to zero bytes, so no lcov `SF:` record can exist), so the second fact, reported as
// the first, is a block with NO remedy. #4887 and #4893 made the cause rarer and added a collector;
// the VERDICT was still the same boolean and the report still listed the module as a measured gap.
// This file pins the three-valued answer and the report that tells them apart.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { makeTempDir } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "diff-coverage.mjs");

type Verdict = { verdict: "type-only" | "emits-code" | "undecidable"; stage?: string; message?: string };
type Undecidable = { file: string; stage: string; message: string };
// `scripts/**` sits outside tsconfig's `include`, so the real module is reached by a runtime import.
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  classifyTypeOnlyModule: (file: string, readSource?: (f: string) => string) => Verdict;
  classifyMissingSourceCoverage: (
    diffText: string,
    lcov: Set<string>,
    classify?: (f: string) => Verdict,
  ) => { gaps: string[]; undecidable: Undecidable[] };
};
const { classifyTypeOnlyModule, classifyMissingSourceCoverage } = mod;

const diffTouching = (...files: string[]) =>
  files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1,2 @@\n code\n+more\n`).join("");
const unreadable = () => {
  throw new Error("EACCES: permission denied");
};

test("the verdict has THREE values: emits code, emits nothing, and could not decide", () => {
  assert.deepEqual(classifyTypeOnlyModule("x.ts", () => "export interface A { a: string }\n"), { verdict: "type-only" });
  assert.deepEqual(classifyTypeOnlyModule("x.ts", () => "export const z = 1;\n"), { verdict: "emits-code" });
  const undecided = classifyTypeOnlyModule("x.ts", unreadable);
  assert.equal(undecided.verdict, "undecidable");
  assert.equal(undecided.stage, "read");
  assert.match(undecided.message ?? "", /EACCES/);
});

test("an enum is real emitted code, NOT an undecidable check — the stripper's refusal is an answer", () => {
  assert.deepEqual(classifyTypeOnlyModule("x.ts", () => "export enum E { A }\n"), { verdict: "emits-code" });
  assert.deepEqual(classifyTypeOnlyModule("x.ts", () => "export namespace N { export const a = 1; }\n"), { verdict: "emits-code" });
});

test("a module that cannot be parsed is UNDECIDABLE and names the transpile stage", () => {
  const v = classifyTypeOnlyModule("bad.ts", () => "export interface { !!! syntax");
  assert.equal(v.verdict, "undecidable");
  assert.equal(v.stage, "transpile");
  assert.ok((v.message ?? "").length > 0, "the reason must be carried, not dropped");
});

test("an undecidable module is reported by name and is never listed as a measured coverage gap", () => {
  const diff = diffTouching("src/lib/gone.ts", "src/lib/sweep.ts");
  const classify = (f: string): Verdict => (f === "src/lib/gone.ts" ? classifyTypeOnlyModule(f, unreadable) : { verdict: "emits-code" });
  const { gaps, undecidable } = classifyMissingSourceCoverage(diff, new Set<string>(), classify);
  assert.deepEqual(gaps, ["src/lib/sweep.ts"], "only the module that provably emits code is a measured gap");
  assert.equal(undecidable.length, 1);
  assert.equal(undecidable[0]?.file, "src/lib/gone.ts");
  assert.equal(undecidable[0]?.stage, "read");
  assert.match(undecidable[0]?.message ?? "", /EACCES/);
});

test("a genuinely type-only module is still exempt and a module that emits real code is still a gap", () => {
  const diff = diffTouching("src/lib/merge-state.ts", "src/lib/sweep.ts", "src/lib/review.ts");
  const real = classifyMissingSourceCoverage(diff, new Set(["src/lib/review.ts"]));
  assert.deepEqual(real, { gaps: ["src/lib/sweep.ts"], undecidable: [] });
  const bare = classifyMissingSourceCoverage(diffTouching("src/lib/sweep.ts"), new Set<string>());
  assert.deepEqual(bare.gaps, ["src/lib/sweep.ts"], "the vacuity hazard (#1399) must still block a real module");
});

test("the gate's stderr names an undecidable module under its own headline, apart from the measured gaps", () => {
  const cwd = makeTempDir("type-only-undecidable");
  mkdirSync(join(cwd, "src", "lib"), { recursive: true });
  writeFileSync(join(cwd, "src", "lib", "has-code.ts"), "export const real = (): number => 1;\n");
  writeFileSync(join(cwd, "src", "lib", "types-only.ts"), "export interface A { a: string }\n");
  writeFileSync(join(cwd, "src", "lib", "broken.ts"), "export interface { !!! syntax");
  writeFileSync(join(cwd, "lcov.info"), "");
  const files = ["src/lib/has-code.ts", "src/lib/types-only.ts", "src/lib/broken.ts", "src/lib/gone.ts"];
  writeFileSync(join(cwd, "d.diff"), diffTouching(...files));
  const r = spawnSync(process.execPath, ["--no-warnings", SCRIPT, "--lcov", "lcov.info", "--diff", "d.diff"], { cwd, encoding: "utf8" });
  assert.equal(r.status, 1, "an undecidable module still fails closed — it is never waved through");
  const [gapPart = "", undecidablePart = ""] = r.stderr.split("could not be decided");
  assert.match(gapPart, /^ {2}- src\/lib\/has-code\.ts$/m, "the module that emits code is a measured gap");
  assert.doesNotMatch(gapPart, /broken\.ts|gone\.ts|types-only\.ts/, "an undecidable module is not reported as a measured gap");
  assert.match(undecidablePart, /broken\.ts[^\n]*transpile/);
  assert.match(undecidablePart, /gone\.ts[^\n]*read/);
  assert.doesNotMatch(r.stderr, /types-only/, "a type-only module is neither a gap nor undecidable");
});
