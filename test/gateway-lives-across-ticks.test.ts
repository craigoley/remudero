import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { buildBatchedGithub, type GitHub } from "../src/lib/status.js";
import { daemonCommand } from "../src/run-task.js";

/**
 * test/gateway-lives-across-ticks.test.ts — R-24 (docs/audits/recon-2026-09-05.md).
 *
 * THE DEFECT. `daemonCommand`/`drainCommand` invoked `githubFactory` INSIDE `refreshMerged`, so
 * every tick got a brand-new `buildBatchedGithub`. That gateway holds `knownBoardPrs` — the row
 * cache `fetchBoardPrsRest`'s early stop compares against — at GATEWAY scope, so a fresh instance
 * always started cold, took `mode: "full"`, and walked the closed-PR half of the repo again:
 * `projectPlan` -> `listMergedHeadBranches` -> `index` -> `mergedRows` -> `restFetchHalf("closed")`.
 * The code's own 2026-08-26 measurement is 25 requests / 21.8 s at 2,400 PRs; this repo has passed
 * 4,080. GitHub's `sort=updated&direction=desc` delta stop can only pay off on an instance that
 * outlives one tick.
 *
 * WHAT THE PER-TICK INSTANCE ACTUALLY BOUGHT, and why it is not lost. Exactly one property: the
 * gateway closes over mutable failure verdicts, so a hoisted instance could let one tick's outage
 * mark every later tick indeterminate. `GitHub.resetFailureFlags()` buys that per tick without
 * discarding the delta cache with it — which is the third assertion below.
 *
 * DRIVEN THROUGH THE REAL `daemonCommand`, capturing the `DaemonDeps` it hands `runDaemon` via the
 * same injected-runDaemon seam test/daemon-triage-guard-wiring.test.ts and test/cost-governor.test
 * .ts already pin. `runDaemon`'s loop body opens with `deps.refreshMerged()` once per tick
 * (lib/daemon.ts), so calling the captured `refreshMerged` three times IS three ticks of the real
 * loop, with no dispatch, no lock and no spawn.
 */

const OWNER_ROWS_PER_PAGE = 100; // BOARD_FULL_PAGE_SIZE — a cold walk's page size.

/** A closed-half corpus deep enough that a COLD walk needs three pages and a warm one needs one:
 *  two full pages plus a short third. Newest first, exactly as `sort=updated&direction=desc`
 *  returns them, which is the entire basis of the delta's early stop. */
function closedRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < OWNER_ROWS_PER_PAGE * 2 + 5; i += 1) {
    const number = 5000 - i;
    rows.push({
      number,
      url: `https://api.github.com/repos/o/r/pulls/${number}`,
      html_url: `https://github.com/o/r/pull/${number}`,
      state: "closed",
      merged: true,
      head: { ref: i === 0 ? "run-W1-T24-1784913918134" : `chore/other-${number}`, sha: "deadbee" },
      body: i === 0 ? "work\nRemudero-Task: W1-T24\n" : "unrelated\n",
      title: "t",
      // FIXED per row, never `Date.now()`: the delta stop compares this string against the cached
      // row's, so a clock-derived stamp would make every warm walk look like a changed page.
      updated_at: `2026-07-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`,
      auto_merge: null,
    });
  }
  return rows;
}

interface TickLog {
  /** Every argv this tick's gateway constructed, in order. */
  argv: string[][];
  /** `readFailed()` as observed from inside the tick's FIRST `exec` — i.e. at the start of the
   *  tick, before any of its own fetches has recorded a verdict. */
  failedAtStart: boolean | undefined;
}

/**
 * The fake REST layer. Serves `closedRows()` by page, an empty open half, and — on the tick named
 * by `throwOpenOnTick` — throws for the open half the way a rate-limited `gh` does.
 */
function recordingExec(
  ticks: TickLog[],
  tickIndex: () => number,
  gatewayRef: () => GitHub | undefined,
  throwOpenOnTick: number,
): (args: string[]) => string {
  const rows = closedRows();
  return (args: string[]) => {
    const tick = ticks[tickIndex()];
    if (tick.failedAtStart === undefined) tick.failedAtStart = gatewayRef()?.readFailed?.() ?? false;
    tick.argv.push(args);
    const url = args[1] ?? "";
    const perPage = Number(/[?&]per_page=(\d+)/.exec(url)?.[1] ?? "0");
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
    if (url.includes("state=open")) {
      if (tickIndex() === throwOpenOnTick) throw new Error("API rate limit exceeded");
      return "[]";
    }
    return JSON.stringify(rows.slice((page - 1) * perPage, page * perPage));
  };
}

