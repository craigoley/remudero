import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { captureInboxDraftSnapshot, commitInboxDraftOutcomes, inboxDraftExampleFragmentYaml,
  MAX_DRAFT_LINT_ATTEMPTS, runDraftRung, type Proposal } from "#src/lib/inbox.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { harnessCommitForShellLessWorker, runFixRung } from "#test/helpers/run-task-test.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type Row = { step: string } & Record<string, unknown>;
const proposal: Proposal = { id: "P9", summary: "model attribution", evidenceAnchors: [] };
const clean = `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: model attribution`;
const dirty = "=== FRAGMENT START ===\n- id: NEW-1\n  title: x\n  acceptance: not a list\n=== FRAGMENT END ===\nSTAMP: model attribution";

function worker(over: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text: clean, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    provider: "claude", model: "requested-draft", servedModel: "served-draft", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false, ...over };
}

function assertModels(row: Row | undefined, requested: string, served: string | null, reason?: string) {
  assert.ok(row, "the attributed row was emitted");
  assert.equal(row.requested_model, requested);
  assert.equal(row.served_model, served);
  if (served === null) {
    assert.equal(typeof row.served_model_reason, "string");
    assert.ok(String(row.served_model_reason).length > 0);
    if (reason) assert.equal(row.served_model_reason, reason);
  } else assert.equal(Object.hasOwn(row, "served_model_reason"), false);
}

test("W1-T10876: an inbox draft row names the requested and served model", async t => {
  for (const scoped of [false, true]) for (const text of [clean, dirty]) {
    for (const servedModel of ["served-draft", undefined]) {
      const stateDir = ownedFixtureDir(t, "draft-model").dir;
      const rows: Row[] = [];
      const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); };
      const scope = { repository: "acme/remudero" };
      const snapshot = captureInboxDraftSnapshot(proposal, scope);
      const outcomes = await runDraftRung([proposal], "- id: W1-T1\n", {
        ...(scoped ? { causalScope: scope } : {}), log,
        spawn: async () => worker({ text, servedModel, servedModelReason: "fixture provider omitted its model" }),
      }, "draft-model");
      assert.equal(outcomes[0].ok, true);
      if (scoped) {
        writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }));
        const args = { stateDir, scope, snapshots: [snapshot], outcomes, log };
        assert.throws(() => commitInboxDraftOutcomes({ ...args, log: () => { throw new Error("append unavailable"); } }), /append unavailable/);
        // Recovery reads the persisted receipt, with no worker or in-memory outcome to consult.
        const pending = JSON.parse(readFileSync(join(stateDir, "inbox-draft-completions.json"), "utf8"));
        assert.equal(Object.keys(pending).length, 1);
        commitInboxDraftOutcomes({ ...args, snapshots: [], outcomes: [] });
      }
      assert.equal(rows.filter(row => row.step === "inbox.drafted").length, 1);
      const row = rows.find(row => row.step === "inbox.drafted");
      assertModels(row, "requested-draft", servedModel ?? null, "fixture provider omitted its model");
      assert.equal(row!.lint_clean, text === clean);
    }
  }
});

test("draft attribution follows the final retry or escalation and survives draft errors", async t => {
  for (const escalation of [false, true]) for (const text of [clean, "malformed final result"]) {
    const rows: Row[] = [];
    let attempts = 0;
    await runDraftRung([proposal], "- id: W1-T1\n", {
      log: (step, extra) => { rows.push({ step, ...extra }); },
      spawn: async () => worker(++attempts === MAX_DRAFT_LINT_ATTEMPTS && !escalation
        ? { text, model: "requested-final", servedModel: "served-final" } : { text: dirty }),
      ...(escalation ? { escalate: async () => worker({ text, model: "requested-final", servedModel: "served-final" }) } : {}),
    }, "final-model");
    assert.equal(attempts, MAX_DRAFT_LINT_ATTEMPTS);
    assertModels(rows.find(row => row.step === (text === clean || escalation ? "inbox.drafted" : "inbox.draft_error")),
      "requested-final", "served-final");
  }
  for (const afterResult of [false, true]) {
    const rows: Row[] = [];
    let calls = 0;
    await runDraftRung([proposal], "- id: W1-T1\n", {
      log: (step, extra) => { rows.push({ step, ...extra }); },
      spawn: async () => {
        if (afterResult && calls++ === 0) return worker({ text: dirty });
        throw new Error("provider unavailable");
      },
    }, "throwing-model");
    const row = rows.find(row => row.step === "inbox.draft_error");
    assert.ok(row);
    assert.equal(rows.filter(row => row.step === "inbox.draft_synthesized").length, afterResult ? 1 : 0);
    assert.equal(row.requested_model, null);
    assert.equal(row.served_model, null);
    assert.equal(typeof row.served_model_reason, "string");
  }
});

