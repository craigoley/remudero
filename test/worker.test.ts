import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerSettingsError } from "../src/lib/settings.js";
import {
  DENY_FLOOR_FALLBACK_MODE,
  collectWorkerResult,
  evaluateDenyFloor,
  parseDecisionRequest,
  spawnWorker,
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
