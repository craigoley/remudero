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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { retainFixture } from "#test/setup/retained-fixtures.js";
import {
  RETRO_PREFLIGHT_STALL_MS,
  RETRO_PREFLIGHT_TOTAL_BACKSTOP_MS,
  runRetroPrepublishCommand,
  runRetroPrepublishPreflight,
  type RetroPrepublishCommandResult,
  type RetroPrepublishRunner,
} from "#src/lib/retro-preflight.js";

function options(timeout: number, totalBackstopMs?: number, env: NodeJS.ProcessEnv = process.env): Parameters<RetroPrepublishRunner>[2] {
  // Only these synthetic -e scripts are excluded. The importing test process still covers the
  // real runner and its watchdog. Coverage startup is not output from a talkative fixture.
  return { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024, timeout,
           env: { ...env, NODE_V8_COVERAGE: "" },
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

test("retro timing fixtures exclude synthetic child coverage while preserving the parent runner coverage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rmd-test-retro-child-coverage-"));
  const parentCoverage = process.env.NODE_V8_COVERAGE;
  const inputEnv = { ...process.env, NODE_V8_COVERAGE: directory };
  const result = await runRetroPrepublishCommand(
    process.execPath,
    ["-e", 'process.stdout.write(JSON.stringify({ coverage: process.env.NODE_V8_COVERAGE ?? null }))'],
    options(5_000, undefined, inputEnv),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { coverage: "" });
  assert.deepEqual(readdirSync(directory), [], "the real synthetic child must not emit coverage artifacts");
  assert.equal(inputEnv.NODE_V8_COVERAGE, directory, "the supplied environment is not mutated");
  assert.equal(process.env.NODE_V8_COVERAGE, parentCoverage, "the parent runner retains its coverage environment");
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
    deps: { run: () => (call++ === 0 ? enumerated : timedOut), now: () => 0,
      changedFiles: async () => ({ unreadable: "fixture has no PR diff" }) },
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
    deps: { run: () => (call++ % 2 === 0 ? enumerated : failed), now: () => 0,
      changedFiles: async () => ({ unreadable: "fixture has no PR diff" }) },
  });
  assert.equal(repairs.length, 1, "an ordinary suite failure still resumes the Architect");
  assert.equal(outcome.attempts, 2, "and still runs the second attempt");
  assert.equal(outcome.repaired, true);
});

async function interruptedEvidence(stdout: string) {
  const events: { step: string; fields: Record<string, unknown> }[] = [];
  let calls = 0, repairs = 0, regenerations = 0;
  const outcome = await runRetroPrepublishPreflight({
    worktreePath: REPO_ROOT,
    provenance: { model: "fixture", effort: "default", sessionId: "partial-evidence" },
    remotePrExisted: false,
    repair: async () => { repairs++; },
    regenerateHarnessArtifacts: () => { regenerations++; },
    log: (step, fields) => { events.push({ step, fields }); },
    deps: {
      now: () => 0,
      changedFiles: async () => ({ unreadable: "fixture has no PR diff" }),
      run: () => ++calls === 1
        ? { status: 0, signal: null, stdout: "test/fixture.test.ts\n", stderr: "" }
        : { status: null, signal: "SIGTERM", stdout, stderr: "",
            error: Object.assign(new Error("fixture total backstop"), { code: "ETIMEDOUT" }) },
    },
  });
  assert.deepEqual(outcome, { ok: false, attempts: 1, suiteCount: 1, repaired: false });
  assert.deepEqual({ calls, repairs, regenerations }, { calls: 2, repairs: 0, regenerations: 0 });
  const failure = events.find(row => row.step === "retro.preflight_failed")?.fields;
  const standDown = events.find(row => row.step === "retro.preflight_repair_stood_down")?.fields;
  assert.ok(failure); assert.ok(standDown);
  assert.equal(failure.exit_class, "process_timeout");
  assert.equal(failure.has_summary, false);
  return { failure, standDown };
}

test("retro bound evidence: a timeout retains partial assertion names without calling the evidence empty", async () => {
  const name = "author deadline admission refuses a too-small real slot budget before starting static work";
  const { failure, standDown } = await interruptedEvidence(`not ok 1 - ${name}\n`);
  assert.deepEqual(failure.failing_tests, [name]);
  assert.equal(standDown.retained_failing_test_names, 1);
  assert.equal(standDown.retained_cancelled_test_names, 0);
  assert.equal(standDown.has_summary, false);
  assert.doesNotMatch(String(standDown.reason), /no failing test|empty evidence/);
  assert.match(String(standDown.reason), /execution bound|could not start/);
});

