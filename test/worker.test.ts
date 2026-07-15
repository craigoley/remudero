import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerSettingsError } from "../src/lib/settings.js";
import {
  BILLING_MODE,
  DEFAULT_EFFORT_LABEL,
  DEFAULT_MODEL_LABEL,
  DENY_FLOOR_FALLBACK_MODE,
  appendQuestion,
  collectWorkerResult,
  evaluateDenyFloor,
  parseDecisionRequest,
  parseQuestion,
  spawnWorker,
  workerLedgerFields,
} from "../src/lib/worker.js";

// ── Synthetic SDK message streams ──────────────────────────────────────────
// The real SDK yields a `type:"result"` envelope (even for an error subtype)
// and, on an error, THEN throws from the iterator. These generators reproduce
// exactly that shape so the ledger-on-error guarantee is tested without a spawn.

/** A clean success stream: an assistant text block, then a success result. */
async function* successStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/1",
    session_id: "sess-ok",
    total_cost_usd: 0.42,
    num_turns: 12,
    permission_denials: [],
  };
}

/**
 * The WS-1 failure shape: the SDK yields the error result envelope (WITH
 * num_turns + total_cost_usd) and THEN throws from the iterator.
 */
function errorResultStream(subtype: string, costUsd: number, numTurns: number) {
  return (async function* (): AsyncGenerator<unknown> {
    yield { type: "assistant", message: { content: [{ type: "text", text: "working…" }] } };
    yield {
      type: "result",
      subtype,
      is_error: true,
      session_id: "sess-err",
      total_cost_usd: costUsd,
      num_turns: numTurns,
      permission_denials: [],
    };
    throw new Error(`Claude Code returned an error result: ${subtype}`);
  })();
}

/** A genuine transport failure: the iterator throws with NO result envelope. */
async function* transportFailureStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "spawning…" }] } };
  throw new Error("spawn ENOENT: bad claude binary");
}

/**
 * A success stream carrying the REAL envelope's `usage` (NonNullableUsage,
 * snake_case) and `modelUsage` (camelCase per-model map) — SDK 0.3.209 ground
 * truth (sdk.d.ts SDKResultSuccess/SDKResultError both carry these).
 */
async function* usageStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/2",
    session_id: "sess-usage",
    total_cost_usd: 1.23,
    num_turns: 7,
    permission_denials: [],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 50,
    },
    modelUsage: {
      "claude-opus-4": {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 50,
        costUSD: 1.23,
        contextWindow: 200000,
      },
    },
  };
}

/**
 * The Anthropic-side TRANSIENT (run W1-T12a-1784117152056): a synthetic api-error
 * message (isApiErrorMessage + model "<synthetic>" + "API Error: Server error
 * mid-response") arrives mid-stream, yet the result envelope still reports SUCCESS
 * (the WS-0 envelope shape). collectWorkerResult must flag this as apiError.
 */
async function* apiErrorMidResponseStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "reading git remote…" }] } };
  yield {
    type: "assistant",
    isApiErrorMessage: true,
    error: "server_error",
    message: {
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: Server error mid-response. The response above may be incomplete." }],
    },
  };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    session_id: "sess-api",
    total_cost_usd: 0.5,
    num_turns: 10,
    permission_denials: [],
  };
}

test("collectWorkerResult: an Anthropic-side server_error mid-response is flagged apiError, even though the envelope reports success", async () => {
  const r = await collectWorkerResult(apiErrorMidResponseStream(), { childEnvKeys: ["PATH"] });
  assert.equal(r.apiError, true, "the <synthetic>/isApiErrorMessage message must set apiError");
  assert.equal(r.subtype, "success", "the result envelope still reports success (WS-0 shape) — that's why classification, not subtype, decides");
});

test("collectWorkerResult: a clean success is NOT flagged apiError", async () => {
  const r = await collectWorkerResult(successStream(), { childEnvKeys: ["PATH"] });
  assert.equal(r.apiError, false);
});

