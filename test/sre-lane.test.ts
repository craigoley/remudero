// test/sre-lane.test.ts — W1-T4385: the SRE gardener runs in its own lightweight lane.
//
// Acceptance (plan/tasks.d/W1-T4385-*.yaml):
//   - a fingerprint with open feedback or an open task is never filed twice
//   - an incident names the merged pull requests that touched its in-app frames
//   - incident filing is paced by the fleet's own merge rate
//   - the daemon starts the SRE lane among its gardens (grep: startSreLane( in src/run-task.ts)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { listFeedback } from "../src/lib/feedback.js";
import {
  aggregateIncidents,
  daemonSreLaneInput,
  fingerprintAlreadyOpen,
  incidentEventFromLedgerRow,
  incidentFeedbackOrigin,
  mergedPrsSince,
  readSreLaneStore,
  runSreLanePass,
  sreLaneRoom,
  sreLaneStorePath,
  startSreLane,
  suspectPullRequests,
  worstOpenIncident,
  type IncidentLedgerEvent,
  type MergedPrFiles,
  type SreLaneInput,
} from "../src/lib/sre-lane.js";

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-sre-lane-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

function event(fingerprint: string, atIso: string, extra: Partial<IncidentLedgerEvent> = {}): IncidentLedgerEvent {
  return {
    fingerprint,
    ts: Date.parse(atIso),
    kind: "exception",
    name: "TypeError",
    message: "boom",
    instance: "core",
    ...extra,
  };
}

function baseDeps(root: string, overrides: Partial<SreLaneInput> = {}): SreLaneInput {
  return {
    stateDir: join(root, "state"),
    root,
    readEvents: () => [],
    hasOpenTask: () => false,
    framesFor: () => [],
    mergedPrsSince: () => [],
    mergedLastDay: () => 10,
    log: () => {},
    ...overrides,
  };
}

test("a fingerprint with open feedback or an open task is never filed twice", async () => {
  // Part 1: an ordinary pass files the worst incident, and its own feedback entry then blocks a
  // second pass from filing it again — the same aggregate re-read, nothing else changed.
  const root = tmpRoot();
  const events = [event(FP_A, "2026-09-23T10:00:00.000Z"), event(FP_A, "2026-09-23T10:05:00.000Z"), event(FP_A, "2026-09-23T10:10:00.000Z")];
  const deps = baseDeps(root, { readEvents: () => events });

  const first = await runSreLanePass(deps);
  assert.equal(first.filed, FP_A);
  const entries = listFeedback(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].origin, incidentFeedbackOrigin(FP_A));

  const second = await runSreLanePass(deps);
  assert.equal(second.filed, undefined, "the same fingerprint's own open feedback must never be filed twice");

  // Part 2: a fingerprint with no feedback entry at all is still refused when an open plan task
  // already covers it — the plan-side half of the same guard.
  const root2 = tmpRoot();
  const deps2 = baseDeps(root2, { readEvents: () => events, hasOpenTask: () => true });
  const pass = await runSreLanePass(deps2);
  assert.equal(pass.filed, undefined, "an open task must block filing even with no feedback entry yet");
  assert.equal(listFeedback(root2).length, 0);

  // The pure predicate underneath both halves, directly.
  assert.equal(fingerprintAlreadyOpen(FP_A, new Set([incidentFeedbackOrigin(FP_A)]), () => false), true);
  assert.equal(fingerprintAlreadyOpen(FP_A, new Set(), () => true), true);
  assert.equal(fingerprintAlreadyOpen(FP_A, new Set(), () => false), false);
});

