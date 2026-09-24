/**
 * W1-T4429 — A PAUSE NAMES ITS OWNER AND ENDS.
 *
 * MEASURED 2026-09-24: a hold set at 02:42:32Z by pid 2770992 in the daemon container (the pid was
 * gone within minutes) stood for FOUR HOURS; 15 open PRs had green ci-gate and no remudero-review,
 * some for 3+ hours, while the daemon logged `daemon.pause` every tick and did nothing else. Nothing
 * recorded who set it or why; clearing it needed an operator to GUESS it was abandoned.
 *
 * Three concerns, three tests:
 *   1. `requestPause` records owner (session/host/pid), reason and an expiry — locally AND on the
 *      shared cross-host anchor's own commit body (design (i)).
 *   2. `evaluatePauseTier`/`stepPauseHoldGovernor` (fleet-control.ts / daemon.ts) escalate an
 *      orphaned hold and then lapse it on its own tiers — never one hard cutoff (design (ii)).
 *   3. `runDaemon`'s PAUSE branch keeps admitting review-only passes — a pause stops dispatching NEW
 *      work, never judging work that is already finished (design (iii)).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ANCHOR_EXPIRES_RE,
  ANCHOR_REASON_RE,
  ANCHOR_SESSION_RE,
  checkSharedPause,
  classifyPauseReason,
  evaluatePauseTier,
  PAUSE_DEFAULT_TTL_MS,
  readSharedPauseAnchor,
  requestPause,
  resolvePauseExpiry,
  sharedPauseRef,
  type SharedPauseGitDeps,
  type SharedPauseMintInfo,
} from "../src/lib/fleet-control.js";
import {
  runDaemon,
  stepPauseHoldGovernor,
  type DaemonDeps,
  type LightPassScope,
  type PauseHoldGovernorInput,
  type PauseHoldGovernorState,
  type PauseHoldOwner,
} from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── shared fixtures ──────────────────────────────────────────────────────────────────────────────

/** Mirrors test/fleet-hold-shared.test.ts's / test/pause-hold-is-attributable.test.ts's own
 *  `fakeRemote` helpers, extended so `mintAnchor` writes the SAME multi-line body production's
 *  `realSharedPauseGitDeps` now mints (session/reason/expires lines, design (i)) — the read this
 *  file exists to prove nothing previously recorded. */
function fakeRemote(): { refs: Map<string, string>; anchors: Map<string, string>; deps: SharedPauseGitDeps } {
  const refs = new Map<string, string>();
  const anchors = new Map<string, string>();
  let seq = 0;
  const deps: SharedPauseGitDeps = {
    mintAnchor(info?: SharedPauseMintInfo) {
      seq += 1;
      const sha = `fake-anchor-${seq}`;
      const lines = [`rmd-pause hold ${9000 + seq}@host-${seq}.example 2026-09-24T02:42:32.000Z`];
      if (info?.sessionId) lines.push(`session: ${info.sessionId}`);
      if (info?.reason) lines.push(`reason: ${info.reason}`);
      if (info?.indefinite) lines.push(`expires: indefinite`);
      else if (info?.expiresAt) lines.push(`expires: ${info.expiresAt}`);
      anchors.set(sha, lines.join("\n"));
      return sha;
    },
    run(args) {
      if (args[0] === "ls-remote") {
        const ref = args[2]!;
        const sha = refs.get(ref);
        return { status: 0, stdout: sha ? `${sha}\t${ref}\n` : "" };
      }
      if (args[0] === "push") {
        const spec = args[args.length - 1]!;
        const sep = spec.indexOf(":");
        const anchor = spec.slice(0, sep);
        const ref = spec.slice(sep + 1);
        if (anchor === "") refs.delete(ref);
        else refs.set(ref, anchor);
        return { status: 0, stdout: "" };
      }
      if (args[0] === "cat-file" && args[1] === "-p") {
        const msg = anchors.get(args[2]!);
        return msg
          ? { status: 0, stdout: `tree deadbeef\nauthor a <a@b> 0 +0000\ncommitter a <a@b> 0 +0000\n\n${msg}\n` }
          : { status: 128, stdout: "" };
      }
      return { status: 1, stdout: "" };
    },
  };
  return { refs, anchors, deps };
}

// ── 1. a pause records its owner, reason and expiry (design (i)) ───────────────────────────────

