import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  filesDigest,
  loadReconArtifact,
  planSha,
  reconArtifactToContext,
  runTask,
  writeReconArtifact,
  type ReconArtifact,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";

// ── W1-T2241: a recon that dies with its dispatch is paid for again — this fixture drives the
// REAL runTask() dispatch path, more than once against the SAME `config.root`/repo clone (state/
// must persist across dispatches for reuse to mean anything), exactly like
// test/recon-degrade.test.ts's own real-git fixture but kept across calls instead of thrown away
// after one. ──────────────────────────────────────────────────────────────────────────────────

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

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

const TASK_ID = "T-RECON-ARTIFACT";

// W1-T2510: the task's own record now lives INSIDE the worktree's `plan/` tree too (a shard
// under `plan/tasks.d/`), not only at the separate `opts.planPath` this fixture already used to
// tell the orchestrator which task to select. `taskRecordSha` (the new `plan_sha` key component)
// reads it from the WORKTREE, exactly like `planSha`/`filesDigest` always have — a fixture that
// never committed a task record into `plan/` would make every dispatch see it as ABSENT and
// therefore never eligible to reuse at all, which would make dispatch 2 below (same task record,
// same files — a reuse) fail for a reason unrelated to what it is testing.
const TASK_RECORD_SHARD_REL = "plan/tasks.d/t-recon-artifact.yaml";

const FIXTURE_PLAN = [
  `- id: ${TASK_ID}`,
  "  title: recon-artifact reuse probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/widget.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

/** A real, throwaway bare "origin" + a real clone at `repoDir`, seeded with a `plan/` dir (an
 *  unrelated `note.md` PLUS the task's own record shard), and the task's own declared
 *  `src/widget.ts` — all three are the SAME worktree-relative paths `planSha`/`taskRecordSha`/
 *  `filesDigest` hash, so a later push through `seed` changes the exact bytes the invalidation
 *  predicate reads. Returns `seed`, a live working clone pushed straight to `origin`, so a later
 *  dispatch's `worktreeAdd` (which fetches before checkout) sees the change. */
function gitFixture(root: string): { repoDir: string; seed: string } {
  const originGit = mkdtempSync(join(tmpdir(), "runtask-recon-artifact-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "runtask-recon-artifact-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "recon-artifact-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "recon-artifact-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "src", "widget.ts"), "export const widget = 1;\n");
  mkdirSync(join(seed, "plan"), { recursive: true });
  writeFileSync(join(seed, "plan", "note.md"), "v1\n");
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed, TASK_RECORD_SHARD_REL), FIXTURE_PLAN);
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "recon-artifact-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "recon-artifact-test"]);
  return { repoDir, seed };
}

/** Commit + push one more change through `seed` — simulates a plan edit or a declared-file
 *  edit landing on `main` between two dispatches of the SAME task. */
