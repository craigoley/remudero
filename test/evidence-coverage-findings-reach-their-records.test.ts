import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { gitRepo } from "#test/helpers/git-repo.js";
import { LANDING_BRANCH, sweepFeedbackLanding } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { prepareEvidenceRecordContext, taskClosure, type EvidenceContextPorts } from "#src/lib/evidence-coverage-record-context.js";
import { buildEvidenceRevision, evidenceRevisionOf, validateEvidenceRevision } from "#src/lib/feedback-evidence-revision.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { pathToFileURL } from "node:url";
import { ghShim } from "#test/helpers/gh-shim.js";

function fixture(t: TestContext, seedRecord = true, ports: EvidenceContextPorts = {}) {
  const origin = gitRepo({ bare: true, scope: t });
  const source = gitRepo({ scope: t });
  const root = source.dir;
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
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, "plan", "tasks.d", ".gitkeep"), "");
  source.git("add", "plan/tasks.yaml", "plan/tasks.d");
  if (seedRecord) source.git("add", "plan/feedback");
  source.git("commit", "-qm", "chore: seed coverage record");
  source.addRemote("origin", origin.dir);
  source.git("push", "-q", "origin", "main");
  const publish = () => { source.git("add", "plan"); source.git("commit", "-qm", "chore: update fixture"); source.git("push", "-q", "origin", "main"); };
  const land = () => {
    const result = withLiveWritesAllowed(() => sweepFeedbackLanding(root, {
      stateRoot, targetRepository: { owner: "o", repo: "r" }, sourceRepository: { owner: "o", repo: "r" },
      gh: (args) => args[1] === "list" ? "[]" : "https://github.com/o/r/pull/1",
    }));
    assert.equal(result.landed, true, JSON.stringify(result));
    origin.git("update-ref", "refs/heads/main", `refs/heads/${LANDING_BRANCH}`);
    source.git("fetch", "-q", "origin");
    source.git("reset", "--hard", "origin/main");
  };
  let now = Date.parse(entry.ts);
  let observed = 51;
  let denominator = 100;
  const file = feedbackEvidenceCoverageFiler(root, { stateRoot }, ports);
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const pass = () => {
    const result = runEvidenceCoverageGardener({
      stateDir, file,
      clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
      log: (step, extra) => logs.push({ step, extra }),
      readRows: () => ({ ok: true, rows: Array.from({ length: denominator }, (_, i) => [
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
    root, stateRoot, stateDir, id, path, queued, entry, logs, pass, source, origin, publish, land,
    setObserved: (count: number) => { observed = count; },
    setDenominator: (count: number) => { denominator = count; },
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
  f.land();
  rmSync(f.queued);
  assert.deepEqual(f.pass().updated, [], "the checkout now holds the latest measurement");
});

test("W1-T9553: a failed initial capture is queued on retry even if its local copy is current", (t) => {
  const f = fixture(t, false);
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
  const raw = `human decision before measurement\n${f.entry.raw}\nkeep this human history`;
  writeFileSync(f.path, stringify({ ...f.entry, status: "rejected", raw, summary: { headline: "retain" },
    proposal_pr: "https://github.com/o/r/pull/10976" }));
  f.publish();
  assert.deepEqual(f.pass().filed, [f.id]);
  assert.equal(f.record().status, "new");
  assert.match(f.record().raw, /Evidence coverage reopened .*51.0%.*overrides rejected closed by .*10976/);
  assert.match(f.record().raw, /human decision before measurement/);
  assert.match(f.record().raw, /keep this human history/);
  assert.deepEqual(f.record().summary, { headline: "retain" });
  f.land();
  const reopened = parse(readFileSync(f.path, "utf8"));
  const closed = { ...reopened, status: "rejected" };
  delete closed.evidence_coverage_last_reopened;
  const decision = mergeFeedbackRecord(stringify(reopened), stringify(closed));
  assert.equal(decision.kind, "take-local");
  assert.ok(decision.kind === "take-local" && decision.content);
  writeFileSync(f.path, decision.kind === "take-local" ? decision.content! : "");
  f.publish();
  rmSync(f.queued);
  assert.deepEqual(f.pass().updated, [], "equal coverage respects a subsequent closing");
  f.setDenominator(200);
  f.setObserved(102);
  assert.deepEqual(f.pass().updated, [f.id]);
  assert.equal(f.record().status, "rejected", "denominator growth alone cannot reopen");
  assert.equal((f.record() as unknown as Record<string, unknown>).evidence_coverage_last_reopened, "51.0");
  f.setDenominator(100);
  f.setObserved(55);
  assert.deepEqual(f.pass().updated, [f.id]);
  assert.equal(f.record().status, "new");
  assert.match(f.record().raw, /55.0%.*overrides rejected/);
});

test("private coverage context: incomplete searches and exact task facts stay conservative", () => {
  const repository = "o/r", task = "W1-T1";
  const fixtureApi = (state: string, incomplete = false, body = `Remudero-Task: ${task}`) => (args: string[]) =>
    JSON.stringify(args[1].startsWith("search/") ? { total_count: 2, incomplete_results: incomplete, items: [{ number: 1 }, { number: 2 }] }
      : { number: Number(args[1].split("/").at(-1)), base: { repo: { full_name: repository } }, body,
        head: { ref: "other" }, state: args[1].endsWith("/1") ? state : "closed", merged_at: "2026-10-14T00:00:00Z" });
  assert.equal(taskClosure(task, repository, fixtureApi("open")), "open", "open PR dominates a merged duplicate");
  assert.equal(taskClosure(task, repository, fixtureApi("closed")), "closed");
  assert.equal(taskClosure(task, repository, fixtureApi("closed", true)), "unknown");
  assert.equal(taskClosure(task, repository, fixtureApi("closed", false, "Remudero-Task: W1-T10")), "unknown");
  assert.equal(taskClosure(task, repository, () => { throw new Error("offline"); }), "unknown");
  assert.equal(taskClosure(task, repository, () => "malformed"), "unknown");
});

test("private coverage eligibility: both complete plan sources and exact API task facts decide accepted and answered records", (t) => {
  for (const status of ["accepted", "answered"] as const) {
    for (const mode of ["merged", "branch", "open", "incomplete", "missing", "foreign", "no-match"] as const) {
      const calls: string[][] = [];
      const f = fixture(t, true, { repository: "o/r", gh: (args) => {
        calls.push(args);
        if (args[1].startsWith("search/")) return JSON.stringify(mode === "missing" ? {} : {
          total_count: mode === "no-match" ? 0 : 2, incomplete_results: mode === "incomplete",
          items: mode === "no-match" ? [] : [{ number: 1 }, { number: 2 }],
        });
        const number = Number(args[1].split("/").at(-1));
        return JSON.stringify({ number, base: { repo: { full_name: mode === "foreign" ? "other/r" : "o/r" } },
          body: mode === "branch" ? "no trailer" : "Remudero-Task: W1-T42",
          head: { ref: mode === "branch" ? "run-W1-T42-123" : "unrelated" },
          state: mode === "open" && number === 2 ? "open" : "closed", merged_at: "2026-10-14T00:00:00Z" });
      } });
      writeFileSync(f.path, stringify({ ...f.entry, status }));
      const task = [{ id: "W1-T42", title: "repair evidence", repo: "r", type: "implement", origin: `feedback#${f.id}` }];
      const path = status === "accepted" ? join(f.root, "plan", "tasks.yaml") : join(f.root, "plan", "tasks.d", "W1-T42.yaml");
      writeFileSync(path, stringify(task));
      f.publish();
      assert.deepEqual(f.pass().filed, [f.id], `${status}/${mode}`);
      assert.equal(f.record().status, mode === "merged" || mode === "branch" ? "new" : status, `${status}/${mode}`);
      assert.match(f.record().raw, /Coverage: 51\/100/);
      assert.ok(calls.some((args) => args[1].startsWith("search/")));
      if (mode === "merged" || mode === "branch" || mode === "open") {
        assert.equal(calls.filter((args) => args[1].startsWith("repos/o/r/pulls/")).length, 2);
      }
    }
  }
});

test("private coverage eligibility: an empty complete plan permits reopening but a missing or malformed corpus does not", (t) => {
  const f = fixture(t);
  for (const status of ["accepted", "answered"]) {
    writeFileSync(f.path, stringify({ ...f.entry, status }));
    f.publish();
    assert.equal(prepareEvidenceRecordContext(f.root).closure(f.id, status).eligible, true);
  }
  writeFileSync(join(f.root, "plan", "tasks.d", "broken.yaml"), "invalid: [yaml");
  f.publish();
  assert.throws(() => prepareEvidenceRecordContext(f.root), /YAML|yaml/);
  rmSync(join(f.root, "plan", "tasks.d", "broken.yaml"));
  rmSync(join(f.root, "plan", "tasks.yaml"));
  f.publish();
  assert.throws(() => prepareEvidenceRecordContext(f.root), /complete evidence plan unavailable/);
});

test("private coverage revision: metadata, human history, invalid measurements and deleted records never gain amendment authority", (t) => {
  const f = fixture(t);
  f.pass();
  const bytes = readFileSync(f.queued, "utf8"), before = readFileSync(f.path, "utf8");
  assert.equal(mergeFeedbackRecord(before, bytes).kind, "take-local");
  for (const mutate of [
    (entry: Record<string, unknown>) => { entry.origin = "alert#dependabot-fake"; },
    (entry: Record<string, unknown>) => { entry.raw = "erased human history"; },
    (entry: Record<string, unknown>) => { entry.status = "accepted"; },
  ]) {
    const entry = parse(bytes);
    mutate(entry);
    assert.equal(mergeFeedbackRecord(before, stringify(entry)).kind, "refuse");
  }
  assert.equal(mergeFeedbackRecord(undefined, bytes).kind, "refuse");
  const revision = evidenceRevisionOf(bytes)!;
  for (const measurement of [{ ...revision.measurement, denominator: 19 }, { ...revision.measurement, floor: 0.99 },
    { ...revision.measurement, baseline: 1.1 }, { ...revision.measurement, line: "Coverage: forged" }]) {
    assert.throws(() => buildEvidenceRevision({ ...revision, measurement }), /invalid evidence_coverage_revision/);
  }
  assert.throws(() => buildEvidenceRevision({ ...revision, expectedPlan: {} }), /invalid evidence_coverage_revision/);
});

test("private coverage revision: an accepted record without complete task facts, or an unbuildable revision, is refused", (t) => {
  const f = fixture(t);
  f.pass();
  const bytes = readFileSync(f.queued, "utf8");
  const revision = evidenceRevisionOf(bytes)!;
  const accepted = stringify({ ...parse(revision.expectedRecord), status: "accepted" });
  assert.throws(() => buildEvidenceRevision({ ...revision, expectedRecord: accepted,
    closure: { eligible: true, reason: "complete task PR evidence" } }), /incomplete task closure facts/);
  const unbuildable = stringify({ ...parse(bytes), evidence_coverage_revision: { ...revision, expectedPlan: {} } });
  assert.match(validateEvidenceRevision(revision.expectedRecord, unbuildable) ?? "",
    /^invalid evidence revision: Error: invalid evidence_coverage_revision/);
});

test("private coverage producer: a non-new local record that fetched main never held is refused, not overwritten", (t) => {
  const f = fixture(t, false);
  assert.deepEqual(f.pass().failed, [f.id]);
  const failure = f.logs.find((row) => row.step === "evidence_coverage.filing_failed");
  assert.match(String(failure?.extra?.error), new RegExp(`refuses deleted record ${f.id}`));
  assert.equal(parse(readFileSync(f.path, "utf8")).raw, f.entry.raw);
});

test("private coverage context: the default API transport shells out and incomplete local sources refuse explicitly", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "plan", "tasks.yaml"), stringify([{ id: "W1-T42", title: "repair evidence", repo: "r",
    type: "implement", origin: `feedback#${f.id}` }]));
  f.publish();
  const home = join(f.root, "home");
  mkdirSync(home);
  const shim = ghShim([
    { when: "api search/", stdout: JSON.stringify({ total_count: 1, incomplete_results: false, items: [{ number: 41 }] }) },
    { when: "api repos/o/r/pulls/41", stdout: JSON.stringify({ number: 41, base: { repo: { full_name: "o/r" } },
      body: "Remudero-Task: W1-T42", head: { ref: "other" }, state: "closed", merged_at: "2026-10-14T00:00:00Z" }) },
  ]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `const {prepareEvidenceRecordContext} = await import(process.argv[1]);
     const ctx = prepareEvidenceRecordContext(process.argv[2], {repository:"o/r"});
     console.log(JSON.stringify(ctx.closure(process.argv[3], "accepted")));`,
    pathToFileURL(join(REPO_ROOT, "src/lib/evidence-coverage-record-context.ts")).href, f.root, f.id],
    { cwd: REPO_ROOT, encoding: "utf8", env: { PATH: `${shim.dir}:${process.env.PATH}`, HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
  assert.equal(JSON.parse(result.trim()).eligible, true);
  const commands = shim.calls();
  assert.equal(commands.length, 3);
  assert.ok(commands.every((args) => args.startsWith("api ")));
  const refused = feedbackEvidenceCoverageFiler(f.root, { stateRoot: f.stateRoot }, { git: () => { throw new Error("source unavailable"); } });
  assert.throws(() => refused({ id: f.id, action: "update", lane: "containment", field: "servedModel", raw: "coverage",
    measurement: { lane: "containment", field: "servedModel", observed: 51, denominator: 100, floor: 0.9,
      at: "2026-10-14T18:46:00.000Z", since: "2026-10-07T18:46:00.000Z", line: "Coverage: 51/100 joined worker calls (51.0%)" } }), /source unavailable/);
});

test("private coverage producer: deletion on fetched main never resurrects a served or queued record", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.pass().filed, [f.id]);
  rmSync(f.path);
  f.publish();
  writeFileSync(f.path, stringify(f.entry));
  assert.deepEqual(f.pass().failed, [f.id]);
  const ctx = prepareEvidenceRecordContext(f.root);
  assert.equal(ctx.wasDeleted(`plan/feedback/${f.id}.yaml`), true);
  assert.match(String(f.logs.at(-2)?.extra?.error), /deleted record/);
});

test("private coverage producer: stale queued plan expectations are refreshed and queued human edits refuse", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.pass().filed, [f.id]);
  const oldPlan = evidenceRevisionOf(readFileSync(f.queued, "utf8"))!.expectedPlan;
  writeFileSync(join(f.root, "plan", "tasks.yaml"), "# new main plan generation\n[]\n");
  f.publish();
  assert.deepEqual(f.pass().updated, [f.id], "a stale queued revision cannot be remembered as complete");
  const newPlan = evidenceRevisionOf(readFileSync(f.queued, "utf8"))!.expectedPlan;
  assert.notDeepEqual(newPlan, oldPlan);
  const human = { ...parse(readFileSync(f.queued, "utf8")), raw: `${f.record().raw}\nconcurrent queued human history` };
  writeFileSync(f.queued, stringify(human));
  assert.deepEqual(f.pass().failed, [f.id]);
  assert.match(f.record().raw, /concurrent queued human history/);
  assert.match(String(f.logs.at(-2)?.extra?.error), /concurrent queued record edits/);
});

test("W1-T9553: the shared landing policy blocks measured edits and reopening", (t) => {
  const f = fixture(t);
  const before = stringify(f.entry);
  assert.deepEqual(mergeFeedbackRecord(before, stringify({ ...f.entry, raw: "Coverage: 51/100 (51.0%)" })),
    { kind: "keep-upstream" });
  const closed = stringify({ ...f.entry, status: "rejected", proposal_pr: "https://github.com/o/r/pull/10976" });
  const reopen = stringify({ ...parse(closed), status: "new", raw: "Coverage: 51/100 (51.0%)" });
  const decision = mergeFeedbackRecord(closed, reopen);
  assert.equal(decision.kind, "refuse");
  if (decision.kind === "refuse") assert.match(decision.reason, /refusing to move the record backward/);
});
