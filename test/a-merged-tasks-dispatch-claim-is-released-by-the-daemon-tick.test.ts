/**
 * test/a-merged-tasks-dispatch-claim-is-released-by-the-daemon-tick.test.ts — W1-T8616.
 *
 * MEASURED 2026-10-12 15:13Z: all 8 claims under refs/rmd-dispatch/* belonged to merged tasks, and on
 * 2026-10-14 24 of 33 did. The evidence arm of `decideDispatchClaimRelease` ran only when something
 * tried to dispatch a merged task, which drain never does, so each claim waited for an operator.
 * The daemon tick now releases them from the merged projection it already built.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// Namespace import: this file must LOAD on a base without the new symbols, so each test fails on
// its own assertion rather than on a missing export.
import * as claimLib from "../src/lib/dispatch-claim.js";
import type { ClaimAnchorIdentity, DispatchClaimListing, DispatchClaimReserverAsync } from "../src/lib/dispatch-claim.js";
import { runDaemon, type DaemonDeps, type DaemonSummary } from "../src/lib/daemon.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { daemonCommand } from "../src/run-task.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const { dispatchClaimRef, gitClaimRunnerAsync, gitDispatchClaimReserverAsync } = claimLib;
type Sweep = (reserver: DispatchClaimReserverAsync, deps: Record<string, unknown>) => Promise<unknown[]>;
const releaseLandedDispatchClaims: Sweep = (reserver, deps) =>
  (claimLib as unknown as { releaseLandedDispatchClaims: Sweep }).releaseLandedDispatchClaims(reserver, deps);
const claimMintedByRerun = (stateDir: string, taskId: string, anchor: ClaimAnchorIdentity): boolean =>
  (claimLib as unknown as { claimMintedByRerun: (s: string, t: string, a: ClaimAnchorIdentity) => boolean }).claimMintedByRerun(stateDir, taskId, anchor);

type Row = { step: string; fields: Record<string, unknown> };

/** A fake async reserver over an in-memory ref table whose drops honour the lease the way git does. */
function fakeReserver(claims: Record<string, { sha: string; message?: string }>) {
  const refs = new Map(Object.entries(claims));
  const drops: Array<{ taskId: string; expect?: string }> = [];
  const reserver: DispatchClaimReserverAsync = {
    mintAnchor: () => "anchor",
    attempt: () => "taken",
    holder: (taskId) => refs.get(taskId)?.sha,
    drop: (taskId, opts) => {
      drops.push({ taskId, expect: opts?.expect });
      const cur = refs.get(taskId);
      if (!cur || (opts?.expect !== undefined && opts.expect !== cur.sha)) return false;
      refs.delete(taskId);
      return true;
    },
    anchorMessage: (taskId) => refs.get(taskId)?.message,
    list: () => [...refs.keys()],
  };
  (reserver as { listHeld?: () => DispatchClaimListing }).listHeld = () => ({
    ok: true,
    claims: [...refs].map(([taskId, c]) => ({ taskId, holder: c.sha })),
  });
  return { reserver, refs, drops };
}

const MERGED = new Map([
  ["W1-T6369", "https://github.com/craigoley/remudero/pull/10118"],
  ["W1-T8396", "https://github.com/craigoley/remudero/pull/11085"],
]);
const isMerged = (id: string) => MERGED.has(id);

