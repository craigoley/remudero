/**
 * W1-T14321 — A PR HEAD REFUSED AT EVERY MAIN COMMIT COUNTS ONCE. The reviewer-health unit is a PR head per reviewer
 * code sha, so one head the reviewer refuses for its own input (a missing task record, say) is counted again at every
 * main commit, and its one failure reads as a failure of every reviewer sha after it. A (unit, reason) already recorded
 * at an earlier sha, with no post of the unit since, is now CARRIED: it joins neither k nor n of the later sha, the way
 * W1-T13849's first hold joins neither. A head that posted since, or fails for a new reason, counts as before.
 * INVARIANT counting-within-one-sha-is-unchanged: within one reviewer sha, posted wins over a refusal and a pending unit
 * holds, exactly as origin/main's shaCounts and recordOutcome. Every effect is an injected fake; git is a stub.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import type { MainRepairLane } from "#src/lib/main-health-rung.js";
import { DOWNGRADE_UNCLASSIFIED } from "#src/lib/review-outcome-class.js";
import * as health from "#src/lib/reviewer-health.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const PULL = "https://github.com/acme/remudero/pull";
const fake = (seed: string): string => createHash("sha1").update(seed).digest("hex");
let clock = Date.parse("2026-12-01T00:00:00.000Z");
const tick = (): string => new Date((clock += 1000)).toISOString();
type Row = Record<string, unknown>;
const REFUSAL = "head-task-metadata-unavailable";
const unit = (pr: number, head = fake(`head-${pr}`)) => ({ pr_url: `${PULL}/${pr}`, head_sha: head });
const unitKey = (pr: number, head = fake(`head-${pr}`)) => `${PULL}/${pr}#${head}`;
const healedField = (incident?: string) => (incident === undefined ? {} : { incident_id: incident });
const posted = (sha: string, pr: number, head?: string, incident?: string): Row =>
  ({ ts: tick(), host: "core", step: "review.posted", state: "success", plan_only: false, reviewer_code_sha: sha, ...unit(pr, head), ...healedField(incident) });
const refused = (sha: string, pr: number, head?: string, reason = REFUSAL, incident?: string): Row =>
  ({ ts: tick(), host: "core", step: "review.semantic_setup_refused", reason, reviewer_code_sha: sha, ...unit(pr, head), ...healedField(incident) });
const withheld = (sha: string, pr: number, head?: string, outcome = "success", reason = "required-semantic-incomplete-verdicts"): Row =>
  ({ ts: tick(), host: "core", step: "review.semantic_incomplete", reason, reviewer_outcome: outcome, reviewer_code_sha: sha, ...unit(pr, head) });
const held = (sha: string, pr: number, head?: string, digest = "input-a"): Row =>
  ({ ...withheld(sha, pr, head, "success", DOWNGRADE_UNCLASSIFIED), review_input_digest: digest });

/** The frozen baseline W1-T13392's replay starts from: 0 of 5267 over 1475 pooled shas. */
const FROZEN = { k: 0, n: 5267, shas: 1475 };
const git: health.GitText = async (args) => { throw new Error(`git ${args.join(" ")} is not in this fixture`); };

/** Reviewer health through the production evaluation over a state file that starts from the frozen baseline. */
function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}counts-once-`));
  t.after(() => execFileSync("rm", ["-rf", dir]));
  const statePath = join(dir, "reviewer-health.json");
  health.saveReviewerHealthState(statePath, { ...health.emptyReviewerHealthState(), pooled: { ...FROZEN }, seq: FROZEN.shas,
    seededAt: "2026-11-22T00:00:00.000Z", cursor: { liveOffset: 0 } });
  const queue: Row[] = [];
  const steps: string[] = [];
  const issues: AsyncIssueGateway = { create: async () => "https://github.com/acme/remudero/issues/1", listOpen: async () => [],
    ensureLabel: async () => true, comment: async () => undefined, closeWithComment: async () => undefined };
  const lane: MainRepairLane = { openFixPr: async () => { throw new Error("no fix PR"); }, openRevertPr: async () => ({ refused: "fixture" }),
    readPr: async () => ({ state: "closed" as const }), closePr: async () => undefined };
  const evaluate = (originMainSha: string) => health.evaluateReviewerHealthNow({ originMainSha }, statePath,
    async () => ({ rows: queue.splice(0), cursor: { liveOffset: 0 } }), git,
    { issues, ledgerPath: join(dir, "ledger.ndjson"), runId: "counts-once-test" }, lane,
    (step) => { steps.push(step); }, { iso: () => new Date(clock).toISOString() });
  return { queue, steps, evaluate, state: () => health.loadReviewerHealthState(statePath) };
}

/** Fold rows into a fresh in-memory state, as the reader does. */
function ingest(rows: Row[], state = health.emptyReviewerHealthState()): health.ReviewerHealthState {
  health.ingestReviewerHealthRows(state, rows);
  return state;
}

/**
 * origin/main's per-sha counting, written out here independently of the module: one unit per PR head per sha; a unit
 * that ever posted at the sha is posted, else its newest class stands, and a first hold per head and digest is pending
 * and never displaces a class. k counts refusals and withholds after the reviewer ran; withheld after a reviewer
 * failure, and a pending hold, are in neither. It carries nothing across shas.
 */
function originMainCounts(rows: Row[]): Map<string, { units: Map<string, string>; reasons: Map<string, number>; k: number; n: number }> {
  const shas = new Map<string, { units: Map<string, string>; reasons: Map<string, number>; k: number; n: number }>();
  const holds = new Map<string, string>();
  for (const row of rows) {
    const sha = String(row.reviewer_code_sha);
    const key = `${String(row.pr_url)}#${String(row.head_sha)}`;
    const rec = shas.get(sha) ?? { units: new Map<string, string>(), reasons: new Map<string, number>(), k: 0, n: 0 };
    shas.set(sha, rec);
    let cls = row.step === "review.posted" ? "posted" : row.step === "review.semantic_setup_refused" ? "setup-refused"
      : row.reviewer_outcome === "success" ? "withheld-success" : "withheld-failure";
    if (cls === "withheld-success" && row.reason === DOWNGRADE_UNCLASSIFIED && row.review_input_digest !== undefined) {
      const holdKey = `${key}\u0000${String(row.review_input_digest)}`;
      const first = holds.get(holdKey);
      if (first === undefined) { holds.set(holdKey, `${sha}@${String(row.ts)}`); cls = "withheld-pending"; }
      else if (first === `${sha}@${String(row.ts)}`) cls = "withheld-pending";
    }
    const prior = rec.units.get(key);
    if (prior === "posted" || (cls === "withheld-pending" && prior !== undefined)) continue;
    rec.units.set(key, cls);
    const failing = cls === "withheld-success" || cls === "setup-refused";
    if (failing && (prior === undefined || prior === "withheld-pending")) {
      const reason = String(row.reason ?? cls);
      rec.reasons.set(reason, (rec.reasons.get(reason) ?? 0) + 1);
    }
  }
  for (const rec of shas.values()) {
    rec.k = 0; rec.n = 0;
    for (const cls of rec.units.values()) {
      if (cls === "withheld-failure" || cls === "withheld-pending") continue;
      rec.n += 1;
      if (cls !== "posted") rec.k += 1;
    }
  }
  return shas;
}

