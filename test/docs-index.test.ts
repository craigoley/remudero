import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/generate-docs-index.mjs"` is a TS7016 — the same reason
// test/clock-sweep.test.ts and test/credit-surface-gate.test.ts reach their scripts through a
// runtime import rather than a typed one. A dynamic specifier is not statically resolved, so this
// loads the REAL module with no shadow copy to drift from it.
const GENERATOR_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "generate-docs-index.mjs"),
).href;

const {
  buildDocsIndex,
  extractMermaidPathCitations,
  findUnresolvedMermaidCitations,
  findUnresolvedPathsInText,
  main,
  parseDocEntry,
  serializeDocsIndex,
} = (await import(GENERATOR_URL)) as {
  buildDocsIndex: (dir: string, outPath: string) => Array<{ path: string; title: string; summary: string; grepHint: string }>;
  extractMermaidPathCitations: (text: string) => string[];
  findUnresolvedMermaidCitations: (dir: string, repoRoot: string) => Array<{ doc: string; path: string }>;
  findUnresolvedPathsInText: (text: string, repoRoot: string) => string[];
  main: (argv: string[]) => void;
  parseDocEntry: (text: string) => { title: string | null; summary: string };
  serializeDocsIndex: (entries: unknown[], dirLabel: string) => string;
};

// ── W1-T2282: the docs INDEX generator (MASTER-PLAN §8A) ────────────────────────────────────────
//
// docs/ was the one knowledge corpus that never got this repo's own RETRIEVED-not-INJECTED
// treatment: MASTER-PLAN.md has plan/plan-index.json + `plan-index:check` (W1-T37, W1-T37-shaped
// suite: test/plan-index.test.ts), learnings/ has learnings/index.json + a ratchet + per-task
// matching (W1-T33, test/learnings-index.test.ts). This suite proves docs/docs-index.json is the
// same discipline applied to docs/: a FRESH index (matches a regeneration byte-for-byte) turns
// `--check` green; a STALE one (or one missing an entry) turns it RED and names the file to
// regenerate; every real markdown file under docs/ -- INCLUDING one with no incoming citation from
// outside docs/ -- appears in it; the index never carries an entry for itself; and a doc citing an
// unresolved repo-relative path inside a fenced ```mermaid block is refused by name.
//
// This suite does NOT duplicate test/docs-claims.test.ts's five hand-enumerated content claims
// (README's WS-0 wording, CONTRIBUTING's ci-gate naming, the operator guide's --repo/verb
// coverage, docs/ci-gate.md's absence, CLAUDE.md's literal/regex asymmetry) -- see the dedicated
// non-duplication test below, which proves this generator is INDIFFERENT to that wording: it only
// asserts structural properties (index completeness, self-exclusion, mermaid-path resolution).
//
// (scripts/generate-docs-index.mjs is a plain .mjs file outside tsconfig's `include`; its pure
// functions are exercised here directly via ESM import -- mirroring how test/plan-index.test.ts
// exercises src/lib/plan-index.ts -- plus its CLI surface via `spawnSync`, mirroring
// test/plan-index.test.ts's convention for the CLI half of scripts/generate-plan-index.mjs.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-docs-index.mjs");

function runGenerate(dir: string, out: string) {
  return spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--out", out], { cwd: REPO_ROOT, encoding: "utf8" });
}

function runCheck(dir: string, out: string) {
  return spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--out", out, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
}

function runCheckPaths(dir: string) {
  return spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--check-paths"], { cwd: REPO_ROOT, encoding: "utf8" });
}

// ── Acceptance: every file under docs is present, with a path, a title, a one-line summary ──────

