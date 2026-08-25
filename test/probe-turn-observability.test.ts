// W1-T2238 — THE CONTAINMENT PROBE RECORDS THAT IT RAN OUT OF TURNS AND NEVER HOW MANY IT
// USED, SO THE ALLOWANCE CANNOT BE TUNED ON EVIDENCE.
//
// `containment.probe` already logs `turns_exhausted` as a boolean (W1-T2201), but the pair
// that would make the allowance tunable on evidence — `numTurns` and the `maxTurns` cap that
// SPECIFIC call ran under — sat on `WorkerResult` (W1-T303) and were dropped one line away
// from the row that needed them. These tests pin the five criteria this shard names:
//   1. an exhausted row records the (numTurns, maxTurns) pair, together.
//   2. a PASSING row records the same pair — the distribution is readable, not only failures.
//   3. the row records how many probe arms reported, in the budget's own unit (commands).
//   4. the turn budget stays DERIVED from the command count and the allowance, never a literal.
//   5. an exhausted probe still fails closed and reports a reason distinct from an
//      unattempted write.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ContainmentError,
  PROBE_TURN_ALLOWANCE,
  assessContainment,
  containmentProbePrompt,
  defaultExecutor,
  probeArmsReported,
  probeCommandCount,
  probeContainment,
  probeTurnBudget,
  type ContainmentEvidence,
  type ProbeExecResult,
} from "../src/lib/containment.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const containmentSrc = readFileSync(
  fileURLToPath(new URL("../src/lib/containment.ts", import.meta.url)),
  "utf8",
);

function settingsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-probe-turn-obs-test-"));
  const path = join(dir, "worker.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const ENABLED = {
  sandbox: { enabled: true, failIfUnavailable: true },
  permissions: { deny: [], allow: [], ask: [] },
};

function fakeWorkerResult(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    ...overrides,
  } as unknown as WorkerResult;
}

function captureLog(): {
  log: (step: string, extra?: Record<string, unknown>) => void;
  lines: Array<{ step: string; extra?: Record<string, unknown> }>;
} {
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { log: (step, extra) => lines.push({ step, extra }), lines };
}

// ── Criterion 1 & 5 — an exhausted row carries the pair AND still fails closed,
//    distinctly from "the write may never have been attempted" ──────────────

test("an exhausted probe's containment.probe row carries num_turns and max_turns TOGETHER, and the run still fails closed with a distinct reason", async () => {
  const exec = (): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: "",
      outsideWriteCreated: false,
      insideWriteCreated: false,
      turnsExhausted: true,
      numTurns: 9,
      maxTurns: 10,
    });
  const { log, lines } = captureLog();
  await assert.rejects(
    () => probeContainment({ settingsFile: settingsFile(ENABLED), exec, token: "tok123", log }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.observed, "turns-exhausted");
      assert.notEqual(err.observed, "write-never-attempted");
      assert.match(err.message, /UNPROVEN/);
      return true;
    },
  );
  const row = lines.find((l) => l.step === "containment.probe");
  assert.ok(row, "containment.probe must still log even on a fail-closed run");
  assert.equal(row!.extra?.turns_exhausted, true);
  assert.equal(row!.extra?.num_turns, 9, "the exhausted row must carry HOW MANY turns it used");
  assert.equal(row!.extra?.max_turns, 10, "the exhausted row must carry the cap it ran under");
});

// ── Criterion 2 — a PASSING row records the same pair, not just the failures ──

