/**
 * W1-T13392 — A REVIEWER-REGRESSION INCIDENT IS NOT RAISED FROM A SINGLE UNPOSTED REVIEW. A Wilson lower bound at
 * the family z puts 1 of 1 at 0.0455, above a baseline of 0 of 5267, so one unposted review opened an incident, and
 * the same refused PR head re-read regressed at every main commit. A sha now reads regressed by the exact
 * (Clopper-Pearson) bound at the same family tail, which a lone failure cannot cross; and for OPENING it pools with
 * the run of unproven shas since the newest one whose own sample reads healthy, so a total outage spread thinly over
 * a fast-moving main still opens.
 * INVARIANT a-real-regression-still-opens: the 2026-10-20 shape, every review of several PRs withheld or refused at
 * one sha, still opens one incident naming the offending merge. Every effect is an injected fake; git is a stub.
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
import type { MainRepairLane, MainRepairRevertRequest } from "#src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const PULL = "https://github.com/acme/remudero/pull";
const fake = (seed: string): string => createHash("sha1").update(seed).digest("hex");
let clock = Date.parse("2026-12-01T00:00:00.000Z");
const tick = (): string => new Date((clock += 1000)).toISOString();
type Row = Record<string, unknown>;
const unit = (pr: number, head = fake(`head-${pr}`)) => ({ pr_url: `${PULL}/${pr}`, head_sha: head });
const posted = (sha: string, pr: number): Row =>
  ({ ts: tick(), host: "core", step: "review.posted", state: "success", plan_only: false, reviewer_code_sha: sha, ...unit(pr) });
const refused = (sha: string, pr: number, head?: string): Row =>
  ({ ts: tick(), host: "core", step: "review.semantic_setup_refused", reason: "head-task-metadata-unavailable", reviewer_code_sha: sha, ...unit(pr, head) });
const withheld = (sha: string, pr: number): Row =>
  ({ ts: tick(), host: "core", step: "review.semantic_incomplete", reason: "required-semantic-incomplete-verdicts", reviewer_outcome: "success",
    reviewer_code_sha: sha, ...unit(pr) });

/** The frozen baseline the acceptance names: 0 of 5267, here over 1475 pooled shas. */
const FROZEN = { k: 0, n: 5267, shas: 1475 };
const HEALTHY = fake("healthy-before-the-storm");
const OFFENDING = fake("the-offending-merge");

/** git over one review-material merge between the healthy sha and the regression: it is blamed. */
const git: health.GitText = async (args) => {
  if (args[0] === "merge-base") return "";
  if (args[0] === "rev-list") return `${OFFENDING}\n`;
  if (args[0] === "diff") return "src/lib/review.ts\n";
  if (args[0] === "log") return "fix(review): refuse incomplete required semantic evaluation (#102)\n";
  throw new Error(`git ${args.join(" ")} is not in this fixture`);
};

/** Reviewer health over a state file that starts as `start`: a seed (cursor null) replays its rows one at a time. */
function harness(t: TestContext, start: Partial<health.ReviewerHealthState>) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}lone-refusal-`));
  t.after(() => execFileSync("rm", ["-rf", dir]));
  const statePath = join(dir, "reviewer-health.json");
  health.saveReviewerHealthState(statePath, { ...health.emptyReviewerHealthState(), ...start });
  const queue: Row[] = [];
  const logs: Array<{ step: string; extra: Row }> = [];
  const issues: string[] = [];
  const reverts: MainRepairRevertRequest[] = [];
  const gateway: AsyncIssueGateway = {
    create: async (title) => { issues.push(title); return `https://github.com/acme/remudero/issues/${issues.length}`; },
    listOpen: async () => [],
    ensureLabel: async () => true,
    comment: async () => undefined,
    closeWithComment: async () => undefined,
  };
  const lane: MainRepairLane = {
    openFixPr: async () => { throw new Error("a reviewer regression opens no fix PR"); },
    openRevertPr: async (request) => { reverts.push(request); return { prUrl: `${PULL}/900` }; },
    readPr: async () => ({ state: "open" as const }),
    closePr: async () => undefined,
  };
  const escalation = { issues: gateway, ledgerPath: join(dir, "ledger.ndjson"), runId: "lone-refusal-test" };
  const evaluate = (originMainSha: string | null) => health.evaluateReviewerHealthNow({ originMainSha }, statePath,
    async () => ({ rows: queue.splice(0), cursor: { liveOffset: 0 } }), git, escalation, lane,
    (step, extra = {}) => { logs.push({ step, extra }); }, { iso: () => new Date(clock).toISOString() });
  const state = () => health.loadReviewerHealthState(statePath);
  const regressed = () => Object.values(state().shas).filter((rec) => rec.regressedAt !== undefined).map((rec) => rec.sha);
  return { queue, logs, issues, reverts, evaluate, state, regressed, steps: (step: string) => logs.filter((l) => l.step === step) };
}

