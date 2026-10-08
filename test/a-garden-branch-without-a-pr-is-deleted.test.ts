/**
 * W1-T4775: `gardenCheckout`'s land pushes `<name>-garden-<ms>` before it opens the PR. A create that
 * is refused must delete that head (the create failure's reason is rethrown, `<name>.garden_head_deleted`
 * is ledgered); a create that succeeds leaves the head for its PR.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gardenCheckout } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

function fixture(fetcher: (args: string[]) => unknown, log: (step: string, extra?: Record<string, unknown>) => void) {
  const seed = gitRepo({ kind: "garden-head-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "README.md");
  seed.git("commit", "-q", "-m", "seed");
  const origin = gitRepo({ bare: true, kind: "garden-head-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "garden-head-clone" });
  clone.git("config", "user.email", "g@example.invalid");
  clone.git("config", "user.name", "g");
  const ws = gardenCheckout({
    name: "plan",
    repoDir: clone.dir,
    worktreesRoot: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-head-wt-`)),
    owner: "acme",
    repo: "remudero",
    log,
    clock: fixedClock(1790000000004),
    fetcher,
  });
  writeFileSync(join(ws.root, "change.txt"), "x\n");
  const heads = () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
  const done = () => {
    ws.dispose();
    origin.cleanup();
    seed.cleanup();
    clone.cleanup();
  };
  return { ws, heads, done };
}

const isCreate = (args: string[]) => args.includes("POST") || args.some((a) => a === "--method");

test("W1-T4775: a refused garden PR create deletes its pushed head", () => {
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const f = fixture(
    (args) => {
      if (isCreate(args)) throw new Error("HTTP 422: refused");
      return [];
    },
    (step, extra) => rows.push([step, extra]),
  );
  try {
    assert.throws(() => withLiveWritesAllowed(() => f.ws.land({ paths: ["change.txt"], title: "chore: t", body: "b" })), /HTTP 422: refused/);
    assert.deepEqual(f.heads(), ["main"], "the head pushed for the refused create is gone");
    assert.deepEqual(rows.filter(([s]) => s.includes("garden_")), [["plan.garden_head_deleted", { branch: "plan-garden-1790000000004" }]]);
  } finally {
    f.done();
  }
});

test("W1-T4775: a created garden PR keeps its head", () => {
  const rows: string[] = [];
  const f = fixture(
    (args) => (isCreate(args) ? { html_url: "https://github.com/acme/remudero/pull/7", number: 7 } : []),
    (step) => rows.push(step),
  );
  try {
    const url = withLiveWritesAllowed(() => f.ws.land({ paths: ["change.txt"], title: "chore: t", body: "b" }));
    assert.equal(url, "https://github.com/acme/remudero/pull/7");
    assert.deepEqual(f.heads(), ["main", "plan-garden-1790000000004"], "the head a created PR sits on is kept");
    assert.deepEqual(rows.filter((s) => s.includes("garden_")), [], "nothing is deleted or retracted");
  } finally {
    f.done();
  }
});
