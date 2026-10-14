import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { ActorEvidence } from "../src/lib/actor-evidence.js";
import type { FleetFlowRow } from "../src/lib/fleet-flow-detectors.js";
import {
  evaluateForeignPauseDetectors,
  foreignPauseDetector,
  loadPausePolicy,
  parsePausePolicy,
  setterClassOf,
  type PausePolicy,
} from "../src/lib/foreign-pause-detector.js";
import { SRE_LANE_DETECTORS } from "../src/lib/sre-lane.js";
import { installPolicyPath } from "../src/lib/policy.js";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";

const at = (iso: string) => Date.parse(iso);
const MIN = 60_000;
const RECYCLE_REASON = "PAUSE requested: container recycle (deploy/recycle-container.sh)";
const RESTORATION_REASON = "maintenance: supervised serve restoration window (core only)";
const SESSION = "operator-serve-restoration-20261011-supervised-v4";

const POLICY: PausePolicy = parsePausePolicy({
  core: { automationSetters: ["daemon", "host-recycle"], origin: "test" },
});

function evidence(callerClass: ActorEvidence["caller_class"]): ActorEvidence {
  return {
    kind: "human", os_user: "codex", host: "Remudero", agent_markers: [], tty: { stdin: false, stdout: false },
    parents: ["sshd"], caller_class: callerClass, ...(callerClass === "remote non-interactive" ? { ssh: { client_address: "10.0.0.9", pty: false } } : {}),
  };
}

function idle(ms: number, fields: Record<string, unknown>): FleetFlowRow {
  return { ts: new Date(ms).toISOString(), step: "lane.idle_changed", at_ms: ms, capacity: 3, ...fields };
}
const free = (ms: number) => idle(ms, { cause: null, idle_slots: 0, dispatchable: 0, hold: null });
const held = (ms: number, cause: string, reason: string, slots: number, extra: Record<string, unknown> = {}) =>
  idle(ms, { cause, idle_slots: slots, dispatchable: 9, hold: { reason, ...extra } });

/** The fleet's own history: six host-recycle drains that left no pause row and cost 3,3,6,6,6,6 slot-minutes (p90 = 6). */
function recycleHistory(origin: number): FleetFlowRow[] {
  return [1, 1, 2, 2, 2, 2].flatMap((minutes, i) => {
    const t0 = origin + i * 3 * 60 * MIN;
    return [held(t0, "recycle_drain", RECYCLE_REASON, 3), free(t0 + minutes * MIN)];
  });
}

function pauseRows(startMs: number, endMs: number | undefined, fields: Record<string, unknown>, slots: number): FleetFlowRow[] {
  const rows: FleetFlowRow[] = [
    { ts: new Date(startMs).toISOString(), step: "fleet.pause", task_id: "FLEET", scope: "instance", instance: "core", ...fields },
    held(startMs + 1000, "operator_pause", String(fields.reason), slots, { session_id: fields.session_id }),
  ];
  if (endMs !== undefined) {
    rows.push({ ts: new Date(endMs).toISOString(), step: "fleet.resume", task_id: "FLEET", scope: "instance", instance: "core" });
    rows.push(free(endMs));
  }
  return rows;
}

const ORIGIN = at("2026-10-10T20:00:00Z");
const PAUSE_AT = at("2026-10-11T11:46:29Z");
const RESUME_AT = at("2026-10-11T12:29:30Z");

const remoteSetter = {
  reason: RESTORATION_REASON, session_id: SESSION, actor: "unknown", actor_evidence: evidence("remote non-interactive"),
  expires_at: "2026-10-11T15:46:29.000Z",
};

function judge(rows: FleetFlowRow[], nowMs: number, instance = "core") {
  return foreignPauseDetector(instance, { policy: POLICY }).evaluate(rows, nowMs, []);
}

