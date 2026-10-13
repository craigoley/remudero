import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { FleetFlowRow } from "../src/lib/fleet-flow-detectors.js";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import { SRE_LANE_DETECTORS } from "../src/lib/sre-lane.js";
import {
  evaluateStrandedTaskDetectors,
  nonWorkerVerdictClass,
  strandedTaskDetector,
  STRANDED_TASK_INPUTS,
} from "../src/lib/stranded-task-detector.js";

const at = (iso: string) => Date.parse(iso);
const MIN = 60_000;

function row(ms: number, task: string, fields: Record<string, unknown>): FleetFlowRow {
  return { ts: new Date(ms).toISOString(), run_id: `R-${ms}`, task_id: task, ...fields };
}
const start = (ms: number, task: string) => row(ms, task, { step: "run.start", type: "implement" });
const verdict = (ms: number, task: string, fields: Record<string, unknown>) => row(ms, task, { step: "verdict", ...fields });
const yielded = (ms: number, task: string) => verdict(ms, task, { verdict: "handed_off", reason: "freshness_yield" });

/**
 * The fleet's own history: six tasks that reached a PR in 60..110 minutes (p90 = 110), and six that were handed
 * off and resumed after 0,1,1,2,2,3 fresh starts of other tasks (p90 = 3). Filler tasks only start.
 */
function baseline(origin: number): FleetFlowRow[] {
  const rows: FleetFlowRow[] = [];
  const gaps = [0, 1, 1, 2, 2, 3];
  gaps.forEach((gap, i) => {
    const t0 = origin + i * 300 * MIN;
    const task = `BASE-${i}`;
    rows.push(start(t0, task), yielded(t0 + 10 * MIN, task));
    for (let k = 0; k < gap; k++) rows.push(start(t0 + (11 + k) * MIN, `FILL-${i}-${k}`));
    rows.push(start(t0 + 30 * MIN, task), row(t0 + (60 + i * 10) * MIN, task, { step: "pr.opened" }));
  });
  return rows;
}

const ORIGIN = at("2026-10-10T00:00:00Z");

function judge(rows: FleetFlowRow[], nowMs: number, priorityOf?: (task: string) => number | undefined) {
  return strandedTaskDetector({ priorityOf }).evaluate(rows, nowMs, []);
}