test("W1-T14321 criterion 1: the stuck shape, one head refused at each of 200 shas, carries 199 of the 200 repeats out of k and n; on origin/main all 200 count", async (t) => {
  const h = harness(t);
  const shas = Array.from({ length: 200 }, (_, i) => fake(`stuck-${i}`));
  const stuckHead = fake("the-one-refused-head");
  const rows: Row[] = [];
  let pr = 2000;
  for (const sha of shas) {
    rows.push(refused(sha, 999, stuckHead));
    for (let j = 0; j < 7; j++) rows.push(posted(sha, pr++));
  }
  h.queue.push(...rows);
  await h.evaluate(shas.at(-1)!);
  const state = h.state();
  const stuck = unitKey(999, stuckHead);
  assert.equal(shas.filter((sha) => state.shas[sha] !== undefined).length, 200, "all 200 shas are tracked");
  assert.equal(state.shas[shas[0]!]!.units[stuck], "setup-refused", "the first sha that refused the head counts it");
  assert.deepEqual(health.shaCounts(state.shas[shas[0]!]!), { k: 1, n: 8 });
  const carried = shas.slice(1).filter((sha) => state.shas[sha]!.units[stuck] === "carried");
  assert.equal(carried.length, 199, "199 of the 200 repeats are carried");
  for (const sha of shas.slice(1)) {
    assert.deepEqual(health.shaCounts(state.shas[sha]!), { k: 0, n: 7 }, "a carried repeat joins neither k nor n");
    assert.deepEqual(state.shas[sha]!.reasons, {}, "nor the sha's failure signature");
  }
  const total = shas.reduce((sum, sha) => { const c = health.shaCounts(state.shas[sha]!); return { k: sum.k + c.k, n: sum.n + c.n }; }, { k: 0, n: 0 });
  assert.deepEqual(total, { k: 1, n: 1401 }, "the head counts once over the 200 shas");
  assert.deepEqual(state.carriedFailures?.[stuck], { [REFUSAL]: { sha: shas[0], at: rows[0]!.ts } }, "recorded at its first sha");
  // origin/main counts the head again at every sha: 200 failing units, 1600 in n.
  const main = originMainCounts(rows);
  assert.equal([...main.values()].filter((rec) => rec.units.get(stuck) === "setup-refused").length, 200, "on origin/main all 200 count");
  assert.deepEqual([...main.values()].reduce((sum, rec) => ({ k: sum.k + rec.k, n: sum.n + rec.n }), { k: 0, n: 0 }), { k: 200, n: 1600 });
  assert.equal(state.incident, null);
  assert.deepEqual(h.steps.filter((step) => step.startsWith("reviewer.regression_")), []);
});

/**
 * THE RECORDED ROWS, 2026-10-19 to 2026-11-22: every reviewer-health row of the live ledger (9945 rows, 5650 outcomes,
 * 1429 evaluations here), as the W1-T13392 and W1-T13393 replays read them (one evaluation per row), reduced for the sha
 * judgment. Replayed under origin/main's counting it gives what origin/main's own code gave over the full rows: the same
 * 6 openings at the same k and n, 14 extensions and 6 closes; only a close's pooled count can differ, as posts batch.
 * - a legacy row naming no reviewer sha is attributed as ingestReviewerHealthRows attributes it (per host and PR, to its
 *   fresh-tree row's sha or the host's prior boot head) and recorded at that flush: one evaluation with no current sha,
 *   `{entry,...}`;
 * - every row of a head that ever fails is kept: `<K><head>.<sha>[.<reason>]:<row index>`, K being P posted, R refused at
 *   setup, W withheld after the reviewer ran, F withheld after it failed; the row index orders the rows in time;
 * - any other head adds only its first post at each sha (it reads posted there from that row on, and nothing else of it
 *   counts), so consecutive such posts at one sha are one evaluation `p<sha>[*<count>]`;
 * - `!` is 2026-10-24T14:07:52Z, from which the live revert was refused: the replay records the healed-tree conflict on
 *   any open incident, as the review route met it.
 * Heads, shas and PRs are small ids; the reasons are the review lane's own.
 */