function fixFixture(t: TestContext, over: Partial<WorkerResult> = {}) {
  const root = gitRepo({ scope: t, kind: "fix-model" }).dir;
  const rows: Row[] = [];
  const model = "requested-fix";
  const mount = { model, effort: "high", maxTurns: 20, contextBudget: 120000 };
  const review = { state: "failure", criteria: [{ claim: "repair", proof: "unit test: repair", met: false,
    reason: "broken", proof_exec: "not_executable" }], testTheater: false, summary: "broken",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: "head-a", reviewerOutcome: "failure" } as Parameters<typeof runFixRung>[0]["initialReview"];
  let spawns = 0;
  const run: Parameters<typeof runFixRung>[0] = {
    taskId: "W1-T10876", runId: "model-run", task: { id: "W1-T10876", title: "repair", files: ["src/fix.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/10876", branch: "run-W1-T10876-1",
    worktreePath: root, initialSessionId: "initial", mount, settingsFile: join(root, "settings.json"),
    config: { root } as Config, budgetUsd: 10, strikeCap: 1, initialReview: review,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      spawn: async args => { spawns++; assert.equal(args.model, model); return worker({ model: "provider-configured-fix",
        servedModel: "served-fix", text: "REPORT\nCOMMIT_MESSAGE: fix(ci): repair", ...over }); },
      waitForCiGreen: async () => "green", runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "REPORT", push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, ...extra }); }, say: () => {}, account: r => r,
      worktreeHasUncommittedChanges: () => false,
      commitsAhead: () => 0,
      harnessCommitForShellLessWorker: input => harnessCommitForShellLessWorker(input, {
        commit: () => ({ committed: true, sha: "head-b", undeclared: [] }), ahead: () => 1,
      }),
    },
  };
  return { run, rows, spawns: () => spawns };
}

test("W1-T10876: a fix round names the model that repaired it", async t => {
  for (const servedModel of ["served-fix", undefined]) for (const terminal of ["done", "refused", "exhausted", "stood_down", "signal"]) {
    const f = fixFixture(t, { servedModel, servedModelReason: "fixture provider omitted its model",
      ...(terminal === "signal" ? { exit: { kind: "signal", signal: "SIGTERM" } as const } : {}) });
    if (terminal === "refused") f.run.deps.harnessCommitForShellLessWorker = input => { input.onRefusal?.("fixture refused undeclared edits"); return 0; };
    if (terminal === "exhausted") f.run.deps.runReview = async () => f.run.initialReview;
    if (terminal === "stood_down") f.run.deps.waitForCiGreen = async () => ({ state: "freshness_handoff", sha: "head-b", oldSha: "head-a", newSha: "head-b" });
    await runFixRung(f.run);
    assert.equal(f.spawns(), 1, terminal);
    assert.ok(f.rows.some(row => row.step === "fix.done"), `${terminal}: ${f.rows.map(row => row.step).join(", ")}`);
    if (terminal !== "signal") assert.equal(f.rows.find(row => row.step === "fix.dispatch")?.requested_model, "requested-fix");
    assertModels(f.rows.find(row => row.step === "fix.done"), "requested-fix", servedModel ?? null, "fixture provider omitted its model");
    const step = { done: "fix.done", refused: "fix.commit_refused", exhausted: "fix.exhausted", stood_down: "fix.stood_down", signal: "fix.done" }[terminal];
    assert.ok(f.rows.some(row => row.step === step), `${terminal}: ${f.rows.map(row => row.step).join(", ")}`);
    assertModels(f.rows.find(row => row.step === step), "requested-fix", servedModel ?? null, "fixture provider omitted its model");
  }
});

test("W1-T10876: a fix row with no worker names no model", async t => {
  const control = fixFixture(t);
  await runFixRung(control.run);
  assertModels(control.rows.find(row => row.step === "fix.done"), "requested-fix", "served-fix");
  for (const admission of [false, true]) {
    const f = fixFixture(t, { notStarted: "admission-abandoned" });
    if (!admission) f.run.deps.fetchPrDiffFiles = async () => { throw new Error("diff unavailable"); };
    await runFixRung(f.run);
    assert.equal(f.spawns(), admission ? 1 : 0);
    const terminals = f.rows.filter(row => row.step === "fix.done" || row.step === "fix.stood_down");
    assert.equal(terminals.length, 1);
    for (const row of terminals) for (const key of ["model", "requested_model", "served_model", "served_model_reason"]) {
      assert.equal(Object.hasOwn(row, key), false, `${key} cannot name a worker that never ran`);
    }
  }
});

test("fix attribution changes with the round and does not leak into a later unstarted round", async t => {
  for (const secondWorker of [true, false]) {
    const f = fixFixture(t);
    f.run.strikeCap = 2;
    f.run.stepUpMount = { ...f.run.mount, model: "requested-step-up" };
    let spawns = 0, reviews = 0, reads = 0;
    f.run.deps.spawn = async args => worker({ model: args.model, servedModel: `served-${++spawns}`,
      text: "REPORT\nCOMMIT_MESSAGE: fix(ci): repair" });
    f.run.deps.fetchPrDiffFiles = async () => {
      if (++reads === 3 && !secondWorker) throw new Error("next round diff unavailable");
      return ["src/fix.ts"];
    };
    f.run.deps.runReview = async () => ({ ...f.run.initialReview, headSha: "head-b",
      state: ++reviews === 1 ? "failure" : "success",
      criteria: [{ ...f.run.initialReview.criteria[0], claim: "repair next finding" }] });
    await runFixRung(f.run);
    const done = f.rows.filter(row => row.step === "fix.done");
    assertModels(done[0], "requested-fix", "served-1");
    assert.equal(spawns, secondWorker ? 2 : 1);
    if (secondWorker) {
      assertModels(done[1], "requested-step-up", "served-2");
      assert.deepEqual(f.rows.filter(row => row.step === "fix.dispatch").map(row => row.requested_model),
        ["requested-fix", "requested-step-up"]);
    } else {
      const stoodDown = f.rows.find(row => row.step === "fix.stood_down");
      assert.ok(stoodDown);
      for (const key of ["model", "requested_model", "served_model", "served_model_reason"]) {
        assert.equal(Object.hasOwn(stoodDown, key), false, `previous worker leaked ${key}`);
      }
    }
  }
});
