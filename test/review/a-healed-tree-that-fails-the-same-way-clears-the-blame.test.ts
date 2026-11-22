/**
 * W1-T13902 — A HEALED TREE THAT FAILS THE SAME WAY CLEARS THE BLAME. A reviewer-regression incident
 * keeps every review on a healed tree (origin/main with the blamed merge reverted) until the current
 * reviewer returns to baseline. When the cause is not the blamed merge, main never returns, and the
 * healed reviews fail as often as the regressed code did: the healed evidence itself says the blame is
 * wrong. INVARIANT healing-keeps-its-incident: only sufficient healed evidence that is not better than
 * the regressed evidence clears it. Every effect is an injected fake; git is a recording stub.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as health from "#src/lib/reviewer-health.js";
import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import type { MainRepairLane } from "#src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const REPO_URL = "https://github.com/acme/remudero/pull";
const fake = (seed: string): string => createHash("sha1").update(seed).digest("hex");
let clock = Date.parse("2026-11-16T00:00:00.000Z");
const tick = (): string => new Date((clock += 1000)).toISOString();
type Row = Record<string, unknown>;
const unit = (pr: number) => ({ pr_url: `${REPO_URL}/${pr}`, head_sha: fake(`head-${pr}`) });
const healedFields = (incident?: string) => (incident === undefined ? {} : { incident_id: incident });
const posted = (sha: string, pr: number, incident?: string): Row =>
  ({ ts: tick(), host: "core", step: "review.posted", state: "success", plan_only: false, reviewer_code_sha: sha, ...unit(pr), ...healedFields(incident) });
const refused = (sha: string, pr: number, incident?: string): Row =>
  ({ ts: tick(), host: "core", step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable", reviewer_code_sha: sha,
    ...unit(pr), ...healedFields(incident) });

const HEALTHY = fake("healthy");
const REGRESSED = fake("regressed");
const MAIN = fake("main-after");
const HEALED = fake("healed-tree");

/** git over a two-commit history: HEALTHY..REGRESSED is one review-material merge, which is blamed. */
const git: health.GitText = async (args) => {
  if (args[0] === "merge-base") return "";
  if (args[0] === "rev-list") return `${REGRESSED}\n`;
  if (args[0] === "diff") return "src/lib/review.ts\n";
  if (args[0] === "log") return "fix(review): the blamed merge (#500)\n";
  throw new Error(`git ${args.join(" ")} is not in this fixture`);
};

