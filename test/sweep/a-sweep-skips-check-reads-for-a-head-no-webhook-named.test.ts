// W1-T14809: a sweep re-reads a PR head's checks only when a webhook named that head or its sha moved,
// with one token-free ls-remote per sweep and today's REST reads when it fails.
//
// Each test drives the read plane's real open-PR read (`fetchOpenPrsWithPostedIdsAsync`, the walk and its
// W1-T12530 prefetch) through the head-read sweeper the producer builds (`createHeadReadSweeper`). The
// deliveries go through the real signed webhook route and the daemon-side acknowledge, so a head is
// re-read only by what a verified delivery journaled and an accepted sweep claimed.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Clock } from "#src/lib/clock.js";
import {
  acknowledgeChangedHeads,
  changedHeadShaOf,
  createDeliveryDedupStore,
  createGitHubEventWakeHandler,
  githubAcknowledgedHeadsPath,
  githubChangedHeadsPath,
  sweepWakeMarkerPath,
  peekChangedHeads,
  pruneAcknowledgedChangedHeads,
  wireSweepWakeToDaemon,
} from "#src/lib/github-event-wake.js";
import {
  createHeadReadGate,
  headReadCountsPath,
  recordHeadReadCounts,
  takeHeadReadCounts,
  type GhApiFetcher,
  type HeadReadGate,
} from "#src/lib/open-prs-rest.js";
import { DEFAULT_GITHUB_EVENT_WAKE_HEAD_RECHECK_MS, loadDefaultPolicy } from "#src/lib/policy.js";
import { createService } from "#src/lib/service.js";
import {
  buildOpenPrViewsAsync, createHeadReadSweeper, fetchOpenPrsWithPostedIdsAsync, headRecheckMsFromPolicy, holdsDrainLock, lsRemoteHeadShas,
  type HeadReadSweeper,
} from "#src/lib/tick-read-worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, originWithClone } from "#test/helpers/git-repo.js";

const SECRET = "w1-t14809-secret";
const REPOSITORY = "o/r";
const T0 = Date.parse("2026-11-26T12:00:00Z");
const MINUTE = 60_000;
const sha = (n: number) => n.toString(16).padStart(40, "a");
const PRS = Array.from({ length: 10 }, (_, i) => i + 1);

function clockAt(ms: number): Clock {
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
}

/** GitHub as ten open pull requests, each head with one completed check and one status; every read is counted. */
function openPrReads(lenient = false) {
  const calls: string[] = [];
  const pull = (n: number) => ({
    number: n, html_url: `https://github.com/o/r/pull/${n}`, state: "open", draft: false, title: `pr ${n}`,
    body: `Remudero-Task: W1-T${n}`, created_at: "2026-11-25T00:00:00Z", updated_at: "2026-11-25T00:00:00Z",
    head: { ref: `run-W1-T${n}-1`, sha: heads.get(n) ?? sha(n) },
  });
  const heads = new Map<number, string>();
  let conclusion = "success";
  const read: GhApiFetcher = async (args) => {
    const path = args[1] ?? "";
    calls.push(path);
    if (path.includes("/pulls?state=open")) return PRS.map(pull);
    if (path.endsWith("/check-runs?per_page=100")) {
      return { check_runs: [{ id: 1, name: "ci-gate", status: "completed", conclusion, started_at: "2026-11-25T00:00:00Z" }] };
    }
    if (path.endsWith("/status")) return { statuses: [{ context: "remudero-review", state: "success", created_at: "2026-11-25T00:00:00Z" }] };
    if (lenient) return [];
    throw new Error(`unexpected read ${path}`);
  };
  const headReads = () => calls.filter((path) => /\/commits\/[0-9a-f]{40}\/(check-runs|status)/.test(path));
  return {
    read, calls, headReads, fail: () => { conclusion = "failure"; }, reset: () => { calls.length = 0; },
    move: (n: number, to: string) => { heads.set(n, to); },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14809-`));
  mkdirSync(join(root, "state"), { recursive: true });
  return { root, stateDir: join(root, "state"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const allHeads = async () => new Set(PRS.map(sha));

async function sweep(sweeper: HeadReadSweeper, root: string, gh: ReturnType<typeof openPrReads>, atMs: number,
  lsRemoteHeads: (checkoutRoot: string) => Promise<ReadonlySet<string>> = allHeads, locked = true) {
  gh.reset();
  await sweeper.begin(root, root, sweepIo(atMs, lsRemoteHeads, locked));
  const prs = await fetchOpenPrsWithPostedIdsAsync("o", "r", gh.read, undefined, sweeper.gate);
  return { prs, headReads: gh.headReads(), counts: sweeper.gate.counts() };
}

/** The sweeper's seams at `atMs`; `locked` says whether this process holds the drain lock (a standby does not). */
function sweepIo(atMs: number, lsRemoteHeads: (checkoutRoot: string) => Promise<ReadonlySet<string>> = allHeads, locked = true) {
  return { lsRemoteHeads, clock: clockAt(atMs), recheckMs: DEFAULT_GITHUB_EVENT_WAKE_HEAD_RECHECK_MS, holdsDrainLock: () => locked };
}

/** POST one signed delivery to the real webhook route, owned by the daemon at `root`. */
async function deliver(root: string, event: string, body: Record<string, unknown>, deliveryId: string, atMs: number,
  options: Partial<Parameters<typeof createGitHubEventWakeHandler>[0]> = {}): Promise<number> {
  const route = createGitHubEventWakeHandler({
    ...options,
    secret: SECRET, repository: REPOSITORY, markerPath: sweepWakeMarkerPath(root),
    resolveMarkerPath: (repository) => (repository === REPOSITORY ? sweepWakeMarkerPath(root) : undefined),
    dedup: createDeliveryDedupStore(50), now: () => new Date(atMs), ...options,
  });
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const raw = JSON.stringify({ ...body, repository: { full_name: REPOSITORY } });
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-github-delivery": deliveryId, "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`,
      },
      body: raw,
    });
    await res.text();
    return res.status;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

