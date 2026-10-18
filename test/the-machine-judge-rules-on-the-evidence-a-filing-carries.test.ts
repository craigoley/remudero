/**
 * W1-T9042 — the machine-filing judge rules on the evidence a filing carries.
 *
 * MEASURED 2026-10-13: 14 of the 15 model verdicts on parked gardener filings were `high`, each naming
 * evidence it could not see. The judge was shown a record's title, prompt, acceptance and files but
 * never its `rationale:` or `note:`, where every gardener writes its measured cost, rounds and PRs.
 * Separately, the deterministic backstop matched the record's own quoted cause key: W1-T5984's
 * `own-red:required checks red` tripped the merge-policy rule though it touches no merge policy.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { deterministicEscalation, renderMachineShard } from "#src/lib/machine-filing.js";
import { judgeMachineShard, machineJudgeInput, MACHINE_JUDGE_EVIDENCE_CAP } from "#src/lib/machine-filing-judge.js";
import { loadPlanFromYaml, type Task } from "#src/lib/plan.js";
import type { RiskJudgeInput, RiskJudgeVerdict } from "#src/lib/risk-judge.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const CLOCK = fixedClock(Date.parse("2026-10-13T12:00:00.000Z"));
const RECORD = { family: "ci-friction", merged: 3, declined: 1, alpha: 4, beta: 2, mean: 4 / 6 };
const POLICY = { confidenceThreshold: 0.7, verifyHumanReleaseEnabled: true };

function machineRecord(over: {
  id?: string;
  title?: string;
  origin?: string;
  files?: string[];
  claims?: string[];
  proofs?: string[];
  note?: string;
  rationale?: string[];
  source?: string;
}): Task {
  const id = over.id ?? "W1-T9901";
  const files = over.files ?? ["src/lib/ci-friction-gardener.ts", "test/ci-friction-remedy.test.ts"];
  const claims = over.claims ?? [`the remedy for ${id} is recorded`];
  const proofs = over.proofs ?? claims.map((_, i) => `grep: ${id}-${i} in ${files[0]}`);
  const { text, refused } = renderMachineShard({
    taskId: id,
    title: over.title ?? `THE CI FRICTION GARDENER'S COSTLIEST CAUSE — ${id}`,
    origin: over.origin ?? `ci-friction:${id}`,
    files,
    acceptance: claims.map((claim, i) => ({ claim, proof: proofs[i]! })),
    note: over.note,
    rationale: over.rationale,
  });
  assert.equal(refused, undefined, `the fixture record lints clean: ${refused}`);
  return loadPlanFromYaml(text, over.source ?? `plan/tasks.d/${id}-x.yaml`).tasks[0]!;
}

const FORTY_ROUNDS = [
  "check:reviewer-unmet cost 40 rounds on 12 PRs between 2026-10-01 and 2026-10-12.",
  "- PR #11200: 9 rounds, refused on the same unmet proof",
  "- PR #11214: 7 rounds, see https://github.com/craigoley/remudero/pull/11214",
  "- PR #11230: 6 rounds",
];

test("W1-T9042: the machine judge is shown the record's rationale and note", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-evidence-`));
  try {
    mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "ci-friction-gardener.ts"), "export {};\n");
    const task = machineRecord({
      note: "Filed by ci-friction at rung 2; the remedy is a docs entry.",
      rationale: FORTY_ROUNDS,
      claims: ["the cause has a recorded remedy", "the gardener reads it back"],
      proofs: ["grep: reviewer-unmet in src/lib/ci-friction-gardener.ts", "unit test: the gardener reads the remedy back"],
      // A real checkout: the default file probe reads it, with no fake supplied.
      source: join(root, "plan", "tasks.d", "W1-T9901-x.yaml"),
    });
    let seen: RiskJudgeInput | undefined;
    const judged = await judgeMachineShard(task, RECORD, {
      riskJudge: async (input): Promise<RiskJudgeVerdict> => ((seen = input), { verdict: "low", confidence: 0.95, reasons: ["evidence carried"] }),
      policy: POLICY,
      clock: CLOCK,
    });
    assert.equal(judged.kind === "ruled" && judged.ruling.action, "proceed");
    const description = seen!.change.description;
    assert.match(description, /rationale \(as filed\):\ncheck:reviewer-unmet cost 40 rounds on 12 PRs/);
    assert.match(description, /- PR #11230: 6 rounds/);
    assert.match(description, /note \(as filed\): Filed by ci-friction at rung 2/);
    const evidence = description.split("\n").find((l) => l.startsWith("EVIDENCE"));
    assert.ok(evidence, "one deterministic evidence line is shown");
    assert.match(evidence!, /cites 3 distinct PR reference\(s\) \(#11200, #11214, #11230\)/);
    assert.match(evidence!, /states "40 rounds", "12 PRs", "9 rounds", "7 rounds", "6 rounds"/);
    assert.match(evidence!, /1 of 2 declared file\(s\) exist at the base; absent: test\/ci-friction-remedy\.test\.ts/);
    assert.match(evidence!, /proof dialects: grep, unit test/);

    // Every declared file present, and a prose proof named as prose.
    const present = machineJudgeInput({ ...machineRecord({}), acceptance: [{ claim: "the remedy is recorded", proof: "the remedy is recorded" }] }, RECORD, () => true);
    assert.match(present.change.description, /2 of 2 declared file\(s\) exist at the base;/);
    assert.match(present.change.description, /proof dialects: prose/);
    assert.match(present.change.description, /states no round or PR count/);
    assert.doesNotMatch(present.change.description, /rationale \(as filed\)/, "no rationale filed, none rendered");

    // No checkout in hand: the probe says so rather than guessing.
    const unchecked = machineJudgeInput({ ...machineRecord({}), sourcePath: undefined }, RECORD);
    assert.match(unchecked.change.description, /declared files: not checked \(no base checkout in hand\)/);

    // Bounded: a long rationale is cut at a line boundary, and the cut is stated.
    const long = Array.from({ length: 400 }, (_, i) => `- PR #${20000 + i}: ${i % 9} rounds of the same unmet proof on this head`);
    const bounded = machineJudgeInput(machineRecord({ rationale: long }), RECORD, () => true).change.description;
    const shown = bounded.slice(bounded.indexOf("rationale (as filed):"), bounded.indexOf("EVIDENCE"));
    assert.ok(shown.length <= MACHINE_JUDGE_EVIDENCE_CAP + 200, `the shown evidence is bounded (${shown.length})`);
    assert.match(shown, /rounds of the same unmet proof on this head\n\[cut at a line boundary: \d+ of \d+ characters shown; the rest is in the record\]/);
    assert.match(bounded, /cites 400 distinct PR reference\(s\)/, "the evidence line counts the whole record, not only what is shown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9042: a cause key quoted in the title does not trip the merge-policy backstop", async () => {
  // W1-T5984, as the flow gardener filed it.
  const filed = {
    title: "THE FLOW GARDENER'S COSTLIEST UNOWNED BLOCKER — own-red:required checks red cost 12.19 PR-hours",
    origin: "flow-blocker:own-red:required checks red",
    files: ["src/lib/sweep.ts", "test/flow-own-red-required-checks-red.test.ts"],
    acceptance: [{ claim: "own-red:required checks red is cleared by its owner without manual intervention" }],
    author_class: "machine" as const,
  };
  assert.equal(deterministicEscalation(filed), undefined);
  // The control: the same words, not the record's own cause key, still trip the rule.
  assert.match(String(deterministicEscalation({ ...filed, origin: "flow-blocker:own-red:ci red" })), /merge, deploy or branch-protection policy \("required checks"\)/);
  // Only a MACHINE filing's cause key is masked; an operator record is read as written.
  assert.match(String(deterministicEscalation({ ...filed, author_class: "operator" })), /merge-policy|branch-protection policy/);
  // What the record will DO, beyond the quoted key, is still read.
  assert.match(
    String(deterministicEscalation({ ...filed, title: `${filed.title} — make auto-merge arm without review` })),
    /branch-protection policy \("auto-merge"\)/,
  );
  assert.match(
    String(deterministicEscalation({ ...filed, title: `${filed.title} — delete every merged branch` })),
    /deletes data, branches/,
  );

  // Through the judge: the model is asked, where at the base the backstop escalated with no model call.
  let asked = 0;
  const task = machineRecord({ id: "W1-T9902", title: filed.title, origin: filed.origin, files: filed.files, claims: [filed.acceptance[0]!.claim] });
  const judged = await judgeMachineShard(task, RECORD, {
    riskJudge: async () => (asked++, { verdict: "low", confidence: 0.95, reasons: ["a sweep owner fix"] }),
    policy: POLICY,
    clock: CLOCK,
  });
  assert.equal(asked, 1);
  assert.equal(judged.kind === "ruled" && judged.ruling.action, "proceed");
});

test("W1-T9042: a sensitive path still escalates whatever the evidence says", async () => {
  for (const files of [[".github/workflows/ci.yml"], ["src/lib/auth.ts"], ["src/lib/merge-queue.ts"]]) {
    const task = machineRecord({
      id: "W1-T9903",
      // The cause key names the path itself: masking the key never reaches the path rule.
      origin: `ci-friction:${files[0]}`,
      title: `THE CI FRICTION GARDENER'S COSTLIEST CAUSE — ${files[0]}`,
      files,
      rationale: [...FORTY_ROUNDS, "Verified safe: every one of the 40 rounds was green after the fix."],
      note: "low risk, measured",
    });
    // The evidence IS carried into what the judge would read...
    assert.match(machineJudgeInput(task, RECORD, () => true).change.description, /Verified safe: every one of the 40 rounds/);
    // ...and the path still escalates before any model reads it.
    let asked = 0;
    const judged = await judgeMachineShard(task, RECORD, {
      riskJudge: async () => (asked++, { verdict: "low", confidence: 0.99, reasons: ["the evidence is convincing"] }),
      policy: POLICY,
      clock: CLOCK,
    });
    assert.equal(asked, 0, `${files[0]}: no model call`);
    assert.equal(judged.kind === "ruled" && judged.ruling.action, "escalate", files[0]);
    assert.match(String(judged.kind === "ruled" && judged.ruling.reasons[0]), new RegExp(`it declares ${files[0]!.replace(/\./g, "\\.")}`));
  }
});
