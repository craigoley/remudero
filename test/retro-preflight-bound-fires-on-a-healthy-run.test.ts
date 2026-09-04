// W1-T2803 — the retro prepublish preflight's bound fired on healthy runs.
//
// The bound was a per-command DEADLINE (`20 * 60 * 1000`) on a run whose length grows with the
// tree, so it decayed into firing on every retro once the plan-reading suite set crossed it. This
// suite pins the replacement: a bound on SILENCE, re-armed on every output chunk, which does not
// decay with the suite count and does not depend on the host's total speed.
//
// BOTH DIRECTIONS ARE PINNED HERE, and the reverse one matters more: a bound raised until nothing
// fires is not a bound. Every timing test below drives REAL subprocesses at millisecond scale
// through the module's own exported command runner, never a fake that can be made to finish under
// any number, and never a real 20-minute wall clock.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  RETRO_PREFLIGHT_STALL_MS,
  RETRO_PREFLIGHT_TOTAL_BACKSTOP_MS,
  runRetroPrepublishCommand,
  runRetroPrepublishPreflight,
  type RetroPrepublishCommandResult,
  type RetroPrepublishRunner,
} from "../src/lib/retro-preflight.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function options(timeout: number, totalBackstopMs?: number): Parameters<RetroPrepublishRunner>[2] {
  return { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024, timeout, env: { ...process.env },
           ...(totalBackstopMs === undefined ? {} : { totalBackstopMs }) };
}

/** A child that prints every `everyMs` for `totalMs`, so it is never silent for long but runs
 *  far longer than the bound — the exact shape of the healthy 200-suite run that was being killed. */
const CHATTY = (everyMs: number, totalMs: number) =>
  `const end = Date.now() + ${totalMs};` +
  `const t = setInterval(() => { process.stdout.write("tick\\n"); if (Date.now() > end) { clearInterval(t); process.exit(0); } }, ${everyMs});`;

/** A child that produces nothing at all and then exits — a genuine hang, for the reverse direction. */
const SILENT = (ms: number) => `setTimeout(() => process.exit(0), ${ms});`;

test("W1-T2803: a long but talkative run is NOT killed — the bound is on silence, so it does not decay with the suite count", async () => {
  // Runs ~900ms against a 300ms bound. Under the old deadline this is a kill; under a re-armed
  // stall bound it completes, because the gaps between chunks stay well under 300ms.
  const result = await runRetroPrepublishCommand(process.execPath, ["-e", CHATTY(50, 900)], options(300));
  assert.equal(result.error, undefined, `a talkative run must not be terminated: ${result.error?.message ?? ""}`);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /tick/);
});

test("W1-T2803: a genuinely hung run is still terminated — the bound is re-shaped, never removed", async () => {
  // The reverse direction, and the one that matters: silence for longer than the bound is killed,
  // classified ETIMEDOUT, and reports SIGTERM. A bound that cannot do this is not a bound.
  const result = await runRetroPrepublishCommand(process.execPath, ["-e", SILENT(5_000)], options(200));
  assert.ok(result.error, "a silent run past the bound must be terminated");
  assert.equal((result.error as NodeJS.ErrnoException).code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGTERM");
});

test("W1-T2803: the timeout failure reports the measured elapsed beside the bound, so a hang is separable from a tight bound", async () => {
  // The old message named the BOUND only, so a hang and a too-tight deadline printed the same
  // sentence and the filing had to derive the difference by hand from a ledger row.
  const result = await runRetroPrepublishCommand(process.execPath, ["-e", SILENT(5_000)], options(200));
  const message = result.error?.message ?? "";
  assert.match(message, /no output for 200ms/, "the bound is named");
  assert.match(message, /elapsed \d+ms at the stall/, "and the measured elapsed is named beside it");
});

test("W1-T2803: no repair on a bound failure — a terminated run carries no failing test and names no plan defect", async () => {
  const repairs: string[] = [];
  const steps: string[] = [];
  const timedOut: RetroPrepublishCommandResult = {
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("retro preflight produced no output for 1ms (elapsed 2ms at the stall, command: node)"), {
      code: "ETIMEDOUT",
    }),
  };
  const enumerated: RetroPrepublishCommandResult = { status: 0, signal: null, stdout: "test/a.test.ts\n", stderr: "" };
  let call = 0;
  const outcome = await runRetroPrepublishPreflight({
    worktreePath: REPO_ROOT,
    provenance: { model: "opus", effort: "default", sessionId: "s1" },
    remotePrExisted: false,
    repair: async (prompt) => { repairs.push(prompt); },
    regenerateHarnessArtifacts: () => {},
    log: (step) => { steps.push(step); },
    deps: { run: () => (call++ === 0 ? enumerated : timedOut), now: () => 0 },
  });
  assert.deepEqual(repairs, [], "a bound failure must not resume the producing Architect session");
  assert.equal(outcome.attempts, 1, "and must not spend a second full attempt against an unchanged bound");
  assert.equal(outcome.repaired, false);
  assert.ok(steps.includes("retro.preflight_repair_stood_down"), "the stand-down is ledgered, never silent");
});

