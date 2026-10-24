import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { affectedSelectionOrFull, affectedSelectionOrFullAsync, readAffectedSuitesInput, selectAffectedSuites } from "#src/lib/affected-suites.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const removed = "test/removed.test.ts";
const present = "test/present.test.ts";
const files = () => new Map([["src/a.ts", "export const a = 1;"], [present, 'import { a } from "#src/a.js";']]);

test("affected selection falls back for a missing changed suite instead of returning a ghost", () => {
  const result = selectAffectedSuites(["src/a.ts", removed], { files: files(), pathReaders: [] });
  assert.equal(result.fullRun, true);
  assert.deepEqual(result.suites, []);
  assert.match(result.reasons[0]!, /changed suite test\/removed\.test\.ts is absent/);
});

test("affected selection keeps existing changed suites and their caller floor", () => {
  const result = selectAffectedSuites(["src/a.ts", present], { files: files(), pathReaders: [] });
  assert.equal(result.fullRun, false);
  assert.deepEqual(result.suites, [present]);
});

test("affected selection does not excuse unknown paths or unreadable input as verified deletions", async () => {
  const absent = affectedSelectionOrFull([removed], () => ({ files: files(), pathReaders: [] }));
  assert.equal(absent.fullRun, true);
  assert.deepEqual(absent.suites, []);
  const unread = affectedSelectionOrFull([removed], () => { throw new Error("unread input"); });
  assert.equal(unread.fullRun, true);
  assert.match(unread.reasons[0]!, /could not read its input.*unread input/);
  const awaited = await affectedSelectionOrFullAsync([removed], async () => ({ files: files(), pathReaders: [] }));
  assert.equal(awaited.fullRun, true);
  assert.deepEqual(awaited.suites, []);
});

test("real committed suite deletion selects the conservative fallback from the current tracked tree", t => {
  const repo = gitRepo({ scope: t, kind: "deleted-suite-selection" });
  mkdirSync(join(repo.dir, "src")); mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo.dir, present), 'import { a } from "#src/a.js";\n');
  writeFileSync(join(repo.dir, removed), "export {};\n");
  repo.git("add", "."); repo.git("commit", "-m", "fixture with both suites");
  rmSync(join(repo.dir, removed));
  writeFileSync(join(repo.dir, "src/a.ts"), "export const a = 2;\n");
  repo.git("add", "-A"); repo.git("commit", "-m", "fixture removes one suite and changes its module");
  const changed = repo.git("diff", "--name-only", "HEAD^", "HEAD").split("\n");
  const input = readAffectedSuitesInput(repo.dir, changed);
  assert.equal(input.files.has(present), true);
  assert.equal(input.files.has(removed), false);
  const result = affectedSelectionOrFull(changed, () => input);
  assert.equal(result.fullRun, true);
  assert.match(result.reasons[0]!, /changed suite test\/removed\.test\.ts is absent/);
  assert.deepEqual(result.suites, []);
});
