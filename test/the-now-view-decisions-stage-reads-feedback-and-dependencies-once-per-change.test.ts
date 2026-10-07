import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { boardOpenSnapshotPath } from "../src/lib/board-snapshot-cache.js";
import { feedbackDir, listFeedback } from "../src/lib/feedback.js";
import { queuedFeedbackDir } from "../src/lib/feedback-landing.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, NOW_REFRESH_MS, nowDependencyVerificationGates, type NowViewContext, type NowViewOptions } from "../src/lib/now-view.js";
import type { BoardPrRest } from "../src/lib/open-prs-rest.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const PROPOSAL = "https://github.com/o/r/pull/9";

function fixture(t: TestContext, options: Partial<NowViewOptions> = {}) {
  const root = makeTempDir("now-decisions-inputs");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now();
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const ledger = join(ledgerDir, "ledger.ndjson");
  writeFileSync(ledger, "");
  const db = openProjectorReadModel(join(root, "models"), "core", clock);
  t.after(() => db.close());
  const lease = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(lease.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: lease.lease, clock });
  const feedbackRoot = join(root, "checkout");
  mkdirSync(feedbackDir(feedbackRoot), { recursive: true });
  const planPath = join(feedbackRoot, "plan", "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T1\n  title: first\n  repo: remudero\n  depends_on: []\n  type: implement\n  risk: low\n  verify: human\n  status: queued\n");
  const feedbackPath = join(feedbackDir(feedbackRoot), "ask.yaml");
  const proposedPath = join(feedbackDir(feedbackRoot), "proposal.yaml");
  const writeEntry = (path: string, id: string, status: string, raw = "which way?") => {
    writeFileSync(path, `id: ${id}\nts: "${clock.iso()}"\nraw: "${raw}"\nstatus: ${status}\nproposal_pr: ${id === "proposal" ? PROPOSAL : "null"}\n`);
    utimesSync(path, new Date(now), new Date(now));
  };
  writeEntry(feedbackPath, "ask", "grilling");
  writeEntry(proposedPath, "proposal", "proposed");
  const calls = { list: 0, reconcile: 0, dependencies: 0 };
  const gateway = fakeGitHub({ prByRef: (ref) => {
    if (ref === PROPOSAL) { calls.reconcile++; now += 11; }
    return null;
  } });
  const view = createNowView({
    instances: [{ name: "core", ledgerDir, feedbackRoot, planPath, repo: "o/r" }], clock,
    readPlan: () => loadPlanFromYaml(readFileSync(planPath, "utf8"), planPath),
    github: () => ({ github: gateway, generation: "g", source: { asOf: null, state: "fresh" } }),
    listGrilling: () => { calls.list++; now += 7; return listFeedback(feedbackRoot); },
    dependencyGates: (input: Parameters<typeof nowDependencyVerificationGates>[0]) => {
      calls.dependencies++;
      return nowDependencyVerificationGates(input);
    },
    hostProbe: { rateLimit: () => 1, diskFree: () => 1, readLive: () => [] },
    planBehind: () => ({ commits: 0 }),
    ...options,
  });
  const context = (): NowViewContext => ({ now, switches: { views: { now: "serve" } }, instances: [{ db,
    state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: now, newestTs: null } }] });
  const build = () => {
    const bodies = view.materialize(context());
    assert.equal(bodies.length, 1);
    return bodies[0]!.data;
  };
  return { root, view, calls, build, context, planPath, feedbackRoot, feedbackPath, proposedPath, ledgerDir, writeEntry,
    advance: () => { now += NOW_REFRESH_MS; },
    append: (row: Record<string, unknown>) => {
      appendFileSync(ledger, `${JSON.stringify({ ts: clock.iso(), ...row })}\n`);
      projector.tick();
    },
  };
}

test("W1-T6254: unchanged feedback is listed and reconciled once across decisions builds", (t) => {
  const f = fixture(t);
  const first = f.build();
  f.advance();
  const second = f.build();
  assert.deepEqual(first.decisions, second.decisions);
  assert.equal(f.calls.list, 1);
  assert.equal(f.calls.reconcile, 1);
  assert.equal(f.view.stages(f.context())!["feedback.list"], 0);
  assert.equal(f.view.stages(f.context())!["feedback.reconcile"], 0);
});

test("W1-T6254: unchanged dependency inputs derive the gates once", (t) => {
  const f = fixture(t);
  const first = f.build();
  f.advance();
  const second = f.build();
  assert.equal(f.calls.dependencies, 1);
  assert.deepEqual(first.humanGates, second.humanGates);
});

test("W1-T6254: a changed input recomputes its decision source", (t) => {
  const f = fixture(t);
  assert.equal(f.build().decisions[0]!.id, "grill:ask");
  const dirBefore = statSync(feedbackDir(f.feedbackRoot)).mtimeMs;
  f.advance();
  f.writeEntry(f.feedbackPath, "ask", "answered");
  assert.equal(statSync(feedbackDir(f.feedbackRoot)).mtimeMs, dirBefore);
  assert.deepEqual(f.build().decisions, []);
  assert.equal(f.calls.list, 2);
  assert.equal(f.calls.reconcile, 2);
  assert.equal(f.calls.dependencies, 1);
  f.append({ task_id: "W1-T1", step: "run.start", run_id: "r1" });
  f.build();
  assert.equal(f.calls.dependencies, 2);
  assert.equal(f.calls.list, 2);
  assert.equal(f.calls.reconcile, 2);
});

