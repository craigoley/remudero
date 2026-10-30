import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { runMeasurementCadenceReport } from "#src/lib/measurement-cadence.js";
import { captureFeedbackReply } from "#src/lib/panel-graph.js";
import { captureFeedback } from "#src/lib/feedback.js";
import { injectCoverageImprovementTask } from "#src/lib/coverage-improvement.js";
import { handRunCensus } from "#src/lib/hand-run-census.js";
import { readQueuedFeedbackRecords, queuedFeedbackLandings } from "#src/lib/feedback-landing.js";
import { readEscalationAnswers } from "#src/lib/escalation-answers.js";
import { renderIssueBody } from "#src/lib/escalate.js";
import { consumeSourceSizeFollowup } from "#src/lib/source-size-followup.js";

const sweepRoot = mkdtempSync(join(tmpdir(), "rmd-w9734-sweep-"));
after(() => rmSync(sweepRoot, { recursive: true, force: true }));
const savedArgv = [...process.argv];
process.argv.push("--repo-root", sweepRoot);
let cli: typeof import("#src/run-task.js");
try { cli = await import("#src/run-task.js"); }
finally { process.argv.splice(0, process.argv.length, ...savedArgv); }
const { buildSweepEffects, captureRepairFeedbackWithPriorVerdict, depReviewCommand } = cli;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w9734-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "checkout"), stateRoot = join(dir, "home"), stateDir = join(stateRoot, "state");
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, stateRoot, stateDir, ledgerPath: join(stateDir, "ledger.ndjson") };
}

function union(stateDir: string, matches: string[] = []) {
  return { stateDir, matches, ok: true, archiveFiles: ["fixture"], archiveCount: 1, liveFileRead: true, unread: [] };
}

async function observeLanding<T>(run: () => T | Promise<T>) {
  const calls: string[][] = [];
  const real = childProcess.execFileSync;
  mock.method(childProcess, "execFileSync", (file: string, args: string[], opts: object) => {
    if (file === "git" && args.join(" ") === `-C ${sweepRoot} config --get remote.origin.url`) {
      return "https://github.com/fixture/repo.git\n";
    }
    if (args?.some(a => /^(fetch|push|ls-remote|worktree|commit-tree|read-tree|hash-object)$/.test(a))) {
      calls.push([file, ...args]);
      throw new Error("synchronous landing is forbidden in this fixture");
    }
    return real(file, args, opts);
  });
  syncBuiltinESMExports();
  try { return { result: await run(), calls }; }
  finally { mock.restoreAll(); syncBuiltinESMExports(); }
}

test("W1-T9734: the measurement cadence captures stage for the async sweep", async t => {
  const f = fixture(t);
  const rows = ["2026-09-01", "2026-09-02"].flatMap((day, i) => ["status", "triage"].map((step, n) =>
    JSON.stringify({ actor: "operator_human", actor_pid: i + 100, step, ts: `${day}T09:0${n}:00.000Z` })));
  let preflights = 0;
  const land = { planPrPreflight: () => { preflights++; throw new Error("inline preflight"); } };
  const opts = {
    ...f, landingStateRoot: f.stateRoot, cwd: f.root, checkoutDir: f.root, escalate: false,
    gitLog: () => ({ dump: "", ref: "fixture" }), ledgerUnion: () => union(f.stateDir),
    coverageImprovement: {
      root: f.root, owner: "fixture", repo: "repo", land,
      reader: () => ({ status: "read" as const, lcovText: "SF:src/debt.ts\nBRF:100\nBRH:85\nend_of_record\n",
        workflowRunId: 1, headSha: "head", artifactId: 1, prNumber: 1 }),
      ledgerUnion: () => union(f.stateDir),
    },
    handRunCensus: {
      root: f.root, runId: "fixture", ledgerPath: f.ledgerPath, land,
      ledgerUnion: (_dir: string, pattern: RegExp) => union(f.stateDir, String(pattern).includes("census_proposed") ? [] : rows),
    },
  };
  const observed = await observeLanding(() => runMeasurementCadenceReport(opts));
  assert.equal(observed.result.coverageImprovement?.producerAction, "filed");
  assert.equal(observed.result.handRunCensus?.status, "measured");
  assert.equal(observed.result.handRunCensus?.status === "measured" && observed.result.handRunCensus.proposedSignatures.length, 1);
  assert.equal(preflights, 0);
  assert.deepEqual(observed.calls, []);
  const queued = readQueuedFeedbackRecords(f.stateRoot);
  assert.equal(queued.size, 2);
  assert.ok([...queued.values()].some(entry => String(entry.raw).includes("src/debt.ts")));
  assert.ok([...queued.values()].some(entry => String(entry.raw).includes("status → triage")));
  for (const rel of queued.keys()) assert.equal(existsSync(join(f.root, rel)), false);
});