test("W1-T8616: a merged task claim is released by the tick", async () => {
  const { reserver, refs, drops } = fakeReserver({
    "W1-T6369": { sha: "a".repeat(40) },
    "W1-T8396": { sha: "b".repeat(40) },
    "W1-T9999": { sha: "c".repeat(40) },
  });
  const rows: Row[] = [];
  const sweeps: Array<Promise<void>> = [];
  const plan = loadPlanFromYaml(`
- id: D
  title: unrelated task
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`, "fixture");
  const deps: DaemonDeps = {
    refreshMerged: () => isMerged,
    runOne: async (taskId): Promise<RunResult> => ({ taskId, runId: "d-run", merged: true, costUsd: 0, verdict: "merged" }),
    sleep: async () => {},
    log: (step, fields = {}) => rows.push({ step, fields }),
  };
  (deps as { releaseLandedClaims?: (m: (id: string) => boolean) => Promise<void> }).releaseLandedClaims = (merged) => {
    const p = releaseLandedDispatchClaims(reserver, {
      isMerged: merged,
      isIndeterminate: () => false,
      prUrlFor: (id: string) => MERGED.get(id),
      log: (step: string, fields: Record<string, unknown>) => rows.push({ step, fields }),
    }).then(() => undefined);
    sweeps.push(p);
    return p;
  };
  await runDaemon(plan, deps, { max: 1, pollIntervalMs: 1 });
  await Promise.all(sweeps);

  assert.ok(sweeps.length >= 1, "the tick starts the sweep");
  assert.deepEqual([...refs.keys()], ["W1-T9999"], "both merged claims are gone; the unmerged one stays");
  assert.deepEqual(
    drops.map((d) => [d.taskId, d.expect]),
    [["W1-T6369", "a".repeat(40)], ["W1-T8396", "b".repeat(40)]],
    "each drop is leased to the sha the listing saw",
  );
  const released = rows.filter((r) => r.step === "dispatch.claim_released");
  assert.equal(released.length, 2, "one row per release, none for the claim left alone");
  assert.deepEqual(released[0]!.fields, {
    ref: dispatchClaimRef("W1-T6369"),
    surface: "tick-sweep",
    holder: "a".repeat(40),
    pr_url: "https://github.com/craigoley/remudero/pull/10118",
    arm: "evidence",
    release: true,
    dropped: true,
    reason: "W1-T6369's work is already observed landed, so its claim is stale and any host may drop it",
  });
  assert.equal(released[1]!.fields.ref, dispatchClaimRef("W1-T8396"));
});

test("W1-T8616: a tick whose sweep throws ledgers the failure and the daemon keeps running", async () => {
  const rows: Row[] = [];
  const plan = loadPlanFromYaml(`
- id: D
  title: unrelated task
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`, "fixture");
  const deps: DaemonDeps = {
    refreshMerged: () => () => false,
    runOne: async (taskId): Promise<RunResult> => ({ taskId, runId: "d-run", merged: true, costUsd: 0, verdict: "merged" }),
    sleep: async () => {},
    log: (step, fields = {}) => rows.push({ step, fields }),
  };
  let started = 0;
  (deps as { releaseLandedClaims?: () => Promise<void> }).releaseLandedClaims = async () => {
    started += 1;
    throw new Error("ls-remote exploded");
  };
  const summary = await runDaemon(plan, deps, { max: 1, pollIntervalMs: 1 });
  await new Promise((r) => setImmediate(r));
  assert.ok(started >= 1);
  assert.deepEqual(summary.merged, ["D"]);
  const failed = rows.filter((r) => r.step === "dispatch.claim_sweep_failed");
  assert.equal(failed.length >= 1, true);
  assert.equal(failed[0]!.fields.surface, "tick-sweep");
  assert.match(String(failed[0]!.fields.error), /ls-remote exploded/);
});

test("W1-T8616: an unmerged or indeterminate task claim is left alone", async () => {
  const { reserver, refs, drops } = fakeReserver({
    "W1-T6369": { sha: "a".repeat(40) },
    "W1-T9999": { sha: "c".repeat(40) },
  });
  const rows: Row[] = [];
  const results = await releaseLandedDispatchClaims(reserver, {
    isMerged,
    isIndeterminate: (id: string) => id === "W1-T6369",
    log: (step: string, fields: Record<string, unknown>) => rows.push({ step, fields }),
  });
  assert.deepEqual(results, []);
  assert.deepEqual(drops, [], "neither an unmerged nor an indeterminate claim is dropped");
  assert.equal(refs.size, 2);
  assert.deepEqual(rows, [], "a claim left alone writes nothing, so a quiet tick adds no rows");
});

