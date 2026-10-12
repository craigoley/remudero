import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// Namespace imports: this file must LOAD on a base without the awaited symbols, so each proof
// fails there on its own assertion rather than on a missing export.
import * as triageLib from "../src/lib/auto-triage.js";
import * as claimLib from "../src/lib/dispatch-claim.js";
import * as runTaskMod from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
const { claimTriage, gitTriageClaimReserver, newFeedbackIdsOldestFirst, triageClaimRef } = triageLib;
const { triageClaimReserverFor } = runTaskMod;
const gitTriageClaimReserverAsync: typeof triageLib.gitTriageClaimReserverAsync = (...a) => triageLib.gitTriageClaimReserverAsync(...a);
const triageClaimReserverAsyncFor: typeof runTaskMod.triageClaimReserverAsyncFor = (...a) => runTaskMod.triageClaimReserverAsyncFor(...a);
const gitClaimRunnerAsync: typeof claimLib.gitClaimRunnerAsync = (...a) => claimLib.gitClaimRunnerAsync(...a);
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

// MEASURED 2026-10-06: the triage claim reserver ran `spawnSync` git inside the daemon process —
// ~543 s of synchronous spawn per 17 h of daemon.loop_lag (the lane's claim and release, and the
// auto-triage pass's claim sweep). These tests pin the awaited replacement: the loop keeps running,
// a bound fails closed and says so, and the awaited reserver reads a real origin as the sync one does.

/** A shell script standing in for `git`: `body` runs, then (when `exec`) the real git with the args. */
function fakeGit(body: string, exec = false): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-triage-fake-bin-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "git");
  writeFileSync(bin, `#!/bin/sh\n${body}\n${exec ? `exec ${realGit} "$@"\n` : ""}`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

/** A real local bare origin and a working clone of it, with a local identity (CI runners have none). */
function originAndWork(): { origin: GitRepo; work: GitRepo; cleanup(): void } {
  const origin = gitRepo({ bare: true, kind: "triage-origin" });
  const work = gitRepo({ kind: "triage-work" });
  work.git("config", "user.name", "remudero-test-work");
  work.git("config", "user.email", "work@remudero.invalid");
  work.addRemote("origin", origin.dir);
  work.git("push", "--quiet", "origin", "main");
  return { origin, work, cleanup: () => (origin.cleanup(), work.cleanup()) };
}

/** Counts interval ticks while `pending` settles — a loop held by a sync spawn counts zero. */
async function ticksWhile<T>(pending: () => Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 20);
  try {
    const value = await pending();
    return { value, ticks };
  } finally {
    clearInterval(timer);
  }
}

/** Runs `fn` with a git on PATH that sleeps `seconds` before running the real one. */
async function withSlowGit<T>(seconds: number, fn: () => Promise<T>): Promise<T> {
  const slow = fakeGit(`sleep ${seconds}`, true);
  const savedPath = process.env.PATH;
  process.env.PATH = `${slow.dir}:${savedPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = savedPath;
    rmSync(slow.dir, { recursive: true, force: true });
  }
}

test("the awaited triage claim keeps a timer firing while its git push is pending", async () => {
  const f = originAndWork();
  try {
    // The PRODUCTION factory the triage lane takes its claim through, with a git that takes 300 ms.
    const reserver = triageClaimReserverAsyncFor(f.work.dir);
    const { value, ticks } = await withSlowGit(0.3, () => ticksWhile(() => claimTriage("fb-tick", reserver)));
    assert.equal(value.proceed, true, value.reason);
    assert.match(value.anchor ?? "", /^[0-9a-f]{40}$/);
    assert.ok(ticks >= 5, `the loop must keep servicing timers during the claim's git calls (ticked ${ticks})`);
    assert.equal(f.origin.git("rev-parse", triageClaimRef("fb-tick")).trim(), value.anchor);
  } finally {
    f.cleanup();
  }
});

