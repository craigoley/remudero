// W1-T11421 — a slow crash loop is reported against the instance's own lifetime.
//
// 2026-11-05: core aborted at its heap limit 29 times in 9 h, each process living 15-28 minutes. No ten-minute window
// ever held six boots, so detectDaemonCrashLoop never fired and nothing alerted. These tests replay that boot pattern
// through the real sentinel, the real ledger and a real rotation, and assert exactly one incident; a healthy history
// must raise none.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CRASHLOOP_WINDOW, classifyEndedDaemonProcesses, daemonBoot, detectDaemonCrashLoop, learnedCleanLifetime } from "#src/lib/daemon.js";
import {
  daemonCrashSentinel,
  clearDaemonCrashLoopIncident,
  LEARNED_CRASHLOOP_SUMMARY,
  runDaemonCrashSentinel,
  type CrashSentinelCtx,
} from "#src/lib/escalation-catalogue.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { rotateLedger } from "#src/lib/ledger.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { systemClock } from "#src/lib/clock.js";
import { drainEscalationSpool, escalationSpoolDir, spoolEscalation } from "#src/lib/host-escalation-spool.js";

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

/** A daemon can report its fatal outcome before the entrypoint records the failed container exit. */
function writeFatalProcess(ledgerPath: string, runId: string, bootMs: number, lifetimeMs: number): void {
  writeProcess(ledgerPath, runId, bootMs, lifetimeMs, false);
  const end = { ts: iso(bootMs + lifetimeMs), run_id: runId, task_id: "DAEMON" };
  row(ledgerPath, { ...end, step: "daemon.summary", stopReason: "error", stopDetail: "fatal worker defect" });
  row(ledgerPath, { ...end, step: "daemon.process.exit", exit_code: 1, clean_exit: false });
}

/** A boot: the sentinel judges the tail exactly as the daemon's pre-boot snapshot would. */
function boot(ledgerPath: string, runId: string, bootMs: number, issues: IssueGateway) {
  const ctx: CrashSentinelCtx = { owner: "o", repo: "r", ledgerPath, runId, issues };
  const before = lines(ledgerPath);
  const result = runDaemonCrashSentinel(before, iso(bootMs), ctx);
  // Keep the fixture's ledger clock aligned with its process clock, including observation rows.
  const after = lines(ledgerPath);
  for (const r of after.slice(before.length)) r.ts = iso(bootMs);
  writeFileSync(ledgerPath, after.map((r) => JSON.stringify(r) + "\n").join(""));
  return result;
}

function drainComments(ledgerPath: string, issues: IssueGateway) {
  return drainEscalationSpool(dirname(ledgerPath), {
    clock: systemClock,
    escalate: async () => { throw new Error("no escalation expected"); },
    close: async () => { throw new Error("no close expected"); },
    comment: async (url, body) => {
      assert.ok(issues.comment);
      issues.comment(url, body);
    },
  });
}

function drainCloses(ledgerPath: string, issues: IssueGateway) {
  return drainEscalationSpool(dirname(ledgerPath), {
    clock: systemClock,
    escalate: async () => { throw new Error("no escalation expected"); },
    comment: async () => { throw new Error("no comment expected"); },
    close: async (url, comment) => {
      assert.ok(issues.closeWithComment);
      issues.closeWithComment(url, comment);
    },
  });
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
    assert.match(issues.created[0].body, /exit code unknown \(no supervisor exit row/);
    const abnormal = lines(ledgerPath).filter((l) => l.step === "daemon.crash.abnormal_exit");
    assert.equal(abnormal.length, 29, "every abnormal exit ledgers its row, rotation notwithstanding");
    assert.equal(verdict.summary?.runLength, 29);
    assert.equal(verdict.incident?.issueUrl, "https://github.com/o/r/issues/1");
  }
});

