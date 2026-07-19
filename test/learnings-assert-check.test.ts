import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T34: SELF-VERIFYING LEARNINGS (extends W1-T29 plan-claims to KNOWLEDGE) ──────────────────
//
// A learnings entry may carry an `assertion:` (a shell command that must exit 0 for its `fact` to
// still hold). This suite proves scripts/learnings-assert-check.mjs is ACTIVE, not merely present:
//   - `--check` is GREEN when the committed corpus already matches a fresh re-verification.
//   - `--check` is RED and NAMES the entry when an `active` entry's assertion now FAILS (the
//     auto-quarantine direction) or a `quarantined` entry's assertion now PASSES (the
//     auto-restore direction) -- either way the committed lifecycle is STALE.
//   - the mutating (non-`--check`) run performs EXACTLY that lifecycle flip via TEXT SURGERY --
//     the target entry's block changes, every sibling entry's bytes are untouched (no reflow) --
//     and a subsequent `--check` on the mutated corpus is green again.
//   - the injector (src/lib/learnings.ts) excludes a quarantined entry from a rendered prompt even
//     when its `files:` glob matches (test/learnings.test.ts covers the pure-selection half; this
//     file covers the assertion-runner half end to end).
//   - the REAL committed learnings/ corpus is currently clean (what CI checks via `npm test`).
//
// (scripts/learnings-assert-check.mjs is a plain .mjs file outside tsconfig's `include`, so it is
// exercised here only via its CLI surface, mirroring test/claims-check.test.ts and
// test/learnings-index.test.ts's convention for their sibling scripts.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "learnings-assert-check.mjs");
const FIXTURES = join(__dirname, "fixtures", "learnings-assert-check");

function runCheck(dir: string) {
  return spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--check", "--cwd", REPO_ROOT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function runMutate(dir: string) {
  return spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--cwd", REPO_ROOT], { cwd: REPO_ROOT, encoding: "utf8" });
}

