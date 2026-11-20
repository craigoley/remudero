/**
 * W1-T13850 — REVIEWER HEALTH JUDGES FAIL RATES PER EVALUATOR MODEL.
 *
 * On 2026-11-19 the router sent every semantic review to one evaluator model, which failed 29 of 31
 * fleet code PRs while the other failed 17 of 172. Reviewer health judged per REVIEWER CODE SHA, where a
 * posted verdict, FAIL included, is a healthy outcome, so nothing alarmed. These tests replay that shape:
 * no reviewer code sha carried both models, so the judgment pools the healthy shas. Every effect is an
 * injected recording fake: nothing here posts a status, an issue or a PR.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as health from "#src/lib/reviewer-health.js";
import { upperNormalQuantile, wilsonInterval } from "#src/lib/model-drift.js";
import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import type { MainRepairLane } from "#src/lib/main-health-rung.js";
import { readReviewEvidenceRecord, renderReviewEvidenceRecord } from "#src/lib/review-evidence-record.js";
import { DOWNGRADE_UNCLASSIFIED } from "#src/lib/review-outcome-class.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

type Row = Record<string, unknown>;
const PULL = "https://github.com/acme/remudero/pull";
const fake = (seed: string): string => createHash("sha1").update(seed).digest("hex");
let clock = Date.parse("2026-11-18T12:00:00.000Z");
const tick = (): string => new Date((clock += 1000)).toISOString();

const SONNET = { provider: null, model: "claude-sonnet-5-5" };
const SOL = { provider: "codex", model: "gpt-6.2-sol" };
type Evaluator = { provider: string | null; model: string };

let prSeq = 20_000;
/** One review.posted row shaped like the 11-19 rows: evaluator_provenance, reviewer_code_sha, state. */
function verdict(sha: string, evaluator: Evaluator, state: "success" | "failure", extra: Row = {}): Row {
  const pr = prSeq++;
  return {
    // An unfiled PR's task id, as the 11-19 rows carry it: its review publishes its reasons in full.
    ts: tick(), host: "core", step: "review.posted", state, plan_only: false, pr_url: `${PULL}/${pr}`, task_id: `PR-${pr}`,
    head_sha: fake(`head-${pr}`), reviewer_code_sha: sha,
    evaluator_provenance: { provider: evaluator.provider, requestedModel: "sonnet", servedModel: null, effort: "high",
      sessionId: null, routedModel: evaluator.model, selectionAssignmentId: fake(`assign-${pr}`) },
    ...(state === "failure"
      ? { reasons: [`proof executed and PASSED on the PR head (grep: criterion ${pr}) — NOTE: reviewer judged the proof non-responsive (semantic downgrade): clause of PR ${pr}`],
        failure_reason: `remudero-review: FAIL — unmet: criterion of PR ${pr}` }
      : {}),
    ...extra,
  };
}

const repeat = (n: number, make: () => Row): Row[] => Array.from({ length: n }, make);

/** The 11-19 counts: claude-sonnet-5-5 155 pass / 17 fail over 40 shas; gpt-6.2-sol 2 pass / 29 fail
 *  over 3 shas no Claude review ran on. */
function elevenNineteen(): { rows: Row[]; solShas: string[]; claudeShas: string[] } {
  const claudeShas = Array.from({ length: 40 }, (_, i) => fake(`claude-sha-${i}`));
  const rows: Row[] = [];
  for (let i = 0; i < 155; i++) rows.push(verdict(claudeShas[i % 40]!, SONNET, "success"));
  for (let i = 0; i < 17; i++) rows.push(verdict(claudeShas[(i * 7) % 40]!, SONNET, "failure"));
  const solShas = [fake("19b11d5e2"), fake("4e13dcf00"), fake("d8307295f")];
  rows.push(...repeat(12, () => verdict(solShas[0]!, SOL, "failure")), verdict(solShas[0]!, SOL, "success"));
  rows.push(...repeat(14, () => verdict(solShas[1]!, SOL, "failure")), verdict(solShas[1]!, SOL, "success"));
  rows.push(...repeat(3, () => verdict(solShas[2]!, SOL, "failure")));
  return { rows, solShas, claudeShas };
}

/** `failLog` names the ledger steps whose append throws, as a full disk or a torn ledger would. */
function harness(t: TestContext, failLog: (step: string) => boolean = () => false, readEvidence?: typeof readReviewEvidenceRecord) {
  const dir = ownedFixtureDir(t, "reviewer-model-health").dir;
  const ledgerPath = join(dir, "ledger.ndjson");
  const statePath = join(dir, "reviewer-health.json");
  const queue: Row[] = [];
  const logs: Array<{ step: string; extra: Row }> = [];
  const created: Array<{ title: string; body: string }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const reverts: unknown[] = [];
  const issues: AsyncIssueGateway = {
    create: async (title, body) => { created.push({ title, body }); return `https://github.com/acme/remudero/issues/${created.length}`; },
    listOpen: async () => [],
    ensureLabel: async () => true,
    closeWithComment: async (url, comment) => { closed.push({ url, comment }); },
  };
  const lane: MainRepairLane = {
    openFixPr: async () => { throw new Error("no fix PR"); },
    openRevertPr: async (request) => { reverts.push(request); return { prUrl: `${PULL}/900` }; },
    readPr: async () => ({ state: "open" as const }),
    closePr: async () => undefined,
  };
  const escalation = { issues, ledgerPath, runId: "reviewer-model-health-test" };
  const log = (step: string, extra: Row = {}) => {
    if (failLog(step)) throw new Error(`ledger append failed: ${step}`);
    logs.push({ step, extra });
  };
  const readRows = async () => ({ rows: queue.splice(0), cursor: { liveOffset: 0 } });
  const git: health.GitText = async () => { throw new Error("no git: no sha regresses here"); };
  const iso = { iso: () => new Date(clock).toISOString() };
  const input = (originMainSha: string | null) => ({ originMainSha, ...(readEvidence ? { readEvidence } : {}) });
  /** The model judgment runs after the route returns (observe-only); these wait for it, so a test reads its effects. */
  const evaluate = async (originMainSha: string | null) => {
    const decision = await health.evaluateReviewerHealthNow(input(originMainSha), statePath, readRows, git, escalation, lane, log, iso);
    await health.settleReviewerModelJudgment(statePath);
    return decision;
  };
  /** The daemon's entry: any rejection of the evaluation routes normally. */
  const evaluateOuter = async (originMainSha: string | null) => {
    const decision = await health.evaluateReviewerHealth(input(originMainSha), statePath, readRows, git, escalation, lane, log, iso);
    await health.settleReviewerModelJudgment(statePath);
    return decision;
  };
  /** The evaluation alone, as the daemon awaits it: the model judgment may still be running. */
  const evaluateRouteOnly = (originMainSha: string | null) =>
    health.evaluateReviewerHealthNow(input(originMainSha), statePath, readRows, git, escalation, lane, log, iso);
  return { queue, logs, created, closed, issues, reverts, statePath, evaluate, evaluateOuter, evaluateRouteOnly, steps: (step: string) => logs.filter((l) => l.step === step) };
}

