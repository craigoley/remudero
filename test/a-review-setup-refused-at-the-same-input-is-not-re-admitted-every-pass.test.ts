import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  REVIEW_INPUT_ADMISSION_BACKSTOP,
  REVIEW_SETUP_REFUSAL_ESCALATED_STEP,
  buildSweepEffects,
  deriveDisposition,
  reviewSetupRefusalCause,
  runSweep,
  type ClarificationQuestion,
  type OpenPrView,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { appendLedger } from "#src/lib/ledger.js";
import { PARKED_PR_REMEDY_STEP } from "#src/lib/parked-pr-remedy.js";
import type { Plan } from "#src/lib/plan.js";
import { reviewSetupRefusalsFor } from "#src/lib/tick-read-worker.js";

// W1-T13193 — the live #18670 shape: a retro run branch run-RETRO-<ms> whose body trailer names RETRO-<ms>. Its
// review setup was refused with head-task-metadata-unavailable at one head and one body digest, and the sweep
// re-admitted it 157 times (142 refusals) because no rule held admission after a refused setup.
const NOW = Date.parse("2026-11-16T14:40:00Z");
const PR_NUMBER = 18670;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
const RUN = "RETRO-1794737755052";
const BRANCH = `run-${RUN}`;
const BODY = `Retro run.\n\nRemudero-Task: ${RUN}\n`;
const HEAD = "2c199b9" + "a".repeat(33);
const DIGEST = "v1:retro-18670-body";
const CODE = "c".repeat(40);
const KEY = RUN;
const REASON = "head-task-metadata-unavailable";

type Row = Record<string, unknown>;

function admitted(ts: string, over: Row = {}): Row {
  return { ts, step: "sweep.review_admitted", task_id: RUN, pr_number: PR_NUMBER, pr_url: PR_URL, head_sha: HEAD,
    review_key: KEY, review_input_digest: DIGEST, ...over };
}
function refused(ts: string, over: Row = {}): Row {
  return { ts, step: "review.semantic_setup_refused", task_id: KEY, lane: "review", pr_url: PR_URL, head_sha: HEAD,
    review_input_digest: DIGEST, reviewer_code_sha: CODE, reason: REASON, ...over };
}

const TWO_REFUSALS: Row[] = [
  admitted("2026-11-15T11:16:48Z"), refused("2026-11-15T11:17:30Z"),
  admitted("2026-11-15T11:22:00Z"), refused("2026-11-15T11:22:40Z"),
];

/** The view the real producer builds: the refusal facts come from reviewSetupRefusalsFor over the same ledger. */
function viewFor(ledger: Row[], over: Partial<OpenPrView> = {}, running: string | null = CODE): OpenPrView {
  const headSha = over.headSha ?? HEAD;
  const digest = over.reviewInputDigest ?? DIGEST;
  return {
    prNumber: PR_NUMBER,
    prUrl: PR_URL,
    taskId: RUN,
    headRefName: BRANCH,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-11-16T14:00:00Z",
    headSha,
    autoMergeArmed: false,
    reviewInputDigest: digest,
    priorReviewAttemptsForInput: 0,
    reviewSetupRefused: reviewSetupRefusalsFor(ledger, KEY, PR_URL, headSha, digest, running),
    ...over,
  } as OpenPrView;
}

function deps(ledgerPath: string, parkedPr?: SweepDeps["parkedPr"]): SweepDeps & {
  escalated: Array<{ reason: string; question: ClarificationQuestion }>;
  reviewed: number[];
} {
  const escalated: Array<{ reason: string; question: ClarificationQuestion }> = [];
  const reviewed: number[] = [];
  return {
    escalated,
    reviewed,
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: (_p, reason, question) => { escalated.push({ reason, question }); },
    postReview: (p) => { reviewed.push(p.prNumber); },
    ledgerPath,
    runId: "SWEEP-1",
    now: () => NOW,
    ...(parkedPr === undefined ? {} : { parkedPr }),
  } as SweepDeps & { escalated: typeof escalated; reviewed: number[] };
}