/** The seed's start: no cursor, so every row is judged as it arrives, against the frozen baseline. */
const seedFromFrozen = (): Partial<health.ReviewerHealthState> => ({ pooled: { ...FROZEN }, seq: FROZEN.shas });
const sig = (value: number, digits: number): number => Number(value.toPrecision(digits));
/** The Wilson score interval origin/main judged with, written out here independently of any module. */
const wilson = (k: number, n: number, z: number): { lower: number; upper: number } => {
  const p = k / n, z2 = z * z, scale = 1 + z2 / n, centre = (p + z2 / (2 * n)) / scale;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / scale;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
};

test("W1-T13392 criterion 1: against the frozen baseline 0 of 5267 at family 2152, a sha at 1 of 1, 1 of 6 and 1 of 21 reads not regressed", async (t) => {
  // 2151 pooled shas and the one judged here: the family of 2152 the acceptance names.
  const h = harness(t, { pooled: { k: 0, n: 5267, shas: 2151 }, seq: 2151, seededAt: "2026-11-22T00:00:00.000Z", cursor: { liveOffset: 0 } });
  const sha = fake("one-refused-pr-head");
  const tail = health.REVIEWER_HEALTH_FAMILY_ALPHA / (2 * 2152);
  let pr = 1;
  const cases: Array<[number, number, number, number]> = [[1, 1, 2.323e-6, 0.0455], [6, 5, 3.872e-7, 0.0073], [21, 15, 1.106e-7, 0.0021]];
  for (const [n, add, exactLower, wilsonLower] of cases) {
    if (n === 1) h.queue.push(refused(sha, pr++));
    else for (let i = 0; i < add; i++) h.queue.push(posted(sha, pr++));
    await h.evaluate(sha);
    const judged = health.judgeReviewerSha(h.state(), sha);
    assert.notEqual(judged.state, "regressed", `1 of ${n} reads ${judged.state}, not regressed`);
    assert.equal(judged.k, 1);
    assert.equal(judged.n, n);
    assert.deepEqual(judged.baseline, { k: 0, n: 5267 });
    if (n === 1) assert.ok(Math.abs(judged.interval!.lower - tail) < 1e-15, "1 of 1's exact lower bound IS the family tail of 2152 shas");
    assert.equal(sig(judged.interval!.lower, 4), exactLower, `the exact lower bound of 1 of ${n}`);
    assert.equal(sig(judged.baselineInterval!.upper, 3), 0.00246, "the exact upper bound of 0 of 5267");
    // origin/main's bound, for the record: Wilson at the same tail's z, against the baseline's Wilson upper 0.00397.
    assert.equal(sig(wilson(0, 5267, judged.z!).upper, 3), 0.00397);
    assert.equal(sig(wilson(1, n, judged.z!).lower, wilsonLower < 0.01 ? 2 : 3), wilsonLower, `origin/main's Wilson lower of 1 of ${n}`);
  }
  assert.deepEqual(h.regressed(), [], "no sha reads regressed");
  assert.equal(h.state().incident, null);
  assert.equal(h.steps("reviewer.regression_opened").length, 0);
  assert.deepEqual(h.issues, [], "no issue is raised from one unposted review");
});

