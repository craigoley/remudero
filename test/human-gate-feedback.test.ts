import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../src/lib/clock.js";
import type { FeedbackEntry } from "../src/lib/feedback.js";
import { measureFeedbackAge, projectFeedbackGates, projectHumanGates, type FeedbackAgeRoot } from "../src/lib/human-gate.js";
import { grillDecisions } from "../src/lib/now-decisions.js";
import { createNowView } from "../src/lib/now-view.js";
import type { Plan } from "../src/lib/plan.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const FROM = "2026-10-02T10:00:00.000Z";
const THROUGH = "2026-10-02T12:00:00.000Z";
const at = (minutes: number): string => new Date(Date.parse(FROM) + minutes * 60_000).toISOString();
const summary = { headline: "Choose a triage path", what_happened: "Two paths remain viable.", decision: "Choose the next step.", options: [{ label: "A", consequence: "Proceed" }, { label: "B", consequence: "Wait" }] };
function entry(id: string, status: FeedbackEntry["status"], over: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return { id, status, ts: FROM, raw: `Question for ${id}?\n${"full context ".repeat(200)}`, attachments: [], origin: "cli", proposal_pr: null, ...over };
}

test("resolved feedback remains a record and an unanswered proposal remains an ask", () => {
  const proposed = entry("proposal", "proposed", { summary, proposal_pr: "https://example.test/pr/1" });
  const resolved = [entry("accepted", "accepted"), entry("rejected", "rejected"), entry("answered", "answered")];
  const source = projectFeedbackGates({ instance: "core", entries: [proposed, ...resolved, proposed], now: Date.parse(THROUGH) });
  assert.deepEqual(source.records.map((e) => e.id), ["accepted", "rejected", "answered"]);
  const projection = projectHumanGates([source]);
  assert.equal(projection.gates.length, 1);
  assert.deepEqual(projection.count.byKind, { feedback_proposal: 1 });
  assert.equal(projection.gates[0]!.key, "feedback_proposal:core:proposal");
  assert.equal(projection.gates[0]!.openedAt, FROM);
  assert.equal(projection.gates[0]!.url, proposed.proposal_pr);
  assert.equal(projection.gates[0]!.resolutionVerb, "ratify");
  assert.ok(projection.gates[0]!.reason.includes(proposed.raw));
  assert.ok(projection.gates[0]!.reason.includes(summary.what_happened));
  assert.ok(projection.gates[0]!.reason.includes("B: Wait"));
  assert.equal(projection.gates[0]!.reason.includes("accepted"), false);
  assert.equal(projectHumanGates([source, { ...source, instance: "other" }]).gates.length, 2);
});

function corpus(t: { after(fn: () => void): void }): FeedbackAgeRoot {
  const ledgerDir = makeTempDir("feedback-age");
  t.after(() => rmSync(ledgerDir, { recursive: true, force: true }));
  const rows = (id: string, minutes: number) => JSON.stringify({ ts: at(minutes), step: "triage.start", feedback_id: id, run_id: `TRIAGE-${id}-1`, task_id: `TRIAGE-${id}` }) + "\n";
  writeFileSync(join(ledgerDir, "ledger.2026-10-02T10-30-00-000Z.ndjson"), rows("plain", 10));
  writeFileSync(join(ledgerDir, "ledger.2026-10-02T11-00-00-000Z.ndjson.gz"), gzipSync(rows("gzip", 20) + rows("second-gzip", 30)));
  const coverageRows = [FROM, THROUGH].map((ts) => JSON.stringify({ ts, step: "daemon.poll" }) + "\n").join("");
  writeFileSync(join(ledgerDir, "ledger.ndjson"), rows("live", 40) + rows("plain", 10) + coverageRows);
  return { instance: "core", ledgerDir, enrolled: true, consent: true,
    coverage: [{ from: FROM, through: THROUGH }],
    entries: [entry("plain", "proposed"), entry("gzip", "grilling"), entry("second-gzip", "accepted"), entry("live", "rejected"), entry("pending", "new", { ts: at(100) })] };
}