test("retro bound evidence: a timeout keeps cancelled names separate from assertion evidence", async () => {
  const { failure, standDown } = await interruptedEvidence(
    "not ok 1 - fixture cancelled\n  ---\n  failureType: 'cancelledByParent'\n  ...\n",
  );
  assert.deepEqual(failure.failing_tests, []);
  assert.deepEqual(failure.cancelled_tests, ["fixture cancelled"]);
  assert.equal(standDown.retained_failing_test_names, 0);
  assert.equal(standDown.retained_cancelled_test_names, 1);
  assert.equal(standDown.has_summary, false);
});

test("retro bound evidence: a timeout with no retained names still reports incomplete evidence", async () => {
  const { failure, standDown } = await interruptedEvidence("");
  assert.deepEqual(failure.failing_tests, []);
  assert.deepEqual(failure.cancelled_tests, []);
  assert.equal(standDown.retained_failing_test_names, 0);
  assert.equal(standDown.retained_cancelled_test_names, 0);
  assert.equal(standDown.has_summary, false);
});

test("retro bound evidence: an ordinary completed assertion failure still gets its one repair", async () => {
  let calls = 0, repairs = 0, regenerations = 0;
  const events: string[] = [];
  const outcome = await runRetroPrepublishPreflight({
    worktreePath: REPO_ROOT,
    provenance: { model: "fixture", effort: "default", sessionId: "completed-evidence" },
    remotePrExisted: false,
    repair: async () => { repairs++; },
    regenerateHarnessArtifacts: () => { regenerations++; },
    log: step => { events.push(step); },
    deps: { now: () => 0, changedFiles: async () => ({ unreadable: "fixture has no PR diff" }), run: () => {
      calls++;
      if (calls % 2 === 1) return { status: 0, signal: null, stdout: "test/fixture.test.ts\n", stderr: "" };
      return calls === 2
        ? { status: 1, signal: null, stdout: "not ok 1 - fixture assertion\n# tests 1\n# fail 1\n", stderr: "" }
        : { status: 0, signal: null, stdout: "ok 1 - repaired\n# tests 1\n# fail 0\n", stderr: "" };
    } },
  });
  assert.deepEqual(outcome, { ok: true, attempts: 2, suiteCount: 1, repaired: true });
  assert.deepEqual({ calls, repairs, regenerations }, { calls: 4, repairs: 1, regenerations: 1 });
  assert.equal(events.includes("retro.preflight_repair_stood_down"), false);
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

async function untilFixture(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** An exact, signal-zero fixture probe. Only ESRCH proves absence; denied/unknown stays UNKNOWN. */
function fixturePidEnded(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw new Error("fixture liveness must be readable; denied is not absence", { cause: error });
  }
}

async function nestedWatchdogFixture(mode: "silence" | "total" | "output" | "ordinary" | "resistant"): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-retro-owned-group-")), nonce = randomUUID();
  const actor = join(dir, "actor.cjs"), wrapper = join(dir, "wrapper.cjs");
  // Private stdio is essential: killing the wrapper must not merely wait for an inherited pipe.
  // Both actors also have a nonce-bound stop request and finite fallback lifetime under deletion.
  writeFileSync(actor, `const fs=require('node:fs'),p=require('node:path');
const [dir,role,nonce,resistant]=process.argv.slice(2),file=n=>p.join(dir,role+'.'+n);
if(resistant==='resistant')process.on('SIGTERM',()=>{});
fs.writeFileSync(file('ready.tmp'),JSON.stringify({pid:process.pid,nonce}));
fs.renameSync(file('ready.tmp'),file('ready'));
const tick=setInterval(()=>{fs.appendFileSync(file('heart'),'tick\\n');
 if(fs.existsSync(file('stop'))&&fs.readFileSync(file('stop'),'utf8')===nonce){clearInterval(tick);process.exit(0);}},25);
setTimeout(()=>{clearInterval(tick);process.exit(0)},6000);`);
  writeFileSync(wrapper, `const fs=require('node:fs'),p=require('node:path'),{spawn}=require('node:child_process');
const [dir,actor,nonce,mode]=process.argv.slice(2);
if(mode==='resistant')process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,[actor,dir,'owned',nonce,mode],{stdio:'ignore',env:process.env});
child.once('error',()=>process.exit(2));
const ready=setInterval(()=>{if(!fs.existsSync(p.join(dir,'owned.heart')))return;
 clearInterval(ready);process.stdout.write('fixture-ready\\n');
 if(mode==='ordinary')process.exit(0);
 if(mode==='output')process.stdout.write('x'.repeat(8192));
 if(mode==='total')setInterval(()=>process.stdout.write('tick\\n'),40);},10);
setTimeout(()=>process.exit(0),6500);`);
  const env = { ...process.env, NODE_V8_COVERAGE: "" };
  const sibling = spawn(process.execPath, [actor, dir, "sibling", nonce], { env, stdio: "ignore", detached: true });
  let siblingError: Error | undefined;
  sibling.once("error", error => { siblingError = error; });
  const siblingClosed = new Promise<void>(resolve => sibling.once("close", () => resolve()));
  let ownedPid: number | undefined;
  const readPid = (role: string): number => {
    const ready = JSON.parse(readFileSync(join(dir, role + ".ready"), "utf8")) as { nonce?: string; pid?: number };
    assert.equal(ready.nonce, nonce);
    assert.ok(typeof ready.pid === "number" && Number.isSafeInteger(ready.pid) && ready.pid > 1);
    return ready.pid;
  };
  const heart = (role: string) => readFileSync(join(dir, role + ".heart")).byteLength;
  let responsiveTicks = 0;
  const responsive = setInterval(() => { responsiveTicks++; }, 25);
  try {
    await untilFixture(() => existsSync(join(dir, "sibling.heart")), "the independent sibling must really start");
    assert.equal(siblingError, undefined);
    const result = await runRetroPrepublishCommand(process.execPath, [wrapper, dir, actor, nonce, mode], {
      ...options(1_500, mode === "total" ? 2_000 : 5_000, env),
      maxBuffer: mode === "output" ? 1024 : 16 * 1024,
    });
    assert.match(result.stdout, /fixture-ready/, "a missing descendant start is not discrimination");
    ownedPid = readPid("owned");
    assert.ok(heart("owned") > 0, "the owned descendant must have executed");
    if (mode === "ordinary") {
      assert.equal(result.status, 0); assert.equal(result.error, undefined);
    } else {
      assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, mode === "output" ? "ENOBUFS" : "ETIMEDOUT");
    }
    assert.equal(result.cleanupError, undefined);
    if (mode === "output") assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 1024, "group cleanup must retain the existing capture ceiling");
    if (mode === "resistant") {
      assert.equal(result.signal, "SIGKILL", "a TERM-resistant leader requires the bounded escalation");
      assert.ok(responsiveTicks > 10, "waiting for teardown must leave the caller event loop responsive");
    }
    const ownedAtResult = heart("owned"), siblingAtResult = heart("sibling");
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(heart("owned"), ownedAtResult, "the known owned descendant must not keep writing after the result");
    assert.ok(heart("sibling") > siblingAtResult, "an unrelated sibling must remain live and writing");
    await untilFixture(() => fixturePidEnded(ownedPid!), "a stopped heartbeat alone is not teardown evidence");
  } finally {
    clearInterval(responsive);
    // The original/deleted runner leaves its descendant live. Ask only these fixture actors to exit,
    // then verify exact PIDs before deleting scratch. No foreign PID or inherited group is signalled.
    try {
      for (const role of ["owned", "sibling"]) writeFileSync(join(dir, role + ".stop"), nonce);
      if (ownedPid === undefined) {
        await untilFixture(() => existsSync(join(dir, "owned.ready")), "unknown owned fixture identity must retain scratch");
        ownedPid = readPid("owned");
      }
      if (ownedPid !== undefined) await untilFixture(() => fixturePidEnded(ownedPid!), "owned fixture did not retire");
      await siblingClosed;
      assert.ok(sibling.pid !== undefined && fixturePidEnded(sibling.pid), "sibling fixture must retire before scratch");
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      retainFixture(dir, "retro process replay cleanup is unknown");
      throw error;
    }
  }
}

