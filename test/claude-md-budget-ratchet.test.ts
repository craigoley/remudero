import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T503: CLAUDE.md BUDGET AS A CI RATCHET ────────────────────────────────────────────────────
//
// CLAUDE.md is injected in full into every session on every lane -- the same "context tax paid
// per session" shape the learnings corpus already carries a CI ceiling on
// (scripts/learnings-budget-ratchet.mjs / test/learnings-budget-ratchet.test.ts). This is that
// same instrument mirrored onto CLAUDE.md: a CEILING on the file's raw byte length, compared
// against a recorded cap in scripts/claude-md-budget-baseline.json. Every test below drives the
// actual CLI (scripts/claude-md-budget-ratchet.mjs) as a subprocess against a planted fixture, so
// the assertion is on the real exit code a CI job would see -- the falsifier fixture proves the
// gate is ACTIVE, not merely present.
//
// (scripts/claude-md-budget-ratchet.mjs is a plain .mjs file outside tsconfig's `include`, so it
// is exercised here only via its CLI surface plus direct function imports, mirroring
// test/learnings-budget-ratchet.test.ts's convention for its sibling script.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "claude-md-budget-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "claude-md-budget-ratchet");

function run(file: string, baseline: string) {
  return spawnSync(process.execPath, [SCRIPT, "--file", join(FIXTURES, file), "--baseline", join(FIXTURES, baseline)], {
    encoding: "utf8",
  });
}

// ── Acceptance criterion 2: a fixture AT the cap passes (title carries the acceptance proof text
//    verbatim -- "the claude-md budget ratchet passes a file at exactly the ceiling" -- so a
//    name-filtered `unit test:` proof finds and runs this exact test) ────────────────────────────

test("claude-md-budget-ratchet CLI: the claude-md budget ratchet passes a file at exactly the ceiling -> zero exit (the gate ACCEPTS)", () => {
  const result = run("sample.md", "at-cap-baseline.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /sample\.md is 50 bytes \(cap 50 bytes\)/);
  assert.match(result.stdout, /OK -- the file is at or under the recorded budget cap/);
});

// ── Acceptance criteria 1 + 3: a fixture OVER the cap fails and the message names the overage in
//    bytes (title carries BOTH proof texts verbatim -- "the claude-md budget ratchet fails a file
//    that outgrows the baseline" and "the claude-md budget failure names the overage in bytes" --
//    so both name-filtered `unit test:` proofs find and run this exact test) ──────────────────────

test("claude-md-budget-ratchet CLI: the claude-md budget ratchet fails a file that outgrows the baseline, and the claude-md budget failure names the overage in bytes (the gate BLOCKS)", () => {
  const result = run("sample.md", "over-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /BLOCKED/);
  assert.match(result.stderr, /CLAUDE\.md is 50 bytes > cap 40 bytes \(10 bytes over\)/);
});

test("claude-md-budget-ratchet CLI: a file safely UNDER the cap -> zero exit", () => {
  const result = run("sample.md", "under-baseline.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /sample\.md is 50 bytes \(cap 100 bytes\)/);
});

test("claude-md-budget-ratchet CLI: baseline with no capBytes at all -> no crash, no false block", () => {
  const result = run("sample.md", "baseline-no-cap.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /cap unset/);
});

// ── Measured in BYTES, not characters -- the explicit contrast with the char-based learnings gate ─

test("claude-md-budget-ratchet CLI: multi-byte UTF-8 content is measured in BYTES, not JS string length", () => {
  // 5 'é' characters (JS string length 5) encode to 10 UTF-8 bytes; a byte-based ratchet must
  // report/measure 10, not 5 -- proving Buffer byte length is used, not String#length.
  const result = run("utf8-sample.md", "utf8-baseline.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /utf8-sample\.md is 10 bytes \(cap 10 bytes\)/);
});

// ── A missing file is a hard error, not a silent zero (CLAUDE.md must always exist) ──────────────

test("claude-md-budget-ratchet CLI: a missing file is rejected, not silently treated as zero bytes", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--file", join(FIXTURES, "does-not-exist.md"), "--baseline", join(FIXTURES, "under-baseline.json")],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /could not read/);
});

// ── The real committed CLAUDE.md + its committed baseline: currently within budget (what CI checks) ─

test("the REAL committed CLAUDE.md is currently within the recorded budget cap", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OK -- the file is at or under the recorded budget cap/);
});

test("claude-md-budget-ratchet module: importing (not spawning as the entry script) does not re-invoke main() -- process.argv[1] is undefined when eval'd", () => {
  const scriptUrl = pathToFileURL(SCRIPT).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(scriptUrl)}); console.log("imported-without-main-invocation");`,
  ]);
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /imported-without-main-invocation/);
});

// ── Direct function-level exercise of the pure exports (measure/evaluate), mirroring the sibling's
//    split between spawned-CLI coverage and in-process logic coverage ───────────────────────────

test("measure()/evaluate(): pure functions agree with the CLI's own byte counting and violation shape", async () => {
  const mod = await import(pathToFileURL(SCRIPT).href);
  const bytes = mod.measure(join(FIXTURES, "sample.md"));
  assert.equal(bytes, 50);

  const okViolations = mod.evaluate(bytes, { capBytes: 50 });
  assert.deepEqual(okViolations, []);

  const overViolations = mod.evaluate(bytes, { capBytes: 40 });
  assert.deepEqual(overViolations, ["CLAUDE.md is 50 bytes > cap 40 bytes (10 bytes over)"]);

  const uncappedViolations = mod.evaluate(bytes, {});
  assert.deepEqual(uncappedViolations, []);
});