test("an incident names the merged pull requests that touched its in-app frames", async () => {
  const mergedPrs: MergedPrFiles[] = [
    { url: "https://github.com/o/r/pull/101", files: ["src/lib/sre-lane.ts"] },
    { url: "https://github.com/o/r/pull/102", files: ["docs/unrelated.md"] },
  ];
  const named = suspectPullRequests(mergedPrs, ["src/lib/sre-lane.ts"]);
  assert.deepEqual(named, ["https://github.com/o/r/pull/101"]);
  assert.deepEqual(suspectPullRequests(mergedPrs, ["src/lib/nowhere.ts"]), []);
  assert.deepEqual(suspectPullRequests(mergedPrs, []), []);

  // End to end: the filed feedback's own raw text names exactly the PR that touched the incident's
  // in-app frame, never the unrelated one.
  const root = tmpRoot();
  const events = [event(FP_A, "2026-09-23T10:00:00.000Z")];
  const deps = baseDeps(root, {
    readEvents: () => events,
    framesFor: () => [{ file: "src/lib/sre-lane.ts", fn: "runSreLanePass" }],
    mergedPrsSince: () => mergedPrs,
  });
  const pass = await runSreLanePass(deps);
  assert.equal(pass.filed, FP_A);
  const raw = listFeedback(root)[0].raw;
  assert.ok(raw.includes("https://github.com/o/r/pull/101"), "raw must name the suspect PR");
  assert.ok(!raw.includes("https://github.com/o/r/pull/102"), "raw must not name the unrelated PR");
});

test("incident filing is paced by the fleet's own merge rate", async () => {
  assert.equal(sreLaneRoom(0, 0), 0);
  assert.equal(sreLaneRoom(3, 1), 2);
  assert.equal(sreLaneRoom(1, 5), 0);

  // A quiet fleet (nothing merged in the last day) never files, no matter how bad the incident.
  const root = tmpRoot();
  const events = [event(FP_A, "2026-09-23T10:00:00.000Z"), event(FP_A, "2026-09-23T10:01:00.000Z")];
  const quiet = baseDeps(root, { readEvents: () => events, mergedLastDay: () => 0 });
  assert.equal((await runSreLanePass(quiet)).filed, undefined);
  assert.equal(listFeedback(root).length, 0);

  // A fleet merging exactly one PR a day files exactly one incident, then stops even though a
  // second, distinct fingerprint is still open and unfiled.
  const root2 = tmpRoot();
  const twoFingerprints = [event(FP_A, "2026-09-23T10:00:00.000Z"), event(FP_B, "2026-09-23T09:00:00.000Z")];
  const pacedDeps = baseDeps(root2, { readEvents: () => twoFingerprints, mergedLastDay: () => 1 });
  const filedFirst = await runSreLanePass(pacedDeps);
  assert.equal(filedFirst.room, 0);
  assert.ok(filedFirst.filed === FP_A || filedFirst.filed === FP_B);
  const secondPass = await runSreLanePass(pacedDeps);
  assert.equal(secondPass.filed, undefined, "the day's pace is spent; the other fingerprint waits");
  assert.equal(listFeedback(root2).length, 1);
});

test("aggregateIncidents and worstOpenIncident rank by burn rate and skip open work", () => {
  const events = [
    event(FP_A, "2026-09-23T10:00:00.000Z"),
    event(FP_A, "2026-09-23T10:05:00.000Z"),
    event(FP_A, "2026-09-23T10:10:00.000Z"),
    event(FP_B, "2026-09-23T09:00:00.000Z"),
  ];
  const evidence = aggregateIncidents(events);
  const fpA = evidence.find((e) => e.fingerprint === FP_A)!;
  assert.equal(fpA.count, 3);
  assert.ok(fpA.burnPerHour > (evidence.find((e) => e.fingerprint === FP_B)!.burnPerHour));

  const worst = worstOpenIncident(evidence, (fp) => fp === FP_A);
  assert.equal(worst?.fingerprint, FP_B, "the burning-but-already-open fingerprint is skipped");
});

test("a ledger row missing a field, or carrying an unparseable ts, is skipped rather than read", () => {
  const row = { fingerprint: FP_A, kind: "exception", name: "TypeError", ts: "2026-09-23T10:00:00.000Z" };
  assert.deepEqual(incidentEventFromLedgerRow(row, "core"), {
    fingerprint: FP_A, ts: Date.parse(row.ts), kind: "exception", name: "TypeError",
    message: undefined, route: undefined, sha: undefined, instance: "core",
  });
  const full = incidentEventFromLedgerRow({ ...row, message: "boom", route: "/api", sha: "abc123" }, "core");
  assert.equal(full?.message, "boom");
  assert.equal(full?.route, "/api");
  assert.equal(full?.sha, "abc123");
  assert.equal(incidentEventFromLedgerRow({ ...row, fingerprint: undefined }, "core"), undefined);
  assert.equal(incidentEventFromLedgerRow({ ...row, ts: "not a date" }, "core"), undefined);
});

