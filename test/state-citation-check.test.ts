import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// ── W1-T1263: STATE-CITATION gate ───────────────────────────────────────────────────────────
//
// A durable record -- a census, a research report, a numbered set of governing constraints -- can
// be written into gitignored state/ (runtime exhaust, swept by design: sweepStaleTempDirs,
// scratchReap, reapStaleWorktrees, container recreation) and then cited BY PATH from a tracked
// file as the source of record. The tracked file survives every sweep; the thing it points at
// does not. This has cost the repo twice, twelve days apart (#1587/710b18b5, then the Law 4/5
// loss), and CLAUDE.md's own prose convention against it went unenforced both times.
//
// scripts/state-citation-check.mjs is the gate this suite proves ACTIVE, not merely present: a
// tracked file citing an unbaselined state/*.md-shaped path turns the CLI red and names the exact
// file:line; ordinary runtime state/ paths (no `.md` suffix) are never even extracted, let alone
// flagged; the SAME unbaselined path can land on opposite sides in the SAME file depending on
// whether the citing text records the path as unrecoverable (the design's hardest case, modelled
// on MASTER-PLAN.md's own two citations of the P48 census document); a baselined path passes while
// a different, unbaselined path in the same file still fails; and a scan that reads zero files
// refuses rather than reporting success.
//
// NOT YET WIRED INTO ci.yml -- deliberately, this PR. See the "real repo" test below for why:
// landing the workflow job in the same diff as the src/lib/review.ts INSTRUMENT_SURFACE
// registration that wiring requires trips remudero-review's own instrument-entanglement gate.
// The checker itself is complete and proven correct against the real repository right now; CI
// wiring is the tracked follow-up.
//
// (scripts/state-citation-check.mjs is a plain .mjs file outside tsconfig's `include`, so it is
// exercised here only via its CLI surface for the acceptance-level tests, plus its exported pure
// functions for the arm-level tests -- same convention as test/task-id-existence-check.test.ts.)
//
// A NOTE ON THE FIXTURE PATHS BELOW: every `state/*.md`-shaped literal a fixture needs is built
// via string concatenation (`mdPath(...)`), never written as one contiguous literal in THIS
// file's own source text. That is not decoration -- this suite's default-scoped CLI test (the
// last one below) runs the real checker against the REAL repository, and this file is itself a
// TRACKED file under test/, which the checker's default scan root (".") covers. A bare literal
// fixture path sitting in this file's own text would be a brand-new, unbaselined citation the
// checker would (correctly) flag against itself.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "state-citation-check.mjs");

/** Never write a literal `state/<name>.md` substring into this file's own source -- see the file
 *  header. Every fixture path is built through here instead. */
function mdPath(name: string): string {
  return "state/" + name + ".md";
}

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `state-citation-${prefix}-`));
}

/** A fresh git repo with nothing added to its index yet -- `git ls-files` against it returns
 *  nothing until `gitAdd` is called. No identity config needed: this suite never commits,
 *  `git add` alone is enough to make a file appear in `git ls-files`. */
function mkFixtureRepo(): string {
  const root = mkTmp("fixture");
  execFileSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  return root;
}

function gitAdd(root: string) {
  execFileSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
}

/** Baseline files live OUTSIDE the fixture repo root, in their own scratch directory -- so a
 *  fixture repo's `git status` is never perturbed by the baseline file's own existence, which the
 *  read-only test below depends on. */
