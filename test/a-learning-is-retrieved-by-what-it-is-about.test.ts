/**
 * test/a-learning-is-retrieved-by-what-it-is-about.test.ts — W1-T4093.
 *
 * Learnings were retrieved by `files:` glob ALONE: no shipped entry declared `symbols:` or
 * `error_signatures:`, even though `selectLearnings` already ranks a symbol/error hit above a bare
 * file match. A glob cannot separate "this fact is about the function the task actually touched"
 * from "this fact merely lives in the same 44,636-line file" — src/run-task.ts alone is globbed by
 * 28 entries. This file covers both halves of the fix:
 *
 *  (1) src/lib/knowledge-symbols.ts derives a fact's symbols from its own text, checked against
 *      which identifiers really exist in the source tree (the same discipline `assertion:` gets) —
 *      so a renamed/removed symbol silently drops out rather than going on matching forever.
 *  (2) src/lib/learnings.ts's `selectLearnings` FILLS BY STRENGTH: once a strong (symbol/error)
 *      match is found, a much weaker file-only match on the same glob no longer rides along just
 *      because the char budget has room — the budget stays a backstop, not the only cut.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { collectSourceSymbols, deriveFactSymbols, extractIdentifierCandidates } from "../src/lib/knowledge-symbols.js";
import { selectLearnings, type LearningEntry } from "../src/lib/learnings.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "learnings-derive-symbols.mjs");

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: "base",
    subsystem: "test",
    lifecycle: "active",
    files: ["src/run-task.ts"],
    fact: "base fact",
    src: "test",
    ...overrides,
  };
}

function runScript(args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ── (i) DERIVATION: a fact's symbols come from the code it names, checked against the tree ─────

test("W1-T4093: a fact's symbols are derived from the code it names", () => {
  const known = new Set(["dispatchFixRung", "buildFixRungDispatchArgs"]);
  const symbols = deriveFactSymbols(
    "dispatchFixRung calls buildFixRungDispatchArgs to rebuild the ledger view before retrying.",
    known,
  );
  assert.deepEqual(symbols, ["buildFixRungDispatchArgs", "dispatchFixRung"]);
  // Plain prose is never mistaken for code: "rebuild"/"ledger"/"retrying" name nothing in the tree,
  // and none of them is even camelCase/PascalCase/snake_case-shaped in the first place.
  assert.deepEqual(
    extractIdentifierCandidates("rebuild the ledger view before retrying"),
    [],
    "ordinary lowercase prose is never identifier-shaped",
  );
});

test("W1-T4093: a symbol that no longer exists is dropped", () => {
  // buildFixRungDispatchArgs was renamed away (or never existed); the tree only recognizes
  // dispatchFixRung now.
  const known = new Set(["dispatchFixRung"]);
  const symbols = deriveFactSymbols(
    "dispatchFixRung calls buildFixRungDispatchArgs to rebuild the ledger view before retrying.",
    known,
  );
  assert.deepEqual(symbols, ["dispatchFixRung"]);
  assert.ok(!symbols.includes("buildFixRungDispatchArgs"), "a renamed/removed symbol is never carried forward");
});

test("W1-T4093: collectSourceSymbols reads real declarations from a source tree, ignoring build output", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}knowledge-symbols-`));
  mkdirSync(join(root, "lib"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(
    join(root, "lib", "thing.ts"),
    "export function parseWidget(x: string) { return x; }\nexport const WIDGET_LIMIT = 4;\nclass WidgetStore {}\n",
  );
  writeFileSync(join(root, "node_modules", "dep", "ignored.ts"), "export function shouldNeverBeSeen() {}\n");
  const symbols = collectSourceSymbols(root);
  assert.ok(symbols.has("parseWidget"));
  assert.ok(symbols.has("WIDGET_LIMIT"));
  assert.ok(symbols.has("WidgetStore"));
  assert.ok(!symbols.has("shouldNeverBeSeen"), "node_modules is never scanned");
});

test("W1-T4093: collectSourceSymbols against a missing root is a non-fatal empty set", () => {
  const missing = join(tmpdir(), `${RMD_TMP_PREFIX}does-not-exist-src-${Date.now()}`);
  assert.deepEqual([...collectSourceSymbols(missing)], []);
});

// ── (ii) A TASK TOUCHING ONE FUNCTION MATCHES ONLY FACTS ABOUT THAT FUNCTION ─────────────────────

test("W1-T4093: a task touching one function of a large file matches only facts about that function", () => {
  const knownSymbols = new Set(["dispatchFixRung", "buildFixRungDispatchArgs", "mountRecon"]);
  const dispatchFact = entry({
    id: "dispatch-fact",
    files: ["src/run-task.ts"],
    fact: "dispatchFixRung calls buildFixRungDispatchArgs to rebuild the ledger view before retrying.",
  });
  const mountFact = entry({
    id: "mount-fact",
    files: ["src/run-task.ts"], // the SAME 44k-line file -- a bare glob cannot tell these apart
    fact: "mountRecon spawns the read-only recon worker before anything else runs.",
  });

  // Falsifier (the plan's own falsifier line): matching on file globs alone selects BOTH facts,
  // because both share the run-task.ts glob and nothing else distinguishes them.
  const globOnly = selectLearnings([dispatchFact, mountFact], ["src/run-task.ts"], 1_000_000);
  assert.deepEqual(
    globOnly.selected.map((e) => e.id).sort(),
    ["dispatch-fact", "mount-fact"],
    "file-glob-only matching cannot distinguish which function was actually touched",
  );

  // With derived symbols and a task that names the touched function, only that fact survives.
  const { selected, dropped } = selectLearnings([dispatchFact, mountFact], ["src/run-task.ts"], 1_000_000, {
    text: "the task changes dispatchFixRung and its buildFixRungDispatchArgs helper.",
    knownSymbols,
  });
  assert.deepEqual(selected.map((e) => e.id), ["dispatch-fact"]);
  assert.deepEqual(dropped.map((e) => e.id), ["mount-fact"]);
});

// ── (iii) FILL BY STRENGTH: a weak glob-only match no longer crowds out a strong one ─────────────

test("W1-T4093: weak matches stop filling the budget", () => {
  const strong = entry({
    id: "strong",
    files: ["src/run-task.ts"],
    symbols: ["dispatchFixRung", "buildFixRungDispatchArgs"],
    fact: "a short strong fact.",
  });
  const weak = entry({
    id: "weak",
    files: ["src/run-task.ts"], // shares the same glob, names neither touched symbol
    fact: "a short weak fact that only shares the file path.",
  });
  const hugeBudget = 1_000_000;
  const { selected, dropped } = selectLearnings([strong, weak], ["src/run-task.ts"], hugeBudget, {
    text: "dispatchFixRung and buildFixRungDispatchArgs both changed in this run.",
  });
  assert.deepEqual(selected.map((e) => e.id), ["strong"]);
  assert.deepEqual(dropped.map((e) => e.id), ["weak"]);
  // Prove the drop was STRENGTH, not the char budget: both facts together cost a tiny fraction of
  // the cap, so nothing here could have run out of room.
  const totalChars = [strong, weak].reduce((s, e) => s + e.fact.length, 0);
  assert.ok(totalChars < hugeBudget / 100, `budget was not the constraint (used only ${totalChars} of ${hugeBudget})`);
});

test("W1-T4093: a lone weak match is still selected — never starve to zero", () => {
  const onlyWeak = entry({ id: "solo", files: ["src/run-task.ts"], fact: "the only candidate, however weak." });
  const { selected, dropped } = selectLearnings([onlyWeak], ["src/run-task.ts"], 1_000_000);
  assert.deepEqual(selected.map((e) => e.id), ["solo"]);
  assert.deepEqual(dropped, []);
});

// ── selection derives symbols from the fact text (grep proof target, exercised here too) ────────

test("W1-T4093: selectLearnings derives symbols from an entry's fact text via knownSymbols, with no declared symbols: at all", () => {
  const knownSymbols = ["dispatchFixRung"];
  const withUndeclaredSymbol = entry({
    id: "undeclared",
    files: ["src/lib/other.ts"],
    fact: "dispatchFixRung is the only place a fix rung is ever dispatched from.",
  });
  const { selected, matchedBy } = selectLearnings([withUndeclaredSymbol], [], 1_000_000, {
    text: "the run's dispatchFixRung call failed",
    knownSymbols,
  });
  assert.deepEqual(selected.map((e) => e.id), ["undeclared"]);
  assert.equal(matchedBy.symbol, 1, "the symbol hit came from derivation, since the entry declared none");
});

// ── scripts/learnings-derive-symbols.mjs: the script that writes derived symbols: (design (i)) ──

test("learnings-derive-symbols derives symbols additively, drops a stale one, and leaves a hand-added acronym alone", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}derive-symbols-shard-`));
  const srcDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}derive-symbols-src-`));
  writeFileSync(join(srcDir, "thing.ts"), "export function renderWidget(x: string) { return x; }\n");
  writeFileSync(
    join(dir, "shard.yaml"),
    [
      "- id: renamed-fn",
      "  subsystem: test",
      "  lifecycle: active",
      "  files: [src/thing.ts]",
      "  symbols: [parseWidget]", // parseWidget no longer exists in srcDir -- stale, derivable-shaped
      "  fact: >-",
      "    Call parseWidget before renderWidget touches the DOM.",
      "  src: test",
      "- id: acronym",
      "  subsystem: test",
      "  lifecycle: active",
      "  files: []",
      "  symbols: [TAP]", // not code-shaped -- never a derivation candidate, never removed
      "  fact: >-",
      "    TAP output interleaves across concurrent runners.",
      "  src: test",
      "",
    ].join("\n"),
  );

  const before = runScript(["--dir", dir, "--src", srcDir, "--check"]);
  assert.notEqual(before.status, 0, before.out);
  assert.match(before.out, /STALE/);

  const applied = runScript(["--dir", dir, "--src", srcDir]);
  assert.equal(applied.status, 0, applied.out);

  const after = readFileSync(join(dir, "shard.yaml"), "utf8");
  assert.match(after, /symbols: \[renderWidget\]/, "parseWidget dropped, renderWidget derived from the fact");
  assert.doesNotMatch(
    after,
    /symbols: \[[^\]]*parseWidget/,
    "a symbol the tree no longer recognizes is never carried forward in a symbols: list",
  );
  assert.match(after, /symbols: \[TAP\]/, "a hand-added, non-code-shaped symbol is left untouched");

  const check = runScript(["--dir", dir, "--src", srcDir, "--check"]);
  assert.equal(check.status, 0, check.out);
  assert.match(check.out, /OK/);
});
