import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  brokerGhRead, ghBrokerDir, ghBrokerDirLive, ghBrokerRouteFor, ghReadBrokerLive,
  type GhBrokerProgress, type GhBrokerResult,
} from "#src/lib/gh-read-broker-client.js";
import {
  classifyGhBrokerRead, defaultGhBrokerClass, defaultGhUpstreamExec, ghBrokerCommand, ghCommand, GhLimiterPacer, ghMaxAgeMs,
  GhReadBroker, parseGhBrokerDuration, runGhDirect, serveGhReadBroker, summariseGhBrokerLog,
  type GhUpstreamExec, type GhUpstreamResult,
} from "#src/lib/gh-read-broker.js";
import { ghExec, ghJson, ghJsonAsync, ghLinesAsync, ghTextAsync } from "#src/lib/github-transport.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T10279 — every Claude session and agent of a Mac account shared ONE 180 s gh read slot. These tests
// drive the broker with an injected `gh` executor, an injected clock and a socket in a private temp dir:
// no real `gh`, no network. The hook is the real hooks/deny-floor.sh, fed the real PreToolUse JSON.

const ROOT = REPO_ROOT;
const HOOK = join(ROOT, "hooks/deny-floor.sh");
const INSTALLER = join(ROOT, "deploy/mac/install-gh-read-broker.sh");

function tmp(t: TestContext, tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-ghb-${tag}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A virtual clock: a sleep advances it and yields, so a paced drain runs at full speed. */
function virtualClock(start = 1_800_000_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); now += ms; await new Promise((resolve) => setImmediate(resolve)); },
  };
}

const ok = (stdout: string): GhUpstreamResult => ({ stdout, stderr: "", exitCode: 0 });
const http = (status: string, headers: string[], body: string) => ok(`HTTP/2.0 ${status}\r\n${headers.join("\r\n")}\r\n\r\n${body}`);

/** An executor the test answers by hand; `api user` (the login lookup) answers itself. */
function controlledExec() {
  const calls: Array<{ args: string[]; resolve: (r: GhUpstreamResult) => void }> = [];
  const exec: GhUpstreamExec = (args) => {
    if (args[1] === "user") return Promise.resolve(ok("octo\n"));
    return new Promise((resolve) => calls.push({ args, resolve }));
  };
  return { exec, calls };
}

