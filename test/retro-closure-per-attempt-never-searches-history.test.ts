/**
 * W1-T5649 — THE RETRO'S PER-ATTEMPT CLOSURE, RE-LANDED WITHOUT SEARCHING HISTORY ON THE DAEMON LOOP.
 *
 * #9091 (W1-T5113) dropped `shippedSince`'s marker pre-filter so it could read each run's merge
 * time, and the daemon's retro trigger then ran one synchronous trailer search per run in history:
 * a 44m52s loop stall on 2026-10-04, reverted by #9131. This suite pins both halves of the re-land:
 * the closure math (merges over dispatched attempts, credited by merge time) and the bound (gateway
 * calls scale with post-marker candidates, never with history, and the daemon awaits them).
 *
 * The loop test counts interval ticks while a PATH-shimmed `gh` holds a search open: a synchronous
 * read holds the loop until the child exits, so no tick can observe it in flight.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { closureByClass, mergeRateCell, renderClosureByClass } from "../src/lib/retro-closure.js";
import {
  buildGather,
  gatherRuns,
  parseLedger,
  saveMarker,
  shippedSince,
  trailerMergesSince,
  type GitLogCommit,
  type LedgerRecord,
  type RetroTriggerDecision,
  type ShippedGithub,
} from "../src/lib/retro.js";
import { loadPolicy, policyPath } from "../src/lib/policy.js";
import { makeTempDir } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import {
  buildRetroDaemonHooks,
  retroCheckOffLoop,
  retroShippedGithubGatewayAsync,
  retroTriggerCheckAsync,
} from "../src/run-task.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

const before = "2026-10-01T00:00:00.000Z";
const marker = "2026-10-01T02:00:00.000Z";
const after = "2026-10-01T03:00:00.000Z";
const pr = (n: number): string => `https://github.com/o/r/pull/${n}`;
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function ledger(rows: LedgerRecord[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

function run(runId: string, taskId: string, startTs: string, verdict: string, verdictTs: string, prUrl?: string): LedgerRecord[] {
  return [
    { ts: startTs, run_id: runId, task_id: taskId, step: "run.start", type: "implement", task_class: "src" },
    { ts: verdictTs, run_id: runId, step: "verdict", verdict, cost_usd: 1, ...(prUrl ? { pr_url: prUrl } : {}) },
  ];
}

/** 400 runs started before the marker and 2 after it, with a local git log dated around it. */
function historyFixture(): { rows: LedgerRecord[]; commits: GitLogCommit[] } {
  const rows: LedgerRecord[] = [];
  const commits: GitLogCommit[] = [];
  for (let i = 0; i < 397; i++) {
    rows.push(...run(`old-${i}`, `W1-T9${i}`, before, "blocked_ci", before));
    if (i % 10 === 0) commits.push({ date: "2026-09-30T00:00:00+00:00", message: `fix: old (#${i})\n\nRemudero-Task: W1-T9${i}` });
  }
  // merged BEFORE the marker, on the ledger: no lookup may be spent on it
  rows.push(...run("old-ledger-merged", "W1-TLM", before, "merged", before, pr(1)));
  // started before the marker, merged gate-side AFTER it: its trailer commit is the only local sign
  rows.push(...run("old-gate-merged", "W1-TGM", before, "blocked_review", before));
  commits.push({ date: "2026-10-01T03:30:00+00:00", message: "fix: gate (#2)\n\nRemudero-Task: W1-TGM" });
  // started before the marker, credited by the ledger's own verdict.merged row after it
  rows.push(...run("old-credited", "W1-TLC", before, "blocked_review", before, pr(3)));
  rows.push({ ts: after, run_id: "sweep", task_id: "W1-TLC", step: "verdict.merged", pr_url: pr(3) });
  // the two post-marker runs
  rows.push(...run("new-merged", "W1-TNM", after, "merged", after, pr(4)));
  rows.push(...run("new-open", "W1-TNO", after, "blocked_ci", after));
  commits.push({ date: "2026-10-01T04:00:00+00:00", message: "chore(plan): a runless filing" });
  return { rows, commits };
}

function countingGateway(commits: GitLogCommit[]) {
  const searches: string[] = [];
  const heads: string[] = [];
  let logReads = 0;
  const github: ShippedGithub = {
    findMergedByTrailer: (taskId) => {
      searches.push(taskId);
      return taskId === "W1-TGM" ? { number: 2, url: pr(2) } : null;
    },
    headRefName: (prUrl) => {
      heads.push(prUrl);
      return ({ [pr(2)]: "run-old-gate-merged", [pr(3)]: "run-old-credited", [pr(4)]: "run-new-merged" } as Record<string, string>)[prUrl];
    },
    mergedCommits: () => { logReads += 1; return commits; },
  };
  return { github, searches, heads, logReads: () => logReads };
}

