/**
 * W1-T12224 — AN OPERATOR ONE-TASK RELEASE AUTHORIZES DISPATCH ONLY.
 *
 * W1-T3206's design (ii) says "a released task becomes dispatchable without editing its `verify:`
 * field", and its falsifier says "DO NOT satisfy this by flipping `verify:` to `auto` on release".
 * The code that made `rmd approve` durable for machine records did exactly that flip in two places:
 * `renderRuledShard` derived `verify` from `ruling.action` for EVERY proceed, `verdict: "operator"`
 * included, and `operatorReleasePin` hashed the contract with `verify: "auto"` so the pin could not
 * see the verification mode at all. MEASURED: W1-T10976 was approved at `risk: high` / `verify: human`
 * and merged PR #17662 rewrote it to `verify: auto` beside its operator ruling, while its own note
 * still said "verify: human and the recorded high/escalate ruling remain holds". One approval to
 * DISPATCH a task therefore also decided how that task is VERIFIED, which nobody approved.
 *
 * These tests drive the real shard text through the real `renderRuledShard` and the real pin
 * functions; no expected shard is hand-built. They fail on origin/main's copy of both sources.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runnableCandidates } from "#src/lib/drain.js";
import { UNPRICED_PRIORITY } from "#src/lib/machine-filing.js";
// Namespace import: a name this build adds reads undefined at base rather than failing the load.
import * as judge from "#src/lib/machine-filing-judge.js";
import * as release from "#src/lib/operator-release.js";
import type { FilingRiskRuling } from "#src/lib/risk-judge.js";
import { assertRunnable, loadPlanFromYaml, parseTasksFromYaml, TASK_STATUSES, type Task } from "#src/lib/plan.js";
import { lintTask, taskRulingPin } from "#src/lib/task-linter.js";

const ID = "W1-T990224";
const REL = `plan/tasks.d/${ID}-guard-the-auto-merge-arm.yaml`;
const JUDGED_AT = "2026-11-20T09:00:00.000Z";
/** The filer's own words on the verify line: a release must not move them either. */
const VERIFY_LINE = "  verify: human  # a machine conclusion parks until a person releases it";

/** A machine-filed record at `risk: high` (it declares a merge-policy path), priced by nothing, parked. */
const SHARD = [
  `- id: ${ID}`,
  '  title: "refuse an auto-merge arm whose head is unapproved"',
  "  repo: remudero",
  "  depends_on: []",
  "  type: implement",
  VERIFY_LINE,
  "  risk: high",
  "  band_meaning: blast-radius",
  "  status: queued",
  "  attempts: 0",
  "  author_class: machine",
  `  origin: "machine-filing:${ID}"`,
  "  files:",
  "    - src/lib/auto-merge.ts",
  "  acceptance:",
  '    - claim: "the auto-merge arm refuses an unapproved head"',
  '      proof: "unit test: the auto-merge arm refuses an unapproved head"',
  "",
].join("\n");

const recordOf = (text: string): Task => parseTasksFromYaml(text, REL)[0]!;
const blocking = (task: Task): string[] =>
  lintTask(task).violations.filter((v) => v.severity === "block").map((v) => v.check).sort();
const verifyLines = (text: string): string[] => text.split("\n").filter((line) => /^ {2}verify:/.test(line));
const judgedPin = (text: string): string => taskRulingPin({ ...recordOf(text), verify: "auto" });

const ruling = (over: Partial<FilingRiskRuling> = {}): FilingRiskRuling => ({
  verdict: "operator", action: "proceed", confidence: 1,
  reasons: ["released by the operator with rmd approve"], judgedAt: JUDGED_AT, ...over,
});

/** The shard as the judge lands an operator release on it, with the rendering refusal named if it refuses. */
function released(text = SHARD): string {
  const out = judge.renderRuledShard(text, REL, judgedPin(text), ruling(), new Set<string>());
  assert.ok("contents" in out, `the release was refused: ${(out as { refused?: string }).refused}`);
  return out.contents;
}

const planOf = (text: string) => loadPlanFromYaml(text, REL);