/** Waits on real time, not a count of turns: under a parallel flake screen a socket round trip can take
 *  far longer than any fixed number of event-loop turns. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(predicate(), `timed out waiting for ${what}`);
}

test("W1-T10279: identical in-flight reads from several clients share one upstream call", { timeout: 60_000 }, async (t) => {
  const cache = tmp(t, "coalesce");
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  const clock = virtualClock();
  const { exec, calls } = controlledExec();
  const broker = new GhReadBroker(dir, exec, clockFromMillisFn(clock.now), clock.sleep, () => 1e12);
  const server = await serveGhReadBroker({ dir, broker });
  t.after(() => server.close());
  assert.equal(ghReadBrokerLive({ RMD_GH_CACHE_HOME: cache }), server.socketPath, "a serving broker's heartbeat reads live");

  const read = (caller: string) => brokerGhRead(server.socketPath, ["api", "repos/o/r/pulls/7"], { class: "agent", caller });
  const clients = [read("a"), read("b"), read("c")];
  await until(() => broker.inProgress === 3 && calls.length === 1, "three clients and one upstream call");
  calls[0].resolve(http("200 OK", ["Cache-Control: private, max-age=60", 'ETag: "e1"'], '{"n":7}'));
  const results = await Promise.all(clients);
  assert.deepEqual(results.map((r) => r.stdout), ['{"n":7}', '{"n":7}', '{"n":7}'], "every client gets the result");
  assert.deepEqual(results.map((r) => r.outcome).sort(), ["coalesced", "coalesced", "upstream-200"]);
  assert.equal(calls.length, 1, "one upstream call for three clients");

  // A FAILED upstream call is not cached: every waiter gets the failure, and the next read goes again.
  const failing = [1, 2].map((n) => brokerGhRead(server.socketPath, ["pr", "view", "9"], { caller: `f${n}`, repo: "o/r" }));
  await until(() => broker.inProgress === 2 && calls.length === 2, "two failing clients");
  calls[1].resolve({ stdout: "", stderr: "HTTP 502: Bad Gateway\n", exitCode: 1 });
  const failed = await Promise.all(failing);
  assert.deepEqual(failed.map((r) => [r.exitCode, r.stderr]), [[1, "HTTP 502: Bad Gateway\n"], [1, "HTTP 502: Bad Gateway\n"]]);
  const again = brokerGhRead(server.socketPath, ["pr", "view", "9"], { caller: "f3", repo: "o/r" });
  await until(() => calls.length === 3, "a fresh upstream call after a failure");
  calls[2].resolve(ok("title: nine\n"));
  assert.equal((await again).stdout, "title: nine\n");

  const status = await ghBrokerStatus(cache);
  assert.equal((status.counts as Record<string, number>).coalesced, 3);
  assert.equal((status.counts as Record<string, number>).upstream_calls, 3);
});

async function ghBrokerStatus(cacheHome: string, since?: string): Promise<Record<string, unknown>> {
  let printed = "";
  const code = await ghBrokerCommand(["status", ...(since ? ["--since", since] : [])], () => assert.fail("status never serves"),
    { RMD_GH_CACHE_HOME: cacheHome }, (text) => void (printed += text));
  assert.equal(code, 0, printed);
  return JSON.parse(printed) as Record<string, unknown>;
}

test("W1-T10279: a fresh hit costs no upstream call and a stale one revalidates with If-None-Match", async (t) => {
  const dir = tmp(t, "etag");
  const clock = virtualClock();
  const upstream: string[][] = [];
  const exec: GhUpstreamExec = async (args) => {
    if (args[1] === "user") return ok("octo\n");
    upstream.push(args);
    // GitHub answers 304 ONLY to a conditional request carrying the ETag it gave.
    if (args.includes('If-None-Match: "e1"')) return http("304 Not Modified", ["Cache-Control: private, max-age=60", 'ETag: "e1"'], "");
    return http("200 OK", ["Cache-Control: private, max-age=60", 'ETag: "e1"', "X-Ratelimit-Remaining: 4999", "X-Ratelimit-Reset: 1800000003"], `{"v":${upstream.length}}`);
  };
  const broker = new GhReadBroker(dir, exec, clockFromMillisFn(clock.now), clock.sleep, () => 1e12);
  const read = (extra: Partial<Parameters<GhReadBroker["read"]>[0]> = {}) =>
    broker.read({ op: "read", args: ["api", "repos/o/r/pulls/1"], class: "interactive", caller: "s", ...extra });

  const first = await read();
  assert.deepEqual([first.outcome, first.stdout], ["upstream-200", '{"v":1}']);
  assert.ok(upstream[0].includes("-i"), "the broker reads headers to learn the ETag and max-age");
  clock.advance(30_000);
  const hit = await read();
  assert.deepEqual([hit.outcome, hit.stdout, upstream.length], ["hit-fresh", '{"v":1}', 1], "inside max-age: no upstream call");
  const included = await read({ args: ["api", "-i", "repos/o/r/pulls/1"] });
  assert.match(included.stdout, /^HTTP\/2\.0 200 OK\r\n[\s\S]*\r\n\r\n\{"v":1\}$/, "`-i` gets the stored headers, from the same entry");
  clock.advance(31_000);
  const stale = await read();
  assert.deepEqual([stale.outcome, stale.stdout], ["revalidated-304", '{"v":1}'], "a 304 serves the stored body");
  assert.ok(upstream[1].includes('If-None-Match: "e1"'), upstream[1].join(" "));
  clock.advance(10_000);
  assert.equal((await read()).outcome, "hit-fresh", "the 304 refreshed the entry's age");
  const forced = await read({ fresh: true });
  assert.deepEqual([forced.outcome, upstream.length], ["revalidated-304", 3], "--fresh revalidates inside max-age");
  // A broker restarted over the same cache still knows the entry and its ETag.
  const restarted = new GhReadBroker(dir, exec, clockFromMillisFn(clock.now), clock.sleep, () => 1e12);
  clock.advance(61_000);
  const afterRestart = await restarted.read({ op: "read", args: ["api", "repos/o/r/pulls/1"], class: "interactive", caller: "s" });
  assert.equal(afterRestart.outcome, "revalidated-304");
  assert.equal(ghMaxAgeMs("Cache-Control: no-cache"), undefined);
  assert.equal(ghMaxAgeMs("ETag: x"), undefined);

  // An opaque read (porcelain) is fresh for the max-age GitHub last advertised, then goes upstream whole.
  const porcelain = { op: "read" as const, args: ["pr", "view", "1"], class: "agent" as const, caller: "a", repo: "o/r" };
  assert.equal((await broker.read(porcelain)).outcome, "upstream-200");
  clock.advance(59_000);
  assert.equal((await broker.read(porcelain)).outcome, "hit-fresh");
  clock.advance(2_000);
  assert.equal((await broker.read(porcelain)).outcome, "upstream-200");
  // A completed run's log never changes: kept until evicted.
  const log = { op: "read" as const, args: ["run", "view", "77", "--log-failed"], class: "agent" as const, caller: "a" };
  await broker.read(log);
  clock.advance(86_400_000);
  assert.equal((await broker.read(log)).outcome, "hit-fresh");
});

test("W1-T10279: an interactive read goes before queued agent reads and agents take turns", { timeout: 60_000 }, async (t) => {
  const dir = tmp(t, "fair");
  const clock = virtualClock();
  const { exec, calls } = controlledExec();
  const broker = new GhReadBroker(dir, exec, clockFromMillisFn(clock.now), clock.sleep, () => 1e12);
  const progress = new Map<string, GhBrokerProgress[]>();
  const read = (n: number, cls: "interactive" | "agent" | "background", caller: string) => {
    progress.set(`${n}`, []);
    return broker.read({ op: "read", args: ["api", `repos/o/r/pulls/${n}`], class: cls, caller }, (p) => progress.get(`${n}`)!.push(p));
  };
  const reads = [read(100, "background", "z")];
  await until(() => calls.length === 1, "the first read upstream");
  reads.push(read(1, "agent", "a"), read(2, "agent", "b"), read(3, "agent", "a"), read(4, "interactive", "s"));
  await until(() => broker.inProgress === 5, "five reads accepted");
  assert.deepEqual(progress.get("3")!.at(-1)?.position, 4, "a queued read reports its position");
  assert.deepEqual(progress.get("4")!.at(-1)?.position, 1, "the interactive read is first in line");
  for (let served = 1; served <= 5; served += 1) {
    await until(() => calls.length === served, `upstream call ${served}`);
    calls[served - 1].resolve(http("200 OK", ["Cache-Control: max-age=60"], "{}"));
  }
  await Promise.all(reads);
  assert.deepEqual(
    calls.map((c) => c.args.find((a) => a.startsWith("repos/"))),
    ["repos/o/r/pulls/100", "repos/o/r/pulls/4", "repos/o/r/pulls/1", "repos/o/r/pulls/2", "repos/o/r/pulls/3"],
    "interactive first, then agents round-robin by caller (a, b, a), FIFO within a caller",
  );
  assert.ok(clock.sleeps.length >= 4 && clock.sleeps.every((ms) => ms > 0), "upstream calls are serial and paced");

  // A higher class joining a queued read lifts it to that class's turn.
  const lifted = [read(200, "background", "z")];
  await until(() => calls.length === 6, "a blocking read");
  lifted.push(read(201, "background", "y"), read(202, "agent", "x"));
  await until(() => broker.inProgress === 3, "both queued");
  lifted.push(read(201, "interactive", "s"));
  await until(() => broker.inProgress === 4, "the joiner");
  for (let served = 6; served <= 8; served += 1) {
    await until(() => calls.length === served, `upstream call ${served}`);
    calls[served - 1].resolve(http("200 OK", [], "{}"));
  }
  await Promise.all(lifted);
  assert.deepEqual(calls.slice(6).map((c) => c.args.find((a) => a.startsWith("repos/"))), ["repos/o/r/pulls/201", "repos/o/r/pulls/202"]);
});

test("W1-T10279: pacing follows retry-after, x-ratelimit and secondary-limit refusals", async (t) => {
  // retry-after holds the limiter for exactly that long, and widens the gap.
  const pacer = new GhLimiterPacer(1_500);
  pacer.lastStartMs = 0;
  assert.equal(pacer.record(1_000, { headers: "HTTP/2.0 403 Forbidden\r\nRetry-After: 30", stderr: "", status: 403, exitCode: 1 }), "secondary");
  assert.equal(pacer.holdUntilMs, 31_000);
  assert.equal(pacer.gapMs, 3_000);
  assert.equal(pacer.nextStartMs(1_000), 31_000);
  // A secondary 403 with no retry-after backs off exponentially from GitHub's one minute.
  const secondary = { headers: "HTTP/2.0 403 Forbidden", stderr: "You have exceeded a secondary rate limit", status: 403, exitCode: 1 };
  pacer.record(40_000, secondary);
  assert.equal(pacer.holdUntilMs, 40_000 + 120_000, "the second refusal in a row holds twice the floor");
  assert.equal(pacer.gapMs, 6_000);
  // Successes narrow the gap again, additively, and clear the refusal streak.
  for (let i = 0; i < 4; i += 1) assert.equal(pacer.record(200_000 + i, { headers: "HTTP/2.0 200 OK", stderr: "", status: 200, exitCode: 0 }), "ok");
  assert.equal(pacer.gapMs, 6_000 - 4 * 150);
  assert.equal(pacer.secondaryRefusals, 0);
  pacer.record(300_000, secondary);
  assert.equal(pacer.holdUntilMs, 360_000, "a new streak starts again at the floor");
  // The primary budget is spread over the time left to its reset.
  const spread = new GhLimiterPacer(1_500);
  spread.lastStartMs = 10_000;
  spread.record(10_000, { headers: "X-Ratelimit-Remaining: 10\r\nX-Ratelimit-Reset: 110", stderr: "", status: 200, exitCode: 0 });
  assert.equal(spread.primarySpreadMs(10_000), 10_000);
  assert.equal(spread.nextStartMs(10_000), 20_000);
  spread.record(10_000, { headers: "X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 110", stderr: "API rate limit exceeded", status: 403, exitCode: 1 });
  assert.equal(spread.holdUntilMs, 110_000, "an exhausted primary budget holds until its reset");
  assert.equal(spread.record(20_000, { headers: "", stderr: "HTTP 404: Not Found", exitCode: 1 }), "failed");
  assert.equal(spread.primarySpreadMs(200_000), 0, "a reading past its reset spreads nothing");

  // End to end: a retry-after answer holds the NEXT queued read for exactly that long.
  const dir = tmp(t, "pace");
  const clock = virtualClock(0);
  const answers = [http("403 Forbidden", ["Retry-After: 45"], '{"message":"You have exceeded a secondary rate limit"}'), http("200 OK", [], "{}")];
  const exec: GhUpstreamExec = async (args) => (args[1] === "user" ? ok("octo\n") : { ...answers.shift()!, exitCode: answers.length === 1 ? 1 : 0 });
  const broker = new GhReadBroker(dir, exec, clockFromMillisFn(clock.now), clock.sleep, () => 1e12);
  const refused = await broker.read({ op: "read", args: ["api", "repos/o/r/pulls/1"], class: "interactive", caller: "s" });
  assert.equal(refused.exitCode, 1);
  const startedAt = clock.now();
  await broker.read({ op: "read", args: ["api", "repos/o/r/pulls/2"], class: "interactive", caller: "s" });
  assert.equal(clock.now() - startedAt, 45_000, "held for exactly the retry-after");
  const status = broker.status() as { limiters: Record<string, { gap_ms: number }> };
  assert.equal(status.limiters.core.gap_ms, 3_000 - 150, "doubled on the refusal, narrowed after the success");
});

/** Fire one PreToolUse call at the real hook with an isolated cache root. */
function fireHook(command: string, cacheHome: string, extra: Record<string, unknown> = {}): { status: number | null; stderr: string } {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ tool_input: { command }, ...extra }),
    encoding: "utf8",
    env: { ...process.env, RMD_GH_CACHE_HOME: cacheHome, XDG_CACHE_HOME: cacheHome, RMD_GH_COOLDOWN_S: "" },
  });
  return { status: r.status, stderr: r.stderr };
}