test("400 pre-marker runs and 2 post-marker runs cost at most 2 trailer searches, and the window is closed by merge time", () => {
  const { rows, commits } = historyFixture();
  const runs = gatherRuns(parseLedger(ledger(rows)));
  assert.equal(runs.filter((r) => r.startTs < marker).length, 400);
  assert.equal(runs.filter((r) => r.startTs > marker).length, 2);
  const gw = countingGateway(commits);

  const result = shippedSince(runs, marker, gw.github);

  assert.ok(gw.searches.length <= 2, `trailer searches: ${gw.searches.length}`);
  assert.deepEqual(gw.searches.sort(), ["W1-TGM", "W1-TNO"]);
  assert.ok(!gw.heads.includes(pr(1)), "no head lookup for a merge that landed before the marker");
  assert.equal(gw.logReads(), 1, "one local git log, never a per-run read");
  assert.deepEqual(result.shipped.map((s) => [s.taskId, s.source, s.mergeTs]), [
    ["W1-TGM", "github", "2026-10-01T03:30:00+00:00"],
    ["W1-TLC", "ledger", after],
    ["W1-TNM", "ledger", after],
  ]);

  const gathered = buildGather({ ledgerNdjson: ledger(rows), learningsMd: "", sinceTs: marker, github: countingGateway(commits).github,
    openTaskClasses: Array(650).fill("src") });
  const [row] = gathered.closureByClass;
  assert.equal(row.taskClass, "src");
  assert.equal(row.merged, 3, "a pre-marker run merged after the marker is credited to this window");
  assert.equal(row.open, 650);
  assert.deepEqual(row.mergeRate, { kind: "refused", merged: 3, denominator: 2, floor: 5 },
    "the denominator is the window's 2 dispatched attempts, not merged + open");
  assert.equal(mergeRateCell(row.mergeRate), "REFUSED (population 2 below floor 5, P48; 3 of 2 attempts)");
  assert.equal(row.lastMergeTs, "2026-10-01T03:30:00+00:00");
});

test("trailerMergesSince keeps each task's newest trailer commit strictly after the marker", () => {
  const map = trailerMergesSince([
    { date: "2026-10-01T02:00:00+00:00", message: "x\n\nRemudero-Task: A" },
    { date: "2026-10-01T05:00:00+00:00", message: "x\n\nRemudero-Task: B" },
    { date: "2026-10-01T04:00:00+00:00", message: "x\n\nRemudero-Task: B" },
    { date: "2026-10-01T06:00:00+00:00", message: "no trailer" },
  ], marker);
  assert.deepEqual([...map], [["B", "2026-10-01T05:00:00+00:00"]]);
});

test("the GitHub arm reads mergedAt when the gateway has it, and a failed log read is named rather than read as empty", () => {
  const runs = gatherRuns(parseLedger(ledger([
    ...run("old", "W1-T-old", before, "blocked_review", before),
    ...run("new", "W1-T-new", after, "blocked_review", after),
  ])));
  const at = (mergedAt: string): ShippedGithub => ({
    findMergedByTrailer: (taskId) => ({ number: 7, url: pr(7), mergedAt: taskId === "W1-T-new" ? mergedAt : after }),
    headRefName: () => "run-new",
    mergedCommits: () => { throw new Error("git log exploded"); },
  });
  const failed = shippedSince(runs, marker, at(after));
  assert.deepEqual(failed.shipped.map((s) => [s.taskId, s.mergeTs]), [["W1-T-new", after]]);
  assert.ok(failed.discrepancies.some((d) => d.includes("merged-commit read failed") && d.includes("git log exploded")));
  assert.equal(shippedSince(runs, marker, at(marker)).shipped.length, 0, "a merge AT the marker is the previous window's");
  assert.equal(shippedSince(runs, undefined, at(marker)).shipped.length, 1, "no marker: no window, and no log read");
});