function pushChange(seed: string, relPath: string, content: string): void {
  const p = join(seed, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", `update ${relPath}`]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
}

/** A fake `gh` on PATH answering the handful of subcommands each dispatch reaches, red on CI so
 *  every dispatch reaches its terminal verdict right after the implement spawn (mirrors
 *  test/recon-degrade.test.ts's own `fakeGh`). `$3` (the ref) is echoed back verbatim rather
 *  than matched against one fixed branch, so the SAME fake serves every dispatch regardless of
 *  that dispatch's own `run-<id>-<ts>` branch name. */
function fakeGh(): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "runtask-recon-artifact-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      "  if [[ \"$5\" == 'headRefName' ]]; then echo '{\"headRefName\":\"'$3'\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'; exit 0; fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

/** Dispatch this task once against a possibly-already-seeded `root`. `ts` fixes `Date.now()`
 *  (and thus `runId`/branch) so sequential dispatches never collide on a worktree branch. */
async function dispatchOnce(
  t: import("node:test").TestContext,
  root: string,
  spawn: typeof spawnWorker,
  ts: number,
): Promise<{ res: Awaited<ReturnType<typeof runTask>>; ledger: Array<Record<string, unknown>> }> {
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };

  const fakeBinDir = fakeGh();
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const dateNowSpy = t.mock.method(Date, "now", () => ts);

  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  try {
    const res = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );
    const allLedger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const ledger = allLedger.filter((l) => l.run_id === res.runId);
    return { res, ledger };
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
  }
}

// ── FULL LIFECYCLE: absent → reused → invalidated(plan_sha) ─────────────────────────────────

test("BEHAVIORAL: absent → reused → plan_sha-invalidated, across three real dispatches of the same task", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-recon-artifact-root-"));
  const { seed } = gitFixture(root);

  try {
    // ── Dispatch 1: no prior artifact — a full recon runs and its own success WRITES one.
    const spawnCalls1: SpawnWorkerArgs[] = [];
    const spawn1: typeof spawnWorker = async (args) => {
      spawnCalls1.push(args);
      if (spawnCalls1.length === 1) {
        return result({
          sessionId: "s-recon-1",
          text:
            "RECON REPORT\nOBSERVED: the repo has a src/widget.ts\n" +
            "INFERRED: this project ships a widget\n" +
            "COULDN'T-VERIFY: whether the widget is load-bearing\n",
        });
      }
      return result({ sessionId: "s-implement-1", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
    };
    const { ledger: ledger1 } = await dispatchOnce(t, root, spawn1, 1785200000001);

    assert.equal(spawnCalls1.length, 2, "dispatch 1: a real recon spawns (no artifact to reuse), then implement");
    assert.equal(ledger1.filter((l) => l.step === "recon.absent").length, 1, "a first dispatch with no artifact reads recon.absent");
    assert.equal(ledger1.filter((l) => l.step === "recon.reused").length, 0);
    assert.equal(ledger1.filter((l) => l.step === "recon.invalidated").length, 0);
    assert.equal(ledger1.filter((l) => l.step === "recon.done").length, 1, "the real recon still ledgers recon.done as before");

    const artifactPath = join(root, "state", "recon-artifacts", `${TASK_ID}.json`);
    const artifact1: ReconArtifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    assert.equal(artifact1.task_id, TASK_ID);
    assert.match(artifact1.observed, /the repo has a src\/widget\.ts/);
    assert.match(artifact1.inferred, /this project ships a widget/);
    assert.match(artifact1.couldnt_verify, /whether the widget is load-bearing/);

    // ── Dispatch 2: SAME plan/ and SAME declared files — the artifact is VALID. Recon must be
    // skipped entirely (only the implement spawn happens), and the reuse is ledgered by its own
    // step, distinct from recon.done/.absent/.invalidated.
    const spawnCalls2: SpawnWorkerArgs[] = [];
    const spawn2: typeof spawnWorker = async (args) => {
      spawnCalls2.push(args);
      return result({ sessionId: "s-implement-2", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/2\n" });
    };
    const { ledger: ledger2 } = await dispatchOnce(t, root, spawn2, 1785200000002);

    assert.equal(spawnCalls2.length, 1, "dispatch 2: recon is SKIPPED — only the implement spawn happens");
    assert.equal(ledger2.filter((l) => l.step === "recon.reused").length, 1, "the reuse is ledgered under its own step");
    assert.equal(ledger2.filter((l) => l.step === "recon.done").length, 0, "no recon.done — recon never ran this dispatch");
    assert.equal(ledger2.filter((l) => l.step === "recon.absent").length, 0);
    assert.equal(ledger2.filter((l) => l.step === "recon.invalidated").length, 0);

    const implementPrompt2 = String(spawnCalls2[0].prompt);
    assert.match(implementPrompt2, /the repo has a src\/widget\.ts/, "the artifact's OBSERVED line reaches the implement prompt");
    assert.match(implementPrompt2, /whether the widget is load-bearing/, "and its COULDN'T-VERIFY line, same as a live recon");
    assert.doesNotMatch(implementPrompt2, /this project ships a widget/, "INFERRED never travels — same rule as a live recon");
    assert.match(implementPrompt2, /VERIFY-AND-EXTEND/, "the artifact is framed as evidence to verify, never authority to build on unchecked");

    // ── Dispatch 3: the TASK'S OWN record shard changes on main (W1-T2510: narrowed plan_sha
    // reads only this file, not the whole plan/ dir) — the SAME artifact must now be
    // INVALIDATED, not reused, and a full recon runs again.
    pushChange(seed, TASK_RECORD_SHARD_REL, FIXTURE_PLAN.replace("medium", "high"));
    const spawnCalls3: SpawnWorkerArgs[] = [];
    const spawn3: typeof spawnWorker = async (args) => {
      spawnCalls3.push(args);
      if (spawnCalls3.length === 1) {
        return result({
          sessionId: "s-recon-3",
          text: "RECON REPORT\nOBSERVED: the task's own record now reads risk high\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
        });
      }
      return result({ sessionId: "s-implement-3", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/3\n" });
    };
    const { ledger: ledger3 } = await dispatchOnce(t, root, spawn3, 1785200000003);

    assert.equal(spawnCalls3.length, 2, "dispatch 3: plan_sha moved, so a full recon runs again, then implement");
    const invalidated3 = ledger3.filter((l) => l.step === "recon.invalidated");
    assert.equal(invalidated3.length, 1, "the moved plan_sha invalidates the prior artifact, exactly once");
    assert.equal(invalidated3[0].reason, "plan_sha", "the invalidation names WHICH key component moved");
    assert.equal(ledger3.filter((l) => l.step === "recon.reused").length, 0, "an invalidated artifact is never reused");
    assert.equal(ledger3.filter((l) => l.step === "recon.absent").length, 0, "invalidated is distinct from absent — a prior artifact DID exist");

    const implementPrompt3 = String(spawnCalls3[1].prompt);
    assert.match(implementPrompt3, /the task's own record now reads risk high/, "the FRESH recon's own OBSERVED line reaches the prompt");
    assert.doesNotMatch(implementPrompt3, /VERIFY-AND-EXTEND/, "a fresh recon is not framed as a reused artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(seed, { recursive: true, force: true });
  }
});

// ── files_digest INVALIDATION (the OTHER key component) ─────────────────────────────────────

test("BEHAVIORAL: a change to the task's own declared files invalidates the artifact by files_digest, not plan_sha", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-recon-artifact-files-root-"));
  const { seed } = gitFixture(root);

  try {
    const spawnCalls1: SpawnWorkerArgs[] = [];
    const spawn1: typeof spawnWorker = async (args) => {
      spawnCalls1.push(args);
      if (spawnCalls1.length === 1) {
        return result({ sessionId: "s-recon-1", text: "RECON REPORT\nOBSERVED: widget is v1\nINFERRED: n/a\nCOULDN'T-VERIFY: n/a\n" });
      }
      return result({ sessionId: "s-implement-1", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
    };
    await dispatchOnce(t, root, spawn1, 1785200100001);

    // The declared file itself changes — plan/ is untouched.
    pushChange(seed, "src/widget.ts", "export const widget = 2;\n");

    const spawnCalls2: SpawnWorkerArgs[] = [];
    const spawn2: typeof spawnWorker = async (args) => {
      spawnCalls2.push(args);
      if (spawnCalls2.length === 1) {
        return result({ sessionId: "s-recon-2", text: "RECON REPORT\nOBSERVED: widget is v2\nINFERRED: n/a\nCOULDN'T-VERIFY: n/a\n" });
      }
      return result({ sessionId: "s-implement-2", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/2\n" });
    };
    const { ledger: ledger2 } = await dispatchOnce(t, root, spawn2, 1785200100002);

    assert.equal(spawnCalls2.length, 2, "the changed declared file invalidates reuse — a full recon runs again");
    const invalidated2 = ledger2.filter((l) => l.step === "recon.invalidated");
    assert.equal(invalidated2.length, 1);
    assert.equal(invalidated2[0].reason, "files_digest", "this invalidation is attributed to files_digest, not plan_sha");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(seed, { recursive: true, force: true });
  }
});

// ── UNIT: the digest primitives themselves ───────────────────────────────────────────────────

test("planSha changes iff plan/ content changes; filesDigest changes iff a declared file's content changes", () => {
  const root = mkdtempSync(join(tmpdir(), "digest-unit-"));
  try {
    mkdirSync(join(root, "plan"), { recursive: true });
    writeFileSync(join(root, "plan", "a.md"), "hello\n");
    writeFileSync(join(root, "src.ts"), "export const x = 1;\n");

    const sha1 = planSha(root);
    const digest1 = filesDigest(root, ["src.ts"]);
    // Unrelated file (outside plan/, not declared) changes — neither digest moves.
    writeFileSync(join(root, "unrelated.txt"), "noise\n");
    assert.equal(planSha(root), sha1, "an unrelated file outside plan/ does not move plan_sha");
    assert.equal(filesDigest(root, ["src.ts"]), digest1, "an undeclared file does not move files_digest");

    writeFileSync(join(root, "plan", "a.md"), "hello again\n");
    assert.notEqual(planSha(root), sha1, "editing a file under plan/ moves plan_sha");
    assert.equal(filesDigest(root, ["src.ts"]), digest1, "and does NOT move files_digest — the two components are independent");

    writeFileSync(join(root, "src.ts"), "export const x = 2;\n");
    assert.notEqual(filesDigest(root, ["src.ts"]), digest1, "editing a declared file moves files_digest");

    // A declared file that does not exist yet (forward reference) never throws, and its later
    // creation is itself a digest change.
    const beforeCreate = filesDigest(root, ["not-yet-created.ts"]);
    writeFileSync(join(root, "not-yet-created.ts"), "export const y = 1;\n");
    assert.notEqual(filesDigest(root, ["not-yet-created.ts"]), beforeCreate, "a declared file's creation moves its digest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── UNIT: a corrupt or missing artifact reads as ABSENT, never fatal ─────────────────────────

test("a missing or corrupt artifact file loads as undefined (absent), never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-corrupt-"));
  try {
    assert.equal(loadReconArtifact(root, "T-NOTHING-WRITTEN"), undefined, "no file at all — absent");

    const p = join(root, "state", "recon-artifacts", "T-CORRUPT.json");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ this is not valid json");
    assert.equal(loadReconArtifact(root, "T-CORRUPT"), undefined, "unparseable JSON — absent, not thrown");

    writeFileSync(p, JSON.stringify({ task_id: "T-CORRUPT", plan_sha: "x" })); // missing required fields
    assert.equal(loadReconArtifact(root, "T-CORRUPT"), undefined, "a shape missing required fields — absent");

    const good: ReconArtifact = {
      task_id: "T-CORRUPT",
      plan_sha: "x",
      files_digest: "y",
      observed: "o",
      inferred: "i",
      couldnt_verify: "c",
      written_at: "2026-08-25T00:00:00.000Z",
      run_id: "r1",
    };
    writeReconArtifact(root, good);
    assert.deepEqual(loadReconArtifact(root, "T-CORRUPT"), good, "a well-formed artifact round-trips exactly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── UNIT: the rendered CONTEXT block preserves the OBSERVED/INFERRED/COULDN'T-VERIFY bands as
// distinct — a prompt may cite only OBSERVED (+ COULDN'T-VERIFY, framed as a gap), and INFERRED
// must never be indistinguishable from an observation once relayed (the same rule
// reconObservedToContext already enforces for a LIVE recon — see its own doc). ──────────────

test("reconArtifactToContext relays OBSERVED and COULDN'T-VERIFY, never INFERRED, and frames every line as evidence to verify", () => {
  const artifact: ReconArtifact = {
    task_id: "T-BANDS",
    plan_sha: "p",
    files_digest: "f",
    observed: "the repo has a README",
    inferred: "the project is well documented",
    couldnt_verify: "whether the README is accurate",
    written_at: "2026-08-25T00:00:00.000Z",
    run_id: "r1",
  };
  const ctx = reconArtifactToContext(artifact, "T-BANDS", undefined);
  assert.match(ctx, /the repo has a README/, "OBSERVED travels");
  assert.match(ctx, /whether the README is accurate/, "COULDN'T-VERIFY travels, marked as a gap");
  assert.doesNotMatch(ctx, /the project is well documented/, "INFERRED never travels");
  assert.match(ctx, /VERIFY-AND-EXTEND/, "framed as evidence, not authority");
  assert.match(ctx, /\[src: recon#T-BANDS\]/, "every relayed line stays cited (assertProvenance's gate)");
});

// ── STATIC: the source actually implements the three new ledger steps this task mints ───────

test("recon.reused, recon.absent and recon.invalidated are all real ledger steps in src/run-task.ts", () => {
  assert.match(runTaskSrc, /log\("recon\.reused"/, "recon.reused must be a real ledger line");
  assert.match(runTaskSrc, /log\("recon\.absent"/, "recon.absent must be a real ledger line");
  assert.match(runTaskSrc, /log\("recon\.invalidated"/, "recon.invalidated must be a real ledger line");
});
