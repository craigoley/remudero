import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxDraftExampleFragmentYaml, MAX_DRAFT_LINT_ATTEMPTS, runDraftRung, type Proposal } from "#src/lib/inbox.js";
import type { WorkerResult } from "#src/lib/worker.js";

const proposal: Proposal = { id: "P9", summary: "lineage fixture", evidenceAnchors: [] };
const cashId = "a4b260ad-174b-4ef8-afb7-5fcb3d1de761";
const subscriptionId = "7ec95e89-66e5-4bc3-a6bc-cf35f38478cd";
const clean = `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: lineage fixture`;
const dirty = "=== FRAGMENT START ===\n- id: NEW-1\n  title: x\n  acceptance: not a list\n=== FRAGMENT END ===\nSTAMP: lineage fixture";

function worker(provider: "cash" | "claude", text: string, extra: Partial<WorkerResult> = {}): WorkerResult {
  const model = provider === "cash" ? "gpt-6-luna" : "sonnet";
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], provider, model, routedModel: model,
    selectionAssignmentId: provider === "cash" ? cashId : subscriptionId, effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false, ...extra };
}

async function replay(cash: WorkerResult, escalation?: () => WorkerResult | undefined) {
  const events: Array<{ step: string } & Record<string, unknown>> = [];
  let cashCalls = 0, subscriptionCalls = 0;
  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
    spawn: async () => { cashCalls++; return cash; },
    ...(escalation ? { escalate: async () => { subscriptionCalls++; return escalation(); } } : {}),
    log: (step, extra) => events.push({ step, ...extra }),
  }, "fixture-lineage");
  return { outcome, events, cashCalls, subscriptionCalls, error: events.find(row => row.step === "inbox.draft_error") };
}

test("draft errors describe the final subscription worker rather than the earlier cash result", async t => {
  for (const [text, fragments, stamps, reason] of [
    ["STAMP: latest subscription stamp", 0, 1, /STAMP but no FRAGMENT/],
    ["=== FRAGMENT START ===\n- id: NEW-1\n=== FRAGMENT END ===", 1, 0, /FRAGMENT but no STAMP/],
  ] as const) {
    await t.test(String(reason), async () => {
      const result = await replay(worker("cash", "earlier cash prose"), () => worker("claude", text));
      assert.equal(result.outcome?.ok, false);
      assert.equal(result.cashCalls, 1);
      assert.equal(result.subscriptionCalls, 1);
      assert.equal(result.error?.fragments, fragments);
      assert.equal(result.error?.stamps, stamps);
      assert.equal(result.error?.output_chars, text.length);
      assert.match(String(result.error?.error), reason);
      assert.equal(result.error?.provider, "claude");
      assert.equal(result.error?.selection_assignment_id, subscriptionId);
    });
  }
});

test("an empty draft result remains no output rather than a synthetic newline", async t => {
  for (const blocks of [[], [""]]) {
    await t.test(JSON.stringify(blocks), async () => {
      const result = await replay(worker("cash", "", { blocks }));
      assert.equal(result.outcome?.ok, false);
      assert.equal(result.subscriptionCalls, 0);
      assert.equal(result.error?.output_chars, 0);
      assert.match(String(result.error?.error), /no output at all/);
    });
  }
});

test("a refused subscription escalation retains its own account refusal and safe assignment", async () => {
  const result = await replay(worker("cash", "earlier cash prose"), () => worker("claude", "", {
    isError: true, usageRefusal: { matched: "fixture subscription limit" },
  }));
  assert.equal(result.outcome?.ok, false);
  if (result.outcome?.ok === false) assert.equal(result.outcome.refused?.matched, "fixture subscription limit");
  assert.equal(result.subscriptionCalls, 1);
  assert.equal(result.error?.usage_refused, true);
  assert.equal(result.error?.provider, "claude");
  assert.equal(result.error?.selection_assignment_id, subscriptionId);
});

test("draft error evidence retains identity and counts but never either worker payload", async () => {
  const cashSecret = "PRIVATE_CASH_PAYLOAD", subscriptionSecret = "PRIVATE_SUBSCRIPTION_PAYLOAD";
  const text = `STAMP: ${subscriptionSecret}`;
  const result = await replay(worker("cash", cashSecret), () => worker("claude", text));
  assert.equal(result.error?.output_chars, text.length);
  assert.equal(result.error?.stamps, 1);
  const serialized = JSON.stringify(result.events);
  assert.equal(serialized.includes(cashSecret), false);
  assert.equal(serialized.includes(subscriptionSecret), false);
});

test("failure lineage keeps the clean cash no-escalation control unchanged", async () => {
  const result = await replay(worker("cash", clean), () => { throw Error("must not call"); });
  assert.equal(result.outcome?.ok, true);
  assert.equal(result.cashCalls, 1);
  assert.equal(result.subscriptionCalls, 0);
  assert.equal(result.events.find(row => row.step === "inbox.drafted")?.lint_clean, true);
});

test("failure lineage preserves a dirty cash draft when subscription transport throws", async () => {
  const result = await replay(worker("cash", dirty), () => { throw Error("fixture transport unavailable"); });
  assert.equal(result.outcome?.ok, true);
  assert.equal(result.cashCalls, MAX_DRAFT_LINT_ATTEMPTS);
  assert.equal(result.subscriptionCalls, 1);
  assert.equal(result.events.find(row => row.step === "inbox.drafted")?.lint_clean, false);
  assert.equal(result.events.filter(row => row.step === "inbox.draft_escalation_error").length, 1);
});
