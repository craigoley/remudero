import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArmSeamRequiredError,
  armAutoMerge,
  armAutoMergeAtOpen,
  armAutoMergeDetailed,
  armIfVerdictPermits,
  disarmAutoMerge,
  requireExplicitArmSeam,
  withdrawArmIfVerdictRefuses,
  type ArmDeps,
} from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

// ── W1-T2346's census (test/operator-gated-default-reachability.test.ts) named the population:
// `armAutoMerge`/`armAutoMergeDetailed`/`armAutoMergeAtOpen`/`disarmAutoMerge` each default a
// WHOLE `deps` parameter to `realArmDeps()`, and `armIfVerdictPermits`/`withdrawArmIfVerdictRefuses`
// each chain `deps.arm ?? armAutoMergeDetailed` / `deps.disarm ?? disarmAutoMerge`. A fixture that
// forgets the seam was therefore wired to the PRODUCTION dependency — a live REST head read and a
// read of this machine's own config/ledger — silently, with no refusal until (if ever) execution
// reached `assertLiveWriteAllowed`'s write-leaf fence, three reads too late.
//
// This file proves the fix: `requireExplicitArmSeam` (src/run-task.ts), consulted by every one of
// those entry points BEFORE `realArmDeps()` is even constructed, refuses under the node test
// runner unless a seam was explicitly supplied. Every test in this file runs UNDER `node --test`,
// so `isTestRunner()` is true throughout — exactly the condition the guard exists to police.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN_TASK_SRC = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");

const PR = "https://github.com/o/r/pull/1";
const TASK_ID = "W1-T2347";
const HEAD = "deadbeef";

