// W1-T13969: the daemon loop reads ledger history, the plan and bundle currency without blocking.
//
// MEASURED on the fleet host's daemon.loop_stall_profile rows of 2026-11-20 (3,076 stalls, 20,085 s of lag): the sweep's
// open-escalation history read (runSweep's openEscalationSince) held the loop 97.5 s in readLedgerUnionRecordsSync, 57%
// of all union-read stall time; loadPlanAtRefAsync parsed every shard again on each load (85.5 s); and childEntryIsCurrent
// re-read and re-hashed the whole src/ tree on every currency check (115 s). Each read now answers from a memo that the
// data's own change signal invalidates: a rotation's size and mtime, a shard's content hash, a source file's stat.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import { appendLedger, type LedgerLine } from "#src/lib/ledger.js";
import { readLedgerUnionRecordsSync, rotationStampIso, type LedgerUnionRecordRead } from "#src/lib/ledger-union.js";
import { loadPlanAtRefAsync, mergePlanBlobs, mergePlanBlobsQuarantiningDuplicates, PlanBlobCache, type Plan } from "#src/lib/plan.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import * as sweepModule from "#test/helpers/sweep-test.js";
import { beginOpenEscalationHistoryPass, buildSweepEffects, readOpenEscalationHistory, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const stamp = (offset: number) => new Date(NOW + offset).toISOString();
const rotationName = (offset: number, gz: boolean) =>
  `ledger.${stamp(offset).replace(/:/g, "-").replace(".", "-")}.ndjson${gz ? ".gz" : ""}`;
const TASK = "W1-T13969";
const PR = 19969;
const HEAD = "a13969".padEnd(40, "0");
const RUN = "w1-t13969-run";
const HOLD_REASON = `a needs-human escalation for this exact (task, PR, head ${HEAD}, cause) is ALREADY OPEN and awaiting a human (https://github.com/acme/remudero/issues/19001) — standing down`;

function scratch(t: TestContext, kind: string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t13969-${kind}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const ndjson = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row) + "\n").join("");

/** Every synchronous read of a rotated ledger file under `stateDir`: whole-file reads, opens for a ranged read, and
 *  gunzips. These are the archive bytes a read pays on the event loop. Async loads (createReadStream) are counted apart. */
function countArchiveReads(t: TestContext, stateDir: string) {
  const isArchive = (path: unknown) => typeof path === "string" && dirname(path) === stateDir && rotationStampIso(basename(path)) !== undefined;
  const counts = { sync: 0, async: 0 };
  const readFile = fs.readFileSync, open = fs.openSync, stream = fs.createReadStream;
  const spies = [
    t.mock.method(fs, "readFileSync", (path: unknown, ...args: unknown[]) => {
      if (isArchive(path)) counts.sync++;
      return Reflect.apply(readFile, fs, [path, ...args]);
    }),
    t.mock.method(fs, "openSync", (path: unknown, ...args: unknown[]) => {
      if (isArchive(path)) counts.sync++;
      return Reflect.apply(open, fs, [path, ...args]);
    }),
    t.mock.method(fs, "createReadStream", (path: unknown, ...args: unknown[]) => {
      if (isArchive(path)) counts.async++;
      return Reflect.apply(stream, fs, [path, ...args]);
    }),
  ];
  syncBuiltinESMExports();
  t.after(() => { for (const spy of spies) spy.mock.restore(); syncBuiltinESMExports(); });
  return { counts, reset: () => { counts.sync = 0; counts.async = 0; } };
}

/** The sweep-owned hold shape of test/sweep/flow-review-failed-n-unmet-criterion.test.ts: one blocked-fixable PR whose
 *  open escalation is still open, read from a real state directory (no injected `readLedger`). */