function heartbeat(cacheHome: string, intervalS: number, ageS: number): void {
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cacheHome })!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "heartbeat"), `${intervalS}\n`);
  const at = (Date.now() - ageS * 1000) / 1000;
  utimesSync(join(dir, "heartbeat"), at, at);
}

test("W1-T10279: the deny floor routes raw reads to a live broker and keeps its floor without one", (t) => {
  const live = tmp(t, "hook-live");
  heartbeat(live, 10, 3);
  const raw = fireHook("gh pr view 5 --json state", live);
  assert.equal(raw.status, 2, "a raw read is refused while the broker is live");
  assert.match(raw.stderr, /rmd gh --class interactive -- <same gh args>/);
  const agent = fireHook("gh api repos/o/r/pulls/5", live, { agent_id: "sub-1" });
  assert.match(agent.stderr, /rmd gh --class agent --/, "a subagent's call is routed as an agent");
  for (let i = 0; i < 3; i += 1) {
    assert.equal(fireHook("rmd gh -- pr view 5 --json state", live).status, 0, "rmd gh is paced by the broker, never floored");
  }
  assert.equal(fireHook("./bin/rmd gh --class agent --fresh -- api repos/o/r/pulls/5", live).status, 0);
  assert.equal(fireHook("rmd gh -- pr view 5 && gh pr view 6", live).status, 2, "a raw gh beside an rmd gh is still routed");
  assert.equal(fireHook("gh api rate_limit", live).status, 0, "the budget probe stays exempt");
  assert.equal(
    fireHook("for i in 1 2 3; do rmd gh -- pr view 5; sleep 30; done", live).status, 2,
    "a polling loop around rmd gh is refused exactly as around gh",
  );

  // No live broker: today's 180 s floor, for `gh` and `rmd gh` alike. A stale heartbeat is no broker.
  for (const [tag, setup] of [["none", () => {}], ["stale", (c: string) => heartbeat(c, 10, 25)]] as const) {
    const cache = tmp(t, `hook-${tag}`);
    setup(cache);
    assert.equal(fireHook("rmd gh -- pr view 5", cache).status, 0, `${tag}: the first read is allowed`);
    const floored = fireHook("gh pr view 6", cache);
    assert.equal(floored.status, 2, `${tag}: the floor holds`);
    assert.match(floored.stderr, /floor 180s, W1-T3275/);
    assert.equal(fireHook("rmd gh -- pr view 7", cache).status, 2, `${tag}: rmd gh is floored like gh with no broker`);
  }
});

