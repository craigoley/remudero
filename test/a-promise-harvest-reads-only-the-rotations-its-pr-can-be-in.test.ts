import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { ghShim } from "./helpers/gh-shim.js";
import { judgeReview, postReviewStatusGuarded, recoverPromisedFollowUpReports, reviewDecisionDigest, type PromisedFollowUpObservation } from "../src/lib/review.js";
import { checksStateFromRollup, DEFAULT_SWEEP_POLICY, runSweep, runSweepLightPass, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";

const taskId = "W1-T8775", prUrl = "https://github.com/o/r/pull/11255", headSha = "a".repeat(40);
const promise = { path: "docs/adr/example.md", text: "file the child task", taskId };
const observation: PromisedFollowUpObservation = { state: "complete", promised: [promise], planRecords: [] };
const criteria = [{ claim: "example", proof: "grep: example in src/example.ts" }];
const evidence = { diff: "+++ b/src/example.ts\n@@\n+example", report: "example", headCheckoutDir: "/unused", execProof: () => "pass" as const };
const firstRun = "2026-10-12T10:00:00.000Z";
const reportRow = { task_id: taskId, pr_url: prUrl, step: "report.followups", entries: [{ type: "task", text: promise.text }] };
const line = (row: object) => JSON.stringify(row) + "\n";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-promise-age-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, line({ step: "dispatch.claim", task_id: taskId, ts: firstRun }));
  return { dir, ledgerPath, taskId, prUrl };
}

test("W1-T9001: a promise harvest reads only the rotations its PR can be in", async t => {
  const args = fixture(t), opened: string[] = [];
  const old = "ledger.2026-10-11T00-00-00-000Z.ndjson.gz";
  const boundary = "ledger.2026-10-12T10-00-00-000Z.ndjson";
  const fresh = "ledger.2026-10-12T11-00-00-000Z.ndjson.gz";
  writeFileSync(join(args.dir, old), gzipSync(line({ step: "unrelated" })));
  for (let day = 1; day <= 30; day++) {
    const stem = `ledger.2026-09-${String(day).padStart(2, "0")}T00-00-00-000Z.ndjson`;
    writeFileSync(join(args.dir, day % 2 ? stem : `${stem}.gz`), day % 2 ? line({ step: "unrelated" }) : gzipSync(line({ step: "unrelated" })));
  }
  writeFileSync(join(args.dir, boundary), line({ ...reportRow, pr_url: prUrl + "0" }));
  writeFileSync(join(args.dir, fresh), gzipSync(line(reportRow)));
  writeFileSync(args.ledgerPath, line({ step: "run.start", task_id: taskId, ts: "2026-10-12T12:00:00.000Z" }) +
    line({ step: "run.start", task_id: "foreign", ts: "2026-08-08T00:00:00.000Z" }) +
    line({ step: "dispatch.claim", task_id: taskId, ts: firstRun }));
  const result = await recoverPromisedFollowUpReports(observation, { ...args, prCreatedAt: "2026-10-12T13:00:00.000Z",
    io: { readdirSync, existsSync, createReadStream: (path, options) => { opened.push(basename(path)); return createReadStream(path, options); } },
  });
  assert.equal(result.state, "complete");
  assert.deepEqual(opened, ["ledger.ndjson", boundary, fresh]);
  assert.equal(judgeReview(criteria, { ...evidence, promisedFollowUpObservation: result }).state, "success");
  if (result.state === "complete") assert.deepEqual(result.harvested, reportRow.entries);
});

test("the PR creation time bounds a harvest when the live task start is unavailable", async t => {
  const args = fixture(t), opened: string[] = [];
  writeFileSync(args.ledgerPath, "");
  const old = "ledger.2026-10-11T00-00-00-000Z.ndjson";
  const fresh = "ledger.2026-10-12T10-00-00-000Z.ndjson.gz";
  writeFileSync(join(args.dir, old), line({ step: "unrelated" }));
  writeFileSync(join(args.dir, fresh), gzipSync(line(reportRow)));
  let reads = 0;
  const result = await recoverPromisedFollowUpReports(observation, { ...args,
    fetchPrCreatedAt: async url => { assert.equal(url, prUrl); reads++; return firstRun; },
    io: { readdirSync, existsSync, createReadStream: (path, options) => { opened.push(basename(path)); return createReadStream(path, options); } },
  });
  assert.equal(reads, 1);
  assert.equal(result.state, "complete");
  assert.deepEqual(opened, ["ledger.ndjson", fresh]);
});

