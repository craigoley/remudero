import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { landingIdentity, sweepFeedbackLanding, type LandingRepository } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

// W1-T9616: finishLanding skipped a push only when origin/<landing>'s TREE equalled main plus the
// pending records, so any main commit between sweeps force-replaced an open landing PR's head with
// the same records (#11901: four head changes, each a new CI run and review). Each test lands once
// against a real bare origin, moves main, and sweeps again; only `gh` is faked.

const TARGET: LandingRepository = { owner: "o", repo: "r" };
const OWNER = "w1-t9616-fixture";
const BRANCH = landingIdentity({ family: "feedback", targetRepository: TARGET, landingOwner: OWNER }).branch;
const preflightOk = () => ({ ok: true, failures: [], unreadable: [] });
const gh = (args: string[]): string => (args[0] === "pr" && args[1] === "list" ? "[]" : "https://github.com/o/r/pull/9616\n");
const fb = (id: string, status: string): string => `id: ${id}\nstatus: ${status}\nraw: ${id} body\n`;
const A = "plan/feedback/fb-a.yaml";
const B = "plan/feedback/fb-b.yaml";

interface Fixture {
  origin: GitRepo;
  root: string;
  /** Commit `files` straight onto origin's main through the seed checkout, main's only writer. */
  moveMain(files: Record<string, string>, message: string): void;
  /** Write a record into the sweeping checkout, as a capture would. */
  capture(path: string, content: string): void;
  tip(ref: string): string;
  sweep(rows: Array<Record<string, unknown> | undefined>, pushes?: string[][]): ReturnType<typeof sweepFeedbackLanding>;
}

function fixture(kind: string): Fixture {
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const seed = gitRepo({ kind: `${kind}-seed` });
  seed.addRemote("origin", origin.dir);
  const write = (dir: string, path: string, content: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const moveMain = (files: Record<string, string>, message: string): void => {
    for (const [path, content] of Object.entries(files)) write(seed.dir, path, content);
    seed.git("add", "-A");
    seed.git("commit", "--quiet", "-m", message);
    seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  };
  moveMain({ "README.md": "base\n", "plan/feedback/fb-base.yaml": fb("fb-base", "new") }, "base");
  const root = gitRepo({ cloneFrom: origin.dir, kind: `${kind}-root` }).dir;
  return {
    origin,
    root,
    moveMain,
    capture: (path, content) => write(root, path, content),
    tip: (ref) => origin.git("rev-parse", ref).trim(),
    sweep(rows, pushes) {
      // The checkout's own fetch of main, as the daemon's poll makes before each sweep.
      execFileSync("git", ["-C", root, "fetch", "--quiet", "origin"]);
      const git = (args: string[], o?: { env?: NodeJS.ProcessEnv }): string => {
        if (args[0] === "push") pushes?.push(args);
        return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: o?.env ?? process.env });
      };
      return withLiveWritesAllowed(() =>
        sweepFeedbackLanding(root, {
          gh,
          git,
          targetRepository: TARGET,
          landingOwner: OWNER,
          planPrPreflight: preflightOk,
          log: (step, extra) => {
            if (step === "feedback.landing_sweep") rows.push(extra);
          },
        }),
      );
    },
  };
}

