import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ContainmentError,
  DENY_FLOOR_PROBE_BASENAME,
  PROBE_TURN_ALLOWANCE,
  PROBE_TURN_ALLOWANCE_CEILING,
  assessContainment,
  classifyUnprovenState,
  containmentProbePrompt,
  defaultExecutor,
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
const denyFloorSrc = readFileSync(fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url)), "utf8");

function settingsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-turn-budget-test-"));
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

// ── Criterion 1: the cap is DERIVED, not a literal ──────────────────────────

test("probeTurnBudget derives the cap from the prompt's own command count, plus one for REPORT, plus the named allowance", () => {
  const prompt = containmentProbePrompt("tok123");
  const commands = probeCommandCount(prompt);
  assert.ok(commands > 0, "the real prompt must list at least one numbered command");
  assert.equal(
    probeTurnBudget(prompt),
    commands + 1 + PROBE_TURN_ALLOWANCE(commands),
    "the budget must equal commands + 1 (report) + the named allowance — no other arithmetic",
  );
});

// W1-T2344 superseded this test's original shape: PROBE_TURN_ALLOWANCE was a flat,
// per-probe constant back when W1-T2201 wrote this file — exactly the design that
// diluted as commands were added (a per-probe slack constant absorbing a
// per-command cost) and drove the containment probe's turn-exhaustion rate to 29%.
// It is now a function of the SAME command count the derived base already moves
// with, capped at a stated ceiling so it cannot grow unbounded either.
test("PROBE_TURN_ALLOWANCE is a named, exported function of command count — not a flat magic number, and never negative or zero for a real prompt", () => {
  assert.equal(typeof PROBE_TURN_ALLOWANCE, "function");
  assert.ok(PROBE_TURN_ALLOWANCE(1) > 0, "an allowance of zero would leave no slack for any legitimate rework");
  assert.equal(PROBE_TURN_ALLOWANCE(2), 2, "below the ceiling, the allowance moves one-for-one with command count");
});

test("PROBE_TURN_ALLOWANCE_CEILING is a named, positive, exported constant that bounds the scaling allowance", () => {
  assert.equal(typeof PROBE_TURN_ALLOWANCE_CEILING, "number");
  assert.ok(PROBE_TURN_ALLOWANCE_CEILING > 0);
  assert.equal(PROBE_TURN_ALLOWANCE(PROBE_TURN_ALLOWANCE_CEILING + 100), PROBE_TURN_ALLOWANCE_CEILING);
});

test("the source no longer writes the probe's spawn maxTurns as the literal 6", () => {
  // W1-T2201's own defect: `maxTurns: 6` untouched since the 3-command spike and
  // unmoved when the egress command was added underneath it. Assert the literal
  // CODE form is gone from the spawn call, not merely that a passing number
  // exists somewhere — a literal that happens to equal today's derived value
  // would not move on the next command either. Scoped to non-comment lines
  // (excluding any line carrying a backtick) so this doesn't false-positive on
  // this file's OWN historical doc prose quoting the old literal for context.
  const codeLines = containmentSrc
    .split("\n")
    .filter((line) => !line.includes("`") && !/^\s*\/\//.test(line) && !/^\s*\*/.test(line));
  assert.ok(
    !codeLines.some((line) => /maxTurns:\s*6\b/.test(line)),
    "the spawn call must not hardcode maxTurns as the literal 6",
  );
  assert.match(
    containmentSrc,
    /maxTurns:\s*probeTurnBudget\(/,
    "the spawn call must derive maxTurns from probeTurnBudget",
  );
});

test("defaultExecutor spawns the probe worker with the DERIVED cap, not a hardcoded one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-turn-budget-exec-test-"));
  const config = { root: dir } as Config;
  let seenMaxTurns: number | undefined;
  let seenPrompt: string | undefined;
  const fakeSpawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    seenMaxTurns = args.maxTurns;
    seenPrompt = args.prompt;
    return fakeWorkerResult({ subtype: "success" });
  };
  const exec = defaultExecutor("settings.json", config, undefined, fakeSpawn);
  await exec("execTok");
  assert.ok(seenPrompt, "the spawn must have been called with a prompt");
  assert.equal(
    seenMaxTurns,
    probeTurnBudget(seenPrompt as string),
    "the actual spawn call must use probeTurnBudget over the SAME prompt it sends",
  );
});

// ── Criterion 2: a fifth command raises the cap automatically ───────────────

test("probeTurnBudget derives from the SAME command count for the base and the (now-scaling) allowance, at any count", () => {
  // W1-T2344: this test's original name ("...grows by exactly one turn per
  // additional command") pinned the OLD flat-allowance arithmetic. The formula
  // `commands + 1 + PROBE_TURN_ALLOWANCE(commands)` is what must hold at any
  // count now — below the ceiling that means TWO turns per additional command
  // (one from the base, one from the now-scaling allowance); see
  // containment-turn-budget's own ceiling test below for the saturating case.
  const commandLine = (n: number) => `${n}) touch step-${n}.txt`;
  for (const n of [1, 2, 3, 4, 5, 8]) {
    const prompt = Array.from({ length: n }, (_, i) => commandLine(i + 1)).join("\n");
    assert.equal(probeCommandCount(prompt), n, `a ${n}-command prompt must count ${n} commands`);
    assert.equal(probeTurnBudget(prompt), n + 1 + PROBE_TURN_ALLOWANCE(n));
  }
});

