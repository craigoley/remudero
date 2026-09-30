import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxDraftExampleFragmentYaml, MAX_DRAFT_LINT_ATTEMPTS, runDraftRung, type Proposal } from "../src/lib/inbox.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { spawnEscalatedInboxDraft } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const proposal: Proposal = { id: "P9", summary: "a proposal", evidenceAnchors: [] };
const stamp = "- P9 (a proposal) — RATIFIED 2026-01-01 -> NEW-1.";
const clean = `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: ${stamp}`;
const dirty = `=== FRAGMENT START ===\n- id: NEW-1\n  title: x\n  acceptance: not a list\n=== FRAGMENT END ===\nSTAMP: ${stamp}`;

function worker(model: string, text: string): WorkerResult {
  return {
    sessionId: `S-${model}`, costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model, routedModel: model, effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

test("W1-T4916: a proposal the cash ladder leaves dirty gets one Sonnet attempt", async () => {
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const escalationPrompts: string[] = [];
  let cashCalls = 0;
  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
    spawn: async () => { cashCalls++; return worker("gpt-oss-120b", dirty); },
    escalate: async (_proposal, prompt) => { escalationPrompts.push(prompt); return worker("claude-sonnet-5-5", clean); },
    log: (step, extra) => events.push({ step, extra }),
  }, "run-1");
  assert.equal(cashCalls, MAX_DRAFT_LINT_ATTEMPTS);
  assert.equal(escalationPrompts.length, 1);
  assert.match(escalationPrompts[0], /acceptance: not a list/);
  assert.match(escalationPrompts[0], /blocking violation|must be|acceptance/i);
  assert.equal(outcome.ok, true);
  assert.equal(events.find((event) => event.step === "inbox.drafted")?.extra?.lint_clean, true);
  assert.deepEqual(events.filter((event) => event.step === "inbox.draft_escalated").map((event) => event.extra), [
    { proposal_id: "P9", from: "gpt-oss-120b", to: "claude-sonnet-5-5", reason: "dirty-lint" },
  ]);
});

test("W1-T4916: a clean cash draft never escalates", async () => {
  let escalations = 0;
  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
    spawn: async () => worker("gpt-oss-120b", clean),
    escalate: async () => { escalations++; return worker("claude-sonnet-5-5", clean); },
    log: () => {},
  }, "run-2");
  assert.equal(outcome.ok, true);
  assert.equal(escalations, 0);
});

test("W1-T4916: escalation is skipped when subscription headroom is below reserve", async () => {
  let sonnetCalls = 0;
  const config = { root: "/tmp/w1-t4916-no-policy", workerProviders: { enabled: ["claude", "cash"], reservePercent: 5 } } as Config;
  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
    spawn: async () => worker("gpt-oss-120b", dirty),
    escalate: async (_proposal, prompt) => spawnEscalatedInboxDraft({
      cwd: "/tmp", settingsFile: "/tmp/worker.json", prompt, mount: { model: "haiku", provider: "cash", effort: "high", maxTurns: 1, contextBudget: 1000 },
      config, disallowedTools: [],
    }, async () => { sonnetCalls++; return worker("claude-sonnet-5-5", clean); }, async () => ({
      provider: "claude", readable: true, windows: [{ name: "weekly", usedPercent: 96 }],
    })),
    log: () => {},
  }, "run-3");
  assert.equal(sonnetCalls, 0);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.candidate.fragmentYaml.includes("acceptance: not a list"), true);
});

test("a fragment-contract failure gets one Sonnet attempt with the original markers", async () => {
  const prompts: string[] = [];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
    spawn: async () => worker("gpt-oss-120b", "a prose answer without fragment markers"),
    escalate: async (_proposal, prompt) => { prompts.push(prompt); return worker("claude-sonnet-5-5", clean); },
    log: (step, extra) => events.push({ step, extra }),
  }, "run-4");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /FRAGMENT START/);
  assert.equal(outcome.ok, true);
  assert.equal(events.find((event) => event.step === "inbox.draft_escalated")?.extra?.reason, "fragment-contract");
});

test("an escalation transport error leaves the dirty cash fragment available", async () => {
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
    spawn: async () => worker("gpt-oss-120b", dirty),
    escalate: async () => { throw new Error("sonnet transport unavailable"); },
    log: (step, extra) => events.push({ step, extra }),
  }, "run-5");
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.candidate.fragmentYaml.includes("acceptance: not a list"), true);
  assert.equal(events.find((event) => event.step === "inbox.draft_escalation_error")?.extra?.error, "sonnet transport unavailable");
});

test("admitted escalation pins the subscription Sonnet mount at medium effort", async () => {
  const config = { root: "/tmp/w1-t4916-no-policy", workerProviders: { enabled: ["claude", "cash"], reservePercent: 5 } } as Config;
  let called = 0;
  const result = await spawnEscalatedInboxDraft({
    cwd: "/tmp", settingsFile: "/tmp/worker.json", prompt: "fix this fragment", config,
    mount: { model: "haiku", provider: "cash", effort: "high", maxTurns: 1, contextBudget: 1000 }, disallowedTools: [],
  }, async (args) => {
    called++;
    assert.equal(args.model, "sonnet");
    assert.equal(args.mountProvider, "claude");
    assert.equal(args.effort, "medium");
    return worker("claude-sonnet-5-5", clean);
  }, async () => ({ provider: "claude", readable: true, windows: [{ name: "weekly", usedPercent: 50 }] }));
  assert.equal(called, 1);
  assert.equal(result?.model, "claude-sonnet-5-5");
});
