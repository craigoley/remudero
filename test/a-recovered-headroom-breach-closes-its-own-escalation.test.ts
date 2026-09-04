import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, Task } from "../src/lib/plan.js";
import { buildBatchedGithub } from "../src/lib/status.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import {
  escalateHeadroomReserve,
  buildHeadroomRecoveryCandidates,
  retireRecoveredHeadroomEscalations,
  renderHeadroomRecoveryCloseComment,
  buildEscalationReconcileCandidates,
  sweepEscalationReconcile,
} from "../src/run-task.js";
import { runEscalationReconcile, type EscalationReconcileCandidate } from "../src/lib/sweep.js";

/**
 * W1-T2603 — A RECOVERED HEADROOM BREACH NEVER CLOSES ITS OWN ESCALATION.
 *
 * `escalateHeadroomReserve` raises one `[HARD_STOP]` issue per breach episode and nothing ever
 * retired it: the breach is a property of the ACCOUNT (`daemon.headroom` window readings), not of
 * any plan task, so it carries no `**Task:**` referent `buildEscalationReconcileCandidates` could
 * resolve — MEASURED live as three identical open issues (#3334/#3384/#3483) against a window that
 * had read `over_ceiling: false` for days, one already annotated stale by an operator and still
 * open. These tests prove the new retirement path this task adds (`buildHeadroomRecoveryCandidates`
 * / `retireRecoveredHeadroomEscalations`), one per acceptance claim, and that the pre-existing
 * task-referent reconciler is untouched.
 */

