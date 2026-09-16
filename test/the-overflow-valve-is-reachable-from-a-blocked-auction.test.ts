/**
 * W1-T3705 — THE VALVE COULD NOT REACH THE MOMENT IT EXISTS FOR.
 *
 * `config.overflow: "api_key"` bills a worker to API credits instead of the subscription. Its whole
 * purpose is to keep working when the subscription is exhausted — and the capacity auction refuses
 * ON an exhausted subscription, before any Claude spawn is built, with no knowledge the valve is
 * armed. Measured on origin/main: `overflow` appears nowhere in worker-provider.ts or
 * provider-routing-policy.ts.
 *
 * These fixtures pin the arm that closes it, and the three things that keep it honest:
 *   the order      — cash first where it can serve the surface (far cheaper); API-billed Claude
 *                    only where cash CANNOT, which is the shell-needing lanes.
 *   both factors   — the config switch and the key, the same two-factor rule buildWorkerEnv keeps.
 *   a bound        — no cap, no divert: this arm spends real money.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { overflowFallbackRefusal, cashFallbackRefusal, spawnWorker } from "../src/lib/worker.js";

// NOT key-shaped on purpose: a realistic prefix here trips the reachable-secret census (W1-T2698),
// and the value is never sent anywhere — only its PRESENCE is read by the two-factor check.
const KEY = "test-only-overflow-factor-present";

function cfg(over: Record<string, unknown> = {}): never {
  return {
    claudeBin: "/bin/true",
    root: "/tmp",
    dailyCapUsd: 20,
    overflow: "api_key",
    workerProviders: { enabled: ["claude", "codex", "cash"], cashFallbackWhenBlocked: true, cashEndpoint: "https://example.test/" },
    ...over,
  } as never;
}

test("the overflow valve refuses on any missing factor, and names which", () => {
  // Armed and complete.
  assert.equal(overflowFallbackRefusal(cfg(), { ANTHROPIC_API_KEY: KEY }), undefined);

  // BOTH FACTORS ARE REQUIRED, in both directions — a key in a shell must not bill the fleet, and
  // the switch alone must not either.
  assert.match(overflowFallbackRefusal(cfg({ overflow: "none" }), { ANTHROPIC_API_KEY: KEY })!, /overflow/);
  assert.match(overflowFallbackRefusal(cfg(), {})!, /ANTHROPIC_API_KEY is absent/);

  // THIS ARM SPENDS REAL MONEY, so an absent cap refuses it exactly as it refuses cash.
  assert.match(overflowFallbackRefusal(cfg({ dailyCapUsd: null }), { ANTHROPIC_API_KEY: KEY })!, /unbounded/);

  // And it cannot route to a provider the committed host config does not enable.
  const noClaude = cfg({ workerProviders: { enabled: ["cash"], cashFallbackWhenBlocked: true } });
  assert.match(overflowFallbackRefusal(noClaude, { ANTHROPIC_API_KEY: KEY })!, /claude is not an enabled/);
});

test("a blocked auction reaches the overflow valve, and only after cash has refused", async () => {
  // BEHAVIOURAL, NOT PREDICATE-ONLY: the whole defect was that nothing CONSULTED the valve, which a
  // test of the predicate alone cannot see. This drives the real `spawnWorker` with every enabled
  // subscription unreadable, so the auction genuinely blocks.
  const root = mkdtempSync(join(tmpdir(), "rmd-overflow-"));
  try {
    const settingsFile = join(root, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }), "utf8");
    const unreadable = { readable: false, windows: [], detail: "exhausted" };

    let cashSpawns = 0;
    const routing = () => ({
      readClaude: async () => ({ provider: "claude", ...unreadable }),
      readCodex: async () => ({ provider: "codex", ...unreadable }),
      writeStatus: () => {},
      spawnOpenWeight: async () => {
        cashSpawns += 1;
        return { provider: "cash", text: "cash", isError: false, subtype: "success" };
      },
    });

    // WHICH ERROR YOU GET NAMES WHICH GATE YOU REACHED, and that is the whole assertion here.
    // `ProviderCapacityBlockedError` means the AUCTION refused — the defect. Anything else means the
    // spawn got past it and into the Claude path, which is the fix. The Claude path then fails on
    // this host's toolchain preflight, which is fine: the claim under test is that the auction no
    // longer blocks, not that a real worker runs.
    const blockedByAuction = (e: unknown) => e instanceof Error && e.name === "ProviderCapacityBlockedError";

    // (a) UNBOUNDED TOOLS: cash refuses the surface, so the overflow arm carries it. Before this
    //     task the same spawn raised ProviderCapacityBlockedError with the valve armed and unread.
    const armed = await spawnWorker({
      cwd: root, prompt: "p", settingsFile, config: cfg(), env: { ANTHROPIC_API_KEY: KEY },
      providerRouting: routing(),
    } as never).catch((e: unknown) => e);
    assert.equal(cashSpawns, 0, "cash cannot serve an unbounded surface, so it must not be handed one");
    assert.equal(blockedByAuction(armed), false, `the armed valve must get past the auction, got: ${String(armed)}`);

    // (b) CASH FIRST WHERE IT CAN SERVE. With a cash-serveable surface the cheaper arm wins and the
    //     overflow arm is never reached — the order is the decision, not an accident.
    cashSpawns = 0;
    await spawnWorker({
      cwd: root, prompt: "p", settingsFile, config: cfg(), env: { ANTHROPIC_API_KEY: KEY },
      tools: ["Read", "Grep", "Glob", "RunCheck"],
      providerRouting: routing(),
    } as never).catch(() => {});
    assert.equal(cashSpawns, 1, "a cash-serveable surface takes the cheaper arm");

    // (c) DISARMED: the auction blocks exactly as it did before, so the arm is what changed and
    //     nothing else quietly widened.
    cashSpawns = 0;
    const disarmed = await spawnWorker({
      cwd: root, prompt: "p", settingsFile, config: cfg({ overflow: "none" }), env: {},
      providerRouting: routing(),
    } as never).catch((e: unknown) => e);
    assert.equal(blockedByAuction(disarmed), true, "with the valve disarmed a blocked auction must still block");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cash and overflow are independent switches, so neither implies the other", () => {
  // A host may want cheap diverts without API billing, or API billing without cash. Neither
  // predicate may read the other's switch.
  const cashOnly = cfg({ overflow: "none" });
  assert.equal(cashFallbackRefusal(cashOnly, ["Read", "Grep", "Glob", "RunCheck"]), undefined);
  assert.ok(overflowFallbackRefusal(cashOnly, { ANTHROPIC_API_KEY: KEY }));

  const overflowOnly = cfg({ workerProviders: { enabled: ["claude", "codex"], cashFallbackWhenBlocked: false } });
  assert.equal(overflowFallbackRefusal(overflowOnly, { ANTHROPIC_API_KEY: KEY }), undefined);
  assert.ok(cashFallbackRefusal(overflowOnly, ["Read", "Grep", "Glob", "RunCheck"]));
});