const RECORDED_REASONS = ["required-semantic-incomplete-verdicts", "head-task-metadata-unavailable", "required-semantic-spawn_error"];
const RECORDED = `
p0 p1 p2 p3*2 p4 p5*2 p6 p7*6 p8*7 p9*4 p10*3 p11*4 p12*3 p13 p14*3 p15*2 p16*3 p17*6 p18*3 p19*4 p20*7 p21*5 p22
p23*2 p24*3 p25*4 p26 p27*4 p28*7 p29 p30 p29 p30 {W0.31.0:197} p30 {W0.31.0:205} p30 {W1.32.0:210} {R2.33.1:265}
{R3.33.1:248,R3.33.1:250,R3.33.1:253,R3.33.1:255,R3.33.1:256,R3.33.1:260,R3.33.1:267} {W4.33.0:271} {R3.33.1:273}
{R2.33.1:275} {R3.33.1:277} {W5.33.0:234,W5.33.0:279} {R2.33.1:281} {R2.33.1:283} {R3.33.1:285} {R6.33.1:287}
{R2.34.1:289} {R3.34.1:291} {W5.33.0:294} {R2.34.1:297} {R3.34.1:299} {W7.34.0:301} {R6.34.1:303} {R3.34.1:305}
{R2.34.1:308} {W5.34.0:310} {W8.34.0:239,W8.34.0:312} {R3.35.1:314} {R2.35.1:316} {W5.35.0:318}
{W0.36.0:214,W0.36.0:217,W0.36.0:244,W9.36.0:320} {R3.36.1:322} {R2.36.1:324} {W10.36.0:225,W11.36.0:242,W11.36.0:326}
{R3.36.1:328} {W8.36.0:330} {W11.36.0:332} {R2.36.1:334} {W12.36.0:336} {W11.36.0:338} {R3.36.1:340} {W5.36.0:342}
{F8.36.2:344} {R2.36.1:346} {W13.36.0:348} {R3.36.1:350} {R2.36.1:352} {W11.36.0:353} {W8.36.0:356} {W12.36.0:358}
{W11.36.0:361} {W14.36.0:215,W14.36.0:219,W14.36.0:245,W14.36.0:360}
{W15.36.0:216,W15.36.0:220,W15.36.0:246,W15.36.0:364} {W5.36.0:366} {R3.36.1:368} {W8.36.0:370} {R2.36.1:372}
{F13.36.2:374}
{W16.37.0:213,W16.37.0:223,W17.37.0:232,W17.37.0:233,W17.37.0:264,W17.37.0:398,W17.37.0:407,W18.37.0:218,W19.37.0:237,W20.37.0:258,P20.37:307,R21.37.1:221,R21.37.1:222,R21.37.1:224,R21.37.1:227,R21.37.1:231,W22.37.0:226,W22.37.0:254,W22.37.0:259,W22.37.0:384,W23.37.0:230,W24.37.0:247,P24.37:263,W25.37.0:236,W26.37.0:257,W26.37.0:394,W26.37.0:408,W27.37.0:251,W27.37.0:262,W28.37.0:403,W29.37.0:252,W29.37.0:261,W29.37.0:390,W11.37.0:379,W14.37.0:380,W15.37.0:381,W30.37.0:382,W8.37.0:385,R3.37.1:386,R3.37.1:392,R3.37.1:395,R3.37.1:396,R3.37.1:399,R3.37.1:402,R3.37.1:404,R3.37.1:410,R3.37.1:414,R3.37.1:415,R2.37.1:387,R2.37.1:393,R2.37.1:401,R2.37.1:405,R2.37.1:412,R2.37.1:416,W5.37.0:388,W31.37.0:389,W31.37.0:409,W7.37.0:391,W9.37.0:397,W9.37.0:406,W12.37.0:400,W12.37.0:411,W32.37.0:413}
P33.38:703
{W11.39.0:418,W11.39.0:488,W11.39.0:572,W33.39.0:622,W14.39.0:419,W34.39.0:437,W34.39.0:501,W34.39.0:585,W34.39.0:657,W34.39.0:754,W9.39.0:420,W9.39.0:491,W9.39.0:573,W9.39.0:639,W9.39.0:735,W30.39.0:421,W30.39.0:487,W30.39.0:566,W30.39.0:569,W30.39.0:638,W30.39.0:729,W15.39.0:422,W15.39.0:492,W15.39.0:575,W15.39.0:646,W15.39.0:745,W17.39.0:423,W17.39.0:493,W17.39.0:576,W17.39.0:644,W35.39.0:689,W22.39.0:424,W22.39.0:496,W36.39.0:514,W36.39.0:521,W36.39.0:591,W36.39.0:665,W36.39.0:760,W26.39.0:425,W26.39.0:495,W26.39.0:577,W26.39.0:649,W37.39.0:750,R3.39.1:426,R3.39.1:435,R3.39.1:438,R3.39.1:441,R3.39.1:445,R3.39.1:448,R3.39.1:451,R3.39.1:455,R3.39.1:457,R3.39.1:460,R3.39.1:462,R3.39.1:465,R3.39.1:468,R3.39.1:471,R3.39.1:476,R3.39.1:480,R3.39.1:482,R3.39.1:486,R3.39.1:497,R3.39.1:499,R3.39.1:511,R3.39.1:516,R3.39.1:519,R3.39.1:523,R3.39.1:527,R3.39.1:529,R3.39.1:532,R3.39.1:535,R3.39.1:540,R3.39.1:541,R3.39.1:547,R3.39.1:549,R3.39.1:551,R3.39.1:554,R3.39.1:559,R3.39.1:561,R3.39.1:564,R3.39.1:568,R3.39.1:578,R3.39.1:582,R3.39.1:586,R3.39.1:595,R3.39.1:600,R3.39.1:604,R3.39.1:606,R3.39.1:610,R3.39.1:614,R3.39.1:616,R3.39.1:620,R3.39.1:624,R3.39.1:629,R3.39.1:634,R3.39.1:641,R3.39.1:647,R3.39.1:656,R3.39.1:658,R3.39.1:659,R3.39.1:668,R3.39.1:674,R3.39.1:676,R3.39.1:678,R3.39.1:681,R3.39.1:684,R3.39.1:692,R3.39.1:695,R3.39.1:697,R3.39.1:701,R3.39.1:705,R3.39.1:709,R3.39.1:712,R3.39.1:715,R3.39.1:719,R3.39.1:721,R3.39.1:724,R3.39.1:727,R3.39.1:730,R38.39.1:736,R38.39.1:739,R38.39.1:741,R38.39.1:742,R38.39.1:753,R38.39.1:755,R38.39.1:757,R38.39.1:763,W8.39.0:427,W8.39.0:498,W8.39.0:583,W8.39.0:653,W8.39.0:756,W5.39.0:428,W5.39.0:504,W5.39.0:581,W5.39.0:650,W5.39.0:746,W39.39.0:429,W39.39.0:503,W39.39.0:587,W39.39.0:667,W39.39.0:765,W29.39.0:430,W29.39.0:502,W40.39.0:589,W40.39.0:662,W40.39.0:764,R2.39.1:431,R2.39.1:436,R2.39.1:439,R2.39.1:442,R2.39.1:444,R2.39.1:447,R2.39.1:450,R2.39.1:454,R2.39.1:456,R2.39.1:461,R2.39.1:463,R2.39.1:466,R2.39.1:469,R2.39.1:472,R2.39.1:475,R2.39.1:479,R2.39.1:483,R2.39.1:490,R2.39.1:505,R2.39.1:510,R2.39.1:517,R2.39.1:518,R2.39.1:524,R2.39.1:526,R2.39.1:530,R2.39.1:531,R2.39.1:534,R2.39.1:539,R2.39.1:542,R2.39.1:545,R2.39.1:548,R2.39.1:552,R2.39.1:555,R2.39.1:557,R2.39.1:562,R2.39.1:565,R2.39.1:570,R2.39.1:579,R2.39.1:588,R2.39.1:594,R2.39.1:599,R2.39.1:603,R2.39.1:611,R2.39.1:615,R2.39.1:617,R2.39.1:619,R2.39.1:625,R2.39.1:627,R2.39.1:630,R2.39.1:636,R2.39.1:642,R2.39.1:651,R2.39.1:655,R2.39.1:660,R2.39.1:663,R2.39.1:669,R2.39.1:672,R2.39.1:675,R2.39.1:679,R2.39.1:682,R2.39.1:685,R2.39.1:690,R2.39.1:694,R2.39.1:699,R2.39.1:700,R2.39.1:704,R2.39.1:707,R2.39.1:713,R2.39.1:716,R2.39.1:718,R2.39.1:720,R2.39.1:723,R2.39.1:726,R2.39.1:732,R2.39.1:733,R2.39.1:737,R2.39.1:743,R2.39.1:747,R2.39.1:751,R2.39.1:758,R2.39.1:761,W31.39.0:432,W31.39.0:508,W31.39.0:593,W31.39.0:598,W31.39.0:671,W12.39.0:433,W12.39.0:506,W12.39.0:597,W41.39.0:648,W41.39.0:749,W7.39.0:434,W42.39.0:459,W42.39.0:467,W42.39.0:544,W42.39.0:608,W42.39.0:687,R43.39.1:440,R43.39.1:443,R43.39.1:446,R43.39.1:449,W44.39.0:452,W44.39.0:509,W45.39.0:560,W45.39.0:623,W45.39.0:710,W46.39.0:458,W46.39.0:464,W46.39.0:537,W46.39.0:607,W46.39.0:688,R47.39.1:470,R47.39.1:473,R47.39.1:477,R47.39.1:478,R47.39.1:484,R47.39.1:489,R47.39.1:507,R47.39.1:512,R47.39.1:515,R47.39.1:520,R47.39.1:522,R47.39.1:525,R47.39.1:528,R47.39.1:533,R47.39.1:536,R47.39.1:538,R47.39.1:543,R47.39.1:546,R47.39.1:550,R47.39.1:553,R47.39.1:556,R47.39.1:558,R47.39.1:563,R47.39.1:567,R47.39.1:571,R47.39.1:580,R47.39.1:590,R47.39.1:596,R47.39.1:602,R47.39.1:605,R47.39.1:612,R47.39.1:613,R47.39.1:618,R47.39.1:621,R47.39.1:626,R47.39.1:628,R47.39.1:631,R47.39.1:635,R47.39.1:643,R47.39.1:652,R47.39.1:654,R47.39.1:661,R47.39.1:664,R47.39.1:670,R47.39.1:673,R47.39.1:677,R47.39.1:680,R47.39.1:683,R47.39.1:686,R47.39.1:691,R47.39.1:696,R47.39.1:698,R47.39.1:702,R47.39.1:706,R47.39.1:708,R47.39.1:711,R47.39.1:714,R47.39.1:717,R47.39.1:722,R47.39.1:725,R47.39.1:728,R47.39.1:731,R47.39.1:734,R47.39.1:738,R47.39.1:744,R47.39.1:748,R47.39.1:752,R47.39.1:759,R47.39.1:762,W48.39.0:601,W48.39.0:609,W49.39.0:633,W49.39.0:640,P49.39:666}
P8.40:973
{R47.41.1:810,R47.41.1:813,R47.41.1:816,R47.41.1:825,R47.41.1:828,R47.41.1:832,R47.41.1:834,R47.41.1:838,R47.41.1:840,R47.41.1:843,R47.41.1:847,R47.41.1:851,R47.41.1:855,R47.41.1:864,R47.41.1:884,R47.41.1:886,R47.41.1:892,R47.41.1:897,R47.41.1:910,R47.41.1:918,R47.41.1:929,R47.41.1:940,R47.41.1:961,R47.41.1:965,R47.41.1:975}
P50.41:978 {W51.41.0:819,W50.41.0:857,W50.41.0:920,W50.41.0:967} p41 {W52.41.0:935} P53.42:984
{W53.42.0:912,W53.42.0:979} P54.42:986 {W54.42.0:911,W54.42.0:972} p42 p43
{R38.44.1:800,R38.44.1:803,R38.44.1:814,R38.44.1:827,R38.44.1:830,R38.44.1:833,R38.44.1:836,R38.44.1:839,R38.44.1:842,R38.44.1:845,R38.44.1:849,R38.44.1:852,R38.44.1:856,R38.44.1:860,R38.44.1:872,R38.44.1:874,R38.44.1:879,R38.44.1:881,R38.44.1:894,R38.44.1:898,R38.44.1:905,R38.44.1:919,R38.44.1:922,R38.44.1:931,R38.44.1:936,R38.44.1:959,R38.44.1:963,R38.44.1:970,R38.44.1:994}
p43
{R2.44.1:801,R2.44.1:804,R2.44.1:815,R2.44.1:826,R2.44.1:829,R2.44.1:831,R2.44.1:835,R2.44.1:837,R2.44.1:841,R2.44.1:844,R2.44.1:848,R2.44.1:850,R2.44.1:854,R2.44.1:863,R2.44.1:871,R2.44.1:877,R2.44.1:880,R2.44.1:891,R2.44.1:896,R2.44.1:909,R2.44.1:917,R2.44.1:925,R2.44.1:933,R2.44.1:937,R2.44.1:960,R2.44.1:964,R2.44.1:971,R2.44.1:998}
{R38.44.1:1000} P55.44:1002 {W39.44.0:805,W55.44.0:853,W55.44.0:902,W55.44.0:938} P41.44:1004
{W30.45.0:792,W30.45.0:858,W30.45.0:904,W30.45.0:954,W9.45.0:793,W9.45.0:859,W9.45.0:908,W9.45.0:955,W15.45.0:794,W15.45.0:861,W15.45.0:866,W15.45.0:916,W15.45.0:958,W34.45.0:795,W34.45.0:862,W34.45.0:907,W34.45.0:957,W35.45.0:796,W35.45.0:867,W35.45.0:915,W35.45.0:956,W35.45.0:968,W37.45.0:797,W37.45.0:878,W37.45.0:924,W37.45.0:969,W36.45.0:798,W36.45.0:870,W36.45.0:914,W36.45.0:966,W5.45.0:799,W5.45.0:868,W5.45.0:921,W5.45.0:962,W8.45.0:802,W8.45.0:873,W8.45.0:927,W8.45.0:974,W40.45.0:806,W40.45.0:876,W40.45.0:926,W40.45.0:977,W31.45.0:807,W31.45.0:821,W31.45.0:887,W31.45.0:944,W42.45.0:808,W42.45.0:875,W42.45.0:928,W42.45.0:981,W45.45.0:809,W45.45.0:823,W56.45.0:890,W56.45.0:948,W46.45.0:811,W46.45.0:824,W46.45.0:885,W46.45.0:939,W46.45.0:946,W41.45.0:812,W41.45.0:883,W41.45.0:941,R57.45.1:817,R57.45.1:820,W58.45.0:888,W58.45.0:947,W59.45.0:889,W59.45.0:945,W60.45.0:893,W60.45.0:903,W60.45.0:952,W61.45.0:895,W61.45.0:901,W61.45.0:951,W62.45.0:900,W62.45.0:906,W62.45.0:950,W63.45.0:930,W64.45.0:934,W65.45.0:953}
P30.46:1006 P34.46:1007 P9.46:1008 P15.46:1009 P36.46:1010 P5.46:1013 P35.46:1014 P65.47:1015 P37.46:1017 P40.46:1018
P31.46:1019 P46.46:1020 P42.46:1021 {R47.48.1:1022} P56.46:1024 P59.48:1025 {R66.49.1:1027} P62.50:1029 P60.50:1031
{R66.51.1:1033} P58.50:1035 P61.50:1037 {R67.52.1:1038} P63.52:1041 P64.51:1043 p53 p54 P2.54:1049 {R2.54.1:1016}
P38.54:1053 {R38.54.1:1011} p54 P47.55:1059 p56*5 P30.56:1081 p56
{R67.56.1:1064,R67.56.1:1065,R67.56.1:1067,R67.56.1:1071,R67.56.1:1073,R67.56.1:1075,R67.56.1:1077,R67.56.1:1079,R67.56.1:1083,R67.56.1:1085,R67.56.1:1086,R67.56.1:1087,R67.56.1:1088,R67.56.1:1090,R67.56.1:1093,R67.56.1:1094,R68.56.1:1080,R69.56.1:1084,R69.56.1:1091,R69.56.1:1092}
p57*12
{R67.57.1:1096,R67.57.1:1097,R70.57.1:1098,R70.57.1:1101,R70.57.1:1104,R70.57.1:1107,R70.57.1:1110,R70.57.1:1112,R70.57.1:1113,R70.57.1:1116,R70.57.1:1117,R70.57.1:1121,R70.57.1:1123,R70.57.1:1126,R70.57.1:1128,R70.57.1:1129,R70.57.1:1133,R70.57.1:1135,R70.57.1:1137,R70.57.1:1142,R70.57.1:1144,R70.57.1:1146,R70.57.1:1149,R70.57.1:1151,R70.57.1:1153,R70.57.1:1154,R71.57.1:1105,R71.57.1:1106,R71.57.1:1109,R71.57.1:1111,R71.57.1:1114,R71.57.1:1115,R71.57.1:1118,R71.57.1:1120,R71.57.1:1124,R71.57.1:1125,R71.57.1:1127,R71.57.1:1130,R71.57.1:1132,R71.57.1:1134,R71.57.1:1136,R71.57.1:1141,R71.57.1:1145,R71.57.1:1148,R71.57.1:1150,R71.57.1:1152,R71.57.1:1155}
p58*4
{R70.58.1:1162,R70.58.1:1167,R70.58.1:1169,R70.58.1:1172,R70.58.1:1173,R70.58.1:1177,R70.58.1:1178,R71.58.1:1163,R71.58.1:1166,R71.58.1:1168,R71.58.1:1171,R71.58.1:1176,R71.58.1:1179}
p59*4
{R70.60.1:1185,R70.60.1:1187,R70.60.1:1188,R70.60.1:1189,R70.60.1:1190,R70.60.1:1192,R70.60.1:1193,R70.60.1:1195} p60
P71.60:1203 {R71.60.1:1184} p61 p62 p63 p64*3 p65 p66*6 p67 p68*2 p69 p70 p71 p72 p73 p74 p75*2 p76 p77 p78 p79*5
p80*7 {R72.80.1:1328,R72.80.1:1330} p81*4
{R72.81.1:1333,R72.81.1:1334,R72.81.1:1335,R72.81.1:1336,R72.81.1:1337,R72.81.1:1339,R73.81.1:1340,R73.81.1:1341,R73.81.1:1342,R73.81.1:1343,R73.81.1:1345,R73.81.1:1348,R73.81.1:1349,R73.81.1:1350,R73.81.1:1351,R73.81.1:1353,R73.81.1:1354,R73.81.1:1355,R73.81.1:1356,R73.81.1:1359,R73.81.1:1360,R73.81.1:1361,R73.81.1:1362,R73.81.1:1363,R73.81.1:1364,R73.81.1:1365,R73.81.1:1366,R73.81.1:1367,R73.81.1:1368,R73.81.1:1369,R73.81.1:1371,R73.81.1:1372,R73.81.1:1373,R73.81.1:1374,R73.81.1:1376,R73.81.1:1377,R73.81.1:1378,R73.81.1:1379,R73.81.1:1381,R73.81.1:1383,R73.81.1:1384,R73.81.1:1385,R73.81.1:1386,R73.81.1:1387}
p82*8
{R73.82.1:1389,R73.82.1:1390,R73.82.1:1391,R73.82.1:1393,R73.82.1:1397,R73.82.1:1398,R73.82.1:1399,R73.82.1:1401,R73.82.1:1402,R73.82.1:1403,R73.82.1:1405,R73.82.1:1406,R73.82.1:1407,R73.82.1:1408,R73.82.1:1410,R73.82.1:1411,R73.82.1:1412,R73.82.1:1413,R73.82.1:1414,R73.82.1:1415,R73.82.1:1416,R73.82.1:1417,R73.82.1:1421,R73.82.1:1422,R74.82.1:1423,R74.82.1:1425,R74.82.1:1426}
p83*3 P74.83:1464
{R74.83.1:1430,R74.83.1:1431,R74.83.1:1433,R74.83.1:1434,R74.83.1:1435,R74.83.1:1437,R74.83.1:1439,R74.83.1:1443,R74.83.1:1445,R74.83.1:1446,R74.83.1:1447,R74.83.1:1449,R74.83.1:1451,R74.83.1:1452,R74.83.1:1454,R74.83.1:1455,R74.83.1:1456,R74.83.1:1457,R74.83.1:1458,R74.83.1:1459,R74.83.1:1460}
p84*9 p85*10 p86 {p85} p87*3 p88 p89 p90 p91*6 p92*2 p93 p94*11 p95*2 p96 {p96*2} p97*5 p99 p100*9 p101*3 p102 p101
p102*2 p103*2 p104*10 p105*6 p106 p107*5 p108*2 p109*3 p110*3 p111*4 p112*2 p113*16 p114 p115 p116*9 p117*10 p118*8
p119*13 p120 p121 p120*3 p122 p123*3 p124*8 p125*9 p126*2 p127 p126*3 p128*9 p129*19 p130*7 p131 p130 p132*7 p133 p132
p134 p132*7 p137*10 {p138} p139*7 p140*10 p141*8 p142*2 p143 p144 p145*13 p146 p147*3 p148 p149 p148 p149 p150 p151
p152 p153 p154*3 p155*19 p156*16 p157*3 p158*2 p157 p158*3 p159*5 p160*5 R75.160.1:2403 p160 ! R75.160.1:2405 p160*5
p161*12 p162 p163*13 p164*2 p165*2 p166*3 p167*3 p168*2 p169*3 p170*2 p171 p170*3 p172*3 p173*9 p174*4 p175*7 p176*2
p177*3 p178 {p176*3} p179*10 p180*7 p181*9 p182*4 p183*6 p184*20 p185 p186*3 p187 p186*2 p188 p189*3 p190*5 p191*6
p192*2 p193*3 p194*6 p195 p196*13 p197*6 p198 p197*4 p199*21 p200*7 p201*11 p202*11 p203*3 p204 p205*3 p206 p207*8
p208 p209*4 p210*9 p211*10 p212 p213*2 p214*10 p215*13 p216*6 p217 p216*11 p218 p219 p220*9 p221*16 p222*16 p223
p222*7 p224*7 p225*3 p226 p227*19 p228*19 p229*18 p230*6 p231 p232*2 p233 p234*2 p235 p236*18 p237*20 p238*7 p239*4
p240 p241 p242 p243*16 p244*13 p245*10 p246*9 p247 p246*5 p248 p246*8 p249*26 p250*8 p251 p250*4 p252*5 p253*2 p254*5
p255 p256 p257 {p252} p258*4 p259 p258*16 p260*4 p261 p260*9 p262 p263 p264*3 p265*6 p266 p265*4 p267 p265*2 p268*21
p269*15 p270*14 p271*25 p272*12 p273 p274 p275*13 {p272*2} p276*8 p277*2 p278*6 p279 p280*7 p281 p282*2 p283*6 p284*6
p285 p284*8 p286*13 p287*20 p288*21 p289*13 p290*7 p291*18 p292*19 p293*14 p294*2 p295*3 p296*15 p297*4 p298*9 p299*13
p300*9 p301*7 p302 p301*12 p303*11 p304*14 p305*10 p306*12 p307*6 R76.307.1:4656 R77.307.1:4657 p307*2 R77.307.1:4662
R76.307.1:4663 R78.307.1:4664 p307 p308*4 R77.309.1:4674 R76.309.1:4676 p309*3 R78.310.1:4685 R79.311.1:4689 p310 p312
p313 p314*5 R77.314.1:4714 p314 R78.314.1:4718 p314 R77.314.1:4720 R76.314.1:4721 R78.314.1:4723 R76.314.1:4724
R77.314.1:4725 p314*3 R77.314.1:4735 p314 R76.314.1:4737 R77.314.1:4738 R77.314.1:4740 R76.314.1:4741 p314
R76.314.1:4743 R78.314.1:4744 p315 R78.314.1:4746 p314 p316 R76.317.1:4750 R77.317.1:4751 R78.317.1:4752 p317
R77.317.1:4756 R76.317.1:4757 R77.317.1:4759 R76.317.1:4760 p317 R77.317.1:4764 R78.317.1:4765 p317 R79.317.1:4767
R80.317.1:4768 p317*2 R78.317.1:4771 p317*3 p318 R81.318.1:4790 R82.318.1:4791 p318*3 p319 p318 R83.318.1:4804 p320*6
p321*17 R83.321.1:4846 p321 R84.321.1:4848 p321 R83.321.1:4851 p321*3 R83.321.1:4856 p321 R83.321.1:4860 p321*2
R84.321.1:4863 p321 R84.321.1:4865 p321 R83.321.1:4869 p321*2 R84.321.1:4872 R83.321.1:4873 R84.321.1:4874 p321*5
R84.321.1:4884 R83.321.1:4885 p321 R83.321.1:4887 R84.321.1:4888 R83.322.1:4891 R84.322.1:4892 R83.322.1:4895
R84.322.1:4896 p322*2 R83.322.1:4899 R84.322.1:4900 R83.322.1:4901 R84.322.1:4902 p322 R84.322.1:4906 p322
R84.322.1:4910 R85.322.1:4912 R85.322.1:4915 R84.322.1:4916 R85.322.1:4918 R84.322.1:4919 p322*2 R84.322.1:4923 p322*3
R84.322.1:4932 R85.322.1:4933 R85.322.1:4935 R84.322.1:4936 p322 R84.322.1:4939 R85.322.1:4940 R85.322.1:4942 p322*3
R84.322.1:4946 p322 R85.322.1:4949 R84.322.1:4950 R85.322.1:4953 R84.322.1:4954 R84.323.1:4955 R85.323.1:4956 p323
R84.324.1:4961 R85.324.1:4962 R85.325.1:4965 R84.325.1:4967 p325 R85.325.1:4971 p325 R85.326.1:4975 R84.326.1:4978
R85.326.1:4979 R85.326.1:4980 R84.326.1:4981 R85.326.1:4982 R86.326.1:4983 R86.326.1:4984 R85.326.1:4986
R86.326.1:4987 R86.326.1:4988 R85.326.1:4989 R86.326.1:4990 R85.326.1:4991 p325 R86.325.1:4993 R85.325.1:4994
R85.325.1:4997 R86.325.1:4998 R85.326.1:5000 R86.326.1:5001 R85.326.1:5002 R86.326.1:5003 R85.326.1:5004
R85.326.1:5005 R87.326.1:5006 R85.326.1:5008 R85.327.1:5009 R85.327.1:5010 p327*10 p328 p327*5 p328*6 p329 p328 p330*4
R88.331.1:5078 R88.331.1:5079 p331*5 p332*2 p333*3 p334 p335*4 p336 p337 p338 p339 p340*2 p341*3 p342*2 p344 p343
p345*2 p346 p347 p348 p347 p349 p350*4 p351*3 p352*4 p353*4 p354*2 p356*8 p357*4 p358*4 p359 p360*2 p361*2 p362*12
p363*2 p364*3 p365*6 p366*5 p367 p366*8 p368 p369*3 W89.370.0:5591 P89.369:5592 p371 p372*3 p373 p374*14 p375*3 p376*2
p377 p378 p379 p380 p381*7 p382 p383 p384*4 p385 p386 p385*2 p387 p388 p389 p390 p391 p392*3 p393 p394*2 p395*3 p396*4
p397*4 p398 p399*5 p400*3 p401*4 p402 p403 p402*2 p404 p405*3 p406*8 p407*2 p408*4 p409*4 p410 p411*5 p412 p411*8 p413
p414*3 p415*9 p416 p417 p418*3 p419 p420*2 p421 p422 p423*3 p424 p423*2 p425*3 p426*3 p427 p428*5 {p427} p429*2 p430*3
p431*3 p430*2 p432*2 p433 p434*3 p435*4 p436*5 p437*2 p438*2 p439*3 p440 p439*10 p441 p442*8 p443*4 p444 p445*2 p446*5
p447*9 p448*4 p449*9 {p449} p450*4 p451*8 p452 p453*2 p454*10 p455*6 p456*6 {p456} p457*5 p458*3 W90.458.0:6421 p459*3
p460*12 p461*2 p462 p461*8 p463*2 p464*4 p465*3 p466*13 p467*15 p468*10 p469 p470 p468*2 p471 p468 p472 p468 p472*2
p473 p474*4 p475*14 p476*2 p477*19 p478 p477 p478*4 p479*29 p480 p479 p480*38 p481*2 p482*18 p483*2 p484*6 p485*8
p486*3 p487*10 p488 p487*2 p488 p489*4 p490 p489 p490*2 p491*13 p492*20 p493*34 p494 p495*43 p496*25 R91.496.1:6996
p496*3 R91.497.1:7003 p498*7 R91.498.1:7015 p498*2 R91.498.1:7018 p498*8 R91.498.1:7027 p498*3 R91.498.1:7031 p498
R91.498.1:7033 p498*4 R91.498.1:7038 p498*3 R91.498.1:7042 p498*3 p499 p498 R91.499.1:7050 p499*3 p498 R92.499.1:7055
p499 R92.499.1:7057 p499*3 R92.500.1:7061 R93.499.1:7062 R92.500.1:7063 p500*5 R92.500.1:7069 R93.499.1:7070
R92.500.1:7071 R93.499.1:7072 p500*2 R92.500.1:7075 R93.499.1:7076 p500 R92.500.1:7078 p500 R93.499.1:7080
R92.500.1:7082 p500 R92.500.1:7084 p500 R93.499.1:7086 R92.500.1:7087 R93.499.1:7088 R92.500.1:7089 R92.500.1:7092
R93.501.1:7093 p500*2 R92.501.1:7096 R93.501.1:7097 p501 R92.501.1:7099 R93.501.1:7100 p501*2 R93.501.1:7103 p501*3
R92.502.1:7107 R93.501.1:7108 p502 R92.502.1:7110 R93.501.1:7111 p502*2 R92.502.1:7115 R93.501.1:7116 R92.502.1:7117
R93.501.1:7118 R92.502.1:7119 R92.502.1:7120 p502*2 R93.503.1:7126 R92.503.1:7127 R93.503.1:7128 p503*3 R92.503.1:7132
R92.503.1:7133 R93.503.1:7134 p503*2 R92.503.1:7137 p503 R93.503.1:7139 R92.503.1:7141 R93.503.1:7142 p503*2
R92.503.1:7146 R93.503.1:7147 R92.503.1:7148 R92.503.1:7149 R93.503.1:7150 R92.503.1:7151 R93.503.1:7152 p503
R92.503.1:7154 R93.503.1:7155 p503 R92.503.1:7157 p503 R93.504.1:7159 p503 R92.504.1:7161 R93.504.1:7162
R93.504.1:7164 R92.504.1:7165 R93.504.1:7166 R92.504.1:7167 R93.504.1:7169 R92.504.1:7170 p504 R92.505.1:7172
R93.504.1:7173 R92.505.1:7174 R93.504.1:7175 R93.504.1:7176 R94.505.1:7178 R94.506.1:7179 R93.506.1:7180 p506*5
R93.506.1:7186 R95.507.1:7187 R93.506.1:7188 p507 p508 R93.506.1:7193 p509*5 R93.509.1:7205 R93.509.1:7206 p509*4
R93.509.1:7212 R93.510.1:7215 p510*3 p511*2 R93.510.1:7225 p511 R93.510.1:7229 p511*3 R93.510.1:7233 p511
R93.512.1:7235 p513 R93.513.1:7241 p514 R93.514.1:7245 p515 R93.516.1:7254 R93.516.1:7256 p516*2 p517 R93.517.1:7264
p517 p518 p519*4 R93.519.1:7275 p519*2 p520*4 R93.520.1:7290 p521*2 R93.522.1:7293 p522 R93.522.1:7302 p522
R93.522.1:7306 p522*4 R93.522.1:7317 p522*6 R93.522.1:7326 p522*4 R93.522.1:7332 p522*4 R93.522.1:7337 p522
R93.522.1:7339 p522*2 R93.522.1:7344 p522*6 R93.522.1:7351 p523*2 R93.524.1:7358 p525 R93.524.1:7363 p525
R93.524.1:7366 p525*2 R93.524.1:7369 R93.524.1:7370 p525 R93.524.1:7372 p525*3 R93.524.1:7376 R93.524.1:7377 p525
R93.524.1:7379 p526*2 R93.524.1:7382 p526 R93.524.1:7384 p527 R93.524.1:7386 R93.524.1:7387 p527 R93.524.1:7390 p527
R93.524.1:7393 R93.524.1:7394 R93.524.1:7395 R93.524.1:7396 p524*2 R93.524.1:7399 p524 R93.524.1:7402 R93.524.1:7403
p524*2 R93.524.1:7406 R93.528.1:7408 R93.528.1:7409 R93.528.1:7410 R93.528.1:7411 R93.528.1:7412 R93.528.1:7413
R93.528.1:7414 R93.528.1:7415 R93.528.1:7416 R93.528.1:7417 R93.528.1:7419 R93.528.1:7420 R93.528.1:7421
R93.528.1:7422 R93.528.1:7423 p529 R93.528.1:7425 R93.528.1:7426 R93.528.1:7427 R93.528.1:7428 p529 R93.528.1:7430
R93.528.1:7431 R93.528.1:7432 p529*2 R93.528.1:7435 R93.528.1:7437 R93.528.1:7438 p529 R93.528.1:7440 p529
R93.528.1:7442 p529 R93.528.1:7444 p530 R93.528.1:7446 R93.528.1:7447 R93.528.1:7449 R93.528.1:7450 p530
R93.528.1:7452 p530 R93.528.1:7454 R93.528.1:7455 R93.528.1:7456 R93.528.1:7457 R93.528.1:7458 p531 R93.528.1:7461
R93.528.1:7463 R93.528.1:7465 R93.528.1:7466 R93.528.1:7467 R93.528.1:7468 p531 R93.528.1:7470 R93.528.1:7472 p531
R93.528.1:7474 R93.532.1:7477 R93.532.1:7478 R93.532.1:7479 R93.532.1:7481 p532 R93.532.1:7484 R93.532.1:7485
R93.532.1:7486 R93.532.1:7487 R93.532.1:7488 R93.532.1:7490 R93.532.1:7491 R93.532.1:7492 p532*15 p533*20 p534*4 p535
p536 p537 p538*7 p539*2 p540*31 p541*4 p542*2 p543 R96.543.1:7668 p543 R96.543.1:7670 p543*15 p544*9 p545*5 p544
p545*12 p546*2 p547*5 p548*4 p549*3 p550*4 p551*6 R97.551.1:7780 R97.551.1:7781 R97.551.1:7782 p551*4 p552*5 p553*7
p554*2 p555 p554*6 p556 p555 p556*4 p557*10 p558*11 p559*6 p560*7 p561 p560 p561*5 p562 R98.562.1:7917 p562*5 p563*4
p564 p565*13 p566*8 p567*2 p568*8 p569*12 p570 p571 p572 p573 p574 p575*2 p576 p577 p576*3 p577 p578*6 p579*14 p580*2
p581 p580*19 p582*2 R99.580.1:8144 R99.580.1:8145 R99.580.1:8147 p582*2 p583 R100.583.1:8157 R100.583.1:8158 p583*7
p584*18 p585 p586 p587 p586 {p584*2} p588*4 p589*8 p588 p589 p590*5 {p588} p590*2 p591*22 p592*5 p593*10 {p591*2}
p594*18 p595*2 p596 p597 p598 p599 p600 p601 p602*6 p603*2 p602 p603*18 p604*4 p605*3 p606 p607 p605 p608 p609 p610
p611*3 p605 p611*6 p612*3 p613*3 p614 p615 p616*3 p617 p618 p619 p620 p621 p620*2 p610 p620*3 R101.620.1:8540 p620*3
p622*3 p623 p624*2 p625*4 p626*15 p627 p628*17 p630*10 R102.630.1:8656 p630*4 R102.630.1:8664 p630*2 R102.630.1:8669
p630 R102.630.1:8671 p631 p630*3 R102.630.1:8678 p630 R102.630.1:8682 p630*3 R102.630.1:8687 p630*5 R102.630.1:8696
p630*2 R102.632.1:8700 p633*4 R102.632.1:8707 p633 R102.633.1:8711 R102.634.1:8712 p633*2 p634 p633 R102.634.1:8723
p634*7 R102.634.1:8735 p634 R102.635.1:8739 p635*2 R102.635.1:8746 p635*7 R102.635.1:8759 p635*5 p637*2 p635 p637*5
R102.638.1:8789 R102.638.1:8790 p637 p638*3 R102.638.1:8805 p638*23 R102.639.1:8851 p638 R102.639.1:8853 p638
R102.640.1:8857 R102.640.1:8858 p639*6 R102.640.1:8867 p639*27 R102.641.1:8915 R102.641.1:8916 p639 R102.641.1:8918
p641*2 R102.641.1:8922 p641*3 p639 p641*2 p639 p641*16 R102.642.1:8970 R102.642.1:8971 R102.642.1:8973 R102.642.1:8976
R102.643.1:8979 R102.643.1:8981 p642*8 R102.643.1:8997 p642*5 p644 p643 p644*5 R102.645.1:9029 p644*2 R102.646.1:9039
R102.646.1:9040 p646*6 R102.646.1:9052 p646*17 p647*3 p646 p647*15 p648 p649 p650 p651 p652 p651*3 p653 p654 p655
R102.655.1:9163 R102.655.1:9167 p655*2 R102.655.1:9174 p655*19 R102.656.1:9200 R102.656.1:9202 p655*3 R102.657.1:9207
R102.657.1:9209 p657*11 R102.657.1:9222 p657*5 p658*5 p657*3 p658*2 p657 p658*7 p659 p658*3 p659 p658 p659*7
R103.659.1:9277 p659*21 P103.659:9317 p659*17 p660*4 p659 p660*5 p659 p660 p659 p660*19 p661 p662 p660 p662*27 p663*2
p662 p663*6 p664*4 p663*2 p665*61 p666*4 p667 p668*9 p669*7 p668 p669*4 p668 p669*30 p670*5 p669 p670*4 p671*6 p672
p673*3 p674*2 p675 p676*2 p677 p678*4 p679*3 p680*2 p681 p680*5 p682*22 p683*4 p684*4 p685*4 p686*2 p687*4 p688*2
p689*8 p690*2 p691 p692 p689 p693*2 p694 p695*2 p696 p695 p696*3 p697*5 p698 p697 p698*4 p699 p700*5 p701 p700 p701*3
`;

