/**
 * W1-T7094: every real worker start yields one counterfactual `memory_budget.shadow` row and starts identically whether
 * the verdict is admit, defer or error. The verdict counts only a reservation's UNREALIZED memory (resident tree memory is
 * already inside MemAvailable), widens and names every uncertainty, gives swap-in and PSI their own reasons, tells the
 * four serve scenarios apart, never pools serve-stopped samples with serve-running ones, and its mode is off or shadow.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { HostMemoryReading, ReadingEntry } from "../src/lib/host-memory-ledger.js";
import {
  emptyShadowTally,
  evaluateShadowMemory,
  loadHostMemoryBudgetPolicy,
  parseHostMemoryBudgetPolicy,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  serveScenarioOf,
  summarizeShadowTally,
  type HostMemoryBudgetPolicy,
  type ShadowEntryInput,
  type ShadowInputs,
  type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs } from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const MIB = 1024 * 1024;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow",
  hostReserveMib: 2048,
  containerReserveMib: 1024,
  swapInPagesPerSecMax: 256,
  psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2,
  serveColdStartReserveMib: 7680,
  uncertaintyMarginMib: 256,
  daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6,
  staleReadingMs: 600_000,
};

function entry(over: Partial<ShadowEntryInput> = {}): ShadowEntryInput {
  return {
    id: "r1",
    owner: "remudero@c1",
    workerClass: "implement",
    estimateMib: 2048,
    estimateSource: { kind: "measured", samples: 12 },
    status: "owned",
    walkComplete: true,
    resident: { mib: 0, complete: true },
    ...over,
  };
}

/** A fully measured, calm snapshot whose only claim is the start's own measured, already-recorded reservation. */
function inputs(over: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    memAvailable: { mib: 8192 },
    swapIn: { pagesPerSec: 0 },
    psi: { someAvg10: 0, someAvg60: 0, fullAvg10: 0, fullAvg60: 0 },
    container: { currentMib: 3000, maxMib: 12_000 },
    ledger: { state: "present" },
    entries: [entry({ id: "start" })],
    start: { reservationId: "start", workerClass: "implement", estimateMib: 2048 },
    daemonGrowth: [{ instance: "remudero", samples: 30, growthMib: 200 }],
    serve: { scenario: "serve-steady", basis: "serve.memory 60s ago" },
    ...over,
  };
}

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: "ENOENT" });
}

/** Fake /proc, cgroup and ledger-entry files: a test drives fixture bytes, never the host's. */
function files(memAvailableKb: number, extra: Record<string, string> = {}): (path: string) => string {
  const table: Record<string, string> = {
    "/proc/meminfo": `MemTotal: 16400000 kB\nMemAvailable: ${memAvailableKb} kB\n`,
    "/proc/vmstat": "pgpgin 1\npswpin 100\npswpout 4\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${3000 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${12_000 * MIB}\n`,
    "/sys/fs/cgroup/memory.swap.current": "0\n",
    "/sys/fs/cgroup/memory.stat": "anon 1\nfile 1\n",
    "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    ...extra,
  };
  return (path) => {
    const text = table[path];
    if (text === undefined) throw enoent(path);
    return text;
  };
}

function reading(entries: Array<Partial<ReadingEntry>>): HostMemoryReading {
  const full = entries.map((e, i): ReadingEntry => ({
    id: `r${i}`, owner: "remudero@c1", workerClass: "implement", estimateMib: 2048,
    estimateSource: { kind: "measured", samples: 9 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
    walkComplete: true, path: `/ledger/r${i}.json`, ...e,
  }));
  return {
    state: "present", scope: "host", dir: "/ledger", entries: full,
    counts: { live: full.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: full.reduce((sum, e) => sum + e.estimateMib, 0),
  };
}

function alive(atMs: number, rssMib: number): string {
  return JSON.stringify({ ts: new Date(atMs).toISOString(), step: "daemon.alive", rss_bytes: rssMib * MIB, vm_swap_bytes: 0 });
}

function ports(over: Partial<ShadowMemoryPorts> & { rows?: LedgerLine[] } = {}): Partial<ShadowMemoryPorts> {
  const rows = over.rows ?? [];
  const tail = [...Array(8).keys()].map((i) => alive(NOW - (8 - i) * 60_000, 4000 + (i === 3 ? 300 : 0)))
    .concat(JSON.stringify({ ts: new Date(NOW - 60_000).toISOString(), step: "serve.memory" })).join("\n");
  return {
    clock: fixedClock(NOW),
    readFile: files(8192 * 1024),
    readTail: () => tail,
    readLedger: () => reading([{ id: "start", estimateSource: { kind: "measured", samples: 9 } }]),
    policy: () => POLICY,
    write: (_path, row) => void rows.push(row),
    stderr: () => undefined,
    ...over,
  };
}

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
}

async function startWorker(root: string, memoryShadow: Partial<ShadowMemoryPorts>): Promise<{ queried: number; result: unknown }> {
  let queried = 0;
  const result = await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "work",
    model: "claude-sonnet-4-6",
    effort: "high",
    runId: "run-shadow",
    taskId: "W1-T7094",
    config: { claudeBin: "/unused", root, dailyCapUsd: 20 } as never,
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "unknown", detail: "unread" }),
      readClaude: async () => ({ provider: "claude", readable: true, windows: [{ name: "claude weekly", usedPercent: 10, resetsAt: NOW / 1000 + 3600 }] }),
      writeStatus: () => {},
      now: () => NOW,
    },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] },
    },
    keychain: {
      platform: "linux" as const,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
    },
    memoryShadow,
    queryFn: (() => {
      queried += 1;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0.25, num_turns: 3 };
      })();
    }) as never,
  } as SpawnWorkerArgs).catch((error: unknown) => error);
  return { queried, result };
}

