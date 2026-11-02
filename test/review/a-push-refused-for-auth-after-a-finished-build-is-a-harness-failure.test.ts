import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import { keptRunHeadRef, pendingWorkerBoundaryHandoffs, unpushedRunHeadKeptRow } from "#src/lib/daemon.js";
import { PushAuthRefusedError, PushFailedError, PUSH_AUTH_REFUSED_STEP, worktreePushExecAsync } from "#src/lib/git-push.js";
import { PUSH_AUTH_REFUSAL_RE, PUSH_AUTH_REFUSED, streakRefusal } from "#src/lib/non-worker-verdict.js";
import { startCredentialHelperSocket, type BoundaryLedgerRow } from "#src/lib/secret-boundary.js";
import { nonWorkerVerdictClass } from "#src/lib/stranded-task-detector.js";
import { withTempDir } from "#src/lib/tmp.js";
import { restoreBoundaryCheckpoint } from "#src/cli/commands/run-task-verb.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SENTINEL = "ghs_SENTINELsentinelSENTINEL0000";
const CONSOLE_T127_STDERR = "remote: Repository not found.\nfatal: repository 'https://github.com/craigoley/remudero-console.git/' not found\n";
const refusedPush = (worktree: string) =>
  Object.assign(new Error(`Command failed: git -C ${worktree} push origin HEAD`), { stderr: CONSOLE_T127_STDERR });
const HELPER = join(REPO_ROOT, "scripts", "git-credential-socket-helper.mjs");

type Row = { step: string } & Record<string, unknown>;

test("W1-T10749: a push refused for auth is retried once and ledgers only credential metadata", async () => {
  await withTempDir("push-auth-retry", async (dir) => {
    const socketRows: BoundaryLedgerRow[] = [];
    const handle = await startCredentialHelperSocket({ socketPath: join(dir, "cred.sock"), log: (row) => socketRows.push(row),
      mint: async () => ({ ok: true, token: SENTINEL, expiresAtMs: Date.parse("2026-11-02T12:24:24.388Z") }) });
    try {
      const rows: Row[] = [];
      const verdicts = { dir, log: (step: string, extra: Record<string, unknown>) => void rows.push({ step, ...extra }), recipe: () => undefined };
      const worktree = join(dir, "run-CONSOLE-T127-1793037108107");
      let calls = 0;
      const push = async (_path: string, _args: readonly string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        calls++;
        const answer = await new Promise<string>((resolve, reject) => {
          const child = execFile(process.execPath, [HELPER, handle.socketPath, "get"], { env: { ...process.env, ...opts?.env }, encoding: "utf8", timeout: 20_000 },
            (error, stdout) => (error ? reject(error) : resolve(stdout)));
          child.stdin?.end("protocol=https\nhost=github.com\npath=craigoley/remudero-console.git\n");
        });
        assert.match(answer, /^password=/m, "git still receives the credential it asked for");
        assert.doesNotMatch(answer, /^rmd_/m, "the receipt lines never reach git");
        if (calls === 1) throw refusedPush(worktree);
        return "";
      };
      await worktreePushExecAsync(worktree, { prGates: false, verdicts, push, refreshAmbient: async () => assert.fail("a socket credential is re-minted, never refreshed") })(
        "git", ["-C", worktree, "push", "origin", "HEAD"], { stdio: "ignore" });
      assert.equal(calls, 2, "one refusal, one retry");
      const refused = rows.filter((row) => row.step === PUSH_AUTH_REFUSED_STEP);
      assert.deepEqual(refused.map((row) => [row.attempt, row.outcome]), [[1, "retrying"], [2, "pushed"]]);
      for (const row of refused) {
        assert.equal(row.credential_path, "socket");
        assert.equal(row.scope, "craigoley/remudero-console");
        assert.equal(row.expires_at, "2026-11-02T12:24:24.388Z");
        assert.equal(typeof row.age_ms, "number");
      }
      assert.ok(socketRows.every((row) => row.credential?.consumer === "run-CONSOLE-T127-1793037108107"), "each mint names its consumer");
      assert.doesNotMatch(JSON.stringify([rows, socketRows]), new RegExp(SENTINEL), "no ledger row carries the token");

      const ambientRows: Row[] = [];
      let refreshes = 0;
      const stillRefused = async () => { throw refusedPush(worktree); };
      const thrown = await Promise.resolve(worktreePushExecAsync(worktree, { prGates: false, push: stillRefused, refreshAmbient: async () => { refreshes++; },
        verdicts: { ...verdicts, log: (step: string, extra: Record<string, unknown>) => void ambientRows.push({ step, ...extra }) } })(
        "git", ["-C", worktree, "push", "origin", "HEAD"], { stdio: "ignore" })).then(() => undefined, (error: unknown) => error);
      assert.ok(thrown instanceof PushAuthRefusedError, "still refused after the retry is a push-auth refusal");
      assert.equal(refreshes, 1, "the ambient token is refreshed once before its retry");
      assert.deepEqual(ambientRows.map((row) => [row.credential_path, row.scope, row.outcome]),
        [["ambient", "installation", "retrying"], ["ambient", "installation", "refused"]]);
      assert.doesNotMatch(String((thrown as Error).message), new RegExp(SENTINEL));

      let nonFastForward = 0;
      const rejected = await Promise.resolve(worktreePushExecAsync(worktree, { prGates: false, verdicts, push: async () => {
        nonFastForward++;
        throw Object.assign(new Error(`Command failed: git -C ${worktree} push origin HEAD`), { stderr: " ! [rejected] HEAD -> run (non-fast-forward)\n" });
      } })("git", ["-C", worktree, "push", "origin", "HEAD"], { stdio: "ignore" })).then(() => undefined, (error: unknown) => error);
      assert.equal(nonFastForward, 1, "a non-fast-forward refusal is never retried here");
      assert.ok(rejected instanceof PushFailedError && !(rejected instanceof PushAuthRefusedError));
    } finally {
      await handle.close();
    }
  });
});

