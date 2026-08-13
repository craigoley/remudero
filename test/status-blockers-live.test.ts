import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";

// ── W1-T306: BLOCKERS BY CLASS was listing `sweep.disposed` PRs whose disposition was still
// `blocked-fixable`/`blocked-ambiguous`/etc. in the LEDGER, even after GitHub confirmed the
// task actually MERGED — the ledger line is a stale snapshot from before the merge landed, and
// `deriveBlockedPrBlockers` never consulted the batched live projection (`projections`) the way
// its sibling `deriveIndeterminateBlockers` already does. All five entries in one live run were
// merged, so the section an operator reads first was mostly noise. Every test below is a plain
// object in, a plain object out: no real `gh`, no real ledger daemon — every seam
// `buildStatusBoard` exposes is injected exactly like the rest of this file's siblings.

const NOW_ISO = "2026-08-03T12:50:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "status-blockers-live-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
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

function ledgerLine(overrides: Record<string, unknown>): Record<string, unknown> {
  return { run_id: "R1", task_id: "daemon", ts: NOW_ISO, ...overrides };
}

function writeLedger(lines: Record<string, unknown>[]): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-blockers-live-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return ledgerPath;
}

// Five tasks: W1-T50 (owns its own merged PR #100 via the plan's `pr:` field), W1-T51 (owns
// merged PR #200, used to prove PR-NUMBER matching for a blocked line that names no task),
// W1-T52 (its `pr:` field, #300, is still OPEN — must remain a genuine blocker), W1-T53 (its
// `pr:` field, #400, is CLOSED-but-unmerged — an abandoned PR, also not a blocker per design
// (2): "a PR that is merged OR closed is NOT a blocker"), and W1-T54 (its `pr:` field, #500, is
// also OPEN, used as the sole genuine blocker in the unreachable-gateway test below).
const PLAN_YAML = `
- id: W1-T50
  title: already merged, owns pr 100
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  pr: 100
- id: W1-T51
  title: already merged, owns pr 200
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  pr: 200
- id: W1-T52
  title: still genuinely blocked, owns pr 300
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  pr: 300
- id: W1-T53
  title: abandoned (closed, never merged), owns pr 400
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  pr: 400
- id: W1-T54
  title: still genuinely blocked, owns pr 500
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  pr: 500
- id: W1-T60
  title: redispatched — its FIRST PR was disposed blocked, its SECOND (current) PR is still open
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`;

function plan(): Plan {
  return loadPlanFromYaml(PLAN_YAML, "fixture");
}

const KNOWN_PRS: Record<number, PrRef> = {
  100: { number: 100, url: "https://x/100", state: "MERGED" },
  200: { number: 200, url: "https://x/200", state: "MERGED" },
  300: { number: 300, url: "https://x/300", state: "OPEN" },
  400: { number: 400, url: "https://x/400", state: "CLOSED" },
  500: { number: 500, url: "https://x/500", state: "OPEN" },
};

function fakeGithub(overrides: Partial<GitHub> = {}): GitHub {
  return {
    prByRef: (ref) => KNOWN_PRS[typeof ref === "number" ? ref : Number(ref)] ?? null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    ...overrides,
  };
}

test("buildStatusBoard: BLOCKERS BY CLASS — a blocked-fixable PR whose OWNING task GitHub now confirms MERGED is dropped, not listed as noise", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "sweep.disposed",
      task_id: "W1-T50",
      pr_number: 100,
      pr_url: "https://x/100",
      disposition: "blocked-fixable",
      reason: "required checks red — ci-log fix, strike 1/3",
      acted: true,
    }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  assert.equal(
    model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 100),
    undefined,
    "PR #100's owning task W1-T50 is GitHub-confirmed merged — it must not render as a blocker",
  );
  const text = renderStatusBoardText(model);
  assert.doesNotMatch(text, /#100/);
});

test("buildStatusBoard: BLOCKERS BY CLASS — a blocked PR line naming NO owning task (sweep.ts's own 'SWEEP' fallback) is STILL dropped when its own PR NUMBER is one GitHub confirms merged", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "sweep.disposed",
      task_id: "SWEEP",
      pr_number: 200,
      pr_url: "https://x/200",
      disposition: "blocked-ambiguous",
      reason: "no owning task named",
      acted: false,
    }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  assert.equal(
    model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 200),
    undefined,
    "PR #200 is GitHub-confirmed merged (W1-T51's own `pr:` field) even though the ledger line names no owning task — it must still be dropped, matched by PR number",
  );
});