function heldPrSweep(t: TestContext, root: string) {
  const open: OpenIssue[] = [{ number: 19001, url: "https://github.com/acme/remudero/issues/19001", title: "[BLOCKED] review false-block",
    body: `**Task:** ${TASK}\n**Class:** BLOCKED\nhttps://github.com/acme/remudero/pull/${PR}\n**Head:** ${HEAD}\n**Cause:** review\n**Contract:** contract-A\n` }];
  const calls: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const issues: IssueGateway = {
    ensureLabel: () => true, listOpen: () => open,
    create: () => { calls.push("create"); return "https://github.com/acme/remudero/issues/2"; },
    comment: () => { calls.push("comment"); },
  };
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", repoRoot: root, config: { root, claudeBin: "/bin/true" } as Config,
    plan: { tasks: [], byId: new Map() } as unknown as Plan, ledgerPath, runId: RUN,
    log: () => undefined, issuesImpl: issues, ghRunImpl: () => undefined, nowMsImpl: () => NOW,
    readJsonImpl: async () => ({ user: { login: "remudero-fleet[bot]" } }),
  });
  const deps = {
    strikeLadder: effects.strikeLadder,
    fixProgressJudge: async () => ({ verdict: "change-approach", reason: "unchanged", approach: "keep holding" }),
    readTaskContractRevision: () => "contract-A",
    readOpenEscalations: () => open,
    arm: () => { calls.push("arm"); }, close: () => { calls.push("close"); },
    updateBranch: () => { calls.push("refresh"); return "updated"; },
    dispatchFix: () => { calls.push("fix"); }, escalate: () => { calls.push("escalate"); },
    claimFixAdmission: () => ({ admitted: true }),
    readLiveState: (candidate: OpenPrView) => ({ ok: true, state: "OPEN", headSha: candidate.headSha }),
    ledgerPath, runId: RUN, now: () => NOW, log: (step: string, extra?: Record<string, unknown>) => { logged.push({ step, ...extra }); },
    appendLine: (path: string, row: LedgerLine) => appendLedger(path, { ts: stamp(0), ...row }),
  } as unknown as SweepDeps;
  const pr: OpenPrView = {
    prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: TASK, headSha: HEAD,
    headRefName: `run-${TASK}-1795216718486`, checksState: "green", reviewState: "failure",
    unmetCriteria: [{ claim: "the loop never blocks on a history read", proof: "unit test: W1-T13969", met: false,
      reason: "the proof skips publication", proof_exec: "executed_pass" }],
    priorStrikes: 1, autoMergeArmed: false, lastActivityAt: stamp(-HOUR), body: `Builds it.\n\nRemudero-Task: ${TASK}\n`,
  };
  return { ledgerPath, calls, logged, sweep: () => runSweep([pr], deps) };
}

const seedRow = { step: "sweep.disposed", task_id: TASK, pr_number: PR, head_sha: HEAD, run_id: RUN,
  disposition: "blocked-fixable", acted: true, ts: stamp(-8 * HOUR) };
const holdRow = (offset: number) => ({ ...seedRow, acted: false, ts: stamp(offset), open_escalation_hold_since: stamp(offset) });

test("W1-T13969 criterion 1: a repeated sweep pass over unchanged rotations reads no archive bytes on the loop", async (t) => {
  const root = scratch(t, "sweep");
  mkdirSync(join(root, "state"));
  const h = heldPrSweep(t, root);
  const stateDir = dirname(h.ledgerPath);
  // The live file keeps the older acted receipt (the checkpoint) and a newer hold; the archives hold the older hold
  // the history read must recover, so the pass's decision depends on the archive (5 h, inside the 6 h SLO).
  writeFileSync(h.ledgerPath, ndjson([seedRow, holdRow(-HOUR)]));
  writeFileSync(join(stateDir, rotationName(-2 * HOUR, true)), gzipSync(ndjson([holdRow(-5 * HOUR),
    { step: "ci.polling", task_id: "W1-T1", ts: stamp(-5 * HOUR + MIN), detail: "x".repeat(512) }])));
  writeFileSync(join(stateDir, rotationName(-3 * HOUR, false)), ndjson([
    { step: "fix.dispatch", task_id: "W1-T2", head_sha: HEAD, run_id: RUN, ts: stamp(-6 * HOUR) }]));
  const reads = countArchiveReads(t, stateDir);

  await h.sweep();
  const first = readLedgerLines(h.ledgerPath).filter((row) => row.step === "sweep.disposed" && row.run_id === RUN && row.ts === stamp(0));
  assert.equal(first.length, 1, "the first pass disposes the held PR once");
  assert.equal(first[0]!.open_escalation_hold_since, stamp(-5 * HOUR), "the hold is recovered from the archived history");

  reads.reset();
  await h.sweep();
  const second = readLedgerLines(h.ledgerPath).filter((row) => row.step === "sweep.disposed" && row.run_id === RUN && row.ts === stamp(0));
  assert.equal(second.length, 2, "the second pass disposes the held PR again");
  assert.equal(second[1]!.open_escalation_hold_since, stamp(-5 * HOUR), "the second pass makes the same decision");
  assert.equal(reads.counts.sync, 0, "a repeated pass over unchanged rotations reads no archive bytes on the loop");
  assert.equal(reads.counts.async, 0, "and loads no rotation again off the loop");
  assert.deepEqual(h.calls.filter((call) => call === "close"), [], "inside the SLO nothing is rebuilt");
  const summaries = h.logged.filter((row) => row.step === "sweep.summary");
  assert.equal(summaries.length, 2, "each pass writes its summary row");
  assert.deepEqual([summaries[1]!.open_escalation_memo_rotations, summaries[1]!.open_escalation_memo_rows], [2, 2],
    "the pass's summary row says what the history memo holds: both rotations, and their two rows of the history's steps");
});

