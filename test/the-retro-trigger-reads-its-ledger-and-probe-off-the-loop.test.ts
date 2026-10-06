import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { GhAsyncExecutor } from "../src/lib/github-transport.js";
import { loadPolicy, policyPath, type Policy } from "../src/lib/policy.js";
import type { GitLogCommit, ShippedGithub } from "../src/lib/retro.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
// Namespace imports: this file must LOAD on a base without the awaited symbols, so each proof
// fails there on its own assertion rather than on a missing export.
import * as ledgerUnion from "../src/lib/ledger-union.js";
import * as retro from "../src/lib/retro.js";
import * as runTask from "../src/run-task.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// After #9636 the daemon's retro trigger awaited its merged-commits read, but the check still ran
// its run-ledger union read (resolveLedgerUnion: every rotation read and gunzipped with readFileSync,
// 919 files / 3.84 GB decompressed on the fleet host) and the GitHub throttle probe (two `gh api`
// calls through execFileSync) on the daemon loop. These pin the awaited replacements.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED_POLICY: Policy = loadPolicy(policyPath(REPO_ROOT));
const POLICY: Policy = { ...SHIPPED_POLICY, values: { ...SHIPPED_POLICY.values, retro: { mergesThreshold: 2, daysThreshold: 99_999 } } };
const NOW = new Date("2026-10-06T12:00:00.000Z");
const COMMITS: GitLogCommit[] = [{ date: "2026-10-05T10:00:00+00:00", message: "chore(plan): file one" }];

/** Rows for runs `from`..`to`: a start, a merged verdict, and one row no union read retains. */
function runRows(from: number, to: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = from; i < to; i++) {
    const run = `W1-T${9000 + i}-1791000000000`;
    rows.push({ ts: `2026-10-05T0${i % 10}:00:00.000Z`, run_id: run, task_id: `W1-T${9000 + i}`, step: "run.start" });
    rows.push({ ts: `2026-10-05T0${i % 10}:30:00.000Z`, run_id: run, task_id: `W1-T${9000 + i}`, step: "verdict", verdict: "merged", pr_url: `https://github.com/o/r/pull/${i}` });
    rows.push({ ts: `2026-10-05T0${i % 10}:40:00.000Z`, run_id: run, step: "noise.unretained", n: i });
  }
  return rows;
}

/** A config whose state dir holds a live ledger, a plain and a gzipped rotation (the union's archive∪live corpus). */
function corpusConfig(extraRotationRows: Array<Record<string, unknown>> = []): Config {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-ledger-offloop-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeLedger(runRows(6, 8), {
    dir: stateDir,
    rotations: [
      { at: "2026-10-01T00:00:00.000Z", rows: runRows(0, 3) },
      { at: "2026-10-03T00:00:00.000Z", rows: [...runRows(2, 6), ...extraRotationRows], gz: true },
    ],
  });
  return { claudeBin: "/bin/true", root };
}

function github(calls: string[] = []): ShippedGithub {
  return {
    findMergedByTrailer: (taskId) => (calls.push(`trailer:${taskId}`), null),
    headRefName: (prUrl) => (calls.push(`head:${prUrl}`), undefined),
    unavailable: () => (calls.push("unavailable"), undefined),
    mergedCommits: () => COMMITS,
  };
}

/** Counts event-loop turns while `pending` settles — a loop held by sync I/O turns almost none. */
async function turnsWhile<T>(pending: () => Promise<T>): Promise<{ value: T; turns: number }> {
  let turns = 0;
  let on = true;
  const tick = (): void => {
    if (!on) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  try {
    return { value: await pending(), turns };
  } finally {
    on = false;
  }
}

/** A shell script standing in for `gh`, run through the real `execFile` so a bound really kills it. */
function fakeGh(body: string): { dir: string; execAsync: GhAsyncExecutor } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-retro-probe-fake-bin-"));
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  const run = promisify(execFile) as unknown as GhAsyncExecutor;
  return { dir, execAsync: ((_file, args, opts) => run(bin, args, opts)) as GhAsyncExecutor };
}

test("the awaited retro trigger check keeps the event loop turning while it reads the ledger union", async () => {
  // ~60,000 unretained rows in the gzipped rotation: the sync union read scans them in one turn.
  const bulk = Array.from({ length: 60_000 }, (_, i) => ({ ts: "2026-10-02T00:00:00.000Z", step: "noise.bulk", i }));
  const config = corpusConfig(bulk);
  const { value, turns } = await turnsWhile(() =>
    runTask.retroTriggerCheckAsync(NOW, { config, github: github(), policy: POLICY, readMergedCommits: async () => COMMITS }),
  );
  assert.equal(value?.fire, true, `the merged runs and the runless commit cross the threshold: ${JSON.stringify(value)}`);
  assert.ok(turns >= 5, `the loop must keep turning while the union is read and scanned (turned ${turns})`);
});

test("the awaited GitHub throttle probe keeps a timer firing while gh is pending", async () => {
  const slow = fakeGh(`sleep 0.4\nif [ "$2" = "rate_limit" ]; then echo 4999; else echo octocat; fi`);
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 20);
  try {
    const verdict = await retro.probeGithubThrottleAsync(retro.throttleProbeRunAsync({ execAsync: slow.execAsync }));
    assert.equal(verdict, undefined, "both calls answered healthy");
    assert.ok(ticks >= 10, `the loop must keep servicing timers during the probe's two gh calls (ticked ${ticks})`);
  } finally {
    clearInterval(timer);
    rmSync(slow.dir, { recursive: true, force: true });
  }
});

