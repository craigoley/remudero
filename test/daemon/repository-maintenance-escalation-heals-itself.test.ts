/**
 * W1-T10750: repository maintenance halted forever after three failures and nothing reclaimed what
 * stopped it. Every case here drives `runRepositoryMaintenance` through its injected clock, survey,
 * run, process-list, boot-evidence, prune-input and operator seams over a REAL temporary git dir, so
 * the leftovers it reclaims are real files.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import { maintenanceOperatorChannel, type AsyncIssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import * as maintenance from "#src/lib/object-reaper.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const policy = { intervalMs: 86400000, probeIntervalMs: 60000, timeoutMs: 300000,
  backoffMs: 60000, maxBackoffMs: 3600000, maxFailures: 3, maxActiveLanes: 1 };
const HOST = "this-host";
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const LONG_AGO = new Date(NOW - 30 * 86400000);
const quiet = () => ({ activeLanes: 0, disk: "healthy" as const });
const survey = (gcLog: string | null, looseCount = 6000, activeLanes = 0): maintenance.MaintenanceSurvey =>
  ({ readable: true, looseCount, looseBytes: looseCount * 2, gcLog, activeLanes, disk: "healthy" });
const okRun = (calls: string[][]) => async (_repo: string, args: readonly string[]): Promise<maintenance.MaintenanceChild> => {
  calls.push([...args]);
  return { ok: true, stdout: "" };
};
/** A survey that reads the marker until a maintenance child has run, as git's own gc clears it. */
const markerUntilRun = (calls: string[][], marker: string | null) => async (): Promise<maintenance.MaintenanceSurvey> =>
  survey(calls.length === 0 ? marker : null);

function plant(path: string, content = "leftover\n", mtime: Date = LONG_AGO): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtime, mtime);
}

function writeState(path: string, state: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ nextEligibleAt: 0, nextSurveyAt: 0, failures: 0, escalated: false, ...state }) + "\n");
}

test("W1-T10750: an escalated store with a gone-owner lock is reclaimed, maintained and cleared", async () => {
  const store = gitRepo({ kind: "maintenance-escalated" });
  const gitDir = join(store.dir, ".git");
  const statePath = join(store.dir, "maintenance.json");
  writeState(statePath, { failures: 3, escalated: true, lastOutcome: "fail", lastReason: "lock file exists, skipping maintenance" });
  plant(join(gitDir, "objects", "maintenance.lock"));
  plant(join(gitDir, "gc.pid"), "4242 e84626218311\n");
  const calls: string[][] = [];
  const rows: Array<Record<string, unknown>> = [];
  await maintenance.runRepositoryMaintenance(store.dir, statePath, policy, (_s, f) => rows.push(f), {
    clock: fixedClock(NOW), random: () => 0, context: quiet, hostname: () => HOST, listProcesses: () => [],
    bootMs: () => NOW - 86400000, survey: markerUntilRun(calls, "There are too many unreachable loose objects"), run: okRun(calls),
  });
  assert.equal(existsSync(join(gitDir, "objects", "maintenance.lock")), false, "the gone owner's lock is reclaimed");
  assert.equal(existsSync(join(gitDir, "gc.pid")), false);
  assert.deepEqual(calls, [maintenance.maintenanceArgs("gc")], "an escalated store is surveyed and maintained again");
  assert.ok(calls[0].includes("maintenance") && calls[0].includes("--task=gc"));
  const saved = JSON.parse(readFileSync(statePath, "utf8")) as maintenance.MaintenanceState;
  assert.equal(saved.escalated, false);
  assert.equal(saved.failures, 0);
  assert.equal(saved.lastOutcome, "complete");
  assert.deepEqual(rows.at(-1)?.leftovers_reclaimed, ["objects/maintenance.lock", "gc.pid"]);
});

