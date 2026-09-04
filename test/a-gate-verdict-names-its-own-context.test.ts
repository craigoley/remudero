// W1-T2810 — a gate verdict names its own context.
//
// THE DEFECT this file pins: `rmd preflight` printed PASS or FAIL and named neither the tree it
// measured nor the conditions it measured under. The sharpest form of it is that `headSha` was
// ALREADY computed on that path and already written to `coverage/preflight-summary.json`, and
// never reached the sentence a human reads — so a green from a 465-commit-behind checkout and a
// green from head were the same sentence (CLAUDE.md hazard (h), which measured exactly that:
// `60965 bytes (cap 61046) OK`, exit 0, both operands stale).
//
// Every predicate under test is PURE except `detectRunContext`, whose two impure reads are driven
// through the injectable `PreflightSpawn` seam this module already uses — so nothing here needs a
// git tree, a network, or a busy machine.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeRunContext,
  detectRunContext,
  isLoadedRun,
  LOADED_RUN_THRESHOLD,
  normalisedLoad,
  parseReflogFetchStamp,
  runContextLine,
  buildPreflightSummary,
  type RunContext,
} from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { preflightCommand } from "../src/run-task.js";

/** A spawn recorder: returns a canned result per argv, and records what was asked for. */
function spawnStub(
  table: Array<{ match: string; status: number; stdout?: string }>,
  seen: string[][] = [],
): { spawn: PreflightSpawn; seen: string[][] } {
  const spawn: PreflightSpawn = (_file, args) => {
    seen.push(args);
    const row = table.find((r) => args.join(" ").includes(r.match));
    return row
      ? { status: row.status, stdout: row.stdout ?? "", stderr: "" }
      : { status: 1, stdout: "", stderr: "no stub" };
  };
  return { spawn, seen };
}

const CTX = (over: Partial<RunContext> = {}): RunContext => ({
  headSha: "abc1234",
  behindCount: 0,
  behindUnknownReason: undefined,
  originFetchedAt: "2026-09-04T13:13:13+00:00",
  loadStart: 0.1,
  loadEnd: 0.2,
  cpuCount: 4,
  ...over,
});

// ── WHICH TREE: the behind-count, all three cases ────────────────────────────────────────────
//
// The falsifier the brief names has two directions — behind prints non-zero, current prints 0.
// There is a THIRD, and it is the one a two-case falsifier misses: a read that could not happen
// at all. Rendering that as 0 would recreate hazard (h) wearing this feature's own fix, because 0
// is the single value that means "you are up to date". So: unknown never zero.

test("W1-T2810: a behind checkout prints a NON-ZERO behind-count, and a current one prints 0", () => {
  const behind = computeRunContext({
    headSha: "abc1234",
    behindText: "465\n",
    reflogText: undefined,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
  });
  assert.equal(behind.behindCount, 465);
  assert.match(runContextLine(behind), /behind=465/);

  const current = computeRunContext({
    headSha: "abc1234",
    behindText: "0\n",
    reflogText: undefined,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
  });
  assert.equal(current.behindCount, 0);
  assert.match(runContextLine(current), /behind=0/);
});

test("W1-T2810: an uncomputable behind-count is a NAMED unknown, never zero — unknown never zero, because 0 is the one value that means up to date", () => {
  for (const behindText of [undefined, "", "   ", "fatal: ambiguous argument"]) {
    const ctx = computeRunContext({
      headSha: "abc1234",
      behindText,
      reflogText: undefined,
      loadavgStart: undefined,
      loadavgEnd: undefined,
      cpuCount: 4,
    });
    assert.equal(ctx.behindCount, undefined, `behindText ${JSON.stringify(behindText)} must not parse`);
    assert.ok(ctx.behindUnknownReason, "an unknown must carry its reason");
    const line = runContextLine(ctx);
    assert.match(line, /behind=unknown/);
    assert.doesNotMatch(line, /behind=0/, "an unreadable comparison must never render as up-to-date");
  }
});

