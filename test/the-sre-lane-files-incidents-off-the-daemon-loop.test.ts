/**
 * W1-T9615 — the SRE lane files incidents off the daemon loop.
 *
 * MEASURED 2026-10-15 (core ledger): from the lane's first start at 03:43Z each `sre_lane.filed` held the daemon loop
 * 60-190 s. runSreLanePass captured through captureFeedback, whose inline landFeedback drove the SYNCHRONOUS landing
 * and its plan-PR preflight (spawnSync of lint-plan-precheck, task-id-existence-check and the shard census), and 17
 * App token refreshes timed out behind the held loop. A daemon-loop capture now STAGES its record in W1-T5460's landing
 * queue, which the per-poll async sweep lands; the CLI keeps its inline capture.
 *
 * The sync spawns are observed for real: node:child_process's sync primitives are wrapped for the duration of a pass,
 * so an inline landing shows up as its `git ... fetch`, whatever seam the code under test does or does not expose. The
 * sweep's repair filing is proven beside its other tests (test/repair-filing-respects-prior-rejection.test.ts).
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import { feedbackCaptured, feedbackEntryPath, listFeedback, stageFeedbackCapture } from "../src/lib/feedback.js";
import { queuedFeedbackDir, queuedFeedbackLandings } from "../src/lib/feedback-landing.js";
import { issueFeedbackId, normalizeIssue, pollIssues } from "../src/lib/issues-intake.js";
import { alertFeedbackId, pollAlerts, type RawAlert } from "../src/lib/ops.js";
import {
  daemonSreLaneInput,
  incidentFeedbackId,
  incidentFeedbackOrigin,
  runSreLanePass,
  type IncidentLedgerEvent,
  type SreLaneInput,
} from "../src/lib/sre-lane.js";

const FP = "c".repeat(64);
const ID = incidentFeedbackId(FP);
const QUEUED = `plan/feedback/${ID}.yaml`;

/** A lane's two roots, apart as in the daemon: the checkout it files into and the state root whose queue the sweep drains. */
function laneRoots(): { root: string; stateRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "rmd-w9615-"));
  const root = join(base, "checkout");
  const stateRoot = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  return { root, stateRoot };
}

function event(atIso: string): IncidentLedgerEvent {
  return { fingerprint: FP, ts: Date.parse(atIso), kind: "exception", name: "TypeError", message: "boom", instance: "core" };
}

function laneDeps(root: string, stateRoot: string, logged: Array<[string, Record<string, unknown>]>): SreLaneInput {
  const events = [event("2026-10-15T04:00:00.000Z"), event("2026-10-15T04:05:00.000Z")];
  return {
    stateDir: join(stateRoot, "state"),
    root,
    landingStateRoot: stateRoot,
    readEvents: () => events,
    hasOpenTask: () => false,
    framesFor: () => [],
    mergedPrsSince: () => [],
    mergedLastDay: () => 10,
    readLandedEntry: () => null,
    detectors: [],
    readFlowRows: async () => [],
    writeFlowEvent: () => {},
    log: (step, extra = {}) => { logged.push([step, extra]); },
  };
}

