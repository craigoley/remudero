/**
 * 2026-10-14 (LIVE-EDITS #11528): the site daemon's live checkout escalated "tracked edits no PR made"
 * at 01:09:37Z and 12:18:58Z. Each patch was byte-for-byte the diff of the very next main commit
 * (442d86c49..7ebd43e68, 478c3ddde..c3753e8f8), and the checkout's reflog records that fast-forward
 * 0-3 s later. The ladder had read the tree while a `git merge --ff-only` had written the new files
 * but not yet moved HEAD, and a change to the daemon's own code is at restart pressure at once, so
 * that single reading opened the issue.
 *
 * These tests put a REAL checkout in that mid-merge state (worktree at main, index and HEAD behind).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEPLOY_RESTART_SCORE_THRESHOLD } from "../src/lib/deploy-judge.js";
import type { Escalation } from "../src/lib/escalate.js";
import { runLiveEditLadder } from "../src/lib/live-edit-ladder.js";
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const T0 = Date.parse("2026-10-14T12:18:58Z");

interface Checkout {
  live: GitRepo;
  escalations: Escalation[];
  rung: (nowMs: number) => ReturnType<typeof runLiveEditLadder>;
}

/** A live clone one commit behind origin, where that commit changes the daemon's own source. */
function behindByASourceChange(t: TestContext): Checkout {
  const origin = gitRepo({ bare: true, kind: "midmerge-origin" });
  const author = gitRepo({ kind: "midmerge-author" });
  mkdirSync(join(author.dir, "src", "lib"), { recursive: true });
  writeFileSync(join(author.dir, "src", "lib", "sweep.ts"), "export const v = 1;\n");
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed");
  author.addRemote("origin", origin.dir);
  author.git("push", "--quiet", "origin", "main");
  const live = gitRepo({ cloneFrom: origin.dir, kind: "midmerge-live" });
  // W1-T9089: every source commit weighs the floor of 1 (the daemon's own code no longer weighs 18), so the checkout is
  // behind by the restart threshold's worth of source commits for its staleness to be at restart pressure at once.
  for (let version = 2; version < 2 + DEPLOY_RESTART_SCORE_THRESHOLD.value; version++) {
    writeFileSync(join(author.dir, "src", "lib", "sweep.ts"), `export const v = ${version};\n`);
    author.git("commit", "--quiet", "-am", "fix(sweep): the triage evidence reads its slice off the loop");
  }
  author.git("push", "--quiet", "origin", "main");
  live.git("fetch", "--quiet", "origin", "main");
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}midmerge-state-`));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const escalations: Escalation[] = [];
  const rung = (nowMs: number) => runLiveEditLadder({
    tree: "daemon-checkout", repoDir: live.dir, stateDir: state, host: "fleet-host", clock: fixedClock(nowMs),
    escalate: async (e) => { escalations.push(e); return "https://github.com/example/fleet/issues/1"; },
    comment: async () => {},
  });
  return { live, escalations, rung };
}

/** What `git merge --ff-only` has done before it moves HEAD: the new blobs are on disk, nothing else. */
function midFastForward(live: GitRepo): void {
  writeFileSync(join(live.dir, "src", "lib", "sweep.ts"), live.git("show", "origin/main:src/lib/sweep.ts") + "\n");
}

test("a reading taken mid-fast-forward never escalates, and the finished merge ends the episode", async (t) => {
  const c = behindByASourceChange(t);
  midFastForward(c.live);
  const first = await c.rung(T0);
  assert.deepEqual(first.paths, ["src/lib/sweep.ts"], "the half-applied merge reads as an edit");
  assert.equal(c.escalations.length, 0, "one reading never opens an issue");
  assert.notEqual(first.tier, 2, first.reason);
  c.live.git("reset", "--quiet", "--hard", "origin/main"); // the merge's last steps: index and HEAD reach main
  const after = await c.rung(T0 + 300_000);
  assert.equal(after.tier, 0, after.reason);
  assert.equal(c.escalations.length, 0, "the merge finished; nothing ever escalated");
});

test("a tracked edit that a second reading still sees escalates on that reading", async (t) => {
  const c = behindByASourceChange(t);
  const handEditPath = join(c.live.dir, "src", "lib", "sweep.ts");
  writeFileSync(handEditPath, "export const v = 'hand edit';\n");
  const first = await c.rung(T0);
  assert.equal(c.escalations.length, 0, first.reason);
  const second = await c.rung(T0 + 300_000);
  assert.equal(second.tier, 2, second.reason);
  assert.equal(c.escalations.length, 1);
  assert.match(c.escalations[0]!.detail, /src\/lib\/sweep\.ts/);
  assert.equal(readFileSync(handEditPath, "utf8"), "export const v = 'hand edit';\n", "still deferred, never discarded");
});
