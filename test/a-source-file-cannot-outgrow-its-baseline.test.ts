// test/a-source-file-cannot-outgrow-its-baseline.test.ts — W1-T2488: a source file's own LINE
// COUNT is the one drift dimension this repo's five existing ratchets (CLAUDE.md's injected byte
// weight, diff coverage, dependency cycles, the learnings budget, the mutation score) do not
// cover. `src/run-task.ts` grew to 32,119 lines against a next-largest source file of 8,445 with
// nothing watching. scripts/source-size-ratchet.mjs is the sixth ratchet, in the same lineage;
// this suite drives it as a real subprocess (a real exit code is what CI actually consumes) over
// isolated fixture directories, mirroring test/cycle-ratchet.test.ts's own convention for its
// sibling gate.
//
// EVERY FIXTURE IS WRITTEN UNDER `mkdtemp`, NEVER INTO THE TRACKED TREE: a test that rewrites a
// tracked file is observed by every other worker in the same concurrent run (W1-T2291), and this
// suite must not add a member to that family while proving a gate about the tree's own shape.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "source-size-ratchet.mjs");
const REAL_BASELINE = join(REPO_ROOT, "scripts", "source-size-baseline.json");

// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/source-size-ratchet.mjs"` is a TS7016 — the same reason
// test/learnings-ratchet-candidates.test.ts reaches its script through a runtime import rather
// than a typed one. A dynamic specifier is not statically resolved, so this loads the REAL
// module with no shadow copy to drift from it.
const { CEILING_BUCKET_LINES, ceilingFor, evaluateSourceSizeRatchet } = (await import(
  pathToFileURL(SCRIPT).href
)) as {
  CEILING_BUCKET_LINES: number;
  ceilingFor: (lines: number) => number;
  evaluateSourceSizeRatchet: (
    currentLines: Record<string, number>,
    baseline: Record<string, number>,
  ) => {
    ok: boolean;
    violations: Array<{ path: string; lines: number; baseline: number; overage: number }>;
    shrunk: Array<{ path: string; from: number; to: number }>;
    added: Array<{ path: string; lines: number }>;
    removed: string[];
    nextBaseline: Record<string, number>;
  };
};

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-source-size-ratchet-"));
}

/** Content with EXACTLY `n` `\n` bytes — `wc -l` semantics, matching what `countLines` measures. */
function linesOf(n: number): string {
  return `${Array.from({ length: n }, (_, i) => `// line ${i}`).join("\n")}\n`;
}

/** Write a source file at `relPath` (e.g. `src/lib/foo.ts`) under `root`, creating parents. */
function plant(root: string, relPath: string, lineCount: number): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, linesOf(lineCount));
}

