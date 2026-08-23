import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  decideMeasurementCadence,
  defaultMeasurementCadenceGitLog,
  measurementCadenceCheck,
  measurementCadenceMarkerPath,
  readMeasurementCadenceMarker,
  recordMeasurementCadenceFire,
  runMeasurementCadenceReport,
  type MeasurementCadencePolicy,
} from "../src/lib/measurement-cadence.js";
import { loadPolicy, policyPath } from "../src/lib/policy.js";
import { daemonCommand, buildMeasurementCadenceDaemonHooks } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import type { Config } from "../src/lib/config.js";

// ── W1-T1259: the three verbs that would answer "is this system getting better" —
// rule-efficacy, verdict-calibration, autonomy-rate — were merged, host-side, and reachable only
// by an operator typing them on the right machine. This file proves the daemon's own cadence
// exists, is paced by ITS OWN policy-data bound (never the raw 60s poll), defaults to writing
// nothing, never files a task, and refuses rather than fakes a healthy zero over nothing
// measured — the five acceptance criteria on W1-T1259's own shard, in that order.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const ON: MeasurementCadencePolicy = {
  enabled: true,
  minIntervalMinutes: 360,
  maxPerDay: 4,
  escalate: false,
};
const NOW = new Date("2026-08-20T12:00:00.000Z");

// ── acceptance 1 + 2: THE DAEMON RUNS ON ITS OWN CADENCE, PACED BY POLICY DATA — an interval
// bound AND a per-day bound, never the raw poll interval ────────────────────────────────────

test("DEFAULT OFF: with the flag false the cadence never fires, whatever else is true", () => {
  const d = decideMeasurementCadence({ policy: { ...ON, enabled: false }, marker: { kind: "absent" }, now: NOW });
  assert.equal(d.fire, false);
  assert.match(d.reason, /disabled/);
});

test("CORRUPT MARKER FAILS CLOSED — never fires on unreadable state", () => {
  const d = decideMeasurementCadence({ policy: ON, marker: { kind: "corrupt" }, now: NOW });
  assert.equal(d.fire, false);
  assert.match(d.reason, /unreadable/);
});

test("FIRST RUN: an absent marker fires immediately (nothing to pace against yet)", () => {
  const d = decideMeasurementCadence({ policy: ON, marker: { kind: "absent" }, now: NOW });
  assert.equal(d.fire, true);
  assert.match(d.reason, /first run/);
});

test("THE INTERVAL BOUND: a fire inside minIntervalMinutes is refused, naming the bound", () => {
  const marker = { kind: "ok" as const, marker: { fires: [new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()] } };
  const d = decideMeasurementCadence({ policy: ON, marker, now: NOW });
  assert.equal(d.fire, false);
  assert.match(d.reason, /minInterval 360m/);
});

test("THE INTERVAL BOUND CLEARS: once minIntervalMinutes has elapsed, it fires again", () => {
  const marker = { kind: "ok" as const, marker: { fires: [new Date(NOW.getTime() - 361 * 60 * 1000).toISOString()] } };
  const d = decideMeasurementCadence({ policy: ON, marker, now: NOW });
  assert.equal(d.fire, true);
});

