import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { projectHumanGates, projectPinReviewerGates } from "../src/lib/human-gate.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, type NowViewData, NOW_DAEMON_SILENT_MS } from "../src/lib/now-view.js";
import { loadPolicy, policyPath } from "../src/lib/policy.js";
import { buildRatificationRow, ratificationPinCheck, renderRatificationRow } from "../src/lib/ratification.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { trackStaleReviewerSkipRecurrence } from "../src/lib/sweep.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const AT = "2026-10-04T12:00:00.000Z";
const NOW = Date.parse(AT);
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const URL = "https://github.com/example/repo/pull/12";
const policy = loadPolicy(policyPath(process.cwd())).values;
const pin = buildRatificationRow("autoTriage", policy.autoTriage, "v1", "operator", new Date(AT));
const pins = new Map([[pin.rung, pin]]);
const drift = ratificationPinCheck(pin.rung, policy.autoTriage, "v2", pins);
assert.equal(drift.fire, false);
const row = (step: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ ts: AT, step, ...over });
const boot = row("daemon.boot", { head_sha: OLD });
const ask = row("review.stale_reviewer_needs_human", { code_sha: OLD, origin_main_sha: NEW,
  reason: "restart came back on the same sha", pr_url: URL });
const refusal = row("rung.unratified", { rung: pin.rung, diff: drift.fire ? "" : drift.diff });

function project(rows: Array<Record<string, unknown>>, over: Partial<Parameters<typeof projectPinReviewerGates>[0]> = {}) {
  return projectHumanGates(projectPinReviewerGates({ instance: "core", state: "complete", rows,
    pins, policy, nowMs: NOW, freshnessBudgetMs: NOW_DAEMON_SILENT_MS, ...over }));
}

test("an absent pin creates no human gate while a hash mismatch does", () => {
  assert.deepEqual(project([], { pins: new Map() }).gates, []);
  const mismatch = project([refusal]);
  assert.equal(mismatch.gates.length, 1);
  assert.equal(mismatch.gates[0]!.key, "pin_drift:core:autoTriage");
  assert.equal(mismatch.gates[0]!.resolutionVerb, "reratify");
  assert.equal(mismatch.gates[0]!.openedAt, AT);
  assert.match(mismatch.gates[0]!.reason, /ratified.*live policy/);
  assert.deepEqual(project([refusal], { pins: new Map() }).gates, mismatch.gates);
  const matching = buildRatificationRow(pin.rung, policy.autoTriage, "v2", "operator", new Date(AT));
  assert.deepEqual(project([refusal], { pins: new Map([[pin.rung, matching]]) }).gates, []);
  assert.deepEqual([...pins.values()], [pin]);
});

test("reviewer recovery stays machine-owned until the source asks for a person", () => {
  const observation = { codeSha: OLD, originMainSha: NEW };
  const first = trackStaleReviewerSkipRecurrence(observation, undefined);
  const held = trackStaleReviewerSkipRecurrence(observation, first.state);
  const restart = trackStaleReviewerSkipRecurrence(observation, held.state, 3);
  for (const action of [first.action, held.action, restart.action]) {
    const step = action.kind === "held" ? "review.stale_reviewer_held" :
      action.kind === "restart" ? "review.stale_reviewer_restart_requested" : "review.skipped_stale_reviewer_code";
    assert.deepEqual(project([boot, row(step, { code_sha: OLD, origin_main_sha: NEW })]).gates, []);
  }
  const human = trackStaleReviewerSkipRecurrence(observation, { ...restart.state!, restartRequested: true });
  assert.equal(human.action.kind, "needs_human");
  const gates = project([boot, ask]).gates;
  assert.equal(gates.length, 1);
  assert.equal(gates[0]!.key, `stale_reviewer:core:${OLD}`);
  assert.equal(gates[0]!.ownerSurface, "inbox");
  assert.equal(gates[0]!.resolutionVerb, "restart");
  assert.equal(gates[0]!.url, URL);
  assert.equal(gates[0]!.openedAt, AT);
  assert.equal(gates[0]!.reason, ask.reason);
  for (const step of ["review.stale_reviewer_held", "review.stale_reviewer_restart_requested"]) {
    assert.deepEqual(project([boot, ask, row(step, { ts: new Date(NOW + 1).toISOString(), code_sha: OLD,
      origin_main_sha: NEW })], { nowMs: NOW + 2 }).gates, []);
  }
});

test("a newer reviewer identity supersedes an old gate without hiding unknown evidence", () => {
  const newerBoot = row("daemon.boot", { ts: new Date(NOW + 1).toISOString(), head_sha: NEW });
  const superseded = project([ask, boot, newerBoot], { nowMs: NOW + 2 });
  assert.deepEqual(superseded.gates, []);
  assert.equal(superseded.sources[1]!.state, "partial");
  assert.deepEqual(superseded.count.inbox, { atLeast: 0 });
  const newAsk = { ...ask, ts: new Date(NOW + 2).toISOString(), code_sha: NEW, origin_main_sha: "c".repeat(40) };
  assert.equal(project([newAsk, boot, ask, newerBoot], { nowMs: NOW + 3 }).gates[0]!.key, `stale_reviewer:core:${NEW}`);
  const unreadable = row("daemon.freshness_not_stale", { ts: new Date(NOW + 1).toISOString(),
    arm: "unassessed", detail: "origin/main could not be read" });
  const unknown = project([boot, ask, unreadable], { nowMs: NOW + 2 });
  assert.equal(unknown.gates.length, 1);
  assert.deepEqual(unknown.count.inbox, { atLeast: 1 });
  assert.match(unknown.sources[1]!.reason!, /origin\/main could not be read/);
  const noIdentity = project([ask]);
  assert.deepEqual(noIdentity.count.inbox, { atLeast: 1 });
  assert.match(noIdentity.sources[1]!.reason!, /loaded.*identity/);
});

