/**
 * W1-T14874 — the daemon's tick sweep judges every held dispatch claim with the W1-T9432 silence judge.
 * OBSERVED 2026-11-25: 12 of 15 claims on core were stale (minted 2026-10-17 to 2026-11-19). Selection defers a task
 * whose claim another lane holds, so no lane ever met them, and the dead-claimant arm never matched a recycled
 * container's hostname. Driven against REAL bare fixture remotes with injected ledger rows and clocks.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { fixedClock } from "#src/lib/clock.js";
import * as claimLib from "#src/lib/dispatch-claim.js";
import type { ClaimSilenceJudgeInputs, DispatchClaimListing, DispatchClaimReserverAsync } from "#src/lib/dispatch-claim.js";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
});

const { dispatchClaimRef, gitClaimRunnerAsync, gitDispatchClaimReserverAsync } = claimLib;
type Sweep = (r: DispatchClaimReserverAsync, l: DispatchClaimListing, d: ClaimSilenceJudgeInputs & { skip?: ReadonlySet<string> }) => Promise<Array<{ taskId: string; verdict: string; dropped?: boolean; anchor?: string }>>;
// Namespace read: this file loads on a base without the new export, so each test fails on its own assertion.
const sweep: Sweep = (r, l, d) => (claimLib as unknown as { sweepSilentDispatchClaims: Sweep }).sweepSilentDispatchClaims(r, l, d);

const MIN = 60_000, HOUR = 60 * MIN, W = HOUR;
type Row = Record<string, unknown>;

function world(t: { after(fn: () => void): void }) {
  const bare = gitRepo({ bare: true, kind: "tick-silence-bare" });
  const work = gitRepo({ kind: "tick-silence-work" });
  work.addRemote("origin", bare.dir);
  work.git("push", "--quiet", "origin", "main");
  t.after(() => { bare.cleanup(); work.cleanup(); });
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const reserver = gitDispatchClaimReserverAsync({ run: gitClaimRunnerAsync(work.dir) });
  return {
    work: work.dir, reserver,
    tip: (id: string) => git(bare.dir, "for-each-ref", "--format=%(objectname)", dispatchClaimRef(id)),
    async claim(id: string, mintedAtMs: number, holder = "3817724@Remudero"): Promise<string> {
      const tree = git(work.dir, "hash-object", "-t", "tree", "/dev/null");
      const sha = git(work.dir, "commit-tree", tree, "-m", `rmd-dispatch claim ${holder} ${new Date(mintedAtMs).toISOString()}`);
      assert.equal(await reserver.attempt(id, sha), "created");
      return sha;
    },
    async listing(): Promise<DispatchClaimListing> { return claimLib.listHeldDispatchClaims(reserver); },
  };
}

/** `n` builds, each claimed and given its verdict `durationMs` later. */
const measured = (n: number, durationMs: number, nowMs: number): Row[] => Array.from({ length: n }, (_, i) => {
  const at = nowMs - 48 * HOUR + i * MIN;
  return [
    { step: "dispatch.claim", outcome: "created", run_id: `m-${i}`, task_id: `T-M-${i}`, ts: new Date(at).toISOString() },
    { step: "verdict", verdict: "merged", run_id: `m-${i}`, task_id: `T-M-${i}`, ts: new Date(at + durationMs).toISOString() },
  ];
}).flat();

function deps(work: string, rows: Row[], nowMs: number, logged: Array<{ step: string; fields: Row }>, reads?: { n: number }): ClaimSilenceJudgeInputs {
  return {
    run: gitClaimRunnerAsync(work), stateDir: join(work, "no-state"), clock: fixedClock(nowMs),
    log: (step, fields) => void logged.push({ step, fields }),
    readRows: async () => { if (reads) reads.n++; return rows; },
    mintedByThisInstance: () => false,
  };
}