/** Every synchronous child-process spawn `run` makes, as argv (the command first). */
async function syncSpawnsDuring<T>(run: () => Promise<T> | T): Promise<{ result: T; spawns: string[][] }> {
  const spawns: string[][] = [];
  const real = { execFileSync: childProcess.execFileSync, spawnSync: childProcess.spawnSync, execSync: childProcess.execSync };
  const record = (file: unknown, args: unknown) => { spawns.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])]); };
  mock.method(childProcess, "execFileSync", (file: string, args?: readonly string[], opts?: object) => {
    record(file, args);
    return real.execFileSync(file, args, opts as never);
  });
  mock.method(childProcess, "spawnSync", (file: string, args?: readonly string[], opts?: object) => {
    record(file, args);
    return real.spawnSync(file, args, opts as never);
  });
  mock.method(childProcess, "execSync", (command: string, opts?: object) => {
    record(command, []);
    return real.execSync(command, opts as never);
  });
  syncBuiltinESMExports();
  try {
    return { result: await run(), spawns };
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

/** A spawn that is part of a landing (the fetch it opens with, a push, a preflight tree or its node checks). */
function landingSpawns(spawns: readonly string[][]): string[][] {
  return spawns.filter((argv) => argv.some((a) => /^(?:fetch|push|ls-remote|worktree|commit-tree|read-tree)$/.test(a) || /\.mjs$/.test(a)));
}

test("W1-T9615: an SRE lane filing never reaches the synchronous plan-PR preflight", async () => {
  const { root, stateRoot } = laneRoots();
  const logged: Array<[string, Record<string, unknown>]> = [];
  const { result, spawns } = await syncSpawnsDuring(() => runSreLanePass(laneDeps(root, stateRoot, logged)));

  assert.equal(result.filed, FP, "the pass files the incident");
  assert.deepEqual(landingSpawns(spawns), [], "no landing ran on the loop: no fetch, push, preflight tree or check script");
  assert.deepEqual(queuedFeedbackLandings(stateRoot), [QUEUED], "the record waits in the state root's landing queue for the async sweep");
  assert.equal(existsSync(feedbackEntryPath(root, ID)), false, "the record moved out of the checkout, so no inline landing can push it");
  const queued = readFileSync(join(queuedFeedbackDir(stateRoot), `${ID}.yaml`), "utf8");
  assert.match(queued, new RegExp(`origin: incident#${FP}`));
  assert.deepEqual(logged.filter(([step]) => step === "sre_lane.filed").map(([, extra]) => extra.landing), ["queued"]);
});

test("W1-T9615: a staged incident is not filed again by the next pass", async () => {
  const { root, stateRoot } = laneRoots();
  const logged: Array<[string, Record<string, unknown>]> = [];
  const deps = laneDeps(root, stateRoot, logged);
  const first = await runSreLanePass(deps);
  assert.equal(first.filed, FP);
  assert.deepEqual(queuedFeedbackLandings(stateRoot), [QUEUED], "precondition: the first filing is staged, not in the checkout");
  assert.equal(listFeedback(root).length, 0);
  const bytes = readFileSync(join(queuedFeedbackDir(stateRoot), `${ID}.yaml`), "utf8");

  const second = await runSreLanePass(deps);
  assert.equal(second.filed, undefined, "the queued record is open feedback for its fingerprint");
  assert.equal(readFileSync(join(queuedFeedbackDir(stateRoot), `${ID}.yaml`), "utf8"), bytes, "the staged record is never rewritten");
  assert.equal(listFeedback(root).length, 0, "nothing new lands in the checkout either");
  assert.equal(logged.filter(([step]) => step === "sre_lane.filed").length, 1);
});

test("W1-T9615: the daemon's SRE lane input stages in its own state root's queue", () => {
  const { root, stateRoot } = laneRoots();
  const base = { stateDir: join(stateRoot, "state"), root, ledgerPath: join(stateRoot, "state", "ledger.ndjson"), owner: "o", repo: "r", mergedLastDay: () => 1, log: () => {} };
  assert.equal(daemonSreLaneInput(base).landingStateRoot, stateRoot, "the parent of the lane's state dir, the root the landing sweep drains");
  assert.equal(daemonSreLaneInput({ ...base, landingStateRoot: join(stateRoot, "other") }).landingStateRoot, join(stateRoot, "other"));
});

test("W1-T9615: a staged capture lands nothing inline, and an id already queued is returned untouched", async () => {
  const { root, stateRoot } = laneRoots();
  const opts = { id: "incident-staged", raw: "boom", origin: incidentFeedbackOrigin(FP) };
  const { result: staged, spawns } = await syncSpawnsDuring(() => stageFeedbackCapture(root, stateRoot, opts));
  assert.equal(staged.queued, true);
  assert.deepEqual(landingSpawns(spawns), []);
  assert.equal(feedbackCaptured(root, "incident-staged", stateRoot), true, "the dedup read sees the queued record");
  assert.equal(feedbackCaptured(root, "incident-staged"), false, "the checkout alone does not hold it");

  const again = stageFeedbackCapture(root, stateRoot, { ...opts, raw: "different bytes" });
  assert.equal(again.queued, false);
  assert.equal(again.entry.raw, "boom", "the queued entry is the answer, never re-captured");
  assert.deepEqual(queuedFeedbackLandings(stateRoot), ["plan/feedback/incident-staged.yaml"]);

  // With no state root the copy stays in the checkout, where the async sweep's dirty scan lands it; still nothing inline.
  const { result: kept, spawns: keptSpawns } = await syncSpawnsDuring(() => stageFeedbackCapture(root, undefined, { ...opts, id: "incident-kept" }));
  assert.equal(kept.queued, false);
  assert.equal(existsSync(feedbackEntryPath(root, "incident-kept")), true);
  assert.deepEqual(landingSpawns(keptSpawns), []);
});

const ALERT = {
  source: "code-scanning", id: "77", severity: "high", summary: "race (#77)",
  url: "https://github.com/o/r/security/code-scanning/77", state: "open", createdAt: "2026-10-15T04:00:00Z",
} as unknown as RawAlert;

function alertDeps(root: string, stateRoot: string) {
  return {
    alerts: { codeScanning: () => [ALERT], dependabot: () => [], secretScanning: () => [] },
    issues: { create: () => "https://github.com/o/r/issues/1" },
    ledgerPath: join(stateRoot, "state", "ledger.ndjson"),
    runId: "OPS-W9615",
    root,
    readLedger: () => [],
    now: () => Date.parse("2026-10-15T05:00:00Z"),
    landingStateRoot: stateRoot,
  } as never;
}

test("W1-T9615: the daemon's alert poll stages a new alert entry and skips it while queued", async () => {
  const { root, stateRoot } = laneRoots();
  const id = alertFeedbackId("o", "r", ALERT);
  const { result: first, spawns } = await syncSpawnsDuring(() => pollAlerts("o", "r", alertDeps(root, stateRoot)));
  assert.equal(first.feedbackCreated.length, 1);
  assert.deepEqual(landingSpawns(spawns), [], "no inline landing on the daemon's intake rung");
  assert.deepEqual(queuedFeedbackLandings(stateRoot), [`plan/feedback/${id}.yaml`]);
  assert.equal(existsSync(feedbackEntryPath(root, id)), false);

  const second = await pollAlerts("o", "r", alertDeps(root, stateRoot));
  assert.equal(second.feedbackCreated.length, 0, "the queued entry is the dedup hit");
});

test("W1-T9615: the daemon's issue poll stages a new issue entry and skips it while queued", async () => {
  const { root, stateRoot } = laneRoots();
  const issue = normalizeIssue("o", "r", { number: 9, title: "t", body: "b", state: "open", created_at: "2026-10-15T04:00:00Z", html_url: "https://github.com/o/r/issues/9", labels: [] });
  const deps = { issues: { list: () => [issue] }, root, ledgerPath: join(stateRoot, "state", "ledger.ndjson"), runId: "ISSUES-W9615", now: () => Date.parse("2026-10-15T05:00:00Z"), landingStateRoot: stateRoot };
  const { result: first, spawns } = await syncSpawnsDuring(() => pollIssues([{ owner: "o", repo: "r" }], deps));
  assert.equal(first.created.length, 1);
  assert.deepEqual(landingSpawns(spawns), [], "no inline landing on the daemon's intake rung");
  const id = issueFeedbackId("o", "r", 9);
  assert.deepEqual(queuedFeedbackLandings(stateRoot), [`plan/feedback/${id}.yaml`]);

  const second = await pollIssues([{ owner: "o", repo: "r" }], deps);
  assert.equal(second.created.length, 0);
  assert.equal(second.skippedExisting, 1, "the queued entry is the dedup hit");
});