test("W1-T4429: a pause records its owner, reason and expiry", () => {
  const remote = fakeRemote();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4429-pause-`));
  const now = new Date("2026-09-24T02:42:32.000Z");

  const info = requestPause(root, "incident: fleet PR pipeline stalled", remote.deps, { now });

  // The LOCAL flag (design (i)): pid/host already existed; session id and expiry are new.
  assert.equal(info.pid, process.pid);
  assert.ok(info.host, "a host is recorded");
  assert.ok(info.sessionId, "an owner session id is recorded");
  assert.equal(info.reason, "incident: fleet PR pipeline stalled");
  assert.equal(info.indefinite, false);
  // "incident" classifies to PAUSE_DEFAULT_TTL_MS.incident (1h) since no --until was supplied.
  assert.equal(info.expiresAt, new Date(now.getTime() + PAUSE_DEFAULT_TTL_MS.incident).toISOString());

  // The SHARED anchor (design (i): "in the ref's commit body") carries the SAME three facts, so a
  // daemon on another host — the one whose own read this task's rationale describes — sees them too.
  const sha = [...remote.refs.values()][0]!;
  const anchor = readSharedPauseAnchor(sha, remote.deps);
  assert.ok(anchor, "the anchor's payload must be recoverable");
  assert.equal(anchor!.reason, "incident: fleet PR pipeline stalled");
  assert.equal(anchor!.sessionId, info.sessionId);
  assert.equal(anchor!.expiresAt, info.expiresAt);
  // Unlike the LOCAL flag (which always writes `indefinite: false` explicitly), the anchor's
  // `expires:` line is only ever present at all for a real expiry or the literal `indefinite` —
  // `readSharedPauseAnchor` leaves the field simply absent otherwise, never `false`.
  assert.ok(!anchor!.indefinite);

  const detail = checkSharedPause(`/tmp/does-not-exist-${process.pid}-w1t4429a`, remote.deps);
  assert.match(detail!, /incident: fleet PR pipeline stalled/, "the rendered detail names the reason");
  assert.match(detail!, new RegExp(sharedPauseRef().replace(/\//g, "\\/")));
});

test("W1-T4429: an explicit --until wins outright over the reason-class default", () => {
  const remote = fakeRemote();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4429-pause-until-`));
  const until = "2026-09-25T00:00:00.000Z";

  const info = requestPause(root, "release freeze", remote.deps, { until, now: new Date("2026-09-24T02:42:32.000Z") });
  assert.equal(info.expiresAt, until);
  assert.equal(info.indefinite, false);
});

