import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { renderCommentCompressionShard } from "#src/lib/gate-gardener.js";
import { backstopConcern, deterministicEscalation, pathClass } from "#src/lib/machine-filing.js";
import { judgeMachineShard } from "#src/lib/machine-filing-judge.js";
import { loadPlanFromYaml, type Task } from "#src/lib/plan.js";
import type { RiskJudgeInput } from "#src/lib/risk-judge.js";

// The seven subjects parked on the operator 2026-11-17, each by the privileged-path rule alone.
const PARKED = [
  "src/lib/deployer.ts", "deploy/recycle-container.sh", "deploy/host-update.sh", ".github/workflows/ci.yml",
  "src/lib/arm-auto-merge.ts", "deploy/install-host-units.sh", "deploy/verify-image.sh",
];
const RECORD = { family: "comment-compression", merged: 3, declined: 0, alpha: 4, beta: 1, mean: 0.8 };
const PORTS = { policy: { confidenceThreshold: 0.7, verifyHumanReleaseEnabled: true }, clock: fixedClock(Date.parse("2026-11-25T00:00:00Z")) };

/** The record exactly as the comment-compression filer writes it. */
function filed(file: string, taskId = "W1-T99481"): Task {
  const { text, refused } = renderCommentCompressionShard({ file, comments: 400 }, taskId);
  assert.equal(refused, undefined, `the filer's record lints clean: ${refused}`);
  return loadPlanFromYaml(text, `plan/tasks.d/${taskId}-x.yaml`).tasks[0]!;
}

test("W1-T13481 criterion 1: a deploy or CI comment-compression record with the generated token claim goes to the judge", async () => {
  for (const file of PARKED) {
    assert.equal(pathClass(file), "privileged", `${file} is a privileged subject`);
    const task = filed(file);
    assert.deepEqual(task.files, [file, task.files![1]], file);
    assert.equal(deterministicEscalation(task), undefined, file);
    const concern = backstopConcern(task) ?? "";
    assert.ok(concern.startsWith(`CONCERN: it declares ${file}, `), `${file}: ${concern}`);
    let seen: RiskJudgeInput | undefined;
    const judged = await judgeMachineShard(task, RECORD, {
      ...PORTS, riskJudge: async (input) => { seen = input; return { verdict: "low", confidence: 0.95, reasons: ["comment-only, token-compared"] }; },
    });
    assert.ok(seen !== undefined, `${file}: the risk judge is asked`);
    assert.ok(seen.change.description.includes(concern), `${file}: the judge reads the concern`);
    assert.equal(judged.kind === "ruled" && judged.ruling.action, "proceed", file);
  }
});

test("W1-T13481 criterion 2: a compression record that also declares another privileged path still escalates", async () => {
  const task = filed("deploy/recycle-container.sh");
  const tests = task.files!.slice(1);
  const extraClaim = { claim: "the deploy script restarts the container", proof: "grep: restart in deploy/recycle-container.sh" };
  const variants: [string, Task][] = [
    ["another deploy path", { ...task, files: [...task.files!, "deploy/host-update.sh"] }],
    ["a workflow path", { ...task, files: [...task.files!, ".github/workflows/release.yml"] }],
    ["a source path beside the subject", { ...task, files: [...task.files!, "src/lib/x.ts"] }],
    ["a second acceptance claim", { ...task, acceptance: [...task.acceptance, extraClaim] }],
    ["an edited claim", { ...task, acceptance: [{ ...task.acceptance[0]!, claim: `${task.acceptance[0]!.claim} Also restart.` }] }],
    ["an operator author", { ...task, author_class: "operator" }],
    ["an origin naming another subject", { ...task, origin: "comment-compression:deploy/host-update.sh" }],
    ["a privileged path without its subject", { ...task, files: ["deploy/host-update.sh", ...tests] }],
  ];
  for (const [why, risky] of variants) {
    assert.match(deterministicEscalation(risky) ?? "", /^it declares (deploy|\.github)\/\S+, a secrets, auth, CI, deploy/, why);
    assert.equal(backstopConcern(risky), undefined, why);
    let asked = false;
    const judged = await judgeMachineShard(risky, RECORD, { ...PORTS, riskJudge: async () => { asked = true; return { verdict: "low", confidence: 1, reasons: [] }; } });
    assert.equal(asked, false, `${why}: the judge is never asked`);
    assert.equal(judged.kind === "ruled" && judged.ruling.action, "escalate", why);
  }
});
