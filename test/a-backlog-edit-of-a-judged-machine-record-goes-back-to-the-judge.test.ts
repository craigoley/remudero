// 2026-10-10 on the fleet host the backlog lane's plan PR was refused at 17:17, 17:38, 17:55 and 18:09Z, the same
// change each time: it retired W1-T5161 and W1-T6007 (selector-shadow-miss records the machine-filing judge had
// released). Retirement drops `priority:`, a field the risk_ruling pin covers, so each landing carried a stale pin:
// lint-plan refused it [machine-author-verify] and the shard census counted both shards as newly violating. The
// lane had no landing guard, so only the plan-PR preflight caught it, after a worktree and a full preflight each time.
// A backlog edit that stales a ruling now parks the record for the judge (verify: human, ruling dropped), the state a
// machine filing arrives in, and the judge rules on the record as it now stands. The lane's guard checks both.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyBacklogActions, backlogGardenSpec, backlogLandingGuard, type BacklogAction, type BacklogEvidence } from "../src/lib/backlog-gardener.js";
import { machineShardFilingRefusal } from "../src/lib/machine-filing.js";
import { needsMachineJudgement } from "../src/lib/machine-filing-judge.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import { lintTask, machineAuthorVerifyViolation } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REL = "plan/tasks.d/w1-t5161-selector-shadow-miss.yaml";
/** W1-T5161 as main carried it on 2026-10-10: judged `proceed`, banded 4 by this gardener. */
const SHARD = String.raw`
- id: W1-T5161
  title: "REPAIR THE SELECTOR EDGE INTO test/preflight-progress-streaming.test.ts — a coverage shard failure its retry did not recover was missed"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  priority: 4
  status: queued
  # backlog gardener: band=4 evidence=0140d95b35f086e4
  attempts: 0
  author_class: machine
  origin: "selector-shadow-miss:test/preflight-progress-streaming.test.ts"
  files: [src/lib/affected-suites.ts, test/the-affected-suite-selector-runs-in-shadow.test.ts]
  note: "W1-T4439 first observed a narrow miss on coverage run 36895766446 for PR #8440 at 3a8347105317948ed193a9cb5a06eed151faac71: scripts/coverage-merge-ratchet.mjs, src/lib/ci-parity.ts, test/merge-lcov.test.ts, test/the-coverage-entry-shards-the-way-ci-does.test.ts -> test/preflight-progress-streaming.test.ts. The failing shard concluded failure, so its retry did not recover it. The changed paths are candidate missing edges, not guessed import edges. Later misses of the same suite are ledgered as selector-shadow.miss_evidence rows naming this task rather than filed again. Add a test in test/the-affected-suite-selector-runs-in-shadow.test.ts that selects test/preflight-progress-streaming.test.ts for each edge: diff-coverage blocks an edge no test exercises."
  acceptance:
    - claim: "the narrow selector includes test/preflight-progress-streaming.test.ts when this edge is exercised"
      proof: "grep: test/preflight-progress-streaming\\.test\\.ts in src/lib/affected-suites.ts"
    - claim: "a regression test selects test/preflight-progress-streaming.test.ts for each recorded edge"
      proof: "grep: test/preflight-progress-streaming\\.test\\.ts in test/the-affected-suite-selector-runs-in-shadow.test.ts"
  risk_ruling:
    verdict: "low"
    action: proceed
    confidence: 0.92
    reasons:
      - "The filed plan scopes a selector-edge repair and regression coverage to two matching implementation/test files."
      - "The supplied family track record reports 8 merged and 0 declined tasks, supporting established practice."
      - "The filing-time gates report no concerning condition, and the stated scope identifies no operator-only decision or escalation-triggering action."
    judged_at: "2026-10-09T23:04:13.055Z"
    pin: "a881634b1191b820b1b5676cb1b5407f619173e6d4e23374e9299a685640f521"
`.trimStart();

function tree(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}backlog-repark-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["plan/tasks.d", "src/lib", "test"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, REL), SHARD);
  writeFileSync(join(root, "src/lib/affected-suites.ts"), "");
  writeFileSync(join(root, "test/the-affected-suite-selector-runs-in-shadow.test.ts"), "");
  return root;
}

const evidence = { signature: "1234567890abcdef" } as BacklogEvidence;
const retire: BacklogAction = { class: "retire", target: "W1-T5161", reason: "overtaken", disposition: { kind: "retire", retirement: "withdrawn" }, evidence };
const reband: BacklogAction = { class: "place", target: "W1-T5161", reason: "a growing symptom", disposition: { kind: "band", band: 2 }, evidence };