test("a later live retry cannot hide a report archived after the PR was created", async t => {
  for (const suppliedAge of [true, false]) {
    const args = fixture(t), opened: string[] = [];
    writeFileSync(args.ledgerPath, line({ step: "run.start", task_id: taskId, ts: "2026-10-13T00:00:00.000Z" }));
    const old = "ledger.2026-10-11T00-00-00-000Z.ndjson";
    const report = "ledger.2026-10-12T11-00-00-000Z.ndjson.gz";
    writeFileSync(join(args.dir, old), line({ step: "unrelated" }));
    writeFileSync(join(args.dir, report), gzipSync(line(reportRow)));
    let ageReads = 0;
    const result = await recoverPromisedFollowUpReports(observation, { ...args,
      ...(suppliedAge ? { prCreatedAt: firstRun } : {}),
      fetchPrCreatedAt: async url => { assert.equal(url, prUrl); ageReads++; return firstRun; },
      io: { readdirSync, existsSync, createReadStream: (path, options) => {
        opened.push(basename(path)); return createReadStream(path, options);
      } },
    });
    assert.equal(ageReads, suppliedAge ? 0 : 1);
    assert.deepEqual(opened, ["ledger.ndjson", report]);
    assert.equal(result.state, "complete");
    if (result.state === "complete") assert.deepEqual(result.harvested, reportRow.entries);
    assert.equal(judgeReview(criteria, { ...evidence, promisedFollowUpObservation: result }).state, "success");
  }
});

