// W1-T13241: a dispatch claim counts as minted by this instance's fleet only when its ledger mint row names
// this instance's host AND a fleet actor (daemon or run_child). A hand session's claim (operator actor), or one
// minted on another host, goes to the silence judge, which reclaims it once its silence passes 2W. Observed
// 2026-11-16: `3861824@Remudero`, minted by `operator_human` on the host, outlived its process and held
// W1-T12114 for hours because the judge handed it to the dead-claimant arm, which cannot judge it.
// Driven through `reclaimSilentDispatchClaim`'s DEFAULT mint-row probe over a real ledger file, with injected
// reservers, run-branch histories and clocks.

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  dispatchClaimRef,
  findClaimMintRow,
  parseClaimAnchorMessage,
  reclaimSilentDispatchClaim,
  type ClaimSilenceJudgeInputs,
  type DispatchClaimReserverAsync,
  type GitAnswer,
} from "#src/lib/dispatch-claim.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const TASK = "W1-T12114";
const MIN = 60_000;
const HOUR = 60 * MIN;
const W = 60 * MIN;
const HOST = "Remudero";
const CONTAINER = "0123456789ab";
const MINTED = "2026-11-11T09:14:13.758Z";
const NOW_MS = Date.parse("2026-11-16T20:00:00.000Z");
const HAND_ANCHOR = `rmd-dispatch claim 3861824@${HOST} ${MINTED}\nrenewed 3861824@${HOST} 2026-11-11T12:59:25.435Z`;
type Row = Record<string, unknown>;

/** `n` builds, each claimed and given its verdict W later, two days before now: the measured window. */
function measuredRows(n: number, nowMs: number): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const claimedAt = nowMs - 2 * 24 * HOUR + i * MIN;
    return [
      { step: "dispatch.claim", outcome: "created", run_id: `measured-${i}`, task_id: `T-M-${i}`, ts: new Date(claimedAt).toISOString() },
      { step: "verdict", verdict: "merged", run_id: `measured-${i}`, task_id: `T-M-${i}`, ts: new Date(claimedAt + W).toISOString() },
    ];
  }).flat();
}

/** The claim's `dispatch.claim` `created` row as the ledger writer records it. */
function mintRow(host: string, actor: string | undefined): Row {
  return {
    ts: "2026-11-11T09:14:15.000Z", step: "dispatch.claim", ref: dispatchClaimRef(TASK), outcome: "created",
    task_id: TASK, host, ...(actor === undefined ? {} : { actor }),
  };
}

interface Seen { calls: string[]; git: string[][]; logged: Array<{ step: string; fields: Row }> }

function reserver(seen: Seen, message: string): DispatchClaimReserverAsync {
  return {
    mintAnchor: () => "fresh-anchor",
    attempt: (_id, anchor) => (seen.calls.push(`attempt:${anchor}`), "created"),
    holder: () => "held-sha",
    drop: (_id, o) => (seen.calls.push(`drop:${o?.expect ?? "-"}`), true),
    anchorMessage: () => message,
  };
}