test("W1-T10750: tmp packs and ref locks are reclaimed only when their owner is provably gone", async () => {
  const store = gitRepo({ kind: "maintenance-leftovers" });
  const gitDir = join(store.dir, ".git");
  const leftovers = ["objects/pack/tmp_pack_X", "objects/pack/tmp_idx_Y", "refs/remotes/origin/run-x.lock", "logs/refs/remotes/origin/run-x.lock"];
  const stage = () => { for (const rel of leftovers) plant(join(gitDir, rel)); };
  const survivors = () => leftovers.filter((rel) => existsSync(join(gitDir, rel)));
  const attempt = async (name: string, deps: Partial<Parameters<typeof maintenance.runRepositoryMaintenance>[4]>) => {
    stage();
    const calls: string[][] = [];
    const rows: Array<Record<string, unknown>> = [];
    const statePath = join(store.dir, `${name}.json`);
    await maintenance.runRepositoryMaintenance(store.dir, statePath, policy, (_s, f) => rows.push(f), {
      clock: fixedClock(NOW), random: () => 0, context: quiet, hostname: () => HOST, listProcesses: () => [],
      bootMs: () => NOW - 3600000, survey: async () => survey(null), run: okRun(calls), ...deps,
    });
    return { calls, rows, state: maintenance.readMaintenanceState(statePath) };
  };

  const gone = await attempt("gone", {});
  assert.deepEqual(survivors(), [], "a gone owner's leftovers are all reclaimed");
  assert.deepEqual([...(gone.rows.at(-1)?.leftovers_reclaimed as string[])].sort(), [...leftovers].sort());

  const liveProcess = await attempt("live-process", { listProcesses: () => [{ pid: 9, args: "git -C /elsewhere fetch origin" }] });
  assert.deepEqual(survivors(), leftovers, "a live git process keeps every leftover");
  assert.match(String((liveProcess.rows.at(-1)?.leftovers_kept as string[])[0]), /live git process 9/);
  assert.equal(liveProcess.calls.length, 1, "an unproven owner of a pack or ref lock does not stop maintenance");

  const blind = await attempt("blind", { listProcesses: () => { throw new Error("ps gone"); } });
  assert.deepEqual(survivors(), leftovers, "an unreadable process list keeps every leftover");
  assert.match(String((blind.rows.at(-1)?.leftovers_kept as string[])[0]), /process list unavailable.*ps gone/);

  const noBoot = await attempt("no-boot", { bootMs: () => { throw new Error("boot receipt unreadable"); } });
  assert.deepEqual(survivors(), leftovers, "unreadable boot evidence keeps every leftover");
  assert.match(String((noBoot.rows.at(-1)?.leftovers_kept as string[])[0]), /boot evidence unreadable.*boot receipt unreadable/);

  const newer = await attempt("newer", { bootMs: () => NOW - 90 * 86400000 });
  assert.deepEqual(survivors(), leftovers, "a leftover younger than the earliest boot could belong to a live instance");
  assert.match(String((newer.rows.at(-1)?.leftovers_kept as string[])[0]), /does not predate boot/);

  // A lock a PROVEN live owner holds is a deferral: no child, no failure count.
  plant(join(gitDir, "objects", "maintenance.lock"));
  plant(join(gitDir, "gc.pid"), `4242 ${HOST}\n`);
  const held = await attempt("held", { listProcesses: () => [{ pid: 4242, args: "git gc --auto" }] });
  assert.equal(held.calls.length, 0, "a live owner's lock runs nothing");
  assert.equal(held.state.failures, 0, "a contended lock is not a failure");
  assert.equal(held.state.lastOutcome, "defer");
  assert.match(held.state.lastReason ?? "", /held by a live owner: gc\.pid names live process 4242/);
  assert.equal(existsSync(join(gitDir, "objects", "maintenance.lock")), true);
});

