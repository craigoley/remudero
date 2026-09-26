import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = join(import.meta.dirname, "..", "deploy", "docker-fixture-fence.sh");

test("a stale recycle fixture cannot reach the host Docker client", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-docker-fence-"));
  const calls = join(dir, "calls");
  const fakeDocker = join(dir, "real-docker");
  const wrapper = join(dir, "docker");
  writeFileSync(calls, "");
  writeFileSync(fakeDocker, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`);
  chmodSync(fakeDocker, 0o755);
  writeFileSync(wrapper, readFileSync(source, "utf8").replace("REAL_DOCKER=/usr/bin/docker", `REAL_DOCKER='${fakeDocker}'`));
  chmodSync(wrapper, 0o755);

  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(wrapper, args, {
    encoding: "utf8",
    env: { ...process.env, RMD_RECYCLE_DOCKERENV_PATH: "", RMD_STATE_DIR: "", ...env },
  });
  for (const args of [
    ["stop", "remudero-daemon"],
    ["rm", "remudero-daemon"],
    ["run", "-d", "--name", "remudero-daemon", "image"],
    ["container", "stop", "remudero-daemon"],
    ["compose", "down"],
    ["system", "prune"],
    ["image", "rm", "image"],
    ["--context", "default", "stop", "remudero-daemon"],
  ]) {
    const result = run(args, { RMD_RECYCLE_DOCKERENV_PATH: join(dir, "no-marker") });
    assert.equal(result.status, 97, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /REFUSING docker/);
  }
  assert.equal(readFileSync(calls, "utf8"), "", "no fixture mutation reached Docker");

  const stale = run(["stop", "remudero-daemon"], { RMD_STATE_DIR: "/mnt/rmd/tmp/old-recycle-checkout" });
  assert.equal(stale.status, 97);
  assert.equal(readFileSync(calls, "utf8"), "");

  assert.equal(run(["ps"], { RMD_RECYCLE_DOCKERENV_PATH: join(dir, "no-marker") }).status, 0);
  assert.equal(run(["container", "ls"], { RMD_STATE_DIR: "/tmp/recycle-fixture" }).status, 0);
  assert.equal(run(["stop", "remudero-daemon"]).status, 0, "an ordinary host recycle still reaches Docker");
  assert.equal(readFileSync(calls, "utf8"), "ps\ncontainer ls\nstop remudero-daemon\n");
});