function ledgerPath(): string {
  const p = join(mkdtempSync(join(tmpdir(), "rmd-headroom-recovery-")), "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

/** Hand-append one raw ledger line with an EXPLICIT `ts` — mirrors headroom-park-ceiling.test.ts's
 *  own fixture idiom, so recovery-vs-escalation ordering is controlled by the test, never by the
 *  real clock (two `appendLedger` calls in the same test can land in the same millisecond). */
function appendRaw(path: string, line: Record<string, unknown>): void {
  appendFileSync(path, JSON.stringify({ host: "test", ...line }) + "\n");
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Escalate a breach for `window`, returning the issue url + the escalation row's own `ts`, so a
 *  test can plant recovery readings strictly after it without depending on the real clock. */
function seedEscalation(
  path: string,
  window: string,
  resetsAt: string,
): { issueUrl: string; escalatedTs: string } {
  // Deterministic per-test-run issue url (derived from window+resetsAt, never random) so
  // assertions can name it without threading a return value through a mutable closure.
  let url = "";
  const issues = {
    create: () => {
      url = `https://github.com/o/r/issues/${window.replace(/[^a-z0-9]/gi, "")}-${resetsAt.replace(/[^a-z0-9]/gi, "")}`;
      return url;
    },
  };
  escalateHeadroomReserve(
    { window, percentUsed: 100, limitPct: 95, resetsAt },
    { owner: "o", repo: "r", ledgerPath: path, runId: "RUN-ESCALATE", issues: issues as never },
  );
  const marker = readLines(path).find((l) => l.step === "daemon.headroom_reserve.escalated");
  assert.ok(marker, "escalateHeadroomReserve must have written its dedup marker");
  return { issueUrl: url, escalatedTs: marker!.ts as string };
}

function openIssueGateway(urls: string[], closed: Array<{ url: string; comment: string }>): IssueGateway {
  return {
    create: () => "",
    listOpen: (): OpenIssue[] => urls.map((url, i) => ({ number: i + 1, url, body: `**Task:** daemon\n` })),
    closeWithComment: (url: string, comment: string) => void closed.push({ url, comment }),
  };
}

// ── claim 1: an open headroom escalation is retired once a reading for the SAME window recovers ──

test("claim 1: a recovery reading for the SAME window, newer than the breach, retires the open escalation", async () => {
  const path = ledgerPath();
  const { issueUrl, escalatedTs } = seedEscalation(path, "weekly (all models)", "2026-09-06 at 12am");

  // The recovery: a positive `daemon.headroom` reading for the SAME window, strictly newer than
  // the escalation, at `over_ceiling: false` — exactly what the daemon's own poll loop writes.
  appendRaw(path, {
    ts: new Date(Date.parse(escalatedTs) + 60_000).toISOString(),
    run_id: "RUN-POLL",
    task_id: "DAEMON",
    step: "daemon.headroom",
    window: "weekly (all models)",
    percent_used: 11,
    limit_pct: 95,
    resets_at: "2026-09-06 at 12am",
    over_ceiling: false,
  });

  const closed: Array<{ url: string; comment: string }> = [];
  const issues = openIssueGateway([issueUrl], closed);
  const result = await retireRecoveredHeadroomEscalations(path, "RUN-RETIRE", { issues });

  assert.equal(result.retired, 1, "the recovered escalation is retired");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].url, issueUrl);
  assert.match(closed[0].comment, /weekly \(all models\)/, "the citation names the recovered window");
  assert.match(closed[0].comment, /11% used/, "and the recovery reading's own percentage");

  const retiredMarker = readLines(path).find((l) => l.step === "daemon.headroom_reserve.retired");
  assert.ok(retiredMarker, "a durable retirement marker is ledgered, mirroring sweep.escalation_closed");
  assert.equal(retiredMarker!.issue_url, issueUrl);
  assert.equal(retiredMarker!.window, "weekly (all models)");
});

test("claim 1 (pure builder): buildHeadroomRecoveryCandidates surfaces the SAME candidate the runner acted on", () => {
  const path = ledgerPath();
  const { issueUrl, escalatedTs } = seedEscalation(path, "session (5h)", "2026-09-02T18:00:00.000Z");
  appendRaw(path, {
    ts: new Date(Date.parse(escalatedTs) + 5_000).toISOString(),
    step: "daemon.headroom",
    window: "session (5h)",
    percent_used: 3,
    limit_pct: 95,
    over_ceiling: false,
  });
  const candidates = buildHeadroomRecoveryCandidates(path, new Set([issueUrl]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].issueUrl, issueUrl);
  assert.equal(candidates[0].window, "session (5h)");
  assert.equal(candidates[0].recovery.percentUsed, 3);
  assert.match(renderHeadroomRecoveryCloseComment(candidates[0]), /session \(5h\)/);
});

test("claim 1: an issue not present in the caller's own open-issue read is left alone (already closed, or never delivered)", () => {
  const path = ledgerPath();
  const { escalatedTs } = seedEscalation(path, "weekly (all models)", "2026-09-06 at 12am");
  appendRaw(path, {
    ts: new Date(Date.parse(escalatedTs) + 1_000).toISOString(),
    step: "daemon.headroom",
    window: "weekly (all models)",
    percent_used: 5,
    over_ceiling: false,
  });
  // openIssueUrls is EMPTY — the same issue is not currently open per the caller's own read.
  const candidates = buildHeadroomRecoveryCandidates(path, new Set());
  assert.deepEqual(candidates, [], "no candidate for an issue the caller did not see open");
});

// ── claim 2: a recovery in one window never retires an escalation raised for a DIFFERENT window ──

test("claim 2: a session-window recovery does NOT retire a weekly-window escalation", async () => {
  const path = ledgerPath();
  const { issueUrl, escalatedTs } = seedEscalation(path, "weekly (all models)", "2026-09-06 at 12am");

  // A DIFFERENT window recovers — session (5h), not weekly. The weekly breach itself never clears.
  appendRaw(path, {
    ts: new Date(Date.parse(escalatedTs) + 60_000).toISOString(),
    step: "daemon.headroom",
    window: "session (5h)",
    percent_used: 2,
    limit_pct: 95,
    over_ceiling: false,
  });

  const closed: Array<{ url: string; comment: string }> = [];
  const issues = openIssueGateway([issueUrl], closed);
  const result = await retireRecoveredHeadroomEscalations(path, "RUN-RETIRE", { issues });

  assert.equal(result.retired, 0, "a different window's recovery must not retire this escalation");
  assert.deepEqual(closed, []);
  assert.deepEqual(buildHeadroomRecoveryCandidates(path, new Set([issueUrl])), []);
});

test("claim 2: a weekly-window recovery does NOT retire a session-window escalation raised at the same time", async () => {
  const path = ledgerPath();
  const { issueUrl, escalatedTs } = seedEscalation(path, "session (5h)", "2026-09-02T18:00:00.000Z");
  appendRaw(path, {
    ts: new Date(Date.parse(escalatedTs) + 60_000).toISOString(),
    step: "daemon.headroom",
    window: "weekly (all models)",
    percent_used: 11,
    over_ceiling: false,
  });
  const closed: Array<{ url: string; comment: string }> = [];
  const issues = openIssueGateway([issueUrl], closed);
  const result = await retireRecoveredHeadroomEscalations(path, "RUN-RETIRE", { issues });
  assert.equal(result.retired, 0);
  assert.deepEqual(closed, []);
});

// ── claim 3: an ABSENCE of breach readings is never read as recovery — a blind governor retires nothing ──

test("claim 3: no daemon.headroom rows at all since the escalation — a blind governor retires nothing", async () => {
  const path = ledgerPath();
  const { issueUrl } = seedEscalation(path, "weekly (all models)", "2026-09-06 at 12am");
  // No daemon.headroom rows appended at all — simulates the W1-T2565 blind window, up to six hours
  // where the daemon never reads headroom, while the account may still be exhausted.
  const closed: Array<{ url: string; comment: string }> = [];
  const issues = openIssueGateway([issueUrl], closed);
  const result = await retireRecoveredHeadroomEscalations(path, "RUN-RETIRE", { issues });
  assert.equal(result.retired, 0, "absence of readings must never be read as recovery");
  assert.deepEqual(closed, []);
});

test("claim 3: a daemon.headroom row for the SAME window BUT OLDER than the escalation is not evidence of recovery", async () => {
  const path = ledgerPath();
  // A reading BEFORE the breach even fired (naturally under ceiling before the account was
  // exhausted) must never be read as evidence the LATER breach has since cleared.
  const preBreachReadingTs = "2026-08-29T00:00:00.000Z";
  appendRaw(path, {
    ts: preBreachReadingTs,
    step: "daemon.headroom",
    window: "weekly (all models)",
    percent_used: 10,
    over_ceiling: false,
  });
  const { issueUrl } = seedEscalation(path, "weekly (all models)", "2026-09-06 at 12am");
  const closed: Array<{ url: string; comment: string }> = [];
  const issues = openIssueGateway([issueUrl], closed);
  const result = await retireRecoveredHeadroomEscalations(path, "RUN-RETIRE", { issues });
  assert.equal(result.retired, 0, "a stale pre-breach reading must never retire a later escalation");
  assert.deepEqual(closed, []);
});

test("claim 3: only-still-breaching readings since the escalation (over_ceiling: true) retire nothing", async () => {
  const path = ledgerPath();
  const { issueUrl, escalatedTs } = seedEscalation(path, "weekly (all models)", "2026-09-06 at 12am");
  appendRaw(path, {
    ts: new Date(Date.parse(escalatedTs) + 30_000).toISOString(),
    step: "daemon.headroom",
    window: "weekly (all models)",
    percent_used: 99,
    over_ceiling: true,
  });
  const closed: Array<{ url: string; comment: string }> = [];
  const issues = openIssueGateway([issueUrl], closed);
  const result = await retireRecoveredHeadroomEscalations(path, "RUN-RETIRE", { issues });
  assert.equal(result.retired, 0, "a still-breaching reading is not a recovery");
  assert.deepEqual(closed, []);
});

// ── claim 4: the task-referent reconciler's own arm is unchanged ──────────────────────────────

function reconPlan(taskId: string): Plan {
  const t = {
    id: taskId, title: taskId, repo: "remudero", depends_on: [], type: "implement",
    verify: "auto", risk: "medium", status: "queued", attempts: 0, origin: "architect", acceptance: [],
  } as unknown as Task;
  return { tasks: [t], byId: new Map([[taskId, t]]) };
}

test("claim 4: buildEscalationReconcileCandidates still resolves a TASK-referent issue exactly as before — a merged task's escalation becomes a candidate carrying its resolver", () => {
  const path = ledgerPath();
  const issues: IssueGateway = {
    create: () => "",
    listOpen: () => [
      { number: 44, url: "https://github.com/o/r/issues/44", title: "[BLOCKED] W1-T189", body: "**Class:** BLOCKED\n**Task:** W1-T189\n\ndetail" },
    ],
  };
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => [
      { number: 574, url: "https://github.com/o/r/pull/574", state: "MERGED", headRefName: "run-W1-T189-1784000000000", body: "Remudero-Task: W1-T189\n" },
    ],
  });
  const cands = buildEscalationReconcileCandidates("o", "r", reconPlan("W1-T189"), path, undefined, { issues, github });
  assert.equal(cands.length, 1, "the task-referent arm still builds exactly one candidate");
  assert.equal(cands[0].taskId, "W1-T189");
  assert.equal(cands[0].derived.merged, true);
  assert.equal(cands[0].derived.prNumber, 574);
});

