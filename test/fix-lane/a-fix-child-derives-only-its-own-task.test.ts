/**
 * W1-T13662: a fix child read one task's merge state by deriving the whole plan (~5,960 tasks, p50 823 s). It now
 * derives its own task only, through projectTask, and answers as before.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import { disposeSharedPauseRefresh, type SharedPauseGitDeps } from "#src/lib/fleet-control.js";
import { loadPlan } from "#src/lib/plan.js";
import { riskJudgePlanContextDigestFor } from "#src/lib/risk-judge.js";
import type { DetachedWorkSpec } from "#src/lib/run-child.js";
import { projectPlan, projectTask, type GitHub, type PrRef } from "#src/lib/status.js";
import { buildFixDispatchEnvelope, type OpenPrView } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { fakeGitHub, type FakeGitHub } from "#test/helpers/fake-github.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { runDetachedWork } from "#test/helpers/run-task-test.js";

const MERGED = "W1-T13662M";
const OPEN = "W1-T13662O";
const NEITHER = "W1-T13662N";
const MISSING = "W1-T13662X";
const HEAD = "1366200000";
const SLUG = "craigoley/remudero";
const UNMET = [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" as const }];
type Row = { step: string } & Record<string, unknown>;

const filler = (count: number): string[] => Array.from({ length: count }, (_, i) => `W1-T1366${String(i).padStart(3, "0")}`);
const taskRow = (id: string) => ({ id, title: `task ${id}`, repo: "remudero", type: "implement", verify: "auto", depends_on: [],
  status: "queued", files: ["src/lib/status.ts"], design: "a fixture task" });

const mergedPr: PrRef = { number: 900, url: `https://github.com/${SLUG}/pull/900`, state: "MERGED", headRefName: `run-${MERGED}-1795000000000` };
const openPr: PrRef = { number: 901, url: `https://github.com/${SLUG}/pull/901`, state: "OPEN", headRefName: `run-${OPEN}-1795000000001` };
/** An open build of a task outside the plan that touches the plan's files, so each unmerged task reads its files. */
const siblingPr: PrRef = { number: 902, url: `https://github.com/${SLUG}/pull/902`, state: "OPEN", headRefName: "run-W1-T99999-1795000000002" };

/** A gateway that answers MERGED by its trailer and OPEN by its open branch, and records every call. */
function gateway(over: Partial<GitHub> = {}): FakeGitHub {
  return fakeGitHub({
    findMergedByTrailer: (taskId) => (taskId === MERGED ? mergedPr : null),
    listMergedHeadBranches: () => [mergedPr],
    listOpenHeadBranches: () => [openPr, siblingPr],
    prByRef: (ref) => ([mergedPr, openPr, siblingPr].find((p) => p.url === ref || p.number === ref) ?? null),
    headRefName: (url) => [mergedPr, openPr, siblingPr].find((p) => p.url === url)?.headRefName,
    changedFiles: () => ["src/lib/status.ts"],
    issueByUrl: () => ({ state: "OPEN", title: "an open escalation" }),
    ...over,
  });
}

function writePlan(root: string, ids: string[]): string {
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, JSON.stringify(ids.map(taskRow)));
  return planPath;
}

const tempRoot = (name: string): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13662-${name}-`));

test("W1-T13662 criterion 1: projectTask holds the named task only, and its entry equals projectPlan's", () => {
  const root = tempRoot("project");
  try {
    const plan = loadPlan(writePlan(root, [MERGED, OPEN, NEITHER, ...filler(5)]));
    /** Open escalations of another plan task and of an id outside the plan: neither may enter a one-task map. */
    const escalations = [filler(1)[0]!, "W1-T77777"].map((taskId, i) => ({ ts: `2026-11-18T10:0${i}:00Z`, step: "escalation.issue_opened",
      task_id: taskId, run_id: `t13662-esc-${i}`, issue_url: `https://github.com/${SLUG}/issues/${800 + i}` }));
    /** A fresh ledger directory per call, so one call's credit store never feeds the next. */
    const fresh = (name: string) => ({ ledgerPath: writeLedger(escalations, { dir: mkdtempSync(join(root, `${name}-`)) }).path });
    const whole = projectPlan(plan, { ledgerPath: fresh("whole").ledgerPath, github: gateway() });
    assert.equal(whole.get("W1-T77777")?.needsHuman, true, "the whole plan holds the task-less escalation");
    for (const id of [MERGED, OPEN, NEITHER]) {
      const one = projectTask(plan, id, { ledgerPath: fresh(id).ledgerPath, github: gateway() });
      assert.deepEqual([...one.keys()], [id], `${id}: the map holds the named task only`);
      assert.deepEqual(one.get(id), whole.get(id), `${id}: the same projection as the whole plan's`);
    }
    assert.equal(whole.get(MERGED)!.merged, true, "the trailer case is merged");
    assert.equal(whole.get(OPEN)!.merged, false);
    assert.equal(whole.get(OPEN)!.prState, "OPEN", "the open case has its open pull request");
    assert.equal(whole.get(NEITHER)!.merged, false);
    assert.notEqual(whole.get(NEITHER)!.prState, "OPEN", "the third case has neither");
    assert.equal(projectTask(plan, MISSING, { ledgerPath: fresh("missing").ledgerPath, github: gateway() }).size, 0,
      "an id not in the plan gives an empty map");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fix-dispatch run child for `taskId` over a fixture plan, config, ledger and GitHub fake (the existing ports). */