test("collectWorkerResult: success stream captures cost, turns, and text", async () => {
  const r = await collectWorkerResult(successStream(), { childEnvKeys: ["PATH"] });
  assert.equal(r.isError, false);
  assert.equal(r.subtype, "success");
  assert.equal(r.costUsd, 0.42);
  assert.equal(r.numTurns, 12);
  assert.match(r.text, /pull\/1/);
  assert.deepEqual(r.blocks, ["hello"]);
});

test("collectWorkerResult: a max-turns error does NOT throw — it returns the envelope with cost + turns", async () => {
  // This is the honest-ledger guarantee: a failed run must never be free.
  const r = await collectWorkerResult(errorResultStream("error_max_turns", 1.73, 60), {
    childEnvKeys: [],
  });
  assert.equal(r.isError, true);
  assert.equal(r.subtype, "error_max_turns");
  assert.equal(r.costUsd, 1.73, "cost_usd must survive the error-result throw");
  assert.equal(r.numTurns, 60, "num_turns must survive the error-result throw");
});

test("collectWorkerResult: a budget breach returns subtype error_max_budget_usd with its cost", async () => {
  const r = await collectWorkerResult(errorResultStream("error_max_budget_usd", 0.011, 3), {
    childEnvKeys: [],
  });
  assert.equal(r.isError, true);
  assert.equal(r.subtype, "error_max_budget_usd");
  assert.equal(r.costUsd, 0.011);
  assert.equal(r.numTurns, 3);
});

test("collectWorkerResult: a throw with NO result envelope is RE-RAISED (real transport failure)", async () => {
  await assert.rejects(
    () => collectWorkerResult(transportFailureStream(), { childEnvKeys: [] }),
    /spawn ENOENT/,
    "a genuine spawn failure must not be silently swallowed",
  );
});

// ── W1-T6: NDJSON ledger + context telemetry + brain-plane calls ───────────
// Every worker + brain call must ledger {model, effort, tokens, total_cost_usd,
// billing_mode, verdict}. `model`/`effort` are CONFIGURED INPUTS (never a
// read-back — effort is not even in the SDK envelope); `tokens` is read off
// the envelope's `usage` (snake_case NonNullableUsage); `total_cost_usd`/
// `billing_mode`/`verdict` are derived per workerLedgerFields.

test("collectWorkerResult: captures aggregate tokens off `usage` and the per-model breakdown off `modelUsage`", async () => {
  const r = await collectWorkerResult(usageStream(), { childEnvKeys: [] });
  assert.deepEqual(r.tokens, { input: 1000, output: 200, cacheRead: 500, cacheCreation: 50 });
  assert.deepEqual(r.modelUsage, {
    "claude-opus-4": {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 50,
      costUSD: 1.23,
      contextWindow: 200000,
    },
  });
});

test("collectWorkerResult: model/effort are the CONFIGURED inputs passed in opts, not read off the envelope", async () => {
  const r = await collectWorkerResult(usageStream(), {
    childEnvKeys: [],
    model: "claude-opus-4",
    effort: "high",
  });
  assert.equal(r.model, "claude-opus-4");
  assert.equal(r.effort, "high");
});

test("collectWorkerResult: model/effort default to the honest 'default' label when the caller configured no override", async () => {
  const r = await collectWorkerResult(successStream(), { childEnvKeys: [] });
  assert.equal(r.model, DEFAULT_MODEL_LABEL);
  assert.equal(r.effort, DEFAULT_EFFORT_LABEL);
});

