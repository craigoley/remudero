import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerSettingsError } from "../src/lib/settings.js";
import {
  collectWorkerResult,
  parseDecisionRequest,
  parseQuestion,
  spawnWorker,
  stripDecoration,
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

// ── Output-contract parser golden tasks ─────────────────────────────────────
// These freeze the two near-miss payloads that bit us live (WS-0 marker `)` bleed,
// T1D markdown decoration) plus the QUESTION contract, so a parser regression can
// never again silently corrupt an auto-choose. Auto-choose (run-task §4) echoes
// `recommended` into DECISIONS.md and the resume prompt verbatim — a dirty value
// there is an unrecoverable wrong turn, so the parser is the load-bearing floor.

test("GOLDEN (WS-0 near-miss): an inline (RECOMMENDED) marker yields a clean value with NO ')' bleed", () => {
  // The exact WS-0 shape: no explicit `RECOMMENDED:` line, only an inline marker
  // on an option. The old parser captured `")"` and was right only by luck.
  const payload = [
    "DECISION_REQUEST: where should the fallback flag live?",
    "- Use an env var (RECOMMENDED)",
    "- Use a CLI flag",
    "Reversible: yes — flip the default in a follow-up.",
  ].join("\n");
  const d = parseDecisionRequest(payload);
  assert.ok(d, "DECISION_REQUEST must be recognised");
  assert.equal(d.recommended, "Use an env var", "marker stripped to the bare option value");
  assert.doesNotMatch(d.recommended ?? "", /\)/, "no stray ')' bleeds into the chosen value");
  assert.deepEqual(d.options, ["Use an env var (RECOMMENDED)", "Use a CLI flag"]);
});

test("GOLDEN (T1D near-miss): DECORATION IS NOT DATA — bold, backticks, emoji, trailing '****' are stripped", () => {
  // PR #12 auto-choose payload: the RECOMMENDED value arrived wrapped in markdown
  // bold, backticks, a ✅ emoji, and a trailing '****'. None of that is data.
  const decorated = "**Option A — `docs/review-gate.md` (new doc)** ✅ ****";
  const payload = [
    "DECISION_REQUEST: pick the review-gate doc home.",
    `- ${decorated}`,
    "- Option B — inline in README",
    `RECOMMENDED: ${decorated}`,
  ].join("\n");
  const d = parseDecisionRequest(payload);
  assert.ok(d, "DECISION_REQUEST must be recognised");
  assert.equal(
    d.recommended,
    "Option A — docs/review-gate.md (new doc)",
    "the chosen value is clean data — em dash + parens survive, chrome does not",
  );
  for (const junk of ["*", "`", "✅"]) {
    assert.ok(!d.recommended?.includes(junk), `chosen value must not contain ${junk}`);
  }
  assert.ok(!d.recommended?.endsWith("****"), "no trailing '****'");
  assert.ok(
    d.options.includes("Option A — docs/review-gate.md (new doc)"),
    "the option list is decoration-free too, so auto-choose can match the value",
  );
});

test("stripDecoration: strips chrome but preserves structural punctuation the worker meant as data", () => {
  assert.equal(stripDecoration("**bold** `code` ✅"), "bold code");
  assert.equal(stripDecoration("Option A — foo/bar.md (new)"), "Option A — foo/bar.md (new)");
  assert.equal(stripDecoration("  plain  "), "plain");
});

test("no-RECOMMENDED fallback: a DECISION_REQUEST with no marker leaves recommended undefined so §4 falls back to the first option", () => {
  // The auto-choose floor is `recommended ?? options[0]` — when a worker emits a
  // DECISION_REQUEST but names no recommendation, the deterministic floor still
  // resolves it (to the first option) rather than stalling for a human.
  const payload = [
    "DECISION_REQUEST: which serialization?",
    "- NDJSON",
    "- a single JSON array",
  ].join("\n");
  const d = parseDecisionRequest(payload);
  assert.ok(d);
  assert.equal(d.recommended, undefined, "no marker ⇒ no recommendation to echo");
  assert.equal(d.options[0], "NDJSON", "…so the floor auto-chooses the first option");
});

test("parseDecisionRequest: non-DECISION text returns null (the parser is a gate, not a guess)", () => {
  assert.equal(parseDecisionRequest("just a normal report, no decision here"), null);
});

test("GOLDEN (QUESTION contract): a QUESTION parses to its text and never blocks the run", () => {
  const q = parseQuestion("QUESTION: should the deny-floor also cover $ROOT-relative symlinks?");
  assert.ok(q, "QUESTION must be recognised");
  assert.equal(q.question, "should the deny-floor also cover $ROOT-relative symlinks?");
  assert.equal(parseQuestion("no question marker present"), null);
});
