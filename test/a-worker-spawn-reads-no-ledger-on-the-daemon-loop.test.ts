// W1-T13185. OBSERVED 2026-11-16 on the core ledger: one inbox draft spawn stalled the daemon loop for 143 s, almost
// all of it spawnWorkerImpl > readDraftStats > readLedgerUnionRecordsSync over every rotation. The draft stats now
// come from one durable-digest slice reader per process, loaded off the loop: a batch awaits its session's load()
// before the first spawn, and a spawn with no batch session awaits the same reader.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { Config } from "#src/lib/config.js";
import { createDraftStatsSession, DRAFT_STATS_SLICE, draftStatsFromRows, readDraftStats, type DraftStats } from "#src/lib/draft-routing.js";
import { inboxDraftExampleFragmentYaml } from "#src/lib/inbox.js";
import { ledgerRotationEntries, realLedgerFs, type LedgerGrepFsDeps } from "#src/lib/ledger-union.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { createEscalationTriageHistoryReader } from "#src/lib/sweep.js";
import { withTempDir } from "#src/lib/tmp.js";
import { spawnWorker, type WorkerResult } from "#src/lib/worker.js";
import { selectOpenWeightModel } from "#src/lib/worker-provider.js";
import { buildInboxDraftSpawnArgs, draftStatsHistory, readInboxDraftStats } from "#test/helpers/run-task-test.js";

const LANE = "inbox-draft";
const PROMPT = "draft P1";
const MOUNT = { model: "haiku", effort: "high", provider: "cash", maxTurns: 400, contextBudget: 180000 } as const;
const GOOD = `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: - P1 (plan) — RATIFIED 2026-10-01 -> NEW-1.`;
/** A whole-second mtime, so restoring it after an overwrite reproduces the size:mtime key exactly. */
const MTIME_S = 1_794_000_000;
const ARCHIVE_DAYS = ["13", "14", "15"];
const DEPLOYMENTS = ["gpt-5-nano", "gpt-oss-120b"];

type Row = Record<string, unknown>;

/** One day's rows: noise the slice drops, routed outcomes, and legacy synthesized/drafted pairs. */
function dayRows(day: string, noise: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < noise; i++) {
    rows.push({ ts: `2026-11-${day}T01:00:00.${String(i % 1000).padStart(3, "0")}Z`, step: "noise.tick", n: i, day });
    if (i % 200 !== 0) continue;
    const id = `${day}-${i}`;
    rows.push({ ts: `2026-11-${day}T02:00:00Z`, step: "draft.routing.outcome", lane: LANE, deployment: DEPLOYMENTS[i % 400 === 0 ? 0 : 1],
      session_id: `s-${id}`, draft_cost_usd: 0.01 + (i % 3) / 100, clean: i % 600 !== 0, contract_failed: i % 1000 === 0, n: i });
    rows.push({ ts: `2026-11-${day}T03:00:00Z`, step: "inbox.draft_synthesized", run_id: `r-${id}`, proposal_id: "P1",
      routed_model: DEPLOYMENTS[1], provider: "cash", cost_usd: 0.02, n: i });
    rows.push({ ts: `2026-11-${day}T04:00:00Z`, step: i % 400 === 0 ? "inbox.drafted" : "inbox.draft_error", run_id: `r-${id}`,
      proposal_id: "P1", lint_clean: true, fragments: 1, stamps: 0, n: i });
  }
  return rows;
}

const ndjson = (rows: readonly Row[]): string => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

/** A state dir with three gzip archives and a live file; returns every row oldest first, as the union reads them. */
function writeFixture(stateDir: string, opts: { archiveTail?: string; liveTail?: string } = {}): Row[] {
  mkdirSync(stateDir, { recursive: true });
  const all: Row[] = [];
  for (const day of ARCHIVE_DAYS) {
    const rows = dayRows(day, 4_000);
    all.push(...rows);
    const path = join(stateDir, `ledger.2026-11-${day}T23-59-59-000Z.ndjson.gz`);
    writeFileSync(path, gzipSync(ndjson(rows) + (day === ARCHIVE_DAYS[0] && opts.archiveTail ? opts.archiveTail + "\n" : "")));
    utimesSync(path, MTIME_S, MTIME_S);
  }
  const live = dayRows("16", 2_000);
  all.push(...live);
  writeFileSync(join(stateDir, "ledger.ndjson"), ndjson(live) + (opts.liveTail ? opts.liveTail + "\n" : ""));
  return all;
}

