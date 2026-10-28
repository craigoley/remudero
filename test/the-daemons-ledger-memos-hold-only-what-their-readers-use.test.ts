import assert from "node:assert/strict";
import fs, { rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as command from "#src/run-task.js";
import * as sweep from "#src/lib/sweep.js";
import { createIncrementalLedgerUnion, createSizedMemo, readLedgerUnionRecordsSync, realLedgerFs } from "#src/lib/ledger-union.js";
import { loadPlan } from "#src/lib/plan.js";
import { runDaemon } from "#src/lib/daemon.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const names = ["dispatchSelectionLedgerUnion", "terminalUnionScans", "mergeLogEvidenceByRoot",
  "dispatchFilingCache", "baseReproductionHostCache"];
const at = (offset: number) => new Date(Date.now() - 60_000 + offset).toISOString();

test("W1-T9105: the alive row reports each memo size", async (t) => {
  const fixture = writeLedger([{ ts: at(0), step: "run.start", task_id: "W1-T1", run_id: "r", task_class: "src" }]);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const path = join(fixture.dir, "tasks.yaml");
  writeFileSync(path, "- id: W1-T1\n  title: memo\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n");
  const plan = loadPlan(path);
  command.dispatchValueContextForSelection(plan, () => false, fixture.dir, () => {}, path,
    undefined, () => ({ kind: "refused", reasons: ["fixture"] }));
  const read = command.daemonMemoryTelemetryReader(undefined, { liveThreads: () => [] });
  const before = read().memo_sizes as Record<string, { entries: number; approx_bytes: number }>;
  const gitRead = (_root: string, args: string[]) => {
    if (args.includes("--show-toplevel")) return fixture.dir;
    if (args.includes("--is-shallow-repository")) return "false";
    if (args[0] === "rev-parse") return "a".repeat(40);
    return "filing:1000\n+- id: W1-T1\n";
  };
  assert.equal(command.readDispatchFilingSnapshot(path, gitRead).kind, "ready");
  const populated = read().memo_sizes as typeof before;
  assert.equal(populated.dispatchFilingCache.entries, before.dispatchFilingCache.entries + 1);
  assert.ok(populated.dispatchFilingCache.approx_bytes > before.dispatchFilingCache.approx_bytes);
  assert.equal(command.readDispatchFilingSnapshot(path, gitRead).kind, "ready");
  assert.deepEqual((read().memo_sizes as typeof before).dispatchFilingCache, populated.dispatchFilingCache,
    "repeated filing reads hold one measured snapshot");
  let release!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });
  const rows: Array<Record<string, unknown>> = [];
  await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (taskId) => { await running; return { taskId, runId: "r", merged: false, verdict: "no_pr", costUsd: 0 }; },
    sweepLight: async () => {},
    sleep: async () => { release(); },
    readMemoryTelemetry: read,
    log: (step, fields = {}) => { if (step === "daemon.alive") rows.push(fields); },
  }, { max: 1, pollIntervalMs: 1 });
  assert.ok(rows.length > 0, "the real ticker wrote an alive row");
  const sizes = rows[0].memo_sizes as Record<string, { entries: number; approx_bytes: number }>;
  assert.ok(sizes, "the heartbeat carries memo attribution");
  assert.deepEqual(Object.keys(sizes).sort(), names.slice().sort());
  for (const size of Object.values(sizes)) {
    assert.ok(Number.isSafeInteger(size.entries) && size.entries >= 0);
    assert.ok(Number.isSafeInteger(size.approx_bytes) && size.approx_bytes >= 0);
  }
  assert.ok(sizes.dispatchSelectionLedgerUnion.entries > 0);
  assert.ok(sizes.dispatchSelectionLedgerUnion.approx_bytes > 0);
});

