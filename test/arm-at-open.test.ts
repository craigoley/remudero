import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  armAutoMerge,
  armAutoMergeAtOpen,
  disarmAutoMerge,
  realArmDeps,
  runTask,
  type ArmDeps,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import { decideAutoMergeArm, judgeReview } from "../src/lib/review.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── W1-T125: move auto-merge arming from "after review" to "at PR creation".
//
// This file proves three distinct things, independently:
//   (A) the two new primitives (`armAutoMergeAtOpen`, `disarmAutoMerge`) behave
//       correctly in isolation (deps-injected, no real gh/network) — mirrors
//       test/run-task.test.ts's existing `armAutoMerge` unit-test style.
//   (B) a REAL `runTask()` run arms the instant its PR opens, structurally
//       before any CI poll — the acceptance-criteria proof.
//   (C) the capped-verdict safety mitigation (`disarmAutoMerge` called before
//       escalating a CAPPED verdict) is wired into runTask's own capped-refusal
//       branch. See the comment on that test for why this is proven at
//       SOURCE level rather than by driving a real runTask() through the
//       review gate — deliberately, not by omission.

// ── (A) UNIT TESTS — deps-injected, mirrors test/run-task.test.ts's armDeps() ──

function armDeps(over: Partial<ArmDeps> = {}): ArmDeps & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    headSha: () => "abc1234",
    ledgerLines: () => [
      { step: "review.posted", task_id: "W1-TX", state: "success", head_sha: "abc1234", proof_exec: ["executed_pass"] },
    ],
    armAuto: () => {},
    mergeDirect: () => {},
    disableAuto: () => {},
    say: (m) => { said.push(m); },
    ...over,
  };
}

const cleanStatusErr = () => {
  const e = new Error("gh failed") as Error & { stderr: string };
  e.stderr = "X Pull request #591 is in clean status; auto-merge cannot be enabled";
  return e;
};

test(
  "armAutoMergeAtOpen: happy path arms immediately with ONLY {armAuto, mergeDirect, say} — no " +
    "ledgerLines/headSha dep at all, proving it has NO prior-verdict prerequisite (unlike armAutoMerge, " +
    "which is gated by the W1-T230 ledger check)",
  () => {
    const said: string[] = [];
    const merged: string[] = [];
    let armedUrl: string | undefined;
    const outcome = armAutoMergeAtOpen("url/open-1", {
      armAuto: (u) => { armedUrl = u; },
      mergeDirect: (u) => { merged.push(u); },
      say: (m) => { said.push(m); },
    });
    assert.equal(outcome, "armed");
    assert.equal(armedUrl, "url/open-1");
    assert.deepEqual(merged, [], "the happy arm path never touches the direct-merge fallback");
  },
);

test(
  "armAutoMergeAtOpen: a clean-status refusal COMPLETES as a direct merge — shares armAutoMerge's " +
    "exact fallback (attemptArm), not a reimplementation",
  () => {
    const merged: string[] = [];
    const said: string[] = [];
    const outcome = armAutoMergeAtOpen("url/open-2", {
      armAuto: () => { throw cleanStatusErr(); },
      mergeDirect: (u) => { merged.push(u); },
      say: (m) => { said.push(m); },
    });
    assert.equal(outcome, "direct-merged");
    assert.deepEqual(merged, ["url/open-2"]);
    assert.ok(said.some((m) => m.includes("clean_status_direct_merge")));
  },
);

test(
  "armAutoMergeAtOpen: a transient arm failure stays arm-error-ignored — no direct merge attempted",
  () => {
    const merged: string[] = [];
    const outcome = armAutoMergeAtOpen("url/open-3", {
      armAuto: () => { throw new Error("connect ETIMEDOUT api.github.com"); },
      mergeDirect: (u) => { merged.push(u); },
      say: () => {},
    });
    assert.equal(outcome, "arm-error-ignored");
    assert.deepEqual(merged, []);
  },
);

test("disarmAutoMerge: happy path calls deps.disableAuto with the prUrl, says automerge.disarmed, never throws", () => {
  const said: string[] = [];
  let disabledUrl: string | undefined;
  assert.doesNotThrow(() =>
    disarmAutoMerge("url/disarm-1", {
      disableAuto: (u) => { disabledUrl = u; },
      say: (m) => { said.push(m); },
    }),
  );
  assert.equal(disabledUrl, "url/disarm-1");
  assert.ok(said.some((m) => m.includes("automerge.disarmed") && m.includes("url/disarm-1")));
});

