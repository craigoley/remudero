// test/the-first-board-read-waits-for-the-first-mint.test.ts — W1-T2554.
//
// `startInstallationTokenRefresh` (src/lib/github-app.ts) used to end on a bare, unawaited
// `tick()` and return `{ armed: true }` before that first mint's promise had settled — so
// `run-task.ts`'s call site fell straight through into the daemon's first board sweep with
// `process.env.GH_TOKEN` still whatever it was before boot. MEASURED on this fleet 2026-09-01:
// the mint landed 1.899s AFTER the first board fetch had already failed `auth`.
//
// THE FIX (github-app.ts's own `ready` doc): `startInstallationTokenRefresh` now also returns
// `ready`, a promise that settles once the FIRST mint has resolved (or failed-and-been-logged) —
// present only when `armed`, and never itself rejecting. `run-task.ts`'s `daemonCommand` awaits it
// before doing anything else. Every test below drives the SAME recorded-sequence shape the
// rationale calls for: a shared `order` (or `calls`) array that a GitHub-call stub and the mint
// both push onto, so the assertion is about ORDER, not just "did both things eventually happen".
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GH_APP_ID_ENV,
  GH_APP_INSTALLATION_ID_ENV,
  GH_APP_PRIVATE_KEY_PATH_ENV,
  startInstallationTokenRefresh,
} from "../src/lib/github-app.js";