const ONE_TASK_YAML = `
- id: W1-T24
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixtureHome(): { home: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-gateway-lives-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, ONE_TASK_YAML);
  // Same reasoning as test/daemon-triage-guard-wiring.test.ts's own fixture: `home` carries the
  // RMD_TMP_PREFIX the daemon's real boot-time `sweepStaleTempDirs` reaps by mtime age.
  const now = new Date();
  utimesSync(home, now, now);
  return { home, planPath };
}

test("R-24: the daemon builds ONE projection gateway for its whole lifetime, and its delta cache survives every tick", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  const ticks: TickLog[] = [0, 1, 2].map(() => ({ argv: [], failedAtStart: undefined }));
  let tick = 0;
  // ONE TICK, ONE CLOCK READING. `refreshMerged` reaches `index()` more than once per pass, so at
  // `ttlMs: 0` a single tick walked the closed half TWICE (MEASURED: 6 calls, not 3) and the count
  // stopped meaning "one tick's walk". A frozen clock per tick, advanced well past `ttlMs`
  // between ticks, gives exactly the production shape: one refresh per tick, none within one.
  let clock = 1_700_000_000_000;
  let gateway: GitHub | undefined;
  const built: GitHub[] = [];
  let captured: DaemonDeps | undefined;

  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      githubFactory: (owner, repo) => {
        // The clock is advanced past `ttlMs` between ticks, so EVERY tick really re-fetches: the
        // reduction asserted below is the delta cache doing the work, never a TTL no-op quietly
        // answering from the previous tick's rows.
        const gw = buildBatchedGithub(owner, repo, {
          ttlMs: 1_000,
          now: () => clock,
          exec: recordingExec(ticks, () => tick, () => gateway, 1),
          commitTrailerIndex: () => null,
        });
        built.push(gw);
        gateway = gw;
        return gw;
      },
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
    assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");

    for (tick = 0; tick < 3; tick += 1) {
      clock += 5_000;
      captured.refreshMerged();
    }

    // ── 1. ONE INSTANCE. The assertion the hoist itself is answerable to: delete
    // `const projectionGithub = githubFactory(...)` and move the call back inside `refreshMerged`
    // and this reads 3.
    assert.equal(built.length, 1, "the factory is invoked ONCE for the daemon's whole lifetime, not once per tick");

    // ── 2. THE DELTA CACHE SURVIVED. A cold closed walk needs 3 pages here (100 + 100 + 5); a warm
    // one stops on the first row it already holds, so 1. Counted, not asserted about a mode string.
    const closedCalls = (t: TickLog): number => t.argv.filter((a) => String(a[1]).includes("state=closed")).length;
    assert.equal(closedCalls(ticks[0]), 3, "tick 1 walks the closed half COLD — three pages");
    assert.ok(closedCalls(ticks[1]) > 0, "tick 2 really did walk — the TTL expired between ticks, so this is not a cached no-op");
    assert.ok(
      closedCalls(ticks[1]) < closedCalls(ticks[0]),
      `tick 2 must stop at the delta boundary: ${closedCalls(ticks[1])} calls vs tick 1's ${closedCalls(ticks[0])}`,
    );
    assert.ok(
      closedCalls(ticks[2]) < closedCalls(ticks[0]),
      `tick 3 must stop at the delta boundary too: ${closedCalls(ticks[2])} calls vs tick 1's ${closedCalls(ticks[0])}`,
    );

    // ── 3. THE VERDICT DID NOT OUTLIVE ITS TICK. Tick 2's open half threw, so the gateway ended
    // that tick failed; tick 3 must OPEN clean. This is the one property the discarded per-tick
    // instance used to provide, now provided by `resetFailureFlags()` — and it is asserted from
    // INSIDE the tick's first `exec`, before that tick has recorded any verdict of its own, which
    // is the only moment a stale verdict is distinguishable from a fresh one.
    assert.equal(ticks[1].failedAtStart, false, "tick 2 opened clean (tick 1 succeeded)");
    assert.equal(gateway?.readFailed?.(), false, "and the gateway ends tick 3 healthy, not stuck on tick 2's outage");
    assert.equal(
      ticks[2].failedAtStart,
      false,
      "tick 3 must NOT open carrying tick 2's failure verdict — delete the resetFailureFlags() call and this reads true",
    );
    // ...while the delta cache tick 1 filled is STILL there, untouched by that failure: a reset
    // that cleared it would send tick 3 back down the three-page cold walk asserted above.
    assert.equal(closedCalls(ticks[2]), closedCalls(ticks[1]), "a failed tick costs no re-walk on the next one");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * `resetFailureFlags()` ITSELF — the three verdicts it clears, and the one thing it must not.
 *
 * The daemon test above drives it end to end through the real command, which exercises the OPEN
 * half only. These drive `buildBatchedGithub` directly, on a FROZEN clock inside `ttlMs`, because
 * that is the only window in which "the failed half was dropped along with its verdict" and "the
 * successful half was left exactly where it was" are distinguishable at all: outside the TTL both
 * halves refetch anyway and the reset would look like a no-op either way.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** Counts the argv this gateway builds, per half, and fails whichever half `failing` names. */
