import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildBatchedGithub, ghGateway, classifyGhFailure, type GitHub, type GhReadState } from "../src/lib/status.js";
import { buildStatusBoard, type StatusBoardDeps } from "../src/lib/status-board.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";

/**
 * W1-T2219: `readFailed()`/`readFailureReason()` were a boolean plus a reason with no
 * "not attempted" and no "in flight" state, and BOTH accessors forced their own fetch first —
 * so asking whether a read failed PERFORMED the read and blocked the caller on a live `gh` call
 * while the flags still answered for the PREVIOUS attempt. This file proves each of the task's
 * seven acceptance claims against `buildBatchedGithub` (the gateway that actually forced the
 * fetch) and, for the "still logs"/"blocked-pr" claims, the sites the design (iv) names as
 * unchanged by this fix.
 */

// ── acceptance: a read that was never attempted is distinguishable from one that failed ───────

test("W1-T2219 acceptance: a read that was never attempted is distinguishable from one that failed", () => {
  const untouched = buildBatchedGithub("o", "r", {
    fetchAll: () => {
      throw new Error("must never be called -- no query method has run yet");
    },
  });
  assert.equal(untouched.readState?.(), "not_attempted", "no query method has ever run on this gateway");
  // THE THIRD-STATE DISCARD, DIRECTLY: readFailed() alone reads `false` for BOTH "not attempted"
  // and "confirmed not failed" -- readState() is what tells them apart.
  assert.equal(untouched.readFailed?.(), false, "the boolean pair alone cannot express 'not attempted'");

  const outage = buildBatchedGithub("o", "r", {
    exec: () => {
      throw Object.assign(new Error("boom"), { status: 1, stderr: "gh: API rate limit exceeded" });
    },
  });
  assert.equal(outage.findMergedByTrailer("W1-T1"), null, "one completed (failing) attempt");
  assert.equal(outage.readState?.(), "failed");

  assert.notEqual(
    untouched.readState?.(),
    outage.readState?.(),
    "'not_attempted' and 'failed' are DIFFERENT, distinguishable states, never collapsed together",
  );

  // The per-task gateway (ghGateway) makes its own `gh` call per query rather than pooling one
  // batched fetch, but it carries the SAME distinction -- an instance nothing has queried yet
  // reads 'not_attempted', never a bare 'false' pretending to be a confirmed clean read.
  const perTaskUntouched = ghGateway("o", "r", {
    exec: () => {
      throw new Error("must never be called");
    },
  });
  assert.equal(perTaskUntouched.readState?.(), "not_attempted");
});

// ── acceptance: a read still in flight is not reported as the previous attempt's verdict ───────

test("W1-T2219 acceptance: a read still in flight is not reported as the previous attempt's verdict", () => {
  let observedDuringSecondFetch: GhReadState | undefined;
  let attempt = 0;
  const gh = buildBatchedGithub("o", "r", {
    ttlMs: 0, // every query re-checks the cache as stale, so a second query re-attempts
    fetchAll: () => {
      attempt += 1;
      if (attempt === 1) {
        // NOT rate-limit shaped: paceGhEntry auto-RETRIES a rate-limited call within the SAME
        // index() invocation (W1-T1007), which would swallow this "first attempt failed, second
        // attempt succeeds" shape before the test ever observed it. An auth-shaped failure
        // rethrows immediately, so this attempt completes (failed) on its own.
        throw Object.assign(new Error("boom"), { status: 1, stderr: "gh: bad credentials" });
      }
      // REENTRANT read from INSIDE the second fetch, while it is still running -- the only way a
      // synchronous `execFileSync`-shaped gateway can be observed mid-attempt at all (the real
      // default path blocks the whole process for its duration, same as everywhere else in
      // status.ts that notes this).
      observedDuringSecondFetch = gh.readState?.();
      return [];
    },
  });

  // First attempt: fails and COMPLETES -- readState() settles on the classified verdict.
  gh.findMergedByTrailer("W1-T1");
  assert.equal(gh.readState?.(), "failed", "the first attempt's own completed verdict");

  // Second attempt: while it is IN FLIGHT, a reentrant caller must see "in_flight" -- never the
  // stale "failed" verdict the FIRST, already-completed attempt left behind (rationale (2)(b)/
  // (3): "the flags still hold the previous attempt's verdict" for as long as a call is running).
  gh.findMergedByTrailer("W1-T1");
  assert.equal(observedDuringSecondFetch, "in_flight", "in flight, not the previous (failed) attempt's verdict");
  assert.equal(gh.readState?.(), "ok", "and once THIS attempt completes, the verdict is its own");
});