test("a ledger merge with no readable time is credited only when its run started after the marker", () => {
  const runs = gatherRuns(parseLedger(ledger([
    { ts: before, step: "run.start", run_id: "old", task_id: "W1-T-old", type: "implement" },
    { step: "verdict", run_id: "old", verdict: "merged", pr_url: pr(8) },
    { ts: after, step: "run.start", run_id: "new", task_id: "W1-T-new", type: "implement" },
    { step: "verdict", run_id: "new", verdict: "merged", pr_url: pr(9) },
    { ts: after, step: "run.start", run_id: "nourl", task_id: "W1-T-nourl", type: "implement" },
    { ts: after, step: "verdict", run_id: "nourl", verdict: "merged" },
  ])));
  const result = shippedSince(runs, marker, { findMergedByTrailer: () => null, headRefName: (u) => (u === pr(9) ? "run-new" : "foreign") });
  assert.deepEqual(result.shipped.map((s) => s.taskId), ["W1-T-new"]);
  assert.ok(result.discrepancies.some((d) => d.startsWith("W1-T-old (old): ledger merge time is unknown")));
  assert.ok(result.discrepancies.some((d) => d.startsWith("W1-T-nourl (nourl): ledger verdict=merged but has no pr_url")));
});

test("W1-T5113: the closure rate is merges over dispatched attempts, and filings stay the alternative denominator", () => {
  const attempt = (runId: string, startTs = after) => ({ runId, taskId: `W1-${runId}`, startTs, taskClass: "src", verdict: "blocked_ci", costUsd: 2 });
  const runs = Array.from({ length: 10 }, (_, i) => attempt(`T${i}`));
  const shipped = runs.slice(0, 5).map(({ runId, taskId }) => ({ runId, taskId }));
  const [row] = closureByClass([...runs, attempt("T-old", before)], shipped, Array(650).fill("src"), marker);
  assert.deepEqual(row.mergeRate, { kind: "rate", value: 0.5, merged: 5, denominator: 10 });
  assert.equal(row.costPerMerge, 4);
  assert.equal(mergeRateCell(row.mergeRate), "0.5 (5 of 10 attempts)");
  const filings = Array.from({ length: 5 }, () => ({ taskClass: "src", filedTs: after }));
  const [filed] = closureByClass(runs, shipped.slice(0, 1), [], marker, filings);
  assert.match(renderClosureByClass([filed]), /0\.2 \(1 of 5 filings\)/);
  const byTask = closureByClass(runs.slice(0, 5), [
    { runId: "absent", taskId: runs[0].taskId, mergeTs: after },
    { runId: runs[1].runId, taskId: runs[1].taskId, mergeTs: marker },
  ], [], marker);
  assert.equal(byTask[0].merged, 1, "joined by task when the credited run is absent; a merge at the marker is excluded");
  assert.equal(byTask[0].lastMergeTs, after);
});

function withGh(kind: string, routes: GhShimRoute[]) {
  const scratch = makeTempDir(`t5649-${kind}`);
  const done = join(scratch, "search.done");
  const shim = ghShim(routes.map((r) => (r.when === "search/issues" ? { ...r, delaySeconds: 0.3, doneFile: done } : r)), { kind: `t5649-${kind}-gh` });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  return {
    shim,
    inFlight: () => shim.calls().some((c) => c.includes("search/issues")) && !existsSync(done),
    restore: () => {
      process.env.PATH = savedPath;
      rmSync(scratch, { recursive: true, force: true });
      rmSync(shim.dir, { recursive: true, force: true });
    },
  };
}

function triggerRoot(rows: LedgerRecord[], markerTs: string): Config {
  const root = makeTempDir("t5649-trigger");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "ledger.ndjson"), ledger(rows) + "\n");
  saveMarker(join(root, "state", "last-retro.json"), { ts: markerTs, learnings_count: 0, runs_seen: 0 });
  return { claudeBin: "/bin/true", root };
}

const FAR_MARKER = "2099-01-01T00:00:00.000Z";
const FAR_AFTER = "2099-01-02T00:00:00.000Z";

