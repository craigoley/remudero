// 2026-10-06: gitPlanBehind spawned `git rev-parse <base> origin/main` on EVERY read-model materialize,
// idle passes included (~7 ms each, serve's views thread, for the now and workstreams views). The pair
// of heads is now read from the ref files, so an unmoved checkout spawns nothing; these prove that the
// file read answers exactly what the spawn answered, on a real repository, as each ref moves.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as nowView from "../src/lib/now-view.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

type Behind = ReturnType<typeof nowView.gitPlanBehind>;

/** A checkout one plan commit behind its origin/main, and a spy over the real git each read may spawn. */
function behindSlot(t: { after(fn: () => void): void }): { repo: GitRepo; planPath: string; calls: string[][]; git: (args: string[]) => string } {
  const repo = gitRepo({ kind: "plan-behind-refs" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  const planPath = join(repo.dir, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  repo.git("add", "plan");
  repo.git("commit", "-q", "-m", "plan");
  const boot = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T9.yaml"), "[]\n");
  repo.git("add", "plan");
  repo.git("commit", "-q", "-m", "a plan commit");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("reset", "-q", "--hard", boot);
  const calls: string[][] = [];
  const git = (args: string[]): string => {
    calls.push(args);
    return repo.git(...args.slice(2));
  };
  return { repo, planPath, calls, git };
}

/** The spawned answer: the same read with the ref-file reader disabled and a fresh memo. */
function spawned(planPath: string, base?: string): Behind {
  return nowView.gitPlanBehind(planPath, {}, undefined, base, () => undefined);
}

test("an unmoved checkout's plan-behind read spawns no git rev-parse", (t) => {
  const slot = behindSlot(t);
  const memo = {};
  const first = nowView.gitPlanBehind(slot.planPath, memo, slot.git, "HEAD");
  assert.equal("commits" in first ? first.commits : -1, 1, `one plan commit behind: ${JSON.stringify(first)}`);
  slot.calls.length = 0;
  for (let i = 0; i < 3; i++) assert.deepEqual(nowView.gitPlanBehind(slot.planPath, memo, slot.git, "HEAD"), first);
  assert.deepEqual(slot.calls, [], "an idle materialize spawns no git at all");
});

test("the ref-file heads equal git rev-parse for HEAD, a pinned sha, and a packed origin/main", (t) => {
  const slot = behindSlot(t);
  const dir = slot.repo.dir;
  const main = slot.repo.git("rev-parse", "origin/main");
  assert.equal(nowView.planHeadsFromRefFiles(dir, "HEAD"), slot.repo.git("rev-parse", "HEAD", "origin/main"));
  assert.equal(nowView.planHeadsFromRefFiles(dir, main), `${main}\n${main}`, "a pinned full sha is its own left side");
  slot.repo.git("pack-refs", "--all");
  assert.equal(nowView.planHeadsFromRefFiles(dir, "HEAD"), slot.repo.git("rev-parse", "HEAD", "origin/main"), "packed-refs answers once the loose refs are gone");
  assert.equal(nowView.planHeadsFromRefFiles(dir, "origin/main"), undefined, "a ref name it does not resolve falls back to the spawn");
});

test("a memoized plan-behind read answers what the spawned read answers as each ref moves", (t) => {
  const slot = behindSlot(t);
  const memo = {};
  const read = (): Behind => nowView.gitPlanBehind(slot.planPath, memo, slot.git, "HEAD");
  assert.deepEqual(read(), spawned(slot.planPath, "HEAD"));

  // origin/main gains a second plan commit (a fetch moves only refs/remotes/origin/main).
  slot.repo.git("checkout", "-q", "--detach", "origin/main");
  writeFileSync(join(slot.repo.dir, "plan", "tasks.d", "W1-T10.yaml"), "[]\n");
  slot.repo.git("add", "plan");
  slot.repo.git("commit", "-q", "-m", "another plan commit");
  slot.repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  slot.repo.git("checkout", "-q", "main");
  const twoBehind = read();
  assert.equal("commits" in twoBehind ? twoBehind.commits : -1, 2, `a moved origin/main is seen at once: ${JSON.stringify(twoBehind)}`);
  assert.deepEqual(twoBehind, spawned(slot.planPath, "HEAD"));

  // The checkout pulls: HEAD's branch moves to origin/main, after the refs are packed.
  slot.repo.git("pack-refs", "--all");
  slot.repo.git("reset", "-q", "--hard", "origin/main");
  assert.deepEqual(read(), { commits: 0 }, "a moved HEAD branch is seen at once");
  assert.deepEqual(read(), spawned(slot.planPath, "HEAD"));
});

test("a linked worktree's plan-behind read resolves its own HEAD through the common dir", (t) => {
  const slot = behindSlot(t);
  const linked = slot.repo.addWorktree(join(slot.repo.dir, "..", `${slot.repo.dir.split("/").pop()}-linked`), "linked", "HEAD");
  t.after(() => linked.cleanup());
  const planPath = join(linked.dir, "plan", "tasks.yaml");
  assert.equal(nowView.planHeadsFromRefFiles(linked.dir, "HEAD"), linked.git("rev-parse", "HEAD", "origin/main"));
  assert.deepEqual(nowView.gitPlanBehind(planPath, {}, slot.git, "HEAD"), spawned(planPath, "HEAD"));
});
