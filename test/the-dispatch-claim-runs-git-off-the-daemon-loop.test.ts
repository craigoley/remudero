import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decideDispatchClaim,
  dispatchClaimRef,
  gitClaimRunnerAsync,
  gitDispatchClaimReserver,
  gitDispatchClaimReserverAsync,
  releaseDispatchClaim,
  releaseDispatchClaimAsync,
  type DispatchClaimReserverAsync,
} from "../src/lib/dispatch-claim.js";
import { assertClaimRefPushAllowedAsync, LiveWriteBlockedError, withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { dispatchClaimReserverAsyncFor, dispatchClaimReserverFor } from "../src/run-task.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

// MEASURED 2026-10-06: runTask's dispatch claim ran `spawnSync` git inside the daemon process —
// 89 daemon.loop_lag rows over 17 h, 1,506 s of spawn time, single pushes/ls-remotes up to 106 s.
// These tests pin the awaited replacement: the loop keeps running, a bound fails closed and says so,
// and the awaited reserver reads a real origin exactly as the sync one does.

/** A shell script standing in for `git`: `body` runs, then (when `exec`) the real git with the args. */
function fakeGit(body: string, exec = false): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-claim-fake-bin-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "git");
  writeFileSync(bin, `#!/bin/sh\n${body}\n${exec ? `exec ${realGit} "$@"\n` : ""}`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

/** A real local bare origin and a working clone of it, with a local identity (CI runners have none). */
function originAndWork(): { origin: GitRepo; work: GitRepo; cleanup(): void } {
  const origin = gitRepo({ bare: true, kind: "claim-origin" });
  const work = gitRepo({ kind: "claim-work" });
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

test("the awaited dispatch claim keeps a timer firing while its git push is pending", async () => {
  const f = originAndWork();
  // The PRODUCTION factory runTask takes its claim through, with a git on PATH that takes 400 ms.
  const slow = fakeGit("sleep 0.4", true);
  const savedPath = process.env.PATH;
  try {
    const reserver = dispatchClaimReserverAsyncFor(f.work.dir);
    process.env.PATH = `${slow.dir}:${savedPath}`;
    const { value, ticks } = await ticksWhile(async () => reserver.attempt("W1-T9001", await reserver.mintAnchor()));
    assert.equal(value, "created");
    assert.ok(ticks >= 5, `the loop must keep servicing timers during the claim's git calls (ticked ${ticks})`);
  } finally {
    process.env.PATH = savedPath;
    rmSync(slow.dir, { recursive: true, force: true });
    f.cleanup();
  }
});

test("a dispatch claim push killed at its bound reads unreachable and the refusal names the timeout", async () => {
  const hung = fakeGit("echo 'connecting to origin' >&2\nexec sleep 5");
  try {
    const reserver = gitDispatchClaimReserverAsync({ run: gitClaimRunnerAsync("/nonexistent-dir", { timeoutMs: 150, graceMs: 50, gitBin: hung.bin }) });
    const outcome = await reserver.attempt("W1-T9002", "a".repeat(40));
    assert.equal(outcome, "unreachable", "a push that never answered must fail closed, never read as created or taken");
    const stderr = reserver.lastAttemptStderr?.();
    assert.match(stderr ?? "", /git push timed out after 150ms and was killed\. git said: connecting to origin/);
    const decision = decideDispatchClaim(outcome, { taskId: "W1-T9002", stderr });
    assert.equal(decision.proceed, false);
    assert.match(decision.reason, /timed out after 150ms/, "the refusal names the bound, not only the category");
  } finally {
    rmSync(hung.dir, { recursive: true, force: true });
  }
});

test("a dispatch claim git call killed at its bound with no stderr still names the timeout", async () => {
  const hung = fakeGit("exec sleep 5");
  try {
    const res = await gitClaimRunnerAsync("/nonexistent-dir", { timeoutMs: 100, graceMs: 50, gitBin: hung.bin })(["ls-remote", "origin"]);
    assert.deepEqual(res, { status: 1, stdout: "", stderr: "git ls-remote timed out after 100ms and was killed." });
  } finally {
    rmSync(hung.dir, { recursive: true, force: true });
  }
});

test("the awaited and sync dispatch reservers read the same real origin identically", async () => {
  const f = originAndWork();
  try {
    const sync = dispatchClaimReserverFor(f.work.dir);
    const awaited = dispatchClaimReserverAsyncFor(f.work.dir);
    const anchor = await awaited.mintAnchor();
    assert.match(anchor, /^[0-9a-f]{40}$/);
    assert.notEqual(anchor, await awaited.mintAnchor(), "two awaited anchors differ");

    assert.equal(await awaited.attempt("W1-T9003", anchor), "created");
    assert.equal(awaited.lastAttemptStderr?.(), undefined);
    assert.equal(sync.attempt("W1-T9003", sync.mintAnchor()), "taken");
    assert.equal(await awaited.attempt("W1-T9003", await awaited.mintAnchor()), "taken");
    assert.match(awaited.lastAttemptStderr?.() ?? "", /rejected|already exists/);

    assert.equal(await awaited.holder("W1-T9003"), anchor);
    assert.equal(await awaited.holder("W1-T9003"), sync.holder("W1-T9003"));
    assert.equal(await awaited.anchorMessage?.("W1-T9003"), sync.anchorMessage?.("W1-T9003"));
    assert.match((await awaited.anchorMessage?.("W1-T9003")) ?? "", /^rmd-dispatch claim \d+@\S+ \S+$/);
    assert.deepEqual(await awaited.list?.(), sync.list?.());
    assert.deepEqual(await awaited.list?.(), ["W1-T9003"]);

    assert.equal(await awaited.drop("W1-T9003", { expect: "0".repeat(40) }), false, "a wrong lease does not delete");
    assert.equal(sync.holder("W1-T9003"), anchor);
    assert.equal(await awaited.drop("W1-T9003", { expect: anchor }), true);
    assert.equal(await awaited.holder("W1-T9003"), undefined);
    assert.equal(sync.holder("W1-T9003"), undefined);
    assert.equal(await awaited.anchorMessage?.("W1-T9003"), undefined, "no holder, no message");

    assert.equal(await awaited.attempt("W1-T9004", await awaited.mintAnchor()), "created");
    assert.equal(await awaited.drop("W1-T9004"), true, "an unconditional drop deletes too");
  } finally {
    f.cleanup();
  }
});

test("the awaited and sync dispatch reservers both read an unreachable origin as unreachable", async () => {
  const work = gitRepo({ kind: "claim-noremote" });
  try {
    work.git("config", "user.name", "remudero-test-work");
    work.git("config", "user.email", "work@remudero.invalid");
    work.addRemote("origin", join(work.dir, "does-not-exist.git"));
    const sync = dispatchClaimReserverFor(work.dir);
    const awaited = dispatchClaimReserverAsyncFor(work.dir);
    assert.equal(await awaited.attempt("W1-T9005", "0".repeat(40)), sync.attempt("W1-T9005", "0".repeat(40)));
    assert.equal(await awaited.attempt("W1-T9005", "0".repeat(40)), "unreachable");
    assert.equal(await awaited.holder("W1-T9005"), undefined);
    assert.deepEqual(await awaited.list?.(), []);
    assert.equal(await awaited.drop("W1-T9005"), false);
  } finally {
    work.cleanup();
  }
});

test("the awaited claim runner really shells out and passes the git exit status through", async () => {
  const f = originAndWork();
  try {
    const run = gitClaimRunnerAsync(f.work.dir);
    const ok = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.deepEqual(ok, { status: 0, stdout: "main\n", stderr: "" });
    const bad = await run(["rev-parse", "--verify", "--quiet", "no-such-ref"]);
    assert.equal(bad.status, 1, "git exit 1 rides through as status 1");
    const fatal = await run(["cat-file", "-p", "not-an-object"]);
    assert.equal(fatal.status, 128, "a fatal git exit keeps its own status");
    assert.match(fatal.stderr, /not-an-object/);
  } finally {
    f.cleanup();
  }
});

test("a claim git that cannot start reads as a failure carrying the spawn error", async () => {
  const res = await gitClaimRunnerAsync("/nonexistent-dir", { gitBin: "/nonexistent-dir/git" })(["ls-remote", "origin"]);
  assert.equal(res.status, 1, "a git that never ran is a failure, never a success");
  assert.match(res.stderr, /ENOENT/);
  const reserver = gitDispatchClaimReserverAsync({ run: gitClaimRunnerAsync("/nonexistent-dir", { gitBin: "/nonexistent-dir/git" }) });
  assert.equal(await reserver.attempt("W1-T9006", "a".repeat(40)), "unreachable");
});

/** An awaited scripted reserver: every method resolves on a later tick, every call recorded. */
function awaitedScripted(over: { holder?: string; message?: string; dropped?: boolean } = {}): DispatchClaimReserverAsync & { calls: string[] } {
  const calls: string[] = [];
  const later = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 1));
  return {
    calls,
    mintAnchor: () => later("anchor"),
    attempt: () => later("created"),
    holder: (id) => (calls.push(`holder:${id}`), later(over.holder)),
    drop: (id, o) => (calls.push(`drop:${id}:${o?.expect ?? "-"}`), later(over.dropped ?? true)),
    anchorMessage: (id) => (calls.push(`message:${id}`), later(over.message)),
  };
}