test("W1-T10279: a write invalidates cached reads and is never brokered", async (t) => {
  const cache = tmp(t, "invalidate");
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  const clock = virtualClock();
  let n = 0;
  const exec: GhUpstreamExec = async (args) => {
    if (args[1] === "user") return ok("octo\n");
    n += 1;
    return args[0] === "api" ? http("200 OK", ["Cache-Control: max-age=60"], `{"body":${n}}`) : ok(`body ${n}\n`);
  };
  const broker = new GhReadBroker(dir, exec, clockFromMillisFn(clock.now), clock.sleep, () => 1e12);
  const view = { op: "read" as const, args: ["pr", "view", "5", "-R", "o/r"], class: "interactive" as const, caller: "s" };
  const api = { op: "read" as const, args: ["api", "repos/o/r/pulls/5"], class: "interactive" as const, caller: "s" };
  const list = { op: "read" as const, args: ["pr", "list"], class: "interactive" as const, caller: "s", repo: "o/r" };
  const other = { op: "read" as const, args: ["api", "repos/o/r/pulls/6"], class: "interactive" as const, caller: "s" };
  for (const r of [view, api, list, other]) await broker.read(r);
  for (const r of [view, api, list, other]) assert.equal((await broker.read(r)).outcome, "hit-fresh");

  // The hook sees the write and appends to the broker's invalidation file.
  assert.equal(fireHook("gh pr edit 5 -R o/r --body new", cache).status, 0, "a write is never refused");
  assert.equal(readFileSync(join(dir, "invalidations"), "utf8"), "o/r 5\n");
  assert.equal((await broker.read(view)).stdout, "body 5\n", "a body edited with gh pr edit is never served stale");
  assert.equal((await broker.read(api)).outcome, "upstream-200");
  assert.equal((await broker.read(list)).outcome, "upstream-200", "a list of that repo's pull requests is dropped too");
  assert.equal((await broker.read(other)).outcome, "hit-fresh", "another pull request's read is kept");
  fireHook("gh api --method PATCH repos/o/r/issues/6 -f title=x", cache);
  fireHook("rmd gh -- pr comment 6 --body hi", cache);
  assert.equal(readFileSync(join(dir, "invalidations"), "utf8"), "o/r 5\no/r 6\n* 6\n");
  assert.equal((await broker.read(other)).outcome, "upstream-200");

  // A write sent to the broker is refused by name, and never reaches gh.
  const before = n;
  for (const args of [["pr", "edit", "5", "--body", "x"], ["api", "--method", "POST", "repos/o/r/issues", "-f", "title=x"],
    ["api", "graphql", "-f", "query=mutation { addStar(input: {}) { clientMutationId } }"], ["api", "repos/o/r/issues", "-f", "title=x"]]) {
    const refused = await broker.read({ op: "read", args, class: "interactive", caller: "s" });
    assert.deepEqual([refused.exitCode, refused.outcome], [2, "refused"], args.join(" "));
    assert.match(refused.stderr, /refused a WRITE/);
  }
  assert.equal(n, before, "no write reached gh");
  assert.equal((broker.status() as { counts: Record<string, number> }).counts.refused, 4);
});

