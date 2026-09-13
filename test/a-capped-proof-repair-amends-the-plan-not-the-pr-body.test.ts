import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { gitRepo } from "./helpers/git-repo.js";

import {
  findTaskShard,
  parseProofAmendmentProposal,
  proofAmendmentIdempotencyKey,
  proofAmendmentIneligibleReason,
  replaceProofScalar,
  requestProofAmendment,
  validateProofAmendmentProposal,
  type ProofAmendmentPrState,
  type ProofAmendmentProposalEntry,
  type ProofAmendmentRecord,
  type ProofAmendmentRequest,
  type ProofAmendmentWritePorts,
} from "../src/lib/proof-amendment.js";
import type { ProofDiscriminationEvidence } from "../src/lib/sweep.js";
import type { WhitelistedProof } from "../src/lib/review.js";
import type { Config } from "../src/lib/config-schema.js";
import {
  CHECK_PROOF_EXIT,
  buildBaseProofDir,
  buildProofAmendmentGitOps,
  buildProofAmendmentWritePorts,
  checkProofCommand,
  dispatchProofAmendmentWrite,
} from "../src/run-task.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";

// W1-T3434 — #5154 was CAPPED because its `unit test:` proofs passed at both the implementation
// head and its merge base, and the proof-discrimination worker was told to repair the PR BODY's
// Acceptance block — an artifact `resolvePlanCriteriaAtHead` never reads for a trailered PR. This
// suite proves the parent-owned replacement: a validated worker proposal produces exactly one
// plan-only amendment, an invalid or non-discriminating one produces none, a duplicate identity
// resumes rather than re-files, and a merged amendment only requests a guarded branch update —
// never a direct write to the implementation PR's body, branch, or task shard from this process.

const TASK_ID = "W1-T3434-FIXTURE";
const PR_URL = "https://github.com/acme/remudero/pull/5154";
const HEAD_SHA = "5154headsha";
const CLAIM = "the widget renders without throwing";
const OLD_PROOF = "unit test: test/widget.test.ts";
const NEW_PROOF = "grep: renderWidget( in src/widget.ts";

function evidence(): ProofDiscriminationEvidence {
  return { proofs: [{ claim: CLAIM, proof: OLD_PROOF, proofExec: "executed_stale" }] };
}

function eligiblePr(over: Partial<ProofAmendmentPrState> = {}): ProofAmendmentPrState {
  return {
    isOpen: true,
    planOnly: false,
    taskId: TASK_ID,
    reviewState: "success",
    capped: true,
    criteria: [{ claim: CLAIM, proof: OLD_PROOF, met: true }],
    ...over,
  };
}

function validEntry(over: Partial<ProofAmendmentProposalEntry> = {}): ProofAmendmentProposalEntry {
  return { claim: CLAIM, oldProof: OLD_PROOF, newProof: NEW_PROOF, ...over };
}

/** A parsed replacement always reads "pass" at the head and "fail" at the base unless a test
 *  overrides one side — the shape a genuine discriminator has. */
function fakeExecutors(overrides: { head?: "pass" | "fail" | "no-match"; base?: "pass" | "fail" | "no-match" } = {}) {
  return {
    execAtHead: (_w: WhitelistedProof, _cwd: string) => overrides.head ?? "pass",
    execAtBase: (_w: WhitelistedProof, _cwd: string) => overrides.base ?? "fail",
  };
}

interface RecordingWritePorts extends ProofAmendmentWritePorts {
  calls: {
    worktreeAdd: number;
    worktreeRemove: number;
    writeFile: Array<{ path: string; text: string }>;
    gitAdd: number;
    gitCommit: number;
    gitPush: number;
    probeExisting: number;
    createPr: number;
    updateBranch: number;
  };
}

/** A fully-faked write side: an in-memory "durable" identity store (mirroring the ledger's own
 *  append-then-read discipline) plus counters so a test can prove, by COUNTING, that a refused or
 *  resumed outcome never touched git or GitHub. */
