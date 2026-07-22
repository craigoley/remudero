import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CRASHLOOP_WINDOW,
  daemonBoot,
  detectDaemonCrashLoop,
  type CrashLoopVerdict,
} from "../src/lib/daemon.js";

// ── detectDaemonCrashLoop: THE PURE BOOT-RATE INVARIANT (W1-T215) ──────────
// A synthetic `daemon.boot` timestamp history in, a verdict out. NO process
// spawn, NO ledger read, NO real clock (Rule 18) — every scenario below is a
// plain array of ISO strings.

const cleanEnv = { PATH: "/usr/bin" };

/** `n` timestamps spaced `stepMs` apart, starting at `startIso`. */
function bootSeries(startIso: string, stepMs: number, n: number): string[] {
  const start = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => new Date(start + i * stepMs).toISOString());
}

test("detectDaemonCrashLoop: more than maxBoots inside the window breaches", () => {
  // 7 boots one minute apart — a full 6-minute span, all inside the default 10-minute
  // window, and 7 > the default maxBoots of 5.
  const boots = bootSeries("2026-07-21T04:02:00Z", 60_000, 7);
  const verdict = detectDaemonCrashLoop(boots);
  assert.equal(verdict.breached, true);
  assert.equal(verdict.windowBoots.length, 7);
  assert.deepEqual(verdict.windowBoots, boots);
});

test("detectDaemonCrashLoop: exactly maxBoots inside the window does NOT breach (strictly-more, not >=)", () => {
  const boots = bootSeries("2026-07-21T04:02:00Z", 60_000, DEFAULT_CRASHLOOP_WINDOW.maxBoots);
  const verdict = detectDaemonCrashLoop(boots);
  assert.equal(verdict.breached, false);
  assert.equal(verdict.windowBoots.length, DEFAULT_CRASHLOOP_WINDOW.maxBoots);
});

// ── THE FALSE-POSITIVE FALSIFIER (acceptance: this must NOT fire on a
// legitimate restart or a normal daily boot pattern) ───────────────────────

test("detectDaemonCrashLoop: a single legitimate operator restart, isolated from prior boots, does not breach", () => {
  // A normal daily boot two days ago, then one isolated restart today (a plist
  // reload after a config change) — nowhere near 5 other boots within 10 minutes.
  const boots = ["2026-07-19T09:00:00Z", "2026-07-20T09:00:00Z", "2026-07-21T09:00:00Z"];
  const verdict = detectDaemonCrashLoop(boots);
  assert.equal(verdict.breached, false);
});

test("detectDaemonCrashLoop: a normal daily boot pattern (30 boots, one per day) does not breach despite a large total count", () => {
  const boots = bootSeries("2026-06-22T09:00:00Z", 24 * 60 * 60_000, 30);
  const verdict = detectDaemonCrashLoop(boots);
  assert.equal(verdict.breached, false);
  // The densest window is exactly one boot — a day apart is nowhere near 10 minutes.
  assert.equal(verdict.windowBoots.length, 1);
});

test("detectDaemonCrashLoop: a handful of restarts during commissioning (2-3 close together, once) does not breach", () => {
  // load -> unload -> reload while testing a plist change: three boots a few
  // seconds apart, once, is well under the default threshold of 5.
  const boots = bootSeries("2026-07-21T09:00:00Z", 5_000, 3);
  const verdict = detectDaemonCrashLoop(boots);
  assert.equal(verdict.breached, false);
});

// ── SHAPE, NOT CAUSE (acceptance: fires on a loop whose trigger is neither
// headroom nor a throwing escalation — the identical function catches both
// observed incidents AND a wholly synthetic third cause) ───────────────────

test("detectDaemonCrashLoop: catches the observed headroom-exit-loop shape (~60s apart)", () => {
  const boots = bootSeries("2026-07-20T22:22:00Z", 60_000, 12);
  assert.equal(detectDaemonCrashLoop(boots).breached, true);
});

test("detectDaemonCrashLoop: catches the observed escalate-throw-loop shape (~55s apart, #472)", () => {
  const boots = bootSeries("2026-07-21T04:02:00Z", 55_000, 11);
  assert.equal(detectDaemonCrashLoop(boots).breached, true);
});

test("detectDaemonCrashLoop: catches a wholly synthetic third cause (tight 8s spacing), proving it detects the SHAPE not a known trigger", () => {
  const boots = bootSeries("2026-07-22T12:00:00Z", 8_000, 9);
  assert.equal(detectDaemonCrashLoop(boots).breached, true);
});

// ── EVIDENCE (acceptance: a breach is surfaced with its evidence rather
// than requiring a human to read raw boot timestamps) ──────────────────────

test("detectDaemonCrashLoop: a breach verdict carries the exact evidence — its own boots, window, and threshold", () => {
  const boots = bootSeries("2026-07-21T04:02:00Z", 60_000, 8);
  const verdict = detectDaemonCrashLoop(boots, { windowMs: 10 * 60_000, maxBoots: 5 });
  assert.equal(verdict.breached, true);
  assert.equal(verdict.windowMs, 10 * 60_000);
  assert.equal(verdict.maxBoots, 5);
  // The evidence is the ACTUAL breaching timestamps, oldest first — sufficient on
  // its own to explain the breach without re-reading the ledger.
  assert.deepEqual(verdict.windowBoots, boots);
});