test("W1-T10279: classifying a read names its limiter and what it is about", () => {
  assert.deepEqual(classifyGhBrokerRead(["api", "graphql", "-f", "query={ viewer { login } }"]).kind, "opaque");
  assert.equal(classifyGhBrokerRead(["api", "graphql", "-f", "query={ viewer { login } }"]).limiter, "graphql");
  assert.equal(classifyGhBrokerRead(["api", "search/issues?q=x"]).limiter, "search");
  assert.equal(classifyGhBrokerRead(["search", "prs", "x"]).limiter, "search");
  assert.equal(classifyGhBrokerRead(["api", "repos/o/r/pulls", "--paginate"]).kind, "opaque");
  assert.equal(classifyGhBrokerRead(["api", "repos/o/r/pulls", "--jq=.[0]"]).kind, "opaque");
  assert.equal(classifyGhBrokerRead(["api", "-X", "GET", "repos/o/r/pulls", "-f", "state=open"]).kind, "opaque");
  assert.deepEqual(classifyGhBrokerRead(["api", "--include", "repos/o/r/pulls/3/files"]).upstreamArgs, ["api", "repos/o/r/pulls/3/files"]);
  assert.deepEqual(classifyGhBrokerRead(["api", "repos/o/r/pulls/3/files"]).subjects, [{ repo: "o/r", number: 3 }]);
  assert.deepEqual(classifyGhBrokerRead(["pr", "list", "--repo=o/r"]).subjects, [{ repo: "o/r", number: null }]);
  assert.deepEqual(classifyGhBrokerRead(["run", "list"]).kind, "opaque");
  assert.deepEqual(classifyGhBrokerRead(["repo", "view"]).kind, "passthrough");
  assert.equal(defaultGhBrokerClass({ REMUDERO_WORKER_SCOPE: "x" }), "agent");
  assert.equal(defaultGhBrokerClass({ REMUDERO_PROCESS_ACTOR: "daemon" }), "background");
  assert.equal(defaultGhBrokerClass({}), "interactive");
  assert.equal(parseGhBrokerDuration("2h"), 7_200_000);
  assert.equal(parseGhBrokerDuration("soon"), undefined);
});

