import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { retroTriggerCheck, buildRetroDaemonHooks } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import { saveMarker, type RetroTriggerDecision, type ShippedGithub } from "../src/lib/retro.js";
import { loadPolicy, policyPath, type Policy } from "../src/lib/policy.js";

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

// ── W1-T264: the retro cadence thresholds are POLICY DATA, read at this ONE call site ──
//
// `retroTriggerCheck` now loads `plan/policy.yaml`'s `retro` row (via `deps.policy`,
// defaulting to the real `loadPolicy(policyPath(repoRoot))`) and hands its two fields to
// `evaluateRetroTrigger` as its fourth argument, instead of letting that parameter fall
// back to `retro.ts`'s own `defaultRetroTriggerPolicy()` source literals. `policyFixture`
// below builds a full, VALID `Policy` (spreading the real shipped policy so every OTHER
// field stays schema-valid) with just the `retro` row overridden — the minimal fixture a
// test needs to prove the injected value, not retro.ts's literal, governs the decision.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED_POLICY: Policy = loadPolicy(policyPath(REPO_ROOT));

function policyFixture(retro: { mergesThreshold: number; daysThreshold: number }): Policy {
  return { ...SHIPPED_POLICY, values: { ...SHIPPED_POLICY.values, retro } };
}

/** `n` ledger-native MERGED runs, each crediting one shipped merge once paired with a
 *  `github.headRefName` that resolves each run's own branch (`run-R<i>`, {@link ownBranchOf}). */
function mergedLedgerLines(n: number, ts: string): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    const runId = `R${i}`;
    const taskId = `T${i}`;
    const prUrl = `https://github.com/o/r/pull/${i}`;
    lines.push(JSON.stringify({ ts, run_id: runId, task_id: taskId, type: "implement", step: "run.start" }));
    lines.push(JSON.stringify({ ts, run_id: runId, task_id: taskId, step: "verdict", verdict: "merged", pr_url: prUrl, cost_usd: 1 }));
  }
  return lines.join("\n") + "\n";
}

/** A gateway that credits every run `mergedLedgerLines` wrote — resolves each PR's head
 *  branch back to that run's own `run-R<i>` branch, so the P9 ownership assert passes. */
function creditingGithub(): ShippedGithub {
  return {
    findMergedByTrailer: () => null,
    headRefName: (prUrl) => {
      const m = /pull\/(\d+)$/.exec(prUrl);
      return m ? `run-R${m[1]}` : undefined;
    },
    unavailable: () => undefined,
  };
}

test("W1-T264 acceptance 2 — retroTriggerCheck passes the loaded policy to evaluateRetroTrigger", () => {
  const { config, markerPath } = fixtureRoot();
  // 3 days before `now` — under retro.ts's own 7-day default, so a wire-through bug
  // (still falling back to the source literal) would show up as a false negative here.
  saveMarker(markerPath, { ts: "2026-07-26T00:00:00.000Z", learnings_count: 0, runs_seen: 0 });
  const now = new Date("2026-07-29T00:00:00.000Z");

  const underDefault = retroTriggerCheck(now, {
    config,
    github: healthyGithub(),
    policy: policyFixture({ mergesThreshold: 25, daysThreshold: 7 }),
  });
  assert.equal(underDefault?.fire, false, "3 days < a daysThreshold of 7 — no fire");

  const underLowered = retroTriggerCheck(now, {
    config,
    github: healthyGithub(),
    policy: policyFixture({ mergesThreshold: 25, daysThreshold: 2 }),
  });
  assert.equal(
    underLowered?.fire,
    true,
    "the INJECTED policy's daysThreshold (2) governs the decision, not retro.ts's own 7-day source default",
  );
  assert.equal(underLowered?.reason, "days");
});

test("W1-T264 acceptance 3 — a policy fixture with a lower mergesThreshold fires earlier", () => {
  const { config, markerPath } = fixtureRoot();
  saveMarker(markerPath, { ts: "2026-07-28T00:00:00.000Z", learnings_count: 0, runs_seen: 0 }); // 1 day before `now`
  writeFileSync(join(config.root, "state", "ledger.ndjson"), mergedLedgerLines(3, "2026-07-28T12:00:00.000Z"));
  const now = new Date("2026-07-29T00:00:00.000Z"); // 1 day since marker — well under either policy's daysThreshold
  const github = creditingGithub();

  const underDefault = retroTriggerCheck(now, { config, github, policy: policyFixture({ mergesThreshold: 25, daysThreshold: 7 }) });
  assert.equal(underDefault?.mergesSinceMarker, 3, "all 3 merged runs are credited");
  assert.equal(underDefault?.fire, false, "3 credited merges is under the default policy's mergesThreshold (25) — no fire");

  const underLowered = retroTriggerCheck(now, { config, github, policy: policyFixture({ mergesThreshold: 2, daysThreshold: 7 }) });
  assert.equal(
    underLowered?.fire,
    true,
    "the SAME 3 merges cross a policy fixture's lowered mergesThreshold (2) — fires EARLIER, with no source edit",
  );
  assert.equal(underLowered?.reason, "merges");
});

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