test("W1-T13969 criterion 1: a corrupt rotation refuses without falling back to a synchronous archive read", async (t) => {
  const stateDir = scratch(t, "corrupt-rotation");
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, ndjson([seedRow, holdRow(-HOUR)]));
  const archive = join(stateDir, rotationName(-2 * HOUR, true));
  writeFileSync(archive, "not a gzip");
  const expected = syncOpenEscalationRead(stateDir, TASK, seedRow.ts);
  assert.equal(expected.ok, false);
  assert.deepEqual(expected.unread, [archive]);
  const reads = countArchiveReads(t, stateDir);

  for (const pass of [1, 2]) {
    reads.reset();
    beginOpenEscalationHistoryPass(ledgerPath);
    const actual = await readOpenEscalationHistory(ledgerPath, TASK, seedRow.ts);
    assert.deepEqual(comparable(actual), comparable(expected), `pass ${pass} refuses the incomplete history`);
    assert.equal(reads.counts.sync, 0, `pass ${pass} reads no corrupt-archive bytes on the loop`);
    assert.equal(reads.counts.async, 1, `pass ${pass} attempts the archive off the loop`);
  }

  writeFileSync(archive, gzipSync(ndjson([holdRow(-5 * HOUR)])));
  const repaired = await readOpenEscalationHistory(ledgerPath, TASK, seedRow.ts);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.rows[0]!.open_escalation_hold_since, stamp(-5 * HOUR), "repair restores the archived hold");
  assert.equal(reads.counts.sync, 0);
});

/** Five rotations an hour apart, each holding one hold row of the task, and the live file's checkpoint. */
function fiveRotations(root: string): string[] {
  writeFileSync(join(root, "ledger.ndjson"), ndjson([seedRow]));
  return [-10, -8, -6, -4, -2].map((hours) => {
    const path = join(root, rotationName(hours * HOUR, hours % 4 === 0));
    writeFileSync(path, hours % 4 === 0 ? gzipSync(ndjson([holdRow((hours - 0.5) * HOUR)])) : ndjson([holdRow((hours - 0.5) * HOUR)]));
    return path;
  });
}

test("W1-T13969 criterion 1: a rotation stays held only while this pass or the one before reached it", async (t) => {
  const exports = sweepModule as unknown as Record<string, unknown>;
  const read = exports.readOpenEscalationHistory as (ledgerPath: string, taskId: string, since: string | undefined) => Promise<LedgerUnionRecordRead>;
  const begin = exports.beginOpenEscalationHistoryPass as (ledgerPath: string) => void;
  const held = exports.openEscalationHistoryHeld as (ledgerPath: string) => { rotations: number; rows: number } | undefined;
  assert.equal(typeof begin, "function", "sweep.ts exports the pass boundary runSweep calls");
  const root = scratch(t, "passes");
  const ledgerPath = join(root, "ledger.ndjson");
  const rotations = fiveRotations(root);
  const reads = countArchiveReads(t, root);
  const old = stamp(-11 * HOUR), recent = stamp(-3 * HOUR);
  // Pass 1: one PR's days-old checkpoint reaches R1..R5; another's recent one reaches R5.
  begin(ledgerPath);
  assert.equal((await read(ledgerPath, TASK, old)).rows.length, 6, "the old window reads every rotation's hold and the checkpoint");
  await read(ledgerPath, TASK, recent);
  assert.equal(reads.counts.async, rotations.length, "the first pass loads each rotation once, off the loop");
  assert.deepEqual(held(ledgerPath), { rotations: 5, rows: 5 });
  // Pass 2: only the recent window. R5, needed by both passes, is not read again; R1..R4 are kept one pass more.
  reads.reset();
  begin(ledgerPath);
  await read(ledgerPath, TASK, recent);
  assert.deepEqual(reads.counts, { sync: 0, async: 0 }, "a rotation needed by both passes is never re-read");
  assert.deepEqual(held(ledgerPath), { rotations: 5, rows: 5 }, "the previous pass's rotations are still held during this pass");
  // Pass 3 begins: no read of pass 2 reached R1..R4, so they leave the memo.
  begin(ledgerPath);
  assert.deepEqual(held(ledgerPath), { rotations: 1, rows: 1 }, "R1..R4 are no longer retained after a pass that did not reach them");
  await read(ledgerPath, TASK, recent);
  assert.deepEqual(reads.counts, { sync: 0, async: 0 }, "R5, read by pass 2, is still answered from the memo");
  const again = await read(ledgerPath, TASK, old);
  assert.equal(again.rows.length, 6, "an old window read again returns the same rows");
  assert.equal(reads.counts.async, 4, "and loads only the four dropped rotations again, off the loop");
  assert.equal(reads.counts.sync, 0);
});

