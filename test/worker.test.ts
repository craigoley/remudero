import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerSettingsError } from "../src/lib/settings.js";
import { WorkerKeychainError } from "../src/lib/worker-home.js";
import { isPidAlive, RUN_ID_ENV, spawnDetachedGroup, TASK_ID_ENV } from "../src/lib/worker-containment.js";
import {
  BILLING_MODE,
  CLAUDE_BIN_ENV_OVERRIDE,
  CLAUDE_EXECUTABLE_LOCATIONS,
  ClaudeToolchainBlockedError,
  DEFAULT_EFFORT_LABEL,
  DEFAULT_MODEL_LABEL,
  DENY_FLOOR_FALLBACK_MODE,
  appendQuestion,
  appendQuestionAnswer,
  cacheTokenLedgerFields,
  collectWorkerResult,
  createClaudeExecutableCache,
  evaluateDenyFloor,
  parseDecisionRequest,
  parseFollowups,
  parseQuestion,
  parseReport,
  resolveClaudeExecutable,
  spawnWorker,
  workerKeychainGrantApps,
  workerLedgerFields,
  workerTranscript,
} from "../src/lib/worker.js";
import { runReview } from "../src/run-task.js";

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

/**
 * A RECORDED stream fixture carrying a `compact_boundary` system message
 * (MASTER-PLAN §8B / W1-T36 acceptance — sdk.d.ts 0.3.210 ground truth:
 * `SDKCompactBoundaryMessage`, `{type:"system", subtype:"compact_boundary"}`).
 */
async function* compactionStream(): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "working…" }] } };
  yield {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 190000, post_tokens: 18000, duration_ms: 3900 },
    uuid: "boundary-1",
    session_id: "sess-compact",
  };
  yield { type: "assistant", message: { content: [{ type: "text", text: "continuing…" }] } };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/3",
    session_id: "sess-compact",
    total_cost_usd: 2.71,
    num_turns: 38,
    permission_denials: [],
  };
}

// ── MASTER-PLAN §8B / W1-T36: detect + ledger a compaction event, flag the
// call quality-suspect. Proof: a unit test over a RECORDED stream fixture
// containing a compact_boundary message — the detector emits the compaction
// event on the ledger-line-shaped `workerLedgerFields` object, alongside
// `quality_suspect=true` on that same object as `verdict`.

test("collectWorkerResult: a compact_boundary message in the stream is DETECTED and recorded on the result", async () => {
  const r = await collectWorkerResult(compactionStream(), { childEnvKeys: [] });
  assert.deepEqual(r.compactionEvents, [{ trigger: "auto", preTokens: 190000, postTokens: 18000, durationMs: 3900 }]);
  assert.equal(r.qualitySuspect, true);
});

test("collectWorkerResult: a clean stream with NO compact_boundary message is never flagged quality-suspect", async () => {
  const r = await collectWorkerResult(successStream(), { childEnvKeys: [] });
  assert.deepEqual(r.compactionEvents, []);
  assert.equal(r.qualitySuspect, false);
});

test("workerLedgerFields: a compacted call's ledger line carries the compaction event AND quality_suspect=true alongside its verdict", async () => {
  const r = await collectWorkerResult(compactionStream(), { childEnvKeys: [] });
  const fields = workerLedgerFields(r);
  assert.equal(fields.verdict, "success");
  assert.equal(fields.quality_suspect, true, "quality_suspect rides the SAME ledger line as verdict");
  assert.deepEqual(fields.compaction_events, [
    { trigger: "auto", preTokens: 190000, postTokens: 18000, durationMs: 3900 },
  ]);
});

test("collectWorkerResult: an ERROR call (error_max_turns) that ALSO compacted is still flagged quality-suspect on the swallowed-throw path", async () => {
  const stream = (async function* (): AsyncGenerator<unknown> {
    yield { type: "assistant", message: { content: [{ type: "text", text: "working…" }] } };
    yield {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 200000 },
    };
    yield {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      session_id: "sess-err-compact",
      total_cost_usd: 4.2,
      num_turns: 60,
      permission_denials: [],
    };
    throw new Error("Claude Code returned an error result: error_max_turns");
  })();
  const r = await collectWorkerResult(stream, { childEnvKeys: [] });
  assert.equal(r.isError, true);
  assert.equal(r.qualitySuspect, true);
  assert.deepEqual(r.compactionEvents, [{ trigger: "auto", preTokens: 200000 }]);
});

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

// ── W1-T2205: workerTranscript joins ONCE — the final message never counts twice ───────────
//
// MEASURED (this task's design note i, two real captured envelopes — a one-turn and a
// two-turn live `query()` spawn against the actual SDK, not a guess off documentation): the
// terminal `SDKResultMessage.result` string is byte-identical to the LAST assistant text block
// `collectWorkerResult` already pushed onto `blocks` before it ever reads `result`. So a real
// worker result carries its own final message twice in `blocks`/`text` — exactly what
// `t348FakeWorker` (test/triage.test.ts) reproduces on purpose, and exactly what a hand-rolled
// `[r.text, r.blocks.join("\n")].join("\n")` then counts twice.

test("workerTranscript: a worker result whose final message also appears as its last assistant text block yields that message exactly once", () => {
  const r = { text: "PROPOSED: file W1-T9999", blocks: ["GROUND: checked the plan first.", "PROPOSED: file W1-T9999"] };
  const transcript = workerTranscript(r);
  assert.equal(transcript.match(/PROPOSED: file W1-T9999/g)?.length, 1, "the overlapping final message must not double-count");
  assert.match(transcript, /GROUND: checked the plan first\./, "the earlier, non-duplicated block still survives the join");
});

test("workerTranscript: the single-block overlap `t348FakeWorker` shape (blocks: [text]) collapses to ONE copy of the message", () => {
  const text = "AMBIGUOUS: a or b?\nOPTION: a|pick a\nOPTION: b|pick b\nRECOMMENDATION: a";
  const transcript = workerTranscript({ text, blocks: [text] });
  assert.equal(transcript, text, "blocks' sole entry IS text — the join must not repeat it");
  assert.equal(transcript.match(/^OPTION:/gm)?.length, 2, "each OPTION line appears once, not twice");
});

