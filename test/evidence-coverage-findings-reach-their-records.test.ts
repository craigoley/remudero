import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse, stringify } from "yaml";

import {
  EVIDENCE_COVERAGE_PASS_INTERVAL_MS,
  evidenceCoverageStatePath,
  feedbackEvidenceCoverageFiler,
  runEvidenceCoverageGardener,
} from "#src/lib/evidence-coverage-gardener.js";
import { feedbackEntryPath, type FeedbackEntry } from "#src/lib/feedback.js";
import { queuedFeedbackDir } from "#src/lib/feedback-landing.js";
import { mergeFeedbackRecord } from "#src/lib/feedback-record-merge.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-coverage-records-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateRoot = join(root, "landing");
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const id = "evidence-coverage-containment-served-model";
  const path = feedbackEntryPath(root, id);
  const queued = join(queuedFeedbackDir(stateRoot), `${id}.yaml`);
  const entry: FeedbackEntry = {
    id, ts: "2026-10-14T18:46:00.000Z", raw: "Coverage: 49/61 joined worker calls (80.3%)",
    status: "grilling", origin: "cli", attachments: [], proposal_pr: null,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(entry));
  let now = Date.parse(entry.ts);
  let observed = 51;
  const file = feedbackEvidenceCoverageFiler(root, { stateRoot });
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const pass = () => {
    const result = runEvidenceCoverageGardener({
      stateDir, file,
      clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
      log: (step, extra) => logs.push({ step, extra }),
      readRows: () => ({ ok: true, rows: Array.from({ length: 100 }, (_, i) => [
        { step: "worker.assignment", lane: "containment", worker_assignment: {
          id: `call-${i}`, selected: { provider: "anthropic", model: "claude" },
        } },
        { step: "worker.attempt", selection_assignment_id: `call-${i}`, success: true,
          served_model: i < observed ? "claude" : null,
          tokens: { input: 10, output: 20 }, total_cost_usd: 0.01, billing_mode: "api" },
      ]).flat() }),
    });
    now += EVIDENCE_COVERAGE_PASS_INTERVAL_MS;
    return result;
  };
  return {
    root, stateRoot, stateDir, id, path, queued, entry, logs, pass,
    setObserved: (count: number) => { observed = count; },
    record: () => parse(readFileSync(queued, "utf8")) as FeedbackEntry,
    state: () => JSON.parse(readFileSync(evidenceCoverageStatePath(stateDir), "utf8")),
  };
}

test("W1-T9553: a refused landing is retried on the next pass", (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.stateRoot), { recursive: true });
  writeFileSync(f.stateRoot, "a file prevents queue creation");
  assert.deepEqual(f.pass().failed, [f.id]);
  assert.equal(f.state().cells["containment/servedModel"].gap.filedDigest, undefined);
  const failure = f.logs.find((row) => row.step === "evidence_coverage.filing_failed");
  assert.match(String(failure?.extra?.error), /queueing .* failed/);
  rmSync(f.stateRoot);
  assert.deepEqual(f.pass().filed, [f.id]);
  assert.match(f.record().raw, /Coverage: 51\/100 joined worker calls \(51.0%\)/);
  assert.equal(f.record().status, "grilling");
  assert.equal(parse(readFileSync(f.path, "utf8")).raw, f.entry.raw);
});

test("W1-T9553: an open record shows the measured value of the latest pass", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.pass().filed, [f.id]);
  assert.match(f.record().raw, /\(51.0%\)/);
  const first = readFileSync(f.queued, "utf8");
  assert.deepEqual(f.pass().updated, [], "the queued record already holds this measurement");
  assert.equal(readFileSync(f.queued, "utf8"), first);
  rmSync(f.queued);
  assert.deepEqual(f.pass().updated, [f.id], "a lost landing must heal despite the local digest");
  assert.match(f.record().raw, /\(51.0%\)/);
  f.setObserved(55);
  assert.deepEqual(f.pass().updated, [f.id]);
  assert.match(f.record().raw, /Coverage: 55\/100 joined worker calls \(55.0%\)/);
  assert.equal(f.record().status, "grilling");
  writeFileSync(f.path, readFileSync(f.queued));
  rmSync(f.queued);
  assert.deepEqual(f.pass().updated, [], "the checkout now holds the latest measurement");
});