test("W1-T14874 criterion 1: the tick sweep drops a claim silent for 2W, logs it as tick-sweep and mints nothing", async t => {
  const w = world(t);
  const nowMs = Date.now();
  const stale = await w.claim("W1-T13878", nowMs - 6 * 24 * HOUR);
  const live = await w.claim("W1-T14869", nowMs - 10 * MIN, "1609912@Remudero");
  const logged: Array<{ step: string; fields: Row }> = [], reads = { n: 0 };
  const judged = await sweep(w.reserver, await w.listing(), deps(w.work, measured(40, W, nowMs), nowMs, logged, reads));
  assert.equal(w.tip("W1-T13878"), "", "THE CLAIM: the stale claim is gone from origin");
  assert.equal(judged.find(j => j.taskId === "W1-T13878")?.verdict, "reclaim");
  assert.equal(judged.find(j => j.taskId === "W1-T13878")?.anchor, undefined, "the sweep never takes the task");
  assert.equal(w.tip("W1-T14869"), live, "a holder silent under W keeps its claim");
  const rows = logged.filter(r => r.step === "dispatch.claim_reclaimed");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fields.surface, "tick-sweep");
  assert.equal(rows[0]!.fields.sha, stale);
  assert.equal(rows[0]!.fields.dropped, true);
  assert.equal(logged.filter(r => r.step === "dispatch.claim").length, 0, "no claim is minted");
  assert.equal(reads.n, 1, "one ledger read serves every claim the pass judges");
});

test("W1-T14874 criterion 2: invariant:the-sweep-keeps-a-claim-it-cannot-judge", async t => {
  const w = world(t);
  const nowMs = Date.now();
  const recent = await w.claim("W1-T1", nowMs - 90 * MIN); // silent for W, under 2W: reported, kept
  const own = await w.claim("W1-T2", nowMs - 6 * 24 * HOUR, "77@this-fleet");
  const skipped = await w.claim("W1-T3", nowMs - 6 * 24 * HOUR);
  const logged: Array<{ step: string; fields: Row }> = [];
  const base = deps(w.work, measured(40, W, nowMs), nowMs, logged);
  const judged = await sweep(w.reserver, await w.listing(), { ...base, mintedByThisInstance: a => a.host === "this-fleet", skip: new Set(["W1-T3"]) });
  assert.deepEqual(judged.map(j => [j.taskId, j.verdict]).sort(), [["W1-T1", "unrenewed"], ["W1-T2", "no-verdict"]]);
  assert.deepEqual([w.tip("W1-T1"), w.tip("W1-T2"), w.tip("W1-T3")], [recent, own, skipped], "THE CLAIM: every claim it cannot judge stays");
  // No measured window: nothing is judged at all, however old the claim.
  const none = await sweep(w.reserver, await w.listing(), deps(w.work, [], nowMs, logged));
  assert.ok(none.every(j => j.verdict === "no-verdict"));
  assert.equal(w.tip("W1-T3"), skipped);
  // An unreadable run branch read is no verdict.
  const failing: ClaimSilenceJudgeInputs["run"] = async () => ({ status: 128, stdout: "", stderr: "fatal: unreachable" });
  const blind = await sweep(w.reserver, { ok: true, claims: [{ taskId: "W1-T3", holder: skipped }] }, { ...base, run: failing });
  assert.equal(blind[0]!.verdict, "no-verdict");
  assert.equal(w.tip("W1-T3"), skipped);
  // A failed listing judges nothing.
  assert.deepEqual(await sweep(w.reserver, { ok: false, stderr: "x" }, base), []);
});

test("W1-T14874 criterion 3: a claim renewed between the judgement and the drop survives", async t => {
  const w = world(t);
  const nowMs = Date.now();
  const stale = await w.claim("W1-T5", nowMs - 6 * 24 * HOUR);
  const logged: Array<{ step: string; fields: Row }> = [];
  // The holder renews after the judge read its anchor: the drop is leased to the judged sha.
  let renewed = "";
  const racing: DispatchClaimReserverAsync = {
    ...w.reserver,
    drop: async (id, opts) => {
      const r = await claimLib.renewDispatchClaimAsync(w.reserver, id, stale);
      renewed = r.outcome === "renewed" ? r.sha : "";
      return w.reserver.drop(id, opts);
    },
  };
  const judged = await sweep(racing, await w.listing(), deps(w.work, measured(40, W, nowMs), nowMs, logged));
  assert.equal(judged[0]!.verdict, "reclaim");
  assert.equal(judged[0]!.dropped, false);
  assert.ok(renewed !== "" && renewed !== stale);
  assert.equal(w.tip("W1-T5"), renewed, "THE CLAIM: the renewed claim survives the leased drop");
});
