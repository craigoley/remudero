// test/daemon-disk-headroom.test.ts — W1-T1082: THE DAEMON NEVER READS ITS OWN FREE SPACE.
//
// `readDiskFreeBytes` (daemon-health.ts) and doctor.ts's measured `judgeDiskHeadroom` both
// existed and neither was reachable from the poll loop — `grep -n "disk\|statfs\|ENOSPC"
// src/lib/daemon.ts` returned zero hits before this task. The first thing the fleet noticed
// about ENOSPC was `appendLedger` throwing, by which time the ledger the crash-loop detector
// reads could no longer be appended to. This suite proves the fix at TWO layers:
//
//   - the PURE tick logic in `runDaemon` (daemon.ts), driven with hand-built `DaemonDeps` —
//     mirrors test/daemon.test.ts's own "W1-T513" heartbeat-driving style;
//   - the REAL wiring `daemonCommand` (run-task.ts) builds — mirrors
//     test/daemon-crashloop-wiring.test.ts's "capture the deps `runDaemon` would have received"
//     technique, so a passing run here proves the PRODUCTION DEFAULT reads a real disk and
//     escalates through a real ledger, not that a hand-built fixture would have.
//
// design (ii): "an emitter conditional on having found something makes silence ambiguous, and
// a field on an unconditional row is never silent" — every scenario below asserts against
// `daemon.alive`, the ONE row `startInFlightTicker` already writes every poll interval.

import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { daemonCommand, escalateDiskHeadroomBreach, ledgerPathFor, DISK_HEADROOM_EPISODE_MS, type RunResult } from "../src/run-task.js";
import { judgeDiskHeadroom, DISK_WARN_BYTES, DISK_FAIL_BYTES } from "../src/lib/doctor.js";
import { DECISION_RELEVANT_LEDGER_STEPS, ledgerExceedsRotationCeiling, rotateLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { IssueGateway } from "../src/lib/escalate.js";

// A single dispatchable task — enough to keep `runOne` in flight so the dispatch-phase
// `startInFlightTicker` (the row this whole task rides on) actually starts ticking.
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "daemon-disk-headroom-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

/** Drives `runDaemon` against one in-flight dispatch, gating `runOne` open only after `ticks`
 *  ticks of the in-flight ticker have fired — the same technique test/daemon.test.ts's own
 *  "W1-T513" suite uses to observe several `daemon.alive` rows from a single dispatch. */
function driveOneDispatch(
  ticks: number,
  extra: Partial<DaemonDeps> = {},
): { sleeps: () => number; runPromise: Promise<import("../src/lib/daemon.js").DaemonSummary> } {
  const plan = fixturePlan();
  const merged = new Set<string>();
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    if (sleeps >= ticks) releaseRunOne?.();
  };
  const runPromise = runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweepLight: async () => {},
      sleep,
      ...extra,
    },
    { max: 1 },
  );
  return { sleeps: () => sleeps, runPromise };
}

test("W1-T1082: daemon.alive carries real disk_free_bytes on every tick, healthy or not (design (ii): unconditional, never emitter-conditional)", async () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const FREE_BYTES = 40 * 1024 ** 3; // comfortably OK — 40 GiB
  const { runPromise, sleeps } = driveOneDispatch(3, {
    readDiskHeadroom: () => ({ freeBytes: FREE_BYTES, verdict: "OK" }),
    log: (step, ex = {}) => lines.push({ step, extra: ex }),
  });
  const s = await runPromise;
  assert.equal(s.stopReason, "max_reached");
  const heartbeats = lines.filter((l) => l.step === "daemon.alive");
  assert.ok(heartbeats.length >= 3, `expected at least 3 daemon.alive rows, saw ${heartbeats.length} (${sleeps()} sleeps)`);
  assert.ok(
    heartbeats.every((h) => h.extra.disk_free_bytes === FREE_BYTES),
    "every daemon.alive row this pass carries the real reading — a HEALTHY reading is never omitted either",
  );
});