test("W1-T10279: rmd gh prints what gh would, sends writes straight to gh, and needs a live broker to broker", { timeout: 60_000 }, async (t) => {
  const cache = tmp(t, "cli");
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  const clock = virtualClock();
  const exec: GhUpstreamExec = async (args) => (args[1] === "user" ? ok("octo\n") : { stdout: "out\n", stderr: "warn\n", exitCode: args.includes("8") ? 4 : 0 });
  const broker = new GhReadBroker(dir, exec, clockFromMillisFn(clock.now), clock.sleep, () => 1e12);
  const server = await serveGhReadBroker({ dir, broker });
  t.after(() => server.close());
  const env = { RMD_GH_CACHE_HOME: cache };
  const run = async (rest: string[], read?: Parameters<typeof ghCommand>[3]) => {
    const direct: string[][] = [];
    let out = "";
    let err = "";
    const code = await ghCommand(rest, env, (args) => { direct.push(args); return 0; }, read,
      (stream, text) => { if (stream === "stdout") out += text; else err += text; });
    return { code, out, err, direct };
  };
  assert.deepEqual(await run(["--", "pr", "view", "7"]), { code: 0, out: "out\n", err: "warn\n", direct: [] });
  assert.equal((await run(["--class", "interactive", "--fresh", "--", "pr", "view", "8"])).code, 4, "the exit code of the gh run itself");
  assert.deepEqual((await run(["--", "pr", "edit", "7", "--body", "x"])).direct, [["pr", "edit", "7", "--body", "x"]], "writes go to gh");
  assert.equal((await run(["pr", "view", "7"])).code, 2, "the `--` is required");
  assert.equal((await run(["--class", "nope", "--", "pr", "view"])).code, 2);
  assert.equal((await run(["--"])).code, 2);
  const progressed = await run(["--", "pr", "view", "9"],
    async (_socket, _args, opts) => { opts?.onProgress?.({ position: 2, expectedWaitMs: 3_000 }); return { stdout: "", stderr: "", exitCode: 0, outcome: "upstream-200" }; });
  assert.match(progressed.err, /queued, position 2, about 3s/);
  const gone = await run(["--", "pr", "view", "9"], async () => { throw new Error("ECONNREFUSED"); });
  assert.deepEqual([gone.direct, /running gh directly/.test(gone.err)], [[["pr", "view", "9"]], true], "an unreachable broker falls back");
  const noBroker = await ghCommand(["--", "pr", "view", "7"], { RMD_GH_CACHE_HOME: tmp(t, "none") }, () => 9);
  assert.equal(noBroker, 9, "no live broker: gh runs directly");

  // status, its log summary, a refused second server, and stop.
  const status = await ghBrokerStatus(cache, "1h");
  assert.equal((status.since as { reads: number }).reads, 2);
  assert.equal(status.heartbeat_interval_s, 10);
  await assert.rejects(serveGhReadBroker({ dir, broker }), /already serving/);
  let printed = "";
  const print = (s: string) => void (printed += s);
  const never = () => assert.fail("never serves");
  assert.equal(await ghBrokerCommand(["status", "--since", "later"], never, env, print), 2);
  assert.equal(await ghBrokerCommand(["bogus"], never, env, print), 2);
  assert.equal(await ghBrokerCommand(["status"], never, {}, print), 2, "no cache root");
  assert.equal(await ghBrokerCommand(["stop"], never, env, print), 0);
  await server.closed;
  assert.equal(ghReadBrokerLive(env), undefined, "a stopped broker leaves no live heartbeat");
  assert.equal(await ghBrokerCommand(["status"], never, env, print), 1, "not running");
  let served = false;
  assert.equal(await ghBrokerCommand(["serve"],
    async (d) => { served = d === dir; return { socketPath: "s", close: async () => {}, closed: Promise.resolve() }; }, env, print), 0);
  assert.ok(served);
  const summary = summariseGhBrokerLog(tmp(t, "nolog"), 0);
  assert.deepEqual([summary.files, summary.reads, summary.served_without_upstream_share], [0, 0, null]);
});

