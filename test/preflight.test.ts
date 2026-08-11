import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkCommitMessage,
  commitlintStep,
  defaultPreflightSpawn,
  emitterChecksStep,
  runPreflight,
  typecheckStep,
  type PreflightSpawn,
} from "../src/lib/commit-message.js";
import { main, preflightCommand } from "../src/run-task.js";

/** Sentinel thrown by the mocked `process.exit` so main()'s flat if-ladder cannot run on
 *  past the verb under test — the same shape test/w1-t143-diff-coverage.test.ts uses,
 *  duplicated locally per this suite's file-scoping convention. */
class ProcessExitCalled extends Error {
  constructor(readonly code?: number) {
    super(`process.exit(${code})`);
  }
}

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

// ── The three lines the injected-spawn tests above structurally cannot reach ──────────
//
//    Every test above supplies its own `PreflightSpawn`, which is the right shape for
//    proving the DECISION logic — but it means the real spawn leaf never runs, and the
//    per-step `catch` arms are only exercised for whichever step the fixture chose to
//    throw from. A preflight whose leaf silently returned the wrong thing, or whose
//    typecheck/emitter step aborted the run instead of reporting, would pass everything
//    above. These four close that gap.

test("defaultPreflightSpawn really shells out — status, stdout and stderr come back from the child, and stdin is piped", () => {
  const ok = defaultPreflightSpawn("echo", ["preflight-leaf"]);
  assert.equal(ok.status, 0, "a clean command exits 0");
  assert.equal(ok.stdout.trim(), "preflight-leaf", "stdout is returned, not swallowed");

  // A NONZERO exit must come back as a status rather than a throw — every step branches on
  // `res.status === 0`, so a leaf that threw here would turn each ordinary check failure
  // into the catch arm's "FAIL — <error>" and lose the tool's own output.
  const bad = defaultPreflightSpawn("sh", ["-c", "echo to-stderr 1>&2; exit 3"]);
  assert.equal(bad.status, 3, "a nonzero exit is reported as a status, never thrown");
  assert.match(bad.stderr, /to-stderr/, "stderr is captured too — a failing step's detail line quotes it");

  // `input` must reach the child: readRangeCommitMessages pipes through this same leaf.
  assert.equal(defaultPreflightSpawn("cat", [], { input: "piped-in" }).stdout, "piped-in", "opts.input is written to the child's stdin");
});

test("defaultPreflightSpawn: a child writing MORE than the OLD 1MB spawnSync default to stdout still returns its true exit status and complete output (W1-T338 — the ci:test ENOBUFS this fix closes)", () => {
  // `test:ci`'s own TAP output is ~1.7MB; this drives the REAL spawnSync leaf (no injected
  // PreflightSpawn) past the OLD 1.0MB default so a dropped `maxBuffer` fails this test rather
  // than merely a note. 1.5MB is comfortably past the old ceiling and comfortably under the new
  // one, so this doubles as the regression lock for that ceiling.
  const byteCount = 1.5 * 1024 * 1024;
  // `process.exit()` right after a large `write()` to a piped stdout can race the async flush
  // and truncate the very output this test means to prove survives intact — exiting from the
  // write's own callback (fired once the data is actually flushed) avoids that race.
  const script = `process.stdout.write("x".repeat(${byteCount}), () => process.exit(0));`;
  const res = defaultPreflightSpawn(process.execPath, ["-e", script]);
  assert.equal(res.status, 0, "a child that exits 0 after writing past the old 1MB default must report status 0, never null (ENOBUFS)");
  assert.equal(res.stdout.length, byteCount, "the full output must come back — not truncated, not swallowed");
});

test("typecheckStep catches a throwing spawn and reports its OWN failure rather than aborting the run", () => {
  const spawn: PreflightSpawn = () => {
    throw new Error("EACCES: tsc is not executable");
  };
  const step = typecheckStep("/repo", spawn);
  assert.equal(step.name, "typecheck");
  assert.equal(step.ok, false, "an unrunnable typechecker is a FAILED step, never a silently passed one");
  assert.match(step.detail, /EACCES/, "the step names why it could not run");
});

test("emitterChecksStep catches a throwing git log and reports its OWN failure rather than aborting the run", () => {
  const spawn: PreflightSpawn = () => {
    throw new Error("fatal: bad revision origin/main");
  };
  const step = emitterChecksStep("/repo", { from: "origin/main", to: "HEAD" }, spawn);
  assert.equal(step.name, "emitter-checks");
  assert.equal(step.ok, false, "a range git cannot read is a FAILED step — never an empty range read as clean");
  assert.match(step.detail, /bad revision/, "the step names why it could not run");
});

