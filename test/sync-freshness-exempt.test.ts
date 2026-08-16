import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/run-task.js";

// ── W1-T907: `rmd sync` IS THE VERB THAT UNSTICKS THE STATE THE GATE REFUSES ─────────────────
//
// `main()`'s entry gate calls `checkCliFreshness`, which refuses when the checkout is BEHIND
// origin/main *and* DIRTY, and turns that into `process.exit(1)` before any verb is dispatched.
// `rmd sync` exists precisely to resolve behind-and-dirty, so gating it behind that refusal would
// mean it could only ever run when it had nothing left to do — the same circular refusal
// test/deploy-run-freshness-exempt.test.ts pins for `deploy-run`.
//
// The exemption is a bare `else if (cmd === "sync")` branch in `main()`, so the ONLY way to
// execute that line is to call `main()` itself. Its own file, per CLAUDE.md's coverage rule.
//
// SAFETY: argv carries a deliberately invalid flag. The gate chain runs BEFORE dispatch, so the
// exemption line is evaluated either way, while `syncCommand`'s own `unknownArgError` guard then
// exits 2 without reaching `runOperatorSync` — no fetch, no discard, nothing touched on disk.

class ProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const REFUSED_BEHIND_AND_DIRTY = () =>
  ({
    status: "refused" as const,
    reason: "dirty" as const,
    message:
      "rmd is behind origin/main (e9fa9ac..97e6857) and the working tree has uncommitted " +
      "changes -- refusing to auto-sync (never mutating uncommitted local state).",
  });

async function runVerbUnderRefusal(
  t: { mock: { method: typeof import("node:test").mock.method } },
  argv: string[],
): Promise<{ exited: boolean; code?: number; errs: string[]; gateRefused: boolean }> {
  const errs: string[] = [];
  t.mock.method(process, "exit", ((code?: number): never => {
    throw new ProcessExitCalled(code);
  }) as typeof process.exit);
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
    return {
      exited,
      code: exited ? (caught as ProcessExitCalled).code : undefined,
      errs,
      gateRefused: errs.some((e) => e.includes("refusing to auto-sync")),
    };
  } finally {
    process.argv = originalArgv;
  }
}

test("W1-T907: `rmd sync` on a behind-and-dirty checkout is NOT refused by the entry gate", async (t) => {
  const r = await runVerbUnderRefusal(t, ["sync", "--not-a-real-flag"]);

  assert.equal(
    r.gateRefused,
    false,
    `the freshness refusal must not fire for sync; stderr was ${JSON.stringify(r.errs)}`,
  );
  // Execution really continued into the verb rather than stopping at the gate: syncCommand's own
  // argument guard answered instead, which it can only do from past the gate.
  assert.ok(r.exited, "main() still exits — through the verb, not through the gate");
  assert.equal(r.code, 2, "and with syncCommand's own unknown-argument code");
  assert.ok(
    r.errs.some((e) => e.includes("--not-a-real-flag")),
    "the message names the bad flag, proving the dispatch was reached",
  );
});

test("REGRESSION LOCK: a plan-reading verb still refuses on the same checkout — the gate was narrowed, not removed", async (t) => {
  // The falsifier for the test above. Without it, a gate that had been deleted outright would
  // pass exactly the same assertions.
  const r = await runVerbUnderRefusal(t, ["lint-plan"]);

  assert.ok(r.exited, "lint-plan still exits at the gate");
  assert.equal(r.code, 1, "and exits 1, exactly as before");
  assert.ok(r.gateRefused, "the operator still gets the remedy message — a stale plan gives a wrong answer");
});