/** The recorded rows through the production evaluation, one evaluation per entry, from W1-T13392's frozen baseline.
 *  `perSha` gives a head a new identity at every sha: origin/main's counting, under which nothing can carry. */
async function replayRecorded(t: TestContext, perSha: boolean) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recorded-replay-`));
  t.after(() => execFileSync("rm", ["-rf", dir]));
  const statePath = join(dir, "reviewer-health.json");
  health.saveReviewerHealthState(statePath, { ...health.emptyReviewerHealthState(), pooled: { ...FROZEN }, seq: FROZEN.shas,
    seededAt: "2026-10-19T00:00:00.000Z", cursor: { liveOffset: 0 } });
  const start = Date.parse("2026-10-19T00:00:00.000Z");
  const shaOf = (id: string): string => fake(`recorded-sha-${id}`);
  const kinds: Record<string, Row> = {
    P: { step: "review.posted", state: "success" }, R: { step: "review.semantic_setup_refused" },
    W: { step: "review.semantic_incomplete", reviewer_outcome: "success" }, F: { step: "review.semantic_incomplete", reviewer_outcome: "error" },
  };
  let at = 0;
  let anonymous = 0;
  const rowsOf = (entry: string): { sha: string; rows: Row[] } => {
    const run = /^p(\d+)(?:\*(\d+))?$/.exec(entry);
    if (run !== null) {
      const sha = shaOf(run[1]!);
      return { sha, rows: Array.from({ length: Number(run[2] ?? 1) }, () => ({ ts: new Date(start + at).toISOString(), host: "core",
        step: "review.posted", state: "success", reviewer_code_sha: sha, ...unit(100_000 + anonymous, fake(`posted-head-${anonymous++}`)) })) };
    }
    const row = /^([PRWF])(\d+)\.(\d+)(?:\.(\d+))?:(\d+)$/.exec(entry);
    assert.ok(row !== null, `a recorded entry: ${entry}`);
    const [, kind, head, sha, reason, index] = row;
    at = Number(index);
    return { sha: shaOf(sha!), rows: [{ ts: new Date(start + at).toISOString(), host: "core", ...kinds[kind!], reviewer_code_sha: shaOf(sha!),
      ...unit(Number(head), fake(perSha ? `recorded-head-${head}-at-${sha}` : `recorded-head-${head}`)),
      ...(reason === undefined ? {} : { reason: RECORDED_REASONS[Number(reason)] }) }] };
  };
  const steps: Array<{ step: string; extra: Row }> = [];
  const issues: AsyncIssueGateway = { create: async () => "https://github.com/acme/remudero/issues/1", listOpen: async () => [],
    ensureLabel: async () => true, comment: async () => undefined, closeWithComment: async () => undefined };
  const lane: MainRepairLane = { openFixPr: async () => { throw new Error("no fix PR"); }, openRevertPr: async () => ({ refused: "fixture" }),
    readPr: async () => ({ state: "closed" as const }), closePr: async () => undefined };
  const escalation = { issues, ledgerPath: join(dir, "ledger.ndjson"), runId: "recorded-replay" };
  const clockAt = { iso: () => new Date(start + at).toISOString() };
  const log = (step: string, extra: Row = {}) => { if (step.startsWith("reviewer.regression")) steps.push({ step, extra }); };
  const carried = new Set<string>();
  let carriedRows = 0;
  let unhealable = false;
  let evaluations = 0;
  for (const token of RECORDED.trim().split(/\s+/)) {
    if (token === "!") { unhealable = true; continue; }
    const flush = token.startsWith("{");
    const parts = (flush ? token.slice(1, -1).split(",") : [token]).map(rowsOf);
    const rows = parts.flatMap((part) => part.rows);
    const current = flush ? null : parts[0]!.sha;
    await health.evaluateReviewerHealthNow({ originMainSha: current, readEvidenceJson: async () => [] }, statePath,
      async () => ({ rows, cursor: { liveOffset: 0 } }), git, escalation, lane, log, clockAt);
    evaluations += 1;
    const state = health.loadReviewerHealthState(statePath);
    for (const row of rows) {
      const key = `${String(row.pr_url)}#${String(row.head_sha)}`;
      if (row.step === "review.posted" || state.shas[String(row.reviewer_code_sha)]?.units[key] !== "carried") continue;
      carried.add(`${key}@${String(row.reviewer_code_sha)}`);
      if (!flush) carriedRows += 1;
    }
    if (unhealable && state.incident !== null && state.incident.healedTree === undefined && current !== null) {
      await health.noteHealedTreeOutcome(statePath, state.incident, { state: "conflict", originMainSha: current,
        reason: "the revert does not apply", paths: ["src/run-task.ts"] }, escalation, () => {}, clockAt);
    }
  }
  const named = (step: string) => steps.filter((s) => s.step === `reviewer.regression_${step}`);
  return { evaluations, carried: carried.size, carriedRows, opened: named("opened"), extended: named("extended").length, closed: named("closed"),
    open: health.loadReviewerHealthState(statePath).incident };
}

