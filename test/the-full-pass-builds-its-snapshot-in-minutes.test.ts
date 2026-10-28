/**
 * W1-T9564 — THE FULL PASS BUILDS ITS SNAPSHOT IN MINUTES, AND DATES A PENDING AGE BY THE CLOCK AT THE ACT.
 *
 * 2026-10-14/15 (core ledger, read only): full passes spent 20.8-23.1 min before `runSweep`'s walk, with no row
 * naming which stage took the time, and a head re-read during the walk read `checks pending -15m` because its age
 * was taken from the pass-entry clock. These fixtures drive the real `buildSweepHook` and the real `runSweep`.
 *
 * FIXTURES ONLY: the gh stand-in, the ledger and the state root live in throwaway directories.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import type { EscalationAnswerGateway } from "#src/lib/escalation-answers.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildSweepHook } from "#test/helpers/run-task-test.js";
import { readLedgerLines } from "#src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const NOW = Date.UTC(2026, 9, 15, 6, 0);
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const SNAPSHOT_HEAD = "9564aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LIVE_HEAD = "9564bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function snapshotPr(): OpenPrView {
  return {
    prNumber: 9564, prUrl: "https://github.com/o/r/pull/9564", taskId: "W1-T9564",
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: at(-5), createdAt: at(-30), headSha: SNAPSHOT_HEAD, autoMergeArmed: false,
  };
}

function pendingRun(clock: { ms: number }): { deps: SweepDeps; rows: () => Array<Record<string, unknown>> } {
  const { path } = writeLedger();
  const deps: SweepDeps = {
    arm: () => "armed",
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: () => {},
    readLiveStateAtAct: () => ({ ok: true, state: "OPEN", headSha: LIVE_HEAD }),
    rereadPrAtAct: async (pr) => {
      clock.ms += 16 * 60_000;
      return { ...pr, headSha: LIVE_HEAD, checksState: "pending", checksPendingSince: at(15), lastActivityAt: at(15) };
    },
    readLedgerUnion: () => ({ complete: false, lines: [] }),
    ledgerPath: path,
    runId: "DAEMON-T9564",
    now: () => clock.ms,
  };
  return { deps, rows: () => readLedgerLines(path) };
}

test("W1-T9564: a head re-read in the pass dates its pending age by the clock at the act", async () => {
  const clock = { ms: NOW };
  const run = pendingRun(clock);
  await runSweep([snapshotPr()], run.deps, DEFAULT_SWEEP_POLICY);
  const disposed = run.rows().filter((r) => r.step === "sweep.disposed");
  assert.equal(disposed.length, 1, "one disposed row, for the re-read head");
  assert.equal(disposed[0].head_sha, LIVE_HEAD);
  assert.equal(disposed[0].rederived, true, "control: the disposition acted on the view read during the pass");
  assert.match(String(disposed[0].reason), /^checks pending 1m \(/, "16 min on the pass clock less 15 min after entry");
  assert.doesNotMatch(String(disposed[0].reason), /pending -\d/, "a pending age is never negative");
});

test("W1-T9564: a pending stamp later than the act clock reads zero minutes, never negative", async () => {
  const clock = { ms: NOW };
  const run = pendingRun(clock);
  const reread = run.deps.rereadPrAtAct!;
  run.deps.rereadPrAtAct = async (pr) => {
    const view = await reread(pr);
    return view && { ...view, checksPendingSince: at(40), lastActivityAt: at(40) };
  };
  await runSweep([snapshotPr()], run.deps, DEFAULT_SWEEP_POLICY);
  const disposed = run.rows().find((r) => r.step === "sweep.disposed");
  assert.match(String(disposed?.reason), /^checks pending 0m \(/);
});

const STAGE_MS = 60;

interface Staged {
  events: string[];
  stage<T>(name: string, value: T): Promise<T>;
}

function staged(): Staged {
  const events: string[] = [];
  let started = 0;
  let release: () => void = () => {};
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  return {
    events,
    async stage(name, value) {
      events.push(`start:${name}`);
      if (++started === 3) release();
      await Promise.race([allStarted, new Promise((resolve) => setTimeout(resolve, 400))]);
      await new Promise((resolve) => setTimeout(resolve, STAGE_MS));
      events.push(`end:${name}`);
      return value;
    },
  };
}

async function runFullPass(withTickRead: boolean): Promise<{ events: string[]; logs: Array<{ step: string; extra: Record<string, unknown> }> }> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9564-`));
  const shim = ghShim([{ when: "", stdout: "[]" }], { kind: "t9564-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = staged();
  const plan = { tasks: [], byId: new Map() };
  const gateway: EscalationAnswerGateway = {
    listOpen: () => s.stage("escalation_answers", []),
    listComments: () => [],
    reactPlusOne: () => {},
  };
  const facts = {
    plan, openPrViews: [], openPrRows: [], projection: [], creditUpdates: [], creditCandidates: [],
    escalationCandidates: [], boardItems: [], staleGateWorkflowsByPr: new Map(), behindMainByPr: new Map(),
    baseChangedFilesByPr: new Map(), mergedFixPrNumbers: [], postFixCiFailuresByPr: new Map(), closedPrs: [],
    servedPublishedAtMs: Date.now() - 90_000,
  };
  try {
    const hook = buildSweepHook("o", "r", { root, claudeBin: "/bin/true" } as Config, join(root, "ledger.ndjson"),
      "DAEMON-T9564", plan, (step, extra = {}) => logs.push({ step, extra }),
      undefined, undefined, undefined, undefined,
      () => s.stage("main_health", undefined),
      undefined, undefined, undefined, undefined, undefined, undefined,
      gateway, undefined,
      withTickRead ? (() => s.stage("tick_read", facts as never)) : undefined);
    await hook();
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
  return { events: s.events, logs };
}

test("W1-T9564: a full pass names how long each stage before its walk took", async () => {
  const { logs } = await runFullPass(true);
  const rows = logs.filter((l) => l.step === "sweep.full_prelude");
  assert.equal(rows.length, 1, "one stage-timer row per full pass");
  const row = rows[0].extra;
  assert.equal(row.walk_reached, true, "written when the walk starts");
  assert.equal(row.tick_read_source, "served", "a generation published before the pass began was served");
  const stages = row.stages as Record<string, number>;
  for (const stage of ["tick_read", "triage_evidence", "main_health", "escalation_answers", "post_fix_reverification",
    "stale_gate_workflows", "updated_for_workflow", "behind_main", "merge_probes", "credit_candidates", "sweep_entry",
    "reader_agreement", "armed_body_guard", "ledger_fold", "main_repair", "stale_releases", "anomaly_sentinels",
    "fleet_state", "mutation_verdicts", "fold_debt", "refusal_amendments", "walk_setup"]) {
    assert.equal(typeof stages[stage], "number", `the row names ${stage}`);
    assert.ok(stages[stage] >= 0, `${stage} is a duration`);
  }
  for (const stage of ["tick_read", "main_health", "escalation_answers"]) {
    assert.ok(stages[stage] >= STAGE_MS - 5, `${stage} carries its injected ${STAGE_MS} ms (${stages[stage]})`);
  }
  assert.ok(Number(row.elapsed_ms) >= STAGE_MS - 5, "the row names the whole pre-walk span");
  assert.deepEqual(logs.filter((l) => l.step === "sweep.error").map((l) => l.extra), [], "control: the pass ran clean");
  const passAt = logs.findIndex((l) => l.step === "sweep.pass");
  assert.ok(passAt > logs.findIndex((l) => l.step === "sweep.full_prelude"), "the row precedes the walk's own heartbeat");
});

test("W1-T9564: the tick read, main health and escalation answers run concurrently", async () => {
  const { events } = await runFullPass(true);
  const firstEnd = events.findIndex((e) => e.startsWith("end:"));
  assert.deepEqual(events.slice(0, firstEnd).sort(),
    ["start:escalation_answers", "start:main_health", "start:tick_read"], "every independent stage starts before any ends");
});

test("W1-T9564: a pass with no read plane reads its own views and names that source", async () => {
  const { logs, events } = await runFullPass(false);
  const row = logs.find((l) => l.step === "sweep.full_prelude")?.extra;
  assert.equal(row?.tick_read_source, "none");
  assert.equal(typeof (row?.stages as Record<string, number>).open_pr_views, "number", "the in-pass view build is timed");
  assert.ok(events.includes("end:escalation_answers"), "control: the answers stage ran");
});