test("feedback laps attribute listing and reconciliation separately", (t) => {
  const f = fixture(t);
  f.build();
  const stages = f.view.stages(f.context())!;
  assert.equal(stages["feedback.list"], 7);
  assert.equal(stages["feedback.overlay"], 0);
  assert.equal(stages["feedback.reconcile"], 11);
});

test("queue edits, replacement and deletion refresh feedback without waiting for the clock", (t) => {
  const f = fixture(t);
  f.build();
  const queued = queuedFeedbackDir(dirname(f.ledgerDir));
  mkdirSync(queued, { recursive: true });
  const path = join(queued, "ask.yaml");
  f.writeEntry(path, "ask", "answered");
  assert.deepEqual(f.build().decisions, []);
  const dirBefore = statSync(queued).mtimeMs;
  f.writeEntry(path, "ask", "grilling");
  assert.equal(statSync(queued).mtimeMs, dirBefore);
  assert.equal(f.build().decisions[0]!.id, "grill:ask");
  const replacement = join(queued, "replacement");
  f.writeEntry(replacement, "ask", "answered");
  renameSync(replacement, path);
  assert.deepEqual(f.build().decisions, []);
  rmSync(path);
  assert.equal(f.build().decisions[0]!.id, "grill:ask");
  assert.equal(f.calls.list, 5);
});

test("plan and github generations invalidate dependency gates; github also reconciles feedback", (t) => {
  let merged = false;
  const proposal: BoardPrRest = { number: 9, url: PROPOSAL, state: "MERGED", headRefName: "proposal",
    headRefOid: "abc", body: "", title: "proposal", updatedAt: new Date().toISOString(), autoMergeRequest: null };
  const f = fixture(t, { github: undefined, readBoardSnapshot: () => ({ closed: new Map(merged ? [[9, proposal]] : []) }) });
  assert.ok(f.build().humanGates!.gates.some((gate) => gate.key === "feedback_proposal:core:proposal"));
  f.advance();
  utimesSync(f.planPath, new Date(), new Date(Date.now() + 60_000));
  f.build();
  assert.equal(f.calls.dependencies, 2);
  assert.equal(f.calls.list, 1);
  const open = boardOpenSnapshotPath(dirname(f.ledgerDir), "o", "r");
  mkdirSync(dirname(open), { recursive: true });
  merged = true;
  writeFileSync(open, JSON.stringify({ type: "board-open-snapshot", schema: 1,
    repository: "o/r", savedAt: new Date().toISOString(), rows: [] }));
  assert.equal(f.build().humanGates!.gates.some((gate) => gate.key === "feedback_proposal:core:proposal"), false);
  assert.equal(f.calls.dependencies, 3);
  assert.equal(f.calls.list, 1);
});

test("unreadable feedback and queue reads report their reason and recover", (t) => {
  const f = fixture(t);
  f.build();
  writeFileSync(f.feedbackPath, "status: [broken");
  assert.match(f.build().decisionsReasons!.grill!, /feedback store is unreadable/);
  f.writeEntry(f.feedbackPath, "ask", "grilling");
  assert.equal(f.build().decisions[0]!.id, "grill:ask");
  const queued = queuedFeedbackDir(dirname(f.ledgerDir));
  mkdirSync(queued, { recursive: true });
  const path = join(queued, "ask.yaml");
  writeFileSync(path, "id: ask\nstatus: [broken");
  assert.match(f.build().decisionsReasons!.grill!, /landing queue is unreadable/);
  f.writeEntry(path, "ask", "answered");
  const recovered = f.build();
  assert.deepEqual(recovered.decisions, []);
  assert.equal(recovered.decisionsReasons?.grill, undefined);
});

test("default dependency derivation remains available without an injected seam", (t) => {
  const f = fixture(t, { dependencyGates: undefined });
  const data = f.build();
  assert.ok(data.humanGates!.sources.some((source) => source.name === "dependency-review"));
  assert.equal(f.calls.dependencies, 0);
});

test("an unreadable feedback identity reports the failed read instead of reusing successful feedback", (t) => {
  const f = fixture(t, { listGrilling: undefined });
  assert.equal(f.build().decisions[0]!.id, "grill:ask");
  const readDir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof readDir>) => {
    if (args[0] === feedbackDir(f.feedbackRoot)) throw Object.assign(new Error("feedback access denied"), { code: "EACCES" });
    return Reflect.apply(readDir, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const unavailable = f.build();
  assert.deepEqual(unavailable.decisions, []);
  assert.match(unavailable.decisionsReasons!.grill!, /feedback access denied/);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(f.build().decisions[0]!.id, "grill:ask");
});
