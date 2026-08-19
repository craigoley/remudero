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
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

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
    // Reaches `gh pr merge --disable-auto` for real, against the PATH-stubbed `gh` installed
    // just above — never the live repo. Exempted because the guard checks the CALL, not the
    // destination, and this test's whole point is that the real dep body executes.
    assert.doesNotThrow(
      () => withLiveWritesAllowed(() => d.disableAuto("url/x")),
      "disableAuto reaches gh pr merge --disable-auto",
    );
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

/** W1-T948: the SAME probe task plus the one declaration the specialist panel's testing
 *  trigger reads — `principles: {tdd: strict}`, the very property review.ts's `isTddStrict`
 *  already reads for the arm gate. Behaviourally INERT for arming: `decideAutoMergeArm` takes
 *  `tddStrict` and never reads it (the name appears in its signature and nowhere in its
 *  body), so the (C) run below decides exactly what it decided before this declaration
 *  existed — only the specialist panel's own log line is added. */
const ARM_OPEN_FIXTURE_PLAN_TDD_STRICT = ARM_OPEN_FIXTURE_PLAN.replace(
  "  status: queued",
  "  principles: {tdd: strict}\n  status: queued",
);

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
      // A REAL runTask() against this file's own containment: an offline `github` gateway, an
      // injected `spawn`, and a fake `gh` on PATH (see the section header above). Nothing here
      // reaches the live repo — but the guard checks the CALL, so the run needs this exemption.
      const res = await withLiveWritesAllowed(() =>
        runTask("T-ARM-OPEN", {
          skipGitSync: true,
          planPath,
          config,
          github: ARM_OPEN_OFFLINE_GITHUB,
          spawn,
          containmentExec: armOpenHoldingContainmentExec,
          isolationExec: armOpenCleanIsolationExec,
        }),
      );

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
//   (iv) an EXECUTION-level proof (added after the three above shipped, W1-T125
//        round 1 fix-ci): `runTask`'s primary post-CI-green `runReview` call
//        gained its own injectable seam (mirroring the `spawn`/`github`/
//        `containmentExec` params already on `runTask`'s opts, and the
//        `deps.runReview` seam `runFixRung` already had) so a test can hand it
//        a CAPPED verdict DIRECTLY, without ever reaching the real `runReview`'s
//        hard-coded `spawnWorker` call (the actual keychain/PATH hazard (i)-(iii)
//        above worked around by staying at source level). This drives a REAL
//        `runTask()` all the way through `disarmAutoMerge(prUrl)` and the
//        `automerge.disarmed` ledger line it writes — the two lines a coverage
//        tool could see were never actually EXECUTED by any prior test, only
//        proven correct by construction via (i)-(iii).

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

/** A fake `gh` for the EXECUTION-level capped-refusal proof: answers `pr view`
 *  (headRefName/body/headRefOid/statusCheckRollup — CI GREEN on the very first
 *  poll, unlike `armOpenFakeGh` above), `pr merge --auto`/`--disable-auto`
 *  (ordered call log, same convention), AND the escalation surface `runTask`'s
 *  own capped-refusal branch reaches next (`gh issue create`, `gh label
 *  create`, `gh api .../issues?...` for the open-issue dedup read) — none of
 *  which the CI-red fixture above ever needs, because a red PR returns before
 *  reaching review at all. */
