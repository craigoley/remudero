/**
 * NO-TOOL-JUDGE DIVERT — an EMPTY tool bound is not an ABSENT one, and conflating them refused the
 * single most divertable spawn shape in the repo.
 *
 * `cashCanServeToolSurface` returned false for `tools.length === 0` alongside `tools === undefined`.
 * Only the second has a reason: undefined means the worker inherits the UNRESTRICTED surface, which
 * includes Bash. An empty array is the opposite — a deliberate declaration that this spawn wants no
 * capability at all, carried by every pure-judge rung here (`RISK_JUDGE_TOOLS` is literally `[]`;
 * both feedback judges say "everything it needs is in the prompt — no exploration").
 *
 * MEASURED on the live fleet 2026-09-17, retro's promotion judge under a full squeeze:
 *
 *   {"event":"worker.provider.cash_fallback_refused",
 *    "refusal":"this spawn's tool surface is not implementable by cash ()"}
 *
 * The empty parenthesis is the bug rendering itself: a bound that named nothing, refused for
 * naming nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cashCanServeToolSurface, cashFallbackRefusal, harnessOwnsGitFor } from "../src/lib/worker.js";
import { RISK_JUDGE_TOOLS } from "../src/lib/risk-judge.js";

const CASH_ENABLED = {
  workerProviders: { enabled: ["claude", "openweight"], cashFallbackWhenBlocked: true },
  dailyCapUsd: 25,
} as never;

test("no-tool-judge-divert: an EMPTY bound can be served by cash", () => {
  assert.equal(cashCanServeToolSurface([]), true, "a spawn asking for no capability needs nothing implemented");
});

test("no-tool-judge-divert: an ABSENT bound is still refused, for its own reason", () => {
  // THE BOUNDARY THIS MUST NOT MOVE. `undefined` inherits the unrestricted surface, which carries
  // Bash — the one capability the check-runner deliberately lacks. Absent is not empty.
  assert.equal(cashCanServeToolSurface(undefined), false);
});

test("no-tool-judge-divert: the risk judge's real declared surface is exactly this shape", () => {
  // Not a hypothetical: reads the shipped constant, so if RISK_JUDGE_TOOLS ever gains a tool this
  // test stops claiming something about a surface that no longer exists.
  assert.deepEqual([...RISK_JUDGE_TOOLS], []);
  assert.equal(cashCanServeToolSurface(RISK_JUDGE_TOOLS), true);
});

test("no-tool-judge-divert: the refusal path agrees, and no longer renders an empty parenthesis", () => {
  // The end-to-end shape the fleet actually hit: with cash enabled and a cap set, a no-tool spawn
  // must produce NO refusal at all.
  assert.equal(cashFallbackRefusal(CASH_ENABLED, []), undefined);

  // And the unbounded case still refuses, still saying "unbounded" rather than an empty list.
  const refusal = cashFallbackRefusal(CASH_ENABLED, undefined);
  assert.match(String(refusal), /unbounded/);
});

test("no-tool-judge-divert: a bound naming a tool cash cannot run is still refused", () => {
  // The predicate must not have become permissive in general — only correct about emptiness.
  assert.equal(cashCanServeToolSurface(["Bash"]), false);
  assert.equal(cashCanServeToolSurface(["Read", "Bash"]), false);
  assert.equal(cashCanServeToolSurface(["Read", "Grep", "Glob", "RunCheck"]), true);
});

test("no-tool-judge-divert: a no-tool spawn is shell-less, so the harness owns its git", () => {
  // Consistency with the coherence rule: `harnessOwnsGitFor([])` already read true, while
  // `cashCanServeToolSurface([])` read false — the two disagreed about the same surface. They
  // agree now.
  assert.equal(harnessOwnsGitFor([]), true);
  assert.equal(cashCanServeToolSurface([]), true);
});