test("W1-T14321 criterion 2: replayed over the recorded rows, 130 repeats are carried; regressed shas fall from 20 to 7 and open-close pairs from 6 to 1", async (t) => {
  const main = await replayRecorded(t, true);
  const head = await replayRecorded(t, false);
  assert.equal(head.evaluations, 1429, "every recorded evaluation was replayed");
  // origin/main's counting: a head refused at every main commit counts at each, and the month flaps six times.
  assert.equal(main.carried, 0, "nothing carries when every sha sees a new head");
  assert.equal(main.opened.length + main.extended, 20, "20 shas read regressed");
  assert.deepEqual([main.opened.length, main.closed.length], [6, 6], "six open-close pairs");
  assert.deepEqual(main.opened.map((o) => `${String(o.extra.k)}/${String(o.extra.n)}`), ["3/3", "4/13", "3/3", "3/3", "4/7", "4/8"],
    "opened as origin/main's own code opened over the full rows");
  // W1-T14321: 130 (head, sha) repeats are carried, and the month opens once and closes once.
  assert.equal(head.carried, 130, "130 repeats are carried out of k and n");
  // The recon's 304 counted ROWS (a retried review is a row each) and only rows naming their sha: the same 304 here.
  assert.equal(head.carriedRows, 304, "304 sha-named rows land on a carried repeat");
  assert.equal(head.opened.length + head.extended, 7, "7 shas read regressed");
  assert.deepEqual([head.opened.length, head.closed.length], [1, 1], "one open-close pair");
  assert.equal(head.open, null, "nothing is open at the end of the month");
  assert.equal(main.open, null);
  // The real regression still opens, the same way: the 10-20 storm at k=3 n=3, the first incident of both.
  for (const run of [main, head]) {
    assert.equal(run.opened[0]!.extra.k, 3);
    assert.equal(run.opened[0]!.extra.n, 3);
  }
  assert.equal(head.opened[0]!.extra.regressed_reviewer_code_sha, main.opened[0]!.extra.regressed_reviewer_code_sha);
});

