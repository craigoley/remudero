// W1-T13325 — the daemon's automatic branch reap read merge credit with the synchronous reader, whose memo
// dies with the process: the first reap after each daemon start decompressed every rotation on the loop.
// These tests pin that the automatic pass awaits the scan that keeps durable digests, that a failed read
// still gives no credit answer, and that the synchronous command keeps the synchronous reader.
import assert from "node:assert/strict";
import fs, { readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import zlib from "node:zlib";
import type { Config } from "#src/lib/config.js";
import { ledgerRotationEntries } from "#src/lib/ledger-union.js";
import type { Plan } from "#src/lib/plan.js";
import { createCreditScanMemo, readLedgerLines, readMergeCreditedTaskIdsAsync } from "#src/lib/status.js";
import { writeLedger, type LedgerFixture } from "#test/helpers/ledger-fixture.js";
import {
  DECLARED_BRANCH_GUARDS, reapBranchesCommand, reapBranchesCommandAsync, runAutomaticBranchReapRung,
} from "#test/helpers/run-task-test.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const TIP_S = Math.floor((NOW - 30 * 86_400_000) / 1000);
/** A whole-second mtime, so restoring it after an overwrite reproduces a rotation's size:mtime key. */
const MTIME_S = 1_791_000_000;
const CREDITED_SLUG = "w1t1060-instrument-declare", OPEN_SLUG = "w1t1061-instrument-read";
const CREDITED_RUN = "run-W1-T2000-1700000000000", OPEN_RUN = "run-W1-T2001-1700000000000";
const NAMES = [CREDITED_SLUG, OPEN_SLUG, CREDITED_RUN, OPEN_RUN];
const plan = (): Plan => ({ tasks: ["W1-T1060", "W1-T1061", "W1-T2000", "W1-T2001"].map((id) => ({ id })), byId: new Map() }) as never;

/** What a pass reports once it has a credit answer, and what it reports with none (as at origin/main). */
const CREDIT_READ = { slug: { [CREDITED_SLUG]: "named_task_credited", [OPEN_SLUG]: "named_task_open" },
  run: { [CREDITED_RUN]: "credited_sibling_stale", [OPEN_RUN]: "orphan_unshipped_stale" }, held: [...NAMES].sort() };
const NO_ANSWER = { slug: { [CREDITED_SLUG]: "named_task_open", [OPEN_SLUG]: "named_task_open" }, run: {}, held: [...NAMES].sort() };

/** Merge credit for W1-T1060 and W1-T2000, held ONLY in two gzip archives; the live file starts empty. */
function corpus(t: TestContext): LedgerFixture {
  const credit = (taskId: string) => ({ ts: "2026-10-12T01:00:00.000Z", run_id: `RUN-${taskId}`, task_id: taskId, step: "verdict.merged", verdict: "merged" });
  const noise = Array.from({ length: 50 }, (_, n) => ({ ts: "2026-10-12T00:00:00.000Z", step: "noise", n }));
  const fixture = writeLedger([], { rotations: [
    { at: "2026-10-12T00:00:00.000Z", gz: true, rows: [...noise, credit("W1-T1060")] },
    { at: "2026-10-13T00:00:00.000Z", gz: true, rows: [...noise, credit("W1-T2000")] },
  ] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  for (const entry of ledgerRotationEntries(readdirSync(fixture.dir), fixture.dir)) utimesSync(entry.path, MTIME_S, MTIME_S);
  return fixture;
}

/** A remote with two slug branches and two stale run branches, no pull request, and no dispatch claim. */
function remote(onCall?: (cmd: string, args: string[]) => void): (cmd: string, args: string[]) => string {
  return (cmd, args) => {
    onCall?.(cmd, args);
    if (args[0] === "ls-remote") return args.includes("refs/rmd-dispatch/*") ? "" : ["a1\trefs/heads/main", ...NAMES.map((name, i) => `b${i}\trefs/heads/${name}`)].join("\n");
    if (args.includes("--merged=origin/main")) return "origin/main";
    if (args[0] === "for-each-ref") return ["origin/main\ta1\t1", ...NAMES.map((name, i) => `origin/${name}\tb${i}\t${TIP_S}`)].join("\n");
    if (cmd !== "git") return "";
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    if (args[0] === "grep" && args.includes("-o")) return DECLARED_BRANCH_GUARDS.map((name) => `src/run-task.ts:1:${name}`).join("\n");
    if (args[0] === "grep") throw new Error("exit 1: no match");
    return "";
  };
}

const commandOpts = (fixture: LedgerFixture) => ({ exec: remote(), root: fixture.dir, ownerRepo: { owner: "acme", repo: "demo" },
  quiet: true, ledgerPath: fixture.path, plan, clock: { now: () => NOW } });

/** The automatic pass with its production defaults: no credit reader is passed, as in the daemon's caller. */
async function automatic(fixture: LedgerFixture, exec = remote()): Promise<string[]> {
  const logged: string[] = [];
  await runAutomaticBranchReapRung("acme", "demo", { root: fixture.dir } as Config, fixture.path, "REAP", (step) => void logged.push(step), {},
    { root: fixture.dir, exec, prune: false, plan, clock: { now: () => NOW } });
  return logged;
}

/** The last pass's ledgered facts: each slug branch's reason, each named stale run branch's, and what is held. */
function reported(fixture: LedgerFixture) {
  const last = (step: string) => readLedgerLines(fixture.path).filter((row) => row.step === step).at(-1);
  const reasons = last("branch_reap.dry_run")?.reasons as Record<string, string>;
  const candidates = last("branch_reap.hygiene_shadow")?.candidates as Array<{ name: string; reason: string }>;
  return { slug: { [CREDITED_SLUG]: reasons[CREDITED_SLUG], [OPEN_SLUG]: reasons[OPEN_SLUG] },
    run: Object.fromEntries(candidates.map((c) => [c.name, c.reason])),
    held: [...(last("branch_reap.dry_run")?.held_branches as string[])].sort() };
}

/** Counts every SYNCHRONOUS read of a rotation and every synchronous gunzip, whoever makes it. */
async function countingSyncReads(run: () => Promise<void>): Promise<{ rotationReads: number; gunzips: number }> {
  const counts = { rotationReads: 0, gunzips: 0 };
  const readFileSync0 = fs.readFileSync;
  const gunzipSync0 = zlib.gunzipSync;
  fs.readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && /ledger\.[^/]*\.ndjson(\.gz)?$/.test(path)) counts.rotationReads += 1;
    return (readFileSync0 as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  zlib.gunzipSync = ((...args: Parameters<typeof gunzipSync0>) => (counts.gunzips += 1, gunzipSync0(...args))) as typeof gunzipSync0;
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    fs.readFileSync = readFileSync0;
    zlib.gunzipSync = gunzipSync0;
    syncBuiltinESMExports();
  }
  return counts;
}

test("W1-T13325 criterion 1: the automatic pass reads archived credit while the loop keeps turning", async (t) => {
  const fixture = corpus(t);
  let turns = 0, running = true;
  const turn = (): void => { turns += 1; if (running) setImmediate(turn); };
  setImmediate(turn);
  // The credit is read after the last branch listing and before the first GitHub read.
  let beforeCredit = -1, afterCredit = -1;
  const exec = remote((cmd, args) => {
    if (cmd === "gh" && afterCredit < 0) afterCredit = turns;
    if (args[0] === "ls-remote" && afterCredit < 0) beforeCredit = turns;
  });
  let logged: string[];
  try {
    logged = await automatic(fixture, exec);
  } finally {
    running = false;
  }
  assert.deepEqual(reported(fixture), CREDIT_READ);
  assert.deepEqual(logged, ["branch_reap.sweep.started", "branch_reap.sweep.completed"]);
  assert.ok(beforeCredit >= 0 && afterCredit > beforeCredit, `the loop turned during the credit read (${beforeCredit} -> ${afterCredit})`);
});

test("W1-T13325 criterion 2: a credit read that throws or rejects leaves slug and run branches held", async (t) => {
  const failures: Array<[string, () => never | Promise<never>]> = [
    ["throws", () => { throw new Error("EIO: the state dir went away"); }],
    ["rejects", async () => { throw new Error("EIO: the state dir went away"); }],
  ];
  for (const [name, readMergeCreditedTaskIds] of failures) {
    await t.test(name, async (sub) => {
      const fixture = corpus(sub);
      const code = await reapBranchesCommandAsync([], { ...commandOpts(fixture), readMergeCreditedTaskIds });
      assert.equal(typeof code, "number", "the pass finishes");
      assert.deepEqual(reported(fixture), NO_ANSWER);
    });
  }
  // The synchronous driver over a throwing reader, the only form origin/main had, reports the same.
  const fixture = corpus(t);
  reapBranchesCommand([], { ...commandOpts(fixture), readMergeCreditedTaskIds: failures[0]![1] });
  assert.deepEqual(reported(fixture), NO_ANSWER);
});

test("W1-T13325 criterion 3: a restarted process reads the credit from the digests the automatic pass left", async (t) => {
  const fixture = corpus(t);
  await automatic(fixture);
  assert.deepEqual(reported(fixture), CREDIT_READ);
  // The restarted process's view: every archive is now garbage of the same length, at the same mtime.
  for (const entry of ledgerRotationEntries(readdirSync(fixture.dir), fixture.dir)) {
    writeFileSync(entry.path, Buffer.alloc(statSync(entry.path).size, 0x21));
    utimesSync(entry.path, MTIME_S, MTIME_S);
  }
  const memo = createCreditScanMemo();
  const loads: number[][] = [];
  await reapBranchesCommandAsync([], { ...commandOpts(fixture), readMergeCreditedTaskIds: async (path, opts) => {
    const read = await readMergeCreditedTaskIdsAsync(path, { ...opts, memo });
    loads.push([read.rotationsLoaded, read.digestHits, read.digestMisses]);
    return read;
  } });
  assert.deepEqual(loads, [[2, 2, 0]], "a fresh memo answers both rotations from their digests");
  assert.deepEqual(reported(fixture), CREDIT_READ);
});

test("W1-T13325 criterion 4: the automatic pass reads no rotation synchronously for merge credit", async (t) => {
  const fixture = corpus(t);
  const counts = await countingSyncReads(async () => void await automatic(fixture));
  assert.deepEqual(counts, { rotationReads: 0, gunzips: 0 });
  // Control: the credit was read, so the zero is not an unasked question.
  assert.deepEqual(reported(fixture), CREDIT_READ);
});

test("W1-T13325 criterion 5: the synchronous command still reads credit with the synchronous reader", async (t) => {
  const fixture = corpus(t);
  let code: unknown;
  const counts = await countingSyncReads(async () => { code = reapBranchesCommand([], commandOpts(fixture)); });
  assert.equal(typeof code, "number", "the synchronous driver returns its exit code, not a promise");
  assert.deepEqual(reported(fixture), CREDIT_READ);
  assert.deepEqual(counts, { rotationReads: 2, gunzips: 2 }, "both archives were read on the caller's stack");
});