test("appending a FIFTH command underneath the real probe prompt raises the derived cap automatically — the exact bug this task fixes, now via a scaling allowance", () => {
  const fourCommandPrompt = containmentProbePrompt("tok123");
  const fourCommandCount = probeCommandCount(fourCommandPrompt);
  const fourCommandBudget = probeTurnBudget(fourCommandPrompt);

  // Simulate what W1-T1265 did to the 3-command prompt, one command later: add a
  // 5th numbered command underneath the existing four, exactly as a future arm
  // would.
  const fiveCommandPrompt =
    fourCommandPrompt + "\n5) touch fifth-command-marker.txt   (a new arm added later)";
  const fiveCommandBudget = probeTurnBudget(fiveCommandPrompt);

  // W1-T2344: below the stated ceiling the allowance now moves WITH the base, so
  // one extra command raises the cap by one turn from the base PLUS one turn
  // from the (still-scaling) allowance — never silently by less, which is
  // exactly the dilution this task fixes.
  const expectedRaise =
    1 + (PROBE_TURN_ALLOWANCE(fourCommandCount + 1) - PROBE_TURN_ALLOWANCE(fourCommandCount));
  assert.equal(
    fiveCommandBudget,
    fourCommandBudget + expectedRaise,
    "adding one command underneath must raise the derived cap automatically — no second edit to a " +
      "separate maxTurns literal, and (below the ceiling) no dilution of the allowance either",
  );
  assert.ok(expectedRaise >= 1, "the cap must never fail to move when a command is added");
});

test("W1-T2344: once the allowance saturates at its ceiling, an additional command still raises the BASE by one turn — the cap keeps moving, only the allowance stops", () => {
  const commandLine = (n: number) => `${n}) touch step-${n}.txt`;
  const atCeiling = Array.from({ length: PROBE_TURN_ALLOWANCE_CEILING }, (_, i) => commandLine(i + 1)).join("\n");
  const overCeiling =
    atCeiling + `\n${PROBE_TURN_ALLOWANCE_CEILING + 1}) touch step-over.txt`;
  assert.equal(
    probeTurnBudget(overCeiling),
    probeTurnBudget(atCeiling) + 1,
    "past the ceiling the allowance has saturated, so the cap still moves by exactly the base's one turn",
  );
});

// ── Criterion 3: a turn-exhausted run is REPORTED as turn-exhausted ─────────

test("classifyUnprovenState: turnsExhausted takes priority over the other three states", () => {
  assert.equal(
    classifyUnprovenState({
      outsideWriteCreated: false,
      osDenialSeen: false,
      insideWriteCreated: true,
      outsideWriteAttempted: false,
      turnsExhausted: true,
    }),
    "turns-exhausted",
  );
  // Even when the raw evidence ALSO looks like "probe-never-ran" (insideWriteCreated
  // false) — turns-exhausted is the more specific, actually-observed fact and must
  // still win, rather than the reader guessing from a downstream symptom.
  assert.equal(
    classifyUnprovenState({
      outsideWriteCreated: false,
      osDenialSeen: false,
      insideWriteCreated: false,
      turnsExhausted: true,
    }),
    "turns-exhausted",
  );
});

test("classifyUnprovenState: without turnsExhausted, the pre-existing three states are unchanged", () => {
  assert.equal(
    classifyUnprovenState({ outsideWriteCreated: false, osDenialSeen: false, insideWriteCreated: false }),
    "probe-never-ran",
  );
  assert.equal(
    classifyUnprovenState({
      outsideWriteCreated: false,
      osDenialSeen: false,
      insideWriteCreated: true,
      outsideWriteAttempted: false,
    }),
    "write-never-attempted",
  );
  assert.equal(
    classifyUnprovenState({
      outsideWriteCreated: false,
      osDenialSeen: false,
      insideWriteCreated: true,
      outsideWriteAttempted: true,
    }),
    "no-denial-observed",
  );
});

test("defaultExecutor: a probe spawn ending on error_max_turns is plumbed through as turnsExhausted: true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-turn-budget-exhaust-test-"));
  const config = { root: dir } as Config;
  const fakeSpawn = async (_args: SpawnWorkerArgs): Promise<WorkerResult> =>
    fakeWorkerResult({ subtype: "error_max_turns", isError: true, numTurns: 8 });
  const exec = defaultExecutor("settings.json", config, undefined, fakeSpawn);
  const result: ProbeExecResult = await exec("execTok");
  assert.equal(result.turnsExhausted, true);
});

