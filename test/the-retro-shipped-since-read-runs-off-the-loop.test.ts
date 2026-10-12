import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { GhAsyncExecutor } from "../src/lib/github-transport.js";
import { loadPolicy, policyPath, type Policy } from "../src/lib/policy.js";
import type { GitLogCommit, RunSummary } from "../src/lib/retro.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
// Namespace imports: this file must LOAD on a base without the awaited symbols, so each proof
// fails there on its own assertion rather than on a missing export.
import * as ownerRepo from "../src/lib/owner-repo.js";
import * as retro from "../src/lib/retro.js";
import * as runTask from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// After #9708 the daemon's retro trigger awaited its ledger read and its throttle probe, but
// `shippedSince` (from `retroTriggerConclude`) still read through `buildBatchedGithub`'s index: a
// synchronous `gh api` page walk, plus the commit-trailer `git` reads, on the daemon loop. These pin
// the awaited gateway that replaces them.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED_POLICY: Policy = loadPolicy(policyPath(REPO_ROOT));
const POLICY: Policy = { ...SHIPPED_POLICY, values: { ...SHIPPED_POLICY.values, retro: { mergesThreshold: 2, daysThreshold: 99_999 } } };
const NOW = new Date("2026-10-06T12:00:00.000Z");
const COMMITS: GitLogCommit[] = [];
const OWNER_REPO = { owner: "o", repo: "r" };

function pr(n: number, head: string, body: string, merged = true): Record<string, unknown> {
  return {
    number: n,
    html_url: `https://github.com/o/r/pull/${n}`,
    state: merged ? "closed" : "open",
    merged_at: merged ? `2026-10-05T0${n}:00:00Z` : null,
    head: { ref: head, sha: `sha${n}` },
    body,
    title: `pr ${n}`,
    updated_at: `2026-10-05T0${n}:00:00Z`,
  };
}

const OPEN_ROWS = [pr(9, "run-W1-T9-1", "", false)];
const CLOSED_ROWS = [
  pr(1, "run-W1-T1-1", "Remudero-Task: W1-T1"),
  pr(2, "run-W1-T2-1", "Remudero-Task: W1-T2"),
  pr(3, "run-W1-T3-1", ""),
  pr(4, "someone-else", "Remudero-Task: W1-T4"),
];

function run(n: number, verdict: string): RunSummary {
  return {
    runId: `W1-T${n}-1`,
    taskId: `W1-T${n}`,
    type: "impl",
    startTs: "2026-10-04T00:00:00.000Z",
    verdict,
    costUsd: 0,
    numTurns: 1,
    ...(verdict === "merged" ? { prUrl: `https://github.com/o/r/pull/${n}`, mergeTs: "2026-10-05T01:00:00Z" } : {}),
  };
}

const RUNS = [run(1, "merged"), run(2, "failed"), run(3, "failed"), run(4, "failed"), run(5, "failed")];

/** A shell script standing in for `gh`: it appends its argv to `log`, then serves the open or closed page. */
function fakeGh(opts: { sleep?: number; closedFails?: boolean; hang?: string } = {}): { dir: string; bin: string; log: string; execAsync: GhAsyncExecutor } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-retro-shipped-fake-bin-"));
  const bin = join(dir, "gh");
  const log = join(dir, "argv.log");
  writeFileSync(join(dir, "open.json"), JSON.stringify(OPEN_ROWS));
  writeFileSync(join(dir, "closed.json"), JSON.stringify(CLOSED_ROWS));
  const closed = opts.closedFails ? `echo "HTTP 502: Bad Gateway" >&2; exit 1` : `cat ${dir}/closed.json`;
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$*" >> ${log}\n${opts.hang ?? ""}\n${opts.sleep ? `sleep ${opts.sleep}` : ""}\n` +
      `case "$2" in *state=open*) cat ${dir}/open.json ;; *) ${closed} ;; esac\n`,
  );
  chmodSync(bin, 0o755);
  const exec = promisify(execFile) as unknown as GhAsyncExecutor;
  return { dir, bin, log, execAsync: ((_file, args, o) => exec(bin, args, o)) as GhAsyncExecutor };
}

/** A real checkout whose origin is o/r and whose origin/main carries PR #3's commit trailer. */
function seededTrailers(withOrigin = true): string {
  const repo = gitRepo({ kind: "retro-shipped" });
  if (withOrigin) repo.addRemote("origin", "https://github.com/o/r.git");
  repo.git("commit", "--allow-empty", "-m", "feat: three (#3)", "-m", "Remudero-Task: W1-T3");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo.dir;
}

