import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import {
  attemptArm, attemptArmAsync, disarmAutoMerge, disarmAutoMergeAsync,
  realArmDeps, realArmDepsAsync, type ArmDeps,
} from "../src/lib/arm-auto-merge.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

const url = "https://github.com/fixture/async-arm/pull/1";
const row = { body: "Stacked on #2", state: "open", merged: false, head: { sha: "head" },
  base: { ref: "main" }, mergeable: true, mergeable_state: "clean" };

async function fixture(run: (shim: ReturnType<typeof ghShim>) => Promise<void>) {
  const routes: GhShimRoute[] = [
    { when: "update-branch", stdout: "{}" },
    { when: "/files", stdout: JSON.stringify([{ filename: "src/example.ts" }]) },
    { when: "/compare/", stdout: JSON.stringify({ behind_by: 0 }) },
    { when: "/pulls/2", stdout: JSON.stringify({ state: "closed", merged: true }) },
    { when: "/pulls/1", stdout: JSON.stringify(row) },
  ].map((route) => ({ ...route, delaySeconds: 0.06 }));
  const shim = ghShim(routes);
  const path = process.env.PATH;
  process.env.PATH = `${shim.dir}:${path}`;
  try {
    await run(shim);
  } finally {
    process.env.PATH = path;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

async function timerDuring<T>(call: () => T | Promise<T>): Promise<T> {
  let ticks = 0;
  const interval = setInterval(() => ticks++, 5);
  try {
    const value = await call();
    assert.ok(ticks > 0, "a timer must fire before this read or wait settles");
    return value;
  } finally {
    clearInterval(interval);
  }
}

test("test/the-async-arm-path-reads-github-off-the-loop.test.ts: real readers let timers fire", async () => {
  await fixture(async () => {
    const sync = realArmDeps();
    const asyncDeps = realArmDepsAsync();
    assert.equal(asyncDeps.sleepSync, undefined);
    for (const name of ["headSha", "isMerged", "readMergeFacts", "readPlanTouch", "stackPrerequisite"] as const) {
      const value = await timerDuring(() => asyncDeps[name]!(url));
      assert.deepEqual(value, sync[name]!(url), name);
    }
    await withLiveWritesAllowed(async () => {
      assert.deepEqual(await timerDuring(() => asyncDeps.updateBranch!(url)), sync.updateBranch!(url));
    });
    await timerDuring(() => asyncDeps.sleep!(30));
    await asyncDeps.sleep!(0);
    await asyncDeps.sleep!(-1);
  });
});

test("async arm awaits head, facts, plan touch and unsettled retry sleep with sync outcome and logs", async () => {
  await fixture(async (shim) => {
    const syncMessages: string[] = [];
    const asyncMessages: string[] = [];
    const facts = { mergeable: "MERGEABLE", behindBy: 0, mergeableState: "clean" };
    let syncReads = 0;
    let syncMerges = 0;
    const waits: number[] = [];
    const syncDeps = {
      headSha: () => "head", readPlanTouch: () => "untouched" as const,
      stackPrerequisite: () => ({ state: "ready" as const, parentNumbers: [2] }),
      mergeQueue: () => false, ledgerLines: () => [], updateBranch: () => ({ ok: true }),
      armAuto: () => { throw new Error("API rate limit exceeded"); },
      mergeDirect: () => { if (++syncMerges === 1) throw new Error("HTTP 405"); },
      isMerged: () => false,
      readMergeFacts: () => ++syncReads === 2 ? { ...facts, mergeable: "UNKNOWN" } : facts,
      sleepSync: (ms: number) => { waits.push(ms); }, say: (message: string) => syncMessages.push(message),
    } satisfies Partial<ArmDeps>;
    const expected = attemptArm(url, syncDeps);
    const real = realArmDepsAsync();
    let asyncReads = 0;
    let asyncMerges = 0;
    const asyncWaits: number[] = [];
    const observed: string[] = [];
    const observe = async <T>(name: string, call: () => T | Promise<T>) => {
      const value = await timerDuring(call);
      observed.push(name);
      return value;
    };
    const actual = await attemptArmAsync(url, {
      ...real, ledgerLines: () => [], mergeQueue: () => false,
      headSha: () => observe("head", () => real.headSha(url)),
      stackPrerequisite: () => observe("stack", () => real.stackPrerequisite!(url)),
      readPlanTouch: () => observe("plan", () => real.readPlanTouch!(url)),
      readMergeFacts: () => {
        shim.addRoute({ when: "/pulls/1", stdout: JSON.stringify({ ...row,
          mergeable: ++asyncReads === 2 ? null : true }), delaySeconds: 0.06 });
        return observe("facts", () => real.readMergeFacts!(url));
      },
      isMerged: () => observe("merged", () => real.isMerged!(url)),
      armAuto: syncDeps.armAuto,
      mergeDirect: async () => { if (++asyncMerges === 1) throw new Error("HTTP 405"); },
      sleep: (ms) => {
        asyncWaits.push(ms);
        return observe("wait", () => real.sleep!(ms));
      },
      say: (message) => asyncMessages.push(message),
    });
    assert.deepEqual(actual, expected);
    assert.deepEqual(asyncMessages, syncMessages);
    assert.deepEqual(asyncWaits, waits);
    assert.deepEqual(observed, ["stack", "plan", "head", "facts", "merged", "facts", "wait", "facts", "head", "facts"]);
    assert.equal(asyncMerges, 2);
  });
});

test("async plan merge, branch update, queue and disarm await readers with sync refusals", async () => {
  const messages: string[] = [];
  const base: ArmDeps = {
    armAuto: () => { throw new Error("clean status"); }, mergeDirect: () => {},
    disableAuto: () => { throw new Error("can't disable auto-merge"); },
    headSha: () => "head", isMerged: () => false, ledgerLines: () => [],
    readPlanTouch: () => "touched",
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 1, mergeableState: "behind" }),
    updateBranch: () => ({ ok: true }), say: (message: string) => messages.push(message),
  } satisfies Partial<ArmDeps>;
  const asyncVersion = (deps: typeof base): ArmDeps<true> => ({
    ...deps,
    headSha: async (ref) => deps.headSha(ref), isMerged: async (ref) => deps.isMerged!(ref),
    readPlanTouch: async (ref) => deps.readPlanTouch!(ref), readMergeFacts: async (ref) => deps.readMergeFacts!(ref),
    updateBranch: async (ref) => deps.updateBranch!(ref),
  });
  const compare = async (deps: typeof base) => {
    messages.length = 0;
    const expected = attemptArm(url, deps);
    const expectedMessages = [...messages];
    messages.length = 0;
    assert.deepEqual(await attemptArmAsync(url, asyncVersion(deps)), expected);
    assert.deepEqual(messages, expectedMessages);
    return expected.outcome;
  };
  assert.equal(await compare(base), "direct-merge-updated");
  assert.equal(await compare({ ...base, updateBranch: () => { throw new Error("update failed"); } }), "direct-merge-update-failed");
  assert.equal(await compare({ ...base, readMergeFacts: () => { throw new Error("facts failed"); } }), "plan-pr-held");
  assert.equal(await compare({ ...base, headSha: () => { throw new Error("head failed"); } }), "direct-merge-preflight-refused");
  const clean: ArmDeps = { ...base, readPlanTouch: () => "untouched",
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 0, mergeableState: "clean" }),
    mergeDirect: () => { throw new Error("merge failed"); } };
  assert.equal(await compare(clean), "direct-merge-failed");
  assert.equal(await compare({ ...clean, isMerged: () => true }), "direct-merged");
  assert.equal(await compare({ ...base, readPlanTouch: () => { throw new Error("files failed"); } }), "direct-merge-updated");
  assert.equal(await disarmAutoMergeAsync(url, asyncVersion(base)), disarmAutoMerge(url, base));
  const merged = { ...base, isMerged: () => true };
  assert.equal(await disarmAutoMergeAsync(url, asyncVersion(merged)), "lost-race");
  const queue = { ...base, mergeQueue: () => true, enqueue: () => { throw new Error("queue failed"); } };
  assert.deepEqual(await attemptArmAsync(url, { ...asyncVersion(queue), ...queue, isMerged: async () => false }), attemptArm(url, queue));
});

