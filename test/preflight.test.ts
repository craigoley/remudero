import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkCommitMessage,
  commitlintStep,
  emitterChecksStep,
  runPreflight,
  typecheckStep,
  type PreflightSpawn,
} from "../src/lib/commit-message.js";
import { preflightCommand } from "../src/run-task.js";

// ── W1-T221: the hand route's missing gate ──────────────────────────────────────────
//
// The worker (machine) lane already reaches lib/commit-message.ts's shaping through the
// shared plan-PR emitter. Nothing on the hand/CLI path ever called ANY of it — a "remember
// to run commitlint" memory note is not a gate. These tests prove `rmd preflight` gives
// the hand lane one command that runs commitlint, `tsc --noEmit`, and the emitter's own
// header/body checks as three INDEPENDENT steps, each naming its own pass/fail, before a
// hand-authored push.

function fakeSpawn(map: Record<string, { status: number; stdout?: string; stderr?: string }>): PreflightSpawn {
  return (file, args) => {
    const key = [file, ...args].join(" ");
    for (const [needle, result] of Object.entries(map)) {
      if (key.includes(needle)) {
        return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
    }
    throw new Error(`fakeSpawn: no fixture matched ${key}`);
  };
}

test("a hand-authored commit violating commitlint that reaches push without a LOCAL named failure FAILS", () => {
  const spawn = fakeSpawn({
    commitlint: { status: 1, stdout: "", stderr: "header-max-length" },
    tsc: { status: 0 },
    "git log": { status: 0, stdout: "\0feat(x): fine\n" },
  });
  const result = runPreflight("/repo", { spawn });
  const commitlint = result.steps.find((s) => s.name === "commitlint")!;
  assert.equal(commitlint.ok, false);
  // Named failure — never legible only as a missing success line (fixture 3).
  assert.match(commitlint.detail, /^commitlint: FAIL/);
  assert.match(commitlint.detail, /header-max-length/);
  assert.equal(result.ok, false);
});

test("a hand-authored commit whose sources do not typecheck reaches push without a local named failure FAILS, so a green test suite can no longer stand in for a compile", () => {
  const spawn = fakeSpawn({
    commitlint: { status: 0 },
    tsc: { status: 2, stdout: "src/foo.ts(3,5): error TS2353: Object literal may only specify known properties." },
    "git log": { status: 0, stdout: "\0feat(x): fine\n" },
  });
  const result = runPreflight("/repo", { spawn });
  const typecheck = result.steps.find((s) => s.name === "typecheck")!;
  assert.equal(typecheck.ok, false);
  assert.match(typecheck.detail, /^typecheck: FAIL/);
  assert.match(typecheck.detail, /TS2353/);
  assert.equal(result.ok, false);
});

test("each step reports its own exit independently, so a failing step is named rather than being visible only as a missing success line", () => {
  const spawn = fakeSpawn({
    commitlint: { status: 0 },
    tsc: { status: 0 },
    "git log": { status: 0, stdout: "\0feat(x): fine\n" },
  });
  const result = runPreflight("/repo", { spawn });
  for (const step of result.steps) {
    // Every step names itself in BOTH directions — a pass says what it checked, not just 0.
    assert.match(step.detail, new RegExp(`^${step.name}: (PASS|FAIL)`));
  }
  assert.deepEqual(
    result.steps.map((s) => s.name),
    ["commitlint", "typecheck", "emitter-checks"],
  );
});

test("one step failing does not prevent the remaining steps from running and reporting, so a single run surfaces every problem rather than only the first", () => {
  const spawn = fakeSpawn({
    commitlint: { status: 1, stderr: "header-max-length" },
    tsc: { status: 2, stdout: "error TS2353" },
    "git log": { status: 0, stdout: "\0FIX layer bad case\n" },
  });
  const result = runPreflight("/repo", { spawn });
  assert.equal(result.steps.length, 3, "all three steps must run even though the first two fail");
  assert.ok(result.steps.every((s) => s.detail.length > 0), "every step must still produce a detail line");
  assert.equal(result.steps.filter((s) => !s.ok).length, 3, "all three steps fail on this fixture");
});

test("a step that throws (e.g. the binary is missing) is caught and reported as that step's own failure, never aborting the run", () => {
  const spawn: PreflightSpawn = (file, args) => {
    if (args.some((a) => a.includes("commitlint"))) throw new Error("ENOENT: no such file");
    return { status: 0, stdout: "\0feat(x): fine\n", stderr: "" };
  };
  const result = runPreflight("/repo", { spawn });
  const commitlint = result.steps.find((s) => s.name === "commitlint")!;
  assert.equal(commitlint.ok, false);
  assert.match(commitlint.detail, /ENOENT/);
  // The other two steps still ran and reported despite commitlint's step throwing.
  assert.equal(result.steps.length, 3);
});

test("the header and body checks call lib/commit-message.ts rather than restating its rules, so the hand lane and the emitter lane cannot drift apart", () => {
  // emitterChecksStep must delegate to checkCommitMessage — proved here by giving it a
  // message checkCommitMessage itself flags, and confirming the step surfaces the SAME
  // violation text checkCommitMessage produces (not a re-derived approximation of it).
  const longLine = "x".repeat(101);
  const spawn = fakeSpawn({
    "git log": { status: 0, stdout: `\0feat(x): fine\n\n${longLine}\n` },
  });
  const direct = checkCommitMessage(`feat(x): fine\n\n${longLine}\n`);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].rule, "body-max-line-length");

  const step = emitterChecksStep("/repo", undefined, spawn);
  assert.equal(step.ok, false);
  assert.match(step.detail, /body-max-line-length/);
  assert.match(step.detail, new RegExp(direct[0].message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("checkCommitMessage: a clean Conventional Commits message has no violations", () => {
  assert.deepEqual(checkCommitMessage("feat(preflight): add the hand-route commit gate (W1-T221)\n"), []);
});

test("checkCommitMessage: flags header-max-length, subject-case and body-max-line-length independently", () => {
  const badSubject = `fix(x): ${"A".repeat(95)}`; // header > 100 chars AND upper-case subject
  const violations = checkCommitMessage(`${badSubject}\n\n${"y".repeat(120)}\n`);
  const rules = violations.map((v) => v.rule).sort();
  assert.deepEqual(rules, ["body-max-line-length", "header-max-length", "subject-case"]);
});

test("commitlintStep and typecheckStep each run the real binary + config CI uses (argv shape)", () => {
  let commitlintArgs: string[] | undefined;
  let tscArgs: string[] | undefined;
  const spawn: PreflightSpawn = (file, args) => {
    if (file.includes("commitlint") || args.some((a) => a.includes("commitlint"))) {
      commitlintArgs = args;
      return { status: 0, stdout: "", stderr: "" };
    }
    tscArgs = args;
    return { status: 0, stdout: "", stderr: "" };
  };
  commitlintStep("/repo", { from: "origin/main", to: "HEAD" }, spawn);
  assert.ok(commitlintArgs?.some((a) => a.includes("commitlint.config.mjs")));
  assert.ok(commitlintArgs?.includes("--from"));
  assert.ok(commitlintArgs?.includes("--to"));

  typecheckStep("/repo", spawn);
  assert.ok(tscArgs?.includes("-p"));
  assert.ok(tscArgs?.includes("--noEmit"));
});

test("preflightCommand prints every step's line and exits non-zero on any failure, all via injected deps (no real spawn)", async () => {
  const spawn = fakeSpawn({
    commitlint: { status: 1, stderr: "header-max-length" },
    tsc: { status: 0 },
    "git log": { status: 0, stdout: "\0feat(x): fine\n" },
  });
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  let code: number;
  try {
    code = await preflightCommand([], { spawn });
  } finally {
    console.log = originalLog;
  }
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes("commitlint: FAIL")));
  assert.ok(lines.some((l) => l.includes("typecheck: PASS")));
  assert.ok(lines.some((l) => l.includes("rmd preflight: FAIL")));
});

test("preflightCommand rejects an unknown argument, spawning nothing", async () => {
  const code = await preflightCommand(["--bogus"]);
  assert.equal(code, 2);
});