test("W1-T14321 criterion 3: a head that posted at one sha and later fails at a new sha still counts at the new sha, and a different reason at a new sha counts", () => {
  const [s1, s2, s3, s4] = ["c3-1", "c3-2", "c3-3", "c3-4"].map(fake) as [string, string, string, string];
  const head = unitKey(31);
  // Refused at s1, posted at s2, refused again at s3: the s3 failure is new evidence and becomes the record.
  const afterPost = ingest([refused(s1, 31), posted(s2, 31), refused(s3, 31), refused(s4, 31)]);
  assert.equal(afterPost.shas[s1]!.units[head], "setup-refused");
  assert.equal(afterPost.shas[s2]!.units[head], "posted");
  assert.equal(afterPost.shas[s3]!.units[head], "setup-refused", "a head that posted since counts again at the new sha");
  assert.deepEqual(health.shaCounts(afterPost.shas[s3]!), { k: 1, n: 1 });
  assert.deepEqual(afterPost.shas[s3]!.reasons, { [REFUSAL]: 1 });
  assert.equal(afterPost.shas[s4]!.units[head], "carried", "its repeat after that is carried from the new record");
  // Posted and refused at one sha (posted wins there): its first failure at the next sha counts.
  const postedFirst = ingest([posted(s1, 32), refused(s1, 32), refused(s2, 32)]);
  assert.equal(postedFirst.shas[s1]!.units[unitKey(32)], "posted");
  assert.equal(postedFirst.shas[s2]!.units[unitKey(32)], "setup-refused", "a refusal posted wins over is no record to carry");
  const refusedThenPosted = ingest([refused(s1, 33), posted(s1, 33), refused(s2, 33)]);
  assert.equal(refusedThenPosted.shas[s2]!.units[unitKey(33)], "setup-refused", "posted at s1 after its refusal: s2's refusal counts");
  // A different reason at a new sha counts, and becomes a record of its own.
  const other = "own-task-record-missing";
  const reasons = ingest([refused(s1, 34), refused(s2, 34, undefined, other), refused(s3, 34), refused(s3, 34, undefined, other)]);
  assert.equal(reasons.shas[s2]!.units[unitKey(34)], "setup-refused", "a new reason at a new sha counts");
  assert.deepEqual(reasons.shas[s2]!.reasons, { [other]: 1 });
  assert.deepEqual(health.shaCounts(reasons.shas[s2]!), { k: 1, n: 1 });
  assert.equal(reasons.shas[s3]!.units[unitKey(34)], "carried", "each reason, once recorded, is carried at a later sha");
  // A withhold after the reviewer ran, a new reason for a head refused before, counts at its sha.
  const withhold = ingest([refused(s1, 35), withheld(s2, 35)]);
  assert.equal(withhold.shas[s2]!.units[unitKey(35)], "withheld-success");
  // Carried then failing for a new reason at the same sha: the new reason counts there.
  const mixed = ingest([refused(s1, 36), refused(s2, 36), withheld(s2, 36)]);
  assert.equal(mixed.shas[s2]!.units[unitKey(36)], "withheld-success");
  assert.deepEqual(mixed.shas[s2]!.reasons, { "required-semantic-incomplete-verdicts": 1 });
  // A head that posts at a later sha after a carried repeat counts as posted there, as any post does.
  const recovered = ingest([refused(s1, 37), refused(s2, 37), posted(s2, 37)]);
  assert.equal(recovered.shas[s2]!.units[unitKey(37)], "posted");
  assert.deepEqual(health.shaCounts(recovered.shas[s2]!), { k: 0, n: 1 });
});

