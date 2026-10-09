// test/the-per-poll-feedback-landing-runs-git-off-the-loop.test.ts — W1-T5672.
//
// W1-T5620 moved the per-poll landing's plan-PR preflight off the daemon loop, but `sweepLandingSteps` still
// drove `defaultGit` (execFileSync): every poll paid a synchronous `git fetch origin` even with nothing to land,
// plus a synchronous ls-remote, push and `gh` PR calls when something was. `sweepFeedbackLandingAsync` now hands
// the network verbs to an awaited seam (`gitAsync` / `ghAsync`), and no verb leaves the machine when nothing is
// pending. The sync boot and CLI forms keep running everything on the thread.
//
// THE OBSERVATION is event-loop turns, never a wall-clock bound: a timer set before the sweep records its place in
// the ordered event log among the awaited fetch's start and end.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { LANDING_BRANCH, sweepFeedbackLanding, sweepFeedbackLandingAsync } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "../src/lib/plan-pr-emitter.js";
import { gitRepo } from "./helpers/git-repo.js";

const execFileAsync = promisify(execFile);
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const NETWORK_VERBS = new Set(["fetch", "ls-remote", "push"]);
const PR_URL = "https://github.com/o/r/pull/5672";

/** A bare origin and a clone of it, the clone holding `pending` uncaptured feedback records. */
function fixture(nonce: string, pending: number) {
  const seed = gitRepo({ kind: `w5672-${nonce}-seed` });
  const origin = gitRepo({ bare: true, kind: `w5672-${nonce}-origin` });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: `w5672-${nonce}-clone` });
  mkdirSync(join(clone.dir, "plan", "feedback"), { recursive: true });
  for (let i = 0; i < pending; i++) {
    writeFileSync(join(clone.dir, "plan", "feedback", `fb-${i}.yaml`), `id: fb-${i}\nstatus: new\nraw: ${nonce}\n`);
  }

  const events: string[] = [];
  const ghCalls: string[][] = [];
  const gh = (args: string[]): string => {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return `${PR_URL}\n`;
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  /** The sync seam, recording every verb it runs; the real git underneath. */
  const git = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    events.push(`sync:${args[0]}`);
    return execFileSyncGit(clone.dir, args, opts?.env);
  };
  /** The awaited seam: each network verb is held `holdMs` in flight, so a timer can only fire inside it by a loop turn. */
  const gitAsync = (holdMs: number) => async (args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<string> => {
    events.push(`async:${args[0]}:start`);
    if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
    const out = (await execFileAsync("git", ["-C", clone.dir, ...args], { encoding: "utf8", env: opts?.env ?? process.env })).stdout;
    events.push(`async:${args[0]}:end`);
    return out;
  };
  const heads = () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
  const landed = () =>
    heads().includes(LANDING_BRANCH) ? origin.git("ls-tree", "-r", "--name-only", `refs/heads/${LANDING_BRANCH}`).split("\n").filter((p) => p.startsWith("plan/feedback/")) : [];
  return { clone, origin, events, ghCalls, gh, git, gitAsync, heads, landed };
}

function execFileSyncGit(dir: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
}