test("W1-T9616: an unchanged landing is not re-pushed when main moves", () => {
  const f = fixture("w9616-unchanged");
  f.capture(A, fb("fb-a", "new"));
  const rows: Array<Record<string, unknown> | undefined> = [];
  const first = f.sweep(rows);
  assert.equal(first.pushed, true, first.error);
  const head = f.tip(BRANCH);

  // Main moves under the open landing: an unrelated file, then a feedback record the landing never held.
  f.moveMain({ "README.md": "main moved\n" }, "unrelated main commit");
  f.moveMain({ "plan/feedback/fb-other.yaml": fb("fb-other", "new") }, "another record lands on main");
  const pushes: string[][] = [];
  const again = f.sweep(rows, pushes);

  assert.equal(again.error, undefined);
  assert.equal(again.pushed, false, "the same records are not force-pushed again");
  assert.deepEqual(pushes, [], "no push was even attempted");
  assert.equal(f.tip(BRANCH), head, "the open landing PR's head stays");
  assert.equal(again.landed, true, "an unchanged landing still counts as landed");
  assert.equal(again.unchangedSinceMainMoved, true);
  assert.equal(rows.at(-1)?.unchanged_since_main_moved, true, "the quiet sweep row names why it skipped");
  assert.equal(rows.at(-1)?.pushed, false);

  // A GitHub update-branch merges main into the landing; the merge tip is compared from its merge base.
  f.moveMain({ "README.md": "main moved again\n" }, "one more main commit");
  const seed = gitRepo({ cloneFrom: f.origin.dir, kind: "w9616-update-branch" });
  seed.git("checkout", "--quiet", "-b", "landing", `origin/${BRANCH}`);
  seed.git("merge", "--quiet", "--no-ff", "--no-edit", "origin/main");
  seed.git("push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
  const merged = f.tip(BRANCH);
  f.moveMain({ "README.md": "and once more\n" }, "main moves after the update-branch");
  const third = f.sweep(rows, pushes);
  assert.equal(third.pushed, false, third.error);
  assert.deepEqual(pushes, []);
  assert.equal(f.tip(BRANCH), merged, "an updated branch's head stays too");
});

test("W1-T9616: a changed landing is still pushed under its lease", () => {
  const leased = (pushes: string[][], tip: string): void =>
    assert.deepEqual(pushes.map((p) => p[1]), [`--force-with-lease=refs/heads/${BRANCH}:${tip}`], "pushed under the lease on the tip it read");

  // A new record beside the landed one.
  const f = fixture("w9616-changed");
  f.capture(A, fb("fb-a", "new"));
  const rows: Array<Record<string, unknown> | undefined> = [];
  assert.equal(f.sweep(rows).pushed, true);
  f.moveMain({ "README.md": "main moved\n" }, "unrelated main commit");
  f.capture(B, fb("fb-b", "new"));
  let tip = f.tip(BRANCH);
  let pushes: string[][] = [];
  const added = f.sweep(rows, pushes);
  assert.equal(added.pushed, true, added.error);
  assert.equal(added.unchangedSinceMainMoved, undefined);
  assert.equal(rows.at(-1)?.unchanged_since_main_moved, undefined, "an acting row never claims the skip");
  leased(pushes, tip);
  assert.notEqual(f.tip(BRANCH), tip);
  assert.match(f.origin.git("show", `${BRANCH}:${B}`), /id: fb-b/, "the new record rides");

  // A changed record: the capture moves fb-a forward in its lifecycle.
  f.moveMain({ "README.md": "main moved twice\n" }, "unrelated main commit");
  f.capture(A, fb("fb-a", "accepted"));
  tip = f.tip(BRANCH);
  pushes = [];
  const changed = f.sweep(rows, pushes);
  assert.equal(changed.pushed, true, changed.error);
  leased(pushes, tip);
  assert.match(f.origin.git("show", `${BRANCH}:${A}`), /status: accepted/);

  // A record main changed since the branch's base: the landing's own copy is untouched, yet its
  // base blob for fb-a is no longer main's, so the branch is rebuilt on the main that changed it.
  const g = fixture("w9616-main-changed");
  g.capture(A, fb("fb-a", "accepted"));
  assert.equal(g.sweep(rows).pushed, true);
  // fb-a reaches main by another route at an earlier lifecycle step, beside an unrelated change (so
  // the trees differ and only the landing's own change can decide); the landing's advance still wins.
  g.moveMain({ [A]: fb("fb-a", "grilling"), "README.md": "main moved\n" }, "fb-a lands on main behind the landing");
  tip = g.tip(BRANCH);
  pushes = [];
  const rebased = g.sweep(rows, pushes);
  assert.equal(rebased.unchangedSinceMainMoved, undefined, "a record main changed is never read as unchanged");
  assert.equal(rebased.pushed, true, rebased.error);
  leased(pushes, tip);
  assert.equal(g.origin.git("rev-parse", `${BRANCH}^`).trim(), g.tip("main"), "rebuilt on the main that changed it");
  assert.match(g.origin.git("show", `${BRANCH}:${A}`), /status: accepted/);
});
