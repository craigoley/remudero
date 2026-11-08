import assert from "node:assert/strict";
import test from "node:test";
import {
  decideProgressWatchdog,
  LIVE_OPEN_PR_MAX_PAGES,
  readLiveOpenPrInventory,
  renderProgressWatchdogVerdict,
  STALL_RECYCLE_AFTER_MS,
  type LiveOpenPrInventory,
} from "#src/lib/progress-watchdog.js";
import { progressWatchdogCommand } from "#src/run-task.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const MIN = 60_000;
const nowMs = Date.now();
const rowsAged = (minutes: number, enumerated = 3): Record<string, unknown>[] =>
  [{ ts: new Date(nowMs - minutes * MIN).toISOString(), step: "sweep.pass", enumerated }];
const prs = (from: number, n: number): { number: number }[] => Array.from({ length: n }, (_, i) => ({ number: from + i }));

/** A fake `gh api` over the open list (paged by 100) and the closed control. */
function board(open: number, closed: { number: number }[] = [{ number: 1 }]): { fetch: (args: string[]) => unknown; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch(args) {
      calls.push(args[1]);
      if (args[1].includes("state=closed")) return closed;
      const page = Number(/&page=(\d+)/.exec(args[1])?.[1] ?? "1");
      return prs(1000 + (page - 1) * 100, Math.max(0, Math.min(100, open - (page - 1) * 100)));
    },
  };
}

const read = (count: number): LiveOpenPrInventory => ({ state: "read", count, numbers: [], control: "ok" });
const decide = (live: LiveOpenPrInventory | undefined, ledger: number | undefined, ageMin = 40) =>
  decideProgressWatchdog({ rows: rowsAged(ageMin), nowMs, openPrCount: ledger, revivalLog: "", liveOpenPrInventory: live });

test("test/daemon/the-progress-watchdog-counts-open-prs-from-a-controlled-live-inventory.test.ts", () => {
  const b = board(0);
  const live = readLiveOpenPrInventory("o", "r", b.fetch);
  assert.deepEqual(live, { state: "read", count: 0, numbers: [], control: "ok" });
  assert.equal(b.calls.some((c) => c.includes("state=closed&per_page=1")), true, "the control ran in the same invocation");
  for (const ledger of [0, undefined, 31]) {
    const verdict = decide(live, ledger);
    assert.deepEqual([verdict.state, verdict.action], ["IDLE", "none"], `ledger ${ledger}`);
    assert.deepEqual(verdict.liveOpenPrInventory, live);
  }
});

test("a 0 with the control failing is UNKNOWN", () => {
  for (const closed of [[], [{ nope: 1 }], "not a list"] as unknown[]) {
    const live = readLiveOpenPrInventory("o", "r", (args) => (args[1].includes("state=closed") ? closed : []));
    assert.equal(live.state, "control_failed");
    for (const ledger of [0, undefined]) {
      const verdict = decide(live, ledger);
      assert.deepEqual([verdict.state, verdict.action], ["UNKNOWN", "none"]);
      assert.match(verdict.reason, /control_failed/);
    }
  }
  const thrown = readLiveOpenPrInventory("o", "r", (args) => {
    if (args[1].includes("state=closed")) throw new Error("401 bad credentials");
    return [];
  });
  assert.deepEqual([thrown.state, thrown.control], ["control_failed", "failed"]);
  assert.match((thrown as { reason: string }).reason, /401 bad credentials/);
});

test("a truncated walk is UNKNOWN", () => {
  const endless = readLiveOpenPrInventory("o", "r", (args) => (args[1].includes("state=closed") ? [{ number: 1 }] : prs(1, 100)));
  assert.equal(endless.state, "unknown");
  assert.match((endless as { reason: string }).reason, new RegExp(`${LIVE_OPEN_PR_MAX_PAGES} pages`));
  const shortRead = readLiveOpenPrInventory("o", "r", () => { throw new Error("ECONNRESET"); });
  assert.equal(shortRead.state, "unknown");
  assert.match((shortRead as { reason: string }).reason, /page 1 unreadable: ECONNRESET/);
  const notAList = readLiveOpenPrInventory("o", "r", () => ({ message: "rate limited" }));
  assert.equal(notAList.state, "unknown");
  for (const ledger of [0, undefined]) {
    assert.deepEqual([decide(endless, ledger).state, decide(endless, ledger).action], ["UNKNOWN", "none"]);
  }
});