test("W1-T1082: a reading below WARN escalates exactly once per episode — a second tick still below opens no second issue", async () => {
  const breaches: Array<{ freeBytes: number; verdict: string }> = [];
  const WARN_FREE_BYTES = DISK_WARN_BYTES - 1024;
  const { runPromise, sleeps } = driveOneDispatch(6, {
    readDiskHeadroom: () => ({ freeBytes: WARN_FREE_BYTES, verdict: "WARN" }),
    onDiskHeadroomBreach: async (info) => {
      breaches.push(info);
    },
  });
  const s = await runPromise;
  assert.equal(s.stopReason, "max_reached");
  assert.ok(sleeps() >= 6, `expected at least 6 ticks, saw ${sleeps()}`);
  assert.equal(
    breaches.length,
    1,
    `the SAME continuous breach must escalate exactly once, however many ticks it spans — saw ${breaches.length} calls`,
  );
  assert.equal(breaches[0].freeBytes, WARN_FREE_BYTES);
  assert.equal(breaches[0].verdict, "WARN");
});

test("W1-T1082: free space recovering above WARN re-arms the latch — a genuinely new episode escalates again", async () => {
  const breaches: Array<{ freeBytes: number; verdict: string }> = [];
  const OK_FREE_BYTES = 40 * 1024 ** 3;
  const WARN_FREE_BYTES = DISK_WARN_BYTES - 1024;
  // tick 1: breach (episode 1) · tick 2: still breached, deduped · tick 3: recovers, latch
  // clears · tick 4+: breached again — a genuinely NEW episode. Extra slack ticks past index 3
  // simply repeat the last (still-breached) reading, which must never add a THIRD escalation.
  const readings: Array<{ freeBytes: number; verdict: "OK" | "WARN" }> = [
    { freeBytes: WARN_FREE_BYTES, verdict: "WARN" },
    { freeBytes: WARN_FREE_BYTES, verdict: "WARN" },
    { freeBytes: OK_FREE_BYTES, verdict: "OK" },
    { freeBytes: WARN_FREE_BYTES, verdict: "WARN" },
  ];
  let tick = 0;
  const { runPromise, sleeps } = driveOneDispatch(readings.length + 2, {
    readDiskHeadroom: () => readings[Math.min(tick++, readings.length - 1)],
    onDiskHeadroomBreach: async (info) => {
      breaches.push(info);
    },
  });
  const s = await runPromise;
  assert.equal(s.stopReason, "max_reached");
  assert.ok(sleeps() >= readings.length, `expected at least ${readings.length} ticks, saw ${sleeps()}`);
  assert.equal(
    breaches.length,
    2,
    `one escalation for the FIRST episode, one for the NEW episode after recovery — never fewer (silenced forever) ` +
      `or more (repeats within one episode) — saw ${breaches.length}`,
  );
  assert.equal(breaches[0].verdict, "WARN");
  assert.equal(breaches[1].verdict, "WARN");
});

test("W1-T1082: an unreadable free-space read is absent from daemon.alive — never a fabricated zero — and escalates nothing", async () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let breaches = 0;
  // `judgeDiskHeadroom(undefined)` itself reports "WARN" — rmd doctor's own unreadable-is-a-WARN
  // convention (doctor.ts). The daemon's escalation gate must STILL refuse to fire on it: an
  // unreadable read is not evidence of a full disk, only evidence the read failed.
  const { runPromise, sleeps } = driveOneDispatch(3, {
    readDiskHeadroom: () => ({ freeBytes: undefined, verdict: judgeDiskHeadroom(undefined).verdict }),
    onDiskHeadroomBreach: async () => {
      breaches++;
    },
    log: (step, ex = {}) => lines.push({ step, extra: ex }),
  });
  const s = await runPromise;
  assert.equal(s.stopReason, "max_reached");
  const heartbeats = lines.filter((l) => l.step === "daemon.alive");
  assert.ok(heartbeats.length >= 3, `saw ${heartbeats.length} (${sleeps()} sleeps)`);
  assert.ok(
    heartbeats.every((h) => !("disk_free_bytes" in h.extra)),
    "the field is simply ABSENT on every row this pass — never present as a fake 0",
  );
  assert.equal(breaches, 0, "an unreadable read never escalates, even though judgeDiskHeadroom itself reports WARN for it");
});

