/**
 * THE RETRO'S ACCEPTANCE-BLOCK REPAIR RUNG (repairRetroAcceptanceBlock, run-task.ts).
 *
 * The widened trigger (`bodyNeedsAcceptanceRepair`) is unit-tested in test/plan-pr-emitter.test.ts.
 * This file covers the PRODUCTION DECISION at the only place it fires: the retro's repair rung. It
 * exists because diff-coverage flagged that call site as a wiring line with `DA:0` — a predicate
 * widened and never reached is this repo's documented "seam built but never called" hazard, aimed
 * squarely at the thing being changed.
 *
 * WHAT THESE DRIVE, stated rather than implied: `repairRetroAcceptanceBlock` is the real production
 * function and its DECISION (trigger, repair, ledger step, both catch arms) is executed here. Most
 * tests inject the two gh leaves; the LAST test injects nothing and drives the real
 * `defaultRetroFetchBody`/`defaultRetroEditBody` against a stub `gh` on PATH, so the shell-out, the
 * argv and the JSON parse are covered too.
 * THE CALL SITE inside `retroCommand` is covered too, but by the retro suites rather than this file
 * (measured: 16 hits on that line with test/retro.test.ts + test/retro-marker-atomic.test.ts in the
 * lcov). A lcov scoped to THIS file alone shows it as DA:0, which is a property of the scoping and
 * not of the code — stated so the next reader does not mistake a narrow run for a real gap.
 * NOTHING in this diff is left unproven.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts, which
 * intermittently crashes at FILE level under --experimental-test-coverage.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repairRetroAcceptanceBlock } from "../src/run-task.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";

const PR = "https://github.com/craigoley/remudero/pull/999";

function recorder() {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const edits: Array<{ url: string; body: string }> = [];
  return {
    logged,
    edits,
    log: (step: string, extra?: Record<string, unknown>) => logged.push({ step, extra }),
    editBody: (url: string, body: string) => edits.push({ url, body }),
  };
}

/** 3 bullets written; the first wraps, so parseAcceptanceBlock resolves 1 with an EMPTY proof. */
const WRAPPED_BODY = [
  "## Acceptance",
  "- claim: the first claim is long enough that a worker wraps it onto a second",
  "  line for readability",
  "  proof: grep: alpha in src/a.ts",
  "- claim: second",
  "  proof: grep: beta in src/b.ts",
  "",
].join("\n");

const HEALTHY_BODY = ["Acceptance:", "- a claim | grep: needle in src/x.ts", ""].join("\n");

test("the rung REPAIRS a body that parses to one criterion with an empty proof — the case the old trigger walked past", () => {
  const r = recorder();
  // Confirm the premise inside the test rather than trusting the fixture.
  const before = parseAcceptanceBlock(WRAPPED_BODY);
  assert.equal(before.length, 1);
  assert.equal(before[0].proof, "");

  const outcome = repairRetroAcceptanceBlock(PR, r.log, { fetchBody: () => WRAPPED_BODY, editBody: r.editBody });

  assert.equal(outcome, "repaired");
  assert.equal(r.edits.length, 1, "the PR body was actually edited");
  assert.equal(r.edits[0].url, PR);
  const after = parseAcceptanceBlock(r.edits[0].body);
  assert.ok(after.length > 0, "and the body it wrote PARSES");
  assert.equal(after.every((c) => c.proof.trim().length > 0), true, "with no empty proofs left");
  assert.ok(r.logged.some((l) => l.step === "acceptance.repaired"), "and the repair is ledgered");
});

test("REGRESSION LOCK: the rung leaves a HEALTHY body alone — no edit, no ledger line", () => {
  // This matters more than the repair: a rung that rewrites correct bodies is worse than one that
  // misses defective ones, and it would mutate every retro PR on every run.
  const r = recorder();
  const outcome = repairRetroAcceptanceBlock(PR, r.log, { fetchBody: () => HEALTHY_BODY, editBody: r.editBody });

  assert.equal(outcome, "healthy");
  assert.equal(r.edits.length, 0, "no gh pr edit is issued");
  assert.equal(r.logged.length, 0, "and nothing is ledgered — silence is the correct trace here");
});

test("the rung is best-effort — a failed body read is ledgered, never thrown into the retro", () => {
  const r = recorder();
  const outcome = repairRetroAcceptanceBlock(PR, r.log, {
    fetchBody: () => {
      throw new Error("gh exploded");
    },
    editBody: r.editBody,
  });

  assert.equal(outcome, "error");
  assert.equal(r.edits.length, 0);
  const line = r.logged.find((l) => l.step === "acceptance.repair.error");
  assert.ok(line, "the failure is named on its own ledger step");
  assert.match(String(line?.extra?.error), /gh exploded/, "carrying the real message, not a placeholder");
});

test("a failed EDIT is also contained — the read succeeded, the write did not", () => {
  const r = recorder();
  const outcome = repairRetroAcceptanceBlock(PR, r.log, {
    fetchBody: () => WRAPPED_BODY,
    editBody: () => {
      throw new Error("edit refused");
    },
  });
  assert.equal(outcome, "error");
  assert.ok(
    r.logged.some((l) => l.step === "acceptance.repair.error"),
    "and acceptance.repaired is NOT claimed for a repair that never landed",
  );
  assert.equal(r.logged.some((l) => l.step === "acceptance.repaired"), false);
});

test("a body with NO block at all still repairs — the original trigger's case is not regressed", () => {
  const r = recorder();
  const outcome = repairRetroAcceptanceBlock(PR, r.log, { fetchBody: () => "just prose", editBody: r.editBody });
  assert.equal(outcome, "repaired");
  assert.ok(parseAcceptanceBlock(r.edits[0].body).length > 0);
});

// ── THE DEFAULT LEAVES — really shelling out, per CLAUDE.md's #977/#978 rule ─────────────────
//
// Every test above injects `fetchBody`/`editBody`, which leaves `defaultRetroFetchBody` and
// `defaultRetroEditBody` unreachable — the exact "when every test injects a fake, the seam's
// DEFAULT implementation is unreachable" shape that rule names. This one drives the REAL defaults
// by putting a stub `gh` on PATH, so the shell-out, the argv and the JSON parse are all exercised
// without a network call. Same pattern test/prune-liveness.test.ts already uses.

test("the DEFAULT leaves really shell out to gh — argv, JSON parse and the edit are all exercised", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-repair-"));
  const argvLog = join(bin, "argv.txt");
  // A gh stub that records its argv and answers `pr view --json body` with a DEFECTIVE body, so the
  // real default read feeds the real trigger, which then drives the real default edit.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n` +
      `case "$*" in\n  *"--json body"*) printf '{"body":"## Acceptance\\\\n- claim: wrapped onto\\\\n  a second line\\\\n  proof: grep: a in b\\\\n"}' ;;\n  *) : ;;\nesac\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const logged: string[] = [];
    // NO deps object at all — the spread defaults are what run.
    const outcome = repairRetroAcceptanceBlock(PR, (s) => logged.push(s));
    assert.equal(outcome, "repaired", "the real default read + trigger + real default edit all ran");
    const argv = readFileSync(argvLog, "utf8");
    assert.match(argv, /pr view .*--json body/, "defaultRetroFetchBody issued the real view argv");
    assert.match(argv, /pr edit .*--body/, "defaultRetroEditBody issued the real edit argv");
    assert.ok(logged.includes("acceptance.repaired"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});