// ── acceptance: asking whether a read failed does not itself perform the read ──────────────────

test("W1-T2219 acceptance: asking whether a read failed does not itself perform the read", () => {
  let fetchCalls = 0;
  let issueFetchCalls = 0;
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => {
      fetchCalls += 1;
      return [];
    },
    fetchAllIssues: () => {
      issueFetchCalls += 1;
      return [];
    },
  });

  gh.readFailed?.();
  gh.readFailureReason?.();
  gh.readState?.();
  gh.issueReadFailureReason?.();

  assert.equal(fetchCalls, 0, "readFailed()/readFailureReason()/readState() must never trigger the PR fetch");
  assert.equal(issueFetchCalls, 0, "issueReadFailureReason() must never trigger the issue fetch");

  // The per-task gateway never shelled out on its own initiative either -- `exec` here would
  // throw if ANY of these accessors reached it, and none do.
  const perTask = ghGateway("o", "r", {
    exec: () => {
      throw new Error("must never be called");
    },
  });
  assert.doesNotThrow(() => perTask.readFailed?.());
  assert.doesNotThrow(() => perTask.readFailureReason?.());
  assert.doesNotThrow(() => perTask.readState?.());
  assert.equal(perTask.readFailed?.(), false);
  assert.equal(perTask.readState?.(), "not_attempted");
});

// ── acceptance: an issue-channel failure is reachable by a caller rather than only logged ──────

test("W1-T2219 acceptance: an issue-channel failure is reachable by a caller rather than only logged", () => {
  const rateLimit = Object.assign(new Error("boom"), { status: 1, stderr: "gh: API rate limit exceeded" });
  const logged: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const gh = buildBatchedGithub("o", "r", {
    fetchAllIssues: () => {
      throw rateLimit;
    },
    log: (event, extra) => logged.push({ event, extra }),
  });

  assert.equal(gh.issueByUrl?.("https://x/issues/1"), null, "the join fails closed, as before this task");
  assert.equal(gh.issueReadFailed?.(), true, "the boolean already existed pre-W1-T2219");
  // THE GAP THIS TASK CLOSES (rationale (2)(c)): the classified reason was captured and LOGGED,
  // but no accessor could reach it -- issueReadFailureReason() is that accessor.
  assert.equal(gh.issueReadFailureReason?.(), "rate_limit", "the reason is now reachable through an accessor");

  const loggedFailure = logged.find((l) => l.event === "board_gateway.issue_fetch_failed");
  assert.equal(
    loggedFailure?.extra?.reason,
    "rate_limit",
    "the SAME reason still reaches the log line -- this is an ADDITIONAL accessor, not a replacement",
  );
});

// ── acceptance: the per-task gateway's issue-channel reason is reachable too ────────────────────

test("W1-T2219 acceptance: ghGateway's issueReadFailureReason() reports the classified reason", () => {
  // ghGateway makes one `gh` call per query (no separate batched issue fetch, per the comment
  // beside issueReadFailed()/issueReadFailureReason() above) -- issueByUrl is the query that
  // drives its sticky failed/failureReason pair here, same as any other query method would.
  const gh = ghGateway("o", "r", {
    exec: () => {
      throw Object.assign(new Error("boom"), { status: 1, stderr: "gh: API rate limit exceeded" });
    },
  });

  assert.equal(gh.issueByUrl?.("https://x/issues/1"), null, "the failed fetch reports unavailable, not a false miss");
  assert.equal(gh.issueReadFailed?.(), true);
  assert.equal(gh.issueReadFailureReason?.(), "rate_limit", "the classified reason, reachable through the accessor");
});

// ── acceptance: a classified failure still reports exactly the reason it reports today ─────────