test("buildStatusBoard: BLOCKERS BY CLASS — a blocked PR whose owning task is GitHub-confirmed still OPEN remains a genuine blocker, so the live-merge check never over-suppresses", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "sweep.disposed",
      task_id: "W1-T52",
      pr_number: 300,
      pr_url: "https://x/300",
      disposition: "conflicted",
      reason: "merge conflict with main",
      acted: true,
    }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  const row = model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 300);
  assert.ok(row, "PR #300's owning task W1-T52 is still OPEN on GitHub — it must remain a listed blocker");
  if (row!.kind === "blocked_pr") {
    assert.equal(row!.taskId, "W1-T52");
    assert.equal(row!.disposition, "conflicted");
  }
  const text = renderStatusBoardText(model);
  assert.match(text, /#300/);
});

// ── design (2): "a PR that is merged OR CLOSED is NOT a blocker" — CLOSED (abandoned, never
// merged) is a DISTINCT GitHub state from MERGED, and design (3) additionally requires that
// `next action:` — computed FROM this very section — never gets pinned to that closed PR either,
// so a reader chasing "next action" is never sent after dead work. ─────────────────────────────

test("buildStatusBoard: BLOCKERS BY CLASS — a blocked PR whose owning task GitHub confirms CLOSED (abandoned, never merged) is dropped, and `next action:` is never computed from it", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "sweep.disposed",
      task_id: "W1-T53",
      pr_number: 400,
      pr_url: "https://x/400",
      disposition: "stale",
      reason: "no activity in 14 days",
      acted: true,
    }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  assert.equal(
    model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 400),
    undefined,
    "PR #400's owning task W1-T53 is GitHub-confirmed CLOSED (never merged) — closed is not merged, but design (2) drops it exactly the same",
  );
  // The ONLY ledgered signal here is the now-dropped closed PR — no circuit-broken, no
  // indeterminate, nothing else for `next action:` to name.
  assert.equal(
    model.blockers.nextAction,
    undefined,
    "with the closed PR dropped there is nothing left to compute a next action FROM — it must not fall back to naming #400 anyway",
  );
  const text = renderStatusBoardText(model);
  assert.doesNotMatch(text, /#400/);
  assert.doesNotMatch(text, /next action:.*400/);
});

// ── W1-T450: an EMPTY dispatch queue must stay silent about staleness even when the ledger's
// own run.start history is stale — "nothing dispatchable" is the honest idle state this task's
// stall rung is not, and reusing this file's already-live-GitHub board keeps that assertion
// exercised with the same reachable-gateway shape every test above already uses ──────────────────

test("buildStatusBoard: QUEUE HEAD — an empty candidate list never renders a stall, however old the ledger's own run.start history is", () => {
  const ledgerPath = writeLedger([
    ledgerLine({ step: "run.start", task_id: "SOME-TASK", run_id: "R1", ts: "2026-08-01T08:00:00.000Z" }),
    ledgerLine({ step: "run.start", task_id: "SOME-TASK", run_id: "R2", ts: "2026-08-01T08:05:00.000Z" }),
  ]);
  const emptyPlan = loadPlanFromYaml("[]\n", "fixture");

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: emptyPlan, github: fakeGithub() }));

  assert.deepEqual(model.queueHead.rows, []);
  assert.equal(model.queueHead.stall, undefined, "an empty queue must never render a stall, however stale run.start is");
  const text = renderStatusBoardText(model);
  assert.match(text, /nothing dispatchable/);
  assert.doesNotMatch(text, /STALL/);
});

test("buildStatusBoard: BLOCKERS BY CLASS — with a closed PR dropped, `next action:` still names a REMAINING genuine blocker, never silently going blank when there is real news", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "sweep.disposed",
      task_id: "W1-T53",
      pr_number: 400,
      pr_url: "https://x/400",
      disposition: "stale",
      reason: "no activity in 14 days",
      acted: true,
    }),
    ledgerLine({
      step: "sweep.disposed",
      task_id: "W1-T52",
      pr_number: 300,
      pr_url: "https://x/300",
      disposition: "conflicted",
      reason: "merge conflict with main",
      acted: true,
    }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  assert.equal(model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 400), undefined);
  assert.ok(model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 300));
  assert.match(model.blockers.nextAction ?? "", /#300/);
  assert.doesNotMatch(model.blockers.nextAction ?? "", /#400/);
});

// ── design (4), DEGRADE HONESTLY: when live merge state cannot be read at all this cycle (the
// GitHub gateway is unreachable), the section must say it is UNVERIFIED rather than falling back
// to printing the raw `sweep.disposed` ledger replay as if it were still current news. ──────────