test("W1-T2803: an ordinary tests_failed STILL repairs and still re-runs — the stand-down is not a blanket refusal", async () => {
  // The falsifier's own warning: a change that stood down on every failure would pass the test
  // above and silently delete the repair rung this preflight exists to drive.
  const repairs: string[] = [];
  const enumerated: RetroPrepublishCommandResult = { status: 0, signal: null, stdout: "test/a.test.ts\n", stderr: "" };
  const failed: RetroPrepublishCommandResult = { status: 1, signal: null, stdout: "not ok 1 - a real failure\n", stderr: "" };
  let call = 0;
  const outcome = await runRetroPrepublishPreflight({
    worktreePath: REPO_ROOT,
    provenance: { model: "opus", effort: "default", sessionId: "s1" },
    remotePrExisted: false,
    repair: async (prompt) => { repairs.push(prompt); },
    regenerateHarnessArtifacts: () => {},
    log: () => {},
    deps: { run: () => (call++ % 2 === 0 ? enumerated : failed), now: () => 0 },
  });
  assert.equal(repairs.length, 1, "an ordinary suite failure still resumes the Architect");
  assert.equal(outcome.attempts, 2, "and still runs the second attempt");
  assert.equal(outcome.repaired, true);
});

test("W1-T2803: the prepublish failure message names what survives, and no longer promises a preserved branch", () => {
  // Pins the ABSENCE, not one exact replacement wording — a test greping for a single new sentence
  // reddens on every future rewording and teaches nothing.
  const runTask = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.equal(
    runTask.includes("diagnostic branch preserved"),
    false,
    "the branch is never pushed on this path and its worktree is reaped, so the claim was false twice over",
  );
  assert.match(runTask, /prepublish validation failed[\s\S]{0,400}retro\.preflight_failed/, "the message names the ledger rows that do outlive the run");
});

test("W1-T2803: the bound's measurement travels with the value in source — the fleet host's own run, its load curve and its ZERO failures, not a bare integer", () => {
  // W1-T312's `WAIT_CAP_SECONDS` established this shape and is the reason that bound has not
  // re-fired: a later reader can check the number against what it was derived from. The reading
  // that matters is the one taken on the host that RUNS this, under the contention it runs under.
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "retro-preflight.ts"), "utf8");
  const doc = source.slice(0, source.indexOf("export const RETRO_PREFLIGHT_STALL_MS"));
  assert.match(doc, /Azure fleet container/, "the host that actually runs it");
  assert.match(doc, /2026-09-04/, "the date the measurement was taken");
  assert.match(doc, /1488602 ms/, "the measured wall clock on that host");
  assert.match(doc, /203 enumerated/, "the suite count at that date");
  assert.match(doc, /FAILURES: 0/, "and the zero that makes this a duration problem and nothing else");
  assert.match(doc, /min 1\.71, p50 12\.13, p90 20\.04, max 22\.34/, "the load curve the run executed under");
  assert.match(doc, /50 samples/, "including how many samples it rests on");
  assert.ok(RETRO_PREFLIGHT_STALL_MS > 0, "the bound is still a bound");
});

test("W1-T2803: the source names elapsed-reporting as the durable deliverable and the constants as stopgaps, because the suite count moves", () => {
  // The corpus went 193 -> 201 -> 203 during the investigation. Whoever re-sizes next must be told
  // which half of this fix survives that drift, or they re-size by guessing exactly as before.
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "retro-preflight.ts"), "utf8");
  assert.match(source, /THE DURABLE DELIVERABLE IS ELAPSED-REPORTING/);
  assert.match(source, /THE CONSTANTS ARE STOPGAPS/);
  assert.match(source, /193 -> 201 -> 203/, "the drift that makes any fixed total a moving target");
});

test("W1-T2803: a run that keeps emitting but never finishes is still terminated by the total backstop", () => {
  // The one case SILENCE cannot catch. Deliberately far above any healthy run: the measured fleet
  // run is 1488602ms and this is ~2.4x it, so it can only fire on something genuinely wrong.
  assert.ok(
    RETRO_PREFLIGHT_TOTAL_BACKSTOP_MS > 1_488_602,
    "the backstop must sit above the measured healthy run on the fleet host, or it re-arms this task's own defect",
  );
  assert.ok(RETRO_PREFLIGHT_TOTAL_BACKSTOP_MS >= RETRO_PREFLIGHT_STALL_MS, "and above the primary control it backs");
});

test("W1-T2803: the backstop fires on a chatty run that outruns it, naming the elapsed beside the bound", async () => {
  // Chatty enough that the stall bound never arms, but past a deliberately tiny backstop.
  const result = await runRetroPrepublishCommand(process.execPath, ["-e", CHATTY(20, 5_000)], options(60_000, 300));
  assert.ok(result.error, "a run past the total backstop must be terminated even while emitting");
  assert.equal((result.error as NodeJS.ErrnoException).code, "ETIMEDOUT");
  assert.match(result.error?.message ?? "", /total backstop/);
  assert.match(result.error?.message ?? "", /elapsed \d+ms/, "the measured elapsed rides beside the bound here too");
});