test("W1-T10279: the transport's read entry points use a live broker instead of the floor", { timeout: 180_000 }, async (t) => {
  const dir = tmp(t, "transport");
  // A separate process serves, as on a Mac: a synchronous read blocks this one while it waits.
  const bootstrap = join(dir, "serve.mjs");
  writeFileSync(bootstrap, `
    const { GhReadBroker, serveGhReadBroker } = await import(${JSON.stringify(join(ROOT, "src/lib/gh-read-broker.ts"))});
    const dir = process.argv[2];
    const broker = new GhReadBroker(dir, async (args) => {
      if (args[1] === "user") return { stdout: "octo\\n", stderr: "", exitCode: 0 };
      if (args.some((a) => a.includes("missing"))) return { stdout: "", stderr: "HTTP 404: Not Found\\n", exitCode: 1 };
      const body = JSON.stringify({ args: args.filter((a) => a !== "-i") });
      const tail = args.some((a) => a.includes("pulls/4")) ? "\\nsecond line" : "";
      return { stdout: "HTTP/2.0 200 OK\\r\\nCache-Control: max-age=60\\r\\nX-Ratelimit-Remaining: 4000\\r\\n\\r\\n" + body + tail, stderr: "", exitCode: 0 };
    }, undefined, undefined, () => 1e12);
    broker.pacer("core").gapMs = 0;
    await serveGhReadBroker({ dir, broker });
  `);
  const cache = join(dir, "cache");
  const brokerDir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  const child = spawn(process.execPath, ["--import", "tsx", bootstrap, brokerDir], { cwd: ROOT, stdio: "ignore" });
  t.after(() => child.kill());
  // Until the child serves (its startup is slow under a parallel flake screen); the test's own timeout bounds it.
  while (ghBrokerDirLive(brokerDir) === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
  const shim = ghShim([{ when: "", stdout: "FALSIFIER: the real gh ran\n" }]);
  const saved = { cache: process.env.RMD_GH_CACHE_HOME, path: process.env.PATH };
  process.env.RMD_GH_CACHE_HOME = cache;
  process.env.PATH = `${shim.dir}:${saved.path ?? ""}`;
  t.after(() => {
    if (saved.cache === undefined) delete process.env.RMD_GH_CACHE_HOME;
    else process.env.RMD_GH_CACHE_HOME = saved.cache;
    process.env.PATH = saved.path;
  });
  const socket = ghBrokerRouteFor(process.env);
  assert.ok(socket, "the fixture broker is live under this test's own cache root");
  assert.equal(ghBrokerRouteFor({ NODE_TEST_CONTEXT: "1", HOME: dir }), undefined, "a test process never finds a broker by itself");
  assert.equal(ghBrokerRouteFor({ GH_TOKEN: "own", HOME: dir }), undefined, "a caller with its own token keeps its identity");

  assert.match(ghExec(["api", "repos/o/r/pulls/1"], { encoding: "utf8" }), /^\{"args":\["api","repos\/o\/r\/pulls\/1"\]\}/);
  assert.ok(Buffer.isBuffer(ghExec(["api", "repos/o/r/pulls/1"])));
  assert.throws(() => ghExec(["api", "repos/o/r/missing"], { encoding: "utf8" }), (e: { status?: number }) => e.status === 1);
  const rate: unknown[] = [];
  assert.deepEqual(ghJson(["api", "repos/o/r/pulls/2"], (r) => rate.push(r)), { args: ["api", "repos/o/r/pulls/2"] }, "-i headers come back");
  assert.equal((rate[0] as { remaining?: number }).remaining, 4000);
  assert.match(String(await ghTextAsync(["api", "repos/o/r/pulls/3"])), /pulls\/3/);
  await assert.rejects(ghJsonAsync(["api", "repos/o/r/missing"]), /HTTP 404/);
  const lines: string[] = [];
  await ghLinesAsync(["api", "repos/o/r/pulls/4"], (line) => lines.push(line));
  assert.deepEqual(lines.slice(1), ["second line"]);
  assert.equal(shim.calls().length, 0, "no read reached gh");
  // A broker that went away after its heartbeat was read: the sync client entry runs gh itself.
  // Every brokered read carried this process's class: an unnamed caller is interactive (W1-T10271's order).
  const logged = readdirSync(join(brokerDir, "log")).flatMap((name) => readFileSync(join(brokerDir, "log", name), "utf8").trim().split("\n"));
  assert.ok(logged.length >= 5, `${logged.length} logged reads`);
  assert.deepEqual([...new Set(logged.map((line) => (JSON.parse(line) as { class: string }).class))], ["interactive"]);
  const fallback = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src/gh-read-broker-client-main.ts"), join(dir, "nowhere.sock"), "agent", "api", "x"],
    { cwd: ROOT, encoding: "utf8", env: process.env });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /^FALSIFIER: the real gh ran\n/);
  assert.match(fallback.stderr, /unreachable .*running gh directly/);
  assert.equal(shim.calls().length, 1);
});

