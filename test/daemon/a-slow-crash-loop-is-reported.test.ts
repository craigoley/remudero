// W1-T11421 — a slow crash loop is reported against the instance's own lifetime.
//
// 2026-11-05: core aborted at its heap limit 29 times in 9 h, each process living 15-28 minutes. No ten-minute window
// ever held six boots, so detectDaemonCrashLoop never fired and nothing alerted. These tests replay that boot pattern
// through the real sentinel, the real ledger and a real rotation, and assert exactly one incident; a healthy history
// must raise none.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CRASHLOOP_WINDOW, daemonBoot, detectDaemonCrashLoop, learnedCleanLifetime } from "#src/lib/daemon.js";
import {
  daemonCrashSentinel,
  clearDaemonCrashLoopIncident,
  withDaemonCrashLoopClear,
  LEARNED_CRASHLOOP_SUMMARY,
  runDaemonCrashSentinel,
  type CrashSentinelCtx,
} from "#src/lib/escalation-catalogue.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { fixedClock } from "#src/lib/clock.js";
import { drainEscalationSpool, escalationSpoolDir, spoolEscalation } from "#src/lib/host-escalation-spool.js";
import { rotateLedger } from "#src/lib/ledger.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const MIN = 60_000;
const HEAP_LIMIT = 7_540_310_016;
const HEAP_FATAL = "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";

function containerProcess(t: Parameters<typeof ownedFixtureDir>[0], ledgerPath: string, runId: string,
  bootMs: number, lifetimeMs: number, exitCode: number, heapLine = HEAP_FATAL): void {
  const { dir: home } = ownedFixtureDir(t, "crash-exit-producer");
  const root = join(home, "Remudero");
  const tree = join(root, "remudero");
  const stubs = join(home, "stubs");
  for (const rel of [".git", "node_modules/.bin", "bin"]) mkdirSync(join(tree, rel), { recursive: true });
  mkdirSync(stubs);
  symlinkSync(dirname(ledgerPath), join(root, "state"), "dir");
  writeFileSync(join(tree, "node_modules/.bin/tsx"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(stubs, "npm"), "#!/bin/bash\necho 'unexpected npm call' >&2\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(stubs, "git"), `#!/bin/bash
case "$*" in
  *'config --get user.name'*) echo fixture ;;
  *'config --get user.email'*) echo fixture@example.invalid ;;
  *'rev-parse --is-bare-repository'*) echo false ;;
  *'rev-parse'*) echo 0123456789012345678901234567890123456789 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(stubs, "date"), `#!/bin/bash\necho ${iso(bootMs + lifetimeMs)}\n`, { mode: 0o755 });
  writeFileSync(join(stubs, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const bootRow = { ts: iso(bootMs), run_id: runId, task_id: "DAEMON", step: "daemon.boot" };
  const memoryRow = { ts: iso(bootMs + lifetimeMs), run_id: runId, task_id: "DAEMON", step: "daemon.memory",
    heap: { used_bytes: HEAP_LIMIT * 0.97, limit_bytes: HEAP_LIMIT }, rss_bytes: 8_000_000_000 };
  writeFileSync(join(tree, "bin/rmd"), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({...${JSON.stringify(bootRow)}, pid: process.pid}) + '\\n');
fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify(${JSON.stringify(memoryRow)}) + '\\n');
process.stderr.write(${JSON.stringify(heapLine + "\n")});
process.exit(${exitCode});
`, { mode: 0o755 });
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RMD_")));
  const result = spawnSync("bash", [join(REPO_ROOT, "deploy/entrypoint.sh"), "./bin/rmd", "daemon"], {
    encoding: "utf8", timeout: 30_000,
    env: { ...ambient, HOME: home, PATH: `${stubs}:${process.env.PATH}`, RMD_RESTART_THROTTLE_S: "1",
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  assert.equal(result.status, exitCode, result.stderr);
  assert.ok(result.stderr.includes(heapLine), "stderr still reaches docker logs");
}

async function drain(ledgerPath: string, issues: ReturnType<typeof recordingGateway>) {
  return withDaemonCrashLoopClear(() => drainEscalationSpool(dirname(ledgerPath), {
    clock: fixedClock(START), escalate: async () => { throw new Error("unexpected escalation"); },
    close: async (url, body) => { issues.closeWithComment!(url, body); },
    comment: async () => { throw new Error("unexpected comment"); },
  }), { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-healthy", issues })();
}

function recordingGateway(): IssueGateway & {
  created: Array<{ title: string; body: string }>;
  comments: Array<{ url: string; body: string }>;
  closed: Array<{ url: string; comment: string }>;
} {
  const created: Array<{ title: string; body: string }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  return {
    created,
    comments,
    closed,
    create(title, body) {
      created.push({ title, body });
      return `https://github.com/o/r/issues/${created.length}`;
    },
    comment(url, body) {
      comments.push({ url, body });
    },
    closeWithComment(url, comment) {
      closed.push({ url, comment });
    },
  };
}

