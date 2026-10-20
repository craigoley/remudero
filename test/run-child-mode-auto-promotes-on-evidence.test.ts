// test/run-child-mode-auto-promotes-on-evidence.test.ts — W1-T9087.
//
// Decision record: docs/adr/0007-build-runs-outlive-the-daemon.md (A.9). `sweep.runChild.mode: auto` decides between shadow and
// on from the ledger's own evidence since the previous daemon boot: it promotes only after a clean whole boot cycle whose closing
// boot recorded an adoption pass, and holds on a probe peak above its admitted class estimate. W1-T9089: a lost child no
// longer demotes it (the in-process path is retired); `on` stays on and flags the contract failing for escalation.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { EngineChildLaunch } from "#src/lib/child-entry-argv.js";
import { resetLearnedEstimateCacheForTests } from "#src/lib/host-memory-learning.js";
import { DEFAULT_ESTIMATE_MIB } from "#src/lib/host-memory-ledger.js";
import { adoptRunChildren, createAdmittedPlanSlot, runChildModeIsOn, startRunChildProbe } from "#src/lib/run-child.js";
import {
  RUN_CHILD_ADOPTION_PASS_STEP, RUN_CHILD_MODE_DECISION_STEP, classifyRunChildLoss, createRunChildModeTracker, decideRunChildMode,
  readRunChildPolicy, runChildModeEvidence, runChildModeFor,
} from "#src/lib/run-child-mode.js";
import { clockFromIsoFn } from "#src/lib/clock.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const MIB = 1024 * 1024;
const scratch: string[] = [];
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}run-child-mode-${label}-`));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

type Row = { step: string } & Record<string, unknown>;
let tick = 0;
const at = (): string => new Date(Date.UTC(2026, 9, 15, 0, 0, tick++)).toISOString();
const boot = (): Row => ({ step: "daemon.start", ts: at() });
const adoption = (live = 0, adopted = live): Row => ({ step: RUN_CHILD_ADOPTION_PASS_STEP, ts: at(), live, adopted, unreadable: 0, misidentified: 0 });
const probe = (peakMib: number, estimateMib: number | null = 512, contract = "ok"): Row => ({
  step: "run_child.shadow", ts: at(), contract, tree_peak_bytes: peakMib * MIB, class_estimate_bytes: estimateMib === null ? null : estimateMib * MIB,
});
const decided = (to: "on" | "shadow"): Row => ({ step: RUN_CHILD_MODE_DECISION_STEP, ts: at(), to });
const lost = (detail: string, stderr = ""): Row => ({ step: "run_child.lost", ts: at(), detail, stderr_tail: stderr });

test("W1-T9087: auto promotes only after a clean boot cycle with an adoption", () => {
  // The first boot, a clean adoption and clean probes: no whole boot cycle yet, so the falsifier (promote on the first clean
  // probe) is refused.
  const rows: Row[] = [boot(), adoption(), probe(300), probe(310)];
  let decision = decideRunChildMode(runChildModeEvidence(rows));
  assert.equal(decision.to, "shadow");
  assert.match(decision.reason, /no whole boot cycle/);

  // The second boot opens, but its adoption pass has not been recorded: still held.
  rows.push(boot());
  decision = decideRunChildMode(runChildModeEvidence(rows));
  assert.equal(decision.to, "shadow");
  assert.match(decision.reason, /no adoption pass/);

  // A closing adoption that missed a live child holds too.
  decision = decideRunChildMode(runChildModeEvidence([...rows, adoption(1, 0)]));
  assert.equal(decision.to, "shadow");
  assert.match(decision.reason, /adopted 0 of 1/);

  // The real adoption pass writes the row the decision reads, even with no runs directory at all.
  const passRows: Row[] = [];
  adoptRunChildren({ stateRoot: join(tmp("adopt"), "state"), instance: "test", log: (step, extra) => { passRows.push({ step, ts: at(), ...extra }); },
    settledRunIds: new Set() });
  assert.deepEqual(passRows.map((r) => r.step), [RUN_CHILD_ADOPTION_PASS_STEP]);
  rows.push(...passRows);

  decision = decideRunChildMode(runChildModeEvidence(rows));
  assert.equal(decision.from, "shadow");
  assert.equal(decision.to, "on");
  assert.match(decision.reason, /promoted/);
  assert.equal(decision.window_start, rows[0]!.ts, "the window opens at the previous boot");
  assert.equal(decision.evidence.roundTrips, 2);

  // No round trip in the window: nothing to promote on, however clean.
  assert.equal(decideRunChildMode(runChildModeEvidence([boot(), adoption(), boot(), adoption()])).to, "shadow");
  // A child's settlement is a round trip, a failure through the contract too; a lost child's settlement is not.
  const settled = (outcome: string, reason?: string): Row => ({ step: "run_child.settled", ts: at(), outcome, ...(reason ? { reason } : {}) });
  const settledCycle = runChildModeEvidence([boot(), adoption(), settled("fulfilled"), settled("rejected", "gh 502"),
    settled("rejected", "run child run-A-1 lost: pid 9 is gone"), boot(), adoption()]);
  assert.equal(decideRunChildMode(settledCycle).evidence.roundTrips, 2);
  assert.equal(decideRunChildMode(settledCycle).to, "on");
  assert.equal(decideRunChildMode(runChildModeEvidence([boot(), adoption(), settled("rejected", "contract_mismatch: schema 2"), boot(), adoption()])).to, "shadow");
  // A probe that failed the contract any other way holds.
  assert.match(decideRunChildMode(runChildModeEvidence([boot(), adoption(), probe(300), probe(300, 512, "unknown"), boot(), adoption()])).reason,
    /1 probe\(s\) failed the contract/);

  // The daemon's tracker ledgers the change once, and runChildModeFor hands the dispatch `on`.
  const ledgered: Row[] = [];
  const tracker = createRunChildModeTracker(rows, clockFromIsoFn(at));
  const asked = runChildModeFor("auto", tracker.evidence());
  assert.equal(asked.mode, "on");
  tracker.record(asked.decision, (step, extra) => { ledgered.push({ step, ...extra }); });
  tracker.record(runChildModeFor("auto", tracker.evidence()).decision, (step, extra) => { ledgered.push({ step, ...extra }); });
  assert.equal(ledgered.length, 1, "an unchanged answer is not re-ledgered");
  assert.deepEqual(Object.keys(ledgered[0]!).sort(), ["evidence", "from", "reason", "step", "to", "window_start"]);
  assert.equal(ledgered[0]!.to, "on");
  assert.equal(tracker.evidence().mode, "on");
  // Once per boot the decision is ledgered even when it did not change.
  tracker.record(runChildModeFor("auto", tracker.evidence()).decision, (step, extra) => { ledgered.push({ step, ...extra }); }, true);
  assert.equal(ledgered.length, 2);
  // A policy other than auto is its own answer; an unreadable one decides nothing.
  assert.deepEqual(runChildModeFor("shadow", tracker.evidence()), { mode: "shadow" });
  assert.match(String(readRunChildPolicy(() => { throw new Error("bad yaml"); }).unreadable), /bad yaml/);

  // The spawn path reads the same decision: auto with promoting evidence starts a child, auto with none stays in-process.
  assert.deepEqual(runChildModeIsOn(() => "auto", tracker.evidence), { on: true });
  assert.deepEqual(runChildModeIsOn(() => "auto"), { on: false });
  assert.deepEqual(runChildModeIsOn(() => "auto", () => runChildModeEvidence([boot()])), { on: false });
});

test("W1-T9087: a lost child flags auto's contract failing instead of demoting it", () => {
  const promoted: Row[] = [boot(), adoption(), probe(300), boot(), adoption(), decided("on")];
  assert.equal(decideRunChildMode(runChildModeEvidence(promoted)).to, "on");

  // W1-T9089: a lost child keeps on and flags the contract failing; with no change of mode the tracker ledgers nothing.
  const ledgered: Row[] = [];
  const tracker = createRunChildModeTracker(promoted, clockFromIsoFn(at));
  tracker.observe("run_child.lost", { detail: "pid 4242 is gone", stderr_tail: "" });
  tracker.record(runChildModeFor("auto", tracker.evidence()).decision, (step, extra) => { ledgered.push({ step, ...extra }); });
  assert.equal(ledgered.length, 0);
  const lostDecision = runChildModeFor("auto", tracker.evidence()).decision!;
  assert.equal(lostDecision.to, "on");
  assert.equal(lostDecision.contract_failing, true);
  assert.match(lostDecision.reason, /stays on, escalated: 1 lost child/);
  assert.equal(tracker.evidence().mode, "on");

  // A misidentified child (a reused pid) and a contract mismatch are flagged the same way.
  assert.match(decideRunChildMode(runChildModeEvidence([...promoted, lost("pid 7 was reused: started 9, recorded 3")])).reason, /escalated: 1 misidentified/);
  for (const row of [probe(300, 512, "contract_mismatch"), { step: RUN_CHILD_ADOPTION_PASS_STEP, live: 1, adopted: 0, unreadable: 0, misidentified: 1 }]) {
    const flagged = decideRunChildMode(runChildModeEvidence([...promoted, row]));
    assert.equal(flagged.to, "on");
    assert.equal(flagged.contract_failing, true);
  }

  // An outside kill is named and not charged to the contract: on stays on. An OOM kill still holds a promotion.
  assert.equal(classifyRunChildLoss({ detail: "the child exited (SIGKILL)", stderr_tail: "Out of memory: Killed process 4242 (node)" }), "oom_kill");
  assert.equal(classifyRunChildLoss({ detail: "status names container a@1, this is b@2" }), "container_stop");
  const oom = lost("the child exited (SIGKILL) in state running", "Memory cgroup out of memory: Killed process 4242");
  assert.equal(decideRunChildMode(runChildModeEvidence([...promoted, oom])).to, "on");
  assert.equal(decideRunChildMode(runChildModeEvidence([...promoted, lost("status names container a@1, this is b@2")])).to, "on");
  const shadowCycle: Row[] = [boot(), adoption(), probe(300), oom, boot(), adoption()];
  assert.match(decideRunChildMode(runChildModeEvidence(shadowCycle)).reason, /OOM kill/);

  // Re-promotion needs a fresh clean boot cycle: the loss stays in the window until a boot that follows it closes a cycle.
  const after: Row[] = [...promoted, lost("pid 4242 is gone"), decided("shadow"), boot(), adoption(), probe(300)];
  assert.equal(decideRunChildMode(runChildModeEvidence(after)).to, "shadow", "the cycle that held the loss is still in the window");
  after.push(boot(), adoption());
  assert.equal(decideRunChildMode(runChildModeEvidence(after)).to, "on", "a fresh clean boot cycle re-promotes");
});

test("W1-T9087: a child peak above its class estimate holds promotion", async () => {
  const cycle = (...probes: Row[]): Row[] => [boot(), adoption(), ...probes, boot(), adoption()];
  assert.equal(decideRunChildMode(runChildModeEvidence(cycle(probe(300, 512), probe(500, 512)))).to, "on");
  const over = decideRunChildMode(runChildModeEvidence(cycle(probe(300, 512), probe(700, 512))));
  assert.equal(over.to, "shadow");
  assert.match(over.reason, /1 probe tree peak\(s\) above the class estimate/);
  assert.equal(over.evidence.peaksOverEstimate, 1);
  // A probe with no admitted estimate to compare (a row from before W1-T9087) holds as well: an unmeasured fit is not a fit.
  assert.match(decideRunChildMode(runChildModeEvidence(cycle(probe(300, null)))).reason, /no admitted class estimate/);

  // The real probe row carries the class estimate it was admitted under.
  resetLearnedEstimateCacheForTests();
  const root = tmp("probe");
  const state = join(root, "state");
  const engine = join(state, "engines", "a".repeat(64));
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ sha: "b".repeat(40), sourceHash: "a".repeat(64), builtAt: Date.now() }));
  const slot = createAdmittedPlanSlot();
  slot.offer({ plan: { tasks: [{ id: "W1-T1" }] } });
  const rows: Row[] = [];
  await startRunChildProbe({
    taskId: "W1-T9087", stateRoot: state, repoDir: root, root, plan: slot.promise, options: { owner: "o" },
    log: (step, extra) => { rows.push({ step, ...extra }); },
  }, {
    readMode: () => "shadow", mainSha: async () => "b".repeat(40), engine: { isCurrent: () => true },
    ledger: { location: () => ({ dir: join(root, "host-memory"), scope: "local" }), instance: () => ({ name: "test", hostUnique: false }), root },
    store: { location: () => ({ dir: join(root, "host-memory") }), root },
    launch: (_engine, args): EngineChildLaunch => ({ argv: ["-e", "process.exit(0)", "--", ...args], kind: "tsx", reason: "test-script", cwd: root, engineRoot: engine }),
  });
  const shadow = rows.filter((r) => r.step === "run_child.shadow");
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0]!.class_estimate_bytes, DEFAULT_ESTIMATE_MIB["run-child-probe"] * MIB);
});