function detached(taskId: string, planIds: string[], github: FakeGitHub) {
  const root = tempRoot("child");
  const planPath = writePlan(root, planIds);
  const pr: OpenPrView = {
    prNumber: 13662, prUrl: `https://github.com/${SLUG}/pull/13662`, taskId, reviewState: "failure", checksState: "green",
    unmetCriteria: UNMET, priorStrikes: 0, lastActivityAt: "2026-11-18T12:00:00Z", headSha: HEAD,
    headRefName: `run-${taskId}-1795001139000`, autoMergeArmed: false,
  };
  const digest = riskJudgePlanContextDigestFor(loadPlan(planPath))({ taskId }) ?? "digest-of-a-missing-task";
  const envelope = buildFixDispatchEnvelope(pr, { unmetCriteria: UNMET }, { fixKey: `${taskId}@${HEAD}`, decidedAtMs: 1, planContextDigest: digest });
  const work: DetachedWorkSpec = { kind: "fix-dispatch", prNumber: pr.prNumber, headSha: HEAD, inputs: { envelope } };
  const rows: Row[] = [];
  let dispatched = 0;
  const git: SharedPauseGitDeps = {
    run: () => assert.fail("no synchronous network read"),
    runAsync: async () => ({ status: 0, stdout: "" }),
    mintAnchor: () => assert.fail("a read never writes a PAUSE anchor"),
  };
  const ports = {
    config: { root, claudeBin: "/bin/true" } as Config, planPath, sharedPauseGit: git, github,
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
    planSnapshot: () => ({ plan: loadPlan(planPath), staleDispatch: false }),
    readPr: async () => ({ state: "OPEN", mergedAt: null, headRefOid: HEAD }),
    claimFixAdmission: () => ({ admitted: true as const }),
    dispatcher: () => ({ dispatchFix: async () => { dispatched++; } }),
  };
  const run = () => runDetachedWork(work, { taskId, runId: `t13662-${taskId}` }, ports);
  return { rows, run, dispatched: () => dispatched,
    cleanup: () => { disposeSharedPauseRefresh(git); rmSync(root, { recursive: true, force: true }); } };
}

const refusal = (rows: Row[]) => rows.find((r) => r.step === "sweep.fix.child_refused")?.reason;
const projectionRows = (rows: Row[]) => rows.filter((r) => r.step === "sweep.fix.prepare_timing" && r.stage === "child-plan-projection");

test("W1-T13662 criterion 2: the fix child's recheck answers merged, open, missing and unreadable as before", async () => {
  const plan = [MERGED, OPEN, NEITHER, ...filler(5)];
  const cases: Array<[string, string, string[], FakeGitHub, string | undefined]> = [
    ["merged", MERGED, plan, gateway(), `task ${MERGED} is already merged`],
    ["open", OPEN, plan, gateway(), undefined],
    ["not in the plan", MISSING, plan, gateway(), `task ${MISSING}'s canonical context changed since the sweep decided`],
    ["unreadable", NEITHER, plan, gateway({ listMergedHeadBranches: () => null, findMergedByTrailer: () => null, readFailed: () => true }),
      `the recheck could not read its evidence (task ${NEITHER}'s merge projection is unreadable)`],
  ];
  for (const [name, taskId, ids, github, reason] of cases) {
    const d = detached(taskId, ids, github);
    try {
      if (reason === undefined) {
        await d.run();
        assert.equal(d.dispatched(), 1, `${name}: found, not merged, not retired, so the fix is dispatched`);
        assert.equal(refusal(d.rows), undefined, `${name}: no refusal`);
      } else {
        await assert.rejects(d.run(), { message: `fix dispatch refused: ${reason}` }, name);
        assert.equal(refusal(d.rows), reason, `${name}: the refusal reason is unchanged`);
        assert.equal(d.dispatched(), 0, `${name}: nothing is dispatched`);
      }
      assert.equal(projectionRows(d.rows).length, taskId === MISSING ? 0 : 1, `${name}: a task not in the plan is not projected`);
    } finally {
      d.cleanup();
    }
  }
});

test("W1-T13662 criterion 3: the child derives only the task it reads, inside one child-plan-projection row", async () => {
  const ids = [OPEN, NEITHER, ...filler(60)];
  assert.ok(ids.length >= 50);
  const github = gateway();
  const d = detached(NEITHER, ids, github);
  try {
    await d.run();
    assert.equal(d.dispatched(), 1);
    const named = github.calls.filter((c) => c.args.some((a) => typeof a === "string" && /^W1-T\d+[A-Z]?$/.test(a)));
    assert.ok(named.length > 0, "the read task is derived");
    assert.deepEqual([...new Set(named.flatMap((c) => c.args.filter((a) => typeof a === "string" && /^W1-T/.test(a))))], [NEITHER],
      "every call that names a task names the read task");
    assert.equal(github.calls.filter((c) => c.method === "changedFiles").length, 1, "the task's files are read for one task, not 62");
    assert.equal(projectionRows(d.rows).length, 1, "one sweep.fix.prepare_timing row with stage child-plan-projection");
  } finally {
    d.cleanup();
  }
});
