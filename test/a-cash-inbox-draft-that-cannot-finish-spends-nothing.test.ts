import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { captureInboxDraftSnapshot, commitInboxDraftOutcomes, draftsDueOnDaemon, inboxDraftExampleFragmentYaml,
  MAX_DRAFT_LINT_ATTEMPTS, planProjectionForDependsOn, resolvedInboxDraftLane, runDraftRung,
  type DraftRungOutcome, type DraftWorkerResult, type Proposal } from "#src/lib/inbox.js";
import type { Config } from "#src/lib/config.js";
import { cashRequestEffort } from "#src/lib/cash-request-effort.js";
import { draftStatsFromRows } from "#src/lib/draft-routing.js";
import { cashDraftFit, openWeightAllowancePath, openWeightReservationUsd, readOpenWeightAllowance,
  reserveOpenWeightBudget } from "#src/lib/worker-provider.js";
import { spawnWorker, type SpawnWorkerArgs } from "#src/lib/worker.js";
import { withWorkspaceCleanup } from "#src/lib/workspace-cleanup-contract.js";
import { draftProposalBatch } from "#test/helpers/run-task-test.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = { step: string } & Record<string, unknown>;
const proposal: Proposal = { id: "P13863", summary: "a cash draft that cannot finish", evidenceAnchors: [] };
const costProposal = { ...proposal, summary: "x".repeat(49_000) };
const clean = `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: cash fit`;
const dirty = "=== FRAGMENT START ===\n- id: NEW-1\n  title: x\n  acceptance: not a list\n=== FRAGMENT END ===\nSTAMP: cash fit";
const PLAN = "- id: W1-T1\n  title: one\n- id: W1-T2\n  title: two\n";
const AT = "2026-11-19T12:00:00.000Z";

function worker(over: Partial<DraftWorkerResult> = {}): DraftWorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text: clean, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    provider: "cash", model: "gpt-oss-120b", servedModel: "gpt-oss-120b", effort: "high",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false, ...over };
}

type FixtureOptions = {
  cap: NonNullable<Config["dailyCapUsd"]>;
  proposal?: Proposal;
  deployments: string[];
  allowCodex?: boolean;
  cashResult?: DraftWorkerResult;
  leaveUsd?: number;
  squeezed?: boolean;
};

/** Exercise the real batch, router and ladder, replacing the external provider boundaries. */
async function productionBatch(t: TestContext, opts: FixtureOptions) {
  const root = ownedFixtureDir(t, "cash-fit-batch").dir;
  const target = gitRepo({ scope: t, kind: "cash-fit-repo" });
  mkdirSync(join(target.dir, "plan"));
  writeFileSync(join(target.dir, "plan", "tasks.yaml"), inboxDraftExampleFragmentYaml().replace("NEW-1", "W1-T1"));
  mkdirSync(join(target.dir, "src", "lib"), { recursive: true });
  writeFileSync(join(target.dir, "src", "lib", "plan.ts"), "export {};\n");
  for (const manifest of ["package.json", "package-lock.json"]) {
    writeFileSync(join(target.dir, manifest), readFileSync(join(REPO_ROOT, manifest)));
  }
  target.git("add", ".");
  target.git("commit", "-m", "fixture plan");
  const origin = gitRepo({ scope: t, bare: true, kind: "cash-fit-origin" });
  target.addRemote("origin", origin.dir);
  target.git("push", "origin", "main");
  mkdirSync(join(root, "repos"));
  renameSync(target.dir, join(root, "repos", "remudero"));
  const config = { root, installRoot: REPO_ROOT, dailyCapUsd: opts.cap,
    workerProviders: { enabled: opts.allowCodex ? ["cash", "codex"] : ["cash"], reservePercent: 5 } } as Config;
  if (opts.leaveUsd !== undefined) {
    config.dailyCapUsd = openWeightReservationUsd("gpt-oss-120b", 300_000) + opts.leaveUsd;
    reserveOpenWeightBudget(config, { requestId: "earlier", deployment: "gpt-oss-120b", requestBodyBytes: 300_000, atIso: AT });
  }
  const rows: Row[] = [];
  const transports: string[] = [];
  const prompts: string[] = [];
  let auctionReads = 0;
  let draft = 0;
  const providerRouting: SpawnWorkerArgs["providerRouting"] = {
    now: () => Date.parse(AT),
    readCodex: async () => {
      auctionReads++;
      return { provider: "codex", readable: true, model: "gpt-6-luna", windows: [{ name: "weekly", usedPercent: 10 }] };
    },
    spawnCodex: async () => { transports.push("codex"); return worker({ provider: "codex", servedModel: "gpt-6-luna" }); },
    spawnOpenWeight: async (_args, _config, selection) => {
      transports.push(selection.model);
      return { ...(opts.cashResult ?? worker()), model: selection.model, servedModel: selection.model };
    },
  };
  const outcomes = await draftProposalBatch([opts.proposal ?? proposal], config, "acme", "remudero", "cash-fit",
    (step, extra) => { rows.push({ step, ...extra }); }, args => {
      if (!args.draftRouting) return spawnWorker(args);
      prompts.push(withWorkspaceCleanup(args.prompt));
      const deployment = opts.deployments[draft++];
      const stats = draftStatsFromRows([{ step: "draft.routing.outcome", lane: "inbox-draft", deployment,
        outcome: "clean", clean: true, draft_cost_usd: 0.000001 }], "inbox-draft");
      return spawnWorker({ ...args, cashSqueezed: opts.squeezed,
        draftRouting: { ...args.draftRouting, random: () => 0.5, readStats: () => stats } });
    }, providerRouting);
  return { config, rows, transports, prompts, outcomes, auctionReads };
}