test("buildStatusBoard: BLOCKERS BY CLASS — GitHub gateway unreachable ⇒ blocked-PR entries are withheld as UNVERIFIED, never replayed from the ledger as if still current", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "sweep.disposed",
      task_id: "W1-T54",
      pr_number: 500,
      pr_url: "https://x/500",
      disposition: "blocked-fixable",
      reason: "required checks red",
      acted: true,
    }),
  ]);
  const unreachable = fakeGithub({ readFailed: () => true, readFailureReason: () => "transport" });

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: unreachable }));

  assert.equal(
    model.blockers.rows.find((r) => r.kind === "blocked_pr"),
    undefined,
    "the ledger's blocked-fixable disposition for PR #500 must NOT be printed while its live merge state cannot be checked",
  );
  assert.match(model.blockers.blockedPrsUnverifiedReason ?? "", /transport/);
  assert.match(model.blockers.nextAction ?? "", /unverified/i);
  const text = renderStatusBoardText(model);
  assert.doesNotMatch(text, /#500 .*\[blocked-fixable\]/);
  assert.match(text, /unverified/i);
});

test("buildStatusBoard: BLOCKERS BY CLASS — GitHub gateway unreachable but the ledger holds NO blocked-PR candidates at all ⇒ no unverified noise, nothing to withhold", () => {
  const ledgerPath = writeLedger([]);
  const unreachable = fakeGithub({ readFailed: () => true, readFailureReason: () => "transport" });

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: unreachable }));

  assert.equal(model.blockers.blockedPrsUnverifiedReason, undefined);
  assert.deepEqual(
    model.blockers.rows.filter((r) => r.kind === "blocked_pr"),
    [],
  );
});

// ── W1-T309: W1-T306 merged with PASS 3/3, yet `rmd status` in production kept printing FIVE
// closed/merged PRs as current blockers. Every W1-T306 test above hands `deriveBlockedPrBlockers`
// a PR number that IS the owning task's own single, current PR (its lone `pr:` field, or its
// only-ever `pr.opened` line) — so the batched per-TASK projection it matched against always
// happened to carry that exact PR number. Production tasks are frequently REDISPATCHED (P29(ii)'s
// own "resets only on a fresh owned PR" streak breaker): a task's FIRST PR gets disposed
// blocked-fixable by sweep, the daemon redispatches, and a SECOND PR opens. status.ts's
// `lastPrOpened` is "last one wins" (deriveStatus rung (a)) — so once the SECOND PR opens, the
// task's projection resolves ONLY against it; the FIRST PR's number never appears in any
// projection's own `prNumber`, so `settledPrNumbers` can never learn it later merged or closed,
// no matter what GitHub says NOW. This is the seam #1214's tests never reached. ─────────────────

const REDISPATCH_PRS: Record<number, PrRef> = {
  600: { number: 600, url: "https://x/600", state: "CLOSED" }, // FIRST attempt — abandoned once redispatched
  601: { number: 601, url: "https://x/601", state: "OPEN" }, // SECOND (current) attempt — genuinely still open
};

function redispatchGithub(overrides: Partial<GitHub> = {}): GitHub {
  return {
    // Mirrors buildBatchedGithub's own lookup: matches a bare number OR a URL ending `/<number>`.
    prByRef: (ref) => {
      const n = typeof ref === "number" ? ref : Number(String(ref).replace(/^.*\/(\d+)$/, "$1"));
      return REDISPATCH_PRS[n] ?? null;
    },
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    ...overrides,
  };
}

test("buildStatusBoard: BLOCKERS BY CLASS — a task's FIRST (now GitHub-confirmed CLOSED) PR is dropped even though the task has since redispatched a SECOND, still-open PR", () => {
  const ledgerPath = writeLedger([
    ledgerLine({ step: "pr.opened", task_id: "W1-T60", pr_url: "https://x/600" }),
    ledgerLine({
      step: "sweep.disposed",
      task_id: "W1-T60",
      pr_number: 600,
      pr_url: "https://x/600",
      disposition: "blocked-fixable",
      reason: "required checks red — ci-log fix, strike 1/3",
      acted: true,
    }),
    // The redispatch: a NEW pr.opened line supersedes the first for `lastPrOpened`'s "last one
    // wins" scan — the task's own projection now resolves against #601, never #600 again.
    ledgerLine({ step: "pr.opened", task_id: "W1-T60", pr_url: "https://x/601" }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: redispatchGithub() }));

  assert.equal(
    model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 600),
    undefined,
    "PR #600 is GitHub-confirmed CLOSED right now — it must not render as a blocker just because " +
      "the owning task's CURRENT pr.opened line points at a different (later) PR",
  );
  assert.equal(model.blockers.blockedPrsUnverifiedReason, undefined, "GitHub was reachable — nothing withheld as unverified");
  const text = renderStatusBoardText(model);
  assert.doesNotMatch(text, /#600/);
});