type ModelRow = Record<string, unknown> & { model: string };
const divergenceRows = (h: ReturnType<typeof harness>): Array<{ models: ModelRow[] }> =>
  h.steps("reviewer.model_divergence").map((l) => l.extra as { models: ModelRow[] });

test("W1-T13850 criterion 1: a posted verdict keeps its evaluator and state, and ingest counts pass and fail per model under each sha", (t) => {
  const sha = fake("c1-sha");
  const routed = health.classifyReviewerHealthRow(verdict(sha, SOL, "failure"));
  assert.equal(routed?.kind, "outcome");
  assert.deepEqual(routed?.kind === "outcome" ? [routed.evaluator, routed.state] : null, [{ provider: "codex", model: "gpt-6.2-sol" }, "failure"]);
  const served = health.classifyReviewerHealthRow({ ...verdict(sha, SONNET, "success"),
    evaluator_provenance: { provider: "claude", requestedModel: "sonnet", servedModel: "claude-sonnet-5-5" } });
  assert.deepEqual(served?.kind === "outcome" ? served.evaluator : null, { provider: "claude", model: "claude-sonnet-5-5" }, "servedModel when not routed");
  const requested = health.classifyReviewerHealthRow({ ...verdict(sha, SONNET, "success"),
    evaluator_provenance: { provider: null, requestedModel: "sonnet", servedModel: null } });
  assert.deepEqual(requested?.kind === "outcome" ? requested.evaluator : null, { provider: null, model: "sonnet" }, "requestedModel last");

  const state = health.emptyReviewerHealthState();
  const counted = [verdict(sha, SOL, "failure"), verdict(sha, SOL, "failure"), verdict(sha, SOL, "success"), verdict(sha, SONNET, "success")];
  const judgedNothing = ["plan_only", "review_reused", "review_discriminated", "status_recovered", "status_confirmed"]
    .map((flag) => verdict(sha, SOL, "failure", { [flag]: true }));
  health.ingestReviewerHealthRows(state, [...counted, ...judgedNothing]);
  const expected = { "gpt-6.2-sol": { provider: "codex", pass: 1, fail: 2 }, "claude-sonnet-5-5": { provider: null, pass: 1, fail: 0 } };
  assert.deepEqual(health.evaluatorModelCounts(state, sha), expected);
  assert.equal(health.shaCounts(state.shas[sha]!).n, 4, "the same five rows count for no sha either");
  health.ingestReviewerHealthRows(state, counted);
  assert.deepEqual(health.evaluatorModelCounts(state, sha), expected, "replaying a row changes nothing");

  // A state file written before model counts existed loads with empty model counts and keeps counting.
  const statePath = join(ownedFixtureDir(t, "reviewer-model-health-legacy").dir, "reviewer-health.json");
  const legacy = health.emptyReviewerHealthState();
  health.ingestReviewerHealthRows(legacy, [verdict(sha, SOL, "success")]);
  const shaped = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown> & { shas: Record<string, Record<string, unknown>> };
  for (const rec of Object.values(shaped.shas)) delete rec.models;
  delete shaped.pooledModels;
  delete shaped.pooledModelShas;
  delete shaped.modelIncidents;
  delete shaped.modelFails;
  writeFileSync(statePath, JSON.stringify(shaped));
  const loaded = health.loadReviewerHealthState(statePath);
  assert.deepEqual(health.evaluatorModelCounts(loaded, sha), {});
  assert.deepEqual(health.judgeEvaluatorModels(loaded), []);
  health.ingestReviewerHealthRows(loaded, [verdict(sha, SOL, "failure")]);
  assert.deepEqual(health.evaluatorModelCounts(loaded, sha), { "gpt-6.2-sol": { provider: "codex", pass: 0, fail: 1 } });
});

test("deferred SHA attribution preserves both evaluator verdicts and pending holds", (t) => {
  for (const attribution of ["daemon.boot", "review.ran_from_fresh_tree"]) {
    const sha = fake(attribution);
    const state = health.emptyReviewerHealthState();
    const posted = verdict(sha, SOL, "failure", { reviewer_code_sha: undefined });
    const held = verdict(sha, SOL, "failure", { reviewer_code_sha: undefined });
    const heldUnit = `${held.pr_url}#${held.head_sha}`;
    const firstHold = {
      ...held, step: "review.semantic_incomplete", reason: DOWNGRADE_UNCLASSIFIED,
      reviewer_outcome: "success", review_input_digest: "first-input",
    };
    if (attribution === "daemon.boot") {
      health.ingestReviewerHealthRows(state, [{ step: attribution, host: posted.host, head_sha: sha }]);
    }
    health.ingestReviewerHealthRows(state, [firstHold, posted]);
    const statePath = join(ownedFixtureDir(t, "reviewer-health-pending").dir, "reviewer-health.json");
    health.saveReviewerHealthState(statePath, state);
    const loaded = health.loadReviewerHealthState(statePath);
    const attributionRows = attribution === "daemon.boot"
      ? [{ step: attribution, host: posted.host, head_sha: sha }]
      : [held, posted].map((row) => ({
        step: attribution, host: row.host, origin_main_sha: sha, pr: String(row.pr_url).split("/").at(-1),
      }));
    health.ingestReviewerHealthRows(loaded, attributionRows);
    assert.equal(loaded.shas[sha]!.units[heldUnit], "withheld-pending", attribution);
    assert.deepEqual(health.shaCounts(loaded.shas[sha]!), { k: 0, n: 1 }, attribution);
    assert.deepEqual(health.evaluatorModelCounts(loaded, sha), { [SOL.model]: { provider: SOL.provider, pass: 0, fail: 1 } });

    health.ingestReviewerHealthRows(loaded, [{ ...firstHold, reviewer_code_sha: sha, ts: tick() }]);
    assert.equal(loaded.shas[sha]!.units[heldUnit], "withheld-success", attribution);
    assert.deepEqual(health.shaCounts(loaded.shas[sha]!), { k: 1, n: 2 }, attribution);
    assert.deepEqual(health.evaluatorModelCounts(loaded, sha), { [SOL.model]: { provider: SOL.provider, pass: 0, fail: 1 } });
  }
});

