import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { captureInboxDraftSnapshot, commitInboxDraftOutcomes, draftsDueOnDaemon, inboxDraftExampleFragmentYaml,
  MAX_DRAFT_LINT_ATTEMPTS, planProjectionForDependsOn, resolvedInboxDraftLane, runDraftRung,
  type DraftWorkerResult, type Proposal } from "#src/lib/inbox.js";
import type { Config } from "#src/lib/config.js";
import { cashDraftFit, openWeightAllowancePath, readOpenWeightAllowance } from "#src/lib/worker-provider.js";
import { draftProposalBatch } from "#test/helpers/run-task-test.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = { step: string } & Record<string, unknown>;
const proposal: Proposal = { id: "P13863", summary: "a cash draft that cannot finish", evidenceAnchors: [] };
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

function cashConfig(t: TestContext, dailyCapUsd: number): Config {
  return { root: ownedFixtureDir(t, "cash-fit-root").dir, dailyCapUsd,
    workerProviders: { enabled: ["cash"], reservePercent: 5 } } as Config;
}

/** The production batch over a real one-commit checkout; only the external provider is replaced. */
async function productionBatch(t: TestContext, dailyCapUsd: number) {
  const root = ownedFixtureDir(t, "cash-fit-batch").dir;
  const target = gitRepo({ scope: t, kind: "cash-fit-repo" });
  mkdirSync(join(target.dir, "plan"));
  writeFileSync(join(target.dir, "plan", "tasks.yaml"), inboxDraftExampleFragmentYaml().replace("NEW-1", "W1-T1"));
  writeFileSync(join(target.dir, "README.md"), "cash fit\n");
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
  const config = { root, installRoot: REPO_ROOT, dailyCapUsd,
    workerProviders: { enabled: ["cash"], reservePercent: 5 } } as Config;
  const rows: Row[] = [];
  let spawns = 0;
  const outcomes = await draftProposalBatch([proposal], config, "acme", "remudero", `cash-fit-${dailyCapUsd}`,
    (step, extra) => { rows.push({ step, ...extra }); }, async () => { spawns++; return worker({ text: dirty }); });
  return { config, rows, spawns, outcomes, root };
}

test("W1-T13863 criterion 1: a cash draft whose whole run is larger than the window is not spawned", async t => {
  const config = cashConfig(t, 1000);
  const big: Proposal = { ...proposal, summary: "x".repeat(300_000) };
  const rows: Row[] = [];
  let spawns = 0;
  const [outcome] = await runDraftRung([big], PLAN, {
    spawn: async () => { spawns++; return worker(); },
    cashFit: (prompt, fit) => cashDraftFit(config, { deployments: ["gpt-oss-120b"], promptChars: prompt.length,
      expectedRequests: fit.expectedRequests, atIso: AT }),
    log: (step, extra) => rows.push({ step, ...extra }),
  }, "window");
  assert.equal(spawns, 0);
  assert.equal(outcome.ok, false);
  const skipped = rows.find(row => row.step === "inbox.draft_cash_skipped");
  assert.ok(skipped, JSON.stringify(rows));
  assert.equal(skipped.reason, "window");
  assert.equal(skipped.deployment, "gpt-oss-120b");
  assert.equal(skipped.window_tokens, 131_072);
  assert.ok(Number(skipped.estimated_tokens) > 131_072);
  // Control: the same prompt holds one request, so only the whole-run estimate refuses it.
  assert.ok(Number(skipped.prompt_chars) / 4 < 131_072);
});

test("W1-T13863 criterion 2: the production batch does not spawn a cash draft past today's allowance", async t => {
  const { rows, spawns, outcomes } = await productionBatch(t, 0.000001);
  assert.equal(spawns, 0, JSON.stringify(rows));
  assert.equal(outcomes[0].ok, false);
  const skipped = rows.find(row => row.step === "inbox.draft_cash_skipped");
  assert.ok(skipped, JSON.stringify(rows));
  assert.equal(skipped.reason, "allowance");
  assert.equal(typeof skipped.estimated_usd, "number");
  assert.equal(typeof skipped.left_usd, "number");
  assert.ok(Number(skipped.estimated_usd) > Number(skipped.left_usd));
  assert.equal(rows.some(row => row.step === "inbox.draft_synthesized"), false);
});

