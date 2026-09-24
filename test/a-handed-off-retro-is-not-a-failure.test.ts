// test/a-handed-off-retro-is-not-a-failure.test.ts — on 2026-09-23/24 four automated retros logged
// `daemon.retro_trigger.run_failed` (exit 1 "ci timeout — PR left OPEN", exit 2 "review failure" from a
// withheld verdict) after opening their PR; the sweep merged three of those PRs. A hand-off is its own
// outcome with its own reason; a red CI and a failed review still fail.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import type { ContainedProcess } from "../src/lib/worker-containment.js";
import {
  AutomatedRetroSubprocessError,
  RETRO_HANDOFF_EXIT_CODES,
  retroExitAfterPrOpened,
  runAutomatedRetroSubprocess,
} from "../src/lib/retro-subprocess.js";
import type { RetroTriggerDecision } from "../src/lib/retro.js";

const FIRED: Extract<RetroTriggerDecision, { fire: true }> = {
  fire: true,
  reason: "merges",
  mergesSinceMarker: 28,
  daysSinceMarker: 0.29,
  followupsPending: 0,
};

function exitingWith(code: number) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const run = runAutomatedRetroSubprocess(FIRED, {
    spawn: () => {
      queueMicrotask(() => child.emit("exit", code, null));
      return { process: child, pid: process.pid + 20_000 } as unknown as ContainedProcess;
    },
    teardown: () => {},
    log: (step, extra = {}) => rows.push({ step, extra }),
  });
  return { run, rows };
}

test("a retro whose PR is left to the sweep exits with a hand-off code, and a red one still fails", () => {
  assert.equal(retroExitAfterPrOpened("timeout"), 3);
  assert.equal(retroExitAfterPrOpened("freshness_handoff"), 3);
  assert.equal(retroExitAfterPrOpened("red"), 1);
  assert.equal(retroExitAfterPrOpened("green", 2), 4);
  assert.equal(retroExitAfterPrOpened("green", 1), 1);
  assert.equal(retroExitAfterPrOpened("green", 0), 0);
  assert.deepEqual(RETRO_HANDOFF_EXIT_CODES, { 3: "ci_not_concluded", 4: "review_withheld" });
});

test("a handed-off retro resolves and names its reason instead of throwing", async () => {
  for (const [code, reason] of [[3, "ci_not_concluded"], [4, "review_withheld"]] as const) {
    const { run, rows } = exitingWith(code);
    await run;
    const terminal = rows.find((r) => r.step === "daemon.retro_subprocess.terminal")?.extra;
    assert.equal(terminal?.outcome, "handed_off");
    assert.equal(terminal?.handoff_reason, reason);
    assert.equal(terminal?.exit_code, code);
  }
});

test("a retro that exits 1 still throws a named failure", async () => {
  const { run, rows } = exitingWith(1);
  await assert.rejects(run, AutomatedRetroSubprocessError);
  const terminal = rows.find((r) => r.step === "daemon.retro_subprocess.terminal")?.extra;
  assert.equal(terminal?.outcome, "failure");
  assert.equal(terminal?.failure_class, "nonzero_exit");
});