function writeBaseline(entries: Array<{ path: string; reason: string }>): string {
  const dir = mkTmp("baseline");
  const p = join(dir, "baseline.json");
  writeFileSync(p, JSON.stringify(entries, null, 2));
  return p;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

// ── acceptance 1: an unbaselined citation of a durable state/*.md path fails ────────────────

test("state-citation: a tracked file citing an unbaselined state/*.md path FAILS, naming the file:line", () => {
  const root = mkFixtureRepo();
  try {
    writeFileSync(join(root, "note.md"), `See ${mdPath("fresh-orphan-9001")} for detail.\n`);
    gitAdd(root);
    const baseline = writeBaseline([]);
    const result = runCli(["--cwd", root, "--baseline", baseline]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /FAILED/);
    assert.match(output, /fresh-orphan-9001\.md/);
    assert.match(output, /note\.md:1/);
  } finally {
    cleanup(root);
  }
});

// ── acceptance 2: ordinary runtime state/ paths are never flagged ───────────────────────────

test("state-citation: ordinary runtime state/ paths (ledger, sentinel, lock, proposals, tokens, logs) are never flagged", () => {
  const root = mkFixtureRepo();
  try {
    writeFileSync(
      join(root, "note.md"),
      [
        "state/ledger.ndjson",
        "state/PAUSE",
        "state/inbox-proposals.json",
        "state/service-tokens.json",
        "state/drain.lock",
        "state/logs/daemon.out.log",
      ].join("\n") + "\n",
    );
    gitAdd(root);
    const baseline = writeBaseline([]);
    const result = runCli(["--cwd", root, "--baseline", baseline]);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.match(output, /state-citation: OK/);
  } finally {
    cleanup(root);
  }
});

// ── acceptance 3: the same unbaselined path lands on opposite sides depending on content shape ──

test("state-citation: a citation recording the path as unrecoverable PASSES while a citation of the SAME unbaselined path as evidence FAILS", () => {
  const root = mkFixtureRepo();
  try {
    const p = mdPath("tombstoned-9002");
    const lines = [
      `GROUND TRUTH, from ${p}, re-derived at deadbeef: 7 recorded instances.`, // line 1 -- evidence
      "filler line one, pushing the two citations apart",
      "filler line two",
      "filler line three",
      "filler line four",
      "filler line five",
      `${p} is`, // line 7 -- the loss-recording citation
      "unrecoverable -- never committed on any ref, no tracked copy or backup.", // line 8 -- the marker
    ];
    writeFileSync(join(root, "doc.md"), lines.join("\n") + "\n");
    gitAdd(root);
    const baseline = writeBaseline([]);
    const result = runCli(["--cwd", root, "--baseline", baseline]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output); // the evidence citation alone still fails the run
    assert.match(output, /doc\.md:1 --/, "the ground-truth (evidence) citation must be named FAILED");
    assert.match(output, /MARKED/, "the loss-recording citation must be reported as passing via the marker");
    assert.doesNotMatch(output, /doc\.md:7 --/, "the loss-recording citation must NOT appear in the FAILED list");
  } finally {
    cleanup(root);
  }
});

// ── acceptance 4: a baseline entry grandfathers its own path, never a different one ─────────

test("state-citation: a baselined path PASSES while a different, unbaselined path in the same file still FAILS", () => {
  const root = mkFixtureRepo();
  try {
    const baselinedPath = mdPath("grandfathered-9003");
    const freshPath = mdPath("brand-new-9004");
    writeFileSync(join(root, "doc.md"), `${baselinedPath} and also ${freshPath}\n`);
    gitAdd(root);
    const baseline = writeBaseline([{ path: baselinedPath, reason: "fixture: pre-existing citation predating this gate" }]);
    const result = runCli(["--cwd", root, "--baseline", baseline]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /BASELINE/);
    assert.match(output, /grandfathered-9003/);
    assert.match(output, /FAILED/);
    assert.match(output, /brand-new-9004/);
  } finally {
    cleanup(root);
  }
});

// ── acceptance 5: a scan that reads zero files refuses rather than reporting success ─────────

test("state-citation: a scan that reads zero files REFUSES rather than reporting success", () => {
  const root = mkFixtureRepo(); // nothing ever added to the index
  try {
    const baseline = writeBaseline([]);
    const result = runCli(["--cwd", root, "--baseline", baseline]);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /FAILED/);
    assert.match(output, /ZERO files/);
  } finally {
    cleanup(root);
  }
});

// ── the scan is read-only ────────────────────────────────────────────────────────────────────

test("state-citation: the scan is read-only -- it mutates neither the tracked tree nor the git index", () => {
  const root = mkFixtureRepo();
  try {
    writeFileSync(join(root, "note.md"), `cites ${mdPath("readonly-check-9005")}\n`);
    gitAdd(root);
    const beforeStatus = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    const beforeContent = readFileSync(join(root, "note.md"), "utf8");
    const baseline = writeBaseline([]);
    const result = runCli(["--cwd", root, "--baseline", baseline]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr); // sanity: this run did fail
    const afterStatus = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    assert.equal(afterStatus, beforeStatus, "the fixture repo's git status must be byte-identical before and after");
    assert.equal(readFileSync(join(root, "note.md"), "utf8"), beforeContent);
  } finally {
    cleanup(root);
  }
});

