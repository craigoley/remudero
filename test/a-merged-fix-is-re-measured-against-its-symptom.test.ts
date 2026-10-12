import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { stringify } from "yaml";
import { buildGather, recordFollowupHarvest, routeFollowupsToRegistry } from "../src/lib/retro.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import { realLedgerFs } from "../src/lib/ledger-union.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { ghShim } from "./helpers/gh-shim.js";

const now = Date.parse("2026-10-03T12:00:00Z");
const mergedAt = "2026-10-01T12:00:00Z";
const prUrl = "https://github.com/craigoley/remudero/pull/1";
const task = { id: "W1-T1", title: "repair deploy failures", repo: "remudero", type: "implement",
  symptom_query: { pattern: '"step":"deploy.failed"', direction: "decrease" } };
const mergedPr = { state: "MERGED", mergedAt, body: "Remudero-Task: W1-T1", headRefName: "run-W1-T1-1" };
const before = [
  { ts: "2026-09-29T12:00:00Z", step: "control" },
  { ts: "2026-09-30T12:00:00Z", step: "deploy.failed" },
  { ts: "2026-10-01T11:59:59Z", step: "deploy.failed" },
];
const afterControl = { ts: "2026-10-03T12:00:00Z", step: "control" };

function gather(record = task) {
  return buildGather({ ledgerNdjson: "", learningsMd: "", now, sinceTs: "2026-10-03T11:00:00Z",
    planCoherence: { monolith: { path: "plan/tasks.yaml", text: "[]" },
      shards: { ok: true, entries: [{ path: "plan/tasks.d/fixture.yaml", text: stringify([record]) }] } },
    github: { findMergedByTrailer: () => ({ number: 1, url: prUrl }), headRefName: () => "run-W1-T1-1" } });
}

