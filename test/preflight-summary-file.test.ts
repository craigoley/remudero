import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildPreflightSummary, preflightSummaryPath, type CiParityStepResult } from "../src/lib/ci-parity.js";
import { preflightCommand, readHeadShaForSummary } from "../src/run-task.js";

/**
 * A PREFLIGHT RESULT MUST SURVIVE THE CONTAINER THAT PRODUCED IT.
 *
 * MEASURED twice in one day: an operator ran `preflight --ci-parity` in a container, watched it
 * reach test 5,371 of ~5,600, and lost the result — the container was removed before the summary
 * was read. Eight minutes of measurement whose only artifact was a terminal buffer.
 *
 * BOTH DIRECTIONS, and the FAILING one is the load-bearing case. A summary written only on success
 * would be worse than useless: the run you most need a record of is the one that failed, and a
 * "writes a summary" test that only ever drives a passing run would pass on exactly that bug. So
 * the two `preflightCommand` tests below are the same fixture with the verdict flipped.
 */

function fakeSpawn(failing: Set<string>) {
  // Every step's shell-out answers 0 unless its command names something in `failing`. `runPreflight`
  // and `runCiParity` between them shell commitlint, tsc, git and npm; answering uniformly keeps
  // this about the SUMMARY rather than about any one step's semantics.
  return (file: string, args: string[]) => {
    const key = [file, ...args].join(" ");
    const bad = [...failing].some((f) => key.includes(f));
    return { status: bad ? 1 : 0, stdout: bad ? "boom" : "", stderr: "" };
  };
}

test("buildPreflightSummary counts both directions and never branches on ok", () => {
  const steps: CiParityStepResult[] = [
    { name: "a", ok: true, detail: "a: PASS" },
    { name: "b", ok: false, detail: "b: FAIL" },
    { name: "c", ok: true, detail: "c: PASS" },
  ];
  const s = buildPreflightSummary({ steps, finishedAt: "2026-08-09T00:00:00.000Z", durationMs: 1234, headSha: "abc", args: ["--ci-parity"] });
  assert.equal(s.ok, false, "one failing step makes the run not ok");
  assert.equal(s.passed, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.headSha, "abc");
  assert.deepEqual(s.args, ["--ci-parity"], "the summary names the run that produced it");
  assert.equal(s.steps.length, 3, "every step is kept, not just the failures");

  const allGreen = buildPreflightSummary({ steps: steps.map((x) => ({ ...x, ok: true })), finishedAt: "t", durationMs: 1, headSha: "z", args: [] });
  assert.equal(allGreen.ok, true);
  assert.equal(allGreen.failed, 0);
});

test("preflightSummaryPath lands under coverage/, the path that already persists on this route", () => {
  // `coverage/` is where the coverage-ratchet step already writes lcov.info, it is gitignored, and
  // in a container the checkout lives under the mounted state volume — so this outlives docker rm
  // with no new mount and no new flag.
  assert.equal(preflightSummaryPath("/srv/tree"), join("/srv/tree", "coverage", "preflight-summary.json"));
});

test("a PASSING preflight writes the summary file", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "rmd-preflight-sum-")), "summary.json");
  const logs: string[] = [];
  const restore = console.log;
  console.log = (m?: unknown) => logs.push(String(m));
  let code: number;
  try {
    code = await preflightCommand(["--summary-file", out], { spawn: fakeSpawn(new Set()) as never });
  } finally {
    console.log = restore;
  }
  assert.equal(code, 0, "the fixture must actually reach a passing verdict");
  assert.ok(existsSync(out), "a passing run must still leave a durable record");
  const s = JSON.parse(readFileSync(out, "utf8")) as { ok: boolean; failed: number; steps: unknown[] };
  assert.equal(s.ok, true);
  assert.equal(s.failed, 0);
  assert.ok(s.steps.length > 0, "the summary must carry the steps, not just a boolean");
  assert.ok(logs.some((l) => l.includes("summary written:") && l.includes(out)), "and the path must be printed so the operator can find it");
});

test("a FAILING preflight writes the summary file too — the case most worth keeping", async () => {
  // THE SAME FIXTURE, VERDICT FLIPPED. Without this, a `if (ok) write(...)` regression would pass
  // the test above and lose exactly the runs an operator needs a record of.
  const out = join(mkdtempSync(join(tmpdir(), "rmd-preflight-sum-")), "summary.json");
  const restore = console.log;
  console.log = () => {};
  let code: number;
  try {
    code = await preflightCommand(["--summary-file", out], { spawn: fakeSpawn(new Set(["commitlint"])) as never });
  } finally {
    console.log = restore;
  }
  assert.equal(code, 1, "the fixture must actually reach a FAILING verdict, or this proves nothing");
  assert.ok(existsSync(out), "a FAILING run must leave a durable record — this is the whole point");
  const s = JSON.parse(readFileSync(out, "utf8")) as { ok: boolean; failed: number; steps: { ok: boolean; detail: string }[] };
  assert.equal(s.ok, false);
  assert.ok(s.failed > 0, "the failure count must be non-zero");
  assert.ok(s.steps.some((x) => !x.ok && /FAIL/.test(x.detail)), "and the failing step's own detail must be preserved for reading later");
});

test("readHeadShaForSummary: really shells out, and degrades to unknown when git cannot answer", () => {
  // BOTH ARMS, and the second is why the seam exists. The DEFAULT implementation really runs
  // `git rev-parse HEAD` — a test that only ever injected would leave it unexercised — and the
  // catch arm is unreachable inside a working repo, so a thrower is the only way to reach it.
  const real = readHeadShaForSummary();
  assert.match(real, /^[0-9a-f]{40}$/, "the default must genuinely shell out and return a real sha");

  const degraded = readHeadShaForSummary(() => {
    throw new Error("git: command not found");
  });
  assert.equal(degraded, "unknown", "a host without git must still get a summary, not an exception");

  const blank = readHeadShaForSummary(() => "   \n");
  assert.equal(blank, "unknown", "empty output is not a sha either");
});

test("an unwritable summary path is reported and never changes the exit code", async () => {
  // The verdict belongs to the checks, not to whether a file could be written. A preflight that
  // passed must not start failing because a directory was read-only.
  // A regular FILE used as a directory component, so `mkdirSync(dirname(...))` fails ENOTDIR
  // immediately and deterministically. (An earlier draft used a path under /proc and HUNG the
  // suite rather than failing — a reminder that "obviously unwritable" is not the same as
  // "fails fast".)
  const blocker = join(mkdtempSync(join(tmpdir(), "rmd-preflight-sum-")), "not-a-dir");
  writeFileSync(blocker, "");
  const errs: string[] = [];
  const restoreLog = console.log;
  const restoreErr = console.error;
  console.log = () => {};
  console.error = (m?: unknown) => errs.push(String(m));
  let code: number;
  try {
    code = await preflightCommand(["--summary-file", join(blocker, "x.json")], { spawn: fakeSpawn(new Set()) as never });
  } finally {
    console.log = restoreLog;
    console.error = restoreErr;
  }
  assert.equal(code, 0, "a write failure must not turn a passing preflight red");
  assert.ok(errs.some((e) => e.includes("summary NOT written")), "but it must say so rather than failing silently");
});
