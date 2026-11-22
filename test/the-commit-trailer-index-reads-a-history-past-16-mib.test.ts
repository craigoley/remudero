/** W1-T14364: the commit trailer index and the retro's awaited twin read a history past 16 MiB. */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import type { GhAsyncExecutor } from "#src/lib/github-transport.js";
import { ShippedReadPending } from "#src/lib/retro.js";
import { buildCommitTrailerIndex } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { retroShippedGithubGatewayAsync } from "#test/helpers/retro-shipped-gateway-seam.js";

const OLD_CAP = 1 << 24;

/** A repository whose origin/main history renders past the old cap, with a credited commit on each side of it. */
function longHistory(t: { after: (fn: () => void) => void }): string {
  const repo = gitRepo({ kind: "trailer-log-cap", seedCommit: false });
  t.after(() => repo.cleanup());
  const { dir } = repo;
  repo.addRemote("origin", "https://github.com/o/r.git");
  const commit = (message: string): void => {
    const file = join(dir, "message.txt");
    writeFileSync(file, message);
    repo.git("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-F", file);
  };
  commit("feat: the oldest build (#1)\n\nRemudero-Task: W1-T1\n");
  commit(`chore: a long history (#2)\n\n${`${"x".repeat(99)}\n`.repeat(Math.ceil((OLD_CAP + 1_000_000) / 100))}`);
  commit("feat: the newest build (#3)\n\nRemudero-Task: W1-T3\n");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

test("W1-T14364 criterion 1: the index credits the oldest and newest commit of a history past 16 MiB", (t) => {
  const index = buildCommitTrailerIndex({ slug: "o/r", cwd: longHistory(t) })();
  assert.ok(index, "the read did not fail on the byte cap");
  assert.deepEqual([...index.keys()].sort(), ["W1-T1", "W1-T3"]);
});

test("W1-T14364 criterion 2: the retro's awaited gateway credits a commit trailer from the same history", async (t) => {
  const dir = longHistory(t);
  const cacheRoot = makeTempDir("trailer-log-retro");
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  const snapshot = createBoardSnapshotCache(cacheRoot, "o", "r");
  // No pull request carries a trailer, so only the commit surface can credit the task.
  const execAsync: GhAsyncExecutor = async () => ({ stdout: "[]", stderr: "" });
  const gateway = await retroShippedGithubGatewayAsync({ ownerRepo: { owner: "o", repo: "r" }, snapshotFor: () => snapshot, execAsync, commitCwd: dir, log: () => {} });
  let found: { url: string } | null | undefined;
  for (let attempt = 0; attempt < 10 && found === undefined; attempt++) {
    try {
      found = gateway.findMergedByTrailer("W1-T3");
    } catch (error) {
      if (!(error instanceof ShippedReadPending)) throw error;
      await error.load();
    }
  }
  assert.equal(found?.url, "https://github.com/o/r/pull/3");
});

test("W1-T14364 criterion 3: invariant:failed-read-is-null — a history that cannot be read is still null, never an empty index", (t) => {
  const repo = gitRepo({ kind: "trailer-log-unreadable", seedCommit: false });
  t.after(() => repo.cleanup());
  repo.addRemote("origin", "https://github.com/o/r.git");
  assert.equal(buildCommitTrailerIndex({ slug: "o/r", cwd: repo.dir })(), null);
});