test("W1-T8616: a failed listing is a failure row, never an empty list", async () => {
  const { reserver, drops } = fakeReserver({ "W1-T6369": { sha: "a".repeat(40) } });
  (reserver as { listHeld?: () => DispatchClaimListing }).listHeld = () => ({ ok: false, stderr: "fatal: unable to access origin" });
  const rows: Row[] = [];
  const log = (step: string, fields: Record<string, unknown>) => rows.push({ step, fields });
  await releaseLandedDispatchClaims(reserver, { isMerged, isIndeterminate: () => false, log });
  delete (reserver as { listHeld?: unknown }).listHeld;
  await releaseLandedDispatchClaims(reserver, { isMerged, isIndeterminate: () => false, log });
  assert.deepEqual(drops, []);
  assert.deepEqual(rows.map((r) => [r.step, r.fields.surface]), [
    ["dispatch.claim_sweep_failed", "tick-sweep"],
    ["dispatch.claim_sweep_failed", "tick-sweep"],
  ]);
  assert.match(String(rows[0]!.fields.error), /unable to access origin/);
  assert.match(String(rows[1]!.fields.error), /cannot list claims/);
});

/** A real local bare origin and a working clone, with a local identity (CI runners have none). */
function originAndWork(): { origin: GitRepo; work: GitRepo; cleanup(): void } {
  const origin = gitRepo({ bare: true, kind: "claim-origin" });
  const work = gitRepo({ kind: "claim-work" });
  work.git("config", "user.name", "remudero-test-work");
  work.git("config", "user.email", "work@remudero.invalid");
  work.addRemote("origin", origin.dir);
  work.git("push", "--quiet", "origin", "main");
  return { origin, work, cleanup: () => (origin.cleanup(), work.cleanup()) };
}

test("W1-T8616: a claim re-minted after the listing survives the drop", async (t) => {
  const f = originAndWork();
  t.after(() => f.cleanup());
  const real = gitDispatchClaimReserverAsync({ run: gitClaimRunnerAsync(f.work.dir) });
  assert.equal(await real.attempt("W1-T6369", await real.mintAnchor()), "created");
  assert.equal(await real.attempt("W1-T8396", await real.mintAnchor()), "created");
  const listedSha = await real.holder("W1-T6369");
  // Between the listing and the drop, the claim is dropped and minted again by another lane.
  let reminted: string | undefined;
  const reserver: DispatchClaimReserverAsync = {
    ...real,
    listHeld: async () => {
      const listing = await real.listHeld!();
      assert.equal(await real.drop("W1-T6369", { expect: listedSha }), true);
      const anchor = await real.mintAnchor();
      assert.equal(await real.attempt("W1-T6369", anchor), "created");
      reminted = anchor;
      return listing;
    },
  };
  const rows: Row[] = [];
  await releaseLandedDispatchClaims(reserver, {
    isMerged,
    isIndeterminate: () => false,
    log: (step: string, fields: Record<string, unknown>) => rows.push({ step, fields }),
  });
  assert.ok(reminted && reminted !== listedSha);
  assert.equal(await real.holder("W1-T6369"), reminted, "the re-minted claim survives the leased drop");
  assert.equal(await real.holder("W1-T8396"), undefined, "a claim still at its listed sha is dropped");
  const byRef = new Map(rows.filter((r) => r.step === "dispatch.claim_released").map((r) => [r.fields.ref, r.fields]));
  assert.equal(byRef.get(dispatchClaimRef("W1-T6369"))?.dropped, false, "the loser of the race says dropped: false");
  assert.equal(byRef.get(dispatchClaimRef("W1-T6369"))?.holder, listedSha);
  assert.equal(byRef.get(dispatchClaimRef("W1-T8396"))?.dropped, true);
  // A failed real listing reads as a failure, not as no claims.
  f.work.git("remote", "set-url", "origin", join(f.work.dir, "no-such-origin"));
  const failed = await real.listHeld!();
  assert.equal(failed.ok, false);
});