function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}blame-cleared-`));
  t.after(() => execFileSync("rm", ["-rf", dir]));
  const statePath = join(dir, "reviewer-health.json");
  const queue: Row[] = [];
  const logs: Array<{ step: string; extra: Row }> = [];
  const closedIssues: Array<{ url: string; comment: string }> = [];
  const closedPrs: Array<{ url: string; comment: string }> = [];
  const issues: AsyncIssueGateway = {
    create: async () => "https://github.com/acme/remudero/issues/1",
    listOpen: async () => [],
    ensureLabel: async () => true,
    comment: async () => undefined,
    closeWithComment: async (url, comment) => { closedIssues.push({ url, comment }); },
  };
  const lane: MainRepairLane = {
    openFixPr: async () => { throw new Error("a reviewer regression opens no fix PR"); },
    openRevertPr: async () => ({ prUrl: `${REPO_URL}/900` }),
    readPr: async () => ({ state: "open" as const }),
    closePr: async (url, comment) => { closedPrs.push({ url, comment }); },
  };
  const escalation = { issues, ledgerPath: join(dir, "ledger.ndjson"), runId: "blame-cleared-test" };
  const evaluate = (originMainSha: string | null) => health.evaluateReviewerHealthNow({ originMainSha }, statePath,
    async () => ({ rows: queue.splice(0), cursor: { liveOffset: 0 } }), git, escalation, lane,
    (step, extra = {}) => { logs.push({ step, extra }); }, { iso: () => new Date(clock).toISOString() });
  return { queue, logs, closedIssues, closedPrs, statePath, evaluate, steps: (step: string) => logs.filter((l) => l.step === step) };
}

/** A clean baseline, then the onset at REGRESSED, then main moving on while it keeps failing the same way. */
async function openIncident(t: TestContext) {
  const h = harness(t);
  let pr = 1;
  for (let i = 0; i < 20; i++) for (let j = 0; j < 10; j++) h.queue.push(posted(fake(`baseline-${i}`), pr++));
  for (let j = 0; j < 10; j++) h.queue.push(posted(HEALTHY, pr++));
  await h.evaluate(HEALTHY);
  h.queue.push(refused(REGRESSED, 301), refused(REGRESSED, 302), refused(REGRESSED, 303), refused(REGRESSED, 304));
  const opened = await h.evaluate(REGRESSED);
  assert.equal(opened.route, "healed", "the incident opened and blames a merge");
  const incident = health.loadReviewerHealthState(h.statePath).incident!;
  assert.equal(incident.offending?.sha, REGRESSED);
  // Main moves on and still fails, about half the time: returnedToBaseline can never close this.
  for (let j = 0; j < 20; j++) h.queue.push(j % 2 === 0 ? refused(MAIN, 400 + j) : posted(MAIN, 400 + j));
  await h.evaluate(MAIN);
  assert.equal(health.loadReviewerHealthState(h.statePath).incident?.id, incident.id, "main's own failures keep it open");
  return { h, incident };
}

test("W1-T13902 criterion 1: healed reviews that fail no less often than the regressed shas close the incident and write reviewer.regression_blame_cleared", async (t) => {
  const { h, incident } = await openIncident(t);
  assert.equal(h.steps("reviewer.regression_blame_cleared").length, 0, "no healed evidence yet: still open");
  // The healed tree's reviews fail as often as main's: reverting the blamed merge did not help.
  for (let j = 0; j < 60; j++) h.queue.push(j % 2 === 0 ? refused(HEALED, 500 + j, incident.id) : posted(HEALED, 500 + j, incident.id));
  const decision = await h.evaluate(MAIN);
  const state = health.loadReviewerHealthState(h.statePath);
  assert.equal(state.incident, null, "the incident closed");
  assert.equal(decision.route, "normal", "reviews leave the healed tree");
  const cleared = h.steps("reviewer.regression_blame_cleared");
  assert.equal(cleared.length, 1);
  const row = cleared[0]!.extra;
  assert.equal(row.incident_id, incident.id);
  assert.equal(row.offending_sha, REGRESSED, "it names the offending sha whose blame is cleared");
  assert.equal(row.healed_k, 30);
  assert.equal(row.healed_n, 60);
  assert.equal(row.regressed_k, 14, "the regressed pool is the onset sha and main's regressed sha");
  assert.equal(row.regressed_n, 24);
  const closedRow = h.steps("reviewer.regression_closed");
  assert.equal(closedRow.length, 1, "it closes through the ordinary close");
  const record = state.closed.find((c) => c.id === incident.id)!;
  assert.equal(record.closedReason, "blame-cleared", "a distinct reason on the closed record");
  assert.ok(record.signature.includes("head-task-metadata-unavailable"), "the closed record keeps its signature");
  assert.equal(h.closedPrs.length, 1, "the revert PR is closed");
  assert.match(h.closedPrs[0]!.comment, /30 of 60 not posted against 14 of 24/);
  assert.match(h.closedIssues[0]!.comment, /blame is cleared/);
});

test("W1-T13902 criterion 2: healed reviews that fail clearly less often, or are too few to judge, keep the incident open", async (t) => {
  // Recovered: the healed reviewer posts everything, so the revert is working.
  const recovered = await openIncident(t);
  for (let j = 0; j < 60; j++) recovered.h.queue.push(posted(HEALED, 600 + j, recovered.incident.id));
  const stillHealed = await recovered.h.evaluate(MAIN);
  const recoveredState = health.loadReviewerHealthState(recovered.h.statePath);
  assert.equal(recoveredState.incident?.id, recovered.incident.id, "a healed reviewer that recovers keeps its incident");
  assert.equal(stillHealed.route, "healed");
  assert.equal(recovered.h.steps("reviewer.regression_blame_cleared").length, 0);
  const evidence = health.blameCleared(recoveredState, recoveredState.incident!);
  assert.equal(evidence.cleared, false);
  assert.notEqual(evidence.evidence.judgment.state, "insufficient", "judged on sufficient evidence, and clearly better");
  // Too few: one healed refusal, or one healed post, could not have shown the healed tree better or worse.
  const thin = await openIncident(t);
  thin.h.queue.push(refused(HEALED, 700, thin.incident.id));
  await thin.h.evaluate(MAIN);
  const thinState = health.loadReviewerHealthState(thin.h.statePath);
  assert.equal(thinState.incident?.id, thin.incident.id, "a thin healed sample never clears the blame");
  assert.equal(health.blameCleared(thinState, thinState.incident!).evidence.judgment.state, "insufficient");
  assert.equal(thin.h.steps("reviewer.regression_blame_cleared").length, 0);
  thin.h.queue.push(posted(HEALED, 701, thin.incident.id));
  await thin.h.evaluate(MAIN);
  assert.equal(health.loadReviewerHealthState(thin.h.statePath).incident?.id, thin.incident.id, "two healed reviews are still too few");
  assert.equal(thin.h.steps("reviewer.regression_blame_cleared").length, 0);
  // A non-healed sha's failures (main's, or a shadow's) are not healed evidence.
  const unhealed = await openIncident(t);
  for (let j = 0; j < 40; j++) unhealed.h.queue.push(j % 2 === 0 ? refused(HEALED, 800 + j) : posted(HEALED, 800 + j));
  await unhealed.h.evaluate(MAIN);
  assert.ok(health.loadReviewerHealthState(unhealed.h.statePath).incident !== null, "rows with no incident id are not a healed tree's");
  assert.equal(unhealed.h.steps("reviewer.regression_blame_cleared").length, 0);
});