function ledgerWith(rows: Row[]): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-t13193-")), "ledger.ndjson");
  for (const row of rows) appendLedger(ledgerPath, row as never);
  return ledgerPath;
}

function rows(ledgerPath: string): Row[] {
  return readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

test("W1-T13193 criterion 1: two refusals at the same input are not admitted, and the disposed row names reason and count", async () => {
  assert.equal(BODY.includes(`Remudero-Task: ${RUN}`), true);
  assert.equal(REVIEW_INPUT_ADMISSION_BACKSTOP, 2);
  const held = reviewSetupRefusalsFor(TWO_REFUSALS, KEY, PR_URL, HEAD, DIGEST, CODE);
  assert.deepEqual(held, { reason: REASON, count: 2, reviewerCodeSha: CODE, runningReviewerCodeSha: CODE });

  const derived = deriveDisposition(viewFor(TWO_REFUSALS), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(derived.disposition, "blocked-ambiguous");
  assert.equal(derived.blocker, "other", "no review lane owns a held review, so the hold climbs the SLO ladder");
  assert.match(derived.reason, /review setup refused 2 times at head 2c199b9 \(head-task-metadata-unavailable/);
  assert.match(derived.reason, /not re-admitted until the head, body or reviewer code changes/);

  const ledgerPath = ledgerWith(TWO_REFUSALS);
  const d = deps(ledgerPath);
  const summary = await runSweep([viewFor(TWO_REFUSALS)], d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(d.reviewed, [], "no review child is started for the refused input");
  assert.equal(summary.byDisposition["post-review"], 0);
  const written = rows(ledgerPath).slice(TWO_REFUSALS.length);
  assert.equal(written.filter((row) => row.step === "sweep.review_admitted").length, 0, "the pass writes no sweep.review_admitted row");
  const disposed = written.filter((row) => row.step === "sweep.disposed" && row.pr_number === PR_NUMBER);
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0]!.disposition, "blocked-ambiguous");
  assert.match(String(disposed[0]!.reason), /head-task-metadata-unavailable/);
  assert.match(String(disposed[0]!.reason), /refused 2 times/);

  // A started review after the refusals ends the hold: the next refusals are counted from it.
  const started = [...TWO_REFUSALS, { ts: "2026-11-15T11:30:00Z", step: "review.pending_posted", task_id: KEY, pr_url: PR_URL,
    head_sha: HEAD, review_input_digest: DIGEST }];
  assert.equal(reviewSetupRefusalsFor(started, KEY, PR_URL, HEAD, DIGEST, CODE), undefined);
  assert.equal(deriveDisposition(viewFor(started), DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
});

test("W1-T13193 criterion 2: a new head, a new body digest or new reviewer code is admitted again", async () => {
  // A new head: the refusal rows name the old head, so the new input has none.
  const NEW_HEAD = "d".repeat(40);
  const newHead = viewFor(TWO_REFUSALS, { headSha: NEW_HEAD });
  assert.equal(newHead.reviewSetupRefused, undefined);
  assert.equal(deriveDisposition(newHead, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
  // A new body digest at the same head: the 2026-11-16 trailer edit on #18670 started its review this way.
  const newBody = viewFor(TWO_REFUSALS, { reviewInputDigest: "v1:retro-18670-body-trailer-RETRO" });
  assert.equal(newBody.reviewSetupRefused, undefined);
  assert.equal(deriveDisposition(newBody, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
  // New reviewer code: the producer counts only the running code's refusals ...
  const NEW_CODE = "e".repeat(40);
  const newCode = viewFor(TWO_REFUSALS, {}, NEW_CODE);
  assert.equal(newCode.reviewSetupRefused, undefined);
  assert.equal(deriveDisposition(newCode, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
  // ... and the sweep admits a hold whose refusals came from other code than the running reviewer.
  const staleHold = viewFor(TWO_REFUSALS, { reviewSetupRefused: { reason: REASON, count: 2, reviewerCodeSha: CODE,
    runningReviewerCodeSha: NEW_CODE } });
  assert.equal(deriveDisposition(staleHold, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");

  // End to end: the changed body is admitted by runSweep.
  const ledgerPath = ledgerWith(TWO_REFUSALS);
  const d = deps(ledgerPath);
  await runSweep([newBody], d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(d.escalated, []);
  const written = rows(ledgerPath).slice(TWO_REFUSALS.length);
  const disposed = written.filter((row) => row.step === "sweep.disposed" && row.pr_number === PR_NUMBER);
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0]!.disposition, "post-review");
});

/** The production parkedPr host, built by buildSweepEffects; its GitHub issue gateway records every write. */
function productionParkedPr(ledgerPath: string, issueWrites: string[]): NonNullable<SweepDeps["parkedPr"]> {
  const root = mkdtempSync(join(tmpdir(), "rmd-t13193-root-"));
  mkdirSync(join(root, "state"));
  const issues: IssueGateway = {
    ensureLabel: () => true, listOpen: () => [],
    create: () => { issueWrites.push("issue"); return "https://github.com/craigoley/remudero/issues/1"; },
    comment: () => { issueWrites.push("comment"); },
  };
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", repoRoot: root,
    config: { root, claudeBin: "/bin/true" } as Config,
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    ledgerPath, runId: "SWEEP-1",
    log: () => undefined, issuesImpl: issues, ghRunImpl: () => undefined, nowMsImpl: () => NOW,
    readJsonImpl: async () => ({ user: { login: "remudero-fleet[bot]" } }),
  });
  assert.ok(effects.parkedPr, "the production effects wire the parkedPr host");
  return effects.parkedPr;
}

test("W1-T13193 criterion 3: the held PR takes one parked-PR remedy per head and input, and opens no needs-human issue", async () => {
  const ledgerPath = ledgerWith(TWO_REFUSALS);
  const issueWrites: string[] = [];
  const parkedPr = productionParkedPr(ledgerPath, issueWrites);
  const remedies = () => rows(ledgerPath).filter((row) => row.step === PARKED_PR_REMEDY_STEP);
  const d1 = deps(ledgerPath, parkedPr);
  await runSweep([viewFor(TWO_REFUSALS)], d1, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(d1.escalated, [], "deps.escalate is never called when parkedPr is wired");
  assert.deepEqual(d1.reviewed, []);
  assert.deepEqual(issueWrites, [], "no needs-human issue is opened");
  assert.deepEqual(remedies().map((row) => [row.pr_number, row.head_sha, row.review_input_digest, row.cause, row.remedy, row.outcome]),
    [[PR_NUMBER, HEAD, DIGEST, reviewSetupRefusalCause(REASON), "fix-on-pr", "taken"]]);
  assert.equal(remedies()[0]!.cause, `review-setup-refused:${REASON}`);
  assert.match(String(remedies()[0]!.text), /review setup refused 2 times \(head-task-metadata-unavailable\)/);
  assert.match(String(remedies()[0]!.text), new RegExp(`digest ${DIGEST}`));
  assert.equal(rows(ledgerPath).filter((row) => row.step === REVIEW_SETUP_REFUSAL_ESCALATED_STEP).length, 0);
  const disposed = rows(ledgerPath).filter((row) => row.step === "sweep.disposed" && row.pr_number === PR_NUMBER);
  assert.equal(disposed.at(-1)!.disposition, "blocked-ambiguous", "the hold stays: no review is admitted");

  // Later passes at the same input write none, even after another refusal lands.
  const d2 = deps(ledgerPath, parkedPr);
  await runSweep([viewFor(TWO_REFUSALS)], d2, DEFAULT_SWEEP_POLICY);
  const three = [...TWO_REFUSALS, refused("2026-11-15T11:40:00Z")];
  appendLedger(ledgerPath, three.at(-1) as never);
  const d3 = deps(ledgerPath, parkedPr);
  await runSweep([viewFor(three)], d3, DEFAULT_SWEEP_POLICY);
  assert.deepEqual([...d2.escalated, ...d3.escalated], []);
  assert.deepEqual(d3.reviewed, []);
  assert.equal(remedies().length, 1, "one remedy row per head and input, not one per pass");

  // A new body that is refused twice too is a new input: it takes its own remedy row.
  const BODY2 = "v1:retro-18670-body-2";
  const second = [refused("2026-11-15T12:00:00Z", { review_input_digest: BODY2 }), refused("2026-11-15T12:05:00Z", { review_input_digest: BODY2 })];
  for (const row of second) appendLedger(ledgerPath, row as never);
  const d4 = deps(ledgerPath, parkedPr);
  await runSweep([viewFor([...three, ...second], { reviewInputDigest: BODY2 })], d4, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(d4.escalated, []);
  assert.deepEqual(remedies().map((row) => row.review_input_digest), [DIGEST, BODY2]);
  assert.deepEqual(issueWrites, []);
});

test("W1-T13193 criterion 3: legacy control, with no parkedPr the hold escalates once per head and input", async () => {
  const ledgerPath = ledgerWith(TWO_REFUSALS);
  const d1 = deps(ledgerPath);
  await runSweep([viewFor(TWO_REFUSALS)], d1, DEFAULT_SWEEP_POLICY);
  assert.equal(d1.escalated.length, 1);
  assert.match(d1.escalated[0]!.reason, /review setup refused 2 times/);
  assert.match(d1.escalated[0]!.reason, /head-task-metadata-unavailable/);
  const escalations = () => rows(ledgerPath).filter((row) => row.step === REVIEW_SETUP_REFUSAL_ESCALATED_STEP);
  assert.equal(escalations().length, 1);
  assert.equal(escalations()[0]!.reason, REASON);
  assert.equal(escalations()[0]!.refusals, 2);
  assert.equal(escalations()[0]!.review_input_digest, DIGEST);
  assert.equal(rows(ledgerPath).filter((row) => row.step === PARKED_PR_REMEDY_STEP).length, 0);

  const d2 = deps(ledgerPath);
  await runSweep([viewFor(TWO_REFUSALS)], d2, DEFAULT_SWEEP_POLICY);
  assert.equal(d2.escalated.length, 0, "one escalation per input, not one per pass");
  assert.deepEqual(d2.reviewed, []);
  assert.equal(escalations().length, 1);
});

test("W1-T13193 criterion 4: one refusal, or refusals with different reasons, are retried on the next pass", async () => {
  const one = TWO_REFUSALS.slice(0, 2);
  assert.equal(reviewSetupRefusalsFor(one, KEY, PR_URL, HEAD, DIGEST, CODE), undefined);
  assert.equal(deriveDisposition(viewFor(one), DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
  const mixed = [admitted("2026-11-15T11:16:48Z"), refused("2026-11-15T11:17:30Z"),
    admitted("2026-11-15T11:22:00Z"), refused("2026-11-15T11:22:40Z", { reason: "semantic-setup-unavailable" })];
  assert.equal(reviewSetupRefusalsFor(mixed, KEY, PR_URL, HEAD, DIGEST, CODE), undefined);
  assert.equal(deriveDisposition(viewFor(mixed), DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
  // The sweep's own check: a hold of one refusal never holds, whatever the producer stamps.
  const single = viewFor(one, { reviewSetupRefused: { reason: REASON, count: 1, reviewerCodeSha: CODE, runningReviewerCodeSha: CODE } });
  assert.equal(deriveDisposition(single, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");

  const ledgerPath = ledgerWith(one);
  const d = deps(ledgerPath);
  await runSweep([viewFor(one)], d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(d.escalated, []);
  const disposed = rows(ledgerPath).filter((row) => row.step === "sweep.disposed" && row.pr_number === PR_NUMBER);
  assert.equal(disposed.at(-1)!.disposition, "post-review");
});