test("workerTranscript: text with NO overlap in blocks (the SDK fact does not hold, or blocks is empty) is still folded in — nothing is silently dropped", () => {
  assert.equal(workerTranscript({ text: "final", blocks: ["a", "b"] }), "final\na\nb");
  assert.equal(workerTranscript({ text: "final", blocks: [] }), "final");
});

// `runReview`'s advisory-reviewer semantic parse (run-task.ts) is the ONE `workerTranscript`
// call site this task's fix touches that no OTHER test anywhere in the repo reaches: every
// `runReview` test in test/review.test.ts disables the advisory-reviewer spawn via
// `spawnReviewer: false`, because reaching it otherwise means a live SDK spawn that costs real
// money. `reviewerQueryFn` (the injectable `queryFn` seam below, mirroring `fakeQueryFn`/
// `capturingQueryFn` above) drives it end-to-end without spending anything.
test("runReview (W1-T2205, end-to-end): the advisory reviewer's overlapping text/blocks reach the joined-transcript parse through a REAL spawnWorker call, exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-runreview-e2e-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-runreview-e2e-gh-"));
  const oldPath = process.env.PATH;
  const oldClaudeBinOverride = process.env[CLAUDE_BIN_ENV_OVERRIDE];
  const oldOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }), "utf8");
    const ledgerPath = join(root, "ledger.ndjson");

    // `runReview` has no keychain-override seam of its own, so its `spawnWorker` call runs the
    // REAL non-darwin credential-file preflight (`assertWorkerCredentialFile`, worker-home.ts)
    // against the process's real HOME. That preflight's own documented precedence accepts a
    // non-empty `CLAUDE_CODE_OAUTH_TOKEN` as an authenticated worker regardless of what the
    // `.credentials.json` file says — set here so this test is deterministic on a CI runner with
    // no such file (this repo's own `ci` job measured that shape), not merely on a host that
    // happens to already carry a real credential on disk. Never a real secret — the injected
    // `reviewerQueryFn` above means the value is never sent anywhere.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-never-sent-reviewerQueryFn-intercepts-the-spawn";

    // `runReview`'s own `spawnWorker` call takes no `claudeExecutable` override (unlike
    // `e2eSpawnWorkerArgs` above), so `resolveClaudeExecutable` runs its REAL preflight —
    // deterministic here via the env-override candidate (checked FIRST, before any live PATH
    // lookup) rather than depending on whatever `claude` binary the host running this suite
    // happens to have. `--version` must exit 0 for `defaultCanExecute` to accept it; the fake
    // `queryFn` above means this binary is never actually EXECUTED as a worker, only preflighted.
    const fakeClaude = join(binDir, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeClaude, 0o755);
    process.env[CLAUDE_BIN_ENV_OVERRIDE] = fakeClaude;

    // Only what runReview's own plumbing (readHeadShaRest, postReviewPending, `gh pr diff`,
    // the terminal status post) needs before it ever reaches the reviewer spawn — same shape
    // as test/review.test.ts's own `runReview` fixtures, trimmed to what this test touches.
    writeFileSync(
      join(binDir, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "api "*)
    case "$*" in
      *pulls/*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"cafebabe0002"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"cafebabe0002"}' ;;
      *state*) echo '{"state":"OPEN"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") echo "" ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${oldPath}`;

    // The overlapping shape MEASURED for a real envelope (worker.test.ts above, this task's
    // design note): the terminal `result` string is byte-identical to the last assistant text
    // block `collectWorkerResult` already pushed onto `blocks`. This queryFn reproduces that
    // shape on purpose — a hand-rolled double join would parse this REVIEW_VERDICT line off a
    // string carrying it twice; `workerTranscript` must not let that change the outcome.
    const verdictText = "REVIEW_VERDICT 1: FAIL";
    const reviewerQueryFn = (() => {
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: verdictText }] } };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: verdictText,
          session_id: "s-reviewer-e2e",
          total_cost_usd: 0.01,
          num_turns: 1,
        };
      })();
    }) as unknown as Parameters<typeof runReview>[0]["reviewerQueryFn"];

    let reviewerLedgered: Record<string, unknown> | undefined;
    const verdict = await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T2205", acceptance: [{ claim: "a claim the report never substantiates", proof: "unit test: no-such-test-title-xyzzy" }] },
      report: "This report deliberately substantiates nothing.",
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as never,
      log: (step: string, extra?: Record<string, unknown>) => {
        if (step === "review.reviewer") reviewerLedgered = extra;
      },
      say: () => {},
      account: (r: never) => r,
      spawnReviewer: true,
      reviewerQueryFn,
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 },
      ledgerPath,
      runId: "RUNREVIEW-E2E-1",
      // W1-T2347: the unsubstantiated report fails the review, so withdrawArmIfVerdictRefuses
      // reaches its `disarm` fallback — supplied so it never falls through to the real
      // disarmAutoMerge default; this test is about the reviewer spawn, not arming.
      disarm: () => "not-armed" as const,
    } as never);

    assert.ok(reviewerLedgered, "the advisory reviewer actually spawned and ledgered — the injected queryFn was really reached");
    assert.equal(reviewerLedgered!.downgrades, 1, "exactly ONE downgrade — the overlapping text/blocks must not double-count the REVIEW_VERDICT line");
    assert.equal(verdict.reviewerOutcome, "success", "the injected reviewer completed, not just attempted");
  } finally {
    process.env.PATH = oldPath;
    if (oldClaudeBinOverride === undefined) delete process.env[CLAUDE_BIN_ENV_OVERRIDE];
    else process.env[CLAUDE_BIN_ENV_OVERRIDE] = oldClaudeBinOverride;
    if (oldOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldOauthToken;
  }
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

test("workerLedgerFields: success call ⇒ {model, effort, tokens, cache_read_input_tokens, cache_creation_input_tokens, total_cost_usd, billing_mode, account_label, verdict, quality_suspect, compaction_events, max_turns} with billing_mode='subscription', verdict='success', quality_suspect=false", async () => {
  const r = await collectWorkerResult(usageStream(), {
    childEnvKeys: [],
    model: "claude-opus-4",
    effort: "high",
    // W1-T268: the account this call's spend is attributed to — a NAME, carried
    // verbatim onto the ledger fields below, never a secret.
    accountLabel: "acct-uuid-123",
    // W1-T303: the configured cap this call ran under — see max_turns below.
    maxTurns: 20,
  });
  const fields = workerLedgerFields(r);
  // W1-T477: `worker_duration_ms` is now ALWAYS present off a real `collectWorkerResult` call
  // (measured start-to-return around the message loop, see that function's own doc) — a real
  // elapsed-ms figure, never a fixed constant this exact-shape assertion could hardcode. Checked
  // for shape here, then excluded from the `deepEqual` below so the rest of the row's shape stays
  // pinned exactly as it was.
  assert.equal(typeof fields.worker_duration_ms, "number");
  assert.ok(fields.worker_duration_ms! >= 0, "a real spawn's duration is never negative");
  const { worker_duration_ms: _workerDurationMs, ...fieldsWithoutDuration } = fields;
  assert.deepEqual(fieldsWithoutDuration, {
    model: "claude-opus-4",
    // W1-T2572: `usageStream()`'s assistant message carries no `model` field, so the
    // provider reported nothing this call could attribute a served model to — an
    // ALWAYS-present explicit `null` (never an omitted key) plus the reason naming why.
    // See WorkerResult.servedModel/workerLedgerFields' own docs for the full contract.
    served_model: null,
    served_model_reason: "no assistant message in the stream reported a real model before the call ended",
    effort: "high",
    tokens: { input: 1000, output: 200, cacheRead: 500, cacheCreation: 50 },
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 50,
    total_cost_usd: 1.23,
    billing_mode: "subscription",
    account_label: "acct-uuid-123",
    verdict: "success",
    quality_suspect: false,
    compaction_events: [],
    // W1-T2245: now ALWAYS present off a real `collectWorkerResult` call (default false/[] when
    // the caller passed no `compactionConfigured` and the stream carried no failed-status
    // message) — see WorkerResult.compactionConfigured/compactionFailures' own docs.
    compaction_configured: false,
    compaction_failures: [],
    max_turns: 20,
  });
  assert.equal(BILLING_MODE, "subscription");
});

test("workerLedgerFields: account_label is undefined (never guessed) when spawnWorker could not resolve one", async () => {
  const r = await collectWorkerResult(usageStream(), { childEnvKeys: [], model: "claude-opus-4", effort: "high" });
  const fields = workerLedgerFields(r);
  assert.equal(fields.account_label, undefined);
});

test("workerLedgerFields: billing_mode is DERIVED 'api' when the child spawned WITH the ANTHROPIC_API_KEY valve (childEnvKeys carries the NAME, never the value)", async () => {
  // The proof surface is the key NAME in childEnvKeys — the secret VALUE is never
  // recorded, so a ledger line proves api-billing without leaking the key.
  const r = await collectWorkerResult(usageStream(), {
    childEnvKeys: ["ANTHROPIC_API_KEY", "HOME", "PATH"],
    model: "claude-opus-4",
  });
  const fields = workerLedgerFields(r);
  assert.equal(fields.billing_mode, "api");
  assert.equal(
    JSON.stringify(fields).includes("sk-ant"),
    false,
    "no secret value may appear anywhere in the ledger fields",
  );
});

// ── W1-T35: cache tokens ledgered as NAMED COLUMNS (flat, snake_case — matching
// the SDK envelope's own field names) so the cache-reuse signal (MASTER-PLAN
// §8A: "near-zero cache reads on the second worker of a run means the ordering
// is wrong") is directly grep/jq-able on a ledger line, not buried in `tokens`.

test("cacheTokenLedgerFields: mirrors tokens.cacheRead/cacheCreation as flat cache_read_input_tokens/cache_creation_input_tokens", () => {
  assert.deepEqual(
    cacheTokenLedgerFields({ input: 1000, output: 200, cacheRead: 500, cacheCreation: 50 }),
    { cache_read_input_tokens: 500, cache_creation_input_tokens: 50 },
  );
});

test("cacheTokenLedgerFields: zero cache tokens ledger as zero columns, not omitted", () => {
  assert.deepEqual(
    cacheTokenLedgerFields({ input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }),
    { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  );
});

test("workerLedgerFields: a result envelope carrying cache_read_input_tokens + cache_creation_input_tokens is ledgered into named columns on the worker line", async () => {
  const r = await collectWorkerResult(usageStream(), { childEnvKeys: [] });
  const fields = workerLedgerFields(r);
  assert.equal(fields.cache_read_input_tokens, 500);
  assert.equal(fields.cache_creation_input_tokens, 50);
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

// ── resolveClaudeExecutable (W1-T113: the vanished-binary incident) ────────
// Over injected fs/exec — no real binary, no real `which`, no real subprocess.

/** A minimal, fully-controllable set of resolveClaudeExecutable's injectable seams. */
function fakeToolchain(opts: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  existing?: Set<string>;
  runnable?: Set<string>;
  which?: () => string | undefined;
  locations?: typeof CLAUDE_EXECUTABLE_LOCATIONS;
}) {
  const existsCalls: string[] = [];
  const canExecuteCalls: string[] = [];
  const whichCalls: number[] = [];
  const deps = {
    env: opts.env ?? {},
    home: opts.home ?? "/home/op",
    exists: (p: string) => {
      existsCalls.push(p);
      return opts.existing?.has(p) ?? false;
    },
    which: () => {
      whichCalls.push(1);
      return opts.which ? opts.which() : undefined;
    },
    canExecute: (p: string) => {
      canExecuteCalls.push(p);
      return opts.runnable?.has(p) ?? false;
    },
    locations: opts.locations,
  };
  return { deps, existsCalls, canExecuteCalls, whichCalls };
}