test("W1-T13850 criterion 2: the 11-19 counts read gpt-6.2-sol diverged and one reviewer.model_divergence row names it", async (t) => {
  const h = harness(t);
  await h.evaluate(null); // the seed: an empty history
  const { rows, solShas, claudeShas } = elevenNineteen();
  h.queue.push(...rows);
  const before = divergenceRows(h).length;
  const decision = await h.evaluate(claudeShas.at(-1)!);
  const state = health.loadReviewerHealthState(h.statePath);
  // Origin/main reads the posts, including FAILs, as healthy sha evidence.
  for (const sha of [...solShas, ...claudeShas]) assert.notEqual(health.judgeReviewerSha(state, sha).state, "regressed", sha);
  assert.equal(health.judgeReviewerSha(state, solShas[0]!).state, "healthy");
  assert.equal(decision.route, "normal");

  const written = divergenceRows(h).slice(before);
  assert.equal(written.length, 1, "one reviewer.model_divergence row for the evaluation: no evaluation named gpt-6.2-sol");
  const sol = written[0]!.models.find((m) => m.model === "gpt-6.2-sol");
  assert.ok(sol, "the row names gpt-6.2-sol");
  const z = upperNormalQuantile(health.REVIEWER_HEALTH_FAMILY_ALPHA / (2 * 2));
  assert.deepEqual(
    { state: sol.state, provider: sol.provider, fail: sol.fail, n: sol.n, baseline_fail: sol.baseline_fail, baseline_n: sol.baseline_n,
      baseline_models: sol.baseline_models, population: sol.population, population_shas: sol.population_shas, z: sol.z },
    { state: "diverged", provider: "codex", fail: 29, n: 31, baseline_fail: 17, baseline_n: 172,
      baseline_models: ["claude-sonnet-5-5"], population: "healthy-shas", population_shas: 43, z });
  assert.deepEqual(sol.interval, wilsonInterval(29, 31, z));
  assert.deepEqual(sol.baseline_interval, wilsonInterval(17, 172, z));
  assert.ok((sol.interval as { lower: number }).lower > (sol.baseline_interval as { upper: number }).upper, "wholly above the pooled baseline");

  const judged = health.judgeEvaluatorModels(state);
  // claude-sonnet-5-5 against a 29-of-31 baseline: even had all 172 failed it could not lie wholly above it.
  assert.deepEqual(judged.map((j) => [j.model, j.state, j.reason]), [["claude-sonnet-5-5", "insufficient", "thin-sample"], ["gpt-6.2-sol", "diverged", null]]);
  assert.equal(judged[0]!.below, true, "a model failing less than its baseline is reported as below, never escalated");
});

test("W1-T13850 criterion 2: shas both models carry are the population when they exist", () => {
  const state = health.emptyReviewerHealthState();
  const shared = fake("shared-sha");
  const rows = [...repeat(20, () => verdict(shared, SOL, "failure")), ...repeat(40, () => verdict(shared, SONNET, "success")),
    // a sha only one model carried is left out of a shared comparison
    ...repeat(30, () => verdict(fake("sonnet-only"), SONNET, "failure"))];
  health.ingestReviewerHealthRows(state, rows);
  const sol = health.judgeEvaluatorModels(state).find((j) => j.model === "gpt-6.2-sol")!;
  assert.deepEqual([sol.population.kind, sol.population.shas, sol.fail, sol.n, sol.baseline.fail, sol.baseline.n, sol.state],
    ["shared-shas", 1, 20, 20, 0, 40, "diverged"]);
});

test("W1-T13850 criterion 3: equal counts never diverge, and a sample that could not show it reads insufficient", () => {
  const sha = (seed: string) => fake(`c3-${seed}`);
  // Equal counts at any rate, high rates included: no fixed rate cut decides.
  for (const [fail, n] of [[0, 5], [5, 5], [45, 50], [50, 100], [99, 100]] as const) {
    const state = health.emptyReviewerHealthState();
    health.ingestReviewerHealthRows(state, [
      ...repeat(fail, () => verdict(sha(`a-${n}`), SOL, "failure")), ...repeat(n - fail, () => verdict(sha(`a-${n}`), SOL, "success")),
      ...repeat(fail, () => verdict(sha(`b-${n}`), SONNET, "failure")), ...repeat(n - fail, () => verdict(sha(`b-${n}`), SONNET, "success"))]);
    const judged = health.judgeEvaluatorModels(state);
    assert.equal(judged.length, 2);
    for (const j of judged) assert.notEqual(j.state, "diverged", `${j.model} at ${fail}/${n} against the same ${fail}/${n}`);
  }
  // A thin sample at a 100% FAIL rate: even had every review failed, its interval could not clear the baseline.
  for (const thin of [1]) {
    const state = health.emptyReviewerHealthState();
    const { rows } = elevenNineteen();
    health.ingestReviewerHealthRows(state, [...rows.filter((r) => (r.evaluator_provenance as { routedModel: string }).routedModel !== SOL.model),
      ...repeat(thin, () => verdict(sha(`thin-${thin}`), SOL, "failure"))]);
    const sol = health.judgeEvaluatorModels(state).find((j) => j.model === SOL.model)!;
    assert.deepEqual([sol.state, sol.reason], ["insufficient", "thin-sample"], `${thin} of ${thin} failed`);
  }
  // The same rate on more reviews reads diverged: the bound is the sample's, not a count.
  const state = health.emptyReviewerHealthState();
  const { rows } = elevenNineteen();
  health.ingestReviewerHealthRows(state, [...rows.filter((r) => (r.evaluator_provenance as { routedModel: string }).routedModel !== SOL.model),
    ...repeat(12, () => verdict(sha("thick"), SOL, "failure"))]);
  assert.equal(health.judgeEvaluatorModels(state).find((j) => j.model === SOL.model)!.state, "diverged");
  // A model with no other model to compare against reads insufficient.
  const alone = health.emptyReviewerHealthState();
  health.ingestReviewerHealthRows(alone, repeat(40, () => verdict(sha("alone"), SOL, "failure")));
  assert.deepEqual(health.judgeEvaluatorModels(alone).map((j) => [j.state, j.reason]), [["insufficient", "no-baseline"]]);
});