test("operator release preserves verify: human and dispatches via matching pin", () => {
  const contents = released();
  const before = recordOf(SHARD);
  const after = recordOf(contents);

  // The verify line is left BYTE-IDENTICAL, the filer's comment included, and no second one is written.
  assert.deepEqual(verifyLines(SHARD), [VERIFY_LINE], "control: the filed record carries one commented verify line");
  assert.deepEqual(verifyLines(contents), [VERIFY_LINE]);
  assert.ok(contents.includes(`\n${VERIFY_LINE}\n`), "the exact line, in place");
  assert.equal(after.verify, "human");
  assert.equal(before.verify, "human", "control: the approval was taken at verify: human");
  assert.ok(!/^ {2}priority:/m.test(contents), "an operator release inserts no dispatch priority either");

  // It carries the ruling the release authorizes, pinned to the record as rewritten.
  assert.equal(after.risk_ruling?.verdict, "operator");
  assert.equal(after.risk_ruling?.action, "proceed");
  assert.equal(after.risk_ruling?.pin, taskRulingPin(after));
  assert.equal(after.risk_ruling?.operator_release_pin, release.operatorReleasePin(before));
  assert.equal(after.risk_ruling?.operator_release_pin, release.operatorReleasePin(after),
    "the pin the operator approved still reads as the pin of the record that landed");
  assert.equal(release.operatorReleaseContractChanged(after), false);

  // It still lints clean: nothing moved to verify: auto, so no verify-keyed check newly fires.
  assert.deepEqual(blocking(after), blocking(before));
  assert.deepEqual(blocking(after), [], "and the landed record blocks on nothing");

  // DISPATCH comes from the release, never from the verify field.
  const plan = planOf(contents);
  const releasedIds = new Set([ID]);
  assert.deepEqual(runnableCandidates(plan, () => false, 5, { releasedIds }).map((t) => t.id), [ID]);
  assert.doesNotThrow(() => assertRunnable(plan, after, () => false, releasedIds));

  // The identical record with no release is still refused, under the same reason as before.
  const reasons: string[] = [];
  assert.deepEqual(runnableCandidates(plan, () => false, 5, { onFiltered: (_t, reason) => void reasons.push(reason) }), []);
  assert.deepEqual(reasons, ["verify-not-auto"]);
  assert.throws(() => assertRunnable(plan, after, () => false), /verify:human/);
});

test("verify change invalidates release pin while status flip stays valid", () => {
  const contents = released();
  const landed = recordOf(contents);
  const approved = landed.risk_ruling!.operator_release_pin!;
  assert.equal(approved, release.operatorReleasePin(landed), "control: the release is current on the landed record");

  // A later edit to the verification mode, in EITHER direction, is a changed contract.
  const toAuto = recordOf(contents.replace(VERIFY_LINE, "  verify: auto"));
  assert.equal(toAuto.verify, "auto", "control: the fixture really flipped");
  assert.notEqual(release.operatorReleasePin(toAuto), approved);
  assert.equal(release.operatorReleaseContractChanged(toAuto), true);
  const backToHuman = { ...toAuto, verify: "human" as const, risk_ruling: { ...toAuto.risk_ruling!, operator_release_pin: release.operatorReleasePin(toAuto) } };
  assert.notEqual(release.operatorReleasePin(backToHuman), release.operatorReleasePin(toAuto));
  assert.equal(release.operatorReleaseContractChanged(backToHuman), true, "auto -> human needs fresh approval too");

  // The judge's own staleness sweep reads the flipped record as stale, and the release authority
  // moves the id to reapproval with no operator author left on it.
  const pins = [{ id: ID, relPath: REL, pin: landed.risk_ruling!.pin, sourcePin: taskRulingPin(recordOf(SHARD)), operatorReleasePin: approved, action: "proceed" }];
  assert.deepEqual(judge.staleRulingPins(pins, new Map([[REL, contents]])), [], "control: unchanged, the landed release is current");
  assert.deepEqual(judge.staleRulingPins(pins, new Map([[REL, contents.replace(VERIFY_LINE, "  verify: auto")]])).map((r) => r.id), [ID]);

  const row = JSON.stringify({ step: "ratify.approved", task_id: ID, release_pin: approved, released: "verify-human" });
  const current = release.qualifyReleaseEvidence([row], new Map(), release.releaseContractPins([landed]));
  assert.equal(current.authors.get(ID), "operator", "control: the approval reads as the operator's while the contract stands");
  assert.deepEqual([...current.reapproval], []);
  const flipped = release.qualifyReleaseEvidence([row], new Map(), release.releaseContractPins([toAuto]));
  assert.equal(flipped.authors.get(ID), undefined, "a verify change leaves no operator author behind");
  assert.deepEqual([...flipped.reapproval], [ID]);

  // W1-T11175 control: a lifecycle status flip is bookkeeping and keeps the release valid.
  for (const status of TASK_STATUSES) {
    assert.equal(release.operatorReleaseContractChanged({ ...landed, status }), false, `status ${status} is bookkeeping`);
  }
});

