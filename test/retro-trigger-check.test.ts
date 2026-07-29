import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retroTriggerCheck, buildRetroDaemonHooks } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { RetroTriggerDecision, ShippedGithub } from "../src/lib/retro.js";

// ── W1-T160: retroTriggerCheck — the IMPURE wiring behind evaluateRetroTrigger ────
//
// The trigger PREDICATE and integrity gate are pure (test/retro.test.ts); the daemon
// LOOP's scheduling contract is test/daemon-retro-trigger.test.ts. This file pins the
// third piece: run-task.ts's `retroTriggerCheck`, which reads the REAL marker + ledger
// and unions the SHIPPED count off a gateway before handing the count to the pure
// predicate. Its `deps` seam lets a test point `config` at a throwaway root and inject
// a fake `github`, so the marker-corrupt / gateway-unavailable / healthy paths are all
// driven with zero `gh` round-trips — the same mechanism `retroCommand` uses in prod,
// never a stub of the function under test.

/** A healthy gateway: never throttled, credits nothing on its own (empty ledger below). */
function healthyGithub(): ShippedGithub {
  return {
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    unavailable: () => undefined,
  };
}

function fixtureRoot(): { config: Config; markerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "retro-trigger-check-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const config: Config = { claudeBin: "/bin/true", root };
  return { config, markerPath: join(root, "state", "last-retro.json") };
}

test("retroTriggerCheck: with an ABSENT marker and a healthy gateway, it reads the real ledger and returns a decision (days threshold, unbounded)", () => {
  const { config } = fixtureRoot();
  // A present-but-non-merged ledger: exercises the readFileSync branch; credits 0 merges.
  writeFileSync(
    join(config.root, "state", "ledger.ndjson"),
    `{"run_id":"DAEMON-1","task_id":"DAEMON","step":"daemon.start"}\n`,
  );
  const now = new Date("2026-07-29T00:00:00.000Z");
  const decision = retroTriggerCheck(now, { config, github: healthyGithub() });
  assert.ok(decision, "an absent marker is the genuine first-ever-retro signal — it evaluates, never skips");
  assert.equal(decision.fire, true, "an absent marker makes days-since-marker unbounded — the days threshold fires");
  assert.equal(decision.reason, "days");
  assert.equal(decision.mergesSinceMarker, 0, "the empty/non-merged ledger credits zero shipped merges");
});

test("retroTriggerCheck: a CORRUPT marker fails closed — returns undefined, never replays a torn marker as 'no marker'", () => {
  const { config, markerPath } = fixtureRoot();
  writeFileSync(markerPath, "{ this is not valid json");
  const decision = retroTriggerCheck(new Date("2026-07-29T00:00:00.000Z"), { config, github: healthyGithub() });
  assert.equal(decision, undefined, "a corrupt marker skips THIS tick's evaluation entirely (fail closed)");
});

test("retroTriggerCheck: a DEGRADED (unavailable) gateway skips the tick — never claims a false merges-since-marker of 0", () => {
  const { config } = fixtureRoot();
  const throttled: ShippedGithub = {
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    unavailable: () => "gh api rate_limit: 0 remaining",
  };
  const decision = retroTriggerCheck(new Date("2026-07-29T00:00:00.000Z"), { config, github: throttled });
  assert.equal(decision, undefined, "an unhealthy gateway skips evaluation rather than read its silence as zero merges");
});

// ── buildRetroDaemonHooks: the daemon's self-target hook pair (extracted from the literal) ──

test("buildRetroDaemonHooks: checkRetroTrigger delegates to the check; runRetroTrigger runs the automated retro exactly once with the decision", async () => {
  let checkCalls = 0;
  let ranWith: { automated: Extract<RetroTriggerDecision, { fire: true }> } | undefined;
  const fired: Extract<RetroTriggerDecision, { fire: true }> = {
    fire: true,
    reason: "merges",
    mergesSinceMarker: 25,
    daysSinceMarker: 3,
  };
  const hooks = buildRetroDaemonHooks({
    check: () => {
      checkCalls++;
      return fired;
    },
    runRetro: async (rest, opts) => {
      assert.deepEqual(rest, [], "the automated retro runs with no positional args — cadence, not an operator invocation");
      ranWith = opts;
      return 0;
    },
  });

  const decision = hooks.checkRetroTrigger();
  assert.equal(checkCalls, 1, "checkRetroTrigger delegates straight to the injected check");
  assert.deepEqual(decision, fired);

  await hooks.runRetroTrigger(fired);
  assert.deepEqual(ranWith?.automated, fired, "runRetroTrigger forwards the firing decision as the automated gate");
});