// ── WHICH TREE: the ref's own staleness ──────────────────────────────────────────────────────
//
// A behind-count computed against a stale local ref is itself stale, so reporting the number
// alone reproduces this task's own defect one level down. The age comes from the reflog's FETCH
// events — fetch age not commit date — because the two differ by construction: measured in this
// repo, `origin/main` was fetched at 13:13:13Z while its tip commit's own date was 13:10:19Z, and
// on a checkout last fetched days ago the tip date still reads recent, since it tracks whatever
// main last did rather than when this checkout last learned anything.

test("W1-T2810: the ref age is parsed from the reflog selector — fetch age not commit date", () => {
  assert.equal(
    parseReflogFetchStamp("origin/main@{2026-09-04T13:13:13+00:00}"),
    "2026-09-04T13:13:13+00:00",
  );
  // Degrades to undefined rather than a guessed timestamp, on every shape that is not a selector.
  assert.equal(parseReflogFetchStamp(undefined), undefined);
  assert.equal(parseReflogFetchStamp(""), undefined);
  assert.equal(parseReflogFetchStamp("fatal: ambiguous argument 'origin/main'"), undefined);
  assert.match(runContextLine(CTX()), /origin\/main fetched 2026-09-04T13:13:13\+00:00/);
  assert.match(runContextLine(CTX({ originFetchedAt: undefined })), /origin\/main fetch age unknown/);
});

// ── UNDER WHAT CONDITIONS: load ──────────────────────────────────────────────────────────────
//
// Core-normalised so the number means the same thing on a 4-core container and a 12-core mini,
// and sampled at both ends because one sample cannot answer both questions. MEASURED, moments
// after a heavy run was stopped in a 4-cpu container: os.loadavg() read [0.69, 2.37, 2.29] — the
// 1-minute figure had already decayed to 0.17 normalised while the 5-minute one still read 0.59.
// A start-only sample there reports an idle machine that was saturated seconds earlier; an
// end-only sample cannot separate "already busy" from "this gate WAS the load".

test("W1-T2810: load is core-normalised, and an all-zero triple is unavailable rather than idle", () => {
  assert.equal(normalisedLoad([4, 4, 4], 4), 1);
  assert.equal(normalisedLoad([4, 4, 4], 8), 0.5);
  // The platform-without-loadavg shape. Never read as an idle machine — the same
  // never-guess-a-zero rule `parseBashMajorVersion` states one screen up in the same file.
  assert.equal(normalisedLoad([0, 0, 0], 4), undefined);
  assert.equal(normalisedLoad(undefined, 4), undefined);
  assert.equal(normalisedLoad([1, 1], 4), undefined, "a short triple cannot be trusted");
  assert.equal(normalisedLoad([Number.NaN, 1, 1], 4), undefined);
  assert.equal(normalisedLoad([1, 1, 1], 0), undefined, "a zero core count would divide by zero");
});

test("W1-T2810: both samples are carried and either one over the threshold labels the run — sampled at both ends", () => {
  const ctx = computeRunContext({
    headSha: "abc1234",
    behindText: "0",
    reflogText: undefined,
    loadavgStart: [8, 8, 8],
    loadavgEnd: [0.4, 1, 1],
    cpuCount: 4,
  });
  assert.equal(ctx.loadStart, 2);
  assert.equal(ctx.loadEnd, 0.1);
  assert.equal(isLoadedRun(ctx), true, "a run that STARTED saturated is a loaded run");
  assert.match(runContextLine(ctx), /load=2\.00->0\.10 of 4 cpu \(LOADED\)/);

  const quiet = computeRunContext({
    headSha: "abc1234",
    behindText: "0",
    reflogText: undefined,
    loadavgStart: [0.4, 1, 1],
    loadavgEnd: [0.4, 1, 1],
    cpuCount: 4,
  });
  assert.equal(isLoadedRun(quiet), false);
  assert.doesNotMatch(runContextLine(quiet), /LOADED/);

  // The threshold is DATA, and it is the boundary that is checked — not an arbitrary big number.
  assert.equal(LOADED_RUN_THRESHOLD, 1);
  assert.equal(isLoadedRun(CTX({ loadStart: LOADED_RUN_THRESHOLD, loadEnd: 0 })), true);
  assert.equal(isLoadedRun(CTX({ loadStart: undefined, loadEnd: undefined })), false);

  assert.match(runContextLine(CTX({ loadStart: undefined, loadEnd: undefined })), /load=unavailable/);
  assert.match(runContextLine(CTX({ loadStart: undefined })), /load=\?->0\.20/);
});