test("W1-T10750: the gc prune window is derived from the fleet live state", async () => {
  const store = gitRepo({ kind: "maintenance-prune-window" });
  const t = (hour: number) => Date.UTC(2026, 9, 26, hour, 7, 5);
  const attempt = async (name: string, pruneInputs: maintenance.PruneInputsFn) => {
    const calls: string[][] = [];
    const rows: Array<Record<string, unknown>> = [];
    await maintenance.runRepositoryMaintenance(store.dir, join(store.dir, `${name}.json`), policy, (_s, f) => rows.push(f), {
      clock: fixedClock(NOW), random: () => 0, context: quiet, hostname: () => HOST, listProcesses: () => [],
      bootMs: () => NOW, survey: markerUntilRun(calls, "marker"), run: okRun(calls), pruneInputs,
    });
    return { calls, row: rows.at(-1)! };
  };

  const derived = await attempt("derived", async () => [{ source: "worktree:lane-a", at: t(15) },
    { source: "inflight:W1-T9.lock", at: t(9) }, { source: "borrower:rmd-review-1", at: t(11) }]);
  assert.deepEqual(derived.calls, [["-c", "gc.pruneExpire=2026-10-26T09:07:05Z", "maintenance", "run", "--task=gc"]],
    "the expiry is the OLDEST live input, still through git maintenance");
  assert.equal(derived.row.prune_expire, "2026-10-26T09:07:05Z");
  assert.deepEqual(derived.row.prune_inputs, ["worktree:lane-a@2026-10-26T15:07:05.000Z",
    "inflight:W1-T9.lock@2026-10-26T09:07:05.000Z", "borrower:rmd-review-1@2026-10-26T11:07:05.000Z"]);

  const unreadable = await attempt("unreadable", async () => { throw new Error("worktree lane-b has no gitdir file"); });
  assert.deepEqual(unreadable.calls, [maintenance.maintenanceArgs("gc")], "an unreadable input leaves git's own default");
  assert.equal(unreadable.row.prune_expire, "git-default");
  assert.match(String((unreadable.row.prune_inputs as string[])[0]), /unreadable: worktree lane-b/);

  const empty = await attempt("empty", async () => []);
  assert.deepEqual(empty.calls, [maintenance.maintenanceArgs("gc")], "no live consumer names no window, so git's default stands");

  // The default inputs read the real store: a registered worktree, an inflight lock and a --shared borrower.
  const inflight = join(store.dir, "inflight");
  plant(join(inflight, "W1-T1.lock"), "{}", new Date(t(8)));
  const lane = join(store.dir, "lane");
  store.git("worktree", "add", "--detach", lane);
  utimesSync(join(store.dir, ".git", "worktrees", "lane", "gitdir"), new Date(t(10)), new Date(t(10)));
  const scratch = join(store.dir, "scratch");
  plant(join(scratch, "rmd-borrower", ".git", "objects", "info", "alternates"), `${join(store.dir, ".git", "objects")}\n`, new Date(t(7)));
  plant(join(scratch, "rmd-other", ".git", "objects", "info", "alternates"), "/some/other/store/objects\n", new Date(t(1)));
  const read = await maintenance.fleetPruneInputs(inflight, scratch)(store.dir);
  assert.deepEqual(read.map((i) => i.source).sort(), ["borrower:rmd-borrower", "inflight:W1-T1.lock", "worktree:lane"]);
  assert.equal(Math.min(...read.map((i) => i.at)), t(7));
  await assert.rejects(maintenance.fleetPruneInputs(inflight, scratch)(join(store.dir, "missing")), /unreadable/);

  // Real git accepts the argv, and the expiry is the one that decides what a gc may delete.
  const blob = (text: string) => execFileSync("git", ["-C", store.dir, "hash-object", "-w", "--stdin"],
    { input: text, encoding: "utf8" }).trim();
  const looseFile = (oid: string) => join(store.dir, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  // Newer git packs a young unreachable object into a cruft pack, so "kept" means the database still has it, not that a loose file does.
  const inDatabase = (oid: string) => spawnSync("git", ["-C", store.dir, "cat-file", "-e", oid]).status === 0;
  const old = blob("older than every live consumer\n");
  const young = blob("newer than the oldest live consumer\n");
  utimesSync(looseFile(old), new Date(t(1)), new Date(t(1)));
  utimesSync(looseFile(young), new Date(t(20)), new Date(t(20)));
  const real = await maintenance.runMaintenanceGit(store.dir, maintenance.maintenanceArgs("gc", maintenance.pruneExpireFor(t(9))), 120000);
  assert.equal(real.ok, true, real.ok ? "" : real.error);
  assert.equal(inDatabase(old), false, "an object older than the oldest consumer is pruned");
  assert.equal(inDatabase(young), true, "an object newer than the oldest consumer is kept");
});

test("W1-T10750: a gc-log store under constant load is not starved", async () => {
  const store = gitRepo({ kind: "maintenance-starved" });
  const statePath = join(store.dir, "maintenance.json");
  let now = NOW;
  const calls: Array<{ at: number; args: string[] }> = [];
  let marker: string | null = "There are too many unreachable loose objects";
  const busy = () => ({ activeLanes: 1, disk: "healthy" as const, queueBusy: true });
  const tick = () => maintenance.runRepositoryMaintenance(store.dir, statePath, policy, () => {}, {
    clock: clockFromMillisFn(() => now), random: () => 0, context: busy, hostname: () => HOST, listProcesses: () => [],
    bootMs: () => NOW, survey: async () => survey(marker, 6000, 1),
    run: async (_repo, args) => { calls.push({ at: now, args: [...args] }); if (args.includes("--task=gc")) marker = null; return { ok: true, stdout: "" }; },
  });
  // Every survey sees one live lane and a busy queue: the store is never quiet.
  for (; now - NOW <= 2 * policy.intervalMs && !calls.some((c) => c.args.includes("--task=gc")); now += policy.probeIntervalMs) await tick();
  assert.deepEqual(calls[0].args, maintenance.maintenanceArgs("incremental"), "the incremental pass runs first, under its normal load limit");
  const gc = calls.find((c) => c.args.includes("--task=gc"));
  assert.ok(gc, "the full gc is admitted without a quiet moment");
  assert.ok(gc.at - calls[0].at <= policy.intervalMs, `the full gc waited ${gc.at - calls[0].at}ms, past the derived bound ${policy.intervalMs}ms`);
  assert.ok(calls.length <= 2, "nothing runs between the incremental pass and the full gc");
  const state = maintenance.readMaintenanceState(statePath);
  assert.equal(state.failures, 0);
  assert.equal(state.escalated, false);
  assert.equal(state.gcLogSince, undefined, "a verified gc ends the starvation clock");
  const loaded = maintenance.decideRepositoryMaintenance(survey("m", 6000, policy.maxActiveLanes + 1),
    { nextEligibleAt: 0, nextSurveyAt: 0, failures: 0, escalated: false, gcLogSince: 0 }, policy, 10 * policy.intervalMs);
  assert.equal(loaded.verdict, "deferred", "a store above the load limit still waits");
});

test("W1-T10750: an escalation opens one operator issue and recovery closes it", async () => {
  const store = gitRepo({ kind: "maintenance-operator" });
  const gitDir = join(store.dir, ".git");
  const statePath = join(store.dir, "maintenance.json");
  const open: OpenIssue[] = [];
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const gateway: AsyncIssueGateway = {
    create: (title, body, labels) => {
      created.push({ title, body, labels });
      const url = `https://github.com/craigoley/remudero/issues/${100 + created.length}`;
      open.push({ number: 100 + created.length, url, title, body });
      return url;
    },
    listOpen: () => [...open],
    closeWithComment: (url, comment) => {
      closed.push({ url, comment });
      open.splice(open.findIndex((i) => i.url === url), 1);
    },
  };
  const operator = maintenanceOperatorChannel(gateway);
  let now = NOW;
  const calls: string[][] = [];
  let failing = true;
  let afterLoose = 6000;
  let probes = 0;
  const tick = async () => {
    probes = 0;
    await maintenance.runRepositoryMaintenance(store.dir, statePath, policy, () => {}, {
      clock: clockFromMillisFn(() => now), random: () => 0, context: quiet, hostname: () => HOST, operator,
      listProcesses: () => [{ pid: 9, args: "git -C /elsewhere fetch origin" }], bootMs: () => NOW,
      survey: async () => (probes++ === 0 ? survey("marker") : survey(failing ? "marker" : null, afterLoose)),
      run: async (_repo, args) => {
        calls.push([...args]);
        return failing ? { ok: false, timedOut: false, error: "lock held" } : { ok: true, stdout: "" };
      },
    });
    return maintenance.readMaintenanceState(statePath);
  };
  plant(join(gitDir, "objects", "pack", "tmp_pack_K"), "crashed repack\n", new Date(NOW));
  writeState(statePath, { failures: 2, lastOutcome: "fail" });

  const escalated = await tick();
  assert.equal(escalated.escalated, true);
  assert.equal(created.length, 1, "the escalation opens exactly one issue");
  assert.deepEqual(created[0].labels, ["needs-human"]);
  assert.ok(created[0].body.includes(`**Repository maintenance:** ${store.dir}`), "keyed by repo path");
  assert.match(created[0].body, /objects\/pack\/tmp_pack_K` kept: live git process 9/, "names the kept leftover and its reason");
  assert.match(created[0].body, /\*\*Last failure:\*\* lock held/);
  assert.match(created[0].body, /\*\*Next re-survey:\*\* 2026-/);
  assert.equal(escalated.operatorIssue, "https://github.com/craigoley/remudero/issues/101");
  assert.ok(escalated.nextSurveyAt > escalated.nextEligibleAt, "an escalated store waits one further backoff step before its re-survey");

  // A second escalation (the issue pointer lost) finds the open issue by repo path and opens nothing.
  now = escalated.nextSurveyAt + 1;
  writeState(statePath, { ...escalated, operatorIssue: undefined, nextEligibleAt: 0, nextSurveyAt: 0 });
  const again = await tick();
  assert.equal(again.escalated, true);
  assert.equal(again.failures, 4, "the re-survey ran and failed again");
  assert.equal(created.length, 1, "a re-escalation never duplicates the issue");
  assert.equal(again.operatorIssue, escalated.operatorIssue);

  // The first verified success closes it with before/after loose counts.
  failing = false;
  afterLoose = 120;
  now = Math.max(again.nextEligibleAt, again.nextSurveyAt) + 1;
  const healed = await tick();
  assert.equal(healed.escalated, false);
  assert.equal(healed.failures, 0);
  assert.equal(healed.operatorIssue, undefined);
  assert.equal(closed.length, 1, "recovery closes the issue once");
  assert.equal(closed[0].url, escalated.operatorIssue);
  assert.match(closed[0].comment, /Loose objects 6000 -> 120/);
  assert.deepEqual(open, [], "no issue stays open after recovery");
  assert.equal(calls.length, 3);
});