test("claim 4: a headroom-breach issue (taskId 'daemon', no plan entry, no PR referent) is still DROPPED by the task-referent arm — the gap this task exists to close, unchanged in that arm", () => {
  const path = ledgerPath();
  const logs: string[] = [];
  const issues: IssueGateway = {
    create: () => "",
    listOpen: () => [
      { number: 90, url: "https://github.com/o/r/issues/90", title: "[HARD_STOP] daemon: weekly headroom reserve reached", body: "**Class:** HARD_STOP\n**Task:** daemon\n\ndetail, no PR anywhere" },
    ],
  };
  const github = buildBatchedGithub("o", "r", { fetchAll: () => [] });
  const cands = buildEscalationReconcileCandidates("o", "r", { tasks: [], byId: new Map() }, path, (s) => logs.push(s), { issues, github });
  assert.equal(cands.length, 0, "no plan task and no PR referent — the task-referent arm builds nothing for it");
});

test("claim 4 end-to-end: sweepEscalationReconcile closes a resolved TASK-referent issue via the OLD path AND retires a recovered headroom issue via the NEW path, in the same pass", async () => {
  const path = ledgerPath();
  const { issueUrl: headroomIssueUrl, escalatedTs } = seedEscalation(path, "weekly (all models)", "2026-09-06 at 12am");
  appendRaw(path, {
    ts: new Date(Date.parse(escalatedTs) + 60_000).toISOString(),
    step: "daemon.headroom",
    window: "weekly (all models)",
    percent_used: 11,
    over_ceiling: false,
  });

  const taskIssueUrl = "https://github.com/o/r/issues/44";
  const closed: Array<{ url: string; comment: string }> = [];
  const issues: IssueGateway = {
    create: () => "",
    listOpen: () => [
      { number: 44, url: taskIssueUrl, title: "[BLOCKED] W1-T189", body: "**Class:** BLOCKED\n**Task:** W1-T189\n\ndetail" },
      { number: 90, url: headroomIssueUrl, title: "[HARD_STOP] daemon: weekly headroom reserve reached", body: "**Class:** HARD_STOP\n**Task:** daemon\n\ndetail" },
    ],
    closeWithComment: (url, comment) => void closed.push({ url, comment }),
  };
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => [
      { number: 574, url: "https://github.com/o/r/pull/574", state: "MERGED", headRefName: "run-W1-T189-1784000000000", body: "Remudero-Task: W1-T189\n" },
    ],
  });

  const summary = await sweepEscalationReconcile("o", "r", reconPlan("W1-T189"), path, "SWEEP-1", () => {}, { issues, github });

  // The task-referent arm's own summary is UNCHANGED: it still sees and closes exactly the one
  // candidate it always did (the headroom issue never becomes ITS candidate — no referent).
  assert.equal(summary.total, 1, "the task-referent arm's candidate count is exactly what it always was");
  assert.equal(summary.closed, 1);

  const taskClose = closed.find((c) => c.url === taskIssueUrl);
  const headroomClose = closed.find((c) => c.url === headroomIssueUrl);
  assert.ok(taskClose, "the task-referent issue closed via the pre-existing path");
  assert.match(taskClose!.comment, /#574/, "citing the merged PR, exactly as before");
  assert.ok(headroomClose, "the headroom-breach issue ALSO closed, via the new W1-T2603 path");
  assert.match(headroomClose!.comment, /weekly \(all models\)/, "citing the recovered window, not a PR");
});