function skipRow(rows: Row[]) {
  const skipped = rows.find(row => row.step === "inbox.draft_cash_skipped");
  assert.ok(skipped, JSON.stringify(rows));
  return skipped;
}

function commitAndFindDue(t: TestContext, outcomes: DraftRungOutcome[]) {
  const stateDir = ownedFixtureDir(t, "cash-fit-state").dir;
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [costProposal] }));
  const scope = { repository: "acme/remudero" };
  const lane = resolvedInboxDraftLane(REPO_ROOT);
  commitInboxDraftOutcomes({ stateDir, scope, snapshots: [captureInboxDraftSnapshot(costProposal, scope)], outcomes, lane, log: () => {} });
  const attempts = JSON.parse(readFileSync(join(stateDir, "inbox-draft-attempts.json"), "utf8")) as Record<string, string>;
  assert.equal(Object.hasOwn(attempts, costProposal.id), false);
  const drafts = JSON.parse(readFileSync(join(stateDir, "inbox-drafts.json"), "utf8"));
  assert.deepEqual(drafts, {});
  return draftsDueOnDaemon([costProposal], drafts, attempts, 3, undefined, lane);
}

test("W1-T13863 criterion 1: the cash draft is held to the deployment selected by the real router", async t => {
  const big = { ...proposal, summary: "x".repeat(300_000) };
  const run = await productionBatch(t, { cap: 1000, proposal: big, deployments: ["gpt-oss-120b"] });
  assert.deepEqual(run.transports, []);
  assert.equal(run.outcomes[0].ok, false);
  assert.equal(run.rows.find(row => row.step === "draft.routing.choice")?.deployment, "gpt-oss-120b");
  const skipped = skipRow(run.rows);
  assert.equal(skipped.reason, "window");
  assert.equal(skipped.deployment, "gpt-oss-120b");
  assert.equal(skipped.window_tokens, 131_072);
  assert.ok(Number(skipped.estimated_tokens) > 131_072);
  assert.ok(run.prompts[0].length / 4 + 8000 < 131_072);
  assert.deepEqual(cashDraftFit(run.config, { deployment: "gpt-5-nano", expectedRequests: 2,
    promptChars: run.prompts[0].length, atIso: AT }), { fits: true });
});

test("W1-T13863 criterion 2: the selected Haiku deployment is refused with both allowance figures", async t => {
  const run = await productionBatch(t, { cap: 1, leaveUsd: 0.03, proposal: costProposal, deployments: ["claude-haiku-5-5"] });
  assert.deepEqual(run.transports, []);
  assert.equal(run.outcomes[0].ok, false);
  assert.equal(run.rows.find(row => row.step === "draft.routing.choice")?.deployment, "claude-haiku-5-5");
  const skipped = skipRow(run.rows);
  assert.equal(skipped.reason, "allowance");
  assert.equal(skipped.deployment, "claude-haiku-5-5");
  assert.equal(skipped.estimated_usd, openWeightReservationUsd("claude-haiku-5-5", Buffer.byteLength(run.prompts[0])) * 2);
  assert.ok(Math.abs(Number(skipped.left_usd) - 0.03) < 1e-12);
  assert.ok(Number(skipped.estimated_usd) > Number(skipped.left_usd));
  assert.ok(openWeightReservationUsd("gpt-oss-120b", Buffer.byteLength(run.prompts[0])) * 2 < Number(skipped.left_usd));
  assert.equal(readOpenWeightAllowance(run.config, { deployments: ["claude-haiku-5-5"], atIso: AT }).attemptsToday, 1);
});

test("W1-T13863 criterion 3: a skipped draft stays due, costs zero and can draft on a subscription", async t => {
  const unavailable = await productionBatch(t, { cap: 0.02, proposal: costProposal, deployments: ["claude-haiku-5-5"] });
  assert.deepEqual(unavailable.transports, []);
  assert.equal(skipRow(unavailable.rows).attempt, 1);
  assert.throws(() => readFileSync(openWeightAllowancePath(unavailable.config)), { code: "ENOENT" });
  const [due] = commitAndFindDue(t, unavailable.outcomes);
  assert.deepEqual(due, costProposal);

  const next = await productionBatch(t, { cap: 0.02, proposal: due, deployments: ["claude-haiku-5-5"], allowCodex: true });
  assert.equal(skipRow(next.rows).reason, "allowance");
  assert.ok(next.auctionReads > 0);
  assert.deepEqual(next.transports, ["codex"]);
  assert.equal(next.outcomes[0].ok, true, JSON.stringify(next.rows));
  assert.equal(next.rows.find(row => row.step === "inbox.draft_synthesized")?.provider, "codex");
  assert.throws(() => readFileSync(openWeightAllowancePath(next.config)), { code: "ENOENT" });
});

