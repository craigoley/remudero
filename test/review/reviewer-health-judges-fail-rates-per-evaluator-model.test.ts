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
    ts: tick(), host: "core", step: "review.posted", state, plan_only: false, pr_url: `${PULL}/${pr}`,
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

function harness(t: TestContext) {
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
  const log = (step: string, extra: Row = {}) => { logs.push({ step, extra }); };
  const readRows = async () => ({ rows: queue.splice(0), cursor: { liveOffset: 0 } });
  const git: health.GitText = async () => { throw new Error("no git: no sha regresses here"); };
  const evaluate = (originMainSha: string | null) =>
    health.evaluateReviewerHealthNow({ originMainSha }, statePath, readRows, git, escalation, lane, log, { iso: () => new Date(clock).toISOString() });
  return { queue, logs, created, closed, reverts, statePath, evaluate, steps: (step: string) => logs.filter((l) => l.step === step) };
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
  delete shaped.modelIncidents;
  delete shaped.modelFails;
  writeFileSync(statePath, JSON.stringify(shaped));
  const loaded = health.loadReviewerHealthState(statePath);
  assert.deepEqual(health.evaluatorModelCounts(loaded, sha), {});
  assert.deepEqual(health.judgeEvaluatorModels(loaded), []);
  health.ingestReviewerHealthRows(loaded, [verdict(sha, SOL, "failure")]);
  assert.deepEqual(health.evaluatorModelCounts(loaded, sha), { "gpt-6.2-sol": { provider: "codex", pass: 0, fail: 1 } });
});

test("W1-T13850 criterion 2: the 11-19 counts read gpt-6.2-sol diverged and one reviewer.model_divergence row names it", async (t) => {
  const h = harness(t);
  await h.evaluate(null); // the seed: an empty history
  const { rows, solShas, claudeShas } = elevenNineteen();
  h.queue.push(...rows);
  const before = divergenceRows(h).length;
  const decision = await h.evaluate(claudeShas.at(-1)!);
  const state = health.loadReviewerHealthState(h.statePath);
  // What origin/main already saw: the sha judgment of every sha reads healthy (posted is healthy).
  for (const sha of [...solShas, ...claudeShas]) assert.notEqual(health.judgeReviewerSha(state, sha).state, "regressed", sha);
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
    else assert.ok(sol.interval!.lower <= sol.baselineInterval!.upper, "closed once it overlaps");
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