// ── the real repo's own checked-in baseline is honest ────────────────────────────────────────
//
// NOT YET WIRED INTO ci.yml -- see this suite's file header and the PR this shipped in for why:
// landing `.github/workflows/ci.yml` in the SAME diff as `src/lib/review.ts`'s INSTRUMENT_SURFACE
// registration (required for test/instrument-surface-completeness.test.ts to stay green once this
// script is referenced from a workflow/package.json) triggers `detectInstrumentEntanglement`
// (src/lib/review.ts) -- remudero-review's own merge-blocking logic, not a lint script -- because
// that registration is a `src/` product-path edit landing beside `.github/workflows/ci.yml` and
// `scripts/state-citation-baseline.json` (both on `INSTRUMENT_SURFACE`). docs/operator-guide.md
// documents the same conflict for every prior gate of this shape and prescribes a sequential,
// multi-PR split as the only way through. This test proves the CHECKER ITSELF is real and correct
// against the actual repository right now; wiring it into ci.yml is the tracked follow-up.

test("state-citation: the real repo, scanned for real with its own checked-in baseline, is clean today", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// ── the pure pieces, driven directly ─────────────────────────────────────────────────────────

const mod = await import(pathToFileURL(SCRIPT).href);

test("W1-T1263: scanCitations never even extracts a runtime state/ path with no .md suffix", () => {
  const root = mkFixtureRepo();
  try {
    writeFileSync(join(root, "note.md"), "state/ledger.ndjson and state/PAUSE, neither ends in .md\n");
    gitAdd(root);
    const { occurrences, filesScanned } = mod.scanCitations(["."], root);
    assert.equal(filesScanned, 1);
    assert.deepEqual(occurrences, []);
  } finally {
    cleanup(root);
  }
});

test("W1-T1263: scanCitations marks a citation whose block carries the marker exactly at the window edge", () => {
  const root = mkFixtureRepo();
  try {
    // CONTEXT_WINDOW is 3: the citation is on line 1, "unrecoverable" on line 4 -- 3 lines away,
    // exactly at the edge that must still be considered part of the same block.
    const p = mdPath("edge-in-9006");
    writeFileSync(join(root, "doc.md"), [`${p} cited here`, "filler", "filler", "unrecoverable, plainly"].join("\n") + "\n");
    gitAdd(root);
    const { occurrences } = mod.scanCitations(["."], root);
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0].marked, true);
  } finally {
    cleanup(root);
  }
});

test("W1-T1263: scanCitations does NOT mark a citation whose only marker sits one line past the window", () => {
  const root = mkFixtureRepo();
  try {
    // Same shape as the edge-in case above, but with ONE more filler line: the marker is now 4
    // lines away, past CONTEXT_WINDOW -- this must NOT be treated as the same block, or the
    // ground-truth-vs-loss-recording separation (acceptance 3) could not hold in a longer document.
    const p = mdPath("edge-out-9007");
    writeFileSync(join(root, "doc.md"), [`${p} cited here`, "filler", "filler", "filler", "unrecoverable, plainly"].join("\n") + "\n");
    gitAdd(root);
    const { occurrences } = mod.scanCitations(["."], root);
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0].marked, false);
  } finally {
    cleanup(root);
  }
});

test("W1-T1263: scanCitations never reads the baseline file itself, even when it sits inside a scanned dir", () => {
  const root = mkFixtureRepo();
  try {
    const p = mdPath("self-reference-9008");
    // The baseline file lives INSIDE the fixture root this time, deliberately, to prove the
    // exclusion (not merely that it happens to live outside the scan root in other tests).
    const baselineAbs = join(root, "baseline.json");
    writeFileSync(baselineAbs, JSON.stringify([{ path: p, reason: "self-reference fixture" }]));
    writeFileSync(join(root, "real-citer.md"), `also cites ${p}\n`);
    gitAdd(root);
    const { occurrences, filesScanned } = mod.scanCitations(["."], root, baselineAbs);
    assert.equal(filesScanned, 1, "only real-citer.md should be read, not baseline.json");
    assert.deepEqual(
      occurrences.map((o: { file: string }) => o.file),
      ["real-citer.md"],
    );
  } finally {
    cleanup(root);
  }
});