test("a backlog retirement or re-band of a judged machine record parks it for the judge, so the landing lints clean", (t) => {
  const control = parseTasksFromYaml(SHARD, REL)[0]!;
  assert.equal(machineAuthorVerifyViolation(control), undefined, "control: the record as judged clears Law 5's pin check");

  for (const action of [retire, reband]) {
    const root = tree(t);
    assert.deepEqual(applyBacklogActions(root, new Map([["W1-T5161", REL]]), [action]), [REL], `${action.class}: the shard is edited`);
    const text = readFileSync(join(root, REL), "utf8");
    const edited = parseTasksFromYaml(text, REL)[0]!;
    assert.equal(machineAuthorVerifyViolation(edited), undefined, `${action.class}: no stale pin lands`);
    assert.deepEqual(lintTask(edited).violations.filter((v) => v.severity === "block").map((v) => v.check), [], `${action.class}: the census sees no blocking violation`);
    assert.equal(edited.verify, "human");
    assert.equal(edited.risk_ruling, undefined, `${action.class}: the stale ruling is dropped, not re-pinned by the gardener`);
    assert.equal(machineShardFilingRefusal(text, REL, { pathExists: () => true }), undefined, `${action.class}: lint-plan's machine-filing admission takes it`);
    assert.equal(backlogLandingGuard({ repoRoot: root })(root, [REL]), undefined, `${action.class}: the lane's own guard passes it`);
    if (action === reband) {
      assert.equal(edited.priority, 2);
      assert.equal(needsMachineJudgement(edited), true, "a queued re-banded record is due for the judge's re-judge path");
    } else {
      assert.equal(edited.retirement, "withdrawn");
    }
  }
});

test("the backlog lane's landing guard refuses a stale ruling pin and a blocking violation the edit introduces", (t) => {
  const root = tree(t);
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}backlog-guard-base-`));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(base, REL), SHARD);
  // What the lane landed on main's code: priority edited, ruling kept, so the pin no longer matches.
  writeFileSync(join(root, REL), SHARD.replace("  priority: 4\n", "  priority: 2\n"));
  const spec = backlogGardenSpec({ stateDir: join(root, "state"), repoRoot: base, openWorkspace: () => { throw new Error("unused"); }, log: () => {} });
  assert.match(String(spec.landingRefusal?.(root, [REL])), /machine-author-verify/, "the spec carries the guard, and it names the stale pin");

  // An operator record the edit gives a blocking violation the census would count; one it already had is not this edit's.
  const op = "plan/tasks.d/W1-T9891-an-operator-record.yaml";
  const record = (files: string) => `- id: W1-T9891\n  title: "an operator record"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: low\n  status: queued\n  files: [${files}]\n  acceptance:\n    - claim: "it holds"\n      proof: "unit test: it holds"\n`;
  writeFileSync(join(base, op), record("src/lib/a.ts"));
  writeFileSync(join(root, op), record("src/lib/a.ts, DECISIONS.md"));
  assert.match(String(backlogLandingGuard({ repoRoot: base })(root, [op])), /W1-T9891: ruling-verify/);
  writeFileSync(join(base, op), record("src/lib/a.ts, DECISIONS.md"));
  assert.equal(backlogLandingGuard({ repoRoot: base })(root, [op]), undefined, "a violation main already carries is not refused here");

  // A shard new to main is checked whole; one this landing made unloadable is refused; one main already cannot load is not.
  const fresh = "plan/tasks.d/W1-T9892-a-new-record.yaml";
  writeFileSync(join(root, fresh), record("DECISIONS.md").replaceAll("W1-T9891", "W1-T9892"));
  assert.match(String(backlogLandingGuard({ repoRoot: base })(root, [fresh])), /W1-T9892: ruling-verify/);
  writeFileSync(join(root, op), "- id: W1-T9891\n  title: [unterminated\n");
  assert.match(String(backlogLandingGuard({ repoRoot: base })(root, [op])), /W1-T9891-an-operator-record\.yaml: does not load/);
  writeFileSync(join(base, op), "- id: W1-T9891\n  title: [unterminated\n");
  assert.equal(backlogLandingGuard({ repoRoot: base })(root, [op]), undefined);
  const stand = () => undefined;
  assert.equal(backlogLandingGuard({ repoRoot: base, landingRefusal: stand }), stand, "a fixture's stand-in guard is used as given");
});
