import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { captureInboxDraftSnapshot, commitInboxDraftOutcomes, draftsDueOnDaemon, inboxDraftExampleFragmentYaml,
  MAX_DRAFT_LINT_ATTEMPTS, planProjectionForDependsOn, readDraftCashResumes, resolvedInboxDraftLane, runDraftRung,
  type DraftWorkerResult, type Proposal } from "#src/lib/inbox.js";
import type { Config } from "#src/lib/config.js";
import { cashRequestEffort } from "#src/lib/cash-request-effort.js";
import { draftStatsFromRows } from "#src/lib/draft-routing.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { cashDraftFit, openWeightAllowancePath, openWeightReservationUsd, readOpenWeightAllowance,
  reserveOpenWeightBudget, settleOpenWeightBudget } from "#src/lib/worker-provider.js";
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
  unpinnedMount?: boolean;
  blockedAuction?: boolean;
  cashResult?: DraftWorkerResult;
  leaveUsd?: number;
  relintDeployment?: string;
  root?: string;
  resume?: boolean;
};

/** Exercise the real batch, router and ladder, replacing the external provider boundaries. */
async function productionBatch(t: TestContext, opts: FixtureOptions) {
  const root = opts.root ?? ownedFixtureDir(t, "cash-fit-batch").dir;
  if (!opts.root) {
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
  }
  const config = { root, installRoot: REPO_ROOT, dailyCapUsd: opts.cap,
    workerProviders: { enabled: opts.allowCodex || opts.blockedAuction ? ["cash", "codex"] : ["cash"], reservePercent: 5,
      cashFallbackWhenBlocked: opts.blockedAuction } } as Config;
  const mount = opts.unpinnedMount
    ? { ...loadMounts(mountsPath(REPO_ROOT)).synthesis.inbox_draft, provider: undefined }
    : undefined;
  if (opts.leaveUsd !== undefined) {
    config.dailyCapUsd = openWeightReservationUsd("gpt-oss-120b", 300_000) + opts.leaveUsd;
    reserveOpenWeightBudget(config, { requestId: "earlier", deployment: "gpt-oss-120b", requestBodyBytes: 300_000, atIso: AT });
  }
  const rows: Row[] = [];
  const transports: string[] = [];
  const cashPostures: (boolean | undefined)[] = [];
  const prompts: string[] = [];
  let auctionReads = 0;
  let draft = 0;
  const providerRouting: SpawnWorkerArgs["providerRouting"] = {
    now: () => Date.parse(AT),
    readCodex: async () => {
      auctionReads++;
      return { provider: "codex", readable: true, model: "gpt-6-luna",
        windows: [{ name: "weekly", usedPercent: opts.blockedAuction ? 100 : 10 }] };
    },
    spawnCodex: async () => { transports.push("codex"); return worker({ provider: "codex", servedModel: "gpt-6-luna" }); },
    spawnOpenWeight: async (args, _config, selection) => {
      const first = transports.length === 0;
      transports.push(selection.model);
      cashPostures.push(args.cashSqueezed);
      const result = first ? opts.cashResult ?? worker() : worker();
      if (result.costUsd > 0) {
        const requestId = randomUUID();
        const identity = { requestId, attemptId: requestId, provider: "cash" as const, deployment: selection.model,
          endpoint: "https://cash.example.test" };
        reserveOpenWeightBudget(config, { requestId, identity, deployment: selection.model, requestBodyBytes: Buffer.byteLength(args.prompt),
          atIso: AT, squeezed: args.cashSqueezed });
        settleOpenWeightBudget(config, { requestId, identity, atIso: AT, actualUsd: result.costUsd });
      }
      return { ...result, model: selection.model, servedModel: selection.model };
    },
  };
  const draftedProposal = opts.proposal ?? proposal;
  const outcomes = await draftProposalBatch([draftedProposal], config, "acme", "remudero", "cash-fit",
    (step, extra) => { rows.push({ step, ...extra }); }, args => {
      if (!args.draftRouting) return spawnWorker(args);
      prompts.push(withWorkspaceCleanup(args.prompt));
      const deployment = opts.deployments[draft++];
      const stats = draftStatsFromRows([{ step: "draft.routing.outcome", lane: "inbox-draft", deployment,
        outcome: "clean", clean: true, draft_cost_usd: 0.000001 }], "inbox-draft");
      return spawnWorker({ ...args,
        ...((draft > 1 || opts.resume) && opts.relintDeployment ? {
          routingTrial: { id: "inbox-bakeoff", arm: "cash", reason: "fixture relint deployment", models: [opts.relintDeployment] },
        } : {}),
        draftRouting: { ...args.draftRouting, random: () => 0.5, readStats: () => stats } });
    }, providerRouting, mount, opts.resume ? readDraftCashResumes(join(root, "state")) : undefined);
  return { config, rows, transports, prompts, outcomes, auctionReads, cashPostures, proposal: draftedProposal };
}

function skipRow(rows: Row[]) {
  const skipped = rows.find(row => row.step === "inbox.draft_cash_skipped");
  assert.ok(skipped, JSON.stringify(rows));
  return skipped;
}