test("a per-poll landing lets a timer fire while its git fetch is in flight, returns the same result as the sync sweep, and fetches nothing when nothing is pending", async (t) => {
  await t.test("a timer set before the sweep fires between the awaited fetch's start and end", async () => {
    const f = fixture("timer", 1);
    const order = f.events;
    const timer = setTimeout(() => order.push("timer"), 20);
    try {
      const result = await withLiveWritesAllowed(() =>
        sweepFeedbackLandingAsync(f.clone.dir, { gh: f.gh, gitAsync: f.gitAsync(120), planPrPreflight: async () => GREEN }),
      );
      assert.equal(result.landed, true, JSON.stringify(result));
      assert.equal(result.pushed, true);
    } finally {
      clearTimeout(timer);
    }

    const fetchStart = order.indexOf("async:fetch:start");
    const fetchEnd = order.indexOf("async:fetch:end");
    const tick = order.indexOf("timer");
    assert.ok(fetchStart >= 0 && fetchEnd > fetchStart, `the fetch ran through the awaited seam: ${JSON.stringify(order)}`);
    assert.ok(tick > fetchStart && tick < fetchEnd, `the timer fired while the fetch was in flight: ${JSON.stringify(order)}`);
  });

  await t.test("the network verbs run through the awaited seam; the sync seam carries none of them", async () => {
    const f = fixture("verbs", 1);
    const result = await withLiveWritesAllowed(() =>
      sweepFeedbackLandingAsync(f.clone.dir, { git: f.git, gh: f.gh, gitAsync: f.gitAsync(0), planPrPreflight: async () => GREEN }),
    );
    assert.equal(result.landed, true, JSON.stringify(result));

    const syncVerbs = f.events.filter((e) => e.startsWith("sync:")).map((e) => e.slice("sync:".length));
    assert.deepEqual(syncVerbs.filter((v) => NETWORK_VERBS.has(v)), [], "no fetch, ls-remote or push ran on the thread");
    const asyncVerbs = f.events.filter((e) => e.endsWith(":start")).map((e) => e.split(":")[1]);
    assert.ok(asyncVerbs.includes("fetch") && asyncVerbs.includes("ls-remote") && asyncVerbs.includes("push"), JSON.stringify(asyncVerbs));
  });

  await t.test("the awaited sweep returns the same result and lands the same tree as the sync sweep", async () => {
    const sync = fixture("same-sync", 2);
    const awaited = fixture("same-async", 2);

    const r1 = withLiveWritesAllowed(() => sweepFeedbackLanding(sync.clone.dir, { gh: sync.gh, planPrPreflight: () => GREEN }));
    const r2 = await withLiveWritesAllowed(() =>
      sweepFeedbackLandingAsync(awaited.clone.dir, { gh: awaited.gh, gitAsync: awaited.gitAsync(0), planPrPreflight: async () => GREEN }),
    );

    assert.equal(r1.landed, true, JSON.stringify(r1));
    assert.deepEqual(r2, r1, "the same LandFeedbackResult");
    assert.deepEqual(r1.files, ["plan/feedback/fb-0.yaml", "plan/feedback/fb-1.yaml"]);
    assert.equal(r1.prUrl, PR_URL);
    assert.deepEqual(awaited.landed(), sync.landed(), "the same records on the landing branch");
    assert.deepEqual(awaited.ghCalls.map((c) => c.slice(0, 2)), sync.ghCalls.map((c) => c.slice(0, 2)), "the same PR calls");
  });

  await t.test("a rejected awaited fetch surfaces as the sweep's error, with nothing pushed and no PR call", async () => {
    const f = fixture("fails", 1);
    const refuse = async (args: string[]): Promise<string> => {
      throw new Error(`refused ${args[0]}`);
    };
    const result = await withLiveWritesAllowed(() =>
      sweepFeedbackLandingAsync(f.clone.dir, { gh: f.gh, gitAsync: refuse, planPrPreflight: async () => GREEN }),
    );
    assert.equal(result.landed, false);
    assert.equal(result.error, "refused fetch");
    assert.deepEqual(f.heads(), ["main"], "nothing was pushed");
    assert.equal(f.ghCalls.length, 0);
  });

  await t.test("nothing is fetched, listed or pushed when nothing is pending", async () => {
    const f = fixture("idle", 0);
    const result = await withLiveWritesAllowed(() =>
      sweepFeedbackLandingAsync(f.clone.dir, { git: f.git, gh: f.gh, gitAsync: f.gitAsync(0), planPrPreflight: async () => GREEN }),
    );

    assert.deepEqual(result, { landed: false, files: [] });
    const verbs = f.events.map((e) => e.split(":")[1] as string);
    assert.deepEqual(verbs.filter((v) => NETWORK_VERBS.has(v)), [], `no network verb: ${JSON.stringify(f.events)}`);
    assert.equal(f.events.filter((e) => e.startsWith("async:")).length, 0, "the awaited seam was never asked");
    assert.equal(f.ghCalls.length, 0, "no PR call");
  });
});