function writeBaseline(root: string, body: Record<string, number>): string {
  const path = join(root, "baseline.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

// ── sanity: the gate is live over the shipped tree, and the SURFACE figures it measures are ────
// exactly the ones this task's own rationale cites ───────────────────────────────────────────────

test("the shipped tree passes its own recorded baseline, and the ratchet is not vacuous — it really measures src/run-task.ts and src/lib/sweep.ts", () => {
  // ⚠ AGAINST A COPY, NEVER THE TRACKED FILE — this suite's own header states the rule and this
  // was the one test breaking it. `main()` does not only READ: when it sees a source file the
  // baseline has no entry for, it RECORDS one and `writeFileSync`s the result (source-size-
  // ratchet.mjs). Run against the real path, an ordinary suite run therefore edits a tracked file
  // whenever `src/**` has gained a module — MEASURED twice on 2026-09-02, both times adding
  // `src/lib/followup-dedup-census.ts` and leaving the tree dirty for whatever ran next. That is
  // the W1-T2291 family the header above refuses to join, and it also silently pre-approves growth
  // the gate exists to make someone decide about.
  //
  // The copy carries the recorded baseline's exact CONTENT, so the assertion below is unchanged in
  // meaning: the shipped tree still has to pass the baseline this repo actually records. Only the
  // write lands somewhere throwaway.
  const scratch = mkdtempSync(join(tmpdir(), "rmd-size-baseline-"));
  const baselineCopy = join(scratch, "source-size-baseline.json");
  writeFileSync(baselineCopy, readFileSync(REAL_BASELINE, "utf8"));
  const gate = run(["--root", REPO_ROOT, "--baseline", baselineCopy]);
  rmSync(scratch, { recursive: true, force: true });
  assert.equal(gate.status, 0, `the tree must pass its own baseline:\n${gate.stdout}\n${gate.stderr}`);
  assert.match(gate.stdout, /source-size-ratchet: OK/);
  const baseline = JSON.parse(readFileSync(REAL_BASELINE, "utf8")) as Record<string, number>;
  assert.ok(
    (baseline["src/run-task.ts"] ?? 0) > (baseline["src/lib/sweep.ts"] ?? 0),
    "sanity: src/run-task.ts must still be recorded as the largest source file, or this gate proves nothing about the defect it names",
  );
});

// ── acceptance: "a source file growing past its recorded baseline fails the gate" / "the ────────
// failure names the file and the overage in lines" ─────────────────────────────────────────────

test("THE FALSIFIER: a source file grown past its recorded baseline BLOCKS, naming the file and the exact overage in lines", () => {
  const root = tmpRoot();
  try {
    plant(root, "src/lib/grown.ts", 7); // grew from a baseline of 3 to 7 — +4 lines over
    const baselinePath = writeBaseline(root, { "src/lib/grown.ts": 3 });
    const over = run(["--root", root, "--baseline", baselinePath]);
    assert.notEqual(over.status, 0, "a file over its baseline must BLOCK");
    assert.match(over.stderr, /source-size-ratchet: BLOCKED/);
    assert.match(over.stderr, /src\/lib\/grown\.ts/, "the failure must name the file");
    assert.match(over.stderr, /7 lines > baseline 3 lines/, "the failure must state both the actual and baseline line counts");
    assert.match(over.stderr, /\+4 line\(s\) over/, "the failure must name the exact overage");
    // W1-T2532: THE REMEDY MUST BE FOLLOWABLE BY WHOEVER READS IT, INCLUDING AN AGENT. The first
    // wording ended "raise the entry in <absolute runner path> by hand", and the sweep's ci-log fix
    // worker read "by hand" as "not yours to edit": four consecutive `ci-log false-block`
    // escalations (issues #3362, #3368, #3369, #3374) landed against PRs whose ONLY failing check
    // was this gate, while 6 of 9 open PRs sat blocked on it. These assertions pin the three things
    // that make the message actionable, so it cannot silently revert to prose.
    assert.match(over.stderr, /TO FIX:/, "the failure must lead with what to do, not only what is wrong");
    assert.match(
      over.stderr,
      /"src\/lib\/grown\.ts": 500,/,
      "it must print the exact JSON line to write, so following it needs no arithmetic and no guesswork — " +
        "W1-T2539: that line is the BUCKET (ceilingFor(7) === 500), never the raw count, because printing " +
        "the raw count would hand the author a value the very next run refuses to keep",
    );
    assert.match(
      over.stderr,
      /scripts\/source-size-baseline\.json/,
      "and name the baseline by its REPO-RELATIVE path — the absolute runner path names nothing the reader can edit",
    );
    assert.doesNotMatch(
      over.stderr,
      /by hand/,
      "never 'by hand': recording deliberate growth is the ordinary outcome and is safe in the same PR (W1-T2526 exempts this path from Standing rule 25)",
    );
    // W1-T2532 ROUND 2: recording the ceiling changes the diff, which makes the PR body's own
    // file claim false and fails the PR from a DIFFERENT gate (bodyContradictsDiff) whose message
    // never mentions this one. MEASURED 2026-08-31: #3365, #3373 and #3378 all landed on that
    // refusal inside one sweep, the extra file being scripts/source-size-baseline.json every time.
    // Following this remedy must not hand the reader into the next refusal unwarned.
    assert.match(
      over.stderr,
      /THEN UPDATE THE PR BODY/,
      "the remedy must warn that recording the ceiling invalidates the body's own file claim",
    );
    assert.match(
      over.stderr,
      /git diff --name-only origin\/main\.\.\.HEAD/,
      "and name the command that re-derives that claim, so the reader is not left to guess",
    );
    assert.match(
      over.stderr,
      /negation is not parsed/,
      "and warn that a NEGATED scope claim is not safe — 'Plan-only: no.' still reads as a plan-only claim (measured on #3373)",
    );
    // the baseline is NEVER advanced by a failing run — raising a ceiling is a human, on-the-record move
    assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), { "src/lib/grown.ts": 3 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance: "a source file at exactly its baseline passes" / falsifier for the block above ──
// ("removing the growth refusal makes the over-baseline case pass") ─────────────────────────────

test("a source file at EXACTLY its baseline passes — and shrinking the SAME over-baseline fixture back down to the baseline is what flips it, proving the block above was the GROWTH and not the fixture", () => {
  const root = tmpRoot();
  try {
    const baselinePath = writeBaseline(root, { "src/lib/grown.ts": 3 });

    plant(root, "src/lib/grown.ts", 7); // the identical over-baseline shape as the falsifier above
    const over = run(["--root", root, "--baseline", baselinePath]);
    assert.notEqual(over.status, 0, "sanity: the over-baseline case still blocks");

    plant(root, "src/lib/grown.ts", 3); // remove exactly the growth that caused the block — nothing else changes
    const at = run(["--root", root, "--baseline", baselinePath]);
    assert.equal(at.status, 0, `at exactly the baseline must pass:\n${at.stdout}\n${at.stderr}`);
    assert.match(at.stdout, /source-size-ratchet: OK/);
    // unchanged — a file at its recorded baseline is neither a shrink nor a growth
    assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), { "src/lib/grown.ts": 3 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance: "a shrunk file rewrites its baseline downward rather than failing" ──────────────

test("a shrunk file PASSES and rewrites its baseline downward automatically — lowering a ceiling is always free", () => {
  const root = tmpRoot();
  try {
    plant(root, "src/lib/shrunk.ts", 2400); // drops a whole bucket: 3500 -> 2500
    // W1-T2539: sized past one bucket deliberately. A sub-bucket shrink no longer re-records —
    // rewriting the ceiling for every few lines lost would re-introduce, on the way DOWN, exactly
    // the colliding edit this bucket exists to remove.
    const baselinePath = writeBaseline(root, { "src/lib/shrunk.ts": 3500 });
    const result = run(["--root", root, "--baseline", baselinePath]);
    assert.equal(result.status, 0, `a shrink must never fail:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ratcheting .* DOWN/);
    assert.match(result.stdout, /src\/lib\/shrunk\.ts: 3500 -> 2500 lines/);
    assert.deepEqual(
      JSON.parse(readFileSync(baselinePath, "utf8")),
      { "src/lib/shrunk.ts": 2500 },
      "holds the gain at the lower BUCKET — the guarantee is unchanged, only the recorded number is",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance: "a newly added source file is recorded rather than refused" ─────────────────────

test("a newly added source file (absent from the baseline) is RECORDED, never refused", () => {
  const root = tmpRoot();
  try {
    plant(root, "src/lib/brand-new.ts", 6);
    const baselinePath = writeBaseline(root, {});
    const result = run(["--root", root, "--baseline", baselinePath]);
    assert.equal(result.status, 0, `a new file must never be refused:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /recording 1 newly seen source file/);
    assert.match(result.stdout, /src\/lib\/brand-new\.ts: 6 lines/);
    // W1-T2539: a new file records its BUCKET, not its length. That headroom is the point — the
    // next PR to grow it does not touch this file at all, so there is no line to collide on.
    assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), { "src/lib/brand-new.ts": 500 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted source file is dropped from the baseline silently — deleting a file is not growth", () => {
  const root = tmpRoot();
  try {
    // the fixture root has NO src/ file at all for this path — the same observable as "deleted".
    const baselinePath = writeBaseline(root, { "src/lib/gone.ts": 40 });
    const result = run(["--root", root, "--baseline", baselinePath]);
    assert.equal(result.status, 0, `an absent file must never block:\n${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── a malformed baseline is refused, never silently disarmed — W1-T1277's four-ratchet ──────────
// failure mode, which this ratchet does not join ─────────────────────────────────────────────────

test("a malformed baseline is REFUSED, never silently disarmed", () => {
  const root = tmpRoot();
  try {
    plant(root, "src/lib/anything.ts", 1);
    for (const bad of ['{"src/lib/anything.ts": "1"}', '{"src/lib/anything.ts": 1.5}', '{"src/lib/anything.ts": -1}', "[]", "not json"]) {
      const baselinePath = join(root, "bad.json");
      writeFileSync(baselinePath, bad);
      const result = run(["--root", root, "--baseline", baselinePath]);
      assert.notEqual(result.status, 0, `a malformed baseline (${bad}) must be refused, not silently passed`);
      assert.match(result.stderr, /source-size-ratchet:/);
    }
    const goodPath = writeBaseline(root, { "src/lib/anything.ts": 1 });
    const good = run(["--root", root, "--baseline", goodPath]);
    assert.equal(good.status, 0, "the falsifier: a WELL-FORMED baseline is accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance: "the step is a member of the habitual fast gate" ────────────────────────────────

test("source-size-ratchet is a member of FAST_GATE_STEPS and wired into package.json's scripts", () => {
  const ciParity = readFileSync(join(REPO_ROOT, "src", "lib", "ci-parity.ts"), "utf8");
  const stepsStart = ciParity.indexOf("export const FAST_GATE_STEPS");
  assert.ok(stepsStart > 0, "sanity: FAST_GATE_STEPS must still be declared");
  const stepsEnd = ciParity.indexOf("\n];", stepsStart);
  const stepsBlock = ciParity.slice(stepsStart, stepsEnd);
  assert.match(stepsBlock, /script:\s*"source-size-ratchet"/, "source-size-ratchet must be a FAST_GATE_STEPS entry");

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["source-size-ratchet"], "node scripts/source-size-ratchet.mjs");
});

// ── acceptance: "the step spawns no test runner and opens no network connection" ─────────────────

test("scripts/source-size-ratchet.mjs spawns NO subprocess at all (no test runner, no git, nothing) and opens no network connection", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(source, /node:child_process/, "no child_process import — this gate spawns nothing, not even git");
  assert.doesNotMatch(source, /\bnode\s+--test\b/, "no test-runner invocation anywhere in the source");
  for (const networkModule of ["node:http", "node:https", "node:net", "node:tls", "node:dgram"]) {
    assert.doesNotMatch(source, new RegExp(networkModule.replace(":", "\\:")), `no ${networkModule} import — this gate opens no network connection`);
  }
  assert.doesNotMatch(source, /\bfetch\s*\(/, "no fetch() call — this gate opens no network connection");
});

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * W1-T2539 — THE BUCKET. An exact recorded ceiling means every PR that grows a file edits the SAME
 * LINE, so two such PRs always conflict — and the conflict is UNRESOLVABLE by the merge-conflict
 * rung, because changing a value on an existing JSON key is a deletion plus an addition and
 * `isPureConcurrentAddition` refuses any deletion. Measured 2026-08-31 on the three PRs left dirty
 * after W1-T2536 turned that rung on: ours -1/-2/-2 against theirs -5/-7/-10, all on this file.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

test("W1-T2539 criterion 1: a recorded ceiling is a BUCKET, so ordinary growth needs no edit", () => {
  // A new file records its bucket, not its length — which is what leaves headroom for the next
  // PR to grow it without touching this file at all.
  const r = evaluateSourceSizeRatchet({ "src/a.ts": 3230 }, {});
  assert.equal(r.ok, true);
  assert.equal(r.nextBaseline["src/a.ts"], 3500, "records the bucket, never the raw count");
  // ...and growth inside that bucket is a no-op: same recorded value, nothing to conflict on.
  const grown = evaluateSourceSizeRatchet({ "src/a.ts": 3499 }, { "src/a.ts": 3500 });
  assert.equal(grown.ok, true);
  assert.equal(grown.nextBaseline["src/a.ts"], 3500, "unchanged — no line is edited, so none can collide");
  assert.equal(grown.shrunk.length, 0);
});

test("W1-T2539 criterion 2: THE PROPERTY THAT REMOVES THE CLASS — differing counts record the IDENTICAL value", () => {
  // git auto-merges an identical change. This is why bucketing eliminates the conflict rather than
  // just making it rarer. All three real 2026-08-31 conflicts, replayed.
  for (const [ours, theirs, truth] of [
    [3136, 3138, 3230],
    [32692, 32713, 32818],
    [32743, 32718, 32748],
  ] as [number, number, number][]) {
    const a = evaluateSourceSizeRatchet({ "src/x.ts": ours }, {}).nextBaseline["src/x.ts"];
    const b = evaluateSourceSizeRatchet({ "src/x.ts": theirs }, {}).nextBaseline["src/x.ts"];
    assert.equal(a, b, `${ours} and ${theirs} must record the SAME line — that is what git can merge`);
    // and the merged tree, which is longer than either side, still fits underneath it
    assert.equal(
      evaluateSourceSizeRatchet({ "src/x.ts": truth }, { "src/x.ts": a }).ok,
      true,
      `the merged truth ${truth} must fit under ${a}, or the conflict is replaced by a block`,
    );
  }
});

test("W1-T2539 criterion 3: a file that grows PAST its bucket still BLOCKS, and the remedy names the bucket", () => {
  const r = evaluateSourceSizeRatchet({ "src/a.ts": 3501 }, { "src/a.ts": 3500 });
  assert.equal(r.ok, false, "the gate still refuses — this task changes the recorded number, not the refusal");
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].baseline, 3500);
  assert.equal(r.violations[0].lines, 3501);
  // The REMEDY must print the bucket. Printing the raw count would hand the author a value the
  // very next run refuses to keep, which is a worse instruction than the one W1-T2538 just fixed.
  assert.equal(ceilingFor(3501), 4000);
});

test("W1-T2539 criterion 4: a failing run still never advances the baseline", () => {
  const r = evaluateSourceSizeRatchet({ "src/a.ts": 9999 }, { "src/a.ts": 3500 });
  assert.equal(r.ok, false);
  assert.equal(r.nextBaseline["src/a.ts"], 3500, "raising a ceiling stays a human, on-the-record move");
});

test("W1-T2539 criterion 5: a shrink re-records only once a WHOLE bucket is dropped", () => {
  // A small shrink must NOT rewrite: doing so re-introduces the colliding edit on the way DOWN.
  const small = evaluateSourceSizeRatchet({ "src/a.ts": 3100 }, { "src/a.ts": 3500 });
  assert.equal(small.shrunk.length, 0, "a sub-bucket shrink leaves the ceiling alone");
  assert.equal(small.nextBaseline["src/a.ts"], 3500);
  // A real drop still holds the gain.
  const big = evaluateSourceSizeRatchet({ "src/a.ts": 2400 }, { "src/a.ts": 3500 });
  assert.equal(big.shrunk.length, 1);
  assert.equal(big.nextBaseline["src/a.ts"], 2500, "takes the lower BUCKET, not the raw count");
});

test("W1-T2539 criterion 6: the bucket is a named export, so changing it is a one-line reviewed edit", () => {
  assert.equal(typeof CEILING_BUCKET_LINES, "number");
  assert.ok(CEILING_BUCKET_LINES > 441, "must exceed the observed max single-commit growth of 441");
  // The derivation, pinned: no single commit can traverse a whole bucket from a standing start.
  assert.equal(ceilingFor(1), CEILING_BUCKET_LINES, "a tiny file still gets one full bucket, never 0");
  assert.equal(ceilingFor(0), CEILING_BUCKET_LINES, "and neither does an empty one breach a ceiling of nothing");
  assert.equal(ceilingFor(CEILING_BUCKET_LINES), CEILING_BUCKET_LINES, "an exact multiple does not round up a whole bucket");
  assert.equal(ceilingFor(CEILING_BUCKET_LINES + 1), CEILING_BUCKET_LINES * 2);
});

test("W1-T2539: the EXISTING exact-count baselines stay valid, so migration is lazy rather than a mass rewrite", () => {
  // The 145 live entries are exact counts. They must keep working untouched — an eager rewrite
  // would itself be a huge diff to this exact file, a conflict magnet against every in-flight PR.
  const exact = { "src/a.ts": 3230 };
  assert.equal(evaluateSourceSizeRatchet({ "src/a.ts": 3230 }, exact).ok, true, "at its exact ceiling: unchanged");
  assert.equal(evaluateSourceSizeRatchet({ "src/a.ts": 3229 }, exact).shrunk.length, 0, "one line under: no rewrite");
  assert.equal(evaluateSourceSizeRatchet({ "src/a.ts": 3231 }, exact).ok, false, "one line over: still blocks");
  // and it re-records into a bucket the first time it legitimately grows
  assert.equal(ceilingFor(3231), 3500);
});

test("no test in this suite passes the TRACKED baseline to the ratchet — the header's own rule, enforced", () => {
  // A source-level pin, because the leak is invisible in a green run: the ratchet writes only when
  // `src/**` has gained an unrecorded module, so the suite passes either way and the damage is a
  // dirty tracked file the NEXT thing to run inherits. Asserting on behaviour would reproduce that
  // same conditionality; asserting on the call site does not.
  const src = readFileSync(join(REPO_ROOT, "test", "a-source-file-cannot-outgrow-its-baseline.test.ts"), "utf8");
  const invocations = [...src.matchAll(/run\(\[[^\]]*\]\)/g)].map((m) => m[0]);
  assert.ok(invocations.length > 0, "control: the suite really does invoke the ratchet, or this pins nothing");
  for (const call of invocations) {
    assert.ok(
      !/REAL_BASELINE/.test(call),
      `the ratchet WRITES its baseline when it sees a new source file, so a run against the tracked ` +
        `path edits the repo mid-suite. Copy it under mkdtemp first. Offending call: ${call}`,
    );
  }
});
