import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  armAutoMergeAtOpen,
  armAutoMergeAtOpenAsync,
  armAutoMergeDetailed,
  armAutoMergeDetailedAsync,
  armIfVerdictPermits,
  armIfVerdictPermitsAsync,
  attemptArm,
  logArmAttribution,
  realArmDeps,
  realArmDepsAsync,
  type ArmDeps,
  type ArmLane,
} from "#src/lib/arm-auto-merge.js";
import type { loadConfig } from "#src/lib/config.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { withGhShim } from "#test/helpers/gh-shim.js";

// W1-T13698. A shadow instance arms and merges nothing on ANY lane. The refusal lives at the arm's own choke point
// (`armAutoMergeDetailed` / `attemptArm`), keyed on the running instance's registry, so the review lane's post-verdict
// arm is refused like the sweep's, and so is every caller of `armAndLogOutcome` and every direct merge behind it.

const HEAD_SHA = "13698aaabbbbccccddddeeeeffff000011112222";
const PR_URL = "https://github.com/acme/remudero/pull/13698";
const TASK_ID = "W1-T13698";
const PASS = { state: "success", capped: false, planOnly: false } as const;
const CLEAN_STATUS = { stderr: "GraphQL: Pull request is in clean status" };

type Row = [string, Record<string, unknown>];

const registry = (repo: string, mode: string | undefined) =>
  ["instances:", "  worker:", `    github_repo: ${repo}`, ...(mode === undefined ? [] : [`    mode: ${mode}`]), ""].join("\n");

