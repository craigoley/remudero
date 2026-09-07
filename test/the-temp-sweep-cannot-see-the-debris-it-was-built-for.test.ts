// W1-T3058 — `sweepStaleTempDirs` opened with `startsWith(RMD_TMP_PREFIX)` and the prefix is
// `rmd-`, so every pre-W1-T2786 `remudero-*` dir failed the FIRST test in the loop: never aged,
// never removed. MEASURED on the operator's Mac: 138 dirs, 11 GiB, a 228 GiB volume at 100%, and an
// agent session that could not run a single command because the harness could not write its output.
//
// THE BYSTANDER ROWS ARE THE POINT. A sweep that passes its happy path while deleting someone
// else's directory is strictly worse than the disk filling.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_TEMP_SWEEP_MAX_AGE_MS,
  LEGACY_TMP_PREFIXES,
  MIN_LEGACY_TMP_PREFIX_LENGTH,
  RMD_TMP_PREFIX,
  isRmdOwnedTempName,
  sweepStaleTempDirs,
} from "../src/lib/tmp.js";

/** An isolated sweep root, so no test ever reads the real /tmp. */
function root(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3058-`));
}

/** A directory with an mtime `ageMs` in the past. */
function aged(dir: string, name: string, ageMs: number): string {
  const full = join(dir, name);
  mkdirSync(full, { recursive: true });
  const when = new Date(Date.now() - ageMs);
  utimesSync(full, when, when);
  return full;
}

const OLD = DEFAULT_TEMP_SWEEP_MAX_AGE_MS * 2;
const FRESH = 1000;

test("W1-T3058 criterion 1: a STALE legacy dir is reaped on the same rule as an rmd- dir", () => {
  const dir = root();
  const legacy = aged(dir, "remudero-task2802", OLD);
  const current = aged(dir, `${RMD_TMP_PREFIX}whatever`, OLD);
  sweepStaleTempDirs({ root: dir });
  assert.equal(existsSync(legacy), false, "the debris that filled the disk must be reaped");
  assert.equal(existsSync(current), false, "and the current prefix still is");
});

test("W1-T3058 criterion 1: a FRESH legacy dir is kept — the age ceiling did not move", () => {
  // The widening is WHICH NAMES are considered, never WHEN one is removed. A dir a concurrent
  // invocation is still using must never be collateral.
  const dir = root();
  const legacy = aged(dir, "remudero-pr4388.hTdnyZ", FRESH);
  sweepStaleTempDirs({ root: dir });
  assert.equal(existsSync(legacy), true);
});

test("W1-T3058 criterion 2 (falsifier): A BYSTANDER IS NEVER REMOVED, AT ANY AGE", () => {
  // `acc-` and `kick-` are real prefixes in hooks/mkdtemp-allowlist.txt, which is exactly why that
  // file was REJECTED as the source for this set: sweeping them would delete a stranger's /tmp dir.
  const dir = root();
  const acc = aged(dir, "acc-someone-elses-work", OLD);
  const kick = aged(dir, "kick-off-notes", OLD);
  const unrelated = aged(dir, "my-important-scratch", OLD);
  sweepStaleTempDirs({ root: dir });
  for (const [label, p] of [["acc-", acc], ["kick-", kick], ["unrelated", unrelated]] as const) {
    assert.equal(existsSync(p), true, `${label} must survive at any age`);
  }
});

test("W1-T3058 criterion 2 (falsifier): a FILE matching a swept prefix is left alone", () => {
  const dir = root();
  const file = join(dir, "remudero-not-a-directory");
  writeFileSync(file, "x");
  const when = new Date(Date.now() - OLD);
  utimesSync(file, when, when);
  sweepStaleTempDirs({ root: dir });
  assert.equal(existsSync(file), true, "the directory-only guard applies to legacy names too");
});

test("W1-T3058 criterion 4: every shipped legacy prefix is long enough to be unambiguous", () => {
  // A BACKSTOP, not a tunable: it exists so a careless `acc-` addition fails here instead of
  // deleting a bystander's directory in production.
  assert.ok(LEGACY_TMP_PREFIXES.length > 0);
  for (const p of LEGACY_TMP_PREFIXES) {
    assert.ok(
      p.length >= MIN_LEGACY_TMP_PREFIX_LENGTH,
      `legacy prefix ${JSON.stringify(p)} is shorter than ${MIN_LEGACY_TMP_PREFIX_LENGTH} — see this file's header`,
    );
    assert.match(p, /-$/, "a prefix must end in a separator so it cannot match a longer word");
  }
  // and the two the measurement singled out could never qualify
  assert.ok("acc-".length < MIN_LEGACY_TMP_PREFIX_LENGTH);
  assert.ok("kick-".length < MIN_LEGACY_TMP_PREFIX_LENGTH);
});

test("W1-T3058: the ownership predicate admits both prefixes and nothing else", () => {
  assert.equal(isRmdOwnedTempName(`${RMD_TMP_PREFIX}x`), true);
  assert.equal(isRmdOwnedTempName("remudero-task1"), true);
  assert.equal(isRmdOwnedTempName("acc-x"), false);
  assert.equal(isRmdOwnedTempName("remuder"), false, "a partial prefix is not a match");
  assert.equal(isRmdOwnedTempName("xremudero-y"), false, "the prefix must be at the START");
});

test("W1-T3058 criterion 3 (falsifier): the sweep NEVER throws, whatever the root", () => {
  // The CLI preamble calls this on every invocation. A verb that died because housekeeping threw
  // would be a far worse defect than the one being fixed.
  assert.doesNotThrow(() => sweepStaleTempDirs({ root: "/definitely/not/a/real/path/12345" }));
  const dir = root();
  writeFileSync(join(dir, "a-file-where-a-dir-was-expected"), "x");
  assert.doesNotThrow(() => sweepStaleTempDirs({ root: dir }));
});

test("W1-T3058 criterion 3: the added cost is MEASURED, not asserted cheap", () => {
  // Design (iii) requires a number rather than a claim. 200 entries is well past a real /tmp.
  const dir = root();
  for (let i = 0; i < 200; i++) aged(dir, `remudero-bulk-${i}`, FRESH);
  const started = Date.now();
  sweepStaleTempDirs({ root: dir });
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 2000, `one sweep over 200 entries took ${elapsedMs}ms — too slow for a CLI preamble`);
});
