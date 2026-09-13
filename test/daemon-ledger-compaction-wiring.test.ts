import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildLedgerCompactionDaemonHooks, daemonCommand, lastLedgerCompactionFiredAtMs } from "../src/run-task.js";
import { fixedClock } from "../src/lib/clock.js";
import { loadConfig } from "../src/lib/config.js";
import type { LedgerCompactCommandDeps } from "../src/lib/ledger-compact.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";

type Compactor = (rest: string[], deps: LedgerCompactCommandDeps) => number;

// W1-T3368's original test drove `runDaemon` with manually injected compaction functions. That
// proves the loop consumer, but not the production composition root that has to supply them. This
// suite builds the real self-target daemon command, captures the real dependency object, and runs
// its bounded compactor against a disposable state directory.

function fixtureHome(): { home: string; planPath: string; stateDir: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-ledger-compaction-"));
  const root = join(home, "Remudero");
  const stateDir = join(root, "state");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root }),
  );
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { home, planPath, stateDir };
}

function writeOverboundCorpus(stateDir: string): void {
  const row = `${JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", step: "fixture" })}\n`;
  // 401 is one above W1-T3368's measured 400-archive trigger. The production floor must admit
  // a corpus that is older than one day but younger than the operator CLI's seven-day default.
  const fourDaysAgoMs = Date.now() - 4 * 24 * 60 * 60_000;
  for (let i = 0; i < 401; i += 1) {
    const stamp = new Date(fourDaysAgoMs - i).toISOString().replaceAll(":", "-").replace(".", "-");
    writeFileSync(join(stateDir, `ledger.${stamp}.ndjson`), row);
  }
}

test("daemonCommand: the self-target daemon wires and runs the bounded ledger compaction rung", async () => {
  const { home, planPath, stateDir } = fixtureHome();
  writeOverboundCorpus(stateDir);
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }

  try {
    assert.ok(captured, "the real daemonCommand composition root reached runDaemon");
    assert.equal(typeof captured.checkLedgerCompaction, "function", "the pressure check reaches the live daemon");
    assert.equal(typeof captured.runLedgerCompaction, "function", "the bounded runner reaches the live daemon");

    const decision = captured.checkLedgerCompaction!();
    assert.equal(decision.fire, true, decision.reason);
    assert.match(decision.reason, /401 archive\(s\) > 400/);

    const outcome = await captured.runLedgerCompaction!();
    assert.deepEqual(
      outcome && {
        sourceCount: outcome.sourceCount,
        rowsWritten: outcome.rowsWritten,
        duplicatesCollapsed: outcome.duplicatesCollapsed,
      },
      { sourceCount: 50, rowsWritten: 1, duplicatesCollapsed: 49 },
      "the real production hook invokes exactly one bounded 50-source pass",
    );
    assert.ok(outcome?.archiveName, "the outcome names the durable replacement archive");
    assert.ok(existsSync(join(stateDir, outcome!.archiveName)), "the replacement was atomically written in the configured state dir");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("lastLedgerCompactionFiredAtMs: only a valid latest fire row throttles a later daemon tick", () => {
  const first = "2026-09-12T00:00:00.000Z";
  const latest = "2026-09-12T00:30:00.000Z";
  const rows = [
    JSON.stringify({ ts: first, step: "ledger_compaction.fired" }),
    '{"step":"ledger_compaction.fired"',
    JSON.stringify({ ts: "not-a-date", step: "ledger_compaction.fired" }),
    JSON.stringify({ ts: latest, step: "ledger_compaction.fired" }),
    JSON.stringify({ ts: "2026-09-12T01:00:00.000Z", step: "ledger_compaction.ran" }),
  ];
  assert.equal(lastLedgerCompactionFiredAtMs(rows), Date.parse(latest));
  assert.equal(lastLedgerCompactionFiredAtMs(['{"step":"ledger_compaction.fired"']), undefined, "a torn row must not invent a throttle marker");
});

test("buildLedgerCompactionDaemonHooks: the shared Clock port controls the compaction cooldown", () => {
  const { home, stateDir } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writeOverboundCorpus(stateDir);
    const lastFired = "2026-09-12T00:00:00.000Z";
    writeFileSync(join(stateDir, "ledger.ndjson"), `${JSON.stringify({ ts: lastFired, step: "ledger_compaction.fired" })}\n`);
    const hooks = buildLedgerCompactionDaemonHooks({
      config: loadConfig(),
      clock: fixedClock(Date.parse(lastFired) + 15 * 60_000),
    });
    const decision = hooks.checkLedgerCompaction();
    assert.equal(decision.fire, false);
    assert.equal(decision.overBound, true);
    assert.match(decision.reason, /throttled — last compaction 900s ago/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildLedgerCompactionDaemonHooks: an untrustworthy compactor outcome fails loudly instead of reading as a completed pass", async () => {
  const { home } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const config = loadConfig();
    const cases: Array<{
      name: string;
      compact: Compactor;
      expected: RegExp;
    }> = [
      {
        name: "nonzero exit",
        compact: (_rest, deps) => {
          deps.error?.("fixture compactor write failed");
          return 1;
        },
        expected: /fixture compactor write failed/,
      },
      { name: "missing report", compact: () => 0, expected: /without its required outcome report/ },
      {
        name: "unreadable report",
        compact: (_rest, deps) => {
          deps.out?.("not json");
          return 0;
        },
        expected: /unreadable outcome report/,
      },
      {
        name: "invalid report schema",
        compact: (_rest, deps) => {
          deps.out?.(JSON.stringify({ sourceCount: 1 }));
          return 0;
        },
        expected: /invalid outcome report/,
      },
    ];
    for (const scenario of cases) {
      const hooks = buildLedgerCompactionDaemonHooks({ config, compact: scenario.compact });
      await assert.rejects(hooks.runLedgerCompaction(), scenario.expected, scenario.name);
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
