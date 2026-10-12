import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "../src/lib/config.js";
import { GARDEN_NAMES } from "../src/run-task.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";

const HEAD = "a".repeat(40);
const PATH = "plan/tasks.d/W1-T5984-fixture.yaml";
const REFUSAL = "[machine-filing-admission] flow-remedy record is not admitted";
const SOURCE = "- id: W1-T5984\n  author_class: machine\n  verify: human\n";
const pr: OpenPrView = {
  prNumber: 9505, prUrl: "https://github.com/acme/remudero/pull/9505", headSha: HEAD,
  headRefName: "flow-remedy-garden-1791271733067", isPlanFiling: true,
  changedFiles: [PATH], checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
  ciFailures: [{ name: "lint-plan", conclusion: "FAILURE",
    logTail: `✗ W1-T5984: 1 violation(s) (0 pre-existing on base main)\n    ${REFUSAL}` }],
};

function fixture(over: Partial<OpenPrView> = {}, options: {
  source?: string; files?: { filename: string; status: string }[]; liveHead?: string;
  readError?: boolean; closeError?: boolean; unreadableSource?: boolean;
} = {}) {
  const view = { ...pr, ...over };
  const ledger: Record<string, unknown>[] = [];
  const closes: string[][] = [];
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", config: { root: "/fixture" } as Config,
    repoRoot: process.cwd(), ledgerPath: "/fixture/ledger", runId: "garden-refusal",
    plan: { tasks: [] } as never, policy: DEFAULT_SWEEP_POLICY,
    log: (step, extra) => logs.push({ step, extra }),
    ghJsonImpl: (args: string[]) => {
      if (options.readError) throw new Error("record read unavailable");
      const endpoint = args[1]!;
      if (endpoint.includes("/files?")) return options.files ?? [{ filename: PATH, status: "added" }];
      if (endpoint.includes("/contents/") && options.unreadableSource) return {};
      if (endpoint.includes("/contents/")) return {
        encoding: "base64", content: Buffer.from(options.source ?? SOURCE).toString("base64"),
      };
      return { head: { sha: options.liveHead ?? view.headSha, ref: view.headRefName },
        title: "chore(plan): file remedy", user: { login: "remudero-fleet[bot]" } };
    },
    ghRunImpl: (_file: string, args: readonly string[]) => {
      if (options.closeError) throw new Error("close unavailable");
      closes.push([...args]);
      return "";
    },
  });
  let updates = 0;
  let reviews = 0;
  let escalations = 0;
  let rounds = 0;
  const deps: SweepDeps = {
    runId: "garden-refusal", ledgerPath: "/fixture/ledger", readLedger: () => ledger,
    appendLine: (_path, row) => ledger.push(row),
    arm() {}, close: effects.close, readPlanRepairFacts: effects.readPlanRepairFacts,
    repairPlanPr: async () => ({ outcome: "unmatched" }),
    postReview() { reviews++; }, escalate() { escalations++; }, dispatchFix() { rounds++; },
    dispatchPlanGateRound: async () => { rounds++; return { outcome: "refused", reason: "unrepairable" }; },
    updateBranch: async () => { updates++; return "updated" as const; },
    behindMainByPr: new Map([[view.prNumber, 100]]),
  };
  return { view, deps, ledger, closes, logs, counts: () => ({ updates, reviews, escalations, rounds }) };
}

test("test/a-machine-gardener-pr-red-on-its-own-record-is-closed-not-re-escalated.test.ts: closes once, names its refusal and stays closed across heads", async () => {
  const f = fixture();
  for (const headSha of [HEAD, HEAD, HEAD, HEAD, HEAD, HEAD, "b".repeat(40)]) {
    const result = await runSweep([{ ...f.view, headSha }], f.deps);
    assert.equal(result.actions[0]!.disposition, "stale");
  }
  assert.equal(f.closes.length, 1);
  assert.deepEqual(f.closes[0]!.slice(0, 4), ["pr", "close", pr.prUrl, "--comment"]);
  assert.match(f.closes[0]![4]!, /W1-T5984/);
  assert.ok(f.closes[0]![4]!.includes(REFUSAL));
  assert.deepEqual(f.counts(), { updates: 0, reviews: 0, escalations: 0, rounds: 0 });
  const rows = f.ledger.filter(row => row.step === "sweep.disposed");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.acted, true);
  assert.equal(rows[0]!.garden_record_refusal, `W1-T5984: ${REFUSAL}`);
});

