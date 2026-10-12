import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, test } from "node:test";
import {
  attemptArm, attemptArmAsync, realArmDeps, realArmDepsAsync,
  PLAN_TOUCH_READ_TTL_MS, type ArmDeps,
} from "../src/lib/arm-auto-merge.js";
import { systemClock } from "../src/lib/clock.js";
import { ghShim } from "./helpers/gh-shim.js";

const HEAD = "head5674";
const FILES = '[{"filename":"plan/tasks.d/optional-check.yaml"}]';

function harness(readPlanTouch: ArmDeps["readPlanTouch"], mergeableState = "unstable", behindBy = 0) {
  const calls: string[] = [];
  const deps: ArmDeps = {
    headSha: () => HEAD, ledgerLines: () => [], readPlanTouch,
    readMergeFacts: () => ({ mergeable: "MERGEABLE", mergeableState, behindBy }),
    updateBranch: () => { calls.push("update"); return { ok: true }; },
    armAuto: () => { calls.push("arm"); }, mergeDirect: () => { calls.push("merge"); },
    disableAuto: () => {}, isMerged: () => false, say: () => {},
  };
  return { deps, calls };
}

describe("test/a-plan-pr-held-only-by-an-optional-check-still-merges.test.ts", () => {
  for (const asyncDriver of [false, true]) {
    const mode = asyncDriver ? "async" : "sync";
    test(`${mode}: an unstable plan PR merges directly and two arm attempts at one head read its files once`, async (t) => {
      const pr = `https://github.com/test/optional-check/pull/${asyncDriver ? 2 : 1}`;
      const shim = ghShim([{ when: "/files", stdout: FILES }], { kind: "w1t5674" });
      t.mock.method(systemClock, "now", () => 1_000);
      const oldPath = process.env.PATH;
      process.env.PATH = `${shim.dir}:${oldPath}`;
      t.after(() => { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); });
      const calls: string[] = [];
      for (let pass = 0; pass < 2; pass++) {
        const h = harness(() => "touched");
        const result = asyncDriver
          ? await attemptArmAsync(pr, { ...h.deps, readPlanTouch: realArmDepsAsync().readPlanTouch }, HEAD)
          : attemptArm(pr, { ...h.deps, readPlanTouch: realArmDeps().readPlanTouch }, HEAD);
        assert.equal(result.outcome, "direct-merged");
        assert.equal(result.directMergePreflight?.remedy, "direct-merge");
        assert.equal(result.directMergePreflight?.behindBy, 0);
        calls.push(...h.calls);
      }
      assert.deepEqual(calls, ["merge", "merge"]);
      assert.equal(shim.calls().filter((c) => c.includes("/files")).length, 1);
    });
  }

  test("has_hooks also takes the direct path, while a behind unstable plan head is refreshed first", () => {
    const hooks = harness(() => "touched", "has_hooks");
    assert.equal(attemptArm("https://github.com/test/optional-check/pull/3", hooks.deps, HEAD).outcome, "direct-merged");
    assert.deepEqual(hooks.calls, ["merge"]);
    const behind = harness(() => "touched", "unstable", 2);
    assert.equal(attemptArm("https://github.com/test/optional-check/pull/4", behind.deps, HEAD).outcome, "direct-merge-updated");
    assert.deepEqual(behind.calls, ["update"]);
  });

  test("blocked, conflicting and inconsistent plan facts still cannot merge", () => {
    const pr = "https://github.com/test/optional-check/pull/5";
    const blocked = harness(() => "touched", "blocked");
    assert.equal(attemptArm(pr, blocked.deps, HEAD).outcome, "plan-pr-held");
    assert.deepEqual(blocked.calls, []);
    for (const facts of [
      { mergeable: "CONFLICTING", mergeableState: "unstable", behindBy: 0 },
      { mergeable: "MERGEABLE", mergeableState: "has_hooks", behindBy: -1 },
    ]) {
      const h = harness(() => "touched");
      h.deps.readMergeFacts = () => facts;
      assert.equal(attemptArm(pr, h.deps, HEAD).outcome, "direct-merge-preflight-refused");
      assert.deepEqual(h.calls, []);
    }
  });

  test("the plan-touch cache separates PRs and heads, expires, and does not cache unattributed reads", (t) => {
    const pr = "https://github.com/test/optional-check/pull/6";
    const shim = ghShim([{ when: "/files", stdout: FILES }], { kind: "w1t5674" });
    const oldPath = process.env.PATH;
    process.env.PATH = `${shim.dir}:${oldPath}`;
    t.after(() => { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); });
    let now = 1_000;
    t.mock.method(systemClock, "now", () => now);
    const read = realArmDeps().readPlanTouch!;
    assert.equal(read(pr, HEAD), "touched");
    now += PLAN_TOUCH_READ_TTL_MS - 1;
    assert.equal(read(pr, HEAD), "touched");
    assert.equal(shim.calls().length, 1);
    shim.addRoute({ when: "/files", stdout: '[{"filename":"src/other.ts"}]' });
    assert.equal(read(pr, "new-head"), "untouched");
    assert.equal(read(pr, "new-head"), "untouched");
    assert.equal(read(`${pr}0`, HEAD), "untouched");
    assert.equal(shim.calls().length, 3);
    now++;
    assert.equal(read(pr, HEAD), "untouched");
    assert.equal(shim.calls().length, 4);
    assert.equal(read(pr), "untouched");
    assert.equal(read(pr), "untouched");
    assert.equal(shim.calls().length, 6);
    assert.equal(read("not-a-pr", HEAD), "unreadable");
    assert.equal(shim.calls().length, 6);
  });

  for (const asyncDriver of [false, true]) {
    test(`${asyncDriver ? "async" : "sync"}: unreadable file lists are retried at the same head`, async (t) => {
      const pr = `https://github.com/test/optional-check/pull/${asyncDriver ? 8 : 7}`;
      const shim = ghShim([{ when: "/files", stderr: "files unavailable", exit: 1 }], { kind: "w1t5674" });
      const oldPath = process.env.PATH;
      process.env.PATH = `${shim.dir}:${oldPath}`;
      t.after(() => { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); });
      t.mock.method(systemClock, "now", () => 1_000);
      const read = (asyncDriver ? realArmDepsAsync() : realArmDeps()).readPlanTouch!;
      assert.equal(await read(pr, HEAD), "unreadable");
      shim.addRoute({ when: "/files", stdout: "[]" });
      assert.equal(await read(pr, HEAD), "unreadable");
      shim.addRoute({ when: "/files", stdout: FILES });
      assert.equal(await read(pr, HEAD), "touched");
      assert.equal(await read(pr, HEAD), "touched");
      assert.equal(shim.calls().length, 3);
    });
  }
});
