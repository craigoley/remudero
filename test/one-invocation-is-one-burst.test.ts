import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_GH_READ_BURST,
  GhReadCadenceRefusal,
  applyGhReadCadence,
  ghReadBurst,
  ghReadCadenceStampPath,
  stampGhRead,
  withDaemonGhTransportFloor,
  withGhTransportFloor,
} from "../src/lib/github-transport.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// `withGhTransportFloor`'s own doc calls it a "standalone" command wrapper, and the per-read floor
// only makes sense under that assumption: one invocation, one read. `rmd review` — the ONLY command
// that wrapper has ever been applied to — makes TWELVE reads, measured on a live invocation. So the
// floor refused the verb's own second read four seconds in, every time.
//
// It protected nothing. Its sole caller was the only thing it ever refused, and the documented
// escape (`RMD_GH_TRANSPORT_FLOOR=advisory`) disables the floor for the WHOLE process, which is
// strictly broader than the verb needs. What the floor is really for is defeating a POLLING LOOP,
// and that is spacing between INVOCATIONS — so the first read of an invocation is still gated at
// the full window, and only then is a bounded burst granted.

const READ = ["api", "repos/o/r"] as const;

function sandbox(): { dir: string; env: NodeJS.ProcessEnv; stamp: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-burst-`));
  const env = { XDG_CACHE_HOME: dir, RMD_GH_TRANSPORT_FLOOR: "enforce" } as NodeJS.ProcessEnv;
  const stamp = ghReadCadenceStampPath(env) as string;
  return { dir, env, stamp };
}

/** Put the window well behind, so the NEXT read is admitted and may open a burst. */
function windowOpen(stamp: string): void {
  stampGhRead(stamp);
  const past = Math.floor(Date.now() / 1000) - 5_000;
  utimesSync(stamp, past, past);
}

/** Put the window just behind, so the next read is INSIDE it and must be gated. */
function windowClosed(stamp: string): void {
  stampGhRead(stamp);
  const recent = Math.floor(Date.now() / 1000) - 5;
  utimesSync(stamp, recent, recent);
}

test("THE DEFECT: a second read inside one invocation is admitted rather than refused", async () => {
  const { dir, env, stamp } = sandbox();
  try {
    await withGhTransportFloor(() => {
      windowOpen(stamp);
      applyGhReadCadence([...READ], { env, warn: () => {} }); // gated, admitted, opens the burst
      // Before this change the line below threw four seconds after the line above, which is what
      // made `rmd review` unable to complete at its own default setting.
      for (let i = 0; i < 11; i += 1) {
        applyGhReadCadence([...READ], { env, warn: () => {} });
      }
    }, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the burst is BOUNDED — a read past it is refused again, so a polling loop still cannot run", async () => {
  const { dir, env, stamp } = sandbox();
  try {
    await withGhTransportFloor(() => {
      windowOpen(stamp);
      applyGhReadCadence([...READ], { env, warn: () => {} });
      for (let i = 0; i < DEFAULT_GH_READ_BURST; i += 1) {
        applyGhReadCadence([...READ], { env, warn: () => {} });
      }
      // The budget is spent and the window is now recent (every admitted read re-stamps), so the
      // floor applies again. This is the half that keeps the guard real.
      assert.throws(() => applyGhReadCadence([...READ], { env }), GhReadCadenceRefusal);
    }, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NO SCOPE, NO BURST — a direct call outside any floor wrapper behaves exactly as before", () => {
  const { dir, env, stamp } = sandbox();
  try {
    windowClosed(stamp);
    // The burst is owned by the wrapper's dynamic extent. Nothing here opened one, so nothing
    // bursts — which is why every pre-existing case in the sibling suite still passes untouched.
    assert.throws(() => applyGhReadCadence([...READ], { env }), GhReadCadenceRefusal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the FIRST read of an invocation is still gated, so spacing BETWEEN invocations survives", async () => {
  const { dir, env, stamp } = sandbox();
  try {
    windowClosed(stamp);
    await withGhTransportFloor(() => {
      // A fresh scope carries no budget: the burst is EARNED by an admitted read, never granted on
      // entry. Otherwise opening a scope would itself be the way around the floor.
      assert.throws(() => applyGhReadCadence([...READ], { env }), GhReadCadenceRefusal);
    }, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("neither a write nor an exempt read can buy a burst for the reads that follow", async () => {
  const { dir, env, stamp } = sandbox();
  try {
    await withGhTransportFloor(() => {
      windowClosed(stamp);
      applyGhReadCadence(["pr", "create", "--title", "x"], { env, warn: () => {} }); // a write
      applyGhReadCadence(["api", "rate_limit"], { env, warn: () => {} }); // exempt
      // Neither is charged against the limiter, so neither may open a burst — otherwise a loop
      // could prefix itself with a free call and read forever.
      assert.throws(() => applyGhReadCadence([...READ], { env }), GhReadCadenceRefusal);
    }, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nested scope cannot hand its parent a budget the parent never earned", async () => {
  const { dir, env, stamp } = sandbox();
  try {
    await withGhTransportFloor(async () => {
      await withDaemonGhTransportFloor(() => {
        windowOpen(stamp);
        applyGhReadCadence([...READ], { env, warn: () => {} });
      }, env);
      windowClosed(stamp);
      // The inner scope's budget died with it; the outer scope still has none of its own.
      assert.throws(() => applyGhReadCadence([...READ], { env }), GhReadCadenceRefusal);
    }, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the refusal names the wait AND the override, because re-running makes it strictly worse", () => {
  const { dir, env, stamp } = sandbox();
  try {
    windowClosed(stamp);
    assert.throws(
      () => applyGhReadCadence([...READ], { env }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /wait \d+s/, "the refusal must name how long to wait");
        assert.match(message, /RMD_GH_TRANSPORT_FLOOR=advisory/, "and the documented override");
        assert.match(message, /Re-running sooner spends another read/, "and why retrying is worse");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed burst override falls back to the default rather than reading as unlimited", () => {
  assert.equal(ghReadBurst({ RMD_GH_READ_BURST: "not-a-number" } as NodeJS.ProcessEnv), DEFAULT_GH_READ_BURST);
  assert.equal(ghReadBurst({ RMD_GH_READ_BURST: "-5" } as NodeJS.ProcessEnv), DEFAULT_GH_READ_BURST);
  assert.equal(ghReadBurst({} as NodeJS.ProcessEnv), DEFAULT_GH_READ_BURST);
  assert.equal(ghReadBurst({ RMD_GH_READ_BURST: "4" } as NodeJS.ProcessEnv), 4);
  // Zero is a REAL choice — it restores the pre-change per-read floor — so it must not be
  // swallowed by the fallback the way a typo is.
  assert.equal(ghReadBurst({ RMD_GH_READ_BURST: "0" } as NodeJS.ProcessEnv), 0);
});

test("the bound separates the two populations it was measured against", () => {
  // Sized as a SEPARATION, not a fit: `rmd review` needs 12 reads (measured live), a polling loop
  // needs hundreds. A bound sitting exactly on the observed value fires the first time a healthy
  // caller does one more read than it did last week.
  assert.ok(DEFAULT_GH_READ_BURST > 12, "must clear the only measured bounded verb");
  assert.ok(DEFAULT_GH_READ_BURST < 200, "must still refuse a loop quickly");
});
