/**
 * A LANDING PUSH FAILURE NAMES ITS REAL CAUSE.
 *
 * On 2026-10-15 the core sweep's feedback landing logged "refused to force-replace feedback-landing:
 * its tip moved again" three times (03:05Z, 03:43Z, 05:41Z). The tip never moved: both pushes in
 * each pass leased the SAME sha, and both failed with git's "could not read Username" because the
 * daemon's own checkout had been wired to a credential socket that was not listening yet at boot.
 * `finishLanding` read every push failure as a lost lease, re-ran the whole preflight, pushed again,
 * and reported a race that never happened.
 *
 * These tests drive `landFeedback` against a real local bare origin; only `gh` is faked.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LANDING_BRANCH, landFeedback } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo } from "#test/helpers/git-repo.js";

function seededOrigin(): string {
  const origin = gitRepo({ bare: true, kind: "landing-cause-origin" });
  const seed = gitRepo({ kind: "landing-cause-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.cleanup();
  return origin.dir;
}

function stateRootOf(origin: string): string {
  return gitRepo({ cloneFrom: origin, kind: "landing-cause-root" }).dir;
}

function fakeGh(prUrl: string) {
  let created = 0;
  return (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(created > 0 ? [{ url: prUrl }] : []);
    if (args[0] === "pr" && args[1] === "create") {
      created++;
      return `${prUrl}\n`;
    }
    if (args[0] === "api") return "{}";
    throw new Error(`unexpected gh call in test fixture: ${JSON.stringify(args)}`);
  };
}

function writeFeedbackEntry(root: string, id: string): void {
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", `${id}.yaml`), `id: ${id}\nraw: ${id} record\n`);
}

function branchTip(origin: string): string {
  return execFileSync("git", ["--git-dir", origin, "rev-parse", `refs/heads/${LANDING_BRANCH}`], { encoding: "utf8" }).trim();
}

test("a landing push refused for credentials is reported as that failure, is pushed once, and never claims the tip moved", () => {
  const origin = seededOrigin();
  const root = stateRootOf(origin);
  writeFeedbackEntry(root, "fb-cause-first");
  assert.equal(withLiveWritesAllowed(() => landFeedback(root, { gh: fakeGh("https://github.com/o/r/pull/901") })).landed, true);
  const tipBefore = branchTip(origin);
  writeFeedbackEntry(root, "fb-cause-second");

  const pushes: string[][] = [];
  const credentiallessGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "push") {
      pushes.push(args);
      throw new Error(
        `Command failed: git -C ${root} ${args.join(" ")}\n` +
          "fatal: could not read Username for 'https://github.com/o/r.git': No such device or address\n",
      );
    }
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: opts?.env ?? process.env });
  };

  const result = withLiveWritesAllowed(() =>
    landFeedback(root, { gh: fakeGh("https://github.com/o/r/pull/901"), git: credentiallessGit }));

  assert.equal(result.landed, false);
  assert.match(result.error ?? "", /could not read Username/, "the real cause is the reported cause");
  assert.doesNotMatch(result.error ?? "", /tip moved/, "a credential failure is never reported as a moved tip");
  assert.equal(pushes.length, 1, "nothing moved, so nothing is re-derived and pushed a second time");
  assert.equal(result.leaseMoved, undefined, "no lease was lost");
  assert.equal(branchTip(origin), tipBefore, "the branch is untouched");
});

test("a lost lease records the tip it found and who wrote it", () => {
  const origin = seededOrigin();
  const rootA = stateRootOf(origin);
  const rootB = stateRootOf(origin);
  writeFeedbackEntry(rootA, "fb-cause-a");
  writeFeedbackEntry(rootB, "fb-cause-b");

  let tipA: string | undefined;
  const racingGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "push" && tipA === undefined) {
      assert.equal(withLiveWritesAllowed(() => landFeedback(rootA, { gh: fakeGh("https://github.com/o/r/pull/902") })).landed, true);
      tipA = branchTip(origin);
    }
    return execFileSync("git", ["-C", rootB, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: opts?.env ?? process.env });
  };

  const result = withLiveWritesAllowed(() =>
    landFeedback(rootB, { gh: fakeGh("https://github.com/o/r/pull/903"), git: racingGit }));

  assert.equal(result.landed, true, "the re-derived retry lands against the moved tip");
  assert.ok(tipA, "sanity: root A moved the tip mid-push");
  assert.equal(result.leaseMoved?.expected, undefined, "B leased the branch as absent");
  assert.equal(result.leaseMoved?.observed, tipA, "the tip B found is the one A pushed");
  assert.match(result.leaseMoved?.by ?? "", /remudero-fleet\[bot\].*land pending filings/, "and names who wrote it");
});

test("a lost lease whose new tip cannot be read still records the move, with its author unknown", () => {
  const origin = seededOrigin();
  const rootA = stateRootOf(origin);
  const rootB = stateRootOf(origin);
  writeFeedbackEntry(rootA, "fb-cause-unread-a");
  writeFeedbackEntry(rootB, "fb-cause-unread-b");

  let tipA: string | undefined;
  const racingGit = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "log") throw new Error("fatal: bad object");
    if (args[0] === "push" && tipA === undefined) {
      assert.equal(withLiveWritesAllowed(() => landFeedback(rootA, { gh: fakeGh("https://github.com/o/r/pull/904") })).landed, true);
      tipA = branchTip(origin);
    }
    return execFileSync("git", ["-C", rootB, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: opts?.env ?? process.env });
  };

  const result = withLiveWritesAllowed(() =>
    landFeedback(rootB, { gh: fakeGh("https://github.com/o/r/pull/905"), git: racingGit }));

  assert.equal(result.landed, true);
  assert.equal(result.leaseMoved?.observed, tipA, "the move is recorded");
  assert.equal(result.leaseMoved?.by, undefined, "only who made it is unknown");
});