describe("test/a-pause-set-from-outside-the-fleet-is-an-incident-by-its-cost.test.ts", () => {
  test("W1-T8245: the serve-restoration pause replay fires and names its setter", async () => {
    const rows = [...recycleHistory(ORIGIN), ...pauseRows(PAUSE_AT, RESUME_AT, remoteSetter, 2)];
    const findings = judge(rows, RESUME_AT);
    assert.equal(findings.length, 1);
    const [finding] = findings;
    assert.equal(finding!.name, "foreign-pause");
    assert.equal(finding!.population, "automation-pause");
    assert.equal(finding!.bound, 6);
    assert.ok(finding!.measured > 80 && finding!.measured < 90, `43 minutes on two slots is about 86, got ${finding!.measured}`);
    assert.match(finding!.subject, /^instance=core since=2026-10-11T11:46:29\.000Z /);
    assert.match(finding!.subject, / setter=codex@Remudero /);
    assert.match(finding!.subject, / actor_class=remote-non-interactive /);
    assert.match(finding!.subject, / session=operator-serve-restoration-20261011-supervised-v4\(claimed\) /);
    assert.match(finding!.subject, / reason=maintenance:_supervised_serve_restoration_window_\(core_only\) /);
    assert.match(finding!.subject, / expires=2026-10-11T15:46:29\.000Z$/);

    // The same hold is in force at 12:10 and already past its bound: the cost, not the end of the hold, is the incident.
    const live = judge([...recycleHistory(ORIGIN), ...pauseRows(PAUSE_AT, undefined, remoteSetter, 2)], at("2026-10-11T12:10:00Z"));
    assert.equal(live.length, 1);
    assert.match(live[0]!.message, /state=in-force/);

    // Through the evaluator: one incident.event, and a second pass over the same hold writes nothing.
    const stateDir = mkdtempSync(join(tmpdir(), "rmd-foreign-pause-"));
    const written: Array<Record<string, unknown>> = [];
    const input = {
      stateDir, detectors: [foreignPauseDetector("core", { policy: POLICY })], nowMs: RESUME_AT,
      readRows: () => rows, writeEvent: (row: Record<string, unknown>) => { written.push(row); },
    };
    assert.equal((await evaluateForeignPauseDetectors(input)).length, 1);
    assert.equal((await evaluateForeignPauseDetectors(input)).length, 0);
    assert.equal(written.length, 1);
    assert.equal(written[0]!.name, "foreign-pause");
    assert.match(String(written[0]!.message), /^instance=core since=2026-10-11T11:46:29\.000Z setter=codex@Remudero /);
  });

  test("W1-T8245: a recycle pause is not foreign", () => {
    const recycleAt = at("2026-10-11T16:16:08Z");
    const rows = [...recycleHistory(ORIGIN), held(recycleAt, "recycle_drain", RECYCLE_REASON, 3), free(recycleAt + 6 * MIN)];
    // 6 minutes on three slots is 18 slot-minutes, three times the history's p90 of 6: only its setter spares it.
    assert.deepEqual(judge(rows, recycleAt + 7 * MIN), []);
    assert.equal(setterClassOf({ reason: RECYCLE_REASON, rowActor: "unknown", evidence: undefined }), "host-recycle");

    // Control: the identical cost from a remote setter fires, so the silence above is the setter and not the cost.
    const control = [...recycleHistory(ORIGIN), ...pauseRows(recycleAt, recycleAt + 6 * MIN, { ...remoteSetter, reason: "maintenance" }, 3)];
    assert.equal(judge(control, recycleAt + 7 * MIN).length, 1);

    // A reason alone is a claim: a recycle-worded pause carrying agent evidence is not the recycle.
    assert.equal(
      setterClassOf({ reason: RECYCLE_REASON, rowActor: "operator_ai", evidence: evidence("agent session") }), "agent-session");
    assert.equal(setterClassOf({ reason: RECYCLE_REASON, rowActor: "unknown", evidence: evidence("agent session") }), "agent-session");
    assert.equal(setterClassOf({ reason: "stale code", rowActor: "daemon", evidence: undefined }), "daemon");
  });

  test("W1-T8245: a foreign pause below its own bound is silent", () => {
    const start = at("2026-10-11T13:00:00Z");
    // Two minutes on two slots is 4 slot-minutes, under the 6-minute bound the fleet's own holds set.
    const cheap = [...recycleHistory(ORIGIN), ...pauseRows(start, start + 2 * MIN, remoteSetter, 2)];
    assert.deepEqual(judge(cheap, start + 3 * MIN), []);
    // Just over it fires: the bound, not the existence of a foreign setter, is what separates them.
    const costly = [...recycleHistory(ORIGIN), ...pauseRows(start, start + 4 * MIN, remoteSetter, 2)];
    assert.equal(judge(costly, start + 5 * MIN).length, 1);
    // An instance with too few holds of any kind to learn a bound cannot judge, and says nothing.
    assert.deepEqual(judge(pauseRows(start, start + 60 * MIN, remoteSetter, 2), start + 61 * MIN), []);
  });

  test("W1-T8245: a hold with no actor evidence is foreign-unverified", () => {
    const rows = [
      ...recycleHistory(ORIGIN),
      ...pauseRows(PAUSE_AT, RESUME_AT, { reason: RESTORATION_REASON, session_id: SESSION, actor: "unknown" }, 2),
    ];
    const findings = judge(rows, RESUME_AT);
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.subject, / setter=unrecorded /);
    assert.match(findings[0]!.subject, / actor_class=unverified /);
    // Even a policy that tried to trust "unverified" cannot: it is not a class a policy may list.
    assert.throws(() => parsePausePolicy({ core: { automationSetters: ["unverified"], origin: "test" } }), /unverified/);
    const trusting = foreignPauseDetector("core", { policy: { core: { automationSetters: ["unverified" as never], origin: "test" } } });
    assert.equal(trusting.evaluate(rows, RESUME_AT, []).length, 1);
  });

  test("W1-T8245: the pause policy names who may hold core and the detector is registered", () => {
    const shipped = loadPausePolicy(installPolicyPath());
    assert.deepEqual(shipped.core?.automationSetters, ["daemon", "host-recycle"]);
    assert.match(shipped.core!.origin, /\S/);
    assert.throws(() => parsePausePolicy({ core: { automationSetters: ["codex"], origin: "test" } }), /codex/);
    assert.throws(() => parsePausePolicy({ core: { automationSetters: ["daemon"] } }), /origin/);
    assert.throws(() => parsePausePolicy({ core: { origin: "test" } }), /automationSetters/);
    assert.ok(SRE_LANE_DETECTORS.some((d) => d.id === "foreign-pause"));
    assert.ok(SRE_LANE_DETECTORS.find((d) => d.id === "foreign-pause")!.inputs.includes("lane.idle_changed"));
    // The default detector reads the shipped policy: core's replay fires with no injected policy.
    const rows = [...recycleHistory(ORIGIN), ...pauseRows(PAUSE_AT, RESUME_AT, remoteSetter, 2)];
    assert.equal(foreignPauseDetector("core").evaluate(rows, RESUME_AT, []).length, 1);
  });

  test("W1-T8245: the evaluator persists its dedupe memory beside the fleet-flow store", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rmd-foreign-pause-"));
    const rows = [...recycleHistory(ORIGIN), ...pauseRows(PAUSE_AT, RESUME_AT, remoteSetter, 2)];
    const events = await evaluateForeignPauseDetectors({
      stateDir, detectors: [foreignPauseDetector("core", { policy: POLICY })], nowMs: RESUME_AT, readRows: () => rows,
      writeEvent: () => {},
    });
    assert.equal(events.length, 1);
    const memory = JSON.parse(readFileSync(join(stateDir, "foreign-pause-detector.json"), "utf8"));
    assert.deepEqual(memory.emitted.map((e: { key: string }) => e.key), ["instance=core since=2026-10-11T11:46:29.000Z"]);
    assert.deepEqual(await evaluateForeignPauseDetectors({ stateDir, detectors: [], nowMs: RESUME_AT, readRows: () => rows }), []);
  });

  test("W1-T8245: a pause policy entry that is not a mapping is refused by name", () => {
    assert.throws(() => parsePausePolicy([]), /'pausePolicy' must be a mapping/);
    assert.throws(() => parsePausePolicy({ core: "daemon" }), /'pausePolicy\.core' must be a mapping/);
  });

  test("W1-T8245: with no injected reader or writer the evaluator reads the real ledger and appends the incident to it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rmd-foreign-pause-"));
    const ledger = join(stateDir, LEDGER_FILENAME);
    const rows = [...recycleHistory(ORIGIN), ...pauseRows(PAUSE_AT, RESUME_AT, remoteSetter, 2)];
    writeFileSync(ledger, rows.map((row) => JSON.stringify({ run_id: "FLEET", task_id: "FLEET", ...row })).join("\n") + "\n");
    const input = { stateDir, detectors: [foreignPauseDetector("core", { policy: POLICY })], nowMs: RESUME_AT };
    const events = await evaluateForeignPauseDetectors(input);
    assert.equal(events.length, 1);
    const appended = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.step === "incident.event");
    assert.equal(appended.length, 1);
    assert.equal(appended[0]!.name, "foreign-pause");
    assert.match(String(appended[0]!.subject), /^instance=core since=2026-10-11T11:46:29\.000Z /);
    // The memoized reader answers a second pass over the same ledger, and the dedupe memory keeps it silent.
    assert.deepEqual(await evaluateForeignPauseDetectors(input), []);
  });
});