test("W1-T13850 criterion 4: a divergence opens one incident naming its latest FAIL clauses, opens nothing more, and closes on overlap", async (t) => {
  const h = harness(t);
  await h.evaluate(null);
  const { rows, claudeShas } = elevenNineteen();
  const solSha = fake("4e13dcf00");
  h.queue.push(...rows,
    // A FAIL with no downgraded proof names its unmet criteria; one naming neither, its failure line.
    verdict(solSha, SOL, "failure", { reasons: ["proof executed and FAILED on the PR head"], unmet_criteria: ["the unmet-only criterion"] }),
    verdict(solSha, SOL, "failure", { reasons: [], failure_reason: "remudero-review: FAIL — the bare failure line" }),
    verdict(solSha, SOL, "failure", {
    reasons: ["proof executed and PASSED on the PR head (grep: x) — NOTE: reviewer judged the proof non-responsive (semantic downgrade): the newest FAIL's own clause"],
  }));
  await h.evaluate(claudeShas.at(-1)!);
  assert.equal(h.created.length, 1, "one incident");
  const { title, body } = h.created[0]!;
  assert.match(title, /gpt-6\.2-sol/);
  assert.match(body, /gpt-6\.2-sol/);
  assert.match(body, /32 of 34/, "the model's counts");
  assert.match(body, /17 of 172/, "the baseline's counts");
  assert.match(body, /the newest FAIL's own clause/, "the latest FAILs' downgrade clauses");
  assert.match(body, /unmet: the unmet-only criterion/);
  assert.match(body, /the bare failure line/);
  assert.ok(body.indexOf("the newest FAIL's own clause") < body.indexOf("the bare failure line"), "newest first");
  assert.match(body, /calibrat/i, "the action: a calibration task");
  assert.match(body, /W1-T12145/);
  assert.equal(h.steps("reviewer.model_divergence_opened").length, 1);
  assert.equal(health.loadReviewerHealthState(h.statePath).modelIncidents["gpt-6.2-sol"]?.issueUrl, "https://github.com/acme/remudero/issues/1");

  h.queue.push(verdict(solSha, SOL, "failure"));
  await h.evaluate(claudeShas.at(-1)!);
  await h.evaluate(claudeShas.at(-1)!);
  assert.equal(h.created.length, 1, "a later evaluation of the same divergence opens nothing more");
  assert.equal(h.closed.length, 0);

  // Passes accrue until the model's interval overlaps the baseline's: then the incident closes.
  let batches = 0;
  while (h.closed.length === 0 && batches < 100) {
    batches += 1;
    h.queue.push(...repeat(20, () => verdict(fake(`sol-recovers-${batches % 3}`), SOL, "success")));
    await h.evaluate(claudeShas.at(-1)!);
    const sol = health.judgeEvaluatorModels(health.loadReviewerHealthState(h.statePath)).find((j) => j.model === SOL.model)!;
    if (h.closed.length === 0) assert.ok(sol.interval!.lower > sol.baselineInterval!.upper, `open only while wholly above (batch ${batches})`);
    else assert.ok(sol.interval!.lower <= sol.baselineInterval!.upper && sol.interval!.upper >= sol.baselineInterval!.lower, "closed once it overlaps");
  }
  assert.deepEqual(h.closed.map((c) => c.url), ["https://github.com/acme/remudero/issues/1"]);
  assert.match(h.closed[0]!.comment, /gpt-6\.2-sol/);
  assert.equal(h.steps("reviewer.model_divergence_closed").length, 1);
  assert.equal(health.loadReviewerHealthState(h.statePath).modelIncidents["gpt-6.2-sol"], undefined);
  assert.equal(h.created.length, 1);
});

test("W1-T13850 criterion 5: invariant:observe-only — the model judgment changes no route, sha judgment or reviewer-sha incident", async (t) => {
  const { rows, solShas, claudeShas } = elevenNineteen();
  // The same rows with every evaluator and verdict state removed: what origin/main's sha judgment reads.
  const blind = rows.map((row) => { const { evaluator_provenance: _e, reasons: _r, failure_reason: _f, ...rest } = row; void [_e, _r, _f]; return { ...rest, state: "success" }; });
  const seen = harness(t);
  const unseen = harness(t);
  for (const h of [seen, unseen]) await h.evaluate(null);
  seen.queue.push(...rows);
  unseen.queue.push(...blind);
  const current = claudeShas.at(-1)!;
  const withModels = await seen.evaluate(current);
  const without = await unseen.evaluate(current);
  assert.equal(seen.created.length, 1, "the divergence escalated (the judgment ran)");
  assert.deepEqual(withModels, without, "the route reads the same");
  const a = health.loadReviewerHealthState(seen.statePath);
  const b = health.loadReviewerHealthState(unseen.statePath);
  for (const sha of [...solShas, ...claudeShas]) assert.deepEqual(health.judgeReviewerSha(a, sha), health.judgeReviewerSha(b, sha), sha);
  assert.equal(a.incident, null, "no reviewer-sha incident");
  assert.deepEqual(Object.values(a.shas).filter((rec) => rec.regressedAt !== undefined), []);
  assert.equal(seen.reverts.length, 0, "no revert PR");
  assert.deepEqual(seen.logs.filter((l) => l.step.startsWith("reviewer.regression")), []);
  assert.deepEqual(Object.values(a.shas).map((rec) => rec.units), Object.values(b.shas).map((rec) => rec.units));
  assert.ok(readFileSync(seen.statePath, "utf8").includes("gpt-6.2-sol"));
});

test("W1-T13850 criterion 1: two posted decisions by one model at one sha both count, and replaying either changes nothing", () => {
  // Review finding (reviewer-health.ts:292): the PR-head key collapsed a FAIL and the PASS posted after a body edit into 1 pass, 0 fail.
  const sha = fake("c1-decisions-sha");
  const head = fake("c1-decisions-head");
  const posted = (state: "success" | "failure", decision: string, attempt: string): Row => ({
    ...verdict(sha, SOL, state), pr_url: `${PULL}/31000`, task_id: "PR-31000", head_sha: head,
    review_decision_digest: fake(decision), review_attempt_id: `review-PR31000-${attempt}`,
  });
  const fail = posted("failure", "decision-before-body-edit", "attempt-1");
  const pass = posted("success", "decision-after-body-edit", "attempt-2");
  const state = health.emptyReviewerHealthState();
  health.ingestReviewerHealthRows(state, [fail, pass]);
  assert.deepEqual(health.evaluatorModelCounts(state, sha), { "gpt-6.2-sol": { provider: "codex", pass: 1, fail: 1 } });
  health.ingestReviewerHealthRows(state, [fail, pass, fail]);
  assert.deepEqual(health.evaluatorModelCounts(state, sha), { "gpt-6.2-sol": { provider: "codex", pass: 1, fail: 1 } }, "an exact replay dedupes");
  assert.deepEqual(state.modelFails["gpt-6.2-sol"]!.map((f) => f.unit), [`${PULL}/31000#${head}`], "the FAIL is remembered once");
  // The sha judgment still counts the PR head once, exactly as before (observe-only).
  assert.deepEqual(health.shaCounts(state.shas[sha]!), { k: 0, n: 1 });
});

test("W1-T13850 criterion 1: replay after eviction and state reload keeps one count per posted decision", (t) => {
  const sha = fake("evicted-decisions");
  const fail = verdict(sha, SOL, "failure", { review_decision_digest: fake("before edit") });
  const pass = { ...fail, state: "success", review_decision_digest: fake("after edit") };
  const state = health.emptyReviewerHealthState();
  health.ingestReviewerHealthRows(state, [fail, pass, ...fillTrackedShas("dedup", "success")]);
  assert.equal(state.shas[sha], undefined);
  const { dir } = ownedFixtureDir(t, "reviewer-model-eviction-replay");
  const statePath = join(dir, "reviewer-health.json");
  health.saveReviewerHealthState(statePath, state);
  const loaded = health.loadReviewerHealthState(statePath);
  health.ingestReviewerHealthRows(loaded, [fail, pass, fail]);
  const sol = health.judgeEvaluatorModels(loaded).find((j) => j.model === SOL.model)!;
  assert.deepEqual([sol.fail, sol.n], [1, 2]);
  assert.equal(loaded.modelFails[SOL.model]?.length, 1);
});

function fillTrackedShas(seed: string, state: "success" | "failure"): Row[] {
  return Array.from({ length: health.MAX_TRACKED_REVIEWER_SHAS }, (_, i) => verdict(fake(`${seed}-${i}`), SONNET, state));
}

test("W1-T13850 criterion 2: a late verdict joins the shared-SHA population after eviction", (t) => {
  const sha = fake("late-shared-sha");
  const state = health.emptyReviewerHealthState();
  health.ingestReviewerHealthRows(state, [...repeat(40, () => verdict(sha, SONNET, "success")), ...fillTrackedShas("late", "failure")]);
  assert.equal(state.shas[sha], undefined);
  const { dir } = ownedFixtureDir(t, "reviewer-model-late-sha");
  const statePath = join(dir, "reviewer-health.json");
  health.saveReviewerHealthState(statePath, state);
  const loaded = health.loadReviewerHealthState(statePath);
  health.ingestReviewerHealthRows(loaded, repeat(20, () => verdict(sha, SOL, "failure")));
  const sol = health.judgeEvaluatorModels(loaded).find((j) => j.model === SOL.model)!;
  assert.deepEqual([sol.population.kind, sol.population.shas, sol.population.pooledShas, sol.state], ["shared-shas", 0, 1, "diverged"]);
  assert.deepEqual([sol.fail, sol.n, sol.baseline.fail, sol.baseline.n], [20, 20, 0, 40]);
});

test("W1-T13850 criterion 2: pooling the only shared sha keeps the shared-sha comparison", () => {
  // Review finding (reviewer-health.ts:523): once the shared sha pooled away, the judge fell back to every healthy sha
  // and gpt-6.2-sol flipped from diverged to insufficient.
  const shared = fake("pooled-shared-sha");
  const sharedRows = [...repeat(20, () => verdict(shared, SOL, "failure")), ...repeat(40, () => verdict(shared, SONNET, "success"))];
  const sonnetOnly = Array.from({ length: health.MAX_TRACKED_REVIEWER_SHAS }, (_, i) => verdict(fake(`sonnet-only-${i}`), SONNET, "failure"));
  const judgeSol = (rows: Row[]) => {
    const state = health.emptyReviewerHealthState();
    health.ingestReviewerHealthRows(state, rows);
    return { state, sol: health.judgeEvaluatorModels(state).find((j) => j.model === SOL.model)! };
  };
  const live = judgeSol([...sharedRows, ...sonnetOnly.slice(1)]);
  assert.ok(live.state.shas[shared], "the shared sha is still tracked");
  const pooled = judgeSol([...sharedRows, ...sonnetOnly]);
  assert.equal(pooled.state.shas[shared], undefined, "the shared sha pooled away");
  for (const { sol } of [live, pooled]) {
    assert.deepEqual([sol.population.kind, sol.population.shas + sol.population.pooledShas, sol.fail, sol.n, sol.baseline.fail, sol.baseline.n, sol.state],
      ["shared-shas", 1, 20, 20, 0, 40, "diverged"]);
  }
  assert.deepEqual([pooled.sol.population.shas, pooled.sol.population.pooledShas], [0, 1], "the pooled shared sha is named as pooled");
  // Earlier files had only an aggregate for the pooled sha, which still contributes to its comparison.
  const models = health.evaluatorModelCounts(pooled.state, shared);
  const legacy = { ...pooled.state, pooledModelShas: {}, pooledModels: models,
    pooledSharedModels: { [JSON.stringify([SONNET.model, SOL.model])]: { shas: 1, models } } };
  assert.deepEqual(health.judgeEvaluatorModels(legacy).find((j) => j.model === SOL.model), pooled.sol);
  delete (legacy as health.ReviewerHealthState).pooledSharedModels;
  assert.equal(health.judgeEvaluatorModels(legacy).find((j) => j.model === SOL.model)!.population.kind, "healthy-shas");
});

test("W1-T13850 criterion 4: an interval wholly below the baseline is not an overlap, so the incident stays open", async (t) => {
  // Review finding (reviewer-health.ts:1027): the close guard read only lower <= baseline.upper, so an interval at
  // 6.9-11.8% against a baseline at 68.5-80.6% closed the incident though the two never met.
  const h = harness(t);
  await h.evaluate(null);
  const { rows, solShas, claudeShas } = elevenNineteen();
  h.queue.push(...rows);
  await h.evaluate(claudeShas.at(-1)!);
  assert.ok(health.loadReviewerHealthState(h.statePath).modelIncidents[SOL.model], "the 11-19 divergence opened");
  h.queue.push(...repeat(300, () => verdict(solShas[0]!, SOL, "success")), ...repeat(500, () => verdict(claudeShas[0]!, SONNET, "failure")));
  await h.evaluate(claudeShas.at(-1)!);
  const sol = health.judgeEvaluatorModels(health.loadReviewerHealthState(h.statePath)).find((j) => j.model === SOL.model)!;
  assert.ok(sol.interval!.upper < sol.baselineInterval!.lower, `wholly below: ${JSON.stringify([sol.interval, sol.baselineInterval])}`);
  assert.equal(sol.below, true);
  assert.deepEqual(h.closed, [], "no close: the intervals do not overlap");
  assert.deepEqual(h.steps("reviewer.model_divergence_closed").filter((l) => l.extra.model === SOL.model), []);
  assert.ok(health.loadReviewerHealthState(h.statePath).modelIncidents[SOL.model], "the incident is still open");
});

test("W1-T13850 criterion 4: a failed issue lookup leaves delivery pending and retries it", async (t) => {
  const h = harness(t);
  await h.evaluate(null);
  const { rows, claudeShas } = elevenNineteen();
  const current = claudeShas.at(-1)!;
  const lookup = h.issues.listOpen!;
  h.issues.listOpen = async () => { throw new Error("issue lookup unavailable"); };
  h.queue.push(...rows);
  await h.evaluate(current);
  assert.equal(h.created.length, 0);
  assert.ok(health.loadReviewerHealthState(h.statePath).modelIncidents[SOL.model]);
  assert.equal(h.steps("reviewer.model_divergence_opened").length, 0);

  h.issues.listOpen = lookup;
  await h.evaluate(current);
  await h.evaluate(current);
  assert.equal(h.created.length, 1);
  assert.equal(h.steps("reviewer.model_divergence_opened").length, 1);
});

test("W1-T13850 criterion 4: a failed close retains the issue and retries on overlap", async (t) => {
  const h = harness(t);
  await h.evaluate(null);
  const { rows, solShas, claudeShas } = elevenNineteen();
  const current = claudeShas.at(-1)!;
  h.queue.push(...rows);
  await h.evaluate(current);
  assert.equal(h.created.length, 1);
  const close = h.issues.closeWithComment!;
  h.issues.closeWithComment = async () => { throw new Error("issue close unavailable"); };
  h.queue.push(...repeat(160, () => verdict(solShas[0]!, SOL, "success")));
  await h.evaluate(current);
  assert.equal(h.closed.length, 0);
  assert.equal(h.steps("reviewer.model_divergence_closed").length, 0);
  assert.match(String(h.steps("reviewer.model_divergence_issue_close_failed")[0]?.extra.error), /issue close unavailable/);
  assert.equal(health.loadReviewerHealthState(h.statePath).modelIncidents[SOL.model]?.issueUrl, "https://github.com/acme/remudero/issues/1");

  h.issues.closeWithComment = close;
  await h.evaluate(current);
  assert.equal(h.closed.length, 1);
  assert.equal(h.steps("reviewer.model_divergence_closed").length, 1);
  assert.equal(health.loadReviewerHealthState(h.statePath).modelIncidents[SOL.model], undefined);
});

test("W1-T13850 criterion 4: a lost delivery receipt recovers the open model issue after the latest FAIL changes", async (t) => {
  const h = harness(t);
  await h.evaluate(null);
  const { rows, solShas, claudeShas } = elevenNineteen();
  const current = claudeShas.at(-1)!;
  const create = h.issues.create;
  h.issues.create = async (...args) => { await create(...args); throw new Error("issue created but receipt was lost"); };
  const url = "https://github.com/acme/remudero/issues/1";
  h.issues.listOpen = async () => h.created.map(({ body }, i) => ({ title: "Retitled reviewer incident", body, url, number: i + 1 }));
  h.queue.push(...rows);
  await h.evaluate(current);
  assert.equal(h.created.length, 1);
  assert.equal(h.steps("reviewer.model_divergence_opened").length, 0);

  h.queue.push(verdict(solShas[0]!, SOL, "failure"));
  await h.evaluate(current);
  assert.equal(h.created.length, 1);
  assert.equal(h.steps("reviewer.model_divergence_opened").length, 1);
  assert.equal(health.loadReviewerHealthState(h.statePath).modelIncidents[SOL.model]?.issueUrl, url);
});

/** A state with an open reviewer-sha incident that names an offending merge: the route is healed. */
function writeHealedState(statePath: string): health.ReviewerIncident {
  const regressed = fake("regressed-reviewer-code");
  const incident: health.ReviewerIncident = {
    id: `reviewer-regression-${regressed.slice(0, 12)}`, openedAt: "2026-11-18T11:00:00.000Z", regressedSha: regressed, regressedSeq: 1,
    bootHeadSha: null, lastHealthySha: null, offending: { sha: fake("offending-merge"), subject: "feat: break review (#1)", pr: 1, reason: "touches src/lib/review.ts" },
    signature: ["setup-refused"],
    evidence: { sha: regressed, state: "regressed", reason: null, k: 5, n: 5, baseline: { k: 0, n: 40 }, interval: null, baselineInterval: null, z: null },
    issueUrl: "https://github.com/acme/remudero/issues/77", revertPrUrl: `${PULL}/900`,
  };
  health.saveReviewerHealthState(statePath, { ...health.emptyReviewerHealthState(), seededAt: "2026-11-18T10:00:00.000Z", cursor: { liveOffset: 0 }, incident });
  return incident;
}

test("W1-T13850 criterion 5: evaluator names inherited from Object.prototype preserve a healed route", async (t) => {
  const seen = harness(t);
  const blind = harness(t);
  const incident = writeHealedState(seen.statePath);
  writeHealedState(blind.statePath);
  const sha = fake("reserved-evaluator-names");
  for (const requestedModel of ["constructor", "__proto__", "toString"]) {
    const row = verdict(sha, SOL, "failure", { evaluator_provenance: { provider: SOL.provider, requestedModel } });
    seen.queue.push(row);
    blind.queue.push({ ...row, evaluator_provenance: undefined });
  }
  const expected = await blind.evaluateOuter(sha);
  assert.deepEqual([expected.route, expected.route === "healed" ? expected.incident.id : null], ["healed", incident.id]);
  assert.deepEqual(await seen.evaluateOuter(sha), expected);
  await seen.evaluateOuter(sha);
  const saved = health.loadReviewerHealthState(seen.statePath);
  const counts = health.evaluatorModelCounts(saved, sha);
  assert.deepEqual(Object.keys(counts).sort(), ["__proto__", "constructor", "toString"]);
  assert.deepEqual(Object.values(counts).map(({ fail }) => fail), [1, 1, 1]);
  assert.deepEqual(seen.steps("reviewer.health_unavailable"), []);
});

test("W1-T13850 criterion 5: unreadable model units cannot prevent SHA ingestion or change the healed route", async (t) => {
  const h = harness(t);
  const incident = writeHealedState(h.statePath);
  const sha = fake("unreadable-model-units");
  const state = health.loadReviewerHealthState(h.statePath);
  health.ingestReviewerHealthRows(state, [verdict(sha, SOL, "success")]);
  const models = { [SOL.model]: { provider: SOL.provider, units: null } };
  writeFileSync(h.statePath, JSON.stringify({ ...state, shas: { [sha]: { ...state.shas[sha], models } } }));
  h.queue.push(verdict(sha, SOL, "failure"));
  const decision = await h.evaluateOuter(sha);
  assert.deepEqual([decision.route, decision.route === "healed" ? decision.incident.id : null], ["healed", incident.id]);
  assert.deepEqual(health.shaCounts(health.loadReviewerHealthState(h.statePath).shas[sha]!), { k: 0, n: 2 });
  assert.equal(h.steps("reviewer.model_divergence_failed").length, 2, "both ingest and judgment report their failure");
  assert.deepEqual(h.steps("reviewer.health_unavailable"), []);
});

test("W1-T13850 criterion 5: a failed model archive write preserves the SHA pool", (t) => {
  const state = health.emptyReviewerHealthState();
  Object.freeze(state.pooledModelShas);
  const blind = health.emptyReviewerHealthState();
  const sha = fake("failed-model-archive");
  const rows = [verdict(sha, SOL, "failure"), ...fillTrackedShas("archive", "success")];
  const failures: string[] = [];
  t.mock.method(console, "error", (message: string) => { failures.push(message); });
  health.ingestReviewerHealthRows(state, rows);
  health.ingestReviewerHealthRows(blind, rows.map((row) => ({ ...row, evaluator_provenance: undefined })));
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /reviewer\.model_divergence_failed/);
  assert.equal(state.shas[sha], undefined);
  assert.deepEqual(state.pooled, blind.pooled);
  assert.deepEqual(health.judgeReviewerSha(state, String(rows.at(-1)?.reviewer_code_sha)),
    health.judgeReviewerSha(blind, String(rows.at(-1)?.reviewer_code_sha)));
});

