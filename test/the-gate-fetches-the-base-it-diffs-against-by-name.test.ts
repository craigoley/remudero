import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearPinnedBaseForTest,
  computeRunContext,
  detectRunContext,
  peekPinnedBase,
  pinnedBase,
  runContextLine,
  runPreflightCoverage,
} from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

/**
 * W1-T3017 — THE GATE FETCHED THE BASE AND THEN DIFFED AGAINST IT BY NAME.
 *
 * `refreshOriginMain` is memoized, so the FETCH happens once per run. That pins nothing where it
 * matters: refs are CLONE-scoped, so a sibling worktree's fetch moves `origin/main` for every
 * process sharing the clone, mid-run, and every diff site re-read that moving name. What moves is
 * what counts as an ADDED line, so `diff-coverage` gains or loses lines it must cover and the red
 * names the author's own file.
 *
 * The discriminator these tests are built on: a spawn recorder whose `rev-parse` answer CHANGES
 * between calls. Against the fixed code every diff argv carries the FIRST sha; against the old
 * code they carried the ref name and would have followed the move. A fixture whose base never
 * moves could not tell the two apart.
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

interface Call {
  file: string;
  args: string[];
}

/** A spawn whose `rev-parse origin/main` answer MOVES after the first call — a sibling fetching
 *  mid-run. Every other command succeeds emptily; the point is the recorded argv, not the output. */
function movingBaseSpawn(opts: { revParseStatus?: number; revParseStdout?: string[] } = {}): {
  spawn: PreflightSpawn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const answers = opts.revParseStdout ?? [SHA_A, SHA_B, SHA_B];
  let revParseCount = 0;
  const spawn: PreflightSpawn = (file, args, _o) => {
    calls.push({ file, args: [...args] });
    if (file === "git" && args[0] === "rev-parse") {
      const out = answers[Math.min(revParseCount, answers.length - 1)] ?? "";
      revParseCount += 1;
      return { status: opts.revParseStatus ?? 0, stdout: `${out}\n`, stderr: "" } as ReturnType<PreflightSpawn>;
    }
    return { status: 0, stdout: "", stderr: "" } as ReturnType<PreflightSpawn>;
  };
  return { spawn, calls };
}

test("pinnedBase resolves origin/main to a sha ONCE and reuses it, so a base that moves mid-run cannot be adopted", () => {
  const { spawn, calls } = movingBaseSpawn();
  clearPinnedBaseForTest(spawn, "/repo");

  const first = pinnedBase("/repo", spawn);
  const second = pinnedBase("/repo", spawn);

  assert.deepEqual(first, { sha: SHA_A });
  assert.deepEqual(second, { sha: SHA_A }, "the second read must return the FIRST sha, not the moved one");
  const revParses = calls.filter((c) => c.file === "git" && c.args[0] === "rev-parse");
  assert.equal(revParses.length, 1, "the base is resolved exactly once per (spawn, repoRoot)");
});

test("pinnedBase is keyed per repoRoot, so two checkouts in one process do not share a base", () => {
  const { spawn } = movingBaseSpawn();
  clearPinnedBaseForTest(spawn, "/repo-one");
  clearPinnedBaseForTest(spawn, "/repo-two");

  assert.deepEqual(pinnedBase("/repo-one", spawn), { sha: SHA_A });
  assert.deepEqual(pinnedBase("/repo-two", spawn), { sha: SHA_B }, "a different root resolves its own base");
  assert.deepEqual(pinnedBase("/repo-one", spawn), { sha: SHA_A }, "and the first root keeps its own");
});

test("a failed rev-parse REFUSES and never falls back to the moving ref name", () => {
  const { spawn } = movingBaseSpawn({ revParseStatus: 128, revParseStdout: [""] });
  clearPinnedBaseForTest(spawn, "/repo");

  const pin = pinnedBase("/repo", spawn);

  assert.ok("failure" in pin, "a failed resolve must not produce a sha");
  assert.doesNotMatch(
    (pin as { failure: string }).failure,
    /^origin\/main$/,
    "the failure must not BE the ref name — that was the silent fallback this task removes",
  );
  assert.match((pin as { failure: string }).failure, /origin\/main/, "and it must still name what it could not resolve");
});

test("a rev-parse that exits 0 with output that is not a sha REFUSES too, so an empty stdout is not read as a base", () => {
  const { spawn } = movingBaseSpawn({ revParseStatus: 0, revParseStdout: [""] });
  clearPinnedBaseForTest(spawn, "/repo");

  const pin = pinnedBase("/repo", spawn);

  assert.ok("failure" in pin, "`stdout.trim() || 'origin/main'` read this exact case as the ref name");
});

test("peekPinnedBase reports ABSENT rather than resolving, so a run that pinned no base cannot claim one", () => {
  const { spawn, calls } = movingBaseSpawn();
  clearPinnedBaseForTest(spawn, "/repo");

  assert.equal(peekPinnedBase("/repo", spawn), undefined, "nothing pinned yet");
  assert.equal(
    calls.filter((c) => c.args[0] === "rev-parse").length,
    0,
    "peeking must spawn nothing — a peek that resolved would be the guess this forbids",
  );

  pinnedBase("/repo", spawn);
  assert.deepEqual(peekPinnedBase("/repo", spawn), { sha: SHA_A }, "and it reports the pin once one is taken");
});