const DEAD_MESSAGE = "rmd-dispatch claim 4242@this-host 2026-10-06T00:00:00.000Z";
const deadProbe = () => ({ localHost: "this-host", namespaceBootMs: Date.parse("2026-10-06T01:00:00.000Z"), namespaceBootIso: "2026-10-06T01:00:00.000Z", pidPresent: false });

test("the awaited dispatch claim release takes the same arm as the sync release on the same inputs", async () => {
  // holder arm: CAS'd on this run's own anchor
  const holderRun = awaitedScripted();
  const held = await releaseDispatchClaimAsync("W1-T9007", holderRun, { anchor: "mine" });
  assert.equal(held.arm, "holder");
  assert.equal(held.dropped, true);
  assert.deepEqual(holderRun.calls, ["drop:W1-T9007:mine"], "the holder arm reads nothing first");

  // evidence arm: unconditional drop, no anchor read
  const evidence = awaitedScripted();
  const landed = await releaseDispatchClaimAsync("W1-T9007", evidence, { evidenceObserved: true });
  assert.equal(landed.arm, "evidence");
  assert.deepEqual(evidence.calls, ["drop:W1-T9007:-"]);

  // dead-claimant arm: the probe receives the parsed anchor; the drop is leased to the judged sha
  const seen: number[] = [];
  const dead = awaitedScripted({ holder: "judged-sha", message: DEAD_MESSAGE });
  const reaped = await releaseDispatchClaimAsync("W1-T9007", dead, { livenessProbe: (a) => (seen.push(a.pid), deadProbe()) });
  assert.equal(reaped.arm, "dead-claimant");
  assert.equal(reaped.dropped, true);
  assert.deepEqual(seen, [4242], "the probe is handed the identity the release parsed");
  assert.deepEqual(dead.calls, ["message:W1-T9007", "holder:W1-T9007", "drop:W1-T9007:judged-sha"]);
  const syncDead = releaseDispatchClaim("W1-T9007", {
    mintAnchor: () => "a", attempt: () => "created", holder: () => "judged-sha", drop: () => true, anchorMessage: () => DEAD_MESSAGE,
  }, { livenessProbe: deadProbe });
  assert.equal(syncDead.arm, reaped.arm);
  assert.equal(syncDead.reason, reaped.reason);

  // dead-claimant whose ref vanished before the leased drop: nothing dropped
  const vanished = awaitedScripted({ message: DEAD_MESSAGE });
  const gone = await releaseDispatchClaimAsync("W1-T9007", vanished, { livenessProbe: deadProbe });
  assert.equal(gone.arm, "dead-claimant");
  assert.equal(gone.dropped, false);
  assert.ok(!vanished.calls.some((c) => c.startsWith("drop:")));

  // operator arm: an unparseable anchor never consults the probe and never drops
  const unread = awaitedScripted({ message: "not an anchor" });
  let probed = false;
  const left = await releaseDispatchClaimAsync("W1-T9007", unread, { livenessProbe: () => ((probed = true), deadProbe()) });
  assert.equal(left.arm, "operator");
  assert.equal(left.dropped, false);
  assert.equal(probed, false);
  const plain = await releaseDispatchClaimAsync("W1-T9007", awaitedScripted());
  assert.equal(plain.arm, releaseDispatchClaim("W1-T9007", gitDispatchClaimReserver({ run: () => ({ status: 1, stdout: "", stderr: "" }) })).arm);
});

test("the awaited claim push guard refuses a network origin under the test runner and spares a local one", async () => {
  const network = async () => ({ status: 0, stdout: "https://github.com/example/repo.git\n", stderr: "" });
  await assert.rejects(assertClaimRefPushAllowedAsync(network, dispatchClaimRef("W1-T9008")), LiveWriteBlockedError);
  await assertClaimRefPushAllowedAsync(async () => ({ status: 0, stdout: "/tmp/origin.git\n", stderr: "" }), dispatchClaimRef("W1-T9008"));
  let asked = false;
  await withLiveWritesAllowed(() => assertClaimRefPushAllowedAsync(async () => ((asked = true), { status: 0, stdout: "", stderr: "" }), "r"));
  assert.equal(asked, false, "inside an allowed scope the guard reads no git at all");
});