test("W1-T14321 criterion 4: invariant:counting-within-one-sha-is-unchanged — within one reviewer sha, posted wins over a refusal and a pending unit holds, exactly as origin/main", () => {
  const sha = fake("one-sha");
  // Every sequence of up to four rows over two heads at one sha, of five kinds: posted, refused, withheld after the
  // reviewer ran, withheld after it failed, and a downgrade-unclassified hold (pending once per head and digest).
  const kinds = [
    (pr: number) => posted(sha, pr), (pr: number) => refused(sha, pr), (pr: number) => withheld(sha, pr),
    (pr: number) => withheld(sha, pr, undefined, "error"), (pr: number) => held(sha, pr),
  ];
  const symbols = [41, 42].flatMap((pr) => kinds.map((kind) => () => kind(pr)));
  let sequences = 0;
  const walk = (prefix: number[]): void => {
    if (prefix.length > 0) {
      const rows = prefix.map((i) => symbols[i]!());
      const state = ingest(rows);
      const main = originMainCounts(rows).get(sha)!;
      const rec = state.shas[sha]!;
      assert.deepEqual(rec.units, Object.fromEntries(main.units), `classes for ${prefix.join(",")}`);
      assert.deepEqual(rec.reasons, Object.fromEntries(main.reasons), `reasons for ${prefix.join(",")}`);
      assert.deepEqual(health.shaCounts(rec), { k: main.k, n: main.n }, `counts for ${prefix.join(",")}`);
      // Read again, the same rows change nothing.
      health.ingestReviewerHealthRows(state, rows);
      assert.deepEqual(health.shaCounts(state.shas[sha]!), { k: main.k, n: main.n }, `re-read ${prefix.join(",")}`);
      sequences += 1;
    }
    if (prefix.length < 4) for (let i = 0; i < symbols.length; i++) walk([...prefix, i]);
  };
  walk([]);
  assert.equal(sequences, 10 + 100 + 1000 + 10000, "every sequence of one to four rows was compared");
  // The named cases, by hand: posted wins over a refusal in either order; a pending hold never displaces a class.
  const one = (rows: Row[]) => { const state = ingest(rows); return { units: state.shas[sha]!.units, counts: health.shaCounts(state.shas[sha]!) }; };
  assert.deepEqual(one([refused(sha, 43), posted(sha, 43)]).counts, { k: 0, n: 1 });
  assert.deepEqual(one([posted(sha, 43), refused(sha, 43)]).counts, { k: 0, n: 1 });
  assert.deepEqual(one([held(sha, 44)]), { units: { [unitKey(44)]: "withheld-pending" }, counts: { k: 0, n: 0 } });
  assert.deepEqual(one([refused(sha, 44), held(sha, 44)]).counts, { k: 1, n: 1 }, "a pending hold keeps the refusal");
  assert.deepEqual(one([held(sha, 44), refused(sha, 44)]).counts, { k: 1, n: 1 });
});