test("W1-T13850 criterion 5: invariant:observe-only — a failing model-observation append keeps the healed route and persists the sha state", async (t) => {
  // Review finding (reviewer-health.ts:1096): the model ledger append rejected before the healed route was returned, so
  // the outer evaluator fell back to the normal route (origin/main: healed; the PR head: normal).
  const { rows, claudeShas } = elevenNineteen();
  const control = harness(t);
  const failing = harness(t, (step) => step === "reviewer.model_divergence");
  const incident = writeHealedState(control.statePath);
  writeHealedState(failing.statePath);
  control.queue.push(...rows);
  failing.queue.push(...rows);
  const expected = await control.evaluateOuter(claudeShas.at(-1)!);
  const decision = await failing.evaluateOuter(claudeShas.at(-1)!);
  assert.equal(expected.route, "healed", "the control routes healed");
  assert.deepEqual(decision, expected, "the failing model append changes no route");
  assert.equal(decision.route === "healed" ? decision.incident.id : null, incident.id);
  assert.deepEqual(failing.steps("reviewer.health_unavailable"), [], "the evaluation did not fail");
  const reported = failing.steps("reviewer.model_divergence_failed");
  assert.equal(reported.length, 1, "the observation's own failure is ledgered");
  assert.match(String(reported[0]!.extra.error), /ledger append failed: reviewer\.model_divergence/);
  const saved = health.loadReviewerHealthState(failing.statePath);
  assert.equal(Object.keys(saved.shas).length, 43, "the sha counts were persisted");
  assert.deepEqual(saved.incident?.id, incident.id);
  for (const sha of claudeShas) {
    assert.deepEqual(health.judgeReviewerSha(saved, sha), health.judgeReviewerSha(health.loadReviewerHealthState(control.statePath), sha), sha);
  }
});