function commitBatch(run: Awaited<ReturnType<typeof productionBatch>>) {
  const stateDir = join(run.config.root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [run.proposal] }));
  const scope = { repository: "acme/remudero" };
  const lane = resolvedInboxDraftLane(REPO_ROOT);
  commitInboxDraftOutcomes({ stateDir, scope, snapshots: [captureInboxDraftSnapshot(run.proposal, scope)],
    outcomes: run.outcomes, lane, log: () => {} });
  const attempts = JSON.parse(readFileSync(join(stateDir, "inbox-draft-attempts.json"), "utf8")) as Record<string, string>;
  const drafts = JSON.parse(readFileSync(join(stateDir, "inbox-drafts.json"), "utf8"));
  return { attempts, drafts, due: draftsDueOnDaemon([run.proposal], drafts, attempts, 3, undefined, lane) };
}

test("W1-T13863 criterion 1: the cash draft is held to the deployment selected by the real router", async t => {
  const big = { ...proposal, summary: "x".repeat(300_000) };
  const run = await productionBatch(t, { cap: 1000, proposal: big, deployments: ["gpt-oss-120b"],
    unpinnedMount: true, blockedAuction: true });
  assert.equal(run.auctionReads, 1);
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

  const ladder = await productionBatch(t, { cap: 1000, proposal: big, deployments: ["gpt-6-luna"],
    cashResult: worker({ text: "missing the fragment markers", costUsd: 0.001 }) });
  assert.deepEqual(ladder.transports, ["gpt-6-luna"]);
  assert.equal(ladder.outcomes[0].ok, false);
  assert.equal(skipRow(ladder.rows).deployment, "gpt-oss-120b");
  assert.equal(skipRow(ladder.rows).reason, "window");
  const pending = commitBatch(ladder);
  assert.deepEqual(pending.attempts, {});
  assert.deepEqual(pending.drafts, {});
  assert.deepEqual(readDraftCashResumes(join(ladder.config.root, "state"))[big.id]?.paidDeployments, ["gpt-6-luna"]);
  assert.deepEqual(pending.due, [big]);

  for (const blockedAuction of [false, true]) {
    const alreadyPaid = await productionBatch(t, { cap: 1000, root: ladder.config.root, resume: true, proposal: big,
      deployments: ["gpt-6-luna"], relintDeployment: "gpt-6-luna", unpinnedMount: blockedAuction, blockedAuction });
    assert.deepEqual(alreadyPaid.transports, []);
    assert.equal(alreadyPaid.outcomes[0].ok, false);
    assert.match(alreadyPaid.outcomes[0].ok ? "" : alreadyPaid.outcomes[0].error, /excluding previously paid draft work/);
    assert.deepEqual(commitBatch(alreadyPaid).due, [big]);
  }
  const retry = await productionBatch(t, { cap: 1000, root: ladder.config.root, resume: true, proposal: big,
    deployments: ["gpt-5-nano"] });
  assert.deepEqual(retry.transports, ["gpt-5-nano"]);
  assert.equal(retry.outcomes[0].ok, true);
});

test("W1-T13863 criterion 2: normal cash and squeezed fallback report both allowance figures", async t => {
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

  const cap = { normal: 0.001, squeezed: 0.01 };
  const fallback = await productionBatch(t, { cap, proposal: costProposal, deployments: ["gpt-5-nano"],
    unpinnedMount: true, blockedAuction: true });
  assert.equal(fallback.auctionReads, 1);
  assert.deepEqual(fallback.transports, []);
  assert.equal(fallback.outcomes[0].ok, false);
  const held = skipRow(fallback.rows);
  const single = openWeightReservationUsd("gpt-5-nano", Buffer.byteLength(fallback.prompts[0]));
  assert.equal(held.reason, "allowance");
  assert.equal(held.deployment, "gpt-5-nano");
  assert.equal(held.left_usd, cap.squeezed);
  assert.equal(held.estimated_usd, single * 2);
  assert.ok(single < cap.squeezed && cap.squeezed < single * 2);
  assert.throws(() => readFileSync(openWeightAllowancePath(fallback.config)), { code: "ENOENT" });

  const ladder = await productionBatch(t, { cap: 0.02, proposal: costProposal, deployments: ["gpt-6-luna"],
    cashResult: worker({ text: "missing the fragment markers" }) });
  assert.deepEqual(ladder.transports, ["gpt-6-luna"]);
  assert.equal(ladder.outcomes[0].ok, false);
  const later = skipRow(ladder.rows);
  assert.equal(later.reason, "allowance");
  assert.equal(later.deployment, "gpt-oss-120b");
  assert.equal(later.left_usd, 0.02);
  assert.equal(later.estimated_usd, openWeightReservationUsd("gpt-oss-120b", Buffer.byteLength(ladder.prompts[0])) * 2);
  assert.deepEqual(cashDraftFit(ladder.config, { deployment: "gpt-5-nano", expectedRequests: 2,
    promptChars: ladder.prompts[0].length, atIso: AT }), { fits: true });
});

