/**
 * test/the-selector-learns-from-its-misses.test.ts — W1-T4462.
 *
 * The W1-T4404 shadow selector's first day of records (159 shadow records over 40 PR runs)
 * found ONE real regression it missed and TWO flakes it counted as misses:
 *
 *   - clock-signature-census on #6967: sre-lane.ts added a `new Date(` call; the census
 *     (test/clock-signature-census.test.ts) imports scripts/clock-signature-ratchet.mjs, whose
 *     OWN `readdirSync`-based walk of src/ is what `censusSuiteFiles` cannot see — the test file's
 *     own text names no enumeration idiom and no `src/` literal.
 *   - two flakes (cold-status-reads timing, boot-fetch ref-lock) that CI's `select-affected-
 *     suites.mjs` invocation never fed `--recent-failures`, so a currently-unstable suite read as
 *     a plain miss instead of a rescued flake.
 *
 * Each is taught here, plus the design's third guard: a brand-new src/ file reaches no symbol
 * callers (nothing imports it yet), so the census/path-reading arm — not the import graph or
 * symbol reach — must be what keeps it from going unmodelled.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { selectAffectedSuites, shadowRecord, type AffectedSuitesInput } from "../src/lib/affected-suites.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// `scripts/**` sits outside tsconfig's `include` (a plain `import` is a TS7016), so this runtime
// import — the same route test/a-census-suite-is-unreachable-from-the-symbols-a-diff-changes.test.ts
// and test/fast-lane-classifier.test.ts take to the same file, leaving no shadow copy to drift.
const { censusSuiteFiles } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "diff-class.mjs")).href)) as {
  censusSuiteFiles: (changed: readonly string[] | undefined, root?: string) => string[];
};

// ── (i) a census that imports its walker script ────────────────────────────────────────────────

test("W1-T4462: a census that imports its walker is selected", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4462-walker-`));
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });

    // The walker: it — not the test file — carries the enumeration idiom and the (bare, no
    // trailing slash) directory name, exactly like scripts/clock-signature-ratchet.mjs's own
    // `readdirSync(join(root, "src"))`.
    writeFileSync(
      join(root, "scripts", "walker.mjs"),
      'import { readdirSync } from "node:fs";\nimport { join } from "node:path";\n' +
        'export function walk(root) {\n  return readdirSync(join(root, "src"), { recursive: true });\n}\n',
    );

    // The census: it names NO enumeration idiom and NO src/ literal of its own — it only imports
    // the walker and calls it. Reading this file's own text alone cannot find the population walk.
    writeFileSync(
      join(root, "test", "imports-its-walker.test.ts"),
      'import { walk } from "../scripts/walker.mjs";\nimport { test } from "node:test";\n' +
        'test("census", () => walk(process.cwd()));\n',
    );

    // CONTROL: an ordinary suite beside it, reachable by neither arm, must not be swept in too.
    writeFileSync(join(root, "test", "ordinary.test.ts"), 'import { thing } from "../src/lib/thing.js";\n');

    const listed = censusSuiteFiles(["src/lib/thing.ts"], root);
    assert.ok(
      listed.includes("test/imports-its-walker.test.ts"),
      "a suite that imports a population-walking scripts/ module is a census suite too",
    );
    assert.ok(!listed.includes("test/ordinary.test.ts"), "control: a suite reachable by neither arm stays out");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4462: the REAL #6967 regression — a src/ change reaches clock-signature-census through its imported walker", () => {
  // Replayed on the real tree, matching test/a-census-suite-is-unreachable-from-the-symbols-a-
  // diff-changes.test.ts's own convention: a synthetic changed-file set is not evidence that the
  // real regression is fixed, only that the mechanism generalizes.
  const listed = censusSuiteFiles(["src/lib/sre-lane.ts"], REPO_ROOT);
  assert.ok(
    listed.includes("test/clock-signature-census.test.ts"),
    "test/clock-signature-census.test.ts imports scripts/clock-signature-ratchet.mjs, whose walk this arm must now see",
  );
});

// ── (ii) a new source file reaches no symbol callers ───────────────────────────────────────────

test("W1-T4462: a new source file selects the suites that walk src", () => {
  const files = new Map<string, string>([
    ["src/lib/totally-new-thing.ts", "export const thing = 1;\n"],
    [
      "test/walks-src.test.ts",
      'import { readdirSync } from "node:fs";\nreaddirSync(join(ROOT, "src/lib/"));\n',
    ],
    ["test/unrelated.test.ts", "export {};\n"],
  ]);
  const changed = ["src/lib/totally-new-thing.ts"];
  const input: AffectedSuitesInput = {
    files,
    // What diff-class's censusSuiteFiles would return for this change: the suite that walks
    // src/lib/ unfiltered, found by content alone — no symbol or import graph involved.
    pathReaders: ["test/walks-src.test.ts"],
    // W1-T4462: a brand-new file has no existing caller — the symbol-reach arm (ci-parity's
    // callerReachableSuites) genuinely finds nothing for it. Supplied as EMPTY, not omitted, so
    // `narrow` is computed and this arm is actually exercised, not skipped.
    symbolSuites: [],
  };
  const sel = selectAffectedSuites(changed, input);
  assert.ok(
    sel.suites.includes("test/walks-src.test.ts"),
    "floor: the census suite that walks src/ unfiltered is selected even though nothing imports the new file yet",
  );
  assert.ok(!sel.suites.includes("test/unrelated.test.ts"), "control: an unrelated suite stays out");
  assert.deepEqual(
    sel.narrow,
    ["test/walks-src.test.ts"],
    "narrow: symbolSuites is empty (no caller found for the new file) yet the census arm still selects it",
  );
});

// ── (iii)/(iv) a flake is not a miss ────────────────────────────────────────────────────────────

test("W1-T4462: a flake is labelled apart from a real miss", () => {
  const files = new Map<string, string>([
    ["src/lib/x.ts", "export const x = 1;\n"],
    ["test/reaches-x.test.ts", 'import { x } from "../src/lib/x.js";\n'],
    // Reaches nothing structurally, but --recent-failures (W1-T4462's ci.yml wiring, built from
    // the flake-retry evidence the job already writes) names it as currently unstable.
    ["test/unstable.test.ts", "export {};\n"],
    ["test/truly-unreached.test.ts", "export {};\n"],
  ]);
  const changed = ["src/lib/x.ts"];
  const input: AffectedSuitesInput = {
    files,
    pathReaders: [],
    recentFailures: ["test/unstable.test.ts"],
    symbolSuites: ["test/reaches-x.test.ts"],
  };
  const sel = selectAffectedSuites(changed, input);
  const record = shadowRecord(sel, ["test/reaches-x.test.ts", "test/unstable.test.ts", "test/truly-unreached.test.ts"]);
  assert.deepEqual(record.failures, [
    { file: "test/reaches-x.test.ts", floor: "selected", narrow: "selected" },
    { file: "test/truly-unreached.test.ts", floor: "missed", narrow: "missed" },
    { file: "test/unstable.test.ts", floor: "flake", narrow: "flake" },
  ]);
});
