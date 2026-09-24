// test/sre-lane.test.ts — W1-T4385: the SRE gardener runs in its own lightweight lane.
//
// Acceptance (plan/tasks.d/W1-T4385-*.yaml):
//   - a fingerprint with open feedback or an open task is never filed twice
//   - an incident names the merged pull requests that touched its in-app frames
//   - incident filing is paced by the fleet's own merge rate
//   - the daemon starts the SRE lane among its gardens (grep: startSreLane( in src/run-task.ts)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { listFeedback } from "../src/lib/feedback.js";
import {
  aggregateIncidents,
  fingerprintAlreadyOpen,
  incidentFeedbackOrigin,
  runSreLanePass,
  sreLaneRoom,
  suspectPullRequests,
  worstOpenIncident,
  type IncidentLedgerEvent,
  type MergedPrFiles,
  type SreLaneDeps,
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

function baseDeps(root: string, overrides: Partial<SreLaneDeps> = {}): SreLaneDeps {
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

test("a fingerprint with open feedback or an open task is never filed twice", () => {
  // Part 1: an ordinary pass files the worst incident, and its own feedback entry then blocks a
  // second pass from filing it again — the same aggregate re-read, nothing else changed.
  const root = tmpRoot();
  const events = [event(FP_A, "2026-09-23T10:00:00.000Z"), event(FP_A, "2026-09-23T10:05:00.000Z"), event(FP_A, "2026-09-23T10:10:00.000Z")];
  const deps = baseDeps(root, { readEvents: () => events });

  const first = runSreLanePass(deps);
  assert.equal(first.filed, FP_A);
  const entries = listFeedback(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].origin, incidentFeedbackOrigin(FP_A));

  const second = runSreLanePass(deps);
  assert.equal(second.filed, undefined, "the same fingerprint's own open feedback must never be filed twice");

  // Part 2: a fingerprint with no feedback entry at all is still refused when an open plan task
  // already covers it — the plan-side half of the same guard.
  const root2 = tmpRoot();
  const deps2 = baseDeps(root2, { readEvents: () => events, hasOpenTask: () => true });
  const pass = runSreLanePass(deps2);
  assert.equal(pass.filed, undefined, "an open task must block filing even with no feedback entry yet");
  assert.equal(listFeedback(root2).length, 0);

  // The pure predicate underneath both halves, directly.
  assert.equal(fingerprintAlreadyOpen(FP_A, new Set([incidentFeedbackOrigin(FP_A)]), () => false), true);
  assert.equal(fingerprintAlreadyOpen(FP_A, new Set(), () => true), true);
  assert.equal(fingerprintAlreadyOpen(FP_A, new Set(), () => false), false);
});

test("an incident names the merged pull requests that touched its in-app frames", () => {
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
  const pass = runSreLanePass(deps);
  assert.equal(pass.filed, FP_A);
  const raw = listFeedback(root)[0].raw;
  assert.ok(raw.includes("https://github.com/o/r/pull/101"), "raw must name the suspect PR");
  assert.ok(!raw.includes("https://github.com/o/r/pull/102"), "raw must not name the unrelated PR");
});

test("incident filing is paced by the fleet's own merge rate", () => {
  assert.equal(sreLaneRoom(0, 0), 0);
  assert.equal(sreLaneRoom(3, 1), 2);
  assert.equal(sreLaneRoom(1, 5), 0);

  // A quiet fleet (nothing merged in the last day) never files, no matter how bad the incident.
  const root = tmpRoot();
  const events = [event(FP_A, "2026-09-23T10:00:00.000Z"), event(FP_A, "2026-09-23T10:01:00.000Z")];
  const quiet = baseDeps(root, { readEvents: () => events, mergedLastDay: () => 0 });
  assert.equal(runSreLanePass(quiet).filed, undefined);
  assert.equal(listFeedback(root).length, 0);

  // A fleet merging exactly one PR a day files exactly one incident, then stops even though a
  // second, distinct fingerprint is still open and unfiled.
  const root2 = tmpRoot();
  const twoFingerprints = [event(FP_A, "2026-09-23T10:00:00.000Z"), event(FP_B, "2026-09-23T09:00:00.000Z")];
  const pacedDeps = baseDeps(root2, { readEvents: () => twoFingerprints, mergedLastDay: () => 1 });
  const filedFirst = runSreLanePass(pacedDeps);
  assert.equal(filedFirst.room, 0);
  assert.ok(filedFirst.filed === FP_A || filedFirst.filed === FP_B);
  const secondPass = runSreLanePass(pacedDeps);
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
