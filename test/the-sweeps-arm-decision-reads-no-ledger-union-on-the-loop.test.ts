import assert from "node:assert/strict";
import fs, { cpSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveLedgerUnion, ledgerRotationEntries } from "#src/lib/ledger-union.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

// W1-T13288. OBSERVED 2026-11-17: two daemon loop stalls of 79 s and 109 s, about 70% of each in decideSweepArm's
// default readArmLedgerUnion closure, which read every rotation synchronously (resolveLedgerUnion) whenever a
// mergeable PR's review.posted row had rotated out of the live file. Each test here drives the real runSweep with
// deps.readLedgerUnion unset, as every production caller does, over a state dir with real gzip archives.

const NOW = Date.parse("2026-11-17T00:30:00Z");
const HEAD = "head-13288";
/** A whole-second mtime, so restoring it reproduces the size:mtime key a digest is bound to. */
const MTIME_S = 1_794_000_000;
const ROTATION = /[\\/]ledger\.[^\\/]+\.ndjson(\.gz)?$/;

function pr(n: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: n,
    prUrl: `https://github.com/craigoley/remudero/pull/${n}`,
    taskId: `W1-T${n}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-11-16T23:00:00Z",
    headSha: HEAD,
    autoMergeArmed: false,
    ...over,
  };
}

function posted(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-11-16T22:00:00.000Z", run_id: "DAEMON-1", task_id: `W1-T${n}`, step: "review.posted",
    context: "remudero-review", state: "success", pr_url: `https://github.com/craigoley/remudero/pull/${n}`,
    head_sha: HEAD, proof_exec: ["exec_error"], capped: true, keyword_only: false, plan_only: false, ...over,
  };
}

function noise(i: number): Record<string, unknown> {
  return { ts: `2026-11-16T21:${String(i % 60).padStart(2, "0")}:00.000Z`, run_id: "DAEMON-1", task_id: "W1-T1", step: "noise.row", i };
}

function stateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}-`));
}

function archives(dir: string): string[] {
  return ledgerRotationEntries(readdirSync(dir), dir).map((entry) => entry.path);
}

function pinMtimes(dir: string): void {
  for (const path of archives(dir)) utimesSync(path, MTIME_S, MTIME_S);
}

/** A state dir whose live file holds no verdict, and whose archives hold `archived` (plus rows no slice keeps). */
function corpus(prefix: string, archived: Array<Record<string, unknown>>, opts: { gz?: boolean; noArchive?: boolean } = {}): string {
  const dir = stateDir(prefix);
  const filler = Array.from({ length: 400 }, (_, i) => noise(i));
  writeLedger([noise(1000)], {
    dir,
    rotations: opts.noArchive ? [] : [
      { at: "2026-11-16T20:00:00.000Z", rows: filler.slice(0, 200) },
      { at: "2026-11-16T22:30:00.000Z", rows: [...filler.slice(200), ...archived], gz: opts.gz ?? true },
    ],
  });
  pinMtimes(dir);
  return dir;
}

interface Pass {
  deps: SweepDeps;
  armed: number[];
  logs: Array<{ step: string; fields: Record<string, unknown> }>;
}

function deps(dir: string): Pass {
  const armed: number[] = [];
  const logs: Pass["logs"] = [];
  return {
    armed,
    logs,
    deps: {
      arm: (p) => { armed.push(p.prNumber); },
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
      ledgerPath: join(dir, "ledger.ndjson"),
      runId: "SWEEP-T13288",
      now: () => NOW,
      log: (step, fields) => { logs.push({ step, fields: fields ?? {} }); },
    },
  };
}

/** `arm`: the read was made for the arm decision (decideSweepArm's own union read, or the arm history load). */
interface RotationRead { path: string; kind: "sync" | "stream"; startTurn: number; endTurn: number; arm: boolean }

const ARM_FRAME = /\b(decideSweepArm|readArmVerdictHistory|loadArmVerdictHistory)\b/;
const armFrame = (): boolean => ARM_FRAME.test(new Error().stack ?? "");

/** Records every read of a rotation file during `body`, and the event-loop turns each one spanned. */
async function watchRotationReads<T>(body: () => Promise<T>): Promise<{ value: T; reads: RotationRead[]; turns: number }> {
  const reads: RotationRead[] = [];
  let turns = 0;
  let on = true;
  const tick = (): void => {
    if (!on) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  const original = { readFileSync: fs.readFileSync, openSync: fs.openSync, createReadStream: fs.createReadStream };
  const rotation = (path: unknown): path is string => typeof path === "string" && ROTATION.test(path);
  fs.readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (rotation(path)) reads.push({ path, kind: "sync", startTurn: turns, endTurn: turns, arm: armFrame() });
    return (original.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  fs.openSync = ((path: unknown, ...rest: unknown[]) => {
    if (rotation(path)) reads.push({ path, kind: "sync", startTurn: turns, endTurn: turns, arm: armFrame() });
    return (original.openSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.openSync;
  fs.createReadStream = ((path: unknown, ...rest: unknown[]) => {
    const stream = (original.createReadStream as (...args: unknown[]) => fs.ReadStream)(path, ...rest);
    if (rotation(path)) {
      const read: RotationRead = { path, kind: "stream", startTurn: turns, endTurn: turns, arm: armFrame() };
      reads.push(read);
      stream.once("close", () => { read.endTurn = turns; });
    }
    return stream;
  }) as typeof fs.createReadStream;
  syncBuiltinESMExports();
  const stackTraceLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  try {
    return { value: await body(), reads, turns };
  } finally {
    Error.stackTraceLimit = stackTraceLimit;
    Object.assign(fs, original);
    syncBuiltinESMExports();
    on = false;
  }
}

function standDown(dir: string, prNumber: number): string {
  const row = readLedgerLines(join(dir, "ledger.ndjson")).filter((l) => l.step === "sweep.disposed" && l.pr_number === prNumber).at(-1);
  return String(row?.stand_down_reason ?? "");
}

function historyRows(pass: Pass): Array<Record<string, unknown>> {
  return pass.logs.filter((row) => row.step === "sweep.arm_verdict_history_read").map((row) => row.fields);
}

test("W1-T13288 criterion 1: an archived capped verdict still refuses, a clean one still arms, and the history is read off the loop", async () => {
  const capped = corpus("arm-capped", [posted(13001)]);
  const clean = corpus("arm-clean", [posted(13002, { capped: false, proof_exec: ["executed_pass"] })]);
  try {
    const refused = deps(capped);
    const watched = await watchRotationReads(() => runSweep([pr(13001)], refused.deps));
    assert.deepEqual(refused.armed, [], "an archived capped, not plan-only verdict must not arm");
    assert.match(standDown(capped, 13001), /CAPPED verdict/);
    const armReads = watched.reads.filter((r) => r.arm);
    assert.ok(armReads.length > 0, "the arm decision's archived history was read");
    assert.deepEqual(armReads.filter((r) => r.kind === "sync"), [], "no rotation was read synchronously for the arm");
    const start = Math.min(...armReads.map((r) => r.startTurn));
    const end = Math.max(...armReads.map((r) => r.endTurn));
    assert.ok(end > start, `the loop turned while the history was read: ${JSON.stringify(watched.reads)}`);

    const armed = deps(clean);
    await runSweep([pr(13002)], armed.deps);
    assert.deepEqual(armed.armed, [13002], "an archived clean verdict still arms");
  } finally {
    rmSync(capped, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});

test("W1-T13288 criterion 2: a complete corpus with no verdict refuses; no archives or an unreadable rotation refuses (W1-T14317)", async () => {
  const absent = corpus("arm-absent", [posted(13010, { head_sha: "other-head" })]);
  const bare = corpus("arm-bare", [], { noArchive: true });
  const broken = corpus("arm-broken", [posted(13012)]);
  try {
    const refused = deps(absent);
    await runSweep([pr(13010)], refused.deps);
    assert.deepEqual(refused.armed, [], "a complete corpus with no verdict for this head is not permission to arm");
    assert.match(standDown(absent, 13010), /complete ledger union shows no review\.posted verdict for this task and head/);
    assert.equal(historyRows(refused).at(-1)?.complete, true);

    const noArchives = deps(bare);
    await runSweep([pr(13011)], noArchives.deps);
    assert.deepEqual(noArchives.armed, [], "W1-T14317: with no archives the history is unreadable, so the arm is refused");
    assert.match(standDown(bare, 13011), /unreadable verdict history/);
    assert.equal(historyRows(noArchives).at(-1)?.complete, false);

    for (const path of archives(broken)) if (path.endsWith(".gz")) {
      writeFileSync(path, Buffer.alloc(statSync(path).size, 0x21));
      utimesSync(path, MTIME_S, MTIME_S);
    }
    const unreadable = deps(broken);
    await runSweep([pr(13012)], unreadable.deps);
    assert.deepEqual(unreadable.armed, [], "W1-T14317: a rotation the reader cannot read refuses the arm");
    assert.match(standDown(broken, 13012), /unreadable verdict history/);
    assert.equal(historyRows(unreadable).at(-1)?.complete, false);
  } finally {
    for (const dir of [absent, bare, broken]) rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T13288 criterion 3: one pass with three missing PRs loads the verdict history once", async () => {
  const dir = corpus("arm-three", [posted(13021, { capped: false }), posted(13022), posted(13023, { capped: false })]);
  try {
    const pass = deps(dir);
    const watched = await watchRotationReads(() => runSweep([pr(13021), pr(13022), pr(13023)], pass.deps));
    assert.equal(historyRows(pass).length, 1, "the history is loaded once in the pass, not once per decideSweepArm call");
    const perArchive = new Map<string, number>();
    for (const read of watched.reads.filter((r) => r.arm)) perArchive.set(read.path, (perArchive.get(read.path) ?? 0) + 1);
    assert.deepEqual([...perArchive.values()], archives(dir).map(() => 1), "each archive is read once for the arm decisions of the whole pass");
    assert.deepEqual(pass.armed.sort(), [13021, 13023], "each PR still gets its own archived verdict's decision");
    assert.match(standDown(dir, 13022), /CAPPED verdict/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T13288 criterion 4: a restarted reader answers from durable digests and still refuses the capped arm", async () => {
  const first = corpus("arm-digest", [posted(13030)]);
  const restarted = stateDir("arm-restarted");
  try {
    const firstPass = deps(first);
    await runSweep([pr(13030)], firstPass.deps);
    assert.deepEqual(firstPass.armed, []);
    // The restarted process's view: a state dir this process's reader has never loaded, holding the digests the
    // first reader left, and archives overwritten with same-length garbage under their original size and mtime.
    cpSync(first, restarted, { recursive: true });
    for (const path of archives(restarted)) {
      writeFileSync(path, Buffer.alloc(statSync(path).size, 0x21));
      utimesSync(path, MTIME_S, MTIME_S);
    }
    assert.equal(resolveLedgerUnion(restarted, ".*", undefined, { step: "review.posted" }).ok, false, "the archives themselves are unreadable now");
    const pass = deps(restarted);
    await runSweep([pr(13030)], pass.deps);
    assert.deepEqual(pass.armed, [], "the archived capped verdict still refuses, read from its digest");
    assert.match(standDown(restarted, 13030), /CAPPED verdict/);
    const row = historyRows(pass).at(-1);
    assert.equal(row?.complete, true);
    assert.equal(row?.digest_hits, archives(restarted).length, "every rotation came from its digest");
    assert.equal(row?.digest_misses, 0, "no rotation was decompressed");
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(restarted, { recursive: true, force: true });
  }
});

test("W1-T13288 criterion 5: the arm decision makes no synchronous ledger-union read", async () => {
  const dir = corpus("arm-nosync", [posted(13040), posted(13041, { capped: false })]);
  try {
    const pass = deps(dir);
    assert.equal(pass.deps.readLedgerUnion, undefined, "as in every production caller");
    const watched = await watchRotationReads(() => runSweep([pr(13040), pr(13041)], pass.deps));
    assert.deepEqual(pass.armed, [13041]);
    assert.ok(watched.reads.some((r) => r.arm && r.kind === "stream"), "the arm history was read, off the loop");
    assert.deepEqual(watched.reads.filter((r) => r.kind === "sync"), [],
      "no rotation file is read synchronously during the pass: no resolveLedgerUnion or readLedgerUnionRawLinesSync");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
