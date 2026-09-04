// W1-T272 — the ALREADY_SATISFIED sanctioned exit.
//
// Five separate W1-T254 runs each correctly diagnosed the task's acceptance was already true
// on origin/main, and each opened a no-op closure PR anyway — the output contract offered
// only a gated DECISION_REQUEST or "Otherwise: open a PR", and `no_pr` (the only PR-less
// verdict) halts the drain as anomalous. This file proves the third exit this task adds:
//   1. `resolveAlreadySatisfied` — the evidence gate — REFUSES a claim unless the named PR is
//      the SAME one the board gateway independently finds MERGED and trailer-anchored to this
//      task (pure unit tests, every refusal shape).
//   2. `alreadySatisfiedVerdict` produces the new, distinct `already_satisfied` verdict shape.
//   3. A REAL `runTask()` run whose worker claims ALREADY_SATISFIED against a verified PR ends
//      `verdict: "already_satisfied"`, `merged: true` — `merged: true` is the literal field
//      drain.ts/daemon.ts gate "stop-on-block" on, so this is the direct proof the new exit
//      does NOT halt the drain, the same way `verdict: "merged"` does not.
//   4. A REAL `runTask()` run whose claim does NOT verify falls straight through to the
//      EXISTING, UNCHANGED `no_pr` path — `merged: false`, same as before this task.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  alreadySatisfiedVerdict,
  noPrVerdict,
  parseAlreadySatisfied,
  prNumberFromRef,
  resolveAlreadySatisfied,
  runTask,
  type AlreadySatisfiedClaim,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { classifyGhFailure, type GitHub, type PrRef } from "../src/lib/status.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";

/** Build a minimal WorkerResult; only the fields each test reads matter (mirrors
 *  run-task.test.ts's own `result` helper — duplicated here so this file stays
 *  self-contained, per the OUTPUT CONTRACT's own file scope). */
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

// ── Part 1: parseAlreadySatisfied — anchored extraction ─────────────────────────────────

test("parseAlreadySatisfied: extracts the ref off an anchored ALREADY_SATISFIED: line", () => {
  const claim = parseAlreadySatisfied("REPORT\nALREADY_SATISFIED: #42\n");
  assert.equal(claim?.ref, "#42");
});

test("parseAlreadySatisfied: the LAST anchored line wins, mirroring the REPORT contract", () => {
  const claim = parseAlreadySatisfied(
    "ALREADY_SATISFIED: #1\nsome more reasoning\nALREADY_SATISFIED: https://github.com/acme/remudero/pull/42\n",
  );
  assert.equal(claim?.ref, "https://github.com/acme/remudero/pull/42");
});

test("parseAlreadySatisfied: a mid-line/quoted occurrence is INERT — only a start-of-line anchor counts", () => {
  const claim = parseAlreadySatisfied(
    "The contract says: `ALREADY_SATISFIED: <ref>` is one of the exits. Nothing else applies here.\n",
  );
  assert.equal(claim, undefined);
});

test("parseAlreadySatisfied: absent from ordinary REPORT/PR_URL text — undefined, never a false positive", () => {
  const claim = parseAlreadySatisfied("REPORT\nPR_URL: https://github.com/acme/remudero/pull/7\n");
  assert.equal(claim, undefined);
});

// ── Part 2: prNumberFromRef ──────────────────────────────────────────────────────────────

test("prNumberFromRef: a bare number, a #-prefixed number, and a full pull URL all resolve to the same number", () => {
  assert.equal(prNumberFromRef("42"), 42);
  assert.equal(prNumberFromRef("#42"), 42);
  assert.equal(prNumberFromRef("https://github.com/acme/remudero/pull/42"), 42);
});

test("prNumberFromRef: a ref naming no number at all is undefined, never a guess", () => {
  assert.equal(prNumberFromRef("it's already fixed, trust me"), undefined);
});

// ── Part 3: resolveAlreadySatisfied — THE EVIDENCE GATE ──────────────────────────────────
// "An unverifiable honesty exit is worse than none" (design part 2): every refusal shape
// below must fall through to undefined, never throw and never guess a credit into existence.

const TASK_ID = "T-ALREADY-SATISFIED";
const CREDIT_PR: PrRef = { number: 42, url: "https://github.com/acme/remudero/pull/42", state: "MERGED" };