test("W1-T9553: a failed initial capture is queued on retry even if its local copy is current", (t) => {
  const f = fixture(t);
  rmSync(f.path);
  writeFileSync(f.stateRoot, "a file prevents queue creation");
  assert.deepEqual(f.pass().failed, [f.id]);
  assert.match(parse(readFileSync(f.path, "utf8")).raw, /\(51.0%\)/);
  rmSync(f.stateRoot);
  assert.deepEqual(f.pass().filed, [f.id]);
  assert.match(f.record().raw, /\(51.0%\)/);
});

test("W1-T9553: a closed record whose gap is still open is reopened with evidence", (t) => {
  const f = fixture(t);
  const closed = stringify({ ...f.entry, status: "rejected", proposal_pr: "https://github.com/o/r/pull/10976" });
  writeFileSync(f.path, closed);
  assert.deepEqual(f.pass().filed, [f.id]);
  assert.equal(f.record().status, "new");
  assert.match(f.record().raw, /Reopened 2026-10-14T18:46:00.000Z: overrides rejected \(https:\/\/github.com\/o\/r\/pull\/10976\)/);
  assert.match(f.record().raw, /window 2026-10-07T18:46:00.000Z to 2026-10-14T18:46:00.000Z; Coverage: 51\/100 joined worker calls \(51.0%\)/);
  assert.equal(mergeFeedbackRecord(closed, readFileSync(f.queued, "utf8")).kind, "take-local",
    "the queued reopening must survive the real publication policy");
  assert.deepEqual(f.pass().updated, []);
  writeFileSync(f.path, stringify({ ...f.record(), status: "rejected" }));
  rmSync(f.queued);
  assert.deepEqual(f.pass().updated, [], "closing unchanged evidence again is respected");
  f.setObserved(55);
  assert.deepEqual(f.pass().updated, [f.id]);
  assert.equal(f.record().status, "new");
  assert.equal(f.record().raw.split("\n").filter((line) => line.startsWith("Reopened ")).length, 2);
  assert.match(f.record().raw, /2026-10-15T12:46:00.000Z.*\(55.0%\)/);
  assert.equal(mergeFeedbackRecord(readFileSync(f.path, "utf8"), readFileSync(f.queued, "utf8")).kind, "take-local");
});

test("W1-T9553: accepted and answered records reopen only without open work", (t) => {
  for (const status of ["accepted", "answered"] as const) {
    const f = fixture(t);
    writeFileSync(f.path, stringify({ ...f.entry, status }));
    const planPath = join(f.root, "plan", "tasks.yaml");
    writeFileSync(planPath, stringify([{ id: "W1-T1", title: "restore coverage", status: "running",
      origin: `feedback#${f.id}`, depends_on: [], prompt: "restore coverage" }]));
    assert.deepEqual(f.pass().filed, [f.id]);
    assert.equal(f.record().status, status);
    assert.doesNotMatch(f.record().raw, /Reopened /);
    writeFileSync(planPath, "[]\n");
    assert.deepEqual(f.pass().updated, [f.id], "unchanged measurement reopens when its task closes");
    assert.equal(f.record().status, "new");
    assert.match(f.record().raw, new RegExp(`overrides ${status}`));
  }
});

test("W1-T9553: healthy and insufficient readings keep a closed record closed", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, stringify({ ...f.entry, status: "rejected" }));
  f.setObserved(100);
  assert.deepEqual(f.pass().filed, []);
  assert.equal(parse(readFileSync(f.path, "utf8")).status, "rejected");
});

test("W1-T9553: measured updates publish without overwriting a newer decision", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.path, "utf8");
  f.pass();
  const after = readFileSync(f.queued, "utf8");
  assert.equal(mergeFeedbackRecord(before, after).kind, "take-local");
  const changed = stringify({ ...f.entry, status: "rejected" });
  assert.equal(mergeFeedbackRecord(changed, after).kind, "refuse");
  const metadata = stringify({ ...f.entry, summary: { headline: "a concurrent decision" } });
  assert.equal(mergeFeedbackRecord(metadata, after).kind, "refuse");
});