function logged(log: string): string[] {
  try {
    return readFileSync(log, "utf8").trim().split("\n");
  } catch {
    return []; // no call was made at all
  }
}

test("the awaited shipped-since read keeps a timer firing while its gh page walk is pending", async () => {
  const slow = fakeGh({ sleep: 0.4 });
  let ticks = 0;
  let last = performance.now();
  let longestGapMs = 0;
  const timer = setInterval(() => {
    ticks += 1;
    longestGapMs = Math.max(longestGapMs, performance.now() - last);
    last = performance.now();
  }, 20);
  try {
    const github = await runTask.retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, execAsync: slow.execAsync });
    const { shipped } = await retro.shippedSinceAsync([run(2, "failed")], undefined, github);
    assert.deepEqual(shipped.map((s) => s.taskId), ["W1-T2"], "the walk was read: PR #2's trailer credits W1-T2");
    assert.equal(logged(slow.log).length, 2, "one open page and one closed page");
    assert.ok(ticks >= 10, `the loop must keep servicing timers during the two gh pages (ticked ${ticks})`);
    // Each page's gh sleeps 400 ms: a page read on the loop holds the timer at least that long.
    assertWallClockBound(longestGapMs, 250, `no gh page may hold the loop (longest timer gap ${Math.round(longestGapMs)}ms)`);
  } finally {
    clearInterval(timer);
    rmSync(slow.dir, { recursive: true, force: true });
  }
});

test("a shipped-since page walk past its bound is killed and the retro decline names the timeout", async () => {
  const pidDir = mkdtempSync(join(tmpdir(), "rmd-retro-shipped-pid-"));
  const pidFile = join(pidDir, "pid");
  const hung = fakeGh({ hang: `echo $$ > ${pidFile}\nexec sleep 30` });
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-shipped-timeout-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeLedger(
    [1, 2].flatMap((n) => [
      { ts: "2026-10-04T00:00:00.000Z", run_id: `W1-T${n}-1`, task_id: `W1-T${n}`, step: "run.start" },
      { ts: "2026-10-05T00:00:00.000Z", run_id: `W1-T${n}-1`, task_id: `W1-T${n}`, step: "verdict", verdict: "merged", pr_url: `https://github.com/o/r/pull/${n}` },
    ]),
    { dir: stateDir },
  );
  const config: Config = { claudeBin: "/bin/true", root };
  try {
    const github = await runTask.retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, execAsync: hung.execAsync, pageTimeoutMs: 150 });
    const decision = await runTask.retroTriggerCheckAsync(NOW, {
      config, github, policy: POLICY, readMergedCommits: async () => COMMITS, probeUnavailable: async () => undefined,
    });
    assert.equal(decision, undefined, "a walk that never answered is no evidence of what shipped");
    const reason = "retro shipped-since read: gh api repos/o/r/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1 timed out after 150ms and was killed";
    const declined = readFileSync(join(stateDir, "ledger.ndjson"), "utf8").split("\n").filter((l) => l.includes("retro_trigger.declined"));
    assert.ok(declined.some((l) => l.includes(reason)), `the decline row names the timeout: ${declined.join("\n")}`);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the hung gh was killed, not abandoned");

    // The commit-trailer git read is bounded the same way: past its bound it rejects naming it, never an empty index.
    const fast = fakeGh();
    try {
      const gateway = await runTask.retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, execAsync: fast.execAsync, commitCwd: seededTrailers(), commitTimeoutMs: 0 });
      await assert.rejects(retro.shippedSinceAsync([run(3, "failed")], undefined, gateway), (e: unknown) => {
        assert.ok(e instanceof retro.ShippedReadTimeoutError, String(e));
        assert.match((e as Error).message, /^retro shipped-since read: git config --get remote\.origin\.url exceeded its 0ms bound and was killed/);
        return true;
      });
    } finally {
      rmSync(fast.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(hung.dir, { recursive: true, force: true });
    rmSync(pidDir, { recursive: true, force: true });
  }
});