test("resolveClaudeExecutable: pinned path absent, table hit — resolves via the location table with the resolved path", () => {
  const npmGlobal = "/home/op/.npm-global/bin/claude";
  const native = "/home/op/.local/bin/claude";
  const { deps } = fakeToolchain({
    home: "/home/op",
    existing: new Set([native]), // npm-global is ABSENT (the vanished-binary shape); native-installer IS present
    runnable: new Set([native]),
  });
  const path = resolveClaudeExecutable(createClaudeExecutableCache(), deps);
  assert.equal(path, native, "falls through the absent npm-global row to the native-installer row");
  assert.notEqual(npmGlobal, native);
});

test("resolveClaudeExecutable: everything absent — throws ClaudeToolchainBlockedError naming every searched path", () => {
  // `which` still resolves to A path (the shell-function/stale-symlink shape MASTER-PLAN
  // Field Finding 3 documents) — but nothing on disk backs it, same as every table row.
  const { deps } = fakeToolchain({ home: "/home/op", existing: new Set(), runnable: new Set(), which: () => "/usr/local/bin/claude" });
  assert.throws(
    () => resolveClaudeExecutable(createClaudeExecutableCache(), deps),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeToolchainBlockedError);
      assert.equal(err.reasonClass, "blocked_toolchain");
      const labels = err.searched.map((s) => s.label);
      assert.ok(labels.includes("PATH"), "PATH is named among the searched candidates");
      for (const loc of CLAUDE_EXECUTABLE_LOCATIONS) {
        assert.ok(labels.includes(loc.label), `${loc.label} is named among the searched candidates`);
      }
      assert.ok(err.searched.every((s) => s.existed === false), "every candidate is recorded as missing");
      assert.match(err.message, /searched:/);
      return true;
    },
    "the run is refused cleanly with a structured, named-paths error — never a raw ENOENT",
  );
});

