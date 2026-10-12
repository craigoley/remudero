import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { projectChangeManagementGates, projectHumanGates, type HumanGateSource } from "../src/lib/human-gate.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, nowActions, type NowAction, type NowViewContext, type NowViewData } from "../src/lib/now-view.js";
import type { Plan } from "../src/lib/plan.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const AT = "2026-10-04T12:00:00.000Z";
const URL = "https://github.com/example/repo/pull/12";

function action(over: Partial<NowAction> = {}): NowAction {
  return { kind: "blocked_pr", prNumber: 12, prUrl: URL, disposition: "blocked-ambiguous",
    reason: "fix strikes exhausted (2/2)", tone: "exhausted", strike: { n: 2, of: 2 }, sortAt: AT, ...over };
}

function source(actions: readonly NowAction[], over: Partial<HumanGateSource> = {}): HumanGateSource {
  return projectChangeManagementGates({ instance: "core", state: "complete", actions, ...over });
}

test("a repairing PR produces no human gate", () => {
  const actions = nowActions({ blockedPrs: [{ kind: "blocked_pr", prNumber: 12, prUrl: URL,
    disposition: "blocked-fixable", reason: "unmet criteria (strike 1/2)" }], mergeHeld: [] }, []);
  assert.equal(actions[0]!.tone, "repairing");
  const projection = projectHumanGates([source(actions)]);
  assert.deepEqual(projection.gates, []);
  assert.deepEqual(projection.count.inbox, { count: 0 });
  assert.deepEqual(projection.count.changeManagement, { count: 0 });
});

test("exhausted repair is an Inbox ask while a merge hold is change management", () => {
  const held = action({ kind: "merge_held", prNumber: 13, disposition: "merge-held", tone: "held",
    reason: "operator release freeze", strike: undefined, prUrl: undefined });
  const projection = projectHumanGates([source([action(), held])]);
  assert.deepEqual(projection.count.inbox, { count: 1 });
  assert.deepEqual(projection.count.changeManagement, { count: 1 });
  assert.deepEqual(projection.count.byKind, { blocked_pr: 1 });
  const repair = projection.gates.find((gate) => gate.kind === "blocked_pr")!;
  assert.equal(repair.ownerSurface, "inbox");
  assert.equal(repair.openedAt, AT);
  assert.equal(repair.url, URL);
  assert.match(repair.reason, /blocked-ambiguous/);
  assert.match(repair.reason, /2\/2/);
  assert.equal(repair.resolutionVerb, "rework");
  const hold = projection.gates.find((gate) => gate.kind === "merge_held")!;
  assert.equal(hold.ownerSurface, "change-management");
  assert.match(hold.reason, /operator release freeze/);
  assert.equal(hold.resolutionVerb, "release_hold");
});

test("unknown PR dispositions preserve uncertainty and source evidence", () => {
  const unknown = action({ disposition: "blocked-ambiguous", tone: "unknown", reason: "GitHub timed out",
    strike: undefined, sortAt: undefined, prUrl: undefined });
  const projection = projectHumanGates([source([unknown])]);
  assert.deepEqual(projection.count.inbox, { atLeast: 1 });
  assert.equal(projection.sources[0]!.state, "partial");
  assert.match(projection.sources[0]!.reason!, /GitHub timed out/);
  assert.equal(projection.gates[0]!.ownerSurface, "inbox");
  assert.match(projection.gates[0]!.reason, /blocked-ambiguous.*GitHub timed out/);
  assert.equal(projection.gates[0]!.openedAt, null);
  assert.equal(projection.gates[0]!.url, null);
  assert.equal(projection.gates[0]!.resolutionVerb, "rework");
});

test("blocked work and fleet holds stay in change management", () => {
  const blocked = action({ tone: "blocked", reason: "repair can resume after its dependency", strike: undefined });
  const fleet = action({ kind: "merge_held", prNumber: undefined, tone: "held", disposition: "merge-held",
    reason: "fleet freeze", strike: undefined, prUrl: undefined });
  const projection = projectHumanGates([source([blocked, fleet])]);
  assert.deepEqual(projection.count.inbox, { count: 0 });
  assert.deepEqual(projection.count.changeManagement, { count: 2 });
  assert.deepEqual(projection.count.byKind, {});
  assert.deepEqual(projection.gates.map((gate) => gate.resolutionVerb).sort(), ["release_hold", "rework"]);
});

