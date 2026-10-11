/**
 * 2026-10-10/11: four tracked files were edited by hand in the Azure host's live checkouts. The
 * daemon's freshness read answered `arm=dirty` and the watchdog deferred every tick, so core sat on
 * 81bb8c305 for five hours and nothing escalated. These suites drive the live-edit ladder over REAL
 * git trees: a bare origin, a live clone behind it carrying a tracked edit, and a state root.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Escalation } from "../src/lib/escalate.js";
import { LIVE_EDIT_STEPS, liveEditStatePath, runLiveEditLadder, trackedEditPaths, withLiveEditLadders, type LiveEditRungInput } from "../src/lib/live-edit-ladder.js";
import { asyncGit, checkServiceFreshnessAsync, daemonFreshnessFromService } from "../src/lib/self-sync.js";
import { clockFromMillisFn, fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-11T00:17:00Z");
const ISSUE = "https://github.com/example/fleet/issues/1";

interface World {
  live: GitRepo;
  origin: GitRepo;
  state: string;
  escalations: Escalation[];
  comments: Array<{ url: string; body: string }>;
  rung: (nowMs: number, extra?: Partial<LiveEditRungInput>) => ReturnType<typeof runLiveEditLadder>;
  steps: () => string[];
}

/** A live clone one material commit behind origin, with one hand edit to a tracked file. */
function world(t: TestContext): World {
  const origin = gitRepo({ bare: true, kind: "ladder-origin" });
  const author = gitRepo({ kind: "ladder-author" });
  writeFileSync(join(author.dir, "app.txt"), "v1\n");
  writeFileSync(join(author.dir, "gone.txt"), "tracked, then deleted by hand\n");
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed");
  author.addRemote("origin", origin.dir);
  author.git("push", "--quiet", "origin", "main");
  const live = gitRepo({ cloneFrom: origin.dir, kind: "ladder-live" });
  mkdirSync(join(author.dir, "src"));
  writeFileSync(join(author.dir, "src", "feature.ts"), "export const x = 1;\n");
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "feat: main moves on");
  author.git("push", "--quiet", "origin", "main");
  live.git("fetch", "--quiet", "origin", "main");
  writeFileSync(join(live.dir, "app.txt"), "hand edit\n");
  rmSync(join(live.dir, "gone.txt"));
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ladder-state-`));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const escalations: Escalation[] = [];
  const comments: Array<{ url: string; body: string }> = [];
  const rung = (nowMs: number, extra: Partial<LiveEditRungInput> = {}) => runLiveEditLadder({
    tree: "daemon-checkout", repoDir: live.dir, stateDir: state, host: "fleet-host", clock: fixedClock(nowMs),
    escalate: async (e) => { escalations.push(e); return ISSUE; },
    comment: async (url, body) => { comments.push({ url, body }); },
    ...extra,
  });
  const steps = () => existsSync(join(state, "ledger.ndjson"))
    ? readFileSync(join(state, "ledger.ndjson"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { step: string }).step)
    : [];
  return { live, origin, state, escalations, comments, rung, steps };
}

test("live-edit ladder tier 1 writes the patch and a recovery ref, and still defers", async (t) => {
  const w = world(t);
  const r = await w.rung(T0);
  assert.equal(r.tier, 1, r.reason);
  assert.equal(r.restored, false);
  assert.deepEqual(r.paths, ["app.txt", "gone.txt"]);
  assert.equal(readFileSync(join(w.live.dir, "app.txt"), "utf8"), "hand edit\n", "tier 1 touches nothing");
  assert.equal(w.escalations.length, 0, "tier 1 does not escalate");
  assert.ok(r.patch && r.ref, "both copies are reported");
  const patch = readFileSync(join(w.state, r.patch), "utf8");
  assert.match(patch, /^\+hand edit$/m);
  assert.match(patch, /^deleted file mode/m);
  assert.match(r.ref, /^refs\/rmd-recovery\/live-edits\/fleet-host\/20261011T001700Z$/);
  assert.equal(w.live.git("show", `${r.ref}:app.txt`), "hand edit");
  assert.equal(w.live.git("rev-parse", `${r.ref}^1`), w.live.git("rev-parse", "HEAD"), "the ref is a commit on the live HEAD");
  assert.deepEqual(w.steps(), [LIVE_EDIT_STEPS.preserved]);
  const again = await w.rung(T0 + 60_000);
  assert.equal(again.patch, r.patch, "an unchanged edit set is not preserved twice");
  assert.deepEqual(w.steps(), [LIVE_EDIT_STEPS.preserved]);
});

test("live-edit ladder tier 2 escalates once at the daemon's own restart pressure", async (t) => {
  const w = world(t);
  await w.rung(T0);
  const due = await w.rung(T0 + HOUR);
  assert.equal(due.tier, 2, due.reason);
  assert.ok(due.pressure! >= 18 && due.pressure! < 36, `pressure ${due.pressure}`);
  assert.equal(w.escalations.length, 1);
  const e = w.escalations[0]!;
  assert.equal(e.taskId, "LIVE-EDITS-daemon-checkout");
  assert.match(e.detail, /`app\.txt`/);
  assert.match(e.detail, /1 commit\(s\) behind origin\/main/);
  assert.ok(e.detail.includes(due.patch!), "the issue names the patch");
  assert.ok(e.detail.includes(due.ref!), "the issue names the recovery ref");
  const later = await w.rung(T0 + HOUR + 60_000);
  assert.equal(later.tier, 2);
  assert.equal(later.issueUrl, ISSUE);
  assert.equal(w.escalations.length, 1, "the same episode never escalates twice");
  assert.equal(readFileSync(join(w.live.dir, "app.txt"), "utf8"), "hand edit\n", "tier 2 still defers");
  assert.equal(w.steps().filter((s) => s === LIVE_EDIT_STEPS.escalated).length, 1);
});

test("live-edit ladder tier 3 restores only after the copy is confirmed, then fast-forwards", async (t) => {
  const w = world(t);
  const first = await w.rung(T0);
  const r = await w.rung(T0 + 2 * HOUR);
  assert.equal(r.tier, 3, r.reason);
  assert.equal(r.restored, true, r.reason);
  assert.equal(w.live.git("status", "--porcelain", "-uno"), "", "every tracked path is back at HEAD");
  assert.equal(readFileSync(join(w.live.dir, "app.txt"), "utf8"), "v1\n");
  const steps = w.steps();
  assert.ok(steps.indexOf(LIVE_EDIT_STEPS.preserved) < steps.indexOf(LIVE_EDIT_STEPS.restored), steps.join(","));
  assert.equal(w.escalations.length, 1, "an episode that skipped tier 2 escalates before restoring");
  assert.equal(w.comments.length, 1);
  assert.equal(w.comments[0]!.url, ISSUE);
  assert.match(w.comments[0]!.body, /restored 2 tracked path\(s\)/);
  assert.ok(w.comments[0]!.body.includes(first.patch!), "the comment names the patch");
  assert.ok(existsSync(join(w.state, first.patch!)), "the patch outlives the restore");
  assert.equal(w.live.git("show", `${first.ref}:app.txt`), "hand edit", "and the ref still holds the edit");
  w.live.git("merge", "--ff-only", "--quiet", "origin/main");
  assert.equal(w.live.git("rev-parse", "HEAD"), w.live.git("rev-parse", "origin/main"), "the checkout fast-forwards");
  const after = await w.rung(T0 + 2 * HOUR + 60_000);
  assert.equal(after.tier, 0);
  assert.equal(existsSync(liveEditStatePath(w.state, "daemon-checkout")), false, "a delivered episode leaves no state");
});

test("live-edit ladder: a write failure in tier 1 blocks tier 3", async (t) => {
  const w = world(t);
  writeFileSync(join(w.state, "recovery"), "a file where the recovery directory must go\n");
  const first = await w.rung(T0);
  assert.equal(first.tier, 1);
  assert.equal(first.patch, undefined, "no copy is reported when none was written");
  const r = await w.rung(T0 + 2 * HOUR);
  assert.equal(r.tier, 3);
  assert.equal(r.restored, false, r.reason);
  assert.match(r.reason, /no confirmed copy/);
  assert.equal(readFileSync(join(w.live.dir, "app.txt"), "utf8"), "hand edit\n", "an unpreserved edit is never restored");
  assert.ok(!existsSync(join(w.live.dir, "gone.txt")), "nor an unpreserved deletion");
  const steps = w.steps();
  assert.ok(steps.includes(LIVE_EDIT_STEPS.preserveFailed));
  assert.ok(steps.includes(LIVE_EDIT_STEPS.restoreRefused));
  assert.ok(!steps.includes(LIVE_EDIT_STEPS.restored));
  assert.match(w.escalations[0]!.detail, /could NOT be preserved/);
  await w.rung(T0 + 2 * HOUR + 60_000);
  assert.equal(w.steps().filter((s) => s === LIVE_EDIT_STEPS.preserveFailed).length, 1, "one failure row per failing edit set");
});

test("live-edit ladder: an edit landing after the copy was confirmed is preserved before any restore", async (t) => {
  const w = world(t);
  await w.rung(T0);
  let readTrees = 0;
  const racing = (dir: string) => async (args: string[], signal?: AbortSignal, env?: NodeJS.ProcessEnv) => {
    // The second snapshot of this run is the pre-restore recheck: a hand edit lands just before it.
    if (args[0] === "read-tree" && ++readTrees === 2) writeFileSync(join(w.live.dir, "app.txt"), "a later edit\n");
    return asyncGit(dir)(args, signal, env);
  };
  const raced = await w.rung(T0 + 2 * HOUR, { git: racing });
  assert.equal(raced.restored, false);
  assert.match(raced.reason, /changed after their copy was confirmed/);
  assert.equal(readFileSync(join(w.live.dir, "app.txt"), "utf8"), "a later edit\n", "the later edit is untouched");
  const next = await w.rung(T0 + 2 * HOUR + 60_000);
  assert.equal(next.restored, true, next.reason);
  assert.equal(w.live.git("show", `${next.ref}:app.txt`), "a later edit", "and was preserved before the restore");
});

test("live-edit ladder: a restore with no voice leaves its notice for the next actor that has one", async (t) => {
  const w = world(t);
  await w.rung(T0, { escalate: undefined, comment: undefined });
  const r = await w.rung(T0 + 2 * HOUR, { escalate: undefined, comment: undefined });
  assert.equal(r.restored, true, r.reason);
  assert.equal(w.escalations.length, 0);
  const pending = JSON.parse(readFileSync(liveEditStatePath(w.state, "daemon-checkout"), "utf8")) as { noticePending?: string; since?: number };
  assert.match(pending.noticePending ?? "", /restored 2 tracked path\(s\)/);
  await w.rung(T0 + 2 * HOUR + 60_000);
  assert.equal(w.escalations.length, 1, "the daemon posts what the watchdog could not");
  assert.match(w.escalations[0]!.detail, /restored 2 tracked path\(s\)/);
  assert.equal(existsSync(liveEditStatePath(w.state, "daemon-checkout")), false);
});

test("live-edit ladder: the daemon's freshness read restores its own tree and re-reads it stale from the episode start", async (t) => {
  const w = world(t);
  const install = gitRepo({ cloneFrom: w.origin.dir, kind: "ladder-install" });
  install.git("reset", "--quiet", "--hard", "HEAD~1");
  writeFileSync(join(install.dir, "app.txt"), "install edit\n");
  let now = T0;
  const read = () => checkServiceFreshnessAsync(w.live.dir, {}, { ignoreReentrancyGuard: true }).then(daemonFreshnessFromService);
  const freshness = withLiveEditLadders(read, {
    daemonRepoDir: w.live.dir, installRepoDir: install.dir, stateDir: w.state, host: "fleet-host", clock: clockFromMillisFn(() => now),
    escalate: async (e) => { w.escalations.push(e); return ISSUE; },
    comment: async (url, body) => { w.comments.push({ url, body }); },
  });
  const held = await freshness();
  assert.deepEqual(held.stale ? "stale" : held.notStale?.arm, "dirty");
  assert.ok(existsSync(liveEditStatePath(w.state, "install-checkout")), "the install tree climbs the same ladder");
  now = T0 + 2 * HOUR;
  const freed = await freshness();
  assert.equal(freed.stale, true, JSON.stringify(freed));
  assert.equal(freed.stale && freed.staleSinceMs, T0, "the restart decision counts the lag from the episode start");
  assert.equal(readFileSync(join(install.dir, "app.txt"), "utf8"), "v1\n", "the install tree is restored too");
  assert.deepEqual(w.escalations.map((e) => e.taskId).sort(), ["LIVE-EDITS-daemon-checkout", "LIVE-EDITS-install-checkout"]);
});

test("live-edit ladder: porcelain paths include a rename's source, and an unreadable tree defers", async (t) => {
  assert.deepEqual(trackedEditPaths("R  new.txt\0old.txt\0 M app.txt\0"), ["app.txt", "new.txt", "old.txt"]);
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ladder-unreadable-`));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const r = await runLiveEditLadder({ tree: "install-checkout", repoDir: join(state, "absent"), stateDir: state, host: "h", clock: fixedClock(T0) });
  assert.equal(r.tier, 0);
  assert.equal(r.restored, false);
  assert.match(r.reason, /ladder unreadable/);
});