// ── THE IMPURE EDGE ──────────────────────────────────────────────────────────────────────────

test("W1-T2810: detectRunContext reads git through the shared spawn seam and NEVER fetches", () => {
  const { spawn, seen } = spawnStub([
    { match: "rev-list", status: 0, stdout: "3\n" },
    { match: "reflog", status: 0, stdout: "origin/main@{2026-09-01T09:00:00+00:00}\n" },
  ]);
  const ctx = detectRunContext({
    repoRoot: "/repo",
    headSha: "deadbee",
    spawn,
    loadavgStart: [1, 1, 1],
    loadavgEnd: [2, 2, 2],
    cpuCount: 2,
  });
  assert.equal(ctx.behindCount, 3);
  assert.equal(ctx.originFetchedAt, "2026-09-01T09:00:00+00:00");
  assert.equal(ctx.headSha, "deadbee");
  // A LOCAL gate must acquire no network dependency: `preflightSummaryPath`'s own doc refuses
  // `config.root` because a preflight "meant to run anywhere must not acquire that dependency",
  // and a fetch would add a hang path to the one command every session runs before its first push.
  assert.ok(
    seen.every((args) => !args.includes("fetch")),
    `detectRunContext must never fetch; saw ${JSON.stringify(seen)}`,
  );
});

