/**
 * W1-T12754 — A FULL SWEEP JOINS THE TICK READ ALREADY IN FLIGHT.
 *
 * On the Azure host core ledger, 2026-11-12T22:31Z to 2026-11-14T22:31Z, 71 of 133 full passes did their own tick
 * read: 29,680 s in the tick_read stage, median 319 s. The read plane runs reads one after another, so each waited
 * for the tick's read in flight and then ran its own. 55 of the 71 had no row that said why the published
 * generation was not used. A full pass that misses the published generation now waits for the read in flight and
 * is served it, once, and its `sweep.full_prelude` row names the miss and the wait.
 *
 * FIXTURES ONLY: the gh stand-in, the ledger and the state root live in throwaway directories. The worker is a
 * real worker thread that answers each request with its input after a short delay.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { clockFromMillisFn } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import {
  freezeReadGeneration, joinableRead, keepLastServe, onePassPerGeneration, startReadPlane, TICK_READ_MAX_AGE_MS,
  type ReadGeneration,
} from "#src/lib/read-plane.js";
import { readLedgerLines } from "#src/lib/status.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import type { TickReadFacts } from "#src/lib/tick-read-worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { buildSweepHook, servedTickRead } from "#test/helpers/run-task-test.js";

const READ_DELAY_MS = 150;
const HOUR_MS = 60 * 60_000;

/** A real read plane over a worker thread that answers each request with its input after READ_DELAY_MS. */
function plane<T>(clockMs?: () => number) {
  let requests = 0;
  const started = startReadPlane({
    workerUrl: pathToFileURL(join(REPO_ROOT, "src", "run-task.ts")), workerInput: {},
    spawn: () => {
      const worker = new Worker(`const { parentPort } = require('node:worker_threads');
        parentPort.on('message', ({ generation, input }) =>
          setTimeout(() => parentPort.postMessage({ generation, facts: input }), ${READ_DELAY_MS}));`, { eval: true });
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message: unknown) => { requests++; post(message); };
      return worker;
    },
    inline: () => { throw new Error("the worker answers"); },
    log: () => {},
    ...(clockMs ? { clock: clockFromMillisFn(clockMs) } : {}),
  });
  return { read: (input: T) => started.read(input), stop: () => started.stop(), requests: () => requests };
}

function oldGeneration<T>(facts: T, publishedAtMs: number, generation = 100): ReadGeneration<T> {
  return freezeReadGeneration({ generation, source: "worker", publishedAtMs, settledAtMs: publishedAtMs, facts });
}

function facts(views: OpenPrView[] = [], tag = "tick"): TickReadFacts & { tag: string } {
  return {
    plan: { tasks: [], byId: new Map() }, openPrViews: views, openPrRows: [], projection: [], creditUpdates: [],
    creditCandidates: [], escalationCandidates: [], boardItems: [], staleGateWorkflowsByPr: new Map(),
    behindMainByPr: new Map(), baseChangedFilesByPr: new Map(), mergedFixPrNumbers: [], postFixCiFailuresByPr: new Map(),
    closedPrs: [], tag,
  } as unknown as TickReadFacts & { tag: string };
}

