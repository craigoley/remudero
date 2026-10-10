// @source-text-subject: the fourth test's subject is which GitHub calls remain in buildSweepEffects' own
// source text (W1-T7747 acceptance 4); the other four drive the effects and assert their behaviour.
//
// W1-T7747 — MEASURED 2026-10-10 on the core daemon: `ghExecFile` (the leaf under `ghJson`/`ghExec`)
// held the loop 13 times, worst 5.1 s, and `mergeDirectViaRest` up to 2.7 s. `buildSweepEffects`
// reached GitHub through those synchronous calls, including the armed-idle direct merge. Each test
// below traps `execFileSync`, `spawnSync` and `execSync` (the `syncBuiltinESMExports` swap
// `startReadPlaneTelemetry` uses), so a synchronous spawn throws, and is recorded, instead of running.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { mergeDirectViaRestAsync, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import type { Config } from "../src/lib/config.js";
import { ghExec } from "../src/lib/github-transport.js";
import { LIVE_WRITE_SENTINEL_TOKEN, LiveWriteBlockedError, withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { buildSweepEffects, type OpenPrView } from "../src/lib/sweep.js";

const OWNER = "craigoley";
const REPO = "remudero";
const PR_NUMBER = 7747;
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`;
const HEAD = "7747774777477747774777477747774777477747";
const MOVED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PULLS = `repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`;

/** Every synchronous child-process spawn throws and is recorded until the test ends. */
function trapSyncSpawns(t: TestContext): string[] {
  const trapped: string[] = [];
  for (const name of ["execFileSync", "spawnSync", "execSync"] as const) {
    t.mock.method(childProcess, name, (...args: unknown[]) => {
      trapped.push(`${name} ${String(args[0])} ${Array.isArray(args[1]) ? args[1].slice(0, 4).join(" ") : ""}`.trim());
      throw new Error(`W1-T7747 trap: a synchronous ${name} would hold the daemon loop`);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return trapped;
}

/** An async REST reader that answers on a later macrotask, so an awaited answer is observably async. */
function asyncReader(answer: (args: string[]) => unknown) {
  const calls: string[][] = [];
  const settled: string[] = [];
  const read = (args: string[]): Promise<unknown> => {
    calls.push(args);
    return new Promise((resolve, reject) => setTimeout(() => {
      settled.push(args.join(" "));
      try {
        resolve(answer(args));
      } catch (error) {
        reject(error);
      }
    }, 5));
  };
  return { read, calls, settled };
}

function view(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER, prUrl: PR_URL, taskId: "W1-T7747", headSha: HEAD, autoMergeArmed: true,
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date().toISOString(), ...overrides,
  };
}

function harness(t: TestContext, deps: Partial<Parameters<typeof buildSweepEffects>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t7747-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logs: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const effects = buildSweepEffects({
    owner: OWNER, repo: REPO, config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"), runId: "RUN-W1-T7747", plan: { tasks: [], byId: new Map() },
    log: (step, fields = {}) => void logs.push({ step, fields }),
    armSessionPrsOverride: true, spawnWallClockBoundMsOverride: 1,
    ...deps,
  });
  return { effects, logs };
}

/** Drive the sweep's `arm` effect in armed-idle mode and hand back the deps it gave the arm. */
async function armedIdleDeps(t: TestContext, deps: Partial<Parameters<typeof buildSweepEffects>[0]>): Promise<ArmDeps<true>> {
  let captured: ArmDeps<true> | undefined;
  const { effects } = harness(t, {
    ...deps,
    armImpl: async (_prUrl, _taskId, armDeps) => {
      captured = armDeps as ArmDeps<true>;
      return "armed";
    },
  });
  await effects.arm!(view(), "armed-idle");
  assert.ok(captured, "the armed-idle arm hands its deps to the arm");
  return captured;
}

test("W1-T7747: the armed-idle direct merge awaits the async transport with the head sha pinned and no sync spawn", async (t) => {
  const trapped = trapSyncSpawns(t);
  const writes: string[][] = [];
  const order: string[] = [];
  const idle = await armedIdleDeps(t, {
    ghJsonAsyncImpl: asyncReader(() => ({})).read,
    ghTextAsyncImpl: (args) => {
      writes.push(args);
      return new Promise((resolve) => setTimeout(() => {
        order.push("write-settled");
        resolve('{"merged":true}');
      }, 5));
    },
  });
  const merged = withLiveWritesAllowed(() => idle.mergeDirect(PR_URL));
  assert.ok(merged instanceof Promise, "the direct merge returns a promise the arm awaits");
  await merged;
  order.push("merge-returned");
  assert.deepEqual(writes, [[
    "api", "--method", "PUT", `${PULLS}/merge`, "-f", "merge_method=squash", "-f", `sha=${HEAD}`,
  ]], "one REST merge write, pinned to the head the sweep observed");
  assert.deepEqual(order, ["write-settled", "merge-returned"], "the merge returns only once the write has settled");
  assert.deepEqual(trapped, [], "the direct merge made no synchronous spawn");
});

test("W1-T7747: the armed-idle head and merge-queue reads await the async transport with sync spawns trapped", async (t) => {
  const trapped = trapSyncSpawns(t);
  let liveHead = HEAD;
  const rest = asyncReader((args) => {
    if (args[1] === PULLS) return { state: "open", auto_merge: {}, head: { sha: liveHead }, base: { ref: "main" } };
    if (args[1] === `repos/${OWNER}/${REPO}/rules/branches/main`) return [{ type: "merge_queue" }];
    throw new Error(`unexpected read ${args.join(" ")}`);
  });
  const idle = await armedIdleDeps(t, { ghJsonAsyncImpl: rest.read });

  const head = idle.headSha(PR_URL);
  assert.ok(head instanceof Promise, "the head read is awaited");
  assert.equal(await head, HEAD);
  const queue = idle.mergeQueue!(PR_URL);
  assert.ok(queue instanceof Promise, "the merge-queue read is awaited");
  assert.equal(await queue, true, "a merge_queue rule on the base branch reads as a queue");

  // The decline the sync override made is kept: a moved head is no longer the armed-idle PR.
  liveHead = MOVED;
  await assert.rejects(Promise.resolve(idle.headSha(PR_URL)), /no longer open and armed at the observed head/);

  // The effect-level queue read the refresh lanes ask is the same awaited read.
  const { effects } = harness(t, { ghJsonAsyncImpl: rest.read });
  const effectQueue = effects.mergeQueue!(PR_URL);
  assert.ok(effectQueue instanceof Promise);
  assert.equal(await effectQueue, true);

  assert.ok(rest.settled.includes(`api ${PULLS}`), "the reads went through the injected async transport");
  assert.ok(rest.settled.includes(`api repos/${OWNER}/${REPO}/rules/branches/main`));
  assert.deepEqual(trapped, [], "no head or queue read made a synchronous spawn");
});

test("W1-T7747: the sweep effects reach gh for plan-gate, fix dispatch, stack prerequisite and ratchet head with sync spawns trapped", async (t) => {
  const trapped = trapSyncSpawns(t);
  const rest = asyncReader((args) => {
    const [verb, path] = args;
    if (verb === "api" && path === PULLS) {
      // a filing whose head moved: the plan-gate round refuses before any worktree is cut
      return { head: { ref: "garden/plan-7747", sha: MOVED }, user: { login: "someone" }, title: "t", body: "" };
    }
    if (verb === "api" && path === `repos/${OWNER}/${REPO}/pulls/7700`) return { state: "closed", merged_at: "2026-10-10T00:00:00Z" };
    if (verb === "pr" && args.includes("headRefName,headRefOid,body")) {
      return { headRefName: "run-W1-T7747-1", headRefOid: MOVED, body: "" };
    }
    if (verb === "pr" && args.includes("headRefName,headRefOid,body,files")) throw new Error("W1-T7747 fixture: head read reached");
    throw new Error(`unexpected read ${args.join(" ")}`);
  });
  const { effects, logs } = harness(t, {
    ghJsonAsyncImpl: rest.read,
    dispatchFixPreflightStandDownImpl: async () => undefined,
    ghLiveStateImpl: async () => ({ state: "OPEN" }),
  });

  // plan-gate round: the live filing read is awaited and its refusal is unchanged
  const round = await effects.dispatchPlanGateRound!(view());
  assert.deepEqual(round, { outcome: "refused", reason: "the filing head or author changed" });

  // fix dispatch: the head lookup goes through the async transport
  await assert.rejects(Promise.resolve(effects.dispatchFix!(view({ checksState: "red" }), undefined as never, undefined)),
    /W1-T7747 fixture: head read reached/);
  assert.ok(rest.calls.some((args) => args.includes("headRefName,headRefOid,body,files")));

  // stack prerequisite: a declared parent is read through the async transport
  const stack = effects.stackPrerequisite!(view({ body: "Stacked on #7700" }));
  assert.ok(stack instanceof Promise, "a parent read is awaited");
  assert.deepEqual(await stack, { state: "ready", parentNumbers: [7700] });
  // a listed unstacked body still answers with no read at all
  assert.deepEqual(effects.stackPrerequisite!(view({ body: "No stack." })), { state: "unstacked", parentNumbers: [] });

  // ratchet repair: the live head re-read is awaited, so a moved head is a decline, not unreadable
  assert.equal(await effects.repairRecordableRatchet!(view(), ["comment-load-ratchet"]), false);
  const declined = logs.find((l) => l.step === "sweep.ratchet_repair_executor_declined");
  assert.equal(declined?.fields.reason, "live_head_changed");
  assert.equal(declined?.fields.observed_head_sha, MOVED);

  assert.deepEqual(trapped, [], "none of the four effects made a synchronous spawn");
});

test("W1-T7747: buildSweepEffects makes no direct sync gh call outside the seam-passing sites", () => {
  const source = readFileSync(new URL("../src/lib/sweep.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function buildSweepEffects(");
  assert.ok(start >= 0, "buildSweepEffects is declared in src/lib/sweep.ts");
  const end = source.indexOf("\n}\n", start);
  const code = source.slice(start, end).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line));

  // the synchronous transport and the synchronous arm helpers, called in an effect body
  const direct = /\bghExec\(|\bghJson\(|\bmergeDirectViaRest\(|\bbaseBranchRequiresMergeQueue\(|\bstackPrerequisiteFromRest\(|\breadArmHeadShaRest\(/;
  assert.deepEqual(code.filter((line) => direct.test(line)).map((line) => line.trim()), []);

  // `ghJsonForBuild` survives only where it is handed as a seam to a sync callee in another module
  // (group 3 of the task record, deferred: each needs its callee made async)
  const seam = [
    /readJson: ghJsonForBuild,/,
    /probeExistingPlanPr\(ghJsonForBuild,/,
    /createPlanPrRest\(ghJsonForBuild,/,
    /readJson: \(args\) => paceGhEntry\(pacer, isGhRateLimitError, \(\) => ghJsonForBuild\(args\)\)/,
  ];
  const uses = code.filter((line) => /\bghJsonForBuild\b/.test(line) && !/ghJsonImpl: ghJsonForBuild = ghJson/.test(line));
  assert.deepEqual(uses.filter((line) => !seam.some((s) => s.test(line))).map((line) => line.trim()), [],
    "every remaining ghJsonForBuild is a seam handed to another module");
  assert.equal(uses.length, 6, "the six deferred seam-passing sites, and no more");
});

test("W1-T7747: mergeDirectViaRestAsync refuses a sentinel GH_TOKEN like the sync transport", async () => {
  assert.equal(process.env.GH_TOKEN, LIVE_WRITE_SENTINEL_TOKEN, "the shared setup installs the sentinel");
  const refusal = (e: unknown): boolean => {
    assert.ok(e instanceof LiveWriteBlockedError, `must be LiveWriteBlockedError, got ${String(e)}`);
    assert.equal(e.boundary, "gh-transport");
    assert.match(e.message, /W1-T4805/);
    assert.match(e.message, new RegExp(`gh api --method PUT ${PULLS}/merge`), "the refusal names the merge write");
    return true;
  };
  // PATH resolves no stub gh, so the only gh a spawn could reach is a real one
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-w1-t7747";
  try {
    assert.throws(() => ghExec(["api", "--method", "PUT", `${PULLS}/merge`], { encoding: "utf8" }), refusal);
    await assert.rejects(mergeDirectViaRestAsync(PR_URL), refusal);
  } finally {
    process.env.PATH = originalPath;
  }
});
