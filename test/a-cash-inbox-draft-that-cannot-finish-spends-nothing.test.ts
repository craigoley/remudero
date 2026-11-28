import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { captureInboxDraftSnapshot, commitInboxDraftOutcomes, DRAFT_RETRY_FULL_INDEX_FILE, draftsDueOnDaemon, inboxDraftExampleFragmentYaml,
  planProjectionForDependsOn, readDraftCashResumes, resolvedInboxDraftLane, runDraftRung,
  type DraftCashResumes, type DraftRungOutcome, type DraftWorkerResult, type Proposal } from "#src/lib/inbox.js";
import type { Config } from "#src/lib/config.js";
import { cashRequestEffort } from "#src/lib/cash-request-effort.js";
import { fixedClock } from "#src/lib/clock.js";
import { draftStatsFromRows } from "#src/lib/draft-routing.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { cashDraftFit, openWeightAllowancePath, openWeightReservationUsd, readOpenWeightAllowance,
  reserveOpenWeightBudget, settleOpenWeightBudget, spawnOpenWeightWorker, type CashDraftFitInput } from "#src/lib/worker-provider.js";
import { CLAUDE_BIN_ENV_OVERRIDE, spawnWorker, type SpawnWorkerArgs } from "#src/lib/worker.js";
import { withWorkspaceCleanup } from "#src/lib/workspace-cleanup-contract.js";
import { buildInboxDraftHook, draftProposalBatch } from "#test/helpers/run-task-test.js";
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
  only?: string[];
  statsUnavailable?: boolean;
  allowCodex?: boolean;
  allowClaude?: boolean;
  blockedClaude?: boolean;
  unreadableAllowance?: boolean;
  omitFit?: boolean;
  unpinnedMount?: boolean;
  effort?: string;
  blockedAuction?: boolean;
  cashResult?: DraftWorkerResult;
  leaveUsd?: number;
  relintDeployment?: string;
  root?: string;
  resume?: boolean;
  proposals?: Proposal[];
  polls?: number;
  afterPoll?: (root: string, poll: number) => void;
  retryFullIndex?: boolean;
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
  if (opts.retryFullIndex) {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", DRAFT_RETRY_FULL_INDEX_FILE), "");
  }
  const config = { root, installRoot: REPO_ROOT, dailyCapUsd: opts.cap,
    workerProviders: { enabled: ["cash", ...(opts.allowCodex || opts.blockedAuction ? ["codex"] : []), ...(opts.allowClaude ? ["claude"] : [])],
      reservePercent: 5, cashEndpoint: "https://cash.example.test/",
      cashFallbackWhenBlocked: opts.blockedAuction } } as Config;
  const defaultMount = loadMounts(mountsPath(REPO_ROOT)).synthesis.inbox_draft;
  const mount = opts.unpinnedMount || opts.effort ? { ...defaultMount,
    provider: opts.unpinnedMount ? undefined : defaultMount.provider, effort: opts.effort ?? defaultMount.effort } : undefined;
  if (opts.leaveUsd !== undefined) {
    config.dailyCapUsd = openWeightReservationUsd("gpt-oss-120b", 300_000) + opts.leaveUsd;
    reserveOpenWeightBudget(config, { requestId: "earlier", deployment: "gpt-oss-120b", requestBodyBytes: 300_000, atIso: AT });
  }
  if (opts.unreadableAllowance) {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(openWeightAllowancePath(config), "{");
  }
  const rows: Row[] = [];
  const transports: string[] = [];
  const cashPostures: (boolean | undefined)[] = [];
  const prompts: string[] = [];
  const subscriptionPrompts: string[] = [];
  const cashPrompts: string[] = [];
  const fitInputs: Array<Omit<CashDraftFitInput, "expectedRequests">> = [];
  let auctionReads = 0;
  let claudeReads = 0;
  let cashAdapterCalls = 0;
  let draft = 0;
  const providerRouting: SpawnWorkerArgs["providerRouting"] = {
    now: () => Date.parse(AT),
    readClaude: async () => {
      claudeReads++;
      return { provider: "claude", readable: true, windows: [{ name: "weekly", usedPercent: opts.blockedClaude ? 100 : 10 }] };
    },
    readCodex: async () => {
      auctionReads++;
      return { provider: "codex", readable: true, model: "gpt-6-luna",
        windows: [{ name: "weekly", usedPercent: opts.blockedAuction ? 100 : 10 }] };
    },
    spawnCodex: async args => {
      transports.push("codex");
      subscriptionPrompts.push(args.prompt);
      return worker({ provider: "codex", servedModel: "gpt-6-luna" });
    },
    spawnOpenWeight: async (args, _config, selection) => {
      cashAdapterCalls++;
      if (opts.unreadableAllowance) {
        const blocked = await spawnOpenWeightWorker({ ...args, env: { RMD_OPENWEIGHT_API_KEY: "fixture" }, clock: fixedClock(Date.parse(AT)),
          fetchImpl: async () => { transports.push(selection.model); return assert.fail("unreadable allowance reached cash transport"); } }, config, selection);
        assert.equal(blocked.costUsd, 0);
        assert.match(blocked.stderr, /allowance file is unreadable/);
        return blocked;
      }
      const first = transports.length === 0;
      transports.push(selection.model);
      cashPrompts.push(args.prompt);
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
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); };
  const rawSpawn: typeof spawnWorker = input => {
    const args: SpawnWorkerArgs = opts.allowClaude ? { ...input,
      claudeExecutable: { cache: {}, deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: root,
        which: () => undefined, exists: () => true, canExecute: () => true, locations: [] } },
      keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "fixture", expiresAt: 4_102_444_800_000 } }) },
      queryFn: (({ prompt }: { prompt: string }) => {
        transports.push("claude");
        subscriptionPrompts.push(prompt);
        return (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: clean, session_id: "rescue", total_cost_usd: 0, num_turns: 1 };
        })();
      }) as SpawnWorkerArgs["queryFn"],
    } : input;
    if (!args.draftRouting) return spawnWorker(args);
    prompts.push(withWorkspaceCleanup(args.promptFor?.({ provider: "cash", harnessOwnsGit: false }) ?? args.prompt));
    const deployment = opts.deployments[draft++];
    const stats = draftStatsFromRows([{ step: "draft.routing.outcome", lane: "inbox-draft", deployment,
      outcome: "clean", clean: true, draft_cost_usd: 0.000001 }], "inbox-draft");
    const models = (draft > 1 || opts.resume) && opts.relintDeployment ? [opts.relintDeployment] : opts.only;
    const fit = args.draftRouting.cashFit;
    return spawnWorker({ ...args,
      ...(models ? {
        routingTrial: { id: "inbox-bakeoff", arm: "cash", reason: "fixture deployments", models },
      } : {}),
      draftRouting: { ...args.draftRouting, cashFit: !fit || opts.omitFit ? undefined : input => {
        fitInputs.push(input);
        return fit(input);
      }, random: () => 0.5, readStats: () => {
        if (opts.statsUnavailable) throw new Error("fixture stats unavailable");
        return stats;
      } } });
  };
  const runBatch = (due: Proposal[], cashResumes?: DraftCashResumes, subscriptionRetryIds?: ReadonlySet<string>) =>
    draftProposalBatch(due, config, "acme", "remudero", "cash-fit", log, rawSpawn, providerRouting, mount, cashResumes, subscriptionRetryIds);
  let outcomes: DraftRungOutcome[] | undefined;
  const batches: string[][] = [];
  if (opts.proposals) {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: opts.proposals }));
  }
  if (opts.resume || opts.proposals) {
    const hook = buildInboxDraftHook("acme", "remudero", config, "cash-fit", log,
      async (due, _config, _owner, _repo, _runId, _log, _spawn, _routing, _mount, cashResumes, subscriptionRetryIds) => {
        batches.push(due.map(proposal => proposal.id));
        outcomes = await runBatch(due, cashResumes, subscriptionRetryIds);
        return outcomes;
      }, undefined, () => undefined);
    for (let poll = 0; poll < (opts.polls ?? 1); poll++) {
      await hook();
      opts.afterPoll?.(root, poll);
    }
  } else {
    outcomes = await runBatch([draftedProposal]);
  }
  assert.ok(outcomes, JSON.stringify(rows));
  return { config, rows, transports, prompts, subscriptionPrompts, cashPrompts, fitInputs, outcomes, batches,
    auctionReads, claudeReads, cashAdapterCalls, cashPostures, proposal: draftedProposal };
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
  return readBatchState(run);
}