function fakeArmDeps(over: Partial<ArmDeps> = {}): ArmDeps {
  return {
    headSha: () => HEAD,
    ledgerLines: () => [],
    armAuto: () => {},
    mergeDirect: () => {},
    disableAuto: () => {},
    say: () => {},
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 1 + 3 — reached with no seam under the test runner: REFUSES, names the entry point
// and the missing seam, rather than running the production dependency
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("armAutoMergeDetailed reached with no deps under the test runner refuses, naming itself", () => {
  assert.throws(
    () => armAutoMergeDetailed(PR, TASK_ID),
    (e: unknown) => {
      assert.ok(e instanceof ArmSeamRequiredError, "must throw the seam-required error, not something else");
      assert.match(e.message, /armAutoMergeDetailed/, "the message must name the entry point that was reached");
      assert.match(e.message, /no seam was supplied/, "the message must name what was missing");
      return true;
    },
  );
});

test("armAutoMerge reached with no deps refuses via the SAME check — forwarding does not construct a real default of its own first", () => {
  // armAutoMerge is a thin wrapper: it must forward an omitted `deps` through UNCHANGED so
  // armAutoMergeDetailed's own check sees the true omission, never a `deps: ArmDeps =
  // realArmDeps()` default on armAutoMerge's OWN signature already resolving to a real object
  // before the forward (which would defeat the callee's check by handing it an already-"supplied"
  // argument).
  assert.throws(
    () => armAutoMerge(PR, TASK_ID),
    (e: unknown) => e instanceof ArmSeamRequiredError && /armAutoMergeDetailed/.test((e as Error).message),
  );
});

test("armAutoMergeAtOpen reached with no deps under the test runner refuses, naming itself", () => {
  assert.throws(
    () => armAutoMergeAtOpen(PR),
    (e: unknown) => {
      assert.ok(e instanceof ArmSeamRequiredError);
      assert.match((e as Error).message, /armAutoMergeAtOpen/);
      return true;
    },
  );
});

test("armAutoMergeAtOpen refuses even on the irreversible-refused branch — the guard precedes EVERY branch, not just the one that arms", () => {
  // The irreversible short-circuit never touches a live dep (it only calls `deps.say`), but
  // `deps` itself must never be resolved to the real default under the test runner regardless of
  // which branch would run — resolving it at all is the thing this task ends being opt-out.
  assert.throws(() => armAutoMergeAtOpen(PR, undefined, true), ArmSeamRequiredError);
});

test("disarmAutoMerge reached with no deps under the test runner refuses, naming itself", () => {
  assert.throws(
    () => disarmAutoMerge(PR),
    (e: unknown) => {
      assert.ok(e instanceof ArmSeamRequiredError);
      assert.match((e as Error).message, /disarmAutoMerge/);
      return true;
    },
  );
});

test("armIfVerdictPermits: a PASSING verdict with no `arm` seam supplied refuses — `deps.arm ?? armAutoMergeDetailed` no longer hands a fixture the production arm", () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  assert.throws(
    () =>
      armIfVerdictPermits(
        { state: "success", capped: false, planOnly: false },
        { prUrl: PR, taskId: TASK_ID, headSha: HEAD, ledgerPath: "/nonexistent/ledger.ndjson", log: (step, extra) => logs.push({ step, extra }) },
        {},
      ),
    (e: unknown) => {
      assert.ok(e instanceof ArmSeamRequiredError, "the exact rationale-(1) call site must now refuse, not fall through");
      assert.match((e as Error).message, /armAutoMergeDetailed/);
      return true;
    },
  );
  // Never ledgered as a normal skip/arm — this is a THROW, not a silent alternate outcome.
  assert.deepEqual(logs, [], "no ledger row is written on this path; the refusal is a thrown error, never a swallowed one");
});

test("withdrawArmIfVerdictRefuses: a REFUSING verdict with no `disarm` seam supplied refuses — `deps.disarm ?? disarmAutoMerge` no longer hands a fixture the production disarm", () => {
  assert.throws(
    () =>
      withdrawArmIfVerdictRefuses(
        { state: "failure", capped: false, planOnly: false },
        { prUrl: PR, taskId: TASK_ID, headSha: HEAD, ledgerPath: "/nonexistent/ledger.ndjson", log: () => {} },
        {},
      ),
    (e: unknown) => e instanceof ArmSeamRequiredError && /disarmAutoMerge/.test((e as Error).message),
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 2 — the refusal fires before the live head read and before the config/ledger read:
// proven DYNAMICALLY, not merely by reading source — a PATH-stubbed `gh` that would record any
// invocation, and a scratch $HOME with no config.json that loadConfig() would have to CREATE if
// it ever ran, both stay untouched.
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("real tree: the refusal fires before any live gh read and before the ambient config/ledger is ever touched", () => {
  const binDir = mkdtempSync(join(tmpdir(), "rmd-arm-seam-bin-"));
  const homeDir = mkdtempSync(join(tmpdir(), "rmd-arm-seam-home-"));
  const ghMarker = join(binDir, "gh-was-invoked");
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  try {
    // A `gh` that would answer ANY call successfully, so a real reach would never merely fail
    // fast for lack of a stub — it would proceed exactly as it would against the real binary,
    // recording that it happened. If the guard ever ran too late, this file would exist after.
    writeFileSync(
      join(binDir, "gh"),
      `#!/bin/sh\necho "$@" >> "${ghMarker}"\necho '{"sha":"${HEAD}"}'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${oldPath}`;
    // A FRESH $HOME with no ~/.config/remudero/config.json: loadConfig() unconditionally CREATES
    // one (the exclusive-create branch, src/lib/config.ts) the moment it is ever called with no
    // existing file to read — so its absence afterwards is direct evidence loadConfig() never ran,
    // not an inference from a stack trace.
    process.env.HOME = homeDir;

    // A truthy taskId, deliberately — armAutoMergeDetailed's OWN `!taskId` short-circuit returns
    // before `deps.headSha`/`deps.ledgerLines` even with the OLD (pre-W1-T2347) code, so a falsy
    // taskId would prove nothing about ordering. This taskId would reach both live reads today
    // were `realArmDeps()` ever actually constructed.
    assert.throws(() => armAutoMergeDetailed(PR, TASK_ID), ArmSeamRequiredError);

    assert.ok(!existsSync(ghMarker), "gh must never have been invoked — the live head read never fired");
    assert.ok(
      !existsSync(join(homeDir, ".config", "remudero", "config.json")),
      "loadConfig() must never have run — the ambient config/ledger read never fired",
    );
  } finally {
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 4 — supplying the seam reaches the injected arm exactly as it does today
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("armAutoMergeDetailed with an explicit deps object reaches it, never the guard", () => {
  const calls: string[] = [];
  const deps = fakeArmDeps({
    headSha: () => { calls.push("headSha"); return HEAD; },
    ledgerLines: () => { calls.push("ledgerLines"); return []; },
  });
  const result = armAutoMergeDetailed(PR, TASK_ID, deps);
  assert.deepEqual(calls, ["headSha", "ledgerLines"], "the injected deps were reached, in the documented order");
  assert.equal(result.outcome, "ledger-refused", "no review.posted line in the injected ledger — same behaviour as before this task");
});

test("armAutoMergeAtOpen with an explicit narrowed deps object reaches it — the SAME shape test/arm-at-open.test.ts already drives", () => {
  let armed = 0;
  const outcome = armAutoMergeAtOpen(PR, {
    armAuto: () => void armed++,
    mergeDirect: () => assert.fail("no direct merge in this fixture"),
    isMerged: () => false,
    say: () => {},
  });
  assert.equal(outcome, "armed");
  assert.equal(armed, 1);
});

test("disarmAutoMerge with an explicit deps object reaches it", () => {
  let disabled = 0;
  const outcome = disarmAutoMerge(PR, { disableAuto: () => void disabled++, say: () => {} });
  assert.equal(outcome, "disarmed");
  assert.equal(disabled, 1);
});

test("armIfVerdictPermits with an explicit `arm` seam reaches it, never armAutoMergeDetailed's default", () => {
  const armCalls: Array<{ prUrl: string; taskId: string }> = [];
  const outcome = armIfVerdictPermits(
    { state: "success", capped: false, planOnly: false },
    { prUrl: PR, taskId: TASK_ID, headSha: HEAD, ledgerPath: "/nonexistent/ledger.ndjson", log: () => {} },
    { arm: (prUrl, taskId) => { armCalls.push({ prUrl, taskId }); return "armed"; } },
  );
  assert.equal(outcome, "armed");
  assert.deepEqual(armCalls, [{ prUrl: PR, taskId: TASK_ID }]);
});

test("withdrawArmIfVerdictRefuses with an explicit `disarm` seam reaches it, never disarmAutoMerge's default", () => {
  const disarmCalls: string[] = [];
  const withdrawn = withdrawArmIfVerdictRefuses(
    { state: "failure", capped: false, planOnly: false },
    { prUrl: PR, taskId: TASK_ID, headSha: HEAD, ledgerPath: "/nonexistent/ledger.ndjson", log: () => {} },
    { disarm: (prUrl) => { disarmCalls.push(prUrl); return "disarmed"; } },
  );
  assert.equal(withdrawn, true);
  assert.deepEqual(disarmCalls, [PR]);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 5 — a section wrapped in withLiveWritesAllowed still reaches the production default
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("wrapped in withLiveWritesAllowed, armAutoMergeDetailed with no deps reaches the REAL realArmDeps() rather than refusing", () => {
  // `taskId` is deliberately `undefined`: the real armAutoMergeDetailed's OWN `!taskId`
  // short-circuit returns before any live REST/gh call, so this proves the exemption let
  // `realArmDeps()` be constructed and reached WITHOUT this test itself needing to drive an
  // actual network call or `gh` binary to observe it safely.
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (msg?: unknown) => { logged.push(String(msg)); };
  try {
    const outcome = withLiveWritesAllowed(() => armAutoMergeDetailed(PR, undefined));
    assert.equal(outcome.outcome, "no-task-id");
    // The REAL realArmDeps().say is exactly `(msg) => console.log(msg)` — a fake deps object
    // never touches the real console.log, so this line is only ever produced by the production
    // default actually having been constructed and reached.
    assert.ok(
      logged.some((l) => l.includes("no task id resolvable")),
      `expected the real realArmDeps() console.log say to fire; got: ${JSON.stringify(logged)}`,
    );
  } finally {
    console.log = originalLog;
  }
});

test("REGRESSION LOCK: the SAME call with no withLiveWritesAllowed wrapper still refuses", () => {
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (msg?: unknown) => { logged.push(String(msg)); };
  try {
    assert.throws(() => armAutoMergeDetailed(PR, undefined), ArmSeamRequiredError);
    assert.deepEqual(logged, [], "nothing from the real default ever ran — the guard fired first");
  } finally {
    console.log = originalLog;
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 6 — outside the node test runner, the guard returns immediately and the production
// arm path is unchanged
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("requireExplicitArmSeam: no seam supplied, but NODE_TEST_CONTEXT absent — a real daemon/operator process — never throws", () => {
  const REAL_RUN: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/x" };
  assert.doesNotThrow(() => requireExplicitArmSeam("armAutoMergeDetailed", false, REAL_RUN));
});

test("requireExplicitArmSeam: a seam IS supplied — never throws, regardless of runner", () => {
  const TEST_RUN: NodeJS.ProcessEnv = { NODE_TEST_CONTEXT: "child-v8" };
  assert.doesNotThrow(() => requireExplicitArmSeam("armAutoMergeDetailed", true, TEST_RUN));
});

test("requireExplicitArmSeam: RMD_ALLOW_LIVE_WRITES=1 exempts a whole process, the SAME override assertLiveWriteAllowed already honours", () => {
  const OPTED: NodeJS.ProcessEnv = { NODE_TEST_CONTEXT: "child-v8", RMD_ALLOW_LIVE_WRITES: "1" };
  assert.doesNotThrow(() => requireExplicitArmSeam("armAutoMergeDetailed", false, OPTED));
});

test("real tree: with NODE_TEST_CONTEXT deliberately absent, armAutoMergeDetailed with no deps does NOT throw — production wiring is byte-identical", () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    // `taskId` undefined, for the same network-safety reason as acceptance 5's test above —
    // this proves the GUARD is inert outside the test runner, not that it is safe to drive a
    // live effect from this suite.
    const outcome = armAutoMergeDetailed(PR, undefined);
    assert.equal(outcome.outcome, "no-task-id", "the real default was reached and ran its own logic unchanged");
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACCEPTANCE 7 (structural insurance; the authoritative proof is `grep: requireExplicitArmSeam(
// in src/run-task.ts`) — every LEVEL-1 entry point's own body calls the guard, so a future edit
// that quietly drops the call is caught here too, not only by the grep.
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("structural: every LEVEL-1 arm/disarm entry point's body calls requireExplicitArmSeam", () => {
  for (const name of ["armAutoMergeDetailed", "armAutoMergeAtOpen", "disarmAutoMerge"]) {
    const fnIdx = RUN_TASK_SRC.indexOf(`export function ${name}(`);
    assert.ok(fnIdx >= 0, `sanity: ${name} is still declared`);
    const nextFnIdx = RUN_TASK_SRC.indexOf("\nexport function ", fnIdx + 1);
    const body = RUN_TASK_SRC.slice(fnIdx, nextFnIdx === -1 ? undefined : nextFnIdx);
    assert.match(body, new RegExp(`requireExplicitArmSeam\\(\\s*"${name}"`), `${name} must consult requireExplicitArmSeam, naming itself`);
  }
});
