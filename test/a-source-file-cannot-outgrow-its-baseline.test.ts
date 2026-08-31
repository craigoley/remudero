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
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "source-size-ratchet.mjs");
const REAL_BASELINE = join(REPO_ROOT, "scripts", "source-size-baseline.json");

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
  const gate = run(["--root", REPO_ROOT, "--baseline", REAL_BASELINE]);
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
      /"src\/lib\/grown\.ts": 7,/,
      "it must print the exact JSON line to write, so following it needs no arithmetic and no guesswork",
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
    plant(root, "src/lib/shrunk.ts", 4);
    const baselinePath = writeBaseline(root, { "src/lib/shrunk.ts": 10 });
    const result = run(["--root", root, "--baseline", baselinePath]);
    assert.equal(result.status, 0, `a shrink must never fail:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ratcheting .* DOWN/);
    assert.match(result.stdout, /src\/lib\/shrunk\.ts: 10 -> 4 lines/);
    assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), { "src/lib/shrunk.ts": 4 });
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
    assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), { "src/lib/brand-new.ts": 6 });
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