test("a triage claim push killed at its bound reads unreachable and the refusal names the timeout", async () => {
  const hung = fakeGit("echo 'connecting to origin' >&2\nexec sleep 5");
  try {
    const reserver = gitTriageClaimReserverAsync({
      run: gitClaimRunnerAsync("/nonexistent-dir", { timeoutMs: 150, graceMs: 50, gitBin: hung.bin }),
      anchor: () => "a".repeat(40),
    });
    const claim = await claimTriage("fb-hung", reserver);
    assert.equal(claim.proceed, false, "a push that never answered must fail closed, never proceed");
    assert.equal(claim.anchor, undefined, "and hold nothing it could later release");
    assert.match(reserver.lastAttemptStderr?.() ?? "", /git push timed out after 150ms and was killed\. git said: connecting to origin/);
    assert.match(claim.reason, /cannot reach origin/, "the timeout reads unreachable, never taken");
    assert.match(claim.reason, /git said: git push timed out after 150ms/, "the refusal names the bound, not only the category");
  } finally {
    rmSync(hung.dir, { recursive: true, force: true });
  }
});

test("the awaited and sync triage reservers read the same real origin identically", async () => {
  const f = originAndWork();
  try {
    const sync = triageClaimReserverFor(f.work.dir);
    const awaited = triageClaimReserverAsyncFor(f.work.dir);
    const anchor = await awaited.mintAnchor();
    assert.match(anchor, /^[0-9a-f]{40}$/);
    assert.notEqual(anchor, await awaited.mintAnchor(), "two awaited anchors differ");

    assert.equal(await awaited.attempt("fb-same", anchor), "created");
    assert.equal(awaited.lastAttemptStderr?.(), undefined);
    assert.equal(sync.attempt("fb-same", sync.mintAnchor()), "taken");
    assert.equal(await awaited.attempt("fb-same", await awaited.mintAnchor()), "taken");
    assert.match(awaited.lastAttemptStderr?.() ?? "", /rejected|already exists/);

    assert.equal(await awaited.holder("fb-same"), anchor);
    assert.equal(await awaited.holder("fb-same"), sync.holder("fb-same"));
    assert.equal(await awaited.holderMessage?.("fb-same"), sync.holderMessage?.("fb-same"));
    assert.ok(triageLib.parseTriageClaimAnchorMessage((await awaited.holderMessage?.("fb-same")) ?? ""), "the message names its holder");
    assert.deepEqual(await awaited.claimedIds?.(), sync.claimedIds?.());
    assert.deepEqual([...((await awaited.claimedIds?.()) ?? [])], [["fb-same", anchor]]);

    assert.equal(await awaited.drop("fb-same", { expect: "0".repeat(40) }), false, "a wrong lease does not delete");
    assert.equal(sync.holder("fb-same"), anchor);
    assert.equal(await awaited.drop("fb-same", { expect: anchor }), true);
    assert.equal(await awaited.holder("fb-same"), undefined);
    assert.equal(sync.holder("fb-same"), undefined);
    assert.equal(await awaited.holderMessage?.("fb-same"), undefined, "no claim, no message");

    assert.equal(await awaited.attempt("fb-other", await awaited.mintAnchor()), "created");
    assert.equal(await awaited.drop("fb-other"), true, "an unconditional drop deletes too");
  } finally {
    f.cleanup();
  }
});

test("the awaited and sync triage reservers both read an unreachable origin as unreachable", async () => {
  const work = gitRepo({ kind: "triage-noremote" });
  try {
    work.git("config", "user.name", "remudero-test-work");
    work.git("config", "user.email", "work@remudero.invalid");
    work.addRemote("origin", join(work.dir, "does-not-exist.git"));
    const sync = triageClaimReserverFor(work.dir);
    const awaited = triageClaimReserverAsyncFor(work.dir);
    assert.equal(await awaited.attempt("fb-gone", "0".repeat(40)), sync.attempt("fb-gone", "0".repeat(40)));
    assert.equal(await awaited.attempt("fb-gone", "0".repeat(40)), "unreachable");
    assert.equal(await awaited.holder("fb-gone"), undefined);
    assert.equal(await awaited.claimedIds?.(), undefined, "an unreadable namespace is undefined, never an empty map");
    assert.equal(sync.claimedIds?.(), undefined);
    assert.equal(await awaited.drop("fb-gone"), false);
  } finally {
    work.cleanup();
  }
});