test("collectWorkerResult: tokens zero out (never crash) when a synthetic/older stream omits `usage`/`modelUsage`", async () => {
  const r = await collectWorkerResult(successStream(), { childEnvKeys: [] });
  assert.deepEqual(r.tokens, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  assert.deepEqual(r.modelUsage, {});
});

test("workerLedgerFields: success call ⇒ {model, effort, tokens, total_cost_usd, billing_mode, verdict} with billing_mode='subscription' and verdict='success'", async () => {
  const r = await collectWorkerResult(usageStream(), {
    childEnvKeys: [],
    model: "claude-opus-4",
    effort: "high",
  });
  const fields = workerLedgerFields(r);
  assert.deepEqual(fields, {
    model: "claude-opus-4",
    effort: "high",
    tokens: { input: 1000, output: 200, cacheRead: 500, cacheCreation: 50 },
    total_cost_usd: 1.23,
    billing_mode: "subscription",
    verdict: "success",
  });
  assert.equal(BILLING_MODE, "subscription");
});

test("workerLedgerFields: an ERROR call's verdict is the SDK's error subtype, not the string 'success'", async () => {
  const r = await collectWorkerResult(errorResultStream("error_max_turns", 1.73, 60), {
    childEnvKeys: [],
    model: "claude-sonnet-4",
    effort: "medium",
  });
  const fields = workerLedgerFields(r);
  assert.equal(fields.verdict, "error_max_turns");
  assert.equal(fields.billing_mode, "subscription");
  assert.equal(fields.total_cost_usd, 1.73);
  assert.equal(fields.model, "claude-sonnet-4");
  assert.equal(fields.effort, "medium");
});

test("spawnWorker: an invalid settings file is REJECTED at the spawn boundary before any worker launches", async () => {
  // FF10a: the guard must fire structurally, not by caller convention. A settings
  // file with `allowedDomains` misplaced at the sandbox root (the exact WS-0
  // silent-drop hazard) must throw BEFORE the SDK is ever invoked.
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-guard-"));
  const badSettings = join(dir, "worker.json");
  writeFileSync(
    badSettings,
    JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowedDomains: ["example.com"] } }),
  );
  await assert.rejects(
    () =>
      spawnWorker({
        cwd: dir,
        permissionMode: "bypassPermissions",
        settingsFile: badSettings,
        prompt: "unreachable — the guard throws first",
      }),
    WorkerSettingsError,
    "a misplaced sandbox key must be rejected before spawn, never silently dropped",
  );
});

// ── evaluateDenyFloor: the dontAsk fallback state machine (spike verdict 4) ──
// MASTER-PLAN §10.i golden task: the `dontAsk` fallback is implemented in
// spike.ts but was NOT exercised (the deterministic floor held under bypass, so
// the fallback branch never ran on 2.1.209). These cases drive the extracted
// state machine directly — no worker spawn — so the fallback path is covered
// including that it is `dontAsk` (not any other mode) the probe falls back to.

test("evaluateDenyFloor: floor holds under bypass ⇒ NO dontAsk fallback, contained", () => {
  // The observed WS-0 outcome: FORBIDDEN_PROBE never landed under bypass.
  const verdict = evaluateDenyFloor({ forbiddenPresentUnderBypass: false });
  assert.deepEqual(verdict, {
    heldUnderBypass: true,
    usedDontAskFallback: false,
    contained: true,
  });
});

test("evaluateDenyFloor: floor leaks under bypass ⇒ dontAsk fallback runs and contains (claude-code#20946 shape)", () => {
  // The counter-report shape: the block leaked under bypass, so the probe re-runs
  // under dontAsk and the forbidden write is blocked there.
  const verdict = evaluateDenyFloor({
    forbiddenPresentUnderBypass: true,
    forbiddenPresentUnderDontAsk: false,
  });
  assert.equal(verdict.usedDontAskFallback, true, "the fallback path must be taken");
  assert.equal(verdict.heldUnderBypass, false, "a leak under bypass is never reported as held");
  assert.equal(verdict.contained, true, "dontAsk blocked the forbidden write");
});

test("evaluateDenyFloor: floor leaks under BOTH bypass and dontAsk ⇒ fallback taken but NOT contained", () => {
  const verdict = evaluateDenyFloor({
    forbiddenPresentUnderBypass: true,
    forbiddenPresentUnderDontAsk: true,
  });
  assert.equal(verdict.usedDontAskFallback, true);
  assert.equal(verdict.heldUnderBypass, false);
  assert.equal(verdict.contained, false, "the floor leaked under dontAsk too — not contained");
});