test("a genuinely PROVEN-CONTAINED (passing) probe's containment.probe row ALSO carries num_turns and max_turns", async () => {
  const exec = (token: string): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted\ntouch probe-ok.txt`,
      outsideWriteCreated: false,
      insideWriteCreated: true,
      numTurns: 5,
      maxTurns: 10,
    });
  const { log, lines } = captureLog();
  const res = await probeContainment({
    settingsFile: settingsFile(ENABLED),
    exec,
    token: "tok123",
    log,
  });
  assert.equal(res.contained, true);
  const row = lines.find((l) => l.step === "containment.probe");
  assert.ok(row, "a passing run must still log containment.probe");
  assert.equal(row!.extra?.turns_exhausted, undefined, "a clean pass never claims exhaustion");
  assert.equal(
    row!.extra?.num_turns,
    5,
    "the passing path is the one whose distribution says whether the allowance is tight " +
      "(rationale (5)) — recording the pair only on failure would throw that signal away",
  );
  assert.equal(row!.extra?.max_turns, 10);
});

test("a probe evidence literal that never populated numTurns/maxTurns (pre-existing fakes) reads as unrecorded, never a guessed 0", async () => {
  const exec = (token: string): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted\ntouch probe-ok.txt`,
      outsideWriteCreated: false,
      insideWriteCreated: true,
    });
  const { log, lines } = captureLog();
  await probeContainment({ settingsFile: settingsFile(ENABLED), exec, token: "tokXYZ", log });
  const row = lines.find((l) => l.step === "containment.probe");
  assert.equal(row!.extra?.num_turns, undefined);
  assert.equal(row!.extra?.max_turns, undefined);
});

// ── Criterion 1/2 plumbing at the extraction site itself: defaultExecutor must
//    carry BOTH fields off WorkerResult rather than dropping them one line away
//    from the row that needs them (rationale (3)) ───────────────────────────

test("defaultExecutor: numTurns is carried off the probe spawn's own WorkerResult, on the exhausted path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-probe-turn-obs-exhaust-"));
  const config = { root: dir } as Config;
  const fakeSpawn = async (_args: SpawnWorkerArgs): Promise<WorkerResult> =>
    fakeWorkerResult({ subtype: "error_max_turns", isError: true, numTurns: 9 });
  const exec = defaultExecutor("settings.json", config, undefined, fakeSpawn);
  const result: ProbeExecResult = await exec("execTok");
  assert.equal(result.turnsExhausted, true);
  assert.equal(result.numTurns, 9, "WorkerResult.numTurns must survive the extraction site");
});

test("defaultExecutor: maxTurns on the returned ProbeExecResult is the SAME cap the spawn call was actually invoked with", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-probe-turn-obs-cap-"));
  const config = { root: dir } as Config;
  let spawnedWith: number | undefined;
  const fakeSpawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    spawnedWith = args.maxTurns;
    // Mirrors real spawnWorker (worker.ts): WorkerResult.maxTurns is `args.maxTurns`
    // carried through VERBATIM (W1-T303) — the fake must do the same or this test
    // would prove nothing about the extraction site under test.
    return fakeWorkerResult({ subtype: "success", numTurns: 6, maxTurns: args.maxTurns });
  };
  const exec = defaultExecutor("settings.json", config, undefined, fakeSpawn);
  const result: ProbeExecResult = await exec("execTok");
  assert.equal(typeof spawnedWith, "number");
  assert.equal(
    result.maxTurns,
    spawnedWith,
    "the ledgered cap must be the cap this SPECIFIC call ran under, not re-derived later",
  );
  assert.equal(result.numTurns, 6);
});

// ── Criterion 3 — arms reported, in the budget's own unit (commands) ────────

test("probeArmsReported counts only the twelve named per-arm booleans, and only where they fired true", () => {
  const base: ContainmentEvidence = { outsideWriteCreated: false, osDenialSeen: false, insideWriteCreated: false };
  assert.equal(probeArmsReported(base), 0, "an evidence object with no arm fields set reports zero");

  const some: ContainmentEvidence = {
    ...base,
    outsideWriteAttempted: true, // 1
    insideWriteCreated: true, // 2
    egressBlockedReached: true, // 3
    tokenReadSucceeded: true, // 4
    // deliberately false / undefined elsewhere — must NOT count
    egressAllowedReached: false,
    stateReadSucceeded: undefined,
  };
  assert.equal(probeArmsReported(some), 4);
});