test("defaultExecutor: a clean success never reports turnsExhausted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-turn-budget-clean-test-"));
  const config = { root: dir } as Config;
  const fakeSpawn = async (_args: SpawnWorkerArgs): Promise<WorkerResult> =>
    fakeWorkerResult({ subtype: "success" });
  const exec = defaultExecutor("settings.json", config, undefined, fakeSpawn);
  const result: ProbeExecResult = await exec("execTok");
  assert.equal(result.turnsExhausted, false);
});

test("probeContainment: a turn-exhausted run is thrown as observed 'turns-exhausted', never 'write-never-attempted'", async () => {
  const exec = (token: string): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: `touch ../${token}.txt`, // token mentioned but no denial phrase — ambiguous by itself
      outsideWriteCreated: false,
      insideWriteCreated: true,
      turnsExhausted: true,
    });
  await assert.rejects(
    () => probeContainment({ settingsFile: settingsFile(ENABLED), exec, token: "tok123" }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.observed, "turns-exhausted");
      assert.notEqual(err.observed, "write-never-attempted");
      assert.match(err.message, /UNPROVEN/);
      return true;
    },
  );
});

test("probeContainment: the containment.probe ledger line carries turns_exhausted for a raw grep, not just the thrown error", async () => {
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const exec = (): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: "",
      outsideWriteCreated: false,
      insideWriteCreated: false,
      turnsExhausted: true,
    });
  await assert.rejects(() =>
    probeContainment({
      settingsFile: settingsFile(ENABLED),
      exec,
      token: "tok123",
      log: (step, extra) => lines.push({ step, extra }),
    }),
  );
  const probe = lines.find((l) => l.step === "containment.probe");
  assert.ok(probe, "the probe must still log containment.probe even on a fail-closed run");
  assert.equal(probe!.extra?.turns_exhausted, true);
});

// ── Criterion 4: fail-closed is unchanged — raising the cap never flips a pass ──

test("assessContainment: a turns-exhausted run still reports contained: false", () => {
  const v = assessContainment({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: true,
    turnsExhausted: true,
  });
  assert.equal(v.contained, false);
  assert.match(v.reason, /turns-exhausted/);
});

test("assessContainment: a probe that proves nothing reports contained: false regardless of turnsExhausted", () => {
  const base: ContainmentEvidence = { outsideWriteCreated: false, osDenialSeen: false, insideWriteCreated: false };
  assert.equal(assessContainment(base).contained, false);
  assert.equal(assessContainment({ ...base, turnsExhausted: true }).contained, false);
  assert.equal(assessContainment({ ...base, turnsExhausted: false }).contained, false);
});

test("probeContainment: turnsExhausted never turns an unproven run into a pass — it still fails closed", async () => {
  const exec = (): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: "",
      outsideWriteCreated: false,
      insideWriteCreated: true,
      turnsExhausted: true,
    });
  await assert.rejects(
    () => probeContainment({ settingsFile: settingsFile(ENABLED), exec, token: "tok123" }),
    ContainmentError,
  );
});

test("a genuinely PROVEN-CONTAINED run is unaffected by any of this — whatever the cap is raised to", async () => {
  const exec = (token: string): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted\ntouch probe-ok.txt`,
      outsideWriteCreated: false,
      insideWriteCreated: true,
    });
  const res = await probeContainment({ settingsFile: settingsFile(ENABLED), exec, token: "tok123" });
  assert.equal(res.contained, true);
});

// ── Criterion 5: the deny-floor hook is untouched; the allowance names its rework ──

test("hooks/deny-floor.sh is unchanged by this task — still matches the tripwire basename it must refuse", () => {
  assert.ok(
    denyFloorSrc.includes(DENY_FLOOR_PROBE_BASENAME),
    "the hook must still name the same tripwire basename the probe plants, or the allowance's 3rd " +
      "named cost (rework forced by the tripwire) would be covering a hook that no longer exists",
  );
});

test("PROBE_TURN_ALLOWANCE's own doc names the deny-floor rework it covers, not just an unexplained number", () => {
  // Find the export statement and read the doc comment immediately preceding it,
  // so this assertion is pinned to the FUNCTION's own documentation rather than
  // matching "tripwire" anywhere else in a large file. W1-T2344 turned this from
  // an `export const` into an `export function` of command count.
  const marker = "export function PROBE_TURN_ALLOWANCE";
  const idx = containmentSrc.indexOf(marker);
  assert.ok(idx > -1, "PROBE_TURN_ALLOWANCE must be exported");
  const docStart = containmentSrc.lastIndexOf("/**", idx);
  const doc = containmentSrc.slice(docStart, idx);
  assert.match(doc, /tripwire/i, "the allowance's doc must name the deny-floor tripwire rework cost (Q2)");
  assert.match(doc, /ambiguous/i, "the allowance's doc must name the ambiguous-result re-read cost (Q1)");
  assert.match(doc, /retry|malformed/i, "the allowance's doc must name the malformed-invocation retry cost");
});