test("resolveClaudeExecutable: a candidate that EXISTS but fails --version is distinguished from one that's simply missing", () => {
  const native = "/home/op/.local/bin/claude";
  const { deps } = fakeToolchain({ home: "/home/op", existing: new Set([native]), runnable: new Set() });
  assert.throws(
    () => resolveClaudeExecutable(createClaudeExecutableCache(), deps),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeToolchainBlockedError);
      const nativeEntry = err.searched.find((s) => s.path === native)!;
      assert.equal(nativeEntry.existed, true);
      assert.equal(nativeEntry.ran, false);
      assert.match(err.message, /exists, --version failed/);
      return true;
    },
  );
});

test("resolveClaudeExecutable: the location table is DATA — a seeded new row resolves with zero resolution-code changes", () => {
  const seededPath = "/opt/homebrew/bin/claude";
  // Override the table wholesale via the SAME `locations` seam every other test above
  // leaves at its default — the resolution CODE (resolveClaudeExecutable itself) is
  // byte-identical between this test and the others; only the DATA (the table) differs.
  const { deps } = fakeToolchain({
    home: "/home/op",
    existing: new Set([seededPath]),
    runnable: new Set([seededPath]),
    locations: [{ label: "homebrew", resolve: () => seededPath }],
  });
  const path = resolveClaudeExecutable(createClaudeExecutableCache(), deps);
  assert.equal(path, seededPath);
});

test("resolveClaudeExecutable: env override wins over PATH and the table", () => {
  const overridePath = "/custom/claude";
  const { deps } = fakeToolchain({
    env: { [CLAUDE_BIN_ENV_OVERRIDE]: overridePath },
    home: "/home/op",
    existing: new Set([overridePath, "/home/op/.npm-global/bin/claude"]),
    runnable: new Set([overridePath, "/home/op/.npm-global/bin/claude"]),
    which: () => "/home/op/.npm-global/bin/claude",
  });
  const path = resolveClaudeExecutable(createClaudeExecutableCache(), deps);
  assert.equal(path, overridePath);
});

test("resolveClaudeExecutable: live PATH wins over the table when no override is set", () => {
  const pathBin = "/usr/local/bin/claude";
  const { deps } = fakeToolchain({
    home: "/home/op",
    existing: new Set([pathBin, "/home/op/.npm-global/bin/claude"]),
    runnable: new Set([pathBin, "/home/op/.npm-global/bin/claude"]),
    which: () => pathBin,
  });
  const path = resolveClaudeExecutable(createClaudeExecutableCache(), deps);
  assert.equal(path, pathBin);
});

test("resolveClaudeExecutable: memoized per cache — a second call never re-touches fs/PATH", () => {
  const native = "/home/op/.local/bin/claude";
  const { deps, existsCalls, whichCalls } = fakeToolchain({ home: "/home/op", existing: new Set([native]), runnable: new Set([native]) });
  const cache = createClaudeExecutableCache();
  const first = resolveClaudeExecutable(cache, deps);
  const existsCallsAfterFirst = existsCalls.length;
  const whichCallsAfterFirst = whichCalls.length;
  const second = resolveClaudeExecutable(cache, deps);
  assert.equal(second, first);
  assert.equal(existsCalls.length, existsCallsAfterFirst, "no new exists() calls on the memoized second resolution");
  assert.equal(whichCalls.length, whichCallsAfterFirst, "no new which() calls on the memoized second resolution");
});

// ── resolveClaudeExecutable's REAL (uninjected) defaults ───────────────────
// Every test above injects `which`/`canExecute` — proving the resolution LOGIC
// over fakes, never the two live seams themselves (`defaultWhich`'s real
// `which claude` subprocess, `defaultCanExecute`'s real `--version` subprocess).
// These two tests leave both seams at their default (omitted from `deps`) and
// control the REAL PATH env var + a REAL executable fixture instead, so the
// live subprocess code paths run deterministically regardless of whether the
// host actually has `claude` installed.