function readBatchState(run: Awaited<ReturnType<typeof productionBatch>>) {
  return draftState(run.config.root, run.proposal);
}

function draftState(root: string, proposal: Proposal) {
  const stateDir = join(root, "state");
  const attempts = JSON.parse(readFileSync(join(stateDir, "inbox-draft-attempts.json"), "utf8")) as Record<string, string>;
  const drafts = JSON.parse(readFileSync(join(stateDir, "inbox-drafts.json"), "utf8"));
  return { attempts, drafts, due: draftsDueOnDaemon([proposal], drafts, attempts, 3, undefined, resolvedInboxDraftLane(REPO_ROOT)) };
}

test("W1-T13863 criterion 1: the cash draft is held to the deployment selected by the real router", async t => {
  const big = { ...proposal, summary: "x".repeat(300_000) };
  const run = await productionBatch(t, { cap: 1000, proposal: big, deployments: ["gpt-oss-120b"],
    only: ["gpt-oss-120b"], unpinnedMount: true, blockedAuction: true });
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
    only: ["gpt-6-luna", "gpt-oss-120b"],
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
  const run = await productionBatch(t, { cap: 1, leaveUsd: 0.03, proposal: costProposal, deployments: ["claude-haiku-5-5"],
    only: ["claude-haiku-5-5"] });
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
    only: ["gpt-5-nano"], unpinnedMount: true, blockedAuction: true });
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
    only: ["gpt-6-luna", "gpt-oss-120b"],
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
  const big = { ...proposal, summary: "x".repeat(2_050_000) };
  const run = await productionBatch(t, { cap: 1000, proposal: big, proposals: [big], polls: 2,
    deployments: [], statsUnavailable: true, allowCodex: true, afterPoll: (root, poll) => {
      if (poll !== 0) return;
      const pending = draftState(root, big);
      assert.deepEqual(pending.attempts, {});
      assert.deepEqual(pending.drafts, {});
      assert.deepEqual(pending.due, [big]);
      assert.deepEqual(readDraftCashResumes(join(root, "state")), {});
    } });
  assert.deepEqual(run.batches, [[big.id], [big.id]]);
  assert.ok(run.auctionReads > 0);
  assert.equal(run.cashAdapterCalls, 0);
  assert.deepEqual(run.transports, ["codex"]);
  assert.equal(skipRow(run.rows).reason, "window");
  assert.equal(run.outcomes[0].ok, true, JSON.stringify(run.rows));
  const synthesized = run.rows.find(row => row.step === "inbox.draft_synthesized");
  assert.equal(synthesized?.provider, "codex");
  assert.equal(synthesized?.prompt_chars, run.subscriptionPrompts[0].length);
  assert.deepEqual(readBatchState(run).due, []);
  assert.throws(() => readFileSync(openWeightAllowancePath(run.config)), { code: "ENOENT" });

  const blocked = await productionBatch(t, { cap: 1000, proposal: big, proposals: [big], polls: 2,
    deployments: [], statsUnavailable: true, blockedAuction: true });
  assert.equal(blocked.auctionReads, 1);
  assert.deepEqual(blocked.transports, []);
  const skips = (rows: Row[]) => rows.filter(row => row.step === "inbox.draft_cash_skipped").map(row => row.deployment);
  assert.deepEqual(skips(blocked.rows), [...skips(run.rows), ...skips(run.rows)]);
  assert.deepEqual(readBatchState(blocked).attempts, {});
  assert.deepEqual(readBatchState(blocked).due, [big]);

  const claudeBlocked = await productionBatch(t, { cap: 1000, proposal: big, proposals: [big], polls: 2,
    deployments: [], statsUnavailable: true, allowClaude: true, blockedClaude: true });
  assert.equal(claudeBlocked.claudeReads, 1);
  assert.deepEqual(claudeBlocked.transports, []);
  assert.deepEqual(skips(claudeBlocked.rows), [...skips(run.rows), ...skips(run.rows)]);
  assert.deepEqual(readBatchState(claudeBlocked).attempts, {});
});

