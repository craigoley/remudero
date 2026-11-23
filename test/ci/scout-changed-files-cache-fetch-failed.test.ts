import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { createChangedFilesCache } from "#src/lib/changed-files-cache.js";
import { withTempDir } from "#src/lib/tmp.js";
import { ghShim, type GhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";

const prUrl = "https://github.com/o/r/pull/17";
const head = "a".repeat(40);
const failureEvent = "changed_files_cache.fetch_failed";
const rateLimit = "gh: secondary rate limit (HTTP 403)";

async function withPullFilesShim(response: GhShimRoute, run: (root: string, shim: GhShim) => Promise<void>): Promise<void> {
  await withTempDir("cf", async (root) => {
    const shim = ghShim([response], { parent: root });
    const previousPath = process.env.PATH;
    const previousCache = process.env.RMD_GH_CACHE_HOME;
    process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
    process.env.RMD_GH_CACHE_HOME = root;
    try {
      await run(root, shim);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCache === undefined) delete process.env.RMD_GH_CACHE_HOME;
      else process.env.RMD_GH_CACHE_HOME = previousCache;
    }
  });
}

test("W1-T13100: changed_files_cache.fetch_failed no longer recurs", async () => {
  const expectedFiles = [" docs/notes.md ", "src/line\nbreak.ts"];
  const stdout = expectedFiles.map((name) => JSON.stringify(name)).join("\n");
  await withPullFilesShim({ when: "pulls/17/files", stdout }, async (root, shim) => {
    const events: string[] = [];
    const log = (event: string) => events.push(event);
    const caches = ["board", "daemon"].map((name) => createChangedFilesCache(join(root, name), "o", "r", { log }));
    for (const cache of caches) assert.equal(cache.lookup(prUrl, "MERGED", head), undefined);
    await Promise.all(caches.map((cache) => cache.settle()));
    for (const cache of caches) {
      assert.deepEqual(cache.lookup(prUrl, "MERGED", head), expectedFiles);
      assert.equal(cache.evidence?.(prUrl, "MERGED", head).status, "complete");
    }
    assert.deepEqual(shim.calls(), ["api --paginate repos/o/r/pulls/17/files --jq .[].filename | @json"]);
    assert.ok(!events.includes(failureEvent));
  });
});

test("W1-T13100: the symptom is still recorded when its failure occurs", async () => {
  await withPullFilesShim({ when: "pulls/17/files", stdout: "partial.ts", stderr: rateLimit, exit: 1 }, async (root, shim) => {
    const failures: Array<Record<string, unknown> | undefined> = [];
    const log = (event: string, extra?: Record<string, unknown>) => {
      if (event === failureEvent) failures.push(extra);
    };
    const caches = ["board", "daemon"].map((name) => createChangedFilesCache(join(root, name), "o", "r", { log }));

    for (const cache of caches) assert.equal(cache.lookup(prUrl, "MERGED"), undefined);
    await Promise.all(caches.map((cache) => cache.settle()));
    for (const cache of caches) assert.equal(cache.lookup(prUrl, "MERGED"), undefined);
    await Promise.all(caches.map((cache) => cache.settle()));
    assert.equal(failures.length, 2);
    for (const failure of failures) {
      assert.equal(failure?.repository, "o/r");
      assert.equal(failure?.pr, "17");
      assert.match(String(failure?.error), /secondary rate limit \(HTTP 403\)/);
    }
    assert.equal(shim.calls().length, 1);
  });
});

test("concurrent open pull request reads for different heads stay independent", async () => {
  await withPullFilesShim({ when: "pulls/17/files", stdout: "open.ts" }, async (root, shim) => {
    const first = createChangedFilesCache(join(root, "first"), "o", "r");
    const second = createChangedFilesCache(join(root, "second"), "o", "r");
    first.lookup(prUrl, "OPEN", head);
    second.lookup(prUrl, "OPEN", "b".repeat(40));
    await Promise.all([first.settle(), second.settle()]);
    assert.equal(shim.calls().length, 2);
  });
});
