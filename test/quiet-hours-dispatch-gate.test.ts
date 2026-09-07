import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkDispatchGovernors, governorDeferPayload, type DispatchGovernorDeps } from "../src/lib/dispatch-governor.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { MergedSet } from "../src/lib/drain.js";
import type { RunResult } from "../src/lib/run-result.js";

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function onePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}quiet-hours-dispatch-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const NONE_MERGED: MergedSet = () => false;
const okResult = (id: string): RunResult => ({
  taskId: id,
  runId: `${id}-run`,
  merged: true,
  costUsd: 0,
  verdict: "merged",
});

test("W1-T2655: quiet hours defers new dispatch while the daemon sweep still runs in that tick", async () => {
  let stop = false;
  let sweeps = 0;
  const dispatched: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];

  const summary = await runDaemon(
    onePlan(),
    {
      refreshMerged: () => NONE_MERGED,
      sweep: () => {
        sweeps++;
      },
      checkQuietHours: () => ({ deferred: true, detail: "QUIET_HOURS file present" }),
      checkStop: () => (stop ? "test done" : undefined),
      runOne: async (id) => {
        dispatched.push(id);
        return okResult(id);
      },
      sleep: async () => {
        stop = true;
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { pollIntervalMs: 5 },
  );

  assert.equal(summary.stopReason, "stopped");
  assert.deepEqual(dispatched, [], "quiet hours holds back new daemon dispatch");
  assert.equal(sweeps, 1, "the full sweep still ran before the dispatch-only governor deferred");
  const hold = lines.find((l) => l.step === "daemon.quiet_hours");
  assert.ok(hold, "the hold is ledgered under its own daemon step");
  assert.equal(hold?.extra.quiet_hours, true);
  assert.equal(hold?.extra.detail, "QUIET_HOURS file present");
  assert.equal(lines.some((l) => l.step === "daemon.pause"), false, "quiet hours must not render as a pause");
});

test("W1-T2655: omitting quiet hours is byte-identical to a quiet-hours dep that returns clear", async () => {
  async function run(withClearDep: boolean): Promise<{
    dispatched: string[];
    summary: Awaited<ReturnType<typeof runDaemon>>;
    lines: Array<{ step: string; extra: Record<string, unknown> }>;
  }> {
    const merged = new Set<string>();
    const dispatched: string[] = [];
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const deps: DaemonDeps = {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        dispatched.push(id);
        merged.add(id);
        return okResult(id);
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    };
    if (withClearDep) deps.checkQuietHours = () => undefined;

    const summary = await runDaemon(onePlan(), deps, { max: 1, pollIntervalMs: 5 });
    return { dispatched, summary, lines };
  }

  const absent = await run(false);
  const clear = await run(true);

  assert.deepEqual(clear.dispatched, absent.dispatched);
  assert.deepEqual(clear.summary, absent.summary);
  assert.deepEqual(clear.lines, absent.lines);
  assert.equal(clear.lines.some((l) => l.step === "daemon.quiet_hours"), false);
});

test("W1-T2655: quiet hours names itself in the verdict kind and shared payload", () => {
  const verdict = checkDispatchGovernors(
    { checkQuietHours: () => ({ deferred: true, detail: "QUIET_HOURS file present" }) },
    undefined,
  );

  assert.ok(verdict);
  assert.equal(verdict.kind, "quiet_hours");
  assert.deepEqual(governorDeferPayload(verdict), {
    quiet_hours: true,
    detail: "QUIET_HOURS file present",
  });
});

test("W1-T2655: an unreadable quiet-hours read fails open and admits dispatch", () => {
  const deps: DispatchGovernorDeps = {
    checkCostGovernor: () => undefined,
    checkQueueGovernor: () => undefined,
    checkQuietHours: () => {
      throw new Error("QUIET_HOURS unreadable");
    },
  };

  assert.equal(checkDispatchGovernors(deps, undefined), undefined);

  const costThrows: DispatchGovernorDeps = {
    checkCostGovernor: () => {
      throw new Error("ledger unreadable");
    },
  };
  const costVerdict = checkDispatchGovernors(costThrows, undefined);
  assert.ok(costVerdict && costVerdict.kind === "unreadable", "cost still uses the fail-closed arm");
});