test("the default PR-age reader obtains the creation time through the REST transport", async t => {
  const args = fixture(t);
  writeFileSync(args.ledgerPath, "");
  writeFileSync(join(args.dir, "ledger.2026-10-12T10-00-00-000Z.ndjson"), line(reportRow));
  const shim = ghShim([{ when: "repos/o/r/pulls/11255", stdout: JSON.stringify({ created_at: firstRun }) }]);
  const priorPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${priorPath}`;
  t.after(() => { process.env.PATH = priorPath; rmSync(shim.dir, { recursive: true, force: true }); });
  const result = await recoverPromisedFollowUpReports(observation, args);
  assert.equal(result.state, "complete");
  if (result.state === "complete") assert.deepEqual(result.harvested, reportRow.entries);
  assert.deepEqual(shim.calls(), ["api repos/o/r/pulls/11255"]);
});

test("an unavailable PR age never falls back to an unbounded harvest or proves a missing promise", async t => {
  for (const route of [
    { stdout: JSON.stringify({}) },
    { stdout: JSON.stringify({ created_at: "unreadable timestamp" }) },
    { stderr: "PR metadata unavailable", exit: 1 },
  ]) {
    const args = fixture(t), opened: string[] = [];
    writeFileSync(args.ledgerPath, "");
    writeFileSync(join(args.dir, "ledger.2026-08-08T00-00-00-000Z.ndjson.gz"), gzipSync(line(reportRow)));
    const shim = ghShim([{ when: "repos/o/r/pulls/11255", ...route }]);
    const priorPath = process.env.PATH;
    process.env.PATH = `${shim.dir}:${priorPath}`;
    let result: PromisedFollowUpObservation;
    try {
      result = await recoverPromisedFollowUpReports(observation, { ...args,
        io: { readdirSync, existsSync, createReadStream: (path, options) => {
          opened.push(basename(path)); return createReadStream(path, options);
        } },
      });
    } finally {
      process.env.PATH = priorPath;
      rmSync(shim.dir, { recursive: true, force: true });
    }
    assert.deepEqual(opened, ["ledger.ndjson"], "an unreadable bound must not open any archive");
    assert.equal(result.state, "unknown");
    if (result.state === "unknown") assert.equal(result.cause, "promise-harvest-incomplete");
    const verdict = judgeReview(criteria, { ...evidence, promisedFollowUpObservation: result });
    assert.equal(verdict.state, "pending", "the unreadable age proves neither satisfaction nor absence");
    assert.equal(verdict.criteria.at(-1)?.loadError, undefined);
  }
});

test("W1-T9001: an unfinished harvest is transient and never asks to repair the toolchain", async t => {
  for (const source of ["live", "archive"]) {
    for (const error of [new DOMException("cancelled", "AbortError"), new Error("EACCES")]) {
      const args = fixture(t);
      const archive = "ledger.2026-10-12T11-00-00-000Z.ndjson.gz";
      if (source === "archive") writeFileSync(join(args.dir, archive), gzipSync(line(reportRow)));
      const opened: string[] = [];
      const controller = new AbortController();
      const result = await recoverPromisedFollowUpReports(observation, { ...args,
        prCreatedAt: firstRun, signal: controller.signal,
        io: { readdirSync, existsSync, createReadStream: (path, options) => {
          opened.push(basename(path));
          if (source === "archive" && basename(path) !== archive) return createReadStream(path, options);
          if (error.name === "AbortError") { controller.abort(error); return createReadStream(path, options); }
          throw error;
        } },
      });
      assert.deepEqual(opened, source === "archive" ? ["ledger.ndjson", archive] : ["ledger.ndjson"]);
      assert.equal(result.state, "unknown");
      if (result.state === "unknown") assert.equal(result.cause, "promise-harvest-incomplete");
      if (result.state === "unknown" && error.name === "AbortError") assert.match(result.reason, /AbortError/);
      const verdict = judgeReview(criteria, { ...evidence, promisedFollowUpObservation: result });
      assert.equal(verdict.state, "pending");
      assert.equal(verdict.criteria.at(-1)?.cause, "promise-harvest-incomplete");
      assert.equal(verdict.criteria.at(-1)?.loadError, undefined);
      for (const description of [verdict.summary, `remudero-review: cannot-evaluate — ${result.state === "unknown" ? result.reason : ""}`]) {
        let issues = 0;
        const posted = await postReviewStatusGuarded({ owner: "o", repo: "r", sha: headSha, taskId, prUrl,
          ledgerPath: args.ledgerPath, runId: "harvest-review", state: verdict.state, description,
          evidence: "no_evidence", fetchLifecycle: () => ({ merged: false, closed: false }), post: () => {},
          issues: { listOpen: () => [], create: () => { issues++; return "https://github.com/o/r/issues/1"; } },
        });
        assert.equal(posted.posted, true);
        assert.equal(issues, 0);
        assert.doesNotMatch(readFileSync(args.ledgerPath, "utf8"), /review.cannot_evaluate_escalated|Repair reviewer toolchain/);
      }
      const input = { headSha, ...evidence, acceptance: criteria };
      assert.equal(reviewDecisionDigest({ ...input, promisedFollowUpObservation: result }), reviewDecisionDigest(input));
    }
  }
});

test("a damaged selected rotation cannot prove that a promised report is absent", async t => {
  for (const contents of [
    "not gzip",
    gzipSync("{broken json}\n"),
    gzipSync(line({ ...reportRow, entries: null })),
    gzipSync(line({ ...reportRow, entries: [null, { type: "task", text: "two\nlines" }] })),
  ]) {
    const args = fixture(t);
    writeFileSync(join(args.dir, "ledger.2026-10-12T11-00-00-000Z.ndjson.gz"), contents);
    const result = await recoverPromisedFollowUpReports(observation, { ...args, prCreatedAt: firstRun });
    assert.equal(result.state, "unknown", "a damaged corpus proves neither satisfaction nor absence");
    if (result.state === "unknown") assert.equal(result.cause, "promise-harvest-incomplete");
    const verdict = judgeReview(criteria, { ...evidence, promisedFollowUpObservation: result });
    assert.equal(verdict.state, "pending");
    assert.equal(verdict.criteria.at(-1)?.loadError, undefined);
    assert.match(verdict.summary, /promise-harvest-incomplete/);
  }
  const args = fixture(t);
  const result = await recoverPromisedFollowUpReports(observation, { ...args, prCreatedAt: firstRun });
  assert.equal(result.state, "complete", "an intact empty corpus is a positive control for absence");
  if (result.state === "complete") assert.equal(result.harvestCorpusComplete, true);
  assert.equal(judgeReview(criteria, { ...evidence, promisedFollowUpObservation: result }).state, "failure");
});

test("W1-T9001: a head held only by an unfinished harvest is reviewed again", async t => {
  const now = Date.now();
  for (const cause of ["promise-harvest-incomplete", undefined]) {
    const args = fixture(t);
    const pending = { state: "unknown", reason: "promise harvest unavailable: AbortError: aborted", ...(cause ? { cause } : {}) };
    writeFileSync(args.ledgerPath, line({ step: "review.posted", task_id: taskId, pr_url: prUrl, head_sha: headSha,
      state: "pending", ts: new Date(now).toISOString(), decision_verdict: { state: "pending", promisedFollowUpObservation: pending } }));
    const checksState = checksStateFromRollup([{ name: "ci", conclusion: "SUCCESS" }, { name: "CodeQL", conclusion: "FAILURE" }], ["ci", "remudero-review"]);
    assert.equal(checksState, "green");
    const pr: OpenPrView = { prNumber: 11255, prUrl, taskId, headSha, reviewState: "pending", checksState,
      reviewPendingSince: new Date(now).toISOString(), lastActivityAt: new Date(now).toISOString(),
      unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false };
    let reviews = 0, escalations = 0;
    const deps: SweepDeps = { ledgerPath: args.ledgerPath, runId: "promise-sweep", now: () => now,
      arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => { escalations++; },
      postReview: p => { assert.equal(p.headSha, headSha); reviews++; },
    };
    const summary = await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(reviews, 1, JSON.stringify(summary));
    assert.equal(escalations, 0);
    const admitted = readFileSync(args.ledgerPath, "utf8").split("\n").filter(Boolean).map(raw => JSON.parse(raw)).find(row => row.step === "sweep.review_admitted");
    assert.equal(admitted?.prior_cause, "promise-harvest-incomplete");
    await runSweepLightPass([pr], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(reviews, 2, "the light pass also admits this same pending head");
    writeFileSync(args.ledgerPath, readFileSync(args.ledgerPath, "utf8") + line({ step: "review.pending_posted", task_id: taskId, pr_url: prUrl, head_sha: headSha, ts: new Date(now + 1).toISOString() }));
    await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(reviews, 2, "a newer pending owner is still in flight");
  }
});

test("a legacy harvest hold recovers from its archive and the next sweep arms the same head", async t => {
  const args = fixture(t), now = Date.now(), reviewInputDigest = "same-input";
  writeFileSync(join(args.dir, "ledger.2026-10-12T11-00-00-000Z.ndjson.gz"), gzipSync(line(reportRow)));
  writeFileSync(args.ledgerPath, line({ step: "review.posted", task_id: taskId, pr_url: prUrl,
    head_sha: headSha, review_input_digest: reviewInputDigest, state: "pending", ts: new Date(now).toISOString(),
    decision_verdict: { state: "pending", criteria: [{ proof_exec: "cannot_evaluate",
      loadError: "promise harvest unavailable: AbortError: aborted" }],
      promisedFollowUpObservation: { state: "unknown", reason: "promise harvest unavailable: AbortError: aborted" } } }));
  const pr: OpenPrView = { prNumber: 11255, prUrl, taskId, headSha, reviewInputDigest,
    reviewState: "pending", checksState: "green", reviewPendingSince: new Date(now).toISOString(),
    lastActivityAt: new Date(now).toISOString(), unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false };
  let reviews = 0, arms = 0;
  const deps: SweepDeps = { ledgerPath: args.ledgerPath, runId: "harvest-recovery", now: () => now,
    arm: p => { assert.equal(p.headSha, headSha); arms++; }, close: () => { assert.fail("recovery cannot close the PR"); },
    dispatchFix: () => { assert.fail("recovery needs no fix worker"); },
    escalate: () => { assert.fail("recovery needs no escalation"); },
    postReview: async p => {
      reviews++;
      const recovered = await recoverPromisedFollowUpReports(observation, { ...args, prCreatedAt: firstRun });
      const verdict = judgeReview(criteria, { ...evidence, promisedFollowUpObservation: recovered });
      assert.equal(verdict.state, "success");
      const posted = await postReviewStatusGuarded({ owner: "o", repo: "r", sha: p.headSha,
        taskId, prUrl, reviewInputDigest, ledgerPath: args.ledgerPath, runId: "harvest-recovered",
        state: verdict.state, description: verdict.summary, evidence: "executed",
        fetchLifecycle: () => ({ merged: false, closed: false }), post: status => { pr.reviewState = status.state; },
      });
      assert.equal(posted.posted, true);
      writeFileSync(args.ledgerPath, readFileSync(args.ledgerPath, "utf8") + line({ step: "review.posted",
        task_id: taskId, pr_url: prUrl, head_sha: headSha, review_input_digest: reviewInputDigest,
        state: verdict.state, decision_verdict: verdict, capped: verdict.capped, plan_only: verdict.planOnly,
        proof_exec: verdict.criteria.map(criterion => criterion.proof_exec), ts: new Date(now + 1).toISOString() }));
    },
  };
  const summary = await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(reviews, 1, "the legacy attributed hold must release its delivered input key");
  assert.equal(pr.reviewState, "success", JSON.stringify(summary));
  const rows = readFileSync(args.ledgerPath, "utf8").split("\n").filter(Boolean).map(raw => JSON.parse(raw));
  assert.equal(rows.find(row => row.step === "sweep.review_admitted")?.prior_cause, "promise-harvest-incomplete");
  assert.equal(rows.findLast(row => row.step === "review.posted")?.state, "success");
  const recoveredSweep = await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(reviews, 1, "a recovered terminal status must not repeat the harvest retry");
  assert.equal(arms, 1, JSON.stringify(recoveredSweep) + readFileSync(args.ledgerPath, "utf8"));
});
