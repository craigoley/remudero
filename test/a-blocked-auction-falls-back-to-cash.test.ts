import assert from "node:assert/strict";
import { test } from "node:test";
import { cashCanServeToolSurface, cashFallbackRefusal } from "../src/lib/worker.js";
import { OPENWEIGHT_FUNCTIONS } from "../src/lib/worker-provider.js";
import type { Config } from "../src/lib/config-schema.js";

// W1-T3692. When no subscription has readable headroom the auction throws
// ProviderCapacityBlockedError and the queue STALLS. Cash should carry the work at exactly that
// moment -- but ONLY for a spawn whose tool surface it can actually run, because openWeightTools
// throws on a tool it does not implement.

const base = {
  claudeBin: "/unused/claude",
  root: "/tmp",
  dailyCapUsd: 20,
  workerProviders: { enabled: ["claude", "cash"], cashFallbackWhenBlocked: true },
} as unknown as Config;

const cfg = (over: Record<string, unknown>) =>
  ({ ...base, workerProviders: { ...(base.workerProviders as object), ...over } }) as unknown as Config;

test("W1-T3692: a lane whose tools cash implements is eligible for the fallback", () => {
  assert.equal(cashFallbackRefusal(base, ["Read", "Grep", "Glob", "RunCheck"]), undefined);
  assert.equal(cashCanServeToolSurface(["Read", "Grep", "Glob", "RunCheck"]), true);
});

test("W1-T3692: a lane needing Bash is REFUSED, so a build lane is never handed to a provider that cannot run it", () => {
  // This is the fix/build surface: FIX_WORKER_TOOLS. Bash has no cash equivalent by design --
  // the check-runner cannot commit or push.
  assert.equal(OPENWEIGHT_FUNCTIONS["Bash"], undefined, "Bash must remain unimplementable by cash");
  assert.equal(cashCanServeToolSurface(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]), false);
  const refusal = cashFallbackRefusal(base, ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]);
  assert.match(String(refusal), /not implementable by cash/);
});

test("W1-T3692: an UNBOUNDED spawn is never eligible — absent bound refuses, it does not assume", () => {
  assert.equal(cashCanServeToolSurface(undefined), false);
  assert.equal(cashCanServeToolSurface([]), false);
  assert.match(String(cashFallbackRefusal(base, undefined)), /unbounded/);
});

test("W1-T3692: the fallback is OFF unless the operator opted in, so it cannot arrive by upgrade", () => {
  const off = cfg({ cashFallbackWhenBlocked: undefined });
  assert.match(String(cashFallbackRefusal(off, ["Read", "Grep"])), /has not enabled/);
  const explicitlyFalse = cfg({ cashFallbackWhenBlocked: false });
  assert.match(String(cashFallbackRefusal(explicitlyFalse, ["Read", "Grep"])), /has not enabled/);
});

test("W1-T3692: cash must be an enabled provider, and the spend must be capped", () => {
  const notEnabled = cfg({ enabled: ["claude"] });
  assert.match(String(cashFallbackRefusal(notEnabled, ["Read", "Grep"])), /not an enabled worker provider/);

  const uncapped = { ...base, dailyCapUsd: undefined } as unknown as Config;
  assert.match(String(cashFallbackRefusal(uncapped, ["Read", "Grep"])), /dailyCapUsd is unset/);
});

test("W1-T3692: every declared dispatch-lane openweight bound is genuinely servable by cash", async () => {
  // The bounds table and the adapter's function list must not drift apart: a lane declaring an
  // openweight row that cash cannot run would pass the auction fallback and then throw.
  const { DISPATCH_LANE_TOOL_BOUNDS } = await import("../src/lib/worker.js");
  const table = DISPATCH_LANE_TOOL_BOUNDS as unknown as Record<string, { openweight?: readonly string[] }>;
  let checked = 0;
  for (const [lane, byProvider] of Object.entries(table)) {
    if (!byProvider.openweight) continue;
    checked++;
    assert.ok(
      cashCanServeToolSurface(byProvider.openweight),
      `lane '${lane}' declares an openweight bound cash cannot run: ${byProvider.openweight.join(", ")}`,
    );
  }
  assert.ok(checked > 0, "at least one lane must declare an openweight bound, or the fallback has no eligible lane");
});