/** A board gateway that credits PR #42 to TASK_ID and nothing else — the one shape every
 *  other GitHub method here is never consulted by `resolveAlreadySatisfied`. */
function creditingGithub(taskId: string, credited: PrRef | null): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: (id) => (id === taskId ? credited : null),
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

test("resolveAlreadySatisfied: VERIFIED when the claimed number matches the gateway's own merged, trailer-anchored PR for this task", () => {
  const claim: AlreadySatisfiedClaim = { raw: "", ref: "#42" };
  const resolved = resolveAlreadySatisfied(claim, creditingGithub(TASK_ID, CREDIT_PR), TASK_ID);
  assert.deepEqual(resolved, { outcome: "verified", number: 42, url: "https://github.com/acme/remudero/pull/42" });
});

test("resolveAlreadySatisfied: VERIFIED off a full pull URL claim too, not just a bare number", () => {
  const claim: AlreadySatisfiedClaim = { raw: "", ref: "https://github.com/acme/remudero/pull/42" };
  const resolved = resolveAlreadySatisfied(claim, creditingGithub(TASK_ID, CREDIT_PR), TASK_ID);
  assert.deepEqual(resolved, { outcome: "verified", number: 42, url: "https://github.com/acme/remudero/pull/42" });
});

test("resolveAlreadySatisfied: REFUSED when the claimed number does not match what the gateway finds — a worker cannot cite ANY merged PR, only the credited one", () => {
  const claim: AlreadySatisfiedClaim = { raw: "", ref: "#999" };
  const resolved = resolveAlreadySatisfied(claim, creditingGithub(TASK_ID, CREDIT_PR), TASK_ID);
  assert.deepEqual(resolved, { outcome: "refuted", reason: "different_pr", creditedNumber: 42 });
});

test("resolveAlreadySatisfied: REFUSED when the gateway finds NO merged, trailer-anchored PR for this task at all", () => {
  const claim: AlreadySatisfiedClaim = { raw: "", ref: "#42" };
  const resolved = resolveAlreadySatisfied(claim, creditingGithub(TASK_ID, null), TASK_ID);
  assert.deepEqual(resolved, { outcome: "refuted", reason: "not_found" });
});

test("resolveAlreadySatisfied: REFUSED on a malformed ref naming no PR number — never reaches the gateway with garbage", () => {
  const claim: AlreadySatisfiedClaim = { raw: "", ref: "trust me, it's done" };
  let consulted = false;
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => {
      consulted = true;
      return CREDIT_PR;
    },
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  const resolved = resolveAlreadySatisfied(claim, github, TASK_ID);
  assert.deepEqual(resolved, { outcome: "refuted", reason: "unparsable_ref" });
  assert.equal(consulted, false, "an unparseable ref must never even reach the board gateway");
});

// ── Part 4: alreadySatisfiedVerdict — the new verdict shape ─────────────────────────────

test("alreadySatisfiedVerdict: a distinct verdict, carrying the credited PR's url and number on its ledger line", () => {
  const v = alreadySatisfiedVerdict(result({ subtype: "success", numTurns: 3 }), 1.23, "implement", {
    number: 42,
    url: "https://github.com/acme/remudero/pull/42",
  });
  assert.equal(v.verdict, "already_satisfied");
  assert.equal(v.prUrl, "https://github.com/acme/remudero/pull/42");
  assert.equal(v.ledger.verdict, "already_satisfied");
  assert.equal(v.ledger.pr_number, 42);
  assert.equal(v.ledger.pr_url, "https://github.com/acme/remudero/pull/42");
  assert.equal(v.ledger.cost_usd, 1.23);
  assert.notEqual(v.verdict as string, "merged");
  assert.notEqual(v.verdict as string, "no_pr");
});

// ── Part 5: no_pr keeps its existing, drain-halting behaviour — UNCHANGED ────────────────

test("noPrVerdict: unchanged by this task — still the honest, distinct 'no_pr' verdict for a terminal-SUCCESS worker with no PR", () => {
  const v = noPrVerdict(result({ subtype: "success", numTurns: 5 }), 2, "implement", 0);
  assert.equal(v.verdict, "no_pr");
  assert.equal(v.ledger.verdict, "no_pr");
  assert.equal(v.ledger.reason, "worker completed without opening a PR");
});