test("W1-T2219 acceptance: a classified failure still reports exactly the reason it reports today", () => {
  const enobufs = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  const gh = buildBatchedGithub("o", "r", {
    exec: () => {
      throw enobufs;
    },
  });

  // Every real caller reaches readFailed()/readFailureReason() AFTER a query method that itself
  // calls index() -- exactly the sequence this reproduces, and the one W1-T2219's blast-radius
  // note (68 invocations across 8 files) says is universal in this codebase.
  assert.equal(gh.findMergedByTrailer("W1-T1"), null);
  assert.equal(gh.readFailed?.(), true, "unchanged from before W1-T2219");
  assert.equal(gh.readFailureReason?.(), "buffer_overflow", "unchanged from before W1-T2219");
  assert.equal(
    classifyGhFailure(null, "", "ENOBUFS"),
    "buffer_overflow",
    "sanity: this IS classifyGhFailure's real verdict for this exact shape, not a fixture-only value",
  );
});

// ── acceptance: the blocked-pr class is still withheld when live state cannot be read ──────────

const NOW_ISO = "2026-08-24T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "read-failed-not-attempted-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function writeLedger(lines: Record<string, unknown>[]): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "read-failed-not-attempted-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return ledgerPath;
}

const PLAN_YAML = `
- id: W1-T9001
  title: still genuinely blocked, owns pr 900
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  pr: 900
`;

function plan(): Plan {
  return loadPlanFromYaml(PLAN_YAML, "fixture");
}

function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

test("W1-T2219 acceptance: the blocked-pr class is still withheld when live state cannot be read", () => {
  const ledgerPath = writeLedger([
    {
      run_id: "R1",
      task_id: "W1-T9001",
      ts: NOW_ISO,
      step: "sweep.disposed",
      pr_number: 900,
      pr_url: "https://x/900",
      disposition: "blocked-fixable",
      reason: "required checks red",
      acted: true,
    },
  ]);
  // A gateway that reports its own read as FAILED -- status-board.ts's own withholding logic
  // (deriveBlockers, status-board.ts:1416-1426) is UNCHANGED by this task; design (iv) states it
  // explicitly ("the withholding is CORRECT and only the reason string is wrong"). This fixture
  // is a plain GitHub literal, not buildBatchedGithub, so it proves the CALLER's behavior rather
  // than re-testing the gateway internals the other cases above already cover.
  const unreachable: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => true,
    readFailureReason: () => "transport",
  };

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: unreachable }));

  assert.equal(
    model.blockers.rows.find((r) => r.kind === "blocked_pr"),
    undefined,
    "the ledger's blocked-fixable disposition must NOT be printed while live merge state cannot be checked",
  );
  assert.match(
    model.blockers.blockedPrsUnverifiedReason ?? "",
    /transport/,
    "the classified reason still names WHY -- rationale (1)'s own subject string, unchanged by this task",
  );
});

// ── acceptance: both failure steps keep logging with their classified reason ───────────────────

test("W1-T2219 acceptance: both failure steps keep logging with their classified reason", () => {
  const rateLimit = Object.assign(new Error("boom"), { status: 1, stderr: "gh: API rate limit exceeded" });
  const logged: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const gh = buildBatchedGithub("o", "r", {
    exec: () => {
      throw rateLimit;
    },
    fetchAllIssues: () => {
      throw rateLimit;
    },
    log: (event, extra) => logged.push({ event, extra }),
  });

  gh.findMergedByTrailer("W1-T1"); // triggers the PR fetch, which fails
  gh.issueByUrl?.("https://x/issues/1"); // triggers the issue fetch, which fails

  const prFailure = logged.find((l) => l.event === "board_gateway.fetch_failed");
  const issueFailure = logged.find((l) => l.event === "board_gateway.issue_fetch_failed");
  assert.equal(prFailure?.extra?.reason, "rate_limit", "board_gateway.fetch_failed still logs -- design (iv), unchanged");
  assert.equal(
    issueFailure?.extra?.reason,
    "rate_limit",
    "board_gateway.issue_fetch_failed still logs -- design (iv), unchanged",
  );
});