/** The daemon's accepted pass: the same acknowledge that consumes SWEEP_WAKE_REQUESTED claims the changed heads. */
function acceptPass(root: string): void {
  const wiring = wireSweepWakeToDaemon(root, () => {}, (() => ({ on: () => {}, close: () => {} })) as never);
  try {
    wiring.acknowledge();
  } finally {
    wiring.close();
  }
}

test("W1-T14809: a sweep skips check reads for a head no webhook named", async () => {
  const f = fixture();
  try {
    const gh = openPrReads();
    const gate = createHeadReadSweeper();
    // A status for a commit that is no PR's head: the webhook is delivering, and it names none of the ten.
    assert.equal(await deliver(f.root, "status", { sha: sha(99), state: "success", context: "deploy" }, "d-live", T0), 202);
    acceptPass(f.root);

    const first = await sweep(gate, f.root, gh, T0);
    assert.equal(first.headReads.length, 20, "positive control: the first sweep reads every head's check-runs and status");
    assert.deepEqual(first.counts, { head_reads_made: 20, head_reads_skipped: 0 });

    // The falsifier: ten open PRs, nothing changed, one minute on. Today this makes at least 20 check reads.
    const second = await sweep(gate, f.root, gh, T0 + MINUTE);
    assert.deepEqual(second.headReads, [], `no check-runs or status read for an unmoved, unnamed head: ${second.headReads.join(", ")}`);
    assert.deepEqual(second.counts, { head_reads_made: 0, head_reads_skipped: 20 });
    assert.ok(gh.calls.some((path) => path.includes("/pulls?state=open")), "the open-PR list itself is still read");
    assert.deepEqual(second.prs.map((pr) => pr.statusCheckRollup), first.prs.map((pr) => pr.statusCheckRollup),
      "each head carries its kept rollup");

    // (a) a moved sha has no kept rollup, so only that head is read.
    gh.move(5, sha(500));
    const moved = await sweep(gate, f.root, gh, T0 + 2 * MINUTE, async () => new Set([...PRS.filter((n) => n !== 5).map(sha), sha(500)]));
    assert.deepEqual(moved.headReads.sort(), [`repos/o/r/commits/${sha(500)}/check-runs?per_page=100`, `repos/o/r/commits/${sha(500)}/status`]);
    assert.deepEqual(moved.counts, { head_reads_made: 2, head_reads_skipped: 18 }, "heads that did not move stay kept");

    // (c) the freshness floor: at headRecheckMs every head is read again, even with nothing named.
    const status = await deliver(f.root, "status", { sha: sha(98), state: "success", context: "deploy" }, "d-live-2", T0 + 9 * MINUTE);
    assert.equal(status, 202);
    acceptPass(f.root);
    const stale = await sweep(gate, f.root, gh, T0 + DEFAULT_GITHUB_EVENT_WAKE_HEAD_RECHECK_MS,
      async () => new Set([...PRS.filter((n) => n !== 5).map(sha), sha(500)]));
    assert.equal(stale.headReads.length, 18, "every read kept since T0 is as old as headRecheckMs and is re-read");
    assert.equal(stale.counts.head_reads_skipped, 2, "the head read at T0+2m is not yet that old");

    // The sweep's counts reach sweep.summary through the state file, summed until taken.
    recordHeadReadCounts(f.stateDir, first.counts);
    recordHeadReadCounts(f.stateDir, second.counts);
    assert.deepEqual(takeHeadReadCounts(f.stateDir), { head_reads_made: 20, head_reads_skipped: 20 });
    assert.equal(existsSync(headReadCountsPath(f.stateDir)), false, "taken counts are removed");
    assert.equal(takeHeadReadCounts(f.stateDir), undefined, "nothing kept, nothing reported");
    writeFileSync(headReadCountsPath(f.stateDir), "{}");
    assert.equal(takeHeadReadCounts(f.stateDir), undefined, "a file without counts reports none");
    // An ls-remote failure's reason survives a later guarded tick until sweep.summary takes it.
    recordHeadReadCounts(f.stateDir, { head_reads_made: 20, head_reads_skipped: 0, head_reads_unguarded: "ls-remote failed: offline" });
    recordHeadReadCounts(f.stateDir, second.counts);
    assert.deepEqual(takeHeadReadCounts(f.stateDir),
      { head_reads_made: 20, head_reads_skipped: 20, head_reads_unguarded: "ls-remote failed: offline" });
    writeFileSync(join(f.root, "blocker"), "a file, not a directory");
    recordHeadReadCounts(join(f.root, "blocker", "state"), first.counts);
    assert.equal(readFileSync(join(f.root, "blocker"), "utf8"), "a file, not a directory", "an unwritable state dir loses only these counts");
  } finally {
    f.cleanup();
  }
});

