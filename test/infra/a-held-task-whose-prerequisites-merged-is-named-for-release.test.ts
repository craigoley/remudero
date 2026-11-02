import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assessHold, HOLD_READINESS_PASS_STEP, HOLD_READINESS_STEP, mergedTaskIds, observeHoldReadiness, startHoldReadinessObserver } from "#src/lib/hold-readiness.js";
import { withTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const heldShard = (id: string, cites: string, extra = "") => `- id: ${id}
  title: held fixture
  repo: remudero-console
  depends_on: []
  type: implement
  verify: auto
  status: queued
  dispatch_hold: true
  plan_refs:
    - core ${cites}
${extra}  design: >-
    DISPATCH HOLD: release only in a separate plan-only readiness amendment after core ${cites} has native merged credit.
`;

test("W1-T11094 criterion 1: a hold reads prerequisites-merged only when every id it cites has merged credit", () => {
  const merged = mergedTaskIds([
    "feat(read-model): publish durable daily progress reports (#14176)", "", "Remudero-Task: W1-T10559",
    "fix(read-model): code health (W1-T10560) (#14363)",
  ].join("\n"));
  assert.deepEqual([...merged].sort(), ["W1-T10559", "W1-T10560"]);
  const ready = assessHold({ id: "CONSOLE-T143", plan_refs: ["core W1-T10559"], design: "DISPATCH HOLD: after core W1-T10559 merges" }, "p", merged);
  assert.equal(ready.state, "prerequisites-merged");
  assert.match(ready.condition, /^DISPATCH HOLD: after core W1-T10559/);
  const waiting = assessHold({ id: "CONSOLE-T144", depends_on: ["CONSOLE-T143"], plan_refs: ["core W1-T10560"] }, "p", merged);
  assert.equal(waiting.state, "waiting");
  assert.deepEqual(waiting.unmerged, ["CONSOLE-T143"]);
  const bare = assessHold({ id: "W1-T5060", note: "waits for W1-T5060's own gate" }, "p", merged);
  assert.equal(bare.state, "cites-nothing", "a task's own id is never its prerequisite");
});

test("W1-T11094 criterion 2: one pass over origin/main names each held queued shard once, and an unchanged picture writes no new row", async () => {
  await withTempDir("hold-readiness", async (dir) => {
    const fixture = gitRepo({ seedCommit: false, kind: "hold-readiness-plan" });
    const repo = fixture.dir;
    const git = (...args: string[]) => fixture.git(...args);
    mkdirSync(join(repo, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(repo, "plan", "tasks.d", "CONSOLE-T143-ready.yaml"), heldShard("CONSOLE-T143", "W1-T10559"));
    writeFileSync(join(repo, "plan", "tasks.d", "CONSOLE-T104-waiting.yaml"), heldShard("CONSOLE-T104", "W1-T5060"));
    writeFileSync(join(repo, "plan", "tasks.d", "CONSOLE-T90-retired.yaml"), heldShard("CONSOLE-T90", "W1-T10559", "  retirement: retired\n"));
    writeFileSync(join(repo, "plan", "tasks.d", "CONSOLE-T91-free.yaml"), heldShard("CONSOLE-T91", "W1-T10559").replace("dispatch_hold: true", "dispatch_hold: false"));
    git("add", "-A");
    git("commit", "-q", "-m", "plan", "-m", "Remudero-Task: W1-T10559");
    git("update-ref", "refs/remotes/origin/main", "HEAD");

    const rows: Array<{ step: string } & Record<string, unknown>> = [];
    const deps = { planCheckout: repo, creditCheckouts: [repo], log: (step: string, fields: Record<string, unknown>) => void rows.push({ step, ...fields }) };
    const seen = new Map<string, string>();
    const pass = await observeHoldReadiness(deps, seen);
    assert.ok("readiness" in pass, JSON.stringify(pass));
    const named = rows.filter((row) => row.step === HOLD_READINESS_STEP).map((row) => [row.hold_task, row.state]);
    assert.deepEqual(named.sort(), [["CONSOLE-T104", "waiting"], ["CONSOLE-T143", "prerequisites-merged"]]);
    assert.ok(rows.every((row) => row.mode === "shadow"), "every row is shadow");
    assert.deepEqual(rows.find((row) => row.step === HOLD_READINESS_PASS_STEP), {
      step: HOLD_READINESS_PASS_STEP, mode: "shadow", held: 2, prerequisites_merged: 1, waiting: 1, cites_nothing: 0 });

    rows.length = 0;
    await observeHoldReadiness(deps, seen);
    assert.deepEqual(rows.map((row) => row.step), [HOLD_READINESS_PASS_STEP], "an unchanged hold is not re-reported");
    fixture.cleanup();
  });
});

test("W1-T11094 criterion 4: the timer observer survives a failed ledger write and keeps passing afterwards", async (t) => {
  await withTempDir("hold-readiness-timer", async (dir) => {
    const errors: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void errors.push(args));
    const steps: string[] = [];
    let calls = 0;
    const observer = startHoldReadinessObserver({ planCheckout: join(dir, "absent"), creditCheckouts: [],
      log: (step) => {
        calls += 1;
        if (calls === 1) throw new Error("ledger write failed");
        steps.push(step);
      } }, 3_600_000, 1);
    try {
      const deadline = Date.now() + 20_000;
      // The first pass's log write throws (rejection arm); a fresh observer below proves the resolve arm.
      // The absent checkout also makes the git pin write its own refusal row to console.error; only the observer's report counts.
      const reported = () => errors.filter((args) => args[0] === "hold readiness observer failed");
      while (reported().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(reported().length, 1, "the failed write is reported once, not thrown");
      assert.match(String(reported()[0]![1]), /ledger write failed/);
    } finally {
      observer.close();
    }
    const second = startHoldReadinessObserver({ planCheckout: join(dir, "absent"), creditCheckouts: [], log: (step) => void steps.push(step) },
      3_600_000, 1);
    try {
      const deadline = Date.now() + 20_000;
      while (steps.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(steps, [HOLD_READINESS_PASS_STEP]);
    } finally {
      second.close();
    }
  });
});

test("W1-T11094 criterion 4b: a pass still in flight makes the next tick a no-op", async () => {
  await withTempDir("hold-readiness-overlap", async (dir) => {
    const steps: string[] = [];
    const observer = startHoldReadinessObserver({ planCheckout: join(dir, "absent"), creditCheckouts: [],
      log: (step) => void steps.push(step) }, 1, 1);
    try {
      const deadline = Date.now() + 20_000;
      while (steps.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(steps.length >= 1);
      assert.ok(steps.every((step) => step === HOLD_READINESS_PASS_STEP));
    } finally {
      observer.close();
    }
  });
});

test("W1-T11094 criterion 3: an unreadable checkout is reported as unreadable, never as a plan with no holds", async () => {
  await withTempDir("hold-readiness-missing", async (dir) => {
    const rows: Array<{ step: string } & Record<string, unknown>> = [];
    const pass = await observeHoldReadiness({ planCheckout: join(dir, "absent"), creditCheckouts: [],
      log: (step, fields) => void rows.push({ step, ...fields }) }, new Map());
    assert.ok("unreadable" in pass);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.step, HOLD_READINESS_PASS_STEP);
    assert.equal(typeof rows[0]!.unreadable, "string");
  });
});