test("resolveClaudeExecutable: real defaultWhich + defaultCanExecute — a `claude` placed on PATH resolves via a real subprocess lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-which-hit-"));
  const fakeClaude = join(dir, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeClaude, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${originalPath ? `:${originalPath}` : ""}`;
  try {
    const cache = createClaudeExecutableCache();
    // No `which`/`canExecute` in deps ⇒ resolveClaudeExecutable falls back to the
    // real defaultWhich/defaultCanExecute — `which claude` finds `fakeClaude` first
    // (prepended onto PATH) and `fakeClaude --version` exits 0, so it resolves.
    const path = resolveClaudeExecutable(cache, { env: {}, home: dir });
    assert.equal(path, fakeClaude, "the real `which claude` + `--version` preflight resolves the PATH-placed fixture");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("resolveClaudeExecutable: real defaultWhich + defaultCanExecute — PATH miss and a non-runnable candidate both refuse via the real subprocess paths", () => {
  const emptyPathDir = mkdtempSync(join(tmpdir(), "rmd-which-miss-"));
  const dir = mkdtempSync(join(tmpdir(), "rmd-canexec-miss-"));
  const brokenCandidate = join(dir, "claude");
  writeFileSync(brokenCandidate, "#!/bin/sh\nexit 1\n");
  chmodSync(brokenCandidate, 0o755);
  const originalPath = process.env.PATH;
  // An EMPTY PATH dir (no `claude` anywhere on it) ⇒ the real `which claude` call
  // fails (non-zero exit, no match) and defaultWhich's catch branch returns
  // `undefined` — deterministic regardless of whatever the host's real PATH holds.
  process.env.PATH = emptyPathDir;
  try {
    const cache = createClaudeExecutableCache();
    assert.throws(
      () =>
        resolveClaudeExecutable(cache, {
          env: {},
          home: dir,
          locations: [{ label: "broken", resolve: () => brokenCandidate }],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeToolchainBlockedError);
        // The real defaultCanExecute() ran `brokenCandidate --version` (exit 1) and
        // caught the non-zero exit, recording it as EXISTS-but-not-runnable, never
        // simply missing.
        const entry = err.searched.find((s) => s.path === brokenCandidate)!;
        assert.equal(entry.existed, true);
        assert.equal(entry.ran, false);
        return true;
      },
      "a PATH miss + a real exit-1 candidate both refuse cleanly via the live subprocess seams",
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

// ── workerKeychainGrantApps (W1-T113) ───────────────────────────────────────

test("workerKeychainGrantApps: the freshly resolved claudeBin (never config.claudeBin's stale value) flows into the keychain grant list", () => {
  assert.deepEqual(workerKeychainGrantApps("/fresh/resolved/claude"), ["/fresh/resolved/claude", "/usr/bin/security"]);
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

test("spawnWorker: W1-T113 — an all-absent toolchain refuses via the injected claudeExecutable override, before any worker-home/keychain work", async () => {
  // Proves two things at once: (1) `SpawnWorkerArgs.claudeExecutable` actually
  // reaches `resolveClaudeExecutable` (the injectable seam the altitude review
  // asked for, matching the file's existing `config` injection convention);
  // (2) the toolchain preflight fires BEFORE workerHomeDir/keychain/materialize
  // — a valid settings file passes the FIRST guard, so a raw ENOENT here would
  // otherwise surface only deep inside worker-home setup or the SDK spawn.
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-toolchain-"));
  const settingsFile = join(dir, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  await assert.rejects(
    () =>
      spawnWorker({
        cwd: dir,
        permissionMode: "bypassPermissions",
        settingsFile,
        prompt: "unreachable — toolchain resolution throws first",
        config: { claudeBin: "/unused", root: dir },
        claudeExecutable: {
          cache: createClaudeExecutableCache(),
          deps: { env: {}, home: dir, exists: () => false, which: () => undefined, canExecute: () => false, locations: [] },
        },
      }),
    ClaudeToolchainBlockedError,
    "an all-absent toolchain refuses cleanly via the SAME injectable seam resolveClaudeExecutable's own unit tests use",
  );
});

test("spawnWorker: W1-T113 — the darwin-only keychain gate provisions with the FRESHLY resolved claudeBin, via the injected platform/runner/exists seams", async () => {
  // spawnWorker's keychain-provisioning gate only runs `if (platform === "darwin")`
  // — real CI is ubuntu, so this exercises it via the SAME injection convention as
  // `config`/`claudeExecutable` above: force `platform: "darwin"` and hand
  // `ensureWorkerKeychain` (worker-home.ts) its OWN pre-existing `runner`/`exists`
  // fakes (never a real `security(1)` call). The fake runner records every argv,
  // then throws on `unlock-keychain` — a deliberate abort BEFORE spawnWorker ever
  // reaches materializeWorkerHome/the real SDK `query()`, same "throws before
  // reaching the SDK" shape the toolchain test above uses.
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-keychain-"));
  const settingsFile = join(dir, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  const claudeBin = "/fresh/resolved/claude";
  const runnerCalls: string[][] = [];
  const runner = (argv: string[]) => {
    runnerCalls.push(argv);
    if (argv[0] === "find-generic-password" && argv.includes("-w")) return "secret\n";
    if (argv[0] === "find-generic-password") return '"acct"<blob>="worker-account"';
    if (argv[0] === "unlock-keychain") throw new Error("simulated: abort before any real spawn work");
    return "";
  };
  await assert.rejects(
    () =>
      spawnWorker({
        cwd: dir,
        permissionMode: "bypassPermissions",
        settingsFile,
        prompt: "unreachable — the simulated unlock failure throws first",
        config: { claudeBin: "/unused", root: dir },
        claudeExecutable: {
          cache: createClaudeExecutableCache(),
          deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: claudeBin }, home: dir, exists: () => true, canExecute: () => true, locations: [] },
        },
        keychain: { platform: "darwin", runner, exists: () => false },
      }),
    WorkerKeychainError,
    "the simulated unlock-keychain failure surfaces as a named WorkerKeychainError, never a raw throw",
  );
  const provisionCall = runnerCalls.find((argv) => argv[0] === "add-generic-password");
  assert.ok(provisionCall, "the keychain-provisioning add-generic-password call actually ran");
  assert.ok(provisionCall!.includes(claudeBin), "the FRESHLY resolved claudeBin (not config.claudeBin's stale value) is granted");
  assert.ok(provisionCall!.includes("/usr/bin/security"), "the fixed /usr/bin/security helper is always granted alongside it");
});

// ── spawnWorker end-to-end containment (W1-T117) ────────────────────────────
// Every earlier spawnWorker test above throws BEFORE reaching the SDK's real
// `query()` call — that call needs a live `claude` subprocess, which a unit
// test cannot provide. `args.queryFn` (W1-T117's own injectable seam) lets
// these two tests drive spawnWorker all the way to its OWN process-group-
// teardown wiring: the fake queryFn below plays the SDK's part just far
// enough to invoke `options.spawnClaudeCodeProcess` itself (exactly as the
// real SDK does — see worker-containment.ts's file header), which spawns a
// REAL detached child via the real `spawnDetachedGroup`. No `claude` binary
// is ever touched; the only thing faked is the SDK's own message stream.

function fakeQueryFn(behavior: "success" | "error") {
  return ((params: {
    prompt: string;
    options: { env: Record<string, string>; spawnClaudeCodeProcess?: (o: unknown) => { kill: (s: string) => void } };
  }) => {
    // Simulates the SDK's real behavior: it calls the custom spawn hook with
    // the command it would have run (a real, harmless `sleep`) AND the SAME
    // `options.env` spawnWorker itself built (markers included) — exactly
    // what the real SDK passes through, never a re-hardcoded env.
    params.options.spawnClaudeCodeProcess?.({
      command: "/bin/sh",
      args: ["-c", "sleep 300"],
      env: params.options.env,
      signal: new AbortController().signal,
    });
    if (behavior === "error") {
      return (async function* () {
        throw new Error("simulated transport failure — no result envelope ever seen");
      })();
    }
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-1",
        total_cost_usd: 0.02,
        num_turns: 1,
      };
    })();
  }) as unknown as Parameters<typeof spawnWorker>[0]["queryFn"];
}

function e2eSpawnWorkerArgs(dir: string, extra: Record<string, unknown> = {}) {
  const settingsFile = join(dir, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  return {
    cwd: dir,
    permissionMode: "bypassPermissions" as const,
    settingsFile,
    prompt: "end-to-end containment fixture",
    config: { claudeBin: "/unused", root: dir },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: dir, exists: () => true, canExecute: () => true, locations: [] },
    },
    // Force past the darwin-only keychain gate without touching the real
    // `security(1)` binary — same escape hatch the keychain test above uses.
    keychain: {
      platform: "linux" as NodeJS.Platform,
      // recon-cloud-workers-spike stop 6: stub the non-darwin credential rung, exactly as the
      // darwin cases above stub `runner`/`exists`. These end-to-end cases are about teardown and
      // env propagation; the credential is a dependency they declare, not their subject.
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }),
    },
    ...extra,
  };
}

/**
 * Wait for a pid to disappear, POLLING TO A DEADLINE rather than sleeping a fixed
 * interval.
 *
 * WHAT THIS REPLACES WAS A RACE, NOT A WAIT. Both end-to-end teardown tests below
 * used `await new Promise((r) => setTimeout(r, 50)) // let the SIGKILL land` and
 * then asserted the pid was gone. 50ms is not a guarantee that a real SIGKILL has
 * been delivered AND the child reaped — it is a guess that holds on an idle laptop
 * and not on a loaded CI runner. MEASURED: #1582 (a ONE-FILE MARKDOWN diff, which
 * cannot reach process teardown) failed `coverage-ratchet` here with
 * `actual: true, expected: false` — the process was simply still alive at 50ms —
 * and the FLAKE-RETRY re-run failed identically, because an immediate retry lands
 * on the same still-loaded machine. `ci-gate` then went red as the aggregator
 * (its own REQUIRED list names coverage-ratchet), so one sleep reddened two checks.
 *
 * THE ASSERTION IS NOT WEAKENED — this is the point. A group that is genuinely NOT
 * torn down still fails, because the caller still asserts `isPidAlive === false`
 * afterwards; it just fails at the deadline instead of at an arbitrary 50ms. What
 * is removed is only the false NEGATIVE on a slow machine. This is the repo's own
 * recurring shape (CLAUDE.md): a bound that fires on a HEALTHY condition.
 */
