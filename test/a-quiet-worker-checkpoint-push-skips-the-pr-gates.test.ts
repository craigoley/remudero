// W1-T8397: #10862 let the restart-yield checkpoint push skip the PR pre-push gate (`{ prGates: false }`), but the
// `watchDispatchSpawn` `endRound` round end (W1-T7807 quiet worker, #10925 container recycle, W1-T8139 latched restart)
// still pushed through `gitPushRunBranchAsync(cwd)` with the gates on. Live on 2026-10-12T10:27:43Z, run
// W1-T7735-1791794991696 ledgered `worker.recycle_yield` action_failed: rule15-precheck refused the checkpoint push and
// nothing was pushed. A checkpoint opens no PR, so every checkpoint push skips the PR gate.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { QuietWatchdogHandle, QuietWatchdogOptions } from "../src/lib/quiet-worker-watchdog.js";
import { gitPushRunBranchAsync, type PushRunBranchAsyncOpts } from "../src/lib/git-push.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { commitAndPushRestartCheckpoint, watchDispatchSpawn } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const idle: QuietWatchdogHandle = { observer: () => {}, tick: async () => {}, start: () => () => {} };

/** The watchdog options `watchDispatchSpawn` builds, so a test can call its `endRound` directly. */
function endRoundFor(cwd: string, seams: Parameters<typeof watchDispatchSpawn>[2]): NonNullable<QuietWatchdogOptions["endRound"]> {
  const captured: QuietWatchdogOptions[] = [];
  watchDispatchSpawn((async () => "raw") as never, {
    enabled: true, taskId: "W1-T8397", runId: "W1-T8397-1", ledgerPath: "/state/ledger.ndjson", fallbackBoundMs: 60_000,
    spawnArgs: { cwd, settingsFile: join(cwd, "settings.json") } as never,
    task: { files: ["src/a.ts"], acceptance: [] } as never,
    provider: () => "claude",
    log: () => {},
  }, { ...seams, runWatchdog: ((options: QuietWatchdogOptions) => { captured.push(options); return idle; }) as never });
  const endRound = captured[0]?.endRound;
  assert.ok(endRound, "watchDispatchSpawn wires an endRound");
  return endRound;
}

/** A harness pre-push hook that refuses every push, as rule15-precheck refused W1-T7735's checkpoint. */
function refusingGate(t: TestContext): void {
  const hooks = mkdtempSync(join(tmpdir(), "rmd-t8397-hooks-"));
  writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho 'rule15-precheck: THIS DIFF WILL BE REFUSED' >&2\nexit 1\n");
  chmodSync(join(hooks, "pre-push"), 0o755);
  const prior = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.RMD_HARNESS_HOOKS_DIR = hooks;
  t.after(() => { if (prior === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR; else process.env.RMD_HARNESS_HOOKS_DIR = prior; });
}

test("W1-T8397: the quiet-worker checkpoint push skips the PR gates", async () => {
  const pushes: Array<{ cwd: string; opts: PushRunBranchAsyncOpts | undefined }> = [];
  const push = (async (cwd: string, opts?: PushRunBranchAsyncOpts) => { pushes.push({ cwd, opts }); }) as typeof gitPushRunBranchAsync;
  const endRound = endRoundFor("/wt", {
    hasUncommittedChanges: (() => true) as never,
    commit: (() => ({ committed: true, undeclared: [] })) as never,
    push,
    headSha: () => "c".repeat(40),
  });
  // Every trigger that ends a round mid-worker: the quiet worker, the #10925 container recycle, the W1-T8139 latched restart.
  for (const trigger of [undefined, "recycle", "restart"] as const) {
    assert.deepEqual(await endRound("round end", trigger), { ended: true, checkpointSha: "c".repeat(40) });
  }
  assert.deepEqual(pushes, [
    { cwd: "/wt", opts: { prGates: false } },
    { cwd: "/wt", opts: { prGates: false } },
    { cwd: "/wt", opts: { prGates: false } },
  ], "each round-end checkpoint push skips the PR gate");

  // The restart-yield checkpoint (#10862) pushes the same way, through the same helper.
  pushes.length = 0;
  await commitAndPushRestartCheckpoint("/wt2", { files: [] }, "W1-T8397", "worker", { push, hasUncommittedChanges: () => false });
  assert.deepEqual(pushes, [{ cwd: "/wt2", opts: { prGates: false } }]);
});

test("W1-T8397: a checkpoint a PR gate would refuse still reaches origin", async (t) => {
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.addRemote("origin", origin.dir);
  seed.git("push", "origin", "main");
  const wt = gitRepo({ cloneFrom: origin.dir });
  wt.git("config", "user.name", "fixture");
  wt.git("config", "user.email", "fixture@remudero.invalid");
  wt.git("config", "core.hooksPath", "hooks"); // a worktree whose config enables hooks: the push leaf runs the harness gate
  const branch = "run-W1-T8397-1791800000000";
  wt.git("checkout", "-b", branch);
  refusingGate(t);

  // Control: the gate is live, so an ordinary (PR) push of this branch is refused and nothing reaches origin.
  await assert.rejects(withLiveWritesAllowed(() => gitPushRunBranchAsync(wt.dir, { stdio: "ignore" })), /refused this push/);
  assert.equal(origin.git("for-each-ref", `refs/heads/${branch}`), "", "the refused push sent nothing");

  // The round's work is on disk, uncommitted, when a container recycle ends the round.
  mkdirSync(join(wt.dir, "src"), { recursive: true });
  writeFileSync(join(wt.dir, "src/a.ts"), "export const kept = 1;\n");
  const endRound = endRoundFor(wt.dir, {});
  const ended = await withLiveWritesAllowed(() => endRound("PAUSE requested: container recycle", "recycle"));
  assert.equal(ended.ended, true, `the round ends handed off: ${JSON.stringify(ended)}`);
  assert.ok(ended.ended);
  assert.equal(origin.git("rev-parse", `refs/heads/${branch}`), ended.checkpointSha, "the checkpoint reached origin");
  assert.equal(origin.git("show", `${branch}:src/a.ts`), "export const kept = 1;");
  assert.match(origin.git("log", "-1", "--format=%B", branch), /^chore\(checkpoint\): yield at container recycle\n[\s\S]*Remudero-Task: W1-T8397/);
});