const CONFIGURED_ENV = {
  [GH_APP_ID_ENV]: "1",
  [GH_APP_INSTALLATION_ID_ENV]: "2",
  [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem",
};

/**
 * Simulates the daemon's own call-site shape: arm the refresher, await `ready` when present
 * (exactly what `run-task.ts`'s `daemonCommand` now does), then make a "board read" call. Every
 * event — the mint settling, the board call firing — is pushed onto `order` so the test can
 * assert the SEQUENCE, not merely that both eventually ran (rationale: "the boot ordering is
 * asserted from the recorded sequence, so a mint that lands second fails the test").
 */
async function bootAndReadBoard(
  order: string[],
  opts: {
    env?: Record<string, string | undefined>;
    refresh?: Parameters<typeof startInstallationTokenRefresh>[0]["refresh"];
    setTimer?: Parameters<typeof startInstallationTokenRefresh>[0]["setTimer"];
  } = {},
): Promise<{ armed: boolean }> {
  const res = startInstallationTokenRefresh({
    log: () => {},
    env: opts.env ?? CONFIGURED_ENV,
    refresh: opts.refresh,
    setTimer: opts.setTimer ?? (() => ({})),
  });
  if (res.ready) {
    await res.ready;
  }
  order.push("board_read");
  return { armed: res.armed };
}

test("W1-T2554: no GitHub call is made before the first installation-token mint resolves, when the App is armed", async () => {
  const order: string[] = [];
  let resolveMint!: () => void;
  const mintStarted = new Promise<void>((resolve) => {
    resolveMint = resolve;
  });

  const refresh = async () => {
    order.push("mint_start");
    // Yield a few microtask turns before resolving, so a caller that does NOT actually await
    // `ready` would race ahead and push "board_read" first — this is the falsifier's shape.
    await Promise.resolve();
    await Promise.resolve();
    order.push("mint_resolved");
    resolveMint();
    return { ok: true, expiresAtMs: Date.now() + 60 * 60 * 1000 };
  };

  await bootAndReadBoard(order, { refresh });
  await mintStarted;

  assert.deepEqual(
    order,
    ["mint_start", "mint_resolved", "board_read"],
    "the board read must not happen until the mint has resolved",
  );
});

test("W1-T2554: the boot ordering is asserted from the recorded sequence, so a mint that lands second fails the test", async () => {
  // A DELIBERATELY BROKEN "fix" that fires the board read from a stray timer instead of awaiting
  // `ready` — proves the assertion above is sensitive to ORDER, not just to both events occurring.
  const order: string[] = [];
  const refresh = async () => {
    await Promise.resolve();
    order.push("mint_resolved");
    return { ok: true, expiresAtMs: Date.now() + 60 * 60 * 1000 };
  };

  // Simulate a caller that does NOT wait for `ready` — the pre-fix shape this task closes.
  const res = startInstallationTokenRefresh({
    log: () => {},
    env: CONFIGURED_ENV,
    refresh,
    setTimer: () => ({}),
  });
  void res.ready; // deliberately unawaited, mirroring the bare `tick()` this task removes
  order.push("board_read");
  await new Promise((r) => setImmediate(r));

  assert.notDeepEqual(
    order,
    ["mint_resolved", "board_read"],
    "an unawaited ready races the board read ahead of the mint — this is the pre-fix defect",
  );
  assert.deepEqual(order, ["board_read", "mint_resolved"], "board_read fires first when ready is not awaited");
});

test("W1-T2554: a host with no GH_APP_* names still returns armed false and waits for nothing", async () => {
  const order: string[] = [];
  let refreshes = 0;
  const result = await bootAndReadBoard(order, {
    env: {},
    refresh: async () => {
      refreshes += 1;
      return { ok: true, expiresAtMs: 0 };
    },
  });

  assert.equal(result.armed, false, "an unconfigured host must not report armed");
  assert.equal(refreshes, 0, "no mint is attempted when the App is not configured");
  assert.deepEqual(order, ["board_read"], "the board read proceeds immediately — nothing to wait for");
});

test("W1-T2554: a mint that REJECTS does not hang the daemon — it proceeds and the failure is logged, not swallowed", async () => {
  const order: string[] = [];
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const res = startInstallationTokenRefresh({
    log: (step, extra = {}) => logs.push({ step, extra }),
    env: CONFIGURED_ENV,
    refresh: async () => {
      order.push("mint_rejected");
      throw new Error("token exchange blew up");
    },
    setTimer: () => ({}),
  });

  assert.equal(res.armed, true);
  assert.ok(res.ready, "an armed refresher must expose a ready promise");

  // The await below must settle (not hang) even though the underlying mint rejected.
  await res.ready;
  order.push("board_read");

  assert.deepEqual(order, ["mint_rejected", "board_read"], "the daemon proceeds past a rejected mint");
  const failureLine = logs.find((l) => l.step === "github_app.token_refresh_failed");
  assert.ok(failureLine, "a rejected mint must still be ledgered, not silently swallowed");
  assert.match(String(failureLine!.extra.reason), /refresh threw:/);
});

test("W1-T2554: a mint that resolves { ok: false } (no throw) also does not hang the daemon", async () => {
  const order: string[] = [];
  const res = startInstallationTokenRefresh({
    log: () => {},
    env: CONFIGURED_ENV,
    refresh: async () => {
      order.push("mint_failed");
      return { ok: false, reason: "exchange rejected: 403" };
    },
    setTimer: () => ({}),
  });

  assert.equal(res.armed, true);
  await res.ready;
  order.push("board_read");

  assert.deepEqual(order, ["mint_failed", "board_read"]);
});

test("W1-T2554: restoring the bare unawaited tick() makes the ordering assertion fail — the falsifier is load-bearing", async () => {
  // A faithful re-creation of the PRE-FIX shape: `tick()` fired and discarded, `{ armed: true }`
  // returned immediately with no `ready` for the caller to wait on. Proves the test in this file
  // actually depends on `ready` being present and awaited — remove that seam and this defends
  // nothing.
  function preFixStartRefresh(refresh: () => Promise<{ ok: boolean }>): { armed: boolean } {
    const tick = (): void => {
      void refresh();
    };
    tick();
    return { armed: true }; // no `ready` field — the bug this task fixes
  }

  const order: string[] = [];
  const refresh = async () => {
    await Promise.resolve();
    order.push("mint_resolved");
    return { ok: true };
  };

  const res = preFixStartRefresh(refresh) as { armed: boolean; ready?: Promise<void> };
  if (res.ready) {
    await res.ready;
  }
  order.push("board_read");
  await new Promise((r) => setImmediate(r));

  assert.notDeepEqual(
    order,
    ["mint_resolved", "board_read"],
    "the pre-fix shape (no `ready`) lets board_read race ahead of the mint — proves the falsifier bites",
  );
});

test("W1-T2554: the refresh timer is still armed for subsequent renewals, exactly as before", async () => {
  const delays: number[] = [];
  let unrefs = 0;
  const NOW = 1_700_000_000_000;
  const EXPIRES = NOW + 60 * 60 * 1000;

  const res = startInstallationTokenRefresh({
    log: () => {},
    env: CONFIGURED_ENV,
    refresh: async () => ({ ok: true, expiresAtMs: EXPIRES }),
    setTimer: (_fn, ms) => {
      delays.push(ms);
      return {
        unref: () => {
          unrefs += 1;
        },
      };
    },
    now: () => NOW,
  });

  assert.equal(res.armed, true);
  await res.ready;

  assert.equal(delays.length, 1, "the next renewal is still scheduled after the awaited first mint");
  assert.equal(unrefs, 1, "the scheduled renewal timer must still be unref'd so it never holds the process open");
});

// W1-T2554 — the RENEWAL itself, not just that a timer was scheduled. The test above captures the
// delay and the unref but never INVOKES the callback the timer was handed, so `tick`'s own body
// (`void runOnce()`) has no covering test: `diff-coverage` blocked this PR naming exactly that one
// line, src/lib/github-app.ts's `tick` arrow. Covering it by invoking the captured callback is not
// coverage theatre — it is the only assertion in this file that the loop RENEWS rather than minting
// once and stopping, which is the behaviour `ready` must not have broken when it was factored out
// of `tick` to be returnable.
test("W1-T2554: invoking the scheduled callback mints AGAIN and re-arms — the renewal loop, not just its first turn", async () => {
  const NOW = 1_700_000_000_000;
  const EXPIRES = NOW + 60 * 60 * 1000;
  let mints = 0;
  const scheduled: Array<() => void> = [];

  const res = startInstallationTokenRefresh({
    log: () => {},
    env: CONFIGURED_ENV,
    refresh: async () => {
      mints += 1;
      return { ok: true, expiresAtMs: EXPIRES };
    },
    setTimer: (fn, _ms) => {
      scheduled.push(fn);
      return { unref: () => {} };
    },
    now: () => NOW,
  });

  await res.ready;
  assert.equal(mints, 1, "the awaited first mint has happened and no more");
  assert.equal(scheduled.length, 1, "and exactly one renewal is pending");

  // Fire the timer the way the runtime would. `tick` returns void and swallows the promise, so the
  // renewal is observed by draining the microtask queue rather than by awaiting a returned handle.
  scheduled[0]!();
  await new Promise((r) => setImmediate(r));

  assert.equal(mints, 2, "firing the scheduled callback mints again — the loop renews");
  assert.equal(scheduled.length, 2, "and re-arms itself, so renewal is not a one-shot");
});