test("W1-T13969 criterion 1: reads with different since windows keep every listed rotation, so neither reloads", async (t) => {
  const read = (sweepModule as unknown as Record<string, unknown>).readOpenEscalationHistory as
    ((ledgerPath: string, taskId: string, since: string | undefined) => Promise<LedgerUnionRecordRead>) | undefined;
  assert.equal(typeof read, "function", "sweep.ts exports the open-escalation history reader the pass uses");
  const root = scratch(t, "windows");
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, ndjson([seedRow]));
  writeFileSync(join(root, rotationName(-6 * HOUR, true)), gzipSync(ndjson([holdRow(-7 * HOUR)])));
  writeFileSync(join(root, rotationName(-2 * HOUR, false)), ndjson([holdRow(-3 * HOUR)]));
  const reads = countArchiveReads(t, root);
  const older = stamp(-8 * HOUR), newer = stamp(-4 * HOUR);
  await read!(ledgerPath, TASK, older);
  await read!(ledgerPath, TASK, newer);
  assert.ok(reads.counts.async >= 2, `the first reads load both rotations off the loop (${reads.counts.async})`);
  assert.equal(reads.counts.sync, 0, "no rotation is read on the loop, even the first time");
  reads.reset();
  const a = await read!(ledgerPath, TASK, older);
  const b = await read!(ledgerPath, TASK, newer);
  assert.deepEqual(reads.counts, { sync: 0, async: 0 }, "a narrower window does not evict the wider window's rotation");
  assert.deepEqual(a.rows.map((row) => String(row.ts)).sort(), [stamp(-7 * HOUR), stamp(-3 * HOUR), seedRow.ts].sort());
  assert.deepEqual(b.rows.map((row) => row.ts), [stamp(-3 * HOUR)]);
  // A rotation rewritten in place (new size and mtime) is its own change signal: it loads again.
  writeFileSync(join(root, rotationName(-2 * HOUR, false)), ndjson([holdRow(-3 * HOUR), holdRow(-150 * MIN)]));
  const c = await read!(ledgerPath, TASK, newer);
  assert.equal(reads.counts.async, 1, "the changed rotation, and only it, is loaded again");
  assert.deepEqual(c.rows.map((row) => row.ts), [stamp(-3 * HOUR), stamp(-150 * MIN)]);
});