test("claim 4 falsifier: runEscalationReconcile alone (no sweepEscalationReconcile wrapper) still leaves a headroom issue untouched — the task-referent reconciler never gained a headroom-closing branch", async () => {
  const path = ledgerPath();
  const issues: IssueGateway = {
    create: () => "",
    listOpen: () => [
      { number: 90, url: "https://github.com/o/r/issues/90", title: "[HARD_STOP] daemon: weekly headroom reserve reached", body: "**Class:** HARD_STOP\n**Task:** daemon\n\ndetail" },
    ],
  };
  const github = buildBatchedGithub("o", "r", { fetchAll: () => [] });
  const candidates = buildEscalationReconcileCandidates("o", "r", { tasks: [], byId: new Map() }, path, undefined, { issues, github });
  const closes: string[] = [];
  const summary = await runEscalationReconcile(candidates as EscalationReconcileCandidate[], {
    closeIssue: (url) => void closes.push(url),
    ledgerPath: path,
    runId: "TEST",
    log: () => {},
  });
  assert.equal(candidates.length, 0, "the task-referent builder still drops it (no referent), unchanged");
  assert.equal(summary.total, 0);
  assert.deepEqual(closes, [], "runEscalationReconcile in isolation never closes a headroom issue — that is the new rung's job");
});