test("real async readers preserve unreadable, invalid and rejected REST results", async () => {
  await fixture(async (shim) => {
    const sync = realArmDeps();
    const asyncDeps = realArmDepsAsync();
    for (const response of ["{}", "null", "[]", "invalid-json"]) {
      shim.addRoute({ when: "/files", stdout: response });
      shim.addRoute({ when: "/pulls/1", stdout: response });
      for (const name of ["isMerged", "readMergeFacts", "readPlanTouch", "stackPrerequisite"] as const) {
        assert.deepEqual(await asyncDeps[name]!(url), sync[name]!(url), `${name}: ${response}`);
      }
      await assert.rejects(async () => asyncDeps.headSha(url));
    }
    shim.addRoute({ when: "/pulls/1", stderr: "REST unavailable", exit: 1 });
    shim.addRoute({ when: "/files", stderr: "files unavailable", exit: 1 });
    shim.addRoute({ when: "update-branch", stderr: "update unavailable", exit: 1 });
    for (const name of ["isMerged", "readMergeFacts", "readPlanTouch"] as const) {
      assert.deepEqual(await asyncDeps[name]!(url), sync[name]!(url), name);
    }
    const unreadableBody = await asyncDeps.stackPrerequisite!(url);
    assert.equal(unreadableBody.state, "unreadable");
    assert.deepEqual(unreadableBody.parentNumbers, []);
    assert.match(unreadableBody.detail!, /could not read this PR's body:.*Command failed:[\s\S]*REST unavailable/);
    for (const name of ["isMerged", "readMergeFacts", "readPlanTouch", "stackPrerequisite", "updateBranch"] as const) {
      assert.deepEqual(await asyncDeps[name]!("bad-url"), sync[name]!("bad-url"), name);
    }
    await assert.rejects(async () => asyncDeps.headSha("bad-url"));
    await withLiveWritesAllowed(async () => {
      const update = await asyncDeps.updateBranch!(url);
      assert.equal(update.ok, false);
      assert.match(update.error!, /update unavailable/);
    });
    shim.addRoute({ when: "/pulls/1", stdout: JSON.stringify(row) });
    shim.addRoute({ when: "/pulls/2", stderr: "parent unavailable", exit: 1 });
    const unreadableParent = await asyncDeps.stackPrerequisite!(url);
    assert.equal(unreadableParent.state, "unreadable");
    assert.deepEqual(unreadableParent.parentNumbers, [2]);
    assert.match(unreadableParent.detail!, /could not read declared parent #2:.*Command failed:[\s\S]*parent unavailable/);
  });
});