test("W1-T13392 criterion 2: a thin total outage, 30 shas of 2 refused units each, opens on the run of unproven shas at k=3 n=3", async (t) => {
  const h = harness(t, seedFromFrozen());
  const shas = Array.from({ length: 30 }, (_, i) => fake(`thin-${i}`));
  let pr = 1000;
  for (let j = 0; j < 7; j++) h.queue.push(posted(HEALTHY, pr++));
  for (const sha of shas) h.queue.push(refused(sha, pr++), refused(sha, pr++));
  const decision = await h.evaluate(shas.at(-1)!);
  const state = h.state();
  const incident = state.incident!;
  assert.ok(incident, "the outage opens an incident");
  assert.equal(incident.regressedSha, shas[1], "on the second sha's first refusal: the first sha's two and its one");
  assert.equal(incident.evidence.k, 3);
  assert.equal(incident.evidence.n, 3);
  assert.equal(incident.evidence.run?.shas, 2, "judged on the run of two unproven shas");
  assert.equal(incident.evidence.run?.since, HEALTHY, "the run starts after the newest sha whose own sample reads healthy");
  assert.deepEqual(incident.evidence.baseline, { k: 0, n: 5267 + 7 }, "against the history before the run");
  assert.equal(incident.offending?.sha, OFFENDING);
  assert.equal(h.regressed().length, 29, "every later sha joins it");
  assert.equal(h.steps("reviewer.regression_opened").length, 1);
  assert.equal(h.issues.length, 1, "raised once");
  assert.equal(decision.route, "healed");
  // Judged per sha without the run it never opens: 2 of 2 at this tail stays below the baseline's upper bound.
  for (const family of [FROZEN.shas + 2, FROZEN.shas + 1 + shas.length]) {
    const tail = health.REVIEWER_HEALTH_FAMILY_ALPHA / (2 * family);
    assert.ok(health.clopperPearsonInterval(2, 2, tail).lower <= health.clopperPearsonInterval(0, FROZEN.n + 7, tail).upper,
      `one thin sha's own 2 of 2 cannot read regressed at a family of ${family}`);
  }
});

test("W1-T13392 criterion 3: the stuck shape and the trickle shape open nothing: 0 regressed of 200 shas, where origin/main judges 200 and 8", async (t) => {
  // Stuck: 200 shas of 7 posted reviews, and one PR head refused again at every sha.
  const stuck = harness(t, seedFromFrozen());
  const stuckShas = Array.from({ length: 200 }, (_, i) => fake(`stuck-${i}`));
  const stuckHead = fake("the-one-refused-head");
  let pr = 2000;
  for (const sha of stuckShas) {
    stuck.queue.push(refused(sha, 999, stuckHead));
    for (let j = 0; j < 7; j++) stuck.queue.push(posted(sha, pr++));
  }
  await stuck.evaluate(stuckShas.at(-1)!);
  assert.equal(stuckShas.filter((sha) => stuck.state().shas[sha] !== undefined).length, 200, "all 200 shas judged");
  assert.deepEqual(stuck.regressed(), [], "0 regressed of 200 stuck shas");
  assert.equal(stuck.state().incident, null);
  assert.deepEqual(stuck.state().closed, [], "nothing opened, so nothing is carried");
  // Trickle: by-design input refusals, one NEW head refused every 25 shas of 7 posted reviews.
  const trickle = harness(t, seedFromFrozen());
  const trickleShas = Array.from({ length: 200 }, (_, i) => fake(`trickle-${i}`));
  trickleShas.forEach((sha, i) => {
    if (i % 25 === 0) trickle.queue.push(refused(sha, 5000 + i));
    for (let j = 0; j < 7; j++) trickle.queue.push(posted(sha, pr++));
  });
  await trickle.evaluate(trickleShas.at(-1)!);
  assert.deepEqual(trickle.regressed(), [], "0 regressed of 200 trickle shas");
  assert.equal(trickle.state().incident, null);
  assert.deepEqual(trickle.state().closed, []);
  assert.equal(stuck.steps("reviewer.regression_carried").length + trickle.steps("reviewer.regression_carried").length, 0);
});