async function awaitPidGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("spawnWorker (end-to-end, SUCCESS path): the process group spawned via options.spawnClaudeCodeProcess is torn down after a normal resolve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-e2e-success-"));
  let capturedPid: number | undefined;
  const result = await spawnWorker({
    ...e2eSpawnWorkerArgs(dir),
    runId: "run-e2e-1",
    taskId: "W1-T117",
    queryFn: fakeQueryFn("success"),
    containment: {
      spawn: (opts, onStderr) => {
        const spawned = spawnDetachedGroup(opts, onStderr);
        capturedPid = spawned.pid;
        return spawned;
      },
    },
  } as Parameters<typeof spawnWorker>[0]);

  assert.equal(result.text, "done", "the fake success envelope reached the caller normally");
  assert.ok(capturedPid, "spawnClaudeCodeProcess was invoked and a real pid captured");
  await awaitPidGone(capturedPid!); // let the SIGKILL land — polled, not guessed
  assert.equal(isPidAlive(capturedPid!), false, "the group spawned by THIS spawnWorker call must be torn down on resolve");
});

test("spawnWorker (end-to-end, ERROR path): the process group is STILL torn down when the SDK stream throws (no result envelope)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-e2e-error-"));
  let capturedPid: number | undefined;
  await assert.rejects(
    () =>
      spawnWorker({
        ...e2eSpawnWorkerArgs(dir),
        queryFn: fakeQueryFn("error"),
        containment: {
          spawn: (opts, onStderr) => {
            const spawned = spawnDetachedGroup(opts, onStderr);
            capturedPid = spawned.pid;
            return spawned;
          },
        },
      } as Parameters<typeof spawnWorker>[0]),
    /simulated transport failure/,
  );
  assert.ok(capturedPid, "spawnClaudeCodeProcess was invoked and a real pid captured, even on the error path");
  await awaitPidGone(capturedPid!);
  assert.equal(isPidAlive(capturedPid!), false, "the group must STILL be torn down — teardown is a finally, not a success-only step");
});

test("spawnWorker (end-to-end): REMUDERO_RUN_ID/REMUDERO_TASK_ID actually reach the child's env when runId/taskId are supplied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-e2e-markers-"));
  let observedEnv: Record<string, string | undefined> | undefined;
  await spawnWorker({
    ...e2eSpawnWorkerArgs(dir),
    runId: "run-marker-1",
    taskId: "W1-T117",
    queryFn: fakeQueryFn("success"),
    containment: {
      spawn: (opts) => {
        observedEnv = opts.env;
        return { process: { stdin: {}, stdout: {}, kill: () => true, killed: false, exitCode: null, on() {}, once() {}, off() {} } as never, pid: 999999 };
      },
    },
  } as Parameters<typeof spawnWorker>[0]);
  assert.equal(observedEnv?.[RUN_ID_ENV], "run-marker-1");
  assert.equal(observedEnv?.[TASK_ID_ENV], "W1-T117");
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