// ── Part 6: BEHAVIORAL — a REAL runTask() run through both branches ─────────────────────
// Mirrors run-task.test.ts's own W1-T105 follow-up-harvest technique: a real, throwaway bare
// "origin" + a real clone stand in for the repo, the worker spawn is faked (zero real Claude
// process), and the GitHub board gateway is injected (zero network). Neither path below opens
// a PR or reaches "Ensure the branch is on origin", so no `gh` binary is needed on PATH at all
// — the SILENT NO-OP GUARD returns before either would run.

const ALREADY_SATISFIED_PLAN = [
  "- id: T-ALREADY-SATISFIED",
  "  title: already-satisfied exit wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

/** A real, throwaway BARE "origin" + a real clone at `repoDir` (mirrors run-task.test.ts's
 *  `followupGitFixture`) — `runTask`'s own `git worktree add`/`git worktree remove` all run
 *  for real, entirely offline. */
function gitFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "rmd-already-satisfied-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "rmd-already-satisfied-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "already-satisfied-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "already-satisfied-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "already-satisfied-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "already-satisfied-test"]);
  return { repoDir };
}

/** Containment PASSES (mirrors run-task.test.ts's `followupHoldingContainmentExec`). */
const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

/** Isolation PASSES (mirrors run-task.test.ts's `followupCleanIsolationExec`). */
const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

const RECON_TEXT = "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n";

