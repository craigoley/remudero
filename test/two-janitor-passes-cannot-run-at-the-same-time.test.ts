import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { SCRIPT, fixture, run, scratchDir } from "./helpers/host-cleanup-fixture.js";

test("test/two-janitor-passes-cannot-run-at-the-same-time.test.ts", async () => {
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const ready = join(fx.root, "ready");
  writeFileSync(fx.env.RMD_CLEANUP_LSOF, `#!/usr/bin/env bash\necho ready > '${ready}'\nread release\nexit 0\n`);
  const watcher = watch(fx.root);
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("first janitor did not reach its probe")), 5000);
    watcher.on("change", () => {
      if (existsSync(ready)) { clearTimeout(timer); resolve(); }
    });
  });
  const first = spawn("bash", [SCRIPT], { env: { ...process.env, ...fx.env }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  first.stdout.on("data", data => { output += data; });
  first.stderr.on("data", data => { output += data; });
  const exited = once(first, "close");
  try {
    await started;
    // The hourly tmp-only sweep: it skips at once and never queues behind the pass holding the lock.
    const blocked = run(fx, { RMD_CLEANUP_ONLY_TMP: "1" });
    assert.equal(blocked.status, 0, blocked.stderr + blocked.stdout);
    assert.equal(existsSync(idle), true, "the competing pass must act on nothing");
    assert.match(blocked.stdout, /another janitor pass holds the lock/);
  } finally {
    watcher.close();
    first.stdin.end("release\n");
  }
  const [status] = await exited;
  assert.equal(status, 0, output);
  assert.equal(existsSync(idle), false, "releasing the lock permits the next pass");
  assert.match(output, /REMOVE/);
});

test("a missing flock command fails closed before any mutation", () => {
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, ...fx.env, RMD_CLEANUP_FLOCK: "/absent/flock" } });
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.equal(existsSync(idle), true);
  assert.match(r.stdout + r.stderr, /cannot acquire janitor lock/);
});

/** Holds the fixture's pass lock in a child for `seconds`, returning once the lock is really held. */
function holdLock(fx: ReturnType<typeof fixture>, seconds: number): ReturnType<typeof spawn> {
  const ready = join(fx.root, `held-${seconds}`);
  const holder = spawn(fx.flock, [fx.env.RMD_CLEANUP_LOCK_FILE, "bash", "-c", `echo held > '${ready}'; sleep ${seconds}`], { stdio: "ignore", detached: true });
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready) || readFileSync(ready, "utf8") !== "held\n") {
    if (Date.now() > deadline) throw new Error("the lock holder never took the lock");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return holder;
}

test("a scheduled full pass waits for a briefly held lock and then runs", async () => {
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const holder = holdLock(fx, 2);
  const exited = once(holder, "close");
  const r = run(fx);
  await exited;
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /WAIT pass: another janitor pass holds the lock; waiting up to 1800 s/);
  assert.doesNotMatch(r.stdout, /KEEP pass/);
  assert.equal(existsSync(idle), false, `the full pass must run once the lock is released:\n${r.stdout}`);
});

test("a full pass gives up after its lock wait bound and acts on nothing", async () => {
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const holder = holdLock(fx, 30);
  const exited = once(holder, "close");
  try {
    const started = Date.now();
    const r = run(fx, { RMD_CLEANUP_LOCK_WAIT_SECONDS: "1" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /KEEP pass: another janitor pass still holds the lock after 1 s/);
    assert.ok(Date.now() - started < 20_000, "the bound must end the wait, not the holder");
    assert.equal(existsSync(idle), true, "a pass that never got the lock must act on nothing");
  } finally {
    process.kill(-holder.pid!, "SIGKILL"); // the group: flock(1) hands its descriptor to the child
    await exited;
  }
});

test("an hourly tmp-only pass skips at once while a full pass holds the lock", async () => {
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const holder = holdLock(fx, 30);
  const exited = once(holder, "close");
  try {
    const started = Date.now();
    const r = run(fx, { RMD_CLEANUP_ONLY_TMP: "1" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /KEEP pass: another janitor pass holds the lock/);
    assert.doesNotMatch(r.stdout, /WAIT pass/);
    assert.ok(Date.now() - started < 10_000, "a tmp-only pass must not queue");
    assert.equal(existsSync(idle), true);
  } finally {
    process.kill(-holder.pid!, "SIGKILL"); // the group: flock(1) hands its descriptor to the child
    await exited;
  }
});

test("a malformed lock wait is refused before any mutation", () => {
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const r = run(fx, { RMD_CLEANUP_LOCK_WAIT_SECONDS: "30m" });
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /RMD_CLEANUP_LOCK_WAIT_SECONDS must be a non-negative integer/);
  assert.equal(existsSync(idle), true);
});