describe("test/a-task-interrupted-only-by-the-harness-is-an-incident.test.ts", () => {
  test("W1-T8240: the W1-T7742 replay fires and names its non-worker causes", () => {
    const task = "W1-T7742";
    const rows = [
      ...baseline(at("2026-10-05T00:00:00Z")),
      start(at("2026-10-10T20:50:00Z"), task),
      verdict(at("2026-10-10T21:13:34Z"), task, { verdict: "no_pr", reason: "restart_checkpoint_failed" }),
      start(at("2026-10-11T04:40:00Z"), task),
      yielded(at("2026-10-11T04:49:28Z"), task),
      start(at("2026-10-11T06:20:00Z"), task),
      verdict(at("2026-10-11T06:25:00Z"), task, { verdict: "failed", stage: "worktree.node_modules" }),
      row(at("2026-10-11T06:33:52Z"), task, { step: "dispatch.lifetime_pressure.infra_only" }),
      start(at("2026-10-11T06:50:00Z"), task),
      verdict(at("2026-10-11T06:52:00Z"), task, { verdict: "blocked_inflight" }),
      yielded(at("2026-10-11T07:03:40Z"), task),
      row(at("2026-10-11T08:35:15Z"), task, { step: "dispatch.circuit_broken", task, freshCount: 5 }),
    ];
    const findings = judge(rows, at("2026-10-11T08:36:00Z"));
    assert.equal(findings.length, 1);
    const [finding] = findings;
    assert.equal(finding!.name, "stranded-task");
    assert.match(finding!.subject, /^task=W1-T7742 since=2026-10-10T20:50:00\.000Z /);
    assert.match(finding!.subject, /causes=\S*claim_race:1/);
    assert.match(finding!.subject, /causes=\S*lifetime_infra_only:1/);
    assert.match(finding!.subject, /causes=\S*node_modules:1/);
    assert.match(finding!.subject, /causes=\S*restart_checkpoint:1/);
    assert.match(finding!.subject, /causes=\S*yield:2/);
    assert.match(finding!.subject, /breaker=tripped/);
    assert.equal(finding!.population, "stranded-span");
    assert.ok(finding!.bound !== undefined && finding!.measured > finding!.bound);
    // The breaker had not escalated yet at 08:35:15 — and the finding was already due hours before it.
    const early = judge(rows.filter((r) => rowAt(r) < at("2026-10-11T08:00:00Z")), at("2026-10-11T08:00:00Z"));
    assert.equal(early.length, 1);
    assert.match(early[0]!.subject, /breaker=clear/);
  });

  test("W1-T8240: the W1-T7837 replay fires on pass-over", () => {
    const task = "W1-T7837";
    const rows = [
      ...baseline(at("2026-10-05T00:00:00Z")),
      start(at("2026-10-11T04:40:00Z"), task),
      verdict(at("2026-10-11T04:51:27Z"), task, { verdict: "no_pr", reason: "restart_checkpoint_failed" }),
      yielded(at("2026-10-11T06:57:07Z"), task),
      yielded(at("2026-10-11T09:02:27Z"), task),
    ];
    // 66 other implement builds start while it sits handed off; 6 of them are higher priority (a lower number).
    for (let i = 0; i < 66; i++) rows.push(start(at("2026-10-11T09:10:00Z") + i * 9 * MIN, `OTHER-${i}`));
    const now = at("2026-10-11T19:42:00Z");
    const priorityOf = (id: string) => id === task ? 5 : id.startsWith("OTHER-") && Number(id.slice(6)) < 6 ? 1 : 5;
    const [finding] = judge(rows, now, priorityOf);
    assert.match(finding!.subject, /^task=W1-T7837 /);
    assert.match(finding!.subject, /passed_over=60$/);
    assert.match(finding!.subject, /breaker=clear/);

    // The pass-over signal alone: a task still inside the fleet's normal start-to-PR span, passed over by 66 starts.
    const brisk = [
      ...baseline(at("2026-10-05T00:00:00Z")),
      start(at("2026-10-11T09:00:00Z"), task),
      yielded(at("2026-10-11T09:05:00Z"), task),
    ];
    for (let i = 0; i < 66; i++) brisk.push(start(at("2026-10-11T09:06:00Z") + i * MIN / 2, `OTHER-${i}`));
    const [only] = judge(brisk, at("2026-10-11T09:50:00Z"));
    assert.equal(only!.population, "pass-over");
    assert.match(only!.subject, /passed_over=66$/);
    // No fresh start passes it over: no finding while it is still inside its span.
    assert.deepEqual(judge(brisk.filter((r) => r.step !== "run.start" || r.task_id === task || String(r.task_id).startsWith("BASE") || String(r.task_id).startsWith("FILL")),
      at("2026-10-11T09:50:00Z")), []);
  });

  test("W1-T8240: a task with a worker failure is not stranded", () => {
    const task = "W1-T-CONTROL";
    const rows = [
      ...baseline(at("2026-10-05T00:00:00Z")),
      start(at("2026-10-10T20:50:00Z"), task),
      verdict(at("2026-10-10T21:13:34Z"), task, { verdict: "no_pr", reason: "restart_checkpoint_failed" }),
      start(at("2026-10-11T04:40:00Z"), task),
      // The control's second verdict is a real worker failure.
      verdict(at("2026-10-11T04:49:28Z"), task, { verdict: "failed", reason: "tests fail", stage: "implement" }),
      start(at("2026-10-11T06:20:00Z"), task),
      yielded(at("2026-10-11T07:03:40Z"), task),
      row(at("2026-10-11T08:35:15Z"), task, { step: "dispatch.circuit_broken", task, freshCount: 5 }),
    ];
    for (let i = 0; i < 40; i++) rows.push(start(at("2026-10-11T07:10:00Z") + i * MIN, `OTHER-${i}`));
    assert.deepEqual(judge(rows, at("2026-10-11T08:36:00Z")), []);
    // The same task without the worker failure fires, so the exclusion is what held it back.
    const without = rows.filter((r) => r.stage !== "implement");
    assert.equal(judge(without, at("2026-10-11T08:36:00Z")).length, 1);
  });

  test("W1-T8240: each non-worker verdict class is recognised", () => {
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{ verdict: "handed_off", reason: "freshness_yield" }, "yield"],
      [{ verdict: "handed_off", reason: "recycle_yield" }, "yield"],
      [{ verdict: "handed_off", reason: "pr_open_yield" }, "handoff"],
      [{ verdict: "no_pr", reason: "restart_checkpoint_failed" }, "restart_checkpoint"],
      [{ verdict: "no_pr", reason: "restart_checkpoint_restore_failed" }, "restart_checkpoint"],
      [{ verdict: "blocked_inflight", reason: "W1-T7742 is already claimed by another lane" }, "claim_race"],
      [{ verdict: "blocked_git_fetch" }, "git_fetch"],
      [{ verdict: "blocked_toolchain" }, "toolchain"],
      [{ verdict: "blocked_containment" }, "toolchain"],
      [{ verdict: "failed", stage: "worktree.node_modules" }, "node_modules"],
      [{ verdict: "failed", stage: "managed_checkout.refresh" }, "toolchain"],
      [{ verdict: "failed", stage: "worker.bounded_output", reason: "stderr budget" }, "output_budget"],
      // Worker-attributable outcomes are not recognised as non-worker.
      [{ verdict: "failed", stage: "implement", reason: "tests fail" }, undefined],
      [{ verdict: "no_pr", reason: "worker produced no diff" }, undefined],
      [{ verdict: "merged" }, undefined],
      [{ verdict: "task_already_merged" }, undefined],
    ];
    for (const [fields, expected] of cases) assert.equal(nonWorkerVerdictClass(fields), expected, JSON.stringify(fields));

    // A run the lock sweep proved orphaned, and a lifetime-pressure infra_only row, are evidence too.
    const orphaned = [
      ...baseline(at("2026-10-05T00:00:00Z")),
      start(at("2026-10-10T10:00:00Z"), "W1-T-ORPHAN"),
      row(at("2026-10-10T10:30:00Z"), "W1-T-ORPHAN", { step: "worker_orphan_killed", pid: 7 }),
    ];
    const [finding] = judge(orphaned, at("2026-10-11T10:00:00Z"));
    assert.match(finding!.subject, /causes=orphaned:1 /);
  });

  test("W1-T8240: the detector is registered and reads only steps something writes", () => {
    assert.ok(SRE_LANE_DETECTORS.some((d) => d.id === "stranded-task"));
    assert.deepEqual([...strandedTaskDetector().inputs], [...STRANDED_TASK_INPUTS]);
  });

  test("W1-T8240: too little history of its own judges nothing", () => {
    const rows = [start(at("2026-10-10T10:00:00Z"), "W1-T-LONE"), yielded(at("2026-10-10T10:10:00Z"), "W1-T-LONE")];
    assert.deepEqual(judge(rows, at("2026-10-11T10:00:00Z")), []);
  });

  test("W1-T8240: one incident per episode, written once and deduped across passes", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rmd-stranded-"));
    const task = "W1-T7742";
    const rows = [
      ...baseline(at("2026-10-05T00:00:00Z")),
      start(at("2026-10-10T20:50:00Z"), task),
      yielded(at("2026-10-11T04:49:28Z"), task),
    ];
    const written: Record<string, unknown>[] = [];
    const run = (nowMs: number) => evaluateStrandedTaskDetectors({
      stateDir, nowMs, detectors: [strandedTaskDetector()], readRows: () => rows,
      writeEvent: (event) => { written.push(event as Record<string, unknown>); },
    });
    const first = await run(at("2026-10-11T05:00:00Z"));
    assert.equal(first.length, 1);
    assert.equal(first[0]!.kind, "flow");
    assert.equal(first[0]!.task_id, "INCIDENT");
    assert.match(String(first[0]!.message), /^task=W1-T7742 since=2026-10-10T20:50:00\.000Z /);
    // The next pass sees a larger passed_over count but the same episode: no second incident.
    assert.deepEqual(await run(at("2026-10-11T05:30:00Z")), []);
    assert.equal(written.length, 1);
    // Another detector in the list, or none registered, writes nothing.
    assert.deepEqual(await evaluateStrandedTaskDetectors({ stateDir, nowMs: at("2026-10-11T05:30:00Z"), detectors: [] }), []);
  });

  test("W1-T8240: the default reader judges the ledger on disk and appends the incident", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rmd-stranded-disk-"));
    const task = "W1-T7837";
    const rows = [
      ...baseline(at("2026-10-05T00:00:00Z")),
      start(at("2026-10-10T20:50:00Z"), task),
      yielded(at("2026-10-11T04:49:28Z"), task),
      { ts: "2026-10-11T04:50:00.000Z", run_id: "NOISE", task_id: task, step: "worker.event" },
    ];
    writeFileSync(join(stateDir, LEDGER_FILENAME), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const events = await evaluateStrandedTaskDetectors({
      stateDir, nowMs: at("2026-10-11T05:00:00Z"), detectors: [strandedTaskDetector()],
    });
    assert.equal(events.length, 1);
    const lines = readFileSync(join(stateDir, LEDGER_FILENAME), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const incident = lines.find((l) => l.step === "incident.event");
    assert.equal(incident.name, "stranded-task");
    assert.match(incident.subject, /^task=W1-T7837 /);
  });
});

function rowAt(r: FleetFlowRow): number {
  return Date.parse(String(r.ts));
}