test("W1-T1082: the daemon's escalation boundary matches rmd doctor's judgeDiskHeadroom exactly — one shared definition, not a second copy", async () => {
  // Sanity: pin doctor.ts's own boundary so a drift there is caught by ITS OWN suite, not
  // silently inherited here.
  assert.equal(judgeDiskHeadroom(DISK_WARN_BYTES).verdict, "OK", "at exactly WARN bytes free, doctor reports OK");
  assert.equal(judgeDiskHeadroom(DISK_WARN_BYTES - 1).verdict, "WARN");
  assert.equal(judgeDiskHeadroom(DISK_FAIL_BYTES - 1).verdict, "FAIL");

  const cases: Array<[number, boolean]> = [
    [DISK_WARN_BYTES, false],
    [DISK_WARN_BYTES - 1, true],
    [DISK_FAIL_BYTES - 1, true],
  ];
  for (const [freeBytes, expectEscalate] of cases) {
    let breaches = 0;
    // Mirrors the REAL run-task.ts wiring exactly: judge via the SAME imported function, never
    // a re-derived `<` comparison against a re-typed constant.
    const { runPromise } = driveOneDispatch(3, {
      readDiskHeadroom: () => ({ freeBytes, verdict: judgeDiskHeadroom(freeBytes).verdict }),
      onDiskHeadroomBreach: async () => {
        breaches++;
      },
    });
    await runPromise;
    assert.equal(
      breaches > 0,
      expectEscalate,
      `freeBytes=${freeBytes}: expected escalate=${expectEscalate}, saw ${breaches} call(s) — the daemon and ` +
        `rmd doctor disagreed at this exact reading`,
    );
  }
});

test("W1-T1082: daemon.disk_headroom.escalated is registered DECISION_RELEVANT — it must survive rotation because escalateDiskHeadroomBreach reads it back", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("daemon.disk_headroom.escalated"),
    "test/ledger-rotation.test.ts's own consumer-derived scan enforces this independently — this is a direct pin",
  );
});

