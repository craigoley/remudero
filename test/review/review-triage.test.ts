// W1-T14851: review triage asks every available decision model about the same pull request.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { DECISION_ANSWERED_STEP } from "#src/lib/decision-model.js";
import type { DecisionCandidate } from "#src/lib/mounts.js";
import { clearOpenWeightAbsence } from "#src/lib/worker-provider.js";
import { readLedgerLines } from "#src/lib/status.js";
import { REVIEW_TRIAGE_ROLE, triagePullRequest, type ReviewTriagePullRequest } from "#src/lib/review-triage.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const KEY = "fixture-triage-key-never-printed";
const env = { RMD_CASH_TRIAGE_A_KEY: KEY, RMD_CASH_TRIAGE_B_KEY: KEY };
const PRICE = { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.05, readAt: "2026-11-12", source: "fixture page" };
const MODEL_A: DecisionCandidate = { name: "fixture-a", deployment: "fixture-decisions-a", shape: "openai-decisions",
  endpoint: { source: "cash-entry", entry: "triage-a" }, price: PRICE };
const MODEL_B: DecisionCandidate = { name: "fixture-b", deployment: "fixture-decisions-b", shape: "openai-decisions",
  endpoint: { source: "cash-entry", entry: "triage-b" }, price: PRICE };
const UNSET: DecisionCandidate = { name: "fixture-unset", deployment: "fixture-decisions-unset", shape: "openai-decisions",
  endpoint: { source: "cash-entry", entry: "triage-missing" }, price: PRICE };

const PR: ReviewTriagePullRequest = { prUrl: "https://github.com/acme/remudero/pull/303", headSha: "c".repeat(40),
  title: "docs: one line", diff: ["diff --git a/docs/a.md b/docs/a.md", "--- a/docs/a.md", "+++ b/docs/a.md", "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n") };

function fixture(t: TestContext): { dir: string; config: Config } {
  clearOpenWeightAbsence();
  t.after(() => clearOpenWeightAbsence());
  const { dir } = ownedFixtureDir(t, "review-triage-every-model");
  return { dir, config: { claudeBin: "/unused", root: dir, dailyCapUsd: 25, workerProviders: { cashDeploymentEndpoints: {
    "triage-a": { endpoint: "https://triage-a.cognitiveservices.azure.com/", keyEnv: "RMD_CASH_TRIAGE_A_KEY" },
    "triage-b": { endpoint: "https://triage-b.cognitiveservices.azure.com/", keyEnv: "RMD_CASH_TRIAGE_B_KEY" },
  } } } as Config };
}

const ANSWERS = [
  { type: "predicate", name: "docs_only", probability: 0.97 },
  { type: "predicate", name: "test_only", probability: 0.02 },
  { type: "predicate", name: "touches_high_risk_paths", probability: 0.01 },
  { type: "score", name: "size_band", score: 0, confidence: 0.9, probabilities: [{ value: 0, label: "tiny", probability: 0.9 },
    { value: 1, label: "small", probability: 0.07 }, { value: 2, label: "medium", probability: 0.02 }, { value: 3, label: "large", probability: 0.01 }] },
  { type: "predicate", name: "needs_human", probability: 0.03 },
];
const ok = () => new Response(JSON.stringify({ model: "served-fixture", answers: ANSWERS, usage: { input_tokens: 300, output_tokens: 0 } }),
  { status: 200, headers: { "content-type": "application/json" } });
const bad = () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, headers: { "content-type": "application/json" } });

/** Answers by host: `failing` hosts answer 400, every other host answers. Records each host asked, in order. */
function byHost(asked: string[], failing: ReadonlySet<string> = new Set()): typeof fetch {
  return async (url) => {
    const host = new URL(String(url)).host;
    asked.push(host);
    return failing.has(host) ? bad() : ok();
  };
}
const triageRows = (dir: string) => readLedgerLines(join(dir, "state", "ledger.ndjson"))
  .filter((line) => line.step === DECISION_ANSWERED_STEP && line.role === REVIEW_TRIAGE_ROLE);

test("W1-T14851 criterion 1: every resolving decision model answers the same triage input", async (t) => {
  const { dir, config } = fixture(t);
  const asked: string[] = [];
  await triagePullRequest(config, PR, { env, fetchImpl: byHost(asked) }, [MODEL_A, UNSET, MODEL_B]);
  assert.deepEqual(asked, ["triage-a.cognitiveservices.azure.com", "triage-b.cognitiveservices.azure.com"],
    "each resolving model is asked once, in decision_models order; the unresolved one is not sent");
  const rows = triageRows(dir);
  assert.deepEqual(rows.map((row) => [row.candidate, row.outcome]), [["fixture-a", "answered"], ["fixture-b", "answered"]]);
  assert.equal(typeof rows[0]!.input_digest, "string");
  assert.equal(rows[0]!.input_digest, rows[1]!.input_digest, "both models judged the same input");
});

test("W1-T14851 criterion 2: one model's failure does not stop the next", async (t) => {
  const { dir, config } = fixture(t);
  const asked: string[] = [];
  await triagePullRequest(config, PR, { env, fetchImpl: byHost(asked, new Set(["triage-a.cognitiveservices.azure.com"])) },
    [MODEL_A, MODEL_B]);
  assert.equal(asked.length >= 2, true, "the second model is still asked after the first fails");
  assert.deepEqual(triageRows(dir).map((row) => [row.candidate, row.outcome]), [["fixture-a", "failed"], ["fixture-b", "answered"]]);
});

test("W1-T14851 criterion 3: the first resolving candidate's row is returned", async (t) => {
  const { config } = fixture(t);
  const failedFirst = await triagePullRequest(config, PR, { env, fetchImpl: byHost([], new Set(["triage-a.cognitiveservices.azure.com"])) },
    [UNSET, MODEL_A, MODEL_B]);
  assert.equal(failedFirst?.candidate, "fixture-a", "the first RESOLVING candidate's row, even when it failed");
  assert.equal(failedFirst?.outcome, "failed");
  const none = await triagePullRequest(config, PR, { env: {}, fetchImpl: byHost([]) }, [UNSET, MODEL_A]);
  assert.equal(none?.candidate, "fixture-unset", "with none resolving, the first candidate is asked once to record why");
  assert.equal(none?.outcome, "unavailable");
});