function fakeWriteDeps(overrides: Partial<ProofAmendmentWritePorts> = {}): RecordingWritePorts {
  const identities = new Map<string, ProofAmendmentRecord>();
  const calls: RecordingWritePorts["calls"] = {
    worktreeAdd: 0,
    worktreeRemove: 0,
    writeFile: [],
    gitAdd: 0,
    gitCommit: 0,
    gitPush: 0,
    probeExisting: 0,
    createPr: 0,
    updateBranch: 0,
  };
  const deps: ProofAmendmentWritePorts = {
    repoDir: "/repo",
    findShard: () => ({ path: "plan/tasks.d/W1-T3434-FIXTURE.yaml", text: `- id: ${TASK_ID}\n  acceptance:\n    - claim: "${CLAIM}"\n      proof: "${OLD_PROOF}"\n` }),
    worktreeAdd: () => {
      calls.worktreeAdd++;
    },
    worktreeRemove: () => {
      calls.worktreeRemove++;
    },
    writeFile: (absPath, text) => {
      calls.writeFile.push({ path: absPath, text });
    },
    gitAdd: () => {
      calls.gitAdd++;
    },
    gitCommit: () => {
      calls.gitCommit++;
      return "committedsha";
    },
    gitPush: () => {
      calls.gitPush++;
    },
    probeExisting: () => {
      calls.probeExisting++;
      return undefined;
    },
    createPr: () => {
      calls.createPr++;
      return { prUrl: "https://github.com/acme/remudero/pull/9001", prNumber: 9001 };
    },
    worktreePathFor: (taskId, prNumber) => `/tmp/proof-amendment-${taskId}-${prNumber}`,
    lookupIdentity: (key) => identities.get(key),
    recordIdentity: (key, record) => {
      identities.set(key, record);
    },
    updateBranch: () => {
      calls.updateBranch++;
      return { ok: true };
    },
    ...overrides,
  };
  return Object.assign(deps, { calls });
}

function baseRequest(over: Partial<ProofAmendmentRequest> = {}): ProofAmendmentRequest {
  return {
    taskId: TASK_ID,
    prNumber: 5154,
    prUrl: PR_URL,
    pr: eligiblePr(),
    evidence: evidence(),
    proposal: [validEntry()],
    headSha: HEAD_SHA,
    currentHeadSha: HEAD_SHA,
    headCwd: "/checkout/head",
    baseCwd: "/checkout/base",
    ...fakeExecutors(),
    ...over,
  };
}

test("a validated trailered capped PR creates one proof-only plan amendment", () => {
  const writeDeps = fakeWriteDeps();
  const outcome = requestProofAmendment(baseRequest(), writeDeps);
  assert.deepEqual(outcome, { kind: "created", amendmentUrl: "https://github.com/acme/remudero/pull/9001", amendmentNumber: 9001 });
  assert.equal(writeDeps.calls.worktreeAdd, 1);
  assert.equal(writeDeps.calls.createPr, 1);
  assert.equal(writeDeps.calls.gitCommit, 1);
  assert.equal(writeDeps.calls.gitPush, 1);
  assert.equal(writeDeps.calls.worktreeRemove, 1, "the worktree is reaped even on the success path");
  assert.equal(writeDeps.calls.writeFile.length, 1);
  // ONLY the proof scalar changed — the claim text is untouched, satisfying Standing rule 15's
  // "never edit claim:" boundary for the amendment's own diff.
  assert.match(writeDeps.calls.writeFile[0]!.text, /proof: "grep: renderWidget\( in src\/widget\.ts"/);
  assert.match(writeDeps.calls.writeFile[0]!.text, new RegExp(`claim: "${CLAIM}"`));
});

test("an invalid or non-discriminating replacement opens no amendment", () => {
  const shapes: Array<{ label: string; over: Partial<ProofAmendmentRequest> }> = [
    { label: "changed claim", over: { proposal: [validEntry({ claim: "a different claim entirely" })] } },
    { label: "old proof not byte-identical", over: { proposal: [validEntry({ oldProof: "unit test: test/other.test.ts" })] } },
    { label: "unparseable replacement", over: { proposal: [validEntry({ newProof: "just repair it somehow" })] } },
    { label: "targets the plan shard itself", over: { proposal: [validEntry({ newProof: "grep: id: W1-T3434-FIXTURE in plan/tasks.d/W1-T3434-FIXTURE.yaml" })] } },
    { label: "fails at the implementation head", over: { execAtHead: () => "fail" as const } },
    { label: "still passes at the merge base (non-discriminating)", over: { execAtBase: () => "pass" as const } },
    { label: "moved implementation head", over: { currentHeadSha: "a-different-head-entirely" } },
    { label: "unreadable base checkout", over: { baseCwd: undefined } },
    { label: "duplicate claim within one proposal", over: { proposal: [validEntry(), validEntry()] } },
    { label: "no proposal at all", over: { proposal: [] } },
  ];
  for (const shape of shapes) {
    const writeDeps = fakeWriteDeps();
    const outcome = requestProofAmendment(baseRequest(shape.over), writeDeps);
    assert.equal(outcome.kind, "refused", `${shape.label} must refuse, got ${outcome.kind}`);
    assert.equal(writeDeps.calls.worktreeAdd, 0, `${shape.label} must never touch a worktree`);
    assert.equal(writeDeps.calls.createPr, 0, `${shape.label} must never open a PR`);
  }
});

