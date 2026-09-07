// W1-T3069 — `RMD_SELF_SYNC_DONE=1` is what rmd tells an operator to set on a detached HEAD, and
// every worktree this fleet creates is detached. It flips `checkCliFreshness` from `assessed` to
// `guarded`, which 26 suites assert on: MEASURED 48 failures with it set against 2 without, all
// surfacing as ordinary assertion errors that name nothing.
//
// THE GUARD EXITS THE PROCESS, so every row below drives a CHILD run of the real setup file rather
// than importing it — an in-process test of a `process.exit` guard would take the runner with it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run a trivial script through the REAL setup import, with the variable set or not. */
function runWithSetup(env: Record<string, string | undefined>): { status: number; out: string } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "-e", "console.log('BODY-RAN')"],
    { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, ...env } },
  );
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

test("W1-T3069 criterion 1: the guard REFUSES before the body runs, and names cause and remedy", () => {
  const { status, out } = runWithSetup({ RMD_SELF_SYNC_DONE: "1" });
  assert.equal(status, 1, "it must exit non-zero");
  assert.doesNotMatch(out, /BODY-RAN/, "and refuse BEFORE any test body executes");
  assert.match(out, /RMD_SELF_SYNC_DONE is set/, "names the variable");
  assert.match(out, /'guarded' instead of 'assessed'/, "names what it DOES — the whole defect is that the failure explains nothing");
  assert.match(out, /env -u RMD_SELF_SYNC_DONE/, "names the remedy");
});

test("W1-T3069 criterion 2 (falsifier): ABSENT is the normal path and is untouched", () => {
  // A guard that fired unconditionally would break every CI run — far worse than the confusion it
  // removes. CI never sets this variable, so CI must never see the guard.
  const { status, out } = runWithSetup({ RMD_SELF_SYNC_DONE: undefined });
  assert.equal(status, 0);
  assert.match(out, /BODY-RAN/, "the body must run");
  assert.doesNotMatch(out, /REFUSED/, "and the guard must say nothing at all");
});

test("W1-T3069 criterion 3: it REFUSES rather than unsetting, so the printed command reproduces", () => {
  // Quietly deleting the variable would produce a result the re-run cannot reproduce. The refusal
  // text says so explicitly, and the exit code is what makes it a refusal rather than a warning.
  const { status, out } = runWithSetup({ RMD_SELF_SYNC_DONE: "1" });
  assert.equal(status, 1);
  assert.match(out, /the command you re-run is the\s+command that produced this result/);
});

test("W1-T3069 (falsifier): any value triggers it, not just \"1\"", () => {
  // `export RMD_SELF_SYNC_DONE=true` or `=0` is just as contaminating: the CLI checks only that the
  // variable is SET. A guard keyed on the literal "1" would miss the shell that set it differently.
  for (const value of ["1", "true", "0", ""]) {
    const { status } = runWithSetup({ RMD_SELF_SYNC_DONE: value });
    assert.equal(status, 1, `value ${JSON.stringify(value)} must still refuse`);
  }
});