// ── W1-T3726: the divert was reachable by exactly ONE lane ──────────────────────────────────────
// `spawnWorker` judges the fallback on `args.cashTools ?? args.tools`, and only implement ever
// passed `cashTools`. Every other lane therefore offered its CLAUDE surface -- which names Bash --
// so recon and diagnose were refused at the moment the subscription ran out, even though
// DISPATCH_LANE_TOOL_BOUNDS has declared their cash equivalents since W1-T3656.

import { cashDivertSpawnFields, cashDivertToolsForLane, resolveDispatchLaneToolBound } from "../src/lib/worker.js";

test("W1-T3726: the CLAUDE surface of a read-only lane is refused — this is the defect being fixed", () => {
  for (const lane of ["recon", "diagnose"]) {
    const claudeSurface = resolveDispatchLaneToolBound(lane, "claude");
    assert.ok(claudeSurface.includes("Bash"), `${lane} really does declare Bash on Claude`);
    assert.match(
      String(cashFallbackRefusal(base, claudeSurface)),
      /not implementable by cash/,
      `${lane}'s Claude surface must be the thing that was refused`,
    );
  }
});

test("W1-T3726: each read-only lane now OFFERS a surface the fallback accepts", () => {
  for (const lane of ["recon", "diagnose"]) {
    const divert = cashDivertToolsForLane(lane);
    assert.ok(divert !== undefined, `${lane} must offer a divert surface`);
    assert.equal(divert!.includes("Bash"), false, "and it must not smuggle a shell in");
    assert.equal(
      cashFallbackRefusal(base, divert),
      undefined,
      `${lane} must be eligible once it offers its own cash surface`,
    );
  }
});

test("W1-T3726: alert_fix offers NO divert — it commits and pushes, which the check-runner cannot", () => {
  // `undefined` rather than a throw: this answers an OFFER, so "no cash equivalent" is a valid
  // answer meaning "keep this lane on the subscription", not a routing error.
  assert.equal(cashDivertToolsForLane("alert_fix"), undefined);
  // retro is deliberately absent too: its prompt does `git add` + commit, so a shell-less retro
  // would be handed a surface that cannot do what it was just asked to do.
  assert.equal(cashDivertToolsForLane("retro") === undefined, false, "retro declares a bound...");
});

test("W1-T3726: an UNKNOWN lane throws, so a typo cannot silently disable a divert", () => {
  assert.throws(() => cashDivertToolsForLane("recno"), /no declared tool bound for dispatch lane/);
});

// W1-T3726 / W1-T2905: THE WIRING, NOT JUST THE HELPER, used to be checked here by reading
// src/run-task.ts as text and grepping for the `...cashDivertSpawnFields("<lane>")` spread --
// exactly the shape the source-text-assertion-census ratchet exists to stop growing (it passes
// when the prose is right and the behaviour is wrong, and breaks on a refactor that moves the
// prose and nothing else). The wiring the read was standing in for is instead driven for real,
// through a live runTask() dispatch with an injected spawn that CAPTURES the args object:
//   - recon: test/recon-degrade.test.ts, "BEHAVIORAL: the healthy path names the record even
//     when recon's OBSERVED section is EMPTY" asserts spawnCalls[0].cashTools against
//     cashDivertToolsForLane("recon").
//   - diagnose: test/run-task.test.ts, "BEHAVIORAL (W1-T7B): two real implement strikes
//     dispatch a DIAGNOSE worker..." asserts spawnCalls[3].cashTools against
//     cashDivertToolsForLane("diagnose").
// Both call sites therefore have a falsifier that fails if the `...cashDivertSpawnFields(lane)`
// spread is ever dropped from src/run-task.ts, with zero source-text reads.

test("W1-T3726: the spread helper carries the surface for a divertible lane and nothing for the rest", () => {
  // BOTH ARMS, because the whole point of this shape is that the call site has no branch to test:
  // if this is wrong, run-task spreads the wrong thing and nothing else notices.
  assert.deepEqual(cashDivertSpawnFields("recon"), { cashTools: cashDivertToolsForLane("recon") });
  assert.deepEqual(cashDivertSpawnFields("diagnose"), { cashTools: cashDivertToolsForLane("diagnose") });
  assert.deepEqual(cashDivertSpawnFields("alert_fix"), {}, "a lane with no cash equivalent spreads NOTHING");
  assert.equal("cashTools" in cashDivertSpawnFields("alert_fix"), false, "not even an undefined key");
});