function halfCountingExec(argv: string[][], failing: () => "open" | "closed" | "none"): (args: string[]) => string {
  return (args: string[]) => {
    argv.push(args);
    const url = String(args[1] ?? "");
    const half = url.includes("state=open") ? "open" : "closed";
    if (failing() === half) throw new Error("API rate limit exceeded");
    return "[]";
  };
}

const countOf = (argv: string[][], half: "open" | "closed"): number =>
  argv.filter((a) => String(a[1]).includes(`state=${half}`)).length;

test("R-24: resetFailureFlags drops a FAILED half with its verdict, and leaves a SUCCESSFUL half untouched", () => {
  const argv: string[][] = [];
  let failing: "open" | "closed" | "none" = "closed";
  const gw = buildBatchedGithub("o", "r", {
    ttlMs: 60_000,
    now: () => 1_700_000_000_000, // FROZEN: nothing below expires by the clock.
    exec: halfCountingExec(argv, () => failing),
    commitTrailerIndex: () => null,
  });

  // Pass 1: the open half succeeds, the closed half throws.
  assert.equal(gw.listMergedHeadBranches?.(), null, "a failed read answers null, never a bare empty list");
  assert.equal(gw.readFailed?.(), true);
  const afterFirst = { open: countOf(argv, "open"), closed: countOf(argv, "closed") };
  assert.ok(afterFirst.open > 0 && afterFirst.closed > 0, "control: both halves really were attempted");

  // Still inside the TTL, the failed half is served from its stamped EMPTY cache — no refetch.
  gw.listMergedHeadBranches?.();
  assert.equal(countOf(argv, "closed"), afterFirst.closed, "control: within the TTL nothing refetches on its own");

  failing = "none";
  gw.resetFailureFlags?.();
  assert.equal(gw.readFailed?.(), false, "the verdict is gone");

  gw.listMergedHeadBranches?.();
  assert.equal(
    countOf(argv, "closed"),
    afterFirst.closed + 1,
    "the FAILED half was dropped with its verdict — otherwise the caller reads that stamped EMPTY half under a healthy readFailed(), which is exactly the 'GitHub says zero PRs' conflation W1-T181 exists to prevent",
  );
  assert.equal(
    countOf(argv, "open"),
    afterFirst.open,
    "and the SUCCESSFUL half is untouched — this resets failures, never the cache",
  );
});

test("R-24: resetFailureFlags clears the ISSUE channel's own verdict, independently of the PR halves", () => {
  let issuesFail = true;
  let issueFetches = 0;
  const gw = buildBatchedGithub("o", "r", {
    ttlMs: 60_000,
    now: () => 1_700_000_000_000,
    fetchAll: () => [],
    fetchAllIssues: () => {
      issueFetches += 1;
      if (issuesFail) throw new Error("API rate limit exceeded");
      return [];
    },
  });

  assert.equal(gw.issueReadFailed?.(), true, "the issue channel failed");
  assert.equal(issueFetches, 1);
  assert.notEqual(gw.issueReadFailureReason?.(), undefined, "and the reason was classified");
  assert.equal(gw.issueReadFailed?.(), true, "within the TTL it stays failed without refetching");
  assert.equal(issueFetches, 1, "control: no refetch of its own");

  issuesFail = false;
  gw.resetFailureFlags?.();
  assert.equal(gw.issueReadFailed?.(), false, "cleared, and the empty issue cache went with it");
  assert.equal(issueFetches, 2, "so the very next read really re-fetches rather than serving the failed empty index");
  assert.equal(gw.issueReadFailureReason?.(), undefined, "the classified reason is cleared alongside the flag");
});

test("R-24: resetFailureFlags on a HEALTHY gateway is a no-op — it performs no I/O and invalidates nothing", () => {
  const argv: string[][] = [];
  const gw = buildBatchedGithub("o", "r", {
    ttlMs: 60_000,
    now: () => 1_700_000_000_000,
    exec: halfCountingExec(argv, () => "none"),
    commitTrailerIndex: () => null,
  });

  gw.listMergedHeadBranches?.();
  const before = argv.length;
  assert.ok(before > 0, "control: the first read really did fetch");

  gw.resetFailureFlags?.();
  assert.equal(argv.length, before, "the reset itself fetches nothing");
  assert.equal(gw.readFailed?.(), false);

  gw.listMergedHeadBranches?.();
  assert.equal(argv.length, before, "and nothing was invalidated — a healthy tick pays no re-walk for calling this");
});
