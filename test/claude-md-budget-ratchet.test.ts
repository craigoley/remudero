import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// ── W1-T503: CLAUDE.md SIZE AS A CI RATCHET (MASTER-PLAN §8A) ────────────────────────────────────
//
// CLAUDE.md is injected in full into every session on every lane -- until this ratchet it was the
// fleet's largest per-session injectable with no budget at all, while the learnings corpus at a
// fifth its weight already had one (scripts/learnings-budget-ratchet.mjs). Same ratchet shape --
// a byte-size CEILING against scripts/claude-md-budget-baseline.json -- except CLAUDE.md's cap
// carries ZERO headroom over the measured figure at capture: its own charter says every addition
// must be paid for by a fold. Every test below drives the actual CLI
// (scripts/claude-md-budget-ratchet.mjs) as a subprocess against a planted fixture, so the
// assertion is on the real exit code a CI job would see -- the falsifier fixture proves the gate
// is ACTIVE, not merely present.
//
// (scripts/claude-md-budget-ratchet.mjs is a plain .mjs file outside tsconfig's `include`, so it
// is exercised here only via its CLI surface, mirroring test/learnings-budget-ratchet.test.ts's
// convention for its sibling script.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "claude-md-budget-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "claude-md-budget-ratchet");
const SAMPLE = join(FIXTURES, "sample.md");

function run(file: string, baseline: string) {
  return spawnSync(process.execPath, [SCRIPT, "--file", file, "--baseline", join(FIXTURES, baseline)], {
    encoding: "utf8",
  });
}

// ── Basic ceiling behavior: the fixture file is a fixed 172 bytes ────────────────────────────────

