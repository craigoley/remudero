/**
 * W1-T12224: an operator one-task release (`rmd approve`) authorizes DISPATCH only. It never rewrites
 * `verify: human` to `verify: auto`, and its pin binds the record's actual `verify:` value, so a later
 * verification-mode change needs fresh approval. W1-T10976 was approved at risk: high / verify: human
 * and landed at `verify: auto` (PR #17662) because renderRuledShard mapped every proceed to auto and
 * operatorReleasePin hashed the contract with `verify: "auto"`.
 *
 * Every case drives real shard text through renderRuledShard and the real pin, lint and selector code.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { resolveReleases, runnableCandidates, type DispatchFilterReason } from "#src/lib/drain.js";
import { renderMachineShard, UNPRICED_PRIORITY } from "#src/lib/machine-filing.js";
import {
  MACHINE_JUDGE_STATE_FILE, needsMachineJudgement, readOperatorReleaseRecords, recordOperatorRelease,
  renderRuledShard, runMachineFilingJudge, staleRulingPins,
} from "#src/lib/machine-filing-judge.js";
import { operatorReleaseContractChanged, operatorReleasePin, qualifyReleaseEvidence, releaseContractPins } from "#src/lib/operator-release.js";
import { loadPlan, parseTasksFromYaml, type Task } from "#src/lib/plan.js";
import { lintTask, taskRulingPin } from "#src/lib/task-linter.js";

const ID = "W1-T9903";
const REL = `plan/tasks.d/${ID}.yaml`;
const CLOCK = fixedClock(Date.parse("2026-11-23T10:00:00Z"));
const HUMAN_LINE = "  verify: human  # held for a person: it changes a release authority";

/** A machine record at risk: high and verify: human, its verify line carrying the filer's comment. */
function heldShard(): string {
  const rendered = renderMachineShard({ taskId: ID, title: "record the bounded remedy", origin: "flow-blocker:fixture",
    files: ["docs/remedy.md"], acceptance: [{ claim: "remedy recorded", proof: "grep: remedy in docs/remedy.md" }],
    invariants: { none: "the fixture records one remedy in a docs file and changes no existing behaviour" } });
  assert.equal(rendered.refused, undefined);
  const text = rendered.text!.replace(/^ {2}verify: human$/m, HUMAN_LINE).replace(/^ {2}risk: low$/m, "  risk: high");
  assert.match(text, /^ {2}risk: high$/m);
  assert.ok(text.split("\n").includes(HUMAN_LINE));
  return text;
}

const record = (text: string): Task => parseTasksFromYaml(text, REL)[0]!;
const verifyLine = (text: string): string | undefined => text.split("\n").find((l) => /^ {2}verify:/.test(l));
const blocks = (t: Task): string[] => lintTask(t).violations.filter((v) => v.severity === "block").map((v) => v.check);
const operatorRuling = { verdict: "operator", action: "proceed", confidence: 1, reasons: ["released by the operator with rmd approve"],
  judgedAt: CLOCK.iso() } as const;

function render(text: string, ruling: Parameters<typeof renderRuledShard>[3]): string {
  const out = renderRuledShard(text, REL, taskRulingPin({ ...record(text), verify: "auto" }), ruling);
  assert.ok("contents" in out, `rendered: ${"refused" in out ? out.refused : ""}`);
  return out.contents;
}

function planRoot(t: TestContext, text: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t12224-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan/tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "plan/tasks.yaml"), "[]\n");
  writeFileSync(join(root, REL), text);
  return { root, stateDir: join(root, "state"), plan: () => loadPlan(join(root, "plan/tasks.yaml")) };
}

