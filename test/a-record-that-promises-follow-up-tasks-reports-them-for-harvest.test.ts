import assert from "node:assert/strict";
import { test } from "node:test";
import { promisedFollowUps, unreportedFollowUps, parseHarvestableFollowUps } from "../src/lib/promised-follow-ups.js";
import { judgeReview, observePromisedFollowUps, recoverPromisedFollowUpReports, preparePromisedReviewDecision, reviewDecisionDigest, reviewInputDigest, REVIEW_ENGINE_REVISION, type PromisedFollowUpObservation } from "../src/lib/review.js";
import { parseFollowups } from "../src/lib/worker.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitRepo } from "./helpers/git-repo.js";
import { gzipSync } from "node:zlib";

const path = "docs/adr/0007-example.md";
const adr = "# Decision\n\n- Follow-up tasks this record files:\n  - source-keyed child bundle store\n    with atomic publication;\n  - bounded heavy READY escalation\n\n## Other\n- not promised\n";
const promises = [{ path, text: "source-keyed child bundle store with atomic publication;", taskId: "W1-T7729" }, { path, text: "bounded heavy READY escalation", taskId: "W1-T7729" }];
const diff = `diff --git a/${path} b/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
const criteria = [{ claim: "a real change", proof: "grep: example in src/example.ts" }];
const observation = (promised = promises, records: Array<{ id: string; title: string; plan_refs: string[] }> = []) => ({
  state: "complete" as const, headSha: "a".repeat(40), baseSha: "b".repeat(40), promised, planRecords: records,
});
function review(report = "", supplied: PromisedFollowUpObservation = observation()) {
  return judgeReview(criteria, {
    diff, report: "a real change", implementationReport: report,
    headCheckoutDir: "/unused", execProof: () => "pass",
    ...({ promisedFollowUpObservation: supplied } as object),
  });
}

test("W1-T8779: an ADR follow-up missing from the report blocks the review", () => {
  const result = review();
  assert.equal(result.state, "failure");
  const unmet = result.criteria.find(c => c.claim === "promised follow-ups reported for harvest");
  assert.equal(unmet?.met, false);
  assert.ok(unmet?.reason.includes("bounded heavy READY escalation"));
});

test("W1-T8779: reported or filed follow-ups satisfy the promise", () => {
  const reported = "## Follow-ups\ntask: source-keyed child bundle store with atomic publication; — avoid duplicate builds\n";
  const filed = [{ id: "W1-T9999", title: "bounded heavy READY escalation", plan_refs: ["W1-T7729"] }];
  assert.deepEqual(unreportedFollowUps(promises, reported, filed), []);
  const satisfied = review(reported, observation(promises, filed));
  assert.equal(satisfied.state, "success");
  assert.equal(satisfied.criteria.length, criteria.length, "a satisfied structural guard invents no unexecuted proof or arm blocker");
  assert.deepEqual(unreportedFollowUps(promises, reported, [{ ...filed[0]!, plan_refs: ["W1-T7728"] }]), [promises[1]]);
});

test("W1-T8779: a PR with no promised follow-ups is unaffected", () => {
  const base = { diff: "+++ b/src/example.ts\n@@\n+export const example = 1;", report: "a real change" };
  assert.deepEqual(judgeReview(criteria, { ...base, ...({ promisedFollowUpObservation: observation([]) } as object) }), judgeReview(criteria, base));
});

test("promise lists retain wrapped bullets and stop before unrelated sections", () => {
  assert.deepEqual(promisedFollowUps([path, "README.md"], p => { assert.equal(p, path); return adr; }), promises.map(({ taskId: _id, ...p }) => p));
});

test("task designs carry their own promise owner and unrelated rationale is ignored", () => {
  const taskPath = "plan/tasks.d/W1-T9000-fixture.yaml";
  const yaml = '- id: W1-T9000\n  rationale: "Follow-up tasks this record files: is prose"\n  design: |\n    Follow-up tasks this record files:\n    - source-keyed child bundle store\n';
  assert.deepEqual(promisedFollowUps([taskPath], () => yaml), [{ path: taskPath, taskId: "W1-T9000", text: "source-keyed child bundle store" }]);
});

test("quoted examples, fenced code and similarly worded prose are not promises", () => {
  for (const text of ['```md\nFollow-up tasks this record files:\n- example\n```', '> Follow-up tasks this record files:\n> - example', 'We discuss "Follow-up tasks this record files:" here.\n- example']) {
    assert.deepEqual(promisedFollowUps([path], () => text), []);
  }
});

test("only harvestable typed entries in the actual Follow-ups section count", () => {
  for (const report of [adr, "## Follow-ups\n- bounded heavy READY escalation", "## Summary\ntask: bounded heavy READY escalation", "## Follow-ups\n## Other\ntask: bounded heavy READY escalation", "## Follow-ups\ntask: bounded heavy READY escalation extended"]) {
    assert.deepEqual(unreportedFollowUps([promises[0]!], report, []), [promises[0]]);
  }
  assert.deepEqual(unreportedFollowUps([promises[1]!], "## Follow-ups\ntask: unrelated escalation", []), [promises[1]]);
});

test("the guard and real worker harvest share exactly one parser grammar", () => {
  for (const text of ["", "## follow-ups\n- Action: do the thing", "## Follow-ups\nresearch: first\ntask: second\n## Other\naction: outside", "## Follow-ups\nplain prose", "## Follow-ups\n\nTASK: source-keyed child bundle store\n"]) {
    assert.deepEqual(parseHarvestableFollowUps(text), parseFollowups(text));
  }
});

test("unreadable promise files are not silently certified as empty", () => {
  assert.throws(() => promisedFollowUps([path], () => { throw new Error("EACCES"); }), /EACCES/);
});

test("a later filing rearms the same-head decision but unrelated main churn does not", () => {
  const input = { headSha: "a".repeat(40), diff, report: "body", acceptance: criteria, promisedFollowUpObservation: observation() };
  const prior = reviewDecisionDigest(input);
  assert.equal(prior, reviewDecisionDigest({ ...input, promisedFollowUpObservation: { ...observation(), baseSha: "c".repeat(40) } }));
  assert.notEqual(prior, reviewDecisionDigest({ ...input, promisedFollowUpObservation: observation(promises, [{ id: "W1-T9999", title: promises[0]!.text, plan_refs: ["W1-T7729"] }]) }));
  assert.notEqual(reviewInputDigest(input.headSha, input.report), reviewInputDigest(input.headSha, input.report, "reviewer-scope-context-v2"));
  assert.equal(REVIEW_ENGINE_REVISION, "promised-followups-snapshot-v3");
});

test("missing exact-head promise evidence is pending, never a successful empty list", () => {
  const result = judgeReview(criteria, { diff, report: "a real change", promisedFollowUpObservation: { state: "unknown", reason: "native read failed" } });
  assert.equal(result.state, "pending");
  assert.equal(result.cannotEvaluate, true);
  assert.match(result.summary, /native read failed/);
});

test("the real Git observer reads the head ADR and only a pinned origin/main's filings", async t => {
  const repo = gitRepo(); t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan"));
  const records = '- id: W1-T7729\n  title: owner\n  repo: remudero\n  type: implement\n  verify: auto\n  status: queued\n';
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), records);
  repo.git("add", "."); repo.git("commit", "-m", "owner on main");
  const base = repo.git("rev-parse", "HEAD"); repo.git("update-ref", "refs/remotes/origin/main", base);
  repo.git("switch", "-c", "promise-head");
  mkdirSync(dirname(join(repo.dir, path)), { recursive: true }); writeFileSync(join(repo.dir, path), adr);
  repo.git("add", "."); repo.git("commit", "-m", "ADR at PR head"); const head = repo.git("rev-parse", "HEAD");
  const args = { diff: repo.git("diff", `${base}...${head}`), headSha: head, headCheckoutDir: repo.dir, task: { id: "W1-T7729", sourcePath: join(repo.dir, "plan/tasks.yaml") } };
  const first = await observePromisedFollowUps(args);
  assert.equal(first.state, "complete");
  if (first.state !== "complete") return;
  assert.deepEqual(first.promised, promises);
  assert.equal(first.baseSha, base);
  const material = { headSha: head, diff: args.diff, report: "same body", acceptance: criteria };
  const oldDecision = reviewDecisionDigest({ ...material, promisedFollowUpObservation: first });
  repo.git("switch", "-c", "filing-only", base);
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), records + '- id: W1-T9999\n  title: "bounded heavy READY escalation"\n  plan_refs: [W1-T7729]\n  repo: remudero\n  type: implement\n  verify: auto\n  status: queued\n');
  repo.git("add", "."); repo.git("commit", "-m", "file one promise"); const filed = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", filed); repo.git("switch", "promise-head");
  const second = await observePromisedFollowUps(args);
  assert.equal(second.state, "complete");
  if (second.state !== "complete") return;
  assert.equal(second.baseSha, filed); assert.equal(second.planRecords[0]?.id, "W1-T9999");
  assert.deepEqual(unreportedFollowUps(second.promised, "", second.planRecords), [promises[0]]);
  assert.notEqual(oldDecision, reviewDecisionDigest({ ...material, promisedFollowUpObservation: second }));
  const state = join(repo.dir, "state"); mkdirSync(state); writeFileSync(join(state, "ledger.ndjson"), "");
  const preparationInput = { ...material, acceptance: [...criteria], implementationReport: "" };
  const prepared = await preparePromisedReviewDecision({ input: preparationInput, headCheckoutDir: repo.dir, task: args.task, ledgerPath: join(state, "ledger.ndjson"), prUrl: "https://github.com/o/r/pull/7" });
  assert.equal(prepared.decisionDigest, reviewDecisionDigest({ ...material, implementationReport: "", promisedFollowUpObservation: { ...second, harvested: [], harvestCorpusComplete: true } }));
  preparationInput.acceptance.length = 0; preparationInput.implementationReport = "## Follow-ups\ntask: source-keyed child bundle store with atomic publication;\n";
  const judged = await prepared.judge({ diff: "caller cannot replace it", report: "caller cannot replace it", execProof: () => "pass", promisedFollowUpObservation: observation([]) });
  assert.equal(judged.state, "failure", "caller mutation and an empty replacement observation cannot drop the bound missing promise");
  assert.equal(judged.criteria.length, criteria.length + 1);
  assert.equal((await observePromisedFollowUps({ ...args, headSha: "f".repeat(40) })).state, "unknown");
});

test("failed Git reads, invalid task paths and absent head checkouts remain UNKNOWN", async () => {
  const args = { diff, headSha: "a".repeat(40), headCheckoutDir: "/never-read", task: { id: "W1-T7729" } };
  const failed = await observePromisedFollowUps({ ...args, runGit: async () => { throw new Error("controlled native failure"); } });
  assert.equal(failed.state, "unknown");
  assert.equal((await observePromisedFollowUps({ ...args, task: { ...args.task, sourcePath: "outside-plan.yaml" } })).state, "unknown");
  assert.equal((await observePromisedFollowUps({ ...args, headCheckoutDir: undefined })).state, "unknown");
  assert.deepEqual(await observePromisedFollowUps({ ...args, diff: "+++ b/src/example.ts\n+changed" }), { state: "complete", promised: [], planRecords: [] });
});

test("a later review recovers actual harvested entries across gzip, plain and live forms without trusting another task or PR", async t => {
  const repo = gitRepo(); t.after(() => repo.cleanup()); const state = join(repo.dir, "state"); mkdirSync(state);
  const identity = { task_id: "W1-T7729", pr_url: "https://github.com/o/r/pull/7", step: "report.followups" };
  const row = (text: string, extra = {}) => JSON.stringify({ ...identity, ...extra, entries: [{ type: "task", text }] }) + "\n";
  writeFileSync(join(state, "ledger.2026-10-10T00-00-00-000Z.ndjson.gz"), gzipSync(row(promises[0]!.text)));
  writeFileSync(join(state, "ledger.2026-10-11T00-00-00-000Z.ndjson"), row(promises[1]!.text, { task_id: "foreign-task" }));
  writeFileSync(join(state, "ledger.ndjson"), row(promises[1]!.text, { pr_url: "https://github.com/o/r/pull/8" }));
  const args = { ledgerPath: join(state, "ledger.ndjson"), taskId: identity.task_id, prUrl: identity.pr_url };
  const first = await recoverPromisedFollowUpReports(observation(), args);
  assert.equal(first.state, "complete"); if (first.state !== "complete") return;
  assert.equal(first.harvestCorpusComplete, true); assert.deepEqual(first.harvested, [{ type: "task", text: promises[0]!.text }]);
  assert.equal(review("", first).state, "failure");
  writeFileSync(join(state, "ledger.ndjson"), row(promises[1]!.text));
  const second = await recoverPromisedFollowUpReports(observation(), args);
  assert.equal(second.state, "complete"); if (second.state !== "complete") return;
  assert.equal(second.harvested?.length, 2); assert.equal(review("", second).state, "success");
  const material = { headSha: "a".repeat(40), diff, report: "same body", acceptance: criteria };
  assert.notEqual(reviewDecisionDigest({ ...material, promisedFollowUpObservation: first }), reviewDecisionDigest({ ...material, promisedFollowUpObservation: second }));
});

test("an unreadable harvest is UNKNOWN, while a no-promise or already-reported review performs no ledger read", async t => {
  const args = { ledgerPath: "/absent/promise-fixture/state/ledger.ndjson", taskId: "W1-T7729", prUrl: "https://github.com/o/r/pull/7" };
  assert.equal((await recoverPromisedFollowUpReports(observation(), args)).state, "unknown");
  const empty = observation([]); assert.equal(await recoverPromisedFollowUpReports(empty, args), empty);
  const reported = "## Follow-ups\ntask: source-keyed child bundle store with atomic publication;\naction: bounded heavy READY escalation\n";
  const current = observation(); assert.equal(await recoverPromisedFollowUpReports(current, { ...args, implementationReport: reported }), current);
  const repo = gitRepo(); t.after(() => repo.cleanup()); const state = join(repo.dir, "state"); mkdirSync(state);
  const local = { ...args, ledgerPath: join(state, "ledger.ndjson") };
  assert.equal((await recoverPromisedFollowUpReports(observation(), local)).state, "unknown", "a missing live ledger is not a measured empty harvest");
  writeFileSync(local.ledgerPath, "");
  const measured = await recoverPromisedFollowUpReports(observation(), local);
  assert.equal(measured.state, "complete"); if (measured.state !== "complete") return;
  assert.equal(measured.harvestCorpusComplete, true); assert.deepEqual(measured.harvested, []);
  assert.equal((await recoverPromisedFollowUpReports(observation(), { ...local, ledgerPath: join(state, "other.ndjson") })).state, "unknown", "do not silently query a different ledger basename");
});