test("W1-T11421: fatal summaries and failed supervisor exits still open and update the slow-loop incident", (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const issues = recordingGateway();
  let at = healthyHistory(ledgerPath, START, issues);
  const boots: string[] = [];
  for (let i = 0; i < 3; i++) {
    const runId = `DAEMON-fatal${i}`;
    boot(ledgerPath, runId, at, issues);
    boots.push(iso(at));
    writeFatalProcess(ledgerPath, runId, at, 20 * MIN);
    at += 22 * MIN;
  }
  const verdict = boot(ledgerPath, "DAEMON-after-fatal", at, issues);
  assert.equal(detectDaemonCrashLoop(boots).breached, false);
  assert.equal(verdict.summary?.runLength, 3);
  assert.equal(verdict.summary?.learned.samples, 6, "fatal summaries cannot teach the clean lifetime");
  assert.equal(issues.created.length, 1);
  assert.equal(issues.comments.length, 1);
  assert.match(issues.created[0].body, /DAEMON-fatal0:.*exit code 1/);
  assert.match(issues.created[0].body, /DAEMON-fatal1:.*exit code 1/);
  assert.match(issues.comments[0].body, /DAEMON-fatal2:.*exit code 1/);
  const observed = lines(ledgerPath);
  assert.deepEqual(observed.filter((r) => r.step === "daemon.crash.abnormal_exit" && String(r.prior_run_id).startsWith("DAEMON-fatal"))
    .map((r) => r.prior_run_id), ["DAEMON-fatal0", "DAEMON-fatal1", "DAEMON-fatal2"]);
  assert.equal(observed.filter((r) => r.step === "daemon.clean_exit.observed" && String(r.prior_run_id).startsWith("DAEMON-fatal")).length, 0);
  assert.deepEqual(observed.filter((r) => r.step === "daemon.crashloop.updated").map((r) => r.prior_run_id), ["DAEMON-fatal2"]);
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

test("W1-T11421 retries issue creation after a transient refusal", (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const issues = recordingGateway();
  const create = issues.create;
  let refusals = 1;
  issues.create = (title, body, labels) => {
    if (refusals-- > 0) throw new Error("temporary issue transport refusal");
    return create(title, body, labels);
  };
  let at = healthyHistory(ledgerPath, START, issues);
  for (let i = 0; i < 2; i++) {
    boot(ledgerPath, `DAEMON-retry-create${i}`, at, issues);
    writeProcess(ledgerPath, `DAEMON-retry-create${i}`, at, 20 * MIN, false);
    at += 22 * MIN;
  }
  const refused = boot(ledgerPath, "DAEMON-create-refused", at, issues);
  assert.equal(refused.incident?.issueUrl, null);
  assert.equal(issues.created.length, 0);
  at += MIN;
  const recovered = boot(ledgerPath, "DAEMON-create-retry", at, issues);
  assert.equal(issues.created.length, 1);
  assert.match(recovered.incident?.issueUrl ?? "", /issues\/1$/);
  assert.equal(lines(ledgerPath).filter((r) => r.step === "daemon.crashloop.escalated" && r.issue_url).length, 1);
});

test("W1-T11421 keeps a refused incident comment retryable across ledger rotation", async (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const issues = recordingGateway();
  let at = healthyHistory(ledgerPath, START, issues);
  for (let i = 0; i < 2; i++) {
    boot(ledgerPath, `DAEMON-retry-comment${i}`, at, issues);
    writeProcess(ledgerPath, `DAEMON-retry-comment${i}`, at, 20 * MIN, false);
    at += 22 * MIN;
  }
  boot(ledgerPath, "DAEMON-comment-open", at, issues);
  const comment = issues.comment!;
  let refusals = 1;
  issues.comment = (url, body) => {
    if (refusals-- > 0) throw new Error("temporary comment transport refusal");
    comment(url, body);
  };
  writeProcess(ledgerPath, "DAEMON-comment-failed-run", at, 20 * MIN, false);
  at += 22 * MIN;
  boot(ledgerPath, "DAEMON-comment-refused", at, issues);
  assert.equal(issues.comments.length, 0);
  assert.equal(lines(ledgerPath).filter((r) => r.step === "daemon.crashloop.updated" && r.delivered === false && r.queued === true).length, 1);
  assert.equal(readdirSync(escalationSpoolDir(dirname(ledgerPath))).filter((name) => name.endsWith(".json")).length, 1);

  for (let n = 0; n < 400; n++) row(ledgerPath, { ts: iso(at), run_id: "noise", step: "fixture.noise", payload: "x".repeat(150) });
  const rotated = rotateLedger(ledgerPath, { ceilingBytes: 32 * 1024, smoothingWindowMs: 0, now: () => new Date(at + 30 * MIN) });
  assert.equal(rotated.rotated, true);
  assert.equal(lines(ledgerPath).some((r) => r.step === "daemon.crashloop.updated" && r.prior_run_id === "DAEMON-comment-failed-run"), false,
    "positive control: rotation discarded the pending ledger marker");

  at += MIN;
  boot(ledgerPath, "DAEMON-comment-after-rotation", at, issues);
  assert.deepEqual(await drainComments(ledgerPath, issues), { delivered: 1, failed: 0 });
  assert.equal(issues.comments.length, 1);
  assert.match(issues.comments[0].body, /DAEMON-comment-failed-run/);
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
    assert.equal(timers[0].ms, learned!.p90Ms + 1, "the clear is armed strictly past the p90");
    timers[0].fn();
    assert.equal(issues.closed.length, 0, "recovery queues a durable close before clearing");
    assert.deepEqual(await drainCloses(ledgerPath, issues), { delivered: 1, failed: 0 });
    assert.equal(issues.closed.length, 1);
    assert.match(issues.closed[0].comment, /DAEMON-healthy outlived the learned p90/);
    const cleared = lines(ledgerPath).filter((l) => l.step === "daemon.crashloop.cleared");
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].run_first, "DAEMON-c0");
    assert.equal(cancelled, 0);
  }
});