test("repeated snapshots deduplicate by PR condition and retain instance ownership", () => {
  const original = action();
  const repeated = action({ reason: "same condition refreshed", sortAt: "2026-10-04T12:01:00.000Z" });
  const before = JSON.stringify([original, repeated]);
  const projection = projectHumanGates([source([original]), source([repeated]), source([original], { instance: "site" })]);
  assert.equal(projection.gates.length, 2);
  assert.equal(new Set(projection.gates.map((gate) => gate.key)).size, 2);
  assert.ok(projection.gates.every((gate) => gate.openedAt === AT));
  assert.equal(JSON.stringify([original, repeated]), before);
  assert.deepEqual(projectHumanGates([source([repeated]), source([original])]), projectHumanGates([source([original]), source([repeated])]));
});

test("missing PR source evidence is retained even with no visible actions", () => {
  for (const state of ["partial", "unavailable"] as const) {
    const projection = projectHumanGates([source([], { state, reason: "open PR snapshot unavailable" })]);
    assert.deepEqual(projection.count.inbox, { atLeast: 0 });
    assert.deepEqual(projection.count.changeManagement, { atLeast: 0 });
    assert.equal(projection.sources[0]!.state, state);
    assert.equal(projection.sources[0]!.reason, "open PR snapshot unavailable");
  }
  const unknown = action({ tone: "unknown", reason: "disposition unverified" });
  assert.equal(source([unknown], { state: "unavailable", reason: "ledger unavailable" }).state, "unavailable");
  assert.match(source([unknown], { state: "partial", reason: "snapshot unreadable" }).reason!, /snapshot unreadable/);
});

function production(t: { after(fn: () => void): void }, readFailed = false, open = false) {
  const root = makeTempDir("human-gate-change-management");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = fixedClock(Date.parse(AT));
  const plan: Plan = { tasks: [], byId: new Map() };
  const github = {
    readFailed: () => readFailed, prByRef: () => open ? { state: "OPEN" } : null, findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
    listOpenHeadBranches: () => open ? [{ number: 12, state: "OPEN", url: URL, headRefName: "operator-pr",
      title: "repair this PR", body: "", isDraft: false, autoMergeRequest: null }] : [],
    headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "ask" }),
  } as unknown as GitHub;
  const rigs = ["core", "site"].map((name) => {
    const ledgerDir = join(root, name, "state");
    mkdirSync(ledgerDir, { recursive: true });
    const db = openProjectorReadModel(join(root, "read-model"), name, clock);
    t.after(() => db.close());
    const lease = acquireLease(db, { clock });
    assert.ok(lease.ok);
    const projector = createLedgerProjector({ ledgerDir, db, lease: lease.lease, clock });
    let sequence = 0;
    return { name, ledgerDir, db, append: (...rows: Array<Record<string, unknown>>) => {
      appendFileSync(join(ledgerDir, "ledger.ndjson"), rows.map((row) =>
        JSON.stringify({ ts: new Date(clock.now() + sequence++).toISOString(), ...row }) + "\n").join(""));
      projector.tick();
    } };
  });
  const view = createNowView({ instances: rigs, clock, readPlan: () => plan,
    github: () => ({ github, generation: "known", source: { asOf: AT, state: "fresh" } }),
    listGrilling: () => [], planBehind: () => ({ commits: 0 }),
    hostProbe: { readLive: () => [], diskFree: () => 1000, rateLimit: () => 5000 } });
  const latest = new Map<string, NowViewData>();
  return { rigs, read: () => {
    const ctx: NowViewContext = { now: clock.now(), switches: { views: { now: "serve" } },
      instances: rigs.map((rig) => ({ db: rig.db, state: { instance: rig.name, generation: Number(rig.db.meta("generation")),
        lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null } })) };
    for (const body of view.materialize(ctx)) latest.set(body.data.instance, body.data);
    return rigs.map((rig) => latest.get(rig.name)!);
  } };
}

