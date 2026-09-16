import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { effectiveCashCapUsd } from "../src/lib/worker-provider.js";
import { spawnWorker } from "../src/lib/worker.js";

// this change. Operator intent, 2026-09-16: "$10 on a normal day and $25 on a day when the
// subscriptions are tapped out." The higher figure is a CEILING that stops the cap refusing work
// on the one day cash is the only thing that can do it -- not permission to spend more.

test("a plain number is the whole cap, squeezed or not — existing configs are untouched", () => {
  assert.equal(effectiveCashCapUsd(20), 20);
  assert.equal(effectiveCashCapUsd(20, { squeezed: true }), 20);
  assert.equal(effectiveCashCapUsd(20, { squeezed: false }), 20);
});

test("a pair uses `normal` for routine work and `squeezed` only when subscriptions are tapped", () => {
  const cap = { normal: 10, squeezed: 25 };
  assert.equal(effectiveCashCapUsd(cap), 10, "absent flag means an ordinary day");
  assert.equal(effectiveCashCapUsd(cap, { squeezed: false }), 10);
  assert.equal(effectiveCashCapUsd(cap, { squeezed: true }), 25);
});

test("an absent cap stays absent, so the transport still refuses to run uncapped", () => {
  // reserveOpenWeightBudget throws on undefined; this must not invent a default.
  assert.equal(effectiveCashCapUsd(undefined), undefined);
  assert.equal(effectiveCashCapUsd(null), undefined);
  assert.equal(effectiveCashCapUsd(null, { squeezed: true }), undefined);
});

test("a pair whose squeezed is BELOW normal is refused as a transposition", () => {
  // Silently honouring it would cap the fleet hardest exactly when it is most constrained.
  assert.throws(
    () => effectiveCashCapUsd({ normal: 25, squeezed: 10 }),
    /squeezed \(\$10\) is below dailyCapUsd\.normal \(\$25\)/,
  );
  assert.throws(() => effectiveCashCapUsd({ normal: 25, squeezed: 10 }), /swap them/);
});

test("equal figures are allowed — that is an operator opting OUT of the raise", () => {
  assert.equal(effectiveCashCapUsd({ normal: 10, squeezed: 10 }, { squeezed: true }), 10);
});

test("a non-finite figure refuses rather than reaching the reservation as NaN", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => effectiveCashCapUsd({ normal: bad, squeezed: 25 }), /two finite numbers/);
    assert.throws(() => effectiveCashCapUsd({ normal: 10, squeezed: bad }), /two finite numbers/);
  }
});

// ── on the guard that is NOT here ───────────────────────────────────────────────────────────────
//
// An earlier draft read src/lib/worker.ts and asserted `cashSqueezed: true` appears exactly once,
// to prove routine mount-affinity work can never claim the raised ceiling. W1-T2905's ratchet
// refused it, and rightly: a per-file count of source-text reads in tests is capped precisely
// because such assertions pin TEXT rather than BEHAVIOUR and rot on the next refactor.
//
// The property still holds and is still worth stating, just not by grepping the tree: the flag is
// carried on SpawnWorkerArgs and set in one branch, which typecheck pins structurally, and the
// cap arithmetic above is the part a bug would actually show up in.

test("the squeeze ceiling is claimed in exactly ONE place", async () => {
  // THE CLAIM IS ABOUT REACHABILITY, asserted BEHAVIOURALLY rather than by reading source: the
  // raised ceiling is reachable only through W1-T3692's blocked-auction fallback, never through
  // ordinary mount-affinity cash work.
  //
  // Observed at the cash adapter's own doorstep — the `cashSqueezed` flag it is HANDED — because
  // that flag is the only thing `effectiveCashCapUsd` consults to decide which figure applies. A
  // path that does not set it cannot claim the raise, whatever the config says.
  const root = mkdtempSync(join(tmpdir(), "rmd-squeeze-claim-"));
  try {
    const settingsFile = join(root, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }), "utf8");
    const config = {
      claudeBin: "/bin/true", root, dailyCapUsd: { normal: 10, squeezed: 25 },
      workerProviders: { enabled: ["claude", "codex", "cash"], cashFallbackWhenBlocked: true, cashEndpoint: "https://example.test/" },
    };
    const unreadable = { readable: false, windows: [], detail: "exhausted" };
    const seen: Array<boolean | undefined> = [];
    const spawnOpenWeight = async (a: { cashSqueezed?: boolean }) => {
      seen.push(a.cashSqueezed);
      return { provider: "cash", text: "ok", isError: false, subtype: "success" };
    };

    // (a) MOUNT AFFINITY — ordinary cash work. It must NOT claim the raise.
    await spawnWorker({
      cwd: root, prompt: "p", settingsFile, config, tools: ["Read"], mountProvider: "cash",
      providerRouting: { writeStatus: () => {}, spawnOpenWeight },
    } as never).catch(() => {});
    assert.equal(seen.at(-1), undefined, "ordinary mount-affinity cash work must not claim the squeeze ceiling");

    // (b) THE BLOCKED-AUCTION FALLBACK — the one path that may.
    await spawnWorker({
      cwd: root, prompt: "p", settingsFile, config, tools: ["Read"],
      providerRouting: {
        readClaude: async () => ({ provider: "claude", ...unreadable }),
        readCodex: async () => ({ provider: "codex", ...unreadable }),
        writeStatus: () => {}, spawnOpenWeight,
      },
    } as never).catch(() => {});
    assert.equal(seen.at(-1), true, "the blocked-auction fallback is the one path that claims it");

    // DISCRIMINATION: both paths reached the adapter, so (a) proves a path that RAN and declined
    // the raise — not a path that never got there.
    assert.equal(seen.length, 2, "both paths must actually reach the cash adapter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
