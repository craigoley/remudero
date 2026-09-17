import assert from "node:assert/strict";
import { test } from "node:test";
import { preflightCommand, preflightSummarySentence, type PreflightTier } from "../src/run-task.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

// ── W1-T3737 — THE LOCAL CI MIRROR IS BUILT, AND THE DEFAULT RAN THREE OF ITS TWENTY CHECKS ───
//
// MEASURED on worktrees cut from origin/main, reproducing the shape that blocked #5928 — one
// comment line added to a file sitting at its recorded ceiling:
//
//   rmd preflight          -> PASS in 12s, "the push may proceed"
//   rmd preflight --fast   -> FAIL in 35s, comment-load-ratchet BLOCKED
//
// On an UNMODIFIED main checkout `--fast` ran twenty checks in 29 seconds with zero false reds, so
// nothing needed building — only the default needed moving. (`--ci-parity` measured 556s with two
// local-environment false reds, which is why it stays opt-in.)
//
// AND THE SENTENCE WAS HAND-WRITTEN BESIDE THE RUN. After those twenty checks it still printed
// "commitlint, typecheck, and emitter checks are all clean" — under-reporting the flagged path and
// over-reporting the default one. Composing it from the steps that ran makes naming fewer checks
// than were performed unreachable, which is what these assertions pin.

const TIERS = (over: Partial<Record<string, boolean>> = {}): PreflightTier[] => [
  { name: "commitlint/typecheck/emitter", enableWith: "always runs", ran: true },
  { name: "the fast gate", enableWith: "drop --no-fast", ran: over.fast ?? true },
  { name: "ci-parity", enableWith: "--ci-parity", ran: over.ciParity ?? false },
  { name: "coverage", enableWith: "--coverage", ran: over.coverage ?? false },
];
const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `step-${i}` }));

test("the summary names every step tier that ran", () => {
  // THE DEFECT, DIRECTLY: twenty steps ran and the sentence named three checks by name. The count
  // now comes from the step list, so it cannot disagree with what was performed.
  const line = preflightSummarySentence(true, steps(20), TIERS());
  assert.match(line, /20 check\(s\) clean/, "the count is the steps that ran, not a written number");
  assert.match(line, /commitlint\/typecheck\/emitter \+ the fast gate/, "both tiers that ran are named");
  assert.doesNotMatch(line, /ci-parity;|coverage;/, "a tier that did not run is never named as having run");

  // And it tracks the steps rather than being a second constant that happens to agree today.
  assert.match(preflightSummarySentence(true, steps(3), TIERS({ fast: false })), /3 check\(s\) clean/);
});

test("the passing summary names its mirrored coverage", () => {
  // A green that does not say what it SKIPPED gets read as "CI will pass", and it never meant that.
  const line = preflightSummarySentence(true, steps(20), TIERS());
  assert.match(line, /not checked here: ci-parity \(--ci-parity\), coverage \(--coverage\)/);
  assert.match(line, /CI runs more than this run did/);

  // Each skipped tier says how to RUN it — a list of things that did not run is useless otherwise.
  const noFast = preflightSummarySentence(true, steps(3), TIERS({ fast: false }));
  assert.match(noFast, /the fast gate \(drop --no-fast\)/);

  // Nothing is skipped ⇒ no such line at all, rather than an empty one.
  const everything = preflightSummarySentence(true, steps(40), TIERS({ ciParity: true, coverage: true }));
  assert.doesNotMatch(everything, /not checked here/);

  // A FAIL says nothing about coverage — the reader has a named failing step to act on.
  const failed = preflightSummarySentence(false, steps(20), TIERS());
  assert.match(failed, /^### rmd preflight: FAIL/);
  assert.doesNotMatch(failed, /not checked here/);
});

/** Drives the real command with a recording spawn and returns every command line it attempted. */
async function runPreflightCommand(argv: string[]): Promise<{ code: number; ran: string[]; lines: string[] }> {
  const ran: string[] = [];
  const spawn: PreflightSpawn = (file, args) => {
    ran.push([file, ...args].join(" "));
    return { status: 0, stdout: "\0feat(x): fine\n", stderr: "" };
  };
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const code = await preflightCommand(argv, { spawn });
    return { code, ran, lines };
  } finally {
    console.log = originalLog;
  }
}

test("the default preflight run includes the fast gate steps", async () => {
  // THE WHOLE TASK. Before this, a builder typing the documented command got three checks and
  // "the push may proceed"; the twenty that refuse most pull requests were behind a flag nobody
  // passed — including me, four times in one session, on comment-load alone.
  const plain = await runPreflightCommand([]);
  assert.ok(
    plain.ran.some((c) => c.includes("comment-load-signal")),
    "the fast gate must run without being asked for",
  );
  assert.ok(plain.lines.some((l) => l.includes("comment-load-ratchet")), "and it must print");

  // `--fast` stays accepted and is now a no-op, so every existing call site and worker prompt that
  // passes it behaves identically rather than erroring on an unknown flag.
  const flagged = await runPreflightCommand(["--fast"]);
  assert.equal(flagged.code, plain.code);
  assert.deepEqual(flagged.ran, plain.ran, "--fast must be a no-op, not a second behaviour");
});

test("--no-fast returns the previous three-step run", async () => {
  // A bound with no escape is a wall: an operator on a slow host must still be able to push.
  const declined = await runPreflightCommand(["--no-fast"]);
  assert.ok(!declined.ran.some((c) => c.includes("comment-load-signal")), "the fast gate is genuinely skipped");
  assert.ok(declined.lines.some((l) => l.includes("3 check(s) clean")), "and the run is the old three-step one");

  // THE CONTROL, and why this discriminates rather than passing on any tree: "the fast gate did
  // not run" is also true of a build that never runs it at all. The default must differ.
  const byDefault = await runPreflightCommand([]);
  assert.notDeepEqual(declined.ran, byDefault.ran, "--no-fast must differ from the default, or it opts out of nothing");
});
