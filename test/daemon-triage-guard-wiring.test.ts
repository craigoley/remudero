import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { daemonCommand, ghLiveStateByNumber } from "../src/run-task.js";
import { singlePrRestArgs, type GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { buildBatchedGithub, type BatchedPr, type GitHub } from "../src/lib/status.js";
import { runDaemon } from "../src/lib/daemon.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";

// W1-T1019 (the guard W1-T300 shipped but never wired): daemon.ts's `deps.isFeedbackOpenPr` /
// `deps.readFeedbackLiveState` were declared and CONSUMED (`deps.isFeedbackOpenPr?.(...)`, no `??`
// fallback) but supplied by NOTHING in `src/` — `openPrNumber` read `undefined` on every pass,
// `inFlight` was always `false`, and the deduped Azure ledger read 77 `auto_triage.fired` rows
// against 0 `skipped_inflight` and 0 `stood_down` over sixteen days. `test/triage-inflight-dedup
// .test.ts` (W1-T300's own falsifier) injects both deps directly and passes either way — it proves
// the GUARD LOGIC, never that anything real supplies it. THAT is the mistake this file exists to
// make impossible, the same way test/auto-triage-wiring.test.ts exists for checkAutoTriage/
// runAutoTriage: every test below drives the REAL `daemonCommand` and asserts on (or replays) the
// DaemonDeps it actually hands to `runDaemon`, never a hand-rolled substitute for either dep.

function fixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-triage-guard-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  // `home` starts with RMD_TMP_PREFIX ("rmd-"), the exact prefix daemonCommand's OWN real
  // boot-time `sweepStaleTempDirs` (lib/tmp.ts) reaps anything under os.tmpdir() matching, by
  // AGE (`now() - mtimeMs > maxAgeMs`, plan/policy.yaml's `sweep.tmpMaxAgeMs`, 1h). Every
  // mkdirSync/writeFileSync above this line updates `home`'s own mtime to the REAL OS clock —
  // under clock-sweep's future shift that real mtime reads as ancient, so the daemon's own real
  // housekeeping sweep deleted this fixture (planPath included, hence the ENOENT on `tasks.yaml`
  // measured under +7d) before `daemonCommand` or the later `loadPlan(planPath)` call ever read
  // it. Stamping `home`'s mtime from the (possibly shifted) injected clock — LAST, after every
  // write under it — keeps this fixture's own age reading consistent with `Date.now()`
  // regardless of shift, the same "stamp from the injected clock" remedy already applied to
  // test/cost-governor.test.ts's and test/run-task.test.ts's identical `rmd-`-prefixed fixtures.
  const now = new Date();
  utimesSync(home, now, now);
  return { home, root, planPath };
}

/** Drives the REAL daemonCommand, capturing the DaemonDeps it hands to runDaemon via the SAME
 *  injected-runDaemon seam test/auto-triage-wiring.test.ts and test/cost-governor.test.ts already
 *  pin. `githubFactory` defaults to an OFFLINE batched gateway (`fetchAll: () => []`) so a test
 *  that only needs the SHAPE of the deps object never pays for or depends on a live `gh` read. */
async function captureDeps(
  planPath: string,
  githubFactory: (owner: string, repo: string) => GitHub = (owner, repo) =>
    buildBatchedGithub(owner, repo, { fetchAll: () => [] }),
): Promise<DaemonDeps> {
  let captured: DaemonDeps | undefined;
  const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
    githubFactory,
    runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  });
  assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
  assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
  return captured;
}

async function withFixture(fn: (f: { home: string; root: string; planPath: string }) => Promise<void>): Promise<void> {
  const f = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = f.home;
  try {
    await fn(f);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(f.home, { recursive: true, force: true });
  }
}

test("W1-T1019: the daemon construction supplies the feedback open pr lookup", async () => {
  await withFixture(async ({ planPath }) => {
    const deps = await captureDeps(planPath);
    // BEFORE THIS FIX: `deps.isFeedbackOpenPr` was `undefined` on every production boot (grep
    // src/ carried only the daemon.ts declaration + consumption — no third, construction, site) —
    // so daemon.ts's `deps.isFeedbackOpenPr?.(decision.feedbackId)` always resolved `undefined`
    // and the whole in-flight block was structurally unreachable.
    assert.equal(
      typeof deps.isFeedbackOpenPr,
      "function",
      "the real daemon construction must wire isFeedbackOpenPr so the in-flight guard can evaluate",
    );
  });
});