test("W1-T9734: the grilled reply and the repair capture stage for the async sweep", async t => {
  const f = fixture(t), parent = "fb-grilled";
  const effects = buildSweepEffects({
    owner: "fixture", repo: "repo", localRepoName: "repo", repoRoot: sweepRoot,
    config: { root: f.stateRoot } as never, ledgerPath: f.ledgerPath, runId: "fixture",
    plan: { tasks: [], byId: new Map() }, log: () => {}, instanceRegistryTextImpl: () => undefined,
  });
  const repair = { id: "repair-no-root", raw: "- PR #2\nrepair failed", origin: "repair#other" };
  writeFileSync(join(f.root, "plan", "feedback", `${parent}.yaml`), stringify({
    id: parent, ts: new Date().toISOString(), raw: "choose the owner", attachments: [], origin: "cli", status: "grilling",
  }));
  const issue = { number: 1, url: "https://github.com/fixture/repo/issues/1", body: renderIssueBody({
    class: "GRILL", taskId: `TRIAGE-${parent}`, summary: "choose the owner", detail: "ownership question",
    options: [{ label: "site", detail: "site owns it" }, { label: "core", detail: "core owns it" }], recommendation: "site",
  }) };
  const observed = await observeLanding(async () => {
    const result = await readEscalationAnswers(f.root, "fixture", {
      listOpen: () => [issue], listComments: () => [{ id: 1, body: "site", authorLogin: "fixture", authorAssociation: "OWNER", authorType: "User" }],
      reactPlusOne: () => {},
    }, { ledgerPath: f.ledgerPath, feedback: { root: f.root, inboxRoot: f.stateRoot, feedbackLand: {} } });
    captureRepairFeedbackWithPriorVerdict(f.root, { id: "repair-window", raw: "- PR #1\nrepair failed", origin: "repair#fixture" }, () => {}, f.stateRoot);
    await effects.captureRepairFeedback!(repair);
    return result;
  });
  assert.equal(observed.result.accepted, 1);
  assert.deepEqual(observed.calls, []);
  const queued = readQueuedFeedbackRecords(f.stateRoot);
  const reply = [...queued.values()].find(entry => entry.reply_to === parent);
  assert.ok(reply);
  assert.equal(queued.get(`plan/feedback/${parent}.yaml`)?.status, "answered");
  assert.equal(queued.get(`plan/feedback/${parent}.yaml`)?.answered_by, reply.id);
  assert.ok(queued.has("plan/feedback/repair-window.yaml"));
  assert.equal(existsSync(join(f.root, "plan/feedback", `${reply.id}.yaml`)), false);
  assert.equal(queued.get("plan/feedback/repair-no-root.yaml")?.raw, repair.raw);
  assert.equal(queued.get("plan/feedback/repair-no-root.yaml")?.origin, repair.origin);
  assert.equal(existsSync(join(sweepRoot, "plan/feedback/repair-no-root.yaml")), false);
  const before = [...queued.entries()];
  captureRepairFeedbackWithPriorVerdict(f.root, { id: "repair-window", raw: "changed", origin: "repair#fixture" }, () => {}, f.stateRoot);
  await effects.captureRepairFeedback!({ ...repair, raw: "changed" });
  assert.deepEqual([...readQueuedFeedbackRecords(f.stateRoot).entries()], before);
});

test("W1-T9734: the panel reply still captures inline", t => {
  const f = fixture(t);
  let captures = 0;
  const result = captureFeedbackReply({ root: f.root, inboxRoot: f.stateRoot }, {
    text: "a panel submission", origin: "ui", submissionKey: "panel-one",
  }, undefined, (root, opts) => {
    captures++;
    assert.equal(opts.land?.stateRoot, f.stateRoot);
    const entry = captureFeedback(root, opts);
    assert.equal(existsSync(join(root, "plan/feedback", `${entry.id}.yaml`)), true);
    return entry;
  });
  assert.equal(captures, 1);
  assert.equal(result.entry.origin, "ui");
  assert.equal(result.landingError, undefined);
  assert.deepEqual(queuedFeedbackLandings(f.stateRoot), [`plan/feedback/${result.entry.id}.yaml`]);
});

