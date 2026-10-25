// test/console-pr-nudges.test.ts — W1-T4077: the console's "Review now" and "Fix now".
//
// The daemon half existed (a durable PR_ACTION_REQUESTED marker the daemon runs through `rmd review` / `rmd fix`),
// but the console could never use it: the route was pinned to the high tier its write token cannot reach, a nudge was
// read only between main-loop iterations (one took 43 minutes on 2026-09-22) and AWAITED there, and a fix nudge on a
// strike-exhausted PR escalated instead of dispatching. OPERATOR RULING 2026-09-22: review and fix only enter the
// ordinary pipelines, so the existing write token may request them.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, startPrActionPump } from "../src/lib/daemon.js";
import { pendingPrActions, prActionSwitchOffPath } from "../src/lib/fleet-control.js";
import { buildPrActionRoute } from "../src/lib/panel-actions.js";
import { loadPlan } from "../src/lib/plan.js";
import { createService } from "../src/lib/service.js";
import { DEFAULT_SWEEP_POLICY, type OpenPrView } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { Config } from "../src/lib/config.js";
import { ghShim } from "./helpers/gh-shim.js";
import { buildSweepEffects, fixCommand, requestedFixView, routeFix, type RegisteredFixOwnerSnapshot, type RunResult } from "../src/run-task.js";

const WRITE = "console-write-token";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("W1-T9682 the requested fix command preserves a real checkout refusal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w9682-command-`));
  mkdirSync(join(root, "state"));
  const head = "a".repeat(40), branch = "run-W1-T500-1792000000000";
  const prUrl = "https://github.com/acme/scratch-w9682/pull/9001";
  const shim = ghShim([
    { when: "headRefName", stdout: JSON.stringify({ headRefName: branch, headRefOid: head, body: "" }) },
    { when: "pulls/9001", stdout: JSON.stringify({ state: "open", merged: false,
      head: { sha: head, ref: branch }, base: { sha: "b".repeat(40) } }) },
    { when: "required_status_checks", stdout: JSON.stringify({ contexts: ["ci-gate"] }) },
    { when: "", stdout: "{}" },
  ], { kind: "w9682-command-gh" });
  const oldPath = process.env.PATH, oldError = console.error, oldLog = console.log;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  const said: string[] = [];
  console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
  console.log = (...args: unknown[]) => { said.push(args.join(" ")); };
  t.after(() => {
    process.env.PATH = oldPath; console.error = oldError; console.log = oldLog;
    rmSync(shim.dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  });
  const ownerPath = join(root, "registered-owner");
  const snapshot: RegisteredFixOwnerSnapshot = { path: ownerPath, pathState: "managed", attachmentState: "exact",
    treeState: "clean", remoteState: "exact", historyState: "contained", claimState: "clear",
    processState: "unknown", processProbeReason: "cwd_unreadable", ageMs: 60_000, localSha: head, remoteSha: head };
  const logs: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const config = { root, claudeBin: "/bin/true" } as Config;
  const task = { id: "W1-T500", title: "test task", risk: "low", acceptance: [], verify: "auto", files: [] } as never;
  const effects = buildSweepEffects({ owner: "acme", repo: "scratch-w9682", config,
    ledgerPath: join(root, "adapter-ledger.ndjson"), runId: "W9682-ADAPTER",
    plan: { tasks: [task], byId: new Map([["W1-T500", task]]) }, policy: DEFAULT_SWEEP_POLICY,
    log: (step, fields) => { logs.push({ step, fields }); },
    resolveTaskContractAtHeadImpl: () => ({ criteria: [] }), registeredWorktreeOwnerImpl: () => ownerPath,
    registeredOwnerRecovery: { capture: () => snapshot, remove: () => assert.fail("never reclaim an unread owner") },
    spawnImpl: async () => { throw new Error("never dispatch a worker after owner refusal"); },
  });
  const code = await fixCommand(["9001", "--requested"], { config, self: { owner: "acme", repo: "scratch-w9682" },
    fetch: (args) => /\/pulls\/9001$/.test(args[1]!) ? { number: 9001, html_url: prUrl, state: "open", merged: false,
      body: "Remudero-Task: W1-T500\n", updated_at: new Date().toISOString(), head: { ref: branch, sha: head }, auto_merge: null }
      : /\/check-runs\?/.test(args[1]!) ? { check_runs: [{ id: 2, name: "ci-gate", status: "completed", conclusion: "failure" }] }
      : { statuses: [] },
    route: (state, pr, commandEffects, policy) => {
      assert.equal(pr.priorStrikes, 0, "the requested owner override still reaches ordinary routing");
      return routeFix(state, pr, { ...commandEffects, dispatchFix: effects.dispatchFix,
        escalate: () => assert.fail("an unread owner cannot become a speculative escalation") }, policy);
    },
  });
  const declined = logs.find(row => row.step === "sweep.fix.checkout_claim_declined");
  assert.equal(declined?.fields?.owner_recovery_reason, "process_cwd_probe_unreadable",
    "the real shared adapter, not a fabricated route verdict, supplies the refusal");
  assert.equal(code, 1);
  const rows = readLedgerLines(join(root, "state", "ledger.ndjson"));
  assert.ok(rows.some(row => row.step === "fix.refused" && row.outcome === "refused" && row.operator_requested === true &&
    String(row.reason).includes("process_cwd_probe_unreadable")));
  assert.ok(!rows.some(row => row.step === "fix.disposed" && row.outcome === "fixed"));
  assert.ok(said.some(line => line.includes("process_cwd_probe_unreadable")));
  assert.ok(shim.calls().some(call => call.includes("headRefName")), "the actual default gh child ran");
  assert.ok(!shim.calls().some(call => /pr (?:merge|close)|--method (?:POST|PATCH|DELETE)/.test(call)), "no outward mutation");
});

