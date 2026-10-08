import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GitFetchError, planSyncGitRunnerAsync, syncPlanFromOrigin, syncPlanFromOriginAsync } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

test("dispatch plan sync retries transient ref contention on both real git transports instead of refusing a fresh plan", async () => {
  const origin = gitRepo({ bare: true, kind: "dispatch-ref-origin" });
  const work = gitRepo({ kind: "dispatch-ref-work" });
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(work.dir, "plan"));
    writeFileSync(join(work.dir, "plan", "tasks.yaml"), '- id: W9-T1\n  title: "fixture"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n');
    work.git("add", "plan"); work.git("commit", "-m", "seed");
    work.addRemote("origin", origin.dir); work.git("push", "origin", "main");
    const bin = join(work.dir, "bin"); mkdirSync(bin);
    const count = join(work.dir, "fetch-count");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const shim = join(bin, "git");
    writeFileSync(shim, `#!/bin/sh\nif [ "$3" = fetch ]; then\n n=0\n [ ! -f '${count}' ] || n=$(cat '${count}')\n n=$((n + 1))\n echo "$n" > '${count}'\n if [ "$n" = 1 ]; then\n  echo "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def" >&2\n  exit 1\n fi\nfi\nexec '${realGit}' "$@"\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    const sync = syncPlanFromOrigin(work.dir, "plan/tasks.yaml");
    assert.equal(readFileSync(count, "utf8").trim(), "2");
    assert.equal(sync.staleDispatch, false);
    assert.equal(sync.plan.tasks[0].id, "W9-T1");
    writeFileSync(count, "0\n");
    const awaited = await syncPlanFromOriginAsync(work.dir, "plan/tasks.yaml", { runGit: planSyncGitRunnerAsync(work.dir, { gitBin: shim }) });
    assert.equal(readFileSync(count, "utf8").trim(), "2");
    assert.deepEqual(awaited, sync);
  } finally { process.env.PATH = savedPath; work.cleanup(); origin.cleanup(); }
});

test("dispatch ref-lock retry remains bounded and never retries authentication failures or silently enables stale dispatch", async () => {
  for (const message of ["authentication failed", "cannot lock ref refs/remotes/origin/main"]) {
    let attempts = 0;
    const runGit = async () => { attempts++; throw new Error(message); };
    await assert.rejects(syncPlanFromOriginAsync("/fixture", "plan/tasks.yaml", { runGit }), error => error instanceof GitFetchError && error.message.includes(message));
    assert.equal(attempts, message.startsWith("authentication") ? 1 : 3);
  }
});