/** A git runner over an in-memory tree at one ref: the four commands loadPlanAtRefAsync issues. */
function planGit(files: Map<string, string>, calls: string[]) {
  const blobId = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
  return async (args: string[], stdin?: string): Promise<string> => {
    calls.push(args[0]!);
    if (args[0] === "show") {
      const text = files.get(args[1]!.slice(args[1]!.indexOf(":") + 1));
      if (text === undefined) throw new Error(`no ${args[1]}`);
      return text;
    }
    if (args[0] === "ls-tree" && args[1] === "--name-only") return [...files.keys()].filter((p) => p.startsWith(args[3]!)).join("\n") + "\n";
    if (args[0] === "ls-tree") {
      const dirs = args.slice(3);
      return [...files].filter(([p]) => dirs.some((d) => p.startsWith(d))).map(([p, text]) => `100644 blob ${blobId(text)}\t${p}`).join("\n") + "\n";
    }
    if (args[0] === "cat-file") {
      const byId = new Map([...files].map(([p, text]) => [blobId(text), text]));
      return stdin!.trim().split("\n").map((id) => {
        const text = byId.get(id)!;
        return `${id} blob ${Buffer.byteLength(text)}\n${text}\n`;
      }).join("");
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

function taskYaml(id: string, extra: string[] = []): string {
  return [`- id: ${id}`, `  title: ${id.toLowerCase()}`, "  repo: r", "  type: implement", "  depends_on: []", "  verify: auto",
    "  status: queued", "  attempts: 0", ...extra, ""].join("\n");
}

function planTree(dir: string): Map<string, string> {
  return new Map([
    [`${dir}/tasks.yaml`, taskYaml("MONO-1")],
    [`${dir}/tasks.d/SHARD-1.yaml`, taskYaml("SHARD-1", ["  acceptance:", '    - claim: "it holds"', '      proof: "unit test: SHARD-1"'])],
    [`${dir}/tasks.d/SHARD-2.yaml`, taskYaml("SHARD-2") + taskYaml("SHARD-3")],
    [`${dir}/tasks.d/SHARD-4.yaml`, taskYaml("SHARD-4", ["  files:", "    - src/a.ts"])],
  ]);
}

test("W1-T13969 criterion 2: a plan loaded twice at one tree identity parses each shard once", async () => {
  const dir = "plan-w1t13969-c2";
  const files = planTree(dir);
  const calls: string[] = [];
  const runGit = planGit(files, calls);
  const cache = new PlanBlobCache();
  const load = loadPlanAtRefAsync as unknown as (...args: unknown[]) => Promise<Plan>;
  const first = await load("fixture-root", `${dir}/tasks.yaml`, "origin/main", runGit, undefined, cache);
  const second = await load("fixture-root", `${dir}/tasks.yaml`, "origin/main", runGit, undefined, cache);
  assert.ok(second.tasks.length >= 5 && second.tasks.every((task, i) => task === first.tasks[i]), "the second load reuses the parsed tasks");
  assert.equal(cache.parsedBlobs, 0, "the second load calls parseTasksFromYaml for no shard");
  assert.equal(cache.reusedBlobs, files.size, "every blob, the monolith and each shard, is answered from its parse");
  // One shard's blob changes: only it is parsed again.
  files.set(`${dir}/tasks.d/SHARD-4.yaml`, taskYaml("SHARD-4", ["  files:", "    - src/b.ts"]));
  const third = await load("fixture-root", `${dir}/tasks.yaml`, "origin/main", runGit, undefined, cache);
  assert.deepEqual([cache.parsedBlobs, cache.reusedBlobs], [1, files.size - 1], "a changed blob, and only it, is parsed again");
  assert.deepEqual(third.byId.get("SHARD-4")!.files, ["src/b.ts"]);
  files.set(`${dir}/tasks.d/SHARD-4.yaml`, taskYaml("SHARD-4", ["  files:", "    - src/a.ts"]));
  const restored = await load("fixture-root", `${dir}/tasks.yaml`, "origin/main", runGit, undefined, cache);
  assert.deepEqual([cache.parsedBlobs, cache.reusedBlobs], [0, files.size], "returning to a previous tree parses no shard");
  assert.strictEqual(restored.byId.get("SHARD-4"), first.byId.get("SHARD-4"), "the restored blob reuses its original parse");

  // The daemon's own call names no cache. Another repo may have the same paths at the same ref.
  const dflt = "plan-w1t13969-c2-default";
  const tree = planTree(dflt);
  const git = planGit(tree, []);
  const once = await loadPlanAtRefAsync("fixture-root", `${dflt}/tasks.yaml`, "origin/main", git);
  const otherTree = planTree(dflt);
  otherTree.set(`${dflt}/tasks.d/SHARD-4.yaml`, taskYaml("SHARD-4", ["  files:", "    - src/other.ts"]));
  const other = await loadPlanAtRefAsync("other-root", `${dflt}/tasks.yaml`, "origin/main", planGit(otherTree, []));
  assert.deepEqual(other.byId.get("SHARD-4")!.files, ["src/other.ts"]);
  const twice = await loadPlanAtRefAsync("fixture-root", `${dflt}/tasks.yaml`, "origin/main", git);
  assert.ok(twice.tasks.length >= 5 && twice.tasks.every((task, i) => task === once.tasks[i]),
    "a second default load reuses every parse after an interleaved load from another repository");
});

interface CurrencyVerdict { current: boolean; reason: string; [key: string]: unknown }
const childEntries = createRequire(import.meta.url)(join(REPO_ROOT, "scripts/build-child-entries.mjs")) as {
  sourceHash(root: string): string;
  childEntryIsCurrent(root: string, name: string, opts?: { hashSource?: (root: string) => string }): CurrencyVerdict;
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[]; workers: string[] }): Promise<{ sourceHash: string }>;
};
const ENTRY = "check-proof-main", ENTRY_SOURCE = "src/check-proof-main.ts";

async function builtTree(t: TestContext): Promise<string> {
  const root = join(scratch(t, "bundle"), "tree");
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, ENTRY_SOURCE), "console.log('entry');\n");
  writeFileSync(join(root, "src", "lib", "note.ts"), "export const note = 'before';\n");
  await childEntries.buildChildEntries({ root, entries: [{ name: ENTRY, source: ENTRY_SOURCE }], workers: [] });
  return root;
}