test("W1-T13850 criterion 5: when the ledger refuses even the failure row, the failure reaches stderr and the route holds", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  const h = harness(t, (step) => step.startsWith("reviewer.model_divergence"));
  const incident = writeHealedState(h.statePath);
  const decision = await h.evaluateOuter(fake("current-reviewer-code"));
  assert.deepEqual([decision.route, decision.route === "healed" ? decision.incident.id : null], ["healed", incident.id]);
  assert.equal(errors.length, 1, "never swallowed silently");
  assert.match(errors[0]!, /reviewer\.model_divergence_failed/);
  assert.match(errors[0]!, /ledger append failed: reviewer\.model_divergence_failed/);
});

test("W1-T13850 criterion 4: a FAIL whose review was not published in full has its clauses redacted from the incident", async (t) => {
  // Review finding (reviewer-health.ts:586): the issue quoted host-ledger downgrade clauses without the ops-catalog
  // publication boundary. An ops task's review publishes "detailed evidence retained on host" and never its reasons; a
  // row that cannot show its review was public is held to the same rule.
  const h = harness(t);
  await h.evaluate(null);
  const { rows, claudeShas } = elevenNineteen();
  const solSha = fake("4e13dcf00");
  const downgrade = (clause: string) => [`proof executed and PASSED on the PR head (grep: x) — NOTE: reviewer judged the proof non-responsive (semantic downgrade): ${clause}`];
  h.queue.push(...rows,
    verdict(solSha, SOL, "failure", { task_id: "W1-T99001", reasons: downgrade("PRIVATE-CATALOG clause of an ops task") }),
    verdict(solSha, SOL, "failure", { task_id: undefined, reasons: downgrade("PRIVATE clause of a row naming no task") }),
    verdict(solSha, SOL, "failure", { task_id: "W1-T99002", reasons: [], failure_reason: "remudero-review: FAIL — PRIVATE failure line" }),
    verdict(solSha, SOL, "failure", { task_id: "PR-31001", reasons: downgrade("public clause of an unfiled PR") }));
  await h.evaluate(claudeShas.at(-1)!);
  assert.equal(h.created.length, 1);
  const { body } = h.created[0]!;
  assert.doesNotMatch(body, /PRIVATE/, "no clause of a review not published in full");
  assert.match(body, /public clause of an unfiled PR/, "a public review's clause is still named");
  assert.equal(body.match(/detailed evidence retained on host/g)?.length, 3, "each redacted FAIL says where its evidence is");
  // The host keeps the clauses: the state file is host-side, and the boundary applies where they leave it.
  assert.ok(health.loadReviewerHealthState(h.statePath).modelFails[SOL.model]!.some((f) => f.clauses.includes("PRIVATE-CATALOG clause of an ops task")));
});