test("W1-T9105: the union keeps only the declared projection with the same answer", (t) => {
  const start = { ts: at(0), step: "run.start", task_id: "W1-T1", run_id: "r", task_class: "src", payload: "x".repeat(100_000) };
  const verdict = { ts: at(100), step: "verdict", task_id: "W1-T1", run_id: "r", verdict: "failed", stage: "managed_checkout.refresh", cost_usd: 2, payload: "y".repeat(100_000) };
  const fixture = writeLedger([verdict], { rotations: [{ at: at(-1000), rows: [start], gz: true }] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const read = createIncrementalLedgerUnion({ holder: "projected-test", reducerVersion: "1", project: command.projectDispatchLedgerRow });
  const options = { step: ["run.start", "verdict", "verdict.merged", "dispatch.cost_of_delay.fallback", "dispatch.cost_of_delay.ready", "dispatch.refused_already_merged"], refuseIncomplete: true };
  const result = read(fixture.dir, options);
  assert.equal(result.archiveCount, 1, "positive control: the projected rows include a real archive");
  assert.ok(result.rows.every((row) => !("payload" in row)), "only consumer fields survive");
  assert.deepEqual(result.rows, [command.projectDispatchLedgerRow(start), command.projectDispatchLedgerRow(verdict)]);
  assert.equal(result.rows[1].stage, verdict.stage, "non-worker verdict evidence survives");
  assert.equal(read.size().entries, 2);
  assert.ok(read.size().approx_bytes < Buffer.byteLength(JSON.stringify([start, verdict])) / 10);
  const bytes = read.size().approx_bytes;
  assert.equal(read(fixture.dir, options), result);
  assert.equal(read.size().approx_bytes, bytes, "cache hits do not accumulate bytes");
  const tasks = [{ id: "W1-T1", title: "one", repo: "remudero", type: "implement" as const, status: "queued" as const,
    verify: "auto" as const, risk: "low" as const, attempts: 0, depends_on: [], files: ["src/a.ts"] }];
  const plan = { tasks, byId: new Map(tasks.map((task) => [task.id, task])) };
  const filing = () => ({ kind: "ready" as const, snapshot: { planTreeSha: "a".repeat(40), filedAtByTaskId: new Map([["W1-T1", Date.parse(start.ts) - 1000]]) } });
  const select = (reader?: typeof readLedgerUnionRecordsSync) => command.dispatchValueContextForSelection(plan, () => false, fixture.dir, () => {}, "plan/tasks.yaml", reader, filing);
  assert.deepEqual(select(read), select(readLedgerUnionRecordsSync));
  assert.deepEqual(select(), select(readLedgerUnionRecordsSync), "production dispatch declares the same projection");
  fixture.append([{ ts: at(200), step: "verdict.merged", task_id: "W1-T1", run_id: "r", payload: "z".repeat(100_000) }]);
  assert.deepEqual(select(read), select(readLedgerUnionRecordsSync), "appended outcomes give the same selection");
  assert.equal(read.size().entries, 3);
  let gunzips = 0;
  const restarted = createIncrementalLedgerUnion({ holder: "projected-test", reducerVersion: "1", project: command.projectDispatchLedgerRow }, {
    ...realLedgerFs, gunzipSync: (buf) => { gunzips++; return realLedgerFs.gunzipSync(buf); },
  });
  assert.deepEqual(restarted(fixture.dir, options).rows, read(fixture.dir, options).rows);
  assert.equal(gunzips, 0, "a restarted reader uses the projected durable digest");
  rmSync(join(fixture.dir, readdirSync(fixture.dir).find((name) => name.endsWith(".ndjson.gz"))!));
  writeFileSync(fixture.path, "");
  assert.equal(read(fixture.dir, options).rows.length, 0);
  assert.equal(read.size().entries, 0, "rotation pruning and live truncation release retained rows");
  assert.ok(read.size().approx_bytes < bytes);
  fixture.append([verdict]);
  assert.equal(read(fixture.dir, options).rows.length, 1);
  rmSync(fixture.path);
  assert.equal(read(fixture.dir, options).rows.length, 0);
  assert.equal(read.size().entries, 0, "a removed live file releases the old cursor's rows");
});

test("W1-T9105: an evicted terminal key gives the same answer", (t) => {
  const url = "https://github.com/o/r/pull/1";
  const terminal = { ts: at(100), step: "pr.terminal", pr_url: url, state: "closed" };
  const fixture = writeLedger([{ ts: at(0), step: "pr.opened", pr_url: url }], { rotations: [{ at: at(200), gz: true,
    rows: [terminal, ...Array.from({ length: 1000 }, (_, i) => ({ ...terminal, pr_url: `https://github.com/o/r/pull/${i + 2}` }))] }] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const before = sweep.terminalUnionScans.size();
  const readFile = realLedgerFs.readFileSync;
  let archiveReads = 0;
  let digestReads = 0;
  t.mock.method(realLedgerFs, "readFileSync", (path: string) => {
    if (path.includes("rotation-digests")) digestReads++;
    else if (path.endsWith(".ndjson.gz")) archiveReads++;
    return readFile(path);
  });
  const lookup = () => ({ prUrl: url, prNumber: 1, state: "closed" as const });
  const appended: unknown[] = [];
  const deps = { ledgerPath: fixture.path, runId: "r", appendLine: (_path: string, row: unknown) => { appended.push(row); } };
  const dry = sweep.runPrTerminalReconcile(lookup, { ...deps, dryRun: true });
  assert.equal(dry.unionRead, true);
  assert.equal(archiveReads, 1, "the cold read opened the archive");
  assert.equal(sweep.terminalUnionScans.size().entries, before.entries + 1, "only the actionable PR is retained");
  assert.ok(sweep.terminalUnionScans.size().approx_bytes > before.approx_bytes);
  const first = sweep.runPrTerminalReconcile(lookup, deps);
  assert.equal(first.appended, 0, "the archived terminal suppresses a duplicate");
  assert.deepEqual(sweep.terminalUnionScans.size(), before, "the consumed closed key is evicted");
  archiveReads = digestReads = 0;
  const repeated = sweep.runPrTerminalReconcile(lookup, deps);
  assert.deepEqual(repeated, first, "an evicted key read from the digest gives the same answer");
  assert.equal(appended.length, 0);
  assert.equal(archiveReads, 0, "eviction never requires decompressing an already digested rotation");
  assert.ok(digestReads > 0, "the evicted key was actually read again from its durable digest");
  fixture.append([{ ts: at(300), step: "pr.opened", pr_url: url }]);
  assert.equal(sweep.runPrTerminalReconcile(lookup, deps).appended, 1, "a later reopen still earns a new terminal row");
  assert.deepEqual(sweep.terminalUnionScans.size(), before);
  assert.equal(sweep.runPrTerminalReconcile(lookup, deps).appended, 0, "the consumed live terminal also settles the PR");
});

test("memo size accounts for nested history, replacement and deletion without walking on reads", () => {
  let measurements = 0;
  const memo = createSizedMemo<string, string>((key, value) => {
    measurements++;
    return { entries: 1, approx_bytes: Buffer.byteLength(key + value) };
  });
  assert.deepEqual(memo.size(), { entries: 0, approx_bytes: 0 });
  memo.set("a", "long");
  assert.deepEqual(memo.size(), { entries: 1, approx_bytes: 5 });
  memo.set("a", "x");
  memo.set("b", "yz");
  for (let i = 0; i < 100; i++) assert.deepEqual(memo.size(), { entries: 2, approx_bytes: 5 });
  assert.equal(measurements, 3, "size reads never revisit a value");
  assert.equal(memo.get("a"), "x");
  assert.equal(memo.delete("missing"), false);
  assert.equal(memo.delete("a"), true);
  assert.deepEqual(memo.size(), { entries: 1, approx_bytes: 3 });
  memo.delete("b");
  assert.deepEqual(memo.size(), { entries: 0, approx_bytes: 0 });
  const history = createSizedMemo<string, Map<string, string>>();
  history.set("root", new Map([["pr", "x".repeat(10_000)]]));
  assert.ok(history.size().approx_bytes > 10_000, "maps held inside the root are attributed too");
  history.set("root", new Map());
  assert.ok(history.size().approx_bytes < 100);
});

test("terminal digest misses notice new archives, failed reads and newly inactionable PRs", (t) => {
  const url = "https://github.com/o/r/pull/22";
  const fixture = writeLedger([{ ts: at(200), step: "pr.opened", pr_url: url }], {
    rotations: [{ at: at(-1000), rows: [{ ts: at(100), step: "pr.terminal", pr_url: url, state: "closed" }] }],
  });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const before = sweep.terminalUnionScans.size();
  const fact = () => ({ prUrl: url, prNumber: 22, state: "merged" as const });
  const deps = { ledgerPath: fixture.path, runId: "r", dryRun: true };
  sweep.runPrTerminalReconcile(fact, deps);
  assert.equal(sweep.terminalUnionScans.size().entries, before.entries + 1);
  writeFileSync(join(fixture.dir, "ledger.2026-10-13T00-00-00-000Z.ndjson"),
    JSON.stringify({ ts: at(300), step: "pr.terminal", pr_url: url, state: "merged" }) + "\n");
  assert.equal(sweep.runPrTerminalReconcile(fact, { ...deps, dryRun: false }).appended, 0,
    "a new final merged fact wins even after a dry-run cached the older closed fact");
  sweep.runPrTerminalReconcile(fact, deps);
  sweep.runPrTerminalReconcile(() => undefined, deps);
  assert.deepEqual(sweep.terminalUnionScans.size(), before, "a PR no longer actionable releases its key");
  t.mock.method(fs, "statSync", () => { throw new Error("inventory unavailable"); });
  const inventoryMiss = sweep.runPrTerminalReconcile(fact, deps);
  assert.equal(inventoryMiss.appended, 0);
  assert.equal(inventoryMiss.unionRead, true, "an unreadable inventory uses the archive reader");
  assert.deepEqual(sweep.terminalUnionScans.size(), before, "an unverifiable inventory cannot populate a hit");
  t.mock.restoreAll();
  rmSync(join(fixture.dir, "ledger.2026-10-13T00-00-00-000Z.ndjson"));
  writeFileSync(join(fixture.dir, "ledger.2026-10-13T01-00-00-000Z.ndjson.gz"), "invalid gzip");
  const appended: Array<Record<string, unknown>> = [];
  assert.equal(sweep.runPrTerminalReconcile(fact, { ...deps, dryRun: false,
    appendLine: (_path, row) => { appended.push(row); } }).appended, 1);
  assert.equal(appended[0].union_unread, 1, "archive failure is carried on the new terminal row");
  assert.deepEqual(sweep.terminalUnionScans.size(), before, "partial archive reads are not retained as complete");
});