/** Runs the real full-pass hook once over `tickReadFor` and returns its rows. */
async function fullPass(tickReadFor: Parameters<typeof buildSweepHook>[20]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12754-`));
  const shim = ghShim([{ when: "", stdout: "[]" }], { kind: "t12754-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const hook = buildSweepHook("o", "r", { root, claudeBin: "/bin/true" } as Config, ledgerPath, "DAEMON-T12754",
      { tasks: [], byId: new Map() }, (step, extra = {}) => logs.push({ step, extra }),
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tickReadFor);
    await hook();
    const prelude = logs.find((l) => l.step === "sweep.full_prelude")?.extra;
    return { prelude, logs, ledger: readLedgerLines(ledgerPath) };
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

/** The daemon's wiring: servedTickRead over onePassPerGeneration, keeping its serve note. */
function wired<T extends object>(current: () => ReadGeneration<T> | undefined,
  read: Parameters<typeof onePassPerGeneration<T, T>>[1], input: () => T, clock?: () => number) {
  return keepLastServe(onePassPerGeneration(current, read, input, clock ? { clock: clockFromMillisFn(clock) } : {}),
    (serve) => servedTickRead(serve, current));
}

test("W1-T12754 criterion 1: each full_prelude row that was not served names its miss and its wait", async () => {
  const published = oldGeneration(facts(), Date.now() - 1_000, 1);
  const p = plane<TickReadFacts>();
  try {
    const tickRead = wired(() => published, joinableRead(p.read), () => facts([], "own"));
    const served = await fullPass(tickRead as never);
    assert.equal(served.prelude?.tick_read_source, "served", "control: the first pass is served the generation");
    assert.equal(served.prelude?.tick_read_miss, undefined);
    const consumed = await fullPass(tickRead as never);
    assert.equal(consumed.prelude?.tick_read_source, "own_read");
    assert.equal(consumed.prelude?.tick_read_miss, "consumed");
    assert.equal(typeof consumed.prelude?.tick_read_wait_ms, "number");
    const stale = await fullPass(wired(() => oldGeneration(facts(), Date.now() - HOUR_MS, 2), joinableRead(p.read),
      () => facts([], "own")) as never);
    assert.equal(stale.prelude?.tick_read_miss, "stale");
    const unpublished = await fullPass(wired(() => undefined, joinableRead(p.read), () => facts()) as never);
    // W1-T13880: with a plane, an unpublished generation is read by the plane, never rebuilt on the loop.
    assert.equal(unpublished.prelude?.tick_read_source, "own_read");
    assert.equal(unpublished.prelude?.tick_read_miss, "unpublished");
    const planeless = wired(() => published, undefined, () => facts());
    await planeless();
    assert.equal((await fullPass(planeless as never)).prelude?.tick_read_miss, "no_plane");
    assert.equal((await fullPass(undefined)).prelude?.tick_read_miss, "no_plane", "no tick read at all");
    // The wait: a pass that reads its own while an earlier read holds the plane waits for that read first.
    const queuedRead = wired(() => published, p.read, () => facts([], "own"));
    await queuedRead();
    const earlier = p.read(facts([], "earlier"));
    const queued = await fullPass(queuedRead as never);
    await earlier;
    assert.equal(queued.prelude?.tick_read_miss, "consumed");
    assert.ok(Number(queued.prelude?.tick_read_wait_ms) >= READ_DELAY_MS - 20, JSON.stringify(queued.prelude));
  } finally { await p.stop(); }
});

test("W1-T12754 criterion 2: a pass that misses the generation is served the read in flight, one worker request", async () => {
  const p = plane<TickReadFacts>();
  try {
    const readTick = joinableRead(p.read);
    const tickRead = wired(() => oldGeneration(facts(), Date.now() - HOUR_MS), readTick, () => facts([], "own"));
    const inFlight = readTick(facts([], "in-flight"));
    const pass = await fullPass(tickRead as never);
    const tick = await inFlight;
    assert.equal(p.requests(), 1, "the worker receives one request, not two");
    assert.equal(pass.prelude?.tick_read_source, "joined");
    assert.equal(pass.prelude?.tick_read_miss, "stale");
    assert.equal(pass.prelude?.snapshot_published_at_ms, tick.publishedAtMs);
    const stages = pass.prelude?.stages as Record<string, number>;
    assert.ok(stages.tick_read >= READ_DELAY_MS - 20, `the tick_read stage ends when that read settles (${stages.tick_read})`);
    assert.equal(tickRead.lastServe()?.source, "joined");
  } finally { await p.stop(); }
});

test("W1-T12754 criterion 3: a generation answers at most one full pass, joined or published", async () => {
  const p = plane<TickReadFacts>();
  try {
    const readTick = joinableRead(p.read);
    let published: ReadGeneration<TickReadFacts> | undefined = oldGeneration(facts(), Date.now() - HOUR_MS);
    const serve = onePassPerGeneration(() => published, readTick, () => facts([], "own"));
    const inFlight = readTick(facts([], "in-flight"));
    const [first, second] = await Promise.all([serve(), serve()]);
    const tick = await inFlight;
    assert.equal(first, tick.facts, "the first pass is served the joined generation");
    assert.notEqual(second, tick.facts, "the second pass reads its own");
    assert.equal((second as { tag?: string } | undefined)?.tag, "own");
    assert.equal(p.requests(), 2, "the tick's read and the second pass's own read");
    published = tick;
    const later = await serve();
    assert.notEqual(later, tick.facts, "the joined generation, once published, is not served to another pass");
    assert.equal(serve.lastServe()?.miss, "consumed");
  } finally { await p.stop(); }
});

test("W1-T12754 criterion 4: a joined read requested longer than the age bound before it settled is not served", async () => {
  let nowMs = 1_000_000;
  let settle!: (generation: ReadGeneration<{ tag: string }>) => void;
  let reads = 0;
  const read = (input: { tag: string }): Promise<ReadGeneration<{ tag: string }>> => {
    reads++;
    if (input.tag === "in-flight") return new Promise((resolve) => { settle = resolve; });
    return Promise.resolve(freezeReadGeneration({ generation: 50 + reads, source: "worker", publishedAtMs: nowMs,
      settledAtMs: nowMs, facts: input }));
  };
  const clock = clockFromMillisFn(() => nowMs);
  const readTick = joinableRead(read, clock);
  const serve = onePassPerGeneration(() => oldGeneration({ tag: "old" }, nowMs - HOUR_MS), readTick, () => ({ tag: "own" }),
    { clock });
  void readTick({ tag: "in-flight" });
  const pass = serve();
  nowMs += TICK_READ_MAX_AGE_MS + 1;
  settle(freezeReadGeneration({ generation: 9, source: "worker", publishedAtMs: 1_000_000, settledAtMs: nowMs,
    facts: { tag: "in-flight" } }));
  assert.deepEqual(await pass, { tag: "own" }, "the pass reads its own");
  assert.equal(serve.lastServe()?.source, "own_read");
  assert.equal(serve.lastServe()?.miss, "stale");
  const row = await fullPass(keepLastServe(serve, (s) => servedTickRead(s, () => undefined)) as never);
  assert.equal(row.prelude?.tick_read_miss, "consumed", "the row names the miss of its own pass");
  // At the bound it is served.
  nowMs = 2_000_000;
  const atBound = onePassPerGeneration(() => oldGeneration({ tag: "old" }, nowMs - HOUR_MS), readTick, () => ({ tag: "own" }),
    { clock });
  void readTick({ tag: "in-flight" });
  const served = atBound();
  nowMs += TICK_READ_MAX_AGE_MS;
  settle(freezeReadGeneration({ generation: 10, source: "worker", publishedAtMs: 2_000_000, settledAtMs: nowMs,
    facts: { tag: "in-flight" } }));
  assert.deepEqual(await served, { tag: "in-flight" });
  assert.equal(atBound.lastServe()?.source, "joined");
});

test("W1-T12754 criterion 5: through the daemon's wiring a full pass sends no second read and ages its rows from that read", async () => {
  const AGO_MS = 90_000;
  const p = plane<TickReadFacts>(() => Date.now() - AGO_MS);
  try {
    const readTick = joinableRead(p.read);
    const tickRead = keepLastServe(onePassPerGeneration(() => oldGeneration(facts(), Date.now() - HOUR_MS), readTick,
      () => facts([], "own")), (serve) => servedTickRead(serve, () => undefined));
    const pr: OpenPrView = {
      prNumber: 12754, prUrl: "https://github.com/o/r/pull/12754", taskId: "W1-T12754", reviewState: "none",
      checksState: "pending", unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), headSha: "12754aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", autoMergeArmed: false,
    };
    const inFlight = readTick(facts([pr], "in-flight"));
    await sleep(10);
    const pass = await fullPass(tickRead as never);
    const tick = await inFlight;
    assert.equal(p.requests(), 1, "no second read request");
    const disposed = pass.ledger.filter((row) => row.step === "sweep.disposed" && row.pr_number === pr.prNumber);
    assert.ok(disposed.length > 0, JSON.stringify(pass.ledger.map((row) => row.step)));
    for (const row of disposed) {
      assert.ok(Number(row.snapshot_age_ms) >= AGO_MS - 1_000,
        `snapshot_age_ms ${String(row.snapshot_age_ms)} is measured from the read's publishedAtMs ${tick.publishedAtMs}`);
    }
    assert.equal(pass.prelude?.snapshot_published_at_ms, tick.publishedAtMs);
  } finally { await p.stop(); }
});
