import assert from "node:assert/strict";
import { test } from "node:test";
import { decideLoopOutcome, type LoopDecisionInput } from "#src/lib/loop-decision.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

const TASK = "W1-T11076";
const URL = "https://github.com/acme/remudero/pull/42";
const HEAD = "a".repeat(40);
const criterion = (claim = "claim A", met = false, proof_exec = "executed_pass") =>
  ({ claim, met, proof_exec, proof: "unit test: behaviour", reason: met ? "passes" : "semantic downgrade" });
const criteria = () => [criterion(), criterion("claim B", true)];
const row = <T extends Record<string, unknown>>(step: string, fields: T = {} as T) =>
  ({ step, task_id: TASK, pr_url: URL, head_sha: HEAD, ...fields });
const review = (claims = criteria()) => row("review.posted", {
  state: "failure", decision_verdict: { state: "failure", criteria: claims, testTheater: false,
    criteriaTampered: false, instrumentEntangled: false, rewardHackingGap: 0 },
});
const round = (id = "round-1", outcome = "FIXED") => [
  row("fix.dispatch", { round_id: id, mode: "reviewer-unmet", unmet_claims: ["claim A"] }),
  row("fix.done", { round_id: id, fix_outcome: outcome }),
];
function input(ledger: readonly Record<string, unknown>[] = [review(), ...round(), review()]): LoopDecisionInput {
  return { taskId: TASK, prNumber: 42, prUrl: URL, headSha: HEAD, reviewState: "failure",
    checksGreen: true, mergeClean: true, changedFiles: ["src/lib/widget.ts"], ledger };
}

