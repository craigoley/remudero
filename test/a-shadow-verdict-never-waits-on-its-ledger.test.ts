/**
 * W1-T7094 (3a): the shadow verdict never waits on its ledger. A lock held by another process, a missing, unreadable or
 * reset store, an errno from the reader, or an unwritable or full sink each yields a verdict at once that NAMES that
 * state as an uncertainty — never zero reservations — and the real start proceeds unchanged.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { readMemoryLedger } from "../src/lib/host-memory-ledger.js";
import {
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy,
  type ShadowMemoryPorts,
  type ShadowOutcome,
  type ShadowVerdict,
} from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs } from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const MIB = 1024 * 1024;
/** Generous for a CI host; a verdict that waited on a lock or a retry loop would take seconds. */
const AT_ONCE_MS = 500;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow", hostReserveMib: 2048, containerReserveMib: 1024, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2, serveColdStartReserveMib: 7680, uncertaintyMarginMib: 256, daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 1, staleReadingMs: 600_000,
};

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function files(path: string): string {
  const table: Record<string, string> = {
    "/proc/meminfo": "MemAvailable: 8388608 kB\n",
    "/proc/vmstat": "pswpin 7\n",
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${3000 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${12_000 * MIB}\n`,
  };
  const text = table[path];
  if (text === undefined) throw errno("ENOENT", path);
  return text;
}

function ports(over: Partial<ShadowMemoryPorts>, rows: LedgerLine[] = [], stderr: string[] = []): Partial<ShadowMemoryPorts> {
  return {
    clock: fixedClock(NOW),
    readFile: files,
    readTail: () => [
      JSON.stringify({ ts: new Date(NOW - 60_000).toISOString(), step: "daemon.alive", rss_bytes: 4000 * MIB }),
      JSON.stringify({ ts: new Date(NOW - 30_000).toISOString(), step: "serve.memory" }),
    ].join("\n"),
    policy: () => POLICY,
    write: (_path, row) => void rows.push(row),
    stderr: (line) => void stderr.push(line),
    ...over,
  };
}

const START = { workerClass: "implement" as const, reservationId: "own", root: "/state/remudero", estimateMib: 2048 };

function timed(over: Partial<ShadowMemoryPorts>, rows?: LedgerLine[], stderr?: string[]): { outcome: ShadowOutcome; ms: number } {
  resetShadowMemoryStateForTests();
  const began = performance.now();
  const outcome = recordShadowMemoryVerdict(START, ports(over, rows, stderr));
  return { outcome, ms: performance.now() - began };
}

function verdictOf(outcome: ShadowOutcome): ShadowVerdict {
  assert.equal(outcome.kind, "recorded", JSON.stringify(outcome));
  return (outcome as { verdict: ShadowVerdict }).verdict;
}

/** The store's state is named as an uncertainty and never read as zero reservations. */
function assertNamedNeverZero(verdict: ShadowVerdict, kind: string, detail?: RegExp): void {
  const named = verdict.uncertainty.find((u) => u.kind === kind);
  assert.ok(named, `uncertainty ${kind} named; got ${JSON.stringify(verdict.uncertainty.map((u) => u.kind))}`);
  assert.ok(named.marginMib > 0, `${kind} widens the margin`);
  if (detail) assert.match((named.detail ?? []).join(" "), detail);
  assert.ok(verdict.numbers.unrealizedMib >= START.estimateMib, "the start's own claim is still counted: never zero reservations");
}

function scratch(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent);
  return mkdtempSync(join(parent, prefix));
}

test("test/a-shadow-verdict-never-waits-on-its-ledger.test.ts: with the ledger lock held by another process the shadow verdict returns at once with that state named as an uncertainty reason, never as zero reservations", () => {
  for (const code of ["EWOULDBLOCK", "EAGAIN", "EBUSY"]) {
    let calls = 0;
    const { outcome, ms } = timed({ readLedger: () => { calls += 1; throw errno(code, "lock held by pid 4242"); } });
    assert.ok(ms < AT_ONCE_MS, `${code}: returned in ${ms}ms`);
    assert.equal(calls, 1, `${code}: the lock is tried once, never retried`);
    assertNamedNeverZero(verdictOf(outcome), "ledger-lock-held", new RegExp(code));
  }
});

test("with the store missing, unreadable or reset the shadow verdict names that state and never reads zero reservations", () => {
  const dir = scratch("rmd-shadow-ledger-");
  try {
    const store = join(dir, "host-memory");
    const reader = (over: Parameters<typeof readMemoryLedger>[0] = {}, at = store) =>
      () => readMemoryLedger({ location: () => ({ dir: at, scope: "host" }), ...over });

    const missing = timed({ readLedger: reader() });
    assert.ok(missing.ms < AT_ONCE_MS);
    assertNamedNeverZero(verdictOf(missing.outcome), "ledger-missing");

    for (const code of ["EACCES", "EIO"]) {
      const unreadable = timed({ readLedger: reader({ read: () => { throw errno(code); } }) });
      assert.ok(unreadable.ms < AT_ONCE_MS);
      assertNamedNeverZero(verdictOf(unreadable.outcome), "ledger-unreadable", new RegExp(code));
    }

    // A store once seen missing stays so until a sweep acknowledges it, so the reset case reads a store of its own.
    const replaced = join(dir, "replaced");
    mkdirSync(replaced, { recursive: true });
    writeFileSync(join(replaced, ".ledger-id"), "first-store\n");
    const present = timed({ readLedger: reader({}, replaced) });
    assert.equal(present.outcome.kind, "recorded");
    assert.equal(verdictOf(present.outcome).uncertainty.some((u) => u.kind.startsWith("ledger-")), false,
      "the positive control: a present store names no ledger uncertainty");
    writeFileSync(join(replaced, ".ledger-id"), "replaced-store\n");
    const reset = timed({ readLedger: reader({}, replaced) });
    assertNamedNeverZero(verdictOf(reset.outcome), "ledger-reset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reader errno (ENOENT, EACCES, ENOSPC, EIO) or a failed reader is named, at once, never zero", () => {
  for (const code of ["ENOENT", "EACCES", "ENOSPC", "EIO"]) {
    const { outcome, ms } = timed({ readLedger: () => { throw errno(code); } });
    assert.ok(ms < AT_ONCE_MS);
    assertNamedNeverZero(verdictOf(outcome), "ledger-error", new RegExp(code));
  }
  assertNamedNeverZero(verdictOf(timed({ readLedger: () => undefined }).outcome), "ledger-error");
});

test("with the store unwritable or full the verdict is still computed at once and the failure is logged once per hour", () => {
  for (const code of ["ENOSPC", "EROFS", "EACCES"]) {
    const stderr: string[] = [];
    const { outcome, ms } = timed({ readLedger: () => undefined, write: () => { throw errno(code); } }, [], stderr);
    assert.ok(ms < AT_ONCE_MS);
    assert.equal(outcome.kind, "recorded");
    assert.equal((outcome as { written: boolean }).written, false);
    assert.equal(stderr.length, 1, `${code}: the shadow_error reaches stderr when the ledger cannot take it`);
    assert.match(stderr[0]!, new RegExp(`memory_budget.shadow_error.*write:${code}`));
    recordShadowMemoryVerdict(START, ports({ readLedger: () => undefined, write: () => { throw errno(code); } }, [], stderr));
    assert.equal(stderr.length, 1, `${code}: deduplicated per reason per hour`);
  }
});

test("with the ledger lock held and the store full the real start proceeds unchanged", async () => {
  const root = scratch("rmd-shadow-start-");
  const run = async (memoryShadow: Partial<ShadowMemoryPorts>) => {
    resetShadowMemoryStateForTests();
    let queried = 0;
    const result = await spawnWorker({
      cwd: root,
      permissionMode: "bypassPermissions" as const,
      settingsFile: join(REPO_ROOT, "settings", "worker.json"),
      prompt: "work",
      model: "claude-sonnet-4-6",
      effort: "high",
      config: { claudeBin: "/unused", root, dailyCapUsd: 20 } as never,
      providerRouting: {
        readClaudeHealth: async () => ({ degradedModels: [], source: "unknown", detail: "unread" }),
        readClaude: async () => ({ provider: "claude", readable: true, windows: [{ name: "w", usedPercent: 10, resetsAt: NOW / 1000 + 3600 }] }),
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
          yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0.5, num_turns: 2 };
        })();
      }) as never,
    } as SpawnWorkerArgs);
    return { queried, shape: { isError: result.isError, text: result.text, numTurns: result.numTurns, costUsd: result.costUsd } };
  };
  try {
    const rows: LedgerLine[] = [];
    const healthy = await run(ports({ readLedger: () => undefined }, rows));
    assert.equal(rows.filter((row) => row.step === "memory_budget.shadow").length, 1, "the positive control: a row was written");
    const stuck = await run(ports({
      readLedger: () => { throw errno("EWOULDBLOCK", "lock held by pid 4242"); },
      write: () => { throw errno("ENOSPC"); },
    }));
    assert.equal(stuck.queried, 1, "the start ran exactly once");
    assert.deepEqual(stuck, healthy, "the start is unchanged");
  } finally {
    resetShadowMemoryStateForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
