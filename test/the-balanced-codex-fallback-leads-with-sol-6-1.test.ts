import assert from "node:assert/strict";
import { test } from "node:test";
import { codexCandidatesForCapability } from "../src/lib/worker-provider.js";

/**
 * W1-T6359 — with no capability table (`.remudero/mounts.yaml` unreadable), the balanced Codex
 * lane falls back to the code-side `FALLBACK_CODEX_MODELS.balanced` list. That list must lead with
 * Sol 6.1 in the same order the mounts' `capabilities.codex.balanced` rows declare, not Luna.
 */
test("W1-T6359: a balanced fallback leads with gpt-6.1-sol", () => {
  for (const effort of [undefined, "low", "medium", "high"]) {
    const candidates = codexCandidatesForCapability(undefined, "balanced", effort);
    assert.equal(candidates[0], "gpt-6.1-sol", `effort ${String(effort)}: a balanced fallback must lead with Sol 6.1`);
    assert.deepEqual(candidates, ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"]);
  }
});
