import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWorktreeBase, WorktreeBaseStaleError, worktreeAddAsync } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

// MEASURED 2026-09-28..10-01: 10 build runs ended worktree.stale_base before any work ran — main advanced between the fetch and
// the ls-remote while a slow `worktree add` checked out (W1-T4939: fetched b1329af, main 2994dd9, behind 2). The worktree is
// brand new and holds nothing, so it is caught up to the remote head it just read instead of refusing the whole run.

function seededOrigin() {
  const seed = gitRepo({ kind: "w1t5120-seed" });
  const origin = gitRepo({ bare: true, kind: "w1t5120-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "w1t5120-clone" });
  const advance = (label: string): string => {
    writeFileSync(join(seed.dir, `${label}.txt`), label);
    seed.git("add", `${label}.txt`);
    seed.git("commit", "-q", "-m", label);
    seed.git("push", "-q", "origin", "main");
    return seed.git("rev-parse", "HEAD").trim();
  };
  const cleanup = () => [seed.dir, origin.dir, clone.dir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  return { repoDir: clone.dir, advance, cleanup };
}

test("W1-T5120: a base that fell behind while the worktree was cut is caught up", async (t) => {
  const { repoDir, advance, cleanup } = seededOrigin();
  const wtRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5120-wt-`));
  t.after(() => { cleanup(); rmSync(wtRoot, { recursive: true, force: true }); });
  let advanced: string | undefined;
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const wt = join(wtRoot, "wt");
  await worktreeAddAsync(repoDir, wt, "run-w1t5120-catch-up", "origin/main", {
    log: (step, extra) => rows.push([step, extra]),
    warn: () => {},
    readRemoteHead: (dir, ref) => {
      advanced ??= advance("landed-while-cutting");
      return execFileSync("git", ["-C", dir, "ls-remote", "origin", `refs/heads/${ref}`], { encoding: "utf8" }).split(/\s+/)[0]!;
    },
  });
  const head = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(head, advanced, "the fresh worktree sits on the remote head, not the stale fetch");
  assert.equal(readWorktreeBase(wt), advanced, "the recorded base moves with it");
  const caught = rows.find(([s]) => s === "worktree.base_caught_up");
  assert.ok(caught, "the catch-up is ledgered");
  assert.equal(caught?.[1]?.to, advanced);
});

test("W1-T5120: a base that cannot catch up is still refused", async (t) => {
  const { repoDir, cleanup } = seededOrigin();
  const wtRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5120-wt-`));
  t.after(() => { cleanup(); rmSync(wtRoot, { recursive: true, force: true }); });
  await assert.rejects(
    worktreeAddAsync(repoDir, join(wtRoot, "wt"), "run-w1t5120-refused", "origin/main", {
      warn: () => {},
      readRemoteHead: () => "1111111111111111111111111111111111111111",
    }),
    WorktreeBaseStaleError,
  );
});

test("W1-T5120: a base that is already current is left as cut, with the real ls-remote", async (t) => {
  const { repoDir, cleanup } = seededOrigin();
  const wtRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5120-wt-`));
  t.after(() => { cleanup(); rmSync(wtRoot, { recursive: true, force: true }); });
  const rows: string[] = [];
  const wt = join(wtRoot, "wt");
  await worktreeAddAsync(repoDir, wt, "run-w1t5120-current", "origin/main", { log: (step) => rows.push(step), warn: () => {} });
  assert.equal(rows.includes("worktree.base_caught_up"), false, "nothing to catch up");
  assert.equal(readWorktreeBase(wt), execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
});
