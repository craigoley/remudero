/**
 * W1-T11423 — no long-lived code materialises the whole ledger union.
 *
 * OBSERVED 2026-11-05: dep-review's proposalProgress called `readLedgerUnionRecordsSync(dir, { refuseIncomplete:
 * true }).rows` — every row of ~394 archives — to filter a dozen by task_id, and core hit its heap limit every
 * ~25 min. It was the third keyed question answered by a whole-ledger scan in two days, and the class had
 * aborted core twice before (09-10, 09-23). A keyed question asks `ledgerRowsFor`; every other union read must
 * carry a bound the union honours, or a written reason on the allowlist below. W1-T11424 empties it.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const READERS = ["readLedgerUnionRecordsSync", "readLedgerUnionRecords", "readLedgerUnionRawLinesSync", "readLedgerUnionRawLinesAsync",
  "readLedgerUnionRawLines", "openLedgerUnion", "readLedgerCorpus"];
/** Options the union honours that bound what a read opens or keeps. */
const BOUNDS = ["step", "pattern", "keep", "since", "sinceTs", "maxRotations", "rotationWindowMs", "afterRotation", "throughRotation",
  "rotationRecords", "where", "selectRotation"];
/** The union's own module defines these readers and `ledgerRowsFor`; it is not a caller. */
const DEFINING = new Set(["src/lib/ledger-union.ts", "src/lib/ledger-key-manifest.ts"]);

/** file#function → why the read is unbounded today. Every entry is W1-T11424's to remove. */
const ALLOWLIST: Record<string, string> = {
  "src/lib/analytics-route.ts#deriveAnalyticsSnapshotFromLedger": "whole-history analytics snapshot, no key; W1-T11424 gives it a per-archive digest",
  "src/lib/benchmark-cohort.ts#observeTimestamp": "benchmark-cohort streams one source at a time through caller-built options; W1-T11424",
  "src/lib/field-trials-flow.ts#readFieldTrialsLedger": "field-trials ledger stream, whole history; W1-T11424",
  "src/lib/field-trials-flow.ts#readControlledLedgerRows": "field-trials materialises every row with no filter; W1-T11424 moves it to ledgerRowsFor",
  "src/lib/human-gate.ts#measureFeedbackAge": "live-file-only read: its fsDeps list no archives, so it never opens a rotation; W1-T11424 states that bound",
  "src/lib/impossible-canary.ts#model": "impossible-canary CLI materialises every row with no filter; W1-T11424",
  "src/lib/pr-owner-ledger.ts#readPrOwnerLedgerProjection": "pr-owner projection streams whole history, no key; W1-T11424",
  "src/lib/pr-state.ts#<module>": "pr-state's injectable reader passes its caller's options through; W1-T11424",
  "src/lib/retro.ts#opts": "retro streams whole history (sinceTs only when given) and bounds its own retained window; W1-T11424",
  "src/lib/routing-experiments.ts#routingAbCommand": "routing-experiments CLI materialises every row with no filter; W1-T11424",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|mjs|js)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Comment lines and block comments blanked (line count kept), so a doc mention is never a call. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n").map((line) => (/^\s*\/\//.test(line) ? "" : line)).join("\n");
}

/** The argument text of the call whose "(" is at `open`, skipping string literals. */
function argumentsAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "\"" || c === "'" || c === "`") {
      for (i += 1; i < text.length && text[i] !== c; i += 1) if (text[i] === "\\") i += 1;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

const FUNCTION = /(?:function\s*\*?\s*([A-Za-z0-9_$]+)\s*[<(]|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*(?::[^=]*)?=>|^\s*(?:(?:public|private|static|async|readonly)\s+)*([A-Za-z0-9_$]+)\s*(?:\([^)]*\)|:)\s*(?::[^{;]*)?(?:=>|\{))/gm;

function enclosingFunction(text: string, at: number): string {
  let name = "<module>";
  for (const match of text.slice(0, at).matchAll(FUNCTION)) {
    const found = match[1] ?? match[2] ?? match[3];
    if (found && !["if", "for", "while", "switch", "catch", "return"].includes(found)) name = found;
  }
  return name;
}

export interface UnionCall { site: string; file: string; fn: string; bounded: boolean }

export function censusUnionCalls(files: Array<{ file: string; text: string }>): UnionCall[] {
  const calls: UnionCall[] = [];
  const name = new RegExp(`\\b(${READERS.join("|")})\\s*\\(`, "g");
  const bound = new RegExp(`(?:^|[{,\\s(])(?:${BOUNDS.join("|")})\\s*(?::|,|\\}|\\?)`);
  for (const { file, text: raw } of files) {
    if (DEFINING.has(file)) continue;
    const text = stripComments(raw);
    for (const match of text.matchAll(name)) {
      const before = text.slice(Math.max(0, match.index! - 40), match.index!);
      if (/(?:function\s*\*?\s*|import\s*\{[^}]*|type\s+\w+\s*=\s*)$/.test(before) || /\bfunction\s*$/.test(before)) continue;
      const open = match.index! + match[0].length - 1;
      const args = argumentsAt(text, open);
      const line = text.slice(0, match.index!).split("\n").length;
      calls.push({ site: `${file}:${line}`, file, fn: enclosingFunction(text, match.index!), bounded: bound.test(args) });
    }
  }
  return calls;
}

function repoFiles(): Array<{ file: string; text: string }> {
  return sourceFiles(join(REPO_ROOT, "src")).map((path) => ({ file: relative(REPO_ROOT, path), text: readFileSync(path, "utf8") }));
}

test("W1-T11423 criterion 3: every non-test union read carries a bound or a written allowlist reason", { timeout: 120_000 }, () => {
  const calls = censusUnionCalls(repoFiles());
  const bounded = calls.filter((c) => c.bounded).length;
  // Population floor: the walk must find real calls of BOTH kinds, so an empty or mis-matching walk cannot pass.
  assert.ok(bounded > Object.keys(ALLOWLIST).length, `census saw ${calls.length} calls, ${bounded} bounded — the walk found too few to judge`);
  const offenders = calls.filter((c) => !c.bounded && !ALLOWLIST[`${c.file}#${c.fn}`]);
  assert.deepEqual(offenders.map((c) => `${c.site} (${c.fn})`), [],
    "an unbounded union read materialises or decompresses the whole ledger: ask ledgerRowsFor, pass a bound, or add a reasoned allowlist entry");
  const used = new Set(calls.filter((c) => !c.bounded).map((c) => `${c.file}#${c.fn}`));
  const stale = Object.keys(ALLOWLIST).filter((key) => !used.has(key));
  assert.deepEqual(stale, [], "an allowlist entry no unbounded call needs any more must be removed");
});

test("W1-T11423 criterion 3: a planted unbounded union read reddens the census, and a bounded one does not", () => {
  const planted = [{ file: "src/lib/planted.ts", text: [
    "export function leak(dir: string) {",
    "  return readLedgerUnionRecordsSync(dir, { refuseIncomplete: true }).rows;",
    "}",
    "export async function keyed(dir: string) {",
    "  return readLedgerUnionRecords(dir, { since: \"2026-11-05T00:00:00Z\", step: [\"x\"] });",
    "}",
    "// readLedgerUnionRecordsSync(dir, {}) in a comment is not a call",
  ].join("\n") }];
  const calls = censusUnionCalls(planted);
  assert.deepEqual(calls.map((c) => [c.fn, c.bounded]), [["leak", false], ["keyed", true]]);
});