test("W1-T4429: --until indefinite records no expiry and never lapses", () => {
  const remote = fakeRemote();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4429-pause-indef-`));

  const info = requestPause(root, "long-running migration", remote.deps, { until: "indefinite" });
  assert.equal(info.expiresAt, null);
  assert.equal(info.indefinite, true);

  const sha = [...remote.refs.values()][0]!;
  const anchor = readSharedPauseAnchor(sha, remote.deps);
  assert.equal(anchor!.indefinite, true);
  assert.equal(anchor!.expiresAt, null);

  const detail = checkSharedPause(`/tmp/does-not-exist-${process.pid}-w1t4429c`, remote.deps);
  assert.match(detail!, /INDEFINITE/);
});

test("W1-T4429: classifyPauseReason picks the reason class resolvePauseExpiry's default keys off", () => {
  assert.equal(classifyPauseReason("investigating a SEV-1 outage"), "incident");
  assert.equal(classifyPauseReason("scheduled maintenance window"), "maintenance");
  assert.equal(classifyPauseReason("cutting the 4.2 release"), "release");
  assert.equal(classifyPauseReason(undefined), "other");
  assert.equal(classifyPauseReason("just poking around"), "other");

  const now = new Date("2026-09-24T00:00:00.000Z");
  const { expiresAt, indefinite } = resolvePauseExpiry("SEV-1 outage", undefined, now);
  assert.equal(indefinite, false);
  assert.equal(expiresAt, new Date(now.getTime() + PAUSE_DEFAULT_TTL_MS.incident).toISOString());
});

test("W1-T4429: ANCHOR_SESSION_RE/ANCHOR_REASON_RE/ANCHOR_EXPIRES_RE recognise their own line and read a legacy anchor with none of them as absent", () => {
  const legacyAnchor = "rmd-pause hold 9001@host-1.example 2026-08-25T03:27:38.000Z";
  const fullAnchor = `${legacyAnchor}\nsession: host-1.example-9001\nreason: release freeze\nexpires: 2026-09-25T00:00:00.000Z`;

  assert.equal(ANCHOR_SESSION_RE.exec(fullAnchor)?.[1], "host-1.example-9001");
  assert.equal(ANCHOR_SESSION_RE.test(legacyAnchor), false, "a legacy anchor with no session line is not misread as one");

  assert.equal(ANCHOR_REASON_RE.exec(fullAnchor)?.[1], "release freeze");
  assert.equal(ANCHOR_REASON_RE.test(legacyAnchor), false, "a legacy anchor with no reason line is not misread as one");

  assert.equal(ANCHOR_EXPIRES_RE.exec(fullAnchor)?.[1], "2026-09-25T00:00:00.000Z");
  assert.equal(ANCHOR_EXPIRES_RE.test(legacyAnchor), false, "a legacy anchor with no expires line is not misread as one");
});

// ── 2. an orphaned pause escalates and then lapses (design (ii)) ───────────────────────────────

interface GovernorHarness {
  rows: Array<{ step: string; extra: Record<string, unknown> }>;
  counts: { cleared: number; needsHuman: number };
  deps: Pick<DaemonDeps, "clearPauseHold" | "onPauseNeedsHuman">;
  log: (step: string, extra?: Record<string, unknown>) => void;
}

function governorHarness(): GovernorHarness {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const counts = { cleared: 0, needsHuman: 0 };
  const deps: Pick<DaemonDeps, "clearPauseHold" | "onPauseNeedsHuman"> = {
    clearPauseHold: () => {
      counts.cleared += 1;
    },
    onPauseNeedsHuman: () => {
      counts.needsHuman += 1;
    },
  };
  const log = (step: string, extra: Record<string, unknown> = {}) => rows.push({ step, extra });
  return { rows, counts, deps, log };
}

const OWNER: PauseHoldOwner = {
  pid: "2770992",
  host: "daemon-container",
  sessionId: "daemon-container-2770992",
  reason: "investigating a red gate",
};

test("W1-T4429: an orphaned pause escalates and then lapses", async () => {
  // A process that "then exits": every tick from here on reports the setter as dead — the
  // falsifier's own scenario ("Set a pause from a process that then exits...").
  const setAt = "2026-09-24T02:42:32.000Z"; // MEASURED — the exact timestamp the rationale names
  const expiresAt = "2026-09-24T04:42:32.000Z"; // a 2h ("other") default TTL from setAt
  const harness = governorHarness();
  const state: PauseHoldGovernorState = {};
  const input = (now: string): PauseHoldGovernorInput => ({
    holdId: "hold-1",
    setAt,
    expiresAt,
    indefinite: false,
    setterAlive: false,
    owner: OWNER,
    now: new Date(now),
  });

  // Shortly after the setter died: well before either time tier, so it reads `orphaned` — escalated,
  // never touched.
  const tier1 = await stepPauseHoldGovernor(input("2026-09-24T02:43:00.000Z"), state, harness.deps, harness.log);
  assert.equal(tier1, "orphaned");
  assert.ok(harness.rows.some((r) => r.step === "pause.orphaned"), "the orphan is ledgered");
  assert.equal(harness.rows.find((r) => r.step === "pause.orphaned")!.extra.reason, OWNER.reason, "the ledger row names the reason");
  assert.equal(harness.counts.cleared, 0, "an orphaned hold is escalated, never cleared, on its own");

  // A second tick, still orphaned, still before the halfway mark: dedup — never re-ledgered.
  harness.rows.length = 0;
  const tier1b = await stepPauseHoldGovernor(input("2026-09-24T02:50:00.000Z"), state, harness.deps, harness.log);
  assert.equal(tier1b, "orphaned");
  assert.equal(harness.rows.length, 0, "an unchanged tier is never re-ledgered");

  // Past HALF the window (setAt 02:42:32, expiry 04:42:32 → halfway 03:42:32): needs_human.
  harness.rows.length = 0;
  const tier2 = await stepPauseHoldGovernor(input("2026-09-24T03:50:00.000Z"), state, harness.deps, harness.log);
  assert.equal(tier2, "needs_human");
  assert.ok(harness.rows.some((r) => r.step === "pause.needs_human"), "the needs-human tier is ledgered");
  assert.equal(harness.counts.needsHuman, 1, "the needs-human escalation callback fired exactly once");
  assert.equal(harness.counts.cleared, 0, "still not cleared — a human is being paged, not auto-resolved");

  // Past the FULL expiry: THIS is the falsifier's own condition ("stood past its expiry with no
  // escalation") — here it both ledgers pause.lapsed AND clears the hold.
  harness.rows.length = 0;
  const tier3 = await stepPauseHoldGovernor(input("2026-09-24T04:50:00.000Z"), state, harness.deps, harness.log);
  assert.equal(tier3, "lapsed");
  assert.ok(harness.rows.some((r) => r.step === "pause.lapsed"), "the lapse is ledgered");
  assert.equal(harness.counts.cleared, 1, "the hold is cleared exactly once, at expiry");
});

test("W1-T4429: an indefinite pause only escalates, never lapses", async () => {
  const harness = governorHarness();
  const state: PauseHoldGovernorState = {};
  const farFuture = new Date("2027-01-01T00:00:00.000Z"); // long past any ordinary TTL

  const tier = await stepPauseHoldGovernor(
    { holdId: "hold-indef", setAt: "2026-09-24T00:00:00.000Z", expiresAt: null, indefinite: true, setterAlive: false, owner: OWNER, now: farFuture },
    state,
    harness.deps,
    harness.log,
  );
  assert.equal(tier, "orphaned", "an indefinite hold can still be orphaned");
  assert.equal(harness.counts.cleared, 0, "…but it is NEVER cleared — design (ii): only escalates, never lapses");

  // Re-driven arbitrarily far into the future: still never lapses.
  const tier2 = await stepPauseHoldGovernor(
    { holdId: "hold-indef", setAt: "2026-09-24T00:00:00.000Z", expiresAt: null, indefinite: true, setterAlive: false, owner: OWNER, now: new Date("2030-01-01T00:00:00.000Z") },
    state,
    harness.deps,
    harness.log,
  );
  assert.notEqual(tier2, "lapsed");
  assert.equal(harness.counts.cleared, 0);
});

test("W1-T4429: evaluatePauseTier reads a live setter as an ordinary held pause, never orphaned", () => {
  const tier = evaluatePauseTier({
    setAt: "2026-09-24T02:42:32.000Z",
    expiresAt: "2026-09-24T04:42:32.000Z",
    indefinite: false,
    setterAlive: true,
    now: new Date("2026-09-24T02:50:00.000Z"),
  });
  assert.equal(tier, "held");
});

test("W1-T4429: evaluatePauseTier never treats unknown liveness as an orphan", () => {
  const tier = evaluatePauseTier({
    setAt: "2026-09-24T02:42:32.000Z",
    expiresAt: "2026-09-24T04:42:32.000Z",
    indefinite: false,
    setterAlive: "unknown",
    now: new Date("2026-09-24T02:50:00.000Z"),
  });
  assert.equal(tier, "held", "an unattributable/unverifiable setter is not evidence of an orphan");
});

// ── 3. reviews continue while dispatch is paused (design (iii)) ────────────────────────────────

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t4429-plan-`));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(file);
}