test("feedback age uses measured evidence and preserves uncalibrated windows", (t) => {
  const root = corpus(t);
  const age = measureFeedbackAge([root], { from: FROM, through: THROUGH });
  assert.equal(age.state, "measured");
  assert.deepEqual(age.samples.map((s) => s.ageMs).sort((a, b) => a - b), [10, 20, 30, 40].map((m) => m * 60_000));
  assert.deepEqual(age.censored, [{ instance: "core", id: "pending", ageMs: 20 * 60_000 }]);
  assert.equal(age.observedMaxMs, 40 * 60_000);
  assert.deepEqual(age.controls[0]!.forms, { plain: 1, gzip: 2, live: 4 });
  assert.equal(measureFeedbackAge([root, root], age.window).samples.length, 4, "duplicate root sightings do not inflate the sample");
  assert.equal(measureFeedbackAge([{ ...root, coverage: [{ from: at(-10), through: THROUGH }, { from: at(150), through: at(200) }] }], age.window).state, "measured");
  const fresh = entry("fresh", "new", { ts: at(100) });
  const old = entry("old", "new", { ts: at(50) });
  const claimed = entry("claimed", "new", { ts: at(45) });
  const source = projectFeedbackGates({ instance: "core", entries: [fresh, old, claimed], now: Date.parse(THROUGH), age,
    rows: [{ ts: at(110), step: "triage.start", feedback_id: "claimed" }] });
  assert.deepEqual(source.gates.map((g) => [g.subject, g.resolutionVerb]), [["old", "triage"]]);
  assert.match(source.gates[0]!.reason, /Unclaimed feedback age 4200000 ms; measured new-to-triage maximum 2400000 ms/);
  assert.deepEqual(source.backlog.map((b) => [b.entry.id, b.state]), [["fresh", "machine"], ["claimed", "claimed"]]);
  assert.equal(projectFeedbackGates({ instance: "other", entries: [old], now: Date.parse(THROUGH), age }).age.state, "uncalibrated");
  const unverified = projectFeedbackGates({ instance: "core", entries: [{ ...entry("proposal", "proposed"), unverified: true }], now: Date.parse(THROUGH), age });
  assert.equal(unverified.state, "partial");
  assert.match(unverified.reason!, /proposal resolution could not be verified/);
  for (const now of [Date.parse(at(-1)), Date.parse(at(121))]) {
    const uncovered = projectFeedbackGates({ instance: "core", entries: [old], now, age });
    assert.equal(uncovered.age.state, "uncalibrated");
    assert.equal(uncovered.state, "partial");
    assert.deepEqual(projectHumanGates([uncovered]).count.inbox, { atLeast: 0 });
    assert.equal(uncovered.followUps.length, 1);
  }
  const leftCensored = projectFeedbackGates({ instance: "core", entries: [entry("before", "new", { ts: at(-1) })], now: Date.parse(THROUGH), age });
  assert.equal(leftCensored.state, "partial");

  for (const roots of [[], [{ ...root, consent: false }], [{ ...root, enrolled: false }], [{ ...root, entries: [] }],
    [{ ...root, coverage: [{ from: at(1), through: THROUGH }] }],
    [{ ...root, coverage: [{ from: FROM, through: at(30) }, { from: at(31), through: THROUGH }] }],
    [{ ...root, entries: [...root.entries, entry("left-censored", "new", { ts: at(-1) })] }],
    [{ ...root, entries: [...root.entries, entry("bad-time", "new", { ts: "unknown" })] }],
    [{ ...root, entries: [...root.entries, entry("old-pending", "new")] }],
    [{ ...root, entries: [entry("plain", "proposed", { ts: at(11) })] }],
    [{ ...root, entries: [entry("plain", "proposed", { ts: at(10) })] }]]) {
    const unknown = measureFeedbackAge(roots, { from: FROM, through: THROUGH });
    assert.equal(unknown.state, "uncalibrated");
    assert.equal(unknown.observedMaxMs, null);
    const uncalibrated = projectFeedbackGates({ instance: "core", entries: [old, fresh], now: Date.parse(THROUGH), age: unknown });
    assert.equal(uncalibrated.state, "partial");
    assert.equal(uncalibrated.gates.length, 0);
    assert.deepEqual(uncalibrated.backlog.map((b) => b.state), ["uncalibrated", "uncalibrated"]);
    assert.equal(uncalibrated.followUps.length, 1);
    assert.match(projectHumanGates([uncalibrated]).sources[0]!.reason!, /uncalibrated/);
    assert.deepEqual(projectHumanGates([uncalibrated]).count.inbox, { atLeast: 0 });
  }
});

test("feedback age refuses unreadable, torn, empty and uncovered corpora", (t) => {
  const root = corpus(t);
  const measure = () => measureFeedbackAge([root], { from: FROM, through: THROUGH });
  writeFileSync(join(root.ledgerDir, "ledger.2026-10-02T11-00-00-000Z.ndjson.gz"), "invalid gzip");
  assert.equal(measure().state, "uncalibrated");
  rmSync(join(root.ledgerDir, "ledger.2026-10-02T11-00-00-000Z.ndjson.gz"));
  writeFileSync(join(root.ledgerDir, "ledger.2026-10-02T11-00-00-000Z.ndjson"), "");
  assert.equal(measure().state, "uncalibrated");
  rmSync(join(root.ledgerDir, "ledger.2026-10-02T11-00-00-000Z.ndjson"));
  writeFileSync(join(root.ledgerDir, "ledger.ndjson"), "{torn\n");
  assert.equal(measure().state, "uncalibrated");
  writeFileSync(join(root.ledgerDir, "ledger.ndjson"), "");
  assert.equal(measure().state, "uncalibrated");
  rmSync(root.ledgerDir, { recursive: true });
  assert.equal(measure().state, "uncalibrated");
  assert.equal(measureFeedbackAge([], { from: "bad", through: THROUGH }).state, "uncalibrated");
});