test("a throttle probe call killed at its bound declines the retro trigger naming the timeout", async () => {
  const pidDir = mkdtempSync(join(tmpdir(), "rmd-retro-probe-pid-"));
  const pidFile = join(pidDir, "pid");
  const hung = fakeGh(`echo $$ > ${pidFile}\nexec sleep 30`);
  try {
    const run = retro.throttleProbeRunAsync({ timeoutMs: 150, execAsync: hung.execAsync });
    const reason = "gh rate_limit probe failed: gh api rate_limit timed out after 150ms and was killed";
    assert.equal(await retro.probeGithubThrottleAsync(run), reason);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the hung gh was killed, not abandoned");

    const config = corpusConfig();
    const decision = await runTask.retroTriggerCheckAsync(NOW, {
      config, github: github(), policy: POLICY, readMergedCommits: async () => COMMITS, probeUnavailable: () => retro.probeGithubThrottleAsync(run),
    });
    assert.equal(decision, undefined, "a probe that never answered is no evidence GitHub is usable");
    const declined = readFileSync(join(config.root, "state", "ledger.ndjson"), "utf8").split("\n").filter((l) => l.includes("retro_trigger"));
    assert.ok(declined.some((l) => l.includes(reason)), `the decline row names the timeout: ${declined.join("\n")}`);
  } finally {
    rmSync(hung.dir, { recursive: true, force: true });
    rmSync(pidDir, { recursive: true, force: true });
  }
});

test("the awaited and sync retro trigger reads answer the same corpus identically", async () => {
  const config = corpusConfig();
  const stateDir = join(config.root, "state");
  const pattern = '"step":"run\\.start"|"step":"verdict"';
  assert.deepEqual(await ledgerUnion.resolveLedgerUnionAsync(stateDir, pattern), ledgerUnion.resolveLedgerUnion(stateDir, pattern));
  for (const opts of [{}, { dedupe: false }, { liveFirst: true, order: "newest-first" as const }, { step: "verdict", maxRotations: 1 }, { requireArchives: true }]) {
    const sync = ledgerUnion.readLedgerUnionRawLinesSync(stateDir, opts);
    assert.ok(sync.rawLines.length > 0, `the corpus is seen: ${JSON.stringify(opts)}`);
    assert.deepEqual(await ledgerUnion.readLedgerUnionRawLinesAsync(stateDir, opts), sync, JSON.stringify(opts));
  }

  const syncCalls: string[] = [];
  const awaitedCalls: string[] = [];
  const sync = runTask.retroTriggerCheck(NOW, { config, github: github(syncCalls), policy: POLICY });
  const awaited = await runTask.retroTriggerCheckAsync(NOW, { config, github: github(awaitedCalls), policy: POLICY, readMergedCommits: async () => COMMITS });
  assert.equal(sync?.fire, true);
  assert.deepEqual(awaited, sync);
  assert.deepEqual(awaitedCalls, syncCalls, "the same GitHub calls, in the same order");

  // A torn rotation: both refuse the union and fall back to the live file alone, identically.
  writeFileSync(join(stateDir, "ledger.2026-10-04T00-00-00-000Z.ndjson.gz"), "not gzip");
  const tornSync = ledgerUnion.resolveLedgerUnion(stateDir, pattern);
  assert.equal(tornSync.ok, false);
  assert.deepEqual(await ledgerUnion.resolveLedgerUnionAsync(stateDir, pattern), tornSync);
  assert.deepEqual(
    await runTask.retroTriggerCheckAsync(NOW, { config, github: github(), policy: POLICY, readMergedCommits: async () => COMMITS }),
    runTask.retroTriggerCheck(NOW, { config, github: github(), policy: POLICY }),
  );

  // An unreadable live file (a directory where the ledger should be) is skipped by both, never an unread rotation.
  const liveless = join(corpusConfig().root, "state");
  rmSync(join(liveless, "ledger.ndjson"));
  mkdirSync(join(liveless, "ledger.ndjson"));
  const livelessSync = ledgerUnion.readLedgerUnionRawLinesSync(liveless, {});
  assert.deepEqual([livelessSync.liveFileRead, livelessSync.unread], [true, []]);
  assert.deepEqual(await ledgerUnion.readLedgerUnionRawLinesAsync(liveless, {}), livelessSync);

  // The probe judges each scripted answer the same way, awaited or not.
  const answers: Array<Record<string, ReturnType<retro.ThrottleProbeRun>>> = [
    { rate_limit: { ok: true, stdout: "4999\n", stderr: "" }, user: { ok: true, stdout: "me\n", stderr: "" } },
    { rate_limit: { ok: true, stdout: "0\n", stderr: "" }, user: { ok: true, stdout: "me\n", stderr: "" } },
    { rate_limit: { ok: false, stdout: "", stderr: "HTTP 502" }, user: { ok: true, stdout: "me\n", stderr: "" } },
    { rate_limit: { ok: true, stdout: "10\n", stderr: "" }, user: { ok: false, stdout: "", stderr: "HTTP 403: API rate limit exceeded" } },
    { rate_limit: { ok: true, stdout: "10\n", stderr: "" }, user: { ok: false, stdout: "", stderr: "HTTP 404" } },
  ];
  for (const answer of answers) {
    const pick = (args: readonly string[]) => answer[args[1] as string]!;
    assert.deepEqual(await retro.probeGithubThrottleAsync(async (args) => pick(args)), retro.probeGithubThrottle(pick));
  }
});