test("W1-T13392 criterion 4: invariant:a-real-regression-still-opens — the 10-20 storm opens one incident naming the offending merge, at k=3 n=3", async (t) => {
  const h = harness(t, seedFromFrozen());
  let pr = 3000;
  for (let j = 0; j < 7; j++) h.queue.push(posted(HEALTHY, pr++));
  // Six shas, five PRs each, every review withheld after the reviewer ran or refused at setup.
  const storm = Array.from({ length: 6 }, (_, i) => fake(`storm-${i}`));
  for (const sha of storm) for (let u = 0; u < 5; u++) h.queue.push(u % 2 === 1 ? withheld(sha, pr++) : refused(sha, pr++));
  const decision = await h.evaluate(storm.at(-1)!);
  const incident = h.state().incident!;
  assert.ok(incident, "the storm opens");
  assert.equal(h.steps("reviewer.regression_opened").length, 1, "one incident");
  assert.equal(incident.regressedSha, storm[0]);
  assert.equal(incident.evidence.k, 3, "on its third unposted review");
  assert.equal(incident.evidence.n, 3);
  assert.equal(incident.lastHealthySha, HEALTHY);
  assert.equal(incident.offending?.sha, OFFENDING, "it names the offending merge");
  assert.equal(incident.offending?.pr, 102);
  assert.deepEqual(incident.signature, ["head-task-metadata-unavailable", "required-semantic-incomplete-verdicts"]);
  assert.deepEqual(h.regressed().sort(), [...storm].sort(), "every storm sha joins the one incident");
  assert.equal(h.issues.length, 1);
  assert.equal(h.reverts.length, 1, "one revert PR of the offending merge");
  assert.equal(h.reverts[0]!.offendingSha, OFFENDING);
  assert.equal(decision.route, "healed");
});

test("W1-T13392: a sha whose own sample reads regressed opens though the thin clean shas before it would dilute its run", async (t) => {
  const h = harness(t, seedFromFrozen());
  let pr = 4000;
  for (let j = 0; j < 7; j++) h.queue.push(posted(HEALTHY, pr++));
  // Two hundred thin shas of one posted review each: each too thin to read healthy, so all of them are the run,
  // and five refusals in 205 units never read regressed there.
  for (let i = 0; i < 200; i++) h.queue.push(posted(fake(`thin-clean-${i}`), pr++));
  const storm = fake("storm-after-thin-clean");
  for (let u = 0; u < 5; u++) h.queue.push(refused(storm, pr++));
  await h.evaluate(storm);
  const incident = h.state().incident!;
  assert.ok(incident, "the storm opens on its own sample");
  assert.equal(incident.regressedSha, storm);
  assert.equal(incident.evidence.n, incident.evidence.k, "judged on its own all-failing sample");
  assert.equal(incident.evidence.run, undefined, "not on the diluted run");
});

test("W1-T13392: the exact bound reproduces known Clopper-Pearson intervals", () => {
  // Two-sided 95% (each tail 0.025), as R's binom.test prints them; and one at a 0.005 tail.
  const known: Array<[number, number, number, number, number]> = [
    [5, 10, 0.025, 0.1870860, 0.8129140], [7, 20, 0.025, 0.1539092, 0.5921885], [1, 2, 0.025, 0.0125791, 0.9874209],
    [0, 10, 0.025, 0, 0.3084971], [3, 7, 0.005, 0.0552993, 0.8822962],
  ];
  for (const [k, n, tail, lower, upper] of known) {
    const interval = health.clopperPearsonInterval(k, n, tail);
    assert.ok(Math.abs(interval.lower - lower) < 5e-7, `${k} of ${n} lower ${interval.lower} vs ${lower}`);
    assert.ok(Math.abs(interval.upper - upper) < 5e-7, `${k} of ${n} upper ${interval.upper} vs ${upper}`);
  }
  // Closed forms: k = 0 and k = n, and a large n whose terms would underflow a direct product.
  assert.ok(Math.abs(health.clopperPearsonInterval(4, 4, 1e-3).lower - Math.pow(1e-3, 1 / 4)) < 1e-12);
  assert.ok(Math.abs(health.clopperPearsonInterval(0, 5267, 2.3234e-6).upper - -Math.expm1(Math.log(2.3234e-6) / 5267)) < 1e-12);
  const big = health.clopperPearsonInterval(2500, 5000, 0.025);
  assert.ok(big.lower > 0.48 && big.lower < 0.5 && big.upper > 0.5 && big.upper < 0.52, JSON.stringify(big));
  const coin = health.clopperPearsonInterval(0, 1, 0.5);
  assert.equal(coin.lower, 0);
  assert.ok(Math.abs(coin.upper - 0.5) < 1e-15, `0 of 1 upper at tail one half: ${coin.upper}`);
});