test("W1-T13863 criterion 3: an allowance skip walks the unchanged row-order ladder to a fitting deployment", async t => {
  const run = await productionBatch(t, { cap: 1, leaveUsd: 0.02, proposal: costProposal,
    deployments: [], statsUnavailable: true, cashResult: worker({ costUsd: 0.001 }) });
  assert.deepEqual(run.rows.filter(row => row.step === "draft.routing.choice").map(row => [row.deployment, row.reason]), [
    ["gpt-oss-120b", "stats-read-failed-row-order"], ["gpt-5-nano", "cash-draft-fit"],
  ]);
  const skipped = skipRow(run.rows);
  assert.equal(skipped.reason, "allowance");
  assert.equal(skipped.deployment, "gpt-oss-120b");
  assert.deepEqual(run.transports, ["gpt-5-nano"]);
  assert.equal(run.outcomes[0].ok, true);
  const allowance = readOpenWeightAllowance(run.config, { deployments: ["gpt-oss-120b", "gpt-5-nano"], atIso: AT });
  assert.equal(allowance.attemptsToday, 2); // The seed reservation and the one fitting transport.
  assert.deepEqual(allowance.settledToday, { "gpt-5-nano": { attempts: 1, settledUsd: 0.001 } });
  assert.deepEqual(commitBatch(run).due, []);
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
  assert.deepEqual(readBatchState(retry).due, []);
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
  assert.deepEqual(subscription.fitInputs, []);
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

test("W1-T13863 criterion 4: unreadable cash allowance still reaches the existing Sonnet rescue", async t => {
  const fixture = { cap: 1000, deployments: ["gpt-oss-120b"], only: ["gpt-oss-120b"], allowClaude: true, unreadableAllowance: true };
  const control = await productionBatch(t, { ...fixture, omitFit: true });
  assert.equal(control.cashAdapterCalls, 1);
  assert.deepEqual(control.transports, ["claude"], JSON.stringify(control.rows));
  assert.equal(control.outcomes[0].ok, true);

  const run = await productionBatch(t, fixture);
  assert.equal(run.cashAdapterCalls, 0);
  assert.deepEqual(run.transports, ["claude"], JSON.stringify(run.rows));
  assert.equal(run.outcomes[0].ok, true, JSON.stringify(run.rows));
  assert.equal(run.fitInputs.length, 1);
  assert.deepEqual(run.subscriptionPrompts, control.subscriptionPrompts);
  const skipped = skipRow(run.rows);
  assert.equal(skipped.reason, "allowance");
  assert.equal(skipped.left_usd, null);
  assert.match(String(skipped.allowance_error), /allowance file is unreadable/);
  assert.equal(run.rows.find(row => row.step === "inbox.draft_escalated")?.reason, "allowance-unreadable");
  assert.equal(readFileSync(openWeightAllowancePath(run.config), "utf8"), "{");

  const noRescue = await productionBatch(t, { ...fixture, allowClaude: false });
  assert.deepEqual(noRescue.transports, []);
  assert.deepEqual(commitBatch(noRescue).attempts, {});
  assert.deepEqual(readBatchState(noRescue).due, [proposal]);
});

test("W1-T13863 criterion 4: a subscription retry starts with the original prompt and attempt after a cash relint skip", async t => {
  const held = await productionBatch(t, { cap: 0.02, proposal: costProposal,
    deployments: ["gpt-5-nano", "claude-haiku-5-5"], cashResult: worker({ text: dirty, costUsd: 0.001 }) });
  assert.deepEqual(held.transports, ["gpt-5-nano"]);
  assert.equal(skipRow(held.rows).attempt, 2);
  assert.deepEqual(commitBatch(held).attempts, {});
  assert.equal(readDraftCashResumes(join(held.config.root, "state"))[costProposal.id]?.attempt, 2);
  const subscription = await productionBatch(t, { cap: 0.001, root: held.config.root, resume: true,
    proposal: costProposal, deployments: [], allowCodex: true, unpinnedMount: true });
  assert.deepEqual(subscription.transports, ["codex"]);
  assert.equal(subscription.subscriptionPrompts[0] === held.prompts[0], true);
  assert.equal(subscription.rows.find(row => row.step === "inbox.draft_synthesized")?.attempt, 1);
  assert.equal(subscription.rows.some(row => row.step === "inbox.draft_cash_skipped" || row.step === "inbox.draft_fellthrough"), false);
  assert.deepEqual(readBatchState(subscription).due, []);
});

test("W1-T13863 criterion 4: three oversized proposals release the next daemon batch's slots", async t => {
  const oversized = [1, 2, 3].map(n => ({ ...proposal, id: `P${n}`, summary: "x".repeat(2_050_000) }));
  const fitting = { ...proposal, id: "P4" };
  const proposals = [...oversized, fitting];
  const run = await productionBatch(t, { cap: 1, deployments: [], statsUnavailable: true, proposals, polls: 3 });
  assert.deepEqual(run.batches, [["P1", "P2", "P3"], ["P4", "P1", "P2"], ["P3", "P1", "P2"]]);
  assert.deepEqual(run.transports, ["gpt-oss-120b"]);
  const stateDir = join(run.config.root, "state");
  const attempts = JSON.parse(readFileSync(join(stateDir, "inbox-draft-attempts.json"), "utf8"));
  const drafts = JSON.parse(readFileSync(join(stateDir, "inbox-drafts.json"), "utf8"));
  assert.deepEqual(attempts, {});
  assert.deepEqual(Object.keys(drafts), [fitting.id]);
  assert.deepEqual(run.rows.filter(row => row.step === "inbox.drafted" && row.lint_clean === true).map(row => row.proposal_id), [fitting.id]);
  assert.deepEqual(draftsDueOnDaemon(proposals, drafts, attempts).map(item => item.id), ["P1", "P2", "P3"]);
  assert.throws(() => readFileSync(openWeightAllowancePath(run.config)), { code: "ENOENT" });
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

test("W1-T13863 criterion 5: cash, relint and rescue rows count the full prompt sent to the adapter", async t => {
  const run = await productionBatch(t, { cap: 1000, deployments: ["gpt-5-nano", "gpt-oss-120b"], allowClaude: true,
    cashResult: worker({ text: dirty }) });
  const rescue = await productionBatch(t, { cap: 1000, deployments: ["gpt-oss-120b"], only: ["gpt-oss-120b"],
    allowClaude: true, cashResult: worker({ text: "missing the fragment markers" }) });
  const full = await productionBatch(t, { cap: 1000, deployments: ["gpt-5-nano", "gpt-oss-120b"], allowClaude: true,
    cashResult: worker({ text: dirty }), retryFullIndex: true });
  for (const batch of [run, rescue, full]) {
    const prompts = [...batch.cashPrompts, ...batch.subscriptionPrompts];
    assert.ok(prompts.length > 1, JSON.stringify(batch.rows));
    const synthesized = batch.rows.filter(row => row.step === "inbox.draft_synthesized");
    assert.deepEqual(synthesized.map(row => row.prompt_chars), prompts.map(prompt => prompt.length));
    assert.deepEqual(batch.fitInputs.map(input => input.promptChars), batch.cashPrompts.map(prompt => prompt.length));
    const planIndex = planProjectionForDependsOn(inboxDraftExampleFragmentYaml().replace("NEW-1", "W1-T1"));
    assert.ok(planIndex.length > 0);
    // The relint redraft cites no plan row here, so its index is empty; the first draft and the rescue carry it whole.
    for (const [i, row] of synthesized.entries()) {
      const cited = row.retry_index === "cited";
      assert.equal(prompts[i]!.includes(planIndex), !cited);
      assert.equal(row.plan_index_chars, cited ? 0 : planIndex.length);
    }
  }
  const retryIndex = (batch: typeof run) => batch.rows.filter(row => row.step === "inbox.draft_synthesized").map(row => row.retry_index);
  assert.deepEqual(retryIndex(run), [undefined, "cited"]);
  assert.deepEqual(retryIndex(rescue), [undefined, "full"]);
  assert.deepEqual(retryIndex(full), [undefined, "full"], "state/DRAFT_RETRY_FULL_INDEX reaches the rung through draftProposalBatch");
  assert.deepEqual(run.transports, ["gpt-5-nano", "gpt-oss-120b"]);
  assert.match(run.cashPrompts[1], /FAILED the plan's own linter/);
  assert.deepEqual(rescue.transports, ["gpt-oss-120b", "claude"]);
});

test("a paid six-request fallback stays in its own production draft lane's median", async t => {
  const seedProposal = { ...proposal, summary: "x".repeat(300_000) };
  const seed = await productionBatch(t, { cap: 1000, proposal: seedProposal, deployments: ["gpt-6-luna"],
    only: ["gpt-6-luna", "gpt-oss-120b"],
    cashResult: worker({ text: "missing the fragment markers", costUsd: 0.001,
      requestEfforts: [{ ...cashRequestEffort("{}", "chat-completions"), requests: 6 }] }) });
  assert.deepEqual(seed.transports, ["gpt-6-luna"]);
  assert.equal(seed.outcomes[0].ok, false);
  assert.equal(skipRow(seed.rows).deployment, "gpt-oss-120b");
  assert.equal(skipRow(seed.rows).expected_requests, 6);
  const overhead = Buffer.byteLength(seed.cashPrompts[0]) - seedProposal.summary.length;

  for (let i = 0; i < 4; i++) {
    const other = await productionBatch(t, { cap: 1000, root: seed.config.root, deployments: ["gpt-oss-120b"],
      only: ["gpt-oss-120b"], effort: "medium",
      cashResult: worker({ requestEfforts: [{ ...cashRequestEffort("{}", "chat-completions"), requests: 1 }] }) });
    assert.equal(other.outcomes[0].ok, true);
    assert.deepEqual(other.transports, ["gpt-oss-120b"]);
  }

  await t.test("W1-T13863 criterion 1: six lane-local requests put oss above its window", async t => {
    const next = await productionBatch(t, { cap: 1000, only: ["gpt-oss-120b"], deployments: [],
      proposal: { ...proposal, summary: "x".repeat(146_864 - overhead) } });
    assert.deepEqual(next.transports, []);
    assert.equal(next.outcomes[0].ok, false);
    const skipped = skipRow(next.rows);
    assert.equal(skipped.reason, "window");
    assert.equal(next.fitInputs[0].promptBytes, 146_864);
    assert.equal(skipped.prompt_chars, next.fitInputs[0].promptChars);
    assert.equal(skipped.expected_requests, 6);
    assert.equal(skipped.estimated_tokens, 228_296);
    assert.equal(skipped.window_tokens, 131_072);
  });

  await t.test("W1-T13863 criterion 2: six lane-local requests put oss above the remaining allowance", async t => {
    const next = await productionBatch(t, { cap: 1, leaveUsd: 0.03, only: ["gpt-oss-120b"], deployments: [],
      proposal: { ...proposal, summary: "x".repeat(56_861 - overhead) } });
    assert.deepEqual(next.transports, []);
    assert.equal(next.outcomes[0].ok, false);
    const skipped = skipRow(next.rows);
    assert.equal(skipped.reason, "allowance");
    assert.equal(next.fitInputs[0].promptBytes, 56_861);
    assert.equal(skipped.expected_requests, 6);
    assert.ok(Math.abs(Number(skipped.estimated_usd) - 0.0799749) < 1e-12);
    assert.ok(Math.abs(Number(skipped.left_usd) - 0.03) < 1e-12);
    assert.equal(readOpenWeightAllowance(next.config, { deployments: ["gpt-oss-120b"], atIso: AT }).attemptsToday, 1);
  });
});

test("cash history defaults to two, rounds up the median and excludes subscription requests", async () => {
  const expected: number[] = [];
  async function observe(requests: number, provider: "cash" | "codex") {
    await runDraftRung([proposal], PLAN, {
      lane: { leadDeployment: "gpt-oss-120b", effort: "low" },
      cashFit: input => { expected.push(input.expectedRequests); return { fits: true }; },
      spawn: async (_proposal, prompt, ctx) => {
        if (provider === "cash") ctx?.cashFit?.({ deployment: "gpt-oss-120b", promptChars: prompt.length, atIso: AT });
        return worker({ provider, requestEfforts: [{ ...cashRequestEffort("{}", "chat-completions"), requests }] });
      },
      log: () => {},
    }, "history");
  }
  await observe(4, "cash");
  await observe(11, "codex");
  await observe(1, "cash");
  await observe(6, "cash");
  assert.deepEqual(expected, [2, 4, 3]);
});