test("W1-T4429: reviews continue while dispatch is paused", async () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const passes: Array<LightPassScope | undefined> = [];
  const sleep: DaemonDeps["sleep"] = async () => {
    await settle();
  };

  const summary = await runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      throw new Error(`runOne must never be called for ${id} — a pause stops dispatching NEW work`);
    },
    // A persistent, never-clearing operator hold — exactly the four-hour stall this task closes.
    checkPause: () => "PAUSE held — operator hold, setter status unknown",
    checkStop: () => (rows.filter((r) => r.step === "daemon.pause").length >= 3 ? "test done — enough paused ticks observed" : undefined),
    sleepUntilSweepWake: async () => {
      await settle();
      return "wake";
    },
    sweepLight: async (scope?: LightPassScope) => {
      passes.push(scope);
    },
    sleep,
    log: (step, extra = {}) => rows.push({ step, extra }),
  });

  assert.equal(summary.stopReason, "stopped");
  assert.deepEqual(summary.attempted, [], "no task was ever admitted — a pause never dispatches NEW work");
  assert.ok(rows.filter((r) => r.step === "daemon.pause").length >= 3, "the pause branch ran repeatedly, exactly as before this task");
  assert.ok(passes.length >= 1, `at least one review-only pass ran WHILE paused (saw ${passes.length})`);
  assert.ok(passes.every((s) => s?.reviewOnly === true), `every pass admitted under a pause is review-only (saw ${JSON.stringify(passes)})`);
  const passRows = rows.filter((r) => r.step === "daemon.review_clock.pass");
  assert.ok(passRows.length >= 1, "a pass admitted under a pause is ledgered");
  assert.ok(passRows.every((r) => r.extra.during_pause === true), JSON.stringify(passRows));
});