test("main() dispatches `rmd preflight` to preflightCommand — the CLI wiring, driven with a bad flag so nothing spawns", async (t) => {
  const exitMock = ((code?: number): never => {
    throw new ProcessExitCalled(code);
  }) as typeof process.exit;
  t.mock.method(process, "exit", exitMock);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const originalArgv = process.argv;
  const originalGuard = process.env.RMD_SELF_SYNC_DONE;
  process.argv = ["node", "run-task.js", "preflight", "--bogus"];
  process.env.RMD_SELF_SYNC_DONE = "1";
  try {
    let caught: unknown;
    await main().catch((e) => {
      caught = e;
    });
    assert.ok(caught instanceof ProcessExitCalled, `main() must reach process.exit, not some other throw: ${String(caught)}`);
    assert.equal((caught as ProcessExitCalled).code, 2, "an unknown flag exits 2 — reached through the verb dispatch, before any spawn");
  } finally {
    process.argv = originalArgv;
    if (originalGuard === undefined) delete process.env.RMD_SELF_SYNC_DONE;
    else process.env.RMD_SELF_SYNC_DONE = originalGuard;
  }
});

// ── W1-T??? (the spawn-vs-lint distinction): a child that NEVER STARTED is not a verdict ──────
//
// These live HERE, alongside the other step-reporting tests, and NOT only in
// test/preflight-spawn-failure.test.ts, for a measured reason. Under the FULL suite with
// `--experimental-test-coverage`, the coverage record contributed by that dedicated file did not
// land: two consecutive full-glob runs reported `commitlintStep`'s own pre-existing lines as
// `DA:...,0` — in the first run the ENTIRE function read zero, including `try {` and `const bin` —
// while a scoped run of the same tests showed 12-51 hits on the same lines. That is the
// file-level-record-loss class CLAUDE.md already records for test/run-task.test.ts, and it made
// diff-coverage block on added lines that a passing, asserting test demonstrably executes.
// This suite's record does land, so the load-bearing assertions are duplicated here deliberately.
// The dedicated file keeps the full behavioural set and the falsifier.

test("commitlint: a child that never produced an exit status is reported as a SPAWN FAILURE, not a lint verdict", () => {
  const spawn: PreflightSpawn = () => ({ status: null, stdout: "", stderr: "", error: "spawnSync ENOENT" });
  const r = commitlintStep("/repo", { from: "origin/main", to: "HEAD" }, spawn);
  assert.equal(r.ok, false);
  assert.match(r.detail, /SPAWN FAILURE/);
  assert.match(r.detail, /ENOENT/);
  assert.match(r.detail, /did NOT run/);
});

test("commitlint: a GENUINE violation is still reported verbatim, so the spawn guard removes no detection", () => {
  const spawn: PreflightSpawn = () => ({
    status: 1,
    stdout: "✖   header must not be longer than 100 characters, current length is 106 [header-max-length]",
    stderr: "",
  });
  const r = commitlintStep("/repo", { from: "origin/main", to: "HEAD" }, spawn);
  assert.equal(r.ok, false);
  assert.match(r.detail, /header-max-length/);
  assert.doesNotMatch(r.detail, /SPAWN FAILURE/);
});

test("typecheck: a child that never started is a SPAWN FAILURE, while a real tsc diagnostic still reports itself", () => {
  const dead: PreflightSpawn = () => ({ status: null, stdout: "", stderr: "", error: "spawnSync EACCES" });
  assert.match(typecheckStep("/repo", dead).detail, /SPAWN FAILURE — spawnSync EACCES/);
  const real: PreflightSpawn = () => ({ status: 1, stdout: "src/x.ts(1,1): error TS2304: Cannot find name 'foo'.", stderr: "" });
  const r = typecheckStep("/repo", real);
  assert.match(r.detail, /TS2304/);
  assert.doesNotMatch(r.detail, /SPAWN FAILURE/);
});

test("emitter-checks: a git log that never ran FAILS instead of passing over zero messages", () => {
  const dead: PreflightSpawn = () => ({ status: null, stdout: "", stderr: "", error: "spawnSync git ENOENT" });
  const r = emitterChecksStep("/repo", { from: "origin/main", to: "HEAD" }, dead);
  assert.equal(r.ok, false, "an unrun check must never report PASS over an empty set");
  assert.match(r.detail, /SPAWN FAILURE/);
  assert.doesNotMatch(r.detail, /0 commit message\(s\)/);
});