test("the run context carries the pinned base sha and the verdict line prints it beside behind=", () => {
  const ctx = computeRunContext({
    headSha: "f".repeat(40),
    behindText: "11\n",
    reflogText: "origin/main@{2026-09-07T10:00:00+00:00}",
    loadavgStart: [0.5, 0.5, 0.5],
    loadavgEnd: [0.5, 0.5, 0.5],
    cpuCount: 4,
    baseSha: SHA_A,
  });

  assert.equal(ctx.baseSha, SHA_A);
  const line = runContextLine(ctx);
  assert.match(line, /behind=11/);
  assert.match(line, new RegExp(SHA_A.slice(0, 12)), "the sha is what makes a verdict reproducible; behind= alone is not");
});

test("with no base pinned the context omits the sha rather than guessing one", () => {
  const ctx = computeRunContext({
    headSha: "f".repeat(40),
    behindText: "0\n",
    reflogText: undefined,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
  });

  assert.equal(ctx.baseSha, undefined);
  assert.doesNotMatch(runContextLine(ctx), /base=/, "an unpinned run must not print a base it never took");
});

test("a base moved by another process mid-run is reported on the context line and fails NO step", () => {
  const ctx = computeRunContext({
    headSha: "f".repeat(40),
    behindText: "11\n",
    reflogText: undefined,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
    baseSha: SHA_A,
    baseShaAtEnd: SHA_B,
  });

  assert.equal(ctx.baseMovedDuringRun, true);
  const line = runContextLine(ctx);
  assert.match(line, /moved/i, "drift is information about the run's conditions, so it lands on the line");
  assert.match(line, new RegExp(SHA_B.slice(0, 12)), "and names what it moved to");
});

test("a base that did not move is NOT reported as drift, so the signal separates a real population", () => {
  const ctx = computeRunContext({
    headSha: "f".repeat(40),
    behindText: "0\n",
    reflogText: undefined,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
    baseSha: SHA_A,
    baseShaAtEnd: SHA_A,
  });

  assert.equal(ctx.baseMovedDuringRun, false);
  assert.doesNotMatch(runContextLine(ctx), /moved/i);
});

test("runPreflightCoverage REFUSES with a named step when the base cannot be pinned — it never throws out of the pipeline", () => {
  // Everything after the base-refresh in that pipeline runs OUTSIDE `runStep`, so a bare throw
  // escapes the function and crashes `preflightCommand` instead of reporting. Caught only because
  // a caller suite exercised the real command; the first implementation of this task threw here.
  const spawn: PreflightSpawn = (file, args) => {
    if (file === "git" && args[0] === "rev-parse") return { status: 128, stdout: "", stderr: "no such ref" } as ReturnType<PreflightSpawn>;
    return { status: 0, stdout: "", stderr: "" } as ReturnType<PreflightSpawn>;
  };
  clearPinnedBaseForTest(spawn);

  const result = runPreflightCoverage("/repo", { spawn });

  assert.equal(result.ok, false);
  const refusal = result.steps.find((s) => s.name === "coverage-mode:base-pin");
  assert.ok(refusal, "expected a named refusal step, not an escaped throw");
  assert.equal(refusal!.ok, false);
  assert.match(refusal!.detail, /REFUSED/);
  assert.doesNotMatch(
    refusal!.detail,
    /diffing against origin\/main/,
    "and it must not announce a fallback it does not perform",
  );
});

test("detectRunContext reads the END-of-run ref ONLY when a base was pinned, and still never fetches", () => {
  // The drift comparison needs a second read, and the seam it lives in is documented NEVER FETCHES.
  // A local `rev-parse` is not a fetch — this pins that distinction rather than trusting the prose.
  const seen: string[][] = [];
  const spawn: PreflightSpawn = (file, args) => {
    seen.push([file, ...args]);
    const key = args.join(" ");
    if (key.includes("rev-list")) return { status: 0, stdout: "3\n", stderr: "" } as ReturnType<PreflightSpawn>;
    if (key.includes("rev-parse")) return { status: 0, stdout: `${SHA_B}\n`, stderr: "" } as ReturnType<PreflightSpawn>;
    return { status: 0, stdout: "", stderr: "" } as ReturnType<PreflightSpawn>;
  };

  const pinned = detectRunContext({
    repoRoot: "/repo",
    headSha: "f".repeat(40),
    spawn,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
    baseSha: SHA_A,
  });
  assert.equal(pinned.baseSha, SHA_A);
  assert.equal(pinned.baseMovedDuringRun, true, "the ref answers SHA_B while the run pinned SHA_A");
  assert.ok(
    !seen.some((argv) => argv.includes("fetch")),
    `detectRunContext must never fetch; saw ${JSON.stringify(seen)}`,
  );

  seen.length = 0;
  const unpinned = detectRunContext({
    repoRoot: "/repo",
    headSha: "f".repeat(40),
    spawn,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
  });
  assert.equal(unpinned.baseSha, undefined);
  assert.equal(unpinned.baseMovedDuringRun, undefined, "no pin means no comparison, so no answer — not `false`");
  assert.ok(
    !seen.some((argv) => argv.includes("rev-parse")),
    "with nothing pinned there is nothing to compare, so the extra read must not happen at all",
  );
});