test("W1-T1019: the daemon construction supplies the confirming live state read", async () => {
  await withFixture(async ({ planPath }) => {
    const deps = await captureDeps(planPath);
    // BEFORE THIS FIX: `deps.readFeedbackLiveState` was `undefined` too, so even a hypothetical
    // `isFeedbackOpenPr` supply alone could never reach the stand-down branch (design clause iv:
    // "BOTH DEPS, NOT ONE").
    assert.equal(
      typeof deps.readFeedbackLiveState,
      "function",
      "the real daemon construction must wire readFeedbackLiveState so the stand-down branch is reachable",
    );
  });
});

test("W1-T1019: an auto triage decision with an open pr is refused not fired", async () => {
  await withFixture(async ({ planPath }) => {
    const feedbackId = "fb-1019-open";
    // A triage run's own branch is `run-TRIAGE-<feedbackId>-<epochMs>` (run-task.ts's
    // `triageCommandLocked`: `taskId = \`TRIAGE-${feedbackId}\``, `branch = \`run-${runId}\``).
    // This fixture is the OPEN half of the SAME batched `listOpenHeadBranches()` fetch the
    // task-lane `isOpenPr` above already reads from `lastProj` — never a second GitHub call.
    const openTriagePr: BatchedPr = {
      number: 4242,
      url: "https://github.com/craigoley/remudero/pull/4242",
      state: "OPEN",
      headRefName: `run-TRIAGE-${feedbackId}-1787000000000`,
    };
    const deps = await captureDeps(planPath, (owner, repo) =>
      buildBatchedGithub(owner, repo, { fetchAll: () => [openTriagePr] }),
    );
    assert.equal(typeof deps.isFeedbackOpenPr, "function");

    // Drive the REAL captured isFeedbackOpenPr — not a hand-rolled fake — through the REAL
    // runDaemon (lib/daemon.js). checkAutoTriage/runAutoTriage are stubbed here because THEIR
    // wiring is already proven by test/auto-triage-wiring.test.ts; this test isolates whether the
    // REAL isFeedbackOpenPr construction resolves an open triage PR correctly. readFeedbackLiveState
    // is deliberately omitted: daemon.ts's own fail-OPEN contract (an absent confirming read
    // leaves `inFlight` true) is already pinned by test/triage-inflight-dedup.test.ts's "NO GUARD
    // WIRED" case, so this isolates isFeedbackOpenPr's contribution alone.
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let fires = 0;
    let stopChecks = 0;
    const plan = loadPlan(planPath);
    const summary = await runDaemon(
      plan,
      {
        refreshMerged: () => () => false,
        runOne: async (id: string) => ({ taskId: id, ok: true, merged: true }) as never,
        checkStop: () => {
          stopChecks++;
          return stopChecks > 1 ? "test bound reached" : undefined;
        },
        sleep: async () => {},
        checkAutoTriage: () => ({ fire: true, feedbackId, reason: "idle" }),
        runAutoTriage: async () => {
          fires++;
        },
        isFeedbackOpenPr: deps.isFeedbackOpenPr,
        log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      },
      { laneCount: 1 },
    );

    assert.equal(summary.stopReason, "stopped");
    assert.equal(fires, 0, "the REAL wired isFeedbackOpenPr must see the open triage PR and refuse the fire");
    assert.equal(lines.filter((l) => l.step === "auto_triage.fired").length, 0);
    const refusals = lines.filter((l) => l.step === "auto_triage.skipped_inflight");
    assert.ok(refusals.length >= 1, "the refusal must be ledgered, not silent");
    assert.equal(refusals[0].extra.feedback, feedbackId);
    assert.equal(
      refusals[0].extra.pr_number,
      4242,
      "the refusal must name the REAL open PR number the fake gateway supplied — proof the real construction, not a fixture, resolved it",
    );
  });
});