test("W1-T14809: a webhook naming a head re-reads its checks", async () => {
  const f = fixture();
  try {
    const gh = openPrReads();
    const gate = createHeadReadSweeper();
    assert.equal(await deliver(f.root, "status", { sha: sha(99), state: "success", context: "deploy" }, "d-live", T0), 202);
    acceptPass(f.root);
    await sweep(gate, f.root, gh, T0);

    // PR 3's ci-gate completes red; GitHub's check_run delivery names its head.
    gh.fail();
    const checkRun = { action: "completed", check_run: { id: 7, name: "ci-gate", conclusion: "failure", status: "completed", head_sha: sha(3) } };
    assert.equal(await deliver(f.root, "check_run", checkRun, "d-check", T0 + 30_000), 202);
    assert.deepEqual(readFileSync(githubChangedHeadsPath(f.root), "utf8").trim().split("\n").map((line) => JSON.parse(line).sha), [sha(3)],
      "the accepted delivery journaled the head it named");

    // Production order (daemon.ts): the tick read the woken sweep consumes runs BEFORE runGatedSweep acknowledges.
    // That very read re-reads the named head, so the woken sweep sees FAILURE, not the rollup kept before it.
    assert.ok(existsSync(sweepWakeMarkerPath(f.root)), "the delivery armed the wake");
    const named = await sweep(gate, f.root, gh, T0 + MINUTE);
    assert.deepEqual(named.headReads.sort(), [
      `repos/o/r/commits/${sha(3)}/check-runs?per_page=100`, `repos/o/r/commits/${sha(3)}/status`,
    ], "the next tick read re-reads the named head, and only it");
    assert.deepEqual(named.counts, { head_reads_made: 2, head_reads_skipped: 18 });
    const pr3 = named.prs.find((pr) => pr.number === 3);
    assert.equal(pr3?.statusCheckRollup?.find((entry) => entry.name === "ci-gate")?.conclusion, "FAILURE", "the woken sweep's read carries the new verdict");
    assert.ok(existsSync(githubChangedHeadsPath(f.root)), "the read never takes the entry: other gates still need it");

    // The gated sweep's acknowledge then consumes the marker; the entry was not lost, and is not read twice.
    acceptPass(f.root);
    assert.equal(existsSync(sweepWakeMarkerPath(f.root)), false, "the acknowledge consumed the marker");
    const after = await sweep(gate, f.root, gh, T0 + 2 * MINUTE);
    assert.deepEqual(after.headReads, [], "the head read since its delivery stays kept");
    assert.equal(after.prs.find((pr) => pr.number === 3)?.statusCheckRollup?.find((entry) => entry.name === "ci-gate")?.conclusion, "FAILURE");

    // A pull_request synchronize names its new head too; another repository's delivery names nothing here.
    const sync = { action: "synchronize", pull_request: { number: 4, head: { sha: sha(4) } } };
    assert.equal(await deliver(f.root, "pull_request", sync, "d-sync", T0 + 150_000), 202);
    assert.equal(changedHeadShaOf("pull_request", sync), sha(4));
    assert.equal(changedHeadShaOf("check_run", { check_run: { head_sha: "not-a-sha" } }), undefined);
    assert.equal(changedHeadShaOf("issue_comment", { sha: sha(4) }), undefined);
    assert.equal(changedHeadShaOf("status", null), undefined);
    acceptPass(f.root);
    writeFileSync(githubAcknowledgedHeadsPath(f.root), `${readFileSync(githubAcknowledgedHeadsPath(f.root), "utf8")}{torn\n{"sha":1}\n`);
    assert.deepEqual(peekChangedHeads(f.root).map((entry) => entry.sha), [sha(99), sha(3), sha(4)], "a torn or malformed line names no head");
    assert.equal(peekChangedHeads(f.root).length, 3, "a peek takes nothing");
    // The lock holder prunes what no gate needs: entries received before now - headRecheckMs.
    pruneAcknowledgedChangedHeads(f.root, T0 + 100_000);
    assert.deepEqual(peekChangedHeads(f.root).map((entry) => entry.sha), [sha(4)]);
    pruneAcknowledgedChangedHeads(f.root, T0, () => { throw new Error("disk full"); });
    assert.deepEqual(peekChangedHeads(f.root), [], "a failed re-append drops only what the floor re-reads anyway");
    acknowledgeChangedHeads(f.root);
    writeFileSync(githubAcknowledgedHeadsPath(f.root), `${JSON.stringify({ sha: sha(4), event: "pull_request", received_at: new Date(T0 + 150_000).toISOString() })}\n`);
    pruneAcknowledgedChangedHeads(f.root, T0 + 200_000);
    assert.equal(existsSync(githubAcknowledgedHeadsPath(f.root)), false, "nothing recent, nothing kept");
    pruneAcknowledgedChangedHeads(f.root, T0);
    acknowledgeChangedHeads(f.root);
    assert.equal(existsSync(githubAcknowledgedHeadsPath(f.root)), false, "an empty journal acknowledges nothing");

    // A successful leaf under enforce writes no marker but still journals its head: its rollup changed.
    const leaf = { action: "completed", check_run: { id: 8, name: "lint", conclusion: "success", status: "completed", head_sha: sha(6) } };
    assert.equal(await deliver(f.root, "check_run", leaf, "d-leaf", T0 + 160_000, { semanticCheckMode: "enforce" }), 202);
    assert.equal(existsSync(sweepWakeMarkerPath(f.root)), false);
    assert.match(readFileSync(githubChangedHeadsPath(f.root), "utf8"), new RegExp(sha(6)));
    // An unwritable acknowledged file keeps the claim beside the journal; nothing throws into the pass.
    mkdirSync(githubAcknowledgedHeadsPath(f.root));
    acknowledgeChangedHeads(f.root);
    assert.equal(existsSync(githubChangedHeadsPath(f.root)), false, "the live journal was claimed");
    // An unreadable acknowledged file reads as no entries, never thrown into the tick; a prune removes it.
    assert.deepEqual(peekChangedHeads(f.root), []);
    pruneAcknowledgedChangedHeads(f.root, T0);
    assert.equal(existsSync(githubAcknowledgedHeadsPath(f.root)), false, "the unreadable file is pruned");
    // A journal append that cannot land still accepts the delivery; the recheck interval covers the head.
    const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14809-nostate-`));
    try {
      assert.equal(await deliver(bare, "check_run", leaf, "d-leaf-2", T0, { semanticCheckMode: "enforce" }), 202);
      assert.equal(existsSync(join(bare, "state")), false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    f.cleanup();
  }
});

test("W1-T14809: a failed ls-remote reads every head over REST", async () => {
  const f = fixture();
  try {
    const gh = openPrReads();
    const gate = createHeadReadSweeper();
    assert.equal(await deliver(f.root, "status", { sha: sha(99), state: "success", context: "deploy" }, "d-live", T0), 202);
    acceptPass(f.root);
    await sweep(gate, f.root, gh, T0);
    assert.equal((await sweep(gate, f.root, gh, T0 + MINUTE)).headReads.length, 0, "positive control: a known head set skips");

    const failed = await sweep(gate, f.root, gh, T0 + 2 * MINUTE, async () => { throw new Error("fatal: unable to access origin"); });
    assert.equal(failed.headReads.length, 20, "every head is read over REST when its sha cannot be confirmed");
    assert.equal(failed.counts.head_reads_made, 20);
    assert.match(failed.counts.head_reads_unguarded ?? "", /^ls-remote failed: fatal: unable to access origin/, "and the sweep says why");

    // The real default: one `git ls-remote` in a checkout with no origin fails the same way.
    const noOrigin = gitRepo({ kind: "w1-t14809-no-origin" });
    gh.reset();
    await gate.begin(f.root, noOrigin.dir, { clock: clockAt(T0 + 3 * MINUTE), holdsDrainLock: () => true });
    await fetchOpenPrsWithPostedIdsAsync("o", "r", gh.read, undefined, gate.gate);
    assert.equal(gh.headReads().length, 20);
    assert.match(gate.gate.counts().head_reads_unguarded ?? "", /^ls-remote failed:/);

    // A read that fails keeps nothing for its head, synchronously or not, so the next sweep reads it again.
    const failing = createHeadReadGate();
    failing.beginSweep({ heads: new Set([sha(1)]), changed: [{ sha: sha(9), event: "status", received_at: new Date(T0).toISOString() }], nowMs: T0, recheckMs: MINUTE });
    const path = `repos/o/r/commits/${sha(1)}/status`;
    assert.throws(() => failing.wrap(() => { throw new Error("sync refusal"); })(["api", path]), /sync refusal/);
    await assert.rejects(Promise.resolve(failing.wrap(async () => { throw new Error("async refusal"); })(["api", path])), /async refusal/);
    failing.beginSweep({ heads: new Set([sha(1)]), changed: [], nowMs: T0 + 1, recheckMs: MINUTE });
    assert.equal(failing.answer(["api", path]), undefined, "no kept answer after a failed read");
    assert.equal(await failing.wrap(async () => "other")(["api", "repos/o/r/pulls?state=open&per_page=100"]), "other", "a non-head read passes through");

    // The policy floor, and the shipped default when the committed policy cannot be read.
    assert.equal(headRecheckMsFromPolicy(), DEFAULT_GITHUB_EVENT_WAKE_HEAD_RECHECK_MS);
    assert.equal(headRecheckMsFromPolicy(() => { throw new Error("unreadable policy"); }), DEFAULT_GITHUB_EVENT_WAKE_HEAD_RECHECK_MS);

    // A quiet repository keeps its skips: no delivery for an interval re-reads nothing the floor has not aged out.
    const quiet = createHeadReadSweeper();
    await sweep(quiet, f.root, gh, T0 + 20 * MINUTE);
    const silent = await sweep(quiet, f.root, gh, T0 + 21 * MINUTE);
    assert.deepEqual(silent.headReads, [], "a kept read younger than headRecheckMs is not re-read, delivery or none");
    assert.deepEqual(silent.counts, { head_reads_made: 0, head_reads_skipped: 20 });
  } finally {
    f.cleanup();
  }
});

test("W1-T14809: a standby's read takes no changed head from the active daemon, and a promotion re-reads", async () => {
  const f = fixture();
  try {
    const gh = openPrReads();
    const active = createHeadReadSweeper();
    const standby = createHeadReadSweeper();
    await sweep(active, f.root, gh, T0);
    await sweep(standby, f.root, gh, T0, allHeads, false);

    // (a) hand-over order: delivery, then the standby's pre-lock tick read, then the active daemon's next read.
    gh.fail();
    const checkRun = { action: "completed", check_run: { id: 9, name: "ci-gate", conclusion: "failure", status: "completed", head_sha: sha(3) } };
    assert.equal(await deliver(f.root, "check_run", checkRun, "d-handover", T0 + 30_000), 202);
    const pre = await sweep(standby, f.root, gh, T0 + MINUTE, allHeads, false);
    assert.equal(pre.headReads.length, 2, "the standby re-reads the named head too");
    const next = await sweep(active, f.root, gh, T0 + MINUTE + 1_000);
    assert.equal(next.headReads.length, 2, "the active daemon's next read still re-reads the named head");
    assert.equal(next.prs.find((pr) => pr.number === 3)?.statusCheckRollup?.find((entry) => entry.name === "ci-gate")?.conclusion, "FAILURE");

    // (b) the standby kept reads before it held the lock; an entry it never saw (here, lost from the journal) is
    // covered because its first locked read drops every pre-lock rollup and re-reads each head.
    const late = createHeadReadSweeper();
    gh.reset();
    const ok = openPrReads();
    await sweep(late, f.root, ok, T0 + 2 * MINUTE, allHeads, false);
    ok.fail();
    rmSync(githubChangedHeadsPath(f.root), { force: true });
    rmSync(githubAcknowledgedHeadsPath(f.root), { force: true });
    const promoted = await sweep(late, f.root, ok, T0 + 3 * MINUTE, allHeads, true);
    assert.equal(promoted.headReads.length, 20, "the first locked read re-reads every head");
    assert.equal(promoted.prs.find((pr) => pr.number === 3)?.statusCheckRollup?.find((entry) => entry.name === "ci-gate")?.conclusion, "FAILURE");
    const steady = await sweep(late, f.root, ok, T0 + 4 * MINUTE, allHeads, true);
    assert.equal(steady.headReads.length, 0, "a lock already held drops nothing");

    // The lock is read from the lock file itself: this process holds it only when the file names its pid.
    assert.equal(holdsDrainLock(f.root), false, "no lock file, no lock");
    writeFileSync(join(f.stateDir, "drain.lock"), JSON.stringify({ pid: process.pid + 1, host: "h", startedAt: new Date(T0).toISOString() }));
    assert.equal(holdsDrainLock(f.root), false, "another process's lock");
    writeFileSync(join(f.stateDir, "drain.lock"), JSON.stringify({ pid: process.pid, host: "h", startedAt: new Date(T0).toISOString() }));
    assert.equal(holdsDrainLock(f.root), true);
  } finally {
    f.cleanup();
  }
});

test("W1-T14809: a light pass's own open-PR read skips the heads its last read kept", async () => {
  const f = fixture();
  try {
    const gh = openPrReads(true);
    const sweeper = createHeadReadSweeper();
    const ledgerPath = join(f.stateDir, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const lightPass = (atMs: number) => buildOpenPrViewsAsync("o", "r", ledgerPath, {
      fetchAsync: gh.read, ciGateSource: { repository: REPOSITORY, checkoutRoot: f.root, isSelf: false },
      headReads: { sweeper, io: sweepIo(atMs) }, requiredContexts: () => ["ci-gate"], readCiGateRequired: () => [],
      readRequiredContextsAsync: async () => ({ kind: "contexts" as const, contexts: ["ci-gate"] }), fetchCiFailureEvidence: () => [],
    });
    gh.reset();
    await lightPass(T0);
    assert.equal(gh.headReads().length, 20, "positive control: the first light pass reads every head");
    gh.reset();
    await lightPass(T0 + MINUTE);
    assert.deepEqual(gh.headReads(), [], "a quiet repository with fresh kept reads: zero head reads");
    assert.deepEqual(takeHeadReadCounts(f.stateDir), { head_reads_made: 20, head_reads_skipped: 20 }, "its counts reach sweep.summary");
  } finally {
    f.cleanup();
  }
});

test("W1-T14809: one ls-remote names every branch and pull-request head on origin", async () => {
  const cloneDir = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14809-clone-`)), "clone");
  const { origin, clone } = originWithClone(cloneDir);
  const main = clone.git("rev-parse", "HEAD");
  clone.git("commit", "--quiet", "--allow-empty", "-m", "pr head");
  const prHead = clone.git("rev-parse", "HEAD");
  clone.git("push", "--quiet", "origin", "HEAD:refs/pull/7/head");
  const heads = await lsRemoteHeadShas(clone.dir);
  assert.deepEqual([...heads].sort(), [main, prHead].sort());
  assert.ok(origin.dir.length > 0);
  // The committed policy carries the floor the read plane falls back to.
  assert.equal(loadDefaultPolicy().values.githubEventWake.headRecheckMs, DEFAULT_GITHUB_EVENT_WAKE_HEAD_RECHECK_MS);
});
