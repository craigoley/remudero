/**
 * W1-T14865 — a red required check on an open ops-catalog pull request reaches the operator inbox within an hour.
 *
 * The fleet's lanes read only the product repositories, so a red required check on an ops catalog pull request went
 * unnoticed. `watchOpsPullRequests` lists the ops catalog's open pull requests and escalates each whose required check
 * failed at least an hour ago on its current head, once per (pull request, head).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { OPS_PR_RED_STALLED_STEP, OPS_PR_WATCH_UNREADABLE_STEP, firstErrorLine, watchOpsPullRequests } from "#src/lib/ops-pr-watch.js";
import type { Escalation } from "#src/lib/escalate.js";

const REPO = "acme/remudero-ops";
const NOW = Date.parse("2026-11-25T18:20:00Z");
const HEAD = "0b39d308c0000000000000000000000000000000";

/** A GET-only api over one open pull request whose ops-gate job concluded failure at `failedAt`. */
function api(failedAt: string, head = HEAD, calls: string[] = []) {
  return async (path: string): Promise<unknown> => {
    calls.push(path);
    if (path.startsWith(`repos/${REPO}/pulls`)) return [{ number: 748, html_url: `https://github.com/${REPO}/pull/748`, head: { sha: head } }];
    if (path.endsWith("/protection/required_status_checks")) return { contexts: ["shadow-registry", "ops-gate", "remudero-review"] };
    if (path.startsWith(`repos/${REPO}/actions/runs?head_sha=`)) return { workflow_runs: [{ id: 11, conclusion: "failure" }, { id: 12, conclusion: "success" }] };
    if (path === `repos/${REPO}/actions/runs/11/jobs?per_page=100`) return { jobs: [{ id: 21, name: "ops-gate", conclusion: "failure", completed_at: failedAt }] };
    if (path === `repos/${REPO}/actions/jobs/21/logs`) return "2026-11-24T22:16:40.0Z ##[error]core-lint: superseded_by unknown task\n";
    throw new Error(`unexpected path ${path}`);
  };
}

async function watch(failedAt: string, ledgerLines: string[] = [], head = HEAD) {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const escalations: Escalation[] = [];
  const result = await watchOpsPullRequests({ repository: REPO, api: api(failedAt, head), nowMs: NOW, ledgerLines,
    log: (step, extra) => rows.push({ step, extra }), escalate: (e) => { escalations.push(e); return "https://github.com/acme/remudero/issues/9"; } });
  return { result, rows, escalations };
}

test("W1-T14865 criterion 1: a required check that failed over an hour ago on an unchanged head is escalated once", async () => {
  const { rows, escalations } = await watch("2026-11-24T22:16:41Z");
  assert.equal(escalations.length, 1, "one operator escalation");
  assert.match(escalations[0]!.summary, /#748: required check ops-gate/);
  assert.equal(escalations[0]!.headSha, HEAD);
  const red = rows.filter((r) => r.step === OPS_PR_RED_STALLED_STEP);
  assert.equal(red.length, 1);
  assert.equal(red[0]!.extra.pr_number, 748);
  assert.equal(red[0]!.extra.check, "ops-gate");
  assert.equal(red[0]!.extra.first_error_line, "core-lint: superseded_by unknown task");
});

test("W1-T14865 criterion 2: invariant:once-per-head — a second tick on the same head writes no second escalation", async () => {
  const first = await watch("2026-11-24T22:16:41Z");
  const ledger = first.rows.map((r) => JSON.stringify({ step: r.step, ...r.extra }));
  const second = await watch("2026-11-24T22:16:41Z", ledger);
  assert.equal(second.escalations.length, 0, "the same head is not escalated twice");
  assert.equal(second.rows.filter((r) => r.step === OPS_PR_RED_STALLED_STEP).length, 0);
  const pushed = await watch("2026-11-24T22:16:41Z", ledger, "1111111110000000000000000000000000000000");
  assert.equal(pushed.escalations.length, 1, "a new head is its own escalation");
});

test("W1-T14865 criterion 3: a check that failed under an hour ago, or a pull request pushed since, is not escalated", async () => {
  const recent = await watch("2026-11-25T17:40:00Z");
  assert.equal(recent.escalations.length, 0, "40 minutes red is not yet stalled");
  assert.equal(recent.rows.length, 0);
  // A push moves the head; the failure on the old head is not on the head the pull request now has.
  const calls: string[] = [];
  const fresh = await watchOpsPullRequests({ repository: REPO, nowMs: NOW, ledgerLines: [], log: () => {},
    api: async (path) => {
      calls.push(path);
      if (path.startsWith(`repos/${REPO}/actions/runs?head_sha=`)) return { workflow_runs: [] };
      return api("2026-11-24T22:16:41Z", "2222222220000000000000000000000000000000")(path);
    } });
  assert.equal(fresh.escalated.length, 0, "the new head has no failed run yet");
});

test("W1-T14865: an unreadable pull request list writes one unreadable row and never escalates", async () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let escalated = 0;
  const failing = async () => { throw new Error("HTTP 502"); };
  const first = await watchOpsPullRequests({ repository: REPO, api: failing, nowMs: NOW, ledgerLines: [],
    log: (step, extra) => rows.push({ step, extra }), escalate: () => { escalated++; } });
  assert.equal(first.unreadable, "HTTP 502");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step, OPS_PR_WATCH_UNREADABLE_STEP);
  const again = await watchOpsPullRequests({ repository: REPO, api: failing, nowMs: NOW,
    ledgerLines: [JSON.stringify({ step: OPS_PR_WATCH_UNREADABLE_STEP, ...rows[0]!.extra })], log: (step, extra) => rows.push({ step, extra }) });
  assert.equal(again.unreadable, "HTTP 502");
  assert.equal(rows.length, 1, "an unchanged failure is not re-written");
  assert.equal(escalated, 0);
  assert.equal(firstErrorLine({ not: "text" }), undefined);
});