async function withRoute<T>(fn: (base: string, root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4077-route-`));
  mkdirSync(join(root, "state"), { recursive: true });
  // Default providers only: the bearer token, which W1-T404 pins at tier "low" — exactly the console's credential.
  const server = createService({
    tokens: { read: "console-read-token", write: WRITE },
    routes: [buildPrActionRoute({ root, ledgerPath: join(root, "state", "ledger.ndjson") })],
    enforceWriteTiers: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, root);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/pr-actions`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

void test("W1-T4077: the write token requests review and fix without a nonce", async () => {
  await withRoute(async (base, root) => {
    const review = await post(base, { action: "review", prNumber: 6612 }, { "x-remudero-operator": "Craig" });
    const fix = await post(base, { action: "fix", prNumber: 6630 });
    assert.equal(review.status, 200);
    assert.equal(fix.status, 200);
    const pending = pendingPrActions(root).map((r) => [r.action, r.prNumber, r.operator]);
    assert.deepEqual(pending.sort(), [["fix", 6630, undefined], ["review", 6612, "Craig"]].sort());
  });
});

void test("W1-T4077: a switched-off action is refused with its reason", async () => {
  await withRoute(async (base, root) => {
    writeFileSync(prActionSwitchOffPath(root, "fix"), "");
    const fix = await post(base, { action: "fix", prNumber: 6630 });
    assert.equal(fix.status, 409);
    assert.match(((await fix.json()) as { detail: string }).detail, /switched off/);
    const review = await post(base, { action: "review", prNumber: 6612 });
    assert.equal(review.status, 200, "switching fix off leaves review on");
    assert.deepEqual(pendingPrActions(root).map((r) => r.action), ["review"]);
  });
});

void test("W1-T4077: a nudge starts while the main loop is busy", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4077-daemon-`));
  try {
    writeFileSync(join(dir, "tasks.yaml"), "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
    const plan = loadPlan(join(dir, "tasks.yaml"));
    const actions: Array<{ action: "fix" | "review"; prNumber: number; origin: string; requestedAt: string }> = [];
    let startedWhileBusy = false;
    let busy = false;
    await runDaemon(
      plan,
      {
        refreshMerged: () => () => false,
        // The main loop is busy for a long awaited stretch, and the nudge arrives in the middle of it.
        runOne: async (id): Promise<RunResult> => {
          busy = true;
          actions.push({ action: "review", prNumber: 6612, origin: "console", requestedAt: new Date().toISOString() });
          await wait(300);
          busy = false;
          return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
        },
        pendingPrActions: () => actions,
        runPrAction: async () => {
          if (busy) startedWhileBusy = true;
          return { outcome: "completed" };
        },
        clearPrAction: (action, prNumber) => {
          const i = actions.findIndex((r) => r.action === action && r.prNumber === prNumber);
          if (i >= 0) actions.splice(i, 1);
        },
        sleep: async () => {},
        log: () => {},
      },
      { headroomEnabled: false, max: 1, pollIntervalMs: 20 },
    );
    assert.equal(startedWhileBusy, true, "the nudge started while the loop was still inside runOne");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("W1-T4077: a nudge runs detached and never holds dispatch", async () => {
  const started: number[] = [];
  const lines: string[] = [];
  const markers: Array<{ action: "fix" | "review"; prNumber: number; origin: string; requestedAt: string }> = [
    { action: "fix", prNumber: 6630, origin: "console", requestedAt: "2026-09-22T22:00:00.000Z" },
    { action: "review", prNumber: 6612, origin: "console", requestedAt: "2026-09-22T22:00:01.000Z" },
  ];
  const pump = startPrActionPump(
    {
      pendingPrActions: () => [...markers],
      // A fix that never settles must not block the review behind it, nor be started twice.
      runPrAction: (request) => {
        started.push(request.prNumber);
        return request.action === "fix" ? new Promise(() => {}) : Promise.resolve({ outcome: "completed" as const });
      },
      clearPrAction: (action, prNumber) => {
        const i = markers.findIndex((r) => r.action === action && r.prNumber === prNumber);
        if (i >= 0) markers.splice(i, 1);
      },
    },
    10,
    (step) => lines.push(step),
  );
  await wait(60);
  pump.stop();
  assert.deepEqual(started, [6630, 6612], "each pending request started once, the review not held behind the unfinished fix");
  assert.equal(lines.filter((s) => s === "console.pr_action_started").length, 2);
  assert.deepEqual(markers.map((r) => r.prNumber), [6630], "the unfinished fix keeps its marker; the finished review's is cleared");
});

void test("W1-T4077: a read that throws is logged and the next tick still runs", async () => {
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let reads = 0;
  const pump = startPrActionPump(
    {
      pendingPrActions: () => {
        reads += 1;
        if (reads === 1) throw new Error("ledger unreadable");
        return [{ action: "review", prNumber: 6612, origin: "console", requestedAt: "2026-09-22T22:00:02.000Z" }];
      },
      runPrAction: async () => ({ outcome: "completed" as const }),
      clearPrAction: () => {},
    },
    10,
    (step, extra) => lines.push({ step, extra }),
  );
  await wait(60);
  pump.stop();
  await pump.settled();
  const failed = lines.find((l) => l.step === "console.pr_action_read_failed");
  assert.ok(failed, "the first, throwing read is logged rather than crashing the pump");
  assert.match(String(failed?.extra?.error), /ledger unreadable/);
  assert.ok(lines.some((l) => l.step === "console.pr_action_started"), "a later, successful read still starts its request");
});

void test("W1-T4077: settled() waits for every in-flight request", async () => {
  let resolveRun: (() => void) | undefined;
  let running = false;
  const pump = startPrActionPump(
    {
      pendingPrActions: () => [{ action: "review", prNumber: 6612, origin: "console", requestedAt: "2026-09-22T22:00:03.000Z" }],
      runPrAction: () => {
        running = true;
        return new Promise<{ outcome: "completed" }>((resolve) => {
          resolveRun = () => {
            running = false;
            resolve({ outcome: "completed" });
          };
        });
      },
      clearPrAction: () => {},
    },
    10,
    () => {},
  );
  await wait(30);
  pump.stop();
  assert.equal(running, true, "the request is still in flight when settled() is called");
  const settled = pump.settled();
  resolveRun?.();
  await settled;
  assert.equal(running, false, "settled() only resolved once the in-flight request finished");
});

function strikeExhaustedRedPr(): OpenPrView {
  return {
    prNumber: 6630,
    prUrl: "https://github.com/o/r/pull/6630",
    taskId: "W1-T4051",
    reviewState: "none",
    checksState: "red",
    ciFailures: [{ name: "coverage-shard (1/4)", conclusion: "failure", logTail: "not ok 1" }],
    unmetCriteria: [],
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    lastActivityAt: new Date().toISOString(),
    headSha: "abc",
    autoMergeArmed: false,
  } as unknown as OpenPrView;
}

void test("W1-T4077: a requested fix on a strike-exhausted PR dispatches one round", async () => {
  const pr = strikeExhaustedRedPr();
  let dispatched = 0;
  let escalated = 0;
  const effects = { dispatchFix: async () => void dispatched++, escalate: async () => void escalated++ } as never;
  const control = await routeFix("OPEN", pr, effects);
  assert.equal(control.outcome, "escalated", "control: the ordinary route escalates at the strike cap");
  const requested = await routeFix("OPEN", requestedFixView(pr), effects);
  assert.equal(requested.outcome, "fixed");
  assert.equal(dispatched, 1, "exactly one fix round");
  assert.equal(escalated, 1, "only the control escalated");
  assert.equal(pr.priorStrikes, DEFAULT_SWEEP_POLICY.strikeCap, "the strike ledger's reading is not rewritten");
});

void test("W1-T4077: a requested fix still refuses a merged PR", async () => {
  const outcome = await routeFix("MERGED", requestedFixView(strikeExhaustedRedPr()), {
    dispatchFix: async () => { throw new Error("a merged PR must never dispatch"); },
    escalate: async () => {},
  } as never);
  assert.equal(outcome.outcome, "refused");
  assert.match(outcome.reason, /MERGED/);
});