test("W1-T13863 criterion 3: a skipped draft writes no attempt key, stays due and spends $0", async t => {
  const { config, rows, spawns, outcomes } = await productionBatch(t, 0.000001);
  assert.equal(spawns, 0);
  const outcome = outcomes[0];
  assert.ok(!outcome.ok && outcome.refused, JSON.stringify(outcome));
  const stateDir = ownedFixtureDir(t, "cash-fit-state").dir;
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }));
  const scope = { repository: "acme/remudero" };
  const lane = resolvedInboxDraftLane(REPO_ROOT);
  commitInboxDraftOutcomes({ stateDir, scope, snapshots: [captureInboxDraftSnapshot(proposal, scope)], outcomes, lane,
    log: (step, extra) => rows.push({ step, ...extra }) });
  const attemptsPath = join(stateDir, "inbox-draft-attempts.json");
  const attempts = existsSync(attemptsPath) ? JSON.parse(readFileSync(attemptsPath, "utf8")) as Record<string, string> : {};
  assert.equal(Object.hasOwn(attempts, proposal.id), false);
  assert.deepEqual(draftsDueOnDaemon([proposal], {}, attempts, 3, undefined, lane).map(p => p.id), [proposal.id]);
  // $0: no reservation was written to today's allowance.
  assert.equal(existsSync(openWeightAllowancePath(config)), false);
  assert.equal(readOpenWeightAllowance(config, { deployments: ["gpt-oss-120b"], atIso: AT }).attemptsToday, 0);
});

test("W1-T13863 criterion 4: a draft that fits spawns as before, and a subscription draft is never checked", async t => {
  const prompts = async (withFit: boolean) => {
    const seen: string[] = [];
    let checks = 0;
    let escalations = 0;
    const [outcome] = await runDraftRung([proposal], PLAN, {
      spawn: async (_p, prompt) => { seen.push(prompt); return worker({ text: dirty }); },
      escalate: async () => { escalations++; return worker({ text: clean, provider: "claude" }); },
      ...(withFit ? { cashFit: () => { checks++; return { fits: true as const }; } } : {}),
      log: () => {},
    }, "fits");
    return { seen, checks, escalations, outcome };
  };
  const before = await prompts(false), after = await prompts(true);
  assert.deepEqual(after.seen, before.seen);
  assert.equal(after.outcome.ok, before.outcome.ok);
  assert.equal(after.escalations, 1);
  // One check per cash spawn; the subscription escalation is not checked against the cash allowance.
  assert.equal(after.checks, MAX_DRAFT_LINT_ATTEMPTS);
  const subscription = await runDraftRung([proposal], PLAN, { spawn: async () => worker({ provider: "claude" }), log: () => {} }, "sub");
  assert.equal(subscription[0].ok, true);
  // The production batch with room left spawns its cash draft.
  const { spawns } = await productionBatch(t, 1000);
  assert.ok(spawns > 0);
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

test("W1-T13863: a skip after a paid attempt keeps that attempt's fragment and is not a refusal", async () => {
  let checks = 0;
  const [outcome] = await runDraftRung([proposal], PLAN, {
    spawn: async () => worker({ text: dirty }),
    cashFit: () => ++checks === 1 ? { fits: true }
      : { fits: false, reason: "allowance", deployment: "gpt-oss-120b", estimatedTokens: 1, estimatedUsd: 2, leftUsd: 1 },
    log: () => {},
  }, "later");
  assert.equal(checks, 2);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.match(outcome.candidate.fragmentYaml, /acceptance: not a list/);
});