test("W1-T14865: without branch protection every failed job counts as required", async () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const base = api("2026-11-24T22:16:41Z");
  await watchOpsPullRequests({ repository: REPO, nowMs: NOW, ledgerLines: [], log: (step, extra) => rows.push({ step, extra }),
    api: async (path) => { if (path.endsWith("/protection/required_status_checks")) throw new Error("HTTP 403"); return base(path); } });
  const red = rows.filter((r) => r.step === OPS_PR_RED_STALLED_STEP);
  assert.equal(red.length, 1);
  assert.equal(red[0]!.extra.required_source, "every_job");
});

test("W1-T14865: the daemon tick reads at most once per interval and never while a read is in flight", async () => {
  const { opsPullRequestWatchTick, OPS_PR_WATCH_EVERY_MS } = await import("#src/lib/ops-pr-watch.js");
  let now = NOW;
  let runs = 0;
  let release: () => void = () => {};
  const rows: string[] = [];
  const tick = opsPullRequestWatchTick({ repository: () => REPO, api: api("2026-11-24T22:16:41Z") },
    { clock: { now: () => now }, ledgerLines: () => [], log: (step) => rows.push(step),
      run: () => { runs++; return new Promise((resolve) => { release = () => resolve({ escalated: [] }); }); } });
  const first = tick();
  assert.ok(first, "the first tick starts a read");
  assert.equal(tick(), undefined, "a read in flight is not started again");
  release(); await first;
  now += OPS_PR_WATCH_EVERY_MS - 1;
  assert.equal(tick(), undefined, "within the interval nothing starts");
  now += 1;
  const second = tick(); assert.ok(second); release(); await second;
  assert.equal(runs, 2);
  const thrown = opsPullRequestWatchTick({ repository: () => REPO, api: api("x") },
    { clock: { now: () => now }, ledgerLines: () => [], log: (step) => rows.push(step), run: async () => { throw new Error("boom"); } });
  await thrown();
  assert.deepEqual(rows, [OPS_PR_WATCH_UNREADABLE_STEP], "a thrown read writes one unreadable row");
  assert.equal(opsPullRequestWatchTick(undefined, { clock: { now: () => now }, ledgerLines: () => [], log: () => {}, run: async () => ({ escalated: [] }) })(), undefined);
  assert.equal(opsPullRequestWatchTick({ repository: () => undefined, api: api("x") },
    { clock: { now: () => now }, ledgerLines: () => [], log: () => {}, run: async () => ({ escalated: [] }) })(), undefined, "no repository yet, no read");
});

test("W1-T14865: the daemon hands the watch only its own rows from the ledger", async () => {
  const { isOpsPullRequestWatchRow } = await import("#src/lib/daemon.js");
  assert.equal(isOpsPullRequestWatchRow(JSON.stringify({ step: OPS_PR_RED_STALLED_STEP, pr_number: 748 })), true);
  assert.equal(isOpsPullRequestWatchRow(JSON.stringify({ step: OPS_PR_WATCH_UNREADABLE_STEP })), true);
  assert.equal(isOpsPullRequestWatchRow(JSON.stringify({ step: "ops_pr.other" })), false);
  assert.equal(isOpsPullRequestWatchRow(JSON.stringify({ step: "fix.dispatch" })), false);
  assert.equal(isOpsPullRequestWatchRow("{\"step\":\"ops_pr.red_stalled\""), false, "a torn line is skipped");
});