/** Reads of files under `<root>/src`: the bytes sourceHash reads to hash a tree. */
function countSourceReads(t: TestContext, root: string, afterRead?: (path: string) => void): () => number {
  const src = join(root, "src") + sep;
  const read = fs.readFileSync;
  let count = 0;
  const spy = t.mock.method(fs, "readFileSync", (path: unknown, ...args: unknown[]) => {
    const result = Reflect.apply(read, fs, [path, ...args]);
    if (typeof path === "string" && path.startsWith(src)) {
      count++;
      afterRead?.(path);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  return () => count;
}

test("W1-T13969 criterion 3: childEntryIsCurrent judges an unchanged tree without rehashing it", async (t) => {
  const root = await builtTree(t);
  const reads = countSourceReads(t, root);
  const first = childEntries.childEntryIsCurrent(root, ENTRY);
  assert.equal(first.reason, "source-hash-match");
  const afterFirst = reads();
  assert.ok(afterFirst >= 2, `the first check hashes every source file (${afterFirst} reads)`);
  const second = childEntries.childEntryIsCurrent(root, ENTRY);
  assert.deepEqual(second, first);
  assert.equal(reads() - afterFirst, 0, "a second call with the same file stats reuses the first source hash and reads no source file");

  // A changed stat alone (same bytes) reruns sourceHash, and the verdict stays current.
  const note = join(root, "src", "lib", "note.ts");
  utimesSync(note, new Date(NOW), new Date(NOW));
  const beforeTouch = reads();
  assert.equal(childEntries.childEntryIsCurrent(root, ENTRY).reason, "source-hash-match");
  assert.ok(reads() - beforeTouch >= 2, "a changed file's stat reruns sourceHash");

  // A changed file is a stale bundle, judged as the unmemoized hash judges it.
  writeFileSync(note, "export const note = 'after!';\n");
  const beforeEdit = reads();
  const stale = childEntries.childEntryIsCurrent(root, ENTRY);
  assert.ok(reads() - beforeEdit >= 2, "an edited file reruns sourceHash");
  assert.equal(stale.current, false);
  assert.equal(stale.reason, "source-changed");
  assert.equal(stale.now, childEntries.sourceHash(root));
});

test("W1-T13969 criterion 3: an unavailable stat witness still yields the content verdict", async (t) => {
  const root = await builtTree(t);
  const note = join(root, "src", "lib", "note.ts");
  const stat = fs.lstatSync;
  const spy = t.mock.method(fs, "lstatSync", (path: unknown, ...args: unknown[]) => {
    if (path === note) throw Object.assign(new Error("cannot stat source"), { code: "EACCES" });
    return Reflect.apply(stat, fs, [path, ...args]);
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  const base = childEntries.childEntryIsCurrent(root, ENTRY, { hashSource: childEntries.sourceHash });
  assert.equal(base.reason, "source-hash-match");
  assert.deepEqual(childEntries.childEntryIsCurrent(root, ENTRY), base);
});

test("W1-T13969 criterion 3: a source change during hashing preserves the verdict and leaves the hash uncached", async (t) => {
  const root = await builtTree(t);
  const note = join(root, "src", "lib", "note.ts");
  const before = "export const note = 'before';\n";
  let changeOnRead = true;
  const reads = countSourceReads(t, root, (path) => {
    if (path !== note || !changeOnRead) return;
    changeOnRead = false;
    writeFileSync(note, "export const note = 'changed during hashing';\n");
  });
  const base = childEntries.childEntryIsCurrent(root, ENTRY, { hashSource: childEntries.sourceHash });
  assert.equal(base.reason, "source-hash-match", "base judges the bytes it read");
  assert.equal(changeOnRead, false);
  writeFileSync(note, before);
  changeOnRead = true;

  assert.deepEqual(childEntries.childEntryIsCurrent(root, ENTRY), base);
  assert.equal(changeOnRead, false, "the memoized check raced with the same edit");
  const afterRace = reads();
  const stale = childEntries.childEntryIsCurrent(root, ENTRY);
  assert.ok(reads() - afterRace >= 2, "the unstable hash was not cached");
  assert.equal(stale.reason, "source-changed");
  assert.equal(stale.now, childEntries.sourceHash(root));
});

/** A replayed history: plain and gzipped rotations, a torn line, an exact replay across files, a row naming the task
 *  only in a nested field, a row with no string ts, and rows of other tasks and steps. */
function replayedHistory(root: string): void {
  const other = { step: "fix.dispatch", task_id: "W1-T7", head_sha: HEAD, run_id: RUN, ts: stamp(-5 * HOUR) };
  const nested = { step: "sweep.disposed", task_id: "W1-T8", pr_number: 8, head_sha: HEAD, ts: stamp(-4 * HOUR), acted: true,
    loop_decision: { task_id: TASK, route: "close-and-rebuild" } };
  const replay = { ...holdRow(-6 * HOUR), replayed: true };
  writeFileSync(join(root, rotationName(-9 * HOUR, true)), gzipSync(ndjson([holdRow(-10 * HOUR)])));
  const spaced = JSON.stringify(replay).replaceAll("\",\"", "\", \"");
  const escapedId = JSON.stringify({ ...holdRow(-5.25 * HOUR), escapedId: true }).replace(TASK, "\\u0057" + TASK.slice(1));
  const escapedStep = JSON.stringify({ ...holdRow(-5.125 * HOUR), escapedStep: true }).replace("sweep.disposed", "\\u0073weep.disposed");
  writeFileSync(join(root, rotationName(-5 * HOUR, true)), gzipSync(ndjson([replay, other, holdRow(-5.5 * HOUR)]) +
    `${spaced}\n${escapedId}\n${escapedStep}\n{"task_id":"${TASK}", broken\n{torn\n`));
  writeFileSync(join(root, rotationName(-3 * HOUR, false)), ndjson([replay, nested,
    { step: "fix.stood_down", task_id: TASK, site: "rung.strike", reason: HOLD_REASON, read_head_sha: HEAD, ts: stamp(-3.5 * HOUR) },
    { step: "fix.done", task_id: TASK, head_sha: HEAD, run_id: RUN, ts: 12 }]));
  writeFileSync(join(root, "ledger.ndjson"), ndjson([seedRow, replay,
    { step: "fix.done", task_id: TASK, head_sha: HEAD, run_id: RUN, ts: stamp(-2 * HOUR) }, holdRow(-HOUR)]) + spaced + "\n");
}

/** origin/main's read at sweep.ts's open-escalation site, verbatim. */
const syncOpenEscalationRead = (stateDir: string, taskId: string, since: string | undefined) =>
  readLedgerUnionRecordsSync(stateDir, {
    step: ["sweep.disposed", "fix.stood_down", "fix.dispatch", "fix.done"],
    since,
    pattern: new RegExp(JSON.stringify(taskId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    refuseIncomplete: true,
  });
const comparable = (read: LedgerUnionRecordRead) =>
  ({ ok: read.ok, rows: read.rows, torn: read.torn, unread: read.unread, archiveFiles: read.archiveFiles, liveFileRead: read.liveFileRead });

test("W1-T13969 criterion 4: invariant:same-rows-same-decisions on a replayed ledger", async (t) => {
  await t.test("each converted ledger read returns origin/main's rows, including a refuseIncomplete refusal", async (st) => {
    const read = (sweepModule as unknown as Record<string, unknown>).readOpenEscalationHistory as
      ((ledgerPath: string, taskId: string, since: string | undefined) => Promise<LedgerUnionRecordRead>) | undefined;
    assert.equal(typeof read, "function", "sweep.ts exports the open-escalation history reader the pass uses");
    const root = scratch(st, "replay");
    replayedHistory(root);
    const cases: Array<[string, string | undefined]> = [[TASK, stamp(-8 * HOUR)], [TASK, stamp(-11 * HOUR)], [TASK, stamp(-4 * HOUR)],
      [TASK, undefined], ["W1-T7", stamp(-8 * HOUR)], ["W1-T8", stamp(-8 * HOUR)], ["W1-T404", stamp(-8 * HOUR)]];
    const rawReplay = syncOpenEscalationRead(root, TASK, stamp(-8 * HOUR));
    assert.equal(rawReplay.rows.filter((row) => row.replayed === true).length, 2, "base keeps distinct spacing and dedupes exact replays");
    assert.ok(rawReplay.rows.some((row) => row.escapedStep === true), "base accepts an escaped step with a raw task-id match");
    assert.ok(rawReplay.rows.every((row) => row.escapedId !== true), "base excludes a task id written only as a JSON escape");
    assert.equal(rawReplay.torn, 1, "base counts only torn lines with the raw task-id match");
    let compared = 0;
    for (const pass of [1, 2]) {
      for (const [taskId, since] of cases) {
        const expected = syncOpenEscalationRead(root, taskId, since);
        const actual = await read!(join(root, "ledger.ndjson"), taskId, since);
        assert.deepEqual(comparable(actual), comparable(expected), `pass ${pass}: ${taskId} since ${since}`);
        compared += expected.rows.length;
      }
    }
    assert.ok(compared >= 20, `the replay compares real rows, not empty reads (${compared})`);
    writeFileSync(join(root, rotationName(-4 * HOUR, true)), "not a gzip");
    const refusedExpected = syncOpenEscalationRead(root, TASK, stamp(-8 * HOUR));
    assert.equal(refusedExpected.ok, false, "an unreadable rotation refuses the strict read");
    const refused = await read!(join(root, "ledger.ndjson"), TASK, stamp(-8 * HOUR));
    assert.deepEqual(comparable(refused), comparable(refusedExpected), "the memoized read refuses the same incomplete history");
    assert.deepEqual(comparable(await read!(join(root, "ledger.ndjson"), TASK, stamp(-8 * HOUR))), comparable(refusedExpected),
      "the next read refuses the same incomplete history");
    const absent = join(root, "gone", "ledger.ndjson");
    const absentExpected = syncOpenEscalationRead(dirname(absent), TASK, stamp(-8 * HOUR));
    assert.deepEqual(absentExpected.unread, [dirname(absent)], "an absent state directory is unread to the strict read");
    assert.deepEqual(comparable(await read!(absent, TASK, stamp(-8 * HOUR))), comparable(absentExpected),
      "and the memoized read refuses it the same way");
  });

  await t.test("an unreadable live ledger refuses archived history", async (st) => {
    const root = scratch(st, "unreadable-live");
    const ledgerPath = join(root, "ledger.ndjson");
    mkdirSync(ledgerPath); // EISDIR when the reader tries to consume it.
    writeFileSync(join(root, rotationName(-2 * HOUR, false)), ndjson([holdRow(-3 * HOUR)]));
    const expected = syncOpenEscalationRead(root, TASK, seedRow.ts);
    assert.equal(expected.ok, false);
    assert.deepEqual(expected.unread, [ledgerPath]);
    assert.deepEqual(comparable(await readOpenEscalationHistory(ledgerPath, TASK, seedRow.ts)), comparable(expected));
  });

  await t.test("each plan load returns origin/main's plan, and refuses an invalid or duplicated shard the same way", async () => {
    const dir = "plan-w1t13969-c4";
    const files = planTree(dir);
    const git = planGit(files, []);
    const blobs = async () => {
      const paths = [...files.keys()].filter((p) => p.includes("/tasks.d/")).sort();
      return [{ label: `origin/main:${dir}/tasks.yaml`, text: files.get(`${dir}/tasks.yaml`)! },
        ...paths.map((p) => ({ label: `origin/main:${p}`, text: files.get(p)! }))];
    };
    for (const pass of [1, 2]) {
      assert.deepEqual(await loadPlanAtRefAsync("fixture-root", `${dir}/tasks.yaml`, "origin/main", git), mergePlanBlobs(await blobs()), `pass ${pass}`);
    }
    const cache = new PlanBlobCache();
    await loadPlanAtRefAsync("fixture-root", `${dir}/tasks.yaml`, "origin/main", git, undefined, cache);
    for (const [name, text] of [["SHARD-9.yaml", "- id: [unclosed\n"], ["SHARD-5.yaml", taskYaml("SHARD-1")]] as const) {
      files.set(`${dir}/tasks.d/${name}`, text);
      let expected: unknown;
      try { mergePlanBlobs(await blobs()); } catch (error) { expected = error; }
      assert.ok(expected instanceof Error, `${name} is refused at base`);
      for (const pass of [1, 2]) {
        await assert.rejects(() => loadPlanAtRefAsync("fixture-root", `${dir}/tasks.yaml`, "origin/main", git, undefined, cache),
          (error: Error) => error.constructor === (expected as Error).constructor && error.message === (expected as Error).message,
          `pass ${pass}: ${name} is refused with origin/main's error`);
        const input = await blobs();
        const quarantined = mergePlanBlobsQuarantiningDuplicates(input);
        assert.ok(quarantined.quarantined.length > 0, `${name} yields quarantine evidence`);
        assert.deepEqual(mergePlanBlobsQuarantiningDuplicates(input, cache), quarantined, `pass ${pass}: ${name} quarantine`);
      }
      files.delete(`${dir}/tasks.d/${name}`);
    }
    assert.deepEqual(await loadPlanAtRefAsync("fixture-root", `${dir}/tasks.yaml`, "origin/main", git), mergePlanBlobs(await blobs()),
      "the plan after the refused shard leaves equals origin/main's");
  });

  await t.test("each bundle currency verdict is origin/main's, current and stale", async (st) => {
    const root = await builtTree(st);
    const base = (r: string) => childEntries.childEntryIsCurrent(r, ENTRY, { hashSource: childEntries.sourceHash });
    for (const pass of [1, 2]) assert.deepEqual(childEntries.childEntryIsCurrent(root, ENTRY), base(root), `current, pass ${pass}`);
    writeFileSync(join(root, "src", "lib", "added.ts"), "export const added = 1;\n");
    for (const pass of [1, 2]) assert.deepEqual(childEntries.childEntryIsCurrent(root, ENTRY), base(root), `stale, pass ${pass}`);
    assert.equal(base(root).reason, "source-changed");
    assert.equal(childEntries.childEntryIsCurrent(root, "never-built").reason, "entry-not-built");
  });
});