// ── parseFollowups: the OPTIONAL '## Follow-ups' §2 section (W1-T105) ──────
// "ensure that if any implementations come back with follow-up research,
// actions, tasks, etc — they get added to the plan" (operator, verbatim). The
// contract: one typed entry per line (research: | task: | action:), each
// line's own text carrying its one-line why; absent section is a no-op.

test("parseFollowups: a report with a typed Follow-ups section parses both entries, typed, why inline", () => {
  const text = [
    "REPORT",
    "Implemented the thing.",
    "",
    "## Follow-ups",
    "research: confirm whether the mutation gate needs the same diff-scope trick — unmeasured here",
    "task: extend ci-gate.yml's REQUIRED array for the new check — out of this task's one concern",
    "",
    "PR_URL: https://github.com/acme/remudero/pull/42",
  ].join("\n");
  const entries = parseFollowups(text);
  assert.ok(entries);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    type: "research",
    text: "confirm whether the mutation gate needs the same diff-scope trick — unmeasured here",
  });
  assert.deepEqual(entries[1], {
    type: "task",
    text: "extend ci-gate.yml's REQUIRED array for the new check — out of this task's one concern",
  });
});

test("parseFollowups: an ACTION entry, a bulleted line, and case-insensitivity all parse", () => {
  const entries = parseFollowups(["## follow-ups", "- Action: rotate the leaked test fixture token"].join("\n"));
  assert.ok(entries);
  assert.deepEqual(entries, [{ type: "action", text: "rotate the leaked test fixture token" }]);
});

test("parseFollowups: a report with NO Follow-ups section returns null — a byte-identical no-op", () => {
  const text = ["REPORT", "Implemented the thing.", "PR_URL: https://github.com/acme/remudero/pull/42"].join("\n");
  assert.equal(parseFollowups(text), null);
  // parseReport's own extraction is unaffected by this parser's existence.
  assert.equal(parseReport(text)?.prUrl, "https://github.com/acme/remudero/pull/42");
});

test("parseFollowups: an empty/malformed Follow-ups section (no typed lines) returns null, not an empty array", () => {
  const text = ["REPORT", "## Follow-ups", "Nothing typed here, just prose.", "PR_URL: https://x/pull/1"].join("\n");
  assert.equal(parseFollowups(text), null);
});

// ── parseReport: anchored PR_URL extraction (W1-T62) ────────────────────────
// Regression fixture modeled on run W1-T54b-1784151420811: the REPORT cited
// evidence pull-URLs (to satisfy acceptance criteria demanding them) BEFORE its
// final `PR_URL:` line. The old parse (`text.match(/.../pull/\d+/)?.[0]`) took
// the FIRST pull-URL anywhere — the evidence PR #80 (Dependabot's) — and won a
// false verdict=merged. Attribution must anchor to the LAST `PR_URL:` line only.

test("parseReport: an evidence pull-URL BEFORE the final PR_URL line does NOT win attribution (W1-T54b regression)", () => {
  const text = [
    "REPORT",
    "Criteria demand evidence pull-URLs in the REPORT:",
    "- https://github.com/acme/remudero/pull/80 (dependency PR, evidence only)",
    "- https://github.com/acme/remudero/pull/81 (dependency PR, evidence only)",
    "Shipped docs/dep-review.md separately.",
    "PR_URL: https://github.com/acme/remudero/pull/91",
  ].join("\n");
  const report = parseReport(text);
  assert.ok(report);
  assert.equal(report.prUrl, "https://github.com/acme/remudero/pull/91");
});

test("parseReport: multiple PR_URL lines (a DECISION_REQUEST resume appends a second REPORT) — the LAST one wins", () => {
  const text = [
    "REPORT",
    "PR_URL: https://github.com/acme/remudero/pull/5",
    "DECISION_REQUEST resumed, re-executed:",
    "REPORT",
    "PR_URL: https://github.com/acme/remudero/pull/6",
  ].join("\n");
  assert.equal(parseReport(text)?.prUrl, "https://github.com/acme/remudero/pull/6");
});

test("parseReport: a missing final PR_URL line fails CLOSED — no attribution, even with pull-URLs elsewhere", () => {
  const text = [
    "REPORT",
    "See https://github.com/acme/remudero/pull/80 for prior art.",
    "No PR was opened this run.",
  ].join("\n");
  assert.equal(parseReport(text)?.prUrl, undefined);
});

test("parseReport: a malformed PR_URL line (not a real github pull URL) fails CLOSED — no attribution", () => {
  const text = ["REPORT", "PR_URL: <the pull request url>"].join("\n");
  assert.equal(parseReport(text)?.prUrl, undefined);
});