test(
  "disarmAutoMerge: deps.disableAuto throwing is SWALLOWED — says an automerge.disarm_failed message " +
    "naming the error, never throws (best-effort, matches armAutoMerge's own never-silent-never-fatal idiom)",
  () => {
    const said: string[] = [];
    assert.doesNotThrow(() =>
      disarmAutoMerge("url/disarm-2", {
        disableAuto: () => { throw new Error("gh: PR already closed"); },
        say: (m) => { said.push(m); },
      }),
    );
    assert.ok(said.some((m) => m.includes("automerge.disarm_failed") && m.includes("gh: PR already closed")));
  },
);

test("realArmDeps: disableAuto (W1-T125) reaches gh pr merge <url> --disable-auto — a PATH-stubbed gh, no throw", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-disarm-stub-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const d = realArmDeps();
    assert.doesNotThrow(() => d.disableAuto("url/x"), "disableAuto reaches gh pr merge --disable-auto");
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

// ── (B) INTEGRATION — the REAL runTask(), mirroring test/run-task.test.ts's ──
// W1-T105 followupGitFixture/followupFakeGh pattern: a real throwaway bare
// "origin", a fake gh on PATH, an injected spawn for recon+implement. CI is
// answered RED on the very first poll so the run reaches its terminal verdict
// fast, with zero sleeps and — crucially — WITHOUT ever reaching the review
// gate (no reviewer spawn, no gh call complexity beyond what's stubbed below).

const ARM_OPEN_FIXTURE_PLAN = [
  "- id: T-ARM-OPEN",
  "  title: arm-at-open wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const ARM_OPEN_OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const armOpenHoldingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const armOpenCleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

function armOpenGitFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "arm-open-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "arm-open-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "arm-open-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "arm-open-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "arm-open-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "arm-open-test"]);
  return { repoDir };
}

/** A fake `gh` answering ownership/trailer/CI (RED, first poll) exactly like
 *  test/run-task.test.ts's followupFakeGh — PLUS `pr merge --auto`/`--disable-auto`,
 *  each recording an ordered line to `callLogPath` so a test can assert WHEN the
 *  arm happened relative to the CI poll (criterion 1/4: "at creation", not
 *  "eventually"). */
function armOpenFakeGh(branch: string, callLogPath: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "arm-open-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      `CALLLOG="${callLogPath}"`,
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then",
      "    echo 'poll' >> \"$CALLLOG\"",
      "    echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'",
      "    exit 0",
      "  fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'merge' ]]; then",
      "  if [[ \"$4\" == '--auto' ]]; then echo \"arm $3\" >> \"$CALLLOG\"; exit 0; fi",
      "  if [[ \"$4\" == '--disable-auto' ]]; then echo \"disarm $3\" >> \"$CALLLOG\"; exit 0; fi",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test(
  "ACCEPTANCE (W1-T125 criteria 1+4): a real runTask run arms auto-merge the INSTANT its PR opens — " +
    "the fake-gh call log proves `pr merge --auto` fires BEFORE the first CI poll (\"at creation\", not " +
    "\"eventually\"), and the ledger's pr.opened line is IMMEDIATELY followed by automerge.armed with ZERO " +
    "polling iterations in between (the structural \"delta ~0\" regression fixture — deterministic, not " +
    "wall-clock)",
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "arm-open-root-"));
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, ARM_OPEN_FIXTURE_PLAN);
    const config: Config = { claudeBin: "/bin/true", root };

    armOpenGitFixture(root);

    const FIXED_TS = 1785100000000;
    const branch = `run-T-ARM-OPEN-${FIXED_TS}`;
    const callLogPath = join(root, "gh-calls.log");
    writeFileSync(callLogPath, "");
    const fakeBinDir = armOpenFakeGh(branch, callLogPath);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${savedPath}`;
    const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

    const spawnCalls: SpawnWorkerArgs[] = [];
    const spawn: typeof spawnWorker = async (args) => {
      spawnCalls.push(args);
      if (spawnCalls.length === 1) {
        return result({ sessionId: "s-recon", text: "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" });
      }
      // Implement worker declares its OWN PR_URL — `gh pr create` is never reached,
      // same convention test/run-task.test.ts's W1-T105 fixture uses.
      return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/42\n" });
    };

    try {
      const res = await runTask("T-ARM-OPEN", {
        skipGitSync: true,
        planPath,
        config,
        github: ARM_OPEN_OFFLINE_GITHUB,
        spawn,
        containmentExec: armOpenHoldingContainmentExec,
        isolationExec: armOpenCleanIsolationExec,
      });

      // ── CRITERION 3 falsifier, same run: CI never went green (red on the very
      // first poll) — the PR must NOT merge. Early arming registering intent is
      // provably NOT the same as GitHub actually merging: the required-status
      // contract still gates the merge, exactly as it did before this task.
      assert.equal(res.verdict, "blocked_ci", "a red PR is unchanged and does NOT merge — the falsifier for criterion 3");
      assert.equal(res.merged, false);
      assert.equal(spawnCalls.length, 2, "exactly recon then implement — no resume, no review spawn reached");

      // ── CRITERION 1+4: the ledger's own structural order.
      const ledger = readLedger(root);
      const openedIdx = ledger.findIndex((l) => l.step === "pr.opened");
      assert.ok(openedIdx >= 0, "pr.opened must be ledgered");
      assert.equal(ledger[openedIdx + 1]?.step, "automerge.armed", "automerge.armed is the VERY NEXT ledger line after pr.opened");
      assert.equal(ledger[openedIdx + 1]?.at, "open");
      assert.equal(ledger[openedIdx + 1]?.outcome, "armed");
      assert.ok(
        !ledger.slice(0, openedIdx + 2).some((l) => l.step === "ci.polling" || l.step === "pr.polling"),
        "zero polling iterations occur between PR creation and the arm — the delta is structurally ~0, not merely fast",
      );

      // ── CRITERION 1: the fake-gh call log proves the arm reached `gh` itself
      // BEFORE the first `statusCheckRollup` poll — "at creation", not "eventually".
      const calls = readFileSync(callLogPath, "utf8").split("\n").filter(Boolean);
      const armIdx = calls.findIndex((l) => l.startsWith("arm "));
      const pollIdx = calls.findIndex((l) => l === "poll");
      assert.ok(armIdx >= 0, "the fake-gh call log recorded the `pr merge --auto` call");
      assert.ok(pollIdx >= 0, "the fake-gh call log recorded the statusCheckRollup poll");
      assert.ok(armIdx < pollIdx, "the arm call precedes the first CI poll in gh's own call order");
    } finally {
      dateNowSpy.mock.restore();
      process.env.PATH = savedPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// ── (C) THE CAPPED-VERDICT SAFETY MITIGATION ────────────────────────────────
//
// Design point (iv) of this task requires: "arming earlier must never merge
// anything the gate would have refused." The one shape early arming reopens
// (see the design note above `armAutoMergeAtOpen`) is a CAPPED verdict that
// still posts `remudero-review: success` — `decideAutoMergeArm` refuses to
// ARM on that shape, but by the time review runs the PR was ALREADY armed at
// open. `runTask`'s capped-refusal branch closes this by calling
// `disarmAutoMerge(prUrl)` immediately before escalating.
//
// Proving this end-to-end would require driving the REAL runTask() through
// the review gate, which spawns a REAL advisory reviewer via `spawnWorker` —
// and `spawnWorker`'s `resolveClaudeExecutable` resolves a REAL `claude`
// binary via PATH/env lookup, INDEPENDENT of `config.claudeBin` (verified by
// reading src/lib/worker.ts's `resolveClaudeExecutable`: it never consults
// `config` at all). On darwin it additionally provisions the REAL login
// Keychain before ever reaching the SDK spawn (`ensureWorkerKeychain`, guarded
// in test/worker.test.ts's OWN unit tests only via injected keychain/toolchain
// seams that `runReview`'s call site does not expose). Neither is something a
// runTask()-level test can safely stub without either spawning a live nested
// agent process or touching real OS keychain state — so, per this task's own
// documented fallback, the mechanism is proven at the two seams that actually
// compose it, each independently real:
//   (i)  `judgeReview`+`decideAutoMergeArm` (both real, no spawn) really do
//        produce a CAPPED, state:"success", planOnly:false verdict that
//        decideAutoMergeArm refuses to arm, for the exact known-good
//        keyword-floor-pass fixture this repo already uses (test/review.test.ts
///       ~1474, ~164-175: `{ claim: "the widget is frobnicated", proof: "the
//        widget frobnicates on load" }").
//   (ii) `disarmAutoMerge` itself is fully covered above (group A) — it is the
//        ONLY new code this mitigation adds.
//   (iii) a SOURCE-level reachability proof (the same technique this file's
//        neighbor test "runFixRung is REUSED..." already uses) that runTask's
//        capped-refusal branch calls `disarmAutoMerge(prUrl)` BEFORE
//        `escalate(...)`, not after and not on some other branch.

test(
  "MECHANISM (i): the real judgeReview + decideAutoMergeArm produce a CAPPED, state:success, " +
    "planOnly:false verdict that decideAutoMergeArm REFUSES to arm — the exact shape runTask's " +
    "capped-refusal branch (and its disarmAutoMerge call) exists to handle",
  () => {
    const criteria: AcceptanceCriterion[] = [{ claim: "the widget is frobnicated", proof: "the widget frobnicates on load" }];
    // A diff touching a non-plan source file, so `planOnly` is false — a planOnly
    // verdict arms UNCONDITIONALLY even when capped (decideAutoMergeArm, the
    // W1-T205 carve-out), so planOnly:false is what actually exercises the
    // capped-refusal branch this mitigation protects.
    const diff = ["--- a/src/lib/widget.ts", "+++ b/src/lib/widget.ts", "+export function frobnicate() {}"].join("\n");
    const verdict = judgeReview(criteria, {
      diff,
      report: "the widget frobnicates on load", // pure prose, keyword-floor MET, never executed
      // no headCheckoutDir/execProof at all ⇒ every criterion is not_executable ⇒ executedCount === 0.
    });
    assert.equal(verdict.state, "success", verdict.summary);
    assert.equal(verdict.capped, true, "zero of the one executable criterion actually executed ⇒ capped");
    assert.equal(verdict.planOnly, false, "a non-plan-scope diff must not exempt this from the capped-refusal check");

    const decision = decideAutoMergeArm(verdict, false, undefined);
    assert.equal(decision.arm, false, "capped + non-planOnly + no override ⇒ decideAutoMergeArm refuses — exactly runTask's capped-refusal branch");
  },
);

test(
  "MECHANISM (iii): runTask's capped-refusal branch calls disarmAutoMerge(prUrl) BEFORE escalate(...) " +
    "— source-level reachability proof (same technique as the neighboring 'runFixRung is REUSED' test " +
    "in test/run-task.test.ts) that early arming is withdrawn before the human escalation, never after",
  () => {
    const disarmIdx = runTaskSrc.indexOf("disarmAutoMerge(prUrl);");
    assert.ok(disarmIdx >= 0, "disarmAutoMerge(prUrl) must be called somewhere in run-task.ts");
    const nextEscalateIdx = runTaskSrc.indexOf("escalate(", disarmIdx);
    assert.ok(nextEscalateIdx >= 0, "an escalate( call must follow the disarm");
    assert.ok(
      nextEscalateIdx - disarmIdx < 300,
      "the escalate( call immediately following disarmAutoMerge must be the SAME capped-refusal branch's own call, not some unrelated one elsewhere in the file",
    );
    assert.match(
      runTaskSrc.slice(disarmIdx, nextEscalateIdx),
      /log\("automerge\.disarmed", \{ reason: "capped verdict refused auto-merge" \}\)/,
      "the disarm is ledgered with an attributable reason, matching this file's never-silent idiom",
    );
    // And the disarm site is textually INSIDE the `if (!armDecision.arm)` capped-
    // refusal branch, not the OLD post-review arm site this task removes.
    const armDecisionIdx = runTaskSrc.indexOf("if (!armDecision.arm) {");
    assert.ok(armDecisionIdx >= 0 && armDecisionIdx < disarmIdx, "disarmAutoMerge must sit inside the capped-refusal (!armDecision.arm) branch");
  },
);

test(
  "WIRING (W1-T125 design point ii): the OLD post-review arm call site no longer calls armAutoMerge — " +
    "arming already happened at PR-open; this site only polls to the gate now",
  () => {
    const pollIdx = runTaskSrc.indexOf("const outcome = await pollToGate(prUrl,");
    assert.ok(pollIdx >= 0, "pollToGate must still be called");
    // The 400 chars immediately BEFORE the poll call must contain no armAutoMerge(
    // call — the primary arm now happens at PR-open, not here.
    const before = runTaskSrc.slice(Math.max(0, pollIdx - 400), pollIdx);
    assert.ok(!/armAutoMerge\(prUrl, taskId\)/.test(before), "the old post-review armAutoMerge(prUrl, taskId) call must be removed from this site");
    // armAutoMergeAtOpen, by contrast, is reachable right after `pr.opened`.
    const openedIdx = runTaskSrc.indexOf('log("pr.opened", { pr_url: prUrl });');
    assert.ok(openedIdx >= 0 && openedIdx < pollIdx);
    const afterOpened = runTaskSrc.slice(openedIdx, openedIdx + 800);
    assert.match(afterOpened, /armAutoMergeAtOpen\(prUrl\)/, "armAutoMergeAtOpen must fire close after pr.opened, not deep into the flow");
  },
);

// Re-exported so `armAutoMerge`'s own (unmodified) 6-call-site contract is
// still importable from this file without an unused-import lint complaint —
// a cheap "the refactor didn't break the export" smoke check.
test("armAutoMerge: still exported and callable with its original 3-arg ledger-gated signature (unchanged by the W1-T125 refactor)", () => {
  const deps = armDeps();
  assert.equal(armAutoMerge("url/unchanged", "W1-TX", deps), "armed");
});