test("a refused relint cannot commit the dirty fragment or retire the proposal", async t => {
  const run = await productionBatch(t, { cap: 0.02, proposal: costProposal,
    deployments: ["gpt-5-nano", "claude-haiku-5-5"], cashResult: worker({ text: dirty, costUsd: 0.001 }) });
  assert.deepEqual(run.transports, ["gpt-5-nano"]);
  assert.equal(skipRow(run.rows).attempt, 2);
  assert.equal(run.rows.find(row => row.step === "inbox.draft_synthesized")?.cost_usd, 0.001);
  assert.equal(run.outcomes[0].ok, false);
  assert.deepEqual(commitAndFindDue(t, run.outcomes).map(p => p.id), [costProposal.id]);
});

test("W1-T13863 criterion 4: a fitting nano route and subscription routing retain their behavior", async t => {
  const run = await productionBatch(t, { cap: 0.02, proposal: costProposal, deployments: ["gpt-5-nano"] });
  assert.deepEqual(run.transports, ["gpt-5-nano"]);
  assert.equal(run.outcomes[0].ok, true);
  assert.equal(run.rows.some(row => row.step === "inbox.draft_cash_skipped"), false);
  assert.ok(openWeightReservationUsd("gpt-oss-120b", run.prompts[0].length) * 2 > 0.02);

  // The existing fair-share deferral can choose a subscription before the cash adapter is reached.
  const subscription = await productionBatch(t, { cap: 0.00001, proposal: costProposal, deployments: ["gpt-5-nano"], allowCodex: true });
  assert.deepEqual(subscription.transports, ["codex"]);
  assert.equal(subscription.outcomes[0].ok, true);
  assert.equal(subscription.rows.some(row => row.step === "inbox.draft_cash_skipped"), false);
});

test("a subscription batch returns per-proposal projection failures for an empty plan", async () => {
  const rows: Row[] = [];
  const outcomes = await runDraftRung([proposal, { ...proposal, id: "P2" }], "", {
    spawn: async () => assert.fail("an unreadable plan cannot reach the worker"),
    log: (step, extra) => rows.push({ step, ...extra }),
  }, "empty-plan");
  assert.deepEqual(outcomes.map(outcome => [outcome.proposalId, outcome.ok]), [[proposal.id, false], ["P2", false]]);
  assert.deepEqual(rows.map(row => [row.proposal_id, row.step]), [[proposal.id, "inbox.draft_error"], ["P2", "inbox.draft_error"]]);
});

test("the routed squeeze posture selects the squeeze allowance", async t => {
  const cap = { normal: 0.01, squeezed: 0.02 };
  const normal = await productionBatch(t, { cap, proposal: costProposal, deployments: ["gpt-5-nano"] });
  assert.equal(skipRow(normal.rows).left_usd, cap.normal);
  const squeezed = await productionBatch(t, { cap, proposal: costProposal, deployments: ["gpt-5-nano"], squeezed: true });
  assert.deepEqual(squeezed.transports, ["gpt-5-nano"]);
});

test("W1-T13863 criterion 5: every draft_synthesized row records prompt_chars and plan_index_chars", async () => {
  const rows: Row[] = [];
  const prompts: string[] = [];
  await runDraftRung([proposal], PLAN, {
    spawn: async (_p, prompt) => { prompts.push(prompt); return worker({ text: dirty }); },
    escalate: async (_p, prompt) => { prompts.push(prompt); return worker({ text: clean, provider: "claude" }); },
    log: (step, extra) => rows.push({ step, ...extra }),
  }, "sizes");
  const synthesized = rows.filter(row => row.step === "inbox.draft_synthesized");
  assert.equal(synthesized.length, MAX_DRAFT_LINT_ATTEMPTS + 1);
  assert.deepEqual(synthesized.map(row => row.prompt_chars), prompts.map(prompt => prompt.length));
  for (const row of synthesized) assert.equal(row.plan_index_chars, planProjectionForDependsOn(PLAN).length);
});

test("cash history averages the middle observations, rounds up and excludes subscription requests", async () => {
  const expected: number[] = [];
  async function observe(requests: number, provider: "cash" | "codex") {
    await runDraftRung([proposal], PLAN, {
      cashFit: input => { expected.push(input.expectedRequests); return { fits: true }; },
      spawn: async (_proposal, prompt, ctx) => {
        if (provider === "cash") ctx?.cashFit?.({ deployment: "gpt-oss-120b", promptChars: prompt.length, atIso: AT });
        return worker({ provider, requestEfforts: [{ ...cashRequestEffort("{}", "chat-completions"), requests }] });
      },
      log: () => {},
    }, "history");
  }
  await observe(1, "cash");
  await observe(4, "cash");
  await observe(11, "codex");
  await observe(6, "cash");
  assert.deepEqual(expected, [2, 1, 3]);
});