test("W1-T13850 criterion 4: a filed task quotes only clauses in its verified published evidence", async (t) => {
  const { rows, claudeShas } = elevenNineteen();
  const sha = fake("publication-reviewer-code");
  const reason = (clause: string) => `proof executed and PASSED — (semantic downgrade): ${clause}`;
  const publication = (catalog: "public" | "ops", reasons: string[]) => {
    const prUrl = `${PULL}/${prSeq}`;
    const headSha = fake(prUrl);
    const digest = `v2:${headSha.padEnd(64, "0")}`;
    const record = renderReviewEvidenceRecord({ pr_url: prUrl, head_sha: headSha, review_input_digest: digest, state: "failure",
      reviewer_code_sha: sha, capped: false, plan_only: false, partially_executed: false, decision_verdict: { criteria: [] },
      unmet_criteria: [], reasons }, catalog);
    const row = verdict(sha, SOL, "failure", { task_id: `W1-T${prSeq}`, head_sha: headSha, review_input_digest: digest, reasons });
    return { row, prUrl, headSha, record };
  };
  const publicTask = publication("public", [reason("the filed public clause")]);
  (publicTask.row.reasons as string[]).push(reason("PRIVATE addition absent from the published record"));
  const opsTask = publication("ops", [reason("PRIVATE clause from the ops catalog")]);
  const unavailable = publication("public", [reason("PRIVATE unless the evidence can be verified")]);
  const mismatched = publication("public", [reason("PRIVATE evidence on a different input")]);
  mismatched.row.review_input_digest = `v2:${"3".repeat(64)}`;
  const readEvidence: typeof readReviewEvidenceRecord = (expected) => readReviewEvidenceRecord(expected, async (args) => {
    const fixture = [publicTask, opsTask, mismatched].find(({ prUrl }) => prUrl === expected.prUrl);
    if (!fixture) throw new Error("review evidence unavailable");
    const at = "2026-11-19T12:00:00.000Z";
    if (args[1] !== "graphql") return [[{ id: 123, body: fixture.record, created_at: at, updated_at: at,
      user: { login: "remudero-fleet[bot]", type: "Bot" } }]];
    return { data: { repository: { nameWithOwner: "acme/remudero", object: { oid: fixture.headSha,
      status: { context: { context: "remudero-review", state: "FAILURE", description: `Verdict [review code ${sha}]`,
        createdAt: at, creator: { login: "remudero-fleet", __typename: "Bot" } } } } } } };
  });
  const h = harness(t, undefined, readEvidence);
  await h.evaluate(null);
  h.queue.push(...rows, publicTask.row, opsTask.row, unavailable.row, mismatched.row);
  await h.evaluate(claudeShas.at(-1)!);
  assert.equal(h.created.length, 1);
  assert.match(h.created[0]!.body, /the filed public clause/);
  assert.doesNotMatch(h.created[0]!.body, /PRIVATE/);
  assert.match(String(h.steps("reviewer.model_divergence_evidence_unavailable")[0]?.extra.error), /review evidence unavailable/);
});