test("W1-T10885: the retro watchdog stops its owned descendants without signaling a sibling", async t => {
  for (const mode of ["silence", "total", "output", "ordinary", "resistant"] as const) {
    await t.test(mode, () => nestedWatchdogFixture(mode));
  }
});

test("W1-T10885: retro process-group cleanup preserves ordinary results and spawn failures", async t => {
  const ordinary = await runRetroPrepublishCommand(process.execPath, ["-e", 'process.stdout.write("ordinary");process.stderr.write("warning")'], options(5_000));
  assert.equal(ordinary.status, 0); assert.equal(ordinary.signal, null); assert.equal(ordinary.error, undefined);
  assert.equal(ordinary.stdout, "ordinary"); assert.equal(ordinary.stderr, "warning");
  const failed = await runRetroPrepublishCommand(process.execPath, ["-e", "process.exit(7)"], options(5_000));
  assert.equal(failed.status, 7); assert.equal(failed.error, undefined);
  const absent = await runRetroPrepublishCommand(join(tmpdir(), "rmd-absent-" + randomUUID()), [], options(5_000));
  assert.equal((absent.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
  assert.notEqual(absent.status, 0);

  // The real child catches TERM and exits zero. Its watchdog error must still reach the consumer,
  // so a nominal exit cannot publish an interrupted run or start a repair against the same bound.
  let calls = 0, repairs = 0, regenerations = 0;
  const events: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const outcome = await runRetroPrepublishPreflight({
    worktreePath: REPO_ROOT, provenance: { model: "fixture", effort: "default", sessionId: "trapped-term" },
    remotePrExisted: false, repair: async () => { repairs++; }, regenerateHarnessArtifacts: () => { regenerations++; },
    log: (step, fields) => { events.push({ step, fields }); },
    deps: { changedFiles: async () => ({ unreadable: "fixture has no PR diff" }), run: async () => {
      if (++calls === 1) return { status: 0, signal: null, stdout: "test/retro-preflight-bound-fires-on-a-healthy-run.test.ts\n", stderr: "" };
      const result = await runRetroPrepublishCommand(process.execPath, ["-e", 'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("ready\\n");setTimeout(()=>process.exit(0),4000)'], options(1_000, 5_000));
      assert.match(result.stdout, /ready/); assert.equal(result.status, 0);
      assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT");
      return result;
    } },
  });
  assert.equal(outcome.ok, false, "a trapped zero exit cannot turn a watchdog error into publication success");
  assert.deepEqual({ calls, repairs, regenerations }, { calls: 2, repairs: 0, regenerations: 0 });
  assert.equal(events.find(x => x.step === "retro.preflight_failed")?.fields.exit_class, "process_timeout");
  assert.ok(events.some(x => x.step === "retro.preflight_repair_stood_down"));

  // Exercise the real cleanup catch with a finite real child. A denied group signal remains
  // unknown, while the command's independently observed exit is still reported truthfully.
  const kill = process.kill.bind(process);
  const denied = Object.assign(new Error("fixture group signal denied"), { code: "EPERM" });
  const signalCalls: NodeJS.Signals[] = [];
  const mocked = t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) { signalCalls.push(signal as NodeJS.Signals); throw denied; }
    return kill(pid, signal);
  });
  try {
    const unconfirmed = await runRetroPrepublishCommand(process.execPath, ["-e", 'process.stdout.write("ready\\n");setTimeout(()=>process.exit(0),2500)'], options(1_000, 5_000));
    assert.match(unconfirmed.stdout, /ready/); assert.equal(unconfirmed.status, 0);
    assert.equal((unconfirmed.error as NodeJS.ErrnoException).code, "ETIMEDOUT", "cleanup failure cannot replace the first watchdog reason");
    assert.equal(unconfirmed.cleanupError, denied);
    assert.ok(signalCalls.includes("SIGTERM") && signalCalls.includes("SIGKILL"));
    const cleanExit = await runRetroPrepublishCommand(process.execPath, ["-e", "process.exit(0)"], options(5_000));
    assert.equal(cleanExit.status, 0);
    assert.equal((cleanExit.error as NodeJS.ErrnoException).code, "EPROCESSGROUP");
    assert.equal(cleanExit.cleanupError, denied, "an exit zero does not turn an unreadable cleanup into success");
  } finally { mocked.mock.restore(); }
});