test("W1-T4429: a bare STOP still wins outright over a pause's own review clock", async () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const passes: Array<LightPassScope | undefined> = [];

  const summary = await runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      throw new Error(`runOne must never be called for ${id}`);
    },
    checkPause: () => "PAUSE held",
    // STOP fires from the very first tick — outranks PAUSE unconditionally (W1-T11).
    checkStop: () => "operator hard-stop",
    sleepUntilSweepWake: async () => {
      await settle();
      return "wake";
    },
    sweepLight: async (scope?: LightPassScope) => {
      passes.push(scope);
    },
    sleep: async () => {
      await settle();
    },
    log: (step, extra = {}) => rows.push({ step, extra }),
  });

  assert.equal(summary.stopReason, "stopped");
  assert.equal(rows.filter((r) => r.step === "daemon.pause").length, 0, "STOP is checked first — the pause branch never even ran");
  assert.equal(passes.length, 0, "no review-only pass ran either — STOP halts everything, PAUSE halts only dispatch");
});

test("W1-T4429: a throwing needs-human page is ledgered and never costs the tick", async () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const tier = await stepPauseHoldGovernor(
    {
      holdId: "hold-page-fails",
      setAt: "2026-09-24T02:42:32.000Z",
      expiresAt: "2026-09-24T04:42:32.000Z",
      indefinite: false,
      setterAlive: "unknown",
      owner: OWNER,
      now: new Date("2026-09-24T03:50:00.000Z"),
    },
    {},
    {
      onPauseNeedsHuman: () => {
        throw new Error("issue tracker unreachable");
      },
    },
    (step, extra = {}) => rows.push({ step, extra }),
  );
  assert.equal(tier, "needs_human", "the tier is still reported — the page's failure does not change it");
  const failed = rows.find((r) => r.step === "pause.needs_human_failed");
  assert.ok(failed, `the failed page is ledgered (saw ${JSON.stringify(rows.map((r) => r.step))})`);
  assert.equal(failed.extra.error, "issue tracker unreachable");
  assert.equal(failed.extra.reason, OWNER.reason, "the failure row still names the hold's reason");
});

test("W1-T4429: runDaemon governs a wired pause hold once per transition, clearing it at lapse", async () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let cleared = 0;
  const summary = await runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      throw new Error(`runOne must never be called for ${id}`);
    },
    checkPause: () => "PAUSE held",
    checkPauseHold: () => ({
      holdId: "anchor-sha-1",
      setAt: "2026-09-24T02:42:32.000Z",
      expiresAt: "2026-09-24T04:42:32.000Z",
      indefinite: false,
      setterAlive: false,
      owner: OWNER,
      now: new Date("2026-09-24T05:00:00.000Z"),
    }),
    clearPauseHold: () => {
      cleared += 1;
    },
    checkStop: () => (rows.filter((r) => r.step === "daemon.pause").length >= 3 ? "test done" : undefined),
    sleepUntilSweepWake: async () => {
      await settle();
      return "wake";
    },
    sweepLight: async () => {},
    sleep: async () => {
      await settle();
    },
    log: (step, extra = {}) => rows.push({ step, extra }),
  });

  assert.equal(summary.stopReason, "stopped");
  assert.ok(rows.filter((r) => r.step === "daemon.pause").length >= 3, "the hold spanned several paused ticks");
  const lapsed = rows.filter((r) => r.step === "pause.lapsed");
  assert.equal(lapsed.length, 1, "one hold, one lapse row — never one per tick");
  assert.equal(lapsed[0]!.extra.hold_id, "anchor-sha-1");
  assert.equal(cleared, 1, "the lapsed hold is cleared exactly once");
});