test("W1-T14321: a carried failure is replay-safe, split by healed tree, and pooled away with its sha", () => {
  const [s1, s2, s3, s4] = ["r-1", "r-2", "r-3", "r-4"].map(fake) as [string, string, string, string];
  // Reading the same rows again changes nothing, though the post re-seeded the record at s3.
  const rows = [refused(s1, 51), refused(s2, 51), posted(s2, 51), refused(s3, 51), refused(s4, 51)];
  const state = ingest(rows);
  const before = JSON.stringify([s1, s2, s3, s4].map((sha) => state.shas[sha]!.units));
  assert.deepEqual([s1, s2, s3, s4].map((sha) => state.shas[sha]!.units[unitKey(51)]), ["setup-refused", "posted", "setup-refused", "carried"]);
  health.ingestReviewerHealthRows(state, rows);
  assert.equal(JSON.stringify([s1, s2, s3, s4].map((sha) => state.shas[sha]!.units)), before, "a re-read is harmless");
  const plain = ingest([refused(s1, 52), refused(s2, 52)]);
  health.ingestReviewerHealthRows(plain, [refused(s1, 52)]);
  assert.equal(plain.shas[s2]!.units[unitKey(52)], "carried");
  // A row older than the record at another sha (a re-read past a re-seed) keeps the class its sha already has.
  const reseeded = ingest([refused(s1, 53), refused(s2, 53), posted(s3, 53), refused(s4, 53)]);
  const stale = refused(s2, 53);
  stale.ts = "2026-01-01T00:00:00.000Z";
  health.ingestReviewerHealthRows(reseeded, [stale]);
  assert.equal(reseeded.shas[s2]!.units[unitKey(53)], "carried", "a stale re-read never turns a carried repeat into a count");
  const fresh = ingest([refused(s1, 54)]);
  const older = refused(s2, 54);
  older.ts = "2026-01-01T00:00:00.000Z";
  health.ingestReviewerHealthRows(fresh, [older]);
  assert.equal(fresh.shas[s2]!.units[unitKey(54)], "setup-refused", "a first sight older than the record counts, as on origin/main");
  // A healed tree's failures are carried among healed shas only: the healed pool counts a head once of its own.
  const incident = "reviewer-regression-fixture";
  const healed = ingest([refused(s1, 55), refused(s2, 55, undefined, REFUSAL, incident), refused(s3, 55, undefined, REFUSAL, incident)]);
  assert.equal(healed.shas[s2]!.healed, true);
  assert.equal(healed.shas[s2]!.units[unitKey(55)], "setup-refused", "the healed tree's first refusal of the head counts");
  assert.equal(healed.shas[s3]!.units[unitKey(55)], "carried", "its repeat at a later healed sha is carried");
  const healedPost = ingest([refused(s1, 56, undefined, REFUSAL, incident), posted(s2, 56), refused(s3, 56, undefined, REFUSAL, incident)]);
  assert.equal(healedPost.shas[s3]!.units[unitKey(56)], "setup-refused", "a post anywhere ends a healed carry too");
  // Pooled away with its sha: the record goes, and the next failure of the head counts and records again.
  const pooledState = ingest([refused(s1, 57)]);
  const filler = Array.from({ length: health.MAX_TRACKED_REVIEWER_SHAS }, (_, i) => posted(fake(`filler-${i}`), 6000 + i));
  health.ingestReviewerHealthRows(pooledState, filler);
  assert.equal(pooledState.shas[s1], undefined, "the recording sha was pooled away");
  assert.equal(pooledState.carriedFailures?.[unitKey(57)], undefined, "and its carried record with it");
  health.ingestReviewerHealthRows(pooledState, [refused(s2, 57)]);
  assert.equal(pooledState.shas[s2]!.units[unitKey(57)], "setup-refused");
  // A state file written before W1-T14321 has no record: it loads, and carries from the next failure on.
  const legacy = { ...health.emptyReviewerHealthState() } as Partial<health.ReviewerHealthState>;
  delete legacy.carriedFailures;
  const loaded = ingest([refused(s1, 58), refused(s2, 58)], legacy as health.ReviewerHealthState);
  assert.equal(loaded.shas[s2]!.units[unitKey(58)], "carried");
});