function result(text: string, model: string): WorkerResult {
  return { text, blocks: [], model, routedModel: model, provider: "cash", isError: false,
    costUsd: 0.01, sessionId: model, subtype: "success", numTurns: 1, stderr: "", apiError: false,
    permissionDenials: [], childEnvKeys: [], effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], compactionFailures: [], compactionConfigured: false, qualitySuspect: false };
}

/** Counts setImmediate turns: a synchronous read on the loop lets none run. */
function turnCounter(): { readonly count: number; stop(): void } {
  let count = 0;
  let on = true;
  const tick = (): void => { if (on) { count++; setImmediate(tick); } };
  setImmediate(tick);
  return { get count() { return count; }, stop() { on = false; } };
}

interface Spawned {
  attempts: string[];
  rows: Array<{ step: string; extra: Row }>;
  stats?: DraftStats;
  turnsDuringRead: number;
}

/** One production inbox draft spawn (buildInboxDraftSpawnArgs, then spawnWorker) over `root`/state. */
async function spawnDraft(root: string, readStats?: () => DraftStats | Promise<DraftStats>, during?: { start(): void; stop(): void }): Promise<Spawned> {
  const settingsFile = join(root, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  const config = { root, workerHomeRoot: join(root, "worker-home"), claudeBin: "/unused", dailyCapUsd: { normal: 10, squeezed: 10 },
    workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" } } as Config;
  const rows: Spawned["rows"] = [];
  const args = buildInboxDraftSpawnArgs({ cwd: process.cwd(), settingsFile, config, prompt: PROMPT, mount: MOUNT, disallowedTools: [],
    proposalId: "P1", draftRoutingLog: (step, extra = {}) => rows.push({ step, extra }),
    ...(readStats ? { draftRoutingReadStats: readStats } : {}) });
  const spawned: Spawned = { attempts: [], rows, turnsDuringRead: 0 };
  const read = args.draftRouting!.readStats;
  args.draftRouting!.readStats = async () => {
    const turns = turnCounter();
    try {
      spawned.stats = await read();
      return spawned.stats;
    } finally {
      turns.stop();
      spawned.turnsDuringRead = turns.count;
    }
  };
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  during?.start();
  try {
    await spawnWorker({ ...args, providerRouting: { spawnOpenWeight: async (_args, _cfg, selection) => {
      spawned.attempts.push(selection.model);
      return result(GOOD, selection.model);
    } } });
  } finally {
    during?.stop();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
  return spawned;
}

const isRotation = (path: string): boolean => ledgerRotationEntries([basename(path)], dirname(path)).length > 0;

test("W1-T13185 criterion 1: a sessionless draft spawn reads the archived stats off the loop, the same stats a whole read gives", async () => {
  await withTempDir("rmd-draft-spawn-stats-", async (root) => {
    const rows = writeFixture(join(root, "state"));
    const spawned = await spawnDraft(root);
    assert.deepEqual(spawned.stats, draftStatsFromRows(rows, LANE), "the spawn's stats are the stats of every fixture row");
    assert.ok(Object.keys(spawned.stats ?? {}).length === 2, "the archived and live outcomes both reached the stats");
    assert.ok(spawned.turnsDuringRead > 0, `the loop turned while the stats were read (turns: ${spawned.turnsDuringRead})`);
    assert.equal(spawned.rows.filter((row) => row.step === "draft.routing.error").length, 0);
    assert.equal(spawned.rows.find((row) => row.step === "draft.routing.choice")?.extra.reason, "thompson-clean-per-dollar");
  });
});

test("W1-T13185 criterion 2: a fresh reader answers from the durable digests after every archive is overwritten", async () => {
  await withTempDir("rmd-draft-stats-digest-", async (root) => {
    const stateDir = join(root, "state");
    const rows = writeFixture(stateDir);
    const expected = draftStatsFromRows(rows, LANE);
    assert.deepEqual(await readInboxDraftStats(stateDir, LANE), expected, "the process's reader leaves its digests");
    const archives = ledgerRotationEntries(ARCHIVE_DAYS.map((day) => `ledger.2026-11-${day}T23-59-59-000Z.ndjson.gz`), stateDir);
    assert.equal(archives.length, 3);
    for (const { path } of archives) {
      const size = statSync(path).size;
      writeFileSync(path, Buffer.alloc(size, 0x7a));
      utimesSync(path, MTIME_S, MTIME_S);
      assert.equal(statSync(path).size, size);
    }
    // A restarted process: a new reader over the same slice, with no memory of the first.
    const restarted = createEscalationTriageHistoryReader({ slice: DRAFT_STATS_SLICE, parseAll: true });
    assert.deepEqual(await readDraftStats(stateDir, LANE, restarted), expected, "the archived rows come from the digests");
    assert.equal(restarted.lastLoad().digestHits, 3, "each archive was answered by its digest");
    assert.equal(restarted.lastLoad().digestMisses, 0);
  });
});

test("W1-T13185 criterion 3: a second batch reads only the live file's new bytes and counts the first batch's outcome once", async () => {
  await withTempDir("rmd-draft-stats-batches-", async (root) => {
    const stateDir = join(root, "state");
    const livePath = join(stateDir, "ledger.ndjson");
    const rows = writeFixture(stateDir);
    const written: Row[] = [];
    const log = (step: string, extra: Row = {}): void => {
      const row = { ts: "2026-11-16T09:00:00Z", step, ...extra };
      written.push(row);
      appendFileSync(livePath, JSON.stringify(row) + "\n");
    };
    const first = createDraftStatsSession(stateDir, LANE, log, readInboxDraftStats);
    await first.load();
    assert.equal(draftStatsHistory().lastLoad().rotations, 3, "the first batch loads every archive off the loop");
    first.log("draft.routing.outcome", { lane: LANE, deployment: DEPLOYMENTS[1], session_id: "batch-1", draft_cost_usd: 0.02,
      clean: true, contract_failed: false });
    const expected = draftStatsFromRows([...rows, ...written], LANE);
    assert.deepEqual(await first.readStats(), expected, "the first batch learns its own outcome");

    const second = createDraftStatsSession(stateDir, LANE, () => {}, readInboxDraftStats);
    await second.load();
    const load = draftStatsHistory().lastLoad();
    const pass = draftStatsHistory().lastPass();
    assert.equal(load.rotations, 0, "no archive is loaded again");
    assert.equal(load.rotationsRead, 0, "no archive is read on the loop");
    assert.equal(pass.seededRotations, 0);
    const appended = Buffer.byteLength(JSON.stringify(written[0]) + "\n");
    assert.ok(pass.readBytes > 0 && pass.readBytes <= appended + 64,
      `the pass reads the live file from where the previous pass stopped (${pass.readBytes} of ${readFileSync(livePath).length} bytes)`);
    assert.deepEqual(await second.readStats(), expected, "the logged outcome is counted once");
  });
});

test("W1-T13185 criterion 4: a draft spawn, with or without a batch session, reads no rotation synchronously", async () => {
  await withTempDir("rmd-draft-stats-sync-", async (root) => {
    const stateDir = join(root, "state");
    const rows = writeFixture(stateDir);
    const expected = draftStatsFromRows(rows, LANE);

    // With a batch session, as draftProposalBatch builds it: the load is before the spawn, and the spawn reads nothing.
    let reads = 0;
    const session = createDraftStatsSession(stateDir, LANE, () => {}, (dir, lane) => { reads++; return readInboxDraftStats(dir, lane); });
    await session.load();
    assert.equal(reads, 1);
    const batched = await spawnDraft(root, session.readStats);
    assert.equal(reads, 1, "the spawn read no ledger: it answered from the loaded snapshot");
    assert.deepEqual(batched.stats, expected);

    // With no session, through the process's reader: every rotation comes from its off-loop load.
    const sessionless = await spawnDraft(root);
    assert.deepEqual(sessionless.stats, expected);
    assert.equal(draftStatsHistory().lastLoad().rotationsRead, 0, "the process's reader read no rotation on the loop");

    // The same read over counted file-system deps: no synchronous read of a rotation while the spawn runs.
    let spawning = false;
    const syncRotationReads: string[] = [];
    const counted = (path: string): void => { if (spawning && isRotation(path)) syncRotationReads.push(basename(path)); };
    const fs: LedgerGrepFsDeps = { ...realLedgerFs,
      readFileSync: (path) => { counted(path); return realLedgerFs.readFileSync(path); },
      readRangeSync: (path, start, end) => { counted(path); return realLedgerFs.readRangeSync(path, start, end); },
      gunzipSync: (buf) => { if (spawning) syncRotationReads.push("gunzip"); return realLedgerFs.gunzipSync(buf); } };
    const reader = createEscalationTriageHistoryReader({ slice: DRAFT_STATS_SLICE, parseAll: true, fs });
    const watched = await spawnDraft(root, () => readDraftStats(stateDir, LANE, reader),
      { start: () => { spawning = true; }, stop: () => { spawning = false; } });
    assert.deepEqual(watched.stats, expected);
    assert.equal(reader.lastLoad().rotations, 3, "the spawn's read loaded the archives, off the loop");
    assert.deepEqual(syncRotationReads, [], "no rotation was read synchronously during the spawn");
  });
});

const SPLICED_FOREIGN_ROW = '{"ts":"2026-11-13T13:32:26.828Z","actor":"daemon","run_id":"DAEMON-1","task_id":"DAEMON",' +
  '"step":"sweep.fix_capacity","lane":"daemon","surface":"full","queue_depth":0,{"ts":"2026-11-13T13:32:27.001Z",' +
  '"step":"service.error","lane":"serve","error":"ENOSPC: no space left on device, write"}';

test("W1-T13185 criterion 5: a torn line that could be a draft row still refuses the stats and keeps the row order", async () => {
  const unrouted = selectOpenWeightModel(loadMounts(mountsPath(process.cwd())).capabilities, "haiku", "high", Buffer.byteLength(PROMPT));
  const couldBeDraft = [
    { archiveTail: '{"ts":"2026-11-13T05:00:00Z","host":"h","run_id":"r","task' },
    { archiveTail: '{"ts":"2026-11-13T05:00:00Z","step":"inbox.drafted","run_id":"r","proposal_id":"P1","lint_cl' },
    { liveTail: '{"ts":"2026-11-16T05:00:00Z","step":"draft.routing.outcome","lane":"inbox-draft","deploy' },
    { liveTail: '{"ts":"2026-11-16T05:00:00Z","host":"h","run_id":"r","task' },
  ];
  for (const tail of couldBeDraft) {
    await withTempDir("rmd-draft-stats-torn-", async (root) => {
      writeFixture(join(root, "state"), tail);
      const spawned = await spawnDraft(root);
      assert.equal(spawned.stats, undefined, `no stats over ${JSON.stringify(tail)}`);
      const error = spawned.rows.find((row) => row.step === "draft.routing.error");
      assert.equal(error?.extra.reason, "stats-read-failed-row-order");
      assert.match(String(error?.extra.error), /draft stats corpus incomplete: ; torn=1 of 1/);
      assert.equal(spawned.rows.find((row) => row.step === "draft.routing.choice")?.extra.reason, "stats-read-failed-row-order");
      assert.deepEqual(spawned.attempts, [unrouted.model], "the spawn keeps the unrouted model order");
    });
  }
  for (const tail of [{ archiveTail: SPLICED_FOREIGN_ROW },
    { liveTail: '{"ts":"2026-11-16T05:00:00Z","step":"sweep.fix_capacity","lane":"daemon","queue_de' }]) {
    await withTempDir("rmd-draft-stats-foreign-", async (root) => {
      const rows = writeFixture(join(root, "state"), tail);
      const spawned = await spawnDraft(root);
      assert.deepEqual(spawned.stats, draftStatsFromRows(rows, LANE), `a torn ${JSON.stringify(tail)} row names another step`);
      assert.equal(spawned.rows.filter((row) => row.step === "draft.routing.error").length, 0);
    });
  }
});
