// test/the-content-landings-read-identity-and-acknowledge-off-the-loop.test.ts — W1-T9755.
//
// W1-T9638 moved the per-poll landing's local git off the daemon loop, but the ci-learning landing still built its
// kind through the SYNC driver (`git config --get remote.origin.url` for the target and for the source checkout: two
// synchronous children per landing, even inside landCiLearningShardsAsync), the plan-reconcile kind did the same,
// and acknowledgeMergedCiLearningShards ran a synchronous `git rev-parse` and `git hash-object` per queued shard.
// Each is now an ask on the landing's own net, so the async driver awaits it.
//
// THE OBSERVATION: a `git` on PATH sleeps 0.3 s and logs each child's start and end (wall-clock ms), and a 20 ms
// interval beside the landing logs its ticks. A child the loop awaits has ticks inside its window; a synchronous
// child holds the loop for the whole window, so none can land there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  landCiLearningShards,
  landCiLearningShardsAsync,
  landPlanReconcileShardsAsync,
  type LandCiLearningShardsOptions,
} from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "../src/lib/plan-pr-emitter.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const PR_URL = "https://github.com/o/r/pull/9755";
const SHARDS = "plan/tasks.d";
const PENDING = join("state", "ci-learning-pending");

/** A shard; one with no `origin:` can be acknowledged only by its bytes. */
const shard = (id: string, title = id, origin?: string): string =>
  `- id: ${id}\n  title: ${title}\n  repo: r\n  type: implement\n  status: queued\n${origin ? `  origin: ${origin}\n` : ""}`;
/** Main holds W1-T1's bytes, an edited W1-T2, and W1-T4's finding under other bytes; W1-T3 is new. */
const ON_MAIN = { "W1-T1-merged.yaml": shard("W1-T1", "merged"), "W1-T2-changed.yaml": shard("W1-T2", "on main"),
  "W1-T4-by-origin.yaml": shard("W1-T4", "on main", "finding-4") };
const QUEUED = { "W1-T1-merged.yaml": shard("W1-T1", "merged"), "W1-T2-changed.yaml": shard("W1-T2", "queued edit"),
  "W1-T3-new.yaml": shard("W1-T3"), "W1-T4-by-origin.yaml": shard("W1-T4", "queued", "finding-4") };