test("W1-T9734: the worker source-size follow-up stages its default capture", async t => {
  const f = fixture(t), head = "b".repeat(40);
  const report = { schema_version: 1, base: "a".repeat(40), head, hotspots: [
    { path: "src/debt.ts", before_lines: 900, after_lines: 1200, delta_lines: 300, delta_percent: 33.33 },
  ] };
  const observed = await observeLanding(() => consumeSourceSizeFollowup({
    ...f, worktreeRoot: f.root, expectedHead: head, runId: "fixture", sourceTask: "W1-T9734",
    ledgerUnion: () => union(f.stateDir),
    readFile: () => JSON.stringify({ ok: true, headSha: head, steps: [{ name: "source-size", ok: true,
      successOutput: { text: `source-size-signal-json: ${JSON.stringify(report)}`, truncated: false } }] }),
  }));
  assert.equal(observed.result.action, "filed");
  assert.deepEqual(observed.calls, []);
  assert.equal(readQueuedFeedbackRecords(f.stateRoot).size, 1);
});

test("W1-T9734: daemon dependency migration captures use the wired state root and deduplicate the queue", async t => {
  for (const explicit of [false, true]) await t.test(explicit ? "explicit state root" : "state root from config", async t => {
    const f = fixture(t);
    const view = { number: 1, url: "https://github.com/fixture/repo/pull/1",
      title: "build(deps-dev): bump @types/node from 22.20.1 to 26.1.1",
      body: "Bumps [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) from 22.20.1 to 26.1.1.",
      headRefOid: "a".repeat(40), author: { login: "app/dependabot" },
      statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] };
    const mutations: string[] = [];
    const run = () => depReviewCommand("1", ["--repo", "fixture/repo"], {
      root: f.root, ...(explicit ? { landingStateRoot: f.stateRoot } : {}),
      config: { root: f.stateRoot, ledger: f.ledgerPath } as never,
      gh: args => args[0] === "api" ? { state: "open", merged: false, head: { sha: view.headRefOid }, body: view.body } : view,
      prDiff: () => 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-"@types/node": "^22.20.1"\n+"@types/node": "^26.1.1"\n',
      contributorAdmission: async () => {},
      issues: { create: () => { throw new Error("unexpected issue"); } } as never,
      postStatus: async () => { throw new Error("unexpected status"); }, arm: () => { throw new Error("unexpected arm"); },
      prMutations: {
        comment: () => { assert.equal(readQueuedFeedbackRecords(f.stateRoot).size, 1); mutations.push("comment"); },
        close: () => { mutations.push("close"); },
      },
    });
    const observed = await observeLanding(run);
    assert.equal(observed.result, 0);
    assert.deepEqual(observed.calls, []);
    assert.deepEqual(mutations, ["comment", "close"]);
    const before = [...readQueuedFeedbackRecords(f.stateRoot).entries()];
    assert.equal(before.length, 1);
    assert.equal(before[0][1].origin, "repair#dep-review");
    assert.equal(existsSync(join(f.root, before[0][0])), false);
    const repeated = await observeLanding(run);
    assert.equal(repeated.result, 0);
    assert.deepEqual(repeated.calls, []);
    assert.deepEqual([...readQueuedFeedbackRecords(f.stateRoot).entries()], before);
  });
});

test("W1-T9734: operator coverage and hand-run verbs keep inline capture", async t => {
  const f = fixture(t);
  const rows = ["2026-09-01", "2026-09-02"].flatMap((day, i) => ["status", "triage"].map((step, n) =>
    JSON.stringify({ actor: "operator_human", actor_pid: i + 100, step, ts: `${day}T09:0${n}:00.000Z` })));
  const observed = await observeLanding(() => {
    const coverage = injectCoverageImprovementTask({ ...f, runId: "cli",
      lcovText: "SF:src/debt.ts\nBRF:100\nBRH:85\nend_of_record\n", ledgerUnion: () => union(f.stateDir) });
    const census = handRunCensus({ ...f, runId: "cli",
      ledgerUnion: (_dir, pattern) => union(f.stateDir, String(pattern).includes("census_proposed") ? [] : rows) });
    return { coverage, census };
  });
  assert.equal(observed.result.coverage.action, "filed");
  assert.equal(observed.result.census.status, "measured");
  assert.equal(observed.calls.length, 2, "both CLI producers attempt inline landing");
  assert.equal(readQueuedFeedbackRecords(f.stateRoot).size, 0);
});