function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `learnings-assert-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

test("learnings-assert-check --check: a CLEAN corpus (every committed lifecycle already matches a fresh re-verification) -> zero exit", () => {
  const result = runCheck(join(FIXTURES, "clean"));
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /PASS {2}a\.yaml#fixture-clean-active/);
  assert.match(output, /FAIL {2}a\.yaml#fixture-clean-quarantined/); // assertion still fails, but that's EXPECTED for a quarantined entry
  assert.match(output, /OK -- every asserted entry's lifecycle matches a fresh re-verification/);
});

test("learnings-assert-check --check: an ACTIVE entry whose assertion now FAILS -> non-zero exit, STALE, names the entry + the quarantine direction", () => {
  const result = runCheck(join(FIXTURES, "mixed"));
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /STALE/);
  assert.match(output, /\[fixture-active-failing\].*lifecycle is 'active' but should be 'quarantined'/);
});

test("learnings-assert-check --check: a QUARANTINED entry whose assertion now PASSES -> non-zero exit, names the entry + the restore direction", () => {
  const result = runCheck(join(FIXTURES, "mixed"));
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /\[fixture-quarantined-now-passing\].*lifecycle is 'quarantined' but should be 'active'/);
  assert.match(output, /re-verification restores it/);
});

test("learnings-assert-check --check: an entry with NO assertion and a SUPERSEDED entry (even with a failing assertion) are never flagged", () => {
  const result = runCheck(join(FIXTURES, "mixed"));
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /fixture-no-assertion/);
  assert.doesNotMatch(output, /fixture-superseded-with-failing-assertion/);
});

test("learnings-assert-check --check: a STILL-quarantined entry (assertion still fails) is not re-flagged (no flip-flop)", () => {
  const result = runCheck(join(FIXTURES, "mixed"));
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /fixture-quarantined-still-failing.*lifecycle is/);
});

test("learnings-assert (mutate): flips EXACTLY the drifting entries via text surgery -- siblings byte-identical, no reflow", () => {
  const dir = copyFixture("mixed");
  try {
    const before = readFileSync(join(dir, "a.yaml"), "utf8");
    const result = runMutate(dir);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.match(output, /fixture-active-failing: active -> quarantined/);
    assert.match(output, /fixture-quarantined-now-passing: quarantined -> active/);

    const after = readFileSync(join(dir, "a.yaml"), "utf8");
    assert.notEqual(after, before, "the file must actually change");

    // the untouched entries' exact text must survive verbatim -- no reflow of the rest of the file
    for (const untouched of [
      "- id: fixture-active-passing",
      "- id: fixture-quarantined-still-failing",
      "- id: fixture-superseded-with-failing-assertion",
      "- id: fixture-no-assertion",
    ]) {
      assert.ok(before.includes(untouched) && after.includes(untouched), `${untouched} must be preserved`);
    }
    // the sibling entries' full blocks are byte-identical before/after (surgery is scoped)
    for (const id of ["fixture-active-passing", "fixture-quarantined-still-failing", "fixture-no-assertion"]) {
      const extract = (text: string) => {
        const start = text.indexOf(`- id: ${id}`);
        const next = text.indexOf("- id: ", start + 1);
        return text.slice(start, next === -1 ? undefined : next);
      };
      assert.equal(extract(after), extract(before), `entry '${id}' must be byte-identical`);
    }

    // the flipped entries now carry the right lifecycle + a quarantined_reason where expected
    const extractBlock = (text: string, id: string) => {
      const start = text.indexOf(`- id: ${id}`);
      const next = text.indexOf("- id: ", start + 1);
      return text.slice(start, next === -1 ? undefined : next);
    };
    assert.match(
      extractBlock(after, "fixture-active-failing"),
      /lifecycle: quarantined\n\s*quarantined_reason: "assertion failed \(exit 1\): exit 1"/,
    );
    const restoredBlock = extractBlock(after, "fixture-quarantined-now-passing");
    assert.match(restoredBlock, /lifecycle: active\n/);
    assert.doesNotMatch(restoredBlock, /quarantined_reason:/);

    // and a subsequent --check on the mutated corpus is green
    const recheck = runCheck(dir);
    assert.equal(recheck.status, 0, recheck.stdout + recheck.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("learnings-assert (mutate): a CLEAN corpus -> zero exit, no mutation reported", () => {
  const dir = copyFixture("clean");
  try {
    const before = readFileSync(join(dir, "a.yaml"), "utf8");
    const result = runMutate(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /OK -- no drift, nothing to mutate/);
    assert.equal(readFileSync(join(dir, "a.yaml"), "utf8"), before, "a clean corpus must not be rewritten at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Injector integration: a quarantined entry is ABSENT from a rendered prompt (acceptance §2) ──

test("end to end: quarantining a real entry via the mutator makes it disappear from selectLearnings, then restoring brings it back", async () => {
  const dir = copyFixture("mixed");
  try {
    const { selectLearnings, loadLearningsCorpus } = await import("../src/lib/learnings.js");
    const before = selectLearnings(loadLearningsCorpus(dir), ["fixture.ts"]).selected.map((e) => e.id);
    // Before the mutator runs, the injector only ever reads the COMMITTED lifecycle -- it never
    // executes an assertion itself -- so a not-yet-quarantined "active" entry is still selected
    // even though its assertion would fail, and a still-"quarantined" entry is not yet selected
    // even though its assertion would now pass.
    assert.ok(before.includes("fixture-active-passing"), "the passing entry starts selected");
    assert.ok(before.includes("fixture-active-failing"), "still lifecycle: active pre-mutation, so still selected");
    assert.ok(!before.includes("fixture-quarantined-now-passing"), "still lifecycle: quarantined pre-mutation, so not yet selected");

    runMutate(dir);
    const after = selectLearnings(loadLearningsCorpus(dir), ["fixture.ts"]).selected.map((e) => e.id);
    assert.ok(!after.includes("fixture-active-failing"), "the auto-quarantined entry must be ABSENT from the rendered selection, even though files: matches");
    assert.ok(after.includes("fixture-quarantined-now-passing"), "the auto-restored entry must be back in the rendered selection");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The real learnings/ corpus: currently clean (this is what CI checks on every PR via `npm test`) ──

test("the REAL committed learnings/ corpus has ZERO drift between its committed lifecycle and a fresh assertion re-verification", () => {
  const result = runCheck(join(REPO_ROOT, "learnings"));
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
});

test("the real corpus carries at least one seeded self-verifying entry (shell-isolation, W1-T34)", () => {
  const raw = readFileSync(join(REPO_ROOT, "learnings", "platform.yaml"), "utf8");
  assert.match(raw, /- id: shell-isolation[\s\S]*?assertion: /);
});
