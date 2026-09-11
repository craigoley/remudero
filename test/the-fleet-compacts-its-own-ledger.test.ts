import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DaemonDeps } from "../src/lib/daemon.js";
import {
  DEFAULT_LEDGER_COMPACTION_TRIGGER,
  decideLedgerCompaction,
  readLedgerCorpusPressure,
  type LedgerCompactionTrigger,
} from "../src/lib/ledger-compaction-rung.js";

// ── W1-T3368: the fleet compacts its own ledger ──────────────────────────────────────────────────
//
// THE INCIDENT THIS REMOVES RATHER THAN DETECTS. 2026-09-10: the fleet daemon OOM-crash-looped for
// eight hours — 66 restarts, exit 134, zero builds dispatched — because a union read decompressed a
// 4.0 GB corpus (959 gzip rotations) against an 8 GB heap. The cure merged SIX MINUTES after the
// first abort (#4950) and nothing ran it; a human eventually ran 14 bounded passes by hand.
//
// So this suite's subject is not "does compaction work" — #4950 owns that. It is: does the fleet
// decide to run it, on the quantity that predicts the abort, without a human.

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const MIN = 60_000;

// The three corpus states the outage actually passed through, as measured on the live host.
const FATAL = { archiveCount: 959, archiveBytes: 508 * 1024 * 1024 };
const HEALTHY = { archiveCount: 347, archiveBytes: 200 * 1024 * 1024 };
const FRESH = { archiveCount: 12, archiveBytes: 6 * 1024 * 1024 };

test("W1-T3368: the corpus that killed the daemon fires the rung", () => {
  const d = decideLedgerCompaction(FATAL, undefined, NOW);
  assert.equal(d.fire, true, d.reason);
  assert.match(d.reason, /over bound/);
  assert.match(d.reason, /959/, "the reason must carry the measurement that decided it");
});

test("W1-T3368 (control): a SMALL corpus fires nothing — a healthy host never pays for this", () => {
  const d = decideLedgerCompaction(FRESH, undefined, NOW);
  assert.equal(d.fire, false);
  assert.match(d.reason, /under bound/);
  assert.match(d.reason, /12 archive/, "a skip must still say what it measured");
});

test("W1-T3368: the trigger sits between the measured healthy and measured fatal states", () => {
  // The number is derived, not picked: 347 healthy, 959 fatal. A bound outside that range is either
  // a gate that never fires or one that only fires once the daemon is already dying.
  const max = DEFAULT_LEDGER_COMPACTION_TRIGGER.maxArchives;
  assert.ok(max > HEALTHY.archiveCount, `maxArchives ${max} is at or below the healthy corpus (347)`);
  assert.ok(max < FATAL.archiveCount, `maxArchives ${max} is at or above the fatal corpus (959)`);
  // And prove the placement does what it claims, rather than just sitting in the range.
  assert.equal(decideLedgerCompaction(FATAL, undefined, NOW).fire, true);
  assert.equal(decideLedgerCompaction(FRESH, undefined, NOW).fire, false);
});

test("W1-T3368: the BYTES axis fires independently — a few enormous archives are also a heap problem", () => {
  const fewButHuge = { archiveCount: 3, archiveBytes: DEFAULT_LEDGER_COMPACTION_TRIGGER.maxArchiveBytes + 1 };
  const d = decideLedgerCompaction(fewButHuge, undefined, NOW);
  assert.equal(d.fire, true, d.reason);
  assert.match(d.reason, /bytes on disk/);
  // CONTROL on the same shape: one byte under the bound, with the same tiny count, must NOT fire —
  // otherwise the bytes arm is firing on the count and this test proves nothing about it.
  const justUnder = { archiveCount: 3, archiveBytes: DEFAULT_LEDGER_COMPACTION_TRIGGER.maxArchiveBytes };
  assert.equal(decideLedgerCompaction(justUnder, undefined, NOW).fire, false);
});

// ── the throttle, and why it must be distinguishable from "healthy" ─────────────────────────────

test("W1-T3368: a fire inside the interval is THROTTLED, and says so rather than reading as healthy", () => {
  const d = decideLedgerCompaction(FATAL, NOW - 5 * MIN, NOW);
  assert.equal(d.fire, false);
  assert.match(d.reason, /throttled/);
  assert.match(d.reason, /over bound/, "a throttled tick must still report that the corpus is over bound");
  assert.doesNotMatch(d.reason, /under bound/, "throttled and healthy must never render the same");
});