test("a failed triage anchor mint is refused as unreachable, names the failure, and pushes nothing", async () => {
  for (const failAt of ["hash-object", "commit-tree"]) {
    const calls: string[] = [];
    const run = (args: string[]) => {
      calls.push(args[0]);
      return args[0] === failAt
        ? { status: 128, stdout: "", stderr: `fatal: ${failAt} said no` }
        : { status: 0, stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n", stderr: "" };
    };
    // An empty anchor pushed as `:<ref>` would DELETE the ref — someone else's claim included.
    for (const reserver of [gitTriageClaimReserverAsync({ run: async (a) => run(a) }), gitTriageClaimReserver({ run })]) {
      calls.length = 0;
      const claim = await claimTriage("fb-mint", reserver);
      assert.equal(claim.proceed, false);
      assert.equal(claim.anchor, undefined);
      assert.match(claim.reason, new RegExp(`cannot reach origin.*git said: minting the claim anchor failed: fatal: ${failAt} said no`));
      assert.ok(!calls.includes("push"), `no push after a failed ${failAt} (${calls.join(",")})`);
    }
  }
  const blank = await claimTriage("fb-mint", { mintAnchor: () => "", attempt: () => "created", holder: () => undefined, drop: () => true });
  assert.equal(blank.proceed, false);
  assert.match(blank.reason, /the claim anchor came back empty/);
});

test("the auto-triage pass sweeps the claim namespace through awaited git, keeping a timer firing", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = newFeedbackIdsOldestFirst(repoRoot);
  assert.ok(candidates.length >= 2, `this proof needs two status:new feedback entries in the checkout (${candidates.length})`);
  const [head] = candidates;
  const root = mkdtempSync(join(tmpdir(), "rmd-triage-sweep-root-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "repos"), { recursive: true });
  // The sweep's production default: `<root>/repos/<repo>`, a clone whose origin holds the claims.
  const f = originAndWork();
  symlinkSync(f.work.dir, join(root, "repos", "sweep-repo"));
  try {
    // A LIVE claim on the head (claimed now, so it is inside the liveness window): the pass must skip it.
    const tree = f.work.git("hash-object", "-t", "tree", "/dev/null").trim();
    const held = f.work.git("commit-tree", tree, "-m", `rmd-triage claim 7@elsewhere ${new Date().toISOString()}`).trim();
    f.work.git("push", "--quiet", "origin", `${held}:${triageClaimRef(head)}`);
    const { loadPolicy, policyPath } = await import("../src/lib/policy.js");
    const shipped = loadPolicy(policyPath(repoRoot));
    const policy = { ...shipped, values: { ...shipped.values, autoTriage: { enabled: true, minIntervalMinutes: 1, maxPerDay: 50 } } };
    const config = { root, claudeBin: "/bin/true" } as unknown as Config;
    const { value, ticks } = await withSlowGit(0.3, () =>
      ticksWhile(async () =>
        runTaskMod.autoTriageCheck({
          config,
          policy,
          ratifications: new Map(),
          now: new Date(),
          deferralPending: true,
          dispatchCount: 1,
          laneBudget: 1,
          resolveClaimRepo: () => ({ repo: "sweep-repo" }),
          readClaimLivenessRows: () => [],
          readRefusalRows: () => [],
        }),
      ),
    );
    assert.equal(value.fire, true, value.reason);
    assert.notEqual(value.fire && value.feedbackId, head, "the live-held head is passed over: the sweep read the real origin");
    assert.ok(ticks >= 3, `the loop must keep servicing timers during the sweep's git calls (ticked ${ticks})`);
    assert.equal(f.origin.git("rev-parse", triageClaimRef(head)).trim(), held, "a live claim is never dropped");
  } finally {
    f.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