test("evaluateDenyFloor: a leak with NO dontAsk observation is conservatively NOT contained", () => {
  // Guards the honest-verdict invariant: an unverified floor never reports holding.
  const verdict = evaluateDenyFloor({ forbiddenPresentUnderBypass: true });
  assert.equal(verdict.usedDontAskFallback, true);
  assert.equal(verdict.contained, false, "an unrun fallback must not be reported as contained");
});

test("DENY_FLOOR_FALLBACK_MODE is the dontAsk permission mode", () => {
  // Pins the fallback mode itself: a regression to any other mode is a defect.
  assert.equal(DENY_FLOOR_FALLBACK_MODE, "dontAsk");
});

// ── parseDecisionRequest golden fixtures — DECORATION IS NOT DATA ────────────
// The auto-choose control plane (MASTER-PLAN §4) resolves a DECISION_REQUEST to
// its RECOMMENDED option and records the value in DECISIONS.md. A label's chrome
// (an inline `(RECOMMENDED)` marker, markdown emphasis, backticks, emoji) must
// never bleed into that value. These two goldens pin the exact malformed payloads
// that once did bleed.

test("parseDecisionRequest: the WS-0 near-miss — inline (RECOMMENDED) marker does NOT bleed its `)` into options or the choice", () => {
  // The exact WS-0 spike payload WITHOUT the explicit `RECOMMENDED:` line, so the
  // parser must fall back to the inline-marked option. The original parser
  // captured `)` from the `(RECOMMENDED)` marker (FINDINGS #5); it was right only
  // by accident (the `)` value happened to equal the default).
  const payload = [
    "DECISION_REQUEST",
    "- docs/spike.md",
    "- docs/spike-hello.md (RECOMMENDED)",
    "Reversibility: single new file, revert the PR to undo.",
  ].join("\n");

  const decision = parseDecisionRequest(payload);
  assert.ok(decision, "the payload announces DECISION_REQUEST so it must parse");
  // Option list carries the data, not the marker: NO stray `)` anywhere.
  assert.deepEqual(decision.options, ["docs/spike.md", "docs/spike-hello.md"]);
  for (const option of decision.options) {
    assert.ok(!option.includes(")"), `option "${option}" must not carry the marker's ')'`);
  }
  // The choice is the clean path, never the bled `)`.
  assert.equal(decision.recommended, "docs/spike-hello.md");
});

test("parseDecisionRequest: the T1D decorated string — bold, backticks, emoji, and trailing `****` are STRIPPED to the clean value", () => {
  // The exact T1D auto-choose near-miss: a fully decorated option label. Same
  // class as the WS-0 `)` bleed — decoration is not data.
  const payload = [
    "DECISION_REQUEST",
    "**Option A — `docs/review-gate.md` (new doc)** ✅ ****",
    "**Option B — inline the gate in CONTRIBUTING.md**",
    "RECOMMENDED: **Option A — `docs/review-gate.md` (new doc)** ✅ ****",
    "Reversibility: a single new doc; delete the file to undo.",
  ].join("\n");

  const decision = parseDecisionRequest(payload);
  assert.ok(decision, "the payload announces DECISION_REQUEST so it must parse");
  // The recommended value is the clean label: no `**`, no ✅, no trailing `****`,
  // no backticks.
  assert.equal(decision.recommended, "Option A — docs/review-gate.md (new doc)");
  assert.ok(!decision.recommended.includes("*"), "no markdown asterisks survive");
  assert.ok(!decision.recommended.includes("`"), "no backticks survive");
  assert.ok(!decision.recommended.includes("✅"), "no emoji survives");
  // Both options are decoration-stripped too.
  assert.deepEqual(decision.options, [
    "Option A — docs/review-gate.md (new doc)",
    "Option B — inline the gate in CONTRIBUTING.md",
  ]);
});