test("buildDocsIndex: every markdown file under a fixture docs/ dir gets a path, a title and a one-line summary", () => {
  const tmp = mkdtempSync(join(tmpdir(), "docs-index-complete-"));
  try {
    mkdirSync(join(tmp, "sub"));
    writeFileSync(join(tmp, "a.md"), "# Doc A\n\nSummary of doc A.\n");
    writeFileSync(join(tmp, "sub", "b.md"), "# Doc B\n\nSummary of doc B.\n");
    const entries = buildDocsIndex(tmp, join(tmp, "docs-index.json"));
    assert.deepEqual(
      entries.map((e: { path: string }) => e.path),
      [`${tmp}/a.md`, `${tmp}/sub/b.md`],
    );
    for (const e of entries) {
      assert.ok(e.path, "entry missing path");
      assert.ok(e.title, "entry missing title");
      assert.equal(typeof e.summary, "string", "entry missing summary");
    }
    assert.equal(entries[0].title, "Doc A");
    assert.equal(entries[0].summary, "Summary of doc A.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseDocEntry: a doc with NO '# ' heading falls back to a null title (caller substitutes the filename)", () => {
  const { title, summary } = parseDocEntry("Just prose, no heading.\n");
  assert.equal(title, null);
  assert.equal(summary, "Just prose, no heading.");
});

test("parseDocEntry: a heading immediately followed by another heading (no body prose) gets an empty summary, never crashes", () => {
  const { title, summary } = parseDocEntry("# Title\n\n## Next\n\nProse under next.\n");
  assert.equal(title, "Title");
  assert.equal(summary, "");
});

// ── Acceptance: a committed index that does not match a fresh regeneration fails the check ──────

test("generate-docs-index (no --check) writes an index that a subsequent --check accepts", () => {
  const tmp = mkdtempSync(join(tmpdir(), "docs-index-roundtrip-"));
  try {
    writeFileSync(join(tmp, "one.md"), "# One\n\nProse one.\n");
    const out = join(tmp, "docs-index.json");
    const genResult = runGenerate(tmp, out);
    assert.equal(genResult.status, 0, genResult.stdout + genResult.stderr);
    const checkResult = runCheck(tmp, out);
    assert.equal(checkResult.status, 0, checkResult.stdout + checkResult.stderr);
    assert.match(checkResult.stdout + checkResult.stderr, /OK -- .*docs-index\.json matches/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate-docs-index --check: a STALE index (corpus changed since generation) -> non-zero exit, NAMES the file to regenerate", () => {
  const tmp = mkdtempSync(join(tmpdir(), "docs-index-stale-"));
  try {
    const out = join(tmp, "docs-index.json");
    writeFileSync(join(tmp, "one.md"), "# One\n\nOriginal prose.\n");
    assert.equal(runGenerate(tmp, out).status, 0);

    writeFileSync(join(tmp, "one.md"), "# One\n\nEDITED prose that no longer matches.\n");
    const result = runCheck(tmp, out);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /is STALE/);
    assert.match(output, /docs-index\.json/);
    assert.match(output, /npm run docs-index/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate-docs-index --check: a MISSING committed index -> non-zero exit, tells the operator how to generate it", () => {
  const tmp = mkdtempSync(join(tmpdir(), "docs-index-missing-"));
  try {
    writeFileSync(join(tmp, "one.md"), "# One\n\nProse.\n");
    const result = runCheck(tmp, join(tmp, "does-not-exist.json"));
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /does not exist/);
    assert.match(output, /npm run docs-index/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Acceptance falsifier: removing an entry from the committed index turns the check RED ────────

test("falsifier: a committed index with one entry REMOVED (vs. a two-doc corpus) turns --check RED, not quietly green", () => {
  const tmp = mkdtempSync(join(tmpdir(), "docs-index-falsifier-"));
  try {
    writeFileSync(join(tmp, "one.md"), "# One\n\nProse one.\n");
    writeFileSync(join(tmp, "two.md"), "# Two\n\nProse two.\n");
    const out = join(tmp, "docs-index.json");
    assert.equal(runGenerate(tmp, out).status, 0);

    // Simulate someone hand-editing the committed index to drop "two.md"'s entry.
    const full = JSON.parse(readFileSync(out, "utf8"));
    const truncated = { ...full, entries: full.entries.filter((e: { path: string }) => !e.path.endsWith("two.md")) };
    writeFileSync(out, JSON.stringify(truncated, null, 2) + "\n");

    const result = runCheck(tmp, out);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /is STALE/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Acceptance: a doc with no incoming citation still appears in the REAL index ──────────────────

test("the REAL docs/docs-index.json carries docs/adr/template.md -- a doc cited by nothing outside docs/", () => {
  const index = JSON.parse(readFileSync(join(REPO_ROOT, "docs", "docs-index.json"), "utf8"));
  const paths = index.entries.map((e: { path: string }) => e.path);
  assert.ok(paths.includes("docs/adr/template.md"), "expected docs/adr/template.md to be indexed despite having no incoming citation");
});

// ── Acceptance: the index excludes itself ────────────────────────────────────────────────────────

test("buildDocsIndex excludes its own --out destination, even if that destination sits under dir with a .md name", () => {
  const tmp = mkdtempSync(join(tmpdir(), "docs-index-self-exclude-"));
  try {
    writeFileSync(join(tmp, "real.md"), "# Real\n\nProse.\n");
    // A contrived out-path that WOULD be picked up by the *.md walk if self-exclusion were missing.
    const selfPath = join(tmp, "docs-index.md");
    const entries = buildDocsIndex(tmp, selfPath);
    assert.deepEqual(
      entries.map((e: { path: string }) => e.path),
      [`${tmp}/real.md`],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the REAL docs/docs-index.json carries no entry for itself", () => {
  const index = JSON.parse(readFileSync(join(REPO_ROOT, "docs", "docs-index.json"), "utf8"));
  const paths = index.entries.map((e: { path: string }) => e.path);
  assert.ok(!paths.includes("docs/docs-index.json"), "the index must not regenerate-on-every-run by naming itself");
});

// ── Acceptance: a doc naming an unresolved repo-relative path is refused, and the path is named ─

test("findUnresolvedPathsInText: a mermaid node citing a path that does not resolve is refused, and the path is named", () => {
  const text = '```mermaid\nflowchart TD\n  N["does the thing (lib/does-not-exist.ts)"]\n```\n';
  const unresolved = findUnresolvedPathsInText(text, REPO_ROOT);
  assert.deepEqual(unresolved, ["lib/does-not-exist.ts"]);
});

test("findUnresolvedPathsInText: a mermaid node citing a REAL repo-relative path resolves cleanly (empty result)", () => {
  const text = '```mermaid\nflowchart TD\n  N["does the thing (package.json)"]\n```\n';
  assert.deepEqual(findUnresolvedPathsInText(text, REPO_ROOT), []);
});

test("extractMermaidPathCitations: a path-shaped token OUTSIDE a mermaid block is never extracted (prose shorthand is out of scope)", () => {
  const text = "Prose mentioning `lib/not-a-real-file.ts` in a backtick span, no mermaid block here.\n";
  assert.deepEqual(extractMermaidPathCitations(text), []);
});

test("generate-docs-index --check-paths: a fixture doc with an unresolved mermaid citation -> non-zero exit, NAMES doc and path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "docs-index-check-paths-bad-"));
  try {
    writeFileSync(
      join(tmp, "diagram.md"),
      '# Diagram\n\n```mermaid\nflowchart TD\n  N["thing (lib/nope.ts)"]\n```\n',
    );
    const result = runCheckPaths(tmp);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /diagram\.md/);
    assert.match(output, /lib\/nope\.ts/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate-docs-index --check-paths: a fixture corpus where every mermaid citation resolves -> zero exit", () => {
  const tmp = mkdtempSync(join(tmpdir(), "docs-index-check-paths-good-"));
  try {
    writeFileSync(
      join(tmp, "diagram.md"),
      '# Diagram\n\n```mermaid\nflowchart TD\n  N["thing (package.json)"]\n```\n',
    );
    const result = runCheckPaths(tmp);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the REAL docs/system-diagrams.md's mermaid citation 'lib/status.ts' does not resolve -- the check's first, tracked, unrepaired finding", () => {
  // Locks in the one live defect this task found (rationale point 2): every OTHER path-like
  // citation in docs/system-diagrams.md's mermaid blocks resolves; this is the sole exception.
  // Repair happens under its own, later change -- this task reports it, and never rewrites the
  // doc (see the "no existing document is rewritten" test below).
  const findings = findUnresolvedMermaidCitations("docs", REPO_ROOT);
  assert.deepEqual(findings, [{ doc: "docs/system-diagrams.md", path: "lib/status.ts" }]);
});

// ── Acceptance: none of docs-claims.test.ts's five claims are duplicated by this check ──────────

test("non-duplication: this generator is indifferent to docs-claims.test.ts's wording claims -- it only checks structure", () => {
  // A fixture doc that carries every one of docs-claims.test.ts's five STALE wordings (the WS-0
  // spike claim, a bare `ci` required-check mention, no --repo flag, no LITERAL/BASIC REGEX
  // asymmetry, and a docs/ci-gate.md-shaped mention) but has NO structural problem: it has a
  // title, a summary, and no unresolved mermaid citation. If this generator duplicated any of
  // those five content claims, this doc would fail one of ITS checks too; it does not.
  const staleWordingDoc =
    "# Some Doc\n\n" +
    "This repo currently contains the **WS-0 spike**, gated by **`ci`** — typecheck only.\n" +
    "No --repo flag here. See docs/ci-gate.md for details.\n\n" +
    "```mermaid\nflowchart TD\n  N[\"cites (package.json)\"]\n```\n";
  const tmp = mkdtempSync(join(tmpdir(), "docs-index-nondupe-"));
  try {
    writeFileSync(join(tmp, "stale-wording.md"), staleWordingDoc);
    const entries = buildDocsIndex(tmp, join(tmp, "docs-index.json"));
    assert.equal(entries.length, 1);
    assert.ok(entries[0].title, "expected a title despite the stale wording");
    assert.equal(findUnresolvedMermaidCitations(tmp, REPO_ROOT).length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Acceptance: no existing document is rewritten; the unresolved path is reported, not fixed ───

test("no existing document is rewritten: reading docs/system-diagrams.md through the checker leaves its content byte-identical", () => {
  const path = join(REPO_ROOT, "docs", "system-diagrams.md");
  const before = readFileSync(path, "utf8");
  findUnresolvedMermaidCitations("docs", REPO_ROOT); // the check itself: read-only by construction
  const after = readFileSync(path, "utf8");
  assert.equal(after, before, "the checker must never write to a doc it inspects");
  assert.ok(before.includes("(lib/status.ts)"), "the unresolved citation is still present, unrepaired -- reported, not silently corrected");
});

// ── serializeDocsIndex: content-only, byte-stable across runs when the corpus hasn't changed ────

test("serializeDocsIndex: identical entries serialize identically (no timestamp -- what makes --check meaningful)", () => {
  const entries = [{ path: "docs/a.md", title: "A", summary: "s", grepHint: "A" }];
  assert.equal(serializeDocsIndex(entries, "docs"), serializeDocsIndex(entries, "docs"));
});

// ── truncate(): a summary longer than SUMMARY_MAX_CHARS is ellipsized, not left verbatim ─────────
//
// Every real doc under docs/ today happens to have a first body line under 160 chars, so this
// branch of truncate() (the ellipsis path, as opposed to the pass-through-unchanged path already
// exercised by every OTHER fixture above) had no covering case -- a fixture doc is the fix, not a
// change to the generator.

test("buildDocsIndex: a summary line over 160 chars is truncated to 160 chars total and ends in an ellipsis", () => {
  const tmp = mkdtempSync(join(tmpdir(), "docs-index-truncate-"));
  try {
    const longLine = "x".repeat(200);
    writeFileSync(join(tmp, "long.md"), `# Long\n\n${longLine}\n`);
    const entries = buildDocsIndex(tmp, join(tmp, "docs-index.json"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].summary.length, 160, entries[0].summary);
    assert.ok(entries[0].summary.endsWith("…"), "a truncated summary must end with the ellipsis marker");
    assert.ok(longLine.startsWith(entries[0].summary.slice(0, -1)), "the kept prefix must be a literal prefix of the original line");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── main()'s own error path, IN-PROCESS ──────────────────────────────────────────────────────────
//
// Every other CLI test above drives the script via `spawnSync` -- a real, independent child
// process with its OWN V8 instance, which `--experimental-test-coverage` never observes: it can
// prove the CLI's stdout/exit code, but it cannot move this file's own coverage record. `main()`
// is exported (see its own comment in scripts/generate-docs-index.mjs) exactly so its outer
// try/catch -- reached only when corpus generation itself throws, e.g. a `--dir` that does not
// exist -- shows up as covered from a call made in THIS process. `process.exitCode`/`console.*`
// are saved and restored around the call, the same `withExitCode` shape
// test/credit-surface-gate.test.ts and test/acceptance-author-gate.test.ts use for their own
// exported `main`, so this test never corrupts its own suite's process.

async function withExitCode(fn: () => void): Promise<{ exitCode: typeof process.exitCode; err: string[] }> {
  const priorExit = process.exitCode;
  const err: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    fn();
    return { exitCode: process.exitCode, err };
  } finally {
    console.error = realErr;
    process.exitCode = priorExit;
  }
}

test("main(): a --dir that does not exist hits the outer catch -- non-zero exit, names the underlying read error", async () => {
  const missingDir = join(tmpdir(), "docs-index-main-catch-does-not-exist");
  rmSync(missingDir, { recursive: true, force: true }); // guarantee absence without depending on ordering
  const { exitCode, err } = await withExitCode(() => main(["--dir", missingDir]));
  assert.equal(exitCode, 1);
  assert.match(err.join("\n"), /generate-docs-index:/);
});

// ── W1-T2323-adjacent: a SUMMARY IS NOT A MAINTENANCE BANNER ────────────────────────────────
//
// `rmd retro` writes `_MAINTAINED BY \`rmd retro\` — regenerated <ISO>._` into docs/ORIENTATION.md
// on every run (src/lib/retro.ts), and the first-prose-line heuristic copied that timestamp into
// the index — so the index went stale on EVERY retro, by construction, and neither retro.ts nor
// run-task.ts references docs-index at all. The operator's ruling was to stop the index
// summarising a volatile line rather than to add a freshness guard: fixing the INPUT makes a guard
// safe afterwards, while adding the guard first moves the breakage onto a lane that did not cause
// it. These pin the input fix, in both directions.

test("parseDocEntry: a leading wholly-emphasised CALLOUT is skipped, and the next prose line is the summary", () => {
  const { summary, title } = parseDocEntry(
    ["# ORIENTATION", "", "_MAINTAINED BY `rmd retro` — regenerated 2026-08-26T13:38:19.806Z._", "", "What this doc is about."].join("\n"),
  );
  assert.equal(title, "ORIENTATION");
  assert.equal(summary, "What this doc is about.", "the banner is machinery, not this doc's first sentence");
});

test("parseDocEntry: a retro rewriting the callout's timestamp does NOT change the entry — the whole point", () => {
  const doc = (stamp: string) =>
    ["# ORIENTATION", "", `_MAINTAINED BY \`rmd retro\` — regenerated ${stamp}._`, "", "A fresh Architect session should orient from THIS doc."].join("\n");
  const a = parseDocEntry(doc("2026-08-26T13:38:19.806Z"));
  const b = parseDocEntry(doc("2099-01-02T03:04:05.678Z"));
  assert.deepEqual(a, b, "two retros a lifetime apart must produce the same index entry");
});

test("parseDocEntry FALSIFIER: without the skip, the timestamp WOULD land in the summary", () => {
  // The pre-fix behaviour, stated rather than described: the first prose line after the H1.
  const lines = ["# ORIENTATION", "", "_MAINTAINED BY `rmd retro` — regenerated 2026-08-26T13:38:19.806Z._", "", "What this doc is about."];
  const preFix = lines.slice(1).find((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()))!.trim();
  assert.match(preFix, /2026-08-26T13:38:19/, "the old heuristic picked the volatile line");
  assert.doesNotMatch(parseDocEntry(lines.join("\n")).summary, /2026-08-26T13:38:19/, "and the fix does not");
});

test("parseDocEntry CONTROL: a line with emphasis INSIDE it is ordinary prose and is NOT skipped", () => {
  // 25 of docs/'s 26 first prose lines are this shape; skipping them would empty the index.
  const { summary } = parseDocEntry(["# ADR", "", "MASTER-PLAN §5 TIER 3: **ADR discipline for IRREVERSIBLE calls.** A short note."].join("\n"));
  assert.match(summary, /MASTER-PLAN/, "emphasis inside a sentence does not make it a banner");
});

test("parseDocEntry: a doc whose ONLY prose is a callout gets an empty summary, never machinery", () => {
  const { summary } = parseDocEntry(["# Generated", "", "_MAINTAINED BY a robot — regenerated 2026-01-01T00:00:00.000Z._", "", "## Next"].join("\n"));
  assert.equal(summary, "", "an empty summary is honest; a maintenance banner is not");
});