test("probeArmsReported reads deny-floor engagement through assessDenyFloor, tri-state — never counted when unobserved", () => {
  const unobserved: ContainmentEvidence = {
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: false,
  };
  const engaged: ContainmentEvidence = { ...unobserved, denyFloorProbeCreated: false };
  const notEngaged: ContainmentEvidence = { ...unobserved, denyFloorProbeCreated: true };
  assert.equal(
    probeArmsReported(engaged) - probeArmsReported(unobserved),
    1,
    "an ENGAGED deny floor must add exactly one to the arm count",
  );
  assert.equal(
    probeArmsReported(notEngaged),
    probeArmsReported(unobserved),
    "a deny floor that did NOT engage (tripwire created) must not be counted as a reporting arm",
  );
});

test("a full twelve-for-twelve evidence object reports exactly 12 arms — the ceiling matches the named list", () => {
  const full: ContainmentEvidence = {
    outsideWriteCreated: false,
    osDenialSeen: true,
    insideWriteCreated: true,
    outsideWriteAttempted: true,
    denyFloorProbeCreated: false, // engaged: true
    egressBlockedReached: true,
    egressAllowedReached: true,
    egressDenialSeen: true,
    tokenReadSucceeded: true,
    stateReadSucceeded: true,
    tokenReadDenialSeen: true,
    operatorHomeReadSucceeded: true,
    operatorHomeReadDenialSeen: true,
  };
  assert.equal(probeArmsReported(full), 12);
});

test("containment.probe row carries arms_reported alongside the pair, in the SAME unit (commands) the budget above is derived from", async () => {
  const exec = (): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: "",
      outsideWriteCreated: false,
      insideWriteCreated: true,
      turnsExhausted: true,
      numTurns: 7,
      maxTurns: 10,
      egressBlockedReached: true,
      tokenReadSucceeded: true,
    });
  const { log, lines } = captureLog();
  await assert.rejects(() =>
    probeContainment({ settingsFile: settingsFile(ENABLED), exec, token: "tokARM", log }),
  );
  const row = lines.find((l) => l.step === "containment.probe");
  assert.equal(typeof row!.extra?.arms_reported, "number");
  assert.ok(
    (row!.extra?.arms_reported as number) >= 2,
    "insideWriteCreated, egressBlockedReached and tokenReadSucceeded all fired true on this fixture",
  );
});

// ── Criterion 4 — the budget stays DERIVED, never a literal ─────────────────

test("probeTurnBudget is still commands + 1 (report) + the named allowance, never a hand-picked literal", () => {
  const prompt = containmentProbePrompt("tok123");
  const commands = probeCommandCount(prompt);
  assert.ok(commands > 0, "the real prompt must list at least one numbered command");
  assert.equal(probeTurnBudget(prompt), commands + 1 + PROBE_TURN_ALLOWANCE);
});

test("this task does not reintroduce a literal maxTurns at the probe spawn call site", () => {
  // Same falsifier discipline as test/containment-turn-budget.test.ts: assert the CODE form
  // is absent, not merely that a passing number exists somewhere.
  assert.ok(
    !/maxTurns:\s*\d+,/.test(containmentSrc),
    "the probe's spawn call must still pass a DERIVED maxTurns, never a literal integer",
  );
  assert.match(containmentSrc, /maxTurns:\s*probeTurnBudget\(prompt\)/);
});

// ── Design part (iv): turns-exhausted stays distinct from "the write may never
//    have been attempted" (W1-T1281) — pinned again here directly on assessContainment ──

test("assessContainment: a turns-exhausted run still reports contained: false regardless of the new fields", () => {
  const v = assessContainment({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: true,
    turnsExhausted: true,
    numTurns: 9,
    maxTurns: 10,
  });
  assert.equal(v.contained, false);
  assert.match(v.reason, /turns-exhausted/);
});