test("W1-T10885: errored zero-exit enumeration cannot start a suite or repair", async () => {
  for (const timedOut of [true, false]) {
    let calls = 0, repairs = 0;
    const events: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const result = await runRetroPrepublishPreflight({
      worktreePath: REPO_ROOT, provenance: { model: "fixture", effort: "default", sessionId: "enumeration-bound" },
      remotePrExisted: false, repair: async () => { repairs++; }, regenerateHarnessArtifacts: () => {},
      log: (step, fields) => { events.push({ step, fields }); },
      deps: { changedFiles: async () => ({ unreadable: "no PR diff" }), run: () => {
        calls++;
        return { status: 0, signal: null, stdout: "test/fixture.test.ts\n", stderr: "",
          ...(timedOut ? { error: Object.assign(new Error("fixture enumeration timed out"), { code: "ETIMEDOUT" }) } : {}),
          cleanupError: new Error("fixture unknown cleanup") };
      } },
    });
    assert.deepEqual(result, { ok: false, attempts: 1, suiteCount: 1, repaired: false });
    assert.equal(calls, 1); assert.equal(repairs, 0);
    assert.equal(events.find(x => x.step === "retro.preflight_failed")?.fields.process_cleanup_failed, true);
    assert.equal(events.find(x => x.step === "retro.preflight_failed")?.fields.exit_class, timedOut ? "process_timeout" : "process_cleanup_failed");
    if (!timedOut) assert.match(String(events.find(x => x.step === "retro.preflight_repair_stood_down")?.fields.reason), /could not confirm its owned process-group cleanup/);
  }
});