test("current reviewer evidence resolves the ask and stale evidence cannot report healthy zero", () => {
  const fresh = row("daemon.freshness_not_stale", { ts: new Date(NOW + 1).toISOString(), arm: "up_to_date" });
  const resolved = project([ask, boot, fresh], { nowMs: NOW + 2 });
  assert.deepEqual(resolved.gates, []);
  assert.deepEqual(resolved.count.inbox, { count: 0 });
  const agedResolution = project([ask, boot, fresh], { nowMs: NOW + NOW_DAEMON_SILENT_MS + 2 });
  assert.deepEqual(agedResolution.gates, []);
  assert.deepEqual(agedResolution.count.inbox, { atLeast: 0 });
  const laterUnknown = row("daemon.freshness_not_stale", { ts: new Date(NOW + 2).toISOString(),
    arm: "unassessed", detail: "upstream unreadable" });
  assert.deepEqual(project([ask, boot, fresh, laterUnknown], { nowMs: NOW + 3 }).gates, []);
  const stale = project([boot, fresh], { nowMs: NOW + NOW_DAEMON_SILENT_MS + 2 });
  assert.deepEqual(stale.count.inbox, { atLeast: 0 });
  assert.match(stale.sources[1]!.reason!, /stale/);
  const unreadable = project([refusal, boot, ask], { state: "unavailable", reason: "archive unreadable", pinReason: "pin unreadable" });
  assert.equal(unreadable.gates.length, 2);
  assert.deepEqual(unreadable.count.inbox, { atLeast: 2 });
});

test("malformed pin observations retain uncertainty and instances keep separate keys", () => {
  const bad = project([row("rung.unratified", { rung: pin.rung, diff: "unreadable operation hash" })]);
  assert.equal(bad.sources[0]!.state, "partial");
  assert.equal(bad.gates.length, 1);
  const other = project([refusal, boot, ask], { instance: "site" });
  assert.deepEqual(other.gates.map((gate) => gate.key).sort(), ["pin_drift:site:autoTriage", `stale_reviewer:site:${OLD}`]);
});

test("production now view rereads pin and reviewer sources outside its fact selection", (t) => {
  const root = makeTempDir("human-gate-pin-reviewer");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerDir = join(root, "state");
  const planDir = join(root, "plan");
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  const pinPath = join(planDir, "ratifications.yaml");
  writeFileSync(pinPath, renderRatificationRow(pin));
  writeFileSync(join(planDir, "policy.yaml"), readFileSync(policyPath(process.cwd()), "utf8"));
  const clock = fixedClock(NOW);
  const db = openProjectorReadModel(join(root, "read-model"), "core", clock);
  t.after(() => db.close());
  const lease = acquireLease(db, { clock });
  assert.ok(lease.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: lease.lease, clock });
  const github = { readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [], listOpenHeadBranches: () => [],
    headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => null } as unknown as GitHub;
  const view = createNowView({ instances: [{ name: "core", ledgerDir, planPath: join(planDir, "tasks.yaml") }], clock,
    readPlan: () => ({ tasks: [], byId: new Map() }), planBehind: () => ({ commits: 0 }),
    github: () => ({ github, generation: "known", source: { asOf: AT, state: "fresh" } }),
    hostProbe: { readLive: () => [], diskFree: () => 1000, rateLimit: () => 5000 } });
  let sequence = 0;
  const append = (...rows: Array<Record<string, unknown>>) => {
    appendFileSync(join(ledgerDir, "ledger.ndjson"), rows.map((r) => JSON.stringify({ ...r,
      ts: new Date(NOW + sequence++).toISOString() }) + "\n").join(""));
    projector.tick();
  };
  const read = (): NowViewData => view.materialize({ now: NOW + sequence,
    switches: { views: { now: "serve" } }, instances: [{ db, state: { instance: "core",
      generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: NOW, newestTs: null } }] })[0]!.data;
  append(boot, refusal, ask);
  assert.deepEqual(read().humanGates!.gates.map((gate) => gate.kind).sort(), ["pin_drift", "stale_reviewer"]);
  const matching = buildRatificationRow(pin.rung, policy.autoTriage, "v2", "operator", new Date(AT));
  writeFileSync(pinPath, renderRatificationRow(matching));
  assert.deepEqual(read().humanGates!.gates.map((gate) => gate.kind), ["stale_reviewer"]);
  append(row("daemon.freshness_not_stale", { arm: "up_to_date" }));
  assert.deepEqual(read().humanGates!.gates, []);
  writeFileSync(pinPath, "[broken yaml");
  assert.equal(read().humanGates!.sources.find((source) => source.name === "ratification-pins")!.state, "unavailable");
  writeFileSync(pinPath, "- rung: autoTriage\n");
  assert.match(read().humanGates!.sources.find((source) => source.name === "ratification-pins")!.reason!, /unreadable rows/);
  rmSync(pinPath);
  assert.deepEqual(read().humanGates!.gates.map((gate) => gate.kind), ["pin_drift"]);
  writeFileSync(pinPath, renderRatificationRow(matching));
  writeFileSync(join(planDir, "policy.yaml"), "[broken yaml");
  assert.match(read().humanGates!.sources.find((source) => source.name === "ratification-pins")!.reason!, /cannot read current ratification source/);
});