test("W1-T4842: a fix whose symptom moved is recorded as worked", () => {
  const fixture = writeLedger([before[1]!, afterControl], { rotations: [{ at: mergedAt, rows: before, gz: true }] });
  const observations: Record<string, unknown>[] = [];
  try {
    const first = gather();
    recordFollowupHarvest(first.followups, { ledgerPath: fixture.path,
      readMergedPr: () => mergedPr, reportFix: () => {},
      writeLedger: (_path, row) => { observations.push(row); fixture.append([row]); } });
    assert.equal(observations.length, 1);
    assert.deepEqual({ step: observations[0]!.step, task: observations[0]!.task,
      before: observations[0]!.before, after: observations[0]!.after, moved: observations[0]!.moved },
    { step: "fix.remeasured", task: "W1-T1", before: 2, after: 0, moved: true });
    assert.deepEqual(first.followups.candidates, []);
    recordFollowupHarvest(gather().followups, { ledgerPath: fixture.path, readMergedPr: () => mergedPr,
      reportFix: () => {}, writeLedger: (_path, row) => observations.push(row) });
    assert.equal(observations.length, 1, "a persisted receipt prevents measuring twice");
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("W1-T4842: a fix whose symptom did not move is surfaced", () => {
  const later = ["2026-10-01T12:00:00Z", "2026-10-02T12:00:00Z"].map(ts => ({ ts, step: "deploy.failed" }));
  const fixture = writeLedger([...later, afterControl], { rotations: [{ at: mergedAt, rows: before }] });
  const reports: string[] = [];
  try {
    const first = gather();
    const observations: Record<string, unknown>[] = [];
    recordFollowupHarvest(first.followups, { ledgerPath: fixture.path, readMergedPr: () => mergedPr,
      reportFix: message => reports.push(message),
      writeLedger: (_path, row) => { observations.push(row); fixture.append([row]); } });
    assert.equal(observations[0]!.moved, false);
    assert.equal(first.followups.candidates.length, 1);
    assert.match(reports[0]!, /W1-T1.*2 -> 2.*unmoved/);
    const registryPath = `${fixture.dir}/inbox-proposals.json`;
    assert.equal(routeFollowupsToRegistry(first.followups, { registryPath })[0]!.routed, true);
    const second = gather();
    recordFollowupHarvest(second.followups, { ledgerPath: fixture.path, readMergedPr: () => mergedPr,
      reportFix: message => reports.push(message) });
    assert.deepEqual(second.followups.candidates, []);
    assert.equal(reports.length, 1, "an unmoved symptom is surfaced once");
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("symptom queries survive plan parsing and invalid declarations are refused", () => {
  assert.deepEqual(parseTasksFromYaml(stringify([task]), "fixture")[0]!.symptom_query, task.symptom_query);
  for (const symptom_query of [null, "shell command", {}, { pattern: "", direction: "decrease" },
    { pattern: "[", direction: "decrease" }, { pattern: "(a+)+", direction: "decrease" },
    { pattern: "a".repeat(201), direction: "decrease" }, { pattern: "deploy.failed", direction: "sideways" }]) {
    assert.throws(() => parseTasksFromYaml(stringify([{ ...task, symptom_query }]), "fixture"), /symptom_query/);
  }
  assert.equal(parseTasksFromYaml(stringify([{ ...task, symptom_query: undefined }]), "fixture")[0]!.symptom_query, undefined);
});

test("remeasurement uses merge time, equal windows, raw query text, and both directions", () => {
  const fixture = writeLedger([afterControl], { rotations: [{ at: mergedAt, rows: before, gz: true }] });
  try {
    const measure = (mergedAt: string, direction = "decrease") => {
      const rows: Record<string, unknown>[] = [];
      recordFollowupHarvest(gather({ ...task, symptom_query: { ...task.symptom_query, direction } }).followups,
        { ledgerPath: fixture.path, readMergedPr: () => ({ ...mergedPr, mergedAt }), reportFix: () => {},
          writeLedger: (_path, row) => rows.push(row) });
      return rows;
    };
    assert.deepEqual(measure("2026-10-03T12:00:01Z"), []);
    assert.deepEqual(measure("2026-10-02T12:00:01Z"), []);
    assert.equal(measure("2026-10-02T12:00:00Z")[0]!.window_ms, 86_400_000);
    assert.deepEqual(measure("2026-09-26T11:59:59Z"), []);
    assert.equal(measure("2026-09-26T12:00:00Z")[0]!.step, "fix.unmeasured", "seven days is eligible but this corpus is too short");
    assert.equal(measure(mergedAt, "increase")[0]!.moved, false);
    fixture.append([{ ts: "2026-10-02T12:00:00Z", step: "deploy.failed" },
      { ts: "2026-10-02T12:00:01Z", step: "deploy.failed" }, { ts: "2026-10-02T12:00:02Z", step: "deploy.failed" }]);
    assert.equal(measure(mergedAt, "increase")[0]!.moved, true);
    const raw = gather({ ...task, symptom_query: { pattern: '"step": "deploy.failed"', direction: "decrease" } });
    appendFileSync(fixture.path, '{"ts": "2026-10-02T12:00:03Z", "step": "deploy.failed"}\n');
    const observations: Record<string, unknown>[] = [];
    recordFollowupHarvest(raw.followups, { ledgerPath: fixture.path, readMergedPr: () => mergedPr, reportFix: () => {},
      writeLedger: (_path, row) => observations.push(row) });
    assert.equal(observations[0]!.before, 0);
    assert.equal(observations[0]!.after, 1, "ledger-grep matches the original physical line");
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("missing controls, unreadable sources and retention limits stay unmeasured", () => {
  for (const damage of ["no-archives", "no-live", "malformed", "future", "timestamp", "numeric-timestamp", "short-window", "empty-after",
    "archive-read", "live-read", "gzip", "unclassified", "rows", "bytes"]) {
    const fixture = writeLedger([afterControl], { rotations: damage === "no-archives" ? [] : [{ at: mergedAt,
      rows: damage === "short-window" ? before.slice(1) : before }] });
    const rows: Record<string, unknown>[] = [];
    try {
      if (damage === "no-live") rmSync(fixture.path);
      if (damage === "malformed") appendFileSync(fixture.path, "{bad}\n");
      if (damage === "future") fixture.append([{ ts: "2026-10-03T12:00:01Z", step: "control" }]);
      if (damage === "timestamp") fixture.append([{ step: "control" }]);
      if (damage === "numeric-timestamp") fixture.append([{ ts: 0, step: "control" }]);
      if (damage === "empty-after") writeFileSync(fixture.path, "");
      if (damage === "unclassified") writeFileSync(`${fixture.dir}/ledger.unknown`, "unknown");
      const fs = { ...realLedgerFs, readFileSync: (path: string) => {
        if ((damage === "archive-read" && path !== fixture.path) || (damage === "live-read" && path === fixture.path)) {
          throw new Error(`forced ${damage}`);
        }
        return realLedgerFs.readFileSync(path);
      } };
      if (damage === "gzip") writeFileSync(`${fixture.dir}/ledger.2026-10-01T12-00-00-000Z.ndjson.gz`, "bad gzip");
      recordFollowupHarvest(gather().followups, { ledgerPath: fixture.path, readMergedPr: () => mergedPr, reportFix: () => {},
        symptomFs: fs, maxFixRows: damage === "rows" ? 1 : undefined, maxFixBytes: damage === "bytes" ? 1 : undefined,
        writeLedger: (_path, row) => rows.push(row) });
      assert.equal(rows[0]!.step, "fix.unmeasured", damage);
      assert.equal(rows[0]!.moved, undefined, damage);
      assert.ok(rows[0]!.reason, damage);
    } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
  }
});

test("only confirmed task merges are measured and GitHub failures retain their reason", () => {
  const fixture = writeLedger([afterControl], { rotations: [{ at: mergedAt, rows: before }] });
  try {
    const rows: Record<string, unknown>[] = [];
    const deps = { ledgerPath: fixture.path, reportFix: () => {}, writeLedger: (_path: string, row: Record<string, unknown>) => rows.push(row) };
    for (const pr of [null, { ...mergedPr, state: "OPEN" }, { ...mergedPr, mergedAt: null },
      { ...mergedPr, mergedAt: "invalid" }, { ...mergedPr, body: "Remudero-Task: W1-T10", headRefName: "run-W1-T10-1" }]) {
      recordFollowupHarvest(gather().followups, { ...deps, readMergedPr: () => pr });
      assert.equal(rows.at(-1)!.step, "fix.unmeasured");
    }
    const branchCredit = gather();
    recordFollowupHarvest(branchCredit.followups, { ...deps, readMergedPr: () => ({ ...mergedPr, body: "" }) });
    assert.equal(rows.at(-1)!.step, "fix.remeasured");
    recordFollowupHarvest(gather().followups, { ...deps, readMergedPr: () => { throw new Error("forced PR read failure"); } });
    assert.match(String(rows.at(-1)!.reason), /forced PR read failure/);
    const unavailable = gather();
    unavailable.followups.fixRemeasurement!.github.unavailable = () => "GitHub throttled";
    recordFollowupHarvest(unavailable.followups, deps);
    assert.match(String(rows.at(-1)!.reason), /GitHub throttled/);
    const absent = gather();
    absent.followups.fixRemeasurement!.github.findMergedByTrailer = () => null;
    const count = rows.length;
    recordFollowupHarvest(absent.followups, deps);
    assert.equal(rows.length, count);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("default ledger writer records a receipt, and a new query earns a new measurement", () => {
  const fixture = writeLedger([afterControl], { rotations: [{ at: mergedAt, rows: before }] });
  try {
    const deps = { ledgerPath: fixture.path, readMergedPr: () => mergedPr, reportFix: () => {} };
    recordFollowupHarvest(gather().followups, deps);
    const changed = gather({ ...task, symptom_query: { pattern: "deploy.failed", direction: "increase" } });
    recordFollowupHarvest(changed.followups, deps);
    const observations = readFileSync(fixture.path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(observations.filter(row => row.step === "fix.remeasured").length, 2);
    assert.equal(changed.followups.candidates.length, 1);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("the default PR reader shells out and carries transport and decode failures", (t) => {
  const fixture = writeLedger([afterControl], { rotations: [{ at: mergedAt, rows: before }] });
  const shim = ghShim([{ when: "pr view", stdout: JSON.stringify(mergedPr) }]);
  const path = process.env.PATH;
  const reports: string[] = [];
  t.mock.method(console, "log", (message: string) => reports.push(message));
  try {
    process.env.PATH = `${shim.dir}:${path}`;
    withLiveWritesAllowed(() => recordFollowupHarvest(gather().followups, { ledgerPath: fixture.path }));
    assert.deepEqual(shim.calls(), [`pr view ${prUrl} --json state,mergedAt,body,headRefName`]);
    assert.match(reports[0]!, /worked/);
    for (const route of [{ when: "pr view", stdout: "invalid JSON" }, { when: "pr view", stderr: "forced transport failure", exit: 1 }]) {
      shim.addRoute(route);
      withLiveWritesAllowed(() => recordFollowupHarvest(gather().followups, { ledgerPath: fixture.path }));
      const observation = JSON.parse(readFileSync(fixture.path, "utf8").trim().split("\n").at(-1)!);
      assert.equal(observation.step, "fix.unmeasured");
      assert.ok(observation.reason);
    }
    assert.match(reports.at(-1)!, /forced transport failure/);
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("gathering stays read-only and legacy tasks have no remeasurement work", () => {
  const fixture = writeLedger([afterControl], { rotations: [{ at: mergedAt, rows: before }] });
  try {
    const original = readFileSync(fixture.path, "utf8");
    gather();
    assert.equal(readFileSync(fixture.path, "utf8"), original);
    const legacy = { ...task };
    delete (legacy as { symptom_query?: unknown }).symptom_query;
    assert.equal(gather(legacy).followups.fixRemeasurement, undefined);
    const harvest = gather().followups;
    harvest.fixRemeasurement!.tasks = parseTasksFromYaml(stringify([legacy]), "fixture");
    recordFollowupHarvest(harvest, { ledgerPath: fixture.path, readMergedPr: () => { throw new Error("must not be called"); } });
    assert.equal(readFileSync(fixture.path, "utf8"), original);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("fix dispatch events remain measurable symptoms", () => {
  const fixture = writeLedger([{ ts: "2026-10-02T12:00:00Z", step: "fix.dispatch" }, afterControl],
    { rotations: [{ at: mergedAt, rows: before.filter(row => row.step === "control") }] });
  try {
    const observations: Record<string, unknown>[] = [];
    recordFollowupHarvest(gather({ ...task, symptom_query: { pattern: '"step":"fix.dispatch"', direction: "increase" } }).followups,
      { ledgerPath: fixture.path, readMergedPr: () => mergedPr, reportFix: () => {},
        writeLedger: (_path, row) => observations.push(row) });
    assert.equal(observations[0]!.before, 0);
    assert.equal(observations[0]!.after, 1);
    assert.equal(observations[0]!.moved, true);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});