test("W1-T1082: a ledger rotation does not re-open a duplicate disk-headroom issue — the marker survives and the next call still dedupes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-disk-headroom-rotation-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const issues: Array<{ title: string }> = [];
    const gateway: IssueGateway = {
      create: (title) => {
        issues.push({ title });
        return `https://github.com/o/r/issues/${issues.length}`;
      },
    };
    const ctx = { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: gateway };
    const firstTs = new Date().toISOString();
    escalateDiskHeadroomBreach({ freeBytes: DISK_WARN_BYTES - 1, verdict: "WARN", ts: firstTs }, ctx);
    assert.equal(issues.length, 1, "sanity: the first breach opens one issue");

    // Pad the live ledger with realistic archivable noise past a small ceiling, and force a
    // real rotation — the same technique test/ledger-rotation.test.ts's own fixtures use.
    for (let n = 0; n < 250; n++) {
      appendFileSync(ledgerPath, JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) }) + "\n");
    }
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, 2000), "test setup sanity: padded past the ceiling");
    const result = rotateLedger(ledgerPath, { ceilingBytes: 2000 });
    assert.equal(result.rotated, true);

    const survivors = readLedgerLines(ledgerPath).filter((l) => l.step === "daemon.disk_headroom.escalated");
    assert.equal(survivors.length, 1, "the marker survives the rotation, not just the noise trimmed away around it");

    // A second call for the SAME still-unresolved episode, minutes later (within
    // DISK_HEADROOM_EPISODE_MS) — must still dedupe post-rotation, from a DIFFERENT process
    // (a fresh runId, mirroring a daemon restart mid-episode).
    const secondTs = new Date(Date.parse(firstTs) + Math.min(5 * 60_000, DISK_HEADROOM_EPISODE_MS - 1)).toISOString();
    escalateDiskHeadroomBreach({ freeBytes: DISK_WARN_BYTES - 1, verdict: "WARN", ts: secondTs }, { ...ctx, runId: "RUN-2" });
    assert.equal(issues.length, 1, "post-rotation, the same episode still opens no second issue — the #977 class stays closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T1082: escalateDiskHeadroomBreach re-arms past its episode window — a reading far outside episodeMs is a genuinely new episode", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-disk-headroom-episode-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const issues: Array<{ title: string }> = [];
    const gateway: IssueGateway = {
      create: (title) => {
        issues.push({ title });
        return `https://github.com/o/r/issues/${issues.length}`;
      },
    };
    const ctx = { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: gateway, episodeMs: 60_000 };
    const firstTs = new Date().toISOString();
    escalateDiskHeadroomBreach({ freeBytes: DISK_WARN_BYTES - 1, verdict: "WARN", ts: firstTs }, ctx);
    assert.equal(issues.length, 1);

    const wellOutsideEpisode = new Date(Date.parse(firstTs) + 120_000).toISOString();
    escalateDiskHeadroomBreach({ freeBytes: DISK_WARN_BYTES - 1, verdict: "WARN", ts: wellOutsideEpisode }, { ...ctx, runId: "RUN-2" });
    assert.equal(issues.length, 2, "past the episode window, a still-low reading opens a fresh issue rather than staying silenced forever");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── WIRING: the REAL `daemonCommand` builds these deps, not merely a hand-built fixture ────────
//
// Mirrors test/daemon-crashloop-wiring.test.ts's own technique exactly: stub `runDaemon` to
// capture the `DaemonDeps` object the REAL command built, then call the captured closures
// directly. A passing run here proves the PRODUCTION DEFAULT reads a real disk (via the real
// `readDiskFreeBytes`) and escalates through a real ledger — not that a hand-built fixture
// would have.

function fixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-disk-headroom-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, root, planPath };
}

test("W1-T1082 wiring: daemonCommand builds readDiskHeadroom off a real statfs + the real judgeDiskHeadroom — no re-derived threshold", async () => {
  const { home, root, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps) => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured?.readDiskHeadroom, "the real command wires readDiskHeadroom");
    const reading = captured!.readDiskHeadroom!();
    assert.equal(typeof reading.freeBytes, "number", "a real statfs on a real, existing root reads a real number");
    assert.equal(
      reading.verdict,
      judgeDiskHeadroom(reading.freeBytes).verdict,
      "the wired reading's verdict is the SAME function's output — never a re-derived comparison",
    );

    assert.ok(captured?.onDiskHeadroomBreach, "the real command wires the escalation hook too");
    captured!.onDiskHeadroomBreach!({ freeBytes: DISK_WARN_BYTES - 1, verdict: "WARN", ts: new Date().toISOString() });
    const lines = readLedgerLines(ledgerPathFor({ root } as never));
    assert.equal(
      lines.filter((l) => l.step === "daemon.disk_headroom.escalated").length,
      1,
      "the real hook writes the real dedup marker to the real ledger at config.root",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T1082 wiring: a healthy real disk reads OK against the real judgeDiskHeadroom, the same way rmd doctor would", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps) => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    const reading = captured!.readDiskHeadroom!();
    // Sanity for THIS test environment: a CI/dev sandbox's own root is not actually below WARN.
    // If this ever fails on a genuinely full test host, that host's own `rmd doctor` would also
    // report WARN/FAIL — the two are, by construction, the same reading, off the same function.
    assert.equal(reading.verdict, "OK", `test host must have real headroom for this scenario — read ${JSON.stringify(reading)}`);
    assert.equal(reading.verdict, judgeDiskHeadroom(reading.freeBytes).verdict);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