function startShape(result: unknown): unknown {
  if (result instanceof Error) return { error: result.message };
  const r = result as { isError: boolean; text: string; numTurns: number; costUsd: number; subtype: string };
  return { isError: r.isError, text: r.text, numTurns: r.numTurns, costUsd: r.costUsd, subtype: r.subtype };
}

test("test/a-shadow-memory-verdict-never-delays-a-start.test.ts: every real worker start yields one memory_budget.shadow row and starts identically whether the verdict is admit, defer or error", async () => {
  const root = fixtureRoot("rmd-shadow-start-");
  try {
    const outcomes: Record<string, { queried: number; result: unknown; rows: LedgerLine[] }> = {};
    const cases: Record<string, Partial<ShadowMemoryPorts>> = {
      admit: {},
      defer: { readFile: files(512 * 1024) },
      error: { policy: () => { throw new Error("policy unreadable"); } },
    };
    for (const [name, over] of Object.entries(cases)) {
      resetShadowMemoryStateForTests();
      const rows: LedgerLine[] = [];
      const run = await startWorker(root, ports({ ...over, rows }));
      outcomes[name] = { ...run, rows };
    }
    const shadow = (name: string) => outcomes[name]!.rows.filter((row) => row.step === "memory_budget.shadow");
    assert.equal(shadow("admit").length, 1, "an admitted start writes exactly one shadow row");
    assert.equal(shadow("admit")[0]!.would_admit, true);
    assert.equal(shadow("defer").length, 1, "a deferred start writes exactly one shadow row");
    assert.equal(shadow("defer")[0]!.would_admit, false);
    assert.deepEqual(shadow("defer")[0]!.reasons, ["memory-available"]);
    assert.equal(shadow("admit")[0]!.counterfactual, true, "the row says the work started regardless");
    assert.equal(shadow("admit")[0]!.cascades_modelled, false);
    assert.equal(shadow("admit")[0]!.task_id, "W1-T7094");
    assert.equal(typeof shadow("admit")[0]!.shadow_us, "number", "the row carries its own cost");
    assert.deepEqual(outcomes.error!.rows.map((row) => row.step), ["memory_budget.shadow_error"]);
    for (const name of ["admit", "defer", "error"]) {
      assert.equal(outcomes[name]!.queried, 1, `${name}: the worker started exactly once`);
    }
    assert.deepEqual(startShape(outcomes.defer!.result), startShape(outcomes.admit!.result), "defer starts identically");
    assert.deepEqual(startShape(outcomes.error!.result), startShape(outcomes.admit!.result), "error starts identically");
    assert.deepEqual(startShape(outcomes.admit!.result), { isError: false, text: "done", numTurns: 3, costUsd: 0.25, subtype: "success" });
  } finally {
    resetShadowMemoryStateForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resident tree memory is not subtracted twice: a reservation counts only estimate minus its tree's rss+swap", () => {
  const resident = evaluateShadowMemory(inputs({ entries: [entry({ id: "start" }), entry({ id: "busy", resident: { mib: 1800, complete: true } })] }), POLICY);
  assert.equal(resident.numbers.unrealizedMib, 2048 + 248, "the busy tree's 1800 MiB is already inside MemAvailable");
  const over = evaluateShadowMemory(inputs({ entries: [entry({ id: "start" }), entry({ id: "big", resident: { mib: 3000, complete: true } })] }), POLICY);
  assert.equal(over.numbers.unrealizedMib, 2048, "a tree past its estimate claims nothing more, never a negative");

  // The same rule end to end: the tree's rss+swap is read from /proc for verified (pid, start) identities only.
  const stat = (start: number) => `42 (node) S 1 ${"0 ".repeat(17)}${start} 0 0`;
  const read = files(8192 * 1024, {
    "/ledger/r0.json": JSON.stringify({ roots: [{ pid: 42, start: "proc:777" }], tree: [{ pid: 43, start: "proc:999" }] }),
    "/proc/42/stat": stat(777),
    "/proc/42/status": "VmRSS:\t1048576 kB\nVmSwap:\t524288 kB\n",
    "/proc/43/stat": `43 (node) S 42 ${"0 ".repeat(17)}111 0 0`,
    "/proc/43/status": "VmRSS:\t9999999 kB\n",
  });
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const outcome = recordShadowMemoryVerdict({ workerClass: "implement", reservationId: "r0", root: "/state/remudero" },
    ports({ rows, readFile: read, readLedger: () => reading([{ estimateMib: 2048 }]) }));
  assert.equal(outcome.kind, "recorded");
  const numbers = (rows[0]!.numbers as { unrealizedMib: number });
  assert.equal(numbers.unrealizedMib, 2048 - 1536, "1 GiB rss + 0.5 GiB swap resident; pid 43's reused pid is not counted");
});

test("an unmeasured estimate, an uncertain entry or missing growth history widens the margin and is named", () => {
  const calm = evaluateShadowMemory(inputs({ memAvailable: { mib: 4400 } }), POLICY);
  assert.equal(calm.wouldAdmit, true, "the positive control: measured inputs fit");
  assert.equal(calm.numbers.marginMib, 0);

  const unmeasured = evaluateShadowMemory(inputs({
    memAvailable: { mib: 4400 },
    entries: [entry({ id: "start", estimateSource: { kind: "default-unmeasured" } })],
  }), POLICY);
  assert.ok(unmeasured.uncertainty.some((u) => u.kind === "unmeasured-estimate" && u.marginMib > 0));
  assert.equal(unmeasured.numbers.unrealizedMib, 2048, "an unmeasured estimate is never read as zero");
  assert.deepEqual(unmeasured.reasons, ["uncertainty"], "the widened margin, not the measured headroom, tipped it");

  const uncertain = evaluateShadowMemory(inputs({ entries: [entry({ id: "start" }), entry({ id: "foreign", status: "uncertain", walkComplete: false })] }), POLICY);
  assert.deepEqual(uncertain.uncertainty.map((u) => u.kind).sort(), ["incomplete-walk", "uncertain-entry"]);

  const noHistory = evaluateShadowMemory(inputs({ daemonGrowth: [{ instance: "remudero", samples: 2, reason: "2 rows" }] }), POLICY);
  const growth = noHistory.uncertainty.find((u) => u.kind === "daemon-growth-unmeasured");
  assert.equal(growth?.marginMib, POLICY.daemonGrowthUnmeasuredMib);
  assert.ok(noHistory.numbers.marginMib > calm.numbers.marginMib, "missing history widens, never narrows");
});

test("swap-in and PSI each produce their own reason", () => {
  assert.deepEqual(evaluateShadowMemory(inputs({ swapIn: { pagesPerSec: 5000 } }), POLICY).reasons, ["swap-in"]);
  assert.deepEqual(evaluateShadowMemory(inputs({ psi: { someAvg10: 40, someAvg60: 20, fullAvg10: 0 } }), POLICY).reasons, ["psi"]);
  assert.deepEqual(evaluateShadowMemory(inputs({ psi: { someAvg10: 1, someAvg60: 1, fullAvg10: 9 } }), POLICY).reasons, ["psi"]);
  assert.deepEqual(evaluateShadowMemory(inputs(), POLICY).reasons, [], "the positive control: calm swap and pressure admit");
  const ceiling = evaluateShadowMemory(inputs({ container: { currentMib: 9500, maxMib: 12_000 } }), POLICY);
  assert.deepEqual(ceiling.reasons, ["container-ceiling"]);
  assert.equal(ceiling.numbers.unreservedContainerMib, 9500, "container memory no resident tree accounts for is named");
});

test("serve-stopped, serve-steady, serve-cold-start and unknown are distinguished", () => {
  const row = (step: string, agoMs: number) => ({ step, at: NOW - agoMs });
  assert.equal(serveScenarioOf([], NOW).scenario, "unknown");
  assert.equal(serveScenarioOf([row("serve.memory", 60_000)], NOW).scenario, "serve-steady");
  assert.equal(serveScenarioOf([row("serve.memory", 120_000), row("serve.stop", 60_000)], NOW).scenario, "serve-stopped");
  assert.equal(serveScenarioOf([row("serve.memory", 3_600_000)], NOW).scenario, "serve-stopped");
  assert.equal(serveScenarioOf([row("serve.supervisor_start", 30_000)], NOW).scenario, "serve-cold-start");
  assert.equal(serveScenarioOf([row("serve.handoff_requested", 90_000), row("serve.memory", 30_000)], NOW).scenario, "serve-cold-start");
  assert.equal(serveScenarioOf([row("serve.handoff_requested", 90_000), row("serve.handoff_done", 40_000), row("serve.memory", 30_000)], NOW).scenario, "serve-steady");

  const steady = evaluateShadowMemory(inputs({ memAvailable: { mib: 9000 } }), POLICY);
  const cold = evaluateShadowMemory(inputs({ memAvailable: { mib: 9000 }, serve: { scenario: "serve-cold-start", basis: "open" } }), POLICY);
  assert.equal(steady.wouldAdmit, true);
  assert.equal(cold.numbers.coldStartReserveMib, POLICY.serveColdStartReserveMib, "a cold start holds serve's peak in reserve");
  assert.equal(cold.wouldAdmit, false);
  const unknown = evaluateShadowMemory(inputs({ serve: { scenario: "unknown", basis: "no serve rows" } }), POLICY);
  assert.ok(unknown.uncertainty.some((u) => u.kind === "serve-scenario-unknown"));
});

test("a scenario with no samples is reported unvalidated and serve-stopped rows are never pooled with serve-running ones", () => {
  const tally = emptyShadowTally();
  tally["serve-stopped"] = { samples: 5, admit: 5, defer: 0 };
  tally["serve-steady"] = { samples: 2, admit: 1, defer: 1 };
  const summary = summarizeShadowTally(tally);
  assert.equal(summary["serve-cold-start"].validity, "unvalidated");
  assert.equal(summary.unknown.validity, "unvalidated");
  assert.deepEqual(summary["serve-steady"], { samples: 2, admit: 1, defer: 1, validity: "sampled" });
  assert.deepEqual(summary["serve-stopped"], { samples: 5, admit: 5, defer: 0, validity: "sampled" });
  assert.deepEqual(Object.keys(summary).sort(), ["serve-cold-start", "serve-steady", "serve-stopped", "unknown"], "no pooled total");

  // A summary row is written on a state change, never per start.
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const start = { workerClass: "implement" as const, reservationId: "r0", root: "/state/remudero" };
  for (let i = 0; i < 3; i += 1) recordShadowMemoryVerdict(start, ports({ rows, readLedger: () => reading([{}]) }));
  recordShadowMemoryVerdict(start, ports({ rows, readLedger: () => reading([{}]), readTail: () => "" }));
  const summaries = rows.filter((row) => row.step === "memory_budget.shadow_summary");
  assert.equal(rows.filter((row) => row.step === "memory_budget.shadow").length, 4);
  assert.deepEqual(summaries.map((row) => row.trigger), ["first", "scenario-change"]);
  const last = summaries.at(-1)!.scenarios as ReturnType<typeof summarizeShadowTally>;
  assert.equal(last["serve-steady"].samples, 3);
  assert.equal(last.unknown.samples, 1);
  assert.equal(last["serve-stopped"].validity, "unvalidated");
});

test("the policy mode accepts only off or shadow", () => {
  const shipped = loadHostMemoryBudgetPolicy();
  assert.equal(shipped.mode, "shadow", "the shipped block parses and runs in shadow");
  const raw = (mode: unknown, origin = "proposal") => ({
    mode: { value: mode, origin },
    ...Object.fromEntries(Object.entries(POLICY).filter(([k]) => k !== "mode")
      .map(([k, v]) => [k, { value: v, origin: "proposal", min: 0, max: 100_000_000 }])),
  });
  assert.equal(parseHostMemoryBudgetPolicy(raw("off")).mode, "off");
  assert.equal(parseHostMemoryBudgetPolicy(raw("shadow")).mode, "shadow");
  for (const mode of ["enforce", "block", "defer", "", undefined]) {
    assert.throws(() => parseHostMemoryBudgetPolicy(raw(mode)), /accepts only "off" or "shadow"/, String(mode));
  }
  assert.throws(() => parseHostMemoryBudgetPolicy(raw("shadow", "net-new")), /must be "proposal"/);

  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const off = recordShadowMemoryVerdict({ workerClass: "review", root: "/state/remudero" }, ports({ rows, policy: () => ({ ...POLICY, mode: "off" }) }));
  assert.equal(off.kind, "off");
  assert.deepEqual(rows, [], "off writes nothing");
});
