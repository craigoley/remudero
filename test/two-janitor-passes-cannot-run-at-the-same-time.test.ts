import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, watch, writeFileSync } from "node:fs";
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
    const blocked = run(fx);
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
