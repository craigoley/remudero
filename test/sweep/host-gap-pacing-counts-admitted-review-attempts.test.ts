import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import { appendLedger, rotateLedger, type LedgerLine } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  HOST_GAP_REREVIEW_STEP, REFUSED_POST_HOST_GAP_REREVIEW_STEP,
  hostGapProgressInput, hostGapRereviewFacts, hostGapRereviewWaitMs, planHostGapRereview, runSweep,
  type OpenPrView, type SweepDeps,
  buildSweepEffects as libraryEffects, DEFAULT_SWEEP_POLICY,
} from "#src/lib/sweep.js";
import { buildSweepEffects as entrypointEffects, reviewCommand, reviewOptionFlags, reviewOptionsFromFlags } from "#test/helpers/run-task-test.js";

const MIN = 60_000, NOW = Date.parse("2026-10-19T12:00:00Z");
const at = (ago: number): string => new Date(NOW - ago * MIN).toISOString();
const HEAD = "a".repeat(40), DIGEST = "v2:current-input", URL = "https://github.com/acme/remudero/pull/10221";
const id = (n: number): string => `review-PR10221-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pr = (): OpenPrView => ({ prNumber: 10221, prUrl: URL, taskId: "W1-T10221", headSha: HEAD,
  headRefName: "run-W1-T10221-1", reviewInputDigest: DIGEST, checksState: "green", reviewState: "success",
  unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: at(50), ciFailures: [] });
const criterion = { claim: "proof", proof: "unit test: an actual title", met: true,
  reason: "host unavailable", proof_exec: "not_executable", proof_skip: "runner-absent" };
const admitted = (n: number, ago: number, hostGap: boolean): Record<string, unknown> => ({
  ts: at(ago), step: "sweep.review_admitted", run_id: "one-daemon-run", task_id: "W1-T10221",
  pr_number: 10221, pr_url: URL, head_sha: HEAD, review_input_digest: DIGEST,
  review_attempt_id: id(n), host_gap_rereview: hostGap, skips: ["runner-absent"],
});
const posted = (n: number, ago: number): Record<string, unknown> => ({
  ts: at(ago), step: "review.posted", run_id: `review-PR10221-${1000 + n}`, review_attempt_id: id(n), task_id: "W1-T10221", pr_url: URL,
  head_sha: HEAD, review_input_digest: DIGEST, state: "success", capped: true, plan_only: false,
  decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [criterion] },
});
const request = (ago: number, ordinal = 1, step = HOST_GAP_REREVIEW_STEP): Record<string, unknown> => ({
  ts: at(ago), step, run_id: "one-daemon-run", task_id: "W1-T10221", pr_number: 10221,
  pr_url: URL, head_sha: HEAD, review_input_digest: DIGEST, review_key: `${URL}@${HEAD}`,
  rereview_ordinal: ordinal, skips: ["runner-absent"], host_gap: "runner-absent",
});
const baseline = (): Record<string, unknown>[] => [admitted(0, 40, false), posted(0, 30)];
const state = (facts: ReturnType<typeof hostGapRereviewFacts>) => ({ history: facts.history,
  skips: ["runner-absent"], lastReviewAtMs: facts.lastReviewAtMs, observedReviewMs: facts.observedReviewMs ?? 10 * MIN,
  nowMs: NOW });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test("denied and duplicate host-gap requests are not completed review rounds", async () => {
  const rows = [...baseline(), request(20), request(19), request(5, 2),
    { ts: at(4), step: "sweep.disposed", run_id: "one-daemon-run", task_id: "W1-T10221", pr_number: 10221,
      head_sha: HEAD, disposition: "post-review", acted: false,
      stand_down_reason: "not admitted this pass: semantic post-review admission bound 0" }];
  for (const marker of [HOST_GAP_REREVIEW_STEP, REFUSED_POST_HOST_GAP_REREVIEW_STEP]) {
    const inputRows = rows.map(r => r.step === HOST_GAP_REREVIEW_STEP ? { ...r, step: marker } : r);
    const facts = hostGapRereviewFacts(pr(), inputRows);
    assert.equal(facts.history.length, 0, "request demand is not admitted/completed work, on either route");
    assert.equal(facts.observedReviewMs, 10 * MIN, "a denied request cannot become a review start");
    const input = hostGapProgressInput(pr(), state(facts));
    assert.equal(input.rounds.length, 0);
    assert.equal(input.strikesSpent, 0);
    assert.equal(input.signals.noOpRounds, 0);
    assert.equal((await planHostGapRereview(state(facts), { input })).kind, "rereview");
  }
});

test("admitted host-gap attempts grow pacing once and preserve live ownership", async () => {
  const first = admitted(1, 20, true), second = admitted(2, 20, true);
  const rows = [...baseline(), request(25), first, posted(1, 16), { ...first }, posted(1, 16),
    request(24), second, posted(2, 15)];
  const facts = hostGapRereviewFacts(pr(), rows);
  assert.equal(facts.history.length, 2, "two distinct attempt IDs count even within one daemon run and timestamp");
  const input = hostGapProgressInput(pr(), state(facts));
  assert.equal(input.rounds.length, 2);
  assert.ok(input.rounds.every(r => r.completed === true));
  assert.equal(input.signals.noOpRounds, 2);
  assert.equal(hostGapRereviewWaitMs(facts.observedReviewMs!, 2), 30 * MIN);
  assert.equal((await planHostGapRereview(state(facts), { input })).kind, "hold");

  const liveRows = baseline(), entered = deferred(), release = deferred();
  let calls = 0, handedRunId: string | undefined;
  const deps: SweepDeps = { ledgerPath: "/unused/host-gap-attempts", runId: "one-daemon-run", now: () => NOW,
    readLedger: () => liveRows, appendLine: (_path, row) => { liveRows.push({ ts: at(0), ...row }); },
    postReview: async (_pr, _mode, runId?: string) => { calls++; handedRunId = runId; entered.resolve(); await release.promise; },
    dispatchFix: () => { throw Error("a host gap must not dispatch body repair"); },
    arm: () => { throw Error("a capped host gap must not arm"); },
    close: () => {}, escalate: () => {},
  };
  const running = runSweep([pr()], deps);
  try {
    await Promise.race([entered.promise, running.then(() => { throw Error("first review never reached its effect"); })]);
    assert.match(handedRunId ?? "", /^review-PR10221-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const again = await runSweep([pr()], { ...deps, runId: "another-daemon-pass" });
    assert.equal(calls, 1, "a live same-input review owns the slot; no second effect");
    assert.ok(again.actions.every(a => !a.acted));
    const admission = liveRows.find(r => r.step === "sweep.review_admitted" && r.review_attempt_id === handedRunId);
    assert.equal(admission?.review_attempt_id, handedRunId);
    assert.equal(admission?.host_gap_rereview, true);
    const inFlight = hostGapProgressInput(pr(), state(hostGapRereviewFacts(pr(), liveRows)));
    assert.equal(inFlight.signals.noOpRounds, 0, "an admitted unfinished attempt is not a completed no-op");
    assert.equal(inFlight.signals.incompleteRounds, 1);
  } finally { release.resolve(); await running; }
});

test("host-gap history separates changed inputs and incomplete legacy evidence", () => {
  const rows = [...baseline(), request(25), admitted(1, 20, true), posted(1, 15)];
  assert.equal(hostGapRereviewFacts({ ...pr(), headSha: "b".repeat(40) }, rows).history.length, 0);
  assert.equal(hostGapRereviewFacts({ ...pr(), reviewInputDigest: "v2:different-input" }, rows).history.length, 0);
  assert.deepEqual(hostGapRereviewFacts(pr(), [...rows].reverse()), hostGapRereviewFacts(pr(), rows),
    "request append order is not attempt attribution");
  const unreadableInput = hostGapRereviewFacts({ ...pr(), reviewInputDigest: undefined }, rows);
  assert.equal(unreadableInput.attribution.state, "incomplete");
  assert.equal(unreadableInput.attribution.currentInputKnown, false);
  const ambiguousAdmission = hostGapRereviewFacts(pr(), [admitted(1, 20, true), admitted(1, 19, true), posted(1, 15)]);
  assert.equal(ambiguousAdmission.history.length, 0, "a reused nonce with contradictory admission dates is unknown");
  assert.equal(ambiguousAdmission.attribution.state, "incomplete");
  const legacy = hostGapRereviewFacts(pr(), [request(20), { ...admitted(1, 19, true), review_attempt_id: undefined }, posted(1, 15)]);
  assert.equal(legacy.history.length, 0);
  assert.equal((legacy as unknown as { attribution: { state: string } }).attribution.state, "incomplete");
  const unfinished = hostGapRereviewFacts(pr(), [admitted(2, 10, true)]);
  const input = hostGapProgressInput(pr(), state(unfinished));
  assert.equal(input.rounds.filter(r => r.completed).length, 0);
  assert.equal(input.signals.noOpRounds, 0);
  assert.equal(input.signals.incompleteRounds, 1);
  const baselineInFlight = hostGapRereviewFacts(pr(), [admitted(0, 20, false)]);
  assert.equal(baselineInFlight.history.length, 0, "an initial review is never a host-gap re-review");
  assert.equal(baselineInFlight.attribution.state, "incomplete");
  assert.equal(baselineInFlight.attribution.incompleteAttempts, 1);

  const refused = { ...posted(1, 15), step: "review.post_refused", review_attempt_id: undefined,
    reviewer_code_host_gap: "cwd-missing" };
  const carrier = { ...posted(1, 19), step: "review.provider_provenance" };
  assert.equal(hostGapRereviewFacts(pr(), [refused, carrier, admitted(1, 20, true)]).history.length, 1,
    "a library-owned refusal joins only through its exact unique per-review carrier, not the daemon run");
  const ambiguous = { ...carrier, review_attempt_id: id(2) };
  assert.equal(hostGapRereviewFacts(pr(), [refused, carrier, ambiguous, admitted(1, 20, true)]).history.filter(r => r.completed !== false).length, 0,
    "an ambiguous carrier never manufactures completed work");
  const options = reviewOptionsFromFlags(["--execution-mode", "semantic", "--review-attempt-id", id(3)]);
  assert.equal((options as unknown as { reviewAttemptId?: string }).reviewAttemptId, id(3));
  const flags = reviewOptionFlags(options);
  assert.equal(flags[flags.indexOf("--review-attempt-id") + 1], id(3), "fresh-tree review keeps the admitted identity");
  assert.equal((reviewOptionsFromFlags(["--review-attempt-id", "review-PR10221-../../bad"]) as unknown as { reviewAttemptId?: string }).reviewAttemptId,
    undefined, "an unbounded/path-shaped identity is not attribution");
});

test("an admitted host-gap refusal remains attributable after real ledger rotation", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-gap-rotation-`));
  try {
    const path = join(root, "state", "ledger.ndjson");
    const carrier = { ...posted(1, 19), step: "review.provider_provenance" };
    const refusal = { ...posted(1, 15), step: "review.post_refused", review_attempt_id: undefined,
      reviewer_code_host_gap: "cwd-missing" };
    for (const row of [admitted(1, 20, true), carrier, refusal])
      appendLedger(path, row as LedgerLine, { ceilingBytes: Number.MAX_SAFE_INTEGER });
    const before = hostGapRereviewFacts(pr(), readLedgerLines(path));
    assert.equal(before.history.length, 1, "the real writer's exact carrier joins the library refusal");
    assert.equal(before.history[0]?.completed, true);
    const ceilingBytes = statSync(path).size * 4;
    const noise = JSON.stringify({ step: "ci.polling", run_id: "noise", task_id: "noise", detail: "x".repeat(1024) }) + "\n";
    appendFileSync(path, noise.repeat(Math.ceil(ceilingBytes / noise.length) + 1));
    assert.ok(statSync(path).size > ceilingBytes, "padding crosses the ceiling without forcing retained-row shedding");
    assert.equal(rotateLedger(path, { ceilingBytes, now: () => new Date(NOW) }).rotated, true,
      "the real default rotation runs in the same clock domain as its fixture rows");
    const retained = readLedgerLines(path);
    assert.equal(retained.filter(row => row.step === "sweep.review_admitted").length, 1,
      "positive control: rotation retains the admission");
    assert.equal(retained.filter(row => row.step === "review.post_refused").length, 1,
      "positive control: rotation retains the refusal");
    const after = hostGapRereviewFacts(pr(), retained);
    assert.equal(after.history.length, 1, "the deciding reader still witnesses exactly one real attempt");
    assert.equal(after.history[0]?.completed, true,
      "dropping the provenance carrier must not turn completed work into an unfinished admission");
    assert.deepEqual(after, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default review bridges and the real refusal logger preserve admitted attempt identity", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-gap-real-defaults-`));
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson"), calls: Record<string, unknown>[] = [];
    const config = { root, claudeBin: "/bin/true" } as Config;
    const deps: Parameters<typeof entrypointEffects>[0] = { owner: "acme", repo: "remudero", localRepoName: "remudero", config,
      ledgerPath, runId: "one-daemon-run", plan: { tasks: [], byId: new Map() } as Plan,
      log: () => {}, policy: DEFAULT_SWEEP_POLICY,
      reviewerCodeFreshnessImpl: () => ({ status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" }),
      reviewCommandImpl: async (_number, _args, options) => { calls.push(options); return 0; },
    };
    for (const build of [libraryEffects, entrypointEffects])
      await build(deps).postReview!(pr(), { kind: "full-review" }, id(3));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.reviewAttemptId === id(3)), "both real default runner wrappers carry the same admission");
    await entrypointEffects(deps).postReview!(pr(), { kind: "discriminate-only", judgedHeadSha: "old" }, id(4));
    assert.equal(calls.at(-1)?.reviewAttemptId, id(4), "the real missing-prior fallback keeps it too");
    const carrier = readLedgerLines(ledgerPath).find(r => r.step === "review.provider_provenance");
    assert.equal(carrier?.review_attempt_id, id(4));
    assert.match(String(carrier?.run_id), /^review-PR10221-[0-9]+$/, "existing numeric review run convention survives");
    assert.equal(carrier?.review_input_digest, DIGEST);

    for (const attemptId of [id(5), id(5).replace("PR10221", "PR10222")]) {
    const code = await reviewCommand("10221", ["--repo", "acme/missing-subject"], {
      reviewAttemptId: attemptId, enforceReviewSubjectCheckout: true,
      resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }), loadConfig: () => config,
      fetchView: () => ({ body: "", html_url: URL, head: { ref: "run-unfiled-1", sha: HEAD }, number: 10221 }),
      fetchHead: () => { throw Error("missing subject must refuse before fetch"); },
      postReviewPending: async () => { throw Error("missing subject must refuse before a status"); },
    });
    assert.equal(code, 1);
    const refusal = readLedgerLines(ledgerPath).findLast(r => r.step === "review.subject_refused");
    assert.equal(refusal?.review_attempt_id, attemptId === id(5) ? id(5) : undefined,
      "the REAL logger binds only this PR's admitted identity, never a foreign PR's nonce");
    if (attemptId === id(5)) assert.equal(typeof refusal?.review_input_digest, "string");
    assert.match(String(refusal?.run_id), /^review-PR10221-[0-9]+$/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an admitted review throw records its own terminal without borrowing the daemon run", async () => {
  const rows = baseline();
  const deps: SweepDeps = { ledgerPath: "/unused/host-gap-attempt-throw", runId: "one-daemon-run", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: at(0), ...row }); },
    postReview: async () => { throw Error("fixture reviewer transport failed after admission"); },
    dispatchFix: () => { throw Error("a host gap must not dispatch body repair"); },
    arm: () => { throw Error("a capped host gap must not arm"); }, close: () => {}, escalate: () => {},
  };
  const result = await runSweep([pr()], deps);
  assert.equal(result.actions[0]?.acted, false, "the real catch still records failure, not a successful review");
  const admission = rows.find(r => r.step === "sweep.review_admitted" && r.host_gap_rereview === true);
  const terminal = rows.findLast(r => r.step === "review.post_refused");
  assert.equal(terminal?.review_attempt_id, admission?.review_attempt_id);
  assert.match(String(terminal?.reason), /fixture reviewer transport failed after admission/);
  const facts = hostGapRereviewFacts(pr(), rows);
  assert.equal(facts.history.length, 1);
  assert.equal(facts.history[0]?.completed, true, "a witnessed terminal attempt is work, unlike a denied demand");
});