test("THE DAILY CAP BINDS INDEPENDENTLY OF THE INTERVAL — never just the raw poll interval", () => {
  // Four fires already recorded today, the MOST RECENT one safely outside minIntervalMinutes —
  // the interval bound alone would happily allow a fifth. Only maxPerDay refuses it.
  const fires = [7, 13, 19, 23].map((h) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString());
  const d = decideMeasurementCadence({ policy: ON, marker: { kind: "ok", marker: { fires } }, now: NOW });
  assert.equal(d.fire, false);
  assert.match(d.reason, /daily cap reached \(4\/4/);
});

test("a fire outside the 24h window does not count against the daily cap", () => {
  const oldFire = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(); // >24h ago
  const d = decideMeasurementCadence({ policy: ON, marker: { kind: "ok", marker: { fires: [oldFire] } }, now: NOW });
  assert.equal(d.fire, true, "a fire outside the rolling 24h window must not count toward maxPerDay");
});

test("readMeasurementCadenceMarker: a malformed JSON file resolves corrupt, not absent", () => {
  const root = tmp("rmd-mc-corrupt-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const markerPath = measurementCadenceMarkerPath(root);
    writeFileSync(markerPath, "{ not valid json");
    const marker = readMeasurementCadenceMarker(markerPath);
    assert.equal(marker.kind, "corrupt", "a truncated/malformed marker must FAIL CLOSED, never read as never-fired");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordMeasurementCadenceFire trims fires OUTSIDE the rolling window on a SECOND recorded fire", () => {
  const root = tmp("rmd-mc-trim-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const markerPath = measurementCadenceMarkerPath(root);
    const dayMs = 24 * 60 * 60 * 1000;
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000); // outside a 24h window
    recordMeasurementCadenceFire(markerPath, old, dayMs);
    const after = recordMeasurementCadenceFire(markerPath, NOW, dayMs);
    assert.deepEqual(after.fires, [NOW.toISOString()], "the stale fire must be trimmed, not kept forever");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultMeasurementCadenceGitLog: a SHALLOW clone is refused by name (mirrors defaultVerdictCalibrationGitLog)", () => {
  const src = mkdtempSync(join(tmpdir(), "rmd-mc-shallow-src-"));
  const dest = join(src, "shallow-clone");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: src, env });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"], { cwd: src, env });
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${src}`, dest], { cwd: src, env });
    assert.throws(() => defaultMeasurementCadenceGitLog(dest), /shallow/);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("measurementCadenceCheck round-trips a real marker file: absent -> fire -> recorded -> refused within the interval", () => {
  const root = tmp("rmd-mc-check-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const markerPath = measurementCadenceMarkerPath(root);

    const first = measurementCadenceCheck({ root, policy: ON, now: NOW });
    assert.equal(first.fire, true, "no marker recorded yet — must fire");

    recordMeasurementCadenceFire(markerPath, NOW, 24 * 60 * 60 * 1000);
    const marker = readMeasurementCadenceMarker(markerPath);
    assert.equal(marker.kind, "ok");

    const second = measurementCadenceCheck({ root, policy: ON, now: new Date(NOW.getTime() + 60 * 1000) });
    assert.equal(second.fire, false, "immediately after a recorded fire, the interval bound must refuse");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 3 + 4: THE DEFAULT CADENCE WRITES NOTHING, NEVER FILES A TASK, AND THE
// ESCALATING FORM STAYS OPT-IN AND OFF BY DEFAULT ─────────────────────────────────────────────

/** Two `ci.stalled` recurrences after RULE_SIGNATURES' own 2026-08-06 effective date — enough to
 *  make `CLAUDE.md#investigation-discipline:bound-fires-on-healthy-condition` REPEATING at 2
 *  recurrences, exactly `RULE_EFFICACY_ESCALATION_THRESHOLD` — the fixture this whole section
 *  needs to prove escalation is reachable in principle and STILL refused by default.
 */
function writeRepeatingRuleFixture(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const lines = [
    JSON.stringify({ ts: "2026-08-10T00:00:00.000Z", step: "ci.stalled", run_id: "r1" }),
    JSON.stringify({ ts: "2026-08-11T00:00:00.000Z", step: "ci.stalled", run_id: "r2" }),
  ].join("\n");
  writeFileSync(join(stateDir, "ledger.2026-08-12T00-00-00-000Z.ndjson"), lines + "\n");
}

const NO_GIT = () => ({ dump: "", ref: "test" });

test("shipped plan/policy.yaml defaults the base cadence ON, read-only — the escalating form stays OFF", () => {
  const p = loadPolicy(policyPath(REPO_ROOT));
  assert.equal(p.values.measurementCadence.enabled, true, "the cadence itself must be safe-on out of the box");
  assert.equal(p.values.measurementCadence.escalate, false, "the ONE write path must ship opted-in-and-off");
  assert.ok(p.values.measurementCadence.minIntervalMinutes > 0);
  assert.ok(p.values.measurementCadence.maxPerDay > 0);
});

test("DEFAULT: a policy.yaml with no measurementCadence block still loads — absent means the SAFE cadence, escalate OFF", () => {
  // Mirrors test/auto-triage-wiring.test.ts's own "absent means OFF" falsifier, but for THIS
  // block the absent default is the safe cadence already on (see policy.ts's own doc for why a
  // read-only rung's absent default differs from a spending rung's).
  const dir = mkdtempSync(join(tmpdir(), "rmd-mc-default-"));
  try {
    const shipped = readFileSync(policyPath(REPO_ROOT), "utf8");
    const withoutBlock = shipped.replace(/^measurementCadence:\n(?:[ \t].*\n|\n)*/m, "");
    assert.ok(!/^measurementCadence:/m.test(withoutBlock), "the fixture really has no measurementCadence block");

    const file = join(dir, "policy.yaml");
    writeFileSync(file, withoutBlock);
    const values = loadPolicy(file).values.measurementCadence;

    assert.equal(values.enabled, true, "absence means the SAFE cadence, not off");
    assert.equal(values.minIntervalMinutes, 360);
    assert.equal(values.maxPerDay, 4);
    assert.equal(values.escalate, false, "the ONE write path stays off even on the absent-block default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DEFAULT CADENCE (escalate: false) drafts NOTHING even over data that would qualify — zero writes", () => {
  const root = tmp("rmd-mc-noesc-");
  try {
    const stateDir = join(root, "state");
    writeRepeatingRuleFixture(stateDir);
    const registryPath = join(stateDir, "inbox-proposals.json");

    const result = runMeasurementCadenceReport({ stateDir, cwd: REPO_ROOT, escalate: false, gitLog: NO_GIT, registryPath });

    assert.equal(result.ruleEfficacy.status, "measured", "the fixture must actually be measurable, or this proves nothing");
    assert.equal(result.ruleEfficacy.repeatingCount, 1, "the fixture's one REPEATING rule must be seen");
    assert.equal(result.ruleEfficacy.escalated, false, "the default cadence must never escalate");
    assert.deepEqual(result.ruleEfficacy.escalatedProposalIds, []);
    assert.equal(existsSync(registryPath), false, "no proposal registry write at all on the default cadence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("THE ESCALATING FORM, WHEN OPTED IN, ONLY EVER DRAFTS A PROPOSAL — never a task, never a feedback entry", () => {
  const root = tmp("rmd-mc-esc-");
  try {
    const stateDir = join(root, "state");
    writeRepeatingRuleFixture(stateDir);
    const registryPath = join(stateDir, "inbox-proposals.json");

    const result = runMeasurementCadenceReport({ stateDir, cwd: REPO_ROOT, escalate: true, gitLog: NO_GIT, registryPath });

    assert.equal(result.ruleEfficacy.escalated, true);
    assert.equal(result.ruleEfficacy.escalatedProposalIds.length, 1);
    assert.match(result.ruleEfficacy.escalatedProposalIds[0], /^rule-efficacy:/, "a PROPOSAL id, never a task/feedback id shape");

    assert.ok(existsSync(registryPath), "the ONE write this module can reach: the proposal registry");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.ok(Array.isArray(registry) || Array.isArray(registry.proposals ?? registry), "sanity: it parses as the registry shape");

    // LAW 5, DIRECTLY: nothing under stateDir besides the ledger fixture and the registry itself —
    // no minted task shard, no feedback entry, no second write path.
    const entries = readdirSync(stateDir).sort();
    assert.deepEqual(entries, ["inbox-proposals.json", "ledger.2026-08-12T00-00-00-000Z.ndjson"].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-running the escalating form is IDEMPOTENT — a rerun never duplicates the proposal", () => {
  const root = tmp("rmd-mc-esc-idem-");
  try {
    const stateDir = join(root, "state");
    writeRepeatingRuleFixture(stateDir);
    const registryPath = join(stateDir, "inbox-proposals.json");

    const first = runMeasurementCadenceReport({ stateDir, cwd: REPO_ROOT, escalate: true, gitLog: NO_GIT, registryPath });
    assert.equal(first.ruleEfficacy.escalatedProposalIds.length, 1);

    const second = runMeasurementCadenceReport({ stateDir, cwd: REPO_ROOT, escalate: true, gitLog: NO_GIT, registryPath });
    assert.equal(second.ruleEfficacy.escalated, false, "the second run finds nothing NEW to draft");
    assert.deepEqual(second.ruleEfficacy.escalatedProposalIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 5: AN UNATTENDED RUN WITH NOTHING MEASURABLE REFUSES — NEVER A HEALTHY-LOOKING
// ZERO (P48) ──────────────────────────────────────────────────────────────────────────────────

test("EMPTY STATE, EVERY VERB: refuses by name, never prints a false 0% over nothing measured", () => {
  const root = tmp("rmd-mc-empty-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true }); // no ledger files at all — zero archives, zero live file

    const result = runMeasurementCadenceReport({ stateDir, cwd: REPO_ROOT, escalate: false, gitLog: NO_GIT });

    assert.equal(result.ruleEfficacy.status, "refused");
    assert.equal(result.ruleEfficacy.repeatIncidentRate, null, "never 0 — null, the refusal value");
    assert.ok(result.ruleEfficacy.refusedReason && result.ruleEfficacy.refusedReason.length > 0);

    assert.equal(result.verdictCalibration.status, "refused");
    assert.ok(result.verdictCalibration.refusedReason && result.verdictCalibration.refusedReason.length > 0);
    for (const c of result.verdictCalibration.classes) {
      assert.equal(c.revertRate, null, `${c.verdictClass} must refuse to print a rate over an empty corpus`);
    }

    assert.equal(result.autonomyRate.status, "refused");
    assert.equal(result.autonomyRate.zeroTouchRate, null, "never 0 — null, the refusal value");
    assert.ok(result.autonomyRate.refusedReason && result.autonomyRate.refusedReason.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable git history degrades verdict-calibration/autonomy-rate to a NAMED refusal, never a false rate", () => {
  const root = tmp("rmd-mc-gitfail-");
  try {
    const stateDir = join(root, "state");
    writeRepeatingRuleFixture(stateDir); // rule-efficacy has real data; the git-dependent verbs do not
    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: REPO_ROOT,
      escalate: false,
      gitLog: () => {
        throw new Error("shallow clone — truncated history would misread absent reverts/fixes as absent evidence");
      },
    });
    assert.equal(result.verdictCalibration.status, "refused");
    assert.match(result.verdictCalibration.refusedReason ?? "", /git history unavailable/);
    assert.equal(result.autonomyRate.status, "refused");
    assert.match(result.autonomyRate.refusedReason ?? "", /git history unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── REACHABILITY: the producer is actually wired, not just a type the consumer reads ──────────
//
// PR #1066 shipped auto-triage's CONSUMER with no PRODUCER: `daemon.ts` read `deps.checkAutoTriage`
// but nothing ever constructed it, so `autoTriage.enabled: true` did nothing in production while
// every unit test passed. This is the same mistake, made impossible for THIS rung: drive the REAL
// `daemonCommand` and assert on the DaemonDeps it actually hands `runDaemon`.

function fixtureHome(): { home: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-mc-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { home, planPath };
}

test("REACHABILITY: daemonCommand actually WIRES checkMeasurementCadence/runMeasurementCadence into the deps it hands runDaemon", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
    assert.equal(typeof captured!.checkMeasurementCadence, "function", "a self-target daemon must wire the decision hook");
    assert.equal(typeof captured!.runMeasurementCadence, "function", "a self-target daemon must wire the runner");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("THE WIRED HOOK, CALLED FOR REAL: check + run actually execute the producer's body, not just its type", async () => {
  // `buildMeasurementCadenceDaemonHooks` is the function `daemonCommand` constructs at its call
  // site (see the REACHABILITY test above) — this calls the closures it RETURNS, so the marker
  // read/write and the three-verb report assembly inside them are actually exercised, not merely
  // referenced.
  const root = mkdtempSync(join(tmpdir(), "rmd-mc-hook-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const hooks = buildMeasurementCadenceDaemonHooks({ config: { root } as Config, now: () => NOW });

    const decision = hooks.checkMeasurementCadence();
    assert.equal(decision.fire, true, "no marker yet under this fresh root — must fire");

    const result = await hooks.runMeasurementCadence();
    assert.equal(result.ruleEfficacy.status, "refused", "a freshly created state dir has no ledger at all");
    assert.equal(result.ruleEfficacy.escalated, false, "the shipped policy's escalate flag is off");

    // THE MARKER-FIRST DISCIPLINE: runMeasurementCadence must have recorded the fire BEFORE (or
    // regardless of) the report body running, so an immediate re-check inside the interval refuses.
    const again = hooks.checkMeasurementCadence();
    assert.equal(again.fire, false, "immediately after a real run, the interval bound must hold");
    assert.match(again.reason, /minInterval/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE CONSUMER: runDaemon's poll loop actually consults + acts on the hook ───────────────────

test("runDaemon: with no checkMeasurementCadence hook the loop behaves exactly as before", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-mc-off-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string }> = [];
    let stopChecks = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 2 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step) => lines.push({ step }),
    });
    assert.equal(lines.filter((l) => l.step.startsWith("measurement_cadence")).length, 0, "an unwired rung emits nothing at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDaemon: a FIRING decision runs the cadence and logs its result", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-mc-fire-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let stopChecks = 0;
    let runs = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      checkMeasurementCadence: () => ({ fire: true, reason: "first run" }),
      runMeasurementCadence: async () => {
        runs++;
        return {
          ruleEfficacy: { status: "refused", refusedReason: "nothing measured", measurableCount: 0, repeatingCount: 0, repeatIncidentRate: null, escalated: false, escalatedProposalIds: [] },
          verdictCalibration: { status: "refused", refusedReason: "nothing measured", classes: [] },
          autonomyRate: { status: "refused", refusedReason: "nothing measured", totalMerges: 0, zeroTouchRate: null },
        };
      },
    });
    assert.ok(runs >= 1, "the wired runner must actually be invoked when the decision fires");
    assert.ok(lines.some((l) => l.step === "measurement_cadence.fired"));
    assert.ok(lines.some((l) => l.step === "measurement_cadence.ran"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDaemon: a REFUSING decision never runs the cadence, and names why", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-mc-skip-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let stopChecks = 0;
    let runs = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      checkMeasurementCadence: () => ({ fire: false, reason: "only 5.0m since the last run (minInterval 360m)" }),
      runMeasurementCadence: async () => {
        runs++;
        throw new Error("must never be called");
      },
    });
    assert.equal(runs, 0, "a refusing decision must never invoke the runner");
    assert.ok(lines.some((l) => l.step === "measurement_cadence.skipped"));
    assert.equal(lines.filter((l) => l.step === "measurement_cadence.fired").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDaemon: a THROWING checkMeasurementCadence is caught and ledgered, never fatal", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-mc-throw-check-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string }> = [];
    let stopChecks = 0;
    const summary = await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step) => lines.push({ step }),
      checkMeasurementCadence: () => {
        throw new Error("simulated decision failure");
      },
    });
    assert.equal(summary.stopReason, "stopped", "a thrown decision must NOT take the daemon down");
    assert.ok(lines.some((l) => l.step === "measurement_cadence.check_failed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDaemon: a THROWING runMeasurementCadence is caught and ledgered, never fatal", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-mc-throw-run-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string }> = [];
    let stopChecks = 0;
    const summary = await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step) => lines.push({ step }),
      checkMeasurementCadence: () => ({ fire: true, reason: "first run" }),
      runMeasurementCadence: async () => {
        throw new Error("simulated report failure");
      },
    });
    assert.equal(summary.stopReason, "stopped", "a thrown report run must NOT take the daemon down");
    assert.ok(lines.some((l) => l.step === "measurement_cadence.run_failed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