test("only an added own machine record with a sole lint-plan refusal is closed", async () => {
  const cases: Parameters<typeof fixture>[] = [
    [{ headRefName: "run-W1-T5984-1" }],
    [{ headRefName: "unknown-garden-1" }],
    [{ headRefName: "feedback-landing-1" }],
    [{ isPlanFiling: false }],
    [{ checksState: "green", ciFailures: [] }],
    [{ ciFailures: [...pr.ciFailures!, { name: "typecheck", logTail: "own red" }] }],
    [{ redRequiredChecks: ["lint-plan", "typecheck"] }],
    [{ ciFailures: [{ ...pr.ciFailures![0]!, sha: "c".repeat(40) }] }],
    [{ ciFailures: [{ ...pr.ciFailures![0]!, conclusion: "CANCELLED" }] }],
    [{ ciFailures: [{ ...pr.ciFailures![0]!, logTail: "✗ W1-T9999: 1 violation(s)\n    " + REFUSAL }] }],
    [{ ciFailures: [{ ...pr.ciFailures![0]!, logTail: pr.ciFailures![0]!.logTail + "\n✗ plan/policy.yaml: invalid policy" }] }],
    [{ ciFailures: [{ name: "lint-plan", logTail: "lint-plan failed with no named refusal" }] }],
    [{}, { source: SOURCE.replace("machine", "operator") }],
    [{}, { source: SOURCE + "- id: W1-T9999\n  author_class: machine\n" }],
    [{}, { source: "{}" }],
    [{}, { source: "[invalid" }],
    [{}, { files: [{ filename: PATH, status: "modified" }] }],
    [{}, { files: [{ filename: "src/x.ts", status: "added" }] }],
    [{}, { files: [{ filename: PATH, status: "added" }, { filename: "src/x.ts", status: "added" }] }],
    [{}, { files: [] }],
    [{}, { liveHead: "d".repeat(40) }],
    [{}, { readError: true }],
    [{}, { unreadableSource: true }],
  ];
  for (const [over, options] of cases) {
    const f = fixture(over, options);
    await runSweep([f.view], f.deps);
    assert.equal(f.closes.length, 0, JSON.stringify([over, options]));
    assert.equal(f.ledger.some(row => row.garden_record_refusal !== undefined), false);
  }
});

test("every registered garden can close its own refused machine shard", async () => {
  for (const name of GARDEN_NAMES) {
    const f = fixture({ headRefName: `${name}-garden-1791271733067` });
    await runSweep([f.view], f.deps);
    assert.equal(f.closes.length, 1, name);
    assert.deepEqual(f.counts(), { updates: 0, reviews: 0, escalations: 0, rounds: 0 });
  }
});

test("the ci-gate aggregate does not hide an own-record lint refusal", async () => {
  const f = fixture({ redRequiredChecks: ["ci-gate", "lint-plan"],
    ciFailures: [...pr.ciFailures!, { name: "ci-gate", conclusion: "FAILURE", logTail: "lint-plan failed" }] });
  await runSweep([f.view], f.deps);
  assert.equal(f.closes.length, 1);
  assert.deepEqual(f.counts(), { updates: 0, reviews: 0, escalations: 0, rounds: 0 });
});

test("dry runs and close failures never seed a successful garden close", async () => {
  for (const dryRun of [true, false]) {
    const f = fixture({}, { closeError: !dryRun });
    f.deps.dryRun = dryRun;
    const result = await runSweep([f.view], f.deps);
    assert.equal(result.actions[0]!.acted, false);
    assert.equal(f.ledger.some(row => row.acted === true), false);
    assert.deepEqual(f.counts(), { updates: 0, reviews: 0, escalations: 0, rounds: 0 });
    if (!dryRun) assert.match(result.actions[0]!.actionError!, /close unavailable/);
  }
});