test("W1-T8616: a rerun lane claim on a merged task is left alone", async (t) => {
  const dir = makeTempDir("tick-claim-rerun");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const HOST = "f25704950f28";
  const MINT = "2026-10-14T12:00:00.000Z";
  const mintRow = (task: string, runId: string) =>
    JSON.stringify({ ts: "2026-10-14T12:00:01.000Z", host: HOST, actor: "daemon", run_id: runId, task_id: task, step: "dispatch.claim", ref: dispatchClaimRef(task), outcome: "created" });
  writeFileSync(join(stateDir, "ledger.ndjson"), [
    JSON.stringify({ ts: "2026-10-14T12:00:00.500Z", host: HOST, run_id: "rerun-run", task_id: "W1-T6369", step: "dispatch.rerun_override" }),
    mintRow("W1-T6369", "rerun-run"),
    "{torn dispatch.rerun_override plain-run",
    mintRow("W1-T8396", "plain-run"),
  ].join("\n") + "\n");
  const message = `rmd-dispatch claim 113@${HOST} ${MINT}`;
  const { reserver, refs } = fakeReserver({
    "W1-T6369": { sha: "a".repeat(40), message },
    "W1-T8396": { sha: "b".repeat(40), message },
  });
  const rows: Row[] = [];
  const reportedRerun = new Set<string>();
  const deps = {
    isMerged,
    isIndeterminate: () => false,
    isRerunClaim: (id: string, anchor: ClaimAnchorIdentity) => claimMintedByRerun(stateDir, id, anchor),
    reportedRerun,
    localHost: HOST,
    log: (step: string, fields: Record<string, unknown>) => rows.push({ step, fields }),
  };
  await releaseLandedDispatchClaims(reserver, deps);
  await releaseLandedDispatchClaims(reserver, deps);
  assert.deepEqual([...refs.keys()], ["W1-T6369"], "the rerun claim stays; the ordinary merged claim is released");
  const rerunRows = rows.filter((r) => r.fields.ref === dispatchClaimRef("W1-T6369"));
  assert.equal(rerunRows.length, 1, "the rerun exception is reported once per holder, not every tick");
  assert.equal(rerunRows[0]!.fields.release, false);
  assert.match(String(rerunRows[0]!.fields.reason), /--rerun/);
  // A claim minted on another host is not looked up in this host's ledger, so it is released.
  const other = fakeReserver({ "W1-T6369": { sha: "d".repeat(40), message: `rmd-dispatch claim 7@Craigs-Mac-mini ${MINT}` } });
  await releaseLandedDispatchClaims(other.reserver, { ...deps, reportedRerun: new Set<string>() });
  assert.equal(other.refs.size, 0);
});

test("W1-T8616: the daemon command wires the tick sweep to the claim reserver and its ledger", async (t) => {
  const home = makeTempDir("tick-claim-boot");
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });
  const tick = fakeReserver({ "W1-T6369": { sha: "a".repeat(40), message: "rmd-dispatch claim 1@elsewhere 2026-10-14T12:00:00.000Z" } });
  const boot = { mintAnchor: () => "x", attempt: () => "taken" as const, holder: () => undefined, drop: () => false, list: () => [] };
  const code = await daemonCommand(["--repo", "remudero-sandbox", "--plan", planPath, "--max", "0"], {
    bootClaimReserver: boot,
    ...({ tickClaimReserver: tick.reserver } as Record<string, unknown>),
    runDaemon: async (_plan, wired): Promise<DaemonSummary> => {
      await (wired as { releaseLandedClaims?: (m: (id: string) => boolean) => Promise<void> }).releaseLandedClaims?.((id) => id === "W1-T6369");
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  });
  assert.equal(code, 0);
  assert.equal(tick.refs.size, 0, "the wired sweep released the merged task's claim");
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const released = ledger.filter((r) => r.step === "dispatch.claim_released" && r.surface === "tick-sweep");
  assert.equal(released.length, 1);
  assert.equal(released[0]!.ref, dispatchClaimRef("W1-T6369"));
  assert.equal(released[0]!.dropped, true);
});