// ── QUESTION contract goldens (MASTER-PLAN §2) — non-blocking side-channel ────
// A QUESTION is the assume-log-keep-moving channel: the worker states what it
// asked, the assumption it PROCEEDED on, and the blast radius if that assumption
// is wrong (low|med). The parser must capture all three; the store append must be
// durable (creates plan/ on a fresh checkout) and must NEVER stall the loop.

test("parseQuestion: the full structured contract — question + current_assumption + impact_if_wrong are all captured", () => {
  const payload = [
    "REPORT",
    "QUESTION: Should the ledger be sharded per-day or per-run?",
    "CURRENT_ASSUMPTION: per-day, matching the digest cadence.",
    "IMPACT_IF_WRONG: med",
    "Proceeding on the assumption; not blocking.",
  ].join("\n");

  const q = parseQuestion(payload);
  assert.ok(q, "the payload announces QUESTION so it must parse");
  assert.equal(q.question, "Should the ledger be sharded per-day or per-run?");
  assert.equal(q.currentAssumption, "per-day, matching the digest cadence.");
  assert.equal(q.impactIfWrong, "med");
});

test("parseQuestion: impact_if_wrong normalises `low`/`medium` variants and a bare QUESTION leaves the optional fields undefined", () => {
  const medium = parseQuestion("QUESTION: X?\nimpact_if_wrong: Medium");
  assert.equal(medium?.impactIfWrong, "med");

  const bare = parseQuestion("QUESTION: Is the cap a tripwire?");
  assert.ok(bare);
  assert.equal(bare.question, "Is the cap a tripwire?");
  assert.equal(bare.currentAssumption, undefined);
  assert.equal(bare.impactIfWrong, undefined);
});

test("parseQuestion: text with no QUESTION line returns null (the guard does not fire on prose)", () => {
  assert.equal(parseQuestion("REPORT\nchanged: src/foo.ts\nPR_URL: https://x/pull/1"), null);
});

test("appendQuestion: appends one NDJSON line durably, creating plan/ on a fresh checkout", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "remudero-q-"));
  // plan/ does not exist yet — the append must create it (durable on fresh checkout).
  const ok1 = appendQuestion(repoRoot, {
    ts: "2026-07-14T00:00:00.000Z",
    task: "W1-T3C",
    question: "First?",
    current_assumption: "assume A",
    impact_if_wrong: "low",
  });
  const ok2 = appendQuestion(repoRoot, {
    ts: "2026-07-14T00:01:00.000Z",
    task: "W1-T3C",
    question: "Second?",
  });
  assert.equal(ok1, true);
  assert.equal(ok2, true);

  const lines = readFileSync(join(repoRoot, "plan", "questions.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.equal(lines.length, 2, "one JSON object per line, append-only");
  const first = JSON.parse(lines[0]);
  assert.equal(first.question, "First?");
  assert.equal(first.current_assumption, "assume A");
  assert.equal(first.impact_if_wrong, "low");
  // Absent optional fields are simply omitted (JSON.stringify drops undefined).
  const second = JSON.parse(lines[1]);
  assert.equal(second.question, "Second?");
  assert.ok(!("current_assumption" in second));
});

test("appendQuestion: NON-BLOCKING — an unwritable store returns false, never throws, so the loop keeps moving", () => {
  // repoRoot is a path UNDER an existing file, so mkdir(plan/) fails with ENOTDIR.
  const file = join(mkdtempSync(join(tmpdir(), "remudero-q-")), "not-a-dir");
  writeFileSync(file, "x");
  const repoRoot = join(file, "nested");

  let threw = false;
  let result: boolean | undefined;
  try {
    result = appendQuestion(repoRoot, { ts: "t", task: "W1-T3C", question: "Q?" });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "a failed side-channel write must NEVER throw (§2 non-blocking)");
  assert.equal(result, false, "the failure is reported as false, not swallowed silently");
});
