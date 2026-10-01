/**
 * test/a-recycled-container-releases-the-claims-it-held.test.ts — W1-T5047.
 *
 * MEASURED 2026-10-01: refs/rmd-dispatch/* held 8 claims whose anchors named containers gone from
 * `docker ps -a`; 4 were on unmerged tasks. W1-T4266's anchor was `93@04270370982e` (2026-09-26).
 * It was dispatched 4 times on 09-30, each run met the claim, logged blocked_inflight and spent a
 * breaker strike. The W1-T2784 dead-claimant arm needs the anchor to name THIS host, and a container's
 * host is its id, so after any recycle the claim fell to the operator arm forever.
 *
 * THE PROOF (no timer): the claim's own `dispatch.claim` created row, in THIS instance's ledger,
 * written by the daemon (actor "daemon") on the anchor's host; and this process holds the instance's
 * single-instance lock (state/drain.lock), taken AFTER the claim was minted. A daemon cannot hold a
 * claim it minted once another daemon holds the instance lock, so the claimant cannot exist.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  decideDispatchClaimRelease,
  dispatchClaimRef,
  findClaimMintRow,
  gitDispatchClaimReserver,
  releaseReplacedContainerClaims,
  type ClaimAnchorIdentity,
  type ClaimMintRow,
  type DispatchClaimReserver,
} from "../src/lib/dispatch-claim.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { daemonCommand } from "../src/run-task.js";
import type { DaemonSummary } from "../src/lib/daemon.js";

const OLD_HOST = "04270370982e";
const LOCAL_HOST = "6e0b5200b656";
const MINTED_ISO = "2026-09-26T15:42:01.170Z";
const LOCK_ISO = "2026-10-01T03:10:00.000Z";
const ANCHOR_MESSAGE = `rmd-dispatch claim 93@${OLD_HOST} ${MINTED_ISO}`;
const DAEMON_MINT_ROW: ClaimMintRow = { host: OLD_HOST, actor: "daemon", ts: "2026-09-26T15:42:01.912Z", source: "ledger.2026-09-26T16-01-00-000Z.ndjson.gz" };

function fakeReserver(claims: Record<string, string>): DispatchClaimReserver & { dropped: string[]; leases: (string | undefined)[] } {
  const dropped: string[] = [];
  const leases: (string | undefined)[] = [];
  return {
    dropped,
    leases,
    mintAnchor: () => "anchor",
    attempt: () => "taken",
    holder: (taskId) => (claims[taskId] !== undefined ? `sha-${taskId}` : undefined),
    drop: (taskId, opts) => {
      leases.push(opts?.expect);
      dropped.push(taskId);
      return true;
    },
    anchorMessage: (taskId) => claims[taskId],
    list: () => Object.keys(claims),
  };
}

const PROBE = { localHost: LOCAL_HOST, lockHeldSinceMs: Date.parse(LOCK_ISO), lockHeldSinceIso: LOCK_ISO };

test("W1-T5047: a claim minted by this instance replaced container is released at boot", () => {
  const reserver = fakeReserver({ "W1-T4266": ANCHOR_MESSAGE });
  const results = releaseReplacedContainerClaims(reserver, { ...PROBE, findMintRow: () => DAEMON_MINT_ROW });
  assert.deepEqual(reserver.dropped, ["W1-T4266"]);
  assert.deepEqual(reserver.leases, ["sha-W1-T4266"], "a dead claim is dropped pinned to the sha that was judged");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.taskId, "W1-T4266");
  assert.equal(results[0]!.arm, "dead-claimant");
  assert.equal(results[0]!.dropped, true);
  assert.match(results[0]!.reason, /04270370982e/);
  assert.match(results[0]!.reason, /drain\.lock|single-instance lock/);
});

test("W1-T5047: an operator CLI claim from another host is never auto-released", () => {
  const reserver = fakeReserver({ "W1-T4266": ANCHOR_MESSAGE });
  const operatorRow: ClaimMintRow = { ...DAEMON_MINT_ROW, actor: "operator" };
  const results = releaseReplacedContainerClaims(reserver, { ...PROBE, findMintRow: () => operatorRow });
  assert.deepEqual(reserver.dropped, []);
  assert.equal(results[0]!.arm, "operator");
  assert.equal(results[0]!.release, false);
});

test("W1-T5047: a claim minted after this process booted is never released", () => {
  const lateIso = "2026-10-01T03:20:00.000Z";
  const reserver = fakeReserver({ "W1-T4266": `rmd-dispatch claim 93@${OLD_HOST} ${lateIso}` });
  const results = releaseReplacedContainerClaims(reserver, {
    ...PROBE,
    findMintRow: () => ({ ...DAEMON_MINT_ROW, ts: "2026-10-01T03:20:01.000Z" }),
  });
  assert.deepEqual(reserver.dropped, []);
  assert.equal(results[0]!.arm, "operator");
});

test("W1-T5047: a claim with no mint row in this ledger is kept, fail closed", () => {
  const reserver = fakeReserver({ "W1-T4266": ANCHOR_MESSAGE, "W1-T9": "not an anchor" });
  const asked: string[] = [];
  const results = releaseReplacedContainerClaims(reserver, {
    ...PROBE,
    findMintRow: (taskId) => {
      asked.push(taskId);
      return undefined;
    },
  });
  assert.deepEqual(reserver.dropped, []);
  assert.deepEqual(results.map((r) => r.arm), ["operator", "operator"]);
  assert.deepEqual(asked, ["W1-T4266"], "an unparseable anchor never reads the ledger");
});

test("W1-T5047: a mint row from a different host than the anchor never releases", () => {
  const anchor: ClaimAnchorIdentity = { pid: 93, host: OLD_HOST, mintedAtMs: Date.parse(MINTED_ISO), mintedAtIso: MINTED_ISO };
  const decision = decideDispatchClaimRelease({
    heldByThisRun: false,
    evidenceObserved: false,
    taskId: "W1-T4266",
    anchorIdentity: anchor,
    replaced: { ...PROBE, mintRow: { ...DAEMON_MINT_ROW, host: "someone-else" } },
  });
  assert.equal(decision.arm, "operator");
  const sameHost = decideDispatchClaimRelease({
    heldByThisRun: false,
    evidenceObserved: false,
    taskId: "W1-T4266",
    anchorIdentity: anchor,
    replaced: { ...PROBE, localHost: OLD_HOST, mintRow: DAEMON_MINT_ROW },
  });
  assert.equal(sameHost.arm, "operator", "a same-host claim is the W1-T2784 arm's case, never this one");
});

test("W1-T5047: a merged task's claim is dropped on evidence during the boot sweep", () => {
  const reserver = fakeReserver({ "W1-T3718": `rmd-dispatch claim 908888@6dae8df56713 2026-09-27T12:36:46.731Z` });
  const results = releaseReplacedContainerClaims(reserver, { ...PROBE, findMintRow: () => undefined, isMerged: () => true });
  assert.equal(results[0]!.arm, "evidence");
  assert.deepEqual(reserver.dropped, ["W1-T3718"]);
});

test("W1-T5047: the git reserver lists the task ids that hold dispatch claims", () => {
  const reserver = gitDispatchClaimReserver({
    run: (args) => {
      assert.deepEqual(args, ["ls-remote", "origin", "refs/rmd-dispatch/*"]);
      return { status: 0, stdout: `${"a".repeat(40)}\t${dispatchClaimRef("W1-T4266")}\n${"b".repeat(40)}\t${dispatchClaimRef("W1-T3676")}\n`, stderr: "" };
    },
  });
  assert.deepEqual(reserver.list?.(), ["W1-T4266", "W1-T3676"]);
  const unreachable = gitDispatchClaimReserver({ run: () => ({ status: 128, stdout: "", stderr: "fatal" }) });
  assert.deepEqual(unreachable.list?.(), []);
});

test("W1-T5047: the mint row is found in the first archive after the claim and nowhere beyond the bound", (t) => {
  const dir = makeTempDir("claim-mint");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const claimRow = { ts: DAEMON_MINT_ROW.ts, host: OLD_HOST, actor: "daemon", step: "dispatch.claim", ref: dispatchClaimRef("W1-T4266"), outcome: "created" };
  const takenRow = { ...claimRow, ts: "2026-09-26T15:50:00.000Z", host: "elsewhere", outcome: "taken" };
  writeFileSync(join(stateDir, "ledger.2026-09-25T00-00-00-000Z.ndjson.gz"), gzipSync(`${JSON.stringify(claimRow)}\n`));
  writeFileSync(join(stateDir, "ledger.2026-09-26T16-01-00-000Z.ndjson.gz"), gzipSync(`${JSON.stringify(takenRow)}\n${JSON.stringify(claimRow)}\n`));
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  const anchor: ClaimAnchorIdentity = { pid: 93, host: OLD_HOST, mintedAtMs: Date.parse(MINTED_ISO), mintedAtIso: MINTED_ISO };
  const row = findClaimMintRow(stateDir, "W1-T4266", anchor);
  assert.deepEqual(row, { ...DAEMON_MINT_ROW, source: "ledger.2026-09-26T16-01-00-000Z.ndjson.gz" });

  // Beyond the bound: three later archives without the row come first, so the real one is never read.
  for (const stamp of ["2026-09-26T15-45-00-000Z", "2026-09-26T15-50-00-000Z", "2026-09-26T15-55-00-000Z"]) {
    writeFileSync(join(stateDir, `ledger.${stamp}.ndjson.gz`), gzipSync(`${JSON.stringify(takenRow)}\n`));
  }
  assert.equal(findClaimMintRow(stateDir, "W1-T4266", anchor), undefined);

  // The live file is read too, and a torn line in it is skipped.
  writeFileSync(join(stateDir, "ledger.ndjson"), `{torn dispatch.claim ${dispatchClaimRef("W1-T4266")}\n"dispatch.claim ${dispatchClaimRef("W1-T4266")}"\n${JSON.stringify(claimRow)}\n`);
  assert.equal(findClaimMintRow(stateDir, "W1-T4266", anchor)?.source, "ledger.ndjson");
  assert.equal(findClaimMintRow(join(dir, "absent"), "W1-T4266", anchor), undefined);
});

async function bootDaemonWith(reserver: DispatchClaimReserver, t: { after: (fn: () => void) => void }): Promise<Array<Record<string, unknown>>> {
  const home = makeTempDir("claim-boot");
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
  const code = await daemonCommand(["--repo", "remudero-sandbox", "--plan", planPath, "--max", "0"], {
    bootClaimReserver: reserver,
    now: () => Date.parse(LOCK_ISO),
    runDaemon: async (): Promise<DaemonSummary> => ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 }),
  });
  assert.equal(code, 0);
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("W1-T5047: the daemon sweeps dispatch claims once after taking its lock and ledgers each decision", async (t) => {
  const reserver = fakeReserver({ "W1-T4266": ANCHOR_MESSAGE });
  const rows = await bootDaemonWith(reserver, t);
  const released = rows.filter((r) => r.step === "dispatch.claim_released" && r.surface === "boot-sweep");
  assert.equal(released.length, 1);
  assert.equal(released[0]!.ref, dispatchClaimRef("W1-T4266"));
  assert.equal(released[0]!.arm, "operator", "no mint row in this fresh ledger, so the claim is kept (fail closed)");
  assert.deepEqual(reserver.dropped, []);
});

test("W1-T5047: a boot sweep that throws is ledgered and the daemon still starts", async (t) => {
  const reserver = fakeReserver({});
  reserver.list = () => {
    throw new Error("ls-remote exploded");
  };
  const rows = await bootDaemonWith(reserver, t);
  const failed = rows.filter((r) => r.step === "dispatch.claim_sweep_failed");
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]!.error), /ls-remote exploded/);
});