function lines(ledgerPath: string): Array<Record<string, unknown>> {
  let text = "";
  try {
    text = readFileSync(ledgerPath, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const row = (ledgerPath: string, r: Record<string, unknown>): void => appendFileSync(ledgerPath, JSON.stringify(r) + "\n");
const iso = (ms: number): string => new Date(ms).toISOString();

/** One daemon process: its boot, a tick and a heap sample each minute, and a clean-exit row iff it ended on purpose. */
function writeProcess(ledgerPath: string, runId: string, bootMs: number, lifetimeMs: number, clean: boolean): void {
  row(ledgerPath, { ts: iso(bootMs), run_id: runId, task_id: "DAEMON", step: "daemon.boot" });
  for (let t = MIN; t <= lifetimeMs; t += MIN) {
    row(ledgerPath, { ts: iso(bootMs + t), run_id: runId, task_id: "DAEMON", step: "daemon.tick" });
    row(ledgerPath, {
      ts: iso(bootMs + t), run_id: runId, task_id: "DAEMON", step: "daemon.memory", rss_bytes: 2_000_000_000 + t,
      heap: { used_bytes: Math.round(HEAP_LIMIT * (t / lifetimeMs) * 0.97), limit_bytes: HEAP_LIMIT },
    });
  }
  if (clean) row(ledgerPath, { ts: iso(bootMs + lifetimeMs), run_id: runId, task_id: "DAEMON", step: "daemon.summary", stopReason: "stale" });
}

/** A boot: the sentinel judges the tail exactly as the daemon's pre-boot snapshot would. */
function boot(ledgerPath: string, runId: string, bootMs: number, issues: IssueGateway) {
  const ctx: CrashSentinelCtx = { owner: "o", repo: "r", ledgerPath, runId, issues };
  return runDaemonCrashSentinel(lines(ledgerPath), iso(bootMs), ctx);
}

/** Rotate the way the live ledger does: everything but retained steps and the newest boot leaves the live file. The
 *  ceiling sits above the retained core and below a few processes' rows, as the real one does. */
function rotate(ledgerPath: string, nowMs: number): void {
  const result = rotateLedger(ledgerPath, { ceilingBytes: 32 * 1024, smoothingWindowMs: 0, now: () => new Date(nowMs) });
  assert.equal(lines(ledgerPath).some((l) => l.step === "daemon.tick"), !result.rotated, "a rotation leaves no tick behind");
}

/** A learned history: six processes that ended cleanly after 50-100 minutes. */
function healthyHistory(ledgerPath: string, startMs: number, issues: IssueGateway): number {
  let at = startMs;
  const lifetimes = [50, 60, 70, 80, 90, 100];
  lifetimes.forEach((m, i) => {
    boot(ledgerPath, `DAEMON-h${i}`, at, issues);
    writeProcess(ledgerPath, `DAEMON-h${i}`, at, m * MIN, true);
    at += m * MIN + 30_000;
  });
  return at;
}

const START = Date.parse("2026-11-05T00:00:00.000Z");

test("W1-T11421: 29 abnormal exits 15-28 min apart raise exactly one incident, though no ten-minute window holds six boots", (t) => {
  {
    const ledgerPath = writeLedger([], { scope: t }).path;
    const issues = recordingGateway();
    let at = healthyHistory(ledgerPath, START, issues);
    const boots: string[] = [];
    for (let i = 0; i < 29; i++) {
      const runId = `DAEMON-c${i}`;
      boot(ledgerPath, runId, at, issues);
      boots.push(iso(at));
      const lifetime = (15 + ((i * 7) % 14)) * MIN; // 15-28 minutes, no clean-exit row
      writeProcess(ledgerPath, runId, at, lifetime, false);
      if (i % 4 === 3) rotate(ledgerPath, at + lifetime); // about hourly, as the live ledger rotates
      at += lifetime + 2 * MIN;
    }
    const verdict = boot(ledgerPath, "DAEMON-next", at, issues);

    // The old window never fires on this shape: that is the defect.
    assert.equal(detectDaemonCrashLoop(boots).breached, false);
    assert.equal(issues.created.length, 1, "exactly one incident for the whole run");
    assert.equal(issues.created[0].title, `[BLOCKED] DAEMON: ${LEARNED_CRASHLOOP_SUMMARY}`);
    assert.match(issues.created[0].body, /DAEMON-c0: booted .* lived \d+ min/);
    assert.match(issues.created[0].body, /heap \d+ of 7191 MiB in force \(\d+%\)/);
    assert.match(issues.created[0].body, /exit code unknown \(no entrypoint wait status recorded/);
    const abnormal = lines(ledgerPath).filter((l) => l.step === "daemon.crash.abnormal_exit");
    assert.equal(abnormal.length, 29, "every abnormal exit ledgers its row, rotation notwithstanding");
    assert.equal(verdict.summary?.runLength, 29);
    assert.equal(verdict.incident?.issueUrl, "https://github.com/o/r/issues/1");
  }
});

test("W1-T11421 criterion 2: each further abnormal exit updates the one incident with its evidence and opens no second issue", (t) => {
  {
    const ledgerPath = writeLedger([], { scope: t }).path;
    const issues = recordingGateway();
    let at = healthyHistory(ledgerPath, START, issues);
    for (let i = 0; i < 6; i++) {
      boot(ledgerPath, `DAEMON-c${i}`, at, issues);
      containerProcess(t, ledgerPath, `DAEMON-c${i}`, at, 20 * MIN, i % 2 === 0 ? 134 : 137, `${HEAP_FATAL} (exit ${i})`);
      at += 22 * MIN;
    }
    boot(ledgerPath, "DAEMON-next", at, issues);
    assert.equal(issues.created.length, 1);
    // The run opens at its second exit; the four after it are appended to that one issue.
    assert.equal(issues.comments.length, 4);
    assert.ok(issues.created[0].body.includes(`exit code 134`));
    assert.ok(issues.created[0].body.includes(`exit code 137`));
    assert.ok(issues.created[0].body.includes(`${HEAP_FATAL} (exit 0)`));
    assert.ok(issues.created[0].body.includes(`${HEAP_FATAL} (exit 1)`));
    for (const [index, c] of issues.comments.entries()) {
      assert.equal(c.url, "https://github.com/o/r/issues/1");
      assert.match(c.body, /lived 20 min .*last daemon\.memory sample .*heap 6975 of 7191 MiB in force/);
      assert.ok(c.body.includes(`exit code ${index % 2 === 0 ? 134 : 137}`));
      assert.ok(c.body.includes(`${HEAP_FATAL} (exit ${index + 2})`));
    }
    const updated = lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.updated");
    assert.deepEqual(updated.map((l) => l.prior_run_id), ["DAEMON-c2", "DAEMON-c3", "DAEMON-c4", "DAEMON-c5"]);
    assert.deepEqual(updated.map((l) => l.run_length), [3, 4, 5, 6]);
    assert.deepEqual(updated.map((l) => l.exit_code), [134, 137, 134, 137]);
    assert.deepEqual(updated.map((l) => l.heap_limit_line), [2, 3, 4, 5].map((i) => `${HEAP_FATAL} (exit ${i})`));
    assert.ok(updated.every((l) => l.lifetime_ms === 20 * MIN && (l.last_memory as { heap_limit_bytes: number }).heap_limit_bytes === HEAP_LIMIT));
    boot(ledgerPath, "DAEMON-again", at + MIN, issues);
    assert.equal(issues.created.length, 1);
    assert.equal(issues.comments.length, 4, "observed exits are never appended twice");
  }
});

test("W1-T11421 criterion 2: a single abnormal exit after a long lifetime only ledgers a row", (t) => {
  {
    const ledgerPath = writeLedger([], { scope: t }).path;
    const issues = recordingGateway();
    let at = healthyHistory(ledgerPath, START, issues);
    boot(ledgerPath, "DAEMON-long", at, issues);
    writeProcess(ledgerPath, "DAEMON-long", at, 300 * MIN, false); // killed after five hours
    at += 302 * MIN;
    const verdict = boot(ledgerPath, "DAEMON-next", at, issues);
    assert.equal(issues.created.length, 0);
    assert.equal(verdict.summary?.incident, "none");
    const abnormal = lines(ledgerPath).filter((l) => l.step === "daemon.crash.abnormal_exit");
    assert.equal(abnormal.length, 1);
    assert.equal(abnormal[0].prior_run_id, "DAEMON-long");
    assert.equal(abnormal[0].lifetime_ms, 300 * MIN);
    assert.equal((abnormal[0].last_memory as { heap_limit_bytes: number }).heap_limit_bytes, HEAP_LIMIT);
  }
});

test("W1-T11421 criterion 2: a killed container supplies its real status without inventing a heap failure", (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const issues = recordingGateway();
  const at = healthyHistory(ledgerPath, START, issues);
  containerProcess(t, ledgerPath, "DAEMON-killed", at, 200 * MIN, 137, "Killed");
  boot(ledgerPath, "DAEMON-next", at + 202 * MIN, issues);
  const abnormal = lines(ledgerPath).filter((l) => l.step === "daemon.crash.abnormal_exit");
  assert.equal(abnormal.length, 1);
  assert.equal(abnormal[0].exit_code, 137);
  assert.equal(abnormal[0].heap_limit_line, null);
  assert.equal(abnormal[0].lifetime_ms, 200 * MIN);
  assert.equal(issues.created.length, 0);
});

test("W1-T11421: a healthy, long-lived boot history raises nothing", (t) => {
  {
    const ledgerPath = writeLedger([], { scope: t }).path;
    const issues = recordingGateway();
    let at = healthyHistory(ledgerPath, START, issues);
    for (let i = 0; i < 20; i++) {
      boot(ledgerPath, `DAEMON-ok${i}`, at, issues);
      writeProcess(ledgerPath, `DAEMON-ok${i}`, at, (45 + ((i * 13) % 60)) * MIN, true);
      at += (45 + ((i * 13) % 60)) * MIN + 30_000;
      rotate(ledgerPath, at);
    }
    boot(ledgerPath, "DAEMON-next", at, issues);
    assert.equal(issues.created.length + issues.comments.length + issues.closed.length, 0);
    assert.equal(lines(ledgerPath).filter((l) => l.step === "daemon.clean_exit.observed").length, 26);
    assert.equal(lines(ledgerPath).filter((l) => l.step === "daemon.crash.abnormal_exit").length, 0, "a rotation never turns a clean end into a crash");
  }
});

test("W1-T11421 criterion 3: the incident closes itself once the running process outlives the learned clean lifetime", async (t) => {
  {
    const ledgerPath = writeLedger([], { scope: t }).path;
    const issues = recordingGateway();
    let at = healthyHistory(ledgerPath, START, issues);
    for (let i = 0; i < 3; i++) {
      boot(ledgerPath, `DAEMON-c${i}`, at, issues);
      writeProcess(ledgerPath, `DAEMON-c${i}`, at, 18 * MIN, false);
      at += 20 * MIN;
    }
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let cancelled = 0;
    const sentinel = daemonCrashSentinel(lines(ledgerPath), { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-healthy", issues }, {
      setTimer: (fn, ms) => (timers.push({ fn, ms }), {}),
      clearTimer: () => void cancelled++,
      onArmed: (cancel) => cancel,
    });
    const summary = sentinel(iso(at));
    assert.equal(issues.created.length, 1);
    assert.equal(summary?.incident, "updated");
    const learned = learnedCleanLifetime([50, 60, 70, 80, 90, 100].map((m) => m * MIN));
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, learned!.p90Ms + 1, "the clear is armed for when this process outlives the p90");
    timers[0].fn();
    assert.equal(issues.closed.length, 0, "the close is queued through the launcher's spool");
    assert.equal(lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.cleared").length, 0);
    assert.deepEqual(await drain(ledgerPath, issues), { delivered: 1, failed: 0 });
    assert.ok(lines(ledgerPath).some((l) => l.step === "host_escalation.delivered" && l.kind === "close"));
    rotate(ledgerPath, at + learned!.p90Ms + MIN);
    assert.equal(lines(ledgerPath).some((l) => l.step === "host_escalation.delivered" && l.kind === "close"), false,
      "the durable cleared marker survives loss of the transport receipt");
    timers[1].fn();
    assert.equal(issues.closed.length, 1);
    assert.match(issues.closed[0].comment, /DAEMON-healthy outlived the learned p90/);
    const cleared = lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.cleared");
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].run_first, "DAEMON-c0");
    assert.equal(cancelled, 0);
  }
});

test("W1-T11421 criterion 3: another abnormal exit after a long life cannot clear the open incident", (t) => {
  {
    const ledgerPath = writeLedger([], { scope: t }).path;
    const issues = recordingGateway();
    let at = healthyHistory(ledgerPath, START, issues);
    for (let i = 0; i < 2; i++) {
      boot(ledgerPath, `DAEMON-c${i}`, at, issues);
      writeProcess(ledgerPath, `DAEMON-c${i}`, at, 18 * MIN, false);
      at += 20 * MIN;
    }
    boot(ledgerPath, "DAEMON-survivor", at, issues);
    assert.equal(issues.created.length, 1);
    writeProcess(ledgerPath, "DAEMON-survivor", at, 200 * MIN, false);
    at += 202 * MIN;
    const verdict = boot(ledgerPath, "DAEMON-next", at, issues);
    assert.equal(verdict.summary?.incident, "updated");
    assert.equal(issues.closed.length, 0);
    assert.equal(verdict.incident?.issueUrl, "https://github.com/o/r/issues/1");
    assert.equal(lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.cleared").length, 0);
  }
});

test("W1-T11421 criterion 3: a transient close failure remains pending across drains and boots until delivery succeeds", async (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const issues = recordingGateway();
  let at = healthyHistory(ledgerPath, START, issues);
  for (let i = 0; i < 2; i++) {
    boot(ledgerPath, `DAEMON-c${i}`, at, issues);
    writeProcess(ledgerPath, `DAEMON-c${i}`, at, 18 * MIN, false);
    at += 20 * MIN;
  }
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const ctx = { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-healthy", issues };
  daemonCrashSentinel(lines(ledgerPath), ctx, { setTimer: (fn, ms) => (timers.push({ fn, ms }), {}) })(iso(at));
  timers[0].fn();
  assert.equal(timers.length, 2, "a queued close remains eligible for retry");
  const close = issues.closeWithComment!;
  issues.closeWithComment = () => { throw new Error("github unavailable"); };
  assert.deepEqual(await drain(ledgerPath, issues), { delivered: 0, failed: 1 });
  assert.equal(readdirSync(escalationSpoolDir(dirname(ledgerPath))).filter((name) => name.startsWith("close-")).length, 1);
  timers[1].fn();
  assert.equal(timers.length, 3, "a failed close keeps the retry armed");
  assert.equal(lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.cleared").length, 0);
  assert.ok(lines(ledgerPath).some((l) => l.step === "host_escalation.drain_failed" && l.error === "github unavailable"));
  assert.equal(timers[2].ms, timers[0].ms, "retry cadence comes from the learned p90");
  const restarted = boot(ledgerPath, "DAEMON-restarted", at + MIN, issues);
  assert.equal(restarted.incident?.issueUrl, "https://github.com/o/r/issues/1", "failed close does not spend the incident");
  issues.closeWithComment = close;
  assert.deepEqual(await drain(ledgerPath, issues), { delivered: 1, failed: 0 });
  timers[2].fn();
  assert.equal(issues.closed.length, 1);
  assert.equal(issues.closed[0].url, "https://github.com/o/r/issues/1");
  assert.equal(lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.cleared" && l.delivered === true).length, 1);
  assert.equal(boot(ledgerPath, "DAEMON-next", at + 2 * MIN, issues).incident, undefined);
  assert.equal(issues.created.length, 1);
});

test("W1-T11421 criterion 3: recovery withdraws a notice that has not reached an issue", (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const stateDir = dirname(ledgerPath);
  spoolEscalation(stateDir, {
    class: "BLOCKED", taskId: "DAEMON", summary: LEARNED_CRASHLOOP_SUMMARY,
    detail: "an undelivered crash-loop notice", options: [], recommendation: "fix",
  }, { source: "daemon-crashloop", host: "fixture", clock: fixedClock(START) });
  assert.equal(clearDaemonCrashLoopIncident({ runFirst: "DAEMON-c0", issueUrl: null }, "outlived p90", {
    owner: "o", repo: "r", ledgerPath, runId: "DAEMON-healthy", issues: recordingGateway(),
  }), true);
  assert.equal(readdirSync(escalationSpoolDir(stateDir)).filter((name) => name.endsWith(".json")).length, 0);
  assert.ok(lines(ledgerPath).some((l) => l.step === "host_escalation.withdrawn"));
  assert.ok(lines(ledgerPath).some((l) => l.step === "daemon.crashloop.cleared" && l.delivered === false));
});

test("W1-T11421 criterion 3: an unwritable close spool records the failure and rearms instead of losing recovery", async (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const issues = recordingGateway();
  let at = healthyHistory(ledgerPath, START, issues);
  for (let i = 0; i < 2; i++) {
    boot(ledgerPath, `DAEMON-c${i}`, at, issues);
    writeProcess(ledgerPath, `DAEMON-c${i}`, at, 18 * MIN, false);
    at += 20 * MIN;
  }
  const timers: Array<() => void> = [];
  daemonCrashSentinel(lines(ledgerPath), { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-healthy", issues }, {
    setTimer: (fn) => (timers.push(fn), {}),
  })(iso(at));
  const spoolPath = escalationSpoolDir(dirname(ledgerPath));
  writeFileSync(spoolPath, "fixture blocking the close spool");
  timers[0]();
  assert.equal(timers.length, 2, "spool write failure keeps the timer armed");
  assert.ok(lines(ledgerPath).some((l) => l.step === "daemon.crashloop_sentinel_failed" && String(l.error).includes("EEXIST")));
  assert.equal(lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.cleared").length, 0);
  rmSync(spoolPath);
  timers[1]();
  assert.equal(timers.length, 3, "queued recovery remains pending until delivery");
  assert.deepEqual(await drain(ledgerPath, issues), { delivered: 1, failed: 0 });
  timers[2]();
  assert.equal(lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.cleared").length, 1);
});

test("W1-T11421 criterion 3: with no learned history the check keeps today's ten-minute window", async (t) => {
  {
    const ledgerPath = writeLedger([], { scope: t }).path;
    const issues = recordingGateway();
    const base = Date.parse("2026-11-05T10:00:00.000Z");
    // Six boots a minute apart and no clean lifetime yet: the sentinel learns nothing and the window decides.
    for (let i = 0; i < 6; i++) row(ledgerPath, { ts: iso(base + i * MIN), run_id: `DAEMON-s${i}`, task_id: "DAEMON", step: "daemon.boot" });
    const nowIso = iso(base + 6 * MIN);
    assert.deepEqual(runDaemonCrashSentinel(lines(ledgerPath), nowIso, { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-probe", issues }), {});
    const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const breaches: unknown[] = [];
    await daemonBoot((step, extra) => logged.push({ step, extra }), {}, undefined, undefined, undefined, {
      priorBoots: () => lines(ledgerPath).filter((l) => l.step === "daemon.boot").map((l) => String(l.ts)),
      now: () => nowIso,
      onBreach: (v) => breaches.push(v),
      sentinel: daemonCrashSentinel(lines(ledgerPath), { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-now", issues }),
    });
    assert.equal(breaches.length, 1, "the ten-minute window still escalates a fast storm");
    const check = logged.find((l) => l.step === "daemon.crashloop_check");
    assert.equal(check?.extra?.window_ms, DEFAULT_CRASHLOOP_WINDOW.windowMs);
    assert.equal(issues.created.length, 0, "the sentinel itself raised nothing");
  }
});

test("W1-T11421: once a clean lifetime is learned the sentinel decides and the window does not also fire", async (t) => {
  {
    const ledgerPath = writeLedger([], { scope: t }).path;
    const issues = recordingGateway();
    let at = healthyHistory(ledgerPath, START, issues);
    for (let i = 0; i < 6; i++) {
      row(ledgerPath, { ts: iso(at), run_id: `DAEMON-s${i}`, task_id: "DAEMON", step: "daemon.boot" });
      at += MIN;
    }
    const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const breaches: unknown[] = [];
    await daemonBoot((step, extra) => logged.push({ step, extra }), {}, undefined, undefined, undefined, {
      priorBoots: () => lines(ledgerPath).filter((l) => l.step === "daemon.boot").map((l) => String(l.ts)),
      now: () => iso(at),
      onBreach: (v) => breaches.push(v),
      sentinel: daemonCrashSentinel(lines(ledgerPath), { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-now", issues }),
    });
    assert.equal(breaches.length, 0);
    assert.equal(issues.created.length, 1, "one incident, from the sentinel");
    const check = logged.find((l) => l.step === "daemon.crashloop_check");
    assert.equal(check?.extra?.basis, "learned");
    assert.equal(check?.extra?.incident, "opened");
    assert.equal(check?.extra?.run_length, 6);
  }
});

test("W1-T11421: a sentinel that throws is ledgered and leaves the decision to the window", (t) => {
  {
    const ledgerPath = writeLedger([], { scope: t }).path;
    const unreadable = new Proxy({}, { get: () => { throw new Error("torn row"); } }) as Record<string, unknown>;
    const sentinel = daemonCrashSentinel([unreadable], { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-now", issues: recordingGateway() });
    assert.equal(sentinel("2026-11-05T00:30:00.000Z"), undefined);
    const failed = lines(ledgerPath).filter((l) => l.step === "daemon.crashloop_sentinel_failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0].error), /torn row/);
  }
});