test("claude-md-budget-ratchet CLI: file AT the cap -> zero exit (the gate ACCEPTS, acceptance criterion 2)", () => {
  const result = run(SAMPLE, "at-cap-baseline.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /is 172 bytes \(cap 172 bytes\)/);
  assert.match(result.stdout, /OK -- .* is at or under the size budget cap/);
});

test("the claude-md budget failure names the overage in bytes (file OVER the cap -> non-zero exit, acceptance criteria 1 and 3)", () => {
  const result = run(SAMPLE, "over-cap-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /BLOCKED/);
  assert.match(result.stderr, /is 172 bytes > cap 165 bytes \(7 bytes over\)/);
});

test("claude-md-budget-ratchet CLI: baseline with no capBytes at all -> no crash, no false block", () => {
  const result = run(SAMPLE, "no-cap-baseline.json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /cap unset/);
});

test("claude-md-budget-ratchet CLI: a missing target file is rejected, not silently treated as zero bytes", () => {
  const result = run(join(FIXTURES, "does-not-exist.md"), "at-cap-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /claude-md-budget-ratchet:/);
});

// ── W1-T1233: a malformed (present but non-number) capBytes must REFUSE, not silently disarm ────
//
// The pre-fix guard was `typeof baseline.capBytes === "number" && actualBytes > baseline.capBytes`
// -- any non-number short-circuited the `&&`, so no violation was ever pushed and the run reported
// OK while still printing "cap 172 bytes" as its first log line, byte-identical to a run that is
// actually enforcing 172. malformed-cap-baseline.json carries the SAME value as at-cap-baseline.json
// (172) but quoted as a string, isolating the type defect from the value.

test("claude-md-budget-ratchet CLI: a capBytes present but not a number refuses instead of passing (acceptance criterion 1)", () => {
  const result = run(SAMPLE, "malformed-cap-baseline.json");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /claude-md-budget-ratchet:/);
});

test("claude-md-budget-ratchet CLI: the refusal names the field and the value it received (acceptance criterion 2)", () => {
  const result = run(SAMPLE, "malformed-cap-baseline.json");
  assert.match(result.stderr, /'capBytes' must be a number, got "172"/);
});

test("claude-md-budget-ratchet CLI: a malformed capBytes never prints a cap figure it is not enforcing (acceptance criterion 6)", () => {
  const result = run(SAMPLE, "malformed-cap-baseline.json");
  assert.doesNotMatch(result.stdout, /cap \d+ bytes/, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /OK --/, result.stdout + result.stderr);
});

// ── The real committed CLAUDE.md + its committed baseline: currently within budget (what CI checks) ─

test("the REAL committed CLAUDE.md is currently within the recorded size budget cap", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OK -- CLAUDE.md is at or under the size budget cap/);
});

// THE ZERO-HEADROOM INVARIANT WAS RETIRED ON 2026-08-22 AND IS REPLACED, NOT DELETED.
//
// It used to assert `capBytes === measuredBytes`, on the charter's reasoning that every addition
// should be paid for by a fold. That held the file at its own size, so an edit paid a fold tax
// whether or not it had anything left worth folding — CLAUDE.md hit the cap with ONE BYTE of room
// twice on the same day and both lanes spent more effort compressing prose than writing the rule
// they came to write. The operator raised the cap to a round 64 KiB and granted deliberate
// headroom; scripts/claude-md-budget-baseline.json's bumpRationale carries that record.
//
// W1-T1234: `measuredBytes` itself is RETIRED, not just its zero-headroom equality. It was a
// recorded byte count pinned to a file that legitimately changes, so it went stale on every
// CLAUDE.md edit and reddened this gate for a reason no PR caused. The gate already derives the
// real figure fresh on every run (`main()` calls `measureBytes` and compares it to `capBytes` --
// scripts/claude-md-budget-ratchet.mjs never reads a stored measured field), so what replaces the
// old assertion proves the gate itself rather than a stored number: a file over the declared cap
// blocks and names the overage, a file at or under it exits clean, the committed baseline declares
// no measured figure at all, and a measured figure planted back into a baseline changes no
// verdict. The cap stays the DECLARED figure rather than drifting upward silently, and a future
// raise still has to change this constant deliberately and say why in prose.
//
// 2026-08-28: raised 65536 -> 67536 by an operator decision, and THE ROUND-BOUNDARY PROPERTY IS
// GONE ON PURPOSE. 64 KiB was legible, not load-bearing; the increment (+2000) is now the thing
// that was reasoned about, so a later reader must not "restore" a power of two by rounding this
// constant. The prose assertion below tracks the CURRENT raise's date, not the file's whole
// history -- the superseded record lives on in the baseline's priorBumpRationale, which the
// third assertion pins so a raise cannot quietly erase the argument it had to answer.
test("the real baseline pins the DECLARED cap, declares no measured figure, and carries a written reason", () => {
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "claude-md-budget-baseline.json"), "utf8"));
  assert.equal(baseline.capBytes, 67536, `the cap must stay the declared figure: ${JSON.stringify(baseline)}`);
  assert.equal(
    Object.hasOwn(baseline, "measuredBytes"),
    false,
    `the committed baseline must declare no measured figure -- it goes stale on every CLAUDE.md edit and the gate never reads it: ${JSON.stringify(baseline)}`,
  );
  assert.match(
    String(baseline.bumpRationale ?? ""),
    /2026-08-28/,
    "a cap raise must stay on the record in prose — an unexplained number is what this gate exists to prevent",
  );
  assert.match(
    String(baseline.priorBumpRationale ?? ""),
    /2026-08-22/,
    "the superseded raise's reasoning must survive the raise that supersedes it — otherwise the record shows only the argument that won",
  );
});

test("claude-md-budget-ratchet CLI: a measured figure planted back into a baseline changes no verdict (acceptance criterion 4)", () => {
  // Same capBytes as at-cap-baseline.json (172, the fixture's real size), plus a planted
  // measuredBytes that is wildly wrong (1). If anything still read a stored measured field this
  // would either crash or flip the verdict; the gate must derive the byte count fresh from the
  // file and ignore the planted field entirely, so this must behave byte-identically to the plain
  // at-cap fixture above.
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-md-budget-ratchet-planted-"));
  const plantedBaseline = join(tmpDir, "baseline.json");
  writeFileSync(plantedBaseline, JSON.stringify({ capBytes: 172, measuredBytes: 1 }));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--file", SAMPLE, "--baseline", plantedBaseline], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /is 172 bytes \(cap 172 bytes\)/);
    assert.match(result.stdout, /OK -- .* is at or under the size budget cap/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
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