test("W1-T3368: once the interval has passed, the same over-bound corpus fires again", () => {
  const justInside = decideLedgerCompaction(FATAL, NOW - (DEFAULT_LEDGER_COMPACTION_TRIGGER.minIntervalMs - 1), NOW);
  assert.equal(justInside.fire, false, "one millisecond inside the interval must still throttle");
  const justOutside = decideLedgerCompaction(FATAL, NOW - DEFAULT_LEDGER_COMPACTION_TRIGGER.minIntervalMs, NOW);
  assert.equal(justOutside.fire, true, "at the interval it must fire — the bound is 'at or beyond'");
});

test("W1-T3368: a marker stamped in the FUTURE throttles rather than looping", () => {
  // A clock shift must not turn this rung into a daemon that compacts instead of building.
  const d = decideLedgerCompaction(FATAL, NOW + 60 * MIN, NOW);
  assert.equal(d.fire, false, d.reason);
  assert.match(d.reason, /throttled/);
});

test("W1-T3368: the interval never holds back a HEALTHY corpus into looking throttled", () => {
  const d = decideLedgerCompaction(FRESH, NOW - 1, NOW);
  assert.match(d.reason, /under bound/, "the bound is checked before the interval for a healthy corpus");
});

// ── the pressure read ───────────────────────────────────────────────────────────────────────────

test("W1-T3368: pressure counts BOTH rotation forms — a glob naming one answers from the other", () => {
  const names = [
    "ledger.ndjson", // the LIVE file is not an archive
    "ledger.2026-09-01T00-00-00-000Z.ndjson", // plain rotation
    "ledger.2026-09-02T00-00-00-000Z.ndjson.gz", // gzip rotation
    "ledger.ndjson.rotate.lock",
    "status.json",
  ];
  const p = readLedgerCorpusPressure("/state", {
    readdir: () => names,
    sizeOf: (path) => (path.endsWith(".gz") ? 2000 : 1000),
  });
  assert.equal(p.archiveCount, 2, "both forms must count, and the live file must not");
  assert.equal(p.archiveBytes, 3000);
});

test("W1-T3368: an UNREADABLE state dir reads as zero pressure and fires nothing", () => {
  // The safe direction: an unreadable corpus is a reason to stay out of the way, never to start
  // deleting. A throw here would also break a daemon tick, which this rung may never do.
  const p = readLedgerCorpusPressure("/gone", {
    readdir: () => {
      throw new Error("ENOENT");
    },
    sizeOf: () => 0,
  });
  assert.deepEqual(p, { archiveCount: 0, archiveBytes: 0 });
  assert.equal(decideLedgerCompaction(p, undefined, NOW).fire, false);
});

test("W1-T3368: an archive that cannot be stat'd still COUNTS — it is a file a union read would open", () => {
  const p = readLedgerCorpusPressure("/state", {
    readdir: () => ["ledger.2026-09-01T00-00-00-000Z.ndjson.gz", "ledger.2026-09-02T00-00-00-000Z.ndjson.gz"],
    sizeOf: (path) => {
      if (path.includes("2026-09-02")) throw new Error("EACCES");
      return 500;
    },
  });
  assert.equal(p.archiveCount, 2, "an unstattable archive is still an archive");
  assert.equal(p.archiveBytes, 500);
});

// ── the wiring, and the contract it changes ─────────────────────────────────────────────────────

/**
 * One daemon cycle with the rung wired however the caller asks, returning the rows it logged.
 * Driving the REAL `runDaemon` is the point: what has to hold is that a decision reaches a ledger
 * row still carrying its own reason, and a read of daemon.ts as text witnesses the spelling of that
 * wiring rather than the wiring — it passes on a block no caller can reach (#981 sent a diagnosis
 * the wrong way for hours on exactly that mismatch).
 */