test("W1-T10749: a push refused for auth is a non-worker strike", () => {
  const worktree = "/home/node/Remudero/worktrees/run-CONSOLE-T127-1793037108107";
  const reason = `Command failed: git -C ${worktree} push origin HEAD\n${CONSOLE_T127_STDERR}\n${CONSOLE_T127_STDERR}`;
  assert.equal(PUSH_AUTH_REFUSAL_RE.test(CONSOLE_T127_STDERR), true);
  assert.equal(PUSH_AUTH_REFUSAL_RE.test(" ! [rejected] HEAD -> run (non-fast-forward)"), false);
  const rows = [
    { step: "verdict", task_id: "CONSOLE-T127", verdict: "failed", stage: "run.error", cause: "git-push-failed", reason },
    { step: "verdict", task_id: "CONSOLE-T134", verdict: "failed", stage: "run.error", cause: "git-push-failed",
      reason: "Command failed: git -C /home/node/Remudero/worktrees/run-CONSOLE-T134-1791968576525 push origin HEAD\nremote: Repository not found." },
    { step: "verdict", task_id: "PORTAL-T45", verdict: "failed", stage: "run.error", cause: "push-auth-refused", reason },
  ];
  for (const row of rows) {
    assert.equal(streakRefusal(row), PUSH_AUTH_REFUSED, `${row.task_id} does not spend the breaker`);
    assert.equal(nonWorkerVerdictClass(row), PUSH_AUTH_REFUSED, `${row.task_id} reads as the harness's`);
  }
  const workerMiss = { step: "verdict", verdict: "failed", stage: "run.error", cause: "git-push-failed", reason: "Command failed: git push\n ! [rejected] (non-fast-forward)" };
  assert.equal(streakRefusal(workerMiss), undefined);
  assert.equal(nonWorkerVerdictClass(workerMiss), undefined);
});

test("W1-T10749: an auth-refused build resumes straight to push", async () => {
  const origin = gitRepo({ bare: true, kind: "push-auth-origin" });
  const seed = gitRepo({ kind: "push-auth-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "push-auth-clone" });
  try {
    const built = "run-W1-T10749-1793037108107";
    clone.git("checkout", "--quiet", "-b", built);
    clone.git("commit", "--quiet", "--allow-empty", "-m", "the finished build");
    const headSha = clone.git("rev-parse", "HEAD");
    const restored = { branch: "run-W1-T10749-1792019257010", headSha: clone.git("rev-parse", "main") };
    const kept = unpushedRunHeadKeptRow("W1-T10749", built, headSha, "run.error");
    assert.equal(kept.source_branch, built, "the run's OWN branch, not the restored one");
    assert.equal(kept.head_sha, headSha);
    assert.equal(kept.resume_at, "push");
    clone.git("update-ref", keptRunHeadRef(built), headSha);
    clone.git("checkout", "--quiet", "main");
    clone.git("branch", "--quiet", "-D", built);

    const ledger = [
      { step: "implement.checkpoint_kept", task_id: "W1-T10749", source_branch: restored.branch, head_sha: restored.headSha },
      { step: "verdict", task_id: "W1-T10749", verdict: "failed", stage: "run.error", cause: "push-auth-refused" },
      { step: "implement.checkpoint_kept", ...kept },
    ].map((row) => JSON.stringify(row));
    const pending = pendingWorkerBoundaryHandoffs(ledger).get("W1-T10749");
    assert.deepEqual(pending, { branch: built, headSha, resumePhase: "preopen" }, "the next dispatch resumes past implement, at pre-open and push");

    const resume = clone.addWorktree(join(clone.dir, "resume-wt"),"run-W1-T10749-1793037999999", "origin/main");
    const steps: string[] = [];
    const result = await restoreBoundaryCheckpoint(pending!, "W1-T10749", async (args) => resume.git(...args), (step) => void steps.push(step));
    assert.equal(result.headSha, headSha, "the unpushed head is restored from its kept ref with no fetch from origin");
    assert.ok(steps.includes("implement.checkpoint_restored_local"));
    assert.ok(!steps.includes("implement.checkpoint_dropped"));
    assert.equal(resume.git("rev-parse", "HEAD"), headSha);
  } finally {
    for (const repo of [clone, seed, origin]) repo.cleanup();
  }
});