test("W1-T11421 criterion 3: a boot after a clean process that outlived the p90 closes the open incident", async (t) => {
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
    writeProcess(ledgerPath, "DAEMON-survivor", at, 200 * MIN, true);
    at += 202 * MIN;
    const verdict = boot(ledgerPath, "DAEMON-next", at, issues);
    assert.equal(verdict.summary?.incident, "cleared");
    assert.deepEqual(await drainCloses(ledgerPath, issues), { delivered: 1, failed: 0 });
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
    // Six fatal summaries a minute apart must not become learned clean samples.
    for (let i = 0; i < 6; i++) writeFatalProcess(ledgerPath, `DAEMON-s${i}`, base + i * MIN, 15_000);
    const nowIso = iso(base + 6 * MIN);
    assert.deepEqual(runDaemonCrashSentinel(lines(ledgerPath), nowIso, { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-probe", issues }), {});
    assert.equal(lines(ledgerPath).filter((r) => r.step === "daemon.crash.abnormal_exit").length, 6);
    assert.equal(lines(ledgerPath).filter((r) => r.step === "daemon.clean_exit.observed").length, 0);
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

test("W1-T11421: a boot-only tail never counts restart downtime as lifetime", () => {
  const bootRow = { ts: iso(START), run_id: "DAEMON-only", step: "daemon.boot" };
  const [end] = classifyEndedDaemonProcesses([bootRow], iso(START + 100 * MIN));
  assert.equal(end.lifetimeMs, 0);
  assert.equal(end.endedTs, bootRow.ts);
  assert.equal(end.endedBasis, "last_row");
  assert.equal(classifyEndedDaemonProcesses([{ ...bootRow, run_id: "WORKER-1" }], iso(START + MIN)).length, 0);
});

test("W1-T11421: fatal summaries and explicit failed exits are not clean lifetime samples", () => {
  const boot = { ts: iso(START), run_id: "DAEMON-fatal", task_id: "DAEMON", step: "daemon.boot" };
  const summary = { ...boot, ts: iso(START + MIN), step: "daemon.summary", stopReason: "error" };
  const next = iso(START + 2 * MIN);
  assert.equal(classifyEndedDaemonProcesses([boot, summary], next)[0].cleanStep, undefined,
    "an error summary alone is an abnormal end");
  const failed = { ...summary, step: "daemon.process.exit", exit_code: 1, clean_exit: false };
  assert.equal(classifyEndedDaemonProcesses([boot, { ...summary, stopReason: "stale" }, failed], next)[0].cleanStep, undefined,
    "the supervisor's failed exit outranks an otherwise clean summary");
  assert.equal(classifyEndedDaemonProcesses([boot, { ...summary, stopReason: "blocked" }], next)[0].cleanStep, undefined,
    "only known clean summary stop reasons can teach clean history");
  const incomplete = { ...summary, step: "daemon.process.exit", exit_code: 75 };
  assert.equal(classifyEndedDaemonProcesses([boot, { ...summary, stopReason: "stale" }, incomplete], next)[0].cleanStep, undefined,
    "an incomplete supervisor receipt cannot fall back to summary evidence");
});

test("W1-T11421: rotation preserves the last row and heap sample before a long restart gap", (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const issues = recordingGateway();
  let at = healthyHistory(ledgerPath, START, issues);
  for (let i = 0; i < 3; i++) {
    const runId = `DAEMON-gap${i}`;
    boot(ledgerPath, runId, at, issues);
    writeProcess(ledgerPath, runId, at, 20 * MIN, false);
    const endedTs = iso(at + 20 * MIN);
    // The last row is deliberately not a memory row; both must survive two real rotations.
    row(ledgerPath, { ts: endedTs, run_id: runId, task_id: "DAEMON", step: "daemon.tick" });
    for (let pass = 0; pass < 2; pass++) {
      for (let n = 0; n < 400; n++) row(ledgerPath, { ts: endedTs, run_id: "noise", step: "fixture.noise", payload: "x".repeat(150) });
      const rotated = rotateLedger(ledgerPath, { ceilingBytes: 32 * 1024, smoothingWindowMs: 0, now: () => new Date(at + 100 * MIN) });
      assert.equal(rotated.rotated, true, "positive control: this really discarded process rows");
    }
    assert.equal(lines(ledgerPath).filter((r) => r.run_id === runId && r.step === "daemon.tick").length, 1);
    assert.equal(lines(ledgerPath).filter((r) => r.run_id === runId && r.step === "daemon.memory").length, 1);
    at += 120 * MIN;
  }
  const verdict = boot(ledgerPath, "DAEMON-after-gap", at, issues);
  const abnormal = lines(ledgerPath).filter((r) => r.step === "daemon.crash.abnormal_exit");
  assert.deepEqual(abnormal.map((r) => r.lifetime_ms), [20 * MIN, 20 * MIN, 20 * MIN]);
  assert.equal(verdict.summary?.runLength, 3);
  assert.equal(issues.created.length, 1);
  assert.equal(issues.comments.length, 1);
});

test("W1-T11421 criterion 2: the real entrypoint supplies each exit code and heap-limit stderr to one incident", (t) => {
  // @source-text-subject: deploy/entrypoint.sh is the executed supervisor under test.
  const source = readFileSync(join(REPO_ROOT, "deploy/entrypoint.sh"), "utf8");
  const boundary = source.indexOf("# ── Signal forwarding");
  assert.ok(boundary > 0, "the real supervision section must exist");
  const fixture = writeLedger([], { scope: t });
  const stateRoot = join(fixture.dir, "instance");
  const stateDir = join(stateRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const issues = recordingGateway();
  healthyHistory(ledgerPath, START, issues);
  mkdirSync(join(fixture.dir, "bin"));
  writeFileSync(join(fixture.dir, "bin/rmd"), `#!/usr/bin/env bash
exec node --input-type=commonjs - <<'CHILD'
const fs = require('node:fs');
const ts = new Date().toISOString();
const base = { ts, run_id: process.env.REMUDERO_RUN_ID, task_id: 'DAEMON' };
const rows = [{ ...base, step: 'daemon.boot' },
  { ...base, step: 'daemon.memory', heap: { used_bytes: 7300000000, limit_bytes: ${HEAP_LIMIT} }, rss_bytes: 8000000000 }];
fs.appendFileSync(process.env.TEST_LEDGER, rows.map(r => JSON.stringify(r) + '\\n').join(''));
console.error(process.env.TEST_HEAP_LINE);
process.exit(Number(process.env.TEST_EXIT_CODE));
CHILD
`, { mode: 0o755 });
  const shell = `set -euo pipefail
CONFIG_ROOT="$TEST_STATE_ROOT"
TREE="$PWD"
supervise_daemon=1
RESTART_THROTTLE_S=0
DAEMON_EXIT_STALE=75
DAEMON_EXIT_BLOCKED=76
DAEMON_EXIT_ENVIRONMENTAL=77
DAEMON_EXIT_IDLE_STARVED=78
FRESHNESS_RESTART_MAX=0
BLOCKED_RESTART_MAX=0
ENVIRONMENTAL_RESTART_MAX=0
log() { printf '%s\\n' "$*" >&2; }
die() { log "$*"; exit 1; }
${source.slice(boundary)}`;
  const codes = [134, 137, 139];
  for (const code of codes) {
    const heapLine = `FATAL ERROR: Reached heap limit Allocation failed (fixture exit ${code})`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RMD_")));
    const child = spawnSync("bash", ["-c", shell, "supervisor", "./bin/rmd", "daemon"], {
      cwd: fixture.dir, encoding: "utf8", env: { ...env, TEST_STATE_ROOT: stateRoot, TEST_LEDGER: ledgerPath,
        TEST_EXIT_CODE: String(code), TEST_HEAP_LINE: heapLine }, timeout: 10_000,
    });
    assert.equal(child.status, code, child.stderr);
    assert.match(child.stderr, /FATAL ERROR: Reached heap limit/, "stderr still reaches container logs");
    const exit = lines(ledgerPath).filter((r) => r.step === "daemon.process.exit").at(-1)!;
    assert.equal(exit.exit_code, code);
    assert.equal(exit.heap_limit_line, heapLine);
    assert.equal(exit.clean_exit, false);
    boot(ledgerPath, "DAEMON-check", Date.now(), issues);
  }
  const abnormal = lines(ledgerPath).filter((r) => r.step === "daemon.crash.abnormal_exit");
  assert.deepEqual(abnormal.map((r) => r.exit_code), codes);
  for (const exit of abnormal) {
    assert.ok(Number(exit.lifetime_ms) >= 0 && Number(exit.lifetime_ms) < MIN);
    assert.equal(exit.heap_limit_bytes, HEAP_LIMIT);
    assert.equal((exit.last_memory as { heap_used_bytes: number }).heap_used_bytes, 7300000000);
  }
  assert.equal(issues.created.length, 1);
  assert.match(issues.created[0].body, /exit code 134.*heap-limit line: FATAL ERROR: Reached heap limit/);
  assert.match(issues.created[0].body, /exit code 137.*heap-limit line: FATAL ERROR: Reached heap limit/);
  assert.equal(issues.comments.length, 1);
  assert.match(issues.comments[0].body, /exit code 139.*heap-limit line: FATAL ERROR: Reached heap limit/);
  assert.equal(readdirSync(stateDir).some((name) => name.startsWith(".daemon-heap-line-")), false);
});

test("W1-T11421 criterion 3: a refused close stays durable across the cleared marker and a later boot", async (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const issues = recordingGateway();
  const ctx: CrashSentinelCtx = { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-recovered", issues };
  const incident = { runFirst: "DAEMON-c0", issueUrl: "https://github.com/o/r/issues/1" };
  row(ledgerPath, { step: "daemon.crashloop.escalated", basis: "learned", run_first: incident.runFirst, issue_url: incident.issueUrl });
  clearDaemonCrashLoopIncident(incident, "recovered past p90", ctx);
  const refuse = recordingGateway();
  refuse.closeWithComment = () => { throw new Error("github transport unavailable"); };
  assert.deepEqual(await drainCloses(ledgerPath, refuse), { delivered: 0, failed: 1 });
  const pending = readdirSync(escalationSpoolDir(dirname(ledgerPath))).filter((n) => n.endsWith(".json"));
  assert.equal(pending.length, 1);
  const action = JSON.parse(readFileSync(join(escalationSpoolDir(dirname(ledgerPath)), pending[0]), "utf8"));
  assert.equal(action.kind, "close");
  assert.equal(action.url, incident.issueUrl);
  assert.match(String(lines(ledgerPath).find((r) => r.step === "host_escalation.drain_failed")?.error), /github transport unavailable/);
  boot(ledgerPath, "DAEMON-later", START + MIN, issues);
  assert.deepEqual(await drainCloses(ledgerPath, issues), { delivered: 1, failed: 0 });
  assert.equal(issues.closed.length, 1);
  assert.equal(readdirSync(escalationSpoolDir(dirname(ledgerPath))).filter((n) => n.endsWith(".json")).length, 0);
});

test("W1-T11421 criterion 3: recovery withdraws an undelivered escalation without posting or closing", (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  spoolEscalation(dirname(ledgerPath), { class: "BLOCKED", taskId: "DAEMON", summary: LEARNED_CRASHLOOP_SUMMARY,
    detail: "crash loop", options: [], recommendation: "repair" }, { source: "fixture", host: "fixture", clock: systemClock });
  clearDaemonCrashLoopIncident({ runFirst: "DAEMON-c0", issueUrl: null }, "recovered", {
    owner: "o", repo: "r", ledgerPath, runId: "DAEMON-recovered", issues: recordingGateway(),
  });
  assert.equal(readdirSync(escalationSpoolDir(dirname(ledgerPath))).filter((n) => n.endsWith(".json")).length, 0);
  assert.equal(lines(ledgerPath).filter((r) => r.step === "daemon.crashloop.cleared").length, 1);
});

test("W1-T11421 criterion 3: another abnormal exit prevents recovery even after a long lifetime", (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const issues = recordingGateway();
  let at = healthyHistory(ledgerPath, START, issues);
  for (let i = 0; i < 2; i++) {
    boot(ledgerPath, `DAEMON-c${i}`, at, issues);
    writeProcess(ledgerPath, `DAEMON-c${i}`, at, 20 * MIN, false);
    at += 22 * MIN;
  }
  boot(ledgerPath, "DAEMON-long", at, issues);
  writeProcess(ledgerPath, "DAEMON-long", at, 200 * MIN, false);
  const timers: Array<() => void> = [];
  const sentinel = daemonCrashSentinel(lines(ledgerPath), { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-running", issues }, {
    setTimer: (fn) => (timers.push(fn), {}),
  });
  const summary = sentinel(iso(at + 202 * MIN));
  assert.equal(summary?.incident, "updated", "a long abnormal process is still an abnormal exit");
  assert.equal(timers.length, 1);
  row(ledgerPath, { step: "daemon.crash.abnormal_exit", prior_run_id: "DAEMON-later-crash" });
  timers[0]();
  assert.equal(lines(ledgerPath).some((r) => r.step === "daemon.crashloop.cleared"), false);
  assert.equal(issues.closed.length, 0);
});

test("W1-T11421 criterion 3: a failed durable handoff keeps the incident open and retries on the learned interval", async (t) => {
  const ledgerPath = writeLedger([], { scope: t }).path;
  const issues = recordingGateway();
  let at = healthyHistory(ledgerPath, START, issues);
  for (let i = 0; i < 2; i++) {
    boot(ledgerPath, `DAEMON-c${i}`, at, issues);
    writeProcess(ledgerPath, `DAEMON-c${i}`, at, 20 * MIN, false);
    at += 22 * MIN;
  }
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const sentinel = daemonCrashSentinel(lines(ledgerPath), { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-running", issues }, {
    setTimer: (fn, ms) => (timers.push({ fn, ms }), {}),
  });
  assert.equal(sentinel(iso(at))?.incident, "opened");
  const spool = escalationSpoolDir(dirname(ledgerPath));
  writeFileSync(spool, "blocks the spool directory");
  timers[0].fn();
  assert.equal(lines(ledgerPath).some((r) => r.step === "daemon.crashloop.cleared"), false);
  assert.match(String(lines(ledgerPath).find((r) => r.step === "daemon.crashloop_sentinel_failed")?.error), /queue recovery close:/);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, timers[0].ms);
  rmSync(spool);
  timers[1].fn();
  assert.equal(lines(ledgerPath).filter((r) => r.step === "daemon.crashloop.cleared").length, 1);
  assert.deepEqual(await drainCloses(ledgerPath, issues), { delivered: 1, failed: 0 });
});


/** Execute the repository's supervisor with only private fixture children and writers. */
async function observedStderrSupervisor(t: import("node:test").TestContext, options: {
  held: boolean; freshness?: boolean; code: number; payload: Buffer;
}) {
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const fixture = writeLedger([], { scope: t });
  const root = fixture.dir;
  const stateRoot = join(root, "instance");
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  const ledgerPath = join(stateRoot, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  writeFileSync(join(root, "payload.bin"), options.payload);
  const writerPath = join(root, "writer.pid");
  const nextPath = join(root, "next-started");
  const countPath = join(root, "starts");
  const syncPath = join(root, "syncs");
  const scriptPath = join(root, "child.cjs");
  writeFileSync(scriptPath, String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const root = process.env.TEST_CASE_ROOT;
const countPath = root + "/starts";
const n = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
fs.writeFileSync(countPath, String(n));
if (n === 1) {
  fs.writeSync(2, fs.readFileSync(root + "/payload.bin"));
  if (process.env.TEST_HELD === "1") {
    const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "ignore", "inherit"] });
    fs.writeFileSync(root + "/writer.pid", String(writer.pid));
    writer.unref();
  }
  process.exit(Number(process.env.TEST_CHILD_CODE));
}
fs.writeFileSync(root + "/next-started", "started");
process.exit(0);
`);
  // @source-text-subject: this is the actual supervision section, not a substitute observer.
  const source = readFileSync(join(REPO_ROOT, "deploy/entrypoint.sh"), "utf8");
  const boundary = source.indexOf("# ── Signal forwarding");
  assert.ok(boundary > 0);
  const shell = String.raw`set -euo pipefail
CONFIG_ROOT="$TEST_STATE_ROOT"
TREE="$TEST_REPO_ROOT"
REF=fixture
supervise_daemon=1
RESTART_THROTTLE_S=0
DAEMON_EXIT_STALE=75
DAEMON_EXIT_BLOCKED=76
DAEMON_EXIT_ENVIRONMENTAL=77
DAEMON_EXIT_IDLE_STARVED=78
FRESHNESS_RESTART_MAX="$TEST_FRESHNESS"
FRESHNESS_RESTART_PAUSE_S=0
BLOCKED_RESTART_MAX=0
ENVIRONMENTAL_RESTART_MAX=0
log() { :; }
die() { printf '%s\n' "$*" >&2; exit 1; }
sync_tree() { printf 'sync\n' >> "$TEST_SYNC_PATH"; }
resolve_rmd_on_path() { :; }
` + source.slice(boundary);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RMD_")));
  const child = spawn("bash", ["-c", shell, "private-supervisor", process.execPath, scriptPath], {
    cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, TEST_CASE_ROOT: root, TEST_STATE_ROOT: stateRoot, TEST_REPO_ROOT: REPO_ROOT,
      TEST_SYNC_PATH: syncPath, TEST_HELD: options.held ? "1" : "0",
      TEST_FRESHNESS: options.freshness ? "1" : "0", TEST_CHILD_CODE: String(options.code) },
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdout.resume();
  let closed = false;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  async function until(check: () => boolean, milliseconds = 10_000): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const finish = (value: boolean, error?: unknown) => {
        clearTimeout(timer); clearInterval(poll);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(false), milliseconds);
      const poll = setInterval(() => {
        try { if (check()) finish(true); } catch (error) { finish(false, error); }
      }, 20);
    });
  }
  const writerAlive = () => {
    if (!existsSync(writerPath)) return false;
    try { process.kill(Number(readFileSync(writerPath, "utf8")), 0); return true; } catch { return false; }
  };
  t.after(async () => {
    // The ledger fixture may already have removed its files; the private process group is ours.
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* private group already ended */ }
    if (!closed && !await until(() => closed, 5_000)) {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* private group already ended */ }
    }
    await done;
  });
  return { ledgerPath, stateRoot, writerAlive, nextPath, countPath, syncPath, until,
    exists: existsSync, done, output: () => Buffer.concat(stderr) };
}

test("W1-T12031 criterion 1: real exit evidence precedes inherited-writer EOF", async (t) => {
  const heap = "FATAL ERROR: Reached heap limit private held-writer fixture";
  const run = await observedStderrSupervisor(t, { held: true, code: 134, payload: Buffer.from(heap + "\n") });
  assert.equal(await run.until(run.writerAlive), true, "positive control: a private writer retains stderr");
  assert.equal(await run.until(() => lines(run.ledgerPath).some((r) => r.step === "daemon.process.exit")), true,
    "actual child exit must be recorded while the writer is still open");
  assert.equal(run.writerAlive(), true, "exit observation did not terminate the inherited writer");
  const exit = lines(run.ledgerPath).find((r) => r.step === "daemon.process.exit")!;
  assert.equal(exit.exit_code, 134);
  assert.equal(exit.clean_exit, false);
  assert.equal(exit.heap_limit_line, heap);
  assert.deepEqual(await run.done, { code: 134, signal: null });
});

test("W1-T12031 criterion 2: ordinary EOF forwards exact raw bytes and retains only the last bounded heap line", async (t) => {
  for (const withHeap of [true, false]) await t.test(withHeap ? "last bounded heap evidence" : "absent evidence stays absent", async (t) => {
    const lastHeap = "FATAL heap limit " + "x".repeat(600);
    const payload = Buffer.concat([
      Buffer.from([0x61, 0xff, 0x00, 0x62, 0x0d, 0x0a]),
      Buffer.alloc(512 * 1024, 0x7a), Buffer.from("\r\n"),
      ...(withHeap ? [Buffer.from("first heap limit old line\n" + lastHeap + "\n")] : []),
    ]);
    const code = withHeap ? 139 : 137;
    const run = await observedStderrSupervisor(t, { held: false, code, payload });
    assert.deepEqual(await run.done, { code, signal: null });
    assert.equal(Buffer.compare(run.output(), Buffer.concat([payload, Buffer.from("\n")])), 0,
      "all bytes, invalid UTF-8, NUL, CRLF and the supervisor's separator survive output backpressure");
    const exit = lines(run.ledgerPath).find((r) => r.step === "daemon.process.exit")!;
    assert.equal(exit.exit_code, code);
    assert.equal(exit.clean_exit, false);
    assert.equal(exit.heap_limit_line, withHeap ? lastHeap.slice(0, 240) : null);
    assert.equal(readdirSync(join(run.stateRoot, "state")).some((name) => name.startsWith(".daemon-heap-line-")), false);
  });
});

test("W1-T12031 criterion 3: freshness resync and the next real child precede inherited-writer EOF", async (t) => {
  const run = await observedStderrSupervisor(t, { held: true, freshness: true, code: 75,
    payload: Buffer.from("freshness child stderr\r\n") });
  assert.equal(await run.until(run.writerAlive), true, "positive control: the first child left its private writer open");
  assert.equal(await run.until(() => run.exists(run.nextPath)), true,
    "the existing freshness branch must resync and start its next child without writer EOF");
  assert.equal(run.writerAlive(), true);
  assert.deepEqual(await run.done, { code: 0, signal: null });
  assert.equal(readFileSync(run.countPath, "utf8"), "2");
  assert.equal(readFileSync(run.syncPath, "utf8"), "sync\n");
  const exits = lines(run.ledgerPath).filter((r) => r.step === "daemon.process.exit");
  assert.deepEqual(exits.map((r) => [r.exit_code, r.clean_exit, r.heap_limit_line]),
    [[75, true, null], [0, true, null]]);
});