test("operator release preserves verify: human and dispatches via matching pin", (t) => {
  const text = heldShard();
  const held = record(text);
  const contents = render(text, operatorRuling);
  assert.equal(verifyLine(contents), HUMAN_LINE, "the verify: line is byte-identical, comment included");
  assert.equal(contents.split("\n").filter((l) => /^ {2}verify:/.test(l)).length, 1);
  assert.equal(contents.split("\n").some((l) => /^ {2}# held for a person/.test(l)), false, "no comment is split onto its own line");
  assert.equal(contents.includes(`  priority: ${UNPRICED_PRIORITY}`), false, "an operator ruling inserts no priority");
  const released = record(contents);
  assert.equal(released.verify, "human");
  assert.equal(released.risk, "high");
  assert.equal(released.risk_ruling?.verdict, "operator");
  assert.equal(released.risk_ruling?.action, "proceed");
  assert.equal(released.risk_ruling?.operator_release_pin, operatorReleasePin(held));
  assert.equal(released.risk_ruling?.operator_release_pin, operatorReleasePin(released));
  assert.deepEqual(blocks(released), [], "the released record still lints clean");

  const f = planRoot(t, contents);
  const reasons: DispatchFilterReason[] = [];
  const unreleased = resolveReleases({ readDurableReleases: () => readOperatorReleaseRecords(f.stateDir) }, f.plan());
  assert.deepEqual(runnableCandidates(f.plan(), () => false, 10, { releasedIds: unreleased.ids, onFiltered: (_t, r) => void reasons.push(r) }), []);
  assert.deepEqual(reasons, ["verify-not-auto"], "with no release the identical record is still held");

  recordOperatorRelease(f.stateDir, held, CLOCK.iso());
  const resolution = resolveReleases({ readDurableReleases: () => readOperatorReleaseRecords(f.stateDir) }, f.plan());
  assert.equal(resolution.ids.has(ID), true, "the pin taken at verify: human matches the record that stays at verify: human");
  assert.deepEqual(runnableCandidates(f.plan(), () => false, 10, { releasedIds: resolution.ids }).map((c) => c.id), [ID]);
});

test("verify change invalidates release pin while status flip stays valid", () => {
  const contents = render(heldShard(), operatorRuling);
  const released = record(contents);
  const pin = released.risk_ruling!.operator_release_pin!;
  const toAuto = contents.replace(HUMAN_LINE, "  verify: auto");
  const autoRecord = record(toAuto);
  assert.equal(autoRecord.verify, "auto");
  assert.notEqual(operatorReleasePin(autoRecord), pin, "human -> auto changes the release pin");
  assert.equal(operatorReleaseContractChanged(autoRecord), true);
  const ruled = { id: ID, relPath: REL, pin: released.risk_ruling!.pin, sourcePin: taskRulingPin(released), operatorReleasePin: pin };
  assert.deepEqual(staleRulingPins([ruled], new Map([[REL, contents]])), [], "control: the unchanged record is current");
  assert.deepEqual(staleRulingPins([ruled], new Map([[REL, toAuto]])).map((s) => s.id), [ID]);
  const humanReceipt = new Map([[ID, { pin }]]);
  const toAutoEvidence = qualifyReleaseEvidence([], humanReceipt, releaseContractPins([autoRecord]));
  assert.equal(toAutoEvidence.reapproval.has(ID), true);
  assert.equal(toAutoEvidence.authors.has(ID), false, "no operator author survives a verify change");
  assert.equal(qualifyReleaseEvidence([], humanReceipt, releaseContractPins([released])).authors.get(ID), "operator", "control");

  // The reverse: a release taken at verify: auto does not authorize the record once it reads verify: human.
  const autoPin = operatorReleasePin(autoRecord);
  const backToHuman = toAuto.replace(/^ {4}operator_release_pin: .*$/m, `    operator_release_pin: ${JSON.stringify(autoPin)}`).replace("  verify: auto", HUMAN_LINE);
  const humanAgain = record(backToHuman);
  assert.equal(humanAgain.verify, "human");
  assert.notEqual(operatorReleasePin(humanAgain), autoPin, "auto -> human changes the release pin");
  assert.equal(operatorReleaseContractChanged(humanAgain), true);
  const autoEvidence = qualifyReleaseEvidence([], new Map([[ID, { pin: autoPin }]]), releaseContractPins([humanAgain]));
  assert.equal(autoEvidence.reapproval.has(ID), true);
  assert.equal(autoEvidence.authors.has(ID), false);

  // W1-T11175 control: a pure lifecycle status flip keeps the landed pin valid.
  const flipped = record(contents.replace(/^ {2}status: queued$/m, "  status: merged"));
  assert.equal(flipped.status, "merged");
  assert.equal(operatorReleaseContractChanged(flipped), false);
});

test("judge proceed keeps verify mapping and escalate remains human", () => {
  const text = heldShard();
  const proceeded = render(text, { verdict: "low", action: "proceed", confidence: 0.95, reasons: ["low"], judgedAt: CLOCK.iso() });
  const lines = proceeded.split("\n");
  const at = lines.indexOf("  verify: auto");
  assert.ok(at > 0, "a judge proceed still renders verify: auto");
  assert.equal(lines[at - 1], "  # held for a person: it changes a release authority", "the filer's comment is kept above");
  assert.equal(lines[at + 1], `  priority: ${UNPRICED_PRIORITY}`, "with its priority insertion");
  const auto = record(proceeded);
  assert.equal(auto.verify, "auto");
  assert.equal(auto.risk_ruling?.verdict, "low");
  assert.equal(auto.risk_ruling?.pin, taskRulingPin(auto), "and its pinned ruling");
  assert.equal(auto.risk_ruling?.operator_release_pin, undefined);

  const escalated = record(render(text, { verdict: "high", action: "escalate", confidence: 0.95, reasons: ["high"], judgedAt: CLOCK.iso() }));
  assert.equal(escalated.verify, "human");
  assert.equal(escalated.risk_ruling?.action, "escalate");
  assert.equal(escalated.risk_ruling?.pin, taskRulingPin(escalated));
  // The mapping is the judge's own: the same proceed carried as the operator's release leaves verify as written.
  assert.equal(verifyLine(render(text, operatorRuling)), HUMAN_LINE, "only a judge's proceed maps the record to verify: auto");
});

test("settled operator ruling at verify: human is not re-rendered", async (t) => {
  const f = planRoot(t, heldShard());
  recordOperatorRelease(f.stateDir, f.plan().byId.get(ID)!, CLOCK.iso());
  const steps: string[] = [];
  const pass = () => runMachineFilingJudge({ stateDir: f.stateDir, plan: f.plan, writeRoot: f.root,
    operatorReleases: () => readOperatorReleaseRecords(f.stateDir),
    riskJudge: async () => assert.fail("an operator release asks no model"),
    isMerged: () => false, stageProposal: () => {}, clock: CLOCK, log: (step) => void steps.push(step) });
  assert.deepEqual((await pass()).proceeded, [ID], "the release lands once");
  const landed = readFileSync(join(f.root, REL), "utf8");
  const task = f.plan().byId.get(ID)!;
  assert.equal(task.verify, "human");
  assert.equal(task.risk_ruling?.verdict, "operator");
  assert.equal(needsMachineJudgement(task, new Set([ID])), false, "the landed operator ruling is settled by the record itself");

  // Without the judge's remembered state, the record alone must keep it from being due.
  rmSync(join(f.stateDir, MACHINE_JUDGE_STATE_FILE), { force: true });
  steps.length = 0;
  const next = await pass();
  assert.deepEqual(next.proceeded, []);
  assert.deepEqual(next.settled, []);
  assert.deepEqual(next.refused, []);
  assert.equal(readFileSync(join(f.root, REL), "utf8"), landed, "nothing is re-rendered");
  assert.equal(steps.includes("machine_judge.already_landed"), false);
  assert.equal(steps.includes("machine_judge.refused"), false);

  // Control: an edited contract is due again (its landed pin no longer matches).
  writeFileSync(join(f.root, REL), landed + "  amendment: a different production action\n");
  assert.equal(needsMachineJudgement(f.plan().byId.get(ID)!, new Set([ID])), true);
});