test("W1-T13850 criterion 4: the body tryEscalateAsync delivers stays within the issue limit when a label cannot be provisioned", async (t) => {
  // Review finding (11-20 19:55Z): 105 FAILs with 484-character clauses rendered 65,511 characters; with a
  // needs-action label unprovisioned, tryEscalateAsync's degraded-label footer made the delivered body 65,670,
  // a cap-enforcing gateway refused it, and no incident opened.
  const h = harness(t);
  const delivered: string[] = [];
  h.issues.ensureLabel = async (label) => label === "needs-human";
  h.issues.create = async (title, body) => {
    delivered.push(body);
    if (body.length > health.GITHUB_ISSUE_BODY_LIMIT) throw new Error(`body is too long (${body.length})`);
    h.created.push({ title, body });
    return `https://github.com/acme/remudero/issues/${h.created.length}`;
  };
  await h.evaluate(null);
  const { rows, claudeShas } = elevenNineteen();
  const solSha = fake("4e13dcf00");
  const clause = (i: number) => `long clause ${i} `.padEnd(484, "x");
  h.queue.push(...rows, ...Array.from({ length: 200 }, (_, i) => verdict(solSha, SOL, "failure", {
    reasons: [`proof executed and PASSED on the PR head (grep: y) — NOTE: reviewer judged the proof non-responsive (semantic downgrade): ${clause(i)}`],
  })));
  await h.evaluate(claudeShas.at(-1)!);
  assert.equal(h.created.length, 1, "the incident opened");
  assert.ok(delivered.every((body) => body.length <= health.GITHUB_ISSUE_BODY_LIMIT), `delivered ${delivered.map((b) => b.length).join(", ")}`);
  assert.match(h.created[0]!.body, /Degraded: label\(s\)/, "the degraded-label footer is part of the delivered body");
  // The rendered incident leaves room for every footer tryEscalateAsync may append, not only the one seen here.
  const rendered = h.created[0]!.body.slice(0, h.created[0]!.body.indexOf("\n\n_Degraded:"));
  assert.ok(rendered.length <= health.GITHUB_ISSUE_BODY_LIMIT - 4_096, `rendered ${rendered.length} leaves the footer reserve`);
  assert.match(h.created[0]!.body, /long clause 199 /, "the newest FAIL is still quoted");
});

test("W1-T13850 criterion 5: invariant:observe-only — a slow model issue lookup delays neither the saved sha state nor the healed route", async (t) => {
  // Review finding (11-20 19:55Z): with the same rows and an open sha incident, origin/main saved and returned
  // healed, while the PR head withheld both until the model issue lookup finished.
  const { rows, claudeShas } = elevenNineteen();
  const control = harness(t);
  const slow = harness(t);
  const incident = writeHealedState(control.statePath);
  writeHealedState(slow.statePath);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  slow.issues.listOpen = async () => { await gate; return []; };
  control.queue.push(...rows);
  slow.queue.push(...rows);
  const expected = await control.evaluate(claudeShas.at(-1)!);
  const decision = await slow.evaluateRouteOnly(claudeShas.at(-1)!);
  assert.equal(expected.route, "healed");
  assert.deepEqual(decision, expected, "the route returns while the model lookup is still pending");
  const saved = health.loadReviewerHealthState(slow.statePath);
  assert.equal(saved.incident?.id, incident.id, "the sha state was saved before the lookup finished");
  assert.equal(Object.keys(saved.shas).length, 43);
  assert.equal(slow.created.length, 0, "the lookup has not finished");
  release();
  await health.settleReviewerModelJudgment(slow.statePath);
  assert.equal(slow.created.length, 1, "the model judgment completes after the route");
  assert.equal(health.loadReviewerHealthState(slow.statePath).modelIncidents["gpt-6.2-sol"]?.issueUrl, "https://github.com/acme/remudero/issues/1");
  assert.equal(health.loadReviewerHealthState(slow.statePath).incident?.id, incident.id, "the merge keeps the sha incident");
});
