import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { repoRoot } from "#test/helpers/repo-root.js";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { withTempDir } from "#src/lib/tmp.js";
import { inboxThreadIdentity, readThread, appendThreadMessage } from "#src/lib/inbox-thread.js";

test("improvement conversation messages are saved once through the native thread store", async () => {
  const { appendThreadMessageOnce } = await import("#src/lib/inbox-thread.js");
  assert.equal(typeof appendThreadMessageOnce, "function", "the durable native writer must exist");
  await withTempDir("improvement-thread-store", dir => {
    const store = { threadStorePath: join(dir, "inbox-threads.jsonl"), now: () => 1793610000000 };
    const identity = inboxThreadIdentity("improvement:acme-atlas:quality");
    const threadId = appendThreadMessage(identity, "escalation", "The source reports a code-maintenance finding.", store);
    const first = appendThreadMessageOnce(identity, "reply", "Plan how to simplify the code without changing its output.", "request-1", store);
    assert.equal(first.kind, "appended"); assert(first.kind === "appended"); assert.equal(first.threadId, threadId); assert.equal(first.seq, 2);
    const reloaded = appendThreadMessageOnce(identity, "reply", "Plan how to simplify the code without changing its output.", "request-1", { ...store });
    assert.equal(reloaded.kind, "existing");
    assert.equal(appendThreadMessageOnce(identity, "reply", "A different goal.", "request-1", store).kind, "conflict");
    const read = readThread(threadId, store); assert.equal(read.status, "ok"); assert(read.status === "ok");
    assert.equal(read.messages.length, 2); assert.deepEqual(read.messages.map(message => message.seq), [1, 2]);
    appendFileSync(store.threadStorePath, "{torn");
    assert.equal(appendThreadMessageOnce(identity, "reply", "Another goal.", "request-2", store).kind, "unresolved", "a damaged store cannot become an empty or saved chat");
  });
});


test("improvement chat writers preserve active and unknown ownership and recover only proven dead writers", async () => {
  const { appendThreadMessageOnce } = await import("#src/lib/inbox-thread.js");
  await withTempDir("improvement-thread-ownership", dir => {
    const store = { threadStorePath: join(dir, "inbox-threads.jsonl") }, identity = inboxThreadIdentity("improvement:acme-atlas:quality");
    const lockDir = join(dir, "inbox-thread-locks"), lockPath = join(lockDir, "write.lock");
    const active = acquireInflightLock(lockDir, "write", { run_id: "fixture-active", reclaim: false });
    try {
      assert.equal(appendThreadMessageOnce(identity, "reply", "Plan this safely.", "live-holder", store).kind, "busy");
      assert.throws(() => appendThreadMessage(identity, "reply", "Legacy writer shares the same lock.", store), /writer.*active|ownership/i);
      assert.equal(existsSync(active.path), true); assert.equal(existsSync(store.threadStorePath), false);
    } finally { active.release(); }
    writeFileSync(lockPath, "{unknown");
    assert.equal(appendThreadMessageOnce(identity, "reply", "Plan this safely.", "unknown-holder", store).kind, "busy");
    assert.equal(readFileSync(lockPath, "utf8"), "{unknown"); unlinkSync(lockPath);
    const child = 'import {acquireInflightLock} from "#src/lib/inflight-lock.js";const held=acquireInflightLock(process.argv[1],"write",{run_id:"fixture-exited",reclaim:false});process.stdout.write(JSON.stringify(held.info));';
    const exited = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child, lockDir], { cwd: repoRoot(), encoding: "utf8", timeout: 10000 }));
    assert.notEqual(exited.pid, process.pid); assert.equal(exited.run_id, "fixture-exited");
    assert.equal(appendThreadMessageOnce(identity, "reply", "Plan this safely.", "after-dead-holder", store).kind, "appended");
  });
});

test("improvement chat never confirms a write after its lock ownership changed", async () => {
  const { appendThreadMessageOnce } = await import("#src/lib/inbox-thread.js");
  await withTempDir("improvement-thread-lost", dir => {
    const lockPath = join(dir, "inbox-thread-locks", "write.lock"), replacement = { pid: process.pid, host: "different-host", startedAt: "2026-01-01T00:00:00.000Z", run_id: "replacement-owner" };
    const store = { threadStorePath: join(dir, "inbox-threads.jsonl"), now: () => { writeFileSync(lockPath, JSON.stringify(replacement)); return 1793610000000; } };
    const result = appendThreadMessageOnce(inboxThreadIdentity("improvement:acme-atlas:quality"), "reply", "Plan this safely.", "lost-owner", store);
    assert.equal(result.kind, "busy", "a lost writer cannot acknowledge a saved message");
    assert.equal(existsSync(store.threadStorePath), false, "ownership is checked again before append");
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), replacement, "the replacement holder is retained");
  });
});

test("improvement chat concurrent processes and reload keep one message per write identity", async () => {
  const { appendThreadMessageOnce } = await import("#src/lib/inbox-thread.js");
  await withTempDir("improvement-thread-processes", async dir => {
    const store = { threadStorePath: join(dir, "inbox-threads.jsonl") }, identity = inboxThreadIdentity("improvement:acme-atlas:quality");
    const threadId = appendThreadMessage(identity, "escalation", "Verified source briefing.", store);
    const script = 'import {inboxThreadIdentity,appendThreadMessageOnce} from "#src/lib/inbox-thread.js";process.stdout.write(JSON.stringify(appendThreadMessageOnce(inboxThreadIdentity("improvement:acme-atlas:quality"),"reply","Plan this safely.",process.argv[2],{threadStorePath:process.argv[1]})));';
    const run = promisify(execFile);
    const children = await Promise.all(Array.from({ length: 4 }, (_, n) => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, store.threadStorePath, `concurrent-${n}`], { cwd: repoRoot(), encoding: "utf8", timeout: 10000 })));
    assert(children.some(child => JSON.parse(child.stdout).kind === "appended"), "at least one real child owns and saves a message");
    for (let n = 0; n < 4; n++) {
      const retried = appendThreadMessageOnce(identity, "reply", "Plan this safely.", `concurrent-${n}`, { ...store });
      assert(["appended", "existing"].includes(retried.kind));
    }
    const saved = readThread(threadId, store);
    assert(saved.status === "ok"); assert.equal(saved.messages.length, 5);
    assert.deepEqual(saved.messages.map(message => message.seq), [1, 2, 3, 4, 5]);
    assert.equal(new Set(saved.messages.slice(1).map(message => message.extra!.messageId)).size, 4);
  });
});