/** A bare origin whose main holds `onMain`, a clone of it, and a daemon state root queuing `queued`. */
function fixture(nonce: string, onMain: Record<string, string>, queued: Record<string, string>) {
  const origin = gitRepo({ bare: true, kind: `w9755-${nonce}-origin` });
  const seed = gitRepo({ kind: `w9755-${nonce}-seed` });
  mkdirSync(join(seed.dir, SHARDS), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  for (const [name, content] of Object.entries(onMain)) writeFileSync(join(seed.dir, SHARDS, name), content);
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed plan");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: `w9755-${nonce}-clone` });
  clone.git("config", "user.name", "w9755 fixture");
  clone.git("config", "user.email", "w9755@remudero.invalid");
  const state = makeTempDir(`w9755-${nonce}-state`);
  const pendingDir = join(state, PENDING, SHARDS);
  mkdirSync(pendingDir, { recursive: true });
  for (const [name, content] of Object.entries(queued)) writeFileSync(join(pendingDir, name), content);
  const ghCalls: string[][] = [];
  const gh = (args: string[]): string => {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return `${PR_URL}\n`;
    return "";
  };
  const deps = (): LandCiLearningShardsOptions => ({
    stateRoot: state, planOrigins: [], gh, planPrPreflight: () => GREEN,
    mintTaskId: () => { throw new Error("no draft is minted here"); },
    renderShard: () => { throw new Error("no draft is rendered here"); },
    recordVerdict: () => ({ ok: true, reason: "" }),
  });
  return {
    clone: clone.dir, state, ghCalls, deps,
    queued: () => (existsSync(pendingDir) ? readdirSync(pendingDir).sort() : []),
    cleanup: () => { for (const dir of [origin.dir, seed.dir, clone.dir, state]) rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A `git` on PATH that logs `start|end <ms> <argv>` around a 0.3 s sleep and the real git. */
function sleepingGit() {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = makeTempDir("w9755-sleeping-git");
  const log = join(dir, "children.log");
  writeFileSync(join(dir, "git"), [
    "#!/bin/sh",
    `echo "start $(date +%s%3N) $*" >> '${log}'`,
    "sleep 0.3",
    `'${real}' "$@"`,
    "rc=$?",
    `echo "end $(date +%s%3N) $*" >> '${log}'`,
    "exit $rc",
  ].join("\n") + "\n", { mode: 0o755 });
  const saved = process.env.PATH;
  return {
    install: () => { process.env.PATH = `${dir}:${saved}`; },
    restore: () => { process.env.PATH = saved; },
    /** Each child, paired start to end in log order. */
    children: (): Array<{ argv: string; start: number; end: number }> => {
      const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      const open: Array<{ argv: string; start: number }> = [];
      const done: Array<{ argv: string; start: number; end: number }> = [];
      for (const line of lines) {
        const [phase, at, ...argv] = line.split(" ");
        if (phase === "start") open.push({ argv: argv.join(" "), start: Number(at) });
        else {
          const index = open.findIndex((child) => child.argv === argv.join(" "));
          if (index >= 0) done.push({ ...open.splice(index, 1)[0]!, end: Number(at) });
        }
      }
      return done;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Run `land` with the sleeping git installed and a 20 ms interval logging wall-clock ticks beside it. */
async function beside<T>(git: ReturnType<typeof sleepingGit>, land: () => Promise<T>): Promise<{ result: T; ticks: number[] }> {
  const ticks: number[] = [];
  const timer = setInterval(() => ticks.push(Date.now()), 20);
  git.install();
  try {
    return { result: await withLiveWritesAllowed(land), ticks };
  } finally {
    git.restore();
    clearInterval(timer);
  }
}

/** The children no timer tick fell inside: each held the loop for its whole window. */
const blocking = (children: ReturnType<ReturnType<typeof sleepingGit>["children"]>, ticks: number[]) =>
  children.filter((child) => !ticks.some((tick) => tick > child.start + 50 && tick < child.end)).map((child) => child.argv);

test("W1-T9755: a content landing reads its identity without blocking a timer", async () => {
  const f = fixture("identity", {}, {});
  const git = sleepingGit();
  try {
    const { result, ticks } = await beside(git, () => landCiLearningShardsAsync([], f.clone, f.deps()));
    assert.deepEqual(result, { filed: [], skipped: [], refused: [] });
    const children = git.children();
    const identity = children.filter((child) => child.argv.includes("config --get remote.origin.url"));
    assert.equal(identity.length, 2, `positive control: the target and the source identity reads ran: ${JSON.stringify(children)}`);
    assert.deepEqual(blocking(children, ticks), [], "every git child of the landing let the timer turn");
  } finally {
    git.cleanup();
    f.cleanup();
  }
});

test("W1-T9755: acknowledging queued shards never blocks a timer and removes only merged ones", async () => {
  const f = fixture("ack", ON_MAIN, QUEUED);
  const git = sleepingGit();
  try {
    const { ticks } = await beside(git, () => landCiLearningShardsAsync([], f.clone, f.deps()));
    assert.deepEqual(f.queued(), ["W1-T2-changed.yaml", "W1-T3-new.yaml"], "only the shards main holds, by bytes or by finding, are removed");
    const children = git.children();
    // The queue's byte check hashes files in the state root: one child per acknowledgement pass (before and after the
    // landing) over every shard main lists, where it was one child per shard.
    const hashes = children.filter((child) => child.argv.includes("hash-object") && child.argv.includes(PENDING));
    assert.equal(hashes.length, 2, `one hash-object per acknowledgement pass: ${JSON.stringify(children)}`);
    assert.ok(hashes[0]!.argv.includes("W1-T1-merged.yaml") && hashes[0]!.argv.includes("W1-T2-changed.yaml"), JSON.stringify(hashes));
    assert.equal(children.filter((child) => / ls-tree -z origin\/main -- /.test(child.argv)).length, 2, "one ls-tree per acknowledgement pass");
    assert.deepEqual(blocking(children, ticks), [], "every git child of the landing let the timer turn");
  } finally {
    git.cleanup();
    f.cleanup();
  }
});

test("W1-T9755: the sync and async drivers acknowledge the same shards", async () => {
  const sync = fixture("same-sync", ON_MAIN, QUEUED);
  const awaited = fixture("same-async", ON_MAIN, QUEUED);
  try {
    const r1 = withLiveWritesAllowed(() => landCiLearningShards([], sync.clone, sync.deps()));
    const r2 = await withLiveWritesAllowed(() => landCiLearningShardsAsync([], awaited.clone, awaited.deps()));
    assert.deepEqual(r2, r1);
    assert.deepEqual(awaited.queued(), sync.queued());
    assert.deepEqual(sync.queued(), ["W1-T2-changed.yaml", "W1-T3-new.yaml"]);
  } finally {
    sync.cleanup();
    awaited.cleanup();
  }
});

test("W1-T9755: a queue main holds none of keeps every shard, and an unreadable main keeps them all", async () => {
  const f = fixture("none", { "W1-T4-by-origin.yaml": ON_MAIN["W1-T4-by-origin.yaml"] }, { "W1-T3-new.yaml": shard("W1-T3") });
  try {
    await withLiveWritesAllowed(() => landCiLearningShardsAsync([], f.clone, f.deps()));
    assert.deepEqual(f.queued(), ["W1-T3-new.yaml"], "a path main lacks keeps its shard");
    const refusing = { ...f.deps(), gitAsync: async (args: string[]) => {
      if (args[0] === "ls-tree") throw new Error("origin/main unreadable");
      return execFileSync("git", ["-C", f.clone, ...args], { encoding: "utf8" });
    } };
    await withLiveWritesAllowed(() => landCiLearningShardsAsync([], f.clone, refusing));
    assert.deepEqual(f.queued(), ["W1-T3-new.yaml"], "a failed read keeps the queue");
  } finally {
    f.cleanup();
  }
});

test("W1-T9755: a plan-reconcile landing reads its identity without blocking a timer", async () => {
  const f = fixture("reconcile", {}, {});
  const git = sleepingGit();
  try {
    const { result, ticks } = await beside(git, () => landPlanReconcileShardsAsync(f.clone, [{ relPath: `${SHARDS}/W1-T4-r.yaml`, content: shard("W1-T4") }], {
      gh: (args: string[]) => (args[1] === "create" ? `${PR_URL}\n` : "[]"), planPrPreflight: async () => GREEN,
    }));
    assert.equal(result.landed, true, JSON.stringify(result));
    const children = git.children();
    assert.equal(children.filter((child) => child.argv.includes("config --get remote.origin.url")).length, 2, JSON.stringify(children));
    assert.deepEqual(blocking(children, ticks), [], "every git child of the landing let the timer turn");
  } finally {
    git.cleanup();
    f.cleanup();
  }
});