test("W1-T1019: a stale cached in flight read stands the guard down", async () => {
  await withFixture(async ({ planPath }) => {
    const feedbackId = "fb-1019-stale";
    // The CACHED snapshot the fake gateway hands isFeedbackOpenPr says OPEN — but the confirming
    // read must be FRESH (W1-T177's discipline, applied to this lane). PR #1184 is the REAL,
    // permanent fact this task's own rationale cites (the #1184/#1185 duplicate-triage race
    // W1-T300 exists for): craigoley/remudero#1184 merged 2026-08-03 and a merged PR's state
    // never reverts.
    //
    // The live state is read through the REAL `ghLiveStateByNumber` — design clause (iii)'s bar is
    // that this proves the shipped construction, not a fake — with only its `fetch` seam injected,
    // the SAME seam test/review-status-gate.test.ts already pins it through. That keeps the fold
    // from a REST payload to "MERGED" the shipped one rather than a literal, and drops the ONE
    // thing this file cannot ask of a CI runner: an authenticated `gh`. Uninjected, the call is a
    // real API read; `ghLiveStateByNumber` swallows its failure and returns undefined, so on a
    // runner with no credential the guard never stood down and this test failed `0 !== 1` while
    // passing on any developer machine — an environment fault wearing a regression's clothes.
    const staleCachedOpenPr: BatchedPr = {
      number: 1184,
      url: "https://github.com/craigoley/remudero/pull/1184",
      state: "OPEN", // the stale cached snapshot
      headRefName: `run-TRIAGE-${feedbackId}-1787000000001`,
    };
    const deps = await captureDeps(planPath, (owner, repo) =>
      buildBatchedGithub(owner, repo, { fetchAll: () => [staleCachedOpenPr] }),
    );
    assert.equal(typeof deps.isFeedbackOpenPr, "function");
    assert.equal(typeof deps.readFeedbackLiveState, "function");

    // #1184's REST row as GitHub really serves it for a merged PR, routed by path so an unrouted
    // read throws rather than silently answering.
    const restPath = singlePrRestArgs("craigoley", "remudero", 1184).join(" ");
    const calls: string[] = [];
    const fetch: GhApiFetcher = (args) => {
      calls.push(args.join(" "));
      if (args.join(" ") !== restPath) throw new Error(`unrouted fetch: ${args.join(" ")}`);
      return { number: 1184, state: "closed", merged: true };
    };
    // The real composition, before it is handed to the daemon: the shipped fold answers MERGED,
    // and it asks REST by number rather than the GraphQL `pr view` form W1-T511 moved off.
    assert.equal(ghLiveStateByNumber("craigoley", "remudero", 1184, fetch), "MERGED");
    assert.deepEqual(calls, ["api repos/craigoley/remudero/pulls/1184"]);

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let fires = 0;
    let stopChecks = 0;
    const plan = loadPlan(planPath);
    await runDaemon(
      plan,
      {
        refreshMerged: () => () => false,
        runOne: async (id: string) => ({ taskId: id, ok: true, merged: true }) as never,
        checkStop: () => {
          stopChecks++;
          return stopChecks > 1 ? "test bound reached" : undefined;
        },
        sleep: async () => {},
        checkAutoTriage: () => ({ fire: true, feedbackId, reason: "idle" }),
        runAutoTriage: async () => {
          fires++;
        },
        isFeedbackOpenPr: deps.isFeedbackOpenPr,
        readFeedbackLiveState: (_feedback, prNumber) => ghLiveStateByNumber("craigoley", "remudero", prNumber, fetch),
        log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      },
      { laneCount: 1 },
    );

    assert.equal(
      fires,
      1,
      "the REAL wired readFeedbackLiveState's fresh read of an already-merged PR must stand the guard down and allow the fire",
    );
    assert.equal(
      lines.filter((l) => l.step === "auto_triage.skipped_inflight").length,
      0,
      "a stood-down guard must never also ledger a live in-flight refusal",
    );
    const stoodDown = lines.filter((l) => l.step === "auto_triage.stood_down");
    assert.ok(stoodDown.length >= 1, "standing down must be ledgered");
    assert.equal(stoodDown[0].extra.feedback, feedbackId);
    assert.equal(stoodDown[0].extra.pr_number, 1184);
    assert.equal(stoodDown[0].extra.state, "MERGED");
  });
});