test("recorded answers expose lifecycle repair rather than repeat a settled question", () => {
  const settled = entry("settled", "grilling", { answered_by: "reply", summary });
  const linked = entry("linked", "grilling");
  const reply = entry("reply", "new", { reply_to: "linked" });
  const ask = entry("ask", "grilling", { proposal_pr: "https://example.test/pr/2" });
  const source = projectFeedbackGates({ instance: "core", entries: [settled, linked, reply, ask], now: Date.parse(THROUGH) });
  assert.deepEqual(source.repairs.map((r) => r.entry.id), ["settled", "linked"]);
  assert.equal(source.state, "partial");
  assert.equal(source.gates.length, 1);
  assert.equal(source.gates[0]!.subject, "ask");
  assert.equal(source.gates[0]!.url, ask.proposal_pr);
  assert.ok(source.reason!.includes(settled.raw));
  assert.match(source.reason!, /lifecycle repair/);
  assert.equal(settled.status, "grilling", "projection does not rewrite lifecycle records");
  const decisions = grillDecisions("core", [settled, linked, reply, ask]);
  assert.deepEqual(decisions.map((d) => d.id), ["grill:ask"]);
  assert.equal(decisions[0]!.prompt, ask.raw, "full question survives the legacy decision projection");
  const withIssue = projectFeedbackGates({ instance: "core", entries: [ask], now: Date.parse(THROUGH), rows: [{ step: "triage.grill_opened", task_id: "TRIAGE-ask", issue_url: "https://example.test/issues/1" }] });
  assert.equal(withIssue.gates[0]!.url, "https://example.test/issues/1");
});

test("production now view consumes the feedback adapter and deduplicates evidence follow-ups", (t) => {
  const root = makeTempDir("feedback-now");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = fixedClock(Date.parse(THROUGH));
  const db = openProjectorReadModel(root, "core", clock);
  t.after(() => db.close());
  const lease = acquireLease(db, { clock });
  assert.ok(lease.ok);
  const ledgerDir = join(root, "state");
  const feedbackRoot = join(root, "checkout");
  mkdirSync(ledgerDir);
  mkdirSync(join(feedbackRoot, "plan", "feedback"), { recursive: true });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  const entries = [entry("proposal", "proposed", { summary }), entry("accepted", "accepted"), entry("new", "new"), entry("settled", "grilling", { answered_by: "answer" }), entry("merged", "proposed", { proposal_pr: "https://example.test/pr/merged" })];
  for (const e of entries) writeFileSync(join(feedbackRoot, "plan", "feedback", `${e.id}.yaml`), JSON.stringify(e));
  const github = { readFailed: () => false, prByRef: (url: string) => url === "https://example.test/pr/merged" ? { state: "MERGED" } : null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], listOpenPrs: () => [], headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "question" }) } as unknown as GitHub;
  const view = createNowView({ instances: [{ name: "core", ledgerDir, feedbackRoot }], clock,
    readPlan: (): Plan => ({ tasks: [], byId: new Map() }),
    github: () => ({ github, generation: "known", source: { asOf: THROUGH, state: "fresh" } }),
    planBehind: () => ({ commits: 0 }),
    hostProbe: { readLive: () => [], diskFree: () => 1_000_000, rateLimit: () => 5000 } });
  const ctx = { now: clock.now(), switches: { views: { now: "serve" as const } }, instances: [{ db, lease: lease.lease, state: { instance: "core", generation: 0, lease: "held" as const, failures: 0, tickedAt: clock.now(), newestTs: null } }] };
  for (const now of [ctx.now, ctx.now + 60_000]) {
    const data = view.materialize({ ...ctx, now })[0]!.data;
    assert.deepEqual(data.humanGates!.gates.map((g) => g.kind), ["feedback_proposal"]);
    assert.ok(data.humanGates!.gates[0]!.reason.includes(entries[0]!.raw));
    assert.equal(data.decisions.length, 0, "settled grills do not survive in the legacy ask list");
    assert.match(data.humanGates!.sources.find((s) => s.name === "feedback")!.reason!, /uncalibrated/);
    const sourceReason = data.humanGates!.sources.find((s) => s.name === "feedback")!.reason!;
    assert.equal(sourceReason.split("evidence-collection follow-up feedback-age:core:").length - 1, 1);
  }
  const badPath = join(feedbackRoot, "plan", "feedback", "settled.yaml");
  rmSync(badPath);
  mkdirSync(badPath);
  const unavailable = view.materialize({ ...ctx, now: ctx.now + 120_000 })[0]!.data;
  assert.match(unavailable.decisionsReasons!.grill!, /feedback store is unreadable/);
  assert.equal(unavailable.humanGates!.sources.find((s) => s.name === "feedback")!.state, "unavailable");
  assert.deepEqual(unavailable.humanGates!.count.inbox, { atLeast: 0 });
});