test("W1-T2810: a NON-ZERO git status renders unknown, and the status is read from the spawn result rather than a pipeline", () => {
  // The shallow-clone case, and it is ordinary rather than exotic: a depth-1 shallow clone carries
  // no refs/remotes/origin/main at all, so `git rev-list --count HEAD..origin/main` exits 128 with
  // EMPTY stdout there. MEASURED while this was designed: piping that command into anything
  // reports the PIPE's status, not git's — the very invocation that failed with 128 read as
  // success — which is how an unknown silently becomes `behind=0`.
  // Verbatim what a depth-1 shallow clone actually produces, measured rather than invented.
  const shallow: PreflightSpawn = () => ({
    status: 128,
    stdout: "",
    stderr: "fatal: ambiguous argument 'HEAD..origin/main': unknown revision or path not in the working tree.\n",
  });
  const ctx = detectRunContext({
    repoRoot: "/repo",
    headSha: "unknown",
    spawn: shallow,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
  });
  assert.equal(ctx.behindCount, undefined);
  assert.equal(ctx.originFetchedAt, undefined);
  assert.doesNotMatch(runContextLine(ctx), /behind=0/);
  assert.match(runContextLine(ctx), /behind=unknown \(fatal: ambiguous argument/);
});

test("W1-T2810: the unknown REASON is the observed failure, not the common one assumed for every case", () => {
  // The shallow clone is the COMMON cause and is the honest default when nothing was captured.
  // It is not the only cause — a missing git, a permission error and a corrupt ref all land in
  // the same branch — so assuming it for all of them would be the guess this module refuses
  // everywhere else. What the read actually reported wins.
  const observed: PreflightSpawn = (_file, args) =>
    args.includes("rev-list")
      ? { status: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository\nmore\n" }
      : { status: 128, stdout: "", stderr: "" };
  const ctx = detectRunContext({
    repoRoot: "/repo",
    headSha: "abc1234",
    spawn: observed,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
  });
  assert.equal(ctx.behindUnknownReason, "fatal: detected dubious ownership in repository");
  assert.match(runContextLine(ctx), /behind=unknown \(fatal: detected dubious ownership/);

  // A non-zero exit with NO stderr still records something observed — the status itself.
  const silent: PreflightSpawn = () => ({ status: 129, stdout: "", stderr: "" });
  const quiet = detectRunContext({
    repoRoot: "/repo",
    headSha: "abc1234",
    spawn: silent,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
  });
  assert.equal(quiet.behindUnknownReason, "git exited 129");

  // And a THROW records its message rather than folding into the absence value.
  const throwing: PreflightSpawn = () => {
    throw new Error("git not found");
  };
  const threw = detectRunContext({
    repoRoot: "/repo",
    headSha: "abc1234",
    spawn: throwing,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
  });
  assert.equal(threw.behindUnknownReason, "git not found");
});

test("W1-T2810: a THROWING spawn degrades to unknown rather than taking down the gate", () => {
  const throwing: PreflightSpawn = () => {
    throw new Error("git not found");
  };
  const ctx = detectRunContext({
    repoRoot: "/repo",
    headSha: "abc1234",
    spawn: throwing,
    loadavgStart: undefined,
    loadavgEnd: undefined,
    cpuCount: 4,
  });
  assert.equal(ctx.behindCount, undefined);
  assert.equal(ctx.originFetchedAt, undefined);
});

// ── THE STAMP ITSELF ─────────────────────────────────────────────────────────────────────────

test("W1-T2810: the stamp names all three facts on one line, and the summary carries the same object so the two cannot drift", () => {
  const line = runContextLine(CTX());
  assert.match(line, /sha=abc1234/);
  assert.match(line, /behind=0/);
  assert.match(line, /origin\/main fetched/);
  assert.match(line, /load=/);
  assert.equal(line.split("\n").length, 1, "the stamp is ONE line — it goes on the verdict, not into a report");

  const summary = buildPreflightSummary({
    steps: [{ name: "ci", ok: true, detail: "PASS" }],
    finishedAt: "2026-09-04T13:00:00.000Z",
    durationMs: 5,
    headSha: "abc1234",
    args: [],
    runContext: CTX(),
  });
  assert.deepEqual(summary.runContext, CTX());
  // Optional, so every summary written before this field existed still parses.
  const without = buildPreflightSummary({
    steps: [{ name: "ci", ok: true, detail: "PASS" }],
    finishedAt: "2026-09-04T13:00:00.000Z",
    durationMs: 5,
    headSha: "abc1234",
    args: [],
  });
  assert.equal(without.runContext, undefined);
});

// ── THE BOUNDARY WITH W1-T2811 ───────────────────────────────────────────────────────────────
//
// W1-T2810 owns LEGIBILITY — the run reports that it happened under load. W1-T2811 owns
// EXPRESSION — a test declares that its own contract is wall-clock dependent. Neither subsumes
// the other, and W1-T2811 carries a clause that closes it UNBUILT if this task ships something
// that makes each wall-clock assertion declare itself at the assertion site. So this stamp is
// run scoped never per assertion, and this test is what makes that checkable rather than merely
// stated: a later drift into per-assertion territory reds here instead of silently closing a
// sibling task that should have been built.

test("W1-T2810: the stamp is run scoped never per assertion, so W1-T2811's expression half stays unbuilt", () => {
  // ONE RunContext describes a RUN. It carries no test name, no assertion identity, and no
  // per-bound field — there is nowhere for a test's own contract to be recorded, by construction.
  const keys = Object.keys(CTX()).sort();
  assert.deepEqual(keys, [
    "behindCount",
    "behindUnknownReason",
    "cpuCount",
    "headSha",
    "loadEnd",
    "loadStart",
    "originFetchedAt",
  ]);
  for (const k of keys) {
    assert.doesNotMatch(k, /assert|test|bound|wallClock/i, `${k} would be W1-T2811's territory`);
  }
});

// ── THE STAMP ON THE REAL VERDICT LINE, BOTH BRANCHES ────────────────────────────────────────
//
// The tests above prove the renderer. THIS pair is what makes the stamp load-bearing: delete the
// stamp from `preflightCommand` and these two red. Without them, every assertion above would keep
// passing over a feature that no longer reached a single human — which is precisely the shape of
// the defect being fixed, since `headSha` was computed on this path all along.
//
// THE PASSING BRANCH IS THE ONE THIS EXISTS FOR. A stale RED gets investigated anyway; the stale
// GREEN is hazard (h)'s measured shape — exit 0, a confident sentence, both operands moved.

/** Drive the real `preflightCommand`, capturing its stdout. `spawn` is injected, which also makes
 *  the command refuse the default summary path — a test has no business writing the orchestrator's
 *  adjudicated verdict (W1-T455). */
async function runPreflightCapturingLines(
  spawn: PreflightSpawn,
  deps: { loadavg?: () => readonly number[] | undefined; cpuCount?: number } = {},
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  let code: number;
  try {
    code = await preflightCommand([], { spawn, ...deps });
  } finally {
    console.log = originalLog;
  }
  return { code, lines };
}

test("W1-T2810: the PASSING verdict carries the context stamp — the stale-green case, which is the one nobody questions", async () => {
  const spawn: PreflightSpawn = (_file, args) => {
    if (args.includes("rev-list")) return { status: 0, stdout: "465\n", stderr: "" };
    if (args.includes("reflog")) return { status: 0, stdout: "origin/main@{2026-08-30T01:02:03+00:00}\n", stderr: "" };
    return { status: 0, stdout: "\0feat(x): fine\n", stderr: "" };
  };
  const { code, lines } = await runPreflightCapturingLines(spawn, { loadavg: () => [8, 8, 8], cpuCount: 4 });
  assert.equal(code, 0, "this fixture is a PASS — the point is that a pass is stamped too");

  const verdict = lines.find((l) => l.includes("rmd preflight: PASS"));
  assert.ok(verdict, "the PASS verdict must be printed");
  assert.match(verdict, /context: sha=/, "a passing verdict must name the tree it measured");
  assert.match(verdict, /behind=465/, "a passing verdict from a behind checkout must say how far behind");
  assert.match(verdict, /origin\/main fetched 2026-08-30T01:02:03\+00:00/, "and how stale that comparison is");
  assert.match(verdict, /\(LOADED\)/, "and that it ran under load");
});

test("W1-T2810: the FAILING verdict carries the identical stamp, so neither direction is interpretable without it", async () => {
  const spawn: PreflightSpawn = (_file, args) => {
    if (args.includes("rev-list")) return { status: 128, stdout: "", stderr: "fatal" };
    if (args.includes("reflog")) return { status: 128, stdout: "", stderr: "fatal" };
    // A commitlint-shaped failure: a non-conforming subject fails the hand route.
    return { status: 1, stdout: "\0nope not conventional\n", stderr: "" };
  };
  const { code, lines } = await runPreflightCapturingLines(spawn, { loadavg: () => [0, 0, 0], cpuCount: 4 });
  assert.equal(code, 1);

  const verdict = lines.find((l) => l.includes("rmd preflight: FAIL"));
  assert.ok(verdict, "the FAIL verdict must be printed");
  assert.match(verdict, /context: sha=/);
  // The shallow-clone degrade reaching the real verdict line, end to end: unknown, never 0.
  assert.match(verdict, /behind=unknown/);
  assert.doesNotMatch(verdict, /behind=0/);
  assert.match(verdict, /load=unavailable/);
});
