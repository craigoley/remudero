import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { commitlintStep, emitterChecksStep, checkCommitMessage } from "../src/lib/commit-message.js";
import { commitMessageContractLines, outputContractLines, renderAnchorBlock } from "../src/lib/compaction.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { QuietWatchdogOptions } from "../src/lib/quiet-worker-watchdog.js";
import * as unfinished from "../src/lib/unfinished-checkpoint.js";
import * as runTask from "../src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TASK = "W1-T8800";
const task = { id: TASK, title: "checkpoint contracts preserve unfinished work", repo: "remudero", type: "implement", risk: "high", depends_on: [], verify: "auto", status: "queued", attempts: 0 } as const;

function rig() {
  const origin = gitRepo({ bare: true, kind: "checkpoint-contract-origin" });
  const seed = gitRepo({ kind: "checkpoint-contract-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const work = gitRepo({ cloneFrom: origin.dir, kind: "checkpoint-contract-work" });
  work.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  work.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const branch = `run-${TASK}-fixture`;
  work.git("checkout", "--quiet", "-b", branch);
  work.git("push", "--quiet", "origin", branch);
  // These are disposable Git fixtures, not validation-tree dependencies or a modified gate.
  symlinkSync(join(ROOT, "node_modules"), join(work.dir, "node_modules"), "dir");
  writeFileSync(join(work.dir, "commitlint.config.mjs"), readFileSync(join(ROOT, "commitlint.config.mjs")));
  work.git("add", "commitlint.config.mjs");
  work.git("commit", "--quiet", "-m", "test(checkpoint): install the unchanged message gate in the fixture");
  work.git("push", "--quiet", "origin", branch);
  const base = work.git("rev-parse", "HEAD");
  return { origin, work, branch, base };
}

function change(dir: string, text = "retained worker work\n") {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/work.txt"), text);
}

function watchdog(cwd: string, trigger?: "recycle" | "restart") {
  let captured: QuietWatchdogOptions | undefined;
  const handle = { observer: () => {}, tick: async () => {}, start: () => () => {} };
  runTask.watchDispatchSpawn((async () => { throw new Error("fixture spawn must not run"); }) as never, {
    enabled: true, taskId: TASK, runId: "checkpoint-fixture", ledgerPath: join(cwd, "ledger.ndjson"), fallbackBoundMs: 60_000,
    spawnArgs: { cwd, settingsFile: join(cwd, "settings.json") }, task: { files: ["src/work.txt"], acceptance: [] }, provider: () => "fixture", log: () => {},
  }, { runWatchdog: ((options: QuietWatchdogOptions) => { captured = options; return handle; }) as never });
  return () => captured!.endRound!("fixture yielded with unfinished work", trigger);
}

function passingRange(work: ReturnType<typeof gitRepo>, base: string, expected: number) {
  assert.equal(work.git("rev-list", "--count", "--no-merges", `${base}..HEAD`), String(expected), "the production gate sees a nonempty verified range");
  const range = { from: base, to: "HEAD" };
  for (const gate of [commitlintStep, emitterChecksStep]) {
    const result = gate(work.dir, range);
    assert.equal(result.ok, true, result.detail);
  }
}

test("checkpoint emitters pass local range gates without erasing unfinished work", async () => {
  for (const trigger of ["boundary", "quiet", "recycle", "restart"] as const) {
    const { origin, work, branch, base } = rig();
    change(work.dir);
    if (trigger === "boundary") await withLiveWritesAllowed(() => runTask.commitAndPushRestartCheckpoint(work.dir, { files: ["src/work.txt"], acceptance: [] }, TASK, "worker"));
    else {
      const ended = await withLiveWritesAllowed(() => watchdog(work.dir, trigger === "quiet" ? undefined : trigger)());
      assert.equal(ended.ended, true, String(ended.reason));
    }
    const subject = work.git("log", "-1", "--format=%s");
    assert.match(subject, /^chore\(checkpoint\): yield at /, `real ${trigger} emitter uses the new subject`);
    const body = work.git("log", "-1", "--format=%B");
    assert.match(body, /\[remudero-context\]\ndecided: retain work for restart\nremaining: resume(?: worker)?\nfailed: none/);
    assert.match(body, new RegExp(`Remudero-Task: ${TASK}$`));
    assert.equal(unfinished.isWipSubject(subject), true, "a valid conventional checkpoint is still unfinished");
    assert.ok(unfinished.checkpointRemaining(body));
    assert.equal(origin.git("rev-parse", branch), work.git("rev-parse", "HEAD"), "real default push retains the exact checkpoint");
    passingRange(work, base, 1);
    const checkpoint = work.git("rev-parse", "HEAD");
    work.git("commit", "--quiet", "--allow-empty", "-m", `fix(checkpoint): finish the real work\n\nRemudero-Task: ${TASK}`);
    passingRange(work, base, 2);
    assert.equal(work.git("rev-parse", "HEAD^"), checkpoint, "a final commit does not rewrite or erase its checkpoint");
    assert.equal(unfinished.isWipSubject(work.git("log", "-1", "--format=%s")), false, "fix(checkpoint) is a terminal change, not the reserved chore marker");
    assert.equal(runTask.branchPrTitle(work.dir, task), `fix(checkpoint): checkpoint contracts preserve unfinished work (${TASK})`);
  }
  const legacy = rig();
  legacy.work.git("commit", "--quiet", "--allow-empty", "-m", "wip: yield at worker\n\n[remudero-context]\nremaining: tests");
  const range = { from: legacy.base, to: "HEAD" };
  for (const gate of [commitlintStep, emitterChecksStep]) assert.equal(gate(legacy.work.dir, range).ok, false, "legacy wip still fails the unchanged local gate");
  assert.equal(unfinished.isWipSubject("wip: yield at worker"), true, "legacy history remains resumable, not waived");
});

test("checkpoint prompt and continuation agree with local range and hosted title contracts", () => {
  const contract = outputContractLines(TASK).join("\n");
  assert.match(contract, /`chore\(checkpoint\): <what>`/);
  const messages = commitMessageContractLines().join("\n");
  assert.match(messages, /HOSTED.*PR TITLE/);
  assert.match(messages, /LOCAL.*commitlint.*emitter-checks/);
  assert.match(messages, /every commit.*range/);
  assert.doesNotMatch(messages, /never block a merge/);
  const anchor = renderAnchorBlock(task as never, "fixture");
  assert.ok(anchor.includes(messages), "compaction repeats the actual contract, not a stale second copy");
  for (const ownsGit of [false, true]) {
    const text = unfinished.renderContinuationPrompt("chore(checkpoint): tests still remain", "tests and coverage", ownsGit);
    assert.match(text, /tests and coverage/);
    assert.match(text, /terminal/);
    assert.match(text, /chore\(checkpoint\)/);
    assert.match(text, /local.*range/);
    assert.equal(text.includes("run NO git or gh commands"), ownsGit);
  }
  const builder = (unfinished as unknown as Record<string, unknown>).checkpointCommitSubject;
  assert.equal(typeof builder, "function", "shared builder exists on the actual module");
  for (const reason of ["yield at worker", "SSE output waits.", "  ", "long reason ".repeat(40)]) {
    const subject = (builder as (reason: string) => string)(reason);
    assert.ok(subject.length <= 100);
    assert.deepEqual(checkCommitMessage(subject), []);
    assert.equal(unfinished.isWipSubject(subject), true);
  }
  assert.equal(unfinished.stripWipMarker("chore(checkpoint)!: retained work"), "chore!: retained work");
  for (const subject of ["wip: old", "wip(scope): old", "chore(wip): old"]) assert.equal(unfinished.isWipSubject(subject), true);
  for (const subject of ["fix(checkpoint): terminal work", "chore(checkpoints): ordinary work", "fix: checkpoint parser"]) assert.equal(unfinished.isWipSubject(subject), false);
});

test("a restored-main merge preserves checkpoint identity and its unfinished marker", async () => {
  const { work, branch, base } = rig();
  work.git("commit", "--quiet", "--allow-empty", "-m", "chore(checkpoint): retained work\n\n[remudero-context]\nremaining: final tests");
  const checkpoint = work.git("rev-parse", "HEAD");
  work.git("push", "--quiet", "origin", branch);
  const checkpointBody = work.git("show", "-s", "--format=%B", checkpoint);
  work.git("checkout", "--quiet", "main");
  work.git("commit", "--quiet", "--allow-empty", "-m", "fix(other): main advanced");
  const restored = await runTask.restoreBoundaryCheckpoint({ branch, headSha: checkpoint }, TASK, async args => work.git(...args));
  assert.equal(restored.base, "main");
  assert.equal(work.git("rev-parse", "HEAD^1"), checkpoint);
  assert.equal(work.git("show", "-s", "--format=%B", checkpoint), checkpointBody, "original object/body remain byte-identical");
  assert.equal(work.git("log", "-1", "--format=%s"), "chore(checkpoint): merge main into the restored checkpoint");
  assert.equal(unfinished.isWipSubject(work.git("log", "-1", "--format=%s")), true);
  assert.deepEqual(checkCommitMessage(work.git("log", "-1", "--format=%B")), []);
  passingRange(work, base, 2);
});

test("checkpoint no-diff, conflict refusal and failed default pushes retain their existing outcomes", async () => {
  const clean = rig();
  await withLiveWritesAllowed(() => runTask.commitAndPushRestartCheckpoint(clean.work.dir, { files: [] }, TASK, "worker"));
  assert.equal(clean.work.git("rev-parse", "HEAD"), clean.base, "no new commit for a clean tree");
  const cleanEnd = await withLiveWritesAllowed(() => watchdog(clean.work.dir)());
  assert.equal(cleanEnd.ended, true);
  assert.equal(cleanEnd.checkpointSha, clean.base);
  const conflict = rig();
  change(conflict.work.dir, "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n");
  await assert.rejects(withLiveWritesAllowed(() => runTask.commitAndPushRestartCheckpoint(conflict.work.dir, { files: ["src/work.txt"] }, TASK, "worker")), /checkpoint refused/);
  const refused = await withLiveWritesAllowed(() => watchdog(conflict.work.dir)());
  assert.equal(refused.ended, false);
  assert.match(String(refused.reason), /checkpoint refused/);
  assert.equal(conflict.work.git("rev-parse", "HEAD"), conflict.base);
  for (const quiet of [false, true]) {
    const failed = rig();
    change(failed.work.dir);
    failed.work.git("remote", "set-url", "--push", "origin", join(failed.work.dir, "missing-local-origin"));
    if (quiet) {
      const ended = await withLiveWritesAllowed(() => watchdog(failed.work.dir, "restart")());
      assert.equal(ended.ended, false);
      assert.match(String(ended.reason), /checkpoint failed:/);
    } else await assert.rejects(withLiveWritesAllowed(() => runTask.commitAndPushRestartCheckpoint(failed.work.dir, { files: ["src/work.txt"] }, TASK, "worker")));
    assert.notEqual(failed.work.git("rev-parse", "HEAD"), failed.base, "failed push retains the committed local work");
    assert.equal(failed.origin.git("rev-parse", failed.branch), failed.base, "failed local-fixture push moved no remote branch");
  }
});
