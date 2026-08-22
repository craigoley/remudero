// test/daemon-crashloop-wiring.test.ts — W1-T215's boot-rate invariant, WIRED at last.
//
// The detector (detectDaemonCrashLoop, lib/daemon.ts) merged 2026-07-22/#590 with daemonBoot's
// crashLoopCheck hook and sat unasked while the 2026-08-03 ENOSPC storm relaunched the daemon
// ten times with zero escalation. This suite locks the WIRING, not the detector (its own edge
// cases live in test/daemon-crashloop.test.ts): every test below drives the REAL `daemonCommand`
// through its REAL `daemonBoot` with the crashLoopCheck object the command ACTUALLY builds —
// the only injection is the existing `runDaemon` loop stub (the W1-T160 seam, same as
// daemon-worker-home-sweep.test.ts), so a passing run here proves the PRODUCTION DEFAULT
// escalates, not that a hand-built fixture would have. A fixture-only assertion is how three
// governors shipped with no caller (W1-T316's note), and how a plan-reloader that threw on every
// tick passed six injecting tests.
//
// The one line left unproven by design: real `gh issue create` delivery. The fixture's PATH has
// no gh, so tryEscalate's delivery fails and the marker records delivered:false — which is
// itself the asserted behavior ("the marker is written whether or not delivery succeeds");
// delivery mechanics belong to escalate.ts's own suite.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonCommand, ledgerPathFor } from "../src/run-task.js";
import { DEFAULT_CRASHLOOP_WINDOW } from "../src/lib/daemon.js";
import type { DaemonSummary } from "../src/lib/daemon.js";

function fixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-crashloop-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  // `home` starts with RMD_TMP_PREFIX ("rmd-"), the exact prefix daemonCommand's OWN real
  // boot-time `sweepStaleTempDirs` (lib/tmp.ts) reaps anything under os.tmpdir() matching, by
  // AGE (`now() - mtimeMs > maxAgeMs`, default 24h). Every mkdirSync/writeFileSync above this
  // line updates `home`'s own mtime to the REAL OS clock (mtimes are not shiftable, same
  // mechanism CLOCK_ARTIFACTS' prune-liveness/serve.glance entries cite) — under clock-sweep's
  // future shift that real mtime reads as ancient, so the daemon's own real housekeeping sweep
  // deletes this fixture (ledger, seeded boots, everything under `root`) before the test's own
  // `daemonCommand` call ever reaches `crashLoopCheck`. Stamping `home`'s mtime from the
  // (possibly shifted) injected clock — LAST, after every write under it, so a later
  // mkdirSync/writeFileSync cannot silently reset it back to the real OS time — keeps this
  // fixture's own age reading consistent with `Date.now()` regardless of shift, the same "stamp
  // from the injected clock" remedy #2250 established for ledger `ts` fields.
  const now = new Date();
  utimesSync(home, now, now);
  return { home, root, planPath };
}

/** Seed `n` daemon.boot lines, newest `spacingMs` apart ending just before now — a storm shape. */
function seedBoots(root: string, n: number, spacingMs: number): string[] {
  const ledgerPath = ledgerPathFor({ root } as never);
  const now = Date.now();
  const ts: string[] = [];
  for (let i = n; i >= 1; i--) {
    const t = new Date(now - i * spacingMs).toISOString();
    ts.push(t);
    appendFileSync(ledgerPath, JSON.stringify({ ts: t, run_id: `DAEMON-seed-${i}`, task_id: "DAEMON", step: "daemon.boot" }) + "\n");
  }
  return ts;
}

function ledgerLines(root: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPathFor({ root } as never), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const loopStub = async (): Promise<DaemonSummary> => ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 });

test("W1-T215 wiring: a boot into a live storm (6 prior boots in <10m) escalates through the REAL daemonCommand — daemon.crashloop_check breached:true and one daemon.crashloop.escalated marker with the window evidence, delivered:false with no gh", async () => {
  const { home, root, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    seedBoots(root, 6, 60_000); // one per minute — the observed storm cadence, > maxBoots (5)
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { runDaemon: loopStub });
    assert.equal(code, 0);

    const lines = ledgerLines(root);
    const check = lines.find((l) => l.step === "daemon.crashloop_check");
    assert.ok(check, "daemonBoot must log the check's own verdict — the wired object reached it");
    assert.equal(check!.breached, true, "6 seeded boots + this boot inside the 10m window must breach maxBoots=5");

    const escalated = lines.filter((l) => l.step === "daemon.crashloop.escalated");
    assert.equal(escalated.length, 1, "exactly one escalation marker for the storm");
    assert.equal(escalated[0].delivered, false, "no gh in the fixture PATH — marker still written (delivery-independent dedup key)");
    assert.ok(Number(escalated[0].window_boots) > DEFAULT_CRASHLOOP_WINDOW.maxBoots, "the marker carries the window's own evidence");
    assert.equal(typeof escalated[0].window_newest, "string");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T215 wiring: the NEXT boot of the SAME storm does not open a second issue — the episode dedup reads the prior marker off the ledger, across processes", async () => {
  const { home, root, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    seedBoots(root, 6, 60_000);
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { runDaemon: loopStub });
    // Second boot, seconds later, storm still live (all seeded boots + boot #1 still in-window).
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { runDaemon: loopStub });

    const lines = ledgerLines(root);
    assert.equal(lines.filter((l) => l.step === "daemon.crashloop_check" && l.breached === true).length, 2, "both boots detect the breach");
    assert.equal(lines.filter((l) => l.step === "daemon.crashloop.escalated").length, 1, "…but the storm escalates exactly once");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T215 wiring: a healthy boot (one stale prior boot, hours old) logs breached:false and escalates nothing — the false-positive falsifier at the wiring layer", async () => {
  const { home, root, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    seedBoots(root, 1, 6 * 60 * 60_000); // one boot six hours ago
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { runDaemon: loopStub });
    assert.equal(code, 0);
    const lines = ledgerLines(root);
    const check = lines.find((l) => l.step === "daemon.crashloop_check");
    assert.ok(check, "the check runs on every boot once wired");
    assert.equal(check!.breached, false);
    assert.equal(lines.some((l) => l.step === "daemon.crashloop.escalated"), false, "no marker, no issue on a healthy boot");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