test("the daemon's awaited trigger keeps the loop ticking through its GitHub search, bounded by post-marker candidates", async () => {
  const rows: LedgerRecord[] = [];
  for (let i = 0; i < 400; i++) rows.push(...run(`old-${i}`, `W1-T8${i}`, before, "blocked_ci", before));
  rows.push(...run("new-open", "W1-TNO", FAR_AFTER, "blocked_ci", FAR_AFTER));
  rows.push(...run("new-merged", "W1-TNM", FAR_AFTER, "merged", FAR_AFTER, "https://github.com/o/r/pull/78"));
  const config = triggerRoot(rows, FAR_MARKER);
  const gh = withGh("loop", [
    { when: "api rate_limit", stdout: "5000" },
    { when: "api user", stdout: "someone" },
    { when: "search/issues", stdout: JSON.stringify({ items: [{ number: 77, html_url: "https://github.com/o/r/pull/77", pull_request: { merged_at: "2099-01-02T01:00:00Z" } }] }) },
    { when: "repos/o/r/pulls/77", stdout: JSON.stringify({ head: { ref: "run-new-open" } }) },
    { when: "repos/o/r/pulls/78", stdout: JSON.stringify({ head: { ref: "run-new-merged" } }) },
  ]);
  try {
    const policy = loadPolicy(policyPath(REPO_ROOT));
    let ticks = 0;
    const interval = setInterval(() => { if (gh.inFlight()) ticks += 1; }, 5);
    let decision: RetroTriggerDecision | undefined;
    try {
      decision = await retroTriggerCheckAsync(new Date("2099-01-03T00:00:00.000Z"), { config, policy });
    } finally {
      clearInterval(interval);
    }
    assert.ok(ticks > 0, `the loop ran ${ticks} interval ticks while the trailer search was in flight`);
    assert.equal(gh.shim.calls().filter((c) => c.includes("search/issues")).length, 1, "one search: the one post-marker run off the ledger");
    assert.ok(gh.shim.calls().some((c) => c.includes("search/issues") && c.includes("W1-TNO")));
    assert.equal(decision?.mergesSinceMarker, 2, "both post-marker merges credited off awaited reads");
  } finally {
    gh.restore();
  }
});

test("the awaited gateway's arms: an unreachable head reads unresolved, a missed search reads null, a refused probe is named", async () => {
  const gh = withGh("arms", [
    { when: "search/issues", stdout: JSON.stringify({ items: [] }) },
    { when: "repos/o/r/pulls/5", stderr: "HTTP 404", exit: 1 },
    { when: "api rate_limit", stderr: "HTTP 401: Bad credentials", exit: 1 },
  ]);
  try {
    const gw = retroShippedGithubGatewayAsync(REPO_ROOT);
    assert.equal(await gw.findMergedByTrailer("W1-TNONE"), null);
    assert.equal(await gw.headRefName("https://github.com/o/r/pull/5"), undefined);
    assert.equal(await gw.headRefName("not a pull url"), undefined);
    assert.match((await gw.unavailable?.()) ?? "", /gh rate_limit probe failed: .*Bad credentials/);
    const config = triggerRoot([], FAR_MARKER);
    assert.equal(await retroTriggerCheckAsync(new Date(), { config, policy: loadPolicy(policyPath(REPO_ROOT)) }), undefined);
    const declined = readFileSync(join(config.root, "state", "ledger.ndjson"), "utf8");
    assert.match(declined, /daemon\.retro_trigger\.declined/);
  } finally {
    gh.restore();
  }
  const foreign = makeTempDir("t5649-origin");
  execFileSync("git", ["init", "-q", foreign]);
  execFileSync("git", ["-C", foreign, "remote", "add", "origin", "nonsense"]);
  await assert.rejects(async () => retroShippedGithubGatewayAsync(foreign).findMergedByTrailer("W1-T1"), /cannot parse owner\/repo/);
  rmSync(foreign, { recursive: true, force: true });
});

test("the daemon hook returns the previous check's decision once, drops one begun before a fire, and rethrows a failure", async () => {
  const fire: RetroTriggerDecision = { fire: true, reason: "merges", mergesSinceMarker: 9, daysSinceMarker: 1, followupsPending: 0 };
  let computes = 0;
  let next: () => Promise<RetroTriggerDecision | undefined> = async () => fire;
  let fired = 0;
  const check = retroCheckOffLoop(() => { computes += 1; return next(); }, () => fired);
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  assert.equal(check(), undefined, "nothing has settled on the first tick");
  await settle();
  assert.deepEqual(check(), fire, "the next tick reads it");
  fired += 1;
  await settle();
  assert.equal(computes, 2, "and that tick started the next check");
  assert.equal(check(), undefined, "a decision begun before the fire is dropped");
  next = async () => { throw new Error("search refused"); };
  await settle();
  await settle();
  assert.throws(() => check(), /search refused/);

  let runs = 0;
  const hooks = buildRetroDaemonHooks({ checkAsync: async () => fire, runRetro: async () => { runs += 1; return 0; } });
  assert.equal(hooks.checkRetroTrigger(), undefined);
  await settle();
  const decision = hooks.checkRetroTrigger();
  assert.deepEqual(decision, fire);
  await hooks.runRetroTrigger(fire);
  await settle();
  assert.equal(hooks.checkRetroTrigger(), undefined, "the hook's own fire drops the decision already in flight");
  assert.equal(runs, 1);
});