test("W1-T13863 criterion 3: a skipped draft stays due, costs zero and can draft on a subscription", async t => {
  const held = await productionBatch(t, { cap: 0.02, proposal: costProposal, deployments: ["claude-haiku-5-5"], allowCodex: true });
  assert.deepEqual(held.transports, []);
  assert.equal(held.auctionReads, 0);
  assert.equal(skipRow(held.rows).attempt, 1);
  assert.throws(() => readFileSync(openWeightAllowancePath(held.config)), { code: "ENOENT" });
  const committed = commitBatch(held);
  assert.deepEqual(committed.attempts, {});
  assert.deepEqual(committed.drafts, {});
  assert.deepEqual(readDraftCashResumes(join(held.config.root, "state")), {});
  const [due] = committed.due;
  assert.deepEqual(due, costProposal);

  const next = await productionBatch(t, { cap: 0.02, root: held.config.root, proposal: due,
    deployments: [], allowCodex: true, unpinnedMount: true });
  assert.ok(next.auctionReads > 0);
  assert.deepEqual(next.transports, ["codex"]);
  assert.equal(next.outcomes[0].ok, true, JSON.stringify(next.rows));
  assert.equal(next.rows.find(row => row.step === "inbox.draft_synthesized")?.provider, "codex");
  assert.throws(() => readFileSync(openWeightAllowancePath(next.config)), { code: "ENOENT" });
});

test("W1-T13863 criterion 3: a refused relint resumes after the paid synthesis without replaying it", async t => {
  const run = await productionBatch(t, { cap: 0.02, proposal: costProposal,
    deployments: ["gpt-5-nano", "claude-haiku-5-5"], cashResult: worker({ text: dirty, costUsd: 0.001 }) });
  assert.deepEqual(run.transports, ["gpt-5-nano"]);
  assert.equal(skipRow(run.rows).attempt, 2);
  assert.equal(run.rows.find(row => row.step === "inbox.draft_synthesized")?.cost_usd, 0.001);
  assert.equal(run.outcomes[0].ok, false);
  const stateDir = join(run.config.root, "state");
  const committed = commitBatch(run);
  assert.deepEqual(committed.attempts, {});
  assert.deepEqual(committed.drafts, {});
  assert.deepEqual(committed.due, [costProposal]);
  assert.equal(readDraftCashResumes(stateDir)[costProposal.id]?.attempt, 2);

  const retry = await productionBatch(t, { cap: 1, root: run.config.root, resume: true, proposal: committed.due[0],
    deployments: ["gpt-5-nano"], relintDeployment: "gpt-5-nano" });
  assert.deepEqual(retry.transports, ["gpt-5-nano"]);
  assert.equal(retry.outcomes[0].ok, true, JSON.stringify(retry.rows));
  assert.match(retry.prompts[0], /FAILED the plan's own linter/);
  assert.equal(retry.rows.find(row => row.step === "inbox.draft_synthesized")?.attempt, 2);
  const allowance = readOpenWeightAllowance(retry.config, { deployments: ["gpt-5-nano"], atIso: AT });
  assert.equal(allowance.attemptsToday, 1);
  assert.equal(allowance.settledToday["gpt-5-nano"]?.settledUsd, 0.001);
  assert.deepEqual(commitBatch(retry).due, []);
  assert.deepEqual(readDraftCashResumes(stateDir), {});
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

  const ladder = await productionBatch(t, { cap: 1000, deployments: ["gpt-6-luna"],
    cashResult: worker({ text: "missing the fragment markers" }) });
  assert.deepEqual(ladder.transports, ["gpt-6-luna", "gpt-oss-120b"]);
  assert.equal(ladder.outcomes[0].ok, true);
  assert.deepEqual(ladder.rows.filter(row => row.step === "draft.routing.choice")
    .map(row => [row.deployment, row.reason]), [
    ["gpt-6-luna", "thompson-clean-per-dollar"], ["gpt-oss-120b", "draft-contract"],
  ]);

  const excluded = await productionBatch(t, { cap: 1000, deployments: ["gpt-5-nano"], unpinnedMount: true,
    blockedAuction: true, relintDeployment: "gpt-5-nano", cashResult: worker({ text: dirty }) });
  assert.deepEqual(excluded.transports, ["gpt-5-nano"]);
  assert.equal(excluded.outcomes[0].ok, false);
  assert.match(excluded.outcomes[0].ok ? "" : excluded.outcomes[0].error, /no eligible cash deployment/);
  assert.equal(excluded.rows.some(row => row.step === "inbox.draft_cash_skipped"), false);
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
  const squeezed = await productionBatch(t, { cap, proposal: costProposal, deployments: ["gpt-5-nano"],
    unpinnedMount: true, blockedAuction: true });
  assert.equal(squeezed.auctionReads, 1);
  assert.deepEqual(squeezed.transports, ["gpt-5-nano"]);
  assert.deepEqual(squeezed.cashPostures, [true]);
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