test("test/sweep/a-looping-pr-is-routed-push-through-rebuild-or-split-in-shadow.test.ts", async (t) => {
  await t.test("a repeated claim after a completed reviewer fix is the first decision point", () => {
    const facts = input();
    const before = structuredClone(facts);
    const decision = decideLoopOutcome(facts);
    assert.equal(decision?.trigger, "repeated-claim");
    assert.equal(decision?.route, "push-through");
    assert.deepEqual(decision?.unmet_classes, ["semantic-downgrade"]);
    assert.deepEqual(facts, before, "the decision is pure");
    assert.equal(decideLoopOutcome(input([review() ])), undefined);
    assert.equal(decideLoopOutcome(input([review(), row("fix.dispatch", { mode: "reviewer-unmet" }), review()])), undefined);
    assert.equal(decideLoopOutcome(input([review(), ...round().map(r => ({ ...r, mode: "ci-log" })), review()])), undefined);
    assert.equal(decideLoopOutcome(input([review(), ...round(), review([criterion("different claim"), criterion("B", true)])])), undefined);
    assert.equal(decideLoopOutcome(input([review(), round()[0], review(), round()[1]])), undefined, "review before completion is not a repeat after repair");
    assert.equal(decideLoopOutcome({ ...facts, reviewState: "success" }), undefined);
  });
  await t.test("scope, design, six completed rounds and two same-class judgements trigger", () => {
    for (const outcome of ["NEEDS_SCOPE", "NEEDS_DESIGN"]) {
      assert.equal(decideLoopOutcome(input([review(), ...round("r", outcome)]))?.trigger, "needs-scope-or-design");
    }
    const six = Array.from({ length: 6 }, (_, i) => round(`round-${i}`)).flat();
    assert.equal(decideLoopOutcome(input([review(), ...six.slice(0, -2)])), undefined);
    assert.equal(decideLoopOutcome(input([review(), ...six]))?.trigger, "six-fix-rounds");
    const judge = (red_class: string) => row("fix.progress_judged", { verdict: "change-approach", red_class });
    assert.equal(decideLoopOutcome(input([review(), judge("ci"), judge("review") ])), undefined);
    assert.equal(decideLoopOutcome(input([review(), judge("ci"), judge("ci") ]))?.trigger, "repeated-change-approach");
    assert.equal(decideLoopOutcome(input([review(), { ...judge("ci"), input_key: "same" }, { ...judge("ci"), input_key: "same" }])), undefined);
    assert.equal(decideLoopOutcome(input([review(), ...round(), review(), ...six]))?.trigger, "repeated-claim");
  });
  await t.test("every push-through prerequisite is independently necessary", () => {
    const base = input();
    for (const patch of [{ checksGreen: false }, { mergeClean: false }, { changedFiles: undefined },
      { changedFiles: [] }, { pushThroughFollowUp: true }, { reviewInputDigest: "unreviewed-input" }]) {
      assert.equal(decideLoopOutcome({ ...base, ...patch })?.route, "close-and-rebuild", JSON.stringify(patch));
    }
    for (const patch of [{ testTheater: true }, { criteriaTampered: true }, { instrumentEntangled: true },
      { rewardHackingGap: 1 }, { changesetContradictions: [{}] }]) {
      const last = review();
      last.decision_verdict = { ...last.decision_verdict, ...patch };
      assert.equal(decideLoopOutcome(input([review(), ...round(), last]))?.route, "close-and-rebuild", JSON.stringify(patch));
    }
    for (const proof of ["executed_fail", "not_executed", "unexecutable", ""]) {
      assert.equal(decideLoopOutcome(input([review(), ...round(), review([criterion("claim A", false, proof), criterion("B", true)])]))?.route,
        "close-and-rebuild", proof);
    }
    assert.equal(decideLoopOutcome(input([review(), ...round(), review([criterion()])]))?.route, "close-and-rebuild");
    const finding = row("review.finding", { reproduced: true, category: "defect" });
    assert.equal(decideLoopOutcome(input([review(), ...round(), review(), finding]))?.route, "close-and-rebuild");
    assert.equal(decideLoopOutcome(input([review(), ...round("r", "NEEDS_DESIGN"), row("review.posted", { state: "failure" })]))?.route, "close-and-rebuild");
  });
  await t.test("protected paths cannot be pushed through", () => {
    for (const path of ["deploy/entrypoint.sh", ".github/workflows/ci.yml", "hooks/pre-push", "src/lib/review.ts",
      "src/lib/merge-queue.ts", "src/lib/risk-judge.ts", "src/lib/ci-gate.ts", "src/lib/ledger.ts",
      "src/lib/ledger-steps.ts", "src/lib/loop-decision.ts", "src/lib/sweep.ts", ".env", "secrets/key.pem",
      "src/lib/credentials.ts", "src/lib/review-findings.ts", "../escape.ts", "deploy\\Dockerfile",
      "src/run-task.ts", "scripts/source-size-ratchet.mjs", "schemas/ledger.json", "src/lib/classify.ts",
      ".codex/auth.json", "src/lib/github-app.ts", "src/lib/provider-auth-sessions.ts", "src/lib/authority.ts",
      "src/lib/managed-garden-token.ts", ".claude/credentials.json", ".npmrc", "keys/id_rsa"]) {
      assert.equal(decideLoopOutcome({ ...input(), changedFiles: [path] })?.route, "close-and-rebuild", path);
    }
  });
  await t.test("split needs two distinct unmet claims, four criteria and four distinct files", () => {
    const all = [criterion(), criterion("claim B"), criterion("C", true), criterion("D", true)];
    const facts = { ...input([review(all), ...round(), review(all)]), checksGreen: false,
      changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"] };
    assert.equal(decideLoopOutcome(facts)?.route, "split");
    assert.equal(decideLoopOutcome({ ...facts, changedFiles: ["a.ts", "b.ts", "c.ts", "c.ts"] })?.route, "close-and-rebuild");
    assert.equal(decideLoopOutcome({ ...facts, ledger: [review(all.slice(0, 3)), ...round(), review(all.slice(0, 3))] })?.route, "close-and-rebuild");
    const duplicates = [criterion(), criterion(), criterion("C", true), criterion("D", true)];
    assert.equal(decideLoopOutcome({ ...facts, ledger: [review(duplicates), ...round(), review(duplicates)] })?.route, "close-and-rebuild");
    assert.equal(decideLoopOutcome({ ...facts, checksGreen: true })?.route, "push-through", "push-through takes precedence");
  });
  await t.test("producer tokens are counted once and sibling PR history is excluded", () => {
    const tokens = { input: 100, output: 20 };
    const ledger = [row("implement.done", { tokens, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 }),
      row("verdict", { tokens }), review(), ...round(), row("fix.done", { round_id: "round-1", tokens: { input: 7, output: 3 } }), review()];
    assert.equal(decideLoopOutcome(input(ledger))?.tokens_spent, 180);
    const sibling = ledger.map(r => ({ ...r, pr_url: "https://github.com/acme/remudero/pull/43", pr_number: 43 }));
    assert.equal(decideLoopOutcome(input(sibling)), undefined);
    assert.equal(decideLoopOutcome(input(ledger.map(r => ({ ...r, pr_url: "https://github.com/other/repo/pull/42" })))), undefined);
    const canonical = row("implement.done", { tokens: { input: 3, output: 2, cacheRead: 7, cacheCreation: 1 },
      cache_read_input_tokens: 7, cache_creation_input_tokens: 1 });
    assert.equal(decideLoopOutcome(input([canonical, review(), ...round(), review()]))?.tokens_spent, 13);
    assert.equal(decideLoopOutcome(input([review(), ...Array(6).fill(round()[1]), review()])), undefined, "duplicate terminals are one round");
    const delayed = round();
    assert.equal(decideLoopOutcome(input([review(), delayed[1], delayed[0], review()]))?.trigger, "repeated-claim", "dispatch is written at round end");
  });
  await t.test("the sweep records one shadow receipt across passes and heads without taking its route", async () => {
    const rows: Record<string, unknown>[] = input().ledger.map(r => ({ ...r }));
    const actions: string[] = [];
    const pr: OpenPrView = { prNumber: 42, prUrl: URL, taskId: TASK, headSha: HEAD,
      headRefName: `run-${TASK}-1793572652743`, checksState: "green", reviewState: "failure",
      unmetCriteria: [{ ...criterion(), proof_exec: "executed_pass" }], priorStrikes: 0, autoMergeArmed: false,
      changedFiles: ["src/lib/widget.ts"], mergeState: "clean", lastActivityAt: new Date().toISOString() };
    const deps: SweepDeps = { ledgerPath: "/unused/ledger.ndjson", runId: "shadow-test",
      readLedger: () => rows, appendLine: (_path, value) => { rows.push(value); }, log: () => undefined,
      now: () => Date.now(), actionable: () => false,
      arm: () => { actions.push("arm"); }, close: () => { actions.push("close"); },
      dispatchFix: () => { actions.push("fix"); }, escalate: () => { actions.push("escalate"); },
      updateBranch: () => { actions.push("update"); return "updated"; },
    } as SweepDeps;
    await runSweep([pr], deps);
    await runSweep([{ ...pr, headSha: "b".repeat(40) }], deps);
    const receipts = rows.filter(r => r.step === "loop.decision");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.trigger, "repeated-claim");
    assert.equal(receipts[0]?.route, "push-through");
    assert.equal(receipts[0]?.shadow, true);
    assert.equal(receipts[0]?.pr_number, 42);
    assert.equal(receipts[0]?.pr_url, undefined, "shadow telemetry cannot supply the gardener's PR-credit fallback");
    assert.equal(receipts[0]?.tokens_spent, 0);
    assert.deepEqual(receipts[0]?.unmet_classes, ["semantic-downgrade"]);
    assert.deepEqual(actions, []);
    assert.ok(rows.some(r => r.step === "sweep.disposed" && r.loop_decision !== undefined));
    rows.splice(0, rows.length, ...rows.filter(r => r.step !== "loop.decision"));
    await runSweep([pr], deps);
    assert.equal(rows.some(r => r.step === "loop.decision"), false, "rotation's carried disposition remembers the decision");
    const dryRows = input().ledger.map(r => ({ ...r }));
    await runSweep([pr], { ...deps, dryRun: true, readLedger: () => dryRows });
    assert.equal(dryRows.some(r => r.step === "loop.decision"), false);
    for (const route of ["split", "close-and-rebuild"]) {
      const all = route === "split" ? [criterion("claim A", false, "executed_fail"), criterion("B"),
        criterion("C", true), criterion("D", true)] : criteria();
      const routeRows: Record<string, unknown>[] = [review(all), ...round(), review(all)];
      await runSweep([{ ...pr, changedFiles: route === "split" ? ["a.ts", "b.ts", "c.ts", "d.ts"] : ["deploy/Dockerfile"] }],
        { ...deps, readLedger: () => routeRows, appendLine: (_path, value) => { routeRows.push(value); } });
      assert.equal(routeRows.find(r => r.step === "loop.decision")?.route, route);
      assert.deepEqual(actions, [], `${route} is also only recorded`);
    }
  });
});