test("parseReport: the anchor is case-insensitive and tolerant of extra whitespace, still anchored to the line", () => {
  const text = ["report", "  pr_url:   https://github.com/acme/remudero/pull/12  "].join("\n");
  assert.equal(parseReport(text)?.prUrl, "https://github.com/acme/remudero/pull/12");
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

// ── appendQuestionAnswer (W3-T5): the panel's answer write lands in the SAME durable store ──

test("appendQuestionAnswer: appends into the SAME plan/questions.ndjson a QUESTION was written to (\"the answer flows to the Architect\")", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "remudero-qa-"));
  appendQuestion(repoRoot, { ts: "2026-07-14T00:00:00.000Z", task: "W1-T78", question: "Which approach?" });
  const ok = appendQuestionAnswer(repoRoot, {
    ts: "2026-07-14T00:05:00.000Z",
    task: "W1-T78",
    answer: "use approach X",
    origin: "abc123def456",
  });
  assert.equal(ok, true);

  const lines = readFileSync(join(repoRoot, "plan", "questions.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, "the question AND its answer live in the same append-only store");
  assert.equal(lines[0].question, "Which approach?");
  assert.equal(lines[1].task, "W1-T78");
  assert.equal(lines[1].answer, "use approach X");
  assert.equal(lines[1].origin, "abc123def456");
});

test("appendQuestionAnswer: NON-BLOCKING -- an unwritable store returns false, never throws", () => {
  const file = join(mkdtempSync(join(tmpdir(), "remudero-qa-")), "not-a-dir");
  writeFileSync(file, "x");
  const repoRoot = join(file, "nested");

  let threw = false;
  let result: boolean | undefined;
  try {
    result = appendQuestionAnswer(repoRoot, { ts: "t", task: "W1-T78", answer: "x", origin: "o" });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "a failed answer write must NEVER throw (mirrors appendQuestion's §2 non-blocking contract)");
  assert.equal(result, false, "the failure is reported as false, not swallowed silently");
});

// ── W1-T480: the empty tool set holds by TRUTHINESS, and nothing asserted it ──
//
// `src/lib/worker.ts` has the repository's ONLY occurrence of `options.tools`:
//   if (args.tools) options.tools = args.tools;
// An empty array is TRUTHY in JavaScript, so `tools: []` really does reach the SDK
// and really does restrict the spawn. Written `if (args.tools?.length)` — a
// one-character-class edit any reviewer would wave through as a defensive tidy-up —
// the empty array becomes falsy, the option is never set, and the SDK default (ALL
// Claude Code tools) applies instead. FIVE read-only spawn builders depend on that
// truthiness: buildRiskJudgeSpawnArgs, buildEscalationJudgeSpawnArgs,
// buildFlightJudgeSpawnArgs, buildDecisionSummarySpawnArgs and
// buildFeedbackExpansionSpawnArgs.
//
// THE FIVE TESTS THAT CLAIM THE PROPERTY PROVE SOMETHING ELSE. Each asserts the
// return value of a PURE BUILDER (`assert.deepEqual(args.tools, [])`), four of them
// announcing the security property in their own title — and all five stay green
// under that one-character change, because a builder that never calls spawnWorker
// cannot observe what spawnWorker does with its result. `options.tools` appeared
// ZERO times anywhere in test/ before this block.
//
// SAME SHAPE AS test/strict-probe.test.ts (W1-T98): "0 violations" reads identically
// whether strict is genuinely wired or silently inert, so the remedy there is a probe
// driven through the REAL path that must fail one way and pass the other — never an
// assertion on an intermediate value. An empty tool list reads identically whether it
// is applied or silently dropped, so it gets the same treatment here.
//
// THREE CASES, AND TWO OF THEM ARE THE DISCRIMINATOR:
//   - `tools: []`    -> PRESENT and deep-equals []. THE FALSIFIER: under `?.length`
//                       this is `undefined` and this assertion alone fails.
//   - tools ABSENT   -> NOT SET AT ALL, so the SDK default applies. This is what stops
//                       someone "fixing" the first case by assigning unconditionally,
//                       which would silently restrict the implement worker to NO tools
//                       — the opposite regression, and the more damaging one. Twelve
//                       call sites rely on that default deliberately.
//   - populated list -> passes through unchanged.
//
// NO `src/` CHANGE ACCOMPANIES THIS, DELIBERATELY (W1-T480 design (iv)): the code is
// correct today. Making the guard an explicit `!== undefined` is exactly as unverified
// as the edit this block exists to catch — until this block exists, at which point it
// is safe for anyone to make.

/**
 * The success-path `queryFn` of {@link fakeQueryFn}, minus the process spawn and plus
 * a capture of the SDK `options` object. These three cases are about what reaches the
 * SDK, not about teardown, so they deliberately never invoke
 * `params.options.spawnClaudeCodeProcess` — no real child is started and no pid has to
 * be reaped. Injecting `queryFn` is `spawn-guard.ts`'s own documented escape from the
 * live-spawn refusal, which is why this runs at all.
 */
function capturingQueryFn(sink: { options?: Record<string, unknown> }) {
  return ((params: { prompt: string; options: Record<string, unknown> }) => {
    sink.options = params.options;
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-tools",
        total_cost_usd: 0,
        num_turns: 1,
      };
    })();
  }) as unknown as Parameters<typeof spawnWorker>[0]["queryFn"];
}

async function spawnAndCaptureOptions(prefix: string, extra: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const sink: { options?: Record<string, unknown> } = {};
  const result = await spawnWorker({
    ...e2eSpawnWorkerArgs(dir, extra),
    runId: "run-tools-1",
    taskId: "W1-T480",
    queryFn: capturingQueryFn(sink),
  } as Parameters<typeof spawnWorker>[0]);
  assert.equal(result.text, "done", "the fake success envelope reached the caller — the spawn path really ran");
  assert.ok(sink.options, "the injected queryFn observed the SDK options object");
  return sink.options!;
}

test("W1-T480 FALSIFIER: an EMPTY tools array reaches the SDK as an empty array — the five read-only judges are restricted by this and nothing else", async () => {
  const options = await spawnAndCaptureOptions("rmd-worker-tools-empty-", { tools: [] });

  // THE WHOLE POINT. Under `if (args.tools?.length)` this key is absent and
  // `options.tools` is undefined, so BOTH assertions below fail — while every
  // builder test that claims this property stays green.
  assert.ok("tools" in options, "an empty tool list must be PASSED THROUGH, not dropped as falsy");
  assert.deepEqual(options.tools, [], "the SDK must receive exactly the empty list, restricting the spawn to no tools");
});

test("W1-T480: an ABSENT tools list leaves options.tools unset, so the SDK default applies — the 12 call sites that pass no tools key rely on this", async () => {
  const options = await spawnAndCaptureOptions("rmd-worker-tools-absent-", {});

  // The guard against "fixing" the case above by assigning unconditionally: that
  // would send `undefined` (or an empty list) for every unrestricted spawn and
  // silently strip the implement worker of its tools.
  assert.equal("tools" in options, false, "no tools key must be set at all when the caller passes none — the SDK default must remain reachable");
});

test("W1-T480: a POPULATED tools list reaches the SDK unchanged", async () => {
  const options = await spawnAndCaptureOptions("rmd-worker-tools-populated-", { tools: ["Bash", "Read"] });

  assert.ok("tools" in options, "a populated tool list must be passed through");
  assert.deepEqual(options.tools, ["Bash", "Read"], "the list must arrive byte-identical — neither reordered nor augmented");
});