test("W1-T1263: scanCitations skips a tracked file whose extension marks it binary", () => {
  const root = mkFixtureRepo();
  try {
    // Not really a PNG -- just text under a binary-flagged extension, to prove the extension
    // filter (not content sniffing) is what excludes it.
    writeFileSync(join(root, "asset.png"), `pretends to cite ${mdPath("binary-should-not-count-9009")}\n`);
    gitAdd(root);
    const { occurrences, filesScanned } = mod.scanCitations(["."], root);
    assert.equal(filesScanned, 0);
    assert.deepEqual(occurrences, []);
  } finally {
    cleanup(root);
  }
});

test("W1-T1263: listTrackedFiles throws when cwd is not a git repository at all", () => {
  const root = mkTmp("not-a-git-repo");
  try {
    assert.throws(
      () => mod.listTrackedFiles(["."], root),
      (e: Error) => /git ls-files.*failed/.test(e.message),
    );
  } finally {
    cleanup(root);
  }
});

test("W1-T1263: listTrackedFiles resolves paths relative to cwd for a real (non-git-error) repo", () => {
  const root = mkFixtureRepo();
  try {
    writeFileSync(join(root, "a.md"), "content\n");
    gitAdd(root);
    assert.deepEqual(mod.listTrackedFiles(["."], root), ["a.md"]);
  } finally {
    cleanup(root);
  }
});

test("W1-T1263: loadBaseline refuses an unreadable file, naming the path", () => {
  const missing = join(mkTmp("scratch"), "absent.json");
  assert.throws(
    () => mod.loadBaseline(missing),
    (e: Error) => /cannot read baseline file .*absent\.json/.test(e.message),
  );
});

test("W1-T1263: loadBaseline refuses a file that is not valid JSON", () => {
  const dir = mkTmp("scratch");
  const p = join(dir, "b.json");
  writeFileSync(p, "{not json");
  try {
    assert.throws(() => mod.loadBaseline(p), (e: Error) => /is not valid JSON/.test(e.message));
  } finally {
    cleanup(dir);
  }
});

test("W1-T1263: loadBaseline refuses a JSON document that is not an array of entries", () => {
  const dir = mkTmp("scratch");
  const p = join(dir, "b.json");
  writeFileSync(p, JSON.stringify({ [mdPath("not-an-array-9010")]: "a map, not an array" }));
  try {
    assert.throws(() => mod.loadBaseline(p), (e: Error) => /must be a JSON array/.test(e.message));
  } finally {
    cleanup(dir);
  }
});

test("W1-T1263: loadBaseline refuses an entry whose path is missing, wrongly shaped, or not a state/*.md string", () => {
  const dir = mkTmp("scratch");
  const p = join(dir, "b.json");
  const badEntries = [
    { reason: "no path at all" },
    { path: "not-under-state", reason: "wrong shape" },
    { path: "state/no-extension", reason: "missing .md" },
    { path: 7, reason: "not a string" },
  ];
  try {
    for (const entry of badEntries) {
      writeFileSync(p, JSON.stringify([entry]));
      assert.throws(() => mod.loadBaseline(p), (e: Error) => /has no valid "path"/.test(e.message));
    }
  } finally {
    cleanup(dir);
  }
});

test("W1-T1263: loadBaseline refuses an entry with no written reason", () => {
  const dir = mkTmp("scratch");
  const p = join(dir, "b.json");
  writeFileSync(p, JSON.stringify([{ path: mdPath("no-reason-9011"), reason: "" }]));
  try {
    assert.throws(() => mod.loadBaseline(p), (e: Error) => /NO WRITTEN REASON/.test(e.message));
  } finally {
    cleanup(dir);
  }
});

test("W1-T1263: loadBaseline refuses the same path listed twice, and loads a well-formed file", () => {
  const dir = mkTmp("scratch");
  const p = join(dir, "b.json");
  const dup = mdPath("dup-9012");
  writeFileSync(p, JSON.stringify([{ path: dup, reason: "first" }, { path: dup, reason: "second" }]));
  assert.throws(() => mod.loadBaseline(p), (e: Error) => /lists .* more than once/.test(e.message));

  // Positive control: the same shape with distinct paths loads cleanly.
  const a = mdPath("distinct-a-9013");
  const b = mdPath("distinct-b-9014");
  writeFileSync(p, JSON.stringify([{ path: a, reason: "first" }, { path: b, reason: "second" }]));
  assert.deepEqual([...mod.loadBaseline(p).keys()].sort(), [a, b].sort());
  cleanup(dir);
});