/** A git runner answering the run-branch read: `branchAtMs` is the newest run-branch commit, absent = no branch. */
function branches(seen: Seen, branchAtMs?: number): (args: string[]) => Promise<GitAnswer> {
  return async (args) => {
    seen.git.push(args);
    if (args[0] === "ls-remote") {
      return { status: 0, stdout: branchAtMs === undefined ? "" : `${"c".repeat(40)}\trefs/heads/run-${TASK}-1794000000000\n`, stderr: "" };
    }
    if (args[0] === "log") return { status: 0, stdout: `${Math.floor((branchAtMs ?? 0) / 1000)}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

function judge(t: TestContext, row: Row, localHost: string, seen: Seen, nowMs = NOW_MS, branchAtMs?: number): ClaimSilenceJudgeInputs {
  const ledger = writeLedger([row], { scope: t });
  const anchor = parseClaimAnchorMessage(HAND_ANCHOR)!;
  const found = findClaimMintRow(ledger.dir, TASK, anchor);
  assert.equal(found?.actor, String(row.actor ?? "unknown"), "control: the default probe reads this claim's mint row from the ledger");
  return {
    run: branches(seen, branchAtMs),
    stateDir: ledger.dir,
    localHost,
    log: (step, fields) => void seen.logged.push({ step, fields }),
    clock: fixedClock(nowMs),
    readRows: async () => [...measuredRows(20, nowMs), ...seen.logged.map(({ step, fields }) => ({ step, ...fields }))],
  };
}

const fresh = (): Seen => ({ calls: [], git: [], logged: [] });

test("W1-T13241 criterion 1: a hand session's claim minted on this host by an operator actor is judged by its silence and reclaimed past 2W", async (t) => {
  for (const actor of ["operator_human", "operator_ai", undefined]) {
    const seen = fresh();
    const judged = await reclaimSilentDispatchClaim(TASK, reserver(seen, HAND_ANCHOR), judge(t, mintRow(HOST, actor), HOST, seen));
    assert.equal(judged.verdict, "reclaim", `${actor ?? "unknown"}: ${judged.reason}`);
    assert.equal(judged.dropped, true);
    assert.equal(judged.anchor, "fresh-anchor", "the judging lane takes the task under its own claim");
    assert.deepEqual(seen.calls, ["drop:held-sha", "attempt:fresh-anchor"], "the drop is pinned to the sha judged");
    assert.ok(seen.git.some((a) => a[0] === "ls-remote"), "the judge read the holder's run branches for a sign of life");
    const reclaimed = seen.logged.find((r) => r.step === "dispatch.claim_reclaimed");
    assert.equal(reclaimed?.fields.holder, `3861824@${HOST}`);
    assert.equal(reclaimed?.fields.last_sign_of_life_source, "renewed");
  }
});

test("W1-T13241 criterion 1: a claim whose mint row names another host than this instance's is judged by its silence, kept under 2W and reclaimed past it", async (t) => {
  const kept = fresh();
  const renewedAtMs = Date.parse("2026-11-11T12:59:25.435Z");
  const early = await reclaimSilentDispatchClaim(TASK, reserver(kept, HAND_ANCHOR),
    judge(t, mintRow(HOST, "daemon"), CONTAINER, kept, renewedAtMs + 90 * MIN));
  assert.equal(early.verdict, "unrenewed", early.reason);
  assert.deepEqual(kept.calls, [], "silence between W and 2W reports and keeps the claim");
  assert.equal(kept.logged.filter((r) => r.step === "dispatch.claim_unrenewed").length, 1);

  const seen = fresh();
  const judged = await reclaimSilentDispatchClaim(TASK, reserver(seen, HAND_ANCHOR), judge(t, mintRow(HOST, "daemon"), CONTAINER, seen));
  assert.equal(judged.verdict, "reclaim", judged.reason);
  assert.equal(judged.dropped, true);
  assert.deepEqual(seen.calls, ["drop:held-sha", "attempt:fresh-anchor"]);
});

test("W1-T13241 criterion 2: a claim a fleet lane of this instance minted goes to the dead-claimant arm and never to the silence judge", async (t) => {
  for (const actor of ["daemon", "run_child"]) {
    for (const localHost of [HOST, `${HOST.toLowerCase()}.local`]) {
      const seen = fresh();
      const judged = await reclaimSilentDispatchClaim(TASK, reserver(seen, HAND_ANCHOR), judge(t, mintRow(HOST, actor), localHost, seen));
      assert.equal(judged.verdict, "no-verdict", `${actor}@${localHost}: ${judged.reason}`);
      assert.match(judged.reason, /fleet lane of this instance/);
      assert.deepEqual(seen.calls, [], "nothing is dropped or retried");
      assert.deepEqual(seen.git, [], "the silence judge never reads its run branches");
      assert.deepEqual(seen.logged, [], "nothing is reported or reclaimed");
    }
  }
});

test("W1-T13241 criterion 3: a hand claim whose holder shows a sign of life inside the window is kept, and unreadable evidence yields no verdict", async (t) => {
  const control = fresh();
  const silent = await reclaimSilentDispatchClaim(TASK, reserver(control, HAND_ANCHOR), judge(t, mintRow(HOST, "operator_human"), HOST, control));
  assert.equal(silent.verdict, "reclaim", `control: the same hand claim with no sign of life is reclaimed — ${silent.reason}`);

  const moving = fresh();
  const branch = await reclaimSilentDispatchClaim(TASK, reserver(moving, HAND_ANCHOR),
    judge(t, mintRow(HOST, "operator_human"), HOST, moving, NOW_MS, NOW_MS - 10 * MIN));
  assert.equal(branch.verdict, "alive", branch.reason);
  assert.match(branch.reason, /\(run-branch\)/);
  assert.deepEqual(moving.calls, [], "a claim whose run branch moved inside the window is kept");
  assert.deepEqual(moving.logged, []);

  const renewing = fresh();
  const renewedMessage = `rmd-dispatch claim 3861824@${HOST} ${MINTED}\nrenewed 3861824@${HOST} ${new Date(NOW_MS - 5 * MIN).toISOString()}`;
  const renewed = await reclaimSilentDispatchClaim(TASK, reserver(renewing, renewedMessage), judge(t, mintRow(HOST, "operator_ai"), CONTAINER, renewing));
  assert.equal(renewed.verdict, "alive", renewed.reason);
  assert.deepEqual(renewing.calls, [], "a claim renewed inside the window is kept");

  const unreadable = fresh();
  const failing = { ...judge(t, mintRow(HOST, "operator_human"), HOST, unreadable), run: async () => ({ status: 128, stdout: "", stderr: "fatal: could not read from remote" }) };
  const blind = await reclaimSilentDispatchClaim(TASK, reserver(unreadable, HAND_ANCHOR), failing);
  assert.equal(blind.verdict, "no-verdict");
  assert.match(blind.reason, /run branches are unreadable/);
  assert.deepEqual(unreadable.calls, []);

  const noAnchor = fresh();
  const garbled = await reclaimSilentDispatchClaim(TASK, reserver(noAnchor, "not a claim anchor"), judge(t, mintRow(HOST, "operator_human"), HOST, noAnchor));
  assert.equal(garbled.verdict, "no-verdict");
  assert.match(garbled.reason, /anchor is unreadable/);
  assert.deepEqual(noAnchor.calls, []);
});
