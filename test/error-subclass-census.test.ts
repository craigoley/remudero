// test/error-subclass-census.test.ts — W1-T2901: hold the direct-`Error`-subclass population at
// its recorded ceiling while the shared envelope (src/lib/errors.ts's `RmdError`) is adopted one
// class at a time, instead of migrating all of them in one high-risk sweep.
//
// Audit recon-2026-09-05 R-37 found dozens of hand-rolled `class X extends Error` subclasses with
// no shared `kind` or exit-code discriminant. This task adopts the envelope for exactly one of
// them (`PlanError`) and wires `main()`'s process boundary through `exitCodeFor` -- the other
// ~50-odd classes are NOT migrated here (see src/lib/errors.ts's header). What stops that debt
// from silently growing while migrations trickle in is THIS test: it re-measures the population
// every run and refuses a count above scripts/error-subclass-baseline.json's recorded ceiling.
//
// THIS IS A CEILING, NOT A TARGET. A class migrating OFF `extends Error` (onto `RmdError`) is
// free to leave the baseline unchanged -- the count only needs to stay <= the ceiling, so an
// improvement never has to touch this file. Lowering the recorded number is a deliberate,
// reviewable act a migration PR can choose to make; this test does not force it. Growth above
// the ceiling is the one thing refused: a new class that still extends `Error` directly needs a
// human decision (adopt `RmdError` instead, or edit the baseline down/up with a stated reason),
// not a silent pass.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE_PATH = fileURLToPath(new URL("../scripts/error-subclass-baseline.json", import.meta.url));

// Direct extension only ("class X extends Error") -- a class that extends another named
// `*Error` subclass (indirect chain) is not counted here; it is already one hop closer to a
// shared discriminant than a class hanging straight off the built-in.
const DIRECT_ERROR_EXTENDS_PATTERN = "class \\w+ extends Error\\b";

function countDirectErrorSubclasses(root: string): number {
  try {
    const matches = execFileSync("git", ["-C", root, "grep", "-hoE", DIRECT_ERROR_EXTENDS_PATTERN, "--", "src/*.ts"], {
      encoding: "utf8",
    });
    return matches.split("\n").filter(Boolean).length;
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && !e.stdout) return 0;
    throw err;
  }
}

function readBaseline(): { directErrorSubclassCount: number } {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  assert.equal(
    typeof raw.directErrorSubclassCount,
    "number",
    "scripts/error-subclass-baseline.json must record 'directErrorSubclassCount' as a number",
  );
  return raw;
}

test("the count of classes extending Error directly is recorded in scripts/error-subclass-baseline.json", () => {
  const baseline = readBaseline();
  assert.ok(
    Number.isInteger(baseline.directErrorSubclassCount) && baseline.directErrorSubclassCount >= 0,
    "the recorded ceiling must be a non-negative integer",
  );
});

test("the count of classes extending Error directly under tracked src/**/*.ts cannot grow past the recorded ceiling", () => {
  const baseline = readBaseline();
  const actual = countDirectErrorSubclasses(REPO_ROOT);
  assert.ok(
    actual <= baseline.directErrorSubclassCount,
    `direct-Error-subclass count grew from the recorded ceiling of ${baseline.directErrorSubclassCount} to ${actual}. ` +
      `Either adopt the shared envelope (src/lib/errors.ts's RmdError, as src/lib/plan.ts's PlanError already ` +
      `does — see the class you added/changed) instead of extending Error directly, or, if growth here is a ` +
      `deliberate reviewed decision, raise 'directErrorSubclassCount' in scripts/error-subclass-baseline.json ` +
      `and say why in that file's own comment.`,
  );
});