test("a duplicate proof-amendment identity resumes instead of creating another PR", () => {
  const writeDeps = fakeWriteDeps();
  const first = requestProofAmendment(baseRequest(), writeDeps);
  assert.equal(first.kind, "created");
  const second = requestProofAmendment(baseRequest(), writeDeps);
  assert.deepEqual(second, { kind: "resumed", amendmentUrl: "https://github.com/acme/remudero/pull/9001", amendmentNumber: 9001 });
  assert.equal(writeDeps.calls.createPr, 1, "a duplicate identity must never open a second amendment PR");
  assert.equal(writeDeps.calls.worktreeAdd, 1);
});

test("a duplicate identity also resumes via a live probe when the identity was never recorded", () => {
  // A crash between push and record must not open a second PR either — the stable branch name
  // lets a fresh dispatch find its own prior push.
  const writeDeps = fakeWriteDeps({
    probeExisting: () => ({ prUrl: "https://github.com/acme/remudero/pull/9002", prNumber: 9002 }),
  });
  const outcome = requestProofAmendment(baseRequest(), writeDeps);
  assert.deepEqual(outcome, { kind: "resumed", amendmentUrl: "https://github.com/acme/remudero/pull/9002", amendmentNumber: 9002 });
  assert.equal(writeDeps.calls.createPr, 0);
  assert.equal(writeDeps.calls.worktreeAdd, 0, "a live probe hit short-circuits before ever cutting a worktree");
});

test("a merged amendment requests only an expected-head branch update", () => {
  const writeDeps = fakeWriteDeps();
  const first = requestProofAmendment(baseRequest(), writeDeps);
  assert.equal(first.kind, "created");
  const merged = fakeWriteDeps({
    lookupIdentity: (key) => writeDeps.lookupIdentity(key),
    recordIdentity: writeDeps.recordIdentity,
  });
  // Simulate the amendment PR having merged since the first dispatch: the SAME identity now
  // resolves `merged: true`.
  const key = proofAmendmentIdempotencyKey({ taskId: TASK_ID, prNumber: 5154, headSha: HEAD_SHA, proposal: [validEntry()] });
  const existing = writeDeps.lookupIdentity(key);
  assert.ok(existing, "the first call must have recorded an identity");
  merged.recordIdentity(key, { ...existing!, merged: true });

  const outcome = requestProofAmendment(baseRequest(), merged);
  assert.equal(outcome.kind, "branch_update_requested");
  assert.equal((outcome as { ok: boolean }).ok, true);
  assert.equal(merged.calls.updateBranch, 1);
  assert.equal(merged.calls.worktreeAdd, 0, "a merged amendment must never re-cut a worktree");
  assert.equal(merged.calls.createPr, 0, "a merged amendment must never open a second PR");
  assert.equal(merged.calls.probeExisting, 0, "a recorded merged identity resolves without a live probe");
});

