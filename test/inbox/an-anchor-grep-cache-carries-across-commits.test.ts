/**
 * W1-T13302: serve re-ran about 1,300 whole-tree `git grep` children every time main moved (28 moves in 3 hours on
 * 2026-11-17), because a new sha emptied the evidence-anchor cache. The cache now carries every answer whose path
 * scope holds no file changed between the two commits, and re-greps only the rest.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  ANCHOR_CARRY_MAX_CHANGED_FILES, cachedAnchorGrep, createAnchorGrepCache, gitAnchorChangedFiles, gitGrepAnchorTrue,
  warmAnchorGrepCache, type EvidenceAnchor,
} from "#src/lib/inbox.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const anchor = (pattern: string, path?: string): EvidenceAnchor => (path === undefined ? { description: pattern, pattern } : { description: pattern, pattern, path });

function repo(t: { after: (fn: () => void) => void }): GitRepo & { commit: (files: Record<string, string | null>) => string } {
  const r = gitRepo({ kind: "anchor-carry" });
  t.after(() => r.cleanup());
  return Object.assign(r, {
    commit(files: Record<string, string | null>): string {
      for (const [rel, text] of Object.entries(files)) {
        const abs = join(r.dir, rel);
        if (text === null) rmSync(abs, { force: true });
        else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); }
      }
      r.git("add", "-A");
      r.git("commit", "--quiet", "--allow-empty", "-m", "step");
      return r.git("rev-parse", "HEAD");
    },
  });
}

test("W1-T13302 criterion 1: a move from A to B re-greps only the anchors whose path a changed file lies in", async (t) => {
  const r = repo(t);
  const a = r.commit({ "plan/tasks.d/W1-T1.yaml": "status: queued\n", "src/lib/x.ts": "export const x = 1;\n", "src/lib/y.ts": "export const y = 1;\n" });
  const b = r.commit({ "src/lib/x.ts": "export const x = 2;\n" });
  const anchors = [anchor("status: queued", "plan/tasks.d/W1-T1.yaml"), anchor("x = 1", "src/lib/x.ts"), anchor("y = 1", "src/lib/y.ts"), anchor("absent", "src/lib/y.ts"), anchor("x = 2", "src/lib")];
  const cache = createAnchorGrepCache(gitAnchorChangedFiles(r.dir));
  const seen: string[] = [];
  const grep = async (ref: string, x: EvidenceAnchor) => (seen.push(`${ref === a ? "A" : "B"}:${x.pattern}`), gitGrepAnchorTrue(r.dir, ref, x));
  await warmAnchorGrepCache(cache, a, anchors, grep);
  assert.equal(seen.length, anchors.length, "positive control: at A every anchor is grepped once");
  seen.length = 0;
  await warmAnchorGrepCache(cache, b, anchors, grep);
  assert.deepEqual(seen.sort(), ["B:x = 1", "B:x = 2"], "only the anchors on src/lib/x.ts and on src/lib are re-grepped");
  const answers = anchors.map((x) => cachedAnchorGrep(cache, b, x, () => assert.fail("every answer is cached at B")));
  assert.deepEqual(answers, [true, false, true, false, true]);
  // The plain cache (no changed-files reader) still empties on every new sha.
  const plain = createAnchorGrepCache();
  let plainGreps = 0;
  for (const sha of [a, b]) for (const x of anchors) cachedAnchorGrep(plain, sha, x, (ref, y) => (plainGreps++, gitGrepAnchorTrue(r.dir, ref, y)));
  assert.equal(plainGreps, 2 * anchors.length);
});

test("W1-T13302 criterion 2: after adds, edits, deletes and renames, every carried answer equals a fresh grep at B", (t) => {
  const r = repo(t);
  const a = r.commit({ "d/keep.txt": "alpha\n", "d/edit.txt": "beta\n", "d/gone.txt": "gamma\n", "d/old.txt": "delta\n", "e/other.txt": "alpha\n", "top.txt": "omega\n" });
  r.git("mv", "d/old.txt", "d/new.txt");
  const b = r.commit({ "d/edit.txt": "beta2\n", "d/gone.txt": null, "d/added.txt": "alpha\n", "e/fresh.txt": "epsilon\n" });
  const anchors: EvidenceAnchor[] = [];
  for (const pattern of ["alpha", "beta2", "gamma", "delta", "nowhere"]) {
    for (const path of [undefined, "d", "d/", "e", "d/keep.txt", "d/edit.txt", "d/gone.txt", "d/old.txt", "d/new.txt", "d/added.txt", "e/fresh.txt", "top.txt", "*.txt"]) anchors.push(anchor(pattern, path));
  }
  const cache = createAnchorGrepCache(gitAnchorChangedFiles(r.dir));
  for (const x of anchors) cachedAnchorGrep(cache, a, x, (ref, y) => gitGrepAnchorTrue(r.dir, ref, y));
  let regreps = 0;
  for (const x of anchors) {
    const carried = cachedAnchorGrep(cache, b, x, (ref, y) => (regreps++, gitGrepAnchorTrue(r.dir, ref, y)));
    assert.equal(carried, gitGrepAnchorTrue(r.dir, b, x), `${x.pattern} in ${x.path ?? "(whole tree)"}`);
  }
  assert.ok(regreps > 0 && regreps < anchors.length, `some answers were carried and some re-grepped (${regreps} of ${anchors.length})`);
});

test("W1-T13302 criterion 3: a failed diff, or one past the changed-file cap, empties the cache as before", (t) => {
  const r = repo(t);
  const a = r.commit({ "keep.txt": "alpha\n" });
  const b = r.commit({ "other.txt": "beta\n" });
  const x = anchor("alpha", "keep.txt");
  const cases: Array<[string, () => string[] | undefined, number]> = [
    ["a failed diff", () => undefined, 2],
    ["a diff past the cap", () => Array.from({ length: ANCHOR_CARRY_MAX_CHANGED_FILES + 1 }, (_, i) => `f${i}`), 2],
    ["positive control: a small, readable diff carries", () => ["other.txt"], 1],
  ];
  for (const [label, changed, expected] of cases) {
    const cache = createAnchorGrepCache(changed);
    let greps = 0;
    const grep = (ref: string, y: EvidenceAnchor) => (greps++, gitGrepAnchorTrue(r.dir, ref, y));
    cachedAnchorGrep(cache, a, x, grep);
    assert.equal(cachedAnchorGrep(cache, b, x, grep), true);
    assert.equal(greps, expected, label);
  }
  assert.equal(gitAnchorChangedFiles(r.dir)("0".repeat(40), b), undefined, "a commit that does not exist reads as undefined");
});