test("W1-T10279: the real upstream executor shells out to the account's own gh", async (t) => {
  const shim = ghShim([
    { when: "repos/o/r/pulls/1", stdout: "{}" }, { when: "missing", stderr: "HTTP 404", exit: 1 }, { when: "quiet-failure", exit: 3 },
  ]);
  const saved = process.env.PATH;
  process.env.PATH = `${shim.dir}:${saved ?? ""}`;
  t.after(() => { process.env.PATH = saved; });
  assert.deepEqual(await defaultGhUpstreamExec(["api", "repos/o/r/pulls/1"], {}), { stdout: "{}\n", stderr: "", exitCode: 0 });
  assert.deepEqual(await defaultGhUpstreamExec(["api", "missing"], {}), { stdout: "", stderr: "HTTP 404\n", exitCode: 1 });
  // `rmd gh`'s direct path for writes and for no live broker: gh's own exit code, gh's own stdio.
  assert.equal(await runGhDirect(["pr", "edit", "quiet-failure"]), 3);
  assert.equal(await runGhDirect(["pr", "edit", "quiet-success"]), 0);
  // A real broker with the default executor, clock and disk measurement serves through the shim too.
  const dir = tmp(t, "real");
  const broker = new GhReadBroker(dir);
  const result: GhBrokerResult = await broker.read({ op: "read", args: ["repo", "view", "repos/o/r/pulls/1"], class: "interactive", caller: "s" });
  assert.equal(result.stdout, "{}\n");
});

test("W1-T10279: the installer describes a per-account launchd agent and --dry-run changes nothing", (t) => {
  const home = tmp(t, "install");
  const rmd = join(home, "rmd");
  writeFileSync(rmd, "#!/bin/sh\n");
  chmodSync(rmd, 0o755);
  const env = { ...process.env, HOME: home };
  const dry = spawnSync("bash", [INSTALLER, "--dry-run", "--rmd", rmd], { encoding: "utf8", env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /<string>gh-broker<\/string>\s*<string>serve<\/string>/);
  assert.match(dry.stdout, /<key>KeepAlive<\/key><true\/>/);
  assert.match(dry.stdout, /would run: launchctl bootstrap gui\//);
  assert.equal(existsSync(join(home, "Library/LaunchAgents/com.remudero.gh-read-broker.plist")), false, "a dry run writes nothing");
  assert.equal(existsSync(join(home, "Library")), false, "a dry run creates nothing under HOME");
  assert.equal(spawnSync("bash", [INSTALLER, "--rmd", "relative/rmd"], { encoding: "utf8", env }).status, 2);
  assert.equal(spawnSync("bash", [INSTALLER, "--bogus"], { encoding: "utf8", env }).status, 2);
  // The installing path itself is the operator's step after merge: no test runs it.
});