test("a walk over several pages counts every open PR", () => {
  const b = board(250);
  const live = readLiveOpenPrInventory("o", "r", b.fetch);
  assert.equal(live.state === "read" && live.count, 250);
  assert.equal(b.calls.filter((c) => c.includes("state=open")).length, 3);
  assert.equal(readLiveOpenPrInventory("o", "r", board(100).fetch).state, "read", "an exactly full page is followed by an empty one");
});

test("a live count above 0 beside a ledger count of 0 or undefined is judged by progress age", () => {
  for (const ledger of [0, undefined]) {
    const stale = decide(read(3), ledger, 40);
    assert.deepEqual([stale.state, stale.action], ["STALLED", "recycle"], `ledger ${ledger}`);
    assert.match(stale.reason, /with 3 open PR\(s\) \(count: live\)/);
    assert.equal(decide(read(3), ledger, 20).state, "STALLED");
    assert.equal(decide(read(3), ledger, 20).action, "capture-diagnostics");
    assert.equal(decide(read(3), ledger, 1).state, "PROGRESSING");
  }
  assert.ok(40 * MIN > STALL_RECYCLE_AFTER_MS);
});

test("a ledger count of 31 with a live inventory that is unknown keeps today's path", () => {
  const unknown: LiveOpenPrInventory = { state: "unknown", control: "not_run", reason: "ECONNRESET" };
  const failed: LiveOpenPrInventory = { state: "control_failed", control: "failed", reason: "no row" };
  for (const live of [unknown, failed]) {
    const verdict = decide(live, 31, 40);
    assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
    assert.match(verdict.reason, /31 open PR\(s\)/);
    assert.equal(decide(live, 31, 1).state, "PROGRESSING");
  }
  assert.equal(decide(undefined, 0).state, "IDLE", "no live read at all is the unchanged ledger path");
});

test("the rendered line names both counts and the control", () => {
  const withRows = decideProgressWatchdog({ rows: rowsAged(40, 31), nowMs, openPrCount: 31, openPrCountSource: "full_pass",
    revivalLog: "", liveOpenPrInventory: read(4) });
  assert.match(renderProgressWatchdogVerdict(withRows), /open_prs_live=4 \(control ok\) open_prs_last_full_pass=31 \(full_pass\)/);
  const unknown = decide({ state: "control_failed", control: "failed", reason: "x" }, undefined);
  assert.match(renderProgressWatchdogVerdict(unknown), /open_prs_live=unknown \(control failed\) open_prs_last_full_pass=unknown \(none\)/);
  assert.doesNotMatch(renderProgressWatchdogVerdict(decide(undefined, 3)), /open_prs_live/);
});

test("progressWatchdogCommand reads the live inventory through its seam and never lets a dead read say IDLE", (t) => {
  const run = (rows: Record<string, unknown>[], live: { fetch: (args: string[]) => unknown; ownerRepo?: () => { owner: string; repo: string } }): string => {
    const { dir } = writeLedger(rows, { scope: t });
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    try {
      assert.equal(progressWatchdogCommand(["--state-root", dir], () => "", { ownerRepo: () => ({ owner: "o", repo: "r" }), ...live }), 0);
    } finally {
      console.log = log;
    }
    return out.join("\n");
  };
  const fresh = [{ ts: new Date(Date.now() - 2 * MIN).toISOString(), step: "sweep.pass", enumerated: 0 }];
  assert.match(run(fresh, board(0)), /^progress-watchdog: IDLE action=none .*open_prs_live=0 \(control ok\) open_prs_last_full_pass=0/);
  assert.match(run(fresh, board(0, [])), /^progress-watchdog: UNKNOWN action=none .*\(control failed\)/);
  assert.match(run(fresh, board(5)), /^progress-watchdog: PROGRESSING action=none .*open_prs_live=5 /);
  const unresolved = run(fresh, { fetch: board(0).fetch, ownerRepo: () => { throw new Error("no origin remote"); } });
  assert.match(unresolved, /^progress-watchdog: UNKNOWN action=none /);
  assert.match(unresolved, /no origin remote/);
});