function hold(pr: number | undefined, step = "automerge.hold_engaged") {
  return { step, ...(pr === undefined ? {} : { pr_number: pr }), by: "operator",
    reason: "release freeze", authority: "console-confirmed" };
}

test("hold release removes the matching instance and PR gate", (t) => {
  const { rigs, read } = production(t);
  rigs[0]!.append(hold(12), hold(13));
  rigs[1]!.append(hold(12));
  const before = read();
  assert.deepEqual(before.map((data) => data.humanGates!.gates.map((gate) => gate.key)),
    [["merge_held:core:12", "merge_held:core:13"], ["merge_held:site:12"]]);
  assert.ok(before.every((data) => data.humanGates!.count.inbox.count === 0 || data.humanGates!.count.inbox.atLeast === 0));
  rigs[0]!.append(hold(12, "automerge.hold_released"));
  const after = read();
  assert.deepEqual(after.map((data) => data.humanGates!.gates.map((gate) => gate.key)),
    [["merge_held:core:13"], ["merge_held:site:12"]]);
  rigs[0]!.append(hold(12));
  assert.deepEqual(read().map((data) => data.humanGates!.gates.map((gate) => gate.key).sort()),
    [["merge_held:core:12", "merge_held:core:13"], ["merge_held:site:12"]]);
});

test("unconfirmed release cannot clear the source-owned hold", (t) => {
  const { rigs, read } = production(t);
  rigs[0]!.append(hold(undefined), { ...hold(undefined, "automerge.hold_released"), authority: "worker" });
  assert.deepEqual(read()[0]!.humanGates!.gates.map((gate) => gate.key), ["merge_held:core:fleet"]);
  rigs[0]!.append(hold(undefined, "automerge.hold_released"));
  assert.deepEqual(read()[0]!.humanGates!.gates, []);
});

test("production now view retains unavailable change-management evidence", (t) => {
  const { rigs, read } = production(t, true);
  rigs[0]!.append({ step: "daemon.tick" });
  rigs[1]!.append({ step: "daemon.tick" });
  for (const data of read()) {
    const evidence = data.humanGates!.sources.find((entry) => entry.name === "change-management");
    assert.ok(evidence);
    assert.equal(evidence.instance, data.instance);
    assert.equal(evidence.state, "partial");
    assert.ok(evidence.reason);
    assert.deepEqual(data.humanGates!.count.inbox, { atLeast: 0 });
  }
});

test("production now view moves a PR from machine repair to an evidenced Inbox ask", (t) => {
  const { rigs, read } = production(t, false, true);
  const disposed = { step: "sweep.disposed", pr_number: 12, pr_url: URL, acted: false };
  rigs[0]!.append({ ...disposed, disposition: "blocked-fixable", reason: "unmet criteria (strike 1/2)" });
  rigs[1]!.append({ step: "daemon.tick" });
  const repairing = read()[0]!;
  assert.equal(repairing.actions[0]!.tone, "repairing");
  assert.deepEqual(repairing.humanGates!.gates, []);
  rigs[0]!.append({ ...disposed, disposition: "blocked-ambiguous", reason: "fix strikes exhausted (2/2)" });
  const exhausted = read()[0]!.humanGates!;
  assert.equal(exhausted.gates.length, 1);
  assert.equal(exhausted.gates[0]!.ownerSurface, "inbox");
  assert.equal(exhausted.gates[0]!.url, URL);
  assert.match(exhausted.gates[0]!.reason, /failed repair attempts 2\/2/);
  assert.equal(exhausted.gates[0]!.resolutionVerb, "rework");
  rigs[0]!.append({ ...disposed, disposition: "blocked-ambiguous", reason: "checks could not be verified" });
  const unknown = read()[0]!.humanGates!;
  assert.match(unknown.gates[0]!.reason, /checks could not be verified/);
  assert.equal(unknown.sources.find((entry) => entry.name === "change-management")!.state, "partial");
  assert.deepEqual(unknown.count.inbox, { atLeast: 1 });
  rigs[0]!.append({ ...disposed, disposition: "blocked-fixable", reason: "repair resumed (strike 1/3)" });
  assert.deepEqual(read()[0]!.humanGates!.gates, []);
});