test("mergedPrsSince names each PR merged since the deploy sha, and nothing when git cannot answer", () => {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[2] === "log") return "sha1\u0001feat: one (#101)\nsha2\u0001a torn subject with no number\n\n";
    return "src/a.ts\nsrc/b.ts\n";
  };
  assert.deepEqual(mergedPrsSince("/repo", "o", "r", "dep1", run), [
    { url: "https://github.com/o/r/pull/101", files: ["src/a.ts", "src/b.ts"] },
  ]);
  assert.equal(calls[0][3], "dep1..origin/main");
  assert.deepEqual(calls[1], ["-C", "/repo", "show", "--name-only", "--format=", "sha1"]);
  assert.equal(calls.length, 2, "a subject with no PR number is never shown, never guessed from");

  calls.length = 0;
  mergedPrsSince("/repo", "o", "r", undefined, run);
  assert.ok(calls[0].includes("--since=24 hours ago"), "no deploy sha reads the last 24 hours");

  // The real git, in a directory that is no repository: the read fails and names no suspects.
  assert.deepEqual(mergedPrsSince(tmpRoot(), "o", "r", "dep1"), []);
});

test("an unreadable SRE lane store restarts empty", () => {
  const root = tmpRoot();
  const stateDir = join(root, "state");
  assert.deepEqual(readSreLaneStore(stateDir), {});
  writeFileSync(sreLaneStorePath(stateDir), "{ torn");
  assert.deepEqual(readSreLaneStore(stateDir), {});
  writeFileSync(sreLaneStorePath(stateDir), "null");
  assert.deepEqual(readSreLaneStore(stateDir), {});
});

test("a failing SRE lane pass is logged, never thrown out of the timer", async () => {
  const root = tmpRoot();
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const lane = startSreLane(baseDeps(root, {
    readEvents: () => { throw new Error("ledger unreadable"); },
    log: (step, extra) => { logged.push([step, extra]); },
  }))(60_000);
  await lane.settled();
  lane.stop();
  assert.deepEqual(logged, [["sre_lane.failed", { error: "ledger unreadable" }]]);
});

test("the daemon's SRE lane reads only the INCIDENT rows of this instance's own ledger", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.jsonl");
  const incident = { task_id: "INCIDENT", step: "incident.event", fingerprint: FP_A, kind: "exception", name: "TypeError", message: "boom", sha: "dep1" };
  writeFileSync(ledgerPath, [
    { ...incident, ts: "2026-09-23T10:00:00.000Z" },
    { ...incident, step: "incident.sampled", ts: "2026-09-23T10:05:00.000Z" },
    { ...incident, fingerprint: undefined, ts: "2026-09-23T10:06:00.000Z" },
    { ...incident, task_id: "W1-T1", fingerprint: FP_B, ts: "2026-09-23T10:07:00.000Z" },
    { ...incident, step: "run.start", fingerprint: FP_B, ts: "2026-09-23T10:08:00.000Z" },
    { ...incident, step: "run.start", fingerprint: FP_B, ts: "2026-09-23T10:09:00.000Z" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  // FP_B's three non-incident rows would outburn FP_A's two if they were read.
  const logged: string[] = [];
  const input = {
    stateDir: join(root, "state"), root, ledgerPath, owner: "o", repo: "r",
    mergedLastDay: () => 1, log: (step: string) => { logged.push(step); },
  };

  const lane = startSreLane(daemonSreLaneInput(input))(60_000);
  await lane.settled();
  lane.stop();
  const entries = listFeedback(root);
  assert.deepEqual(entries.map((e) => e.origin), [incidentFeedbackOrigin(FP_A)], "only the INCIDENT rows count");
  assert.ok(entries[0].raw.includes("Count: 2"), "both incident steps are read, the torn row is not");
  assert.ok(entries[0].raw.includes("Instance(s): r"));
  assert.deepEqual(logged, ["sre_lane.filed"]);
});
