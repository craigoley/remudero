import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/run-task.js";
import { treeFfSafe } from "../src/lib/deployer.js";

// ── THE CIRCULAR REFUSAL ─────────────────────────────────────────────────────────────
// `deploy-run` is the deploy supervisor's cycle — the com.remudero.supervisor launchd unit
// invokes it every 120s — and its whole purpose is to fast-forward a stale checkout. But
// `checkCliFreshness` refuses when the tree is BEHIND *and* DIRTY (self-sync.ts:164-176),
// and `main()`'s entry gate (run-task.ts:10890) turned that into `process.exit(1)` BEFORE
// `deployRunCommand` (run-task.ts:6278) was ever entered. The verb that exists to fix
// staleness was refused for being stale. Reproduced live:
//
//   rmd is behind origin/main (e9fa9ac..97e6857) and the working tree has uncommitted
//   changes -- refusing to auto-sync
//
// The ledger carries ZERO deploy.* events across the live file and all 661 rotations.
//
// The outer gate is redundant here because the deployer owns a strictly better one:
// `treeFfSafe` (deployer.ts:102) refuses only when a locally-modified path is ALSO in the
// incoming diff, and it sits directly in front of `pullFf()` (deployer.ts:236-251). The
// blunt gate fired first, which is why the precise one had never run.

class ProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** The exact shape `checkCliFreshness` returns for a behind-AND-dirty checkout. */
const REFUSED_BEHIND_AND_DIRTY = () =>
  ({
    status: "refused" as const,
    reason: "dirty",
    message:
      "rmd is behind origin/main (e9fa9ac..97e6857) and the working tree has uncommitted " +
      "changes -- refusing to auto-sync (never mutating uncommitted local state).",
  });

/** Drives `main()` for one verb with the freshness check pinned to the refusal, and reports
 *  whether the process exited (the gate fired) or execution continued into the verb. */
async function runVerbUnderRefusal(
  t: { mock: { method: typeof import("node:test").mock.method } },
  argv: string[],
): Promise<{ exited: boolean; code?: number; errs: string[]; reached: boolean }> {
  const errs: string[] = [];
  t.mock.method(
    process,
    "exit",
    ((code?: number): never => {
      throw new ProcessExitCalled(code);
    }) as typeof process.exit,
  );
  t.mock.method(console, "error", (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
  const originalArgv = process.argv;
  process.argv = ["node", "run-task.js", ...argv];
  try {
    let caught: unknown;
    await main({ checkFreshness: REFUSED_BEHIND_AND_DIRTY }).catch((e) => {
      caught = e;
    });
    const exited = caught instanceof ProcessExitCalled;
    const code = exited ? (caught as ProcessExitCalled).code : undefined;
    // The gate's refusal is identified by its own message. If execution got past the gate,
    // that message is absent — whatever happens later in the verb is a different failure.
    const gateRefused = errs.some((e) => e.includes("refusing to auto-sync"));
    return { exited, code, errs, reached: !gateRefused };
  } finally {
    process.argv = originalArgv;
  }
}

// ── VALIDATION 4: deploy-run ENTERS its own logic ────────────────────────────────────
test("deploy-run on a behind-and-dirty checkout is NOT refused by the entry gate — it reaches its own logic", async (t) => {
  const r = await runVerbUnderRefusal(t, ["deploy-run", "--dry-run"]);

  // THE ASSERTION THAT MATTERS: the gate's refusal message never appears, so execution
  // continued past run-task.ts:10890 into deployRunCommand rather than exiting there.
  assert.ok(
    r.reached,
    `the freshness refusal must NOT fire for deploy-run; stderr was ${JSON.stringify(r.errs)}`,
  );
  assert.ok(
    !r.errs.some((e) => e.includes("refusing to auto-sync")),
    "the circular refusal is gone",
  );
});

// ── VALIDATION 7: REGRESSION LOCK — every other verb still refuses ───────────────────
test("REGRESSION LOCK: a plan-reading verb still refuses on a behind-and-dirty checkout — the gate was narrowed, not removed", async (t) => {
  const r = await runVerbUnderRefusal(t, ["lint-plan"]);

  assert.ok(r.exited, "lint-plan still exits at the gate");
  assert.equal(r.code, 1, "and exits 1, exactly as before");
  assert.ok(
    r.errs.some((e) => e.includes("refusing to auto-sync")),
    "the operator still gets the remedy message — a stale plan gives a wrong answer",
  );
});

test("REGRESSION LOCK: `deploy` (the marker-writing operator trigger) is NOT exempted — only deploy-run is", async (t) => {
  const r = await runVerbUnderRefusal(t, ["deploy"]);

  assert.ok(r.exited, "`rmd deploy` still exits at the gate");
  assert.equal(r.code, 1);
  assert.ok(
    r.errs.some((e) => e.includes("refusing to auto-sync")),
    "deploy is an interactive operator trigger with a human present to act on the remedy",
  );
});

// ── VALIDATIONS 5 & 6: the guard that REPLACES the outer gate ───────────────────────
// After this change `treeFfSafe` is the only thing between a dirty tree and a bad
// fast-forward, so both directions of its predicate are pinned here.

test("deployer guard: a dirty path that IS in the incoming diff conflicts — this is what replaces the outer gate", () => {
  const r = treeFfSafe({
    dirtyFiles: ["src/lib/deployer.ts", "DECISIONS.md"],
    incomingFiles: ["src/lib/deployer.ts", "README.md"],
  });

  assert.equal(r.ok, false, "a locally-modified file that the fast-forward would overwrite must abort");
  assert.deepEqual(r.conflicting, ["src/lib/deployer.ts"], "and it names exactly the conflicting path");
});

test("deployer guard: a dirty path NOT in the incoming diff proceeds — the case blocked for five days", () => {
  // This is the live shape: the canonical checkout is dirty with the daemon's own writes
  // (DECISIONS.md, plan/feedback/*.yaml, state/) while the incoming diff touches src/.
  const r = treeFfSafe({
    dirtyFiles: ["DECISIONS.md", "plan/feedback/fb-1784770185732-e025c1.yaml"],
    incomingFiles: ["src/lib/sweep.ts", "test/sweep.test.ts"],
  });

  assert.equal(r.ok, true, "dirt that the fast-forward does not touch must NOT block the deploy");
  assert.deepEqual(r.conflicting, [], "nothing conflicts");
});