/** A root whose `.remudero/daemon-instances.yaml` is `body` (none when undefined), and a config reader pointing at it. */
async function withRegistry<T>(body: string | undefined, run: (cfg: typeof loadConfig) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13698-registry-`));
  try {
    if (body !== undefined) {
      mkdirSync(join(root, ".remudero"), { recursive: true });
      writeFileSync(join(root, ".remudero", "daemon-instances.yaml"), body);
    }
    return await run((() => ({ root })) as unknown as typeof loadConfig);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Fake arm deps: every call is recorded by name, and a PASS review sits in the ledger for this head. */
function spyDeps(shadow: boolean | undefined, overrides: Partial<ArmDeps> = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const deps: ArmDeps = {
    headSha: () => (calls.push("headSha"), HEAD_SHA),
    ledgerLines: () => (calls.push("ledgerLines"), [{ step: "review.posted", task_id: TASK_ID, head_sha: HEAD_SHA, pr_url: PR_URL, state: "success" }]),
    armAuto: () => void calls.push("armAuto"),
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => void calls.push("disableAuto"),
    isMerged: () => (calls.push("isMerged"), false),
    stackPrerequisite: () => (calls.push("stackPrerequisite"), { state: "unstacked", parentNumbers: [] }),
    closingReferences: () => (calls.push("closingReferences"), { state: "clean", defused: [] }),
    contributorAdmission: () => void calls.push("contributorAdmission"),
    say: (message) => void said.push(message),
    ...(shadow === undefined ? {} : { shadowInstance: () => shadow }),
    ...overrides,
  };
  return { deps, calls, said };
}

function ctxFor(rows: Row[], repoMode?: "shadow" | "live") {
  return {
    prUrl: PR_URL,
    taskId: TASK_ID,
    headSha: HEAD_SHA,
    ledgerPath: "/nonexistent/ledger.ndjson",
    log: (step: string, extra: Record<string, unknown> = {}) => void rows.push([step, extra]),
    ...(repoMode === undefined ? {} : { repoMode }),
  };
}

test("W1-T13698 criterion 1: with the registry mode shadow a review-lane PASS reaches armAutoMergeDetailed, which refuses with zero gh calls and ledgers automerge.shadow_refused naming the PR and the lane", async () => {
  await withRegistry(registry("acme/remudero", "shadow"), (cfg) => withGhShim([], async (shim) => {
    const rows: Row[] = [];
    // The review lane's context carries NO repoMode: the refusal comes from the arm's own registry read.
    const outcome = await armIfVerdictPermitsAsync(PASS, ctxFor(rows), {
      arm: (prUrl, taskId) => armAutoMergeDetailedAsync(prUrl, taskId, realArmDepsAsync(cfg)),
    });
    assert.equal(outcome, "shadow-refused");
    assert.deepEqual(shim.calls(), [], "no gh call of any kind: no head read, no --auto arm, no direct merge");
    const refused = rows.filter(([step]) => step === "automerge.shadow_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.[1].pr_url, PR_URL);
    assert.equal(refused[0]?.[1].lane, "review");
    assert.equal(refused[0]?.[1].task_id, TASK_ID);
    assert.ok(rows.some(([step, extra]) => step === "automerge.arm_skipped" && extra.outcome === "shadow-refused"));
    assert.ok(!rows.some(([step]) => step === "automerge.armed" || step === "automerge.arm_failed"));
  }));
});

test("W1-T13698 criterion 1: the synchronous review arm over the real deps is refused the same way, with zero gh calls", async () => {
  await withRegistry(registry("acme/remudero", "shadow"), (cfg) => withGhShim([], async (shim) => {
    const rows: Row[] = [];
    const outcome = armIfVerdictPermits(PASS, ctxFor(rows), {
      arm: (prUrl, taskId) => armAutoMergeDetailed(prUrl, taskId, realArmDeps(cfg)),
    });
    assert.equal(outcome, "shadow-refused");
    assert.deepEqual(shim.calls(), []);
    assert.equal(rows.filter(([step]) => step === "automerge.shadow_refused").length, 1);
  }));
});

test("W1-T13698 criterion 1: a review context that already names repoMode shadow is refused before any effector, once", async () => {
  const rows: Row[] = [];
  const calls: string[] = [];
  const outcome = await armIfVerdictPermitsAsync(PASS, ctxFor(rows, "shadow"), {
    arm: (prUrl) => (calls.push(prUrl), "armed" as const),
  });
  assert.equal(outcome, "shadow-refused");
  assert.deepEqual(calls, []);
  const refused = rows.filter(([step]) => step === "automerge.shadow_refused");
  assert.equal(refused.length, 1, "one row, not one from the context and one from the attribution");
  assert.equal(refused[0]?.[1].lane, "review");
  assert.equal(armIfVerdictPermits(PASS, ctxFor([], "shadow"), { arm: (prUrl) => (calls.push(prUrl), "armed" as const) }), "shadow-refused");
  assert.deepEqual(calls, []);
});

test("W1-T13698 criterion 1: only the declared repository's shadow row refuses — a foreign shadow row, a live row and an absent registry do not", async () => {
  for (const [body, shadow] of [
    [registry("acme/remudero", "shadow"), true],
    [registry("ACME/Remudero", "shadow"), true],
    [registry("acme/remudero", "live"), false],
    [registry("acme/remudero", undefined), false],
    [registry("acme/other", "shadow"), false],
    ["instances:\n  worker:\n    github_repo: acme/remudero\n    mode: bogus\n", false],
    [undefined, false],
  ] as const) {
    await withRegistry(body, async (cfg) => {
      assert.equal(await realArmDepsAsync(cfg).shadowInstance?.(PR_URL), shadow, JSON.stringify(body));
    });
  }
});

test("W1-T13698 criterion 2: every arm entry point refuses a shadow instance before its first read or write", async () => {
  const entries: Array<[string, (deps: ArmDeps) => unknown]> = [
    ["armAutoMergeDetailed", (deps) => armAutoMergeDetailed(PR_URL, TASK_ID, deps)],
    ["armAutoMergeDetailedAsync", (deps) => armAutoMergeDetailedAsync(PR_URL, TASK_ID, deps)],
    ["attemptArm", (deps) => attemptArm(PR_URL, deps)],
    ["armAutoMergeAtOpen", (deps) => armAutoMergeAtOpen(PR_URL, deps)],
    ["armAutoMergeAtOpenAsync", (deps) => armAutoMergeAtOpenAsync(PR_URL, deps)],
  ];
  for (const [name, enter] of entries) {
    const { deps, calls, said } = spyDeps(true);
    const result = (await enter(deps)) as { outcome?: string } | string;
    assert.equal(typeof result === "string" ? result : result.outcome, "shadow-refused", name);
    assert.deepEqual(calls, [], `${name}: no gh read, ledger read or write`);
    assert.ok(said.some((line) => line.startsWith("automerge.shadow_refused")), `${name} says why`);
  }
});

test("W1-T13698 criterion 2: every caller of armAndLogOutcome — operator, review, plan, approve, triage, retro and sweep — ledgers the refusal with its lane", async () => {
  // armAndLogOutcome is `logArmAttribution(arm(prUrl, taskId))`; plan, approve, triage and retro all arm as lane operator.
  for (const lane of ["operator", "review", "sweep"] as const satisfies readonly ArmLane[]) {
    const { deps, calls } = spyDeps(true);
    const result = armAutoMergeDetailed(PR_URL, TASK_ID, deps);
    const rows: Row[] = [];
    logArmAttribution((step, extra = {}) => void rows.push([step, extra]), result.outcome, PR_URL, TASK_ID, lane, { outcome: result.outcome, head_sha: HEAD_SHA });
    assert.deepEqual(calls, [], lane);
    assert.deepEqual(rows.map(([step]) => step), ["automerge.shadow_refused", "automerge.arm_skipped"], lane);
    assert.equal(rows[0]?.[1].lane, lane);
    assert.equal(rows[0]?.[1].pr_url, PR_URL);
    assert.equal(rows[0]?.[1].pr_number, 13698);
    assert.equal(rows[1]?.[1].outcome, "shadow-refused");
  }
});

test("W1-T13698 criterion 2: the direct merge behind a ratchet-judge decision is never reached — not the judge, the quota fallback or the clean-status merge", async () => {
  const clean = { verdict: "clean", rows: [], counted: [], uncounted: [] } as const;
  const wiring = (armAuto: ArmDeps["armAuto"], calls: string[]): Partial<ArmDeps> => ({
    armAuto,
    readMergedRatchets: () => (calls.push("readMergedRatchets"), clean),
  });
  for (const failure of [CLEAN_STATUS, { stderr: "API rate limit exceeded for user ID 1" }]) {
    const shadowRun = spyDeps(true);
    const refused = armAutoMergeDetailed(PR_URL, TASK_ID, {
      ...shadowRun.deps,
      ...wiring(() => { shadowRun.calls.push("armAuto"); throw failure; }, shadowRun.calls),
      // The preflight's own reads and the update-branch remedy are spied too: none may run under shadow.
      readMergeFacts: () => (shadowRun.calls.push("readMergeFacts"), { mergeable: "MERGEABLE" as const }),
      updateBranch: () => (shadowRun.calls.push("updateBranch"), { ok: true }),
    });
    assert.equal(refused.outcome, "shadow-refused", JSON.stringify(failure));
    assert.deepEqual(shadowRun.calls, [], "neither the judge, the arm, the preflight nor the merge ran");
  }
  // POSITIVE CONTROL: the identical wiring on a live instance does arm, fail clean-status, judge and merge directly.
  for (const live of [false, undefined]) {
    const liveRun = spyDeps(live);
    const merged = armAutoMergeDetailed(PR_URL, TASK_ID, {
      ...liveRun.deps,
      ...wiring(() => { liveRun.calls.push("armAuto"); throw CLEAN_STATUS; }, liveRun.calls),
    });
    assert.equal(merged.outcome, "direct-merged");
    assert.ok(liveRun.calls.includes("readMergedRatchets") && liveRun.calls.includes("armAuto") && liveRun.calls.includes("mergeDirect"), liveRun.calls.join(","));
  }
});

test("W1-T13698 criterion 2: a queue branch's arm and enqueue are refused too", () => {
  const { deps, calls } = spyDeps(true, { mergeQueue: () => (calls.push("mergeQueue"), true), enqueue: () => void calls.push("enqueue") });
  assert.equal(armAutoMergeDetailed(PR_URL, TASK_ID, deps).outcome, "shadow-refused");
  assert.deepEqual(calls, []);
});

test("W1-T13698 criterion 3: with mode live or absent every lane arms exactly as before — same calls, same ledger rows", async () => {
  const armedRows = async (shadow: boolean | undefined, repoMode?: "shadow" | "live") => {
    const { deps, calls } = spyDeps(shadow);
    const rows: Row[] = [];
    const outcome = await armIfVerdictPermitsAsync(PASS, ctxFor(rows, repoMode), {
      arm: (prUrl, taskId) => armAutoMergeDetailed(prUrl, taskId, deps),
    });
    return { outcome, calls, steps: rows.map(([step, extra]) => [step, extra.outcome, extra.lane]) };
  };
  const baseline = await armedRows(undefined);
  assert.equal(baseline.outcome, "armed");
  assert.deepEqual(baseline.calls.filter((name) => name === "armAuto" || name === "mergeDirect"), ["armAuto"]);
  assert.deepEqual(baseline.steps, [["automerge.armed", "armed", "review"]]);
  for (const [shadow, repoMode] of [[false, undefined], [undefined, "live"], [false, "live"]] as const) {
    assert.deepEqual(await armedRows(shadow, repoMode), baseline, `shadowInstance ${String(shadow)} / repoMode ${String(repoMode)}`);
  }
});

test("W1-T13698 criterion 3: a live, mode-less, foreign-shadow or absent registry leaves the real mode read live — the arm effector runs and no shadow row is written", async () => {
  for (const body of [registry("acme/remudero", "live"), registry("acme/remudero", undefined), registry("acme/other", "shadow"), undefined]) {
    await withRegistry(body, async (cfg) => {
      const { deps, calls } = spyDeps(undefined);
      // The real deps' own registry read, with only the gh effectors swapped for spies.
      const realMode = realArmDepsAsync(cfg).shadowInstance;
      const rows: Row[] = [];
      const outcome = await armIfVerdictPermitsAsync(PASS, ctxFor(rows), {
        arm: (prUrl, taskId) => armAutoMergeDetailedAsync(prUrl, taskId, { ...deps, ...(realMode === undefined ? {} : { shadowInstance: realMode }) }),
      });
      assert.equal(outcome, "armed", JSON.stringify(body));
      assert.ok(calls.includes("armAuto"), JSON.stringify(body));
      assert.ok(!rows.some(([step]) => step === "automerge.shadow_refused"), JSON.stringify(body));
    });
  }
});

test("W1-T13698 criterion 3: a seam that cannot read the instance mode is read as live and says so, never as shadow", async () => {
  const { deps, calls, said } = spyDeps(undefined, { shadowInstance: () => { throw new Error("registry unreadable"); } });
  const result = armAutoMergeDetailed(PR_URL, TASK_ID, deps);
  assert.equal(result.outcome, "armed");
  assert.ok(calls.includes("armAuto"));
  assert.ok(said.some((line) => line.startsWith("automerge.shadow_mode_unreadable") && line.includes("registry unreadable")));
});
