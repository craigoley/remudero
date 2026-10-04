import assert from "node:assert/strict";
import { appendFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeRecentActivity, createRecentActivityCache } from "../src/lib/board.js";
import { fixedClock } from "../src/lib/clock.js";
import { createLedgerProjector, ledgerLineIdentity, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { acquireLease, openReadModel, openScratchReadModel, withWriteTransaction } from "../src/lib/read-model-db.js";
import { projectRecentEntry, readRecentActivity, RECENT_ACTIVITY_HISTORY_CAP, RECENT_ROW_PROJECTION } from "../src/lib/recent-projection.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { makeTempDir } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const clock = fixedClock(NOW);
const PR = "https://github.com/craigoley/remudero/pull/1";
const task: Task = { id: "W1-T1", title: "persist activity", repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
const plan: Plan = { tasks: [task], byId: new Map([[task.id, task]]) };
const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };

function row(step: string, ms = NOW - 1000, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: new Date(ms).toISOString(), step, task_id: task.id, run_id: "r1", ...extra };
}

function fixture(t: { after(fn: () => void): void }) {
  const dir = makeTempDir("recent-projection");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openProjectorReadModel(dir, "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock });
  assert.ok(got.ok);
  const projector = createLedgerProjector({ ledgerDir: dir, db, lease: got.lease, clock });
  const live = join(dir, "ledger.ndjson");
  writeFileSync(live, "");
  const ingest = (rows: Record<string, unknown>[]) => {
    appendFileSync(live, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return projector.tick();
  };
  const read = (opts: Parameters<typeof readRecentActivity>[2] = {}) => readRecentActivity(db, "core", { plan, nowMs: NOW, ...opts });
  return { dir, db, live, ingest, read, lease: got.lease };
}

test("W1-T4924: recent history survives a ledger rotation and a serve restart", (t) => {
  const f = fixture(t);
  f.ingest([row("run.start"), row("verdict.merged", NOW - 500, { pr_url: PR })]);
  assert.equal(f.read().entries.length, 2);
  renameSync(f.live, join(f.dir, "ledger.2026-10-04T12-00-00-000Z.ndjson"));
  writeFileSync(f.live, "");
  f.ingest([row("review.posted", NOW, { pr_url: PR, state: "success" })]);
  const expected = f.read();
  assert.deepEqual(expected.entries.map((e) => e.verb), ["review", "merged", "started"]);
  const reader = openReadModel({ stateDir: f.dir, instance: "core", schemaVersion: 1, readOnly: true });
  assert.deepEqual(readRecentActivity(reader, "core", { plan, nowMs: NOW }), expected);
  reader.close();
  const restarted = openReadModel({ stateDir: f.dir, instance: "core", schemaVersion: 1, readOnly: true });
  t.after(() => restarted.close());
  assert.deepEqual(readRecentActivity(restarted, "core", { plan, nowMs: NOW }), expected);
});

test("W1-T4924: merged today is an exact count from the recent projection", (t) => {
  const f = fixture(t);
  const midnight = Date.parse("2026-10-04T00:00:00Z");
  f.ingest([
    row("verdict.merged", midnight - 1, { pr_url: PR + "0" }),
    row("verdict", midnight, { verdict: "merged", pr_url: PR }),
    row("verdict.merged", midnight + 1, { pr_url: PR }),
    row("verdict.merged", midnight + 2, { pr_url: PR + "2" }),
  ]);
  renameSync(f.live, join(f.dir, "ledger.2026-10-04T00-00-00-000Z.ndjson"));
  writeFileSync(f.live, "");
  f.ingest(Array.from({ length: RECENT_ACTIVITY_HISTORY_CAP + 5 }, (_, i) => row("run.start", NOW - 500 + i, { run_id: `r${i}` })));
  assert.equal(f.read().entries.length, 20);
  assert.equal(f.read({ limit: RECENT_ACTIVITY_HISTORY_CAP }).entries.length, RECENT_ACTIVITY_HISTORY_CAP);
  assert.equal(f.read({ verbs: new Set(["merged"]) }).entries.length, 0, "the page has shed its merges");
  assert.equal(f.read({ limit: 1, verbs: new Set(["started"]) }).mergedToday, 2);
  assert.equal(f.read({ nowMs: midnight + 86400000 }).mergedToday, 0);
});

test("recent projection is order independent, deduplicates merges and filters before limiting", (t) => {
  const f = fixture(t);
  const rows = [row("run.start", NOW - 4), row("verdict", NOW - 3, { verdict: "merged", pr_url: PR }), row("verdict.merged", NOW - 2, { pr_url: PR }), row("review.posted", NOW - 1, { pr_url: PR })];
  f.ingest(rows.slice().reverse());
  assert.equal(f.ingest(rows).duplicates, rows.length);
  assert.deepEqual(f.read().entries.map((e) => e.verb), ["review", "merged", "started"]);
  assert.equal(f.read().entries[1].ts, rows[2].ts);
  assert.equal(f.read({ verbs: new Set(["started", "merged"]), limit: 1 }).entries[0].verb, "merged");
  assert.equal(f.read().mergedToday, 1);
  assert.deepEqual(readRecentActivity(f.db, "other", { plan, nowMs: NOW }), { entries: [], mergedToday: 0 });
  assert.throws(() => f.read({ limit: 0 }), /limit/);
  assert.throws(() => f.read({ limit: 201 }), /limit/);
  assert.throws(() => f.read({ verbs: new Set(["typo"]) }), /verb/);
});

test("persisted rows use the live classifier and retain worker metadata, plan titles and run PRs", (t) => {
  const f = fixture(t);
  const steps = ["verdict", "verdict.merged", "run.start", "review.posted", "automerge.armed", "fix.dispatch", "fix.done", "fix.exhausted", "escalation.issue_opened", "implement.done", "worker.activity", "console.kick_refused", "console.kick_dispatched", "ignored"];
  const rows = [row("pr.opened", NOW - 100, { pr_url: PR }), ...steps.map((step, i) => row(step, NOW - 50 + i, {
    verdict: "blocked_ci", cost_usd: 1.2, num_turns: 3, state: "success", strike: 2, strikes: 3, class: "ci", task: task.id,
    reason: "busy", event_kind: "tool-executing", event_at: new Date(NOW).toISOString(), worker_role: "implementer", provider: "openai", requested_model: "gpt", served_model: "gpt", turns_so_far: 2,
    tool_name: "Read", tool_reason: "inspect", tool_started_at: "start", tool_completed_at: "end", tool_duration_ms: 10, tool_outcome: "success",
  }))];
  f.ingest(rows.slice().reverse());
  const live = computeRecentActivity({ plan, ledgerPath: f.live, github, readLedger: () => rows }, createRecentActivityCache(), 200);
  assert.deepEqual(f.read({ limit: 200 }).entries, JSON.parse(JSON.stringify(live)));
  assert.equal(f.read().entries.find((e) => e.verb === "worker")?.servedModel, "gpt");
});

test("recent materialization prunes oldest by timestamp and rolls back with its checkpoint", (t) => {
  const f = fixture(t);
  f.ingest(Array.from({ length: 205 }, (_, i) => row("run.start", NOW - i, { run_id: `r${i}` })));
  const entries = f.read({ limit: 200 }).entries;
  assert.equal(entries.at(-1)?.ts, new Date(NOW - 199).toISOString());
  const late = row("review.posted", NOW + 1);
  assert.throws(() => withWriteTransaction(f.db, f.lease, () => {
    projectRecentEntry(f.db, "core", late, ledgerLineIdentity(JSON.stringify(late)));
    throw new Error("checkpoint failed");
  }), /checkpoint failed/);
  assert.deepEqual(f.read({ limit: 200 }).entries, entries);
  withWriteTransaction(f.db, f.lease, () => {
    RECENT_ROW_PROJECTION.apply(f.db, "broken", ledgerLineIdentity("broken"), () => undefined);
    projectRecentEntry(f.db, "core", { step: "run.start", task_id: task.id, ts: "invalid" }, ledgerLineIdentity("invalid"));
    projectRecentEntry(f.db, "core", { step: "run.start", ts: new Date(NOW).toISOString() }, ledgerLineIdentity("no-task"));
  });
  assert.deepEqual(f.read({ limit: 200 }).entries, entries);
  assert.throws(() => withWriteTransaction(f.db, f.lease, () => {
    f.db.prepare("DELETE FROM meta WHERE k = 'instance'").run();
    f.db.prepare("DELETE FROM recent_instance").run();
    RECENT_ROW_PROJECTION.apply(f.db, JSON.stringify(late), ledgerLineIdentity(JSON.stringify(late)), () => late);
  }), /requires read-model instance metadata/);
  assert.equal(f.db.meta("instance"), "core", "the invalid projection transaction rolled back");
});

test("duplicate merge reports use one slot in the bounded history in either ingest order", (t) => {
  const rows = [
    ...Array.from({ length: 200 }, (_, i) => row("run.start", NOW - 500 + i, { run_id: `r${i}` })),
    ...Array.from({ length: 200 }, (_, i) => row("verdict.merged", NOW - 200 + i, { pr_url: PR, run_id: `credit${i}` })),
  ];
  const forward = fixture(t);
  forward.ingest(rows);
  const reverse = fixture(t);
  reverse.ingest(rows.slice().reverse());
  const result = forward.read({ limit: 200 });
  assert.equal(result.entries.length, 200);
  assert.equal(result.entries.filter((e) => e.verb === "merged").length, 1);
  assert.equal(result.mergedToday, 1);
  assert.deepEqual(reverse.read({ limit: 200 }), result);
});

test("recent reads filter unknown tasks, keep operator refusals and isolate instance histories", (t) => {
  const f = fixture(t);
  const operator = row("console.kick_refused", NOW - 1, { task_id: "DAEMON", task: "removed", reason: "already merged" });
  f.ingest([row("run.start", NOW - 3, { task_id: "DAEMON" }), row("run.start", NOW - 2), operator]);
  assert.deepEqual(f.read().entries.map((e) => [e.taskId, e.title]), [["removed", "removed"], [task.id, task.title]]);
  withWriteTransaction(f.db, f.lease, () => {
    const other = row("verdict.merged", NOW, { pr_url: PR });
    projectRecentEntry(f.db, "other", other, ledgerLineIdentity(JSON.stringify(other)));
  });
  assert.equal(f.read().mergedToday, 0);
  assert.equal(readRecentActivity(f.db, "other", { plan, nowMs: NOW }).mergedToday, 1);
  assert.equal(readRecentActivity(f.db, "other", { plan, nowMs: NOW }).entries[0].prUrl, PR);
});

test("the oracle can replay the recent projection with its copied instance context", (t) => {
  const f = fixture(t);
  const merged = row("verdict.merged", NOW - 1, { pr_url: PR });
  f.ingest([merged]);
  const scratch = openScratchReadModel();
  t.after(() => scratch.close());
  scratch.exec(RECENT_ROW_PROJECTION.ddl);
  scratch.prepare("INSERT INTO recent_instance(k, instance) VALUES(1, ?)").run(f.db.prepare("SELECT instance FROM recent_instance WHERE k = 1").get()!.instance);
  const line = JSON.stringify(merged);
  RECENT_ROW_PROJECTION.apply(scratch, line, ledgerLineIdentity(line), () => merged);
  assert.deepEqual(readRecentActivity(scratch, "core", { plan, nowMs: NOW }), f.read());
});