test("the live fix rung calls the proof-amendment parent rather than granting the worker direct write authority", async () => {
  // @source-text-subject: src/run-task.ts — this task's own acceptance criterion 5 IS a grep over
  // this exact file's text (`grep: requestProofAmendment( in src/run-task.ts`), so asserting on
  // its source is the criterion's own subject, not a shortcut around behaviour. Reads the real
  // installed file rather than trusting the diff: the wiring must survive as ordinary source.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const runTaskSrc = readFileSync(join(import.meta.dirname, "..", "src", "run-task.ts"), "utf8");
  assert.match(runTaskSrc, /requestProofAmendment\(/, "the fix rung must call the parent effect directly");
  assert.match(runTaskSrc, /kind:\s*"proof_amendment"/, "the durable fix.dispatch record identifies this amendment subtype");
  assert.doesNotMatch(
    runTaskSrc.match(/if \(mode === "proof-discrimination"\)[\s\S]{0,400}/)?.[0] ?? "",
    /repair the pr body/i,
  );
  const promptRenderSrc = readFileSync(join(import.meta.dirname, "..", "src", "lib", "prompt-render.ts"), "utf8");
  assert.doesNotMatch(promptRenderSrc, /Repair the PR BODY's Acceptance block only/);
  assert.match(promptRenderSrc, /PROOF_AMENDMENT:/, "the worker is asked to PROPOSE, not to write the body itself");

  // The worker's own report grammar (what run-task.ts parses back out) carries no field for a PR
  // body, branch name, or task-file path — only claim/old-proof/new-proof text.
  const parsed = parseProofAmendmentProposal(
    ["PROOF_AMENDMENT:", "1. claim: a claim", "   old_proof: unit test: test/x.test.ts", "   new_proof: grep: x( in src/x.ts", ""].join("\n"),
  );
  assert.deepEqual(parsed, [{ claim: "a claim", oldProof: "unit test: test/x.test.ts", newProof: "grep: x( in src/x.ts" }]);
  assert.deepEqual(Object.keys(parsed[0]!).sort(), ["claim", "newProof", "oldProof"]);
});

test("buildProofAmendmentGitOps runs git add/commit through an injected spawn, never a real process", () => {
  // The write ports `requestProofAmendment` receives for its `gitAdd`/`gitCommit` fields are built
  // here through `execFileSyncFn`, APPENDED LAST and defaulted to the real `execFileSync` in
  // production — this test injects a fake to assert the exact recorded external-tool invocation
  // without ever crossing the process boundary, covering the lines a `diff-cov:` directive cannot
  // exempt for a real spawn.
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const fakeExecFileSync = ((file: string, args: readonly string[]) => {
    calls.push({ file, args });
    return "deadbeefcafefeed\n";
  }) as unknown as typeof import("node:child_process").execFileSync;
  const ops = buildProofAmendmentGitOps(fakeExecFileSync);

  ops.gitAdd("/tmp/proof-amendment-wt", "plan/tasks.d/W1-T3434.yaml");
  const sha = ops.gitCommit("/tmp/proof-amendment-wt", "chore(plan): amend W1-T3434 proof");

  assert.deepEqual(calls, [
    { file: "git", args: ["-C", "/tmp/proof-amendment-wt", "add", "plan/tasks.d/W1-T3434.yaml"] },
    { file: "git", args: ["-C", "/tmp/proof-amendment-wt", "commit", "-m", "chore(plan): amend W1-T3434 proof"] },
    { file: "git", args: ["-C", "/tmp/proof-amendment-wt", "rev-parse", "HEAD"] },
  ]);
  assert.equal(sha, "deadbeefcafefeed", "gitCommit trims the recorded rev-parse output");
});

test("buildProofAmendmentWritePorts wires every write port through its own injected I/O, never a live process/network call", () => {
  // requestProofAmendment's write-ports object used to be built inline inside runFixRung's
  // proof-discrimination arm, closing directly over real process/network I/O with no injection
  // seam a test could reach. buildProofAmendmentWritePorts extracts that construction so every
  // I/O boundary is overridable — this test overrides all of them and drives every port to
  // assert the exact call it forwards, covering the lines a live worktree/GitHub write cannot.
  const logCalls: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const worktreeAddCalls: unknown[] = [];
  const worktreeRemoveCalls: unknown[] = [];
  const writeFileCalls: Array<{ absPath: string; text: string }> = [];
  const gitPushCalls: unknown[] = [];
  const probeCalls: unknown[] = [];
  const createPrCalls: unknown[] = [];
  const isPrMergedCalls: string[] = [];
  const ghExecCalls: unknown[] = [];
  const assertLiveWriteCalls: Array<{ action: string; reason: string }> = [];
  let isPrMergedThrows = false;

  const gitOps = {
    gitAdd: (_wp: string, _relPath: string) => {},
    gitCommit: (_wp: string, _message: string) => "gitopssha",
  };

  const ports = buildProofAmendmentWritePorts(
    {
      taskId: "W1-T3434-FIXTURE",
      worktreePath: "/tmp/proof-amendment-repo",
      config: { root: "/tmp/rmd-root" } as unknown as Config,
      owner: "acme",
      repo: "remudero",
      prNumber: 5154,
      ledgerLinesNow: [
        { step: "fix.dispatch", kind: "proof_amendment", identity_key: "found-key", amendment_url: "https://github.com/acme/remudero/pull/9001", amendment_number: 9001 },
        { step: "fix.dispatch", kind: "proof_amendment", identity_key: "malformed-key", amendment_url: "", amendment_number: 9002 },
      ],
      log: (step, extra) => logCalls.push({ step, extra }),
      gitOps,
    },
    {
      worktreeAddFn: (...args) => {
        worktreeAddCalls.push(args);
      },
      worktreeRemoveFn: (...args) => {
        worktreeRemoveCalls.push(args);
      },
      writeFileFn: (absPath, text) => writeFileCalls.push({ absPath, text }),
      gitPushFn: (...args) => {
        gitPushCalls.push(args);
      },
      probeExistingPlanPrFn: (fetch, owner, repo, headBranch) => {
        probeCalls.push({ owner, repo, headBranch });
        return headBranch === "has-existing" ? { prUrl: "https://github.com/acme/remudero/pull/9010", prNumber: 9010 } : undefined;
      },
      createPlanPrRestFn: (fetch, owner, repo, o) => {
        createPrCalls.push({ owner, repo, o });
        return { prUrl: "https://github.com/acme/remudero/pull/9020", prNumber: 9020 };
      },
      isPrMergedNowFn: (prUrl) => {
        isPrMergedCalls.push(prUrl);
        if (isPrMergedThrows) throw new Error("unreadable merge state");
        return true;
      },
      ghExecFn: ((...args: unknown[]) => {
        ghExecCalls.push(args);
        return Buffer.from("");
      }) as unknown as typeof import("../src/lib/github-transport.js").ghExec,
      assertLiveWriteAllowedFn: (action, reason) => {
        assertLiveWriteCalls.push({ action, reason });
      },
    },
  );

  assert.equal(ports.repoDir, "/tmp/proof-amendment-repo");

  ports.worktreeAdd("/repo", "/wt", "proof-amendment/W1-T3434-FIXTURE-5154");
  assert.equal(worktreeAddCalls.length, 1);
  const worktreeAddArgs = worktreeAddCalls[0] as readonly unknown[];
  assert.deepEqual(worktreeAddArgs.slice(0, 4), ["/repo", "/wt", "proof-amendment/W1-T3434-FIXTURE-5154", "origin/main"]);
  assert.equal(typeof (worktreeAddArgs[4] as { log?: unknown }).log, "function", "worktreeAdd forwards the injected log fn, not a fresh one");

  ports.worktreeRemove("/repo", "/wt");
  assert.deepEqual(worktreeRemoveCalls, [["/repo", "/wt"]]);

  ports.writeFile("/repo/plan/tasks.d/W1-T3434.yaml", "new text");
  assert.deepEqual(writeFileCalls, [{ absPath: "/repo/plan/tasks.d/W1-T3434.yaml", text: "new text" }]);

  assert.equal(ports.gitAdd, gitOps.gitAdd, "gitAdd/gitCommit delegate straight to the injected gitOps, never rebuilt here");
  assert.equal(ports.gitCommit, gitOps.gitCommit);

  ports.gitPush("/wt", "proof-amendment/W1-T3434-FIXTURE-5154", "abc123");
  assert.deepEqual(gitPushCalls, [["/wt", "proof-amendment/W1-T3434-FIXTURE-5154", "abc123"]]);

  assert.equal(ports.probeExisting("no-existing-branch"), undefined);
  assert.deepEqual(ports.probeExisting("has-existing"), { prUrl: "https://github.com/acme/remudero/pull/9010", prNumber: 9010 });
  assert.equal(probeCalls.length, 2);

  const created = ports.createPr({ title: "t", body: "b", head: "h", base: "main" });
  assert.deepEqual(created, { prUrl: "https://github.com/acme/remudero/pull/9020", prNumber: 9020 });
  assert.deepEqual(assertLiveWriteCalls[0], { action: "gh-pr-create", reason: "opening W1-T3434-FIXTURE's proof-amendment PR" });
  assert.equal(createPrCalls.length, 1);

  assert.equal(ports.worktreePathFor("W1-T3434-FIXTURE", 5154), join("/tmp/rmd-root", "worktrees", "proof-amendment-W1-T3434-FIXTURE-5154"));

  // lookupIdentity: no matching row at all.
  assert.equal(ports.lookupIdentity("missing-key"), undefined);
  // lookupIdentity: row found but malformed (empty amendment_url) — still undefined.
  assert.equal(ports.lookupIdentity("malformed-key"), undefined);
  // lookupIdentity: row found and valid — isPrMergedNowFn answers merged.
  assert.deepEqual(ports.lookupIdentity("found-key"), {
    amendmentUrl: "https://github.com/acme/remudero/pull/9001",
    amendmentNumber: 9001,
    merged: true,
  });
  assert.deepEqual(isPrMergedCalls, ["https://github.com/acme/remudero/pull/9001"]);
  // lookupIdentity: an unreadable live merge state (isPrMergedNowFn throws) defaults to un-merged.
  isPrMergedThrows = true;
  assert.deepEqual(ports.lookupIdentity("found-key"), {
    amendmentUrl: "https://github.com/acme/remudero/pull/9001",
    amendmentNumber: 9001,
    merged: false,
  });

  ports.recordIdentity("some-key", { amendmentUrl: "https://github.com/acme/remudero/pull/9020", amendmentNumber: 9020, merged: false });
  assert.deepEqual(logCalls.at(-1), {
    step: "fix.dispatch",
    extra: {
      kind: "proof_amendment",
      task_id: "W1-T3434-FIXTURE",
      pr_number: 5154,
      identity_key: "some-key",
      amendment_url: "https://github.com/acme/remudero/pull/9020",
      amendment_number: 9020,
    },
  });

  const okResult = ports.updateBranch("https://github.com/acme/remudero/pull/5154", "def456");
  assert.deepEqual(okResult, { ok: true });
  assert.equal(ghExecCalls.length, 1);
  assert.equal(assertLiveWriteCalls.at(-1)!.action, "gh-pr-update-branch");

  const failingPorts = buildProofAmendmentWritePorts(
    {
      taskId: "W1-T3434-FIXTURE",
      worktreePath: "/tmp/proof-amendment-repo",
      config: { root: "/tmp/rmd-root" } as unknown as Config,
      owner: "acme",
      repo: "remudero",
      prNumber: 5154,
      ledgerLinesNow: [],
      log: () => {},
      gitOps,
    },
    {
      ghExecFn: (() => {
        throw { stderr: "rejected: non-fast-forward" };
      }) as unknown as typeof import("../src/lib/github-transport.js").ghExec,
      assertLiveWriteAllowedFn: () => {},
    },
  );
  assert.deepEqual(failingPorts.updateBranch("https://github.com/acme/remudero/pull/5154", "def456"), {
    ok: false,
    error: "rejected: non-fast-forward",
  });
});

function baseDispatchParams(over: Partial<Parameters<typeof dispatchProofAmendmentWrite>[0]> = {}): Parameters<typeof dispatchProofAmendmentWrite>[0] {
  return {
    prUrl: PR_URL,
    taskId: TASK_ID,
    worktreePath: "/tmp/proof-amendment-repo",
    config: { root: "/tmp/rmd-root" } as unknown as Config,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/head-checkout" },
    evidence: evidence(),
    transcriptText: [
      "PROOF_AMENDMENT:",
      `1. claim: ${CLAIM}`,
      `   old_proof: ${OLD_PROOF}`,
      `   new_proof: ${NEW_PROOF}`,
      "",
    ].join("\n"),
    review: {
      state: "success",
      capped: true,
      criteria: [{ claim: CLAIM, proof: OLD_PROOF, met: true, reason: "matched", proof_exec: "executed_pass" }],
    },
    priorHeadSha: HEAD_SHA,
    log: () => {},
    getLedgerLinesNow: () => [],
    ...over,
  };
}

test("dispatchProofAmendmentWrite is the whole proof-discrimination arm, extracted out of runFixRung and exercisable without a live git/GitHub write", () => {
  // Proposal parsing and the base-proof build are overridable here; `requestProofAmendment`
  // itself is called for real (this task's own acceptance criteria grep for that exact literal
  // call site in run-task.ts — see the "the live fix rung calls the proof-amendment parent…"
  // test above), but every write IT makes still goes through the injected write ports one layer
  // down (buildProofAmendmentWritePorts), so nothing it does escapes this function's own fakes.
  // This drives the FULL body — early-return on no PR number, early-return on an empty proposal,
  // the success path, and the catch(e) path — the coverage-ratchet flagged as unreachable when
  // everything closed over live process/network I/O with no seam at all.
  const logCalls: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => logCalls.push({ step, extra });

  // No PR number in the URL -> the transcript is still parsed (matches the pre-extraction
  // order — parsing never depended on the PR number) but nothing further runs.
  let parseCalls = 0;
  dispatchProofAmendmentWrite(
    baseDispatchParams({ prUrl: "https://github.com/acme/remudero/not-a-pull-url", log }),
    { parseProofAmendmentProposalFn: (text) => { parseCalls += 1; return parseProofAmendmentProposal(text); } },
  );
  assert.equal(parseCalls, 1);
  assert.deepEqual(logCalls, []);

  // A transcript with no PROOF_AMENDMENT block parses to an empty proposal -> bails out before
  // ever calling buildBaseProofDirFn or touching a write port (findShard included).
  let baseProofCalls = 0;
  let findShardCalls = 0;
  dispatchProofAmendmentWrite(baseDispatchParams({ transcriptText: "no proposal here", log }), {
    buildBaseProofDirFn: () => {
      baseProofCalls += 1;
      return { baseIsCheckout: false } as ReturnType<typeof buildBaseProofDir>;
    },
    findShardFn: () => {
      findShardCalls += 1;
      return undefined;
    },
  });
  assert.equal(baseProofCalls, 0);
  assert.equal(findShardCalls, 0);
  assert.deepEqual(logCalls, []);

  // The success path: a real PR number and a non-empty proposal reach the real
  // `requestProofAmendment`, entirely through the injected write ports — never a live
  // worktree/GitHub call — and its outcome is logged under `proof_amendment.requested`. The
  // proposal's `old_proof` deliberately does not byte-match this `evidence`'s recorded proof, so
  // `requestProofAmendment` refuses deterministically at `claim-not-recognised` — BEFORE it would
  // ever try to execute the replacement proof against a real checkout — while still exercising
  // every wiring line in between: the lazy ledger read, the base-proof build, the git-ops build,
  // the write-ports build, the dispatch call itself, and the final log line.
  logCalls.length = 0;
  let getLedgerLinesCalls = 0;
  let findShardCallsSuccess = 0;
  dispatchProofAmendmentWrite(
    baseDispatchParams({
      log,
      evidence: { proofs: [{ claim: CLAIM, proof: "a completely different old proof", proofExec: "executed_stale" }] },
      getLedgerLinesNow: () => {
        getLedgerLinesCalls += 1;
        return [];
      },
    }),
    {
      buildBaseProofDirFn: () => ({ baseIsCheckout: false }) as ReturnType<typeof buildBaseProofDir>,
      findShardFn: () => {
        findShardCallsSuccess += 1;
        return { path: "plan/tasks.d/W1-T3434-FIXTURE.yaml", text: "shard text" };
      },
    },
  );
  assert.equal(getLedgerLinesCalls, 1, "the ledger is read lazily, only once a real proposal exists");
  assert.equal(findShardCallsSuccess, 1, "reached requestProofAmendment's own shard lookup — real dispatch, real ports");
  assert.deepEqual(logCalls, [
    {
      step: "proof_amendment.requested",
      extra: {
        pr_number: 5154,
        task_id: TASK_ID,
        outcome: "refused",
        kind: "refused",
        reason: "claim-not-recognised",
        detail: `no capped stale-proof row byte-matches this claim/old-proof pair: ${CLAIM}`,
      },
    },
  ]);

  // The catch(e) path: a throw anywhere inside (here: findShardFn, one of the injected write
  // ports) is caught and logged as `proof_amendment.error`, never left to propagate into the
  // caller's ordinary re-review below it.
  logCalls.length = 0;
  dispatchProofAmendmentWrite(baseDispatchParams({ log }), {
    buildBaseProofDirFn: () => ({ baseIsCheckout: false }) as ReturnType<typeof buildBaseProofDir>,
    findShardFn: () => {
      throw new Error("shard lookup exploded");
    },
  });
  assert.deepEqual(logCalls, [{ step: "proof_amendment.error", extra: { error: "shard lookup exploded" } }]);
});

test("renderFixPrompt gives a proof-discrimination worker a proposal grammar, not PR-body write instructions", () => {
  const prompt = renderFixPrompt({
    task: { id: TASK_ID, title: "proof amendment", files: ["src/lib/proof-amendment.ts"] },
    round: 1,
    branch: "run-W1-T3434-1",
    evidence: { proofDiscrimination: evidence() },
  });
  assert.match(prompt, /MODE: proof-discrimination/);
  assert.match(prompt, /THE PLAN, NOT THIS PR'S BODY/i);
  assert.match(prompt, /PROOF_AMENDMENT:/);
  assert.match(prompt, /old_proof:/);
  assert.doesNotMatch(prompt, /Repair the PR BODY's Acceptance block only/);
});

test("checkProofCommand treats a grep target added on the head as discriminating despite base test materialisation", (t) => {
  // Built through the shared fixture (test/helpers/git-repo.ts) rather than a raw git-init call
  // written out here — test/fixture-copy-census.test.ts's gitInitFiles count is a frozen ceiling
  // over test/*.test.ts precisely so a new copy of that boilerplate does not creep back in.
  const repo = gitRepo({ seedCommit: true }); // commit 1 (HEAD~1 below): the merge-base, no target file
  const savedCwd = process.cwd();
  const logs: string[] = [];
  try {
    const target = "test/added-proof.test.ts";
    const marker = "proof-amendment-added-grep-target";
    mkdirSync(join(repo.dir, "test"), { recursive: true });
    writeFileSync(join(repo.dir, target), `${marker}\n`);
    repo.git("add", ".");
    repo.git("commit", "-m", "add proof target"); // commit 2 (HEAD): adds the grep target
    process.chdir(repo.dir);
    t.mock.method(console, "log", (...args: unknown[]) => void logs.push(args.map(String).join(" ")));
    const code = checkProofCommand(["grep:", marker, "in", target, "--base", "HEAD~1"]);
    assert.equal(code, CHECK_PROOF_EXIT.pass, logs.join("\n"));
    assert.match(logs.join("\n"), /base:\s+ABSENT at HEAD~1/);
    assert.match(logs.join("\n"), /discrimination:\s+discriminates/);
  } finally {
    process.chdir(savedCwd);
    repo.cleanup();
  }
});

test("parseProofAmendmentProposal returns nothing for a report with no PROOF_AMENDMENT block", () => {
  assert.deepEqual(parseProofAmendmentProposal("I edited the PR body instead."), []);
  assert.deepEqual(parseProofAmendmentProposal(""), []);
});

test("proofAmendmentIneligibleReason checks the five gates in order", () => {
  assert.equal(proofAmendmentIneligibleReason(eligiblePr({ isOpen: false }), evidence()), "not-open");
  assert.equal(proofAmendmentIneligibleReason(eligiblePr({ planOnly: true }), evidence()), "plan-only-pr");
  assert.equal(proofAmendmentIneligibleReason(eligiblePr({ taskId: undefined }), evidence()), "no-task-trailer");
  assert.equal(proofAmendmentIneligibleReason(eligiblePr({ reviewState: "failure" }), evidence()), "review-not-success");
  assert.equal(proofAmendmentIneligibleReason(eligiblePr({ capped: false }), evidence()), "not-capped");
  assert.equal(
    proofAmendmentIneligibleReason(eligiblePr({ criteria: [{ claim: CLAIM, proof: OLD_PROOF, met: false }] }), evidence()),
    "unmet-criteria",
  );
  assert.equal(proofAmendmentIneligibleReason(eligiblePr(), undefined), "no-evidence");
  assert.equal(proofAmendmentIneligibleReason(eligiblePr(), { proofs: [] }), "no-evidence");
  assert.equal(proofAmendmentIneligibleReason(eligiblePr(), evidence()), undefined);
});

test("validateProofAmendmentProposal is the same gate requestProofAmendment uses internally", () => {
  const ok = validateProofAmendmentProposal([validEntry()], evidence(), {
    headCwd: "/head",
    baseCwd: "/base",
    currentHeadSha: HEAD_SHA,
    pinnedHeadSha: HEAD_SHA,
    planShardPaths: new Set(["plan/tasks.yaml"]),
    ...fakeExecutors(),
  });
  assert.equal(ok.ok, true);
  const badParse = validateProofAmendmentProposal([validEntry({ newProof: "not a whitelisted shape" })], evidence(), {
    headCwd: "/head",
    baseCwd: "/base",
    currentHeadSha: HEAD_SHA,
    pinnedHeadSha: HEAD_SHA,
    planShardPaths: new Set(),
    ...fakeExecutors(),
  });
  assert.equal(badParse.ok, false);
  if (!badParse.ok) assert.equal(badParse.refusal.reason, "parse-error");
});

test("replaceProofScalar touches only the proof line under its own claim, never the claim text", () => {
  const shard = [
    "- id: W1-T3434-FIXTURE",
    "  acceptance:",
    `    - claim: "${CLAIM}"`,
    `      proof: "${OLD_PROOF}"`,
    "    - claim: \"a second, unrelated claim\"",
    "      proof: \"unit test: test/other.test.ts\"",
  ].join("\n");
  const replaced = replaceProofScalar(shard, CLAIM, OLD_PROOF, NEW_PROOF);
  assert.ok(replaced);
  assert.match(replaced!, new RegExp(`claim: "${CLAIM}"`));
  assert.match(replaced!, /proof: "grep: renderWidget\( in src\/widget\.ts"/);
  assert.match(replaced!, /a second, unrelated claim/);
  assert.match(replaced!, /unit test: test\/other\.test\.ts/, "the unrelated criterion's proof is untouched");
  // Drift: the exact old-proof text is no longer present.
  assert.equal(replaceProofScalar(shard, CLAIM, "unit test: test/gone.test.ts", NEW_PROOF), undefined);
});

test("proofAmendmentIdempotencyKey is keyed on the OLD-proof digest, not the proposed replacement", () => {
  // Design: "a durable idempotency key over task id, implementation PR number, head SHA and
  // old-proof digest" — deliberately over the STALE proof being replaced, not the candidate
  // replacement text, so a re-dispatch proposing a differently-worded fix for the SAME defect
  // still resumes the one amendment already in flight rather than opening a second.
  const identity = { taskId: TASK_ID, prNumber: 5154, headSha: HEAD_SHA, proposal: [validEntry()] };
  const key1 = proofAmendmentIdempotencyKey(identity);
  const key2 = proofAmendmentIdempotencyKey(identity);
  assert.equal(key1, key2, "identical input is a stable, durable key");
  assert.equal(
    key1,
    proofAmendmentIdempotencyKey({ ...identity, proposal: [validEntry({ newProof: "grep: other( in src/x.ts" })] }),
    "a different PROPOSED replacement for the same old proof is the same identity",
  );
  assert.notEqual(key1, proofAmendmentIdempotencyKey({ ...identity, headSha: "a-new-head" }));
  assert.notEqual(key1, proofAmendmentIdempotencyKey({ ...identity, proposal: [validEntry({ oldProof: "unit test: test/other.test.ts" })] }));
  assert.notEqual(key1, proofAmendmentIdempotencyKey({ ...identity, prNumber: 5155 }));
});

test("findTaskShard reads the plan/tasks.d shard by task-id prefix, matching dispatchPlanOnlyRepair's own convention", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const repoDir = mkdtempSync(join(tmpdir(), "rmd-proof-amendment-"));
  mkdirSync(join(repoDir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repoDir, "plan", "tasks.d", `${TASK_ID}-a-fixture.yaml`), `- id: ${TASK_ID}\n`);
  const found = findTaskShard(repoDir, TASK_ID);
  assert.ok(found);
  assert.equal(found!.path, join("plan", "tasks.d", `${TASK_ID}-a-fixture.yaml`));
  assert.equal(findTaskShard(repoDir, "W1-T-NOT-PRESENT"), undefined);
});
