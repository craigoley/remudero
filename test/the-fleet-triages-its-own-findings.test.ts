/**
 * test/the-fleet-triages-its-own-findings.test.ts — W1-T4089.
 *
 * W1-T4086 took the fleet's own findings out of the operator's inbox. The daemon now files the ready
 * ones at the pace the fleet merges work and folds duplicates, each with a plain reason; a finding
 * the inbox classification has retired never reaches it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon } from "../src/lib/daemon.js";
import {
  classificationSnapshotPath,
  findingSubject,
  fleetLaneDecisions,
  fleetLaneOffPath,
  fleetLaneStorePath,
  readFleetLaneStore,
  mergedInLastDay,
  startFleetLane,
  triageFleetLane,
  writeClassificationSnapshot,
  type FleetLaneDeps,
} from "../src/lib/fleet-lane.js";
import { machineTokens } from "../src/lib/inbox-plain.js";
import { buildPanelGraphRoutes } from "../src/lib/panel-graph.js";
import { loadPlan } from "../src/lib/plan.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { type RunResult } from "../src/run-task.js";

const A1 = "adoption:field-no-writer:src/lib/plan.ts:context:";
const A2 = "adoption:export-no-caller:src/lib/plan.ts:loadPlanAtRef";
const P1 = "proof-debt:W1-T2";
const P2 = "proof-debt:W1-T3";
const F1 = "followup:W1-T3999:research";
const RETIRED = "proof-debt:W1-T4";
const VH = "verify-human:W1-T235";

interface Fx {
  stateDir: string;
  ledgerPath: string;
  approved: string[];
  deps: (merged: number) => FleetLaneDeps;
  ledger: () => Array<Record<string, unknown>>;
}

function fx(states: Record<string, string>, drafted: string[]): Fx {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4089-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: Object.keys(states).map((id) => ({ id, summary: id, evidenceAnchors: [] })) }));
  writeFileSync(
    join(stateDir, "inbox-drafts.json"),
    JSON.stringify(Object.fromEntries(drafted.map((id) => [id, { proposalId: id, fragmentYaml: "[]", stampLine: "", anchorFingerprint: "" }]))),
  );
  writeClassificationSnapshot(stateDir, Object.entries(states).map(([proposalId, state]) => ({ proposalId, state })));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const approved: string[] = [];
  return {
    stateDir,
    ledgerPath,
    approved,
    deps: (merged) => ({ stateDir, ledgerPath, mergedLastDay: () => merged, approve: (id) => void approved.push(id) }),
    ledger: () => {
      try {
        return readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
  };
}

test("W1-T4089: a fleet finding is filed, merged or retired with a plain reason", () => {
  const f = fx({ [A1]: "ready", [A2]: "ready", [P1]: "ready", [RETIRED]: "retired", [VH]: "ready" }, [A1, A2, P1, RETIRED, VH]);
  const pass = triageFleetLane(f.deps(10));
  assert.deepEqual(pass.merged, [A2], "the second finding about the same file is folded into the first");
  assert.equal(pass.filed.length, 1, "one finding a pass: concurrent approves race on one checkout");
  triageFleetLane(f.deps(10));
  assert.deepEqual([...f.approved].sort(), [A1, P1].sort(), "filed through the ordinary approve, one per pass");
  assert.ok(!f.approved.includes(RETIRED), "a finding the inbox retired is never filed");
  assert.ok(!f.approved.includes(VH), "an operator item is never the fleet's to file");
  const decided = f.ledger().filter((l) => l.step === "fleet_lane.decided");
  assert.equal(decided.length, 3);
  for (const d of decided) assert.deepEqual(machineTokens(String(d.reason)), [], `${d.task_id}: the reason is plain`);
  assert.ok(f.ledger().some((l) => l.step === "panel.proposal_declined" && l.task_id === A2), "a fold is an ordinary, reversible decline");
  const decisions = fleetLaneDecisions(f.ledger());
  assert.equal(decisions.get(A1)?.decision, "file");
  assert.equal(decisions.get(A2)?.decision, "merge");
});

test("W1-T4089: filing follows the fleet merge rate", () => {
  const ids = [P1, P2, F1, "proof-debt:W1-T5", "proof-debt:W1-T6"];
  const f = fx(Object.fromEntries(ids.map((id) => [id, "ready"])), ids);
  assert.equal(triageFleetLane(f.deps(2)).filed.length, 1, "two merged in the last day: one filed this pass");
  assert.equal(triageFleetLane(f.deps(2)).filed.length, 1, "and the second on the next");
  assert.equal(triageFleetLane(f.deps(2)).filed.length, 0, "the day's room is spent");
  assert.equal(triageFleetLane(f.deps(4)).filed.length, 1, "the fleet sped up: room for more");
  assert.equal(triageFleetLane(f.deps(4)).filed.length, 1);
  assert.equal(triageFleetLane(f.deps(0)).filed.length, 0, "a fleet that merged nothing gets nothing new");
  // Oldest of the most common kind first.
  assert.deepEqual(f.approved.slice(0, 2), [P1, P2]);
});

test("the fleet lane remembers its decisions after the live ledger rotates", () => {
  // 2026-09-23: the lane read its past decisions from the live ledger, which rotates every few
  // minutes, so each pass forgot them and re-filed 47 findings about seven times each.
  const f = fx({ [P1]: "ready", [P2]: "ready" }, [P1, P2]);
  assert.deepEqual(triageFleetLane(f.deps(5)).filed, [P1]);
  writeFileSync(f.ledgerPath, ""); // the live ledger rotated away
  assert.deepEqual(triageFleetLane(f.deps(5)).filed, [P2], "P1 is not filed a second time");
  assert.deepEqual(triageFleetLane(f.deps(5)).filed, []);
  assert.deepEqual(f.approved, [P1, P2]);
  assert.equal(readFleetLaneStore(f.stateDir)[P1]?.decision, "file");
  // A store that cannot be read stops the pass rather than forgetting every decision.
  writeFileSync(fleetLaneStorePath(f.stateDir), "{ torn");
  assert.throws(() => triageFleetLane(f.deps(5)));
});

test("W1-T4089: two findings with the same subject become one task", () => {
  assert.equal(findingSubject(A1), findingSubject(A2), "same kind, same file");
  assert.notEqual(findingSubject(A1), findingSubject(P1));
  assert.equal(findingSubject("followup:W1-T3999:research"), findingSubject("followup:W1-T3999:ci"), "same kind, same task");
  assert.notEqual(findingSubject("proof-debt:W1-T3999"), findingSubject("followup:W1-T3999:ci"), "different kinds stay apart");
  assert.equal(findingSubject("codeql-quality:js/x"), "codeql-quality|js/x");
  assert.equal(findingSubject("skill-draft:implement-clean-a4ce"), undefined, "a finding that names nothing shared is never folded");
  const f = fx({ "followup:W1-T3999:research": "ready", "followup:W1-T3999:ci": "not_ready" }, ["followup:W1-T3999:research"]);
  const pass = triageFleetLane(f.deps(5));
  assert.deepEqual(pass.merged, ["followup:W1-T3999:ci"]);
  assert.deepEqual(pass.filed, ["followup:W1-T3999:research"]);
  assert.deepEqual(triageFleetLane(f.deps(5)), { filed: [], merged: [], room: 5 - 1 }, "a second pass decides nothing twice");
});

test("W1-T4089: a finding whose evidence no longer holds is retired", () => {
  // The inbox classification owns retirement; the lane reads it and never files or folds a retired one.
  const f = fx({ [P1]: "retired", [P2]: "ratified", [F1]: "declined" }, [P1, P2, F1]);
  const pass = triageFleetLane(f.deps(10));
  assert.deepEqual(pass, { filed: [], merged: [], room: 10 });
  assert.deepEqual(f.approved, []);
  // No snapshot at all: nothing is done on a guess.
  const g = fx({ [P1]: "ready" }, [P1]);
  writeFileSync(classificationSnapshotPath(g.stateDir), "{ torn");
  assert.deepEqual(triageFleetLane(g.deps(10)), { filed: [], merged: [], room: 0 });
  writeFileSync(classificationSnapshotPath(g.stateDir), JSON.stringify({ generatedAt: "x" }));
  assert.deepEqual(triageFleetLane(g.deps(10)).filed, []);
});

test("W1-T4089: a switched-off kind is left alone", () => {
  const f = fx({ [A1]: "ready", [A2]: "ready", [P1]: "ready" }, [A1, A2, P1]);
  writeFileSync(fleetLaneOffPath(f.stateDir, "adoption"), "");
  const pass = triageFleetLane(f.deps(10));
  assert.deepEqual(pass.filed, [P1]);
  assert.deepEqual(pass.merged, [], "a switched-off kind is not folded either");
});

test("W1-T4089: the daemon runs the fleet lane beside a busy main loop", async () => {
  const f = fx({ [P1]: "ready" }, [P1]);
  writeFileSync(join(f.stateDir, "..", "tasks.yaml"), "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let busy = false;
  let filedWhileBusy = false;
  await runDaemon(
    loadPlan(join(f.stateDir, "..", "tasks.yaml")),
    {
      refreshMerged: () => () => false,
      runOne: async (id): Promise<RunResult> => {
        busy = true;
        await new Promise((resolve) => setTimeout(resolve, 150));
        busy = false;
        return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      fleetLane: {
        ...f.deps(5),
        mergedLastDay: () => {
          if (busy) filedWhileBusy = true;
          return busy ? 5 : 0;
        },
      },
      sleep: async () => {},
      log: () => {},
    },
    { headroomEnabled: false, max: 1, pollIntervalMs: 20 },
  );
  assert.equal(filedWhileBusy, true);
  assert.deepEqual(f.approved, [P1]);
});

test("W1-T4089: the lane's timer logs a failure and keeps going", async () => {
  const lines: string[] = [];
  let calls = 0;
  const pump = startFleetLane(
    () => {
      calls += 1;
      if (calls === 1) throw new Error("registry unreadable");
      return { filed: ["x"], merged: [], room: 0 };
    },
    10,
    (s) => lines.push(s),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  pump.stop();
  assert.ok(lines.includes("fleet_lane.failed"));
  assert.ok(lines.includes("fleet_lane.pass"));
});

test("W1-T4089: the merge rate comes from main's history, and an unanswerable read files nothing", () => {
  assert.equal(mergedInLastDay("/repo", () => "a\nb\nc\n"), 3);
  assert.equal(mergedInLastDay("/repo", () => { throw new Error("no git"); }), 0);
  assert.equal(typeof mergedInLastDay(process.cwd()), "number", "the real git read runs");
});

test("W1-T4089: the inbox writes the classification snapshot and shows each fleet finding's decision", async () => {
  const f = fx({ [A1]: "ready" }, []);
  const root = join(f.stateDir, "..");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(classificationSnapshotPath(f.stateDir), "");
  writeFileSync(f.ledgerPath, JSON.stringify({ step: "fleet_lane.decided", task_id: A1, decision: "merge", reason: "Folded." }) + "\n" + JSON.stringify({ step: "fleet_lane.decided", task_id: A1, decision: "other" }) + "\n");
  const server = createService({
    tokens: { read: "r", write: "w" },
    routes: buildPanelGraphRoutes({
      root,
      inboxRoot: root,
      planPath: join(root, "plan", "tasks.yaml"),
      ledgerPath: f.ledgerPath,
      github: { prView: () => null },
      statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
      ratify: { approve: () => {}, reframe: () => {} },
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox`, { headers: { authorization: "Bearer r" } });
    const body = (await res.json()) as { fleet: Array<{ proposalId: string; decision?: string; reason?: string }> };
    assert.equal(body.fleet[0]!.decision, "merge");
    assert.equal(body.fleet[0]!.reason, "Folded.");
    const snap = JSON.parse(readFileSync(classificationSnapshotPath(f.stateDir), "utf8")) as { states: Record<string, string> };
    assert.equal(snap.states[A1], "not_ready", "the route recorded what it classified");
  } finally {
    server.close();
  }
  assert.equal(fleetLaneDecisions([{ step: "fleet_lane.decided", task_id: P1, decision: "file" }]).get(P1)?.reason, "The fleet turned this finding into planned work.");
});