async function daemonRows(deps: Partial<DaemonDeps>): Promise<Array<{ step: string; extra?: Record<string, unknown> }>> {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-lcr-"));
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    let stopChecks = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks += 1;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
      ...deps,
    });
    return rows.filter((r) => r.step.startsWith("ledger_compaction"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIRES = { fire: true as const, reason: "959 archives over bound 400" };
const OUTCOME = { sourceCount: 40, rowsWritten: 9_000, duplicatesCollapsed: 3, archiveName: "ledger.2026-09-01T00-00-00-000Z.ndjson.gz" };

test("W1-T3368: a FIRING decision runs one pass, and the .ran row carries THAT decision's reason", async () => {
  let passes = 0;
  const rows = await daemonRows({
    checkLedgerCompaction: () => FIRES,
    runLedgerCompaction: async () => {
      passes += 1;
      return OUTCOME;
    },
  });
  assert.equal(passes, 1, "a firing decision must actually invoke the runner, exactly once per cycle");
  assert.deepEqual(rows.map((r) => r.step), ["ledger_compaction.fired", "ledger_compaction.ran"]);
  assert.equal(rows[1].extra?.reason, FIRES.reason, "the reason must travel with the outcome, never be re-derived");
  assert.equal(rows[1].extra?.source_count, OUTCOME.sourceCount);
  assert.equal(rows[1].extra?.rows_written, OUTCOME.rowsWritten);
});

test("W1-T3368: a pass that finds nothing eligible is a RESULT, distinguishable from a break", async () => {
  const rows = await daemonRows({
    checkLedgerCompaction: () => FIRES,
    runLedgerCompaction: async () => undefined,
  });
  assert.deepEqual(rows.map((r) => r.step), ["ledger_compaction.fired", "ledger_compaction.nothing_eligible"]);
  assert.equal(rows[1].extra?.reason, FIRES.reason);
});

test("W1-T3368: a compaction that THROWS is best-effort — the cycle survives and the row says what it was trying to do", async () => {
  const rows = await daemonRows({
    checkLedgerCompaction: () => FIRES,
    runLedgerCompaction: async () => {
      throw new Error("gzip write failed");
    },
  });
  assert.deepEqual(rows.map((r) => r.step), ["ledger_compaction.fired", "ledger_compaction.run_failed"]);
  assert.equal(rows[1].extra?.reason, FIRES.reason, "a failure must also say what it was trying to do");
  assert.match(String(rows[1].extra?.error), /gzip write failed/);
});

test("W1-T3368: a REFUSING decision never runs a pass, and names why", async () => {
  let passes = 0;
  const rows = await daemonRows({
    checkLedgerCompaction: () => ({ fire: false, reason: "12 archives under bound 400" }),
    runLedgerCompaction: async () => {
      passes += 1;
      return OUTCOME;
    },
  });
  assert.equal(passes, 0, "a refusing decision must never invoke the runner");
  assert.deepEqual(rows.map((r) => r.step), ["ledger_compaction.skipped"]);
  assert.match(String(rows[0].extra?.reason), /under bound/);
});

test("W1-T3368: a CHECK that throws is survivable too — an unreadable corpus never breaks a cycle", async () => {
  let passes = 0;
  const rows = await daemonRows({
    checkLedgerCompaction: () => {
      throw new Error("state dir vanished");
    },
    runLedgerCompaction: async () => {
      passes += 1;
      return OUTCOME;
    },
  });
  assert.equal(passes, 0);
  assert.deepEqual(rows.map((r) => r.step), ["ledger_compaction.check_failed"]);
});

test("W1-T3368: the rung is OPTIONAL, so a host that never wires it behaves exactly as before", async () => {
  const rows = await daemonRows({});
  assert.deepEqual(rows, [], "an unwired rung emits nothing at all");
});

test("W1-T3368: the verb's own help no longer claims it never runs from a daemon cadence", async () => {
  // A contract whose code disagrees with its own description is the defect class this change exists
  // to stop repeating, so retiring that half of the contract is part of the change, not a follow-up.
  // Rendered through the same `commandHelp` an operator reaches, not read off the registry's source.
  const { COMMANDS, commandHelp } = await import("../src/run-task.js");
  const spec = COMMANDS.find((c) => c.name === "ledger-compact");
  assert.ok(spec, "the ledger-compact verb must still be in the registry rmd --help renders from");
  const help = commandHelp(spec);
  assert.equal(
    /never runs from rotateLedger or a daemon cadence/.test(help),
    false,
    "the help still claims no daemon cadence runs it, which is now false",
  );
  assert.match(help, /never a rotateLedger dependency/, "the half that is STILL TRUE must survive explicitly");
  assert.match(help, /W1-T3368/, "and the change must be attributable from the help itself");
});

test("W1-T3368: a caller may override every bound, so a host with a different corpus is not stuck with ours", () => {
  const tight: LedgerCompactionTrigger = { maxArchives: 5, maxArchiveBytes: 1, minIntervalMs: 0 };
  assert.equal(decideLedgerCompaction(FRESH, undefined, NOW, tight).fire, true);
  const loose: LedgerCompactionTrigger = { maxArchives: 10_000, maxArchiveBytes: 2 ** 40, minIntervalMs: 0 };
  assert.equal(decideLedgerCompaction(FATAL, undefined, NOW, loose).fire, false);
});