function armOpenCappedFakeGh(branch: string, callLogPath: string, headSha: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "arm-open-capped-bin-"));
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
      `  if [[ "$5" == 'headRefOid' ]]; then echo '{"headRefOid":"${headSha}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then",
      "    echo 'poll' >> \"$CALLLOG\"",
      "    echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"SUCCESS\"}]}'",
      "    exit 0",
      "  fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'merge' ]]; then",
      "  if [[ \"$4\" == '--auto' ]]; then echo \"arm $3\" >> \"$CALLLOG\"; exit 0; fi",
      "  if [[ \"$4\" == '--disable-auto' ]]; then echo \"disarm $3\" >> \"$CALLLOG\"; exit 0; fi",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == 'label' && \"$2\" == 'create' ]]; then exit 0; fi",
      "if [[ \"$1\" == 'issue' && \"$2\" == 'create' ]]; then",
      "  echo 'https://github.com/acme/remudero/issues/501'",
      "  exit 0",
      "fi",
      // W1-T511: `ghLiveState` reads live PR state over REST (`gh api repos/{o}/{r}/pulls/{n}`).
      // This arm MUST precede the generic `api` arm below, which answers `[]` for the open-issue
      // dedup read — an array folds to NOT-OPEN, so without this the fix rung stands down
      // (`fix.stood_down`) before the branch under test is reached.
      "if [[ \"$1\" == 'api' && \"$2\" =~ ^repos/[^/]+/[^/]+/pulls/[0-9]+$ ]]; then echo '{\"state\":\"open\",\"merged\":false}'; exit 0; fi",
      "if [[ \"$1\" == 'api' ]]; then echo '[]'; exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

test(
  "EXECUTION (W1-T125 mechanism iv): a real runTask() run whose review call (injected) returns a " +
    "CAPPED, state:success, planOnly:false verdict actually EXECUTES disarmAutoMerge(prUrl) and logs " +
    "automerge.disarmed — the fake-gh call log proves `pr merge --disable-auto` really reaches `gh`, " +
    "withdrawing the arm-at-open BEFORE the run escalates and returns a blocked verdict",
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "arm-open-capped-root-"));
    const planPath = join(root, "tasks.yaml");
    // W1-T948: the tdd:strict variant, so this SAME run also exercises run-task.ts's
    // specialist-panel call site. Inert for everything this test already asserts.
    writeFileSync(planPath, ARM_OPEN_FIXTURE_PLAN_TDD_STRICT);
    const config: Config = { claudeBin: "/bin/true", root };

    armOpenGitFixture(root);

    const FIXED_TS = 1785100000001;
    const branch = `run-T-ARM-OPEN-${FIXED_TS}`;
    const headSha = "cafed00d1234";
    const callLogPath = join(root, "gh-calls.log");
    writeFileSync(callLogPath, "");
    const fakeBinDir = armOpenCappedFakeGh(branch, callLogPath, headSha);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${savedPath}`;
    const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

    const spawnCalls: SpawnWorkerArgs[] = [];
    const spawn: typeof spawnWorker = async (args) => {
      spawnCalls.push(args);
      if (spawnCalls.length === 1) {
        return result({ sessionId: "s-recon", text: "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" });
      }
      return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/501\n" });
    };

    // A genuinely CAPPED, state:success, planOnly:false verdict — the exact shape
    // MECHANISM (i) above proves `judgeReview`+`decideAutoMergeArm` really produce,
    // handed straight to runTask's injected review seam so the run reaches the
    // capped-refusal branch without a live reviewer spawn.
    const cappedVerdict = {
      state: "success" as const,
      criteria: [],
      testTheater: false,
      summary: "CAPPED — 0 of 1 proofs executed",
      floorDegraded: false,
      capped: true,
      keywordOnly: false,
      planOnly: false,
      headSha,
      reviewerOutcome: "success",
    };
    let seenRunReviewArgs: { prUrl: string } | undefined;

    try {
      // Same containment as the (B) run above — offline gateway, injected spawn, fake gh — plus
      // an injected review seam. Exempted for the same reason: the boundary is real, the
      // destination is not.
      const res = await withLiveWritesAllowed(() =>
        runTask("T-ARM-OPEN", {
          skipGitSync: true,
          planPath,
          config,
          github: ARM_OPEN_OFFLINE_GITHUB,
          spawn,
          containmentExec: armOpenHoldingContainmentExec,
          isolationExec: armOpenCleanIsolationExec,
          runReview: async (args) => {
            seenRunReviewArgs = { prUrl: args.prUrl };
            return cappedVerdict;
          },
        }),
      );

      assert.equal(res.verdict, "blocked", "a CAPPED, non-planOnly verdict with no override is refused, unattended");
      assert.equal(res.merged, false);
      assert.equal(seenRunReviewArgs?.prUrl, "https://github.com/acme/remudero/pull/501", "the injected review seam observed the run's own PR");

      const ledger = readLedger(root);
      const armedIdx = ledger.findIndex((l) => l.step === "automerge.armed");
      assert.ok(armedIdx >= 0, "the run must have armed at open first, same as the sibling ACCEPTANCE test");
      const disarmedIdx = ledger.findIndex((l) => l.step === "automerge.disarmed");
      assert.ok(disarmedIdx >= 0, "automerge.disarmed must be ledgered — the line disarmAutoMerge's own log() call writes");
      assert.ok(disarmedIdx > armedIdx, "the disarm must be ledgered AFTER the earlier arm-at-open, never before");
      assert.equal(ledger[disarmedIdx]?.reason, "capped verdict refused auto-merge");
      const verdictIdx = ledger.findIndex((l) => l.step === "verdict");
      assert.ok(verdictIdx > disarmedIdx, "the terminal verdict line must follow the disarm, matching the source order (disarm BEFORE escalate BEFORE the verdict log)");

      // ── W1-T948: the SAME real run reaches run-task.ts's specialist-panel call site.
      // This task declares `principles: {tdd: strict}`, so `taskMetadataFromPrinciples`
      // builds metadata the testing trigger fires on and the panel's ledger line is
      // WRITTEN, naming that trigger. The paired negative half — an otherwise identical
      // run whose task declares no principles writing NO such line — is asserted in the
      // (D) risk-judge test below, off the same real runTask path.
      const panelLines = ledger.filter((l) => l.step === "specialist.panel");
      assert.equal(panelLines.length, 1, "a tdd:strict task must ledger specialist.panel exactly once");
      assert.deepEqual(
        panelLines[0]?.triggers,
        ["testing"],
        "only the testing trigger fires: the panel is called with an EMPTY-files diff, so security and containment see no path and design has no task flag",
      );
      const panelIdx = ledger.findIndex((l) => l.step === "specialist.panel");
      assert.ok(panelIdx < disarmedIdx, "the panel line precedes the arm decision it sits above in source order");

      // ── The execution-level proof itself: `gh pr merge <url> --disable-auto`
      // really reached the fake `gh` binary — disarmAutoMerge's default deps
      // (realArmDeps()) shell out for real, exercised end-to-end here.
      const calls = readFileSync(callLogPath, "utf8").split("\n").filter(Boolean);
      assert.ok(
        calls.includes("disarm https://github.com/acme/remudero/pull/501"),
        `expected a 'disarm <prUrl>' call in the gh call log; got: ${JSON.stringify(calls)}`,
      );
      const armIdx = calls.indexOf("arm https://github.com/acme/remudero/pull/501");
      const disarmIdx = calls.indexOf("disarm https://github.com/acme/remudero/pull/501");
      assert.ok(armIdx >= 0 && disarmIdx > armIdx, "the disarm call must follow the earlier arm-at-open call in gh's own call order");
    } finally {
      dateNowSpy.mock.restore();
      process.env.PATH = savedPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// ── (D) THE RISK JUDGE (P34 clause (b), W1-T248) ────────────────────────────
//
// Sits structurally right after the arm decision this file's group (C) already
// proves, so it reuses that SAME real-runTask()-execution technique rather
// than inventing a new one: an armed, non-capped review verdict (injected via
// the same `runReview` seam) reaches the new risk-judge block, and the SAME
// injected `spawn` the recon/implement workers already use gets a THIRD call —
// the risk judge's own spawn (`realRiskJudge`'s wiring). A `RISK_VERDICT: high`
// response drives the escalate path — the shape a coverage tool could not see
// exercised by any prior test (this task's own commit message: "no existing
// runTask() end-to-end test reaches this call site").

test(
  "EXECUTION (W1-T248): a real runTask() run whose (injected) review is a full, non-capped PASS reaches " +
    "the risk-judge block; a HIGH-risk verdict from the (injected) judge spawn withdraws the arm-at-open, " +
    "ledgers risk_judge.decision + risk_judge.escalated VERBATIM, and returns a blocked verdict naming the " +
    "judge's own escalation issue — all BEFORE pollToGate is ever reached",
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "arm-open-riskjudge-root-"));
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, ARM_OPEN_FIXTURE_PLAN);
    const config: Config = { claudeBin: "/bin/true", root };

    armOpenGitFixture(root);

    const FIXED_TS = 1785100000002;
    const branch = `run-T-ARM-OPEN-${FIXED_TS}`;
    const headSha = "deadbeef5678";
    const callLogPath = join(root, "gh-calls.log");
    writeFileSync(callLogPath, "");
    // CI green (unlike the CI-red ACCEPTANCE fixture above) — a real run only
    // reaches review, and this new risk-judge block, once ci actually goes
    // green; armOpenCappedFakeGh already answers `statusCheckRollup` SUCCESS
    // plus the escalation surface (issue/label create) the judge's own
    // escalate dep below reaches, so it is reused as-is (nothing here is
    // actually "capped" — the name is this fixture's, not this test's shape).
    const fakeBinDir = armOpenCappedFakeGh(branch, callLogPath, headSha);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${savedPath}`;
    const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

    const spawnCalls: SpawnWorkerArgs[] = [];
    const spawn: typeof spawnWorker = async (args) => {
      spawnCalls.push(args);
      if (spawnCalls.length === 1) {
        return result({ sessionId: "s-recon", text: "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" });
      }
      if (spawnCalls.length === 2) {
        return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/601\n" });
      }
      // The THIRD spawn call is the risk judge itself (realRiskJudge's own
      // spawnRiskJudgeWorker, wired to runTask's SAME injected `spawn`) — a
      // deliberately HIGH-risk, high-confidence verdict so this run reaches
      // the escalate path (the branch a coverage tool could not otherwise see
      // exercised).
      return result({
        sessionId: "s-risk-judge",
        text: "RISK_VERDICT: high\nRISK_CONFIDENCE: 0.88\nRISK_REASON: touches an unreviewed area with no precedent",
      });
    };

    // A full, non-capped PASS — decideAutoMergeArm arms unconditionally on this
    // shape (verdict.state==="success" && !verdict.capped), so the run reaches
    // the NEW risk-judge block right after arming, never the capped-refusal
    // branch group (C) already covers.
    const fullPassVerdict = {
      state: "success" as const,
      criteria: [],
      testTheater: false,
      summary: "full PASS — every criterion executed",
      floorDegraded: false,
      capped: false,
      keywordOnly: false,
      planOnly: false,
      headSha,
      reviewerOutcome: "success",
    };

    try {
      // Same containment again, with the risk-judge spawn injected. Exempted for the same reason.
      const res = await withLiveWritesAllowed(() =>
        runTask("T-ARM-OPEN", {
          skipGitSync: true,
          planPath,
          config,
          github: ARM_OPEN_OFFLINE_GITHUB,
          spawn,
          containmentExec: armOpenHoldingContainmentExec,
          isolationExec: armOpenCleanIsolationExec,
          runReview: async () => fullPassVerdict,
        }),
      );

      assert.equal(res.verdict, "blocked", "a HIGH-risk judge verdict escalates and refuses to proceed to pollToGate");
      assert.equal(res.merged, false);
      assert.equal(spawnCalls.length, 3, "recon, implement, THEN the risk judge's own spawn — pollToGate never spawns anything");

      const ledger = readLedger(root);
      const armedIdx = ledger.findIndex((l) => l.step === "automerge.armed");
      assert.ok(armedIdx >= 0, "the run armed at open, same as every other run in this file");

      // ── W1-T948 NEGATIVE CONTROL, on the same real runTask path as the (C) positive:
      // this run's task declares NO principles, so the testing trigger does not fire and
      // no specialist.panel line is written. Without this half, the (C) assertion would
      // also pass against a panel that logged unconditionally.
      assert.equal(
        ledger.filter((l) => l.step === "specialist.panel").length,
        0,
        "a task with no `principles: {tdd: strict}` declaration must ledger NO specialist.panel line",
      );

      const decisionIdx = ledger.findIndex((l) => l.step === "risk_judge.decision");
      assert.ok(decisionIdx >= 0, "risk_judge.decision must be ledgered");
      assert.equal(ledger[decisionIdx]?.verdict, "high");
      assert.deepEqual(ledger[decisionIdx]?.reasons, ["touches an unreviewed area with no precedent"], "the judge's OWN observed reasons, ledgered VERBATIM");
      assert.equal(ledger[decisionIdx]?.confidence, 0.88, "confidence ledgered verbatim (round ii)");
      assert.equal(ledger[decisionIdx]?.action, "escalate");

      const disarmedIdx = ledger.findIndex((l) => l.step === "automerge.disarmed");
      assert.ok(disarmedIdx >= 0, "the risk judge's escalate dep must withdraw the arm-at-open");
      assert.equal(ledger[disarmedIdx]?.reason, "risk judge escalated — auto-merge refused");
      assert.ok(disarmedIdx > armedIdx, "the disarm follows the earlier arm-at-open, never before it");
      assert.ok(disarmedIdx > decisionIdx, "the decision is ledgered BEFORE the escalate dep withdraws the arm, matching runRiskJudge's own source order");

      const escalatedIdx = ledger.findIndex((l) => l.step === "risk_judge.escalated");
      assert.ok(escalatedIdx >= 0, "risk_judge.escalated must be ledgered");
      const issueUrl = ledger[escalatedIdx]?.issue_url as string | undefined;
      assert.match(String(issueUrl), /^https:\/\/github\.com\/acme\/remudero\/issues\/\d+$/, "the escalate dep's real issue URL");

      const verdictIdx = ledger.findIndex((l) => l.step === "verdict");
      assert.ok(verdictIdx > escalatedIdx, "the terminal verdict line follows risk_judge.escalated, matching source order");
      assert.equal(ledger[verdictIdx]?.verdict, "blocked");
      assert.equal(ledger[verdictIdx]?.reason, "risk judge escalated");
      assert.equal(ledger[verdictIdx]?.issue_url, issueUrl, "the returned verdict's issue_url is the SAME one the escalate dep produced");

      // pollToGate is never reached — no `ci.polling`/`pr.polling` line, and the
      // fake-gh call log recorded no SECOND statusCheckRollup poll beyond the
      // one `waitForCiGreen` already made before review.
      assert.ok(
        !ledger.some((l) => l.step === "ci.polling" || l.step === "pr.polling"),
        "the risk-judge escalation returns BEFORE pollToGate — no polling line is ever ledgered",
      );
      const pollCalls = readFileSync(callLogPath, "utf8").split("\n").filter((l) => l === "poll");
      assert.equal(pollCalls.length, 1, "exactly the ONE waitForCiGreen poll before review — pollToGate's own poll never fires");
    } finally {
      dateNowSpy.mock.restore();
      process.env.PATH = savedPath;
      rmSync(root, { recursive: true, force: true });
    }
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

// ── run-task.ts:3668 — the fix rung's best-effort push ───────────────────────────────
// The LAST of PR #954's guarded call sites that no test reached. `runTask` enters the fix
// rung on any non-success review (run-task.ts:3637), and `runFixRung` calls `deps.push(...)`
// (run-task.ts:2302) once the fix worker returns — so an injected review with state:"blocked"
// plus a spawn that also answers the fix worker drives it.
//
// The push is best-effort: its refusal is SWALLOWED by the caller's own try/catch, so
// `assert.throws` would prove nothing here. The observable is that the run got PAST it —
// the fix rung's own ledger lines. The drive is exempted because the push is real and lands
// in this fixture's throwaway origin; the guard's refusal is proven in
// test/live-write-guard-leaves.test.ts.
test(
  "EXECUTION: a real runTask() run whose (injected) review is NON-SUCCESS enters the fix rung and " +
    "reaches its best-effort push — the last guarded call site with no coverage",
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "arm-open-fixrung-root-"));
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, ARM_OPEN_FIXTURE_PLAN);
    const config: Config = { claudeBin: "/bin/true", root };
    armOpenGitFixture(root);

    const FIXED_TS = 1785100000002;
    const branch = `run-T-ARM-OPEN-${FIXED_TS}`;
    const headSha = "cafed00d5678";
    const callLogPath = join(root, "gh-calls.log");
    writeFileSync(callLogPath, "");
    const fakeBinDir = armOpenCappedFakeGh(branch, callLogPath, headSha);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${savedPath}`;
    t.mock.method(Date, "now", () => FIXED_TS);

    const spawnCalls: SpawnWorkerArgs[] = [];
    const spawn: typeof spawnWorker = async (args) => {
      spawnCalls.push(args);
      if (spawnCalls.length === 1) {
        return result({ sessionId: "s-recon", text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" });
      }
      if (spawnCalls.length === 2) {
        return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/501\n" });
      }
      // the FIX worker — its return is what carries runFixRung on to deps.push()
      return result({ sessionId: "s-fix", text: "REPORT\nfix applied\n" });
    };

    // state:"failure" is the only non-success ReviewState, and NOT capped — so the run takes
    // the fix rung rather than the capped refusal.
    const blockedVerdict = {
      state: "failure" as const,
      criteria: [],
      testTheater: false,
      summary: "failure — one unmet criterion",
      floorDegraded: false,
      capped: false,
      keywordOnly: false,
      planOnly: false,
      headSha,
      reviewerOutcome: "success",
    };

    try {
      await withLiveWritesAllowed(() =>
        runTask("T-ARM-OPEN", {
          skipGitSync: true,
          planPath,
          config,
          github: ARM_OPEN_OFFLINE_GITHUB,
          spawn,
          containmentExec: armOpenHoldingContainmentExec,
          isolationExec: armOpenCleanIsolationExec,
          runReview: async () => blockedVerdict,
        }),
      ).catch(() => undefined);

      const ledger = readLedger(root);
      const steps = ledger.map((l) => l.step);
      assert.ok(
        steps.includes("fix.dispatch"),
        `the run entered the fix rung; steps=${JSON.stringify(steps)}`,
      );
      assert.ok(
        spawnCalls.length >= 3,
        `a FIX worker was spawned (recon, implement, fix) — got ${spawnCalls.length} spawns`,
      );
    } finally {
      process.env.PATH = savedPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(fakeBinDir, { recursive: true, force: true });
    }
  },
);