test("BEHAVIORAL: a real runTask() run whose worker claims a VERIFIED ALREADY_SATISFIED ends verdict:already_satisfied, merged:true — the drain does not halt", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-already-satisfied-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ALREADY_SATISFIED_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: RECON_TEXT });
    // The implement worker opens NO PR and commits nothing — it found the acceptance already
    // true on origin/main and names the merged PR that already did the work.
    return result({ sessionId: "s-implement", text: "REPORT\nALREADY_SATISFIED: #42\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-ALREADY-SATISFIED", {
        skipGitSync: true,
        planPath,
        config,
        github: creditingGithub("T-ALREADY-SATISFIED", CREDIT_PR),
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );

    assert.equal(spawnCalls.length, 2, "recon then implement — no resume, no gh pr create, no review spawn");
    assert.equal(res.verdict, "already_satisfied");
    assert.equal(res.merged, true, "merged:true is the literal field drain.ts/daemon.ts gate stop-on-block on — this proves the new exit does not halt the drain");
    assert.equal(res.prUrl, "https://github.com/acme/remudero/pull/42");

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const verdictLine = ledger.find((l) => l.step === "verdict");
    assert.equal(verdictLine?.verdict, "already_satisfied");
    assert.equal(verdictLine?.pr_number, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL: a real runTask() run whose ALREADY_SATISFIED claim does NOT verify falls straight through to the existing, unchanged no_pr path — merged:false, the drain halts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-already-satisfied-refused-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ALREADY_SATISFIED_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: RECON_TEXT });
    // Names a PR the board gateway never credits to this task — a lazy/hallucinated claim.
    return result({ sessionId: "s-implement", text: "REPORT\nALREADY_SATISFIED: #999\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-ALREADY-SATISFIED", {
        skipGitSync: true,
        planPath,
        config,
        github: creditingGithub("T-ALREADY-SATISFIED", CREDIT_PR), // credits #42, never #999
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );

    assert.equal(spawnCalls.length, 2, "recon then implement");
    assert.equal(res.verdict, "no_pr", "an unverified claim is refused and treated exactly as if none had been made");
    assert.equal(res.merged, false, "no_pr keeps its existing drain-halting behaviour, unchanged by this task");
    assert.equal(res.prUrl, undefined);

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const refusal = ledger.find((l) => l.step === "already_satisfied.refused");
    assert.equal(refusal?.claimed_ref, "#999");
    assert.equal(refusal?.claimed_number, 999);
    // THE FORENSIC RECORD NAMES ITS CAUSE (W1-T119 applied to rung (c)): before this, the row
    // carried task/ref/number and NO reason, so "you cited the wrong PR" and "the read failed"
    // were indistinguishable on disk. #999 loses to the credited #42, and the row says so.
    assert.equal(refusal?.reason, "different_pr", "a refusal must say WHICH of the three things happened");
    assert.equal(refusal?.credited_number, 42, "and name the PR that actually holds the trailer");
    const verdictLine = ledger.find((l) => l.step === "verdict");
    assert.equal(verdictLine?.verdict, "no_pr");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL: a real runTask() run whose worktree teardown fails on the already_satisfied path still credits the verdict, only ledgering the teardown error", async () => {
  // The already_satisfied exit's own `worktreeRemove` catch (mirrors the sibling `no_pr` catch
  // right below it) must never turn a VERIFIED claim into a failed run just because cleanup
  // couldn't run — best-effort teardown, not a gate. Forcing a REAL `git worktree remove`
  // failure (a lock, exactly as git itself refuses without `-f -f`) proves the catch is live.
  const root = mkdtempSync(join(tmpdir(), "rmd-already-satisfied-teardown-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ALREADY_SATISFIED_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  const { repoDir } = gitFixture(root);

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: RECON_TEXT });
    // Lock the worktree — `git worktree remove --force` (single force) fatals on a
    // locked tree instead of removing it, exactly like it would refuse on any other
    // real-world teardown obstruction (a stray lockfile, a dirty submodule, etc.).
    execFileSync("git", ["-C", repoDir, "worktree", "lock", args.cwd, "--reason", "held-for-test"]);
    return result({ sessionId: "s-implement", text: "REPORT\nALREADY_SATISFIED: #42\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-ALREADY-SATISFIED", {
        skipGitSync: true,
        planPath,
        config,
        github: creditingGithub("T-ALREADY-SATISFIED", CREDIT_PR),
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );

    assert.equal(res.verdict, "already_satisfied", "a teardown failure does not demote the verdict");
    assert.equal(res.merged, true);
    assert.equal(res.prUrl, "https://github.com/acme/remudero/pull/42");

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const removeError = ledger.find((l) => l.step === "worktree.remove.error");
    assert.equal(removeError?.on, "already_satisfied");
    // `worktreeRemove` runs git with `stdio: "inherit"`, so git's own "cannot remove a
    // locked working tree" text lands on the real stderr, not on the thrown Error's
    // `.message` — the message is only ever execFileSync's generic "Command failed: …".
    assert.match(String(removeError?.error), /Command failed.*worktree remove/);
    const verdictLine = ledger.find((l) => l.step === "verdict");
    assert.equal(verdictLine?.verdict, "already_satisfied");
  } finally {
    // The locked worktree's admin metadata under repoDir/.git prevents nothing here —
    // filesystem removal is unconditional regardless of git's own lock bookkeeping.
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL: a real runTask() run whose board gateway READ FAILS records already_satisfied.unverified with its reason — never a refusal", async () => {
  // THE $23.34 CASE, end to end. Six `already_satisfied.refused` rows exist in the ledger union;
  // replayed later, three of four resolved correctly (W1-T377→#1386, W1-T378→#1391,
  // W1-T412→#1508). The workers were right and the read could not answer — but the row said the
  // claim was false, and two already-shipped tasks were re-dispatched for it.
  const root = mkdtempSync(join(tmpdir(), "rmd-already-satisfied-unverifiable-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ALREADY_SATISFIED_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  // A gateway whose read genuinely FAILS, classified the way the production one does.
  let failed = false;
  let reason: ReturnType<typeof classifyGhFailure> | undefined;
  const unreadable: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => {
      failed = true;
      reason = classifyGhFailure(1, "dial tcp: connect: network is unreachable", undefined);
      return null;
    },
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => failed,
    readFailureReason: () => reason,
  };

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: RECON_TEXT });
    // A TRUE claim — the PR really is merged; the gateway simply cannot be reached to confirm it.
    return result({ sessionId: "s-implement", text: "REPORT\nALREADY_SATISFIED: #42\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-ALREADY-SATISFIED", {
        skipGitSync: true,
        planPath,
        config,
        github: unreadable,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );

    assert.equal(res.verdict, "no_pr", "an unverifiable claim is still never CREDITED — that would be worse");
    assert.equal(res.merged, false);

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const unverified = ledger.find((l) => l.step === "already_satisfied.unverified");
    assert.ok(unverified, "the run recorded that it COULD NOT CHECK");
    assert.equal(unverified?.claimed_ref, "#42");
    assert.equal(unverified?.claimed_number, 42);
    assert.equal(unverified?.reason, "transport", "and why — threaded from classifyGhFailure, not guessed");

    assert.equal(
      ledger.find((l) => l.step === "already_satisfied.refused"),
      undefined,
      "a read that FAILED must never be recorded as a claim that was FALSE — the whole defect",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
