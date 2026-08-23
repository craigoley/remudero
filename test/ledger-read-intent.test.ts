// test/ledger-read-intent.test.ts — W1-T444's structural fix closed the RESOLVER side of the
// ledger-union invariant (`resolveLedgerUnion`'s coverage refusal, `ledgerRotationEntries` as the
// one definition of the corpus). It never touched the CALLER side: `readLedgerLines(path,
// ledgerFs)` takes a bare path, so a live-file read and "the first step of a union read" are the
// SAME call — nothing at the call site records which one a caller meant, and W1-T1013's own
// harvest instance (#2164, fixed as #2262) shows that gets forgotten in practice, not in theory.
//
// THIS TASK (W1-T1262) makes that choice DECLARED rather than defaulted-into, via design option
// (a) from the task's own `design` note: a lint-style source scan, the same house pattern
// `test/no-raw-nul.test.ts` already uses for a different invariant (walk tracked sources, fail
// naming the offender). `ledgerReadIntentViolations` (src/lib/status.ts) is that scan: every call
// to `readLedgerLines(` must carry a `ledger-read-intent: live` or `ledger-read-intent: union`
// comment on the same line or the line directly above, or it is a violation, named by file and
// line — never a bare count.
//
// THE FALSIFIER RUNS BOTH WAYS (design note (iii)): an undeclared live-file call must be refused
// (first test below), and a declared one — either flavour — must pass unchanged (second and third
// tests). The fourth test proves the check names the offender rather than reporting a count, and
// the fifth runs the scan for real against `src/lib/status.ts` itself — the file this task
// declares as "the narrowing/refusal point for every option" — so this gate has actual teeth on
// the one production file already migrated, not just on fixtures.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ledgerReadIntentViolations } from "../src/lib/status.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("PROPERTY a readLedgerLines call that takes the live file alone without declaring intent is refused", () => {
  const source = [
    "export function loadRecent(path, ledgerFs) {",
    "  const lines = readLedgerLines(path, ledgerFs);",
    "  return lines;",
    "}",
    "",
  ].join("\n");
  const violations = ledgerReadIntentViolations([{ path: "src/lib/fixture-undeclared.ts", text: source }]);
  assert.equal(violations.length, 1, "an undeclared bare-path call must be refused exactly once");
  assert.equal(violations[0].file, "src/lib/fixture-undeclared.ts");
  assert.equal(violations[0].line, 2);
});

test("PROPERTY a call that declares the newest-rows (live) intent still passes", () => {
  const sameLine = [
    "export function loadRecent(path, ledgerFs) {",
    "  const lines = readLedgerLines(path, ledgerFs); // ledger-read-intent: live",
    "  return lines;",
    "}",
    "",
  ].join("\n");
  const lineAbove = [
    "export function loadRecent(path, ledgerFs) {",
    "  // ledger-read-intent: live — rmd doctor wants the newest rows only.",
    "  const lines = readLedgerLines(path, ledgerFs);",
    "  return lines;",
    "}",
    "",
  ].join("\n");
  for (const [label, text] of [
    ["same-line marker", sameLine],
    ["marker on the line above", lineAbove],
  ] as const) {
    const violations = ledgerReadIntentViolations([{ path: "src/lib/fixture-live.ts", text }]);
    assert.deepEqual(violations, [], `a declared live-file read must survive unchanged (${label})`);
  }
});

test("PROPERTY a union read is distinguishable from a live-file read at the call site, not by inspection", () => {
  // Three call sites, three markers (none, live, union) — DISTINGUISHABLE means readable straight
  // off the source text, without ever running the code or inspecting what it returns.
  const source = [
    "export function loadLive(path, ledgerFs) {",
    "  const live = readLedgerLines(path, ledgerFs); // ledger-read-intent: live",
    "  return live;",
    "}",
    "",
    "export function seedUnion(path, ledgerFs) {",
    "  const seed = readLedgerLines(path, ledgerFs); // ledger-read-intent: union",
    "  return extendWithRotations(seed);",
    "}",
    "",
    "export function forgotten(path, ledgerFs) {",
    "  return readLedgerLines(path, ledgerFs);",
    "}",
    "",
  ].join("\n");
  const violations = ledgerReadIntentViolations([{ path: "src/lib/fixture-mixed.ts", text: source }]);
  // Only the undeclared third call is a violation — the live- and union-declared calls both pass,
  // and they passed via TWO DIFFERENT, textually distinct markers, not one flavour standing in
  // for both.
  assert.deepEqual(
    violations.map((v) => v.line),
    [12],
  );
  const lines = source.split("\n");
  assert.match(lines[1], /ledger-read-intent:\s*live\b/);
  assert.match(lines[6], /ledger-read-intent:\s*union\b/);
  assert.notEqual(lines[1].trim(), lines[6].trim(), "the live and union declarations must differ");

  // An invented third value is not a declaration at all — only "live" and "union" are legal, so
  // the distinction stays exactly two-way, never open-ended.
  const bogus = source.replace("ledger-read-intent: union", "ledger-read-intent: everything");
  const bogusViolations = ledgerReadIntentViolations([{ path: "src/lib/fixture-mixed.ts", text: bogus }]);
  assert.deepEqual(
    bogusViolations.map((v) => v.line),
    [7, 12],
    "a value other than live/union must not count as a declaration",
  );
});

test("PROPERTY the check names the offending reader rather than reporting a bare count", () => {
  const source = [
    "export function a(path, ledgerFs) {",
    "  return readLedgerLines(path, ledgerFs);",
    "}",
    "",
    "export function b(path, ledgerFs) {",
    "  return readLedgerLines(path, ledgerFs);",
    "}",
    "",
  ].join("\n");
  const violations = ledgerReadIntentViolations([
    { path: "src/lib/fixture-a.ts", text: source },
    { path: "src/lib/fixture-b.ts", text: "export const clean = 1;\n" },
  ]);
  // Two distinct offending lines in ONE file — a bare count ("2 violations") could not tell them
  // apart or say which file; this reports each, named.
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line}`),
    ["src/lib/fixture-a.ts:2", "src/lib/fixture-a.ts:6"],
  );
  for (const v of violations) {
    assert.equal(typeof v.file, "string");
    assert.ok(v.file.length > 0, "the offending file must be named");
    assert.ok(v.text.includes("readLedgerLines("), "the offending line's own text is carried, not summarised away");
  }
});

test("PROPERTY src/lib/status.ts — the narrowing point readLedgerLines is defined at — is itself clean", () => {
  const tracked = execFileSync("git", ["ls-files", "src/lib/status.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(tracked, ["src/lib/status.ts"], "src/lib/status.ts must be tracked for this gate to see it");
  const text = readFileSync(join(REPO_ROOT, "src/lib/status.ts"), "utf8");
  const violations = ledgerReadIntentViolations([{ path: "src/lib/status.ts", text }]);
  assert.deepEqual(violations, [], "every readLedgerLines call inside its own defining module must be declared");
});
