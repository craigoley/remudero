// test/interactive-reads-use-the-app-budget.test.ts — W1-T4085: INTERACTIVE READS SPEND THE
// OPERATOR'S OWN GITHUB BUDGET.
//
// hooks/deny-floor.sh rule 9's 180s read cadence (W1-T3275) is deliberately SHARED by every
// session on the host — GitHub's secondary rate limit counts per USER across every process, so
// pooling it is correct. But that also means one session's legitimate read gets refused behind
// another session's read, seconds earlier and nothing to do with it. OBSERVED 2026-09-22: two
// interactive sessions, single reads refused "0s after the last one" repeatedly, escaped only by
// the on-the-record override `RMD_GH_COOLDOWN_S=0`, spent several times in one session.
//
// design (i)/(ii)/(iii) from plan/tasks.d/W1-T4085-…yaml:
//   (i)   an interactive READ mints a fresh installation token and rides it, paced on a SEPARATE
//         stamp (never the shared one, and never the `search` bucket either).
//   (ii)  a WRITE never even attempts a mint — authorship matters, and it is already exempt from
//         cadence entirely.
//   (iii) a failed mint is not an error: the call falls straight back to today's shared floor.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";
import {
  GH_APP_READ_BUCKET,
  GH_SEARCH_BUCKET,
  ghInteractiveRead,
  ghReadCadenceStampPath,
  readGhReadCadenceStampMs,
  routeInteractiveGhRead,
  type GhAppTokenMint,
} from "../src/lib/github-transport.js";

