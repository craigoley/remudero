// W1-T11421 — a slow crash loop is reported against the instance's own lifetime.
//
// 2026-11-05: core aborted at its heap limit 29 times in 9 h, each process living 15-28 minutes. No ten-minute window
// ever held six boots, so detectDaemonCrashLoop never fired and nothing alerted. These tests replay that boot pattern
// through the real sentinel, the real ledger and a real rotation, and assert exactly one incident; a healthy history
// must raise none.

import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_CRASHLOOP_WINDOW, daemonBoot, detectDaemonCrashLoop, learnedCleanLifetime } from "#src/lib/daemon.js";
import {
  daemonCrashSentinel,
  LEARNED_CRASHLOOP_SUMMARY,
  runDaemonCrashSentinel,
  type CrashSentinelCtx,
} from "#src/lib/escalation-catalogue.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { rotateLedger } from "#src/lib/ledger.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const MIN = 60_000;
const HEAP_LIMIT = 7_540_310_016;

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
    assert.match(issues.created[0].body, /exit code unknown \(not visible in-container/);
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
      writeProcess(ledgerPath, `DAEMON-c${i}`, at, 20 * MIN, false);
      at += 22 * MIN;
    }
    boot(ledgerPath, "DAEMON-next", at, issues);
    assert.equal(issues.created.length, 1);
    // The run opens at its second exit; the four after it are appended to that one issue.
    assert.equal(issues.comments.length, 4);
    for (const c of issues.comments) {
      assert.equal(c.url, "https://github.com/o/r/issues/1");
      assert.match(c.body, /lived 20 min .*last daemon\.memory sample .*heap-limit line: none in the ledger/);
    }
    const updated = lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.updated");
    assert.deepEqual(updated.map((l) => l.prior_run_id), ["DAEMON-c2", "DAEMON-c3", "DAEMON-c4", "DAEMON-c5"]);
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

test("W1-T11421 criterion 3: the incident closes itself once the running process outlives the learned clean lifetime", (t) => {
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
    assert.equal(timers[0].ms, learned?.p90Ms, "the clear is armed for when this process outlives the p90");
    timers[0].fn();
    assert.equal(issues.closed.length, 1);
    assert.match(issues.closed[0].comment, /DAEMON-healthy outlived the learned p90/);
    const cleared = lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.cleared");
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].run_first, "DAEMON-c0");
    assert.equal(cancelled, 0);
  }
});

test("W1-T11421 criterion 3: a boot after a process that outlived the p90 closes the open incident", (t) => {
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
    assert.equal(verdict.summary?.incident, "cleared");
    assert.equal(issues.closed.length, 1);
    assert.match(issues.closed[0].comment, /DAEMON-survivor lived 200 min, past the learned p90/);
    assert.equal(verdict.incident, undefined);
  }
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