test("W1-T10885: interrupted diff classification cannot narrow the checked suite set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-retro-diff-bound-"));
  const calls: string[][] = [];
  const events: Array<{ step: string; fields: Record<string, unknown> }> = [];
  try {
    const result = await runRetroPrepublishPreflight({
      worktreePath: REPO_ROOT, provenance: { model: "fixture", effort: "default", sessionId: "diff-bound" },
      remotePrExisted: false, repair: async () => {}, regenerateHarnessArtifacts: () => {},
      log: (step, fields) => { events.push({ step, fields }); },
      deps: { tmpRoot: dir, changedFiles: async () => ({ files: ["plan/tasks.d/fixture.yaml"] }), run: (_command, args) => {
        calls.push(args);
        if (calls.length === 1) return { status: 0, signal: null, stdout: "PLAN_ONLY\n", stderr: "", error: new Error("interrupted classification") };
        if (calls.length === 2) return { status: 0, signal: null, stdout: "test/fixture.test.ts\n", stderr: "" };
        return { status: 0, signal: null, stdout: "# tests 1\n# fail 0\n", stderr: "" };
      } },
    });
    assert.equal(result.ok, true); assert.equal(calls.length, 3);
    assert.equal(calls[1].includes("--changed-files"), false, "an interrupted classification must retain the broad set");
    assert.equal(events.find(x => x.step === "retro.preflight_passed")?.fields.suite_selection, "broad");
    assert.match(String(events.find(x => x.step === "retro.preflight_passed")?.fields.suite_selection_reason), /command error/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T10885: a cleanup refusal keeps assertion evidence without claiming a timeout", async t => {
  const kill = process.kill.bind(process);
  const mocked = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid < 0) throw Object.assign(new Error("fixture group signal denied"), { code: "EPERM" });
    return kill(pid, signal);
  });
  let calls = 0, repairs = 0;
  const events: Array<{ step: string; fields: Record<string, unknown> }> = [];
  try {
    const result = await runRetroPrepublishPreflight({
      worktreePath: REPO_ROOT, provenance: { model: "fixture", effort: "default", sessionId: "cleanup-with-assertion" },
      remotePrExisted: false, repair: async () => { repairs++; }, regenerateHarnessArtifacts: () => {},
      log: (step, fields) => { events.push({ step, fields }); },
      deps: { changedFiles: async () => ({ unreadable: "no PR diff" }), run: async () => {
        if (++calls === 1) return { status: 0, signal: null, stdout: "test/fixture.test.ts\n", stderr: "" };
        return runRetroPrepublishCommand(process.execPath, ["-e", 'process.stdout.write("not ok 1 - fixture assertion\\n# tests 1\\n# fail 1\\n");process.exitCode=1'], options(5_000));
      } },
    });
    assert.equal(result.ok, false); assert.equal(repairs, 0); assert.equal(calls, 2);
    const failed = events.find(x => x.step === "retro.preflight_failed")!.fields;
    assert.equal(failed.exit_class, "process_cleanup_failed");
    assert.equal(failed.process_cleanup_failed, true);
    assert.deepEqual(failed.failing_tests, ["fixture assertion"]);
    const reason = String(events.find(x => x.step === "retro.preflight_repair_stood_down")?.fields.reason);
    assert.match(reason, /failure ended the attempt after it named 1 failing test/);
    assert.match(reason, /could not confirm its owned process-group cleanup/);
    assert.doesNotMatch(reason, /execution bound|bound stopped the run/);
  } finally { mocked.mock.restore(); }
});