test("judge proceed keeps verify mapping and escalate remains human", () => {
  const render = (over: Partial<FilingRiskRuling>): string => {
    const out = judge.renderRuledShard(SHARD, REL, judgedPin(SHARD), ruling({ verdict: "low", ...over }), new Set<string>());
    assert.ok("contents" in out, `refused: ${(out as { refused?: string }).refused}`);
    return out.contents;
  };

  const proceeded = render({ action: "proceed" });
  const onProceed = recordOf(proceeded);
  assert.equal(onProceed.verify, "auto", "a judge proceed is still released to verify: auto");
  assert.deepEqual(verifyLines(proceeded), ["  verify: auto"]);
  assert.ok(proceeded.includes("  # a machine conclusion parks until a person releases it"), "the filer's comment is kept above the rewrite");
  assert.equal(onProceed.priority, UNPRICED_PRIORITY, "with its unpriced dispatch priority");
  assert.equal(onProceed.risk_ruling?.verdict, "low");
  assert.equal(onProceed.risk_ruling?.pin, taskRulingPin(onProceed));
  assert.equal(onProceed.risk_ruling?.operator_release_pin, undefined, "a judge ruling pins no operator release");

  const escalated = recordOf(render({ action: "escalate" }));
  assert.equal(escalated.verify, "human");
  assert.equal(escalated.risk_ruling?.action, "escalate");
  assert.equal(escalated.priority, undefined, "an escalation inserts no priority");

  // The mapping is keyed on the VERDICT: only an operator release is exempt from it.
  assert.equal(recordOf(released()).verify, "human");
});

test("settled operator ruling at verify: human is not re-rendered", () => {
  const contents = released();
  const landed = recordOf(contents);
  const operatorReleases = new Set([ID]);

  assert.equal(judge.needsMachineJudgement(recordOf(SHARD), operatorReleases), true, "control: the unruled release is due");
  assert.equal(judge.settledOperatorRelease(landed), true);
  assert.equal(judge.needsMachineJudgement(landed, operatorReleases), false,
    "the ruling the release authorized has landed on the record, so the next pass has nothing to do");

  // Re-rendering the landed record changes nothing but the stamp, which is why re-rendering it is the defect.
  const again = judge.renderRuledShard(contents, REL, judgedPin(contents), ruling({ judgedAt: "2026-11-21T09:00:00.000Z" }), new Set<string>());
  assert.ok("contents" in again);
  assert.equal(again.contents.replace(/^ {4}judged_at: .*$/m, ""), contents.replace(/^ {4}judged_at: .*$/m, ""));

  // A contract edit is what makes it due again — and only after a fresh approval clears reapproval.
  const edited = recordOf(contents.replace("refuse an auto-merge arm whose head is unapproved", "refuse an auto-merge arm whose head is unreviewed"));
  assert.equal(judge.settledOperatorRelease(edited), false);
  assert.equal(release.operatorReleaseContractChanged(edited), true);
  const flippedVerify = recordOf(contents.replace(VERIFY_LINE, "  verify: auto"));
  assert.equal(judge.settledOperatorRelease(flippedVerify), false, "a verification-mode change is not a settled release either");
});