test("detectDaemonCrashLoop: an unparseable timestamp is dropped, never thrown on (ledger's own torn-line discipline)", () => {
  const boots = [...bootSeries("2026-07-21T04:02:00Z", 60_000, 6), "not-a-timestamp", ""];
  assert.doesNotThrow(() => detectDaemonCrashLoop(boots));
  const verdict = detectDaemonCrashLoop(boots);
  assert.equal(verdict.breached, true); // the 6 valid boots alone already breach
  assert.ok(verdict.windowBoots.every((b) => b !== "not-a-timestamp" && b !== ""));
});

test("detectDaemonCrashLoop: a caller-supplied window/threshold is POLICY DATA, not a hardcoded constant", () => {
  // 3 boots spanning 600ms, well inside a 1000ms window either way — only the
  // THRESHOLD differs between the two calls below.
  const boots = bootSeries("2026-07-21T00:00:00Z", 300, 3);
  assert.equal(detectDaemonCrashLoop(boots, { windowMs: 1_000, maxBoots: 5 }).breached, false);
  assert.equal(detectDaemonCrashLoop(boots, { windowMs: 1_000, maxBoots: 2 }).breached, true);
});

test("detectDaemonCrashLoop: unordered input is sorted before windowing", () => {
  const ordered = bootSeries("2026-07-21T04:02:00Z", 60_000, 6);
  const shuffled = [ordered[3], ordered[0], ordered[5], ordered[1], ordered[4], ordered[2]];
  assert.deepEqual(detectDaemonCrashLoop(shuffled).windowBoots.sort(), [...ordered].sort());
});

// ── daemonBoot wiring: the invariant is CONSULTED at boot, logged either
// way, and a breach is surfaced via onBreach rather than left for a human to
// notice ────────────────────────────────────────────────────────────────────

test("daemonBoot: no crashLoopCheck injected -> no daemon.crashloop_check line at all (pre-W1-T215 behavior unchanged)", () => {
  const lines: { step: string; extra?: Record<string, unknown> }[] = [];
  daemonBoot((step, extra) => lines.push({ step, extra }), cleanEnv);
  assert.ok(!lines.some((l) => l.step === "daemon.crashloop_check"));
});

test("daemonBoot: a breaching prior-boot history logs daemon.crashloop_check breached=true and fires onBreach with the evidence", () => {
  const lines: { step: string; extra?: Record<string, unknown> }[] = [];
  const priorBoots = bootSeries("2026-07-21T04:02:00Z", 60_000, 7);
  let breached: CrashLoopVerdict | undefined;
  daemonBoot(
    (step, extra) => lines.push({ step, extra }),
    cleanEnv,
    undefined,
    undefined,
    undefined,
    {
      priorBoots: () => priorBoots,
      now: () => "2026-07-21T04:09:00Z", // 8th boot, one minute after the last
      onBreach: (v) => {
        breached = v;
      },
    },
  );
  const check = lines.find((l) => l.step === "daemon.crashloop_check");
  assert.ok(check);
  assert.equal(check!.extra!.breached, true);
  assert.equal(check!.extra!.boot_count, 8);
  assert.ok(breached, "onBreach must fire on a breach");
  assert.equal(breached!.windowBoots.length, 8);
});

test("daemonBoot: a non-breaching prior-boot history logs breached=false and does NOT fire onBreach", () => {
  const lines: { step: string; extra?: Record<string, unknown> }[] = [];
  let breachedCalls = 0;
  daemonBoot(
    (step, extra) => lines.push({ step, extra }),
    cleanEnv,
    undefined,
    undefined,
    undefined,
    {
      priorBoots: () => ["2026-07-19T09:00:00Z", "2026-07-20T09:00:00Z"],
      now: () => "2026-07-21T09:00:00Z", // isolated, a day after the last
      onBreach: () => {
        breachedCalls++;
      },
    },
  );
  const check = lines.find((l) => l.step === "daemon.crashloop_check");
  assert.ok(check);
  assert.equal(check!.extra!.breached, false);
  assert.equal(breachedCalls, 0);
});

test("daemonBoot: a custom window is honoured over the default (POLICY DATA)", () => {
  const lines: { step: string; extra?: Record<string, unknown> }[] = [];
  let breachedCalls = 0;
  daemonBoot(
    (step, extra) => lines.push({ step, extra }),
    cleanEnv,
    undefined,
    undefined,
    undefined,
    {
      priorBoots: () => ["2026-07-21T09:00:00.000Z", "2026-07-21T09:00:00.200Z"],
      now: () => "2026-07-21T09:00:00.400Z", // 3 boots inside 1s
      window: { windowMs: 1_000, maxBoots: 2 },
      onBreach: () => {
        breachedCalls++;
      },
    },
  );
  const check = lines.find((l) => l.step === "daemon.crashloop_check");
  assert.equal(check!.extra!.breached, true);
  assert.equal(check!.extra!.max_boots, 2);
  assert.equal(check!.extra!.window_ms, 1_000);
  assert.equal(breachedCalls, 1);
});
