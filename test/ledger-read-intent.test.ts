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

// ── W1-T2393 — RECORDING, NOT FIXING ────────────────────────────────────────────────────────────
//
// The gate above judges exactly one file (src/lib/status.ts). It never walks src/lib/sweep.ts, so
// sweep.ts's own two `readLedgerLines` call sites — bound to a name (`readLedger`) and invoked
// through that alias — are invisible to it for TWO independent reasons: the corpus never contains
// sweep.ts, and even if it did, `LEDGER_READ_INTENT_CALL_RE` requires a literal `readLedgerLines(`
// and cannot match an alias call. W1-T2393 does not widen the corpus or the regex (that is a
// separate, more expensive task — see this task's own rationale, Q3): it only adds the same
// declaring comment sweep.ts's peers already carry, by hand, at the two sites the regex can't
// reach, and pins here that doing so touched nothing else.

test("PROPERTY sweep.ts's two value-bound readLedger call sites declare the live intent, not union", () => {
  const text = readFileSync(join(REPO_ROOT, "src/lib/sweep.ts"), "utf8");
  const lines = text.split("\n");
  const bindingLine = "  const readLedger = deps.readLedger ?? readLedgerLines;";
  const bindingLineIndexes = lines
    .map((line, i) => (line === bindingLine ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(
    bindingLineIndexes.length,
    2,
    "sweep.ts must still bind readLedgerLines through the alias at exactly its two known sites " +
      "(runSweep and runPostFixReverification) — a different count means this pin is stale",
  );
  for (const i of bindingLineIndexes) {
    const declared = lines[i - 1].match(/ledger-read-intent:\s*(live|union)\b/);
    assert.ok(declared, `line ${i + 1}'s alias binding must declare an intent on the line directly above it`);
    assert.equal(
      declared[1],
      "live",
      "both folds read the live file only, never rotations — 'union' would misdeclare what they do " +
        "(this task's Q2: the marker is documentary, so an honest value here still costs nothing)",
    );
  }
});

test("PROPERTY the gate's regex is unchanged — it still cannot see a value-bound alias call", () => {
  // Same shape as sweep.ts's real call sites: bind the reader to a name, call the alias. If this
  // now reported a violation, the regex would have been widened by this task — it was not.
  const source = [
    "export function fold(path, ledgerFs) {",
    "  const readLedger = readLedgerLines;",
    "  return readLedger(path, ledgerFs);",
    "}",
    "",
  ].join("\n");
  const violations = ledgerReadIntentViolations([{ path: "src/lib/fixture-alias.ts", text: source }]);
  assert.deepEqual(
    violations,
    [],
    "widening the regex to catch value bindings is the expensive lever this task's Q3 measured and " +
      "declined — not something to slip in here",
  );
  // The definition line and a bare declared call must still behave exactly as before, too — the
  // regex's existing, narrower behaviour is untouched in both directions.
  const stillCaughtBare = ledgerReadIntentViolations([
    { path: "src/lib/fixture-still-bare.ts", text: "export function g(p) {\n  return readLedgerLines(p);\n}\n" },
  ]);
  assert.equal(stillCaughtBare.length, 1, "a bare undeclared call must still be caught exactly as before");
});

test("PROPERTY the enforced corpus is unchanged — this test file still feeds exactly src/lib/status.ts from disk", () => {
  const selfText = readFileSync(join(REPO_ROOT, "test/ledger-read-intent.test.ts"), "utf8");
  const diskReads = [...selfText.matchAll(/execFileSync\(\s*"git",\s*\[\s*"ls-files",\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    diskReads,
    ["src/lib/status.ts"],
    "widening the enforced corpus to more of src/ is a separate task with its own budget (this " +
      "task's rationale) — this shard must not quietly start enforcing sweep.ts or anything else",
  );
});

test("PROPERTY sweep.ts's new markers are documentation only — nothing paces, throttles, sleeps or delays", () => {
  const text = readFileSync(join(REPO_ROOT, "src/lib/sweep.ts"), "utf8");
  const lines = text.split("\n");
  const markerLines = lines
    .map((line, i) => (line.includes("ledger-read-intent: live") && line.includes("this fold reads") ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(markerLines.length, 2, "exactly two documentary marker lines were added by this task");
  for (const markerLine of markerLines) {
    let start = markerLine;
    while (lines[start - 1]?.trim().startsWith("//")) start--;
    const end = markerLine;
    const block = lines.slice(start, end + 1).join("\n");
    assert.doesNotMatch(
      block,
      /\b(setTimeout|setInterval|sleep|throttle|debounce|delay|await\s+new\s+Promise)\b/i,
      "a declaring comment must never carry a pacing primitive — this task adds documentation, not behaviour",
    );
    // Immediately after the comment block, the pre-existing alias binding must be untouched — no
    // call was inserted between the new marker and the line it documents.
    assert.equal(
      lines[end + 1],
      "  const readLedger = deps.readLedger ?? readLedgerLines;",
      "the marker must sit directly above the unchanged alias binding, nothing inserted between them",
    );
  }
});