test("the awaited and sync shipped-since gateways answer identically over a recorded gh and a real git checkout", async () => {
  const scenarios = [
    { name: "healthy", gh: {}, origin: true, minShipped: 3 },
    { name: "closed pages fail", gh: { closedFails: true }, origin: true, minShipped: 0 },
    { name: "no origin remote", gh: {}, origin: false, minShipped: 2 },
  ];
  for (const scenario of scenarios) {
    const cwd = seededTrailers(scenario.origin);
    const syncGh = fakeGh(scenario.gh);
    const awaitedGh = fakeGh(scenario.gh);
    try {
      const exec = (args: string[]): string => execFileSync(syncGh.bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const sync = retro.shippedSince(RUNS, undefined, runTask.retroShippedGithubGateway({ ownerRepo: OWNER_REPO, exec, commitCwd: cwd }));
      const github = await runTask.retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, execAsync: awaitedGh.execAsync, commitCwd: cwd });
      const awaited = await retro.shippedSinceAsync(RUNS, undefined, github);
      assert.equal(sync.shipped.length, scenario.minShipped, `${scenario.name}: ${JSON.stringify(sync)}`);
      assert.ok(sync.discrepancies.length > 0, `${scenario.name}: the corpus is judged, not skipped`);
      assert.deepEqual(awaited, sync, scenario.name);
      assert.ok(logged(syncGh.log).length >= 2, `${scenario.name}: gh was read`);
      assert.deepEqual(logged(awaitedGh.log), logged(syncGh.log), `${scenario.name}: the same gh calls, in the same order`);
    } finally {
      rmSync(syncGh.dir, { recursive: true, force: true });
      rmSync(awaitedGh.dir, { recursive: true, force: true });
    }
  }

  // Through the trigger: the production-shaped awaited gateway and the sync one decide the same corpus alike.
  const cwd = seededTrailers();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-shipped-same-`));
  mkdirSync(join(root, "state"), { recursive: true });
  writeLedger(
    [1, 2, 3].flatMap((n) => [
      { ts: "2026-10-04T00:00:00.000Z", run_id: `W1-T${n}-1`, task_id: `W1-T${n}`, step: "run.start" },
      { ts: "2026-10-05T00:00:00.000Z", run_id: `W1-T${n}-1`, task_id: `W1-T${n}`, step: "verdict", verdict: n === 1 ? "merged" : "failed", ...(n === 1 ? { pr_url: "https://github.com/o/r/pull/1" } : {}) },
    ]),
    { dir: join(root, "state") },
  );
  const config: Config = { claudeBin: "/bin/true", root };
  const syncGh = fakeGh();
  const awaitedGh = fakeGh();
  try {
    const exec = (args: string[]): string => execFileSync(syncGh.bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const healthy = { unavailable: () => undefined, mergedCommits: () => COMMITS };
    const sync = runTask.retroTriggerCheck(NOW, { config, policy: POLICY, github: { ...runTask.retroShippedGithubGateway({ ownerRepo: OWNER_REPO, exec, commitCwd: cwd }), ...healthy } });
    const github = await runTask.retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, execAsync: awaitedGh.execAsync, commitCwd: cwd });
    const awaited = await runTask.retroTriggerCheckAsync(NOW, { config, policy: POLICY, github: { ...github, ...healthy }, readMergedCommits: async () => COMMITS });
    assert.equal(sync?.fire, true, `three credited merges cross the threshold: ${JSON.stringify(sync)}`);
    assert.deepEqual(awaited, sync);
  } finally {
    rmSync(syncGh.dir, { recursive: true, force: true });
    rmSync(awaitedGh.dir, { recursive: true, force: true });
  }
});

test("the awaited owner/repo read answers as the sync one, its typed failures included", async () => {
  const withOrigin = seededTrailers(true);
  assert.deepEqual(await ownerRepo.resolveOwnerRepoAtAsync(withOrigin), ownerRepo.resolveOwnerRepoAt(withOrigin));
  assert.deepEqual(await ownerRepo.resolveOwnerRepoAtAsync(withOrigin), OWNER_REPO);
  const failures = [seededTrailers(false), mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-shipped-nogit-`))];
  const odd = gitRepo({ kind: "retro-shipped-odd" });
  odd.addRemote("origin", "not-a-slug");
  failures.push(odd.dir);
  for (const root of failures) {
    let syncError: unknown;
    try {
      ownerRepo.resolveOwnerRepoAt(root);
    } catch (e) {
      syncError = e;
    }
    assert.ok(syncError instanceof ownerRepo.OwnerRepoUnresolvableError, `the sync read fails at ${root}`);
    await assert.rejects(ownerRepo.resolveOwnerRepoAtAsync(root), (e: unknown) => {
      assert.ok(e instanceof ownerRepo.OwnerRepoUnresolvableError, String(e));
      assert.equal((e as Error).message, (syncError as Error).message);
      return true;
    });
  }
});