function withCache(fn: (env: NodeJS.ProcessEnv) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-interactive-read-`));
  return Promise.resolve(fn({ XDG_CACHE_HOME: dir } as NodeJS.ProcessEnv)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

// ── (i) A READ RIDES THE APP TOKEN, ON ITS OWN STAMP ─────────────────────────────────────────

test("W1-T4085: an interactive read rides the app budget", async () => {
  await withCache(async (env) => {
    let mintCalls = 0;
    const route = await routeInteractiveGhRead(["pr", "view", "123"], {
      env,
      warn: () => {},
      mint: async (): Promise<GhAppTokenMint> => {
        mintCalls += 1;
        return { ok: true, token: "ghs_minted_app_token" };
      },
    });
    assert.equal(mintCalls, 1, "a read must attempt exactly one mint");
    assert.equal(route.usesAppToken, true);
    assert.deepEqual(route.envOverlay, { GH_TOKEN: "ghs_minted_app_token" }, "the caller must see the minted token");
    assert.equal(route.decision.allow, true, "the FIRST app-routed read must never be refused");

    // ON ITS OWN STAMP — never the shared one, and never the `search` bucket either, so a burst of
    // app-routed reads can never collide with `search`'s own far-lower ceiling.
    const appStamp = ghReadCadenceStampPath(env, GH_APP_READ_BUCKET) as string;
    const sharedStamp = ghReadCadenceStampPath(env) as string;
    const searchStamp = ghReadCadenceStampPath(env, GH_SEARCH_BUCKET) as string;
    assert.notEqual(readGhReadCadenceStampMs(appStamp), undefined, "the app bucket must be stamped");
    assert.equal(readGhReadCadenceStampMs(sharedStamp), undefined, "the shared user stamp must stay untouched");
    assert.equal(readGhReadCadenceStampMs(searchStamp), undefined, "the search bucket must stay untouched");

    // A SECOND session's read, still inside the shared window, is entirely unaffected — the whole
    // point of the separate stamp is that it never fights the shared budget for the same slot.
    const second = await routeInteractiveGhRead(["pr", "checks", "124"], {
      env,
      warn: () => {},
      mint: async (): Promise<GhAppTokenMint> => ({ ok: true, token: "ghs_minted_app_token_2" }),
    });
    assert.equal(second.usesAppToken, true);
    assert.equal(second.decision.allow, true, "a second app-routed read must not be paced against the shared window");
  });
});

// ── (ii) WRITES KEEP THE USER IDENTITY ───────────────────────────────────────────────────────

test("W1-T4085: writes keep the user identity", async () => {
  await withCache(async (env) => {
    let mintCalls = 0;
    const route = await routeInteractiveGhRead(["pr", "create", "--title", "x", "--body", "y"], {
      env,
      warn: () => {},
      mint: async (): Promise<GhAppTokenMint> => {
        mintCalls += 1;
        return { ok: true, token: "should-never-be-minted-for-a-write" };
      },
    });
    // NOT MERELY UNUSED — NEVER EVEN ATTEMPTED. Authorship matters: a write posted under the app's
    // identity would misattribute it, so the mint must not run at all for a write-shaped call.
    assert.equal(mintCalls, 0, "a write must never attempt a mint");
    assert.equal(route.usesAppToken, false);
    assert.deepEqual(route.envOverlay, {}, "a write's env overlay must be empty — the ambient identity is kept");
    assert.equal(route.decision.allow, true, "a write is exempt from cadence and must never be refused");

    // The budget probe (`gh api rate_limit`) is likewise identity-exempt.
    const probe = await routeInteractiveGhRead(["api", "rate_limit"], {
      env,
      warn: () => {},
      mint: async (): Promise<GhAppTokenMint> => {
        mintCalls += 1;
        return { ok: true, token: "still-should-not-be-minted" };
      },
    });
    assert.equal(mintCalls, 0, "the cadence-exempt budget probe must never attempt a mint either");
    assert.equal(probe.usesAppToken, false);
    assert.deepEqual(probe.envOverlay, {});
  });
});

// ── (iii) A FAILED MINT FALLS BACK TO THE SHARED FLOOR ───────────────────────────────────────

test("W1-T4085: a failed mint falls back to the shared floor", async () => {
  await withCache(async (env) => {
    const route = await routeInteractiveGhRead(["pr", "view", "123"], {
      env,
      warn: () => {},
      mint: async (): Promise<GhAppTokenMint> => ({ ok: false }),
    });
    assert.equal(route.usesAppToken, false);
    assert.deepEqual(route.envOverlay, {}, "no token to overlay when the mint failed");
    assert.equal(route.decision.allow, true, "the first read on an unconfigured host must still be allowed");

    // THE SHARED STAMP, NOT THE APP ONE, moved — this call spent exactly what it would have spent
    // before this task existed, byte-identical (design iii).
    const sharedStamp = ghReadCadenceStampPath(env) as string;
    const appStamp = ghReadCadenceStampPath(env, GH_APP_READ_BUCKET) as string;
    assert.notEqual(readGhReadCadenceStampMs(sharedStamp), undefined, "the shared floor's stamp must move");
    assert.equal(readGhReadCadenceStampMs(appStamp), undefined, "the app bucket must never be touched by a failed mint");

    // A mint that THROWS degrades identically — never an unhandled rejection, never a worse outcome
    // than an ordinary read.
    const threw = await routeInteractiveGhRead(["pr", "view", "125"], {
      env,
      warn: () => {},
      mint: async (): Promise<GhAppTokenMint> => {
        throw new Error("network unreachable");
      },
    });
    assert.equal(threw.usesAppToken, false);
    assert.deepEqual(threw.envOverlay, {});
  });
});

// ── THE DEFAULT MINTER, UNCONFIGURED (the shape every dev machine hits) ──────────────────────

test("W1-T4085: the default minter is not an attempt on a host with no GH_APP_* configured", async () => {
  await withCache(async (env) => {
    // No mint injected at all — drives the REAL default minter, which delegates to
    // github-app.ts's refreshInstallationToken. Absent GH_APP_ID/GH_APP_INSTALLATION_ID/
    // GH_APP_PRIVATE_KEY_PATH that returns `{ ok: false }` with no network reached, so this must
    // behave exactly like test 3 above: fall back to the shared floor.
    const route = await routeInteractiveGhRead(["pr", "view", "123"], { env, warn: () => {} });
    assert.equal(route.usesAppToken, false);
    assert.deepEqual(route.envOverlay, {});
    assert.equal(route.decision.allow, true);
  });
});

// ── THE WIRED ENTRY POINT REALLY SPAWNS gh WITH THE ROUTED IDENTITY ─────────────────────────

test("W1-T4085: ghInteractiveRead spawns gh carrying the minted token", async () => {
  await withCache(async (env) => {
    // The shared shim echoes its stdout inside double quotes, so `$GH_TOKEN` prints the identity
    // the child process actually received.
    const shim = ghShim([{ when: "pr view 7", stdout: "$GH_TOKEN" }], { kind: "gh-interactive-read" });
    try {
      const out = await ghInteractiveRead(["pr", "view", "7"], {
        encoding: "utf8",
        env: { ...env, PATH: `${shim.dir}:${process.env.PATH ?? ""}` },
        deps: { env, warn: () => {}, mint: async () => ({ ok: true, token: "ghs_minted_for_spawn" }) },
      });
      assert.equal(String(out).trim(), "ghs_minted_for_spawn");
      assert.deepEqual(shim.calls(), ["pr view 7"]);
    } finally {
      rmSync(shim.dir, { recursive: true, force: true });
    }
  });
});
