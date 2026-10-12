// 2026-10-10: four gardens' idle checks (`cheapFingerprint`) each ran `git rev-parse HEAD` through a
// synchronous spawn on the daemon loop, every pulse. On a thrashing host one took 17.9 s and
// `daemon.loop_lag` named them in the 08:05–08:22Z stalls. HEAD is now read from the ref files. These
// prove the read answers what the spawn answered, and that the daemon's own sync-spawn sampler sees
// no spawn from an idle check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ciFrictionGardenSpec, type CiFrictionGardenSources } from "../src/lib/ci-friction-gardener.js";
import { fixedClock } from "../src/lib/clock.js";
import { flowGardenSpec, type FlowGardenSources } from "../src/lib/flow-remedy-gardener.js";
import type { GardenerDeps } from "../src/lib/gardener.js";
import { gateGardenSpec, type GateProbes } from "../src/lib/gate-gardener.js";
import { hotFileGardenSpec, type HotFileGardenSources } from "../src/lib/hot-file-gardener.js";
import { startReadPlaneTelemetry } from "../src/lib/read-plane.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const NOW = Date.parse("2026-10-10T08:11:33.555Z");

/** Milliseconds `fn` spent in synchronous child processes, as the daemon's own sampler measures them. */
function syncSpawnMs(fn: () => void): number {
  const telemetry = startReadPlaneTelemetry();
  try {
    fn();
    return telemetry.sample().sync_spawn_ms;
  } finally {
    telemetry.stop();
  }
}

function idleChecks(repo: GitRepo): Array<{ name: string; cheap: () => string }> {
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const deps: GardenerDeps = { repoRoot: repo.dir, stateDir, clock: fixedClock(NOW), log: () => {},
    openWorkspace: () => { throw new Error("an idle check opens no workspace"); } };
  return [
    ciFrictionGardenSpec(deps, { ownerSearch: { filesContaining: () => [], fileExists: () => false } } as unknown as CiFrictionGardenSources),
    flowGardenSpec(deps, {} as FlowGardenSources),
    gateGardenSpec(deps, {} as GateProbes),
    hotFileGardenSpec(deps, {} as HotFileGardenSources),
  ].map((spec) => ({ name: spec.name, cheap: () => spec.cheapFingerprint() }));
}

test("unit test: a garden's idle check reads HEAD from the ref files and spawns no git", (t) => {
  const repo = gitRepo({ kind: "garden-idle-head" });
  t.after(() => repo.cleanup());
  const checks = idleChecks(repo);
  assert.deepEqual(checks.map((c) => c.name).sort(), ["ci-friction", "flow-remedy", "gate", "hot-file"]);

  // Positive control: the sampler sees a synchronous git spawn made through a named import.
  assert.ok(syncSpawnMs(() => execFileSync("git", ["-C", repo.dir, "rev-parse", "HEAD"])) > 0, "the sampler must see a sync spawn");

  for (const moved of [false, true]) {
    if (moved) {
      writeFileSync(join(repo.dir, "next.txt"), "next\n");
      repo.git("add", "next.txt");
      repo.git("commit", "-q", "-m", "move HEAD");
    }
    const head = repo.git("rev-parse", "HEAD");
    const spawned: string[] = [];
    for (const check of checks) {
      let fingerprint = "";
      if (syncSpawnMs(() => { fingerprint = check.cheap(); }) > 0) spawned.push(check.name);
      assert.ok(fingerprint.startsWith(`${head}:`), `${check.name}'s fingerprint carries HEAD ${head}: ${fingerprint}`);
    }
    assert.deepEqual(spawned, [], "an idle check spawned a synchronous child on the daemon loop");
  }
});

test("unit test: headShaFromRefFiles answers what git rev-parse HEAD answers, or nothing", async (t) => {
  // Loaded here, not at the top, so the file still loads on a tree without the module and this test is what fails.
  const { checkoutHeadStamp, headShaFromRefFiles } = await import("../src/lib/checkout-head.js");
  const repo = gitRepo({ kind: "head-ref-files" });
  t.after(() => repo.cleanup());
  const rev = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  assert.equal(headShaFromRefFiles(repo.dir), rev(repo.dir), "a loose branch ref");
  repo.git("pack-refs", "--all");
  assert.equal(headShaFromRefFiles(repo.dir), rev(repo.dir), "packed-refs once the loose ref is gone");

  const parent = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}head-linked-`));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const linked = repo.addWorktree(join(parent, "linked"), "linked-branch");
  writeFileSync(join(linked.dir, "linked.txt"), "linked\n");
  linked.git("add", "linked.txt");
  linked.git("commit", "-q", "-m", "linked commit");
  assert.equal(headShaFromRefFiles(linked.dir), rev(linked.dir), "a linked worktree's gitdir pointer and commondir");
  assert.notEqual(headShaFromRefFiles(linked.dir), headShaFromRefFiles(repo.dir), "each tree answers its own HEAD");

  repo.git("checkout", "-q", "--detach", "HEAD");
  assert.equal(headShaFromRefFiles(repo.dir), rev(repo.dir), "a detached HEAD is its own sha");

  // Layouts it does not recognise answer nothing, and the stamp then forces a pass rather than a skip.
  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}head-none-`));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(headShaFromRefFiles(bare), undefined, "no .git at all");
  mkdirSync(join(bare, ".git"));
  writeFileSync(join(bare, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
  assert.equal(headShaFromRefFiles(bare), undefined, "a reftable store's placeholder HEAD");
  writeFileSync(join(bare, ".git", "HEAD"), "not-a-sha\n");
  assert.equal(headShaFromRefFiles(bare), undefined, "a HEAD that is neither a ref nor a full sha");
  mkdirSync(join(bare, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(bare, ".git", "refs", "heads", "main"), "ref: refs/heads/other\n");
  writeFileSync(join(bare, ".git", "HEAD"), "ref: refs/heads/main\n");
  assert.equal(headShaFromRefFiles(bare), undefined, "a loose ref that is not a full sha");

  assert.equal(checkoutHeadStamp(repo.dir, fixedClock(NOW)), rev(repo.dir));
  assert.equal(checkoutHeadStamp(bare, fixedClock(NOW)), `head-unresolved@${NOW}`);
  assert.notEqual(checkoutHeadStamp(bare, fixedClock(NOW + 1)), checkoutHeadStamp(bare, fixedClock(NOW)), "an unresolved HEAD never matches its last stamp");
});
